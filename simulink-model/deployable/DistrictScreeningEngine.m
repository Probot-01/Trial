classdef DistrictScreeningEngine < matlab.System
% DISTRICTSCREENINGENGINE  Code-generation-compatible district screening engine.
%
%   The core of districtResourceModel.slx -- the Simulink Compiler deployable
%   version of the district resource model (PS requirement 5).
%
%   WHY THIS EXISTS AND NOT THE SIMEVENTS MODEL
%     Simulink Compiler deploys a model by running it in Rapid Accelerator,
%     which generates C code from every block. SimEvents blocks do not
%     support code generation at all (verified 2026-10-03: even a bare
%     Entity Generator fails with SimulinkEventEngine:Engine:CodeGenNotSupported,
%     and MathWorks' Simulink Compiler limitations page says the same). So
%     districtScreeningSimEvents.slx stays the PS deliverable and validation
%     model, and this engine is what a standalone app can actually ship.
%
%   SAME MODEL, SAME NUMBERS
%     This is referenceQueueingModel.m's algorithm, rewritten for code
%     generation (fixed-size buffers, no cell arrays, no dynamic growth). The
%     random inputs are drawn in EXACTLY the reference model's order
%     (Poisson count, arrival times, PHC, tier, then review times in
%     upload-completion order), so for the same parameters and seed this
%     engine reproduces the reference model's summary, not just
%     approximately -- validateDeployableResourceModel checks that.
%
%   HOW TIME WORKS
%     The engine is stepped by a Simulink clock (input t, seconds).
%       Stage 1, network upload: serial FIFO per PHC with no randomness of
%         its own, so each case's upload completion is fixed the moment the
%         patients are generated; it is computed then.
%       Stages 2-3, tier triage and ophthalmologist review: event-processed
%         as simulation time advances -- every event with time <= t is
%         handled at the step for t (arrivals into the B/C queues, review
%         completions, Tier C preempting Tier B with preemptive-RESUME).
%     At the horizon (simDays working days) the engine drains the review
%     queues to completion, exactly as the reference model does, emits the
%     summary and raises 'done', which stops the simulation.

    % ── Tunable: changeable in the deployed app without a rebuild ─────────
    properties
        AnnualPatients      = 100000
        NumPhcs             = 10
        WorkingDaysPerYear  = 250
        WorkingHoursPerDay  = 8
        ImageSizeMB         = 4
        BandwidthMbps       = [0.5 1 2 5]   % rural tiers, assigned round-robin to PHCs
        NumOphthalmologists = 2
        TierFractions       = [0.384 0.438 0.178]   % A / B / C
        ReviewSecondsB      = 30
        ReviewSecondsC      = 240
        SimDays             = 20
        RngSeed             = 42
    end

    % ── Fixed at build time: buffer sizes for code generation ────────────
    properties (Nontunable)
        MaxCases     = 500000
        MaxReviewers = 20
        MaxPhcs      = 200
    end

    properties (Access = private)
        Horizon
        NArr
        ArrTime
        ArrPhc
        Tier
        UploadDone
        UploadWait
        UploadSecPerPhc
        NeedsReview      % review cases, sorted by upload completion
        NR
        Remaining
        Drawn
        ReviewStart
        ReviewEnd
        SortedUploadDone
        SortedUploadDoneA
        NA
        QB
        HB
        TB
        QC
        HC
        TC
        Qi
        SrvBusyUntil
        SrvCase
        SrvTier
        K
        PtrArrived
        PtrUploaded
        PtrAuto
        ReviewedDone
        Finished
        Summary
        Truncated
    end

    methods
        function obj = DistrictScreeningEngine(varargin)
            setProperties(obj, nargin, varargin{:});
        end
    end

    methods (Access = protected)
        function num = getNumInputsImpl(~),  num = 1; end
        function num = getNumOutputsImpl(~), num = 9; end

        function [o1,o2,o3,o4,o5,o6,o7,o8,o9] = getOutputSizeImpl(~)
            o1 = [1 1]; o2 = [1 1]; o3 = [1 1]; o4 = [1 1]; o5 = [1 1];
            o6 = [1 1]; o7 = [1 1]; o8 = [1 13]; o9 = [1 1];
        end
        function [o1,o2,o3,o4,o5,o6,o7,o8,o9] = getOutputDataTypeImpl(~)
            o1 = 'double'; o2 = 'double'; o3 = 'double'; o4 = 'double'; o5 = 'double';
            o6 = 'double'; o7 = 'double'; o8 = 'double'; o9 = 'boolean';
        end
        function [o1,o2,o3,o4,o5,o6,o7,o8,o9] = isOutputComplexImpl(~)
            o1 = false; o2 = false; o3 = false; o4 = false; o5 = false;
            o6 = false; o7 = false; o8 = false; o9 = false;
        end
        function [o1,o2,o3,o4,o5,o6,o7,o8,o9] = isOutputFixedSizeImpl(~)
            o1 = true; o2 = true; o3 = true; o4 = true; o5 = true;
            o6 = true; o7 = true; o8 = true; o9 = true;
        end
        function [n1,n2,n3,n4,n5,n6,n7,n8,n9] = getOutputNamesImpl(~)
            n1 = 'arrived'; n2 = 'uploaded'; n3 = 'autoCleared';
            n4 = 'queueB'; n5 = 'queueC'; n6 = 'reviewersBusy';
            n7 = 'reviewed'; n8 = 'summary'; n9 = 'done';
        end
        function n = getInputNamesImpl(~), n = 't'; end

        function setupImpl(obj, ~)
            M = obj.MaxCases; pad = obj.MaxReviewers + 8;
            obj.ArrTime = zeros(M, 1);   obj.ArrPhc = zeros(M, 1);
            obj.Tier = zeros(M, 1);      obj.UploadDone = zeros(M, 1);
            obj.UploadWait = zeros(M, 1); obj.UploadSecPerPhc = zeros(obj.MaxPhcs, 1);
            obj.NeedsReview = zeros(M, 1); obj.Remaining = zeros(M, 1);
            obj.Drawn = zeros(M, 1);     obj.ReviewStart = nan(M, 1);
            obj.ReviewEnd = nan(M, 1);   obj.SortedUploadDone = zeros(M, 1);
            obj.SortedUploadDoneA = zeros(M, 1);
            obj.QB = zeros(M + pad, 1);  obj.QC = zeros(M + 1, 1);
            obj.SrvBusyUntil = zeros(obj.MaxReviewers, 1);
            obj.SrvCase = zeros(obj.MaxReviewers, 1);
            obj.SrvTier = zeros(obj.MaxReviewers, 1);
            obj.Summary = nan(1, 13);
            obj.Horizon = 0; obj.NArr = 0; obj.NR = 0; obj.NA = 0;
            obj.HB = 0; obj.TB = 0; obj.HC = 0; obj.TC = 0; obj.Qi = 0; obj.K = 0;
            obj.PtrArrived = 0; obj.PtrUploaded = 0; obj.PtrAuto = 0;
            obj.ReviewedDone = 0; obj.Finished = false; obj.Truncated = false;
        end

        function resetImpl(obj)
            generateCases(obj);
        end

        function [arrived, uploaded, autoCleared, queueB, queueC, busy, reviewed, summary, done] = stepImpl(obj, t)
            if ~obj.Finished
                if t >= obj.Horizon
                    processReviewEvents(obj, inf);   % drain, as the reference model does
                    finalize(obj);
                else
                    processReviewEvents(obj, t);
                end
            end
            tt = t;
            if obj.Finished, tt = inf; end
            while obj.PtrArrived < obj.NArr && obj.ArrTime(obj.PtrArrived + 1) <= tt
                obj.PtrArrived = obj.PtrArrived + 1;
            end
            while obj.PtrUploaded < obj.NArr && obj.SortedUploadDone(obj.PtrUploaded + 1) <= tt
                obj.PtrUploaded = obj.PtrUploaded + 1;
            end
            while obj.PtrAuto < obj.NA && obj.SortedUploadDoneA(obj.PtrAuto + 1) <= tt
                obj.PtrAuto = obj.PtrAuto + 1;
            end
            arrived = obj.PtrArrived;
            uploaded = obj.PtrUploaded;
            autoCleared = obj.PtrAuto;
            queueB = obj.TB - obj.HB + 1;
            queueC = obj.TC - obj.HC + 1;
            busy = 0;
            for k = 1:obj.K
                if obj.SrvCase(k) > 0, busy = busy + 1; end
            end
            reviewed = obj.ReviewedDone;
            summary = obj.Summary;
            done = obj.Finished;
        end
    end

    methods (Access = private)
        function generateCases(obj)
            rng(obj.RngSeed, 'twister');
            K = min(max(1, round(obj.NumOphthalmologists)), obj.MaxReviewers);
            nPhc = min(max(1, round(obj.NumPhcs)), obj.MaxPhcs);
            obj.K = K;
            secondsPerDay = obj.WorkingHoursPerDay * 3600;
            obj.Horizon = obj.SimDays * secondsPerDay;
            perDay = obj.AnnualPatients / obj.WorkingDaysPerYear;
            arrivalRate = perDay / secondsPerDay;

            nb = numel(obj.BandwidthMbps);
            for ph = 1:nPhc
                bw = obj.BandwidthMbps(mod(ph - 1, nb) + 1);
                obj.UploadSecPerPhc(ph) = (obj.ImageSizeMB * 8) / bw;
            end

            % Poisson arrival count -- poissrnd_local in the reference model.
            lambda = arrivalRate * obj.Horizon;
            if lambda > 1000
                nArr = max(0, round(lambda + sqrt(lambda) * randn()));
            else
                L = exp(-lambda); k = 0; pr = 1;
                while true
                    pr = pr * rand();
                    if pr <= L, break; end
                    k = k + 1;
                end
                nArr = k;
            end
            obj.Truncated = nArr > obj.MaxCases;
            nArr = min(nArr, obj.MaxCases);
            obj.NArr = nArr;

            % Draw order matches the reference: all times, then all PHCs,
            % then all tier uniforms (rand(n,1) == n sequential rand() draws).
            obj.ArrTime(:) = inf;
            for i = 1:nArr, obj.ArrTime(i) = rand() * obj.Horizon; end
            obj.ArrTime = sort(obj.ArrTime);
            for i = 1:nArr, obj.ArrPhc(i) = randi(nPhc); end
            tf = obj.TierFractions;
            s = tf(1) + tf(2) + tf(3);
            cut1 = tf(1) / s; cut2 = (tf(1) + tf(2)) / s;
            for i = 1:nArr
                u = rand();
                if u > cut2
                    obj.Tier(i) = 3;
                elseif u > cut1
                    obj.Tier(i) = 2;
                else
                    obj.Tier(i) = 1;
                end
            end

            % Stage 1: serial FIFO upload per PHC.
            freeAt = zeros(obj.MaxPhcs, 1);
            for i = 1:nArr
                ph = obj.ArrPhc(i);
                st = max(obj.ArrTime(i), freeAt(ph));
                obj.UploadWait(i) = st - obj.ArrTime(i);
                obj.UploadDone(i) = st + obj.UploadSecPerPhc(ph);
                freeAt(ph) = obj.UploadDone(i);
            end

            % Review cases in upload-completion order (stable on index, like
            % MATLAB's sort on the reference model's index-ordered list).
            nR = 0; nA = 0;
            keys = inf(obj.MaxCases, 1);
            idx = zeros(obj.MaxCases, 1);
            for i = 1:nArr
                if obj.Tier(i) > 1
                    nR = nR + 1; keys(nR) = obj.UploadDone(i); idx(nR) = i;
                else
                    nA = nA + 1;
                end
            end
            [~, ord] = sort(keys);
            for j = 1:nR, obj.NeedsReview(j) = idx(ord(j)); end
            obj.NR = nR; obj.NA = nA;

            % Review service times, drawn in that order.
            obj.Remaining(:) = 0; obj.Drawn(:) = 0;
            for j = 1:nR
                c = obj.NeedsReview(j);
                if obj.Tier(c) == 3
                    st = -obj.ReviewSecondsC * log(rand());
                else
                    st = -obj.ReviewSecondsB * log(rand());
                end
                obj.Remaining(c) = st; obj.Drawn(c) = st;
            end

            % Sorted completion times, for the "uploaded" / "autoCleared" signals.
            all_ = inf(obj.MaxCases, 1); a_ = inf(obj.MaxCases, 1); na = 0;
            for i = 1:nArr
                all_(i) = obj.UploadDone(i);
                if obj.Tier(i) == 1, na = na + 1; a_(na) = obj.UploadDone(i); end
            end
            obj.SortedUploadDone = sort(all_);
            obj.SortedUploadDoneA = sort(a_);

            % Review-stage state.
            pad = obj.MaxReviewers + 8;
            obj.HB = pad + 1; obj.TB = pad; obj.HC = 1; obj.TC = 0; obj.Qi = 1;
            obj.SrvBusyUntil(:) = 0; obj.SrvCase(:) = 0; obj.SrvTier(:) = 0;
            obj.ReviewStart(:) = nan; obj.ReviewEnd(:) = nan;
            obj.PtrArrived = 0; obj.PtrUploaded = 0; obj.PtrAuto = 0;
            obj.ReviewedDone = 0; obj.Finished = false;
            obj.Summary(:) = nan;
        end

        function processReviewEvents(obj, tLimit)
            % The reference model's review loop, paused at tLimit. An event
            % later than tLimit is left untouched until the next step.
            K = obj.K;
            while obj.Qi <= obj.NR || (obj.TB - obj.HB + 1) + (obj.TC - obj.HC + 1) > 0 || anyBusy(obj)
                tArrive = inf;
                if obj.Qi <= obj.NR, tArrive = obj.UploadDone(obj.NeedsReview(obj.Qi)); end
                tDone = inf;
                for k = 1:K
                    if obj.SrvCase(k) > 0 && obj.SrvBusyUntil(k) < tDone
                        tDone = obj.SrvBusyUntil(k);
                    end
                end
                clock = min(tArrive, tDone);
                if ~isfinite(clock) || clock > tLimit, break; end

                for k = 1:K
                    if obj.SrvCase(k) > 0 && abs(obj.SrvBusyUntil(k) - clock) < 1e-9
                        c = obj.SrvCase(k);
                        obj.ReviewEnd(c) = clock;
                        obj.Remaining(c) = 0;
                        obj.SrvCase(k) = 0; obj.SrvTier(k) = 0;
                        obj.ReviewedDone = obj.ReviewedDone + 1;
                    end
                end
                while obj.Qi <= obj.NR && obj.UploadDone(obj.NeedsReview(obj.Qi)) <= clock + 1e-9
                    c = obj.NeedsReview(obj.Qi);
                    if obj.Tier(c) == 3
                        obj.TC = obj.TC + 1; obj.QC(obj.TC) = c;
                    else
                        obj.TB = obj.TB + 1; obj.QB(obj.TB) = c;
                    end
                    obj.Qi = obj.Qi + 1;
                end
                % Idle reviewers take Tier C first, then Tier B.
                for k = 1:K
                    if obj.SrvCase(k) == 0 && (obj.TB - obj.HB + 1) + (obj.TC - obj.HC + 1) > 0
                        if obj.TC >= obj.HC
                            c = obj.QC(obj.HC); obj.HC = obj.HC + 1;
                        else
                            c = obj.QB(obj.HB); obj.HB = obj.HB + 1;
                        end
                        startService(obj, k, c, clock);
                    end
                end
                % Tier C waiting while a reviewer holds Tier B: preempt the
                % Tier B case with the most remaining work; it RESUMES later.
                while obj.TC >= obj.HC && anyTierB(obj)
                    w = 0; best = -inf;
                    for k = 1:K
                        if obj.SrvTier(k) == 2 && (obj.SrvBusyUntil(k) - clock) > best
                            best = obj.SrvBusyUntil(k) - clock; w = k;
                        end
                    end
                    pre = obj.SrvCase(w);
                    obj.Remaining(pre) = obj.SrvBusyUntil(w) - clock;
                    obj.HB = obj.HB - 1; obj.QB(obj.HB) = pre;
                    c = obj.QC(obj.HC); obj.HC = obj.HC + 1;
                    startService(obj, w, c, clock);
                end
            end
        end

        function startService(obj, k, c, clock)
            if isnan(obj.ReviewStart(c)), obj.ReviewStart(c) = clock; end
            obj.SrvCase(k) = c; obj.SrvTier(k) = obj.Tier(c);
            obj.SrvBusyUntil(k) = clock + obj.Remaining(c);
        end

        function b = anyBusy(obj)
            b = false;
            for k = 1:obj.K
                if obj.SrvCase(k) > 0, b = true; return; end
            end
        end

        function b = anyTierB(obj)
            b = false;
            for k = 1:obj.K
                if obj.SrvTier(k) == 2, b = true; return; end
            end
        end

        function finalize(obj)
            n = obj.NArr; nR = obj.NR; K = obj.K; H = obj.Horizon;
            nPhc = min(max(1, round(obj.NumPhcs)), obj.MaxPhcs);

            % Fixed-size buffers only (code generation): unused slots hold
            % +inf so a sort pushes them past the n real values.
            M = obj.MaxCases;
            rw = inf(M, 1); upW = inf(M, 1);
            rwSum = 0; rwN = 0; totSum = 0; totN = 0; work = 0;
            for j = 1:nR
                c = obj.NeedsReview(j);
                w = obj.ReviewStart(c) - obj.UploadDone(c);
                if ~isnan(w), rwN = rwN + 1; rw(rwN) = w; rwSum = rwSum + w; end
                tt = obj.ReviewEnd(c) - obj.ArrTime(c);
                if ~isnan(tt), totN = totN + 1; totSum = totSum + tt; end
                work = work + obj.Drawn(c);
            end
            upSum = 0;
            for i = 1:n
                upW(i) = obj.UploadWait(i); upSum = upSum + upW(i);
            end
            perPhc = zeros(obj.MaxPhcs, 1);
            for i = 1:n
                ph = obj.ArrPhc(i);
                perPhc(ph) = perPhc(ph) + obj.UploadSecPerPhc(ph);
            end
            uploadUtil = (sum(perPhc(1:obj.MaxPhcs)) / nPhc) / H;   % unused PHC slots are 0
            reviewUtil = work / (K * H);
            rwMean = nanIfEmpty(rwSum, rwN) / 60;
            rwP95 = pct95(rw, rwN) / 60;
            upMean = nanIfEmpty(upSum, n) / 60;
            upP95 = pct95(upW, n) / 60;
            totMean = nanIfEmpty(totSum, totN) / 60;

            % diagnose() in the reference model: 1 review saturated,
            % 2 upload saturated, 3 review approaching capacity, 0 adequate.
            code = 0; needed = K;
            if reviewUtil > 0.85 || rwP95 > 60
                code = 1; needed = max(K + 1, ceil(K * reviewUtil / 0.70));
            elseif uploadUtil > 0.85 || upP95 > 60
                code = 2;
            elseif reviewUtil > 0.60
                code = 3; needed = K + 1;
            end

            nA = 0;
            for i = 1:n
                if obj.Tier(i) == 1, nA = nA + 1; end
            end
            obj.Summary = [n, nA, nR, 100 * uploadUtil, 100 * reviewUtil, ...
                rwMean, rwP95, upMean, upP95, totMean, code, needed, double(obj.Truncated)];
            obj.Finished = true;
        end
    end
end

function m = nanIfEmpty(s, c)
if c == 0, m = nan; else, m = s / c; end
end

function v = pct95(x, n)
% prctile_local in the reference model (interp1 over linspace(0,100,n)) on
% the first n values of x; the rest of x is +inf padding.
if n == 0, v = nan; return; end
x = sort(x);
if n == 1, v = x(1); return; end
pos = 0.95 * (n - 1) + 1;
lo = floor(pos);
if lo >= n, v = x(n); return; end
v = x(lo) + (pos - lo) * (x(lo + 1) - x(lo));
end
