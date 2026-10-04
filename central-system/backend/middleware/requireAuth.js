'use strict';



const pool = require('../db/pgClient');
const cfg = require('../services/authConfig');
const { verifySession, safeEqual } = require('../services/authTokens');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);


const REVOCATION_CACHE_MS = 60_000;
const userCache = new Map();   // userId -> { role, checkedAt }

async function currentRole(userId) {
  const hit = userCache.get(userId);
  if (hit && Date.now() - hit.checkedAt < REVOCATION_CACHE_MS) return hit.role;
  try {

    const { rows } = await pool.query(
      'SELECT role, is_active FROM users WHERE user_id = $1', [userId]);
    const role = rows.length && rows[0].is_active ? rows[0].role : null;
    userCache.set(userId, { role, checkedAt: Date.now() });
    if (userCache.size > 1000) {
      for (const [k, v] of userCache) {
        if (Date.now() - v.checkedAt > REVOCATION_CACHE_MS) userCache.delete(k);
      }
    }
    return role;
  } catch (err) {

    console.error(`[requireAuth] could not re-check user ${userId}: ${err.message}`);
    return hit ? hit.role : undefined;
  }
}

/** The verified session payload from the request's cookie, or null. */
function readSession(req) {
  return verifySession(req.cookies && req.cookies[cfg.SESSION_COOKIE]);
}

async function requireAuth(req, res, next) {
  const session = readSession(req);
  if (session) req.user = { userId: session.userId, role: session.role };

  if (!cfg.AUTH_ENABLED) return next();

  if (!session) {
    return res.status(401).json({
      error: 'unauthenticated', message: 'Log in to continue.',
    });
  }

  const role = await currentRole(session.userId);
  if (role === null) {
    return res.status(401).json({
      error: 'unauthenticated', message: 'This account is no longer active.',
    });
  }
  // A role change takes effect on the next request, not at the next login.
  if (role !== undefined && role !== req.user.role) req.user.role = role;

  if (!SAFE_METHODS.has(req.method) &&
    !safeEqual(req.get(cfg.CSRF_HEADER) || '', session.csrf)) {
    return res.status(403).json({
      error: 'csrf_invalid',
      message: 'Missing or invalid X-CSRF-Token header. Use the csrfToken from ' +
        'the login or /auth/me response.',
    });
  }

  return next();
}

module.exports = requireAuth;
module.exports.requireAuth = requireAuth;
module.exports.readSession = readSession;
module.exports._clearUserCache = () => userCache.clear();
