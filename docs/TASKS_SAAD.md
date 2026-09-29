# Saad's task list — integration finish line

From a full audit of `integration` at `2ed512b` (your merged work + mine), 2026-09-29. Full evidence for everything
below is in `docs/INTEGRATION_AUDIT.md` if you want it; this file is just the action list, split so you and Tanuj can
work in parallel without stepping on each other. Tanuj's half is `docs/TASKS_TANUJ.md` — his items aren't repeated here.

**Blocking:** Tanuj is sending you a link to `ml-pipeline/models/` (1.5 GB, git-ignored, currently only on his
machine) — you need it before any of this runs. Checksums to verify against are in `docs/RELEASE.md`.

Deployment (Render/Vercel/where the DB and models live) is explicitly parked until after tomorrow's video — don't
spend time on it.

**Rule thresholds — nothing for you to do, it's already correct**, in case you were wondering: your own
`rule_thresholds_by_red_version.json` wiring (`gradingOrchestrator.js` → `runCasePipeline.m`) is live and both
engines already read the v2-matched thresholds when `RED_LESION_MODEL_VERSION=v2`. `rule_thresholds_red_v2.json`
(the other file, from `recalibrateRuleGate2.py`) is unused and can stay that way — different numbers, nobody reads it.

---

## P0

### 1. PHC local API: turn auth on by default
`phc-local-app/backend/.env.example:55` ships `LOCAL_AUTH_ENABLED=false`. With it off, anonymous `GET /patients`
returns real names, ages and phone numbers on `0.0.0.0` — anyone on the same network reads every registered
patient. `demo-reset` currently *requires* it off (`scripts/demo-reset.js:194`), which is presumably why it's off in
the shipped example.
- Flip the default to `true` in `.env.example`.
- `demo-reset` already creates the `technician` account — make it log in (`POST /auth/login`) and use the returned
  token for its own seeding calls, instead of relying on auth being off.
- Once that's done, `verify_peer_device_admin.js` should stop SKIPping — right now it SKIPs with "auth is off,
  passing would be a false reassurance," which is exactly this finding. Confirm it goes green.

## P1

### 2. Wire MC-dropout uncertainty on the MATLAB classifier path
`uncertaintyScore` is `null` on every case graded through the default `INFERENCE_BACKEND=matlab` path — the Case
Detail screen always shows "UNCERTAINTY NOT COMPUTED" and Tier C ordering falls back to `1 − confidence`. Python's
`branchAInfer.py` already computes it (`mcDropout.py`, ~0.1s, 20 passes) when `INFERENCE_BACKEND=python`. Either:
- (preferred if time allows) find a way to run the same MC-dropout passes through the MATLAB-imported network — you flagged in your own backend-plan-status.md that a stochastic forward pass is possible when requested as an explicit intermediate output, just not through the normal `forward()` call; or
- (fallback, cheap) explicitly document that uncertainty is only ever computed under the Python classifier backend, and make the UI say "not computed under this engine" rather than a bare "NOT COMPUTED" that reads like a missing feature.

Either way, this shouldn't be left silently null with no explanation — it currently is.

### 3. Build the quality-gate compiled executable
`phc-local-app/backend/quality-gate-matlab/dist/qualityGate.exe` doesn't exist, so `verify_quality_gate_parity.js`
SKIPs and every PHC machine needs a full MATLAB install + licence — which contradicts the "no MATLAB licence needed
on the PHC machine" design intent (`buildQualityGateExe.m` exists for exactly this, and `testQualityGateDeploy.m`
already confirms the Compiler is installed and working, 16/16). Run it, confirm the exe loads and grades a real
image, then rerun `verify_quality_gate_parity.js` and confirm it stops skipping.

