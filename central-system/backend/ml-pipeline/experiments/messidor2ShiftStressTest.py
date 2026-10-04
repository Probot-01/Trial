
import os
import sys
import json
import time
import random
from pathlib import Path

import numpy as np
import pandas as pd
import cv2
from PIL import Image, ImageDraw
from sklearn.metrics import roc_auc_score, cohen_kappa_score

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")  # CPU-only, per task

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import evalMessidor2V2a as ev            # noqa: E402  (ben_graham_preprocess, path resolution, softmax)
import evalV2aPostHoc as posthoc         # noqa: E402  (VAL-lock logic)
import conformalPolicySweep2 as cps      # noqa: E402  (C5v3 policy fit/eval)
import conformalCrossFitValidation as ccv  # noqa: E402  (fold_metrics/evaluate_fold -- same field names as the
                                            # in-domain cross-fit report, for a same-keys side-by-side)

PIPELINE_DIR = HERE.parent
sys.path.insert(0, str(PIPELINE_DIR / "inference"))
from branchAInfer import assign_tier, EXPECTED_CALIB_METHOD  # noqa: E402  (production tiering, exactly as shipped)

MODEL1_DIR = PIPELINE_DIR / "models" / "Model1"
V2A_DIR = MODEL1_DIR / "v2a"
MESSIDOR_ROOT = ev.MESSIDOR_ROOT
MANIFEST_CSV = ev.MANIFEST_CSV
OUT_DIR = PIPELINE_DIR / "diagnostics" / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)

LOGITS_CACHE = OUT_DIR / "messidor2_v2a_logits.npy"
MONTAGE_PNG = OUT_DIR / "messidor2_sanity_montage.png"
REPORT_JSON = OUT_DIR / "messidor2_shift_stress_test.json"
CONFORMAL_SWEEP2_JSON = OUT_DIR / "conformal_policy_sweep2.json"

NUM_CLASSES = 5
REFERABLE_FROM = 2
SEED = 42
N_BOOT = 2000
IMG_SIZE = 512

RESOLUTION_BUCKETS = [(1440, 960), (2240, 1488), (2304, 1536)]


def softmax(x):
    return ev.softmax(x)


# ===========================================================================
# SHARED: load everything once
# ===========================================================================
def load_messidor(tag="v2a"):
    """tag='v2a' (default) is BYTE-IDENTICAL to this function's original,
    unparameterised behaviour: same cache file (messidor2_v2a_logits.npy,
    the dict-shaped cache evalMessidor2V2a.py itself writes), same assert.

    Any other tag reads the cache convention evalMessidor2Candidate.py
    writes instead (messidor2_<tag>_logits5.npy + messidor2_<tag>_ids.npy --
    plain arrays, no dict) -- that script is what produced those caches for
    v2b/v2c, and this one does not reimplement that inference path."""
    manifest = pd.read_csv(MANIFEST_CSV)
    assert manifest["gradable"].eq(1).all()
    if tag == "v2a":
        cached = np.load(LOGITS_CACHE, allow_pickle=True).item()
        assert list(cached["image_path"]) == list(manifest["image_path"]), \
            "cached logits do not align with the current manifest order - rerun evalMessidor2V2a.py"
        logits5 = cached["logits5"].astype(np.float64)
    else:
        ids_path = OUT_DIR / f"messidor2_{tag}_ids.npy"
        logits5_path = OUT_DIR / f"messidor2_{tag}_logits5.npy"
        if not (ids_path.is_file() and logits5_path.is_file()):
            raise FileNotFoundError(
                f"No Messidor-2 logits cache for tag={tag!r} ({logits5_path} / {ids_path}) -- "
                f"run experiments/evalMessidor2Candidate.py --checkpoint models/Model1/{tag}/branchA_{tag}.pt "
                f"--tag {tag} first (this script does not run inference itself for a non-v2a tag).")
        cached_ids = np.load(ids_path, allow_pickle=True).tolist()
        assert cached_ids == list(manifest["image_path"]), \
            f"cached logits for tag={tag!r} do not align with the current manifest order"
        logits5 = np.load(logits5_path).astype(np.float64)
    return manifest.reset_index(drop=True), logits5


def load_indomain_val_test(tag="v2a"):
    d = MODEL1_DIR / tag
    val_ids = np.load(d / f"branchA_{tag}_val_ids.npy", allow_pickle=True)
    val_labels = np.load(d / f"branchA_{tag}_val_labels.npy").astype(int)
    val_logits5 = np.load(d / f"branchA_{tag}_val_logits.npy").astype(np.float64)
    test_ids = np.load(d / f"branchA_{tag}_test_ids.npy", allow_pickle=True)
    test_labels = np.load(d / f"branchA_{tag}_test_labels.npy").astype(int)
    test_logits5 = np.load(d / f"branchA_{tag}_test_logits.npy").astype(np.float64)
    return {"val_ids": val_ids, "val_labels": val_labels, "val_logits5": val_logits5,
           "test_ids": test_ids, "test_labels": test_labels, "test_logits5": test_logits5}


def patient_bootstrap(metric_fn, patient_ids, n_boot=N_BOOT, seed=SEED):
    """Generic patient-level bootstrap. metric_fn(idx_array)->dict of scalars.
    Returns {key: (lo2.5, hi97.5)}."""
    unique_patients = np.unique(patient_ids)
    patient_to_idx = {p: np.where(patient_ids == p)[0] for p in unique_patients}
    n_p = len(unique_patients)
    rng = np.random.default_rng(seed)
    boot = None
    for _ in range(n_boot):
        sampled = rng.choice(unique_patients, size=n_p, replace=True)
        idx = np.concatenate([patient_to_idx[p] for p in sampled])
        vals = metric_fn(idx)
        if boot is None:
            boot = {k: [] for k in vals}
        for k, v in vals.items():
            boot[k].append(v)
    return {k: (float(np.nanpercentile(v, 2.5)), float(np.nanpercentile(v, 97.5))) for k, v in boot.items()}


def sens_spec_auc(y_true_ref, pred_ref_bool, score=None):
    tp = int((y_true_ref & pred_ref_bool).sum()); fn = int((y_true_ref & ~pred_ref_bool).sum())
    tn = int((~y_true_ref & ~pred_ref_bool).sum()); fp = int((~y_true_ref & pred_ref_bool).sum())
    sens = tp / (tp + fn) if (tp + fn) else float("nan")
    spec = tn / (tn + fp) if (tn + fp) else float("nan")
    auc = float("nan")
    if score is not None and len(np.unique(y_true_ref)) > 1:
        auc = float(roc_auc_score(y_true_ref, score))
    return sens, spec, auc


OUT_LINES = []


def out(s=""):
    print(s)
    OUT_LINES.append(str(s))


# ===========================================================================
# PART A: SANITY - montage + format/resolution breakdown
# ===========================================================================
def _preprocess_messidor_tile(rel_path):
    bgr = cv2.imread(str(MESSIDOR_ROOT / rel_path), cv2.IMREAD_COLOR)
    if bgr is None:
        return None
    proc = ev.ben_graham_preprocess(bgr, IMG_SIZE)
    return cv2.cvtColor(proc, cv2.COLOR_BGR2RGB)


def _preprocess_idrid_tile(cache_id):
    raw_id, _ = ev.to_row_image_id(cache_id, IMG_SIZE)
    try:
        path = ev.resolve_idrid_grading_path(raw_id)
    except FileNotFoundError:
        return None, None
    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        return None, None
    proc = ev.ben_graham_preprocess(bgr, IMG_SIZE)
    return cv2.cvtColor(proc, cv2.COLOR_BGR2RGB), path


