
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
from scipy.special import softmax as _softmax

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import messidor2ShiftStressTest as mst      # noqa: E402  load_messidor, load_shipped_calibration, assign_tier_fast
import conformalCrossFitValidation as ccv   # noqa: E402  fit_temperature/fit_qhat_per_stratum/fit_referable_threshold/
                                             # fold_metrics/referable_sens_spec_at_threshold/STRATUM_OF_CLASS (the
                                             # already-MATLAB-validated port of calibrateBranchA.m's fitting procedure)

PIPELINE_DIR = HERE.parent
sys.path.insert(0, str(PIPELINE_DIR / "inference"))
from branchAInfer import assign_tier   # noqa: E402  literal production tiering, for the two full-437 fits

OUT_DIR = PIPELINE_DIR / "diagnostics" / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)

REFERABLE_FROM = 2
SEED = 42
SIZES = [50, 100, 200, 400]
N_REPEATS = 20

OUT_LINES = []


def out(s=""):
    print(s)
    OUT_LINES.append(str(s))


def fit_production_calib(logits, labels):
    T = ccv.fit_temperature(logits, labels)
    probs = _softmax(logits / T, axis=1)
    qhat, n_g = ccv.fit_qhat_per_stratum(probs, labels, ccv.ALPHA_PER_STRATUM)
    thr, n_ref, sat = ccv.fit_referable_threshold(probs, labels, ccv.REFERABLE_TARGET_SENS)
    return T, qhat, thr, n_g, n_ref, sat


def aggregate_repeats(reps):
    def vals(key):
        return np.array([r[key] for r in reps], dtype=float)

    agg = {}
    for k in ("coverage_marginal", "mean_set_size", "tierA_share", "tierB_share", "tierC_share",
              "false_autoclear_tierA_ref_rate", "false_autoclear_tierA_ge3_rate",
              "referable_sensitivity", "referable_specificity"):
        v = vals(k)
        agg[k] = {"mean": float(np.nanmean(v)), "std": float(np.nanstd(v)),
                  "min": float(np.nanmin(v)), "max": float(np.nanmax(v))}
    for stratum_name in ("non_referable", "referable"):
        v = np.array([r["coverage_per_stratum"][stratum_name]["coverage"] for r in reps], dtype=float)
        agg[f"coverage_stratum_{stratum_name}"] = {"mean": float(np.nanmean(v)), "std": float(np.nanstd(v))}
    agg["n_repeats"] = len(reps)
    agg["n_qhat_saturated_nonref"] = int(sum(1 for r in reps if r["qhatPerStratum"][0] >= 1.0))
    agg["n_referableThreshold_saturated"] = int(sum(1 for r in reps if r["referableThreshold_saturated"]))
    agg["mean_referableThreshold"] = float(np.mean([r["referableThreshold"] for r in reps]))
    agg["mean_temperature"] = float(np.mean([r["T"] for r in reps]))
    agg["mean_n_cal_referable"] = float(np.mean([r["n_ref_in_cal"] for r in reps]))
    agg["_repeats_raw"] = reps
    return agg


