
import os
import sys
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import cv2
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
import torchvision.transforms as T
from PIL import Image
import timm
from sklearn.metrics import cohen_kappa_score, roc_auc_score, confusion_matrix

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import evalV2aPostHoc as posthoc  # noqa: E402  (reuse the already-corrected VAL-lock logic)

PIPELINE_DIR = HERE.parent
MODEL1_DIR = PIPELINE_DIR / "models" / "Model1"
V2A_DIR = MODEL1_DIR / "v2a"
CKPT_PATH = V2A_DIR / "branchA_v2a.pt"

MESSIDOR_ROOT = PIPELINE_DIR / "datasets" / "Messidor-2"
MANIFEST_CSV = MESSIDOR_ROOT / "eval_manifest.csv"

IDRID_GRADING_IMG_ROOT = (PIPELINE_DIR / "datasets" / "idrid" / "grading" /
                          "B. Disease Grading" / "1. Original Images")
IDRID_TAG_DIR = {"train": "a. Training Set", "test": "b. Testing Set"}

OUT_DIR = PIPELINE_DIR / "diagnostics" / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)
LOGITS_CACHE = OUT_DIR / "messidor2_v2a_logits.npy"       # primary (fp16 autocast, matches how VAL/TEST were produced)
LOGITS_CACHE_FP32 = OUT_DIR / "messidor2_v2a_logits_fp32.npy"  # secondary, precision-comparison only
REPORT_JSON = OUT_DIR / "messidor2_v2a_external_validation.json"
REPORT_TXT = OUT_DIR / "messidor2_v2a_external_validation.txt"

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
NUM_CLASSES = 5
REFERABLE_FROM = 2
TARGETS = [0.90, 0.93, 0.95]
N_BOOTSTRAP = 2000
BOOT_SEED = 42
FIDELITY_N = 10
FIDELITY_LOGIT_TOL = 1e-3   # original bar; kept for reporting, not the acceptance gate (see below)
FIDELITY_PROB_TOL = 0.01    # revised acceptance gate: max softmax-probability diff, at whichever
                            # precision (fp16 autocast vs fp32) is closer to the saved Kaggle logits
                            # (saved logits were produced under fp16 autocast on a T4 - see run_fidelity_check)


def amp_autocast(enabled=True):
    return torch.autocast("cuda", dtype=torch.float16, enabled=enabled and DEVICE.type == "cuda")

RESOLUTION_BUCKETS = [(1440, 960), (2240, 1488), (2304, 1536)]

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


# ===========================================================================
# 1. PREPROCESSING + MODEL - verbatim from train_classifier_kaggle_v2.ipynb
# ===========================================================================
def ben_graham_preprocess(image: np.ndarray, target_size: int = 384) -> np.ndarray:
    """Ben Graham-style fundus preprocessing. Identical to preprocessing/ben_graham.py.

    image       : BGR uint8 array, shape (H, W, 3)
    target_size : output square side length
    returns     : uint8 array (target_size, target_size, 3), values 0..255, BGR order
    """
    if image is None or image.size == 0:
        raise ValueError("ben_graham_preprocess received an empty or None image.")
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError(f"Expected a 3-channel image, got shape {image.shape}.")

    gray = image[:, :, 1]
    _, mask = cv2.threshold(gray, 7, 255, cv2.THRESH_BINARY)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if contours:
        largest = max(contours, key=cv2.contourArea)
        x, y, w, h = cv2.boundingRect(largest)
        x, y = max(0, x), max(0, y)
        w = min(w, image.shape[1] - x)
        h = min(h, image.shape[0] - y)
        cropped = image[y:y + h, x:x + w]
    else:
        cropped = image
    if cropped.size == 0:
        cropped = image

    resized = cv2.resize(cropped, (target_size, target_size), interpolation=cv2.INTER_AREA)

    sigma = target_size / 30.0
    ksize = max(int(sigma) * 2 + 1, 1)
    blurred = cv2.GaussianBlur(resized, (ksize, ksize), sigma)
    enhanced = cv2.addWeighted(resized, 4, blurred, -4, 128)
    return enhanced


class DRClassifierV2(nn.Module):
    """timm backbone (feature mode) + explicit Dropout + TWO linear heads.
    Verbatim from the notebook - see its cell 14 docstring for why the
    dropout must be an nn.Module (MC-Dropout compatibility), not used here."""
    def __init__(self, model_name, num_classes, drop_rate, pretrained=False):
        super().__init__()
        self.backbone = timm.create_model(model_name, pretrained=pretrained,
                                          num_classes=0, drop_rate=0.0)
        self.num_features = self.backbone.num_features
        self.drop = nn.Dropout(p=drop_rate)
        self.head5 = nn.Linear(self.num_features, num_classes)
        self.headBin = nn.Linear(self.num_features, 1)

    def forward(self, x):
        feats = self.drop(self.backbone(x))
        return self.head5(feats), self.headBin(feats).squeeze(-1)


def build_eval_transform(img_size):
    """eval_tf, verbatim from the notebook's cell 12. Resize is a no-op given
    ben_graham_preprocess already outputs img_size x img_size, but it is kept
    to match the training-time pipeline exactly, not assumed away."""
    return T.Compose([
        T.Resize((img_size, img_size)),
        T.ToTensor(),
        T.Normalize(IMAGENET_MEAN, IMAGENET_STD),
    ])


def preprocess_to_tensor(bgr, img_size, transform):
    proc = ben_graham_preprocess(bgr, img_size)
    rgb = cv2.cvtColor(proc, cv2.COLOR_BGR2RGB)
    return transform(Image.fromarray(rgb))


