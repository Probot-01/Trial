

import json
import os
import sys

import numpy as np
from scipy.special import softmax as _softmax
from scipy.stats import t as _t_dist

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)

V2A_DIR = os.path.join(ML_ROOT, "models", "Model1", "v2a")
MODEL1_DIR = os.path.join(ML_ROOT, "models", "Model1")
CALIB_V1_JSON = os.path.join(ML_ROOT, "models", "calibration_v1.json")
OUT_DIR = os.path.join(ML_ROOT, "diagnostics", "out")
SWEEP1_JSON = os.path.join(OUT_DIR, "conformal_policy_sweep.json")

NUM_CLASSES = 5
REFERABLE_FROM = 2
N_REPEATS = 10
N_FOLDS = 5
C0_ALPHA = 0.10  # same documented assumption as conformalPolicySweep.py
ALPHA_REF_OPTIONS = [0.02, 0.03, 0.05]
EPS = 1e-9


# ── Temperature fit: bit-for-bit port of calibrateBranchA.m (same algorithm
#    as conformalPolicySweep.py's fit_temperature -- independently re-typed
#    here rather than imported, see module docstring) ───────────────────────
def mean_nll(logits, labels, T):
    s = logits / T
    s = s - s.max(axis=1, keepdims=True)
    logZ = np.log(np.exp(s).sum(axis=1))
    idx = labels.astype(int)
    true_logit = s[np.arange(len(labels)), idx]
    return float(-(true_logit - logZ).mean())


def fit_temperature(logits, labels):
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


# ── Mode, ties to the higher grade ──────────────────────────────────────────
def predicted_mode(probs):
    max_val = probs.max(axis=1, keepdims=True)
    is_max = probs == max_val
    rev_idx = is_max[:, ::-1].argmax(axis=1)
    return NUM_CLASSES - 1 - rev_idx


# ── Scores, vectorised (calibration-fitting side: score at the TRUE grade) ──
def true_scores_old(probs, labels):
    """THE DEFECTIVE SCORE -- s(k) = interval mass mode..k INCLUDING k's own
    mass. s(mode) = p(mode), close to 1 for confident-correct cases. Used
    ONLY for the Step-1 reproduction check; never used for the real v3
    configs below."""
    n = probs.shape[0]
    mode = predicted_mode(probs)
    lo = np.minimum(mode, labels)
    hi = np.maximum(mode, labels)
    cdf = np.hstack([np.zeros((n, 1)), np.cumsum(probs, axis=1)])
    return cdf[np.arange(n), hi + 1] - cdf[np.arange(n), lo], mode


def true_scores_v3(probs, labels):
    """CORRECTED SCORE -- s(mode)=0; s(k)= interval mass mode..k MINUS p_k."""
    n = probs.shape[0]
    mode = predicted_mode(probs)
    lo = np.minimum(mode, labels)
    hi = np.maximum(mode, labels)
    cdf = np.hstack([np.zeros((n, 1)), np.cumsum(probs, axis=1)])
    interval = cdf[np.arange(n), hi + 1] - cdf[np.arange(n), lo]
    p_true = probs[np.arange(n), labels]
    return interval - p_true, mode


# ── Scores, single-row (inference-time: score at EVERY candidate k) ────────
def row_scores_old(probs_row):
    """Local copy of branchAInfer.ordinal_mode_interval_score() (the
    production, defective score) -- used ONLY inside the Step-1 reproduction
    harness so that harness can be run with either score via one parameter."""
    p = np.asarray(probs_row, dtype=float)
    max_val = p.max()
    mode = int(np.max(np.nonzero(p == max_val)[0]))
    scores = np.zeros(NUM_CLASSES)
    for k in range(NUM_CLASSES):
        lo, hi = (mode, k) if mode <= k else (k, mode)
        scores[k] = p[lo:hi + 1].sum()
    return scores, mode


def row_scores_v3(probs_row):
    """CORRECTED SCORE, per-candidate -- s(mode)=0, s(k)=interval-p_k."""
    p = np.asarray(probs_row, dtype=float)
    max_val = p.max()
    mode = int(np.max(np.nonzero(p == max_val)[0]))
    scores = np.zeros(NUM_CLASSES)
    for k in range(NUM_CLASSES):
        if k == mode:
            scores[k] = 0.0
            continue
        lo, hi = (mode, k) if mode <= k else (k, mode)
        scores[k] = p[lo:hi + 1].sum() - p[k]
    return scores, mode


# ── Generic Mondrian qhat fitter (conformalCalibrate.m's algorithm) ────────
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


# ── Config fitting, parameterised by which true_scores_* function to use ──
def config_C1(cal_probs, cal_labels, score_fn):
    scores, _ = score_fn(cal_probs, cal_labels)
    alpha = np.array([0.10, 0.10, 0.10, 0.05, 0.05])
    qhat, n_g, rank_g, sat = fit_group_qhat(scores, cal_labels, 5, alpha)
    return qhat, n_g, rank_g, sat, alpha, [f"true_grade={k}" for k in range(5)]


