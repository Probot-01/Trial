'use strict';



const pool = require('../db/pgClient');
const cfg = require('../services/authConfig');
const { hashApiKey } = require('../services/authTokens');
const requireAuth = require('./requireAuth');

async function findPhcByKey(key) {
  const { rows } = await pool.query(
    'SELECT phc_id, name FROM phc_sites WHERE api_key_hash = $1', [hashApiKey(key)]);
  return rows[0] || null;
}

/** Stamp last_contact_at. Never fails the request it is attached to. */
async function touchPhcContact(phcId) {
  if (!phcId) return;
  try {
    await pool.query('UPDATE phc_sites SET last_contact_at = now() WHERE phc_id = $1', [phcId]);
  } catch (err) {
    console.error(`[phcAuth] could not update last_contact_at for ${phcId}: ${err.message}`);
  }
}

async function requirePhcApiKey(req, res, next) {
  const key = req.get(cfg.PHC_KEY_HEADER);

  if (!key) {
    if (!cfg.PHC_AUTH_ENABLED) return next();
    return res.status(401).json({
      error: 'phc_key_required',
      message: `Send this PHC's API key in the ${cfg.PHC_KEY_HEADER} header.`,
    });
  }

  try {
    const site = await findPhcByKey(key);
    if (!site) {
      return res.status(401).json({
        error: 'phc_key_invalid', message: 'Unknown or revoked PHC API key.',
      });
    }
    req.phc = { phcId: site.phc_id, name: site.name };
    await touchPhcContact(site.phc_id);
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * requireUserOrPhc -- accept EITHER a valid PHC key or a logged-in user of any
 * role. A request that presents a PHC key is judged on that key alone.
 */
function requireUserOrPhc(req, res, next) {
  if (req.get(cfg.PHC_KEY_HEADER)) return requirePhcApiKey(req, res, next);
  return requireAuth(req, res, next);
}

module.exports = requirePhcApiKey;
module.exports.requirePhcApiKey = requirePhcApiKey;
module.exports.requireUserOrPhc = requireUserOrPhc;
module.exports.touchPhcContact = touchPhcContact;
