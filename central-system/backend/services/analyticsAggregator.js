'use strict';



const pool = require('../db/pgClient');


const REPORT_TZ = process.env.REPORT_TIMEZONE || 'Asia/Kolkata';


async function getDashboard() {
  const [today, perPhc, turnaround, totals, reviews, grades, weekly] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS n
      FROM cases
      WHERE (received_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
    `, [REPORT_TZ]),

    pool.query(`
      SELECT c.phc_id, s.name AS phc_name, COUNT(*)::int AS n
      FROM cases c
      LEFT JOIN phc_sites s ON s.phc_id = c.phc_id
      WHERE (c.received_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
      GROUP BY c.phc_id, s.name
      ORDER BY n DESC, s.name NULLS LAST
    `, [REPORT_TZ]),

    pool.query(`
      SELECT AVG(review_duration_seconds)::float AS avg_seconds
      FROM ophthalmologist_reviews
      WHERE review_duration_seconds IS NOT NULL
    `),

    // Cases received in the last 7 days / graded cases / their mean confidence.
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE c.received_at >= now() - interval '7 days')::int AS week_n,
        COUNT(*) FILTER (WHERE c.status = 'graded')::int                          AS graded_n,
        AVG(g.confidence_score)::float                                            AS avg_conf
      FROM cases c
      LEFT JOIN grading_results g ON g.case_id = c.case_id
    `),

    // Override rate over recorded reviews.
    pool.query(`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE decision = 'override')::int AS overrides
      FROM ophthalmologist_reviews
    `),

    // The classifier's grade, per grade, over graded cases.
    pool.query(`
      SELECT dr_grade_cnn AS grade, COUNT(*)::int AS n
      FROM grading_results WHERE dr_grade_cnn IS NOT NULL GROUP BY dr_grade_cnn
    `),

    // Last six local weeks, oldest first, zeros included (a real zero is data).
    pool.query(`
      WITH weeks AS (
        SELECT date_trunc('week', (now() AT TIME ZONE $1)) - (n * interval '1 week') AS wk
        FROM generate_series(5, 0, -1) AS n
      )
      SELECT to_char(w.wk, 'IYYY-"W"IW') AS week,
             (SELECT COUNT(*)::int FROM cases c
               WHERE date_trunc('week', c.received_at AT TIME ZONE $1) = w.wk) AS cases,
             (SELECT COUNT(*)::int FROM referrals r
               JOIN cases c ON c.case_id = r.case_id
               WHERE date_trunc('week', c.received_at AT TIME ZONE $1) = w.wk) AS referrals
      FROM weeks w ORDER BY w.wk
    `, [REPORT_TZ]),
  ]);

  const avg = turnaround.rows[0].avg_seconds;

  return {
    casesToday: today.rows[0].n,
    casesPerPhc: perPhc.rows.map((r) => ({
      phcId: r.phc_id ?? null,
      phcName: r.phc_name ?? null,   // null = cases that arrived without a PHC id
      count: r.n,
    })),

    averageReviewTurnaroundSeconds: avg === null ? null : Math.round(avg),

    casesThisWeek: totals.rows[0].week_n,
    totalCasesProcessed: totals.rows[0].graded_n,
    // null, never 0, when there is nothing to divide -- same rule as the average above.
    overrideRate: reviews.rows[0].n === 0 ? null : reviews.rows[0].overrides / reviews.rows[0].n,
    avgConfidenceScore: totals.rows[0].avg_conf === null ? null : totals.rows[0].avg_conf,
    drGradeDistribution: gradeDistribution(grades.rows),
    weeklyTrend: weekly.rows,
  };
}

const GRADE_LABELS = { 0: 'No DR', 1: 'Mild NPDR', 2: 'Moderate NPDR', 3: 'Severe NPDR', 4: 'PDR' };

