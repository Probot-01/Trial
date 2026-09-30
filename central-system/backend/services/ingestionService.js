'use strict';

/**
 * ingestionService.js  (Task 3.3)
 *
 * Receives a case from a PHC sync manager, stores it, and reads it back in the
 * exact shape api-contracts.md specifies.
 *
 *   ingestCase(fields)     -> { caseId, receivedAt, status, duplicate, fromSummary }
 *   ingestSummary(fields)  -> { caseId, receivedAt, status, duplicate }
 *   getCaseStatus(caseId)  -> { caseId, status } | null
 *   getCaseDetail(caseId)  -> full case detail | null
 *
 * THE NULL RULE, which is the whole point of getCaseDetail:
 *   Every ML-derived field must come back as an explicit null until its module
 *   ships — never undefined, never a missing key, and never a zero standing in
 *   for a real result. The frontend renders "not yet available" for null. A
 *   missing key reads as undefined and can render as blank; a 0 reads as a
 *   measured finding of zero lesions. On a clinical screen those are very
 *   different claims, and only one of them is true right now.
 */

const fs   = require('fs');
const path = require('path');

const pool       = require('../db/pgClient');
const mediaPaths = require('./mediaPaths');
const mediaCrypto = require('./mediaCrypto');
const cfg        = require('./authConfig');
const lesionCounts = require('./lesionCounts');
const engineProvenance = require('./engineProvenance');

// Task 4.6: .dcm accepted because real fundus cameras export DICOM under the
// Ophthalmic Photography IOD, and readFundusImage.m now reads it. Central only
// -- the PHC quality gate still uses imread, so a DICOM cannot yet complete the
// capture->sync path end to end. See readFundusImage.m for why that is a
// bundle/licensing decision (Task 8.1) rather than a coding one.
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.dcm']);

/**
 * parseJsonField(value, fieldName)
 *
 * The questionnaire payloads arrive as JSON-encoded strings inside a multipart
 * body. They are parsed here and passed to pg as OBJECTS: node-postgres encodes
 * a JS object to JSONB itself, and handing it a pre-stringified value stores a
 * JSON *string* inside the JSONB column instead of a JSON object. That still
 * inserts cleanly and only shows up later, when a query on a nested key matches
 * nothing.
 */
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

// Reference alphabet: uppercase, with 0/O/1/I/5/S removed. These get read aloud
// and retyped between an ophthalmologist and a PHC, and that is exactly where
// the ambiguous glyphs cause a mismatch on the wrong patient's record.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';

function randomReference() {
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  }
  return `PT-${s}`;
}

/**
 * ensurePatientReference(client, patientId)
 *
 * Mints the display-safe reference shown to ophthalmologists in place of the
 * real patient ID (api-contracts.md — "never the raw patientId").
 *
 * WIDER THAN THE CONTRACT'S EXAMPLE, deliberately. api-contracts.md illustrates
 * the format as "PT-4821", but four digits is only 9,000 distinct values, and
 * this system is specified for a district screening 100,000+ patients a year —
 * the space would be exhausted in weeks, and by the birthday bound collisions
 * start at roughly a hundred patients. Six characters from a 30-symbol alphabet
 * gives ~7.3e8 instead. The prefix and shape are preserved; only the width
 * changes. api-contracts.md should record this.
 *
 * Random rather than sequential or hashed: a reference that can be counted or
 * reversed leaks the very thing it exists to hide.
 */
