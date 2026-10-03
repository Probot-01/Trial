function report = validateLivePipelineModel(varargin)
% VALIDATELIVEPIPELINEMODEL  Check netraSetuPipelineLive.slx before packaging it.
%
%   report = validateLivePipelineModel()
%   report = validateLivePipelineModel('SkipDeployment', true)
%
%   1. EXACT: the Simulink model (normal mode, and Rapid Accelerator under
%      simulink.compiler.configureForDeployment) produces the same final state
%      as PipelineEngine stepped directly in MATLAB, same seed and inputs.
%   2. LIVE: in deployment mode, the controls are driven through
%      setExternalInputsFcn while the simulation runs and the state is read
%      through setExternalOutputsFcn. A 2-hour network outage must make the
%      PHC backlog climb and then drain; a 2-hour grading outage must do the
%      same to the grading backlog while the reviewers go idle.
%   3. THEORY: a long run matches queueing-theory expectations (arrival rate,
%      tier split, utilisations, retakes) within 3%.
%
%   Statistical comparison with the SimEvents model itself is documented in
%   README.md: that model is deterministic (fixed seeds), deadlocks in its
%   grading-retry loop after ~13 h, and over-generates arrivals by ~10% from
%   its sampled-signal approximation, so it is a sanity reference, not an
%   oracle.

ip = inputParser; ip.addParameter('SkipDeployment', false); ip.parse(varargin{:});
here = fileparts(mfilename('fullpath')); addpath(here);
mdl = 'netraSetuPipelineLive';
if ~isfile(fullfile(here, [mdl '.slx'])), buildLivePipelineModel(); end
load_system(fullfile(here, [mdl '.slx']));
cleanup = onCleanup(@() close_system(mdl, 0));
p = pipelineDefaults();
fails = 0;

% ── 1. exact ──────────────────────────────────────────────────────────────
H = 6 * 3600;
ref = engineRun(p, H);
modes = {'normal'};
if ~ip.Results.SkipDeployment
    modes{end+1} = 'deployment';
    % configureForDeployment turns the Rapid Accelerator up-to-date check
    % OFF (a deployed app cannot rebuild). After any model change that would
    % silently test the OLD target, so rebuild it here first.
    Simulink.BlockDiagram.buildRapidAcceleratorTarget(mdl);
end
fprintf('\n=== 1. Simulink model vs engine, %g h, seed %d ===\n', H/3600, p.RngSeed);
for mi = 1:numel(modes)
    in = baseInput(mdl, p, H);
    if strcmp(modes{mi}, 'normal')
        t = (0:H)';
        in = in.setExternalInput([t, repmat([p.MeanIatSeconds 1 1 1], numel(t), 1)]);
        % Interpreted for this check: in NORMAL mode a 'Code generation' System
        % block runs as a MEX with its own random-number state (measured: same
        % seed, reproducible, but a different stream). Rapid Accelerator --
        % what the deployed app runs -- uses the seeded stream and matches.
        in = in.setBlockParameter([mdl '/Pipeline Engine'], 'SimulateUsing', 'Interpreted execution');
    else
        in = simulink.compiler.setExternalInputsFcn(in, @(id, time) constIn(id, p));
        in = simulink.compiler.configureForDeployment(in);
    end
    t0 = tic; out = sim(in); secs = toc(t0);
    y = lastState(out.state);
    d = max(abs(y - ref));
    ok = d < 1e-9;
    fails = fails + ~ok;
    fprintf('  %-10s %s  max abs diff %.1e  (arrived %d, referred %d)  %.1fs\n', ...
        modes{mi}, pf(ok), d, y(1), y(4), secs);
end

% ── 2. live control ───────────────────────────────────────────────────────
if ~ip.Results.SkipDeployment
    fprintf('\n=== 2. live controls in deployment mode (8 h) ===\n');
    for which = {'network', 'grading'}
        global LIVE_TRACE %#ok<GVMIS>
        LIVE_TRACE = zeros(0, 27);
        in = baseInput(mdl, p, 8 * 3600);
        in = simulink.compiler.setExternalInputsFcn(in, @(id, time) outageIn(id, time, p, which{1}));
        in = simulink.compiler.setExternalOutputsFcn(in, @(id, time, data) recordOut(time, data));
        in = simulink.compiler.configureForDeployment(in);
        sim(in);
        tr = LIVE_TRACE;
        if strcmp(which{1}, 'network'), col = 1 + 8; label = 'PHC backlog'; else, col = 1 + 9; label = 'grading backlog'; end
        at = @(h) tr(find(tr(:, 1) <= h * 3600, 1, 'last'), col);
        before = at(1.99); peak = max(tr(tr(:,1) >= 2*3600 & tr(:,1) <= 4*3600, col)); after = at(8);
        revIdle = true; rv = 0;
        if strcmp(which{1}, 'grading')
            rv = tr(tr(:,1) >= 2.5*3600 & tr(:,1) <= 4*3600, 1 + 14);
            revIdle = mean(rv) < 0.2;   % reviewers starve while grading is down
        end
        ok = before <= 5 && peak >= 30 && after <= 10 && revIdle;
        fails = fails + ~ok;
        fprintf('  %-8s outage 2-4 h: %s  %s %d before -> peak %d -> %d at 8 h%s\n', which{1}, pf(ok), ...
            label, before, peak, after, ternary(strcmp(which{1}, 'grading'), sprintf(', reviewers busy %.2f during outage', mean(rv)), ''));
    end
