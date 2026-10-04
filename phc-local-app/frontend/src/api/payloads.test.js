// npm test  (phc-local-app/frontend)   -- plain node:test, no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestionnairePayload, buildMetadataPayload, IncompleteAnswers } from './payloads.js';

const Q = {
  knownDiabetic: true, yearsSinceDiagnosis: '5to10', glycemicControl: 'poor', bloodPressure: 'high',
  pregnancy: 'no', blurredVision: true, floaters: false, suddenVisionChange: false, eyePain: true,
};
const M = { pupilStatus: 'dilated', lightingEnvironment: 'low_light', workerUsabilityRating: 'not_sure', observedIssues: ['glare', 'out_of_focus'] };

test('questionnaire: every answer is carried through as given', () => {
  const p = buildQuestionnairePayload(Q, 'hi');
  assert.deepEqual(p.riskFactors, {
    yearsSinceDiagnosis: '5to10', glycemicControl: 'poor', bloodPressure: 'high',
    pregnant: false, hba1c: null, yearsDiabetic: null,
  });
  assert.deepEqual(p.symptoms, { blurredVision: true, floaters: false, suddenVisionChange: false, eyePain: true });
  assert.equal(p.language, 'hi');
});

test('questionnaire: pregnancy yes/no/not_applicable -> true/false/null (null is a different answer from false)', () => {
  assert.equal(buildQuestionnairePayload({ ...Q, pregnancy: 'yes' }).riskFactors.pregnant, true);
  assert.equal(buildQuestionnairePayload({ ...Q, pregnancy: 'no' }).riskFactors.pregnant, false);
  assert.equal(buildQuestionnairePayload({ ...Q, pregnancy: 'not_applicable' }).riskFactors.pregnant, null);
});

test('questionnaire: a measured HbA1c is sent, a blank one is null -- never a default', () => {
  assert.equal(buildQuestionnairePayload({ ...Q, hba1c: '8.4' }).riskFactors.hba1c, 8.4);
  assert.equal(buildQuestionnairePayload({ ...Q, hba1c: '' }).riskFactors.hba1c, null);
});

test('questionnaire: an unanswered question is an error naming it -- no silent "moderate"/"unknown"', () => {
  for (const [field, label] of [['glycemicControl', 'glycemic control'], ['bloodPressure', 'blood pressure'],
  ['yearsSinceDiagnosis', 'years since diagnosis'], ['pregnancy', 'pregnancy']]) {
    const q = { ...Q, [field]: '' };
    assert.throws(() => buildQuestionnairePayload(q), (e) => e instanceof IncompleteAnswers && e.missing.includes(label), field);
  }
  assert.throws(() => buildQuestionnairePayload({ ...Q, knownDiabetic: null }), IncompleteAnswers);
  assert.throws(() => buildQuestionnairePayload({ ...Q, floaters: undefined }), /floaters/);
  assert.throws(() => buildQuestionnairePayload(null), IncompleteAnswers);
});

test('metadata: eye, camera and every answer are carried through -- including eyeLaterality, which used to be dropped', () => {
  const p = buildMetadataPayload(M, { eye: 'left', cameraDeviceId: 'remidio_fop' });
  assert.deepEqual(p, {
    cameraDeviceReported: 'remidio_fop', pupilStatus: 'dilated', lightingEnvironment: 'low_light',
    observedIssues: ['glare', 'out_of_focus'], workerUsabilityRating: 'not_sure', eyeLaterality: 'left',
  });
});

test('metadata: the technician\'s observed issues are kept, not replaced by "none_noticed"', () => {
  const p = buildMetadataPayload({ ...M, observedIssues: ['media_opacity'] }, { eye: 'right', cameraDeviceId: 'unknown' });
  assert.deepEqual(p.observedIssues, ['media_opacity']);
});

test('metadata: "none noticed" must be chosen, and stands alone', () => {
  assert.throws(() => buildMetadataPayload({ ...M, observedIssues: [] }, { eye: 'left', cameraDeviceId: 'unknown' }), /observed issues/);
  assert.deepEqual(buildMetadataPayload({ ...M, observedIssues: ['none_noticed'] }, { eye: 'left', cameraDeviceId: 'unknown' }).observedIssues, ['none_noticed']);
  assert.throws(() => buildMetadataPayload({ ...M, observedIssues: ['none_noticed', 'glare'] }, { eye: 'left', cameraDeviceId: 'unknown' }), /cannot be combined/);
});

test('metadata: no eye, no camera, or an out-of-contract answer is an error', () => {
  assert.throws(() => buildMetadataPayload(M, { eye: null, cameraDeviceId: 'unknown' }), /eye/);
  assert.throws(() => buildMetadataPayload(M, { eye: 'left', cameraDeviceId: '' }), /camera/);
  assert.throws(() => buildMetadataPayload({ ...M, pupilStatus: undefined }, { eye: 'left', cameraDeviceId: 'unknown' }), /pupil/);
  assert.throws(() => buildMetadataPayload({ ...M, lightingEnvironment: 'dim' }, { eye: 'left', cameraDeviceId: 'unknown' }), /lighting/);
  assert.throws(() => buildMetadataPayload({ ...M, workerUsabilityRating: null }, { eye: 'left', cameraDeviceId: 'unknown' }), /usability/);
  assert.throws(() => buildMetadataPayload({ ...M, observedIssues: ['CATARACT SUSPECTED'] }, { eye: 'left', cameraDeviceId: 'unknown' }), /unrecognised/);
});
