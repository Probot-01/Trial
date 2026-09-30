# NetraSetu — Explainable AI for Diabetic Retinopathy Screening in Rural India

**Smart India Hackathon — PS 26038** · Team "Game Of Codes" (Tanuj, Saad, Kankshi, Parth, Vedant)

A dual-tier AI-powered clinical screening platform that lets a minimally-trained technician at a
rural Primary Health Centre (PHC) screen a patient for diabetic retinopathy (DR) in minutes, with
two independent AI models cross-checking each other and a remote ophthalmologist confirming every
positive result before it reaches the patient.

India has roughly one ophthalmologist per 100,000 rural people, and DR affects about 18% of the
country's 77M+ diabetic adults. Early screening prevents 90% of DR-related blindness — the gap is
specialist capacity, not awareness. NetraSetu closes that gap by moving the screening decision to
the edge and the diagnostic confirmation to a specialist who reviews in seconds, not minutes.

---

## Headline results

Full numbers, sources, and reproduction commands: **[`docs/ML_BENCHMARKS.md`](docs/ML_BENCHMARKS.md)**.
Every figure below is measured by code in this repository, independently re-run and verified —
nothing is projected.

| Metric (deployed classifier, official 103-image IDRiD test set) | Result |
|---|---|
| Referable-DR (grade ≥ 2) sensitivity | **100%** (64/64) |
| Referable-DR specificity | 82.1% |
| Quadratic-weighted kappa | 0.841 |
| Grade-4 (proliferative DR) recall | **13/13** |
| Cases safely auto-cleared with no specialist review (Tier A), zero false clears | 4 / 103 |

| Statistical safety validation (cross-fit, n=1161, 50 folds) | Result |
|---|---|
| Grade-4 cases ever auto-cleared without review, across 1000 fold-assignments | **0** |
| False auto-clear rate, referable and grade≥3 cases | **0.0%** |

| Segmentation model | Test set | Dice |
|---|---|---|
| Vessel U-Net | CHASE_DB1 (in-domain) | 0.80 |
| Hard-exudate U-Net | IDRiD heldout | 0.67 |
| Optic-disc localization | IDRiD heldout, n=77 | 98.7% within 1 disc radius |

| System reliability | Result |
|---|---|
| Full-dataset backend soak test (447 real IDRiD images, real capture→quality-gate→sync→grading pipeline) | **447/447 graded, 0 failed, 0 timeout** |

**Read the caveats, not just the table.** Specificity is honestly below the >85% target even
though sensitivity clears its >90% target; the calibration population overlaps with the test
population in §1's headline numbers; the deployed red-lesion segmentation model has no
independently measured accuracy score of its own yet. All of this is stated plainly, with sources,
in `docs/ML_BENCHMARKS.md` §6 — this project reports what it hasn't proven, not just what it has.

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
├── datasets/              # Public datasets only (IDRiD, APTOS, Messidor-2, CHASE_DB1) — git-ignored
└── docs/                  # Design, API contracts, benchmarks, demo runbook
```

**Two independent AI branches grade every image**, not just one:
- **Branch A** — an EfficientNet-B0 CNN, ordinal-aware training, run via a persistent MATLAB
  session (trained in PyTorch, imported via ONNX).
- **Branch B** — an explicit, auditable ICDR/ETDRS rule engine operating on quadrant-mapped lesion
  counts from dedicated segmentation models (vessels, optic disc/fovea, hard exudates,
  microaneurysms/haemorrhages).

When the branches agree, that agreement is itself evidence supporting the case's confidence tier.
When they disagree, the case is forced into mandatory human review with a required explicit
resolution — never averaged away as noise.

**Confidence routing** combines temperature-scaled calibration, Monte Carlo Dropout uncertainty,
and class-conditional conformal prediction into one tier per case (A: auto-clear · B: AI-assisted
review · C: full manual review), so review effort goes where the model is genuinely uncertain, not
just where the predicted severity is highest.

**Grad-CAM explainability** shows exactly which pixels drove the classifier's decision, validated
with a lesion-attention consistency score, assembled with the lesion evidence and rule-engine
reasoning into one rationale per case.

**Offline-first, both front-ends.** Every capture is stored locally first and transmitted
opportunistically — immediately if the network is up, queued (chunked, resumable, urgency-then-age
prioritized) if it isn't, with a manual export-to-drive fallback for outages measured in days.

Full design rationale and current implementation status: **[`docs/TECHNICAL_DOCUMENTATION.md`](docs/TECHNICAL_DOCUMENTATION.md)**.

---

## Run locally

One command starts the whole system: Postgres, migrations, seed data, both backends, both web
frontends, and the persistent MATLAB session.

### Prerequisites

| | Version | Notes |
|---|---|---|
| **Node.js** | 18+ (22 LTS tested) | npm comes with it |
| **Docker** | Docker Desktop / Engine with Compose v2 | runs Postgres only |
| **MATLAB** | R2026a (tested: Update 5) | required for the default engine (`INFERENCE_BACKEND=matlab`). Toolboxes: **Deep Learning**, **Image Processing**, **Statistics and Machine Learning**, **Medical Imaging**. Optional: **Simulink + SimEvents** (resource-model co-validation), **MATLAB Compiler** (standalone quality-gate exe). `matlab` must be on `PATH`, or set `MATLAB_EXECUTABLE` in both backends' `.env` |
| **Python** | 3.11 (conda env `dr_screening`) | only for the Python segmentation worker / `INFERENCE_BACKEND=python`: `pip install -r central-system/backend/ml-pipeline/requirements.txt` |

No Redis — the grading queue runs in-process in the central backend.

### Model weights (required, not in git)

Trained model weights (~1.5 GB) are git-ignored and distributed separately, with SHA-256 checksums
tracked in git so a fresh clone can verify it has the exact bytes the results above were measured
with:

```bash
npm run models:verify                              # check what's already on disk
node scripts/fetch-models.js --url <archive-link>   # or: download + extract + verify in one step
```

Get the archive link (or the archive itself) from whoever holds it. Full details, served model
versions, and checksums: `docs/RELEASE.md`.

### Start

```bash
git clone <repo> && cd SIH_2026
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

