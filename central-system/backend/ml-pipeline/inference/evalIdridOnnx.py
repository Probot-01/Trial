

import argparse
import csv
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ML_ROOT)

import segInfer      # noqa: E402
import modelPaths    # noqa: E402
import verifyModel3  # noqa: E402  (resolve_images, and the proven recipe)

INPUT_SIZE = segInfer.INPUT_SIZE
LOC = verifyModel3.LOC
PRED_CSV = verifyModel3.PRED_CSV

OD_RADIUS_FRAC = 0.0655

GT_DIRS = {
    "od":    ("2. Groundtruths", "1. Optic Disc Center Location"),
    "fovea": ("2. Groundtruths", "2. Fovea Center Location"),
}
GT_FILES = {
    ("od", "train"):    "a. IDRiD_OD_Center_Training Set_Markups.csv",
    ("od", "test"):     "b. IDRiD_OD_Center_Testing Set_Markups.csv",
    ("fovea", "train"): "IDRiD_Fovea_Center_Training Set_Markups.csv",
    ("fovea", "test"):  "IDRiD_Fovea_Center_Testing Set_Markups.csv",
}
IMG_DIRS = {"train": "a. Training Set", "test": "b. Testing Set"}


def load_gt(landmark, split):
    path = os.path.join(LOC, *GT_DIRS[landmark], GT_FILES[(landmark, split)])
    return verifyModel3._read_gt(path)      # {id: (x, y)} in ORIGINAL pixels


def build_cases(which):
    """[(image_id, split, path)] for the requested set."""
    if which == "heldout":
        with open(PRED_CSV, newline="", encoding="utf-8-sig") as fh:
            rows = list(csv.DictReader(fh))
        resolved, unresolved = verifyModel3.resolve_images(rows)
        if unresolved:
            print(f"  WARNING: {len(unresolved)} ids could not be resolved to "
                  f"a folder and are excluded: {unresolved}")
        return ([(i, s, p) for i, (s, p) in sorted(resolved.items())],
                len(rows))

    splits = {"all": ("train", "test"), "train": ("train",), "test": ("test",)}[which]
    cases = []
    for split in splits:
        folder = os.path.join(LOC, "1. Original Images", IMG_DIRS[split])
        for fname in sorted(os.listdir(folder)):
            if fname.lower().endswith((".jpg", ".jpeg", ".png", ".tif")):
                cases.append((os.path.splitext(fname)[0], split,
                              os.path.join(folder, fname)))
    return cases, len(cases)


