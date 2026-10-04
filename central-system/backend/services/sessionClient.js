'use strict';


const fs = require('fs');
const path = require('path');

const POLL_MS = 50;


function removeQuietly(p) {
  try { fs.unlinkSync(p); } catch { /* already gone, or taken by the worker */ }
}


function createSessionClient({ dir, heartbeatFile, staleMs = 30_000, label = 'worker' }) {
  const REQUEST_DIR = path.join(dir, 'requests');
  const RESPONSE_DIR = path.join(dir, 'responses');

  function alive() {
    try { return Date.now() - fs.statSync(heartbeatFile).mtimeMs < staleMs; } catch { return false; }
  }


  function call(payload, { timeoutMs = 30_000, prefix = 'req' } = {}) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(REQUEST_DIR, { recursive: true });
      fs.mkdirSync(RESPONSE_DIR, { recursive: true });

      const id = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const reqPath = path.join(REQUEST_DIR, `${id}.json`);
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

            const transient = err instanceof SyntaxError || ['EACCES', 'EPERM', 'EBUSY'].includes(err.code);
            if (transient && Date.now() - startedAt <= timeoutMs) return;
            clearInterval(poll);
            removeQuietly(respPath);
            return reject(new Error(`${label} response JSON parse failed: ${err.message}`));
          }
          clearInterval(poll);
          removeQuietly(respPath);
          if (body && body.error) {

            const err = new Error(body.error);
            if (typeof body.code === 'string' && body.code) err.code = body.code;
            return reject(err);
          }
          return resolve(body);
        }
        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(poll);

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