end

% ── 3. theory ─────────────────────────────────────────────────────────────
fprintf('\n=== 3. long run (300 h) vs queueing theory ===\n');
L = 300 * 3600;
y = engineRun(p, L);
lam = 1 / p.MeanIatSeconds; tf = p.TierFractions;
graded = y(3) + y(4) + y(5);
att = 1 + p.GradingFailureRate + p.GradingFailureRate^2;
f = 1 - p.QualityPassRate;
checks = {
    'arrivals',        y(1),             lam * L
    'Tier A share',    y(3) / graded,    tf(1)
    'upload util',     y(24),            lam * p.UploadSeconds / p.NumPhcs
    'grading util',    y(25),            lam * att * p.GradingSeconds / p.GradingConcurrency
    'reviewer util',   y(26),            lam * (tf(2)*p.ReviewSecondsB + tf(3)*p.ReviewSecondsC) / p.NumOphthalmologists
    'retakes/patient', y(23) / y(1),     f + f^2 + f^3 };
for i = 1:size(checks, 1)
    rel = abs(checks{i, 2} - checks{i, 3}) / checks{i, 3};
    ok = rel < 0.03; fails = fails + ~ok;
    fprintf('  %-16s %s  model %10.4f  theory %10.4f  (%.1f%%)\n', checks{i, 1}, pf(ok), checks{i, 2}, checks{i, 3}, 100 * rel);
end

report.failures = fails;
fprintf('\n%d check(s) failed\n', fails);
if fails > 0
    error('validateLivePipelineModel:failed', '%d check(s) failed.', fails);
end
end

% ═════════════════════════════════════════════════════════════════════════════
function in = baseInput(mdl, p, H)
in = Simulink.SimulationInput(mdl);
f = {'NumPhcs', 'NumOphthalmologists', 'GradingConcurrency', 'CaptureSeconds', 'QualityPassRate', ...
     'UploadSeconds', 'GradingSeconds', 'GradingFailureRate', 'MaxAttempts', 'TierFractions', ...
     'ReviewSecondsB', 'ReviewSecondsC', 'ReferableFraction', 'RngSeed'};
for i = 1:numel(f), in = in.setVariable(f{i}, p.(f{i}), 'Workspace', mdl); end
in = in.setModelParameter('StopTime', num2str(H));
end

function y = engineRun(p, H)
e = PipelineEngine('NumPhcs', p.NumPhcs, 'NumOphthalmologists', p.NumOphthalmologists, ...
    'GradingConcurrency', p.GradingConcurrency, 'CaptureSeconds', p.CaptureSeconds, ...
    'QualityPassRate', p.QualityPassRate, 'UploadSeconds', p.UploadSeconds, ...
    'GradingSeconds', p.GradingSeconds, 'GradingFailureRate', p.GradingFailureRate, ...
    'MaxAttempts', p.MaxAttempts, 'TierFractions', p.TierFractions, ...
    'ReviewSecondsB', p.ReviewSecondsB, 'ReviewSecondsC', p.ReviewSecondsC, ...
    'ReferableFraction', p.ReferableFraction, 'RngSeed', p.RngSeed);
for t = 0:1:H, y = e(t, p.MeanIatSeconds, 1, 1, 1); end
end

function v = constIn(id, p)
vals = [p.MeanIatSeconds 1 1 1];
v = vals(id);
end

function v = outageIn(id, time, p, which)
vals = [p.MeanIatSeconds 1 1 1];
down = time >= 2*3600 && time < 4*3600;
if down && strcmp(which, 'network'), vals(3) = 0; end
if down && strcmp(which, 'grading'), vals(4) = 0; end
v = vals(id);
end

function recordOut(time, data)
global LIVE_TRACE %#ok<GVMIS>
LIVE_TRACE(end + 1, :) = [time, reshape(double(data), 1, [])];
end

function y = lastState(ts)
d = ts.Data;
if ndims(d) == 3, y = reshape(d(:, :, end), 1, []); else, y = d(end, :); end
end

function s = pf(ok), if ok, s = 'PASS'; else, s = 'FAIL'; end, end
function s = ternary(c, a, b), if c, s = a; else, s = b; end, end