def config_C2(cal_probs, cal_labels, score_fn):
    scores, _ = score_fn(cal_probs, cal_labels)
    alpha = np.array([0.30, 0.30, 0.20, 0.05, 0.05])
    qhat, n_g, rank_g, sat = fit_group_qhat(scores, cal_labels, 5, alpha)
    return qhat, n_g, rank_g, sat, alpha, [f"true_grade={k}" for k in range(5)]


def config_C4(cal_probs, cal_labels, score_fn):
    scores, _ = score_fn(cal_probs, cal_labels)
    group = np.zeros(len(cal_labels), dtype=int)
    alpha = np.array([0.10])
    qhat_g, n_g, rank_g, sat = fit_group_qhat(scores, group, 1, alpha)
    qhat = np.repeat(qhat_g, 5)
    return qhat, np.repeat(n_g, 5), np.repeat(rank_g, 5), np.repeat(sat, 5), \
        np.repeat(alpha, 5), ["marginal_all"] * 5


def config_C5(cal_probs, cal_labels, score_fn):
    scores, _ = score_fn(cal_probs, cal_labels)
    group = (cal_labels >= REFERABLE_FROM).astype(int)
    alpha = np.array([0.30, 0.05])
    qhat_g, n_g, rank_g, sat = fit_group_qhat(scores, group, 2, alpha)
    slot_to_group = np.array([0, 0, 1, 1, 1])
    qhat = qhat_g[slot_to_group]
    return qhat, n_g[slot_to_group], rank_g[slot_to_group], sat[slot_to_group], \
        alpha[slot_to_group], ["nonreferable(0-1)", "nonreferable(0-1)",
                                "referable(2-4)", "referable(2-4)", "referable(2-4)"]


V3_CONFIGS = {"C1v3": config_C1, "C2v3": config_C2, "C4v3": config_C4, "C5v3": config_C5}


# ── C0: legacy marginal LAC, + hull for size stats ──────────────────────────
def config_C0_fit(cal_probs, cal_labels):
    true_probs = cal_probs[np.arange(len(cal_labels)), cal_labels]
    scores = 1.0 - true_probs
    n = len(cal_labels)
    rank = int(np.ceil((n + 1) * (1 - C0_ALPHA)))
    qhat = 1.0 if rank > n else float(np.sort(scores)[rank - 1])
    return qhat, n, rank


def c0_predict_hulled(probs_row, qhat):
    in_set = [k for k in range(NUM_CLASSES) if (1.0 - probs_row[k]) <= qhat + EPS]
    if not in_set:
        return {"empty": True, "set": [], "low": None, "high": None, "tier": "C"}
    lo, hi = min(in_set), max(in_set)
    hulled = list(range(lo, hi + 1))  # the "+ hull" this script adds over sweep 1
    if hi < REFERABLE_FROM:
        tier = "A"
    elif lo >= REFERABLE_FROM:
        tier = "B"
    else:
        tier = "C"
    return {"empty": False, "set": hulled, "low": lo, "high": hi, "tier": tier}


# ── Generic ordinal tiering -- reproduces branchAInfer.assign_tier()'s
#    algorithm exactly, parameterised by the row-score function, since
#    assign_tier() itself is hardwired to the old score and is production
#    code this task must not modify ─────────────────────────────────────────
def assign_tier_ordinal(probs_row, qhat_per_class, row_score_fn):
    scores, mode = row_score_fn(probs_row)
    in_set = {k for k in range(NUM_CLASSES) if scores[k] <= qhat_per_class[k] + EPS}
    in_set.add(mode)
    lo, hi = min(in_set), max(in_set)
    pred_set = list(range(lo, hi + 1))
    if hi < REFERABLE_FROM:
        tier = "A"
    elif lo >= REFERABLE_FROM:
        tier = "B"
    else:
        tier = "C"
    return tier, pred_set, lo, hi


def evaluate_ordinal_config(eval_probs, eval_labels, qhat_per_class, row_score_fn):
    n = len(eval_labels)
    set_sizes = np.zeros(n, dtype=int)
    tiers = np.empty(n, dtype="<U1")
    los = np.zeros(n, dtype=int)
    his = np.zeros(n, dtype=int)
    for i in range(n):
        tier, pred_set, lo, hi = assign_tier_ordinal(eval_probs[i], qhat_per_class, row_score_fn)
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
        r = c0_predict_hulled(eval_probs[i], qhat)
        set_sizes[i] = len(r["set"])
        tiers[i] = r["tier"]
        empty[i] = r["empty"]
        los[i] = -1 if r["low"] is None else r["low"]
        his[i] = -1 if r["high"] is None else r["high"]
    return {"set_size": set_sizes, "tier": tiers, "low": los, "high": his, "empty": empty}


