'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pool = require('../db/pgClient');
const mediaPaths = require('./mediaPaths');
const mediaCrypto = require('./mediaCrypto');
const { fromMatlab, fromMatlabDeep } = require('./matlabInterop');
const matlabFallback = require('./matlabFallback');
const matlabSession = require('./matlabSessionClient');
const segSession = require('./segSessionClient');
const { cameraNotValidated: isCameraNotValidated } = require('./validatedCameras');
const { engineEntry, normaliseEngineEntry } = require('./engineProvenance');

const ALLOW_MATLAB_FALLBACK = process.env.MATLAB_ALLOW_FALLBACK === '1';

// ── Path constants ────────────────────────────────────────────────────────────
const ML_ROOT = path.resolve(__dirname, '..', 'ml-pipeline');
const PREPROCESSING_DIR = path.join(ML_ROOT, 'preprocessing');
const GRADING_DIR = path.join(ML_ROOT, 'grading');
const CALIBRATION_DIR = path.join(ML_ROOT, 'calibration');
const EXPLAINABILITY_DIR = path.join(ML_ROOT, 'explainability');

const CAMERA_CAL_DIR = path.join(ML_ROOT, 'cameraCalibration');

const SEGMENTATION_DIR = path.join(ML_ROOT, 'segmentation');
const MODELS_DIR = path.join(ML_ROOT, 'models');


const MODEL_VERSION_FALLBACK = 'unknown';
const MATLAB_EXE = process.env.MATLAB_EXECUTABLE || 'matlab';
const TIMEOUT_MS = parseInt(process.env.MATLAB_TIMEOUT_MS || '120000', 10);


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
const SEG_INFER = path.join(ML_ROOT, 'inference', 'segInfer.py');


const INFERENCE_BACKEND = (process.env.INFERENCE_BACKEND || 'matlab').toLowerCase();
if (!['python', 'matlab', 'remote'].includes(INFERENCE_BACKEND)) {
  throw new Error(`INFERENCE_BACKEND must be 'python', 'matlab', or 'remote', got '${INFERENCE_BACKEND}'`);
}
const ML_INFERENCE_SERVICE_URL = (process.env.ML_INFERENCE_SERVICE_URL || '').replace(/\/+$/, '');
if (INFERENCE_BACKEND === 'remote' && !ML_INFERENCE_SERVICE_URL) {
  throw new Error('INFERENCE_BACKEND=remote requires ML_INFERENCE_SERVICE_URL '
    + '(the deployed ml-inference-service base URL, e.g. an HF Space URL)');
}
const ML_INFERENCE_TIMEOUT_MS = parseInt(process.env.ML_INFERENCE_TIMEOUT_MS || '180000', 10);
const PREPROCESS_TENSOR = path.join(ML_ROOT, 'inference', 'preprocessBranchATensor.py');

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

const MATLAB_SESSION_TIMEOUT_MS = parseInt(process.env.MATLAB_SESSION_TIMEOUT_MS || '30000', 10);


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


async function runBranchAInferenceMatlab(imagePath, gradcamPath) {
  const tensorPath = await preprocessBranchATensor(imagePath);
  try {
    return await callMatlabSession(tensorPath, gradcamPath);
  } finally {
    fs.unlink(tensorPath, () => { });   // best-effort; a leaked temp file is not worth failing the case over
  }
}


