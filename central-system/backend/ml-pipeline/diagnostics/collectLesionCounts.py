

import argparse
import csv
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, ML_ROOT)
sys.path.insert(0, os.path.join(ML_ROOT, "inference"))

GRADING = os.path.join(ML_ROOT, "datasets", "idrid", "grading", "B. Disease Grading")
SPLITS = {
    "train": (os.path.join(GRADING, "1. Original Images", "a. Training Set"),
              os.path.join(GRADING, "2. Groundtruths",
                           "a. IDRiD_Disease Grading_Training Labels.csv")),
    "test":  (os.path.join(GRADING, "1. Original Images", "b. Testing Set"),
              os.path.join(GRADING, "2. Groundtruths",
                           "b. IDRiD_Disease Grading_Testing Labels.csv")),
}

FIELDS = ["image", "gt_grade", "red_per_quadrant", "sum_red", "sum_bright",
          "ma_per_quadrant", "he_per_quadrant", "fovea_unreliable",
          "red_lesion_model_version"]


def load_labels(csv_path):
    """{image id -> ICDR grade}. IDRiD's header has trailing empty columns."""
    out = {}
    with open(csv_path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            name = (row.get("Image name") or "").strip()
            grade = (row.get("Retinopathy grade") or "").strip()
            if name and grade.isdigit():
                out[name] = int(grade)
    return out


def existing_rows(path):
    if not os.path.isfile(path):
        return {}
    with open(path, newline="", encoding="utf-8") as fh:
        return {r["image"]: r for r in csv.DictReader(fh)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", choices=sorted(SPLITS), default="test")
    ap.add_argument("--version", choices=["v1", "v2"], default="v2")
    ap.add_argument("--limit", type=int, default=0, help="stop after N new images")
    args = ap.parse_args()

    # Set BEFORE importing segInfer: the switch is read at import time.
    os.environ["RED_LESION_MODEL_VERSION"] = args.version
    from inference import segInfer

    img_dir, label_csv = SPLITS[args.split]
    labels = load_labels(label_csv)

    out_dir = os.path.join(HERE, "out")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(
        out_dir, f"lesion_counts_{args.version}_{args.split}.csv")
    done = existing_rows(out_path)

    present = sorted(
        n for n in labels
        if os.path.isfile(os.path.join(img_dir, n + ".jpg")))
    todo = [n for n in present if n not in done]

    print(f"split {args.split}: {len(present)}/{len(labels)} labelled images on "
          f"disk, {len(done)} already collected, {len(todo)} to do "
          f"(model {args.version})", flush=True)

    if args.limit:
        todo = todo[:args.limit]

    t0 = time.time()
    for i, name in enumerate(todo, 1):
        path = os.path.join(img_dir, name + ".jpg")
        try:
            r = segInfer.run_one(path)
            red = r.get("redPerQuadrant") or []
            ma = r.get("maPerQuadrant")
            he = r.get("hePerQuadrant")
            bright = r.get("brightPerQuadrant") or []
            done[name] = {
                "image": name,
                "gt_grade": labels[name],
                "red_per_quadrant": "|".join(str(int(v)) for v in red),
                "sum_red": sum(int(v) for v in red),
                "sum_bright": sum(int(v) for v in bright),
                "ma_per_quadrant": "|".join(str(int(v)) for v in ma) if ma else "",
                "he_per_quadrant": "|".join(str(int(v)) for v in he) if he else "",
                "fovea_unreliable": int(bool(r.get("foveaUnreliable"))),
                "red_lesion_model_version": r.get("redLesionModelVersion") or args.version,
            }
        except Exception as exc:                      # noqa: BLE001
            # One unreadable image must not cost the whole run; the row is
            # simply absent and the next run retries it.
            print(f"  SKIP {name}: {exc}", flush=True)
            continue

        # Flush every image: this run takes tens of minutes and a crash at
        # image 200 should not discard 199 results.
        with open(out_path, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=FIELDS)
            w.writeheader()
            for row in done.values():
                w.writerow(row)

        if i % 10 == 0 or i == len(todo):
            per = (time.time() - t0) / i
            print(f"  {i}/{len(todo)}  {per:.1f}s/image  "
                  f"eta {per * (len(todo) - i) / 60:.0f} min", flush=True)

    print(f"wrote {out_path} ({len(done)} rows)", flush=True)


if __name__ == "__main__":
    main()
