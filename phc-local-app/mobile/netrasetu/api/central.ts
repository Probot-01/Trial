
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { getConfig, POLICY } from '../config';
import { CentralStatus, PhcReport, QualityEngine } from '../types';

export class CentralError extends Error {
  constructor(
    public kind: 'network' | 'timeout' | 'http' | 'config',
    public code: string,
    message: string,
    public status: number | null = null,
  ) {
    super(message);
    this.name = 'CentralError';
  }

  /** Worth retrying automatically, without anyone changing anything. */
  get retryable(): boolean {
    if (this.kind === 'network' || this.kind === 'timeout') return true;
    if (this.status === null) return false;
    if (this.status >= 500 || this.status === 429 || this.status === 408) return true;
    // A chunk that arrived corrupted, or a chunk set that is incomplete: resend.
    return ['chunk_checksum_mismatch', 'incomplete_upload', 'checksum_mismatch', 'session_not_found'].includes(this.code);
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const { phcApiKey } = getConfig();
  return {
    Accept: 'application/json',
    ...(phcApiKey ? { 'X-PHC-Api-Key': phcApiKey } : {}),
    ...extra,
  };
}

function url(path: string): string {
  const base = getConfig().centralUrl;
  if (!/^https?:\/\//.test(base)) {
    throw new CentralError('config', 'central_url_invalid', 'The central server address is not set. Open Settings.');
  }
  return `${base}${path}`;
}

async function requestFull<T>(path: string, init: RequestInit, timeoutMs = POLICY.requestTimeoutMs): Promise<{ status: number; body: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url(path), { ...init, headers: headers(init.headers as Record<string, string>), signal: controller.signal });
  } catch (err) {
    if (err instanceof CentralError) throw err;
    if ((err as Error)?.name === 'AbortError') {
      throw new CentralError('timeout', 'timeout', 'The central server did not respond in time.');
    }
    throw new CentralError('network', 'network_unreachable', 'Cannot reach the central server.');
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; message?: string };
    throw new CentralError('http', b.error ?? `http_${res.status}`, b.message ?? `Central server returned ${res.status}.`, res.status);
  }
  return { status: res.status, body: body as T };
}

async function request<T>(path: string, init: RequestInit, timeoutMs = POLICY.requestTimeoutMs): Promise<T> {
  return (await requestFull<T>(path, init, timeoutMs)).body;
}

// ── Health ─────────────────────────────────────────────────────────────────

export async function checkHealth(): Promise<boolean> {
  try {
    const r = await request<{ status: string }>('/health', { method: 'GET' }, 6000);
    return r?.status === 'ok';
  } catch {
    return false;
  }
}

// ── Case submission ────────────────────────────────────────────────────────

/** The case fields shared by POST /cases, /cases/summary and chunk init. phcId is never sent: central pins it from the key. */
export interface CaseFields {
  patientId: string;
  captureIdRef: string;
  cameraDeviceId: string;
  capturedAt: string;
  consentGivenAt: string | null;
  patientName: string;
  patientAge: number;
  patientContactNumber: string;
  questionnaireData: object;
  captureMetadata: object;
  qualityScores: object | null;
  /** Which engine ran the quality gate ("js-device" for this app); null/absent = not recorded. */
  qualityGateEngine?: QualityEngine | null;
  pendingCount: number;
}

export interface IngestResponse {
  caseId: string;
  receivedAt: string;
  status?: CentralStatus;
  duplicate?: boolean;
}


function accepted(r: { status: number; body: IngestResponse | null }, what: string): IngestResponse {
  const b = r.body;
  const ok = (r.status === 201 || (r.status === 200 && b?.duplicate === true)) && typeof b?.caseId === 'string' && b.caseId !== '';
  if (!ok || !b) {
    throw new CentralError('http', 'not_accepted', `Central did not accept the ${what} (HTTP ${r.status}).`, r.status);
  }
  return b;
}

export async function postSummary(f: CaseFields): Promise<IngestResponse> {
  return accepted(await requestFull<IngestResponse>('/api/v1/cases/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(f),
  }), 'case summary');
}

