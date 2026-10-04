

import csv
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ML_ROOT = HERE.parent
sys.path.insert(0, str(ML_ROOT / "inference"))
sys.path.insert(0, str(ML_ROOT))
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

import cv2  # noqa: E402
import segInfer as seg  # noqa: E402

GRADING_ROOT = ML_ROOT / "datasets" / "idrid" / "grading" / "B. Disease Grading"
OUT_DIR = ML_ROOT / "diagnostics" / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)
COUNTS_CSV = OUT_DIR / "gate2_lesion_counts.csv"
REPORT_JSON = OUT_DIR / "gate2_recalibration_report.json"
REPORT_TXT = OUT_DIR / "gate2_recalibration_report.txt"
THRESHOLDS_OUT = ML_ROOT / "models" / "rule_thresholds_red_v2.json"

SPLITS = {
    "train": ("a. Training Set", "a. IDRiD_Disease Grading_Training Labels.csv"),
    "test":  ("b. Testing Set",  "b. IDRiD_Disease Grading_Testing Labels.csv"),
}

OLD_CONSTANTS = {"redFloor": 3, "grade3QuadMin": 3, "brightFloor": 1, "moderateRedCount": 5}


# ── Dataset ──────────────────────────────────────────────────────────────────
def load_split(split):
    folder, csvname = SPLITS[split]
    imgdir = GRADING_ROOT / "1. Original Images" / folder
    files = {p.stem for p in imgdir.glob("*.jpg")}
    rows = []
    with open(GRADING_ROOT / "2. Groundtruths" / csvname, newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            iid = r["Image name"].strip()
            if iid and iid in files:
                rows.append((iid, int(r["Retinopathy grade"]), str(imgdir / f"{iid}.jpg")))
    return rows


# ── Per-image inference (v1 AND v2 red-lesion counts in one pass) ──────────
def process_image(path):
    bgr = cv2.imread(path, cv2.IMREAD_COLOR)
    if bgr is None:
        raise IOError(f"cannot read {path}")
    pts = seg.localize(bgr)
    disc = (pts["opticDisc"]["x"], pts["opticDisc"]["y"])
    fovea = (pts["fovea"]["x"], pts["fovea"]["y"])

    seg.RED_LESION_MODEL_VERSION = "v1"
    _red_o, _bright_o, _od, red512_v1, bright512, box, _extra = seg.lesions(bgr, disc)
    disc512 = seg._to_crop512(disc[0], disc[1], box)
    fovea512 = seg._to_crop512(fovea[0], fovea[1], box)
    red_comps_v1 = seg.describe(red512_v1, 10)          # v1's own CLI default floor
    bright_comps = seg.describe(bright512, 10)           # unaffected by RED_LESION_MODEL_VERSION
    red_q_v1 = seg.quadrant_counts(red_comps_v1, fovea512, disc512)
    bright_q = seg.quadrant_counts(bright_comps, fovea512, disc512)

    seg.RED_LESION_MODEL_VERSION = "v2"
    _red_o2, _bright_o2, _od2, _red512_v2, _bright512_v2, box2, extra_v2 = seg.lesions(bgr, disc)
    ma_floor, he_floor = seg._red_v2_floors()
    ma_comps = seg.describe(extra_v2["ma512"], ma_floor)
    he_comps = seg.describe(extra_v2["he512"], he_floor)
    ma_q = seg.quadrant_counts(ma_comps, fovea512, disc512)
    he_q = seg.quadrant_counts(he_comps, fovea512, disc512)
    red_q_v2 = [m + h for m, h in zip(ma_q, he_q)]

    return {"red_q_v1": red_q_v1, "bright_q": bright_q,
            "red_q_v2": red_q_v2, "ma_q": ma_q, "he_q": he_q}


def build_or_load_counts():
    have = {}
    if COUNTS_CSV.is_file():
        with open(COUNTS_CSV, newline="") as fh:
            for r in csv.DictReader(fh):
                have[(r["split"], r["image"])] = r

    todo = []
    all_rows = {}
    for split in ("train", "test"):
        for iid, gt, path in load_split(split):
            all_rows[(split, iid)] = (gt, path)
            if (split, iid) not in have:
                todo.append((split, iid, gt, path))

    print(f"Cached counts for {len(have)} images; {len(todo)} to compute.")
    fieldnames = ["split", "image", "gt", "red_q_v1", "bright_q", "red_q_v2", "ma_q", "he_q"]
    if todo:
        t0 = time.time()
        with open(COUNTS_CSV, "a", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=fieldnames)
            if not have:
                w.writeheader()
            for i, (split, iid, gt, path) in enumerate(todo):
                r = process_image(path)
                row = {"split": split, "image": iid, "gt": gt,
                      "red_q_v1": r["red_q_v1"], "bright_q": r["bright_q"],
                      "red_q_v2": r["red_q_v2"], "ma_q": r["ma_q"], "he_q": r["he_q"]}
                w.writerow(row)
                have[(split, iid)] = {k: str(v) for k, v in row.items()}
                if (i + 1) % 25 == 0 or (i + 1) == len(todo):
                    fh.flush()
                    print(f"  {i + 1}/{len(todo)}  ({time.time() - t0:.1f}s elapsed)", file=sys.stderr)

    import ast
    records = {"train": [], "test": []}
    for (split, iid), gt_path in all_rows.items():
        gt, _path = gt_path
        r = have[(split, iid)]
        records[split].append({
            "image": iid, "gt": gt,
            "red_q_v1": list(ast.literal_eval(r["red_q_v1"])),
            "bright_q": list(ast.literal_eval(r["bright_q"])),
            "red_q_v2": list(ast.literal_eval(r["red_q_v2"])),
            "ma_q": list(ast.literal_eval(r["ma_q"])),
            "he_q": list(ast.literal_eval(r["he_q"])),
        })
    return records


# ── Threshold fitting (TRAIN ONLY) ──────────────────────────────────────────
def youden_threshold(scores, positive_mask, candidates):
    scores = np.asarray(scores, dtype=float)
    positive_mask = np.asarray(positive_mask, dtype=bool)
    best = None
    for t in candidates:
        pred_pos = scores >= t
        tp = int((positive_mask & pred_pos).sum())
        fn = int((positive_mask & ~pred_pos).sum())
        tn = int((~positive_mask & ~pred_pos).sum())
        fp = int((~positive_mask & pred_pos).sum())
        sens = tp / (tp + fn) if (tp + fn) else 0.0
        spec = tn / (tn + fp) if (tn + fp) else 0.0
        j = sens + spec - 1
        if best is None or j > best["j"]:
            best = {"t": t, "j": j, "sens": sens, "spec": spec,
                    "tp": tp, "fn": fn, "tn": tn, "fp": fp}
    return best


def fit_thresholds(train_records, red_key):
    gt = np.array([r["gt"] for r in train_records])
    sum_red = np.array([sum(r[red_key]) for r in train_records])
    min_quad_red = np.array([min(r[red_key]) for r in train_records])
    sum_bright = np.array([sum(r["bright_q"]) for r in train_records])

    max_red = int(sum_red.max())
    max_bright = int(sum_bright.max())

    red_floor_fit = youden_threshold(sum_red, gt >= 1, range(0, max_red + 2))
    grade3_fit = youden_threshold(min_quad_red, gt >= 3, range(0, int(min_quad_red.max()) + 2))
    bright_floor_fit = youden_threshold(sum_bright, gt >= 1, range(0, max_bright + 2))

    return {
        "redFloor": {"value": red_floor_fit["t"], "fit": red_floor_fit,
                    "n_train": len(train_records)},
        "grade3QuadMin": {"value": grade3_fit["t"], "fit": grade3_fit,
                          "n_train": len(train_records)},
        "brightFloor": {"value": bright_floor_fit["t"], "fit": bright_floor_fit,
                        "n_train": len(train_records),
                        "caveat": ("secondary/less-rigorous: fit as a standalone "
                                   "grade0-vs-rest noise floor on sum(bright), not "
                                   "jointly with redFloor the way the rule actually "
                                   "uses it (conditional on red already present)")},
    }


# ── The rule itself, parameterised (mirrors ruleEngineGrade.m's structure,
#    reimplemented in Python only for this diagnostic -- NOT a substitute for
#    or a copy shipped into ruleEngineGrade.m) ──────────────────────────────
def apply_rule(red_q, bright_q, red_floor, grade3_quad_min, bright_floor,
               moderate_red_count=5, max_grade=3):
    sr = sum(red_q)
    sb = sum(bright_q)
    if all(q >= grade3_quad_min for q in red_q):
        g = 3
    elif sr >= red_floor and (sb >= bright_floor or sr > moderate_red_count):
        g = 2
    elif sr >= red_floor:
        g = 1
    else:
        g = 0
    return min(g, max_grade)


# ── Stats ────────────────────────────────────────────────────────────────────
def wilson_ci(k, n, z=1.959963984540054):
    if n == 0:
        return (float("nan"), float("nan"))
    phat = k / n
    denom = 1 + z * z / n
    center = phat + z * z / (2 * n)
    adj = z * np.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n))
    return (float((center - adj) / denom), float((center + adj) / denom))