def build_sanity_montage(manifest, logits5, indomain, tile_size=260):
    probs5 = softmax(logits5)
    p_ge2 = probs5[:, 2] + probs5[:, 3] + probs5[:, 4]
    y_true = manifest["dr_grade"].values.astype(int)

    rng = random.Random(SEED)
    random_idx = rng.sample(range(len(manifest)), 8)

    worst_mask = y_true >= REFERABLE_FROM
    worst_order = np.argsort(p_ge2)  # ascending: lowest P(g>=2) first
    worst_idx = [i for i in worst_order if worst_mask[i]][:8]

    rows = []
    row_labels = []

    row1_tiles, row1_caps = [], []
    for i in random_idx:
        img = _preprocess_messidor_tile(manifest["image_path"].iloc[i])
        row1_tiles.append(img)
        row1_caps.append(f"true={y_true[i]} P(g2+)={p_ge2[i]:.2f}")
    rows.append(row1_tiles); row_labels.append("Messidor-2: 8 RANDOM (preprocessed)")
    row1_caps_all = row1_caps

    row2_tiles, row2_caps = [], []
    for i in worst_idx:
        img = _preprocess_messidor_tile(manifest["image_path"].iloc[i])
        row2_tiles.append(img)
        row2_caps.append(f"true={y_true[i]} P(g2+)={p_ge2[i]:.2f}")
    rows.append(row2_tiles); row_labels.append("Messidor-2: 8 WORST MISSES (true>=2, lowest P(g2+))")

    test_ids = indomain["test_ids"]
    idrid_test_idx = sorted(i for i, c in enumerate(test_ids) if str(c).startswith("idrid"))
    row3_tiles, row3_caps = [], []
    picked = 0
    for i in idrid_test_idx:
        if picked >= 8:
            break
        img, path = _preprocess_idrid_tile(str(test_ids[i]))
        if img is None:
            continue
        row3_tiles.append(img)
        row3_caps.append(f"true={indomain['test_labels'][i]} (IDRiD)")
        picked += 1
    rows.append(row3_tiles); row_labels.append("In-domain (IDRiD test, only source with local raw files): 8 preprocessed")

    n_cols = 8
    cap_h = 34
    label_h = 22
    canvas_w = n_cols * tile_size
    canvas_h = len(rows) * (tile_size + cap_h + label_h)
    canvas = Image.new("RGB", (canvas_w, canvas_h), "white")
    draw = ImageDraw.Draw(canvas)
    y = 0
    all_caps = [row1_caps_all, row2_caps, row3_caps]
    for r, (tiles, label, caps) in enumerate(zip(rows, row_labels, all_caps)):
        draw.text((6, y + 4), label, fill=(0, 0, 0))
        y += label_h
        for c in range(n_cols):
            x = c * tile_size
            if c < len(tiles) and tiles[c] is not None:
                tile_img = Image.fromarray(tiles[c]).resize((tile_size, tile_size))
                canvas.paste(tile_img, (x, y))
                draw.text((x + 4, y + tile_size + 2), caps[c], fill=(0, 0, 0))
            else:
                draw.text((x + 4, y + tile_size + 2), "(unavailable)", fill=(200, 0, 0))
        y += tile_size + cap_h
    canvas.save(str(MONTAGE_PNG))
    return MONTAGE_PNG, {
        "random_idx_image_paths": [manifest["image_path"].iloc[i] for i in random_idx],
        "worst_miss_image_paths": [manifest["image_path"].iloc[i] for i in worst_idx],
        "worst_miss_p_ge2": [float(p_ge2[i]) for i in worst_idx],
        "worst_miss_true_grade": [int(y_true[i]) for i in worst_idx],
        "n_idrid_test_tiles_used": len(row3_tiles),
    }


def format_resolution_breakdown(manifest, logits5):
    probs5 = softmax(logits5)
    p_ge2 = probs5[:, 2] + probs5[:, 3] + probs5[:, 4]
    y_true = manifest["dr_grade"].values.astype(int)
    y_pred = logits5.argmax(axis=1)
    ref_true = y_true >= REFERABLE_FROM
    ref_pred = y_pred >= REFERABLE_FROM
    patient_ids = manifest["patient_id"].values

    exts = manifest["image_path"].apply(lambda p: os.path.splitext(p)[1].lower())

    out("\nFile-format breakdown:")
    out(f"  {'format':8s} {'n':>5s} {'AUC(P(g2+))':>12s} {'sens':>7s} {'spec':>7s} {'pred-grade0 share':>18s}")
    format_report = {}
    for ext in sorted(exts.unique()):
        mask = (exts == ext).values
        n = int(mask.sum())
        sens, spec, auc = sens_spec_auc(ref_true[mask], ref_pred[mask], p_ge2[mask])
        g0_share = float((y_pred[mask] == 0).mean())

        # patient-level bootstrap restricted to this subset's patients
        sub_patients = patient_ids[mask]
        sub_ref_true = ref_true[mask]
        sub_ref_pred = ref_pred[mask]
        sub_p_ge2 = p_ge2[mask]
        sub_ypred = y_pred[mask]

        def metric_fn(idx):
            s, sp, a = sens_spec_auc(sub_ref_true[idx], sub_ref_pred[idx], sub_p_ge2[idx])
            return {"sens": s, "spec": sp, "auc": a, "g0_share": float((sub_ypred[idx] == 0).mean())}

        ci = patient_bootstrap(metric_fn, sub_patients)
        out(f"  {ext:8s} {n:5d} {auc:12.4f} {sens:7.4f} {spec:7.4f} {g0_share:18.4f}")
        out(f"           95% CI: auc={ci['auc']}, sens={ci['sens']}, spec={ci['spec']}, g0_share={ci['g0_share']}")
        format_report[ext] = {"n": n, "auc": auc, "sens": sens, "spec": spec, "grade0_share": g0_share,
                              "ci95": ci}

    out("\nResolution breakdown:")
    dims = []
    for p in manifest["image_path"]:
        with Image.open(MESSIDOR_ROOT / p) as im:
            dims.append(im.size)
    dims = np.array(dims)
    resolution_report = {}
    matched_any = np.zeros(len(dims), dtype=bool)
    for (w, h) in RESOLUTION_BUCKETS:
        label = f"{w}x{h}"
        mask = (dims[:, 0] == w) & (dims[:, 1] == h)
        matched_any |= mask
        n = int(mask.sum())
        if n == 0:
            resolution_report[label] = {"n": 0}
            continue
        sens, spec, auc = sens_spec_auc(ref_true[mask], ref_pred[mask], p_ge2[mask])
        g0_share = float((y_pred[mask] == 0).mean())
        sub_patients = patient_ids[mask]
        sub_ref_true = ref_true[mask]; sub_ref_pred = ref_pred[mask]; sub_p_ge2 = p_ge2[mask]; sub_ypred = y_pred[mask]

        def metric_fn(idx):
            s, sp, a = sens_spec_auc(sub_ref_true[idx], sub_ref_pred[idx], sub_p_ge2[idx])
            return {"sens": s, "spec": sp, "auc": a, "g0_share": float((sub_ypred[idx] == 0).mean())}

        ci = patient_bootstrap(metric_fn, sub_patients)
        out(f"  {label:12s} {n:5d} {auc:12.4f} {sens:7.4f} {spec:7.4f} {g0_share:18.4f}")
        out(f"           95% CI: auc={ci['auc']}, sens={ci['sens']}, spec={ci['spec']}, g0_share={ci['g0_share']}")
        resolution_report[label] = {"n": n, "auc": auc, "sens": sens, "spec": spec, "grade0_share": g0_share,
                                    "ci95": ci}
    n_other = int((~matched_any).sum())
    if n_other:
        out(f"  other        n={n_other}")
        resolution_report["other"] = {"n": n_other}

    return format_report, resolution_report


def run_part_a(manifest, logits5, indomain):
    out("\n" + "=" * 78)
    out("PART A: SANITY CHECK")
    out("=" * 78)
    montage_path, montage_meta = build_sanity_montage(manifest, logits5, indomain)
    out(f"Montage saved (outside git - diagnostics/out/ is gitignored): {montage_path}")
    out(f"Worst-miss image paths: {montage_meta['worst_miss_image_paths']}")

    visual_description = (
        "VISUAL INSPECTION of the montage (24 tiles, 512px Ben Graham preprocessed):\n"
        "  - Crop/framing: sane and consistent across ALL three rows - a clean circular\n"
        "    retinal field, no rectangular black bars bleeding in, no obviously botched\n"
        "    crops. The preprocessing pipeline does NOT look broken on Messidor-2.\n"
        "  - A small notch/flare artifact is visible near the top-right edge of the\n"
        "    circular crop in most Messidor-2 tiles (both random and worst-miss rows) -\n"
        "    consistent in position, likely a fixed camera/lens marking rather than\n"
        "    per-image noise. Not seen on the IDRiD row.\n"
        "  - Colour: Messidor-2 tiles (rows 1-2) have a cooler grey-green/olive cast;\n"
        "    the IDRiD row (row 3) has a visibly warmer orange/red-brown cast. This is a\n"
        "    real, visible systematic colour-domain difference between the two camera/\n"
        "    site populations that Ben Graham's local-contrast normalisation does not\n"
        "    remove - a plausible contributor to the ranking (AUC) drop, not a sign of a\n"
        "    broken pipeline.\n"
        "  - Sharpness: broadly comparable across all three rows - no obvious focus/\n"
        "    blur difference jumps out.\n"
        "  - The row-2 WORST MISSES do not look visually degraded, occluded, or low-\n"
        "    quality - they are clean, well-centered, well-focused fundus photos with\n"
        "    clearly visible vessels and optic discs. The model is confidently wrong on\n"
        "    these (P(g2+) approx 0.00 on true-referable images), not confused by an\n"
        "    obviously bad photo. Some IDRiD tiles show bright white speckled patches\n"
        "    (likely hard exudates or bright artifacts) not seen as prominently in the\n"
        "    Messidor sample shown here, but n=8 is too small to generalise this.\n"
        "  CONCLUSION: nothing here suggests a preprocessing/pipeline bug specific to\n"
        "  Messidor-2. The visible difference is a genuine camera/site colour-domain\n"
        "  shift, consistent with (not proof of) the AUC and format/resolution results\n"
        "  below."
    )
    out("\n" + visual_description)

    format_report, resolution_report = format_resolution_breakdown(manifest, logits5)
    return {"montage_path": str(montage_path), "montage_meta": montage_meta,
           "visual_description": visual_description,
           "format_breakdown": format_report, "resolution_breakdown": resolution_report}


