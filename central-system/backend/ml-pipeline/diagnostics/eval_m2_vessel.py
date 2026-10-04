

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ML_ROOT, "inference"))
sys.path.insert(0, ML_ROOT)

import segInfer  # noqa: E402

CHASE = os.path.join(ML_ROOT, "datasets", "chasedb1")
DRIVE = os.path.abspath(os.path.join(ML_ROOT, "..", "..", "..",
                                     "datasets", "DRIVE"))
DRIVE_SIZE = (565, 584)          # (w, h), what CHASE is downscaled to


def read_gray(path):
    from PIL import Image
    return np.array(Image.open(path).convert("L"))


def predict_prob(model, bgr, resize_to=None, green_match=None, fov=None):

    import cv2
    import torch

    h0, w0 = bgr.shape[:2]
    work = bgr if resize_to is None else cv2.resize(
        bgr, resize_to, interpolation=cv2.INTER_AREA)

    green = work[:, :, 1]
    if green_match is not None:
        # Shift and scale the green channel to the target mean/sd, measured
        # inside the FOV so the black surround does not drag the statistics.
        # Applied to the whole frame to keep the padding logic unchanged.
        tgt_mean, tgt_std = green_match
        m = fov if (fov is not None and fov.shape == green.shape) else None
        vals = green[m] if m is not None else green
        cur_mean, cur_std = float(vals.mean()), float(vals.std())
        if cur_std > 1e-6:
            adj = (green.astype(np.float32) - cur_mean) * (tgt_std / cur_std) \
                + tgt_mean
            green = np.clip(adj, 0, 255).astype(np.uint8)

    padded, (ox, oy, nw, nh) = segInfer._aspect_pad(green)
    x = ((padded.astype(np.float32) / 255.0) - 0.5) / 0.5
    with torch.no_grad():
        logits = model(torch.from_numpy(x[None, None, ...]))[0, 0].numpy()
    prob = 1.0 / (1.0 + np.exp(-logits))
    inner = prob[oy:oy + nh, ox:ox + nw]
    return cv2.resize(inner, (w0, h0), interpolation=cv2.INTER_LINEAR)


def counts(pred, gt, sel):
    p, g = pred[sel], gt[sel]
    return (int((p & g).sum()), int((p & ~g).sum()),
            int((~p & ~g).sum()), int((~p & g).sum()))


def rates(tp, fp, tn, fn):
    d = lambda a, b: float(a) / float(b) if b else float("nan")  # noqa: E731
    return {"sensitivity": d(tp, tp + fn), "specificity": d(tn, tn + fp),
            "precision": d(tp, tp + fp), "dice": d(2 * tp, 2 * tp + fp + fn),
            "iou": d(tp, tp + fp + fn),
            "accuracy": d(tp + tn, tp + fp + tn + fn)}


def calibre_recall(prob, gt, fov, thresh=0.5, bins=(1, 2, 3, 4, 6, 99)):
    
    import cv2
    dt = cv2.distanceTransform(gt.astype(np.uint8), cv2.DIST_L2, 3)
    pred = prob > thresh
    out = []
    lo = 0.0
    for hi in bins:
        sel = gt & fov & (dt > lo) & (dt <= hi)
        n = int(sel.sum())
        rec = float(pred[sel].mean()) if n else float("nan")
        out.append((lo, hi, n, rec))
        lo = hi
    return out


