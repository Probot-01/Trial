function PipelineDashboardApp(varargin)
% PIPELINEDASHBOARDAPP  Interactive full-pipeline dashboard, deployable.
%
%   PipelineDashboardApp()                     open the dashboard
%   PipelineDashboardApp('--snapshot', png)    scripted 8 h run with a network
%                                              outage 2-4 h, then save the
%                                              window as an image and exit
%   PipelineDashboardApp('--json', in, out)    headless run, metrics to JSON
%
%   The Simulink Compiler counterpart of the SimEvents dashboard in
%   netraSetuPipeline.slx (which is unchanged and still the model to open in
%   Simulink). It simulates netraSetuPipelineLive.slx WHILE you watch:
%     - the live controls feed the model's root inports every 5 simulated seconds
%       (simulink.compiler.setExternalInputsFcn),
%     - the displays read its output as it runs (setExternalOutputsFcn),
%     - setPostStepFcn paces the run and keeps the window responsive, so the
%       sliders and switches work mid-run, exactly like the Simulink dashboard.
%
%   Every rate is a modelled assumption unless calibration.json marks it
%   measured; the app says so on screen.

if nargin >= 1 && strcmp(varargin{1}, '--json')
    if nargin < 3, error('usage: PipelineDashboardApp --json <params.json> <results.json>'); end
    headless(varargin{2}, varargin{3});
    return
end
snap = '';
if nargin >= 2 && strcmp(varargin{1}, '--snapshot'), snap = varargin{2}; end
dashboard(snap);
end

% ═════════════════════════════════════════════════════════════════════════════
function in = buildInput(p, hours)
mdl = 'netraSetuPipelineLive';
if ~isdeployed && ~bdIsLoaded(mdl)
    load_system(fullfile(fileparts(mfilename('fullpath')), [mdl '.slx']));
end
in = Simulink.SimulationInput(mdl);
f = {'NumPhcs', 'NumOphthalmologists', 'GradingConcurrency', 'CaptureSeconds', 'QualityPassRate', ...
     'UploadSeconds', 'GradingSeconds', 'GradingFailureRate', 'MaxAttempts', 'TierFractions', ...
     'ReviewSecondsB', 'ReviewSecondsC', 'ReferableFraction', 'RngSeed'};
for i = 1:numel(f), in = in.setVariable(f{i}, p.(f{i}), 'Workspace', mdl); end
in = in.setModelParameter('StopTime', num2str(round(hours * 3600)));
end

function headless(inPath, outPath)
p = pipelineDefaults(); hours = 8; ctl = [p.MeanIatSeconds 1 1 1];
if isfile(inPath)
    g = jsondecode(fileread(inPath)); f = fieldnames(g);
    for i = 1:numel(f)
        if isfield(p, f{i}), p.(f{i}) = reshape(double(g.(f{i})), 1, []); end
    end
    if isfield(g, 'Hours'), hours = g.Hours; end
    if isfield(g, 'MeanIatSeconds'), ctl(1) = g.MeanIatSeconds; end
end
in = buildInput(p, hours);
in = simulink.compiler.setExternalInputsFcn(in, @(id, t) ctl(id));
in = simulink.compiler.configureForDeployment(in);
out = sim(in);
d = out.state.Data;
if ndims(d) == 3, y = reshape(d(:, :, end), 1, []); else, y = d(end, :); end
r = struct('hours', hours, 'arrived', y(1), 'captureAbandoned', y(2), 'autoCleared', y(3), ...
    'referred', y(4), 'clearedByReviewer', y(5), 'gradingFailed', y(6), ...
    'phcBacklog', y(8), 'gradingBacklog', y(9), 'awaitingReview', y(10), ...
    'uploadUtilisation', y(24), 'gradingUtilisation', y(25), 'reviewerUtilisation', y(26), ...
    'params', p, 'model', 'netraSetuPipelineLive (Simulink Compiler)');
fid = fopen(outPath, 'w'); fprintf(fid, '%s', jsonencode(r, 'PrettyPrint', true)); fclose(fid);
fprintf('%d arrived, %d auto-cleared, %d referred, %d cleared by a reviewer in %g h\n', ...
    y(1), y(3), y(4), y(5), hours);
end

% ═════════════════════════════════════════════════════════════════════════════
function dashboard(snapshotPath)
INK = [0.04 0.04 0.04]; RED = [0.902 0.231 0.180]; PAPER = [0.98 0.965 0.937]; WHITE = [1 1 1];
p0 = pipelineDefaults();
mdl = 'netraSetuPipelineLive';

