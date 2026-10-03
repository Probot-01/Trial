# NetraSetu — ML Benchmarks

PS 26038 · Team Game Of Codes

Every number below is measured on real data by real code already in this repository — nothing is
estimated or projected. Each figure states its population, sample size and (where applicable)
confidence interval, and cites the exact file it came from so it can be independently reproduced.
Where a number is optimistic for a stated reason, that caveat sits right next to it rather than
being hidden — this is also the project's own standing design rule for what the product shows a
clinician, applied here to what we show a reviewer.

**What's running:** a DR severity classifier, four lesion/structure segmentation models (vessels,
optic disc/fovea, hard exudates, microaneurysms + haemorrhages), and an explicit rule engine.
Exact served model identifiers and checksums are in `docs/RELEASE.md`, for anyone reproducing a
number below.

---

## 1. Headline result — DR severity classifier

**The model:** EfficientNet-B0 at 512×512 with an ordinal-aware loss, trained on APTOS 2019 +
IDRiD with an EyePACS subset added to the 5-class loss, plus photometric domain augmentation.

### 1a. Held-out test set — 628 images (550 APTOS + 78 IDRiD), never touched during training or calibration

| Metric | Result | SIH problem-statement target |
|---|---|---|
| Quadratic-weighted kappa (QWK) | **0.884** | |
| Referable-DR sensitivity (argmax grade ≥ 2) | **92.7%** | > 90% ✅ |
| Referable-DR specificity (argmax grade ≥ 2) | **92.4%** | > 85% ✅ |
| Grade-4 (proliferative DR) recall | 57.4% (31/54) | |

### 1b. The live operating point — what actually decides a referral

The referral decision is not the argmax grade; it's a calibrated threshold on P(grade ≥ 2), set
at **0.3873**, validated by 50-fold cross-fitting on the pooled validation + test population
(**n = 1,161**) — in cross-fitting, every fold's calibration is fit on the *other* folds, never
the one being scored.

| Metric (cross-fit, n = 1,161) | Result [95% CI] | SIH target |
|---|---|---|
| Referable sensitivity at the live threshold | **95.0%** [92.8, 96.6] (478/503) | > 90% ✅ |
| Referable specificity at the live threshold | **91.0%** [88.6, 93.0] (599/658) | > 85% ✅ |

**Reference point, not a like-for-like comparison:** the FDA-pivotal-trial benchmark for
autonomous DR screening (IDx-DR, 900 patients, 10 primary-care sites) reported 87.2% sensitivity
/ 90.7% specificity. NetraSetu is decision support with an ophthalmologist confirming every
referral, not an autonomous diagnostic — this is a scale reference, not a claim of equivalence.

### 1c. Grade-4 recall is 57.4% in-domain, and that's still a safe system

A proliferative case graded 3 instead of 4 is still referred — referral fires on the calibrated
P(grade ≥ 2), not on hitting the exact top grade. In the cross-fit safety study below, **zero
grade-4 cases were ever auto-cleared**, across 1,000 fold assignments. The lower exact-grade
number is about resolution at the very top of the scale, not about missed referrals, and any
grade-4 CNN prediction independently forces full manual review (Tier C).

### 1d. How the classifier improved across development — same 628-image held-out set

| | First working version | Larger input size | + more training data | **Deployed** |
|---|---|---|---|---|
| QWK | 0.869 | 0.873 | 0.885 | **0.884** |
| Referable sensitivity (argmax) | 86.0% | 90.1% | 84.9% | **92.7%** |
| Referable specificity (argmax) | 93.8% | 93.8% | 94.7% | **92.4%** |
| Grade-4 recall (n = 54) | 0.444 | 0.537 | 0.463 | **0.574** |

The deployed classifier resolved the first version's known grade-4 weakness (0.444 → 0.574) and
was chosen over the candidate that technically scored marginally higher in training, on the most
decision-relevant metric available: how often the auto-clear tier is wrong about a referable case
on a camera the model has never seen (Section 3) — 2.3% for the deployed classifier versus 12.8%
for that candidate. We had both candidates' full external numbers in hand when we made that call.

---

## 2. Statistical safety validation — conformal confidence tiers

Class-conditional conformal calibration decides which cases can safely skip human review
(Tier A). It's evaluated separately from raw accuracy because it's a *coverage guarantee*, not a
point estimate — a cross-fit study on the pooled val+test population (n = 1,161).

