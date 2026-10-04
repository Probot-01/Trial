'use strict';



const fs = require('fs');
const path = require('path');

const db = require('../db/localDb');
const { runQualityGate } = require('./qualityGateClient');
const { generateLocalId } = require('./ids');

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR || path.resolve(__dirname, '..', 'storage');

fs.mkdirSync(STORAGE_DIR, { recursive: true });

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp']);


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
    buffer = fs.readFileSync(imageFile);
    sourceName = imageFile;
  } else if (Buffer.isBuffer(imageFile)) {
    buffer = imageFile;
    sourceName = '.jpg';                 // raw bytes carry no filename
  } else if (imageFile.buffer) {
    buffer = imageFile.buffer;
    sourceName = imageFile.originalname || '.jpg';
  } else if (imageFile.path) {
    buffer = fs.readFileSync(imageFile.path);
    sourceName = imageFile.originalname || imageFile.path;
  } else {
    throw new Error(
      'handleCapture: imageFile must be a path, a Buffer, or a multer file object');
  }

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

function countPriorRetakes(patientId, nowIso) {
  const startOfDay = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
  const { n } = db.prepare(`
    SELECT COUNT(*) AS n FROM captures
    WHERE patient_id = ? AND quality_status = 'retake' AND captured_at >= ?
  `).get(patientId, startOfDay);
  return n;
}


function provisionalPriority(qualityStatus) {
  return qualityStatus === 'borderline' ? 'high' : 'low';
}

/**

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


  const patient = db
    .prepare('SELECT patient_id FROM patients WHERE patient_id = ?')
    .get(patientId);
  if (!patient) {
    throw new Error(`handleCapture: patient_not_found (${patientId})`);
  }

  const { buffer, ext } = resolveImageInput(imageFile);

  const captureId = generateLocalId();
  const capturedAt = new Date().toISOString();
  const imagePath = path.join(STORAGE_DIR, `${captureId}${ext}`);

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


const gating = new Set();


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


    const commit = db.transaction(() => {

      db.prepare(`
        UPDATE captures SET quality_status = ?, quality_reason = ?, quality_scores = ?,
                            quality_engine = ?
        WHERE capture_id = ?
      `).run(gate.status, gate.reason,
        gate.scores ? JSON.stringify(gate.scores) : null,
        gate.engine ? JSON.stringify(gate.engine) : null,
        captureId);


      if (gate.status === 'pass' || gate.status === 'borderline') {
        db.prepare(`
          INSERT INTO sync_queue
            (queue_id, capture_id, status, priority, chunks_sent, chunks_total, last_attempt_at)
          VALUES (?, ?, 'pending', ?, 0, 1, NULL)
        `).run(generateLocalId(), captureId, provisionalPriority(gate.status));
      }
    });
    commit();


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
    captureId: row.capture_id,
    patientId: row.patient_id,
    qualityStatus: row.quality_status,
    qualityReason: row.quality_reason ?? null,
    retakeCount: row.retake_count,
    capturedAt: row.captured_at,

    qualityGateEngine: engine,

    bestEffort: !!row.best_effort,
    qualityScore,
    metrics,
  };
}

module.exports = { handleCapture, recheckCapture, markBestEffort, STORAGE_DIR };
