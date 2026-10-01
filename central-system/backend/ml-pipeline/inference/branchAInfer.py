"""
branchAInfer.py
===============
Branch A inference. Reads a fundus image, returns a graded result as JSON.

    python branchAInfer.py <imagePath>

Prints ONE line of JSON to stdout and nothing else on success:

    {"drGradeCnn": 2, "confidenceScore": 0.71, "conformalTier": "B", ...}

Exit codes:
    0  success, JSON on stdout
    2  wrong arguments
    3  inference failed (unreadable image, missing model, ...)

── WHY THIS IS PYTHON AND NOT MATLAB ───────────────────────────────────────
The design doc requires MATLAB for the image-analysis and modelling code,
including both grading branches, and that was tested rather than waived.
MATLAB's official converter imports this network and computes the WRONG
NUMBERS: on identical input tensors it agrees with the model's published
logits on 8-11% of cases with a correlation of -0.25, while Python reproduces
them to 0.0050 with 100% agreement. The structure imports correctly, which is
what makes it dangerous -- only running it against known-good outputs catches
it. See testImportedNetwork.m; re-run it when the converter is updated.

So Branch A runs here. Everything that does not need the model's internals
stays in MATLAB: quality gate, camera calibration, the ICDR rule engine,
conformal tiering, the evidence report, Simulink.

── ERRORS GO TO STDERR, NEVER STDOUT ───────────────────────────────────────
Node parses stdout as JSON. A traceback printed there would be read as a
malformed result rather than a failure, and the orchestrator would report a
parse error instead of the real cause. stdout carries exactly one thing.

── THE PREPROCESSING IS NOT A CHOICE ───────────────────────────────────────
ben_graham_preprocess is imported from the training code, not reimplemented.
A model only ever sees what preprocessing hands it, and this project has
already measured what a mismatched chain costs: adding a CLAHE stage that
training never used dropped agreement with the model's own outputs from 100%
to 57.7%. If the training preprocessing changes, this import follows it
automatically -- which is the entire reason it is an import.
"""

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, ML_ROOT)

MODEL_DIR = os.path.join(ML_ROOT, "models")
EXPECTED_CALIB_METHOD = "ordinal_mode_interval_stratified_v3"

# ── BRANCH_A_MODEL_VERSION switch (v2a integration, GATE 4) ─────────────────
# Style matches INFERENCE_BACKEND (gradingOrchestrator.js): an env var read
# once at import time, default stays the currently-deployed model. Set by
# whatever spawns this process (or the shell, for direct/manual runs) --
# nothing in this file or gradingOrchestrator.js needs to "know" about it
# beyond process.env inheritance, the same way INFERENCE_BACKEND already
# reaches this process without this file naming it.
#
# modelPaths.CHECKPOINTS role + this version's own calibration FILENAME
# (never calibration_v1.json) are looked up from this table so every
# version-dependent path in this file comes from ONE place.
BRANCH_A_MODEL_VERSIONS = {
    "branchA_v1":  {"role": "classifier", "calib_filename": "calibration_v1.json"},
    "branchA_v2a": {"role": "classifier_v2a", "calib_filename": "calibration_branchA_v2a.json"},
    "branchA_v2b": {"role": "classifier_v2b", "calib_filename": "calibration_branchA_v2b.json"},
    "branchA_v2c": {"role": "classifier_v2c", "calib_filename": "calibration_branchA_v2c.json"},
}

# v2-family tags: dual-head checkpoint (5-class + binary referable), 5-class
# head only via export_to_onnx.build_v2a_5class_model (already generic --
# it only reads fields off whatever ckpt dict it's handed, never the
# filename). GENERALIZE (v2b integration): load_model() below used to check
# `== "branchA_v2a"` specifically; it now checks membership in this tuple so
# branchA_v2b reuses the exact same wrapper without a second copy. A later
# tag (branchA_v2c) needs one new line in BRANCH_A_MODEL_VERSIONS above and
# one here -- nothing else in this file changes.
V2_FAMILY_VERSIONS = ("branchA_v2a", "branchA_v2b", "branchA_v2c")

# DEFAULT CHANGE (v2c integration, 2026-09-21): branchA_v2c passed every
# gate (ONNX/MATLAB parity, revised cross-fit guards, calibrated end-to-end
# agreement with MATLAB) and is now the deployed default, replacing
# branchA_v1. ROLLBACK: set BRANCH_A_MODEL_VERSION=branchA_v1 in the
# environment (or spawning process) to restore the previous model with no
# code change -- every v1 code path in this file is untouched and still
# fully supported.
BRANCH_A_MODEL_VERSION = os.environ.get("BRANCH_A_MODEL_VERSION", "branchA_v2c")
if BRANCH_A_MODEL_VERSION not in BRANCH_A_MODEL_VERSIONS:
    raise ValueError(
        f"BRANCH_A_MODEL_VERSION={BRANCH_A_MODEL_VERSION!r} is not one of "
        f"{sorted(BRANCH_A_MODEL_VERSIONS)}.")

# NEVER calibration_v1.json for a non-v1 version: this is a different FILE,
# not a shared file with a version field checked after the fact, so a v2a
# run cannot find v1's calibration even by accident (see load_calibration()'s
# own modelVersion guard for the second, explicit line of defence).
CALIB_PATH = os.path.join(MODEL_DIR, BRANCH_A_MODEL_VERSIONS[BRANCH_A_MODEL_VERSION]["calib_filename"])

