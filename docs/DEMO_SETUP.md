# Demo setup and verification — one laptop

Everything runs on a single machine: both backends, PostgreSQL, the five models,
MATLAB, and a browser pointed at either the Vercel frontend or a local one.

**Why one machine and not two.** The hosted frontend reaches the backend at
`http://localhost:5000`, and `localhost` always means *the machine running the
browser*. Splitting them needs a tunnel or a LAN address, and a plain-HTTP LAN
address is blocked as mixed content from an HTTPS page. A second laptop is only
worth it to demo offline sync (see the last section).

Versions below are what this system is **known to run on**, not minimums —
they are the ones the pipeline was verified against.

---

## 1. Prerequisites

| Component | Version verified | Notes |
|---|---|---|
| Node.js | 18+ (tested on 24.11) | `node -v` |
| Python | **3.10.9** | must be on PATH as `python` |
| PostgreSQL | 14+ | needs a database and a user |
| MATLAB | **R2026a** | licensed install; see toolboxes below |

### MATLAB toolboxes

Measured with `matlab.codetools.requiredFilesAndProducts` against the live
pipeline — these three are **required**:

- Image Processing Toolbox
- Computer Vision Toolbox
- Medical Imaging Toolbox  *(DICOM reading, Task 4.6)*

Optional, only for work that is not on the demo path:

- MATLAB Compiler — rebuilding `qualityGate.exe` (Task 8.1)
- SimEvents — the district queueing model (Task 3.8)

Check what you have:

```matlab
ver
```

### Hardware

| | |
|---|---|
| RAM | **8 GB minimum, 16 GB comfortable** |
| Peak inference | ~2.0 GB (segmentation 1.6 GB + Branch A 0.4 GB, run concurrently) |
| Disk | 1.1 GB models + datasets + ~1 GB node_modules |
| Per case | **~12.5 s** end to end |

No GPU needed. The verified install is **CPU-only PyTorch**.

---

## 2. Model weights — get these first

The five `.pt` checkpoints are **not in git** (55–280 MB each, two over GitHub's
100 MB file limit). Copy them into `central-system/backend/ml-pipeline/models/`.

The **folder names do not matter**. `modelPaths.py` resolves checkpoints by
filename anywhere under `models/`, so any layout works — but two copies of the
same filename is a hard error rather than a guess.

Required filenames:

```
branchA_v1.pt              # classifier      (Branch A)
vessel_unet_v1.pt          # vessels         (M2)
localization_v1.pt         # disc / fovea    (M3)
bright_lesion_unet_v1.pt   # exudates        (M4)
red_lesion_unet_v1.pt      # MA + HE         (M5)
```

Verify all five resolve:

```bash
cd central-system/backend/ml-pipeline/inference
python modelPaths.py
```

Expect five absolute paths and `all five checkpoints resolved`. Exit code 1 and
a `MISSING:` line means a file is absent or ambiguous.

---

## 3. Python dependencies

Only five packages are needed to **run** the pipeline:

```bash
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install timm segmentation-models-pytorch opencv-python numpy
```

> `ml-pipeline/requirements.txt` asks for CUDA 12.1 wheels plus pandas, scipy,
> scikit-learn, matplotlib and albumentations. Those are for **training and the
> offline experiments**, not for grading a case. The verified working install is
> the CPU build above. Install the full file only if you intend to re-run the
> Phase 9 experiments.

Verify:

```bash
python -c "import torch,timm,cv2,numpy,segmentation_models_pytorch as smp; print('torch',torch.__version__,'timm',timm.__version__,'cv2',cv2.__version__,'smp',smp.__version__)"
```

Known-good: `torch 2.14.0+cpu · timm 1.0.29 · cv2 5.0.0 · smp 0.5.0`.

---

## 4. Node dependencies

Four separate packages, each needs its own install:

```bash
cd central-system/backend  && npm install
cd ../frontend             && npm install
cd ../../phc-local-app/backend  && npm install
cd ../frontend                  && npm install
```

`phc-local-app/backend` uses **better-sqlite3**, which compiles a native
addon. On Windows that needs build tools; if `npm install` fails there, install
the VS Build Tools (C++ workload) and retry.

---

## 5. Configuration

