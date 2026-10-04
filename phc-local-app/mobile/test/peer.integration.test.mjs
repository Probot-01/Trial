
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '../../backend');
const DEMO = path.resolve(HERE, '../../../demo_images');
const require = createRequire(import.meta.url);
const Database = require(path.join(BACKEND, 'node_modules/better-sqlite3'));
const backendCrypto = require(path.join(BACKEND, 'services/peerCrypto.js'));

const PC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-pc-'));
const PC_ENV = {
  ...process.env,
  LOCAL_DB_PATH: path.join(PC_DIR, 'local.sqlite'),
  LOCAL_STORAGE_DIR: path.join(PC_DIR, 'storage'),
  LOCAL_AUTH_ENABLED: 'true',
  SYNC_DISABLED: '1',
  PHC_CODE: 'PHC001',
};

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let port, base, pc;

async function startPc() {
  pc = spawn(process.execPath, [path.join(BACKEND, 'server.js')], { env: { ...PC_ENV, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  pc.stderr.on('data', (d) => { if (/Error/.test(String(d))) process.stderr.write(`[pc] ${d}`); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('local backend did not start');
}
async function stopPc() {
  if (!pc) return;
  const exited = new Promise((r) => pc.once('exit', r));
  pc.kill();
  await exited;
  pc = null;
}
const pcDb = () => new Database(PC_ENV.LOCAL_DB_PATH, { readonly: true });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Phone modules (real source, device APIs shimmed).
const { setConfig } = await import('../netrasetu/config/index.ts');
const { getDb, kvSet } = await import('../netrasetu/db/database.ts');
const patients = await import('../netrasetu/db/patients.ts');
const caps = await import('../netrasetu/db/captures.ts');
const { persistCaptureImage } = await import('../netrasetu/lib/storage.ts');
const { toQuestionnairePayload, priorityTier } = await import('../netrasetu/lib/questionnaire.ts');
const { savePairing, getPairing } = await import('../netrasetu/peer/pairing.ts');
const { peerCall, PeerError } = await import('../netrasetu/peer/peerClient.ts');
const replicate = await import('../netrasetu/peer/replicate.ts');
const mobileCrypto = await import('../netrasetu/peer/peerCrypto.ts');
const offline = await import('../netrasetu/auth/offlineCredentials.ts');
const { syncManager } = await import('../netrasetu/sync/syncManager.ts');

let pairing;

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // Seed a technician on the PC with the real admin CLI.
  execFileSync(process.execPath, [path.join(BACKEND, 'scripts/technician.js'), 'add', 'asha', 'Asha Test', '--password', 'field-pass-1'], { env: PC_ENV });
  await startPc();
  const token = (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'asha', password: 'field-pass-1' }) })).json()).token;
  pairing = (await (await fetch(`${base}/peer/pair`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'Test phone' }) })).json()).pairing;
  pairing.urls = ['http://127.0.0.1:1', base]; // first address dead: the client must fall through to the next
  setConfig({ centralUrl: 'http://127.0.0.1:1', phcCode: 'PHC001' }); // central unreachable throughout: this is LAN-only
  await getDb();
  await savePairing(pairing);
});
after(async () => { await stopPc(); });

const Q = {
  knownDiabetic: true, yearsSinceDiagnosis: 'gt10', glycemicControl: 'poor', bloodPressure: 'high', pregnancy: 'not_applicable', hba1c: '9.1',
  symptoms: { blurredVision: true, floaters: false, suddenVisionChange: false, eyePain: false }
};
const META = { cameraDeviceReported: 'mobile_lens', pupilStatus: 'dilated', lightingEnvironment: 'low_light', observedIssues: ['none_noticed'], workerUsabilityRating: 'clear', eyeLaterality: 'right' };
const PASS = {
  status: 'pass', reason: null, compositeScore: 0.9, preset: 'mobile_lens', analysedAt: '1002x867',
  scores: { focusScore: 0.8, illuminationScore: 0.95, fovScore: 1, coveragePercent: 0.86, glareScore: 0, motionScore: 0.18, occlusionScore: 0.01 }
};

