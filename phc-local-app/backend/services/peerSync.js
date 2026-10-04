'use strict';


const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/localDb');
const { STORAGE_DIR } = require('./captureHandler');

const PAGE = 300;
/** A capture's own device uploads it; another device takes over only after this much silence. */
const TAKEOVER_MS = Number(process.env.PEER_TAKEOVER_MS || 6 * 3600 * 1000);

const STATE_RANK = { pending: 0, summary_sent: 1, synced: 2 };
const CENTRAL_RANK = { awaiting_image: 1, processing: 2, graded: 3, error: 3 };
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// ── Row <-> wire record ─────────────────────────────────────────────────────

const toWire = {
  patients: (r) => ({
    patientId: r.patient_id, name: r.name, age: r.age, contactNumber: r.contact_number,
    consentGivenAt: r.consent_given_at, registeredAt: r.registered_at, duplicateOf: r.duplicate_of ?? null,
    demographics: parse(r.demographics_json), questionnaire: parse(r.questionnaire_json),
    updatedAt: r.updated_at || r.registered_at, originDevice: r.origin_device || db.deviceId(),
  }),
  captures: (r) => ({
    captureId: r.capture_id, patientId: r.patient_id, eye: r.eye ?? null, cameraDeviceId: r.camera_device_id,
    source: r.source || 'desktop', qualityStatus: r.quality_status, qualityReason: r.quality_reason,
    qualityScores: parse(r.quality_scores), qualityEngine: parse(r.quality_engine), retakeCount: r.retake_count, bestEffort: !!r.best_effort,
    capturedAt: r.captured_at, imageBytes: r.image_bytes ?? null, imageSha256: r.image_sha256 ?? null,
    originDevice: r.origin_device || db.deviceId(),
  }),
  questionnaire_responses: (r) => ({
    responseId: r.response_id, captureId: r.capture_id, riskFactorFields: parse(r.risk_factor_fields),
    symptomFields: parse(r.symptom_fields), language: r.language, recordedAt: r.recorded_at,
  }),
  capture_metadata_responses: (r) => ({
    responseId: r.response_id, captureId: r.capture_id, cameraDeviceReported: r.camera_device_reported,
    pupilStatus: r.pupil_status, lightingEnvironment: r.lighting_environment,
    observedIssues: parse(r.observed_issues) ?? [], workerUsabilityRating: r.worker_usability_rating,
    eyeLaterality: r.eye_laterality ?? null, recordedAt: r.recorded_at,
  }),
  sync_queue: (r) => ({
    captureId: r.capture_id, state: r.status === 'synced' ? 'synced' : 'pending',
    centralCaseId: r.central_case_id ?? null, centralStatus: r.central_status ?? null,
    priority: r.priority === 'high' ? 1 : 2, ownerDevice: r.owner_device || db.deviceId(),
    updatedAt: r.updated_at || r.last_attempt_at || null,
  }),
};

const KIND = {
  patients: 'patient', captures: 'capture', questionnaire_responses: 'questionnaire',
  capture_metadata_responses: 'metadata', sync_queue: 'syncState',
};
const TABLE_OF = Object.fromEntries(Object.entries(KIND).map(([t, k]) => [k, t]));
// Parents before children, so foreign keys hold when a page is applied in order.
const APPLY_ORDER = ['patient', 'capture', 'questionnaire', 'metadata', 'syncState'];


function changesSince(cursor, excludeOrigin = null) {
  const rows = db.prepare(`
    SELECT tbl, pk, MAX(seq) AS seq FROM change_log
    WHERE seq > ? AND (origin IS NULL OR origin <> ?)
    GROUP BY tbl, pk ORDER BY seq LIMIT ?`).all(Number(cursor) || 0, excludeOrigin ?? '', PAGE + 1);
  const more = rows.length > PAGE;
  const page = rows.slice(0, PAGE);
  const records = [];
  for (const { tbl, pk } of page) {
    const key = db.SYNCED_TABLES[tbl];
    const row = db.prepare(`SELECT * FROM ${tbl} WHERE ${key} = ?`).get(pk);
    if (!row) continue;
    if (tbl === 'captures' && row.quality_status === 'pending') continue;
    records.push({ kind: KIND[tbl], data: toWire[tbl](row) });
  }
  records.sort((a, b) => APPLY_ORDER.indexOf(a.kind) - APPLY_ORDER.indexOf(b.kind));
  const last = page.length ? page[page.length - 1].seq : Number(cursor) || 0;
  // When the tail of the page was all excluded, still advance past it.
  const maxSeq = db.prepare('SELECT MAX(seq) AS m FROM change_log').get().m || 0;
  return { records, cursor: more ? last : Math.max(last, maxSeq), more };
}

