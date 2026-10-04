import {
  PatientQuestionnaire, QuestionnairePayload, CaptureMetadataPayload, QualityResult,
} from '../types';

export const EMPTY_QUESTIONNAIRE: PatientQuestionnaire = {
  knownDiabetic: true,
  yearsSinceDiagnosis: null,
  glycemicControl: null,
  bloodPressure: null,
  pregnancy: 'not_applicable',
  hba1c: '',
  symptoms: { blurredVision: false, floaters: false, suddenVisionChange: false, eyePain: false },
};

/** Pregnancy is only asked of a patient who could be pregnant (desktop: age < 55; plus not male). */
export function pregnancyApplies(age: number | null, gender: string): boolean {
  if (gender === 'male') return false;
  return age === null || Number.isNaN(age) || age < 55;
}

/** Every question the form must have an answer for before capture can start (§9.1: no skip). */
export function questionnaireMissing(q: PatientQuestionnaire): string[] {
  const missing: string[] = [];
  if (q.knownDiabetic && !q.yearsSinceDiagnosis) missing.push('yearsSinceDiagnosis');
  if (!q.glycemicControl) missing.push('glycemicControl');
  if (!q.bloodPressure) missing.push('bloodPressure');
  return missing;
}

function numOrNull(v: string, min: number, max: number): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export function toQuestionnairePayload(q: PatientQuestionnaire, language: string): QuestionnairePayload {
  return {
    riskFactors: {
      yearsSinceDiagnosis: q.knownDiabetic ? (q.yearsSinceDiagnosis ?? 'lt1') : 'lt1',
      glycemicControl: q.glycemicControl ?? 'moderate',
      bloodPressure: q.bloodPressure ?? 'unknown',
      pregnant: q.pregnancy === 'yes' ? true : q.pregnancy === 'no' ? false : null,
      hba1c: numOrNull(q.hba1c, 4, 20),
      yearsDiabetic: null,
    },
    symptoms: { ...q.symptoms },
    language,
  };
}

export function priorityTier(q: QuestionnairePayload, meta: CaptureMetadataPayload, quality: QualityResult | null, bestEffort: boolean): number {
  const redFlag = q.symptoms.suddenVisionChange || q.symptoms.eyePain;
  if (redFlag || bestEffort) return 0;
  const elevated = q.riskFactors.glycemicControl === 'poor'
    || q.riskFactors.yearsSinceDiagnosis === 'gt10'
    || q.symptoms.blurredVision || q.symptoms.floaters
    || quality?.status === 'borderline'
    || meta.workerUsabilityRating !== 'clear';
  return elevated ? 1 : 2;
}
