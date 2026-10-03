function netraSetuInferMain(mode, argPath, outputJsonPath)
% NETRASETUINFERMAIN  Deployment entry point for the NETWORK half of grading.
%
%   netraSetuInferMain branchA  <tensor.mat>  <out.json>
%   netraSetuInferMain segcheck <image.jpg>   <out.json>
%   netraSetuInferMain selftest -             <out.json>
%
%   The per-case chain (netraSetuCaseMain) is plain arithmetic on numbers a
%   caller already has. This one is the part that loads neural networks, and
%   it is packaged separately because the two have completely different
%   deployment profiles: the case chain is a 1.3 MB archive, this one carries
%   hundreds of megabytes of weights.
%
%   ── WHY THE %#function PRAGMAS BELOW ARE THE WHOLE POINT ───────────────────
%   A network imported from ONNX is not self-contained. importNetworkFromONNX
%   generates a package of custom layer classes (models/+branchA_v1/*.m and
%   friends) and the saved .mat holds REFERENCES to them. mcc analyses code by
%   following calls, and nothing in this file calls those classes by name --
%   they are only ever constructed while load() reconstitutes the net.
%
%   So without the pragmas, mcc builds happily, the archive omits every custom
%   layer, and load() fails at the first inference on a machine with no MATLAB
%   to fall back to. The failure names a missing class, not a missing
%   dependency declaration, which is why it is worth writing down here.
%
%   Branch A's imported net needs 16 of them; each segmentation net needs 5.
%
%   branchA_v2c, not branchA_v1: branchAInferMatlab.m's live default is
%   branchA_v2c (see its own cfg table), and its custom layer classes live in
%   their own +branchA_v2c package -- a different namespace from v1's, even
%   though both happen to have the same 16 ReduceMeanLayer names. Packaging
%   v1's classes here would satisfy mcc's dependency analysis but not the net
%   this archive actually loads at runtime.
%
%#function branchA_v2c.ReduceMeanLayer1000
%#function branchA_v2c.ReduceMeanLayer1001
%#function branchA_v2c.ReduceMeanLayer1002
%#function branchA_v2c.ReduceMeanLayer1003
%#function branchA_v2c.ReduceMeanLayer1004
%#function branchA_v2c.ReduceMeanLayer1005
%#function branchA_v2c.ReduceMeanLayer1006
%#function branchA_v2c.ReduceMeanLayer1007
%#function branchA_v2c.ReduceMeanLayer1008
%#function branchA_v2c.ReduceMeanLayer1009
%#function branchA_v2c.ReduceMeanLayer1010
%#function branchA_v2c.ReduceMeanLayer1011
%#function branchA_v2c.ReduceMeanLayer1012
%#function branchA_v2c.ReduceMeanLayer1013
%#function branchA_v2c.ReduceMeanLayer1014
%#function branchA_v2c.ReduceMeanLayer1015

try
    if nargin < 3
        error('netraSetuInferMain:usage', ...
              'usage: netraSetuInferMain <branchA|segcheck|selftest> <input> <output.json>');
    end

    switch lower(char(mode))
        case 'brancha'
            out = branchAInferMatlab(argPath);

        case 'segcheck'
            % Loads each segmentation net and runs ONE forward pass on a
            % zero tensor. The point is not the numbers -- it is whether a
            % deployed archive can reconstitute these networks at all, which
            % is the question the pragmas above exist to answer.
            out = segLoadCheck();

        case 'selftest'
            out = struct('deployed', isdeployed, 'ctfroot', ctfrootSafe(), ...
                         'matlabRoot', matlabroot);

        otherwise
            error('netraSetuInferMain:badMode', 'unknown mode "%s"', mode);
    end

    txt = jsonencodeAscii(out);
    fid = fopen(outputJsonPath, 'w');
    if fid < 0
        error('netraSetuInferMain:cannotWrite', 'could not open %s', outputJsonPath);
    end
    closer = onCleanup(@() fclose(fid));
    fwrite(fid, txt);
    fprintf('%s\n', outputJsonPath);
catch ME
    fprintf(2, '%s\n', jsonencode(struct('error', ME.identifier, 'message', ME.message)));
    if isdeployed, exit(1); else, rethrow(ME); end
end

if isdeployed, exit(0); end
end

% ═══════════════════════════════════════════════════════════════════════════
function out = segLoadCheck()
% Load each segmentation net from its .mat and push one zero tensor through.
%
% Sizes are the ONNX import's own geometry, and a wrong one fails loudly here
% rather than producing a silently mis-shaped mask later.
nets = { ...
    'vessel_unet_v1.mat',        [512 512 1 1]; ...
    'localization_v1.mat',       [512 512 3 1]; ...
    'bright_lesion_unet_v1.mat', [512 512 3 1]};

out = struct('nets', struct('name', {}, 'loaded', {}, 'outputSize', {}, ...
                            'loadSeconds', {}, 'forwardSeconds', {}, 'error', {}));
for k = 1:size(nets, 1)
    name = nets{k, 1};
    rec = struct('name', name, 'loaded', false, 'outputSize', [], ...
                 'loadSeconds', 0, 'forwardSeconds', 0, 'error', '');
    try
        t = tic;
        p = assetPath(name);
        loaded = load(p, 'net');
        rec.loadSeconds = toc(t);
        rec.loaded = true;

        t = tic;
        y = predict(loaded.net, dlarray(single(zeros(nets{k, 2})), 'SSCB'));
        rec.forwardSeconds = toc(t);
        rec.outputSize = size(extractdata(y));
    catch ME
        rec.error = ME.message;
    end
    out.nets(k) = rec; %#ok<AGROW>
end
out.allLoaded = all([out.nets.loaded]);
end

% ═══════════════════════════════════════════════════════════════════════════
function p = assetPath(name)
% Find a packaged data file, in MATLAB or inside a CTF archive.
%
% ── WHAT THE TRIAL BUILD ACTUALLY FOUND ────────────────────────────────────
% The first version of this guessed: ctfroot/name, ctfroot/models/name and so
% on. Every guess missed, and all three networks failed to load out of a
% 240 MB archive that definitely contained them. mcc -a does not flatten a
% file to the archive root, nor mirror the last folder or two -- it recreates
% the file's WHOLE absolute source path (minus the drive letter) under
% ctfroot, e.g. <ctfroot>/Users/<builder>/Desktop/.../ml-pipeline/models/
% vessel_unet_v1.mat
%
% That path contains the BUILD MACHINE's user name and directory layout, so
% no hard-coded candidate list can be right on another machine. Searching by
% file NAME under ctfroot is the only lookup that survives being built
% somewhere else, which is the entire point of shipping a component.
%
% Cached per name: walking a 240 MB archive is not free, and the answer
% cannot change within a run.
persistent FOUND
if isempty(FOUND), FOUND = containers.Map('KeyType', 'char', 'ValueType', 'char'); end
if isKey(FOUND, name)
    p = FOUND(name);
    return;
end

candidates = {};
if isdeployed
    hits = dir(fullfile(ctfroot, '**', name));
    for k = 1:numel(hits)
        candidates{end+1} = fullfile(hits(k).folder, hits(k).name); %#ok<AGROW>
    end
    % Beside the executable too, so an asset can be replaced at a site
    % without a rebuild.
    candidates{end+1} = fullfile(pwd, name); %#ok<AGROW>
else
    here = fileparts(mfilename('fullpath'));
    candidates = {fullfile(here, '..', 'models', name), fullfile(here, name)};
end

for k = 1:numel(candidates)
    if isfile(candidates{k})
        p = candidates{k};
        FOUND(name) = p;
        return;
    end
end
error('netraSetuInferMain:assetMissing', ...
      ['%s was not found. Tried:\n  %s\n' ...
       'If this is a compiled build, it was probably not added with mcc -a ' ...
       '-- see deploy/buildCaseChain.m.'], ...
      name, strjoin(candidates, sprintf('\n  ')));
end

function r = ctfrootSafe()
if isdeployed, r = ctfroot; else, r = '(not deployed)'; end
end
