
import cv2
import numpy as np


def ben_graham_preprocess(image: np.ndarray, target_size: int = 384) -> np.ndarray:
   
    if image is None or image.size == 0:
        raise ValueError("ben_graham_preprocess received an empty or None image.")
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError(
            f"Expected a 3-channel BGR image, got shape {image.shape}."
        )


    x, y, w, h = retinal_crop_box(image)
    cropped = image[y : y + h, x : x + w]

    # Guard against degenerate crops.
    if cropped.size == 0:
        cropped = image

    resized = cv2.resize(cropped, (target_size, target_size), interpolation=cv2.INTER_AREA)


    sigma = target_size / 30.0
    ksize = int(sigma) * 2 + 1  # Always odd
    ksize = max(ksize, 1)

    blurred = cv2.GaussianBlur(resized, (ksize, ksize), sigma)


    enhanced = cv2.addWeighted(resized, 4, blurred, -4, 128)

    return enhanced


def retinal_crop_box(image: np.ndarray):
   
    # Work on the green channel — highest contrast for fundus images.
    gray = image[:, :, 1]

    # Threshold: any pixel brighter than 7 is considered "inside the retina".
    _, mask = cv2.threshold(gray, 7, 255, cv2.THRESH_BINARY)

    # Morphological closing to fill gaps, then find the bounding box.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    if not contours:
        # Fallback: the full image if no contour found.
        return 0, 0, image.shape[1], image.shape[0]

    # Use the largest contour — the retinal disc boundary.
    largest = max(contours, key=cv2.contourArea)
    x, y, w, h = cv2.boundingRect(largest)
    # Ensure we stay within image bounds.
    x = max(0, x)
    y = max(0, y)
    w = min(w, image.shape[1] - x)
    h = min(h, image.shape[0] - y)
    return x, y, w, h