fig = uifigure('Name', 'NetraSetu -- Live Screening Pipeline', 'Position', [40 40 1320 800], 'Color', PAPER);
if isprop(fig, 'Theme'), fig.Theme = 'light'; end
g = uigridlayout(fig, [1 2], 'ColumnWidth', {320, '1x'}, 'BackgroundColor', PAPER);

% ── left: setup + live controls ─────────────────────────────────────────────
left = uigridlayout(g, [2 1], 'RowHeight', {'1x', 300}, 'BackgroundColor', PAPER, 'Padding', 0);
setupP = uipanel(left, 'Title', 'SETUP (before a run)', 'FontWeight', 'bold', 'BackgroundColor', PAPER);
sg = uigridlayout(setupP, [12 2], 'RowHeight', repmat({22}, 1, 12), 'ColumnWidth', {'1.4x', '1x'}, ...
    'BackgroundColor', PAPER, 'RowSpacing', 4);
fields = {
    'Hours',               'Hours to simulate',           8
    'NumPhcs',             'PHCs (cameras / links)',      p0.NumPhcs
    'NumOphthalmologists', 'Ophthalmologists (max 8)',    p0.NumOphthalmologists
    'GradingConcurrency',  'Grading concurrency',         p0.GradingConcurrency
    'TierA',               'Tier A share %',              round(100*p0.TierFractions(1), 1)
    'TierB',               'Tier B share %',              round(100*p0.TierFractions(2), 1)
    'TierC',               'Tier C share %',              round(100*p0.TierFractions(3), 1)
    'QualityPass',         'Quality first-pass %',        round(100*p0.QualityPassRate, 1)
    'GradingFail',         'Grading failure %',           round(100*p0.GradingFailureRate, 1)
    'ReviewSecondsB',      'Tier B review (s)',           p0.ReviewSecondsB
    'ReviewSecondsC',      'Tier C review (s)',           p0.ReviewSecondsC
    'RngSeed',             'Random seed',                 p0.RngSeed};
ed = struct();
for i = 1:size(fields, 1)
    uilabel(sg, 'Text', fields{i, 2});
    ed.(fields{i, 1}) = uieditfield(sg, 'numeric', 'Value', fields{i, 3}, 'ValueDisplayFormat', '%.11g');
end

liveP = uipanel(left, 'Title', 'LIVE CONTROLS (work while it runs)', 'FontWeight', 'bold', ...
    'BackgroundColor', PAPER, 'ForegroundColor', RED);
lg = uigridlayout(liveP, [7 2], 'RowHeight', {20, 34, 20, 34, 30, 30, 32}, 'ColumnWidth', {'1x', '1x'}, ...
    'BackgroundColor', PAPER, 'RowSpacing', 4);
lblPph = uilabel(lg, 'Text', ''); lblPph.Layout.Column = [1 2];
sPph = uislider(lg, 'Limits', [5 120], 'Value', 3600 / p0.MeanIatSeconds); sPph.Layout.Column = [1 2];
lblRev = uilabel(lg, 'Text', ''); lblRev.Layout.Column = [1 2];
sRev = uislider(lg, 'Limits', [0.25 3], 'Value', 1); sRev.Layout.Column = [1 2];
uilabel(lg, 'Text', 'Network link');
swNet = uiswitch(lg, 'toggle', 'Items', {'Down', 'Up'}, 'Value', 'Up', 'Orientation', 'horizontal');
uilabel(lg, 'Text', 'Grading available');
swGrd = uiswitch(lg, 'toggle', 'Items', {'Down', 'Up'}, 'Value', 'Up', 'Orientation', 'horizontal');
% Paces the compiled app can actually hold: an unpaced 8 h run measured ~200x
% real time in the exe (per-step callbacks into MATLAB set the ceiling), so
% faster fixed paces would only be labels.
ddPace = uidropdown(lg, 'Items', {'100x', '200x', 'As fast as possible'}, 'Value', '200x');
bg = uigridlayout(lg, [1 2], 'Padding', 0, 'BackgroundColor', PAPER);
btnStart = uibutton(bg, 'Text', 'START', 'FontWeight', 'bold', 'BackgroundColor', RED, 'FontColor', WHITE);
btnStop = uibutton(bg, 'Text', 'STOP', 'BackgroundColor', INK, 'FontColor', WHITE, 'Enable', 'off');