def eval_set(model, cases, label, resize_to=None, thresh=0.5,
             sweep=None, calibre=False, green_match=None, exclude_thin=False):
    """cases = [(name, image_path, gt_path, fov_path or None)]."""
    agg = np.zeros(4, np.int64)
    per_image, cal_acc, sweep_acc = [], [], {}
    if sweep is not None:
        sweep_acc = {round(t, 2): np.zeros(4, np.int64) for t in sweep}

    import cv2
    for name, img_path, gt_path, fov_path in cases:
        bgr = cv2.imread(img_path, cv2.IMREAD_COLOR)
        if bgr is None:
            continue
        gt = read_gray(gt_path) > 127
        fov = (read_gray(fov_path) > 127) if fov_path else np.ones_like(gt)

        prob = predict_prob(model, bgr, resize_to=resize_to,
                            green_match=green_match, fov=fov)
        pred = prob > thresh

        scope = fov
        if exclude_thin:
            # Don't-care: drop the thinnest GT from the scored region
            # entirely, so those pixels count neither as misses nor as false
            # positives. Scoring them as background instead would punish the
            # model for predictions the stricter annotator would have accepted.
            dt = cv2.distanceTransform(gt.astype(np.uint8), cv2.DIST_L2, 3)
            scope = fov & ~(gt & (dt <= 1))

        c = counts(pred, gt, scope)
        agg += np.array(c, np.int64)
        per_image.append((name, rates(*c)))

        if sweep is not None:
            for t in sweep:
                sweep_acc[round(t, 2)] += np.array(
                    counts(prob > t, gt, fov), np.int64)
        if calibre:
            cal_acc.append(calibre_recall(prob, gt, fov, thresh))

    m = rates(*[int(v) for v in agg])
    dices = [r["dice"] for _n, r in per_image]
    print(f"\n{'-' * 70}")
    print(f"{label}   (n={len(per_image)}"
          f"{', input downscaled to %dx%d' % resize_to if resize_to else ''})")
    print(f"{'-' * 70}")
    tp, fp, tn, fn = (int(v) for v in agg)
    print(f"  TP {tp:>10,}  FP {fp:>9,}  TN {tn:>12,}  FN {fn:>10,}")
    print(f"  Sensitivity {m['sensitivity']:.4f}   Specificity "
          f"{m['specificity']:.4f}   Precision {m['precision']:.4f}")
    print(f"  Dice {m['dice']:.4f}   IoU {m['iou']:.4f}   "
          f"Accuracy {m['accuracy']:.4f}")
    if dices:
        print(f"  per-image Dice {np.mean(dices):.4f} +/- {np.std(dices):.4f} "
              f"(min {np.min(dices):.4f}, max {np.max(dices):.4f})")

    result = {"label": label, "n": len(per_image), "aggregate": m,
              "per_image_dice_mean": float(np.mean(dices)) if dices else None,
              "resize_to": resize_to}

    if sweep is not None:
        print(f"\n  threshold sweep (aggregate Dice):")
        best_t, best_d = None, -1.0
        rows = []
        for t in sorted(sweep_acc):
            r = rates(*[int(v) for v in sweep_acc[t]])
            rows.append((t, r))
            if r["dice"] > best_d:
                best_t, best_d = t, r["dice"]
        for t, r in rows:
            star = "  <- best" if t == best_t else ""
            mark = "  (shipped)" if abs(t - 0.5) < 1e-9 else ""
            print(f"    thr {t:.2f}  Se {r['sensitivity']:.4f}  "
                  f"Sp {r['specificity']:.4f}  Dice {r['dice']:.4f}"
                  f"{star}{mark}")
        result["sweep"] = {str(t): r for t, r in rows}
        result["best_threshold"] = best_t
        result["best_dice"] = best_d

    if calibre and cal_acc:
        print(f"\n  recall by vessel half-width (GT distance transform, px):")
        nb = len(cal_acc[0])
        for i in range(nb):
            lo, hi, _n, _r = cal_acc[0][i]
            tot = sum(c[i][2] for c in cal_acc)
            hits = sum(c[i][2] * c[i][3] for c in cal_acc
                       if not np.isnan(c[i][3]))
            rec = hits / tot if tot else float("nan")
            span = f"{lo:.0f}-{hi:.0f}" if hi < 90 else f">{lo:.0f}"
            print(f"    half-width {span:>6s} px : recall {rec:.4f}  "
                  f"({tot:,} GT px)")
            result.setdefault("calibre", []).append(
                {"lo": lo, "hi": hi, "gt_px": tot, "recall": rec})

    return result


def chase_cases():
    out = []
    for f in sorted(os.listdir(CHASE)):
        if not f.endswith(".jpg"):
            continue
        gt = os.path.join(CHASE, f.replace(".jpg", "_1stHO.png"))
        if os.path.exists(gt):
            out.append((f, os.path.join(CHASE, f), gt, None))
    return out


