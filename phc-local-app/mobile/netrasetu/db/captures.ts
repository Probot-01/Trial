import { File } from 'expo-file-system';
import { getDb, nowIso } from './database';
import { generateLocalId } from '../lib/ids';
import { QUALITY_GATE_ENGINE } from '../lib/quality/engine';
import {
  Capture, CaptureMetadataPayload, CaptureSource, CentralStatus, Eye, LifecycleStatus,
  QualityResult, QueueEntry, QuestionnairePayload, SyncRow, SyncState,
} from '../types';

interface CaptureRow {
  capture_id: string;
  patient_id: string;
  eye: Eye | null;
  camera_device_id: string;
  source: CaptureSource;
  image_path: string;
  image_bytes: number | null;
  quality_status: Capture['qualityStatus'];
  quality_reason: Capture['qualityReason'];
  quality_scores_json: string | null;
  quality_engine: string | null;
  retake_count: number;
  best_effort: number;
  captured_at: string;
}

interface SyncDbRow {
  capture_id: string;
  priority_tier: number;
  state: SyncState;
  central_case_id: string | null;
  central_status: CentralStatus | null;
  summary_sent_at: string | null;
  uploaded_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  last_error_code: string | null;
  last_error: string | null;
  enqueued_at: string;
}

function captureFromRow(r: CaptureRow): Capture {
  return {
    captureId: r.capture_id,
    patientId: r.patient_id,
    eye: r.eye,
    cameraDeviceId: r.camera_device_id,
    source: r.source,
    imagePath: r.image_path,
    imageBytes: r.image_bytes,
    qualityStatus: r.quality_status,
    qualityReason: r.quality_reason,
    qualityScores: r.quality_scores_json ? JSON.parse(r.quality_scores_json) : null,
    qualityEngine: r.quality_engine ? JSON.parse(r.quality_engine) : null,
    retakeCount: r.retake_count,
    bestEffort: !!r.best_effort,
    capturedAt: r.captured_at,
  };
}

function syncFromRow(r: SyncDbRow): SyncRow {
  return {
    captureId: r.capture_id,
    priorityTier: r.priority_tier,
    state: r.state,
    centralCaseId: r.central_case_id,
    centralStatus: r.central_status,
    summarySentAt: r.summary_sent_at,
    uploadedAt: r.uploaded_at,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastAttemptAt: r.last_attempt_at,
    lastErrorCode: r.last_error_code,
    lastError: r.last_error,
    enqueuedAt: r.enqueued_at,
  };
}

// ── Capture lifecycle ──────────────────────────────────────────────────────

/**
 * Failed attempts for this patient since UTC midnight -- the same meaning as
 * the local backend's retakeCount ("which attempt is this, in this sitting").
 */
export async function countRetakesToday(patientId: string): Promise<number> {
  const db = await getDb();
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const r = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM captures WHERE patient_id = ? AND quality_status = 'retake' AND captured_at >= ?`,
    [patientId, midnight.toISOString()]);
  return r?.n ?? 0;
}

/** Mints the capture ID (the idempotency key -- never regenerated) for a new photo. */
export function newCaptureId(): string {
  return generateLocalId();
}


export async function recordCapture(c: {
  captureId: string;
  patientId: string;
  cameraDeviceId: string;
  source: CaptureSource;
  imagePath: string;
  imageBytes: number;
  quality: QualityResult;
  capturedAt: string;
}): Promise<Capture> {
  const db = await getDb();
  const retakeCount = await countRetakesToday(c.patientId);
  await db.runAsync(
    `INSERT INTO captures (capture_id, patient_id, eye, camera_device_id, source, image_path, image_bytes,
                           quality_status, quality_reason, quality_scores_json, quality_engine, retake_count, best_effort, captured_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [c.captureId, c.patientId, c.cameraDeviceId, c.source, c.imagePath, c.imageBytes,
    c.quality.status, c.quality.reason, JSON.stringify(c.quality), JSON.stringify(QUALITY_GATE_ENGINE), retakeCount, c.capturedAt]);
  return (await getCapture(c.captureId))!;
}


