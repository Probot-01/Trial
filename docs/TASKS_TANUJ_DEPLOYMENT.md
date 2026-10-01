# Tanuj: deployment tasks (from Saad, 2026-10-02)

These need your Render access. Background and evidence are in `docs/deployment-changes-2026-10-01.md`.

---

## 1. Issue a central identity for the standalone PHC (PHC002)  ← the main ask

**Why.** The standalone PHC zip (`NetraSetu-PHC-standalone.zip`, compiled MATLAB quality gate, runs on the free
MATLAB Runtime) is set up as `PHC_CODE=PHC002` and sends its cases to
`https://netrasetu-central.onrender.com`. Central refuses uploads from a PHC it doesn't know, so it needs its own
`PHC_ID` + `PHC_API_KEY`. The hosted PHC's key (`NetraSetu Demo PHC`) must not be reused: two sites on one identity
would mix their cases.

Normally this is `npm run provision-phc-key -- --create "<name>"`, but Render's free tier has no Shell or Jobs.
Pick **one** of these:

**Option A: reuse the start-up provisioner (no code change, needs one restart).**
`scripts/provisionDemoPhcOnce.js` runs on every container start of `netrasetu-central` (Dockerfile `CMD`) and
creates a PHC named `DEMO_PHC_NAME` only if no PHC with that name exists yet.
1. Render dashboard → `netrasetu-central` → Environment → add
   `DEMO_PHC_NAME = NetraSetu Standalone PHC` → save. This restarts the service.
2. Open the service **Logs** right away and copy the two lines printed under
   `[provisionDemoPhcOnce] Provisioned a new PHC site:`:
   `PHC_ID=…` and `PHC_API_KEY=…`. **The key is printed once and never again.**
3. Leave the variable in place or remove it. Either way, later restarts do nothing.
   (If it's removed, the script looks for "NetraSetu Demo PHC", which already exists.)

**Option B: run the normal script from your laptop against the Render database.**
1. Render dashboard → `netrasetu-db` → Connections → copy the **External Database URL**.
2. Locally: `cd central-system/backend`, then run with that URL as `DATABASE_URL` (env var, not committed):
   `npm run provision-phc-key -- --create "NetraSetu Standalone PHC"`
3. Copy the printed `PHC_ID` and `PHC_API_KEY`.

**Then.** Send both values to Saad privately (not in git, not in a public chat).
- **Decided (Saad, 2026-10-02):** the key gets **baked into the downloadable zip's `settings.env`** as PHC002, so
  the downloaded station works out of the box. Accepted trade-off: anyone with the zip can upload as PHC002.
- If it ever needs revoking, run provision again for the same PHC ID. That issues a new key and the old one stops
  working immediately.

**Done when.** A capture from the standalone PHC shows `synced` on the station and appears as a case on central.

---

## 2. Also needs your Render access (found during the same check)

These block the hosted demo. They aren't about the PHC ID, but only you can change Render.

1. **Redeploy `netrasetu-phc` once Saad's quality-gate fix is on `main` (fixes "hosted PHC refuses every
   capture").**
   - Until then, `netrasetu-phc` falls back to a JS gate that was switched off in code (`82d4d5b`), so every
     `POST /captures` returns 503 `quality_gate_failed` and nothing reaches central (confirmed 2026-10-02).
   - Saad's fix (2026-10-02) rewrites `services/qualityGateFallback.js` as a faithful port of the MATLAB gate and
     re-enables it. Evidence: 0 mismatches against MATLAB on 6 + 52 images, PHC tests 41/41, and the real Dockerfile
     image run under a 512 MB cap with captures returning 201 and MATLAB's own verdicts (peak 242 MB).
   - The fix also changes `phc-local-app/backend/Dockerfile` to copy `cameraPresets.json`.
   - **No env change is needed:** `QUALITY_GATE_ALLOW_FALLBACK=1` is already set.
   - **Your step:** after the commits land on `main`, go to the Render dashboard → `netrasetu-phc` → Manual Deploy
     → latest commit.
   - **Check:** one capture on phcapp.vercel.app returns a quality result instead of "quality check could not run".
     Cases will show quality engine `js-fallback`. That is expected and honest.
2. **Decided (Saad, 2026-10-02): leave the fallback settings as they are. Do not add `MATLAB_ALLOW_FALLBACK`.**
   Kept here for the record only. **The hosted central probably can't finish grading.** `render.yaml` doesn't set `MATLAB_ALLOW_FALLBACK=1` on
   `netrasetu-central`, and with no MATLAB there `runCasePipeline` should fail the case
   (`gradingOrchestrator.js:83`, `:928`). This comes from reading the code and hasn't been live-tested.
   One test upload would settle it.
3. **Confirm the Render deploys are current.** Vercel builds are on `8a2daa5` (latest `main`). Render has
   auto-deploy off and doesn't report deploys to GitHub, so from outside nobody can tell which commit
   `netrasetu-central` / `netrasetu-phc` / `netrasetu-ml-inference` run. Each should be at `8a2daa5`.
   The last PHC-backend change is `9d20ab7`.