def evaluate_ordinal_fast(probs, labels, qhat_per_class):
    """Vectorised equivalent of cps.assign_tier_ordinal + cps.evaluate_ordinal_config
    for row_scores_v3 specifically - same formula, same algorithm (mode always
    a member, contiguous hull via [lo,hi], EPS boundary guard), just without a
    per-row Python loop. Used ONLY inside the 2000x bootstrap (where the exact
    per-row reference implementation is too slow); the headline Messidor-2
    numbers use cps.evaluate_ordinal_config directly. Correctness is verified
    once against the reference implementation before first use (see
    verify_fast_matches_reference)."""
    n = probs.shape[0]
    max_val = probs.max(axis=1, keepdims=True)
    is_max = probs == max_val
    mode = NUM_CLASSES - 1 - is_max[:, ::-1].argmax(axis=1)  # ties -> higher grade
    cdf = np.hstack([np.zeros((n, 1)), np.cumsum(probs, axis=1)])
    rows = np.arange(n)

    scores = np.zeros((n, NUM_CLASSES))
    for k in range(NUM_CLASSES):
        lo_k = np.minimum(mode, k)
        hi_k = np.maximum(mode, k)
        interval = cdf[rows, hi_k + 1] - cdf[rows, lo_k]
        scores[:, k] = interval - probs[:, k]
    scores[rows, mode] = 0.0

    in_set = scores <= (qhat_per_class[None, :] + cps.EPS)
    in_set[rows, mode] = True
    cols = np.arange(NUM_CLASSES)
    lo = np.where(in_set, cols, NUM_CLASSES).min(axis=1)
    hi = np.where(in_set, cols, -1).max(axis=1)

    tier = np.where(hi < REFERABLE_FROM, "A", np.where(lo >= REFERABLE_FROM, "B", "C"))
    return {"set_size": hi - lo + 1, "tier": tier, "low": lo, "high": hi}


def verify_fast_matches_reference(probs, labels, qhat_per_class, n_check=200):
    idx = np.random.default_rng(0).choice(len(labels), size=min(n_check, len(labels)), replace=False)
    ref = cps.evaluate_ordinal_config(probs[idx], labels[idx], qhat_per_class, cps.row_scores_v3)
    fast = evaluate_ordinal_fast(probs[idx], labels[idx], qhat_per_class)
    ok = (np.array_equal(ref["tier"], fast["tier"]) and np.array_equal(ref["low"], fast["low"])
          and np.array_equal(ref["high"], fast["high"]) and np.array_equal(ref["set_size"], fast["set_size"]))
    if not ok:
        raise RuntimeError("evaluate_ordinal_fast does NOT match the reference implementation - "
                           "do not use it for the bootstrap until this is fixed.")
    return True


def load_indomain_reference_c5v3():
    with open(CONFORMAL_SWEEP2_JSON) as f:
        sweep = json.load(f)
    return sweep["cross_fit_results"]["C5v3"]


def extra_c5v3_stats(eval_out, eval_labels):
    """Adds what conformalPolicySweep2.fold_metrics doesn't: tierA_ge3_rate
    (mirrors tierA_referable_rate but for grade>=3) and per-STRATUM (2-group
    referable/nonreferable) coverage, alongside its per-grade coverage."""
    tiers = eval_out["tier"]
    is_A = tiers == "A"
    n_A = int(is_A.sum())
    true_ge3 = eval_labels >= 3
    n_A_ge3 = int((is_A & true_ge3).sum())
    tierA_ge3_rate = (n_A_ge3 / n_A) if n_A else float("nan")

    covered = (eval_out["low"] <= eval_labels) & (eval_labels <= eval_out["high"])
    stratum = (eval_labels >= REFERABLE_FROM).astype(int)
    stratum_coverage = {}
    for s, name in [(0, "nonreferable(0-1)"), (1, "referable(2-4)")]:
        mask = stratum == s
        n = int(mask.sum())
        stratum_coverage[name] = {"coverage": float(covered[mask].mean()) if n else float("nan"), "n": n}

    return {"tierA_ge3_k": n_A_ge3, "tierA_ge3_n": n_A, "tierA_ge3_rate": tierA_ge3_rate,
           "stratum_coverage": stratum_coverage}