One `.env` at the **repository root** — both backends load it.

```ini
# --- required ---
DATABASE_URL=postgresql://netrasetu:netrasetu_dev@localhost:5433/dr_screening_central
MATLAB_EXECUTABLE=matlab
MATLAB_TIMEOUT_MS=120000

# --- optional, sensible defaults exist ---
# PYTHON_EXECUTABLE=python
# PORT=5000
# CENTRAL_API_URL=http://localhost:5000   (PHC backend; required, no default)
# CORS_ALLOWED_ORIGINS=https://your-app.vercel.app,http://localhost:5173
# SMS_DRY_RUN=1
```

*(2026-09-26: each backend now has its own `.env` and `.env.example`; see the
README's "Run locally". `CENTRAL_URL` was renamed `CENTRAL_API_URL`; the old
name is still read, with a warning.)*

**CORS defaults cover local dev only.** With `CORS_ALLOWED_ORIGINS` unset, the
central backend allows just the two local frontends (`http://localhost:5173`,
`:5174`). A Vercel frontend must be listed explicitly. The pattern
`https://*.vercel.app` is accepted for per-deployment subdomains. A bare `*` is
refused at startup, because credentials are on.

`SMS_DRY_RUN=1` keeps Twilio from sending real messages. Leave it on unless you
have credentials and intend to demo live SMS.

### Frontend variables (Vite)

Both frontends default to **live** data (changed 2026-09-26). Set these in
Vercel's project settings, or in the `.env` beside each frontend for a local
`npm run dev`. Each frontend's `.env.example` lists them:

```ini
VITE_DATA_MODE=live                               # or mock
VITE_CENTRAL_API_BASE=http://localhost:5000       # central app
VITE_LOCAL_API_BASE=http://localhost:4000         # PHC app
```

Live mode never shows mock data. A failed request shows an error state, and an
unset API URL is reported on screen. `VITE_DATA_MODE=mock` shows fixture data
with a permanent "DEMO DATA — not real results" banner. The old
`VITE_USE_MOCK_DATA` and the ngrok `VITE_ML_API_ENDPOINT` are gone.

---

## 6. Database

```bash
npm run db:up                          # Docker Postgres on :5433 (docker-compose.dev.yml)
cd central-system/backend && npm run setup-db
cd ../../phc-local-app/backend && npm run setup-db   # creates the local SQLite file
```

Verify the schema:

```bash
psql "$DATABASE_URL" -c "\dt"
```

Expect 12 tables: `cases`, `corrections`, `explainability_outputs`,
`grading_results`, `model_versions`, `notifications`,
`ophthalmologist_reviews`, `patients`, `phc_sites`, `referrals`,
`segmentation_outputs`, `users`.

---

## 7. Start it

Three terminals:

```bash
# 1 — central backend  (grading, ophthalmologist queue, admin)
cd central-system/backend && npm start        # → :5000

# 2 — PHC local backend (capture, quality gate, sync)
cd phc-local-app/backend && npm start         # → :4000

# 3 — frontend, ONLY if not using the Vercel one
cd central-system/frontend && npm run dev     # → :5173
```

On boot the central backend prints how many stranded cases it recovered — that
is normal and means the queue is doing its job.

---

## 8. Verification ladder

Run these in order. Each one isolates a different layer, so the first failure
tells you which layer is broken.

### 8.1 Models load and run — no server, no database

```bash
cd central-system/backend/ml-pipeline/inference
python modelPaths.py
python branchAInfer.py ../../../../datasets/2.jpg
python segInfer.py ../../../../datasets/2.jpg
```

Branch A prints one line of JSON with `drGradeCnn`, `confidenceScore`,
`conformalTier`, `uncertaintyScore`. On `datasets/2.jpg` expect **grade 3,
confidence ≈ 0.8173, tier B**.

segInfer prints `opticDisc`, `fovea`, `redPerQuadrant`, `brightPerQuadrant` and
a `verified` block.

### 8.2 The recipes still reproduce the models' own published output

This is the check that catches a broken preprocessing chain — the failure mode
that produces plausible, wrong numbers rather than an error.

