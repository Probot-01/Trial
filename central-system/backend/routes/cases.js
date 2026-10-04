'use strict';



const express = require('express');
const multer = require('multer');

const ingestion = require('../services/ingestionService');
const gradingQueue = require('../services/gradingQueue');
const { handleConfirmedReferral } = require('../services/referralNotificationService');
const pool = require('../db/pgClient');
const cfg = require('../services/authConfig');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { requirePhcApiKey, requireUserOrPhc } = require('../middleware/requirePhcApiKey');
const { logAccess } = require('../services/accessLog');
const datasetCollector = require('../services/datasetCollector');

const router = express.Router();

const anyUser = [requireAuth, requireRole('ophthalmologist', 'district_admin')];
const ophthalmologist = [requireAuth, requireRole('ophthalmologist')];


function pinPhc(req, res) {
  if (!req.phc) return true;
  const claimed = req.body && req.body.phcId;
  if (claimed && claimed !== req.phc.phcId) {
    res.status(403).json({
      error: 'phc_mismatch',
      message: `This API key belongs to PHC ${req.phc.phcId}, but the request names ${claimed}.`,
    });
    return false;
  }
  if (req.body) req.body.phcId = req.phc.phcId;
  return true;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error(`Expected an image, got ${file.mimetype}`),
      { code: 'NOT_AN_IMAGE' }));
  },
});


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = (res, caseId) => res.status(404).json({
  error: 'case_not_found', message: `No case with id ${caseId}`,
});

// ── POST /api/v1/cases ───────────────────────────────────────────────────────
router.post('/', requirePhcApiKey, upload.single('image'), async (req, res, next) => {
  if (!pinPhc(req, res)) return;
  let caseId;
  try {
    const result = await ingestion.ingestCase({ ...req.body, imageFile: req.file });
    caseId = result.caseId;

    e.
      if(result.duplicate) return res.status(200).json(result);

    gradingQueue.enqueue(caseId);

    res.status(201).json(result);
  } catch (err) {
    if (err.code === 'patient_not_found') {
      return res.status(404).json({ error: err.code, message: err.message });
    }
    if (err.status === 400 || err.code === 'invalid_json') {
      return res.status(400).json({ error: err.code || 'bad_request', message: err.message });
    }
    next(err);
  }
});

router.post('/summary', requirePhcApiKey, async (req, res, next) => {
  if (!pinPhc(req, res)) return;
  try {
    const result = await ingestion.ingestSummary(req.body || {});
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    if (err.code === 'patient_not_found') {
      return res.status(404).json({ error: err.code, message: err.message });
    }
    if (err.status === 400 || err.code === 'invalid_json') {
      return res.status(400).json({ error: err.code || 'bad_request', message: err.message });
    }
    next(err);
  }
});



const chunked = require('../services/chunkedUploadService');

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: chunked.MAX_CHUNK_BYTES },
});



function sendUploadError(res, err, next) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  return next(err);
}

router.post('/:captureRef/chunks/init', requirePhcApiKey, async (req, res, next) => {
  try {
    if (!pinPhc(req, res)) return;
    res.status(201).json(await chunked.initSession(req.params.captureRef, req.body || {}));
  } catch (err) { sendUploadError(res, err, next); }
});

router.post('/:captureRef/chunks/complete', requirePhcApiKey, async (req, res, next) => {
  try {
    const result = await chunked.completeSession(req.params.captureRef);

    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) { sendUploadError(res, err, next); }
});

router.get('/:captureRef/chunks', requirePhcApiKey, (req, res, next) => {
  try {
    const session = chunked.getSession(req.params.captureRef);
    if (!session) {
      return res.status(404).json({
        error: 'session_not_found',
        message: `No upload session for ${req.params.captureRef}.`,
      });
    }
    res.json(session);
  } catch (err) { sendUploadError(res, err, next); }
});

router.post('/:captureRef/chunks/:index', requirePhcApiKey, chunkUpload.single('chunk'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'empty_chunk', message: "Send the chunk bytes as the 'chunk' field.",
      });
    }
    const result = await chunked.putChunk(
      req.params.captureRef, req.params.index, req.file.buffer,
      req.body?.sha256 || req.get('x-chunk-sha256'));
    res.json(result);
  } catch (err) { sendUploadError(res, err, next); }
});


router.get('/:caseId/status', requireUserOrPhc, async (req, res, next) => {

  const { caseId } = req.params;
  if (!UUID_RE.test(caseId)) return notFound(res, caseId);
  try {
    const status = await ingestion.getCaseStatus(caseId);
    if (!status) return notFound(res, caseId);
    res.json(status);
  } catch (err) { next(err); }
});

// ── GET /api/v1/cases/:caseId ────────────────────────────────────────────────
router.get('/:caseId', anyUser, async (req, res, next) => {
  const { caseId } = req.params;
  if (!UUID_RE.test(caseId)) return notFound(res, caseId);
  try {
    const detail = await ingestion.getCaseDetail(caseId);
    if (!detail) return notFound(res, caseId);
    await logAccess(req.user?.userId, 'view_case', 'case', caseId);
    res.json(detail);
  } catch (err) { next(err); }
});