# ── C6: referable-safety gate fit + apply, on top of C4v3's tiering ─────────
def fit_referable_gate_tau(cal_probs, cal_labels, alpha_ref):
    ref_mask = cal_labels >= REFERABLE_FROM
    p_ref = cal_probs[ref_mask, 2:5].sum(axis=1)
    n = len(p_ref)
    if n == 0:
        return 0.0, 0, 0, True  # cannot fit at all; strict fallback, flagged
    rank = int(np.ceil((n + 1) * alpha_ref))
    if rank > n:
        return 0.0, n, rank, True  # saturated: strict fallback (see module docstring)
    tau = float(np.sort(p_ref)[rank - 1])
    return tau, n, rank, False


def evaluate_c6(eval_probs, eval_labels, qhat_c4v3, tau):
    """Base tier/set from C4v3 (row_scores_v3, qhat_c4v3); Tier-A cases with
    P(g>=2) > tau are demoted to B. Tier B/C and the reported set are
    otherwise identical to C4v3 -- the gate only ever removes Tier-A status,
    it never changes the prediction SET itself (that would need re-running
    conformal set construction, which is not what a downstream safety gate
    on the TIER is meant to do)."""
    n = len(eval_labels)
    set_sizes = np.zeros(n, dtype=int)
    tiers = np.empty(n, dtype="<U1")
    los = np.zeros(n, dtype=int)
    his = np.zeros(n, dtype=int)
    demoted = np.zeros(n, dtype=bool)
    p_ref_all = eval_probs[:, 2:5].sum(axis=1)
    for i in range(n):
        tier, pred_set, lo, hi = assign_tier_ordinal(eval_probs[i], qhat_c4v3, row_scores_v3)
        if tier == "A" and p_ref_all[i] > tau + EPS:
            tier = "B"
            demoted[i] = True
        set_sizes[i] = len(pred_set)
        tiers[i] = tier
        los[i] = lo
        his[i] = hi
    return {"set_size": set_sizes, "tier": tiers, "low": los, "high": his,
            "p_ref": p_ref_all, "demoted": demoted}


# ── Stats (independently re-typed, see module docstring) ───────────────────
def mean_ci95_over_samples(values):
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


# ── Per-fold metric extraction (same definitions as conformalPolicySweep.py,
#    re-typed here for the same reason as everything else above) ───────────
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

    if "empty" in eval_out:
        m["frac_empty_set"] = float(eval_out["empty"].mean())
        covered = np.zeros(n, dtype=bool)
        for i in range(n):
            covered[i] = (not eval_out["empty"][i]) and \
                (eval_out["low"][i] <= eval_labels[i] <= eval_out["high"][i])
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

    true_ref = eval_labels >= REFERABLE_FROM
    true_ge3 = eval_labels >= 3
    if "empty" in eval_out:
        set_within_01 = np.array([(not eval_out["empty"][i]) and eval_out["high"][i] < REFERABLE_FROM
                                   for i in range(n)])
    else:
        set_within_01 = eval_out["high"] < REFERABLE_FROM

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
                 "tierA_share", "tierB_share", "tierC_share",
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


