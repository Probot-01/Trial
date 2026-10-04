

import argparse
import csv
import json
import os
import sys

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

import cv2
import numpy as np
from scipy.stats import beta as beta_dist

try:
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import train_test_split
except ImportError as exc:  # pragma: no cover
    print(f"foveaGateValidation: sklearn required ({exc})", file=sys.stderr)
    raise

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
INFERENCE_DIR = os.path.join(ML_ROOT, "inference")
sys.path.insert(0, INFERENCE_DIR)
sys.path.insert(0, ML_ROOT)

import segInfer  # noqa: E402

LOC = os.path.join(ML_ROOT, "datasets", "idrid", "localization", "C. Localization")
IMG_DIR = os.path.join(LOC, "1. Original Images")
GT_DIR = os.path.join(LOC, "2. Groundtruths")
PRED_CSV = os.path.join(ML_ROOT, "models", "Model3", "localization_test_predictions.csv")
SEG_OD_DIR = os.path.join(ML_ROOT, "datasets", "idrid", "segmentation",
                          "A. Segmentation", "2. All Segmentation Groundtruths")

INPUT_SIZE = segInfer.INPUT_SIZE  # 512
SEED = 42  # matches localization_v1.pt's own ckpt["seed"]
CANDIDATE_THRESHOLDS = [round(t, 2) for t in np.arange(0.05, 0.96, 0.01)]
REPORT_THRESHOLDS = [0.30, 0.40, 0.50]


# ── Ground truth loading ─────────────────────────────────────────────────────
def _read_gt(path):
    out = {}
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.reader(fh):
            if row and row[0].startswith("IDRiD"):
                out[row[0]] = (float(row[1]), float(row[2]))
    return out


def build_full_pool():
    """All 516 (folder, image_id) entries with OD + fovea GT in native px.

    Folder collisions in filename are real, different patients (see module
    docstring) -- every entry is keyed by (folder, image_id), not image_id
    alone.
    """
    folders = {
        "train": "a. Training Set",
        "test": "b. Testing Set",
    }
    od_csv = {
        "train": os.path.join(GT_DIR, "1. Optic Disc Center Location",
                              "a. IDRiD_OD_Center_Training Set_Markups.csv"),
        "test": os.path.join(GT_DIR, "1. Optic Disc Center Location",
                             "b. IDRiD_OD_Center_Testing Set_Markups.csv"),
    }
    fovea_csv = {
        "train": os.path.join(GT_DIR, "2. Fovea Center Location",
                              "IDRiD_Fovea_Center_Training Set_Markups.csv"),
        "test": os.path.join(GT_DIR, "2. Fovea Center Location",
                             "IDRiD_Fovea_Center_Testing Set_Markups.csv"),
    }

    pool = []
    for folder_key, folder_name in folders.items():
        od_gt = _read_gt(od_csv[folder_key])
        fov_gt = _read_gt(fovea_csv[folder_key])
        img_dir = os.path.join(IMG_DIR, folder_name)
        for image_id in sorted(od_gt):
            if image_id not in fov_gt:
                continue
            path = os.path.join(img_dir, image_id + ".jpg")
            if not os.path.exists(path):
                continue
            pool.append({
                "folder": folder_key,
                "id": image_id,
                "path": path,
                "od_gt": od_gt[image_id],
                "fovea_gt": fov_gt[image_id],
            })
    return pool


def resolve_test_keys(pool):
    """The exact 78-image TEST set, as (folder, id) keys.

    Reproduces verifyModel3.resolve_images()'s od_true-matching disambiguation:
    the predictions CSV's od_true_x/y is the GT under the model's OWN 512
    squish mapping, so it identifies which physical folder each id came from
    without guessing.

    Resolved PER ROW, not per image_id: IDRiD_050 appears twice in the
    predictions CSV (once from each official folder -- both really are TEST
    images, they just share a filename). Keying by image_id alone would let
    the second row silently overwrite the first and lose one real test image.
    """
    with open(PRED_CSV, newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))

    by_key = {(e["folder"], e["id"]): e for e in pool}
    resolved, unresolved = set(), []
    for row in rows:
        img_id = row["image_id"]
        tx, ty = float(row["od_true_x"]), float(row["od_true_y"])
        hits = []
        for folder_key in ("train", "test"):
            e = by_key.get((folder_key, img_id))
            if e is None:
                continue
            img = cv2.imread(e["path"], cv2.IMREAD_COLOR)
            if img is None:
                continue
            h, w = img.shape[:2]
            gx, gy = e["od_gt"]
            if abs(gx * INPUT_SIZE / w - tx) < 0.01 and abs(gy * INPUT_SIZE / h - ty) < 0.01:
                hits.append(folder_key)
        if len(hits) == 1:
            resolved.add((hits[0], img_id))
        else:
            unresolved.append((img_id, len(hits)))
    return resolved, unresolved


