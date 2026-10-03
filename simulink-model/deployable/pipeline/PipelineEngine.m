classdef PipelineEngine < matlab.System
% PIPELINEENGINE  Code-generation-compatible engine of the full NetraSetu pipeline.
%
%   The core of netraSetuPipelineLive.slx -- the Simulink Compiler deployable
%   twin of ../../netraSetuPipeline.slx (the interactive SimEvents dashboard
%   model, which stays as it is). SimEvents blocks cannot generate code, so
%   that model cannot be compiled into an app; this engine reproduces its
%   stages with blocks that can.
%
%   STAGES (same as buildFullPipelineModel.m)
%     arrivals (exponential, live mean) -> capture queue (200) -> quality gate
%     (one camera per PHC; up to 3 retakes inside the service time, abandoned
%     if still unusable) -> PHC sync queue -> network upload (one link per
%     PHC; switchable) -> grading queue -> grading server (capacity 2;
%     switchable; fails at a rate and retries up to 3 attempts, then the case
%     is failed) -> tier triage (Tier A auto-clears) -> review queue (Tier C
%     first) -> reviewers (Tier C preempts Tier B, which RESUMES) -> Tier C
%     referred, Tier B referred at the referable rate, else cleared.
%
%   LIVE INPUTS (sampled every step -- 5 s in netraSetuPipelineLive.slx --
%   changeable while it runs)
%     meanIatSec   mean seconds between arrivals ("patients per hour")
%     reviewScale  multiplier on review time ("review speed")
%     networkUp    1 = district link up, 0 = down
%     gradingUp    1 = central grading up, 0 = down
%
%   ONE DELIBERATE DIFFERENCE FROM THE SIMEVENTS MODEL
%     There an outage is a very long service time (its Entity Gate could not
%     take a switch signal), so the case already in service when the switch
%     flips is stuck for ~11 days. Here an outage is what it really is: no
%     new upload / grading STARTS while the switch is off; work in progress
%     finishes, and the backlog drains when it comes back.
%
%   Events are processed in continuous time: every arrival, completion,
%   retry and preemption with time <= t is handled, in time order, at the
%   step for t. Utilisations are exact time integrals of servers busy.

    properties
        NumPhcs             = 10
        NumOphthalmologists = 2
        GradingConcurrency  = 2
        CaptureSeconds      = 90
        QualityPassRate     = 0.926
        UploadSeconds       = 29.6
        GradingSeconds      = 39
        GradingFailureRate  = 0.05
        MaxAttempts         = 3
        TierFractions       = [0.384 0.438 0.178]
        ReviewSecondsB      = 30
        ReviewSecondsC      = 240
        ReferableFraction   = 0.30
        RngSeed             = 42
    end

    properties (Nontunable)
        MaxEntities  = 100000
        MaxServers   = 50
        MaxReviewers = 8
        CaptureQueueCapacity = 200
    end

    properties (Access = private)
        % per entity
        Tier; Ok; Retakes; Attempts; Remaining; SvcDrawn
        NEnt
        % arrivals
        NextArrival; ArrivalBlocked
        % FIFOs (ring buffers): capture, sync, grading; review = C fifo + B deque
        QCap; HCap; NCap
        QSync; HSync; NSync
        QGrad; HGrad; NGrad
        QRevC; HRevC; NRevC
        QRevB; HRevB; NRevB
        % servers
        CapBusy; CapEnt
        UpBusy; UpEnt
        GrBusy; GrEnt
        RvBusy; RvEnt
        % counters
        CntArrived; CntAbandoned; CntAuto; CntReferred; CntCleared; CntFailed; CntRetakes
        % utilisation integrals
        LastT; IntUp; IntGr; IntRv; IntCap
        % live inputs
        CurIat; CurScale; CurNet; CurGrade
    end

    methods
        function obj = PipelineEngine(varargin)
            setProperties(obj, nargin, varargin{:});
        end
    end

    methods (Access = protected)
        function n = getNumInputsImpl(~),  n = 5; end
        function n = getNumOutputsImpl(~), n = 1; end
        function s = getOutputSizeImpl(~), s = [1 26]; end
        function d = getOutputDataTypeImpl(~), d = 'double'; end
        function c = isOutputComplexImpl(~), c = false; end
        function f = isOutputFixedSizeImpl(~), f = true; end
        function [a, b, c, d, e] = getInputNamesImpl(~)
            a = 't'; b = 'meanIatSec'; c = 'reviewScale'; d = 'networkUp'; e = 'gradingUp';
        end
        function n = getOutputNamesImpl(~), n = 'state'; end

        function setupImpl(obj, ~, ~, ~, ~, ~)
            M = obj.MaxEntities; S = obj.MaxServers; R = obj.MaxReviewers;
            obj.Tier = zeros(M, 1); obj.Ok = false(M, 1); obj.Retakes = zeros(M, 1);
            obj.Attempts = zeros(M, 1); obj.Remaining = zeros(M, 1); obj.SvcDrawn = false(M, 1);
            obj.QCap = zeros(M, 1); obj.QSync = zeros(M, 1); obj.QGrad = zeros(M, 1);
            obj.QRevC = zeros(M, 1); obj.QRevB = zeros(M, 1);
            obj.CapBusy = zeros(S, 1); obj.CapEnt = zeros(S, 1);
            obj.UpBusy = zeros(S, 1);  obj.UpEnt = zeros(S, 1);
            obj.GrBusy = zeros(R, 1);  obj.GrEnt = zeros(R, 1);
            obj.RvBusy = zeros(R, 1);  obj.RvEnt = zeros(R, 1);
            resetState(obj);
        end

        function resetImpl(obj)
            resetState(obj);
        end

        function y = stepImpl(obj, t, meanIat, scale, netUp, gradeUp)
            obj.CurIat = max(1, meanIat);
            obj.CurScale = max(0.01, scale);
            obj.CurNet = netUp > 0.5;
            obj.CurGrade = gradeUp > 0.5;
            if isinf(obj.NextArrival) && ~obj.ArrivalBlocked && obj.NEnt < obj.MaxEntities
                obj.NextArrival = t + drawExp(obj.CurIat);   % first arrival
            end
            % Every event with time <= t, in time order.
            while true
                [te, kind, k] = nextEvent(obj);
                if te > t, break; end
                integrate(obj, te);
                switch kind
                    case 1, arrive(obj, te);
                    case 2, captureDone(obj, k, te);
                    case 3, uploadDone(obj, k, te);
                    case 4, gradingDone(obj, k, te);
                    otherwise, reviewDone(obj, k, te);
                end
                startWork(obj, te);
            end
            integrate(obj, t);
            startWork(obj, t);   % a switch flipped back on starts work now
            y = stateVector(obj, t);
        end
    end

    methods (Access = private)
        function resetState(obj)
            rng(obj.RngSeed, 'twister');
            obj.NEnt = 0; obj.NextArrival = inf; obj.ArrivalBlocked = false;
            obj.HCap = 1; obj.NCap = 0; obj.HSync = 1; obj.NSync = 0;
            obj.HGrad = 1; obj.NGrad = 0; obj.HRevC = 1; obj.NRevC = 0;
            obj.HRevB = 1; obj.NRevB = 0;
            obj.CapBusy(:) = inf; obj.CapEnt(:) = 0;
            obj.UpBusy(:) = inf;  obj.UpEnt(:) = 0;
            obj.GrBusy(:) = inf;  obj.GrEnt(:) = 0;
            obj.RvBusy(:) = inf;  obj.RvEnt(:) = 0;
            obj.CntArrived = 0; obj.CntAbandoned = 0; obj.CntAuto = 0;
            obj.CntReferred = 0; obj.CntCleared = 0; obj.CntFailed = 0; obj.CntRetakes = 0;
            obj.LastT = 0; obj.IntUp = 0; obj.IntGr = 0; obj.IntRv = 0; obj.IntCap = 0;
            obj.CurIat = 72; obj.CurScale = 1; obj.CurNet = true; obj.CurGrade = true;
        end

        function [te, kind, k] = nextEvent(obj)
            te = inf; kind = 0; k = 0;
            if ~obj.ArrivalBlocked && obj.NextArrival < te
                te = obj.NextArrival; kind = 1;
            end
            % Explicit loops, not min() over a runtime-length slice: code
            % generation needs fixed sizes.
            for i = 1:nP(obj)
                if obj.CapBusy(i) < te, te = obj.CapBusy(i); kind = 2; k = i; end
            end
            for i = 1:nP(obj)
                if obj.UpBusy(i) < te, te = obj.UpBusy(i); kind = 3; k = i; end
            end
            for i = 1:nG(obj)
                if obj.GrBusy(i) < te, te = obj.GrBusy(i); kind = 4; k = i; end
            end
            for i = 1:nR(obj)
                if obj.RvBusy(i) < te, te = obj.RvBusy(i); kind = 5; k = i; end
            end
        end

        function integrate(obj, t)
            dt = t - obj.LastT;
            if dt > 0
                obj.IntCap = obj.IntCap + dt * countBusy(obj.CapBusy, nP(obj));
                obj.IntUp = obj.IntUp + dt * countBusy(obj.UpBusy, nP(obj));
                obj.IntGr = obj.IntGr + dt * countBusy(obj.GrBusy, nG(obj));
                obj.IntRv = obj.IntRv + dt * countBusy(obj.RvBusy, nR(obj));
                obj.LastT = t;
            end
        end

        % ── events ─────────────────────────────────────────────────────────
        function arrive(obj, te)
            if obj.NCap >= obj.CaptureQueueCapacity
                obj.ArrivalBlocked = true;      % generator blocks, as in SimEvents
                return
            end
            if obj.NEnt >= obj.MaxEntities
                obj.NextArrival = inf; return
            end
            obj.NEnt = obj.NEnt + 1; e = obj.NEnt;
            u = rand();
            tf = obj.TierFractions;
            if u < tf(1)
                obj.Tier(e) = 1;
            elseif u < tf(1) + tf(2)
                obj.Tier(e) = 2;
            else
                obj.Tier(e) = 3;
            end
            obj.Attempts(e) = 0; obj.SvcDrawn(e) = false; obj.Remaining(e) = 0;
            obj.CntArrived = obj.CntArrived + 1;
            [obj.QCap, obj.HCap, obj.NCap] = pushBack(obj.QCap, obj.HCap, obj.NCap, e);
            obj.NextArrival = te + drawExp(obj.CurIat);
        end

        function captureDone(obj, k, ~)
            e = obj.CapEnt(k);
            obj.CapBusy(k) = inf; obj.CapEnt(k) = 0;
            if obj.Ok(e)
                [obj.QSync, obj.HSync, obj.NSync] = pushBack(obj.QSync, obj.HSync, obj.NSync, e);
            else
                obj.CntAbandoned = obj.CntAbandoned + 1;
            end
        end

        function uploadDone(obj, k, ~)
            e = obj.UpEnt(k);
            obj.UpBusy(k) = inf; obj.UpEnt(k) = 0;
            [obj.QGrad, obj.HGrad, obj.NGrad] = pushBack(obj.QGrad, obj.HGrad, obj.NGrad, e);
        end

        function gradingDone(obj, k, ~)
            e = obj.GrEnt(k);
            obj.GrBusy(k) = inf; obj.GrEnt(k) = 0;
            obj.Attempts(e) = obj.Attempts(e) + 1;
            if rand() < obj.GradingFailureRate
                if obj.Attempts(e) >= obj.MaxAttempts
                    obj.CntFailed = obj.CntFailed + 1;
                else
                    % A retry waits AHEAD of the grading queue (it is held at
                    % the merge in front of the server in the SimEvents model).
                    [obj.QGrad, obj.HGrad, obj.NGrad] = pushFront(obj.QGrad, obj.HGrad, obj.NGrad, e);
                end
            elseif obj.Tier(e) == 1
                obj.CntAuto = obj.CntAuto + 1;
            elseif obj.Tier(e) == 3
                [obj.QRevC, obj.HRevC, obj.NRevC] = pushBack(obj.QRevC, obj.HRevC, obj.NRevC, e);
            else
                [obj.QRevB, obj.HRevB, obj.NRevB] = pushBack(obj.QRevB, obj.HRevB, obj.NRevB, e);
            end
        end

        function reviewDone(obj, k, ~)
            e = obj.RvEnt(k);
            obj.RvBusy(k) = inf; obj.RvEnt(k) = 0;
            obj.Remaining(e) = 0;
            if obj.Tier(e) >= 3 || rand() < obj.ReferableFraction
                obj.CntReferred = obj.CntReferred + 1;
            else
                obj.CntCleared = obj.CntCleared + 1;
            end
        end

        % ── starting work at time tn ───────────────────────────────────────
        function startWork(obj, tn)
            % Quality gate: one camera per PHC. Retakes are decided on entry.
            for k = 1:nP(obj)
                if isinf(obj.CapBusy(k)) && obj.NCap > 0
                    [e, obj.HCap, obj.NCap] = popFront(obj.QCap, obj.HCap, obj.NCap);
                    n = 0; ok = rand() < obj.QualityPassRate;
                    while ~ok && n < 3
                        n = n + 1; ok = rand() < obj.QualityPassRate;
                    end
                    obj.Retakes(e) = n; obj.Ok(e) = ok;
                    obj.CntRetakes = obj.CntRetakes + n;
                    obj.CapEnt(k) = e; obj.CapBusy(k) = tn + obj.CaptureSeconds * (1 + n);
                    if obj.ArrivalBlocked          % space freed: the held arrival enters now
                        obj.ArrivalBlocked = false;
                        obj.NextArrival = tn;
                    end
                end
            end
            % Network upload: only while the link is up.
            if obj.CurNet
                for k = 1:nP(obj)
                    if isinf(obj.UpBusy(k)) && obj.NSync > 0
                        [e, obj.HSync, obj.NSync] = popFront(obj.QSync, obj.HSync, obj.NSync);
                        obj.UpEnt(k) = e; obj.UpBusy(k) = tn + drawExp(obj.UploadSeconds);
                    end
                end
            end
            % Grading: only while grading is up.
            if obj.CurGrade
                for k = 1:nG(obj)
                    if isinf(obj.GrBusy(k)) && obj.NGrad > 0
                        [e, obj.HGrad, obj.NGrad] = popFront(obj.QGrad, obj.HGrad, obj.NGrad);
                        obj.GrEnt(k) = e; obj.GrBusy(k) = tn + drawExp(obj.GradingSeconds);
                    end
                end
            end
            % Reviewers: idle ones take Tier C first, then Tier B.
            for k = 1:nR(obj)
                if isinf(obj.RvBusy(k)) && (obj.NRevC + obj.NRevB) > 0
                    if obj.NRevC > 0
                        [e, obj.HRevC, obj.NRevC] = popFront(obj.QRevC, obj.HRevC, obj.NRevC);
                    else
                        [e, obj.HRevB, obj.NRevB] = popFront(obj.QRevB, obj.HRevB, obj.NRevB);
                    end
                    startReview(obj, k, e, tn);
                end
            end
            % Tier C waiting and a reviewer holding Tier B: preempt the Tier B
            % case with the most work left; it goes back to the head of the
            % Tier B queue and resumes with its remaining time.
            while obj.NRevC > 0
                w = 0; best = -inf;
                for k = 1:nR(obj)
                    e = obj.RvEnt(k);
                    if e > 0 && obj.Tier(e) == 2 && (obj.RvBusy(k) - tn) > best
                        best = obj.RvBusy(k) - tn; w = k;
                    end
                end
                if w == 0, break; end
                pre = obj.RvEnt(w);
                obj.Remaining(pre) = obj.RvBusy(w) - tn;
                [obj.QRevB, obj.HRevB, obj.NRevB] = pushFront(obj.QRevB, obj.HRevB, obj.NRevB, pre);
                [e, obj.HRevC, obj.NRevC] = popFront(obj.QRevC, obj.HRevC, obj.NRevC);
                obj.RvBusy(w) = inf; obj.RvEnt(w) = 0;
                startReview(obj, w, e, tn);
            end
        end

        function startReview(obj, k, e, tn)
            if ~obj.SvcDrawn(e)
                if obj.Tier(e) == 3
                    base = obj.ReviewSecondsC;
                else
                    base = obj.ReviewSecondsB;
                end
                obj.Remaining(e) = drawExp(base * obj.CurScale);
                obj.SvcDrawn(e) = true;
            end
            obj.RvEnt(k) = e; obj.RvBusy(k) = tn + obj.Remaining(e);
        end

        function y = stateVector(obj, t)
            y = zeros(1, 26);
            y(1) = obj.CntArrived;  y(2) = obj.CntAbandoned; y(3) = obj.CntAuto;
            y(4) = obj.CntReferred; y(5) = obj.CntCleared;   y(6) = obj.CntFailed;
            y(7) = obj.NCap; y(8) = obj.NSync; y(9) = obj.NGrad; y(10) = obj.NRevC + obj.NRevB;
            y(11) = countBusy(obj.CapBusy, nP(obj));
            y(12) = countBusy(obj.UpBusy, nP(obj));
            y(13) = countBusy(obj.GrBusy, nG(obj));
            y(14) = countBusy(obj.RvBusy, nR(obj));
            for k = 1:min(8, obj.MaxReviewers)
                if k <= nR(obj) && ~isinf(obj.RvBusy(k)), y(14 + k) = 1; end
            end
            y(23) = obj.CntRetakes;
            if t > 0
                y(24) = obj.IntUp / (nP(obj) * t);
                y(25) = obj.IntGr / (nG(obj) * t);
                y(26) = obj.IntRv / (nR(obj) * t);
            end
        end

        function n = nP(obj), n = min(max(1, round(obj.NumPhcs)), obj.MaxServers); end
        function n = nG(obj), n = min(max(1, round(obj.GradingConcurrency)), obj.MaxReviewers); end
        function n = nR(obj), n = min(max(1, round(obj.NumOphthalmologists)), obj.MaxReviewers); end
    end
end

% ── helpers ──────────────────────────────────────────────────────────────────
function dt = drawExp(meanSecs)
dt = -meanSecs * log(max(rand(), 1e-12));
dt = max(dt, 1e-3);
end

function c = countBusy(busy, n)
c = 0;
for k = 1:n
    if ~isinf(busy(k)), c = c + 1; end
end
end

function [q, h, n] = pushBack(q, h, n, e)
cap = numel(q);
if n >= cap, return; end
q(mod(h - 1 + n, cap) + 1) = e;
n = n + 1;
end

function [q, h, n] = pushFront(q, h, n, e)
cap = numel(q);
if n >= cap, return; end
h = mod(h - 2, cap) + 1;
q(h) = e;
n = n + 1;
end

function [e, h, n] = popFront(q, h, n)
e = q(h);
h = mod(h, numel(q)) + 1;
n = n - 1;
end
