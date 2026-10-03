function results = buildResourceModelApp(outDir)
% BUILDRESOURCEMODELAPP  Package the district resource model as a standalone app.
%
%   buildResourceModelApp()          -> simulink-model/deployable/dist
%   buildResourceModelApp(outDir)
%
%   Simulink Compiler + MATLAB Compiler: DistrictResourceApp.m (the app) plus
%   districtResourceModel.slx (the model, simulated in Rapid Accelerator) ->
%   NetraSetuResourceModel.exe, which runs on any Windows PC with the free
%   MATLAB Runtime R2026a and no MATLAB or Simulink licence.
%
%   PRECONDITIONS
%     - Simulink Compiler and MATLAB Compiler installed (license('test',
%       'Simulink_Compiler')).
%     - A C compiler visible to MATLAB: the model is compiled to C for Rapid
%       Accelerator at build time. Check with mex -setup C. On the machine
%       this was first built on, that was MSYS2 MinGW-w64 GCC 13.1 via
%       MW_MINGW64_LOC (see README.md in this folder).
%     - validateDeployableResourceModel passes in 'deployment' mode. Do not
%       package a model that has not just been validated.

thisDir = fileparts(mfilename('fullpath'));
if nargin < 1 || isempty(outDir), outDir = fullfile(thisDir, 'dist'); end
addpath(thisDir); addpath(fileparts(thisDir));

if ~license('test', 'Simulink_Compiler')
    error('buildResourceModelApp:noSimulinkCompiler', 'Simulink Compiler is not licensed or installed.');
end
cc = mex.getCompilerConfigurations('C', 'Selected');
if isempty(cc)
    error('buildResourceModelApp:noCompiler', ...
        'No C compiler selected for MATLAB. Run mex -setup C first (see README.md).');
end
fprintf('[buildResourceModelApp] C compiler: %s %s\n', cc.Name, cc.Version);

slx = fullfile(thisDir, 'districtResourceModel.slx');
if ~isfile(slx), buildDeployableResourceModel(); end

if isfolder(outDir), rmdir(outDir, 's'); end
opts = compiler.build.StandaloneApplicationOptions(fullfile(thisDir, 'DistrictResourceApp.m'), ...
    'ExecutableName', 'NetraSetuResourceModel', ...
    'AdditionalFiles', {slx, fullfile(thisDir, 'DistrictScreeningEngine.m')}, ...
    'OutputDir', outDir, ...
    'Verbose', 'on');
t0 = tic;
results = compiler.build.standaloneApplication(opts);
fprintf('\n[buildResourceModelApp] built in %.0f s:\n', toc(t0));
for i = 1:numel(results.Files)
    fprintf('  %s\n', results.Files{i});
end
fprintf(['\nNext: run the exe ("NetraSetuResourceModel.exe" opens the app;\n' ...
         '"NetraSetuResourceModel.exe --json in.json out.json" runs headless)\n' ...
         'and compare its numbers with validateDeployableResourceModel.\n']);
end
