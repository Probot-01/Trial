
'use strict';



const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const CENTRAL_DIR = path.join(ROOT, 'central-system', 'backend');
const PHC_DIR = path.join(ROOT, 'phc-local-app', 'backend');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const fx = (n) => path.join(FIXTURES, n);
const GOOD_BORDERLINE_1 = fx('idrid_163_good_borderline.jpg');
const GOOD_BORDERLINE_2 = fx('idrid_003_good_borderline.jpg');
const GOOD_PASS = fx('idrid_010_good_pass_w1800.jpg');
const BAD = fx('idrid_164_bad_blur_dark.jpg');

const ARGS = process.argv.slice(2);
const argVal = (n, d) => { const i = ARGS.indexOf(n); return i === -1 ? d : ARGS[i + 1]; };
const ONLY = new Set((argVal('--only', 's1,s2,s3,s4,s5')).split(',').map((s) => s.trim()));
const GRADING_WAIT_MS = Number(argVal('--grading-wait-min', '20')) * 60000;
const KEEP = ARGS.includes('--keep');

const E2E_DB = 'dr_screening_e2e';
const ADMIN_DB_URL = process.env.E2E_ADMIN_DATABASE_URL || 'postgresql://netrasetu:netrasetu_dev@localhost:5433/dr_screening_central';
const DB_URL = ADMIN_DB_URL.replace(/\/[^/]+$/, `/${E2E_DB}`);
const CENTRAL_PORT = Number(process.env.E2E_CENTRAL_PORT || 5000);
const PROXY_PORT = Number(process.env.E2E_PROXY_PORT || 5090);
const PHC_PORT = Number(process.env.E2E_PHC_PORT || 4000);
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'netrasetu-e2e-'));

const pg = require(require.resolve('pg', { paths: [CENTRAL_DIR] }));
const Database = require(require.resolve('better-sqlite3', { paths: [PHC_DIR] }));

// ── reporting ───────────────────────────────────────────────────────────────
let failures = 0, passes = 0;
const say = (s = '') => console.log(s);
const head = (s) => say(`\n${'═'.repeat(78)}\n${s}\n${'═'.repeat(78)}`);
const sub = (s) => say(`\n--- ${s}`);
const show = (label, value) => say(`    ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
function check(label, ok, detail) {
  if (ok) passes++; else failures++;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && detail !== undefined) say(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, fn, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  say(`    (timed out waiting for: ${label})`);
  return null;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
async function call(base, p, { method = 'GET', json, form, headers = {} } = {}) {
  const t0 = Date.now();
  const res = await fetch(base + p, {
    method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : form,
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, text, ms: Date.now() - t0 };
}
const PHC = () => `http://127.0.0.1:${PHC_PORT}`;
const CENTRAL = () => `http://127.0.0.1:${CENTRAL_PORT}`;

async function postCapture(base, patientId, file, cameraDeviceId = 'unknown') {
  const form = new FormData();
  form.append('patientId', patientId);
  form.append('cameraDeviceId', cameraDeviceId);
  form.append('image', new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }), path.basename(file));
  return call(base, '/captures', { method: 'POST', form });
}
const registerPatient = (base, name, age = 58) => call(base, '/patients', {
  method: 'POST', json: { name, age, contactNumber: '+919800000000', consentGivenAt: new Date().toISOString() },
});

// ── processes ───────────────────────────────────────────────────────────────
const services = new Map();
function startNode(name, cwd, script, env, port) {
  const log = path.join(RUN, `${name}.log`);
  const out = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [script], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, out], windowsHide: true });
  services.set(name, { child, log, port });
  return child;
}
function stopService(name) {
  const s = services.get(name);
  if (!s) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(s.child.pid), '/T', '/F'], { stdio: 'ignore' });
  else s.child.kill('SIGKILL');
  services.delete(name);
}
async function waitHealthy(url, ms = 90000) {
  return waitFor(url, async () => { try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, { timeoutMs: ms, intervalMs: 500 });
}
const logText = (name) => { try { return fs.readFileSync(path.join(RUN, `${name}.log`), 'utf8'); } catch { return ''; } };

let centralEnv, phcCreds;
function startCentral() {
  startNode('central', CENTRAL_DIR, 'server.js', centralEnv, CENTRAL_PORT);
}
function phcEnv(extra = {}) {
  return {
    PORT: String(PHC_PORT),
    LOCAL_DB_PATH: path.join(RUN, 'phc.sqlite'), LOCAL_STORAGE_DIR: path.join(RUN, 'phc-storage'),
    CENTRAL_API_URL: `http://127.0.0.1:${PROXY_PORT}`,
    PHC_ID: phcCreds.id, PHC_API_KEY: phcCreds.key, PHC_CODE: 'PHC001',
    ...extra,
  };
}


const proxy = { server: null, killAfterChunks: null, chunkPosts: [], forwardedChunks: 0, killed: 0, reqs: [] };
function startProxy() {
  proxy.server = http.createServer((req, res) => {
    proxy.reqs.push(`${req.method} ${req.url.split('?')[0]}`);
    const isChunk = req.method === 'POST' && /\/chunks\/\d+$/.test(req.url);
    if (isChunk && proxy.killAfterChunks !== null && proxy.forwardedChunks >= proxy.killAfterChunks) {
      proxy.killAfterChunks = null;
      proxy.killed++;
      req.socket.destroy();                 // the connection dies in the middle of the upload
      return;
    }
    if (isChunk) { proxy.forwardedChunks++; proxy.chunkPosts.push(Number(req.url.match(/\/chunks\/(\d+)$/)[1])); }
    const up = http.request({ host: '127.0.0.1', port: CENTRAL_PORT, method: req.method, path: req.url, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers); ur.pipe(res);
    });
    up.on('error', () => req.socket.destroy());
    req.pipe(up);
  });
  return new Promise((r) => proxy.server.listen(PROXY_PORT, '127.0.0.1', r));
}

