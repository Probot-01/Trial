'use strict';



let online = false;
let lastSyncAttempt = null;   // ISO 8601 UTC string, or null if never attempted

/** Record the outcome of a heartbeat / sync attempt. Called by Task 3.4. */
function recordAttempt(isOnline, whenIso = new Date().toISOString()) {
  online = !!isOnline;
  lastSyncAttempt = whenIso;
}

/** Current connectivity view, for GET /sync/status. */
function getState() {
  return { online, lastSyncAttempt };
}

module.exports = { recordAttempt, getState };
