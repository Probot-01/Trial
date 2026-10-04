'use strict';



const express = require('express');
const { handleDeliveryReport } = require('../services/referralNotificationService');

const router = express.Router();


router.use(express.urlencoded({ extended: false, limit: '16kb' }));

const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const CALLBACK_URL = process.env.TWILIO_STATUS_CALLBACK_URL || '';

function verifyTwilioSignature(req) {
  if (!AUTH_TOKEN || !CALLBACK_URL) return false;
  try {
    const twilio = require('twilio');
    return twilio.validateRequest(
      AUTH_TOKEN, req.get('X-Twilio-Signature') || '', CALLBACK_URL, req.body || {});
  } catch (err) {
    console.error(`[notifications] signature check failed: ${err.message}`);
    return false;
  }
}

router.post('/sms-status', async (req, res) => {
  if (!verifyTwilioSignature(req)) {
    console.warn('[notifications] rejected an unsigned or unverifiable delivery report');
    return res.status(403).json({
      error: 'invalid_signature',
      message: 'This endpoint accepts only signed Twilio status callbacks.',
    });
  }

  const sid = req.body?.MessageSid;
  const status = req.body?.MessageStatus;
  const detail = req.body?.ErrorCode
    ? `Twilio error ${req.body.ErrorCode}${req.body.ErrorMessage ? `: ${req.body.ErrorMessage}` : ''}`
    : null;

  try {
    const out = await handleDeliveryReport(sid, status, detail);
    if (!out.matched) {

      console.warn(`[notifications] delivery report for unknown message ${sid} (${status})`);
    }
  } catch (err) {
    console.error(`[notifications] delivery report for ${sid} failed: ${err.message}`);
  }
  res.status(204).end();
});

module.exports = router;
