function results = validateDeployableResourceModel(varargin)
% VALIDATEDEPLOYABLERESOURCEMODEL  districtResourceModel.slx vs referenceQueueingModel.m.
%
%   results = validateDeployableResourceModel()
%   results = validateDeployableResourceModel('Modes', {'normal'})
%
%   Runs the deployable model on contrasting scenarios and compares its
%   summary with the reference model's on the same parameters and seed.
%   The engine draws its random inputs in the reference model's order, so
%   the expected agreement is EXACT (floating-point rounding), not "within
%   a tolerance" -- any real difference is a bug.
%
%   Modes:
%     'normal'     ordinary simulation in MATLAB
%     'deployment' simulink.compiler.configureForDeployment: Rapid
%                  Accelerator with deployed-app rules, parameters changed
%                  only through setVariable. This is what the standalone app
%                  runs, so passing here is the precondition for packaging.
%                  Needs a C compiler visible to MATLAB (mex -setup C).

ip = inputParser;
ip.addParameter('Modes', {'normal', 'deployment'});
ip.parse(varargin{:});
modes = ip.Results.Modes;

thisDir = fileparts(mfilename('fullpath'));
addpath(thisDir); addpath(fileparts(thisDir));
mdl = 'districtResourceModel';
slx = fullfile(thisDir, [mdl '.slx']);
if ~isfile(slx), buildDeployableResourceModel(); end
load_system(slx);
cleanup = onCleanup(@() close_system(mdl, 0));

scenarios = {
    'Baseline: 10 PHCs, 2 ophthalmologists', struct()
    'Camp mode: same volume in 50 days',     struct('workingDaysPerYear', 50)
    'Small: 3 PHCs, 1 ophthalmologist',      struct('numPhcs', 3, 'numOphthalmologists', 1)
    'Weak model: 30% Tier A, 5 days',        struct('tierFractions', [0.3 0.5 0.2], 'simDays', 5)
    'Scaled up: 4 ophthalmologists, camp',   struct('numOphthalmologists', 4, 'workingDaysPerYear', 50)
};
labels = {'cases', 'auto-cleared', 'needing review', 'upload util %', 'review util %', ...
          'review wait mean (min)', 'review wait p95 (min)', 'upload wait mean (min)', ...
          'upload wait p95 (min)', 'total time mean (min)'};

results = struct('mode', {}, 'scenario', {}, 'maxRelDiff', {}, 'pass', {}, 'seconds', {});
fprintf('\n=== districtResourceModel vs referenceQueueingModel ===\n');
for mi = 1:numel(modes)
    mode = modes{mi};
    fprintf('\n-- mode: %s --\n', mode);
    for s = 1:size(scenarios, 1)
        p = referenceQueueingModel('defaults');
        f = fieldnames(scenarios{s, 2});
        for j = 1:numel(f), p.(f{j}) = scenarios{s, 2}.(f{j}); end
        r = referenceQueueingModel('run', p);
        ref = [r.casesSimulated r.casesAutoCleared r.casesReviewed ...
               100*r.uploadUtilisation 100*r.reviewUtilisation r.reviewWaitMeanMin ...
               r.reviewWaitP95Min r.uploadWaitMeanMin r.uploadWaitP95Min r.totalTimeMeanMin];

        in = Simulink.SimulationInput(mdl);
        in = setParams(in, mdl, p);
        if strcmp(mode, 'deployment')
            in = simulink.compiler.configureForDeployment(in);
        end
        t0 = tic;
        out = sim(in);
        secs = toc(t0);
        sm = finalSummary(out.summary);
        d = max(abs(sm(1:10) - ref) ./ max(1, abs(ref)));
        ok = d < 1e-9 && isfinite(sm(1));
        results(end+1) = struct('mode', mode, 'scenario', scenarios{s, 1}, ...
            'maxRelDiff', d, 'pass', ok, 'seconds', secs); %#ok<AGROW>
        fprintf('  %-40s %s  max rel diff %.1e   review p95 %8.2f min   bottleneck %d   %.1fs\n', ...
            scenarios{s, 1}, ternary(ok, 'MATCH', 'DIFF '), d, sm(7), sm(11), secs);
        if ~ok
            for k = 1:10
                fprintf('      %-24s model %12.4f   reference %12.4f\n', labels{k}, sm(k), ref(k));
            end
        end
    end
end
nFail = sum(~[results.pass]);
fprintf('\n%d runs, %d mismatched\n', numel(results), nFail);
if nFail > 0
    error('validateDeployableResourceModel:mismatch', '%d run(s) disagree with the reference model.', nFail);
end
end

function in = setParams(in, mdl, p)
map = {'AnnualPatients', p.annualPatients; 'NumPhcs', p.numPhcs; ...
       'WorkingDaysPerYear', p.workingDaysPerYear; 'WorkingHoursPerDay', p.workingHoursPerDay; ...
       'ImageSizeMB', p.imageSizeMB; 'BandwidthMbps', p.bandwidthMbps; ...
       'NumOphthalmologists', p.numOphthalmologists; 'TierFractions', p.tierFractions; ...
       'ReviewSecondsB', p.reviewSecondsB; 'ReviewSecondsC', p.reviewSecondsC; ...
       'SimDays', p.simDays; 'RngSeed', p.rngSeed};
for i = 1:size(map, 1)
    in = in.setVariable(map{i, 1}, map{i, 2}, 'Workspace', mdl);
end
end

function sm = finalSummary(ts)
% A 1x13 signal is logged as 1x13xN (time on the third dimension).
d = ts.Data;
if ndims(d) == 3, sm = reshape(d(:, :, end), 1, []); else, sm = d(end, :); end
end

function s = ternary(c, a, b)
if c, s = a; else, s = b; end
end
