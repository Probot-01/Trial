

import argparse
import csv
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ML_ROOT, "inference"))
sys.path.insert(0, ML_ROOT)

import segInfer      # noqa: E402
import verifyModel3  # noqa: E402

INPUT_SIZE = segInfer.INPUT_SIZE
LOC = verifyModel3.LOC
OD_RADIUS_FRAC = 0.0655          # see evalIdridOnnx.py
# A gross miss: past one optic-disc DIAMETER. Far beyond annotator
# disagreement, and past the point where the quadrant axis survives.
GROSS_MULT = 2.0

GT_DIRS = {"od": ("2. Groundtruths", "1. Optic Disc Center Location"),
           "fovea": ("2. Groundtruths", "2. Fovea Center Location")}
GT_FILES = {("od", "train"): "a. IDRiD_OD_Center_Training Set_Markups.csv",
            ("od", "test"): "b. IDRiD_OD_Center_Testing Set_Markups.csv",
            ("fovea", "train"): "IDRiD_Fovea_Center_Training Set_Markups.csv",
            ("fovea", "test"): "IDRiD_Fovea_Center_Testing Set_Markups.csv"}
IMG_DIRS = {"train": "a. Training Set", "test": "b. Testing Set"}


def load_gt(landmark, split):
    return verifyModel3._read_gt(
        os.path.join(LOC, *GT_DIRS[landmark], GT_FILES[(landmark, split)]))


def build_cases(which):
    if which == "heldout":
        with open(verifyModel3.PRED_CSV, newline="", encoding="utf-8-sig") as fh:
            rows = list(csv.DictReader(fh))
        resolved, unresolved = verifyModel3.resolve_images(rows)
        if unresolved:
            print(f"  {len(unresolved)} ids unresolved, excluded: {unresolved}")
        return [(i, s, p) for i, (s, p) in sorted(resolved.items())]
    cases = []
    for split in ("train", "test"):
        folder = os.path.join(LOC, "1. Original Images", IMG_DIRS[split])
        for f in sorted(os.listdir(folder)):
            if f.lower().endswith((".jpg", ".jpeg", ".png")):
                cases.append((os.path.splitext(f)[0], split,
                              os.path.join(folder, f)))
    return cases


def auc(scores, labels):
    """ROC AUC via rank sum. labels: 1 = the event we want to detect."""
    s, y = np.asarray(scores, float), np.asarray(labels, int)
    pos, neg = int(y.sum()), int((1 - y).sum())
    if pos == 0 or neg == 0:
        return float("nan")
    order = np.argsort(s)
    ranks = np.empty(len(s), float)
    ranks[order] = np.arange(1, len(s) + 1)
    # Average ranks over ties so a detector is not credited for arbitrary
    # tie-breaking order.
    _, inv, cnt = np.unique(s, return_inverse=True, return_counts=True)
    for i, c in enumerate(cnt):
        if c > 1:
            ranks[inv == i] = ranks[inv == i].mean()
    return float((ranks[y == 1].sum() - pos * (pos + 1) / 2) / (pos * neg))


