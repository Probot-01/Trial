
import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { getDb, kvGet, kvSet, nowIso } from '../db/database';
import { getPairing, Pairing } from './pairing';
import { hello, IMAGE_TIMEOUT_MS, peerCall, PeerError } from './peerClient';
import { bundleAad, keyFromB64, openJson, seal, Envelope } from './peerCrypto';
import { fromBase64, toBase64, toHex } from './bytes';
import type { QualityResult } from '../types';

export type WireKind = 'patient' | 'capture' | 'questionnaire' | 'metadata' | 'syncState';
export interface WireRecord { kind: WireKind; data: Record<string, any> }

const APPLY_ORDER: WireKind[] = ['patient', 'capture', 'questionnaire', 'metadata', 'syncState'];
const TABLE: Record<WireKind, { table: string; pk: string }> = {
  patient: { table: 'patients', pk: 'patient_id' },
  capture: { table: 'captures', pk: 'capture_id' },
  questionnaire: { table: 'questionnaire_responses', pk: 'response_id' },
  metadata: { table: 'capture_metadata_responses', pk: 'response_id' },
  syncState: { table: 'sync_queue', pk: 'capture_id' },
};
const KIND_OF: Record<string, WireKind> = Object.fromEntries(Object.entries(TABLE).map(([k, v]) => [v.table, k as WireKind]));
const STATE_RANK: Record<string, number> = { pending: 0, summary_sent: 1, synced: 2 };
const CENTRAL_RANK: Record<string, number> = { awaiting_image: 1, processing: 2, graded: 3, error: 3 };
const TAKEOVER_MS = 6 * 3600 * 1000;
const PUSH_BATCH = 100;

const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const J = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

// ── Ownership (who uploads a capture to central) ────────────────────────────

/** Mirrors the PC's rule: the capturing device uploads; the other takes over after 6 h of silence. */
export async function ownsUpload(owner: string | null): Promise<boolean> {
  const p = await getPairing();
  if (!p || !owner || owner === p.deviceId) return true;
  const lastSeen = Date.parse((await kvGet('peer_last_seen')) ?? '') || 0;
  return Date.now() - lastSeen > TAKEOVER_MS;
}

// ── Local rows -> wire ──────────────────────────────────────────────────────

async function toWire(tbl: string, row: any, me: string): Promise<WireRecord | null> {
  switch (tbl) {
    case 'patients':
      return {
        kind: 'patient', data: {
          patientId: row.patient_id, name: row.name, age: row.age, contactNumber: row.contact_number,
          consentGivenAt: row.consent_given_at, registeredAt: row.registered_at, duplicateOf: row.duplicate_of,
          demographics: parse(row.demographics_json), questionnaire: parse(row.questionnaire_json),
          updatedAt: row.updated_at || row.registered_at, originDevice: row.origin_device || me,
        }
      };
    case 'captures': {
      const q: QualityResult | null = parse(row.quality_scores_json);
      return {
        kind: 'capture', data: {
          captureId: row.capture_id, patientId: row.patient_id, eye: row.eye, cameraDeviceId: row.camera_device_id,
          source: row.source, qualityStatus: row.quality_status, qualityReason: row.quality_reason,
          qualityScores: q ? { ...q.scores, compositeScore: q.compositeScore, preset: q.preset, analysedAt: q.analysedAt } : null,
          qualityEngine: parse(row.quality_engine),
          retakeCount: row.retake_count, bestEffort: !!row.best_effort, capturedAt: row.captured_at,
          imageBytes: row.image_bytes, imageSha256: row.image_sha256, originDevice: row.origin_device || me,
        }
      };
    }
    case 'questionnaire_responses':
      return {
        kind: 'questionnaire', data: {
          responseId: row.response_id, captureId: row.capture_id, riskFactorFields: parse(row.risk_factor_fields),
          symptomFields: parse(row.symptom_fields), language: row.language, recordedAt: row.recorded_at,
        }
      };
    case 'capture_metadata_responses':
      return {
        kind: 'metadata', data: {
          responseId: row.response_id, captureId: row.capture_id, cameraDeviceReported: row.camera_device_reported,
          pupilStatus: row.pupil_status, lightingEnvironment: row.lighting_environment,
          observedIssues: parse(row.observed_issues) ?? [], workerUsabilityRating: row.worker_usability_rating,
          eyeLaterality: row.eye_laterality, recordedAt: row.recorded_at,
        }
      };
    case 'sync_queue':
      return {
        kind: 'syncState', data: {
          captureId: row.capture_id, state: row.state === 'failed' ? 'pending' : row.state,
          centralCaseId: row.central_case_id, centralStatus: row.central_status, priority: row.priority_tier,
          ownerDevice: row.owner_device || me, updatedAt: row.updated_at,
        }
      };
    default:
      return null;
  }
}