def run_part_b(manifest, logits5, indomain):
    out("\n" + "=" * 78)
    out("PART B: C5v3 POLICY UNDER SHIFT")
    out("=" * 78)

    cal_logits = np.concatenate([indomain["val_logits5"], indomain["test_logits5"]], axis=0)
    cal_labels = np.concatenate([indomain["val_labels"], indomain["test_labels"]], axis=0)
    cal_probs = softmax(cal_logits)
    out(f"Calibration pool: pooled v2a val+test, n={len(cal_labels)} "
       f"(val={len(indomain['val_labels'])}, test={len(indomain['test_labels'])})")

    # ---- fit C5v3 (score v3, referable-stratified Mondrian alpha=[0.30,0.05]) ----
    qhat, n_g, rank_g, sat, alpha, group_labels = cps.config_C5(cal_probs, cal_labels, cps.true_scores_v3)
    out(f"C5v3 fit on pooled val+test: qhatPerClass={np.round(qhat, 4).tolist()}  "
       f"n_perGroup={n_g.tolist()}  alpha={alpha.tolist()}  saturated={sat.tolist()}")

    m_probs5 = softmax(logits5)
    y_true = manifest["dr_grade"].values.astype(int)
    patient_ids = manifest["patient_id"].values

    eval_out = cps.evaluate_ordinal_config(m_probs5, y_true, qhat, cps.row_scores_v3)
    metrics = cps.fold_metrics(eval_out, y_true)
    extra = extra_c5v3_stats(eval_out, y_true)
    set_within_01 = eval_out["high"] < REFERABLE_FROM
    false_clear_mask_ref = (y_true >= REFERABLE_FROM) & set_within_01

    out("\nC5v3 applied UNCHANGED to Messidor-2 (n={}):".format(len(y_true)))
    out(f"  mean set size        : {metrics['mean_set_size']:.4f}  "
       f"(size1={metrics['frac_size1']:.4f} size2={metrics['frac_size2']:.4f} size>=3={metrics['frac_size_ge3']:.4f})")
    out(f"  Tier A/B/C shares    : {metrics['tierA_share']:.4f} / {metrics['tierB_share']:.4f} / {metrics['tierC_share']:.4f}")
    out(f"  coverage (marginal)  : {metrics['coverage_marginal']:.4f}")
    out("  coverage per grade   :")
    for k in range(5):
        cg = metrics["coverage_per_grade"][str(k)]
        out(f"    grade {k}: coverage={cg['coverage']:.4f}  n={cg['n_k']}")
    out("  coverage per stratum :")
    for name, d in extra["stratum_coverage"].items():
        out(f"    {name}: coverage={d['coverage']:.4f}  n={d['n']}")
    out(f"  false auto-clear (on SETS, denom=true count):")
    out(f"    true referable (>=2): {metrics['false_auto_clear_ref_k']}/{metrics['false_auto_clear_ref_n']} "
       f"= {metrics['false_auto_clear_ref_rate']:.4f}")
    out(f"    true grade>=3        : {metrics['false_auto_clear_ge3_k']}/{metrics['false_auto_clear_ge3_n']} "
       f"= {metrics['false_auto_clear_ge3_rate']:.4f}")
    out(f"  false auto-clear (on final TIER A, denom=tierA count):")
    out(f"    tierA & referable(>=2): {metrics['tierA_referable_k']}/{metrics['tierA_count']} "
       f"= {metrics['tierA_referable_rate']:.4f}")
    out(f"    tierA & grade>=3      : {extra['tierA_ge3_k']}/{extra['tierA_ge3_n']} "
       f"= {extra['tierA_ge3_rate']:.4f}")

    # ---- referableThreshold: P(g>=2), locked at 95% sensitivity on the SAME pooled cal set ----
    cal_p_ge2 = cal_probs[:, 2] + cal_probs[:, 3] + cal_probs[:, 4]
    cal_ref_true = cal_labels >= REFERABLE_FROM
    lock = posthoc.lock_threshold_on_val(cal_p_ge2, cal_ref_true, 0.95)
    out(f"\nreferableThreshold: P(g>=2)>=95% target sensitivity, locked on pooled val+test: "
       f"threshold={lock['threshold']:.4f}  cal_sens={lock['val_sensitivity']:.4f}  cal_spec={lock['val_specificity']:.4f}")

    m_p_ge2 = m_probs5[:, 2] + m_probs5[:, 3] + m_probs5[:, 4]
    m_ref_true = y_true >= REFERABLE_FROM
    thr_pred = m_p_ge2 >= lock["threshold"]
    thr_sens, thr_spec, thr_auc = sens_spec_auc(m_ref_true, thr_pred, m_p_ge2)
    out(f"Applied UNCHANGED to Messidor-2: sens={thr_sens:.4f}  spec={thr_spec:.4f}  AUC={thr_auc:.4f}")

    # ---- patient-level bootstrap CIs for the headline Messidor numbers -----
    # (uses evaluate_ordinal_fast, verified to match the reference row-by-row
    # implementation exactly - see verify_fast_matches_reference below)
    verify_fast_matches_reference(m_probs5, y_true, qhat)
    def metric_fn(idx):
        sub_labels = y_true[idx]
        sub_probs = m_probs5[idx]
        sub_eval = evaluate_ordinal_fast(sub_probs, sub_labels, qhat)
        sub_m = cps.fold_metrics(sub_eval, sub_labels)
        sub_pge2 = sub_probs[:, 2] + sub_probs[:, 3] + sub_probs[:, 4]
        sub_ref = sub_labels >= REFERABLE_FROM
        s, sp, a = sens_spec_auc(sub_ref, sub_pge2 >= lock["threshold"], sub_pge2)
        return {"tierA_share": sub_m["tierA_share"], "tierB_share": sub_m["tierB_share"],
               "tierC_share": sub_m["tierC_share"], "coverage_marginal": sub_m["coverage_marginal"],
               "false_auto_clear_ref_rate": sub_m["false_auto_clear_ref_rate"],
               "false_auto_clear_ge3_rate": sub_m["false_auto_clear_ge3_rate"],
               "tierA_referable_rate": sub_m["tierA_referable_rate"],
               "referableThreshold_sens": s, "referableThreshold_spec": sp, "referableThreshold_auc": a}

    out("\nComputing patient-level bootstrap CIs for Part B headline numbers...")
    ci = patient_bootstrap(metric_fn, patient_ids)
    for k, v in ci.items():
        out(f"  {k:28s} 95% CI: [{v[0]:.4f}, {v[1]:.4f}]")

    # ---- side-by-side with in-domain cross-fit reference ---------------------
    indomain_ref = load_indomain_reference_c5v3()
    out("\nSIDE BY SIDE: C5v3 in-domain cross-fit (10x5-fold on pooled val+test, from "
       "conformal_policy_sweep2.json) vs single-fit-on-full-pool applied to Messidor-2:")
    out(f"  {'metric':26s} {'in-domain (cross-fit)':>24s} {'Messidor-2':>14s}")
    pairs = [
        ("mean_set_size", metrics["mean_set_size"]),
        ("tierA_share", metrics["tierA_share"]),
        ("tierB_share", metrics["tierB_share"]),
        ("tierC_share", metrics["tierC_share"]),
        ("coverage_marginal", metrics["coverage_marginal"]),
        ("false_auto_clear_ref_rate", metrics["false_auto_clear_ref_rate"]),
        ("false_auto_clear_ge3_rate", metrics["false_auto_clear_ge3_rate"]),
        ("tierA_referable_rate", metrics["tierA_referable_rate"]),
    ]
    for key, m2_val in pairs:
        indomain_val = indomain_ref[key]["mean"]
        out(f"  {key:26s} {indomain_val:24.4f} {m2_val:14.4f}")

    # extra cross-reference: AUC of P(g>=2) on the HELD-OUT in-domain test set alone
    # (not the calibration pool itself, which would be an optimistic apples-to-oranges
    # comparison) - for the closing ranking-vs-calibration judgement.
    test_probs = softmax(indomain["test_logits5"])
    test_p_ge2 = test_probs[:, 2] + test_probs[:, 3] + test_probs[:, 4]
    test_ref_true = indomain["test_labels"] >= REFERABLE_FROM
    indomain_test_auc = float(roc_auc_score(test_ref_true, test_p_ge2))
    out(f"\nAUC of P(g>=2), in-domain HELD-OUT test alone: {indomain_test_auc:.4f}   "
       f"vs Messidor-2: {thr_auc:.4f}   delta={thr_auc - indomain_test_auc:+.4f}")

    return {
        "calibration_n": len(cal_labels),
        "qhat_per_class": qhat.tolist(), "n_per_group": n_g.tolist(), "alpha": alpha.tolist(),
        "messidor2_c5v3": {**metrics, **extra},
        "referable_threshold": {"threshold": lock["threshold"], "cal_sens": lock["val_sensitivity"],
                               "cal_spec": lock["val_specificity"],
                               "messidor2_sens": thr_sens, "messidor2_spec": thr_spec, "messidor2_auc": thr_auc,
                               "indomain_test_auc": indomain_test_auc},
        "patient_bootstrap_ci95": {k: list(v) for k, v in ci.items()},
        "indomain_cross_fit_reference": indomain_ref,
        "_false_clear_mask_ref": false_clear_mask_ref,
    }



def load_shipped_calibration(tag):
    """Reads models/calibration_branchA_<tag>.json DIRECTLY (not via
    branchAInfer.load_calibration, which is locked to whatever
    BRANCH_A_MODEL_VERSION the process's env var says at IMPORT time --
    this script may report on a tag that differs from that default).
    Replicates load_calibration's own hard-refusal guards so a wrong-method,
    wrong-version, or malformed file is caught here too, not silently
    misapplied."""
    path = PIPELINE_DIR / "models" / f"calibration_branchA_{tag}.json"
    if not path.is_file():
        raise FileNotFoundError(f"No shipped calibration for tag={tag!r} at {path}")
    with open(path) as f:
        c = json.load(f)
    if c.get("method") != EXPECTED_CALIB_METHOD:
        raise ValueError(f"{path.name} has method={c.get('method')!r}, expected {EXPECTED_CALIB_METHOD!r} "
                         "-- refusing to apply it as 'the production policy'.")
    if c.get("modelVersion") != f"branchA_{tag}":
        raise ValueError(f"{path.name} has modelVersion={c.get('modelVersion')!r}, expected 'branchA_{tag}'.")
    if not isinstance(c.get("qhatPerStratum"), list) or len(c["qhatPerStratum"]) != 2:
        raise ValueError(f"{path.name}: qhatPerStratum missing or malformed.")
    if not isinstance(c.get("stratumOf"), list) or len(c["stratumOf"]) != NUM_CLASSES:
        raise ValueError(f"{path.name}: stratumOf missing or malformed.")
    if not isinstance(c.get("referableThreshold"), (int, float)):
        raise ValueError(f"{path.name}: referableThreshold missing.")
    c["calibrated"] = True
    return c, path


def assign_tier_fast(probs, qhat_per_stratum, stratum_of, referable_threshold, eps=1e-9):
    """Vectorised equivalent of branchAInfer.assign_tier for method
    ordinal_mode_interval_stratified_v3 -- same score formula as
    evalMessidor2Candidate.evaluate_ordinal_fast, different membership
    (per-STRATUM qhat, not per-class) and an added referable-threshold
    safety gate (Tier A -> B demotion). Used ONLY inside the 2000x
    bootstrap; the headline point estimates below call assign_tier()
    itself, per row. Correctness verified once against assign_tier() before
    first use (see verify_production_tier_fast)."""
    n = probs.shape[0]
    max_val = probs.max(axis=1, keepdims=True)
    is_max = probs == max_val
    mode = NUM_CLASSES - 1 - is_max[:, ::-1].argmax(axis=1)  # ties -> higher grade
    cdf = np.hstack([np.zeros((n, 1)), np.cumsum(probs, axis=1)])
    rows = np.arange(n)

    scores = np.zeros((n, NUM_CLASSES))
    for k in range(NUM_CLASSES):
        lo_k = np.minimum(mode, k)
        hi_k = np.maximum(mode, k)
        interval = cdf[rows, hi_k + 1] - cdf[rows, lo_k]
        scores[:, k] = interval - probs[:, k]
    scores[rows, mode] = 0.0

    qhat_per_class = np.array([qhat_per_stratum[stratum_of[k]] for k in range(NUM_CLASSES)])
    in_set = scores <= (qhat_per_class[None, :] + eps)
    in_set[rows, mode] = True
    cols = np.arange(NUM_CLASSES)
    lo = np.where(in_set, cols, NUM_CLASSES).min(axis=1)
    hi = np.where(in_set, cols, -1).max(axis=1)

    p_ref = probs[:, 2] + probs[:, 3] + probs[:, 4]
    auto_clearable = hi < REFERABLE_FROM
    gated = p_ref >= (referable_threshold - eps)
    tier = np.where(auto_clearable & gated, "B",
           np.where(auto_clearable & ~gated, "A",
           np.where(lo >= REFERABLE_FROM, "B", "C")))
    return {"tier": tier, "low": lo, "high": hi, "set_size": hi - lo + 1, "p_referable": p_ref}


