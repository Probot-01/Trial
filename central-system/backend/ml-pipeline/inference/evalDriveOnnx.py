

import argparse
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ML_ROOT)

import segInfer  # noqa: E402  (path setup must precede it)
import modelPaths  # noqa: E402

INPUT_SIZE = segInfer.INPUT_SIZE


def onnx_path(role):
"
    return modelPaths.resolve_checkpoint(
        modelPaths.CHECKPOINTS[role].replace(".pt", ".onnx"))


def _read_gray(path):
    """Single-channel uint8 from .tif or .gif. cv2 cannot read DRIVE's gifs."""
    from PIL import Image
    return np.array(Image.open(path).convert("L"))


def _read_bgr(path):
    from PIL import Image
    rgb = np.array(Image.open(path).convert("RGB"))
    return rgb[:, :, ::-1].copy()          # PIL is RGB, segInfer expects BGR


def discover(drive_dir, split):
    """(image, vessel_gt or None, fov_mask or None) triples for a split."""
    img_dir = os.path.join(drive_dir, split, "images")
    if not os.path.isdir(img_dir):
        raise SystemExit(f"no images at {img_dir}")

    gt_dir = os.path.join(drive_dir, split, "1st_manual")
    fov_dir = os.path.join(drive_dir, split, "mask")
    have_gt, have_fov = os.path.isdir(gt_dir), os.path.isdir(fov_dir)

    out = []
    for fname in sorted(os.listdir(img_dir)):
        if not fname.lower().endswith((".tif", ".tiff", ".png", ".jpg")):
            continue
        # DRIVE names by a numeric stem: 21_training.tif -> 21_manual1.gif,
        # 21_training_mask.gif. Matched on the stem so this survives the
        # test/training naming difference without a per-split special case.
        num = fname.split("_")[0]
        gt = fov = None
        if have_gt:
            hits = [f for f in os.listdir(gt_dir) if f.startswith(num + "_")]
            gt = os.path.join(gt_dir, hits[0]) if hits else None
        if have_fov:
            hits = [f for f in os.listdir(fov_dir) if f.startswith(num + "_")]
            fov = os.path.join(fov_dir, hits[0]) if hits else None
        out.append((os.path.join(img_dir, fname), gt, fov))
    return out


def rates(tp, fp, tn, fn):
    """Sensitivity, specificity, precision, F1/Dice, accuracy, IoU."""
    d = lambda a, b: float(a) / float(b) if b else float("nan")  # noqa: E731
    sens = d(tp, tp + fn)
    prec = d(tp, tp + fp)
    return {
        "sensitivity": sens,
        "specificity": d(tn, tn + fp),
        "precision": prec,
        # 2TP/(2TP+FP+FN) -- identical to Dice on binary masks, computed in
        # that form so it is defined when both masks are empty rather than
        # dividing two zeros in the harmonic mean.
        "f1": d(2 * tp, 2 * tp + fp + fn),
        "iou": d(tp, tp + fp + fn),
        "accuracy": d(tp + tn, tp + fp + tn + fn),
    }


