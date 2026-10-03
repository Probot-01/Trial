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
| **MATLAB** | R2026a (tested: Update 5) | Required for the default engine (`INFERENCE_BACKEND=matlab`). Toolboxes: Deep Learning, Image Processing, Statistics and Machine Learning, Medical Imaging. Optional: Simulink + SimEvents (resource model), MATLAB Compiler (standalone executables), MATLAB Report Generator (evidence PDF; a core-MATLAB fallback renderer exists). `matlab` must be on `PATH`, or set `MATLAB_EXECUTABLE` |
| **Python** | 3.11 (conda env `dr_screening`) | Preprocessing and the segmentation worker: `pip install -r central-system/backend/ml-pipeline/requirements.txt` |

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

## Headline ML results

Full numbers, populations, intervals and caveats: **[`docs/ML_BENCHMARKS.md`](docs/ML_BENCHMARKS.md)**.

**DR severity classifier (deployed):**

| Metric | Population | Result | SIH target |
|---|---|---|---|
| Quadratic-weighted kappa | Held-out test, n = 628 | **0.884** | — |
| Referable-DR sensitivity, live threshold | 50-fold cross-fit, n = 1,161 | **95.0%** [92.8, 96.6] | > 90% ✅ |
| Referable-DR specificity, live threshold | 50-fold cross-fit, n = 1,161 | **91.0%** [88.6, 93.0] | > 85% ✅ |

**Safety of the auto-clear tier** (no grade-4 case has ever auto-cleared without review, across
1,000 fold assignments) and **external validation on a camera the model has never seen**
(Messidor-2, n = 872: sensitivity drops to 75.2%, which is why unvalidated cameras are
capped at mandatory human review) are both in the benchmarks doc in full, with the reasoning for
why that's a safety feature, not a hidden flaw.

**Segmentation:** vessel Dice 0.777, hard-exudate Dice 0.583/0.733, red-lesion (MA+haemorrhage)
Dice 0.599, optic-disc localization within one disc radius 98.7% of the time.

**Full technical documentation** (system design, every component explained, implementation
status, and the dual-deployment architecture in depth) lives in
**[`docs/TECHNICAL_DOCUMENTATION.md`](docs/TECHNICAL_DOCUMENTATION.md)** and, as a shareable PDF
alongside the ML benchmarks and MATLAB-application deliverables, at:

📁 **Google Drive:** _[link to be added]_

---

## Simulink models

Two SimEvents discrete-event models (`simulink-model/`), built entirely from script
(`buildDistrictScreeningModel.m`, `buildFullPipelineModel.m`), validate the system's capacity
assumptions and demo its queueing behavior under load.

<p>
  <img src="docs/ppt-audit/assets/districtScreeningSimEvents_thumbnail.png" width="420" alt="District-scale SimEvents queueing model: PHC arrivals, tier triage, preemptive reviewer pool">
  <br><em>District queueing model — PHC arrivals → tier triage (Tier A auto-clears) → a
  two-ophthalmologist review pool where Tier C preempts Tier B.</em>
</p>

<p>
  <img src="docs/ppt-audit/assets/netraSetuPipeline_thumbnail.png" width="420" alt="Full watchable pipeline model with live sliders for arrival rate, review speed, network and grading availability">
  <br><em>Full-pipeline model — the entire capture→referral flow as a live, watchable simulation
  with sliders for patient load, review speed, and network/grading outages.</em>
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
executables — see the MATLAB-applications deliverables in the Drive folder above). This is the
configuration the Simulink models validate and the one intended for a real PHC rollout.

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

## Prototype

_Screenshots to be added._

---

## Research and references

_To be added — research notes and references collected during the project's initial planning._

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
| [`docs/system-design-v4.md`](docs/system-design-v4.md) | Original locked design document and rationale |
| [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md) | Scene-by-scene demo walkthrough |
| [`docs/RELEASE.md`](docs/RELEASE.md) | Served model versions and checksums |

---

## Design philosophy

The UI is high-contrast, cyber-brutalist and clinical (`#E63B2E` / `#0A0A0A`), with monospace
telemetry. One standing rule runs through every screen in every app: **a failure never gets to
look like a success.** A network error, a timeout and a working result are always visibly
distinguishable.
