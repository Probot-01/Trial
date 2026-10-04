'use strict';



const fs = require('fs');
const { execFile } = require('child_process');

const pool = require('../db/pgClient');
const gradingQueue = require('./gradingQueue');
const matlabSupervisor = require('./matlabSessionSupervisor');
const segSupervisor = require('./segWorkerSupervisor');
const matlabSession = require('./matlabSessionClient');
const segSession = require('./segSessionClient');

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const DB_TIMEOUT_MS = num('HEALTH_DB_TIMEOUT_MS', 1000);
const PY_PROBE_EVERY_MS = num('HEALTH_PYTHON_PROBE_INTERVAL_MS', 60_000);
const PY_PROBE_TIMEOUT_MS = num('HEALTH_PYTHON_PROBE_TIMEOUT_MS', 60_000);
const PYTHON_EXE = process.env.PYTHON_EXECUTABLE || 'python';


const PY_REQUIRED = ['numpy', 'cv2', 'scipy', 'torch', 'timm', 'segmentation_models_pytorch'];
const PY_PROBE_SRC = `import sys, importlib
bad = []
for m in ${JSON.stringify(PY_REQUIRED)}:
    try:
        importlib.import_module(m)
    except Exception as e:
        bad.append(m + ': ' + type(e).__name__ + ': ' + str(e)[:120])
print(sys.version.split()[0])
print('|'.join(bad))`;

function heartbeatAt(file) {
  try { return new Date(fs.statSync(file).mtimeMs).toISOString(); } catch { return null; }
}

function withTimeout(promise, ms, what) {
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

async function dbStatus() {
  const t0 = Date.now();
  try {
    await withTimeout(pool.query('SELECT 1'), DB_TIMEOUT_MS, 'Postgres');
    return { status: 'ok', latencyMs: Date.now() - t0, error: null };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - t0, error: String(err.message).slice(0, 200) };
  }
}

function queueStatus() {
  const s = gradingQueue.stats();
  return { status: s.running ? 'ok' : 'stopped', ...s };
}

function matlabStatus() {
  const sup = matlabSupervisor.getStatus();
  return {
    // 'healthy' | 'restarting' | 'down' | 'disabled' -- the supervisor's view,
    // the same value GET /api/v1/admin/system-health reports.
    status: sup.status,
    // Ground truth right now, independent of the supervisor's last pass (and
    // meaningful when the supervisor is disabled): is the heartbeat fresh?
    heartbeatFresh: matlabSession.alive(),
    lastHeartbeatAt: heartbeatAt(matlabSession.HEARTBEAT),
    restartsInWindow: sup.restartsInWindow,
    lastError: sup.lastError,
  };
}

// ── Python: a cached background probe ──────────────────────────────────────
const py = {
  status: 'unknown', version: null, missing: [], error: null, checkedAt: null,
  probing: null,
};

function probePython() {
  if (py.probing) return py.probing;
  py.probing = new Promise((resolve) => {
    execFile(PYTHON_EXE, ['-c', PY_PROBE_SRC],
      { timeout: PY_PROBE_TIMEOUT_MS, windowsHide: true, env: process.env },
      (err, stdout, stderr) => {
        py.checkedAt = new Date().toISOString();
        if (err) {
          py.status = 'unavailable';
          py.version = null;
          py.missing = [];
          // Say what happened, not err.message (which is the whole command line,
          // including the probe script).
          py.error = (err.code === 'ENOENT' ? `no interpreter at '${PYTHON_EXE}'`
            : err.killed ? `the probe did not finish within ${Math.round(PY_PROBE_TIMEOUT_MS / 1000)} s `
              + '(a cold start can take that long; it is retried)'
              : `the probe exited with code ${err.code}`)
            + (stderr ? ` -- ${String(stderr).trim().slice(-200)}` : '');
        } else {
          const [version, bad = ''] = String(stdout).trim().split(/\r?\n/);
          py.version = version || null;
          py.missing = bad ? bad.split('|') : [];
          py.status = py.missing.length ? 'unavailable' : 'ok';
          py.error = py.missing.length ? 'required modules failed to import' : null;
        }
        py.probing = null;
        resolve();
      });
  });
  return py.probing;
}

function pythonStatus() {
  const stale = !py.checkedAt || Date.now() - Date.parse(py.checkedAt) > PY_PROBE_EVERY_MS;
  if (stale) probePython();   // refresh in the background; never awaited here
  const seg = segSupervisor.getStatus();
  return {
    status: py.status,   // 'ok' | 'unavailable' | 'unknown' (first probe still running)
    executable: PYTHON_EXE,
    version: py.version,
    missingModules: py.missing,
    error: py.error,
    checkedAt: py.checkedAt,
    // The persistent segmentation worker (optional: without it each case
    // spawns segInfer.py, slower but equivalent).
    segWorker: {
      status: seg.status,
      heartbeatFresh: segSession.alive(),
      lastHeartbeatAt: heartbeatAt(segSession.HEARTBEAT),
      restartsInWindow: seg.restartsInWindow,
      lastError: seg.lastError,
    },
  };
}

async function report() {
  return {
    status: 'ok',
    components: {
      db: await dbStatus(),
      queue: queueStatus(),
      matlabSession: matlabStatus(),
      python: pythonStatus(),
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { report, probePython, _py: py };
