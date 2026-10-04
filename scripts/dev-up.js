#!/usr/bin/env node
'use strict';


const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const ARGS = new Set(process.argv.slice(2));
const CHECK_ONLY = ARGS.has('--check');

const rel = (p) => path.join(ROOT, p);
const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', bold: '', reset: '' };

const step = (n, msg) => console.log(`\n${C.bold}[dev-up ${n}]${C.reset} ${msg}`);
const ok = (msg) => console.log(`  ${C.green}✓${C.reset} ${msg}`);
const warn = (msg) => console.log(`  ${C.yellow}!${C.reset} ${msg}`);
function die(msg, hint) {
  console.error(`\n  ${C.red}✗ ${msg}${C.reset}`);
  if (hint) console.error(`    ${hint}`);
  shutdown(1);
}

const SERVICE_DIRS = {
  centralApi: 'central-system/backend',
  phcApi: 'phc-local-app/backend',
  centralWeb: 'central-system/frontend',
  phcWeb: 'phc-local-app/frontend',
};

// ── helpers ─────────────────────────────────────────────────────────────────


const needsShell = (cmd) => IS_WIN && !path.isAbsolute(cmd);
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: needsShell(cmd), ...opts });
  return r.status === 0;
}
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: needsShell(cmd), ...opts });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** KEY=VALUE files, first non-empty value wins -- the same rule as loadEnv.js. */
function readEnvChain(files) {
  const out = {};
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      if (v !== '' && (out[m[1]] === undefined || out[m[1]] === '')) out[m[1]] = v;
    }
  }
  return { ...out, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')) };
}

function portInUse(port) {
  const tryHost = (host) => new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
  return Promise.all([tryHost('127.0.0.1'), tryHost('::1')]).then((r) => r.some(Boolean));
}

async function httpOk(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 200) };
  } catch (err) {
    return { ok: false, status: null, body: err.cause?.code || err.message };
  }
}

async function waitFor(label, fn, { timeoutMs, intervalMs = 1000 }) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last?.ok) return last;
    if (shuttingDown) return last;
    await sleep(intervalMs);
  }
  return last;
}

// ── child processes ─────────────────────────────────────────────────────────

const children = [];
let shuttingDown = false;

