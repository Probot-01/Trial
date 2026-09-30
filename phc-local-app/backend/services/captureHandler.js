'use strict';

/**
 * captureHandler.js  (Task 3.1)
 *
 * Takes a freshly captured fundus image, stores it, runs the local quality
 * gate over it, and records the outcome.
 *
 *   handleCapture(patientId, imageFile, cameraDeviceId)
 *     -> { captureId, patientId, qualityStatus, qualityReason, retakeCount,
 *          capturedAt, qualityGateEngine }
 *   recheckCapture(captureId)     re-run the gate on an already-saved capture
 *
 * The returned object is the POST /captures response body from
 * api-contracts.md -- camelCase, ISO 8601 UTC timestamp, string IDs -- plus
 * qualityGateEngine (which engine ran the gate). The route in Task 3.2 can
 * `res.status(201).json(await handleCapture(...))` with no reshaping.
 *
 * ORDER OF OPERATIONS, and why
 *   1. write the image to disk
 *   2. INSERT the capture row with quality_status = 'pending'
 *   3. run the quality gate (slow -- spawns MATLAB)
 *   4. UPDATE the row with the real status/reason, and -- atomically with it --
 *      enqueue the capture for sync if it passed
 *
 * The row is inserted BEFORE the gate runs so that a MATLAB crash, a timeout,
 * or the technician closing the laptop mid-check cannot lose the capture. The
 * image is already on disk and the row already points at it, so the case can be
 * re-gated later instead of asking the patient to sit back down.
 *
 * 'pending' is therefore a real, persisted state -- but it is an INTERNAL one.
 * api-contracts.md's qualityStatus enum is only pass/retake/borderline, so a
 * 'pending' row is never returned over HTTP: if the gate fails, this function
 * throws and the row stays 'pending' for later repair.
 */

const fs   = require('fs');
const path = require('path');

const db                 = require('../db/localDb');
const { runQualityGate } = require('./qualityGateClient');
const { generateLocalId } = require('./ids');

// Captured images live outside the DB; the row stores a path. Git-ignored --
// these are patient fundus photographs.
// LOCAL_STORAGE_DIR: tests point this at a scratch directory.
const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR || path.resolve(__dirname, '..', 'storage');

fs.mkdirSync(STORAGE_DIR, { recursive: true });

// Formats MATLAB's imread can open. Anything else is rejected up front rather
// than failing several seconds later inside the quality gate with a MATLAB
// stack trace the technician cannot act on.
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp']);

/**
 * resolveImageInput(imageFile)
 *
 * Normalises the several shapes an image can arrive in to { buffer, ext }.
 *
 * Accepted:
 *   - string                     a path on disk (how Task 3.1's DoD calls this)
 *   - Buffer                     raw bytes
 *   - { buffer, originalname }   multer memoryStorage
 *   - { path, originalname }     multer diskStorage
 *
 * Task 3.1's Definition of Done exercises this with a plain path, while Task
 * 3.2 will hand it a multer file object. Supporting both means the DoD tests
 * the same code path the route will use, rather than a variant of it.
 */
function resolveImageInput(imageFile) {
  if (!imageFile) {
    throw new Error('handleCapture: imageFile is required');
  }

  let buffer;
  let sourceName;

  if (typeof imageFile === 'string') {
    if (!fs.existsSync(imageFile)) {
      throw new Error(`handleCapture: image not found at ${imageFile}`);
    }
    buffer     = fs.readFileSync(imageFile);
    sourceName = imageFile;
  } else if (Buffer.isBuffer(imageFile)) {
    buffer     = imageFile;
    sourceName = '.jpg';                 // raw bytes carry no filename
  } else if (imageFile.buffer) {
    buffer     = imageFile.buffer;
    sourceName = imageFile.originalname || '.jpg';
  } else if (imageFile.path) {
    buffer     = fs.readFileSync(imageFile.path);
    sourceName = imageFile.originalname || imageFile.path;
  } else {
    throw new Error(
      'handleCapture: imageFile must be a path, a Buffer, or a multer file object');
  }

  // Preserve the original extension rather than forcing .jpg as the task text
  // suggests: the stored bytes are never transcoded, so a PNG saved as .jpg
  // would be a file whose extension lies about its contents. imread dispatches
  // on content, but everything else (viewers, the central upload) reads the
  // extension.
  let ext = path.extname(sourceName).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    if (ext) {
      throw new Error(
        `handleCapture: unsupported image type '${ext}'. Supported: ${[...ALLOWED_EXT].join(', ')}`);
    }
    ext = '.jpg';
  }

  return { buffer, ext };
}

