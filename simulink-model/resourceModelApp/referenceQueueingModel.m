function varargout = referenceQueueingModel(mode, params)
% REFERENCEQUEUEINGMODEL  Discrete-event simulation of the district screening
% pipeline, in plain MATLAB.
%
%   referenceQueueingModel()                 run the default scenario set
%   p = referenceQueueingModel('defaults')   get the default parameter struct
%   r = referenceQueueingModel('run', p)     run one configuration
%   r = referenceQueueingModel('recommend', p)
%                                            the resource-allocation answer
%                                            as DATA, for the admin dashboard
%                                            (backend plan §G) -- see below
%
%   ===================================================================
%   THIS IS NOT THE SIMULINK DELIVERABLE.
%
%   PS requirement 5 asks for a Simulink model specifically. That is
%   buildDistrictScreeningModel.m + districtScreeningSimEvents.slx, and it
%   is blocked until Simulink and SimEvents are installed (Task 0.0).
%
%   This file exists for two reasons:
%     1. to produce the district-scale numbers now rather than blocking on
%        an install;
%     2. to act as a VALIDATION ORACLE — once the SimEvents model is built,
%        it should reproduce these numbers on the same inputs. A material
%        disagreement means one of the two is wrong, which is worth finding
%        before the demo rather than during it.
%
%   Never present this as the Simulink deliverable. See README.md.
%   ===================================================================
%
%   Model (design doc §7, §8.1):
%     stage 1  per-PHC upload queue, service time = image size / bandwidth
%     stage 2  tier triage — Tier A auto-clears and never reaches a reviewer
%     stage 3  reviewer pool, Tier C PREEMPTS Tier B (preemptive-resume)
%
%   Every parameter is a modelled assumption, not measured field data
%   (design doc §16). Say so when presenting results.

if nargin < 1, mode = 'scenarios'; end

switch lower(mode)
    case 'defaults'
        varargout{1} = defaultParams();
    case 'run'
        varargout{1} = simulate(params);
    case 'scenarios'
        runScenarioSet();
    case 'recommend'
        if nargin < 2, params = defaultParams(); end
        varargout{1} = recommend(params);
    otherwise
        error('referenceQueueingModel: unknown mode ''%s''.', mode);
end
end

% ── Parameters ───────────────────────────────────────────────────────────────
function p = defaultParams()
p.annualPatients       = 100000;      % the PS's district-scale figure
p.numPhcs              = 10;
p.workingDaysPerYear   = 250;
p.workingHoursPerDay   = 8;
p.imageSizeMB          = 4;
p.bandwidthMbps        = [0.5 1 2 5]; % sampled per PHC — rural tiers
p.numOphthalmologists  = 2;
% MEASURED: 50-fold cross-fit of the shipped conformal policy over the
% 628-image held-out test split, scored against ground-truth labels
% (diagnostics/out/conformal_v3_crossfit_report_branchA_v2c.json). False
% auto-clear of truly referable patients is 0.0 across all folds, so this
% 38% auto-clear share is a real workload reduction and not a safety trade.
% Deliberately NOT the development database's 0.028/0.847/0.125 -- that
% corpus is 60/72 grade 3 and measures the seed data, not the system.
p.tierFractions        = [0.384 0.438 0.178];   % A / B / C
p.reviewSecondsB       = 30;          % the PS's <30 s AI-assisted target
p.reviewSecondsC       = 240;         % full manual grading
p.simDays              = 20;
p.rngSeed              = 42;          % fixed: results must be reproducible
end

% ── Simulation ───────────────────────────────────────────────────────────────
function r = simulate(p)
rng(p.rngSeed);

secondsPerDay = p.workingHoursPerDay * 3600;
horizon       = p.simDays * secondsPerDay;

% Arrival rate. Patients only arrive during working hours, so the annual
% figure is spread over working seconds, not calendar seconds — using calendar
% time would understate the peak load by roughly 3x and make every queue look
% comfortable.
perDay      = p.annualPatients / p.workingDaysPerYear;
arrivalRate = perDay / secondsPerDay;              % arrivals per second

% Upload service time per PHC. Serial per site: a PHC uploads one image at a
% time, which is what makes bandwidth a queueing constraint rather than just a
% latency figure.
bwPerPhc      = p.bandwidthMbps(mod(0:p.numPhcs-1, numel(p.bandwidthMbps)) + 1);
uploadSeconds = (p.imageSizeMB * 8) ./ bwPerPhc;   % MB->Mb / Mbps

