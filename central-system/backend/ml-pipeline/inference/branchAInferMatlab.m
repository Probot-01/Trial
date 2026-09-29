function out = branchAInferMatlab(tensorPath, gradcamPath)
% BRANCHAINFERMATLAB  Branch A inference via the imported MATLAB dlnetwork
% (models/branchA_v1.mat or models/branchA_v2a.mat, ONNX-imported from the
% matching PyTorch checkpoint branchAInfer.py serves), given an
% ALREADY-PREPROCESSED tensor.
%
%   out = branchAInferMatlab(tensorPath)
%   out = branchAInferMatlab(tensorPath, gradcamPath)
%
% Mirrors branchAInfer.py's JSON contract field-for-field (see that file's
% docstring) so gradingOrchestrator.js's calling/parsing code does not change
% -- only which backend it shells out to (INFERENCE_BACKEND=matlab|python).
%
% ── BRANCH_A_MODEL_VERSION=branchA_v1|branchA_v2a (v2a integration, GATE 4) ─
% Env var, default branchA_v1 (see versionCfg below). Selects the .mat, the
% calibration file (NEVER calibration_v1.json for v2a -- a different
% filename, plus an explicit modelVersion-field guard), the tensor size used
% only for the initialize() fallback, and the modelVersion/imgSize/
% preprocessing fields in the returned struct. tensorPath's own tensor size
% must already match the selected version -- that is
% preprocessBranchATensor.py's job (it reads ckpt["img_size"] from whichever
% checkpoint BRANCH_A_MODEL_VERSION resolves to Python-side), not this
% function's.
%
% ── CONTRACT CHANGE (2026-09-19): NO IMAGE PREPROCESSING HAPPENS HERE ──────
% This function used to do its own preprocessing via preprocessForBranchA.m /
% preprocessModel1.m -- a hand-maintained MATLAB PORT of the Python
% ben_graham chain. That port had a real, measured residual (SSIM 0.981, not
% 1.0 -- preprocessModel1.m's own header) that was small in pixel terms but
% large enough to flip the predicted grade on 1/10 and the conformal tier on
% 2/10 real images, even though the imported network matched Python to 2e-6
% given IDENTICAL input (training/parityCheck.m). The fix is not a tighter
% port. It is not maintaining a second implementation at all:
%
%   tensorPath is a .mat written by ml-pipeline/inference/
%   preprocessBranchATensor.py, which calls branchAInfer.preprocess() --
%   the EXACT function branchAInfer.py's own Python inference path uses for
%   every image. This function's job is to load that tensor and call
%   predict(). Preprocessing exists in exactly one place in this codebase
%   now: preprocess() in branchAInfer.py.
%
% tensorPath's .mat contains:
%   x        (384,384,3,1) single, SSCB layout, ImageNet-normalized --
%            handed to dlarray(x,'SSCB') and predict() with no further
%            transformation.
%   display  (384,384,3) uint8, ben_graham-enhanced RGB, the SAME pixels x
%            was computed from one step before normalization -- Grad-CAM's
%            overlay background (must be the ENHANCED image, i.e. what the
%            network actually saw, not the plain crop -- see
%            preprocessBranchATensor.py's docstring).
%
% ── WHY THIS EXISTS ALONGSIDE branchAInfer.py, NOT INSTEAD OF IT ────────────
% branchAInfer.py's own header explains why Branch A ran in Python in the
% first place: MATLAB's DIRECT PyTorch converter (importNetworkFromPyTorch)
% imported this exact architecture wrong -- 8-11% class agreement, -0.25
% correlation against the model's own published logits, despite importing
% "structurally fine" (see testImportedNetwork.m). That failure does NOT
% apply here: this .mat came from a DIFFERENT path (torch.onnx.export ->
% importNetworkFromONNX), independently verified against the same PyTorch
% model on 10 real IDRiD images at max|diff| ~2e-6 (post-softmax) -- see
% training/parityCheck.m.
%
% ── RAW LOGITS, NOT THE NET'S OWN OUTPUT ────────────────────────────────────
% The saved `net` has a terminal softmax baked in (the handoff contract
% requires it, for classifyBranchA.m's direct callers). Temperature scaling
% needs to divide LOGITS by T before softmax, so this function reaches past
% that terminal layer with predict(net, X, 'Outputs', 'x_head_Gemm') to get
% the pre-softmax Gemm output, then applies temperature + softmax itself --
% the same two-step branchAInfer.py does. argmax is invariant to both
% monotonic transforms, so the predicted grade does not depend on this choice;
% the calibrated confidence and conformal tier do.
%
% ── uncertaintyScore: COMPUTED HERE SINCE 2026-09-29 ────────────────────────
% This block used to record a deliberate gap: forward() on this imported
% network returns a bit-identical default output across repeated calls, so
% MC-dropout could not be run through it and uncertaintyScore was reported as
% null with a reason.
%
% The gap was in the approach, not the network. Dropout is a Bernoulli mask
% and a scale; what has to come from the network is the features and the
% head's weights, and both are readable. inference/mcDropoutMatlab.m resamples
% the mask and the head over features the trunk produced once -- no stochastic
% forward() required -- and reproduces the statistic mcDropout.py reports.
% Read that file before changing it: it follows PyTorch's dropout POSITION
% (before the head) rather than this graph's (after it), and in eval mode the
% two are indistinguishable.
% This does not affect drGradeCnn, confidenceScore, referable, or
% conformalTier, which is what tiering and the DB write actually consume.
% (gradcamWarning is still not produced here: it reports attention falling
% outside the retina, which needs the retinal mask that this function -- which
% never touches a raw image -- does not have.)
%
% gradcamMap WAS listed here as moot, on the reasoning that gradCam.m "only
% ever returned a finished PNG". That was true of gradCam.m's signature and
% false about the system: branchAInfer.py returns the raw map, and Task 7.1's
% lesion-attention score is computed from it, so the claim held only until
% someone checked whether anything consumed it. gradCam.m now returns the raw
% map as an optional second output and it is passed through below.

if nargin < 2, gradcamPath = ''; end

thisDir = fileparts(mfilename('fullpath'));
mlRoot  = fullfile(thisDir, '..');
% preprocessing/, grading/, cameraCalibration/ are NOT needed here any more --
% this function never touches a raw image.
addpath(fullfile(mlRoot, 'calibration'));
addpath(fullfile(mlRoot, 'explainability'));
addpath(fullfile(mlRoot, 'models'));

% ── BRANCH_A_MODEL_VERSION switch (v2a integration, GATE 4) ─────────────────
% Style matches INFERENCE_BACKEND: an env var read once per call, default
% stays the currently-deployed model. Whatever spawns this MATLAB process
% (or the shell, for a direct/manual run) sets it; nothing here needs
% gradingOrchestrator.js to name it explicitly, the same way INFERENCE_
% BACKEND already reaches this process without this file naming it either.
% DEFAULT CHANGE (v2c integration, 2026-09-21): branchA_v2c passed every
% gate (ONNX/MATLAB parity, revised cross-fit guards, calibrated end-to-end
% agreement with the Python backend) and is now the deployed default,
% replacing branchA_v1. ROLLBACK: set BRANCH_A_MODEL_VERSION=branchA_v1 in
% the environment (or spawning process) to restore the previous model with
% no code change -- every v1 code path in this file is untouched and still
% fully supported.
BRANCH_A_MODEL_VERSION = getenv('BRANCH_A_MODEL_VERSION');
if isempty(BRANCH_A_MODEL_VERSION), BRANCH_A_MODEL_VERSION = 'branchA_v2c'; end

versionCfg = struct( ...
    'branchA_v1', struct( ...
        'matFile',       'branchA_v1.mat', ...
        'calibFile',     'calibration_v1.json', ...
        'imgSize',       384, ...
        'preprocessing', ['branchAInfer.preprocess() (Python) via preprocessBranchATensor.py -- ' ...
                          'ben_graham 384, ImageNet norm, no CLAHE']), ...
    'branchA_v2a', struct( ...
        'matFile',       'branchA_v2a.mat', ...
        'calibFile',     'calibration_branchA_v2a.json', ...
        'imgSize',       512, ...
        'preprocessing', ['branchAInfer.preprocess() (Python) via preprocessBranchATensor.py -- ' ...
                          'ben_graham 512, ImageNet norm, 5-class head only (binary head dropped ' ...
                          'at export)']), ...
    'branchA_v2b', struct( ...
        'matFile',       'branchA_v2b.mat', ...
        'calibFile',     'calibration_branchA_v2b.json', ...
        'imgSize',       512, ...
        'preprocessing', ['branchAInfer.preprocess() (Python) via preprocessBranchATensor.py -- ' ...
                          'ben_graham 512, ImageNet norm, 5-class head only (binary head dropped ' ...
                          'at export)']), ...
    'branchA_v2c', struct( ...
        'matFile',       'branchA_v2c.mat', ...
        'calibFile',     'calibration_branchA_v2c.json', ...
        'imgSize',       512, ...
        'preprocessing', ['branchAInfer.preprocess() (Python) via preprocessBranchATensor.py -- ' ...
                          'ben_graham 512, ImageNet norm, 5-class head only (binary head dropped ' ...
                          'at export)']) ...
);
% GENERALIZE (v2b integration): versionCfg is this file's own registry, keyed
% by exactly the tags below -- a later tag (branchA_v2c) needs one new field
% here, nothing else in this function changes.
if ~isfield(versionCfg, BRANCH_A_MODEL_VERSION)
    error('branchAInferMatlab:badVersion', ...
          'BRANCH_A_MODEL_VERSION must be one of {%s}, got ''%s''.', ...
          strjoin(fieldnames(versionCfg), ', '), BRANCH_A_MODEL_VERSION);
end
cfg = versionCfg.(BRANCH_A_MODEL_VERSION);

% NEVER calibration_v1.json for a non-v1 version: this is a different FILE
% (cfg.calibFile), not a shared file with a version field checked after the
% fact, so a v2a run cannot find v1's calibration even by accident (see the
% MODEL-VERSION GUARD below for the second, explicit line of defence).
modelPath = fullfile(mlRoot, 'models', cfg.matFile);
calibPath = fullfile(mlRoot, 'models', cfg.calibFile);

% persistent, like classifyBranchA.m: safe whether this runs as a fresh
% -batch process per call or inside the persistent session (matlabSession/
% runMatlabInferenceSession.m), which calls this same function repeatedly
% without exiting MATLAB between requests. Keyed by VERSION too -- a
% persistent-session process that switches BRANCH_A_MODEL_VERSION between
% requests must reload, not keep serving whichever model happened to load
% first (this is exactly the switch-back-to-v1-and-confirm-old-behaviour
% case the v2a integration's own end-to-end check exercises).
persistent net netVersion
if isempty(net) || ~strcmp(netVersion, BRANCH_A_MODEL_VERSION)
    % The ONNX converter's layer classes must be reachable BEFORE this load.
    % Without them load() SUCCEEDS, substituting placeholder layers, and the
    % net then dies inside initialize/predict with "Undefined function
    % 'getExecutableNetwork'" -- an internal name that mentions no support
    % package and reads exactly like a corrupt model file. The conclusion
    % nearly reached was to regenerate a .mat that turned out to be perfectly
    % good (Initialized = 1, 242 layers, predicts correctly once the path is
    % right).
    %
    % runMatlabInferenceSession guards its own startup the same way, which is
    % precisely why this hid for so long: the long-running session was immune
    % and every cold MATLAB -- including any compiled build -- was not. The
    % guard belongs HERE too, next to the load it protects, so every caller
    % is covered rather than only the one that remembered.
    %
    % Refused, not warned: a placeholder network does not fail safely, it
    % fails confusingly several calls later.
    if ~ensureOnnxSupportOnPath()
        error('branchAInferMatlab:noOnnxSupport', ...
            ['The Deep Learning Toolbox Converter for ONNX Model Format is ' ...
             'not on the path, so %s cannot be loaded correctly. Install it ' ...
             'from the Add-On Explorer.'], modelPath);
    end
    loaded = load(modelPath, 'net');
    net = loaded.net;
    if isa(net, 'dlnetwork') && ~net.Initialized
        sz = cfg.imgSize;
        net = initialize(net, dlarray(zeros(sz, sz, 3, 1, 'single'), 'SSCB'));
    end
    netVersion = BRANCH_A_MODEL_VERSION;
end

td = load(tensorPath, 'x', 'display');
X = dlarray(single(td.x), 'SSCB');

% Both outputs in ONE forward pass: the head's logits for the point estimate,
% and the features feeding that head for MC-dropout below. Asking for them
% separately would run the whole convolutional trunk twice per case for a
% result that is identical the second time.
[featsD, logitsD] = predict(net, X, 'Outputs', {'x_backbone_global__2', 'x_head_Gemm'});
logits  = reshape(double(extractdata(logitsD)), 1, []);
mcFeats = extractdata(featsD);

EXPECTED_METHOD = 'ordinal_mode_interval_stratified_v3';
[~, calibFileName, calibFileExt] = fileparts(calibPath);
calibFileName = [calibFileName calibFileExt];

calibrated = false;
calibrationWarning = '';
temperature = 1.0;
calib = struct();
if isfile(calibPath)
    calib = jsondecode(fileread(calibPath));

    % METHOD GUARD (2026-09-20): refuse anything that is not THIS score/set
    % construction, rather than silently falling back to whatever fields
    % happen to be present. A legacy marginal-LAC file (or the archived
    % calibration_v1_marginal_lac_ARCHIVE.json) has no qhatPerClass at all --
    % applying it would either crash conformalTiering or, worse, be patched
    % around into re-reading the old scalar qhat, which is exactly the
    % silent-fallback this guard exists to prevent. Unlike the trainedImgSize
    % check below, a MISSING method field is treated as a mismatch, not as
    % "legacy and unverifiable" -- there is no prior schema this code knows
    % how to run against.
    gotMethod = '';
    if isfield(calib, 'method'), gotMethod = calib.method; end

    % VERSION GUARD (2026-09-19): refuse a calibration fitted for a
    % differently-shaped model instead of silently applying it -- the exact
    % mistake of deploying a v2 model (different resolution) with v1's
    % calibration still in calibration_v1.json. The network's OWN input-layer
    % size is the ground truth here (not a hardcoded 384), so this stays
    % correct automatically whatever .mat is actually loaded. Mirrors the
    % same guard in branchAInfer.py's load_calibration() -- both backends
    % read this file independently and must agree on when to trust it.
    netImgSize = net.Layers(1).InputSize(1);
    trainedSize = [];
    if isfield(calib, 'trainedImgSize'), trainedSize = calib.trainedImgSize; end

    % MODEL-VERSION GUARD (v2a integration, GATE 4): the file must also
    % declare modelVersion == BRANCH_A_MODEL_VERSION. calibPath already
    % points at a version-specific filename (never calibration_v1.json for
    % a non-v1 version), so this is a second, explicit check -- belt and
    % braces, not redundant: a copy-pasted file with the right name but a
    % stale modelVersion field inside it must still be refused. Mirrors the
    % same guard in branchAInfer.py's load_calibration().
    gotVersion = '';
    if isfield(calib, 'modelVersion'), gotVersion = calib.modelVersion; end

    if ~strcmp(gotMethod, EXPECTED_METHOD)
        calibrationWarning = sprintf(...
            ['%s has method=''%s'' but this code requires ''%s'' -- REFUSING to ' ...
             'apply it (a different method''s thresholds mean nothing here). Re-run ' ...
             'calibrateBranchA.m and overwrite %s before deploying it. Confidences ' ...
             'are UNCALIBRATED.'], ...
            calibFileName, gotMethod, EXPECTED_METHOD, calibFileName);
    elseif ~strcmp(gotVersion, BRANCH_A_MODEL_VERSION)
        calibrationWarning = sprintf(...
            ['%s has modelVersion=''%s'' but BRANCH_A_MODEL_VERSION=''%s'' -- ' ...
             'REFUSING to apply it. A calibration fitted for a different model ' ...
             'version must NEVER be applied here, even if method and trainedImgSize ' ...
             'happen to match. Confidences are UNCALIBRATED.'], ...
            calibFileName, gotVersion, BRANCH_A_MODEL_VERSION);
    elseif ~isempty(trainedSize) && trainedSize ~= netImgSize
        calibrationWarning = sprintf(...
            ['%s was fitted for trainedImgSize=%d but the loaded network''s input ' ...
             'is %dx%d -- REFUSING to apply this calibration (qhatPerStratum/' ...
             'temperature from a different model mean nothing here). Re-run ' ...
             'calibrateBranchA.m against THIS model''s predictions and overwrite ' ...
             '%s before deploying it. Confidences are UNCALIBRATED.'], ...
            calibFileName, trainedSize, netImgSize, netImgSize, calibFileName);
    else
        temperature = calib.temperature;
        calibrated = true;
    end
else
    calibrationWarning = sprintf(...
        '%s missing; run calibrateBranchA.m for %s. Confidences are UNCALIBRATED.', ...
        calibFileName, BRANCH_A_MODEL_VERSION);
end

rawProbs = softmaxRow(logits);
calProbs = softmaxRow(logits ./ temperature);

% ── Task 6.1: epistemic uncertainty (inference/mcDropoutMatlab.m) ──────────
% This used to be hardcoded null with a note that MC-dropout was not
% implemented here, because forward() on this imported network is
% deterministic. It does not need to be stochastic: dropout is a Bernoulli
% mask and a scale, and the features and the head's weights are both readable,
% so the mask and the head are resampled by hand over features the trunk
% produced once. See that file for why it follows PyTorch's dropout POSITION
% rather than this graph's.
%
% Caught, not thrown: uncertainty is a queue-ordering signal, and a case that
% grades correctly must not fail because its uncertainty could not be
% measured. The score stays empty and the reason travels with it.
mc = struct('score', [], 'detail', [], 'err', []);
try
    mcOut = mcDropoutMatlab(net, X, struct('temperature', temperature, 'features', mcFeats));
    mc.score  = mcOut.uncertaintyScore;
    mc.detail = mcOut;
catch mcErr
    mc.err = mcErr.message;
end

[confidence, gradeIdx] = max(calProbs);
grade = gradeIdx - 1;

% Live referable flag (conformal policy v3): P(g>=2) clearing the fitted
% referableThreshold (targets ~95% referable sensitivity on its own,
% independent of the conformal set/tier), OR the grade-3/grade-4 safety
% check (P(g3)+P(g4) > 0.5). The safety-check term does not require
% calibration; the referableThreshold term does -- absent calibration, only
% the safety check can fire, which is intentional: referable must never
% look MORE confident than the model's calibration state actually supports.
pReferable = sum(calProbs(3:5));
p34 = sum(calProbs(4:5));
referable = (p34 > 0.5) || (calibrated && isfield(calib, 'referableThreshold') ...
    && pReferable >= calib.referableThreshold);

tier = '';
predictionSet = [];
tierReason = '';
predictionSetLow = [];
predictionSetHigh = [];
predictionSetContiguous = [];
if calibrated
    [tier, details] = conformalTiering(calProbs, calib);
    predictionSet = details.predictionSet;
    tierReason = details.reason;
    predictionSetLow = details.low;
    predictionSetHigh = details.high;
    predictionSetContiguous = details.contiguous;
end

out = struct( ...
    'drGradeCnn',              grade, ...
    'confidenceScore',         confidence, ...
    'calibratedProbabilities', calProbs, ...
    'rawProbabilities',        rawProbs, ...
    'logits',                  logits, ...
    'referable',               referable, ...
    'conformalTier',           tier, ...
    'predictionSet',           predictionSet, ...
    'predictionSetLow',        predictionSetLow, ...
    'predictionSetHigh',       predictionSetHigh, ...
    'predictionSetContiguous', predictionSetContiguous, ...
    'tierReason',              tierReason, ...
    'temperature',             temperature, ...
    'calibrated',              calibrated, ...
    'modelVersion',            BRANCH_A_MODEL_VERSION, ...
    'imgSize',                 cfg.imgSize, ...
    'preprocessing',           cfg.preprocessing, ...
    'backend',                 'matlab', ...
    'uncertaintyScore',        mc.score, ...
    'uncertaintyDetail',       mc.detail, ...
    'uncertaintyError',        mc.err ...
);
if ~isempty(calibrationWarning)
    out.calibrationWarning = calibrationWarning;
end

if ~isempty(gradcamPath)
    try
        [~, camMap] = gradCam(net, td.display, gradeIdx, gradcamPath);
        out.gradcamPath = gradcamPath;
        % The RAW map as well as the PNG. Without it the MATLAB backend was
        % silently dropping Task 7.1: gradingOrchestrator passes
        % branchA.gradcamMap through as camMap, runCasePipeline.m skips
        % lesionAttentionConsistency when that is empty, and the score reached
        % the database as NULL on every case graded on this backend -- while
        % the same case on the Python backend got a number. Nothing errored.
        out.gradcamMap = camMap;
    catch ME
        % Field left UNSET here, not set to [] -- jsonencode renders [] as
        % JSON [], which `branchA.gradcamPath ?? null` in gradingOrchestrator.js
        % would NOT convert to null ([] is not nullish). An absent key
        % round-trips through JSON.parse as `undefined`, which `?? null` does
        % catch. See the matching uncertaintyScore fix in gradingOrchestrator.js.
        out.gradcamError = ME.message;
    end
end
end

function p = softmaxRow(z)
z = z - max(z);
e = exp(z);
p = e ./ sum(e);
end
