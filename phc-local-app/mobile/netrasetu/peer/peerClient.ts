
import * as Crypto from 'expo-crypto';
import { getPairing, Pairing, savePairing } from './pairing';
import { keyFromB64, openJson, requestAad, responseAad, seal, Envelope } from './peerCrypto';
import { toHex } from './bytes';

export class PeerError extends Error {
  constructor(public code: string, message: string, public status: number | null = null) { super(message); }
  get unreachable() { return this.code === 'pc_unreachable'; }
}

/** PC clock minus phone clock, learned from /peer/hello (phones in the field often have the wrong time). */
let clockOffsetMs = 0;
const TIMEOUT_MS = 20_000;
const IMAGE_TIMEOUT_MS = 120_000;

async function once(p: Pairing, url: string, path: string, body: object, timeoutMs: number): Promise<unknown> {
  const key = keyFromB64(p.key);
  const ts = String(Date.now() + clockOffsetMs);
  const nonce = toHex(Crypto.getRandomBytes(16));
  const envelope = seal(key, body, requestAad({ deviceId: p.deviceId, method: 'POST', path, ts, nonce }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-netra-device': p.deviceId, 'x-netra-ts': ts, 'x-netra-nonce': nonce },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
  } catch {
    throw new PeerError('pc_unreachable', `Cannot reach the PHC PC at ${url}.`);
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.json().catch(() => null) as (Envelope & { error?: string; message?: string }) | null;
  if (raw && raw.v === 1 && raw.ct) {
    const out = openJson<{ error?: string; message?: string }>(key, raw, responseAad({ deviceId: p.deviceId, path, nonce }));
    if (!res.ok) throw new PeerError(out?.error ?? `http_${res.status}`, out?.message ?? `PC returned ${res.status}`, res.status);
    return out;
  }
  // Unsealed = the PC refused before it could (or would) use our key.
  throw new PeerError(raw?.error ?? `http_${res.status}`, raw?.message ?? `PC returned ${res.status}`, res.status);
}


export async function peerCall<T>(path: string, body: object = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
  const p = await getPairing();
  if (!p) throw new PeerError('not_paired', 'This phone is not paired with a PHC PC.');
  const urls = [...new Set([p.lastUrl, ...p.urls].filter(Boolean) as string[])];
  let last: PeerError | null = null;
  for (const url of urls) {
    try {
      const out = await once(p, url, path, body, opts.timeoutMs ?? TIMEOUT_MS);
      if (url !== p.lastUrl) await savePairing({ ...p, lastUrl: url });
      return out as T;
    } catch (err) {
      if (err instanceof PeerError && err.unreachable) { last = err; continue; }
      throw err;
    }
  }
  throw last ?? new PeerError('pc_unreachable', 'Cannot reach the PHC PC.');
}

export interface Hello { serverTime: number; pcDeviceId: string; phcCode: string; phcName: string | null; authRequired: boolean }

export async function hello(): Promise<Hello> {
  const t0 = Date.now();
  const h = await peerCall<Hello>('/peer/hello', {});
  const rtt = Date.now() - t0;
  clockOffsetMs = h.serverTime - (t0 + rtt / 2);
  const p = await getPairing();
  if (p && h.pcDeviceId !== p.pcDeviceId) {
    throw new PeerError('pc_mismatch', 'A different PC answered at this address. Re-pair with your PHC PC.');
  }
  return h;
}

export { IMAGE_TIMEOUT_MS };
