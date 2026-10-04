'use strict';



const express = require('express');
const analytics = require('../services/analyticsAggregator');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { logAccess } = require('../services/accessLog');

const router = express.Router();


const STATUSES = ['referred', 'manual_follow_up', 'contacted', 'attended', 'lost'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


router.patch('/:referralId', requireAuth, requireRole('district_admin'), async (req, res, next) => {
  const { referralId } = req.params;
  const { status, assignedWorker } = req.body || {};

  if (!UUID_RE.test(referralId)) {
    return res.status(404).json({
      error: 'referral_not_found', message: `No referral with id ${referralId}`,
    });
  }

  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({
      error: 'invalid_field',
      message: `status must be one of: ${STATUSES.join(', ')} — got '${status}'.`,
    });
  }

  if (status === undefined && assignedWorker === undefined) {
    return res.status(400).json({
      error: 'no_fields_to_update',
      message: 'Supply status, assignedWorker, or both.',
    });
  }

  try {

    const patch = { status };
    if ('assignedWorker' in (req.body || {})) patch.assignedWorker = assignedWorker;

    const updated = await analytics.updateReferral(referralId, patch);
    if (!updated) {
      return res.status(404).json({
        error: 'referral_not_found', message: `No referral with id ${referralId}`,
      });
    }
    await logAccess(req.user?.userId, 'update_referral', 'referral', referralId);
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;
