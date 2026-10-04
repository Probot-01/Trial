
import csv
import os
import sys

import cv2
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

LOC = os.path.join(ML_ROOT, "datasets", "idrid", "localization", "C. Localization")
PRED_CSV = os.path.join(ML_ROOT, "models", "Model3", "localization_test_predictions.csv")

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], np.float32)
INPUT_SIZE = 512


def _read_gt(path):
    out = {}
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.reader(fh):
            if row and row[0].startswith("IDRiD"):
                out[row[0]] = (float(row[1]), float(row[2]))
    return out


def resolve_images(rows):
    """Map each image_id to the actual file, using GT agreement to break the
    Training/Testing filename collision. Returns (resolved, unresolved)."""
    gtdir = os.path.join(LOC, "2. Groundtruths", "1. Optic Disc Center Location")
    imdir = os.path.join(LOC, "1. Original Images")
    folders = {
        "train": (os.path.join(imdir, "a. Training Set"),
                  _read_gt(os.path.join(gtdir, "a. IDRiD_OD_Center_Training Set_Markups.csv"))),
        "test": (os.path.join(imdir, "b. Testing Set"),
                 _read_gt(os.path.join(gtdir, "b. IDRiD_OD_Center_Testing Set_Markups.csv"))),
    }
    resolved, unresolved = {}, []
    for row in rows:
        img_id = row["image_id"]
        tx, ty = float(row["od_true_x"]), float(row["od_true_y"])
        hits = []
        for split, (folder, gt) in folders.items():
            path = os.path.join(folder, img_id + ".jpg")
            if not os.path.exists(path) or img_id not in gt:
                continue
            img = cv2.imread(path, cv2.IMREAD_COLOR)
            if img is None:
                continue
            h, w = img.shape[:2]
            gx, gy = gt[img_id]

            if abs(gx * INPUT_SIZE / w - tx) < 0.01 and abs(gy * INPUT_SIZE / h - ty) < 0.01:
                hits.append((split, path))
        if len(hits) == 1:
            resolved[img_id] = hits[0]
        else:
            unresolved.append((img_id, len(hits)))
    return resolved, unresolved


def preprocess(bgr, interpolation=cv2.INTER_AREA):
    """The proven recipe. See the module docstring on why INTER_AREA."""
    resized = cv2.resize(bgr, (INPUT_SIZE, INPUT_SIZE), interpolation=interpolation)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    x = (rgb.astype(np.float32) / 255.0 - IMAGENET_MEAN) / IMAGENET_STD
    return torch.from_numpy(x.transpose(2, 0, 1)[None, ...])


def load_model():
    import segmentation_models_pytorch as smp
    from modelPaths import resolve
    ckpt = torch.load(resolve("localization"), map_location="cpu", weights_only=False)
    model = smp.Unet(encoder_name="resnet18", encoder_weights=None,
                     in_channels=3, classes=2, activation=None)
    model.load_state_dict(ckpt["model_state_dict"], strict=True)
    model.eval()
    return model


def peaks(heatmaps):
    """argmax per channel -> [(x, y), ...] in 512-space."""
    pts = []
    for c in range(heatmaps.shape[0]):
        iy, ix = np.unravel_index(heatmaps[c].argmax(), heatmaps[c].shape)
        pts.append((float(ix), float(iy)))
    return pts


def main():
    if not os.path.exists(PRED_CSV):
        print(f"missing {PRED_CSV}", file=sys.stderr)
        return 2
    with open(PRED_CSV, newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))

    resolved, unresolved = resolve_images(rows)
    print(f"resolved {len(resolved)}/{len(rows)} images "
          f"({sum(1 for s, _ in resolved.values() if s == 'train')} train, "
          f"{sum(1 for s, _ in resolved.values() if s == 'test')} test)")
    if unresolved:
        print(f"UNRESOLVED (id, candidate count): {unresolved}")

    model = load_model()

    exact = 0
    d_his, d_gt_mine, d_gt_his = [], [], []
    for row in rows:
        img_id = row["image_id"]
        if img_id not in resolved:
            continue
        bgr = cv2.imread(resolved[img_id][1], cv2.IMREAD_COLOR)
        with torch.no_grad():
            hm = model(preprocess(bgr))[0].numpy()
        (ox, oy), (fx, fy) = peaks(hm)

        hox, hoy = float(row["od_pred_x"]), float(row["od_pred_y"])
        hfx, hfy = float(row["fovea_pred_x"]), float(row["fovea_pred_y"])
        gox, goy = float(row["od_true_x"]), float(row["od_true_y"])

        exact += (ox == hox and oy == hoy and fx == hfx and fy == hfy)
        d_his.append(np.hypot(ox - hox, oy - hoy))
        d_gt_mine.append(np.hypot(ox - gox, oy - goy))
        d_gt_his.append(np.hypot(hox - gox, hoy - goy))

    n = len(d_his)
    pct = 100.0 * exact / n
    print(f"\nexact reproduction (OD and fovea both): {exact}/{n} ({pct:.1f}%)")
    print(f"ours vs published : OD mean {np.mean(d_his):.2f} px, median "
          f"{np.median(d_his):.1f} px (512-space)")
    print(f"ours vs GT        : OD mean {np.mean(d_gt_mine):.2f} px")
    print(f"published vs GT   : OD mean {np.mean(d_gt_his):.2f} px")


    ok = pct >= 95.0
    print("\nVERDICT:", "recipe REPRODUCES the model" if ok
          else "recipe does NOT reproduce the model -- do not ship it")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
