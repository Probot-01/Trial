

import json
import os
import sys

import numpy as np
from scipy.special import softmax as _softmax
from scipy.stats import t as _t_dist

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
INFERENCE_DIR = os.path.join(ML_ROOT, "inference")
sys.path.insert(0, INFERENCE_DIR)
sys.path.insert(0, ML_ROOT)

from branchAInfer import ordinal_mode_interval_score, assign_tier  # noqa: E402

V2A_DIR = os.path.join(ML_ROOT, "models", "Model1", "v2a")
MODEL1_DIR = os.path.join(ML_ROOT, "models", "Model1")
CALIB_V1_JSON = os.path.join(ML_ROOT, "models", "calibration_v1.json")
OUT_DIR = os.path.join(ML_ROOT, "diagnostics", "out")

NUM_CLASSES = 5
REFERABLE_FROM = 2
N_REPEATS = 10
N_FOLDS = 5
C0_ALPHA = 0.10  # not pinned by the task; documented choice, see report header


# ── Temperature fit: bit-for-bit port of calibrateBranchA.m ─────────────────
def mean_nll(logits, labels, T):
    s = logits / T
    s = s - s.max(axis=1, keepdims=True)
    logZ = np.log(np.exp(s).sum(axis=1))
    idx = labels.astype(int)
    true_logit = s[np.arange(len(labels)), idx]
    return float(-(true_logit - logZ).mean())


def fit_temperature(logits, labels):
    """Golden-section search over log(T) in [log(0.05), log(20)], minimising
    mean NLL -- same bounds, same recursion, same 200-iteration/1e-10 stop
    condition as calibrateBranchA.m's Task 2.5 cell."""
    phi = (np.sqrt(5) - 1) / 2
    a, b = np.log(0.05), np.log(20)
    c, d = b - phi * (b - a), a + phi * (b - a)
    fc, fd = mean_nll(logits, labels, np.exp(c)), mean_nll(logits, labels, np.exp(d))
    for _ in range(200):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - phi * (b - a)
            fc = mean_nll(logits, labels, np.exp(c))
        else:
            a, c, fc = c, d, fd
            d = a + phi * (b - a)
            fd = mean_nll(logits, labels, np.exp(d))
        if (b - a) < 1e-10:
            break
    return float(np.exp((a + b) / 2))


# ── Ordinal mode-interval score, vectorised (calibration-fitting side only;
#    inference-time scoring/tiering always goes through the imported
#    production assign_tier()/ordinal_mode_interval_score() instead) ────────
def predicted_mode(probs):
    """probs: (n,5). Ties broken to the HIGHER grade -- last index attaining
    the row max, matching ordinalModeIntervalScore.m exactly."""
    max_val = probs.max(axis=1, keepdims=True)
    is_max = probs == max_val
    rev_idx = is_max[:, ::-1].argmax(axis=1)   # first True from the right
    return NUM_CLASSES - 1 - rev_idx           # = last True from the left


def true_scores(probs, labels):
    """scores(i) = ordinal_mode_interval_score(probs[i])[trueGrade_i] for
    every i, vectorised. Matches conformalCalibrate.m's `trueScore` exactly
    (verified below against calibration_v1.json)."""
    n = probs.shape[0]
    mode = predicted_mode(probs)
    lo = np.minimum(mode, labels)
    hi = np.maximum(mode, labels)
    cdf = np.hstack([np.zeros((n, 1)), np.cumsum(probs, axis=1)])  # (n,6)
    return cdf[np.arange(n), hi + 1] - cdf[np.arange(n), lo], mode


# ── Generic Mondrian qhat fitter -- conformalCalibrate.m's algorithm,
#    parameterised by an arbitrary per-point group id ───────────────────────
def fit_group_qhat(scores_at_true, group_id, n_groups, alpha_per_group):
    qhat = np.zeros(n_groups)
    n_g = np.zeros(n_groups, dtype=int)
    rank_g = np.zeros(n_groups, dtype=int)
    saturated = np.zeros(n_groups, dtype=bool)
    for g in range(n_groups):
        mask = group_id == g
        nk = int(mask.sum())
        n_g[g] = nk
        alpha = alpha_per_group[g]
        rank = int(np.ceil((nk + 1) * (1 - alpha)))
        rank_g[g] = rank
        if nk == 0 or rank > nk:
            qhat[g] = 1.0
            saturated[g] = True
        else:
            qhat[g] = np.sort(scores_at_true[mask])[rank - 1]
    return qhat, n_g, rank_g, saturated