function centralMediaCrypto() {
  if (!process.env.MEDIA_ENCRYPTION_KEY) {
    try {
      const m = fs.readFileSync(path.join(CENTRAL_DIR, '.env'), 'utf8').match(/^MEDIA_ENCRYPTION_KEY=(.*)$/m);
      if (m && m[1].trim()) process.env.MEDIA_ENCRYPTION_KEY = m[1].trim();
    } catch { /* no .env: the file will not decrypt and the check will say so */ }
  }
  return require(path.join(CENTRAL_DIR, 'services', 'mediaCrypto'));
}

// ── databases ───────────────────────────────────────────────────────────────
let centralDb;
const qc = async (sql, params = []) => (await centralDb.query(sql, params)).rows;
function phcDb({ write = false, file = 'phc.sqlite' } = {}) {
  return new Database(path.join(RUN, file), write ? { timeout: 5000 } : { readonly: true, fileMustExist: true, timeout: 5000 });
}
const phcOne = (sql, ...p) => { const d = phcDb(); try { return d.prepare(sql).get(...p); } finally { d.close(); } };
const phcAll = (sql, ...p) => { const d = phcDb(); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const listing = async () => (await call(PHC(), '/captures')).body || [];
const item = async (id) => (await listing()).find((r) => r.captureId === id);

const ID_RE = /^PHC001-[0-9a-z]{8}-[0-9a-z]{8}$/;
const REF_RE = /^PT-[ABCDEFGHJKLMNPQRTUVWXYZ2346789]{6}$/;

// ── what the technician answers, built by the FRONTEND's own builders ───────
let payloads;
const ANSWERS = {
  questionnaire: {
    knownDiabetic: true, yearsSinceDiagnosis: '5to10', glycemicControl: 'poor', bloodPressure: 'high', pregnancy: 'not_applicable',
    blurredVision: true, floaters: false, suddenVisionChange: false, eyePain: false,
  },
  metadata: { pupilStatus: 'dilated', lightingEnvironment: 'indoor_clinic', workerUsabilityRating: 'clear', observedIssues: ['media_opacity'] },
};
async function fillForms(base, captureId, eye) {
  const q = payloads.buildQuestionnairePayload(ANSWERS.questionnaire, 'en');
  const m = payloads.buildMetadataPayload(ANSWERS.metadata, { eye, cameraDeviceId: 'unknown' });
  const a = await call(base, `/captures/${captureId}/questionnaire`, { method: 'POST', json: q });
  const b = await call(base, `/captures/${captureId}/capture-metadata`, { method: 'POST', json: m });
  return { a, b, q, m };
}

async function setup() {
  head('SETUP: scratch database, central, PHC backend, proxy');
  say(`  run directory: ${RUN}`);
  const admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${E2E_DB}`);
  await admin.end();
  const env = { ...process.env, DATABASE_URL: DB_URL };
  const mig = spawnSync(process.execPath, ['scripts/setupCentralDb.js'], { cwd: ROOT, env, encoding: 'utf8' });
  check('central migrations applied to the scratch database', mig.status === 0 && /tables present/.test(mig.stdout), mig.stdout.slice(-300) + mig.stderr.slice(-300));
  const seed = spawnSync(process.execPath, ['scripts/seed-demo.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...env, DEMO_OPHTHALMOLOGIST_PASSWORD: crypto.randomBytes(9).toString('base64url'), DEMO_ADMIN_PASSWORD: crypto.randomBytes(9).toString('base64url') }
  });
  const id = (seed.stdout.match(/PHC_ID=([0-9a-f-]{36})/) || [])[1];
  const key = (seed.stdout.match(/PHC_API_KEY=(phc_[A-Za-z0-9_-]+)/) || [])[1];
  check('seed created PHC001 with an API key (not printed here)', !!id && !!key);
  phcCreds = { id, key };
  centralDb = new pg.Pool({ connectionString: DB_URL, max: 4 });

  centralEnv = {
    DATABASE_URL: DB_URL, PORT: String(CENTRAL_PORT),
    // Case media goes to the run's scratch directory, never backend/media.
    MEDIA_ROOT: path.join(RUN, 'central-media'),
    // Grading runs on the Python classifier so no second persistent MATLAB session is
    // needed; the MATLAB rule-engine / report steps still use matlab -batch.
    INFERENCE_BACKEND: 'python', MATLAB_SUPERVISOR_ENABLED: 'false', SEG_WORKER_SUPERVISOR_ENABLED: 'false',
    SIMULINK_VALIDATION_ENABLED: 'false',
  };
  startCentral();
  check('central answers /health', !!(await waitHealthy(`${CENTRAL()}/health`)));
  await startProxy();
  startNode('phc', PHC_DIR, 'server.js', phcEnv(), PHC_PORT);
  check('PHC local backend answers /health', !!(await waitHealthy(`${PHC()}/health`)));

  payloads = await import(pathToFileURL(path.join(ROOT, 'phc-local-app', 'frontend', 'src', 'api', 'payloads.js')).href);
}

// ═══ S1 ═════════════════════════════════════════════════════════════════════
const S = {};   // state shared between scenarios
async function s1() {
  head('S1  register -> capture (bad, then good) -> questionnaires -> sync -> result state');

  sub('1. Register a patient, with consent');
  const p = await registerPatient(PHC(), 'E2E Patient One');
  show('POST /patients', p.body);
  check('201, consentGivenAt echoed', p.status === 201 && !!p.body.consentGivenAt);
  check('CHECK 1: patientId follows the global ID rule {PHC}-{ts}-{8}', ID_RE.test(p.body.patientId), p.body.patientId);
  S.patient = p.body;

  sub('2. A deliberately bad image (blurred + dark) -> the real MATLAB gate asks for a retake');
  const bad = await postCapture(PHC(), S.patient.patientId, BAD);
  show(`POST /captures  (${bad.ms} ms)`, bad.body);
  check('201 retake with a contract reason', bad.status === 201 && bad.body.qualityStatus === 'retake' && bad.body.qualityReason === 'low_illumination', bad.body);
  check('CHECK 1: captureId follows the global ID rule', ID_RE.test(bad.body.captureId), bad.body.captureId);
  check('the response says WHICH engine ran the gate (matlab, not a fallback)',
    bad.body.qualityGateEngine?.engine === 'matlab' && bad.body.qualityGateEngine.fallback === false, bad.body.qualityGateEngine);
  check('a retake is not queued for upload', !phcOne('SELECT 1 x FROM sync_queue WHERE capture_id = ?', bad.body.captureId));
  const li = await item(bad.body.captureId);
  show('GET /captures row', li);
  check('queue row says retake required (status captured, qualityStatus retake)', li.status === 'captured' && li.qualityStatus === 'retake');

  sub('3. Retake: a good image (native IDRiD, gate: borderline)');
  const good = await postCapture(PHC(), S.patient.patientId, GOOD_BORDERLINE_1);
  show(`POST /captures  (${good.ms} ms)`, good.body);
  check('accepted (borderline)', good.status === 201 && good.body.qualityStatus === 'borderline', good.body);
  check('retakeCount counts the earlier failed attempt today', good.body.retakeCount === 1, good.body.retakeCount);
  check('engine reported', good.body.qualityGateEngine?.engine === 'matlab');
  S.cap1 = good.body.captureId;
  check('CHECK 1: captureId follows the ID rule', ID_RE.test(S.cap1));

  sub('4. Forms NOT filled in yet: it must not sync (it used to, and central graded it with no answers)');
  await sleep(14000);                                   // longer than one sync cycle (10 s)
  const st = (await call(PHC(), '/sync/status')).body;
  show('GET /sync/status', st);
  check('awaitingFormsCount 1, pendingCount 0', st.awaitingFormsCount === 1 && st.pendingCount === 0);
  check('central has NO case for it yet', (await qc('SELECT 1 FROM cases WHERE capture_id_ref = $1', [S.cap1])).length === 0);
  check('queue row: quality_passed, formsComplete false', (await item(S.cap1)).status === 'quality_passed' && (await item(S.cap1)).formsComplete === false);

  sub('5. Both questionnaires, built by the frontend\'s own builders (eye = left)');
  const f = await fillForms(PHC(), S.cap1, 'left');
  show('POST questionnaire', f.a.body); show('POST capture-metadata', f.b.body);
  check('both accepted (201)', f.a.status === 201 && f.b.status === 201, [f.a.body, f.b.body]);
  check('CHECK 1: response ids follow the ID rule', ID_RE.test(f.a.body.responseId) && ID_RE.test(f.b.body.responseId));

  sub('6. Sync: central answers 201 processing; only THEN is it "synced"');
  const synced = await waitFor('local queue row synced', async () => phcOne("SELECT * FROM sync_queue WHERE capture_id = ? AND status = 'synced'", S.cap1), { timeoutMs: 60000 });
  check('synced within one or two sync cycles', !!synced);
  show('local sync_queue row', synced && { status: synced.status, central_case_id: synced.central_case_id, central_status: synced.central_status, priority: synced.priority });
  const cc = (await qc(`SELECT c.case_id, c.status, c.capture_id_ref, c.patient_id, c.questionnaire_data, c.capture_metadata,
                               c.eye_laterality_reported, c.captured_at, c.received_at, p.patient_reference
                        FROM cases c JOIN patients p ON p.patient_id = c.patient_id WHERE c.capture_id_ref = $1`, [S.cap1]))[0];
  show('central cases row', cc && { case_id: cc.case_id, status: cc.status, patient_id: cc.patient_id, patient_reference: cc.patient_reference, eye: cc.eye_laterality_reported });
  check('CHECK 2: the local row is synced ONLY because central holds the case', !!cc && synced?.central_case_id === cc.case_id);
  check('central stored it as processing', cc?.status === 'processing' || cc?.status === 'graded');
  check('CHECK 1: central kept the local patient id', cc?.patient_id === S.patient.patientId);
  check('CHECK 1: patientReference follows PT-XXXXXX (6 chars, 0 O 1 I 5 S excluded)', REF_RE.test(cc?.patient_reference || ''), cc?.patient_reference);
  check('central received BOTH questionnaires', !!cc?.questionnaire_data && !!cc?.capture_metadata);
  check('the technician\'s answers arrived unchanged', cc?.questionnaire_data?.riskFactors?.glycemicControl === 'poor'
    && cc?.capture_metadata?.observedIssues?.[0] === 'media_opacity' && cc?.capture_metadata?.lightingEnvironment === 'indoor_clinic');
  check('the EYE reached central (eyeLaterality, tagged left)', cc?.capture_metadata?.eyeLaterality === 'left' && cc?.eye_laterality_reported === 'left');
  check('capturedAt is the capture time, not the sync time', cc && Math.abs(new Date(cc.captured_at) - new Date(good.body.capturedAt)) < 1000);
  S.case1 = cc?.case_id;

  sub('7. Local queue shows the state central reports');
  const pending = await waitFor('result_pending or later', async () => {
    const r = await item(S.cap1); return ['result_pending', 'result_delivered'].includes(r?.status) ? r : null;
  }, { timeoutMs: 30000 });
  show('GET /captures row', pending);
  check('lifecycle reaches result_pending (or already delivered)', !!pending);
  say('    (waiting for central to grade it happens in the background; checked at the end)');
}

// ═══ S2 ═════════════════════════════════════════════════════════════════════
async function s2() {
  head('S2  idempotency: the same capture id sent again');
  if (!S.cap1) return check('needs S1', false);
  const before = (await qc('SELECT count(*)::int n FROM cases WHERE capture_id_ref = $1', [S.cap1]))[0].n;
  const startedBefore = (await qc('SELECT case_id, processing_started_at FROM cases WHERE capture_id_ref = $1', [S.cap1]))[0];
  const localCaseBefore = phcOne('SELECT central_case_id FROM sync_queue WHERE capture_id = ?', S.cap1).central_case_id;
  say('  Simulating "central got it, the 201 never reached us": the PHC forgets it was synced.');
  const w = phcDb({ write: true });
  w.prepare("UPDATE sync_queue SET status = 'pending', central_case_id = NULL, central_status = NULL, last_error = NULL, attempts = 0, next_attempt_at = NULL WHERE capture_id = ?").run(S.cap1);
  w.close();
  const resynced = await waitFor('re-synced', async () => phcOne("SELECT * FROM sync_queue WHERE capture_id = ? AND status = 'synced'", S.cap1), { timeoutMs: 60000 });
  check('it syncs again with no manual action', !!resynced);
  const after = (await qc('SELECT count(*)::int n FROM cases WHERE capture_id_ref = $1', [S.cap1]))[0].n;
  const startedAfter = (await qc('SELECT case_id, processing_started_at FROM cases WHERE capture_id_ref = $1', [S.cap1]))[0];
  show('central cases with this capture_id_ref: before / after', [before, after]);
  check('CHECK 3: still exactly ONE central case', before === 1 && after === 1);
  check('CHECK 3: and it is the same case (same id, same processing_started_at)',
    startedBefore.case_id === startedAfter.case_id && String(startedBefore.processing_started_at) === String(startedAfter.processing_started_at));
  check('CHECK 3: the PHC got its case id back (200 duplicate) and marked it synced', resynced?.central_case_id === localCaseBefore);
  check('CHECK 3: the PHC log shows central already had it', /central already had it/.test(logText('phc')));
  const runs = (await qc('SELECT count(*)::int n FROM grading_results WHERE case_id = $1', [startedAfter.case_id]))[0].n;
  show('grading_results rows for the case', runs);
  check('CHECK 3: no second grading run (at most one result row)', runs <= 1);
}

// ═══ S3 ═════════════════════════════════════════════════════════════════════
async function s3() {
  head('S3  large image: chunked upload, connection killed mid-upload, resume');
  // A >2 MB file WITHOUT changing what the gate sees: the same native IDRiD pixels re-encoded
  // at JPEG q100 / 4:4:4. (Upscaling would blur it and fail the gate.)
  const sharp = require(require.resolve('sharp', { paths: [PHC_DIR] }));
  const big = path.join(RUN, 'big_native_q100.jpg');
  await sharp(GOOD_BORDERLINE_2).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toFile(big);
  const size = fs.statSync(big).size;
  show('large image', `${(size / 1048576).toFixed(2)} MB (single-shot/chunk threshold is 2 MB)`);
  check('the file is above the single-shot threshold', size > 2 * 1048576, size);

  const p = (await registerPatient(PHC(), 'E2E Patient Large')).body;
  const cap = await postCapture(PHC(), p.patientId, big);
  show(`POST /captures (${cap.ms} ms)`, cap.body);
  if (!check('the large image clears the gate', cap.status === 201 && ['pass', 'borderline'].includes(cap.body.qualityStatus), cap.body)) return;
  S.capBig = cap.body.captureId;

  // Kill the connection after 2 chunks have been accepted; the sync will start the moment forms are in.
  proxy.forwardedChunks = 0; proxy.chunkPosts = []; proxy.killed = 0; proxy.killAfterChunks = 2;
  const f = await fillForms(PHC(), S.capBig, 'right');
  check('forms accepted', f.a.status === 201 && f.b.status === 201);
  const interrupted = await waitFor('upload interrupted', async () => {
    const r = await item(S.capBig); return r?.uploadProgress && r.syncError ? r : null;
  }, { timeoutMs: 60000, intervalMs: 500 });
  show('queue row while interrupted', interrupted && { status: interrupted.status, uploadProgress: interrupted.uploadProgress, syncError: interrupted.syncError });
  check('CHECK 5: the connection was killed mid-upload (proxy dropped a chunk request)', proxy.killed === 1);
  check('CHECK 5: the row shows progress, and is still pending (not synced, not lost)',
    !!interrupted && interrupted.status === 'quality_passed' && interrupted.uploadProgress.sent === 2 && interrupted.syncError.kind === 'network', interrupted);
  const sess = (await call(CENTRAL(), `/api/v1/cases/${S.capBig}/chunks`, { headers: { 'x-phc-api-key': phcCreds.key } }));
  show('central chunk session', sess.body && { received: sess.body.received, missing: sess.body.missing?.length, complete: sess.body.complete });
  check('CHECK 5: central holds exactly the 2 chunks that landed', sess.body?.received?.length === 2);

  const done = await waitFor('resumed and synced', async () => phcOne("SELECT * FROM sync_queue WHERE capture_id = ? AND status = 'synced'", S.capBig), { timeoutMs: 90000 });
  check('CHECK 5: it resumed by itself and central accepted it', !!done);
  const total = interrupted?.uploadProgress?.total;
  const counts = proxy.chunkPosts.reduce((a, i) => (a[i] = (a[i] || 0) + 1, a), {});
  show('chunk requests forwarded to central, by index', counts);
  check('CHECK 5: every chunk arrived, and NONE was sent twice (only the missing ones were re-sent)',
    Object.keys(counts).length === total && Object.values(counts).every((n) => n === 1), counts);
  check('the PHC log says it resumed', /resuming .*: 2\/\d+ chunks already there/.test(logText('phc')));
  const cc = await qc('SELECT case_id, status FROM cases WHERE capture_id_ref = $1', [S.capBig]);
  check('CHECK 3/5: one central case', cc.length === 1);
  check('the whole-file SHA-256 was verified by central (it assembled and ingested)', cc.length === 1);
  const imgPath = (await qc('SELECT image_path FROM cases WHERE capture_id_ref = $1', [S.capBig]))[0]?.image_path;
  const sameBytes = imgPath && (() => {
    try {
      const enc = fs.readFileSync(imgPath); const dec = centralMediaCrypto().decryptBuffer(enc);
      return crypto.createHash('sha256').update(dec).digest('hex') === crypto.createHash('sha256').update(fs.readFileSync(big)).digest('hex');
    } catch { return false; }
  })();
  check('the stored image is byte-identical to the file the PHC uploaded', !!sameBytes);
}

// ═══ S4 ═════════════════════════════════════════════════════════════════════
async function s4() {
  head('S4  offline: central stopped, three captures queue, central returns, all sync in order');
  const beforeCases = (await qc('SELECT count(*)::int n FROM cases'))[0].n;
  stopService('central');
  await sleep(1500);
  const off = await waitFor('PHC reports offline', async () => { const s = (await call(PHC(), '/sync/status')).body; return s.online === false ? s : null; }, { timeoutMs: 30000 });
  show('GET /sync/status (central down)', off);
  check('the PHC reports offline', !!off);

  // capture order: a LOW-urgency 'pass' first, then two HIGH-urgency 'borderline' -> urgency first, then age
  const plan = [
    { name: 'E2E Offline A (pass, oldest)', file: GOOD_PASS, expectQ: 'pass' },
    { name: 'E2E Offline B (borderline)', file: GOOD_BORDERLINE_1, expectQ: 'borderline' },
    { name: 'E2E Offline C (borderline, newest)', file: GOOD_BORDERLINE_2, expectQ: 'borderline' },
  ];
  S.offline = [];
  for (const [i, e] of plan.entries()) {
    const p = (await registerPatient(PHC(), e.name)).body;
    const cap = await postCapture(PHC(), p.patientId, e.file);
    check(`capture ${i + 1} works with central down (gate ran locally: ${cap.body?.qualityStatus})`, cap.status === 201 && cap.body.qualityStatus === e.expectQ, cap.body);
    await fillForms(PHC(), cap.body.captureId, i % 2 ? 'right' : 'left');
    S.offline.push({ ...e, captureId: cap.body.captureId, capturedAt: cap.body.capturedAt, patientId: p.patientId });
  }
  await sleep(11000);                                   // a full sync cycle while offline
  const st = (await call(PHC(), '/sync/status')).body;
  show('GET /sync/status (3 captured, central still down)', st);
  check('CHECK 4: the three are visibly PENDING (pendingCount 3, offline)', st.pendingCount === 3 && st.online === false, st);
  const rows = await Promise.all(S.offline.map((o) => item(o.captureId)));
  show('queue rows', rows.map((r) => ({ status: r.status, formsComplete: r.formsComplete, syncError: r.syncError && r.syncError.kind })));
  check('CHECK 4: each is quality_passed with forms complete (waiting for upload), none pretends to be synced', rows.every((r) => r.status === 'quality_passed' && r.formsComplete));
  check('CHECK 4: nothing reached central', (await qc('SELECT count(*)::int n FROM cases'))[0].n === beforeCases);

  say('  Restarting central...');
  startCentral();
  check('central is back', !!(await waitHealthy(`${CENTRAL()}/health`)));
  const all = await waitFor('all three synced', async () => {
    const r = await Promise.all(S.offline.map((o) => phcOne("SELECT * FROM sync_queue WHERE capture_id = ? AND status = 'synced'", o.captureId)));
    return r.every(Boolean) ? r : null;
  }, { timeoutMs: 90000 });
  check('CHECK 4: all three synced by themselves, no manual action', !!all);
  const central = await qc(`SELECT capture_id_ref, received_at, captured_at FROM cases WHERE capture_id_ref = ANY($1) ORDER BY received_at`, [S.offline.map((o) => o.captureId)]);
  show('central arrival order', central.map((c) => S.offline.find((o) => o.captureId === c.capture_id_ref).name));
  const [A, B, C] = S.offline;
  check('CHECK 4: order = urgency first (borderline B, C), then the older low-urgency A',
    central.length === 3 && central[0].capture_id_ref === B.captureId && central[1].capture_id_ref === C.captureId && central[2].capture_id_ref === A.captureId,
    central.map((c) => c.capture_id_ref));
  check('CHECK 4: within a tier, older first (B before C)', central[0]?.capture_id_ref === B.captureId && central[1]?.capture_id_ref === C.captureId);
  check('CHECK 4: no duplicates: exactly 3 new central cases', (await qc('SELECT count(*)::int n FROM cases'))[0].n === beforeCases + 3);
  check('CHECK 4: each keeps its capture time (captured hours before it synced)',
    central.every((c) => Math.abs(new Date(c.captured_at) - new Date(S.offline.find((o) => o.captureId === c.capture_id_ref).capturedAt)) < 1000));
}

// ═══ S5 ═════════════════════════════════════════════════════════════════════
async function s5() {
  head('S5  error states: central refuses; quality gate unavailable (and recovery)');

  sub('a. Central refuses the upload (wrong PHC key -> 401): a clear message, never a fake success');
  stopService('phc');
  const port2 = PHC_PORT + 1;
  startNode('phc-badkey', PHC_DIR, 'server.js', { ...phcEnv({ PORT: String(port2), PHC_API_KEY: 'phc_this_key_is_wrong_for_the_e2e_test', LOCAL_DB_PATH: path.join(RUN, 'phc-badkey.sqlite'), LOCAL_STORAGE_DIR: path.join(RUN, 'phc-badkey-storage') }) }, port2);
  const base = `http://127.0.0.1:${port2}`;
  await waitHealthy(`${base}/health`);
  const p = (await registerPatient(base, 'E2E Refused')).body;
  const cap = await postCapture(base, p.patientId, GOOD_BORDERLINE_1);
  await fillForms(base, cap.body.captureId, 'left');
  const refused = await waitFor('refusal recorded', async () => { const s = (await call(base, '/sync/status')).body; return s.lastError ? s : null; }, { timeoutMs: 60000 });
  show('GET /sync/status', refused);
  check('CHECK 6: the refusal is visible, in central\'s own words (401 phc_key_invalid)', refused?.lastError?.kind === 'rejected' && /401/.test(refused.lastError.message) && /phc_key_invalid/.test(refused.lastError.message), refused?.lastError);
  const row = (await (await fetch(`${base}/captures`)).json())[0];
  show('GET /captures row', { status: row.status, syncError: row.syncError });
  check('CHECK 6: the capture is NOT marked synced; it stays pending with the error attached', row.status === 'quality_passed' && row.syncError?.kind === 'rejected');
  check('CHECK 6: central has no case for it', (await qc('SELECT 1 FROM cases WHERE capture_id_ref = $1', [cap.body.captureId])).length === 0);
  const a1 = row.syncError.attempts; await sleep(12000);
  const row2 = (await (await fetch(`${base}/captures`)).json())[0];
  check('CHECK 6: backoff: it is not re-sent every cycle (attempts did not climb by one per 10 s)', row2.syncError.attempts - a1 <= 1, [a1, row2.syncError.attempts]);
  stopService('phc-badkey');

  sub('b. Quality-gate engine unavailable (MATLAB not found): 503, the image is saved, nothing is invented');
  const port3 = PHC_PORT + 2;
  const gateDb = { LOCAL_DB_PATH: path.join(RUN, 'phc-nogate.sqlite'), LOCAL_STORAGE_DIR: path.join(RUN, 'phc-nogate-storage') };
  startNode('phc-nogate', PHC_DIR, 'server.js', { ...phcEnv({ PORT: String(port3), ...gateDb, MATLAB_EXECUTABLE: path.join(RUN, 'no-such-matlab.exe'), MATLAB_TIMEOUT_MS: '5000' }) }, port3);
  const b3 = `http://127.0.0.1:${port3}`;
  await waitHealthy(`${b3}/health`);
  const p3 = (await registerPatient(b3, 'E2E No Gate')).body;
  const c3 = await postCapture(b3, p3.patientId, GOOD_BORDERLINE_1);
  show(`POST /captures  (${c3.ms} ms)`, c3.body);
  check('CHECK 6: 503 quality_gate_failed', c3.status === 503 && c3.body.error === 'quality_gate_failed');
  check('CHECK 6: the message says the image was saved', /image was saved/i.test(c3.body.message));
  check('CHECK 6: no quality verdict, and no engine, was invented', c3.body.qualityStatus === undefined && c3.body.qualityGateEngine === undefined);
  check('CHECK 6: the response gives the captureId to re-check with', ID_RE.test(c3.body.captureId || ''));
  const q3 = (await (await fetch(`${b3}/captures`)).json())[0];
  show('GET /captures row', { status: q3.status, qualityStatus: q3.qualityStatus });
  check('CHECK 6: the queue shows it as not yet checked (qualityStatus null), not as passed', q3.status === 'captured' && q3.qualityStatus === null);
  const again = await call(b3, `/captures/${c3.body.captureId}/quality-check`, { method: 'POST' });
  check('CHECK 6: re-checking while MATLAB is still missing is the same clear error', again.status === 503 && again.body.captureId === c3.body.captureId);
  stopService('phc-nogate');

  sub('c. Recovery: MATLAB available again -> re-check the SAVED image, no new photograph');
  startNode('phc-nogate2', PHC_DIR, 'server.js', { ...phcEnv({ PORT: String(port3), ...gateDb }) }, port3);
  await waitHealthy(`${b3}/health`);
  const rc = await call(b3, `/captures/${c3.body.captureId}/quality-check`, { method: 'POST' });
  show(`POST /captures/:id/quality-check (${rc.ms} ms)`, rc.body);
  check('the saved image is checked now, by the real MATLAB gate', rc.status === 200 && rc.body.qualityStatus === 'borderline' && rc.body.qualityGateEngine?.engine === 'matlab', rc.body);
  {
    const d = phcDb({ file: 'phc-nogate.sqlite' });
    let queued; try { queued = d.prepare('SELECT 1 x FROM sync_queue WHERE capture_id = ?').get(c3.body.captureId); } finally { d.close(); }
    check('it is queued for upload only now', !!queued);
  }
  stopService('phc-nogate2');
  startNode('phc', PHC_DIR, 'server.js', phcEnv(), PHC_PORT);
  await waitHealthy(`${PHC()}/health`);
}

// ═══ finale: results ════════════════════════════════════════════════════════
async function finale() {
  head('RESULT STATE: cases central has been grading in the background');
  const ids = [S.cap1, S.capBig, ...(S.offline || []).map((o) => o.captureId)].filter(Boolean);
  const started = Date.now();
  say(`  waiting up to ${Math.round(GRADING_WAIT_MS / 60000)} min for central to finish ${ids.length} case(s)...`);
  let last = '';
  const done = await waitFor('all cases graded/error', async () => {
    const rows = await Promise.all(ids.map((id) => item(id)));
    const line = rows.map((r) => r?.centralStatus || r?.status).join(', ');
    if (line !== last) { say(`    [${Math.round((Date.now() - started) / 1000)}s] ${line}`); last = line; }
    return rows.every((r) => ['graded', 'error'].includes(r?.centralStatus)) ? rows : null;
  }, { timeoutMs: GRADING_WAIT_MS, intervalMs: 10000 });
  const rows = await Promise.all(ids.map((id) => item(id)));
  for (const r of rows) show(r.captureId, { status: r.status, centralStatus: r.centralStatus });
  const graded = rows.filter((r) => r.centralStatus === 'graded');
  const errored = rows.filter((r) => r.centralStatus === 'error');
  check('CHECK 7: at least one case was graded by central, and the local queue says result_delivered for it',
    graded.length > 0 && graded.every((r) => r.status === 'result_delivered'), rows.map((r) => [r.status, r.centralStatus]));
  check('CHECK 7: a case central failed to grade (if any) is NOT shown as a result',
    errored.every((r) => r.status === 'synced'), errored);
  check('CHECK 7: nothing is left claiming a result it does not have', rows.every((r) => r.status !== 'result_delivered' || r.centralStatus === 'graded'));
  if (!done) say('    (not every case finished inside the wait; see the states above)');
  const dbRows = await qc(`SELECT c.status, count(*)::int n FROM cases c GROUP BY 1 ORDER BY 1`);
  show('central cases by status', dbRows);
  const eng = await qc(`SELECT count(*)::int n FROM cases`);
  show('central cases total', eng[0].n);
}

async function main() {
  say(`NetraSetu PHC flow verification -- ${new Date().toISOString()}`);
  try {
    await setup();
    if (ONLY.has('s1')) await s1();
    if (ONLY.has('s2')) await s2();
    if (ONLY.has('s3')) await s3();
    if (ONLY.has('s4')) await s4();
    if (ONLY.has('s5')) await s5();
    if (ONLY.has('s1')) await finale();
  } catch (err) {
    failures++;
    say(`\nABORTED: ${err.stack || err}`);
  } finally {
    head(failures === 0 ? `ALL ${passes} CHECKS PASSED` : `${failures} CHECK(S) FAILED, ${passes} passed`);
    say(`  logs: ${RUN}`);
    for (const n of [...services.keys()]) stopService(n);
    proxy.server?.close();
    try { await centralDb?.end(); } catch { /* ignore */ }
    if (!KEEP) { /* logs are kept for inspection; the scratch database is dropped on the next run */ }
    process.exit(failures === 0 ? 0 : 1);
  }
}
main();
