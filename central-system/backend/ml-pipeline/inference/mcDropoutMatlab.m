function out = mcDropoutMatlab(net, X, opts)
% MCDROPOUTMATLAB  Task 6.1 epistemic uncertainty on the MATLAB classifier path.
%
%   out = mcDropoutMatlab(net, X)
%   out = mcDropoutMatlab(net, X, opts)
%
%   opts:
%     .passes      20     Monte-Carlo passes
%     .temperature 1.0    the same calibration temperature the point estimate uses
%     .seed        12345  for a reproducible score on a reproducible input
%     .features    []     the head's input, when the caller already has it.
%                         branchAInferMatlab already runs the trunk for the
%                         point estimate, so handing the features over makes
%                         this measurement cost a few matrix multiplies instead
%                         of a second full forward pass -- the same reuse
%                         mcDropout.py makes. X may be [] when this is given.
%
%   Returns the same fields as inference/mcDropout.py's mc_dropout(), so the two
%   classifier backends write the same quantity into
%   grading_results.uncertainty_score rather than two different numbers that
%   happen to share a column.
%
% ── WHY THIS DOES NOT CALL forward() ────────────────────────────────────────
% It cannot. forward() on this ONNX-imported network returns a bit-identical
% default output across repeated calls even though the dropout layer is
% independently confirmed stochastic when requested as an explicit intermediate
% output. branchAInferMatlab.m carried that as a known, deliberate gap and
% reported uncertaintyScore as null rather than risk a wrong number.
%
% It does not need forward() to be stochastic. Dropout is a Bernoulli mask and
% a scale; the part that must come from the network is the features and the
% head's weights, and both are readable. So the trunk runs ONCE (it is
% deterministic in eval mode -- the same optimisation mcDropout.py makes, and
% for the same reason: 20 full forwards would recompute the expensive part 19
% times for nothing), and only the mask and the head are resampled.
%
% Verified before this function was written: applying the head's own Weights
% and Bias by hand to the layer that feeds it reproduces
% predict(net, X, 'Outputs', 'x_head_Gemm') to 8.3e-07, i.e. float32 precision.
%
% ── THE ORDERING TRAP THIS FUNCTION AVOIDS ──────────────────────────────────
% In the imported MATLAB graph the layers run
%
%     ... -> x_backbone_global__2 -> x_head_Gemm -> dropout_dr -> softmax_dr
%
% i.e. dropout sits AFTER the fully-connected head. In PyTorch it sits BEFORE
% it: mcDropout.py samples `model.head(model.dropout(feats))`. In eval mode
% dropout is the identity, so both graphs produce identical outputs and nothing
% ever revealed the difference -- it appears only when dropout is switched on,
% which is exactly this measurement.
%
% Sampling the graph's own dropout position would therefore perturb the LOGITS
% where Python perturbs the FEATURES. Both produce a plausible bounded number;
% they are not the same quantity. This function follows PyTorch, because that
% is where the model was trained and what the Python backend reports.
%
% ── WHAT THE NUMBER MEANS, AND WHAT IT DOES NOT ─────────────────────────────
% One dropout layer, on the classifier head. This samples the HEAD's
% uncertainty over FIXED features; it cannot see representation uncertainty, so
% a confidently wrong out-of-distribution image scores LOW. Same scope caveat
% mcDropout.py states, repeated here so the MATLAB payload carries it too.
%
% Zero variance is NOT reported as certainty. A network with no active dropout
% makes every pass identical and the entropy collapses to the point estimate's
% -- which reads downstream as unusually high confidence. That raises here, the
% way mcDropout.py's NoDropout does: an unmeasured quantity is null, never 0.

if nargin < 3, opts = struct(); end
passes      = getdef(opts, 'passes', 20);
temperature = getdef(opts, 'temperature', 1.0);
seed        = getdef(opts, 'seed', 12345);

layers = net.Layers;
names  = arrayfun(@(l) string(l.Name), layers);

% ── The head, and the layer that feeds it ──────────────────────────────────
headIdx = find(names == "x_head_Gemm", 1);
if isempty(headIdx) || ~isa(layers(headIdx), 'nnet.cnn.layer.FullyConnectedLayer')
    error('mcDropoutMatlab:noHead', ...
        ['Expected a fully-connected layer named x_head_Gemm. The graph has ' ...
         'changed shape, and this function reproduces the head by hand, so it ' ...
         'must not guess which layer that is.']);
