

import json
import os
import sys

import numpy as np
from scipy.stats import beta

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
INFERENCE_DIR = os.path.join(ML_ROOT, "inference")
sys.path.insert(0, INFERENCE_DIR)

from branchAInfer import assign_tier, ordinal_mode_interval_score  # noqa: E402

MODELS_DIR = os.path.join(ML_ROOT, "models")
MODEL1_DIR = os.path.join(MODELS_DIR, "Model1")


def clopper_pearson(x, n, alpha=0.05):
    if n == 0:
        return (float("nan"), float("nan"))
    lo = 0.0 if x == 0 else beta.ppf(alpha / 2, x, n - x + 1)
    hi = 1.0 if x == n else beta.ppf(1 - alpha / 2, x + 1, n - x)
    return lo, hi


def softmax_rows(logits):
    z = logits - logits.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def old_marginal_lac_set(probs, qhat):
    """The method being replaced: raw {k : 1-p(k) <= qhat}, no hull, no
    forced mode. Reimplemented here (not imported) because the whole point
    is that this code path no longer exists in branchAInfer.py -- this is a
    frozen reference copy for the comparison only."""
    return [k for k in range(5) if (1.0 - probs[k]) <= qhat]


def is_contiguous(grades):
    if not grades:
        return True  # vacuously -- but flagged separately as empty below
    lo, hi = min(grades), max(grades)
    return sorted(grades) == list(range(lo, hi + 1))


def main():
    print("=" * 70)
    print("validate_conformal_v2.py is SUPERSEDED (conformal policy v3, 2026-09-20)")
    print("=" * 70)
    print("This script's premise (an untouched held-out test split) no longer")
    print("holds -- policy v3 pools val+test for the final fit. Its schema")
    print("assumptions (alphaPerClass, method='...mondrian_v2') are stale too.")
    print()
    print("Run experiments/conformalCrossFitValidation.py instead -- it reports")
    print("the same kind of numbers (coverage, set size, Tier A/B/C shares,")
    print("false-auto-clear rates) but measured honestly via cross-fitting.")
    print()
    print("See this file's module docstring for the full explanation. The")
    print("original v2 validation logic is kept below, unreachable, for")
    print("history -- _legacy_main_v2() -- and is not run by this main().")
    return 0


def _legacy_main_v2():
    """Unreachable -- kept for history only. See module docstring."""
    test_logits = np.load(os.path.join(MODEL1_DIR, "branchA_v1_test_logits.npy"))
    test_labels = np.load(os.path.join(MODEL1_DIR, "branchA_v1_test_labels.npy")).astype(int)
    n = len(test_labels)

    with open(os.path.join(MODELS_DIR, "calibration_v1.json"), "r", encoding="utf-8") as f:
        new_calib = json.load(f)
    new_calib["calibrated"] = True
    assert new_calib["method"] == "ordinal_mode_interval_mondrian_v2"

    with open(os.path.join(MODELS_DIR, "calibration_v1_marginal_lac_ARCHIVE.json"),
              "r", encoding="utf-8") as f:
        old_calib = json.load(f)

    T = float(new_calib["temperature"])
    assert abs(T - float(old_calib["temperature"])) < 1e-9, \
        "temperature differs between archived and new calibration -- unexpected"
    probs = softmax_rows(test_logits / T)

    print("=" * 70)
    print(f"CONFORMAL v2 VALIDATION -- branchA_v1 test split, n={n} (untouched)")
    print("=" * 70)

    # ── NEW method ───────────────────────────────────────────────────────
    set_sizes = np.zeros(n, dtype=int)
    covered = np.zeros(n, dtype=bool)
    tiers = [None] * n
    covered_per_grade = {k: [] for k in range(5)}

    for i in range(n):
        p = probs[i]
        y = test_labels[i]
        tier, pred_set, _reason, low, high, _contig = assign_tier(list(p), new_calib)
        set_sizes[i] = len(pred_set)
        covered[i] = y in pred_set
        tiers[i] = tier
        covered_per_grade[y].append(covered[i])

    marginal_coverage = covered.mean()
    print(f"\n--- NEW method: {new_calib['method']} ---")
    print(f"marginal coverage           : {marginal_coverage:.4f}  ({covered.sum()}/{n})")
    print(f"mean prediction-set size    : {set_sizes.mean():.3f}")
    for sz, label in [(1, "size 1"), (2, "size 2")]:
        frac = (set_sizes == sz).mean()
        print(f"fraction {label:<7s}          : {frac:.4f}  ({(set_sizes == sz).sum()}/{n})")
    frac_ge3 = (set_sizes >= 3).mean()
    print(f"fraction size >=3           : {frac_ge3:.4f}  ({(set_sizes >= 3).sum()}/{n})")

    print("\nper-grade coverage (covered/n_k, Clopper-Pearson 95% CI):")
    alpha_per_class = new_calib["alphaPerClass"]
    for k in range(5):
        arr = np.array(covered_per_grade[k])
        nk = len(arr)
        x = int(arr.sum())
        cov = x / nk if nk else float("nan")
        lo, hi = clopper_pearson(x, nk)
        target = 1 - alpha_per_class[k]
        flag = "" if (nk == 0 or lo <= target <= hi or cov >= target) else "  <-- BELOW TARGET"
        print(f"  grade {k}: n_k={nk:4d}  covered={x:4d}  coverage={cov:.4f}  "
              f"95% CI=[{lo:.4f}, {hi:.4f}]  target={target:.2f}{flag}")

    tier_counts = {t: tiers.count(t) for t in ("A", "B", "C")}
    print(f"\ntier distribution: A={tier_counts['A']}  B={tier_counts['B']}  C={tier_counts['C']}")

    mean_size = set_sizes.mean()
    print("\n--- gate check ---")
    if mean_size > 2.5:
        print(f"** MEAN SET SIZE {mean_size:.3f} EXCEEDS 2.5 -- STOP AND REPORT **")
    else:
        print(f"mean set size {mean_size:.3f} <= 2.5, gate OK")

    below_target = []
    for k in range(5):
        arr = np.array(covered_per_grade[k])
        nk = len(arr)
        if nk == 0:
            continue
        x = int(arr.sum())
        lo, hi = clopper_pearson(x, nk)
        target = 1 - alpha_per_class[k]
        if hi < target:
            below_target.append(k)
    if below_target:
        print(f"** grade(s) {below_target} coverage CI is CLEARLY BELOW target -- STOP AND REPORT **")
    else:
        print("no grade's coverage CI is clearly below its target")

    # ── OLD method, same 628 images, for the non-contiguous-fraction claim ─
    old_qhat = float(old_calib["qhat"])
    old_sets = [old_marginal_lac_set(probs[i], old_qhat) for i in range(n)]
    old_noncontig = sum(1 for s in old_sets if not is_contiguous(s))
    old_empty = sum(1 for s in old_sets if not s)
    old_sizes = np.array([len(s) for s in old_sets])

    print(f"\n--- OLD method (marginal LAC, qhat={old_qhat:.4f}) on the SAME {n} images ---")
    print(f"non-contiguous sets         : {old_noncontig}/{n}  ({100*old_noncontig/n:.1f}%)")
    print(f"  (earlier claim: 14.6% on a 103-image sample)")
    print(f"empty sets                  : {old_empty}/{n}  ({100*old_empty/n:.1f}%)")
    print(f"mean set size               : {old_sizes.mean():.3f}")

    print("\n" + "=" * 70)


if __name__ == "__main__":
    main()
