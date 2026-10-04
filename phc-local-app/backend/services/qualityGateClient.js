'use strict';



const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { runQualityGateFallback } = require('./qualityGateFallback');


const ALLOW_JS_FALLBACK = process.env.QUALITY_GATE_ALLOW_FALLBACK === '1';

// Absolute path to the quality-gate-matlab/ folder so MATLAB can addpath it.
const MATLAB_GATE_DIR = path.resolve(__dirname, '..', 'quality-gate-matlab');

// MATLAB executable — honour env override, fall back to 'matlab' on PATH.
const MATLAB_EXE = process.env.MATLAB_EXECUTABLE || 'matlab';

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

function spawnCompiled(imagePath, cameraDeviceId) {
  const args = [imagePath, cameraDeviceId];

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(COMPILED_EXE)) {
    return spawnCollecting('cmd.exe', ['/c', COMPILED_EXE, ...args], 'qualityGate wrapper');
  }
  return spawnCollecting(COMPILED_EXE, args, 'qualityGate exe');
}


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

        const reason = code === null && signal
          ? `was killed by ${signal} (likely the ${TIMEOUT_MS}ms timeout -- ` +
          'a cold MATLAB start is competing with another resident MATLAB ' +
          'process on this machine; consider MATLAB_TIMEOUT_MS if this recurs)'
          : `exited with code ${code}`;
        return reject(new Error(
          `${label} ${reason}.\nstderr: ${stderr.trim()}`
        ));
      }

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
  const safePath = imagePath.replace(/\\/g, '/').replace(/'/g, "''");
  const safeDeviceId = deviceId.replace(/'/g, "''");


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
      return withEngine(await runQualityGateFallback(imagePath, deviceId), 'js-fallback', true,
        'qualityGateFallback.js -- MATLAB not installed, QUALITY_GATE_ALLOW_FALLBACK=1');
    }
    throw new Error(`Quality gate MATLAB call failed: ${err.message}`);
  }

  return withEngine(parseGateOutput(raw), 'matlab', false, 'qualityGateMain.m via matlab -batch');
}


function withEngine(result, engine, fallback, detail) {
  return { ...result, engine: { engine, fallback, detail } };
}


function parseGateOutput(raw) {

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


  const reasonRaw = parsed.reason;
  const reason = (
    reasonRaw === null ||
    reasonRaw === undefined ||
    (Array.isArray(reasonRaw) && reasonRaw.length === 0)
  ) ? null : reasonRaw;


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


function gateMode() {
  return COMPILED_EXE ? 'compiled' : 'matlab';
}

module.exports = { runQualityGate, warmUp, gateMode, parseGateOutput };
