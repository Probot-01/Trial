

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


BRANCH_A_MODEL_VERSIONS = {
    "branchA_v1":  {"role": "classifier", "calib_filename": "calibration_v1.json"},
    "branchA_v2a": {"role": "classifier_v2a", "calib_filename": "calibration_branchA_v2a.json"},
    "branchA_v2b": {"role": "classifier_v2b", "calib_filename": "calibration_branchA_v2b.json"},
    "branchA_v2c": {"role": "classifier_v2c", "calib_filename": "calibration_branchA_v2c.json"},
}

V2_FAMILY_VERSIONS = ("branchA_v2a", "branchA_v2b", "branchA_v2c")


BRANCH_A_MODEL_VERSION = os.environ.get("BRANCH_A_MODEL_VERSION", "branchA_v2c")
if BRANCH_A_MODEL_VERSION not in BRANCH_A_MODEL_VERSIONS:
    raise ValueError(
        f"BRANCH_A_MODEL_VERSION={BRANCH_A_MODEL_VERSION!r} is not one of "
        f"{sorted(BRANCH_A_MODEL_VERSIONS)}.")

CALIB_PATH = os.path.join(MODEL_DIR, BRANCH_A_MODEL_VERSIONS[BRANCH_A_MODEL_VERSION]["calib_filename"])

_MODEL = None
_CKPT = None
_CALIB = None


def _fail(msg, code=3):
    print(f"branchAInfer: {msg}", file=sys.stderr)
    sys.exit(code)


def load_calibration(ckpt=None):
    
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

  
    model.eval()

    _MODEL, _CKPT = model, ckpt
    return model, ckpt


def display_base(bgr, size):
   
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



BRANCH_A_INFERENCE_ENGINE = os.environ.get("BRANCH_A_INFERENCE_ENGINE", "torch").strip().lower()
_ONNX_GRAPHCAM_PATH = os.path.join(ML_ROOT, "training", "onnx_out", "branchA_v2c_graphcam.onnx")
_ONNX_HEAD_NPZ_PATH = os.path.join(MODEL_DIR, "Model1", "v2c", "branchA_v2c_head.npz")

_ONNX_META_PATH = os.path.join(MODEL_DIR, "Model1", "v2c", "branchA_v2c_meta.json")
_ACT_OUTPUT_NAME = "/backbone/bn2/act/Mul_output_0"


def _softmax_rows(z):
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


def _entropy(p, axis=-1):
    return -(p * np.log(np.clip(p, 1e-12, None))).sum(axis=axis)


def _mc_dropout_onnx(pooled, W, b, drop_rate, temperature, n_passes=20, seed=12345):
  
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

       
        if args.gradcam:
            try:
                from gradcam import compute_gradcam, save_overlay
                cam, cam_class, _ = compute_gradcam(model, torch.from_numpy(x),
                                                    class_index=grade)
                info = save_overlay(cam, base, args.gradcam)
                out["gradcam"] = info
                out["gradcamClass"] = cam_class
              
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
