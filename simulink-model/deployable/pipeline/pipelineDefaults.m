function p = pipelineDefaults(calibrationPath)
% PIPELINEDEFAULTS  Default parameters of the live pipeline model.
%
%   p = pipelineDefaults()
%   p = pipelineDefaults(calibrationPath)
%
%   The same defaults and the same calibration.json overrides as
%   buildFullPipelineModel.m's loadCalibration (the SimEvents dashboard
%   model), so the deployable twin starts from identical numbers. Field
%   names are the PipelineEngine property names.
%
%   One addition: ReviewSecondsC. The SimEvents model draws every review
%   from the Tier B mean (its single "Review Time" signal), so a Tier C full
%   review takes ~30 s there. The engine uses the calibrated Tier C time
%   (240 s) by default; validateLivePipelineModel sets it equal to the Tier B
%   time when comparing against the SimEvents model.

if nargin < 1 || isempty(calibrationPath)
    here = fileparts(mfilename('fullpath'));
    calibrationPath = fullfile(here, '..', '..', 'calibration.json');
    if isdeployed
        % Bundled by buildPipelineDashboardApp. Searched for inside the
        % archive rather than assumed at one path: where the compiler puts an
        % added file is exactly what broke qualityGate.exe's presets lookup.
        hits = dir(fullfile(ctfroot, '**', 'calibration.json'));
        if ~isempty(hits), calibrationPath = fullfile(hits(1).folder, hits(1).name); end
    end
end

p = struct( ...
    'MeanIatSeconds',      72, ...
    'NumPhcs',             10, ...
    'NumOphthalmologists', 2, ...
    'GradingConcurrency',  2, ...
    'CaptureSeconds',      90, ...
    'QualityPassRate',     0.885, ...
    'UploadSeconds',       29.6, ...
    'GradingSeconds',      39, ...
    'GradingFailureRate',  0.05, ...
    'MaxAttempts',         3, ...
    'TierFractions',       [0.384 0.438 0.178], ...
    'ReviewSecondsB',      30, ...
    'ReviewSecondsC',      240, ...
    'ReferableFraction',   0.30, ...
    'WorkingHoursPerDay',  8, ...
    'RngSeed',             42);

if ~isfile(calibrationPath), return; end
c = jsondecode(fileread(calibrationPath));
p.GradingSeconds      = pick(c, 'gradingSeconds',      p.GradingSeconds);
p.QualityPassRate     = pick(c, 'qualityPassRate',     p.QualityPassRate);
p.ReviewSecondsB      = pick(c, 'reviewSecondsB',      p.ReviewSecondsB);
p.ReviewSecondsC      = pick(c, 'reviewSecondsC',      p.ReviewSecondsC);
p.NumPhcs             = pick(c, 'numPhcs',             p.NumPhcs);
p.NumOphthalmologists = pick(c, 'numOphthalmologists', p.NumOphthalmologists);
p.WorkingHoursPerDay  = pick(c, 'workingHoursPerDay',  p.WorkingHoursPerDay);
tf = reshape(pick(c, 'tierFractions', p.TierFractions), 1, []);
if numel(tf) == 3, p.TierFractions = tf; end
if isfield(c, 'annualPatients') && isfield(c, 'workingDaysPerYear')
    perDay = pick(c, 'annualPatients', 100000) / pick(c, 'workingDaysPerYear', 250);
    p.MeanIatSeconds = (p.WorkingHoursPerDay * 3600) / perDay;
end
end

function v = pick(c, name, dflt)
v = dflt;
if isfield(c, name) && isstruct(c.(name)) && isfield(c.(name), 'value') && ~isempty(c.(name).value)
    v = c.(name).value;
end
end
