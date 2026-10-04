'use strict';


const crypto = require('crypto');

const VERSION = 1;

function keyFromB64(b64) {
  const key = Buffer.from(String(b64 || ''), 'base64');
  if (key.length !== 32) throw new Error('peer key must be 32 bytes');
  return key;
}

function newKeyB64() {
  return crypto.randomBytes(32).toString('base64');
}

/** Encrypts `plaintext` (Buffer | string | object -> JSON) under key with the given AAD string. */
function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.isBuffer(plaintext) ? plaintext
    : Buffer.from(typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext), 'utf8');
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return { v: VERSION, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** Decrypts an envelope; throws on a wrong key, wrong AAD or any tampering. Returns a Buffer. */
function open(key, envelope, aad) {
  if (!envelope || envelope.v !== VERSION || !envelope.iv || !envelope.ct || !envelope.tag) {
    throw Object.assign(new Error('malformed envelope'), { code: 'envelope_malformed' });
  }
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) {
    throw Object.assign(new Error('malformed envelope'), { code: 'envelope_malformed' });
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
  } catch {
    throw Object.assign(new Error('decryption failed (wrong key or tampered data)'), { code: 'envelope_invalid' });
  }
}

const openJson = (key, envelope, aad) => JSON.parse(open(key, envelope, aad).toString('utf8'));

/** AAD strings -- identical on both sides (mobile: netrasetu/peer/peerCrypto.ts). */
const requestAad = ({ deviceId, method, path, ts, nonce }) => `req|${deviceId}|${method.toUpperCase()}|${path}|${ts}|${nonce}`;
const responseAad = ({ deviceId, path, nonce }) => `res|${deviceId}|${path}|${nonce}`;
const bundleAad = ({ fromDevice, toDevice, createdAt }) => `bundle|${fromDevice}|${toDevice}|${createdAt}`;

module.exports = { seal, open, openJson, keyFromB64, newKeyB64, requestAad, responseAad, bundleAad, VERSION };
