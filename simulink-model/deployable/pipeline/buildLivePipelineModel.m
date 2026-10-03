function buildLivePipelineModel(outPath)
% BUILDLIVEPIPELINEMODEL  Construct netraSetuPipelineLive.slx.
%
%   buildLivePipelineModel()
%   buildLivePipelineModel(outPath)
%
%   The Simulink Compiler deployable twin of ../../netraSetuPipeline.slx, the
%   interactive SimEvents dashboard model (which is NOT modified). SimEvents
%   blocks cannot generate code, so that model cannot be packaged; this one
%   uses only code-generation-capable blocks around PipelineEngine.
%
%   STRUCTURE
%
%     In1 MeanIatSec  ─┐
%     In2 ReviewScale ─┤
%     In3 NetworkUp   ─┼─▶ Pipeline Engine (MATLAB System) ─┬─▶ Out1 state (1x26)
%     In4 GradingUp   ─┤                                     └─▶ To Workspace 'state'
%     Clock (5 s)     ─┘
%
%   THE LIVE CONTROLS ARE ROOT INPORTS. The SimEvents model binds dashboard
%   sliders to Constant blocks, which only works inside Simulink. A deployed
%   app instead feeds root inports through
%   simulink.compiler.setExternalInputsFcn and reads Out1 through
%   setExternalOutputsFcn, every step, while the simulation runs -- that is
%   what makes the compiled dashboard interactive (PipelineDashboardApp.m).
%
%   STEP SIZE: 5 s. The engine handles every arrival, completion and
%   preemption at its exact continuous time between steps, so the step only
%   sets how often the live controls are sampled and the outputs are read.
%   Measured in the compiled app: at 1 s the per-step MATLAB callbacks (four
%   inputs, one output, one post-step) capped an 8 h run near 90x real time;
%   at 5 s the 200x-2000x paces are reachable. With constant inputs the
%   results are identical to 1 s stepping (validateLivePipelineModel).
%
%   Engine parameters (PHCs, reviewers, times, rates, tier mix, seed) are
%   model-workspace variables, tunable at run start without a rebuild.

here = fileparts(mfilename('fullpath'));
if nargin < 1 || isempty(outPath)
    outPath = fullfile(here, 'netraSetuPipelineLive.slx');
end
addpath(here);

mdl = 'netraSetuPipelineLive';
if bdIsLoaded(mdl), close_system(mdl, 0); end
if isfile(outPath), delete(outPath); end
p = pipelineDefaults();
STEP = 5;   % seconds of simulated time per step (see the header note on step size)

new_system(mdl, 'Model');
try
    params = {'NumPhcs', 'NumOphthalmologists', 'GradingConcurrency', 'CaptureSeconds', ...
              'QualityPassRate', 'UploadSeconds', 'GradingSeconds', 'GradingFailureRate', ...
              'MaxAttempts', 'TierFractions', 'ReviewSecondsB', 'ReviewSecondsC', ...
              'ReferableFraction', 'RngSeed'};
    hws = get_param(mdl, 'ModelWorkspace');
    for i = 1:numel(params)
        assignin(hws, params{i}, p.(params{i}));
    end

    inputs = {'MeanIatSec', p.MeanIatSeconds; 'ReviewScale', 1; 'NetworkUp', 1; 'GradingUp', 1};
    for i = 1:size(inputs, 1)
        b = sprintf('%s/%s', mdl, inputs{i, 1});
        add_block('simulink/Sources/In1', b);
        set_param(b, 'OutDataTypeStr', 'double', 'PortDimensions', '1', ...
            'SampleTime', num2str(STEP));
    end

    add_block('simulink/Sources/Digital Clock', [mdl '/Clock']);
    set_param([mdl '/Clock'], 'SampleTime', num2str(STEP));

    eng = [mdl '/Pipeline Engine'];
    add_block('simulink/User-Defined Functions/MATLAB System', eng);
    set_param(eng, 'System', 'PipelineEngine', 'SimulateUsing', 'Code generation');
    for i = 1:numel(params)
        set_param(eng, params{i}, params{i});
    end

    add_block('simulink/Sinks/Out1', [mdl '/state']);
    add_block('simulink/Sinks/To Workspace', [mdl '/state log']);
    set_param([mdl '/state log'], 'VariableName', 'state', 'SaveFormat', 'Timeseries');

    c = @(a, b) add_line(mdl, a, b, 'autorouting', 'on');
    c('Clock/1', 'Pipeline Engine/1');
    for i = 1:size(inputs, 1)
        c(sprintf('%s/1', inputs{i, 1}), sprintf('Pipeline Engine/%d', i + 1));
    end
    c('Pipeline Engine/1', 'state/1');
    c('Pipeline Engine/1', 'state log/1');

    try, Simulink.BlockDiagram.arrangeSystem(mdl); catch, end

    set_param(mdl, 'SolverType', 'Fixed-step', 'Solver', 'FixedStepDiscrete', ...
        'FixedStep', num2str(STEP), ...
        'StopTime', num2str(p.WorkingHoursPerDay * 3600), ...
        'DefaultParameterBehavior', 'Tunable', ...
        'LoadExternalInput', 'off', 'SaveOutput', 'off', ...
        'SignalLogging', 'off', 'ReturnWorkspaceOutputs', 'on');

    save_system(mdl, outPath);
    fprintf('Built %s (%d blocks)\n', outPath, numel(find_system(mdl, 'Type', 'Block')));
    close_system(mdl, 0);
catch ME
    if bdIsLoaded(mdl), close_system(mdl, 0); end
    rethrow(ME);
end
end