def drive_cases(split="training"):
    img_dir = os.path.join(DRIVE, split, "images")
    gt_dir = os.path.join(DRIVE, split, "1st_manual")
    fov_dir = os.path.join(DRIVE, split, "mask")
    if not os.path.isdir(gt_dir):
        return []
    out = []
    for f in sorted(os.listdir(img_dir)):
        num = f.split("_")[0]
        gts = [x for x in os.listdir(gt_dir) if x.startswith(num + "_")]
        fovs = ([x for x in os.listdir(fov_dir) if x.startswith(num + "_")]
                if os.path.isdir(fov_dir) else [])
        if gts:
            out.append((f, os.path.join(img_dir, f),
                        os.path.join(gt_dir, gts[0]),
                        os.path.join(fov_dir, fovs[0]) if fovs else None))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default=None)
    ap.add_argument("--skip-sweep", action="store_true")
    args = ap.parse_args()

    model, ckpt = segInfer.load("vessel")
    print("M2 VESSEL SEGMENTATION -- PyTorch checkpoint")
    print(f"  arch {segInfer._ARCH['vessel']}")
    print(f"  checkpoint best_val_dice (CHASE): {ckpt.get('best_val_dice')}")
    print(f"  preprocessing: {ckpt.get('preprocessing')}")

    sweep = None if args.skip_sweep else [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
    res = {}

    ch, dr = chase_cases(), drive_cases()
    print(f"\nCHASE_DB1: {len(ch)} images with GT (in-domain, 999x960)")
    print(f"DRIVE    : {len(dr)} images with GT (out-of-domain, 565x584)")

    print(f"\n{'=' * 70}")
    print("1. IN-DOMAIN vs OUT-OF-DOMAIN")
    print("=" * 70)
    res["chase"] = eval_set(model, ch, "CHASE_DB1 (training domain)",
                            sweep=sweep, calibre=True)
    res["drive"] = eval_set(model, dr, "DRIVE (unseen domain), inside FOV",
                            sweep=sweep, calibre=True)

    print(f"\n{'=' * 70}")
    print("2. CONTROLLED EXPERIMENT -- is the gap explained by SCALE ALONE?")
    print("=" * 70)
    print("Same CHASE images, same expert tracings, downscaled to DRIVE's")
    print("pixel dimensions before preprocessing. Only scale changes.")
    res["chase_downscaled"] = eval_set(
        model, ch, "CHASE_DB1 downscaled to DRIVE size",
        resize_to=DRIVE_SIZE, calibre=True)

    # The symmetric half of the experiment. Downscaling CHASE tests one
    # direction;;this tests the other, and the two together are what make the
    # conclusion safe. The naive reading of "DRIVE is smaller" is that DRIVE
    # vessels reach the model too thin -- but the aspect-pad scales 565->512
    # (x0.88) and 999->512 (x0.51), so a DRIVE vessel arrives WIDER in the
    # model's frame than a CHASE one, not thinner. If effective calibre were
    # the cause, matching DRIVE's scale to CHASE's should recover the Dice.
    print(f"\n{'=' * 70}")
    print("3. THE SYMMETRIC TEST -- does matching DRIVE to CHASE's scale help?")
    print("=" * 70)
    CHASE_SIZE = (999, 960)
    res["drive_upscaled"] = eval_set(
        model, dr, "DRIVE upscaled to CHASE size, inside FOV",
        resize_to=CHASE_SIZE, calibre=True)

    # Domain characterisation. If scale is not the cause, what differs? These
    # are the two candidates a vessel model is sensitive to: how much of the
    # retina the annotator called vessel, and the green channel's contrast.
    print(f"\n{'=' * 70}")
    print("4. DOMAIN CHARACTERISATION")
    print("=" * 70)
    import cv2
    for nm, cases in (("CHASE_DB1", ch), ("DRIVE", dr)):
        fracs, stds, means, thin = [], [], [], []
        for name, img_path, gt_path, fov_path in cases:
            bgr = cv2.imread(img_path, cv2.IMREAD_COLOR)
            gt = read_gray(gt_path) > 127
            fov = (read_gray(fov_path) > 127) if fov_path else np.ones_like(gt)
            g = bgr[:, :, 1]
            fracs.append(float(gt[fov].mean()))
            means.append(float(g[fov].mean()))
            stds.append(float(g[fov].std()))
            dt = cv2.distanceTransform(gt.astype(np.uint8), cv2.DIST_L2, 3)
            v = dt[gt & fov]
            thin.append(float((v <= 1).mean()) if v.size else float("nan"))
        print(f"  {nm:10s} vessel pixels {100 * np.mean(fracs):5.2f}% of FOV | "
              f"green mean {np.mean(means):6.2f} sd {np.mean(stds):5.2f} | "
              f"GT that is <=1px half-width {100 * np.mean(thin):5.1f}%")
        res.setdefault("domains", {})[nm] = {
            "vessel_frac": float(np.mean(fracs)),
            "green_mean": float(np.mean(means)),
            "green_std": float(np.mean(stds)),
            "thin_gt_share": float(np.mean(thin))}

    # Scale is out. The characterisation leaves two candidates, and both are
    # testable rather than merely plausible.
    print(f"\n{'=' * 70}")
    print("5. INTENSITY HYPOTHESIS -- is the gap the input distribution?")
    print("=" * 70)
    print("M2 normalises with a FIXED (x/255-0.5)/0.5 and no per-image")
    print("standardisation, so CHASE's green channel (mean ~42, sd ~36) and")
    print("DRIVE's (mean ~97, sd ~20) reach the model as different")
    print("distributions. Here DRIVE's green channel is standardised to")
    print("CHASE's within-FOV statistics before the chain; nothing else moves.")
    ch_stats = res["domains"]["CHASE_DB1"]
    res["drive_intensity_matched"] = eval_set(
        model, dr, "DRIVE, green channel matched to CHASE intensity",
        calibre=True,
        green_match=(ch_stats["green_mean"], ch_stats["green_std"]))

    # The other candidate is the annotators, not the model. DRIVE calls 12.5%
    # of the FOV vessel against CHASE's 6.9%, and half of DRIVE's vessel
    # pixels are <=1px half-width against CHASE's 29.5%. A model trained to
    # one convention is being graded against a stricter one, so the thinnest
    # GT is scored as don't-care here: those pixels are removed from both the
    # prediction and the truth rather than counted as misses.
    print(f"\n{'=' * 70}")
    print("6. ANNOTATION-CONVENTION HYPOTHESIS")
    print("=" * 70)
    print("DRIVE's thinnest GT (half-width <=1px) treated as don't-care,")
    print("approximating CHASE's sparser annotation convention.")
    res["drive_thick_only"] = eval_set(
        model, dr, "DRIVE, GT half-width <=1px excluded (don't-care)",
        exclude_thin=True)

    d_full = res["chase"]["aggregate"]["dice"]
    d_down = res["chase_downscaled"]["aggregate"]["dice"]
    d_drive = res["drive"]["aggregate"]["dice"]
    s_full = res["chase"]["aggregate"]["sensitivity"]
    s_down = res["chase_downscaled"]["aggregate"]["sensitivity"]
    s_drive = res["drive"]["aggregate"]["sensitivity"]

    print(f"\n{'=' * 70}")
    print("VERDICT")
    print("=" * 70)
    d_up = res["drive_upscaled"]["aggregate"]["dice"]
    s_up = res["drive_upscaled"]["aggregate"]["sensitivity"]
    print(f"  CHASE at native scale        Dice {d_full:.4f}  Se {s_full:.4f}")
    print(f"  CHASE downscaled to DRIVE    Dice {d_down:.4f}  Se {s_down:.4f}")
    print(f"  DRIVE at native scale        Dice {d_drive:.4f}  Se {s_drive:.4f}")
    print(f"  DRIVE upscaled to CHASE      Dice {d_up:.4f}  Se {s_up:.4f}")
    drop_total = d_full - d_drive
    drop_scale = d_full - d_down
    if drop_total > 1e-9:
        share = 100.0 * drop_scale / drop_total
        print(f"\n  total Dice drop CHASE->DRIVE      : {drop_total:.4f}")
        print(f"  drop from DOWNSCALING ALONE       : {drop_scale:.4f} "
              f"({share:.1f}% of the total)")
        print(f"  residual attributable to anything else: "
              f"{drop_total - drop_scale:.4f}")
        res["attribution"] = {"total_drop": drop_total,
                              "scale_drop": drop_scale,
                              "scale_share_pct": share}

    if args.json:
        os.makedirs(os.path.dirname(args.json) or ".", exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(res, fh, indent=2, default=float)
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