def eval_vessel(cases, thresh):
    import onnxruntime as ort
    import cv2

    sess = ort.InferenceSession(onnx_path("vessel"),
                                providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name

    # Four accumulators: original vs 512 space, FOV-restricted vs not.
    acc = {k: np.zeros(4, np.int64) for k in
           ("orig_fov", "orig_all", "s512_fov", "s512_all")}
    per_image, scored, skipped = [], 0, 0

    for img_path, gt_path, fov_path in cases:
        name = os.path.basename(img_path)
        if gt_path is None:
            skipped += 1
            continue

        bgr = _read_bgr(img_path)
        h, w = bgr.shape[:2]

        # segInfer.vessels(), exactly: green channel, aspect-pad to 512,
        # (x/255 - 0.5)/0.5. Via segInfer's own _aspect_pad, not a copy.
        padded, (ox, oy, nw, nh) = segInfer._aspect_pad(bgr[:, :, 1])
        x = ((padded.astype(np.float32) / 255.0) - 0.5) / 0.5
        logits = sess.run(None, {in_name: x[None, None, ...]})[0][0, 0]
        prob = 1.0 / (1.0 + np.exp(-logits))

        # Unpad BEFORE resizing back, as segInfer does: the pad is not part of
        # the image and resizing it in drags black bands into the retina.
        inner = prob[oy:oy + nh, ox:ox + nw]
        pred_orig = cv2.resize(inner, (w, h),
                               interpolation=cv2.INTER_LINEAR) > thresh

        gt_orig = _read_gray(gt_path) > 127
        fov_orig = (_read_gray(fov_path) > 127) if fov_path else np.ones_like(gt_orig)

        # 512-space view: ground truth carried INTO the model's frame through
        # the same aspect-pad, so pred and gt occupy identical geometry.
        gt_512, _ = segInfer._aspect_pad(gt_orig.astype(np.uint8) * 255)
        fov_512, _ = segInfer._aspect_pad(fov_orig.astype(np.uint8) * 255)
        pred_512 = prob > thresh

        for key, pred, gt, fov in (
                ("orig", pred_orig, gt_orig, fov_orig),
                ("s512", pred_512, gt_512 > 127, fov_512 > 127)):
            for scope, sel in (("fov", fov), ("all", np.ones_like(fov))):
                p, g = pred[sel], gt[sel]
                counts = np.array([
                    int(( p &  g).sum()),   # TP
                    int(( p & ~g).sum()),   # FP
                    int((~p & ~g).sum()),   # TN
                    int((~p &  g).sum()),   # FN
                ], np.int64)
                acc[f"{key}_{scope}"] += counts

        tp, fp, tn, fn = [int(v) for v in (
            (pred_orig & gt_orig & fov_orig).sum(),
            (pred_orig & ~gt_orig & fov_orig).sum(),
            (~pred_orig & ~gt_orig & fov_orig).sum(),
            (~pred_orig & gt_orig & fov_orig).sum())]
        m = rates(tp, fp, tn, fn)
        per_image.append((name, m))
        scored += 1
        print(f"  {name:22s} Se {m['sensitivity']:.4f}  Sp {m['specificity']:.4f}  "
              f"Dice {m['f1']:.4f}  IoU {m['iou']:.4f}")

    return acc, per_image, scored, skipped


def eval_localization(cases):
    import onnxruntime as ort
    import cv2

    sess = ort.InferenceSession(onnx_path("localization"),
                                providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name

    rows = []
    for img_path, _gt, fov_path in cases:
        bgr = _read_bgr(img_path)
        h, w = bgr.shape[:2]

        # segInfer.localize(), exactly: INTER_AREA to 512, BGR->RGB, ImageNet.
        resized = cv2.resize(bgr, (INPUT_SIZE, INPUT_SIZE),
                             interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
        x = (rgb.astype(np.float32) / 255.0
             - segInfer.IMAGENET_MEAN) / segInfer.IMAGENET_STD
        hm = sess.run(None, {in_name: x.transpose(2, 0, 1)[None, ...]})[0][0]

        fov = (_read_gray(fov_path) > 127) if fov_path else None
        row = {"name": os.path.basename(img_path)}
        for idx, key in ((0, "opticDisc"), (1, "fovea")):
            iy, ix = np.unravel_index(hm[idx].argmax(), hm[idx].shape)
            px, py = float(ix) * w / INPUT_SIZE, float(iy) * h / INPUT_SIZE
            # No coordinate ground truth exists, so the only check available is
            # whether the peak is anatomically possible at all: a landmark
            # outside the field of view is wrong regardless of annotations.
            inside = None
            if fov is not None:
                yy, xx = int(round(py)), int(round(px))
                inside = bool(fov[min(max(yy, 0), h - 1), min(max(xx, 0), w - 1)])
            row[key] = {"x512": int(ix), "y512": int(iy), "x": px, "y": py,
                        "peak": float(hm[idx].max()), "insideFov": inside}
        rows.append(row)

    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--drive", default=None,
                    help="DRIVE root (contains test/ and training/)")
    ap.add_argument("--split", default="training", choices=["training", "test"])
    ap.add_argument("--thresh", type=float, default=0.5,
                    help="probability threshold, matching segInfer's >0.5")
    args = ap.parse_args()

    drive = args.drive
    if drive is None:
        # DRIVE sits beside dr-screening-system/datasets, NOT under
        # ml-pipeline/datasets where chasedb1 and idrid are. Both candidates
        # are tried so this works whichever layout a machine has.
        for cand in (os.path.join(ML_ROOT, "datasets", "DRIVE"),
                     os.path.abspath(os.path.join(
                         ML_ROOT, "..", "..", "..", "datasets", "DRIVE"))):
            if os.path.isdir(cand):
                drive = cand
                break
    if not drive or not os.path.isdir(drive):
        raise SystemExit("DRIVE dataset not found; pass --drive DIR")

    cases = discover(drive, args.split)
    n_gt = sum(1 for _i, g, _f in cases if g)
    n_fov = sum(1 for _i, _g, f in cases if f)

    print(f"DRIVE: {drive}")
    print(f"split: {args.split}   images: {len(cases)}   "
          f"with vessel GT: {n_gt}   with FOV mask: {n_fov}")
    print(f"threshold: prob > {args.thresh}\n")

    if n_gt == 0:
        print(f"NOTE: split '{args.split}' has no 1st_manual/ vessel ground "
              f"truth, so M2 cannot be scored here. DRIVE ships expert "
              f"tracings for the training split only. Re-run with "
              f"--split training.\n")

    print("=" * 72)
    print("MODEL 2 -- VESSEL SEGMENTATION (per image, original space, in FOV)")
    print("=" * 72)
    acc, per_image, scored, skipped = eval_vessel(cases, args.thresh)

    if scored:
        print(f"\n{'-' * 72}")
        print(f"AGGREGATED over {scored} images "
              f"({skipped} skipped for missing GT)")
        print(f"{'-' * 72}")
        label = {
            "orig_fov":  "original space, inside FOV   <- PRIMARY",
            "orig_all":  "original space, whole frame",
            "s512_fov":  "512 model space, inside FOV",
            "s512_all":  "512 model space, whole frame",
        }
        for key in ("orig_fov", "orig_all", "s512_fov", "s512_all"):
            tp, fp, tn, fn = (int(v) for v in acc[key])
            m = rates(tp, fp, tn, fn)
            print(f"\n{label[key]}")
            print(f"  TP {tp:>10,}   FP {fp:>10,}   "
                  f"TN {tn:>12,}   FN {fn:>10,}")
            print(f"  Sensitivity (recall) {m['sensitivity']:.4f}")
            print(f"  Specificity          {m['specificity']:.4f}")
            print(f"  Precision            {m['precision']:.4f}")
            print(f"  F1 / Dice            {m['f1']:.4f}")
            print(f"  IoU (Jaccard)        {m['iou']:.4f}")
            print(f"  Accuracy             {m['accuracy']:.4f}")

    
        dices = [m["f1"] for _n, m in per_image]
        senss = [m["sensitivity"] for _n, m in per_image]
        print(f"\n  per-image mean Dice  {np.mean(dices):.4f} "
              f"+/- {np.std(dices):.4f}  (min {np.min(dices):.4f}, "
              f"max {np.max(dices):.4f})")
        print(f"  per-image mean Se    {np.mean(senss):.4f} "
              f"+/- {np.std(senss):.4f}")

    print(f"\n{'=' * 72}")
    print("MODEL 3 -- OPTIC DISC & FOVEA LOCALIZATION")
    print("=" * 72)
    print("Ground Truth missing for Model 3 metrics.")
    print("DRIVE is a vessel-segmentation benchmark: it ships images/, mask/ "
          "(FOV)\nand 1st_manual/ (vessels) only, with no optic-disc or fovea "
          "coordinates.\nMean Euclidean Distance Error cannot be computed "
          "from this dataset.\nInference is run below to confirm the export "
          "produces usable landmarks;\nthese are predictions, NOT scored "
          "against anything.\n")

    rows = eval_localization(cases)
    inside = 0
    for r in rows:
        d, f = r["opticDisc"], r["fovea"]
        print(f"  {r['name']:22s} disc=({d['x']:6.1f},{d['y']:6.1f}) "
              f"peak {d['peak']:.3f} fov=({f['x']:6.1f},{f['y']:6.1f}) "
              f"peak {f['peak']:.3f}")
        inside += int(bool(d["insideFov"])) + int(bool(f["insideFov"]))
    if rows:
        tot = 2 * len(rows)
        print(f"\n  sanity check only: {inside}/{tot} predicted landmarks fall "
              f"inside the FOV mask.")
        print("  This is a plausibility bound, not an accuracy metric -- a "
              "landmark can sit\n  inside the FOV and still be in the wrong "
              "place. Scoring M3 needs a dataset\n  with disc/fovea "
              "annotations (IDRiD's localization set has them).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