def assign_splits(pool):
    """test = exact recovered 78; val = RECONSTRUCTED (see module docstring);
    train = remainder, reported as seen-by-the-model either way."""
    test_keys, unresolved = resolve_test_keys(pool)
    remaining = [e for e in pool if (e["folder"], e["id"]) not in test_keys]

    target_val_n = round(0.15 * len(pool))  # sizing anchor only, see docstring
    remaining_keys = [(e["folder"], e["id"]) for e in remaining]
    train_keys_list, val_keys_list = train_test_split(
        remaining_keys, test_size=target_val_n, random_state=SEED, shuffle=True)
    val_keys = set(val_keys_list)
    train_keys = set(train_keys_list)

    for e in pool:
        key = (e["folder"], e["id"])
        if key in test_keys:
            e["split"] = "test"
        elif key in val_keys:
            e["split"] = "val_reconstructed"
        else:
            assert key in train_keys
            e["split"] = "train_seen_by_model"
    return unresolved


# ── Disc-diameter gross-miss threshold ───────────────────────────────────────
def measure_disc_diameter_px():
    diams = []
    for folder in ("a. Training Set", "b. Testing Set"):
        d = os.path.join(SEG_OD_DIR, folder, "5. Optic Disc")
        if not os.path.isdir(d):
            continue
        for fname in sorted(os.listdir(d)):
            m = cv2.imread(os.path.join(d, fname), cv2.IMREAD_UNCHANGED)
            if m is None:
                continue
            area = int((m > 0).sum())
            if area > 0:
                diams.append(2.0 * np.sqrt(area / np.pi))
    diams = np.array(diams, dtype=float)
    return diams


# ── Inference ────────────────────────────────────────────────────────────────
def run_inference(pool):
    records = []
    for i, e in enumerate(pool):
        bgr = cv2.imread(e["path"], cv2.IMREAD_COLOR)
        if bgr is None:
            print(f"foveaGateValidation: could not read {e['path']}, skipping",
                  file=sys.stderr)
            continue
        h, w = bgr.shape[:2]
        pts = segInfer.localize(bgr)

        gx, gy = e["fovea_gt"]
        gx512, gy512 = gx * INPUT_SIZE / w, gy * INPUT_SIZE / h

        pred = pts["fovea"]
        err_native = float(np.hypot(pred["x"] - gx, pred["y"] - gy))
        err_512 = float(np.hypot(pred["x512"] - gx512, pred["y512"] - gy512))

        records.append({
            "id": e["id"], "folder": e["folder"], "split": e["split"],
            "peak": pred["peak"],
            "err_native": err_native, "err_512": err_512,
        })
        if (i + 1) % 100 == 0 or (i + 1) == len(pool):
            print(f"  ... {i + 1}/{len(pool)} images", file=sys.stderr)
    return records


# ── Stats ────────────────────────────────────────────────────────────────────
def clopper_pearson(k, n, alpha=0.05):
    if n == 0:
        return (float("nan"), float("nan"))
    lo = 0.0 if k == 0 else beta_dist.ppf(alpha / 2, k, n - k + 1)
    hi = 1.0 if k == n else beta_dist.ppf(1 - alpha / 2, k + 1, n - k)
    return (float(lo), float(hi))


def percentiles(values, ps=(0, 5, 25, 50, 75, 90, 95, 99, 100)):
    values = np.asarray(values, dtype=float)
    return {p: float(np.percentile(values, p)) for p in ps}


def print_distribution(records, label):
    peaks = [r["peak"] for r in records]
    err512 = [r["err_512"] for r in records]
    errnat = [r["err_native"] for r in records]
    print(f"\n-- {label}: n={len(records)} --")
    print("  peak percentiles:      " + fmt_pct(percentiles(peaks)))
    print("  error@512 percentiles: " + fmt_pct(percentiles(err512)))
    print("  error@native percentiles: " + fmt_pct(percentiles(errnat)))


