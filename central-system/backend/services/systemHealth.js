'use strict';



const pool = require('../db/pgClient');
const supervisor = require('./matlabSessionSupervisor');
const segSupervisor = require('./segWorkerSupervisor');
const { openAlerts } = require('./systemAlerts');
const watchdog = require('./gradingWatchdog');

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const { PHC_SILENT_HOURS } = require('./phcSilence');   // the one definition of a silent PHC
const STUCK_JOB_MINUTES = num('STUCK_JOB_MINUTES', 15);
const UNREVIEWED_CASE_HOURS = num('UNREVIEWED_CASE_HOURS', 48);

const hoursSince = (d) => (d ? Math.floor((Date.now() - d.getTime()) / 3_600_000) : null);

async function silentPhcs() {

  const { rows } = await pool.query(`
    SELECT phc_id, name, last_contact_at
    FROM phc_sites
    WHERE last_contact_at IS NULL
       OR last_contact_at < now() - make_interval(hours => $1)
    ORDER BY last_contact_at ASC NULLS FIRST
  `, [PHC_SILENT_HOURS]);   // same rule as phcSilence.isSilent()
  return rows.map((r) => ({
    phcId: r.phc_id,
    phcName: r.name,
    lastContactAt: r.last_contact_at ? r.last_contact_at.toISOString() : null,
    hoursSilent: hoursSince(r.last_contact_at),
  }));
}

async function stuckJobs() {

  const { rows } = await pool.query(`
    SELECT c.case_id,
           COALESCE(c.processing_started_at, c.received_at) AS started_at,
           count(r.recovery_id)::int AS recoveries,
           max(r.recovered_at)       AS last_recovered_at
    FROM cases c
    LEFT JOIN grading_recoveries r ON r.case_id = c.case_id
    WHERE c.status = 'processing'
    GROUP BY c.case_id, c.processing_started_at, c.received_at
    HAVING GREATEST(COALESCE(c.processing_started_at, c.received_at),
                    COALESCE(max(r.recovered_at),
                             COALESCE(c.processing_started_at, c.received_at)))
             < now() - make_interval(mins => $1)
        OR count(r.recovery_id) >= $2
    ORDER BY COALESCE(c.processing_started_at, c.received_at) ASC
  `, [STUCK_JOB_MINUTES, watchdog.MAX_RECOVERIES]);
  return rows.map((r) => ({
    caseId: r.case_id,
    stuckSince: r.started_at.toISOString(),
    autoRecoveredCount: r.recoveries,
    lastRecoveredAt: r.last_recovered_at ? r.last_recovered_at.toISOString() : null,
    autoRecoveryExhausted: r.recoveries >= watchdog.MAX_RECOVERIES,
  }));
}

async function unreviewedCases() {
  const { rows } = await pool.query(`
    SELECT c.case_id, g.conformal_tier, c.received_at
    FROM cases c
    JOIN grading_results g ON g.case_id = c.case_id
    WHERE g.referable = true
      AND c.received_at < now() - make_interval(hours => $1)
      AND NOT EXISTS (SELECT 1 FROM ophthalmologist_reviews r WHERE r.case_id = c.case_id)
    ORDER BY c.received_at ASC
  `, [UNREVIEWED_CASE_HOURS]);
  return rows.map((r) => ({
    caseId: r.case_id,
    tier: r.conformal_tier,
    createdAt: r.received_at.toISOString(),
    hoursUnreviewed: hoursSince(r.received_at),
  }));
}

async function failedCases() {

  const { rows } = await pool.query(`
    SELECT COALESCE(failure_code, 'not_recorded') AS code,
           count(*)::int AS n,
           max(failed_at) AS last_failed_at,
           (array_agg(failure_reason ORDER BY failed_at DESC NULLS LAST))[1] AS example,
           (array_agg(case_id::text ORDER BY failed_at DESC NULLS LAST))[1] AS example_case
      FROM cases
     WHERE status = 'error'
     GROUP BY 1
     ORDER BY 2 DESC
  `);
  return rows.map((r) => ({
    failureCode: r.code,
    count: r.n,
    lastFailedAt: r.last_failed_at ? r.last_failed_at.toISOString() : null,

    exampleReason: r.example
      || (r.code === 'not_recorded' ? 'failed before the reason was recorded' : null),
    exampleCaseId: r.example_case,
  }));
}

async function getSystemHealth() {
  const [phcs, stuck, failed, unreviewed, alerts] = await Promise.all([
    silentPhcs(), stuckJobs(), failedCases(), unreviewedCases(), openAlerts(),
  ]);
  const matlab = supervisor.getStatus();
  const segWorker = segSupervisor.getStatus();
  return {
    silentPhcs: phcs,
    stuckJobs: stuck,

    failedCases: failed,
    failedCaseCount: failed.reduce((n, f) => n + f.count, 0),
    matlabSessionStatus: matlab.status,
    unreviewedCases: unreviewed,

    matlabSession: matlab,

    segWorker,
    alerts,
    thresholds: {
      silentPhcHours: PHC_SILENT_HOURS,
      stuckJobMinutes: STUCK_JOB_MINUTES,
      unreviewedCaseHours: UNREVIEWED_CASE_HOURS,
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getSystemHealth, PHC_SILENT_HOURS, STUCK_JOB_MINUTES, UNREVIEWED_CASE_HOURS };
