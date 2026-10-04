

import argparse
import json
import os
import sys

import cv2
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ML_ROOT, "inference"))
sys.path.insert(0, ML_ROOT)

MODEL1 = os.path.join(ML_ROOT, "models", "Model1")
CAM_SIZE = 384          # Branch A's input size, and the CAM's upsample target
SEG_SIZE = 512          # the lesion models' input size


def lesion_mask_384(bgr):
    
    import segInfer as S
    rgb512, _box = S._crop512(bgr)
    red = S._lesion_prob("red_lesion", rgb512) > 0.5
    bright = S._lesion_prob("hard_exudate", rgb512) > 0.5  # GATE 4: role was "bright_lesion"
    from gradcam import retinal_mask
    roi512 = retinal_mask(cv2.cvtColor(rgb512, cv2.COLOR_RGB2BGR))
    union = (red | bright) & roi512
    m = cv2.resize(union.astype(np.uint8), (CAM_SIZE, CAM_SIZE),
                   interpolation=cv2.INTER_NEAREST).astype(bool)
    r = cv2.resize(roi512.astype(np.uint8), (CAM_SIZE, CAM_SIZE),
                   interpolation=cv2.INTER_NEAREST).astype(bool)
    return m, r


def attention_consistency(cam384, lesion, roi):
    """Attention energy inside lesions, against its chance level."""
    cam = np.clip(cam384, 0, None).astype(np.float64)
    cam = cam * roi
    total = cam.sum()
    if total <= 0:
        return None
    inside = float(cam[lesion & roi].sum())
    score = inside / total
    roi_px = int(roi.sum())
    chance = float((lesion & roi).sum()) / roi_px if roi_px else float("nan")
    # Enrichment is the number that means anything. score alone scales with how
    # much of the retina is lesion, so a diseased eye scores high for free.
    enrichment = (score / chance) if chance > 0 else float("nan")
    return {"score": float(score), "chanceLevel": chance,
            "enrichment": float(enrichment),
            "lesionFractionOfRoi": chance}


def occlude(bgr, lesion_mask_orig, dilate=4):
    """Inpaint the lesions out of the ORIGINAL image."""
    m = lesion_mask_orig.astype(np.uint8)
    if dilate > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate * 2 + 1,) * 2)
        m = cv2.dilate(m, k)
    return cv2.inpaint(bgr, m, 3, cv2.INPAINT_TELEA)


