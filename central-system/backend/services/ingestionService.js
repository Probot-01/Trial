'use strict';



const fs = require('fs');
const path = require('path');

const pool = require('../db/pgClient');
const mediaPaths = require('./mediaPaths');
const mediaCrypto = require('./mediaCrypto');
const cfg = require('./authConfig');
const lesionCounts = require('./lesionCounts');
const engineProvenance = require('./engineProvenance');


const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.dcm']);

function parseJsonField(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    const e = new Error(`${fieldName} is not valid JSON: ${err.message}`);
    e.code = 'invalid_json';
    throw e;
  }
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';

function randomReference() {
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  }
  return `PT-${s}`;
}

async function ensurePatientReference(client, patientId) {
  const { rows } = await client.query(
    'SELECT patient_reference FROM patients WHERE patient_id = $1', [patientId]);
  if (rows.length && rows[0].patient_reference) return rows[0].patient_reference;

  for (let attempt = 0; attempt < 20; attempt++) {
    const ref = randomReference();

    await client.query('SAVEPOINT ref_attempt');
    try {
      await client.query(
        'UPDATE patients SET patient_reference = $1 WHERE patient_id = $2', [ref, patientId]);
      await client.query('RELEASE SAVEPOINT ref_attempt');
      return ref;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT ref_attempt');
      if (err.code !== '23505') throw err;   // 23505 = unique_violation
    }
  }
  throw new Error('ensurePatientReference: could not allocate a unique reference');
}


function readQualityGateEngine(value) {
  const raw = parseJsonField(value, 'qualityGateEngine');
  if (raw === null) return null;
  const entry = engineProvenance.normaliseEngineEntry(raw, engineProvenance.QUALITY_GATE_ENGINES);
  if (!entry) {
    throw badRequest('invalid_field', 'qualityGateEngine must be '
      + '{ "engine": "matlab" | "python" | "js-fallback" | "js-device", "fallback": boolean, "detail": string|null }.');
  }
  return entry;
}

function readCaseFields(fields) {
  const { patientId } = fields;
  if (!patientId) throw badRequest('patient_id_required', 'patientId is required.');


  let consentGivenAt = null;
  if (fields.consentGivenAt !== undefined && fields.consentGivenAt !== null &&
    fields.consentGivenAt !== '') {
    const t = new Date(fields.consentGivenAt);
    if (Number.isNaN(t.getTime())) {
      throw badRequest('invalid_field', 'consentGivenAt must be an ISO-8601 timestamp.');
    }
    consentGivenAt = t.toISOString();
  }

  const pendingCount = fields.pendingCount;

  return {
    patientId,
    phcId: fields.phcId || null,
    captureIdRef: fields.captureIdRef || null,
    cameraDeviceId: fields.cameraDeviceId || null,
    capturedAt: fields.capturedAt || null,
    consentGivenAt,

    questionnaireData: parseJsonField(fields.questionnaireData, 'questionnaireData'),
    captureMetadata: parseJsonField(fields.captureMetadata, 'captureMetadata'),
    qualityScores: parseJsonField(fields.qualityScores, 'qualityScores'),
    qualityGateEngine: readQualityGateEngine(fields.qualityGateEngine),
    pendingCount: pendingCount === undefined || pendingCount === null || pendingCount === ''
      ? null : parseInt(pendingCount, 10),
    patientName: fields.patientName,
    patientAge: fields.patientAge,
    patientContactNumber: fields.patientContactNumber,
  };
}

/** 'left' | 'right' | null from the capture metadata's eyeLaterality (§10.4). */
function reportedLaterality(captureMetadata) {
  const v = captureMetadata && captureMetadata.eyeLaterality;
  return v === 'left' || v === 'right' ? v : null;
}


