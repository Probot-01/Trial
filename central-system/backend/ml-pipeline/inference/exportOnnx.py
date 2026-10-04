

import argparse
import os
import sys

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ML_ROOT)

import segInfer  # noqa: E402  (path setup must precede it)

INPUT_SIZE = segInfer.INPUT_SIZE

# role -> output filename. Named after the checkpoint so the .onnx sitting
# next to the .pt is obviously the same model.
EXPORTS = {
    "vessel":       "vessel_unet_v1.onnx",
    "localization": "localization_v1.onnx",
}


def export(role, outdir, opset):
    model, _ckpt = segInfer.load(role)          # strict=True load, .eval()
    channels = segInfer._ARCH[role]["in_channels"]
    dummy = torch.randn(1, channels, INPUT_SIZE, INPUT_SIZE)


    with torch.no_grad():
        out = model(dummy)

    path = os.path.join(outdir, EXPORTS[role])
    torch.onnx.export(
        model,
        dummy,
        path,
        opset_version=opset,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        do_constant_folding=True,

        dynamo=False,
    )
    return path, tuple(dummy.shape), tuple(out.shape)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default=os.path.join(ML_ROOT, "models", "onnx"))
    ap.add_argument("--opset", type=int, default=14)
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    for role in EXPORTS:
        path, ishape, oshape = export(role, args.outdir, args.opset)
        mb = os.path.getsize(path) / 1e6
        print(f"{role:13s} in={ishape} out={oshape} opset={args.opset} "
              f"-> {path} ({mb:.1f} MB)")


    import onnx
    for fname in EXPORTS.values():
        onnx.checker.check_model(os.path.join(args.outdir, fname))
    print("onnx.checker: all models structurally valid")
    print("NEXT: python verifyOnnx.py   (numerical equivalence)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