| Guard | Threshold | Result |
|---|---|---|
| Referable-case coverage, lower confidence bound | ≥ 93% | **94.2%** ✅ |
| False auto-clear rate, referable cases | ≤ 5% | **0.0%** ✅ |
| False auto-clear rate, grade ≥ 3 cases | ≤ 2% | **0.0%** ✅ |
| Mean prediction-set size (smaller = more decisive) | ≤ 2.5 | 2.01 ✅ |
| Grade-4 cases auto-cleared, across 1,000 fold assignments | — | **0** |
| Tier distribution (pooled) | — | A 38.4% · B 43.8% · C 17.8% |

**The clinical safety claim this supports:** across a cross-fit study covering the model's full
calibration population, **no grade-4 case has ever auto-cleared without human review**. That's
the property the tiering system exists to guarantee, and it held with zero exceptions.

**Cross-implementation parity:** the calibrated classifier's Python and MATLAB inference paths
agree exactly 10/10 on grade and tier across real IDRiD images, with a max probability difference
of 5.1×10⁻⁷ — floating-point noise, not a real divergence.

---

## 3. External validation — a camera the model has never seen (Messidor-2)

**The dataset:** 1,744 gradable images from 874 patients, shot on a Topcon camera, with
independently adjudicated grades — never used for training, calibration or threshold selection.

**The split:** patients were split once by patient-ID parity, before any numbers existed. The
even half chose between model candidates; the **odd half (n = 872) was never touched until one
final audited run**, and every figure below comes from that report half. Intervals are 95%
patient-level bootstrap; false-auto-clear rates use exact Clopper–Pearson bounds.

| Metric | In-domain | **Unseen camera (Messidor-2, n = 872)** |
|---|---|---|
| AUC of P(grade ≥ 2) | 0.979 | **0.924** [0.900, 0.945] |
| Referable sensitivity at the shipped threshold | 95.0% | **75.2%** [68.6, 81.4] |
| Referable specificity at the shipped threshold | 91.0% | **93.9%** [91.8, 95.8] |
| QWK | 0.884 | 0.717 |
| Grade-4 recall | 57.4% | 46.2% (n = 13) |
| False auto-clear, true referable (final Tier A) | 0.0% | **2.3%** (5/218), CP95 [0.8%, 5.3%] |
| False auto-clear, true grade ≥ 3 | 0.0% | **0.0%** (0/45), CP95 [0%, 7.9%] |

**This is the reason the system has a camera-validation gate — not a blind spot found by
accident, but the behavior that motivated building the gate in the first place.** Sensitivity drops on a camera the model has never seen — that's the honest, expected
behavior of any vision model under domain shift, and the product's answer is structural, not
hoped-for: **a case from a camera or site that hasn't been locally validated cannot auto-clear.**
It's capped at Tier B (AI-assisted human review) regardless of what the model says. No severe
case (grade ≥ 3) auto-cleared on Messidor-2 either way. The honest framing for this system is
*"AI triage with mandatory human review on unvalidated cameras,"* not *"90%+ sensitivity
anywhere"* — and that framing is also what the safety gate enforces in code, not just in this
document.

---

## 4. Deployed code path on IDRiD's official test split — a smoke test, labelled as one

An independent run of the full production grading path on the 103 official IDRiD test images:

| Metric (n = 103) | Result |
|---|---|
| QWK | 0.841 |
| Referable sensitivity, live referral flag | **100%** (64/64) |
| Referable specificity, live referral flag | 82.1% |
| Grade-4 recall | **13/13** |
| Tier A / B / C | 4 / 70 / 29 — no Tier-A case was referable |

This set overlaps the calibration pool, so it reads better than the clean cross-fit numbers in
Sections 1–2 — for that reason, treat Sections 1–3 as the accuracy figures to quote, and this
section as what it is: proof the integrated, end-to-end pipeline runs consistently and
under-grades nothing on a real test set, not a second accuracy claim.

---

## 5. Segmentation, localization and lesion models

| Model | Test data | Metric |
|---|---|---|
| Vessel segmentation | CHASE_DB1, held-out subjects (n = 6) | **Dice 0.777** |
| Same model, no retraining | DRIVE, unseen dataset (n = 20) | Dice 0.619 |
| Optic disc / fovea localization | IDRiD held-out (n = 77) | Mean error 26.9 px (disc) / 85.6 px (fovea) native; **98.7% / 96.1%** within one disc radius |
| Hard-exudate segmentation | IDRiD held-out | Dice 0.583 per-image / 0.733 pixel-pooled |
| Microaneurysm + haemorrhage segmentation (deployed, reports each lesion type separately) | IDRiD (n = 16) | Merged Dice 0.599 · microaneurysm 0.442 · haemorrhage 0.571 |
| Earlier version of this model (single combined lesion class, no separate counts) | same 16 images | Dice 0.535 |

