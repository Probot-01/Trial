

import argparse
import csv
import os
import sys

import cv2
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ML_ROOT, "inference"))
sys.path.insert(0, ML_ROOT)

MODEL1 = os.path.join(ML_ROOT, "models", "Model1")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=0)
    ap.add_argument("--out", default=os.path.join(HERE, "task92_inputs.csv"))
    args = ap.parse_args()

    sys.argv = [sys.argv[0]]
    import branchAInfer as B
    import segInfer as S
    from domainGap import resolve_idrid

    model, ckpt = B.load_model()
    calib = B.load_calibration()
    T = float(calib.get("temperature", 1.0))

    ids = np.load(os.path.join(MODEL1, "branchA_v1_test_ids.npy"), allow_pickle=True)
    labels = np.load(os.path.join(MODEL1, "branchA_v1_test_labels.npy"), allow_pickle=True)

    cases = []
    for s, y in zip(ids, labels):
        s = str(s)
        if not s.startswith("idrid"):
            continue
        p = resolve_idrid(s)
        if p:
            cases.append((s, p, int(y)))
    if args.n:
        cases = cases[:args.n]
    print(f"cases: {len(cases)}")

    rows = []
    for i, (img_id, path, truth) in enumerate(cases, 1):
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)

        x, _base, _enh = B.preprocess(path, ckpt)
        with torch.no_grad():
            logits = model(torch.from_numpy(x)).numpy()[0]
        probs = B.softmax(logits / T)

        # Branch B inputs. Any failure leaves the counts EMPTY rather than zero:
        # runTask92.m then passes NaN as the rule grade, which is "could not
        # run", not "found nothing". Those are different claims and the whole
        # coverage calculation depends on not confusing them.
        red_q = bright_q = None
        try:
            pts = S.localize(bgr)
            disc = (pts["opticDisc"]["x"], pts["opticDisc"]["y"])
            fovea = (pts["fovea"]["x"], pts["fovea"]["y"])
            _r, _b, _od, red512, bright512, box = S.lesions(bgr, disc)
            d512 = S._to_crop512(disc[0], disc[1], box)
            f512 = S._to_crop512(fovea[0], fovea[1], box)
            red_q = S.quadrant_counts(S.describe(red512, 10), f512, d512)
            bright_q = S.quadrant_counts(S.describe(bright512, 10), f512, d512)
        except Exception as exc:  # noqa: BLE001
            print(f"  {img_id}: segmentation failed ({exc}); Branch B unavailable")

        rows.append({
            "image_id": img_id,
            "true_grade": truth,
            **{f"p{k}": f"{probs[k]:.10f}" for k in range(5)},
            "red_q": " ".join(map(str, red_q)) if red_q else "",
            "bright_q": " ".join(map(str, bright_q)) if bright_q else "",
        })
        if i % 10 == 0:
            print(f"  {i}/{len(cases)}")

    fields = ["image_id", "true_grade"] + [f"p{k}" for k in range(5)] + ["red_q", "bright_q"]
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

    have_b = sum(1 for r in rows if r["red_q"])
    print(f"\nwrote {len(rows)} rows to {args.out}")
    print(f"Branch B inputs available for {have_b}/{len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
