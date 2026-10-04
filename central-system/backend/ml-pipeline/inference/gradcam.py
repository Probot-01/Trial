

import cv2
import numpy as np


TARGET_LAYER = "backbone.bn2.act"


def _resolve(model, dotted):
    mod = model
    for part in dotted.split("."):
        mod = getattr(mod, part)
    return mod


def compute_gradcam(model, input_tensor, class_index=None, target_layer=TARGET_LAYER):
   
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
      
        out.register_hook(lambda g: gradients.setdefault("value", g))

    handle = layer.register_forward_hook(fwd_hook)
    try:
        model.zero_grad(set_to_none=True)
        logits = model(input_tensor)

        if class_index is None:
            class_index = int(logits.argmax(dim=1).item())

      
        score = logits[0, class_index]
        score.backward()

        acts = activations["value"].detach()[0]      # C x H x W
        grads = gradients["value"].detach()[0]       # C x H x W
    finally:
        handle.remove()

  
    weights = grads.mean(dim=(1, 2))                 # C

    cam = (weights[:, None, None] * acts).sum(dim=0)

    cam = torch.relu(cam).cpu().numpy().astype(np.float32)

    peak = cam.max()
    if peak > 0:
        cam = cam / peak


    return cam, class_index, logits.detach().cpu().numpy()[0]


def retinal_mask(bgr_image, threshold=7):
  
    green = bgr_image[:, :, 1]
    mask = green > threshold
    mask = cv2.morphologyEx(mask.astype(np.uint8),
                            cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    return mask.astype(bool)


def save_overlay(cam, display_bgr, out_path, alpha=0.4, apply_roi_mask=True):
  
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
