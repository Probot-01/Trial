'use strict';


const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('../db/localDb');
const syncState = require('./syncState');
const { FORMS_COMPLETE_SQL, countPending } = require('./syncReadiness');

if (!process.env.CENTRAL_API_URL && process.env.CENTRAL_URL) {
  console.warn('[syncManager] CENTRAL_URL is deprecated; rename it to CENTRAL_API_URL.');
}
const CENTRAL_URL = (process.env.CENTRAL_API_URL || process.env.CENTRAL_URL || '').replace(/\/+$/, '');
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL_MS || '10000', 10);
const HEALTH_TIMEOUT = parseInt(process.env.SYNC_HEALTH_TIMEOUT_MS || '3000', 10);
const UPLOAD_TIMEOUT = parseInt(process.env.SYNC_UPLOAD_TIMEOUT_MS || '600000', 10);


const CHUNK_THRESHOLD = parseInt(process.env.SYNC_CHUNK_THRESHOLD_BYTES || String(2 * 1024 * 1024), 10);

const CHUNK_SIZE = parseInt(process.env.SYNC_CHUNK_BYTES || String(1024 * 1024), 10);

const CHUNK_TIMEOUT = parseInt(process.env.SYNC_CHUNK_TIMEOUT_MS || '120000', 10);


const BACKOFF_BASE_MS = parseInt(process.env.SYNC_BACKOFF_BASE_MS || '30000', 10);
const BACKOFF_MAX_MS = parseInt(process.env.SYNC_BACKOFF_MAX_MS || String(15 * 60 * 1000), 10);


const POLL_BATCH = parseInt(process.env.SYNC_POLL_BATCH || '25', 10);

const CENTRAL_STATUSES = new Set(['awaiting_image', 'processing', 'graded', 'error']);

const PHC_ID = process.env.PHC_ID || null;


const PHC_API_KEY = process.env.PHC_API_KEY || null;


function centralHeaders(extra = {}) {
  return PHC_API_KEY ? { ...extra, 'x-phc-api-key': PHC_API_KEY } : extra;
}

let timer = null;
let running = false;   // guards against a slow cycle overlapping the next tick


