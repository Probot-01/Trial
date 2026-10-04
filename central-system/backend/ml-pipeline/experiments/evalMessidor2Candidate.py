

import argparse
import datetime
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import torch
from scipy.special import softmax as _softmax
from sklearn.metrics import cohen_kappa_score

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import evalMessidor2V2a as ref        # noqa: E402  fidelity-checked preprocessing/model/dataset/cache pattern
import evalV2aPostHoc as posthoc      # noqa: E402  lock_threshold_on_val, safe_auc (correct VAL->TEST discipline)
import conformalPolicySweep2 as sweep2  # noqa: E402  C5v3 replica (fit_temperature, config_C5, scores, tiering)

PIPELINE_DIR = HERE.parent
MODEL1_DIR = PIPELINE_DIR / "models" / "Model1"
MESSIDOR_ROOT = PIPELINE_DIR / "datasets" / "Messidor-2"
OUT_DIR = PIPELINE_DIR / "diagnostics" / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)
FINAL_LOG = OUT_DIR / "final_report_log.txt"

DEVICE = ref.DEVICE
NUM_CLASSES = 5
REFERABLE_FROM = 2
N_BOOTSTRAP = 2000
BOOT_SEED = 42
VAL_TARGET = 0.95  # task item 3: both operating points are locked at 0.95 sensitivity on VAL

REFERENCE_FULLSET_AUC = 0.868      # task item 6
REFERENCE_FULLSET_AUC_TOL = 0.002  # matches the JSON's 0.8678 to 3dp

# Path 1 / Path 2 decision-rule thresholds (task item 5)
PATH1 = {"min_auc_gain": 0.02, "max_val_auc_regress": 0.01, "max_val_qwk_regress": 0.01}
PATH2 = {"min_auc_gain": 0.05, "max_val_auc_regress": 0.02, "max_val_qwk_regress": 0.02}
INCUMBENT_TAG = "v2a"


# ═══════════════════════════════════════════════════════════════════════════
# Generic (tag-parameterised) model loading + in-domain arrays
# ═══════════════════════════════════════════════════════════════════════════
def checkpoint_path_for_tag(tag):
    return MODEL1_DIR / tag / f"branchA_{tag}.pt"


def load_model_generic(ckpt_path):
    ckpt = torch.load(str(ckpt_path), map_location="cpu", weights_only=False)
    assert tuple(ckpt["normalize_mean"]) == ref.IMAGENET_MEAN, "checkpoint normalize_mean drifted from ImageNet stats"
    assert tuple(ckpt["normalize_std"]) == ref.IMAGENET_STD, "checkpoint normalize_std drifted from ImageNet stats"
    assert ckpt["channel_order"] == "RGB"
    model = ref.DRClassifierV2(ckpt["model_name"], ckpt["num_classes"], ckpt["drop_rate"], pretrained=False)
    model.load_state_dict(ckpt["model_state_dict"], strict=True)
    model.to(DEVICE)
    model.eval()
    img_size = ckpt["img_size"]
    print(f"Loaded {ckpt_path}: {ckpt['model_name']}  img_size={img_size}  "
          f"drop_rate={ckpt['drop_rate']}  epoch={ckpt.get('epoch')}  "
          f"val_qwk={ckpt.get('val_qwk')}")
    return model, ckpt, img_size


def load_in_domain_arrays(tag):
    """models/Model1/<tag>/branchA_<tag>_{val,test}_{ids,labels,logits,binary_logits}.npy
    -- the convention v2a already uses. Required for any tag this script runs on."""
    d = MODEL1_DIR / tag
    out = {}
    for split in ("val", "test"):
        out[split] = {
            "ids": np.load(d / f"branchA_{tag}_{split}_ids.npy", allow_pickle=True),
            "labels": np.load(d / f"branchA_{tag}_{split}_labels.npy").astype(int),
            "logits5": np.load(d / f"branchA_{tag}_{split}_logits.npy").astype(np.float64),
            "logits_bin": np.load(d / f"branchA_{tag}_{split}_binary_logits.npy").astype(np.float64),
        }
    return out


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.asarray(x, dtype=np.float64)))


def p_ge2_from_logits5(logits5):
    p = ref.softmax(logits5)
    return p[:, 2] + p[:, 3] + p[:, 4]



ENSEMBLE_RE = re.compile(r"^ens\(([^)]+)\)$")


def is_ensemble_tag(tag):
    return bool(ENSEMBLE_RE.match(tag))


def ensemble_components(tag):
    m = ENSEMBLE_RE.match(tag)
    if not m:
        raise ValueError(f"{tag!r} is not an ensemble tag (expected 'ens(tagA,tagB,...)')")
    comps = [c.strip() for c in m.group(1).split(",") if c.strip()]
    if len(comps) < 2:
        raise ValueError(f"ensemble tag {tag!r} needs >= 2 components, got {comps}")
    return comps


def logits_from_probs5(probs5, eps=1e-12):
    """Pseudo-logits for a 5-class probability vector: softmax(log(p)) == p
    exactly when p sums to 1 (exp(log(p_i)) / sum(exp(log(p_j))) = p_i /
    sum(p_j) = p_i). Renormalised before the log to guard against drift from
    averaging/clipping."""
    p = np.clip(probs5, eps, 1.0)
    p = p / p.sum(axis=-1, keepdims=True)
    return np.log(p)


def bin_logit_from_prob(p, eps=1e-9):
    """Exact inverse of sigmoid: sigmoid(logit(p)) == p."""
    p = np.clip(np.asarray(p, dtype=np.float64), eps, 1.0 - eps)
    return np.log(p / (1.0 - p))


# ═══════════════════════════════════════════════════════════════════════════
# Messidor-2 inference cache (task item 1: exactly 3 named files per tag)
# ═══════════════════════════════════════════════════════════════════════════
def cache_paths(tag):
    return (OUT_DIR / f"messidor2_{tag}_logits5.npy",
            OUT_DIR / f"messidor2_{tag}_logitsBin.npy",
            OUT_DIR / f"messidor2_{tag}_ids.npy")


def cache_meta_path(tag):
    return OUT_DIR / f"messidor2_{tag}_meta.json"


