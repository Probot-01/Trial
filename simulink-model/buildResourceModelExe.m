function outDir = buildResourceModelExe(outDir)
% BUILDRESOURCEMODELEXE  Compile the district resource model into a
% standalone executable.
%
%   buildResourceModelExe()          % -> simulink-model/dist
%   buildResourceModelExe(outDir)
%
%   Run once, on a machine that HAS MATLAB and MATLAB Compiler. The resulting
%   executable runs the daily resource-allocation recommendation
%   (central-system/backend/services/resourceRecommendations.js) on a machine
%   with neither MATLAB nor a licence -- only the free MATLAB Runtime.
%
%   Deliberately the first of the standalone MATLAB applications attempted:
%   referenceQueueingModel.m needs no toolbox beyond base MATLAB (it uses its
%   own poissrnd_local/prctile_local specifically to avoid a Statistics
%   Toolbox dependency), so this has the smallest archive and the fewest ways
%   to fail of any compiled target in this repo.

if nargin < 1 || isempty(outDir)
    outDir = fullfile(fileparts(mfilename('fullpath')), 'dist');
end

srcDir = fullfile(fileparts(mfilename('fullpath')), 'resourceModelApp');

if exist('mcc', 'file') == 0
    error('buildResourceModelExe:noCompiler', ...
          'MATLAB Compiler is not installed (mcc not found).');
end

if ~exist(outDir, 'dir'), mkdir(outDir); end

entryPoint = fullfile(srcDir, 'resourceModelCli.m');

% The entry point lives in its OWN dedicated folder (resourceModelApp/),
% containing only the three files it actually needs (itself,
% referenceQueueingModel.m, a vendored jsonencodeAscii.m) -- not in
% simulink-model/ alongside buildFullPipelineModel.m, sweepDistrictScenarios.m
% and friends. mcc implicitly scans its entry point's WHOLE directory, and
% sharing it with those heavier Simulink/Parallel-Computing-calling scripts is
% what caused dependency analysis to either hang for 20+ minutes or crash on
% an unrelated unresolvable symbol in MATLAB's own Import Tool
% (internal.matlab.importtool...) -- confirmed by the plain default recipe
% (no -N, matching buildQualityGateExe.m's own working recipe exactly) still
% crashing the same way from the old shared location.
%
% -N: start dependency analysis from an empty path, not the full default one
% -- kept as a second safeguard now that the directory itself is clean.
%
% -p .../toolbox/compiler/runtime IS required: a build with only
% '-p toolbox/compiler' (no further subfolder) produced a working-looking
% exe that still failed at launch with "Unrecognized function or variable
% 'runtimeInitializationChecks'". That function is defined in
% toolbox/compiler/RUNTIME specifically (find it yourself with
% `which runtimeInitializationChecks` once a MATLAB session has it loaded) --
% MATLAB's path is not recursive, so adding the parent folder does not add
% this one. Confirmed by locating the actual .m file on disk, not assumed.
args = { '-m', entryPoint, ...
         '-o', 'resourceModel', ...
         '-d', outDir, ...
         '-N', ...
         '-p', fullfile(matlabroot, 'toolbox', 'compiler'), ...
         '-p', fullfile(matlabroot, 'toolbox', 'compiler', 'runtime'), ...
         '-v' };

fprintf('[buildResourceModelExe] compiling %s\n', entryPoint);
fprintf('[buildResourceModelExe] output    %s\n', outDir);

mcc(args{:});

if ispc, exeName = 'resourceModel.exe'; else, exeName = 'resourceModel'; end
exePath = fullfile(outDir, exeName);
if exist(exePath, 'file') ~= 2
    error('buildResourceModelExe:noOutput', ...
          'mcc reported success but %s does not exist.', exePath);
end

fprintf('\n[buildResourceModelExe] built: %s\n', exePath);
fprintf('\nTest with no MATLAB on PATH, only the MATLAB Runtime:\n    %s\n', exePath);
end
