function DistrictResourceApp(varargin)
% DISTRICTRESOURCEAPP  Standalone resource-planning app for the district model.
%
%   DistrictResourceApp()                         open the app
%   DistrictResourceApp('--json', in, out)        headless: params JSON in, results JSON out
%
%   Compiled with Simulink Compiler (buildResourceModelApp.m) into a Windows
%   executable that needs only the free MATLAB Runtime. Every run simulates
%   districtResourceModel.slx through simulink.compiler.configureForDeployment
%   -- the same path in MATLAB and in the compiled app -- so what is validated
%   in MATLAB (validateDeployableResourceModel) is what ships.
%
%   Every parameter is a modelled assumption unless measured, and the app says
%   so on screen: this is a planning estimate, not a measurement.

if nargin >= 1 && strcmp(varargin{1}, '--json')
    if nargin < 3
        error('DistrictResourceApp:usage', 'usage: DistrictResourceApp --json <params.json> <results.json>');
    end
    headless(varargin{2}, varargin{3});
    return
end
if nargin >= 2 && strcmp(varargin{1}, '--snapshot')
    gui(varargin{2});   % run the defaults once, save the window as an image, exit
    return
end
gui('');
end

% ═════════════════════════════════════════════════════════════════════════════
% Simulation
% ═════════════════════════════════════════════════════════════════════════════
function p = defaults()
p = struct('AnnualPatients', 100000, 'NumPhcs', 10, 'WorkingDaysPerYear', 250, ...
    'WorkingHoursPerDay', 8, 'ImageSizeMB', 4, 'BandwidthMbps', [0.5 1 2 5], ...
    'NumOphthalmologists', 2, 'TierFractions', [0.384 0.438 0.178], ...
    'ReviewSecondsB', 30, 'ReviewSecondsC', 240, 'SimDays', 20, 'RngSeed', 42);
end

function r = simulate(p)
mdl = 'districtResourceModel';
if ~isdeployed && ~bdIsLoaded(mdl)
    load_system(fullfile(fileparts(mfilename('fullpath')), [mdl '.slx']));
end
in = Simulink.SimulationInput(mdl);
f = fieldnames(p);
for i = 1:numel(f)
    in = in.setVariable(f{i}, p.(f{i}), 'Workspace', mdl);
end
in = simulink.compiler.configureForDeployment(in);
out = sim(in);
if ~isempty(out.ErrorMessage)
    error('DistrictResourceApp:sim', '%s', out.ErrorMessage);
end
s = lastRow(out.summary);
r = struct('casesSimulated', s(1), 'casesAutoCleared', s(2), 'casesReviewed', s(3), ...
    'uploadUtilisationPct', s(4), 'reviewUtilisationPct', s(5), ...
    'reviewWaitMeanMin', s(6), 'reviewWaitP95Min', s(7), ...
    'uploadWaitMeanMin', s(8), 'uploadWaitP95Min', s(9), 'totalTimeMeanMin', s(10), ...
    'bottleneckCode', s(11), 'suggestedOphthalmologists', s(12), 'truncated', s(13) > 0);
[r.bottleneck, r.recommendation] = diagnose(r, p);
r.series = struct( ...
    'hours', out.queueB.Time / 3600, ...
    'queueB', out.queueB.Data(:), 'queueC', out.queueC.Data(:), ...
    'reviewersBusy', out.reviewersBusy.Data(:), 'reviewerUtil', out.reviewerUtil.Data(:), ...
    'arrived', out.arrived.Data(:), 'reviewed', out.reviewed.Data(:));
end

function s = lastRow(ts)
d = ts.Data;
if ndims(d) == 3, s = reshape(d(:, :, end), 1, []); else, s = d(end, :); end
end

