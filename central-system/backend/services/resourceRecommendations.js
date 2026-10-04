'use strict';



const path = require('path');
const { execFile } = require('child_process');

const pool = require('../db/pgClient');
const { fromMatlabDeep } = require('./matlabInterop');

const SIMULINK_DIR = path.resolve(__dirname, '..', '..', '..', 'simulink-model');
const INFERENCE_DIR = path.resolve(__dirname, '..', 'ml-pipeline', 'inference');
const MATLAB_EXE = process.env.MATLAB_EXECUTABLE || 'matlab';
const TIMEOUT_MS = Number(process.env.RESOURCE_MODEL_TIMEOUT_MS) || 10 * 60_000;
const CRON = process.env.RESOURCE_MODEL_CRON || '30 2 * * *';
const MIN_CASES_FOR_OBSERVED_MIX = 30;

let running = null;   // the in-flight run's promise, shared by concurrent callers
let task = null;

const toMatlabStr = (s) => String(s).replace(/\\/g, '/').replace(/'/g, "''");

/** Observed inputs from the database, plus a record of where each came from. */
async function gatherInputs() {
  const params = {};
  const source = {};

  const mix = (await pool.query(`
    SELECT conformal_tier AS tier, count(*)::int AS n
    FROM grading_results
    WHERE conformal_tier IS NOT NULL AND graded_at > now() - interval '90 days'
    GROUP BY conformal_tier
  `)).rows;
  const counts = { A: 0, B: 0, C: 0 };
  for (const r of mix) counts[r.tier] = r.n;
  const total = counts.A + counts.B + counts.C;
  if (total >= MIN_CASES_FOR_OBSERVED_MIX) {
    params.tierFractions = [counts.A / total, counts.B / total, counts.C / total];
    source.tierFractions = `observed: ${total} graded cases, last 90 days`;
  } else {
    source.tierFractions = `default: only ${total} graded cases in 90 days ` +
      `(< ${MIN_CASES_FOR_OBSERVED_MIX} needed for an observed mix)`;
  }

  const phcs = (await pool.query('SELECT count(*)::int AS n FROM phc_sites')).rows[0].n;
  if (phcs > 0) { params.numPhcs = phcs; source.numPhcs = `observed: ${phcs} PHC sites`; }
  else source.numPhcs = 'default: no PHC sites registered';

  const ophth = (await pool.query(
    "SELECT count(*)::int AS n FROM users WHERE role = 'ophthalmologist'")).rows[0].n;
  if (ophth > 0) {
    params.numOphthalmologists = ophth;
    source.numOphthalmologists = `observed: ${ophth} ophthalmologist account(s)`;
  } else source.numOphthalmologists = 'default: no ophthalmologist accounts';

  // Volume scales with the number of PHCs -- the model's own convention in its
  // scenario table (100,000/year is the 10-PHC district). Without this, a
  // 1-PHC pilot database would push the whole district's volume through one
  // site's uplink and report an upload crisis that does not exist.
  const annual = Number(process.env.RESOURCE_MODEL_ANNUAL_PATIENTS);
  if (Number.isFinite(annual) && annual > 0) {
    params.annualPatients = annual;
    source.annualPatients = 'configured: RESOURCE_MODEL_ANNUAL_PATIENTS';
  } else if (params.numPhcs) {
    params.annualPatients = Math.round(100000 * params.numPhcs / 10);
    source.annualPatients = `default: 100,000/year per 10 PHCs, scaled to ${params.numPhcs} ` +
      '(set RESOURCE_MODEL_ANNUAL_PATIENTS for a real district figure)';
  } else {
    source.annualPatients = 'default: 100,000/year (the PS district-scale figure, 10 PHCs)';
  }

  source.other = 'model defaults (bandwidth tiers, review times, image size) — assumptions, not measurements';
  return { params, source };
}

/** MATLAB struct literal for the observed params. */
function paramsLiteral(params) {
  const parts = Object.entries(params).map(([k, v]) =>
    `'${k}', ${Array.isArray(v) ? `[${v.join(' ')}]` : v}`);
  return parts.length ? `struct(${parts.join(', ')})` : 'struct()';
}

/** Test seam: how MATLAB is invoked. Resolves the parsed JSON. */
let runModel = (params) => new Promise((resolve, reject) => {
  // jsonencodeAscii: the recommendation text contains em dashes, which Windows
  // stdout drops (see ml-pipeline/inference/jsonencodeAscii.m).
  const expr = `addpath('${toMatlabStr(SIMULINK_DIR)}'); ` +
    `addpath('${toMatlabStr(INFERENCE_DIR)}'); ` +
    `r = referenceQueueingModel('recommend', ${paramsLiteral(params)}); ` +
    'disp(jsonencodeAscii(r));';
  execFile(MATLAB_EXE, ['-batch', expr],
    { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => {
      if (err) return reject(new Error(`resource model failed: ${err.message} ${stderr || ''}`.trim()));
      const i = stdout.indexOf('{');
      if (i === -1) return reject(new Error(`resource model printed no JSON: ${stdout.slice(0, 300)}`));
      try { resolve(fromMatlabDeep(JSON.parse(stdout.slice(i)))); }
      catch (e) { reject(new Error(`resource model JSON parse failed: ${e.message}`)); }
    });
});

async function doRun() {
  const { params, source } = await gatherInputs();
  const r = await runModel(params);
  const { rows } = await pool.query(`
    INSERT INTO resource_recommendations
      (min_ophthalmologists_routine, min_ophthalmologists_camp, max_searched,
       p95_target_min, bottleneck, recommendation, current_state, params,
       inputs_source, model, run_seconds)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `, [r.minOphthalmologistsRoutine ?? null, r.minOphthalmologistsCamp ?? null,
  r.maxSearched ?? null, r.p95TargetMin ?? null, r.bottleneck, r.recommendation,
  r.current ?? null, r.params, source, r.model || 'referenceQueueingModel',
  r.runSeconds ?? null]);
  console.log(`[resourceModel] refreshed: routine ${r.minOphthalmologistsRoutine ?? '>max'}, ` +
    `camp ${r.minOphthalmologistsCamp ?? '>max'}, bottleneck "${r.bottleneck}"`);
  return toResponse(rows[0]);
}

/** Run now (or join the run already in flight). */
function refresh() {
  if (!running) {
    running = doRun().finally(() => { running = null; });
  }
  return running;
}

function toResponse(row) {
  return {
    generatedAt: row.generated_at.toISOString(),
    minOphthalmologistsRoutine: row.min_ophthalmologists_routine,
    minOphthalmologistsCamp: row.min_ophthalmologists_camp,
    maxSearched: row.max_searched,
    p95TargetMin: row.p95_target_min,
    bottleneck: row.bottleneck,
    recommendation: row.recommendation,
    current: row.current_state,
    params: row.params,
    inputsSource: row.inputs_source,
    model: row.model,
    runSeconds: row.run_seconds,
  };
}

async function latest() {
  const { rows } = await pool.query(
    'SELECT * FROM resource_recommendations ORDER BY generated_at DESC LIMIT 1');
  return rows.length ? toResponse(rows[0]) : null;
}

/** Daily schedule. Main-block only (server.js), like the other background jobs. */
function start() {
  if (task) return;
  const cron = require('node-cron');
  if (!cron.validate(CRON)) {
    // A typo in RESOURCE_MODEL_CRON used to throw out of here and stop the
    // whole backend from starting. Losing the daily resource estimate is not
    // worth refusing to grade cases.
    console.error(`[resourceModel] RESOURCE_MODEL_CRON is not a valid cron expression ` +
      `("${CRON}"); the daily run is disabled. POST /admin/resource-recommendations/` +
      `refresh still works.`);
    return;
  }
  task = cron.schedule(CRON, () => {
    refresh().catch((err) => console.error(`[resourceModel] scheduled run failed: ${err.message}`));
  });
}

function stop() { if (task) { task.stop(); task = null; } }

function _setRunner(fn) { const prev = runModel; runModel = fn; return prev; }

module.exports = { refresh, latest, start, stop, gatherInputs, _setRunner, CRON };