% ── right: live view ────────────────────────────────────────────────────────
right = uigridlayout(g, [5 1], 'RowHeight', {44, 150, 120, '1x', 22}, 'BackgroundColor', PAPER);
clk = uilabel(right, 'Text', 'Press START. Sliders and switches work while it runs.', ...
    'FontSize', 14, 'FontWeight', 'bold', 'FontColor', INK, 'WordWrap', 'on');
tg = uigridlayout(right, [2 4], 'BackgroundColor', PAPER, 'RowSpacing', 6, 'ColumnSpacing', 6, 'Padding', 0);
tileNames = {'phc', 'PHC backlog'; 'grd', 'Grading backlog'; 'rev', 'Awaiting review'; ...
             'ref', 'Referred + SMS'; 'auto', 'Auto-cleared (Tier A)'; 'clr', 'Cleared by reviewer'; ...
             'fail', 'Grading gave up'; 'aban', 'Capture abandoned'};
tile = struct();
for i = 1:size(tileNames, 1)
    pnl = uipanel(tg, 'BackgroundColor', WHITE);
    pg = uigridlayout(pnl, [2 1], 'RowHeight', {16, '1x'}, 'Padding', [8 2 8 2], 'BackgroundColor', WHITE);
    uilabel(pg, 'Text', upper(tileNames{i, 2}), 'FontSize', 10, 'FontColor', [0.4 0.4 0.4]);
    tile.(tileNames{i, 1}) = uilabel(pg, 'Text', '0', 'FontSize', 24, 'FontWeight', 'bold', ...
        'FontColor', INK, 'VerticalAlignment', 'top');
end
gg = uigridlayout(right, [1 3], 'ColumnWidth', {'1x', '1x', '1.3x'}, 'BackgroundColor', PAPER, 'Padding', 0);
gp1 = uipanel(gg, 'Title', 'UPLOAD LINK IN USE', 'BackgroundColor', WHITE);
gUp = uigauge(uigridlayout(gp1, [1 1], 'BackgroundColor', WHITE), 'semicircular', 'Limits', [0 100]);
gp2 = uipanel(gg, 'Title', 'GRADING LOAD', 'BackgroundColor', WHITE);
gGr = uigauge(uigridlayout(gp2, [1 1], 'BackgroundColor', WHITE), 'semicircular', 'Limits', [0 100]);
lp = uipanel(gg, 'Title', 'REVIEWERS (lit = busy)', 'BackgroundColor', WHITE);
lgr = uigridlayout(lp, [2 8], 'BackgroundColor', WHITE, 'RowHeight', {'1x', 16});
lamps = gobjects(1, 8); lampLbl = gobjects(1, 8);
for k = 1:8
    lamps(k) = uilamp(lgr, 'Color', [0.85 0.85 0.85]);
    lamps(k).Layout.Row = 1; lamps(k).Layout.Column = k;
end
for k = 1:8
    lampLbl(k) = uilabel(lgr, 'Text', sprintf('R%d', k), 'HorizontalAlignment', 'center', 'FontSize', 10);
    lampLbl(k).Layout.Row = 2; lampLbl(k).Layout.Column = k;
end
ag = uigridlayout(right, [1 2], 'BackgroundColor', PAPER, 'Padding', 0);
axP = uiaxes(ag); title(axP, 'PHC backlog over time'); xlabel(axP, 'simulated hours'); ylabel(axP, 'cases');
axR = uiaxes(ag); title(axR, 'Queues behind grading and review'); xlabel(axR, 'simulated hours'); ylabel(axR, 'cases');
uilabel(right, 'Text', ['Every rate is a modelled assumption unless calibration.json marks it measured. ' ...
    'Same stages as the SimEvents dashboard (netraSetuPipeline.slx).'], ...
    'FontAngle', 'italic', 'FontColor', [0.35 0.35 0.35]);

lnP = animatedline(axP, 'Color', INK, 'LineWidth', 1.2);
lnG = animatedline(axR, 'Color', [0.45 0.45 0.45], 'LineWidth', 1.1);
lnR = animatedline(axR, 'Color', RED, 'LineWidth', 1.2);
legend(axR, {'grading backlog', 'awaiting review'}, 'Location', 'northwest');

