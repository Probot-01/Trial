# NetraSetu — ML Benchmarks (National Round, final)

PS 26038 · Team Game Of Codes

Every number below is measured, and each one states its **population, sample size and interval**. The canonical source for every classifier, conformal, external-validation, lesion and rule-engine figure is the ML lead's *ML Layer Final Report & Claims Ledger* (2026-09-21). Pipeline-level figures (smoke test, parity, soak test) come from the integration pass that followed it.

**How to read this document.** Section 1 holds the numbers we stand behind. Every section after it adds context: how the numbers degrade on a camera the model has never seen, what the deployed code path does on IDRiD's official test split, and what is still unproven. Where a number flatters us for a known reason, the reason sits next to the number.

**Served model versions:**

- classifier: `branchA_v2c`, conformal policy `ordinal_mode_interval_stratified_v3`;
- vessel segmentation: `vessel_unet_v1`;
- optic disc/fovea localization: `localization_v1`;
- hard-exudate segmentation: `hard_exudate` (formerly `bright_lesion`);
- red-lesion segmentation: `red_lesion_unet_v2`.

Checksums are in `docs/RELEASE.md`.

---

## 1. Headline — DR severity classifier (Branch A, `branchA_v2c`), in-domain

**The model:** EfficientNet-B0 at 512×512 with an ordinal-aware loss. It was trained on APTOS 2019 + IDRiD, with an EyePACS subset added to the 5-class loss (weight 0.5) and photometric domain augmentation.

### 1a. Held-out test set: 628 images (550 APTOS + 78 IDRiD)

This set was held out from every training and calibration step for all four model versions.

| Metric | Result | SIH target |
|---|---|---|
| Quadratic-weighted kappa (QWK) | **0.884** | — |
| Referable-DR sensitivity (argmax grade ≥ 2) | 92.7% | > 90% ✅ |
| Referable-DR specificity (argmax grade ≥ 2) | 92.4% | > 85% ✅ |
| Grade-4 (proliferative DR) recall | 57.4% (31/54) | — |
| Grade-1 (mild) recall | 55.0% (n = 60) | — |

### 1b. Live operating point: the calibrated referable threshold

**How the live referral works.** The referral decision is not the argmax grade. It is a calibrated threshold on P(grade ≥ 2), set at **0.3873** for v2c.

**How it was validated.** It was checked by 50-fold cross-fitting on the pooled validation + test population (**n = 1,161**). In cross-fitting, the calibration is always fit on other folds than the one being scored.

| Metric (cross-fit, n = 1,161) | Result [95% CI] | SIH target |
|---|---|---|
| Referable sensitivity at the live threshold | **95.0%** [92.8, 96.6] (478/503) | > 90% ✅, lower bound clears |
| Referable specificity at the live threshold | **91.0%** [88.6, 93.0] (599/658) | > 85% ✅, lower bound clears |

**These are in-domain numbers.** They hold on the camera families the model was trained and calibrated on. Section 3 shows what happens on a camera it has never seen, and that section is part of the result, not a footnote.

### 1c. Why grade-4 recall is 57% and that is still safe

A proliferative case graded 3 instead of 4 is still referred: referral fires on the calibrated P(grade ≥ 2), not on the exact grade. In the cross-fit safety study (Section 2), **zero grade-4 cases were ever auto-cleared** across 1,000 fold assignments.

The low recall is about exact-grade resolution at the top of the scale, not missed referrals. Any grade-4 prediction by the CNN also forces full manual review (Tier C).

**Thin-evidence note on the IDRiD-only slice.** On the 78 IDRiD images within the held-out set, v2c's grade-4 recall is 0.600 (6/10) versus v1's 0.300 (3/10). With n = 10 grade-4 cases, this is too few for a strong claim either way; always quote it separately, never folded into the pooled number.

### 1d. Model lineage (same 628-image held-out set)