def evaluate(records, red_key, red_floor, grade3_quad_min, bright_floor, label):
    n = len(records)
    preds = [apply_rule(r[red_key], r["bright_q"], red_floor, grade3_quad_min, bright_floor)
            for r in records]
    gts = [r["gt"] for r in records]
    exact = sum(int(p == g) for p, g in zip(preds, gts))
    within1 = sum(int(abs(p - g) <= 1) for p, g in zip(preds, gts))

    cm = [[0] * 5 for _ in range(5)]  # rows=GT(0..4), cols=pred(0..3, index into same 5x5)
    for p, g in zip(preds, gts):
        cm[g][p] += 1
    n_per_grade = {g: gts.count(g) for g in range(5)}

    exact_ci = wilson_ci(exact, n)
    within1_ci = wilson_ci(within1, n)

    return {
        "label": label, "n": n,
        "exact_agreement": {"k": exact, "n": n, "rate": exact / n, "ci95": list(exact_ci)},
        "within1_agreement": {"k": within1, "n": n, "rate": within1 / n, "ci95": list(within1_ci)},
        "confusion_matrix_rows_gt_cols_pred": cm,
        "n_per_grade": n_per_grade,
    }


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    lines = []

    def out(s=""):
        print(s)
        lines.append(s)

    out("=" * 78)
    out("GATE 2: rule-threshold recalibration on IDRiD GRADING (v1 vs v2 counts)")
    out("=" * 78)

    records = build_or_load_counts()
    out(f"\ntrain n={len(records['train'])} (official split has 413; see the data-gap "
        f"note in this file's docstring)   test n={len(records['test'])} (complete, 103/103)")

    from collections import Counter
    out(f"train grade counts: {dict(sorted(Counter(r['gt'] for r in records['train']).items()))}")
    out(f"test  grade counts: {dict(sorted(Counter(r['gt'] for r in records['test']).items()))}")

    report = {"data_gap": {
        "official_train_n": 413, "available_train_n": len(records["train"]),
        "missing_train_ids": "IDRiD_001-IDRiD_162 (162 consecutive, confirmed via directory listing)",
        "test_n": len(records["test"]), "test_complete": len(records["test"]) == 103,
    }}

    results = {}
    for version, red_key in [("v1", "red_q_v1"), ("v2", "red_q_v2")]:
        out("\n" + "=" * 78)
        out(f"VERSION {version} ({red_key})")
        out("=" * 78)

        fitted = fit_thresholds(records["train"], red_key)
        out(f"\nFitted on TRAIN (n={len(records['train'])}), Youden's J:")
        for name, d in fitted.items():
            f = d["fit"]
            out(f"  {name:15s} = {d['value']:2d}   J={f['j']:.3f}  sens={f['sens']:.3f}  "
                f"spec={f['spec']:.3f}  (tp={f['tp']} fn={f['fn']} tn={f['tn']} fp={f['fp']})")
            if "caveat" in d:
                out(f"    caveat: {d['caveat']}")

        rf, g3, bf = fitted["redFloor"]["value"], fitted["grade3QuadMin"]["value"], fitted["brightFloor"]["value"]

        eval_new = {}
        eval_old = {}
        for split in ("train", "test"):
            eval_new[split] = evaluate(records[split], red_key, rf, g3, bf, f"{version}-recalibrated-{split}")
            eval_old[split] = evaluate(records[split], red_key, OLD_CONSTANTS["redFloor"],
                                       OLD_CONSTANTS["grade3QuadMin"], OLD_CONSTANTS["brightFloor"],
                                       f"{version}-old_constants-{split}")

        for split in ("train", "test"):
            out(f"\n-- {split.upper()} (n={eval_new[split]['n']}) --")
            en, eo = eval_new[split], eval_old[split]
            out(f"  OLD constants  (redFloor=3, grade3QuadMin=3, brightFloor=1):")
            out(f"    exact:   {eo['exact_agreement']['k']}/{eo['n']} = {eo['exact_agreement']['rate']:.3f}  "
                f"95% CI [{eo['exact_agreement']['ci95'][0]:.3f},{eo['exact_agreement']['ci95'][1]:.3f}]")
            out(f"    within1: {eo['within1_agreement']['k']}/{eo['n']} = {eo['within1_agreement']['rate']:.3f}  "
                f"95% CI [{eo['within1_agreement']['ci95'][0]:.3f},{eo['within1_agreement']['ci95'][1]:.3f}]")
            out(f"  NEW recalibrated (redFloor={rf}, grade3QuadMin={g3}, brightFloor={bf}):")
            out(f"    exact:   {en['exact_agreement']['k']}/{en['n']} = {en['exact_agreement']['rate']:.3f}  "
                f"95% CI [{en['exact_agreement']['ci95'][0]:.3f},{en['exact_agreement']['ci95'][1]:.3f}]")
            out(f"    within1: {en['within1_agreement']['k']}/{en['n']} = {en['within1_agreement']['rate']:.3f}  "
                f"95% CI [{en['within1_agreement']['ci95'][0]:.3f},{en['within1_agreement']['ci95'][1]:.3f}]")
            out(f"    n per grade: {en['n_per_grade']}")
            out(f"    confusion matrix (rows=GT 0-4, cols=pred 0-3; pred can never be 4, "
                f"RULE_MAX_GRADE=3):")
            for g_idx, row in enumerate(en["confusion_matrix_rows_gt_cols_pred"]):
                out(f"      GT={g_idx}: {row[:4]}")

        results[version] = {"fitted": fitted, "new": eval_new, "old": eval_old}

    report["results"] = results

    # ── Is the 71.4%-on-14-images figure superseded? ───────────────────────
    out("\n" + "=" * 78)
    out("IS THE EARLIER 71.4%-ON-14-IMAGES FIGURE SUPERSEDED?")
    out("=" * 78)
    old14_rate = 10 / 14
    v1_test_exact = results["v1"]["new"]["test"]["exact_agreement"]["rate"]
    v1_test_ci = results["v1"]["new"]["test"]["exact_agreement"]["ci95"]
    out(f"Old figure: rule_v2 vs ground truth, n=14, exact agreement 10/14 = {100*old14_rate:.1f}%.")
    out(f"This run, v1 counts, recalibrated thresholds, TEST (n={results['v1']['new']['test']['n']}): "
        f"{100*v1_test_exact:.1f}%  95% CI [{100*v1_test_ci[0]:.1f}%,{100*v1_test_ci[1]:.1f}%].")
    if old14_rate < v1_test_ci[0] or old14_rate > v1_test_ci[1]:
        out(f"SUPERSEDED: {100*old14_rate:.1f}% falls OUTSIDE the 95% CI of the same-style "
            f"(v1 counts) figure on {results['v1']['new']['test']['n']} held-out test images. "
            f"The n=14 figure should not be quoted as the current operating point.")
    else:
        out(f"NOT clearly superseded: {100*old14_rate:.1f}% falls within the 95% CI on the "
            f"larger test set -- consistent with the old figure, not contradicting it, but "
            f"the n=14 estimate was always too small to trust on its own.")
    report["superseded_check"] = {
        "old_n14_rate": old14_rate, "new_test_rate_v1": v1_test_exact, "new_test_ci_v1": v1_test_ci,
    }

    # ── Write the new thresholds file (NOT ruleEngineGrade.m) ──────────────
    thresholds_doc = {
        "_comment": ("Fitted by diagnostics/recalibrateRuleGate2.py on the IDRiD GRADING "
                    "dataset (train-fit / test-report; see that script's docstring for the "
                    "known train-split data gap: 251/413 official train images available "
                    "locally, test split complete at 103/103). NOT read by any production "
                    "code yet -- see 'saadMustChange' below for exactly what Saad needs to "
                    "wire up in ruleEngineGrade.m to use these instead of its current "
                    "hardcoded defaults."),
        "fittedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fittedOn": f"IDRiD grading TRAIN split, n={len(records['train'])} "
                    f"(251/413 available -- see _comment)",
        "reportedOn": f"IDRiD grading TEST split, n={len(records['test'])} (complete, untouched)",
        "v1": {k: v["value"] for k, v in results["v1"]["fitted"].items()},
        "v2": {k: v["value"] for k, v in results["v2"]["fitted"].items()},
        "ruleMaxGrade": 3,
        "note": ("ruleMaxGrade is NOT a fitted quantity -- it is the safety cap described in "
                "ruleEngineGrade.m's header (grade 4 = NV suspicion / Branch A only) and is "
                "carried through unchanged, not recalibrated."),
        "saadMustChange": [
            "grading/ruleEngineGrade.m lines ~122-126: replace the getdef(...) DEFAULT "
            "VALUES for redFloor / grade3QuadMin / brightFloor with the values under "
            "this file's 'v1' key (if still running RED_LESION_MODEL_VERSION=v1) or "
            "'v2' key (once v2 is the live red-lesion model) -- e.g. "
            "redFloor = getdef(opts, 'redFloor', <thresholds.v1.redFloor or v2.redFloor>).",
            "The docstring comments at lines ~49-69 (the 'measured on 14 validation "
            "images' justification) should be updated to cite this file's n and method "
            "instead, since the 14-image figure is superseded (see this report's own "
            "superseded_check section) -- but that text edit is Saad's call, not made here.",
        ],
    }
    with open(THRESHOLDS_OUT, "w") as fh:
        json.dump(thresholds_doc, fh, indent=2)
    out(f"\nWrote {THRESHOLDS_OUT}")
    out("Saad must change (grading/ruleEngineGrade.m, NOT edited by this script):")
    for line in thresholds_doc["saadMustChange"]:
        out(f"  - {line}")

    def _default(o):
        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
        raise TypeError(f"{type(o)} not serializable")

    with open(REPORT_JSON, "w") as fh:
        json.dump(report, fh, indent=2, default=_default)
    with open(REPORT_TXT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"\nWrote {REPORT_JSON}")
    print(f"Wrote {REPORT_TXT}")


if __name__ == "__main__":
    raise SystemExit(main())