# The checkpoint is resolved by FILENAME, not by a fixed path. The weights are
# not in git and the folder layout under models/ is not stable -- see
# modelPaths.py. A hardcoded path here broke once already when a teammate's
# commit removed the file.

# Cached across calls within one process. Loading EfficientNet-B0 and its
# weights costs a second or so; a long-lived worker should pay that once.
_MODEL = None
_CKPT = None
_CALIB = None


def _fail(msg, code=3):
    print(f"branchAInfer: {msg}", file=sys.stderr)
    sys.exit(code)


def load_calibration(ckpt=None):
    """Temperature and conformal thresholds, fitted by calibrateBranchA.m.

    Absent calibration is NOT silently treated as "no calibration needed".
    T defaults to 1.0 only with an explicit flag in the output, because an
    uncalibrated confidence flowing into the Tier A/B/C routing would look
    exactly like a calibrated one and would route cases on numbers that mean
    something different.

    METHOD GUARD (2026-09-20, updated for score v3): the file at CALIB_PATH
    must declare method == EXPECTED_CALIB_METHOD (the referable-stratified
    ordinal mode-interval scheme, score v3, assign_tier() below implements).
    Unlike the trainedImgSize check, a MISSING or mismatched method is always
    a hard refusal, never treated as "legacy and unverifiable" -- neither the
    old marginal-LAC schema (a single qhat/probThreshold) nor the v2
    per-CLASS Mondrian schema (qhatPerClass, no qhatPerStratum/
    referableThreshold) has fields this code could silently fall back to
    reading, and that is the point: there must be no path from a stale file
    (of either older schema) to a score/tiering rule this code no longer
    implements. See calibration_v1_marginal_lac_ARCHIVE.json for the LAC
    schema; the v2 per-class schema this replaces is 'ordinal_mode_interval_
    mondrian_v2' (qhatPerClass), now equally refused.

    VERSION GUARD (2026-09-19): pass the loaded checkpoint (load_checkpoint())
    and this refuses to treat calibration_v1.json's qhatPerStratum/temperature
    as valid if the file's trainedImgSize doesn't match ckpt["img_size"] --
    e.g. a v2 model trained at 512/640 with a v1-fitted file still in place.
    qhatPerStratum is a quantile of ONE model's nonconformity scores and means
    nothing for a differently-trained one. A calibration file with no
    trainedImgSize field at all (but the right method) is NOT treated as a
    mismatch (nothing to compare), only as unverifiable -- it degrades the
    same way a missing file does, calibrated=True but flagged, not a hard
    failure.

    MODEL-VERSION GUARD (v2a integration, GATE 4): the file must also declare
    modelVersion == BRANCH_A_MODEL_VERSION. CALIB_PATH already points at a
    version-specific filename (never calibration_v1.json for a non-v1
    version), so this guard is a second, explicit check rather than the only
    thing standing between two models' thresholds -- belt and braces, not
    redundant: a copy-pasted file with the right name but a stale
    modelVersion field inside it must still be refused, not silently
    accepted because the filename happened to match.
    """
    if not os.path.exists(CALIB_PATH):
        return {"temperature": 1.0, "qhatPerStratum": None, "calibrated": False,
                "warning": f"{os.path.basename(CALIB_PATH)} missing; run "
                           f"calibrateBranchA.m for {BRANCH_A_MODEL_VERSION}. "
                           "Confidences are UNCALIBRATED."}
    with open(CALIB_PATH, "r", encoding="utf-8") as f:
        c = json.load(f)

    got_method = c.get("method")
    if got_method != EXPECTED_CALIB_METHOD:
        return {"temperature": 1.0, "qhatPerStratum": None, "calibrated": False,
                "warning": (
                    f"{os.path.basename(CALIB_PATH)} has method={got_method!r} but this "
                    f"code requires {EXPECTED_CALIB_METHOD!r} -- REFUSING to apply it (a "
                    "different method's thresholds mean nothing here). Re-run "
                    f"calibrateBranchA.m and overwrite {os.path.basename(CALIB_PATH)} "
                    "before deploying it. Confidences are UNCALIBRATED.")}

    got_version = c.get("modelVersion")
    if got_version != BRANCH_A_MODEL_VERSION:
        return {"temperature": 1.0, "qhatPerStratum": None, "calibrated": False,
                "warning": (
                    f"{os.path.basename(CALIB_PATH)} has modelVersion={got_version!r} but "
                    f"BRANCH_A_MODEL_VERSION={BRANCH_A_MODEL_VERSION!r} -- REFUSING to apply "
                    "it. A calibration fitted for a different model version must NEVER be "
                    "applied here, even if method and trainedImgSize happen to match. "
                    "Confidences are UNCALIBRATED.")}

    trained_size = c.get("trainedImgSize")
    ckpt_size = ckpt.get("img_size") if ckpt else None
    if trained_size is not None and ckpt_size is not None and trained_size != ckpt_size:
        return {"temperature": 1.0, "qhatPerStratum": None, "calibrated": False,
                "warning": (
                    f"{os.path.basename(CALIB_PATH)} was fitted for trainedImgSize="
                    f"{trained_size} but the loaded checkpoint's img_size={ckpt_size} -- "
                    "REFUSING to apply this calibration (qhatPerStratum/temperature from a "
                    "different model mean nothing here). Re-run calibrateBranchA.m against "
                    f"THIS model's predictions and overwrite {os.path.basename(CALIB_PATH)} "
                    "before deploying it. Confidences are UNCALIBRATED until then.")}

    qhat_per_stratum = c.get("qhatPerStratum")
    if not isinstance(qhat_per_stratum, list) or len(qhat_per_stratum) != 2:
        return {"temperature": 1.0, "qhatPerStratum": None, "calibrated": False,
                "warning": (f"{os.path.basename(CALIB_PATH)} declares the right method but "
                            "qhatPerStratum is missing or not length 2 -- REFUSING to "
                            "apply it. Confidences are UNCALIBRATED.")}

    stratum_of = c.get("stratumOf")
    if not isinstance(stratum_of, list) or len(stratum_of) != 5:
        return {"temperature": 1.0, "qhatPerStratum": None, "calibrated": False,
                "warning": (f"{os.path.basename(CALIB_PATH)} declares the right method but "
                            "stratumOf is missing or not length 5 -- REFUSING to "
                            "apply it. Confidences are UNCALIBRATED.")}

    if not isinstance(c.get("referableThreshold"), (int, float)):
        return {"temperature": 1.0, "qhatPerStratum": None, "calibrated": False,
                "warning": (f"{os.path.basename(CALIB_PATH)} declares the right method but "
                            "referableThreshold is missing -- REFUSING to apply it. "
                            "Confidences are UNCALIBRATED.")}

    c["calibrated"] = True
    return c