def try_load_messidor_cache(tag, precision, manifest_df):
    """Returns (logits5, logits_bin) if a valid cache hit, else None. Split
    out from run_or_load_messidor_inference so ensemble components can be
    read from cache without needing their model loaded at all when the cache
    is already warm (as it will be for v2a/v2b once each has been run once)."""
    p_logits5, p_logits_bin, p_ids = cache_paths(tag)
    p_meta = cache_meta_path(tag)
    ids = manifest_df["image_path"].tolist()
    if not (p_logits5.is_file() and p_logits_bin.is_file() and p_ids.is_file()):
        return None
    cached_ids = np.load(p_ids, allow_pickle=True).tolist()
    if cached_ids != ids:
        print(f"Cache for tag={tag!r} exists but its ids differ from the current manifest -- recomputing.")
        return None
    meta = json.loads(p_meta.read_text()) if p_meta.is_file() else {}
    if meta.get("precision") != precision:
        print(f"Cache for tag={tag!r} exists (ids match) but was computed at "
              f"precision={meta.get('precision')!r}, not the requested {precision!r} -- recomputing.")
        return None
    print(f"Using cached Messidor-2 logits for tag={tag!r} precision={precision!r} "
          f"(n={len(ids)}): {p_logits5.name}, {p_logits_bin.name}")
    return np.load(p_logits5), np.load(p_logits_bin)


def run_or_load_messidor_inference(model, img_size, transform, manifest_df, tag, precision):
    cached = try_load_messidor_cache(tag, precision, manifest_df)
    if cached is not None:
        return cached
    ids = manifest_df["image_path"].tolist()
    p_logits5, p_logits_bin, p_ids = cache_paths(tag)
    p_meta = cache_meta_path(tag)

    use_amp = (precision == "fp16")
    print(f"\nRunning {precision} inference on {len(manifest_df)} Messidor-2 images "
          f"(device={DEVICE}, img_size={img_size})...")
    paths = [str(MESSIDOR_ROOT / p) for p in manifest_df["image_path"]]
    ds = ref.MessidorDataset(paths, img_size, transform)
    loader = torch.utils.data.DataLoader(ds, batch_size=16, shuffle=False, num_workers=6)

    logits5 = np.zeros((len(ds), NUM_CLASSES), dtype=np.float32)
    logits_bin = np.zeros((len(ds),), dtype=np.float32)
    t0 = time.time()
    n_done = 0
    with torch.no_grad():
        for imgs, idx in loader:
            imgs = imgs.to(DEVICE, non_blocking=True)
            with ref.amp_autocast(enabled=use_amp):
                l5, lb = model(imgs)
            idx_np = idx.numpy()
            logits5[idx_np] = l5.float().cpu().numpy()
            logits_bin[idx_np] = lb.float().cpu().numpy()
            n_done += len(idx_np)
            if n_done % 320 == 0 or n_done == len(ds):
                print(f"  {n_done}/{len(ds)}  ({time.time() - t0:.1f}s elapsed)")

    np.save(p_logits5, logits5)
    np.save(p_logits_bin, logits_bin)
    np.save(p_ids, np.array(ids, dtype=object))
    p_meta.write_text(json.dumps({"precision": precision, "n": len(ids), "tag": tag,
                                  "written_at_utc": datetime.datetime.utcnow().isoformat()}, indent=2))
    print(f"Cached: {p_logits5.name}, {p_logits_bin.name}, {p_ids.name}  (precision={precision})")
    return logits5, logits_bin

def get_messidor_logits_for_tag(tag, precision, manifest_df):
    """Returns (logits5, logits_bin) for `tag`. For a real tag: cache first,
    loading the checkpoint only on a cache miss. For an ensemble tag: gets
    each component's (logits5, logits_bin) the same way (recursively, so
    ensembles-of-ensembles work), averages PROBABILITIES per image, and
    converts back to pseudo-logits (see logits_from_probs5/bin_logit_from_prob)."""
    if is_ensemble_tag(tag):
        comps = ensemble_components(tag)
        probs5_list, probbin_list = [], []
        for c in comps:
            l5, lb = get_messidor_logits_for_tag(c, precision, manifest_df)
            probs5_list.append(_softmax(l5, axis=1))
            probbin_list.append(sigmoid(lb))
        probs5_avg = np.mean(probs5_list, axis=0)
        probbin_avg = np.mean(probbin_list, axis=0)
        print(f"Ensemble {tag!r}: averaged softmax probabilities of {comps} "
              f"over {len(manifest_df)} Messidor-2 images (both heads).")
        return logits_from_probs5(probs5_avg), bin_logit_from_prob(probbin_avg)

    cached = try_load_messidor_cache(tag, precision, manifest_df)
    if cached is not None:
        return cached
    ckpt_path = checkpoint_path_for_tag(tag)
    if not ckpt_path.is_file():
        raise FileNotFoundError(
            f"No Messidor-2 cache for tag {tag!r} and no checkpoint at the conventional path "
            f"{ckpt_path} (models/Model1/<tag>/branchA_<tag>.pt) to compute one.")
    model, ckpt, img_size = load_model_generic(ckpt_path)
    transform = ref.build_eval_transform(img_size)
    return run_or_load_messidor_inference(model, img_size, transform, manifest_df, tag, precision)


def get_in_domain_arrays_for_tag(tag):
    """Returns {"val": {...}, "test": {...}} for `tag`, each with ids/labels/
    logits5/logits_bin - real tag: load_in_domain_arrays. Ensemble tag:
    average each component's SAVED probabilities per split (asserting ids/
    labels line up exactly across components - a real correctness check, not
    a formality, since silently averaging misaligned rows would be wrong)."""
    if not is_ensemble_tag(tag):
        return load_in_domain_arrays(tag)

    comps = ensemble_components(tag)
    out = {}
    for split in ("val", "test"):
        probs5_list, probbin_list = [], []
        ref_ids = ref_labels = None
        for c in comps:
            arr = load_in_domain_arrays(c)[split]
            if ref_ids is None:
                ref_ids, ref_labels = arr["ids"], arr["labels"]
            else:
                assert list(arr["ids"]) == list(ref_ids), (
                    f"ensemble {tag!r}: component {c!r}'s {split} ids do not match {comps[0]!r}'s - "
                    f"cannot average mismatched rows.")
                assert np.array_equal(arr["labels"], ref_labels), (
                    f"ensemble {tag!r}: component {c!r}'s {split} labels do not match {comps[0]!r}'s.")
            probs5_list.append(_softmax(arr["logits5"], axis=1))
            probbin_list.append(sigmoid(arr["logits_bin"]))
        probs5_avg = np.mean(probs5_list, axis=0)
        probbin_avg = np.mean(probbin_list, axis=0)
        out[split] = {"ids": ref_ids, "labels": ref_labels,
                     "logits5": logits_from_probs5(probs5_avg), "logits_bin": bin_logit_from_prob(probbin_avg)}
    print(f"Ensemble {tag!r}: averaged in-domain val/test probabilities of {comps} "
         f"(val n={len(out['val']['labels'])}, test n={len(out['test']['labels'])}, ids/labels verified aligned).")
    return out


