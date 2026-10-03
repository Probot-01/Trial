function buildDeployableResourceModel(outPath)
% BUILDDEPLOYABLERESOURCEMODEL  Construct districtResourceModel.slx.
%
%   buildDeployableResourceModel()
%   buildDeployableResourceModel(outPath)
%
%   The Simulink Compiler deployable version of the district resource model
%   (PS requirement 5). Same reasoning as buildDistrictScreeningModel.m: the
%   script is the reviewable source of truth, the .slx is a build artifact.
%
%   WHY A SECOND MODEL
%     Simulink Compiler runs a deployed model in Rapid Accelerator, which
%     needs C code from every block. SimEvents blocks cannot generate code
%     (SimulinkEventEngine:Engine:CodeGenNotSupported, verified 2026-10-03),
%     so districtScreeningSimEvents.slx cannot be deployed. This model uses
%     only code-generation-capable blocks around DistrictScreeningEngine (a
%     MATLAB System block), and reproduces referenceQueueingModel.m exactly
%     for the same parameters and seed (validateDeployableResourceModel).
%
%   STRUCTURE
%
%     Clock (60 s) ─▶ District Screening Engine ─┬─▶ arrived / uploaded / autoCleared
%                     (MATLAB System block)       ├─▶ queueB / queueC
%                                                 ├─▶ reviewersBusy ─▶ ÷ NumOphthalmologists ─▶ reviewerUtil
%                                                 ├─▶ reviewed
%                                                 ├─▶ summary (13 values, filled at the horizon)
%                                                 └─▶ done ─▶ Stop Simulation
%
%   Every parameter is a model-workspace variable referenced by the engine
%   block, and the model's default parameter behaviour is Tunable, so a
%   deployed app changes any of them with SimulationInput.setVariable and
%   no rebuild. StopTime is inf: the engine stops the run itself once the
%   horizon is reached and the review queues have drained.

thisDir = fileparts(mfilename('fullpath'));
if nargin < 1 || isempty(outPath)
    outPath = fullfile(thisDir, 'districtResourceModel.slx');
end
addpath(thisDir);
addpath(fileparts(thisDir));   % referenceQueueingModel.m, for the defaults

modelName = 'districtResourceModel';
if bdIsLoaded(modelName), close_system(modelName, 0); end
if isfile(outPath), delete(outPath); end

p = referenceQueueingModel('defaults');
STEP = 60;   % seconds of simulated time per step

new_system(modelName, 'Model');
try
    m = modelName;

    % ── Parameters: model workspace, one variable per engine property ─────
    params = { ...
        'AnnualPatients',      p.annualPatients
        'NumPhcs',             p.numPhcs
        'WorkingDaysPerYear',  p.workingDaysPerYear
        'WorkingHoursPerDay',  p.workingHoursPerDay
        'ImageSizeMB',         p.imageSizeMB
        'BandwidthMbps',       p.bandwidthMbps
        'NumOphthalmologists', p.numOphthalmologists
        'TierFractions',       p.tierFractions
        'ReviewSecondsB',      p.reviewSecondsB
        'ReviewSecondsC',      p.reviewSecondsC
        'SimDays',             p.simDays
        'RngSeed',             p.rngSeed };
    hws = get_param(m, 'ModelWorkspace');
    for i = 1:size(params, 1)
        assignin(hws, params{i, 1}, params{i, 2});
    end

    % ── Blocks ────────────────────────────────────────────────────────────
    add_block('simulink/Sources/Digital Clock', [m '/Clock']);
    set_param([m '/Clock'], 'SampleTime', num2str(STEP));

    eng = [m '/District Screening Engine'];
    add_block('simulink/User-Defined Functions/MATLAB System', eng);
    set_param(eng, 'System', 'DistrictScreeningEngine', 'SimulateUsing', 'Code generation');
    for i = 1:size(params, 1)
        set_param(eng, params{i, 1}, params{i, 1});
    end

    outs = {'arrived', 'uploaded', 'autoCleared', 'queueB', 'queueC', ...
            'reviewersBusy', 'reviewed', 'summary'};
    for k = 1:numel(outs)
        toWs(m, outs{k});
    end

    add_block('simulink/Sources/Constant', [m '/Reviewers']);
    set_param([m '/Reviewers'], 'Value', 'NumOphthalmologists', 'SampleTime', num2str(STEP));
    add_block('simulink/Math Operations/Divide', [m '/Utilisation']);
    toWs(m, 'reviewerUtil');

    add_block('simulink/Sinks/Stop Simulation', [m '/Stop At Horizon']);

    % ── Wiring ────────────────────────────────────────────────────────────
    c = @(a, b) add_line(m, a, b, 'autorouting', 'on');
    c('Clock/1', 'District Screening Engine/1');
    for k = 1:numel(outs)
        c(sprintf('District Screening Engine/%d', k), sprintf('%s out/1', outs{k}));
    end
    c('District Screening Engine/6', 'Utilisation/1');
    c('Reviewers/1', 'Utilisation/2');
    c('Utilisation/1', 'reviewerUtil out/1');
    c('District Screening Engine/9', 'Stop At Horizon/1');

    try
        Simulink.BlockDiagram.arrangeSystem(m);
    catch
        % cosmetic only
    end

    % ── Configuration ─────────────────────────────────────────────────────
    set_param(m, ...
        'SolverType', 'Fixed-step', 'Solver', 'FixedStepDiscrete', ...
        'FixedStep', num2str(STEP), 'StopTime', 'inf', ...
        'DefaultParameterBehavior', 'Tunable', ...
        'SignalLogging', 'off', 'ReturnWorkspaceOutputs', 'on');

    save_system(m, outPath);
    fprintf('Built %s (%d blocks)\n', outPath, numel(find_system(m, 'Type', 'Block')));
    close_system(m, 0);
catch ME
    if bdIsLoaded(modelName), close_system(modelName, 0); end
    rethrow(ME);
end
end

function toWs(m, name)
blk = sprintf('%s/%s out', m, name);
add_block('simulink/Sinks/To Workspace', blk);
set_param(blk, 'VariableName', name, 'SaveFormat', 'Timeseries');
end