def load_model():
    ckpt = torch.load(str(CKPT_PATH), map_location="cpu", weights_only=False)
    assert tuple(ckpt["normalize_mean"]) == IMAGENET_MEAN, "checkpoint normalize_mean drifted from ImageNet stats"
    assert tuple(ckpt["normalize_std"]) == IMAGENET_STD, "checkpoint normalize_std drifted from ImageNet stats"
    assert ckpt["channel_order"] == "RGB"
    model = DRClassifierV2(ckpt["model_name"], ckpt["num_classes"], ckpt["drop_rate"], pretrained=False)
    model.load_state_dict(ckpt["model_state_dict"], strict=True)
    model.to(DEVICE)
    model.eval()
    img_size = ckpt["img_size"]
    print(f"Loaded {CKPT_PATH.name}: {ckpt['model_name']}  img_size={img_size}  "
          f"drop_rate={ckpt['drop_rate']}  epoch={ckpt.get('epoch')}  "
          f"val_qwk={ckpt.get('val_qwk'):.4f}")
    return model, ckpt, img_size


# ===========================================================================
# 2. ID PARSING (v2a cache-key format -> raw source id, for the fidelity check)
# ===========================================================================
def to_row_image_id(cache_id: str, img_size: int):
    """Inverse of the notebook's cache_key(source, image_id) = f"{source}_{image_id}_{img_size}",
    where image_id itself is f"{source}__{raw_id}". Returns (raw_id, source)."""
    suffix = f"_{img_size}"
    assert cache_id.endswith(suffix), cache_id
    s = cache_id[: -len(suffix)]
    for src in ("aptos", "idrid", "eyepacs"):
        pfx = src + "_"
        if s.startswith(pfx):
            row_image_id = s[len(pfx):]
            assert row_image_id.startswith(src + "__"), row_image_id
            return row_image_id[len(src) + 2:], src
    raise ValueError(f"unrecognised source prefix in {cache_id!r}")


def resolve_idrid_grading_path(raw_id: str) -> Path:
    """raw_id like 'idrid_train_IDRiD_003' (built by the notebook's
    load_idrid as f"idrid_{ctag}_{name}")."""
    parts = raw_id.split("_", 2)
    assert len(parts) == 3 and parts[0] == "idrid", raw_id
    ctag, name = parts[1], parts[2]
    subdir = IDRID_TAG_DIR.get(ctag)
    if subdir is None:
        raise ValueError(f"unrecognised IDRiD tag {ctag!r} in {raw_id!r}")
    p = IDRID_GRADING_IMG_ROOT / subdir / f"{name}.jpg"
    if not p.is_file():
        raise FileNotFoundError(f"IDRiD grading image not found: {p}")
    return p


