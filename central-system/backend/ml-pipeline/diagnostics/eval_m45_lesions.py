

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

SEG = os.path.join(ML_ROOT, "datasets", "idrid", "segmentation",
                   "A. Segmentation")
IMG_DIRS = {"train": "a. Training Set", "test": "b. Testing Set"}
GT_SUB = {"MA": "1. Microaneurysms", "HE": "2. Haemorrhages",
          "EX": "3. Hard Exudates", "SE": "4. Soft Exudates",
          "OD": "5. Optic Disc"}
SIZE = segInfer.INPUT_SIZE

M5_METRICS = os.path.join(ML_ROOT, "models", "red_lesion_predictions(model5)",
                          "red_lesion_metrics.json")


def find_image(img_id):
    for split, sub in IMG_DIRS.items():
        p = os.path.join(SEG, "1. Original Images", sub, img_id + ".jpg")
        if os.path.exists(p):
            return split, p
    return None, None


def load_gt_mask(img_id, split, kind, shape):
 
    from PIL import Image
    folder = os.path.join(SEG, "2. All Segmentation Groundtruths",
                          IMG_DIRS[split], GT_SUB[kind])
    if not os.path.isdir(folder):
        return np.zeros(shape, bool)
    for f in os.listdir(folder):
        if f.startswith(img_id + "_"):
            m = np.array(Image.open(os.path.join(folder, f)).convert("L"))
            return m > 0
    return np.zeros(shape, bool)


def to_512(mask_orig, box):
  
    import cv2
    x0, y0, bw, bh = box
    crop = mask_orig[y0:y0 + bh, x0:x0 + bw]
    return cv2.resize(crop.astype(np.uint8), (SIZE, SIZE),
                      interpolation=cv2.INTER_NEAREST).astype(bool)


def rates(tp, fp, tn, fn):
    d = lambda a, b: float(a) / float(b) if b else float("nan")  # noqa: E731
    return {"sensitivity": d(tp, tp + fn), "specificity": d(tn, tn + fp),
            "precision": d(tp, tp + fp), "dice": d(2 * tp, 2 * tp + fp + fn),
            "iou": d(tp, tp + fp + fn)}


def dice_of(pred, gt):
    tp = int((pred & gt).sum())
    return (2.0 * tp / (2 * tp + int((pred & ~gt).sum()) +
                        int((~pred & gt).sum()))
            if (pred.any() or gt.any()) else float("nan"))


def component_recall(pred, gt, area_bins=((0, 10), (10, 25), (25, 100),
                                          (100, 500), (500, 10 ** 9))):
    """Per-LESION detection rate by lesion area, in 512-space pixels.

    A component counts as detected if the prediction overlaps it at all. That
    is a deliberately generous rule: for a counting pipeline, finding a lesion
    at all is what matters, and requiring 50% overlap would conflate detection
    failure with boundary imprecision. It also makes a miss unambiguous --
    zero predicted pixels anywhere on the lesion.
    """
    import cv2
    n, labels, stats, _cent = cv2.connectedComponentsWithStats(
        gt.astype(np.uint8), connectivity=8)
    out = {b: [0, 0] for b in area_bins}       # [detected, total]
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        hit = bool((pred & (labels == i)).any())
        for lo, hi in area_bins:
            if lo <= area < hi:
                out[(lo, hi)][1] += 1
                out[(lo, hi)][0] += int(hit)
                break
    return out


