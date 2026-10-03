function n = ensureReportGeneratorOnPath()
% ENSUREREPORTGENERATORONPATH  Put an installed MATLAB Report Generator on THIS
% process's path, without touching the saved path.
%
%   n = ensureReportGeneratorOnPath()   % n = folders added (0 if none needed)
%
% WHY: `mpm install` copies a product's files, but its folders reach the saved
% path (pathdef.m) only through a separate step that needs admin rights here.
% Until then the licence is fine and the classes exist, yet mlreportgen's own
% "is it installed" check (which reads rptgen's Contents.m) fails, and
% open(Document) throws "MATLAB Report Generator is not installed".
%
% The fix is deliberately local. pathdef.m is shared by every MATLAB process
% on the machine, including another checkout's session running at the same
% time; rewriting it is not this code's call. Instead each process that needs
% the toolbox adds the product's own folders to its own path, read from the
% product's own path lists (toolbox/local/path/*.phl -- the same lists
% restoredefaultpath would use), and only when they are missing.
%
% Returns 0 and does nothing when the folders are already there (a machine
% whose path was saved properly) or the product is not installed at all.

persistent done
n = 0;
if ~isempty(done), return; end

phlDir = fullfile(matlabroot, 'toolbox', 'local', 'path');
files = dir(fullfile(phlDir, '*.phl'));
files = files(~cellfun(@isempty, regexp({files.name}, 'rptgen|reportgen', 'once')));

onPath = lower(strsplit(path, pathsep));
for k = 1:numel(files)
    lines = splitlines(fileread(fullfile(files(k).folder, files(k).name)));
    for j = 1:numel(lines)
        entry = strtrim(lines{j});
        if isempty(entry) || entry(1) == '%', continue; end
        folder = fullfile(matlabroot, strrep(entry, '/', filesep));
        if isfolder(folder) && ~any(strcmp(onPath, lower(folder)))
            addpath(folder);
            onPath{end + 1} = lower(folder); %#ok<AGROW>
            n = n + 1;
        end
    end
end
done = true;
end
