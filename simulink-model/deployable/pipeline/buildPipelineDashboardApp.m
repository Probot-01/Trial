function results = buildPipelineDashboardApp(outDir)
% BUILDPIPELINEDASHBOARDAPP  Package the live pipeline dashboard as a standalone app.
%
%   buildPipelineDashboardApp()          -> simulink-model/deployable/pipeline/dist
%   buildPipelineDashboardApp(outDir)
%
%   Simulink Compiler + MATLAB Compiler: PipelineDashboardApp.m plus
%   netraSetuPipelineLive.slx -> NetraSetuPipelineDashboard.exe, which runs
%   on any Windows PC with the free MATLAB Runtime R2026a.
%
%   Preconditions are the same as buildResourceModelApp.m: Simulink Compiler
%   and MATLAB Compiler installed, a C compiler selected for MATLAB
%   (mex -setup C), and validateLivePipelineModel passing.

here = fileparts(mfilename('fullpath'));
if nargin < 1 || isempty(outDir), outDir = fullfile(here, 'dist'); end
addpath(here);

if ~license('test', 'Simulink_Compiler')
    error('buildPipelineDashboardApp:noSimulinkCompiler', 'Simulink Compiler is not licensed or installed.');
end
cc = mex.getCompilerConfigurations('C', 'Selected');
if isempty(cc)
    error('buildPipelineDashboardApp:noCompiler', 'No C compiler selected for MATLAB. Run mex -setup C first.');
end
fprintf('[buildPipelineDashboardApp] C compiler: %s %s\n', cc.Name, cc.Version);

slx = fullfile(here, 'netraSetuPipelineLive.slx');
if ~isfile(slx), buildLivePipelineModel(); end

if isfolder(outDir), rmdir(outDir, 's'); end
opts = compiler.build.StandaloneApplicationOptions(fullfile(here, 'PipelineDashboardApp.m'), ...
    'ExecutableName', 'NetraSetuPipelineDashboard', ...
    'AdditionalFiles', {slx, fullfile(here, 'PipelineEngine.m'), fullfile(here, 'pipelineDefaults.m'), ...
                        fullfile(here, '..', '..', 'calibration.json')}, ...
    'OutputDir', outDir, 'Verbose', 'on');
t0 = tic;
results = compiler.build.standaloneApplication(opts);
fprintf('\n[buildPipelineDashboardApp] built in %.0f s:\n', toc(t0));
for i = 1:numel(results.Files), fprintf('  %s\n', results.Files{i}); end
end
