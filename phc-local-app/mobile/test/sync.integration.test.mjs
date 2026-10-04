
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CENTRAL = process.env.CENTRAL || 'http://localhost:5000';
const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../demo_images');

const { setConfig, POLICY } = await import('../netrasetu/config/index.ts');
const { getDb } = await import('../netrasetu/db/database.ts');
const patients = await import('../netrasetu/db/patients.ts');
const caps = await import('../netrasetu/db/captures.ts');
const { persistCaptureImage } = await import('../netrasetu/lib/storage.ts');
const { toQuestionnairePayload, priorityTier } = await import('../netrasetu/lib/questionnaire.ts');
const { syncManager } = await import('../netrasetu/sync/syncManager.ts');
const { getReport } = await import('../netrasetu/api/central.ts');

let centralUp = false;
before(async () => {
  try { centralUp = (await (await fetch(`${CENTRAL}/health`)).json()).status === 'ok'; } catch { centralUp = false; }
  setConfig({ centralUrl: CENTRAL, phcCode: 'PHCT' });
  await getDb();
});
const skipIfDown = (t) => { if (!centralUp) { t.skip(`central not reachable at ${CENTRAL}`); return true; } return false; };

const Q = {
  knownDiabetic: true, yearsSinceDiagnosis: '5to10', glycemicControl: 'moderate', bloodPressure: 'high', pregnancy: 'not_applicable', hba1c: '8.1',
  symptoms: { blurredVision: false, floaters: false, suddenVisionChange: false, eyePain: false },
};
const META = { cameraDeviceReported: 'remidio_fop', pupilStatus: 'dilated', lightingEnvironment: 'indoor_clinic', observedIssues: ['none_noticed'], workerUsabilityRating: 'clear', eyeLaterality: 'right' };
const PASS = {
  status: 'pass', reason: null, compositeScore: 0.92, preset: 'default', analysedAt: '1002x867',
  scores: { focusScore: 0.8, illuminationScore: 0.95, fovScore: 1, coveragePercent: 0.86, glareScore: 0, motionScore: 0.18, occlusionScore: 0.01 },
};

/** Registers a patient and queues one capture exactly as the Capture screen does. */
async function queueCase({ image = '1_quality_pass.jpg', age = 58, questionnaire = Q, name = 'Sync Test' } = {}) {
  const p = await patients.createPatient({
    name, age, contactNumber: '+919000000002', consentGivenAt: new Date().toISOString(),
    demographics: { patientType: 'new' }, questionnaire,
  });
  const captureId = caps.newCaptureId();
  const stored = await persistCaptureImage(path.join(DEMO, image), captureId, 'image/jpeg');
  await caps.recordCapture({
    captureId, patientId: p.patientId, cameraDeviceId: 'remidio_fop', source: 'gallery',
    imagePath: stored.uri, imageBytes: stored.bytes, quality: PASS, capturedAt: new Date().toISOString(),
  });
  const payload = toQuestionnairePayload(questionnaire, 'en');
  await caps.queueCapture({
    captureId, eye: 'right', cameraDeviceId: 'remidio_fop', bestEffort: false,
    questionnaire: payload, metadata: META, priorityTier: priorityTier(payload, META, PASS, false),
  });
  return { captureId, patientId: p.patientId };
}

const entry = (captureId) => caps.getQueueEntry(captureId);

async function syncUntil(captureId, pred, rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    await syncManager.trigger();
    const e = await entry(captureId);
    if (pred(e)) return e;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return entry(captureId);
}

test('happy path: summary -> image -> graded -> report, with lifecycle stages along the way', async (t) => {
  if (skipIfDown(t)) return;
  const { captureId } = await queueCase();
  assert.equal((await entry(captureId)).lifecycle, 'quality_passed');
  assert.equal(await caps.pendingUploadCount() >= 1, true);

  await syncManager.trigger();
  const afterUpload = await entry(captureId);
  assert.equal(afterUpload.sync.state, 'synced', `state=${afterUpload.sync.state} err=${afterUpload.sync.lastError}`);
  assert.ok(afterUpload.sync.summarySentAt && afterUpload.sync.uploadedAt && afterUpload.sync.centralCaseId);
  assert.equal(syncManager.current.connectivity, 'online');

  const done = await syncUntil(captureId, (e) => e.lifecycle === 'result_delivered' || e.problem === 'grading_failed');
  assert.equal(done.lifecycle, 'result_delivered', `problem=${done.problem}`);

  const r = await getReport(captureId);
  assert.equal(r.status, 'graded');
  assert.equal(r.caseId, done.sync.centralCaseId);
  assert.ok(Number.isInteger(r.drGradeCnn));
  assert.equal(r.review, null);
});

