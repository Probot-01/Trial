
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import nnls
from sklearn.metrics import roc_auc_score, roc_curve
from sklearn.model_selection import StratifiedKFold

COMPONENTS = ["density", "tortuosity", "fractalDim", "branchDensity"]
DESIGN_THRESHOLD = 0.6
N_BOOT = 2000
BOOT_SEED = 42


# ═══════════════════════════════════════════════════════════════════════════
# Normalisation + weight fitting - TRAIN ONLY, everywhere
# ═══════════════════════════════════════════════════════════════════════════
def fit_train_ranges(train_df):
    """Min-max range per component, from TRAIN data only."""
    ranges = {}
    for c in COMPONENTS:
        lo, hi = float(train_df[c].min()), float(train_df[c].max())
        if hi <= lo:
            hi = lo + 1e-6  # degenerate column guard, should not fire on real data
        ranges[c] = (lo, hi)
    return ranges


def normalise(df, ranges):
    """Returns an (n, 4) array of min-max-normalised, clipped-to-[0,1] components."""
    cols = []
    for c in COMPONENTS:
        lo, hi = ranges[c]
        cols.append(np.clip((df[c].values - lo) / (hi - lo), 0.0, 1.0))
    return np.stack(cols, axis=1)


def fit_weights_nnls(X, y):
    """Non-negative least squares of weak label y on normalised features X,
    weights renormalised to sum to 1 (a zero-weight-vector fit, degenerate
    only if X is literally constant, falls back to equal weights)."""
    w, _residual = nnls(X, y.astype(float))
    if w.sum() <= 1e-9:
        return np.array([0.25, 0.25, 0.25, 0.25])
    return w / w.sum()


def cross_validate_weights(train_df, ranges, n_folds=5, seed=BOOT_SEED):
    """5-fold CV on TRAIN ONLY: fit NNLS weights on 4 folds, evaluate AUC on
    the held-out fold, using the SAME train-only ranges throughout (ranges
    are fit once on the full 251, before this CV loop - re-fitting them per
    fold would be a defensible alternative but the task asks for ranges from
    "the train part", singular, i.e. the whole 251, not a nested re-fit)."""
    X = normalise(train_df, ranges)
    y = (train_df["grade"].values == 4).astype(int)
    skf = StratifiedKFold(n_splits=n_folds, shuffle=True, random_state=seed)
    fold_aucs, fold_weights = [], []
    for tr_idx, te_idx in skf.split(X, y):
        w = fit_weights_nnls(X[tr_idx], y[tr_idx])
        score_te = X[te_idx] @ w
        if len(np.unique(y[te_idx])) > 1:
            fold_aucs.append(float(roc_auc_score(y[te_idx], score_te)))
        else:
            fold_aucs.append(float("nan"))
        fold_weights.append(w.tolist())
    return fold_aucs, fold_weights


# ═══════════════════════════════════════════════════════════════════════════
# Scoring
# ═══════════════════════════════════════════════════════════════════════════
def apply_score(df, ranges, weights):
    X = normalise(df, ranges)
    return np.clip(X @ np.asarray(weights), 0.0, 1.0)


def youden_threshold(y_true, score):
    fpr, tpr, thr = roc_curve(y_true, score)
    j = tpr - fpr
    return float(thr[np.argmax(j)])


def sens_spec_at(y_true, score, thr):
    pred = score >= thr
    tp = int((y_true & pred).sum()); fn = int((y_true & ~pred).sum())
    tn = int((~y_true & ~pred).sum()); fp = int((~y_true & pred).sum())
    return (tp / (tp + fn) if (tp + fn) else float("nan"),
           tn / (tn + fp) if (tn + fp) else float("nan"))


