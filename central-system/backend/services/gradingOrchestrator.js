'use strict';

/**
 * gradingOrchestrator.js
 *
 * Chains the full Phase 2 ML pipeline for one case and persists the results.
 *
 * Call: await processCase(caseId)
 *
 * Pipeline (two round-trips, since 2026-09-09):
 *   PYTHON  ben_graham → EfficientNet-B0 → temperature → conformal tier
 *           → Grad-CAM (same spawn)
 *   MATLAB  readFundusImage → preprocessForBranchA (camera cross-check)
 *           → generateEvidenceReport
 *
 * Branch A moved to Python because MATLAB's official PyTorch converter
 * (importNetworkFromPyTorch) imported the network and computed the wrong
 * numbers — 8-11% agreement with the model's own published logits,
 * correlation -0.25, while Python reproduces them exactly. See
 * ml-pipeline/testImportedNetwork.m, which re-runs that check in one command.
 *
 * CORRECTION (2026-09-18): that finding does not generalize to every MATLAB
 * import path. models/branchA_v1.mat was produced via a DIFFERENT converter
 * (torch.onnx.export -> importNetworkFromONNX) and independently verified
 * against the same PyTorch checkpoint on 10 real images at max|diff| ~2e-6
 * post-softmax (training/parityCheck.m). An INFERENCE_BACKEND=matlab path now
 * exists as an alternative to the Python one below (see
 * runBranchAInferenceMatlab / branchAInferMatlab.m); INFERENCE_BACKEND
 * defaults to 'python' unless documented otherwise elsewhere. Both paths are
 * kept — this is a backend switch, not a replacement.
 *
 * DB writes:
 *   grading_results        — CNN grade, referable flag, calibrated confidence,
 *                            conformal tier (temporary placeholder rule),
 *                            model version.
 *   explainability_outputs — Grad-CAM PNG path.
 *   cases.status           — updated to 'graded'.
 *
 * NULL columns left for later phases:
 *   grading_results.dr_grade_rule_engine  — Phase 4
 *   grading_results.branch_agreement      — Phase 5
 *   grading_results.uncertainty_score     — Phase 6
 *
 * Conformal tier rule (TEMPORARY — replaced by real conformal calibration
 * in Task 6.2):
 *   confidence > 0.9  → 'A'   (auto-grade safe)
 *   0.6 ≤ conf ≤ 0.9 → 'B'   (review recommended)
 *   confidence < 0.6  → 'C'   (urgent review)
 *
 * MATLAB bridge: same child_process + matlab -batch approach as Task 1.6
 * (qualityGateClient.js). No official MATLAB Engine API for Node.js exists.
 * MATLAB_EXECUTABLE env var overrides the 'matlab' PATH lookup.
 * Task 8.1 (post-checkpoint) replaces this with a compiled standalone binary.
 */

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const pool       = require('../db/pgClient');
const mediaPaths = require('./mediaPaths');
const mediaCrypto = require('./mediaCrypto');
const { fromMatlab, fromMatlabDeep } = require('./matlabInterop');
const matlabFallback = require('./matlabFallback');
const matlabSession  = require('./matlabSessionClient');
const segSession     = require('./segSessionClient');
const { cameraNotValidated: isCameraNotValidated } = require('./validatedCameras');
const { engineEntry, normaliseEngineEntry } = require('./engineProvenance');

// Task: MATLAB workaround for a dev machine with no MATLAB install (no
// license, no disk space). When true, MATLAB genuinely failing to SPAWN
// (ENOENT — the interpreter is not on this machine) falls back to
// matlabFallback.js's JS port of the rule engine / branch-agreement /
// evidence-report logic instead of failing the whole case to 'error'. Branch A
// (the CNN grade, Python) and Phase 4 segmentation (also Python) are
// completely unaffected either way — only the MATLAB-only stages (Branch B's
// grading call site, the camera cross-check, lesion-attention consistency)
// are substituted.
//
// OFF by default (2026-09-26): a missing MATLAB fails the case loudly. Opt in
// with MATLAB_ALLOW_FALLBACK=1, and only on a machine that genuinely has no
// MATLAB -- standing rule: no silent engine fallback.
const ALLOW_MATLAB_FALLBACK = process.env.MATLAB_ALLOW_FALLBACK === '1';

// ── Path constants ────────────────────────────────────────────────────────────
const ML_ROOT          = path.resolve(__dirname, '..', 'ml-pipeline');
const PREPROCESSING_DIR = path.join(ML_ROOT, 'preprocessing');
const GRADING_DIR       = path.join(ML_ROOT, 'grading');
const CALIBRATION_DIR   = path.join(ML_ROOT, 'calibration');
const EXPLAINABILITY_DIR= path.join(ML_ROOT, 'explainability');
// Task 6.3. preprocessForBranchA calls classifyCameraFamily and
// applyCalibrationProfile, which live here — without this on the path the
// whole pipeline dies at preprocessing with 'Unrecognized function'.
const CAMERA_CAL_DIR    = path.join(ML_ROOT, 'cameraCalibration');
// Task 7.3. generateEvidenceReport needs fundusQuadrants, which lives here.
const SEGMENTATION_DIR  = path.join(ML_ROOT, 'segmentation');
const MODELS_DIR        = path.join(ML_ROOT, 'models');

// LAST-RESORT fallback only. The version that actually graded a case comes
// from the inference result itself (branchA.modelVersion) -- see the write to
// grading_results.model_version.
//
// This used to BE the stored value, hardcoded, while branchA.modelVersion was
// never read. Every row in grading_results therefore said 'branchA_v1'
// regardless of what ran, and the day the default moved to branchA_v2c that
// column became silently, uniformly wrong -- the one field whose whole job is
// to say which model produced a grade.
const MODEL_VERSION_FALLBACK = 'unknown';
const MATLAB_EXE        = process.env.MATLAB_EXECUTABLE || 'matlab';
const TIMEOUT_MS        = parseInt(process.env.MATLAB_TIMEOUT_MS || '120000', 10);

// Grad-CAM output location comes from mediaPaths, NOT a local constant. It has
// to land under backend/media so the URL api-contracts.md returns
// (/media/cases/<id>/gradcam.png) actually resolves — this previously wrote to
// backend/explainability-outputs/, which is outside the static root, so the
// stored path was correct and the file was really there and the frontend could
// still never have loaded it.

/**
 * unavailable(code, message)
 *
 * An error tagged so gradingQueue can classify it as PERMANENT.
 *
 * "The interpreter could not be spawned" is not a transient failure. Retrying
 * in two seconds cannot make a missing executable exist, and the retry is not
 * free: since the Python stages run BEFORE MATLAB (the rule engine needs their
 * output), a MATLAB spawn failure previously cost a full Branch A run plus four
 * segmentation models on each of three attempts — roughly 35 s of model
 * inference to reach a conclusion available in milliseconds.
 *
 * Only SPAWN failures are permanent. A non-zero exit stays retryable: that can
 * be a licence-server hiccup or a locked file, which a retry genuinely fixes.
 */
function unavailable(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ── MATLAB bridge (shared with qualityGateClient pattern) ─────────────────────
function spawnMatlabBatch(expr) {
  return new Promise((resolve, reject) => {
    const proc = spawn(MATLAB_EXE, ['-batch', expr], {
      env: process.env,
      timeout: TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(
        `matlab -batch exited ${code}.\nstderr: ${stderr.trim()}`));
      resolve(stdout.trim());
    });
    proc.on('error', (err) => reject(unavailable('matlab_unavailable',
      `Failed to spawn MATLAB (set MATLAB_EXECUTABLE?): ${err.message}`)));
  });
}

const PYTHON_EXE = process.env.PYTHON_EXECUTABLE || 'python';
const BRANCH_A_INFER = path.join(ML_ROOT, 'inference', 'branchAInfer.py');
const SEG_INFER      = path.join(ML_ROOT, 'inference', 'segInfer.py');

// ── Branch A backend switch ─────────────────────────────────────────────────
// 'matlab' (DEFAULT as of 2026-09-19): branchAInferMatlab.m against the
//          persistent MATLAB session (ml-pipeline/inference/matlabSession/ --
//          REQUIRED to be running; there is no per-call cold-start fallback,
//          see callMatlabSession below). Flipped from 'python' only once both
//          gating conditions were met and measured, not assumed:
//            - correctness: 10/10 grade AND 10/10 conformal-tier agreement
//              with the python backend on 10 real IDRiD images, after
//              preprocessModel1.m's MATLAB port (SSIM 0.981) was removed in
//              favor of both backends calling the one Python preprocessing
//              function (branchAInfer.preprocess()) -- see
//              branchAInferMatlab.m's header and ml-pipeline/experiments/
//              compareInferenceBackends.js.
//            - latency: mean 3.3s/image against the persistent session vs
//              python's 6.3s (ml-pipeline/experiments/measureInferenceLatency.js)
//              -- matlab is now the FASTER backend, not merely acceptable.
// 'python': branchAInfer.py, the original path. Kept, not deleted -- set
//           INFERENCE_BACKEND=python to fall back to it (e.g. if the
//           persistent session is down and restarting it isn't an option
//           right now).
// Segmentation (segInfer.py) is UNCHANGED either way -- this switch is
// Branch A/classifier only.
const INFERENCE_BACKEND = (process.env.INFERENCE_BACKEND || 'matlab').toLowerCase();
if (!['python', 'matlab'].includes(INFERENCE_BACKEND)) {
  throw new Error(`INFERENCE_BACKEND must be 'python' or 'matlab', got '${INFERENCE_BACKEND}'`);
}
const PREPROCESS_TENSOR = path.join(ML_ROOT, 'inference', 'preprocessBranchATensor.py');
// branchAInferMatlab.m itself is no longer addpath'd/invoked per call from
// here -- the persistent session (matlabSession/runMatlabInferenceSession.m)
// addpaths and calls it once, at its own startup. See callMatlabSession below.

/**
 * runBranchAInference(imagePath)
 *
 * Grades one image with the real Branch A model. Returns the parsed JSON.
 *
 * Arguments cross as argv, not interpolated into a command string, so a
 * capture path containing a quote is inert rather than executable — the same
 * property the compiled quality gate gained in Task 8.1.
 */