```bash
cd central-system/backend/ml-pipeline/inference
python verifyModel3.py        # expect 77/78 exact  -> "recipe REPRODUCES the model"
python verifySegModels.py     # expect M2 100.000% exact, M5 max diff < 0.001
```

```bash
cd central-system/backend/ml-pipeline/experiments
python verifyRuleEngineCounts.py   # expect 14/14 sum(red), 14/14 rule grade
```

### 8.3 MATLAB works and the rule engine is sane

```bash
cd central-system/backend/ml-pipeline/grading
matlab -batch "testBranchB"                    # expect 54/54 passed
```

```bash
cd central-system/backend/ml-pipeline/explainability
matlab -batch "testPhase7Explainability"       # expect 58 checks, 0 failed
```

```bash
cd phc-local-app/backend/quality-gate-matlab
matlab -batch "testQualityGateDeploy"          # expect 22 checks, 0 failed
```

### 8.4 CORS — the hosted frontend can actually reach the backend

```bash
cd central-system/backend && node middleware/testCors.js   # expect 26 checks pass
```

With the central backend running, confirm a real preflight:

```bash
curl -i -X OPTIONS http://localhost:5000/api/v1/ophthalmologist/queue -H "Origin: https://demo.vercel.app" -H "Access-Control-Request-Method: GET"
```

Expect `204` and `Access-Control-Allow-Origin: https://demo.vercel.app`.
A lookalike origin must get **no** such header:

```bash
curl -i http://localhost:5000/api/v1/ophthalmologist/queue -H "Origin: https://evil-vercel.app"
```

### 8.5 End to end — the one that matters

```bash
node verify_task33.js      # POST a case, poll, assert every field
node verify_task34.js      # PHC capture -> sync -> central -> graded
```

Expect `Task 3.3 DoD met` and `Task 3.4 DoD met`.

> These two scripts are **not tracked in git** (they were removed from the repo
> deliberately). They exist on this laptop. If they are ever lost, section 8.6
> is the fallback that needs no test harness.

### 8.6 One-command health check (no test scripts needed)

With the central backend running:

```bash
curl http://localhost:5000/health
```

Then confirm the full pipeline has actually written everything:

```bash
cd central-system/backend && node -e "const p=require('./db/pgClient');(async()=>{const r=await p.query(\`SELECT g.dr_grade_cnn cnn,g.dr_grade_rule_engine rule,g.branch_agreement agree,g.conformal_tier tier,g.uncertainty_score unc,e.lesion_attention_consistency_score lac,e.gradcam_path IS NOT NULL gradcam,s.lesion_counts->>'redTotal' red FROM grading_results g LEFT JOIN explainability_outputs e USING(case_id) LEFT JOIN segmentation_outputs s USING(case_id) ORDER BY g.graded_at DESC LIMIT 1\`);console.table(r.rows);process.exit(0)})()"
```

**A usable system shows all of these non-null:** `cnn`, `tier`, `unc`, `lac`,
`gradcam`, `red`. `agree` may legitimately be `null` — that means the rule
engine returned its ceiling grade of 3, which is a lower bound ("≥3") and
neither confirms nor contradicts Branch A.

Check nothing is wedged:

```bash
cd central-system/backend && node -e "const p=require('./db/pgClient');(async()=>{const r=await p.query(\"SELECT status,count(*) FROM cases GROUP BY status\");console.table(r.rows);process.exit(0)})()"
```

Cases sitting on `processing` for more than a minute or two mean grading is
stuck — restart the central backend and stranded-case recovery will re-queue
them.

---

## 9. Known failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `checkpoint '<name>.pt' not found` | weights not copied in | section 2 |
| `checkpoint is AMBIGUOUS — 2 copies` | duplicate file under `models/` | delete the stale one |
| `Failed to spawn MATLAB` | not on PATH | set `MATLAB_EXECUTABLE` to the full `matlab.exe` path |
| Case stuck on `processing` | queue died mid-flight | restart central backend; recovery re-queues |
| Case goes straight to `error` in ~7 s | MATLAB or Python missing — classified permanent, not retried | check `MATLAB_EXECUTABLE` / `PYTHON_EXECUTABLE` |
| Browser: CORS / network error, server log silent | request blocked before reaching Express | section 8.4 |
| Frontend shows data with backends stopped | `VITE_DATA_MODE=mock` (the DEMO DATA banner is showing) | set `VITE_DATA_MODE=live` and restart `npm run dev` |
| Grading takes ~12 s | expected — 5 models + MATLAB | not a fault |

