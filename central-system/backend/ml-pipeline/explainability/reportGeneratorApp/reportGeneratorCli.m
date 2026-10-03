function reportGeneratorCli(inputJsonPath, outPath)
% REPORTGENERATORCLI  Deployable entry point for the per-case clinical
% rationale PDF.
%
%   Compiled form:   reportGenerator.exe <input.json> <out.pdf>
%   In MATLAB:       reportGeneratorCli('case.json', 'out.pdf')
%
%   input.json is the same shape central-system/backend/services/caseReport.js
%   writes for generateReport.m -- see that file's own header for the exact
%   field list (caseId, patientReference, drGradeCnn, lesionCounts, ...).
%
%   Prints the written PDF's path to stdout and nothing else on success, so
%   this exe is a drop-in replacement for the `matlab -batch generateReport(...)`
%   call central already makes, on a machine with no MATLAB license -- only
%   the free MATLAB Runtime.
%
%   Exit codes (compiled only):
%     0  success, PDF written, path printed to stdout
%     2  wrong number of arguments
%     3  report generation failed (bad input JSON, unreadable image, ...)
%
%   ── WHY A SEPARATE ENTRY POINT ─────────────────────────────────────────────
%   generateReport returns a path, the right shape for a MATLAB caller.
%   A deployed program communicates through argv, stdout and an exit code --
%   same reasoning as qualityGateCli.m and netraSetuCaseMain.m.
%
%   ── ERRORS GO TO STDERR, NEVER STDOUT ──────────────────────────────────────
%   Node reads stdout as the result path; an error message there would be
%   read as a (nonexistent) file rather than a failure.

if nargin < 2
    printError('usage: reportGenerator <input.json> <out.pdf>');
    exitWith(2);
    return;
end

try
    written = generateReport(char(inputJsonPath), char(outPath));
    fprintf('%s\n', written);
catch err
    printError(sprintf('%s: %s', err.identifier, err.message));
    exitWith(3);
    return;
end

if isdeployed
    exit(0);
end
end

% ───────────────────────────────────────────────────────────────────────────
function printError(msg)
fprintf(2, 'reportGenerator: %s\n', msg);
end

function exitWith(code)
% exit() terminates MATLAB itself -- correct for a compiled program, wrong in
% an interactive session, so it is guarded the same way qualityGateCli.m is.
if isdeployed
    exit(code);
else
    error('reportGeneratorCli:failed', 'reportGeneratorCli would exit with code %d', code);
end
end