function [bottleneck, rec] = diagnose(r, p)
% Same wording and thresholds as referenceQueueingModel.m's diagnose().
K = p.NumOphthalmologists;
switch r.bottleneckCode
    case 1
        bottleneck = 'ophthalmologist review';
        rec = sprintf(['Reviewer pool is the constraint (%.0f%% utilised, p95 wait %.0f min). ' ...
            'Add ophthalmologists: %d -> %d.'], r.reviewUtilisationPct, r.reviewWaitP95Min, ...
            K, r.suggestedOphthalmologists);
    case 2
        bottleneck = 'network upload';
        rec = sprintf(['Upload is the constraint (%.0f%% utilised, p95 wait %.0f min) while ' ...
            'reviewers sit at %.0f%%. Adding staff would not help -- raise bandwidth at the ' ...
            'slowest sites or compress before transmission.'], r.uploadUtilisationPct, ...
            r.uploadWaitP95Min, r.reviewUtilisationPct);
    case 3
        bottleneck = 'review (approaching capacity)';
        rec = sprintf(['Adequate but with little margin: review %.0f%% utilised, p95 wait %.0f min. ' ...
            'One reviewer absent, or a modest volume rise, pushes this over. Plan for %d rather than %d.'], ...
            r.reviewUtilisationPct, r.reviewWaitP95Min, K + 1, K);
    otherwise
        bottleneck = 'none -- capacity adequate';
        rec = sprintf(['Capacity is adequate: review %.0f%% utilised, upload %.0f%%, ' ...
            'mean end-to-end %.0f min. Headroom for more PHCs or higher volume.'], ...
            r.reviewUtilisationPct, r.uploadUtilisationPct, r.totalTimeMeanMin);
end
end

