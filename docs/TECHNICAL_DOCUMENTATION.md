# NetraSetu — Technical Documentation

**PS 26038 — Explainable AI for Diabetic Retinopathy Screening in Rural India**
Team "Game Of Codes": Tanuj (lead, ML), Saad (backend, MATLAB/Simulink), Kankshi, Parth, Vedant

This document explains what the system is, how its parts fit together, and what state each part is actually in today. It reconciles three sources:

- the team's locked design (`docs/system-design-v4.md`);
- the code-verified audit of what in that design is resolved vs. still accurate (`docs/STALE_CLAIMS_AUDIT.md`);
- the final integration-testing pass.

Every ML number here matches `docs/ML_BENCHMARKS.md`, which carries the populations, intervals and caveats. This document explains *why* the system is built the way it is.

---

## 1. The problem, and why the architecture looks the way it does

India has 20,944 ophthalmologists, about 15 per million people (AIIMS Delhi national survey, 2025). Blindness is 1.37× more prevalent in rural areas, and 90% of DR-related vision loss is preventable with timely referral.

The real task isn't "build an AI that detects DR." It is: **let a non-specialist technician at a rural PHC do what only a specialist could do before, and let that specialist trust and act on the AI's output in seconds.** Every architectural choice below traces back to that sentence.

**Edge/cloud split.** Rural PHCs have unreliable internet and modest hardware. Compressing the grading models to run there would sacrifice exactly the accuracy the system is judged on. The only step that genuinely needs to run locally is the image-quality check: the technician needs a retake decision before the patient leaves the chair. So **local does quality gating only; central does all grading.** This applies identically to both front-ends.

**Capture source.** A phone's bare camera cannot produce a usable fundus photograph; that is an optical limitation, not a software one. Both front-ends therefore take images from a dedicated fundus camera. The mobile app imports those images from the gallery, and it also offers a dedicated fundus-lens capture mode (`mobile_lens` preset). Neither front-end calls an external or unversioned inference endpoint.

**Human-in-the-loop, always.** The AI never tells a patient they have a disease. Every "probably has DR" outcome is confirmed by an ophthalmologist before it becomes a message to the patient.

**Two front-ends, one spec.** The desktop web app and the Expo mobile app implement the same technician workflow against the same central API contract. They differ in exactly one respect: how the image gets onto the device.

**No result ever substitutes for a failure.** A network failure, a timeout and a working result must be distinguishable on screen. A failed request surfaces as an error or genuinely queues for retry, never as a fabricated result. Mock data only ever appears behind an explicit, visible "DEMO DATA" banner (`DATA_MODE=mock`).

---

## 2. Actors

| Actor | Touches |
|---|---|
| PHC technician | Either local front-end (desktop or mobile) |
| Patient | Gives verbal consent (timestamped at registration); receives an in-person result and/or SMS |
| Ophthalmologist | Central web app: review queue, case detail, decision controls |
| District health administrator | Central web app: dashboard, system health, referral tracker, resource recommendations |
| ASHA / community health worker | Referral follow-up, assigned via the admin interface |

---

## 3. High-level architecture

```
 PHC Desktop (React+Vite) ─┐        ┌──────────────────────────┐
   + PHC local backend     │        │ Central Backend          │──▶ PostgreSQL
   (SQLite queue,          ├──────▶ │ (Node/Express)           │──▶ Grading pipeline
    MATLAB quality gate)   │ HTTPS  │  - Ingestion API         │    (MATLAB + Python)
                           │ + PHC  │  - Grading orchestrator  │──▶ media/ (AES-256-GCM)
 PHC Mobile (Expo/RN) ─────┘ API key│  - Referral / SMS        │
   (expo-sqlite queue,              │  - Admin analytics       │──▶ Central Web (React+Vite)
    on-device JS quality gate)      │  - Simulink integration  │    ophthalmologist / admin
                                    └──────────────────────────┘
```

**Where MATLAB lives:**

- the desktop quality gate;
- camera-fingerprint calibration;
- segmentation orchestration;
- the rule engine;
- conformal and calibration math;
- explainability and the evidence report;
- the Simulink resource model.

Branch A (the CNN) and all segmentation models are trained in PyTorch, exported to ONNX and imported into MATLAB's Deep Learning Toolbox. Tensor-level parity was verified for all 9 model artifacts, with maximum differences of 1×10⁻⁶ to 4×10⁻⁵.

Python remains on the serving path for preprocessing and the segmentation worker. The preprocessing chain is implemented exactly once, and that implementation both trains and serves the model: an earlier MATLAB reimplementation was removed after it flipped real grades via a residual invisible on synthetic test tensors.

**No Redis:** the grading queue runs in-process in the central backend.

### 3.1 MATLAB and Simulink in this system