/**
 * countPriorRetakes(patientId, nowIso)
 *
 * How many captures for this patient already failed the gate TODAY.
 *
 * Scoped to the current UTC day deliberately. retakeCount answers "which
 * attempt is this, in this sitting" -- the technician is retaking because the
 * patient is still in the chair. A patient screened again six months later
 * starts a fresh sitting and should not inherit a count from the last visit.
 *
 * captured_at is an ISO 8601 UTC string in a fixed format, so a lexicographic
 * >= comparison against the start of the day is equivalent to a date
 * comparison, and lets SQLite use the index rather than parsing every row.
 */
function countPriorRetakes(patientId, nowIso) {
  const startOfDay = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
  const { n } = db.prepare(`
    SELECT COUNT(*) AS n FROM captures
    WHERE patient_id = ? AND quality_status = 'retake' AND captured_at >= ?
  `).get(patientId, startOfDay);
  return n;
}

/**
 * provisionalPriority(qualityStatus)
 *
 * Which captures the sync manager should send first when bandwidth is scarce.
 *
 * The design doc wants referable/uncertain cases prioritised over
 * confident-negative ones (§9.2) -- but referable-ness is a central grading
 * result, and this runs before the image has left the building. So the value
 * written here is explicitly PROVISIONAL, "until a first central pass
 * classifies it" (§4.3).
 *
 * 'borderline' is the only uncertainty signal available locally: the gate found
 * no single hard failure but the composite score was still below par, so the
 * image is the kind that most benefits from central enhancement and a human
 * look. That earns 'high'. A clean pass starts 'low'.
 *
 * This is a heuristic standing in for a real signal, not a validated ranking.
 * Task 3.4 should update the row once the central classification comes back.
 */
function provisionalPriority(qualityStatus) {
  return qualityStatus === 'borderline' ? 'high' : 'low';
}

/**
 * handleCapture(patientId, imageFile, cameraDeviceId)
 *
 * @param {string} patientId       — an existing patients.patient_id
 * @param {string|Buffer|object} imageFile — see resolveImageInput
 * @param {string} [cameraDeviceId] — a key in cameraPresets.json, or 'unknown'
 * @returns {Promise<{captureId,patientId,qualityStatus,qualityReason,retakeCount,capturedAt,qualityGateEngine}>}
 */
async function handleCapture(patientId, imageFile, cameraDeviceId = 'unknown') {
  if (!patientId) {
    throw new Error('handleCapture: patientId is required');
  }

  // Check the patient up front. localDb.js enables foreign_keys, so a bad
  // patientId would fail at INSERT anyway -- but as an opaque SQLITE_CONSTRAINT
  // error, after the image has already been written to disk. Task 3.2 maps this
  // message to a 404 patient_not_found.
  const patient = db
    .prepare('SELECT patient_id FROM patients WHERE patient_id = ?')
    .get(patientId);
  if (!patient) {
    throw new Error(`handleCapture: patient_not_found (${patientId})`);
  }

  const { buffer, ext } = resolveImageInput(imageFile);

  const captureId  = generateLocalId();
  const capturedAt = new Date().toISOString();
  const imagePath  = path.join(STORAGE_DIR, `${captureId}${ext}`);

  // ── 1. Persist the image ───────────────────────────────────────────────────
  fs.writeFileSync(imagePath, buffer);

  // ── 2. Record the capture before the slow part ─────────────────────────────
  const retakeCount = countPriorRetakes(patientId, capturedAt);

  db.prepare(`
    INSERT INTO captures
      (capture_id, patient_id, camera_device_id, image_path,
       quality_status, quality_reason, retake_count, captured_at)
    VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)
  `).run(captureId, patientId, cameraDeviceId, imagePath, retakeCount, capturedAt);

  // ── 3. + 4. Quality gate, then record the verdict ──────────────────────────
  return gateCapture(captureId);
}

