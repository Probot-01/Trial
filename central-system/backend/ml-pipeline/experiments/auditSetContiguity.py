
import glob
import os
import sys

import cv2
import numpy as np
import torch

ML_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ML_ROOT)
sys.path.insert(0, os.path.join(ML_ROOT, "inference"))

import branchAInfer as bai  # noqa: E402

IDRID_TEST_DIR = os.path.join(
    ML_ROOT, "datasets", "idrid", "grading", "B. Disease Grading",
    "1. Original Images", "b. Testing Set")


def is_contiguous(grades):
    if len(grades) <= 1:
        return True
    g = sorted(grades)
    return g[-1] - g[0] + 1 == len(g)


def main():
    model, ckpt = bai.load_model()
    calib = bai.load_calibration()
    print(f"calibration: qhat={calib.get('qhat')}  alpha={calib.get('alpha')}  "
          f"calibrated={calib.get('calibrated')}  referableFrom={calib.get('referableFrom')}\n")

    images = sorted(glob.glob(os.path.join(IDRID_TEST_DIR, "*.jpg")))
    if not images:
        print(f"No images found under {IDRID_TEST_DIR}", file=sys.stderr)
        sys.exit(1)

    n_contig = 0
    n_scattered = 0
    n_empty = 0
    size_counts = {}
    scattered_examples = []

    for path in images:
        x, _base, _enh = bai.preprocess(path, ckpt)
        with torch.no_grad():
            logits = model(torch.from_numpy(x)).numpy()[0]
        T = float(calib.get("temperature", 1.0))
        cal = bai.softmax(logits / T)

        tier, pred_set, reason = bai.assign_tier(cal, calib)
        size_counts[len(pred_set)] = size_counts.get(len(pred_set), 0) + 1

        if len(pred_set) == 0:
            n_empty += 1
            continue
        if is_contiguous(pred_set):
            n_contig += 1
        else:
            n_scattered += 1
            if len(scattered_examples) < 10:
                scattered_examples.append((os.path.basename(path), pred_set,
                                           [round(float(p), 4) for p in cal]))

    n = len(images)
    n_nonempty = n_contig + n_scattered
    print(f"images tested            : {n}")
    print(f"empty prediction sets     : {n_empty}  ({100*n_empty/n:.1f}%)")
    print(f"non-empty sets            : {n_nonempty}")
    if n_nonempty:
        print(f"  contiguous              : {n_contig}  ({100*n_contig/n_nonempty:.1f}% of non-empty)")
        print(f"  scattered (non-contig.) : {n_scattered}  ({100*n_scattered/n_nonempty:.1f}% of non-empty)")
    print(f"\nset-size distribution      : {dict(sorted(size_counts.items()))}")

    if scattered_examples:
        print("\nexample scattered sets (image, set, calibrated probs [g0..g4]):")
        for name, s, probs in scattered_examples:
            print(f"  {name:20s} set={s}  probs={probs}")
    else:
        print("\nNo scattered sets observed in this sample.")


if __name__ == "__main__":
    main()
