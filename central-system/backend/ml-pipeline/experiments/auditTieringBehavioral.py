
import json
import os
import subprocess
import sys

ML_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ML_ROOT)
sys.path.insert(0, os.path.join(ML_ROOT, "inference"))
import branchAInfer as bai  # noqa: E402

GRADING_ORCH = os.path.abspath(os.path.join(
    ML_ROOT, "..", "services", "gradingOrchestrator.js"))


def _run_node(script):
    out = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
    return out.stdout.strip()


def real_js_assign_tier(confidence, branch_agreement):
    """Calls the REAL, exported gradingOrchestrator.js assignTier()."""
    ba = "null" if branch_agreement is None else ("true" if branch_agreement else "false")
    script = (
        f"const {{ assignTier }} = require({json.dumps(GRADING_ORCH)});"
        f"console.log(assignTier({confidence}, {ba}));"
    )
    return _run_node(script)


def real_js_is_capture_ungradable(quality_scores):
    """Calls the REAL, exported gradingOrchestrator.js isCaptureUngradable()."""
    qs = "null" if quality_scores is None else json.dumps(quality_scores)
    script = (
        f"const {{ isCaptureUngradable }} = require({json.dumps(GRADING_ORCH)});"
        f"console.log(JSON.stringify(isCaptureUngradable({qs})));"
    )
    return json.loads(_run_node(script))


def decide_tier_669_692(branch_agreement, beyond_rule_engine, quality_forced,
                         camera_mismatch, camera_site_probation_cleared,
                         conformal_tier, conformal_reason, confidence_score):
    """Verbatim port of gradingOrchestrator.js's post-override tier chain
    (currently lines 669-692 of processCase(), preceded by the one-line
    cameraProbationOverride combinator a few lines above it). Reproduced, not
    re-derived, because that logic is not factored into a callable function
    in the real code -- see item 1 of the original audit. Ordering matches
    the real file exactly, including WHY: the three exact-'C' checks
    (disagreement, beyond-rule-engine, quality-forced) all come before the
    one floor-only-to-'B' check (camera probation), so the floor can never
    pre-empt a case that also deserves a hard C."""
    camera_probation_override = camera_mismatch and not camera_site_probation_cleared

    if branch_agreement is False:
        return 'C', 'branches disagree'
    if beyond_rule_engine:
        return 'C', "CNN grade is above the rule engine's ceiling; no second opinion is possible"
    if quality_forced:
        return 'C', ('capture quality is below the local retake threshold -- no shortcut on an '
                     'image the quality gate itself would have rejected')
    if camera_probation_override:
        return 'B', ('camera family mismatch on a camera/site with too few prior graded cases -- '
                     'not yet enough of a track record to auto-clear')
    if conformal_tier:
        return conformal_tier, conformal_reason or 'conformal prediction set'
    return real_js_assign_tier(confidence_score, branch_agreement), 'uncalibrated fallback thresholds'


def conformal(probs):
    calib = bai.load_calibration()
    tier, pred_set, reason = bai.assign_tier(probs, calib)
    conf = probs[max(range(5), key=lambda g: probs[g])]
    return tier, pred_set, reason, conf


# A clean quality_scores object -- every sub-score comfortably clear of
# gradingOrchestrator.js's QUALITY_RETAKE_THRESHOLDS (mirrors
# qualityGateMain.m's own hard-failure branches).
CLEAN_QUALITY = dict(focusScore=0.8, illuminationScore=0.8, coveragePercent=0.95,
                     glareScore=0.05, motionScore=0.05, occlusionScore=0.02)
# Fails on coveragePercent alone (< 0.5, qualityGateMain.m's own FOV-failure
# threshold, checked first there because a badly-framed image makes every
# other metric unreliable) -- one clean trigger rather than several, so a
# failure here points at a specific threshold, not "something in the object".
UNGRADABLE_QUALITY = dict(focusScore=0.8, illuminationScore=0.8, coveragePercent=0.3,
                          glareScore=0.05, motionScore=0.05, occlusionScore=0.02)

SCENARIOS = []

# (a) high confidence, branches agree, known site, clean capture -> expect A
probs_a = [0.98, 0.005, 0.005, 0.005, 0.005]
t, s, r, c = conformal(probs_a)
SCENARIOS.append(dict(
    name="(a) confident, agree, known site, clean capture",
    expect="A",
    branch_agreement=True, beyond_rule_engine=False,
    conformal_tier=t, conformal_reason=r, confidence=c,
    note=f"conformal set={s}",
    camera_mismatch=False, camera_site_probation_cleared=True,
    quality_scores=CLEAN_QUALITY,
))