# ── Config definitions: each returns (qhatPerClass[5], n_g, rank_g, saturated,
#    group_labels_for_reporting) given the CALIBRATION half only ────────────
def config_C1(cal_probs, cal_labels):
    scores, _ = true_scores(cal_probs, cal_labels)
    alpha = np.array([0.10, 0.10, 0.10, 0.05, 0.05])
    qhat, n_g, rank_g, sat = fit_group_qhat(scores, cal_labels, 5, alpha)
    return qhat, n_g, rank_g, sat, alpha, [f"true_grade={k}" for k in range(5)]


def config_C2(cal_probs, cal_labels):
    scores, _ = true_scores(cal_probs, cal_labels)
    alpha = np.array([0.30, 0.30, 0.20, 0.05, 0.05])
    qhat, n_g, rank_g, sat = fit_group_qhat(scores, cal_labels, 5, alpha)
    return qhat, n_g, rank_g, sat, alpha, [f"true_grade={k}" for k in range(5)]


def config_C3(cal_probs, cal_labels):
    scores, mode = true_scores(cal_probs, cal_labels)
    alpha = np.array([0.10] * 5)
    qhat, n_g, rank_g, sat = fit_group_qhat(scores, mode, 5, alpha)
    return qhat, n_g, rank_g, sat, alpha, [f"pred_grade={k}" for k in range(5)]


def config_C4(cal_probs, cal_labels):
    scores, _ = true_scores(cal_probs, cal_labels)
    group = np.zeros(len(cal_labels), dtype=int)
    alpha = np.array([0.10])
    qhat_g, n_g, rank_g, sat = fit_group_qhat(scores, group, 1, alpha)
    qhat = np.repeat(qhat_g, 5)
    return qhat, np.repeat(n_g, 5), np.repeat(rank_g, 5), np.repeat(sat, 5), \
        np.repeat(alpha, 5), ["marginal_all"] * 5


def config_C5(cal_probs, cal_labels):
    scores, _ = true_scores(cal_probs, cal_labels)
    group = (cal_labels >= REFERABLE_FROM).astype(int)   # 0=nonref(0,1), 1=ref(2,3,4)
    alpha = np.array([0.30, 0.05])
    qhat_g, n_g, rank_g, sat = fit_group_qhat(scores, group, 2, alpha)
    slot_to_group = np.array([0, 0, 1, 1, 1])
    qhat = qhat_g[slot_to_group]
    return qhat, n_g[slot_to_group], rank_g[slot_to_group], sat[slot_to_group], \
        alpha[slot_to_group], ["nonreferable(0-1)", "nonreferable(0-1)",
                                "referable(2-4)", "referable(2-4)", "referable(2-4)"]


ORDINAL_CONFIGS = {
    "C1": config_C1, "C2": config_C2, "C3": config_C3,
    "C4": config_C4, "C5": config_C5,
}


# ── C0: legacy marginal LAC, non-contiguous, reference only ─────────────────
def config_C0_fit(cal_probs, cal_labels):
    true_probs = cal_probs[np.arange(len(cal_labels)), cal_labels]
    scores = 1.0 - true_probs
    n = len(cal_labels)
    rank = int(np.ceil((n + 1) * (1 - C0_ALPHA)))
    qhat = 1.0 if rank > n else float(np.sort(scores)[rank - 1])
    return qhat, n, rank


def c0_predict(probs_row, qhat):
    """Raw (possibly non-contiguous, possibly empty) LAC set. Empty sets are
    the old empty-set/'out-of-distribution' case conformalTiering.m's
    docstring refers to as the behaviour the ordinal method's mode-always-
    member rule replaced -- reproduced here, not patched, since C0 exists to
    show what that patch fixed."""
    in_set = [k for k in range(5) if (1.0 - probs_row[k]) <= qhat + 1e-9]
    if not in_set:
        return {"empty": True, "set": [], "low": None, "high": None, "tier": "C"}
    lo, hi = min(in_set), max(in_set)
    if hi < REFERABLE_FROM:
        tier = "A"
    elif lo >= REFERABLE_FROM:
        tier = "B"
    else:
        tier = "C"
    return {"empty": False, "set": in_set, "low": lo, "high": hi, "tier": tier}


