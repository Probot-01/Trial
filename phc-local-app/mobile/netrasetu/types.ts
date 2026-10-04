
export interface Demographics {
  patientType: 'new' | 'revisit' | 'referral';
  abhaId: string;
  visitNo: string;
  title: string;
  firstName: string;
  middleName: string;
  lastName: string;
  gender: '' | 'female' | 'male' | 'other';
  dob: string;
  maritalStatus: string;
  bloodGroup: string;
  address: string;
  state: string;
  pincode: string;
  district: string;
  occupation: string;
  altPhone: string;
}

export interface Patient {
  patientId: string;
  name: string;
  age: number;
  contactNumber: string;
  consentGivenAt: string | null;
  duplicateOf: string | null;
  registeredAt: string;
  demographics: Demographics | null;
  questionnaire: PatientQuestionnaire | null;
}

// ── Patient symptom + risk questionnaire (design doc §9.1) ─────────────────
export type YearsSinceDiagnosis = 'lt1' | '1to5' | '5to10' | 'gt10';
export type GlycemicControl = 'good' | 'moderate' | 'poor';
export type BloodPressure = 'normal' | 'high' | 'unknown';
export type Pregnancy = 'yes' | 'no' | 'not_applicable';

export interface Symptoms {
  blurredVision: boolean;
  floaters: boolean;
  suddenVisionChange: boolean;
  eyePain: boolean;
}

/** What the form collects; converted to the contract payload by toQuestionnairePayload(). */
export interface PatientQuestionnaire {
  knownDiabetic: boolean;
  yearsSinceDiagnosis: YearsSinceDiagnosis | null;
  glycemicControl: GlycemicControl | null;
  bloodPressure: BloodPressure | null;
  pregnancy: Pregnancy;
  /** Lab HbA1c %, only if actually tested. Blank stays null -- never guessed. */
  hba1c: string;
  symptoms: Symptoms;
}

/** api-contracts.md, POST /captures/:captureId/questionnaire and central questionnaireData. */
export interface QuestionnairePayload {
  riskFactors: {
    yearsSinceDiagnosis: YearsSinceDiagnosis;
    glycemicControl: GlycemicControl;
    bloodPressure: BloodPressure;
    pregnant: boolean | null;
    hba1c: number | null;
    yearsDiabetic: number | null;
  };
  symptoms: Symptoms;
  language: string | null;
}

// ── Capture metadata questionnaire (design doc §9.6) ───────────────────────
export type PupilStatus = 'dilated' | 'non_dilated' | 'unknown';
export type LightingEnvironment = 'indoor_clinic' | 'outdoor_mobile' | 'low_light';
export type ObservedIssue = 'glare' | 'blink_or_moved' | 'out_of_focus' | 'media_opacity' | 'eyelash_obstruction' | 'none_noticed';
export type UsabilityRating = 'clear' | 'not_sure' | 'clearly_unusable';
export type Eye = 'left' | 'right';

export interface CaptureMetadataPayload {
  cameraDeviceReported: string;
  pupilStatus: PupilStatus;
  lightingEnvironment: LightingEnvironment;
  observedIssues: ObservedIssue[];
  workerUsabilityRating: UsabilityRating;
  eyeLaterality: Eye;
}

// ── Local quality gate ─────────────────────────────────────────────────────
export type QualityStatus = 'pass' | 'borderline' | 'retake';
export type QualityReason = 'blur' | 'low_illumination' | 'insufficient_fov' | 'glare' | 'motion_artifact' | 'eyelash_occlusion';

/** The seven sub-scores qualityGateMain.m reports, under the same names. */
export interface QualityScores {
  focusScore: number;
  illuminationScore: number;
  fovScore: number;
  coveragePercent: number;
  glareScore: number;
  motionScore: number;
  occlusionScore: number;
}

export interface QualityResult {
  status: QualityStatus;
  reason: QualityReason | null;
  scores: QualityScores;
  /** mean(focus, illumination, fov) -- the value the MATLAB gate compares to 0.7. */
  compositeScore: number;
  preset: string;
  /** Pixels actually analysed, e.g. "1024x768" -- recorded so a score can be traced. */
  analysedAt: string;
}

import type { QualityEngine } from './lib/quality/engine';
export type { QualityEngine };

export type CaptureSource = 'gallery' | 'lens' | 'sample';

export interface Capture {
  captureId: string;
  patientId: string;
  eye: Eye | null;
  cameraDeviceId: string;
  source: CaptureSource;
  imagePath: string;
  imageBytes: number | null;
  qualityStatus: QualityStatus;
  qualityReason: QualityReason | null;
  qualityScores: QualityResult | null;
  /** Which engine gated this capture; null = not recorded (never guessed). */
  qualityEngine: QualityEngine | null;
  retakeCount: number;
  bestEffort: boolean;
  capturedAt: string;
}

// ── Sync ───────────────────────────────────────────────────────────────────
export type SyncState = 'pending' | 'summary_sent' | 'synced' | 'failed';
export type CentralStatus = 'awaiting_image' | 'processing' | 'graded' | 'error';

export interface SyncRow {
  captureId: string;
  priorityTier: number;
  state: SyncState;
  centralCaseId: string | null;
  centralStatus: CentralStatus | null;
  summarySentAt: string | null;
  uploadedAt: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  enqueuedAt: string;
}

/** Local Queue lifecycle -- the same vocabulary as the desktop's GET /captures `status`. */
export type LifecycleStatus = 'captured' | 'quality_passed' | 'synced' | 'result_pending' | 'result_delivered';

export interface QueueEntry {
  capture: Capture;
  patient: Pick<Patient, 'patientId' | 'name' | 'age' | 'contactNumber'>;
  sync: SyncRow | null;
  lifecycle: LifecycleStatus;
  /** Set when something needs the technician's attention rather than more waiting. */
  problem: 'upload_failed' | 'retrying' | 'grading_failed' | null;
}

// ── Central PHC report (GET /api/v1/phc/cases/:captureRef/report) ──────────
export interface LesionCounts {
  microaneurysms: number | null;
  hemorrhages: number | null;
  hardExudates: number | null;
  softExudates: number | null;
}

export interface PhcReport {
  captureRef: string;
  caseId: string;
  status: CentralStatus;
  failureCode: string | null;
  gradedAt: string | null;
  modelVersion: string | null;
  drGradeCnn: number | null;
  drGradeRuleEngine: number | null;
  branchAgreement: boolean | null;
  confidenceScore: number | null;
  uncertaintyScore: number | null;
  conformalTier: 'A' | 'B' | 'C' | null;
  tierReason: string | null;
  lesionCounts: LesionCounts | null;
  nvSuspicionScore: number | null;
  evidenceSummaryText: string | null;
  eyeLaterality: Eye | null;
  eyeLateralityMismatch: boolean;
  foveaUnreliable: boolean | null;
  gradCamAvailable: boolean;
  review: { decision: 'confirm' | 'override'; correctedGrade: number | null; reviewedAt: string } | null;
}
