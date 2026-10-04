
import argparse
import sys
import os
import numpy as np
import cv2


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from preprocessing.ben_graham import ben_graham_preprocess
from preprocessing.clahe_enhance import clahe_enhance




def make_synthetic_fundus(size: int = 512) -> np.ndarray:
    
    img = np.zeros((size, size, 3), dtype=np.uint8)
    cx, cy, r = size // 2, size // 2, int(size * 0.45)

    # Radial gradient inside the disc (mimics fundus illumination falloff)
    Y, X = np.ogrid[:size, :size]
    dist = np.sqrt((X - cx) ** 2 + (Y - cy) ** 2).astype(np.float32)
    mask = dist <= r
    intensity = np.clip(1.0 - (dist / r) * 0.5, 0, 1)

    img[mask, 1] = (intensity[mask] * 180).astype(np.uint8)   # green channel
    img[mask, 0] = (intensity[mask] * 30).astype(np.uint8)    # blue channel
    img[mask, 2] = (intensity[mask] * 20).astype(np.uint8)    # red channel

    # Add some noise to make it more realistic
    noise = np.random.normal(0, 8, img.shape).astype(np.int16)
    img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)

    # Simulate a few bright exudate-like spots
    for _ in range(5):
        sx = cx + np.random.randint(-r // 2, r // 2)
        sy = cy + np.random.randint(-r // 2, r // 2)
        cv2.circle(img, (sx, sy), np.random.randint(4, 12), (60, 200, 200), -1)

    return img


# ------------------------------------------------------------------ #
# Utility: make a side-by-side comparison image                       #
# ------------------------------------------------------------------ #

def side_by_side(images: list, labels: list, target_h: int = 400) -> np.ndarray:
    """Resize all images to target_h height and concatenate horizontally."""
    panels = []
    for img, label in zip(images, labels):
        h, w = img.shape[:2]
        new_w = int(w * target_h / h)
        resized = cv2.resize(img, (new_w, target_h))
        # Add label text
        cv2.putText(resized, label, (10, 30), cv2.FONT_HERSHEY_SIMPLEX,
                    0.8, (255, 255, 255), 2, cv2.LINE_AA)
        panels.append(resized)
    return np.concatenate(panels, axis=1)


# ------------------------------------------------------------------ #
# Main                                                                 #
# ------------------------------------------------------------------ #

def main():
    parser = argparse.ArgumentParser(description="Test preprocessing pipeline")
    parser.add_argument("--image", type=str, default=None,
                        help="Path to a fundus image. If omitted, uses a synthetic image.")
    parser.add_argument("--size", type=int, default=384,
                        help="Target size for Ben Graham preprocessing. Default 384.")
    parser.add_argument("--clip", type=float, default=2.0,
                        help="CLAHE clip limit. Default 2.0.")
    args = parser.parse_args()

    out_dir = SCRIPT_DIR  # Save outputs next to the script

    # ---- Load or generate input image ---- #
    if args.image:
        original = cv2.imread(args.image)
        if original is None:
            print(f"[ERROR] Could not read image at: {args.image}")
            sys.exit(1)
        print(f"[INFO] Loaded image: {args.image}  shape={original.shape}")
    else:
        print("[INFO] No image provided — generating synthetic fundus image for testing.")
        original = make_synthetic_fundus(size=512)

    # ---- Run preprocessing ---- #
    print(f"[INFO] Running ben_graham_preprocess (target_size={args.size})...")
    ben_graham_out = ben_graham_preprocess(original.copy(), target_size=args.size)
    print(f"       Output shape: {ben_graham_out.shape}")

    print(f"[INFO] Running clahe_enhance (clip_limit={args.clip}) on original...")
    clahe_out = clahe_enhance(original.copy(), clip_limit=args.clip)
    print(f"       Output shape: {clahe_out.shape}")

    print("[INFO] Running combined: ben_graham → clahe...")
    both_out = clahe_enhance(ben_graham_out.copy(), clip_limit=args.clip)
    print(f"       Output shape: {both_out.shape}")

    # ---- Save individual outputs ---- #
    cv2.imwrite(os.path.join(out_dir, "test_output_original.png"), original)
    cv2.imwrite(os.path.join(out_dir, "test_output_ben_graham.png"), ben_graham_out)
    cv2.imwrite(os.path.join(out_dir, "test_output_clahe.png"), clahe_out)
    cv2.imwrite(os.path.join(out_dir, "test_output_both.png"), both_out)

    # ---- Save a side-by-side comparison ---- #
    # Resize clahe_out to same size as ben_graham_out for comparison
    clahe_resized = cv2.resize(clahe_out, (args.size, args.size))
    original_resized = cv2.resize(original, (args.size, args.size))
    comparison = side_by_side(
        [original_resized, ben_graham_out, clahe_resized, both_out],
        ["Original", "Ben Graham", "CLAHE", "Ben Graham + CLAHE"]
    )
    cv2.imwrite(os.path.join(out_dir, "test_output_comparison.png"), comparison)

    print("\n[DONE] Saved outputs:")
    for name in ["test_output_original.png", "test_output_ben_graham.png",
                 "test_output_clahe.png", "test_output_both.png",
                 "test_output_comparison.png"]:
        path = os.path.join(out_dir, name)
        size_kb = os.path.getsize(path) / 1024
        print(f"  {name}  ({size_kb:.1f} KB)")

    print("\n[INFO] Visual check: open test_output_comparison.png to see all four variants side by side.")


if __name__ == "__main__":
    main()
