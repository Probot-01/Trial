

import glob
import json
import os
import sys

import cv2
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ML_ROOT)

SEG = os.path.join(ML_ROOT, "datasets", "idrid", "segmentation", "A. Segmentation")
CHASE = os.path.join(ML_ROOT, "datasets", "chasedb1")
MODELS = os.path.join(ML_ROOT, "models")

HALF = (np.array([0.5] * 3, np.float32), np.array([0.5] * 3, np.float32))
IMAGENET = (np.array([0.485, 0.456, 0.406], np.float32),
            np.array([0.229, 0.224, 0.225], np.float32))


def build(role, encoder, in_ch, classes):
    import segmentation_models_pytorch as smp
    from modelPaths import resolve
    ckpt = torch.load(resolve(role), map_location="cpu", weights_only=False)
    model = smp.Unet(encoder_name=encoder, encoder_weights=None,
                     in_channels=in_ch, classes=classes, activation=None)
    model.load_state_dict(ckpt["model_state_dict"], strict=True)
    model.eval()
    return model


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def infer(model, x):
    with torch.no_grad():
        return model(torch.from_numpy(x))[0, 0].numpy()


# ── M2 ─────────────────────────────────────────────────────────────────────
def verify_vessel():
    model = build("vessel", "resnet34", 1, 1)
    preds = sorted(glob.glob(os.path.join(MODELS, "**", "*_pred.png"), recursive=True))
    interps = {"linear": cv2.INTER_LINEAR, "area": cv2.INTER_AREA,
               "cubic": cv2.INTER_CUBIC, "nearest": cv2.INTER_NEAREST,
               "lanczos": cv2.INTER_LANCZOS4}

    print("M2 vessel -- against published CHASE prediction masks")
    best = None
    for name, flag in interps.items():
        agree, dice, n = [], [], 0
        for pred_path in preds:
            base = os.path.basename(pred_path).replace("_pred.png", "")
            src = os.path.join(CHASE, base + ".jpg")
            if not os.path.exists(src):
                continue
            published = cv2.imread(pred_path, cv2.IMREAD_GRAYSCALE) > 127
            bgr = cv2.imread(src, cv2.IMREAD_COLOR)

            green = bgr[:, :, 1]
            h, w = green.shape[:2]
            scale = 512 / max(h, w)
            nw, nh = int(round(w * scale)), int(round(h * scale))
            resized = cv2.resize(green, (nw, nh), interpolation=flag)
            padded = np.zeros((512, 512), resized.dtype)
            ox, oy = (512 - nw) // 2, (512 - nh) // 2
            padded[oy:oy + nh, ox:ox + nw] = resized

            x = ((padded.astype(np.float32) / 255.0) - 0.5) / 0.5
            mine = sigmoid(infer(model, x[None, None, ...])) > 0.5

            agree.append((mine == published).mean())
            inter = (mine & published).sum()
            dice.append(2 * inter / (mine.sum() + published.sum() + 1e-9))
            n += 1
        if not n:
            print("  no CHASE sources found"); return None
        row = (np.mean(agree), np.mean(dice), name, n)
        print(f"  {name:8s} exact {100*row[0]:8.3f}%   Dice {row[1]:.4f}   ({n} images)")
        best = row if best is None or row[0] > best[0] else best
    print(f"  -> best: {best[2]} at {100*best[0]:.3f}% exact")
    return best[2] == "linear" and best[0] >= 0.9999


# ── Lesion ground truth ────────────────────────────────────────────────────
def lesion_gt(img_id, subdirs):
    total = None
    for sub in subdirs:
        pattern = os.path.join(SEG, "2. All Segmentation Groundtruths", "**",
                               sub, img_id + "_*.tif")
        for path in glob.glob(pattern, recursive=True):
            g = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
            if g is None:
                continue
            total = (g > 0) if total is None else (total | (g > 0))
    return total


