

import argparse
import os
import sys

import cv2
import numpy as np


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preprocessing.ben_graham import ben_graham_preprocess      # noqa: E402


def reference_chain(bgr_image: np.ndarray, target_size: int = 384) -> np.ndarray:
   
    return ben_graham_preprocess(bgr_image, target_size=target_size)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("images", nargs="+", help="input fundus image paths")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--size", type=int, default=384,
                    help="target size; must match the trained network (384)")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    for path in args.images:

        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        if bgr is None:
            print(f"SKIP  could not read {path}", file=sys.stderr)
            continue

        out = reference_chain(bgr, target_size=args.size)

        stem = os.path.splitext(os.path.basename(path))[0]
        dest = os.path.join(args.out, f"{stem}_reference.png")
        cv2.imwrite(dest, out)   # imwrite expects BGR, which is what we have

        print(f"{path}  ->  {dest}   shape={out.shape} dtype={out.dtype}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
