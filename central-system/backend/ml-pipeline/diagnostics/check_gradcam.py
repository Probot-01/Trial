
import sys
from pathlib import Path

import numpy as np
import cv2
import torch
import torch.nn as nn

PIPE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PIPE))
from preprocessing.ben_graham import ben_graham_preprocess  # noqa: E402

OUT = Path(__file__).resolve().parent / "out"
OUT.mkdir(exist_ok=True)

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], np.float32)


def find_ckpt(name, *subdirs):
    for c in [PIPE / "models" / name] + [PIPE / "models" / s / name for s in subdirs]:
        if c.is_file():
            return c
    hits = sorted((PIPE / "models").rglob(name))
    if hits:
        return hits[0]
    raise FileNotFoundError(f"{name} not found under {PIPE/'models'}")


def build_model(model_name, num_classes, drop_rate):
    import timm

    class DRClassifier(nn.Module):
        def __init__(self):
            super().__init__()
            self.backbone = timm.create_model(model_name, pretrained=False,
                                              num_classes=0, drop_rate=0.0)
            self.num_features = self.backbone.num_features
            self.drop = nn.Dropout(p=drop_rate)
            self.head = nn.Linear(self.num_features, num_classes)

        def forward(self, x):
            return self.head(self.drop(self.backbone(x)))

    return DRClassifier()


def resolve_idrid_path(image_name, tag):
    base = PIPE / "datasets" / "idrid" / "grading" / "B. Disease Grading" / "1. Original Images"
    sub = "a. Training Set" if tag == "train" else "b. Testing Set"
    for ext in (".jpg", ".jpeg", ".JPG", ".png"):
        p = base / sub / f"{image_name}{ext}"
        if p.is_file():
            return p
    # last resort: search
    hits = list(base.rglob(f"{image_name}.*"))
    return hits[0] if hits else None


def pick_val_images(n_per_grade=1):
    ids = np.load(str(find_ckpt("branchA_v1_val_ids.npy", "Model1")), allow_pickle=True)
    lab = np.load(str(find_ckpt("branchA_v1_val_labels.npy", "Model1")), allow_pickle=True)
    buckets = {g: [] for g in range(5)}
    for s, y in zip(ids, lab):
        s = str(s)
        if not s.startswith("idrid__"):
            continue
        rest = s.split("idrid__", 1)[1]
        tag = "train" if "_train_" in rest else "test"
        name = "IDRiD_" + rest.split("IDRiD_")[1]
        p = resolve_idrid_path(name, tag)
        if p is not None:
            buckets[int(y)].append((name, int(y), p))
    rng = np.random.default_rng(42)
    picks = []
    for g in range(5):
        if buckets[g]:
            rng.shuffle(buckets[g])
            picks.extend(buckets[g][:n_per_grade])
    # top up to 5 if some grade had no local file
    if len(picks) < 5:
        pool = [x for g in range(5) for x in buckets[g] if x not in picks]
        rng.shuffle(pool)
        picks.extend(pool[:5 - len(picks)])
    return picks[:5]


class GradCAM:
    """Minimal Grad-CAM for one target conv layer."""
    def __init__(self, model, target_layer):
        self.model = model
        self.acts = None
        self.grads = None
        target_layer.register_forward_hook(self._fwd)
        target_layer.register_full_backward_hook(self._bwd)

    def _fwd(self, module, inp, out):
        self.acts = out.detach()

    def _bwd(self, module, grad_in, grad_out):
        self.grads = grad_out[0].detach()

    def __call__(self, x, class_idx=None):
        self.model.zero_grad(set_to_none=True)
        logits = self.model(x)                       # (1, C)
        if class_idx is None:
            class_idx = int(logits.argmax(1))
        logits[0, class_idx].backward()
        w = self.grads.mean(dim=(2, 3), keepdim=True)          # (1, K, 1, 1)
        cam = (w * self.acts).sum(1).clamp(min=0)[0]           # (h, w)
        cam = cam / (cam.max() + 1e-8)
        return cam.cpu().numpy(), class_idx, torch.softmax(logits, 1)[0].detach().cpu().numpy()


def corner_vs_center(cam):
    """Fraction of CAM mass in a border frame (outer 15%) vs a center box (mid 40%)."""
    h, w = cam.shape
    total = cam.sum() + 1e-8
    bh, bw = int(h * 0.15), int(w * 0.15)
    border = cam.copy()
    border[bh:h - bh, bw:w - bw] = 0
    cy0, cy1 = int(h * 0.3), int(h * 0.7)
    cx0, cx1 = int(w * 0.3), int(w * 0.7)
    center = cam[cy0:cy1, cx0:cx1].sum()
    return border.sum() / total, center / total


def main():
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    ck = torch.load(str(find_ckpt("branchA_v1.pt", "Model1")), map_location="cpu",
                    weights_only=False)
    S = int(ck.get("img_size", 384))
    model = build_model(ck.get("model_name", "efficientnet_b0"),
                        int(ck.get("num_classes", 5)), float(ck.get("drop_rate", 0.3)))
    model.load_state_dict(ck["model_state_dict"], strict=True)
    model.to(dev).eval()

    # target layer: final 1x1 conv of the EfficientNet feature extractor
    target = model.backbone.conv_head
    cam_engine = GradCAM(model, target)

    picks = pick_val_images()
    print(f"[Grad-CAM] target layer = backbone.conv_head | {len(picks)} val images\n")
    print(f"{'image':12s} {'gtGrade':>7} {'pred':>4} {'p(pred)':>8} "
          f"{'borderMass':>10} {'centerMass':>10} {'camStd':>7}  verdict")
    print("-" * 82)

    rows = []
    for name, gt, path in picks:
        bgr = cv2.imread(str(path))
        proc = ben_graham_preprocess(bgr, S)                 # BGR uint8
        rgb = cv2.cvtColor(proc, cv2.COLOR_BGR2RGB)
        x = (rgb.astype(np.float32) / 255.0 - IMAGENET_MEAN) / IMAGENET_STD
        x = torch.from_numpy(x.transpose(2, 0, 1)[None].copy()).float().to(dev)

        cam, cls, probs = cam_engine(x)
        cam_full = cv2.resize(cam, (S, S), interpolation=cv2.INTER_CUBIC)
        cam_full = np.clip(cam_full, 0, 1)

        border, center = corner_vs_center(cam_full)
        std = float(cam_full.std())
        # plausible = concentrated (not uniform) AND not border-dominated
        plausible = (std > 0.12) and (border < 0.55) and (center > 0.20)
        verdict = "OK - focal, on-retina" if plausible else "CHECK - diffuse/edge"
        rows.append((name, gt, cls, plausible))

        heat = cv2.applyColorMap((cam_full * 255).astype(np.uint8), cv2.COLORMAP_JET)
        overlay = cv2.addWeighted(proc, 0.55, heat, 0.45, 0)
        panel = np.concatenate([proc, overlay], axis=1)
        cv2.putText(panel, f"{name}  gt={gt}  pred={cls}  p={probs[cls]:.2f}",
                    (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
        fp = OUT / f"gradcam_{name}_gt{gt}_pred{cls}.png"
        cv2.imwrite(str(fp), panel)

        print(f"{name:12s} {gt:>7} {cls:>4} {probs[cls]:>8.3f} "
              f"{border:>10.2f} {center:>10.2f} {std:>7.3f}  {verdict}")

    n_ok = sum(r[3] for r in rows)
    print("-" * 82)
    print(f"{n_ok}/{len(rows)} heatmaps are focal and on-retina (not corners, not uniform).")
    print(f"PNGs: {OUT}")


if __name__ == "__main__":
    main()
