
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Crypto from 'expo-crypto';
import { kvGet, kvSet } from '../db/database';
import { fromBase64, toBase64, utf8 } from '../peer/bytes';

const KEY = 'offline_credentials';
const ITERATIONS = 60_000;

export interface CachedUser { userId: string; username: string; name: string; role: string }
interface Verifier extends CachedUser { salt: string; hash: string; iterations: number; savedAt: string }

async function all(): Promise<Record<string, Verifier>> {
  const raw = await kvGet(KEY);
  return raw ? JSON.parse(raw) : {};
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  return pbkdf2Async(sha256, utf8.encode(password), salt, { c: iterations, dkLen: 32 });
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function rememberCredentials(user: CachedUser, password: string): Promise<void> {
  const salt = Crypto.getRandomBytes(16);
  const hash = await derive(password, salt, ITERATIONS);
  const map = await all();
  map[user.username.toLowerCase()] = { ...user, salt: toBase64(salt), hash: toBase64(hash), iterations: ITERATIONS, savedAt: new Date().toISOString() };
  await kvSet(KEY, JSON.stringify(map));
}

export async function forgetCredentials(username: string): Promise<void> {
  const map = await all();
  delete map[username.toLowerCase()];
  await kvSet(KEY, JSON.stringify(map));
}

/** The cached user if `password` matches, 'no_cached' if this phone has never seen them, else null. */
export async function verifyOffline(username: string, password: string): Promise<CachedUser | 'no_cached' | null> {
  const v = (await all())[username.toLowerCase()];
  if (!v) return 'no_cached';
  const hash = await derive(password, fromBase64(v.salt), v.iterations);
  return constantTimeEqual(hash, fromBase64(v.hash))
    ? { userId: v.userId, username: v.username, name: v.name, role: v.role }
    : null;
}
