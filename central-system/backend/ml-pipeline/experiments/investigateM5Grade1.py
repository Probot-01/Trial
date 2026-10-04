
import json
import os
import subprocess
from pathlib import Path

ML_ROOT = Path(__file__).resolve().parents[1]
SEG_INFER = ML_ROOT / "inference" / "segInfer.py"
PY = os.environ.get("PYTHON_EXECUTABLE", "python")

GRADING_DIR = ML_ROOT / "datasets" / "idrid" / "grading" / "B. Disease Grading" / "1. Original Images"

GRADE1 = {
    "IDRiD_203": "a. Training Set", "IDRiD_290": "a. Training Set",
    "IDRiD_291": "a. Training Set", "IDRiD_021": "b. Testing Set",
}
GRADE0 = {
    "IDRiD_255": "a. Training Set", "IDRiD_267": "a. Training Set",
    "IDRiD_298": "a. Training Set", "IDRiD_351": "a. Training Set",
    "IDRiD_395": "a. Training Set", "IDRiD_396": "a. Training Set",
}

RED_FLOOR = 3  # ruleEngineGrade.m's current threshold


def run(name, subfolder):
    img = GRADING_DIR / subfolder / f"{name}.jpg"
    out = subprocess.run([PY, str(SEG_INFER), str(img)], capture_output=True, text=True)
    if out.returncode != 0:
        print(f"{name}: FAILED rc={out.returncode} stderr={out.stderr[-500:]}")
        return None, None
    start = out.stdout.find("{")
    data = json.loads(out.stdout[start:])
    return data["redLesions"]["count"], data.get("redPerQuadrant")


def main():
    print(f"{'image':14s} {'true grade':10s} {'M5 red count':13s} {'per-quadrant':20s} {'>= redFloor(3)?'}")
    fp, fn = 0, 0
    for name, sub in GRADE1.items():
        c, q = run(name, sub)
        hit = c is not None and c >= RED_FLOOR
        if not hit:
            fn += 1
        print(f"{name:14s} {'1':10s} {str(c):13s} {str(q):20s} {hit}")
    for name, sub in GRADE0.items():
        c, q = run(name, sub)
        hit = c is not None and c >= RED_FLOOR
        if hit:
            fp += 1
        print(f"{name:14s} {'0':10s} {str(c):13s} {str(q):20s} {hit}")

    print(f"\ngrade-1 cases still missed by redFloor={RED_FLOOR}: {fn}/{len(GRADE1)}")
    print(f"grade-0 cases that would be FALSELY escalated: {fp}/{len(GRADE0)}")
    print("\nSee this file's module docstring for the conclusion and what was built instead.")


if __name__ == "__main__":
    main()
