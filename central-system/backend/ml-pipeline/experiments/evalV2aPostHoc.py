

import json
import os
import sys

import numpy as np
from scipy.special import softmax as _softmax
from sklearn.metrics import cohen_kappa_score, f1_score, roc_auc_score, roc_curve, confusion_matrix

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
V2A_DIR = os.path.join(ML_ROOT, "models", "Model1", "v2a")
OUT_DIR = os.path.join(ML_ROOT, "diagnostics", "out")
METRICS_JSON = os.path.join(V2A_DIR, "branchA_v2a_metrics.json")

REFERABLE_FROM = 2   # grade >= 2 is referable -- matches ckpt["referable_from"]
NUM_CLASSES = 5
TARGETS = [0.90, 0.93, 0.95]
Z95 = 1.959963984540054  # scipy.stats.norm.ppf(0.975), hardcoded to avoid a scipy.stats import


# ── Loading ──────────────────────────────────────────────────────────────────
def load_split(split):
    def p(name):
        return os.path.join(V2A_DIR, f"branchA_v2a_{split}_{name}.npy")
    ids = np.load(p("ids"), allow_pickle=True)
    labels = np.load(p("labels"), allow_pickle=True).astype(int)
    logits5 = np.load(p("logits"), allow_pickle=True).astype(np.float64)
    logits_bin = np.load(p("binary_logits"), allow_pickle=True).astype(np.float64)
    return ids, labels, logits5, logits_bin


def source_of(image_id):
    s = str(image_id).lower()
    if s.startswith("idrid"):
        return "idrid"
    if s.startswith("aptos"):
        return "aptos"
    if s.startswith("eyepacs"):
        return "eyepacs"
    return "unknown"


# ── Stats ────────────────────────────────────────────────────────────────────
def wilson_ci(k, n, z=Z95):
    """Wilson score interval for a binomial proportion. (nan, nan) if n==0."""
    if n == 0:
        return (float("nan"), float("nan"))
    phat = k / n
    denom = 1 + z * z / n
    center = phat + z * z / (2 * n)
    adj = z * np.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n))
    return (float((center - adj) / denom), float((center + adj) / denom))


def rate_with_ci(k, n):
    lo, hi = wilson_ci(k, n)
    return {"k": int(k), "n": int(n), "rate": (k / n if n else float("nan")),
            "ci95": [lo, hi]}


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


# ── Metrics matching the notebook's compute_metrics(), plus extras ──────────
def full_metrics(y_true, y_pred, probs5):
    y_true = np.asarray(y_true)
    y_pred = np.asarray(y_pred)
    n = len(y_true)

    qwk = float(cohen_kappa_score(y_true, y_pred, weights="quadratic")) if n else float("nan")
    macro_f1 = float(f1_score(y_true, y_pred, average="macro", labels=list(range(NUM_CLASSES)))) if n else float("nan")

    ref_true = y_true >= REFERABLE_FROM
    ref_pred = y_pred >= REFERABLE_FROM
    tp = int((ref_true & ref_pred).sum())
    fn = int((ref_true & ~ref_pred).sum())
    tn = int((~ref_true & ~ref_pred).sum())
    fp = int((~ref_true & ref_pred).sum())
    ref_sens = rate_with_ci(tp, tp + fn)
    ref_spec = rate_with_ci(tn, tn + fp)

    g4_mask = y_true == 4
    g4_recall = rate_with_ci(int((y_pred[g4_mask] == 4).sum()), int(g4_mask.sum()))
    g1_mask = y_true == 1
    g1_recall = rate_with_ci(int((y_pred[g1_mask] == 1).sum()), int(g1_mask.sum()))

    mean_signed_error = float((y_pred - y_true).mean()) if n else float("nan")

    # C.5 "live-path" safety check: argmax referable OR P(g3)+P(g4) > 0.5,
    # mirroring the production rule-engine's grade-3/grade-4 safety net
    # (ML plan §0's "interim grade-3/grade-4 safety check").
    live_pred = ref_pred | ((probs5[:, 3] + probs5[:, 4]) > 0.5)
    lp_tp = int((ref_true & live_pred).sum())
    lp_fn = int((ref_true & ~live_pred).sum())
    lp_tn = int((~ref_true & ~live_pred).sum())
    lp_fp = int((~ref_true & live_pred).sum())
    live_sens = rate_with_ci(lp_tp, lp_tp + lp_fn)
    live_spec = rate_with_ci(lp_tn, lp_tn + lp_fp)

    cm = confusion_matrix(y_true, y_pred, labels=list(range(NUM_CLASSES))).tolist()

    return {
        "n": n, "qwk": qwk, "macro_f1": macro_f1,
        "ref_sens": ref_sens, "ref_spec": ref_spec,
        "grade4_recall": g4_recall, "grade1_recall": g1_recall,
        "mean_signed_error": mean_signed_error,
        "live_path_sens": live_sens, "live_path_spec": live_spec,
        "confusion_matrix": cm,
    }


