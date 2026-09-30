'use strict';

/**
 * sessionClient.js -- the ONE implementation of the request/response file
 * protocol the two persistent workers speak.
 *
 *   const client = createSessionClient({ dir, heartbeatFile, label });
 *   if (client.alive()) await client.call(payload, { timeoutMs, prefix });
 *
 * Two workers use it: the MATLAB inference session
 * (ml-pipeline/inference/matlabSession) and the Python segmentation worker
 * (ml-pipeline/inference/segSession). They run different languages and
 * different models, and the transport between them and Node is identical:
 * write a request file, poll for the matching response, both sides
 * temp-then-rename so neither observes a partial file.
 *
 * It lives in one place because it did not, once. Three callers had grown
 * their own copy and they differed in small ways that were bugs waiting to
 * happen -- one reclaimed a timed-out request file and one did not, so a slow
 * worker could still pick up work nobody was waiting for and leave an orphan
 * response next to it.
 *
 * WHY A DIRECTORY AND NOT A SOCKET: no extra dependency on either side, and
 * every step is inspectable with a directory listing -- a stuck request is a
 * file you can read, not opaque socket state. Throughput is not the goal; one
 * case at a time is the load shape, and a 50 ms poll is far under the
 * multi-second budget this exists to protect.
 */

const fs   = require('fs');
const path = require('path');

const POLL_MS = 50;

/**
 * Synchronous on purpose. With the async fs.unlink the promise settled while
 * the file was still there: a caller told "your request was taken back" could
 * still find it in requests/ -- exactly the window in which a session that has
 * just restarted picks it up and runs work nobody is waiting for
 * (verify_backend_pipeline.js checks both files).
 */
function removeQuietly(p) {
  try { fs.unlinkSync(p); } catch { /* already gone, or taken by the worker */ }
}

/**
 * createSessionClient({ dir, heartbeatFile, staleMs, label })
 *
 * `dir` holds requests/ and responses/; `heartbeatFile` is what the worker
 * rewrites while it polls.
 */
function createSessionClient({ dir, heartbeatFile, staleMs = 30_000, label = 'worker' }) {
  const REQUEST_DIR  = path.join(dir, 'requests');
  const RESPONSE_DIR = path.join(dir, 'responses');

  /**
   * alive() -- is the worker loaded and still polling?
   *
   * The heartbeat, not the PID: a process that is up but wedged keeps its PID
   * and stops refreshing the file. Both workers write it only once their
   * models are loaded, so "alive" also means "ready", never "starting".
   */
  function alive() {
    try { return Date.now() - fs.statSync(heartbeatFile).mtimeMs < staleMs; } catch { return false; }
  }

  /**
   * call(payload, { timeoutMs, prefix }) -> Promise<object>
   *
   * Rejects with the worker's own message when the response carries `error`,
   * and with a `session_timeout`-coded error when nothing answers in time.
   */
  function call(payload, { timeoutMs = 30_000, prefix = 'req' } = {}) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(REQUEST_DIR, { recursive: true });
      fs.mkdirSync(RESPONSE_DIR, { recursive: true });

      const id = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const reqPath  = path.join(REQUEST_DIR, `${id}.json`);
      const respPath = path.join(RESPONSE_DIR, `${id}.json`);

      fs.writeFileSync(`${reqPath}.tmp`, JSON.stringify(payload));
      fs.renameSync(`${reqPath}.tmp`, reqPath);

      const startedAt = Date.now();
      const poll = setInterval(() => {
        if (fs.existsSync(respPath)) {
          let body;
          try {
            body = JSON.parse(fs.readFileSync(respPath, 'utf8'));
          } catch (err) {
            // On Windows the file shows up before the worker's move has released
            // it (EACCES/EPERM/EBUSY), or half-written (SyntaxError). Look again on
            // the next tick; only give up on the deadline.
            const transient = err instanceof SyntaxError || ['EACCES', 'EPERM', 'EBUSY'].includes(err.code);
            if (transient && Date.now() - startedAt <= timeoutMs) return;
            clearInterval(poll);
            removeQuietly(respPath);
            return reject(new Error(`${label} response JSON parse failed: ${err.message}`));
          }
          clearInterval(poll);
          removeQuietly(respPath);
          if (body && body.error) {
            // The worker's own classification, when it gives one (e.g. the seg
            // worker's matlab_segmentation_failed), so the caller can tell a
            // failed engine from an unreadable image.
            const err = new Error(body.error);
            if (typeof body.code === 'string' && body.code) err.code = body.code;
            return reject(err);
          }
          return resolve(body);
        }
        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(poll);
          // Take the request back. Left behind, a worker that is merely slow
          // (or one that starts later) picks it up, runs work nobody is
          // waiting for, and leaves an orphan response file behind it.
          removeQuietly(reqPath);
          const err = new Error(`No response from the ${label} within ${timeoutMs}ms.`);
          err.code = 'session_timeout';
          return reject(err);
        }
      }, POLL_MS);
    });
  }

  return { alive, call, dir, REQUEST_DIR, RESPONSE_DIR, HEARTBEAT: heartbeatFile };
}

module.exports = { createSessionClient };