/** All five grades, zeros included; null when nothing has been graded. */
function gradeDistribution(rows) {
  const byGrade = new Map(rows.map((r) => [r.grade, r.n]));
  const total = [...byGrade.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  return [0, 1, 2, 3, 4].map((g) => {
    const count = byGrade.get(g) || 0;
    return { grade: g, label: GRADE_LABELS[g], count, percentage: Math.round((count / total) * 1000) / 10 };
  });
}


async function getReferrals() {
  return selectReferrals(null);
}


async function selectReferrals(referralId) {
  const { rows } = await pool.query(`
    SELECT r.referral_id, r.status, r.assigned_worker, r.updated_at,
           p.patient_reference, s.name AS phc_name,
           COALESCE(
             (SELECT rv.corrected_grade FROM ophthalmologist_reviews rv
               WHERE rv.case_id = c.case_id AND rv.corrected_grade IS NOT NULL
               ORDER BY rv.reviewed_at DESC LIMIT 1),
             g.dr_grade_cnn) AS dr_grade
    FROM referrals r
    JOIN cases    c ON c.case_id    = r.case_id
    JOIN patients p ON p.patient_id = c.patient_id
    LEFT JOIN phc_sites       s ON s.phc_id  = c.phc_id
    LEFT JOIN grading_results g ON g.case_id = c.case_id
    WHERE ($1::uuid IS NULL OR r.referral_id = $1::uuid)
    ORDER BY r.updated_at DESC
  `, [referralId]);
  return rows.map(toReferral);
}

/** Update a referral's tracking state. Returns null if it does not exist. */
async function updateReferral(referralId, { status, assignedWorker }) {
  const { rowCount } = await pool.query(`
    UPDATE referrals r
    SET status          = COALESCE($2, r.status),
        -- Distinguish "not supplied" from "cleared". undefined leaves the
        -- worker unchanged; an explicit null unassigns them, which is a real
        -- action when a worker leaves or a case is reassigned.
        assigned_worker = CASE WHEN $4 THEN $3 ELSE r.assigned_worker END,
        updated_at      = now()
    FROM cases c, patients p
    WHERE r.referral_id = $1
      AND c.case_id    = r.case_id
      AND p.patient_id = c.patient_id
  `, [referralId, status ?? null, assignedWorker ?? null,
    assignedWorker !== undefined]);

  if (!rowCount) return null;
  return (await selectReferrals(referralId))[0] ?? null;
}


async function getPhcSyncStatus(phcId) {
  const { rows } = await pool.query(
    'SELECT phc_id, name, last_sync_at, last_contact_at, pending_count FROM phc_sites WHERE phc_id = $1',
    [phcId]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    phcId: r.phc_id,
    phcName: r.name,
    lastSyncAt: r.last_sync_at ? r.last_sync_at.toISOString() : null,

    lastContactAt: r.last_contact_at ? r.last_contact_at.toISOString() : null,
    pendingCount: r.pending_count ?? 0,
  };
}

const { PHC_SILENT_HOURS, isSilent } = require('./phcSilence');


async function getPhcs() {
  const { rows } = await pool.query(`
    SELECT s.phc_id, s.phc_code, s.name, s.district, s.pending_count, s.last_contact_at,
           (SELECT MAX(c.received_at) FROM cases c WHERE c.phc_id = s.phc_id) AS last_received,
           (SELECT COUNT(*)::int FROM cases c
             WHERE c.phc_id = s.phc_id AND c.received_at > now() - interval '24 hours') AS cases_24h,
           (SELECT COUNT(*)::int FROM cases c
             WHERE c.phc_id = s.phc_id AND c.status = 'error') AS failed
    FROM phc_sites s
    ORDER BY s.name, s.phc_id
  `);
  return rows.map((r) => ({
    phcId: r.phc_id,
    phcCode: r.phc_code ?? null,
    name: r.name,
    district: r.district ?? null,
    lastSyncAt: r.last_received ? r.last_received.toISOString() : null,
    casesLast24h: r.cases_24h,
    pendingOrFailedCount: (r.pending_count ?? 0) + r.failed,
    lastContactAt: r.last_contact_at ? r.last_contact_at.toISOString() : null,
    status: isSilent(r.last_contact_at) ? 'silent' : 'active',
  }));
}

function toReferral(r) {
  return {
    referralId: r.referral_id,
    patientReference: r.patient_reference ?? null,
    status: r.status,
    assignedWorker: r.assigned_worker ?? null,
    phcName: r.phc_name ?? null,
    drGrade: r.dr_grade ?? null,
    updatedAt: r.updated_at.toISOString(),
  };
}

module.exports = {
  getDashboard, getReferrals, updateReferral, getPhcSyncStatus, getPhcs, REPORT_TZ,
};
