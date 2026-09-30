#!/usr/bin/env node
'use strict';

/**
 * demo-reset.js -- put THIS checkout's stack into a clean, recording-ready state.
 *
 *   node scripts/demo-reset.js [--yes-wipe-database] [--skip-cases] [--no-review]
 *
 *   1. stops the stack (central, PHC desktop backend, both web frontends, the
 *      MATLAB session, the segmentation worker) -- by the ports and pid files this
 *      checkout's own .env files name, so a second worktree's stack is never touched
 *   2. wipes: the central database (dropped and recreated: cases, referrals,
 *      reviews, access log, alerts, users, PHC sites), central media, the PHC
 *      desktop's SQLite queue and its stored images, and the worker session logs
 *   3. runs every migration, re-seeds users and PHC sites (phc_code populated,
 *      fresh API keys; PHC001's id/key go into the PHC backend's git-ignored .env),
 *      and creates the PHC desktop technician account once its backend is up
 *   4. starts everything and waits until every /health check is green
 *   5. warms MATLAB and the models with one real inference (no case is created)
 *   6. creates the demo set (scripts/demo-set.json) through the REAL pipeline:
 *      PHC local backend -> quality gate -> sync -> central grading, then verifies
 *      each case got the outcome the demo needs
 *   7. reviews the cases that carry a `review` (as the demo ophthalmologist, through
 *      the real review API) and leaves the two referables UNREVIEWED
 *   8. prints credentials, URLs, case references, and how to clear the mobile store
 *
 * Secrets: passwords are generated per run and printed once at the end, in
 * memory only. Nothing is written to a file that git could pick up; service logs
 * go to the OS temp directory. The database is dropped by name from
 * central-system/backend/.env; the shared default name dr_screening_central is
 * refused unless --yes-wipe-database is given.
 *
 * Exit: 0 = ready; 1 = a step failed; 2 = ready but a demo case did not get the
 * outcome the demo needs (the table says which).
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const stack = require('./lib/demoStack');

const { ROOT, CENTRAL_DIR, PHC_DIR, INFERENCE_DIR } = stack;
const ARGS = process.argv.slice(2);
const FLAG = (n) => ARGS.includes(n);
const T0 = Date.now();
const say = (msg) => console.log(`[${String(Math.round((Date.now() - T0) / 1000)).padStart(4)}s] ${msg}`);
const need = (v, what) => { if (!v) throw new Error(what); return v; };

const cfg = stack.config();
const pg = () => require(require.resolve('pg', { paths: [CENTRAL_DIR] }));

// ── 1. stop ─────────────────────────────────────────────────────────────────
async function stopStack() {
  say('1/8 stopping this checkout\'s stack');
  for (const [name, port] of Object.entries(cfg.ports)) {
    const pids = await stack.stopPort(port);
    if (pids.length) say(`     stopped ${name} on :${port} (pid ${pids.join(',')})`);
  }
  say(`     workers: ${stack.stopWorkers()}`);
}

// ── 2. wipe ─────────────────────────────────────────────────────────────────
function rmChildren(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir)) { fs.rmSync(path.join(dir, e), { recursive: true, force: true }); n++; }
  return n;
}

async function wipe() {
  say('2/8 wiping database, media, PHC queue, logs');
  const url = new URL(need(cfg.databaseUrl, 'central-system/backend/.env has no DATABASE_URL'));
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error(`refusing odd database name '${dbName}'`);
  if (dbName === 'dr_screening_central' && !FLAG('--yes-wipe-database')) {
    throw new Error(`DATABASE_URL points at the shared default database '${dbName}'. `
      + 'That is the primary checkout\'s database; pass --yes-wipe-database if you mean to wipe it.');
  }
  url.pathname = '/postgres';
  const { Client } = pg();
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally { await admin.end(); }
  say(`     database '${dbName}' recreated`);

  const media = cfg.central.MEDIA_ROOT ? path.resolve(CENTRAL_DIR, cfg.central.MEDIA_ROOT) : path.join(CENTRAL_DIR, 'media');
  say(`     central media: ${rmChildren(media)} entries removed`);

  const dbFile = cfg.phc.LOCAL_DB_PATH ? path.resolve(PHC_DIR, cfg.phc.LOCAL_DB_PATH) : path.join(PHC_DIR, 'db', 'local.sqlite');
  let removed = 0;
  for (const f of [dbFile, `${dbFile}-shm`, `${dbFile}-wal`]) if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed++; }
  const storage = cfg.phc.LOCAL_STORAGE_DIR ? path.resolve(PHC_DIR, cfg.phc.LOCAL_STORAGE_DIR) : path.join(PHC_DIR, 'storage');
  say(`     PHC desktop: ${removed} sqlite files and ${rmChildren(storage)} stored entries removed`);

  for (const f of ['matlabSession/session.log', 'matlabSession/session.stdout.log', 'matlabSession/session.stderr.log',
    'segSession/worker.log']) fs.rmSync(path.join(INFERENCE_DIR, f), { force: true });
  for (const d of ['matlabSession/requests', 'matlabSession/responses', 'segSession/requests', 'segSession/responses']) {
    rmChildren(path.join(INFERENCE_DIR, d));
  }
}

// ── 3. migrate + seed ───────────────────────────────────────────────────────
function run(what, file, args, opts) {
  const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}):\n${(r.stdout || '').slice(-800)}\n${(r.stderr || '').slice(-800)}`);
  return r.stdout;
}

function migrateAndSeed() {
  say('3/8 migrating and seeding');
  run('migrations', path.join(ROOT, 'scripts', 'setupCentralDb.js'), [], { cwd: CENTRAL_DIR });
  const creds = {
    ophthalmologist: { email: 'ophthalmologist@demo.netrasetu.local', password: crypto.randomBytes(9).toString('base64url') },
    admin: { email: 'admin@demo.netrasetu.local', password: crypto.randomBytes(9).toString('base64url') },
  };
  // Output is captured and DROPPED: it carries API keys that are shown once. PHC001's
  // id and key are written by the seed itself into phc-local-app/backend/.env (git-ignored).
  run('seed', path.join(ROOT, 'scripts', 'seed-demo.js'), ['--write-phc-env'], {
    cwd: ROOT,
    env: { ...process.env, DEMO_OPHTHALMOLOGIST_PASSWORD: creds.ophthalmologist.password, DEMO_ADMIN_PASSWORD: creds.admin.password },
  });
  say('     users and PHC sites seeded (fresh API keys issued)');
  return creds;
}

// ── 4. start + health ───────────────────────────────────────────────────────
async function startAndWait() {
  say('4/8 starting the stack (MATLAB takes about a minute)');
  const cfg2 = stack.config();               // re-read: the seed rewrote the PHC .env
  const logs = {
    central: stack.startCentral(cfg2),
    phc: stack.startNode('phc-backend', PHC_DIR, path.join(PHC_DIR, 'server.js')),
    // Same for the central web app's /api proxy: it must point at THIS checkout's central port.
    centralWeb: stack.startVite('central-web', stack.CENTRAL_WEB_DIR, { CENTRAL_API_PROXY_TARGET: `http://localhost:${cfg2.ports.central}` }),
    // The PHC web app must talk to THIS checkout's backend port, whatever its .env still says
    // (a real environment variable beats .env in Vite). A stale :4000 shows "Cannot reach the PHC backend".
    phcWeb: stack.startVite('phc-web', stack.PHC_WEB_DIR, { VITE_LOCAL_API_BASE: `http://localhost:${cfg2.ports.phc}` }),
  };
  const p = cfg2.ports;
  await stack.waitFor('PHC backend /health', () => stack.httpOk(`http://localhost:${p.phc}/health`), 90000);
  await stack.waitFor('central web', () => stack.httpOk(`http://localhost:${p.centralWeb}/`), 90000);
  await stack.waitFor('PHC web', () => stack.httpOk(`http://localhost:${p.phcWeb}/`), 90000);
  const c = await stack.waitFor('central /health (db, queue, MATLAB session, Python, segmentation worker)',
    () => stack.centralHealthy(p.central), 6 * 60000, 3000);
  say(`     healthy: db ${c.db.status}, queue ${c.queue.status}, matlab ${c.matlabSession.status}, `
    + `python ${c.python.status} ${c.python.version}, seg worker ${c.python.segWorker.status}`);
  say(`     logs: ${path.dirname(logs.central)}`);
  return cfg2;
}

// The PHC desktop's login is real: a technician row in its SQLite (wiped above), created
// once the backend has made the schema. Generated password, printed once at the end.
function addTechnician() {
  const password = crypto.randomBytes(9).toString('base64url');
  const r = spawnSync(process.execPath, [path.join(PHC_DIR, 'scripts', 'technician.js'), 'add', 'technician', 'Demo Technician', '--password', password],
    { cwd: PHC_DIR, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`creating the PHC technician failed: ${(r.stderr || r.stdout || '').slice(-400)}`);
  say('     PHC technician account created');
  return { username: 'technician', password };
}

// ── 5. warm-up ──────────────────────────────────────────────────────────────
function warmUp() {
  say('5/8 warming MATLAB and the models with one real inference (no case is created)');
  const img = path.join(ROOT, 'tests', 'fixtures', 'idrid_003_good_borderline.jpg');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'lib', 'warmup.js'), img],
    { cwd: CENTRAL_DIR, encoding: 'utf8', timeout: 8 * 60000 });
  if (r.status !== 0) throw new Error(`warm-up failed: ${(r.stderr || r.stdout || '').slice(-500)}`);
  for (const l of r.stdout.trim().split(/\r?\n/)) say(`     ${l}`);
}

// ── 6. demo set through the real pipeline ───────────────────────────────────
function findIdrid(id) {
  const name = `IDRiD_${id}.jpg`;
  const rel = path.join('central-system', 'backend', 'ml-pipeline', 'datasets', 'idrid', 'grading',
    'B. Disease Grading', '1. Original Images', 'b. Testing Set', name);
  const cands = [process.env.IDRID_TESTING_DIR && path.join(process.env.IDRID_TESTING_DIR, name),
    path.join(ROOT, rel), path.join(ROOT, '..', 'SIH_2026', rel), path.join(ROOT, '..', 'SIH_2026-integration', rel)].filter(Boolean);
  const hit = cands.find((c) => fs.existsSync(c));
  if (!hit) throw new Error(`${name} not found. Set IDRID_TESTING_DIR to the IDRiD 'b. Testing Set' folder. Looked in:\n  ${cands.join('\n  ')}`);
  return hit;
}

async function phcCall(base, method, url, body, form, token) {
  const headers = form || !body ? {} : { 'content-type': 'application/json' };
  // Sent on every call. This script used to rely on LOCAL_AUTH_ENABLED=false,
  // which is why the PHC backend shipped with auth OFF -- and with it off,
  // anonymous GET /patients returns real names, ages and phone numbers to
  // anything on the same network. demo-reset logs in like a technician does
  // instead, so the flag can default to true.
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + url, { method, signal: AbortSignal.timeout(180000),
    body: form || (body ? JSON.stringify(body) : undefined), headers });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${json ? JSON.stringify(json) : text.slice(0, 200)}`
    + (r.status === 401 ? ' (PHC login failed or the session expired -- demo-reset signs in as the'
                        + ' technician account it just created; it no longer needs auth switched off)' : ''));
  return json;
}

/** The technician session demo-reset does its seeding through. */
async function phcLogin(base, creds) {
  const r = await fetch(`${base}/auth/login`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: creds.username, password: creds.password }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.token) {
    throw new Error(`PHC login as '${creds.username}' failed -> ${r.status} `
      + `${body ? JSON.stringify(body) : ''}. The account is created earlier in this run `
      + `(addTechnician), so this failing means the backend cannot read it.`);
  }
  return body.token;
}