| | v1 (384px) | v2a (512px) | v2b (+EyePACS, binary head) | **v2c (deployed)** |
|---|---|---|---|---|
| QWK | 0.869 | 0.873 | 0.885 | **0.884** |
| Referable sens (argmax) | 86.0% | 90.1% | 84.9% | **92.7%** |
| Referable spec (argmax) | 93.8% | 93.8% | 94.7% | **92.4%** |
| Grade-4 recall (n = 54) | 0.444 | 0.537 | 0.463 | **0.574** |

**Disclosed deviation from our own promotion rule.** The pre-declared rule (paired AUC gain on an untouched external half) selects v2b: v2c's AUC gain over v2b was −0.009 [−0.029, +0.012], crossing zero. We deployed v2c anyway, on a more decision-relevant metric: how often the auto-clear tier is wrong about a referable case on an unseen camera. That rate was 2.3% for v2c versus 12.8% for v2b (Section 3). We made this call with both models' full external numbers in hand, and it is stated here rather than hidden.

---

## 2. Safety — conformal confidence tiers (in-domain, cross-fit)

**Method.** Class-conditional (referable-stratified) conformal prediction decides which cases may skip human review (Tier A). It uses two strata: grades 0–1 and grades 2–4, with α = [0.30, 0.05]. The guarantee is therefore strongest on referable cases.

**Setup.** 50-fold cross-fit on the pooled population, n = 1,161, deployed model v2c.

| Guard | Threshold | Result |
|---|---|---|
| Referable-stratum coverage, lower confidence bound | ≥ 93% | **94.2%** ✅ |
| False auto-clear rate, true referable cases (upper bound) | ≤ 5% | **0.0%** ✅ |
| False auto-clear rate, true grade ≥ 3 cases (upper bound) | ≤ 2% | **0.0%** ✅ |
| Mean prediction-set size | ≤ 2.5 | 2.01 ✅ |
| Grade-4 cases auto-cleared, across 1,000 fold assignments | — | **0** |
| Tier distribution (pooled) | — | A 38.4% · B 43.8% · C 17.8% |

**How the method evolved.** Don't describe the current method as the original one.

1. **Legacy marginal LAC.** A single global threshold that could produce non-contiguous or empty prediction sets: 3.8% non-contiguous on the 628-image test set.
2. **Mondrian v2.** Per-grade calibration. An internal sanity gate caught a scoring defect before shipping: confident, correct predictions received the highest nonconformity score, which saturated the quantile at about 0.996.
3. **v3 (shipped).** Corrected scoring, with zero nonconformity at the predicted grade that grows monotonically away from it, plus referable stratification. It is validated by 90/90 automated tests: golden vectors plus 10,000-trial property tests, with exact MATLAB/Python agreement.

**Structural note.** Two safety clauses exist in code but never change an outcome today. Both are subsumed by the calibrated threshold, so they are not described as active safety layers.

- **Referable threshold demotes Tier A → Tier B:** Tier-A eligibility already implies P(grade ≥ 2) well below 0.3873.
- **P(grade 3) + P(grade 4) > 0.5 ⇒ referable:** any such case already exceeds the 0.3873 threshold on P(grade ≥ 2).

**What "guaranteed" does and doesn't mean.** Conformal coverage assumes the test population resembles the calibration population. On an unseen camera it undershoots (Section 3). The accurate phrase is: *class-conditional calibrated confidence, validated in-domain, with a measured and disclosed degradation under camera shift.*

---

## 3. External validation — a camera the model has never seen (Messidor-2)

**The dataset.** Messidor-2: 1,744 gradable images from 874 patients, a Topcon camera, and independently adjudicated grades. It was never used for training, calibration or threshold selection.

**The split.** Patients were split once by patient-ID parity, before any numbers existed. The even half chose between model candidates. The **odd half, n = 872, was never touched until one audited final run**, and every figure below comes from that report half.

- Intervals are 95% patient-level bootstrap.
- False-auto-clear rates use exact Clopper–Pearson bounds.

