'use strict';



const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAGIC = Buffer.from('NSMEDIA1', 'ascii');
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER = MAGIC.length + IV_LEN + TAG_LEN;

function parseKey(raw) {
  if (!raw) return null;
  const s = raw.trim();
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) key = Buffer.from(s, 'hex');
  else {
    try { key = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch { key = null; }
  }
  if (!key || key.length !== 32) {
    throw new Error('MEDIA_ENCRYPTION_KEY must be 32 bytes (64 hex chars, or base64). ' +
      'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return key;
}

let cachedKey;
function key() {
  if (cachedKey === undefined) cachedKey = parseKey(process.env.MEDIA_ENCRYPTION_KEY);
  return cachedKey;
}

const enabled = () => key() !== null;

function isEncrypted(buf) {
  return buf.length >= HEADER && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Encrypt when a key is configured; otherwise return the bytes unchanged. */
function encryptBuffer(plain) {
  const k = key();
  if (!k || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/** Plaintext of a buffer that may or may not be encrypted. Throws on a bad tag. */
function decryptBuffer(buf) {
  if (!isEncrypted(buf)) return buf;
  const k = key();
  if (!k) {
    const err = new Error('This media file is encrypted but MEDIA_ENCRYPTION_KEY is not set.');
    err.code = 'media_key_missing';
    throw err;
  }
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = buf.subarray(MAGIC.length + IV_LEN, HEADER);
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(HEADER)), decipher.final()]);
}

/** Write a file, encrypted when a key is configured. */
function writeFile(filePath, plain) {
  fs.writeFileSync(filePath, encryptBuffer(plain));
}

/** Read a file's plaintext, whichever form it is stored in. */
function readFile(filePath) {
  return decryptBuffer(fs.readFileSync(filePath));
}

function readEncryptedFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (!isEncrypted(buf)) {
    const err = new Error(`${path.basename(filePath)} is stored unencrypted; refusing to serve it. ` +
      'Set MEDIA_ENCRYPTION_KEY and run scripts/encryptMedia.js, or move the file out of media/.');
    err.code = 'media_not_encrypted';
    throw err;
  }
  return decryptBuffer(buf);
}


function encryptFileInPlace(filePath) {
  if (!enabled()) return false;
  const buf = fs.readFileSync(filePath);
  if (isEncrypted(buf)) return false;
  const tmp = `${filePath}.enc-tmp`;
  fs.writeFileSync(tmp, encryptBuffer(buf));
  fs.renameSync(tmp, filePath);
  return true;
}

/** Encrypt every not-yet-encrypted file in a case's media directory. */
function encryptDir(dir) {
  if (!enabled() || !fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) n += encryptDir(p);
    else if (entry.isFile() && !entry.name.endsWith('.enc-tmp')) n += encryptFileInPlace(p) ? 1 : 0;
  }
  return n;
}


async function withPlaintextCopy(filePath, fn) {
  if (!filePath || !fs.existsSync(filePath)) return fn(filePath);
  const buf = fs.readFileSync(filePath);
  if (!isEncrypted(buf)) return fn(filePath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-media-'));
  const tmp = path.join(dir, path.basename(filePath));
  fs.writeFileSync(tmp, decryptBuffer(buf));
  try {
    return await fn(tmp);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  enabled, isEncrypted, encryptBuffer, decryptBuffer,
  writeFile, readFile, readEncryptedFile, encryptFileInPlace, encryptDir, withPlaintextCopy,
  _resetKeyForTests: () => { cachedKey = undefined; },
};