# ── Stats ────────────────────────────────────────────────────────────────────
def mean_ci95_over_samples(values):
    """Mean and a t-based 95% CI over a list of per-fold (or per-repeat)
    values -- 'mean with 95% interval over repeats/folds', as specified."""
    values = np.asarray([v for v in values if np.isfinite(v)], dtype=float)
    n = len(values)
    if n == 0:
        return {"mean": float("nan"), "ci95": [float("nan"), float("nan")], "n_folds": 0}
    if n == 1:
        return {"mean": float(values[0]), "ci95": [float("nan"), float("nan")], "n_folds": 1}
    m = float(values.mean())
    se = float(values.std(ddof=1) / np.sqrt(n))
    tcrit = float(_t_dist.ppf(0.975, df=n - 1))
    return {"mean": m, "ci95": [m - tcrit * se, m + tcrit * se], "n_folds": n}


def wilson_ci(k, n, z=1.959963984540054):
    if n == 0:
        return (float("nan"), float("nan"))
    phat = k / n
    denom = 1 + z * z / n
    center = phat + z * z / (2 * n)
    adj = z * np.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n))
    return (float((center - adj) / denom), float((center + adj) / denom))


def rate_with_ci(k, n):
    lo, hi = wilson_ci(k, n)
    return {"k": int(k), "n": int(n), "rate": (k / n if n else float("nan")), "ci95": [lo, hi]}


# ── Per-point evaluation for one config on one (probs, labels) eval array ───
def evaluate_ordinal_config(eval_probs, eval_labels, qhat_per_class):
    calib = {"calibrated": True, "qhatPerClass": list(qhat_per_class), "referableFrom": REFERABLE_FROM}
    n = len(eval_labels)
    set_sizes = np.zeros(n, dtype=int)
    tiers = np.empty(n, dtype="<U1")
    los = np.zeros(n, dtype=int)
    his = np.zeros(n, dtype=int)
    for i in range(n):
        tier, pred_set, _reason, lo, hi, _contig = assign_tier(list(eval_probs[i]), calib)
        set_sizes[i] = len(pred_set)
        tiers[i] = tier
        los[i] = lo
        his[i] = hi
    return {"set_size": set_sizes, "tier": tiers, "low": los, "high": his}


def evaluate_c0(eval_probs, eval_labels, qhat):
    n = len(eval_labels)
    set_sizes = np.zeros(n, dtype=int)
    tiers = np.empty(n, dtype="<U1")
    los = np.full(n, -1, dtype=int)
    his = np.full(n, -1, dtype=int)
    empty = np.zeros(n, dtype=bool)
    for i in range(n):
        r = c0_predict(eval_probs[i], qhat)
        set_sizes[i] = len(r["set"])
        tiers[i] = r["tier"]
        empty[i] = r["empty"]
        los[i] = -1 if r["low"] is None else r["low"]
        his[i] = -1 if r["high"] is None else r["high"]
    return {"set_size": set_sizes, "tier": tiers, "low": los, "high": his, "empty": empty}