/**
 * Local changes after `cursor` that the PC has not got, oldest first.
 * A capture travels only once it is queued (or failed the gate, as retake
 * evidence): an in-progress capture is not a case yet, and may be discarded.
 */
export async function localChangesSince(cursor: number, excludeOrigin: string, me: string, limit = 500) {
  const db = await getDb();
  const rows = await db.getAllAsync<{ tbl: string; pk: string; seq: number }>(
    `SELECT tbl, pk, MAX(seq) AS seq FROM change_log
     WHERE seq > ? AND (origin IS NULL OR origin <> ?)
     GROUP BY tbl, pk ORDER BY seq LIMIT ?`, [cursor, excludeOrigin, limit + 1]);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const records: WireRecord[] = [];
  for (const { tbl, pk } of page) {
    const kind = KIND_OF[tbl];
    if (!kind) continue;
    const row = await db.getFirstAsync<any>(`SELECT * FROM ${tbl} WHERE ${TABLE[kind].pk} = ?`, [pk]);
    if (!row) continue;
    if (tbl === 'captures' && row.quality_status !== 'retake') {
      const queued = await db.getFirstAsync('SELECT 1 FROM sync_queue WHERE capture_id = ?', [pk]);
      if (!queued) continue;
    }
    const w = await toWire(tbl, row, me);
    if (w) records.push(w);
  }
  records.sort((a, b) => APPLY_ORDER.indexOf(a.kind) - APPLY_ORDER.indexOf(b.kind));
  const maxSeq = (await db.getFirstAsync<{ m: number | null }>('SELECT MAX(seq) AS m FROM change_log'))?.m ?? 0;
  const last = page.length ? page[page.length - 1].seq : cursor;
  return { records, cursor: more ? last : Math.max(last, maxSeq), more };
}

// ── Wire -> local rows ──────────────────────────────────────────────────────

function qualityFromWire(c: any): QualityResult | null {
  const s = c.qualityScores;
  if (!s) return null;
  const scores = {
    focusScore: s.focusScore ?? 0, illuminationScore: s.illuminationScore ?? 0, fovScore: s.fovScore ?? 0,
    coveragePercent: s.coveragePercent ?? 0, glareScore: s.glareScore ?? 0, motionScore: s.motionScore ?? 0,
    occlusionScore: s.occlusionScore ?? 0,
  };
  return {
    status: c.qualityStatus, reason: c.qualityReason ?? null, scores,
    compositeScore: s.compositeScore ?? (scores.focusScore + scores.illuminationScore + scores.fovScore) / 3,
    preset: s.preset ?? (c.cameraDeviceId === 'mobile_lens' ? 'mobile_lens' : 'default'),
    analysedAt: s.analysedAt ?? 'on the PHC PC',
  };
}

type Tx = { runAsync: (sql: string, params?: any[]) => Promise<{ changes: number }>; getFirstAsync: <T>(sql: string, params?: any[]) => Promise<T | null> };