| Metric | In-domain | **Unseen camera (Messidor-2 report half, n = 872)** |
|---|---|---|
| AUC of P(grade ≥ 2) | ~0.98 | **0.924** [0.900, 0.945] |
| Referable sensitivity at the shipped threshold | 95.0% | **75.2%** [68.6, 81.4] |
| Referable specificity at the shipped threshold | 91.0% | **93.9%** [91.8, 95.8] |
| QWK | 0.884 | 0.717 |
| Grade-4 recall | 57.4% | 46.2% (n = 13) |
| False auto-clear, true referable (final Tier A) | 0.0% | **2.3%** (5/218), CP95 [0.8%, 5.3%] |
| False auto-clear, true grade ≥ 3 | 0.0% | **0.0%** (0/45), CP95 [0%, 7.9%] |
| Tier A / B / C share | 38.4 / 43.8 / 17.8% | 36.5 / 22.0 / 41.5% |

**What this supports, stated plainly:**

- **The >90% sensitivity target does not hold on a camera the system hasn't been validated on.** At the shipped threshold, sensitivity is 75.2%. Specificity holds up fine.
- **Ranking quality is the limit, not calibration.** Refitting the calibration on up to 437 local patients never closed v2c's residual coverage gap (it peaks around 87.6% against a 92.4% target).
- **The auto-clear tier stays close to its safety guard under shift.** The rate is 2.3%, with an upper bound of 5.3%, so read it as *close to* the 5% guard, not a clean pass. No severe case (grade ≥ 3) was auto-cleared.
- **The policy consequence.** No case from a camera or site that hasn't been locally validated may auto-clear; it is capped at Tier B (AI-assisted human review) with reason `unvalidated_camera`. This is the project's answer to domain shift. It is not a claim that the model generalizes; it is a control that stops the model auto-clearing when it might not.
- **Framing for any audience:** *"AI triage with mandatory human review on cameras that have not been locally validated"*, not *"90%+ sensitivity anywhere."*

---

## 4. Deployed code path on IDRiD's official test split (smoke test, not a validation)

**What it is.** An independent run of the full production grading path on the 103 official IDRiD test images (`scripts/audit/eval_idrid_test.py`).

| Metric (n = 103) | Result |
|---|---|
| QWK | 0.841 |
| Referable sensitivity, live referral flag | 100% (64/64) |
| Referable specificity, live referral flag | 82.1% |
| Grade-4 recall | 13/13 |
| Tier A / B / C | 4 / 70 / 29 — **no Tier-A case was referable** |

**Do not quote this table as accuracy.** The temperature scaling and referral threshold were fit on a pool that includes these 103 images, and the set is 62% referable, which moves both sensitivity and specificity. What it establishes is narrower but real: the integrated pipeline, run end to end, grades consistently with the model's validated behavior and silently under-grades nothing on this set. For accuracy, use Sections 1–3.

---

## 5. Segmentation, localization and lesion models

| Model | Test data | Metric | Notes |
|---|---|---|---|
| Vessel U-Net (`vessel_unet_v1`) | CHASE_DB1, held out | **Dice 0.777** | Not retrained this round |
| Same model, no retraining | DRIVE (unseen dataset, n = 20) | Dice 0.619 | Real cross-dataset gap. The live threshold is a fixed 0.5; the designed domain-adaptive threshold was never implemented |
| Optic disc / fovea localization (`localization_v1`) | IDRiD | Mean error **16 px (disc) / 32 px (fovea)** at native resolution | |
| Hard-exudate U-Net | IDRiD | **Dice 0.583** per image / **0.733** global | |
| Red-lesion U-Net **v2, deployed** (3-class: background / MA / haemorrhage) | IDRiD val, n = 16 | **Dice 0.599** merged · MA 0.442 · haemorrhage 0.571 | Tuned and evaluated on the same 16 images, so this is thin evidence |
| Red-lesion U-Net v1 (single merged class) | same 16 images | Dice 0.535 | Predecessor |