export async function discardUnqueuedCapture(captureId: string): Promise<void> {
  const db = await getDb();
  const c = await getCapture(captureId);
  if (!c || c.qualityStatus === 'retake') return;
  const queued = await db.getFirstAsync('SELECT 1 FROM sync_queue WHERE capture_id = ?', [captureId]);
  if (queued) return;
  await db.runAsync('DELETE FROM captures WHERE capture_id = ?', [captureId]);
  try {
    const f = new File(c.imagePath);
    if (f.exists) f.delete();
  } catch { /* the row is gone; a stray file is harmless */ }
}

export async function getCapture(captureId: string): Promise<Capture | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<CaptureRow>('SELECT * FROM captures WHERE capture_id = ?', [captureId]);
  return r ? captureFromRow(r) : null;
}

export async function queueCapture(args: {
  captureId: string;
  eye: Eye;
  cameraDeviceId: string;
  bestEffort: boolean;
  questionnaire: QuestionnairePayload;
  metadata: CaptureMetadataPayload;
  priorityTier: number;
}): Promise<void> {
  const db = await getDb();
  const now = nowIso();
  await db.withExclusiveTransactionAsync(async (tx) => {
    await tx.runAsync(
      'UPDATE captures SET eye = ?, camera_device_id = ?, best_effort = ? WHERE capture_id = ?',
      [args.eye, args.cameraDeviceId, args.bestEffort ? 1 : 0, args.captureId]);
    await tx.runAsync(
      `INSERT INTO questionnaire_responses (response_id, capture_id, risk_factor_fields, symptom_fields, language, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [generateLocalId(), args.captureId, JSON.stringify(args.questionnaire.riskFactors),
      JSON.stringify(args.questionnaire.symptoms), args.questionnaire.language, now]);
    const m = args.metadata;
    await tx.runAsync(
      `INSERT INTO capture_metadata_responses (response_id, capture_id, camera_device_reported, pupil_status,
         lighting_environment, observed_issues, worker_usability_rating, eye_laterality, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [generateLocalId(), args.captureId, m.cameraDeviceReported, m.pupilStatus, m.lightingEnvironment,
      JSON.stringify(m.observedIssues), m.workerUsabilityRating, m.eyeLaterality, now]);
    await tx.runAsync(
      `INSERT INTO sync_queue (capture_id, priority_tier, state, attempts, enqueued_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?)`,
      [args.captureId, args.priorityTier, now, now]);
  });
}

/** Everything central needs for one case, read back from the per-record tables. */
export interface CaseBundle {
  capture: Capture;
  patient: { patientId: string; name: string; age: number; contactNumber: string; consentGivenAt: string | null };
  questionnaire: QuestionnairePayload;
  metadata: CaptureMetadataPayload;
  sync: SyncRow;
}

export async function getCaseBundle(captureId: string): Promise<CaseBundle | null> {
  const db = await getDb();
  const c = await db.getFirstAsync<CaptureRow>('SELECT * FROM captures WHERE capture_id = ?', [captureId]);
  const s = await db.getFirstAsync<SyncDbRow>('SELECT * FROM sync_queue WHERE capture_id = ?', [captureId]);
  if (!c || !s) return null;
  const p = await db.getFirstAsync<{ patient_id: string; name: string; age: number; contact_number: string; consent_given_at: string | null }>(
    'SELECT patient_id, name, age, contact_number, consent_given_at FROM patients WHERE patient_id = ?', [c.patient_id]);
  const q = await db.getFirstAsync<{ risk_factor_fields: string; symptom_fields: string; language: string | null }>(
    'SELECT risk_factor_fields, symptom_fields, language FROM questionnaire_responses WHERE capture_id = ? ORDER BY recorded_at DESC LIMIT 1', [captureId]);
  const m = await db.getFirstAsync<{ camera_device_reported: string; pupil_status: string; lighting_environment: string; observed_issues: string; worker_usability_rating: string; eye_laterality: Eye }>(
    'SELECT * FROM capture_metadata_responses WHERE capture_id = ? ORDER BY recorded_at DESC LIMIT 1', [captureId]);
  if (!p || !q || !m) return null;
  return {
    capture: captureFromRow(c),
    patient: { patientId: p.patient_id, name: p.name, age: p.age, contactNumber: p.contact_number, consentGivenAt: p.consent_given_at },
    questionnaire: { riskFactors: JSON.parse(q.risk_factor_fields), symptoms: JSON.parse(q.symptom_fields), language: q.language },
    metadata: {
      cameraDeviceReported: m.camera_device_reported,
      pupilStatus: m.pupil_status as CaptureMetadataPayload['pupilStatus'],
      lightingEnvironment: m.lighting_environment as CaptureMetadataPayload['lightingEnvironment'],
      observedIssues: JSON.parse(m.observed_issues),
      workerUsabilityRating: m.worker_usability_rating as CaptureMetadataPayload['workerUsabilityRating'],
      eyeLaterality: m.eye_laterality,
    },
    sync: syncFromRow(s),
  };
}

export function lifecycleOf(c: Capture, s: SyncRow | null): { lifecycle: LifecycleStatus; problem: QueueEntry['problem'] } {
  if (!s) return { lifecycle: c.qualityStatus === 'retake' && !c.bestEffort ? 'captured' : 'quality_passed', problem: null };
  if (s.state === 'failed') {
    return { lifecycle: s.summarySentAt ? 'synced' : 'quality_passed', problem: 'upload_failed' };
  }
  if (s.state === 'synced') {
    if (s.centralStatus === 'graded') return { lifecycle: 'result_delivered', problem: null };
    if (s.centralStatus === 'error') return { lifecycle: 'result_pending', problem: 'grading_failed' };
    return { lifecycle: 'result_pending', problem: null };
  }
  const retrying = s.attempts > 0 && !!s.lastErrorCode;
  if (s.state === 'summary_sent') return { lifecycle: 'synced', problem: retrying ? 'retrying' : null };
  return { lifecycle: 'quality_passed', problem: retrying ? 'retrying' : null };
}

export async function listQueue(limit = 300): Promise<QueueEntry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CaptureRow & SyncDbRow & { p_name: string; p_age: number; p_contact: string; s_capture: string | null }>(
    `SELECT c.*, p.name AS p_name, p.age AS p_age, p.contact_number AS p_contact,
            q.capture_id AS s_capture, q.priority_tier, q.state, q.central_case_id, q.central_status,
            q.summary_sent_at, q.uploaded_at, q.attempts, q.next_attempt_at, q.last_attempt_at,
            q.last_error_code, q.last_error, q.enqueued_at
     FROM captures c
     JOIN patients p ON p.patient_id = c.patient_id
     LEFT JOIN sync_queue q ON q.capture_id = c.capture_id
     ORDER BY c.captured_at DESC
     LIMIT ?`, [limit]);
  return rows.map((r) => {
    const capture = captureFromRow(r);
    const sync = r.s_capture ? syncFromRow({ ...r, capture_id: r.s_capture }) : null;
    return {
      capture,
      patient: { patientId: r.patient_id, name: r.p_name, age: r.p_age, contactNumber: r.p_contact },
      sync,
      ...lifecycleOf(capture, sync),
    };
  });
}