async function isOnline() {
  if (!CENTRAL_URL) return false;
  try {

    const res = await fetch(`${CENTRAL_URL}/health`, {
      headers: centralHeaders(),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Everything the central ingestion endpoint needs for one capture. */
function loadCaseBundle(captureId) {
  const capture = db.prepare('SELECT * FROM captures WHERE capture_id = ?').get(captureId);
  if (!capture) return null;

  const patient = db.prepare('SELECT * FROM patients WHERE patient_id = ?')
    .get(capture.patient_id);

  const questionnaire = db.prepare(
    'SELECT * FROM questionnaire_responses WHERE capture_id = ? ORDER BY recorded_at DESC LIMIT 1'
  ).get(captureId);

  const metadata = db.prepare(
    'SELECT * FROM capture_metadata_responses WHERE capture_id = ? ORDER BY recorded_at DESC LIMIT 1'
  ).get(captureId);

  return { capture, patient, questionnaire, metadata };
}


function buildCaseFields({ capture, patient, questionnaire, metadata }) {
  const fields = {
    patientId: capture.patient_id,
    captureIdRef: capture.capture_id,
    cameraDeviceId: capture.camera_device_id || 'unknown',

    capturedAt: capture.captured_at,
  };

  if (PHC_ID) fields.phcId = PHC_ID;

  if (patient) {
    fields.patientName = patient.name;
    fields.patientAge = String(patient.age);
    fields.patientContactNumber = patient.contact_number;

    if (patient.consent_given_at) fields.consentGivenAt = patient.consent_given_at;
  }


  if (questionnaire) {
    fields.questionnaireData = JSON.stringify({
      riskFactors: JSON.parse(questionnaire.risk_factor_fields),
      symptoms: JSON.parse(questionnaire.symptom_fields),
      language: questionnaire.language,
    });
  }
  if (metadata) {
    fields.captureMetadata = JSON.stringify({
      cameraDeviceReported: metadata.camera_device_reported,
      pupilStatus: metadata.pupil_status,
      lightingEnvironment: metadata.lighting_environment,
      observedIssues: JSON.parse(metadata.observed_issues),
      workerUsabilityRating: metadata.worker_usability_rating,
      // §10.4. null for captures recorded before the field was stored.
      eyeLaterality: metadata.eye_laterality ?? null,

      ...(capture.best_effort ? { bestEffort: true } : {}),
    });
  }


  if (capture.quality_scores) {
    fields.qualityScores = capture.quality_scores;
  }

  if (capture.quality_engine) {
    fields.qualityGateEngine = capture.quality_engine;
  }


  fields.pendingCount = String(Math.max(0, countPending() - 1));

  return fields;
}

function imageMime(imagePath) {
  const ext = path.extname(imagePath).toLowerCase() || '.jpg';
  return ext === '.png' ? 'image/png'
    : (ext === '.tif' || ext === '.tiff') ? 'image/tiff'
      : 'image/jpeg';
}

function buildFormData(bundle) {
  const form = new FormData();
  for (const [k, v] of Object.entries(buildCaseFields(bundle))) form.append(k, v);

  const imagePath = bundle.capture.image_path;
  const buf = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase() || '.jpg';
  form.append('image', new Blob([buf], { type: imageMime(imagePath) }), `image${ext}`);

  return form;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');


class SyncError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
    this.status = status;
  }
}

/** Parse a response body as JSON, or null (an HTML error page, an empty body). */
async function readBody(res) {
  const text = await res.text().catch(() => '');
  try { return { text, json: text ? JSON.parse(text) : null }; } catch { return { text, json: null }; }
}

/** SyncError for a non-2xx answer, quoting central's { error, message } when it sent one. */
function httpError(context, res, body) {
  const said = body.json && (body.json.error || body.json.message)
    ? `${body.json.error || ''}${body.json.error && body.json.message ? ': ' : ''}${body.json.message || ''}`
    : body.text.slice(0, 160);
  return new SyncError(res.status >= 500 ? 'server' : 'rejected',
    `${context} -> central answered ${res.status}${said ? ` (${said})` : ''}`, res.status);
}

/** Any fetch/abort failure becomes a 'network' SyncError; SyncErrors pass through. */
function asSyncError(err) {
  if (err instanceof SyncError) return err;
  const code = err && err.cause && err.cause.code;
  const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return new SyncError('network', timedOut
    ? 'central did not answer in time'
    : `cannot reach central${code ? ` (${code})` : ''}: ${err && err.message}`);
}


function acceptedCase(res, json) {
  const created = res.status === 201;
  const duplicate = res.status === 200 && !!json && json.duplicate === true;
  if (!(created || duplicate) || !json || typeof json.caseId !== 'string' || !json.caseId) {
    throw new SyncError('server',
      `central answered ${res.status} but not with an accepted case `
      + '(expected 201, or 200 with duplicate:true, and a caseId)', res.status);
  }
  return {
    caseId: json.caseId,
    status: CENTRAL_STATUSES.has(json.status) ? json.status : 'processing',
    duplicate,
  };
}

/**

 *
 * @param {object} bundle
 * @param {{onProgress?: function(sent:number,total:number)}} [opts]
 * @returns {Promise<{caseId, status, duplicate}>} once central has ACCEPTED it
 * @throws {SyncError}
 */
async function uploadChunked({ capture, patient, questionnaire, metadata }, { onProgress } = {}) {
  const bundle = { capture, patient, questionnaire, metadata };
  const imagePath = capture.image_path;
  const buf = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase() || '.jpg';
  const totalChunks = Math.ceil(buf.length / CHUNK_SIZE);
  const captureRef = capture.capture_id;

  const base = `${CENTRAL_URL}/api/v1/cases/${encodeURIComponent(captureRef)}/chunks`;

  try {
    const initRes = await fetch(`${base}/init`, {
      method: 'POST',
      headers: centralHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        ...buildCaseFields(bundle),
        totalChunks,
        totalBytes: buf.length,
        sha256: sha256(buf),
        filename: `image${ext}`,
      }),
      signal: AbortSignal.timeout(CHUNK_TIMEOUT),
    });
    const initBody = await readBody(initRes);
    if (!initRes.ok) throw httpError('chunk init', initRes, initBody);
    const session = initBody.json || {};

    if (session.alreadyIngested) {
      if (typeof session.caseId !== 'string' || !session.caseId) {
        throw new SyncError('server', 'central says the capture is already ingested but named no case', initRes.status);
      }
      return { caseId: session.caseId, status: 'processing', duplicate: true };
    }

    const missing = session.missing ?? [...Array(totalChunks).keys()];
    if (session.resumed && missing.length < totalChunks) {
      console.log(`[syncManager] resuming ${captureRef}: `
        + `${totalChunks - missing.length}/${totalChunks} chunks already there`);
    }
    if (onProgress) onProgress(totalChunks - missing.length, totalChunks);

    let sent = totalChunks - missing.length;
    for (const i of missing) {
      const slice = buf.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, buf.length));
      const form = new FormData();
      form.append('sha256', sha256(slice));
      form.append('chunk', new Blob([slice], { type: 'application/octet-stream' }), `${i}.part`);

      const res = await fetch(`${base}/${i}`, {
        method: 'POST', headers: centralHeaders(), body: form,
        signal: AbortSignal.timeout(CHUNK_TIMEOUT),
      });
      if (!res.ok) {

        throw httpError(`chunk ${i + 1}/${totalChunks}`, res, await readBody(res));
      }
      sent += 1;
      if (onProgress) onProgress(sent, totalChunks);
    }

    const doneRes = await fetch(`${base}/complete`, {
      method: 'POST', headers: centralHeaders(), signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
    });
    const doneBody = await readBody(doneRes);
    if (!doneRes.ok) throw httpError('chunk complete', doneRes, doneBody);
    return acceptedCase(doneRes, doneBody.json);
  } catch (err) {
    throw asSyncError(err);
  }
}