def load_checkpoint():
    """Just the checkpoint dict -- no model construction.

    Split out of load_model() so preprocessBranchATensor.py (the MATLAB
    backend's tensor-generation step, see that file) can read img_size /
    channel_order / normalize_mean / normalize_std without paying to build
    and load EfficientNet-B0 when all it needs is metadata.
    """
    global _CKPT
    if _CKPT is not None:
        return _CKPT

    import torch
    from modelPaths import resolve, CheckpointMissing
    role = BRANCH_A_MODEL_VERSIONS[BRANCH_A_MODEL_VERSION]["role"]
    try:
        ckpt_path = resolve(role)
    except CheckpointMissing as exc:
        _fail(str(exc))

    _CKPT = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    return _CKPT


# The four checkpoint fields preprocess() reads -- and nothing else.
PREPROCESS_KEYS = ("img_size", "channel_order", "normalize_mean", "normalize_std")


def load_preprocess_meta():
    """preprocess()'s checkpoint metadata, cached on disk across processes.

    preprocessBranchATensor.py is a FRESH process on every case, so the
    in-process _CKPT cache never survived to a second case: each one paid
    `import torch` plus a full torch.load of the checkpoint (~2.9 s measured)
    to read four small values. They are now read FROM THE CHECKPOINT ITSELF
    once and kept in a JSON cache keyed by the checkpoint's resolved path,
    size and mtime, plus BRANCH_A_MODEL_VERSION -- so a swapped or retrained
    checkpoint, or a version switch, misses the cache and is re-read. Nothing
    is hardcoded here; a cache miss is exactly the old behaviour.
    """
    import tempfile
    from modelPaths import resolve, CheckpointMissing
    role = BRANCH_A_MODEL_VERSIONS[BRANCH_A_MODEL_VERSION]["role"]
    try:
        ckpt_path = resolve(role)
    except CheckpointMissing as exc:
        _fail(str(exc))
    st = os.stat(ckpt_path)
    key = {"version": BRANCH_A_MODEL_VERSION, "path": os.path.abspath(ckpt_path),
           "size": st.st_size, "mtime_ns": st.st_mtime_ns}
    cache_path = os.path.join(tempfile.gettempdir(),
                              f"netrasetu_{BRANCH_A_MODEL_VERSION}_preprocess_meta.json")
    try:
        with open(cache_path, encoding="utf-8") as fh:
            cached = json.load(fh)
        if cached.get("key") == key:
            return cached["meta"]
    except (OSError, ValueError, KeyError):
        pass

    ckpt = load_checkpoint()
    meta = {k: ckpt[k] for k in PREPROCESS_KEYS}
    meta = json.loads(json.dumps(meta))   # plain JSON types, same as a cache hit returns
    tmp = f"{cache_path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"key": key, "meta": meta}, fh)
        os.replace(tmp, cache_path)
    except OSError:
        pass   # an unwritable cache only costs the next case the slow path
    return meta


