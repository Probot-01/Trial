function outDir = buildReportGeneratorExe(outDir)
% BUILDREPORTGENERATOREXE  Compile the clinical-rationale PDF generator into
% a standalone executable.
%
%   buildReportGeneratorExe()          % -> reportGeneratorApp/dist
%   buildReportGeneratorExe(outDir)
%
%   Run once, on a machine that HAS MATLAB and MATLAB Compiler. The resulting
%   executable runs central-system/backend/services/caseReport.js's PDF
%   generation step (currently `matlab -batch generateReport(...)`) on a
%   machine with neither MATLAB nor a licence -- only the free MATLAB Runtime.
%
%   Entry point and its two dependencies (generateReport.m,
%   generateReportFigures.m, ensureReportGeneratorOnPath.m) are vendored into
%   this dedicated folder rather than built from
%   ml-pipeline/explainability/ directly: that folder also holds gradCam.m
%   (needs Deep Learning Toolbox for autodiff) and two test scripts, neither
%   of which this target calls -- sharing it anyway risks the same
%   dependency-analysis trouble a similarly-oversized shared directory caused
%   for the resource-model build (see simulink-model/buildResourceModelExe.m).
%
%   MATLAB Report Generator's DOM classes (mlreportgen.dom.*) are MATLAB
%   built-ins, not path-dependent .m files, so they need no -p entry --
%   confirmed with `which('mlreportgen.dom.Document')` reporting "built-in
%   method". On this machine the toolbox itself isn't licensed, so
%   generateReport.m always takes its core-MATLAB fallback
%   (generateReportFigures.m) at runtime; both paths are still in the archive.

if nargin < 1 || isempty(outDir)
    outDir = fullfile(fileparts(mfilename('fullpath')), 'dist');
end

srcDir = fileparts(mfilename('fullpath'));

if exist('mcc', 'file') == 0
    error('buildReportGeneratorExe:noCompiler', ...
          'MATLAB Compiler is not installed (mcc not found).');
end

if ~exist(outDir, 'dir'), mkdir(outDir); end

entryPoint = fullfile(srcDir, 'reportGeneratorCli.m');

% -N + explicit -p toolbox paths: without -N, mcc's dependency resolver has
% repeatedly walked into MATLAB's own Import Tool (internal.matlab.importtool
% ...) and crashed on an unrelated unresolvable symbol there -- see
% buildQualityGateExe.m's "Build 2" and buildResourceModelExe.m's history.
%
% images: imread/imresize/imwrite/imshow, used by both the Report Generator
% path and the core-MATLAB fallback renderer to embed the fundus image and
% Grad-CAM overlay.
%
% compiler + compiler/runtime: compiler alone is not enough. MATLAB's path is
% not recursive, and runtimeInitializationChecks.m -- which the compiled
% exe's own bootstrap calls -- lives specifically in the runtime subfolder.
% Omitting it produces an exe that builds cleanly and fails at launch with
% "Unrecognized function or variable 'runtimeInitializationChecks'" -- found
% by actually running the resource-model exe, not assumed.
toolboxPaths = {'images', 'compiler', fullfile('compiler', 'runtime')};
args = {'-m', entryPoint, '-o', 'reportGenerator', '-d', outDir, '-N', '-v'};
for k = 1:numel(toolboxPaths)
    args = [args, {'-p', fullfile(matlabroot, 'toolbox', toolboxPaths{k})}]; %#ok<AGROW>
end

fprintf('[buildReportGeneratorExe] compiling %s\n', entryPoint);
fprintf('[buildReportGeneratorExe] output    %s\n', outDir);

mcc(args{:});

if ispc, exeName = 'reportGenerator.exe'; else, exeName = 'reportGenerator'; end
exePath = fullfile(outDir, exeName);
if exist(exePath, 'file') ~= 2
    error('buildReportGeneratorExe:noOutput', ...
          'mcc reported success but %s does not exist.', exePath);
end

fprintf('\n[buildReportGeneratorExe] built: %s\n', exePath);
end