test('large image goes through the chunked, resumable upload', async (t) => {
  if (skipIfDown(t)) return;
  const before = POLICY.chunkThresholdBytes;
  POLICY.chunkThresholdBytes = 100_000; // force it for a 443 KB demo image
  try {
    const { captureId } = await queueCase({ image: '2_grading_confirm.jpg' });
    assert.ok((await entry(captureId)).capture.imageBytes > POLICY.chunkThresholdBytes);
    await syncManager.trigger();
    const e = await entry(captureId);
    assert.equal(e.sync.state, 'synced', `err=${e.sync.lastError}`);
    assert.ok(e.sync.centralCaseId);
  } finally {
    POLICY.chunkThresholdBytes = before;
  }
});

test('phone offline: nothing is attempted, nothing is lost, it syncs when the network returns', async (t) => {
  if (skipIfDown(t)) return;
  const { captureId } = await queueCase();
  globalThis.__deviceOnline = false;
  try {
    await syncManager.trigger();
    assert.equal(syncManager.current.connectivity, 'offline');
    const e = await entry(captureId);
    assert.equal(e.sync.state, 'pending');
    assert.equal(e.sync.attempts, 0);
  } finally {
    globalThis.__deviceOnline = true;
  }
  await syncManager.trigger();
  assert.equal((await entry(captureId)).sync.state, 'synced');
});

test('central unreachable: case stays queued, connectivity says so, and it syncs once central is back', async (t) => {
  if (skipIfDown(t)) return;
  const { captureId } = await queueCase();
  setConfig({ centralUrl: 'http://127.0.0.1:59999' });
  try {
    await syncManager.trigger();
    assert.equal(syncManager.current.connectivity, 'no_server');
    assert.equal((await entry(captureId)).sync.state, 'pending');
  } finally {
    setConfig({ centralUrl: CENTRAL });
  }
  await syncManager.trigger();
  assert.equal((await entry(captureId)).sync.state, 'synced');
});

test('lost response: re-sending an already-accepted case returns the SAME central case (idempotent)', async (t) => {
  if (skipIfDown(t)) return;
  const { captureId } = await queueCase();
  await syncManager.trigger();
  const first = await entry(captureId);
  assert.equal(first.sync.state, 'synced');
  // Simulate the app dying after central accepted the upload but before it
  // recorded that: the row is back to 'pending' with no memory of the case.
  const db = await getDb();
  await db.runAsync(`UPDATE sync_queue SET state='pending', central_case_id=NULL, summary_sent_at=NULL, uploaded_at=NULL WHERE capture_id=?`, [captureId]);
  await syncManager.trigger();
  const second = await entry(captureId);
  assert.equal(second.sync.state, 'synced');
  assert.equal(second.sync.centralCaseId, first.sync.centralCaseId);
});

test('central rejects the data: marked failed with its reason, not retried forever, retry puts it back', async (t) => {
  if (skipIfDown(t)) return;
  const { captureId } = await queueCase({ age: 200 }); // central: patientAge must be 0-130
  await syncManager.trigger();
  const e = await entry(captureId);
  assert.equal(e.sync.state, 'failed');
  assert.equal(e.problem, 'upload_failed');
  assert.equal(e.sync.lastErrorCode, 'invalid_field');
  assert.match(e.sync.lastError, /patientAge/);
  assert.notEqual(await caps.nextDueForUpload(), captureId);
  await caps.resetForRetry(captureId);
  assert.equal((await entry(captureId)).sync.state, 'pending');
  await (await getDb()).runAsync(`UPDATE sync_queue SET state='failed' WHERE capture_id=?`, [captureId]); // leave it parked
});

test('queue order: urgent first, then oldest first', async () => {
  globalThis.__deviceOnline = false; // keep the manager from uploading while we inspect order
  try {
    const db = await getDb();
    await db.runAsync(`UPDATE sync_queue SET state='failed' WHERE state IN ('pending','summary_sent')`);
    const routine = await queueCase({ name: 'Routine Old' });
    await new Promise((r) => setTimeout(r, 5));
    const urgent = await queueCase({ name: 'Urgent New', questionnaire: { ...Q, symptoms: { ...Q.symptoms, suddenVisionChange: true } } });
    assert.equal(await caps.nextDueForUpload(), urgent.captureId);
    await db.runAsync(`UPDATE sync_queue SET state='failed' WHERE capture_id=?`, [urgent.captureId]);
    assert.equal(await caps.nextDueForUpload(), routine.captureId);
    await db.runAsync(`UPDATE sync_queue SET state='failed' WHERE capture_id=?`, [routine.captureId]);
  } finally {
    globalThis.__deviceOnline = true;
  }
});

test('a missing image file is surfaced as a failure, not silently skipped', async (t) => {
  if (skipIfDown(t)) return;
  const { captureId } = await queueCase();
  const { File } = await import('expo-file-system');
  new File((await entry(captureId)).capture.imagePath).delete();
  await syncManager.trigger();
  const e = await entry(captureId);
  assert.equal(e.sync.state, 'failed');
  assert.equal(e.sync.lastErrorCode, 'image_missing');
});

test('duplicate check finds the patient registered earlier on this device', async () => {
  const m = await patients.findPossibleDuplicates('Sync Tset', 58, '+91 90000 00002');
  assert.ok(m.length > 0 && m[0].matchedOn.includes('phone'));
});