async function applyOne(tx: Tx, r: WireRecord): Promise<boolean> {
  const d = r.data;
  switch (r.kind) {
    case 'patient': {
      const cur = await tx.getFirstAsync<any>('SELECT updated_at, registered_at, origin_device FROM patients WHERE patient_id = ?', [d.patientId]);
      if (cur) {
        const curAt = cur.updated_at || cur.registered_at;
        const wins = d.updatedAt > curAt || (d.updatedAt === curAt && String(d.originDevice) > String(cur.origin_device ?? ''));
        if (!wins) return false;
        await tx.runAsync(`UPDATE patients SET name = ?, age = ?, contact_number = ?, consent_given_at = COALESCE(consent_given_at, ?),
            duplicate_of = ?, demographics_json = ?, questionnaire_json = ?, updated_at = ?, origin_device = ? WHERE patient_id = ?`,
          [d.name, d.age, d.contactNumber, d.consentGivenAt, d.duplicateOf ?? null, J(d.demographics), J(d.questionnaire), d.updatedAt, d.originDevice, d.patientId]);
        return true;
      }
      await tx.runAsync(`INSERT INTO patients (patient_id, name, age, contact_number, consent_given_at, duplicate_of, registered_at,
          demographics_json, questionnaire_json, updated_at, origin_device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.patientId, d.name, d.age, d.contactNumber, d.consentGivenAt, d.duplicateOf ?? null, d.registeredAt,
        J(d.demographics), J(d.questionnaire), d.updatedAt ?? d.registeredAt, d.originDevice]);
      return true;
    }
    case 'capture': {
      if (await tx.getFirstAsync('SELECT 1 FROM captures WHERE capture_id = ?', [d.captureId])) return false;
      const img = imageFileFor(d.captureId);
      if (!img) throw new PeerError('image_missing', `image for ${d.captureId} not received`);
      await tx.runAsync(`INSERT INTO captures (capture_id, patient_id, eye, camera_device_id, source, image_path, image_bytes, quality_status,
          quality_reason, quality_scores_json, quality_engine, retake_count, best_effort, captured_at, origin_device, image_sha256)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.captureId, d.patientId, d.eye ?? null, d.cameraDeviceId ?? 'unknown', d.source ?? 'desktop', img.uri, img.size,
        d.qualityStatus, d.qualityReason ?? null, J(qualityFromWire(d)), J(d.qualityEngine), d.retakeCount ?? 0, d.bestEffort ? 1 : 0, d.capturedAt,
        d.originDevice, d.imageSha256 ?? null]);
      return true;
    }
    case 'questionnaire': {
      const res = await tx.runAsync(`INSERT OR IGNORE INTO questionnaire_responses (response_id, capture_id, risk_factor_fields, symptom_fields, language, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?)`, [d.responseId, d.captureId, J(d.riskFactorFields), J(d.symptomFields), d.language ?? null, d.recordedAt]);
      return res.changes > 0;
    }
    case 'metadata': {
      const res = await tx.runAsync(`INSERT OR IGNORE INTO capture_metadata_responses (response_id, capture_id, camera_device_reported, pupil_status,
          lighting_environment, observed_issues, worker_usability_rating, eye_laterality, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.responseId, d.captureId, d.cameraDeviceReported ?? null, d.pupilStatus ?? 'unknown', d.lightingEnvironment ?? 'indoor_clinic',
        J(d.observedIssues ?? []), d.workerUsabilityRating ?? 'not_sure', d.eyeLaterality ?? null, d.recordedAt]);
      return res.changes > 0;
    }
    case 'syncState': {
      const now = nowIso();
      const cur = await tx.getFirstAsync<any>('SELECT * FROM sync_queue WHERE capture_id = ?', [d.captureId]);
      if (!cur) {
        const synced = d.state === 'synced';
        await tx.runAsync(`INSERT INTO sync_queue (capture_id, priority_tier, state, central_case_id, central_status, summary_sent_at, uploaded_at,
            attempts, enqueued_at, updated_at, owner_device) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          [d.captureId, Number.isInteger(d.priority) ? d.priority : 2, synced ? 'synced' : 'pending', d.centralCaseId ?? null,
          d.centralStatus ?? null, synced ? now : null, synced ? now : null, now, now, d.ownerDevice ?? null]);
        return true;
      }
      const curRank = cur.state === 'failed' ? -1 : STATE_RANK[cur.state] ?? 0;
      const inRank = STATE_RANK[d.state] ?? 0;
      const nextState = inRank > curRank ? d.state : cur.state;
      const nextCentral = (CENTRAL_RANK[d.centralStatus] ?? 0) > (CENTRAL_RANK[cur.central_status] ?? 0) ? d.centralStatus : cur.central_status;
      const nextCase = cur.central_case_id || d.centralCaseId || null;
      if (nextState === cur.state && nextCentral === cur.central_status && nextCase === cur.central_case_id) return false;
      await tx.runAsync(`UPDATE sync_queue SET state = ?, central_status = ?, central_case_id = ?,
          uploaded_at = CASE WHEN ? = 'synced' AND uploaded_at IS NULL THEN ? ELSE uploaded_at END,
          last_error_code = CASE WHEN ? = 'synced' THEN NULL ELSE last_error_code END, updated_at = ? WHERE capture_id = ?`,
        [nextState, nextCentral, nextCase, nextState, now, nextState, now, d.captureId]);
      return true;
    }
    default:
      return false;
  }
}

