# Integration audit: what is left before this is a finished product

Audited 2026-09-29 (IST) on `integration` at `2ed512b` (Tanuj's work merged with Saad's, pushed the same day).
Deadline: tomorrow night. Everything below was run or read, not assumed; the evidence is beside each finding.

**How it was done.** Fresh `demo-reset` (database dropped, all 22 migrations from zero, real stack, five real cases graded) → every
test suite that exists → every documented endpoint probed on the live backends → every screen of both web apps driven in a browser
→ the design doc's own feature list (§9, §10, §16, §17) checked against the code → an independent measurement of the served classifier.
Not done: a phone (needs you, see the last section), a load test, a clean-machine install.

---

## 1. Verdict

**The core flow is solid.** Register → local quality gate → offline queue → sync → central grading → reviewer confirm/override → referral →
admin dashboards works end to end, twice from an empty database, with real MATLAB and real models. What stands between this and "finished" is
not the pipeline. It is (a) how the thing is delivered and configured, (b) some screens that still show invented data, and (c) four
design features that were never built on the desktop app. Nothing below needs a new model.

| Layer | State | One line |
|---|---|---|
| Database | Good | 22 migrations apply from zero; FKs, uniqueness on `capture_id_ref`, `access_log`. No backup/restore procedure. |
| Central backend | Good | Auth, roles, CSRF, encrypted media, idempotent ingestion, watchdog, supervisor, health, PDF report, Simulink validation all verified live. Real SMS is off. |
| PHC backend | Good, **but unauthenticated by default** | Sync/offline/resume verified (76/76 e2e). `LOCAL_AUTH_ENABLED=false`: anyone on the LAN can read patient names and phone numbers. |
| ML | Works; numbers need honest framing | Served model checked independently (§5). Uncertainty is not computed on the default path. No external validation. |
| Central web | Good, **two pages show invented data** | Profile and Settings. |
| PHC web | Good, **three design features missing** | Ungradable path, use-existing-patient / other eye, regional-language questionnaire. |
| Mobile | Verified by tests, **needs you** | Builds and passes 28+9+12 tests; no installable build exists. |
| Delivery | **Not done** | Model weights are not in git and the README does not say where to get them. No hosting/CI/Docker story. |

---

## 2. What was verified working (evidence)

| Check | Result |
|---|---|
| `demo-reset` on the merged code (empty DB → migrations 0001-0022 → stack → 5 real cases → 3 reviews) | exit 0, 236 s |
| `tests/e2e/verify_phc_flow.js`: registration, gate reject + retake, questionnaires, idempotency, chunked upload killed mid-way and resumed, 3 offline captures synced in urgency/age order, central 4xx/down/gate-unavailable | **76/76**, all 5 graded |
| Unit: PHC backend 41/41, PHC frontend 8/8, mobile 28/28; mobile `test:sync` 9/9, `test:peer` 12/12 (ran before the merge) | pass |
| Node suites against the live stack: auth (62 checks, needs the seeded passwords), ingestion, pipeline, health, TLS, engine provenance, camera vocabulary, report provenance, provenance UI 39/39, fallback parity (720 cases), mobile gate parity, fovea e2e | pass (auth and fovea needed inputs supplied; see §4) |
| MATLAB: `testBranchB` 54/54, `testRuleEngineSignals` 17/17, `testPhase7Explainability` 58/0 failed, `testReadFundusDicom` 8/8, `testConformalV2` 0 failures, `testQualityGateDeploy` 16/0 failed | pass |
| Contract probe of every documented GET on the live backends (`scripts/audit/contract_probe.js`) | 32/34; the two "fails" are by design: `/admin/simulink-validation` is 404 until first run (then 200, 67 s, all three metrics agree) and central `/patients/search` takes a PHC key, not a reviewer session |
| Role separation | reviewer → admin routes 403; admin → reviewer queue 403; anonymous `/media` 401; stored image decrypts for a session |
| Browser, central: reviewer queue, case detail (Grad-CAM, both branches, lesion evidence, provenance panel), confirm, override; admin overview, dashboard, referrals (3 rows), PHC health, resource planning, **Simulink co-validation (live, AGREE)** | works, console clean |
| Browser, PHC: login, registration, gate reject/retake, queue, offline/online header, Devices page, language switch | works (issues in §3) |
| Referral SMS | writes a `dry_run` notification row; nothing is sent |