# ── Fold-level metric extraction (shared by cross-fit and old-protocol) ────
def fold_metrics(eval_out, eval_labels):
    n = len(eval_labels)
    tiers = eval_out["tier"]
    set_sizes = eval_out["set_size"]

    m = {}
    m["mean_set_size"] = float(set_sizes.mean())
    m["frac_size1"] = float((set_sizes == 1).mean())
    m["frac_size2"] = float((set_sizes == 2).mean())
    m["frac_size_ge3"] = float((set_sizes >= 3).mean())

    m["tierA_share"] = float((tiers == "A").mean())
    m["tierB_share"] = float((tiers == "B").mean())
    m["tierC_share"] = float((tiers == "C").mean())
    m["workload_tierC_share"] = m["tierC_share"]


    if "empty" in eval_out:
        m["frac_empty_set"] = float(eval_out["empty"].mean())
        covered = np.zeros(n, dtype=bool)
        for i in range(n):
            if eval_out["empty"][i]:
                covered[i] = False
            else:
                covered[i] = eval_out["low"][i] <= eval_labels[i] <= eval_out["high"][i]
    else:
        covered = (eval_out["low"] <= eval_labels) & (eval_labels <= eval_out["high"])
    m["coverage_marginal"] = float(covered.mean())

    m["coverage_per_grade"] = {}
    for k in range(5):
        mask = eval_labels == k
        nk = int(mask.sum())
        m["coverage_per_grade"][str(k)] = {
            "coverage": float(covered[mask].mean()) if nk else float("nan"), "n_k": nk,
        }

    # safety
    true_ref = eval_labels >= REFERABLE_FROM
    true_ge3 = eval_labels >= 3
    set_within_01 = (eval_out["high"] < REFERABLE_FROM) if "empty" not in eval_out else \
        np.array([(not eval_out["empty"][i]) and eval_out["high"][i] < REFERABLE_FROM for i in range(n)])

    n_ref = int(true_ref.sum())
    n_ge3 = int(true_ge3.sum())
    m["false_auto_clear_ref_k"] = int((true_ref & set_within_01).sum())
    m["false_auto_clear_ref_n"] = n_ref
    m["false_auto_clear_ref_rate"] = (m["false_auto_clear_ref_k"] / n_ref) if n_ref else float("nan")
    m["false_auto_clear_ge3_k"] = int((true_ge3 & set_within_01).sum())
    m["false_auto_clear_ge3_n"] = n_ge3
    m["false_auto_clear_ge3_rate"] = (m["false_auto_clear_ge3_k"] / n_ge3) if n_ge3 else float("nan")

    is_A = tiers == "A"
    n_A = int(is_A.sum())
    n_A_referable = int((is_A & true_ref).sum())
    m["tierA_count"] = n_A
    m["tierA_referable_k"] = n_A_referable
    m["tierA_referable_rate"] = (n_A_referable / n_A) if n_A else float("nan")

    return m


