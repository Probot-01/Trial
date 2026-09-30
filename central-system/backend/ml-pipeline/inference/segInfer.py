"""
segInfer.py
===========
Phase 4 segmentation and localization: models M2-M5, one process, one JSON.

    python segInfer.py <imagePath> --outdir DIR

Prints ONE line of JSON to stdout. Errors go to stderr, never stdout, for the
same reason as branchAInfer.py: Node parses stdout as JSON, so a traceback
printed there is read as a malformed result instead of a failure.

Exit codes:  0 success   2 bad arguments   3 inference failed
             4 the MATLAB session failed a forward pass and the PyTorch
               fallback is off (SEG_ALLOW_PYTHON_FALLBACK unset)

── WHY ALL FOUR RUN IN ONE PROCESS ─────────────────────────────────────────
Interpreter start plus four model loads dominates the cost; four spawns would
pay it four times. They are also not independent -- M4's optic-disc masking
needs M3's disc centre -- so splitting them would mean passing coordinates
between processes for no gain.

── THE THREE COORDINATE SPACES, WHICH ARE THE WHOLE DIFFICULTY ─────────────
This is the part that silently produces plausible, wrong output.

  ORIGINAL      the photograph as captured, HxW.
  SQUISH-512    original resized to 512x512 ignoring aspect. M3 only.
  CROP-512      ben_graham's retinal crop box, resized to 512x512. M4, M5.
  PAD-512       aspect-preserving resize + centre zero-pad. M2 only.

Every model works in a different one, and NONE of them is the original. A mask
produced in CROP-512 and read as if it were SQUISH-512 still looks like a
lesion mask -- it is just in the wrong place, and since quadrant counts are what
the ICDR rule engine grades on, the grade changes without anything failing.

M4 is the sharp edge: its optic-disc masking is trained-in behaviour that the
model does NOT apply, so the caller must. The disc comes from M3 in SQUISH-512;
the mask must be applied in CROP-512. Mapping between them is via
retinal_crop_box(), which is why that was factored out of ben_graham rather
than reimplemented.

── WHAT IS PROVEN AND WHAT IS NOT ──────────────────────────────────────────
M3's recipe is PROVEN: it reproduces the model's own published predictions on
77/78 images (verifyModel3.py). That verification also established that
interpolation is not a detail -- INTER_AREA agrees 98.7% of the time and
OpenCV's default INTER_LINEAR only 28.2%.

M2, M4 and M5 preprocessing is taken from the checkpoints' own metadata strings
and Tanuj's handover, and is NOT independently reproduced here. The
interpolation used for M2's aspect-preserving resize in particular is not
recorded anywhere, and the M3 result is direct evidence that guessing it wrong
is not a rounding error. Treat their masks as unvalidated until each has its
own verify script. Nothing downstream should present them otherwise.
"""

import argparse
import json
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ML_ROOT)

INPUT_SIZE = 512
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], np.float32)

# M4's trained-in optic-disc mask radius, in CROP-512 pixels. From the
# checkpoint's own od_mask_radius field. The model does not apply it.
OD_MASK_RADIUS = 58

# Fovea peak-confidence gate (ML plan section 5). Below this, the fovea
# heatmap has no real peak and pts["fovea"]'s coordinate should not be
# trusted as a quadrant-axis endpoint.
#
# 0.37, chosen on VAL only (experiments/foveaGateValidation.py, all 516 IDRiD
# localization images, "peak" is a raw unnormalised regression output, not a
# probability -- see that script's module docstring): the smallest threshold
# with 100% VAL gross-miss sensitivity (2/2, Clopper-Pearson 95% CI
# [15.8%,100%] -- n=2 is small, see the script's own caveat) at a 1.3% VAL
# false-alarm rate (1/75, CI [0%,7.2%]). Confirmed on the untouched TEST
# split (78 images): sensitivity 100% (2/2), false-alarm rate 5.3% (4/76,
# CI [1.5%,12.9%]). Across all 516 images this flags 14 (2.71%).
FOVEA_PEAK_THRESHOLD = 0.37