Dev database note: it holds 5 cases, but the previous dev database held **2 distinct images across 143 cases** (Saad's log). No tier split, grade mix or auto-clear rate taken from any dev DB means anything. Do not quote one.

---

## 3. What is left

Effort is one person, in hours, including verifying. "Owner" is a suggestion.

### P0: do first (blocks calling it finished or shipping it)

| # | Finding | Evidence | Fix | Effort | Owner |
|---|---|---|---|---|---|
| P0-1 | **Model weights are not in git and nothing says where they are.** A fresh clone cannot grade a single case. 1.5 GB under `ml-pipeline/models/`, all git-ignored; README prerequisites do not mention them. | `.gitignore` lines 55-61; `git ls-files models/` shows only MATLAB package code; `docs/RELEASE.md` has the checksums but no location | Put the files in one shared place (Drive folder or a GitHub Release), add `scripts/fetch-models.js` that downloads and checks against the SHA-256 list in `RELEASE.md`, add one README step | 1.5 | Tanuj (owns weights) |
| P0-2 | **PHC local API has no authentication by default.** The login screen is cosmetic in the default config: anonymous `GET /patients` returns names, ages and phone numbers; `/captures`, `/peer/devices` too. It listens on `0.0.0.0`. `demo-reset` even requires it off. | `curl localhost:4200/patients` → 200 with data; `phc-local-app/backend/.env.example:55` `LOCAL_AUTH_ENABLED=false`; `scripts/demo-reset.js:194` | Default it to `true`, make `demo-reset` log in (it already creates the technician), rerun `verify_peer_device_admin` (it SKIPs while auth is off) | 2 | Saad |
| P0-3 | **Central Profile page and Settings page show invented data.** A default personal email (`krrishgadekar@gmail.com`), a phone number, "Level 4 · District Chief", "DNW-MM-PUN-042", "7 PHCs / 64 villages / 18 reports", an assigned-PHC list of seven sites when the system has two, "Last login today, 9:12 AM from Pune". Settings toggles (PIN or fingerprint unlock, Wi-Fi-only sync, low-data mode, "Last synced 11:30 PM") are stored in `localStorage` and do nothing. This breaks the project's own rule that no screen fabricates. | `CentralProfileDrawer.jsx` lines 22, 25, 39, 192, 250-260, 353; screenshots of `/admin/profile` and `/admin/settings`; `FieldOpsPage.jsx` (unrouted dead code with fake PHCs) | Bind profile to `/auth/me` and `/admin/phcs`; delete or hide the dead settings and keep language/theme; delete `FieldOpsPage.jsx` | 3 | Kankshi/Vedant (UI) |
| P0-4 | **Patients never receive an SMS.** `SMS_DRY_RUN=1` and no Twilio credentials. The referral row says `dry_run`. | `central-system/backend/.env` (lengths 0); `notifications.status = dry_run` | Decide: get a Twilio account (trial accounts can only text verified numbers) or say in the demo that SMS is a dry run with the message shown | 1 + credentials | Tanuj decides |
| P0-5 | **"What is the deliverable?" is undecided.** Everything runs on one machine with MATLAB; the two Vercel deployments build in mock mode by default (they show the DEMO DATA banner); there is no Dockerfile, no CI, no hosting config for the backends. | `find . -name Dockerfile` (none), `vercel.json` in both frontends, README | Pick one: (A) local install on the demo/judging laptop plus recorded demo, with the Vercel sites labelled as mock previews; or (B) hosted, which is 1-2 days and cannot include MATLAB inference without a licensed server. Recommend A for tomorrow. | decision, then 1-2 | Tanuj |

### P1: design features that are missing or hollow (a judge can find these)

| # | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|
| P1-1 | **No ungradable / "best effort" path on the desktop (design §10.2).** Three failed retakes still offer only RETAKE. A patient whose media is opaque can never be recorded, referred or flagged. The code comment says so. | Tested in the browser: three failing attempts, no new option; `QualityResultPanel.jsx:186-190`. Mobile has it. | Offer "best effort: proceed as ungradable" after 3 failed attempts; queue with `bestEffort`, force Tier C centrally; the backend already carries `best_effort` | 5 |
| P1-2 | **No "use this patient" or "capture the other eye" on the desktop.** The duplicate check only warns; every revisit or second eye creates a second patient record, so `priorAssessments` (longitudinal history) can never fill and two-eye visits double-register (design §10.3, §10.4). Mobile has find-existing. | `PatientRegistrationForm.jsx:562-610` (advisory card, no action) | Add "USE THIS PATIENT" on a match and an "add other eye" action from the queue row | 4 |
| P1-3 | **Patient questionnaire and consent text are English only on the desktop.** Switching to Hindi translates the header and nav only (design §4.1 wants regional-language labels). Locales are also incomplete: PHC and mobile have 83 of 108 keys translated, central only Hindi/Marathi. | Browser screenshot in Hindi: the whole questionnaire and consent block stay English | Put the form strings behind `t()`, translate the missing keys (Hindi and Marathi first) | 4 |
| P1-4 | **Uncertainty is never computed on the default classifier path.** MC-dropout returns null under the MATLAB backend, so the UI always reads NOT COMPUTED and the Tier C queue ranks by 1 − confidence. | `verify_fovea_e2e` log: "MC-Dropout not implemented for the MATLAB backend"; case detail "UNCERTAINTY NOT COMPUTED" | Compute it from the same checkpoint through `mcDropout.py` (~0.1 s) and store it, or disclose it as not measured | 3 |
| P1-5 | **The PHC quality gate has no compiled executable**, so every PHC needs a MATLAB install and licence. That contradicts the "no licence on the PHC machine" claim. | `quality-gate-matlab/dist/` absent; `verify_quality_gate_parity` SKIPs | Run `buildQualityGateExe.m` (Compiler is installed), test `verify_quality_gate_parity`, document the Runtime install | 2 |
| P1-6 | **Continual learning is dormant.** The service is never started; `retrainBranchA.m` does not exist. Review corrections are stored (`corrections`, `dataset_labels`, export script) but nothing retrains. | `grep continualLearning`: only its own file; no `retrainBranchA.m` | Either wire a scheduled dry-run of the promotion gate, or present it honestly as "corrections captured and exportable; retraining is manual" | 2 (honest) or 12+ (wired) |
| P1-7 | **Camp mode's relay device (design §9.5) is not built.** Batch screening is only the ordinary offline queue. | no `relay` code anywhere in `phc-local-app` | Remove it from any claim, or build it (about 2 days, not recommended) | 0.5 |
| P1-8 | **Mobile has no installable build.** No `eas.json`; it runs in Expo Go on the same Wi-Fi only. The laptop's LAN address changed between yesterday and today (`.36` → `.41`), which breaks a saved server address. | no `phc-local-app/mobile/eas.json`; `ipconfig` | Build an APK (needs an Expo account) and give the laptop a fixed address or hostname for the demo | 3 |

### P2: hygiene and honesty (cheap, do them if time allows)

| # | Finding | Fix | Effort |
|---|---|---|---|
| P2-1 | **`verify_*` suites are not portable.** `verify_fovea_e2e.js` and `verify_demo_dryrun.js` hard-code `C:\Users\91740\...`; the dry run also hard-codes a PHC UUID and default passwords; `verify_backend_auth.js` needs the seeded passwords; `verify_mobile_lens.js` assumes a patient exists; `verify_peer_device_admin.js` needs an auth-on stack on `:4000`; `testCalibrationPhase6` has one stale check; `verifyPhase4` is known red. There is no single "run everything" command. | Fix the paths, add `npm run verify` that runs the lot and reports SKIPs loudly | 3 |
| P2-2 | Compiled `__pycache__/*.pyc` (3 files) are tracked in git and dirty the tree on every run. | `git rm --cached`, add to `.gitignore` | 0.2 |
| P2-3 | Clutter tracked in git: `experimenting Frontend/`, `docs/*(1).md` duplicates, `ml-pipeline/training/diag*.py`, `diag*_out.txt`, `*.log`, `test_output_*.png`, root-level `verify_*.js` | Move or delete | 1 |
| P2-4 | `npm audit`: PHC backend 1 high (`sharp`/libvips CVEs) + 3 moderate; central backend 4 moderate; mobile 19 moderate (Expo transitive); both web apps clean | `npm audit fix` on the backends, retest | 1 |
| P2-5 | Encryption at rest for Postgres and the PHC SQLite is still the OS-level action (Windows Device Encryption, admin needed); there is no documented backup and restore procedure for the database | Turn on Device Encryption; write a `pg_dump` / restore note | 1 |
| P2-6 | Phone pairing and technician accounts are CLI-only (`npm run peer -- pair`, `npm run technician -- add`); no screen pairs a phone. Revoking is in the UI. | Document for the demo, or add a pair screen | 1 or 4 |
| P2-7 | PHC app starts on a stale session, shows the registration form for ~2 s, then bounces to login (fix from yesterday works, but the flash is visible) | Check the token with `/auth/me` before rendering the authed layout | 1 |
| P2-8 | Simulink validation table prints raw floats (`39.95160468670402%`); tier-fraction and arrival-pattern cells of the assumptions panel are empty | Round the numbers, fill or hide the cells | 0.5 |
| P2-9 | `origin/main` is 6 commits behind `integration` (all yours, from today and yesterday). Every other teammate branch is already contained in `integration`. | Open the PR `integration` → `main` after the freeze | 0.2 |

---

## 4. Test notes: what "failing" meant

Not product failures, but they will trip anyone else: `verify_backend_auth` and `verify_demo_dryrun` use default passwords that `demo-reset`
deliberately randomises; `verify_fovea_e2e` and `verify_demo_dryrun` point at `C:\Users\91740\...` (fixed in a temporary copy, then 100% pass for
fovea); `verify_mobile_lens` fails 3 checks because its hard-coded patient id no longer exists; `verify_peer_device_admin` SKIPs correctly while
`LOCAL_AUTH_ENABLED` is off (which is finding P0-2). Two MATLAB suites are red for known reasons: `testCalibrationPhase6` (a stale check that expects the
old stub's error) and `verifyPhase4` (Saad's logged harness issue). `verify_quality_gate_parity` SKIPs because the JS fallback is deliberately off and no
executable is built.

---

## 5. ML: what the served model actually does

Independent run of the **served** classifier (`branchA_v2c`, the `branchAInfer.py` code path, calibrated) on the **103 official IDRiD test images**
against the ground-truth CSV (`scripts/audit/eval_idrid_test.py`):

| Metric | Result | PS target |
|---|---|---|
| Referable-DR sensitivity, live referral flag | **100%** (64/64); by grade ≥ 2 argmax: 96.9% | > 90% ✅ |
| Referable-DR specificity, live flag | **82.1%**; by argmax: 79.5% | > 85% ❌ |
| Quadratic-weighted kappa | 0.841 | (0.85 near-term goal) |
| Exact grade / within one grade | 77.7% / 91.3% | |
| Grade-4 recall | **13/13** (was 0.444 on v1) | |
| Tiers | A 4 · B 70 · C 29 (of 103) | |
| Tier A but truly referable (false auto-clear) | 0 | |
| Prediction sets contiguous (no {0,3}-style gaps) | 83.5% | design §18 open item |

**Read this as a smoke test, not validation.** The temperature and thresholds were fitted on a pool that includes these 628 test images
(`calibration_branchA_v2c.json`: "pooled val+test, n=1161"), so the numbers are optimistic. What it does establish: the deployed model is not
broken, the safety property (no missed referable case in this set) holds, and **specificity is below the PS bar while sensitivity clears it**.
Consequences to say out loud: only **4% of cases auto-clear**, so reviewers see about 96% of cases (the Simulink model says capacity is fine at this
volume, which is true, but it undercuts an "AI reduces specialist load" pitch); and there is **no external validation** (Messidor-2 was never run).

Other ML facts, all in the docs, worth having in your head before a judge asks:
- Rule engine (Branch B) cannot see venous beading or IRMA (detectors cut), so it can under-call severe NPDR; the evidence text says so on every case.
- Neovascularization suspicion is gated off (AUC at or below chance); it decides nothing.
- `models/rule_thresholds_red_v2.json` is **not wired** and is waiting on a decision: it changes grading (15 of 52 held-out grades move). CLAUDE.md forbids changing thresholds without your say-so, so it was left alone.
- Soft exudates are `null` by design; microaneurysm and haemorrhage counts are real under M5 v2.
- Grading takes about 21-25 s per case with the MATLAB session and segmentation worker up; the gate takes 10-15 s (fresh `matlab -batch`).

---

## 6. Decisions only you can make

1. **Deliverable** (P0-5): local install + recorded demo (recommended), or hosted.
2. **SMS** (P0-4): real Twilio, or dry run stated openly.
3. **Threshold recalibration** (`rule_thresholds_red_v2.json`): wire it or leave it (sensitivity vs 6 fewer escalations; needs a stated operating point).
4. **Continual learning and camp relay**: honest "designed, not wired" wording, or spend time on them (I recommend the wording).
5. **Which of P1-1 … P1-3 make the cut** for tomorrow night: I would do P1-1 and P1-2 (clinical workflow), P1-3 for Hindi/Marathi only.

## 7. Suggested order for the next ~36 hours

1. **Tonight:** P0-1 (weights), P0-2 (auth default), P0-3 (fake profile data), decisions 1-4. Saad on P0-2 and P1-5; UI owner on P0-3; you on P0-1.
2. **Tomorrow morning:** P1-1, P1-2, P1-3 (Hindi/Marathi), P1-4. P2-2 and P2-3 whenever someone is waiting on a build.
3. **Tomorrow afternoon:** freeze `integration`. `demo-reset`, run `docs/DEMO_RUNBOOK.md` twice, tag, open the PR into `main`. Anything found goes in `docs/BUGLOG.md`.
4. **Your phone tests (below) can run in parallel with all of it.**

---

## 8. Mobile: what I need you to test by hand

The stack is up and the app is already configured for it (`phc-local-app/mobile/.env`, git-ignored): server `http://192.168.1.41:5200`, current PHC001 key.
On the laptop: `cd SIH_2026-integration\phc-local-app\mobile` then `npx expo start --clear`. Phone on the same Wi-Fi (`BHIDE-5G`), open in Expo Go. Login is the
demo technician shown on the login screen. If the laptop's address changed again, the server address is under Menu → Device settings.

| # | Do | Expect |
|---|---|---|
| M1 | Register a patient (fill every question, tick consent) | The Register button will not proceed until every question is answered |
| M2 | Import `tests/fixtures/idrid_010_good_pass_w1800.jpg` from the gallery → quality result → capture questions → SAVE & SYNC | Gate passes; queue goes pending → synced → RESULT READY in about 30 s; on central (`:5174`, reviewer login) the case appears and Case Detail reads Quality gate: JS-DEVICE |
| M3 | Import `idrid_164_bad_blur_dark.jpg` | Rejected on the phone with a retake reason; nothing queued |
| M4 | Wi-Fi off → capture two images → Wi-Fi on | Queue shows 2 pending while offline; both sync, no duplicates |
| M5 | Fail the gate three times for one patient | A "best effort / ungradable" option appears (the desktop lacks this, P1-1) |
| M6 | Registration → search the patient from M1 → capture the other eye | Reuses the patient, no duplicate record (the desktop lacks this, P1-2) |
| M7 | Open a finished case in the app | Report and Grad-CAM load from central |
| M8 | Switch language to Hindi on the registration screen | Tell me whether the questionnaire and consent text translate (the desktop's do not) |
| M9 | Kill the app mid-upload (large image), reopen | Resumes, no duplicate case |

Tell me what fails and I will fix it or log it.