def load_model():
    global _MODEL, _CKPT
    if _MODEL is not None:
        return _MODEL, _CKPT

    import torch.nn as nn
    import timm

    ckpt = load_checkpoint()

    if BRANCH_A_MODEL_VERSION in V2_FAMILY_VERSIONS:
        # Every v2-family checkpoint (branchA_v2a, branchA_v2b, ...) is a
        # DUAL-head checkpoint (5-class + binary referable). This
        # integration ships the 5-class grade only -- the binary head's
        # conformal/deployment story is undecided (see the v2a integration
        # brief). Reuse training/export_to_onnx.py's
        # DRClassifierV2Export/build_v2a_5class_model rather than defining a
        # second wrapper here: that is the SAME class GATE 1's ONNX export
        # uses, so the Python live path and the exported graph are provably
        # built from identical logic, not two hand-kept-in-sync copies. The
        # function's name is a historical artifact of v2a being first --
        # its body only ever reads fields off the ckpt dict it's handed, so
        # it is already generic across the whole v2-family (GENERALIZE, v2b
        # integration: this branch used to check `== "branchA_v2a"`
        # specifically).
        sys.path.insert(0, os.path.join(ML_ROOT, "training"))
        from export_to_onnx import build_v2a_5class_model
        model = build_v2a_5class_model(
            ckpt, label=f"M1 {BRANCH_A_MODEL_VERSION} (5-class head only)")
    else:
        class DRClassifier(nn.Module):
            """Rebuilt from the checkpoint's own `arch` string:
            timm(model_name, num_classes=0, drop_rate=0) -> Dropout -> Linear
            """

            def __init__(self, model_name, num_classes, num_features, drop_rate):
                super().__init__()
                self.backbone = timm.create_model(model_name, pretrained=False,
                                                  num_classes=0, drop_rate=0)
                self.dropout = nn.Dropout(drop_rate)
                self.head = nn.Linear(num_features, num_classes)

            def forward(self, x):
                return self.head(self.dropout(self.backbone(x)))

        model = DRClassifier(ckpt["model_name"], ckpt["num_classes"],
                             ckpt["num_features"], ckpt["drop_rate"])
        model.load_state_dict(ckpt["model_state_dict"], strict=True)

    # eval() is not cosmetic: drop_rate is 0.3, and in train mode every call
    # would sample a different dropout mask and return a different grade for
    # the same photograph.
    model.eval()

    _MODEL, _CKPT = model, ckpt
    return model, ckpt


def display_base(bgr, size):
    """The fundus at the model's geometry, without the contrast step.

    ben_graham does crop -> resize -> contrast boost. Only the first two move
    pixels; the boost is pixel-wise. So repeating the crop and resize gives an
    image the heatmap aligns to EXACTLY while still looking like a retina,
    rather than the grey, contrast-stretched thing the model consumes.

    Display only. If this ever drifted from ben_graham's crop the consequence
    is a heatmap drawn a few pixels off, not a wrong grade — but it is
    duplicated logic and is flagged as such.
    """
    import cv2
    green = bgr[:, :, 1]
    _, mask = cv2.threshold(green, 7, 255, cv2.THRESH_BINARY)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cropped = bgr
    if contours:
        x, y, w, h = cv2.boundingRect(max(contours, key=cv2.contourArea))
        cropped = bgr[y:y + h, x:x + w]
    if cropped.size == 0:
        cropped = bgr
    return cv2.resize(cropped, (size, size), interpolation=cv2.INTER_AREA)


def preprocess(image_path, ckpt):
    """The training chain, imported rather than reimplemented.

    THE shared preprocessing step -- branchAInfer.py's own main() below and
    preprocessBranchATensor.py (the MATLAB backend's tensor-generation
    script) both call this exact function, so the two inference backends see
    identical input by construction rather than by two implementations (one
    of them, formerly, a MATLAB port with a measured SSIM-0.981 residual)
    trying to independently agree. Do not reimplement any piece of this
    elsewhere for any caller, MATLAB included.

    Returns (model_input_NCHW, display_base_bgr, enhanced_rgb_uint8):
      model_input_NCHW    - what the network actually consumes (normalized).
      display_base_bgr    - crop+resize only, no contrast boost, BGR -- this
                             process's own Grad-CAM overlay background.
      enhanced_rgb_uint8   - crop+resize+contrast boost, RGB, uint8, BEFORE
                             normalization -- i.e. model_input_NCHW's pixels
                             one step earlier. Exported for
                             preprocessBranchATensor.py, whose consumer
                             (MATLAB's gradCam.m) expects the same enhanced
                             image the network saw, not the unenhanced one
                             this process's own overlay uses.
    """
    import cv2
    from preprocessing.ben_graham import ben_graham_preprocess

    # cv2.imread returns BGR, which is what ben_graham was written against.
    # Handing it RGB would swap red and blue -- and in a fundus photograph the
    # red channel carries most of the signal, so the result looks plausible
    # and is completely wrong.
    bgr = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if bgr is None:
        _fail(f"could not read image: {image_path}")

    proc = ben_graham_preprocess(bgr, target_size=ckpt["img_size"])
    base = display_base(bgr, ckpt["img_size"])

    if ckpt["channel_order"] == "RGB":
        proc = cv2.cvtColor(proc, cv2.COLOR_BGR2RGB)

    enhanced_rgb_uint8 = proc.copy()

    x = proc.astype(np.float32) / 255.0
    x = (x - np.array(ckpt["normalize_mean"], np.float32)) \
        / np.array(ckpt["normalize_std"], np.float32)
    return x.transpose(2, 0, 1)[None, ...], base, enhanced_rgb_uint8   # HWC -> NCHW


def softmax(v):
    e = np.exp(v - v.max())
    return e / e.sum()


