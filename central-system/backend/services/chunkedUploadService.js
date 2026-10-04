'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const mediaPaths = require('./mediaPaths');
const mediaCrypto = require('./mediaCrypto');
const ingestion = require('./ingestionService');
const gradingQueue = require('./gradingQueue');

const CHUNK_ROOT = path.join(mediaPaths.MEDIA_ROOT, 'chunks');

const MAX_CHUNK_BYTES = parseInt(process.env.UPLOAD_MAX_CHUNK_BYTES || String(4 * 1024 * 1024), 10);
const MAX_TOTAL_BYTES = parseInt(process.env.UPLOAD_MAX_TOTAL_BYTES || String(64 * 1024 * 1024), 10);
const MAX_CHUNKS = parseInt(process.env.UPLOAD_MAX_CHUNKS || '2048', 10);
const SESSION_TTL_MS = parseInt(process.env.UPLOAD_SESSION_TTL_MS || String(7 * 24 * 3600 * 1000), 10);

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.dcm']);

const CAPTURE_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

const locks = new Map();

async function withLock(key, fn) {
  while (locks.has(key)) await locks.get(key);
  let release;
  const p = new Promise((r) => { release = r; });
  locks.set(key, p);
  try {
    return await fn();
  } finally {
    locks.delete(key);
    release();
  }
}

function badRequest(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function assertCaptureRef(captureRef) {
  if (!captureRef || !CAPTURE_REF_RE.test(captureRef)) {
    throw badRequest('invalid_capture_ref',
      'captureRef must be 1-64 characters of letters, digits, hyphen or underscore.');
  }
}

function sessionDir(captureRef) {
  assertCaptureRef(captureRef);
  const dir = path.join(CHUNK_ROOT, captureRef);
  // Defence in depth: even with the regex above, never write outside the root.
  const rel = path.relative(CHUNK_ROOT, path.resolve(dir));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw badRequest('invalid_capture_ref', 'Refusing a captureRef that escapes the chunk root.');
  }
  return dir;
}

const manifestPath = (captureRef) => path.join(sessionDir(captureRef), 'manifest.json');
const chunkPath = (captureRef, index) =>
  path.join(sessionDir(captureRef), `${String(index).padStart(6, '0')}.part`);

function readManifest(captureRef) {
  const p = manifestPath(captureRef);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw badRequest('corrupt_session',
      `Upload session for ${captureRef} has an unreadable manifest: ${err.message}`);
  }
}

function writeManifest(captureRef, manifest) {
  // Write-then-rename: a manifest half-written by a crash would make the
  // session unreadable and unresumable, losing the chunks already transferred.
  const p = manifestPath(captureRef);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, p);
}