async function ensurePatient(client, f) {
  const known = await client.query(
    'SELECT patient_id FROM patients WHERE patient_id = $1', [f.patientId]);

  if (known.rows.length === 0) {
    if (!f.patientName || f.patientAge === undefined || !f.patientContactNumber) {
      throw badRequest('patient_not_found',
        `Patient ${f.patientId} is not known centrally. Send patientName, ` +
        'patientAge and patientContactNumber with the case to register them.');
    }

    const age = parseInt(f.patientAge, 10);
    if (!Number.isInteger(age) || age < 0 || age > 130) {
      throw badRequest('invalid_field',
        `patientAge must be an integer between 0 and 130 — got '${f.patientAge}'.`);
    }
    await client.query(`
      INSERT INTO patients (patient_id, name, age, contact_number, registered_at,
                            consent_given_at)
      VALUES ($1, $2, $3, $4, now(), $5)
      ON CONFLICT (patient_id) DO NOTHING
    `, [f.patientId, f.patientName, age, f.patientContactNumber, f.consentGivenAt]);
  } else if (f.consentGivenAt) {

    await client.query(`
      UPDATE patients SET consent_given_at = COALESCE(consent_given_at, $2)
      WHERE patient_id = $1
    `, [f.patientId, f.consentGivenAt]);
  }

  await ensurePatientReference(client, f.patientId);
}


async function touchPhc(client, f, { fullSync }) {
  if (!f.phcId) return;
  if (fullSync) {
    await client.query(`
      UPDATE phc_sites
      SET last_sync_at = now(), last_contact_at = now(),
          pending_count = COALESCE($2, pending_count)
      WHERE phc_id = $1
    `, [f.phcId, f.pendingCount]);
  } else {
    await client.query('UPDATE phc_sites SET last_contact_at = now() WHERE phc_id = $1',
      [f.phcId]);
  }
}

/** Resolves the upload into { buffer, ext }, before any DB work. */
function readImage(imageFile) {
  if (!imageFile) throw badRequest('image_required', 'An image file is required.');

  let buffer, sourceName;
  if (typeof imageFile === 'string') {
    if (!fs.existsSync(imageFile)) {
      throw badRequest('image_not_found', `No image at ${imageFile}`);
    }
    buffer = fs.readFileSync(imageFile); sourceName = imageFile;
  } else if (imageFile.buffer) {
    buffer = imageFile.buffer; sourceName = imageFile.originalname || '.jpg';
  } else if (imageFile.path) {
    buffer = fs.readFileSync(imageFile.path);
    sourceName = imageFile.originalname || imageFile.path;
  } else {
    throw badRequest('image_required', 'imageFile must be a path or a multer file object.');
  }

  let ext = path.extname(sourceName).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    if (ext) throw badRequest('invalid_image_type', `Unsupported image type '${ext}'.`);
    ext = '.jpg';
  }
  return { buffer, ext };
}