def full_fit_and_apply(logits5, y_true, cal_idx, eval_idx, label):
    """Full-437-patient swap: literal branchAInfer.assign_tier (cheap enough
    at n=872 x 2 not to need the vectorised replica)."""
    T, qhat, thr, n_g, n_ref, sat = fit_production_calib(logits5[cal_idx], y_true[cal_idx])
    eval_probs = _softmax(logits5[eval_idx] / T, axis=1)
    eval_labels = y_true[eval_idx]
    n = len(eval_labels)
    calib_full = {"calibrated": True, "qhatPerStratum": [float(v) for v in qhat],
                  "stratumOf": ccv.STRATUM_OF_CLASS, "referableThreshold": float(thr),
                  "referableTargetSensitivity": ccv.REFERABLE_TARGET_SENS, "referableFrom": REFERABLE_FROM}
    ev = {"set_size": np.zeros(n, dtype=int), "tier": np.empty(n, dtype="<U1"),
         "low": np.zeros(n, dtype=int), "high": np.zeros(n, dtype=int)}
    for i in range(n):
        tier, pred_set, _reason, lo, hi, _contig = assign_tier(list(eval_probs[i]), calib_full)
        ev["tier"][i] = tier; ev["low"][i] = lo; ev["high"][i] = hi; ev["set_size"][i] = len(pred_set)
    fm = ccv.fold_metrics(ev, eval_labels)
    rs = ccv.referable_sens_spec_at_threshold(eval_probs, eval_labels, thr)

    out(f"  {label}: T={T:.4f}  qhatPerStratum={np.round(qhat, 4).tolist()}  "
       f"referableThreshold={thr:.4f}  (n_cal={len(cal_idx)}, n_cal_referable={n_ref}"
       f"{' SATURATED' if sat else ''})")
    out(f"    coverage marginal={fm['coverage_marginal']:.4f}  mean_set_size={fm['mean_set_size']:.4f}  "
       f"Tier A/B/C={fm['tierA_share']:.4f}/{fm['tierB_share']:.4f}/{fm['tierC_share']:.4f}")
    out(f"    coverage per stratum: non-referable={fm['coverage_per_stratum']['non_referable']['coverage']:.4f}  "
       f"referable={fm['coverage_per_stratum']['referable']['coverage']:.4f}")
    out(f"    false auto-clear (final Tier A): true referable={fm['false_autoclear_tierA_ref_rate']:.4f} "
       f"({fm['false_autoclear_tierA_ref_k']}/{fm['false_autoclear_tierA_ref_n']})  "
       f"true grade>=3={fm['false_autoclear_tierA_ge3_rate']:.4f} "
       f"({fm['false_autoclear_tierA_ge3_k']}/{fm['false_autoclear_tierA_ge3_n']})")
    out(f"    referable sens/spec at refit threshold: sens={rs['sensitivity']['rate']:.4f}  "
       f"spec={rs['specificity']['rate']:.4f}")

    return {"T": T, "qhatPerStratum": [float(v) for v in qhat], "referableThreshold": float(thr),
           "n_cal": int(len(cal_idx)), "n_cal_referable": int(n_ref), "referableThreshold_saturated": bool(sat),
           **fm, "referable_sensitivity": rs["sensitivity"]["rate"], "referable_specificity": rs["specificity"]["rate"]}


