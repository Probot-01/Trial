'use strict';



const db = require('../db/localDb');

/** SQL predicate over a sync_queue row aliased `q`: both questionnaires recorded. */
const FORMS_COMPLETE_SQL = `
  EXISTS (SELECT 1 FROM questionnaire_responses qr WHERE qr.capture_id = q.capture_id)
  AND EXISTS (SELECT 1 FROM capture_metadata_responses cm WHERE cm.capture_id = q.capture_id)`;

/** Rows waiting to be uploaded: pending AND their forms are complete. */
function countPending() {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM sync_queue q
    WHERE q.status = 'pending' AND ${FORMS_COMPLETE_SQL}`).get().n;
}

/** Passed-the-gate captures still waiting for a questionnaire (not uploadable yet). */
function countAwaitingForms() {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM sync_queue q
    WHERE q.status = 'pending' AND NOT (${FORMS_COMPLETE_SQL})`).get().n;
}

module.exports = { FORMS_COMPLETE_SQL, countPending, countAwaitingForms };