def summarize(name, errs_orig, errs_512, radii):
    """Distance stats plus within-radius hit rates."""
    e, e512, r = (np.asarray(errs_orig, float), np.asarray(errs_512, float),
                  np.asarray(radii, float))
    print(f"\n  {name}  (n={len(e)})")
    print(f"    Mean Euclidean Distance Error : {e.mean():10.2f} px (original)")
    print(f"    Median                        : {np.median(e):10.2f} px")
    print(f"    Std                           : {e.std():10.2f} px")
    print(f"    Min / Max                     : {e.min():.2f} / {e.max():.2f} px")
    print(f"    Mean error in 512 space       : {e512.mean():10.2f} px "
          f"(median {np.median(e512):.2f})")
    frac = e / r
    for mult, label in ((0.25, "0.25R"), (0.5, "0.5R"), (1.0, "1R"), (2.0, "2R")):
        hit = float((frac <= mult).mean()) * 100.0
        print(f"    within {label:>5s} ({mult * OD_RADIUS_FRAC * 100:.2f}% of width): "
              f"{hit:6.2f}%  ({int((frac <= mult).sum())}/{len(e)})")
    return {"mean": float(e.mean()), "median": float(np.median(e)),
            "mean512": float(e512.mean()),
            "within1R": float((frac <= 1.0).mean()) * 100.0}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", dest="which", default="heldout",
                    choices=["heldout", "all", "train", "test"],
                    help="heldout = the 78 images M3 itself held out (default)")
    ap.add_argument("--limit", type=int, default=None,
                    help="score only the first N images (smoke test)")
    args = ap.parse_args()

    import cv2
    import onnxruntime as ort

    onnx_file = modelPaths.resolve_checkpoint(
        modelPaths.CHECKPOINTS["localization"].replace(".pt", ".onnx"))
    sess = ort.InferenceSession(onnx_file, providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name

    print(f"model : {onnx_file}")
    print(f"IDRiD : {LOC}")
    print(f"set   : {args.which}")

    cases, total = build_cases(args.which)
    if args.limit:
        cases = cases[:args.limit]

    if args.which == "heldout":
        n_tr = sum(1 for _i, s, _p in cases if s == "train")
        print(f"images: {len(cases)} of {total} held-out rows resolved "
              f"({n_tr} from the Training folder, {len(cases) - n_tr} from "
              f"Testing -- the split draws from both)")
        print("status: HELD OUT by the model. This estimates generalization.")
    else:
        print(f"images: {len(cases)}")
        print("status: *** CONTAMINATED -- M3 was trained on most of these. ***")
        print("        These figures are training error, not accuracy.")

    gt = {(lm, sp): load_gt(lm, sp) for lm in ("od", "fovea")
          for sp in ("train", "test")}

    res = {"od": ([], [], []), "fovea": ([], [], [])}
    worst = {"od": [], "fovea": []}
    missing = 0

    for img_id, split, path in cases:
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        if bgr is None:
            missing += 1
            continue
        h, w = bgr.shape[:2]

        # The proven recipe, via verifyModel3 so there is one copy of it.
        x = verifyModel3.preprocess(bgr).numpy()
        hm = sess.run(None, {in_name: x})[0][0]

        for idx, lm in ((0, "od"), (1, "fovea")):
            truth = gt[(lm, split)].get(img_id)
            if truth is None:
                continue
            iy, ix = np.unravel_index(hm[idx].argmax(), hm[idx].shape)
            # 512-space argmax mapped back to the photograph, exactly as
            # segInfer.localize() reports it.
            px, py = float(ix) * w / INPUT_SIZE, float(iy) * h / INPUT_SIZE
            d_orig = float(np.hypot(px - truth[0], py - truth[1]))
            # 512-space error: ground truth carried INTO the model frame,
            # rather than scaling d_orig by one axis -- the squish has a
            # different factor per axis, so a single scalar would be wrong.
            d_512 = float(np.hypot(float(ix) - truth[0] * INPUT_SIZE / w,
                                   float(iy) - truth[1] * INPUT_SIZE / h))
            radius = OD_RADIUS_FRAC * w
            res[lm][0].append(d_orig)
            res[lm][1].append(d_512)
            res[lm][2].append(radius)
            worst[lm].append((d_orig, img_id, split, d_orig / radius))

    print(f"\n{'=' * 72}")
    print("MODEL 3 -- OPTIC DISC & FOVEA LOCALIZATION vs IDRiD GROUND TRUTH")
    print("=" * 72)
    if missing:
        print(f"  ({missing} images unreadable and skipped)")

    out = {}
    for lm, label in (("od", "OPTIC DISC"), ("fovea", "FOVEA")):
        if res[lm][0]:
            out[lm] = summarize(label, *res[lm])

    both = res["od"][0] + res["fovea"][0]
    if both:
        print(f"\n  COMBINED mean Euclidean error over both landmarks: "
              f"{np.mean(both):.2f} px (n={len(both)})")


    ck_err = 5.646450042724609      # ckpt['best_val_pixel_error'], 512-space
    if out:
        mean512 = np.mean([v["mean512"] for v in out.values()])
        print(f"\n  checkpoint's recorded best_val_pixel_error : "
              f"{ck_err:.2f} px (512-space)")
        print(f"  ours, same space, mean over both landmarks : {mean512:.2f} px")

    for lm, label in (("od", "optic disc"), ("fovea", "fovea")):
        if worst[lm]:
            worst[lm].sort(reverse=True)
            print(f"\n  worst 5 {label} errors:")
            for d, img_id, split, fr in worst[lm][:5]:
                flag = "  <- gross miss" if fr > 1.0 else ""
                print(f"    {img_id} ({split:5s}) {d:9.1f} px = {fr:5.2f}R{flag}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