function runBranchAInference(imagePath, gradcamPath) {
  return new Promise((resolve, reject) => {
    const args = [BRANCH_A_INFER, imagePath];
    if (gradcamPath) args.push('--gradcam', gradcamPath);
    const proc = spawn(PYTHON_EXE, args, {
      env: process.env,
      timeout: TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        // branchAInfer.py documents its codes: 2 = bad arguments, 3 = inference
        // failed. Surfacing the number separates a deployment mistake from an
        // unreadable image.
        return reject(new Error(
          `Branch A inference exited ${code}.\nstderr: ${stderr.trim()}`));
      }
      const start = stdout.indexOf('{');
      if (start === -1) {
        return reject(new Error(`Branch A returned no JSON.\nstdout: ${stdout.slice(0, 300)}`));
      }
      try {
        resolve(JSON.parse(stdout.slice(start)));
      } catch (err) {
        reject(new Error(`Branch A JSON parse failed: ${err.message}`));
      }
    });

    proc.on('error', (err) => reject(unavailable('python_unavailable',
      `Failed to spawn Python (set PYTHON_EXECUTABLE?): ${err.message}`)));
  });
}

/**
 * preprocessBranchATensor(imagePath)
 *
 * Runs the ONE shared preprocessing step (branchAInfer.preprocess(), via
 * preprocessBranchATensor.py) and returns the path to the .mat tensor it
 * wrote. Both Branch A backends need this to see identical input; the
 * python backend does it in-process inside branchAInfer.py, the matlab
 * backend needs it as a separate step first since MATLAB no longer carries
 * its own preprocessing (see branchAInferMatlab.m's header for why that
 * port was removed rather than fixed).
 *
 * Caller owns cleanup of the returned path (see runBranchAInferenceMatlab).
 */
function preprocessBranchATensor(imagePath) {
  return new Promise((resolve, reject) => {
    const tensorPath = path.join(
      os.tmpdir(), `branchA_tensor_${Date.now()}_${Math.random().toString(36).slice(2)}.mat`);
    const proc = spawn(PYTHON_EXE, [PREPROCESS_TENSOR, imagePath, tensorPath], {
      env: process.env,
      timeout: TIMEOUT_MS,
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(
          `Branch A tensor preprocessing exited ${code}.\nstderr: ${stderr.trim()}`));
      }
      resolve(tensorPath);
    });
    proc.on('error', (err) => reject(unavailable('python_unavailable',
      `Failed to spawn Python for Branch A preprocessing (set PYTHON_EXECUTABLE?): ${err.message}`)));
  });
}

// ── Persistent MATLAB session (Part 2 of the MATLAB-backend latency fix) ───
// ml-pipeline/inference/matlabSession/{README.md,runMatlabInferenceSession.m,
// manageMatlabSession.ps1}. `matlab -batch` cold-starts in ~24s mean (10-image
// measurement, ml-pipeline/experiments/measureInferenceLatency.js) -- 3.9x
// Python's ~6.2s, almost entirely interpreter/toolbox/ONNX-package startup,
// not the predict() call itself. Spawning a fresh MATLAB process per case
// pays that every time; this session pays it once at startup and serves
// requests over a request/response directory instead.
//
// This REPLACES the per-call `matlab -batch` spawn for Branch A -- there is
// no fallback to a fresh process if the session isn't running (see
// callMatlabSession's timeout below). That is deliberate: silently falling
// back would reintroduce the exact 24s-per-case cost this exists to remove,
// and do it quietly.
const MATLAB_SESSION_TIMEOUT_MS   = parseInt(process.env.MATLAB_SESSION_TIMEOUT_MS || '30000', 10);

/**
 * callMatlabSession(tensorPath, gradcamPath)
 *
 * The request/response file protocol itself lives in matlabSessionClient.js --
 * this adds only Branch A's payload shape and its error classification.
 */
async function callMatlabSession(tensorPath, gradcamPath) {
  let body;
  try {
    body = await matlabSession.call(
      { tensorPath, gradcamPath: gradcamPath || '' },
      { timeoutMs: MATLAB_SESSION_TIMEOUT_MS, prefix: 'branchA' });
  } catch (err) {
    if (err.code === 'matlab_session_timeout') {
      throw unavailable('matlab_session_unavailable', err.message);
    }
    throw new Error(`Branch A (MATLAB session) failed: ${err.message}`);
  }
  // §Q: normalised at the boundary -- see matlabInterop.js.
  return fromMatlabDeep(body);
}

/**
 * runBranchAInferenceMatlab(imagePath, gradcamPath)
 *
 * The MATLAB-backend twin of runBranchAInference: same inputs, same resolved
 * JSON shape, same reject-on-failure contract (a Branch A failure must fail
 * the case -- there is no grade without it) -- mirrored field-for-field so
 * processCase() below does not need to know which backend produced `branchA`.
 *
 * Two steps, not one spawn: preprocessBranchATensor() (a fresh Python
 * process, every call -- preprocessing was deliberately NOT made part of the
 * persistent session, see matlabSession/README.md's last section) writes the
 * tensor, then callMatlabSession() hands it to the already-running MATLAB
 * session and waits for the response file.
 */
async function runBranchAInferenceMatlab(imagePath, gradcamPath) {
  const tensorPath = await preprocessBranchATensor(imagePath);
  try {
    return await callMatlabSession(tensorPath, gradcamPath);
  } finally {
    fs.unlink(tensorPath, () => {});   // best-effort; a leaked temp file is not worth failing the case over
  }
}

/**
 * runSegInference(imagePath, outdir)
 *
 * Phase 4: vessels, optic disc/fovea, and both lesion models (M2-M5), in one
 * Python process. Returns the parsed JSON, or NULL on any failure.
 *
 * NULL, NOT A THROW. Branch B is the SECOND opinion. If segmentation fails, the
 * right outcome is a case graded by Branch A alone with branch_agreement NULL —
 * which the schema, the API contract and the tier logic all already handle,
 * because that has been the normal state for the whole project so far. Throwing
 * would fail a case that the classifier graded perfectly well, turning a
 * degraded result into a lost one.
 *
 * The distinction that must not blur: NULL means "Branch B did not run", and
 * FALSE means "Branch B ran and disagreed". Only the second forces Tier C.
 *
 * ONE EXCEPTION, which REJECTS: segInfer.py's exit code 4, "the MATLAB session
 * failed a forward pass and the PyTorch fallback is off". That is an engine
 * failure, not a missing second opinion -- degrading the case to classifier-
 * only would be the silent engine fallback the standing rules forbid. It
 * rejects with a retryable code, so the grading queue retries the case and,
 * if MATLAB stays down, marks it 'error' where System Health shows it.
 */
const SEG_EXIT_MATLAB_FAILED = 4;

function matlabSegmentationFailed(message) {
  return unavailable('matlab_segmentation_failed',
    `Segmentation's MATLAB engine failed and SEG_ALLOW_PYTHON_FALLBACK is off: ${message}`);
}

function runSegInference(imagePath, outdir) {
  return new Promise((resolve, reject) => {
    const args = [SEG_INFER, imagePath];
    if (outdir) args.push('--outdir', outdir);
    const proc = spawn(PYTHON_EXE, args, { env: process.env, timeout: TIMEOUT_MS });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === SEG_EXIT_MATLAB_FAILED) {
        return reject(matlabSegmentationFailed(stderr.trim().slice(0, 500)));
      }
      if (code !== 0) {
        console.warn(`[gradingOrchestrator] segmentation exited ${code}; `
          + `Branch B unavailable. stderr: ${stderr.trim().slice(0, 300)}`);
        return resolve(null);
      }
      const start = stdout.indexOf('{');
      if (start === -1) {
        console.warn('[gradingOrchestrator] segmentation returned no JSON; '
          + 'Branch B unavailable');
        return resolve(null);
      }
      try {
        resolve(JSON.parse(stdout.slice(start)));
      } catch (err) {
        console.warn(`[gradingOrchestrator] segmentation JSON parse failed: ${err.message}`);
        resolve(null);
      }
    });

    proc.on('error', (err) => {
      console.warn(`[gradingOrchestrator] failed to spawn segmentation: ${err.message}`);
      resolve(null);
    });
  });
}

// ── The persistent segmentation worker ──────────────────────────────────────
// Segmentation was the largest remaining cost in grading a case, and almost
// none of it was segmentation. Measured on this machine: the torch import plus
// the four model loads take 17.1 s, and the actual work takes 2.0 s. Spawning
// segInfer.py per case paid the 17 s every time.
//
// This is also the answer to backend plan §S.4's puzzle -- that serving M2-M4
// from the MATLAB session gave no speed-up at all (22.5 s vs 21.4 s over 20
// images). It moved forward passes that cost under a second each, and left the
// seventeen seconds of process start exactly where they were.
//
// The worker is preferred when it is up and the per-case spawn is the
// fallback, for the same reason the case pipeline works that way: the fallback
// is the behaviour that shipped before, it is logged, and the alternative is
// losing Branch B over a worker that happens to be restarting.
const SEG_SESSION_TIMEOUT_MS = parseInt(
  process.env.SEG_SESSION_TIMEOUT_MS || '120000', 10);

async function runSegInferenceSession(imagePath, outdir) {
  try {
    return await segSession.call({ image: imagePath, outdir: outdir || '' },
      { timeoutMs: SEG_SESSION_TIMEOUT_MS, prefix: 'seg' });
  } catch (err) {
    // The worker's MATLAB engine failed: not a reason to re-run the same
    // models in a fresh process (it would ask the same session again) and
    // never a reason to degrade silently -- see runSegInference.
    if (err.code === 'matlab_segmentation_failed') throw matlabSegmentationFailed(err.message);
    console.warn(`[gradingOrchestrator] the segmentation worker could not handle `
      + `this image (${err.message}); falling back to a fresh segInfer.py process, `
      + 'which costs this case about 17 s of model loading');
    return null;
  }
}

/**
 * segment(imagePath, outdir) -- Branch B's input, from whichever path is up.
 *
 * Resolves NULL on any failure of BOTH paths: see runSegInference's header for
 * why losing Branch B must degrade a case rather than fail it. The one thing
 * that throws is a MATLAB-engine failure (matlab_segmentation_failed), for the
 * reason given there.
 */
