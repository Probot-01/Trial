 
import ast
import csv
from collections import defaultdict
from pathlib import Path

CSV = Path(__file__).resolve().parent / "out" / "agreement_results.csv"


# --------------------------------------------------------------------------
# Rule engines
# --------------------------------------------------------------------------
def rule_v1(red_q, sum_bright, nv=0.0):
    """Original rule, verbatim from the request."""
    sr = sum(red_q)
    if nv > 0.6:
        return 4
    if all(q > 20 for q in red_q):
        return 3
    if sr > 0 and (sum_bright > 0 or sr > 5):
        return 2
    if sr > 0:
        return 1
    return 0


# ---- calibrated constants (justified in main() from the real distribution) --
RED_FLOOR = 3            # replaces ">0"  (grade-0 FP noise floor tops out at 2)
GRADE3_QUAD_MIN = 3      # replaces ">20 in all quads" (max observed min-quadrant = 14)
RULE_MAX_GRADE = 3       # hard cap: NV / grade 4 is the classifier's call, not the rule's


def rule_v2(red_q, sum_bright, nv=0.0):
    """Recalibrated rule.
    - 'lesions present' now means sum(red) >= RED_FLOOR (both places the old
      rule used '> 0').
    - grade 3 = red lesions in EVERY quadrant at >= GRADE3_QUAD_MIN
      ('diffuse' haemorrhage), instead of the unreachable '> 20 in all quads'.
    - output hard-capped at grade 3; grade 4 comes from the classifier branch.
    """
    sr = sum(red_q)
    if nv > 0.6:                                     # dead branch (no NV model) - kept for parity
        g = 4
    elif all(q >= GRADE3_QUAD_MIN for q in red_q):
        g = 3
    elif sr >= RED_FLOOR and (sum_bright > 0 or sr > 5):
        g = 2
    elif sr >= RED_FLOOR:
        g = 1
    else:
        g = 0
    return min(g, RULE_MAX_GRADE)


