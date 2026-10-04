'use strict';



const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cfg = require('./authConfig');

function issueSession(user) {
  const csrf = crypto.randomBytes(24).toString('base64url');
  const token = jwt.sign(
    { userId: user.user_id, role: user.role, csrf },
    cfg.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: `${cfg.JWT_TTL_HOURS}h` },
  );
  const expiresAt = new Date(Date.now() + cfg.JWT_TTL_HOURS * 3600 * 1000).toISOString();
  return { token, csrfToken: csrf, expiresAt };
}

/** Returns { userId, role, csrf, exp } or null. Never throws. */
function verifySession(token) {
  if (!token) return null;
  try {
    const p = jwt.verify(token, cfg.JWT_SECRET, { algorithms: ['HS256'] });
    if (!p.userId || !cfg.ROLES.includes(p.role) || !p.csrf) return null;
    return p;
  } catch {
    return null;
  }
}

/** Constant-time string comparison; false on any length mismatch. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** SHA-256 hex of a PHC API key -- what phc_sites.api_key_hash stores. */
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

module.exports = { issueSession, verifySession, safeEqual, hashApiKey };