async function phoneCase(name, image = '1_quality_pass.jpg') {
  const p = await patients.createPatient({ name, age: 57, contactNumber: '+919555555555', consentGivenAt: new Date().toISOString(), demographics: { patientType: 'new' }, questionnaire: Q });
  const captureId = caps.newCaptureId();
  const stored = await persistCaptureImage(path.join(DEMO, image), captureId, 'image/jpeg');
  await caps.recordCapture({ captureId, patientId: p.patientId, cameraDeviceId: 'mobile_lens', source: 'lens', imagePath: stored.uri, imageBytes: stored.bytes, quality: PASS, capturedAt: new Date().toISOString() });
  const qp = toQuestionnairePayload(Q, 'mr');
  await caps.queueCapture({ captureId, eye: 'right', cameraDeviceId: 'mobile_lens', bestEffort: false, questionnaire: qp, metadata: META, priorityTier: priorityTier(qp, META, PASS, false) });
  return { patientId: p.patientId, captureId };
}

// ── Crypto interop ──────────────────────────────────────────────────────────

test('the phone (noble) and the PC (node:crypto) seal and open each other\'s envelopes', () => {
  const keyB64 = backendCrypto.newKeyB64();
  const aad = 'req|ph-1|POST|/peer/pull|123|abc';
  const fromPhone = mobileCrypto.seal(mobileCrypto.keyFromB64(keyB64), { hello: 'पीएचसी', n: 42 }, aad);
  assert.deepEqual(backendCrypto.openJson(backendCrypto.keyFromB64(keyB64), fromPhone, aad), { hello: 'पीएचसी', n: 42 });
  const fromPc = backendCrypto.seal(backendCrypto.keyFromB64(keyB64), { ok: true }, aad);
  assert.deepEqual(mobileCrypto.openJson(mobileCrypto.keyFromB64(keyB64), fromPc, aad), { ok: true });
  assert.throws(() => mobileCrypto.openJson(mobileCrypto.keyFromB64(keyB64), fromPc, `${aad}x`));
  const big = crypto.randomBytes(3 * 1024 * 1024); // an image-sized payload
  const env = mobileCrypto.seal(mobileCrypto.keyFromB64(keyB64), new Uint8Array(big), aad);
  assert.equal(sha(backendCrypto.open(backendCrypto.keyFromB64(keyB64), env, aad)), sha(big));
});

// ── Auth through the sealed channel ─────────────────────────────────────────

test('technician login happens over the sealed channel; without it the PC refuses data', async () => {
  await assert.rejects(peerCall('/peer/login', { username: 'asha', password: 'wrong-pass' }), (e) => e instanceof PeerError && e.code === 'invalid_credentials');
  replicate.setPeerToken(null);
  await assert.rejects(replicate.replicateWithPc(), (e) => e.code === 'unauthenticated');
  const r = await peerCall('/peer/login', { username: 'asha', password: 'field-pass-1' });
  assert.equal(r.user.username, 'asha');
  replicate.setPeerToken(r.token);
  await offline.rememberCredentials(r.user, 'field-pass-1');
});

test('the pairing key is kept in the OS keystore, never in the app database', async () => {
  const db = await getDb();
  const rows = await db.getAllAsync('SELECT key, value FROM kv');
  assert.ok(!rows.some((r) => r.value.includes(pairing.key)), 'pairing key found in SQLite');
  assert.equal((await getPairing()).key, pairing.key);
});

test('offline login: the cached PBKDF2 verifier accepts the right password only; the password itself is not stored', async () => {
  assert.equal((await offline.verifyOffline('asha', 'field-pass-1')).username, 'asha');
  assert.equal(await offline.verifyOffline('asha', 'field-pass-2'), null);
  assert.equal(await offline.verifyOffline('ravi', 'whatever'), 'no_cached');
  const db = await getDb();
  const raw = (await db.getFirstAsync("SELECT value FROM kv WHERE key = 'offline_credentials'")).value;
  assert.ok(!raw.includes('field-pass-1'));
});

// ── The power-cut scenario ──────────────────────────────────────────────────

let deskPatientId, deskCaptureId, deskImageSha;