def ordinal_mode_interval_score(probs):
    """Ordinal mode-interval nonconformity score, v3 -- see
    calibration/ordinalModeIntervalScore.m.

    mode = argmax(probs), ties broken to the HIGHER grade (last index
    attaining the max, not the first) -- unchanged from v2. score(mode) = 0
    by definition. For k != mode: score(k) = (sum of probs over the grades
    between mode and k inclusive) MINUS probs[k] -- the interval mass minus
    k's own mass. Nondecreasing as k moves away from the mode.

    v2's score included k's own probability mass in its own score
    (score(mode) == probs[mode], close to 1 for a confident-correct case --
    backwards for a nonconformity score, where low should mean "conforms
    well"). This never showed up in mode MEMBERSHIP (the mode is always
    added to the set regardless of its own score), but it silently inflated
    qhat wherever a grade's own calibration examples included points whose
    true grade equalled the mode, admitting more neighbouring grades than
    the requested alpha should have. v3 fixes the definition itself: see
    experiments/conformalPolicySweep2.py's row_scores_v3 (the reference this
    was ported from) and tests/conformal_golden_vectors.json for the
    hand-worked vectors that pin it down.

    This is a direct, function-for-function port of
    calibration/ordinalModeIntervalScore.m in the MATLAB codebase. It is
    duplicated here only because Branch A's model runs in Python while
    conformal tiering for the MATLAB backend runs in MATLAB (see this file's
    own header for why); the two are NOT allowed to independently drift, and
    tests/conformal_golden_vectors.json plus tests/test_conformal_v2.py
    are what catches it if they ever do -- both implementations are checked
    against the same MATLAB-generated golden vectors on every run.
    """
    max_val = max(probs)
    mode = max(g for g in range(5) if probs[g] == max_val)  # last tie = higher grade
    scores = [0.0] * 5
    for k in range(5):
        if k == mode:
            continue
        lo, hi = (mode, k) if mode <= k else (k, mode)
        scores[k] = sum(probs[lo:hi + 1]) - probs[k]
    return scores, mode


# grades 0..4 -> referable-stratum index (0-based): 0=non-referable (0,1), 1=referable (2,3,4)
STRATUM_OF_CLASS = [0, 0, 1, 1, 1]


def assign_tier(probs, calib):
    """Conformal tier from a contiguous, referable-stratified prediction set
    (score v3), method ordinal_mode_interval_stratified_v3, plus the
    referable-threshold safety gate.

    Membership of candidate grade k is tested as
    score(k) <= qhatPerStratum[stratumOf[k]] + EPS -- the threshold fitted
    from calibration examples whose TRUE grade fell in k's own REFERABLE
    STRATUM (non-referable: 0-1; referable: 2-4), not k's individual grade
    (v2's finest per-grade split could not support a reliable quantile at
    grade 3's n). The mode is always a member regardless of its own score
    (score v3 makes this trivial: score(mode)=0 <= any qhat >= 0). Per-
    stratum thresholds can still reopen gaps in that raw membership even
    though the score is ordinal, so the CONTIGUOUS HULL [min(raw), max(raw)]
    is returned, never the raw set -- it only ever adds coverage, and a
    gapped set like {1,3} misrepresents what "referable vs not" means on an
    ordinal scale. The EPS guard mirrors the score-scale-comparison
    discipline needed for the same reason in v2; here it also absorbs the
    last-bit differences that can arise between this Python implementation
    and the MATLAB one it is checked against in tests/test_conformal_v2.py.

    Because the mode is always a member, the returned set is NEVER empty.

    REFERABLE-THRESHOLD SAFETY GATE (new in v3): a case whose own
    P(g>=2) = sum(probs[2:5]) is >= calib["referableThreshold"] can NEVER be
    Tier A, even if the conformal set itself says {0,1} -- this is a
    separate, independently-fitted check (targets ~95% referable
    sensitivity on its own), not a property of the stratum-conditional set
    guarantee, which is about the stratum on average, not this specific
    case. Demotes A -> B; does not change the reported prediction set.

    Branch disagreement and forced-poor-quality overrides are applied by the
    orchestrator, which is the only place that knows about Branch B.

    Returns (tier, predictionSet, reason, low, high, contiguous).
    """
    if not calib.get("calibrated") or calib.get("qhatPerStratum") is None:
        return None, [], "no calibration available", None, None, None

    qhat_per_stratum = [float(v) for v in calib["qhatPerStratum"]]
    stratum_of = [int(v) for v in calib.get("stratumOf", STRATUM_OF_CLASS)]
    referable_threshold = float(calib["referableThreshold"])
    referable_target_sens = float(calib.get("referableTargetSensitivity", 0.05))
    referable_from = int(calib.get("referableFrom", 2))
    EPS = 1e-9

    scores, mode = ordinal_mode_interval_score(probs)
    qhat_per_candidate = [qhat_per_stratum[stratum_of[k]] for k in range(5)]
    in_set = {g for g in range(5) if scores[g] <= qhat_per_candidate[g] + EPS}
    in_set.add(mode)

    low, high = min(in_set), max(in_set)
    pred_set = list(range(low, high + 1))
    contiguous = (sorted(in_set) == pred_set)

    p_referable = sum(probs[2:5])

    if high < referable_from:
        if p_referable >= referable_threshold - EPS:
            tier = "B"
            reason = (
                f"prediction set is non-referable {pred_set}, but "
                f"P(g>=2)={p_referable:.4f} >= the referable-threshold safety gate "
                f"({referable_threshold:.4f}, fitted for "
                f"{100 * (1 - referable_target_sens):.0f}% referable sensitivity) -- "
                "auto-clear withheld, routed to assisted review")
        else:
            tier = "A"
            reason = (
                f"prediction set {pred_set} contains no referable grade, at "
                "stratum-conditional coverage (target alpha per stratum in "
                f"calib['alphaPerStratum']), and P(g>=2)={p_referable:.4f} is below "
                "the referable-threshold safety gate")
    elif low >= referable_from:
        tier = "B"
        reason = "prediction set is entirely referable"
    else:
        tier = "C"
        reason = "prediction set spans referable and non-referable grades"
    return tier, pred_set, reason, low, high, contiguous


