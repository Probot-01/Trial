

import argparse
import json
import os
import sys

import cv2
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ML_ROOT, "inference"))
sys.path.insert(0, ML_ROOT)

GRADING = os.path.join(ML_ROOT, "datasets", "idrid", "grading",
                       "B. Disease Grading", "1. Original Images")
MODEL1 = os.path.join(ML_ROOT, "models", "Model1")
REFERABLE_FROM = 2


# ── Perturbations ──────────────────────────────────────────────────────────
def vignette(bgr, strength):
    """Radial darkening toward the edges. A small aperture on a cheap lens."""
    h, w = bgr.shape[:2]
    yy, xx = np.ogrid[:h, :w]
    cy, cx = h / 2.0, w / 2.0
    r = np.sqrt(((yy - cy) / cy) ** 2 + ((xx - cx) / cx) ** 2)
    fall = np.clip(1.0 - strength * (r ** 2), 0.0, 1.0).astype(np.float32)
    return np.clip(bgr.astype(np.float32) * fall[..., None], 0, 255).astype(np.uint8)


def colour_shift(bgr, strength):
    """Per-channel gain: white-balance drift from uncalibrated LEDs.

    Warm shift (more red, less blue) because that is the direction cheap
    illumination actually drifts, and a fundus image is dominated by red -- so
    this pushes the channel carrying most of the signal.
    """
    gains = np.array([1.0 - 0.35 * strength, 1.0, 1.0 + 0.30 * strength], np.float32)
    return np.clip(bgr.astype(np.float32) * gains, 0, 255).astype(np.uint8)


def resolution_loss(bgr, strength):
    """Downsample and upsample: a lower-resolution sensor."""
    h, w = bgr.shape[:2]
    f = max(0.05, 1.0 - 0.85 * strength)
    small = cv2.resize(bgr, (max(8, int(w * f)), max(8, int(h * f))),
                       interpolation=cv2.INTER_AREA)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


def defocus(bgr, strength):
    """Gaussian blur: hand-held mount, imperfect focus."""
    k = int(max(1, round(strength * 12))) * 2 + 1
    return cv2.GaussianBlur(bgr, (k, k), 0)


def jpeg(bgr, strength):
    """Aggressive JPEG: bandwidth-constrained capture and transfer."""
    q = int(np.clip(95 - 85 * strength, 5, 95))
    ok, enc = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), q])
    return cv2.imdecode(enc, cv2.IMREAD_COLOR) if ok else bgr


PERTURBATIONS = {
    "vignette": vignette,
    "colour_shift": colour_shift,
    "resolution_loss": resolution_loss,
    "defocus": defocus,
    "jpeg": jpeg,
}


def combined(bgr, strength):
    out = bgr
    for fn in (vignette, colour_shift, resolution_loss, defocus, jpeg):
        out = fn(out, strength)
    return out


# ── Metrics ────────────────────────────────────────────────────────────────
def quadratic_kappa(a, b, n_classes=5):
    a, b = np.asarray(a, int), np.asarray(b, int)
    O = np.zeros((n_classes, n_classes))
    for x, y in zip(a, b):
        O[x, y] += 1
    w = np.array([[(i - j) ** 2 for j in range(n_classes)] for i in range(n_classes)],
                 float) / (n_classes - 1) ** 2
    ha, hb = np.bincount(a, minlength=n_classes), np.bincount(b, minlength=n_classes)
    E = np.outer(ha, hb).astype(float)
    E *= O.sum() / E.sum()
    denom = (w * E).sum()
    return 1.0 - (w * O).sum() / denom if denom else float("nan")


def score(truth, pred, conf, tiers):
    truth, pred = np.asarray(truth), np.asarray(pred)
    ref_t, ref_p = truth >= REFERABLE_FROM, pred >= REFERABLE_FROM
    tp = int((ref_t & ref_p).sum()); fn = int((ref_t & ~ref_p).sum())
    tn = int((~ref_t & ~ref_p).sum()); fp = int((~ref_t & ref_p).sum())
    return {
        "n": int(len(truth)),
        "accuracy": float((truth == pred).mean()),
        "sensitivity": float(tp / (tp + fn)) if tp + fn else float("nan"),
        "specificity": float(tn / (tn + fp)) if tn + fp else float("nan"),
        "quadraticKappa": float(quadratic_kappa(truth, pred)),
        "meanConfidence": float(np.mean(conf)),
        "tierA": int(sum(t == "A" for t in tiers)),
        "tierB": int(sum(t == "B" for t in tiers)),
        "tierC": int(sum(t == "C" for t in tiers)),
    }


