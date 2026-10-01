# NetraSetu — Explainable AI for Diabetic Retinopathy Screening in Rural India

**Smart India Hackathon 2026 — PS 26038** · Team "Game Of Codes" (Tanuj, Saad, Kankshi, Parth, Vedant)

NetraSetu lets a minimally trained technician at a rural Primary Health Centre (PHC) screen a patient for diabetic retinopathy (DR) in minutes. Two independent AI branches cross-check every image, and a remote ophthalmologist confirms every positive result before it reaches the patient.

India has only 20,944 ophthalmologists, about 15 per million people (AIIMS Delhi national survey, 2025), and blindness is 1.37× more prevalent in rural India than in urban areas (National Blindness & Visual Impairment Survey 2015–19). Yet 90% of DR-related vision loss is preventable with timely referral. The gap is specialist capacity, not awareness. NetraSetu moves the screening step to the PHC, and it turns the specialist's job into confirming flagged cases in seconds instead of screening everyone.

---

## Headline results

Full numbers, populations, intervals and caveats are in **[`docs/ML_BENCHMARKS.md`](docs/ML_BENCHMARKS.md)**.

**DR severity classifier (deployed `branchA_v2c`), in-domain:**

| Metric | Population | Result | SIH target |
|---|---|---|---|
| Quadratic-weighted kappa | Held-out test, n = 628 (APTOS + IDRiD) | **0.884** | — |
| Referable-DR sensitivity, live calibrated threshold | 50-fold cross-fit, n = 1,161 | **95.0%** [92.8, 96.6] | > 90% ✅ |
| Referable-DR specificity, live calibrated threshold | 50-fold cross-fit, n = 1,161 | **91.0%** [88.6, 93.0] | > 85% ✅ |

**Safety of the auto-clear tier (conformal, in-domain cross-fit, n = 1,161):**

| Metric | Result |
|---|---|
| False auto-clears of referable cases | **0.0%** |
| False auto-clears of grade ≥ 3 cases | **0.0%** |
| Grade-4 cases auto-cleared, across 1,000 fold assignments | **0** |

**On a camera the model has never seen (Messidor-2, untouched report half, n = 872).** Stated because it matters:

| Metric | Result |
|---|---|
| AUC (referable) | 0.924 (vs. ~0.98 in-domain) |
| Sensitivity / specificity at the shipped threshold | **75.2%** / 93.9% |
| False auto-clears of referable cases | 2.3% (upper bound 5.3%) |
| False auto-clears of grade ≥ 3 cases | 0% |

The >90% sensitivity target does not hold on an unvalidated camera. So the system's policy is that **no case from a camera or site that hasn't been locally validated can auto-clear**; it always gets human review.

**Segmentation and localization:**

| Model | Test data | Result |
|---|---|---|
| Vessel U-Net | CHASE_DB1 (held out) | Dice 0.777 |
| Hard-exudate U-Net | IDRiD | Dice 0.583 per image / 0.733 global |
| Red-lesion U-Net v2 (microaneurysm + haemorrhage, 3-class) | IDRiD val, n = 16 (thin) | Dice 0.599 |
| Optic disc / fovea localization | IDRiD | 16 px / 32 px mean error (native resolution) |

**System reliability:**

| Metric | Result |
|---|---|
| Full-pipeline soak test: every IDRiD image on disk through capture → quality gate → sync → grading | **447/447 graded, 0 failed, 0 timed out** |

**Read the caveats, not just the tables** (all in `docs/ML_BENCHMARKS.md` §8):

- sensitivity drops to 75.2% on an unseen camera;
- exact grade-4 recall is 57.4%, safe only because referral uses a calibrated threshold and CNN grade-4 forces full review;
- the red-lesion evidence rests on 16 images;
- the neovascularization score was built, tested and failed, so it is not used.

This project reports what it hasn't proven, not just what it has.

---

## System architecture

```
Explainable-AI-for-Diabetic-Retinopathy-in-Rural-India/
├── phc-local-app/
│   ├── frontend/          # Desktop PHC technician app (React + Vite)
│   ├── backend/           # PHC local API, SQLite queue, on-device quality gate
│   └── mobile/            # Expo/React Native technician app — same spec, gallery/lens import
├── central-system/
│   ├── frontend/          # Ophthalmologist + district admin web app (React + Vite)
│   └── backend/           # Central API, grading pipeline, PostgreSQL, MATLAB + Python inference
├── simulink-model/        # SimEvents discrete-event resource-allocation model
├── datasets/              # Public datasets only — git-ignored
└── docs/                  # Design, API contracts, benchmarks, demo runbook
```

