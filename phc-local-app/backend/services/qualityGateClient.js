'use strict';

/**
 * qualityGateClient.js
 *
 * Node ↔ MATLAB bridge for the quality gate.
 *
 * IMPLEMENTATION NOTE — "MATLAB Engine API for JavaScript" does not exist.
 * MathWorks provides official engine APIs for Python, Java, C/C++, and .NET
 * only.  The Task 1.6 spec mentions it, but there is no such npm package.
 *
 * Bridge strategy: child_process calling `matlab -batch`.
 *   • MATLAB runs qualityGateMain.m, jsonencode()s the result struct, and
 *     prints it to stdout.  Node reads stdout and JSON.parse()s it.
 *   • MATLAB startup takes 3–8 s.  To avoid paying that cost per request,
 *     this module keeps a shared "warm" promise that pre-launches MATLAB
 *     during server startup (see warmUp() below), so the first real request
 *     doesn't incur the cold-start penalty.
 * TASK 8.1 — TWO BACKENDS, SELECTED AT RUNTIME.
 *   Set QUALITY_GATE_EXE to a compiled qualityGate executable and this module
 *   shells out to that instead of launching MATLAB. The PHC machine then needs
 *   only the free MATLAB Runtime rather than a licensed MATLAB install, which
 *   is the main win. It is also faster, but modestly: MEASURED warm on the dev
 *   machine, ~9.1 s per call via matlab -batch against ~4.6 s via the exe.
 *   About 2x. An earlier version of this comment claimed ~50 ms, which was
 *   never measured and was wrong — the Runtime still initialises on every
 *   invocation, because every call is a fresh process.
 *
 *   Both paths are kept, deliberately. Developers here have MATLAB and no
 *   compiled build; PHCs will have the exe and no MATLAB. Making the compiled
 *   path mandatory would mean nobody could run the gate until someone
 *   remembered to compile it, and deleting the MATLAB path would make every
 *   change to a .m file require a rebuild before it could be tested.
 *
 *   The two produce byte-identical JSON — qualityGateCli.m calls the same
 *   qualityGateMain and jsonencode()s the same struct — so everything below
 *   the spawn is shared. That sharing is the point: a second parser for the
 *   compiled path is a second thing to drift.
 *
 * MATLAB must be on the system PATH, OR set MATLAB_EXECUTABLE env var to the
 * full path, e.g.:
 *   $env:MATLAB_EXECUTABLE = "C:\Program Files\MATLAB\R2024b\bin\matlab.exe"
 */

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');

const { runQualityGateFallback } = require('./qualityGateFallback');

// Task: MATLAB workaround for dev machines with no MATLAB install and no
// compiled QUALITY_GATE_EXE (no license, no disk space for MATLAB — this is
// exactly that machine). When true, a MATLAB spawn failure (ENOENT — the
// interpreter genuinely could not be launched) falls back to a pure-JS
// re-implementation of the same decision logic (qualityGateFallback.js)
// instead of failing the capture with 503.
//
// OFF by default (2026-09-26): without MATLAB or the exe the capture gets
// 503 quality_gate_failed (image saved, re-checkable). Opt in with
// QUALITY_GATE_ALLOW_FALLBACK=1 -- standing rule: no silent engine fallback.
//
// This does NOT change behaviour on a machine that actually has MATLAB or a
// compiled exe: both are tried first, exactly as before, and a REAL MATLAB
// error (bad image, license problem, non-zero exit) is never routed to the
// fallback — only "the interpreter could not be spawned at all" is.
const ALLOW_JS_FALLBACK = process.env.QUALITY_GATE_ALLOW_FALLBACK === '1';

// Absolute path to the quality-gate-matlab/ folder so MATLAB can addpath it.
const MATLAB_GATE_DIR = path.resolve(__dirname, '..', 'quality-gate-matlab');

// MATLAB executable — honour env override, fall back to 'matlab' on PATH.
const MATLAB_EXE = process.env.MATLAB_EXECUTABLE || 'matlab';

// Task 8.1. When set AND present on disk, the compiled executable is used.
// Checked once at load: a path that does not exist falls back to MATLAB with a
// warning rather than failing every capture, because a PHC whose exe went
// missing should degrade to slow-but-working, not to broken.
const QUALITY_GATE_EXE = process.env.QUALITY_GATE_EXE || null;