def verify_v2a_fullset_auc(manifest_df, logits5):
    """Task item 6: the cached 5-class logits must reproduce the earlier
    full-set (all 1,744) report -- AUC 0.868 -- exactly the number
    diagnostics/out/messidor2_v2a_external_validation.json already recorded
    (0.8678...). Full-set here means ALL 1,744, selection+report combined,
    matching how that earlier report was computed (it predates this
    script's peek-proof split)."""
    y_true = manifest_df["dr_grade"].values.astype(int)
    ref_true = y_true >= REFERABLE_FROM
    p_ge2 = p_ge2_from_logits5(logits5)
    auc = float(posthoc.safe_auc(ref_true, p_ge2))
    ok = abs(auc - REFERENCE_FULLSET_AUC) <= REFERENCE_FULLSET_AUC_TOL
    print("\n" + "=" * 78)
    print("ITEM 6 VERIFICATION: cached v2a logits reproduce the earlier full-set report")
    print("=" * 78)
    print(f"  full-set (n=1744) AUC of P(g>=2): {auc:.4f}  (target {REFERENCE_FULLSET_AUC} "
          f"+/- {REFERENCE_FULLSET_AUC_TOL})  -> {'PASS' if ok else 'FAIL'}")
    return ok, auc


# ═══════════════════════════════════════════════════════════════════════════
# C5v3 replica (task item 3/4): fitted on the candidate's pooled in-domain
# val+test, applied to Messidor-2 -- NEVER refit on Messidor-2 itself.
# ═══════════════════════════════════════════════════════════════════════════
def fit_c5v3_on_pooled_indomain(indom):
    val, test = indom["val"], indom["test"]
    pool_logits = np.concatenate([val["logits5"], test["logits5"]])
    pool_labels = np.concatenate([val["labels"], test["labels"]])
    T = sweep2.fit_temperature(pool_logits, pool_labels)
    pool_probs = _softmax(pool_logits / T, axis=1)
    qhat, n_g, rank_g, sat, alpha, group_labels = sweep2.config_C5(pool_probs, pool_labels, sweep2.true_scores_v3)
    print(f"\nC5v3 policy fitted on pooled in-domain val+test (n={len(pool_labels)}): "
          f"T={T:.4f}  qhatPerClass={np.round(qhat, 4).tolist()}  "
          f"nCalPerGroup={n_g.tolist()}  groups={group_labels}")
    return T, qhat


def c5v3_within01_flags(logits5, T, qhat):
    """Per-image bool: True if the C5v3 prediction set lies entirely within
    {0,1} (i.e. would be auto-cleared, absent any override) -- the same
    'set_within_01' definition conformalPolicySweep2.fold_metrics uses for
    false_auto_clear_ref/ge3."""
    probs = _softmax(logits5 / T, axis=1)
    n = len(logits5)
    within01 = np.zeros(n, dtype=bool)
    for i in range(n):
        _tier, _pred_set, _lo, hi = sweep2.assign_tier_ordinal(probs[i], qhat, sweep2.row_scores_v3)
        within01[i] = hi < REFERABLE_FROM
    return within01