**Methodology note.** `matlab.codetools.requiredFilesAndProducts` was attempted on each entry-point function first, per the original instruction. It hung indefinitely (10+ minutes, reproduced twice, once with zero other MATLAB processes running, ruling out license contention) on the very first function analyzed — almost certainly because the live MATLAB path's directory is on-path alongside dozens of ONNX-import-generated custom layer classes (`+red_lesion_unet_v2`, `+red_lesion_unet_v1`, etc.), which appears to make MATLAB's static dependency walker effectively intractable here. It was abandoned as impractical in this environment. **Status below instead comes from direct code tracing** (file:line call chains, confirmed against this session's own live runs and `central.log` output) — a different method than instructed, stated plainly rather than silently substituted.

| Component | MATLAB product(s) | Where it runs | Status |
|---|---|---|---|
| Local quality gate | Image Processing Toolbox; MATLAB Compiler (standalone tier) | PHC desktop | **Live** (`quality-gate-matlab/qualityGateMain.m`, run via `matlab -batch`, default engine). **Compiled tier built** (2026-10-02): `quality-gate-matlab/dist/qualityGate.exe`, committed, runs on the free MATLAB Runtime. Verified from an isolated folder away from the source tree (`testQualityGateDeploy`, 23/23); ships in the standalone PHC (§4.4, §12.3). |
| Branch A classifier inference (ONNX import) | Deep Learning Toolbox | Central | **Live** (`gradingOrchestrator.js:187` defaults `INFERENCE_BACKEND=matlab`, no `.env` override; `branchAInferMatlab.m` via the persistent MATLAB session). |
| Segmentation / localization inference | Deep Learning Toolbox | Central | **Live** for all four models (`runMatlabInferenceSession.m`: generic `predict()` on `vessel_unet_v1`, `localization_v1`, `bright_lesion_unet_v1`, and — wired in this same integration pass — `red_lesion_unet_v2`; see this doc's §6.6 and the commit "Wire red_lesion_unet_v2 into MATLAB serving"). |
| Rule engine (ICDR 4-2-1) | MATLAB (base, no toolbox) | Central | **Live** (`ml-pipeline/grading/ruleEngineGrade.m`, called from `runCasePipeline.m` every graded case; confirmed it both skips quadrant logic and is gated by `foveaUnreliable`). |
| Conformal prediction / calibration math | MATLAB (base; Statistics and Machine Learning Toolbox usage not independently confirmed — see methodology note) | Central | **Live** (`ml-pipeline/calibration/conformalTiering.m`, feeds the real tier decision in `gradingOrchestrator.js`; 90/90 automated tests pass, per `ML_BENCHMARKS.md` §7). |
| Grad-CAM + lesion-attention consistency | Deep Learning Toolbox | Central | **Live**, both halves. `lesionAttentionConsistency.m` runs inside `runCasePipeline.m` for every case and is written to `explainability_outputs` every time, not only in an offline script. |
| Camera-fingerprint calibration | Image Processing Toolbox | Central | **Live** (`ml-pipeline/cameraCalibration/classifyCameraFamily.m`). Its output reaches the tier decision through the camera-probation/mismatch path (`gradingOrchestrator.js`), not a separate direct channel — still a real, live effect on routing, not dead code. |
| Evidence-report PDF | MATLAB Report Generator (core-MATLAB fallback renderer) | Central | **Live** (`ml-pipeline/explainability/generateReport.m`, generated on demand via `services/caseReport.js`'s `getOrCreateReport()` — exercised directly earlier in this integration pass). Whether the live machine actually has MATLAB Report Generator installed (vs. running the fallback renderer via `ensureReportGeneratorOnPath.m`) was not independently re-checked this pass. |
| District resource model | Simulink + SimEvents | Central (scheduled) | **Built, not on the live path by default.** `netraSetuPipeline.slx` exists and runs to completion when invoked. But (a) the scheduled weekly cross-validation job is currently **disabled** — confirmed directly from this session's own backend startup log: `[simulinkValidation] disabled (SIMULINK_VALIDATION_ENABLED)`; (b) even when enabled, its role is a periodic cross-validation check against a separate function, `referenceQueueingModel.m` — which is what actually generates the Resource Recommendations screen's live data (`services/resourceRecommendations.js`'s own header comment: *"the .slx stays the PS deliverable and the validation check, not something run per refresh"*). See §7 for the corrected description. |
| District resource model as a standalone app | **Simulink Compiler** + MATLAB Compiler | Any Windows PC (free MATLAB Runtime) | **Built** (2026-10-03): `simulink-model/deployable/dist/NetraSetuResourceModel.exe`, committed. SimEvents blocks cannot generate code, so the app runs `districtResourceModel.slx`, a code-generation-capable model that reproduces `referenceQueueingModel.m` exactly. See §7.1. |

---

## 4. Local PHC application (both front-ends)

### 4.1 Screens

| Screen | What it does |
|---|---|
| Patient Registration | New-patient form. Fuzzy duplicate check by name/age/phone before an ID is minted. Timestamped verbal-consent checkbox. **Patient symptom/risk questionnaire** (diabetes duration, glycemic control, BP, pregnancy, symptoms; tap-only, no skip) |
| Capture | Desktop: camera trigger / import. Mobile: gallery import or fundus-lens mode. Tags left/right eye before anything else |
| Quality Result | Pass / borderline / fail with a specific reason (blur, dark, field of view, glare, motion, eyelash occlusion, …). A real quality score when one exists, "not available" when it doesn't, never a fabricated number. The engine that ran is shown |
| Capture Metadata Questionnaire | Device, pupil status, lighting, observed issues. Tap-only, under 45 seconds, runs after the quality gate |
| Local Queue | Captured → Quality-Passed → Synced → Result-Pending → Result-Delivered, with a storage-pressure indicator |
| Sync Status | Online/offline indicator and pending count. "Synced" means central actually accepted the case (HTTP 201), never merely that a request returned |

**Final flow on both apps:** registration + patient questionnaire → capture → quality gate → capture-metadata questionnaire → queue → sync.

### 4.2 Local backend

| Service | Responsibility |
|---|---|
| Quality-Gate Engine | **Desktop**, tried in this order (`services/qualityGateClient.js`), each result stamped with its engine: <ol><li>the **compiled `qualityGate.exe`** on the free MATLAB Runtime, when `QUALITY_GATE_EXE` is set (built and committed 2026-10-02);</li><li>**MATLAB** via `matlab -batch`;</li><li>the **JS port** (`services/qualityGateFallback.js`), only when MATLAB cannot launch **and** `QUALITY_GATE_ALLOW_FALLBACK=1`. Rewritten 2026-10-02 as a step-by-step port of the MATLAB gate and re-enabled after 0 mismatches against MATLAB on 6 + 52 images (engine `js-fallback`);</li><li>otherwise HTTP 503 `quality_gate_failed`: the image is kept and no verdict is invented.</li></ol>**Mobile:** its own on-device TypeScript port (engine `js-device`), with its own parity test against MATLAB |
| Local API | Wraps capture + quality gate and reads/writes the local database |
| Sync Manager | Prioritizes by urgency tier, then age. Sends a lightweight case-summary packet ahead of the full image on thin connectivity. Uploads full images in resumable chunks with hash verification. Every submission carries the local `capture_id` as an idempotency key, so a retry never creates a duplicate case |

### 4.3 What differs on mobile, and only this

- **Local persistence:** a real embedded database (`expo-sqlite`, per-record), not a serialized blob.
- **Identity:** the exact same collision-safe ID scheme as desktop (PHC code + timestamp + random suffix).
- **Questionnaires:** both apply in full.
- **Login:** the mobile app authenticates against the paired PHC PC's technician accounts over an encrypted peer channel, with an honest offline-cache fallback.

### 4.4 Standalone PHC (downloadable, no MATLAB licence)

A complete PHC station packaged as a Windows zip (`NetraSetu-PHC-standalone.zip`, distributed outside git). It
contains:

- the PHC backend and the built web app;
- a bundled Node runtime;
- the **compiled quality gate** (`qualityGate.exe`), which needs only the free MATLAB Runtime R2026a;
- `Start-PHC.cmd`, `Add-Technician.cmd`, `Check-Setup.cmd`;
- one `settings.env` for site identity (`PHC_CODE`, `CENTRAL_API_URL`, `PHC_ID`, `PHC_API_KEY`).

Patient data is kept in `data\`, separate from the program, so replacing the program keeps the data.

It was tested end to end against a local central (2026-10-02): registration, capture, compiled gate, sync, MATLAB
grading at central, and "RESULT READY" back at the station. Restarts, install paths containing spaces, offline
capture and enforced login were also checked.

**Not yet tested:** a PC that has only the MATLAB Runtime installed and no MATLAB.

---

## 5. Central system

### 5.1 Ophthalmologist interface

| Screen | Components |
|---|---|
| Review Queue | Sorted so the least-confident cases surface first, not the most severe. Shows patient ref, eye, PHC, capture time, both branches' grades, tier and claim status. Auto-refreshes |
| Case Detail | Fundus image with toggleable Grad-CAM overlay. Lesion-evidence panel: microaneurysms, haemorrhages and hard exudates measured, cotton-wool spots shown as unmeasured. Both grading branches side by side with a disagreement flag. Calibrated confidence and conformal tier. Review-duration timer. Engine-provenance details (collapsed by default). Downloadable evidence-report PDF |
| Decision Controls | Opening a case claims it; a second reviewer sees who holds it and can't submit a conflicting decision. Confirm, or Override with a structured reason, optional free text and a corrected grade. **On branch disagreement, Confirm is not available**: the reviewer must pick an explicit final grade |
| Case History | Per-patient, per-eye longitudinal view |

### 5.2 District admin interface

| Screen | Components |
|---|---|
| Dashboard | Cases today/week/total, average review time, override rate, average confidence, cases by PHC |
| PHC Health (includes System Health) | Every PHC with last sync time, 24-hour volume, pending/failed count, and active/silent status. On the same screen, the consolidated system-health view (`GET /api/v1/admin/system-health`): silent PHCs (one definition and threshold everywhere), stuck grading jobs, MATLAB session health, and referable cases unreviewed past a threshold. There is no separate System Health route; the case status banner uses the same data |
| Referral Tracker | referred → contacted → attended / lost. Assigned-worker field. Automatic manual-follow-up state when SMS delivery fails |
| Resource Recommendations | Staffing/routing guidance from the Simulink resource model |

### 5.3 Central backend services

- Ingestion API (dedup on `capture_id`)
- Grading Pipeline Orchestrator (preprocessing → camera calibration → segmentation → dual-branch grading → confidence routing → rationale)
- Referral & Notification Service (Twilio SMS, manual follow-up on failure)
- Admin Analytics Aggregator
- Simulink Integration
- Grading Job Watchdog
- MATLAB Session Supervisor (auto-restart, health reporting)
- Auth Service
- Audit Logging
- Site & Camera Probation Tracking

### 5.4 Database

PostgreSQL with migration tooling (`node-pg-migrate`). Core tables:

- `patients`, `cases`;
- `grading_results`: both grades, agreement flag, confidence, uncertainty, conformal tier, claim state;
- `segmentation_outputs`: lesion counts per category, NV score recorded for research only, fovea-reliability flag;
- `explainability_outputs`: Grad-CAM path, report path, engine provenance;
- `ophthalmologist_reviews`, `referrals`, `phc_sites`, `users`, `access_log`.

### 5.5 API contract

One contract, `docs/api-contracts.md`, consumed identically by both front-ends. Core endpoints:

- `POST /api/v1/cases` (idempotent on `capture_id`);
- `POST /api/v1/cases/summary`;
- chunked upload endpoints;
- `GET /api/v1/ophthalmologist/queue`;
- `POST /api/v1/cases/:id/review`;
- `GET /api/v1/phc/cases/:captureRef/report`;
- `GET /api/v1/admin/*` (dashboard, system health, PHCs, referrals);
- `POST /api/v1/auth/*`.

---

## 6. ML pipeline

### 6.1 Image quality assessment (local)

Classical computer vision in `quality-gate-matlab/qualityGateMain.m` and its four `assess*.m` helpers, with
per-camera presets in `cameraPresets.json` (`default`, `mobile_lens`).

**Seven scores:**

| Score | How it is computed |
|---|---|
| focus | Laplacian variance |
| illumination | Mean grey distance from 100 |
| field of view, coverage | Largest filled bright region |
| glare | Saturated centre pixels |
| motion | Horizontal vs vertical gradient variance |
| occlusion | Dark pixels inside the retinal disc's convex hull |

**Decision order:** insufficient FOV → glare → motion → low illumination → blur → eyelash occlusion. If none of these
fires, the image is **borderline** when the mean of focus, illumination and FOV is below 0.7, otherwise **pass**.

**The same gate runs in four forms:**

- **MATLAB**, the reference;
- the **compiled exe**, which reproduces every MATLAB sub-score to 1e-9;
- the **desktop JS port**, rewritten 2026-10-02 as a step-by-step port (exact `rgb2gray` weights, N−1 variance,
  MATLAB's `imclose` border semantics, `bwconvhull` built from pixel-edge midpoints, the same presets). Against
  MATLAB it had 0 mismatches on 58 images, every decision identical, and a worst score gap of 3.3e-4;
- the **mobile TypeScript port**.

The thresholds are engineered heuristics and have not been validated against a gradability-labelled dataset (§10).

### 6.2 Preprocessing (central)

**Ben Graham preprocessing only:** circular retinal crop → resize → Gaussian-subtraction contrast
(`4·img − 4·blur + 128`). It is implemented exactly once (`preprocessing/ben_graham.py`) and imported by both
training and serving (see §3 for why).

CLAHE is **not** part of the serving chain. Adding a CLAHE stage that training never used dropped agreement with the
model's own outputs from 100% to 57.7% (`inference/branchAInfer.py` header). `clahe_enhance.py` remains in the repo
only as an experiment.

### 6.3 Camera-fingerprint calibration (central)

Identifies the capture device family from vignetting, aspect ratio and colour-channel gains, cross-checked against the technician-reported device. A mismatch, or an unvalidated camera family, feeds confidence routing as a reason for human review, not as a pixel-level correction.

### 6.4 Optic disc / fovea localization (central)

A U-Net heatmap regressor with 16 px (disc) / 32 px (fovea) mean error at native resolution on IDRiD. The fovea heatmap occasionally has no real peak, which would silently rotate the quadrant axis the rule engine relies on. A peak-confidence gate (threshold 0.37, raw heatmap units) marks such cases `foveaUnreliable`: the rule engine then skips quadrant-dependent logic, and the case is forced to at least Tier B.

### 6.5 Vessel segmentation (central)

A U-Net trained on CHASE_DB1 (Dice 0.777 held out), complemented by a Frangi vesselness filter. There is a real cross-dataset gap (Dice 0.619 on DRIVE). The live threshold is a fixed 0.5; the designed per-domain threshold was not implemented.

### 6.6 Lesion segmentation (central)

- **Red lesions:** the deployed model is **v2**, a 3-class U-Net (background / microaneurysm / haemorrhage) with class-specific minimum-area filters (MA 5 px, haemorrhage 10 px). It reports real, separate counts per quadrant. Dice is 0.599 merged (MA 0.442, haemorrhage 0.571) on 16 validation images; that is thin evidence, and it does not prove a gain over v1 (0.535).
- **Hard exudates:** Dice 0.583 per image / 0.733 global on IDRiD.
- **Cotton-wool spots:** an explicit scope exclusion (data too sparse), always reported as unmeasured, never as a false zero.
- **Neovascularization:** a suspicion score was built and tested. It **failed validation** (AUC 0.29 IDRiD, 0.38 Messidor-2, both below chance), so it influences no decision.

**Standing rule:** the lesion size filters and the rule engine's thresholds are one jointly calibrated unit. Changing one without recalibrating the other silently rescales what the thresholds mean.

### 6.7 DR severity classification — two independent branches (central)

**Branch A (CNN).** Deployed model: `branchA_v2c`, EfficientNet-B0 at 512×512, with an ordinal-aware loss and class weighting. It was trained on APTOS 2019 + IDRiD, plus an EyePACS subset in the 5-class loss and photometric domain augmentation.

On the 628-image held-out test set:

| Metric | Result |
|---|---|
| QWK | 0.884 |
| Referable sensitivity / specificity (argmax) | 92.7% / 92.4% |
| Grade-4 recall | 57.4% (31/54) |

**The live referral decision** uses a calibrated threshold on P(grade ≥ 2), set at 0.3873, not the argmax grade. By 50-fold cross-fit (n = 1,161), sensitivity is 95.0% and specificity 91.0% in-domain.

**Model choice.** v2c was chosen over our own promotion rule's pick (v2b) because its auto-clear tier is far more stable on an unseen camera. This deviation is disclosed in `ML_BENCHMARKS.md` §1d.

**Branch B (rule engine).** Plain, testable code implementing the ICDR "4-2-1" rule on quadrant-mapped lesion counts, auditable line by line against the clinical text. Its frozen thresholds are `RED_FLOOR=3`, `GRADE3_QUAD_MIN=3` and `RULE_MAX_GRADE=3`. It is deliberately capped at grade 3, since no validated neovascularization signal exists. Exact agreement with ground truth is 60.2% on IDRiD's official test split (n = 103).

**Fusion.** Agreement supports the tier. Disagreement unconditionally forces mandatory review with an explicit resolution. Branch B's value is being an independent, auditable second opinion and a disagreement tripwire, not standalone accuracy.

### 6.8 Confidence routing (central)

One decision per case combines:

- temperature-scaled confidence;
- referable-stratified conformal prediction (v3);
- branch agreement;
- camera validation / probation status;
- quality flags, including `foveaUnreliable`.

| Tier | Meaning | Consequence |
|---|---|---|
| A — auto-clear | Singleton conformal set, high confidence, branch agreement, validated camera, no quality flag | Skips the ophthalmologist queue |
| B — AI-assisted review | Narrow conformal interval, or an unvalidated camera | Full rationale report; target review under 30 s |
| C — full manual review | Wide interval, branch disagreement, CNN grade-4, probation, or quality flag | No shortcuts |

**In-domain safety** (cross-fit, n = 1,161): **0% false auto-clears** of referable and of grade ≥ 3 cases, and **zero grade-4 cases auto-cleared** across 1,000 fold assignments.

**On an unseen camera** (Messidor-2, n = 872): the referable false-auto-clear rate rises to 2.3% (upper bound 5.3%), and sensitivity at the shipped threshold is 75.2%. **This is why unvalidated cameras cannot auto-clear.**

Two coded safety clauses are structurally subsumed by the calibrated threshold today, so they are not presented as active safety layers:

- "P(grade 3) + P(grade 4) > 0.5 ⇒ referable";
- "referable threshold demotes Tier A."

### 6.9 Explainability (central)

Grad-CAM on the classifier's final convolutional layer, restricted to the retinal region, with a lesion-attention consistency score that checks the heatmap against the segmentation masks. It is assembled together with the lesion evidence and the rule-engine criteria that fired into one rationale and a downloadable evidence-report PDF.

The Grad-CAM image is the model's own cropped working image, not the original capture, and the UI captions this.

### 6.10 Symptom + risk questionnaire — queue-ordering hint, not a confidence adjustment (central)

**Correction: no confidence-fusion step exists.** The questionnaire (diabetes duration, glycemic control, BP, symptoms) does not adjust the classifier's confidence or grade in any way — grep of the whole grading orchestrator and ML pipeline found no such fusion code. What does exist is `calculateUrgencyScore.m`: a synthetic-data-trained, explicitly-documented **queue-ordering hint only**, used to help sequence which cases a reviewer sees first. `runCasePipeline.m` otherwise only passes the questionnaire through for display text on the case report. The questionnaire never overrides or adjusts the image-based grade — that part of the original claim holds; the "adjusts confidence" mechanism itself does not exist.

### 6.11 Continual learning (central)

Ophthalmologist overrides and their structured reasons are captured in the same transaction as the review. They are exportable with consent enforcement and deduplication (`scripts/exportTrainingSet.js`). Scheduled fine-tuning, the validation gate and promotion are **not implemented this round**: corrections are captured and exportable, and retraining is a manual, future step.

---

## 7. Systems layer — Simulink resource model

A discrete-event simulation built in SimEvents.

- **Entities:** patient images.
- **Arrivals:** each PHC's acquisition rate.
- **Network:** a bandwidth-constrained queue across good / poor / very-poor connectivity tiers.
- **Review:** ophthalmologist review as a limited-capacity server (~30 s for Tier B, several minutes for Tier C, with Tier C pre-empting Tier B).
- **Outputs:** queue length over time, average wait and bottleneck location.

**What actually feeds the Resource Recommendations screen.** The screen's live data comes from `referenceQueueingModel.m` — a separate, pure-MATLAB queueing model, not a per-refresh run of the `.slx` file (`services/resourceRecommendations.js`, its own header comment: *"the .slx stays the PS deliverable and the validation check, not something run per refresh"*). The SimEvents model (`netraSetuPipeline.slx`) is real, runs to completion, and serves as a periodic cross-validation check against `referenceQueueingModel.m`'s output — it does not itself generate what the screen displays.

Bandwidth and timing parameters are modeled assumptions, not measured field data.

### 7.1 The resource model as a standalone app (Simulink Compiler)

The district resource model is packaged with **Simulink Compiler** as `NetraSetuResourceModel.exe`
(`simulink-model/deployable/`). It runs on any Windows PC with the free MATLAB Runtime R2026a and needs no MATLAB or
Simulink licence.

**What it does:**

- **Inputs:** you set patients per year, PHCs, ophthalmologists, tier mix, review times, bandwidth and days.
- **Results:** KPIs (utilisation, mean and p95 review wait, end-to-end time), the bottleneck with a plain-language
  recommendation, and queue and utilisation curves over time.
- **Minimum ophthalmologists:** it searches for the smallest team that holds the p95 review wait under 60 minutes,
  for routine and camp-mode schedules.
- **Headless mode:** `--json` takes parameters in and writes results out, for use from the backend.

**Why it runs a different model.** Simulink Compiler deploys through Rapid Accelerator, which needs C code from every
block, and SimEvents blocks do not support code generation (`SimulinkEventEngine:Engine:CodeGenNotSupported`,
verified 2026-10-03). So the app simulates `districtResourceModel.slx`: a clock-driven, code-generation-capable MATLAB
System block (`DistrictScreeningEngine.m`) that implements `referenceQueueingModel.m`'s algorithm, including Tier C
pre-empting Tier B with resume. It draws its random inputs in the reference model's order, so for the same parameters
and seed it reproduces the reference **exactly**. Every parameter is tunable at runtime, with no rebuild.

**Verification** (`validateDeployableResourceModel`):

| Mode | Result |
|---|---|
| Normal simulation | 5/5 scenarios exact (≤ 1e-14 relative) |
| Rapid Accelerator deployment mode | 5/5 scenarios exact |
| The compiled exe | 5/5 scenarios exact, same bottleneck verdicts |

The SimEvents `.slx` remains the PS deliverable and the weekly validation model.

---

## 8. Resilience and edge-case handling

- **Extended outages:** urgency-then-age sync ordering and PHC last-contact time feeding System Health apply to both front-ends. Summary packets ahead of the full image and a storage-pressure warning are built on **mobile only** (`netrasetu/sync/syncManager.ts`, `netrasetu/lib/storage.ts`) — the desktop app posts the full multipart body directly (with chunked upload for large images), with no summary-packet or storage-pressure code path. A manual export-to-drive fallback is **not built** on either front-end (`phc-local-app/mobile/README.md`: "Not built yet: export-queue-to-drive").
- **Ungradable images:** after a fixed number of failed retakes, the technician can mark a capture "best effort — ungradable." The flag is sent to and stored by central, but central does not yet read it to force Tier C — that routing effect is a stated follow-up, not current behavior.
- **Duplicate patients:** fuzzy matching at registration; the technician confirms or merges.
- **Per-eye capture:** one visit can produce two independently graded cases.
- **Failed patient contact:** an undeliverable SMS flips the referral to manual follow-up.
- **Collision-safe identity:** PHC code + timestamp + random suffix, with `capture_id` as an idempotency key enforced by a uniqueness constraint.
- **Active monitoring:** silent PHC, stuck job, dead MATLAB session and stale referable case are treated as one failure class, surfaced on one screen.
- **MATLAB session supervision:** the session auto-restarts, and health is reported per component (database, queue, MATLAB, Python, segmentation worker). A case that fails while MATLAB is down is currently marked failed and must be resubmitted; automatic re-queue on recovery is not implemented.
- **Concurrent review:** opening a case claims it.
- **Disagreement:** Confirm is never available when the branches disagree.

---

## 9. Security (current state)

Verified against the running system in the integration pass:

- **Central:** authentication is enabled.
  - Passwords are hashed with bcryptjs; a wrong password gets a genuine 401.
  - The session is a signed JWT (HS256) in an **httpOnly** cookie, 12 h by default, `Secure` (`services/authConfig.js`, `services/authTokens.js`).
  - Role-based access control is enforced server-side on every endpoint, including media: 401 without a session, 403 for the wrong role. The UI routes enforce the same roles.
- **PHC ingestion:** a per-PHC API key is required on every central ingestion call. Only its hash is stored. Keys are provisioned via CLI, shown once, and never returned by any API.
- **PHC desktop:** technician accounts hashed with **scrypt** (`phc-local-app/backend/services/passwords.js`), provisioned via CLI. Login is on by default, because the PHC backend listens on the clinic LAN for phone pairing. The mobile app authenticates against the paired PHC PC over a sealed peer channel.
- **Encryption at rest (central):** AES-256-GCM for stored images, Grad-CAM overlays and report PDFs (`MEDIA_ENCRYPTION_KEY`).
- **Encryption in transit:** TLS is supported by both backends, and provided by the reverse proxy in deployment (§12).
- **Audit logging:** every access to patient data is recorded in `access_log`.

**Stated gaps.** This is a prototype-stage security floor, not a production compliance claim:

- The PHC-side local stores (desktop SQLite and mobile database/photos) are **not encrypted** this round.
- There are no refresh tokens, no rate limiting and no formal secret rotation.
- No penetration test or security audit has been performed.

---

## 10. Honest limitations (stated on purpose)

1. **Decision support, not diagnosis.** This is a screening decision-support system, not an autonomous diagnostic. Every positive is confirmed by an ophthalmologist.
2. **Domain shift.** Sensitivity is 95.0% in-domain but 75.2% on an unseen camera at the shipped threshold. Local recalibration does not close v2c's gap, because ranking quality is the limit, so unvalidated cameras are always routed to human review.
3. **Top-grade resolution.** Exact grade-4 recall is 57.4% in-domain. It is made safe by threshold-based referral and CNN-grade-4 → Tier C routing, not by the recall itself.
4. **MATLAB licensing.** Central inference still needs a MATLAB licence on the serving machine; packaging it with MATLAB Compiler is not done (trial targets only, `ml-pipeline/deploy/`). The PHC side no longer needs one: the quality gate is compiled (`qualityGate.exe`, free MATLAB Runtime) and ships in the standalone PHC (§4.4). The district resource model also ships as a Simulink Compiler app (§7.1).
5. **Thin red-lesion evidence.** Red-lesion v2 was evaluated on 16 images, the same ones it was tuned on.
6. **Neovascularization and uncovered lesion types.** Neovascularization failed validation and is not used. Cotton-wool spots, venous beading and IRMA are not detected.
7. **Rule engine accuracy.** Exact agreement is 60.2% (n = 103).
8. **Vessel threshold.** There is a cross-dataset gap, and the fixed 0.5 threshold is not domain-adaptive.
9. **In-memory grading queue.** Failed-while-MATLAB-down cases are not auto-re-queued.
10. **Partial test coverage.**
    - conformal: 90/90;
    - fovea gate: 12/12;
    - PHC backend: 41;
    - mobile: 28;
    - central backend: no automated suite.
11. **Simulink parameters** are modeled assumptions, not field data.
12. **DME.** Diabetic macular edema cannot be reliably ruled out from colour fundus photographs alone.
13. **No clinical data.** No real-patient or prospective clinical data has been used.
14. **No subgroup analysis.** No subgroup (demographic) analysis has been done: the public datasets don't carry the needed fields.
15. **Quality gate unvalidated against labels.** The quality gate's thresholds are engineered heuristics, not validated against a gradability-labelled dataset.

---

## 11. Datasets

| Dataset | Size | Used for |
|---|---|---|
| APTOS 2019 (Aravind Eye Hospital, India) | 3,662 images, 5-class grade | Classifier training and held-out test |
| IDRiD (Nanded, Maharashtra, India) | 516 grading · 81 segmentation · 516 localization | Classifier training and test, lesion and localization models, rule-engine calibration, official test-split evaluation |
| EyePACS | Curated subset (10k–24k of 35,126, quality-filtered) | v2c classifier training (5-class loss, weight 0.5) |
| CHASE_DB1 | 28 images | Vessel segmentation training / held-out evaluation |
| DRIVE | 20 test images | Vessel cross-dataset evaluation only |
| Messidor-2 | 1,744 gradable images, 874 patients | External validation only; never used for training, calibration or thresholds |

Only public research datasets are used anywhere in this system, and no real patient data. Two of the core training datasets, APTOS and IDRiD, come from Indian populations and clinics, which is directly relevant to the deployment target. The external test, Messidor-2 (France), deliberately comes from a different population and camera.

---

## 12. Deployment

### 12.1 Target production deployment (the plan)

| Component | Where it runs | How |
|---|---|---|
| PHC desktop app + PHC local backend | On-site at each PHC, on the technician's PC | Installed locally, fully offline-capable. SQLite queue, MATLAB-compiled quality gate on the free MATLAB Runtime (no license needed) |
| Mobile app | Technician's Android phone | Installed APK. On-device JS quality gate, `expo-sqlite` queue |
| Central backend + grading pipeline | A district/state-hosted Linux server or VM | Docker Compose behind a TLS reverse proxy. MATLAB inference packaged with MATLAB Compiler and run on the free MATLAB Runtime, removing the license dependency. Python worker for preprocessing and segmentation. PostgreSQL with nightly backups |
| Central web (ophthalmologist / admin) | Static hosting | Same-origin with the API (reverse proxy or host rewrites), so the session cookie and image access work without cross-site exceptions |

**Why this shape.** Grading needs the full-capacity models and a single calibrated environment, so it stays central. Offline capture and quality gating are what a rural PHC actually needs locally.

### 12.2 Current deployment (online submission demo)

Defined in `render.yaml` (Render, free tier, Singapore) plus two Vercel projects. Status checked 2026-10-02/03.

| Component | Hosted on | Link | Status |
|---|---|---|---|
| Central web (ophthalmologist / admin) | Vercel | https://centralsys.vercel.app | Live; built from current `main`; real data (`VITE_DATA_MODE=live`) |
| PHC web (hosted demo station) | Vercel | https://phcapp.vercel.app | Live; built from current `main`; real data |
| Central backend (API) | Render (Docker) | https://netrasetu-central.onrender.com/health | Live. Migrations, demo users and the demo PHC are provisioned at container start |
| Database | Render PostgreSQL (free) | — | Live |
| PHC backend | Render (Docker) | https://netrasetu-phc.onrender.com/health | Live. Its capture fix (JS quality gate re-enabled, `87f50ef` + `d540e9e`) is on `main` and **waits for a manual Render redeploy**; until then captures return 503 |
| ML inference | Render (Docker), `ml-inference-service/` | https://netrasetu-ml-inference.onrender.com/health | Live. Branch A and segmentation on **ONNX Runtime**, with Grad-CAM and MC-dropout computed in closed form, so it fits 512 MB |
| Mobile app | APK | — | Not published yet; EAS build config is in `phc-local-app/mobile/eas.json` |

**Live grading of new uploads is not verified.** The hosted central has no MATLAB, and `MATLAB_ALLOW_FALLBACK` is
deliberately left unset. From the code, a newly submitted case is therefore expected to stop at the rule-engine step
(`runCasePipeline`) instead of being graded by a substitute engine. Cases graded on the full local system are
unaffected.

**What a judge can do:** log in to the central web with the demo ophthalmologist or admin credentials (handed over
separately, never in the repo), and use the review queue, case detail, referral tracker, PHC health and resource
recommendations. The PHC web supports the technician workflow; captures need the PHC redeploy above.

**What differs from production (§12.1):**

- No MATLAB anywhere in the hosted demo. Central calls ML over HTTP (`INFERENCE_BACKEND=remote`), and the PHC uses
  the JS quality gate.
- Storage is ephemeral (the PHC SQLite file, central media files).
- Free-tier services sleep when idle; the first request after a sleep takes about 20–45 s.
- The session cookie is cross-site (`COOKIE_SAMESITE=none`), because the web apps and APIs are on different domains.
- Demo data is public-dataset images only.

### 12.3 Downloadable components

| Component | Where | Needs |
|---|---|---|
| Standalone PHC (§4.4) | `NetraSetu-PHC-standalone.zip` (outside git) | Windows + free MATLAB Runtime R2026a; a `PHC_ID` / `PHC_API_KEY` issued by central (PHC002's is pending) |
| District resource model app (§7.1) | `simulink-model/deployable/dist/NetraSetuResourceModel.exe` (in the repo) | Windows + free MATLAB Runtime R2026a with the Simulink Compiler add-on |
| Compiled quality gate | `phc-local-app/backend/quality-gate-matlab/dist/qualityGate.exe` (in the repo) | free MATLAB Runtime R2026a |
