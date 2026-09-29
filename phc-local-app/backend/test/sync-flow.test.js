'use strict';

/**
 * PHC local backend: capture -> queue -> sync -> result state.
 *
 *   npm test          (from phc-local-app/backend)
 *
 * The sync manager runs UNCHANGED against a real HTTP server that plays central
 * (fake central below), on a throwaway database and storage directory. What is
 * pinned here is the contract between the PHC and central:
 *   - a capture is uploaded only once BOTH questionnaires exist;
 *   - "synced" means central accepted it (201, or 200 + duplicate:true) and
 *     named the case -- nothing else, however 2xx;
 *   - a refusal is recorded and shown, not retried silently at full speed;
 *   - a dropped link keeps the queue order and needs no manual action;
 *   - urgency first, then age;
 *   - result states come from central's status endpoint, never from elapsed time;
 *   - a large image resumes after a dropped connection without re-sending chunks.
 * The real MATLAB gate and a real central are exercised by tests/e2e.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Readable } = require('stream');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phc-flow-test-'));
// Auth posture pinned, like every other env var in this file. These are
// SYNC/GATE flow tests, not auth tests: the enforced path has its own suite
// (test/auth-peer.test.js, which pins this to 'true' and asserts patient data
// needs a session). Left unset, the flag came from whichever .env the
// developer had, so the result of this suite depended on local config -- it
// broke the day LOCAL_AUTH_ENABLED started defaulting to true, which is now
// the shipped default precisely because anonymous reads leak patient data.
process.env.LOCAL_AUTH_ENABLED = 'false';
process.env.LOCAL_DB_PATH = path.join(TMP, 'local.sqlite');
process.env.LOCAL_STORAGE_DIR = path.join(TMP, 'storage');
process.env.SYNC_DISABLED = '1';
process.env.PHC_API_KEY = 'phc_test_key_for_flow_tests';
process.env.PHC_ID = '00000000-0000-4000-8000-000000000001';
process.env.SYNC_BACKOFF_BASE_MS = '700';
process.env.SYNC_BACKOFF_MAX_MS = '5000';
process.env.SYNC_CHUNK_THRESHOLD_BYTES = '100000';
process.env.SYNC_CHUNK_BYTES = '40000';
process.env.SYNC_HEALTH_TIMEOUT_MS = '1500';
// No MATLAB, no compiled gate, no JS fallback: the gate cannot run (the 503 tests).
process.env.MATLAB_EXECUTABLE = path.join(TMP, 'no-such-matlab');
// A failed spawn leaves Node's spawn-timeout timer running; keep it short so the run exits.
process.env.MATLAB_TIMEOUT_MS = '1000';
delete process.env.QUALITY_GATE_EXE;
delete process.env.QUALITY_GATE_ALLOW_FALLBACK;

const FIXTURE = path.resolve(__dirname, '../../../tests/fixtures/idrid_003_good_borderline.jpg');

// ── Fake central ────────────────────────────────────────────────────────────
const central = {
  mode: 'created',              // how POST /api/v1/cases answers
  completeMode: 'ok',           // how chunks/complete answers: ok | no-case
  statuses: {},                 // caseId -> status the status endpoint reports
  dropAfterChunks: null,        // destroy the socket once this many chunks have been accepted
  posts: [],                    // captureIdRef of every POST /api/v1/cases, in order
  keys: [],                     // x-phc-api-key seen on each request
  statusPolls: [],              // caseIds asked about
  chunkPosts: {},               // captureRef -> { index -> times posted }
  sessions: {},                 // captureRef -> Set of received chunk indexes
  cases: {},                    // captureIdRef -> caseId (central's idempotency)
  reset() {
    this.mode = 'created'; this.completeMode = 'ok'; this.statuses = {};
    this.dropAfterChunks = null; this.posts = []; this.keys = []; this.statusPolls = [];
    this.chunkPosts = {}; this.sessions = {}; this.cases = {};
  },
};
let nextCase = 1;
const caseFor = (ref) => (central.cases[ref] ||= `case-${String(nextCase++).padStart(4, '0')}`);

async function readForm(req) {
  const r = new Request('http://fake/', { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half' });
  return r.formData();
}
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const fake = http.createServer(async (req, res) => {
  central.keys.push(req.headers['x-phc-api-key'] || null);
  const url = new URL(req.url, 'http://fake');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });

    const st = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/status$/);
    if (req.method === 'GET' && st) {
      central.statusPolls.push(st[1]);
      const status = central.statuses[st[1]] || 'processing';
      return send(res, 200, { caseId: st[1], status });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/cases') {
      const form = await readForm(req);
      const ref = form.get('captureIdRef');
      central.posts.push(ref);
      switch (central.mode) {
        case 'drop': return req.socket.destroy();
        case 'reject400': return send(res, 400, { error: 'invalid_field', message: 'patientAge must be an integer 0-130.' });
        case 'server500': return send(res, 500, '<html>Internal Server Error</html>');
        case 'created-no-id': return send(res, 201, {});
        case 'ok-200-no-duplicate': return send(res, 200, { caseId: 'x', receivedAt: new Date().toISOString() });
        default: {
          const known = !!central.cases[ref];
          const caseId = caseFor(ref);
          if (known) return send(res, 200, { caseId, receivedAt: new Date().toISOString(), status: 'processing', duplicate: true });
          return send(res, 201, { caseId, receivedAt: new Date().toISOString(), status: 'processing', duplicate: false, fromSummary: false });
        }
      }
    }

    const init = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/chunks\/init$/);
    if (req.method === 'POST' && init) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const ref = init[1];
      const got = (central.sessions[ref] ||= new Set());
      const missing = [...Array(body.totalChunks).keys()].filter((i) => !got.has(i));
      return send(res, 201, { captureRef: ref, totalChunks: body.totalChunks, received: [...got], missing,
        resumed: got.size > 0, alreadyIngested: false });
    }
    const chunk = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/chunks\/(\d+)$/);
    if (req.method === 'POST' && chunk) {
      if (central.dropAfterChunks !== null && (central.sessions[chunk[1]]?.size ?? 0) >= central.dropAfterChunks) {
        return req.socket.destroy();          // the connection dies mid-upload
      }
      await readForm(req);
      const i = Number(chunk[2]);
      (central.chunkPosts[chunk[1]] ||= {})[i] = (central.chunkPosts[chunk[1]][i] || 0) + 1;
      (central.sessions[chunk[1]] ||= new Set()).add(i);
      return send(res, 200, { index: i });
    }
    const done = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/chunks\/complete$/);
    if (req.method === 'POST' && done) {
      if (central.completeMode === 'no-case') return send(res, 201, {});
      const known = !!central.cases[done[1]];
      const caseId = caseFor(done[1]);
      return send(res, known ? 200 : 201, { caseId, receivedAt: new Date().toISOString(), duplicate: known });
    }
    send(res, 404, { error: 'not_found', message: 'no such route' });
  } catch (err) {
    send(res, 500, { error: 'fake_central_failed', message: err.message });
  }
});

let app, server, base, db, sync;

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.CENTRAL_API_URL = `http://127.0.0.1:${fake.address().port}`;
  app = require('../server');
  db = require('../db/localDb');
  sync = require('../services/syncManager');
  server = app.createServer().server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  // Keep-alive sockets would otherwise hold the process open for ~30 s.
  for (const s of [server, fake]) { s?.close(); s?.closeAllConnections?.(); }
});

// ── helpers ─────────────────────────────────────────────────────────────────
const { generateLocalId } = require('../services/ids');
let tick = 0;

/** A patient + a capture that has already cleared the gate + its queue row. Forms not filled in. */
function seedCapture({ quality = 'borderline', ageMinutes = 0, image = null } = {}) {
  const patientId = generateLocalId();
  const captureId = generateLocalId();
  const at = new Date(Date.now() - ageMinutes * 60000 + (tick++)).toISOString();
  const imagePath = image || path.join(TMP, `${captureId}.jpg`);
  if (!image) fs.writeFileSync(imagePath, Buffer.from('not-really-a-jpeg-but-central-is-fake'));
  db.prepare('INSERT INTO patients (patient_id, name, age, contact_number, registered_at, consent_given_at) VALUES (?,?,?,?,?,?)')
    .run(patientId, 'Test Patient', 55, '+919800000000', at, at);
  db.prepare(`INSERT INTO captures (capture_id, patient_id, camera_device_id, image_path, quality_status, quality_reason,
                retake_count, captured_at) VALUES (?,?,?,?,?,NULL,0,?)`)
    .run(captureId, patientId, 'unknown', imagePath, quality, at);
  db.prepare(`INSERT INTO sync_queue (queue_id, capture_id, status, priority, chunks_sent, chunks_total)
              VALUES (?,?, 'pending', ?, 0, 1)`)
    .run(generateLocalId(), captureId, quality === 'borderline' ? 'high' : 'low');
  return { patientId, captureId };
}

