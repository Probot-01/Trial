'use strict';



const pool = require('../db/pgClient');

async function logAccess(userId, action, resourceType, resourceId = null) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO access_log (user_id, action, resource_type, resource_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, action, resourceType, resourceId == null ? null : String(resourceId)]);
  } catch (err) {
    console.error(`[accessLog] FAILED to record ${action} ${resourceType}/${resourceId} ` +
      `by ${userId}: ${err.message}`);
  }
}

module.exports = { logAccess };