# ── RED_LESION_MODEL_VERSION switch (M5 phase 2) ────────────────────────────
# Style matches BRANCH_A_MODEL_VERSION (inference/branchAInfer.py): an env var
# read once at import time, default stays the currently-deployed model. With
# v1 selected (the default), every line touched below reduces to exactly the
# code that ran before this switch existed -- see lesions()'s v1 branch --
# so v1 output is unchanged, not merely equivalent.
RED_LESION_MODEL_VERSIONS = {"v1": "red_lesion", "v2": "red_lesion_v2"}
# DEFAULT CHANGED v1 -> v2, 2026-09-23 (Saad's decision).
#
# v2 is the 3-class retrain: it reports microaneurysms and haemorrhages
# separately instead of one merged "red lesion" mask, which is what makes
# lesionCounts.microaneurysms / .hemorrhages real numbers instead of null.
# Verified end to end before flipping: the net loads and emits [512 512 3],
# and maPerQuadrant + hePerQuadrant sum to redPerQuadrant exactly.
#
# THE THRESHOLDS MOVED WITH IT, AND HAD TO. v2 finds ~2.6x more red lesions
# than v1, so v1's thresholds against v2's counts drop referable specificity
# to 0.231 on IDRiD's test split -- 30 of 39 healthy eyes flagged as
# referable, with nothing erroring. The matching set is in
# models/rule_thresholds_by_red_version.json and is attached per case by
# gradingOrchestrator's caseRuleOpts(), keyed off the redLesionModelVersion
# this module reports, so the two cannot be flipped independently.
#
# ROLLBACK: set RED_LESION_MODEL_VERSION=v1 in the environment. The v1 code
# paths are untouched and the v1 thresholds are still in that JSON, so the
# rollback restores both halves together.
RED_LESION_MODEL_VERSION = os.environ.get("RED_LESION_MODEL_VERSION", "v2")

# 10 px at 512. NOT a free parameter: redFloor and grade3QuadMin were
# calibrated against counts produced with this exact filter.
DEFAULT_MIN_AREA = 10
if RED_LESION_MODEL_VERSION not in RED_LESION_MODEL_VERSIONS:
    raise ValueError(
        f"RED_LESION_MODEL_VERSION={RED_LESION_MODEL_VERSION!r} is not one of "
        f"{sorted(RED_LESION_MODEL_VERSIONS)}.")

# v2's per-class connected-component floors. Read from the config the floors
# were actually chosen against (models/red_lesion_v2_config.json's
# floor-sweep -- see red_lesion_v2_metrics.json's "floor_sweep" section)
# rather than hardcoded a second time here, but the recalibration in Gate 2
# was fitted specifically against MA=5/HE=10, so a config drift is asserted
# against, not silently followed.
_RED_V2_CONFIG_PATH = os.path.join(ML_ROOT, "models", "red_lesion_v2_config.json")


def _red_v2_floors():
    import json as _json
    with open(_RED_V2_CONFIG_PATH) as fh:
        cfg = _json.load(fh)
    floors = cfg["chosen_min_area_floors"]
    ma, he = int(floors["MA"]), int(floors["HE"])
    if (ma, he) != (5, 10):
        raise ValueError(
            f"models/red_lesion_v2_config.json's chosen_min_area_floors is now "
            f"MA={ma} HE={he}, but Gate 2's rule-threshold recalibration was "
            f"fitted against MA=5/HE=10 -- it does not automatically transfer "
            f"to different floors. Recalibrate before changing this.")
    return ma, he


_MODELS = {}


def _fail(msg, code=3):
    print(f"segInfer: {msg}", file=sys.stderr)
    sys.exit(code)


# ── Model construction ─────────────────────────────────────────────────────
# Architectures come from each checkpoint's own metadata, and every load is
# strict=True. A non-strict load would silently accept a shape mismatch and
# leave randomly initialised weights in place, which produces a mask that looks
# like noise-flecked anatomy rather than an error.
_ARCH = {
    "vessel":        dict(encoder_name="resnet34", in_channels=1, classes=1),
    "localization":  dict(encoder_name="resnet18", in_channels=3, classes=2),
    "hard_exudate":  dict(encoder_name="resnet34", in_channels=3, classes=1),  # GATE 4: was "bright_lesion"
    "red_lesion":    dict(encoder_name="resnet34", in_channels=3, classes=1),
    "red_lesion_v2": dict(encoder_name="resnet34", in_channels=3, classes=3),
}


def load(role):
    if role in _MODELS:
        return _MODELS[role]
    import torch
    import segmentation_models_pytorch as smp
    from modelPaths import resolve, CheckpointMissing
    try:
        path = resolve(role)
    except CheckpointMissing as exc:
        _fail(str(exc))
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    model = smp.Unet(encoder_weights=None, activation=None, **_ARCH[role])
    model.load_state_dict(ckpt["model_state_dict"], strict=True)
    model.eval()
    _MODELS[role] = (model, ckpt)
    return model, ckpt


def _forward(model, x):
    import torch
    with torch.no_grad():
        return model(torch.from_numpy(x))[0].numpy()