end
if headIdx < 2
    error('mcDropoutMatlab:noFeatureLayer', 'x_head_Gemm has no preceding layer.');
end
featLayer = names(headIdx - 1);

% ── Dropout probability, read from the network, never assumed ──────────────
dropIdx = find(arrayfun(@(l) isa(l, 'nnet.cnn.layer.DropoutLayer'), layers));
if isempty(dropIdx)
    error('mcDropoutMatlab:noDropout', ...
        ['No dropout layer in this network: every pass would be identical and ' ...
         'the variance would be exactly 0, which reads downstream as MAXIMUM ' ...
         'certainty. Refusing to report a number this model cannot support.']);
end
p = double(layers(dropIdx(1)).Probability);
if ~(p > 0 && p < 1)
    error('mcDropoutMatlab:inactiveDropout', ...
        ['Dropout probability is %.3f, so sampling it changes nothing and the ' ...
         'score would be a point estimate wearing an uncertainty label.'], p);
end

% ── Trunk once, head many times ────────────────────────────────────────────
feats = getdef(opts, 'features', []);
if isempty(feats)
    feats = extractdata(predict(net, X, 'Outputs', featLayer));
end
feats = reshape(double(feats), [], 1);
W = double(layers(headIdx).Weights);
b = double(layers(headIdx).Bias);
if size(W, 2) ~= numel(feats)
    error('mcDropoutMatlab:shapeMismatch', ...
        'Head expects %d features, layer %s produced %d.', size(W, 2), featLayer, numel(feats));
end

% Reproducible, and restored afterwards so this never perturbs a caller's
% stream -- a grading run that changed its own RNG as a side effect would be a
% nasty thing to debug.
rngState = rng(seed, 'twister');
cleanup  = onCleanup(@() rng(rngState));

nClasses = size(W, 1);
probs = zeros(passes, nClasses);
for i = 1:passes
    % Inverted dropout, as nn.Dropout does at train time: keep with
    % probability 1-p and scale the survivors by 1/(1-p), so the expectation
    % matches eval mode and no rescaling is needed anywhere else.
    mask = double(rand(size(feats)) >= p) / (1 - p);
    logits = (W * (feats .* mask) + b)';
    probs(i, :) = softmaxRow(logits / temperature);
end

meanProbs = mean(probs, 1);
predEntropy     = entropyRow(meanProbs);
expectedEntropy = mean(arrayfun(@(i) entropyRow(probs(i, :)), 1:passes));
mutualInfo      = max(0, predEntropy - expectedEntropy);
maxEntropy      = log(nClasses);

out = struct( ...
    'uncertaintyScore',            min(1, max(0, predEntropy / maxEntropy)), ...
    'predictiveEntropy',           predEntropy, ...
    'expectedEntropy',             expectedEntropy, ...
    'mutualInformation',           mutualInfo, ...
    'normalisedMutualInformation', mutualInfo / maxEntropy, ...
    'meanProbabilities',           meanProbs, ...
    'perClassVariance',            var(probs, 0, 1), ...
    'totalVariance',               sum(var(probs, 0, 1)), ...
    'meanGrade',                   find(meanProbs == max(meanProbs), 1) - 1, ...
    'passes',                      passes, ...
    'seed',                        seed, ...
    'dropoutP',                    p, ...
    'backend',                     'matlab', ...
    'scope', ['head only -- the single dropout layer sits on the classifier ' ...
              'head, so this samples classifier uncertainty over fixed ' ...
              'features and cannot see representation uncertainty. A ' ...
              'confident out-of-distribution image scores LOW.'], ...
    'note', ['Same estimator and same statistic as inference/mcDropout.py, ' ...
             'applied to the features rather than the logits because that is ' ...
             'where PyTorch''s dropout sits. MATLAB and NumPy draw different ' ...
             'random numbers from the same seed, so the two backends agree on ' ...
             'the quantity and on its distribution, NOT digit for digit.']);
end

% ── Local functions ─────────────────────────────────────────────────────────

function p = softmaxRow(z)
z = z - max(z);
e = exp(z);
p = e ./ sum(e);
end

function h = entropyRow(p)
% Natural-log entropy. 0*log(0) is 0, not NaN.
q = p(p > 0);
h = -sum(q .* log(q));
end

function v = getdef(s, name, dflt)
if isstruct(s) && isfield(s, name) && ~isempty(s.(name)), v = s.(name); else, v = dflt; end
end
