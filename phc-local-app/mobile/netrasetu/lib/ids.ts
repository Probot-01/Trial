
import * as Crypto from 'expo-crypto';
import { getConfig } from '../config';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LIMIT = Math.floor(256 / ALPHABET.length) * ALPHABET.length; // 252
export const SUFFIX_LENGTH = 8;

function randomSuffix(n = SUFFIX_LENGTH): string {
  let out = '';
  while (out.length < n) {
    for (const byte of Crypto.getRandomBytes(n * 2)) {
      if (byte >= LIMIT) continue; // reject: avoids modulo bias
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === n) break;
    }
  }
  return out;
}

let lastMs = 0;

/** Date.now(), but strictly increasing within this process. */
function monotonicNow(): number {
  const now = Date.now();
  lastMs = now > lastMs ? now : lastMs + 1;
  return lastMs;
}

export function generateLocalId(phcCode = getConfig().phcCode): string {
  return `${phcCode}-${monotonicNow().toString(36)}-${randomSuffix(SUFFIX_LENGTH)}`;
}

/** Accepts current (8-char) and pre-2026-09-24 (4-char) suffixes. */
export const LOCAL_ID_RE = /^[A-Za-z0-9]+-[0-9a-z]+-(?:[0-9a-z]{8}|[0-9a-z]{4})$/;