async function ingestCase(fields) {
  const f = readCaseFields(fields);

  const { buffer, ext } = readImage(fields.imageFile);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensurePatient(client, f);


    const inserted = await client.query(`
      INSERT INTO cases
        (patient_id, phc_id, capture_id_ref, camera_device_id, image_path,
         questionnaire_data, capture_metadata, status, captured_at, quality_scores,
         eye_laterality_reported, processing_started_at, quality_gate_engine)
      VALUES ($1, $2, $3, $4, '', $5, $6, 'processing', $7, $8, $9, now(), $10)
      ON CONFLICT (capture_id_ref) DO NOTHING
      RETURNING case_id, received_at
    `, [f.patientId, f.phcId, f.captureIdRef, f.cameraDeviceId,
    f.questionnaireData, f.captureMetadata,

    f.capturedAt || new Date().toISOString(), f.qualityScores,
    reportedLaterality(f.captureMetadata), f.qualityGateEngine]);

    let caseId, receivedAt, fromSummary = false;

    if (inserted.rows.length) {
      caseId = inserted.rows[0].case_id;
      receivedAt = inserted.rows[0].received_at;
    } else {
      const existing = (await client.query(`
        SELECT case_id, status, received_at FROM cases
        WHERE capture_id_ref = $1 FOR UPDATE
      `, [f.captureIdRef])).rows[0];

      if (existing.status !== 'awaiting_image') {

        await touchPhc(client, f, { fullSync: false });
        await client.query('COMMIT');
        return {
          caseId: existing.case_id,
          receivedAt: existing.received_at.toISOString(),
          status: existing.status,
          duplicate: true,
          fromSummary: false,
        };
      }

      caseId = existing.case_id;
      receivedAt = existing.received_at;
      fromSummary = true;

      const summaryImagePath = mediaPaths.originalPath(caseId, ext);
      mediaCrypto.writeFile(summaryImagePath, buffer);   // encrypted at rest when MEDIA_ENCRYPTION_KEY is set
      await client.query(`
        UPDATE cases
        SET status             = 'processing',
            -- NOT received_at: this row may have been created by a summary
            -- packet days ago (§C). The watchdog and the stuck-job check
            -- measure from here.
            processing_started_at = now(),
            image_path         = $8,
            phc_id             = COALESCE(phc_id, $2),
            camera_device_id   = COALESCE($3, camera_device_id),
            questionnaire_data = COALESCE($4, questionnaire_data),
            capture_metadata   = COALESCE($5, capture_metadata),
            captured_at        = COALESCE($6, captured_at),
            quality_scores     = COALESCE($7, quality_scores),
            eye_laterality_reported = COALESCE($9, eye_laterality_reported),
            quality_gate_engine = COALESCE($10, quality_gate_engine)
        WHERE case_id = $1
      `, [caseId, f.phcId, f.cameraDeviceId, f.questionnaireData, f.captureMetadata,
        f.capturedAt, f.qualityScores, summaryImagePath,
        reportedLaterality(f.captureMetadata), f.qualityGateEngine]);
    }

    if (!fromSummary) {
      const imagePath = mediaPaths.originalPath(caseId, ext);
      mediaCrypto.writeFile(imagePath, buffer);   // encrypted at rest when MEDIA_ENCRYPTION_KEY is set
      await client.query('UPDATE cases SET image_path = $1 WHERE case_id = $2',
        [imagePath, caseId]);
    }

    await touchPhc(client, f, { fullSync: true });
    await client.query('COMMIT');

    return {
      caseId, receivedAt: receivedAt.toISOString(),
      status: 'processing', duplicate: false, fromSummary,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


async function ingestSummary(fields) {
  const f = readCaseFields(fields);
  if (!f.captureIdRef) {
    throw badRequest('capture_id_required',
      'captureIdRef is required on a summary: it is how the image upload finds this case.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensurePatient(client, f);

    const inserted = await client.query(`
      INSERT INTO cases
        (patient_id, phc_id, capture_id_ref, camera_device_id, image_path,
         questionnaire_data, capture_metadata, status, captured_at, quality_scores,
         eye_laterality_reported, quality_gate_engine)
      VALUES ($1, $2, $3, $4, NULL, $5, $6, 'awaiting_image', $7, $8, $9, $10)
      ON CONFLICT (capture_id_ref) DO NOTHING
      RETURNING case_id, received_at, status
    `, [f.patientId, f.phcId, f.captureIdRef, f.cameraDeviceId,
    f.questionnaireData, f.captureMetadata,
    f.capturedAt || new Date().toISOString(), f.qualityScores,
    reportedLaterality(f.captureMetadata), f.qualityGateEngine]);

    let row = inserted.rows[0];
    const duplicate = !row;
    if (duplicate) {
      row = (await client.query(
        'SELECT case_id, received_at, status FROM cases WHERE capture_id_ref = $1',
        [f.captureIdRef])).rows[0];
    }

    await touchPhc(client, f, { fullSync: false });
    await client.query('COMMIT');

    return {
      caseId: row.case_id, receivedAt: row.received_at.toISOString(),
      status: row.status, duplicate,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


async function findCaseByCaptureRef(captureIdRef) {
  if (!captureIdRef) return null;
  const { rows } = await pool.query(
    'SELECT case_id, status FROM cases WHERE capture_id_ref = $1', [captureIdRef]);
  return rows.length ? { caseId: rows[0].case_id, status: rows[0].status } : null;
}

/** GET /api/v1/cases/:caseId/status */
async function getCaseStatus(caseId) {
  const { rows } = await pool.query(
    'SELECT case_id, status FROM cases WHERE case_id = $1', [caseId]);
  if (!rows.length) return null;
  return { caseId: rows[0].case_id, status: rows[0].status };
}


async function getCaseDetail(caseId) {
  const { rows } = await pool.query(`
    SELECT
      c.case_id, c.image_path, c.questionnaire_data, c.capture_metadata,
      c.patient_id, c.eye_laterality_reported, c.eye_laterality_detected,
      c.status, c.failure_code, c.failed_at, c.quality_gate_engine,
      g.engine_provenance,
      s.fovea_unreliable,
      p.patient_reference,
      g.dr_grade_cnn, g.dr_grade_rule_engine, g.branch_agreement,
      c.source_format, c.dicom_device_model, c.camera_device_id,
      c.camera_family_detected, c.camera_mismatch, c.camera_expected_family,
      g.confidence_score, g.uncertainty_score, g.conformal_tier, g.tier_reason,
      g.model_version, g.urgency_score, g.urgency_factor, g.urgency_inputs,
      g.claimed_by, g.claimed_at, claimant.name AS claimed_by_name,
      g.claimed_at > now() - make_interval(mins => $2) AS claim_live,
      s.lesion_counts, s.nv_suspicion_score,
      e.gradcam_path, e.lesion_attention_consistency_score, e.evidence_summary_text,
      e.lesion_attention_chance_level, e.lesion_attention_enrichment,
      e.lesion_attention_flagged
    FROM cases c
    JOIN      patients               p ON p.patient_id = c.patient_id
    LEFT JOIN grading_results        g ON g.case_id    = c.case_id
    LEFT JOIN segmentation_outputs   s ON s.case_id    = c.case_id
    LEFT JOIN explainability_outputs e ON e.case_id    = c.case_id
    LEFT JOIN users                  claimant ON claimant.user_id = g.claimed_by
    WHERE c.case_id = $1
  `, [caseId, cfg.CLAIM_TTL_MINUTES]);

  if (!rows.length) return null;
  const r = rows[0];


  const prior = await pool.query(`
    SELECT c.case_id, g.graded_at, g.dr_grade_cnn, s.lesion_counts,
      rev.decision AS review_decision, ref.status AS referral_status
    FROM cases c
    JOIN grading_results g ON g.case_id = c.case_id
    LEFT JOIN segmentation_outputs s ON s.case_id = c.case_id
    -- One case can have more than one review (a correction re-reviews it);
    -- the latest decision is what the timeline badge should reflect.
    LEFT JOIN LATERAL (
      SELECT decision FROM ophthalmologist_reviews
      WHERE case_id = c.case_id ORDER BY reviewed_at DESC LIMIT 1
    ) rev ON true
    LEFT JOIN referrals ref ON ref.case_id = c.case_id
    WHERE c.patient_id = $1 AND c.case_id <> $2 AND g.graded_at IS NOT NULL
    ORDER BY g.graded_at DESC
    LIMIT 10
  `, [r.patient_id, caseId]);


  return {
    caseId: r.case_id,
    patientReference: r.patient_reference ?? null,
    imageUrl: mediaPaths.toPublicUrl(r.image_path),
    gradCamOverlayUrl: mediaPaths.toPublicUrl(r.gradcam_path),


    lesionCounts: lesionCounts.toContractShape(r.lesion_counts),
    nvSuspicionScore: r.nv_suspicion_score ?? null,

    // Phase 7 — explainability safeguards
    evidenceSummaryText: r.evidence_summary_text ?? null,

    // Phase 2 — Branch A (populated now)
    drGradeCnn: r.dr_grade_cnn ?? null,
    confidenceScore: r.confidence_score ?? null,
    conformalTier: r.conformal_tier ?? null,

    modelVersion: r.model_version ?? null,

    urgencyScore: Number.isFinite(r.urgency_score) ? r.urgency_score : null,
    urgencyTopFactor: r.urgency_factor ?? null,
    urgencyBasis: r.urgency_score == null ? null : 'synthetic-model',
    urgencyLimitation: r.urgency_score == null ? null
      : 'Trained on synthetic data, never validated against patient outcomes. '
      + 'Use for queue ordering only -- not a clinical assessment.',

    urgencyInputs: r.urgency_inputs ?? null,

    sourceFormat: r.source_format ?? null,
    dicomDeviceModel: r.dicom_device_model ?? null,
    cameraDeviceReported: r.camera_device_id ?? null,
    cameraFamilyDetected: r.camera_family_detected ?? null,

    cameraMismatch: r.camera_mismatch ?? null,
    cameraExpectedFamily: r.camera_expected_family ?? null,

    tierReason: r.tier_reason ?? null,

    // Phase 5 — Branch B and agreement
    drGradeRuleEngine: r.dr_grade_rule_engine ?? null,
    branchAgreement: r.branch_agreement ?? null,

    // Phase 6 — MC-Dropout
    uncertaintyScore: r.uncertainty_score ?? null,

    // Phase 7
    lesionAttentionConsistencyScore: r.lesion_attention_consistency_score ?? null,

    lesionAttentionChanceLevel: r.lesion_attention_chance_level ?? null,
    lesionAttentionEnrichment: r.lesion_attention_enrichment ?? null,

    lesionAttentionFlagged: r.lesion_attention_flagged ?? null,

    questionnaireData: r.questionnaire_data ?? null,
    captureMetadata: r.capture_metadata ?? null,


    eyeLaterality: r.eye_laterality_detected ?? r.eye_laterality_reported ?? null,
    eyeLateralitySource: r.eye_laterality_detected ? 'dicom'
      : (r.eye_laterality_reported ? 'technician' : null),
    eyeLateralityMismatch: !!(r.eye_laterality_detected && r.eye_laterality_reported
      && r.eye_laterality_detected !== r.eye_laterality_reported),

    foveaUnreliable: r.fovea_unreliable ?? null,


    engineProvenance: engineProvenance.toContractShape(
      r.engine_provenance, r.quality_gate_engine),


    status: r.status ?? null,
    failureCode: r.failure_code ?? null,
    failedAt: r.failed_at ? r.failed_at.toISOString() : null,


    claim: r.claim_live
      ? {
        claimedBy: { userId: r.claimed_by, name: r.claimed_by_name ?? null },
        claimedAt: r.claimed_at.toISOString(),
        expiresAt: new Date(r.claimed_at.getTime() + cfg.CLAIM_TTL_MINUTES * 60000).toISOString(),
      }
      : null,

    priorAssessments: prior.rows.map((x) => ({
      caseId: x.case_id,
      gradedAt: x.graded_at.toISOString(),
      drGradeCnn: x.dr_grade_cnn ?? null,

      lesions: (() => {
        const lc = lesionCounts.toContractShape(x.lesion_counts);
        if (!lc) return null;
        const { microaneurysms, hemorrhages, hardExudates, softExudates } = lc;
        return { microaneurysms, hemorrhages, hardExudates, softExudates };
      })(),
      status: x.review_decision === 'override' ? 'OVERRIDDEN'
        : x.review_decision === 'confirm' ? 'CONFIRMED' : null,
      referralStatus: x.referral_status ?? null,
    })),
  };
}

function badRequest(code, message) {
  const e = new Error(message);
  e.code = code;
  e.status = 400;
  return e;
}

module.exports = {
  ingestCase, ingestSummary, getCaseStatus, getCaseDetail, findCaseByCaptureRef,
};