export async function getQueueEntry(captureId: string): Promise<QueueEntry | null> {
  const all = await listQueue(1000);
  return all.find((e) => e.capture.captureId === captureId) ?? null;
}


export async function nextDueForUpload(): Promise<string | null> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ capture_id: string; owner_device: string | null }>(
    `SELECT capture_id, owner_device FROM sync_queue
     WHERE state IN ('pending', 'summary_sent')
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY priority_tier ASC, enqueued_at ASC
     LIMIT 50`, [nowIso()]);
  const { ownsUpload } = await import('../peer/replicate');
  for (const r of rows) if (await ownsUpload(r.owner_device)) return r.capture_id;
  return null;
}

/** Synced cases whose grade is not final yet -- polled for status. */
export async function listAwaitingGrade(): Promise<{ captureId: string; caseId: string }[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ capture_id: string; central_case_id: string }>(
    `SELECT capture_id, central_case_id FROM sync_queue
     WHERE state = 'synced' AND central_case_id IS NOT NULL
       AND (central_status IS NULL OR central_status IN ('processing', 'awaiting_image'))
     ORDER BY uploaded_at ASC LIMIT 25`);
  return rows.map((r) => ({ captureId: r.capture_id, caseId: r.central_case_id }));
}

/** Items still waiting for central to ACCEPT them -- the header's "pending" count. */
export async function pendingUploadCount(): Promise<number> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_queue WHERE state <> 'synced'`);
  return r?.n ?? 0;
}

export async function queueSize(): Promise<number> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM sync_queue');
  return r?.n ?? 0;
}

export async function markSummarySent(captureId: string, caseId: string, centralStatus: CentralStatus): Promise<void> {
  const db = await getDb();
  const now = nowIso();
  await db.runAsync(
    `UPDATE sync_queue SET state = 'summary_sent', central_case_id = ?, central_status = ?, summary_sent_at = ?,
       last_error_code = NULL, last_error = NULL, next_attempt_at = NULL, updated_at = ?
     WHERE capture_id = ?`, [caseId, centralStatus, now, now, captureId]);
}

export async function markSynced(captureId: string, caseId: string, centralStatus: CentralStatus): Promise<void> {
  const db = await getDb();
  const now = nowIso();
  await db.runAsync(
    `UPDATE sync_queue SET state = 'synced', central_case_id = ?, central_status = ?, uploaded_at = ?,
       last_error_code = NULL, last_error = NULL, next_attempt_at = NULL, updated_at = ?
     WHERE capture_id = ?`, [caseId, centralStatus, now, now, captureId]);
}

export async function setCentralStatus(captureId: string, status: CentralStatus): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE sync_queue SET central_status = ?, updated_at = ? WHERE capture_id = ?',
    [status, nowIso(), captureId]);
}

/** A transient failure: back off exponentially (30 s .. 30 min) and try again. */
export async function markAttemptFailed(captureId: string, code: string, message: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ attempts: number }>('SELECT attempts FROM sync_queue WHERE capture_id = ?', [captureId]);
  const attempts = (row?.attempts ?? 0) + 1;
  const delayMs = Math.min(30 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 6));
  const now = nowIso();
  await db.runAsync(
    `UPDATE sync_queue SET attempts = ?, last_attempt_at = ?, next_attempt_at = ?, last_error_code = ?, last_error = ?, updated_at = ?
     WHERE capture_id = ?`,
    [attempts, now, new Date(Date.now() + delayMs).toISOString(), code, message, now, captureId]);
}

/** A permanent failure (central rejected the data): stop retrying, surface it. */
export async function markFailed(captureId: string, code: string, message: string): Promise<void> {
  const db = await getDb();
  const now = nowIso();
  await db.runAsync(
    `UPDATE sync_queue SET state = 'failed', attempts = attempts + 1, last_attempt_at = ?, last_error_code = ?, last_error = ?, updated_at = ?
     WHERE capture_id = ?`, [now, code, message, now, captureId]);
}

/** Technician pressed "retry" on a failed or backed-off item. */
export async function resetForRetry(captureId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE sync_queue
     SET state = CASE WHEN summary_sent_at IS NULL THEN 'pending' ELSE 'summary_sent' END,
         next_attempt_at = NULL, updated_at = ?
     WHERE capture_id = ? AND state <> 'synced'`, [nowIso(), captureId]);
}