test('1. while both are on: work done on the desktop is already on the phone', async () => {
  const token = (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'asha', password: 'field-pass-1' }) })).json()).token;
  const pt = await (await fetch(`${base}/patients`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Desk Registered', age: 63, contactNumber: '+919666666666', consentGivenAt: new Date().toISOString() })
  })).json();
  deskPatientId = pt.patientId;
  // A desktop capture that passed the gate (inserted as captureHandler would, image in storage).
  deskCaptureId = `PHC001-${Date.now().toString(36)}-desk0001`;
  const img = fs.readFileSync(path.join(DEMO, '4_backup.jpg'));
  deskImageSha = sha(img);
  fs.mkdirSync(PC_ENV.LOCAL_STORAGE_DIR, { recursive: true });
  const imgPath = path.join(PC_ENV.LOCAL_STORAGE_DIR, `${deskCaptureId}.jpg`);
  fs.writeFileSync(imgPath, img);
  const w = new Database(PC_ENV.LOCAL_DB_PATH);
  w.prepare(`INSERT INTO captures (capture_id, patient_id, camera_device_id, image_path, quality_status, quality_reason, retake_count, captured_at, quality_scores, quality_engine)
             VALUES (?, ?, 'remidio_fop', ?, 'pass', NULL, 0, ?, ?, ?)`).run(deskCaptureId, deskPatientId, imgPath, new Date().toISOString(), JSON.stringify(PASS.scores),
    JSON.stringify({ engine: 'matlab', fallback: false, detail: 'qualityGateMain.m via matlab -batch' }));
  w.prepare(`INSERT INTO sync_queue (queue_id, capture_id, status, priority) VALUES (?, ?, 'pending', 'low')`).run(`q-${deskCaptureId}`, deskCaptureId);
  w.close();

  const r = await replicate.replicateWithPc();
  assert.ok(r.pulled >= 3, JSON.stringify(r));
  assert.equal(r.imagesReceived, 1);
  const p = await patients.getPatient(deskPatientId);
  assert.equal(p.name, 'Desk Registered');
  const c = await caps.getCapture(deskCaptureId);
  assert.equal(c.qualityStatus, 'pass');
  assert.equal(c.qualityEngine?.engine, 'matlab', "the PC's gate engine survives the trip to the phone");
  assert.equal(sha(fs.readFileSync(new URL(c.imagePath))), deskImageSha, 'image bytes identical on the phone');
  assert.equal((await getPairing()).lastUrl, base, 'fell through the dead address to the live one');
});

test('2. the PC capture is NOT uploaded by the phone while the PC is alive (the PC owns it)', async () => {
  const e = await caps.getQueueEntry(deskCaptureId);
  assert.equal(e.sync.state, 'pending');
  assert.notEqual(await caps.nextDueForUpload(), deskCaptureId);
});

let outageCase;
test('3. POWER CUT: the PC dies; the phone keeps registering and capturing, nothing is lost', async () => {
  await stopPc();
  outageCase = await phoneCase('Outage Patient');
  await syncManager.trigger();
  assert.equal(syncManager.current.pcLink, 'unreachable');
  await assert.rejects(replicate.replicateWithPc(), (e) => e.code === 'pc_unreachable');
  const e = await caps.getQueueEntry(outageCase.captureId);
  assert.equal(e.lifecycle, 'quality_passed');
  // The phone can also take over the dead PC's queued case once it has been silent long enough.
  await kvSet('peer_last_seen', new Date(Date.now() - 7 * 3600 * 1000).toISOString());
  assert.equal(await replicate.ownsUpload(pairing.pcDeviceId), true);
  await kvSet('peer_last_seen', new Date().toISOString());
});

test('4. POWER BACK: everything captured during the outage reaches the PC, image intact', async () => {
  await startPc();
  const r = await replicate.replicateWithPc();
  assert.ok(r.pushed >= 5, JSON.stringify(r));
  assert.equal(r.imagesSent, 1);
  const db = pcDb();
  try {
    const p = db.prepare('SELECT * FROM patients WHERE patient_id = ?').get(outageCase.patientId);
    assert.equal(p.name, 'Outage Patient');
    assert.equal(p.origin_device, pairing.deviceId);
    assert.equal(JSON.parse(p.questionnaire_json).glycemicControl, 'poor');
    const c = db.prepare('SELECT * FROM captures WHERE capture_id = ?').get(outageCase.captureId);
    assert.equal(c.source, 'lens');
    assert.equal(JSON.parse(c.quality_engine).engine, 'js-device', "the phone's gate engine survives the trip to the PC");
    assert.equal(JSON.parse(c.quality_engine).fallback, false);
    assert.equal(sha(fs.readFileSync(c.image_path)), sha(fs.readFileSync(path.join(DEMO, '1_quality_pass.jpg'))));
    assert.ok(db.prepare('SELECT 1 FROM questionnaire_responses WHERE capture_id = ?').get(outageCase.captureId));
    assert.equal(db.prepare('SELECT eye_laterality FROM capture_metadata_responses WHERE capture_id = ?').get(outageCase.captureId).eye_laterality, 'right');
    const q = db.prepare('SELECT * FROM sync_queue WHERE capture_id = ?').get(outageCase.captureId);
    assert.equal(q.owner_device, pairing.deviceId, 'the phone keeps ownership of its own upload');
    assert.equal(q.priority, 'high');
  } finally { db.close(); }
});