const QUESTIONNAIRE = {
  riskFactors: { yearsSinceDiagnosis: '5to10', glycemicControl: 'moderate', bloodPressure: 'high', pregnant: null },
  symptoms: { blurredVision: true, floaters: false, suddenVisionChange: false, eyePain: false },
  language: 'en',
};
const METADATA = {
  cameraDeviceReported: 'unknown', pupilStatus: 'dilated', lightingEnvironment: 'indoor_clinic',
  observedIssues: ['none_noticed'], workerUsabilityRating: 'clear', eyeLaterality: 'left',
};
const postJson = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function fillForms(captureId) {
  assert.equal((await postJson(`/captures/${captureId}/questionnaire`, QUESTIONNAIRE)).status, 201);
  assert.equal((await postJson(`/captures/${captureId}/capture-metadata`, METADATA)).status, 201);
}
const row = (captureId) => db.prepare('SELECT * FROM sync_queue WHERE capture_id = ?').get(captureId);
const listing = async () => (await fetch(`${base}/captures`)).json();
const statusOf = async (captureId) => (await listing()).find((r) => r.captureId === captureId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A clean slate: nothing pending in the queue, fake central reset. */
function clean() {
  central.reset();
  db.prepare("UPDATE sync_queue SET status = 'synced', central_case_id = COALESCE(central_case_id, 'old'), central_status = 'graded'").run();
}

// ── 1. Forms before sync ────────────────────────────────────────────────────

test('a capture is NOT uploaded until both questionnaires exist', async () => {
  clean();
  const { captureId } = seedCapture();

  let r = await sync.syncOnce();
  assert.equal(r.attempted, 0, 'nothing is ready: no forms yet');
  assert.deepEqual(central.posts, []);
  let s = await (await fetch(`${base}/sync/status`)).json();
  assert.equal(s.pendingCount, 0, 'awaiting forms is not "pending upload"');
  assert.equal(s.awaitingFormsCount, 1);
  assert.equal((await statusOf(captureId)).formsComplete, false);

  assert.equal((await postJson(`/captures/${captureId}/questionnaire`, QUESTIONNAIRE)).status, 201);
  await sync.syncOnce();
  assert.deepEqual(central.posts, [], 'the patient questionnaire alone is not enough');

  assert.equal((await postJson(`/captures/${captureId}/capture-metadata`, METADATA)).status, 201);
  s = await (await fetch(`${base}/sync/status`)).json();
  assert.equal(s.pendingCount, 1);
  assert.equal(s.awaitingFormsCount, 0);

  r = await sync.syncOnce();
  assert.equal(r.synced, 1);
  assert.deepEqual(central.posts, [captureId]);
  assert.ok(central.keys.every((k) => k === process.env.PHC_API_KEY), 'every central call carries the PHC key');
});

// ── 2. "Synced" means central accepted it ───────────────────────────────────

test('201 with a case id -> synced, with central\'s case id and status recorded', async () => {
  clean();
  const { captureId } = seedCapture(); await fillForms(captureId);
  await sync.syncOnce();
  const q = row(captureId);
  assert.equal(q.status, 'synced');
  assert.match(q.central_case_id, /^case-\d{4}$/);
  assert.equal(q.central_status, 'processing');
  assert.equal(q.last_error, null);
});

test('201 WITHOUT a case id is not an acceptance: stays pending, error recorded', async () => {
  clean(); central.mode = 'created-no-id';
  const { captureId } = seedCapture(); await fillForms(captureId);
  const r = await sync.syncOnce();
  assert.equal(r.synced, 0);
  const q = row(captureId);
  assert.equal(q.status, 'pending');
  assert.equal(q.error_kind, 'server');
  assert.match(q.last_error, /not with an accepted case/);
});

test('200 without duplicate:true is not an acceptance either', async () => {
  clean(); central.mode = 'ok-200-no-duplicate';
  const { captureId } = seedCapture(); await fillForms(captureId);
  await sync.syncOnce();
  assert.equal(row(captureId).status, 'pending');
});

test('re-sending a capture central already has (200 duplicate:true) -> synced, one central case', async () => {
  clean();
  const { captureId } = seedCapture(); await fillForms(captureId);
  await sync.syncOnce();
  const first = row(captureId).central_case_id;

  // The answer to the first upload "was lost": the PHC still thinks it is pending.
  db.prepare("UPDATE sync_queue SET status = 'pending', central_case_id = NULL, central_status = NULL WHERE capture_id = ?").run(captureId);
  await sync.syncOnce();
  assert.equal(central.posts.length, 2, 'it was sent twice...');
  assert.equal(new Set(Object.values(central.cases)).size, 1, '...but central has ONE case');
  assert.equal(row(captureId).status, 'synced');
  assert.equal(row(captureId).central_case_id, first, 'and it is the same case');
});

// ── 3. A refusal is recorded and backed off ─────────────────────────────────

test('central answers 400: pending, refusal quoted, backed off; then recovers with no manual action', async () => {
  clean(); central.mode = 'reject400';
  const { captureId } = seedCapture(); await fillForms(captureId);

  await sync.syncOnce();
  let q = row(captureId);
  assert.equal(q.status, 'pending');
  assert.equal(q.error_kind, 'rejected');
  assert.match(q.last_error, /400.*invalid_field.*patientAge must be an integer/s);
  assert.equal(q.attempts, 1);
  assert.ok(q.next_attempt_at > new Date().toISOString(), 'a retry time in the future');

  const item = await statusOf(captureId);
  assert.equal(item.syncError.kind, 'rejected');
  assert.match(item.syncError.message, /invalid_field/);
  const s = await (await fetch(`${base}/sync/status`)).json();
  assert.equal(s.lastError.captureId, captureId);
  assert.equal(s.pendingCount, 1, 'still pending: nothing is dropped');

  const before = central.posts.length;
  await sync.syncOnce();
  assert.equal(central.posts.length, before, 'backoff: not re-sent straight away');

  central.mode = 'created';
  await sleep(800);
  const r = await sync.syncOnce();
  assert.equal(r.synced, 1);
  q = row(captureId);
  assert.equal(q.status, 'synced');
  assert.equal(q.last_error, null);
  assert.equal(q.attempts, 0);
});

test('central answers 500 (an HTML page): recorded as a server error, still pending', async () => {
  clean(); central.mode = 'server500';
  const { captureId } = seedCapture(); await fillForms(captureId);
  await sync.syncOnce();
  const q = row(captureId);
  assert.equal(q.status, 'pending');
  assert.equal(q.error_kind, 'server');
  assert.match(q.last_error, /500/);
});

// ── 4. Offline / dropped link ───────────────────────────────────────────────

test('a dropped connection: no backoff, the cycle stops, order intact, recovers by itself', async () => {
  clean(); central.mode = 'drop';
  const a = seedCapture({ ageMinutes: 30 }); const b = seedCapture({ ageMinutes: 20 }); const c = seedCapture({ ageMinutes: 10 });
  for (const x of [a, b, c]) await fillForms(x.captureId);

  const r = await sync.syncOnce();
  assert.equal(r.synced, 0);
  assert.equal(central.posts.length, 1, 'the cycle stopped after the link died: it did not hammer the other two');
  assert.equal(row(a.captureId).error_kind, 'network');
  assert.equal(row(a.captureId).next_attempt_at, null, 'no backoff for an unreachable central');
  assert.equal((await (await fetch(`${base}/sync/status`)).json()).pendingCount, 3, 'all three visibly pending');

  central.mode = 'created'; central.posts = [];
  const r2 = await sync.syncOnce();
  assert.equal(r2.synced, 3);
  assert.deepEqual(central.posts, [a.captureId, b.captureId, c.captureId], 'oldest first');
  assert.equal(new Set(central.posts).size, 3, 'no duplicates');
});

// ── 5. Urgency first, then age ──────────────────────────────────────────────

test('upload order: urgency tier first, then age (oldest first within a tier)', async () => {
  clean();
  const oldLow  = seedCapture({ quality: 'pass',       ageMinutes: 90 });   // low urgency, oldest
  const midHigh = seedCapture({ quality: 'borderline', ageMinutes: 60 });   // high urgency
  const newHigh = seedCapture({ quality: 'borderline', ageMinutes: 30 });   // high urgency, newer
  for (const x of [oldLow, midHigh, newHigh]) await fillForms(x.captureId);

  await sync.syncOnce();
  assert.deepEqual(central.posts, [midHigh.captureId, newHigh.captureId, oldLow.captureId]);
});

// ── 6. Result state comes from central ─────────────────────────────────────

test('result_pending -> result_delivered follows central\'s status; error stays visible; terminal states are not polled', async () => {
  clean();
  const { captureId } = seedCapture(); await fillForms(captureId);
  await sync.syncOnce();
  let item = await statusOf(captureId);
  assert.equal(item.status, 'result_pending');
  assert.equal(item.centralStatus, 'processing');

  const caseId = row(captureId).central_case_id;
  await sync.syncOnce();
  assert.ok(central.statusPolls.includes(caseId), 'central was asked');

  central.statuses[caseId] = 'graded';
  await sync.syncOnce();
  item = await statusOf(captureId);
  assert.equal(item.status, 'result_delivered');
  assert.equal(item.centralStatus, 'graded');

  const polls = central.statusPolls.length;
  await sync.syncOnce();
  assert.equal(central.statusPolls.length, polls, 'graded is terminal: not asked again');

  // A case central failed to grade: accepted, but there is NO result to show.
  clean();
  const bad = seedCapture(); await fillForms(bad.captureId);
  await sync.syncOnce();
  central.statuses[row(bad.captureId).central_case_id] = 'error';
  await sync.syncOnce();
  item = await statusOf(bad.captureId);
  assert.equal(item.status, 'synced', 'never dressed up as a result');
  assert.equal(item.centralStatus, 'error');
});

test('a failed status poll changes nothing (no invented state)', async () => {
  clean();
  const { captureId } = seedCapture(); await fillForms(captureId);
  await sync.syncOnce();
  const caseId = row(captureId).central_case_id;
  central.statuses[caseId] = 'nonsense';
  await sync.syncOnce();
  assert.equal(row(captureId).central_status, 'processing');
});

// ── 7. Lifecycle listing ────────────────────────────────────────────────────

test('GET /captures: lifecycle status for a capture that has not cleared the gate / was told to retake', async () => {
  clean();
  const p = generateLocalId(); const now = new Date().toISOString();
  db.prepare('INSERT INTO patients (patient_id, name, age, contact_number, registered_at) VALUES (?,?,?,?,?)').run(p, 'Retake Person', 40, '+91', now);
  const mk = (status, reason) => {
    const id = generateLocalId();
    db.prepare(`INSERT INTO captures (capture_id, patient_id, camera_device_id, image_path, quality_status, quality_reason, retake_count, captured_at)
                VALUES (?,?,?,?,?,?,0,?)`).run(id, p, 'unknown', path.join(TMP, 'x.jpg'), status, reason, now);
    return id;
  };
  const retake = mk('retake', 'blur');
  const pending = mk('pending', null);
  const list = await listing();
  const r = list.find((x) => x.captureId === retake);
  const pd = list.find((x) => x.captureId === pending);
  assert.equal(r.status, 'captured');
  assert.equal(r.qualityStatus, 'retake');
  assert.equal(r.qualityReason, 'blur');
  assert.equal(pd.status, 'captured');
  assert.equal(pd.qualityStatus, null, "'pending' is internal, never a quality status");
});

// ── 8. Large image: chunked, resumable ──────────────────────────────────────

test('a large image goes chunked; after the connection dies mid-upload only the MISSING chunks are re-sent', async () => {
  clean();
  const { captureId } = seedCapture({ image: FIXTURE }); await fillForms(captureId);
  const bytes = fs.statSync(FIXTURE).size;
  const total = Math.ceil(bytes / 40000);
  assert.ok(total > 4, `fixture spans several chunks (${total})`);

  central.dropAfterChunks = 3;          // three chunks land, then the connection is killed
  const r1 = await sync.syncOnce();
  assert.equal(r1.synced, 0);
  let q = row(captureId);
  assert.equal(q.status, 'pending');
  assert.equal(q.error_kind, 'network');
  assert.equal(q.chunks_sent, 3, 'progress kept on the row');
  assert.equal(q.chunks_total, total);
  let item = await statusOf(captureId);
  assert.deepEqual(item.uploadProgress, { sent: 3, total });
  assert.equal(central.sessions[captureId].size, 3);

  central.dropAfterChunks = null;       // connection is healthy again
  const r2 = await sync.syncOnce();
  assert.equal(r2.synced, 1);
  const posts = central.chunkPosts[captureId];
  assert.equal(Object.keys(posts).length, total, 'every chunk arrived');
  assert.ok(Object.values(posts).every((n) => n === 1), 'and NO chunk was sent twice');
  q = row(captureId);
  assert.equal(q.status, 'synced');
  assert.match(q.central_case_id, /^case-/);
  assert.equal(central.posts.length, 0, 'the single-shot endpoint was never used for it');
});

test('chunk complete answering 201 without a case id is not an acceptance', async () => {
  clean(); central.completeMode = 'no-case';
  const { captureId } = seedCapture({ image: FIXTURE }); await fillForms(captureId);
  await sync.syncOnce();
  assert.equal(row(captureId).status, 'pending');
  assert.match(row(captureId).last_error, /not with an accepted case/);
});

// ── 9. Quality gate unavailable: a clear error, the capture is not lost ─────

test('gate cannot run -> 503 quality_gate_failed with the captureId; nothing queued; the row is recoverable', async () => {
  clean();
  const patient = await (await postJson('/patients', { name: 'Gate Down', age: 50, contactNumber: '+919811111111' })).json();
  const form = new FormData();
  form.append('patientId', patient.patientId);
  form.append('cameraDeviceId', 'unknown');
  form.append('image', new Blob([fs.readFileSync(FIXTURE)], { type: 'image/jpeg' }), 'x.jpg');
  const res = await fetch(`${base}/captures`, { method: 'POST', body: form });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'quality_gate_failed');
  assert.match(body.message, /image was saved/i);
  assert.match(body.captureId, /^PHC001-[0-9a-z]+-[0-9a-z]{8}$/);

  const c = db.prepare('SELECT * FROM captures WHERE capture_id = ?').get(body.captureId);
  assert.equal(c.quality_status, 'pending');
  assert.ok(fs.existsSync(c.image_path), 'the image is on disk');
  assert.equal(row(body.captureId), undefined, 'a capture that was never checked is never queued');

  // Re-checking the SAVED image: still unavailable -> same clear error, same id.
  const again = await fetch(`${base}/captures/${body.captureId}/quality-check`, { method: 'POST' });
  assert.equal(again.status, 503);
  assert.equal((await again.json()).captureId, body.captureId);
  assert.equal((await fetch(`${base}/captures/PHC001-nope-00000000/quality-check`, { method: 'POST' })).status, 404);
});

// ── 10. IDs ─────────────────────────────────────────────────────────────────

test('patient and capture ids follow the global ID rule (docs/id-format-spec.md)', async () => {
  const { LOCAL_ID_RE } = require('../services/ids');
  const p = await (await postJson('/patients', { name: 'Id Check', age: 30, contactNumber: '+919822222222' })).json();
  assert.match(p.patientId, LOCAL_ID_RE);
  assert.match(p.patientId, /^PHC001-[0-9a-z]{8}-[0-9a-z]{8}$/, 'current format: PHC code, base36 timestamp, 8-char suffix');
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(generateLocalId());
  assert.equal(ids.size, 500, '500 ids minted back to back are all distinct');
});
