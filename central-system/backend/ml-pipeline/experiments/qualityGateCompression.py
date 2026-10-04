

import argparse
import csv
import json
import os
import subprocess
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(ML_ROOT)))
GATE_DIR = os.path.join(REPO, "phc-local-app", "backend", "quality-gate-matlab")
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ML_ROOT, "inference"))

MATLAB_SCRIPT = """
addpath('{gate}');
d = dir(fullfile('{outdir}', '*.jpg'));
fid = fopen('{csv}', 'w');
fprintf(fid, 'file,variant,status,reason,focus,illum,occl,glare,motion,fov\\n');
for i = 1:numel(d)
    p = fullfile(d(i).folder, d(i).name);
    try
        r = qualityGateMain(p, '{camera}');
        rs = r.reason; if isempty(rs), rs = '-'; end
        v = 'clean'; if contains(d(i).name, '_B_'), v = 'jpeg10'; end
        sc = r.scores;
        fprintf(fid, '%s,%s,%s,%s,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f\\n', ...
                d(i).name, v, r.status, rs, sc.focusScore, sc.illuminationScore, ...
                gf(sc,'occlusionScore'), gf(sc,'glareScore'), ...
                gf(sc,'motionScore'), gf(sc,'fovScore'));
    catch ME
        fprintf(fid, '%s,err,err,%s,NaN,NaN,NaN,NaN,NaN,NaN\\n', d(i).name, ME.message);
    end
end
fclose(fid);
function v = gf(s, f)
if isfield(s, f), v = s.(f); else, v = NaN; end
end
"""


def build_pairs(outdir, limit):
    from domainGap import resolve_idrid, jpeg
    ids = np.load(os.path.join(ML_ROOT, "models", "Model1",
                               "branchA_v1_test_ids.npy"), allow_pickle=True)
    os.makedirs(outdir, exist_ok=True)
    for f in os.listdir(outdir):
        if f.endswith(".jpg"):
            os.remove(os.path.join(outdir, f))
    n = 0
    for s in ids:
        s = str(s)
        if not s.startswith("idrid"):
            continue
        path = resolve_idrid(s)
        if not path:
            continue
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        base = os.path.splitext(os.path.basename(path))[0]
      
        cv2.imwrite(os.path.join(outdir, base + "_A_clean.jpg"), bgr,
                    [int(cv2.IMWRITE_JPEG_QUALITY), 95])
        cv2.imwrite(os.path.join(outdir, base + "_B_jpeg10.jpg"), jpeg(bgr, 1.0),
                    [int(cv2.IMWRITE_JPEG_QUALITY), 95])
        n += 1
        if limit and n >= limit:
            break
    return n


def sweep(clean, degraded):
    rows = []
    for t in np.arange(0.05, 0.45, 0.01):
        cp = float((clean >= t).mean())
        jr = float((degraded < t).mean())
        rows.append({"threshold": round(float(t), 2), "cleanPass": cp,
                     "compressedReject": jr, "youden": cp + jr - 1})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=0, help="image pairs (0 = all)")
    ap.add_argument("--outdir", default=os.path.join(HERE, "qg_images"))
    ap.add_argument("--camera", default="forus_3nethra_v2")
    ap.add_argument("--out", default=os.path.join(HERE, "quality_gate_compression.json"))
    args = ap.parse_args()

    n = build_pairs(args.outdir, args.n)
    print(f"built {n} clean/compressed pairs in {args.outdir}")

    csv_path = os.path.join(args.outdir, "gate.csv")

    script = os.path.join(args.outdir, "runQualityGate.m")
  
    with open(script, "w", encoding="ascii", newline="\n") as fh:
        fh.write(MATLAB_SCRIPT.strip().format(
            gate=GATE_DIR.replace("\\", "/"),
            outdir=args.outdir.replace("\\", "/"),
            csv=csv_path.replace("\\", "/"),
            camera=args.camera))

    subprocess.run(["matlab", "-batch", f"run('{script}')".replace("\\", "/")],
                   check=True)

    with open(csv_path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    out = {"n": n, "camera": args.camera}
    focus = {}
    for variant in ("clean", "jpeg10"):
        sub = [r for r in rows if r["variant"] == variant]
        f = np.array([float(r["focus"]) for r in sub])
        focus[variant] = f
        statuses = {}
        reasons = {}
        for r in sub:
            statuses[r["status"]] = statuses.get(r["status"], 0) + 1
            reasons[r["reason"]] = reasons.get(r["reason"], 0) + 1
        out[variant] = {
            "n": len(sub), "status": statuses, "reason": reasons,
            "focusMin": float(f.min()), "focusMedian": float(np.median(f)),
            "focusMax": float(f.max()),
            "passedAt0_40": int((f >= 0.40).sum()),
        }
        print(f"{variant:8s} n={len(sub)} status={statuses} "
              f"focus min {f.min():.4f} median {np.median(f):.4f} max {f.max():.4f}")

    out["thresholdSweep"] = sweep(focus["clean"], focus["jpeg10"])
    best = max(out["thresholdSweep"], key=lambda r: r["youden"])
    out["bestThreshold"] = best
    out["currentThreshold"] = 0.40
    print(f"\ncurrent 0.40  -> clean pass {100*(focus['clean']>=0.4).mean():.1f}%, "
          f"compressed reject {100*(focus['jpeg10']<0.4).mean():.1f}%")
    print(f"best {best['threshold']:.2f}     -> clean pass {100*best['cleanPass']:.1f}%, "
          f"compressed reject {100*best['compressedReject']:.1f}%")

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    print(f"written to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
