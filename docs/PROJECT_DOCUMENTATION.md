# NetraSetu: Project Documentation

**Smart India Hackathon 2026 · PS 26038 · Explainable AI for Diabetic Retinopathy Screening in Rural India**
Team "Game Of Codes": Tanuj, Saad, Kankshi, Parth, Vedant

> **What this document is.** A complete, code-checked description of what exists in the repository as of
> **2026-10-02** (`main` @ `eab10b9`). It is the source material for the final README.
>
> **How it was checked.** Structure, endpoints, screens, tables, settings and pipeline steps were read from the code
> itself (file references given). ML metrics are **quoted** from `docs/ML_BENCHMARKS.md` (Tanuj's evaluation) and
> were not re-measured here.
>
> Where older docs disagree with the code, the code wins, and the disagreement is listed in **§15**.

---

## Contents

1. [The problem and the idea](#1-the-problem-and-the-idea)
2. [What is in the repository](#2-what-is-in-the-repository)
3. [Architecture and the life of a case](#3-architecture-and-the-life-of-a-case)
4. [Technology stack](#4-technology-stack)
5. [PHC side: capture station](#5-phc-side-capture-station)
6. [Central side: grading, review and administration](#6-central-side-grading-review-and-administration)
7. [ML pipeline](#7-ml-pipeline)
8. [MATLAB and Simulink](#8-matlab-and-simulink)
9. [Results](#9-results)
10. [Deployment: three ways the system runs](#10-deployment-three-ways-the-system-runs)
11. [Security and privacy](#11-security-and-privacy)
12. [Testing and verification](#12-testing-and-verification)
13. [Configuration reference](#13-configuration-reference)
14. [Datasets](#14-datasets)
15. [Corrections to older docs](#15-corrections-to-older-docs)
16. [Known limitations and open items](#16-known-limitations-and-open-items)
17. [Documentation index](#17-documentation-index)
18. [Notes for writing the README](#18-notes-for-writing-the-readme)

---

## 1. The problem and the idea

India has about 20,944 ophthalmologists, roughly 15 per million people. Blindness is 1.37× more common in rural
areas, and about 90% of diabetic-retinopathy (DR) vision loss is preventable with timely referral. The bottleneck is
specialist time, not awareness. *(Figures as cited in the existing README; the sources named there are the AIIMS
Delhi national survey 2025 and NBVIS 2015–19.)*

**NetraSetu moves screening to the Primary Health Centre (PHC):**

- **At the PHC.** A minimally trained technician photographs the retina with a fundus camera. A local quality gate
  says "retake" *before the patient leaves the chair*.
- **At the central server.** Every image is graded by **two independent branches**: a CNN, and an explainable
  rule engine built on segmented lesions.
- **Routing.** A confidence router decides whether a case can be auto-cleared, needs a quick AI-assisted review, or
  needs full manual review.
- **Specialist confirmation.** An ophthalmologist confirms every positive before the patient is told anything, then
  a referral is tracked through to attendance.

**Design rules that run through the whole codebase** (from `CLAUDE.md` and the design doc):

- **A failure never looks like a success.** No screen invents a result. A failed request shows an error or genuinely
  queues for retry. Mock data appears only when `DATA_MODE=mock` is set, and then under a visible "DEMO DATA" banner.
- **Engine provenance.** Every ML output records which engine produced it (`matlab`, `python`, `js-fallback`,
  `js-device`). An engine switch is never silent.
- **Humans decide.** The AI never tells a patient they have a disease.
- **Public data only.** Only public datasets are used (IDRiD, APTOS, Messidor-2, DRIVE, CHASE_DB1, an EyePACS subset).
  No real patient data appears anywhere.

---

## 2. What is in the repository

| Path | What it is | Tracked files* |
|---|---|---|
| `phc-local-app/frontend/` | PHC technician web app (React 19 + Vite) | 54 |
| `phc-local-app/backend/` | PHC local API: SQLite queue, quality gate, sync to central, phone pairing | 44 |
| `phc-local-app/backend/quality-gate-matlab/` | The MATLAB quality gate, its compiler build script, and the **compiled `dist/qualityGate.exe`** | – |
| `phc-local-app/mobile/` | Expo / React Native technician app (**work in progress, owned by a teammate**) | 89 |
| `central-system/backend/` | Central API, grading orchestrator, PostgreSQL, MATLAB + Python inference, SMS | 2,427 |
| `central-system/backend/ml-pipeline/` | Preprocessing, inference, segmentation, grading, calibration, explainability, training code, model checksums | (part of above) |
| `central-system/frontend/` | Ophthalmologist + district-admin web app (React 19 + Vite) | 75 |
| `ml-inference-service/` | FastAPI wrapper used **only** by the hosted online demo (ONNX Runtime, no MATLAB) | 5 |
| `simulink-model/` | SimEvents district resource model + pure-MATLAB reference queueing model | 13 |
| `scripts/` | Dev stack launcher, DB setup, seeding, model fetch/verify, demo reset, provisioning, exports | 25 |
| `tests/` | Shared image fixtures and an end-to-end PHC flow check | 6 + 1 |
| `verify_*.js` (repo root) | 17 standalone verification scripts (parity, provenance, auth, TLS, pipeline…) | 17 |
| `docs/` | Design, API contract, benchmarks, runbooks, audits, task plans | – |
| `render.yaml`, `.dockerignore`, `*/Dockerfile` | Online-demo deployment (Render) | – |
| `docker-compose.dev.yml` | Local Postgres (host port 5433) | – |
| `experimenting Frontend/` | **Leftover experiment**, not part of the system (a local commit removing it never reached `origin`) | 21 |

\* `git ls-files` counts on 2026-10-02. Model weights and datasets are git-ignored. Weight checksums are tracked in
`central-system/backend/ml-pipeline/models.sha256`.

---

## 3. Architecture and the life of a case

```
 ┌──────────────── PHC (offline-first) ────────────────┐            ┌──────────────── Central ────────────────────────┐
 │                                                      │            │                                                 │
 │  PHC web app (React)  ──►  PHC backend (Node/Express) │   HTTPS    │  Central backend (Node/Express)                 │
 │   register · capture       · SQLite queue            │ ─────────► │   ingestion (idempotent on capture id)          │
 │   quality result           · quality gate:           │  per-PHC   │   in-process grading queue + watchdog           │
 │   questionnaires           ·   compiled exe / MATLAB │  API key   │   grading orchestrator ──► MATLAB session       │
 │   local queue              ·   / JS port (opt-in)    │            │                        ──► Python seg worker    │
 │                            · sync manager (chunks)   │            │   referral + Twilio SMS                         │
 │  Mobile app (Expo) ── pairs with the PHC PC ─────────┼──────────► │   admin analytics · system health               │
 │   on-device JS gate, expo-sqlite queue               │            │   PostgreSQL · media/ (AES-256-GCM at rest)     │
 └──────────────────────────────────────────────────────┘            │                                                 │
                                                                     │  Central web app (React)                        │
                                                                     │   ophthalmologist: queue · case · decision      │
                                                                     │   district admin: dashboard · referrals · PHCs  │
                                                                     │                   · resource recommendations    │
                                                                     └─────────────────────────────────────────────────┘
```

**Life of one case:**

1. **Register.** The technician registers the patient. There is a duplicate check, verbal consent is timestamped,
   and a symptom/risk questionnaire is filled in. The PHC mints a collision-safe ID: `{PHC_CODE}-{base36
   time}-{8 random}` (`docs/id-format-spec.md`, `phc-local-app/backend/services/ids.js`).
2. **Capture.** A fundus image is captured or imported with the eye (left/right) tagged. It is saved locally first.
3. **Quality gate.** It runs **on the PHC** and returns pass / borderline / retake with a reason (blur,
   low_illumination, insufficient_fov, glare, motion_artifact, eyelash_occlusion). The engine used is recorded.
4. **Capture metadata.** Pupil, lighting, observed issues and usability are recorded. The capture enters the local
   queue.
5. **Sync.** The sync manager uploads to central when online: urgency first, then age. Large images go up in
   resumable chunks. The local capture ID is the idempotency key, so retries never duplicate a case. "Synced" means
   central answered **201**.
6. **Grading at central** (`services/gradingOrchestrator.js`):
   1. preprocessing;
   2. camera-family fingerprint;
   3. optic disc / fovea localization;
   4. vessel + lesion segmentation;
   5. **Branch A** (CNN) and **Branch B** (ICDR rule engine);
   6. calibration + conformal prediction;
   7. tier decision;
   8. Grad-CAM, lesion-attention consistency, and the rationale / evidence report.
7. **Review.** Tier B/C cases appear in the ophthalmologist's queue, least-confident first. Opening a case claims
   it. The reviewer confirms or overrides with a structured reason. **On branch disagreement, "Confirm" is not
   offered**: the reviewer must choose a final grade.
8. **Referral.** Referable cases create a referral (referred → contacted → attended / lost) with Twilio SMS. A
   failed SMS flips the referral to manual follow-up.
9. **Back at the PHC.** The PHC polls results. Its queue shows "RESULT READY", and the report is available to the
   PHC (`GET /api/v1/phc/cases/:captureRef/report`).

---

## 4. Technology stack

| Layer | Technology (versions from `package.json` / requirements) |
|---|---|
| Web front-ends | React 19.2, Vite 8, react-router 7, i18next (7 locales: en, hi, mr, te, ta, pa, bn), Chart.js + three.js (central) |
| PHC backend | Node.js, Express 4, better-sqlite3, sharp, multer, qrcode (phone pairing) |
| Central backend | Node.js, Express 4, PostgreSQL (`pg`, `node-pg-migrate`), jsonwebtoken + cookie-parser, bcryptjs, node-cron, Twilio |
| Mobile | Expo 57, React Native 0.86, expo-sqlite, expo-camera, @noble/ciphers (sealed peer channel) |
| ML (training + serving helpers) | Python 3.11, PyTorch, timm (EfficientNet-B0), segmentation-models-pytorch, OpenCV, scikit-learn |
| MATLAB (R2026a) | Deep Learning, Image Processing, Statistics & ML, Medical Imaging toolboxes; Simulink + SimEvents; MATLAB Compiler; Report Generator (optional) |
| Hosted demo only | Render (Docker, free tier), Vercel (static), FastAPI + ONNX Runtime (`ml-inference-service/`) |
| Dev infrastructure | Docker Compose (Postgres), one-command launcher `npm run dev:all` |

There is no Redis: the grading queue runs in-process in the central backend (`services/gradingQueue.js`).

---

## 5. PHC side: capture station

### 5.1 PHC web app (`phc-local-app/frontend`)

**Routes** (`src/App.jsx`): `/register`, `/capture`, `/queue`, `/devices`, plus a login gate.

| Screen (component) | What it does |
|---|---|
| Login (`LoginScreen`) | Technician login against the PHC backend |
| Patient Registration (`PatientRegistrationForm` + `PatientQuestionnaireForm`) | Four-section form, contact number required, duplicate check, consent checkbox, risk/symptom questionnaire |
| Capture (`CaptureScreen`) | Eye selection, camera selection (Forus 3Nethra v2, Remidio FOP, generic fundus, phone fundus lens, unknown), image capture/import |
| Quality Result (`QualityResultPanel`) | Verdict, reason, real quality score and the focus / illumination / coverage metrics; "retry quality check" if the gate could not run |
| Capture Metadata (`CaptureMetadataForm`) | Pupil status, lighting, observed issues, usability. Tap-only |
| Local Queue (`LocalQueueTable`) | Five pipeline stages per capture, from real local and central state; "capture other eye" |
| Paired Devices (`PairedDevicesPage`) | Pair and revoke technician phones (QR pairing) |

### 5.2 PHC backend (`phc-local-app/backend`)

**Endpoints** (`routes/*.js`; everything except `/auth` and `/health` requires a technician session):

| Group | Endpoints |
|---|---|
| auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout` |
| patients | `POST /patients`, `GET /patients`, `GET /patients/search`, `GET /patients/:patientId` |
| captures | `POST /captures` (image upload plus quality gate), `POST /captures/mobile`, `POST /captures/:id/quality-check`, `POST /captures/:id/best-effort`, `POST /captures/:id/questionnaire`, `POST /captures/:id/capture-metadata`, `GET /captures` |
| sync | `GET /sync/status` |
| peer (phone ↔ PC) | `POST /peer/pair`, `GET /peer/devices`, `POST /peer/devices/:id/revoke`, `/peer/hello`, `/login`, `/pull`, `/push`, `/image/get`, `/image/put`, `/bundle` (payloads sealed end to end) |
| health | `GET /health` |

**Local database** (SQLite, `db/schema.sql` + `db/localDb.js`): `patients`, `captures`, `questionnaire_responses`,
`capture_metadata_responses`, `sync_queue`, `technicians`, `sessions`, `access_log`, `peer_devices`, plus
sync/peer bookkeeping tables.

**Services:**

- `captureHandler.js`: saves the image, runs the gate, queues the capture.
- `qualityGateClient.js`: picks the quality-gate engine (order below).
- `syncManager.js`: uploads to central and polls results.
- `localAuth.js` + `passwords.js`: technician accounts, **scrypt** hashes.
- `peerSync.js` / `peerCrypto.js`: phone pairing.
- `ids.js`: collision-safe IDs.

**Quality-gate engine order** (`services/qualityGateClient.js`). Each result is stamped with its engine.

1. **Compiled `qualityGate.exe`** on the free MATLAB Runtime, when `QUALITY_GATE_EXE` is set. Recorded as `matlab`,
   "compiled qualityGate executable (MATLAB Runtime)".
2. **MATLAB** via `matlab -batch qualityGateMain(...)`. Recorded as `matlab`.
3. **JS port** (`services/qualityGateFallback.js`), only if MATLAB cannot be launched **and**
   `QUALITY_GATE_ALLOW_FALLBACK=1`. Recorded as `js-fallback`, fallback `true`. Since 2026-10-02 it is a
   step-by-step port of the MATLAB gate: 0 mismatches against MATLAB on 6 + 52 test images, every decision identical.
4. Otherwise: **HTTP 503 `quality_gate_failed`**. The image is kept and can be re-checked. No verdict is invented.

**The quality gate itself** (`quality-gate-matlab/qualityGateMain.m` + `assess*.m`): classical computer vision with
per-camera presets (`cameraPresets.json`: `default`, `mobile_lens`).

| Score | How it is computed |
|---|---|
| focus | Variance of a Laplacian |
| illumination | Mean grey distance from 100 |
| field of view / coverage | Largest filled bright region |
| glare | Share of saturated pixels in the centre |
| motion | Horizontal vs vertical gradient variance |
| occlusion | Dark pixels inside the retinal disc's convex hull |

Decision order: insufficient_fov → glare → motion → low_illumination → blur → eyelash_occlusion. Then, if the mean of
focus/illumination/FOV is below 0.7, **borderline**, else **pass**.

### 5.3 Mobile app (`phc-local-app/mobile`), work in progress

Owned by a teammate and still under development. Documented here as it exists, not changed.

- **Screens:** Login, Pairing, Registration, Capture (gallery import), Lens Camera (fundus-lens attachment, tagged
  `mobile_lens`), Queue, Case Report, Settings.
- **Quality gate:** an on-device TypeScript port of the MATLAB gate, recorded as `js-device`. Its own parity test is
  `npm run test:parity`.
- **Sync:** an `expo-sqlite` queue; summary packet first, then a chunked image; same idempotency rule as desktop.
- **No mock mode.**
- Not built (per its README): export-queue-to-drive, camp relay mode.

### 5.4 Standalone downloadable PHC (built 2026-10-02)

A PHC that needs **no MATLAB licence and no Node install**, for sites outside the hosted demo. File:
`NetraSetu-PHC-standalone.zip` (57.5 MB), distributed outside git.

```
NetraSetu-PHC\
  Start-PHC.cmd          starts backend + web app, opens http://localhost:5173
  Add-Technician.cmd     creates a technician login
  Check-Setup.cmd        preflight: MATLAB Runtime present, settings valid
  settings.env           PHC_CODE (PHC002), CENTRAL_API_URL, PHC_ID, PHC_API_KEY
  README.txt
  app\  backend\ (PHC backend + production deps)  web\ (built web app)
        quality-gate\qualityGate.exe  launcher.js
  runtime\node.exe       bundled Node 24
  data\                  created on first start: SQLite + images (survives app updates)
```

- **Requirement:** the free **MATLAB Runtime R2026a** (about 1 GB).
- **Tested end to end** against a local central: register → capture → compiled gate → sync → central grades with
  MATLAB → "RESULT READY". Restart persistence, install paths with spaces, offline capture and auth were also checked.
- **Not yet tested:** a PC with only the Runtime installed and no MATLAB.
- **Pending:** PHC002's `PHC_ID`/`PHC_API_KEY` on the hosted central (`docs/TASKS_TANUJ_DEPLOYMENT.md`).

---

## 6. Central side: grading, review and administration

### 6.1 Central backend endpoints (`central-system/backend/server.js`, `routes/*.js`)

| Endpoint | Guard | Purpose |
|---|---|---|
| `POST /api/v1/auth/login`, `GET /me`, `POST /logout` | – | JWT session in an httpOnly cookie (12 h default) |
| `POST /api/v1/cases` | PHC API key | Ingest a case (image + metadata). Idempotent on capture ID |
| `POST /api/v1/cases/summary` | PHC API key | Lightweight summary ahead of the image |
| `POST /api/v1/cases/:captureRef/chunks/init`, `/:index`, `/complete`; `GET …/chunks` | PHC API key | Resumable chunked upload |
| `GET /api/v1/cases/:caseId/status` | user or PHC | Grading status |
| `GET /api/v1/cases/:caseId` | any user | Case detail: grades, tier, lesions, provenance, prior assessments |
| `POST /api/v1/cases/:caseId/claim` | ophthalmologist | Claim a case for review |
| `POST /api/v1/cases/:caseId/review` | ophthalmologist | Confirm / override (corrected grade, structured reason) |
| `GET /api/v1/cases/:caseId/report`, `/reviews` | any user | Evidence-report PDF; review history |
| `GET /api/v1/ophthalmologist/queue` | ophthalmologist | Review queue |
| `GET /api/v1/admin/dashboard`, `/referrals`, `/phcs`, `/system-health`, `/resource-recommendations` (+`/refresh`), `/simulink-validation` (+`/refresh`) | district admin | Admin views |
| `PATCH /api/v1/referrals/:referralId` | district admin | Update referral status / assigned worker |
| `GET /api/v1/phc/cases/:captureRef/report`, `/gradcam` | PHC API key | Results back to the PHC |
| `GET /api/v1/phc/:phcId/sync-status` | district admin | One PHC's sync state |
| `GET /api/v1/patients/search` | PHC API key | Patient lookup |
| `POST /api/v1/notifications/sms-status` | Twilio signature | SMS delivery reports |
| `GET /media/*` | ophthalmologist / admin | Decrypts and serves case images and overlays; access-logged |
| `GET /health` | – | Per-component health: db, queue, MATLAB session, Python, segmentation worker |

The request/response shapes are defined in **`docs/api-contracts.md`**, which is the source of truth.

### 6.2 Central services (`central-system/backend/services/`)

| Service | Role |
|---|---|
| `ingestionService.js`, `chunkedUploadService.js` | Idempotent ingestion; resumable chunk sessions |
| `gradingQueue.js`, `gradingWatchdog.js` | In-process queue with retries and backoff; reaps stuck jobs |
| `gradingOrchestrator.js` | The pipeline in §7, the tier decision, and engine provenance |
| `matlabSessionClient.js`, `matlabSessionSupervisor.js` | Persistent MATLAB session (warm models), heartbeat, auto-restart |
| `segSessionClient.js`, `segWorkerSupervisor.js` | Persistent Python segmentation worker |
| `matlabFallback.js` | JS port of the MATLAB rule engine. Only used with `MATLAB_ALLOW_FALLBACK=1`, recorded as `js-fallback` |
| `referralNotificationService.js` | Referrals + Twilio SMS (dry-run supported); failure leads to manual follow-up |
| `analyticsAggregator.js`, `systemHealth.js`, `systemAlerts.js`, `phcSilence.js` | Dashboard numbers; one consolidated failure view (silent PHCs, stuck jobs, MATLAB down, stale referable cases) |
| `resourceRecommendations.js`, `simulinkValidation.js` | Resource recommendations (scheduled) and the weekly Simulink cross-check |
| `caseReport.js` | Evidence-report PDF via MATLAB |
| `mediaCrypto.js`, `mediaPaths.js` | AES-256-GCM encryption of media at rest |
| `authConfig.js`, `authTokens.js`, `accessLog.js` | JWT cookie sessions, hashed PHC API keys, access audit log |
| `validatedCameras.js` + `config/validatedCameras.json` | Which camera/site combinations may auto-clear |
| `continualLearningService.js`, `datasetCollector.js` | Capture of reviewer corrections for later retraining (export: `scripts/exportTrainingSet.js`) |

### 6.3 Database (PostgreSQL, 22 migrations in `db/migrations/`)

Tables: `patients`, `cases`, `grading_results`, `segmentation_outputs`, `explainability_outputs`,
`ophthalmologist_reviews`, `corrections`, `referrals`, `notifications`, `phc_sites`, `users`, `access_log`,
`system_alerts`, `grading_recoveries`, `resource_recommendations`, `model_versions`, `dataset_labels`.

Setup: `npm run db:migrate` (`scripts/setupCentralDb.js`, idempotent).

### 6.4 Central web app (`central-system/frontend`)

**Routes** (`src/App.jsx`), role-guarded:

- **Ophthalmologist:** `/ophth/queue`, `/ophth/case/:caseId`, profile, settings.
- **District admin:** `/admin/dashboard`, `/admin/dashboard/detailed`, `/admin/referrals`, `/admin/phc-health`,
  `/admin/resources`, profile, settings.

| Screen | Highlights |
|---|---|
| Review Queue | Least-confident first; both branch grades, tier, claim state; auto-refresh |
| Case Detail | Fundus image / Grad-CAM toggle, lesion evidence (MA, haemorrhage, hard exudate; cotton-wool spots shown as *unmeasured*), side-by-side branch comparison with disagreement flag, calibrated confidence + conformal tier, prior-visit timeline, engine provenance, evidence-report PDF, decision controls with claim lock |
| Admin Dashboard | Case volumes, review time, override rate, confidence, cases by PHC |
| PHC Health | Every PHC's last sync, volume, pending/failed, silent status, plus system-health alerts |
| Referral Tracker | referred → contacted → attended / lost / manual follow-up; assigned worker |
| Resource Recommendations | Staffing / routing guidance from the queueing model (§8) |

There are info buttons on every screen, and the UI is available in 7 languages.

---

## 7. ML pipeline

All paths are under `central-system/backend/ml-pipeline/`. Served versions are listed in `docs/RELEASE.md`. Weights
are not in git; verify them with `npm run models:verify`.

### 7.1 Models served

| Role | Model | Served by |
|---|---|---|
| DR grade (Branch A) | `branchA_v2c`: EfficientNet-B0, 512×512, ordinal-aware loss | MATLAB session (ONNX import) |
| Vessels | `vessel_unet_v1` (U-Net) | MATLAB session |
| Optic disc / fovea | `localization_v1` (U-Net heatmap regressor) | MATLAB session |
| Hard exudates | `bright_lesion_unet_v1` | MATLAB session |
| Microaneurysm + haemorrhage | `red_lesion_unet_v2` (3-class U-Net) | MATLAB session (since 2026-09-30) |
| Calibration / conformal | `temperature_v1`, `conformal_v1`, `calibration_branchA_v2c.json` | MATLAB |

All networks were trained in PyTorch, exported to ONNX and imported into MATLAB's Deep Learning Toolbox. Tensor-level
parity is reported as 1e-6 to 4e-5 (TECHNICAL_DOCUMENTATION §3). PyTorch remains an explicit fallback
(`INFERENCE_BACKEND=python`, `SEG_ALLOW_PYTHON_FALLBACK=1`). Either choice is recorded in provenance.

### 7.2 Steps

1. **Preprocessing (Ben Graham, no CLAHE).** Circular retinal crop → resize → Gaussian-subtraction contrast
   (`4·img − 4·blur + 128`). This is `preprocessing/ben_graham.py`, imported by both training and serving
   (`inference/branchAInfer.py`, `preprocessBranchATensor.py`), so they can't drift apart. A `clahe_enhance.py`
   exists, but the serving chain doesn't use it. Adding CLAHE dropped agreement with the model's own outputs to
   57.7% (`branchAInfer.py` header).
2. **Camera fingerprint.** `cameraCalibration/classifyCameraFamily.m` uses vignetting, aspect ratio and colour
   gains, cross-checked against the technician-reported camera. A mismatch or an unvalidated camera feeds the tier
   decision.
3. **Localization + fovea gate.** If the fovea heatmap peak is below **0.37** (`segInfer.py`
   `FOVEA_PEAK_THRESHOLD`), the case is marked `foveaUnreliable`. The rule engine then skips quadrant logic and the
   case cannot be Tier A.
4. **Segmentation.** Vessels, hard exudates, and red lesions (separate MA and haemorrhage counts per quadrant).
   Cotton-wool spots are **explicitly not measured**, and shown as such.
5. **Branch A (CNN).** Grade 0–4. Referral uses the **calibrated threshold P(grade ≥ 2) ≥ 0.3873** (temperature
   1.544, method `ordinal_mode_interval_stratified_v3`; `models/calibration_branchA_v2c.json`), not the argmax.
   MC-dropout gives an uncertainty score.
6. **Branch B (rule engine).** `grading/ruleEngineGrade.m` implements the ICDR "4-2-1" rule on quadrant-mapped lesion
   counts with frozen thresholds `redFloor = 3`, `grade3QuadMin = 3`, capped at grade 3 (no validated
   neovascularization signal). It is auditable line by line.
7. **Tier decision** (`gradingOrchestrator.js` `decideTier`), in this order:
   1. branches disagree → **C**;
   2. CNN grade above the rule engine's ceiling → **C**;
   3. capture below the local quality floor → **C**;
   4. otherwise the **conformal tier**.
   Tier A is then demoted to **B** on a camera-probation mismatch, an eye-laterality mismatch, `foveaUnreliable`, or
   an **unvalidated camera**. Every decision stores a human-readable `tierReason`.
8. **Explainability.** Grad-CAM on the classifier's last convolutional activation (`inference/gradcam.py` /
   `explainability/gradCam.m`), a lesion-attention consistency score against the segmentation masks
   (`lesionAttentionConsistency.m`), and a rationale plus downloadable evidence-report PDF (`generateReport.m`).
9. **Urgency hint.** `calculateUrgencyScore.m` orders the review queue from questionnaire risk factors. It is a
   **queue-ordering hint only**: it never changes a grade or confidence.

| Tier | Meaning |
|---|---|
| A | Auto-clear |
| B | AI-assisted review (target under 30 s) |
| C | Full manual review |

---

## 8. MATLAB and Simulink

| Component | MATLAB product | Where | Status (verified 2026-10-02) |
|---|---|---|---|
| PHC quality gate | Image Processing Toolbox | PHC | Live via `matlab -batch` |
| Compiled quality gate | **MATLAB Compiler** + free Runtime | PHC | **Built and committed**: `dist/qualityGate.exe` (`adbdd06`). Runs isolated from the source tree; `testQualityGateDeploy` 23/23. Shipped in the standalone PHC |
| Branch A inference | Deep Learning Toolbox | Central | Live (persistent session, `branchAInferMatlab.m`) |
| Segmentation / localization (4 nets) | Deep Learning Toolbox | Central | Live (`matlabSession/runMatlabInferenceSession.m`) |
| Rule engine, conformal tiering, calibration | MATLAB | Central | Live (`runCasePipeline.m`, `conformalTiering.m`) |
| Grad-CAM + lesion-attention consistency | Deep Learning Toolbox | Central | Live |
| Camera-fingerprint calibration | Image Processing Toolbox | Central | Live |
| Evidence-report PDF | Report Generator (core fallback renderer exists) | Central | Live, on demand |
| District resource model | **Simulink + SimEvents** | Central (scheduled) | `netraSetuPipeline.slx` / `districtScreeningSimEvents.slx` run to completion. The live Resource Recommendations data comes from the pure-MATLAB `referenceQueueingModel.m`; the `.slx` is the weekly cross-check (disabled by default, `SIMULINK_VALIDATION_ENABLED`) |
| Central inference packaging | MATLAB Compiler | Central | Trial targets in `ml-pipeline/deploy/` (`netraSetuCaseMain.m`, `netraSetuInferMain.m`); not the serving path |
| **Resource model as a standalone app** | **Simulink Compiler** + MATLAB Compiler | Any Windows PC (free Runtime) | **Built 2026-10-03**: `simulink-model/deployable/` → `NetraSetuResourceModel.exe` (GUI + `--json`). SimEvents can't generate code, so the app runs `districtResourceModel.slx`, a code-generation-capable model that reproduces `referenceQueueingModel.m` exactly (normal mode, Rapid Accelerator deployment mode, and the compiled exe all verified) |

**Simulink model** (`simulink-model/`): patient images are entities, PHC arrival rates feed a bandwidth-limited
network across three connectivity tiers, and ophthalmologist review is a limited-capacity server where Tier C
pre-empts Tier B. Outputs are queue length, wait time and bottleneck location. Parameters are modelled assumptions,
not field data.

---

## 9. Results

Quoted from `docs/ML_BENCHMARKS.md`, which has the populations, intervals and caveats. Not re-measured here.

**Branch A (`branchA_v2c`), in-domain:**

| Metric | Population | Result |
|---|---|---|
| Quadratic-weighted kappa | Held-out test, n = 628 (APTOS + IDRiD) | 0.884 |
| Referable sensitivity, calibrated threshold | 50-fold cross-fit, n = 1,161 | **95.0%** [92.8, 96.6] |
| Referable specificity, calibrated threshold | same | **91.0%** [88.6, 93.0] |
| Grade-4 exact recall | held-out | 57.4% (31/54) |

**Auto-clear safety (in-domain cross-fit, n = 1,161):**

- 0.0% false auto-clears of referable cases;
- 0.0% false auto-clears of grade ≥ 3 cases;
- 0 grade-4 cases auto-cleared across 1,000 fold assignments.

**Unseen camera (Messidor-2, n = 872):**

- AUC 0.924;
- sensitivity 75.2% and specificity 93.9% at the shipped threshold;
- 2.3% false auto-clears of referable cases (upper bound 5.3%).

This is why **unvalidated cameras can never auto-clear**.

**Segmentation and localization:**

| Model | Result |
|---|---|
| Vessels | Dice 0.777 (CHASE_DB1) and 0.619 (DRIVE, cross-dataset) |
| Hard exudates | Dice 0.583 per image / 0.733 global |
| Red lesions v2 | Dice 0.599 (n = 16, thin evidence) |
| Optic disc / fovea | 16 px / 32 px mean error |

**Rule engine:** 60.2% exact agreement (IDRiD official test split, n = 103).

**Reliability:** full-pipeline soak test, 447/447 IDRiD images graded, 0 failed.

**Failed and therefore not used:** a neovascularization score (AUC 0.29 / 0.38).

**Quality-gate parity (measured 2026-10-02):**

| Comparison | Result |
|---|---|
| Compiled exe vs MATLAB | Every sub-score to 1e-9 |
| JS port vs MATLAB | 0 mismatches on 58 image runs; worst score gap 3.3e-4 |

---

## 10. Deployment: three ways the system runs

### 10.1 Local, full system (the primary, final-round setup)

`npm run dev:all` (`scripts/dev-up.js`) runs these steps:

1. copies `.env.example` files;
2. installs dependencies;
3. starts Postgres in Docker (port 5433);
4. migrates the database;
5. seeds demo users and PHC sites, printing their secrets once;
6. starts both backends and both web apps;
7. waits for health checks and the MATLAB session heartbeat.

| Service | URL |
|---|---|
| PHC web | http://localhost:5173 |
| Central web | http://localhost:5174 |
| Central API | http://localhost:5000 |
| PHC API | http://localhost:4000 |

**Requirements:** Node 18+, Docker, MATLAB R2026a with its toolboxes, Python 3.11, and the model weights
(`npm run models:verify` / `models:fetch`).

To fill the system with realistic cases, run `node scripts/demo-reset.js`, which pushes real public-dataset cases
through the real pipeline.

### 10.2 Hosted online demo (this round only; `render.yaml`)

| Component | Where | Notes |
|---|---|---|
| Central web | **https://centralsys.vercel.app** | Vercel, auto-deploys from `main` |
| PHC web | **https://phcapp.vercel.app** | Vercel, auto-deploys from `main` |
| Central API + Postgres | **https://netrasetu-central.onrender.com** | Render free tier (Docker), Singapore. Migrations, demo users and demo PHC are provisioned at container start |
| PHC API | **https://netrasetu-phc.onrender.com** | Render; JS quality gate (`QUALITY_GATE_ALLOW_FALLBACK=1`); ephemeral SQLite |
| ML inference | **https://netrasetu-ml-inference.onrender.com** | `ml-inference-service/`: Branch A + segmentation on **ONNX Runtime** (closed-form Grad-CAM / MC-dropout) to fit 512 MB; weights from a private release |

- **How it differs from the local system:**
  - no MATLAB on any hosted service;
  - central calls ML over HTTP (`INFERENCE_BACKEND=remote`);
  - the session cookie is cross-site (`COOKIE_SAMESITE=none`);
  - Render auto-deploy is **off**, so redeploys are manual.
- **Status (2026-10-02):**
  - All five URLs answer, and the Vercel apps are built from current `main`.
  - The hosted PHC's capture fix (re-enabled JS gate, `87f50ef` + `d540e9e`) is pushed but **waits for a manual
    Render redeploy**.
  - The hosted central has no `MATLAB_ALLOW_FALLBACK`, which was kept deliberately. So, judging from the code, cases
    submitted there may stop at the rule-engine step. This has not been live-tested.
  - Details: `docs/deployment-changes-2026-10-01.md`, `docs/TASKS_TANUJ_DEPLOYMENT.md`.

### 10.3 Standalone PHC (§5.4)

A Windows zip with the compiled quality gate and bundled Node, which syncs to whichever central is configured.

---

## 11. Security and privacy

- **Central users.** Passwords are hashed with bcryptjs (`routes/auth.js`). Sessions are a signed JWT (HS256) in an
  **httpOnly** cookie, 12 h by default, with a `Secure` flag (`services/authConfig.js`, `authTokens.js`). Roles are
  enforced server-side on every route, including `/media`.
- **PHC → central.** Every ingestion call requires a per-PHC API key. Only its hash is stored (`hashApiKey`). Keys
  are issued by `npm run provision-phc-key` and shown once.
- **PHC technicians.** Passwords use **scrypt** (`phc-local-app/backend/services/passwords.js`). Auth is on by default
  because the PHC backend listens on the clinic LAN for phone pairing.
- **Encryption at rest.** Central images, Grad-CAM overlays and report PDFs use AES-256-GCM
  (`services/mediaCrypto.js`, `MEDIA_ENCRYPTION_KEY`).
- **In transit.** Both backends can serve HTTPS directly (`TLS_KEY_PATH`/`TLS_CERT_PATH`,
  `LOCAL_TLS_KEY_PATH`/`LOCAL_TLS_CERT_PATH`; TLS 1.2+). The hosted demo uses the platforms' TLS. Phone↔PC traffic
  is sealed end to end regardless.
- **Audit.** Patient-data access is written to `access_log` on both central and PHC.
- **Secrets** are read from the environment. Every service has an `.env.example`, and `.env` files are git-ignored.
- **Stated gaps** (prototype floor, not a compliance claim):
  - PHC local stores are not encrypted;
  - no refresh tokens, rate limiting or formal key rotation;
  - no penetration test;
  - the hosted PHC's demo technician password is a literal in its Dockerfile (flagged in the deployment notes).

---

## 12. Testing and verification

| Suite | Command | State |
|---|---|---|
| PHC backend (auth/peer, sync flow, quality-gate engine) | `cd phc-local-app/backend && npm test` | **41/41 pass** (2026-10-02) |
| Quality gate packaging | `matlab -batch testQualityGateDeploy` | **23/23** (isolated exe) |
| Quality gate: compiled vs JS | `node verify_quality_gate_parity.js` | **0 mismatches** |
| PHC web | `cd phc-local-app/frontend && npm test` | payload contract tests |
| Mobile | `npm test`, `test:sync`, `test:parity`, `type-check` | per mobile README |
| Conformal / calibration | `ml-pipeline/tests/` (MATLAB + Python golden vectors) | 90/90 reported in ML_BENCHMARKS §7 |
| Fovea gate | `ml-pipeline/test_fovea_gate.py` | 12/12 reported |
| End-to-end PHC flow | `tests/e2e/verify_phc_flow.js` | – |
| Repo-root checks | 17 × `verify_*.js` (provenance, engine fallback parity, auth, TLS, ingestion, pipeline, urgency inputs, camera vocabulary, mobile lens, demo dry run…) | run individually |
| Full dataset soak | `node scripts/test-full-dataset.js` | 447/447 graded (reported) |

**Gap:** the central backend has no automated unit suite of its own. It is covered by the repo-root `verify_*.js`
scripts and the soak test.

---

## 13. Configuration reference

Every service reads its own `.env`, and every variable is documented in that service's `.env.example`. The most
important ones:

| Service | Key variables |
|---|---|
| Central backend | `DATABASE_URL`, `JWT_SECRET`, `AUTH_ENABLED`, `PHC_AUTH_ENABLED`, `CORS_ALLOWED_ORIGINS`, `COOKIE_SAMESITE`, `MEDIA_ENCRYPTION_KEY`, `MATLAB_EXECUTABLE`, `INFERENCE_BACKEND` (`matlab` / `python` / `remote`), `SEG_INFERENCE_BACKEND`, `MATLAB_ALLOW_FALLBACK`, `ML_INFERENCE_SERVICE_URL`, `TWILIO_*`, `SMS_DRY_RUN`, `TLS_*`, `SIMULINK_VALIDATION_ENABLED` |
| PHC backend | `CENTRAL_API_URL`, `PHC_CODE`, `PHC_ID`, `PHC_API_KEY`, `LOCAL_AUTH_ENABLED`, `MATLAB_EXECUTABLE`, `QUALITY_GATE_EXE`, `QUALITY_GATE_ALLOW_FALLBACK`, `CORS_ALLOWED_ORIGINS`, `LOCAL_TLS_*`, `SYNC_*` |
| Central web | `VITE_CENTRAL_API_BASE`, `VITE_DATA_MODE` |
| PHC web | `VITE_LOCAL_API_BASE`, `VITE_DATA_MODE`, `VITE_PHC_NAME` |
| Mobile | `EXPO_PUBLIC_CENTRAL_API_URL`, `EXPO_PUBLIC_PHC_API_KEY`, `EXPO_PUBLIC_PHC_CODE` |

No app has a built-in server URL. An unset URL shows an on-screen error.

---

## 14. Datasets

All public, with no real patient data (`docs/TECHNICAL_DOCUMENTATION.md` §11):

| Dataset | Origin | Use |
|---|---|---|
| APTOS 2019 | India, Aravind Eye Hospital | Classifier training and test |
| IDRiD | India, Nanded | Classifier, lesion and localization models, rule-engine calibration |
| EyePACS (curated subset) | – | v2c classifier training |
| CHASE_DB1 | – | Vessel segmentation |
| DRIVE | – | Vessel cross-dataset evaluation only |
| Messidor-2 | France | External validation only; never used for training or thresholds |

---

## 15. Corrections to older docs

Found while checking this document against the code. Fix these in the README rather than copying the old text.

| Old claim | Where | What the code says |
|---|---|---|
| "No `.exe` has been compiled; `dist/` is empty" | TECHNICAL_DOCUMENTATION §3.1, §4.2, §10.4 | Built, fixed and committed (`adbdd06`), tested isolated (23/23), shipped in the standalone PHC |
| Preprocessing is "CLAHE, illumination normalization, denoising and Ben Graham crop" | TECHNICAL_DOCUMENTATION §6.2 | Serving uses **Ben Graham only** (crop → resize → Gaussian subtraction). CLAHE is explicitly not used (`branchAInfer.py` header) |
| "PHC desktop and mobile: bcrypt technician accounts" | README Security; TECHNICAL_DOCUMENTATION §9 | PHC technicians use **scrypt** (`services/passwords.js`). Central users use bcryptjs |
| Central login is "session-based" | README Security | A signed **JWT in an httpOnly cookie** (functionally a session, 12 h) |
| The JS quality gate "numerically verified … within about 0.005" | TECHNICAL_DOCUMENTATION §6.1 | That was the old port, which was then switched off for diverging. The 2026-10-02 port: 0 mismatches, worst gap 3.3e-4 |
| §12.2 "Current deployment" and the README demo links are placeholders | TECHNICAL_DOCUMENTATION §12.2; README | Fill them from §10.2 here |
| A dedicated "System Health" screen | TECHNICAL_DOCUMENTATION §5.2 | No separate route. System-health data shows inside PHC Health and the case status banner (`/api/v1/admin/system-health`) |
| Quality checks include "contrast, colour balance, border proportion" | TECHNICAL_DOCUMENTATION §6.1 | The gate computes seven scores: focus, illumination, FOV, coverage, glare, motion, occlusion (`qualityGateMain.m`) |

---

## 16. Known limitations and open items

**Limitations (stated on purpose):**

- **Decision support, not diagnosis.** Every positive is confirmed by an ophthalmologist.
- **Domain shift.** Sensitivity is 95.0% in-domain but 75.2% on an unseen camera, which is why unvalidated cameras
  never auto-clear.
- **Grade 4.** Exact grade-4 recall is 57.4%. Safety comes from threshold referral and CNN-grade-4 → Tier C routing.
- **Thin evidence and narrow coverage.** Red-lesion evidence rests on 16 images. Cotton-wool spots, venous beading
  and IRMA are not detected. The NV score failed validation and is unused.
- **Rule engine.** 60.2% exact agreement. Its value is as an independent tripwire.
- **Not validated against labels or the field.** Quality-gate thresholds are engineered heuristics. Simulink
  parameters are assumptions. There is no clinical or prospective data and no subgroup analysis.
- **Grading queue.** It is in-memory, so a case failed while MATLAB is down is not automatically re-queued.

**Open items (2026-10-02):**

1. Manual Render redeploy of `netrasetu-phc` to put the hosted capture fix live (Tanuj).
2. PHC002 `PHC_ID`/`PHC_API_KEY` from the hosted central, then baked into the standalone zip (Tanuj → Saad).
3. Test the standalone PHC on a PC with only the MATLAB Runtime installed.
4. Hosted central grading of new uploads is unverified (`MATLAB_ALLOW_FALLBACK` kept unset by decision).
5. The mobile app is in progress, and no APK has been published.
6. Remove the leftover `experimenting Frontend/` folder.

---

## 17. Documentation index

| Document | Contents |
|---|---|
| `docs/PROJECT_DOCUMENTATION.md` | This file: the whole project, checked against the code |
| `docs/TECHNICAL_DOCUMENTATION.md` | Design rationale and implementation status (see §15 for stale points) |
| `docs/ML_BENCHMARKS.md` | Every ML metric with population, n, interval, caveats |
| `docs/api-contracts.md` | API source of truth |
| `docs/system-design-v4.md` | Locked design document |
| `docs/RELEASE.md` | Served model versions + checksums |
| `docs/RUNTIME.md`, `docs/DEMO_SETUP.md`, `docs/DEMO_RUNBOOK.md`, `docs/DEMO_SCRIPT.md`, `docs/COMMANDS.md` | Running and demoing |
| `docs/SECURITY.md`, `docs/id-format-spec.md`, `docs/peer-sync-protocol.md` | Security posture, ID scheme, phone↔PC protocol |
| `docs/deployment-changes-2026-10-01.md`, `docs/TASKS_TANUJ_DEPLOYMENT.md` | Hosted-demo deployment notes and pending tasks |
| `docs/STALE_CLAIMS_AUDIT.md`, `docs/INTEGRATION_AUDIT.md`, `docs/NetraSetu_Build_Audit.md` | Earlier audits |
| `simulink-model/README.md`, `phc-local-app/mobile/README.md`, `ml-inference-service/README.md`, `tests/fixtures/README.md` | Component READMEs |

---

## 18. Notes for writing the README

What a judge needs in the first screen, in this order:

1. **One sentence and a picture.** "A rural technician screens for DR in minutes; two independent AI branches
   cross-check every image; an ophthalmologist confirms every positive." Add the §3 diagram or a screenshot of
   Case Detail with the Grad-CAM and branch comparison.
2. **Live links that work** (§10.2), with the demo login handed over separately, never written in the README. Add a
   one-line note on which hosted features are live.
3. **Headline results with their caveats** (§9). Honesty about the 75.2% unseen-camera number is a strength of this
   project; keep it.
4. **What makes it different:**
   - two branches with a mandatory-review tripwire;
   - conformal tiers that never auto-clear unvalidated cameras;
   - an offline-first PHC;
   - engine provenance on every output;
   - MATLAB/Simulink across the pipeline;
   - a no-licence standalone PHC via MATLAB Compiler.
5. **How to run it** (§10.1), in three commands.
6. **Limitations** (§16), short.

Avoid in the README:

- every stale claim in §15;
- any password, API key or Render secret;
- calling the hosted demo the "production" setup (production is §12.1 of TECHNICAL_DOCUMENTATION; the hosted demo is
  a reduced, MATLAB-free variant).