async function createDemoSet(cfg2, creds) {
  say('6/8 creating the demo set through PHC backend -> quality gate -> sync -> central grading');
  const set = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-set.json'), 'utf8')).cases;
  const base = `http://localhost:${cfg2.ports.phc}`;
  const token = await phcLogin(base, creds.technician);
  const made = [];
  for (const [i, c] of set.entries()) {
    const file = findIdrid(c.idrid);
    const p = await phcCall(base, 'POST', '/patients', { name: c.name, age: c.age,
      contactNumber: `+91000000${String(1000 + i)}`, consentGivenAt: new Date().toISOString() }, null, token);
    const fd = new FormData();
    fd.append('patientId', p.patientId); fd.append('cameraDeviceId', 'unknown');
    fd.append('image', new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }), path.basename(file));
    // The gate is a fresh `matlab -batch` per capture; on Windows it now and then dies at
    // process start (exit 3221225794, DLL init) while other MATLABs are running. The
    // capture is saved and its 503 carries the id, so re-run the check instead of failing.
    let cap;
    try { cap = await phcCall(base, 'POST', '/captures', null, fd, token); } catch (err) {
      const m = /"captureId":"([^"]+)"/.exec(err.message);
      if (!/quality_gate_failed/.test(err.message) || !m) throw err;
      for (let attempt = 1; attempt <= 3 && !cap; attempt++) {
        say(`     quality gate did not start (attempt ${attempt}); re-running the check for ${m[1]}`);
        try { cap = await phcCall(base, 'POST', `/captures/${m[1]}/quality-check`, {}, null, token); } catch (e2) { if (attempt === 3) throw e2; }
      }
    }
    if (!['pass', 'borderline'].includes(cap.qualityStatus)) {
      throw new Error(`IDRiD_${c.idrid}: the quality gate said '${cap.qualityStatus}${cap.qualityReason ? '/' + cap.qualityReason : ''}', so it would never sync. Pick another image in demo-set.json.`);
    }
    await phcCall(base, 'POST', `/captures/${cap.captureId}/questionnaire`, { riskFactors: c.risk, symptoms: c.symptoms, language: 'en' }, null, token);
    await phcCall(base, 'POST', `/captures/${cap.captureId}/capture-metadata`, { cameraDeviceReported: 'unknown',
      pupilStatus: 'dilated', lightingEnvironment: 'indoor_clinic', observedIssues: ['none_noticed'],
      workerUsabilityRating: 'clear', eyeLaterality: c.eye }, null, token);
    say(`     ${c.role.padEnd(12)} IDRiD_${c.idrid}  captured (${cap.captureId}), gate ${cap.qualityStatus}`);
    made.push({ ...c, captureId: cap.captureId });
  }

  say('     waiting for the PHC sync manager to upload and central to grade all of them');
  const { Client } = pg();
  const db = new Client({ connectionString: cfg2.databaseUrl });
  await db.connect();
  try {
    const q = `SELECT c.capture_id_ref, c.case_id, c.status, p.patient_reference, g.dr_grade_cnn, g.dr_grade_rule_engine,
                      g.branch_agreement, g.conformal_tier, g.confidence_score, g.referable
               FROM cases c JOIN patients p ON p.patient_id = c.patient_id
               LEFT JOIN grading_results g ON g.case_id = c.case_id WHERE c.capture_id_ref = ANY($1)`;
    const ids = made.map((m) => m.captureId);
    const rows = await stack.waitFor('all demo cases to be graded', async () => {
      const { rows: r } = await db.query(q, [ids]);
      const bad = r.find((x) => x.status === 'error');
      if (bad) throw Object.assign(new Error(`case ${bad.case_id} failed grading`), { fatal: true });
      return r.length === ids.length && r.every((x) => x.status === 'graded') ? r : false;
    }, 15 * 60000, 5000);
    for (const m of made) Object.assign(m, rows.find((r) => r.capture_id_ref === m.captureId));
  } finally { await db.end(); }
  return made;
}