/** Applies records from `origin` atomically; rows are tagged so they are not pushed back. */
export async function applyRecords(records: WireRecord[], origin: string): Promise<{ applied: number; skipped: number }> {
  const db = await getDb();
  const sorted = [...records].sort((a, b) => APPLY_ORDER.indexOf(a.kind) - APPLY_ORDER.indexOf(b.kind));
  let applied = 0, skipped = 0;
  await db.withExclusiveTransactionAsync(async (tx) => {
    await tx.runAsync('UPDATE sync_ctx SET origin = ? WHERE id = 1', [origin]);
    try {
      for (const r of sorted) (await applyOne(tx as unknown as Tx, r)) ? applied++ : skipped++;
    } finally {
      await tx.runAsync('UPDATE sync_ctx SET origin = NULL WHERE id = 1', []);
    }
  });
  return { applied, skipped };
}

// ── Images ──────────────────────────────────────────────────────────────────

const capturesDir = () => new Directory(Paths.document, 'captures');
const EXTS = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp'];

function imageFileFor(captureId: string): { uri: string; size: number } | null {
  for (const ext of EXTS) {
    const f = new File(capturesDir(), `${captureId}${ext}`);
    if (f.exists) return { uri: f.uri, size: f.size ?? 0 };
  }
  return null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as unknown as BufferSource)));
}

async function storeImage(captureId: string, bytes: Uint8Array, sha256: string, ext: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(captureId)) throw new PeerError('invalid_field', 'bad capture id');
  if ((await sha256Hex(bytes)) !== sha256) throw new PeerError('checksum_mismatch', `image ${captureId} failed its checksum`);
  const dir = capturesDir();
  dir.create({ intermediates: true, idempotent: true });
  const f = new File(dir, `${captureId}${EXTS.includes(ext) ? ext : '.jpg'}`);
  if (f.exists) f.delete();
  f.create();
  f.write(bytes);
}

async function readImagePayload(captureId: string): Promise<{ bytesB64: string; sha256: string; ext: string } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ image_path: string }>('SELECT image_path FROM captures WHERE capture_id = ?', [captureId]);
  if (!row) return null;
  const f = new File(row.image_path);
  if (!f.exists) return null;
  const bytes = await f.bytes();
  const ext = (/\.[a-z]+$/i.exec(row.image_path)?.[0] ?? '.jpg').toLowerCase();
  return { bytesB64: toBase64(bytes), sha256: await sha256Hex(bytes), ext };
}

// ── One replication pass ────────────────────────────────────────────────────

export interface ReplicationResult { pushed: number; pulled: number; imagesSent: number; imagesReceived: number }

let token: string | null = null;
export function setPeerToken(t: string | null) { token = t; }
const withToken = (body: object) => (token ? { ...body, token } : body);