**Red-lesion v2.** Its merged Dice overlaps v1's within statistical intervals, so v2 is **not a proven accuracy gain**. What it adds for certain is real, separate microaneurysm and haemorrhage counts per quadrant. It also brings class-specific minimum-area filters: MA 5 px (component F1 0.648) and haemorrhage 10 px (F1 0.595). A single 10 px floor would have discarded most true microaneurysms, whose median ground-truth size is 6 px across 3,452 components.

**Fovea reliability gate.** When the fovea heatmap has no real peak, the case is flagged `foveaUnreliable` (threshold 0.37 in raw heatmap units, not a probability).

- **Catch rate:** it catches both known gross localization failures in the held-out split. With only 2 positives, the interval is wide: 15.8–100%.
- **False alarms:** 5.3% [1.5, 12.9] on otherwise-good localizations.
- **Flag rates:** 2.7% of IDRiD images and 14.6% of Messidor-2 images.

**Not detected, by design.** Cotton-wool spots (soft exudates) have no detector, because the pixel-level training data is too sparse. The field is always reported as unmeasured, never as a false zero. Venous beading and IRMA detectors were not built for the same reason.

**Neovascularization (NV) suspicion score: built, tested, failed.** This was a vessel density, tortuosity, fractal-dimension and branching proxy near the optic disc.

| | IDRiD test (n = 103, 13 PDR) | Messidor-2 (n = 1,744, 35 PDR) |
|---|---|---|
| AUC, PDR vs. all other grades | 0.286 | 0.379 |

Both results are below chance. The cause was investigated: the vessel model, trained on healthy eyes, segments *less* vessel signal on diseased retinas, which swamps the NV signal. The score is **not wired into any decision.** Grade-4 cases are caught by the classifier, by the CNN-grade-4 → Tier C rule, and by mandatory review on branch disagreement.

---

## 6. Rule engine (Branch B — explicit ICDR "4-2-1" criteria)

**What it is.** Plain, auditable code on quadrant-mapped lesion counts, with no learned weights. Its frozen thresholds are `RED_FLOOR=3`, `GRADE3_QUAD_MIN=3` and `RULE_MAX_GRADE=3`. It is deliberately capped at grade 3, since there is no validated NV signal (Section 5).

| Exact agreement with ground truth, IDRiD official test (n = 103) | Result |
|---|---|
| Original thresholds, v1 lesion counts | 58.3% |
| Recalibrated thresholds, v1 counts | 57.3% |
| **Recalibrated thresholds, v2 counts (deployed)** | **60.2%** |

These three overlap within their intervals. An earlier 71.4% figure was measured on 14 hand-picked images, is **superseded**, and must not be quoted.

**Why a 60% rule engine is still useful.** Branch B's job is not to beat the CNN. It gives an independent, human-auditable second opinion: agreement strengthens a case's tier, and **disagreement unconditionally forces mandatory review** with an explicit grade chosen by the ophthalmologist. We report no system-wide Branch A/B agreement rate, because the only candidate file is a curated set of debugging examples, not a representative sample.

---

## 7. Engineering integrity

