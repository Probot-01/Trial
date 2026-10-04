

import csv
import glob
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
SEG_INFER = os.path.join(ML_ROOT, "inference", "segInfer.py")
REFERENCE = os.path.join(ML_ROOT, "diagnostics", "out", "agreement_results.csv")
GRADING = os.path.join(ML_ROOT, "datasets", "idrid", "grading",
                       "B. Disease Grading", "1. Original Images")


def rule_grade(red_q, sum_bright, red_floor=3, quad_min=3, moderate=5,
               bright_floor=1, max_grade=3):
    """Python mirror of ruleEngineGrade.m's defaults, for this check only.

    Deliberately NOT the production path — that is MATLAB, and this script is
    verifying counts, not re-implementing the rule engine. If the two ever
    disagree, ruleEngineGrade.m is right.
    """
    total = sum(red_q)
    if red_q and all(q >= quad_min for q in red_q):
        grade = 3
    elif total >= red_floor and (sum_bright >= bright_floor or total > moderate):
        grade = 2
    elif total >= red_floor:
        grade = 1
    else:
        grade = 0
    return min(grade, max_grade)


def main():
    if not os.path.exists(REFERENCE):
        print(f"missing {REFERENCE}", file=sys.stderr)
        return 2
    with open(REFERENCE, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    print(f"{'image':12s}{'ref':>5}{'ours':>6}  {'ref quadrants':<18}"
          f"{'ours':<18}{'grade ref/ours':>15}")
    sum_ok = quad_ok = grade_ok = n = 0
    for row in rows:
        hits = glob.glob(os.path.join(GRADING, "**", row["image"] + ".jpg"),
                         recursive=True)
        if not hits:
            print(f"{row['image']:12s}  source image not present")
            continue
        proc = subprocess.run([sys.executable, SEG_INFER, hits[0]],
                              capture_output=True, text=True)
        if proc.returncode != 0:
            print(f"{row['image']:12s}  segInfer failed: {proc.stderr.strip()[:60]}")
            continue
        out = json.loads(proc.stdout)

        ours = out["redLesions"]["count"]
        our_q = out["redPerQuadrant"]
        ref = int(row["sum_red"])
        ref_q = list(eval(row["red_per_quadrant"]))  # noqa: S307 - our own CSV
        bright = int(row["sum_bright"])

        g_ref, g_ours = rule_grade(ref_q, bright), rule_grade(our_q, bright)
        sum_ok += (ref == ours)
        quad_ok += (ref_q == our_q)
        grade_ok += (g_ref == g_ours)
        n += 1
        flag = "" if ref_q == our_q else "  (quadrants differ)"
        print(f"{row['image']:12s}{ref:>5}{ours:>6}  {str(ref_q):<18}"
              f"{str(our_q):<18}{g_ref:>7}/{g_ours:<7}{flag}")

    print(f"\nsum(red) exact          : {sum_ok}/{n}")
    print(f"quadrant vector exact   : {quad_ok}/{n}")
    print(f"rule-engine grade equal : {grade_ok}/{n}")

    # The bar is sum and GRADE, not the quadrant vector — see the docstring.
    ok = (sum_ok == n and grade_ok == n)
    print("\nVERDICT:", "counts reproduce the calibration" if ok
          else "counts do NOT reproduce the calibration -- do not grade with them")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
