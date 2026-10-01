function p = qualityGateAssetPath(name)
% QUALITYGATEASSETPATH  Locate a bundled data file, in-MATLAB or compiled.
%
%   p = qualityGateAssetPath('cameraPresets.json')
%
%   Task 8.1.
%
%   ── WHY THIS EXISTS ────────────────────────────────────────────────────────
%   qualityGateMain used to find its presets with
%
%       fullfile(fileparts(mfilename('fullpath')), 'cameraPresets.json')
%
%   which is correct under MATLAB and WRONG inside a compiled executable. In a
%   deployed application mfilename('fullpath') resolves into the CTF archive,
%   not to a directory on disk, so fileread() fails — and it fails at the first
%   real capture on a PHC machine, not at build time, with an error that reads
%   like a missing file rather than a packaging mistake.
%
%   This is the single most common way a working MATLAB program breaks when it
%   is compiled, and it is invisible until the exe runs on a machine that has
%   no MATLAB and no source tree to accidentally fall back to.
%
%   Under `mcc -a`, added files land under ctfroot, sometimes at the root and
%   sometimes under a path mirroring their source folder depending on how they
%   were added. Rather than depend on which, this checks the plausible
%   locations and reports all of them if none matched — a build error a human
%   can act on, instead of "file not found".

candidates = {};

if isdeployed
    % Compiled: the CTF archive is expanded under ctfroot.
    %
    % MEASURED 2026-10-02 (MATLAB Compiler 26.1): `mcc -o qualityGate -a <file>`
    % puts the file at ctfroot\qualityGate\<file> -- a folder named after the
    % component, which none of the three guesses below matched. The exe only
    % worked inside the repo because the "next to the exe" candidate at the
    % end resolves to quality-gate-matlab\, i.e. the SOURCE copy. Copied
    % anywhere else it failed every capture with notFound.
    candidates{end+1} = fullfile(ctfroot, 'qualityGate', name);
    candidates{end+1} = fullfile(ctfroot, name);
    candidates{end+1} = fullfile(ctfroot, 'quality-gate-matlab', name);
    candidates{end+1} = fullfile(ctfroot, 'phc-local-app', 'backend', 'quality-gate-matlab', name);
    % Last resort inside the archive: wherever a future Compiler release
    % decides to put it. Still the bundled copy, never the source tree.
    hits = dir(fullfile(ctfroot, '**', name));
    for k = 1:numel(hits)
        candidates{end+1} = fullfile(hits(k).folder, hits(k).name); %#ok<AGROW>
    end
    % Alongside the executable, for a file shipped next to it rather than
    % baked in — useful for editing presets at a site without a rebuild.
    candidates{end+1} = fullfile(fileparts(getExePath()), name);
else
    candidates{end+1} = fullfile(fileparts(mfilename('fullpath')), name);
end

for k = 1:numel(candidates)
    if exist(candidates{k}, 'file') == 2
        p = candidates{k};
        return;
    end
end

error('qualityGateAssetPath:notFound', ...
      ['Could not locate bundled asset ''%s''. Looked in:\n  %s\n' ...
       'If this is a compiled build, the file was probably not added with ' ...
       '"mcc -a" — see buildQualityGateExe.m.'], ...
      name, strjoin(candidates, sprintf('\n  ')));
end

function exePath = getExePath()
% Path of the running executable. Guarded because this is only meaningful in a
% deployed context and must not throw during the non-deployed branch above.
try
    if isdeployed
        [~, result] = system('path');
        exePath = char(regexpi(result, 'Path=(.*?);', 'tokens', 'once'));
    else
        exePath = pwd;
    end
catch
    exePath = pwd;
end
if isempty(exePath), exePath = pwd; end
end
