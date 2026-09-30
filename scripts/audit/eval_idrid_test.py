"""Independent check of the SERVED Branch A classifier on the official IDRiD test set.
Uses branchAInfer's own load_model / preprocess / calibration / assign_tier (no re-implementation)."""
import os, sys, csv, json, glob
import numpy as np

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "central-system", "backend", "ml-pipeline"))
sys.path.insert(0, os.path.join(ROOT, "inference"))
sys.path.insert(0, os.path.join(ROOT, "preprocessing"))
sys.path.insert(0, os.path.join(ROOT, "training"))
import torch
import branchAInfer as b

lab = {}
csvp = os.path.join(ROOT, "datasets", "idrid", "grading", "B. Disease Grading", "2. Groundtruths", "b. IDRiD_Disease Grading_Testing Labels.csv")
with open(csvp, newline="", encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        lab[r["Image name"].strip()] = int(r["Retinopathy grade"])
imgdir = os.path.join(ROOT, "datasets", "idrid", "grading", "B. Disease Grading", "1. Original Images", "b. Testing Set")
files = {os.path.splitext(os.path.basename(p))[0]: p for p in glob.glob(os.path.join(imgdir, "*"))}

model, ckpt = b.load_model()
calib = b.load_calibration(ckpt)
T = float(calib.get("temperature", 1.0))
rows = []
for name in sorted(lab):
    if name not in files:
        continue
    x, base, _ = b.preprocess(files[name], ckpt)
    with torch.no_grad():
        logits = model(torch.from_numpy(x)).numpy()[0]
    cal = b.softmax(logits / T)
    grade = int(cal.argmax())
    tier, pred_set, reason, lo, hi, contig = b.assign_tier(cal, calib)
    p_ref = float(cal[2] + cal[3] + cal[4]); p34 = float(cal[3] + cal[4])
    thr = calib.get("referableThreshold")
    referable = (p34 > 0.5) or (calib.get("calibrated", False) and thr is not None and p_ref >= float(thr))
    rows.append(dict(name=name, truth=lab[name], grade=grade, tier=tier, referable=bool(referable), conf=float(cal[grade]), contig=bool(contig)))

n = len(rows)
t = np.array([r["truth"] for r in rows]); g = np.array([r["grade"] for r in rows])
ref_t = t >= 2; ref_p = np.array([r["referable"] for r in rows]); ref_g = g >= 2
def sens(pred): return float((pred & ref_t).sum() / max(1, ref_t.sum()))
def spec(pred): return float((~pred & ~ref_t).sum() / max(1, (~ref_t).sum()))
# quadratic weighted kappa
K = 5
O = np.zeros((K, K))
for a, c in zip(t, g): O[a, c] += 1
E = np.outer(O.sum(1), O.sum(0)) / O.sum()
W = np.array([[(i - j) ** 2 / (K - 1) ** 2 for j in range(K)] for i in range(K)])
qwk = 1 - (W * O).sum() / (W * E).sum()
tiers = {k: sum(1 for r in rows if r["tier"] == k) for k in "ABC"}
autoclear_missed = sum(1 for r in rows if r["tier"] == "A" and r["truth"] >= 2)
out = dict(model=b.BRANCH_A_MODEL_VERSION, n=n, truth_dist={int(k): int((t == k).sum()) for k in range(5)},
           exact_acc=float((t == g).mean()), within1=float((abs(t - g) <= 1).mean()), qwk=float(qwk),
           referable_truth=int(ref_t.sum()),
           argmax_ref_sens=sens(ref_g), argmax_ref_spec=spec(ref_g),
           flag_ref_sens=sens(ref_p), flag_ref_spec=spec(ref_p),
           tiers=tiers, tierA_but_truly_referable=int(autoclear_missed),
           grade4_recall=float(((g == 4) & (t == 4)).sum() / max(1, (t == 4).sum())), n_grade4=int((t == 4).sum()),
           confusion=O.astype(int).tolist(), calibrated=bool(calib.get("calibrated", False)),
           contiguous_frac=float(np.mean([r["contig"] for r in rows])))
print(json.dumps(out, indent=1))
