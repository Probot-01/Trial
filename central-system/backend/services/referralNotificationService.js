'use strict';


const pool = require('../db/pgClient');

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

const STATUS_CALLBACK_URL = process.env.TWILIO_STATUS_CALLBACK_URL || '';


const DRY_RUN = process.env.SMS_DRY_RUN === '1';

let twilioClient = null;
let twilioInitError = null;


function getTwilioClient() {
  if (twilioClient || twilioInitError) return twilioClient;
  if (!isConfigured()) return null;
  try {
    twilioClient = require('twilio')(TWILIO_SID, TWILIO_TOKEN);
  } catch (err) {
    twilioInitError = err;
    console.error('[referral] Twilio client init failed:', err.message);
  }
  return twilioClient;
}

function isConfigured() {
  return !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);
}


const TEMPLATES = {
  en: 'Your recent eye screening at {phc} needs a follow-up check with an eye '
    + 'doctor. Please visit {clinic} as soon as you can. Bring this message with you.',

  hi: 'आपकी हाल की आँखों की जाँच ({phc}) के बाद आँख के डॉक्टर से दोबारा जाँच '
    + 'कराना ज़रूरी है। कृपया जल्द से जल्द {clinic} पर जाएँ। यह संदेश साथ लाएँ।',
};

const DEFAULT_CLINIC = process.env.REFERRAL_CLINIC_NAME
  || 'the district hospital eye department';

function buildMessage({ language, phcName }) {
  const template = TEMPLATES[language] || TEMPLATES.en;
  return template
    .replace('{phc}', phcName || 'your health centre')
    .replace('{clinic}', DEFAULT_CLINIC);
}

/**
 * handleConfirmedReferral(caseId, opts)
 *
 * @param {string} caseId
 * @param {object} [opts]
 * @param {number} [opts.correctedGrade] — the ophthalmologist's own grade, when
 *        the decision was an override. See the note below.
 * @returns {Promise<{referralId, alreadyReferred, sms}>}
 */
async function handleConfirmedReferral(caseId, opts = {}) {
  const { rows } = await pool.query(`
    SELECT c.case_id, c.patient_id, c.questionnaire_data,
           p.contact_number, p.patient_reference,
           site.name AS phc_name,
           g.dr_grade_cnn, g.referable,
           r.decision, r.reviewed_at
    FROM cases c
    JOIN      patients        p    ON p.patient_id = c.patient_id
    LEFT JOIN phc_sites       site ON site.phc_id  = c.phc_id
    LEFT JOIN grading_results g    ON g.case_id    = c.case_id
    LEFT JOIN LATERAL (
      SELECT decision, reviewed_at FROM ophthalmologist_reviews
      WHERE case_id = c.case_id ORDER BY reviewed_at DESC LIMIT 1
    ) r ON true
    WHERE c.case_id = $1
  `, [caseId]);

  if (!rows.length) throw new Error(`handleConfirmedReferral: case ${caseId} not found`);
  const row = rows[0];

  // Guard the safety rule at the point of action, not only at the call site.
  // No human decision on record means no SMS, whatever the caller believes.
  if (!row.decision) {
    return skip(caseId, row, 'no_review_on_record',
      'No ophthalmologist review recorded for this case.');
  }


  let effectiveGrade;
  if (row.decision === 'confirm') {
    effectiveGrade = row.dr_grade_cnn;
  } else if (Number.isInteger(opts.correctedGrade)) {
    effectiveGrade = opts.correctedGrade;
  } else {
    return skip(caseId, row, 'override_without_grade',
      'Review was an override but no correctedGrade was supplied — cannot '
      + 'determine whether this case is referable. See api-contracts.md.');
  }

  if (!(effectiveGrade >= 2)) {
    // Non-referable: case closes, no SMS (design doc §8.1 step 8).
    return {
      referralId: null, alreadyReferred: false,
      sms: { status: 'not_referable', sent: false }
    };
  }

  // ── Referral row ──────────────────────────────────────────────────────────
  // ON CONFLICT against uq_referrals_case: a case reviewed twice must not
  // produce a second referral or a second SMS to the patient.
  const ref = await pool.query(`
    INSERT INTO referrals (case_id, status) VALUES ($1, 'referred')
    ON CONFLICT (case_id) DO NOTHING
    RETURNING referral_id
  `, [caseId]);

  const alreadyReferred = ref.rows.length === 0;
  const referralId = alreadyReferred
    ? (await pool.query('SELECT referral_id FROM referrals WHERE case_id = $1', [caseId]))
      .rows[0].referral_id
    : ref.rows[0].referral_id;

  if (alreadyReferred) {
    // Already handled by an earlier review. Do not re-send.
    return {
      referralId, alreadyReferred: true,
      sms: { status: 'already_sent', sent: false }
    };
  }

  // ── SMS ───────────────────────────────────────────────────────────────────
  const language = (row.questionnaire_data && row.questionnaire_data.language) || 'en';
  const body = buildMessage({ language, phcName: row.phc_name });
  const to = row.contact_number;

  if (!to) {
    // §10.5: nothing can be sent, so this needs a person, now -- not at
    // whatever point someone notices the tracker.
    await flipToManualFollowUp(referralId, 'no contact number on record');
    return {
      referralId, alreadyReferred: false,
      sms: await record(caseId, row, 'no_contact_number', null,
        'Patient has no contact number on record.')
    };
  }

  if (DRY_RUN || !isConfigured()) {
    const why = DRY_RUN ? 'dry_run' : 'not_configured';
    console.log(`[referral] SMS ${why} — would send to ${maskNumber(to)}:\n  ${body}`);

    if (why === 'not_configured') {
      await flipToManualFollowUp(referralId, 'SMS provider not configured');
    }
    return {
      referralId, alreadyReferred: false,
      sms: await record(caseId, row, why, null, null, body)
    };
  }

  const client = getTwilioClient();
  if (!client) {
    await flipToManualFollowUp(referralId, 'SMS client unavailable');
    return {
      referralId, alreadyReferred: false,
      sms: await record(caseId, row, 'client_unavailable', null,
        twilioInitError ? twilioInitError.message : 'unknown')
    };
  }

  try {

    const msg = await client.messages.create({
      body, from: TWILIO_FROM, to,
      ...(STATUS_CALLBACK_URL ? { statusCallback: STATUS_CALLBACK_URL } : {}),
    });
    console.log(`[referral] SMS sent to ${maskNumber(to)} (${msg.sid})`);
    return {
      referralId, alreadyReferred: false,
      sms: await record(caseId, row, 'sent', msg.sid, null, body)
    };
  } catch (err) {

    console.error(`[referral] SMS FAILED for case ${caseId}: ${err.message}`);
    await flipToManualFollowUp(referralId, 'SMS send failed');
    return {
      referralId, alreadyReferred: false,
      sms: await record(caseId, row, 'failed', null, err.message, body)
    };
  }
}


