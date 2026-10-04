'use strict';



const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CENTRAL_DIR = path.join(ROOT, 'central-system', 'backend');
const CENTRAL_WEB_DIR = path.join(ROOT, 'central-system', 'frontend');
const PHC_DIR = path.join(ROOT, 'phc-local-app', 'backend');
const PHC_WEB_DIR = path.join(ROOT, 'phc-local-app', 'frontend');
const INFERENCE_DIR = path.join(CENTRAL_DIR, 'ml-pipeline', 'inference');

/** KEY=value lines of a dotenv file (no interpolation); {} if the file is missing. */
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function config() {
  const central = readEnv(path.join(CENTRAL_DIR, '.env'));
  const phc = readEnv(path.join(PHC_DIR, '.env'));
  const centralWeb = readEnv(path.join(CENTRAL_WEB_DIR, '.env'));
  const phcWeb = readEnv(path.join(PHC_WEB_DIR, '.env'));
  return {
    central, phc, centralWeb, phcWeb,
    ports: {
      central: Number(central.PORT || 5000),
      phc: Number(phc.PORT || 4000),
      centralWeb: Number(centralWeb.CENTRAL_WEB_PORT || 5174),
      phcWeb: Number(phcWeb.PHC_WEB_PORT || 5173),
    },
    databaseUrl: central.DATABASE_URL || '',
  };
}

// ── logs: outside the repo, so nothing here can be committed ────────────────
function logDir() {
  const d = path.join(os.tmpdir(), `netrasetu-demo-${path.basename(ROOT)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ── ports and processes ──────────────────────────────────────────────────────
function pidsOnPort(port) {
  if (process.platform === 'win32') {
    // No `-p TCP`: that lists IPv4 only, and Vite binds [::1] (localhost -> ::1), so its
    // listeners were never found and never stopped. Plain -ano shows both families.
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
    const pids = new Set();
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[0] === 'TCP' && cols[3] === 'LISTENING' && /[:\]]/.test(cols[1]) && cols[1].endsWith(`:${port}`)) pids.add(Number(cols[4]));
    }
    return [...pids].filter(Boolean);
  }
  const r = spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return (r.stdout || '').split(/\s+/).map(Number).filter(Boolean);
}

function killPid(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
}

/** Stops whatever listens on `port`; returns the pids it stopped. */
async function stopPort(port) {
  const pids = pidsOnPort(port);
  pids.forEach(killPid);
  const t0 = Date.now();
  while (pidsOnPort(port).length && Date.now() - t0 < 15000) await sleep(300);
  return pids;
}

/** The persistent MATLAB session and the Python segmentation worker of THIS checkout. */
function stopWorkers() {
  if (process.platform !== 'win32') return 'not stopped (worker scripts are PowerShell-only)';
  const res = [];
  for (const [dir, script] of [['matlabSession', 'manageMatlabSession.ps1'], ['segSession', 'manageSegWorker.ps1']]) {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(INFERENCE_DIR, dir, script), 'stop'], { encoding: 'utf8' });
    res.push(`${dir}: ${(r.stdout || '').trim().split(/\r?\n/).pop() || 'ok'}`);
  }
  return res.join('; ');
}

/** Starts a Node entry point detached, logging to the temp dir. Returns the log path. */
function startNode(name, cwd, entry, extraEnv = {}) {
  const log = path.join(logDir(), `${name}.log`);
  const fd = fs.openSync(log, 'w');
  const child = spawn(process.execPath, [entry], {
    cwd, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
    env: { ...process.env, ...extraEnv },
  });
  child.unref();
  return log;
}

function startVite(name, dir, extraEnv = {}) {
  return startNode(name, dir, path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js'), extraEnv);
}

// ── waiting ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, opts = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs || 5000), ...opts });
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body };
}

/** Polls `check()` until it returns truthy or `timeoutMs` passes. */
async function waitFor(what, check, timeoutMs, everyMs = 2000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await check(); if (v) return v; } catch (e) { last = e.message; }
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${last ? ` (last error: ${last})` : ''}`);
}


async function centralHealthy(port) {
  const { status, body } = await getJson(`http://localhost:${port}/health`);
  const c = body && body.components;
  if (status !== 200 || !c) return false;
  const segOk = c.python.segWorker.status === 'healthy' || c.python.segWorker.status === 'disabled';
  return c.db.status === 'ok' && c.queue.status === 'ok' && c.matlabSession.status === 'healthy'
    && c.python.status === 'ok' && segOk ? c : false;
}

async function httpOk(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); return r.ok; } catch { return false; }
}

function startCentral(cfg) {
  return startNode('central', CENTRAL_DIR, path.join(CENTRAL_DIR, 'server.js'));
}

module.exports = {
  ROOT, CENTRAL_DIR, CENTRAL_WEB_DIR, PHC_DIR, PHC_WEB_DIR, INFERENCE_DIR,
  readEnv, config, logDir, pidsOnPort, stopPort, stopWorkers, startNode, startVite, startCentral,
  sleep, getJson, waitFor, centralHealthy, httpOk,
};