# --------------------------------------------------------------------------
def main():
    rows = []
    with open(CSV) as f:
        for r in csv.DictReader(f):
            rows.append({
                "image": r["image"],
                "gt": int(r["gt_grade"]),
                "clf": int(r["classifier_grade"]),
                "rule_v1_saved": int(r["rule_grade"]),
                "sum_red": int(r["sum_red"]),
                "sum_bright": int(r["sum_bright"]),
                "red_q": list(ast.literal_eval(r["red_per_quadrant"])),
            })
    n = len(rows)
    print(f"Loaded {n} images from {CSV.name}\n")

    # ---- 1. distributions grouped by GT grade --------------------------
    by_grade = defaultdict(list)
    for x in rows:
        by_grade[x["gt"]].append(x)

    print("=" * 74)
    print("  DISTRIBUTION OF RED-LESION COUNTS BY GROUND-TRUTH GRADE")
    print("=" * 74)
    print(f"  {'GT':>2} {'n':>2}  {'sum(red) values':<28} {'min-quadrant values':<22}")
    print("  " + "-" * 70)
    for g in sorted(by_grade):
        xs = by_grade[g]
        sreds = sorted(x["sum_red"] for x in xs)
        minqs = sorted(min(x["red_q"]) for x in xs)
        print(f"  {g:>2} {len(xs):>2}  {str(sreds):<28} {str(minqs):<22}")
    print("  " + "-" * 70)

    g0_max = max(x["sum_red"] for x in by_grade[0])
    g1_min = min(x["sum_red"] for x in by_grade[1])
    all_minq = [min(x["red_q"]) for x in rows]
    g3_minqs = sorted(min(x["red_q"]) for x in by_grade.get(3, []))
    g2_minqs = sorted(min(x["red_q"]) for x in by_grade.get(2, []))

    print(f"\n  grade-1 boundary  (replace 'sum(red) > 0'):")
    print(f"    grade-0 images  -> sum(red) max = {g0_max}   (this is the FP noise floor)")
    print(f"    grade-1 images  -> sum(red) min = {g1_min}")
    print(f"    clean gap at {g0_max} | {g1_min}  ==>  RED_FLOOR = {RED_FLOOR}  "
          f"(sum(red) >= {RED_FLOOR})")

    print(f"\n  grade-3 boundary  (replace '> 20 in ALL 4 quadrants'):")
    print(f"    max min-quadrant count observed anywhere = {max(all_minq)}   "
          f"(so '> 20 in all quads' is unreachable)")
    print(f"    grade-2 images  -> min-quadrant values = {g2_minqs}")
    print(f"    grade-3 images  -> min-quadrant values = {g3_minqs}")
    print(f"    grade-2 tops out at {max(g2_minqs)}, grade-3 starts at {min(g3_minqs)}  "
          f"==>  GRADE3_QUAD_MIN = {GRADE3_QUAD_MIN}  (red >= {GRADE3_QUAD_MIN} in every quadrant)")
    print(f"    (n={len(g3_minqs)} grade-3 images - provisional; re-check with more labels)")

    print(f"\n  grade-4:  no model emits an NV score -> rule output hard-capped at "
          f"grade {RULE_MAX_GRADE}. Grade-4 detection = classifier branch only.")

    # ---- 2. sanity: rule_v1 reproduces the saved column ----------------
    repro = all(rule_v1(x["red_q"], x["sum_bright"]) == x["rule_v1_saved"] for x in rows)
    print(f"\n  [sanity] rule_v1() reproduces saved rule grades exactly: {repro}")

    # ---- 3. re-score old vs new --------------------------------------
    print("\n" + "=" * 74)
    print("  PER-IMAGE RE-SCORE  (same 14 images, same saved counts)")
    print("=" * 74)
    hdr = f"  {'image':11s} {'GT':>2} {'red_q':>16} {'sRed':>4} {'sBrt':>4} | " \
          f"{'v1':>2} {'v2':>2} {'clf':>3} | {'agrV1':>5} {'agrV2':>5}"
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    ex1 = ex2 = w1 = w2 = 0
    for x in rows:
        g1 = rule_v1(x["red_q"], x["sum_bright"])
        g2 = rule_v2(x["red_q"], x["sum_bright"])
        a1, a2 = (g1 == x["clf"]), (g2 == x["clf"])
        ex1 += a1; ex2 += a2
        w1 += abs(g1 - x["clf"]) <= 1
        w2 += abs(g2 - x["clf"]) <= 1
        print(f"  {x['image']:11s} {x['gt']:>2} {str(tuple(x['red_q'])):>16} "
              f"{x['sum_red']:>4} {x['sum_bright']:>4} | {g1:>2} {g2:>2} {x['clf']:>3} | "
              f"{str(a1):>5} {str(a2):>5}")
    print("  " + "-" * (len(hdr) - 2))

    print("\n" + "=" * 74)
    print("  AGREEMENT WITH CLASSIFIER  -  OLD vs RECALIBRATED")
    print("=" * 74)
    print(f"  exact grade match : {ex1}/{n} = {100*ex1/n:4.1f}%   ->   "
          f"{ex2}/{n} = {100*ex2/n:4.1f}%")
    print(f"  within +/- 1 grade: {w1}/{n} = {100*w1/n:4.1f}%   ->   "
          f"{w2}/{n} = {100*w2/n:4.1f}%")

    # rule-vs-GT too, for context (agreement target is the classifier, but GT is informative)
    gt1 = sum(rule_v1(x["red_q"], x["sum_bright"]) == x["gt"] for x in rows)
    gt2 = sum(rule_v2(x["red_q"], x["sum_bright"]) == x["gt"] for x in rows)
    print(f"\n  (for reference, rule vs GROUND TRUTH exact: "
          f"{gt1}/{n} = {100*gt1/n:.1f}%  ->  {gt2}/{n} = {100*gt2/n:.1f}%)")

    out = CSV.parent / "recalibrated_results.csv"
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["image", "gt_grade", "sum_red", "sum_bright", "red_per_quadrant",
                    "rule_v1", "rule_v2", "classifier_grade", "agree_v1", "agree_v2"])
        for x in rows:
            g1 = rule_v1(x["red_q"], x["sum_bright"])
            g2 = rule_v2(x["red_q"], x["sum_bright"])
            w.writerow([x["image"], x["gt"], x["sum_red"], x["sum_bright"],
                        "|".join(str(q) for q in x["red_q"]), g1, g2, x["clf"],
                        int(g1 == x["clf"]), int(g2 == x["clf"])])
    print(f"\n  per-image table -> {out}")
    print("\n  Proposed constants for Saad's rule_engine:")
    print(f"    RED_FLOOR        = {RED_FLOOR}     # 'lesions present' (both old '>0' sites)")
    print(f"    GRADE3_QUAD_MIN  = {GRADE3_QUAD_MIN}     # red lesions in every quadrant")
    print(f"    RULE_MAX_GRADE   = {RULE_MAX_GRADE}     # hard cap; grade 4 = classifier only")


if __name__ == "__main__":
    main()
