function resourceModelCli(paramsJsonPath)
% RESOURCEMODELCLI  Deployable entry point for the district resource model.
%
%   Compiled form:   resourceModel.exe [paramsJsonPath]
%   In MATLAB:       resourceModelCli('params.json')
%                     resourceModelCli()               % run with defaults
%
%   paramsJsonPath, if given, is a JSON file with any subset of the fields
%   referenceQueueingModel('defaults') returns (annualPatients, numPhcs,
%   workingDaysPerYear, workingHoursPerDay, imageSizeMB, bandwidthMbps,
%   numOphthalmologists, tierFractions, reviewSecondsB, reviewSecondsC,
%   simDays, rngSeed). Fields it omits keep their default value.
%
%   Prints ONE line of JSON to stdout and nothing else on success -- the same
%   shape central-system/backend/services/resourceRecommendations.js already
%   parses from `matlab -batch referenceQueueingModel('recommend', ...)`, so
%   this exe is a drop-in replacement for that call on a machine with no
%   MATLAB licence, only the free MATLAB Runtime.
%
%   Exit codes (compiled only):
%     0  success, JSON on stdout
%     2  wrong number of arguments
%     3  the model itself failed (bad JSON, bad field, ...)
%
%   See buildResourceModelExe.m for the mcc build.
%
%   ── WHY A SEPARATE ENTRY POINT ─────────────────────────────────────────────
%   referenceQueueingModel returns a struct, the right shape for a MATLAB
%   caller and useless to a compiled executable, which communicates through
%   argv, stdout and an exit code -- same reasoning as qualityGateCli.m.
%
%   ── ERRORS GO TO STDERR, NEVER STDOUT ──────────────────────────────────────
%   Node parses stdout as JSON; an error message there would be read as a
%   malformed result rather than a failure.

if nargin > 1
    printError('usage: resourceModel [paramsJsonPath]');
    exitWith(2);
    return;
end

try
    params = referenceQueueingModel('defaults');
    if nargin == 1 && ~isempty(paramsJsonPath)
        overrides = jsondecode(fileread(char(paramsJsonPath)));
        for f = fieldnames(overrides)'
            params.(f{1}) = overrides.(f{1});
        end
    end
    r = referenceQueueingModel('recommend', params);
    disp(jsonencodeAscii(r));
catch err
    printError(sprintf('%s: %s', err.identifier, err.message));
    exitWith(3);
    return;
end
end

% ───────────────────────────────────────────────────────────────────────────
function printError(msg)
fprintf(2, 'resourceModel: %s\n', msg);
end

function exitWith(code)
% exit() terminates MATLAB itself -- correct for a compiled program, wrong in
% an interactive session, so it is guarded the same way qualityGateCli.m is.
if isdeployed
    exit(code);
else
    error('resourceModelCli:failed', 'resourceModelCli would exit with code %d', code);
end
end