def fmt_pct(d):
    return ", ".join(f"p{p}={v:.3f}" for p, v in d.items())


def evaluate_threshold(records, threshold, gross_key="gross_miss_native"):
    """Confusion of (peak < threshold) vs (is a gross miss), on one split."""
    n = len(records)
    n_pos = sum(1 for r in records if r[gross_key])   # gross misses
    n_neg = n - n_pos
    tp = sum(1 for r in records if r[gross_key] and r["peak"] < threshold)
    fn = n_pos - tp
    fp = sum(1 for r in records if not r[gross_key] and r["peak"] < threshold)
    tn = n_neg - fp

    sens_lo, sens_hi = clopper_pearson(tp, n_pos) if n_pos else (float("nan"), float("nan"))
    far_lo, far_hi = clopper_pearson(fp, n_neg) if n_neg else (float("nan"), float("nan"))

    return {
        "threshold": threshold, "n": n, "n_gross_miss": n_pos, "n_good": n_neg,
        "tp": tp, "fn": fn, "fp": fp, "tn": tn,
        "sensitivity": (tp / n_pos) if n_pos else float("nan"),
        "sensitivity_ci95": (sens_lo, sens_hi),
        "false_alarm_rate": (fp / n_neg) if n_neg else float("nan"),
        "false_alarm_rate_ci95": (far_lo, far_hi),
    }


def compute_auc(records, gross_key="gross_miss_native"):
    y = np.array([1 if r[gross_key] else 0 for r in records])
    n_pos, n_neg = int(y.sum()), int((1 - y).sum())
    if n_pos == 0 or n_neg == 0:
        return None, n_pos, n_neg
    score = np.array([-r["peak"] for r in records])   # lower peak = more likely gross miss
    return float(roc_auc_score(y, score)), n_pos, n_neg


def print_threshold_table(records, thresholds, gross_key="gross_miss_native"):
    print(f"  {'thr':>5} {'n':>4} {'miss':>5} {'good':>5} {'TP':>4} {'FN':>4} "
          f"{'FP':>4} {'TN':>4} {'sens':>7} {'sens_CI95':>18} "
          f"{'FAR':>7} {'FAR_CI95':>18}")
    for t in thresholds:
        r = evaluate_threshold(records, t, gross_key)
        sens = f"{r['sensitivity']:.3f}" if r["n_gross_miss"] else "n/a"
        far = f"{r['false_alarm_rate']:.3f}" if r["n_good"] else "n/a"
        sci = f"[{r['sensitivity_ci95'][0]:.3f},{r['sensitivity_ci95'][1]:.3f}]" \
            if r["n_gross_miss"] else "n/a"
        fci = f"[{r['false_alarm_rate_ci95'][0]:.3f},{r['false_alarm_rate_ci95'][1]:.3f}]" \
            if r["n_good"] else "n/a"
        print(f"  {t:>5.2f} {r['n']:>4} {r['n_gross_miss']:>5} {r['n_good']:>5} "
              f"{r['tp']:>4} {r['fn']:>4} {r['fp']:>4} {r['tn']:>4} "
              f"{sens:>7} {sci:>18} {far:>7} {fci:>18}")


def pick_threshold_on_val(val_records, gross_key="gross_miss_native"):
    """The smallest candidate threshold that catches every known VAL gross
    miss. Thresholds are scanned in increasing order and sensitivity is
    monotonically non-decreasing in threshold, so the first one to reach
    100% IS the smallest -- no FAR-based tie-break is needed or applied; a
    FAR-based tie-break would (and, in an earlier version of this function,
    did) silently prefer a LARGER threshold whenever several small
    thresholds shared the same FAR, contradicting the "smallest" the
    function name promises. If VAL has zero gross misses (expected: ~2.6% of
    ~77 images is close to 0-2), there is nothing to fit sensitivity against
    -- fall back to the smallest threshold with a false-alarm rate no worse
    than 5% on VAL, and say so plainly.
    """
    n_pos = sum(1 for r in val_records if r[gross_key])
    evals = [evaluate_threshold(val_records, t, gross_key) for t in CANDIDATE_THRESHOLDS]

    if n_pos == 0:
        print("\n  VAL has 0 gross misses (reconstructed VAL, small n -- see module "
              "docstring): cannot fit a sensitivity-driven threshold. Falling back "
              "to the largest threshold with VAL false-alarm rate <= 5%.")
        candidates = [e for e in evals if e["false_alarm_rate"] <= 0.05]
        chosen = max(candidates, key=lambda e: e["threshold"]) if candidates \
            else min(evals, key=lambda e: e["false_alarm_rate"])
        return chosen["threshold"], "no VAL gross misses; chosen by false-alarm rate <=5%"

    full_sens = [e for e in evals if e["sensitivity"] == 1.0]
    if full_sens:
        chosen = min(full_sens, key=lambda e: e["threshold"])
        return chosen["threshold"], "smallest threshold with 100% VAL gross-miss sensitivity"

    chosen = max(evals, key=lambda e: (e["sensitivity"], -e["false_alarm_rate"]))
    return chosen["threshold"], "no threshold reached 100% VAL sensitivity; picked the best available"