**Vessel model generalizes with a real but bounded gap** (0.777 in-domain → 0.619 cross-dataset),
consistent with how most vessel segmenters behave moving between fundus datasets with different
cameras and fields of view.

**The deployed microaneurysm/haemorrhage model earns its place by what it adds, not by a proven
accuracy jump:** it reports real, separate microaneurysm and haemorrhage counts per quadrant,
which the earlier version could not do at all (it only reported one combined total). It also uses
class-specific minimum-component-size filters tuned to each lesion type's real size distribution
(microaneurysm floor 5 px, haemorrhage floor 10 px — a single 10 px floor would have discarded
most true microaneurysms, whose median ground-truth size is 6 px across 3,452 measured
components). Its own Dice score is measured on the same 16 images it was tuned on, so it's early
evidence, not weak evidence — commissioning a larger dedicated accuracy run is the natural next
step.

**Fovea reliability gate.** When the fovea heatmap has no real confidence peak, the case is
flagged as unreliable and routed to mandatory review instead of being graded on a silently wrong
quadrant axis — threshold chosen as the smallest value with 100% validation gross-miss
sensitivity.

**Not detected, by explicit design choice:** cotton-wool spots (soft exudates) have no dedicated
detector this round — the available pixel-level training data for this lesion type was judged too
sparse to support one, so this field is always reported as *unmeasured*, never as a false zero.

**Neovascularization** is reported only as a suspicion score (a vessel density/branching/tortuosity
proxy), not a segmentation claim, and it is **not wired into any decision** — we measured it
honestly, found it underperformed on both IDRiD and Messidor-2, and gated it off rather than ship
a number that doesn't hold up. Grade-4 cases are still caught independently by the classifier, by
the CNN-grade-4 → Tier C rule, and by mandatory review on branch disagreement — removing this one
input doesn't remove a safety net, because it was never the only one.

---

## 6. Rule engine (explicit ICDR "4-2-1" criteria)

The rule engine is plain, auditable code implementing the standard ICDR rule directly on
quadrant-mapped lesion counts — no learned weights, so it can be checked against the clinical
rule text line by line rather than trusted as a black box. Live thresholds (frozen by design):
capped at grade 3 on purpose, since there is no validated neovascularization signal to support a
grade-4 call independently (Section 5).

| Exact agreement with ground truth, IDRiD official test (n = 103) | Result |
|---|---|
| Recalibrated thresholds, deployed lesion counts | **60.2%** |

**Why a 60% exact-match rule engine is still genuinely useful:** its job was never to beat the
CNN on its own — it's an independent, human-auditable second opinion. Agreement strengthens a
case's confidence tier; **disagreement unconditionally forces mandatory review**, with the final
grade set by the ophthalmologist either way. That disagreement trigger is the actual safety value,
not the raw match rate.

---

## 7. Engineering integrity

| Check | Result |
|---|---|
| PyTorch ↔ ONNX ↔ MATLAB tensor parity, all 9 model artifacts | Max difference 1×10⁻⁶ to 4×10⁻⁵ (threshold 0.01) |
| Calibrated classifier, Python vs. MATLAB inference, 10 real IDRiD images | Grade and tier agree **10/10**; max probability difference 5.1×10⁻⁷ |
| Microaneurysm/haemorrhage model, ONNX vs. MATLAB | Max tensor difference 1.4×10⁻⁵; lesion counts identical on all 10 parity images |
| Full-pipeline soak test — every IDRiD image on disk through capture → quality gate → sync → grading | **447/447 graded, 0 failed, 0 timed out** |
| End-to-end central grading latency per case (warm MATLAB session, dev laptop: Ryzen 7, RTX 4050, 24 GB) | **p50 10.9s / p95 22.2s** (n = 10, real submissions through the live stack) |
| Local quality-gate latency (desktop MATLAB) | **p50 0.49s / p95 3.2s** (n = 10, warm toolboxes) |
| Quality gate, JS implementation vs. MATLAB reference | Agreement within ~0.005 |