# ── ONNX Runtime backend (BRANCH_A_INFERENCE_ENGINE=onnx) ───────────────────
# The SIH online-demo deployment only (ml-inference-service/, Render free
# web service, 512MB). torch+timm alone cost ~480MB to import and load this
# model -- measured directly, see the deployment session's own notes --
# before a single inference runs, which does not fit. ONNX Runtime's own
# import is ~30MB.
#
# Grad-CAM and MC-dropout are computed in CLOSED FORM instead of via
# autograd: everything after backbone.bn2.act (the spatial feature map
# gradcam.py already hooks, TARGET_LAYER) is global-average-pool ->
# dropout (identity in eval mode for the point estimate) -> one Linear
# layer (head.weight/head.bias) -- simple enough to differentiate and
# resample by hand. This is the SAME technique mcDropoutMatlab.m already
# uses for MC-dropout on the MATLAB backend (verified there to 8.3e-07
# against the real head), extended here to Grad-CAM too:
#
#   d(logits[k])/d(acts[c,h,w]) = head.weight[k,c] / (H*W)   -- CONSTANT
#   over all (h,w) for a fixed channel, because global-average-pooling's
#   own gradient is uniform. So Grad-CAM's channel weights (normally the
#   spatial MEAN of the backprop gradient) equal head.weight[class,:]/(H*W)
#   exactly -- not an approximation, the same formula, computed differently.
#
# Verified against the real torch path (logits, Grad-CAM map, and a
# deterministic same-dropout-mask head-math cross-check that isolates RNG
# differences) across three distinct real images before being trusted:
# logits max|diff| ~5e-6, Grad-CAM max|diff| ~3e-6, head-math cross-check
# ~1e-6 -- see extract_branchA_onnx_artifacts.py's header for how the two
# derived artifacts below were produced.
#
# ONLY supports branchA_v2c (the deployed default): branchA_v2c_graphcam.onnx
# and branchA_v2c_head.npz were generated for that version specifically.
BRANCH_A_INFERENCE_ENGINE = os.environ.get("BRANCH_A_INFERENCE_ENGINE", "torch").strip().lower()
_ONNX_GRAPHCAM_PATH = os.path.join(ML_ROOT, "training", "onnx_out", "branchA_v2c_graphcam.onnx")
_ONNX_HEAD_NPZ_PATH = os.path.join(MODEL_DIR, "Model1", "v2c", "branchA_v2c_head.npz")
# The 5 fields preprocess()/load_calibration() need (img_size, channel_order,
# normalize_mean, normalize_std, preprocessing), extracted once offline
# (extract_branchA_onnx_artifacts.py) -- NOT read via load_checkpoint() here,
# which would import torch just to read them, reintroducing the exact
# ~480MB import cost this whole path exists to avoid.
_ONNX_META_PATH = os.path.join(MODEL_DIR, "Model1", "v2c", "branchA_v2c_meta.json")
_ACT_OUTPUT_NAME = "/backbone/bn2/act/Mul_output_0"


def _softmax_rows(z):
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


def _entropy(p, axis=-1):
    return -(p * np.log(np.clip(p, 1e-12, None))).sum(axis=axis)


def _mc_dropout_onnx(pooled, W, b, drop_rate, temperature, n_passes=20, seed=12345):
    """MC-dropout over the head, closed form: resample a dropout mask on the
    pooled features (the same point dropout acts at in
    DRClassifier.forward: head(dropout(backbone(x)))) and apply the head's
    own frozen weights by hand. Returns the same shape mcDropout.py's
    mc_dropout() does, so both engines write the same quantity into
    grading_results.uncertainty_score.
    """
    if n_passes < 2:
        raise ValueError("n_passes must be at least 2")
    if drop_rate <= 0:
        raise ValueError("no active dropout (drop_rate<=0): every pass would "
                         "be identical and the variance would be exactly 0")

    rng = np.random.default_rng(seed)
    keep_prob = 1.0 - drop_rate
    n_classes = W.shape[0]
    logits_passes = np.empty((n_passes, n_classes), dtype=np.float64)
    for i in range(n_passes):
        mask = (rng.random(pooled.shape[0]) < keep_prob).astype(np.float32) / keep_prob
        logits_passes[i] = W @ (pooled * mask) + b

    probs = _softmax_rows(logits_passes / float(temperature))
    mean = probs.mean(axis=0)
    var = probs.var(axis=0)

    predictive_entropy = float(_entropy(mean))
    expected_entropy = float(_entropy(probs, axis=1).mean())
    mutual_information = max(0.0, predictive_entropy - expected_entropy)
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
        "dropoutLayers": ["head-input (closed-form, BRANCH_A_INFERENCE_ENGINE=onnx)"],
        "dropoutP": [float(drop_rate)],
        "scope": ("head only -- the single dropout layer sits after the "
                  "convolutional trunk, so this samples classifier uncertainty "
                  "over fixed features and cannot see representation "
                  "uncertainty. A confident out-of-distribution image scores "
                  "LOW."),
    }