def run_for_tag(tag):
    out("=" * 78)
    out(f"PART E ({tag}): SITE CONFORMAL RECALIBRATION -- ADAPTATION EXPERIMENT")
    out("(Messidor-2 labels ARE used to refit the production calibration in this "
       "part, on purpose)")
    out("=" * 78)

    manifest, logits5 = mst.load_messidor(tag)
    y_true = manifest["dr_grade"].values.astype(int)
    patient_ids = manifest["patient_id"].values
    is_A = (patient_ids % 2 == 0)
    idxA, idxB = np.where(is_A)[0], np.where(~is_A)[0]
    out(f"Half A (even patient_id, SELECTION): {len(idxA)} images, "
       f"{len(np.unique(patient_ids[idxA]))} patients")
    out(f"Half B (odd patient_id, REPORT): {len(idxB)} images, "
       f"{len(np.unique(patient_ids[idxB]))} patients")


    shipped_calib, shipped_path = mst.load_shipped_calibration(tag)
    T0 = float(shipped_calib["temperature"])
    probs0 = _softmax(logits5 / T0, axis=1)
    mst.verify_production_tier_fast(probs0, shipped_calib)
    out("assign_tier_fast verified against inference/branchAInfer.assign_tier "
       "(200 random rows, shipped calibration) -- safe to use for the repeats below.")

    # ---- sizes 50/100/200/400: site subset of A -> refit -> apply to full B --
    unique_A = np.unique(patient_ids[idxA])
    rng = np.random.default_rng(SEED)

    out(f"\nSubsampling calibration subsets of half A's patients at n in {SIZES} "
       f"({N_REPEATS} repeats each, sampled without replacement). Production "
       f"calibration (temperature + stratified qhat + referableThreshold, "
       f"calibrateBranchA.m's own fitting procedure, via its already-validated "
       f"Python port) is refit on the SITE subset alone and applied to the FULL, "
       f"fixed half B via assign_tier_fast:")

    size_results = {}
    for size in SIZES:
        if size > len(unique_A):
            out(f"  n_patients={size}: SKIPPED (only {len(unique_A)} patients available in A)")
            continue
        reps = []
        for _ in range(N_REPEATS):
            chosen = rng.choice(unique_A, size=size, replace=False)
            cal_idx = idxA[np.isin(patient_ids[idxA], chosen)]
            T, qhat, thr, n_g, n_ref, sat = fit_production_calib(logits5[cal_idx], y_true[cal_idx])
            eval_probs = _softmax(logits5[idxB] / T, axis=1)
            ev = mst.assign_tier_fast(eval_probs, list(qhat), ccv.STRATUM_OF_CLASS, thr)
            fm = ccv.fold_metrics(ev, y_true[idxB])
            rs = ccv.referable_sens_spec_at_threshold(eval_probs, y_true[idxB], thr)
            reps.append({
                "n_cal_images": int(len(cal_idx)), "n_ref_in_cal": int(n_ref),
                "referableThreshold_saturated": bool(sat), "T": T, "referableThreshold": thr,
                "qhatPerStratum": [float(v) for v in qhat],
                **fm,
                "referable_sensitivity": rs["sensitivity"]["rate"],
                "referable_specificity": rs["specificity"]["rate"],
            })
        agg = aggregate_repeats(reps)
        size_results[str(size)] = agg
        out(f"  n_patients={size:4d} (repeats={agg['n_repeats']}/{N_REPEATS}, "
           f"mean referableThreshold={agg['mean_referableThreshold']:.4f}, "
           f"referableThreshold saturated {agg['n_referableThreshold_saturated']}/{agg['n_repeats']}):")
        out(f"    coverage marginal   mean={agg['coverage_marginal']['mean']:.4f} "
           f"std={agg['coverage_marginal']['std']:.4f}")
        out(f"    mean set size       mean={agg['mean_set_size']['mean']:.4f} "
           f"std={agg['mean_set_size']['std']:.4f}")
        out(f"    Tier A/B/C shares   A: mean={agg['tierA_share']['mean']:.4f} std={agg['tierA_share']['std']:.4f}  "
           f"B: mean={agg['tierB_share']['mean']:.4f} std={agg['tierB_share']['std']:.4f}  "
           f"C: mean={agg['tierC_share']['mean']:.4f} std={agg['tierC_share']['std']:.4f}")
        out(f"    false auto-clear (final Tier A)  true referable: mean={agg['false_autoclear_tierA_ref_rate']['mean']:.4f} "
           f"std={agg['false_autoclear_tierA_ref_rate']['std']:.4f}  "
           f"true grade>=3: mean={agg['false_autoclear_tierA_ge3_rate']['mean']:.4f} "
           f"std={agg['false_autoclear_tierA_ge3_rate']['std']:.4f}")
        out(f"    referable sens/spec at refit threshold  sens: mean={agg['referable_sensitivity']['mean']:.4f} "
           f"std={agg['referable_sensitivity']['std']:.4f}  spec: mean={agg['referable_specificity']['mean']:.4f} "
           f"std={agg['referable_specificity']['std']:.4f}")

    # ---- full 437-patient swap, both directions -------------------------------
    out("\nFull 437-patient swap (production calibration refit on the FULL half, "
       "applied to the OTHER full half; both directions):")
    full_A_to_B = full_fit_and_apply(logits5, y_true, idxA, idxB, "full A(437) -> full B(437)")
    full_B_to_A = full_fit_and_apply(logits5, y_true, idxB, idxA, "full B(437) -> full A(437)")

    # ---- "unvalidated camera rule": 0 labelled site patients, Tier A -> B ------
    out("\n'Unvalidated camera rule' (the 0-labelled-site-patients anchor point): "
       "apply the SHIPPED production calibration UNCHANGED to the REPORT half, but "
       "refuse Tier A outright -- every would-be Tier A case is demoted to Tier B:")
    probs_B_shipped = _softmax(logits5[idxB] / T0, axis=1)
    n = len(idxB)
    ev_shipped = {"set_size": np.zeros(n, dtype=int), "tier": np.empty(n, dtype="<U1"),
                 "low": np.zeros(n, dtype=int), "high": np.zeros(n, dtype=int)}
    for i in range(n):
        tier, pred_set, _reason, lo, hi, _contig = assign_tier(list(probs_B_shipped[i]), shipped_calib)
        ev_shipped["tier"][i] = tier; ev_shipped["low"][i] = lo
        ev_shipped["high"][i] = hi; ev_shipped["set_size"][i] = len(pred_set)
    fm_shipped = ccv.fold_metrics(ev_shipped, y_true[idxB])
    tierA_share = fm_shipped["tierA_share"]
    tierA_k = int((ev_shipped["tier"] == "A").sum())

    camera_rule = {
        "baseline_shipped_report_half": {
            "tierA_share": fm_shipped["tierA_share"], "tierB_share": fm_shipped["tierB_share"],
            "tierC_share": fm_shipped["tierC_share"],
            "false_autoclear_tierA_ref_rate": fm_shipped["false_autoclear_tierA_ref_rate"],
            "false_autoclear_tierA_ref_k": fm_shipped["false_autoclear_tierA_ref_k"],
            "false_autoclear_tierA_ref_n": fm_shipped["false_autoclear_tierA_ref_n"],
            "false_autoclear_tierA_ge3_rate": fm_shipped["false_autoclear_tierA_ge3_rate"],
        },
        "camera_rule_report_half": {
            "tierA_share": 0.0, "tierB_share": fm_shipped["tierB_share"] + fm_shipped["tierA_share"],
            "tierC_share": fm_shipped["tierC_share"],
            "false_autoclear_tierA_ref_rate": 0.0, "false_autoclear_tierA_ge3_rate": 0.0,
        },
        "workload_cost_share": tierA_share, "workload_cost_k": tierA_k, "n_total": n,
    }
    out(f"  shipped policy REPORT half: Tier A/B/C = {fm_shipped['tierA_share']:.4f}/"
       f"{fm_shipped['tierB_share']:.4f}/{fm_shipped['tierC_share']:.4f}  "
       f"false-auto-clear true referable={fm_shipped['false_autoclear_tierA_ref_rate']:.4f} "
       f"({fm_shipped['false_autoclear_tierA_ref_k']}/{fm_shipped['false_autoclear_tierA_ref_n']})")
    out(f"  camera-rule REPORT half:    Tier A/B/C = 0.0000/"
       f"{fm_shipped['tierB_share'] + fm_shipped['tierA_share']:.4f}/{fm_shipped['tierC_share']:.4f}  "
       f"false-auto-clear true referable=0.0000 (0/{fm_shipped['false_autoclear_tierA_ref_n']}) "
       f"(no auto-clear happens at all, so nothing can be falsely auto-cleared)")
    out(f"  workload cost: {tierA_k}/{n} = {tierA_share:.4f} of cases move from auto-clear to "
       f"assisted review -- exactly the shipped policy's own Tier A share/count on this half.")

    return {"tag": tag, "n_patients_A": int(len(unique_A)),
           "n_patients_B": int(len(np.unique(patient_ids[idxB]))),
           "shipped_calibration_path": str(shipped_path),
           "subsampling": size_results,
           "full_437_swap": {"A_to_B": full_A_to_B, "B_to_A": full_B_to_A},
           "unvalidated_camera_rule": camera_rule}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", type=str, default="v2c")
    args = ap.parse_args()

    t0 = time.time()
    report = run_for_tag(args.tag)
    report["wall_time_seconds"] = time.time() - t0

    report_json = OUT_DIR / f"messidor2_site_conformal_recal_{args.tag}.json"
    report_txt = OUT_DIR / f"messidor2_site_conformal_recal_{args.tag}.txt"

    def _default(o):
        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
        return str(o)

    with open(report_json, "w") as f:
        json.dump(report, f, indent=2, default=_default)
    out(f"\nWrote {report_json}")
    with open(report_txt, "w", encoding="utf-8") as f:
        f.write("\n".join(OUT_LINES) + "\n")
    out(f"Wrote {report_txt}")
    out(f"Total wall time: {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
