/**
 * Unit tests for the app's pure logic, run on the real source files.
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const q = await import('../netrasetu/lib/questionnaire.ts');
const meta = await import('../netrasetu/lib/metadata.ts');
const fuzzy = await import('../netrasetu/lib/fuzzy.ts');
const fmt = await import('../netrasetu/lib/format.ts');
const grades = await import('../netrasetu/lib/grades.ts');
const ids = await import('../netrasetu/lib/ids.ts');
const gate = await import('../netrasetu/lib/quality/qualityGate.ts');
const { lifecycleOf } = await import('../netrasetu/db/captures.ts');
const { setConfig, getConfig } = await import('../netrasetu/config/index.ts');
const central = await import('../netrasetu/api/central.ts');
const { QUALITY_GATE_ENGINE } = await import('../netrasetu/lib/quality/engine.ts');

const baseQ = {
  knownDiabetic: true, yearsSinceDiagnosis: '5to10', glycemicControl: 'moderate', bloodPressure: 'normal',
  pregnancy: 'not_applicable', hba1c: '', symptoms: { blurredVision: false, floaters: false, suddenVisionChange: false, eyePain: false },
};
const baseMeta = { cameraDeviceReported: 'remidio_fop', pupilStatus: 'dilated', lightingEnvironment: 'indoor_clinic', observedIssues: ['none_noticed'], workerUsabilityRating: 'clear', eyeLaterality: 'left' };

// ── Questionnaire (design doc §9.1, api-contracts enums) ────────────────────
test('questionnaire payload uses only contract enum values', () => {
  const p = q.toQuestionnairePayload(baseQ, 'hi');
  assert.deepEqual(p.riskFactors, { yearsSinceDiagnosis: '5to10', glycemicControl: 'moderate', bloodPressure: 'normal', pregnant: null, hba1c: null, yearsDiabetic: null });
  assert.equal(p.language, 'hi');
});

test('not-known-diabetic is sent as lt1, not whatever bucket was left selected', () => {
  assert.equal(q.toQuestionnairePayload({ ...baseQ, knownDiabetic: false, yearsSinceDiagnosis: 'gt10' }, 'en').riskFactors.yearsSinceDiagnosis, 'lt1');
});

test('HbA1c: blank or out of range is null (never a guessed number); a real value passes through', () => {
  assert.equal(q.toQuestionnairePayload({ ...baseQ, hba1c: '' }, 'en').riskFactors.hba1c, null);
  assert.equal(q.toQuestionnairePayload({ ...baseQ, hba1c: '25' }, 'en').riskFactors.hba1c, null);
  assert.equal(q.toQuestionnairePayload({ ...baseQ, hba1c: 'abc' }, 'en').riskFactors.hba1c, null);
  assert.equal(q.toQuestionnairePayload({ ...baseQ, hba1c: '8.2' }, 'en').riskFactors.hba1c, 8.2);
});

test('pregnancy maps yes/no/N-A to true/false/null', () => {
  assert.equal(q.toQuestionnairePayload({ ...baseQ, pregnancy: 'yes' }, 'en').riskFactors.pregnant, true);
  assert.equal(q.toQuestionnairePayload({ ...baseQ, pregnancy: 'no' }, 'en').riskFactors.pregnant, false);
  assert.equal(q.toQuestionnairePayload({ ...baseQ, pregnancy: 'not_applicable' }, 'en').riskFactors.pregnant, null);
});

test('pregnancy is asked only when it can apply', () => {
  assert.equal(q.pregnancyApplies(30, 'female'), true);
  assert.equal(q.pregnancyApplies(60, 'female'), false);
  assert.equal(q.pregnancyApplies(30, 'male'), false);
  assert.equal(q.pregnancyApplies(null, ''), true);
});

test('no skip: every risk question must be answered', () => {
  assert.deepEqual(q.questionnaireMissing(baseQ), []);
  assert.deepEqual(q.questionnaireMissing({ ...baseQ, yearsSinceDiagnosis: null, glycemicControl: null, bloodPressure: null }),
    ['yearsSinceDiagnosis', 'glycemicControl', 'bloodPressure']);
  assert.deepEqual(q.questionnaireMissing({ ...baseQ, knownDiabetic: false, yearsSinceDiagnosis: null }), []);
});

test('sync priority: red flags and best-effort first, then elevated risk, then routine', () => {
  const routine = q.toQuestionnairePayload(baseQ, 'en');
  const red = q.toQuestionnairePayload({ ...baseQ, symptoms: { ...baseQ.symptoms, suddenVisionChange: true } }, 'en');
  const poor = q.toQuestionnairePayload({ ...baseQ, glycemicControl: 'poor' }, 'en');
  assert.equal(q.priorityTier(red, baseMeta, null, false), 0);
  assert.equal(q.priorityTier(routine, baseMeta, null, true), 0);
  assert.equal(q.priorityTier(poor, baseMeta, null, false), 1);
  assert.equal(q.priorityTier(routine, { ...baseMeta, workerUsabilityRating: 'not_sure' }, null, false), 1);
  assert.equal(q.priorityTier(routine, baseMeta, { status: 'borderline' }, false), 1);
  assert.equal(q.priorityTier(routine, baseMeta, { status: 'pass' }, false), 2);
});

// ── Capture metadata (§9.6) ─────────────────────────────────────────────────
test("'none_noticed' is exclusive, as the contract requires", () => {
  assert.deepEqual(meta.toggleObservedIssue(['glare'], 'none_noticed'), ['none_noticed']);
  assert.deepEqual(meta.toggleObservedIssue(['none_noticed'], 'glare'), ['glare']);
  assert.deepEqual(meta.toggleObservedIssue(['glare', 'out_of_focus'], 'glare'), ['out_of_focus']);
  assert.deepEqual(meta.toggleObservedIssue(['none_noticed'], 'none_noticed'), []);
});

test('every metadata question is required, including the eye', () => {
  const empty = { eye: null, cameraDeviceId: 'unknown', pupilStatus: null, lightingEnvironment: null, observedIssues: [], workerUsabilityRating: null };
  assert.equal(meta.metadataMissing(empty).length, 5);
  const full = { eye: 'right', cameraDeviceId: 'mobile_lens', pupilStatus: 'unknown', lightingEnvironment: 'low_light', observedIssues: ['glare'], workerUsabilityRating: 'not_sure' };
  assert.deepEqual(meta.metadataMissing(full), []);
  assert.deepEqual(meta.toMetadataPayload(full), {
    cameraDeviceReported: 'mobile_lens', pupilStatus: 'unknown', lightingEnvironment: 'low_light',
    observedIssues: ['glare'], workerUsabilityRating: 'not_sure', eyeLaterality: 'right',
  });
});

// ── Duplicate patients (§10.3) ──────────────────────────────────────────────
test('duplicate matching: same phone is a strong match, a name typo still matches, a stranger does not', () => {
  const existing = { name: 'Sunita K. Devi', age: 54, contactNumber: '+91 98765-43210' };
  const byPhone = fuzzy.scoreMatch({ name: 'S Devi', age: 54, phone: '9876543210' }, existing);
  assert.ok(byPhone.score >= 0.6 && byPhone.matchedOn.includes('phone'));
  const byName = fuzzy.scoreMatch({ name: 'Sunita K Devii', age: 55, phone: '' }, existing);
  assert.ok(byName.score >= 0.35 && byName.matchedOn.includes('name'), JSON.stringify(byName));
  assert.equal(fuzzy.scoreMatch({ name: 'Ramesh Kumar', age: 54, phone: '9000000000' }, existing).score, 0);
});

// ── IDs (docs/id-format-spec.md) ────────────────────────────────────────────
test('local IDs follow the shared format and use the configured site code', () => {
  const before = getConfig().phcCode;
  setConfig({ phcCode: 'PHC042' });
  for (let i = 0; i < 1000; i++) {
    const id = ids.generateLocalId();
    assert.match(id, ids.LOCAL_ID_RE);
    assert.ok(id.startsWith('PHC042-'));
    assert.equal(id.split('-')[1], id.split('-')[1].toLowerCase());
  }
  setConfig({ phcCode: before });
});


test('one process never repeats an ID, even minting a million back-to-back', () => {
  const n = 1_000_000;
  const seen = new Set();
  for (let i = 0; i < n; i++) seen.add(ids.generateLocalId('X'));
  assert.equal(seen.size, n);
});

test('a frozen clock (bulk import, clock not advancing) still yields unique, increasing IDs', () => {
  const realNow = Date.now;
  Date.now = () => 1_900_000_000_000;
  try {
    const list = Array.from({ length: 50_000 }, () => ids.generateLocalId('X'));
    assert.equal(new Set(list).size, list.length);
    const ts = list.map((id) => parseInt(id.split('-')[1], 36));
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1]);
  } finally {
    Date.now = realNow;
  }
});

test('two devices of one PHC minting in the SAME millisecond do not collide (8-char suffix)', () => {
  // Same PHC code, same timestamp, independent RNG draws -- the desktop and
  // the phone at the same instant. Only the suffix separates them.
  const n = 200_000;
  const suffixes = new Set();
  for (let i = 0; i < n; i++) suffixes.add(ids.generateLocalId('X').split('-')[2]);
  const expected = (n * n) / (2 * 36 ** 8); // ~0.007
  assert.ok(n - suffixes.size <= 1, `${n - suffixes.size} suffix collisions (expected ~${expected.toFixed(3)})`);
});

test('ID format: 8-char suffix now; 4-char IDs minted before the fix stay valid', () => {
  assert.match(ids.generateLocalId('PHC001'), /^PHC001-[0-9a-z]+-[0-9a-z]{8}$/);
  assert.match('PHC001-lz3k9f-a2x9', ids.LOCAL_ID_RE);
  assert.doesNotMatch('PHC001-lz3k9f-a2x9k', ids.LOCAL_ID_RE);
  assert.ok(ids.generateLocalId('PHC001').length <= 64, 'fits the chunk-upload captureRef limit');
});

test('desktop (ids.js) and mobile (ids.ts) generate the identical format', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const desktop = require('../../backend/services/ids.js');
  const a = desktop.generateLocalId('PHC001');
  const b = ids.generateLocalId('PHC001');
  assert.match(a, ids.LOCAL_ID_RE);
  assert.match(b, desktop.LOCAL_ID_RE);
  assert.equal(a.split('-')[2].length, b.split('-')[2].length);
  assert.equal(String(desktop.LOCAL_ID_RE), String(ids.LOCAL_ID_RE));
});

test('ID suffix has no modulo bias (a-d are not favoured)', () => {
  const counts = {};
  for (let i = 0; i < 20000; i++) for (const ch of ids.generateLocalId('X').split('-')[2].slice(0, 4)) counts[ch] = (counts[ch] ?? 0) + 1;
  const expected = (20000 * 4) / 36;
  const firstFour = ['a', 'b', 'c', 'd'].reduce((s, c) => s + counts[c], 0) / 4;
  const rest = Object.entries(counts).filter(([c]) => !'abcd'.includes(c)).reduce((s, [, n]) => s + n, 0) / 32;
  assert.ok(Math.abs(firstFour / rest - 1) < 0.05, `a-d mean ${firstFour} vs rest ${rest} (expected ~${expected})`);
});

// ── Display helpers: never a made-up number ─────────────────────────────────
test('missing values display as N/A, not 0%', () => {
  assert.equal(fmt.pct(null), 'N/A');
  assert.equal(fmt.pct(undefined), 'N/A');
  assert.equal(fmt.pct(0), '0%');
  assert.equal(fmt.pct(0.873), '87%');
});

test('age from DOB, and short IDs', () => {
  const y = new Date().getFullYear() - 40;
  assert.equal(fmt.ageFromDob(`01/01/${y}`), 40);
  assert.equal(fmt.ageFromDob('not a date'), null);
  assert.equal(fmt.shortId('PHC001-mtuss3yg-a2x9'), 'MTUSS3YG');
});

test('grade labels cover ICDR 0-4 and nothing else; referable is grade 2+', () => {
  assert.equal(grades.gradeLabel(0), 'No DR');
  assert.equal(grades.gradeLabel(4), 'Proliferative DR');
  assert.equal(grades.gradeLabel(5), null);
  assert.equal(grades.gradeLabel(null), null);
  assert.equal(grades.isReferable(1), false);
  assert.equal(grades.isReferable(2), true);
  assert.equal(grades.isReferable(null), false);
});

// ── Local Queue lifecycle (desktop's pipeline vocabulary) ───────────────────
test('lifecycle stages come only from real local/central state', () => {
  const cap = (over = {}) => ({ qualityStatus: 'pass', bestEffort: false, ...over });
  const sync = (over = {}) => ({ state: 'pending', attempts: 0, lastErrorCode: null, summarySentAt: null, centralStatus: null, ...over });
  assert.deepEqual(lifecycleOf(cap({ qualityStatus: 'retake' }), null), { lifecycle: 'captured', problem: null });
  assert.deepEqual(lifecycleOf(cap(), sync()), { lifecycle: 'quality_passed', problem: null });
  assert.deepEqual(lifecycleOf(cap(), sync({ attempts: 2, lastErrorCode: 'network_unreachable' })), { lifecycle: 'quality_passed', problem: 'retrying' });
  assert.deepEqual(lifecycleOf(cap(), sync({ state: 'summary_sent', summarySentAt: 'x' })), { lifecycle: 'synced', problem: null });
  assert.deepEqual(lifecycleOf(cap(), sync({ state: 'synced', centralStatus: 'processing' })), { lifecycle: 'result_pending', problem: null });
  assert.deepEqual(lifecycleOf(cap(), sync({ state: 'synced', centralStatus: 'graded' })), { lifecycle: 'result_delivered', problem: null });
  assert.deepEqual(lifecycleOf(cap(), sync({ state: 'synced', centralStatus: 'error' })), { lifecycle: 'result_pending', problem: 'grading_failed' });
  assert.deepEqual(lifecycleOf(cap(), sync({ state: 'failed' })), { lifecycle: 'quality_passed', problem: 'upload_failed' });
});

// ── Quality gate edge cases (full parity is verify_mobile_quality_gate_parity.mjs) ──
test('quality gate: an all-black frame is insufficient field of view, never a pass', () => {
  const W = 64, H = 48;
  const r = gate.runQualityGateOnGray({ pixels: new Uint8Array(W * H), width: W, height: H }, 'default');
  assert.equal(r.status, 'retake');
  assert.equal(r.reason, 'insufficient_fov');
});

test('quality gate: unknown camera ids fall back to the default preset, as MATLAB does', () => {
  assert.equal(gate.presetFor('forus_3nethra_v2'), 'default');
  assert.equal(gate.presetFor('mobile_lens'), 'mobile_lens');
  assert.equal(gate.presetFor('constructor'), 'default');
});

// ── "Synced" means central accepted it (api-contracts.md: 201, or 200 + duplicate:true) ──────────
async function withFetch(status, body, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const prev = getConfig();
  setConfig({ centralUrl: 'http://central.test', phcApiKey: 'phc_test' });
  try { return await fn(); } finally { globalThis.fetch = real; setConfig(prev); }
}
const FIELDS = {
  patientId: 'P', captureIdRef: 'C', cameraDeviceId: 'unknown', capturedAt: 'x', consentGivenAt: null, patientName: 'n', patientAge: 1,
  patientContactNumber: '1', questionnaireData: {}, captureMetadata: {}, qualityScores: null, pendingCount: 1
};

test('summary: 201 is accepted; 200 + duplicate:true is accepted; a bare 200 is NOT acceptance', async () => {
  assert.equal((await withFetch(201, { caseId: 'c1', status: 'awaiting_image' }, () => central.postSummary(FIELDS))).caseId, 'c1');
  assert.equal((await withFetch(200, { caseId: 'c1', duplicate: true }, () => central.postSummary(FIELDS))).caseId, 'c1');
  await assert.rejects(withFetch(200, { caseId: 'c1' }, () => central.postSummary(FIELDS)), (e) => e.code === 'not_accepted' && e.retryable === false);
  await assert.rejects(withFetch(201, {}, () => central.postSummary(FIELDS)), (e) => e.code === 'not_accepted');
});

test('a 4xx is central refusing (not retryable, its own code); a 5xx is retryable', async () => {
  await assert.rejects(withFetch(400, { error: 'invalid_field', message: 'bad' }, () => central.postSummary(FIELDS)), (e) => e.code === 'invalid_field' && !e.retryable);
  await assert.rejects(withFetch(503, { error: 'x', message: 'down' }, () => central.postSummary(FIELDS)), (e) => e.retryable);
});

test('the phone reports its quality-gate engine as js-device, not a fallback', () => {
  assert.deepEqual({ engine: QUALITY_GATE_ENGINE.engine, fallback: QUALITY_GATE_ENGINE.fallback }, { engine: 'js-device', fallback: false });
  assert.ok(QUALITY_GATE_ENGINE.detail.length <= 300);
});

test('the summary request carries the PHC API key and the engine', async () => {
  const real = globalThis.fetch; let seen;
  globalThis.fetch = async (u, init) => { seen = { u, init }; return new Response(JSON.stringify({ caseId: 'c1' }), { status: 201 }); };
  const prev = getConfig(); setConfig({ centralUrl: 'http://central.test', phcApiKey: 'phc_test' });
  try { await central.postSummary({ ...FIELDS, qualityGateEngine: QUALITY_GATE_ENGINE }); } finally { globalThis.fetch = real; setConfig(prev); }
  assert.equal(seen.u, 'http://central.test/api/v1/cases/summary');
  assert.equal(seen.init.headers['X-PHC-Api-Key'], 'phc_test');
  assert.equal(JSON.parse(seen.init.body).qualityGateEngine.engine, 'js-device');
});

// ── Expo's UTF-8-only TextDecoder must not crash fast-png at load ───────────
test('latin1 shim: a UTF-8-only TextDecoder gains latin1 and keeps its UTF-8 behaviour', async () => {
  const Real = globalThis.TextDecoder;
  globalThis.TextDecoder = class Utf8Only extends Real {
    constructor(label, opts) { if (label && !/^utf-?8$/i.test(label)) throw new RangeError(`Unknown encoding ${label}`); super(label, opts); }
  };
  try {
    const { installLatin1Decoder } = await import('../netrasetu/lib/latin1Shim.ts');
    installLatin1Decoder();
    assert.equal(new TextDecoder('latin1').decode(new Uint8Array([0x63, 0x61, 0x66, 0xe9])), 'café');
    assert.equal(new TextDecoder('utf-8').decode(new Uint8Array([0xc3, 0xa9])), 'é');
    assert.equal(new TextDecoder().decode(new Uint8Array([0x61])), 'a');
  } finally { globalThis.TextDecoder = Real; }
});
