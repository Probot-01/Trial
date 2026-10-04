

import json
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
INFERENCE_DIR = os.path.join(os.path.dirname(HERE), "inference")
sys.path.insert(0, INFERENCE_DIR)

from branchAInfer import assign_tier, ordinal_mode_interval_score  # noqa: E402

MODELS_DIR = os.path.join(os.path.dirname(HERE), "models")
CALIB_PATH = os.path.join(MODELS_DIR, "calibration_branchA_v2a.json")
GOLDEN_PATH = os.path.join(HERE, "conformal_golden_vectors.json")

EXPECTED_METHOD = "ordinal_mode_interval_stratified_v3"


def _load_calib():
    with open(CALIB_PATH, "r", encoding="utf-8") as f:
        calib = json.load(f)
    assert calib["method"] == EXPECTED_METHOD, (
        "models/calibration_branchA_v2a.json is not the expected method -- "
        "re-run calibrateBranchA.m / refitCalibration.m")
    calib["calibrated"] = True
    return calib


def _load_golden():
    with open(GOLDEN_PATH, "r", encoding="utf-8") as f:
        golden = json.load(f)
    assert golden["method"] == EXPECTED_METHOD
    return golden["cases"]


CALIB = _load_calib()
GOLDEN_CASES = _load_golden()


@pytest.mark.parametrize("case", GOLDEN_CASES, ids=lambda c: c["id"])
def test_golden_case_reproduced_exactly(case):
    probs = case["probs"]
    expected = case["expected"]

    tier, pred_set, _reason, low, high, contiguous = assign_tier(probs, CALIB)

    assert tier == expected["tier"], case["id"]
    assert pred_set == expected["predictionSet"], case["id"]
    assert low == expected["low"], case["id"]
    assert high == expected["high"], case["id"]
    assert len(pred_set) == expected["setSize"], case["id"]
    assert contiguous == expected["contiguous"], case["id"]

    _scores, mode = ordinal_mode_interval_score(probs)
    assert mode == expected["mode"], case["id"]

    p_referable = sum(probs[2:5])
    assert abs(p_referable - expected["pReferable"]) < 1e-9, case["id"]


def test_golden_vectors_cover_at_least_80_cases():
    assert len(GOLDEN_CASES) >= 80


def test_property_10000_random_simplex_points():
    
    rng = np.random.default_rng(0)
    n_trials = 10_000
    failures = []
    referable_threshold = float(CALIB["referableThreshold"])

    for i in range(n_trials):
        p = rng.dirichlet(np.ones(5))
        tier, pred_set, _reason, low, high, _contiguous = assign_tier(list(p), CALIB)

        expected_hull = list(range(low, high + 1))
        is_contig = (pred_set == expected_hull)

        _scores, mode = ordinal_mode_interval_score(list(p))
        contains_mode = (low <= mode <= high)

        p_referable = float(p[2] + p[3] + p[4])
        never_autoclear_above_threshold = not (tier == "A" and p_referable >= referable_threshold)

        if not (is_contig and contains_mode and never_autoclear_above_threshold):
            failures.append((i, p.tolist(), tier, pred_set, mode, p_referable))

    assert not failures, f"{len(failures)}/{n_trials} property failures, e.g. {failures[:5]}"


SYNTHETIC_DEMOTION_CALIB = {
    "method": "ordinal_mode_interval_stratified_v3",
    "stratumOf": [0, 0, 1, 1, 1],
    "qhatPerStratum": [1.0, 0.3],
    "referableThreshold": 0.2,
    "referableTargetSensitivity": 0.05,
    "referableFrom": 2,
    "calibrated": True,
}


def test_referable_threshold_demotion_fires():
   
    probs = [0.65, 0.10, 0.15, 0.05, 0.05]
    tier, pred_set, reason, low, high, _contig = assign_tier(probs, SYNTHETIC_DEMOTION_CALIB)
    assert tier == "B"
    assert "auto-clear withheld" in reason


def test_referable_threshold_demotion_does_not_fire_below_threshold():
    # Same Tier-A-eligible structure, but pRef=0.05 < 0.2 -> stays Tier A.
    probs = [0.65, 0.30, 0.03, 0.01, 0.01]
    tier, pred_set, _reason, low, high, _contig = assign_tier(probs, SYNTHETIC_DEMOTION_CALIB)
    assert tier == "A"
