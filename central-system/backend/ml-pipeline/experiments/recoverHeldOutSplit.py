
import os
from collections import Counter
from pathlib import Path

import numpy as np

ML_ROOT = Path(__file__).resolve().parents[1]
MODEL1_DIR = ML_ROOT / "models" / "Model1"


def load_recovered_split():
    """Returns dict with 'test' and 'val' entries, each {ids, labels}.

    ids are '<source>__<original_id>' strings, e.g.
    'idrid__idrid_train_IDRiD_203', 'aptos__89ee1fa16f90'. labels are the
    ICDR 0-4 grade recorded at split time.
    """
    out = {}
    for split in ("test", "val"):
        ids = np.load(MODEL1_DIR / f"branchA_v1_{split}_ids.npy", allow_pickle=True)
        labels = np.load(MODEL1_DIR / f"branchA_v1_{split}_labels.npy", allow_pickle=True)
        assert len(ids) == len(labels), f"{split}: id/label count mismatch"
        out[split] = {"ids": ids, "labels": labels}
    return out


def excluded_ids(split):
    """All IDs (test + val, both sources) that MUST be excluded from any v2
    training set. Use this set to filter a combined APTOS+IDRiD+EyePACS
    training manifest before every v2 run, not just the first one."""
    return set(split["test"]["ids"]) | set(split["val"]["ids"])


def summarize(split):
    for name, d in split.items():
        ids, labels = d["ids"], d["labels"]
        sources = Counter(i.split("__")[0] for i in ids)
        grades = Counter(int(l) for l in labels)
        print(f"-- {name}: n={len(ids)} --")
        print(f"   sources: {dict(sources)}")
        print(f"   grade distribution: {dict(sorted(grades.items()))}")


def check_no_overlap(split):
    test_ids = set(split["test"]["ids"])
    val_ids = set(split["val"]["ids"])
    overlap = test_ids & val_ids
    assert not overlap, f"test/val overlap found: {overlap}"
    print(f"OK: test and val are disjoint ({len(test_ids)} + {len(val_ids)} ids, no overlap).")


def check_files_resolvable(split, sample_n=10):
    """Spot-check that a sample of recovered IDs actually resolve to real
    image files on disk, for the sources present locally (idrid). aptos IDs
    are hashed (e.g. '89ee1fa16f90') and cannot be mapped back to a filename
    without the original train_classifier_kaggle.ipynb id-hashing step --
    flagged, not silently skipped.
    """
    idrid_grading = (ML_ROOT / "datasets" / "idrid" / "grading" / "B. Disease Grading"
                      / "1. Original Images")
    checked, missing, unresolvable = 0, 0, 0
    for d in split.values():
        idrid_ids = [i for i in d["ids"] if i.startswith("idrid")][:sample_n]
        aptos_ids = [i for i in d["ids"] if not i.startswith("idrid")][:sample_n]
        unresolvable += len(aptos_ids)
        for i in idrid_ids:
           
            tail = i.split("__", 1)[1]
            fname = "IDRiD_" + tail.split("IDRiD_")[-1] + ".jpg"
            checked += 1
            found = [s for s in ("a. Training Set", "b. Testing Set")
                     if (idrid_grading / s / fname).is_file()]
            if not found:
                missing += 1
                print(f"  UNRESOLVED: {i} -> {fname} not found in either local subset")
    print(f"file-resolution spot check: {checked} idrid ids checked, {missing} missing, "
          f"{unresolvable} aptos ids skipped (hashed, no local mapping)")


if __name__ == "__main__":
    split = load_recovered_split()
    summarize(split)
    print()
    check_no_overlap(split)
    check_files_resolvable(split)
    print(f"\ntotal excluded ids (test+val, both sources): {len(excluded_ids(split))}")
    print("v2 training MUST filter its combined manifest against this exact set")
    print("before every run -- see the v2 Kaggle notebook's data-loading cell.")