Ctrl+C stops the four services; Postgres and the MATLAB session keep running (`npm run db:down`
stops Postgres). `npm run dev:check` runs the same start sequence, prints the summary, then exits
non-zero if anything is unhealthy.

**Want a fully populated, demo-ready state in one command instead** (real cases pushed through the
real pipeline, not just an empty running stack)? `node scripts/demo-reset.js` — see
`docs/DEMO_RUNBOOK.md` for the full scene-by-scene walkthrough, or `docs/DEMO_SCRIPT.md` for a
condensed ~6-minute video script.

Lost the printed credentials? `node scripts/seed-demo.js --force --write-phc-env` issues new ones.

### Configuration

Every service reads its own `.env`; each `.env.example` documents every variable it reads.

| File | Key variables |
|---|---|
| `central-system/backend/.env` | `DATABASE_URL`, `CORS_ALLOWED_ORIGINS`, `AUTH_ENABLED`, `JWT_SECRET`, `PHC_AUTH_ENABLED`, `MATLAB_EXECUTABLE`, `INFERENCE_BACKEND` |
| `phc-local-app/backend/.env` | `CENTRAL_API_URL`, `PHC_CODE`, `PHC_ID`, `PHC_API_KEY`, `MATLAB_EXECUTABLE`, `LOCAL_AUTH_ENABLED` |
| `central-system/frontend/.env` | `VITE_CENTRAL_API_BASE`, `VITE_DATA_MODE` |
| `phc-local-app/frontend/.env` | `VITE_LOCAL_API_BASE`, `VITE_DATA_MODE` |
| `phc-local-app/mobile/.env` | `EXPO_PUBLIC_CENTRAL_API_URL`, `EXPO_PUBLIC_PHC_API_KEY`, `EXPO_PUBLIC_PHC_CODE` |

No app has a built-in server URL — an unset one shows an on-screen error, never a silent default.

### Data mode: live vs. demo

`VITE_DATA_MODE` in each web frontend's `.env`:
- **`live`** (default): every screen calls the real backend; a failed request shows an error, never
  mock data.
- **`mock`**: fixture data only, no backend needed, with a permanent **"DEMO DATA"** banner on
  every page.

Nothing switches between the two at runtime, and mock data never appears as a silent fallback on a
real request's failure — that is a system-wide, non-negotiable rule (see
`docs/TECHNICAL_DOCUMENTATION.md` §1).

### Running a service on its own

```bash
npm run db:up && npm run db:migrate && npm run db:seed    # database only
cd central-system/backend  && npm start                    # :5000
cd phc-local-app/backend   && npm start                    # :4000
cd central-system/frontend && npm run dev                  # :5174 (strictPort)
cd phc-local-app/frontend  && npm run dev                  # :5173 (strictPort)
cd phc-local-app/mobile    && npx expo start                # Expo Go, same LAN as the backends
```

---

## Security

Real authentication on every application: central web (session/bcrypt, role-enforced), PHC
desktop and mobile (bcrypt/session, technician accounts via `npm run technician -- add`), AES-256
encryption at rest for stored images and reports, and an audit log of every access to patient data.
This is a **prototype-stage security floor, not a production compliance claim** — see
`docs/TECHNICAL_DOCUMENTATION.md` §9 for exactly what is and isn't covered.

---

## Datasets

Only public datasets are used anywhere in this project — **no real patient data**, in seeds, tests,
or deployments: APTOS 2019, IDRiD, CHASE_DB1, Messidor-2. See `docs/TECHNICAL_DOCUMENTATION.md` §11.

---

## Documentation index

| Document | Contents |
|---|---|
| [`docs/TECHNICAL_DOCUMENTATION.md`](docs/TECHNICAL_DOCUMENTATION.md) | Full system design, architecture, ML pipeline, current implementation status |
| [`docs/ML_BENCHMARKS.md`](docs/ML_BENCHMARKS.md) | Every measured ML metric, with sources and reproduction commands |
| [`docs/api-contracts.md`](docs/api-contracts.md) | Request/response shapes, source of truth over any other doc or plan |
| [`docs/system-design-v4.md`](docs/system-design-v4.md) | Original locked design document and design rationale |
| [`docs/STALE_CLAIMS_AUDIT.md`](docs/STALE_CLAIMS_AUDIT.md) | What in the design doc is now resolved vs. still accurate, verified against live code |
| [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md) | Full scene-by-scene demo walkthrough |
| [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) | Condensed ~6-minute video script |
| [`docs/RELEASE.md`](docs/RELEASE.md) | Served model versions and checksums |

---

## Design philosophy

High-contrast, cyber-brutalist clinical UI (`#E63B2E` / `#0A0A0A`), monospace telemetry, and a
standing rule that runs through every screen in every app: **a failure never gets to look like a
success.** A network error, a timeout, and a working result are always visibly distinguishable —
no screen substitutes a fabricated or mock result for a genuine failure.