// Captures whose gate is running right now, so a second request for the same
// one (a double-clicked RETRY) cannot run it twice and enqueue it twice.
const gating = new Set();

/**
 * gateCapture(captureId)
 *
 * Runs the quality gate (spawns MATLAB; seconds, not milliseconds) over an
 * already-stored capture and records the verdict and -- atomically with it --
 * the sync-queue row if it passed. A capture that already has a verdict is
 * returned as it is, not re-gated.
 *
 * If the gate cannot run (MATLAB missing, timeout...) the row stays 'pending',
 * the image stays on disk, and this throws 'quality_gate_failed: ...' with
 * .captureId set: the capture is recoverable (recheckCapture) and must never be
 * presented as lost, or as passed.
 */
async function gateCapture(captureId) {
  const row = db.prepare('SELECT * FROM captures WHERE capture_id = ?').get(captureId);
  if (!row) throw new Error(`gateCapture: capture_not_found (${captureId})`);
  if (row.quality_status !== 'pending') return toResponse(row);

  if (gating.has(captureId)) {
    throw Object.assign(new Error('quality_gate_busy: this capture is already being checked'),
      { captureId });
  }
  gating.add(captureId);

  try {
    let gate;
    try {
      gate = await runQualityGate(row.image_path, row.camera_device_id || 'unknown');
    } catch (err) {
      // Leave the row 'pending'. The image is on disk and the row points at it,
      // so this capture can be re-gated without recalling the patient.
      console.error(`[captureHandler] quality gate failed for ${captureId}:`, err.message);
      throw Object.assign(new Error(`quality_gate_failed: ${err.message}`), { captureId });
    }

    // Both writes in one transaction. A capture that passed the gate but has no
    // sync_queue row would never reach the central server and nothing would ever
    // notice -- it would just look like a case the ophthalmologist never got to.
    const commit = db.transaction(() => {
      // qualityGateClient already normalises MATLAB's empty-matrix reason to null.
      // quality_scores is stored, not just logged. The six sub-scores say WHICH
      // dimension of an image is weak, and Task 2.8's adaptive enhancement runs
      // centrally -- so discarding them here means the central pipeline can only
      // apply one fixed chain to every image, which is what "adaptive" was
      // supposed to stop.
      db.prepare(`
        UPDATE captures SET quality_status = ?, quality_reason = ?, quality_scores = ?,
                            quality_engine = ?
        WHERE capture_id = ?
      `).run(gate.status, gate.reason,
             gate.scores ? JSON.stringify(gate.scores) : null,
             gate.engine ? JSON.stringify(gate.engine) : null,
             captureId);

      // Only pass/borderline get queued. A 'retake' is not a case -- the
      // technician is about to shoot it again (design doc §8.1 loops back to
      // step 1), so uploading it would spend scarce rural bandwidth on an image
      // that is already being replaced.
      if (gate.status === 'pass' || gate.status === 'borderline') {
        db.prepare(`
          INSERT INTO sync_queue
            (queue_id, capture_id, status, priority, chunks_sent, chunks_total, last_attempt_at)
          VALUES (?, ?, 'pending', ?, 0, 1, NULL)
        `).run(generateLocalId(), captureId, provisionalPriority(gate.status));
      }
    });
    commit();

    // All seven raw sub-scores are for logging only. Three of them (focus,
    // illumination, fov) also feed the derived qualityScore/metrics that
    // toResponse() exposes (2026-09-30) -- glare/motion/occlusion still never
    // leave this log line.
    console.log(`[captureHandler] ${captureId}: ${gate.status}`
      + `${gate.reason ? ` (${gate.reason})` : ''}`
      + ` engine=${gate.engine ? gate.engine.engine : 'unrecorded'}`
      + ` scores=${JSON.stringify(gate.scores)}`);

    return toResponse(db.prepare('SELECT * FROM captures WHERE capture_id = ?').get(captureId));
  } finally {
    gating.delete(captureId);
  }
}

/** recheckCapture(captureId) -- re-run the gate on a saved capture; see gateCapture. */
function recheckCapture(captureId) {
  return gateCapture(captureId);
}

