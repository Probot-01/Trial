
import { secretGet, secretSet } from '../lib/secrets';

export interface Pairing {
  kind: 'netrasetu-pair';
  v: 1;
  deviceId: string;
  key: string;
  pcDeviceId: string;
  urls: string[];
  phcCode: string;
  phcName: string | null;
  pairedAt?: string;
  /** Last URL that answered -- tried first next time. */
  lastUrl?: string;
}

const KEY = 'peer_pairing';
let cached: Pairing | null | undefined;

export function parsePairing(text: string): Pairing {
  let p: Pairing;
  try { p = JSON.parse(text.trim()); } catch { throw new Error('Not a NetraSetu pairing code.'); }
  if (p?.kind !== 'netrasetu-pair' || p.v !== 1 || !p.deviceId || !p.key || !p.pcDeviceId) {
    throw new Error('Not a NetraSetu pairing code.');
  }
  if (!Array.isArray(p.urls) || !p.urls.length) throw new Error('The pairing code lists no PC address. Is the PC on the network?');
  return p;
}

export async function getPairing(): Promise<Pairing | null> {
  if (cached !== undefined) return cached;
  const raw = await secretGet(KEY);
  cached = raw ? JSON.parse(raw) : null;
  return cached ?? null;
}

export async function savePairing(p: Pairing): Promise<void> {
  cached = { ...p, pairedAt: p.pairedAt ?? new Date().toISOString() };
  await secretSet(KEY, JSON.stringify(cached));
}

export async function clearPairing(): Promise<void> {
  cached = null;
  await secretSet(KEY, null);
}

/** For tests: forget the in-memory copy. */
export function resetPairingCache() { cached = undefined; }
