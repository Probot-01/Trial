#!/usr/bin/env node
'use strict';



const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pool = require(path.join(ROOT, 'central-system', 'backend', 'db', 'pgClient'));

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : (process.argv[i + 1] || dflt);
}

/** A measured value, with enough context to judge it. */
function measured(value, n, note) {
  return { value, source: 'measured', n, note };
}
function assumed(value, note) {
  return { value, source: 'assumed', n: null, note };
}

async function qualityGate() {

  const dbPath = path.join(ROOT, 'phc-local-app', 'backend', 'db', 'local.sqlite');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const Database = require(path.join(ROOT, 'phc-local-app', 'backend',
      'node_modules', 'better-sqlite3'));
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT quality_status, count(*) n FROM captures GROUP BY 1').all();
    db.close();
    const total = rows.reduce((a, r) => a + r.n, 0);
    const pass = (rows.find((r) => r.quality_status === 'pass') || { n: 0 }).n;
    return { pass, total };
  } catch {
    return null;
  }
}

async function main() {
  const out = {
    generatedAt: new Date().toISOString(),
    provenance: 'scripts/exportSimCalibration.js, from the live central database '
      + 'and the PHC SQLite file on this machine',
  };

  // ── Grading ──────────────────────────────────────────────────────────────
  const graded = await pool.query(
    "SELECT count(*)::int n FROM cases WHERE status = 'graded'");
  const failed = await pool.query(
    "SELECT count(*)::int n FROM cases WHERE status = 'error'");
  const recov = await pool.query('SELECT count(*)::int n FROM grading_recoveries');

  const totalRun = graded.rows[0].n + failed.rows[0].n;
  // 21 s was measured against branchA_v1 at 384 px. The classifier moved to
  // branchA_v2c at 512 px on 2026-09-23 and the red-lesion model to v2, and
  // six end-to-end runs that day took 27.4, 31.7, 31.9, 33.9, 47.9 and 62.5 s
  // -- mean ~39 s. Left as a hardcoded figure because it is a WALL-CLOCK
  // measurement of this machine, which the database cannot supply: cases are
  // timestamped at grading completion, not at start, so a duration derived
  // from the rows would silently include queue waiting time.
  //
  // RE-MEASURE THIS whenever the model versions change. A district model fed a
  // per-case service time from the previous classifier understates every queue
  // in it, and nothing about the output looks wrong when it does.
  out.gradingSeconds = measured(39, 6,
    'end-to-end per case with the MATLAB session and segmentation worker warm, '
    + 'branchA_v2c (512 px) + red lesion v2; mean of 6 runs on this machine '
    + '(27.4-62.5 s), not derived from the database');
  out.gradingFailureRate = measured(
    totalRun ? failed.rows[0].n / totalRun : 0, totalRun,
    'cases that ended in error over all cases that ran. Inflated by development '
    + 'runs against a half-built pipeline -- treat as an upper bound, and see '
    + 'failure_code on each case for what actually broke');
  out.recoveriesPerCase = measured(
    totalRun ? recov.rows[0].n / totalRun : 0, totalRun,
    'watchdog re-queues per case: how often a case stalled and had to be picked up again');

  // ── Tiers: both versions, clearly separated ──────────────────────────────
  const tier = await pool.query(
    'SELECT conformal_tier t, count(*)::int n FROM grading_results '
    + 'WHERE conformal_tier IS NOT NULL GROUP BY 1');
  const byTier = Object.fromEntries(tier.rows.map((r) => [r.t, r.n]));
  const tierTotal = (byTier.A || 0) + (byTier.B || 0) + (byTier.C || 0);
  out.tierFractionsObserved = measured(
    tierTotal ? [(byTier.A || 0) / tierTotal, (byTier.B || 0) / tierTotal,
    (byTier.C || 0) / tierTotal] : null,
    tierTotal,
    'THIS CORPUS, which is mostly IDRiD -- a teaching set enriched for disease. '
    + 'NOT a screening population. Do not use as the model default.');
  // ── THE MODEL DEFAULT: measured on HELD-OUT data, not on this database ────
  // 50-fold cross-fit of the shipped conformal policy over the 628-image
  // held-out test split, scored against ground-truth labels
  // (diagnostics/out/conformal_v3_crossfit_report_branchA_v2c.json).
  //
  // This replaces the design-doc assumption of 0.70/0.20/0.10, and it is NOT
  // the same thing as tierFractionsObserved above. That one is this
  // development database, where 60 of 72 cases are grade 3 because it was
  // seeded with diseased images for testing -- a 3% auto-clear rate there is
  // correct behaviour on a corpus with almost nothing to clear, and useless
  // as a population estimate.
  //
  // What makes this one usable: same measurement, proper sample. 38.4% of
  // cases auto-clear and the false auto-clear rate for truly referable
  // patients is 0.0 across all 50 folds -- so the workload reduction is real
  // and nothing referable is being cleared to achieve it.
  out.tierFractions = measured([0.38405690395145775, 0.4375477282817819,
    0.1783953677667604], 628,
    'branchA_v2c conformal policy, 50-fold cross-fit on the held-out test '
    + 'split scored against ground truth; false auto-clear of truly referable '
    + 'cases 0.0 across all folds. NOT this database -- see '
    + 'tierFractionsObserved for that, and why it is not a population estimate');

  // ── Quality gate ─────────────────────────────────────────────────────────
  const qg = await qualityGate();
  if (qg && qg.total) {
    out.qualityPassRate = measured(qg.pass / qg.total, qg.total,
      'captures accepted first time at the PHC; the rest are retakes, so the '
      + 'patient is photographed again before anything syncs');
  } else {
    out.qualityPassRate = assumed(0.885,
      'the clean-image acceptance rate measured during quality-gate calibration');
  }

  // ── Review ───────────────────────────────────────────────────────────────
  const rev = await pool.query(
    'SELECT count(*)::int n, avg(review_duration_seconds)::float avg '
    + 'FROM ophthalmologist_reviews WHERE review_duration_seconds IS NOT NULL');
  if (rev.rows[0].n > 0) {
    out.reviewSecondsB = measured(rev.rows[0].avg, rev.rows[0].n,
      'mean recorded review duration. One population, not split by tier yet');
    out.reviewSecondsC = measured(rev.rows[0].avg * 8, rev.rows[0].n,
      'scaled from the design doc ratio (30 s assisted vs 240 s full grading) '
      + 'because no Tier C reviews have been recorded separately');
  } else {
    out.reviewSecondsB = assumed(30, 'the PS target for an AI-assisted read');
    out.reviewSecondsC = assumed(240, 'design doc §7: full manual grading');
  }

  // ── Arrivals ─────────────────────────────────────────────────────────────
  out.annualPatients = assumed(100000, 'the district scale named in the problem statement');
  out.numPhcs = assumed(10, 'design doc §7');
  out.numOphthalmologists = assumed(2, 'design doc §7');
  out.workingDaysPerYear = assumed(250, 'design doc §7');
  out.workingHoursPerDay = assumed(8, 'design doc §7');
  out.imageSizeMB = assumed(4, 'a full-resolution fundus capture');
  out.bandwidthMbps = assumed([0.5, 1, 2, 5], 'rural link tiers, design doc §8.1');

  const outPath = path.resolve(arg('--out',
    path.join(ROOT, 'simulink-model', 'calibration.json')));
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  const m = Object.values(out).filter((v) => v && v.source === 'measured').length;
  const a = Object.values(out).filter((v) => v && v.source === 'assumed').length;
  console.log(`wrote ${outPath}`);
  console.log(`${m} measured, ${a} assumed — every field says which it is`);
  for (const [k, v] of Object.entries(out)) {
    if (v && v.source) {
      const val = Array.isArray(v.value) ? `[${v.value.map((x) => (+x).toFixed(3))}]`
        : (typeof v.value === 'number' ? (+v.value).toFixed(4) : String(v.value));
      console.log(`  ${v.source === 'measured' ? 'M' : 'a'}  ${k.padEnd(22)} ${val}`
        + (v.n ? `  (n=${v.n})` : ''));
    }
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
