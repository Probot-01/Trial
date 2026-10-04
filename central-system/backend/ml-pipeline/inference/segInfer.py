

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


FOVEA_PEAK_THRESHOLD = 0.37


RED_LESION_MODEL_VERSIONS = {"v1": "red_lesion", "v2": "red_lesion_v2"}

RED_LESION_MODEL_VERSION = os.environ.get("RED_LESION_MODEL_VERSION", "v2")


DEFAULT_MIN_AREA = 10
if RED_LESION_MODEL_VERSION not in RED_LESION_MODEL_VERSIONS:
    raise ValueError(
        f"RED_LESION_MODEL_VERSION={RED_LESION_MODEL_VERSION!r} is not one of "
        f"{sorted(RED_LESION_MODEL_VERSIONS)}.")


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



SEG_BACKEND = os.environ.get("SEG_INFERENCE_BACKEND", "matlab").strip().lower()
SEG_ALLOW_PYTHON_FALLBACK = os.environ.get("SEG_ALLOW_PYTHON_FALLBACK", "") == "1"
_MATLAB_NETS = {
    "vessel": "vessel_unet_v1",
    "localization": "localization_v1",
    "hard_exudate": "bright_lesion_unet_v1",
    "red_lesion_v2": "red_lesion_unet_v2",
}


_ONNX_FILES = {
    "vessel": "vessel_unet_v1.onnx",
    "localization": "localization_v1.onnx",
    "hard_exudate": "bright_lesion_unet_v1.onnx",
    "red_lesion_v2": "red_lesion_unet_v2.onnx",
}


def _forward_onnx(role, x):
    """Forward pass via ONNX Runtime, loaded and released per call -- no
    persistent cache (unlike load()'s _MODELS dict), so memory is freed
    between models rather than accumulating across all four."""
    import onnxruntime as ort
    if role not in _ONNX_FILES:
        raise KeyError(f"no ONNX export registered for role {role!r}; "
                       f"known: {sorted(_ONNX_FILES)}")
    path = os.path.join(ML_ROOT, "training", "onnx_out", _ONNX_FILES[role])
    if not os.path.exists(path):
        _fail(f"ONNX model not found: {path}")
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name
    out = sess.run(None, {inp_name: x.astype(np.float32)})[0]
    del sess
    return out[0]

BACKEND_USED = {}

EXIT_MATLAB_FAILED = 4


class MatlabEngineFailed(RuntimeError):



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
            return _forward(load(role)[0], x)
    elif SEG_BACKEND == "onnx":
        BACKEND_USED[role] = {"engine": "python", "fallback": False,
                              "detail": f"ONNX Runtime ({_ONNX_FILES.get(role, role)}, "
                                        "SEG_INFERENCE_BACKEND=onnx)"}
        return _forward_onnx(role, x)
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
           
            "x512": float(ix), "y512": float(iy),
            "x": float(ix) * w / INPUT_SIZE,
            "y": float(iy) * h / INPUT_SIZE,
            "peak": float(hm[idx].max()),
        }

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
   
    resized = cv2.resize(gray, (nw, nh), interpolation=cv2.INTER_LINEAR)
    out = np.zeros((size, size), resized.dtype)
    ox, oy = (size - nw) // 2, (size - nh) // 2
    out[oy:oy + nh, ox:ox + nw] = resized
    return out, (ox, oy, nw, nh)


def vessels(bgr):
 
    h, w = bgr.shape[:2]
    green = bgr[:, :, 1]
    padded, (ox, oy, nw, nh) = _aspect_pad(green)
    x = ((padded.astype(np.float32) / 255.0) - 0.5) / 0.5
    logits = _run("vessel", x[None, None, ...])[0]
    prob = 1.0 / (1.0 + np.exp(-logits))

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

    x = ((rgb512.astype(np.float32) / 255.0) - 0.5) / 0.5
    logits = _run(role, x.transpose(2, 0, 1)[None, ...])[0]
    return 1.0 / (1.0 + np.exp(-logits))


def _lesion_prob_v2(role, rgb512):

    x = ((rgb512.astype(np.float32) / 255.0) - 0.5) / 0.5

    logits = _run(role, x.transpose(2, 0, 1)[None, ...])  # (3, H, W)
    e = np.exp(logits - logits.max(axis=0, keepdims=True))
    return e / e.sum(axis=0, keepdims=True)


def lesions(bgr, disc_xy):

    h, w = bgr.shape[:2]
    rgb512, box = _crop512(bgr)

    role = RED_LESION_MODEL_VERSIONS[RED_LESION_MODEL_VERSION]
    ma512 = he512 = None
    if RED_LESION_MODEL_VERSION == "v2":

        probs3 = _lesion_prob_v2(role, rgb512)
        cls = probs3.argmax(axis=0)
        red = cls != 0
        ma512 = cls == 1
        he512 = cls == 2
    else:
        red = _lesion_prob(role, rgb512) > 0.5
    bright = _lesion_prob("hard_exudate", rgb512) > 0.5  # GATE 4: role was "bright_lesion"


    od_masked = False
    if disc_xy is not None:
        cx, cy = _to_crop512(disc_xy[0], disc_xy[1], box)
        if np.isfinite(cx) and np.isfinite(cy):
            yy, xx = np.ogrid[:INPUT_SIZE, :INPUT_SIZE]
            bright = bright & (((xx - cx) ** 2 + (yy - cy) ** 2) > OD_MASK_RADIUS ** 2)
            od_masked = True


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
  
        back = cv2.resize(mask.astype(np.uint8), (bw, bh),
                          interpolation=cv2.INTER_NEAREST).astype(bool)
        full[y0:y0 + bh, x0:x0 + bw] = back
        return full


    red_v2_extra = {"ma512": ma512, "he512": he512} if RED_LESION_MODEL_VERSION == "v2" else None
    return to_original(red), to_original(bright), od_masked, red, bright, box, red_v2_extra


# ── Reporting ──────────────────────────────────────────────────────────────
def quadrant_counts(components, fovea_xy, disc_xy):
  
    axis = np.array(disc_xy, float) - np.array(fovea_xy, float)
    norm = np.linalg.norm(axis)
    if norm < 1e-6:
     
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


    fovea = (pts["fovea"]["x"], pts["fovea"]["y"])
    disc512 = _to_crop512(disc[0], disc[1], box)
    fovea512 = _to_crop512(fovea[0], fovea[1], box)
    red_comps = describe(red512, min_area)
    bright_comps = describe(bright512, min_area)
    red_q = quadrant_counts(red_comps, fovea512, disc512)
    bright_q = quadrant_counts(bright_comps, fovea512, disc512)


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
  
        "brightLesions": summarise(bright512, min_area),
        "odMaskApplied": od_masked,
        "odMaskRadiusCrop512": OD_MASK_RADIUS,

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


    if RED_LESION_MODEL_VERSION == "v2":
        out["maPerQuadrant"] = ma_q
        out["hePerQuadrant"] = he_q
        out["lesionCounts"] = lesion_counts_v2
        out["redLesionModelVersion"] = RED_LESION_MODEL_VERSION

    if outdir:
        base = os.path.splitext(os.path.basename(image))[0]
     
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
