'use strict';


const fs = require('fs');
const path = require('path');

const pool = require('../db/pgClient');

const MODELS_DIR = path.resolve(__dirname, '..', 'ml-pipeline', 'models');
const LIVE_MODEL = path.join(MODELS_DIR, 'branchA_v1.mat');
const TRAINING_DIR = path.resolve(__dirname, '..', 'ml-pipeline', 'training');

const DEFAULT_THRESHOLD = parseInt(process.env.RETRAIN_THRESHOLD || '20', 10);
const DEFAULT_SCHEDULE = process.env.RETRAIN_SCHEDULE || '0 2 * * *';  // 02:00 daily

const GATED_METRICS = [
  { column: 'validation_sensitivity', label: 'sensitivity' },
  { column: 'validation_specificity', label: 'specificity' },
  { column: 'validation_kappa', label: 'kappa' },
];

async function getLiveVersion() {
  const { rows } = await pool.query(
    'SELECT * FROM model_versions WHERE promoted = true ORDER BY promoted_at DESC LIMIT 1');
  return rows[0] || null;
}


async function countPendingCorrections() {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM corrections WHERE used_in_model_version IS NULL');
  return rows[0].n;
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * promotionDecision(live, candidate)
 *
 * @param {object|null} live      the currently promoted version, or null
 * @param {object} candidate      { sensitivity, specificity, kappa }
 * @returns {{promote: boolean, reasons: string[], bootstrap: boolean}}
 *
 * Pure and synchronous, so the gate can be unit-tested exhaustively without a
 * database or a model. For the one component that can change clinical behaviour
 * unattended, that testability is the point.
 */
function promotionDecision(live, candidate) {
  const reasons = [];

  for (const m of GATED_METRICS) {
    const v = candidate[metricKey(m.column)];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      reasons.push(`candidate ${m.label} is missing or not a number — cannot evaluate`);
      return { promote: false, reasons, bootstrap: false };
    }
  }


  const liveHasMetrics = live && GATED_METRICS.every(
    (m) => typeof live[m.column] === 'number' && Number.isFinite(live[m.column]));

  if (!liveHasMetrics) {
    reasons.push(live
      ? `live version '${live.version_id}' has no recorded metrics — nothing to compare against`
      : 'no promoted version exists yet');
    return { promote: true, reasons, bootstrap: true };
  }

  // The gate proper: no gated metric may be worse than the live model's.
  let promote = true;
  for (const m of GATED_METRICS) {
    const liveVal = live[m.column];
    const candVal = candidate[metricKey(m.column)];
    if (candVal < liveVal) {
      promote = false;
      reasons.push(`${m.label} REGRESSED: ${candVal.toFixed(4)} < ${liveVal.toFixed(4)}`);
    } else {
      reasons.push(`${m.label} ok: ${candVal.toFixed(4)} >= ${liveVal.toFixed(4)}`);
    }
  }

  return { promote, reasons, bootstrap: false };
}

function metricKey(column) {
  return {
    validation_sensitivity: 'sensitivity',
    validation_specificity: 'specificity',
    validation_kappa: 'kappa'
  }[column];
}


async function defaultRetrainFn(ctx) {
  const script = path.join(TRAINING_DIR, 'retrainBranchA.m');
  if (!fs.existsSync(script)) {
    const err = new Error(
      `continualLearning: retraining script not found at ${script}. ` +
      'Task 7.2 needs a variant of trainBranchAClassifier.m that fine-tunes the ' +
      'current model on the original data plus the corrected cases oversampled ' +
      '3x, and returns held-out sensitivity/specificity/kappa. Until it exists ' +
      'this job correctly refuses to run rather than inventing metrics.');
    err.code = 'retrain_not_implemented';
    throw err;
  }
  throw Object.assign(
    new Error('continualLearning: retrainBranchA.m exists but its Node bridge is not wired.'),
    { code: 'retrain_not_wired', ctx });
}

// ── One cycle ───────────────────────────────────────────────────────────────

/**
 * runOnce(opts)
 *
 * @param {object} [opts]
 * @param {number}   [opts.threshold]   corrections needed to trigger
 * @param {function} [opts.retrainFn]   injectable retraining step
 * @param {boolean}  [opts.dryRun]      evaluate and decide, write nothing
 * @param {boolean}  [opts.swapModelFile] default true
 * @returns {Promise<object>} a summary of what happened and why
 */