function resolveCompiledExe() {
  if (!QUALITY_GATE_EXE) return null;
  if (fs.existsSync(QUALITY_GATE_EXE)) return QUALITY_GATE_EXE;
  console.warn(
    `[qualityGateClient] QUALITY_GATE_EXE is set to '${QUALITY_GATE_EXE}' but no file `
    + 'is there; falling back to launching MATLAB. Captures still work, slowly.');
  return null;
}

const COMPILED_EXE = resolveCompiledExe();

// Maximum time (ms) to wait for a single MATLAB call, including startup.
// 30s was measured against an otherwise-idle machine; a cold `matlab -batch`
// start competing with central's persistent classification MATLAB session
// (loaded weights resident) on the same laptop measured 30.9s here, i.e.
// already over the old default -- confirmed with `time matlab -batch
// "disp('warm')"` while that session was up. 60s gives real headroom for
// that same-machine case without masking a genuinely hung process for long.
const TIMEOUT_MS = parseInt(process.env.MATLAB_TIMEOUT_MS || '60000', 10);

/**
 * spawnMatlabBatch(matlabExpr)
 *
 * Runs a MATLAB -batch expression and resolves with its stdout as a string.
 * Rejects on non-zero exit, timeout, or stderr content that indicates an
 * unhandled exception.
 *
 * @param {string} matlabExpr — the MATLAB expression to evaluate
 * @returns {Promise<string>}
 */
function spawnMatlabBatch(matlabExpr) {
  return spawnCollecting(MATLAB_EXE, ['-batch', matlabExpr], 'matlab -batch');
}

/**
 * spawnCompiled(imagePath, cameraDeviceId)
 *
 * Runs the compiled qualityGate executable.
 *
 * Arguments cross as plain argv rather than being interpolated into a MATLAB
 * expression. That removes the quoting hazard entirely: the escaping in
 * runQualityGate below exists because a -batch expression is evaluated as
 * CODE, so a filename containing a quote would execute. argv has no such
 * problem — the OS hands the string through untouched.
 */
function spawnCompiled(imagePath, cameraDeviceId) {
  const args = [imagePath, cameraDeviceId];

  // A .cmd/.bat wrapper is a normal way to deploy an MCR application on
  // Windows: the MATLAB Runtime's runtime\win64 directory has to be on PATH
  // before the exe starts, and a one-line batch file is the usual way sites do
  // that. Node 18+ refuses to spawn .cmd directly (the CVE-2024-27980 fix), so
  // those go through cmd.exe explicitly.
  //
  // Explicitly, and NOT via `shell: true`. shell:true would concatenate the
  // arguments into one command string, which reintroduces the quoting hazard
  // this whole path exists to avoid. Passing them as an array keeps Node's
  // per-argument quoting in play.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(COMPILED_EXE)) {
    return spawnCollecting('cmd.exe', ['/c', COMPILED_EXE, ...args], 'qualityGate wrapper');
  }
  return spawnCollecting(COMPILED_EXE, args, 'qualityGate exe');
}

/**
 * spawnCollecting(cmd, args, label)
 *
 * Shared child-process plumbing for both backends: collect stdout, honour the
 * timeout, and name the failing backend in any error.
 */
function spawnCollecting(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      env: process.env,
      timeout: TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code, signal) => {
      if (code !== 0) {
        // qualityGateCli.m documents its exit codes: 2 = wrong arity, 3 = the
        // gate itself failed. Surfacing the number is what separates a
        // packaging mistake from an unreadable image in a PHC's logs.
        //
        // code === null with a signal means Node's own `timeout` option (or
        // an external kill) ended the process before it exited on its own --
        // a cold `matlab -batch` start competing with another resident MATLAB
        // process (e.g. central's persistent classification session) on the
        // same machine can genuinely take >30s, and that used to print as an
        // unexplained "exited with code null" with no stderr, which reads
        // like a crash rather than what it is: a timeout.
        const reason = code === null && signal
          ? `was killed by ${signal} (likely the ${TIMEOUT_MS}ms timeout -- ` +
            'a cold MATLAB start is competing with another resident MATLAB ' +
            'process on this machine; consider MATLAB_TIMEOUT_MS if this recurs)'
          : `exited with code ${code}`;
        return reject(new Error(
          `${label} ${reason}.\nstderr: ${stderr.trim()}`
        ));
      }
      // MATLAB writes licence/startup banners to stderr, not stdout, and the
      // Runtime does the same. stderr alone is therefore not evidence of
      // failure — only the exit code is.
      resolve(stdout.trim());
    });

    proc.on('error', (err) => {
      reject(new Error(
        `Failed to spawn ${label} ('${cmd}'): ${err.message}`
      ));
    });
  });
}

