'use strict';


const crypto = require('crypto');

const flag = (name, dflt = false) => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
};

const AUTH_ENABLED = flag('AUTH_ENABLED');
const PHC_AUTH_ENABLED = flag('PHC_AUTH_ENABLED');

let JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  if (AUTH_ENABLED) {
    throw new Error('AUTH_ENABLED=true but JWT_SECRET is not set. Refusing to start ' +
      'with a guessable or per-process session key. Set JWT_SECRET in .env -- see ' +
      '.env.example for a one-line generator.');
  }
  JWT_SECRET = crypto.randomBytes(48).toString('base64url');
}
if (AUTH_ENABLED && JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters.');
}

const JWT_TTL_HOURS = Number(process.env.JWT_TTL_HOURS || 12);
if (!(JWT_TTL_HOURS > 0 && JWT_TTL_HOURS <= 24)) {
  throw new Error(`JWT_TTL_HOURS must be in (0, 24], got ${process.env.JWT_TTL_HOURS}.`);
}

const SAMESITE = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
if (!['lax', 'strict', 'none'].includes(SAMESITE)) {
  throw new Error(`COOKIE_SAMESITE must be lax, strict or none, got ${SAMESITE}.`);
}
// SameSite=None without Secure is rejected by every current browser.
const COOKIE_SECURE = SAMESITE === 'none' ? true : flag('COOKIE_SECURE', true);

const CLAIM_TTL_MINUTES = Number(process.env.CLAIM_TTL_MINUTES || 30);
if (!(CLAIM_TTL_MINUTES > 0)) {
  throw new Error(`CLAIM_TTL_MINUTES must be positive, got ${process.env.CLAIM_TTL_MINUTES}.`);
}

module.exports = {
  AUTH_ENABLED,
  PHC_AUTH_ENABLED,
  JWT_SECRET,
  JWT_TTL_HOURS,
  CLAIM_TTL_MINUTES,
  SESSION_COOKIE: 'ns_session',
  CSRF_HEADER: 'x-csrf-token',
  PHC_KEY_HEADER: 'x-phc-api-key',
  cookieOptions: {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: SAMESITE,
    path: '/',
    maxAge: JWT_TTL_HOURS * 3600 * 1000,
  },
  ROLES: ['ophthalmologist', 'district_admin'],
};