def _drop_stats(drops, expect):
    """Summarise one arm of the occlusion test against its EXPECTED direction.

    expect='fall' means confidence should drop when the evidence is removed;
    expect='rise' means it should increase. Reporting "correctDirection"
    against the expectation is the only way these two arms can be compared --
    a raw count of "confidence fell" scores the healthy arm as a failure for
    behaving exactly as it should.
    """
    if not drops:
        return {"n": 0}
    arr = np.array(drops, float)
    correct = arr > 0 if expect == "fall" else arr < 0
    return {
        "n": int(len(arr)),
        "expectedDirection": expect,
        "medianDrop": float(np.median(arr)),
        "meanDrop": float(arr.mean()),
        "correctDirection": int(correct.sum()),
        "correctFraction": float(correct.mean()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=12)
    ap.add_argument("--out", default=os.path.join(HERE, "explainability_results.json"))
    args = ap.parse_args()

    sys.argv = [sys.argv[0]]
    import branchAInfer as B
    from gradcam import compute_gradcam
    import segInfer as S
    from domainGap import resolve_idrid

    model, ckpt = B.load_model()
    calib = B.load_calibration()
    T = float(calib.get("temperature", 1.0))

    ids = np.load(os.path.join(MODEL1, "branchA_v1_test_ids.npy"), allow_pickle=True)
    labels = np.load(os.path.join(MODEL1, "branchA_v1_test_labels.npy"), allow_pickle=True)
    cases = []
    for s, y in zip(ids, labels):
        s = str(s)
        if not s.startswith("idrid"):
            continue
        p = resolve_idrid(s)
        if p:
            cases.append((p, int(y)))
    cases = cases[:args.n]
    print(f"cases: {len(cases)}")

    def grade_of(bgr):
        proc = __import__("preprocessing.ben_graham", fromlist=["x"]).ben_graham_preprocess(
            bgr, target_size=ckpt["img_size"])
        if ckpt["channel_order"] == "RGB":
            proc = cv2.cvtColor(proc, cv2.COLOR_BGR2RGB)
        x = proc.astype(np.float32) / 255.0
        x = (x - np.array(ckpt["normalize_mean"], np.float32)) \
            / np.array(ckpt["normalize_std"], np.float32)
        return x.transpose(2, 0, 1)[None, ...]

    rows = []
    for path, y in cases:
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        x = grade_of(bgr)
        with torch.no_grad():
            logits = model(torch.from_numpy(x)).numpy()[0]
        p = B.softmax(logits / T)
        grade = int(p.argmax())
        conf = float(p[grade])

        cam, _cls, _lg = compute_gradcam(model, torch.from_numpy(x), class_index=grade)
        cam384 = cv2.resize(cam, (CAM_SIZE, CAM_SIZE), interpolation=cv2.INTER_LINEAR)

        lesion, roi = lesion_mask_384(bgr)
        cons = attention_consistency(cam384, lesion, roi)

        # Counterfactual: remove the lesions from the ORIGINAL image, re-run the
        # whole chain, and read the confidence in the SAME class as before.
        from preprocessing.ben_graham import retinal_crop_box
        x0, y0, bw, bh = retinal_crop_box(bgr)
        les_crop = cv2.resize(lesion.astype(np.uint8), (bw, bh),
                              interpolation=cv2.INTER_NEAREST)
        les_orig = np.zeros(bgr.shape[:2], np.uint8)
        les_orig[y0:y0 + bh, x0:x0 + bw] = les_crop

        occ_conf = None
        if les_orig.any():
            xo = grade_of(occlude(bgr, les_orig))
            with torch.no_grad():
                lo = model(torch.from_numpy(xo)).numpy()[0]
            occ_conf = float(B.softmax(lo / T)[grade])

        rows.append({
            "image": os.path.basename(path), "trueGrade": y, "predGrade": grade,
            "confidence": conf, "consistency": cons,
            "occludedConfidence": occ_conf,
            "confidenceDrop": (conf - occ_conf) if occ_conf is not None else None,
            "lesionPixels": int(lesion.sum()),
        })
        c = cons or {}
        print(f"{os.path.basename(path):14s} true{y} pred{grade} conf {conf:.3f} "
              f"| attn {c.get('score', float('nan')):.3f} chance "
              f"{c.get('chanceLevel', float('nan')):.3f} enrich "
              f"{c.get('enrichment', float('nan')):.2f} "
              f"| occluded {('%.3f' % occ_conf) if occ_conf is not None else '  -  '} "
              f"drop {(conf - occ_conf) if occ_conf is not None else float('nan'):+.3f}")

    valid = [r for r in rows if r["consistency"]]
    enr = [r["consistency"]["enrichment"] for r in valid]
    drops = [r["confidenceDrop"] for r in rows if r["confidenceDrop"] is not None]

    summary = {
        "n": len(rows),
        "attentionEnrichment": {
            "median": float(np.median(enr)), "mean": float(np.mean(enr)),
            "min": float(np.min(enr)), "max": float(np.max(enr)),
            "aboveChance": int(sum(e > 1.0 for e in enr)),
        },
      
        "occlusionByPrediction": {
            "referable": _drop_stats(
                [r["confidenceDrop"] for r in rows
                 if r["confidenceDrop"] is not None and r["predGrade"] >= 2],
                expect="fall"),
            "nonReferable": _drop_stats(
                [r["confidenceDrop"] for r in rows
                 if r["confidenceDrop"] is not None and r["predGrade"] < 2],
                expect="rise"),
        },
        "occlusionConfidenceDropPooled": {
            "median": float(np.median(drops)), "mean": float(np.mean(drops)),
            "note": ("pooled across both arms and therefore NOT interpretable "
                     "on its own -- see occlusionByPrediction"),
        },
        "reviewTimeSeconds": None,
        "reviewTimeN": 0,
        "reviewTimeNote": (
            "NOT MEASURED. PS requirement 4's <30 s bar needs a real timer on "
            "the review screen populating review_duration_seconds. n = 0 -- no "
            "median can be reported and none is invented."),
        "clinicianPlausibilityNote": (
            "NOT DONE. 'Grad-CAM rated as clinically useful' is a human "
            "judgement and cannot be self-assessed."),
    }
    print("\n--- summary ---")
    print(json.dumps(summary, indent=2))
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"summary": summary, "cases": rows}, fh, indent=2)
    print(f"written to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