def run_onnx(image_path, gradcam_path, mc_dropout_passes):
    """The ONNX Runtime twin of main()'s torch block: identical output dict
    shape, computed without torch -- see this section's header comment."""
    if BRANCH_A_MODEL_VERSION != "branchA_v2c":
        _fail("BRANCH_A_INFERENCE_ENGINE=onnx only supports branchA_v2c, got "
             f"BRANCH_A_MODEL_VERSION={BRANCH_A_MODEL_VERSION!r}")
    import onnxruntime as ort

    with open(_ONNX_META_PATH, encoding="utf-8") as fh:
        ckpt = json.load(fh)   # synthetic -- see _ONNX_META_PATH's own comment
    calib = load_calibration(ckpt)
    x, base, _enhanced = preprocess(image_path, ckpt)

    head = np.load(_ONNX_HEAD_NPZ_PATH)
    W, b, drop_rate = head["head_weight"], head["head_bias"], float(head["drop_rate"])

    sess = ort.InferenceSession(_ONNX_GRAPHCAM_PATH, providers=["CPUExecutionProvider"])
    logits, acts = sess.run(["logits", _ACT_OUTPUT_NAME], {"input": x.astype(np.float32)})
    logits = logits[0]
    acts = acts[0]            # (C, H, W) -- backbone.bn2.act, pre-pool
    del sess

    raw = softmax(logits)
    T = float(calib.get("temperature", 1.0))
    cal = softmax(logits / T)
    grade = int(cal.argmax())
    tier, pred_set, tier_reason, set_low, set_high, set_contiguous = assign_tier(cal, calib)

    p_referable = float(cal[2] + cal[3] + cal[4])
    p34 = float(cal[3] + cal[4])
    referable_threshold = calib.get("referableThreshold")
    referable = (p34 > 0.5) or (
        calib.get("calibrated", False) and referable_threshold is not None
        and p_referable >= float(referable_threshold)
    )

    out = {
        "drGradeCnn": grade,
        "confidenceScore": float(cal[grade]),
        "calibratedProbabilities": [float(v) for v in cal],
        "rawProbabilities": [float(v) for v in raw],
        "logits": [float(v) for v in logits],
        "referable": bool(referable),
        "conformalTier": tier,
        "predictionSet": pred_set,
        "predictionSetLow": set_low,
        "predictionSetHigh": set_high,
        "predictionSetContiguous": set_contiguous,
        "tierReason": tier_reason,
        "temperature": T,
        "calibrated": bool(calib.get("calibrated", False)),
        "modelVersion": BRANCH_A_MODEL_VERSION,
        "imgSize": int(ckpt["img_size"]),
        "preprocessing": ckpt.get("preprocessing", ""),
    }
    if calib.get("warning"):
        out["calibrationWarning"] = calib["warning"]

    pooled = acts.mean(axis=(1, 2))          # global average pool, (C,)

    if mc_dropout_passes and mc_dropout_passes >= 2:
        try:
            uncertainty = _mc_dropout_onnx(pooled, W, b, drop_rate, T,
                                           n_passes=mc_dropout_passes)
            out["uncertaintyScore"] = uncertainty["uncertaintyScore"]
            out["uncertainty"] = uncertainty
        except Exception as exc:  # noqa: BLE001 -- must not fail the grade
            out["uncertaintyScore"] = None
            out["uncertaintyError"] = f"{type(exc).__name__}: {exc}"
            print(f"branchAInfer: MC-dropout (onnx) failed: {exc}", file=sys.stderr)
    else:
        out["uncertaintyScore"] = None

    if gradcam_path:
        try:
            Hc, Wc = acts.shape[1], acts.shape[2]
            weights = W[grade] / (Hc * Wc)
            cam = np.maximum(0.0, (weights[:, None, None] * acts).sum(axis=0)).astype(np.float32)
            peak = cam.max()
            if peak > 0:
                cam = cam / peak
            from gradcam import save_overlay
            info = save_overlay(cam, base, gradcam_path)
            out["gradcam"] = info
            out["gradcamClass"] = grade
            out["gradcamMap"] = [[float(v) for v in row] for row in cam]
            out["gradcamPath"] = gradcam_path
            if info.get("mostlyOutsideRetina"):
                out["gradcamWarning"] = (
                    "most of the model's attention fell OUTSIDE the retinal "
                    "circle -- the grade may rest on camera artefacts rather "
                    "than on the eye")
        except Exception as exc:  # noqa: BLE001 -- must not fail the grade
            out["gradcamPath"] = None
            out["gradcamError"] = f"{type(exc).__name__}: {exc}"
            print(f"branchAInfer: Grad-CAM (onnx) failed: {exc}", file=sys.stderr)

    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image", nargs="?", help="path to the fundus image")
    ap.add_argument("--gradcam", metavar="PNG",
                    help="also write a Grad-CAM overlay to this path")
    ap.add_argument("--mc-dropout", type=int, default=20, metavar="N",
                    help="MC-dropout passes for uncertainty_score (0 disables)")
    args = ap.parse_args()

    if not args.image:
        print("usage: branchAInfer.py <imagePath>", file=sys.stderr)
        sys.exit(2)
    if not os.path.exists(args.image):
        _fail(f"no file at {args.image}")

    try:
        if BRANCH_A_INFERENCE_ENGINE == "onnx":
            out = run_onnx(args.image, args.gradcam, args.mc_dropout)
            print(json.dumps(out))
            return 0

        import torch
        model, ckpt = load_model()
        calib = load_calibration(ckpt)

        x, base, _enhanced = preprocess(args.image, ckpt)  # _enhanced unused here -- this
        # process's own Grad-CAM overlay uses `base`; enhanced_rgb_uint8 exists for
        # preprocessBranchATensor.py's caller (MATLAB), not this one.
        with torch.no_grad():
            logits = model(torch.from_numpy(x)).numpy()[0]

        raw = softmax(logits)
        T = float(calib.get("temperature", 1.0))
        cal = softmax(logits / T)

        grade = int(cal.argmax())
        tier, pred_set, tier_reason, set_low, set_high, set_contiguous = assign_tier(cal, calib)

        # Live referable flag (conformal policy v3): P(g>=2) clearing the
        # fitted referableThreshold (targets ~95% referable sensitivity on
        # its own, independent of the conformal set/tier), OR the grade-3/
        # grade-4 safety check (P(g3)+P(g4) > 0.5) -- catches a genuinely
        # proliferative-leaning case even when neither single grade nor the
        # combined referable mass alone crosses its own threshold. The
        # safety-check term does not require calibration; the
        # referableThreshold term does (absent calibration, only the safety
        # check can fire, which is intentional -- referable must never look
        # MORE confident than the model's calibration state actually
        # supports).
        p_referable = float(cal[2] + cal[3] + cal[4])
        p34 = float(cal[3] + cal[4])
        referable_threshold = calib.get("referableThreshold")
        referable = (p34 > 0.5) or (
            calib.get("calibrated", False) and referable_threshold is not None
            and p_referable >= float(referable_threshold)
        )

        out = {
            "drGradeCnn": grade,
            "confidenceScore": float(cal[grade]),
            "calibratedProbabilities": [float(v) for v in cal],
            "rawProbabilities": [float(v) for v in raw],
            "logits": [float(v) for v in logits],
            "referable": bool(referable),
            "conformalTier": tier,
            "predictionSet": pred_set,
            "predictionSetLow": set_low,
            "predictionSetHigh": set_high,
            "predictionSetContiguous": set_contiguous,
            "tierReason": tier_reason,
            "temperature": T,
            "calibrated": bool(calib.get("calibrated", False)),
            # The ACTUAL resolved version, not calib.get("modelVersion", ...):
            # calib can be legitimately uncalibrated/absent (v2a today, by
            # design -- see the v2a integration brief) while inference still
            # ran on a real, known model. Reading this from calib would have
            # reported "branchA_v1" while actually running v2a's weights
            # whenever calibration was missing -- a real bug this fixes, not
            # cosmetic: gradingOrchestrator.js and the DB row trust this
            # field to know which model actually produced the grade.
            "modelVersion": BRANCH_A_MODEL_VERSION,
            "imgSize": int(ckpt["img_size"]),
            "preprocessing": ckpt.get("preprocessing", ""),
        }
        if calib.get("warning"):
            out["calibrationWarning"] = calib["warning"]

        # ── Task 6.1: MC-dropout uncertainty ───────────────────────────────
        # Same process and same preprocessed tensor as the grade. On this model
        # the convolutional trunk is deterministic and the single dropout sits
        # after it, so 20 passes cost ~0.1 s -- the trunk runs once.
        #
        # A failure here must NOT fail the grade: uncertainty_score orders the
        # review QUEUE, it does not decide anything clinical. The column stays
        # NULL and the queue falls back to (1 - confidence), which is what it
        # already does. NULL means "not measured"; 0.0 would mean "measured, and
        # maximally certain", and those must never be confused.
        if args.mc_dropout and args.mc_dropout >= 2:
            try:
                from mcDropout import mc_dropout
                mc = mc_dropout(model, torch.from_numpy(x),
                                n_passes=args.mc_dropout, temperature=T)
                out["uncertaintyScore"] = mc["uncertaintyScore"]
                out["uncertainty"] = mc
            except Exception as exc:  # noqa: BLE001
                out["uncertaintyScore"] = None
                out["uncertaintyError"] = f"{type(exc).__name__}: {exc}"
                print(f"branchAInfer: MC-dropout failed: {exc}", file=sys.stderr)
        else:
            out["uncertaintyScore"] = None

        # ── Grad-CAM, in the same process ──────────────────────────────────
        # Same spawn as the grade: the interpreter start and model load
        # dominate the cost, so a second process would roughly double the time
        # to produce one explained result.
        #
        # A Grad-CAM failure must NOT fail the grade. The grade is the clinical
        # output and is already computed; losing the picture is a degraded
        # result, not a lost one. The reason is reported rather than swallowed.
        if args.gradcam:
            try:
                from gradcam import compute_gradcam, save_overlay
                cam, cam_class, _ = compute_gradcam(model, torch.from_numpy(x),
                                                    class_index=grade)
                info = save_overlay(cam, base, args.gradcam)
                out["gradcam"] = info
                out["gradcamClass"] = cam_class
                # The RAW cam, at its own 12x12 resolution -- 144 floats, small
                # enough to travel in the JSON. Task 7.1 scores attention
                # against a lesion mask and needs the map itself; the overlay
                # PNG has already been colour-mapped and alpha-blended with the
                # fundus, so recovering the map from it is not possible.
                out["gradcamMap"] = [[float(v) for v in row] for row in cam]
                out["gradcamPath"] = args.gradcam
                if info.get("mostlyOutsideRetina"):
                    out["gradcamWarning"] = (
                        "most of the model's attention fell OUTSIDE the retinal "
                        "circle -- the grade may rest on camera artefacts rather "
                        "than on the eye")
            except Exception as exc:  # noqa: BLE001
                out["gradcamPath"] = None
                out["gradcamError"] = f"{type(exc).__name__}: {exc}"
                print(f"branchAInfer: Grad-CAM failed: {exc}", file=sys.stderr)

        print(json.dumps(out))
        return 0

    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - the boundary must not leak a traceback to stdout
        _fail(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
