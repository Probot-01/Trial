

import {
  YEARS_SINCE_DIAGNOSIS, GLYCEMIC_CONTROL, BLOOD_PRESSURE, SYMPTOMS,
  PUPIL_STATUS, LIGHTING_ENVIRONMENT, OBSERVED_ISSUES, USABILITY_RATING, NONE_NOTICED, EYES,
} from './captureOptions.js';

export class IncompleteAnswers extends Error {
  constructor(what, missing) {
    super(`${what} is incomplete: ${missing.join(', ')}.`);
    this.name = 'IncompleteAnswers';
    this.missing = missing;
  }
}

const ids = (list) => list.map((o) => o.id);
const oneOf = (list, v) => ids(list).includes(v);


export function buildQuestionnairePayload(q, language = null) {
  const missing = [];
  if (!q || typeof q !== 'object') throw new IncompleteAnswers('The patient questionnaire', ['all answers']);

  if (typeof q.knownDiabetic !== 'boolean') missing.push('known diabetic?');
  if (!oneOf(YEARS_SINCE_DIAGNOSIS, q.yearsSinceDiagnosis)) missing.push('years since diagnosis');
  if (!oneOf(GLYCEMIC_CONTROL, q.glycemicControl)) missing.push('glycemic control');
  if (!oneOf(BLOOD_PRESSURE, q.bloodPressure)) missing.push('blood pressure');
  if (!['yes', 'no', 'not_applicable'].includes(q.pregnancy)) missing.push('pregnancy');
  for (const s of SYMPTOMS) {
    if (typeof q[s.id] !== 'boolean') missing.push(s.label.toLowerCase());
  }
  if (missing.length) throw new IncompleteAnswers('The patient questionnaire', missing);

  const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    riskFactors: {
      yearsSinceDiagnosis: q.yearsSinceDiagnosis,
      glycemicControl: q.glycemicControl,
      bloodPressure: q.bloodPressure,
      // null means "not applicable / not asked" -- a different answer from false.
      pregnant: q.pregnancy === 'yes' ? true : q.pregnancy === 'no' ? false : null,
      // Measured values are optional and only sent when someone measured them.
      hba1c: num(q.hba1c),
      yearsDiabetic: num(q.yearsDiabetic),
    },
    symptoms: Object.fromEntries(SYMPTOMS.map((s) => [s.id, q[s.id]])),
    language: language || null,
  };
}


export function buildMetadataPayload(m, { eye, cameraDeviceId }) {
  const missing = [];
  if (!oneOf(EYES, eye)) missing.push('eye (left/right)');
  if (!cameraDeviceId) missing.push('camera');
  if (!m || typeof m !== 'object') throw new IncompleteAnswers('The capture details', ['all answers']);
  if (!oneOf(PUPIL_STATUS, m.pupilStatus)) missing.push('pupil status');
  if (!oneOf(LIGHTING_ENVIRONMENT, m.lightingEnvironment)) missing.push('lighting');
  if (!oneOf(USABILITY_RATING, m.workerUsabilityRating)) missing.push('image usability');

  const issues = Array.isArray(m.observedIssues) ? m.observedIssues : [];
  if (!issues.length) missing.push('observed issues (or "none noticed")');
  const known = new Set([...ids(OBSERVED_ISSUES), NONE_NOTICED]);
  const unknown = issues.filter((i) => !known.has(i));
  if (unknown.length) missing.push(`unrecognised issue(s): ${unknown.join(', ')}`);
  if (issues.includes(NONE_NOTICED) && issues.length > 1) {
    missing.push('"none noticed" cannot be combined with an observed issue');
  }
  if (missing.length) throw new IncompleteAnswers('The capture details', missing);

  return {
    cameraDeviceReported: cameraDeviceId,
    pupilStatus: m.pupilStatus,
    lightingEnvironment: m.lightingEnvironment,
    observedIssues: issues,
    workerUsabilityRating: m.workerUsabilityRating,
    eyeLaterality: eye,
  };
}