async function runOnce(opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const retrainFn = opts.retrainFn ?? defaultRetrainFn;
  const dryRun = !!opts.dryRun;
  const swapFile = opts.swapModelFile !== false;

  const live = await getLiveVersion();
  const pending = await countPendingCorrections();

  if (pending < threshold) {
    return {
      action: 'skipped', reason: 'below_threshold', pending, threshold,
      liveVersion: live ? live.version_id : null
    };
  }

  console.log(`[continualLearning] ${pending} pending corrections (threshold ${threshold}) — retraining`);

  let candidate;
  try {
    candidate = await retrainFn({ live, pendingCorrections: pending });
  } catch (err) {
    // A failed retrain leaves everything untouched: no version row, and the
    // corrections stay queued for the next attempt (design doc §8.4).
    console.error('[continualLearning] retraining failed:', err.message);
    return {
      action: 'failed', reason: err.code || 'retrain_error',
      message: err.message, pending, liveVersion: live ? live.version_id : null
    };
  }

  const decision = promotionDecision(live, candidate);

  console.log(`[continualLearning] candidate '${candidate.versionId}': `
    + `${decision.promote ? 'PROMOTE' : 'REJECT'}`);
  for (const r of decision.reasons) console.log(`    ${r}`);

  if (dryRun) {
    return {
      action: 'dry_run', candidate, decision, pending,
      liveVersion: live ? live.version_id : null
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');


    await client.query(`
      INSERT INTO model_versions
        (version_id, trained_at, validation_sensitivity, validation_specificity,
         validation_kappa, promoted, promoted_at)
      VALUES ($1, now(), $2, $3, $4, false, NULL)
      ON CONFLICT (version_id) DO UPDATE SET
        trained_at             = now(),
        validation_sensitivity = EXCLUDED.validation_sensitivity,
        validation_specificity = EXCLUDED.validation_specificity,
        validation_kappa       = EXCLUDED.validation_kappa
    `, [candidate.versionId, candidate.sensitivity, candidate.specificity, candidate.kappa]);

    if (!decision.promote) {
      await client.query('COMMIT');
      // Corrections deliberately stay unconsumed, so the next cycle retries
      // with these plus whatever has accumulated since.
      return {
        action: 'rejected', candidate, decision, pending,
        liveVersion: live ? live.version_id : null
      };
    }

    // Exactly one promoted version at a time. Demoting inside the same
    // transaction is what makes that an invariant rather than a convention.
    await client.query('UPDATE model_versions SET promoted = false WHERE promoted = true');
    await client.query(
      'UPDATE model_versions SET promoted = true, promoted_at = now() WHERE version_id = $1',
      [candidate.versionId]);

    // Mark the corrections consumed — only now that they actually shaped a
    // promoted model.
    await client.query(
      'UPDATE corrections SET used_in_model_version = $1 WHERE used_in_model_version IS NULL',
      [candidate.versionId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }


  if (swapFile && candidate.modelPath) {
    try {
      await swapLiveModel(candidate.modelPath);
    } catch (err) {
      console.error('[continualLearning] model swap FAILED, reverting promotion:', err.message);
      await pool.query(
        'UPDATE model_versions SET promoted = false, promoted_at = NULL WHERE version_id = $1',
        [candidate.versionId]);
      if (live) {
        await pool.query(
          'UPDATE model_versions SET promoted = true WHERE version_id = $1', [live.version_id]);
      }
      await pool.query(
        'UPDATE corrections SET used_in_model_version = NULL WHERE used_in_model_version = $1',
        [candidate.versionId]);
      return {
        action: 'failed', reason: 'model_swap_failed', message: err.message,
        candidate, decision
      };
    }
  }

  console.log(`[continualLearning] promoted '${candidate.versionId}'`
    + (decision.bootstrap ? ' (BOOTSTRAP — no prior metrics to compare against)' : ''));

  return {
    action: 'promoted', candidate, decision, pending,
    previousVersion: live ? live.version_id : null
  };
}


async function swapLiveModel(candidatePath) {
  if (!fs.existsSync(candidatePath)) {
    throw new Error(`candidate model not found at ${candidatePath}`);
  }
  if (fs.existsSync(LIVE_MODEL)) {
    const backup = `${LIVE_MODEL}.previous`;
    fs.copyFileSync(LIVE_MODEL, backup);
  }
  fs.copyFileSync(candidatePath, LIVE_MODEL);
}

// ── Scheduling ──────────────────────────────────────────────────────────────

let task = null;

/**
 * start(opts)
 *
 * @param {object} [opts] .schedule (cron), plus anything runOnce accepts
 * @returns {{stop: function}}
 */
function start(opts = {}) {
  const cron = require('node-cron');
  const schedule = opts.schedule || DEFAULT_SCHEDULE;

  if (!cron.validate(schedule)) {
    throw new Error(`continualLearning: invalid cron schedule '${schedule}'`);
  }

  if (task) return { stop };

  task = cron.schedule(schedule, async () => {
    try {
      await runOnce(opts);
    } catch (err) {

      console.error('[continualLearning] cycle error:', err.message);
    }
  });

  console.log(`[continualLearning] scheduled '${schedule}' `
    + `(threshold ${opts.threshold ?? DEFAULT_THRESHOLD} corrections)`);
  return { stop };
}

function stop() {
  if (task) { task.stop(); task = null; }
}

module.exports = {
  runOnce, start, stop,
  promotionDecision, getLiveVersion, countPendingCorrections, swapLiveModel,
  GATED_METRICS, DEFAULT_THRESHOLD,
};
