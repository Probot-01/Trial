
import sys
from pathlib import Path

import torch
import torch.nn as nn

PIPE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PIPE))


def find_ckpt(name: str) -> Path:
    for c in [PIPE / "models" / name,
              PIPE / "models" / "Model1" / name]:
        if c.is_file():
            return c
    hits = sorted((PIPE / "models").rglob(name))
    if hits:
        return hits[0]
    raise FileNotFoundError(f"{name} not found under {PIPE/'models'}")


def build_drclassifier(model_name, num_classes, drop_rate):
    """Exact architecture from training/train_classifier_kaggle.ipynb (ARCH_DESC):
       timm(model_name, num_classes=0, drop_rate=0) -> nn.Dropout(drop_rate)
       -> nn.Linear(num_features, num_classes)."""
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


def main():
    ck_path = find_ckpt("branchA_v1.pt")
    print(f"[checkpoint] {ck_path}")
    ck = torch.load(str(ck_path), map_location="cpu", weights_only=False)

    meta = {k: ck[k] for k in ck if k != "model_state_dict"}
    print("\n--- checkpoint metadata ---")
    for k in ("model_name", "arch", "num_classes", "num_features", "drop_rate",
              "img_size", "preprocessing", "normalize_mean", "normalize_std",
              "channel_order", "epoch", "val_qwk", "seed"):
        if k in meta:
            print(f"  {k:15s}: {meta[k]}")

    model_name = meta.get("model_name", "efficientnet_b0")
    num_classes = int(meta.get("num_classes", 5))
    drop_rate = float(meta.get("drop_rate", 0.3))

    model = build_drclassifier(model_name, num_classes, drop_rate)
    missing, unexpected = model.load_state_dict(ck["model_state_dict"], strict=False)
    print("\n--- state_dict load ---")
    print(f"  missing keys   : {list(missing) or 'none'}")
    print(f"  unexpected keys: {list(unexpected) or 'none'}")
    print(f"  -> rebuilt DRClassifier matches the checkpoint exactly"
          if not missing and not unexpected else "  -> MISMATCH, investigate")

    # ---- 1. is there an nn.Dropout module, and where? --------------------
    dropouts = [(n, m) for n, m in model.named_modules() if isinstance(m, nn.Dropout)]
    print("\n--- dropout layer inspection ---")
    print(f"  nn.Dropout modules in model : {len(dropouts)}")
    for n, m in dropouts:
        print(f"    '{n}'  p={m.p}")
    # confirm it is *before the head* in the forward path
    fwd = "head(self.drop(self.backbone(x)))"
    print(f"  forward path                : return {fwd}")
    has_pre_head = any(n == "drop" for n, _ in dropouts) and isinstance(model.head, nn.Linear)
    print(f"  nn.Dropout(p={drop_rate}) sits directly before nn.Linear head : {has_pre_head}")

    # timm's own head dropout is a functional F.dropout (no module) and here the
    # backbone was built with drop_rate=0.0, so `model.drop` is the ONLY stochastic
    # unit in the whole network.
    backbone_drops = [(n, m) for n, m in model.backbone.named_modules()
                      if isinstance(m, nn.Dropout) and float(m.p) > 0]
    print(f"  active nn.Dropout inside the timm backbone : {len(backbone_drops)} "
          f"(backbone built with drop_rate=0.0)")

    if not has_pre_head:
        print("\n==> ANSWER: NO usable pre-head dropout layer. See notes above.")
        return

    # ---- 2. can it be forced active independently of eval mode? ----------
    print("\n--- MC-Dropout activation test ---")
    model.eval()  # whole model to eval (BN uses running stats, etc.)

    def enable_mc_dropout(m):
        n_on = 0
        for mod in m.modules():
            if isinstance(mod, nn.Dropout):
                mod.train()
                n_on += 1
        return n_on

    n_on = enable_mc_dropout(model)
    # verify: dropout.training True, everything else still eval
    drop_training = model.drop.training
    bn_states = [mod.training for mod in model.modules()
                 if isinstance(mod, (nn.BatchNorm2d, nn.BatchNorm1d))]
    n_bn_train = sum(bn_states)
    print(f"  forced {n_on} nn.Dropout module(s) to train() after model.eval()")
    print(f"  model.drop.training              : {drop_training}  (want True)")
    print(f"  BatchNorm modules still in eval  : {len(bn_states) - n_bn_train}/{len(bn_states)}"
          f"  ({'all frozen - good' if n_bn_train == 0 else 'SOME IN TRAIN - bad'})")

    torch.manual_seed(0)
    x = torch.randn(1, 3, int(meta.get("img_size", 384)), int(meta.get("img_size", 384)))

    # (a) deterministic reference: everything eval, dropout OFF
    model.eval()
    with torch.no_grad():
        ref = torch.stack([torch.softmax(model(x), 1) for _ in range(5)])
    ref_spread = (ref.max(0).values - ref.min(0).values).max().item()

    # (b) MC-Dropout ON
    model.eval()
    enable_mc_dropout(model)
    with torch.no_grad():
        mc = torch.stack([torch.softmax(model(x), 1)[0] for _ in range(50)])
    per_class_std = mc.std(0)
    mean_probs = mc.mean(0)
    print(f"\n  eval + dropout OFF : identical logits across 5 passes "
          f"(max prob spread {ref_spread:.2e})")
    print(f"  eval + dropout ON  : 50 stochastic passes")
    print(f"    mean pred class          : {int(mean_probs.argmax())}")
    print(f"    per-class softmax std    : "
          + ", ".join(f"{v:.4f}" for v in per_class_std.tolist()))
    print(f"    max per-class std        : {per_class_std.max().item():.4f}")
    print(f"    predictive entropy       : "
          f"{-(mean_probs * (mean_probs + 1e-9).log()).sum().item():.4f} nats")

    works = (ref_spread < 1e-5) and (per_class_std.max().item() > 1e-3) and (n_bn_train == 0)
    print("\n" + "=" * 60)
    print(f"  ANSWER: dropout layer present = YES  (model.drop = nn.Dropout(p={drop_rate}))")
    print(f"          MC-Dropout usable     = {'YES' if works else 'NO'}"
          f"  (stochastic at inference, BN stays frozen)")
    print("=" * 60)


if __name__ == "__main__":
    main()
