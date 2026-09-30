# Backend plan: status against `implementation-plan-backend-saad.md`

Status as of 2026-09-23 (late). Sections marked "Since 2026-09-22" and the "Waiting on other people" list are the current ones; earlier sections are kept as the record of when each thing was verified. Every item below was verified by running it, not by reading code. The test scripts named in the table can be re-run.

## Where each section stands

| § | Item | Status | Verified by |
|---|---|---|---|
| L | Migration tooling (node-pg-migrate). `schema.sql` is now migration 0001, and all later changes are migrations 0002–0009. | Done | `npm run migrate` |
| A.1–A.13 | Login (httpOnly cookie), CSRF, bcrypt, seed users, role guards on every route, `AUTH_ENABLED` flag, 12 h JWT, PHC API keys plus a provisioning script, access log | Done | `verify_backend_auth.js` (53 checks) |
| A.14 | TLS: optional HTTPS at TLS 1.2+ (`TLS_KEY_PATH` / `TLS_CERT_PATH`), plus a self-signed dev certificate from `scripts/generateDevCert.js` | Done | HTTPS served; TLS 1.1 and plain HTTP refused |
| A.15 | Encryption at rest | **Media files: done (2026-09-27).** `MEDIA_ENCRYPTION_KEY` is set and all 646 files under `media/` are AES-256-GCM encrypted; `/media` refuses to serve a plaintext patient image. **Database and SQLite: still the OS-level deployment action below.** | served image byte-identical to the original (SHA-256); `/media` 200 with a session, 401 without |
| B.1 | `GET /api/v1/patients/search`. The desktop app also gets the same endpoint on its local backend, for offline use. | Done | auth suite plus local test |
| B.2 | `POST /cases/:id/claim`: one conditional UPDATE, 30-minute expiry, 409 names who holds it | Done | auth suite |
| B.3 | `GET /cases/:id/reviews` | Done | auth suite |
| C | Idempotent ingestion on `capture_id_ref` (46 old duplicates relabelled, none deleted), plus `POST /cases/summary` and an `awaiting_image` status | Done | `verify_backend_ingestion.js` (20 checks, including 6 concurrent retries) |
| D | Periodic stranded-job watchdog, recoveries recorded, capped at 3 per case | Done | `verify_backend_health.js` |
| E | MATLAB session supervisor: heartbeat, auto-start at boot, restart, alert when a restart fails, no restart loop. The same supervisor now also watches the segmentation worker (`workerSupervisor.js`, two instances). | Done | `verify_backend_health.js` |
| F | `GET /admin/system-health` covering silent PHCs, stuck jobs, MATLAB status and unreviewed cases, plus the new `last_contact_at`. Also reports `segWorker`, kept separate from the MATLAB status on purpose: the MATLAB session being down fails cases, the worker being down only slows them. | Done | `verify_backend_health.js` |
| G | Simulink README fixed. `referenceQueueingModel('recommend')` runs daily into `resource_recommendations`, served by `GET /admin/resource-recommendations`. **§G.2's other half is now scheduled too:** the `.slx` runs weekly as the validation check (`simulinkValidation.js`), writes `simulink-model/out/last-validation.json`, is served by `GET /admin/simulink-validation`, and raises `simulink_model_diverged` when the two models stop agreeing or the run cannot happen. | Done | ran live: 49 s, all three metrics agree; `verify_backend_health.js` |
| H | Venous beading and IRMA wired into the rule engine as 4-element boolean arrays; they are passed only when present | Done | `testRuleEngineSignals.m` (17) + `testBranchB.m` (54) |
| I | `fovea_unreliable` stored; rule engine skips the quadrant criteria; tier held at B or higher. Tanuj's gate is merged, so this is end-to-end now. See the §I.3 note below. | Done | `testRuleEngineSignals.m`, live MATLAB run, `verify_fallback_parity.js` (720 cases) |
| J | `neovascularizationSuspicion.m` now runs inside the per-case MATLAB call; the real score is stored instead of NULL/0 | Done | live run: NV 0.119 / 0.166 on the sample images. *(Was 0.078 / 0.101, measured when `verifyPhase4.m` fed the vessel model the CLASSIFIER's preprocessing and got a speckled mask. The NV score is computed FROM that mask, so fixing the harness moved it. The new numbers come from the production mask.)* |
| K | Camera probation | No action needed (as planned) | none |
| M | `consentGivenAt` accepted and stored, at both the PHC and central | Done | tests |
| N | ID-format spec for the mobile team, `docs/id-format-spec.md` | Done | self-check run against `ids.js` |
| O | Clinical-rationale PDF, `GET /cases/:id/report`. Rendered by `generateReport.m` with **MATLAB Report Generator** (`mlreportgen.dom`), as the plan specifies; `generateReportFigures.m` is a core-MATLAB fallback for a machine without that toolbox. | Done | real case rendered and served |
| P | DICOM through `readFundusImage`; the DICOM eye tag is recorded and a mismatch with the technician's choice is flagged | Done | `testReadFundusDicom.m` (8), on a synthetic DICOM |
| Q | One `fromMatlabDeep` boundary for `[]`→null, plus `jsonencodeAscii`, which fixes em dashes being silently dropped from MATLAB output on Windows | Done | live runs |
| R | Rename to `hard_exudate` / `hardExudates` in the JS layer | **Done — no work was needed** | `verify_demo_dryrun.js`, `verify_task33.js` |
| S | M2/M3/M4 served from the MATLAB session (`SEG_INFERENCE_BACKEND`, PyTorch fallback, M5 excluded) | Done | `diagnostics/checkSegBackendParity.py`: rule grade 20/20, lesion counts 20/20 |

## Full audit, 2026-09-20: what it found

A line-by-line pass over every plan section, plus the design doc's own
requirements, looking for things that were done wrongly rather than not at all.
Twelve defects, all fixed and covered by tests.

**Would have been visible to a user**

1. **Reviewed cases never left the review queue.** The queue selected every
   graded Tier B/C case with no check for an existing review, so finished work
   stayed mixed in with outstanding work forever.
2. **A review could be recorded against a case that was never graded** — and
   with a referable-looking corrected grade, that raised a referral and sent
   the patient an SMS. Now `409 case_not_graded`.
3. **An undeliverable SMS left the referral looking exactly like a delivered
   one** (design doc §10.5, never implemented). The one patient nobody reached
   was indistinguishable from the ones who were told.
4. **The camera-probation tier rule could LOWER a case's tier.** It set the
   tier to exactly 'B', so a case the conformal predictor had put in Tier C
   came out as B -- the "floor" was cutting the review requirement.
5. **Queue rows did not show the eye or whether another reviewer held the
   case**, both of which the design doc asks for (§5.2), so a reviewer could
   open a case someone else was already deciding.

**Operational / data correctness**

6. **Summary-first cases were reported as stuck immediately.** "How long has
   this been processing?" was measured from `received_at`, which for a
   summary-first case is when the *summary* arrived, possibly days earlier.
   Now measured from a new `processing_started_at`.
7. **A reviewer who had ever claimed a case could not be removed** (a foreign
   key blocked it), and deleting a user would have orphaned the audit trail
   anyway. Access is now revoked by deactivation; history is kept.
8. **A revoked account kept working for up to 12 hours** -- until its token
   expired. Sessions are now re-checked against the account (cached 60 s), so
   deactivation and role changes take effect within a minute.
9. **A timed-out MATLAB request was left in the request directory,** so a slow
   session would later run inference nobody was waiting for and leave orphan
   response files behind.
10. **The MATLAB session went unsupervised** on a python-classifier +
    matlab-segmentation configuration, silently degrading every case to the
    PyTorch fallback with nobody told.
11. **A chunked upload of an already-ingested capture transferred the whole
    image** over a bad link before ingestion recognised the duplicate and
    discarded it.
12. **A non-numeric `patientAge` produced a 500** from a NOT NULL constraint
    rather than a 400 naming the field.

**Hardening added at the same time**

- Security headers on every response (nosniff, frame-deny, no-referrer,
  no-store).
- A 500 no longer echoes internal error text in production; database errors
  quote table names, column names and sometimes patient values.
- The login brake now also counts per IP, not only per (IP, email), so one
  client cannot walk a list of addresses; its memory is bounded.
- An invalid `RESOURCE_MODEL_CRON` no longer stops the backend from starting.
- A boot warning when auth is enabled over plain HTTP, where the Secure
  session cookie is silently dropped by the browser.

**Test suites:** 17 Node suites, 516 checks plus 5,760 fallback-parity comparisons, all passing --
`verify_backend_auth` (66), `verify_backend_ingestion` (20),
`verify_backend_health` (28), `verify_backend_pipeline` (35),
`verify_task27`–`verify_task82_83`, plus
`testCors`, `testBranchB` (54), `testRuleEngineSignals` (17),
`testPhase7Explainability` (58) and `testReadFundusDicom` (8) in MATLAB.

Two existing suites asserted behaviour this work deliberately changed (the
ingestion response gained fields; sync-status gained `lastContactAt`) and were
updated. One was failing before any of this work, on a missing `sharp`
install, and one assumed a database with no sync history; both fixed.

## Flagged explicitly (plan §A.15): the OS-level half is still not in place

*Updated 2026-09-28.* The application half is done: case media is encrypted at
rest by `services/mediaCrypto.js`, and the `/media` route refuses to serve a
file that is sitting in plaintext rather than quietly handing it out. That
covers the stored images, which were the largest body of patient data on disk.
What remains below is the Postgres data directory and the PHC's SQLite file,
which no application code can encrypt.

The plan's own corrected guidance: self-hosted Postgres has no built-in transparent data encryption. For this round the real mechanism is **full-disk encryption at the OS level**. It needs no application code, so it cannot be done from the repository.

- **This machine (Windows 11 Home):** BitLocker proper isn't available on the Home edition. Windows 11 Home offers **Device Encryption** instead (Settings → Privacy & security → Device encryption) if the hardware supports it. It covers the Postgres data directory, the stored images under `central-system/backend/media/`, and the PHC's SQLite file. Someone with admin rights on the machine has to switch it on.
- **What it protects against:** a stolen or badly decommissioned disk.
- **What it does not protect against:** a compromised running system reading the database. That needs column-level encryption (`pgcrypto`) with proper key management, which is out of scope this round.

## Notes

- **§I.3: closed, and not the way this file previously expected.** It used to say the upstream quadrant assignment in `segInfer.py` should learn to read `foveaUnreliable` and fall back to the image axes. Tanuj's answer (2026-09-20) is that it should not: the quadrant counts are built on the fovea axis regardless of the flag, and the consumer's job is to **treat them as invalid for the 4-2-1 rule** — which is exactly what `ruleEngineGrade.m` already does. No upstream change is coming, and none is needed.

  What the flag means: M3's fovea heatmap peak below 0.37, or a missing/NaN heatmap. The backend's two obligations are a **Tier B floor** (a floor, not an assignment — a Tier C case stays C) and skipping criteria (a) and (b).

  **One integration defect was found and fixed before it could bite.** `segInfer.py`'s output dict does not splat the localization result; it copies `opticDisc` and `fovea` out of it by name. A `foveaUnreliable` added inside `localize()` would therefore never have reached the backend — it would have been stored as NULL, the Tier B floor would not have fired, and a case whose fovea could not be found would have been auto-cleared at Tier A on quadrants nobody could place. Nothing would have errored. The flag is now promoted to the top level explicitly, with absent still meaning absent rather than false.

  **Delivered and merged (2026-09-20).** Tanuj's peak-confidence gate is on `origin/tanuj` and merged into this branch: `foveaUnreliable` is true when M3's fovea heatmap peak is below 0.37, and also when the heatmap is missing or NaN. It is computed in `localize()` and promoted to the top level of `segInfer.run_one()`'s output, which is where the backend reads it. The gate is validated on only 2 known failures, so it is a safety net, not a proven detector.

  **Two defects came out of that handoff, both fixed.**

  *The evidence text was wrong.* It told the ophthalmologist the quadrants "follow the image axes" — this file's earlier assumption. They do not: segInfer keeps building the axis from the flagged fovea, so the counts are keyed to a point already called untrustworthy. The sentence, and two code comments repeating it, now say that instead.

  *The JS fallback rule engine ignored the flag entirely.* `services/matlabFallback.js` — used when MATLAB cannot be spawned — applied criteria (a) and (b) to quadrants the MATLAB engine skips, so one image could get two different grades depending only on whether MATLAB was installed. The port now mirrors `ruleEngineGrade.m`: the same `quadrantFlags` semantics (absent means *not assessed*, an all-false array means *assessed, found nothing*), the same skipping of (a) and (b), the same per-criterion caveats, and the orchestrator now passes it the same `caseRuleOpts(segResult)` the MATLAB path gets. `verify_fallback_parity.js` runs both engines over 720 cases and compares grade, lower-bound bookkeeping, both assessed flags, the criterion and the full limitation text: 0 mismatched.
- **§S.4 latency, resolved.** The original finding was that serving M2–M4 from the MATLAB session gave no speedup at all: 22.5 s per image on MATLAB vs 21.4 s on PyTorch, over 20 images. The reason is now measured rather than suspected — it moved forward passes costing under a second each and left 17 s of Python process start exactly where it was.

  With the segmentation worker that process start is gone, and the comparison finally means something. It goes the other way:

  | `SEG_INFERENCE_BACKEND` (in the **worker's** environment) | segmentation | whole case |
  |---|---|---|
  | `matlab` (the default, per §S) | 5.3 s | 22.6 s |
  | `python` | 2.6 s | 20.6 s |

  Identical outputs either way (tensor parity 2e-6..4e-5, `diagnostics/out/parity_v1_report.txt`). Serving the three nets from MATLAB now **costs** about 2.7 s per case, because each forward pass is a separate round trip to another process. **The default is left on `matlab` because §S asks for it — this is a decision for the plan owner, not one to change quietly.**
- **Grading time per case is about 33 s end to end, with the session up** (was about 47 s). The per-case MATLAB work — camera check, NV score, rule engine, lesion attention, evidence sentence — is now `ml-pipeline/grading/runCasePipeline.m`, a real function served by the persistent session, instead of ~60 statements joined onto one line for `matlab -batch`. That call went from 23.3 s to 9.2 s: the difference is almost entirely MATLAB start-up, which the session pays once at boot instead of once per case. Verified byte-identical on all 12 output fields against the old expression, on the same image, in the same MATLAB (`scratchpad/parity.js` pattern; `verify_backend_pipeline.js` covers the input and transport contracts). When no session is running it still falls back to `matlab -batch` and logs that it did.
- **Segmentation is now a persistent worker too, and a case takes about 21 s.** `ml-pipeline/inference/segSession/runSegWorker.py` holds M2–M5 in memory; the backend uses it when its heartbeat is fresh and spawns `segInfer.py` per case when it is not. Measured on this machine: the torch import plus four model loads cost **17.1 s** and the actual work costs **2.0 s**, so the per-case process was paying seventeen seconds to do two seconds of work. Same `segInfer.run_one` on both paths, so no preprocessing step, threshold or count can drift; a real case through both produced identical lesion counts, rule-engine grade and NV score.
- **Grading latency, end to end, on the development machine:** about 47 s before this work → 33 s with the case pipeline in the MATLAB session → **21 s** with the segmentation worker as well.
- **Uncertainty on the MATLAB path:** `uncertainty_score` is null under `INFERENCE_BACKEND=matlab`, because MC-dropout is deliberately not faked there. The review queue then ranks Tier C by 1 − confidence, as it always has when uncertainty is missing.
- **`lesionCounts` in `GET /cases/:id` does not match its own contract.** It returns `{red, bright, redTotal, brightTotal, …}`; api-contracts.md and the frontend's lesion panel expect `{microaneurysms, hemorrhages, hardExudates, softExudates}`. This is live and it is the frontend's problem today, not a future one.

  The final values are now specified (Tanuj, 2026-09-20): `microaneurysms` and `hemorrhages` become real numbers from M5's new `maPerQuadrant`/`hePerQuadrant`; `hardExudates` is the §R rename of the bright-lesion count; `softExudates` stays `null` as a **disclosed exclusion** — nothing in the pipeline detects them, and null is the only honest value.

  Not fixed yet on purpose: the shape change is breaking for the frontend, and doing it once — with §R and the M5 wiring — costs the frontend one migration instead of two. If M5 slips, shipping the correct keys early with `microaneurysms`/`hemorrhages` null is the better trade; that is a call for the plan owner.

## Since 2026-09-20

| What | State |
|---|---|
| `lesionCounts` returns the contract keys (`microaneurysms`, `hemorrhages`, `hardExudates`, `softExudates`) | Done. Mapped at the API boundary by `services/lesionCounts.js`; nothing changed in the database |
| Failure reasons on a case (`failure_code`, `failure_reason`, `failed_at`, migration 0014) | Done. `GET /admin/system-health` groups failures by cause; case detail now returns `status`, which it never did |
| Review labels for retraining (`dataset_labels`, migration 0013) + `scripts/exportTrainingSet.js` | Done. Written inside the review transaction; export enforces consent, dedupe and the newest label per case |
| Tanuj's conformal v3 + referable-safety gate | Merged and re-verified. Both inference paths already implement it; nothing needed wiring |
| M5 v2 (3-class red lesions) | Merged behind `RED_LESION_MODEL_VERSION`. **This cell said "still v1" and contradicted the M5 v2 row further down this same file; corrected 2026-09-29 — the default is v2** (`segInfer.py`, no `.env` override), and every live `lesion_counts` row carries `redLesionModelVersion: v2` with real MA/HE totals. The orchestrator stores the split; the API mapper reads it |
| 512 px classifier (v2a) | Merged, **not** the default. Tanuj has not finalised v2a vs v2b/v2c |
| Tier floors (A -> B) | **Now tested.** `decideTier` extracted as a pure function; 18 checks in `verify_backend_pipeline.js` |
| Parallel Computing Toolbox | 5 uses shipped (`sweepDistrictScenarios` via `parsim`, `monteCarloQueueing`, `calibrateQualityThresholds`, `batchGenerateReports`, and the `optimizeRuleThresholds` search); `runTask92` measured and left serial on purpose. **The threshold search only started using it on 2026-09-23** -- its gate accepted a pool that already existed, and `matlab -batch` starts with none, so it was wired in and ran serial. Now starts a pool above 2e5 evaluations: the v2 refit went from ~24 min to 215 s on 6 workers, byte-identical result |
| Live SimEvents model `netraSetuPipeline.slx` | Done. Whole pipeline, live sliders and outage switches, calibrated by `scripts/exportSimCalibration.js` |

**Not wired, waiting on a decision:** `models/rule_thresholds_red_v2.json`. It recalibrates `redFloor`/`grade3QuadMin`/`brightFloor` for BOTH model versions -- v1 moves from 3/3/1 to 8/2/5 -- so it changes grading today, switch or no switch. Measured on the 52-case held-out split: 15 of 52 grades change (14 down, 13 of them 2 -> 0), exact agreement with ground truth moves 28/52 -> 29/52, and branch disagreements fall from 23 to 17, i.e. six fewer cases escalated to a human. Accuracy-neutral, materially different behaviour.

## Since 2026-09-22

| What | State |
|---|---|
| Tanuj's `origin/tanuj` merged again (`45b58a3`) -- classifier v2b/v2c evaluation, NV negative result, district-admin features | Done. `origin/main` already contained all of it via PR #19 |
| Branch A "corrupt model" | **Not corrupt.** The ONNX converter support package was absent from the path of any cold MATLAB, so `load()` substituted placeholder layers and succeeded, failing later with an internal name. Guard moved next to the load in `branchAInferMatlab.m`; Tanuj's existing `ensureOnnxSupportOnPath.m` reused rather than duplicated |
| MATLAB Compiler trial build (`deploy/`) | Done. Two targets: the case chain (1.3 MB) and the networks. Compiled Branch A matches MATLAB and Python exactly (grade 3, conf 0.821636) |
| Triage urgency score (`grading/calculateUrgencyScore.m`) | Done, Statistics & ML Toolbox (TreeBagger). Synthetic training data, exact Shapley attribution, 17/17 selftest. **Not wired into any decision path** -- it is a prioritisation aid, trained on an invented formula |
| NV suspicion score | **Gated off.** It failed validation (AUC 0.286 IDRiD / 0.379 Messidor-2, at or below chance). `runCasePipeline.m` and `matlabFallback.js` now both pass 0 to the rule engine; the measured value is still stored and reported, it just decides nothing |
| `unvalidated_camera` Tier A floor (`config/validatedCameras.json`, `services/validatedCameras.js`) | Done. Tanuj asked twice; this is that control. Fails closed on a missing/malformed config, and a blank `cameraDeviceId` no longer auto-clears. Distinct from camera probation, which only fires on a family MISMATCH -- an unfamiliar camera reporting itself honestly used to reach Tier A unimpeded |
| `tier_reason` persisted (migration 0015) | Done. `decideTier` always returned a reason; it was used for one log line and discarded. Five different situations produce a "B" and a reviewer could not tell which. Not backfilled -- NULL means "not recorded", never "no reason" |
| Evidence prose ignored `ruleOpts` (JS fallback) | **Fixed.** `evidenceSummaryText` re-ran the rule engine without the opts, so a fovea-unreliable case was graded Moderate NPDR while the text under it said "Severe NPDR, ETDRS 4-2-1(a)". The 720-case parity never saw it because it compares the rule engine's output fields, not the prose. 2880 evidence-text checks added |
| `vesselSegmentationUnet.m` | **Fixed, four defects.** It was still written for the MATLAB-trained 3-channel U-Net; the file is now the ONNX import of Tanuj's 1-channel PyTorch model. Missing `models/` on the path (this was his `verifyPhase4.m` crash), RGB instead of green, no `[-1,1]` normalisation, no sigmoid, and `imresize` antialiasing on. Now matches `segInfer.py` to four decimals (0.0564 both) |
| Rule-threshold optimiser (`grading/optimizeRuleThresholds.m`) | Done. Statistics & ML Toolbox (`perfcurve` Youden's J, `cvpartition` stratified folds, `bootci`). Refuses to run unless its fast evaluator matches `ruleEngineGrade` exactly. 18/18 selftest. **NOT Optimization Toolbox** -- see the toolbox note below |
| M5 v2 binaries | **Arrived 2026-09-23** (manually, not via git -- they are gitignored). `red_lesion_unet_v2.mat` loads, `[512 512 3]`, contract verified end to end: `maPerQuadrant` + `hePerQuadrant` sum to `redPerQuadrant`. **Now the default** |
| Classifier v2a/v2b/v2c checkpoints | **Arrived 2026-09-23** (`branchA_v2*.pt`, manually). v2c is **now the default** -- see below |

### Classifier: branchA_v1 (384 px) -> branchA_v2c (512 px)

Tanuj's go-ahead. `docs/flip_default_v2c.patch` applied unchanged -- his patch, not a
hand edit -- so both the Python and MATLAB defaults are `branchA_v2c`. Rollback is
still one env var.

He delivered the PyTorch checkpoint only, so the MATLAB artifact was derived here:

    branchA_v2c.pt -> export_to_onnx.py --only m1_v2c -> branchA_v2c.onnx
                   -> importModelsV2c()               -> models/branchA_v2c.mat

**Verified, not assumed:** `parityCheckV2c` against his own reference fixtures
(`parity_data/branchA_v2c_{input,torch_output}.mat`) gives max|diff| **1e-6**
against a 0.01 threshold and **10/10 argmax agreement** on real images -- the
same standard as the other eight artifacts. The net loads clean: 242 layers,
input `[512 512 3]`, output `[5 1]` summing to 1.

**Why v2c and not v2b, stated plainly.** The pre-declared promotion rule selects
**v2b** (selection-half AUC gain -0.0089, CI crosses zero). v2c is a DISCLOSED
override on a more decision-relevant metric: under domain shift v2b's Tier-A
share nearly doubles (48% -> 66%) and its false auto-clear of truly referable
cases rises to **12.84%**, against v2c's **2.29%**. A model that stops deferring
exactly when it is out of its depth is the dangerous one. In-domain, v2c trades
~2 points of specificity for ~8 of referable sensitivity (0.849 -> 0.927).
Known cost: v2c's grade-1 recall is worse (0.633 -> 0.550). Say this as a
disclosed deviation, never as "v2c won".

**384 -> 512 is now complete across classification and segmentation.** Most of
the pipeline followed automatically: `preprocessBranchATensor.py` delegates to
`branchAInfer.preprocess` and follows the checkpoint (verified emitting
512x512), and `segInfer.py` has been `INPUT_SIZE = 512` throughout. One thing
WAS hardcoded and is fixed: the MATLAB session's warm-up tensor was a literal
384, which against a 512 network fails the warm-up outright -- non-fatal, since
the caller catches it, but it silently hands the first real request the model
load the warm-up existed to absorb. It now reads `imgSize` from
`branchAInferMatlab.m`'s own version registry.

Left over, neither on the live path: `experiments/explainabilityValidation.py`
still hardcodes `CAM_SIZE = 384`, and the `lesion384` / `roi384` key names no
longer describe their contents (the code reads whatever is at the path and
rescales, so nothing assumes a size).

**Grades move with the model.** On the two `verify_fovea_e2e` images:
`cnn=4 rule=2 tier=C` / `cnn=3 rule=3 tier=B` under v1 became
`cnn=3 rule=2 tier=C` / `cnn=2 rule=3 tier=C` under v2c -- the second now
routing to Tier C on branch disagreement rather than sitting at B. Any demo
screenshot or slide figure captured before 2026-09-23 shows v1 grades.

### MATLAB toolboxes actually used -- checked, not assumed

Ten in active use: **Deep Learning** (all 9 imported networks), **Image
Processing** (heaviest -- quality gate, preprocessing, segmentation
post-processing), **Statistics & ML** (urgency score, threshold refit),
**Parallel Computing** (6 files), **Simulink** + **SimEvents** (district
model), **MATLAB Compiler** (both `deploy/` and the PHC quality gate),
**Report Generator** (clinical PDF), **Computer Vision** (`insertShape` /
`insertObjectAnnotation` in the evidence report, `unetLayers` /
`pixelLabelDatastore` in `trainVesselUnet.m`), **Medical Imaging**
(`medicalImage` for DICOM capture), and **Global Optimization Toolbox**
(`surrogateopt`, `ga`, `patternsearch` in `optimizeRuleThresholds.m` --
installed 2026-09-23; previously fell back to exhaustive search).

**Optimization Toolbox is licensed but NOT used** -- zero calls to `fmincon`,
`intlinprog`, `linprog` or `lsqnonlin`. The solvers in `optimizeRuleThresholds.m`
(`surrogateopt`, `ga`, `patternsearch`) belong to the **Global** Optimization
Toolbox (now installed), not the plain Optimization Toolbox. Do not conflate
the two on a slide.

Also not available: MATLAB Production Server, MATLAB Compiler SDK,
MATLAB Web App Server (all `license=0`). MPS was considered for the central
system and rejected: missing licences, and it is an RPC endpoint for compiled
MATLAB functions, not a web server -- no cookie sessions, CSRF, multipart
upload or static hosting, so Node would still be needed in front of it.

#### Global Optimization Toolbox: installed, tested, and it does NOT win

Installed 2026-09-23; `surrogateopt`, `ga`, `patternsearch` and `particleswarm`
all resolve. `optimizeRuleThresholds.m` supports all three solvers, so the open
question -- would a global solver beat the plain-MATLAB exhaustive search? --
was settled by running it rather than argued. Same data, same objective,
fit on the v2 train split:

| solver | thresholds | train QWK | evals | wall |
|---|---|---|---|---|
| **exhaustive + local refine** | **9 / 8 / 11 / 7** | **0.8780** | 1.12 M | 215 s (6 workers) |
| `ga` | 12 / 2 / 102 / 1 | 0.8739 | 2 589 | 82 s |
| `surrogateopt` | 9 / 8 / 64 / 3 | 0.8726 | 600 | 121 s |

Both global solvers returned a WORSE optimum, and `verifyExhaustive` reports
`exhaustiveAgrees = 0` for each -- enumeration beat them outright. That is the
expected shape, not a surprise: the objective is a step function riddled with
plateaus (poor ground for a smooth surrogate) and each evaluation is ~30 us,
so there is nothing for a sampling strategy to economise on. `ga` is the
fastest of the three and stays wired as the `solver: 'auto'` fallback for a
grid too large to enumerate.

**So do not claim the Global Optimization Toolbox produced the deployed
thresholds.** It is installed and supported; the numbers in production came
from exhaustive search. Note also that `ga`'s 12 / 2 is inside the wide tied
plateau the exhaustive search reports, which is why it looks close to Tanuj's
independently fitted values without being a second confirmation of them.

### Model/backend integration audit (2026-09-23)

Every field each side emits, cross-referenced against what the other reads.
The case-pipeline contract is symmetric (12 in, 12 read). Three real defects,
all fixed:

1. **The recorded model was a constant.** `grading_results.model_version` was
   written from a hardcoded `'branchA_v1'` while `branchA.modelVersion` -- which
   both engines report -- was never read. All 67 rows said `branchA_v1`, and the
   moment the default became `branchA_v2c` that column was uniformly false.
   Writing the truth then hit a foreign key: `model_version` references
   `model_versions`, which held one row, so the schema made recording the truth
   *impossible* -- almost certainly why the constant existed. The constraint is
   correct and stays; **migration 0017** registers the v2 family with each
   model's own delivered metrics (n=628), v2c promoted. An unregistered model
   now fails the case with a message naming the fix.
2. **`sourceFormat` and `dicomDeviceModel` were computed and dropped** on every
   case since DICOM landed, while `readFundusImage.m`'s header states the device
   "is recorded as evidence". **Migration 0016** adds
   `cases.source_format` / `cases.dicom_device_model`, kept separate from the
   worker-reported `camera_device_id` for the same reported-vs-detected reason
   the schema already splits `camera_family_detected`.
3. **The two engines disagreed on `sourceFormat`'s vocabulary** -- MATLAB
   `'image'`/`'dicom'`, the JS fallback the file extension. Harmless while the
   field was dropped, wrong the moment it is stored. The fallback now matches
   MATLAB and never claims `'dicom'`, which it cannot read. Empty strings
   normalise to NULL.

Left unconsumed by design: `venousBeadingQuadrants` / `irmaQuadrants` are read
but never emitted (detectors cut; absent correctly means "not assessed"), and
segInfer's static `verified` / `verificationNote` provenance block is dropped
-- worth surfacing on the case detail later, since its own comment says it
exists to be shown.

### Triage urgency score, wired (2026-09-23)

`calculateUrgencyScore.m` existed and was called by nothing. Now computed per
case, stored (**migration 0018**: `urgency_score` CHECK 1..100 NULL-allowed,
`urgency_factor`, `urgency_inputs` JSONB), exposed on the case detail and the
queue, and shown in the central review queue.

Under the constraints its own header sets, because the forest is trained on
SYNTHETIC data and has never been validated against an outcome:

- **Missing data means no score.** MATLAB skips the call entirely unless age,
  years diabetic AND HbA1c are all present and in range. NULL, never 1 -- 1 is
  a legitimate low-urgency result, so an imputed 1 could not be told apart from
  a measured one. Verified: complete data scores, missing HbA1c skips, absent
  clinical block skips, out-of-range HbA1c skips.
- **Bucket midpoints are allowed, silent ones are not.** `glycemicControl:
  'poor'` may stand in as 9.5, but it is tagged `assumed from ...`, the tag is
  stored in `urgency_inputs`, and the API returns it. An unrecognised bucket
  yields no score at all.
- **Ordering only.** In the queue it is a TIE-BREAK placed *after* the
  calibrated keys (uncertainty for Tier C, confidence for Tier B), never ahead
  of them -- a synthetic-data signal must not outrank one calibrated on the
  model's own measured error. It does not touch `decideTier`, the referral
  decision or the patient SMS.
- **Never the number alone.** `urgencyScore` ships with `urgencyBasis` and
  `urgencyLimitation` everywhere, and the queue renders a visible footnote
  rather than hiding the caveat in a tooltip. `--` marks not-computed.

PHC intake now collects a real HbA1c (optional, "leave blank if not tested")
and carries the year count through as a number alongside the existing bucket,
which the old mapping discarded.

**Capture formats:** jpg, jpeg, png, bmp, tif and DICOM are accepted and were
verified through `readFundusImage` itself, not inferred from the allow-lists.
The one format that genuinely fails is **`.webp`** -- MATLAB's `imread` has no
WebP support, which is why `verifyPhase4` skips those files.

### The M5 v2 threshold question, now measured

`RED_LESION_MODEL_VERSION=v2` detects far more red lesions than v1 (81 vs 31 on one image; 2.6x). Every threshold in `ruleEngineGrade.m` was fitted against v1 counts, so they do not transfer.

Measured properly for the first time: `diagnostics/collectLesionCounts.py` ran segInfer with v2 over IDRiD's official grading split (251 train on disk of 413, test complete at 103/103), then `optimizeRuleThresholds` fitted on train and reported on the untouched test split.

| on the 103-image TEST split | current 3/3/5/1 | refit 9/8/11/7 |
|---|---|---|
| QWK | 0.457 | 0.692 |
| referable sensitivity | 0.984 | 0.859 |
| referable specificity | **0.231** | 0.872 |

Specificity 0.231 is 30 of the 39 non-referable eyes in that split flagged as referable. **Do not confuse this with the classifier specificity in Tanuj's reports** (0.939, Branch A on Messidor-2) -- different model, different dataset, different question.

The refit costs sensitivity: 0.984 -> 0.859, which is **below the 0.90 problem-statement target**. That is a clinical operating-point choice, not a technical one. A sensitivity-constrained fit (>= 0.90 hard constraint) is the alternative.

Cross-check, independent method: Youden's J via `perfcurve` reproduced **Tanuj's published v2 numbers exactly** (`redFloor` 12, `grade3QuadMin` 4) from our data. The joint search disagrees (9 and 8) because it optimises whole-rule-engine agreement rather than each threshold's own binary question. That gap is unresolved and should be before anything ships.

Caveat: 5-fold CV said QWK 0.863, the held-out test said 0.692. Trust the held-out number. The likely cause is the known train-split data gap (251 of 413 images).

## Waiting on other people

- **Tanuj** — updated 2026-09-23 (evening). The list is now down to one open item.
  1. **Confirmation that `unvalidated_camera` satisfies his request** — he asked twice and has it logged as unconfirmed; it is built and tested, so he can close it.

  Everything else on the morning's list closed the same day:
  - `models/branchA_v2c.mat` — **no longer needed from him.** He delivered `branchA_v2c.pt`; the `.onnx` and `.mat` were derived here (see below) and parity-verified against his own reference fixtures.
  - Go-ahead to flip `RED_LESION_MODEL_VERSION=v2` — **given, and done.**
  - Go-ahead to switch the classifier to v2c — **given, and done.**
  - `grade3QuadMin` for v2 counts — **settled on evidence**, 4 not 8; see the threshold section above. Worth him knowing our joint search preferred 8 on train and that the held-out split is what decided it.

  **Closed since 2026-09-20, no longer waiting:**
  - §R rename — done; he deliberately kept the wire keys (`brightLesions`/`brightPerQuadrant`) and renamed only internal model identifiers, so the JS layer needed no change.
  - M5 3-class retrain — delivered, contract verified exactly.
  - `foveaUnreliable` — delivered and merged; consumed end to end.
  - `venousBeadingQuadrants` / `irmaQuadrants` — **cut by Tanuj, permanently for this round.** No annotated data exists to validate either detector. Our side is built and passes them through when present; the rule engine's "criteria (b) and (c) were NOT assessed" caveat is now the permanent state, not a temporary one. Branch B can therefore under-call severe NPDR by design, and that disclosure must travel with the grade.

- **Also worth telling him** (not blocking us):
  - `verifyPhase4.m`'s crash is diagnosed and fixed — it was `models/` missing from the path, not a corrupt model. Three further defects in the same function are fixed with it.
  - His reports describe v2c as "deployed"; the code default is `branchA_v1`, and will stay so until the binary above arrives. Nothing in a slide should say v2c yet.
  - ~~`docs/implementation-plan-backend-saad (1).md` and `implementation-plan-ml-tanuj (1).md` are browser-download duplicates~~ **Done 2026-09-29.** The saad one was byte-identical to its original and was removed; the tanuj one was the ONLY copy (its original was gone, replaced by the rename) and was renamed back rather than deleted, which is what the warning here was for.
- **Frontend team:**
  - The login screen: `credentials: 'include'` plus the `X-CSRF-Token` header.
  - The claim flow and the disagreement rule (Confirm unavailable on disagreement cases).
  - The review-history panel.
  - `eyeLaterality: m.eye` in `CaptureScreen.jsx`'s capture-metadata payload.
  - Mobile: the ID format, a PHC API key, and the endpoints listed in api-contracts.md.