# ── Contact sheet ────────────────────────────────────────────────────────────
def save_contact_sheet(records, pool_by_key, out_path, n=12):
    lowest = sorted(records, key=lambda r: r["peak"])[:n]
    cols, cell = 4, 260
    rows = (len(lowest) + cols - 1) // cols
    sheet = np.full((rows * cell, cols * cell, 3), 30, dtype=np.uint8)

    for i, r in enumerate(lowest):
        e = pool_by_key[(r["folder"], r["id"])]
        bgr = cv2.imread(e["path"], cv2.IMREAD_COLOR)
        h, w = bgr.shape[:2]
        thumb = cv2.resize(bgr, (cell, cell), interpolation=cv2.INTER_AREA)
        sx, sy = cell / w, cell / h

        pts = segInfer.localize(bgr)
        pred_x, pred_y = pts["fovea"]["x"] * sx, pts["fovea"]["y"] * sy
        gt_x, gt_y = e["fovea_gt"][0] * sx, e["fovea_gt"][1] * sy

        cv2.drawMarker(thumb, (int(round(pred_x)), int(round(pred_y))),
                       (0, 0, 255), cv2.MARKER_CROSS, 18, 2)   # red = predicted
        cv2.drawMarker(thumb, (int(round(gt_x)), int(round(gt_y))),
                       (0, 255, 0), cv2.MARKER_TILTED_CROSS, 18, 2)  # green = true
        cv2.putText(thumb, f"{e['id']} p={r['peak']:.3f}", (6, 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(thumb, f"{r['split']}", (6, cell - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 200, 0), 1, cv2.LINE_AA)

        rr, cc = divmod(i, cols)
        sheet[rr * cell:(rr + 1) * cell, cc * cell:(cc + 1) * cell] = thumb

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    cv2.imwrite(out_path, sheet)
    return out_path, [(r["id"], r["folder"], r["split"], r["peak"]) for r in lowest]


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--contact-sheet-out", default=None,
                    help="Path for the 12-lowest-peak contact sheet PNG "
                         "(default: OUT_DIR/fovea_gate_contact_sheet.png, "
                         "outside the git repo)")
    ap.add_argument("--json-out", default=None,
                    help="Optional path to dump the full per-image record list")
    args = ap.parse_args()

    print(f"CUDA_VISIBLE_DEVICES={os.environ.get('CUDA_VISIBLE_DEVICES')!r} "
          f"(should be '' -- CPU only)")

    print("Building the full 516-image pool with GT ...")
    pool = build_full_pool()
    print(f"  pool size: {len(pool)}")
    if len(pool) != 516:
        print(f"  WARNING: expected 516, got {len(pool)} -- see per-folder counts below",
              file=sys.stderr)

    print("Resolving the exact TEST-78 split from localization_test_predictions.csv ...")
    unresolved = assign_splits(pool)
    if unresolved:
        print(f"  {len(unresolved)} predictions-CSV id(s) did not resolve to a unique "
              f"folder and were excluded from TEST: {unresolved}")
    counts = {}
    for e in pool:
        counts[e["split"]] = counts.get(e["split"], 0) + 1
    print(f"  split sizes: {counts}")

    print("\nMeasuring optic-disc diameter from IDRiD's segmentation subset "
          "(81 masks: 54 train + 27 test) ...")
    diam_native_all = measure_disc_diameter_px()
    disc_diam_native = float(np.median(diam_native_all))
    x_scale, y_scale = INPUT_SIZE / 4288.0, INPUT_SIZE / 2848.0
    disc_diam_512 = disc_diam_native * np.sqrt(x_scale * y_scale)
    print(f"  n={len(diam_native_all)} masks, median diameter = {disc_diam_native:.1f} px "
          f"(native, 4288x2848) -> {disc_diam_512:.1f} px at 512 "
          f"(area-preserving scale sqrt({x_scale:.4f}*{y_scale:.4f}))")
    print(f"  gross-miss threshold: error_native > {disc_diam_native:.1f} px (AUTHORITATIVE), "
          f"error_512 > {disc_diam_512:.1f} px (reported alongside, not identical by "
          f"construction -- the 512 resize is a non-uniform x/y squish, see below)")
    print(f"  (task's own 80px-at-512 fallback would have been the number used "
          f"if this measurement were unavailable -- {disc_diam_512:.1f} px is close "
          f"to it, which is a sanity cross-check, not a coincidence relied on)")

    print(f"\nRunning localization_v1 forward pass on all {len(pool)} images (CPU) ...")
    records = run_inference(pool)

    for r in records:
        # bool(...): a numpy.bool_ from this comparison is NOT a json-serialisable
        # Python bool (json.dumps raises on it) -- cast immediately so every
        # downstream consumer, including --json-out, gets a real bool.
        r["gross_miss_native"] = bool(r["err_native"] > disc_diam_native)
        r["gross_miss_512"] = bool(r["err_512"] > disc_diam_512)

    by_split = {"train_seen_by_model": [], "val_reconstructed": [], "test": []}
    for r in records:
        by_split[r["split"]].append(r)

    print("\n" + "=" * 78)
    print("ERROR DISTRIBUTION (shown first, before any threshold talk)")
    print("=" * 78)
    print_distribution(records, "ALL 516")
    for split_name, recs in by_split.items():
        print_distribution(recs, split_name)

    n_gross_512 = sum(1 for r in records if r["gross_miss_512"])
    n_gross_native = sum(1 for r in records if r["gross_miss_native"])
    print(f"\nGross misses (error_native > {disc_diam_native:.1f}px, NATIVE -- authoritative "
          f"below): {n_gross_native}/{len(records)} ({100 * n_gross_native / len(records):.1f}%)")
    print(f"Gross misses (error_512 > {disc_diam_512:.1f}px, 512-space): {n_gross_512}/{len(records)} "
          f"({100 * n_gross_512 / len(records):.1f}%)")
    if n_gross_512 != n_gross_native:
        discordant = [r["id"] for r in records if r["gross_miss_512"] != r["gross_miss_native"]]
        print(f"  These do NOT have to match, and here they differ by {abs(n_gross_512 - n_gross_native)} "
              f"image(s): {discordant}. The 512 resize is a non-uniform x/y SQUISH "
              f"(x_scale={x_scale:.4f} != y_scale={y_scale:.4f} because every IDRiD image "
              f"here is 4288x2848, not square), so a circle of error becomes an ellipse "
              f"under that mapping -- Euclidean distance in native px and Euclidean "
              f"distance in 512px are not simply proportional, and a near-threshold error "
              f"vector that is mostly along one axis can cross one space's threshold "
              f"without crossing the other's. This is expected anisotropy, not a bug. "
              f"NATIVE is treated as authoritative from here on because the disc-diameter "
              f"threshold is a real anatomical measurement in native pixels; 512-space "
              f"numbers are still reported in full below for the resolution the task asked "
              f"for, but gross-miss/sensitivity/FAR/AUC decisions use NATIVE.")
    else:
        print("  MATCH (no discordant images this run).")
    for split_name, recs in by_split.items():
        n_gm = sum(1 for r in recs if r["gross_miss_native"])
        print(f"  {split_name}: {n_gm}/{len(recs)} gross misses (native) "
              f"({100 * n_gm / len(recs) if recs else float('nan'):.1f}%)")

    print("\n" + "=" * 78)
    print("THRESHOLD SELECTION ON VAL ONLY (val_reconstructed -- see caveats above)")
    print("=" * 78)
    print_threshold_table(by_split["val_reconstructed"],
                          sorted(set(CANDIDATE_THRESHOLDS) | set(REPORT_THRESHOLDS)))
    chosen_threshold, reason = pick_threshold_on_val(by_split["val_reconstructed"])
    print(f"\nCHOSEN THRESHOLD: {chosen_threshold:.2f}  ({reason})")

    print("\n" + "=" * 78)
    print("TEST RESULTS (the trustworthy headline numbers -- exact, unreconstructed split)")
    print("=" * 78)
    test_recs = by_split["test"]
    print(f"TEST n={len(test_recs)}, gross misses={sum(1 for r in test_recs if r['gross_miss_native'])}")
    print_threshold_table(test_recs, sorted(set(REPORT_THRESHOLDS) | {round(chosen_threshold, 2)}))

    auc, n_pos, n_neg = compute_auc(test_recs)
    print(f"\nTEST AUC (peak as a gross-miss detector, higher peak = more reliable): ", end="")
    if auc is None:
        print(f"NOT COMPUTABLE -- only {n_pos} positive(s) (gross misses) and "
              f"{n_neg} negative(s) in TEST. AUC needs both classes present; with "
              f"n_pos={n_pos} this number would not be a reliable claim even if "
              f"sklearn returned one.")
    elif n_pos < 5:
        print(f"{auc:.3f}  -- CAUTION: only {n_pos} positive(s) in TEST (n_neg={n_neg}). "
              f"Treat this AUC as indicative, not a statistically supported claim -- "
              f"too few positives for a tight confidence interval.")
    else:
        print(f"{auc:.3f}  (n_pos={n_pos}, n_neg={n_neg})")

    print("\n" + "=" * 78)
    print("TRAIN-SPLIT RESULTS (seen-by-the-model -- reconstructed pool, not a real "
          "held-out evaluation; reported per the task, labelled accordingly)")
    print("=" * 78)
    train_recs = by_split["train_seen_by_model"]
    print(f"train n={len(train_recs)}, gross misses={sum(1 for r in train_recs if r['gross_miss_native'])}")
    print_threshold_table(train_recs, sorted(set(REPORT_THRESHOLDS) | {round(chosen_threshold, 2)}))
    train_auc, tn_pos, tn_neg = compute_auc(train_recs)
    if train_auc is None:
        print(f"train AUC NOT COMPUTABLE (n_pos={tn_pos}, n_neg={tn_neg})")
    else:
        print(f"train AUC: {train_auc:.3f} (n_pos={tn_pos}, n_neg={tn_neg}) -- SEEN BY THE MODEL, "
              f"expect this to look better than TEST and not be representative of new images")

    n_flagged = sum(1 for r in records if r["peak"] < chosen_threshold)
    print(f"\nFraction flagged foveaUnreliable across all {len(records)} images at "
          f"threshold {chosen_threshold:.2f}: {n_flagged}/{len(records)} "
          f"({100 * n_flagged / len(records):.2f}%)")

    out_dir = args.contact_sheet_out
    if out_dir is None:
        default_dir = os.environ.get("FOVEA_GATE_OUT_DIR")
        if not default_dir:
            print("\nNo --contact-sheet-out and no FOVEA_GATE_OUT_DIR env var set; "
                  "skipping the contact sheet. Pass one of these to save it "
                  "(outside the git repo).", file=sys.stderr)
            out_dir = None
        else:
            out_dir = os.path.join(default_dir, "fovea_gate_contact_sheet.png")

    if out_dir:
        pool_by_key = {(e["folder"], e["id"]): e for e in pool}
        path, lowest_info = save_contact_sheet(records, pool_by_key, out_dir)
        print(f"\nContact sheet (12 lowest-peak images, predicted=red X / true=green X) "
              f"saved to: {path}")
        for img_id, folder, split, peak in lowest_info:
            print(f"  {img_id} ({folder}, {split}): peak={peak:.4f}")

    if args.json_out:
        def _default(o):
            if isinstance(o, np.generic):   # numpy.bool_, numpy.float64, ...
                return o.item()
            raise TypeError(f"Object of type {o.__class__.__name__} is not JSON serializable")

        with open(args.json_out, "w") as fh:
            json.dump({
                "disc_diam_native_px": disc_diam_native,
                "disc_diam_512_px": disc_diam_512,
                "chosen_threshold": chosen_threshold,
                "chosen_threshold_reason": reason,
                "records": records,
            }, fh, indent=2, default=_default)
        print(f"\nFull per-image record dump written to {args.json_out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