/**
 * markBestEffort(captureId)  (design doc §10.2)
 *
 * After a fixed number of failed retakes, the technician can mark the capture
 * "best effort -- proceed as ungradable" rather than retaking forever or the
 * case silently never being recorded. Only makes sense for an image that
 * actually failed the gate: a 'pass'/'borderline' capture already queues
 * itself, and 'pending' has no verdict yet to override.
 *
 * A 'retake' capture is normally never queued (gateCapture's own comment: "the
 * technician is about to shoot it again"). This is the one path that queues one
 * anyway -- with best_effort = 1 so central sees this is a technician override,
 * not a real pass, and (a follow-up on the central side, not built here) can
 * hold it at Tier C regardless of what the classifier says.
 *
 * Idempotent: calling it twice does not create a second sync_queue row.
 */
function markBestEffort(captureId) {
  const row = db.prepare('SELECT * FROM captures WHERE capture_id = ?').get(captureId);
  if (!row) throw new Error(`markBestEffort: capture_not_found (${captureId})`);
  if (row.quality_status !== 'retake') {
    throw Object.assign(
      new Error("best_effort_not_applicable: only a capture the quality gate marked 'retake' can be proceeded as best effort"),
      { code: 'best_effort_not_applicable', captureId });
  }

  const commit = db.transaction(() => {
    db.prepare('UPDATE captures SET best_effort = 1 WHERE capture_id = ?').run(captureId);
    const alreadyQueued = db.prepare('SELECT 1 FROM sync_queue WHERE capture_id = ?').get(captureId);
    if (!alreadyQueued) {
      // 'high' priority: this is exactly the kind of uncertain case §9.2 wants
      // sent first, and there is no tier above 'high' in this queue's scale.
      db.prepare(`
        INSERT INTO sync_queue
          (queue_id, capture_id, status, priority, chunks_sent, chunks_total, last_attempt_at)
        VALUES (?, ?, 'pending', 'high', 0, 1, NULL)
      `).run(generateLocalId(), captureId);
    }
  });
  commit();

  return toResponse(db.prepare('SELECT * FROM captures WHERE capture_id = ?').get(captureId));
}

/** The POST /captures response body for a capture row (api-contracts.md, plus qualityGateEngine). */
function toResponse(row) {
  let engine = null;
  try { engine = row.quality_engine ? JSON.parse(row.quality_engine) : null; } catch { engine = null; }

  // qualityScore/metrics (2026-09-30, api-contracts.md changelog): the MATLAB
  // gate's own borderline threshold is `mean([focusScore, illuminationScore,
  // fovScore]) < 0.7` (qualityGateMain.m) -- recomputed here from the stored
  // sub-scores, not invented. null when the sub-scores were never recorded
  // (capture predates this, or a fallback engine that doesn't produce them).
  let scores = null;
  try { scores = row.quality_scores ? JSON.parse(row.quality_scores) : null; } catch { scores = null; }
  const hasTriad = scores
    && typeof scores.focusScore === 'number'
    && typeof scores.illuminationScore === 'number'
    && typeof scores.fovScore === 'number';
  const qualityScore = hasTriad
    ? (scores.focusScore + scores.illuminationScore + scores.fovScore) / 3
    : null;
  const metrics = scores ? {
    focusScore: scores.focusScore,
    illuminationScore: scores.illuminationScore,
    retinalCoverageScore: scores.coveragePercent,
  } : null;

  return {
    captureId:     row.capture_id,
    patientId:     row.patient_id,
    qualityStatus: row.quality_status,
    qualityReason: row.quality_reason ?? null,
    retakeCount:   row.retake_count,
    capturedAt:    row.captured_at,
    // Which engine ran the gate ({ engine, fallback, detail }). null only for a
    // capture gated before this was stored -- never guessed.
    qualityGateEngine: engine,
    // §10.2: a technician-forced proceed on an image that failed the gate.
    // false for every ordinary capture, including a real pass/borderline.
    bestEffort: !!row.best_effort,
    qualityScore,
    metrics,
  };
}

module.exports = { handleCapture, recheckCapture, markBestEffort, STORAGE_DIR };
