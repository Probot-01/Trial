

import os
import sys

import numpy as np
import torch
import torch.nn as nn
import timm
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from preprocessing.ben_graham import ben_graham_preprocess      # noqa: E402
from preprocessing.clahe_enhance import clahe_enhance           # noqa: E402

MODEL_DIR = os.path.join(HERE, "models", "Model1")
IDRID_DIR = os.path.join(HERE, "datasets", "idrid", "grading",
                         "B. Disease Grading", "1. Original Images")


class DRClassifier(nn.Module):
   

    def __init__(self, model_name, num_classes, num_features, drop_rate):
        super().__init__()
        self.backbone = timm.create_model(model_name, pretrained=False,
                                          num_classes=0, drop_rate=0)
        self.dropout = nn.Dropout(drop_rate)
        self.head = nn.Linear(num_features, num_classes)

    def forward(self, x):
        return self.head(self.dropout(self.backbone(x)))


def load_model(ckpt):
    m = DRClassifier(ckpt["model_name"], ckpt["num_classes"],
                     ckpt["num_features"], ckpt["drop_rate"])
    missing, unexpected = m.load_state_dict(ckpt["model_state_dict"], strict=True)
    m.eval()
    return m


def find_image(image_id):
    
    stem_full = image_id.split("__")[-1]
    if stem_full.startswith("idrid_train_"):
        split = "a. Training Set"
        stem = stem_full.replace("idrid_train_", "")
    elif stem_full.startswith("idrid_test_"):
        split = "b. Testing Set"
        stem = stem_full.replace("idrid_test_", "")
    else:
        return None

    p = os.path.join(IDRID_DIR, split, stem + ".jpg")
    return p if os.path.exists(p) else None


def chain_ben_graham_only(bgr, size):
    return ben_graham_preprocess(bgr, target_size=size)


def chain_ben_graham_plus_clahe(bgr, size):
    x = ben_graham_preprocess(bgr, target_size=size)
    return clahe_enhance(x, clip_limit=2.0, tile_grid_size=(8, 8))


CHAINS = {
    "ben_graham only": chain_ben_graham_only,
    "ben_graham + CLAHE": chain_ben_graham_plus_clahe,
}


def main():
    ckpt = torch.load(os.path.join(MODEL_DIR, "branchA_v1.pt"),
                      map_location="cpu", weights_only=False)
    model = load_model(ckpt)

    size = ckpt["img_size"]
    mean = np.array(ckpt["normalize_mean"], dtype=np.float32)
    std = np.array(ckpt["normalize_std"], dtype=np.float32)
    order = ckpt["channel_order"]

    ids = np.load(os.path.join(MODEL_DIR, "branchA_v1_test_ids.npy"), allow_pickle=True)
    ref_logits = np.load(os.path.join(MODEL_DIR, "branchA_v1_test_logits.npy"))
    labels = np.load(os.path.join(MODEL_DIR, "branchA_v1_test_labels.npy"))

    rows = []
    for i, raw_id in enumerate(ids):
        sid = str(raw_id)
        if not sid.startswith("idrid"):
            continue
        p = find_image(sid)
        if p:
            rows.append((i, sid, p))

    print(f"checkpoint: {ckpt['model_name']} @ {size}px, channel_order={order}")
    print(f"matched {len(rows)} of 78 IDRiD test images on disk\n")
    if not rows:
        print("No images matched; cannot identify the chain.")
        return 1

    results = {}
    for name, fn in CHAINS.items():
        got, want = [], []
        for idx, sid, path in rows:
            bgr = cv2.imread(path, cv2.IMREAD_COLOR)
            if bgr is None:
                continue
            proc = fn(bgr, size)                      # BGR, uint8, size x size
            rgb = cv2.cvtColor(proc, cv2.COLOR_BGR2RGB) if order == "RGB" else proc
            x = rgb.astype(np.float32) / 255.0
            x = (x - mean) / std
            t = torch.from_numpy(x.transpose(2, 0, 1)).unsqueeze(0)
            with torch.no_grad():
                got.append(model(t).numpy()[0])
            want.append(ref_logits[idx])

        got = np.array(got)
        want = np.array(want)
        mad = float(np.abs(got - want).mean())
        agree = float((got.argmax(1) == want.argmax(1)).mean())
        corr = float(np.corrcoef(got.ravel(), want.ravel())[0, 1])
        results[name] = (mad, agree, corr)

        print(f"--- {name}")
        print(f"    mean |logit difference| : {mad:.4f}")
        print(f"    predicted-class agreement: {agree*100:.1f}%")
        print(f"    correlation              : {corr:.4f}\n")

    best = min(results, key=lambda k: results[k][0])
    print("=" * 62)
    print(f"TRAINING CHAIN IS ALMOST CERTAINLY: {best}")
    print("=" * 62)
    print("A near-zero logit difference means the pixels fed in here are the")
    print("pixels the model was trained on. A large one means they are not,")
    print("however plausible the images look.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
