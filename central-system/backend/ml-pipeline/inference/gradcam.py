"""
gradcam.py
==========
Grad-CAM for Branch A, against the model that actually made the decision.

    from gradcam import compute_gradcam, save_overlay

── WHY THIS EXISTS IN PYTHON ───────────────────────────────────────────────
There is a MATLAB gradCam.m, and it can only load the untrained stub. Once
Branch A moved to Python, a heatmap produced there would have been explaining
a DIFFERENT network than the one that produced the grade — an explanation
confidently unrelated to its prediction, which is worse than no explanation.
So gradcam_path was set to null, and this closes that gap properly.

── THE TARGET LAYER, AND ITS HONEST RESOLUTION ─────────────────────────────
Hooked at `backbone.bn2.act` — the activation after the final convolution,
the last point where spatial position still exists. After it comes global
pooling, which discards location entirely, so nothing later can be localised.

For a 384x384 input that feature map is 12x12. EACH CELL THEREFORE COVERS
32x32 PIXELS. Upsampling to 384 makes a smooth picture but invents no detail:
the heatmap genuinely cannot resolve anything smaller than a 32-pixel block.

That matters clinically. A microaneurysm is a handful of pixels across, so
Grad-CAM can indicate the REGION the model weighted and can never point at an
individual lesion. Design doc §6.9 says the same thing, and it is the reason
the lesion-attention consistency score (Task 7.1) exists as a separate check
rather than the heatmap being trusted on its own.

── THE ROI SAFEGUARD ───────────────────────────────────────────────────────
Design doc §6.9 requires heatmap energy outside the retinal circle to be
discounted. A CNN will happily key on the black surround or the vignette edge
— artefacts of the camera, not the eye — and such a heatmap looks confident
and means nothing. Attention outside the retina is zeroed here, and how much
was removed is reported, because a case where most of the attention was
outside the eye is itself a finding.
"""

import cv2
import numpy as np

# The activation after the last conv. Not conv_head itself: Grad-CAM
# conventionally uses the activated feature map, and the SiLU here is what the
# rest of the network actually consumes.
TARGET_LAYER = "backbone.bn2.act"


def _resolve(model, dotted):
    mod = model
    for part in dotted.split("."):
        mod = getattr(mod, part)
    return mod


def compute_gradcam(model, input_tensor, class_index=None, target_layer=TARGET_LAYER):
    """Grad-CAM for one image.

    Returns (cam, class_index, logits) with cam float32 in [0,1] at the feature
    map's own resolution — deliberately NOT upsampled here, so the caller can
    see how coarse it really is.

    Gradients are required, so this cannot run under torch.no_grad(). The model
    still must be in eval() mode: drop_rate is 0.3, and a dropout mask sampled
    during the backward pass would make the explanation different every time it
    was computed for the same image.
    """
    import torch   # lazy: save_overlay()/retinal_mask() below never need torch,
                   # and importing it merely to IMPORT this module (not call this
                   # function) used to cost ~350MB -- see branchAInfer.py's
                   # BRANCH_A_INFERENCE_ENGINE=onnx path, which imports
                   # save_overlay alone and must not pull torch in to do it.
    if model.training:
        raise RuntimeError(
            "model must be in eval() mode: dropout would randomise the explanation")

    activations = {}
    gradients = {}

    layer = _resolve(model, target_layer)

    def fwd_hook(_m, _i, out):
        activations["value"] = out
        # Grab the gradient flowing back through this exact tensor. A module
        # backward hook would give the gradient w.r.t. the module's inputs,
        # which is a different quantity and a classic way to get a Grad-CAM
        # that looks plausible and is wrong.
        out.register_hook(lambda g: gradients.setdefault("value", g))

    handle = layer.register_forward_hook(fwd_hook)
    try:
        model.zero_grad(set_to_none=True)
        logits = model(input_tensor)

        if class_index is None:
            class_index = int(logits.argmax(dim=1).item())

        # Backward on the raw LOGIT, not the softmax probability. Through a
        # softmax the gradient of the top class is damped by exactly how
        # confident the model already is, so a very confident prediction would
        # produce a near-zero, all-noise map.
        score = logits[0, class_index]
        score.backward()

        acts = activations["value"].detach()[0]      # C x H x W
        grads = gradients["value"].detach()[0]       # C x H x W
    finally:
        handle.remove()

    # Channel weights = spatially averaged gradient: how much this feature map
    # as a whole pushed the score for the target class.
    weights = grads.mean(dim=(1, 2))                 # C

    cam = (weights[:, None, None] * acts).sum(dim=0)

    # ReLU because only evidence FOR the class is wanted. Negative values are
    # regions that argued against it, and leaving them in produces a map that
    # highlights contradictory evidence as though it were supporting.
    cam = torch.relu(cam).cpu().numpy().astype(np.float32)

    peak = cam.max()
    if peak > 0:
        cam = cam / peak
    # A flat all-zero CAM is left as zeros rather than divided into NaNs, and
    # the caller can see it is empty. It means no positive evidence survived
    # the ReLU, which is worth noticing rather than papering over.

    return cam, class_index, logits.detach().cpu().numpy()[0]


def retinal_mask(bgr_image, threshold=7):
    """The retinal circle, by the same rule ben_graham uses to crop.

    Same threshold as the training preprocessing on purpose: a different
    definition of "inside the retina" here would discount energy the model was
    legitimately given.
    """
    green = bgr_image[:, :, 1]
    mask = green > threshold
    mask = cv2.morphologyEx(mask.astype(np.uint8),
                            cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    return mask.astype(bool)


def save_overlay(cam, display_bgr, out_path, alpha=0.4, apply_roi_mask=True):
    """Blend the CAM over a fundus image and write a PNG.

    Returns a dict describing what was drawn, including how much attention the
    ROI safeguard removed.

    display_bgr is the cropped-and-resized fundus WITHOUT ben_graham's contrast
    step. The geometry is identical to the model's input — that step is
    pixel-wise and moves nothing — so the heatmap aligns exactly, while the
    clinician sees a recognisable retina instead of a contrast-boosted one.
    """
    h, w = display_bgr.shape[:2]

    # Bilinear upsampling from 12x12. This smooths; it does not add detail.
    cam_full = cv2.resize(cam, (w, h), interpolation=cv2.INTER_LINEAR)

    info = {"energyTotal": float(cam_full.sum())}

    if apply_roi_mask:
        mask = retinal_mask(display_bgr)
        inside = float(cam_full[mask].sum())
        total = float(cam_full.sum())
        info["energyInsideRetina"] = inside
        info["fractionInsideRetina"] = (inside / total) if total > 0 else None
        cam_full = cam_full * mask
        # A model attending mostly outside the eye is a finding, not a detail.
        info["mostlyOutsideRetina"] = bool(
            total > 0 and (inside / total) < 0.5)

    peak = cam_full.max()
    if peak > 0:
        cam_full = cam_full / peak

    heat = cv2.applyColorMap(np.uint8(255 * cam_full), cv2.COLORMAP_JET)
    overlay = cv2.addWeighted(heat, alpha, display_bgr, 1 - alpha, 0)

    os_dir = __import__("os").path.dirname(out_path)
    if os_dir:
        __import__("os").makedirs(os_dir, exist_ok=True)
    if not cv2.imwrite(out_path, overlay):
        raise RuntimeError(f"could not write overlay to {out_path}")

    info["path"] = out_path
    info["camResolution"] = list(cam.shape)
    info["overlayResolution"] = [h, w]
    return info
