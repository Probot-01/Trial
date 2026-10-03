function outPath = generateReport(inputJsonPath, outPath)
% GENERATEREPORT  Per-case clinical-rationale PDF (backend plan §O, design §6.9).
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
% provenanceRows is flattened by the Node side (services/caseReport.js) into a
% uniform array so jsondecode yields a struct array, not a nested object with
% optional nulls to interrogate field by field. It is empty when no engine was
% recorded for this case, which the report states rather than papers over.
%
% Any field may be null; a null prints as "not available", never as 0 -- the
% same not-measured-vs-measured-zero rule as the rest of the pipeline.
%
% Identity on the report is the display-safe patientReference only, never the
% raw patient ID (api-contracts.md, "Global patient-reference rule").
%
% ── RENDERER ───────────────────────────────────────────────────────────────
% MATLAB Report Generator (mlreportgen.dom), as the plan specifies: real
% document structure, tables and a repeating page footer. When that toolbox is
% not installed or its licence cannot be checked out, this falls back to
% generateReportFigures.m, which draws the same report with core MATLAB only.
% Both write the same file; the fallback exists so a machine without the
% toolbox still produces a report rather than failing the request.

ensureReportGeneratorOnPath();   % this process only; never touches the saved path

if ~reportGeneratorAvailable()
    warning('generateReport:fallback', ...
        ['MATLAB Report Generator is unavailable; rendering with the core-MATLAB ' ...
         'fallback (generateReportFigures.m).']);
    outPath = generateReportFigures(inputJsonPath, outPath);
    return;
end

import mlreportgen.dom.*

in = jsondecode(fileread(inputJsonPath));
get = @(name) fieldOr(in, name);

GRADE_TEXT = { ...
    'Grade 0 - No apparent diabetic retinopathy', ...
    'Grade 1 - Mild non-proliferative DR (microaneurysms only)', ...
    'Grade 2 - Moderate non-proliferative DR', ...
    'Grade 3 - Severe non-proliferative DR', ...
    'Grade 4 - Proliferative DR (possible new vessel growth)'};
TIER_TEXT = struct( ...
    'A', 'Tier A - high-confidence, eligible for auto-clear', ...
    'B', 'Tier B - assisted review recommended', ...
    'C', 'Tier C - mandatory full ophthalmologist review');
DISCLAIMER = ['AI-ASSISTED SCREEN - REQUIRES OPHTHALMOLOGIST REVIEW. This report is ' ...
    'generated automatically from a screening photograph. It is not a diagnosis ' ...
    'and must not be used to make treatment decisions without review by a ' ...
    'qualified ophthalmologist.'];
NAVY = '#1f4a7d';

[outDir, outName] = fileparts(outPath);
d = Document(fullfile(outDir, outName), 'pdf');
d.OutputPath = fullfile(outDir, outName);
open(d);
cleanupDoc = onCleanup(@() closeIfOpen(d));

% A4 portrait with room for the standing disclaimer at the foot of every page.
layout = d.CurrentPageLayout;
layout.PageSize = PageSize('11.69in', '8.27in', 'portrait');
layout.PageMargins.Top = '0.6in';
layout.PageMargins.Bottom = '1.3in';
layout.PageMargins.Left = '0.7in';
layout.PageMargins.Right = '0.7in';
layout.PageMargins.Footer = '0.4in';

% ── The disclaimer, on EVERY page ──────────────────────────────────────────
% A page footer rather than a block at the end: a printed page that travels on
% its own must still carry the statement that this is not a diagnosis.
footer = PDFPageFooter();
fp = Paragraph(DISCLAIMER);
fp.Style = {FontFamily('Helvetica'), FontSize('7.5pt'), Bold(true), ...
            Color('#8a4b00'), OuterMargin('0pt', '0pt', '0pt', '2pt')};
append(footer, fp);
layout.PageFooters = footer;

% ═══ Page 1 ════════════════════════════════════════════════════════════════
append(d, banner('NetraSetu - Diabetic Retinopathy Screening Report', ...
                 sprintf('Case %s', str(get('caseId'))), NAVY));

append(d, kvLine('Patient reference', str(get('patientReference')), ...
                 'Age', str(get('patientAge')), ...
                 'Eye', eyeText(get('eyeLaterality'))));
append(d, kvLine('Screening site', str(get('phcName')), ...
                 'Captured', str(get('capturedAt')), '', ''));