async function postToInferenceService(urlPath, imagePath, extraFields = {}) {
  const buf = await fs.promises.readFile(imagePath);
  const form = new FormData();
  form.append('image', new Blob([buf]), path.basename(imagePath));
  for (const [key, val] of Object.entries(extraFields)) form.append(key, String(val));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ML_INFERENCE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${ML_INFERENCE_SERVICE_URL}${urlPath}`, {
      method: 'POST', body: form, signal: controller.signal,
    });
  } catch (err) {
    throw unavailable('ml_inference_service_unavailable',
      `Failed to reach ml-inference-service at ${ML_INFERENCE_SERVICE_URL}${urlPath}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`ml-inference-service ${urlPath} returned non-JSON (status ${res.status}): ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`ml-inference-service ${urlPath} returned ${res.status}: `
      + `${body.error || ''} ${(body.stderr || '').toString().slice(0, 300)}`);
  }
  return body;
}


async function runBranchAInferenceRemote(imagePath, gradcamPath) {
  const result = await postToInferenceService('/infer/branch-a', imagePath);
  if (gradcamPath && result.gradcamBase64) {
    await fs.promises.writeFile(gradcamPath, Buffer.from(result.gradcamBase64, 'base64'));
    result.gradcamPath = gradcamPath;
  } else {
    result.gradcamPath = null;
  }
  delete result.gradcamBase64;
  return result;
}


async function runSegInferenceRemote(imagePath, outdir) {
  let result;
  try {
    result = await postToInferenceService('/infer/segmentation', imagePath);
  } catch (err) {
    console.warn(`[gradingOrchestrator] remote segmentation failed: ${err.message}`);
    return null;
  }
  const masksBase64 = result.masksBase64 || {};
  const base = path.basename(imagePath, path.extname(imagePath));
  const masks = {};
  if (outdir) fs.mkdirSync(outdir, { recursive: true });
  for (const [name, b64] of Object.entries(masksBase64)) {
    if (!b64) continue;
    const maskPath = path.join(outdir, `${base}_${name}.png`);
    await fs.promises.writeFile(maskPath, Buffer.from(b64, 'base64'));
    masks[name] = maskPath;
  }
  result.masks = masks;
  delete result.masksBase64;
  return result;
}


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


async function segment(imagePath, outdir) {

  if (INFERENCE_BACKEND === 'remote') {
    return runSegInferenceRemote(imagePath, outdir);
  }
  if (segSession.alive()) {
    const viaWorker = await runSegInferenceSession(imagePath, outdir);
    if (viaWorker) return viaWorker;
  }
  return runSegInference(imagePath, outdir);
}


const SCORE_FIELDS = ['focusScore', 'illuminationScore', 'fovScore',
  'coveragePercent', 'glareScore', 'motionScore',
  'occlusionScore'];


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
 */
function assignTier(confidence, branchAgreement) {
  if (branchAgreement === false) return 'C';
  if (confidence > 0.9) return 'A';
  if (confidence >= 0.6) return 'B';
  return 'C';
}


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


  if (tier === 'A' && cameraProbationOverride) {
    tier = 'B';
    tierReason = `camera family mismatch on a camera/site with fewer than `
      + `${CAMERA_PROBATION_MIN_CASES} prior graded cases — not yet enough `
      + 'of a track record to auto-clear';
  }

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

  if (tier === 'A' && cameraNotValidated === true) {
    tier = 'B';
    tierReason = 'unvalidated_camera: this camera/site has not been validated '
      + 'against known-correct grades, and referable sensitivity is measurably '
      + 'lower on unfamiliar cameras — not auto-cleared';
  }
  return { tier, tierReason };
}


const QUALITY_RETAKE_THRESHOLDS = {
  minCoveragePercent: 0.5,   // qualityGateMain.m: fov.coveragePercent < 0.5
  maxGlareScore: 0.3,   // qualityGateMain.m: glareScore > 0.3
  maxMotionScore: 0.3,   // qualityGateMain.m: motionScore > 0.3
  illuminationThreshold: 0.4,   // cameraPresets.json 'default'.illuminationThreshold
  focusThreshold: 0.17,  // cameraPresets.json 'default'.focusThreshold
  maxOcclusionScore: 0.18,  // qualityGateMain.m: occlusionScore > 0.18
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

  const caseRow = caseRes.rows[0];
  // The readable copy from processCase; the stored path itself when the file
  // is not encrypted.
  const imagePath = plainImagePath || caseRow.image_path;
  if (!imagePath)
    throw new Error(`processCase: case '${caseId}' has no image_path`);


  const gradcamPath = mediaPaths.gradcamPath(caseId);   // creates the dir too


  const qualityScores = caseRow.quality_scores || null;

  const cameraDeviceId = caseRow.camera_device_id || '';

  const runBranchA = INFERENCE_BACKEND === 'matlab'
    ? runBranchAInferenceMatlab
    : INFERENCE_BACKEND === 'remote'
      ? runBranchAInferenceRemote
      : runBranchAInference;

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

  if (branchA.gradcamWarning) {
    console.warn(`[gradingOrchestrator] case ${caseId}: ${branchA.gradcamWarning}`);
  }


  const ruleEngineGrade = fromMatlab(mlResult.ruleEngineGrade);
  const branchAgreement = fromMatlab(mlResult.branchAgreement);


  const grade0Vs1Disagreement = branchAgreement === false
    && grade === 0 && Number.isInteger(ruleEngineGrade) && ruleEngineGrade >= 1;
  if (grade0Vs1Disagreement) {
    console.log(`[gradingOrchestrator] case ${caseId}: grade0Vs1Disagreement — `
      + `CNN said 0, rule engine (M5-fed) said ${ruleEngineGrade} — routed to Tier C, `
      + 'grade NOT auto-corrected (see investigateM5Grade1.py)');
  }


  const cameraCheck = readCameraCheck(mlResult);
  const cameraProbationOverride = mlResult.cameraMismatch === true
    && !cameraSiteProbationCleared;
  if (mlResult.cameraMismatch) {
    console.warn(`[gradingOrchestrator] case ${caseId}: camera family mismatch — `
      + `reported '${cameraDeviceId}', image looks like '${mlResult.cameraFamily}'`
      + (cameraSiteProbationCleared ? '' : ' (camera/site still on probation)'));
  }

  const qualityForced = isCaptureUngradable(qualityScores);


  const foveaUnreliable = readFoveaUnreliable(segResult);

  const detectedLaterality = { L: 'left', R: 'right' }[
    String(fromMatlab(mlResult.imageLaterality) || '').toUpperCase()] || null;
  const reportedLaterality = caseRow.eye_laterality_reported || null;
  const lateralityMismatch = !!(detectedLaterality && reportedLaterality
    && detectedLaterality !== reportedLaterality);
  if (lateralityMismatch) {
    console.warn(`[gradingOrchestrator] case ${caseId}: eye laterality mismatch — `
      + `technician said ${reportedLaterality}, the DICOM file says ${detectedLaterality}`);
  }



  const beyondRuleEngine =
    mlResult.ruleIsLowerBound === true &&
    Number.isInteger(fromMatlab(mlResult.ruleMaxGrade)) &&
    grade > fromMatlab(mlResult.ruleMaxGrade);

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


  const uncertaintyScore = fromMatlab(branchA.uncertaintyScore);


  const modelVersion = (typeof branchA.modelVersion === 'string'
    && branchA.modelVersion.trim())
    ? branchA.modelVersion.trim()
    : MODEL_VERSION_FALLBACK;

  await assertModelRegistered(modelVersion);

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

    fromMatlab(mlResult.lesionAttentionConsistency),
    fromMatlab(mlResult.lesionAttentionChanceLevel),
    fromMatlab(mlResult.lesionAttentionEnrichment),

    typeof mlResult.lesionAttentionFlagged === 'boolean'
      ? mlResult.lesionAttentionFlagged : null]);

  if (segResult) {
    const masks = segResult.masks || {};


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

        procedure: segResult.countingProcedure ?? null,


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




  await pool.query(

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


function blankToNull(v) {
  if (typeof v !== 'string') return v ?? null;
  const t = v.trim();
  return t === '' ? null : t;
}

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


const HBA1C_FROM_BUCKET = { good: 6.2, moderate: 7.5, poor: 9.5 };
const YEARS_FROM_BUCKET = { lt1: 0.5, '1to5': 3, '5to10': 7.5, gt10: 15 };

function caseClinicalInputs(patientAge, questionnaire) {
  const age = Number(patientAge);
  if (!Number.isFinite(age) || age < 1 || age > 120) return null;

  const rf = (questionnaire && questionnaire.riskFactors) || {};
  const provenance = { patientAge: 'measured' };


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

const CASE_PIPELINE_TIMEOUT_MS = parseInt(
  process.env.MATLAB_CASE_PIPELINE_TIMEOUT_MS || '120000', 10);

function casePipelineBatchExpr(inputPath) {
  const p = toMatlabStr;

  const dirs = [PREPROCESSING_DIR, GRADING_DIR, CALIBRATION_DIR, EXPLAINABILITY_DIR,
    CAMERA_CAL_DIR, SEGMENTATION_DIR, MODELS_DIR,
    path.join(ML_ROOT, 'inference')];
  return dirs.map((d) => `addpath('${p(d)}');`).join(' ')

    + ` disp(jsonencodeAscii(runCasePipeline('${p(inputPath)}')));`;
}


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
    fs.unlink(inputPath, () => { });   // best-effort; a leaked temp file is not worth failing the case over
  }
}


function buildEngineProvenance({ inferenceBackend, segResult, casePipelineVia }) {

  const classifier = inferenceBackend === 'matlab'
    ? engineEntry('matlab', 'MATLAB session (branchAInferMatlab.m); input tensor '
      + 'preprocessed in Python (preprocessBranchATensor.py)')
    : engineEntry('python', 'branchAInfer.py (INFERENCE_BACKEND=python)');

  let segmentation = null;
  if (segResult) {
    const e = segResult.engines || {};
    segmentation = {
      vessel: normaliseEngineEntry(e.vessel),
      localization: normaliseEngineEntry(e.localization),
      hardExudate: normaliseEngineEntry(e.hardExudate),
      redLesion: normaliseEngineEntry(e.redLesion),
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

module.exports = {
  processCase, assignTier, decideTier, buildCasePipelineInput, caseRuleOpts, readFoveaUnreliable,
  caseClinicalInputs,
  runBranchAInference, runBranchAInferenceMatlab, runBranchAInferenceRemote, INFERENCE_BACKEND,
  isCaptureUngradable, hasClearedCameraSiteProbation, CAMERA_PROBATION_MIN_CASES,
  segment, buildEngineProvenance,
};