/**
 * syncOnce()
 *
 * One full cycle: heartbeat, then drain what is pending.
 *
 * @returns {Promise<{online, attempted, synced, failed}>}
 */
async function syncOnce() {
  const nowIso = new Date().toISOString();

  const online = await isOnline();
  syncState.recordAttempt(online, nowIso);

  if (!online) {

    return { online: false, attempted: 0, synced: 0, failed: 0 };
  }


  const { ownsUpload } = require('./peerSync');
  const pending = db.prepare(`
    SELECT q.queue_id, q.capture_id, q.priority, q.owner_device, q.attempts
    FROM sync_queue q
    JOIN captures c ON c.capture_id = q.capture_id
    WHERE q.status = 'pending'
      AND ${FORMS_COMPLETE_SQL}
      AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
    ORDER BY CASE q.priority WHEN 'high' THEN 0 ELSE 1 END, c.captured_at ASC, c.capture_id ASC
  `).all(nowIso).filter((r) => ownsUpload(r.owner_device));

  let synced = 0, failed = 0;

  for (const row of pending) {
    // Stamp the attempt before trying, so a crash mid-upload still leaves
    // evidence that this row was reached.
    db.prepare('UPDATE sync_queue SET last_attempt_at = ? WHERE queue_id = ?')
      .run(new Date().toISOString(), row.queue_id);

    let bytes = 0;
    try {
      const bundle = loadCaseBundle(row.capture_id);
      if (!bundle) throw new SyncError('server', `capture ${row.capture_id} is missing from the local database`);
      if (!fs.existsSync(bundle.capture.image_path)) {
        throw new SyncError('server', `image file is missing at ${bundle.capture.image_path}`);
      }

      // Task 8.2: chunk the big ones, post the small ones whole.
      bytes = fs.statSync(bundle.capture.image_path).size;
      let accepted;

      if (bytes > CHUNK_THRESHOLD) {
        accepted = await uploadChunked(bundle, {
          onProgress: (sent, total) => db.prepare(
            'UPDATE sync_queue SET chunks_sent = ?, chunks_total = ? WHERE queue_id = ?')
            .run(sent, total, row.queue_id),
        });
      } else {
        let res;
        try {
          res = await fetch(`${CENTRAL_URL}/api/v1/cases`, {
            method: 'POST',
            headers: centralHeaders(),
            body: buildFormData(bundle),
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
          });
        } catch (err) { throw asSyncError(err); }
        const body = await readBody(res);
        if (!res.ok) throw httpError('upload', res, body);
        accepted = acceptedCase(res, body.json);
      }

      db.prepare(`UPDATE sync_queue
                  SET status = 'synced', central_case_id = ?, central_status = ?, updated_at = ?,
                      last_error = NULL, error_kind = NULL, attempts = 0, next_attempt_at = NULL
                  WHERE queue_id = ?`)
        .run(accepted.caseId, accepted.status, new Date().toISOString(), row.queue_id);
      synced++;
      console.log(`[syncManager] ${row.capture_id} -> case ${accepted.caseId}`
        + `${accepted.duplicate ? ' (central already had it)' : ''}`
        + `${bytes > CHUNK_THRESHOLD ? ` (chunked, ${(bytes / 1048576).toFixed(1)} MB)` : ''}`);
    } catch (raw) {

      const err = asSyncError(raw);
      failed++;
      const attempts = (row.attempts || 0) + 1;
      const backoffMs = err.kind === 'network' ? 0
        : Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
      db.prepare(`UPDATE sync_queue
                  SET last_error = ?, error_kind = ?, attempts = ?, next_attempt_at = ?, updated_at = ?
                  WHERE queue_id = ?`)
        .run(err.message.slice(0, 500), err.kind, attempts,
          backoffMs ? new Date(Date.now() + backoffMs).toISOString() : null,
          new Date().toISOString(), row.queue_id);
      console.warn(`[syncManager] ${row.capture_id} not synced (${err.kind}), staying pending`
        + `${backoffMs ? `, retry in ${Math.round(backoffMs / 1000)}s` : ''}: ${err.message}`);


      if (err.kind === 'network') break;
    }
  }

  await pollResults();

  return { online: true, attempted: pending.length, synced, failed };
}