def verify_production_tier_fast(probs, calib, n_check=200, seed=0):
    idx = np.random.default_rng(seed).choice(len(probs), size=min(n_check, len(probs)), replace=False)
    qhat = [float(v) for v in calib["qhatPerStratum"]]
    stratum_of = [int(v) for v in calib["stratumOf"]]
    thr = float(calib["referableThreshold"])
    fast = assign_tier_fast(probs[idx], qhat, stratum_of, thr)
    for j, i in enumerate(idx):
        tier, _pred_set, _reason, lo, hi, _c = assign_tier(list(probs[i]), calib)
        if tier != fast["tier"][j] or lo != fast["low"][j] or hi != fast["high"][j]:
            raise RuntimeError("assign_tier_fast does NOT match branchAInfer.assign_tier -- do not use "
                               "it for the bootstrap until this is fixed.")
    return True


def production_policy_half_report(label, y_true, probs, patient_ids, calib, n_boot=N_BOOT, seed=SEED):
    qhat = [float(v) for v in calib["qhatPerStratum"]]
    stratum_of = [int(v) for v in calib["stratumOf"]]
    thr = float(calib["referableThreshold"])

    # ---- point estimate: the literal production function, looped per row ----
    n = len(y_true)
    eval_out = {"set_size": np.zeros(n, dtype=int), "tier": np.empty(n, dtype="<U1"),
               "low": np.zeros(n, dtype=int), "high": np.zeros(n, dtype=int)}
    for i in range(n):
        tier, pred_set, _reason, lo, hi, _c = assign_tier(list(probs[i]), calib)
        eval_out["tier"][i] = tier
        eval_out["low"][i] = lo
        eval_out["high"][i] = hi
        eval_out["set_size"][i] = len(pred_set)
    metrics = ccv.fold_metrics(eval_out, y_true)  # same field names as the in-domain cross-fit report

    p_ref = probs[:, 2] + probs[:, 3] + probs[:, 4]
    ref_true = y_true >= REFERABLE_FROM
    thr_sens, thr_spec, thr_auc = sens_spec_auc(ref_true, p_ref >= thr, p_ref)

    out(f"\n--- {label} (n={n}) -- PRODUCTION-INSTALLED policy, exactly as shipped ---")
    out(f"  mean set size        : {metrics['mean_set_size']:.4f}  "
       f"(size1={metrics['frac_size1']:.4f} size2={metrics['frac_size2']:.4f} size>=3={metrics['frac_size_ge3']:.4f})")
    out(f"  Tier A/B/C shares    : {metrics['tierA_share']:.4f} / {metrics['tierB_share']:.4f} / {metrics['tierC_share']:.4f}")
    out(f"  coverage (marginal)  : {metrics['coverage_marginal']:.4f}")
    out(f"  false auto-clear (on FINAL Tier A label, denom=true count):")
    out(f"    true referable (>=2): {metrics['false_autoclear_tierA_ref_k']}/{metrics['false_autoclear_tierA_ref_n']} "
       f"= {metrics['false_autoclear_tierA_ref_rate']:.4f}")
    out(f"    true grade>=3        : {metrics['false_autoclear_tierA_ge3_k']}/{metrics['false_autoclear_tierA_ge3_n']} "
       f"= {metrics['false_autoclear_tierA_ge3_rate']:.4f}")
    out(f"  referable sens/spec at SHIPPED referableThreshold ({thr:.4f}): "
       f"sens={thr_sens:.4f}  spec={thr_spec:.4f}  AUC={thr_auc:.4f}")

    # ---- patient-level bootstrap CIs (fast vectorised replica, verified above) ----
    def metric_fn(idx):
        sub_labels, sub_probs = y_true[idx], probs[idx]
        ev = assign_tier_fast(sub_probs, qhat, stratum_of, thr)
        sub_ref, sub_ge3 = sub_labels >= REFERABLE_FROM, sub_labels >= 3
        is_A = ev["tier"] == "A"
        n_ref, n_ge3 = int(sub_ref.sum()), int(sub_ge3.sum())
        covered = (ev["low"] <= sub_labels) & (sub_labels <= ev["high"])
        s, sp, _ = sens_spec_auc(sub_ref, ev["p_referable"] >= thr, None)
        return {"tierA_share": float((ev["tier"] == "A").mean()),
               "tierB_share": float((ev["tier"] == "B").mean()),
               "tierC_share": float((ev["tier"] == "C").mean()),
               "coverage_marginal": float(covered.mean()),
               "false_autoclear_tierA_ref_rate": (float((sub_ref & is_A).sum()) / n_ref) if n_ref else float("nan"),
               "false_autoclear_tierA_ge3_rate": (float((sub_ge3 & is_A).sum()) / n_ge3) if n_ge3 else float("nan"),
               "referableThreshold_sens": s, "referableThreshold_spec": sp}

    ci = patient_bootstrap(metric_fn, patient_ids, n_boot=n_boot, seed=seed)
    out(f"  95% CI (patient-level bootstrap, n_boot={n_boot}):")
    for k, v in ci.items():
        out(f"    {k:28s} [{v[0]:.4f}, {v[1]:.4f}]")

    return {"n": n, **metrics,
           "referableThreshold": thr, "referableThreshold_sens": thr_sens,
           "referableThreshold_spec": thr_spec, "referableThreshold_auc": thr_auc,
           "patient_bootstrap_ci95": {k: list(v) for k, v in ci.items()}}


def run_part_b_production(tag, manifest, logits5):
    out("\n" + "=" * 78)
    out(f"PART B ({tag}): PRODUCTION-INSTALLED POLICY UNDER SHIFT")
    out("=" * 78)

    calib, calib_path = load_shipped_calibration(tag)
    out(f"Shipped calibration: {calib_path}")
    out(f"  method={calib['method']}  modelVersion={calib['modelVersion']}  "
       f"temperature={calib['temperature']:.4f}  qhatPerStratum={calib['qhatPerStratum']}  "
       f"alphaPerStratum={calib.get('alphaPerStratum')}  referableThreshold={calib['referableThreshold']:.4f}")
    out(f"  fittedOn={calib.get('fittedOn')!r}  fittedAt={calib.get('fittedAt')!r}")

    T = float(calib["temperature"])
    probs = softmax(logits5 / T)
    verify_production_tier_fast(probs, calib)

    y_true = manifest["dr_grade"].values.astype(int)
    patient_ids = manifest["patient_id"].values
    selection_mask = (patient_ids % 2 == 0)
    report_mask = ~selection_mask
    out(f"\nPatient split: SELECTION (even patient_id) = {selection_mask.sum()} images / "
       f"{len(np.unique(patient_ids[selection_mask]))} patients; "
       f"REPORT (odd patient_id) = {report_mask.sum()} images / "
       f"{len(np.unique(patient_ids[report_mask]))} patients")

    sel_result = production_policy_half_report(
        "SELECTION half", y_true[selection_mask], probs[selection_mask],
        patient_ids[selection_mask], calib)
    rep_result = production_policy_half_report(
        "REPORT half", y_true[report_mask], probs[report_mask],
        patient_ids[report_mask], calib)

    # ---- side-by-side with the in-domain cross-fit reference, if on record ----
    crossfit_path = OUT_DIR / f"conformal_v3_crossfit_report_branchA_{tag}.json"
    indomain_ref = None
    if crossfit_path.is_file():
        with open(crossfit_path) as f:
            indomain_ref = json.load(f)[f"crossfit_branchA_{tag}"]
        out(f"\nSIDE BY SIDE: in-domain cross-fit ({crossfit_path.name}) vs Messidor-2 "
           "(single shipped fit applied to each half):")
        out(f"  {'metric':30s} {'in-domain (cross-fit)':>24s} {'Messidor-2 SELECTION':>22s} {'Messidor-2 REPORT':>20s}")
        pairs = [("mean_set_size", "mean_set_size"), ("tierA_share", "tierA_share"),
                ("tierB_share", "tierB_share"), ("tierC_share", "tierC_share"),
                ("coverage_marginal", "coverage_marginal"),
                ("false_autoclear_tierA_ref_rate", "false_autoclear_tierA_ref_rate"),
                ("false_autoclear_tierA_ge3_rate", "false_autoclear_tierA_ge3_rate")]
        for id_key, m2_key in pairs:
            id_val = indomain_ref[id_key]["mean"]
            out(f"  {id_key:30s} {id_val:24.4f} {sel_result[m2_key]:22.4f} {rep_result[m2_key]:20.4f}")
        id_sens = indomain_ref["referable_sensitivity"]["mean"]
        id_spec = indomain_ref["referable_specificity"]["mean"]
        out(f"  {'referableThreshold_sens':30s} {id_sens:24.4f} {sel_result['referableThreshold_sens']:22.4f} "
           f"{rep_result['referableThreshold_sens']:20.4f}")
        out(f"  {'referableThreshold_spec':30s} {id_spec:24.4f} {sel_result['referableThreshold_spec']:22.4f} "
           f"{rep_result['referableThreshold_spec']:20.4f}")
    else:
        out(f"\n(no in-domain cross-fit report on record at {crossfit_path} -- run "
           f"experiments/conformalCrossFitValidation.py --target-version branchA_{tag} first for that reference)")

    return {"tag": tag, "calibration": {k: v for k, v in calib.items() if k != "note"},
           "calibration_path": str(calib_path),
           "selection_half": sel_result, "report_half": rep_result,
           "indomain_cross_fit_reference": indomain_ref}


