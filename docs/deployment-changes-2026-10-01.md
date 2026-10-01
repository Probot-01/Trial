# Deployment changes pulled from upstream (2026-10-01)

Notes on what landed in the `krrishgadekar/SIH_2026` remote since our last sync. The changes are mostly about putting
the system online for the SIH online-demo round. This file is a reading guide with file references.
It is not a spec: `docs/api-contracts.md` and `docs/system-design-v4.md` still govern.

## Where the changes are

| Ref | Commits | Author / dates | What |
|---|---|---|---|
| `origin/integration` (`01998ad..e26b8c6`) | 7 | Tanuj, 2026-09-30 | UI polish, real PHC quality metrics, mobile parity, test/seed scripts |
| `origin/main` (`e26b8c6..8a2daa5`) | 21 (15 non-merge) | Tanuj, 2026-09-30 → 10-01 | **Deployment work** (Render + ONNX), red-lesion v2 on MATLAB, final docs |

`origin/main` already contains all of `origin/integration`. Diff on `origin/main` only: 28 files, +2306 / −95.

> **Local state:** merged into local `integration` on 2026-10-01 (merge commit `254ac18`, upstream version kept on conflicts). See "Pull status" at the end.

---

## 1. Deployment architecture (online demo only)

Every deployment commit says the same thing. This setup exists **only to give judges a live URL this round**.
The final round still runs everything locally with MATLAB, and the production target (TECHNICAL_DOCUMENTATION §12.1)
is unchanged.

```
 Vercel                          Render (free tier, region: singapore)
 ───────────────────             ──────────────────────────────────────────────────────────
 centralsys.vercel.app  ──────▶  netrasetu-central   (Node, Docker)  ──HTTP──▶ netrasetu-ml-inference
   (cookie session,                 │ Postgres: netrasetu-db (free)              (Python, ONNX Runtime)
    credentials:'include')          │                                              pulls weights from a
 phcapp.vercel.app      ──────▶  netrasetu-phc       (Node, Docker,               private GitHub release
   (Bearer token)                   ephemeral SQLite, JS quality gate) ──▶ central   at container start
```

- Frontends stay on Vercel. Neither frontend changed for deployment. Their API base URLs live in Vercel env and are
  not visible in the repo.
- **No MATLAB anywhere in the hosted demo.** The classifier and segmentation run as ONNX Runtime in Python, the PHC
  quality gate uses the existing JS port, and the case pipeline (rule engine) can only run as `js-fallback`,
  because central has no MATLAB. **But render.yaml doesn't enable that fallback.** See review note 0.

### New files