**Two independent grading branches** grade every image:

- **Branch A:** an EfficientNet-B0 CNN, trained in PyTorch with an ordinal-aware loss, exported to ONNX and imported into MATLAB's Deep Learning Toolbox, with tensor-level parity verified.
- **Branch B:** an explicit, auditable ICDR "4-2-1" rule engine operating on quadrant-mapped lesion counts. Those counts come from dedicated models for vessels, optic disc/fovea, hard exudates, and microaneurysms/haemorrhages.

When the branches agree, the agreement supports the case's confidence tier. When they disagree, the case goes to **mandatory human review with an explicit grade decision**; the disagreement is never averaged away.

**Confidence routing** combines several signals into one tier per case:

- temperature-scaled calibration;
- referable-stratified conformal prediction;
- branch agreement;
- camera validation status;
- capture-quality flags.

The resulting tiers are **A** (auto-clear), **B** (AI-assisted review) and **C** (full manual review). Review effort goes where the model is genuinely uncertain.

**Explainability:** a Grad-CAM heatmap, with a lesion-attention consistency check against the segmentation masks, is assembled together with the lesion evidence and the rule-engine criteria that fired into one rationale per case.

**Offline-first front-ends:** both store every capture locally first. They sync immediately when online. When offline, captures queue locally and upload in resumable chunks, prioritized by urgency then age, with a manual export fallback for multi-day outages.

Full design and implementation status: **[`docs/TECHNICAL_DOCUMENTATION.md`](docs/TECHNICAL_DOCUMENTATION.md)**.

---

## Live demo links (online submission)

See [`docs/TECHNICAL_DOCUMENTATION.md` §12](docs/TECHNICAL_DOCUMENTATION.md) for exactly what each deployed link runs and what it doesn't.

| What | Link |
|---|---|
| Central web (ophthalmologist / district admin) | _to be added after deployment_ |
| PHC technician web (hosted demo station) | _to be added after deployment_ |
| Android app (APK) | _to be added after deployment_ |
| Demo video | _to be added_ |

---

## Run locally

One command starts the whole system: Postgres, migrations, seed data, both backends, both web front-ends, and the persistent MATLAB session.

### Prerequisites

| | Version | Notes |
|---|---|---|
| **Node.js** | 18+ (22 LTS tested) | npm comes with it |
| **Docker** | Docker Desktop / Engine with Compose v2 | Runs Postgres only |
| **MATLAB** | R2026a (tested: Update 5) | Required for the default engine (`INFERENCE_BACKEND=matlab`). Toolboxes: Deep Learning, Image Processing, Statistics and Machine Learning, Medical Imaging. Optional: Simulink + SimEvents (resource model), MATLAB Compiler (standalone quality-gate executable), MATLAB Report Generator (evidence-report PDF; a core-MATLAB fallback renderer exists). `matlab` must be on `PATH`, or set `MATLAB_EXECUTABLE` in both backends' `.env` |
| **Python** | 3.11 (conda env `dr_screening`) | Needed for preprocessing and the segmentation worker: `pip install -r central-system/backend/ml-pipeline/requirements.txt` |

There is no Redis: the grading queue runs in-process in the central backend.

### Model weights (required, not in git)

Trained weights (~1.5 GB) are git-ignored and distributed separately. Their SHA-256 checksums are tracked in git, so a fresh clone can verify it has the exact bytes the results above were measured with:

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

On first run this:

1. copies every service's `.env.example` to `.env` (existing `.env` files are never touched);
2. runs `npm install` in each service that has no `node_modules`;
3. starts Postgres in Docker (host port **5433**);
4. applies migrations;
5. seeds two demo users and two PHC sites, **printing their passwords and API keys once**;
6. starts every service, waits for health checks and the MATLAB session heartbeat, and prints:

| Service | URL |
|---|---|
| PHC web (technician) | http://localhost:5173 |
| Central web (ophthalmologist / district admin) | http://localhost:5174 |
| Central API | http://localhost:5000 (`/health`) |
| PHC local API | http://localhost:4000 (`/health`) |
| Postgres | `localhost:5433`, user `netrasetu`, db `dr_screening_central` |

Ctrl+C stops the four services; Postgres and the MATLAB session keep running (`npm run db:down` stops Postgres). `npm run dev:check` runs the same start sequence, prints the summary, and exits non-zero if anything is unhealthy.

