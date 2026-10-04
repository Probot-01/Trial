'use strict';


const express = require('express');
const multer = require('multer');

const db = require('../db/localDb');
const { handleCapture, recheckCapture, markBestEffort } = require('../services/captureHandler');
const { generateLocalId } = require('../services/ids');

const router = express.Router();


const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },   // fundus images run 1-10 MB
  fileFilter(req, file, cb) {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error(`Expected an image, got ${file.mimetype}`),
      { code: 'NOT_AN_IMAGE' }));
  },
});

// ── Contract enums (api-contracts.md) ────────────────────────────────────────
const YEARS_SINCE_DIAGNOSIS = ['lt1', '1to5', '5to10', 'gt10'];
const GLYCEMIC_CONTROL = ['good', 'moderate', 'poor'];
const BLOOD_PRESSURE = ['normal', 'high', 'unknown'];
const SYMPTOM_FIELDS = ['blurredVision', 'floaters', 'suddenVisionChange', 'eyePain'];

const PUPIL_STATUS = ['dilated', 'non_dilated', 'unknown'];
const LIGHTING_ENVIRONMENT = ['indoor_clinic', 'outdoor_mobile', 'low_light'];
const OBSERVED_ISSUES = ['glare', 'blink_or_moved', 'out_of_focus',
  'media_opacity', 'eyelash_obstruction', 'none_noticed'];
const USABILITY_RATING = ['clear', 'not_sure', 'clearly_unusable'];

const bad = (res, error, message) => res.status(400).json({ error, message });


function numOrNull(v, min, max) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function checkEnum(res, field, value, allowed, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (!required) return true;
    bad(res, 'missing_field', `${field} is required.`);
    return false;
  }
  if (!allowed.includes(value)) {
    bad(res, 'invalid_field',
      `${field} must be one of: ${allowed.join(', ')} — got '${value}'.`);
    return false;
  }
  return true;
}

function captureExists(captureId) {
  return !!db.prepare('SELECT capture_id FROM captures WHERE capture_id = ?').get(captureId);
}


function sendCaptureError(res, err, patientId) {
  if (err.message.includes('patient_not_found')) {
    res.status(404).json({
      error: 'patient_not_found',
      message: `No patient with id ${patientId}`,
    });
    return true;
  }
  if (err.message.startsWith('quality_gate_busy')) {
    res.status(409).json({
      error: 'quality_gate_busy',
      message: 'The quality check for this capture is already running.',
      captureId: err.captureId,
    });
    return true;
  }
  if (err.message.startsWith('quality_gate_failed')) {

    const detail = err.message.replace(/^quality_gate_failed:\s*/, '').slice(0, 300);
    res.status(503).json({
      error: 'quality_gate_failed',
      message: 'The image was saved but the quality check could not run. '
        + 'Check that MATLAB (or the compiled quality gate) is available, then re-run the check. '
        + `Detail: ${detail}`,
      captureId: err.captureId,
    });
    return true;
  }
  return false;
}

// ── POST /captures ───────────────────────────────────────────────────────────
router.post('/', upload.single('image'), async (req, res, next) => {
  const { patientId, cameraDeviceId } = req.body || {};

  if (!patientId) return bad(res, 'patient_id_required', 'patientId is required.');
  if (!req.file) return bad(res, 'image_required', 'An image file is required.');

  try {
    const result = await handleCapture(
      patientId, req.file, cameraDeviceId || 'unknown');
    res.status(201).json(result);
  } catch (err) {
    if (sendCaptureError(res, err, patientId)) return;
    next(err);
  }
});

router.post('/:captureId/quality-check', async (req, res, next) => {
  if (!captureExists(req.params.captureId)) {
    return res.status(404).json({
      error: 'capture_not_found', message: `No capture with id ${req.params.captureId}`,
    });
  }
  try {
    res.json(await recheckCapture(req.params.captureId));
  } catch (err) {
    if (sendCaptureError(res, err)) return;
    next(err);
  }
});


