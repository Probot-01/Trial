

import argparse
import csv
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
SEG = os.path.join(ML_ROOT, "inference", "segInfer.py")
IDRID = os.path.join(ML_ROOT, "datasets", "idrid", "grading", "B. Disease Grading")
IMG_DIR = os.path.join(IDRID, "1. Original Images", "b. Testing Set")
LABELS = os.path.join(IDRID, "2. Groundtruths", "b. IDRiD_Disease Grading_Testing Labels.csv")
OUT = os.path.join(HERE, "out")


def run_seg(image, backend):
    env = dict(os.environ, SEG_INFERENCE_BACKEND=backend)
    t0 = time.time()
    p = subprocess.run([sys.executable, SEG, image], capture_output=True, text=True, env=env)
    dt = time.time() - t0
    if p.returncode != 0:
        raise RuntimeError(f"segInfer ({backend}) failed on {image}: {p.stderr[-400:]}")
    return json.loads(p.stdout[p.stdout.index("{"):]), dt


def rule_grades(vectors):
    """ruleEngineGrade for each (red, bright) pair, in ONE MATLAB start."""
    matlab = os.environ.get("MATLAB_EXECUTABLE", "matlab")
    rows = "; ".join(" ".join(str(v) for v in r + b) for r, b in vectors)
    grading = os.path.join(ML_ROOT, "grading").replace("\\", "/")
    expr = (f"addpath('{grading}'); V = [{rows}]; g = zeros(1, size(V,1)); "
            "for i = 1:size(V,1), g(i) = ruleEngineGrade(V(i,1:4), V(i,5:8), 0); end; "
            "disp(jsonencode(g));")
    p = subprocess.run([matlab, "-batch", expr], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-400:])
    out = json.loads(p.stdout[p.stdout.index("["):])
    return out if isinstance(out, list) else [out]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-grade", type=int, default=4)
    args = ap.parse_args()

    with open(LABELS, newline="", encoding="utf-8") as f:
        labels = [(r["Image name"].strip(), int(r["Retinopathy grade"])) for r in csv.DictReader(f)]
    picked = []
    for g in range(5):
        picked += [(n, gr) for n, gr in labels if gr == g][: args.per_grade]

    rows, vectors, times = [], [], {"python": [], "matlab": []}
    for name, grade in picked:
        image = os.path.join(IMG_DIR, name + ".jpg")
        res = {}
        for backend in ("python", "matlab"):
            res[backend], dt = run_seg(image, backend)
            times[backend].append(dt)
        used = res["matlab"].get("segBackend", {}).get("used", {})
        py, ml = res["python"], res["matlab"]

        def dist(a, b):
            return ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5

        row = {
            "image": name, "gtGrade": grade,
            "matlabActuallyUsed": all(used.get(k) == "matlab" for k in
                                      ("vessel", "localization", "bright_lesion")),
            "discShiftPx": round(dist(py["opticDisc"], ml["opticDisc"]), 3),
            "foveaShiftPx": round(dist(py["fovea"], ml["fovea"]), 3),
            "vesselPxPy": py["vessel"]["pixels"], "vesselPxMl": ml["vessel"]["pixels"],
            "redPy": py["redPerQuadrant"], "redMl": ml["redPerQuadrant"],
            "brightPy": py["brightPerQuadrant"], "brightMl": ml["brightPerQuadrant"],
        }
        rows.append(row)
        vectors += [(py["redPerQuadrant"], py["brightPerQuadrant"]),
                    (ml["redPerQuadrant"], ml["brightPerQuadrant"])]
        print(f"{name} g{grade}: disc {row['discShiftPx']}px fovea {row['foveaShiftPx']}px "
              f"vessel {row['vesselPxPy']}/{row['vesselPxMl']} red {row['redPy']}/{row['redMl']} "
              f"bright {row['brightPy']}/{row['brightMl']}", flush=True)

    grades = rule_grades(vectors)
    for i, row in enumerate(rows):
        row["ruleGradePy"], row["ruleGradeMl"] = grades[2 * i], grades[2 * i + 1]

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "seg_backend_parity.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        for r in rows:
            w.writerow({k: json.dumps(v) if isinstance(v, list) else v for k, v in r.items()})

    n = len(rows)
    same = lambda k1, k2: sum(r[k1] == r[k2] for r in rows)
    mean = lambda xs: sum(xs) / len(xs)
    lines = [
        "Segmentation backend parity (backend plan §S.3): PyTorch vs MATLAB session",
        f"{n} IDRiD test images, {args.per_grade} per ground-truth grade 0-4",
        f"MATLAB actually served all three nets on {sum(r['matlabActuallyUsed'] for r in rows)}/{n} images",
        "",
        f"optic disc position identical (shift 0 px): {sum(r['discShiftPx'] == 0 for r in rows)}/{n}"
        f"  (max shift {max(r['discShiftPx'] for r in rows)} px)",
        f"fovea position identical:                   {sum(r['foveaShiftPx'] == 0 for r in rows)}/{n}"
        f"  (max shift {max(r['foveaShiftPx'] for r in rows)} px)",
        f"vessel pixel count identical:               {same('vesselPxPy', 'vesselPxMl')}/{n}"
        f"  (max |diff| {max(abs(r['vesselPxPy'] - r['vesselPxMl']) for r in rows)} px)",
        f"red per-quadrant counts identical:          {same('redPy', 'redMl')}/{n}",
        f"bright per-quadrant counts identical:       {same('brightPy', 'brightMl')}/{n}",
        f"RULE-ENGINE GRADE identical:                {same('ruleGradePy', 'ruleGradeMl')}/{n}",
        "",
        f"mean segInfer wall time, python backend: {mean(times['python']):.2f} s/image",
        f"mean segInfer wall time, matlab backend: {mean(times['matlab']):.2f} s/image",
        "(each segInfer call is a fresh Python process; both columns include its",
        " start-up and the PyTorch M5 load, which stays on Python either way)",
    ]
    report = "\n".join(lines)
    with open(os.path.join(OUT, "seg_backend_parity.txt"), "w", encoding="utf-8") as f:
        f.write(report + "\n")
    print("\n" + report)


if __name__ == "__main__":
    main()
