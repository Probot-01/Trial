
import sys
from pathlib import Path

import numpy as np
import cv2
import pandas as pd
import torch
import torch.nn as nn

PIPE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PIPE))
from preprocessing.ben_graham import ben_graham_preprocess  # noqa: E402

OUT = Path(__file__).resolve().parent / "out"
OUT.mkdir(exist_ok=True)

IMN_M = np.array([0.485, 0.456, 0.406], np.float32)
IMN_S = np.array([0.229, 0.224, 0.225], np.float32)

N_IMAGES = 14
MIN_BLOB_AREA = 10          # px @ 512, drop specks (matches red-lesion training threshold)
SEED = 42
DEV = torch.device("cuda" if torch.cuda.is_available() else "cpu")

GRAD = PIPE / "datasets" / "idrid" / "grading" / "B. Disease Grading"
LOC = PIPE / "datasets" / "idrid" / "localization" / "C. Localization" / "2. Groundtruths"


# ---------------------------------------------------------------- resolvers
def find_ckpt(name, *subdirs):
    for c in [PIPE / "models" / name] + [PIPE / "models" / s / name for s in subdirs]:
        if c.is_file():
            return c
    hits = sorted((PIPE / "models").rglob(name))
    if hits:
        return hits[0]
    raise FileNotFoundError(f"{name} not found under {PIPE/'models'}")


def idrid_grade_csv():
    d = {}
    for f, tag in [("2. Groundtruths/a. IDRiD_Disease Grading_Training Labels.csv", "train"),
                   ("2. Groundtruths/b. IDRiD_Disease Grading_Testing Labels.csv", "test")]:
        t = pd.read_csv(GRAD / f)
        t.columns = [c.strip() for c in t.columns]
        for _, r in t.iterrows():
            d[(tag, str(r["Image name"]).strip())] = int(r["Retinopathy grade"])
    return d


def load_loc_csv(rel):
    t = pd.read_csv(LOC / rel)
    t.columns = [c.strip() for c in t.columns]
    xc = [c for c in t.columns if c.lower().startswith("x")][0]
    yc = [c for c in t.columns if c.lower().startswith("y")][0]
    return {str(r["Image No"]).strip(): (float(r[xc]), float(r[yc]))
            for _, r in t.iterrows() if str(r["Image No"]).strip().startswith("IDRiD")}


def img_path(name, tag):
    sub = "a. Training Set" if tag == "train" else "b. Testing Set"
    for ext in (".jpg", ".jpeg", ".JPG", ".png"):
        p = GRAD / "1. Original Images" / sub / f"{name}{ext}"
        if p.is_file():
            return p
    return None


# ---------------------------------------------------------------- models
def build_drclassifier(model_name, num_classes, drop_rate):
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


def load_smp_unet(ck, default_in=3):
    import segmentation_models_pytorch as smp
    enc = ck.get("encoder") or ck.get("encoder_name") or "resnet34"
    m = smp.Unet(encoder_name=enc, encoder_weights=None,
                 in_channels=int(ck.get("in_channels", default_in)),
                 classes=int(ck.get("classes", 1)))
    m.load_state_dict(ck["model_state_dict"])
    return m.to(DEV).eval()


# ---------------------------------------------------------------- inference helpers
def classifier_grade(model, bgr, size):
    proc = ben_graham_preprocess(bgr, size)
    rgb = cv2.cvtColor(proc, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    x = ((rgb - IMN_M) / IMN_S).transpose(2, 0, 1)[None]
    with torch.no_grad():
        logit = model(torch.from_numpy(x.copy()).float().to(DEV))
    p = torch.softmax(logit, 1)[0].cpu().numpy()
    return int(p.argmax()), p


def localize(model, bgr, size):
    """resize + ImageNet norm; channel 0 = optic disc, channel 1 = fovea (verified
    against IDRiD GT). Returns ((odx,ody),(fovx,fovy)) in ORIGINAL pixel coords."""
    H, W = bgr.shape[:2]
    rgb = cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), (size, size)).astype(np.float32) / 255.0
    x = ((rgb - IMN_M) / IMN_S).transpose(2, 0, 1)[None]
    with torch.no_grad():
        hm = torch.sigmoid(model(torch.from_numpy(x.copy()).float().to(DEV)))[0].cpu().numpy()
    pts = []
    for c in range(hm.shape[0]):
        yy, xx = np.unravel_index(int(hm[c].argmax()), hm[c].shape)
        pts.append((xx * W / size, yy * H / size))
    return pts[0], pts[1]