async function ensurePatientReference(client, patientId) {
  const { rows } = await client.query(
    'SELECT patient_reference FROM patients WHERE patient_id = $1', [patientId]);
  if (rows.length && rows[0].patient_reference) return rows[0].patient_reference;

  for (let attempt = 0; attempt < 20; attempt++) {
    const ref = randomReference();
    // SAVEPOINT per attempt. In Postgres ANY error aborts the whole
    // transaction, so a plain try/catch retry loop is broken inside one: the
    // first unique violation poisons the transaction and every subsequent
    // statement fails with "current transaction is aborted", including the
    // retry itself and the eventual COMMIT. Rolling back to a savepoint
    // confines the failed attempt.
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

/**
 * readQualityGateEngine(value) -> { engine, fallback, detail } | null
 *
 * Which engine ran the PHC's quality gate on this capture (engine provenance,
 * migration 0019). Optional -- absent from an older PHC build, which is stored
 * as NULL ("not recorded"). Present but malformed is a 400, not a silent NULL:
 * a PHC that believes it is reporting provenance must find out that it is not.
 */
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

/**
 * readCaseFields(fields) -- the validation and parsing shared by a full case
 * (ingestCase) and a summary packet (ingestSummary). Throws 400-shaped errors.
 */
function readCaseFields(fields) {
  const { patientId } = fields;
  if (!patientId) throw badRequest('patient_id_required', 'patientId is required.');

  // Validated rather than handed to Postgres raw: a malformed timestamp would
  // otherwise surface as a 500 from the INSERT instead of a 400 naming the field.
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
    phcId:          fields.phcId || null,
    captureIdRef:   fields.captureIdRef || null,
    cameraDeviceId: fields.cameraDeviceId || null,
    capturedAt:     fields.capturedAt || null,
    consentGivenAt,
    // Parsed to objects: pg encodes a JS object to JSONB itself, and a
    // pre-stringified value would be stored as a JSON STRING inside the column,
    // which only surfaces later when a query on a nested key matches nothing.
    questionnaireData: parseJsonField(fields.questionnaireData, 'questionnaireData'),
    captureMetadata:   parseJsonField(fields.captureMetadata, 'captureMetadata'),
    qualityScores:     parseJsonField(fields.qualityScores, 'qualityScores'),
    qualityGateEngine: readQualityGateEngine(fields.qualityGateEngine),
    pendingCount: pendingCount === undefined || pendingCount === null || pendingCount === ''
      ? null : parseInt(pendingCount, 10),
    patientName:          fields.patientName,
    patientAge:           fields.patientAge,
    patientContactNumber: fields.patientContactNumber,
  };
}

/** 'left' | 'right' | null from the capture metadata's eyeLaterality (§10.4). */
function reportedLaterality(captureMetadata) {
  const v = captureMetadata && captureMetadata.eyeLaterality;
  return v === 'left' || v === 'right' ? v : null;
}

/**
 * ensurePatient(client, f)
 *
 * cases.patient_id is a foreign key, so the patient must exist centrally
 * first. api-contracts.md defines no central patient-creation endpoint, so the
 * demographics ride along with the case: accepted when supplied and REQUIRED
 * when the patient is unknown, because patients.name/age/contact_number are
 * NOT NULL -- and contact_number is not bookkeeping: Task 3.6 sends the
 * referral SMS to it.
 */
async function ensurePatient(client, f) {
  const known = await client.query(
    'SELECT patient_id FROM patients WHERE patient_id = $1', [f.patientId]);

  if (known.rows.length === 0) {
    if (!f.patientName || f.patientAge === undefined || !f.patientContactNumber) {
      throw badRequest('patient_not_found',
        `Patient ${f.patientId} is not known centrally. Send patientName, ` +
        'patientAge and patientContactNumber with the case to register them.');
    }
    // Validated here rather than left to the NOT NULL column: parseInt('abc')
    // is NaN, which reaches Postgres as null and surfaces as a 500 about a
    // constraint instead of a 400 naming the field the PHC got wrong.
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
    // A known patient's FIRST recorded consent is kept: consent is given once
    // at registration, and a later case must not quietly move that date.
    await client.query(`
      UPDATE patients SET consent_given_at = COALESCE(consent_given_at, $2)
      WHERE patient_id = $1
    `, [f.patientId, f.consentGivenAt]);
  }

  await ensurePatientReference(client, f.patientId);
}

/**
 * touchPhc(client, f, { fullSync })
 *
 * last_contact_at: EVERY ingestion touchpoint -- a summary packet is contact
 * even when no full sync completes (backend plan §F.1).
 *
 * last_sync_at + pending_count: only on a full case landing. pending_count is
 * the PHC's own report of its queue (the queue lives in that site's SQLite, not
 * here), true only as of last_sync_at, so the two are always written together:
 * read apart, pending_count misleads, because the site whose backlog is really
 * growing is the offline one whose number is frozen.
 */
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

/**
 * ingestCase(fields)
 *
 * @param {object} fields
 *   patientId, phcId, captureIdRef, cameraDeviceId  — strings
 *   imageFile        — multer file object ({ buffer, originalname }) or a path
 *   questionnaireData, captureMetadata              — JSON strings or objects
 *   patientName, patientAge, patientContactNumber   — optional, see ensurePatient
 *   consentGivenAt   — ISO timestamp the technician confirmed verbal consent
 *                      (design doc §9.7, backend plan §M); optional here, the
 *                      PHC front-ends enforce that it was collected
 * @returns {Promise<{caseId, receivedAt, status, duplicate, fromSummary}>}
 *
 * ── IDEMPOTENT ON captureIdRef (design doc §10.6, backend plan §C) ──────────
 * The PHC's capture id is the idempotency key, backed by the
 * cases_capture_id_ref_unique constraint. Three outcomes:
 *
 *   new capture                -> a new case, status 'processing'. The caller
 *                                 enqueues grading.
 *   capture already has a case -> NOTHING is written or re-graded; the existing
 *     with an image               case comes back with duplicate: true. This is
 *                                 the retry after a lost response, and it must
 *                                 look like success to the PHC, not an error.
 *   capture has a summary-only -> the image fills THAT row (fromSummary: true),
 *     case ('awaiting_image')     it moves to 'processing', and the caller
 *                                 enqueues grading. Fields the summary already
 *                                 set are kept unless this upload supplies them.
 *
 * With no captureIdRef there is nothing to deduplicate on, so every call makes
 * a new case, as before.
 */
async function ingestCase(fields) {
  const f = readCaseFields(fields);
  // Resolve the image bytes before opening a transaction -- no point holding a
  // DB connection while reading a file that might not exist.
  const { buffer, ext } = readImage(fields.imageFile);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensurePatient(client, f);

    // image_path is written AFTER the row exists, because the filename is keyed
    // on the generated case_id. Insert with a placeholder, then update.
    // ON CONFLICT DO NOTHING rather than a SELECT-then-INSERT: two concurrent
    // retries of the same capture cannot both get past a unique index.
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
        // Falls back to now() only when the PHC did not send one. That fallback
        // is wrong for any case that synced late, so the sync manager (Task 3.4)
        // must always send the local captures.captured_at.
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
        // A retry. The patient step above may have recorded consent for the
        // first time, which is worth keeping, so COMMIT rather than roll back.
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
      // image_path and status in ONE statement: the
      // cases_image_required_unless_awaiting constraint is checked per
      // statement, so leaving 'awaiting_image' before the path is set fails.
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

/**
 * ingestSummary(fields) -- POST /api/v1/cases/summary (design doc §10.1).
 *
 * The same fields as ingestCase minus the image. Creates the case in state
 * 'awaiting_image' so central knows it exists -- the patient, the
 * questionnaires, and that this PHC is alive -- before a thin link manages to
 * move the full image. Nothing is graded until the image arrives via
 * POST /api/v1/cases or the chunk group, which fill in this same row.
 *
 * captureIdRef is REQUIRED here: it is the only thing that ties the later
 * image to this row, so a summary without one could never be completed.
 *
 * Idempotent: a repeated summary, or a summary arriving after the image did,
 * changes nothing and returns the existing case with duplicate: true.
 */
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

/**
 * findCaseByCaptureRef(captureIdRef) -> { caseId, status } | null
 *
 * The idempotency lookup (§C), for callers that need to know whether a capture
 * already has a case before doing expensive work -- the chunked upload checks
 * it before accepting megabytes it would then discard.
 */
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

/**
 * getCaseDetail(caseId)
 *
 * LEFT JOINs across cases + grading_results + segmentation_outputs +
 * explainability_outputs. LEFT, not INNER: a case that has been received but
 * not yet graded has no grading_results row at all, and an INNER JOIN would
 * return "not found" for a case that demonstrably exists.
 */
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

  // Earlier screenings for the same patient — the longitudinal view on the
  // ophthalmologist's Case History panel (design doc §5.2).
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

  // `?? null` throughout: a LEFT JOIN with no match yields undefined for those
  // columns, and JSON.stringify DROPS an undefined value entirely rather than
  // emitting null. The contract requires the key to be present and null.
  return {
    caseId:            r.case_id,
    patientReference:  r.patient_reference ?? null,
    imageUrl:          mediaPaths.toPublicUrl(r.image_path),
    gradCamOverlayUrl: mediaPaths.toPublicUrl(r.gradcam_path),

    // Phase 4 — segmentation
    // Mapped to the contract's clinical key names at this boundary, never
    // stored that way -- see services/lesionCounts.js.
    lesionCounts:      lesionCounts.toContractShape(r.lesion_counts),
    nvSuspicionScore:  r.nv_suspicion_score ?? null,

    // Phase 7 — explainability safeguards
    evidenceSummaryText: r.evidence_summary_text ?? null,

    // Phase 2 — Branch A (populated now)
    drGradeCnn:        r.dr_grade_cnn ?? null,
    confidenceScore:   r.confidence_score ?? null,
    conformalTier:     r.conformal_tier ?? null,
    // WHICH MODEL produced drGradeCnn. Read from the inference result per case,
    // so it follows BRANCH_A_MODEL_VERSION rather than a constant. 'unknown'
    // means the result did not report one; NULL means the row predates this
    // being stored honestly, when every row claimed 'branchA_v1'.
    modelVersion:      r.model_version ?? null,

    // ── Triage urgency: a QUEUE ORDERING HINT, never a clinical statement ──
    // The four fields travel together on purpose. urgencyScore is meaningless
    // and potentially harmful without urgencyLimitation and urgencyBasis
    // beside it -- the model behind it is trained on SYNTHETIC data and has
    // never been validated against an outcome, so a bare number on a screen
    // would read as evidence about a patient. Any surface showing the score
    // MUST show the limitation.
    //
    // null means NOT COMPUTED (the clinical inputs were not all available),
    // never "low urgency". 1 is a real score and must stay distinguishable.
    urgencyScore:      Number.isFinite(r.urgency_score) ? r.urgency_score : null,
    urgencyTopFactor:  r.urgency_factor ?? null,
    urgencyBasis:      r.urgency_score == null ? null : 'synthetic-model',
    urgencyLimitation: r.urgency_score == null ? null
      : 'Trained on synthetic data, never validated against patient outcomes. '
        + 'Use for queue ordering only -- not a clinical assessment.',
    // What went in, each value tagged measured or assumed, so "HbA1c 9.5%"
    // can be shown as the bucket midpoint it may be rather than a lab result.
    urgencyInputs:     r.urgency_inputs ?? null,
    // What the image FILE says about itself, next to what the worker reported.
    // Deliberately separate fields -- a disagreement between them is the point.
    sourceFormat:      r.source_format ?? null,
    dicomDeviceModel:  r.dicom_device_model ?? null,
    cameraDeviceReported: r.camera_device_id ?? null,
    cameraFamilyDetected: r.camera_family_detected ?? null,
    // The reported-vs-detected cross-check (migration 0021), three-state on
    // purpose: true disagreed, false agreed, null the check could not run
    // because no expected family was known for the reported device. A null is
    // NOT an agreement -- classifyCameraFamily.m returns false in both the
    // "agreed" and the "nothing to compare" case, and only one of those is a
    // statement about this camera.
    cameraMismatch:       r.camera_mismatch ?? null,
    cameraExpectedFamily: r.camera_expected_family ?? null,
    // WHY this tier -- the escalation that fired, or the floor that raised it
    // from A. Five different situations produce a "B", and they call for
    // different things from the reviewer: "the model is unsure" is not the
    // same as "this camera has never been validated here". NULL means the row
    // predates migration 0015, i.e. not recorded -- never "no reason".
    tierReason:        r.tier_reason ?? null,

    // Phase 5 — Branch B and agreement
    drGradeRuleEngine: r.dr_grade_rule_engine ?? null,
    branchAgreement:   r.branch_agreement ?? null,

    // Phase 6 — MC-Dropout
    uncertaintyScore:  r.uncertainty_score ?? null,

    // Phase 7
    lesionAttentionConsistencyScore: r.lesion_attention_consistency_score ?? null,
    // The score is NOT interpretable alone (migration 0022). If lesions cover
    // 70% of the retina, a heatmap of pure noise also scores 0.70. chanceLevel
    // is what a random heatmap would score on THIS eye; enrichment is the
    // ratio, where 1.0 is chance and above 1 is real attention; flagged is the
    // comparison already made, next to the maths, so no surface re-derives it.
    // A surface showing the score must show these with it.
    lesionAttentionChanceLevel: r.lesion_attention_chance_level ?? null,
    lesionAttentionEnrichment:  r.lesion_attention_enrichment ?? null,
    // Meaningful even when the score is null: a heatmap with no energy is
    // undefined-but-flagged.
    lesionAttentionFlagged:     r.lesion_attention_flagged ?? null,

    questionnaireData: r.questionnaire_data ?? null,
    captureMetadata:   r.capture_metadata ?? null,

    // §10.4 / backend plan §P. The image's own DICOM tag wins over the
    // technician's selection when both exist; a disagreement is surfaced, not
    // resolved silently. null when neither is known.
    eyeLaterality: r.eye_laterality_detected ?? r.eye_laterality_reported ?? null,
    eyeLateralitySource: r.eye_laterality_detected ? 'dicom'
      : (r.eye_laterality_reported ? 'technician' : null),
    eyeLateralityMismatch: !!(r.eye_laterality_detected && r.eye_laterality_reported
      && r.eye_laterality_detected !== r.eye_laterality_reported),

    // §I: true when the fovea could not be located reliably (the lesion
    // quadrants are still keyed to that unreliable fovea, so they cannot be
    // trusted). null when not reported.
    foveaUnreliable: r.fovea_unreliable ?? null,

    // WHICH ENGINE produced each ML output (migration 0019): classifier,
    // each segmentation model, rule engine, and the PHC's quality gate. Every
    // key is always present; null means NOT RECORDED (not graded yet, graded
    // before provenance was stored, or segmentation did not run) -- never a
    // guess from the current configuration.
    engineProvenance: engineProvenance.toContractShape(
      r.engine_provenance, r.quality_gate_engine),

    // Why grading gave up, on a case whose status is 'error' (migration 0014).
    // The CODE only: failure_reason can quote internal paths and library
    // messages, which belong on the admin health screen, not on a clinical
    // case view. null on every case that has not failed.
    // api-contracts.md: "a case with status: error must not be
    // indistinguishable from a graded one". Every ML field below is null on
    // BOTH a failed case and one still being graded, so without the status
    // the two read identically -- the reader sees blanks and cannot tell
    // "not yet" from "never".
    status: r.status ?? null,
    failureCode: r.failure_code ?? null,
    failedAt:    r.failed_at ? r.failed_at.toISOString() : null,

    // §10.8: who is reviewing this case right now, if anyone. null once the
    // claim has expired. The reviewer's own client compares userId to decide
    // between "you hold this" and "someone else does".
    claim: r.claim_live
      ? {
        claimedBy: { userId: r.claimed_by, name: r.claimed_by_name ?? null },
        claimedAt: r.claimed_at.toISOString(),
        expiresAt: new Date(r.claimed_at.getTime() + cfg.CLAIM_TTL_MINUTES * 60000).toISOString(),
      }
      : null,

    // 2026-09-30: lesions/status/referralStatus added (api-contracts.md
    // changelog) -- the Case History timeline's diff-view and referral
    // tracker were built against these fields but the endpoint never sent
    // them, so every prior visit rendered "NO LESION DATA" and no referral
    // progress regardless of what actually happened.
    priorAssessments: prior.rows.map((x) => ({
      caseId:         x.case_id,
      gradedAt:       x.graded_at.toISOString(),
      drGradeCnn:     x.dr_grade_cnn ?? null,
      // The timeline's diff view compares four flat numbers; toContractShape's
      // `detail` sub-object (per-quadrant arrays, procedure metadata) is for
      // Case Detail's own evidence panel, not a value this view can diff.
      lesions:        (() => {
        const lc = lesionCounts.toContractShape(x.lesion_counts);
        if (!lc) return null;
        const { microaneurysms, hemorrhages, hardExudates, softExudates } = lc;
        return { microaneurysms, hemorrhages, hardExudates, softExudates };
      })(),
      status:         x.review_decision === 'override' ? 'OVERRIDDEN'
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
