'use strict';



const express = require('express');

const db = require('../db/localDb');
const syncState = require('../services/syncState');
const { countPending, countAwaitingForms } = require('../services/syncReadiness');

const router = express.Router();

router.get('/status', (req, res) => {

  const n = countPending();


  const err = db.prepare(
    "SELECT capture_id, error_kind, last_error, updated_at FROM sync_queue " +
    "WHERE status = 'pending' AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get();


  const { last } = db.prepare(
    'SELECT MAX(last_attempt_at) AS last FROM sync_queue').get();

  const state = syncState.getState();

  res.json({
    online: state.online,
    pendingCount: n,
    awaitingFormsCount: countAwaitingForms(),
    lastError: err
      ? { captureId: err.capture_id, kind: err.error_kind, message: err.last_error, at: err.updated_at }
      : null,

    lastSyncAttempt: state.lastSyncAttempt || last || null,
  });
});

module.exports = router;