function startService(name, dir, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: rel(dir),
    env: { ...process.env, FORCE_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const tag = `${C.dim}[${name}]${C.reset} `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) out.write(`${tag}${l}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`${tag}${C.red}exited (${signal || code}) -- see its log above${C.reset}`);
    }
  });
  children.push({ name, child });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (children.length) console.log(`\n[dev-up] stopping ${children.length} service(s)…`);
  for (const { child } of children) {
    if (child.exitCode !== null) continue;
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGINT');
  }
  // Give POSIX children a moment to exit cleanly, then leave.
  setTimeout(() => process.exit(code), IS_WIN ? 200 : 1500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ── steps ───────────────────────────────────────────────────────────────────

async function ensureDocker() {
  if (!capture('docker', ['--version']).ok) {
    die('Docker is not installed or not on PATH.', 'Install Docker Desktop (https://docs.docker.com/get-docker/) and re-run.');
  }
  if (capture('docker', ['info', '--format', '{{.ServerVersion}}']).ok) return ok('Docker daemon is running');

  const desktop = IS_WIN && [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
  ].find((p) => fs.existsSync(p));
  if (!desktop) die('The Docker daemon is not running.', 'Start Docker Desktop (or `sudo systemctl start docker`) and re-run.');

  warn('Docker daemon not running -- starting Docker Desktop (this can take a minute)…');
  spawn(desktop, [], { detached: true, stdio: 'ignore' }).unref();
  const r = await waitFor('docker', () => ({ ok: capture('docker', ['info', '--format', '{{.ServerVersion}}']).ok }),
    { timeoutMs: 180_000, intervalMs: 3000 });
  if (!r?.ok) die('Docker Desktop did not come up within 3 minutes.', 'Start it by hand, wait for "Engine running", and re-run.');
  ok('Docker daemon is running');
}

function ensureEnvFiles() {
  for (const dir of Object.values(SERVICE_DIRS)) {
    const env = rel(`${dir}/.env`);
    if (fs.existsSync(env)) { ok(`${dir}/.env exists (kept as is)`); continue; }
    fs.copyFileSync(rel(`${dir}/.env.example`), env);
    ok(`${dir}/.env created from .env.example`);
  }

  // Secrets the central backend needs that must never be committed: generated
  // here, per machine, only when the line is present and empty.
  const centralEnv = rel(`${SERVICE_DIRS.centralApi}/.env`);
  let text = fs.readFileSync(centralEnv, 'utf8');
  const generated = [];
  for (const [key, make] of [
    ['JWT_SECRET', () => require('crypto').randomBytes(48).toString('base64url')],
    ['MEDIA_ENCRYPTION_KEY', () => require('crypto').randomBytes(32).toString('hex')],
  ]) {
    const re = new RegExp(`^${key}=[ \\t]*$`, 'm');
    if (re.test(text)) { text = text.replace(re, `${key}=${make()}`); generated.push(key); }
  }
  if (generated.length) {
    fs.writeFileSync(centralEnv, text);
    ok(`generated ${generated.join(' and ')} in ${SERVICE_DIRS.centralApi}/.env (keep MEDIA_ENCRYPTION_KEY: without it encrypted media is unreadable)`);
  }
}

function ensureInstalled() {
  if (ARGS.has('--skip-install')) return warn('--skip-install: not checking node_modules');
  for (const dir of Object.values(SERVICE_DIRS)) {
    if (fs.existsSync(rel(`${dir}/node_modules`))) { ok(`${dir}: node_modules present`); continue; }
    console.log(`  … npm install in ${dir}`);
    if (!run('npm', ['install', '--no-audit', '--no-fund'], { cwd: rel(dir) })) die(`npm install failed in ${dir}.`);
    ok(`${dir}: installed`);
  }
}

function matlabExecutable(centralEnv) {
  const configured = centralEnv.MATLAB_EXECUTABLE;
  if (configured) return fs.existsSync(configured) ? configured : null;
  const r = capture(IS_WIN ? 'where' : 'which', ['matlab']);
  return r.ok ? r.out.split(/\r?\n/)[0] : null;
}

function heartbeatAgeMs(centralEnv, which = 'matlab') {
  const hb = which === 'matlab'
    ? centralEnv.MATLAB_HEARTBEAT_PATH || rel('central-system/backend/ml-pipeline/inference/matlabSession/session.heartbeat')
    : centralEnv.SEG_HEARTBEAT_PATH || rel('central-system/backend/ml-pipeline/inference/segSession/worker.heartbeat');
  try { return Date.now() - fs.statSync(hb).mtimeMs; } catch { return null; }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  step(1, 'preflight');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) die(`Node ${process.versions.node} is too old; 18+ is required (22 LTS recommended).`);
  ok(`Node ${process.versions.node}`);
  await ensureDocker();

  step(2, 'env files');
  ensureEnvFiles();
  const centralEnv = readEnvChain([rel('central-system/backend/.env'), rel('.env')]);
  const PORTS = {
    centralApi: Number(centralEnv.PORT || 5000),
    phcApi: Number(readEnvChain([rel('phc-local-app/backend/.env')]).PORT || 4000),
    centralWeb: 5174,   // pinned in central-system/frontend/vite.config.js
    phcWeb: 5173,   // pinned in phc-local-app/frontend/vite.config.js
  };

  step(3, 'dependencies');
  ensureInstalled();

  for (const [name, port] of Object.entries(PORTS)) {
    if (await portInUse(port)) {
      die(`Port ${port} (${name}) is already in use.`,
        'A previous dev-up (or another app) is still running. Stop it and re-run.');
    }
  }

  step(4, 'Postgres (docker-compose.dev.yml)');
  if (!run('docker', ['compose', '-f', 'docker-compose.dev.yml', 'up', '-d', '--wait', '--quiet-pull'])) {
    die('docker compose up failed.', 'If the port is taken, set NETRASETU_PG_PORT in the root .env and DATABASE_URL to match.');
  }
  ok('Postgres is up and healthy');

  step(5, 'migrations');
  if (!run(process.execPath, ['scripts/setupCentralDb.js'])) die('Migrations failed.');

  step(6, 'seed');
  if (!run(process.execPath, ['scripts/seed-demo.js', '--write-phc-env'])) die('Seeding failed.');
  const techs = capture(process.execPath, ['scripts/technician.js', 'list'], { cwd: rel('phc-local-app/backend') });
  if (!techs.ok) die('Could not read the PHC technician list.', techs.out);
  if (techs.out.split(/\r?\n/).some((l) => /\bactive\b/.test(l))) {
    ok('PHC local database already has a technician account');
  } else {
    console.log('  PHC local database has no technician account -- creating one (password shown once):');
    if (!run(process.execPath, ['scripts/technician.js', 'add', 'technician', 'Demo Technician'],
      { cwd: rel('phc-local-app/backend') })) die('Could not create the technician account.');
  }

  step(7, 'starting services');
  const vite = 'node_modules/vite/bin/vite.js';
  startService('central-api', SERVICE_DIRS.centralApi, ['server.js']);
  startService('phc-api', SERVICE_DIRS.phcApi, ['server.js']);
  startService('central-web', SERVICE_DIRS.centralWeb, [vite]);
  startService('phc-web', SERVICE_DIRS.phcWeb, [vite]);

  step(8, 'health checks');
  const checks = [
    { name: 'Central API', url: `http://localhost:${PORTS.centralApi}/health` },
    { name: 'PHC local API', url: `http://localhost:${PORTS.phcApi}/health` },
    { name: 'Central web', url: `http://localhost:${PORTS.centralWeb}/` },
    { name: 'PHC web', url: `http://localhost:${PORTS.phcWeb}/` },
  ];
  const health = [];
  for (const c of checks) {
    const r = await waitFor(c.name, () => httpOk(c.url), { timeoutMs: 60_000 });
    health.push({ ...c, ...r });
    if (r?.ok) ok(`${c.name.padEnd(14)} ${c.url} -> ${r.status} ${c.url.endsWith('/health') ? r.body : ''}`);
    else warn(`${c.name.padEnd(14)} ${c.url} -> NOT RESPONDING (${r?.status ?? r?.body})`);
  }

  step(9, 'MATLAB session');
  const matlabWanted = [centralEnv.INFERENCE_BACKEND, centralEnv.SEG_INFERENCE_BACKEND]
    .some((v) => (v || 'matlab').toLowerCase() === 'matlab')
    && !/^(0|false|no|off)$/i.test(centralEnv.MATLAB_SUPERVISOR_ENABLED || '');
  let matlab = { state: 'not needed', detail: 'INFERENCE_BACKEND and SEG_INFERENCE_BACKEND are not matlab' };
  if (matlabWanted) {
    const exe = matlabExecutable(centralEnv);
    if (!exe) {
      matlab = {
        state: 'MISSING', detail: centralEnv.MATLAB_EXECUTABLE
          ? `MATLAB_EXECUTABLE=${centralEnv.MATLAB_EXECUTABLE} does not exist`
          : '`matlab` is not on PATH and MATLAB_EXECUTABLE is unset'
      };
      warn(`MATLAB not found: ${matlab.detail}. Grading through MATLAB will not work.`);
    } else if (ARGS.has('--no-matlab-wait')) {
      matlab = { state: 'not checked', detail: '--no-matlab-wait' };
      warn('--no-matlab-wait: not waiting for the session heartbeat');
    } else {
      const graceMs = Number(centralEnv.MATLAB_STARTUP_GRACE_MS) > 0 ? Number(centralEnv.MATLAB_STARTUP_GRACE_MS) : 240_000;
      const staleMs = Number(centralEnv.MATLAB_HEARTBEAT_STALE_MS) > 0 ? Number(centralEnv.MATLAB_HEARTBEAT_STALE_MS) : 30_000;
      console.log(`  waiting up to ${Math.round(graceMs / 1000)} s for the session heartbeat (${exe})…`);
      const started = Date.now();
      const r = await waitFor('matlab', () => {
        const age = heartbeatAgeMs(centralEnv);
        return { ok: age !== null && age < staleMs, age };
      }, { timeoutMs: graceMs, intervalMs: 3000 });
      if (r?.ok) {
        matlab = { state: 'healthy', detail: `heartbeat ${Math.round(r.age / 1000)} s old, up after ${Math.round((Date.now() - started) / 1000)} s` };
        ok(`MATLAB session healthy (${matlab.detail})`);
      } else {
        matlab = { state: 'NOT UP', detail: `no fresh heartbeat after ${Math.round(graceMs / 1000)} s -- see central-system/backend/ml-pipeline/inference/matlabSession/session.log` };
        warn(`MATLAB session ${matlab.detail}`);
      }
    }
  }

  // The Python segmentation worker: informational, not a gate. Grading works
  // without it (about 17 s slower per case), but a dead one should be visible.
  let seg = { state: 'disabled', detail: 'SEG_WORKER_SUPERVISOR_ENABLED is off' };
  if (!/^(0|false|no|off)$/i.test(centralEnv.SEG_WORKER_SUPERVISOR_ENABLED || '')) {
    const r = await waitFor('seg', () => {
      const age = heartbeatAgeMs(centralEnv, 'seg');
      return { ok: age !== null && age < 30_000, age };
    }, { timeoutMs: 20_000, intervalMs: 2000 });
    seg = r?.ok
      ? { state: 'healthy', detail: `heartbeat ${Math.round(r.age / 1000)} s old` }
      : {
        state: 'NOT UP', detail: 'grading still works, ~17 s slower per case -- check PYTHON_EXECUTABLE and '
          + 'central-system/backend/ml-pipeline/inference/segSession/worker.log'
      };
    (r?.ok ? ok : warn)(`Segmentation worker ${seg.state} (${seg.detail})`);
  }

  step(10, 'summary');
  const allHealthy = health.every((h) => h.ok) && !['MISSING', 'NOT UP'].includes(matlab.state);
  const line = '─'.repeat(72);
  console.log(line);
  console.log(`  Central web (ophthalmologist / district admin)  http://localhost:${PORTS.centralWeb}`);
  console.log(`  PHC web (technician)                            http://localhost:${PORTS.phcWeb}`);
  console.log(`  Central API                                     http://localhost:${PORTS.centralApi}  (/health)`);
  console.log(`  PHC local API                                   http://localhost:${PORTS.phcApi}  (/health)`);
  console.log(`  Postgres (docker)                               localhost:${centralEnv.NETRASETU_PG_PORT || 5433}`);
  console.log(`  MATLAB session                                  ${matlab.state} -- ${matlab.detail}`);
  console.log(`  Segmentation worker (Python, optional)          ${seg.state} -- ${seg.detail}`);
  console.log(line);
  for (const h of health) console.log(`  ${h.ok ? `${C.green}OK  ` : `${C.red}FAIL`}${C.reset}  ${h.name}`);
  console.log(line);
  console.log(allHealthy
    ? `  ${C.green}Everything is up.${C.reset}${CHECK_ONLY ? '' : ' Ctrl+C stops all services (Postgres keeps running: docker compose -f docker-compose.dev.yml down).'}`
    : `  ${C.red}Something is not healthy -- see above.${C.reset}`);
  console.log(`  Data mode: central web ${readEnvChain([rel('central-system/frontend/.env')]).VITE_DATA_MODE || 'live'}, ` +
    `PHC web ${readEnvChain([rel('phc-local-app/frontend/.env')]).VITE_DATA_MODE || 'live'}.`);
  console.log(line);

  if (CHECK_ONLY) shutdown(allHealthy ? 0 : 1);
}

main().catch((err) => { console.error(err); shutdown(1); });