% Images side by side, in a borderless table so they stay aligned.
imgTable = Table();
imgRow = TableRow();
append(imgRow, imageCell(get('imagePath'), 'Fundus photograph'));
append(imgRow, imageCell(get('gradcamPath'), ...
                         'Grad-CAM attention (where the classifier looked)'));
append(imgTable, imgRow);
imgTable.Style = {Border('none'), Width('100%'), ...
                  OuterMargin('0pt', '0pt', '10pt', '10pt')};
imgTable.TableEntriesStyle = {Border('none'), HAlign('center'), ...
                              InnerMargin('4pt', '4pt', '2pt', '2pt')};
append(d, imgTable);

append(d, heading('AI screening grade'));
g = get('drGradeCnn');
if isnumeric(g) && isscalar(g) && g >= 0 && g <= 4
    gradeLine = GRADE_TEXT{g + 1};
else
    gradeLine = 'Grade not available';
end
pg = Paragraph(gradeLine);
pg.Style = {FontFamily('Helvetica'), FontSize('14pt'), Bold(true), ...
            OuterMargin('0pt', '0pt', '2pt', '6pt')};
append(d, pg);

tier = get('conformalTier');
tierLine = 'Review tier not available';
if ischar(tier) && isfield(TIER_TEXT, tier), tierLine = TIER_TEXT.(tier); end
append(d, body(sprintf('%s     Classifier confidence: %s', ...
                       tierLine, pct(get('confidenceScore')))));
if ~isempty(get('tierReason'))
    append(d, body(['Why: ' str(get('tierReason'))], '9pt'));
end

% ═══ Page 2 ════════════════════════════════════════════════════════════════
br = Paragraph(' ');
br.Style = {PageBreakBefore(true)};
append(d, br);
append(d, banner('Clinical rationale', sprintf('Case %s', str(get('caseId'))), NAVY));

append(d, heading('Two independent assessments'));
append(d, body(sprintf('Branch A - image classifier (CNN):  %s', gradeOnly(get('drGradeCnn')))));
append(d, body(sprintf('Branch B - ICDR/ETDRS rule engine on detected lesions:  %s', ...
                       gradeOnly(get('drGradeRuleEngine')))));

ag = get('branchAgreement');
if isequal(ag, true)
    agText = 'The two branches AGREE.';
elseif isequal(ag, false)
    agText = 'The two branches DISAGREE - this case requires an explicit grade from the reviewer.';
elseif ~isempty(get('drGradeCnn')) && ~isempty(get('drGradeRuleEngine'))
    % Both graded, yet no verdict: the rule-engine grade is at its ceiling,
    % which means "this grade OR WORSE" -- it can neither confirm nor
    % contradict the classifier there (see branchesAgree.m).
    agText = ['Agreement not established: the rule-engine grade is its maximum ' ...
              '("this grade or worse"), so it cannot confirm the classifier here.'];
else
    agText = 'Agreement could not be assessed: one branch did not produce a grade.';
end
pa = Paragraph(agText);
pa.Style = {FontFamily('Helvetica'), FontSize('10pt'), Bold(true), ...
            OuterMargin('0pt', '0pt', '4pt', '8pt')};
append(d, pa);

append(d, heading('Lesion evidence'));
rows = {
    'Microaneurysms + haemorrhages', countOf(get('lesionCounts'), 'redTotal'), ...
        quadOf(get('lesionCounts'), 'red')
    'Hard exudates', countOf(get('lesionCounts'), 'brightTotal'), ...
        quadOf(get('lesionCounts'), 'bright')
    'Soft exudates (cotton-wool spots)', 'not assessed', ...
        'no validated detector (disclosed scope exclusion)'
    'Neovascularization suspicion score', num3(get('nvSuspicionScore')), ...
        'suspicion signal only - not a validated NV detector'
    };
lesionTable = Table([{'Finding', 'Count', 'Detail'}; rows]);
lesionTable.Style = {Border('solid', '#c8d2de', '0.5pt'), ...
                     ColSep('solid', '#c8d2de', '0.5pt'), ...
                     RowSep('solid', '#c8d2de', '0.5pt'), ...
                     Width('100%'), FontFamily('Helvetica'), FontSize('9pt')};
