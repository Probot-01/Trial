'use strict';



const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { raiseAlert, resolveAlert } = require('./systemAlerts');

const SIMULINK_DIR = path.resolve(__dirname, '..', '..', '..', 'simulink-model');
const INFERENCE_DIR = path.resolve(__dirname, '..', 'ml-pipeline', 'inference');
const OUT_DIR = path.join(SIMULINK_DIR, 'out');
const RESULT_PATH = process.env.SIMULINK_VALIDATION_PATH
  || path.join(OUT_DIR, 'last-validation.json');

const MATLAB_EXE = process.env.MATLAB_EXECUTABLE || 'matlab';
const TIMEOUT_MS = Number(process.env.SIMULINK_VALIDATION_TIMEOUT_MS) || 20 * 60_000;
const CRON = process.env.SIMULINK_VALIDATION_CRON || '0 3 * * 0';
const ALERT_KIND = 'simulink_model_diverged';

let running = null;   // the in-flight run, shared by concurrent callers
let task = null;

const toMatlabStr = (s) => String(s).replace(/\\/g, '/').replace(/'/g, "''");

function enabled() {
  const flag = process.env.SIMULINK_VALIDATION_ENABLED;
  return !(flag !== undefined && flag !== '' && /^(0|false|no|off)$/i.test(flag.trim()));
}

/** Test seam: how MATLAB is invoked. Resolves the parsed result struct. */
let runModel = () => new Promise((resolve, reject) => {
  // jsonencodeAscii, not jsonencode: Windows stdout is the ANSI code page and
  // drops the em dashes MATLAB text is full of.
  const expr = `addpath('${toMatlabStr(SIMULINK_DIR)}'); `
    + `addpath('${toMatlabStr(INFERENCE_DIR)}'); `
    + 'r = runDistrictScreeningModel(); disp(jsonencodeAscii(r));';
  execFile(MATLAB_EXE, ['-batch', expr],
    { cwd: SIMULINK_DIR, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(
          `SimEvents validation failed: ${err.message} ${stderr || ''}`.trim().slice(0, 600)));
      }
      // The function prints a human report first; the JSON is the first brace.
      const i = stdout.indexOf('{');
      if (i === -1) {
        return reject(new Error(`SimEvents validation printed no JSON: ${stdout.slice(0, 300)}`));
      }
      try { resolve(JSON.parse(stdout.slice(i))); }
      catch (e) { reject(new Error(`SimEvents validation JSON parse failed: ${e.message}`)); }
    });
});

function readResult() {
  try { return JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8')); } catch { return null; }
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  const tmp = `${RESULT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, RESULT_PATH);   // a reader never sees a half-written file
}

async function doRun() {
  const startedAt = new Date();
  let result;
  try {
    const r = await runModel();
    const checks = Array.isArray(r.checks) ? r.checks : [r.checks].filter(Boolean);
    result = {
      ranAt: r.ranAt || startedAt.toISOString(),
      status: r.agree ? 'agree' : 'diverged',
      checks,
      simEvents: {
        tierAAutoCleared: r.tierAAutoCleared,
        reviewed: r.reviewed,
        uploadUtilisation: r.uploadUtilisation,
        reviewerUtilisation: r.reviewerUtilisation,
        reviewWaitMeanSec: r.reviewWaitMeanSec,
      },
      reference: r.reference,
      params: r.params,
      simSeconds: r.simSeconds,

      note: 'All parameters are modelled assumptions, not measured field data.',
    };
  } catch (err) {

    result = {
      ranAt: startedAt.toISOString(),
      status: 'error',
      error: err.message,
      checks: [],
    };
  }
  writeResult(result);

  if (result.status === 'agree') {
    console.log('[simulinkValidation] SimEvents and the reference model still agree.');
    await resolveAlert(ALERT_KIND);
  } else if (result.status === 'diverged') {
    const failed = result.checks.filter((c) => !c.agree)
      .map((c) => `${c.metric}: SimEvents ${Number(c.simEvents).toFixed(1)}${c.unit} vs `
        + `reference ${Number(c.reference).toFixed(1)}${c.unit} (tolerance ${c.tolerance})`)
      .join('; ');
    const message = 'The SimEvents model and the reference queueing model no longer agree. '
      + 'The resource recommendations on the dashboard come from the reference model, and '
      + `its validation is what this checks. ${failed}`;
    console.error(`[simulinkValidation] DIVERGED -- ${failed}`);
    await raiseAlert(ALERT_KIND, '', message);
  } else {
    console.error(`[simulinkValidation] could not run: ${result.error}`);
    await raiseAlert(ALERT_KIND, '', `The weekly SimEvents validation could not run, so the `
      + `resource model is currently unvalidated: ${result.error}`);
  }
  return result;
}

/** Run now, or join the run already in flight. */
function refresh() {
  if (!running) running = doRun().finally(() => { running = null; });
  return running;
}

/** The last recorded result, or null if it has never run on this machine. */
function latest() {
  return readResult();
}

function start() {
  if (task || !enabled()) {
    if (!enabled()) console.log('[simulinkValidation] disabled (SIMULINK_VALIDATION_ENABLED).');
    return;
  }
  const cron = require('node-cron');
  if (!cron.validate(CRON)) {
    // Same rule as the resource model's: a bad cron string is a configuration
    // mistake, not a reason the backend should refuse to start.
    console.error(`[simulinkValidation] SIMULINK_VALIDATION_CRON "${CRON}" is not a valid `
      + 'cron expression -- the weekly validation is NOT scheduled.');
    return;
  }
  task = cron.schedule(CRON, () => { refresh().catch(() => { }); });
  console.log(`[simulinkValidation] weekly SimEvents validation scheduled (${CRON}).`);
}

function stop() {
  if (task) { task.stop(); task = null; }
}

module.exports = {
  start, stop, refresh, latest, enabled,
  RESULT_PATH, ALERT_KIND, CRON,
  _setRunner: (fn) => { const prev = runModel; runModel = fn; return prev; },
};
