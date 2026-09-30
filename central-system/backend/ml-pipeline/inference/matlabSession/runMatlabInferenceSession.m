function runMatlabInferenceSession()
% RUNMATLABINFERENCESESSION  Persistent MATLAB inference server (Part 2 of
% the MATLAB-backend latency fix -- see README.md in this folder).
%
% Loads the networks its configured backends need (see the load block
% below: the classifier when INFERENCE_BACKEND=matlab, M2-M4 when
% SEG_INFERENCE_BACKEND=matlab), then polls a request directory for
% work: each request names a Branch A tensor .mat (written by
% preprocessBranchATensor.py) plus an optional Grad-CAM output path; each
% response is the same JSON branchAInferMatlab.m always produced, written
% back under the matching request id.
%
%   matlab -batch "cd('<this dir>'); runMatlabInferenceSession()"
%
% Do not run this directly for real use -- manageMatlabSession.ps1 in this
% folder is the documented start/stop/status interface (background process,
% log redirection, PID tracking). This function itself never daemonizes; it
% blocks until told to stop and expects whatever launched it to have put it
% in the background.
%
% STOP: create a file named 'stop.flag' in this directory. Checked once per
% poll cycle (POLL_INTERVAL_SECONDS below), so shutdown happens within tens
% of milliseconds of the flag appearing. manageMatlabSession.ps1's `stop`
% command does this for you.
%
% ── WHY A FILE-BASED PROTOCOL AND NOT tcpserver ─────────────────────────────
% Simpler, needs no extra toolbox, and every step is inspectable with a
% directory listing -- a stuck request is a file sitting in requests/, not
% opaque socket state. Throughput is not the goal: one Branch A call at a
% time is the current load shape, and a poll interval measured in tens of
% milliseconds is well under the multi-second budget this whole exercise
% exists to protect (see the latency numbers in README.md).
%
% ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
% It does not preprocess images -- that still happens in a fresh Python
% process per call (preprocessBranchATensor.py), unchanged by this file.
% Only the MATLAB half of the round trip (network load + predict +
% calibration + Grad-CAM) becomes persistent here.
%
% It DOES serve three other request types, none of which need a network:
% segmentation forward passes (backend plan §S), the clinical-rationale PDF
% (§O), and the per-case grading pipeline (runCasePipeline.m). All three exist
% here for the same reason -- so they do not each pay a MATLAB start.

thisDir     = fileparts(mfilename('fullpath'));
requestDir  = fullfile(thisDir, 'requests');
responseDir = fullfile(thisDir, 'responses');
stopFlag    = fullfile(thisDir, 'stop.flag');
logFile     = fullfile(thisDir, 'session.log');
% Liveness signal for the Node-side supervisor (matlabSessionSupervisor.js,
% backend plan §E). Rewritten every HEARTBEAT_SECONDS from inside the poll
% loop, so a fresh heartbeat means "loaded AND still polling" -- a process that
% is alive but wedged stops refreshing it, which a PID check alone would miss.
% Only written once the loop starts, so it is absent while networks load.
heartbeatFile = fullfile(thisDir, 'session.heartbeat');
if isfile(heartbeatFile), delete(heartbeatFile); end

if ~isfolder(requestDir),  mkdir(requestDir);  end
if ~isfolder(responseDir), mkdir(responseDir); end
if isfile(stopFlag), delete(stopFlag); end   % stale flag from a previous run

mlRoot = fullfile(thisDir, '..', '..');
addpath(fullfile(thisDir, '..'));              % branchAInferMatlab.m lives in inference/
addpath(fullfile(mlRoot, 'calibration'));
addpath(fullfile(mlRoot, 'explainability'));
addpath(fullfile(mlRoot, 'preprocessing'));    % readFundusImage, for report images
addpath(fullfile(mlRoot, 'segmentation'));     % fundusQuadrants, for report labels
addpath(fullfile(mlRoot, 'grading'));          % runCasePipeline and the rule engine
addpath(fullfile(mlRoot, 'cameraCalibration'));% classifyCameraFamily, for Task 6.3
addpath(fullfile(mlRoot, 'models'));

