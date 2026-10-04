
import json
import os
import sys

import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "inference"))

import segInfer  # noqa: E402


def gaussian_heatmap(size=64, cx=32, cy=32, sigma=5.0, peak=0.9):
    yy, xx = np.mgrid[0:size, 0:size]
    hm = peak * np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2)))
    return hm.astype(np.float32)


def test_flat_heatmap_is_unreliable():
    """No peak at all (uniform heatmap) -> True."""
    flat = np.full((64, 64), 0.05, dtype=np.float32)
    assert segInfer.fovea_unreliable(flat) is True


def test_low_flat_heatmap_below_threshold_is_unreliable():
    """A heatmap whose max sits below FOVEA_PEAK_THRESHOLD -> True."""
    hm = np.full((64, 64), segInfer.FOVEA_PEAK_THRESHOLD - 0.01, dtype=np.float32)
    assert segInfer.fovea_unreliable(hm) is True


def test_clear_gaussian_peak_is_reliable():
    """A clear, well-above-threshold Gaussian peak -> False."""
    hm = gaussian_heatmap(peak=0.9)
    assert segInfer.fovea_unreliable(hm) is False


def test_peak_just_above_threshold_is_reliable():
    hm = gaussian_heatmap(peak=segInfer.FOVEA_PEAK_THRESHOLD + 0.05)
    assert segInfer.fovea_unreliable(hm) is False


def test_peak_just_below_threshold_is_unreliable():
    hm = gaussian_heatmap(peak=segInfer.FOVEA_PEAK_THRESHOLD - 0.05)
    assert segInfer.fovea_unreliable(hm) is True


def test_none_heatmap_is_unreliable():
    """Missing heatmap -> True, never a silent False."""
    assert segInfer.fovea_unreliable(None) is True


def test_empty_heatmap_is_unreliable():
    assert segInfer.fovea_unreliable(np.array([])) is True


def test_nan_heatmap_is_unreliable():
    """NaN heatmap (e.g. a corrupt forward pass) -> True, never a silent False."""
    hm = np.full((64, 64), np.nan, dtype=np.float32)
    assert segInfer.fovea_unreliable(hm) is True


def test_partial_nan_with_high_peak_elsewhere_is_still_reliable():

    hm = gaussian_heatmap(peak=0.9)
    hm[0, 0] = np.nan
  
    assert segInfer.fovea_unreliable(hm) is True


def test_inf_heatmap_is_unreliable():
    hm = np.full((64, 64), np.inf, dtype=np.float32)
    assert segInfer.fovea_unreliable(hm) is True


def test_result_type_is_exactly_bool():
    hm_reliable = gaussian_heatmap(peak=0.9)
    hm_unreliable = np.full((64, 64), 0.01, dtype=np.float32)
    for hm in (hm_reliable, hm_unreliable, None, np.full((64, 64), np.nan)):
        result = segInfer.fovea_unreliable(hm)
        assert type(result) is bool, f"expected exactly bool, got {type(result)}"


def test_json_dumps_emits_lowercase_true_false():
   
    payload_true = {"foveaUnreliable": segInfer.fovea_unreliable(None)}
    payload_false = {"foveaUnreliable": segInfer.fovea_unreliable(gaussian_heatmap(peak=0.9))}
    assert json.dumps(payload_true) == '{"foveaUnreliable": true}'
    assert json.dumps(payload_false) == '{"foveaUnreliable": false}'


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-v"]))
