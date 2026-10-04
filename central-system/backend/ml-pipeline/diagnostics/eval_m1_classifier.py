

import argparse
import csv
import json
import os
import sys
from collections import Counter

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ML_ROOT, "inference"))
sys.path.insert(0, ML_ROOT)

import branchAInfer  # noqa: E402

GRADING = os.path.join(ML_ROOT, "datasets", "idrid", "grading",
                       "B. Disease Grading")
IMG_DIRS = {"train": "a. Training Set", "test": "b. Testing Set"}
LABEL_FILES = {
    "train": "a. IDRiD_Disease Grading_Training Labels.csv",
    "test":  "b. IDRiD_Disease Grading_Testing Labels.csv",
}
MODEL1_DIR = os.path.join(ML_ROOT, "models", "Model1")

GRADE_NAMES = {0: "No DR", 1: "Mild NPDR", 2: "Moderate NPDR",
               3: "Severe NPDR", 4: "Proliferative DR"}
REFERABLE_FROM = 2


def load_labels(split):
    path = os.path.join(GRADING, "2. Groundtruths", LABEL_FILES[split])
    out = {}
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.reader(fh):
            if row and row[0].startswith("IDRiD"):
                out[row[0].strip()] = int(row[1])
    return out


def qwk(y_true, y_pred, n=5):
    from sklearn.metrics import cohen_kappa_score
    return float(cohen_kappa_score(y_true, y_pred, weights="quadratic",
                                   labels=list(range(n))))


def confusion(y_true, y_pred, n=5):
    m = np.zeros((n, n), np.int64)
    for t, p in zip(y_true, y_pred):
        m[int(t), int(p)] += 1
    return m


def print_report(title, y_true, y_pred, probs=None, contaminated=False):
    y_true, y_pred = np.asarray(y_true, int), np.asarray(y_pred, int)
    n = len(y_true)
    print(f"\n{'=' * 74}")
    print(title)
    if contaminated:
        print("*** CONTAMINATED -- contains images M1 was trained on. ***")
        print("*** These are training-error figures, NOT accuracy.     ***")
    print("=" * 74)
    print(f"images: {n}")

    k = qwk(y_true, y_pred)
    acc = float((y_true == y_pred).mean())
    print(f"\nQuadratic Weighted Kappa : {k:.4f}")
    print(f"Exact accuracy           : {acc:.4f}")
    print(f"Within-1-grade accuracy  : "
          f"{float((np.abs(y_true - y_pred) <= 1).mean()):.4f}")

    cm = confusion(y_true, y_pred)
    print(f"\nCONFUSION MATRIX   (rows = true, cols = predicted)")
    print(f"{'':>18s}" + "".join(f"{p:>8d}" for p in range(5)) + f"{'total':>9s}")
    for t in range(5):
        row = cm[t]
        print(f"  {t} {GRADE_NAMES[t]:<14s}" +
              "".join(f"{v:>8d}" for v in row) + f"{row.sum():>9d}")
    print(f"  {'predicted total':<16s}" +
          "".join(f"{cm[:, p].sum():>8d}" for p in range(5)) +
          f"{cm.sum():>9d}")

    print(f"\nPER-GRADE")
    print(f"  {'grade':<20s}{'n':>5s}{'recall':>9s}{'prec':>9s}{'f1':>9s}"
          f"{'mean signed err':>17s}")
    per_grade = {}
    for g in range(5):
        sel = y_true == g
        ng = int(sel.sum())
        if ng == 0:
            print(f"  {GRADE_NAMES[g]:<20s}{0:>5d}{'--':>9s}{'--':>9s}"
                  f"{'--':>9s}{'--':>17s}")
            continue
        rec = float((y_pred[sel] == g).mean())
        pcol = y_pred == g
        prec = float((y_true[pcol] == g).mean()) if pcol.sum() else float("nan")
        f1 = (2 * rec * prec / (rec + prec)) if (rec + prec) else float("nan")
        # Signed: negative means the model grades this class LOWER than truth.
        signed = float((y_pred[sel] - g).mean())
        per_grade[g] = {"n": ng, "recall": rec, "precision": prec, "f1": f1,
                        "mean_signed_error": signed}
        print(f"  {GRADE_NAMES[g]:<20s}{ng:>5d}{rec:>9.4f}{prec:>9.4f}"
              f"{f1:>9.4f}{signed:>+17.3f}")

    # Direction of error. The asymmetry is the clinical finding, not the rate.
    err = y_pred - y_true
    under = int((err < 0).sum())
    over = int((err > 0).sum())
    print(f"\nERROR DIRECTION")
    print(f"  under-graded (pred < true) : {under:>4d}  ({100.0 * under / n:5.2f}%)")
    print(f"  over-graded  (pred > true) : {over:>4d}  ({100.0 * over / n:5.2f}%)")
    print(f"  correct                    : {int((err == 0).sum()):>4d}  "
          f"({100.0 * (err == 0).mean():5.2f}%)")
    print(f"  mean signed error overall  : {err.mean():+.4f}")
    if under + over:
        print(f"  of all errors, {100.0 * under / (under + over):.1f}% are "
              f"UNDER-grades")

    # Referable = grade >= 2. This is the number the screening pathway acts on.
    t_ref, p_ref = y_true >= REFERABLE_FROM, y_pred >= REFERABLE_FROM
    tp = int((t_ref & p_ref).sum()); fn = int((t_ref & ~p_ref).sum())
    tn = int((~t_ref & ~p_ref).sum()); fp = int((~t_ref & p_ref).sum())
    sens = tp / (tp + fn) if tp + fn else float("nan")
    spec = tn / (tn + fp) if tn + fp else float("nan")
    print(f"\nREFERABLE DR (grade >= {REFERABLE_FROM})")
    print(f"  TP {tp}  FN {fn}  TN {tn}  FP {fp}")
    print(f"  Sensitivity {sens:.4f}    Specificity {spec:.4f}")
    if tp + fn:
        print(f"  MISSED referable cases: {fn} of {tp + fn} "
              f"({100.0 * fn / (tp + fn):.1f}%)")

    # Grade 4 is the sight-threatening class; where its misses land decides
    # whether a miss is a downgrade within referable or a fall-through to
    # non-referable, which are very different clinically.
    sel4 = y_true == 4
    if sel4.sum():
        dist = Counter(y_pred[sel4].tolist())
        print(f"\nGRADE 4 (Proliferative DR) -- where the {int(sel4.sum())} "
              f"true cases were sent")
        for g in range(5):
            if dist.get(g):
                tag = "  <- correct" if g == 4 else (
                    "  <- NOT REFERABLE" if g < REFERABLE_FROM else "")
                print(f"    predicted {g} ({GRADE_NAMES[g]:<16s}): "
                      f"{dist[g]:>3d}{tag}")
        miss_ref = int((y_pred[sel4] < REFERABLE_FROM).sum())
        print(f"    grade-4 recall {float((y_pred[sel4] == 4).mean()):.4f}; "
              f"{miss_ref} fell below the referral threshold entirely")

    return {"n": n, "qwk": k, "accuracy": acc,
            "confusion": cm.tolist(), "per_grade": per_grade,
            "under": under, "over": over,
            "referable": {"tp": tp, "fn": fn, "tn": tn, "fp": fp,
                          "sensitivity": sens, "specificity": spec},
            "contaminated": contaminated}