lesionTable.TableEntriesStyle = {InnerMargin('4pt', '4pt', '2pt', '2pt'), VAlign('top')};
lesionTable.Children(1).Style = {BackgroundColor('#eef2f7'), Bold(true)};
% Column widths: set on the header row's entries, which the PDF renderer
% applies to the whole column (TableColSpec takes no constructor arguments).
hdr = lesionTable.Children(1);
hdr.Children(1).Style = [hdr.Children(1).Style, {Width('38%')}];
hdr.Children(2).Style = [hdr.Children(2).Style, {Width('14%')}];
hdr.Children(3).Style = [hdr.Children(3).Style, {Width('48%')}];
append(d, lesionTable);
append(d, body(['Red lesions are counted as one class: the segmentation model does not ' ...
                'separate microaneurysms from haemorrhages.'], '8pt', true));

append(d, heading('Evidence summary'));
append(d, body(str(get('evidenceSummaryText')), '9pt'));

% ── How this result was produced ───────────────────────────────────────────
% The report leaves the system and goes into a patient record, so it carries
% its own provenance: which classifier build, and which engine produced each
% output. Whoever reads it later will not have the reviewer console open.
%
% provenanceRows arrives already flattened by services/caseReport.js as a
% uniform array of {label, engine, fallback, detail}, so jsondecode gives a
% struct array to loop over. Outputs nobody recorded are omitted there; when
% NOTHING was recorded the array is empty and that is said in one line.
append(d, heading('How this result was produced'));
append(d, body(sprintf('Classifier model build: %s', str(get('modelVersion')))));

rowsProv = get('provenanceRows');
if isempty(rowsProv)
    append(d, body(['The engine that produced each output was not recorded for this ' ...
                    'case. That is a gap in the record, not a statement that any ' ...
                    'particular engine ran.'], '9pt'));
else
    provCells = cell(numel(rowsProv), 3);
    anyFallback = false;
    for k = 1:numel(rowsProv)
        r = rowsProv(k);
        engineTxt = upper(str(r.engine));
        if isequal(r.fallback, true)
            engineTxt = [engineTxt ' (FALLBACK)'];   %#ok<AGROW>
            anyFallback = true;
        end
        provCells(k, :) = {str(r.label), engineTxt, str(r.detail)};
    end
    provTable = Table([{'Output', 'Engine', 'Detail'}; provCells]);
    provTable.Style = {Border('solid', '#c8d2de', '0.5pt'), ...
                       ColSep('solid', '#c8d2de', '0.5pt'), ...
                       RowSep('solid', '#c8d2de', '0.5pt'), ...
                       Width('100%'), FontFamily('Helvetica'), FontSize('8pt')};
    provTable.TableEntriesStyle = {InnerMargin('4pt', '4pt', '2pt', '2pt'), VAlign('top')};
    provTable.Children(1).Style = {BackgroundColor('#eef2f7'), Bold(true)};
    ph = provTable.Children(1);
    ph.Children(1).Style = [ph.Children(1).Style, {Width('30%')}];
    ph.Children(2).Style = [ph.Children(2).Style, {Width('18%')}];
    ph.Children(3).Style = [ph.Children(3).Style, {Width('52%')}];
    append(d, provTable);

    % A non-primary engine is a caveat on the result, not a footnote about
    % infrastructure: it means an explicit flag let a secondary implementation
    % answer where the primary one would have failed the case instead.
    if anyFallback
        pf = Paragraph(['One or more outputs above came from a NON-PRIMARY engine ' ...
                        '(marked FALLBACK). Weigh this result accordingly.']);
        pf.Style = {FontFamily('Helvetica'), FontSize('9pt'), Bold(true), ...
                    Color('#8a1f1f'), OuterMargin('0pt', '0pt', '4pt', '4pt')};
        append(d, pf);
    end
end

close(d);
clear cleanupDoc
outPath = fullfile(outDir, [outName '.pdf']);
end

% ── Availability ────────────────────────────────────────────────────────────
function tf = reportGeneratorAvailable()
% Three things must hold: the classes exist, the licence checks out, AND the
% product is actually installed. The classes ship with core MATLAB and the
% licence can be valid on a machine where the product was never installed, in
% which case only open(Document) fails -- with "not installed", as a hard
% error instead of taking the fallback renderer below.
tf = false;
if exist('mlreportgen.dom.Document', 'class') ~= 8, return; end
try
    tf = license('test', 'MATLAB_Report_Gen') == 1 ...
         && builtin('license', 'checkout', 'MATLAB_Report_Gen') == 1 ...
         && ~isempty(ver('rptgen'));
catch
    tf = false;
end
end

function closeIfOpen(d)
try, close(d); catch, end
end