def lesion_dice(model, img_id, mean, std, subdirs):
    from preprocessing.ben_graham import ben_graham_preprocess, retinal_crop_box
    src = glob.glob(os.path.join(SEG, "1. Original Images", "**", img_id + ".jpg"),
                    recursive=True)
    gt = lesion_gt(img_id, subdirs)
    if not src or gt is None:
        return None
    bgr = cv2.imread(src[0], cv2.IMREAD_COLOR)
    rgb = cv2.cvtColor(ben_graham_preprocess(bgr, target_size=512), cv2.COLOR_BGR2RGB)
    x = (rgb.astype(np.float32) / 255.0 - mean) / std
    pred = sigmoid(infer(model, x.transpose(2, 0, 1)[None, ...])) > 0.5


    x0, y0, bw, bh = retinal_crop_box(bgr)
    g = cv2.resize(gt[y0:y0 + bh, x0:x0 + bw].astype(np.uint8), (512, 512),
                   interpolation=cv2.INTER_NEAREST) > 0
    return 2 * (pred & g).sum() / (pred.sum() + g.sum() + 1e-9)


# ── M5 ─────────────────────────────────────────────────────────────────────
def verify_red():
    meta_path = glob.glob(os.path.join(MODELS, "**", "red_lesion_metrics.json"),
                          recursive=True)
    if not meta_path:
        print("M5: red_lesion_metrics.json not found"); return None
    meta = json.load(open(meta_path[0], encoding="utf-8"))
    published = meta["per_image_val_dice_at_best"]
    model = build("red_lesion", "resnet34", 3, 1)

    print("M5 red lesion -- against per-image published val Dice")
    mine_all, diffs = [], []
    for img_id in meta["val_ids"]:
        d = lesion_dice(model, img_id, *HALF, ["1. Microaneurysms", "2. Haemorrhages"])
        if d is None:
            print(f"  {img_id}: source or GT missing"); continue
        pub = float(published[img_id]) if isinstance(published, dict) else None
        mine_all.append(d)
        if pub is not None:
            diffs.append(abs(d - pub))
            print(f"  {img_id:10s} ours {d:.4f}   published {pub:.4f}   d={abs(d-pub):.5f}")
    print(f"  -> mean ours {np.mean(mine_all):.4f} vs published "
          f"{meta['best_val_dice']:.4f}; max per-image diff {max(diffs):.5f}")
    return max(diffs) < 0.001


# ── M4 ─────────────────────────────────────────────────────────────────────
def verify_bright():
    model = build("hard_exudate", "resnet34", 3, 1)  # GATE 4: role was "bright_lesion"
    ids = sorted({os.path.splitext(os.path.basename(p))[0]
                  for p in glob.glob(os.path.join(SEG, "1. Original Images", "**", "*.jpg"),
                                     recursive=True)})
    subdirs = ["3. Hard Exudates", "4. Soft Exudates"]

    print("M4 bright lesion -- normalization only (val split not recorded)")
    scores = {}
    for name, (mean, std) in (("half (x-0.5)/0.5", HALF), ("imagenet", IMAGENET)):
        ds = [d for d in (lesion_dice(model, i, mean, std, subdirs) for i in ids)
              if d is not None]
        scores[name] = np.mean(ds)
        print(f"  {name:18s} Dice {np.mean(ds):.4f}  ({len(ds)} images)")
    ratio = scores["half (x-0.5)/0.5"] / scores["imagenet"]
    print(f"  -> half/imagenet = {ratio:.2f}x (Tanuj reported 1.48x on his split)")
    print("  NOTE: partial. The published Dice cannot be reproduced because the "
          "summary records\n        only split sizes (43/11), not which images.")
    return ratio > 1.2


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    runners = {"vessel": verify_vessel, "red": verify_red, "bright": verify_bright}
    results = {}
    for name, fn in runners.items():
        if which in ("all", name):
            results[name] = fn()
            print()
    bad = [k for k, v in results.items() if v is False]
    if bad:
        print("FAILED:", ", ".join(bad))
        return 1
    print("all requested checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