% ── shared run state ────────────────────────────────────────────────────────
S = struct('running', false, 'stopReq', false, 'y', zeros(1, 26), 'tSim', 0, ...
    'wall0', 0, 'lastDraw', 0, 'lastPlot', -inf, 'K', 2, 'script', false, ...
    'ctl', [p0.MeanIatSeconds 1 1 1], 'netShown', true);
% The model asks for the four control values every step (four callbacks
% per step). Reading them from the UI each time cost ~115,000 UI
% property reads per 8 h run and capped the app near 70x real time, so the
% controls write into S.ctl when they change and the callback reads only S.

updateLiveLabels();
sPph.ValueChangingFcn = @(~, ev) onPph(ev.Value);
sPph.ValueChangedFcn = @(src, ~) onPph(src.Value);
sRev.ValueChangingFcn = @(~, ev) onRev(ev.Value);
sRev.ValueChangedFcn = @(src, ~) onRev(src.Value);
swNet.ValueChangedFcn = @(src, ~) setCtl(3, double(strcmp(src.Value, 'Up')));
swGrd.ValueChangedFcn = @(src, ~) setCtl(4, double(strcmp(src.Value, 'Up')));
btnStart.ButtonPushedFcn = @(~, ~) startRun();
btnStop.ButtonPushedFcn = @(~, ~) requestStop();
fig.CloseRequestFcn = @(~, ~) closeApp();

if ~isempty(snapshotPath)
    % Scripted demo: unpaced 8 h with the network down from 2 h to 4 h.
    S.script = true; ddPace.Value = 'As fast as possible';
    startRun();
    for k = 1:4, drawnow; pause(1); end
    exportapp(fig, snapshotPath);
    delete(fig);
    return