async function pollResults() {
  const rows = db.prepare(`
    SELECT queue_id, capture_id, central_case_id, central_status
    FROM sync_queue
    WHERE status = 'synced' AND central_case_id IS NOT NULL
      AND COALESCE(central_status, '') NOT IN ('graded', 'error')
    ORDER BY COALESCE(updated_at, '') ASC
    LIMIT ?
  `).all(POLL_BATCH);

  let changed = 0;
  for (const row of rows) {
    let res;
    try {
      res = await fetch(`${CENTRAL_URL}/api/v1/cases/${encodeURIComponent(row.central_case_id)}/status`, {
        headers: centralHeaders(), signal: AbortSignal.timeout(HEALTH_TIMEOUT),
      });
    } catch {
      break;   // link went away; the next heartbeat will say so
    }
    const body = await readBody(res);
    if (!res.ok) {
      console.warn(`[syncManager] status of case ${row.central_case_id} (${row.capture_id}): `
        + `central answered ${res.status}${body.json && body.json.error ? ` ${body.json.error}` : ''}`);
      continue;
    }
    const status = body.json && body.json.status;
    if (!CENTRAL_STATUSES.has(status)) {
      console.warn(`[syncManager] status of case ${row.central_case_id}: unrecognised answer, ignored`);
      continue;
    }
    if (status !== row.central_status) {
      db.prepare('UPDATE sync_queue SET central_status = ?, updated_at = ? WHERE queue_id = ?')
        .run(status, new Date().toISOString(), row.queue_id);
      changed++;
      console.log(`[syncManager] ${row.capture_id}: central status ${row.central_status} -> ${status}`);
    }
  }
  return { polled: rows.length, changed };
}

/**
 * start(opts)
 *
 * @param {object} [opts]
 * @param {number} [opts.intervalMs]
 * @returns {{stop: function}}
 */
function start({ intervalMs = SYNC_INTERVAL } = {}) {
  if (timer) return { stop };

  const tick = async () => {

    if (running) return;
    running = true;
    try {
      await syncOnce();
    } catch (err) {

      console.error('[syncManager] cycle error:', err.message);
    } finally {
      running = false;
    }
  };

  if (!CENTRAL_URL) {
    console.error('[syncManager] CENTRAL_API_URL is not set -- NOTHING WILL SYNC. '
      + 'Captures are kept in the local queue until it is set and the backend restarted.');
    return { stop };
  }

  timer = setInterval(tick, intervalMs);
  // Do not hold the process open just for the sync loop.
  if (timer.unref) timer.unref();

  console.log(`[syncManager] polling ${CENTRAL_URL} every ${intervalMs}ms`
    + `${PHC_ID ? '' : ' (PHC_ID unset — cases will sync without a PHC attribution)'}`
    + `${PHC_API_KEY ? '' : ' (PHC_API_KEY unset — sync will fail once central enforces PHC keys)'}`);

  tick();   // one immediate pass, so startup does not wait a full interval
  return { stop };
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  start, stop, syncOnce, pollResults, isOnline, countPending, acceptedCase, SyncError,

  uploadChunked, CHUNK_THRESHOLD, CHUNK_SIZE,
};