async function segment(imagePath, outdir) {
  if (segSession.alive()) {
    const viaWorker = await runSegInferenceSession(imagePath, outdir);
    if (viaWorker) return viaWorker;
  }
  return runSegInference(imagePath, outdir);
}

// The six quality sub-scores isCaptureUngradable() knows about. Named here
// rather than inline so the list stays in one place; it mirrors the PHC quality
// gate's own fields (qualityGateMain.m).
const SCORE_FIELDS = ['focusScore', 'illuminationScore', 'fovScore',
                      'coveragePercent', 'glareScore', 'motionScore',
                      'occlusionScore'];

// ── Path escaping for MATLAB string literals ───────────────────────────────────
function toMatlabStr(p) {
  return p.replace(/\\/g, '/').replace(/'/g, "''");
}

// ── Conformal tier (temporary placeholder — Task 6.2 replaces this) ───────────
/**
 * assignTier(confidence, branchAgreement)
 *
 * @param {number} confidence      calibrated max probability
 * @param {boolean|null} branchAgreement  true, false, or null when Branch B
 *        has not run. NULL IS NOT FALSE — see below.
 *
 * BRANCH DISAGREEMENT OVERRIDES CONFIDENCE ENTIRELY (Task 5.2, design doc
 * §1.11). When the CNN and the rule engine reach different grades, the case
 * goes to full manual review no matter how confident either branch was — a
 * confident disagreement is MORE alarming than an unconfident one, not less,
 * because it means two independent methods are both sure and incompatible.
 *
 * null means Branch B has not run yet, which today is the normal case: the rule
 * engine needs lesion counts from Phase 4 segmentation. Treating null as
 * disagreement would force every case to Tier C and drown the review queue in
 * cases nothing has actually flagged.
 */
function assignTier(confidence, branchAgreement) {
  if (branchAgreement === false) return 'C';
  if (confidence > 0.9)  return 'A';
  if (confidence >= 0.6) return 'B';
  return 'C';
}

/**
 * decideTier(input) -> { tier, tierReason }
 *
 * The whole tier decision as one pure function: the escalation chain, then
 * the floors. Extracted from processCase because it could not be tested in
 * place -- exercising a Tier A -> B floor needs a case that is high
 * confidence AND has agreeing branches AND carries a flag, and no image in
 * the corpus happens to be all three at once. Grading a real flagged image
 * proved the flag reaches the database; only this proves the floor itself
 * does anything.
 *
 * TWO RULES, and the order matters:
 *   1. ESCALATION picks the tier, worst-first, first match wins.
 *   2. FLOORS may only raise A -> B. They never lower a B or a C -- these
 *      used to sit inside the chain as `tier = 'B'`, so a probation-camera
 *      case the conformal set had put in C came out as B and the "floor"
 *      was cutting the review requirement.
 */
function decideTier(input) {
  const {
    branchAgreement, beyondRuleEngine, qualityForced, ruleMaxGrade, grade,
    conformalTier, conformalReason, confidenceScore,
    cameraProbationOverride, lateralityMismatch, foveaUnreliable,
    cameraNotValidated,
  } = input;

  let tier;
  let tierReason;
  if (branchAgreement === false) {
    tier = 'C';
    tierReason = 'branches disagree';
  } else if (beyondRuleEngine) {
    tier = 'C';
    tierReason = `CNN grade ${grade} is above the rule engine's ceiling `
      + `(${ruleMaxGrade}); no second opinion is possible`;
  } else if (qualityForced) {
    tier = 'C';
    tierReason = 'capture quality is below the local retake threshold '
      + '(qualityGateMain.m-equivalent hard failure) — no shortcut on an '
      + 'image the quality gate itself would have rejected';
  } else if (conformalTier) {
    tier = conformalTier;
    tierReason = conformalReason || 'conformal prediction set';
  } else {
    tier = assignTier(confidenceScore, branchAgreement);
    tierReason = 'uncalibrated fallback thresholds';
  }

  // ── Floors: can only raise A -> B, never lower a B or C ──────────────────
  // Applied to the tier the conformal set (or fallback) produced. These used
  // to sit INSIDE the chain above as `tier = 'B'`, which meant a probation-
  // camera case the conformal set had put in Tier C came out as B -- the
  // "floor" was lowering it. A floor is a minimum; it is applied as one now.
  if (tier === 'A' && cameraProbationOverride) {
    tier = 'B';
    tierReason = `camera family mismatch on a camera/site with fewer than `
      + `${CAMERA_PROBATION_MIN_CASES} prior graded cases — not yet enough `
      + 'of a track record to auto-clear';
  }
  // §I: the quadrants were keyed to an axis drawn through a fovea the gate
  // flagged as untrustworthy (segInfer does not fall back to the image axes),
  // and the rule engine skipped its quadrant criteria -- not a basis for
  // auto-clearing.
  if (tier === 'A' && lateralityMismatch) {
    tier = 'B';
    tierReason = 'the image file and the technician disagree on which eye this is — '
      + 'not auto-cleared until a human confirms the laterality';
  }
  if (tier === 'A' && foveaUnreliable === true) {
    tier = 'B';
    tierReason = 'fovea could not be located reliably, so lesion quadrants and '
      + 'the quadrant-based severe-NPDR criteria are unreliable — not auto-cleared';
  }
  // ── unvalidated_camera ──────────────────────────────────────────────────
  // Distinct from cameraProbationOverride above, which needs a reported-vs-
  // detected family MISMATCH before it fires. The case this catches has no
  // mismatch at all: an unfamiliar camera that reports itself honestly and
  // produces a perfectly normal-looking image, on which referable sensitivity
  // measured 75.2% instead of 95.0% (Messidor-2, ML Layer Final Report §3).
  // Nothing in the image announces that, so no image-derived signal can catch
  // it -- only knowing whether anyone validated this camera here.
  //
  // Last of the floors because it is the broadest: it should not supply the
  // reason on a case that has a more specific one to give.
  if (tier === 'A' && cameraNotValidated === true) {
    tier = 'B';
    tierReason = 'unvalidated_camera: this camera/site has not been validated '
      + 'against known-correct grades, and referable sensitivity is measurably '
      + 'lower on unfamiliar cameras — not auto-cleared';
  }
  return { tier, tierReason };
}

// ── Quality-forced override (design doc §6.8's "force-flagged poor-but-not-
// unusable capture" -> Tier C) ──────────────────────────────────────────────
/**
 * isCaptureUngradable(qualityScores)
 *
 * quality_scores was already being loaded and forwarded to MATLAB for
 * adaptiveEnhance's preprocessing (Task 2.8) but never converted to a
 * boolean or checked anywhere in the tier decision -- a case whose own
 * quality gate would have told the technician to retake the photo could
 * still sail through to Tier A on a confident-looking probability.
 *
 * Thresholds are NOT invented here: they are the same hard-failure branches
 * phc-local-app/backend/quality-gate-matlab/qualityGateMain.m already uses
 * to decide LOCAL 'retake' (that file's Step 4), using the one preset that
 * exists today (cameraPresets.json's 'default': focusThreshold 0.17,
 * illuminationThreshold 0.4 -- no per-camera overrides are defined yet, so
 * mirroring 'default' here is not an approximation of anything more precise).
 * The local gate's softer 'borderline' composite-score branch is
 * deliberately NOT reproduced -- borderline images are already handled by
 * adaptiveEnhance and are not what this override exists to catch.
 *
 * A case reaching here with a hard local-retake-equivalent score means one
 * of: the technician forced the capture through despite a warning, the local
 * gate was bypassed, or scores were computed but not acted on locally. Any of
 * those is exactly the "poor-but-not-unusable capture" the design doc's Tier
 * C row names -- no statistical guarantee about the classifier addresses it.
 *
 * Returns false (not ungradable) when quality_scores is null/absent --
 * captures from before this column existed, or synced without scores, fall
 * back to "no signal", not "forced C". SCORE_FIELDS above names the same six
 * sub-scores.
 */
const QUALITY_RETAKE_THRESHOLDS = {
  minCoveragePercent:    0.5,   // qualityGateMain.m: fov.coveragePercent < 0.5
  maxGlareScore:         0.3,   // qualityGateMain.m: glareScore > 0.3
  maxMotionScore:        0.3,   // qualityGateMain.m: motionScore > 0.3
  illuminationThreshold: 0.4,   // cameraPresets.json 'default'.illuminationThreshold
  focusThreshold:        0.17,  // cameraPresets.json 'default'.focusThreshold
  maxOcclusionScore:     0.18,  // qualityGateMain.m: occlusionScore > 0.18
};

function isCaptureUngradable(qualityScores) {
  if (!qualityScores || typeof qualityScores !== 'object') return false;
  const t = QUALITY_RETAKE_THRESHOLDS;
  const finite = (v) => Number.isFinite(Number(v));
  const num = (v) => Number(v);

  if (finite(qualityScores.coveragePercent) && num(qualityScores.coveragePercent) < t.minCoveragePercent) return true;
  if (finite(qualityScores.glareScore) && num(qualityScores.glareScore) > t.maxGlareScore) return true;
  if (finite(qualityScores.motionScore) && num(qualityScores.motionScore) > t.maxMotionScore) return true;
  if (finite(qualityScores.illuminationScore) && num(qualityScores.illuminationScore) < t.illuminationThreshold) return true;
  if (finite(qualityScores.focusScore) && num(qualityScores.focusScore) < t.focusThreshold) return true;
  if (finite(qualityScores.occlusionScore) && num(qualityScores.occlusionScore) > t.maxOcclusionScore) return true;
  return false;
}

// ── Camera/site probation override (design doc §6.8's implicit "unfamiliar
// capture source" case; no case-count threshold is specified anywhere in the
// docs, so CAMERA_PROBATION_MIN_CASES below is a stated, tunable default, not
// a derived number) ──────────────────────────────────────────────────────────
/**
 * hasClearedCameraSiteProbation(phcId, cameraDeviceId, excludeCaseId)
 *
 * classifyCameraFamily.m already runs every case and flags a reported-vs-
 * detected mismatch (gradingOrchestrator.js's cameraMismatch handling below),
 * but that flag alone says nothing about whether THIS camera/site combination
 * has a track record yet -- an established camera can mismatch on a single
 * unusual photo without that being a systemic problem, while a mismatch on a
 * brand-new install is exactly the "unfamiliar input distribution" case a
 * conformal guarantee fitted on public datasets says nothing about.
 *
 * "Cleared probation" = this exact (phc_id, camera_device_id) pair has at
 * least CAMERA_PROBATION_MIN_CASES prior GRADED cases. Keyed on the pair, not
 * either alone: moving a known camera to a new site, or a new camera arriving
 * at a known site, both restart probation, because the failure mode this
 * guards against (unfamiliar capture characteristics) can come from either.
 *
 * No cameraDeviceId reported -> nothing to be "on probation" FOR -> treated
 * as cleared, so a missing worker-reported field doesn't itself block a case
 * (a null/absent report is a data-completeness issue, not evidence of an
 * unfamiliar camera).
 */
const CAMERA_PROBATION_MIN_CASES = 20;

async function hasClearedCameraSiteProbation(phcId, cameraDeviceId, excludeCaseId) {
  if (!cameraDeviceId) return true;
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS n
      FROM cases c
      JOIN grading_results g ON g.case_id = c.case_id
     WHERE c.camera_device_id = $1
       AND c.phc_id IS NOT DISTINCT FROM $2
       AND c.case_id <> $3
  `, [cameraDeviceId, phcId, excludeCaseId]);
  return rows[0].n >= CAMERA_PROBATION_MIN_CASES;
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * processCase(caseId)
 *
 * Media may be encrypted at rest (mediaCrypto.js), and Python and MATLAB read
 * the image by path, so grading runs on a decrypted temp copy that is deleted
 * afterwards. Everything the pipeline wrote into the case's media directory
 * (Grad-CAM, masks) is encrypted as soon as it finishes -- success or failure.
 *
 * @param {string} caseId — UUID of the case to grade.
 * @returns {Promise<Object>} summary of what was written to the DB.
 */
async function processCase(caseId) {
  const { rows } = await pool.query('SELECT image_path FROM cases WHERE case_id = $1', [caseId]);
  if (!rows.length) return gradeCase(caseId, null);   // throws "not found", as before
  try {
    return await mediaCrypto.withPlaintextCopy(rows[0].image_path,
      (plainImagePath) => gradeCase(caseId, plainImagePath));
  } finally {
    try {
      mediaCrypto.encryptDir(mediaPaths.caseDir(caseId));
    } catch (err) {
      console.error(`[gradingOrchestrator] case ${caseId}: could not encrypt pipeline outputs: ${err.message}`);
    }
  }
}

async function gradeCase(caseId, plainImagePath) {
  // ── Step 1: fetch case row ─────────────────────────────────────────────────
  // Joined to patients for age, which the urgency score needs and the cases
  // table does not carry. LEFT JOIN, not INNER: a case whose patient row is
  // somehow missing must still be graded -- it just gets no urgency score.
  const caseRes = await pool.query(
    `SELECT c.*, p.age AS patient_age
       FROM cases c
       LEFT JOIN patients p ON p.patient_id = c.patient_id
      WHERE c.case_id = $1`, [caseId]);
  if (caseRes.rows.length === 0)
    throw new Error(`processCase: case '${caseId}' not found in cases table`);

  const caseRow   = caseRes.rows[0];
  // The readable copy from processCase; the stored path itself when the file
  // is not encrypted.
  const imagePath = plainImagePath || caseRow.image_path;
  if (!imagePath)
    throw new Error(`processCase: case '${caseId}' has no image_path`);

  // ── Step 2: ONE MATLAB round-trip for the whole per-case pipeline ─────────
  // Camera check, NV score, rule engine, lesion attention and the evidence
  // sentence all run in a single call (runCasePipeline.m) rather than five, and
  // that call goes to the persistent session when one is up -- see
  // runCasePipelineMatlab below for why it still falls back to a fresh MATLAB.
  const gradcamPath = mediaPaths.gradcamPath(caseId);   // creates the dir too

  // The PHC quality gate's sub-scores. Used HERE, by isCaptureUngradable below
  // -- they are no longer sent to MATLAB, which stopped reading them when
  // Branch A's preprocessing moved to Python.
  const qualityScores = caseRow.quality_scores || null;

  const cameraDeviceId = caseRow.camera_device_id || '';

  // ── The two Python stages, in parallel ─────────────────────────────────────
  // Branch A (the classifier) and Phase 4 segmentation are independent, so they
  // run concurrently: each loads its own models and neither reads the other's
  // output. MATLAB then runs LAST, because the rule engine needs the lesion
  // counts and the agreement check needs Branch A's grade.
  //
  // Why Python at all: MATLAB's official PyTorch converter imports these
  // networks and computes the wrong numbers — 8-11% class agreement against the
  // model's own published logits, correlation -0.25, on identical input
  // tensors, while Python reproduces them to 0.0050 with 100% agreement. The
  // structure imports correctly, which is what makes it dangerous. Measured in
  // testImportedNetwork.m; re-run it if the converter is updated.
  //
  // Grad-CAM is produced inside the Branch A call rather than a second spawn:
  // interpreter start and model load dominate the cost.
  //
  // Promise.all and not allSettled: segment() resolves NULL on an ordinary
  // failure, because Branch B is the second opinion and losing it must degrade
  // the result rather than fail the case. A Branch A failure DOES reject, and
  // should — without it there is no grade at all. So does a segmentation MATLAB-
  // engine failure (matlab_segmentation_failed): see runSegInference.
  //
  // Backend switch (INFERENCE_BACKEND=python|matlab, default python): both
  // functions resolve to the identical JSON shape, so nothing below this line
  // needs to know which one ran. Segmentation is unaffected either way.
  const runBranchA = INFERENCE_BACKEND === 'matlab'
    ? runBranchAInferenceMatlab
    : runBranchAInference;
  // Probation lookup runs alongside the two inference calls rather than
  // after them -- it only needs caseRow fields already in hand, and adding it
  // serially would tack a DB round-trip onto every case's latency for no
  // reason.
  const [branchA, segResult, cameraSiteProbationCleared] = await Promise.all([
    runBranchA(imagePath, gradcamPath),
    segment(imagePath, mediaPaths.caseDir(caseId)),
    hasClearedCameraSiteProbation(caseRow.phc_id, cameraDeviceId, caseId),
  ]);

  if (!segResult) {
    console.warn(`[gradingOrchestrator] case ${caseId}: Branch B unavailable, `
      + 'grading on the classifier alone');
  }

  let mlResult;
  // How the MATLAB per-case pipeline actually ran ('session' | 'batch'), or
  // 'js-fallback' -- recorded as the rule engine's provenance below.
  const casePipelineRun = { via: null };
  try {
    mlResult = await runCasePipelineMatlab(
      buildCasePipelineInput(imagePath, cameraDeviceId, caseId, segResult,
                             branchA.drGradeCnn, branchA.gradcamMap,
                             caseClinicalInputs(caseRow.patient_age, caseRow.questionnaire_data)),
      caseId, casePipelineRun);
  } catch (err) {
    if (ALLOW_MATLAB_FALLBACK && err.code === 'matlab_unavailable') {
      casePipelineRun.via = 'js-fallback';
      console.warn(`[gradingOrchestrator] case ${caseId}: MATLAB is not installed on `
        + 'this machine — using the JS fallback (matlabFallback.js) for Branch B / '
        + 'evidence report / camera check. On a machine with MATLAB this code path '
        + 'is never taken.');
      mlResult = matlabFallback.runMatlabFallback({
        imagePath, segResult, branchAGrade: branchA.drGradeCnn,
        ruleOpts: caseRuleOpts(segResult),
      });
    } else {
      // Re-wrap for context but CARRY THE CODE. Without this the classification
      // above is lost at the boundary and every failure looks transient again —
      // the wrapper is exactly where a permanent error quietly becomes a
      // three-attempt one.
      throw unavailable(err.code,
        `Grading pipeline MATLAB call failed: ${err.message}`);
    }
  }

  const grade = branchA.drGradeCnn;
  const confidenceScore = branchA.confidenceScore;
  const referable = branchA.referable;

  if (branchA.calibrationWarning) {
    console.warn(`[gradingOrchestrator] case ${caseId}: ${branchA.calibrationWarning}`);
  }
  if (branchA.gradcamError) {
    console.warn(`[gradingOrchestrator] case ${caseId}: Grad-CAM failed: ${branchA.gradcamError}`);
  }
  // Design doc §6.9's safeguard. A heatmap sitting mostly outside the retinal
  // circle means the model keyed on camera artefacts rather than the eye, and
  // that is a reason for a human to look — not something to log quietly and
  // move past.
  if (branchA.gradcamWarning) {
    console.warn(`[gradingOrchestrator] case ${caseId}: ${branchA.gradcamWarning}`);
  }

  // Branch B (Tasks 5.1/5.2), live. The rule engine grades the lesion QUADRANT
  // COUNTS that Phase 4 segmentation produced, and branchesAgree compares its
  // grade with Branch A's.
  //
  // fromMatlab, not `?? null`: MATLAB's jsonencode renders an empty array as
  // JSON [], NOT as null. That arrives here as an empty JS array, which `??`
  // does not catch because [] is not nullish — and node-postgres then serialises
  // it as the Postgres ARRAY literal {}, so the insert dies with
  // `invalid input syntax for type boolean: "{}"`. MATLAB uses [] for both
  // "no grade" and "no opinion", which are exactly the cases this must map to
  // SQL NULL, so every value crossing that boundary goes through here.
  //
  // Inside fromMatlab it is `?? null` and not `|| null`, because a rule-engine
  // grade of 0 is a real result — "no DR by ICDR criteria" — and || would
  // discard Branch B's opinion on precisely the healthy eyes where agreement
  // matters most for clearing a case. `false` must survive for the same reason.
  // (fromMatlab now lives in matlabInterop.js and mlResult is already
  // normalised by fromMatlabDeep; the per-field calls below are kept as a
  // second guard for the JS-fallback path, which does not go through it.)

  const ruleEngineGrade = fromMatlab(mlResult.ruleEngineGrade);
  const branchAgreement = fromMatlab(mlResult.branchAgreement);

  // v2-task item 6 ("feed M5's microaneurysm count into the grade-0-vs-1
  // decision"): investigated with real inference on the recovered held-out
  // IDRiD grade-1/grade-0 images, not implemented as an automatic grade
  // override -- see experiments/investigateM5Grade1.py's docstring for the
  // n=10 evidence. A naive "M5 red count >= redFloor => bump grade 0 to 1"
  // rule would have fixed at most 3/4 real grade-1 misses while
  // mis-escalating 3/6 true grade-0 images in that sample (spurious counts
  // of 6, 16, and a boundary 3, well above the "1-2" ruleEngineGrade.m's
  // redFloor was calibrated on). Silently rewriting dr_grade_cnn on a signal
  // that noisy was not a defensible trade.
  //
  // What M5's count already does, correctly: it feeds ruleEngineGrade.m,
  // whose grade is compared to Branch A's by branchesAgree() -- CNN=0 vs
  // rule-engine>=1 IS a disagreement there (`agree = gradeA == gradeB` for
  // the non-lower-bound case), so it already forces Tier C via the
  // branchAgreement check below. That is the safe version of "feed the count
  // into the decision": a human sees it, the pipeline does not silently
  // relabel a healthy eye on a spurious detection. This flag exists so that
  // specific boundary is distinguishable in logs from other disagreements,
  // for monitoring and any future, better-evidenced threshold change.
  const grade0Vs1Disagreement = branchAgreement === false
    && grade === 0 && Number.isInteger(ruleEngineGrade) && ruleEngineGrade >= 1;
  if (grade0Vs1Disagreement) {
    console.log(`[gradingOrchestrator] case ${caseId}: grade0Vs1Disagreement — `
      + `CNN said 0, rule engine (M5-fed) said ${ruleEngineGrade} — routed to Tier C, `
      + 'grade NOT auto-corrected (see investigateM5Grade1.py)');
  }

  // Task 6.3. A reported-vs-detected disagreement is ALWAYS logged. Whether it
  // also touches the tier depends on cameraSiteProbationCleared (see the
  // override chain below) — an established camera/site's occasional mismatch
  // stays a log line, same as before; the previous behaviour ("never changes
  // the grading") now only holds once this camera/site has a track record.
  // The stored, three-state form of the same check (migration 0021). The
  // console.warn below and the probation override are both lossy: the override
  // only writes a tier_reason while the tier would otherwise be A AND the
  // camera/site is still on probation, so on an established camera, or on a
  // case already in Tier B/C, the mismatch used to reach nobody.
  const cameraCheck = readCameraCheck(mlResult);
  const cameraProbationOverride = mlResult.cameraMismatch === true
    && !cameraSiteProbationCleared;
  if (mlResult.cameraMismatch) {
    console.warn(`[gradingOrchestrator] case ${caseId}: camera family mismatch — `
      + `reported '${cameraDeviceId}', image looks like '${mlResult.cameraFamily}'`
      + (cameraSiteProbationCleared ? '' : ' (camera/site still on probation)'));
  }

  // quality_scores was already loaded (above) and forwarded to MATLAB for
  // adaptiveEnhance's preprocessing, but until now nothing turned it into a
  // tier signal. isCaptureUngradable reuses qualityGateMain.m's own
  // hard-retake thresholds — see that function's header.
  const qualityForced = isCaptureUngradable(qualityScores);

  // §I: the localizer could not place the fovea (Tanuj's peak-confidence gate).
  // true / false when reported, null when the localization output does not
  // carry the field yet -- "not reported" is NOT the same as "reliable", and
  // it is stored as NULL rather than false for that reason.
  const foveaUnreliable = readFoveaUnreliable(segResult);

  // §P / §10.4: the eye the image itself reports (DICOM ImageLaterality, read
  // by readFundusImage.m) against the one the technician selected.
  const detectedLaterality = { L: 'left', R: 'right' }[
    String(fromMatlab(mlResult.imageLaterality) || '').toUpperCase()] || null;
  const reportedLaterality = caseRow.eye_laterality_reported || null;
  const lateralityMismatch = !!(detectedLaterality && reportedLaterality
    && detectedLaterality !== reportedLaterality);
  if (lateralityMismatch) {
    console.warn(`[gradingOrchestrator] case ${caseId}: eye laterality mismatch — `
      + `technician said ${reportedLaterality}, the DICOM file says ${detectedLaterality}`);
  }

  // ── Tier: real conformal boundaries now, not the placeholder thresholds ────
  // branchAInfer.py assigns A/B/C from the conformal prediction set fitted by
  // calibrateBranchA.m (Task 6.2). assignTier's hardcoded 0.9/0.6 cut-offs were
  // always documented as temporary and are now the fallback for when no
  // calibration file exists.
  //
  // The disagreement override stays HERE regardless, because it is the one
  // thing Python cannot know: Branch B runs in MATLAB, so only this function
  // sees both grades. A confident disagreement is more alarming than an
  // unconfident one, and it forces full manual review whatever the conformal
  // set says (design doc §1.11, §6.7).
  // A grade above the rule engine's ceiling has NO second opinion at all: the
  // rule engine cannot represent it, so branchesAgree correctly returns null
  // rather than a false agreement or a spurious disagreement. That leaves the
  // most consequential grade this system can produce — proliferative DR — as the
  // one case where the dual-branch safety net silently does not apply.
  //
  // So it is escalated explicitly, on its own stated reason, rather than by
  // pretending the branches disagreed. This is what Tanuj's cap was for: every
  // suspected grade 4 reaches an ophthalmologist. It matters here because NV
  // recall is 0.4444 — the branch most likely to be wrong about grade 4 is the
  // only branch that can assess it.
  const beyondRuleEngine =
    mlResult.ruleIsLowerBound === true &&
    Number.isInteger(fromMatlab(mlResult.ruleMaxGrade)) &&
    grade > fromMatlab(mlResult.ruleMaxGrade);

  // ── Override chain ──────────────────────────────────────────────────────
  // All four early checks are decided before the conformal tier is ever
  // consulted — none of them is a statement about classifier confidence, so
  // none of them should be answerable by one.
  //
  // Ordering is NOT arbitrary. The three checks that force an exact 'C'
  // (branch disagreement, beyond-rule-engine, quality-forced) all come before
  // the one check that only raises a FLOOR to 'B' (camera/site probation).
  // Checking the floor first would risk it short-circuiting the chain on a
  // case that also warranted a hard 'C' — e.g. a probation-camera image of a
  // confirmed grade 4 must still reach 'C', not get stuck at 'B' because the
  // probation check matched first. A floor can only ever raise A -> B; it
  // must never be able to pre-empt a real C.
  const decided = decideTier({
    branchAgreement, beyondRuleEngine, qualityForced,
    ruleMaxGrade: mlResult.ruleMaxGrade, grade,
    conformalTier: branchA.conformalTier, conformalReason: branchA.tierReason,
    confidenceScore, cameraProbationOverride, lateralityMismatch, foveaUnreliable,
    cameraNotValidated: isCameraNotValidated(caseRow.phc_id, cameraDeviceId),
  });
  const tier = decided.tier;
  const tierReason = decided.tierReason;

  if (tier === 'C') {
    console.log(`[gradingOrchestrator] case ${caseId}: Tier C — ${tierReason}`);
  }

  // ── Step 3: INSERT INTO grading_results ────────────────────────────────────
  //
  // uncertainty_score (Task 6.1) is written from MC-dropout. It is NULL, never
  // 0, when the measurement did not happen: the ophthalmologist queue ranks
  // Tier C by it descending and falls back to (1 - confidence) while NULL, so
  // a 0 meaning "not measured" would read as "maximally certain" and sort a
  // never-sampled case to the wrong end of the queue.
  //
  // Note the comment sits ABOVE pool.query, not inside the template literal.
  // A JS comment inside the SQL string is sent to Postgres as SQL and every
  // case fails with a syntax error -- that has already happened here once.
  // fromMatlab, not `?? null`: the MATLAB backend's branchAInferMatlab.m
  // reports "not measured" as `[]` (MATLAB's empty-array idiom), and
  // jsonencode renders that as JSON `[]`, not `null` -- the same MATLAB/JS
  // mismatch `fromMatlab` was already built for below (ruleEngineGrade,
  // branchAgreement). `[]` is not nullish, so plain `?? null` would leave an
  // array here and the INSERT below would fail against a FLOAT column. The
  // Python backend's real `null` passes through fromMatlab unchanged.
  const uncertaintyScore = fromMatlab(branchA.uncertaintyScore);

  // WHICH MODEL GRADED THIS CASE -- from the inference result, not a constant.
  // Both engines report it (branchAInferMatlab.m's out.modelVersion and
  // branchAInfer.py's "modelVersion"), and both honour BRANCH_A_MODEL_VERSION,
  // so this follows a version switch automatically instead of needing a code
  // edit nobody remembers to make. Falls back to 'unknown' rather than to a
  // guess: a row that cannot say what produced it must not claim a version.
  const modelVersion = (typeof branchA.modelVersion === 'string'
    && branchA.modelVersion.trim())
    ? branchA.modelVersion.trim()
    : MODEL_VERSION_FALLBACK;

  // grading_results.model_version is a FOREIGN KEY into model_versions, so an
  // unregistered model does not produce a wrong row -- it produces a raw
  // "violates foreign key constraint" from deep inside the insert, which says
  // nothing about what to do. Checked here so the message names the actual
  // problem and the fix. The constraint itself is correct and stays: a grade
  // may only cite a model someone registered, with the validation numbers
  // that justified using it.
  await assertModelRegistered(modelVersion);

  // ── Triage urgency: stored, but it decides nothing ────────────────────────
  // A QUEUE ORDERING HINT from a forest trained on SYNTHETIC data. It is
  // deliberately read here and nowhere near decideTier, the referral logic or
  // the SMS -- see migration 0018 and calculateUrgencyScore.m's header.
  //
  // Absent when MATLAB skipped the score because the clinical inputs were not
  // all there. NULL is stored, never a 1: 1 is a real low-urgency score, so an
  // imputed one could not be told apart from a measured one.
  const urgency = {
    score: Number.isFinite(fromMatlab(mlResult.urgencyScore))
      ? Math.round(fromMatlab(mlResult.urgencyScore)) : null,
    factor: blankToNull(fromMatlab(mlResult.urgencyFactor)),
    inputs: fromMatlabDeep(mlResult.urgencyInputs) ?? null,
  };
  if (mlResult.urgencyError) {
    console.warn(`[gradingOrchestrator] case ${caseId}: urgency score not `
      + `computed: ${mlResult.urgencyError}`);
  }
  if (branchA.uncertaintyError) {
    console.warn(`[gradingOrchestrator] case ${caseId}: `
      + `MC-dropout failed: ${branchA.uncertaintyError}`);
  }

  // WHICH ENGINE produced each ML output (standing rule: every case records
  // it; no silent engine fallback). The quality gate's is not here: it ran at
  // the PHC and arrived with the case (cases.quality_gate_engine).
  const engineProvenance = buildEngineProvenance({
    inferenceBackend: INFERENCE_BACKEND, segResult, casePipelineVia: casePipelineRun.via,
  });

  await pool.query(`
    INSERT INTO grading_results
      (case_id, dr_grade_cnn, referable, confidence_score,
       conformal_tier, model_version, graded_at,
       dr_grade_rule_engine, branch_agreement, uncertainty_score, tier_reason,
       urgency_score, urgency_factor, urgency_inputs, engine_provenance)
    VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (case_id) DO UPDATE SET
      engine_provenance    = EXCLUDED.engine_provenance,
      dr_grade_cnn         = EXCLUDED.dr_grade_cnn,
      referable            = EXCLUDED.referable,
      confidence_score     = EXCLUDED.confidence_score,
      conformal_tier       = EXCLUDED.conformal_tier,
      model_version        = EXCLUDED.model_version,
      graded_at            = NOW(),
      dr_grade_rule_engine = EXCLUDED.dr_grade_rule_engine,
      branch_agreement     = EXCLUDED.branch_agreement,
      uncertainty_score    = EXCLUDED.uncertainty_score,
      tier_reason          = EXCLUDED.tier_reason,
      urgency_score        = EXCLUDED.urgency_score,
      urgency_factor       = EXCLUDED.urgency_factor,
      urgency_inputs       = EXCLUDED.urgency_inputs
  `, [caseId, grade, referable, confidenceScore, tier, modelVersion,
      ruleEngineGrade, branchAgreement, uncertaintyScore, tierReason ?? null,
      urgency.score, urgency.factor, urgency.inputs, engineProvenance]);

  // ── Step 4: INSERT INTO explainability_outputs ─────────────────────────────
  // vessel_mask_path, lesion_red_path, lesion_bright_path stay NULL (Phase 3).
  //
  // gradcam_path is written only when Python actually produced an overlay. A
  // Grad-CAM failure does not fail the grade — the clinical output is already
  // computed — so the column falls back to NULL and the frontend renders "not
  // yet available" rather than a URL to a file that is not there.
  await pool.query(`
    INSERT INTO explainability_outputs
      (case_id, gradcam_path, evidence_summary_text,
       lesion_attention_consistency_score,
       lesion_attention_chance_level, lesion_attention_enrichment,
       lesion_attention_flagged)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (case_id) DO UPDATE SET
      gradcam_path                       = EXCLUDED.gradcam_path,
      evidence_summary_text              = EXCLUDED.evidence_summary_text,
      lesion_attention_consistency_score = EXCLUDED.lesion_attention_consistency_score,
      lesion_attention_chance_level      = EXCLUDED.lesion_attention_chance_level,
      lesion_attention_enrichment        = EXCLUDED.lesion_attention_enrichment,
      lesion_attention_flagged           = EXCLUDED.lesion_attention_flagged
  `, [caseId, branchA.gradcamPath ?? null, mlResult.evidenceSummaryText ?? null,
      // The score NEVER travels alone (migration 0022). A bare overlap
      // fraction is not interpretable: lesions covering 70% of the retina make
      // a noise heatmap score 0.70 too. chanceLevel is what a random heatmap
      // would score on THIS eye, and enrichment is the ratio that means
      // something.
      fromMatlab(mlResult.lesionAttentionConsistency),
      fromMatlab(mlResult.lesionAttentionChanceLevel),
      fromMatlab(mlResult.lesionAttentionEnrichment),
      // Defined even when the score is not: a heatmap with no energy is
      // undefined-but-flagged, because Grad-CAM producing nothing is itself a
      // reason to review.
      typeof mlResult.lesionAttentionFlagged === 'boolean'
        ? mlResult.lesionAttentionFlagged : null]);

  // ── Step 4b: INSERT INTO segmentation_outputs ──────────────────────────────
  // This table has existed since the initial schema with exactly the columns
  // Phase 4 produces — lesion_counts, nv_suspicion_score, vessel_map_path,
  // optic_disc_x/y, fovea_x/y — and nothing had ever written to it. The
  // case-detail API SELECTs from it, so lesionCounts and nvSuspicionScore were
  // reaching the frontend as null on every case even once segmentation ran.
  //
  // Paths come from segInfer's own report of what it wrote, not from
  // reconstructing a filename here: a path built by guessing the convention is
  // a path that 404s the day one side of the convention changes.
  if (segResult) {
    const masks = segResult.masks || {};

    // nv_suspicion_score (§J): neovascularizationSuspicion.m now runs inside
    // the per-case MATLAB call on segInfer's vessel mask. It is NULL -- never 0
    // -- when it could not run (no vessel mask, no optic disc): 0 would claim
    // the score was MEASURED and came out at zero, which is a different
    // statement from "no detector ran". Unmeasured is NULL everywhere else in
    // this project.
    await pool.query(`
      INSERT INTO segmentation_outputs
        (case_id, lesion_counts, nv_suspicion_score, vessel_map_path,
         lesion_masks_path, optic_disc_x, optic_disc_y, fovea_x, fovea_y,
         fovea_unreliable)
      VALUES ($1, $2, $9, $3, $4, $5, $6, $7, $8, $10)
      ON CONFLICT (case_id) DO UPDATE SET
        nv_suspicion_score = EXCLUDED.nv_suspicion_score,
        fovea_unreliable  = EXCLUDED.fovea_unreliable,
        lesion_counts     = EXCLUDED.lesion_counts,
        vessel_map_path   = EXCLUDED.vessel_map_path,
        lesion_masks_path = EXCLUDED.lesion_masks_path,
        optic_disc_x      = EXCLUDED.optic_disc_x,
        optic_disc_y      = EXCLUDED.optic_disc_y,
        fovea_x           = EXCLUDED.fovea_x,
        fovea_y           = EXCLUDED.fovea_y
    `, [caseId,
        JSON.stringify({
          red: segResult.redPerQuadrant ?? null,
          bright: segResult.brightPerQuadrant ?? null,
          redTotal: segResult.redLesions?.count ?? null,
          brightTotal: segResult.brightLesions?.count ?? null,
          minAreaPx: segResult.redLesions?.minAreaFilter ?? null,
          // The counting procedure travels WITH the counts. These numbers are
          // only comparable to the ICDR thresholds because they were produced
          // the same way, and a reader six months from now cannot recover that
          // from four integers.
          procedure: segResult.countingProcedure ?? null,

          // ── M5 v2, additive and absent under v1 ──────────────────────────
          // Under RED_LESION_MODEL_VERSION=v2 the red-lesion model separates
          // microaneurysms from haemorrhages, and segInfer reports both the
          // per-quadrant split and its own totals. Stored with `?? null`
          // throughout, so a v1 case keeps exactly the shape it has today:
          // absent stays absent, and services/lesionCounts.js reads null as
          // "this detector does not exist yet" rather than "none were found".
          ma: segResult.maPerQuadrant ?? null,
          he: segResult.hePerQuadrant ?? null,
          maTotal: segResult.lesionCounts?.microaneurysms ?? null,
          heTotal: segResult.lesionCounts?.hemorrhages ?? null,
          redLesionModelVersion: segResult.redLesionModelVersion ?? 'v1',
        }),
        masks.vessel ?? null,
        // One column for both lesion masks: the schema predates there being two
        // models. Stored as JSON rather than picking one and dropping the other.
        JSON.stringify({ red: masks.red ?? null, bright: masks.bright ?? null }),
        segResult.opticDisc?.x ?? null, segResult.opticDisc?.y ?? null,
        segResult.fovea?.x ?? null, segResult.fovea?.y ?? null,
        Number.isFinite(fromMatlab(mlResult.nvSuspicionScore))
          ? mlResult.nvSuspicionScore : null,
        foveaUnreliable]);
  }

  // (lesion_attention_consistency_score is written in Step 4 above, from
  // mlResult.lesionAttentionConsistency. This used to say it "stays NULL on
  // purpose" because Tasks 4.2/4.3 produced no lesion mask -- that stopped
  // being true when the segmenter landed, and the comment outlived it. The
  // score is NULL only when runCasePipeline.m could not compute one, which
  // needs the Grad-CAM map as well as the masks.)

  // ── Step 5: mark case as graded ────────────────────────────────────────────
  await pool.query(
    // source_format / dicom_device_model: what the IMAGE FILE says about
    // itself, kept apart from the worker-reported camera_device_id on purpose
    // -- see migration 0016. Both engines have always returned these; until
    // now nothing stored them, while readFundusImage.m's header claimed the
    // device "is recorded as evidence".
    //
    // THE FAILURE COLUMNS ARE CLEARED. A case can reach here after having
    // failed before -- the queue retries, the watchdog recovers, and a case
    // can be re-graded by hand. Leaving failure_code / failure_reason /
    // failed_at behind would leave a GRADED case carrying the reason it once
    // gave up, and api-contracts.md says failureCode is "null on every case
    // that has not failed". getCaseDetail serves the column straight, with no
    // status check, so the stale value would be reported as this case's own.
    // (/admin/system-health filters on status = 'error' and was never wrong.)
    `UPDATE cases SET status = 'graded', camera_family_detected = $2,
       eye_laterality_detected = $3, source_format = $4, dicom_device_model = $5,
       camera_mismatch = $6, camera_expected_family = $7,
       failure_code = NULL, failure_reason = NULL, failed_at = NULL
     WHERE case_id = $1`,
    [caseId, fromMatlab(mlResult.cameraFamily), detectedLaterality,
     blankToNull(fromMatlab(mlResult.sourceFormat)),
     blankToNull(fromMatlab(mlResult.dicomDeviceModel)),
     cameraCheck.mismatch, cameraCheck.expectedFamily]);

  console.log(`[gradingOrchestrator] case ${caseId}: grade=${grade}, `
    + `confidence=${confidenceScore.toFixed(4)}, tier=${tier}, `
    + `referable=${referable}`);

  return { caseId, grade, confidenceScore, referable, tier, gradcamPath: branchA.gradcamPath ?? null };
}

// ── MATLAB expression builder ──────────────────────────────────────────────────
/** A 4-element quadrant count array, or null when absent or malformed. */
function quadCounts(arr) {
  if (!Array.isArray(arr) || arr.length !== 4) return null;
  if (!arr.every((v) => Number.isInteger(v) && v >= 0)) return null;
  return arr;
}

/**
 * camMatrix(rows) -- an MxN numeric matrix, or null when absent or ragged.
 *
 * null rather than zeros(): an all-zero Grad-CAM is a real and meaningful state
 * (no positive evidence survived the ReLU), so it must not be the value that
 * also means "no heatmap was produced".
 */
function camMatrix(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const width = rows[0].length;
  if (!rows.every((r) => Array.isArray(r) && r.length === width
                         && r.every((v) => Number.isFinite(v)))) return null;
  return rows;
}

/** [x, y] from {x, y}, or null when either is missing. */
function opticDiscXY(pt) {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
  return [pt.x, pt.y];
}

/**
 * readFoveaUnreliable(segResult) -> true | false | null (backend plan §I).
 * Accepts the contract field `foveaUnreliable` at the top level of the
 * localization/segmentation JSON. Anything but a real boolean is null --
 * including MATLAB's [] -- because "not reported" must not read as "reliable".
 */
function readFoveaUnreliable(segResult) {
  const v = segResult ? segResult.foveaUnreliable : undefined;
  return typeof v === 'boolean' ? v : null;
}

/** 4 booleans, or null when not a 4-element boolean/0-1 array. */
function flags4(arr) {
  if (!Array.isArray(arr) || arr.length !== 4) return null;
  if (!arr.every((v) => v === true || v === false || v === 0 || v === 1)) return null;
  return arr.map((v) => !!v);
}

/**
 * caseRuleOpts(segResult) -- the ruleEngineGrade opts (backend plan §H, §I).
 *
 * Contract fields (agreed with Tanuj): venousBeadingQuadrants, irmaQuadrants
 * (4 booleans, fundusQuadrants('names') order), foveaUnreliable (boolean).
 * ONLY fields that are actually present and well-formed are included: to the
 * rule engine a supplied array -- even an all-false one -- means that criterion
 * WAS assessed, and drops the "not assessed" caveat from the evidence text.
 */
/**
 * assertModelRegistered(versionId)
 *
 * A grade must be able to say which model produced it, and model_versions is
 * where that claim is anchored -- version, training date, and the validation
 * sensitivity/specificity/kappa that justified deploying it.
 *
 * Cached after the first successful lookup: the registry changes by migration,
 * not during a run, and this sits on the per-case path.
 *
 * Deliberately FAILS the case rather than storing NULL or a fallback string.
 * A case graded by a model nobody registered has no provenance, and quietly
 * accepting it is how the old hardcoded constant survived -- every row claimed
 * branchA_v1 whatever actually ran. The error names the migration to add.
 */
/**
 * blankToNull(v) -- MATLAB's '' is "not stated", and must not be stored as a
 * value. readFundusImage.m initialises deviceModel and laterality to '' and
 * fills them only from a DICOM tag, so a JPEG capture arrives with empty
 * strings. Stored raw, the column then holds '' for "no DICOM device" and
 * NULL for "graded before this was recorded" -- two different unknowns that
 * read as different things while meaning the same one.
 */
function blankToNull(v) {
  if (typeof v !== 'string') return v ?? null;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * readCameraCheck(mlResult) -- the reported-vs-detected camera cross-check as
 * the three states migration 0021 stores, not the two the engines return.
 *
 * classifyCameraFamily.m can only compare the detected family against the
 * family the reported device implies when that device is in
 * calibrationProfiles.json's deviceAssociations. When it is not -- an
 * unrecognised dropdown value, or no device reported at all -- it has nothing
 * to compare against and returns mismatch = false.
 *
 * That false means "not checked". Storing it as false would record that this
 * camera was verified against its own image, about a case where nobody could
 * look. So the checkability test is expectedFamily, not mismatch:
 *
 *   expectedFamily non-empty -> the check ran; mismatch is its real answer
 *   expectedFamily empty     -> NULL, and no expected family to show
 *
 * cameraExpectedFamily was added to runCasePipeline.m's output for exactly
 * this; a result from an older engine that does not carry it is not-checkable
 * by the same rule, which is the safe reading of a missing field.
 */
function readCameraCheck(mlResult) {
  const expected = blankToNull(fromMatlab(mlResult.cameraExpectedFamily));
  if (expected === null) return { mismatch: null, expectedFamily: null };
  return { mismatch: mlResult.cameraMismatch === true, expectedFamily: expected };
}

const REGISTERED_MODELS = new Set();
async function assertModelRegistered(versionId) {
  if (REGISTERED_MODELS.has(versionId)) return;
  const { rows } = await pool.query(
    'SELECT 1 FROM model_versions WHERE version_id = $1', [versionId]);
  if (rows.length === 0) {
    const err = new Error(
      `model '${versionId}' is not registered in model_versions, so a grade `
      + 'citing it cannot be stored (grading_results.model_version is a foreign '
      + 'key into that table). Add it in a migration with its validation '
      + 'sensitivity, specificity and kappa -- see '
      + 'db/migrations/0017_register_classifier_v2_family.sql.');
    err.code = 'model_not_registered';
    throw err;
  }
  REGISTERED_MODELS.add(versionId);
}

/**
 * caseClinicalInputs(patientAge, questionnaire) -> clinical block or null
 *
 * What calculateUrgencyScore.m needs: age, years diabetic, HbA1c. Returns
 * null unless ALL THREE are genuinely available, which makes MATLAB skip the
 * score entirely.
 *
 * ── THE PART THAT MATTERS: WHAT COUNTS AS "AVAILABLE" ──────────────────────
 * The PHC questionnaire has historically carried BUCKETS -- glycemicControl
 * 'good'|'moderate'|'poor' and yearsSinceDiagnosis 'lt1'|'1to5'|... -- while
 * the function wants a lab HbA1c and an integer year count. The intake form
 * now collects the real numbers, so a bucket is only ever a fallback for an
 * older capture.
 *
 * Bucket midpoints ARE used, but never silently: each value is tagged
 * 'measured' or 'assumed' in `provenance`, that tag is stored in
 * urgency_inputs, and the case detail is expected to show it. A screen must
 * be able to say "HbA1c 9.5% (assumed from 'poor')" rather than implying a
 * test the patient never had -- which is the specific failure
 * calculateUrgencyScore.m's wiring notes call out.
 *
 * A bucket with no defensible midpoint (an unrecognised value) yields null
 * rather than a guess, and null means no score at all.
 */
const HBA1C_FROM_BUCKET = { good: 6.2, moderate: 7.5, poor: 9.5 };
const YEARS_FROM_BUCKET = { lt1: 0.5, '1to5': 3, '5to10': 7.5, gt10: 15 };

function caseClinicalInputs(patientAge, questionnaire) {
  const age = Number(patientAge);
  if (!Number.isFinite(age) || age < 1 || age > 120) return null;

  const rf = (questionnaire && questionnaire.riskFactors) || {};
  const provenance = { patientAge: 'measured' };

  // `Number(null) === 0`, and 0 is finite -- so a field the current intake
  // forms never collect (they send null, not omit the key) used to coerce
  // to a false "0, measured" reading instead of falling through to the
  // bucket. Guard the null/undefined case explicitly before coercing;
  // Number(undefined) is already NaN and needed no guard, but null does.
  const hasRealNumber = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

  // HbA1c: the real lab value when the form collected one, else the bucket.
  let hba1c = hasRealNumber(rf.hba1c) ? Number(rf.hba1c) : NaN;
  if (Number.isFinite(hba1c)) {
    provenance.hba1c = 'measured';
  } else {
    hba1c = HBA1C_FROM_BUCKET[String(rf.glycemicControl || '').toLowerCase()];
    provenance.hba1c = hba1c === undefined ? 'missing'
      : `assumed from glycemicControl='${rf.glycemicControl}'`;
  }

  let years = hasRealNumber(rf.yearsDiabetic) ? Number(rf.yearsDiabetic) : NaN;
  if (Number.isFinite(years)) {
    provenance.yearsDiabetic = 'measured';
  } else {
    years = YEARS_FROM_BUCKET[String(rf.yearsSinceDiagnosis || '').toLowerCase()];
    provenance.yearsDiabetic = years === undefined ? 'missing'
      : `assumed from yearsSinceDiagnosis='${rf.yearsSinceDiagnosis}'`;
  }

  if (!Number.isFinite(hba1c) || !Number.isFinite(years)) return null;
  return { patientAge: age, yearsDiabetic: years, hba1c, provenance };
}

function caseRuleOpts(segResult) {
  const opts = {};
  const vb = flags4(segResult && segResult.venousBeadingQuadrants);
  const irma = flags4(segResult && segResult.irmaQuadrants);
  if (vb) opts.venousBeadingQuadrants = vb;
  if (irma) opts.irmaQuadrants = irma;
  if (readFoveaUnreliable(segResult) === true) opts.foveaUnreliable = true;
  Object.assign(opts, redLesionThresholds(segResult));
  return opts;
}

/**
 * redLesionThresholds(segResult) -> { redFloor, grade3QuadMin, ... } or {}
 *
 * The thresholds that belong to the red-lesion model THIS RESULT came from.
 *
 * ── WHY THIS IS KEYED OFF THE RESULT AND NOT A CONSTANT ────────────────────
 * The rule engine's thresholds are properties of the segmenter, not of the
 * ICDR criteria: redFloor is a measured false-positive noise floor. v2 finds
 * roughly 2.6x more red lesions than v1, so running v2 counts through v1's
 * thresholds collapses referable specificity to 0.231 on IDRiD's test split --
 * 30 of 39 healthy eyes flagged. Nothing errors; the grades are just wrong.
 *
 * So the pairing is made automatic. segInfer reports which model produced the
 * counts (`redLesionModelVersion`), and the matching thresholds are attached
 * here, in the ONE function both grading engines already take their rule
 * options from. Flipping the model switch cannot leave stale thresholds
 * behind, and the MATLAB path and the JS fallback cannot end up on different
 * numbers -- the failure verify_fallback_parity.js exists to catch.
 *
 * Returns {} when the version is unknown or unlisted, which leaves
 * ruleEngineGrade on its own documented defaults rather than guessing.
 */
let RULE_THRESHOLDS = null;
function redLesionThresholds(segResult) {
  if (RULE_THRESHOLDS === null) {
    const p = path.join(__dirname, '..', 'ml-pipeline', 'models',
                        'rule_thresholds_by_red_version.json');
    try {
      RULE_THRESHOLDS = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      RULE_THRESHOLDS = {};
      console.warn('[gradingOrchestrator] could not read rule_thresholds_by_red_version.json '
        + `(${err.code || err.message}) -- the rule engine will use its built-in `
        + 'defaults, which are the v1 numbers');
    }
  }
  const v = segResult && segResult.redLesionModelVersion;
  const set = v && RULE_THRESHOLDS[v];
  if (!set) return {};
  const out = {};
  for (const k of ['redFloor', 'grade3QuadMin', 'moderateRedCount', 'brightFloor']) {
    if (Number.isFinite(set[k])) out[k] = set[k];
  }
  return out;
}

/**
 * buildCasePipelineInput(...) -- everything runCasePipeline.m needs for a case.
 *
 * This used to be buildMatlabExpr, which assembled ~60 MATLAB statements into
 * ONE line of source for `matlab -batch`. The logic now lives in
 * ml-pipeline/grading/runCasePipeline.m and this builds only its input, which
 * is why the MATLAB-quoting helpers -- and their two comments about needing a
 * semicolon after every `if` and `end` so the joined line still parsed -- are
 * gone with it.
 *
 * Paths go out with forward slashes: MATLAB accepts them on Windows, and it
 * keeps a backslash from ever having to survive a round trip through JSON.
 *
 * NOT passed any more: qualityScores. It was assigned into the old expression
 * and never read -- the preprocessing chain that once consumed it was removed
 * when Branch A moved to Python. It is still loaded and still used, by
 * isCaptureUngradable() on this side.
 */
function buildCasePipelineInput(imagePath, cameraDeviceId, caseIdForReport,
                                segResult, branchAGrade, gradcamMap, clinical) {
  const fwd = (v) => (v ? String(v).replace(/\\/g, '/') : '');
  const masks = (segResult && segResult.masks) || {};
  return {
    imagePath: fwd(imagePath),
    caseId: String(caseIdForReport),
    cameraDeviceId: cameraDeviceId || '',
    // Both null when segmentation did not run; the rule engine then refuses to
    // grade rather than grading an eye nothing looked at.
    redQ: quadCounts(segResult && segResult.redPerQuadrant),
    brightQ: quadCounts(segResult && segResult.brightPerQuadrant),
    // Backend plan §J: the vessel mask and the optic disc, both in ORIGINAL
    // image pixels (the same frame).
    vesselPath: fwd(masks.vessel),
    odXY: opticDiscXY(segResult && segResult.opticDisc),
    ruleOpts: caseRuleOpts(segResult),
    branchAGrade: Number.isInteger(branchAGrade) ? branchAGrade : null,
    // Task 7.1: the raw CAM plus the lesion and ROI masks at Branch A's 384
    // geometry, all pre-aligned. No crop geometry is re-derived on either side.
    camMap: camMatrix(gradcamMap),
    lesion384Path: fwd(masks.lesion384),
    roi384Path: fwd(masks.roi384),
    // Urgency-score inputs, or null. null makes runCasePipeline skip the score
    // outright rather than impute one -- see caseClinicalInputs.
    clinical: clinical || null,
  };
}

// -- Running it: the session first, a fresh MATLAB only if there is no session -
// The single largest cost in grading a case used to be the MATLAB start this
// call paid: about 20 s of the ~50 s per case, for work that takes seconds.
// The persistent session pays it once, at boot.
//
// Unlike Branch A (above), this DOES fall back to `matlab -batch` when the
// session is down. The reasoning differs because the stakes do: for Branch A a
// silent fallback would reintroduce the very per-case cost the session exists
// to remove, and hide that it had. Here the fallback is exactly the behaviour
// that shipped before this change, it is logged every time it happens, and the
// alternative is failing a case outright over a session that is restarting.
const CASE_PIPELINE_TIMEOUT_MS = parseInt(
  process.env.MATLAB_CASE_PIPELINE_TIMEOUT_MS || '120000', 10);

function casePipelineBatchExpr(inputPath) {
  const p = toMatlabStr;
  // MODELS_DIR is on the path deliberately: an ONNX-imported net also needs its
  // companion `+branchA_v1/` custom-layer package folder to be resolvable, and
  // without it a .mat loads "successfully" into a broken network that only
  // errors later, at predict().
  const dirs = [PREPROCESSING_DIR, GRADING_DIR, CALIBRATION_DIR, EXPLAINABILITY_DIR,
                CAMERA_CAL_DIR, SEGMENTATION_DIR, MODELS_DIR,
                path.join(ML_ROOT, 'inference')];
  return dirs.map((d) => `addpath('${p(d)}');`).join(' ')
    // jsonencodeAscii, not jsonencode: stdout on Windows is the ANSI code page,
    // which silently drops the em dashes the evidence text is full of. See
    // ml-pipeline/inference/jsonencodeAscii.m.
    + ` disp(jsonencodeAscii(runCasePipeline('${p(inputPath)}')));`;
}

/**
 * runCasePipelineMatlab(input, caseId, run) -> the parsed, §Q-normalised result.
 *
 * `run.via` is set to how it actually ran -- 'session' or 'batch' -- for the
 * case's engine provenance. Both are MATLAB; the difference is recorded
 * because a case that paid a cold `matlab -batch` start is worth being able
 * to find.
 */
async function runCasePipelineMatlab(input, caseId, run = {}) {
  const inputPath = path.join(os.tmpdir(),
    `case_pipeline_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(inputPath, JSON.stringify(input));
  try {
    if (matlabSession.alive()) {
      try {
        const viaSession = fromMatlabDeep(await matlabSession.call(
          { casePipeline: inputPath.replace(/\\/g, '/') },
          { timeoutMs: CASE_PIPELINE_TIMEOUT_MS, prefix: 'case' }));
        run.via = 'session';
        return viaSession;
      } catch (err) {
        console.warn(`[gradingOrchestrator] case ${caseId}: the MATLAB session could not `
          + `run the grading pipeline (${err.message}); falling back to matlab -batch, `
          + 'which costs this case about 20 s of MATLAB start-up');
      }
    }
    const raw = await spawnMatlabBatch(casePipelineBatchExpr(inputPath));
    run.via = 'batch';
    // MATLAB start-up text can precede the JSON on stdout.
    const jsonStart = raw.indexOf('{');
    if (jsonStart === -1) throw new Error(`No JSON in MATLAB output.\nRaw:\n${raw}`);
    try {
      // §Q: every [] MATLAB emits for "no value" becomes null right here, so no
      // field can reach Postgres as the array literal '{}'.
      return fromMatlabDeep(JSON.parse(raw.slice(jsonStart)));
    } catch (err) {
      throw new Error(`MATLAB JSON parse failed: ${err.message}\n`
        + `Raw: ${raw.slice(jsonStart, jsonStart + 300)}`);
    }
  } finally {
    fs.unlink(inputPath, () => {});   // best-effort; a leaked temp file is not worth failing the case over
  }
}

// ── Engine provenance (entry shape and rules: services/engineProvenance.js) ──
/**
 * buildEngineProvenance({ inferenceBackend, segResult, casePipelineVia })
 *   -> { classifier, segmentation, ruleEngine }
 *
 * segmentation is null when it did not run; each of its four models is
 * whatever segInfer reported in its `engines` block.
 */
function buildEngineProvenance({ inferenceBackend, segResult, casePipelineVia }) {
  const classifier = inferenceBackend === 'matlab'
    ? engineEntry('matlab', 'MATLAB session (branchAInferMatlab.m); input tensor '
      + 'preprocessed in Python (preprocessBranchATensor.py)')
    : engineEntry('python', 'branchAInfer.py (INFERENCE_BACKEND=python)');

  let segmentation = null;
  if (segResult) {
    const e = segResult.engines || {};
    segmentation = {
      vessel:       normaliseEngineEntry(e.vessel),
      localization: normaliseEngineEntry(e.localization),
      hardExudate:  normaliseEngineEntry(e.hardExudate),
      redLesion:    normaliseEngineEntry(e.redLesion),
    };
  }

  const ruleEngine = {
    session: engineEntry('matlab', 'runCasePipeline.m in the persistent MATLAB session'),
    batch: engineEntry('matlab', 'runCasePipeline.m via a fresh matlab -batch '
      + '(the session could not take the request)'),
    'js-fallback': engineEntry('js-fallback',
      'matlabFallback.js -- MATLAB not installed, MATLAB_ALLOW_FALLBACK=1', true),
  }[casePipelineVia] || null;

  return { classifier, segmentation, ruleEngine };
}

// buildCasePipelineInput is exported for testing: asserting on the INPUT it
// actually produces is a real check, whereas grepping this file's source is
// not -- a comment quoting an old field would fail such a grep while the
// generated input was perfectly correct.
module.exports = {
  processCase, assignTier, decideTier, buildCasePipelineInput, caseRuleOpts, readFoveaUnreliable,
  caseClinicalInputs,
  runBranchAInference, runBranchAInferenceMatlab, INFERENCE_BACKEND,
  isCaptureUngradable, hasClearedCameraSiteProbation, CAMERA_PROBATION_MIN_CASES,
  segment, buildEngineProvenance,
};