# SEG_INFERENCE_BACKEND=matlab|python. With matlab, the forward pass of all
# four MATLAB-converted models runs in the persistent MATLAB session; every
# pre- and post-processing step below is unchanged, so both backends share one
# copy of it. red_lesion_unet_v1 (M5's old 2-class model, the one the 3-class
# retrain replaced) is NOT in this dict and never will be -- it is not served
# under any configuration. red_lesion_unet_v2 (the deployed 3-class model) was
# added here once its ONNX->MATLAB import and parity check
# (training/parityCheckRedLesionV2.m: per-image max|diff| and per-class
# connected-component count, both against the same 10 real IDRiD images
# parityCheck.m uses) confirmed the imported dlnetwork agrees with the
# PyTorch checkpoint it was converted from.
#
# A session failure FAILS segmentation (exit code 4, MatlabEngineFailed) --
# standing rule: no silent engine fallback. The case then fails visibly or is
# retried by the grading queue, rather than quietly running on PyTorch.
#
# SEG_ALLOW_PYTHON_FALLBACK=1 opts back in to the PyTorch fallback (tensor
# parity was verified at 2e-6..4e-5, so it changes where the numbers came
# from, not what they are). Even then it is never silent: every model's engine
# is reported in the output's `engines` block and stored per case as engine
# provenance, with fallback: true.
SEG_BACKEND = os.environ.get("SEG_INFERENCE_BACKEND", "matlab").strip().lower()
SEG_ALLOW_PYTHON_FALLBACK = os.environ.get("SEG_ALLOW_PYTHON_FALLBACK", "") == "1"
_MATLAB_NETS = {
    "vessel": "vessel_unet_v1",
    "localization": "localization_v1",
    "hard_exudate": "bright_lesion_unet_v1",
    "red_lesion_v2": "red_lesion_unet_v2",
}
# Which engine produced each role's forward pass, for the CURRENT run_one call
# only -- reset at its start, because the segmentation worker calls run_one
# many times in one process and a stale entry would misattribute a case.
BACKEND_USED = {}

EXIT_MATLAB_FAILED = 4


class MatlabEngineFailed(RuntimeError):
    """The MATLAB session could not run a forward pass, and the PyTorch
    fallback is not enabled. Distinct from every other failure so the backend
    can fail (or retry) the case instead of degrading it to classifier-only."""


def _run(role, x):
    """Forward pass for `role` on NCHW float32 x; returns C x H x W."""
    if SEG_BACKEND == "matlab" and role in _MATLAB_NETS:
        try:
            from matlabSessionClient import forward
            out = forward(_MATLAB_NETS[role], x)
            BACKEND_USED[role] = {"engine": "matlab", "fallback": False,
                                  "detail": f"MATLAB session forward pass ({_MATLAB_NETS[role]})"}
            return out
        except Exception as exc:  # noqa: BLE001 - fail, or fall back only when allowed
            if not SEG_ALLOW_PYTHON_FALLBACK:
                raise MatlabEngineFailed(
                    f"MATLAB session failed for {role} ({exc}); "
                    "SEG_ALLOW_PYTHON_FALLBACK is not set, so not falling back to PyTorch"
                ) from exc
            print(f"segInfer: MATLAB session failed for {role} ({exc}); "
                  "falling back to PyTorch (SEG_ALLOW_PYTHON_FALLBACK=1)", file=sys.stderr)
            BACKEND_USED[role] = {"engine": "python", "fallback": True,
                                  "detail": f"PyTorch after MATLAB failed: {exc}"[:300]}
    else:
        detail = ("PyTorch; not converted for MATLAB serving"
                  if role not in _MATLAB_NETS else "PyTorch (SEG_INFERENCE_BACKEND=python)")
        BACKEND_USED[role] = {"engine": "python", "fallback": False, "detail": detail}
    return _forward(load(role)[0], x)


def engines_used():
    """{vessel, localization, hardExudate, redLesion} -> the engine entry for
    each model that ran in this call, None for one that did not."""
    red = BACKEND_USED.get("red_lesion_v2") or BACKEND_USED.get("red_lesion")
    return {
        "vessel": BACKEND_USED.get("vessel"),
        "localization": BACKEND_USED.get("localization"),
        "hardExudate": BACKEND_USED.get("hard_exudate"),
        "redLesion": red,
    }


def fovea_unreliable(heatmap):
    """True when the fovea heatmap (ML plan section 5) has no reliable peak.

    heatmap is the raw 2D fovea channel the model emits (no activation, no
    clamp -- see FOVEA_PEAK_THRESHOLD's comment). A missing heatmap (None) or
    one whose max is not finite (NaN/inf, e.g. a corrupt forward pass) always
    counts as unreliable -- this must never silently resolve to False just
    because the peak could not be computed.

    Always returns a real Python bool, never numpy.bool_/None/[].
    """
    if heatmap is None or np.size(heatmap) == 0:
        return True
    peak = float(np.max(heatmap))
    if not np.isfinite(peak):
        return True
    return bool(peak < FOVEA_PEAK_THRESHOLD)