# ── Runner ─────────────────────────────────────────────────────────────────
def resolve_idrid(id_string):
    """idrid__idrid_train_IDRiD_396 -> the actual file.

    The id names its own source folder, which is the only reliable way to pick
    between IDRiD's Training and Testing directories: they reuse filenames.
    """
    part = id_string.split("__", 1)[1]
    fname = "IDRiD_" + part.split("_IDRiD_")[1]
    split = part.split("_IDRiD_")[0].replace("idrid_", "")
    folder = "a. Training Set" if split == "train" else "b. Testing Set"
    path = os.path.join(GRADING, folder, fname + ".jpg")
    return path if os.path.exists(path) else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=0, help="limit images (0 = all)")
    ap.add_argument("--out", default=os.path.join(HERE, "domain_gap_results.json"))
    args = ap.parse_args()

    sys.argv = [sys.argv[0]]
    import branchAInfer as B

    model, ckpt = B.load_model()
    calib = B.load_calibration()
    T = float(calib.get("temperature", 1.0))

    ids = np.load(os.path.join(MODEL1, "branchA_v1_test_ids.npy"), allow_pickle=True)
    labels = np.load(os.path.join(MODEL1, "branchA_v1_test_labels.npy"), allow_pickle=True)

    cases = []
    for id_string, y in zip(ids, labels):
        s = str(id_string)
        if not s.startswith("idrid"):
            continue
        path = resolve_idrid(s)
        if path:
            cases.append((path, int(y)))
    if args.n:
        cases = cases[:args.n]
    print(f"held-out IDRiD test images resolved: {len(cases)}")

    def evaluate(transform, strength):
        truth, pred, conf, tiers = [], [], [], []
        for path, y in cases:
            bgr = cv2.imread(path, cv2.IMREAD_COLOR)
            if transform is not None:
                bgr = transform(bgr, strength)
            # Preprocessing runs on the PERTURBED image, exactly as it would in
            # the field. Perturbing after preprocessing would measure a
            # different and much easier problem.
            from preprocessing.ben_graham import ben_graham_preprocess
            proc = ben_graham_preprocess(bgr, target_size=ckpt["img_size"])
            if ckpt["channel_order"] == "RGB":
                proc = cv2.cvtColor(proc, cv2.COLOR_BGR2RGB)
            x = proc.astype(np.float32) / 255.0
            x = (x - np.array(ckpt["normalize_mean"], np.float32)) \
                / np.array(ckpt["normalize_std"], np.float32)
            with torch.no_grad():
                logits = model(torch.from_numpy(x.transpose(2, 0, 1)[None, ...])).numpy()[0]
            p = B.softmax(logits / T)
            g = int(p.argmax())
            tier, _set, _why = B.assign_tier(p, calib)
            truth.append(y); pred.append(g); conf.append(float(p[g])); tiers.append(tier)
        return score(truth, pred, conf, tiers)

    results = {"baseline": evaluate(None, 0.0)}
    print(f"\nbaseline  {fmt(results['baseline'])}")

    strengths = [0.25, 0.5, 1.0]
    for name, fn in list(PERTURBATIONS.items()) + [("combined", combined)]:
        results[name] = {}
        for s in strengths:
            r = evaluate(fn, s)
            results[name][str(s)] = r
            print(f"{name:16s} s={s:<5} {fmt(r)}")

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2)
    print(f"\nwritten to {args.out}")
    return 0


def fmt(r):
    return (f"acc {r['accuracy']:.3f}  sens {r['sensitivity']:.3f}  "
            f"spec {r['specificity']:.3f}  kappa {r['quadraticKappa']:.3f}  "
            f"conf {r['meanConfidence']:.3f}  A/B/C {r['tierA']}/{r['tierB']}/{r['tierC']}")


if __name__ == "__main__":
    raise SystemExit(main())