def bootstrap_ci_auc(y_true, score, n_boot=N_BOOT, seed=BOOT_SEED, groups=None):
    """Plain (groups=None) or patient-clustered (groups=array) percentile
    bootstrap 95% CI for AUC."""
    rng = np.random.default_rng(seed)
    n = len(y_true)
    aucs = []
    if groups is None:
        for _ in range(n_boot):
            idx = rng.integers(0, n, size=n)
            yt = y_true[idx]
            if len(np.unique(yt)) < 2:
                continue
            aucs.append(roc_auc_score(yt, score[idx]))
    else:
        unique_g = np.unique(groups)
        g_to_idx = {g: np.where(groups == g)[0] for g in unique_g}
        n_g = len(unique_g)
        for _ in range(n_boot):
            sampled = rng.choice(unique_g, size=n_g, replace=True)
            idx = np.concatenate([g_to_idx[g] for g in sampled])
            yt = y_true[idx]
            if len(np.unique(yt)) < 2:
                continue
            aucs.append(roc_auc_score(yt, score[idx]))
    aucs = np.array(aucs)
    return float(np.percentile(aucs, 2.5)), float(np.percentile(aucs, 97.5))


def auc_with_ci(y_true, score, groups=None):
    if len(np.unique(y_true)) < 2:
        return {"auc": float("nan"), "ci95": [float("nan"), float("nan")], "n": len(y_true), "n_pos": int(y_true.sum())}
    auc = float(roc_auc_score(y_true, score))
    lo, hi = bootstrap_ci_auc(y_true, score, groups=groups)
    return {"auc": auc, "ci95": [lo, hi], "n": int(len(y_true)), "n_pos": int(y_true.sum())}


