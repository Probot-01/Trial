function outPath = generateReportFigures(inputJsonPath, outPath)
% GENERATEREPORTFIGURES  Core-MATLAB fallback renderer for the clinical-
% rationale PDF (backend plan §O, design §6.9).
%
% generateReport.m uses MATLAB Report Generator when it is available and falls
% back to THIS when it is not, so the report still works on a machine without
% that toolbox. Same inputs, same output file, same contract.
%
%   outPath = generateReport(inputJsonPath, outPath)
%
% inputJsonPath: a JSON file written by the Node backend (services/
% caseReport.js) holding everything the report shows -- assembled from the
% database there, so this file does no I/O beyond reading it and the images:
%
%   caseId, patientReference, patientAge, phcName, capturedAt, eyeLaterality,
%   imagePath, gradcamPath,
%   drGradeCnn, confidenceScore, conformalTier, tierReason (optional),
%   drGradeRuleEngine, branchAgreement,
%   lesionCounts {red, bright, redTotal, brightTotal},  nvSuspicionScore,
%   evidenceSummaryText, generatedAt,
%   modelVersion, provenanceRows [{label, engine, fallback, detail}]
%
% Any field may be null; a null is printed as "not available", never as 0 --
% the same not-measured-vs-measured-zero rule as the rest of the pipeline.
%
% ── HOW IT RENDERS ─────────────────────────────────────────────────────────
% Core MATLAB only: two laid-out figure pages exported with
% exportgraphics(..., 'ContentType', 'vector', 'Append', true). The result is a
% real multi-page PDF with selectable text and no toolbox dependency.
%
% Identity on the report is the display-safe patientReference only, never the
% raw patient ID (api-contracts.md, "Global patient-reference rule").

in = jsondecode(fileread(inputJsonPath));
get = @(name) fieldOr(in, name);

GRADE_TEXT = { ...
    'Grade 0 - No apparent diabetic retinopathy', ...
    'Grade 1 - Mild non-proliferative DR (microaneurysms only)', ...
    'Grade 2 - Moderate non-proliferative DR', ...
    'Grade 3 - Severe non-proliferative DR', ...
    'Grade 4 - Proliferative DR (possible new vessel growth)'};
TIER_TEXT = struct('A', 'Tier A - high-confidence, eligible for auto-clear', ...
                   'B', 'Tier B - assisted review recommended', ...
                   'C', 'Tier C - mandatory full ophthalmologist review');
DISCLAIMER = ['AI-ASSISTED SCREEN - REQUIRES OPHTHALMOLOGIST REVIEW. This report ' ...
    'is generated automatically from a screening photograph. It is not a ' ...
    'diagnosis and must not be used to make treatment decisions without ' ...
    'review by a qualified ophthalmologist.'];

W = 8.27; H = 11.69;   % A4, inches

% ═══ Page 1: identification, images, grade ══════════════════════════════════
f1 = newPage(W, H);
header(f1, W, H, 'NetraSetu - Diabetic Retinopathy Screening Report', get('caseId'));

txt(f1, 0.6, H - 1.45, sprintf('Patient reference: %s     Age: %s     Eye: %s', ...
    str(get('patientReference')), str(get('patientAge')), eyeText(get('eyeLaterality'))), 10);
txt(f1, 0.6, H - 1.75, sprintf('Screening site: %s     Captured: %s', ...
    str(get('phcName')), str(get('capturedAt'))), 10);

imgW = (W - 1.6) / 2; imgH = imgW;
putImage(f1, get('imagePath'), [0.6, H - 2.35 - imgH, imgW, imgH], 'Fundus photograph');
putImage(f1, get('gradcamPath'), [0.6 + imgW + 0.4, H - 2.35 - imgH, imgW, imgH], ...
         'Grad-CAM attention (where the classifier looked)');

y = H - 2.85 - imgH;
g = get('drGradeCnn');
if isnumeric(g) && isscalar(g) && g >= 0 && g <= 4
    gradeLine = GRADE_TEXT{g + 1};
else
    gradeLine = 'Grade not available';
