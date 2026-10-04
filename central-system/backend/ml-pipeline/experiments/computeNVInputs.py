
import argparse
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import pandas as pd

PIPELINE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PIPELINE_DIR / "inference"))
import segInfer  # noqa: E402  (read-only import of the LIVE functions)

CANVAS = 512

IDRID_GRADING_ROOT = PIPELINE_DIR / "datasets" / "idrid" / "grading" / "B. Disease Grading"
MESSIDOR_ROOT = PIPELINE_DIR / "datasets" / "Messidor-2"


def compute_mask512_and_disc(bgr):
    """Returns (mask512 bool [512,512], discX512, discY512) - see module
    docstring for why original-pixel-space first, then resize."""
    h, w = bgr.shape[:2]
    pts = segInfer.localize(bgr)
    disc_x, disc_y = pts["opticDisc"]["x"], pts["opticDisc"]["y"]
    mask_orig = segInfer.vessels(bgr)  # bool, (h, w), fixed >0.5 threshold

    mask512 = cv2.resize(mask_orig.astype(np.uint8) * 255, (CANVAS, CANVAS),
                         interpolation=cv2.INTER_NEAREST) > 127
    disc_x512 = disc_x * CANVAS / w
    disc_y512 = disc_y * CANVAS / h
    return mask512, float(disc_x512), float(disc_y512), pts["opticDisc"]["peak"]


def list_idrid(split):
    """split: 'a. Training Set' or 'b. Testing Set'. Only images that ACTUALLY
    exist on disk are returned (the local grading Training Set folder is
    known to be incomplete - see memory/session notes)."""
    img_dir = IDRID_GRADING_ROOT / "1. Original Images" / split
    label_name = ("a. IDRiD_Disease Grading_Training Labels.csv" if "Training" in split
                 else "b. IDRiD_Disease Grading_Testing Labels.csv")
    label_csv = IDRID_GRADING_ROOT / "2. Groundtruths" / label_name
    df = pd.read_csv(label_csv)
    df.columns = [c.strip() for c in df.columns]
    df = df.rename(columns={"Image name": "image_id", "Retinopathy grade": "grade"})[["image_id", "grade"]]
    rows = []
    for _, r in df.iterrows():
        p = img_dir / f"{r.image_id}.jpg"
        if p.is_file():
            rows.append({"image_id": r.image_id, "grade": int(r.grade), "path": str(p)})
    return pd.DataFrame(rows)


def list_messidor2():
    manifest = pd.read_csv(MESSIDOR_ROOT / "eval_manifest.csv")
    assert manifest["gradable"].eq(1).all()
    rows = []
    for _, r in manifest.iterrows():
        rows.append({"image_id": Path(r.image_path).stem, "grade": int(r.dr_grade),
                    "path": str(MESSIDOR_ROOT / r.image_path), "patient_id": int(r.patient_id)})
    return pd.DataFrame(rows)


DATASETS = {
    "idrid_train": lambda: list_idrid("a. Training Set"),
    "idrid_test": lambda: list_idrid("b. Testing Set"),
    "messidor2": list_messidor2,
}


def cache_path(out_dir, dataset, image_id):
    return Path(out_dir) / dataset / f"{image_id}.npz"


def run(dataset, out_dir):
    df = DATASETS[dataset]()
    print(f"{dataset}: {len(df)} images (with grades: {df['grade'].value_counts().sort_index().to_dict()})")
    (Path(out_dir) / dataset).mkdir(parents=True, exist_ok=True)

    n_cached = n_computed = n_failed = 0
    t0 = time.time()
    for i, row in df.iterrows():
        cp = cache_path(out_dir, dataset, row.image_id)
        if cp.is_file():
            n_cached += 1
            continue
        bgr = cv2.imread(row.path, cv2.IMREAD_COLOR)
        if bgr is None:
            print(f"  WARNING: cannot read {row.path} - skipping")
            n_failed += 1
            continue
        mask512, discX, discY, fovea_peak_unused_here = compute_mask512_and_disc(bgr)
        np.savez_compressed(cp, mask512=mask512, discX512=discX, discY512=discY,
                            grade=row.grade, source_path=row.path)
        n_computed += 1
        if n_computed % 50 == 0:
            dt = time.time() - t0
            print(f"  {n_computed} computed, {n_cached} already cached, {n_failed} failed "
                 f"({dt:.0f}s elapsed, {dt / max(n_computed,1):.2f}s/image)")

    print(f"{dataset} DONE: {n_computed} computed, {n_cached} already cached, {n_failed} failed "
         f"({time.time() - t0:.0f}s)")
    manifest_out = Path(out_dir) / dataset / "_manifest.csv"
    df.to_csv(manifest_out, index=False)
    print(f"Wrote {manifest_out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True, choices=list(DATASETS.keys()))
    ap.add_argument("--out-dir", required=True, help="scratch directory OUTSIDE git")
    args = ap.parse_args()
    run(args.dataset, args.out_dir)