# ===========================================================================
# 3. FIDELITY CHECK (step 1)
# ===========================================================================
def run_fidelity_check(model, img_size, transform, n=FIDELITY_N):
    """Recomputes each fidelity image at BOTH fp32 and fp16-autocast (the
    saved branchA_v2a_test_logits.npy were produced by the notebook's
    evaluate(), which wraps the forward pass in torch.amp.autocast("cuda",
    enabled=USE_AMP) with USE_AMP=True, on a Kaggle T4 - i.e. fp16 autocast,
    not fp32). Reports logit-space AND probability-space max-abs-diff for
    each precision, per image, with source. Acceptance gate (revised from
    the original blanket <1e-3 on raw logits, which does not account for a
    cross-hardware fp16-vs-fp32 comparison): argmax agreement 10/10 AND max
    softmax-probability diff <= FIDELITY_PROB_TOL at whichever precision is
    closer to the saved logits.
    """
    print("\n" + "=" * 78)
    print(f"FIDELITY CHECK: reproducing branchA_v2a_test_logits.npy on {n} recovered-test images")
    print("=" * 78)
    print("NOTE: APTOS raw images are NOT available anywhere on this machine (checked "
          "datasets/aptos2019/, C:/Users/Tanuj/Desktop/datasets/aptos2019/, and a full-disk "
          "search for train.csv / train_images/ - all empty or absent). All 10 fidelity "
          "images are therefore IDRiD-sourced (52/78 IDRiD test images have raw files "
          "available locally after filtering out ones missing from this machine's "
          "incomplete grading 'Training Set' folder). This is a real gap in cross-source "
          "coverage for this check, not a choice.")

    test_ids = np.load(V2A_DIR / "branchA_v2a_test_ids.npy", allow_pickle=True)
    test_logits5 = np.load(V2A_DIR / "branchA_v2a_test_logits.npy").astype(np.float64)

    idrid_indices = [i for i, cid in enumerate(test_ids) if str(cid).startswith("idrid")]
    resolvable = []
    for i in sorted(idrid_indices):
        raw_id, _ = to_row_image_id(str(test_ids[i]), img_size)
        try:
            resolve_idrid_grading_path(raw_id)
            resolvable.append(i)
        except FileNotFoundError:
            continue
    if len(resolvable) < n:
        raise RuntimeError(f"only {len(resolvable)} IDRiD test ids resolvable locally, need {n}")
    chosen = resolvable[:n]

    rows = []
    logit_diffs = {"fp32": [], "fp16": []}
    prob_diffs = {"fp32": [], "fp16": []}
    argmax_agree = {"fp32": 0, "fp16": 0}
    print(f"\n  {'id':45s} {'src':6s} {'logit_fp32':>11s} {'logit_fp16':>11s} "
          f"{'prob_fp32':>10s} {'prob_fp16':>10s} {'argmax(saved/fp32/fp16)':>24s}")
    with torch.no_grad():
        for idx in chosen:
            cid = str(test_ids[idx])
            raw_id, src = to_row_image_id(cid, img_size)
            path = resolve_idrid_grading_path(raw_id)
            bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
            if bgr is None:
                raise IOError(f"cannot read {path}")
            x = preprocess_to_tensor(bgr, img_size, transform).unsqueeze(0).to(DEVICE)

            l5_fp32, _ = model(x)
            l5_fp32 = l5_fp32[0].cpu().numpy().astype(np.float64)
            with amp_autocast():
                l5_fp16, _ = model(x)
            l5_fp16 = l5_fp16[0].float().cpu().numpy().astype(np.float64)

            saved = test_logits5[idx]
            p_saved = softmax(saved[None, :])[0]
            p_fp32 = softmax(l5_fp32[None, :])[0]
            p_fp16 = softmax(l5_fp16[None, :])[0]

            d_logit_fp32 = float(np.max(np.abs(l5_fp32 - saved)))
            d_logit_fp16 = float(np.max(np.abs(l5_fp16 - saved)))
            d_prob_fp32 = float(np.max(np.abs(p_fp32 - p_saved)))
            d_prob_fp16 = float(np.max(np.abs(p_fp16 - p_saved)))
            logit_diffs["fp32"].append(d_logit_fp32); logit_diffs["fp16"].append(d_logit_fp16)
            prob_diffs["fp32"].append(d_prob_fp32); prob_diffs["fp16"].append(d_prob_fp16)

            am_saved, am_fp32, am_fp16 = int(p_saved.argmax()), int(p_fp32.argmax()), int(p_fp16.argmax())
            argmax_agree["fp32"] += int(am_fp32 == am_saved)
            argmax_agree["fp16"] += int(am_fp16 == am_saved)

            rows.append({"id": cid, "source": src, "path": str(path),
                        "logit_diff_fp32": d_logit_fp32, "logit_diff_fp16": d_logit_fp16,
                        "prob_diff_fp32": d_prob_fp32, "prob_diff_fp16": d_prob_fp16,
                        "argmax_saved": am_saved, "argmax_fp32": am_fp32, "argmax_fp16": am_fp16})
            print(f"  {cid:45s} {src:6s} {d_logit_fp32:11.5f} {d_logit_fp16:11.5f} "
                  f"{d_prob_fp32:10.5f} {d_prob_fp16:10.5f}          {am_saved}/{am_fp32}/{am_fp16}")

    max_logit_fp32, max_logit_fp16 = max(logit_diffs["fp32"]), max(logit_diffs["fp16"])
    max_prob_fp32, max_prob_fp16 = max(prob_diffs["fp32"]), max(prob_diffs["fp16"])
    closer = "fp16" if max_logit_fp16 <= max_logit_fp32 else "fp32"

    print(f"\n  max logit diff : fp32={max_logit_fp32:.5f}   fp16={max_logit_fp16:.5f}")
    print(f"  max prob  diff : fp32={max_prob_fp32:.5f}   fp16={max_prob_fp16:.5f}")
    print(f"  argmax agreement (of {n}): fp32={argmax_agree['fp32']}  fp16={argmax_agree['fp16']}")
    print(f"  closer to saved (Kaggle T4, fp16-autocast) logits: {closer}")
    print("  NOTE: all images are IDRiD-sourced (APTOS unavailable locally) - this does not "
          "test whether the gap differs by source, only by precision.")

    gate_precision = closer
    passed = (argmax_agree[gate_precision] == n) and (max(prob_diffs[gate_precision]) <= FIDELITY_PROB_TOL)
    print(f"\nFIDELITY RESULT (revised gate: argmax 10/10 AND max prob diff <= {FIDELITY_PROB_TOL} "
          f"at {gate_precision} precision) -> {'PASS' if passed else 'FAIL'}")
    print(f"  (original blanket <1e-3 raw-logit bar: fp32 would have "
          f"{'PASSED' if max_logit_fp32 < 1e-3 else 'FAILED'}, "
          f"fp16 would have {'PASSED' if max_logit_fp16 < 1e-3 else 'FAILED'} - "
          f"kept for the record, not used as the gate)")
    print("=" * 78)

    summary = {
        "n": n, "closer_precision": closer, "gate": {"metric": "argmax_10_of_10_and_max_prob_diff",
                                                     "tolerance": FIDELITY_PROB_TOL, "precision_used": gate_precision},
        "max_logit_diff_fp32": max_logit_fp32, "max_logit_diff_fp16": max_logit_fp16,
        "max_prob_diff_fp32": max_prob_fp32, "max_prob_diff_fp16": max_prob_fp16,
        "argmax_agreement_fp32": argmax_agree["fp32"], "argmax_agreement_fp16": argmax_agree["fp16"],
        "aptos_available_locally": False, "per_image": rows,
    }
    return passed, summary


# ===========================================================================
# 4. MESSIDOR-2 INFERENCE (step 2, cached)
# ===========================================================================
class MessidorDataset(Dataset):
    def __init__(self, image_paths, img_size, transform):
        self.image_paths = list(image_paths)
        self.img_size = img_size
        self.transform = transform

    def __len__(self):
        return len(self.image_paths)

    def __getitem__(self, i):
        path = self.image_paths[i]
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        if bgr is None:
            raise IOError(f"cannot read {path}")
        img = preprocess_to_tensor(bgr, self.img_size, self.transform)
        return img, i


def load_manifest():
    df = pd.read_csv(MANIFEST_CSV)
    assert df["gradable"].eq(1).all(), "eval_manifest.csv contains a non-gradable row - filter before use"
    return df.reset_index(drop=True)


def _load_cache_if_matching(cache_path, manifest_df):
    if not cache_path.is_file():
        return None
    cached = np.load(cache_path, allow_pickle=True).item()
    if list(cached["image_path"]) == list(manifest_df["image_path"]):
        print(f"\nUsing cached logits: {cache_path} (n={len(cached['image_path'])})")
        return cached["logits5"], cached["logits_bin"]
    print(f"Cache {cache_path} exists but image_path order/content differs from the "
          f"current manifest - recomputing.")
    return None