/** Indices actually present on disk, ascending. */
function receivedChunks(captureRef) {
  const dir = sessionDir(captureRef);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.part'))
    .map((f) => parseInt(f.slice(0, -5), 10))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');


async function initSession(captureRef, meta = {}) {
  assertCaptureRef(captureRef);

  const existingCase = await ingestion.findCaseByCaptureRef(captureRef);
  if (existingCase && existingCase.status !== 'awaiting_image') {
    return {
      captureRef, alreadyIngested: true, caseId: existingCase.caseId,
      status: existingCase.status, missing: [], received: [],
    };
  }

  const totalChunks = parseInt(meta.totalChunks, 10);
  const totalBytes = parseInt(meta.totalBytes, 10);
  const expectedSha = String(meta.sha256 || '').toLowerCase();

  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS) {
    throw badRequest('invalid_field',
      `totalChunks must be an integer in 1..${MAX_CHUNKS}.`);
  }
  if (!Number.isInteger(totalBytes) || totalBytes < 1) {
    throw badRequest('invalid_field', 'totalBytes must be a positive integer.');
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw badRequest('image_too_large',
      `Image is ${totalBytes} bytes; the limit is ${MAX_TOTAL_BYTES}.`, 413);
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
    throw badRequest('invalid_field',
      'sha256 must be the hex SHA-256 of the complete image.');
  }

  let ext = path.extname(meta.filename || '').toLowerCase();
  if (!ext) ext = '.jpg';
  if (!ALLOWED_EXT.has(ext)) {
    throw badRequest('invalid_image_type', `Unsupported image type '${ext}'.`);
  }

  return withLock(captureRef, async () => {
    const existing = readManifest(captureRef);

    if (existing) {
      if (existing.caseId) {

        return {
          captureRef, alreadyIngested: true, caseId: existing.caseId,
          totalChunks: existing.totalChunks, received: [], missing: [],
        };
      }
      const sameFile = existing.sha256 === expectedSha
        && existing.totalChunks === totalChunks
        && existing.totalBytes === totalBytes;
      if (sameFile) {
        const received = receivedChunks(captureRef);
        return {
          captureRef, alreadyIngested: false,
          totalChunks, received,
          missing: missingChunks(totalChunks, received),
          resumed: true,
        };
      }
      // Different file under the same key: start clean.
      fs.rmSync(sessionDir(captureRef), { recursive: true, force: true });
    }

    fs.mkdirSync(sessionDir(captureRef), { recursive: true });

    const { totalChunks: _tc, totalBytes: _tb, sha256: _sh, filename: _fn, ...caseFields } = meta;

    writeManifest(captureRef, {
      captureRef, totalChunks, totalBytes, sha256: expectedSha, ext,
      caseFields,                       // patientId, phcId, questionnaires, ...
      createdAt: new Date().toISOString(),
      caseId: null,
    });

    return {
      captureRef, alreadyIngested: false, totalChunks,
      received: [], missing: missingChunks(totalChunks, []), resumed: false,
    };
  });
}

function missingChunks(totalChunks, received) {
  const have = new Set(received);
  const out = [];
  for (let i = 0; i < totalChunks; i++) if (!have.has(i)) out.push(i);
  return out;
}


function getSession(captureRef) {
  assertCaptureRef(captureRef);
  const manifest = readManifest(captureRef);
  if (!manifest) return null;

  const received = receivedChunks(captureRef);
  return {
    captureRef,
    totalChunks: manifest.totalChunks,
    totalBytes: manifest.totalBytes,
    sha256: manifest.sha256,
    received,
    missing: missingChunks(manifest.totalChunks, received),
    complete: received.length === manifest.totalChunks,
    caseId: manifest.caseId,
    createdAt: manifest.createdAt,
  };
}


async function putChunk(captureRef, index, buffer, chunkSha) {
  assertCaptureRef(captureRef);

  const manifest = readManifest(captureRef);
  if (!manifest) {
    throw badRequest('session_not_found',
      `No upload session for ${captureRef}. Call init first.`, 404);
  }
  if (manifest.caseId) {
    throw badRequest('already_ingested',
      `Capture ${captureRef} was already assembled into case ${manifest.caseId}.`, 409);
  }

  const i = parseInt(index, 10);
  if (!Number.isInteger(i) || i < 0 || i >= manifest.totalChunks) {
    throw badRequest('invalid_field',
      `chunkIndex must be an integer in 0..${manifest.totalChunks - 1}.`);
  }
  if (!buffer || !buffer.length) {
    throw badRequest('empty_chunk', 'The chunk body was empty.');
  }
  if (buffer.length > MAX_CHUNK_BYTES) {
    throw badRequest('chunk_too_large',
      `Chunk is ${buffer.length} bytes; the limit is ${MAX_CHUNK_BYTES}.`, 413);
  }

  const actual = sha256(buffer);
  if (chunkSha && String(chunkSha).toLowerCase() !== actual) {

    throw badRequest('chunk_checksum_mismatch',
      `Chunk ${i} failed its checksum — expected ${chunkSha}, got ${actual}. Resend it.`,
      422);
  }

  return withLock(`${captureRef}:${i}`, async () => {
    const p = chunkPath(captureRef, i);
    const tmp = `${p}.tmp`;

    fs.writeFileSync(tmp, mediaCrypto.encryptBuffer(buffer));
    fs.renameSync(tmp, p);     // atomic: a .part file is always whole

    const received = receivedChunks(captureRef);
    return {
      captureRef, index: i, bytes: buffer.length, sha256: actual,
      received: received.length,
      totalChunks: manifest.totalChunks,
      missing: missingChunks(manifest.totalChunks, received),
    };
  });
}