def detector_report(name, scores, is_bad, lower_is_bad=True):
    """How well does `scores` flag the gross misses?"""
    scores = np.asarray(scores, float)
    is_bad = np.asarray(is_bad, bool)
    n_bad = int(is_bad.sum())
    if n_bad == 0:
        print(f"    {name:<26s} (no gross misses to detect)")
        return None
    # AUC is computed on the orientation where HIGHER = more suspicious, so
    # the three detectors are directly comparable.
    signal = -scores if lower_is_bad else scores
    a = auc(signal, is_bad.astype(int))

    # The operating point that matters: flag every gross miss, and report what
    # that costs in false alarms. A detector is only useful to the pipeline if
    # that cost is small enough to act on.
    thr_all = signal[is_bad].min()
    flagged = signal >= thr_all
    fp = int((flagged & ~is_bad).sum())
    clean = int((~is_bad).sum())
    print(f"    {name:<26s} AUC {a:.3f}   "
          f"catch all {n_bad} at cost {fp}/{clean} false alarms "
          f"({100.0 * fp / clean:.1f}%)")
    return {"auc": a, "false_alarms_to_catch_all": fp, "clean": clean}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", dest="which", default="heldout",
                    choices=["heldout", "all"])
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    import cv2
    import torch

    model, ckpt = segInfer.load("localization")
    print("M3 LOCALIZATION -- PyTorch checkpoint")
    print(f"  arch {segInfer._ARCH['localization']}")
    print(f"  checkpoint best_val_pixel_error: "
          f"{ckpt.get('best_val_pixel_error')} px (512-space)")
    print(f"  sigma {ckpt.get('sigma')}  input_size {ckpt.get('input_size')}")

    cases = build_cases(args.which)
    contaminated = args.which != "heldout"
    print(f"\nset: {args.which}   images: {len(cases)}")
    print("status: " + ("*** CONTAMINATED -- M3 trained on most of these ***"
                        if contaminated else
                        "HELD OUT by the model. Estimates generalization."))

    gt = {(lm, sp): load_gt(lm, sp) for lm in ("od", "fovea")
          for sp in ("train", "test")}

    rows = []
    for img_id, split, path in cases:
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        if bgr is None:
            continue
        h, w = bgr.shape[:2]
        with torch.no_grad():
            hm = model(verifyModel3.preprocess(bgr))[0].numpy()

        rec = {"id": img_id, "split": split, "w": w, "h": h,
               "radius": OD_RADIUS_FRAC * w}
        ok = True
        for idx, lm in ((0, "od"), (1, "fovea")):
            truth = gt[(lm, split)].get(img_id)
            if truth is None:
                ok = False
                break
            plane = hm[idx]
            iy, ix = np.unravel_index(plane.argmax(), plane.shape)
            px, py = float(ix) * w / INPUT_SIZE, float(iy) * h / INPUT_SIZE
            rec[lm] = {
                "pred": (px, py), "true": truth,
                "err": float(np.hypot(px - truth[0], py - truth[1])),
                "err512": float(np.hypot(
                    float(ix) - truth[0] * INPUT_SIZE / w,
                    float(iy) - truth[1] * INPUT_SIZE / h)),
                "peak": float(plane.max()),
                # Peak height alone says little: a flat heatmap can have a
                # numerically high maximum. The margin over the plane's own
                # mean is what says the peak stands out.
                "margin": float(plane.max() - plane.mean()),
                "xy512": (int(ix), int(iy)),
            }
        if not ok:
            continue

        # Anatomy: disc-to-fovea is ~2-3 disc diameters in a real eye. Uses
        # the PREDICTED positions only, so it is computable at inference time.
        dd = 2.0 * rec["radius"]
        rec["dd_sep"] = float(np.hypot(
            rec["od"]["pred"][0] - rec["fovea"]["pred"][0],
            rec["od"]["pred"][1] - rec["fovea"]["pred"][1]) / dd)
        rec["dd_sep_true"] = float(np.hypot(
            rec["od"]["true"][0] - rec["fovea"]["true"][0],
            rec["od"]["true"][1] - rec["fovea"]["true"][1]) / dd)
        rows.append(rec)

    print(f"scored: {len(rows)}")
    out = {"set": args.which, "n": len(rows), "contaminated": contaminated}

    print(f"\n{'=' * 74}")
    print("ACCURACY")
    print("=" * 74)
    for lm, label in (("od", "OPTIC DISC"), ("fovea", "FOVEA")):
        e = np.array([r[lm]["err"] for r in rows])
        e512 = np.array([r[lm]["err512"] for r in rows])
        frac = np.array([r[lm]["err"] / r["radius"] for r in rows])
        print(f"\n  {label}")
        print(f"    mean {e.mean():9.2f} px   median {np.median(e):8.2f} px   "
              f"sd {e.std():9.2f} px   max {e.max():9.1f} px")
        print(f"    mean {e512.mean():9.2f} px (512-space), median "
              f"{np.median(e512):.2f}")
        print(f"    mean/median ratio {e.mean() / np.median(e):.2f}   "
              f"(a ratio far above 1 means outliers, not spread)")
        for m in (0.25, 0.5, 1.0, 2.0):
            print(f"    within {m:>4.2f}R : {100.0 * (frac <= m).mean():6.2f}%"
                  f"  ({int((frac <= m).sum())}/{len(frac)})")
        out.setdefault("accuracy", {})[lm] = {
            "mean": float(e.mean()), "median": float(np.median(e)),
            "sd": float(e.std()), "max": float(e.max()),
            "mean512": float(e512.mean()),
            "within1R": float((frac <= 1.0).mean()) * 100.0}

    # ---- the failure mode ----
    print(f"\n{'=' * 74}")
    print(f"FAILURE MODE -- gross misses (> {GROSS_MULT:.0f}R = "
          f"{GROSS_MULT / 2:.0f} optic disc diameters)")
    print("=" * 74)
    for lm, label in (("od", "OPTIC DISC"), ("fovea", "FOVEA")):
        bad = [r for r in rows if r[lm]["err"] / r["radius"] > GROSS_MULT]
        e = np.array([r[lm]["err"] for r in rows])
        share = 100.0 * len(bad) / len(rows)
        print(f"\n  {label}: {len(bad)}/{len(rows)} ({share:.1f}%) gross misses")
        if bad:
            # How much of the reported mean is these few images? If removing
            # them collapses the mean, the mean was describing them, not the
            # model's typical behaviour.
            keep = np.array([r[lm]["err"] for r in rows
                             if r[lm]["err"] / r["radius"] <= GROSS_MULT])
            print(f"    mean WITH them {e.mean():8.2f} px   "
                  f"mean WITHOUT {keep.mean():8.2f} px   "
                  f"({100.0 * (1 - keep.mean() / e.mean()):.0f}% of the mean "
                  f"comes from {share:.1f}% of images)")
            print(f"    {'id':<12s}{'split':<7s}{'err px':>10s}{'R':>7s}"
                  f"{'peak':>8s}{'margin':>8s}{'pred DD sep':>13s}")
            for r in sorted(bad, key=lambda r: -r[lm]["err"]):
                print(f"    {r['id']:<12s}{r['split']:<7s}"
                      f"{r[lm]['err']:>10.1f}{r[lm]['err'] / r['radius']:>7.2f}"
                      f"{r[lm]['peak']:>8.3f}{r[lm]['margin']:>8.3f}"
                      f"{r['dd_sep']:>13.2f}")
            out.setdefault("gross", {})[lm] = [
                {"id": r["id"], "split": r["split"], "err": r[lm]["err"],
                 "R": r[lm]["err"] / r["radius"], "peak": r[lm]["peak"],
                 "margin": r[lm]["margin"], "dd_sep": r["dd_sep"]}
                for r in sorted(bad, key=lambda r: -r[lm]["err"])]

    # ---- is it detectable? ----
    print(f"\n{'=' * 74}")
    print("IS THE FAILURE DETECTABLE AT INFERENCE TIME?")
    print("=" * 74)
    print("Higher AUC = better separation of gross misses from good ones.")
    print("0.5 = useless. The false-alarm column is the price of catching")
    print("every gross miss, which is what a safety gate has to do.\n")
    for lm, label in (("od", "OPTIC DISC"), ("fovea", "FOVEA")):
        is_bad = np.array([r[lm]["err"] / r["radius"] > GROSS_MULT
                           for r in rows])
        print(f"  {label}  ({int(is_bad.sum())} gross of {len(rows)})")
        d = {}
        d["peak"] = detector_report(
            "heatmap peak", [r[lm]["peak"] for r in rows], is_bad)
        d["margin"] = detector_report(
            "peak - mean (margin)", [r[lm]["margin"] for r in rows], is_bad)
        # Geometry is scored on DEVIATION from the anatomical norm, so both
        # an implausibly small and an implausibly large separation count as
        # suspicious. Higher deviation = more suspicious.
        med_dd = float(np.median([r["dd_sep_true"] for r in rows]))
        dev = [abs(r["dd_sep"] - med_dd) for r in rows]
        d["geometry"] = detector_report(
            f"|DD sep - {med_dd:.2f}| (anatomy)", dev, is_bad,
            lower_is_bad=False)
        out.setdefault("detectors", {})[lm] = d
        print()

    dd_true = np.array([r["dd_sep_true"] for r in rows])
    dd_pred = np.array([r["dd_sep"] for r in rows])
    print(f"  disc-fovea separation, TRUE      : median {np.median(dd_true):.2f} DD "
          f"(5th-95th {np.percentile(dd_true, 5):.2f}-"
          f"{np.percentile(dd_true, 95):.2f})")
    print(f"  disc-fovea separation, PREDICTED : median {np.median(dd_pred):.2f} DD "
          f"(5th-95th {np.percentile(dd_pred, 5):.2f}-"
          f"{np.percentile(dd_pred, 95):.2f})")
    out["dd_true_median"] = float(np.median(dd_true))
    out["dd_pred_median"] = float(np.median(dd_pred))
    out["dd_true_p5_p95"] = [float(np.percentile(dd_true, 5)),
                             float(np.percentile(dd_true, 95))]

    # Where do the hallucinated foveas land? If they cluster at the frame
    # edge, the model is not confusing the fovea with another structure --
    # it is producing a heatmap with no real peak and argmax is picking noise.
    bad_f = [r for r in rows
             if r["fovea"]["err"] / r["radius"] > GROSS_MULT]
    if bad_f:
        print(f"\n  where the {len(bad_f)} hallucinated foveas landed "
              f"(512-space, frame is 0-511):")
        for r in bad_f:
            x, y = r["fovea"]["xy512"]
            edge = min(x, y, 511 - x, 511 - y)
            print(f"    {r['id']:<12s} at ({x:3d},{y:3d})  "
                  f"{edge:3d} px from the nearest frame edge"
                  f"{'   <- ON THE EDGE' if edge <= 8 else ''}")

    # The concrete number the ML team needs: what does a given fovea-peak
    # cut-off actually buy and cost. Printed as a table rather than a single
    # recommendation because the right operating point depends on whether a
    # flagged image is rejected outright or merely routed for review.
    print(f"\n{'=' * 74}")
    print("FOVEA PEAK THRESHOLD -- operating points")
    print("=" * 74)
    peaks = np.array([r["fovea"]["peak"] for r in rows])
    is_bad = np.array([r["fovea"]["err"] / r["radius"] > GROSS_MULT
                       for r in rows])
    errs = np.array([r["fovea"]["err"] / r["radius"] for r in rows])
    print(f"  fovea peak: gross misses "
          f"{peaks[is_bad].min():.3f}-{peaks[is_bad].max():.3f}, "
          f"good {peaks[~is_bad].min():.3f}-{peaks[~is_bad].max():.3f} "
          f"(good 5th pct {np.percentile(peaks[~is_bad], 5):.3f})")
    print(f"\n  {'threshold':>10s}{'flagged':>9s}{'gross caught':>14s}"
          f"{'gross missed':>14s}{'false alarms':>14s}{'mean err of kept':>18s}")
    for t in (0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50):
        flag = peaks < t
        caught = int((flag & is_bad).sum())
        missed = int((~flag & is_bad).sum())
        fa = int((flag & ~is_bad).sum())
        kept = errs[~flag]
        print(f"  {t:>10.2f}{int(flag.sum()):>9d}{caught:>8d}/{int(is_bad.sum())}"
              f"{missed:>14d}{fa:>14d}"
              f"{(kept.mean() if kept.size else float('nan')):>17.3f}R")
    out["peak_threshold_table"] = {
        str(t): {"flagged": int((peaks < t).sum()),
                 "caught": int(((peaks < t) & is_bad).sum()),
                 "false_alarms": int(((peaks < t) & ~is_bad).sum())}
        for t in (0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50)}

    if args.json:
        os.makedirs(os.path.dirname(args.json) or ".", exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(out, fh, indent=2, default=float)
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