router.post('/:captureId/best-effort', (req, res, next) => {
  const { captureId } = req.params;
  if (!captureExists(captureId)) {
    return res.status(404).json({
      error: 'capture_not_found', message: `No capture with id ${captureId}`,
    });
  }
  try {
    res.json(markBestEffort(captureId));
  } catch (err) {
    if (err.code === 'best_effort_not_applicable') {
      return bad(res, 'best_effort_not_applicable', err.message);
    }
    next(err);
  }
});

router.post('/mobile', upload.single('image'), async (req, res, next) => {
  const { patientId } = req.body || {};

  if (!patientId) return bad(res, 'patient_id_required', 'patientId is required.');
  if (!req.file) return bad(res, 'image_required', 'An image file is required.');

  try {
    const result = await handleCapture(patientId, req.file, 'mobile_lens');
    res.status(201).json(result);
  } catch (err) {
    if (sendCaptureError(res, err, patientId)) return;
    next(err);
  }
});

// ── POST /captures/:captureId/questionnaire ──────────────────────────────────
// Patient symptom + risk answers (design doc §9.1) — about the PATIENT.
router.post('/:captureId/questionnaire', (req, res) => {
  const { captureId } = req.params;
  const { riskFactors, symptoms, language } = req.body || {};

  if (!captureExists(captureId)) {
    return res.status(404).json({
      error: 'capture_not_found', message: `No capture with id ${captureId}`,
    });
  }
  if (!riskFactors || typeof riskFactors !== 'object') {
    return bad(res, 'missing_field', 'riskFactors object is required.');
  }
  if (!symptoms || typeof symptoms !== 'object') {
    return bad(res, 'missing_field', 'symptoms object is required.');
  }

  if (!checkEnum(res, 'riskFactors.yearsSinceDiagnosis',
    riskFactors.yearsSinceDiagnosis, YEARS_SINCE_DIAGNOSIS)) return;
  if (!checkEnum(res, 'riskFactors.glycemicControl',
    riskFactors.glycemicControl, GLYCEMIC_CONTROL)) return;
  if (!checkEnum(res, 'riskFactors.bloodPressure',
    riskFactors.bloodPressure, BLOOD_PRESSURE)) return;

  // pregnant is boolean | null — null meaning not applicable / not asked, which
  // is a genuinely different answer from false and must stay distinguishable.
  const pregnant = riskFactors.pregnant;
  if (pregnant !== null && pregnant !== undefined && typeof pregnant !== 'boolean') {
    return bad(res, 'invalid_field',
      'riskFactors.pregnant must be true, false, or null (null = not applicable).');
  }

  for (const field of SYMPTOM_FIELDS) {
    if (typeof symptoms[field] !== 'boolean') {
      return bad(res, 'invalid_field', `symptoms.${field} must be a boolean.`);
    }
  }

  const responseId = generateLocalId();

  db.prepare(`
    INSERT INTO questionnaire_responses
      (response_id, capture_id, risk_factor_fields, symptom_fields, language, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    responseId,
    captureId,
    // The columns are TEXT, so the nested objects are stringified here. The
    // central side stores the same payloads as real JSONB.
    JSON.stringify({
      yearsSinceDiagnosis: riskFactors.yearsSinceDiagnosis,
      glycemicControl: riskFactors.glycemicControl,
      bloodPressure: riskFactors.bloodPressure,
      pregnant: pregnant === undefined ? null : pregnant,

      hba1c: numOrNull(riskFactors.hba1c, 4, 20),
      yearsDiabetic: numOrNull(riskFactors.yearsDiabetic, 0, 80),
    }),
    JSON.stringify(Object.fromEntries(SYMPTOM_FIELDS.map((f) => [f, symptoms[f]]))),
    language || null,
    new Date().toISOString(),
  );

  res.status(201).json({ responseId, captureId });
});


router.post('/:captureId/capture-metadata', (req, res) => {
  const { captureId } = req.params;
  const {
    cameraDeviceReported, pupilStatus, lightingEnvironment,
    observedIssues, workerUsabilityRating, eyeLaterality,
  } = req.body || {};

  if (!captureExists(captureId)) {
    return res.status(404).json({
      error: 'capture_not_found', message: `No capture with id ${captureId}`,
    });
  }

  if (!checkEnum(res, 'pupilStatus', pupilStatus, PUPIL_STATUS)) return;
  if (!checkEnum(res, 'lightingEnvironment', lightingEnvironment, LIGHTING_ENVIRONMENT)) return;
  if (!checkEnum(res, 'workerUsabilityRating', workerUsabilityRating, USABILITY_RATING)) return;

  if (eyeLaterality !== undefined && eyeLaterality !== null &&
    !['left', 'right'].includes(eyeLaterality)) {
    return bad(res, 'invalid_field', "eyeLaterality must be 'left' or 'right'.");
  }

  if (!Array.isArray(observedIssues)) {
    return bad(res, 'invalid_field', 'observedIssues must be an array.');
  }
  for (const issue of observedIssues) {
    if (!OBSERVED_ISSUES.includes(issue)) {
      return bad(res, 'invalid_field',
        `observedIssues entries must be one of: ${OBSERVED_ISSUES.join(', ')} — got '${issue}'.`);
    }
  }

  if (observedIssues.includes('none_noticed') && observedIssues.length > 1) {
    return bad(res, 'invalid_field',
      "observedIssues: 'none_noticed' must be the only element when present.");
  }

  const responseId = generateLocalId();

  db.prepare(`
    INSERT INTO capture_metadata_responses
      (response_id, capture_id, camera_device_reported, pupil_status,
       lighting_environment, observed_issues, worker_usability_rating, recorded_at,
       eye_laterality)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    responseId, captureId,
    cameraDeviceReported || null,
    pupilStatus, lightingEnvironment,
    JSON.stringify(observedIssues),
    workerUsabilityRating,
    new Date().toISOString(),
    eyeLaterality || null,
  );

  res.status(201).json({ responseId, captureId });
});