export async function replicateWithPc(): Promise<ReplicationResult> {
  const p = await getPairing();
  if (!p) throw new PeerError('not_paired', 'Not paired with a PHC PC.');
  await hello();
  await kvSet('peer_last_seen', nowIso());
  const out: ReplicationResult = { pushed: 0, pulled: 0, imagesSent: 0, imagesReceived: 0 };
  const db = await getDb();

  // Push: images first (the PC refuses a capture record without its image).
  let pushCursor = Number((await kvGet('peer_push_cursor')) ?? 0);
  for (; ;) {
    const page = await localChangesSince(pushCursor, p.pcDeviceId, p.deviceId, PUSH_BATCH);
    for (const r of page.records.filter((x) => x.kind === 'capture')) {
      const sent = await db.getFirstAsync('SELECT 1 FROM peer_images_sent WHERE capture_id = ?', [r.data.captureId]);
      if (sent) continue;
      const img = await readImagePayload(r.data.captureId);
      if (!img) continue;
      await peerCall('/peer/image/put', withToken({ captureId: r.data.captureId, ...img }), { timeoutMs: IMAGE_TIMEOUT_MS });
      await db.runAsync('INSERT OR REPLACE INTO peer_images_sent (capture_id, sent_at) VALUES (?, ?)', [r.data.captureId, nowIso()]);
      out.imagesSent++;
    }
    if (page.records.length) {
      await peerCall('/peer/push', withToken({ records: page.records }));
      out.pushed += page.records.length;
    }
    pushCursor = page.cursor;
    await kvSet('peer_push_cursor', String(pushCursor));
    if (!page.more) break;
  }

  // Pull: fetch each new capture's image before applying its record.
  let pullCursor = Number((await kvGet('peer_pull_cursor')) ?? 0);
  for (; ;) {
    const page = await peerCall<{ records: WireRecord[]; cursor: number; more: boolean }>('/peer/pull', withToken({ cursor: pullCursor }));
    for (const r of page.records.filter((x) => x.kind === 'capture')) {
      if (imageFileFor(r.data.captureId)) continue;
      const img = await peerCall<{ bytesB64: string; sha256: string; ext: string }>('/peer/image/get', withToken({ captureId: r.data.captureId }), { timeoutMs: IMAGE_TIMEOUT_MS });
      await storeImage(r.data.captureId, fromBase64(img.bytesB64), img.sha256, img.ext);
      await db.runAsync('INSERT OR REPLACE INTO peer_images_sent (capture_id, sent_at) VALUES (?, ?)', [r.data.captureId, nowIso()]);
      out.imagesReceived++;
    }
    if (page.records.length) {
      await applyRecords(page.records, p.pcDeviceId);
      out.pulled += page.records.length;
    }
    pullCursor = page.cursor;
    await kvSet('peer_pull_cursor', String(pullCursor));
    if (!page.more) break;
  }
  await kvSet('peer_last_sync', nowIso());
  return out;
}

// ── Bundles (no network at all) ─────────────────────────────────────────────

export interface Bundle { kind: 'netrasetu-bundle'; v: 1; fromDevice: string; toDevice: string; createdAt: string; envelope: Envelope }

/** Everything the PC has not received yet, with images, sealed for the paired PC. */
export async function buildBundle(): Promise<{ bundle: Bundle; records: number; images: number }> {
  const p = await getPairing();
  if (!p) throw new PeerError('not_paired', 'Pair with the PHC PC first: the bundle is encrypted for it.');
  const records: WireRecord[] = [];
  let cursor = Number((await kvGet('peer_push_cursor')) ?? 0);
  for (; ;) {
    const page = await localChangesSince(cursor, p.pcDeviceId, p.deviceId);
    records.push(...page.records);
    cursor = page.cursor;
    if (!page.more) break;
  }
  const images: Record<string, { bytesB64: string; sha256: string; ext: string }> = {};
  for (const r of records) {
    if (r.kind !== 'capture') continue;
    const img = await readImagePayload(r.data.captureId);
    if (img) images[r.data.captureId] = img;
  }
  const header = { kind: 'netrasetu-bundle' as const, v: 1 as const, fromDevice: p.deviceId, toDevice: p.pcDeviceId, createdAt: nowIso() };
  const bundle: Bundle = { ...header, envelope: seal(keyFromB64(p.key), { records, images }, bundleAad(header)) };
  return { bundle, records: records.length, images: Object.keys(images).length };
}

/** Opens a bundle the PC exported for this phone and applies it. */
export async function importBundle(bundle: Bundle): Promise<{ applied: number; skipped: number; records: number }> {
  const p: Pairing | null = await getPairing();
  if (!p) throw new PeerError('not_paired', 'Pair with the PHC PC first.');
  if (bundle?.kind !== 'netrasetu-bundle' || bundle.v !== 1) throw new PeerError('bundle_invalid', 'Not a NetraSetu bundle.');
  if (bundle.toDevice !== p.deviceId || bundle.fromDevice !== p.pcDeviceId) {
    throw new PeerError('bundle_wrong_recipient', 'This bundle was made for a different device.');
  }
  const payload = openJson<{ records: WireRecord[]; images: Record<string, { bytesB64: string; sha256: string; ext: string }> }>(
    keyFromB64(p.key), bundle.envelope, bundleAad(bundle));
  for (const [captureId, img] of Object.entries(payload.images ?? {})) {
    if (!imageFileFor(captureId)) await storeImage(captureId, fromBase64(img.bytesB64), img.sha256, img.ext);
  }
  const res = await applyRecords(payload.records ?? [], p.pcDeviceId);
  return { ...res, records: (payload.records ?? []).length };
}