@torch.no_grad()
def _run_messidor_inference_precision(model, img_size, transform, manifest_df, cache_path,
                                       use_amp, batch_size=16, num_workers=6):
    cached = _load_cache_if_matching(cache_path, manifest_df)
    if cached is not None:
        return cached

    label = "fp16-autocast" if use_amp else "fp32"
    print(f"\nRunning {label} inference on {len(manifest_df)} Messidor-2 images "
          f"(device={DEVICE}, img_size={img_size})...")
    t0 = time.time()
    paths = [str(MESSIDOR_ROOT / p) for p in manifest_df["image_path"]]
    ds = MessidorDataset(paths, img_size, transform)
    loader = DataLoader(ds, batch_size=batch_size, shuffle=False, num_workers=num_workers)

    logits5 = np.zeros((len(ds), NUM_CLASSES), dtype=np.float32)
    logits_bin = np.zeros((len(ds),), dtype=np.float32)
    n_done = 0
    for imgs, idx in loader:
        imgs = imgs.to(DEVICE, non_blocking=True)
        with amp_autocast(enabled=use_amp):
            l5, lb = model(imgs)
        l5 = l5.float().cpu().numpy()
        lb = lb.float().cpu().numpy()
        idx_np = idx.numpy()
        logits5[idx_np] = l5
        logits_bin[idx_np] = lb
        n_done += len(idx_np)
        if n_done % 320 == 0 or n_done == len(ds):
            print(f"  {n_done}/{len(ds)}  ({time.time() - t0:.1f}s elapsed)")

    dt = time.time() - t0
    print(f"{label} inference done: {len(ds)} images in {dt:.1f}s ({dt / len(ds) * 1000:.1f} ms/image)")

    np.save(cache_path, {"logits5": logits5, "logits_bin": logits_bin,
                        "image_path": manifest_df["image_path"].tolist()},
           allow_pickle=True)
    print(f"Cached: {cache_path}")
    return logits5, logits_bin


def run_messidor_inference(model, img_size, transform, manifest_df, batch_size=16, num_workers=6):
    """Runs Messidor-2 inference at BOTH precisions:
    - fp16 autocast (PRIMARY, cached at LOGITS_CACHE) - matches how the
      notebook's evaluate() produced the VAL/TEST arrays the operating
      points are locked on, so this is the apples-to-apples comparison.
    - fp32 (SECONDARY, cached at LOGITS_CACHE_FP32) - precision-comparison
      context only, per the fidelity-check follow-up.
    Returns (logits5_fp16, logits_bin_fp16, logits5_fp32, logits_bin_fp32).
    """
    l5_fp16, lb_fp16 = _run_messidor_inference_precision(
        model, img_size, transform, manifest_df, LOGITS_CACHE, use_amp=True,
        batch_size=batch_size, num_workers=num_workers)
    l5_fp32, lb_fp32 = _run_messidor_inference_precision(
        model, img_size, transform, manifest_df, LOGITS_CACHE_FP32, use_amp=False,
        batch_size=batch_size, num_workers=num_workers)
    return l5_fp16, lb_fp16, l5_fp32, lb_fp32


# ===========================================================================
# 5. METRICS
# ===========================================================================
def softmax(x):
    e = np.exp(x - x.max(axis=1, keepdims=True))
    return e / e.sum(axis=1, keepdims=True)


def per_grade_recall(y_true, y_pred, num_classes=NUM_CLASSES):
    out = {}
    for g in range(num_classes):
        mask = y_true == g
        n = int(mask.sum())
        recall = float((y_pred[mask] == g).sum() / n) if n else float("nan")
        out[g] = {"recall": recall, "n": n}
    return out


def confidence_and_grade_distribution(logits5):
    probs = softmax(logits5)
    conf = probs.max(axis=1)
    pred = logits5.argmax(axis=1)
    dist = {g: float((pred == g).mean()) for g in range(NUM_CLASSES)}
    return float(conf.mean()), dist