% ── Building blocks ─────────────────────────────────────────────────────────
function t = banner(titleText, subtitleText, navy)
import mlreportgen.dom.*
titlePara = Paragraph(titleText);
titlePara.Style = {FontFamily('Helvetica'), FontSize('15pt'), Bold(true), ...
                   Color('white'), OuterMargin('0pt', '0pt', '0pt', '1pt')};
subPara = Paragraph(subtitleText);
subPara.Style = {FontFamily('Helvetica'), FontSize('8pt'), Color('#d7e3f4')};
cell = TableEntry();
append(cell, titlePara);
append(cell, subPara);
% Table() cannot take pre-built TableEntry objects in a cell array -- rows are
% assembled explicitly instead.
row = TableRow();
append(row, cell);
t = Table();
append(t, row);
t.Style = {Border('none'), Width('100%'), BackgroundColor(navy), ...
           OuterMargin('0pt', '0pt', '0pt', '10pt')};
t.TableEntriesStyle = {Border('none'), BackgroundColor(navy), ...
                       InnerMargin('10pt', '10pt', '7pt', '7pt')};
end

function p = kvLine(k1, v1, k2, v2, k3, v3)
import mlreportgen.dom.*
parts = {};
for pair = {{k1, v1}, {k2, v2}, {k3, v3}}
    if ~isempty(pair{1}{1})
        parts{end + 1} = sprintf('%s: %s', pair{1}{1}, pair{1}{2}); %#ok<AGROW>
    end
end
% ' | ', not spaces: a run of spaces collapses to one in the rendered PDF,
% which ran the fields together ("Patient reference: PT-K3M9XQ Age: 54").
p = Paragraph(strjoin(parts, '  |  '));
p.Style = {FontFamily('Helvetica'), FontSize('10pt'), ...
           OuterMargin('0pt', '0pt', '0pt', '3pt')};
end

function p = heading(text)
import mlreportgen.dom.*
p = Paragraph(text);
p.Style = {FontFamily('Helvetica'), FontSize('12pt'), Bold(true), ...
           Color('#1f4a7d'), OuterMargin('0pt', '0pt', '10pt', '4pt')};
end

function p = body(text, size, italic)
import mlreportgen.dom.*
if nargin < 2, size = '10pt'; end
if nargin < 3, italic = false; end
p = Paragraph(text);
p.Style = {FontFamily('Helvetica'), FontSize(size), Italic(italic), ...
           OuterMargin('0pt', '0pt', '0pt', '3pt')};
end

function cell = imageCell(imgPath, caption)
% Downscaled to a temp copy before embedding: a 4288x2848 fundus photograph
% embedded at full resolution makes a needlessly huge PDF for a 3-inch
% printed image.
import mlreportgen.dom.*
cell = TableEntry();
usable = ischar(imgPath) && ~isempty(imgPath) && isfile(imgPath);
if usable
    try
        im = readFundusImage(imgPath);
    catch
        im = imread(imgPath);
    end
    if max(size(im, 1), size(im, 2)) > 1200
        im = imresize(im, 1200 / max(size(im, 1), size(im, 2)));
    end
    tmp = [tempname '.png'];
    imwrite(im, tmp);
    img = Image(tmp);
    img.Style = {Width('3.1in'), Height('3.1in')};
    holder = Paragraph();
    holder.Style = {HAlign('center'), OuterMargin('0pt', '0pt', '0pt', '0pt')};
    append(holder, img);
    append(cell, holder);
else
    % Same footprint as an image, so the two captions stay on one line.
    miss = Paragraph('not available');
    miss.Style = {FontFamily('Helvetica'), FontSize('9pt'), Color('#777777'), ...
                  HAlign('center'), Width('3.1in'), Height('3.1in'), ...
                  Border('solid', '#dddddd', '0.5pt'), ...
                  BackgroundColor('#f4f4f4'), VAlign('middle')};
    append(cell, miss);
end
cap = Paragraph(caption);
cap.Style = {FontFamily('Helvetica'), FontSize('8.5pt'), Color('#444444'), ...
             HAlign('center'), OuterMargin('0pt', '0pt', '3pt', '0pt')};
append(cell, cap);
end

% ── Value formatting (identical rules to the fallback renderer) ─────────────
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
if strcmp(v, 'left'), s = 'Left (OS)';
elseif strcmp(v, 'right'), s = 'Right (OD)';
else, s = 'not recorded';
end
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