def aggregate_fold_metrics(fold_metric_list):
    keys_mean = ["mean_set_size", "frac_size1", "frac_size2", "frac_size_ge3",
                 "tierA_share", "tierB_share", "tierC_share", "workload_tierC_share",
                 "coverage_marginal", "false_auto_clear_ref_rate", "false_auto_clear_ge3_rate",
                 "tierA_referable_rate"]
    agg = {k: mean_ci95_over_samples([fm[k] for fm in fold_metric_list]) for k in keys_mean}

    if "frac_empty_set" in fold_metric_list[0]:
        agg["frac_empty_set"] = mean_ci95_over_samples(
            [fm["frac_empty_set"] for fm in fold_metric_list])

    agg["false_auto_clear_ref_counts"] = {
        "k_total": sum(fm["false_auto_clear_ref_k"] for fm in fold_metric_list),
        "n_total": sum(fm["false_auto_clear_ref_n"] for fm in fold_metric_list),
    }
    agg["false_auto_clear_ge3_counts"] = {
        "k_total": sum(fm["false_auto_clear_ge3_k"] for fm in fold_metric_list),
        "n_total": sum(fm["false_auto_clear_ge3_n"] for fm in fold_metric_list),
    }
    agg["tierA_referable_counts"] = {
        "k_total": sum(fm["tierA_referable_k"] for fm in fold_metric_list),
        "n_total": sum(fm["tierA_count"] for fm in fold_metric_list),
    }

    per_grade = {}
    for k in range(5):
        cov_vals = [fm["coverage_per_grade"][str(k)]["coverage"] for fm in fold_metric_list]
        n_ks = [fm["coverage_per_grade"][str(k)]["n_k"] for fm in fold_metric_list]
        per_grade[str(k)] = {"coverage": mean_ci95_over_samples(cov_vals),
                             "mean_n_k": float(np.mean(n_ks)), "total_n_k": int(np.sum(n_ks))}
    agg["coverage_per_grade"] = per_grade
    return agg


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    lines = []

    def out(s=""):
        print(s)
        lines.append(s)

    out("=" * 78)
    out("conformalPolicySweep.py -- v2a conformal policy sweep")
    out("=" * 78)

    # ── Validation gate ────────────────────────────────────────────────────
    out("\n" + "=" * 78)
    out("VALIDATION GATE: replica vs production (branchA_v1, calibration_v1.json)")
    out("=" * 78)
    v1_val_logits = np.load(os.path.join(MODEL1_DIR, "branchA_v1_val_logits.npy")).astype(np.float64)
    v1_val_labels = np.load(os.path.join(MODEL1_DIR, "branchA_v1_val_labels.npy")).astype(int)
    with open(CALIB_V1_JSON) as fh:
        ref = json.load(fh)

    T_replica = fit_temperature(v1_val_logits, v1_val_labels)
    probs_replica = _softmax(v1_val_logits / T_replica, axis=1)
    qhat_replica, n_g_replica, _, _, _, _ = config_C1(probs_replica, v1_val_labels)

    out(f"temperature: replica={T_replica:.6f}  production={ref['temperature']:.6f}  "
        f"diff={abs(T_replica - ref['temperature']):.2e}")
    out(f"nCalPerClass: replica={n_g_replica.tolist()}  production={ref['nCalPerClass']}")
    out(f"qhatPerClass: replica={np.round(qhat_replica, 6).tolist()}")
    out(f"              production={ref['qhatPerClass']}")

    T_ok = abs(T_replica - ref["temperature"]) < 1e-3
    n_ok = n_g_replica.tolist() == ref["nCalPerClass"]
    qhat_ok = bool(np.allclose(qhat_replica, ref["qhatPerClass"], atol=1e-4))
    out(f"\nT match (<1e-3): {T_ok}   nCalPerClass exact match: {n_ok}   "
        f"qhatPerClass match (<1e-4): {qhat_ok}")
    if not (T_ok and n_ok and qhat_ok):
        out("\nVALIDATION GATE FAILED -- refusing to trust downstream v2a numbers.")
        _write_outputs(lines, {"validation_gate": "FAILED"})
        return 1
    out("\nVALIDATION GATE PASSED. Proceeding with v2a.")

    # ── Load v2a arrays, pool ──────────────────────────────────────────────
    val_ids = np.load(os.path.join(V2A_DIR, "branchA_v2a_val_ids.npy"), allow_pickle=True)
    val_labels = np.load(os.path.join(V2A_DIR, "branchA_v2a_val_labels.npy")).astype(int)
    val_logits = np.load(os.path.join(V2A_DIR, "branchA_v2a_val_logits.npy")).astype(np.float64)
    test_ids = np.load(os.path.join(V2A_DIR, "branchA_v2a_test_ids.npy"), allow_pickle=True)
    test_labels = np.load(os.path.join(V2A_DIR, "branchA_v2a_test_labels.npy")).astype(int)
    test_logits = np.load(os.path.join(V2A_DIR, "branchA_v2a_test_logits.npy")).astype(np.float64)

    pool_ids = np.concatenate([val_ids, test_ids])
    pool_labels = np.concatenate([val_labels, test_labels])
    pool_logits = np.concatenate([val_logits, test_logits])
    out(f"\npooled val+test: n={len(pool_ids)}  "
        f"grade counts={dict(zip(*np.unique(pool_labels, return_counts=True)))}")

    # ── Cross-fit: 10 repeats x 5-fold, stratified by grade ────────────────
    out("\n" + "=" * 78)
    out(f"CROSS-FIT PROTOCOL: {N_REPEATS} repeats x {N_FOLDS}-fold, stratified")
    out("=" * 78)
    from sklearn.model_selection import StratifiedKFold

    ordinal_fold_metrics = {name: [] for name in ORDINAL_CONFIGS}
    ordinal_fold_qhat = {name: [] for name in ORDINAL_CONFIGS}
    ordinal_fold_ng = {name: [] for name in ORDINAL_CONFIGS}
    c0_fold_metrics = []
    n_folds_run = 0

    for repeat in range(N_REPEATS):
        skf = StratifiedKFold(n_splits=N_FOLDS, shuffle=True, random_state=repeat)
        for cal_idx, eval_idx in skf.split(pool_logits, pool_labels):
            cal_logits, cal_labels = pool_logits[cal_idx], pool_labels[cal_idx]
            eval_logits, eval_labels = pool_logits[eval_idx], pool_labels[eval_idx]

            T = fit_temperature(cal_logits, cal_labels)
            cal_probs = _softmax(cal_logits / T, axis=1)
            eval_probs = _softmax(eval_logits / T, axis=1)

            for name, fn in ORDINAL_CONFIGS.items():
                qhat, n_g, _rank, _sat, _alpha, _labels = fn(cal_probs, cal_labels)
                ev = evaluate_ordinal_config(eval_probs, eval_labels, qhat)
                ordinal_fold_metrics[name].append(fold_metrics(ev, eval_labels))
                ordinal_fold_qhat[name].append(qhat)
                ordinal_fold_ng[name].append(n_g)

            qhat0, n0, rank0 = config_C0_fit(cal_probs, cal_labels)
            ev0 = evaluate_c0(eval_probs, eval_labels, qhat0)
            c0_fold_metrics.append(fold_metrics(ev0, eval_labels))

            n_folds_run += 1

    out(f"\nran {n_folds_run} folds ({N_REPEATS} repeats x {N_FOLDS} folds).")

    cross_fit_results = {}
    for name in ORDINAL_CONFIGS:
        agg = aggregate_fold_metrics(ordinal_fold_metrics[name])
        agg["mean_qhatPerClass"] = np.mean(ordinal_fold_qhat[name], axis=0).tolist()
        agg["mean_nCalPerClass"] = np.mean(ordinal_fold_ng[name], axis=0).tolist()
        cross_fit_results[name] = agg
    cross_fit_results["C0"] = aggregate_fold_metrics(c0_fold_metrics)

    # ── Old protocol: fit on VAL, evaluate on TEST (production's own recipe) ─
    out("\n" + "=" * 78)
    out("OLD PROTOCOL (for comparison only): fit on VAL, evaluate on TEST")
    out("=" * 78)
    T_old = fit_temperature(val_logits, val_labels)
    val_probs_old = _softmax(val_logits / T_old, axis=1)
    test_probs_old = _softmax(test_logits / T_old, axis=1)
    out(f"temperature (val-fit): {T_old:.4f}")

    old_protocol_results = {}
    old_protocol_qhat = {}
    for name, fn in ORDINAL_CONFIGS.items():
        qhat, n_g, rank_g, sat, alpha, group_labels = fn(val_probs_old, val_labels)
        ev = evaluate_ordinal_config(test_probs_old, test_labels, qhat)
        old_protocol_results[name] = fold_metrics(ev, test_labels)
        old_protocol_qhat[name] = {"qhatPerClass": qhat.tolist(), "nCalPerClass": n_g.tolist(),
                                    "rankPerClass": rank_g.tolist(), "saturated": sat.tolist(),
                                    "alphaPerClass": alpha.tolist(), "groupLabels": group_labels}
        # item 4d: grade-4 tier distribution on the real, fixed TEST set
        g4_mask = test_labels == 4
        tiers_g4 = ev["tier"][g4_mask]
        old_protocol_results[name]["grade4_tier_distribution"] = {
            t: int((tiers_g4 == t).sum()) for t in ["A", "B", "C"]
        }
    qhat0_old, n0_old, rank0_old = config_C0_fit(val_probs_old, val_labels)
    ev0_old = evaluate_c0(test_probs_old, test_labels, qhat0_old)
    old_protocol_results["C0"] = fold_metrics(ev0_old, test_labels)
    g4_mask = test_labels == 4
    old_protocol_results["C0"]["grade4_tier_distribution"] = {
        t: int((ev0_old["tier"][g4_mask] == t).sum()) for t in ["A", "B", "C"]
    }

    # ── Print the table ─────────────────────────────────────────────────────
    out("\n" + "=" * 78)
    out("RESULTS TABLE (cross-fit: mean [95% CI]; old protocol: point estimate)")
    out("=" * 78)
    header = (f"{'cfg':>4} {'setSz':>16} {'sz1':>7} {'sz2':>7} {'sz>=3':>7} "
              f"{'TierA':>8} {'TierB':>8} {'TierC':>8} {'covMarg':>9} "
              f"{'FAC_ref':>9} {'FAC_ge3':>9} {'TierA_refRate':>13}")
    out(header)
    for name in ["C0", "C1", "C2", "C3", "C4", "C5"]:
        a = cross_fit_results[name]
        def cell(key):
            v = a[key]
            return f"{v['mean']:.3f}"
        out(f"{name:>4} "
            f"{cell('mean_set_size'):>16} {cell('frac_size1'):>7} {cell('frac_size2'):>7} "
            f"{cell('frac_size_ge3'):>7} {cell('tierA_share'):>8} {cell('tierB_share'):>8} "
            f"{cell('tierC_share'):>8} {cell('coverage_marginal'):>9} "
            f"{cell('false_auto_clear_ref_rate'):>9} {cell('false_auto_clear_ge3_rate'):>9} "
            f"{cell('tierA_referable_rate'):>13}")

    out("\n-- cross-fit 95% CIs on the headline safety/workload metrics (mean over 50 folds) --")
    for name in ["C0", "C1", "C2", "C3", "C4", "C5"]:
        a = cross_fit_results[name]
        def ci_str(key):
            v = a[key]
            return f"{v['mean']:.4f} [{v['ci95'][0]:.4f},{v['ci95'][1]:.4f}]"
        out(f"  {name}: mean_set_size={ci_str('mean_set_size')}  "
            f"tierC_share={ci_str('tierC_share')}")
        out(f"       false_auto_clear_ref={ci_str('false_auto_clear_ref_rate')} "
            f"({a['false_auto_clear_ref_counts']['k_total']}/{a['false_auto_clear_ref_counts']['n_total']} pooled)  "
            f"false_auto_clear_ge3={ci_str('false_auto_clear_ge3_rate')} "
            f"({a['false_auto_clear_ge3_counts']['k_total']}/{a['false_auto_clear_ge3_counts']['n_total']} pooled)")
        out(f"       tierA_referable_rate={ci_str('tierA_referable_rate')} "
            f"({a['tierA_referable_counts']['k_total']}/{a['tierA_referable_counts']['n_total']} pooled)  "
            f"coverage_marginal={ci_str('coverage_marginal')}")

    out("\n-- old protocol (val-fit / test-eval), for comparison --")
    out(header)
    for name in ["C0", "C1", "C2", "C3", "C4", "C5"]:
        m = old_protocol_results[name]
        out(f"{name:>4} "
            f"{m['mean_set_size']:>16.3f} {m['frac_size1']:>7.3f} {m['frac_size2']:>7.3f} "
            f"{m['frac_size_ge3']:>7.3f} {m['tierA_share']:>8.3f} {m['tierB_share']:>8.3f} "
            f"{m['tierC_share']:>8.3f} {m['coverage_marginal']:>9.3f} "
            f"{m['false_auto_clear_ref_rate']:>9.3f} {m['false_auto_clear_ge3_rate']:>9.3f} "
            f"{m['tierA_referable_rate']:>13.3f}")

    out("\n-- grade-4 (54 cases in TEST) Tier distribution, old protocol only "
        "(the only protocol with a fixed, well-defined TEST cohort) --")
    for name in ["C0", "C1", "C2", "C3", "C4", "C5"]:
        out(f"  {name}: {old_protocol_results[name]['grade4_tier_distribution']}")

    out("\nNote: Tier conditions NOT evaluable here (unavailable inputs): branch "
        "disagreement override (no Branch B run), quality-forced override (no "
        "quality-gate worker flag), and the MC-Dropout uncertainty withhold on "
        "Tier A (would need a fresh forward pass per case with dropout enabled, "
        "which these saved arrays do not support). All three are left at their "
        "production defaults (None/False), matching the normal case where "
        "Branch B has not run.")

    c0_empty = cross_fit_results["C0"].get("frac_empty_set", {"mean": float("nan"), "ci95": [float("nan")] * 2})
    out("\nNote on C0's coverage/safety numbers: C0's prediction set can be "
        "non-contiguous or EMPTY (the pre-ordinal-method behaviour). Coverage "
        "and the 'set entirely within {0,1}' safety check both use the raw "
        "set's [low,high] envelope (an empty set is never counted as covering, "
        f"never counted as Tier A auto-clear). Cross-fit fraction of empty C0 "
        f"sets: {c0_empty['mean']:.4f} [{c0_empty['ci95'][0]:.4f},{c0_empty['ci95'][1]:.4f}]. "
        "This is C0-specific and does not apply to C1-C5, which are never "
        "empty by construction (mode is always a member).")

    # ── Decision rule (pre-declared; cross-fit only; C1-C5, C0 excluded) ───
    out("\n" + "=" * 78)
    out("DECISION RULE (pre-declared, applied to CROSS-FIT results, C1-C5 only)")
    out("eligible = false_auto_clear_ref<=5% AND false_auto_clear_ge3<=2% AND mean_set_size<=2.5")
    out("=" * 78)
    eligible = []
    for name in ["C1", "C2", "C3", "C4", "C5"]:
        a = cross_fit_results[name]
        fac_ref = a["false_auto_clear_ref_rate"]["mean"]
        fac_ge3 = a["false_auto_clear_ge3_rate"]["mean"]
        mss = a["mean_set_size"]["mean"]
        is_eligible = (fac_ref <= 0.05) and (fac_ge3 <= 0.02) and (mss <= 2.5)
        eligible.append((name, is_eligible, fac_ref, fac_ge3, mss, a["tierC_share"]["mean"]))
        out(f"  {name}: fac_ref={fac_ref:.4f} (<=0.05? {fac_ref <= 0.05})  "
            f"fac_ge3={fac_ge3:.4f} (<=0.02? {fac_ge3 <= 0.02})  "
            f"mean_set_size={mss:.4f} (<=2.5? {mss <= 2.5})  -> eligible={is_eligible}")

    eligible_names = [e[0] for e in eligible if e[1]]
    if eligible_names:
        ranking = sorted([e for e in eligible if e[1]], key=lambda e: e[5])
        out(f"\nEligible: {eligible_names}")
        out("Ranked by lowest cross-fit Tier C share (workload), best first:")
        for name, _elig, fac_ref, fac_ge3, mss, tierc in ranking:
            out(f"  {name}: TierC share={tierc:.4f}  (fac_ref={fac_ref:.4f}, "
                f"fac_ge3={fac_ge3:.4f}, mean_set_size={mss:.4f})")
        top_config = ranking[0][0]
    else:
        out("\nNo config is eligible under the pre-declared rule. Ranking by "
            "false auto-clear (referable) instead, ascending:")
        ranking = sorted(eligible, key=lambda e: e[2])
        for name, _elig, fac_ref, fac_ge3, mss, tierc in ranking:
            out(f"  {name}: fac_ref={fac_ref:.4f}  (fac_ge3={fac_ge3:.4f}, "
                f"mean_set_size={mss:.4f}, TierC share={tierc:.4f})")
        top_config = ranking[0][0]

    out(f"\nNo winner is installed in code. Top-ranked by this rule: {top_config} "
        f"(informational only).")

    # ── Per-class qhat/n_k report: C1 and the top-ranked config ────────────
    out("\n" + "=" * 78)
    out(f"PER-CLASS qhat / n_k: C1 and top-ranked ({top_config})")
    out("=" * 78)
    for name in sorted({"C1", top_config}):
        a = cross_fit_results[name]
        out(f"\n-- {name} (cross-fit mean over {N_REPEATS * N_FOLDS} folds) --")
        out(f"  mean qhatPerClass:      {[round(v, 4) for v in a['mean_qhatPerClass']]}")
        out(f"  mean nCalPerClass:      {[round(v, 1) for v in a['mean_nCalPerClass']]}")
        out(f"  old-protocol qhatPerClass: {[round(v, 4) for v in old_protocol_qhat[name]['qhatPerClass']]}")
        out(f"  old-protocol nCalPerClass: {old_protocol_qhat[name]['nCalPerClass']}")
        out(f"  old-protocol group labels: {old_protocol_qhat[name]['groupLabels']}")
        out(f"  old-protocol saturated:    {old_protocol_qhat[name]['saturated']}")

    # ── Write outputs ────────────────────────────────────────────────────────
    report = {
        "validation_gate": "PASSED",
        "validation_gate_detail": {
            "temperature_replica": T_replica, "temperature_production": ref["temperature"],
            "qhatPerClass_replica": qhat_replica.tolist(),
            "qhatPerClass_production": ref["qhatPerClass"],
        },
        "n_folds_run": n_folds_run,
        "cross_fit_results": cross_fit_results,
        "old_protocol_results": old_protocol_results,
        "old_protocol_qhat": old_protocol_qhat,
        "decision_rule": {
            "eligible": eligible_names,
            "ranking": [{"config": e[0], "eligible": e[1], "false_auto_clear_ref": e[2],
                        "false_auto_clear_ge3": e[3], "mean_set_size": e[4],
                        "tierC_share": e[5]} for e in ranking],
            "top_config": top_config,
        },
        "c0_alpha_assumption": C0_ALPHA,
    }
    _write_outputs(lines, report)
    return 0


def _write_outputs(lines, report):
    os.makedirs(OUT_DIR, exist_ok=True)
    json_path = os.path.join(OUT_DIR, "conformal_policy_sweep.json")
    txt_path = os.path.join(OUT_DIR, "conformal_policy_sweep.txt")

    def _default(o):
        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
        raise TypeError(f"Object of type {o.__class__.__name__} is not JSON serializable")

    with open(json_path, "w") as fh:
        json.dump(report, fh, indent=2, default=_default)
    with open(txt_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"\nWrote {json_path}")
    print(f"Wrote {txt_path}")


if __name__ == "__main__":
    raise SystemExit(main())