**For a fully populated, demo-ready state:** run `node scripts/demo-reset.js`. It pushes real public-dataset cases through the real pipeline. See `docs/DEMO_RUNBOOK.md` for the scene-by-scene walkthrough.

Lost the printed credentials? `node scripts/seed-demo.js --force --write-phc-env` issues new ones.

### Configuration

Every service reads its own `.env`, and each `.env.example` documents every variable it reads.

| File | Key variables |
|---|---|
| `central-system/backend/.env` | `DATABASE_URL`, `CORS_ALLOWED_ORIGINS`, `AUTH_ENABLED`, `JWT_SECRET`, `PHC_AUTH_ENABLED`, `MATLAB_EXECUTABLE`, `INFERENCE_BACKEND`, `MEDIA_ENCRYPTION_KEY` |
| `phc-local-app/backend/.env` | `CENTRAL_API_URL`, `PHC_CODE`, `PHC_ID`, `PHC_API_KEY`, `MATLAB_EXECUTABLE`, `LOCAL_AUTH_ENABLED` |
| `central-system/frontend/.env` | `VITE_CENTRAL_API_BASE`, `VITE_DATA_MODE` |
| `phc-local-app/frontend/.env` | `VITE_LOCAL_API_BASE`, `VITE_DATA_MODE` |
| `phc-local-app/mobile/.env` | `EXPO_PUBLIC_CENTRAL_API_URL`, `EXPO_PUBLIC_PHC_API_KEY`, `EXPO_PUBLIC_PHC_CODE` |

No app has a built-in server URL. An unset one shows an on-screen error, never a silent default.

### Data mode: live vs. demo

`VITE_DATA_MODE` in each web front-end's `.env`:

- **`live`** (default): every screen calls the real backend, and a failed request shows an error, never mock data.
- **`mock`**: fixture data only, no backend needed, with a permanent **"DEMO DATA"** banner on every page.

Mock data never appears as a silent fallback when a real request fails. That is a system-wide, non-negotiable rule.

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

## Security

Security measures in place:

- **Authentication on every application:**
  - central web: session-based, bcrypt, role-enforced server-side (ophthalmologist / district admin);
  - PHC desktop and mobile: bcrypt technician accounts;
  - PHC-to-central ingestion: a per-PHC API key.
- **Encryption at rest on the central server:** AES-256-GCM for stored images, Grad-CAM overlays and report PDFs.
- **Audit log:** every access to patient data is recorded.

This is a **prototype-stage security floor, not a production compliance claim**. The PHC-side local databases (desktop SQLite, mobile store) are not yet encrypted, and no penetration test or security audit has been done. See `docs/TECHNICAL_DOCUMENTATION.md` §9.

---

## Datasets

Only public research datasets are used anywhere in this project — **no real patient data** in seeds, tests, demos or deployments:

- APTOS 2019 (India, Aravind Eye Hospital);
- IDRiD (India, Nanded);
- EyePACS (curated subset);
- CHASE_DB1;
- DRIVE (evaluation only);
- Messidor-2 (external validation only).

Details are in `docs/TECHNICAL_DOCUMENTATION.md` §11.

---

## Documentation index

| Document | Contents |
|---|---|
| [`docs/TECHNICAL_DOCUMENTATION.md`](docs/TECHNICAL_DOCUMENTATION.md) | System design, architecture, ML pipeline, implementation status, deployment |
| [`docs/ML_BENCHMARKS.md`](docs/ML_BENCHMARKS.md) | Every ML metric, with population, n, interval and caveats |
| [`docs/api-contracts.md`](docs/api-contracts.md) | Request/response shapes; the source of truth over any other doc |
| [`docs/system-design-v4.md`](docs/system-design-v4.md) | Original locked design document and rationale |
| [`docs/STALE_CLAIMS_AUDIT.md`](docs/STALE_CLAIMS_AUDIT.md) | What in the design doc is resolved vs. still accurate, verified against code |
| [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md) | Scene-by-scene demo walkthrough |
| [`docs/RELEASE.md`](docs/RELEASE.md) | Served model versions and checksums |

---

## Design philosophy

The UI is high-contrast, cyber-brutalist and clinical (`#E63B2E` / `#0A0A0A`), with monospace telemetry. One standing rule runs through every screen in every app: **a failure never gets to look like a success.** A network error, a timeout and a working result are always visibly distinguishable.