% The ONNX converter must be on the path BEFORE any load(): without it the
% ONNX-imported networks deserialize into broken objects without an error.
if ~ensureOnnxSupportOnPath()
    logMsg(logFile, 'WARNING: ONNX converter support package not available');
end
% ── Load ONLY what the configured backends will ask this session for ──────
% Same env, same defaults as gradingOrchestrator.js / segInfer.py (the
% supervisor launches this session with the backend's environment):
%   INFERENCE_BACKEND=matlab     -> the classifier, which branchAInferMatlab.m
%                                   loads itself (warm-up below). The session
%                                   no longer loads its own branchA_v1 copy --
%                                   nothing ever served from it.
%   SEG_INFERENCE_BACKEND=matlab -> the SEG_SERVED nets (M2, M3, M4, and M5
%                                   v2 as of its ONNX->MATLAB import + parity
%                                   check). M5's old red_lesion_unet_v1 (the
%                                   2-class model v2's retrain replaced) is
%                                   not in SEG_SERVED and is never loaded.
% This changes what is resident, never which engine runs anything: a request
% for a model that is not loaded fails loudly (handleRequest), it is not
% quietly served some other way. `nets` staying a local variable of this
% function, alive for the whole loop below, is what keeps them resident.
classifierBackend = lower(strtrim(getenv('INFERENCE_BACKEND')));
if isempty(classifierBackend), classifierBackend = 'matlab'; end
segBackend = lower(strtrim(getenv('SEG_INFERENCE_BACKEND')));
if isempty(segBackend), segBackend = 'matlab'; end
netFiles = {};
if strcmp(segBackend, 'matlab'), netFiles = SEG_SERVED(); end
plusClassifier = '';
if strcmp(classifierBackend, 'matlab'), plusClassifier = ' + the classifier'; end
logMsg(logFile, sprintf(['session starting -- INFERENCE_BACKEND=%s, ' ...
    'SEG_INFERENCE_BACKEND=%s; loading %d segmentation network(s)%s'], ...
    classifierBackend, segBackend, numel(netFiles), plusClassifier));

modelsDir = fullfile(mlRoot, 'models');
nets = struct();
for i = 1:numel(netFiles)
    name = netFiles{i};
    loaded = load(fullfile(modelsDir, [name '.mat']), 'net');
    nets.(name) = loaded.net;
    logMsg(logFile, sprintf('  loaded %s', name));
end

% branchAInferMatlab.m keeps its OWN persistent net. Call it once now on a
% dummy tensor so the first REAL request doesn't pay that load cost -- only
% when the classifier actually runs here.
% SIZE FOLLOWS THE SELECTED MODEL, it is not 384. branchA_v1 is a 384 px
% network and the v2 family is 512, so a hardcoded 384 tensor fails the
% warm-up outright once BRANCH_A_MODEL_VERSION is a v2 tag -- non-fatal
% (the catch below logs and continues) but it silently costs the first real
% request the load it was meant to pay for. Asked of the same registry
% branchAInferMatlab.m uses, so the two cannot disagree.
if strcmp(classifierBackend, 'matlab')
    warmupTensor = fullfile(tempdir, 'matlab_session_warmup.mat');
    warmupSize = branchAInputSize();
    x = zeros(warmupSize, warmupSize, 3, 1, 'single'); %#ok<NASGU>
    display = zeros(warmupSize, warmupSize, 3, 'uint8'); %#ok<NASGU>
    save(warmupTensor, 'x', 'display');
    logMsg(logFile, sprintf('  warmup tensor %dx%d', warmupSize, warmupSize));
    try
        branchAInferMatlab(warmupTensor, '');
        logMsg(logFile, '  warmup inference call OK');
    catch ME
        logMsg(logFile, sprintf('  WARNING: warmup call failed: %s', ME.message));
    end
    delete(warmupTensor);
else
    logMsg(logFile, '  classifier not loaded (INFERENCE_BACKEND is not matlab)');
end

logMsg(logFile, 'session ready, polling for requests');

POLL_INTERVAL_SECONDS = 0.05;
HEARTBEAT_SECONDS     = 5;
beatClock = tic;
lastBeat  = -Inf;

while true
    if isfile(stopFlag)
        logMsg(logFile, 'stop.flag seen -- shutting down');
        delete(stopFlag);
        break;
    end

    if toc(beatClock) - lastBeat >= HEARTBEAT_SECONDS
        writeAtomic(heartbeatFile, char(datetime('now', 'TimeZone', 'UTC', ...
            'Format', 'yyyy-MM-dd''T''HH:mm:ss''Z''')));
        lastBeat = toc(beatClock);
    end

    reqFiles = dir(fullfile(requestDir, '*.json'));
    for i = 1:numel(reqFiles)
        reqPath = fullfile(reqFiles(i).folder, reqFiles(i).name);
        [~, reqId] = fileparts(reqFiles(i).name);
        handleRequest(reqPath, reqId, responseDir, logFile, nets);
    end

    pause(POLL_INTERVAL_SECONDS);
end

if isfile(heartbeatFile), delete(heartbeatFile); end
logMsg(logFile, 'session stopped');
end

% ── Local functions ─────────────────────────────────────────────────────────

function names = SEG_SERVED()
% Segmentation nets this session will run on request. red_lesion_unet_v1 (M5's
% old 2-class model, replaced by the 3-class retrain, backend plan §S.2) is
% deliberately excluded -- not loaded, not served, stays on the Python path
% permanently. red_lesion_unet_v2 (the deployed 3-class model) is served here
% since its ONNX->MATLAB import and parity check against the PyTorch
% checkpoint passed (training/parityCheckRedLesionV2.m).
names = {'vessel_unet_v1', 'localization_v1', 'bright_lesion_unet_v1', 'red_lesion_unet_v2'};
end

function handleRequest(reqPath, reqId, responseDir, logFile, nets)
respPath = fullfile(responseDir, [reqId '.json']);
t0 = tic;
try
    req = jsondecode(fileread(reqPath));

    % ── Segmentation forward pass (backend plan §S) ───────────────────────
    % {"model": "<net name>", "tensorPath": "<in .mat>", "outPath": "<out .mat>"}
    % Forward pass ONLY. segInfer.py keeps every pre- and post-processing
    % step (resize, padding, normalisation, thresholds, OD mask, counting,
    % quadrants), so there is exactly one copy of that logic and the MATLAB
    % and Python backends cannot drift apart on it. The tensor arrives HWCN
    % (MATLAB 'SSCB'); the raw network output goes back the same way.
    if isfield(req, 'model')
        name = char(req.model);
        if ~ismember(name, SEG_SERVED)
            error('runMatlabInferenceSession:model', ...
                  'Model "%s" is not served by this session (served: %s).', ...
                  name, strjoin(SEG_SERVED, ', '));
        end
        if ~isfield(nets, name)
            error('runMatlabInferenceSession:notLoaded', ...
                  ['Model "%s" is not loaded: this session was started with ' ...
                   'SEG_INFERENCE_BACKEND other than matlab.'], name);
        end
        td = load(req.tensorPath, 'x');
        y = predict(nets.(name), dlarray(single(td.x), 'SSCB'));
        y = gather(extractdata(y)); %#ok<NASGU>
        save(req.outPath, 'y', '-v7');
        writeAtomic(respPath, jsonencodeAscii(struct('ok', true, 'outPath', req.outPath)));
        logMsg(logFile, sprintf('  request %s OK %s (%.0f ms)', reqId, name, toc(t0) * 1000));
        delete(reqPath);
        return;
    end

    % ── Per-case grading pipeline ─────────────────────────────────────────
    % {"casePipeline": "<input .json>"} -- the rule engine, camera check, NV
    % score, lesion attention and evidence sentence for one case. This is the
    % single largest win the session offers: run as `matlab -batch` it paid a
    % ~20 s MATLAB start on EVERY case, which was most of the ~50 s a case
    % took. The work itself is seconds. See runCasePipeline.m.
    if isfield(req, 'casePipeline')
        out = runCasePipeline(char(req.casePipeline));
        writeAtomic(respPath, jsonencodeAscii(out));
        logMsg(logFile, sprintf('  request %s OK casePipeline (%.0f ms)', reqId, toc(t0) * 1000));
        delete(reqPath);
        return;
    end

    % ── Clinical-rationale PDF (backend plan §O) ──────────────────────────
    % {"report": "<input .json>", "outPath": "<.pdf>"} -- rendered here so a
    % report does not pay a ~20 s MATLAB start of its own.
    if isfield(req, 'report')
        generateReport(char(req.report), char(req.outPath));
        writeAtomic(respPath, jsonencodeAscii(struct('ok', true, 'outPath', req.outPath)));
        logMsg(logFile, sprintf('  request %s OK report (%.0f ms)', reqId, toc(t0) * 1000));
        delete(reqPath);
        return;
    end

    gradcamPath = '';
    if isfield(req, 'gradcamPath'), gradcamPath = req.gradcamPath; end

    out = branchAInferMatlab(req.tensorPath, gradcamPath);
    writeAtomic(respPath, jsonencodeAscii(out));   % ASCII-safe: see jsonencodeAscii.m
    logMsg(logFile, sprintf('  request %s OK (%.0f ms)', reqId, toc(t0) * 1000));
catch ME
    writeAtomic(respPath, jsonencodeAscii(struct('error', ME.message)));
    logMsg(logFile, sprintf('  request %s FAILED (%.0f ms): %s', reqId, toc(t0) * 1000, ME.message));
end
% Request file deleted LAST, after the response is written: the Node side
% polls for the RESPONSE file's existence only, so ordering here just keeps
% requests/ from accumulating -- it is not part of the handshake.
delete(reqPath);
end

function writeAtomic(finalPath, content)
% Write-then-rename: the Node side polls for finalPath's existence, so a
% response file it could read mid-write would be a real race. rename() on
% the same filesystem is atomic; a direct write is not.
tmpPath = [finalPath '.tmp'];
fid = fopen(tmpPath, 'w');
fwrite(fid, content);
fclose(fid);
movefile(tmpPath, finalPath);
end

function logMsg(logFile, msg)
line = sprintf('[%s] %s', datestr(now, 'yyyy-mm-dd HH:MM:SS'), msg);
disp(line);
fid = fopen(logFile, 'a');
fprintf(fid, '%s\n', line);
fclose(fid);
end

function sz = branchAInputSize()
% The selected Branch A model's input size, read from branchAInferMatlab.m's
% own version registry rather than duplicated here.
%
% Parsed from the source instead of being asked of the function, because
% branchAInferMatlab keeps the registry local to its body and exposes no
% accessor. Parsing is ugly but it has one virtue over a second copy of the
% numbers: when a new version is added there, this cannot silently disagree.
% Falls back to 384 (branchA_v1) if anything about the parse changes, and the
% warm-up is best-effort anyway -- its caller already tolerates failure.
sz = 384;
try
    version = getenv('BRANCH_A_MODEL_VERSION');
    if isempty(version), version = 'branchA_v2c'; end   % same default as that file
    src = fileread(fullfile(fileparts(mfilename('fullpath')), '..', ...
                            'branchAInferMatlab.m'));
    % Find this version's struct( ... ) and read its imgSize.
    pat = ['''' version ''''  '\s*,\s*struct\(.*?''imgSize''\s*,\s*(\d+)'];
    tok = regexp(src, pat, 'tokens', 'once');
    if ~isempty(tok)
        sz = str2double(tok{1});
    end
    if ~isfinite(sz) || sz < 32, sz = 384; end
catch
    sz = 384;
end
end