def compare_to_metrics_json(computed, ref_block, tol=1e-6):
    """Field-by-field comparison against branchA_v2a_metrics.json's stored
    scalars. Returns a list of mismatch strings (empty = clean match)."""
    scalar_map = {
        "qwk": "qwk", "macro_f1": "macro_f1",
        "mean_signed_error": "mean_signed_error",
        "n": "n",
    }
    rate_map = {
        "ref_sens": "ref_sens", "ref_spec": "ref_spec",
        "live_path_sens": "live_path_sens", "live_path_spec": "live_path_spec",
    }
    recall_map = {"grade4_recall": "grade4_recall", "grade1_recall": "grade1_recall"}
    recall_n_map = {"grade4_recall": "grade4_n", "grade1_recall": "grade1_n"}

    mismatches = []
    for our_key, ref_key in scalar_map.items():
        if ref_key not in ref_block:
            continue
        a, b = computed[our_key], ref_block[ref_key]
        if not (a == b or (isinstance(a, float) and isinstance(b, (int, float)) and abs(a - b) <= tol)):
            mismatches.append(f"{our_key}: computed={a!r} vs metrics.json={b!r}")
    for our_key, ref_key in rate_map.items():
        if ref_key not in ref_block:
            continue
        a, b = computed[our_key]["rate"], ref_block[ref_key]
        if not (np.isnan(a) and np.isnan(b)) and abs(a - b) > tol:
            mismatches.append(f"{our_key}: computed={a!r} vs metrics.json={b!r}")
    for our_key, ref_key in recall_map.items():
        a, b = computed[our_key]["rate"], ref_block.get(ref_key)
        if b is not None and not (np.isnan(a) and np.isnan(b)) and abs(a - b) > tol:
            mismatches.append(f"{our_key}: computed={a!r} vs metrics.json={b!r}")
        n_key = recall_n_map[our_key]
        if n_key in ref_block and computed[our_key]["n"] != ref_block[n_key]:
            mismatches.append(f"{n_key}: computed={computed[our_key]['n']!r} vs metrics.json={ref_block[n_key]!r}")
    if "confusion_matrix" in ref_block and computed["confusion_matrix"] != ref_block["confusion_matrix"]:
        mismatches.append("confusion_matrix: differs (see report json for both)")
    return mismatches


# ── Threshold locking (the CORRECT version -- see module docstring) ─────────
def lock_threshold_on_val(val_score, val_ref_true, target):
    """Smallest-sensitivity-loss / best-specificity threshold on VAL that
    still clears `target` sensitivity. roc_curve's thresholds are
    DECREASING and tpr is non-decreasing as threshold falls, so the FIRST
    index (lowest, via argmax on the boolean mask) where tpr>=target is the
    HIGHEST threshold that still clears the bar -- the correct fix for the
    notebook's np.where(...)[0][-1] bug.
    """
    fpr, tpr, thresholds = roc_curve(val_ref_true, val_score)
    ok = tpr >= target
    if not ok.any():
        return None
    idx = int(np.argmax(ok))
    return {
        "threshold": float(thresholds[idx]),
        "val_sensitivity": float(tpr[idx]),
        "val_specificity": float(1 - fpr[idx]),
        "val_tpr_max": float(tpr.max()),
    }


def apply_threshold(test_score, test_ref_true, threshold):
    pred = test_score >= threshold
    tp = int((test_ref_true & pred).sum())
    fn = int((test_ref_true & ~pred).sum())
    tn = int((~test_ref_true & ~pred).sum())
    fp = int((~test_ref_true & pred).sum())
    return {
        "threshold": float(threshold),
        "sensitivity": rate_with_ci(tp, tp + fn),
        "specificity": rate_with_ci(tn, tn + fp),
    }