% ── Event-driven simulation ──────────────────────────────────────────────────
% Generate arrivals up front (Poisson process, exponential gaps).
nArr    = poissrnd_local(arrivalRate * horizon);
arrTime = sort(rand(nArr, 1) * horizon);
arrPhc  = randi(p.numPhcs, nArr, 1);

% Assign tiers by the configured fractions.
u    = rand(nArr, 1);
cuts = cumsum(p.tierFractions(:)') / sum(p.tierFractions);
tier = ones(nArr, 1);                        % 1=A, 2=B, 3=C
tier(u > cuts(1)) = 2;
tier(u > cuts(2)) = 3;

% ── Stage 1: per-PHC upload queues ───────────────────────────────────────────
% Serial FIFO per site: a case starts uploading when the site is free and it
% has arrived, whichever is later.
uploadFreeAt = zeros(p.numPhcs, 1);
uploadDone   = zeros(nArr, 1);
uploadWait   = zeros(nArr, 1);

for i = 1:nArr
    ph    = arrPhc(i);
    start = max(arrTime(i), uploadFreeAt(ph));
    uploadWait(i)   = start - arrTime(i);
    uploadDone(i)   = start + uploadSeconds(ph);
    uploadFreeAt(ph) = uploadDone(i);
end

% ── Stage 2: triage ──────────────────────────────────────────────────────────
% Tier A auto-clears here and never consumes reviewer capacity. Modelling this
% is the point: it is what the tier system buys, and omitting it would make the
% reviewer pool look far more overloaded than it is.
needsReview = find(tier > 1);
[~, ord]    = sort(uploadDone(needsReview));
needsReview = needsReview(ord);

% ── Stage 3: reviewer pool, Tier C preempts Tier B ───────────────────────────
% Preemptive-resume: a Tier C arriving to a fully busy pool displaces an
% in-progress Tier B, which returns to the queue with its REMAINING work rather
% than restarting (design doc §7).
K = p.numOphthalmologists;
srvBusyUntil = zeros(K, 1);      % when each reviewer next frees (if not preempted)
srvCase      = zeros(K, 1);      % case index in service, 0 = idle
srvTier      = zeros(K, 1);

reviewStart = nan(nArr, 1);
reviewEnd   = nan(nArr, 1);
remaining   = zeros(nArr, 1);
for i = needsReview'
    remaining(i) = serviceTime(tier(i), p);
end
% Keep the service times actually drawn. `remaining` is consumed during the
% simulation (decremented on preemption, zeroed on completion), so the offered
% load must be summed from this copy. Re-drawing fresh random times afterwards
% would report a load the simulation never actually ran.
drawnService = remaining;

% Two FIFO queues rather than one scanned for the highest tier.
%
% The first version kept a single queue and picked the max-tier entry with a
% linear scan per dispatch. That is O(n^2), and it does not degrade gracefully:
% the interesting scenarios are precisely the SATURATED ones, where the queue
% grows to tens of thousands of cases, so the configurations worth studying were
% the ones too slow to run. Since there are only two reviewable tiers, one queue
% each gives O(1) dispatch -- take from C if non-empty, else B.
%
% Head/tail indices rather than queue(1) = [], because deleting the front of a
% MATLAB array reallocates the whole thing on every dispatch.
%
% qB carries FRONT padding: a preempted Tier B is pushed back at the head, so
% hB decrements and would otherwise run off index 1. At most K cases are in
% service at once, so K + slack is enough headroom.
nR  = numel(needsReview);
pad = K + 8;
qB = zeros(nR + pad, 1); hB = pad + 1; tB = pad;     % head, tail
qC = zeros(nR + 1, 1);   hC = 1;       tC = 0;

qi    = 1;                       % next arrival into the review stage
clock = 0;

% NOT an anonymous function. MATLAB closures capture by VALUE at creation
% time, so an @() helper over hB/tB/hC/tC would freeze at its initial value of
% 0 and silently never dispatch anything -- the simulation would run to
% completion with every wait time NaN, which reads as a modelling result rather
% than a bug. Compute the depth inline instead.

while qi <= numel(needsReview) || (tB - hB + 1) + (tC - hC + 1) > 0 || any(srvCase > 0)
    % Next event: an arrival into review, or the earliest service completion.
    tArrive = inf;
    if qi <= numel(needsReview), tArrive = uploadDone(needsReview(qi)); end
    busy    = find(srvCase > 0);
    tDone   = inf;
    if ~isempty(busy), tDone = min(srvBusyUntil(busy)); end

    clock = min(tArrive, tDone);
    if ~isfinite(clock), break; end

    % Completions first, so a freed reviewer can take the arriving case.
    for k = busy(:)'
        if abs(srvBusyUntil(k) - clock) < 1e-9
            reviewEnd(srvCase(k)) = clock;
            remaining(srvCase(k)) = 0;
            srvCase(k) = 0; srvTier(k) = 0;
        end
    end

    % Arrivals into the review stage.
    while qi <= numel(needsReview) && uploadDone(needsReview(qi)) <= clock + 1e-9
        c = needsReview(qi);
        if tier(c) == 3, tC = tC + 1; qC(tC) = c;
        else,            tB = tB + 1; qB(tB) = c; end
        qi = qi + 1;
    end

    % Dispatch: Tier C first, FIFO within each tier.
    idle = find(srvCase == 0);
    ii = 1;
    while ii <= numel(idle) && (tB - hB + 1) + (tC - hC + 1) > 0
        if tC >= hC, c = qC(hC); hC = hC + 1;
        else,        c = qB(hB); hB = hB + 1; end
        k = idle(ii); ii = ii + 1;
        if isnan(reviewStart(c)), reviewStart(c) = clock; end
        srvCase(k) = c; srvTier(k) = tier(c);
        srvBusyUntil(k) = clock + remaining(c);
    end

    % Preemption: a waiting Tier C displaces an in-service Tier B.
    while tC >= hC && any(srvTier == 2)
        % Preempt the B with the most work left — it has the least sunk cost,
        % so restarting it later wastes the least reviewer time.
        bIdx = find(srvTier == 2);
        [~, w] = max(srvBusyUntil(bIdx) - clock);
        k = bIdx(w);

        pre = srvCase(k);
        remaining(pre) = srvBusyUntil(k) - clock;   % resume, do not restart
        % Re-queue at the FRONT of B: it was already at the head when it was
        % dispatched, and sending it to the back would let a preempted case be
        % overtaken repeatedly and starve.
        hB = hB - 1; qB(hB) = pre;

        c = qC(hC); hC = hC + 1;
        if isnan(reviewStart(c)), reviewStart(c) = clock; end
        srvCase(k) = c; srvTier(k) = tier(c);
        srvBusyUntil(k) = clock + remaining(c);
    end
end

% ── Metrics ──────────────────────────────────────────────────────────────────
reviewWait  = reviewStart(needsReview) - uploadDone(needsReview);
totalTime   = reviewEnd(needsReview)   - arrTime(needsReview);
reviewWork  = sum(drawnService(needsReview));

r.params              = p;
r.casesSimulated      = nArr;
r.casesAutoCleared    = sum(tier == 1);
r.casesReviewed       = numel(needsReview);
r.uploadWaitMeanMin   = mean(uploadWait) / 60;
r.uploadWaitP95Min    = prctile_local(uploadWait, 95) / 60;
r.reviewWaitMeanMin   = mean(reviewWait, 'omitnan') / 60;
r.reviewWaitP95Min    = prctile_local(reviewWait(~isnan(reviewWait)), 95) / 60;
r.totalTimeMeanMin    = mean(totalTime, 'omitnan') / 60;
r.uploadUtilisation   = mean(accumarray(arrPhc, uploadSeconds(arrPhc)', [p.numPhcs 1])) / horizon;
% Offered load, NOT censored at 100%. A saturated stage must be able to report
% >100% -- capping it would make "exactly at capacity" and "receiving twice the
% work it can do" look identical, and those need very different recommendations.
r.reviewOfferedLoad   = reviewWork / (K * horizon);
r.reviewUtilisation   = r.reviewOfferedLoad;
[r.bottleneck, r.recommendation] = diagnose(r);
end

% ── Helpers ──────────────────────────────────────────────────────────────────
function t = serviceTime(tierIdx, p)
% Exponential around the mean: review duration varies a lot case to case, and
% a fixed time would hide exactly the queue build-up this model exists to show.
if tierIdx == 3
    t = -p.reviewSecondsC * log(rand());
else
    t = -p.reviewSecondsB * log(rand());
end
end

function [bottleneck, rec] = diagnose(r)
% Judge on BOTH utilisation and tail latency. Utilisation alone is misleading
% in a queueing system: a stage at 60% mean utilisation with bursty arrivals can
% still leave a patient's result sitting for an hour, and the mean wait hides it
% completely. The p95 is what a technician waiting on a same-visit answer
% actually experiences, so it gets its own trigger.
p = r.params;

SATURATED  = 0.85;
BUSY       = 0.60;
P95_LIMIT  = 60;      % minutes — beyond this a same-visit result is not credible

reviewStrained = r.reviewUtilisation > SATURATED || r.reviewWaitP95Min > P95_LIMIT;
uploadStrained = r.uploadUtilisation > SATURATED || r.uploadWaitP95Min > P95_LIMIT;

if reviewStrained
    bottleneck = 'ophthalmologist review';
    % Size from OFFERED load, not observed utilisation. Under saturation the
    % two diverge: observed utilisation pins at ~100% no matter how far demand
    % overshoots, so sizing off it would under-provision exactly when it matters.
    needed = max(p.numOphthalmologists + 1, ...
                 ceil(p.numOphthalmologists * r.reviewOfferedLoad / 0.70));
    rec = sprintf(['Reviewer pool is the constraint (%.0f%% utilised, p95 wait ' ...
        '%.0f min). Add ophthalmologists: %d -> %d.'], ...
        100*r.reviewUtilisation, r.reviewWaitP95Min, p.numOphthalmologists, needed);
elseif uploadStrained
    bottleneck = 'network upload';
    rec = sprintf(['Upload is the constraint (%.0f%% utilised, p95 wait %.0f min) ' ...
        'while reviewers sit at %.0f%%. Adding staff would not help — raise ' ...
        'bandwidth at the slowest sites or compress before transmission.'], ...
        100*r.uploadUtilisation, r.uploadWaitP95Min, 100*r.reviewUtilisation);
elseif r.reviewUtilisation > BUSY
    bottleneck = 'review (approaching capacity)';
    rec = sprintf(['Adequate but with little margin: review %.0f%% utilised, ' ...
        'p95 wait %.0f min. One reviewer absent, or a modest volume rise, ' ...
        'pushes this over. Plan for %d rather than %d.'], ...
        100*r.reviewUtilisation, r.reviewWaitP95Min, ...
        p.numOphthalmologists + 1, p.numOphthalmologists);
else
    bottleneck = 'none — capacity adequate';
    rec = sprintf(['Capacity is adequate: review %.0f%% utilised, upload %.0f%%, ' ...
        'p95 end-to-end %.0f min. Headroom for more PHCs or higher volume.'], ...
        100*r.reviewUtilisation, 100*r.uploadUtilisation, r.totalTimeMeanMin);
end
end

function n = minReviewersFor(p, p95LimitMin)
% Smallest reviewer pool holding the p95 review wait under a limit.
% This is the actual "optimize resource allocation" answer the PS asks for --
% a single scenario reports a state, a search reports a decision.
%
% Searches upward from 1 rather than bisecting: the wait is monotonic in pool
% size, but an undersized pool produces an unstable queue whose simulation is
% slow, so starting small and stopping at the first success visits fewer
% expensive configurations than a bisection would.
MAX_POOL = 12;
n = NaN;
for k = 1:MAX_POOL
    q = p; q.numOphthalmologists = k;
    r = simulate(q);
    if r.reviewWaitP95Min <= p95LimitMin, n = k; return; end
end
end

function s = reviewerCountStr(n)
% NaN means the search hit its ceiling without meeting the target -- report
% that as ">12", never as a number, so an unmet target cannot be misread as a
% satisfied one.
if isnan(n), s = '>12 (target unmet)'; else, s = sprintf('%d', n); end
end

function n = poissrnd_local(lambda)
% Poisson draw without Statistics Toolbox — that toolbox is licensed but not
% installed (Task 0.0), and this model must run today regardless.
% Normal approximation is exact enough for the large lambda here (>1e4).
if lambda > 1000
    n = max(0, round(lambda + sqrt(lambda) * randn()));
else
    L = exp(-lambda); k = 0; pr = 1;
    while true
        pr = pr * rand(); if pr <= L, break; end
        k = k + 1;
    end
    n = k;
end
end

function v = prctile_local(x, q)
% Percentile without Statistics Toolbox (see above).
x = sort(x(:));
if isempty(x), v = NaN; return; end
v = interp1(linspace(0, 100, numel(x)), x, q, 'linear', 'extrap');
end

% ── Recommendation (backend plan §G) ─────────────────────────────────────────
function out = recommend(p)
% What the admin dashboard's Resource Recommendations panel shows, computed
% rather than typed in: the smallest reviewer pool that holds the p95 review
% wait under 60 minutes, for routine operation and for camp mode (the same
% annual volume compressed into 50 days, design doc §9.5), plus the bottleneck
% diagnosis for the pool as it is staffed today.
%
% Missing fields in p fall back to defaultParams(), so a caller supplies only
% what it has actually observed (tier mix, PHC count, reviewer count).
d = defaultParams();
f = fieldnames(d);
for i = 1:numel(f)
    if ~isfield(p, f{i}) || isempty(p.(f{i})), p.(f{i}) = d.(f{i}); end
end

P95_LIMIT_MIN = 60;
t0 = tic;

current = simulate(p);
nRoutine = minReviewersFor(p, P95_LIMIT_MIN);
q = p; q.workingDaysPerYear = 50;
nCamp = minReviewersFor(q, P95_LIMIT_MIN);

% [] (-> JSON null) when the search hit its ceiling: "more than 12, target
% unmet" must never be readable as a number of reviewers that works.
out.minOphthalmologistsRoutine = [];
if ~isnan(nRoutine), out.minOphthalmologistsRoutine = nRoutine; end
out.minOphthalmologistsCamp = [];
if ~isnan(nCamp), out.minOphthalmologistsCamp = nCamp; end
out.maxSearched        = 12;
out.p95TargetMin       = P95_LIMIT_MIN;
out.bottleneck         = current.bottleneck;
out.recommendation     = current.recommendation;
out.current = struct( ...
    'numOphthalmologists', p.numOphthalmologists, ...
    'reviewUtilisationPct', 100 * current.reviewUtilisation, ...
    'reviewWaitP95Min', current.reviewWaitP95Min, ...
    'uploadUtilisationPct', 100 * current.uploadUtilisation, ...
    'uploadWaitP95Min', current.uploadWaitP95Min, ...
    'casesReviewed', current.casesReviewed, ...
    'casesAutoCleared', current.casesAutoCleared);
out.params  = p;
out.model   = 'referenceQueueingModel';
out.caveat  = ['Every parameter is a modelled assumption unless stated as ' ...
               'observed; this is a planning estimate, not a measurement.'];
out.runSeconds = toc(t0);
end

% ── Scenario set ─────────────────────────────────────────────────────────────
function runScenarioSet()
fprintf('\n=== District screening — reference queueing model ===\n');
fprintf('NOT the Simulink deliverable (Task 3.8 / PS req 5). See README.md.\n');
fprintf('All parameters are modelled assumptions, not field data.\n\n');

% Scenario set chosen to find where the system BREAKS, not to confirm that a
% comfortably-resourced configuration is comfortable. The first pass at this
% reported "capacity adequate" for every scenario, which is a true but useless
% answer -- at 100k/year over 250 working days a district sees only ~400
% patients/day, and that load is genuinely easy. The interesting question is
% what pushes it over, so the set below includes the two things that actually
% do: camp-mode bursts and a lower Tier A auto-clear rate.
scenarios = {
%   label                                    PHCs  ophths  tierA  days
    'Small: 3 PHCs, 1 ophthalmologist',        3,    1,    0.70,  250
    'Baseline: 10 PHCs, 2 ophthalmologists',  10,    2,    0.70,  250
    'Camp mode: same volume in 50 days',      10,    2,    0.70,   50
    'Weak model: Tier A only 30%',            10,    2,    0.30,  250
    'No tier system at all: 0% auto-clear',   10,    2,    0.00,  250
    'Camp mode + weak model',                 10,    2,    0.30,   50
};

rows = {};
for i = 1:size(scenarios, 1)
    p = defaultParams();
    p.numPhcs             = scenarios{i, 2};
    p.numOphthalmologists = scenarios{i, 3};
    tierA                 = scenarios{i, 4};
    p.workingDaysPerYear  = scenarios{i, 5};
    % Volume scales with the number of PHCs; the 100k figure is the 10-PHC case.
    % Note it does NOT scale with workingDaysPerYear -- camp mode compresses the
    % same annual population into fewer days (design doc §9.5), which is exactly
    % why it stresses the system.
    p.annualPatients      = 100000 * p.numPhcs / 10;
    % Split the non-A remainder 2:1 between B and C, holding the original ratio.
    p.tierFractions       = [tierA, (1-tierA)*2/3, (1-tierA)*1/3];

    r = simulate(p);
    rows(end+1, :) = { scenarios{i,1}, r.casesReviewed, ...
        round(100*r.uploadUtilisation), round(100*r.reviewUtilisation), ...
        round(r.reviewWaitP95Min), round(r.totalTimeMeanMin), r.bottleneck }; %#ok<AGROW>

    fprintf('--- %s ---\n', scenarios{i,1});
    fprintf('  %d patients/yr over %d days, %d reviewed (%.0f%% auto-cleared)\n', ...
        p.annualPatients, p.workingDaysPerYear, r.casesReviewed, ...
        100*r.casesAutoCleared/max(1,r.casesSimulated));
    fprintf('  upload  : %3.0f%% utilised, mean %5.1f min, p95 %6.1f min\n', ...
        100*r.uploadUtilisation, r.uploadWaitMeanMin, r.uploadWaitP95Min);
    fprintf('  review  : %3.0f%% utilised, mean %5.1f min, p95 %6.1f min\n', ...
        100*r.reviewUtilisation, r.reviewWaitMeanMin, r.reviewWaitP95Min);
    fprintf('  BOTTLENECK: %s\n', r.bottleneck);
    fprintf('  > %s\n\n', r.recommendation);
end

% ── The actual resource-allocation answer ────────────────────────────────────
% A scenario table reports states. The PS asks to OPTIMISE allocation, which
% means answering "how many do we need" -- so search for it rather than leaving
% the reader to interpolate between rows.
fprintf('=== Minimum ophthalmologists to hold p95 review wait under 60 min ===\n');
fprintf('    (100k patients/yr, swept over Tier A auto-clear rate)\n\n');
fprintf('    Tier A     routine (250 days)   camp mode (50 days)\n');
fprintf('    --------   ------------------   -------------------\n');
for tierA = [0.70 0.50 0.30 0.00]
    p = defaultParams();
    p.tierFractions = [tierA, (1-tierA)*2/3, (1-tierA)*1/3];

    nRoutine = minReviewersFor(p, 60);

    % Camp mode compresses the same annual population into 50 days (design doc
    % §9.5). Both regimes are swept because the routine one alone does not
    % discriminate -- see the note printed below.
    q = p; q.workingDaysPerYear = 50;
    nCamp = minReviewersFor(q, 60);

    fprintf('    %5.0f%%     %-18s   %s\n', 100*tierA, ...
        reviewerCountStr(nRoutine), reviewerCountStr(nCamp));
end

fprintf(['\n    Reading this honestly: at 100k patients/year spread over 250\n' ...
         '    working days, the district needs 1-2 ophthalmologists REGARDLESS\n' ...
         '    of the Tier A rate. That volume is ~400 patients/day across all\n' ...
         '    PHCs, and it simply is not a heavy review load. The tier system''s\n' ...
         '    value does NOT show up as headcount in the routine regime.\n\n' ...
         '    It shows up under burst load. Camp/batch screening (§9.5) is where\n' ...
         '    the auto-clear rate starts driving staffing, because the same\n' ...
         '    annual population arrives in a fifth of the time.\n\n' ...
         '    So the defensible claim is "the tier system is what makes camp-mode\n' ...
         '    screening staffable", not "it saves N ophthalmologists per year".\n' ...
         '    Tier A share is an ASSUMPTION until the real model produces real\n' ...
         '    tiers -- and it is the single most influential parameter here.\n\n']);

% Export for analyticsAggregator.js (design doc §5.3).
outPath = fullfile(fileparts(mfilename('fullpath')), 'simulation-results.csv');
fid = fopen(outPath, 'w');
fprintf(fid, 'scenario,casesReviewed,uploadUtilPct,reviewUtilPct,reviewWaitP95Min,totalTimeMeanMin,bottleneck\n');
for i = 1:size(rows, 1)
    fprintf(fid, '"%s",%d,%d,%d,%d,%d,"%s"\n', rows{i,:});
end
fclose(fid);
fprintf('Wrote %s\n\n', outPath);
end