test('5. once the phone uploads a case to central, the PC learns it is done (and will not upload it again)', async () => {
  await caps.markSynced(outageCase.captureId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'graded');
  await replicate.replicateWithPc();
  const db = pcDb();
  try {
    const q = db.prepare('SELECT * FROM sync_queue WHERE capture_id = ?').get(outageCase.captureId);
    assert.equal(q.status, 'synced');
    assert.equal(q.central_case_id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(q.central_status, 'graded');
  } finally { db.close(); }
});

test('6. converged: a further pass moves nothing in either direction (no echo)', async () => {
  const r = await replicate.replicateWithPc();
  assert.deepEqual(r, { pushed: 0, pulled: 0, imagesSent: 0, imagesReceived: 0 });
});

test('7. no network at all: phone -> PC by encrypted bundle file (USB), then PC -> phone', async () => {
  await stopPc();
  const later = await phoneCase('Bundle Patient', '3_grading_override.jpg');
  const { bundle, records, images } = await replicate.buildBundle();
  assert.ok(records >= 5 && images === 1);
  const file = path.join(PC_DIR, 'from-phone.nsbundle');
  fs.writeFileSync(file, JSON.stringify(bundle));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('Bundle Patient'), 'bundle file is not readable');

  // Tampered copy is refused by the PC's import tool.
  const bad = JSON.parse(JSON.stringify(bundle)); bad.envelope.ct = bad.envelope.ct.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
  fs.writeFileSync(path.join(PC_DIR, 'bad.nsbundle'), JSON.stringify(bad));
  assert.throws(() => execFileSync(process.execPath, [path.join(BACKEND, 'scripts/peer.js'), 'import', path.join(PC_DIR, 'bad.nsbundle')], { env: PC_ENV, stdio: 'pipe' }));

  const out = execFileSync(process.execPath, [path.join(BACKEND, 'scripts/peer.js'), 'import', file], { env: PC_ENV }).toString();
  assert.match(out, /applied/);
  const db = pcDb();
  try {
    assert.ok(db.prepare('SELECT 1 FROM captures WHERE capture_id = ?').get(later.captureId));
  } finally { db.close(); }

  // PC -> phone: a patient registered on the PC during the same outage.
  const w = new Database(PC_ENV.LOCAL_DB_PATH);
  const pid = `PHC001-${Date.now().toString(36)}-pcbundle`;
  w.prepare('INSERT INTO patients (patient_id, name, age, contact_number, registered_at) VALUES (?, ?, ?, ?, ?)').run(pid, 'PC Bundle Patient', 70, '+919777777777', new Date().toISOString());
  w.close();
  const outFile = path.join(PC_DIR, 'to-phone.nsbundle');
  execFileSync(process.execPath, [path.join(BACKEND, 'scripts/peer.js'), 'export', pairing.deviceId, outFile], { env: PC_ENV });
  const res = await replicate.importBundle(JSON.parse(fs.readFileSync(outFile, 'utf8')));
  assert.ok(res.applied >= 1);
  assert.equal((await patients.getPatient(pid)).name, 'PC Bundle Patient');
  await startPc();
});

test('8. a bundle made for another phone cannot be opened here', async () => {
  const other = {
    kind: 'netrasetu-bundle', v: 1, fromDevice: pairing.pcDeviceId, toDevice: 'ph-someoneelse', createdAt: new Date().toISOString(),
    envelope: backendCrypto.seal(backendCrypto.keyFromB64(pairing.key), { records: [], images: {} }, 'x')
  };
  await assert.rejects(replicate.importBundle(other), (e) => e.code === 'bundle_wrong_recipient');
});
