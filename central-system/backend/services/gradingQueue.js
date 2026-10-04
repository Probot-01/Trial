'use strict';


const pool = require('../db/pgClient');
const { processCase } = require('./gradingOrchestrator');


const CONCURRENCY = Math.max(1, parseInt(process.env.GRADING_CONCURRENCY || '1', 10));

const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.GRADING_MAX_ATTEMPTS || '3', 10));

const RETRY_BASE_MS = parseInt(process.env.GRADING_RETRY_BASE_MS || '2000', 10);

const PERMANENT = new Set([
  'image_not_found', 'invalid_image_type', 'case_not_found',
  'matlab_unavailable', 'python_unavailable',
]);

const queue = [];              // caseIds waiting for a worker
const queued = new Set();      // membership test for the above (dedupe)
const inflight = new Set();    // caseIds a worker currently holds
const retrying = new Set();    // caseIds waiting out a retry backoff (neither of the above)

let workers = 0;
let started = false;
let processed = 0;
let failed = 0;
let idleWaiters = [];

// Injectable so tests can drive the queue without MATLAB. Production never
// touches this.
let runGrading = processCase;

/**
 * enqueue(caseId)
 *
 * @returns {boolean} true if newly queued, false if already queued or inflight.

 */
function enqueue(caseId) {
  if (!caseId) throw new Error('enqueue: caseId is required');
  if (queued.has(caseId) || inflight.has(caseId) || retrying.has(caseId)) return false;
  queue.push({ caseId, attempts: 0 });
  queued.add(caseId);

  clearFailure(caseId);
  if (started) pump();
  return true;
}

/** Spin up workers until concurrency is reached or the queue is empty. */
function pump() {
  while (started && workers < CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    queued.delete(job.caseId);
    workers++;
    inflight.add(job.caseId);
    runJob(job).finally(() => {
      workers--;
      inflight.delete(job.caseId);
      if (queue.length > 0) pump();
      else if (workers === 0) resolveIdle();
    });
  }
  if (queue.length === 0 && workers === 0) resolveIdle();
}

async function runJob(job) {
  job.attempts++;
  try {
    await runGrading(job.caseId);
    processed++;
  } catch (err) {
    const permanent = PERMANENT.has(err.code);
    const exhausted = job.attempts >= MAX_ATTEMPTS;

    if (permanent || exhausted) {
      failed++;
      console.error(
        `[gradingQueue] ${job.caseId} failed after ${job.attempts} attempt(s)`
        + `${permanent ? ' (permanent)' : ''}: ${err.message}`);
      await markError(job.caseId, err, job.attempts);
      return;
    }

    const delay = RETRY_BASE_MS * Math.pow(2, job.attempts - 1);
    console.warn(
      `[gradingQueue] ${job.caseId} attempt ${job.attempts} failed, retrying in `
      + `${delay}ms: ${err.message}`);

    retrying.add(job.caseId);
    const t = setTimeout(() => {
      retrying.delete(job.caseId);
      if (!queued.has(job.caseId) && !inflight.has(job.caseId)) {
        queue.push(job);
        queued.add(job.caseId);
        if (started) pump();
      }
    }, delay);
    if (t.unref) t.unref();   // a pending retry must not hold the process open
  }
}

async function markError(caseId, err, attempts) {
  const code = (err && err.code) || 'unknown';
  const reason = [
    err && err.message ? String(err.message) : 'no message',
    attempts ? `(after ${attempts} attempt${attempts === 1 ? '' : 's'})` : '',
  ].join(' ').trim().slice(0, 500);
  try {
    await pool.query(
      `UPDATE cases
          SET status = 'error', failure_code = $2, failure_reason = $3,
              failed_at = now()
        WHERE case_id = $1`, [caseId, code, reason]);
  } catch (dbErr) {
    console.error(`[gradingQueue] could not mark ${caseId} as error: ${dbErr.message}`);
  }
}


async function clearFailure(caseId) {
  try {
    await pool.query(
      `UPDATE cases SET failure_code = NULL, failure_reason = NULL, failed_at = NULL
        WHERE case_id = $1 AND failure_code IS NOT NULL`, [caseId]);
  } catch (err) {
    console.error(`[gradingQueue] could not clear the failure on ${caseId}: ${err.message}`);
  }
}


async function recoverStranded({ source = 'boot', minAgeSeconds = 0, maxRecoveries = null } = {}) {
  let rows;
  try {

    ({ rows } = await pool.query(`
      SELECT c.case_id
      FROM cases c
      WHERE c.status = 'processing'
        AND COALESCE(c.processing_started_at, c.received_at)
              <= now() - make_interval(secs => $1)
        AND ($2::int IS NULL OR
             (SELECT count(*) FROM grading_recoveries r WHERE r.case_id = c.case_id) < $2::int)
      ORDER BY COALESCE(c.processing_started_at, c.received_at) ASC
    `, [minAgeSeconds, maxRecoveries]));
  } catch (err) {

    console.error(`[gradingQueue] stranded-case recovery failed: ${err.message}`);
    return 0;
  }


  const recovered = rows.map((r) => r.case_id).filter((id) => enqueue(id));
  if (recovered.length > 0) {
    console.log(`[gradingQueue] ${source}: recovered ${recovered.length} case(s) ` +
      "left 'processing' with no job behind them");
    try {
      await pool.query(`
        INSERT INTO grading_recoveries (case_id, source)
        SELECT unnest($1::uuid[]), $2
      `, [recovered, source]);
    } catch (err) {
      console.error(`[gradingQueue] could not record recoveries: ${err.message}`);
    }
  }
  return recovered.length;
}

function start() {
  if (started) return;
  started = true;
  pump();
}

async function stop({ drain = false } = {}) {
  started = false;
  if (drain && workers > 0) await onIdle();
}

/** Resolves when nothing is queued and no worker is running. */
function onIdle() {
  if (queue.length === 0 && workers === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

function resolveIdle() {
  if (queue.length > 0 || workers > 0) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const w of waiters) w();
}

function stats() {
  return {
    queued: queue.length,
    inflight: inflight.size,
    retrying: retrying.size,
    processed,
    failed,
    concurrency: CONCURRENCY,
    running: started,
  };
}

/** Test seam. Returns the previous function so a test can restore it. */
function _setGradingFn(fn) {
  const prev = runGrading;
  runGrading = fn || processCase;
  return prev;
}

/** Test seam: drop all state. Never call this from production code. */
function _reset() {
  queue.length = 0;
  queued.clear();
  inflight.clear();
  retrying.clear();
  workers = 0;
  started = false;
  processed = 0;
  failed = 0;
  idleWaiters = [];
  runGrading = processCase;
}

module.exports = {
  enqueue, start, stop, onIdle, recoverStranded, stats, clearFailure,
  _setGradingFn, _reset,
  MAX_ATTEMPTS, CONCURRENCY,
};