| Check | Result |
|---|---|
| PyTorch ↔ ONNX ↔ MATLAB tensor parity, all 9 model artifacts | Max difference 1×10⁻⁶ to 4×10⁻⁵ (threshold 0.01) |
| Calibrated classifier, Python vs. MATLAB inference, 10 real IDRiD images | Grade and tier agree 10/10; max probability difference 5.1×10⁻⁷ |
| Red-lesion v2, ONNX vs. MATLAB | Max tensor difference 1.4×10⁻⁵; MA/haemorrhage counts identical on all 10 parity images |
| Full-pipeline soak test: every IDRiD image on disk through capture → quality gate → sync → grading | **447/447 graded, 0 failed, 0 timed out** (throughput and reliability, not accuracy) |
| End-to-end central grading latency per case (warm MATLAB session, dev laptop: Ryzen 7, RTX 4050, 24 GB) | **p50 10.9 s / p95 22.2 s (n=10)**, measured via `POST /api/v1/cases` → poll `/status` until `graded`, 10 real submissions through the live running stack. With n=10, "p95" is effectively the max of 10 samples, not an interpolated percentile — treat it as an upper bound seen, not a statistically tight bound. Range was 10.9s–43.1s; the two outliers (23–43s) look like queue/scheduling variance under a cold-ish run, not a different code path. |
| Local quality-gate latency (desktop, MATLAB) | **p50 0.49 s / p95 3.2 s (n=10)**, measured via 10 direct `qualityGateMain()` calls in a live MATLAB session (warm toolboxes, not counting MATLAB's own interpreter startup). Range 0.17s–3.2s. |
| Quality gate, JS implementation vs. MATLAB reference | Agreement within ~0.005 on reference values |

**Automated tests:**

| Suite | Result |
|---|---|
| Conformal (MATLAB + Python) | 90/90 |
| Fovea gate | 12/12 |
| PHC backend | 41/41 |
| Mobile | 28 |
| Central backend | No automated suite; targeted verification scripts only |

---

## 8. Limitations, stated on purpose

1. **In-domain vs. unseen camera.** Sensitivity is 95.0% in-domain but 75.2% on an unseen camera at the shipped threshold, and local recalibration does not close v2c's gap. That is why unvalidated cameras cannot auto-clear.
2. **External auto-clear margin.** The false-auto-clear rate on the unseen camera is 2.3%, with an upper bound of 5.3%: close to the 5% guard, not a clean pass.
3. **Top-grade resolution.** Grade-4 exact recall is 57.4% in-domain. It is safe because of referral thresholding and Tier C routing, but the top-grade resolution is a real limitation.
4. **Promotion-rule deviation.** v2c was deployed against our own promotion rule's pick (v2b), for a disclosed safety reason.
5. **Red-lesion evidence is thin.** v2 was evaluated on 16 images, the same ones it was tuned on.
6. **Neovascularization failed validation** and is not used. Cotton-wool spots, venous beading and IRMA are out of scope.
7. **Vessel cross-dataset gap.** Dice is 0.777 in-domain vs. 0.619 on DRIVE, with a fixed 0.5 threshold.
8. **Rule engine.** Exact agreement is 60.2% on n = 103; its value is the auditable second opinion and the disagreement trigger, not standalone accuracy.
9. **No clinical data.** No real-patient or prospective data; all results are on public datasets.
    - Two training datasets are Indian populations: APTOS (Aravind Eye Hospital) and IDRiD (Nanded, Maharashtra).
    - No subgroup analysis (age, sex, camera model within a dataset) has been done: the public datasets don't carry the demographic fields needed.
10. **DME.** Diabetic macular edema cannot be reliably ruled out from colour fundus photographs alone.
11. **Quality gate not validated against labels.** Its thresholds are engineered heuristics, checked for MATLAB/JS agreement but not validated against a gradability-labelled dataset.

**Reference point, not a comparison.** IDx-DR's FDA pivotal trial reported 87.2% sensitivity and 90.7% specificity for referable DR (900 patients, 10 sites). IDx-DR is autonomous; NetraSetu is decision support with an ophthalmologist confirming every positive.

---

## 9. Superseded figures — do not quote

These appeared in earlier drafts, the internal-round deck, or working notes. They are replaced by the figures above; anyone presenting NetraSetu should use the right-hand column.

| Old claim | Why it's retired | Use instead |
|---|---|---|
| "100% referable sensitivity, 13/13 grade-4" (IDRiD official test, n = 103) | Calibration pool includes these images | 95.0% / 91.0% (cross-fit, n = 1,161); grade-4 57.4% (n = 54) |
| QWK 0.883 / 0.869, sensitivity 86%, specificity 94–96% | Internal-round model v1 (384px) | v2c: QWK 0.884; 95.0% / 91.0% at the live threshold |
| "Grade-4 recall 0.444" | v1, pooled; always needs population and n | v2c 57.4% (31/54) pooled; IDRiD-only 6/10 |
| "71.4% rule-engine agreement" | n = 14, hand-picked | 60.2% (IDRiD official test, n = 103) |
| "14.6% of prediction sets non-contiguous" | Source never confirmed | 3.8% (legacy method, n = 628) |
| Vessel Dice 0.80 (CHASE_DB1, n = 28) | n = 28 is the whole dataset, training images included | 0.777 held out |
| "Guaranteed confidence" | Coverage only holds in-domain | "Calibrated confidence, validated in-domain, with disclosed degradation under camera shift" |
| ">90% sensitivity" with no population | False on an unseen camera | 95.0% in-domain; 75.2% on an unseen camera |
| "50–100 local images recover the sensitivity gap" | True for v2b, not for the deployed v2c | Unvalidated cameras are capped at human review |
| Lesion detection "evaluated with FROC" | No FROC analysis was run | Dice and component-level F1 (§5) |
| Domain-adaptive vessel threshold (0.5 / 0.10) | Designed, never implemented | Fixed 0.5 threshold |

---

## 10. Sources and reproduction

Every figure traces to one of these. Model binaries are distributed separately and verified by checksum (`npm run models:verify`).

| Figures | Source |
|---|---|
| §1–§3, §5 (lesion, fovea, NV), §6, §9 | ML Layer Final Report & Claims Ledger, 2026-09-21 — **not in repo.** No file matching this name/date exists anywhere in this checkout (searched by name and by date); it exists only outside this repository (the ML lead's own copy). Cross-checked instead against `diagnostics/MODEL_INTERFACE_REFERENCE.md` and `models/red_lesion_v2_metrics.json`, which reproduce the same figures — see the §5 row below. |
| §2 cross-fit guards, tiers, grade-4 auto-clears, Python/MATLAB parity | `central-system/backend/ml-pipeline/diagnostics/out/conformal_v3_crossfit_report_branchA_v2c.json` |
| §3 external validation | `central-system/backend/ml-pipeline/docs/messidor2_v2c_final_external_report.md`, `central-system/backend/ml-pipeline/docs/messidor2_v2b_final_external_report.md` (path corrected — these are nested under `ml-pipeline/docs/`, not the top-level `docs/`) |
| §4 smoke test | `scripts/audit/eval_idrid_test.py` |
| §5 fovea gate | `central-system/backend/ml-pipeline/diagnostics/out/fovea_gate_report.json` |
| §5 segmentation | Vessel 0.777: `diagnostics/MODEL_INTERFACE_REFERENCE.md:257` (CHASE_DB1, subject-level 22-train/6-val split, seed 42 — the genuine held-out score; `diagnostics/out/m2_metrics.json`'s 0.8024 scores against all 28 images including training subjects and is not the same measurement). Hard-exudate 0.583/0.733: `diagnostics/MODEL_INTERFACE_REFERENCE.md:340,343` (original 43-train/11-val IDRiD split; per-image mean / pixel-pooled). Red-lesion v2 0.599/0.442/0.571: `models/red_lesion_v2_metrics.json` (`best_val_dice_merged`, `val_dice_ma`, `val_dice_he`). Red-lesion v1 0.535: `models/red_lesion_predictions(model5)/red_lesion_metrics.json` (`best_val_dice`, n=16) — also independently reproduced in `diagnostics/out/m45_metrics.json`'s `m5_heldout.per_image_dice` (0.53508) on the same 16 images. **Localization 16 px / 32 px: source not located.** The closest file, `diagnostics/out/m3_metrics.json` (heldout, n=77), reports different numbers (mean 26.9 px / 85.6 px native, median 21.2 px / 31.2 px native) — neither matches 16/32 exactly. Flag this specific figure to the ML lead for its source before publishing it; do not treat it as reconciled. |
| §7 artifact parity | `central-system/backend/ml-pipeline/diagnostics/out/artifact_manifest.json` |
| §7 soak test | `scripts/test-full-dataset.js` |