def seg_blobs(model, bgr, size, od_xy_512=None, od_radius=0):
    """Ben Graham + (x/255-0.5)/0.5; return list of blob centroids in 512-space."""
    proc = ben_graham_preprocess(bgr, size)
    rgb = cv2.cvtColor(proc, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    x = ((rgb - 0.5) / 0.5).transpose(2, 0, 1)[None]
    with torch.no_grad():
        prob = torch.sigmoid(model(torch.from_numpy(x.copy()).float().to(DEV)))[0, 0].cpu().numpy()
    mask = (prob > 0.5).astype(np.uint8)
    if od_xy_512 is not None and od_radius > 0:
        yy, xx = np.ogrid[:size, :size]
        mask[((xx - od_xy_512[0]) ** 2 + (yy - od_xy_512[1]) ** 2) <= od_radius ** 2] = 0
    n, _, stats, cents = cv2.connectedComponentsWithStats(mask, connectivity=8)
    return [tuple(cents[i]) for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= MIN_BLOB_AREA]


def quadrant_counts(centroids, fovea_xy, od_xy):
    """4 quadrants in the frame centred at the fovea, x-axis = fovea->OD (nasal),
    y-axis = perpendicular. Returns [q_++, q_+-, q_-+, q_--] counts."""
    ax = np.array(od_xy, float) - np.array(fovea_xy, float)
    n = np.linalg.norm(ax)
    if n < 1e-6:
        ax = np.array([1.0, 0.0]); n = 1.0
    ax = ax / n
    perp = np.array([-ax[1], ax[0]])
    counts = [0, 0, 0, 0]
    for c in centroids:
        d = np.array(c, float) - np.array(fovea_xy, float)
        u, v = float(d @ ax), float(d @ perp)
        idx = (0 if u >= 0 else 2) + (0 if v >= 0 else 1)
        counts[idx] += 1
    return counts


def rule_engine(red_q, bright_q, nv_score=0.0):
    """Returns (grade, which_clause_fired)."""
    sum_red, sum_bright = sum(red_q), sum(bright_q)
    if nv_score > 0.6:
        return 4, "nv>0.6"
    if all(q > 20 for q in red_q):                       # "> 20 in ALL 4 quadrants"
        return 3, "red>20 all-quads"
    if sum_red > 0 and (sum_bright > 0 or sum_red > 5):
        return 2, "red>0 & (bright>0 | red>5)"
    if sum_red > 0:
        return 1, "red>0"
    return 0, "no lesions"


# ---------------------------------------------------------------- main
def pick_images():
    ids = np.load(str(find_ckpt("branchA_v1_val_ids.npy", "Model1")), allow_pickle=True)
    lab = np.load(str(find_ckpt("branchA_v1_val_labels.npy", "Model1")), allow_pickle=True)
    od = {**load_loc_csv("1. Optic Disc Center Location/a. IDRiD_OD_Center_Training Set_Markups.csv"),
          **load_loc_csv("1. Optic Disc Center Location/b. IDRiD_OD_Center_Testing Set_Markups.csv")}
    fo = {**load_loc_csv("2. Fovea Center Location/IDRiD_Fovea_Center_Training Set_Markups.csv"),
          **load_loc_csv("2. Fovea Center Location/IDRiD_Fovea_Center_Testing Set_Markups.csv")}
    buckets = {g: [] for g in range(5)}
    for s, y in zip(ids, lab):
        s = str(s)
        if not s.startswith("idrid__"):
            continue
        rest = s.split("idrid__", 1)[1]
        tag = "train" if "_train_" in rest else "test"
        name = "IDRiD_" + rest.split("IDRiD_")[1]
        p = img_path(name, tag)
        if p is not None and name in od and name in fo:
            buckets[int(y)].append((name, tag, int(y), p, od[name], fo[name]))
    rng = np.random.default_rng(SEED)
    picks, per = [], max(1, N_IMAGES // 5)
    for g in range(5):
        rng.shuffle(buckets[g])
        picks += buckets[g][:per]
    pool = [x for g in range(5) for x in buckets[g][per:]]
    rng.shuffle(pool)
    picks += pool[:max(0, N_IMAGES - len(picks))]
    return picks[:N_IMAGES]


def main():
    print(f"[device] {DEV}")
    ck_clf = torch.load(str(find_ckpt("branchA_v1.pt", "Model1")), map_location="cpu",
                        weights_only=False)
    clf = build_drclassifier(ck_clf.get("model_name", "efficientnet_b0"),
                             int(ck_clf.get("num_classes", 5)),
                             float(ck_clf.get("drop_rate", 0.3)))
    clf.load_state_dict(ck_clf["model_state_dict"], strict=True)
    clf.to(DEV).eval()
    clf_size = int(ck_clf.get("img_size", 384))

    ck_loc = torch.load(str(find_ckpt("localization_v1.pt", "Model3")), map_location="cpu",
                        weights_only=False)
    loc = load_smp_unet(ck_loc)
    loc_size = int(ck_loc.get("input_size", 512))

    ck_red = torch.load(str(find_ckpt("red_lesion_unet_v1.pt", "Model5",
                                      "red_lesion_predictions(model5)")),
                        map_location="cpu", weights_only=False)
    red = load_smp_unet(ck_red)
    red_size = int(ck_red.get("image_input_size", 512))

    ck_br = torch.load(str(find_ckpt("bright_lesion_unet_v1.pt", "Model4")), map_location="cpu",
                       weights_only=False)
    bright = load_smp_unet(ck_br)
    br_size = int(ck_br.get("input_size", 512))
    od_r = int(ck_br.get("od_mask_radius", 0)) if ck_br.get("od_masking") else 0

    grades = idrid_grade_csv()
    picks = pick_images()

    print(f"\nModels:")
    print(f"  classifier   branchA_v1        efficientnet_b0 @ {clf_size}, ben-graham + imagenet-norm")
    print(f"  localization localization_v1   resnet18 U-Net @ {loc_size}, ch0=OD ch1=fovea")
    print(f"  red lesion   red_lesion_unet_v1 resnet34 U-Net @ {red_size} (MA OR HE)")
    print(f"  bright les.  bright_lesion_unet_v1 resnet34 U-Net @ {br_size}, OD-mask r={od_r}")
    print(f"\nRule engine: nv_suspicion_score defaults to 0 (no NV model) -> grade 4 unreachable.")
    print(f"'hemorrhage count' == red-lesion blob count (model does not split MA vs HE).")
    print(f"Blob = 8-connected component >= {MIN_BLOB_AREA}px @ 512.\n")

    hdr = (f"{'image':11s} {'gtGr':>4} {'ruleGr':>6} {'clfGr':>5} {'agree':>5} | "
           f"{'sRed':>4} {'sBrt':>4} {'redPerQuad':>16} {'minQ':>4} | "
           f"{'ODerr':>6} {'FOVerr':>6}")
    print(hdr)
    print("-" * len(hdr))

    rows = []
    od_errs, fov_errs = [], []
    for name, tag, gt, p, od_gt, fov_gt in picks:
        bgr = cv2.imread(str(p))
        H, W = bgr.shape[:2]

        cg, _ = classifier_grade(clf, bgr, clf_size)
        (odx, ody), (fvx, fvy) = localize(loc, bgr, loc_size)
        od_err = float(np.hypot(odx - od_gt[0], ody - od_gt[1]))
        fov_err = float(np.hypot(fvx - fov_gt[0], fvy - fov_gt[1]))
        od_errs.append(od_err); fov_errs.append(fov_err)

        # OD centre expressed in the 512 seg-space, for bright-lesion OD masking
        od_512 = (odx * br_size / W, ody * br_size / H)
        # fovea / OD in 512 seg-space for quadrant frame
        fov_s = (fvx * red_size / W, fvy * red_size / H)
        od_s = (odx * red_size / W, ody * red_size / H)

        red_c = seg_blobs(red, bgr, red_size)
        br_c = seg_blobs(bright, bgr, br_size, od_xy_512=od_512, od_radius=od_r)
        red_q = quadrant_counts(red_c, fov_s, od_s)
        br_q = quadrant_counts(br_c, fov_s, od_s)

        rg, clause = rule_engine(red_q, br_q, nv_score=0.0)
        agree = (rg == cg)
        rows.append((name, gt, rg, cg, agree, sum(red_q), sum(br_q), tuple(red_q), clause))
        print(f"{name:11s} {gt:>4} {rg:>6} {cg:>5} {str(agree):>5} | "
              f"{sum(red_q):>4} {sum(br_q):>4} {str(red_q):>16} {min(red_q):>4} | "
              f"{od_err:>6.0f} {fov_err:>6.0f}")

    n = len(rows)
    exact = sum(r[4] for r in rows)
    within1 = sum(abs(r[2] - r[3]) <= 1 for r in rows)
    print("-" * len(hdr))
    print(f"\nAgreement (exact grade match):  {exact}/{n} = {100*exact/n:.1f}%")
    print(f"Agreement (within +/- 1 grade): {within1}/{n} = {100*within1/n:.1f}%")
    print(f"Localization vs IDRiD GT: mean OD err {np.mean(od_errs):.0f}px, "
          f"mean fovea err {np.mean(fov_errs):.0f}px  (orig ~{W}x{H})")
    import collections
    pair = collections.Counter((r[2], r[3]) for r in rows)
    print("\n(rule, classifier) pairs:", dict(sorted(pair.items())))
    print("rule clause that fired :", dict(collections.Counter(r[8] for r in rows)))
    rule_hist = collections.Counter(r[2] for r in rows)
    clf_hist = collections.Counter(r[3] for r in rows)
    gt_hist = collections.Counter(r[1] for r in rows)
    print(f"grade histogram  GT:{dict(sorted(gt_hist.items()))}  "
          f"rule:{dict(sorted(rule_hist.items()))}  clf:{dict(sorted(clf_hist.items()))}")

    csv = OUT / "agreement_results.csv"
    with open(csv, "w") as f:
        f.write("image,gt_grade,rule_grade,classifier_grade,agree,sum_red,sum_bright,"
                "red_per_quadrant,rule_clause\n")
        for r in rows:
            f.write(f"{r[0]},{r[1]},{r[2]},{r[3]},{int(r[4])},{r[5]},{r[6]},"
                    f"\"{r[7]}\",{r[8]}\n")
    print(f"\nper-image table -> {csv}")


if __name__ == "__main__":
    main()