router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT c.capture_id, c.patient_id, p.name AS patient_name,
           c.quality_status, c.quality_reason, c.captured_at, c.best_effort,
           q.status AS sync_status, q.central_status, q.last_error, q.error_kind,
           q.attempts, q.next_attempt_at, q.chunks_sent, q.chunks_total,
           EXISTS (SELECT 1 FROM questionnaire_responses qr WHERE qr.capture_id = c.capture_id) AS has_questionnaire,
           EXISTS (SELECT 1 FROM capture_metadata_responses cm WHERE cm.capture_id = c.capture_id) AS has_metadata
    FROM captures c
    JOIN patients p ON p.patient_id = c.patient_id
    LEFT JOIN sync_queue q ON q.capture_id = c.capture_id
    ORDER BY c.captured_at DESC
    LIMIT 500
  `).all();

  res.json(rows.map((r) => ({
    captureId: r.capture_id,
    patientId: r.patient_id,
    patientName: r.patient_name,
    status: lifecycleStatus(r),
    capturedAt: r.captured_at,

    qualityStatus: r.quality_status === 'pending' ? null : r.quality_status,
    qualityReason: r.quality_reason ?? null,

    bestEffort: !!r.best_effort,

    formsComplete: !!(r.has_questionnaire && r.has_metadata),

    centralStatus: r.central_status ?? null,

    syncError: r.sync_status === 'pending' && r.last_error
      ? { kind: r.error_kind, message: r.last_error, attempts: r.attempts, nextAttemptAt: r.next_attempt_at ?? null }
      : null,
    // Progress of a chunked upload in flight or interrupted (null for small images).
    uploadProgress: r.sync_status === 'pending' && r.chunks_total > 1
      ? { sent: r.chunks_sent, total: r.chunks_total }
      : null,
  })));
});


function lifecycleStatus(row) {
  if (row.sync_status === 'synced') {
    if (row.central_status === 'graded') return 'result_delivered';
    if (row.central_status === 'processing' || row.central_status === 'awaiting_image') {
      return 'result_pending';
    }
    return 'synced';
  }

  if (row.quality_status === 'pass' || row.quality_status === 'borderline' || row.best_effort) {
    return 'quality_passed';
  }

  return 'captured';
}


router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig ? 'image_too_large' : 'upload_failed',
      message: tooBig ? 'Image exceeds the 25 MB limit.' : err.message,
    });
  }
  if (err && err.code === 'NOT_AN_IMAGE') {
    return bad(res, 'invalid_image_type', err.message);
  }
  next(err);
});

module.exports = router;
