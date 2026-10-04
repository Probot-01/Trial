
import numpy as np
import torch
import torch.nn as nn

DROPOUT_TYPES = (nn.Dropout, nn.Dropout1d, nn.Dropout2d, nn.Dropout3d,
                 nn.AlphaDropout, nn.FeatureAlphaDropout)


class NoDropout(RuntimeError):
    """No active dropout: sampling would report certainty it never measured."""


def dropout_modules(model):
    """Active dropout modules. p == 0 does not count -- it is a no-op layer and
    would produce identical passes, which is the zero-variance trap."""
    return [(name, m) for name, m in model.named_modules()
            if isinstance(m, DROPOUT_TYPES) and getattr(m, "p", 0) > 0]


def _softmax(z, axis=-1):
    z = z - z.max(axis=axis, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=axis, keepdims=True)


def _entropy(p, axis=-1):
    # 0 * log 0 is 0 by convention, but numpy makes it nan. Clipping keeps a
    # confident row from producing a nan that then poisons the whole score.
    return -(p * np.log(np.clip(p, 1e-12, None))).sum(axis=axis)


def mc_dropout(model, x, n_passes=20, temperature=1.0, seed=12345,
               require_dropout=True):
   
    if n_passes < 2:
        raise ValueError("n_passes must be at least 2; "
                         "variance over a single pass is meaningless")

    active = dropout_modules(model)
    if not active:
        if require_dropout:
            raise NoDropout(
                "no active dropout modules: every pass would be identical and "
                "the variance would be exactly 0, which downstream reads as "
                "maximum certainty. Refusing to report an unmeasured 0.")
        return None

    was_training = model.training
    bn_before = [m.training for m in model.modules()
                 if isinstance(m, nn.modules.batchnorm._BatchNorm)]

    gen = torch.Generator().manual_seed(seed)
    prior = torch.random.get_rng_state()
    torch.random.manual_seed(int(torch.randint(0, 2**31 - 1, (1,), generator=gen)))

    try:
        model.eval()                      # everything deterministic ...
        for _name, m in active:
            m.train()                     # ... except dropout

      
        bn_after = [m.training for m in model.modules()
                    if isinstance(m, nn.modules.batchnorm._BatchNorm)]
        if any(bn_after):
            raise RuntimeError("BatchNorm is in training mode during MC-dropout; "
                               "at batch size 1 it would normalise by a single "
                               "image's own statistics")

        logits = _sample(model, x, n_passes, active)
    finally:
        torch.random.set_rng_state(prior)
        model.train(was_training)
        for m, state in zip((m for m in model.modules()
                             if isinstance(m, nn.modules.batchnorm._BatchNorm)),
                            bn_before):
            m.train(state)

    probs = _softmax(logits / float(temperature), axis=1)   # passes x classes
    mean = probs.mean(axis=0)
    var = probs.var(axis=0)


    predictive_entropy = float(_entropy(mean))
    expected_entropy = float(_entropy(probs, axis=1).mean())
    mutual_information = max(0.0, predictive_entropy - expected_entropy)

    n_classes = probs.shape[1]
    max_entropy = float(np.log(n_classes))

  
    score = float(np.clip(predictive_entropy / max_entropy, 0.0, 1.0))

    return {
        "uncertaintyScore": score,
        "predictiveEntropy": predictive_entropy,
        "expectedEntropy": expected_entropy,
        "mutualInformation": mutual_information,
        "normalisedMutualInformation": float(mutual_information / max_entropy),
        "meanProbabilities": [float(v) for v in mean],
        "perClassVariance": [float(v) for v in var],
        "totalVariance": float(var.sum()),
        "meanGrade": int(mean.argmax()),
        "passes": int(n_passes),
        "seed": int(seed),
        "dropoutLayers": [name for name, _ in active],
        "dropoutP": [float(m.p) for _, m in active],
       
        "scope": ("head only -- the single dropout layer sits after the "
                  "convolutional trunk, so this samples classifier uncertainty "
                  "over fixed features and cannot see representation "
                  "uncertainty. A confident out-of-distribution image scores "
                  "LOW."),
    }


def _has_split_head(model, active):
    """True when the model is head(dropout(backbone(x))) with that one dropout."""
    return (len(active) == 1
            and all(hasattr(model, a) for a in ("backbone", "dropout", "head"))
            and active[0][1] is model.dropout)


def _sample(model, x, n_passes, active):
    """n_passes x n_classes logits."""
    with torch.no_grad():
        if _has_split_head(model, active):
            
            feats = model.backbone(x)
            return np.stack([model.head(model.dropout(feats))[0].numpy()
                             for _ in range(n_passes)])
        return np.stack([model(x)[0].numpy() for _ in range(n_passes)])