function toMultipart(f: CaseFields): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(f)) {
    if (v === null || v === undefined) continue;
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return form;
}

function mimeFor(uri: string): string {
  if (/\.png$/i.test(uri)) return 'image/png';
  if (/\.tiff?$/i.test(uri)) return 'image/tiff';
  if (/\.bmp$/i.test(uri)) return 'image/bmp';
  return 'image/jpeg';
}

/** Single-shot upload: POST /api/v1/cases. 201 new, 200 duplicate -- both mean central has it. */
export async function postCase(f: CaseFields, imageUri: string): Promise<IngestResponse> {
  const form = toMultipart(f);
  const name = imageUri.split('/').pop() ?? `${f.captureIdRef}.jpg`;
  // React Native's FormData file part.
  form.append('image', { uri: imageUri, name, type: mimeFor(imageUri) } as unknown as Blob);
  return accepted(await requestFull<IngestResponse>('/api/v1/cases', { method: 'POST', body: form }, POLICY.uploadTimeoutMs), 'case');
}

// ── Chunked / resumable upload (Task 8.2) ──────────────────────────────────

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface ChunkSession { received: number[]; missing: number[]; alreadyIngested?: boolean }

/**
 * Uploads a large image in chunks, resuming whatever central already holds.
 * Returns the same shape as POST /cases.
 */
export async function postCaseChunked(f: CaseFields, imageUri: string, onProgress?: (done: number, total: number) => void): Promise<IngestResponse> {
  const bytes = await new File(imageUri).bytes();
  const size = POLICY.chunkSizeBytes;
  const totalChunks = Math.ceil(bytes.length / size);
  const ref = encodeURIComponent(f.captureIdRef);

  const init = await request<ChunkSession>(`/api/v1/cases/${ref}/chunks/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...f,
      totalChunks,
      totalBytes: bytes.length,
      sha256: await sha256Hex(bytes),
      filename: imageUri.split('/').pop() ?? `${f.captureIdRef}.jpg`,
    }),
  });

  if (!init.alreadyIngested) {
    const tmp = new File(Paths.cache, `chunk-${f.captureIdRef}.bin`);
    try {
      let done = totalChunks - init.missing.length;
      for (const index of init.missing) {
        const part = bytes.subarray(index * size, Math.min(bytes.length, (index + 1) * size));
        if (tmp.exists) tmp.delete();
        tmp.create();
        tmp.write(part);
        const form = new FormData();
        form.append('sha256', await sha256Hex(part));
        form.append('chunk', { uri: tmp.uri, name: `chunk-${index}`, type: 'application/octet-stream' } as unknown as Blob);
        await request(`/api/v1/cases/${ref}/chunks/${index}`, { method: 'POST', body: form }, POLICY.uploadTimeoutMs);
        done += 1;
        onProgress?.(done, totalChunks);
      }
    } finally {
      try { if (tmp.exists) tmp.delete(); } catch { /* ignore */ }
    }
  }

  return accepted(await requestFull<IngestResponse>(`/api/v1/cases/${ref}/chunks/complete`, { method: 'POST' }, POLICY.uploadTimeoutMs), 'case');
}

// ── Status and result ──────────────────────────────────────────────────────

export function getCaseStatus(caseId: string): Promise<{ caseId: string; status: CentralStatus }> {
  return request(`/api/v1/cases/${encodeURIComponent(caseId)}/status`, { method: 'GET' });
}

/** GET /api/v1/phc/cases/:captureRef/report (added for this app, 2026-09-24). */
export function getReport(captureRef: string): Promise<PhcReport> {
  return request(`/api/v1/phc/cases/${encodeURIComponent(captureRef)}/report`, { method: 'GET' });
}

/** Image source (uri + auth header) for the GradCAM overlay. */
export function gradcamSource(captureRef: string): { uri: string; headers: Record<string, string> } {
  return { uri: url(`/api/v1/phc/cases/${encodeURIComponent(captureRef)}/gradcam`), headers: headers() };
}