---

## 10. What is not wired, so nobody hunts for it

Stated so these read as decisions rather than bugs on demo day:

- **`nvSuspicionScore` is always NULL.** No neovascularization detector runs;
  `neovascularizationSuspicion.m` exists but nothing calls it. Branch B
  therefore cannot reach grade 4 at all, by design — a CNN grade 4 is escalated
  to Tier C instead, because no second opinion is possible.
- **Camera calibration is detected, not applied.** The family is classified and
  a reported-vs-detected mismatch is logged, but no per-family pixel correction
  reaches the model. Applying one would feed the network an input distribution
  it was never trained on.
- **The PHC quality gate cannot read DICOM.** It still uses `imread`, so a
  `.dcm` cannot complete capture → sync end to end. The central pipeline reads
  DICOM fine.
- ~~Mock data is the default in both frontends~~ and ~~`VITE_ML_API_ENDPOINT`
  points at ngrok~~: both fixed 2026-09-26. Frontends default to live, and mock
  mode is explicit (`VITE_DATA_MODE=mock`) with an on-screen banner.

---

## 11. If you do use a second laptop

Only worth it to show offline-first sync, which is a genuine differentiator.

Laptop 2 runs the PHC backend with `CENTRAL_API_URL=http://<laptop-1-ip>:5000`.
Disconnect the network, capture cases, reconnect, watch them sync.

**The catch:** laptop 2 needs MATLAB for the quality gate, or `qualityGate.exe`
plus the free MATLAB Runtime R2026a — and **that Runtime path has never been
tested on a machine without MATLAB**. Try it well before the day, not on it.

The same story can be told from one laptop by pointing at `capturedAt` being
earlier than `receivedAt` on a synced case, which is the actual evidence that
the case was taken offline and uploaded later.

## 12. Backing the demo up, and putting it back

There is a lot of state behind a working demo and none of it is in git: the
Postgres database, the encrypted case media, and the PHC's SQLite file. A
re-seed from scratch means re-running every capture through MATLAB, so take a
snapshot once the demo set is graded and you are happy with it.

```bash
# Central: schema + data. -Fc is the compressed custom format, restorable
# selectively; plain SQL is fine too if you would rather read it.
pg_dump -Fc -d dr_screening_central -f demo-central.dump

# The images and reports the case pages load. ENCRYPTED AT REST, so this is
# useless without MEDIA_ENCRYPTION_KEY -- back that up too, separately, or the
# restore gives you a database full of cases whose pictures will not open.
tar -czf demo-media.tgz -C central-system/backend media

# The PHC desktop's own database: patients, captures, technician accounts,
# paired devices.
cp phc-local-app/backend/db/local.sqlite demo-phc.sqlite
```

Restoring:

```bash
dropdb dr_screening_central && createdb dr_screening_central
pg_restore -d dr_screening_central demo-central.dump
tar -xzf demo-media.tgz -C central-system/backend
cp demo-phc.sqlite phc-local-app/backend/db/local.sqlite
```

Two things that will bite otherwise:

- **`MEDIA_ENCRYPTION_KEY` is not in the dump and not in git** (it lives in
  `central-system/backend/.env`, git-ignored). Restore the media without it and
  `/media` refuses to serve every image -- correctly, since it will not hand
  out a file it cannot verify. Keep the key wherever this deployment keeps its
  secrets. Losing it means the media is unrecoverable; `docs/SECURITY.md` says
  the only remedy is a full re-seed.
- **Restoring an old database against newer code needs `npm run migrate`
  afterwards.** Migrations are forward-only and the dump carries whatever
  schema version it was taken at.

Full-disk encryption (plan §A.15) is still the separate, non-code piece: on
Windows 11 Home that is Settings -> Privacy & security -> Device encryption,
and someone with admin on the machine has to switch it on. It protects the
Postgres data directory and the PHC SQLite file, which the application cannot
encrypt itself. The case media is already encrypted independently of it.