// ── POST /api/v1/cases/:caseId/review  (Task 3.5) ────────────────────────────
const DECISIONS = ['confirm', 'override'];
const OVERRIDE_CATEGORIES = ['artifact_misread', 'lesion_missed',
  'wrong_severity', 'image_quality_issue'];

router.post('/:caseId/review', ophthalmologist, async (req, res, next) => {
  const { caseId } = req.params;
  const {
    decision, overrideReasonCategory, overrideReasonText, reviewDurationSeconds,
    correctedGrade,
  } = req.body || {};


  const reviewerId = req.user?.userId || req.body?.ophthalmologistId || null;

  if (!UUID_RE.test(caseId)) return notFound(res, caseId);

  if (correctedGrade !== undefined && correctedGrade !== null &&
    !(Number.isInteger(correctedGrade) && correctedGrade >= 0 && correctedGrade <= 4)) {
    return res.status(400).json({
      error: 'invalid_field', message: 'correctedGrade must be an integer 0-4.',
    });
  }

  if (!DECISIONS.includes(decision)) {
    return res.status(400).json({
      error: 'invalid_field',
      message: `decision must be one of: ${DECISIONS.join(', ')}.`,
    });
  }

  if (decision === 'confirm' && overrideReasonCategory) {
    return res.status(400).json({
      error: 'invalid_field',
      message: "overrideReasonCategory must be null when decision is 'confirm'.",
    });
  }
  if (decision === 'override' && !OVERRIDE_CATEGORIES.includes(overrideReasonCategory)) {
    return res.status(400).json({
      error: 'invalid_field',
      message: `overrideReasonCategory must be one of: ${OVERRIDE_CATEGORIES.join(', ')}.`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const exists = await client.query('SELECT 1 FROM cases WHERE case_id = $1', [caseId]);
    if (!exists.rows.length) {
      await client.query('ROLLBACK');
      return notFound(res, caseId);
    }

    // FOR UPDATE: a concurrent claim on this case waits for this review to land
    // rather than interleaving with the checks below.
    const graded = await client.query(`
      SELECT branch_agreement, claimed_by, claimed_at,
             claimed_at > now() - make_interval(mins => $2) AS claim_live
      FROM grading_results WHERE case_id = $1 FOR UPDATE
    `, [caseId, cfg.CLAIM_TTL_MINUTES]);
    const g = graded.rows[0];

    if (!g) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'case_not_graded',
        message: 'This case has no grading result yet, so there is nothing to review.',
      });
    }

    if (g.claimed_by && g.claim_live && req.user && g.claimed_by !== req.user.userId) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'case_claimed',
        message: 'Another reviewer holds this case. Claim it first once their claim expires.',
        claimedBy: g.claimed_by,
        claimedAt: g.claimed_at.toISOString(),
      });
    }

    if (g.branch_agreement === false) {
      if (decision === 'confirm' || !Number.isInteger(correctedGrade)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'explicit_grade_required',
          message: 'Branch A and Branch B disagree on this case. Submit an override ' +
            'with correctedGrade (0-4); a plain confirm is not accepted.',
        });
      }
    }

    const inserted = await client.query(`
      INSERT INTO ophthalmologist_reviews
        (case_id, ophthalmologist_id, decision,
         override_reason_category, override_reason_text, review_duration_seconds,
         corrected_grade)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING review_id
    `, [caseId, reviewerId, decision,
      decision === 'override' ? overrideReasonCategory : null,
      overrideReasonText || null,
      Number.isInteger(reviewDurationSeconds) ? reviewDurationSeconds : null,
      decision === 'override' && Number.isInteger(correctedGrade) ? correctedGrade : null]);

    const reviewId = inserted.rows[0].review_id;


    if (decision === 'override') {
      await client.query(
        'INSERT INTO corrections (case_id, review_id) VALUES ($1, $2)', [caseId, reviewId]);
    }


    await datasetCollector.recordLabel(client, {
      caseId, reviewId, decision, reviewerId,
      correctedGrade: Number.isInteger(correctedGrade) ? correctedGrade : undefined,
    });

    await client.query('COMMIT');

    await logAccess(req.user?.userId, 'submit_review', 'case', caseId);

    let referral = null;
    try {
      referral = await handleConfirmedReferral(caseId, {

        correctedGrade: Number.isInteger(req.body?.correctedGrade)
          ? req.body.correctedGrade : undefined,
      });
    } catch (err) {
      console.error(`[cases] referral handling failed for ${caseId}:`, err.message);
    }

    res.json({
      reviewId,
      referralId: referral?.referralId ?? null,
      smsStatus: referral?.sms?.status ?? null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/:caseId/claim', ophthalmologist, async (req, res, next) => {
  const { caseId } = req.params;
  if (!UUID_RE.test(caseId)) return notFound(res, caseId);
  if (!req.user) {
    return res.status(401).json({
      error: 'unauthenticated', message: 'Log in to claim a case for review.',
    });
  }

  const shape = (row) => ({
    caseId,
    claimedBy: { userId: row.claimed_by, name: row.claimant_name ?? null },
    claimedAt: row.claimed_at.toISOString(),
    expiresAt: new Date(row.claimed_at.getTime() + cfg.CLAIM_TTL_MINUTES * 60000).toISOString(),
  });

  try {
    const { rows } = await pool.query(`
      UPDATE grading_results g
      SET claimed_by = $2, claimed_at = now()
      WHERE g.case_id = $1
        AND (g.claimed_by IS NULL
             OR g.claimed_by = $2
             OR g.claimed_at <= now() - make_interval(mins => $3))
      RETURNING g.claimed_by, g.claimed_at,
                (SELECT name FROM users WHERE user_id = g.claimed_by) AS claimant_name
    `, [caseId, req.user.userId, cfg.CLAIM_TTL_MINUTES]);

    if (rows.length) {
      await logAccess(req.user.userId, 'claim_case', 'case', caseId);
      return res.json(shape(rows[0]));
    }

    const held = await pool.query(`
      SELECT g.claimed_by, g.claimed_at, u.name AS claimant_name
      FROM grading_results g LEFT JOIN users u ON u.user_id = g.claimed_by
      WHERE g.case_id = $1
    `, [caseId]);
    if (!held.rows.length) {
      const exists = await pool.query('SELECT 1 FROM cases WHERE case_id = $1', [caseId]);
      if (!exists.rows.length) return notFound(res, caseId);
      return res.status(409).json({
        error: 'case_not_graded', message: 'This case has not been graded yet.',
      });
    }
    return res.status(409).json({
      error: 'case_claimed',
      message: `${held.rows[0].claimant_name || 'Another reviewer'} is reviewing this case.`,
      ...shape(held.rows[0]),
    });
  } catch (err) { next(err); }
});