# ── M3: optic disc and fovea ───────────────────────────────────────────────
def localize(bgr):
    """Disc and fovea in ORIGINAL image pixels.

    The proven recipe -- see verifyModel3.py. INTER_AREA is load-bearing.
    """
    h, w = bgr.shape[:2]
    resized = cv2.resize(bgr, (INPUT_SIZE, INPUT_SIZE), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    x = (rgb.astype(np.float32) / 255.0 - IMAGENET_MEAN) / IMAGENET_STD
    hm = _run("localization", x.transpose(2, 0, 1)[None, ...])

    pts = {}
    for idx, name in ((0, "opticDisc"), (1, "fovea")):
        iy, ix = np.unravel_index(hm[idx].argmax(), hm[idx].shape)
        pts[name] = {
            # 512-space is what the model emits; original-space is what every
            # other stage needs. Both are reported so a disagreement between
            # them is visible rather than inferred.
            "x512": float(ix), "y512": float(iy),
            "x": float(ix) * w / INPUT_SIZE,
            "y": float(iy) * h / INPUT_SIZE,
            "peak": float(hm[idx].max()),
        }

    # Fovea peak-confidence gate: below FOVEA_PEAK_THRESHOLD the heatmap has
    # no real peak, so pts["fovea"]'s coordinate should not be trusted as a
    # quadrant-axis endpoint. Logged to the server log (stderr) regardless of
    # outcome -- there is no existing detail/debug object in this JSON to
    # attach it to instead.
    pts["foveaUnreliable"] = fovea_unreliable(hm[1])
    print(f"segInfer: fovea peak={pts['fovea']['peak']!r} "
          f"threshold={FOVEA_PEAK_THRESHOLD} "
          f"foveaUnreliable={pts['foveaUnreliable']}", file=sys.stderr)
    return pts


# ── M2: vessels ────────────────────────────────────────────────────────────
def _aspect_pad(gray, size=INPUT_SIZE):
    """Aspect-preserving resize then centre zero-pad. Returns (padded, geom)."""
    h, w = gray.shape[:2]
    scale = size / max(h, w)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    # INTER_LINEAR, and this is NOT the same choice M3 makes. M3 needs
    # INTER_AREA (98.7% agreement vs 28.2% for LINEAR); M2 needs INTER_LINEAR
    # (100.000% exact pixel agreement vs 99.756% for AREA). Neither checkpoint
    # records its interpolation, and the two models disagree -- so it cannot be
    # set once globally and must be verified per model. See verifySegModels.py.
    resized = cv2.resize(gray, (nw, nh), interpolation=cv2.INTER_LINEAR)
    out = np.zeros((size, size), resized.dtype)
    ox, oy = (size - nw) // 2, (size - nh) // 2
    out[oy:oy + nh, ox:ox + nw] = resized
    return out, (ox, oy, nw, nh)


def vessels(bgr):
    """Vessel mask in ORIGINAL image pixels.

    Trained on CHASE_DB1, which is near-square, so the centre pad barely showed
    there. A 3:2 fundus photograph gets large black bands, and the pad must be
    reproduced exactly or the model sees an input unlike anything it was
    trained on. This is the highest train/serve-skew risk of the four.
    """
    h, w = bgr.shape[:2]
    green = bgr[:, :, 1]
    padded, (ox, oy, nw, nh) = _aspect_pad(green)
    x = ((padded.astype(np.float32) / 255.0) - 0.5) / 0.5
    logits = _run("vessel", x[None, None, ...])[0]
    prob = 1.0 / (1.0 + np.exp(-logits))
    # Undo the pad BEFORE resizing back: the padding is not part of the image,
    # and resizing it in would drag black bands into the retina.
    inner = prob[oy:oy + nh, ox:ox + nw]
    full = cv2.resize(inner, (w, h), interpolation=cv2.INTER_LINEAR)
    return full > 0.5


# ── M4 / M5: lesions, in ben_graham CROP-512 space ─────────────────────────
def _crop512(bgr):
    """ben_graham at 512 plus the crop box needed to map coordinates."""
    from preprocessing.ben_graham import ben_graham_preprocess, retinal_crop_box
    proc = ben_graham_preprocess(bgr, target_size=INPUT_SIZE)
    return cv2.cvtColor(proc, cv2.COLOR_BGR2RGB), retinal_crop_box(bgr)


def _to_crop512(px, py, box):
    """ORIGINAL pixel -> CROP-512 pixel."""
    x0, y0, bw, bh = box
    return (px - x0) * INPUT_SIZE / bw, (py - y0) * INPUT_SIZE / bh


def _lesion_prob(role, rgb512):
    # Both lesion models use (x/255 - 0.5)/0.5, NOT ImageNet. M4's checkpoint
    # says encoder_weights='imagenet', which describes only how the encoder was
    # initialised -- it is not the input normalization, and reading it as such
    # is the single easiest mistake here. Tanuj resolved it by Dice against
    # ground truth: this norm 0.49, ImageNet norm 0.33. Note the failure mode:
    # 0.33 still yields a plausible-looking mask, so it degrades quietly.
    x = ((rgb512.astype(np.float32) / 255.0) - 0.5) / 0.5
    logits = _run(role, x.transpose(2, 0, 1)[None, ...])[0]
    return 1.0 / (1.0 + np.exp(-logits))


def _lesion_prob_v2(role, rgb512):
    """3-channel softmax counterpart of _lesion_prob, for red_lesion_v2 only.

    Same input normalization as _lesion_prob -- verified against the
    checkpoint's own 'preprocessing' metadata string, not assumed -- only the
    activation differs: softmax over 3 classes here (background/MA/HE)
    instead of sigmoid over one logit. Returns (3, H, W) probabilities.
    """
    x = ((rgb512.astype(np.float32) / 255.0) - 0.5) / 0.5
    # NO extra [0] here: _run()/_forward() already strip the batch dim (see
    # localize()'s identical multi-channel pattern), leaving (3, H, W). The
    # single-channel _lesion_prob() above needs its own trailing [0] to drop
    # a channel dim of size 1 -- that pattern does NOT generalise to 3
    # classes, and copying it here silently kept only channel 0 (background),
    # which is exactly the bug this comment is now guarding against.
    # Through _run(), same as every other segmentation role: MATLAB when
    # SEG_INFERENCE_BACKEND=matlab (red_lesion_v2 is now in _MATLAB_NETS),
    # PyTorch otherwise. _run() records BACKEND_USED[role] itself.
    logits = _run(role, x.transpose(2, 0, 1)[None, ...])  # (3, H, W)
    e = np.exp(logits - logits.max(axis=0, keepdims=True))
    return e / e.sum(axis=0, keepdims=True)


def lesions(bgr, disc_xy):
    """Red-lesion and hard-exudate masks, both in ORIGINAL image pixels.
    (Local variable/JSON-key names below still say 'bright' -- see the GATE 4
    comment at this file's JSON contract keys for exactly what did and did
    not get renamed and why.)

    Returns (redOriginal, brightOriginal, odMasked, red512, bright512, box,
    redV2Extra). redV2Extra is None under RED_LESION_MODEL_VERSION=='v1' (the
    default) and a {'ma512', 'he512'} dict of the two per-class 512-space
    masks under 'v2' -- everything else in this function's v1 code path is
    untouched by the version switch, not merely equivalent under it.
    """
    h, w = bgr.shape[:2]
    rgb512, box = _crop512(bgr)

    role = RED_LESION_MODEL_VERSIONS[RED_LESION_MODEL_VERSION]
    ma512 = he512 = None
    if RED_LESION_MODEL_VERSION == "v2":
        # class_map (from the checkpoint): 0=background, 1=microaneurysm,
        # 2=haemorrhage. argmax rather than a per-class >0.5 threshold: the
        # three channels are softmaxed together (mutually exclusive classes),
        # not three independent sigmoids, so argmax is the correct decision
        # rule the model was trained under -- see red_lesion_v2_config.json's
        # class_map and the checkpoint's own 'preprocessing' note ("3-class
        # target = MA(1) precedence over HE(2) over bg(0)").
        probs3 = _lesion_prob_v2(role, rgb512)
        cls = probs3.argmax(axis=0)
        red = cls != 0
        ma512 = cls == 1
        he512 = cls == 2
    else:
        red = _lesion_prob(role, rgb512) > 0.5
    bright = _lesion_prob("hard_exudate", rgb512) > 0.5  # GATE 4: role was "bright_lesion"

    # M4's optic-disc masking: trained-in behaviour the model does not apply.
    # The disc is bright and round and the hard-exudate model fires on it, so
    # without this every image gains a large false exudate exactly where the
    # disc is -- which, with redFloor now at 3, is enough to move a grade.
    od_masked = False
    if disc_xy is not None:
        cx, cy = _to_crop512(disc_xy[0], disc_xy[1], box)
        if np.isfinite(cx) and np.isfinite(cy):
            yy, xx = np.ogrid[:INPUT_SIZE, :INPUT_SIZE]
            bright = bright & (((xx - cx) ** 2 + (yy - cy) ** 2) > OD_MASK_RADIUS ** 2)
            od_masked = True

    # Restrict to the retina. A "lesion" outside the retinal circle is a
    # camera artefact by definition -- the vignette edge and the black surround
    # are high-contrast boundaries and both lesion models fire along them. On a
    # real image this was the majority of all detections, concentrated in a band
    # at the image edge. Left in, they are counted as lesions by the rule
    # engine, and with redFloor at 3 that alone can manufacture a grade.
    #
    # Same green>7 rule ben_graham crops with and Grad-CAM's ROI safeguard
    # uses, so "inside the retina" means one thing across the pipeline.
    from gradcam import retinal_mask
    roi512 = retinal_mask(cv2.cvtColor(rgb512, cv2.COLOR_RGB2BGR))
    red = red & roi512
    bright = bright & roi512
    if RED_LESION_MODEL_VERSION == "v2":
        ma512 = ma512 & roi512
        he512 = he512 & roi512

    def to_original(mask):
        x0, y0, bw, bh = box
        full = np.zeros((h, w), bool)
        # INTER_NEAREST: a binary mask must stay binary. Interpolating it
        # produces fractional values that a >0.5 threshold then re-binarises
        # along resampled edges, quietly changing lesion areas and counts.
        back = cv2.resize(mask.astype(np.uint8), (bw, bh),
                          interpolation=cv2.INTER_NEAREST).astype(bool)
        full[y0:y0 + bh, x0:x0 + bw] = back
        return full

    # The 512-space masks are returned ALONGSIDE the original-space ones, and
    # counting must use the 512 ones.
    #
    # min_area is 10 px AT 512. Applied to an upsampled original-space mask it
    # means something completely different: mapping a 512 mask back onto a
    # 4288-wide photograph scales areas by ~70x, so a 10 px floor there keeps
    # blobs of 0.14 px at 512 -- i.e. no filtering at all. Measured, that
    # inflated IDRiD_212 from 1 red lesion to 11, and every count with it.
    #
    # Original-space masks stay for overlays and for anything that has to line
    # up with the photograph; counts come from the space the thresholds were
    # calibrated in.
    red_v2_extra = {"ma512": ma512, "he512": he512} if RED_LESION_MODEL_VERSION == "v2" else None
    return to_original(red), to_original(bright), od_masked, red, bright, box, red_v2_extra


# ── Reporting ──────────────────────────────────────────────────────────────
def quadrant_counts(components, fovea_xy, disc_xy):
    """Lesions per quadrant, in the frame the ICDR thresholds were fitted in.

    Centred on the FOVEA, x-axis pointing fovea -> optic disc (nasal), y-axis
    perpendicular. Returns [q_++, q_+-, q_-+, q_--].

    This reproduces diagnostics/check_agreement.py's convention exactly, and
    that is the point: redFloor and grade3QuadMin were calibrated against these
    counts, and a threshold is only meaningful paired with the procedure it was
    fitted on. A different-but-reasonable partition would silently shift what
    "3 lesions in all four quadrants" means.

    The quadrants are NOT named here. fundusQuadrants.m does the anatomical
    naming (superior-temporal and so on) for the evidence report, including the
    mirrored-eye case where superior and inferior swap; that logic is tested
    there and is not duplicated.

    NOTE (ML plan section 5/6.4): this function does not check
    foveaUnreliable. It always builds the axis from fovea_xy, reliable or
    not -- an unreliable-fovea fallback belongs in MATLAB alongside the
    section 6.4 quadrant-assignment port, not here. Until that lands, a
    caller with foveaUnreliable=True still gets a fovea-centred axis from a
    coordinate the gate has already flagged as untrustworthy.
    """
    axis = np.array(disc_xy, float) - np.array(fovea_xy, float)
    norm = np.linalg.norm(axis)
    if norm < 1e-6:
        # Disc and fovea on top of each other means localization failed. Fall
        # back to image axes rather than dividing by ~0 and scattering lesions
        # into essentially random quadrants.
        axis = np.array([1.0, 0.0])
        norm = 1.0
    axis = axis / norm
    perp = np.array([-axis[1], axis[0]])

    counts = [0, 0, 0, 0]
    for comp in components:
        d = np.array([comp["x"], comp["y"]], float) - np.array(fovea_xy, float)
        u, v = float(d @ axis), float(d @ perp)
        counts[(0 if u >= 0 else 2) + (0 if v >= 0 else 1)] += 1
    return counts


def describe(mask, min_area=1):
    """Connected-component summary. Counts LESIONS, not pixels.

    The rule engine grades on lesion counts, and a pixel count is a different
    quantity: one large haemorrhage and forty microaneurysms can cover the same
    area and mean completely different things clinically.
    """
    n, _labels, stats, cents = cv2.connectedComponentsWithStats(
        mask.astype(np.uint8), connectivity=8)
    comps = []
    for i in range(1, n):                       # 0 is background
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        comps.append({"x": float(cents[i][0]), "y": float(cents[i][1]), "area": area})
    return comps


def summarise(mask, min_area=1):
    """Compact counts for the JSON payload.

    The full component list is deliberately NOT returned. On a real image it
    ran to hundreds of entries and tens of kilobytes, and nothing downstream
    consumes it: quadrant assignment happens in MATLAB from the mask PNG plus
    the disc/fovea axis, because that geometry is already written and tested
    there (including the mirrored-eye case). Shipping the list as well would be
    a second copy of the same facts, free to drift from the first.
    """
    comps = describe(mask, min_area)
    areas = sorted((c["area"] for c in comps), reverse=True)
    return {
        "count": len(comps),
        "totalAreaPx": int(sum(areas)),
        "largestAreaPx": int(areas[0]) if areas else 0,
        "medianAreaPx": float(np.median(areas)) if areas else 0.0,
        "minAreaFilter": int(min_area),
    }


def save_mask(mask, path):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    if not cv2.imwrite(path, (mask.astype(np.uint8) * 255)):
        raise RuntimeError(f"could not write {path}")
    return path


def run_one(image, outdir=None, min_area=DEFAULT_MIN_AREA):
    """One image in, the full segmentation payload out.

    THE API THE BACKEND CALLS. The segmentation worker
    (segSession/runSegWorker.py) holds the models in memory and calls this
    per case; main() below is the same work through a fresh process. Keeping
    one implementation is the point -- when this logic lived in main() only,
    the worker had nothing to call, and a merge that dropped it would have
    taken the warm path down without any test noticing.
    """
    BACKEND_USED.clear()
    bgr = cv2.imread(image, cv2.IMREAD_COLOR)
    if bgr is None:
        _fail(f"could not read image: {image}")
    h, w = bgr.shape[:2]

    pts = localize(bgr)
    fovea_unreliable_flag = pts.pop("foveaUnreliable")
    disc = (pts["opticDisc"]["x"], pts["opticDisc"]["y"])

    vessel = vessels(bgr)
    red, bright, od_masked, red512, bright512, box, red_v2_extra = lesions(bgr, disc)
    rgb512_for_roi, _ = _crop512(bgr)

    # Counting and quadrant assignment both happen in CROP-512, the space
    # the ICDR thresholds were calibrated in, so the landmarks are mapped
    # into it too rather than the masks being mapped out of it.
    fovea = (pts["fovea"]["x"], pts["fovea"]["y"])
    disc512 = _to_crop512(disc[0], disc[1], box)
    fovea512 = _to_crop512(fovea[0], fovea[1], box)
    red_comps = describe(red512, min_area)
    bright_comps = describe(bright512, min_area)
    red_q = quadrant_counts(red_comps, fovea512, disc512)
    bright_q = quadrant_counts(bright_comps, fovea512, disc512)

    # RED_LESION_MODEL_VERSION=='v2' only, additive: per-class quadrant
    # counts and real lesionCounts totals. redPerQuadrant is then
    # OVERWRITTEN to be maPerQuadrant + hePerQuadrant, each already
    # filtered by its OWN floor -- not a fresh describe() on the MA|HE
    # union, which would merge any MA/HE components that touch pixel-
    # to-pixel into one blob and undercount both classes.
    ma_q = he_q = None
    lesion_counts_v2 = None
    if RED_LESION_MODEL_VERSION == "v2":
        ma_floor, he_floor = _red_v2_floors()
        ma_comps = describe(red_v2_extra["ma512"], ma_floor)
        he_comps = describe(red_v2_extra["he512"], he_floor)
        ma_q = quadrant_counts(ma_comps, fovea512, disc512)
        he_q = quadrant_counts(he_comps, fovea512, disc512)
        red_q = [m + hh for m, hh in zip(ma_q, he_q)]
        lesion_counts_v2 = {"microaneurysms": len(ma_comps),
                            "hemorrhages": len(he_comps),
                            "softExudates": None}

    out = {
        "image": os.path.abspath(image),
        "imageSize": [int(h), int(w)],
        "opticDisc": pts["opticDisc"],
        "fovea": pts["fovea"],
        "foveaUnreliable": fovea_unreliable_flag,
        "vessel": {"pixels": int(vessel.sum()),
                   "fraction": float(vessel.mean())},
        "redLesions": summarise(red512, min_area),
        # "brightLesions"/"brightPerQuadrant" (below) and "brightLesion"
        # (in "verified") are JSON CONTRACT KEYS, deliberately NOT renamed
        # by GATE 4's bright_lesion->hard_exudate internal rename -- the
        # model/role is now called hard_exudate internally (see _ARCH,
        # modelPaths.CHECKPOINTS), but these three wire keys are untouched
        # on purpose.
        "brightLesions": summarise(bright512, min_area),
        "odMaskApplied": od_masked,
        "odMaskRadiusCrop512": OD_MASK_RADIUS,
        # Stated in the payload, not only in a doc: anything that renders
        # or reports these masks should be able to see that three of the
        # four recipes have not been reproduced against known-good output.
        "verified": {"localization": True, "vessel": True,
                     "redLesion": True, "brightLesion": "normalization only"},
        "verificationNote": ("M2 100.000% exact vs published CHASE masks; "
                             "M3 77/78 exact vs published predictions; "
                             "M5 per-image val Dice reproduced to 4dp. "
                             "M4's normalization is confirmed (1.42x over "
                             "ImageNet) but its val split is not recorded, "
                             "so its exact Dice cannot be reproduced. "
                             "See verifySegModels.py / verifyModel3.py."),
        # Quadrant counts, in the frame the ICDR thresholds were fitted in.
        "redPerQuadrant": red_q,
        "brightPerQuadrant": bright_q,
        "countingProcedure": (
            (
                "3-class softmax, argmax class map (0=background,1=MA,2=HE), "
                "8-connectivity, MA components >= %d px and HE components >= "
                "%d px (both at 512, per models/red_lesion_v2_config.json), "
                "quadrants centred on the fovea with the x-axis along "
                "fovea->disc. redPerQuadrant = maPerQuadrant + hePerQuadrant, "
                "each already filtered by its own floor." % _red_v2_floors()
            ) if RED_LESION_MODEL_VERSION == "v2" else (
                "prob > 0.5, 8-connectivity, components >= %d px at 512, "
                "quadrants centred on the fovea with the x-axis along "
                "fovea->disc. Reproduces diagnostics/check_agreement.py "
                "exactly: 14/14 red counts on its own images." % min_area
            )),
    }

    # RED_LESION_MODEL_VERSION=='v2' ONLY: additive fields per the M5
    # phase 2 contract. Never added under 'v1' -- v1's dict above (and
    # therefore its JSON) is unchanged from before this switch existed.
    if RED_LESION_MODEL_VERSION == "v2":
        out["maPerQuadrant"] = ma_q
        out["hePerQuadrant"] = he_q
        out["lesionCounts"] = lesion_counts_v2
        out["redLesionModelVersion"] = RED_LESION_MODEL_VERSION

    if outdir:
        base = os.path.splitext(os.path.basename(image))[0]
        # Lesion union and retina, at Branch A's 384 geometry.
        #
        # Task 7.1 compares Grad-CAM against a lesion mask, and the two live
        # in different spaces: the CAM is 12x12 over ben_graham's crop at
        # 384, the masks above are in ORIGINAL image pixels. Both of these
        # are written in the CAM's own frame so the comparison needs no
        # re-derivation of the crop geometry on the MATLAB side, where
        # getting it wrong would silently score attention against a
        # misaligned mask and still return a plausible number.
        #
        # NEAREST on the way down: a binary mask must stay binary.
        union384 = cv2.resize((red512 | bright512).astype(np.uint8),
                              (384, 384), interpolation=cv2.INTER_NEAREST)
        from gradcam import retinal_mask
        roi512 = retinal_mask(cv2.cvtColor(rgb512_for_roi, cv2.COLOR_RGB2BGR))
        roi384 = cv2.resize(roi512.astype(np.uint8), (384, 384),
                            interpolation=cv2.INTER_NEAREST)
        out["masks"] = {
            "lesion384": save_mask(union384.astype(bool),
                                   os.path.join(outdir, base + "_lesion384.png")),
            "roi384": save_mask(roi384.astype(bool),
                                os.path.join(outdir, base + "_roi384.png")),
            "vessel": save_mask(vessel, os.path.join(outdir, base + "_vessel.png")),
            "red":    save_mask(red,    os.path.join(outdir, base + "_red.png")),
            "bright": save_mask(bright, os.path.join(outdir, base + "_bright.png")),
        }

    # Which engine produced each model's output -- stored per case as engine
    # provenance (grading_results.engine_provenance). Additive key.
    out["engines"] = engines_used()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image", nargs="?")
    ap.add_argument("--outdir", default=None,
                    help="write vessel/red/bright mask PNGs here")
    ap.add_argument("--min-area", type=int, default=DEFAULT_MIN_AREA,
                    help="drop components smaller than this many pixels (512-space)")
    args = ap.parse_args()

    if not args.image:
        print("usage: segInfer.py <imagePath> [--outdir DIR]", file=sys.stderr)
        sys.exit(2)
    if not os.path.exists(args.image):
        _fail(f"no file at {args.image}")

    try:
        print(json.dumps(run_one(args.image, args.outdir, args.min_area)))
        return 0
    except SystemExit:
        raise
    except MatlabEngineFailed as exc:
        _fail(f"MatlabEngineFailed: {exc}", code=EXIT_MATLAB_FAILED)
    except Exception as exc:  # noqa: BLE001 - must not leak a traceback to stdout
        _fail(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