def parse_idrid_id(model_id):
    """'idrid__idrid_train_IDRiD_396' -> ('train', 'IDRiD_396').

    The split is carried IN the id, which is what makes these usable at all:
    IDRiD's grading Training and Testing folders both contain an IDRiD_001,
    so the bare number names two different eyes.
    """
    tail = model_id.split("__", 1)[1] if "__" in model_id else model_id
    for split in ("train", "test"):
        prefix = f"idrid_{split}_"
        if tail.startswith(prefix):
            return split, tail[len(prefix):]
    return None, None


def run_images(cases, ckpt, model):
    """cases = [(key, path, label)] -> (labels, preds, probs, missing)."""
    import torch
    y_true, y_pred, probs, missing = [], [], [], []
    for key, path, label in cases:
        if not os.path.exists(path):
            missing.append(key)
            continue
        x, _base = branchAInfer.preprocess(path, ckpt)
        with torch.no_grad():
            logits = model(torch.from_numpy(x)).numpy()[0]
        p = branchAInfer.softmax(logits)
        y_true.append(label)
        y_pred.append(int(p.argmax()))
        probs.append(p)
    return (np.array(y_true), np.array(y_pred),
            np.array(probs) if probs else None, missing)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", dest="which", default="all",
                    choices=["heldout", "idrid-heldout", "idrid-all", "all"])
    ap.add_argument("--json", default=None, help="write metrics to this file")
    args = ap.parse_args()

    results = {}
    want = ({"heldout", "idrid-heldout", "idrid-all"} if args.which == "all"
            else {args.which})

    # ---- A. the model's own held-out split, from its published logits ----
    if "heldout" in want:
        ids = np.load(os.path.join(MODEL1_DIR, "branchA_v1_test_ids.npy"),
                      allow_pickle=True)
        labels = np.load(os.path.join(MODEL1_DIR, "branchA_v1_test_labels.npy"),
                         allow_pickle=True)
        logits = np.load(os.path.join(MODEL1_DIR, "branchA_v1_test_logits.npy"),
                         allow_pickle=True)
        preds = logits.argmax(1)
        src = Counter(str(i).split("__")[0] for i in ids)
        print(f"source mix of the held-out split: {dict(src)}")
        results["heldout"] = print_report(
            "A. M1 HELD-OUT TEST SPLIT (published logits, 550 APTOS + 78 IDRiD)",
            labels, preds)

        # Per-source breakdown: a pooled kappa can hide one dataset carrying
        # the other, and IDRiD is the distribution this pipeline actually runs
        # on in the field.
        for source in sorted(src):
            sel = np.array([str(i).startswith(source + "__") for i in ids])
            if sel.sum() > 10:
                results[f"heldout_{source}"] = print_report(
                    f"A{source[0].upper()}. HELD-OUT, {source.upper()} SUBSET ONLY",
                    labels[sel], preds[sel])

    if not want & {"idrid-heldout", "idrid-all"}:
        if args.json:
            with open(args.json, "w", encoding="utf-8") as fh:
                json.dump(results, fh, indent=2)
        return 0

    model, ckpt = branchAInfer.load_model()
    lab = {s: load_labels(s) for s in ("train", "test")}

    # ---- B. the IDRiD images inside the held-out split, re-run ----
    if "idrid-heldout" in want:
        ids = np.load(os.path.join(MODEL1_DIR, "branchA_v1_test_ids.npy"),
                      allow_pickle=True)
        logits = np.load(os.path.join(MODEL1_DIR, "branchA_v1_test_logits.npy"),
                         allow_pickle=True)
        published = {}
        cases = []
        for i, mid in enumerate(ids):
            split, img_id = parse_idrid_id(str(mid))
            if split is None:
                continue
            path = os.path.join(GRADING, "1. Original Images",
                                IMG_DIRS[split], img_id + ".jpg")
            truth = lab[split].get(img_id)
            if truth is None:
                continue
            cases.append(((split, img_id), path, truth))
            published[(split, img_id)] = logits[i]

        y_true, y_pred, _p, missing = run_images(cases, ckpt, model)
        print(f"\nIDRiD subset of held-out split: {len(cases)} ids, "
              f"{len(y_true)} scored, {len(missing)} image files absent")
        if missing:
            print(f"  absent: {[m[1] for m in missing][:10]}"
                  f"{' ...' if len(missing) > 10 else ''}")
        if len(y_true):
            results["idrid_heldout"] = print_report(
                "B. IDRiD IMAGES WITHIN M1'S HELD-OUT SPLIT (re-run from pixels)",
                y_true, y_pred)

            # Reproduction check: our logits vs the ones training recorded. A
            # gap here means the preprocessing drifted, and every number in
            # this file would be measuring a different chain.
            import torch
            agree, diffs = 0, []
            for (key, path, _t) in cases:
                if not os.path.exists(path):
                    continue
                x, _b = branchAInfer.preprocess(path, ckpt)
                with torch.no_grad():
                    ours = model(torch.from_numpy(x)).numpy()[0]
                theirs = published[key]
                diffs.append(float(np.abs(ours - theirs).max()))
                agree += int(ours.argmax() == theirs.argmax())
            if diffs:
                print(f"\n  REPRODUCTION vs published logits: "
                      f"argmax agrees {agree}/{len(diffs)}, "
                      f"max|logit diff| mean {np.mean(diffs):.4f}, "
                      f"worst {np.max(diffs):.4f}")

    # ---- C. all of IDRiD grading, contaminated ----
    if "idrid-all" in want:
        cases = []
        for split in ("train", "test"):
            folder = os.path.join(GRADING, "1. Original Images", IMG_DIRS[split])
            if not os.path.isdir(folder):
                continue
            for img_id, truth in sorted(lab[split].items()):
                cases.append(((split, img_id),
                              os.path.join(folder, img_id + ".jpg"), truth))
        y_true, y_pred, _p, missing = run_images(cases, ckpt, model)
        print(f"\nfull IDRiD grading: {len(cases)} labelled ids, "
              f"{len(y_true)} scored, {len(missing)} image files absent "
              f"(the grading Training folder on this machine holds "
              f"IDRiD_163-413 only)")
        if len(y_true):
            results["idrid_all"] = print_report(
                "C. ALL IDRiD GRADING IMAGES ON DISK", y_true, y_pred,
                contaminated=True)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(results, fh, indent=2, default=float)
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