end
txt(f1, 0.6, y, 'AI screening grade', 12, 'bold');
txt(f1, 0.6, y - 0.32, gradeLine, 13, 'bold');
tier = get('conformalTier');
tierLine = 'Review tier not available';
if ischar(tier) && isfield(TIER_TEXT, tier), tierLine = TIER_TEXT.(tier); end
txt(f1, 0.6, y - 0.64, sprintf('%s     Classifier confidence: %s', tierLine, pct(get('confidenceScore'))), 10);
if ~isempty(get('tierReason'))
    txt(f1, 0.6, y - 0.92, ['Why: ' str(get('tierReason'))], 9, 'normal', W - 1.2);
end

footer(f1, W, DISCLAIMER, 1, 3);

% ═══ Page 2: both branches, lesion evidence, rationale ══════════════════════
f2 = newPage(W, H);
header(f2, W, H, 'Clinical rationale', get('caseId'));

y = H - 1.5;
txt(f2, 0.6, y, 'Two independent assessments', 12, 'bold');
txt(f2, 0.6, y - 0.32, sprintf('Branch A - image classifier (CNN):  %s', gradeOnly(get('drGradeCnn'))), 10);
txt(f2, 0.6, y - 0.58, sprintf('Branch B - ICDR/ETDRS rule engine on detected lesions:  %s', ...
    gradeOnly(get('drGradeRuleEngine'))), 10);
ag = get('branchAgreement');
if isequal(ag, true)
    agText = 'The two branches AGREE.';
elseif isequal(ag, false)
    agText = 'The two branches DISAGREE - this case requires an explicit grade from the reviewer.';
elseif isnumeric(get('drGradeCnn')) && isnumeric(get('drGradeRuleEngine')) ...
        && ~isempty(get('drGradeCnn')) && ~isempty(get('drGradeRuleEngine'))
    % Both graded, yet no verdict: the rule engine's grade is at its ceiling,
    % which means "this grade OR WORSE" -- it can neither confirm nor contradict
    % the classifier at that level (see branchesAgree.m).
    agText = ['Agreement not established: the rule-engine grade is its maximum ' ...
              '("this grade or worse"), so it cannot confirm the classifier here.'];
else
    agText = 'Agreement could not be assessed: one branch did not produce a grade.';
end
txt(f2, 0.6, y - 0.86, agText, 10, 'bold');

y = y - 1.45;
txt(f2, 0.6, y, 'Lesion evidence', 12, 'bold');
lc = get('lesionCounts');
rows = {
    'Microaneurysms + haemorrhages (red lesions)', countOf(lc, 'redTotal'), quadOf(lc, 'red')
    'Hard exudates',                               countOf(lc, 'brightTotal'), quadOf(lc, 'bright')
    'Soft exudates (cotton-wool spots)',           'not assessed', 'no validated detector (disclosed scope exclusion)'
    'Neovascularization suspicion score',          num3(get('nvSuspicionScore')), 'suspicion signal only - not a validated NV detector'
    };
for i = 1:size(rows, 1)
    yy = y - 0.35 - 0.42 * (i - 1);
    txt(f2, 0.6, yy, rows{i, 1}, 10, 'bold');
    txt(f2, 4.4, yy, rows{i, 2}, 10);
    txt(f2, 0.8, yy - 0.2, rows{i, 3}, 8, 'normal', W - 1.4);
end
txt(f2, 0.6, y - 0.35 - 0.42 * 4, ['Red lesions are counted as one class: the segmentation model ' ...
    'does not separate microaneurysms from haemorrhages.'], 8, 'italic', W - 1.2);

y = y - 2.55;
txt(f2, 0.6, y, 'Evidence summary', 12, 'bold');
txt(f2, 0.6, y - 0.3, str(get('evidenceSummaryText')), 9, 'normal', W - 1.2);

footer(f2, W, DISCLAIMER, 2, 3);

% ═══ Page 3 -- how this result was produced ═════════════════════════════════
% The SAME section generateReport.m renders with the Report Generator. Both
% renderers write the same report; a fact that appears in one and not the
% other is exactly the divergence the fallback exists to avoid. It gets its
% own page here because this renderer places text by hand and page 2 has no
% room left, not because it is less important.
f3 = newPage(W, H);
header(f3, W, H, 'How this result was produced', str(get('caseId')));
y = H - 1.5;
txt(f3, 0.6, y, sprintf('Classifier model build: %s', str(get('modelVersion'))), 10, 'bold');