def unit_tests_v3_score():

    cases = []

    cases.append(("one_hot_grade0", [1, 0, 0, 0, 0], [0, 1, 1, 1, 1], 0))

 
    cases.append(("bimodal_mode_high", [0.45, 0, 0, 0.05, 0.5],
                  [0.55, 0.55, 0.55, 0.5, 0.0], 4))

    cases.append(("uniform_tie_to_highest", [0.2, 0.2, 0.2, 0.2, 0.2],
                  [0.8, 0.6, 0.4, 0.2, 0.0], 4))


    cases.append(("asymmetric_mode_middle", [0.05, 0.10, 0.60, 0.15, 0.10],
                  [0.70, 0.60, 0.0, 0.60, 0.75], 2))

    print("\n" + "=" * 78)
    print("UNIT TESTS: v3 score, hand-worked vectors")
    print("=" * 78)
    n_fail = 0
    for name, probs, expected, expected_mode in cases:
        probs = np.array(probs, dtype=float)
        scores, mode = row_scores_v3(probs)
        ok_scores = np.allclose(scores, expected, atol=1e-9)
        ok_mode = (mode == expected_mode)
        status = "PASS" if (ok_scores and ok_mode) else "FAIL"
        if status == "FAIL":
            n_fail += 1
        print(f"  {status}  {name}: probs={probs.tolist()}")
        print(f"        expected scores={expected}  mode={expected_mode}")
        print(f"        got      scores={np.round(scores, 6).tolist()}  mode={int(mode)}")
        # monotonicity property, independent of the hand-worked numbers:
        # moving away from the mode on either side must never decrease s.
        mono_ok = True
        for k in range(mode, NUM_CLASSES - 1):
            if scores[k + 1] < scores[k] - 1e-12:
                mono_ok = False
        for k in range(mode, 0, -1):
            if scores[k - 1] < scores[k] - 1e-12:
                mono_ok = False
        if not mono_ok:
            n_fail += 1
            print(f"        FAIL  monotonicity away from the mode violated")
    if n_fail:
        raise AssertionError(f"{n_fail} v3-score unit test(s) failed")
    print(f"\nAll {len(cases)} hand-worked v3-score vectors passed (scores + mode + monotonicity).")


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    lines = []

    def out(s=""):
        print(s)
        lines.append(s)

    out("=" * 78)
    out("conformalPolicySweep2.py -- corrected (v3) score + C6 safety gate")
    out("=" * 78)

    # ── Unit tests (task item 1, hand-worked vectors) ──────────────────────
    try:
        unit_tests_v3_score()
    except AssertionError as exc:
        out(f"\nUNIT TESTS FAILED: {exc}")
        out("Stopping -- refusing to trust anything computed with a score that "
            "fails its own hand-worked vectors.")
        _write_outputs(lines, {"status": "UNIT_TESTS_FAILED"})
        return 1


    out("\n" + "=" * 78)
    out("VALIDATION GATE 0: replica vs production (branchA_v1, calibration_v1.json)")
    out("=" * 78)
    v1_val_logits = np.load(os.path.join(MODEL1_DIR, "branchA_v1_val_logits.npy")).astype(np.float64)
    v1_val_labels = np.load(os.path.join(MODEL1_DIR, "branchA_v1_val_labels.npy")).astype(int)
    with open(CALIB_V1_JSON) as fh:
        ref = json.load(fh)

    T_replica = fit_temperature(v1_val_logits, v1_val_labels)
    probs_replica = _softmax(v1_val_logits / T_replica, axis=1)
    qhat_replica, n_g_replica, _, _, _, _ = config_C1(probs_replica, v1_val_labels, true_scores_old)

    out(f"temperature: replica={T_replica:.6f}  production={ref['temperature']:.6f}")
    T_ok = abs(T_replica - ref["temperature"]) < 1e-3
    n_ok = n_g_replica.tolist() == ref["nCalPerClass"]
    qhat_ok = bool(np.allclose(qhat_replica, ref["qhatPerClass"], atol=1e-4))
    out(f"T match (<1e-3): {T_ok}   nCalPerClass exact match: {n_ok}   "
        f"qhatPerClass match (<1e-4): {qhat_ok}")
    if not (T_ok and n_ok and qhat_ok):
        out("\nVALIDATION GATE 0 FAILED -- refusing to trust downstream numbers.")
        _write_outputs(lines, {"status": "VALIDATION_GATE_0_FAILED"})
        return 1
    out("VALIDATION GATE 0 PASSED.")

    # ── Load and pool v2a val+test (identical pooling order to sweep 1) ────
    val_labels = np.load(os.path.join(V2A_DIR, "branchA_v2a_val_labels.npy")).astype(int)
    val_logits = np.load(os.path.join(V2A_DIR, "branchA_v2a_val_logits.npy")).astype(np.float64)
    test_labels = np.load(os.path.join(V2A_DIR, "branchA_v2a_test_labels.npy")).astype(int)
    test_logits = np.load(os.path.join(V2A_DIR, "branchA_v2a_test_logits.npy")).astype(np.float64)

    pool_labels = np.concatenate([val_labels, test_labels])
    pool_logits = np.concatenate([val_logits, test_logits])
    out(f"\npooled val+test: n={len(pool_labels)}  "
        f"grade counts={dict(zip(*np.unique(pool_labels, return_counts=True)))}")

    from sklearn.model_selection import StratifiedKFold

    def run_cross_fit(score_fn_for_true, row_score_fn, configs):
        """One full 10x5 cross-fit pass for the given ordinal configs, using
        score_fn_for_true (vectorised, at the true grade, for FITTING) and
        row_score_fn (per-row, all 5 candidates, for EVALUATING/tiering).
        Returns per-config aggregated metrics, plus the raw per-fold list
        (needed by C6, which reuses C4's per-fold qhat)."""
        fold_metrics_by_cfg = {name: [] for name in configs}
        fold_qhat_by_cfg = {name: [] for name in configs}
        fold_ng_by_cfg = {name: [] for name in configs}
        fold_indices = []  # (cal_idx, eval_idx) per fold, for C6 to reuse
        n_folds_run = 0
        for repeat in range(N_REPEATS):
            skf = StratifiedKFold(n_splits=N_FOLDS, shuffle=True, random_state=repeat)
            for cal_idx, eval_idx in skf.split(pool_logits, pool_labels):
                cal_logits, cal_labels = pool_logits[cal_idx], pool_labels[cal_idx]
                eval_logits, eval_labels = pool_logits[eval_idx], pool_labels[eval_idx]
                T = fit_temperature(cal_logits, cal_labels)
                cal_probs = _softmax(cal_logits / T, axis=1)
                eval_probs = _softmax(eval_logits / T, axis=1)

                for name, fn in configs.items():
                    qhat, n_g, _rank, _sat, _alpha, _labels = fn(cal_probs, cal_labels, score_fn_for_true)
                    ev = evaluate_ordinal_config(eval_probs, eval_labels, qhat, row_score_fn)
                    fold_metrics_by_cfg[name].append(fold_metrics(ev, eval_labels))
                    fold_qhat_by_cfg[name].append(qhat)
                    fold_ng_by_cfg[name].append(n_g)

                fold_indices.append((cal_idx, eval_idx))
                n_folds_run += 1

        results = {}
        for name in configs:
            agg = aggregate_fold_metrics(fold_metrics_by_cfg[name])
            agg["mean_qhatPerClass"] = np.mean(fold_qhat_by_cfg[name], axis=0).tolist()
            agg["mean_nCalPerClass"] = np.mean(fold_ng_by_cfg[name], axis=0).tolist()
            results[name] = agg
        return results, fold_indices, fold_qhat_by_cfg

    # ── STEP 1: reproduce sweep 1's C1 with the OLD score ──────────────────
    out("\n" + "=" * 78)
    out("STEP 1: reproduce conformal_policy_sweep.json's C1 with the OLD score")
    out(f"({N_REPEATS} repeats x {N_FOLDS}-fold, same StratifiedKFold(random_state=repeat), "
        "same val-then-test pooling order)")
    out("=" * 78)
    if not os.path.exists(SWEEP1_JSON):
        out(f"\n{SWEEP1_JSON} not found -- cannot verify reproduction. Stopping.")
        _write_outputs(lines, {"status": "SWEEP1_JSON_MISSING"})
        return 1
    with open(SWEEP1_JSON) as fh:
        sweep1 = json.load(fh)
    sweep1_c1 = sweep1["cross_fit_results"]["C1"]

    old_score_results, _fold_idx_unused, _q_unused = run_cross_fit(
        true_scores_old, row_scores_old, {"C1": config_C1})
    my_c1 = old_score_results["C1"]

    def close(a, b, atol=1e-6, rtol=1e-3):
        return abs(a - b) <= max(atol, rtol * abs(b))

    checks = [
        ("mean_set_size", my_c1["mean_set_size"]["mean"], sweep1_c1["mean_set_size"]["mean"]),
        ("coverage_marginal", my_c1["coverage_marginal"]["mean"], sweep1_c1["coverage_marginal"]["mean"]),
        ("tierA_share", my_c1["tierA_share"]["mean"], sweep1_c1["tierA_share"]["mean"]),
        ("tierB_share", my_c1["tierB_share"]["mean"], sweep1_c1["tierB_share"]["mean"]),
        ("tierC_share", my_c1["tierC_share"]["mean"], sweep1_c1["tierC_share"]["mean"]),
        ("false_auto_clear_ref_rate", my_c1["false_auto_clear_ref_rate"]["mean"],
         sweep1_c1["false_auto_clear_ref_rate"]["mean"]),
    ]
    all_ok = True
    for name, mine, theirs in checks:
        ok = close(mine, theirs)
        all_ok = all_ok and ok
        out(f"  {name}: this script={mine:.6f}  sweep1={theirs:.6f}  match={ok}")
    qhat_close = np.allclose(my_c1["mean_qhatPerClass"], sweep1_c1["mean_qhatPerClass"], atol=1e-3)
    all_ok = all_ok and qhat_close
    out(f"  mean_qhatPerClass: this script={[round(v,4) for v in my_c1['mean_qhatPerClass']]}")
    out(f"                     sweep1={[round(v,4) for v in sweep1_c1['mean_qhatPerClass']]}")
    out(f"                     match={qhat_close}")

    if not all_ok:
        out("\nSTEP 1 REPRODUCTION FAILED -- the harness itself does not agree with "
            "sweep 1 under the old score. Stopping before trusting any v3 numbers.")
        _write_outputs(lines, {"status": "STEP1_REPRODUCTION_FAILED"})
        return 1
    out("\nSTEP 1 PASSED: old-score reproduction matches sweep 1. Switching to v3.")

    # ── v3 cross-fit: C1v3, C2v3, C4v3, C5v3 ───────────────────────────────
    out("\n" + "=" * 78)
    out(f"V3 CROSS-FIT: {N_REPEATS} repeats x {N_FOLDS}-fold, corrected score")
    out("=" * 78)
    v3_results, fold_indices, fold_qhat_by_cfg = run_cross_fit(
        true_scores_v3, row_scores_v3, V3_CONFIGS)
    out(f"ran {len(fold_indices)} folds.")

    # ── C0 (unaffected by the score fix; + hull, see module docstring) ─────
    c0_fold_metrics = []
    for cal_idx, eval_idx in fold_indices:
        cal_logits, cal_labels = pool_logits[cal_idx], pool_labels[cal_idx]
        eval_logits, eval_labels = pool_logits[eval_idx], pool_labels[eval_idx]
        T = fit_temperature(cal_logits, cal_labels)
        cal_probs = _softmax(cal_logits / T, axis=1)
        eval_probs = _softmax(eval_logits / T, axis=1)
        qhat0, _n0, _rank0 = config_C0_fit(cal_probs, cal_labels)
        ev0 = evaluate_c0(eval_probs, eval_labels, qhat0)
        c0_fold_metrics.append(fold_metrics(ev0, eval_labels))
    v3_results["C0"] = aggregate_fold_metrics(c0_fold_metrics)

    # ── SANITY GATE (task item 5): C4v3 marginal coverage ~88-93% ──────────
    c4v3_cov = v3_results["C4v3"]["coverage_marginal"]["mean"]
    out("\n" + "=" * 78)
    out("SANITY GATE: C4v3 marginal coverage should be ~88-93% (alpha=0.10 target ~90%)")
    out("=" * 78)
    out(f"C4v3 cross-fit marginal coverage: {c4v3_cov:.4f}")
    if not (0.88 <= c4v3_cov <= 0.93):
        out(f"\nSANITY GATE FAILED: C4v3 coverage {c4v3_cov:.4f} is NOT within [0.88, 0.93]. "
            "This would mean the v3-score diagnosis is wrong (or something else changed "
            "coverage behaviour) -- STOPPING rather than reporting numbers built on an "
            "unconfirmed fix.")
        _write_outputs(lines, {
            "status": "SANITY_GATE_FAILED",
            "c4v3_marginal_coverage": c4v3_cov,
            "v3_cross_fit_results_so_far": v3_results,
        })
        return 1
    out("SANITY GATE PASSED.")

    # ── C6: referable-safety gate on top of C4v3, three alpha_ref options ──
    out("\n" + "=" * 78)
    out("C6: referable-safety gate on C4v3's Tier A, alpha_ref in "
        f"{ALPHA_REF_OPTIONS}")
    out("=" * 78)
    c6_names = [f"C6(alpha_ref={a})" for a in ALPHA_REF_OPTIONS]
    c6_fold_metrics = {name: [] for name in c6_names}
    c6_fold_tau = {name: [] for name in c6_names}
    c6_fold_gate_rate = {name: [] for name in c6_names}  # per-fold (k,n) for the joint rate
    c6_saturated_any = {name: False for name in c6_names}

    for fold_i, (cal_idx, eval_idx) in enumerate(fold_indices):
        cal_logits, cal_labels = pool_logits[cal_idx], pool_labels[cal_idx]
        eval_logits, eval_labels = pool_logits[eval_idx], pool_labels[eval_idx]
        T = fit_temperature(cal_logits, cal_labels)
        cal_probs = _softmax(cal_logits / T, axis=1)
        eval_probs = _softmax(eval_logits / T, axis=1)
        qhat_c4v3 = fold_qhat_by_cfg["C4v3"][fold_i]

        for alpha_ref, name in zip(ALPHA_REF_OPTIONS, c6_names):
            tau, n_ref_cal, rank, saturated = fit_referable_gate_tau(cal_probs, cal_labels, alpha_ref)
            if saturated:
                c6_saturated_any[name] = True
            ev6 = evaluate_c6(eval_probs, eval_labels, qhat_c4v3, tau)
            c6_fold_metrics[name].append(fold_metrics(ev6, eval_labels))
            c6_fold_tau[name].append(tau)
            joint = (eval_labels >= REFERABLE_FROM) & (ev6["p_ref"] <= tau + EPS)
            c6_fold_gate_rate[name].append((int(joint.sum()), len(eval_labels)))

    for name in c6_names:
        agg = aggregate_fold_metrics(c6_fold_metrics[name])
        agg["mean_tau"] = float(np.mean(c6_fold_tau[name]))
        agg["tau_saturated_any_fold"] = c6_saturated_any[name]
        k_total = sum(k for k, _n in c6_fold_gate_rate[name])
        n_total = sum(n for _k, n in c6_fold_gate_rate[name])
        agg["referable_and_below_tau_rate_pooled"] = rate_with_ci(k_total, n_total)
        agg["referable_and_below_tau_rate_fold_mean"] = mean_ci95_over_samples(
            [k / n for k, n in c6_fold_gate_rate[name] if n])
        v3_results[name] = agg
        out(f"  {name}: mean_tau={agg['mean_tau']:.4f}  saturated_any_fold={c6_saturated_any[name]}  "
            f"P(referable AND P(g>=2)<=tau)={agg['referable_and_below_tau_rate_pooled']['rate']:.4f} "
            f"[{agg['referable_and_below_tau_rate_pooled']['ci95'][0]:.4f},"
            f"{agg['referable_and_below_tau_rate_pooled']['ci95'][1]:.4f}] "
            f"({k_total}/{n_total} pooled)")

    ALL_NAMES = ["C0"] + list(V3_CONFIGS.keys()) + c6_names

    # ── Old protocol: fit on VAL, evaluate on TEST (comparison only) ───────
    out("\n" + "=" * 78)
    out("OLD PROTOCOL (for comparison only): fit on VAL, evaluate on TEST -- v3 score")
    out("=" * 78)
    T_old = fit_temperature(val_logits, val_labels)
    val_probs_old = _softmax(val_logits / T_old, axis=1)
    test_probs_old = _softmax(test_logits / T_old, axis=1)
    out(f"temperature (val-fit): {T_old:.4f}")

    old_protocol_results = {}
    old_protocol_qhat = {}
    for name, fn in V3_CONFIGS.items():
        qhat, n_g, rank_g, sat, alpha, group_labels = fn(val_probs_old, val_labels, true_scores_v3)
        ev = evaluate_ordinal_config(test_probs_old, test_labels, qhat, row_scores_v3)
        old_protocol_results[name] = fold_metrics(ev, test_labels)
        old_protocol_qhat[name] = {"qhatPerClass": qhat.tolist(), "nCalPerClass": n_g.tolist(),
                                    "rankPerClass": rank_g.tolist(), "saturated": sat.tolist(),
                                    "alphaPerClass": alpha.tolist(), "groupLabels": group_labels}
        g4_mask = test_labels == 4
        old_protocol_results[name]["grade4_tier_distribution"] = {
            t: int((ev["tier"][g4_mask] == t).sum()) for t in ["A", "B", "C"]
        }

    qhat0_old, _n0_old, _rank0_old = config_C0_fit(val_probs_old, val_labels)
    ev0_old = evaluate_c0(test_probs_old, test_labels, qhat0_old)
    old_protocol_results["C0"] = fold_metrics(ev0_old, test_labels)
    g4_mask = test_labels == 4
    old_protocol_results["C0"]["grade4_tier_distribution"] = {
        t: int((ev0_old["tier"][g4_mask] == t).sum()) for t in ["A", "B", "C"]
    }

    qhat_c4v3_old = np.array(old_protocol_qhat["C4v3"]["qhatPerClass"])
    for alpha_ref, name in zip(ALPHA_REF_OPTIONS, c6_names):
        tau_old, _n, _rank, _sat = fit_referable_gate_tau(val_probs_old, val_labels, alpha_ref)
        ev6_old = evaluate_c6(test_probs_old, test_labels, qhat_c4v3_old, tau_old)
        old_protocol_results[name] = fold_metrics(ev6_old, test_labels)
        old_protocol_results[name]["tau"] = tau_old
        g4_mask = test_labels == 4
        old_protocol_results[name]["grade4_tier_distribution"] = {
            t: int((ev6_old["tier"][g4_mask] == t).sum()) for t in ["A", "B", "C"]
        }

    # ── Results table ───────────────────────────────────────────────────────
    out("\n" + "=" * 78)
    out("RESULTS TABLE (cross-fit: mean [95% CI]; old protocol: point estimate) -- v3 score")
    out("=" * 78)
    header = (f"{'cfg':>18} {'setSz':>7} {'sz1':>7} {'sz2':>7} {'sz>=3':>7} "
              f"{'TierA':>8} {'TierB':>8} {'TierC':>8} {'covMarg':>9} "
              f"{'FAC_ref':>9} {'FAC_ge3':>9} {'TierA_refRate':>13}")
    out(header)
    for name in ALL_NAMES:
        a = v3_results[name]
        def cell(key):
            return f"{a[key]['mean']:.3f}"
        out(f"{name:>18} "
            f"{cell('mean_set_size'):>7} {cell('frac_size1'):>7} {cell('frac_size2'):>7} "
            f"{cell('frac_size_ge3'):>7} {cell('tierA_share'):>8} {cell('tierB_share'):>8} "
            f"{cell('tierC_share'):>8} {cell('coverage_marginal'):>9} "
            f"{cell('false_auto_clear_ref_rate'):>9} {cell('false_auto_clear_ge3_rate'):>9} "
            f"{cell('tierA_referable_rate'):>13}")

    out("\n-- cross-fit 95% CIs on the headline safety/workload metrics (mean over "
        f"{len(fold_indices)} folds) --")
    for name in ALL_NAMES:
        a = v3_results[name]
        def ci_str(key):
            v = a[key]
            return f"{v['mean']:.4f} [{v['ci95'][0]:.4f},{v['ci95'][1]:.4f}]"
        out(f"  {name}: mean_set_size={ci_str('mean_set_size')}  tierC_share={ci_str('tierC_share')}")
        out(f"       false_auto_clear_ref={ci_str('false_auto_clear_ref_rate')} "
            f"({a['false_auto_clear_ref_counts']['k_total']}/{a['false_auto_clear_ref_counts']['n_total']} pooled)  "
            f"false_auto_clear_ge3={ci_str('false_auto_clear_ge3_rate')} "
            f"({a['false_auto_clear_ge3_counts']['k_total']}/{a['false_auto_clear_ge3_counts']['n_total']} pooled)")
        out(f"       tierA_referable_rate={ci_str('tierA_referable_rate')} "
            f"({a['tierA_referable_counts']['k_total']}/{a['tierA_referable_counts']['n_total']} pooled)  "
            f"coverage_marginal={ci_str('coverage_marginal')}")

    out("\n-- per-grade coverage, cross-fit (mean [95% CI] over folds; n_k = pooled total) --")
    for name in ALL_NAMES:
        a = v3_results[name]
        row = []
        for k in range(5):
            g = a["coverage_per_grade"][str(k)]
            row.append(f"g{k}={g['coverage']['mean']:.3f}[{g['coverage']['ci95'][0]:.3f},"
                       f"{g['coverage']['ci95'][1]:.3f}](n={g['total_n_k']})")
        out(f"  {name:>18}: " + "  ".join(row))

    out("\n-- old protocol (val-fit / test-eval), for comparison --")
    out(header)
    for name in ALL_NAMES:
        m = old_protocol_results[name]
        out(f"{name:>18} "
            f"{m['mean_set_size']:>7.3f} {m['frac_size1']:>7.3f} {m['frac_size2']:>7.3f} "
            f"{m['frac_size_ge3']:>7.3f} {m['tierA_share']:>8.3f} {m['tierB_share']:>8.3f} "
            f"{m['tierC_share']:>8.3f} {m['coverage_marginal']:>9.3f} "
            f"{m['false_auto_clear_ref_rate']:>9.3f} {m['false_auto_clear_ge3_rate']:>9.3f} "
            f"{m['tierA_referable_rate']:>13.3f}")

    out("\n-- grade-4 Tier distribution, old protocol only (fixed TEST cohort) --")
    for name in ALL_NAMES:
        out(f"  {name}: {old_protocol_results[name]['grade4_tier_distribution']}")

    out("\nNote: Tier conditions NOT evaluable here (unavailable inputs): branch "
        "disagreement override, quality-forced override, MC-Dropout uncertainty "
        "withhold on Tier A -- left at production defaults (None/False), same as "
        "conformalPolicySweep.py.")

    c0_empty = v3_results["C0"].get("frac_empty_set", {"mean": float("nan"), "ci95": [float("nan")] * 2})
    out(f"\nC0 (+hull) empty-set fraction (cross-fit): {c0_empty['mean']:.4f} "
        f"[{c0_empty['ci95'][0]:.4f},{c0_empty['ci95'][1]:.4f}]. Non-empty C0 sets are "
        "hulled before their size is counted (see module docstring); this does not "
        "apply to any ordinal config, which are never gapped or empty by construction.")

    # ── Decision rule (task item 4, same pre-declared rule, C0 excluded) ───
    out("\n" + "=" * 78)
    out("DECISION RULE (pre-declared, applied to CROSS-FIT results, C0 excluded)")
    out("eligible = false_auto_clear_ref<=5% AND false_auto_clear_ge3<=2% AND mean_set_size<=2.5")
    out("=" * 78)
    candidate_names = list(V3_CONFIGS.keys()) + c6_names
    eligible = []
    for name in candidate_names:
        a = v3_results[name]
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

    out(f"\nNo winner is installed in code. Top-ranked by this rule: {top_config} (informational only).")

    # ── Write outputs ────────────────────────────────────────────────────────
    report = {
        "status": "OK",
        "unit_tests": "PASSED",
        "validation_gate_0": "PASSED",
        "step1_reproduction": "PASSED",
        "sanity_gate_c4v3_coverage": c4v3_cov,
        "n_folds_run": len(fold_indices),
        "cross_fit_results": v3_results,
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
        "alpha_ref_options": ALPHA_REF_OPTIONS,
    }
    _write_outputs(lines, report)
    return 0


def _write_outputs(lines, report):
    os.makedirs(OUT_DIR, exist_ok=True)
    json_path = os.path.join(OUT_DIR, "conformal_policy_sweep2.json")
    txt_path = os.path.join(OUT_DIR, "conformal_policy_sweep2.txt")

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
