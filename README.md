# NetraSetu — Explainable AI for Diabetic Retinopathy Screening in Rural India

**Smart India Hackathon 2026 — PS 26038** · Team "Game Of Codes"
Tanuj (team lead; ML layer, mobile app, integration), Saad (backend, database), Krrish (lead frontend developer), Parth (frontend, presentations), Vedant (frontend, presentations), Kankshi (backend and ML layer support)

NetraSetu lets a minimally trained technician at a rural Primary Health Centre (PHC) screen a
patient for diabetic retinopathy (DR) in minutes. Two independent AI branches cross-check every
image, every result is explained — not just scored — and a remote ophthalmologist confirms every
positive before it reaches the patient.

India has only 20,944 ophthalmologists, about 15 per million people (AIIMS Delhi national survey,
2025), and blindness is 1.37× more prevalent in rural India than in urban areas (National
Blindness & Visual Impairment Survey 2015–19). Yet 90% of DR-related vision loss is preventable
with timely referral. The gap is specialist capacity, not awareness. NetraSetu moves the
screening step to the PHC, and turns the specialist's job into confirming flagged cases in
seconds instead of screening everyone.

---

## Live deployment

| What | Link |
|---|---|
| Central web (ophthalmologist / district admin) | https://centralsys.vercel.app |
| PHC technician web (hosted demo station) | https://phcapp.vercel.app |
| Central API | https://netrasetu-central.onrender.com/health |
| PHC local API | https://netrasetu-phc.onrender.com/health |
| Android app (APK, direct install, no Play Store) | [Download](https://expo.dev/artifacts/eas/AXeqZ3jshQkh7qTIsaXkO3nUBWXyqH9XnyRv1di0jYo.apk) |
| Demo video | _to be added_ |
| Google Drive (shareable PDFs: technical documentation, ML benchmarks, MATLAB-application deliverables) | [Open](https://drive.google.com/drive/folders/1e--esRoyi59QNlBE0cQxvH51eg6y62Pv) |

**Demo technician login (hosted PHC station):** username `demo`, password `Fundus-Comet-52` — a
fixed demo-only account, intentionally public for judge access.

This hosted deployment is a **separate configuration from the full local/offline deployment** —
see "Two deployment modes" below and `docs/TECHNICAL_DOCUMENTATION.md` for the full explanation of
why they differ and what each one proves.

---

## Run locally

One command starts the whole system: Postgres, migrations, seed data, both backends, both web
front-ends, and the persistent MATLAB session.

### Prerequisites

| | Version | Notes |
|---|---|---|
| **Node.js** | 18+ (22 LTS tested) | npm comes with it |
| **Docker** | Docker Desktop / Engine with Compose v2 | Runs Postgres only |
| **MATLAB** | R2026a (tested: Update 5) | Required for the default engine (`INFERENCE_BACKEND=matlab`). Core toolboxes: Deep Learning, Image Processing, Statistics and Machine Learning, Medical Imaging. Also used, in offline calibration/experiment/evidence-rendering scripts only (never in the live request path): Computer Vision, Parallel Computing, Global Optimization — see "Standalone MATLAB applications and toolboxes" below for exactly where each one is used. Optional: Simulink + SimEvents (resource model), MATLAB Compiler / Simulink Compiler (standalone executables), MATLAB Report Generator (evidence PDF; a core-MATLAB fallback renderer exists). `matlab` must be on `PATH`, or set `MATLAB_EXECUTABLE` |
| **Python** | 3.11 (conda env `dr_screening`) | Preprocessing and the segmentation worker: `pip install -r central-system/backend/ml-pipeline/requirements.txt`. If a bare `python` isn't on your `PATH` (it silently defaults to that), set `PYTHON_EXECUTABLE` in `central-system/backend/.env` to this env's `python.exe` directly |

There is no Redis: the grading queue runs in-process in the central backend.

### Model weights (required, not in git)

Trained weights (~1.5 GB) are git-ignored and distributed separately. Their SHA-256 checksums are
tracked in git, so a fresh clone can verify it has the exact bytes the benchmarks were measured
with:

```bash
npm run models:verify                              # check what's already on disk
node scripts/fetch-models.js --url <archive-link>   # or: download + extract + verify in one step
```

Served versions and checksums are in `docs/RELEASE.md`.

### Start

```bash
git clone <repo> && cd <repo>
npm run dev:all              # or: scripts/dev-up.sh   |   .\scripts\dev-up.ps1  (Windows)
```

On first run this copies every `.env.example` to `.env`, installs dependencies, starts Postgres
in Docker, applies migrations, seeds two demo users and two PHC sites (printing their passwords
and API keys once), then starts every service and waits for health checks:

| Service | URL |
|---|---|
| PHC web (technician) | http://localhost:5173 |
| Central web (ophthalmologist / district admin) | http://localhost:5174 |
| Central API | http://localhost:5000 (`/health`) |
| PHC local API | http://localhost:4000 (`/health`) |
| Postgres | `localhost:5433`, user `netrasetu`, db `dr_screening_central` |

Ctrl+C stops the four services; Postgres and the MATLAB session keep running
(`npm run db:down` stops Postgres). `npm run dev:check` runs the same sequence and exits non-zero
if anything is unhealthy.

**For a fully populated, demo-ready state:** `node scripts/demo-reset.js` pushes real
public-dataset cases through the real pipeline. See `docs/DEMO_RUNBOOK.md` for the scene-by-scene
walkthrough. Lost the printed credentials? `node scripts/seed-demo.js --force --write-phc-env`
issues new ones.

### Running a service on its own

```bash
npm run db:up && npm run db:migrate && npm run db:seed    # database only
cd central-system/backend  && npm start                    # :5000
cd phc-local-app/backend   && npm start                    # :4000
cd central-system/frontend && npm run dev                  # :5174
cd phc-local-app/frontend  && npm run dev                  # :5173
cd phc-local-app/mobile    && npx expo start                # Expo Go, same LAN as the backends
```

---

## Headline ML results

Full numbers, populations, intervals, reproduction paths and caveats:
**[`docs/ML_BENCHMARKS.md`](docs/ML_BENCHMARKS.md)**. Everything below is measured on real data by
code already in this repository — nothing projected or estimated.

**DR severity classifier (deployed model: EfficientNet-B0 @ 512×512, ordinal-aware loss):**

| Metric | Population | Result | SIH target |
|---|---|---|---|
| Quadratic-weighted kappa | Held-out test, n = 628 | **0.884** | — |
| Referable-DR sensitivity, argmax grade | Held-out test, n = 628 | 92.7% | > 90% ✅ |
| Referable-DR specificity, argmax grade | Held-out test, n = 628 | 92.4% | > 85% ✅ |
| Referable-DR sensitivity, live referral threshold | 50-fold cross-fit, n = 1,161 | **95.0%** [92.8, 96.6] | > 90% ✅ |
| Referable-DR specificity, live referral threshold | 50-fold cross-fit, n = 1,161 | **91.0%** [88.6, 93.0] | > 85% ✅ |
| Grade-4 (proliferative DR) exact recall | Held-out test, n = 628 | 57.4% (31/54) | |

Grade-4 exact recall is the one deliberately conservative number here — and it's still a safe
system, because referral fires on calibrated P(grade ≥ 2), not on hitting the exact top grade; a
proliferative case graded 3 instead of 4 is still referred.

**Safety of the auto-clear tier** — class-conditional conformal calibration, cross-fit on the same
n = 1,161 population:

| Guard | Threshold | Result |
|---|---|---|
| Referable-case coverage, lower confidence bound | ≥ 93% | **94.2%** ✅ |
| False auto-clear rate, referable cases | ≤ 5% | **0.0%** ✅ |
| False auto-clear rate, grade ≥ 3 cases | ≤ 2% | **0.0%** ✅ |
| Grade-4 cases auto-cleared, across 1,000 fold assignments | — | **0** |
| Tier distribution (pooled) | — | A 38.4% · B 43.8% · C 17.8% |

**External validation on a camera the model has never seen** (Messidor-2, Topcon camera,
odd-half held-out, n = 872 — never touched until one final audited run):

| Metric | In-domain | Unseen camera (Messidor-2) |
|---|---|---|
| AUC of P(grade ≥ 2) | 0.979 | **0.924** [0.900, 0.945] |
| Referable sensitivity at the shipped threshold | 95.0% | **75.2%** [68.6, 81.4] |
| False auto-clear, true referable | 0.0% | 2.3% (5/218) |
| False auto-clear, true grade ≥ 3 | 0.0% | **0.0%** (0/45) |

Sensitivity dropping on an unseen camera is the expected behavior of any vision model under domain
shift — the product's answer is structural: **a camera or site that hasn't been locally validated
can never reach the auto-clear tier**, regardless of what the model says. This is the reason the
camera-validation gate exists, not a blind spot found by accident.

**Deployed, end-to-end pipeline smoke test** (official IDRiD test split, n = 103, overlaps the
calibration pool so read it as integration proof, not a fourth accuracy claim): QWK 0.841,
referable sensitivity **100%** (64/64), grade-4 recall **13/13**, 0 Tier-A cases referable.

**Segmentation and lesion models:**

| Model | Test data | Result |
|---|---|---|
| Vessel segmentation | CHASE_DB1 held-out (n = 6) | Dice **0.777** |
| Same model, no retraining | DRIVE, unseen dataset (n = 20) | Dice 0.619 |
| Optic disc / fovea localization | IDRiD held-out (n = 77) | **98.7% / 96.1%** within one disc radius |
| Hard-exudate segmentation | IDRiD held-out | Dice 0.583 per-image / 0.733 pixel-pooled |
| Microaneurysm + haemorrhage segmentation | IDRiD (n = 16) | Merged Dice 0.599 |

Cotton-wool spots and neovascularization are explicitly **not wired into any decision** — measured,
found not to hold up, and reported as "unmeasured" rather than a false zero. Full reasoning in
`docs/ML_BENCHMARKS.md` §5.

**Rule engine** (explicit ICDR "4-2-1" criteria, plain auditable code — no learned weights):
60.2% exact agreement with ground truth on IDRiD's official test set. Its value isn't beating the
CNN — agreement strengthens a case's confidence tier, and **disagreement unconditionally forces
mandatory review**, with the final grade set by the ophthalmologist either way.

**Engineering integrity — the numbers behind "it actually runs, consistently":**

| Check | Result |
|---|---|
| PyTorch ↔ ONNX ↔ MATLAB tensor parity, all 9 model artifacts | Max difference 1×10⁻⁶–4×10⁻⁵ |
| Classifier, Python vs. MATLAB inference, real IDRiD images | Grade and tier agree **10/10** |
| Full-pipeline soak test — every IDRiD image through capture → quality gate → sync → grading | **447/447 graded, 0 failed, 0 timed out** |
| End-to-end central grading latency (warm MATLAB, dev laptop) | p50 10.9s / p95 22.2s |
| Local quality-gate latency (desktop MATLAB) | p50 0.49s / p95 3.2s |
| Automated tests | Conformal 90/90 · fovea gate 12/12 · PHC backend 41/41 · mobile 28 |

**Scope, stated on purpose:** in-domain vs. unseen-camera sensitivity (95.0% → 75.2%), grade-4
exact-recall is a known next-round target, microaneurysm/haemorrhage evidence is early (16-image
tune set), neovascularization and cotton-wool spots are measured and gated off rather than
shipped unproven, and every result above is on public datasets — no real-patient or prospective
data this round. Full detail: `docs/ML_BENCHMARKS.md` §8.

---

## Honest status — what works, what doesn't, and why

We'd rather a judge read this than discover it live.

- **SMS referral notifications are wired and enabled for real sending** (not a dry-run stub) —
  but on the hosted demo, a Twilio trial account can only deliver SMS to phone numbers that have
  been manually verified in the Twilio console. **If a judge's number isn't pre-verified, the SMS
  step will not actually arrive during a live demo**, even though the referral itself completes
  normally and the system correctly attempted to send it. This is a demo-account limitation, not
  a code limitation — a production Twilio account (out of trial mode) sends to any number.
- **The hosted deployment runs on Render's free tier**, which spins down after ~15 minutes idle.
  The first request after idle can be slow while it wakes back up — this is a hosting-tier
  behavior, not a performance bug in the pipeline itself.
- **The hosted deployment's quality gate and rule engine run on JS ports of the MATLAB logic**,
  not MATLAB itself — Render's free tier has no MATLAB license or install. Both ports are
  verified against their MATLAB originals (0 mismatches across hundreds of test cases — see
  `docs/ML_BENCHMARKS.md` §7). See "Two deployment modes" below for why this split exists and what
  it does and doesn't mean for the result you see.
- **Media storage on the hosted demo is ephemeral.** Render's free-tier filesystem resets on
  redeploy, so images from older demo cases may 404 after a redeploy. The local/offline deployment
  does not have this limitation.

Full status detail: `docs/TECHNICAL_DOCUMENTATION.md`.

---

## Simulink models

Two SimEvents discrete-event models (`simulink-model/`), built entirely from script
(`buildDistrictScreeningModel.m`, `buildFullPipelineModel.m`), validate the system's capacity
assumptions and demo its queueing behavior under load.

<p>
  <a href="docs/ppt-audit/assets/districtScreeningSimEvents_full.png">
    <img src="docs/ppt-audit/assets/districtScreeningSimEvents_full.png" width="420" alt="District-scale SimEvents queueing model: PHC arrivals, tier triage, preemptive reviewer pool">
  </a>
  <br><em>District queueing model — PHC arrivals → tier triage (Tier A auto-clears) → a
  two-ophthalmologist review pool where Tier C preempts Tier B. Click the image for full
  resolution — GitHub's inline preview doesn't support zoom.</em>
</p>

<p>
  <a href="docs/ppt-audit/assets/netraSetuPipeline_full.png">
    <img src="docs/ppt-audit/assets/netraSetuPipeline_full.png" width="420" alt="Full watchable pipeline model with live sliders for arrival rate, review speed, network and grading availability">
  </a>
  <br><em>Full-pipeline model — the entire capture→referral flow as a live, watchable simulation
  with sliders for patient load, review speed, and network/grading outages. Click the image for
  full resolution.</em>
</p>

This district model is also checked weekly, automatically, against an independent pure-MATLAB
reference implementation of the same queueing logic — a software self-test that catches either
model drifting from the other.

---

## Data flow — how one case actually moves through the system

```
PHC capture  →  quality gate  →  local queue  →  sync to central  →  grading  →  tiering  →  review  →  referral
```

1. **Capture.** A technician photographs the retina (desktop camera or a mobile fundus-lens
   attachment). The image is stored locally first — nothing is lost to a network outage.

2. **Quality gate.** Before anything else happens, the image is checked for focus, field-of-view
   coverage, illumination, glare, motion blur and occlusion. A failing image is retaken on the
   spot, at the PHC, rather than discovered unusable after it's already been reviewed remotely.
   Engine: MATLAB (desktop, compiled to a standalone executable — no MATLAB license needed on the
   PHC machine) with a verified JS port as the fallback.

3. **Preprocessing (Ben Graham method).** The retinal circle is located from the green color
   channel, the image is cropped tightly to it (removing black borders), and resized to the
   network's input size. This exact step — one implementation, not a MATLAB port kept in sync by
   hand — is used for every Branch A inference, in every deployment mode, so what the model is
   shown is never a question. (An earlier MATLAB-native port of this step was measured and
   retired: it matched the reference to SSIM 0.981, which still flipped the predicted grade on
   1 real image in 10 — close enough to look right, not close enough to trust.)

4. **Branch A — CNN classification.** An EfficientNet-B0, trained with an ordinal-aware loss,
   predicts a 5-class DR grade and a calibrated referable probability. Exported to ONNX and
   imported into MATLAB's Deep Learning Toolbox for MATLAB-backend deployments; numerically
   verified to agree with the PyTorch original to within 1×10⁻⁶–4×10⁻⁵.

5. **Branch B — segmentation + rule engine.** Four dedicated models locate the vessels, optic
   disc and fovea, hard exudates, and microaneurysms/haemorrhages. Their outputs are mapped onto
   the four retinal quadrants, and an explicit, auditable ICDR "4-2-1" rule engine — ordinary
   code, not learned weights — applies the standard clinical grading criteria directly.

6. **Agreement check.** When Branch A and Branch B agree, that agreement strengthens the case's
   confidence tier. When they disagree, review is mandatory and the disagreement is shown, never
   silently resolved in the model's favor.

7. **Confidence tiering.** Temperature-scaled calibration, referable-stratified conformal
   prediction, branch agreement, camera-validation status and capture-quality flags combine into
   one of three tiers: **A** (auto-clear), **B** (AI-assisted review), **C** (full manual review).
   A camera the system hasn't been locally validated on can never reach Tier A, regardless of what
   the model says — this is a structural safety control, not a hope.

8. **Explainability.** A Grad-CAM heatmap, cross-checked for consistency against the lesion
   segmentation masks, is assembled with the rule-engine criteria that actually fired into one
   plain-language rationale per case — so a reviewing ophthalmologist sees *why*, not just *what*.

9. **Review and referral.** An ophthalmologist confirms or overrides the result. A referral
   triggers an SMS to the patient (see "Honest status" above for the hosted-demo caveat on this
   step) and a clinical-rationale PDF.

---

## Two deployment modes, and why they differ

NetraSetu is built and demonstrated in **two deliberately different configurations**, because
they answer two different questions a hackathon round asks.

**Local / full deployment — "can this actually run with no MATLAB license cost at the PHC, and
does the full MATLAB-native pipeline work end to end?"** This is the system as designed: the
classifier, segmentation nets, rule engine, camera checks, evidence text and quality gate all run
natively inside MATLAB (persistent session, or the free MATLAB Runtime via compiled standalone
executables). This is the configuration the Simulink models validate and the one intended for a
real PHC rollout.

Seven standalone applications prove this out — exact paths, build scripts and toolbox
requirements for every one are in "Standalone MATLAB applications and toolboxes" below.

**Hosted / online deployment — "can a judge reach this system from anywhere, instantly, with no
local setup?"** Render's and Vercel's free tiers have no MATLAB available at all, so this
deployment runs the classifier and segmentation on ONNX Runtime (numerically verified equivalent
to the MATLAB path) and uses verified JS ports for the quality gate and rule engine, recorded
honestly as such in every case's own engine-provenance record — the system never claims an engine
ran when it didn't. This mode exists purely for round-the-clock reachability during judging, not
as the intended production architecture.

Both modes are real, both are tested, and the system is explicit — case by case, in its own
output — about which one produced any given result.

---

## Standalone MATLAB applications and toolboxes

**The seven standalone applications**, each compiled with MATLAB Compiler or Simulink Compiler so
it runs on a machine with no MATLAB license — only the free MATLAB Runtime. Six ship directly in
this repo at the paths below; the inference engine (classifier + all four segmentation models,
265MB) is too large for a normal git push and is instead a
**[GitHub Release](https://github.com/krrishgadekar/SIH_2026/releases/tag/inference-engine-v1)**.

| # | Application | Path in this repo | Built by | Requires at runtime |
|---|---|---|---|---|
| 1 | PHC quality gate | `phc-local-app/backend/quality-gate-matlab/dist/qualityGate.exe` | `buildQualityGateExe.m` | MATLAB Compiler Runtime |
| 2 | District resource model (compiled from the real Simulink model) | `simulink-model/deployable/dist/NetraSetuResourceModel.exe` | `simulink-model/deployable/buildResourceModelApp.m` | Simulink Compiler Runtime |
| 3 | District resource model (plain-MATLAB CLI reimplementation of the same queueing logic, no Simulink Compiler needed) | `simulink-model/resourceModelApp/dist/resourceModel.exe` | `simulink-model/resourceModelApp/buildResourceModelExe.m` | MATLAB Compiler Runtime |
| 4 | Case-chain engine | `central-system/backend/ml-pipeline/deploy/dist/netraSetuCaseMain.exe` | `central-system/backend/ml-pipeline/deploy/buildCaseChain.m` | MATLAB Compiler Runtime (+ Deep Learning, Image Processing, Statistics and Machine Learning add-ons) |
| 5 | Clinical-rationale report generator | `central-system/backend/ml-pipeline/explainability/reportGeneratorApp/dist/reportGenerator.exe` | `.../reportGeneratorApp/buildReportGeneratorExe.m` | MATLAB Compiler Runtime |
| 6 | Interactive full-pipeline dashboard | `simulink-model/deployable/pipeline/dist/NetraSetuPipelineDashboard.exe` | `simulink-model/deployable/pipeline/buildPipelineDashboardApp.m` | Simulink Compiler Runtime |
| 7 | Inference engine (classifier + 4 segmentation models) | not in git (265MB) — [GitHub Release](https://github.com/krrishgadekar/SIH_2026/releases/tag/inference-engine-v1) | same `buildCaseChain.m`, inference target | MATLAB Compiler Runtime (+ same add-ons as #4) |

Rows 2 and 3 are genuinely two different applications, not a duplicate: one is Simulink Compiler's
build of the actual `.slx` model, the other a plain-MATLAB-Compiler reimplementation of the same
queueing logic, kept independently buildable with no Simulink Compiler license at all.

**Every MATLAB toolbox this project uses, and exactly where:**

| Toolbox / product | Used in | What for |
|---|---|---|
| Deep Learning Toolbox | Case-chain and inference engine (`ml-pipeline/deploy`) | Runs the ONNX-imported DR classifier natively in MATLAB |
| Image Processing Toolbox | Preprocessing, quality gate, report generator, case-chain/inference engine | Image I/O, cropping, resizing, basic filtering |
| Statistics and Machine Learning Toolbox | Case-chain and inference engine | Calibration and conformal-prediction statistics behind the confidence tiers |
| Medical Imaging Toolbox | `ml-pipeline/preprocessing/readFundusImage.m` | Reads DICOM images a clinical-grade fundus camera exports (Ophthalmic Photography format), and pulls the camera manufacturer/model and eye laterality out of the file's own metadata. Deliberately kept out of the compiled quality-gate bundle (licensing/bundle-size tradeoff), so the PHC desktop app still uses plain image reading |
| Computer Vision Toolbox | `ml-pipeline/explainability/generateEvidenceReport.m`, `ml-pipeline/verifyPhase4.m` | Annotating lesion boxes/shapes onto the evidence images shown in a case's clinical rationale |
| Parallel Computing Toolbox | Offline calibration and experiment scripts — `ml-pipeline/grading/optimizeRuleThresholds.m`, `ml-pipeline/explainability/batchGenerateReports.m`, `ml-pipeline/experiments/runTask92.m`, `quality-gate-matlab/calibrateQualityThresholds.m`, `simulink-model/monteCarloQueueing.m`, `simulink-model/sweepDistrictScenarios.m` | Parallelizing threshold sweeps and batch report generation during development — never in the live request path |
| Global Optimization Toolbox | `ml-pipeline/grading/optimizeRuleThresholds.m` | Searching the rule-engine's threshold space during calibration, before the chosen thresholds are frozen into the deployed rule engine |
| Simulink + SimEvents | `simulink-model/` | The two discrete-event models above (district queueing, full pipeline) |
| Simulink Compiler | Apps #2 and #6 above | Compiling the Simulink models themselves into standalone executables |
| MATLAB Compiler | Apps #1, #3, #4, #5, #7 above | Compiling plain-MATLAB entry points into standalone executables |
| MATLAB Report Generator | Clinical-rationale PDF generation | Evidence PDF layout; a core-MATLAB fallback renderer exists if this toolbox isn't available |

Computer Vision, Parallel Computing and Global Optimization never run in the live request
path — they're real, verified-in-code dependencies of the offline calibration and
evidence-rendering tooling, not of anything a judge's live case goes through.

---

## Prototype

Click any screenshot for full resolution — GitHub's inline preview doesn't support zoom.

**Landing and role selection**

<p>
  <a href="docs/prototype/00-Intro/01-splash.png"><img src="docs/prototype/00-Intro/01-splash.png" width="260" alt="NetraSetu splash screen"></a>
  <a href="docs/prototype/00-Intro/02-eye-anatomy.png"><img src="docs/prototype/00-Intro/02-eye-anatomy.png" width="260" alt="Eye anatomy explainer animation"></a>
  <a href="docs/prototype/00-Intro/03-role-selection.png"><img src="docs/prototype/00-Intro/03-role-selection.png" width="260" alt="Central web role selection: ophthalmologist or district worker"></a>
</p>

**PHC technician** (`phc-local-app`) — registers the patient, captures the retina photo, and
clears the local quality gate before anything is sent anywhere:

<p>
  <a href="docs/prototype/01-PHC%20Technician/01-patient-registration.png"><img src="docs/prototype/01-PHC%20Technician/01-patient-registration.png" width="400" alt="PHC technician: new patient registration form"></a>
  <a href="docs/prototype/01-PHC%20Technician/02-capture-and-quality-gate.png"><img src="docs/prototype/01-PHC%20Technician/02-capture-and-quality-gate.png" width="400" alt="PHC technician: image capture and local quality gate"></a>
</p>

**Ophthalmologist** (`central-system/frontend`) — reviews the AI grade against the rule engine,
the Grad-CAM evidence and lesion counts, and confirms or overrides before a referral fires:

<p>
  <a href="docs/prototype/02-Ophthalmologist/01-case-list.png"><img src="docs/prototype/02-Ophthalmologist/01-case-list.png" width="400" alt="Ophthalmologist: case list"></a>
  <a href="docs/prototype/02-Ophthalmologist/02-gradcam-and-lesion-evidence.png"><img src="docs/prototype/02-Ophthalmologist/02-gradcam-and-lesion-evidence.png" width="400" alt="Ophthalmologist: Grad-CAM and lesion evidence"></a>
  <a href="docs/prototype/02-Ophthalmologist/03-ai-confidence-and-context.png"><img src="docs/prototype/02-Ophthalmologist/03-ai-confidence-and-context.png" width="400" alt="Ophthalmologist: AI confidence, uncertainty and patient context"></a>
  <a href="docs/prototype/02-Ophthalmologist/04-confirm-or-override.png"><img src="docs/prototype/02-Ophthalmologist/04-confirm-or-override.png" width="400" alt="Ophthalmologist: confirm or override decision"></a>
</p>

Confirming or overriding renders the downloadable clinical-rationale PDF (MATLAB Report
Generator, with a core-MATLAB fallback renderer), and a confirmed referral reaches the patient
directly by SMS:

<p>
  <a href="docs/prototype/02-Ophthalmologist/05-clinical-rationale-report.jpeg"><img src="docs/prototype/02-Ophthalmologist/05-clinical-rationale-report.jpeg" width="400" alt="Clinical-rationale PDF report: fundus photo, Grad-CAM, AI grade"></a>
  <a href="docs/prototype/02-Ophthalmologist/06-patient-sms-notification.jpeg"><img src="docs/prototype/02-Ophthalmologist/06-patient-sms-notification.jpeg" width="260" alt="Patient referral SMS notification"></a>
</p>

**District admin** (`central-system/frontend`) — the district-wide view: screening volume,
DR grade distribution, the referral tracker, PHC uptime, and MATLAB-Simulink-backed resource
planning:

<p>
  <a href="docs/prototype/03-District%20Admin/01-overview.png"><img src="docs/prototype/03-District%20Admin/01-overview.png" width="400" alt="District admin: overview"></a>
  <a href="docs/prototype/03-District%20Admin/02-dashboard-kpis.png"><img src="docs/prototype/03-District%20Admin/02-dashboard-kpis.png" width="400" alt="District admin: dashboard KPIs"></a>
  <a href="docs/prototype/03-District%20Admin/03-dashboard-dr-grade-distribution.png"><img src="docs/prototype/03-District%20Admin/03-dashboard-dr-grade-distribution.png" width="400" alt="District admin: DR grade distribution"></a>
  <a href="docs/prototype/03-District%20Admin/04-referral-tracker.png"><img src="docs/prototype/03-District%20Admin/04-referral-tracker.png" width="400" alt="District admin: referral tracker"></a>
  <a href="docs/prototype/03-District%20Admin/05-phc-health.png"><img src="docs/prototype/03-District%20Admin/05-phc-health.png" width="400" alt="District admin: PHC health"></a>
  <a href="docs/prototype/03-District%20Admin/06-resource-allocation.png"><img src="docs/prototype/03-District%20Admin/06-resource-allocation.png" width="400" alt="District admin: Simulink-backed resource allocation"></a>
</p>

---

## Research and references

Full register, with status (fetched / logged / canonical / estimate) for every entry, internal
evidence file paths, and a log of claims corrected or dropped along the way:
**[`docs/NetraSetu — Research & References Register.md`](docs/NetraSetu%20%E2%80%94%20Research%20%26%20References%20Register.md)**.
The core sources:

**Clinical evidence and benchmarks**
- Abràmoff et al., IDx-DR pivotal trial, *npj Digital Medicine* 2018 — 87.2% sensitivity / 90.7% specificity, 900 patients, 10 sites ([doi.org/10.1038/s41746-018-0040-6](https://doi.org/10.1038/s41746-018-0040-6))
- Medios AI / Remidio SMART study (India), PMC7039584 — 93.0% sensitivity / 92.5% specificity, n=900 ([pmc.ncbi.nlm.nih.gov/articles/PMC7039584](https://pmc.ncbi.nlm.nih.gov/articles/PMC7039584/))
- Wilkinson et al., International Clinical DR and DME Severity Scales, *Ophthalmology* 2003 — defines the 5-level ICDR scale this system's grades and rule engine follow ([pubmed.ncbi.nlm.nih.gov/13129861](https://pubmed.ncbi.nlm.nih.gov/13129861/))
- Lu et al., comparative accuracy of handheld/smartphone fundus cameras, *PLOS Digital Health* 2022 — mobile-lens feasibility reference ([journals.plos.org/digitalhealth](https://journals.plos.org/digitalhealth/article?id=10.1371%2Fjournal.pdig.0000131))

**Health-system, policy and economics**
- Purohit et al., cost-effectiveness of DR screening at Indian PHCs, *PharmacoEconomics Open* 2025 — $354/QALY for AI-supported screening ([pmc.ncbi.nlm.nih.gov/articles/PMC12209073](https://pmc.ncbi.nlm.nih.gov/articles/PMC12209073))
- IDF Diabetes Atlas, 11th ed. (2024 data), India — ~90 million adults with diabetes ([diabetesatlas.org](https://diabetesatlas.org/data-by-location/country/india/))
- AIIMS Delhi national ophthalmic workforce survey (Vashist et al.), Oct 2025 — 20,944 ophthalmologists, ~15 per million people
- National Blindness and Visual Impairment Survey 2015–19 — ~6.2M blind, ~55M visually impaired nationally ([ncbi.nlm.nih.gov/pmc/articles/PMC8725073](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8725073/))
- Ayushman Bharat — DR screening added to the PHC/HWC eye-care package, April 2022

**Datasets** — APTOS 2019, EyePACS (curated subset), IDRiD, CHASE_DB1, DRIVE, Messidor-2. Exact role of each in training/evaluation: see `docs/TECHNICAL_DOCUMENTATION.md` §11.

**Method references** (standard techniques this system implements) — U-Net (Ronneberger et al. 2015), EfficientNet-B0 (Tan & Le 2019), temperature scaling (Guo et al. 2017), MC Dropout (Gal & Ghahramani 2016), conformal prediction (Vovk, Gammerman & Shafer 2005; Angelopoulos & Bates 2021), class-conditional conformal prediction (Vovk 2012), Grad-CAM / Grad-CAM++ (Selvaraju et al. 2017; Chattopadhay et al. 2018), Ben Graham preprocessing (Graham, Kaggle DR competition 2015), Frangi vesselness (Frangi et al., MICCAI 1998), quadratic-weighted kappa (Cohen 1968).

**MathWorks references** — the Medical Imaging Toolbox's own multilabel DR fundus classification example (validated reference architecture for this system's MATLAB-native path), and MathWorks' own writeup of how Team TwinX won SIH 2025.

**Existing solutions landscape** — IDx-DR/LumineticsCore and EyeArt (clinic-based, strongly validated); Remidio Medios AI and Forus Health (India-built portable devices, the closest real-world precedent to this system's deployment model).

---

## Security

Security measures in place:

- **Authentication on every application:** central web (session-based, bcrypt, role-enforced
  server-side), PHC desktop and mobile (bcrypt technician accounts), PHC-to-central ingestion (a
  per-PHC API key).
- **Encryption at rest on the central server:** AES-256-GCM for stored images, Grad-CAM overlays
  and report PDFs.
- **Audit log:** every access to patient data is recorded.

This is a **prototype-stage security floor, not a production compliance claim**. The PHC-side
local databases (desktop SQLite, mobile store) are not yet encrypted, and no penetration test or
security audit has been done. See `docs/TECHNICAL_DOCUMENTATION.md` §9.

---

## Datasets

Only public research datasets are used anywhere in this project — **no real patient data** in
seeds, tests, demos or deployments: APTOS 2019 (India, Aravind Eye Hospital), IDRiD (India,
Nanded), EyePACS (curated subset), CHASE_DB1, DRIVE (evaluation only), Messidor-2 (external
validation only). Details: `docs/TECHNICAL_DOCUMENTATION.md` §11.

---

## Environment configuration

Every service reads its own `.env`, and each `.env.example` documents every variable it reads.
**Twilio credentials are deliberately excluded below** — request them privately if you need to
test real SMS sending; every other value here is safe to share.

| File | Key variables |
|---|---|
| `central-system/backend/.env` | `DATABASE_URL`, `CORS_ALLOWED_ORIGINS`, `AUTH_ENABLED`, `JWT_SECRET`, `PHC_AUTH_ENABLED`, `MATLAB_EXECUTABLE`, `INFERENCE_BACKEND` (`matlab` / `python` / `remote`), `MEDIA_ENCRYPTION_KEY`, `MATLAB_ALLOW_FALLBACK` |
| `phc-local-app/backend/.env` | `CENTRAL_API_URL`, `PHC_CODE`, `PHC_ID`, `PHC_API_KEY`, `MATLAB_EXECUTABLE`, `LOCAL_AUTH_ENABLED`, `QUALITY_GATE_ALLOW_FALLBACK` |
| `central-system/frontend/.env` | `VITE_CENTRAL_API_BASE`, `VITE_DATA_MODE` |
| `phc-local-app/frontend/.env` | `VITE_LOCAL_API_BASE`, `VITE_DATA_MODE` |
| `phc-local-app/mobile/.env` | `EXPO_PUBLIC_CENTRAL_API_URL`, `EXPO_PUBLIC_PHC_API_KEY`, `EXPO_PUBLIC_PHC_CODE` |

No app has a built-in server URL — an unset one shows an on-screen error, never a silent default.
`VITE_DATA_MODE=mock` shows fixture data with a permanent **"DEMO DATA"** banner and is never used
as a silent fallback when a real request fails — that's a system-wide, non-negotiable rule.

---

## Documentation index

| Document | Contents |
|---|---|
| [`docs/TECHNICAL_DOCUMENTATION.md`](docs/TECHNICAL_DOCUMENTATION.md) | System design, every component explained, dual-deployment architecture, implementation status |
| [`docs/ML_BENCHMARKS.md`](docs/ML_BENCHMARKS.md) | Every ML metric, with population, n, interval and caveats |
| [`docs/api-contracts.md`](docs/api-contracts.md) | Request/response shapes; the source of truth over any other doc |
| [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md) | Scene-by-scene demo walkthrough |
| [`docs/RELEASE.md`](docs/RELEASE.md) | Served model versions and checksums |

---

## Design philosophy

The UI is high-contrast, cyber-brutalist and clinical (`#E63B2E` / `#0A0A0A`), with monospace
telemetry. One standing rule runs through every screen in every app: **a failure never gets to
look like a success.** A network error, a timeout and a working result are always visibly
distinguishable.