y = y - 0.5;
rowsProv = get('provenanceRows');
if isempty(rowsProv)
    txt(f3, 0.6, y, ['The engine that produced each output was not recorded for this ' ...
        'case. That is a gap in the record, not a statement that any particular ' ...
        'engine ran.'], 9, 'normal', W - 1.2);
else
    txt(f3, 0.6, y, 'Output', 9, 'bold');
    txt(f3, 3.4, y, 'Engine', 9, 'bold');
    anyFallback = false;
    for k = 1:numel(rowsProv)
        r = rowsProv(k);
        yy = y - 0.34 - 0.46 * (k - 1);
        engineTxt = upper(str(r.engine));
        if isequal(r.fallback, true)
            engineTxt = [engineTxt ' (FALLBACK)'];   %#ok<AGROW>
            anyFallback = true;
        end
        txt(f3, 0.6, yy, str(r.label), 9, 'bold');
        txt(f3, 3.4, yy, engineTxt, 9);
        txt(f3, 0.8, yy - 0.2, str(r.detail), 8, 'normal', W - 1.4);
    end
    if anyFallback
        yy = y - 0.34 - 0.46 * numel(rowsProv) - 0.25;
        t = txt(f3, 0.6, yy, ['One or more outputs above came from a NON-PRIMARY ' ...
            'engine (marked FALLBACK). Weigh this result accordingly.'], 9, 'bold', W - 1.2);
        t.Color = [0.54 0.12 0.12];
    end
end
footer(f3, W, DISCLAIMER, 3, 3);

% ═══ Write ══════════════════════════════════════════════════════════════════
if isfile(outPath), delete(outPath); end
exportgraphics(f1, outPath, 'ContentType', 'vector');
exportgraphics(f2, outPath, 'ContentType', 'vector', 'Append', true);
exportgraphics(f3, outPath, 'ContentType', 'vector', 'Append', true);
close([f1 f2 f3]);
end

% ── Layout helpers ──────────────────────────────────────────────────────────
function f = newPage(W, H)
f = figure('Visible', 'off', 'Units', 'inches', 'Position', [0 0 W H], ...
           'Color', 'w', 'PaperUnits', 'inches', 'PaperSize', [W H]);
% R2025a+ renders batch-mode figures in the DARK graphics theme by default,
% which turns default-coloured text near-white on this white page. Pin light.
try, f.Theme = 'light'; catch, end
axes(f, 'Units', 'normalized', 'Position', [0 0 1 1], 'Visible', 'off', ...
     'XLim', [0 W], 'YLim', [0 H]);
end

function header(f, W, H, title, caseId)
ax = f.Children(end);
patch(ax, [0 W W 0], [H - 0.95 H - 0.95 H H], [0.12 0.29 0.49], 'EdgeColor', 'none');
text(ax, 0.6, H - 0.42, title, 'Color', 'w', 'FontSize', 15, 'FontWeight', 'bold');
% Own line: a case id is a 36-character UUID and collides with the title if
% right-aligned on the same line.
text(ax, 0.6, H - 0.75, sprintf('Case %s', str(caseId)), 'Color', [0.85 0.9 1], ...
     'FontSize', 8);
end

function footer(f, W, disclaimer, page, pages)
ax = f.Children(end);
patch(ax, [0.5 W - 0.5 W - 0.5 0.5], [0.45 0.45 1.25 1.25], [1 0.95 0.85], ...
      'EdgeColor', [0.85 0.55 0.1]);
t = text(ax, 0.65, 0.85, disclaimer, 'FontSize', 8.5, 'FontWeight', 'bold', ...
         'VerticalAlignment', 'middle', 'Color', [0.45 0.2 0]);
wrapTo(t, W - 1.3);
text(ax, W / 2, 0.22, sprintf('Page %d of %d', page, pages), 'FontSize', 8, ...
     'HorizontalAlignment', 'center', 'Color', [0.4 0.4 0.4]);
