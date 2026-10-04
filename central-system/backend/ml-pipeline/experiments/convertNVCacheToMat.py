
import argparse
from pathlib import Path

import numpy as np
from scipy.io import savemat


def convert_dataset(dataset_dir: Path):
    npz_files = sorted(dataset_dir.glob("*.npz"))
    n = 0
    for f in npz_files:
        mat_path = f.with_suffix(".mat")
        if mat_path.is_file() and mat_path.stat().st_mtime >= f.stat().st_mtime:
            continue
        d = np.load(f, allow_pickle=True)
        savemat(str(mat_path), {
            "mask": d["mask512"].astype(bool),
            "discXY": np.array([[float(d["discX512"]), float(d["discY512"])]]),
            "grade": int(d["grade"]),
            "imageId": f.stem,
        })
        n += 1
    print(f"{dataset_dir.name}: converted {n} new/updated .npz -> .mat ({len(npz_files)} total)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", required=True, help="the nv_score_pipeline scratch directory")
    args = ap.parse_args()
    root = Path(args.cache_dir)
    for sub in sorted(root.iterdir()):
        if sub.is_dir():
            convert_dataset(sub)