# ===========================================================================
# PART C: SHIFT DETECTORS (defined before looking at Messidor labels)
# ===========================================================================
def _logsumexp(x, axis=1):
    m = x.max(axis=axis, keepdims=True)
    return (m + np.log(np.exp(x - m).sum(axis=axis, keepdims=True))).squeeze(axis)


def predictive_entropy(probs, eps=1e-12):
    return -np.sum(probs * np.log(probs + eps), axis=1)


def camera_fingerprint_features(bgr):
    h, w = bgr.shape[:2]
    aspect = w / h
    m = max(1, int(0.03 * min(h, w)))
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    border_mask = np.zeros_like(gray, dtype=bool)
    border_mask[:m, :] = True; border_mask[-m:, :] = True
    border_mask[:, :m] = True; border_mask[:, -m:] = True
    mean_border_brightness = float(gray[border_mask].mean())
    meanB, meanG, meanR = (float(bgr[:, :, c].mean()) for c in range(3))
    ratio_rg = meanR / (meanG + 1e-6)
    ratio_bg = meanB / (meanG + 1e-6)
    return np.array([w, h, aspect, mean_border_brightness, ratio_rg, ratio_bg], dtype=np.float64)


CAMERA_FEATURE_NAMES = ["width", "height", "aspect_ratio", "mean_border_brightness",
                        "colour_ratio_R_G", "colour_ratio_B_G"]


def collect_idrid_raw_stats(cache_ids, run_fovea=True):
    """Returns (fovea_peaks, camera_features) arrays for the subset of the
    given v2a cache ids that are IDRiD-sourced AND have a locally resolvable
    raw file. APTOS raw files are not available on this machine, so val/test
    coverage for detectors (v)/(vi) is limited to this IDRiD-only subset -
    disclosed explicitly wherever these numbers are reported."""
    sys.path.insert(0, str(PIPELINE_DIR / "inference"))
    import segInfer  # noqa: E402  (read-only import)
    import io, contextlib
    buf = io.StringIO()

    peaks, feats, kept_idx = [], [], []
    for i, cid in enumerate(cache_ids):
        cid = str(cid)
        if not cid.startswith("idrid"):
            continue
        raw_id, _ = ev.to_row_image_id(cid, IMG_SIZE)
        try:
            path = ev.resolve_idrid_grading_path(raw_id)
        except FileNotFoundError:
            continue
        bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if bgr is None:
            continue
        feats.append(camera_fingerprint_features(bgr))
        if run_fovea:
            with contextlib.redirect_stderr(buf):
                pts = segInfer.localize(bgr)
            peaks.append(pts["fovea"]["peak"])
        kept_idx.append(i)
    return (np.array(peaks) if run_fovea else None), np.array(feats), np.array(kept_idx)


def collect_messidor_raw_stats(manifest, run_fovea=True):
    sys.path.insert(0, str(PIPELINE_DIR / "inference"))
    import segInfer  # noqa: E402
    import io, contextlib
    buf = io.StringIO()

    peaks, feats = [], []
    for p in manifest["image_path"]:
        bgr = cv2.imread(str(MESSIDOR_ROOT / p), cv2.IMREAD_COLOR)
        if bgr is None:
            peaks.append(np.nan); feats.append(np.full(6, np.nan)); continue
        feats.append(camera_fingerprint_features(bgr))
        if run_fovea:
            with contextlib.redirect_stderr(buf):
                pts = segInfer.localize(bgr)
            peaks.append(pts["fovea"]["peak"])
    return (np.array(peaks) if run_fovea else None), np.array(feats)


def detector_report(name, score_val, score_test, score_messidor, direction_note, patient_ids_messidor,
                    messidor_false_clear_mask):
    """score_* already transformed so HIGHER = more anomalous/shifted. Cutoff
    = 95th percentile of score_val (in-domain VAL only, no Messidor peeking)."""
    cutoff = float(np.nanpercentile(score_val, 95))
    frac_messidor = float(np.nanmean(score_messidor > cutoff))
    frac_test = float(np.nanmean(score_test > cutoff))

    domain_label = np.concatenate([np.zeros(len(score_test) + len(score_val)), np.ones(len(score_messidor))])
    pooled_indomain = np.concatenate([score_val, score_test])
    valid = np.isfinite(np.concatenate([pooled_indomain, score_messidor]))
    all_scores = np.concatenate([pooled_indomain, score_messidor])
    auroc = float(roc_auc_score(domain_label[valid], all_scores[valid])) if len(np.unique(domain_label[valid])) > 1 else float("nan")

    flag_messidor = score_messidor > cutoff
    n_false_clear = int(messidor_false_clear_mask.sum())
    n_caught = int((messidor_false_clear_mask & flag_messidor).sum())
    caught_share = n_caught / n_false_clear if n_false_clear else float("nan")

    out(f"  {name:26s} AUROC(domain)={auroc:.4f}  cutoff(valP95)={cutoff:.4f}  "
       f"frac_messidor_flagged={frac_messidor:.4f}  frac_indomain_test_flagged={frac_test:.4f}  "
       f"false_autoclear_caught={n_caught}/{n_false_clear}={caught_share:.4f}   [{direction_note}]")
    return {"auroc": auroc, "cutoff": cutoff, "frac_messidor_flagged": frac_messidor,
           "frac_indomain_test_flagged": frac_test, "false_autoclear_caught": n_caught,
           "false_autoclear_total": n_false_clear, "false_autoclear_caught_share": caught_share,
           "flag_messidor": flag_messidor}