async function completeSession(captureRef) {
  assertCaptureRef(captureRef);

  return withLock(captureRef, async () => {
    const manifest = readManifest(captureRef);
    if (!manifest) {
      throw badRequest('session_not_found', `No upload session for ${captureRef}.`, 404);
    }


    if (manifest.caseId) {
      return { caseId: manifest.caseId, receivedAt: manifest.ingestedAt, duplicate: true };
    }

    const received = receivedChunks(captureRef);
    const missing = missingChunks(manifest.totalChunks, received);
    if (missing.length) {
      throw badRequest('incomplete_upload',
        `${missing.length} chunk(s) still missing: [${missing.slice(0, 20).join(', ')}` +
        `${missing.length > 20 ? ', …' : ''}]. Send them, then complete again.`, 409);
    }

    const hash = crypto.createHash('sha256');
    const parts = [];
    let assembledBytes = 0;
    for (let i = 0; i < manifest.totalChunks; i++) {
      const buf = mediaCrypto.readFile(chunkPath(captureRef, i));
      hash.update(buf);
      assembledBytes += buf.length;
      parts.push(buf);
    }
    const assembledSha = hash.digest('hex');

    if (assembledBytes !== manifest.totalBytes) {
      throw badRequest('size_mismatch',
        `Assembled ${assembledBytes} bytes but the session declared ${manifest.totalBytes}.`,
        422);
    }
    if (assembledSha !== manifest.sha256) {

      fs.rmSync(sessionDir(captureRef), { recursive: true, force: true });
      throw badRequest('checksum_mismatch',
        `Assembled image hashes to ${assembledSha}, not the declared ${manifest.sha256}. ` +
        'The session has been discarded; start again.', 422);
    }

    const result = await ingestion.ingestCase({
      ...manifest.caseFields,
      captureIdRef: manifest.caseFields.captureIdRef || captureRef,
      imageFile: {
        buffer: Buffer.concat(parts, assembledBytes),
        originalname: `image${manifest.ext}`,
      },
    });


    manifest.caseId = result.caseId;
    manifest.ingestedAt = result.receivedAt;
    writeManifest(captureRef, manifest);

    for (let i = 0; i < manifest.totalChunks; i++) {
      fs.rmSync(chunkPath(captureRef, i), { force: true });
    }

    if (!result.duplicate) gradingQueue.enqueue(result.caseId);

    return result;
  });
}


function sweepStale(maxAgeMs = SESSION_TTL_MS) {
  if (!fs.existsSync(CHUNK_ROOT)) return { swept: 0, kept: 0 };
  const cutoff = Date.now() - maxAgeMs;
  let swept = 0, kept = 0;

  for (const entry of fs.readdirSync(CHUNK_ROOT)) {
    if (!CAPTURE_REF_RE.test(entry)) continue;
    let manifest;
    try {
      manifest = readManifest(entry);
    } catch {
      manifest = null;                      // corrupt: treat as sweepable
    }
    const dir = path.join(CHUNK_ROOT, entry);
    const age = manifest?.createdAt ? Date.parse(manifest.createdAt) : 0;

    if (!manifest || age < cutoff) {
      fs.rmSync(dir, { recursive: true, force: true });
      swept++;
    } else {
      kept++;
    }
  }
  return { swept, kept };
}

module.exports = {
  initSession, getSession, putChunk, completeSession, sweepStale,
  CHUNK_ROOT, MAX_CHUNK_BYTES, MAX_TOTAL_BYTES, MAX_CHUNKS,
  CAPTURE_REF_RE,
};