def predict(model, rgb512):
    """CROP-512 probability. (x/255-0.5)/0.5, NOT ImageNet -- see docstring."""
    import torch
    x = ((rgb512.astype(np.float32) / 255.0) - 0.5) / 0.5
    with torch.no_grad():
        logits = model(torch.from_numpy(
            x.transpose(2, 0, 1)[None, ...]))[0, 0].numpy()
    return 1.0 / (1.0 + np.exp(-logits))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--thresh", type=float, default=0.5)
    args = ap.parse_args()

    import cv2
    from preprocessing.ben_graham import retinal_crop_box

    with open(M5_METRICS, encoding="utf-8") as fh:
        m5meta = json.load(fh)
    m5_val = set(m5meta["val_ids"])
    m5_per_image = m5meta.get("per_image_val_dice_at_best", {})

    # M4 never saw the Testing folder; M5's split is recorded explicitly.
    m4_held = {f"IDRiD_{i:02d}" for i in range(55, 82)}

    all_ids = sorted({os.path.splitext(f)[0]
                      for sub in IMG_DIRS.values()
                      for f in os.listdir(os.path.join(
                          SEG, "1. Original Images", sub))
                      if f.lower().endswith(".jpg")})
    if args.limit:
        all_ids = all_ids[:args.limit]

    print("M4 / M5 LESION SEGMENTATION -- PyTorch checkpoints")
    m4, ck4 = segInfer.load("bright_lesion")
    m5, ck5 = segInfer.load("red_lesion")
    print(f"  M4 best_val_dice {ck4.get('best_val_dice'):.4f} "
          f"(global {ck4.get('global_val_dice'):.4f}), "
          f"od_masking={ck4.get('od_masking')} r={ck4.get('od_mask_radius')}")
    print(f"  M5 best_val_dice {ck5.get('best_val_dice'):.4f}, "
          f"target = {ck5.get('preprocessing', '').split('red_lesion = ')[-1]}")
    print(f"\n  images: {len(all_ids)}")
    print(f"  M4 held-out (Testing folder, never trained on): {len(m4_held)}")
    print(f"  M5 held-out (recorded val_ids): {len(m5_val)}")

    rows = []
    for img_id in all_ids:
        split, path = find_image(img_id)
        if path is None:
            continue
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        if bgr is None:
            continue
        box = retinal_crop_box(bgr)
        from preprocessing.ben_graham import ben_graham_preprocess
        rgb512 = cv2.cvtColor(ben_graham_preprocess(bgr, target_size=SIZE),
                              cv2.COLOR_BGR2RGB)

        shape = bgr.shape[:2]
        gt = {k: to_512(load_gt_mask(img_id, split, k, shape), box)
              for k in ("MA", "HE", "EX", "SE", "OD")}

        p4 = predict(m4, rgb512)
        p5 = predict(m5, rgb512)
        rows.append({"id": img_id, "split": split, "gt": gt,
                     "p4": p4, "p5": p5})
        print(f"\r  scored {len(rows)}/{len(all_ids)}", end="", flush=True)
    print()

    out = {}
    T = args.thresh

    # ---- M4: what is its target? ----
    print(f"\n{'=' * 74}")
    print("M4 TARGET IDENTIFICATION -- which ground truth does it match?")
    print("=" * 74)
    held4 = [r for r in rows if r["id"] in m4_held]
    if not held4:
        # Only happens under --limit, which can select a subset containing
        # none of the Testing folder. Identifying the target on whatever is
        # available is still valid -- which GT the model matches is a property
        # of the model, not of the split -- but it is said out loud.
        print("  (no held-out images in this subset; identifying the target "
              "on all scored images instead)")
        held4 = rows
    cands = {"EX (hard exudates)": lambda g: g["EX"],
             "SE (soft exudates)": lambda g: g["SE"],
             "EX or SE (union)": lambda g: g["EX"] | g["SE"]}
    best_name, best_d = None, -1.0
    for name, fn in cands.items():
        agg = np.zeros(4, np.int64)
        for r in held4:
            gtm, pred = fn(r["gt"]), r["p4"] > T
            agg += np.array([int((pred & gtm).sum()), int((pred & ~gtm).sum()),
                             int((~pred & ~gtm).sum()),
                             int((~pred & gtm).sum())], np.int64)
        m = rates(*[int(v) for v in agg])
        print(f"  {name:<22s} Dice {m['dice']:.4f}  Se {m['sensitivity']:.4f}  "
              f"Prec {m['precision']:.4f}")
        # nan > x is False, so a candidate whose GT is empty everywhere can
        # never win by accident -- it simply never becomes the best.
        if not np.isnan(m["dice"]) and m["dice"] > best_d:
            best_name, best_d = name, m["dice"]
    if best_name is None:
        raise SystemExit("could not identify M4's target: every candidate "
                         "ground truth was empty on the scored images")
    print(f"\n  -> M4's target is {best_name} (highest agreement, "
          f"Dice {best_d:.4f}).")
    m4_target = {"EX (hard exudates)": lambda g: g["EX"],
                 "SE (soft exudates)": lambda g: g["SE"],
                 "EX or SE (union)": lambda g: g["EX"] | g["SE"]}[best_name]
    out["m4_target"] = best_name

    # ---- M4 / M5 headline metrics ----
    for tag, model_key, target_fn, held, label in (
            ("m4", "p4", m4_target, m4_held,
             f"M4 BRIGHT LESION vs {best_name}"),
            ("m5", "p5", lambda g: g["MA"] | g["HE"], m5_val,
             "M5 RED LESION vs MA or HE")):
        for scope, sel in (("HELD OUT", lambda r: r["id"] in held),
                           ("ALL (contaminated)", lambda r: True)):
            sub = [r for r in rows if sel(r)]
            if not sub:
                continue
            agg = np.zeros(4, np.int64)
            per = []
            for r in sub:
                gtm, pred = target_fn(r["gt"]), r[model_key] > T
                agg += np.array([int((pred & gtm).sum()),
                                 int((pred & ~gtm).sum()),
                                 int((~pred & ~gtm).sum()),
                                 int((~pred & gtm).sum())], np.int64)
                per.append((r["id"], dice_of(pred, gtm)))
            m = rates(*[int(v) for v in agg])
            print(f"\n{'=' * 74}")
            print(f"{label}  --  {scope}  (n={len(sub)})")
            if scope.startswith("ALL"):
                print("*** includes training images; not an accuracy figure ***")
            print("=" * 74)
            tp, fp, tn, fn = (int(v) for v in agg)
            print(f"  TP {tp:>9,}  FP {fp:>9,}  TN {tn:>11,}  FN {fn:>9,}")
            print(f"  Sensitivity {m['sensitivity']:.4f}   Specificity "
                  f"{m['specificity']:.4f}   Precision {m['precision']:.4f}")
            print(f"  Dice (pooled) {m['dice']:.4f}   IoU {m['iou']:.4f}")
            ds = [d for _i, d in per if not np.isnan(d)]
            if ds:
                print(f"  per-image Dice {np.mean(ds):.4f} +/- {np.std(ds):.4f}")
            if scope == "HELD OUT":
                out[f"{tag}_heldout"] = {"n": len(sub), **m,
                                         "per_image_dice": float(np.mean(ds))
                                         if ds else None}
                print(f"\n  worst 5 images by Dice:")
                for i, d in sorted(per, key=lambda x: (np.isnan(x[1]), x[1]))[:5]:
                    print(f"    {i:<12s} Dice {d:.4f}")
                out[f"{tag}_worst"] = [
                    {"id": i, "dice": d} for i, d in
                    sorted(per, key=lambda x: (np.isnan(x[1]), x[1]))[:5]]

    # ---- FLAW 1: does M4 fire on the optic disc? ----
    print(f"\n{'=' * 74}")
    print("FLAW TEST 1 -- does M4 mistake the OPTIC DISC for a bright lesion?")
    print("=" * 74)
    fp_in_od, fp_total, od_px, od_fired = 0, 0, 0, 0
    per_img = []
    for r in [x for x in rows if x["id"] in m4_held]:
        gtm, pred = m4_target(r["gt"]), r["p4"] > T
        od = r["gt"]["OD"]
        fp = pred & ~gtm
        fp_in_od += int((fp & od).sum())
        fp_total += int(fp.sum())
        od_px += int(od.sum())
        od_fired += int((pred & od).sum())
        if od.any():
            per_img.append((r["id"], float((pred & od).sum()) / int(od.sum()),
                            int((fp & od).sum())))
    print(f"  false-positive pixels inside the annotated disc: "
          f"{fp_in_od:,} of {fp_total:,} ({100.0 * fp_in_od / fp_total:.1f}% "
          f"of ALL M4 false positives)")
    print(f"  the disc is {100.0 * od_px / (len(per_img) * SIZE * SIZE):.2f}% "
          f"of the frame, so this is "
          f"{(fp_in_od / fp_total) / (od_px / (len(per_img) * SIZE * SIZE)):.1f}x "
          f"the rate expected if false positives were uniform")
    print(f"  mean share of each disc that M4 marks as lesion: "
          f"{100.0 * np.mean([p for _i, p, _f in per_img]):.1f}%")
    print(f"\n  worst offenders (fraction of the disc predicted as lesion):")
    for i, frac, nfp in sorted(per_img, key=lambda x: -x[1])[:6]:
        print(f"    {i:<12s} {100 * frac:5.1f}% of disc  ({nfp:,} FP px)")

    # What the existing radius-58 mask is worth, and whether 58 is right.
    print(f"\n  effect of masking the disc (segInfer applies r=58 at 512):")
    for radius in (0, 40, 58, 80, "annotated"):
        agg = np.zeros(4, np.int64)
        for r in [x for x in rows if x["id"] in m4_held]:
            gtm, pred = m4_target(r["gt"]), r["p4"] > T
            od = r["gt"]["OD"]
            if radius == "annotated":
                keep = ~od
            elif radius:
                ys, xs = np.nonzero(od)
                keep = np.ones_like(pred)
                if len(xs):
                    cx, cy = xs.mean(), ys.mean()
                    yy, xx = np.ogrid[:SIZE, :SIZE]
                    keep = ((xx - cx) ** 2 + (yy - cy) ** 2) > radius ** 2
            else:
                keep = np.ones_like(pred)
            p = pred & keep
            agg += np.array([int((p & gtm).sum()), int((p & ~gtm).sum()),
                             int((~p & ~gtm).sum()), int((~p & gtm).sum())],
                            np.int64)
        m = rates(*[int(v) for v in agg])
        tag = ("none" if radius == 0 else
               f"r={radius}" if radius != "annotated" else "annotated disc")
        star = "  <- shipped" if radius == 58 else ""
        print(f"    mask {tag:<16s} Dice {m['dice']:.4f}  "
              f"Se {m['sensitivity']:.4f}  Prec {m['precision']:.4f}{star}")
        out.setdefault("m4_od_mask", {})[str(radius)] = m

    # ---- FLAW 2: does M5 miss small microaneurysms? ----
    print(f"\n{'=' * 74}")
    print("FLAW TEST 2 -- does M5 miss microaneurysms, and is it a SIZE issue?")
    print("=" * 74)
    held5 = [r for r in rows if r["id"] in m5_val]
    for kind, label in (("MA", "MICROANEURYSMS"), ("HE", "HAEMORRHAGES")):
        agg = np.zeros(4, np.int64)
        comp = {}
        for r in held5:
            gtm, pred = r["gt"][kind], r["p5"] > T
            agg += np.array([int((pred & gtm).sum()), int((pred & ~gtm).sum()),
                             int((~pred & ~gtm).sum()),
                             int((~pred & gtm).sum())], np.int64)
            for b, (d, t) in component_recall(pred, gtm).items():
                cur = comp.setdefault(b, [0, 0])
                cur[0] += d
                cur[1] += t
        m = rates(*[int(v) for v in agg])
        print(f"\n  {label} (M5 is trained on MA or HE jointly)")
        print(f"    pixel   Se {m['sensitivity']:.4f}  Dice {m['dice']:.4f}")
        print(f"    per-lesion detection rate by area (512-space px):")
        tot_d = tot_t = 0
        for (lo, hi), (d, t) in sorted(comp.items()):
            if t == 0:
                continue
            span = f"{lo}-{hi}" if hi < 10 ** 8 else f">{lo}"
            print(f"      area {span:>9s} px : {d:>5d}/{t:<5d} lesions "
                  f"= {100.0 * d / t:6.2f}%")
            tot_d += d
            tot_t += t
        if tot_t:
            print(f"      {'ALL':>14s} : {tot_d:>5d}/{tot_t:<5d} lesions "
                  f"= {100.0 * tot_d / tot_t:6.2f}%")
        out.setdefault("m5_lesion_recall", {})[kind] = {
            "pixel": m,
            "by_area": {f"{lo}-{hi}": {"detected": d, "total": t}
                        for (lo, hi), (d, t) in sorted(comp.items())},
            "overall_detect_pct": (100.0 * tot_d / tot_t) if tot_t else None}

    # Reproduction check against the per-image val Dice training recorded.
    if m5_per_image:
        print(f"\n  reproduction vs red_lesion_metrics.json "
              f"per_image_val_dice_at_best:")
        diffs = []
        for r in held5:
            rec = m5_per_image.get(r["id"])
            if rec is None:
                continue
            ours = dice_of(r["p5"] > T, r["gt"]["MA"] | r["gt"]["HE"])
            diffs.append(abs(ours - rec))
        if diffs:
            print(f"    {len(diffs)} images, mean |our Dice - recorded| "
                  f"{np.mean(diffs):.4f}, worst {np.max(diffs):.4f}")
            out["m5_reproduction_mean_abs_diff"] = float(np.mean(diffs))

    if args.json:
        os.makedirs(os.path.dirname(args.json) or ".", exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(out, fh, indent=2, default=float)
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