def bootstrap_metrics(idx_fn_inputs, patient_ids, n_boot=N_BOOTSTRAP, seed=BOOT_SEED):
    """Patient-level bootstrap: resample UNIQUE patients with replacement
    (same count as observed), include every row (both eyes) of each sampled
    patient. Returns {metric_name: (lo2.5, hi97.5)} over n_boot resamples.

    idx_fn_inputs: dict with y_true, y_pred_argmax, p_ge2, locked_thresholds
                  (dict target->threshold), needed to recompute every metric
                  from a row-index array.
    """
    y_true = idx_fn_inputs["y_true"]
    y_pred = idx_fn_inputs["y_pred_argmax"]
    p_ge2 = idx_fn_inputs["p_ge2"]
    thresholds = idx_fn_inputs["locked_thresholds"]

    unique_patients = np.unique(patient_ids)
    patient_to_idx = {p: np.where(patient_ids == p)[0] for p in unique_patients}
    n_p = len(unique_patients)
    rng = np.random.default_rng(seed)

    keys = (["ref_sens_argmax", "ref_spec_argmax", "qwk", "mean_signed_error",
            "auc_p_ge2"] +
           [f"sens_t{t}" for t in thresholds] + [f"spec_t{t}" for t in thresholds] +
           [f"grade{g}_recall" for g in range(NUM_CLASSES)])
    boot = {k: [] for k in keys}

    for _ in range(n_boot):
        sampled_patients = rng.choice(unique_patients, size=n_p, replace=True)
        idx = np.concatenate([patient_to_idx[p] for p in sampled_patients])
        yt, yp, pg = y_true[idx], y_pred[idx], p_ge2[idx]

        ref_true = yt >= REFERABLE_FROM
        ref_pred = yp >= REFERABLE_FROM
        tp = int((ref_true & ref_pred).sum()); fn = int((ref_true & ~ref_pred).sum())
        tn = int((~ref_true & ~ref_pred).sum()); fp = int((~ref_true & ref_pred).sum())
        boot["ref_sens_argmax"].append(tp / (tp + fn) if (tp + fn) else np.nan)
        boot["ref_spec_argmax"].append(tn / (tn + fp) if (tn + fp) else np.nan)

        boot["qwk"].append(cohen_kappa_score(yt, yp, weights="quadratic") if len(np.unique(yt)) > 1 else np.nan)
        boot["mean_signed_error"].append(float((yp - yt).mean()))

        try:
            boot["auc_p_ge2"].append(roc_auc_score(ref_true, pg) if len(np.unique(ref_true)) > 1 else np.nan)
        except ValueError:
            boot["auc_p_ge2"].append(np.nan)

        for t, thr in thresholds.items():
            pred_t = pg >= thr
            tp = int((ref_true & pred_t).sum()); fn = int((ref_true & ~pred_t).sum())
            tn = int((~ref_true & ~pred_t).sum()); fp = int((~ref_true & pred_t).sum())
            boot[f"sens_t{t}"].append(tp / (tp + fn) if (tp + fn) else np.nan)
            boot[f"spec_t{t}"].append(tn / (tn + fp) if (tn + fp) else np.nan)

        for g in range(NUM_CLASSES):
            gmask = yt == g
            boot[f"grade{g}_recall"].append(float((yp[gmask] == g).sum() / gmask.sum()) if gmask.sum() else np.nan)

    ci = {k: (float(np.nanpercentile(v, 2.5)), float(np.nanpercentile(v, 97.5))) for k, v in boot.items()}
    return ci


# ===========================================================================
# 6. OPTIONAL: FOVEA-GATE DIAGNOSTIC (report only, no tuning)
# ===========================================================================
def run_fovea_gate(manifest_df):
    import io
    import contextlib
    sys.path.insert(0, str(PIPELINE_DIR / "inference"))
    import segInfer  # noqa: E402  (read-only import, not modified)

    n_flagged = 0
    n_ok = 0
    n_failed = 0
    buf = io.StringIO()
    t0 = time.time()
    for p in manifest_df["image_path"]:
        path = str(MESSIDOR_ROOT / p)
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        if bgr is None:
            n_failed += 1
            continue
        try:
            with contextlib.redirect_stderr(buf):
                pts = segInfer.localize(bgr)
            if pts["foveaUnreliable"]:
                n_flagged += 1
            else:
                n_ok += 1
        except Exception:
            n_failed += 1
    dt = time.time() - t0
    n_total = n_ok + n_flagged
    frac = n_flagged / n_total if n_total else float("nan")
    print(f"\nFovea gate: {n_flagged}/{n_total} images flagged foveaUnreliable "
          f"({frac:.1%}), {n_failed} failed to run, {dt:.1f}s total. Report only - "
          f"FOVEA_PEAK_THRESHOLD={segInfer.FOVEA_PEAK_THRESHOLD} was fitted on IDRiD "
          f"(experiments/foveaGateValidation.py) and is UNCHANGED here.")
    return {"n_flagged": n_flagged, "n_ok": n_ok, "n_failed": n_failed,
            "fraction_flagged": frac, "threshold_used": segInfer.FOVEA_PEAK_THRESHOLD}