// ── Applying records from a peer ────────────────────────────────────────────

const J = (v) => (v === null || v === undefined ? null : JSON.stringify(v));

function applyPatient(p) {
  const cur = db.prepare('SELECT updated_at, registered_at, origin_device FROM patients WHERE patient_id = ?').get(p.patientId);
  if (cur) {
    const curAt = cur.updated_at || cur.registered_at;
    const incomingWins = p.updatedAt > curAt
      || (p.updatedAt === curAt && String(p.originDevice) > String(cur.origin_device || db.deviceId()));
    if (!incomingWins) return false;
    db.prepare(`UPDATE patients SET name = ?, age = ?, contact_number = ?, consent_given_at = COALESCE(consent_given_at, ?),
                  duplicate_of = ?, demographics_json = ?, questionnaire_json = ?, updated_at = ?, origin_device = ?
                WHERE patient_id = ?`)
      .run(p.name, p.age, p.contactNumber, p.consentGivenAt, p.duplicateOf, J(p.demographics), J(p.questionnaire),
        p.updatedAt, p.originDevice, p.patientId);
    return true;
  }
  db.prepare(`INSERT INTO patients (patient_id, name, age, contact_number, registered_at, consent_given_at,
                duplicate_of, demographics_json, questionnaire_json, updated_at, origin_device)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.patientId, p.name, p.age, p.contactNumber, p.registeredAt, p.consentGivenAt, p.duplicateOf,
      J(p.demographics), J(p.questionnaire), p.updatedAt, p.originDevice);
  return true;
}

function applyCapture(c) {
  if (db.prepare('SELECT 1 FROM captures WHERE capture_id = ?').get(c.captureId)) return false;
  const imagePath = existingImagePath(c.captureId);
  if (!imagePath) {
    throw Object.assign(new Error(`image for ${c.captureId} must be sent before the capture record`), { code: 'image_missing' });
  }
  db.prepare(`INSERT INTO captures (capture_id, patient_id, camera_device_id, image_path, quality_status, quality_reason,
                retake_count, captured_at, quality_scores, quality_engine, eye, source, best_effort, image_bytes, image_sha256, origin_device)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(c.captureId, c.patientId, c.cameraDeviceId, imagePath, c.qualityStatus, c.qualityReason, c.retakeCount ?? 0,
      c.capturedAt, J(c.qualityScores), J(c.qualityEngine), c.eye, c.source, c.bestEffort ? 1 : 0, c.imageBytes, c.imageSha256, c.originDevice);
  return true;
}

function applyQuestionnaire(q) {
  const r = db.prepare(`INSERT OR IGNORE INTO questionnaire_responses (response_id, capture_id, risk_factor_fields, symptom_fields, language, recorded_at)
                        VALUES (?, ?, ?, ?, ?, ?)`)
    .run(q.responseId, q.captureId, J(q.riskFactorFields), J(q.symptomFields), q.language, q.recordedAt);
  return r.changes > 0;
}

function applyMetadata(m) {
  const r = db.prepare(`INSERT OR IGNORE INTO capture_metadata_responses (response_id, capture_id, camera_device_reported, pupil_status,
                          lighting_environment, observed_issues, worker_usability_rating, recorded_at, eye_laterality)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(m.responseId, m.captureId, m.cameraDeviceReported, m.pupilStatus, m.lightingEnvironment,
      J(m.observedIssues ?? []), m.workerUsabilityRating, m.recordedAt, m.eyeLaterality);
  return r.changes > 0;
}

function applySyncState(s) {
  const cur = db.prepare('SELECT * FROM sync_queue WHERE capture_id = ?').get(s.captureId);
  const now = new Date().toISOString();
  if (!cur) {
    db.prepare(`INSERT INTO sync_queue (queue_id, capture_id, status, priority, chunks_sent, chunks_total, last_attempt_at,
                  central_case_id, central_status, owner_device, updated_at)
                VALUES (?, ?, ?, ?, 0, 1, NULL, ?, ?, ?, ?)`)
      .run(`q-${s.captureId}`, s.captureId, s.state === 'synced' ? 'synced' : 'pending', s.priority <= 1 ? 'high' : 'low',
        s.centralCaseId, s.centralStatus, s.ownerDevice, now);
    return true;
  }
  const curState = cur.status === 'synced' ? 'synced' : 'pending';
  const nextState = (STATE_RANK[s.state] ?? 0) > STATE_RANK[curState] ? s.state : curState;
  const nextCentral = (CENTRAL_RANK[s.centralStatus] ?? 0) > (CENTRAL_RANK[cur.central_status] ?? 0) ? s.centralStatus : cur.central_status;
  const nextCase = cur.central_case_id || s.centralCaseId || null;
  const changed = (nextState === 'synced') !== (cur.status === 'synced')
    || nextCentral !== cur.central_status || nextCase !== cur.central_case_id;
  if (!changed) return false;
  db.prepare(`UPDATE sync_queue SET status = ?, central_status = ?, central_case_id = ?, updated_at = ? WHERE capture_id = ?`)
    .run(nextState === 'synced' ? 'synced' : cur.status, nextCentral, nextCase, now, s.captureId);
  return true;
}

const APPLY = { patient: applyPatient, capture: applyCapture, questionnaire: applyQuestionnaire, metadata: applyMetadata, syncState: applySyncState };

/**
 * Applies a batch from `origin` in one transaction. The origin is written to
 * sync_ctx for the duration, so the change feed tags these rows as the
 * phone's own and does not send them back to it.
 */
function applyRecords(records, origin) {
  const sorted = [...records].sort((a, b) => APPLY_ORDER.indexOf(a.kind) - APPLY_ORDER.indexOf(b.kind));
  let applied = 0, skipped = 0;
  db.transaction(() => {
    db.prepare('UPDATE sync_ctx SET origin = ? WHERE id = 1').run(origin);
    try {
      for (const r of sorted) {
        const fn = APPLY[r.kind];
        if (!fn) { skipped += 1; continue; }
        if (fn(r.data)) applied += 1; else skipped += 1;
      }
    } finally {
      db.prepare('UPDATE sync_ctx SET origin = NULL WHERE id = 1').run();
    }
  })();
  return { applied, skipped };
}

// ── Images ──────────────────────────────────────────────────────────────────

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp'];

function existingImagePath(captureId) {
  const row = db.prepare('SELECT image_path FROM captures WHERE capture_id = ?').get(captureId);
  if (row && fs.existsSync(row.image_path)) return row.image_path;
  for (const ext of IMAGE_EXT) {
    const p = path.join(STORAGE_DIR, `${captureId}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readImage(captureId) {
  const p = existingImagePath(captureId);
  if (!p) return null;
  const bytes = fs.readFileSync(p);
  return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ext: path.extname(p).toLowerCase() };
}

function writeImage(captureId, bytes, sha256, ext = '.jpg') {
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 && actual !== sha256) {
    throw Object.assign(new Error('image checksum mismatch'), { code: 'checksum_mismatch' });
  }
  const safeExt = IMAGE_EXT.includes(String(ext).toLowerCase()) ? String(ext).toLowerCase() : '.jpg';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(captureId)) throw Object.assign(new Error('bad capture id'), { code: 'invalid_field' });
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const p = path.join(STORAGE_DIR, `${captureId}${safeExt}`);
  fs.writeFileSync(p, bytes);
  return p;
}


function ownsUpload(ownerDevice) {
  const me = db.deviceId();
  if (!ownerDevice || ownerDevice === me) return true;
  const peer = db.prepare('SELECT last_seen_at FROM peer_devices WHERE device_id = ?').get(ownerDevice);
  const lastSeen = peer?.last_seen_at ? Date.parse(peer.last_seen_at) : 0;
  return Date.now() - lastSeen > TAKEOVER_MS;
}

module.exports = {
  changesSince, applyRecords, readImage, writeImage, existingImagePath, ownsUpload,
  toWire, KIND, TABLE_OF, TAKEOVER_MS,
};