def run_part_c(manifest, logits5, indomain, messidor_false_clear_mask):
    out("\n" + "=" * 78)
    out("PART C: SHIFT DETECTORS (defined on logits/cheap image stats, before Messidor labels)")
    out("=" * 78)

    val_logits, test_logits = indomain["val_logits5"], indomain["test_logits5"]
    val_labels, test_labels = indomain["val_labels"], indomain["test_labels"]
    val_probs, test_probs = softmax(val_logits), softmax(test_logits)
    m_probs = softmax(logits5)

    T = cps.fit_temperature(np.concatenate([val_logits, test_logits]), np.concatenate([val_labels, test_labels]))
    out(f"Temperature fit on pooled in-domain val+test (before touching Messidor): T={T:.4f}")

    results = {}

    # (i) max softmax -> anomaly score = 1 - max_softmax (higher = more anomalous)
    s_val = 1.0 - val_probs.max(axis=1)
    s_test = 1.0 - test_probs.max(axis=1)
    s_mess = 1.0 - m_probs.max(axis=1)
    results["neg_max_softmax"] = detector_report("(i) 1 - max softmax", s_val, s_test, s_mess,
                                                 "higher = less confident", manifest["patient_id"].values,
                                                 messidor_false_clear_mask)

    # (ii) energy = -logsumexp(logits/T) -> higher energy = more anomalous (standard OOD direction)
    s_val = -_logsumexp(val_logits / T)
    s_test = -_logsumexp(test_logits / T)
    s_mess = -_logsumexp(logits5 / T)
    results["energy"] = detector_report(f"(ii) energy (T={T:.3f})", s_val, s_test, s_mess,
                                        "higher = more anomalous (standard OOD energy)",
                                        manifest["patient_id"].values, messidor_false_clear_mask)

    # (iii) max logit -> anomaly score = -max_logit (higher = more anomalous)
    s_val = -val_logits.max(axis=1)
    s_test = -test_logits.max(axis=1)
    s_mess = -logits5.max(axis=1)
    results["neg_max_logit"] = detector_report("(iii) -max logit", s_val, s_test, s_mess,
                                               "higher = lower max logit", manifest["patient_id"].values,
                                               messidor_false_clear_mask)

    # (iv) predictive entropy -> already higher = more anomalous
    s_val = predictive_entropy(val_probs)
    s_test = predictive_entropy(test_probs)
    s_mess = predictive_entropy(m_probs)
    results["entropy"] = detector_report("(iv) predictive entropy", s_val, s_test, s_mess,
                                         "higher = more uncertain", manifest["patient_id"].values,
                                         messidor_false_clear_mask)

    # (v) + (vi): one combined pass over Messidor-2 (each image read once) for both
    # the fovea peak and the camera-fingerprint features.
    out("\nComputing fovea-gate peaks + camera-fingerprint features (CPU) for in-domain "
       "val/test (IDRiD-resolvable subset only - APTOS raw files unavailable) and all "
       "Messidor-2 images (single pass)...")
    val_peaks, val_feats, val_kept = collect_idrid_raw_stats(indomain["val_ids"], run_fovea=True)
    test_peaks, test_feats, test_kept = collect_idrid_raw_stats(indomain["test_ids"], run_fovea=True)
    mess_peaks, mess_feats = collect_messidor_raw_stats(manifest, run_fovea=True)
    out(f"  in-domain val fovea/camera coverage: {len(val_peaks)}/{len(indomain['val_ids'])} "
       f"(IDRiD-resolvable only)   test: {len(test_peaks)}/{len(indomain['test_ids'])}")

    # (v) fovea-gate peak -> anomaly score = -peak (higher = more anomalous / unreliable)
    s_val = -val_peaks
    s_test = -test_peaks
    s_mess = -mess_peaks
    results["fovea_neg_peak"] = detector_report(
        "(v) -fovea peak", s_val, s_test, s_mess,
        "higher = less reliable fovea localization; val/test COVERAGE LIMITED to IDRiD-resolvable subset",
        manifest["patient_id"].values, messidor_false_clear_mask)

    # (vi) camera fingerprint: diagonal z-score^2 sum, fit on in-domain VAL (IDRiD-resolvable) only
    out("\nCamera-fingerprint anomaly score (width/height/aspect/border-brightness/colour ratios)...")
    feat_mean = val_feats.mean(axis=0)
    feat_std = val_feats.std(axis=0) + 1e-6
    out(f"  in-domain VAL (IDRiD-resolvable, n={len(val_feats)}) feature mean/std used to fit the anomaly score:")
    for name, mu, sd in zip(CAMERA_FEATURE_NAMES, feat_mean, feat_std):
        out(f"    {name:24s} mean={mu:10.3f}  std={sd:10.3f}")

    def zsq_sum(feats):
        z = (feats - feat_mean[None, :]) / feat_std[None, :]
        return (z ** 2).sum(axis=1)

    s_val = zsq_sum(val_feats)
    s_test = zsq_sum(test_feats)
    s_mess = zsq_sum(mess_feats)
    results["camera_fingerprint"] = detector_report(
        "(vi) camera fingerprint", s_val, s_test, s_mess,
        "higher = further from in-domain-VAL camera stats (diagonal z^2 sum); "
        "val/test COVERAGE LIMITED to IDRiD-resolvable subset",
        manifest["patient_id"].values, messidor_false_clear_mask)
    if val_feats[:, 0].std() < 1e-6 and val_feats[:, 1].std() < 1e-6:
        caveat = ("CAVEAT on (vi): the in-domain-VAL reference is IDRiD-only (APTOS unavailable "
                 "locally), and every IDRiD image is exactly 4288x2848 (std=0 here) - so width/"
                 "height alone perfectly separate 'is this an IDRiD photo' from anything else. "
                 "The AUROC=1.0 this produces is a 'not-this-exact-camera' detector, not "
                 "evidence of a generally powerful shift signal - it would likely score just as "
                 "perfectly against any other external, non-IDRiD, non-shifted dataset too. "
                 "Read its catch-rate as an upper bound achievable BY CONSTRUCTION here, not as "
                 "a validated real-world shift detector.")
        out(f"  {caveat}")
        results["camera_fingerprint"]["caveat"] = caveat

    # ---- OR-combination of the two best detectors (by domain AUROC) --------
    ranked = sorted(results.items(), key=lambda kv: kv[1]["auroc"], reverse=True)
    best_two = [ranked[0][0], ranked[1][0]]
    out(f"\nTwo best detectors by domain-separation AUROC: {best_two} "
       f"(AUROC={ranked[0][1]['auroc']:.4f}, {ranked[1][1]['auroc']:.4f})")
    combo_flag = results[best_two[0]]["flag_messidor"] | results[best_two[1]]["flag_messidor"]
    frac_messidor_combo = float(combo_flag.mean())
    n_false_clear = int(messidor_false_clear_mask.sum())
    n_caught_combo = int((messidor_false_clear_mask & combo_flag).sum())
    out(f"  OR-combo flags {frac_messidor_combo:.4f} of Messidor-2; "
       f"catches {n_caught_combo}/{n_false_clear} = "
       f"{(n_caught_combo / n_false_clear if n_false_clear else float('nan')):.4f} of the false auto-clears")

    for k in results:
        results[k].pop("flag_messidor", None)  # drop non-JSON-serialisable/bulky array before returning
    results["or_combo"] = {"detectors": best_two, "frac_messidor_flagged": frac_messidor_combo,
                           "false_autoclear_caught": n_caught_combo, "false_autoclear_total": n_false_clear,
                           "false_autoclear_caught_share": (n_caught_combo / n_false_clear if n_false_clear else float("nan"))}
    results["temperature"] = T
    return results