end

function t = txt(f, x, y, s, size, weight, wrapWidth)
if nargin < 6, weight = 'normal'; end
ax = f.Children(end);
angle = 'normal';
if strcmp(weight, 'italic'), angle = 'italic'; weight = 'normal'; end
t = text(ax, x, y, s, 'FontSize', size, 'FontWeight', weight, 'FontAngle', angle, ...
         'VerticalAlignment', 'top', 'Interpreter', 'none', 'Color', [0.1 0.1 0.12]);
if nargin >= 7, wrapTo(t, wrapWidth); end
end

function wrapTo(t, widthIn)
% Approximate character-count wrap at the text's font size.
charsPerLine = max(20, floor(widthIn * 72 / (t.FontSize * 0.52)));
words = strsplit(t.String, ' ');
lines = {''};
for i = 1:numel(words)
    candidate = strtrim([lines{end} ' ' words{i}]);
    if numel(candidate) > charsPerLine && ~isempty(lines{end})
        lines{end + 1} = words{i}; %#ok<AGROW>
    else
        lines{end} = candidate;
    end
end
t.String = lines;
end

function putImage(f, p, posIn, caption)
W = f.Position(3); H = f.Position(4);
ax = axes(f, 'Units', 'normalized', ...
          'Position', [posIn(1) / W, posIn(2) / H, posIn(3) / W, posIn(4) / H]);
if ischar(p) && isfile(p)
    try
        im = readFundusImage(p);
    catch
        im = imread(p);
    end
    % Downscale before embedding: a 4288x2848 fundus photo embedded at full
    % resolution made exportgraphics take ~25 s per report. ~1200 px is far
    % more than a 3.4-inch printed image can show.
    if max(size(im, 1), size(im, 2)) > 1200
        im = imresize(im, 1200 / max(size(im, 1), size(im, 2)));
    end
    imshow(im, 'Parent', ax);
else
    set(ax, 'XTick', [], 'YTick', [], 'Box', 'on', 'Color', [0.95 0.95 0.95]);
    text(ax, 0.5, 0.5, 'not available', 'HorizontalAlignment', 'center', ...
         'Units', 'normalized', 'Color', [0.35 0.35 0.35]);
end
title(ax, caption, 'FontSize', 9, 'FontWeight', 'normal', 'Color', [0.1 0.1 0.12]);
end

% ── Value formatting ────────────────────────────────────────────────────────
function v = fieldOr(s, name)
if isfield(s, name) && ~isempty(s.(name)), v = s.(name); else, v = []; end
end

function s = str(v)
if isempty(v), s = 'not available';
elseif isnumeric(v) || islogical(v), s = num2str(v);
else, s = char(v);
end
end

function s = eyeText(v)
if strcmp(v, 'left'), s = 'Left (OS)'; elseif strcmp(v, 'right'), s = 'Right (OD)'; else, s = 'not recorded'; end
end

function s = gradeOnly(g)
if isnumeric(g) && isscalar(g), s = sprintf('Grade %d', g); else, s = 'not available'; end
end

function s = pct(v)
if isnumeric(v) && isscalar(v), s = sprintf('%.0f%%', 100 * v); else, s = 'not available'; end
end

function s = num3(v)
if isnumeric(v) && isscalar(v), s = sprintf('%.3f', v); else, s = 'not measured'; end
end

function s = countOf(lc, name)
if isstruct(lc) && isfield(lc, name) && isnumeric(lc.(name)) && ~isempty(lc.(name))
    s = sprintf('%d', lc.(name));
else
    s = 'not measured';
end
end

function s = quadOf(lc, name)
names = {'superior-temporal', 'inferior-temporal', 'superior-nasal', 'inferior-nasal'};
try
    names = fundusQuadrants('names');
catch
end
if isstruct(lc) && isfield(lc, name) && numel(lc.(name)) == 4
    q = lc.(name);
    parts = arrayfun(@(i) sprintf('%s %d', names{i}, q(i)), 1:4, 'UniformOutput', false);
    s = ['by quadrant: ' strjoin(parts, ', ')];
else
    s = 'quadrant breakdown not available';
end
end
