'use strict';



const express = require('express');
const analytics = require('../services/analyticsAggregator');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { logAccess } = require('../services/accessLog');
const { getSystemHealth } = require('../services/systemHealth');
const resourceModel = require('../services/resourceRecommendations');
const simulinkValidation = require('../services/simulinkValidation');

const router = express.Router();

// District-admin only (§A.7). Every route in this file is admin-facing.
const adminOnly = [requireAuth, requireRole('district_admin')];

router.get('/dashboard', adminOnly, async (req, res, next) => {
  try {
    const body = await analytics.getDashboard();
    await logAccess(req.user?.userId, 'view_dashboard', 'dashboard');
    res.json(body);
  } catch (err) { next(err); }
});

router.get('/referrals', adminOnly, async (req, res, next) => {
  try {
    const body = await analytics.getReferrals();
    await logAccess(req.user?.userId, 'view_referrals', 'referral_list');
    res.json(body);
  } catch (err) { next(err); }
});

// Every PHC site with its recent activity. The API key / hash are never part of
// the response (analytics.getPhcs does not select them).
router.get('/phcs', adminOnly, async (req, res, next) => {
  try {
    const body = await analytics.getPhcs();
    await logAccess(req.user?.userId, 'view_phcs', 'phc_list');
    res.json(body);
  } catch (err) { next(err); }
});

router.get('/system-health', adminOnly, async (req, res, next) => {
  try {
    const body = await getSystemHealth();
    await logAccess(req.user?.userId, 'view_system_health', 'system_health');
    res.json(body);
  } catch (err) { next(err); }
});


router.get('/resource-recommendations', adminOnly, async (req, res, next) => {
  try {
    const body = await resourceModel.latest();
    if (!body) {
      return res.status(404).json({
        error: 'recommendations_not_generated',
        message: 'The resource model has not run yet. POST /api/v1/admin/' +
          'resource-recommendations/refresh, or wait for the daily run.',
      });
    }
    res.json(body);
  } catch (err) { next(err); }
});


router.post('/resource-recommendations/refresh', adminOnly, async (req, res, next) => {
  try {
    const body = await resourceModel.refresh();
    await logAccess(req.user?.userId, 'refresh_resource_model', 'resource_recommendations');
    res.json(body);
  } catch (err) {
    res.status(502).json({ error: 'resource_model_failed', message: err.message });
  }
});


router.get('/simulink-validation', adminOnly, async (req, res, next) => {
  try {
    const body = simulinkValidation.latest();
    if (!body) {
      return res.status(404).json({
        error: 'validation_not_run',
        message: 'The SimEvents validation has not run on this machine yet. It runs '
          + 'weekly; POST /api/v1/admin/simulink-validation/refresh to run it now.',
      });
    }
    res.json(body);
  } catch (err) { next(err); }
});

router.post('/simulink-validation/refresh', adminOnly, async (req, res, next) => {
  try {
    const body = await simulinkValidation.refresh();
    await logAccess(req.user?.userId, 'refresh_simulink_validation', 'simulink_validation');
    res.json(body);
  } catch (err) {
    res.status(502).json({ error: 'simulink_validation_failed', message: err.message });
  }
});

module.exports = router;