function n = minReviewers(p, p95LimitMin, progress)
% Smallest pool meeting the p95 review-wait target (referenceQueueingModel's
% minReviewersFor, searched up to the engine's 20-reviewer limit).
n = NaN;
for k = 1:20
    if nargin >= 3, progress(k); end
    q = p; q.NumOphthalmologists = k;
    r = simulate(q);
    if r.reviewWaitP95Min <= p95LimitMin, n = k; return; end
end
end

function problems = check(p)
problems = {};
if p.AnnualPatients <= 0, problems{end+1} = 'Annual patients must be positive.'; end
if p.NumPhcs < 1 || p.NumPhcs > 200, problems{end+1} = 'PHCs must be 1-200.'; end
if p.NumOphthalmologists < 1 || p.NumOphthalmologists > 20, problems{end+1} = 'Ophthalmologists must be 1-20.'; end
if numel(p.BandwidthMbps) ~= 4 || any(p.BandwidthMbps <= 0)
    problems{end+1} = 'Bandwidth needs exactly four positive values (Mbps).';
end
if any(p.TierFractions < 0) || sum(p.TierFractions) <= 0, problems{end+1} = 'Tier shares must be non-negative.'; end
expected = p.AnnualPatients / p.WorkingDaysPerYear * p.SimDays;
if expected > 450000
    problems{end+1} = sprintf(['About %.0f cases would be simulated; the engine holds 500,000. ' ...
        'Reduce simulated days.'], expected);
end
end

% ═════════════════════════════════════════════════════════════════════════════
% Headless (JSON)
% ═════════════════════════════════════════════════════════════════════════════
function headless(inPath, outPath)
p = defaults();
if ~isempty(inPath) && isfile(inPath)
    given = jsondecode(fileread(inPath));
    f = fieldnames(given);
    for i = 1:numel(f)
        if isfield(p, f{i}), p.(f{i}) = reshape(double(given.(f{i})), 1, []); end
    end
end
problems = check(p);
if ~isempty(problems)
    error('DistrictResourceApp:params', '%s', strjoin(problems, ' '));
end
r = simulate(p);
r = rmfield(r, 'series');
r.params = p;
r.model = 'districtResourceModel (Simulink Compiler)';
r.caveat = 'Every parameter is a modelled assumption unless stated as observed; a planning estimate, not a measurement.';
fid = fopen(outPath, 'w'); fprintf(fid, '%s', jsonencode(r, 'PrettyPrint', true)); fclose(fid);
fprintf('%s\n', r.recommendation);
end

% ═════════════════════════════════════════════════════════════════════════════
% GUI
% ═════════════════════════════════════════════════════════════════════════════
function gui(snapshotPath)
INK = [0.04 0.04 0.04]; RED = [0.902 0.231 0.180]; PAPER = [0.98 0.965 0.937];
fig = uifigure('Name', 'NetraSetu -- District Resource Model', 'Position', [60 60 1240 760], ...
    'Color', PAPER);
% Pin the light theme: on a PC in Windows dark mode the controls and axes
% otherwise turn black against this app's light panels.
if isprop(fig, 'Theme'), fig.Theme = 'light'; end
g = uigridlayout(fig, [1 2], 'ColumnWidth', {330, '1x'}, 'BackgroundColor', PAPER);

% ── Parameters ───────────────────────────────────────────────────────────────
left = uipanel(g, 'Title', 'DISTRICT PARAMETERS', 'FontWeight', 'bold', 'BackgroundColor', PAPER);
lg = uigridlayout(left, [18 2], 'RowHeight', repmat({24}, 1, 18), 'ColumnWidth', {'1.25x', '1x'}, ...
    'BackgroundColor', PAPER);
fields = {
    'AnnualPatients',      'Patients per year',            'num'
    'NumPhcs',             'PHCs',                         'num'
    'WorkingDaysPerYear',  'Working days / year',          'num'
    'WorkingHoursPerDay',  'Working hours / day',          'num'
    'NumOphthalmologists', 'Ophthalmologists',             'num'
    'TierA',               'Tier A share (auto-clear) %',  'num'
    'TierB',               'Tier B share (assisted) %',    'num'
    'TierC',               'Tier C share (full review) %', 'num'
    'ReviewSecondsB',      'Tier B review time (s)',       'num'
    'ReviewSecondsC',      'Tier C review time (s)',       'num'
    'ImageSizeMB',         'Image size (MB)',              'num'
    'BandwidthMbps',       'PHC bandwidth tiers (Mbps)',   'text'
    'SimDays',             'Days simulated',               'num'
    'RngSeed',             'Random seed',                  'num'};
ctl = struct();
for i = 1:size(fields, 1)
    uilabel(lg, 'Text', fields{i, 2}, 'FontColor', INK);
    if strcmp(fields{i, 3}, 'num')
        ctl.(fields{i, 1}) = uieditfield(lg, 'numeric', 'ValueDisplayFormat', '%.11g');
    else
        ctl.(fields{i, 1}) = uieditfield(lg, 'text');
    end
end
btnRun = uibutton(lg, 'Text', 'RUN SIMULATION', 'FontWeight', 'bold', ...
    'BackgroundColor', RED, 'FontColor', [1 1 1]);
btnRun.Layout.Column = [1 2];
btnMin = uibutton(lg, 'Text', 'FIND MINIMUM OPHTHALMOLOGISTS', 'BackgroundColor', INK, 'FontColor', [1 1 1]);
btnMin.Layout.Column = [1 2];
btnDef = uibutton(lg, 'Text', 'Reset to defaults');
btnDef.Layout.Column = [1 2];
note = uilabel(lg, 'Text', 'All inputs are modelled assumptions, not field data.', ...
    'FontAngle', 'italic', 'FontColor', [0.35 0.35 0.35], 'WordWrap', 'on');
note.Layout.Column = [1 2];

% ── Results ──────────────────────────────────────────────────────────────────
right = uigridlayout(g, [4 1], 'RowHeight', {176, 76, '1x', '1x'}, 'BackgroundColor', PAPER);
kp = uigridlayout(right, [2 4], 'BackgroundColor', PAPER);
kpi = struct();
names = {'cases', 'Cases simulated'; 'auto', 'Auto-cleared (Tier A)'; ...
         'revUtil', 'Reviewer utilisation'; 'upUtil', 'Upload utilisation'; ...
         'waitMean', 'Review wait, mean'; 'waitP95', 'Review wait, p95'; ...
         'total', 'End-to-end, mean'; 'bottle', 'Bottleneck'};
for i = 1:size(names, 1)
    pnl = uipanel(kp, 'BackgroundColor', [1 1 1]);
    pg = uigridlayout(pnl, [2 1], 'RowHeight', {16, '1x'}, 'Padding', [8 2 8 2], 'RowSpacing', 2, ...
        'BackgroundColor', [1 1 1]);
    uilabel(pg, 'Text', upper(names{i, 2}), 'FontSize', 10, 'FontColor', [0.4 0.4 0.4]);
    kpi.(names{i, 1}) = uilabel(pg, 'Text', '--', 'FontSize', 17, 'FontWeight', 'bold', 'FontColor', INK, ...
        'WordWrap', 'on', 'VerticalAlignment', 'top');
end
recBox = uitextarea(right, 'Value', {'Set the parameters and press RUN SIMULATION.'}, 'Editable', 'off', ...
    'FontSize', 13, 'BackgroundColor', [1 1 1]);
axQ = uiaxes(right); title(axQ, 'Review queue over time'); xlabel(axQ, 'working hours'); ylabel(axQ, 'cases waiting');
axU = uiaxes(right); title(axU, 'Reviewer utilisation over time (1-hour rolling average)');
xlabel(axU, 'working hours'); ylabel(axU, 'busy fraction');

setForm(defaults());
btnRun.ButtonPushedFcn = @(~, ~) onRun();
btnMin.ButtonPushedFcn = @(~, ~) onMin();
btnDef.ButtonPushedFcn = @(~, ~) setForm(defaults());
if ~isempty(snapshotPath)
    % Renders the app's own window (exportapp), not the screen.
    onRun();
    for k = 1:4, drawnow; pause(1); end   % let both charts finish rendering
    exportapp(fig, snapshotPath);
    delete(fig);
    return
end
uiwait(fig);

    function setForm(p)
        ctl.AnnualPatients.Value = p.AnnualPatients; ctl.NumPhcs.Value = p.NumPhcs;
        ctl.WorkingDaysPerYear.Value = p.WorkingDaysPerYear; ctl.WorkingHoursPerDay.Value = p.WorkingHoursPerDay;
        ctl.NumOphthalmologists.Value = p.NumOphthalmologists;
        ctl.TierA.Value = round(100 * p.TierFractions(1), 1); ctl.TierB.Value = round(100 * p.TierFractions(2), 1);
        ctl.TierC.Value = round(100 * p.TierFractions(3), 1);
        ctl.ReviewSecondsB.Value = p.ReviewSecondsB; ctl.ReviewSecondsC.Value = p.ReviewSecondsC;
        ctl.ImageSizeMB.Value = p.ImageSizeMB; ctl.BandwidthMbps.Value = strtrim(sprintf('%g ', p.BandwidthMbps));
        ctl.SimDays.Value = p.SimDays; ctl.RngSeed.Value = p.RngSeed;
    end

    function p = readForm()
        p = defaults();
        p.AnnualPatients = ctl.AnnualPatients.Value; p.NumPhcs = round(ctl.NumPhcs.Value);
        p.WorkingDaysPerYear = ctl.WorkingDaysPerYear.Value; p.WorkingHoursPerDay = ctl.WorkingHoursPerDay.Value;
        p.NumOphthalmologists = round(ctl.NumOphthalmologists.Value);
        p.TierFractions = [ctl.TierA.Value ctl.TierB.Value ctl.TierC.Value] / 100;
        p.ReviewSecondsB = ctl.ReviewSecondsB.Value; p.ReviewSecondsC = ctl.ReviewSecondsC.Value;
        p.ImageSizeMB = ctl.ImageSizeMB.Value;
        p.BandwidthMbps = str2num(ctl.BandwidthMbps.Value); %#ok<ST2NM>
        p.SimDays = round(ctl.SimDays.Value); p.RngSeed = round(ctl.RngSeed.Value);
    end

    function ok = validate(p)
        problems = check(p);
        ok = isempty(problems);
        if ~ok, uialert(fig, strjoin(problems, newline), 'Check the parameters'); end
    end

    function onRun()
        p = readForm();
        if ~validate(p), return; end
        d = uiprogressdlg(fig, 'Title', 'Simulating', 'Message', ...
            'Running the district model (the first run prepares the simulation and takes longer)...', ...
            'Indeterminate', 'on');
        try
            r = simulate(p);
            close(d);
            show(r, p);
        catch ME
            close(d);
            fprintf(2, 'Simulation failed: %s\n', getReport(ME, 'basic'));
            uialert(fig, ME.message, 'Simulation failed');
        end
    end

    function onMin()
        p = readForm();
        if ~validate(p), return; end
        d = uiprogressdlg(fig, 'Title', 'Searching', 'Message', 'Routine schedule...');
        try
            nR = minReviewers(p, 60, @(k) set(d, 'Value', k / 40, 'Message', sprintf('Routine schedule: trying %d', k)));
            q = p; q.WorkingDaysPerYear = 50;
            nC = minReviewers(q, 60, @(k) set(d, 'Value', 0.5 + k / 40, 'Message', sprintf('Camp mode (50 days): trying %d', k)));
            close(d);
            recBox.Value = {
                sprintf('Minimum ophthalmologists to hold the p95 review wait under 60 minutes, for %s patients/year:', ...
                    num2str(p.AnnualPatients))
                sprintf('  Routine (%g working days/year): %s', p.WorkingDaysPerYear, countStr(nR))
                sprintf('  Camp mode (same volume in 50 days): %s', countStr(nC))
                ''
                'Tier A share is the most influential input -- every auto-cleared case never reaches a reviewer.'};
        catch ME
            close(d);
            uialert(fig, ME.message, 'Search failed');
        end
    end

    function show(r, p)
        kpi.cases.Text = sprintf('%d', r.casesSimulated);
        kpi.auto.Text = sprintf('%.1f%%', 100 * r.casesAutoCleared / max(1, r.casesSimulated));
        kpi.revUtil.Text = sprintf('%.1f%%', r.reviewUtilisationPct);
        kpi.upUtil.Text = sprintf('%.1f%%', r.uploadUtilisationPct);
        kpi.waitMean.Text = minutes_(r.reviewWaitMeanMin);
        kpi.waitP95.Text = minutes_(r.reviewWaitP95Min);
        kpi.total.Text = minutes_(r.totalTimeMeanMin);
        kpi.bottle.Text = r.bottleneck;
        kpi.bottle.FontSize = 13;
        msg = {r.recommendation, '', sprintf('%d PHCs, %d ophthalmologists, %d days simulated.', ...
            p.NumPhcs, p.NumOphthalmologists, p.SimDays)};
        if r.truncated, msg{end+1} = 'WARNING: case limit reached; results cover the first 500,000 cases only.'; end
        recBox.Value = msg;
        s = r.series;
        plot(axQ, s.hours, s.queueB, 'Color', [0.35 0.35 0.35], 'LineWidth', 1); hold(axQ, 'on');
        plot(axQ, s.hours, s.queueC, 'Color', RED, 'LineWidth', 1.2); hold(axQ, 'off');
        legend(axQ, {'Tier B', 'Tier C'}, 'Location', 'northwest');
        % The raw signal is the instantaneous busy share (0, 1/K, ... 1);
        % one simulated hour = 60 steps of the model's 60 s clock.
        plot(axU, s.hours, movmean(s.reviewerUtil, 60), 'Color', INK, 'LineWidth', 1);
        yline(axU, mean(s.reviewerUtil), '--', sprintf('mean %.0f%%', 100 * mean(s.reviewerUtil)), ...
            'Color', RED, 'LabelHorizontalAlignment', 'left');
        ylim(axU, [0 1.05]);
    end
end

function s = minutes_(m)
if ~isfinite(m), s = '--'; elseif m < 1, s = sprintf('%.0f s', 60 * m);
elseif m < 120, s = sprintf('%.1f min', m); else, s = sprintf('%.1f h', m / 60); end
end

function s = countStr(n)
if isnan(n), s = 'more than 20 (target not met)'; else, s = sprintf('%d', n); end
end