# (b) same as (a) but branches disagree -> expect C
SCENARIOS.append(dict(
    name="(b) same as (a) but branches DISAGREE",
    expect="C",
    branch_agreement=False, beyond_rule_engine=False,
    conformal_tier=t, conformal_reason=r, confidence=c,
    note=f"conformal set={s} (irrelevant -- disagreement short-circuits)",
    camera_mismatch=False, camera_site_probation_cleared=True,
    quality_scores=CLEAN_QUALITY,
))

# (c) same as (a) but from a brand-new, not-yet-probated camera -> expect B
# (mismatch detected AND probation not cleared -- the real override is a
# conjunction of both signals, per the request that added it; a mismatch
# alone on an established camera, or a new-but-consistent camera, still
# doesn't trigger it, unchanged from before).
SCENARIOS.append(dict(
    name="(c) same as (a) but NEW, NOT-YET-PROBATED CAMERA (+ mismatch)",
    expect="B",
    branch_agreement=True, beyond_rule_engine=False,
    conformal_tier=t, conformal_reason=r, confidence=c,
    note="cameraProbationOverride = mismatch && !cleared -- now wired into "
         "the chain ahead of the conformal tier",
    camera_mismatch=True, camera_site_probation_cleared=False,
    quality_scores=CLEAN_QUALITY,
))

# (d) same as (a) but capture flagged ungradable -> expect C
# quality_forced now comes from the REAL isCaptureUngradable(), not an
# assumed flag -- see real_js_is_capture_ungradable() above.
SCENARIOS.append(dict(
    name="(d) same as (a) but CAPTURE FLAGGED UNGRADABLE",
    expect="C",
    branch_agreement=True, beyond_rule_engine=False,
    conformal_tier=t, conformal_reason=r, confidence=c,
    note="isCaptureUngradable() now wired into the chain ahead of the "
         "conformal tier (and ahead of the camera-probation floor, so a hard "
         "C here can never be downgraded to B)",
    camera_mismatch=False, camera_site_probation_cleared=True,
    quality_scores=UNGRADABLE_QUALITY,
))

# (e) CNN predicts grade 4, branches agree, otherwise clean -> expect C
probs_e = [0.005, 0.005, 0.005, 0.005, 0.98]
t2, s2, r2, c2 = conformal(probs_e)
SCENARIOS.append(dict(
    name="(e) CNN predicts grade 4, branches agree, otherwise clean",
    expect="C",
    branch_agreement=True, beyond_rule_engine=True,  # grade(4) > ruleMaxGrade(3)
    conformal_tier=t2, conformal_reason=r2, confidence=c2,
    note=f"conformal set={s2} alone would give tier={t2} ({r2}); "
         f"beyondRuleEngine override must fire to reach C",
    camera_mismatch=False, camera_site_probation_cleared=True,
    quality_scores=CLEAN_QUALITY,
))


def main():
    print(f"{'scenario':55s} {'expect':8s} {'actual':8s} {'match?':7s}")
    print("-" * 90)
    mismatches = []
    for sc in SCENARIOS:
        quality_forced = real_js_is_capture_ungradable(sc["quality_scores"])
        tier, reason = decide_tier_669_692(
            sc["branch_agreement"], sc["beyond_rule_engine"], quality_forced,
            sc["camera_mismatch"], sc["camera_site_probation_cleared"],
            sc["conformal_tier"], sc["conformal_reason"], sc["confidence"])
        expect = sc["expect"]
        ok = tier == expect
        flag = "OK" if ok else "MISMATCH"
        if not ok:
            mismatches.append(sc["name"])
        print(f"{sc['name']:55s} {expect:8s} {tier:8s} {flag:7s}")
        print(f"    reason:         {reason}")
        print(f"    quality_forced: {quality_forced}")
        print(f"    note:           {sc['note']}")
        print()

    print("=" * 60)
    if mismatches:
        print(f"{len(mismatches)} scenario(s) did not match the expected/designed behavior:")
        for m in mismatches:
            print(f"  - {m}")
    else:
        print("All scenarios matched expectations.")


if __name__ == "__main__":
    main()