def safe_auc(y_true, score):
    if len(np.unique(y_true)) < 2:
        return None
    return float(roc_auc_score(y_true, score))


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    report = {}
    lines = []

    def out(s=""):
        print(s)
        lines.append(s)

    out("=" * 78)
    out("v2a post-hoc evaluation (CPU-only, from saved arrays -- no retraining)")
    out("=" * 78)

    val_ids, val_labels, val_logits5, val_logits_bin = load_split("val")
    test_ids, test_labels, test_logits5, test_logits_bin = load_split("test")
    val_probs5 = _softmax(val_logits5, axis=1)
    test_probs5 = _softmax(test_logits5, axis=1)
    val_pred_argmax = val_logits5.argmax(axis=1)
    test_pred_argmax = test_logits5.argmax(axis=1)

    val_source = np.array([source_of(i) for i in val_ids])
    test_source = np.array([source_of(i) for i in test_ids])
    out(f"\nval: n={len(val_ids)}  sources={dict(zip(*np.unique(val_source, return_counts=True)))}")
    out(f"test: n={len(test_ids)}  sources={dict(zip(*np.unique(test_source, return_counts=True)))}")

    with open(METRICS_JSON) as fh:
        ref_metrics = json.load(fh)

    # ── Item 1: reproduce pooled/idrid/aptos test numbers, diff vs metrics.json
    out("\n" + "=" * 78)
    out("ITEM 1: reproduce test_pooled / test_idrid_only / test_aptos_only")
    out("=" * 78)
    subsets = {
        "test_pooled": np.ones(len(test_ids), dtype=bool),
        "test_idrid_only": test_source == "idrid",
        "test_aptos_only": test_source == "aptos",
    }
    item1 = {}
    for name, mask in subsets.items():
        m = full_metrics(test_labels[mask], test_pred_argmax[mask], test_probs5[mask])
        mismatches = compare_to_metrics_json(m, ref_metrics.get(name, {}))
        item1[name] = {"computed": m, "mismatches_vs_metrics_json": mismatches}
        out(f"\n-- {name} (n={m['n']}) --")
        out(f"  qwk={m['qwk']:.4f}  macro_f1={m['macro_f1']:.4f}  mean_signed_error={m['mean_signed_error']:+.4f}")
        out(f"  ref_sens={m['ref_sens']['rate']:.4f} [{m['ref_sens']['ci95'][0]:.4f},{m['ref_sens']['ci95'][1]:.4f}] "
            f"({m['ref_sens']['k']}/{m['ref_sens']['n']})   "
            f"ref_spec={m['ref_spec']['rate']:.4f} [{m['ref_spec']['ci95'][0]:.4f},{m['ref_spec']['ci95'][1]:.4f}] "
            f"({m['ref_spec']['k']}/{m['ref_spec']['n']})")
        out(f"  grade4_recall={m['grade4_recall']['rate']:.4f} [{m['grade4_recall']['ci95'][0]:.4f},"
            f"{m['grade4_recall']['ci95'][1]:.4f}] ({m['grade4_recall']['k']}/{m['grade4_recall']['n']})   "
            f"grade1_recall={m['grade1_recall']['rate']:.4f} [{m['grade1_recall']['ci95'][0]:.4f},"
            f"{m['grade1_recall']['ci95'][1]:.4f}] ({m['grade1_recall']['k']}/{m['grade1_recall']['n']})")
        out(f"  live_path_sens={m['live_path_sens']['rate']:.4f} "
            f"[{m['live_path_sens']['ci95'][0]:.4f},{m['live_path_sens']['ci95'][1]:.4f}] "
            f"({m['live_path_sens']['k']}/{m['live_path_sens']['n']})   "
            f"live_path_spec={m['live_path_spec']['rate']:.4f} "
            f"[{m['live_path_spec']['ci95'][0]:.4f},{m['live_path_spec']['ci95'][1]:.4f}] "
            f"({m['live_path_spec']['k']}/{m['live_path_spec']['n']})")
        if mismatches:
            out(f"  MISMATCH vs branchA_v2a_metrics.json: {mismatches}")
        else:
            out("  MATCH vs branchA_v2a_metrics.json (within 1e-6).")
    report["item1_reproduced_test_metrics"] = item1

    # ── Item 2: binary head, correctly locked on VAL ─────────────────────────
    out("\n" + "=" * 78)
    out("ITEM 2: binary head, threshold locked CORRECTLY on VAL")
    out("=" * 78)
    val_probs_bin = sigmoid(val_logits_bin)
    test_probs_bin = sigmoid(test_logits_bin)
    val_ref_true = val_labels >= REFERABLE_FROM
    test_ref_true = test_labels >= REFERABLE_FROM

    binhead_val_auc = safe_auc(val_ref_true, val_probs_bin)
    binhead_test_auc = safe_auc(test_ref_true, test_probs_bin)
    out(f"\nbinary head AUC: val={binhead_val_auc}, test={binhead_test_auc}")

    item2 = {"auc_val": binhead_val_auc, "auc_test": binhead_test_auc, "targets": {}}
    for target in TARGETS:
        lock = lock_threshold_on_val(val_probs_bin, val_ref_true, target)
        out(f"\n-- target sensitivity {target:.0%} --")
        if lock is None:
            out(f"  UNREACHABLE on VAL (max val tpr for binary head is below {target:.0%}).")
            item2["targets"][str(target)] = {"reachable": False}
            continue
        test_eval = apply_threshold(test_probs_bin, test_ref_true, lock["threshold"])
        out(f"  VAL:  threshold={lock['threshold']:.4f}  sens={lock['val_sensitivity']:.4f}  "
            f"spec={lock['val_specificity']:.4f}")
        out(f"  TEST: sens={test_eval['sensitivity']['rate']:.4f} "
            f"[{test_eval['sensitivity']['ci95'][0]:.4f},{test_eval['sensitivity']['ci95'][1]:.4f}] "
            f"({test_eval['sensitivity']['k']}/{test_eval['sensitivity']['n']})   "
            f"spec={test_eval['specificity']['rate']:.4f} "
            f"[{test_eval['specificity']['ci95'][0]:.4f},{test_eval['specificity']['ci95'][1]:.4f}] "
            f"({test_eval['specificity']['k']}/{test_eval['specificity']['n']})")
        item2["targets"][str(target)] = {"reachable": True, "val_lock": lock, "test": test_eval}
    report["item2_binary_head_corrected"] = item2

    # ── Item 3: 5-class-derived referable score P(g>=2) ──────────────────────
    out("\n" + "=" * 78)
    out("ITEM 3: 5-class-derived referable score P(g>=2) = sum softmax(logits)[2:5]")
    out("=" * 78)
    val_score5 = val_probs5[:, 2] + val_probs5[:, 3] + val_probs5[:, 4]
    test_score5 = test_probs5[:, 2] + test_probs5[:, 3] + test_probs5[:, 4]
    score5_val_auc = safe_auc(val_ref_true, val_score5)
    score5_test_auc = safe_auc(test_ref_true, test_score5)
    out(f"\nP(g>=2) AUC: val={score5_val_auc}, test={score5_test_auc}")

    # current argmax>=2 point (already computed in item1's test_pooled block,
    # restated here for the head-to-head table)
    argmax_point = item1["test_pooled"]["computed"]["ref_sens"], item1["test_pooled"]["computed"]["ref_spec"]
    out(f"\ncurrent argmax>=2 point (pooled TEST, no VAL lock involved): "
        f"sens={argmax_point[0]['rate']:.4f}  spec={argmax_point[1]['rate']:.4f}")

    item3 = {"auc_val": score5_val_auc, "auc_test": score5_test_auc,
             "argmax_ge2_point_pooled_test": {"sens": argmax_point[0], "spec": argmax_point[1]},
             "targets": {}}
    head_to_head = []
    for target in TARGETS:
        lock = lock_threshold_on_val(val_score5, val_ref_true, target)
        out(f"\n-- target sensitivity {target:.0%} --")
        if lock is None:
            out(f"  UNREACHABLE on VAL (max val tpr for P(g>=2) is below {target:.0%}).")
            item3["targets"][str(target)] = {"reachable": False}
            continue
        test_eval = apply_threshold(test_score5, test_ref_true, lock["threshold"])
        out(f"  VAL:  threshold={lock['threshold']:.4f}  sens={lock['val_sensitivity']:.4f}  "
            f"spec={lock['val_specificity']:.4f}")
        out(f"  TEST: sens={test_eval['sensitivity']['rate']:.4f} "
            f"[{test_eval['sensitivity']['ci95'][0]:.4f},{test_eval['sensitivity']['ci95'][1]:.4f}] "
            f"({test_eval['sensitivity']['k']}/{test_eval['sensitivity']['n']})   "
            f"spec={test_eval['specificity']['rate']:.4f} "
            f"[{test_eval['specificity']['ci95'][0]:.4f},{test_eval['specificity']['ci95'][1]:.4f}] "
            f"({test_eval['specificity']['k']}/{test_eval['specificity']['n']})")
        item3["targets"][str(target)] = {"reachable": True, "val_lock": lock, "test": test_eval}

        bh = item2["targets"].get(str(target), {})
        bh_spec = bh.get("test", {}).get("specificity", {}).get("rate") if bh.get("reachable") else None
        s5_spec = test_eval["specificity"]["rate"]
        head_to_head.append({
            "target_val_sensitivity": target,
            "binary_head_test_specificity": bh_spec,
            "p_g_ge2_test_specificity": s5_spec,
            "winner": ("p_g_ge2" if (bh_spec is None or s5_spec > bh_spec)
                      else ("binary_head" if s5_spec < bh_spec else "tie")),
        })
    report["item3_5class_derived_score"] = item3

    out("\n-- head-to-head: TEST specificity at equal VAL-locked sensitivity target --")
    out(f"  {'target':>8} {'binary_head_spec':>18} {'p(g>=2)_spec':>14} {'winner':>12}")
    for row in head_to_head:
        bh = f"{row['binary_head_test_specificity']:.4f}" if row["binary_head_test_specificity"] is not None else "n/a"
        s5 = f"{row['p_g_ge2_test_specificity']:.4f}" if row["p_g_ge2_test_specificity"] is not None else "n/a"
        out(f"  {row['target_val_sensitivity']:>8.0%} {bh:>18} {s5:>14} {row['winner']:>12}")
    report["item3_head_to_head"] = head_to_head

    # ── Item 4: grade-4 analysis on TEST ─────────────────────────────────────
    out("\n" + "=" * 78)
    out("ITEM 4: grade-4 (PDR) analysis on TEST")
    out("=" * 78)
    g4_mask = test_labels == 4
    g4_n = int(g4_mask.sum())
    g4_pred = test_pred_argmax[g4_mask]
    pred_dist = {int(g): int((g4_pred == g).sum()) for g in range(NUM_CLASSES)}
    out(f"\n{g4_n} true grade-4 (PDR) cases in TEST.")
    out(f"predicted-grade distribution: {pred_dist}")

    non_ref_mask_within_g4 = g4_pred < REFERABLE_FROM
    g4_ids = test_ids[g4_mask]
    g4_score5 = test_score5[g4_mask]
    rank_all = np.argsort(np.argsort(test_score5)) + 1  # 1 = lowest P(g>=2) in all of TEST
    g4_rank_all = rank_all[g4_mask]

    missed = []
    for i in np.where(non_ref_mask_within_g4)[0]:
        missed.append({
            "id": str(g4_ids[i]), "predicted_grade": int(g4_pred[i]),
            "p_g_ge2": float(g4_score5[i]),
            "p_g_ge2_rank_in_test_ascending": int(g4_rank_all[i]),
            "p_g_ge2_rank_of": int(len(test_score5)),
        })
    out(f"\npredicted NON-referable (argmax < {REFERABLE_FROM}) among true grade-4: "
        f"{len(missed)}/{g4_n}")
    for m in missed:
        out(f"  {m['id']}: predicted_grade={m['predicted_grade']}  P(g>=2)={m['p_g_ge2']:.4f}  "
            f"rank {m['p_g_ge2_rank_in_test_ascending']}/{m['p_g_ge2_rank_of']} (1=lowest confidence)")

    t93 = item3["targets"].get("0.93", {})
    rescue_note = "item 3's 0.93-target lock was unreachable on VAL; cannot evaluate rescue."
    if missed:
        if t93.get("reachable"):
            thr93 = t93["val_lock"]["threshold"]
            for m in missed:
                m["rescued_by_val_locked_0.93_threshold"] = bool(m["p_g_ge2"] >= thr93)
            n_rescued = sum(1 for m in missed if m["rescued_by_val_locked_0.93_threshold"])
            rescue_note = (f"P(g>=2) >= {thr93:.4f} (the VAL-locked 0.93-target threshold from item 3) "
                           f"rescues {n_rescued}/{len(missed)} of these.")
        out(f"\n{rescue_note}")
    report_missed = missed

    g3_mask = test_labels == 3
    g3_n = int(g3_mask.sum())
    g3_overcalled_g4 = int((test_pred_argmax[g3_mask] == 4).sum())
    overcall_rate = rate_with_ci(g3_overcalled_g4, g3_n)
    out(f"\ntrue grade-3 over-called as grade-4: {overcall_rate['rate']:.4f} "
        f"[{overcall_rate['ci95'][0]:.4f},{overcall_rate['ci95'][1]:.4f}] "
        f"({overcall_rate['k']}/{overcall_rate['n']})")

    report["item4_grade4_analysis"] = {
        "n_grade4_test": g4_n,
        "predicted_grade_distribution": pred_dist,
        "predicted_non_referable": report_missed,
        "rescue_note": rescue_note,
        "grade3_overcalled_as_grade4": overcall_rate,
    }

    # ── Write outputs ─────────────────────────────────────────────────────────
    os.makedirs(OUT_DIR, exist_ok=True)
    json_path = os.path.join(OUT_DIR, "v2a_posthoc_report.json")
    txt_path = os.path.join(OUT_DIR, "v2a_posthoc_report.txt")

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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
