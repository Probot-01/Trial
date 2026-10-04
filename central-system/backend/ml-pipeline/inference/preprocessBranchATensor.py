
import argparse
import os
import sys

import numpy as np
import scipy.io as sio

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import branchAInfer as bai  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image", nargs="?")
    ap.add_argument("outputMat", nargs="?")
    args = ap.parse_args()

    if not args.image or not args.outputMat:
        print("usage: preprocessBranchATensor.py <imagePath> <outputMatPath>", file=sys.stderr)
        sys.exit(2)
    if not os.path.exists(args.image):
        print(f"preprocessBranchATensor: no file at {args.image}", file=sys.stderr)
        sys.exit(3)

    try:
        # Only the four metadata fields preprocess() reads, from the on-disk
        # cache when the checkpoint is unchanged -- see load_preprocess_meta().
        meta = bai.load_preprocess_meta()
        x, _display_base, enhanced = bai.preprocess(args.image, meta)  # x: (1,3,H,W) NCHW float32

        hwcn = np.transpose(x, (2, 3, 1, 0)).astype(np.float32)  # NCHW -> HWCN (MATLAB SSCB)
        sio.savemat(args.outputMat, {
            "x": hwcn,
            "display": enhanced.astype(np.uint8),
        })
        print(args.outputMat)
        return 0
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - stdout carries only the output path on success
        print(f"preprocessBranchATensor: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(3)


if __name__ == "__main__":
    raise SystemExit(main())
