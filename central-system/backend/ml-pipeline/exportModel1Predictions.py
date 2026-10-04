

import argparse
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

MODEL_VERSIONS = {
    "branchA_v1":  {"npy_prefix": "branchA_v1", "dir": os.path.join(HERE, "models", "Model1")},
    "branchA_v2a": {"npy_prefix": "branchA_v2a", "dir": os.path.join(HERE, "models", "Model1", "v2a")},
    "branchA_v2b": {"npy_prefix": "branchA_v2b", "dir": os.path.join(HERE, "models", "Model1", "v2b")},
    "branchA_v2c": {"npy_prefix": "branchA_v2c", "dir": os.path.join(HERE, "models", "Model1", "v2c")},
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-version", choices=sorted(MODEL_VERSIONS), default="branchA_v1")
    args = ap.parse_args()

    cfg = MODEL_VERSIONS[args.model_version]
    model_dir = cfg["dir"]
    prefix = cfg["npy_prefix"]

    for split in ("val", "test"):
        logits = np.load(os.path.join(model_dir, f"{prefix}_{split}_logits.npy"))
        labels = np.load(os.path.join(model_dir, f"{prefix}_{split}_labels.npy"))

        if logits.shape[0] != labels.shape[0]:
            raise SystemExit(
                f"{split}: {logits.shape[0]} logit rows but {labels.shape[0]} labels")
        if logits.shape[1] != 5:
            raise SystemExit(f"{split}: expected 5 classes, got {logits.shape[1]}")

       
        np.savetxt(os.path.join(model_dir, f"{split}_logits.csv"),
                   logits, delimiter=",", fmt="%.17g")
        np.savetxt(os.path.join(model_dir, f"{split}_labels.csv"),
                   labels.astype(int), delimiter=",", fmt="%d")

        counts = np.bincount(labels.astype(int), minlength=5)
        print(f"{split:5s}  n={len(labels):4d}  grade counts {counts.tolist()}")

    print(f"\n[{args.model_version}] written to {model_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