### 4. Sweep pass on the verify suites (your usual territory)
A few of the root `verify_*.js` scripts are not portable and will confuse the next person who runs them:
- `verify_fovea_e2e.js` and `verify_demo_dryrun.js` hardcode `C:\Users\91740\Desktop\SIH\dr-screening-system\...` — replace with `path.join(__dirname, 'central-system', 'backend')`. I ran a patched copy of both to confirm they still pass once the path is fixed (fovea: all checks pass; dryrun also needs a real `PHC_ID`/`PHC_API_KEY` and `DEMO_*_PASSWORD` env instead of its hardcoded defaults — see the script's own top for what it expects).
- `verify_backend_auth.js` needs `DEMO_OPHTHALMOLOGIST_PASSWORD` / `DEMO_ADMIN_PASSWORD` set to match whatever `demo-reset` printed — fine as-is, just note it in the script's own header if it isn't already.
- `verify_mobile_lens.js` fails 3 checks against a fresh database because its hardcoded patient id no longer exists — needs to register its own patient first rather than assuming one.
- Bonus, low effort: one `npm run verify` (or a shell script) that runs every `verify_*` suite plus the MATLAB `test*.m` files in one go and prints a summary — there currently isn't a single command for this, and I ended up writing one by hand for the audit (happy to hand it over — it's `scripts/audit/` on my side if useful as a starting point, feel free to fold it into something more permanent).

### 5. `npm audit`
`phc-local-app/backend`: 1 high (sharp/libvips CVEs, transitive) + 3 moderate. `central-system/backend`: 4 moderate.
Run `npm audit fix` in both, rerun the full test suite (41/41 and the backend verify scripts) to confirm nothing
broke, since `sharp` is load-bearing for the JS quality-gate fallback.

## P2 — cheap, do if there's time

> **All four done, 2026-09-29 (Saad).** `.pyc` was already clean (0 tracked,
> `__pycache__/` ignored). Clutter: the `(1).md` pair needed care and got it --
> the saad copy was byte-identical and was deleted, the tanuj copy was the ONLY
> copy (its original had been replaced by the rename) and was renamed back, as
> the warning in `backend-plan-status.md` said. Generated `test_output_*.png`
> and `diag*_out/_err.txt` were UNTRACKED and git-ignored, not deleted, and the
> experiment sources (`training/diag*.py`) stay tracked. `DEMO_SETUP.md` gained
> a pg_dump/restore section including the `MEDIA_ENCRYPTION_KEY` trap.
> `DEMO_RUNBOOK.md` gained a section on the two CLI-only setup steps.
> Not touched: `experimenting Frontend/` -- `main` already deletes it
> (commit 55a85e1), so removing it here as well only risks a messy merge.

- **Tracked `__pycache__/*.pyc`** (3 files under `ml-pipeline/preprocessing/`) show up dirty on every run — `git rm --cached` them and add `__pycache__/` to `.gitignore` if it isn't there already.
- **Repo clutter**: `experimenting Frontend/`, duplicate `docs/*(1).md` files, `ml-pipeline/training/diag*.py` + their `*_out.txt`/`*_err.txt`, `test_output_*.png` — worth a tidy-up commit, not urgent.
- **Encryption-at-rest / backup**: `docs/backend-plan-status.md` already documents that OS-level Device Encryption is the remaining piece (someone with admin on the machine has to switch it on) — no code change, just make sure it actually gets turned on before demo day if the machine will have real-looking data on it. Also worth a one-paragraph `pg_dump`/restore note somewhere (`docs/DEMO_SETUP.md` seems the right place) since there currently isn't one.
- **Peer pairing / technician accounts are CLI-only** (`npm run peer -- pair`, `npm run technician -- add`) — fine for a demo run by you or Tanuj, but if there's a screen recording planned of setting up a fresh PHC, this needs to be in the runbook narration since there's no UI for it yet (the revoke side already has one, `PairedDevicesPage.jsx`).

(The Simulink validation table's raw-float display is a `.jsx` edit — Tanuj's file, since frontend stays with him.)

## When you're both done

Same as Tanuj's file: `node scripts/demo-reset.js` (exit 0), then `docs/DEMO_RUNBOOK.md` scene by scene, twice, from a
clean reset each time. Anything that breaks goes in `docs/BUGLOG.md` in the same style as the existing entries there.