# ===========================================================================
# 7. MAIN
# ===========================================================================
def main():
    fidelity_only = "--fidelity-only" in sys.argv
    skip_fovea = "--skip-fovea" in sys.argv

    model, ckpt, img_size = load_model()
    transform = build_eval_transform(img_size)

    passed, fidelity_summary = run_fidelity_check(model, img_size, transform)
    if not passed:
        print("\n*** STOP: fidelity check FAILED even under the revised gate. Preprocessing/"
              "model do not reproduce v2a's saved test logits closely enough. Not proceeding "
              "to Messidor-2. ***")
        sys.exit(1)

    if fidelity_only:
        print("\n--fidelity-only: stopping here as requested.")
        return

    # ---- load v2a's own VAL arrays (for locking thresholds) + in-domain test (for domain-shift compare)
    val_ids = np.load(V2A_DIR / "branchA_v2a_val_ids.npy", allow_pickle=True)
    val_labels = np.load(V2A_DIR / "branchA_v2a_val_labels.npy").astype(int)
    val_logits5 = np.load(V2A_DIR / "branchA_v2a_val_logits.npy").astype(np.float64)
    val_probs5 = softmax(val_logits5)
    val_p_ge2 = val_probs5[:, 2] + val_probs5[:, 3] + val_probs5[:, 4]
    val_ref_true = val_labels >= REFERABLE_FROM

    test_labels = np.load(V2A_DIR / "branchA_v2a_test_labels.npy").astype(int)
    test_logits5 = np.load(V2A_DIR / "branchA_v2a_test_logits.npy").astype(np.float64)

    locked = {}
    print("\n" + "=" * 78)
    print("OPERATING POINTS LOCKED ON v2a VAL (never re-tuned on Messidor-2)")
    print("=" * 78)
    for target in TARGETS:
        lock = posthoc.lock_threshold_on_val(val_p_ge2, val_ref_true, target)
        if lock is None:
            print(f"  target {target:.0%}: UNREACHABLE on VAL (max val sens "
                  f"for P(g>=2) below {target:.0%}) - skipping this target.")
            continue
        locked[target] = lock
        print(f"  target {target:.0%}: threshold={lock['threshold']:.4f}  "
              f"val_sens={lock['val_sensitivity']:.4f}  val_spec={lock['val_specificity']:.4f}")

    # ---- Messidor-2 manifest + inference (cached) ------------------------
    manifest_df = load_manifest()
    print(f"\nMessidor-2 manifest: {len(manifest_df)} gradable images, "
          f"{manifest_df['patient_id'].nunique()} unique patients")

    m_logits5, m_logits_bin, m_logits5_fp32, m_logits_bin_fp32 = run_messidor_inference(
        model, img_size, transform, manifest_df)
    m_probs5 = softmax(m_logits5)
    m_p_ge2 = m_probs5[:, 2] + m_probs5[:, 3] + m_probs5[:, 4]
    m_pred_argmax = m_logits5.argmax(axis=1)

    # ---- fp16(primary) vs fp32(secondary) precision comparison on Messidor-2 ----
    m_probs5_fp32 = softmax(m_logits5_fp32)
    m_pred_argmax_fp32 = m_logits5_fp32.argmax(axis=1)
    precision_agree = int((m_pred_argmax == m_pred_argmax_fp32).sum())
    print("\n" + "=" * 78)
    print("PRECISION COMPARISON ON MESSIDOR-2: fp16-autocast (primary) vs fp32 (secondary)")
    print("=" * 78)
    print(f"  argmax agreement: {precision_agree}/{len(m_pred_argmax)} "
          f"({precision_agree / len(m_pred_argmax):.2%})")
    print("  predicted-grade counts:")
    print(f"    {'grade':>6} {'fp16':>8} {'fp32':>8}")
    grade_counts_fp16 = {g: int((m_pred_argmax == g).sum()) for g in range(NUM_CLASSES)}
    grade_counts_fp32 = {g: int((m_pred_argmax_fp32 == g).sum()) for g in range(NUM_CLASSES)}
    for g in range(NUM_CLASSES):
        print(f"    {g:>6} {grade_counts_fp16[g]:>8} {grade_counts_fp32[g]:>8}")
    y_true_precision = manifest_df["dr_grade"].values.astype(int)
    ref_true_precision = y_true_precision >= REFERABLE_FROM

    def _sens_spec(pred_argmax):
        rp = pred_argmax >= REFERABLE_FROM
        tp = int((ref_true_precision & rp).sum()); fn = int((ref_true_precision & ~rp).sum())
        tn = int((~ref_true_precision & ~rp).sum()); fp = int((~ref_true_precision & rp).sum())
        return (tp / (tp + fn) if (tp + fn) else float("nan"),
                tn / (tn + fp) if (tn + fp) else float("nan"))

    sens_fp16, spec_fp16 = _sens_spec(m_pred_argmax)
    sens_fp32, spec_fp32 = _sens_spec(m_pred_argmax_fp32)
    print(f"  referable (argmax>=2) sens/spec: fp16={sens_fp16:.4f}/{spec_fp16:.4f}   "
          f"fp32={sens_fp32:.4f}/{spec_fp32:.4f}   "
          f"delta={sens_fp16 - sens_fp32:+.4f}/{spec_fp16 - spec_fp32:+.4f}")
    precision_comparison = {
        "argmax_agreement": precision_agree, "n": int(len(m_pred_argmax)),
        "grade_counts_fp16": grade_counts_fp16, "grade_counts_fp32": grade_counts_fp32,
        "ref_sens_spec_fp16": [sens_fp16, spec_fp16], "ref_sens_spec_fp32": [sens_fp32, spec_fp32],
    }
    y_true = manifest_df["dr_grade"].values.astype(int)
    ref_true = y_true >= REFERABLE_FROM
    patient_ids = manifest_df["patient_id"].values

    # ---- step 3: metrics vs adjudicated grades ----------------------------
    print("\n" + "=" * 78)
    print("MESSIDOR-2 METRICS vs ADJUDICATED GRADES")
    print("=" * 78)

    qwk = float(cohen_kappa_score(y_true, m_pred_argmax, weights="quadratic"))
    mean_signed_error = float((m_pred_argmax - y_true).mean())
    auc_p_ge2 = float(roc_auc_score(ref_true, m_p_ge2))
    cm = confusion_matrix(y_true, m_pred_argmax, labels=list(range(NUM_CLASSES))).tolist()
    grade_recall = per_grade_recall(y_true, m_pred_argmax)

    ref_pred_argmax = m_pred_argmax >= REFERABLE_FROM
    tp = int((ref_true & ref_pred_argmax).sum()); fn = int((ref_true & ~ref_pred_argmax).sum())
    tn = int((~ref_true & ~ref_pred_argmax).sum()); fp = int((~ref_true & ref_pred_argmax).sum())
    ref_sens_argmax = tp / (tp + fn) if (tp + fn) else float("nan")
    ref_spec_argmax = tn / (tn + fp) if (tn + fp) else float("nan")

    threshold_results = {}
    for target, lock in locked.items():
        thr = lock["threshold"]
        pred_t = m_p_ge2 >= thr
        tp = int((ref_true & pred_t).sum()); fn = int((ref_true & ~pred_t).sum())
        tn = int((~ref_true & ~pred_t).sum()); fp = int((~ref_true & pred_t).sum())
        sens = tp / (tp + fn) if (tp + fn) else float("nan")
        spec = tn / (tn + fp) if (tn + fp) else float("nan")
        threshold_results[target] = {"threshold": thr, "sens": sens, "spec": spec}

    print(f"QWK                          : {qwk:.4f}")
    print(f"AUC of P(g>=2)               : {auc_p_ge2:.4f}")
    print(f"Mean signed error            : {mean_signed_error:+.4f}  (negative = under-grading)")
    print(f"Referable (argmax>=2) sens/spec: {ref_sens_argmax:.4f} / {ref_spec_argmax:.4f}")
    for target, r in threshold_results.items():
        print(f"Referable (P(g>=2)>=VAL-locked {target:.0%} threshold={r['threshold']:.4f}) "
              f"sens/spec: {r['sens']:.4f} / {r['spec']:.4f}")
    print("Per-grade recall:")
    for g, d in grade_recall.items():
        print(f"  grade {g}: recall={d['recall']:.4f}  n={d['n']}")
    print("Confusion matrix (rows=truth, cols=pred):")
    print(pd.DataFrame(cm, index=[f"true{g}" for g in range(NUM_CLASSES)],
                       columns=[f"pred{g}" for g in range(NUM_CLASSES)]))

    # ---- patient-level bootstrap CIs --------------------------------------
    print("\nComputing patient-level bootstrap CIs "
          f"(n_boot={N_BOOTSTRAP}, {manifest_df['patient_id'].nunique()} unique patients)...")
    boot_inputs = {
        "y_true": y_true, "y_pred_argmax": m_pred_argmax, "p_ge2": m_p_ge2,
        "locked_thresholds": {t: lock["threshold"] for t, lock in locked.items()},
    }
    ci = bootstrap_metrics(boot_inputs, patient_ids)
    print(f"  ref_sens (argmax)  95% CI: [{ci['ref_sens_argmax'][0]:.4f}, {ci['ref_sens_argmax'][1]:.4f}]")
    print(f"  ref_spec (argmax)  95% CI: [{ci['ref_spec_argmax'][0]:.4f}, {ci['ref_spec_argmax'][1]:.4f}]")
    print(f"  QWK                95% CI: [{ci['qwk'][0]:.4f}, {ci['qwk'][1]:.4f}]")
    print(f"  AUC P(g>=2)        95% CI: [{ci['auc_p_ge2'][0]:.4f}, {ci['auc_p_ge2'][1]:.4f}]")
    for target in locked:
        print(f"  sens @ {target:.0%} lock   95% CI: [{ci[f'sens_t{target}'][0]:.4f}, {ci[f'sens_t{target}'][1]:.4f}]")
        print(f"  spec @ {target:.0%} lock   95% CI: [{ci[f'spec_t{target}'][0]:.4f}, {ci[f'spec_t{target}'][1]:.4f}]")
    for g in range(NUM_CLASSES):
        print(f"  grade{g} recall     95% CI: [{ci[f'grade{g}_recall'][0]:.4f}, {ci[f'grade{g}_recall'][1]:.4f}]")

    # ---- step 4: resolution breakdown + missed severe cases ----------------
    print("\n" + "=" * 78)
    print("BREAKDOWN BY IMAGE RESOLUTION")
    print("=" * 78)
    print("Reading raw image dimensions (header-only)...")
    dims = []
    for p in manifest_df["image_path"]:
        with Image.open(MESSIDOR_ROOT / p) as im:
            dims.append(im.size)  # (width, height)
    dims = np.array(dims)
    resolution_report = {}
    bucket_labels = [f"{w}x{h}" for w, h in RESOLUTION_BUCKETS]
    matched_any = np.zeros(len(dims), dtype=bool)
    for (w, h), label in zip(RESOLUTION_BUCKETS, bucket_labels):
        mask = (dims[:, 0] == w) & (dims[:, 1] == h)
        matched_any |= mask
        n = int(mask.sum())
        if n == 0:
            resolution_report[label] = {"n": 0}
            continue
        yt, yp = y_true[mask], m_pred_argmax[mask]
        rt, rp = ref_true[mask], ref_pred_argmax[mask]
        tp = int((rt & rp).sum()); fn = int((rt & ~rp).sum())
        tn = int((~rt & ~rp).sum()); fp = int((~rt & rp).sum())
        resolution_report[label] = {
            "n": n,
            "qwk": float(cohen_kappa_score(yt, yp, weights="quadratic")) if len(np.unique(yt)) > 1 else float("nan"),
            "ref_sens_argmax": tp / (tp + fn) if (tp + fn) else float("nan"),
            "ref_spec_argmax": tn / (tn + fp) if (tn + fp) else float("nan"),
            "mean_signed_error": float((yp - yt).mean()),
        }
        print(f"  {label:12s} n={n:4d}  QWK={resolution_report[label]['qwk']:.4f}  "
              f"ref_sens={resolution_report[label]['ref_sens_argmax']:.4f}  "
              f"ref_spec={resolution_report[label]['ref_spec_argmax']:.4f}")
    n_other = int((~matched_any).sum())
    if n_other:
        other_dims = [tuple(d) for d in dims[~matched_any]]
        print(f"  other        n={n_other:4d}  dims not matching the 3 canonical buckets: "
              f"{sorted(set(other_dims))}")
        resolution_report["other"] = {"n": n_other, "dims": sorted(set(str(d) for d in other_dims))}

    missed_severe = manifest_df[(y_true >= 3) & (~ref_pred_argmax)].copy()
    missed_severe["true_grade"] = y_true[(y_true >= 3) & (~ref_pred_argmax)]
    missed_severe["pred_grade"] = m_pred_argmax[(y_true >= 3) & (~ref_pred_argmax)]
    missed_severe["p_ge2"] = m_p_ge2[(y_true >= 3) & (~ref_pred_argmax)]
    missed_severe_records = missed_severe[["image_path", "true_grade", "pred_grade", "p_ge2", "patient_id"]].to_dict("records")
    print(f"\nTrue grade>=3 cases predicted NON-referable (argmax<2): {len(missed_severe_records)}")
    for r in missed_severe_records:
        print(f"  {r['image_path']}  true={r['true_grade']}  pred={r['pred_grade']}  "
              f"P(g>=2)={r['p_ge2']:.3f}  patient={r['patient_id']}")

    # ---- step 5: domain-shift diagnostics ----------------------------------
    print("\n" + "=" * 78)
    print("DOMAIN-SHIFT DIAGNOSTICS: Messidor-2 vs v2a's own recovered (in-domain) test")
    print("=" * 78)
    test_conf, test_dist = confidence_and_grade_distribution(test_logits5)
    m_conf, m_dist = confidence_and_grade_distribution(m_logits5)
    print(f"  mean max-softmax confidence : in-domain test={test_conf:.4f}   Messidor-2={m_conf:.4f}   "
          f"delta={m_conf - test_conf:+.4f}")
    print("  predicted-grade distribution:")
    print(f"    {'grade':>6} {'in-domain':>10} {'messidor2':>10}")
    for g in range(NUM_CLASSES):
        print(f"    {g:>6} {test_dist[g]:>10.3f} {m_dist[g]:>10.3f}")

    fovea_report = None
    if not skip_fovea:
        try:
            fovea_report = run_fovea_gate(manifest_df)
        except Exception as e:
            print(f"\nFovea gate diagnostic skipped (did not run cleanly): {e}")

    # ---- step 6: final in-domain vs Messidor-2 report ----------------------
    print("\n" + "=" * 78)
    print("FINAL REPORT: IN-DOMAIN (v2a recovered test) vs MESSIDOR-2")
    print("=" * 78)
    test_pred = test_logits5.argmax(axis=1)
    test_ref_true = test_labels >= REFERABLE_FROM
    test_ref_pred = test_pred >= REFERABLE_FROM
    tp = int((test_ref_true & test_ref_pred).sum()); fn = int((test_ref_true & ~test_ref_pred).sum())
    tn = int((~test_ref_true & ~test_ref_pred).sum()); fp = int((~test_ref_true & test_ref_pred).sum())
    test_qwk = float(cohen_kappa_score(test_labels, test_pred, weights="quadratic"))
    test_sens = tp / (tp + fn) if (tp + fn) else float("nan")
    test_spec = tn / (tn + fp) if (tn + fp) else float("nan")
    test_grade_recall = per_grade_recall(test_labels, test_pred)

    def row(label, indom, mess):
        delta = mess - indom if isinstance(indom, float) and isinstance(mess, float) else float("nan")
        print(f"  {label:32s} in-domain={indom:.4f}   messidor2={mess:.4f}   delta={delta:+.4f}")

    row("QWK", test_qwk, qwk)
    row("Referable sens (argmax)", test_sens, ref_sens_argmax)
    row("Referable spec (argmax)", test_spec, ref_spec_argmax)
    row("Grade-3 recall", test_grade_recall[3]["recall"], grade_recall[3]["recall"])
    row("Grade-4 recall", test_grade_recall[4]["recall"], grade_recall[4]["recall"])
    row("Mean max-softmax confidence", test_conf, m_conf)
    print(f"\n  grade-3 n: in-domain={test_grade_recall[3]['n']}  messidor2={grade_recall[3]['n']}")
    print(f"  grade-4 n: in-domain={test_grade_recall[4]['n']}  messidor2={grade_recall[4]['n']}")
    print("\n  Interpretation is left to the reader in the JSON/TXT report below; "
          "no threshold or preprocessing choice here was adjusted based on these numbers.")

    # ---- write reports ------------------------------------------------------
    report = {
        "checkpoint": str(CKPT_PATH),
        "fidelity_check": {"passed": bool(passed), **fidelity_summary},
        "precision_comparison_messidor2": precision_comparison,
        "n_messidor2_images": int(len(manifest_df)),
        "n_unique_patients": int(manifest_df["patient_id"].nunique()),
        "locked_operating_points": {str(t): lock for t, lock in locked.items()},
        "messidor2_metrics": {
            "qwk": qwk, "auc_p_ge2": auc_p_ge2, "mean_signed_error": mean_signed_error,
            "ref_sens_argmax": ref_sens_argmax, "ref_spec_argmax": ref_spec_argmax,
            "threshold_results": {str(t): r for t, r in threshold_results.items()},
            "per_grade_recall": {str(g): d for g, d in grade_recall.items()},
            "confusion_matrix": cm,
        },
        "patient_bootstrap_ci_95": {k: list(v) for k, v in ci.items()},
        "resolution_breakdown": resolution_report,
        "missed_severe_referable_misses": missed_severe_records,
        "domain_shift": {
            "in_domain_test_mean_confidence": test_conf, "messidor2_mean_confidence": m_conf,
            "in_domain_test_grade_distribution": test_dist, "messidor2_grade_distribution": m_dist,
        },
        "fovea_gate": fovea_report,
        "in_domain_vs_messidor2": {
            "qwk": {"in_domain": test_qwk, "messidor2": qwk},
            "ref_sens_argmax": {"in_domain": test_sens, "messidor2": ref_sens_argmax},
            "ref_spec_argmax": {"in_domain": test_spec, "messidor2": ref_spec_argmax},
            "grade3_recall": {"in_domain": test_grade_recall[3]["recall"], "messidor2": grade_recall[3]["recall"],
                             "in_domain_n": test_grade_recall[3]["n"], "messidor2_n": grade_recall[3]["n"]},
            "grade4_recall": {"in_domain": test_grade_recall[4]["recall"], "messidor2": grade_recall[4]["recall"],
                             "in_domain_n": test_grade_recall[4]["n"], "messidor2_n": grade_recall[4]["n"]},
        },
    }
    with open(REPORT_JSON, "w") as f:
        json.dump(report, f, indent=2, default=float)
    print(f"\nWrote {REPORT_JSON}")


if __name__ == "__main__":
    main()