function verify(made) {
  let ok = true;
  for (const m of made) {
    const problems = [];
    if ('agree' in m.expect && m.branch_agreement !== m.expect.agree) problems.push(`branches ${m.branch_agreement ? 'agree' : 'disagree'}, demo needs ${m.expect.agree ? 'agree' : 'disagree'}`);
    if ('referable' in m.expect && m.referable !== m.expect.referable) problems.push(`referable=${m.referable}, demo needs ${m.expect.referable}`);
    m.problems = problems;
    if (problems.length) ok = false;
  }
  return ok;
}

// ── 7. reviews ──────────────────────────────────────────────────────────────
async function reviewSome(made, creds, cfg2) {
  say('7/8 reviewing the cases that carry a review; the referables stay unreviewed');
  const base = `http://localhost:${cfg2.ports.central}`;
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(creds.ophthalmologist) });
  if (!login.ok) throw new Error(`demo ophthalmologist login failed (${login.status})`);
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const csrf = (await login.json()).csrfToken;
  for (const m of made.filter((x) => x.review)) {
    const r = m.review;
    const body = { decision: r.decision, overrideReasonCategory: r.decision === 'override' ? r.category : null,
      ...(r.correctedGrade !== undefined ? { correctedGrade: r.correctedGrade } : {}) };
    const res = await fetch(`${base}/api/v1/cases/${m.case_id}/review`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`review of ${m.patient_reference} failed: ${res.status} ${JSON.stringify(out)}`);
    m.reviewed = `${r.decision}${r.correctedGrade !== undefined ? ` -> grade ${r.correctedGrade}` : ''}${out.referralId ? ', referral raised' : ''}`;
    say(`     ${m.patient_reference}: ${m.reviewed}`);
  }
}