# ═══════════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-csv", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    lines = []
    def out(s=""):
        print(s)
        lines.append(str(s))

    df = pd.read_csv(args.raw_csv)
    df = df[df["valid"] == True].copy()  # noqa: E712  (rows where the score genuinely computed)
    train_df = df[df["dataset"] == "idrid_train"].reset_index(drop=True)
    test_df = df[df["dataset"] == "idrid_test"].reset_index(drop=True)
    mess_df = df[df["dataset"] == "messidor2"].reset_index(drop=True)

    
    manifest_path = Path(__file__).resolve().parent.parent / "datasets" / "Messidor-2" / "eval_manifest.csv"
    manifest = pd.read_csv(manifest_path)
    manifest["imageId"] = manifest["image_path"].apply(lambda p: Path(p).stem)
    mess_df = mess_df.merge(manifest[["imageId", "patient_id"]], on="imageId", how="left")
    assert mess_df["patient_id"].notna().all(), "some Messidor-2 rows failed to match a patient_id - join is broken"
    mess_df["patient_id"] = mess_df["patient_id"].astype(int)

    out("=" * 78)
    out("NV-SCORE PDR SEPARATION - fit on IDRiD-train, validate on IDRiD-test + Messidor-2")
    out("=" * 78)
    out(f"n per grade, IDRiD train (valid={len(train_df)}): "
       f"{train_df['grade'].value_counts().sort_index().to_dict()}")
    out(f"n per grade, IDRiD test  (valid={len(test_df)}): "
       f"{test_df['grade'].value_counts().sort_index().to_dict()}")
    out(f"n per grade, Messidor-2  (valid={len(mess_df)}): "
       f"{mess_df['grade'].value_counts().sort_index().to_dict()}")

    # ---- ranges + weights, TRAIN ONLY -------------------------------------
    ranges = fit_train_ranges(train_df)
    out("\nTrain-only min-max ranges (component -> [lo, hi]):")
    for c in COMPONENTS:
        out(f"  {c:14s}: {ranges[c]}")

    fold_aucs, fold_weights = cross_validate_weights(train_df, ranges)
    out(f"\n5-fold CV (train-only, weak label grade4=1 vs 0-3): fold AUCs = "
       f"{[round(a, 4) for a in fold_aucs]}")
    out(f"  mean={np.nanmean(fold_aucs):.4f}  std={np.nanstd(fold_aucs):.4f}  "
       f"per-fold weights={[[round(w, 3) for w in wv] for wv in fold_weights]}")

    X_train_all = normalise(train_df, ranges)
    y_train_all = (train_df["grade"].values == 4).astype(int)
    fitted_weights = fit_weights_nnls(X_train_all, y_train_all)
    equal_weights = np.array([0.25, 0.25, 0.25, 0.25])
    out(f"\nCHOSEN (fitted) weights [{', '.join(COMPONENTS)}]: "
       f"{[round(w, 4) for w in fitted_weights]}")
    out(f"Equal-weight comparison : {equal_weights.tolist()}")

    # ---- Youden thresholds, TRAIN ONLY -------------------------------------
    train_old_score = train_df["oldScore"].values
    train_fitted_score = apply_score(train_df, ranges, fitted_weights)
    train_equal_score = apply_score(train_df, ranges, equal_weights)
    youden_old = youden_threshold(y_train_all, train_old_score)
    youden_fitted = youden_threshold(y_train_all, train_fitted_score)
    youden_equal = youden_threshold(y_train_all, train_equal_score)
    out(f"\nTrain-optimal (Youden) thresholds: old={youden_old:.4f}  "
       f"fitted-new={youden_fitted:.4f}  equal-new={youden_equal:.4f}")

    # ---- item 2: compare old / equal / fitted, identically evaluated ------
    def summarise_variant(name, score_fn, threshold_train):
        row = {"variant": name}
        for label, dsdf, groups in [("idrid_test", test_df, None),
                                    ("messidor2", mess_df, mess_df["patient_id"].values if "patient_id" in mess_df else None)]:
            score = score_fn(dsdf)
            y4 = (dsdf["grade"].values == 4).astype(int).astype(bool)
            a = auc_with_ci(y4, score, groups=groups)
            row[f"{label}_auc"] = a["auc"]; row[f"{label}_ci"] = a["ci95"]
        return row

    variants_summary = []
    variants_summary.append(summarise_variant("old (2-component, 50/50)",
                                              lambda d: d["oldScore"].values, youden_old))
    variants_summary.append(summarise_variant("equal (4-way, 0.25 each)",
                                              lambda d: apply_score(d, ranges, equal_weights), youden_equal))
    variants_summary.append(summarise_variant("fitted (NNLS, train-CV)",
                                              lambda d: apply_score(d, ranges, fitted_weights), youden_fitted))

    out("\n" + "=" * 78)
    out("ITEM 2: old vs equal-4-way vs fitted-4-way, AUC(grade4 vs 0-3), identically evaluated")
    out("=" * 78)
    for r in variants_summary:
        out(f"  {r['variant']:28s} IDRiD-test AUC={r['idrid_test_auc']:.4f} "
           f"[{r['idrid_test_ci'][0]:.4f},{r['idrid_test_ci'][1]:.4f}]   "
           f"Messidor-2 AUC={r['messidor2_auc']:.4f} [{r['messidor2_ci'][0]:.4f},{r['messidor2_ci'][1]:.4f}]")

    # ---- item 3: full metric tables for OLD and FITTED-NEW -----------------
    def full_table(name, score_fn, thr_design, thr_youden):
        out(f"\n--- {name} ---")
        result = {"variant": name}
        for label, dsdf, groups in [("IDRiD official grading test (n=103)", test_df, None),
                                    ("Messidor-2 (frozen, external, n=1744)", mess_df,
                                     mess_df["patient_id"].values if "patient_id" in mess_df else None)]:
            score = score_fn(dsdf)
            grade = dsdf["grade"].values
            out(f"  {label}:")

            y4 = (grade == 4).astype(int).astype(bool)
            a4 = auc_with_ci(y4.astype(int), score, groups=groups)
            out(f"    AUC grade4 vs 0-3      : {a4['auc']:.4f} [{a4['ci95'][0]:.4f},{a4['ci95'][1]:.4f}]  "
               f"(n={a4['n']}, n_pos={a4['n_pos']})")
            result[f"{label}__auc_4_vs_0123"] = a4

            if "Messidor" in label:
                y34 = np.isin(grade, [3, 4]).astype(int)
                a34 = auc_with_ci(y34, score, groups=groups)
                out(f"    AUC grade3-4 vs 0-2    : {a34['auc']:.4f} [{a34['ci95'][0]:.4f},{a34['ci95'][1]:.4f}]  "
                   f"(n={a34['n']}, n_pos={a34['n_pos']})")
                result[f"{label}__auc_34_vs_012"] = a34

                ref_mask = np.isin(grade, [2, 3, 4])
                y4_ref = (grade[ref_mask] == 4).astype(int)
                score_ref = score[ref_mask]
                g_ref = groups[ref_mask] if groups is not None else None
                a4ref = auc_with_ci(y4_ref, score_ref, groups=g_ref)
                out(f"    AUC grade4 vs 2-3 (referable only): {a4ref['auc']:.4f} "
                   f"[{a4ref['ci95'][0]:.4f},{a4ref['ci95'][1]:.4f}]  (n={a4ref['n']}, n_pos={a4ref['n_pos']})")
                result[f"{label}__auc_4_vs_23_referable"] = a4ref

            for thr_name, thr in [(f"design threshold {thr_design}", thr_design),
                                  (f"train-Youden {thr_youden:.4f}", thr_youden)]:
                sens, spec = sens_spec_at(y4, score, thr)
                out(f"    sens/spec for PDR @ {thr_name}: sens={sens:.4f}  spec={spec:.4f}")
                result[f"{label}__sens_spec_{thr_name}"] = {"sens": sens, "spec": spec, "threshold": thr}
        return result

    old_table = full_table("OLD score (2-component, 50/50, live formula)",
                           lambda d: d["oldScore"].values, DESIGN_THRESHOLD, youden_old)
    new_table = full_table("NEW score (4-component, train-fitted NNLS weights)",
                           lambda d: apply_score(d, ranges, fitted_weights), DESIGN_THRESHOLD, youden_fitted)

    # ---- verdict -------------------------------------------------------------
    out("\n" + "=" * 78)
    out("VERDICT")
    out("=" * 78)
    test_auc_new = new_table["IDRiD official grading test (n=103)__auc_4_vs_0123"]["auc"]
    mess_auc_new = new_table["Messidor-2 (frozen, external, n=1744)__auc_4_vs_0123"]["auc"]
    verdict_lines = [
        f"NEW score AUC (grade4 vs 0-3): IDRiD-test={test_auc_new:.4f}, Messidor-2={mess_auc_new:.4f}.",
    ]
    if min(test_auc_new, mess_auc_new) < 0.70:
        verdict_lines.append("AUC is TOO LOW to justify any live use as a grade-4-triggering signal - "
                             "this remains what the module header already says: a suspicion signal for "
                             "human review, not something to route a decision through.")
    elif min(test_auc_new, mess_auc_new) < 0.80:
        verdict_lines.append("AUC is modest - better than chance, not strong enough to justify unsupervised "
                             "live use; remains a suspicion signal, not a decision input.")
    else:
        verdict_lines.append("AUC is reasonably strong on both sets, but a single small IDRiD-train fit "
                             "(18 positives) and no clinical validation still argue against live use without "
                             "further, independent confirmation.")
    for v in verdict_lines:
        out(v)

    # ---- write outputs ---------------------------------------------------
    report = {
        "train_ranges": ranges, "cv_fold_aucs": fold_aucs, "cv_fold_weights": fold_weights,
        "fitted_weights": fitted_weights.tolist(), "equal_weights": equal_weights.tolist(),
        "youden_thresholds": {"old": youden_old, "fitted": youden_fitted, "equal": youden_equal},
        "design_threshold": DESIGN_THRESHOLD,
        "item2_variant_comparison": variants_summary,
        "item3_old_score_table": old_table, "item3_new_score_table": new_table,
        "verdict": verdict_lines,
    }
    with open(out_dir / "nv_score_validation_report.json", "w") as f:
        json.dump(report, f, indent=2, default=lambda o: o.item() if isinstance(o, np.generic) else o.tolist() if isinstance(o, np.ndarray) else str(o))
    with open(out_dir / "nv_score_validation_report.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    out(f"\nWrote {out_dir / 'nv_score_validation_report.json'}")
    out(f"Wrote {out_dir / 'nv_score_validation_report.txt'}")


if __name__ == "__main__":
    main()