| File | Purpose |
|---|---|
| `render.yaml` | Render Blueprint with 3 web services and 1 free Postgres. `autoDeployTrigger: "off"` on all of them, so deploys are manual from the dashboard. |
| `.dockerignore` | Repo-root build context. Excludes datasets, model weights (except 3 small JSONs), `onnx_out/`, training, media, sqlite, both frontends, mobile, docs, tests, simulink, and `.env*`. |
| `central-system/backend/Dockerfile` | `node:22-slim`, pure Node, **no `ml-pipeline/`** (~8 GB). CMD runs `migrate`, then `seed-users`, then `provisionDemoPhcOnce.js`, then `exec node server.js` on **every container start** (all three are idempotent). |
| `phc-local-app/backend/Dockerfile` | `node:22-slim` plus python3/make/g++ (better-sqlite3 builds from source). CMD creates a demo technician (`|| true` on re-runs), then starts the server. |
| `ml-inference-service/` (`app.py`, `Dockerfile`, `fetch_models.py`, `requirements.txt`, `README.md`) | FastAPI wrapper that shells out to the **unchanged** `branchAInfer.py` / `segInfer.py` CLIs. Returns Grad-CAM and masks as base64. Endpoints: `GET /health`, `POST /infer/branch-a`, `POST /infer/segmentation`. An `asyncio.Lock` serialises the two endpoints. No torch in requirements. |
| `scripts/provisionDemoPhcOnce.js` | Replaces `npm run provision-phc-key` (Render's free tier has no Shell). Creates "NetraSetu Demo PHC" once and **prints `PHC_ID`/`PHC_API_KEY` to the logs once**. You then copy them into `netrasetu-phc`'s env by hand. |
| `central-system/backend/ml-pipeline/models/Model1/v2c/branchA_v2c_meta.json` | Branch A's preprocessing metadata (img size, mean/std), extracted so the ONNX path never opens the `.pt` file. |

### Changed code

| File | Change |
|---|---|
| `central-system/backend/services/gradingOrchestrator.js` | New `INFERENCE_BACKEND=remote` (alongside `matlab`/`python`). It needs `ML_INFERENCE_SERVICE_URL` and throws at startup without it. `ML_INFERENCE_TIMEOUT_MS` defaults to 180000. New functions: `postToInferenceService`, `runBranchAInferenceRemote`, `runSegInferenceRemote`. `remote` also redirects **segmentation** (`segment()` short-circuits). Base64 payloads are decoded back to the same local paths the DB and pipeline already expect. A failed remote segmentation returns `null`, so the case degrades to Branch A only and does not fail. |
| `ml-pipeline/inference/branchAInfer.py` | New `BRANCH_A_INFERENCE_ENGINE=onnx` (default `torch`), **v2c only**. It uses a new artifact `training/onnx_out/branchA_v2c_graphcam.onnx` (an ONNX export with an extra output at `backbone.bn2.act`) and `models/Model1/v2c/branchA_v2c_head.npz`. Grad-CAM and MC-dropout are computed **in closed form** from the head weights. Claimed parity vs torch: logits ~5e-6, Grad-CAM ~3e-6. |
| `ml-pipeline/inference/segInfer.py` | New `SEG_INFERENCE_BACKEND=onnx`. It loads one U-Net at a time with no cache (peak ~250–270 MB). Claimed parity max abs diff 8.5e-5. Provenance detail reads "ONNX Runtime (…)". |
| `ml-pipeline/inference/gradcam.py` | `import torch` moved inside `compute_gradcam()` so that importing `save_overlay` doesn't pull in torch. |
| `scripts/fetch-models.js` | Optional `MODELS_REPO_TOKEN` for a **private** GitHub release asset. The auth header goes on the first request only, not on the redirect. |
| `central-system/backend/.env.example` | Documents `INFERENCE_BACKEND=remote`, `ML_INFERENCE_SERVICE_URL`, `ML_INFERENCE_TIMEOUT_MS`. |

### Fixes found during live deploy (commit trail)

1. `68a3c06`: Render's free tier rejects `preDeployCommand`, so migrate and seed moved into the Dockerfile CMD.
   This also fixed a real bug: `scripts/setupCentralDb.js` was never copied into the image.
2. `b10b33b`: The BuildKit secret mount didn't receive `MODELS_REPO_TOKEN` on Render (404 twice), so the model
   fetch moved to **container start**. A sentinel file skips re-fetching within the same filesystem.
3. `9d20ab7`: The demo PHC and technician are now provisioned without Shell access (see above).
4. `8a2daa5`: **Cross-origin cookie.** Login returned 200 and the next request got 401. The fix is
   `COOKIE_SAMESITE=none` on central (authConfig forces `COOKIE_SECURE=true` with it). PHC is unaffected because it uses Bearer auth.
5. `8c1ec89`: Engine provenance no longer names "ml-inference-service/HF Spaces". `remote` now reports exactly like local `python`.

### Render env vars that must be set by hand (`sync: false`)

| Service | Vars |
|---|---|
| `netrasetu-central` | `DEMO_OPHTHALMOLOGIST_PASSWORD`, `DEMO_ADMIN_PASSWORD` (seedDemoUsers refuses defaults in production), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `REFERRAL_CLINIC_NAME` |
| `netrasetu-phc` | `PHC_ID`, `PHC_API_KEY` (copied from central's first-boot log) |
| `netrasetu-ml-inference` | `MODELS_REPO_TOKEN` (read access to `tanujb03/netrasetu-models-private`) |

Hard-coded in render.yaml: `CORS_ALLOWED_ORIGINS` (`https://centralsys.vercel.app`, `https://phcapp.vercel.app`),
`ML_INFERENCE_SERVICE_URL=https://netrasetu-ml-inference.onrender.com`,
`CENTRAL_API_URL=https://netrasetu-central.onrender.com`, `TRUST_PROXY=1`, `QUALITY_GATE_ALLOW_FALLBACK=1`,
`MATLAB_SUPERVISOR_ENABLED`/`SEG_WORKER_SUPERVISOR_ENABLED`/`SIMULINK_VALIDATION_ENABLED=false`. `JWT_SECRET` and
`MEDIA_ENCRYPTION_KEY` are generated by Render.

---

### Live status (probed 2026-10-02, read-only: `/health`, CORS preflight, deployed JS bundles, GitHub deployments API)

| Component | Where | Status | Evidence |
|---|---|---|---|
| Central web | `https://centralsys.vercel.app` | **Deployed** | Bundle built from `8a2daa5` (`main`): `VITE_DATA_MODE=live`, `VITE_CENTRAL_API_BASE=https://netrasetu-central.onrender.com` |
| PHC web | `https://phcapp.vercel.app` | **Deployed** | Same commit: `VITE_DATA_MODE=live`, `VITE_LOCAL_API_BASE=https://netrasetu-phc.onrender.com` |
| Central backend + Postgres | `https://netrasetu-central.onrender.com` | **Deployed** | `/health` 200 (~23 s cold start): db ok, queue running, `processed: 0`, matlabSession/segWorker `disabled`, local python `unavailable` (expected with `remote`). CORS allows centralsys with credentials. Protected routes return 401. |
| PHC backend | `https://netrasetu-phc.onrender.com` | **Deployed** | `/health` 200. CORS allows phcapp plus the `authorization` header. Its connection to central is not visible without logging in. |
| ML inference | `https://netrasetu-ml-inference.onrender.com` | **Deployed** | `/health` 200 (~43 s cold start), both scripts present |
| Third Vercel project `sih-2026` | Unknown | **Unknown** | Deploys every `main` commit, but its URL is behind Vercel login (302). `sih-2026.vercel.app` is an unrelated "INCOIS Hazard Reporting" site, not ours. |
| Android APK | None | **Not deployed** | No GitHub releases. No `eas.json` in the repo. README and §12.2 link is still a placeholder. |
| Standalone downloadable PHC (compiled MATLAB quality gate) | Not hosted | **Partly built, not packaged** | See "Standalone PHC status" below |
| MATLAB / Simulink | Local only | **Not deployed, by design** | Final round runs locally |

**Not verified (needs a login):** that a new upload actually gets graded end to end (see review note 0, `MATLAB_ALLOW_FALLBACK`),
that PHC→central sync works with the provisioned key, and that demo data exists in the DB.

### Standalone PHC status (checked 2026-10-02)

The plan is that PHC #1 is the hosted one on Vercel/Render (done). PHC #2 is a downloadable standalone station:
the Node PHC backend plus frontend, with the quality gate compiled by MATLAB Compiler and running on the free MATLAB
Runtime, so no MATLAB licence is needed.

- **Exe exists only on Saad's machine.** `phc-local-app/backend/quality-gate-matlab/dist/qualityGate.exe` is 1.37 MB,
  built 2026-09-10 04:31 with MATLAB Compiler 26.1. `dist/` is git-ignored, so it's in no repo or release. That's why
  TECHNICAL_DOCUMENTATION §4.2/§13 and TANUJ_FINAL_CHECKLIST §5 say "never built" (Tanuj's `mcc` failed on his machine).
- **It runs.** On 2026-10-02, `dist/qualityGate.cmd demo_images/1_quality_pass.jpg default` exited 0 with valid JSON
  (`pass`, focusScore 0.80108…, matching the value recorded at build time). It took ~22–30 s per call cold.
- **Rebuilt 2026-10-02 00:20** from current source (the old build predated the `mobile_lens` preset added in
  `bfe026e`).
  - Build command: `matlab -batch "cd('<repo>/phc-local-app/backend/quality-gate-matlab'); buildQualityGateExe()"`.
    Exit 0, ~40 s, 1,372,211 bytes.
  - The old build is backed up in the session scratchpad.
  - Output is identical to the MATLAB source on `demo_images/1_quality_pass.jpg`.
  - `testQualityGateDeploy`: **22 checks, 0 failed**, including "every sub-score matches to 1e-9" and "cameraPresets.json bundled".
  - `verify_quality_gate_parity.js` still SKIPs, now only because the JS fallback is switched off (see the next section).
- **Never tested without MATLAB.** `qualityGate.cmd` borrows `C:\Program Files\MATLAB\R2026a\runtime\win64`.
  MATLAB Runtime R2026a is not installed here and has never been tried on a clean machine.
  The required runtime add-ons are Base, Standard, Extended, Graphics, Image Processing, and Parallel Computing
  (`dist/buildresult.json`).
- **No package exists.** There is no installer, zip, release, or setup script for a downloadable PHC. Nothing in the
  repo bundles the backend, frontend build, exe, and an `.env` template together.
- **PHC #2 needs its own central identity.** It needs a second `PHC_ID`/`PHC_API_KEY` from central.
  `provisionDemoPhcOnce.js` only creates the one demo PHC, and Render's free tier has no Shell for
  `provision-phc-key`, so there is currently no way to mint a second key on the hosted central.
- Tracked as `docs/TASKS_SAAD.md` §3 (owner: Saad).

**Packaged 2026-10-02:** `C:\Users\91740\Desktop\SIH\NetraSetu-PHC-standalone.zip`. Not in the repo.
57.5 MB, 1707 entries, SHA-256 `A8F91DD3…AC36E86`. *(Superseded the same day by the fixed-exe build,
`E484C116…`; see "Changes made 2026-10-02".)*

Contents:
- `runtime\node.exe` (v24.11.0)
- `app\backend` (repo PHC backend, production deps)
- `app\web` (frontend built with `VITE_LOCAL_API_BASE=http://localhost:4000`, `VITE_DATA_MODE=live`)
- `app\quality-gate\qualityGate.exe`
- `app\launcher.js`
- `Start-PHC.cmd`, `Add-Technician.cmd`, `Check-Setup.cmd`
- `settings.env` (`PHC_CODE=PHC002`, Render central URL, key fields empty)
- `README.txt`

Data goes to `data\`, outside `app\`.

End-to-end test against the local central (2026-10-02). The PATH had no Node and no MATLAB; the MATLAB Runtime was
borrowed from the full MATLAB install.
- Register a patient (UI), then capture (public demo image), then the compiled quality gate: pass 92%, engine
  recorded as "compiled qualityGate executable (MATLAB Runtime)".
- Questionnaire and metadata, then sync (case `14bdb3aa…`), then central grades it: CNN 3 / rule 3, tier B,
  all-MATLAB provenance. The PHC queue then shows "RESULT READY".
- Also passed:
  - restart keeps data;
  - install path with spaces;
  - offline capture (`online:false`, capture saved);
  - auth enforced (401);
  - ports released on stop;
  - fresh extract with `Expand-Archive`, then Check-Setup OK, with a clear error when the Runtime is missing.

**Bug found (FIXED 2026-10-02, see "Changes made 2026-10-02" below):** `qualityGateAssetPath.m` never checks
`<ctfroot>\qualityGate\cameraPresets.json`, which is where `mcc -a` puts the file. So the exe fails
(`qualityGateAssetPath:notFound`, exit 3) everywhere except beside the source tree. In the repo, the exe only works
because the "next to the exe" fallback resolves to `quality-gate-matlab\cameraPresets.json` (the source file).
For the same reason, `testQualityGateDeploy`'s "from a binary with no source tree" check is a false pass.
The zip ships `app\cameraPresets.json`, which that fallback finds.
The real fix is one more candidate path in `qualityGateAssetPath.m`, then a rebuild.

**Not tested:** a PC with only the standalone MATLAB Runtime installed and no MATLAB at all.

**Hosted PHC confirmed broken (2026-10-02).** Reproduced locally with its exact settings
(`QUALITY_GATE_ALLOW_FALLBACK=1`, no MATLAB, no exe): `POST /captures` returns **503 `quality_gate_failed`**
("JS quality-gate fallback is switched off"). `POST /captures/:id/best-effort` returns 400
`best_effort_not_applicable` (it only accepts `retake` captures), so there is no way past it and nothing is queued
(`pendingCount: 0`). The switch-off commit `82d4d5b` is an ancestor of the deployed `8a2daa5`.

### Changes made 2026-10-02 (Saad)

All local and uncommitted. Nothing was pushed or deployed.

1. **Fixed `phc-local-app/backend/quality-gate-matlab/qualityGateAssetPath.m`.**
   - In the compiled branch, the first candidate is now `fullfile(ctfroot, 'qualityGate', name)`, which is where
     `mcc -o qualityGate -a cameraPresets.json` actually puts the file (measured in the runtime cache:
     `MatlabRuntimeCache\R2026a\qualit*\qualityGate\cameraPresets.json`).
   - A last-resort `dir(fullfile(ctfroot, '**', name))` search was added, so a future Compiler layout change still
     finds the *bundled* copy instead of failing.
   - The non-compiled (in-MATLAB) branch is unchanged.
2. **Rebuilt `dist/qualityGate.exe`** with `matlab -batch "cd('<repo>/phc-local-app/backend/quality-gate-matlab'); buildQualityGateExe()"`.
   Exit 0, 1,372,348 bytes, 2026-10-02 00:55.
   - Verified by copying the exe *alone* into an empty folder far from the repo (0 `cameraPresets.json` files
     anywhere near it). It runs and exits 0 for `generic_fundus` and `mobile_lens`. The previous build failed
     exactly this test.
   - `testQualityGateDeploy`: 22 checks, 0 failed.
3. **Updated the standalone zip.**
   - Swapped in the fixed exe and **removed the `app\cameraPresets.json` workaround**.
   - New SHA-256 `E484C116…B569581B`, 57.5 MB.
   - Re-verified from a fresh `Expand-Archive`: 0 presets files in the package, capture returns HTTP 201
     `pass`, and the engine is recorded as "compiled qualityGate executable (MATLAB Runtime)".
4. **Hosted PHC version check.**
   - Vercel `phcapp` is built from `8a2daa5`, which is current `origin/main`, so it's up to date.
   - The Render `netrasetu-phc` commit can't be seen from outside (auto-deploy off, no GitHub deployment
     records). The last PHC-backend commit is `9d20ab7`, so Tanuj needs to confirm it in the dashboard.
   - The hosted capture failure (503, above) is **not** a version mismatch: current repo code behaves the same,
     so a redeploy won't fix it.
   - Nothing could be "fixed" here without Render access. All of it went into `docs/TASKS_TANUJ_DEPLOYMENT.md`.
5. **New doc `docs/TASKS_TANUJ_DEPLOYMENT.md`.**
   - Main task: issue PHC002's `PHC_ID`/`PHC_API_KEY` on the hosted central. Two Shell-free options: set
     `DEMO_PHC_NAME` and restart, or run `provision-phc-key` locally against the Render DB's external URL.
   - It also lists the hosted-PHC 503, the `MATLAB_ALLOW_FALLBACK` gap, and the Render deploy-version check.

6. **`testQualityGateDeploy.m` now tests the exe in isolation.** It copies `dist\qualityGate.exe` alone into
   `<tempname>\bin\` and runs it there, with that folder as the working directory, so no source
   `cameraPresets.json` can be found by accident.
   - New checks: "isolated copy has no cameraPresets.json beside it" and "cameraPresets.json resolved from inside
     the archive".
   - The old tautological "bundled" check, which only re-tested that the exe exists, is gone.
   - Fixed exe: **23 checks, 0 failed**. With the old buggy exe swapped in: **2 failed**, so the test now catches
     the bug it missed before.
7. **Hosted PHC capture fixed in code: the JS quality gate rewritten and re-enabled**
   (`phc-local-app/backend/services/qualityGateFallback.js`).
   - The old file implemented an outdated version of the MATLAB metrics, which is why it was switched off. It is now
     a step-by-step port of `qualityGateMain.m` + the four `assess*.m`:
     - exact `rgb2gray` coefficients;
     - no EXIF rotation (MATLAB's `imread` doesn't rotate);
     - `var` with N−1;
     - the inclusive glare region;
     - `imfill` with 4-connectivity, plus 8-connected `regionprops`;
     - `imclose` with the exact `strel('disk',7)` octagon on a zero-padded plane (measured: MATLAB's `imclose` ≠
       `imerode(imdilate())` at the border);
     - 8-connected `bwareaopen`;
     - `bwconvhull` from pixel-edge midpoints, like `regionprops`;
     - camera presets read from the same `cameraPresets.json`.
   - Variances are streamed (Welford), which cut peak memory on a 12 MP image from 379 MB to 241 MB.
   - Parity:
     - `verify_quality_gate_parity.js`: **6 images, 0 mismatches** (54 checks).
     - Extra set of **52 images** (10 CHASE_DB1, 15 DRIVE, 15 IDRiD at 4288×2848, plus 12 degraded copies):
       **0 mismatches**. Every decision is identical, covering pass, borderline and retake for
       blur / low_illumination / eyelash_occlusion / glare / insufficient_fov.
     - Worst score gaps: focus 3.5e-12, motion 7.2e-11, occlusion 3.3e-4. The rest are 0. Tolerance is 1e-3.
       The occlusion residue comes from `poly2mask` (a compiled builtin) tie-breaking on hull-edge pixels:
       ±~30 pixels of disc area.
   - Every result is still stamped `engine: 'js-fallback', fallback: true`.
   - `qualityGateClient.js` now passes the camera device ID to the fallback (previously ignored).
8. **`phc-local-app/backend/Dockerfile`**: copies `quality-gate-matlab/cameraPresets.json` (only that file) into the
   image, because the JS gate reads it. Without it, the container returned `ENOENT … cameraPresets.json` as a 503.
   This was found by the container test below, not by the unit tests.
9. **`test/quality-gate-engine.test.js`** updated from "opted-in fallback ⇒ 503 switched off" to the stricter
   "opted-in fallback ⇒ MATLAB's own verdict for the fixture (`borderline`), every score within 1e-3 of MATLAB's,
   engine recorded as `js-fallback`". The "gate cannot run ⇒ truthful 503" guarantee is still tested in
   `sync-flow.test.js` (fallback not opted in). PHC suite: **41/41 pass**.
10. **Render simulation.** I built the real `phc-local-app/backend/Dockerfile` image with Docker and ran it with
    Render's `netrasetu-phc` settings (`NODE_ENV=production`, `QUALITY_GATE_ALLOW_FALLBACK=1`, auth on) and a hard
    **512 MB** memory cap.
    - Captures returned **HTTP 201**:
      - demo image: `pass`;
      - test fixture and full-size IDRiD: `borderline` (6 s);
      - blurred copy: `retake/blur`;
      - darkened copy: `retake/low_illumination`.
    - All match MATLAB. Peak container memory was 242 MB, with no OOM kill.

**Not deployed yet.** The hosted PHC needs these commits on `origin/main` plus a manual Render deploy of
`netrasetu-phc` (auto-deploy is off). See `docs/TASKS_TANUJ_DEPLOYMENT.md`.

**The standalone zip is unaffected.** It keeps the fallback disabled and always uses the compiled exe, so its
bundled copy of the old `qualityGateFallback.js` is never called.

## 2. Other changes on `origin/main` (not deployment)

- **Red-lesion v2 is now MATLAB-served** (`9ca0127`). `red_lesion_unet_v2` was added to `segInfer.py` `_MATLAB_NETS` and
  to `runMatlabInferenceSession.m` `SEG_SERVED()`. `_lesion_prob_v2` now dispatches through `_run()`. Parity:
  `training/parityCheckRedLesionV2.m`. `docs/RELEASE.md` and `red_lesion_v2_config.json` are updated to match.
  Rule-engine thresholds are untouched.
- `scripts/lib/demoStack.js`: `centralHealthy()` now accepts `segWorker.status === 'disabled'`. Before this, `demo-reset`/`dev-up`
  timed out under the default `SEG_INFERENCE_BACKEND=matlab`.
- New docs: `docs/TECHNICAL_DOCUMENTATION.md` (+PDF), `docs/ML_BENCHMARKS.md` (+PDF), `docs/DEMO_SCRIPT.md` (+PDF),
  and a rewritten `README.md`. **§12.2 "Current deployment" and README "Live demo links" are still `_to be added_` placeholders.**

## 3. Changes on `origin/integration` (included in main)

- **API contract (additive, dated 2026-09-30):** PHC `POST /captures` and `/quality-check` gain `qualityScore` and `metrics`.
  Central `priorAssessments[]` gains `lesions`, `status`, `referralStatus`.
- PHC backend: `captureHandler.js`, `qualityGateClient.js` expose the real quality sub-scores.
- Central backend: `ingestionService.js` returns lesion counts and review status for prior assessments.
- Central frontend: new `InfoModalButton`, jargon removed, plus a rework of `GradCamOverlay.jsx` and
  `BranchComparisonPanel.jsx` (this is the same fix our local `7498e2f` made, done differently. See Pull status.)
- PHC frontend: real quality metrics, fundus-lens camera, date picker, info buttons.
- Mobile (`phc-local-app/mobile/`): DateField, InfoModalButton, clinical slip PDF fix. *(Mobile is off-limits for us.
  Listed for completeness only.)*
- `scripts/test-full-dataset.js`, `scripts/seed-real-demo-cases.js`. `simulink-model/netraSetuPipeline.slx` was re-saved.

---

## 4. Things to look at (my review notes, not yet discussed with Tanuj)

Ordered by how much they matter. Items marked *(verified)* come from reading the code at `origin/main`.
*(likely)* means I inferred it from how the platform behaves and did not test it.

00. **The hosted PHC can't quality-check a capture** *(verified in code, not live-tested)*. render.yaml gives
   `netrasetu-phc` `QUALITY_GATE_ALLOW_FALLBACK=1` and says it uses the "existing JS port". But
   `services/qualityGateFallback.js:314` `runQualityGateFallback()` is switched off: it unconditionally throws
   "the JS quality-gate fallback is switched off…" (since `82d4d5b`, 2026-09-27, because its scores diverged from MATLAB).
   So `qualityGateClient.js` falls to that throw, and `captureHandler.js:245` turns it into `quality_gate_failed`.
   Every capture on phcapp.vercel.app should end there. A Windows `qualityGate.exe` can't help on Render's Linux
   container. The fix needs a decision: a Linux compiled gate plus the Linux Runtime in the image (likely too big for
   free tier), or re-enabling the JS gate after fixing its divergence.
0. **Hosted grading likely fails at the rule-engine step** *(verified in code, not live-tested)*.
   `gradingOrchestrator.js:83` sets `ALLOW_MATLAB_FALLBACK = process.env.MATLAB_ALLOW_FALLBACK === '1'` (OFF by
   default since 2026-09-26). Line ~928 only falls back to `matlabFallback.js` when that flag is on. render.yaml does
   **not** set `MATLAB_ALLOW_FALLBACK` on `netrasetu-central`, and that host has no MATLAB. So `runCasePipeline`
   should hit `matlab_unavailable` and the case should go to `error` even after remote inference succeeds.
   The likely fix is one env line, `MATLAB_ALLOW_FALLBACK: "1"`. That is an explicit, recorded `js-fallback`, which
   the rules allow. Confirm with one upload against the live URL.
1. **A fixed demo password is committed in a public repo** *(verified)*. `phc-local-app/backend/Dockerfile`
   CMD runs `technician.js add demo … --admin --password "<literal>"`. That is an admin login to a live public URL.
   CLAUDE.md says "Never commit secrets". This should become an env var (`sync: false`) and the password should be rotated.
2. **Provenance detail is inaccurate for `remote`** *(verified)*. `buildEngineProvenance` gives the classifier
   `engineEntry('python', 'branchAInfer.py (INFERENCE_BACKEND=python)')`, but on the demo the backend is `remote`
   and the engine is ONNX Runtime with closed-form Grad-CAM/MC-dropout. Segmentation's detail honestly says "ONNX Runtime".
   The engine *label* `python` is defensible. The detail string states a config that isn't true.
   This needs a decision against the "every case records which engine" rule.
3. **New model artifacts were derived** *(verified)*. These are `branchA_v2c_graphcam.onnx` (a re-export with an added
   graph output) and `branchA_v2c_head.npz`. No weights changed, but CLAUDE.md says "do not … re-export model weights".
   Tanuj owns ML, so this is probably fine. Worth confirming it's intended.
4. **Ephemeral disk on Render free** *(likely)*. Central writes uploads, Grad-CAM PNGs and masks to `media/` on the
   container filesystem, while Postgres keeps their paths. Any redeploy or restart (and free services restart after
   idle spin-down) loses those files, so images for older cases may 404. The PHC SQLite is explicitly ephemeral.
5. **Cold starts** *(likely)*. All three services spin down when idle. ml-inference re-downloads ~340 MB of models on
   every fresh container (the sentinel only helps within one filesystem). The first case after idle may exceed
   `ML_INFERENCE_TIMEOUT_MS` (180 s). If so, Branch A throws and segmentation silently returns `null`.
6. **Real SMS is enabled** *(verified)*. `SMS_DRY_RUN` is deliberately unset and real Twilio credentials are used, so
   a demo referral sends a real SMS.
7. **Stale comments** *(verified)*. `gradingOrchestrator.js` and `.env.example` still say ml-inference runs on
   "Hugging Face Spaces" (it's Render now). `runSegInferenceRemote`'s header says the service forces
   `SEG_INFERENCE_BACKEND=python` (it forces `onnx`).
8. The PHC API key is printed to Render logs on first boot *(verified, by design)*. Anyone with dashboard log access
   can read it.
9. Render free Postgres has an expiry window *(check the current Render policy)*. Plan for the demo date.
10. Placeholders in TECHNICAL_DOCUMENTATION §12.2 and README links still need filling once the URLs are final.

## 5. Open questions

- **Q1.** Has anyone uploaded a new case on the hosted demo end to end? (See review note 0.)
- **Q2.** Is the hosted deployment live yet, and are the Vercel frontends' API base URLs pointed at `*.onrender.com`?

---

## Pull status (local checkout)

- `git fetch --all` done. Local `integration` (`c8c35ca`) is **behind** `origin/integration` and also **ahead** of it by
  `7498e2f` "Fix GradCam double-blend and Branch B null agreement label". That commit exists on `probot/integration`
  but not on `origin`.
- Fast-forward is impossible. A trial merge (`git merge-tree`) of local `HEAD` with `origin/main` **conflicts** in:
  - `central-system/frontend/src/components/screens/BranchComparisonPanel.jsx`
  - `central-system/frontend/src/components/screens/GradCamOverlay.jsx`
  - `central-system/frontend/src/styles/main.css`

  Both sides fixed the same two bugs (Grad-CAM double blending, and Branch B "not available" when the rule engine
  is at its grade-3 ceiling). Upstream's version swaps image and Grad-CAM instead of stacking them, and also
  explains the crop mismatch.
- **Resolved 2026-10-01:** `origin/main` was merged into local `integration` as `254ac18`, keeping the upstream
  version of all three conflicting files (as decided). The resulting tree is identical to `origin/main`
  (`git diff origin/main HEAD` is empty). `7498e2f`'s changes are superseded but still in history. Nothing was pushed.
- Local `main` (`55a85e1`) has diverged from `origin/main` (2 local / 67 remote).
- The uncommitted local edits (`nodemon.json`, frontend `package-lock.json`) don't overlap the incoming files.