async function flipToManualFollowUp(referralId, why) {
  if (!referralId) return false;
  try {
    const { rowCount } = await pool.query(`
      UPDATE referrals SET status = 'manual_follow_up', updated_at = now()
      WHERE referral_id = $1 AND status = 'referred'
    `, [referralId]);
    if (rowCount) {
      console.warn(`[referral] ${referralId} -> manual_follow_up (${why})`);
    }
    return rowCount > 0;
  } catch (err) {
    console.error(`[referral] could not flip ${referralId} to manual follow-up: ${err.message}`);
    return false;
  }
}


async function handleDeliveryReport(providerMessageId, deliveryStatus, errorDetail) {
  const status = String(deliveryStatus || '').toLowerCase();
  const terminalFailure = status === 'undelivered' || status === 'failed';

  const { rows } = await pool.query(`
    UPDATE notifications
    SET status = $2, error_detail = COALESCE($3, error_detail)
    WHERE provider_message_id = $1
    RETURNING case_id
  `, [providerMessageId, terminalFailure ? `delivery_${status}` : status, errorDetail || null]);
  if (!rows.length) return { matched: false, flipped: false };

  if (!terminalFailure) return { matched: true, flipped: false };

  const ref = await pool.query(
    'SELECT referral_id FROM referrals WHERE case_id = $1', [rows[0].case_id]);
  const flipped = ref.rows.length
    ? await flipToManualFollowUp(ref.rows[0].referral_id, `SMS ${status}`)
    : false;
  return { matched: true, flipped, caseId: rows[0].case_id };
}

async function record(caseId, row, status, providerId, errorDetail, body) {
  await pool.query(`
    INSERT INTO notifications
      (patient_id, case_id, channel, message_type, status, provider_message_id, error_detail)
    VALUES ($1, $2, 'sms', 'positive', $3, $4, $5)
  `, [row.patient_id, caseId, status, providerId || null, errorDetail || null]);
  return {
    status, sent: status === 'sent', providerMessageId: providerId || null,
    errorDetail: errorDetail || null, body: body || null
  };
}

async function skip(caseId, row, status, message) {
  console.warn(`[referral] case ${caseId}: ${message}`);
  return {
    referralId: null, alreadyReferred: false,
    sms: { status, sent: false, errorDetail: message }
  };
}


function maskNumber(n) {
  const s = String(n);
  return s.length <= 4 ? '****' : `${s.slice(0, 3)}****${s.slice(-3)}`;
}

module.exports = {
  handleConfirmedReferral, isConfigured, buildMessage, TEMPLATES,
  handleDeliveryReport, flipToManualFollowUp,
};