/**
 * runQualityGate(imagePath, cameraDeviceId)
 *
 * Calls qualityGateMain.m via a matlab -batch subprocess and returns the
 * result as a plain JS object.
 *
 * @param {string} imagePath      — absolute path to the captured image file
 * @param {string} cameraDeviceId — device identifier from the capture metadata
 * @returns {Promise<{ status: string, reason: string|null, scores: object }>}
 */
async function runQualityGate(imagePath, cameraDeviceId) {
  const deviceId = cameraDeviceId || 'unknown';

  // ── Task 8.1: the compiled path ──────────────────────────────────────────
  // Everything after the spawn is shared with the MATLAB path below, because
  // qualityGateCli.m jsonencode()s the very same struct qualityGateMain
  // returns. A separate parser here would be a second thing to keep in step.
  if (COMPILED_EXE) {
    let rawExe;
    try {
      rawExe = await spawnCompiled(imagePath, deviceId);
    } catch (err) {
      throw new Error(`Quality gate executable failed: ${err.message}`);
    }
    return withEngine(parseGateOutput(rawExe), 'matlab', false,
      'compiled qualityGate executable (MATLAB Runtime)');
  }

  // Escape backslashes and single-quotes for embedding in a MATLAB string.
  const safePath     = imagePath.replace(/\\/g, '/').replace(/'/g, "''");
  const safeDeviceId = deviceId.replace(/'/g, "''");

  // MATLAB expression:
  //   1. addpath the quality-gate directory so all .m files are found.
  //   2. Call qualityGateMain.
  //   3. jsonencode the result and disp() it — that's what lands in stdout.
  const matlabGateDir = MATLAB_GATE_DIR.replace(/\\/g, '/');

  const expr = [
    `addpath('${matlabGateDir}');`,
    `result = qualityGateMain('${safePath}', '${safeDeviceId}');`,
    `disp(jsonencode(result));`,
  ].join(' ');

  let raw;
  try {
    raw = await spawnMatlabBatch(expr);
  } catch (err) {
    if (ALLOW_JS_FALLBACK && err.message.includes("Failed to spawn matlab -batch")) {
      console.warn(
        '[qualityGateClient] MATLAB is not installed on this machine — using the '
        + 'JS quality-gate fallback (qualityGateFallback.js) instead. On a machine '
        + 'with MATLAB (or QUALITY_GATE_EXE) this code path is never taken.');
      return withEngine(await runQualityGateFallback(imagePath), 'js-fallback', true,
        'qualityGateFallback.js -- MATLAB not installed, QUALITY_GATE_ALLOW_FALLBACK=1');
    }
    throw new Error(`Quality gate MATLAB call failed: ${err.message}`);
  }

  return withEngine(parseGateOutput(raw), 'matlab', false, 'qualityGateMain.m via matlab -batch');
}

/**
 * withEngine(result, engine, fallback, detail) -- the gate's verdict plus WHICH
 * ENGINE produced it (standing rule: every case records the engine behind each
 * ML output, and no engine switch is silent). Stored on the capture and sent
 * to central with the case as qualityGateEngine -- see api-contracts.md.
 */
function withEngine(result, engine, fallback, detail) {
  return { ...result, engine: { engine, fallback, detail } };
}

/**
 * parseGateOutput(raw)
 *
 * Turns either backend's stdout into the result object the route handler
 * expects. Shared by both paths on purpose — the compiled executable calls the
 * same qualityGateMain and jsonencode()s the same struct, so a second parser
 * would only be a second place for the shape to drift.
 */
function parseGateOutput(raw) {
  // Extract the JSON object from stdout.
  // MATLAB may print startup/licence text before our disp() output, so
  // find the first '{' and take from there.
  const jsonStart = raw.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(
      `Quality gate returned no JSON object.\nRaw stdout:\n${raw}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(jsonStart));
  } catch (err) {
    throw new Error(
      `Quality gate JSON parse failed: ${err.message}\nRaw: ${raw.slice(jsonStart, jsonStart + 200)}`
    );
  }

  // Normalise MATLAB's jsonencode output to the expected JS shape:
  //   result.status  — string: 'pass' | 'retake' | 'borderline'
  //   result.reason  — string | null
  //     MATLAB encodes [] (empty matrix) as a JSON empty array [], NOT null.
  //     So we must treat both null AND [] as "no reason" and normalise to null.
  //   result.scores  — plain object of all seven sub-scores:
  //     focusScore, illuminationScore, fovScore, coveragePercent,
  //     glareScore, motionScore, occlusionScore
  //
  //   Verified against real MATLAB Online output (2.jpg, 'unknown'):
  //   {"scores":{"focusScore":0.801,"illuminationScore":0.950,"fovScore":1,
  //    "coveragePercent":0.859,"glareScore":0,"motionScore":0.182,
  //    "occlusionScore":0.141},"status":"pass","reason":[]}
  const reasonRaw = parsed.reason;
  const reason = (
    reasonRaw === null ||
    reasonRaw === undefined ||
    (Array.isArray(reasonRaw) && reasonRaw.length === 0)
  ) ? null : reasonRaw;

  // The borderline/pass threshold in qualityGateMain.m's own decision chain
  // (Step 4, last branch): `compositeScore = mean([focus, illumination, fov])`,
  // then `compositeScore < 0.7` -> borderline. Recomputed here from the three
  // sub-scores it already returns -- the exact formula that decided this
  // capture's own verdict, not a number invented for display. The mobile
  // app's qualityGate.ts port of the same MATLAB source computes it
  // identically (verified at parity, largest observed diff 2.55e-3).
  const s = parsed.scores || {};
  const compositeScore = (
    typeof s.focusScore === 'number'
    && typeof s.illuminationScore === 'number'
    && typeof s.fovScore === 'number'
  ) ? (s.focusScore + s.illuminationScore + s.fovScore) / 3 : null;

  return {
    status: parsed.status,
    reason,
    scores: parsed.scores,
    compositeScore,
  };
}

/**
 * warmUp()
 *
 * Pre-launches a MATLAB process during server startup to pay the startup cost
 * upfront rather than on the first real patient capture.  Call once from
 * server.js; safe to call multiple times (subsequent calls are no-ops).
 *
 * @returns {Promise<void>}
 */
let _warmUpDone = false;
async function warmUp() {
  if (_warmUpDone) return;
  _warmUpDone = true;

  // Task 8.1: nothing to warm when compiled. The exe starts in tens of
  // milliseconds, so there is no cold-start cost to pay upfront — this whole
  // mechanism exists only to hide MATLAB's 3-8 s interpreter launch. Spawning
  // it anyway would just add a pointless process at every server start.
  if (COMPILED_EXE) {
    console.log(`[qualityGateClient] using compiled gate at ${COMPILED_EXE}; no warm-up needed.`);
    return;
  }

  try {
    // Lightweight call that just verifies MATLAB starts and can see the gate dir.
    const matlabGateDir = MATLAB_GATE_DIR.replace(/\\/g, '/');
    await spawnMatlabBatch(`addpath('${matlabGateDir}'); disp('warm');`);
    console.log('[qualityGateClient] MATLAB warm-up complete.');
  } catch (err) {
    // Log but don't crash server — captures will still work, just with cold starts.
    console.warn('[qualityGateClient] MATLAB warm-up failed (is MATLAB installed?):', err.message);
  }
}

/**
 * gateMode()
 *
 * Which backend is in use: 'compiled' or 'matlab'. Exported so the server can
 * log it at startup and so Task 8.1's verification can assert the selection
 * without inspecting env vars itself.
 */
function gateMode() {
  return COMPILED_EXE ? 'compiled' : 'matlab';
}

module.exports = { runQualityGate, warmUp, gateMode, parseGateOutput };
