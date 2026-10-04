
import { gcm } from '@noble/ciphers/aes.js';
import * as Crypto from 'expo-crypto';
import { fromBase64, toBase64, utf8 } from './bytes';

export interface Envelope { v: 1; iv: string; ct: string; tag: string }

export function keyFromB64(b64: string): Uint8Array {
  const k = fromBase64(b64);
  if (k.length !== 32) throw new Error('peer key must be 32 bytes');
  return k;
}

export function seal(key: Uint8Array, plaintext: Uint8Array | string | object, aad: string): Envelope {
  const iv = Crypto.getRandomBytes(12);
  const data = plaintext instanceof Uint8Array ? plaintext
    : utf8.encode(typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext));
  const out = gcm(key, iv, utf8.encode(aad)).encrypt(data); // ciphertext || 16-byte tag
  return {
    v: 1,
    iv: toBase64(iv),
    ct: toBase64(out.subarray(0, out.length - 16)),
    tag: toBase64(out.subarray(out.length - 16)),
  };
}

export class EnvelopeError extends Error {
  constructor(public code: 'envelope_malformed' | 'envelope_invalid', message: string) { super(message); }
}

export function open(key: Uint8Array, env: Envelope, aad: string): Uint8Array {
  if (!env || env.v !== 1 || !env.iv || !env.ct || !env.tag) throw new EnvelopeError('envelope_malformed', 'malformed envelope');
  const iv = fromBase64(env.iv);
  const ct = fromBase64(env.ct);
  const tag = fromBase64(env.tag);
  if (iv.length !== 12 || tag.length !== 16) throw new EnvelopeError('envelope_malformed', 'malformed envelope');
  const joined = new Uint8Array(ct.length + 16);
  joined.set(ct);
  joined.set(tag, ct.length);
  try {
    return gcm(key, iv, utf8.encode(aad)).decrypt(joined);
  } catch {
    throw new EnvelopeError('envelope_invalid', 'decryption failed (wrong key or tampered data)');
  }
}

export const openJson = <T = unknown>(key: Uint8Array, env: Envelope, aad: string): T => JSON.parse(utf8.decode(open(key, env, aad)));

export const requestAad = (a: { deviceId: string; method: string; path: string; ts: string; nonce: string }) =>
  `req|${a.deviceId}|${a.method.toUpperCase()}|${a.path}|${a.ts}|${a.nonce}`;
export const responseAad = (a: { deviceId: string; path: string; nonce: string }) => `res|${a.deviceId}|${a.path}|${a.nonce}`;
export const bundleAad = (a: { fromDevice: string; toDevice: string; createdAt: string }) =>
  `bundle|${a.fromDevice}|${a.toDevice}|${a.createdAt}`;