# ═══════════════════════════════════════════════════════════════════════════
# Point-estimate metrics (shared by selection/report halves and in-domain)
# ═══════════════════════════════════════════════════════════════════════════
def compute_point_metrics(y_true, logits5, logits_bin, locked_5class, locked_bin):
    ref_true = y_true >= REFERABLE_FROM
    p_ge2 = p_ge2_from_logits5(logits5)
    p_bin = sigmoid(logits_bin)
    pred_argmax = logits5.argmax(axis=1)

    auc_5class = posthoc.safe_auc(ref_true, p_ge2)
    auc_bin = posthoc.safe_auc(ref_true, p_bin)
    qwk = float(cohen_kappa_score(y_true, pred_argmax, weights="quadratic")) \
        if len(np.unique(y_true)) > 1 else float("nan")
    grade_recall = ref.per_grade_recall(y_true, pred_argmax)
    grade0_share = float((pred_argmax == 0).mean())

    def sens_spec_at(score, thr):
        pred = score >= thr
        tp = int((ref_true & pred).sum()); fn = int((ref_true & ~pred).sum())
        tn = int((~ref_true & ~pred).sum()); fp = int((~ref_true & pred).sum())
        return (tp / (tp + fn) if (tp + fn) else float("nan"),
                tn / (tn + fp) if (tn + fp) else float("nan"))

    op_5class = None
    if locked_5class is not None:
        s, sp = sens_spec_at(p_ge2, locked_5class["threshold"])
        op_5class = {"threshold": locked_5class["threshold"], "sens": s, "spec": sp}
    op_bin = None
    if locked_bin is not None:
        s, sp = sens_spec_at(p_bin, locked_bin["threshold"])
        op_bin = {"threshold": locked_bin["threshold"], "sens": s, "spec": sp}

    ref_pred_argmax = pred_argmax >= REFERABLE_FROM
    tp = int((ref_true & ref_pred_argmax).sum()); fn = int((ref_true & ~ref_pred_argmax).sum())
    tn = int((~ref_true & ~ref_pred_argmax).sum()); fp = int((~ref_true & ref_pred_argmax).sum())
    op_argmax = {"sens": tp / (tp + fn) if (tp + fn) else float("nan"),
                 "spec": tn / (tn + fp) if (tn + fp) else float("nan")}

    return {
        "n": int(len(y_true)),
        "auc_p_ge2_5class": auc_5class, "auc_binary_head": auc_bin,
        "qwk": qwk, "grade_recall": grade_recall, "grade0_share": grade0_share,
        "op_5class_at_0.95": op_5class, "op_binary_at_0.95": op_bin, "op_argmax": op_argmax,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Selection/report-half evaluation: point metrics + patient-level bootstrap
# ═══════════════════════════════════════════════════════════════════════════
def evaluate_half(y_true, logits5, logits_bin, patient_ids, locked_5class, locked_bin,
                  c5v3_T, c5v3_qhat, n_boot=N_BOOTSTRAP, seed=BOOT_SEED):
    n = len(y_true)
    ref_true = y_true >= REFERABLE_FROM
    ge3_true = y_true >= 3
    p_ge2 = p_ge2_from_logits5(logits5)
    p_bin = sigmoid(logits_bin)
    pred_argmax = logits5.argmax(axis=1)

    point = compute_point_metrics(y_true, logits5, logits_bin, locked_5class, locked_bin)

    within01 = c5v3_within01_flags(logits5, c5v3_T, c5v3_qhat)
    n_ref = int(ref_true.sum()); n_ge3 = int(ge3_true.sum())
    fac_ref_k = int((ref_true & within01).sum()); fac_ge3_k = int((ge3_true & within01).sum())
    point["false_auto_clear_ref"] = {"k": fac_ref_k, "n": n_ref,
                                     "rate": (fac_ref_k / n_ref) if n_ref else float("nan")}
    point["false_auto_clear_ge3"] = {"k": fac_ge3_k, "n": n_ge3,
                                     "rate": (fac_ge3_k / n_ge3) if n_ge3 else float("nan")}

    unique_patients = np.unique(patient_ids)
    patient_to_idx = {p: np.where(patient_ids == p)[0] for p in unique_patients}
    n_p = len(unique_patients)
    rng = np.random.default_rng(seed)

    keys = (["auc_p_ge2_5class", "auc_binary_head", "qwk", "grade0_share",
            "op_5class_sens", "op_5class_spec", "op_bin_sens", "op_bin_spec",
            "op_argmax_sens", "op_argmax_spec", "fac_ref", "fac_ge3"] +
           [f"grade{g}_recall" for g in range(NUM_CLASSES)])
    boot = {k: [] for k in keys}

    for _ in range(n_boot):
        sampled = rng.choice(unique_patients, size=n_p, replace=True)
        idx = np.concatenate([patient_to_idx[p] for p in sampled])
        yt, rt, g3t = y_true[idx], ref_true[idx], ge3_true[idx]
        pg2, pb, pa, wi = p_ge2[idx], p_bin[idx], pred_argmax[idx], within01[idx]

        auc5 = posthoc.safe_auc(rt, pg2); boot["auc_p_ge2_5class"].append(auc5 if auc5 is not None else np.nan)
        aucb = posthoc.safe_auc(rt, pb); boot["auc_binary_head"].append(aucb if aucb is not None else np.nan)
        boot["qwk"].append(cohen_kappa_score(yt, pa, weights="quadratic") if len(np.unique(yt)) > 1 else np.nan)
        boot["grade0_share"].append(float((pa == 0).mean()))

        if locked_5class is not None:
            pred = pg2 >= locked_5class["threshold"]
            tp = int((rt & pred).sum()); fn = int((rt & ~pred).sum())
            tn = int((~rt & ~pred).sum()); fp = int((~rt & pred).sum())
            boot["op_5class_sens"].append(tp / (tp + fn) if (tp + fn) else np.nan)
            boot["op_5class_spec"].append(tn / (tn + fp) if (tn + fp) else np.nan)
        else:
            boot["op_5class_sens"].append(np.nan); boot["op_5class_spec"].append(np.nan)

        if locked_bin is not None:
            pred = pb >= locked_bin["threshold"]
            tp = int((rt & pred).sum()); fn = int((rt & ~pred).sum())
            tn = int((~rt & ~pred).sum()); fp = int((~rt & pred).sum())
            boot["op_bin_sens"].append(tp / (tp + fn) if (tp + fn) else np.nan)
            boot["op_bin_spec"].append(tn / (tn + fp) if (tn + fp) else np.nan)
        else:
            boot["op_bin_sens"].append(np.nan); boot["op_bin_spec"].append(np.nan)

        rpa = pa >= REFERABLE_FROM
        tp = int((rt & rpa).sum()); fn = int((rt & ~rpa).sum())
        tn = int((~rt & ~rpa).sum()); fp = int((~rt & rpa).sum())
        boot["op_argmax_sens"].append(tp / (tp + fn) if (tp + fn) else np.nan)
        boot["op_argmax_spec"].append(tn / (tn + fp) if (tn + fp) else np.nan)

        n_ref_b, n_ge3_b = int(rt.sum()), int(g3t.sum())
        boot["fac_ref"].append(float((rt & wi).sum()) / n_ref_b if n_ref_b else np.nan)
        boot["fac_ge3"].append(float((g3t & wi).sum()) / n_ge3_b if n_ge3_b else np.nan)

        for g in range(NUM_CLASSES):
            gm = yt == g
            boot[f"grade{g}_recall"].append(float((pa[gm] == g).sum() / gm.sum()) if gm.sum() else np.nan)

    ci = {k: (float(np.nanpercentile(v, 2.5)), float(np.nanpercentile(v, 97.5))) for k, v in boot.items()}
    return point, ci


def print_half_report(label, n, point, ci):
    print(f"\n--- {label} (n={n}, {point['n']} images) ---")
    print(f"AUC P(g>=2) [5-class]  : {point['auc_p_ge2_5class']:.4f}  "
          f"95% CI [{ci['auc_p_ge2_5class'][0]:.4f}, {ci['auc_p_ge2_5class'][1]:.4f}]")
    print(f"AUC [binary head]      : {point['auc_binary_head']:.4f}  "
          f"95% CI [{ci['auc_binary_head'][0]:.4f}, {ci['auc_binary_head'][1]:.4f}]")
    print(f"QWK                    : {point['qwk']:.4f}  "
          f"95% CI [{ci['qwk'][0]:.4f}, {ci['qwk'][1]:.4f}]")
    print(f"Predicted grade-0 share: {point['grade0_share']:.4f}  "
          f"95% CI [{ci['grade0_share'][0]:.4f}, {ci['grade0_share'][1]:.4f}]")
    for name, op, sk, spk in [("5-class@0.95", point["op_5class_at_0.95"], "op_5class_sens", "op_5class_spec"),
                              ("binary@0.95", point["op_binary_at_0.95"], "op_bin_sens", "op_bin_spec"),
                              ("argmax>=2", point["op_argmax"], "op_argmax_sens", "op_argmax_spec")]:
        if op is None:
            print(f"  {name:14s}: UNREACHABLE on VAL at target {VAL_TARGET:.0%}")
            continue
        print(f"  {name:14s}: sens={op['sens']:.4f} [{ci[sk][0]:.4f},{ci[sk][1]:.4f}]  "
              f"spec={op['spec']:.4f} [{ci[spk][0]:.4f},{ci[spk][1]:.4f}]")
    print("Per-grade recall:")
    for g in range(NUM_CLASSES):
        r = point["grade_recall"][g]
        clo, chi = ci[f"grade{g}_recall"]
        print(f"  grade {g}: recall={r['recall']:.4f}  n={r['n']}  95% CI [{clo:.4f},{chi:.4f}]")
    fr, fg3 = point["false_auto_clear_ref"], point["false_auto_clear_ge3"]
    print(f"False auto-clear (C5v3), true referable : {fr['rate']:.4f} ({fr['k']}/{fr['n']})  "
          f"95% CI [{ci['fac_ref'][0]:.4f},{ci['fac_ref'][1]:.4f}]")
    print(f"False auto-clear (C5v3), true grade>=3   : {fg3['rate']:.4f} ({fg3['k']}/{fg3['n']})  "
          f"95% CI [{ci['fac_ge3'][0]:.4f},{ci['fac_ge3'][1]:.4f}]")


def print_indomain_report(label, point):
    print(f"\n--- IN-DOMAIN {label} (n={point['n']}) ---")
    print(f"QWK                     : {point['qwk']:.4f}")
    print(f"AUC P(g>=2) [5-class]   : {point['auc_p_ge2_5class']}")
    print(f"AUC [binary head]       : {point['auc_binary_head']}")
    for name, op in [("5-class@0.95", point["op_5class_at_0.95"]),
                     ("binary@0.95", point["op_binary_at_0.95"]),
                     ("argmax>=2", point["op_argmax"])]:
        if op is None:
            print(f"  {name:14s}: UNREACHABLE on VAL at target {VAL_TARGET:.0%}")
        else:
            print(f"  {name:14s}: sens={op['sens']:.4f}  spec={op['spec']:.4f}")
    g4 = point["grade_recall"][4]
    print(f"Grade-4 recall          : {g4['recall']:.4f}  (n={g4['n']})")


# ═══════════════════════════════════════════════════════════════════════════
# Single-candidate run
# ═══════════════════════════════════════════════════════════════════════════
def run_single(checkpoint_path, tag, final, precision, n_boot):
    print("=" * 78)
    print(f"evalMessidor2Candidate.py -- tag={tag}  checkpoint={checkpoint_path}  "
          f"precision={precision}  final={final}")
    print("=" * 78)

    manifest_df = ref.load_manifest()
    print(f"\nMessidor-2 manifest: {len(manifest_df)} gradable images, "
          f"{manifest_df['patient_id'].nunique()} unique patients")

    logits5, logits_bin = get_messidor_logits_for_tag(tag, precision, manifest_df)

    if tag == INCUMBENT_TAG:
        verify_v2a_fullset_auc(manifest_df, logits5)

    indom = get_in_domain_arrays_for_tag(tag)
    val, test = indom["val"], indom["test"]
    val_ref_true = val["labels"] >= REFERABLE_FROM

    print("\n" + "=" * 78)
    print(f"OPERATING POINTS LOCKED ON {tag}'s OWN VAL (target {VAL_TARGET:.0%} sensitivity)")
    print("=" * 78)
    locked_5class = posthoc.lock_threshold_on_val(p_ge2_from_logits5(val["logits5"]), val_ref_true, VAL_TARGET)
    locked_bin = posthoc.lock_threshold_on_val(sigmoid(val["logits_bin"]), val_ref_true, VAL_TARGET)
    if locked_5class:
        print(f"  5-class P(g>=2): threshold={locked_5class['threshold']:.4f}  "
              f"val_sens={locked_5class['val_sensitivity']:.4f}  val_spec={locked_5class['val_specificity']:.4f}")
    else:
        print(f"  5-class P(g>=2): UNREACHABLE at {VAL_TARGET:.0%} on VAL")
    if locked_bin:
        print(f"  binary head    : threshold={locked_bin['threshold']:.4f}  "
              f"val_sens={locked_bin['val_sensitivity']:.4f}  val_spec={locked_bin['val_specificity']:.4f}")
    else:
        print(f"  binary head    : UNREACHABLE at {VAL_TARGET:.0%} on VAL")

    c5v3_T, c5v3_qhat = fit_c5v3_on_pooled_indomain(indom)

    patient_ids = manifest_df["patient_id"].values
    y_true_all = manifest_df["dr_grade"].values.astype(int)
    selection_mask = (patient_ids % 2 == 0)
    report_mask = ~selection_mask
    print(f"\nPatient split: SELECTION (even patient_id) = {selection_mask.sum()} images / "
          f"{len(np.unique(patient_ids[selection_mask]))} patients; "
          f"REPORT (odd patient_id) = {report_mask.sum()} images / "
          f"{len(np.unique(patient_ids[report_mask]))} patients")

    print("\n" + "=" * 78)
    print("SELECTION-HALF RESULTS (patient-level bootstrap, n_boot=%d)" % n_boot)
    print("=" * 78)
    sel_point, sel_ci = evaluate_half(
        y_true_all[selection_mask], logits5[selection_mask], logits_bin[selection_mask],
        patient_ids[selection_mask], locked_5class, locked_bin, c5v3_T, c5v3_qhat, n_boot=n_boot)
    print_half_report("SELECTION half", int(selection_mask.sum()), sel_point, sel_ci)

    print("\n" + "=" * 78)
    print("IN-DOMAIN RESULTS (recovered TEST, same checkpoint)")
    print("=" * 78)
    test_point = compute_point_metrics(test["labels"], test["logits5"], test["logits_bin"],
                                       locked_5class, locked_bin)
    print_indomain_report(f"TEST ({tag})", test_point)

    report = {
        "tag": tag, "checkpoint": str(checkpoint_path), "precision": precision,
        "n_messidor2_images": int(len(manifest_df)),
        "item6_fullset_auc_check": None,
        "locked_operating_points": {"5class": locked_5class, "binary": locked_bin},
        "c5v3_fit": {"temperature": c5v3_T, "qhatPerClass": c5v3_qhat.tolist()},
        "selection_half": {"point": sel_point, "ci95": sel_ci},
        "in_domain_test": test_point,
        "final_peeked": bool(final),
    }
    if tag == INCUMBENT_TAG:
        ok, auc = verify_v2a_fullset_auc(manifest_df, logits5)
        report["item6_fullset_auc_check"] = {"passed": ok, "auc": auc, "target": REFERENCE_FULLSET_AUC}

    if final:
        print("\n" + "=" * 78)
        print("--final: REPORT-HALF RESULTS (patient-level bootstrap) -- PEEKING, LOGGED BELOW")
        print("=" * 78)
        rep_point, rep_ci = evaluate_half(
            y_true_all[report_mask], logits5[report_mask], logits_bin[report_mask],
            patient_ids[report_mask], locked_5class, locked_bin, c5v3_T, c5v3_qhat, n_boot=n_boot)
        print_half_report("REPORT half", int(report_mask.sum()), rep_point, rep_ci)
        report["report_half"] = {"point": rep_point, "ci95": rep_ci}

        timestamp = datetime.datetime.utcnow().isoformat() + "Z"
        with open(FINAL_LOG, "a", encoding="utf-8") as fh:
            fh.write(f"{tag}\t{timestamp}\n")
        print(f"\nAppended peek record to {FINAL_LOG}: tag={tag}  timestamp={timestamp}")
    else:
        print("\n(REPORT half not computed -- pass --final to see it. Doing so logs a line to "
              f"{FINAL_LOG.name}.)")

    out_json = OUT_DIR / f"messidor2_{tag}_candidate_report.json"

    def _default(o):
        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
        raise TypeError(f"Object of type {o.__class__.__name__} is not JSON serializable")

    with open(out_json, "w") as fh:
        json.dump(report, fh, indent=2, default=_default)
    print(f"\nWrote {out_json}")
    return report


# ═══════════════════════════════════════════════════════════════════════════
# --compare: decision rule only (selection-half + in-domain VAL, never TEST
# or the report half)
# ═══════════════════════════════════════════════════════════════════════════
EXPECTED_PATH1 = {"min_auc_gain": 0.02, "max_val_auc_regress": 0.01, "max_val_qwk_regress": 0.01}
EXPECTED_PATH2 = {"min_auc_gain": 0.05, "max_val_auc_regress": 0.02, "max_val_qwk_regress": 0.02}


def print_rule_thresholds_and_verify(incumbent_tag=INCUMBENT_TAG):
    """Task item 2: print the exact thresholds --compare uses and confirm
    they equal the spec. PATH1/PATH2 (defined near the top of this file) ARE
    the thresholds the rule uses - this just prints them next to the
    expected values and asserts they match, rather than silently trusting
    they haven't drifted."""
    print("\n" + "=" * 78)
    print("DECISION-RULE THRESHOLDS IN USE")
    print("=" * 78)
    print(f"  Path 1: selection-half best-of-two-heads AUC gain >= {PATH1['min_auc_gain']:.2f}  AND  "
          f"in-domain VAL P(g>=2) AUC not worse by more than {PATH1['max_val_auc_regress']:.2f}  AND  "
          f"val QWK not worse by more than {PATH1['max_val_qwk_regress']:.2f}")
    print(f"  Path 2: selection-half best-of-two-heads AUC gain >= {PATH2['min_auc_gain']:.2f}  AND  "
          f"in-domain VAL P(g>=2) AUC not worse by more than {PATH2['max_val_auc_regress']:.2f}  AND  "
          f"val QWK not worse by more than {PATH2['max_val_qwk_regress']:.2f}")
    print(f"  Else: keep the incumbent ({incumbent_tag}).")
    matches = (PATH1 == EXPECTED_PATH1) and (PATH2 == EXPECTED_PATH2)
    print(f"  Matches task spec (Path1=0.02/0.01/0.01, Path2=0.05/0.02/0.02): "
          f"{'YES - no fix needed' if matches else 'NO - MISMATCH, see below'}")
    if not matches:
        print(f"  MISMATCH DETECTED: PATH1={PATH1} PATH2={PATH2} vs "
              f"expected PATH1={EXPECTED_PATH1} PATH2={EXPECTED_PATH2}")
    assert matches, "Decision-rule thresholds do not match the task spec - fix PATH1/PATH2 constants."
    return matches


def compute_compare_summary(tag, precision, manifest_df, n_boot):
    """Full per-tag computation for --compare: locked operating points on the
    tag's own VAL, C5v3 fitted on the tag's own pooled in-domain val+test,
    the full selection-half table (point + patient-bootstrap CI, same as
    default-mode run_single), in-domain VAL point metrics, and the raw
    selection-half arrays needed for the paired incumbent-vs-candidate AUC-
    difference bootstrap."""
    logits5, logits_bin = get_messidor_logits_for_tag(tag, precision, manifest_df)
    indom = get_in_domain_arrays_for_tag(tag)
    val, test = indom["val"], indom["test"]
    val_ref_true = val["labels"] >= REFERABLE_FROM

    locked_5class = posthoc.lock_threshold_on_val(p_ge2_from_logits5(val["logits5"]), val_ref_true, VAL_TARGET)
    locked_bin = posthoc.lock_threshold_on_val(sigmoid(val["logits_bin"]), val_ref_true, VAL_TARGET)
    c5v3_T, c5v3_qhat = fit_c5v3_on_pooled_indomain(indom)

    patient_ids = manifest_df["patient_id"].values
    y_true_all = manifest_df["dr_grade"].values.astype(int)
    selection_mask = (patient_ids % 2 == 0)

    sel_y_true = y_true_all[selection_mask]
    sel_logits5 = logits5[selection_mask]
    sel_logits_bin = logits_bin[selection_mask]
    sel_patient_ids = patient_ids[selection_mask]

    sel_point, sel_ci = evaluate_half(sel_y_true, sel_logits5, sel_logits_bin, sel_patient_ids,
                                      locked_5class, locked_bin, c5v3_T, c5v3_qhat, n_boot=n_boot)

    val_point = compute_point_metrics(val["labels"], val["logits5"], val["logits_bin"], locked_5class, locked_bin)

    best_sel_auc = max(a for a in (sel_point["auc_p_ge2_5class"], sel_point["auc_binary_head"]) if a is not None)

    return {
        "tag": tag,
        "selection_point": sel_point, "selection_ci95": sel_ci,
        "selection_auc_5class": sel_point["auc_p_ge2_5class"], "selection_auc_binary": sel_point["auc_binary_head"],
        "selection_best_auc": best_sel_auc,
        "val_point": val_point,
        "val_auc_p_ge2_5class": val_point["auc_p_ge2_5class"], "val_qwk": val_point["qwk"],
        "locked_operating_points": {"5class": locked_5class, "binary": locked_bin},
        "c5v3_fit": {"temperature": c5v3_T, "qhatPerClass": c5v3_qhat.tolist()},
        # raw arrays for the paired bootstrap - same y_true/patient_ids across every tag
        # (identical manifest + identical selection_mask), only the model outputs differ.
        "_sel_ref_true": sel_y_true >= REFERABLE_FROM,
        "_sel_p_ge2": p_ge2_from_logits5(sel_logits5),
        "_sel_p_bin": sigmoid(sel_logits_bin),
        "_sel_patient_ids": sel_patient_ids,
    }


def paired_auc_diff_bootstrap(incumbent_summary, candidate_summary, n_boot=N_BOOTSTRAP, seed=BOOT_SEED):
    """Task item 3a: paired patient-level bootstrap 95% CI for the selection-
    half best-of-two-heads AUC DIFFERENCE (candidate minus incumbent), using
    the SAME patient resample for both models each iteration (a paired
    design controls for per-resample sampling noise common to both models,
    giving a tighter, more honest interval than two independent CIs would)."""
    patient_ids = incumbent_summary["_sel_patient_ids"]
    assert np.array_equal(patient_ids, candidate_summary["_sel_patient_ids"]), \
        "incumbent and candidate selection-half patient_ids differ - not the same manifest/split?"
    ref_true = incumbent_summary["_sel_ref_true"]
    assert np.array_equal(ref_true, candidate_summary["_sel_ref_true"]), \
        "incumbent and candidate selection-half true labels differ - not the same manifest?"

    inc_pg2, inc_pb = incumbent_summary["_sel_p_ge2"], incumbent_summary["_sel_p_bin"]
    can_pg2, can_pb = candidate_summary["_sel_p_ge2"], candidate_summary["_sel_p_bin"]

    unique_patients = np.unique(patient_ids)
    patient_to_idx = {p: np.where(patient_ids == p)[0] for p in unique_patients}
    n_p = len(unique_patients)
    rng = np.random.default_rng(seed)

    diffs = []
    for _ in range(n_boot):
        sampled = rng.choice(unique_patients, size=n_p, replace=True)
        idx = np.concatenate([patient_to_idx[p] for p in sampled])
        rt = ref_true[idx]
        if len(np.unique(rt)) < 2:
            diffs.append(np.nan)
            continue
        inc_a5, inc_ab = posthoc.safe_auc(rt, inc_pg2[idx]), posthoc.safe_auc(rt, inc_pb[idx])
        can_a5, can_ab = posthoc.safe_auc(rt, can_pg2[idx]), posthoc.safe_auc(rt, can_pb[idx])
        inc_best = max(a for a in (inc_a5, inc_ab) if a is not None)
        can_best = max(a for a in (can_a5, can_ab) if a is not None)
        diffs.append(can_best - inc_best)

    diffs = np.array(diffs, dtype=float)
    return {"mean_diff": float(np.nanmean(diffs)),
           "ci95": (float(np.nanpercentile(diffs, 2.5)), float(np.nanpercentile(diffs, 97.5))),
           "n_boot": n_boot}


def run_compare(tags, precision, n_boot, incumbent_tag=INCUMBENT_TAG):
    """incumbent_tag defaults to the module-level INCUMBENT_TAG ("v2a") for
    backward compatibility with earlier calls/tests, but is otherwise fully
    configurable -- see --incumbent on the CLI. This does NOT change the
    decision rule itself (PATH1/PATH2, the three compared metrics, which
    halves/splits are used): it only changes WHICH already-evaluated
    candidate plays the incumbent role that the same fixed rule is applied
    against. Needed because an earlier task moved the real incumbent from
    v2a to v2b (v2b replaced v2a under Path 2); this script's CLI never took
    the incumbent from argument order (an earlier task description assumed
    it did) -- it was always the hardcoded module constant -- so this flag
    is the adaptation, not a change to what counts as a pass."""
    print("=" * 78)
    print(f"evalMessidor2Candidate.py --compare {' '.join(tags)}  (incumbent={incumbent_tag})")
    print("=" * 78)
    print("Decision rule uses ONLY the selection half and each candidate's own in-domain VAL. "
          "The recovered TEST split and the report half are never used to decide.")

    print_rule_thresholds_and_verify(incumbent_tag)

    manifest_df = ref.load_manifest()
    all_tags = list(dict.fromkeys([incumbent_tag] + list(tags)))  # incumbent first, de-duplicated
    summaries = {}
    for t in all_tags:
        print("\n" + "=" * 78)
        print(f"CANDIDATE: {t}")
        print("=" * 78)
        summaries[t] = compute_compare_summary(t, precision, manifest_df, n_boot)
        s = summaries[t]
        print_half_report(f"SELECTION half ({t})", int(len(s["_sel_patient_ids"])), s["selection_point"], s["selection_ci95"])
        print(f"\n--- IN-DOMAIN VAL ({t}) ---")
        print(f"  AUC P(g>=2) [5-class] : {s['val_point']['auc_p_ge2_5class']:.4f}")
        print(f"  AUC [binary head]     : {s['val_point']['auc_binary_head']:.4f}")
        print(f"  QWK                   : {s['val_point']['qwk']:.4f}")

    incumbent = summaries[incumbent_tag]
    print("\n" + "=" * 78)
    print(f"DECISION RULE (incumbent = {incumbent_tag}, best-selection-AUC="
          f"{incumbent['selection_best_auc']:.4f}, val-AUC={incumbent['val_auc_p_ge2_5class']:.4f}, "
          f"val-QWK={incumbent['val_qwk']:.4f})")
    print("=" * 78)

    results = {}
    for t in all_tags:
        if t == incumbent_tag:
            continue
        c = summaries[t]
        auc_gain = c["selection_best_auc"] - incumbent["selection_best_auc"]
        val_auc_delta = c["val_auc_p_ge2_5class"] - incumbent["val_auc_p_ge2_5class"]
        val_qwk_delta = c["val_qwk"] - incumbent["val_qwk"]

        path1 = (auc_gain >= PATH1["min_auc_gain"] and
                 val_auc_delta >= -PATH1["max_val_auc_regress"] and
                 val_qwk_delta >= -PATH1["max_val_qwk_regress"])
        path2 = (auc_gain >= PATH2["min_auc_gain"] and
                 val_auc_delta >= -PATH2["max_val_auc_regress"] and
                 val_qwk_delta >= -PATH2["max_val_qwk_regress"])
        fired = "PATH1" if path1 else ("PATH2" if path2 else None)

        paired = paired_auc_diff_bootstrap(incumbent, c, n_boot=n_boot)

        print(f"\n{t} vs {incumbent_tag}:")
        print(f"  selection AUC gain (point)     : {auc_gain:+.4f}  "
              f"(Path1 needs >= {PATH1['min_auc_gain']:.2f}, Path2 needs >= {PATH2['min_auc_gain']:.2f})")
        print(f"  selection AUC gain (paired 95% CI, same resamples): "
              f"[{paired['ci95'][0]:+.4f}, {paired['ci95'][1]:+.4f}]  (mean diff {paired['mean_diff']:+.4f})")
        print(f"  in-domain VAL AUC delta        : {val_auc_delta:+.4f}  "
              f"(Path1 floor -{PATH1['max_val_auc_regress']:.2f}, Path2 floor -{PATH2['max_val_auc_regress']:.2f})")
        print(f"  val QWK delta                  : {val_qwk_delta:+.4f}  "
              f"(Path1 floor -{PATH1['max_val_qwk_regress']:.2f}, Path2 floor -{PATH2['max_val_qwk_regress']:.2f})")
        print(f"  -> {'Path 1 fires: promote candidate' if fired == 'PATH1' else ''}"
              f"{'Path 2 (strong evidence) fires: promote candidate' if fired == 'PATH2' else ''}"
              f"{'no path fires: KEEP INCUMBENT' if fired is None else ''}")
        results[t] = {"auc_gain": auc_gain, "paired_auc_diff_ci95": paired,
                      "val_auc_delta": val_auc_delta, "val_qwk_delta": val_qwk_delta, "path_fired": fired}

    print(f"\nNo config is installed. This is a report only.")

    def _strip_private(s):
        return {k: v for k, v in s.items() if not k.startswith("_")}

    out_json = OUT_DIR / f"messidor2_compare_{'_'.join(t.replace('(', '').replace(')', '').replace(',', '-') for t in all_tags)}.json"

    def _default(o):
        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
        raise TypeError(f"Object of type {o.__class__.__name__} is not JSON serializable")

    report = {"incumbent": incumbent_tag,
             "summaries": {t: _strip_private(s) for t, s in summaries.items()},
             "results": results}
    with open(out_json, "w") as fh:
        json.dump(report, fh, indent=2, default=_default)
    print(f"\nWrote {out_json}")
    return report


# ═══════════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--checkpoint", type=str, default=None, help="path to a branchA_<tag>.pt checkpoint")
    ap.add_argument("--tag", type=str, default=None, help="e.g. v2a, v2b, v2c")
    ap.add_argument("--final", action="store_true",
                    help="also compute+print the REPORT half; appends a line to final_report_log.txt")
    ap.add_argument("--precision", choices=["fp16", "fp32"], default="fp16")
    ap.add_argument("--n-boot", type=int, default=N_BOOTSTRAP)
    ap.add_argument("--compare", nargs="+", metavar="TAG", default=None,
                    help="apply the pre-declared promotion rule to these tags against the incumbent "
                        "(default v2a; see --incumbent). A TAG may be 'ens(tagA,tagB,...)' for an "
                        "averaged-probability ensemble)")
    ap.add_argument("--incumbent", type=str, default=INCUMBENT_TAG,
                    help=f"which tag --compare treats as the incumbent (default {INCUMBENT_TAG}). "
                        "Does not change the decision rule (PATH1/PATH2) -- only which "
                        "already-evaluated candidate that fixed rule is applied against.")
    ap.add_argument("--ensemble", nargs="+", metavar="TAG", default=None,
                    help="default-mode (single-candidate) run of an ensemble that averages the listed "
                        "models' output probabilities, e.g. --ensemble v2a v2b. Equivalent to running "
                        "with --tag 'ens(v2a,v2b)' but without needing a real checkpoint path.")
    args = ap.parse_args()

    import os
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "" if not torch.cuda.is_available() else
                          os.environ.get("CUDA_VISIBLE_DEVICES", ""))

    if args.compare:
        run_compare(args.compare, args.precision, args.n_boot, incumbent_tag=args.incumbent)
        return 0

    if args.ensemble:
        if len(args.ensemble) < 2:
            ap.error("--ensemble needs at least 2 component tags")
        tag = f"ens({','.join(args.ensemble)})"
        run_single(None, tag, args.final, args.precision, args.n_boot)
        return 0

    if not args.checkpoint or not args.tag:
        ap.error("--checkpoint and --tag are required unless --compare or --ensemble is used")

    run_single(Path(args.checkpoint), args.tag, args.final, args.precision, args.n_boot)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