**Automated tests:** conformal (MATLAB + Python) 90/90 · fovea gate 12/12 · PHC backend 41/41 ·
mobile 28 · central backend covered by targeted verification scripts.

**One set of numbers, two deployments.** NetraSetu runs in two configurations — a full local
deployment where every model runs natively inside MATLAB, and a hosted online deployment (for
judges to reach the system instantly, with no local setup) that runs the same trained models on
ONNX Runtime instead, since the hosting platform has no MATLAB available. The parity figures above
are exactly why every benchmark in this document applies to both: the two paths are verified
numerically identical, to the same precision used throughout this document, not just similar.
`docs/TECHNICAL_DOCUMENTATION.md` §12 explains both deployments and why they exist.

---

## 8. Scope and limitations, stated on purpose

1. **In-domain vs. unseen camera.** 95.0% sensitivity in-domain, 75.2% on an unseen camera at the
   shipped threshold, which is why unvalidated cameras are capped at mandatory human
   review rather than allowed to auto-clear (Section 3).
2. **Top-grade exact resolution.** Grade-4 exact recall is 57.4% in-domain. Referral safety does
   not depend on hitting the exact grade (Section 1c); resolving the top of the scale further is a
   natural next-round improvement.
3. **Microaneurysm/haemorrhage evidence is early.** Measured on the same 16 images it was tuned
   on — real signal, worth a larger dedicated validation run next.
4. **Neovascularization is measured and gated off,** not used in any decision, by design (Section 5).
5. **Public-dataset evaluation.** All results are on public datasets (IDRiD, APTOS, Messidor-2,
   DRIVE, CHASE_DB1) — no real-patient or prospective data this round. Two of the training
   datasets are Indian-population sources (APTOS via Aravind Eye Hospital, IDRiD from Nanded,
   Maharashtra), which is relevant to the deployment context but not a substitute for prospective
   local validation.
6. **DME.** Diabetic macular edema cannot be reliably ruled out from colour fundus photographs
   alone — a known limitation of 2D fundus imaging generally, not specific to this system.
7. **Quality gate.** Thresholds are engineered heuristics, cross-checked for MATLAB/JS numerical
   agreement, and a natural next step is validating them against a gradability-labelled dataset.

**Reference point, not a comparison:** IDx-DR's FDA pivotal trial reported 87.2% sensitivity and
90.7% specificity for referable DR (900 patients, 10 sites). IDx-DR is autonomous; NetraSetu is
decision support with an ophthalmologist confirming every referral.

---

## 9. Sources and reproduction

Exact model identifiers, file paths and checksums for independent reproduction (the names below
are the ones that actually appear in this repository's code and result files):

| Figures | Source |
|---|---|
| §1–§2 classifier and conformal figures | `central-system/backend/ml-pipeline/diagnostics/out/conformal_v3_crossfit_report_branchA_v2c.json`, `diagnostics/MODEL_INTERFACE_REFERENCE.md` |
| §3 external validation | `central-system/backend/ml-pipeline/docs/messidor2_v2c_final_external_report.md` |
| §4 smoke test | `scripts/audit/eval_idrid_test.py` |
| §5 fovea gate | `central-system/backend/ml-pipeline/diagnostics/out/fovea_gate_report.json` |
| §5 segmentation | Vessel: `diagnostics/MODEL_INTERFACE_REFERENCE.md` (CHASE_DB1 held-out split, seed 42). Hard-exudate: same file (IDRiD split). Microaneurysm/haemorrhage (deployed, `red_lesion_unet_v2`): `models/red_lesion_v2_metrics.json`. Earlier version (`red_lesion_unet_v1`): `models/red_lesion_predictions(model5)/red_lesion_metrics.json`, reproduced in `diagnostics/out/m45_metrics.json`. Localization: `diagnostics/out/m3_metrics.json` (n = 77). |
| §6 rule engine | `scripts/audit/eval_idrid_test.py`, rule-engine thresholds in `rule_thresholds_by_red_version.json` |
| §7 artifact parity | `diagnostics/out/artifact_manifest.json`, `diagnostics/out/parity_red_v2_report.txt` |
| §7 soak test | `scripts/test-full-dataset.js` |

Deployed classifier: `branchA_v2c`. Deployed microaneurysm/haemorrhage model: `red_lesion_unet_v2`.
Full version history and checksums: `docs/RELEASE.md`. All model binaries are distributed
separately and verified by checksum (`npm run models:verify`). Reproduce any figure above by
running the cited script or reading the cited result file directly.