// ── 8. report ───────────────────────────────────────────────────────────────
function report(made, creds, cfg2, ready) {
  const p = cfg2.ports;
  const L = '─'.repeat(78);
  console.log(`\n${L}\n  DEMO STACK ${ready ? 'READY' : 'READY, BUT A DEMO CASE IS NOT AS PLANNED (see below)'}   (${Math.round((Date.now() - T0) / 1000)} s)\n${L}`);
  console.log(`  PHC desktop (technician)      http://localhost:${p.phcWeb}     backend :${p.phc}`);
  console.log(`  Central (reviewer / admin)    http://localhost:${p.centralWeb}     backend :${p.central}`);
  console.log(`\n  Logins (generated for this run; shown once):`);
  console.log(`    ophthalmologist   ${creds.ophthalmologist.email}   ${creds.ophthalmologist.password}`);
  console.log(`    district admin    ${creds.admin.email}   ${creds.admin.password}`);
  console.log(`    PHC technician    ${creds.technician.username}   ${creds.technician.password}   (PHC desktop, site PHC Kharadi / PHC001)`);
  console.log(`\n  Cases (patient reference is what the screens show):`);
  console.log(`    ${'REFERENCE'.padEnd(11)}${'ROLE'.padEnd(14)}${'IMAGE'.padEnd(12)}${'CNN'.padEnd(5)}${'RULE'.padEnd(6)}${'TIER'.padEnd(6)}STATE`);
  for (const m of made) {
    const state = m.reviewed ? `reviewed (${m.reviewed})` : 'UNREVIEWED (live review scene)';
    console.log(`    ${String(m.patient_reference).padEnd(11)}${m.role.padEnd(14)}${('IDRiD_' + m.idrid).padEnd(12)}${String(m.dr_grade_cnn).padEnd(5)}${String(m.dr_grade_rule_engine ?? '-').padEnd(6)}${String(m.conformal_tier).padEnd(6)}${state}`);
    for (const pr of m.problems || []) console.log(`      !! ${pr}`);
  }
  console.log(`\n  Mobile app: clear its local store before recording (the phone keeps its own data):`);
  console.log(`    - Data lives in the app's SQLite database 'netrasetu.db' plus SecureStore entries.`);
  console.log(`    - Expo Go, Android: Settings > Apps > Expo Go > Storage > Clear data (or uninstall/reinstall).`);
  console.log(`      Expo Go, iOS: delete and reinstall Expo Go. A standalone build: uninstall and reinstall it.`);
  console.log(`    - Then point the app at this machine's LAN address (central :${p.central}) and the new PHC001 key`);
  console.log(`      in phc-local-app/backend/.env (PHC_ID / PHC_API_KEY): the old key no longer works.`);
  console.log(`\n  Offline scene:  node scripts/demo-offline.js stop | restore | status     (see docs/DEMO.md)`);
  console.log(`  Service logs:   ${stack.logDir()}\n${L}`);
}

(async () => {
  try {
    await stopStack();
    await wipe();
    const creds = migrateAndSeed();
    const cfg2 = await startAndWait();
    creds.technician = addTechnician();
    warmUp();
    if (FLAG('--skip-cases')) { report([], creds, cfg2, true); return; }
    const made = await createDemoSet(cfg2, creds);
    const ready = verify(made);
    if (!FLAG('--no-review')) await reviewSome(made, creds, cfg2);
    say('8/8 done');
    report(made, creds, cfg2, ready);
    process.exitCode = ready ? 0 : 2;
  } catch (err) {
    // A refused connection is an AggregateError with an empty message (localhost -> ::1 and 127.0.0.1).
    const codes = (err.errors || [err]).map((e) => e.code).filter(Boolean);
    const detail = err.message || (codes.length ? codes.join(', ') : String(err));
    const hint = codes.includes('ECONNREFUSED') ? '\nIs Postgres up? Start Docker Desktop, then: npm run db:up' : '';
    console.error(`\ndemo-reset FAILED: ${detail}${hint}\nService logs: ${stack.logDir()}`);
    process.exitCode = 1;
  }
})();