const caseReport = require('../services/caseReport');
router.get('/:caseId/report', anyUser, async (req, res, next) => {
  const { caseId } = req.params;
  if (!UUID_RE.test(caseId)) return notFound(res, caseId);
  try {
    const out = await caseReport.getOrCreateReport(caseId, {
      force: req.query.regenerate === '1' || req.query.regenerate === 'true',
    });
    if (!out) return notFound(res, caseId);
    if (out.error === 'case_not_graded') {
      return res.status(409).json({
        error: 'case_not_graded', message: 'A report can only be generated once the case is graded.',
      });
    }
    await logAccess(req.user?.userId, 'view_report', 'case', caseId);
    res.json(out);
  } catch (err) {

    console.error(`[cases] report for ${caseId} failed:`, err.message);
    res.status(502).json({
      error: 'report_generation_failed',
      message: 'The evidence report could not be generated on the server. '
        + 'The grade and evidence on this screen are unaffected; an administrator can find the cause in the server log.',
    });
  }
});


router.get('/:caseId/reviews', anyUser, async (req, res, next) => {
  const { caseId } = req.params;
  if (!UUID_RE.test(caseId)) return notFound(res, caseId);
  try {
    const exists = await pool.query('SELECT 1 FROM cases WHERE case_id = $1', [caseId]);
    if (!exists.rows.length) return notFound(res, caseId);

    const { rows } = await pool.query(`
      SELECT r.review_id, r.decision, r.override_reason_category, r.override_reason_text,
             r.corrected_grade, r.review_duration_seconds, r.reviewed_at,
             r.ophthalmologist_id, u.user_id, u.name AS reviewer_name
      FROM ophthalmologist_reviews r
      LEFT JOIN users u ON u.user_id::text = r.ophthalmologist_id
      WHERE r.case_id = $1
      ORDER BY r.reviewed_at DESC
    `, [caseId]);

    await logAccess(req.user?.userId, 'view_reviews', 'case', caseId);

    res.json(rows.map((r) => ({
      reviewId: r.review_id,
      decision: r.decision,
      overrideReasonCategory: r.override_reason_category ?? null,
      overrideReasonText: r.override_reason_text ?? null,
      correctedGrade: r.corrected_grade ?? null,
      reviewDurationSeconds: r.review_duration_seconds ?? null,
      reviewedAt: r.reviewed_at.toISOString(),
      reviewer: r.user_id ? { userId: r.user_id, name: r.reviewer_name } : null,
      ophthalmologistId: r.ophthalmologist_id ?? null,
    })));
  } catch (err) { next(err); }
});

// ── Upload errors ────────────────────────────────────────────────────────────
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig ? 'image_too_large' : 'upload_failed',
      message: tooBig ? 'Image exceeds the 25 MB limit.' : err.message,
    });
  }
  if (err && err.code === 'NOT_AN_IMAGE') {
    return res.status(400).json({ error: 'invalid_image_type', message: err.message });
  }
  next(err);
});

module.exports = router;
