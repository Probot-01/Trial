'use strict';



const crypto = require('crypto');


const PHC_CODE = process.env.PHC_CODE || 'PHC001';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SUFFIX_LENGTH = 8;


const LOCAL_ID_RE = /^[A-Za-z0-9]+-[0-9a-z]+-(?:[0-9a-z]{8}|[0-9a-z]{4})$/;


function randomSuffix(n = SUFFIX_LENGTH) {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = '';
  while (out.length < n) {
    for (const byte of crypto.randomBytes(n * 2)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === n) break;
    }
  }
  return out;
}

let lastMs = 0;

/** Date.now(), but strictly increasing within this process. */
function monotonicNow() {
  const now = Date.now();
  lastMs = now > lastMs ? now : lastMs + 1;
  return lastMs;
}

/**
 * generateLocalId([phcCode])
 *
 * @param {string} [phcCode] — override the configured PHC code.
 * @returns {string} e.g. 'PHC001-mtuss3yg-a2x9k7qp'
 */
function generateLocalId(phcCode = PHC_CODE) {
  return `${phcCode}-${monotonicNow().toString(36)}-${randomSuffix(SUFFIX_LENGTH)}`;
}

module.exports = { generateLocalId, PHC_CODE, LOCAL_ID_RE, SUFFIX_LENGTH };