# ===========================================================================
# PART D: SITE-CALIBRATION EXPERIMENT (ADAPTATION, NOT GENERALIZATION)
# This is the one place Messidor-2 LABELS are used to fit a threshold - by
# design, and labelled as such everywhere it's reported.
# ===========================================================================
def run_part_d(manifest, logits5):
    out("\n" + "=" * 78)
    out("PART D: SITE-CALIBRATION EXPERIMENT -- ADAPTATION, NOT GENERALIZATION")
    out("(Messidor-2 labels ARE used to fit a threshold in this part, on purpose)")
    out("=" * 78)

    probs5 = softmax(logits5)
    p_ge2 = probs5[:, 2] + probs5[:, 3] + probs5[:, 4]
    y_true = manifest["dr_grade"].values.astype(int)
    ref_true = y_true >= REFERABLE_FROM
    patient_ids = manifest["patient_id"].values

    is_A = (patient_ids % 2 == 0)
    idxA, idxB = np.where(is_A)[0], np.where(~is_A)[0]
    out(f"Half A (even patient_id): {len(idxA)} images, {len(np.unique(patient_ids[idxA]))} patients")
    out(f"Half B (odd patient_id): {len(idxB)} images, {len(np.unique(patient_ids[idxB]))} patients")

    def lock_and_apply(cal_idx, eval_idx, label):
        lock = posthoc.lock_threshold_on_val(p_ge2[cal_idx], ref_true[cal_idx], 0.95)
        pred_eval = p_ge2[eval_idx] >= lock["threshold"]
        sens, spec, auc_eval = sens_spec_auc(ref_true[eval_idx], pred_eval, p_ge2[eval_idx])
        auc_cal = (float(roc_auc_score(ref_true[cal_idx], p_ge2[cal_idx]))
                  if len(np.unique(ref_true[cal_idx])) > 1 else float("nan"))
        eval_patients = patient_ids[eval_idx]
        eval_ref, eval_pge2 = ref_true[eval_idx], p_ge2[eval_idx]

        def metric_fn(idx):
            s, sp, _ = sens_spec_auc(eval_ref[idx], eval_pge2[idx] >= lock["threshold"], None)
            return {"sens": s, "spec": sp}

        ci = patient_bootstrap(metric_fn, eval_patients)
        out(f"  {label}: threshold={lock['threshold']:.4f}  cal_sens={lock['val_sensitivity']:.4f}  "
           f"cal_spec={lock['val_specificity']:.4f}")
        out(f"    eval sens={sens:.4f} (95% CI [{ci['sens'][0]:.4f},{ci['sens'][1]:.4f}])  "
           f"spec={spec:.4f} (95% CI [{ci['spec'][0]:.4f},{ci['spec'][1]:.4f}])  "
           f"AUC(cal half)={auc_cal:.4f}  AUC(eval half)={auc_eval:.4f}")
        return {"threshold": lock["threshold"], "cal_sens": lock["val_sensitivity"],
               "cal_spec": lock["val_specificity"], "eval_sens": sens, "eval_spec": spec,
               "eval_sens_ci95": list(ci["sens"]), "eval_spec_ci95": list(ci["spec"]),
               "auc_cal_half": auc_cal, "auc_eval_half": auc_eval}

    out("\nA -> B (lock threshold on A's own labels, apply UNCHANGED to B):")
    a_to_b = lock_and_apply(idxA, idxB, "A->B")
    out("\nB -> A (lock threshold on B's own labels, apply UNCHANGED to A):")
    b_to_a = lock_and_apply(idxB, idxA, "B->A")

    out("\nSubsampling random subsets of A's patients at n in {50,100,200,400} (20 repeats each), "
       "always evaluated on the FULL half B:")
    sizes = [50, 100, 200, 400]
    n_repeats = 20
    unique_A_patients = np.unique(patient_ids[idxA])
    rng = np.random.default_rng(SEED)
    subsample_results = {}
    for size in sizes:
        if size > len(unique_A_patients):
            out(f"  n_patients={size}: SKIPPED (only {len(unique_A_patients)} patients available in A)")
            continue
        sens_list, spec_list = [], []
        for _ in range(n_repeats):
            chosen = rng.choice(unique_A_patients, size=size, replace=False)
            cal_idx = idxA[np.isin(patient_ids[idxA], chosen)]
            if ref_true[cal_idx].sum() == 0 or (~ref_true[cal_idx]).sum() == 0:
                continue  # degenerate calibration subset (single class) - skip this repeat
            lock = posthoc.lock_threshold_on_val(p_ge2[cal_idx], ref_true[cal_idx], 0.95)
            pred_eval = p_ge2[idxB] >= lock["threshold"]
            sens, spec, _ = sens_spec_auc(ref_true[idxB], pred_eval, None)
            sens_list.append(sens); spec_list.append(spec)
        sens_arr, spec_arr = np.array(sens_list), np.array(spec_list)
        out(f"  n_patients={size:4d} (valid repeats={len(sens_list)}/{n_repeats}): "
           f"sens mean={sens_arr.mean():.4f} std={sens_arr.std():.4f} "
           f"[{sens_arr.min():.4f},{sens_arr.max():.4f}]   "
           f"spec mean={spec_arr.mean():.4f} std={spec_arr.std():.4f} "
           f"[{spec_arr.min():.4f},{spec_arr.max():.4f}]")
        subsample_results[str(size)] = {
            "n_valid_repeats": len(sens_list),
            "sens_mean": float(sens_arr.mean()), "sens_std": float(sens_arr.std()),
            "sens_min": float(sens_arr.min()), "sens_max": float(sens_arr.max()),
            "spec_mean": float(spec_arr.mean()), "spec_std": float(spec_arr.std()),
            "spec_min": float(spec_arr.min()), "spec_max": float(spec_arr.max()),
        }

    return {"A_to_B": a_to_b, "B_to_A": b_to_a, "subsampling": subsample_results,
           "n_patients_A": int(len(unique_A_patients)), "n_patients_B": int(len(np.unique(patient_ids[idxB])))}


# ===========================================================================
# MAIN
# ===========================================================================
def main():
    t0 = time.time()
    parts_arg = None
    tag = "v2a"
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith("--parts"):
            if "=" in a:
                parts_arg = a.split("=", 1)[1]
            else:
                parts_arg = args[i + 1]; i += 1
        elif a.startswith("--tag"):
            if "=" in a:
                tag = a.split("=", 1)[1]
            else:
                tag = args[i + 1]; i += 1
        i += 1

    parts = set(parts_arg.split(",")) if parts_arg else ({"A", "B", "C", "D"} if tag == "v2a" else {"B", "D"})
    if tag != "v2a" and (parts & {"A", "C"}):
        raise SystemExit(f"Parts A/C are not generalized beyond tag='v2a' (requested parts={sorted(parts)} "
                         f"for tag={tag!r}). Pass --parts B,D (or omit --parts) for a non-v2a tag.")

    out("=" * 78)
    out(f"MESSIDOR-2 EXTERNAL-SHIFT STRESS TEST OF THE {tag} PIPELINE")
    out(f"parts run: {sorted(parts)}")
    out("=" * 78)

    manifest, logits5 = load_messidor(tag)
    indomain = load_indomain_val_test(tag)
    out(f"Messidor-2: n={len(manifest)}, {manifest['patient_id'].nunique()} patients   "
       f"in-domain: val n={len(indomain['val_labels'])}, test n={len(indomain['test_labels'])}")

    report = {"tag": tag}
    b_result = None
    if "A" in parts:
        report["part_a"] = run_part_a(manifest, logits5, indomain)
    if "B" in parts:
        if tag == "v2a":
            b_result = run_part_b(manifest, logits5, indomain)
            report["part_b"] = {k: v for k, v in b_result.items() if not k.startswith("_")}
        else:
            report["part_b"] = run_part_b_production(tag, manifest, logits5)
    if "C" in parts:
        if b_result is None:
            b_result = run_part_b(manifest, logits5, indomain)
            report.setdefault("part_b", {k: v for k, v in b_result.items() if not k.startswith("_")})
        report["part_c"] = run_part_c(manifest, logits5, indomain, b_result["_false_clear_mask_ref"])
    if "D" in parts:
        report["part_d"] = run_part_d(manifest, logits5)

    # ---- closing plain statements -------------------------------------------
    out("\n" + "=" * 78)
    out("CLOSING STATEMENTS")
    out("=" * 78)
    closing = {}
    if "A" in parts and "B" in parts and "D" in parts:
        closing["i_preprocessing_or_data_artifact"] = (
            "NOT a preprocessing/pipeline bug: the montage shows clean, correctly-cropped "
            "512px circles on Messidor-2, matching IDRiD's framing. There IS a real, visible "
            "camera colour-domain difference (cooler grey-green vs IDRiD's warmer cast), and "
            ".jpg-format images perform measurably worse than .png (lower AUC/sens), but "
            "neither fully explains the drop - .png alone (the majority format) still shows a "
            "large sensitivity gap vs in-domain. Verdict: a minor contributor, not the main cause."
        )
        closing["ii_threshold_calibration"] = (
            "A LARGE part of the drop IS threshold-calibration failure, not model failure: "
            "the in-domain-locked P(g>=2) threshold (~0.30) is simply wrong for Messidor-2's "
            "shifted score distribution. Site-calibration (Part D) using Messidor-2's OWN "
            "labels finds the right threshold is ~0.01-0.014, and doing so restores sensitivity "
            "to ~94-97% (matching the 95% target) even from as few as 50-100 labelled patients. "
            "Verdict: a major, and genuinely fixable-by-recalibration, contributor."
        )
        closing["iii_ranking_quality"] = (
            "There is ALSO real ranking (AUC) degradation, not just a wrong threshold: AUC of "
            "P(g>=2) drops from 0.983 (in-domain held-out test) to 0.868 (Messidor-2), a 0.115 "
            "absolute drop. This is why even the BEST site-calibrated threshold in Part D still "
            "leaves specificity at only ~31-44%, far below in-domain's ~90% at the same "
            "sensitivity - a lower AUC means sensitivity and specificity trade off much more "
            "sharply on Messidor-2, and no threshold choice escapes that. Verdict: a major "
            "contributor that site-calibration alone cannot fully fix."
        )
        for line in closing.values():
            out("\n" + line)
    else:
        out("(closing statements require parts A, B, and D - skipped since not all were run)")
    report["closing_statements"] = closing

    report["wall_time_seconds"] = time.time() - t0
    # GENERALIZE (--tag): v2a keeps its ORIGINAL, unsuffixed report filenames
    # (byte-identical path to before this generalization); any other tag gets
    # its own suffixed report so it never overwrites v2a's own record.
    suffix = "" if tag == "v2a" else f"_{tag}"
    report_json = OUT_DIR / f"messidor2_shift_stress_test{suffix}.json"
    report_txt = OUT_DIR / f"messidor2_shift_stress_test{suffix}.txt"
    with open(report_json, "w") as f:
        json.dump(report, f, indent=2, default=lambda o: o.item() if isinstance(o, np.generic)
                  else o.tolist() if isinstance(o, np.ndarray) else str(o))
    out(f"\nWrote {report_json}")
    with open(report_txt, "w", encoding="utf-8") as f:
        f.write("\n".join(OUT_LINES) + "\n")
    out(f"Wrote {report_txt}")
    out(f"\nTotal wall time: {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