end
uiwait(fig);

    function updateLiveLabels(pph, rs)
        if nargin < 1 || isempty(pph), pph = sPph.Value; end
        if nargin < 2 || isempty(rs), rs = sRev.Value; end
        lblPph.Text = sprintf('Patients per hour: %.0f  (one every %.0f s)', pph, 3600 / pph);
        lblRev.Text = sprintf('Review time scale: %.2fx  (lower = faster reviews)', rs);
    end

    function p = readSetup()
        p = p0;
        p.NumPhcs = round(ed.NumPhcs.Value);
        p.NumOphthalmologists = min(8, max(1, round(ed.NumOphthalmologists.Value)));
        p.GradingConcurrency = min(8, max(1, round(ed.GradingConcurrency.Value)));
        tf = [ed.TierA.Value ed.TierB.Value ed.TierC.Value];
        p.TierFractions = tf / max(sum(tf), eps);
        p.QualityPassRate = min(1, max(0.01, ed.QualityPass.Value / 100));
        p.GradingFailureRate = min(0.95, max(0, ed.GradingFail.Value / 100));
        p.ReviewSecondsB = ed.ReviewSecondsB.Value; p.ReviewSecondsC = ed.ReviewSecondsC.Value;
        p.RngSeed = round(ed.RngSeed.Value);
    end

    function onPph(v), S.ctl(1) = 3600 / max(1, v); updateLiveLabels(v, []); end
    function onRev(v), S.ctl(2) = v; updateLiveLabels([], v); end
    function setCtl(k, v), S.ctl(k) = v; end

    function v = liveInput(id, time)
        if S.script && id == 3   % --snapshot: scripted network outage from 2 h to 4 h
            up = ~(time >= 2*3600 && time < 4*3600);
            S.ctl(3) = double(up);
            if up ~= S.netShown   % touch the switch only when it actually flips
                swNet.Value = ternary(up, 'Up', 'Down'); S.netShown = up;
            end
        end
        v = S.ctl(id);
    end

    function liveOutput(~, time, data)
        S.y = reshape(double(data), 1, []); S.tSim = time;
    end

    function postStep(time)
        pace = paceValue();
        if pace > 0     % hold the run to `pace` x real time
            ahead = time / pace - toc(S.wall0);
            if ahead > 0.002, pause(min(ahead, 0.25)); end
        end
        if time - S.lastPlot >= 30   % one plot point per 30 simulated seconds
            addpoints(lnP, time / 3600, S.y(8));
            addpoints(lnG, time / 3600, S.y(9));
            addpoints(lnR, time / 3600, S.y(10));
            S.lastPlot = time;
        end
        if toc(S.wall0) - S.lastDraw > 0.25   % ~4 redraws per second
            refreshView(time);
            drawnow limitrate;   % also lets slider / switch / STOP callbacks run
            S.lastDraw = toc(S.wall0);
        end
        if S.stopReq, simulink.compiler.stopSimulation(mdl); end
    end

    function pace = paceValue()
        switch ddPace.Value
            case '100x', pace = 100;
            case '200x', pace = 200;
            otherwise, pace = 0;
        end
    end

    function refreshView(time)
        y = S.y;
        h = floor(time / 3600); m = floor(mod(time, 3600) / 60); s = floor(mod(time, 60));
        clk.Text = sprintf('Simulated time %02d:%02d:%02d   |   %d patients arrived   |   network %s, grading %s', ...
            h, m, s, y(1), ternary(S.ctl(3) > 0.5, 'up', 'DOWN'), ternary(S.ctl(4) > 0.5, 'up', 'DOWN'));
        tile.phc.Text = sprintf('%d', y(8));  tile.grd.Text = sprintf('%d', y(9));
        tile.rev.Text = sprintf('%d', y(10)); tile.ref.Text = sprintf('%d', y(4));
        tile.auto.Text = sprintf('%d', y(3)); tile.clr.Text = sprintf('%d', y(5));
        tile.fail.Text = sprintf('%d', y(6)); tile.aban.Text = sprintf('%d', y(2));
        tile.phc.FontColor = ternary(y(8) > 20, RED, INK);
        tile.grd.FontColor = ternary(y(9) > 20, RED, INK);
        gUp.Value = 100 * y(12) / max(1, S.P.NumPhcs);
        gGr.Value = 100 * y(13) / max(1, S.P.GradingConcurrency);
        for k = 1:8
            if k <= S.K
                lamps(k).Color = ternary(y(14 + k) > 0, RED, [0.85 0.85 0.85]);
            end
        end
    end

    function startRun()
        if S.running, return; end
        p = readSetup(); S.P = p; S.K = p.NumOphthalmologists;
        for k = 1:8
            lamps(k).Visible = k <= S.K; lampLbl(k).Visible = k <= S.K;
        end
        clearpoints(lnP); clearpoints(lnG); clearpoints(lnR);
        S.y = zeros(1, 26); S.lastPlot = -inf; S.lastDraw = 0; S.stopReq = false; S.running = true;
        S.ctl = [3600 / max(1, sPph.Value), sRev.Value, ...
                 double(strcmp(swNet.Value, 'Up')), double(strcmp(swGrd.Value, 'Up'))];
        S.netShown = strcmp(swNet.Value, 'Up');
        setSetupEnabled(false); btnStart.Enable = 'off'; btnStop.Enable = 'on';
        clk.Text = 'Preparing the simulation...'; drawnow;
        try
            in = buildInput(p, ed.Hours.Value);
            in = simulink.compiler.setExternalInputsFcn(in, @(id, t) liveInput(id, t));
            in = simulink.compiler.setExternalOutputsFcn(in, @(id, t, d) liveOutput(id, t, d));
            in = simulink.compiler.setPostStepFcn(in, @(t) postStep(t));
            in = simulink.compiler.configureForDeployment(in);
            S.wall0 = tic;
            sim(in);
            refreshView(S.tSim);
            y = S.y;
            clk.Text = sprintf(['Finished %.1f simulated hours: %d arrived, %d auto-cleared, %d referred, ' ...
                '%d cleared. Utilisation: upload %.0f%%, grading %.0f%%, reviewers %.0f%%.'], ...
                S.tSim / 3600, y(1), y(3), y(4), y(5), 100*y(24), 100*y(25), 100*y(26));
        catch ME
            if isvalid(fig)
                fprintf(2, 'Simulation failed: %s\n', getReport(ME, 'basic'));
                uialert(fig, ME.message, 'Simulation failed');
            end
        end
        S.running = false;
        if isvalid(fig)
            setSetupEnabled(true); btnStart.Enable = 'on'; btnStop.Enable = 'off';
        end
    end

    function requestStop()
        S.stopReq = true;
    end

    function setSetupEnabled(on)
        f = fieldnames(ed);
        for i = 1:numel(f), ed.(f{i}).Enable = on; end
    end

    function closeApp()
        if S.running
            S.stopReq = true;
            try, simulink.compiler.stopSimulation(mdl); catch, end
        end
        delete(fig);
    end
end

function v = ternary(c, a, b)
if c, v = a; else, v = b; end
end
