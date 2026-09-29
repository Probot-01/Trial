# API & Data Contracts — Single Source of Truth

**Read this before writing any code that sends or receives data.** Both plans reference this file instead of re-describing shapes — if a task in either plan and this file ever disagree, this file wins and the task should be corrected.

**Global naming rule:** SQL columns are `snake_case` (matches the schema.sql files). Every JSON payload over HTTP — every request body, every response body — is `camelCase`. The translation between the two happens in the route handler, never in the database layer and never in a frontend component. If you're generating a route handler, it reads snake_case from the DB and returns camelCase JSON; if you're generating a DB insert, it takes camelCase from the parsed request and writes snake_case columns.

**Global ID rule:** all IDs are strings, never numbers, even where the DB uses an integer or UUID underneath. Locally-generated IDs (patients, captures) use the format `{PHC_CODE}-{base36 timestamp}-{8 random alphanumeric chars}`, e.g. `"PHC001-mtuss3yg-a2x9k7qp"` (since 2026-09-24; IDs minted earlier keep their 4-character suffix and stay valid; the full rule is `docs/id-format-spec.md`). Centrally-generated IDs (cases, reviews, referrals) are standard UUIDv4 strings.

**Global date rule:** every timestamp field is an ISO 8601 string in UTC, e.g. `"2026-09-06T14:32:00.000Z"`. Never epoch numbers, never locale-formatted strings.

**Global enum rule:** every enum-like field (status, reason codes, categories) uses the exact lowercase snake_case string values listed below — nothing else, no synonyms, no title case. These strings are compared with `===` in the code that consumes them, so a mismatch (e.g. `"Blur"` instead of `"blur"`) silently breaks the UI mapping.

**Global patient-reference rule:** `patientReference` is `PT-` followed by **six** characters drawn from `ABCDEFGHJKLMNPQRTUVWXYZ2346789` — uppercase, with `0 O 1 I 5 S` deliberately excluded, e.g. `"PT-K3M9XQ"`. It is randomly assigned, never derived from `patientId`, and never reversible back to it. Earlier drafts of this file showed `"PT-4821"`; that four-digit form is **withdrawn**. Four digits is 9,000 values for a system specified at 100,000+ patients per year — the space is exhausted within weeks, and by the birthday bound collisions begin at roughly a hundred patients. The excluded glyphs are the ones that get misread when a reference is spoken between an ophthalmologist and a PHC, which is how a note lands on the wrong patient's record.

---

## Changelog

Kept because this file is the tie-breaker: when it changes, the code and both
plans have to be re-checked against it, and a silent edit makes that impossible.

**2026-09-28 — `GET /api/v1/cases/:caseId` gains `lesionAttentionChanceLevel`, `lesionAttentionEnrichment`, `lesionAttentionFlagged`.** Additive (migration 0022). The Grad-CAM/lesion consistency score was being served alone, and **alone it is not interpretable**.
- `lesionAttentionConsistencyScore` is the fraction of Grad-CAM energy falling inside the segmented lesions. If lesions cover 70% of the retina, a heatmap of pure noise also scores 0.70. `lesionAttentionConsistency.m`'s own header says a UI showing that fraction beside a green tick "would be actively misleading" — and Case Detail was rendering it on a 0–1 bar coloured red below an invented 0.6 threshold.
- **`lesionAttentionChanceLevel`** is the lesion area fraction: what a random heatmap would score *on this eye*. **`lesionAttentionEnrichment`** is score / chance, where 1.0 is chance and above 1 is real attention. **`lesionAttentionFlagged`** is `enrichment > 1.0` evaluated in MATLAB, next to the maths, so no surface re-derives the comparison.
- `flagged` is meaningful even when the score is `null`: a heatmap with no energy inside the retina is undefined-*but-flagged*, because Grad-CAM producing nothing is itself a reason to review. A `null` score with `flagged: null` means not computed.
- **A surface that shows the score must show the chance level with it.** A low result is a reason to review, never to change a grade — the lesion masks are model output with their own error rate.
- **Root cause of the score being `null` everywhere:** `branchAInferMatlab.m` returned the Grad-CAM PNG but not the raw map, while `branchAInfer.py` returned both. `runCasePipeline.m` skips the calculation without a map, so moving the classifier to the MATLAB backend silently switched Task 7.1 off. `gradCam.m` now returns the raw map as an optional second output.

**2026-09-27 (regrade) — A case that succeeds after failing no longer reports the old failure.** Bug fix, not a contract change: this document already said `failureCode` is "null on every case that has not failed".
- The orchestrator's success path set `status = 'graded'` and left `failure_code`, `failure_reason` and `failed_at` untouched, so a case that failed and later succeeded was served as `status: "graded"` **with the old `failureCode` and `failedAt` still attached**. `getCaseDetail` serves those columns straight, with no status check.
- It affected every route to success-after-failure: the queue's retry, the watchdog's recovery, and a manual re-grade — not just the bulk re-grade that exposed it.
- `GET /admin/system-health` was never wrong: `failedCases()` filters on `status = 'error'`. That is precisely why nothing caught it.
- Fixed in `gradingOrchestrator.js`: the success `UPDATE` now nulls all three. `verify_backend_health.js` asserts the invariant (no `graded` case carries a failure code, reason or timestamp).

**2026-09-27 (urgency inputs) — `GET /api/v1/ophthalmologist/queue` gains `urgencyAssumedInputs`.** Additive.
- The urgency model needs an HbA1c; the questionnaire records glycemic control as poor/moderate/good. So `'moderate'` becomes **7.5** — a bucket midpoint standing in for a number nobody measured. `calculateUrgencyScore.m` has recorded that faithfully in `urgency_inputs.provenance` all along, and the reviewer never saw it: a score of 79 built on two substituted values and a 55 built on three real ones rendered as identical bare numbers.
- **`urgencyAssumedInputs`** is the list of inputs that were substituted, from `patientAge` \| `yearsDiabetic` \| `hba1c`, in that reading order. `[]` = all three measured. **`null` = not known** (no score, or a row from before this was recorded) and is deliberately distinct from `[]`, which is a positive claim. Only the literal `"measured"` counts as measured; any other provenance string is treated as substituted, so a value the engine did not vouch for is never laundered into one it did.
- The queue selects `urgency_inputs -> 'provenance'` rather than the whole blob, which repeats a model card on every row.
- The queue UI marks such a score with a leading `~` **in the open, not only on hover**, for the same reason the urgency footnote is stated in the open: a 1–100 number in a clinical queue reads as evidence unless something on the row says otherwise.
- `urgencyInputs` (the full object, on case detail) and `urgencyBasis` remain served and unrendered. Urgency is deliberately **not** shown on Case Detail at all: it is a queue-ordering hint, and putting it on the clinical review screen would invite the clinical reading this document forbids.

**2026-09-27 (last) — Case Detail finally reads `status`, `failureCode`, `failedAt` and the eye-laterality pair.** No shape changed; four fields that were added for the reviewer's benefit and never rendered now are.
- **A failed case no longer reads like a graded one.** This document has said since 2026-09-20 that "a case with `status: \"error\"` must not be indistinguishable from a graded one", and on this screen it was: every ML field is `null` on a failed case *and* on one still grading, so both rendered as grade "—", confidence "NOT COMPUTED", no evidence. **68 of the 138 cases in the development database are `error`.** A new banner (`CaseStatusBanner`) states which it is, and says in as many words that the blanks are missing results, not findings — an empty grade beside an empty lesion count otherwise reads as "nothing found".
- The banner shows `failureCode` and `failedAt`, never the failure *message*, which stays admin-only via `/admin/system-health` because it can quote internal paths. An unrecognised `status` renders nothing rather than guessing.
- **`eyeLateralitySource` and `eyeLateralityMismatch` are shown.** The EYE tile printed the winning value alone, which hid both whose word it was on and that the file and the technician disagreed. A mismatch is now a DISPUTED badge; it already floors the tier, and filing a grade against the wrong eye is not a cosmetic error.
- Still served and still unread by any screen, recorded here rather than silently: `urgencyBasis` and `urgencyInputs` (the queue shows `urgencyScore`, `urgencyTopFactor` and `urgencyLimitation`, but not which inputs were measured and which were bucket midpoints).

**2026-09-27 (later still) — `GET /api/v1/cases/:caseId/report`: the PDF now carries its own provenance.** No request or response shape changed — the PDF's CONTENT changed, which this file records because the report is the artifact that leaves the system.
- **The "Why:" line under the review tier now appears.** `generateReport.m` has rendered it from `tierReason` since it was written, and the backend never sent the field, so every PDF named the tier and never the reason for it. Regenerated reports now carry it; cached ones are regenerated when the case is re-graded, or on `force`.
- **New section, "How this result was produced":** the classifier model build, and a table naming the engine behind each ML output with its `detail`. An output nobody recorded is omitted; a case with no provenance at all prints one line saying the record is missing, never a claim that some engine ran.
- **A non-primary engine is called out in red** on the report itself, not only in the API. Same rule as the reviewer console: a `fallback: true` must be visible.
- Both renderers were changed together — `generateReport.m` (MATLAB Report Generator) and `generateReportFigures.m` (core-MATLAB fallback). They are required to produce the same report; `verify_report_provenance.js` fails if they read different fields.

**2026-09-27 (later) — `GET /api/v1/cases/:caseId` gains `cameraMismatch` and `cameraExpectedFamily`.** The reported-vs-detected camera cross-check has run on every case since Task 6.3 and reached no reader. It sets a tier floor, and a floor only writes `tierReason` when the tier would otherwise be A *and* the camera/site is still on probation — so a mismatch on a case the conformal set had already put in Tier B or C, or on any established camera, was a server log line and nothing else. Measured on a real case: `cameraMismatch: true` with a `tierReason` that never mentions the camera. Now stored (migration 0021) and served.
- **`cameraMismatch` is three-state and the third state is the point.** `true` = the check ran and the two disagreed; `false` = the check ran and they agreed; **`null` = the check could not run**, because no device was reported or the reported device has no entry in the central device-association table. `classifyCameraFamily.m` returns `mismatch = false` in *both* the "agreed" and the "nothing to compare" case, and storing that as `false` would record that a camera was verified against its own image when nobody could look. Do not read `null` as agreement.
- **`cameraExpectedFamily`** is the family the reported device implies — the other half of the comparison, in the same vocabulary as `cameraFamilyDetected`. `null` exactly when `cameraMismatch` is `null`. Without it, "mismatch" is an assertion the reader cannot inspect.
- Both are `null` on any case graded before this date; that is "not recorded", as everywhere else.
- **`cameraDeviceId` is not "one of the keys in `cameraPresets.json`"**, as this document said in two places. That file is the PHC quality gate's optics presets (`default`, `mobile_lens`) and has never held device ids. The accepted values are the ids in the PHC's own `captureOptions.js` `CAMERA_DEVICES`; whether a given one can be *cross-checked* depends on the central `calibrationProfiles.json` `deviceAssociations`. `generic_fundus` is deliberately not checkable (it names no single camera family) and is now listed with a `null` association so that stays a recorded decision rather than an omission.

**2026-09-27 — Capture provenance documented; Case Detail now shows the whole of `engineProvenance`.** No shape changed; this closes a documentation gap and a UI gap.
- **`GET /api/v1/cases/:caseId` carries `sourceFormat`, `dicomDeviceModel`, `cameraFamilyDetected`**, which have been served since migration 0016/Task 6.3 but were never written down here. They say what the image FILE reports about itself, deliberately kept apart from the technician's `captureMetadata.cameraDeviceReported`. `sourceFormat` is `"dicom" | "image"` — what the upload actually was, not its filename extension. `dicomDeviceModel` is manufacturer + model from the file's own tags, and is `null` on a plain image, which carries none. `cameraFamilyDetected` is one of `"desktop_tabletop" | "portable_handheld" | "smartphone_adapter" | "unknown"` (`classifyCameraFamily.m`; `"unknown"` means nothing scored well enough) and may also be `"disabled"` when camera calibration was switched off for that run. All three are `null` on a case that has not been graded. They are **not** a device identifier and must not be string-compared with `cameraDeviceReported`: a family is a coarser fact than a device. Where a reported-vs-detected disagreement matters, the backend already states it in `tierReason`.
- **The full `engineProvenance` is now on Case Detail** (`ProvenancePanel`), replacing the lone quality-gate tile that stood in for all seven entries. `fallback: true` is called out at the top of the panel as well as on its row, per this document's "a UI should make a `true` visible". `detail` is printed verbatim and never parsed — which is what lets `engine: "matlab"` keep covering both `matlab -batch` and the compiled MATLAB executable, with only `detail` saying which. **Do not add a `"matlab-compiled"` engine value when the pipeline moves to the MATLAB Compiler**; the enum is fixed here, and the UI already reports the change through `detail`.
- **`modelVersion` is shown** on Case Detail for the first time. It was in this document and in the response, and no screen rendered it, so a reviewer could not tell which classifier build graded the case in front of them.
- Known gap, not fixed here: `cameraMismatch` is computed per case and logged, but it only reaches a reader through `tierReason`, and `tierReason` records it only while that camera/site is still on probation. Once probation clears, a reported-vs-detected disagreement is a server log line and nothing else. Surfacing it needs a stored field; it is not inferable in the client.

**2026-09-27 (demo prep) — One definition of a silent PHC.** `GET /admin/system-health` counted a site silent after 48 h without any contact (`SILENT_PHC_HOURS`); `GET /admin/phcs` after 24 h without a *case* (`PHC_SILENT_HOURS`). The two screens could disagree on the same site. Both now use one rule, in `services/phcSilence.js`: no contact of any kind within `PHC_SILENT_HOURS` (default 24), or never. Changes: `thresholds.silentPhcHours` default 48 -> 24; `/admin/phcs` `status` is derived from contact, not from the last case; `/admin/phcs` items gain `lastContactAt`; env `SILENT_PHC_HOURS` is removed and ignored.

Also: the `pendingCount` a PHC sends with a case now excludes the capture being uploaded (it is what remains queued behind it). It used to include it, so the last upload of a session left `phc_sites.pending_count = 1` and PHC Health showed a phantom backlog. Also: the UI shows every date and time in IST (Asia/Kolkata); Case detail shows `patientReference` as the case identifier and reads "NOT COMPUTED" for `uncertaintyScore`/consistency when null; the Resources page says "Simulation results not yet generated" until the Simulink output exists.

**2026-09-27 (later) — `GET /api/v1/admin/phcs`.** Lists every PHC site with its recent activity (district_admin). It gives the PHC Health page a real data source; that table used to say "no live data source yet". Adds nullable `phc_sites.phc_code` and `phc_sites.district` (migration 0020); both are reported as `null` until someone records them. New optional env `PHC_SILENT_HOURS` (default 24).

**2026-09-27 — Final capture flow order (desktop and mobile), decided by Tanuj.** Registration + patient questionnaire (every question answered, no skip, consent confirmed) → capture → local quality gate → capture-metadata questionnaire → local queue → sync. This is a note on `system-design-v4.md` §8.1, which lists the patient questionnaire after the gate: both front-ends collect it at registration and store it per patient, then attach it to each capture. No endpoint or field changed.

**2026-09-27 — Expo mobile app sends `qualityGateEngine: "js-device"`; peer sync carries it.** No endpoint or shape changed. The mobile app now sends the optional `qualityGateEngine` (`{ "engine": "js-device", "fallback": false, "detail": "…" }`) on `/cases`, `/cases/summary` and the chunk init, so a mobile case's `engineProvenance.qualityGate` is `js-device`, not `null`. The desktop↔phone peer wire `capture` record gains an optional `qualityEngine` (the same entry), applied by both sides, so a case uploaded by the other device keeps the engine that really gated it. A capture with no recorded engine stays `null` ("not recorded"). Mobile also now treats only `201`, or `200` + `duplicate: true` with a `caseId`, as acceptance (any other 2xx is a failure, never "synced").

**2026-09-27 — Reviewer and admin flows, verified against real cases.**
- **Lesion evidence is two families, red and bright.** `lesionCounts.microaneurysms` and `hemorrhages` are the breakdown of the red family, and are real numbers under M5 v2 (`null` under v1). `hardExudates` is the bright family. **`softExudates` is deprecated:** it stays in the response for wire compatibility, is always `null`, and no UI renders it, because nothing detects cotton-wool spots. It will be removed once the mobile app stops reading it.
- **`lesionCounts.detail.redTotal` is now the sum of `redPerQuadrant`.** It used to be the older whole-mask count, which under M5 v2 differed from the quadrant counts the rule engine and the evidence text use (for example 15 against 18).
- **`GET /admin/dashboard` gains** `casesThisWeek` (last 7 days), `totalCasesProcessed` (graded), `overrideRate` (0–1, or `null` with no reviews), `avgConfidenceScore` (0–1, or `null`), `drGradeDistribution` (`[{ grade, label, count, percentage }]` for the classifier's grade, or `null` with nothing graded) and `weeklyTrend` (`[{ week, cases, referrals }]`, last six weeks). Additive. Not provided, because central cannot know them: images rejected by the PHC quality gate, and model accuracy.
- **`GET /admin/referrals` items and the `PATCH /referrals/:id` response gain** `phcName` and `drGrade` (the reviewer's corrected grade when there is one, else the classifier's). Additive.
- **`manual_follow_up` is also set when no SMS provider is configured** (`smsStatus: "not_configured"`). The patient was not told, so someone has to phone them. It was left in `referred` before. `dry_run` is unchanged.
- **`GET /cases/:caseId/report` 502** now carries a short message. The MATLAB error is in the server log only. Without the MATLAB Report Generator product on the server, the report is rendered by the core-MATLAB fallback instead of failing.

**2026-09-26 (later) — Quality-gate engine value `js-device`.** `qualityGateEngine` and `engineProvenance.qualityGate` may now also be `"js-device"`. It means the mobile app's on-device TypeScript port of `qualityGateMain.m`, which is that client's primary gate, so `fallback` is `false`. It is valid only for the quality gate. Classifier, segmentation and rule-engine entries stay `"matlab" | "python" | "js-fallback"`. The backend accepts it now; the mobile app starts sending it separately.

**2026-09-26 — Engine provenance, component health, no silent segmentation fallback.**
- **`GET /api/v1/cases/:caseId` gains `engineProvenance`**: which engine (`matlab` | `python` | `js-fallback`) produced the classifier grade, each segmentation model, the rule engine and the PHC quality gate. The shape and its null rules are under the case-detail section below. Additive. *(Shown on Case Detail since 2026-09-27.)*
- **`POST /api/v1/cases`, `/cases/summary` and the chunk upload accept an optional `qualityGateEngine`**: a JSON-stringified engine entry for the PHC's quality gate. A malformed value returns `400 invalid_field`. If it is absent, it is stored as "not recorded". The PHC desktop backend sends it from this date. The Expo mobile app does not send it yet.
- **`GET /health` gains `components`**: `db`, `queue`, `matlabSession` and `python`, reported separately. The top-level `status` is still `"ok"` whenever the server answers, because PHC sync and the mobile app treat `/health` as a reachability heartbeat. Monitors should read `components`.
- **New `failureCode` value `matlab_segmentation_failed`**: segmentation's MATLAB engine failed and `SEG_ALLOW_PYTHON_FALLBACK` is not set. The case is retried, then marked `error`. It is no longer silently re-run on PyTorch, and no longer silently graded on the classifier alone.

**2026-09-26 — PHC capture → sync → result flow (Local API).** Found by running the whole flow against real services; each change is additive unless marked.

- **Fixed (behaviour): a capture is uploaded only after both questionnaires are recorded.** It used to be queued at the quality gate and uploaded within one sync cycle, so central graded cases with `questionnaireData` and `captureMetadata` NULL. `pendingCount` now counts only rows ready to upload; new `awaitingFormsCount` counts the rest.
- **Fixed (behaviour): "synced" now means central accepted the case** (201, or 200 + `duplicate: true`, with a `caseId`). Any other 2xx used to mark the capture synced.
- **`GET /sync/status` gains `awaitingFormsCount` and `lastError`**; a refusal is recorded and retried with backoff instead of retried silently and forever.
- **`GET /captures`: `result_pending` and `result_delivered` are now reachable**, driven by polling central's status endpoint. New per-row fields: `qualityStatus`, `qualityReason`, `formsComplete`, `centralStatus`, `syncError`, `uploadProgress`.
- **`POST /captures` response gains `qualityGateEngine`** (which engine ran the gate). The `503 quality_gate_failed` body gains `captureId`.
- **New `POST /captures/:captureId/quality-check`**: re-run the gate on a saved, unchecked capture (what the 503 text always promised).
- **The disabled JS quality-gate tier no longer invents a verdict.** It answered `retake` / `MATLAB_UNAVAILABLE` for every image; it now throws, which is reported as `503 quality_gate_failed`.
- **Global ID rule corrected to the 8-character suffix** (`docs/id-format-spec.md`, 2026-09-24); the contract text still said 4.

**2026-09-24 — PHC-readable report.** Added `GET /api/v1/phc/cases/:captureRef/report` and `GET /api/v1/phc/cases/:captureRef/gradcam` (PHC key). Until now nothing a PHC is allowed to call returned a grade, so a PHC front-end had no honest way to show a result. First consumer: the Expo mobile app.

**2026-09-20 — Full backend audit: behaviour fixes.** Each of these changes what a client sees.

- **The review queue no longer lists cases that have already been reviewed.** It used to keep them forever, so the queue grew without bound and finished work was indistinguishable from outstanding work. The history is still at `GET /cases/:caseId/reviews`.
- **Queue rows gain `eyeLaterality`, `claimedBy` and `claimedAt`** (design doc §5.2): show the eye, and whether another reviewer currently holds the case.
- **`GET /cases/:caseId` gains `claim`** (`null`, or `{ claimedBy: { userId, name }, claimedAt, expiresAt }`), so Case Detail can disable the decision controls when someone else holds the case (§10.8).
- **`POST /cases/:caseId/review` returns `409 case_not_graded`** when the case has no grading result. It used to record a review, and could raise a referral and an SMS, for a case that had never been graded.
- **An undeliverable SMS now moves the referral to `manual_follow_up`** (design doc §10.5), which is a new value in the referral status enum: `referred | manual_follow_up | contacted | attended | lost`. It is set when there is no contact number, when sending fails, and when Twilio later reports `undelivered`/`failed`. It never overwrites a status a worker has already moved on.
- **New `POST /api/v1/notifications/sms-status`**: Twilio's delivery callback, authenticated by Twilio's request signature. Not for frontend use.
- **Deactivating a user** (`users.is_active = false`) now revokes access within a minute, instead of the session staying valid for up to 12 hours. A role change also takes effect on the next request. A deactivated account cannot log in, and gets the same response as a wrong password.
- **Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.**
- **A 500 no longer echoes the internal error message** when `NODE_ENV=production`; the detail goes to the server log.
- **`patientAge` that is not an integer 0–130 returns `400 invalid_field`** instead of a 500.
- **Chunked upload:** `POST /cases/:captureRef/chunks/init` answers `{ alreadyIngested: true, caseId, status }` when that capture already has a complete case, instead of accepting an upload it would then discard.

**2026-09-20 — Backend plan §G, §I, §O, §P (resource model, fovea, PDF report, eye laterality).**
- **New `GET /api/v1/admin/resource-recommendations`** (404 until the first run) and **`POST …/refresh`**. This is the district resource model's output, replacing the hardcoded panel copy.
- **New `GET /api/v1/cases/:caseId/report`**. It returns `{ reportUrl, generatedAt, cached }`, and the PDF itself is fetched from `/media`.
- **`GET /api/v1/cases/:caseId` gains four fields:** `eyeLaterality`, `eyeLateralitySource`, `eyeLateralityMismatch` and `foveaUnreliable`.
- **Local `POST /captures/:captureId/capture-metadata` accepts `eyeLaterality`** (`"left" | "right"`). The desktop capture screen already asks the technician, but its payload mapper does not send the answer yet: `toRealCaptureMetadataPayload` in `CaptureScreen.jsx` needs `eyeLaterality: m.eye`. That is a frontend change.

**2026-09-20 — Backend plan §D–§F (system health).**
- New `GET /api/v1/admin/system-health` (district_admin), below.
- `GET /api/v1/phc/:phcId/sync-status` gains `lastContactAt`: any contact at all, summary packets included. A PHC health badge should key off `lastContactAt`, not `lastSyncAt`; the threshold comes from `thresholds.silentPhcHours` in system-health.

**2026-09-20 — Backend plan §C (idempotent ingestion + summary packets).**

- **One PHC capture is one central case.** `captureIdRef` is now an idempotency key, backed by a unique constraint. Re-sending a capture central already has returns **`200`** with the existing `caseId` and `"duplicate": true`. Nothing is stored and nothing is re-graded. Treat it as success: mark the capture synced.
- **New `POST /api/v1/cases/summary`.** It carries the same fields as `POST /api/v1/cases` but no image, and is sent ahead of the image on a thin link. It creates the case in the new status **`"awaiting_image"`**. The later full upload with the same `captureIdRef`, by single POST or chunks, fills in that same case and starts grading.
- **Status enum:** `GET /api/v1/cases/:caseId/status` can now return `"awaiting_image"`, as well as `"processing" | "graded" | "error"`.
- **`POST /api/v1/cases` responses gain `status`, `duplicate` and `fromSummary`.** These are additive; `caseId` and `receivedAt` are unchanged.

**2026-09-20 — Backend plan §A, §B.1–B.3, §M (auth, claiming, review history, patient search, consent).**

- **Login exists.** `POST /api/v1/auth/login`, `GET /api/v1/auth/me` and `POST /api/v1/auth/logout` are specified under "Authentication" below. The session is an **httpOnly cookie**, not a token the frontend handles. Every browser `fetch` must send `credentials: 'include'`, and every POST, PATCH or DELETE must send the `X-CSRF-Token` header. `<img>` tags need nothing extra.
- **Enforcement is behind flags, both OFF by default.** `AUTH_ENABLED` covers browser users and `PHC_AUTH_ENABLED` covers PHC device keys. While a flag is off, nothing is rejected for missing credentials, so today's frontends and sync keep working unchanged. Build against the "flag ON" behaviour: that is what ships.
- **Every route now has an allowed role.** The table is under "Authentication". Once `AUTH_ENABLED=true`, a wrong role gets `403 forbidden` and no session gets `401 unauthenticated`.
- **PHC apps authenticate with a per-site API key** in the `X-PHC-Api-Key` header, on `POST /api/v1/cases` and every `/chunks` route. `GET /api/v1/cases/:caseId/status` accepts either a PHC key or a logged-in user.
- **`POST /api/v1/cases/:caseId/review` changes in three ways:**
  1. The reviewer is taken from the session. `ophthalmologistId` in the body is ignored when someone is logged in.
  2. `correctedGrade` is now **stored** and returned by review history.
  3. **§10.9 is enforced server-side, regardless of flags.** On a case where `branchAgreement === false`, a `"confirm"`, or an override without `correctedGrade`, returns `400 explicit_grade_required`. A review on a case another reviewer holds returns `409 case_claimed`.
- **New endpoints:**
  - `POST /api/v1/cases/:caseId/claim`
  - `GET /api/v1/cases/:caseId/reviews` (closes the gap previously recorded under the review endpoint)
  - `GET /api/v1/patients/search` (central, PHC key)
  - `GET /patients/search` (local, same shape)
- **Consent (§9.7):** local `POST /patients` and central `POST /api/v1/cases` accept an optional `consentGivenAt` (ISO 8601). The sync manager forwards the local value to central.

**2026-09-09 — Task 7.3.** `evidenceSummaryText` is no longer `null`: it is always a non-empty string now that the report generator exists. Until lesion segmentation ships it states that segmentation has not been run rather than reporting zero lesions. `lesionAttentionConsistencyScore` stays `null` — Task 7.1 is built and tested but needs a lesion mask to score against.

**2026-09-09 — Tasks 8.2 and 8.3.** One behaviour change and one new endpoint group.

- **Breaking for any client that assumed it:** `POST /api/v1/cases` no longer grades before responding. Grading is queued (Task 8.3), so the case is **always** `"processing"` when the `201` returns. A client that read the case immediately after posting and expected a grade now gets nulls. Poll `GET /api/v1/cases/:caseId/status` — which is what that endpoint was always for. The request itself went from tens of seconds to milliseconds.
- Added the chunked/resumable upload group under `POST|GET /api/v1/cases/:captureRef/chunks…` (Task 8.2), for large images on links that cannot finish a single-shot POST.
- No change to the `status` enum: `"processing"` already means "not ready, keep polling", and queued-vs-grading is not a distinction any client can act on.

**2026-09-08 — reconciled against the implemented backend.** Every change below
came from building against this document and finding it under-specified rather
than wrong. Nothing documented here was reinterpreted; the additions fill gaps
that made an endpoint unbuildable as written.

- `POST /api/v1/cases` gains optional `patientName`, `patientAge`, `patientContactNumber`, and `capturedAt`. **Without the first three, no case for a new patient can ever be stored** — see that endpoint's note.
- `patientReference` widened from four digits to six characters (above).
- Media URLs keep the uploaded file's real extension; `original.jpg` is an example, not a fixed name.
- Error bodies are `{ error, message }` on **every** failure path, including the ones this file previously showed with `error` alone.
- Documented the error responses for `POST /captures` and `POST /api/v1/cases`, which had none.
- Recorded which `GET /captures` lifecycle states are currently reachable.
- Noted that `GET /sync/status` reports `online: false` until the sync manager (Task 3.4) exists.
- Recorded `GET /patients` (local), which exists but was undocumented.
- Clarified `priorityRank` behaviour when Tier C exceeds 100 cases.

---

## Local API — `phc-local-app/backend`, base URL `http://localhost:4000`

### `POST /patients`
*(2026-09-20)* Also accepts an optional `consentGivenAt` (ISO 8601): the moment the technician ticked "verbal consent obtained" (design doc §9.7). It is echoed back as `consentGivenAt` (`null` if absent) and forwarded to central on sync. Errors: `400 invalid_field` for an unparseable timestamp.

Request:
```json
{ "name": "Sunita Devi", "age": 54, "contactNumber": "+919812345678" }
```
Response `201`:
```json
{ "patientId": "PHC001-lz3k9f-a2x9", "name": "Sunita Devi", "age": 54, "contactNumber": "+919812345678", "registeredAt": "2026-09-06T09:00:00.000Z" }
```
Response `400` if `contactNumber` missing: `{ "error": "contact_number_required", "message": "..." }`
Also `400 name_required`, `400 invalid_age` (must be an integer 0–130).

`contactNumber` is required because it is the only channel for delivering a result to a patient who has already gone home. A patient registered without one cannot be reached in the offline flow.

### `GET /patients/:patientId`
Response `200`: same shape as the POST response above.
Response `404`: `{ "error": "patient_not_found", "message": "..." }`

### `GET /patients`
Response `200`: array of the same object, most recently registered first, capped at 200.
Not part of the original contract; recorded 2026-09-08 because it is implemented and the Patient Lookup screen needs a list to search. The cap is deliberate — this table grows all season on modest PHC hardware.

### `GET /patients/search?name=&age=&phone=`  *(added 2026-09-20, design doc §10.3)*
Duplicate check at registration, against **this PHC's own** records, so it works offline. Same parameters, matching rules and item shape as central's `GET /api/v1/patients/search` (below), with two differences: it searches only local patients, and each item is the full `POST /patients` shape (the real `contactNumber`, since this is the site's own data) plus `matchedOn` and `score`.

At least one of `name` or `phone` is required; `age` only boosts. Errors: `400 invalid_field`.

### `POST /captures`
Request: `multipart/form-data` with fields `patientId` (string), `image` (file), `cameraDeviceId` (string — one of the ids in the PHC front-end's `captureOptions.js` `CAMERA_DEVICES`, or `"unknown"`; *corrected 2026-09-27: this said `cameraPresets.json`, which holds optics presets, not device ids*).
Response `201`:
```json
{
  "captureId": "PHC001-mtuss3yg-a2x9k7qp",
  "patientId": "PHC001-mtuss2ab-k4z8m1cd",
  "qualityStatus": "pass",
  "qualityReason": null,
  "retakeCount": 0,
  "capturedAt": "2026-09-06T09:05:00.000Z",
  "qualityGateEngine": { "engine": "matlab", "fallback": false, "detail": "qualityGateMain.m via matlab -batch" }
}
```
`qualityStatus` is exactly one of `"pass" | "retake" | "borderline"`.

*(2026-09-26)* **`qualityGateEngine`** says which engine produced this verdict: `{ "engine": "matlab" | "js-fallback", "fallback": boolean, "detail": string }`. It is never guessed: it is `null` only for a capture gated before the engine was recorded. The screen must show it. `"matlab"` covers both the compiled executable and `matlab -batch` (`detail` says which). `"js-fallback"` can only appear with `QUALITY_GATE_ALLOW_FALLBACK=1`, and the JS tier is currently switched off in code, so it does not answer today (see the 503 below).
`qualityReason` is `null` when `qualityStatus` is `"pass"`; otherwise exactly one of: `"blur" | "low_illumination" | "insufficient_fov" | "glare" | "motion_artifact" | "eyelash_occlusion"`. These six strings are fixed — the frontend's `QualityResultPanel.jsx` maps each one to its own human-readable message, so the quality gate must return one of these exact values, never free text.

`retakeCount` counts prior failed attempts **for this patient on the current UTC day**. It answers "which attempt is this, in this sitting" — a patient screened again months later starts at 0 rather than inheriting an old count.

Errors: `400 patient_id_required`, `400 image_required`, `400 invalid_image_type`, `404 patient_not_found`, `413 image_too_large` (25 MB), `503 quality_gate_failed`.

`503 quality_gate_failed` means the image **was saved** and the capture row exists, but the quality check could not run (typically MATLAB unavailable). The capture is recoverable and can be re-checked without recalling the patient — do not present it to the technician as a lost capture. The row stays in an internal `pending` state that is never returned as a `qualityStatus`. *(2026-09-26)* The error body also carries **`captureId`**, the id to re-check it with (below). No verdict is ever invented when the gate cannot run: the JS tier used to answer every image with `retake` / `MATLAB_UNAVAILABLE`, which is not one of the six reasons and told technicians to retake photographs that had never been checked.

### `POST /captures/:captureId/quality-check`  *(added 2026-09-26)*
Re-run the quality gate on a capture that was saved but not checked (the `503 quality_gate_failed` case), without taking the photograph again. No request body. Response `200`: the same body as `POST /captures`. A capture that already has a verdict is returned as it is, not re-gated. Errors: `404 capture_not_found`, `409 quality_gate_busy` (already being checked), `503 quality_gate_failed` (still unavailable; same `captureId`).

### `POST /captures/:captureId/questionnaire` (patient symptom + risk)
Request:
```json
{
  "riskFactors": {
    "yearsSinceDiagnosis": "lt1",
    "glycemicControl": "moderate",
    "bloodPressure": "high",
    "pregnant": false
  },
  "symptoms": {
    "blurredVision": true,
    "floaters": false,
    "suddenVisionChange": false,
    "eyePain": false
  },
  "language": "hi"
}
```
`yearsSinceDiagnosis` ∈ `"lt1" | "1to5" | "5to10" | "gt10"`. `glycemicControl` ∈ `"good" | "moderate" | "poor"`. `bloodPressure` ∈ `"normal" | "high" | "unknown"`. `pregnant` is `boolean | null` (null = not applicable/not asked).
Response `201`: `{ "responseId": "string", "captureId": "string" }`

### `POST /captures/:captureId/capture-metadata`
*(2026-09-20)* Also accepts optional `eyeLaterality`: `"left" | "right"` (design doc §10.4). It is stored with the capture and forwarded to central inside `captureMetadata`. Errors: `400 invalid_field` for any other value.

Request:
```json
{
  "cameraDeviceReported": "forus_3nethra_v2",
  "pupilStatus": "dilated",
  "lightingEnvironment": "indoor_clinic",
  "observedIssues": ["none_noticed"],
  "workerUsabilityRating": "clear"
}
```
`pupilStatus` ∈ `"dilated" | "non_dilated" | "unknown"`. `lightingEnvironment` ∈ `"indoor_clinic" | "outdoor_mobile" | "low_light"`. `observedIssues` is an array containing zero or more of: `"glare" | "blink_or_moved" | "out_of_focus" | "media_opacity" | "eyelash_obstruction" | "none_noticed"` (if `"none_noticed"` is present, it should be the only element). `workerUsabilityRating` ∈ `"clear" | "not_sure" | "clearly_unusable"`.
Response `201`: `{ "responseId": "string", "captureId": "string" }`

### `GET /sync/status`
Response `200`: `{ "online": true, "pendingCount": 3, "awaitingFormsCount": 1, "lastSyncAttempt": "2026-09-06T09:10:00.000Z", "lastError": null }` — `lastSyncAttempt` is `null` if no attempt has ever been made.

`online` reflects the last actual heartbeat to the central server, held in memory rather than persisted: "is the network up right now" is true of the running process at this moment, and a restarted server must not report a state it has never observed. **Until the sync manager (Task 3.4) exists, this is always `false` with `lastSyncAttempt: null`** — nothing has tried to reach the server yet, so that is the honest answer rather than a placeholder. The technician uses this indicator to decide whether the patient can wait for a result, so an optimistic `true` that nothing verified is worse than `false`.

`pendingCount` counts `sync_queue` rows **ready to upload and not yet accepted by central**. Only captures whose quality status is `pass` or `borderline` are queued: a `retake` is about to be reshot, and uploading it would spend scarce rural bandwidth on an image that is already being replaced.

*(2026-09-26)* **A capture is uploaded only once BOTH questionnaires are recorded** (`POST /captures/:captureId/questionnaire` and `.../capture-metadata`). Before this it was queued at the quality gate and the sync loop usually won the race against the technician: central stored and graded the case with no questionnaires, and the answers recorded a minute later were never sent. `awaitingFormsCount` counts the passed captures still waiting for a questionnaire; they are not in `pendingCount`. **`lastError`** is `null`, or `{ "captureId", "kind": "network" | "rejected" | "server", "message", "at" }`: the most recent reason a capture is still pending, in central's own words when it answered (`rejected` = central refused it with a 4xx; `server` = a 5xx, or a 2xx that was not an acceptance; `network` = no answer). A refusal is retried with a doubling delay (30 s up to 15 min) rather than resending the image every cycle; a dropped connection is retried at once.

**"Synced" means central ACCEPTED the case** (design doc §4.1, §4.4): `201` from `POST /api/v1/cases` (or from `chunks/complete`), or `200` with `"duplicate": true` (central already had the capture), and in both cases a `caseId`. Any other answer, however 2xx, leaves the capture pending.

### `GET /captures` (for the Local Queue table)
Response `200`: array of
```json
{
  "captureId": "PHC001-lz4a2b-c7f1",
  "patientId": "PHC001-lz3k9f-a2x9",
  "patientName": "Sunita Devi",
  "status": "quality_passed",
  "capturedAt": "2026-09-06T09:05:00.000Z",
  "qualityStatus": "borderline",
  "qualityReason": null,
  "formsComplete": true,
  "centralStatus": null,
  "syncError": null,
  "uploadProgress": null
}
```
`status` ∈ `"captured" | "quality_passed" | "synced" | "result_pending" | "result_delivered"`.

*(2026-09-26)* The fields after `capturedAt` are additive detail behind `status`. `qualityStatus` is the capture's quality verdict (`null` while the gate has not run), `qualityReason` its reason. `formsComplete` is whether both questionnaires are recorded. `centralStatus` is what central last reported about the case (`"awaiting_image" | "processing" | "graded" | "error"`) or `null`. `syncError` is `null` or `{ "kind", "message", "attempts", "nextAttemptAt" }` (same kinds as `/sync/status`). `uploadProgress` is `null` or `{ "sent", "total" }` for a chunked upload in flight or interrupted.

This is a **lifecycle** vocabulary and is not the same thing as `qualityStatus`: `qualityStatus` answers "was the photo usable", `status` answers "how far along is this case". Do not map one onto the other.

*(2026-09-26)* All five are now reachable, and the last three come from **what central reports**, never from elapsed time: after central accepts a case the sync manager polls `GET /api/v1/cases/:caseId/status` until it is `graded` or `error`. `synced` = accepted, no report on it yet; `result_pending` = central reports `awaiting_image` or `processing`; `result_delivered` = central reports `graded` (the grade itself is held at central; this Local API does not carry it). A case central reports as `error` stays **`synced`** with `centralStatus: "error"`: it was accepted but has no result, and must never be shown as one. Do **not** infer any of these from elapsed time; a fabricated status on a clinical screen is worse than a coarse one.

---

## Central API — `central-system/backend`, base URL `http://localhost:5000`

### `GET /health`
*(components added 2026-09-26)* Unauthenticated. Response `200`:
```json
{
  "status": "ok",
  "components": {
    "db":            { "status": "ok" | "down", "latencyMs": 3, "error": null },
    "queue":         { "status": "ok" | "stopped", "queued": 0, "inflight": 1, "retrying": 0,
                       "processed": 12, "failed": 0, "concurrency": 1, "running": true },
    "matlabSession": { "status": "healthy" | "restarting" | "down" | "disabled",
                       "heartbeatFresh": true, "lastHeartbeatAt": "…|null",
                       "restartsInWindow": 0, "lastError": null },
    "python":        { "status": "ok" | "unavailable" | "unknown", "executable": "…",
                       "version": "3.11.16", "missingModules": [], "error": null, "checkedAt": "…|null",
                       "segWorker": { "status": "healthy" | "restarting" | "down" | "disabled",
                                      "heartbeatFresh": true, "lastHeartbeatAt": "…|null",
                                      "restartsInWindow": 0, "lastError": null } }
  },
  "generatedAt": "…"
}
```
- **`status` is always `"ok"` when the server answers.** It means "reachable", because PHC sync and the mobile app gate every upload on it. A down database or MATLAB session shows up under `components`, not here. A case that arrives while MATLAB is down is still stored, then graded or visibly failed by the queue.
- **`db`:** `SELECT 1`, capped at 1 s.
- **`matlabSession.status`:** the supervisor's value, the same one `GET /admin/system-health` reports. `heartbeatFresh` is the live reading, which is still meaningful when the supervisor is `disabled`.
- **`python`:** the interpreter plus the modules the pipeline imports (`numpy`, `cv2`, `scipy`, `torch`, `timm`, `segmentation_models_pytorch`). The probe is cached and refreshed in the background at most once a minute, so `checkedAt` says how old the answer is. `"unknown"` means the first probe has not finished yet.

### `POST /api/v1/cases`
Request: `multipart/form-data` with fields `patientId`, `phcId`, `captureIdRef`, `cameraDeviceId` (all strings), `image` (file), `questionnaireData` (JSON-stringified payload matching the patient questionnaire shape above), `captureMetadata` (JSON-stringified payload matching the capture-metadata shape above).

Plus these, added 2026-09-08:

| Field | Required | Why |
|---|---|---|
| `patientName` | when the patient is unknown centrally | see below |
| `patientAge` | when the patient is unknown centrally | see below |
| `patientContactNumber` | when the patient is unknown centrally | see below |
| `capturedAt` | should always be sent | ISO 8601 UTC, the local `captures.capturedAt` |

**Why the patient fields exist.** `cases.patientId` references a central patient record, but this file defines **no central patient-creation endpoint**, and this request originally carried no demographics. So nothing could ever create that record, and every case for a not-yet-known patient would fail. Rather than invent a second endpoint, the sync manager sends the demographics alongside the first case for a patient; the server registers them if absent and ignores them otherwise. `patientContactNumber` is not bookkeeping — `POST /api/v1/cases/:caseId/review` triggers the referral SMS to exactly this number, so a patient stored without one cannot be told their result.

**Why `capturedAt` is separate from `receivedAt`.** This system is offline-first: a capture can sit in a PHC's sync queue for days before it reaches the server. `receivedAt` is when the server got it; `capturedAt` is when the patient was actually photographed. The ophthalmologist queue shows `capturedAt`, because that is the clinical fact. Treating `receivedAt` as a stand-in silently misdates every case that synced late — which is the normal case in the rural deployment this is built for. If omitted, the server falls back to its own clock, which is wrong for any delayed sync.

Response `201`: `{ "caseId": "a1b2c3d4-...", "receivedAt": "2026-09-06T09:15:00.000Z" }`

A `201` means the case was **stored**, not that it was graded. **Since Task 8.3 grading is queued, so a case is always `"processing"` when the POST returns** — clients must poll `GET /api/v1/cases/:caseId/status` and must not treat the `201` as meaning a grade exists. If grading later fails, the case stays stored and its status becomes `"error"`.

Optional, added 2026-09-26: `qualityGateEngine`, a JSON-stringified engine entry (`{ "engine": "matlab" | "python" | "js-fallback" | "js-device", "fallback": boolean, "detail": string|null }`; `js-device` = the mobile on-device gate) naming the engine that ran the PHC's quality gate on this capture. It is served back as `engineProvenance.qualityGate` on the case detail. The same optional field is accepted by `/cases/summary` and the chunk upload. If it is absent, it is stored as "not recorded", never assumed.

Errors: `400 image_required`, `400 invalid_image_type`, `400 invalid_json` (malformed `questionnaireData`/`captureMetadata`/`qualityGateEngine`), `400 invalid_field` (`qualityGateEngine` is valid JSON but not an engine entry), `404 patient_not_found` (unknown patient and no demographics supplied), `413 image_too_large` (limit 25 MB).

### `POST /api/v1/cases/summary`  *(added 2026-09-20, design doc §10.1)*
JSON body with the same fields as `POST /api/v1/cases` minus `image`. `captureIdRef` is **required** here: it is what the later image upload matches on.

Response: `{ "caseId", "receivedAt", "status", "duplicate" }`.
- **`201`, `status: "awaiting_image"`:** the case was created.
- **`200`, `duplicate: true`:** the capture was already known. `status` is its current state, which may already be `"processing"` or `"graded"` if the image arrived first.

A summary is never graded. It records the patient and the questionnaires, and marks the PHC as in contact (`last_contact_at`, not `last_sync_at`).

Errors:
- `400 capture_id_required | invalid_field | invalid_json`
- `404 patient_not_found`: unknown patient and no demographics sent.

Auth: PHC key.

### `GET /api/v1/cases/:caseId/status`
*(2026-09-20)* `status` may also be `"awaiting_image"`: a summary arrived and the image has not yet.
Response `200`: `{ "caseId": "string", "status": "processing" | "graded" | "error" }`

`"processing"` covers both *waiting for a worker* and *being graded*. That is deliberate: from outside they are the same fact — the answer is not ready, keep polling — and a fourth enum value would expose an internal distinction no client can act on. Both `"graded"` and `"error"` are terminal; nothing leaves either state without a new submission.

**How long to expect:** about 21 s from upload to `"graded"` on the development machine, plus however long the case waited for a free worker. It takes roughly 40 s if the Python segmentation worker is down, because the backend then starts segmentation per case. *(Corrected 2026-09-26)* If the persistent **MATLAB session** is down, the case does not quietly switch engines. It is retried, and if MATLAB is still down it ends in `"error"` (`failureCode` `matlab_session_unavailable` or `matlab_segmentation_failed`). The supervisor restarts the session and raises a System Health alert if that fails. Design a UI that polls, not one that blocks, and do not treat 60 s as abnormal.

### Chunked / resumable upload — `POST|GET /api/v1/cases/:captureRef/chunks…`  *(Task 8.2)*

For images too large to transfer in one request on a poor link. Small images should keep using `POST /api/v1/cases`; chunking a 400 KB file spends extra round trips to save nothing, and round trips are the costly part on these links. The PHC sync manager switches over above `SYNC_CHUNK_THRESHOLD_BYTES` (default 2 MB).

`:captureRef` is the **PHC's own capture id** (`PHC001-lz3k9f-a2x9`), not a central UUID and not a server-issued token. A client that crashes mid-upload re-derives the session key from its own database row, so no resume state has to survive the crash. It must match `^[A-Za-z0-9_-]{1,64}$`.

**`POST /api/v1/cases/:captureRef/chunks/init`** — body is `application/json`: the same case fields as `POST /api/v1/cases` (`patientId`, `capturedAt`, `questionnaireData`, …) plus `totalChunks`, `totalBytes`, `sha256` (hex SHA-256 of the **whole** image), `filename`.
Response `201`: `{ captureRef, totalChunks, received: [int], missing: [int], resumed: bool, alreadyIngested: bool }`.
Calling it again with identical parameters **resumes**: chunks already held are kept and reported in `received`. Calling it with different parameters discards the old chunks, because they belong to a different file.

**`GET /api/v1/cases/:captureRef/chunks`** — Response `200`: `{ captureRef, totalChunks, totalBytes, sha256, received, missing, complete, caseId, createdAt }`. This is the resume primitive: ask what the server has, send only `missing`. `404 session_not_found` if there is no session.

**`POST /api/v1/cases/:captureRef/chunks/:index`** — `multipart/form-data` with the bytes in a `chunk` field and the chunk's own hex SHA-256 in a `sha256` field (or the `X-Chunk-Sha256` header). Response `200`: `{ index, bytes, sha256, received, totalChunks, missing }`.
Re-sending a chunk the server already holds is a **success**, not a conflict — after a dropped connection a client cannot know whether its last chunk arrived.

**`POST /api/v1/cases/:captureRef/chunks/complete`** — assembles in index order, verifies length and the whole-file SHA-256, ingests, and queues grading.
Response `201`: `{ caseId, receivedAt, duplicate: false }` — the same shape as `POST /api/v1/cases`, so the two paths are interchangeable.
Response `200`: `{ caseId, receivedAt, duplicate: true }` when the session was already completed. **Completion is idempotent**: a client that never saw the first response gets the original `caseId` back rather than creating a second case for one scan.

Errors: `400 invalid_capture_ref`, `400 invalid_field`, `400 invalid_image_type`, `400 empty_chunk`, `404 session_not_found`, `409 already_ingested` (a chunk sent after completion), `409 incomplete_upload` (completing with chunks missing — the body lists which), `413 chunk_too_large`, `413 image_too_large`, `422 chunk_checksum_mismatch` (resend that chunk), `422 checksum_mismatch` (the assembled whole is wrong; the session is discarded, start again), `422 size_mismatch`.

**Why two levels of checksum.** Reassembling an image from pieces that crossed a flaky link creates a failure single-shot upload does not have: a file that is the right length, decodes as a valid JPEG, and is subtly wrong — which would then be graded and reported to a clinician with nothing to indicate a problem. Per-chunk hashes catch damage at the chunk instead of after the whole transfer; the whole-file hash catches a *set* of individually-valid chunks that assemble wrong (a stale chunk from an earlier attempt). Nothing is ingested that cannot be shown to be exactly what the PHC captured.

### `GET /api/v1/ophthalmologist/queue`
Response `200`: array of
```json
{
  "caseId": "a1b2c3d4-...",
  "patientReference": "PT-4821",
  "phcName": "PHC Kharadi",
  "capturedAt": "2026-09-06T09:05:00.000Z",
  "drGradeCnn": 2,
  "drGradeRuleEngine": 3,
  "branchAgreement": false,
  "confidenceScore": 0.81,
  "conformalTier": "C",
  "priorityRank": 1
}
```
*(2026-09-20)* Each row also carries `eyeLaterality` (`"left" | "right" | null`), `claimedBy` (`null`, or `{ userId, name }` when another reviewer holds it) and `claimedAt`. Cases that have already been reviewed are **not** listed.

`patientReference` is a display-safe identifier, never the raw `patientId` used internally (keep patient-identifying strings out of anything an ophthalmologist's screen might be seen displaying by someone else). `drGradeRuleEngine` and `branchAgreement` are `null` until Branch B is built (post-checkpoint) — the frontend must handle `null` here from day one, not just once Branch B ships. `conformalTier` ∈ `"A" | "B" | "C"` — Tier A never appears in this list since it auto-clears. Sorted ascending by `priorityRank` (1 = review first). Checkpoint-version ranking: Tier C cases ranked 1–100 by `uncertaintyScore` descending, Tier B cases ranked 101–200 by `confidenceScore` ascending.

`uncertaintyScore` is `null` until MC-Dropout ships (Phase 6). Until then ranking uses `1 - confidenceScore` in its place — same ordering, different scale. That substitute is used for **ordering only** and is never reported as an uncertainty value.

**When Tier C exceeds 100 cases**, Tier B does not start at 101 — it starts after the last Tier C rank. Anchoring B at 101 while C had already reached, say, 150 would interleave the two and place Tier B cases above Tier C ones, inverting the safety ordering the tiers exist to enforce. The 1–100 / 101–200 bands are the expected shape at normal volume, not a cap.

`capturedAt` is the capture time reported by the PHC, not the time the server received the case.

### `GET /api/v1/cases/:caseId` (full case detail)
Response `200`:
```json
{
  "caseId": "a1b2c3d4-...",
  "patientReference": "PT-4821",
  "imageUrl": "/media/cases/a1b2c3d4/original.jpg",
  "gradCamOverlayUrl": "/media/cases/a1b2c3d4/gradcam.png",
  "lesionCounts": { "microaneurysms": null, "hemorrhages": null, "hardExudates": 3, "softExudates": null,
                    "detail": { "redTotal": 8, "redPerQuadrant": [3, 2, 2, 1], "brightPerQuadrant": [1, 1, 1, 0], "minAreaPx": 10, "procedure": "prob > 0.5, 8-connectivity, ..." } },
  "nvSuspicionScore": 0.12,
  "evidenceSummaryText": "6 microaneurysms (superior-temporal: 3, inferior-nasal: 3), 2 dot hemorrhages. Severe-NPDR criteria not met.",
  "drGradeCnn": 2,
  "drGradeRuleEngine": 3,
  "branchAgreement": false,
  "confidenceScore": 0.81,
  "uncertaintyScore": 0.34,
  "conformalTier": "C",
  "lesionAttentionConsistencyScore": 0.71,
  "questionnaireData": { "riskFactors": { "...": "..." }, "symptoms": { "...": "..." }, "language": "hi" },
  "captureMetadata": { "cameraDeviceReported": "forus_3nethra_v2", "pupilStatus": "dilated", "lightingEnvironment": "indoor_clinic", "observedIssues": ["none_noticed"], "workerUsabilityRating": "clear" },
  "priorAssessments": [ { "caseId": "prev-case-id", "gradedAt": "2026-06-01T10:00:00.000Z", "drGradeCnn": 1 } ]
}
```
> [!NOTE]
> **`lesionCounts` returns these keys.** `hardExudates` is a real number — the bright-lesion count under its correct name. **`microaneurysms` and `hemorrhages` are real numbers too, since the M5 3-class model became the default** (`RED_LESION_MODEL_VERSION` defaults to `v2` in `segInfer.py`, with no `.env` override anywhere). *Corrected 2026-09-29: this paragraph said, "as of 2026-09-20", that both were `null` because M5 detected red lesions as a single class and that they would "become real numbers when Tanuj's 3-class retrain lands". It landed and is the default. Verified rather than assumed: every `segmentation_outputs.lesion_counts` row in the live database carries `redLesionModelVersion: "v2"` with non-zero `maTotal`/`heTotal`, and `GET /cases/:caseId` on the newest graded case returns `microaneurysms: 69, hemorrhages: 12`.* They are `null` only under an explicit `RED_LESION_MODEL_VERSION=v1` rollback, where the split genuinely does not exist and dividing a total by any ratio would be inventing a measurement. **`softExudates` is permanently `null`** — nothing in the pipeline detects cotton-wool spots, so it is a disclosed exclusion and must never become `0`.
>
> A fifth key, `detail`, carries the per-quadrant measurement behind those numbers: `redTotal`, `redPerQuadrant`, `brightPerQuadrant`, `minAreaPx` and the counting `procedure`. The database still stores `{red, bright, redTotal, brightTotal}`; only the API boundary speaks clinical names (`services/lesionCounts.js`), so the per-quadrant detail is not lost and no migration was needed. A case whose segmentation has not run reports `lesionCounts: null`, not an object of four nulls — "segmentation did not run" and "it ran and found nothing" stay different statements.

Every ML-derived field (`lesionCounts`, `nvSuspicionScore`, `drGradeRuleEngine`, `branchAgreement`, `uncertaintyScore`, `lesionAttentionConsistencyScore`) is `null` until its backing module ships — the frontend renders "not yet available" for `null`, never crashes on it and never shows a zero/empty value as if it were a real result.

**`evidenceSummaryText` is the exception, since Task 7.3 shipped: it is always a non-empty string.** Lesion segmentation (Tasks 4.2/4.3) does not exist yet, so today it reads:

> "Lesion segmentation has not been run for this case, so no lesion-level evidence is available. The grade shown is from the image classifier alone and has not been cross-checked against ICDR lesion criteria."

That is deliberate and is not a placeholder. It never says "0 microaneurysms" — zero-measured and not-measured are different clinical claims, and a clinician reading this field needs to know which one they are looking at. The example above shows the shape once lesion counts exist. The text is templated from stored counts, never generated prose, and the criterion it names comes from the same rule engine that produced `drGradeRuleEngine`, not from a second copy of the ICDR rules.

**The key must be present and its value `null`.** Not absent, not `undefined`. This is not pedantry: `JSON.stringify` silently drops `undefined` values, so a handler that returns `undefined` emits a response with the key missing entirely. A missing `lesionCounts` renders as blank; a `0` reads as a measured finding of no lesions. On a clinical screen those are three different claims and only one of them is true. Server-side tests must assert key **presence** separately from value.

`drGradeCnn`, `confidenceScore` and `conformalTier` are likewise `null` for a case that has not been graded yet, or whose grading failed — a case with `status: "error"` must not be indistinguishable from a graded one.

`imageUrl` and `gradCamOverlayUrl` are paths under `/media`, or `null` when the file does not exist. `original.jpg` in the example is illustrative: the uploaded file's real extension is preserved, so a PNG upload is served as `original.png`. Naming a PNG `.jpg` would be a file whose extension lies about its contents. Both URLs are served by the central server as static files; a URL returned here is expected to resolve, so treat a 404 on one as a bug rather than an empty state.

### `GET /api/v1/cases/:caseId`: fields added 2026-09-20
- `eyeLaterality`: `"left" | "right" | null`. The eye the image's own DICOM tag reports, if the file has one; otherwise the technician's selection.
- `eyeLateralitySource`: `"dicom" | "technician" | null`.
- `eyeLateralityMismatch`: `true` when the DICOM tag and the technician's selection disagree. Such a case is never auto-cleared (it is held at Tier B or higher).
- `foveaUnreliable`: `true | false | null`. `true` means the localizer could not place the fovea confidently — M3's fovea heatmap peak was below 0.37, or the heatmap was missing or NaN. `null` means the localizer did not report the field at all, which is **not** the same as `false` and is never shown as "reliable".

  When it is `true`: the case is held at **Tier B or worse** (never auto-cleared), and the quadrant-based severe-NPDR criteria — ETDRS 4-2-1 (a) and (b) — are **not applied**, because the four quadrant counts are built on the fovea axis whether or not the fovea was found, so they are not the anatomical quadrants those criteria are written for. Grading falls back to totals. The evidence text says which criteria were skipped.

  **It is a safety net, not a proven detector.** Tanuj validated the gate against two known localization failures. Do not present it to a clinician as a measurement of image quality.

### `GET /api/v1/cases/:caseId`: fields added 2026-09-20 (failures)
- `status`: the case's own status (`processing` | `awaiting_image` | `graded` | `error`). It was missing from this response, which meant a failed case and a still-grading one looked identical: every ML field is `null` on both.
- `failureCode`: why grading gave up, on an `error` case — e.g. `matlab_unavailable`, `matlab_session_unavailable`, `matlab_segmentation_failed` *(2026-09-26)*, `python_unavailable`, `image_not_found`. `null` on every case that has not failed, and `not_recorded` never appears here (that grouping label is the admin health screen's, for the 62 cases that failed before the reason was stored).
- `failedAt`: ISO-8601 timestamp of the moment it gave up, distinct from `receivedAt`.
- The failure MESSAGE is deliberately not in this response. It can quote internal paths and library errors, so it is served only by `GET /admin/system-health`, to an admin.

### `GET /api/v1/cases/:caseId`: field added 2026-09-26 (engine provenance)
`engineProvenance`: which engine produced each ML output of this case. The standing rule is that every case records it and no engine switch is silent.
```json
"engineProvenance": {
  "classifier":   { "engine": "matlab", "fallback": false,
                    "detail": "MATLAB session (branchAInferMatlab.m); input tensor preprocessed in Python (preprocessBranchATensor.py)" },
  "segmentation": {
    "vessel":       { "engine": "matlab", "fallback": false, "detail": "MATLAB session forward pass (vessel_unet_v1)" },
    "localization": { "engine": "matlab", "fallback": false, "detail": "MATLAB session forward pass (localization_v1)" },
    "hardExudate":  { "engine": "matlab", "fallback": false, "detail": "MATLAB session forward pass (bright_lesion_unet_v1)" },
    "redLesion":    { "engine": "python", "fallback": false, "detail": "PyTorch; not converted for MATLAB serving" }
  },
  "ruleEngine":   { "engine": "matlab", "fallback": false, "detail": "runCasePipeline.m in the persistent MATLAB session" },
  "qualityGate":  { "engine": "matlab", "fallback": false, "detail": "qualityGateMain.m via matlab -batch" }
}
```
- **Each entry** is `{ engine, fallback, detail }`, or `null`. `engine` is one of `"matlab" | "python" | "js-fallback"` and nothing else, except that `qualityGate` may also be `"js-device"` (the mobile on-device gate; *2026-09-26*). `detail` is free text for a human, at most 300 characters. Do not parse it.
- **`fallback: true`** means the output came from a non-primary engine because an explicit env flag allowed it: `MATLAB_ALLOW_FALLBACK`, `SEG_ALLOW_PYTHON_FALLBACK` or `QUALITY_GATE_ALLOW_FALLBACK`. Without the flag there is no fallback, and the case fails or is retried instead. A UI should make a `true` visible.
- **`ruleEngine`** covers the whole per-case MATLAB call: the rule engine, branch agreement, camera check, NV score, lesion-attention score and evidence text. When the session could not take the request, `detail` says it ran through `matlab -batch`. The engine is still `matlab`.
- **`null` means NOT RECORDED**, and is never a guess from the server's current configuration. The object itself is always present with all four keys.
  - `classifier`, `segmentation` and `ruleEngine` are `null` on a case not graded yet, and on one graded before 2026-09-26.
  - `segmentation` is `null` when segmentation did not run for this case. That is the same fact `lesionCounts: null` states. A single model inside it is `null` when segmentation did not report that model.
  - `qualityGate` is `null` when the capturing client did not report it: older PHC builds and captures replicated between peer devices before 2026-09-27. The mobile app reports `js-device`, and peer sync carries the entry, from that date.

### `GET /api/v1/admin/system-health`: fields added 2026-09-20
- `failedCases`: cases that gave up, grouped by `failureCode`, each with `count`, `lastFailedAt`, an `exampleReason` and an `exampleCaseId`. Separate from `stuckJobs` on purpose — a stuck case may still recover on its own, a failed one needs a person.
- `failedCaseCount`: the total across those groups.

### `POST /api/v1/cases/:caseId/review`
Request:
```json
{
  "ophthalmologistId": "string",
  "decision": "override",
  "overrideReasonCategory": "wrong_severity",
  "overrideReasonText": "Grade 3 lesions visible superior-temporal, model under-called it.",
  "reviewDurationSeconds": 24
}
```
`decision` ∈ `"confirm" | "override"`. `overrideReasonCategory` is `null` when `decision` is `"confirm"`, otherwise one of: `"artifact_misread" | "lesion_missed" | "wrong_severity" | "image_quality_issue"`. `overrideReasonText` is optional free text, `null` if not provided.
Response `200`: `{ "reviewId": "string", "referralId": "string|null", "smsStatus": "string|null" }`

`referralId` is non-null when this decision raised a referral. `smsStatus` is deliberately a string rather than a boolean, because the interesting states are not "sent / not sent":

| `smsStatus` | meaning |
|---|---|
| `sent` | delivered to Twilio, `providerMessageId` recorded |
| `not_configured` | Twilio credentials absent — **nothing was sent** |
| `dry_run` | `SMS_DRY_RUN=1`; message composed and logged, not sent |
| `failed` | Twilio rejected it; the referral still stands |
| `not_referable` | grade < 2, so no referral and no message (design doc §8.1) |
| `already_sent` | this case was referred by an earlier review; not re-sent |
| `override_without_grade` | see `correctedGrade` below |
| `no_review_on_record` | refused — no human decision exists for this case |

**Optional request field `correctedGrade` (integer 0–4), added 2026-09-08.** On `"confirm"` the model's grade stands and referability follows from it. On `"override"` the ophthalmologist has said the model was wrong — but this contract has no field for *what the grade actually is*, so the system cannot tell whether the case is still referable. Without `correctedGrade` an override returns `override_without_grade` and **no SMS is sent**: telling a patient to seek care for a finding the reviewer may have just ruled out is worse than sending nothing, since the admin referral tracker still shows the case either way. Supply it whenever the decision is an override.

Errors: `400 invalid_field` (bad `decision`; a category supplied on a `confirm`; a category missing or invalid on an `override`), `404 case_not_found`, `409 case_not_graded` (the case has no grading result yet — nothing to confirm or override), `409 case_claimed` (another reviewer holds it).

An `"override"` also writes a `corrections` row in the same transaction — that pairing of "the model was wrong" with "and here is why" is the training signal the continual-learning loop consumes, so a review whose correction failed to record would be lost from retraining with nothing downstream noticing.

**Changes from 2026-09-20:**
- The reviewer is taken from the login session. `ophthalmologistId` is used only when no one is logged in, which can happen only while `AUTH_ENABLED=false`.
- `correctedGrade` is persisted.
- If another reviewer holds a live claim on the case: `409 case_claimed` with `{ claimedBy, claimedAt }`.
- If the two branches disagree (`branchAgreement === false`): a `"confirm"`, or an `"override"` without `correctedGrade`, returns `400 explicit_grade_required` (design doc §10.9). The UI should make Confirm unavailable on such cases; the server enforces it either way.

Review history is now served by `GET /api/v1/cases/:caseId/reviews`, below.

### `POST /api/v1/cases/:caseId/claim`  *(added 2026-09-20, design doc §10.8)*
Call this when a reviewer opens a case in Case Detail. It takes no body. Requires a logged-in ophthalmologist, even while `AUTH_ENABLED=false`, because a claim with no claimant means nothing.

- **Success.** It succeeds when the case is unclaimed, already held by the caller (for example after a page reload), or held by someone whose claim is older than `CLAIM_TTL_MINUTES` (default 30). Response `200`: `{ "caseId", "claimedBy": { "userId", "name" }, "claimedAt", "expiresAt" }`.
- **`409 case_claimed`.** Someone else holds a live claim. The body has the same fields as the `200` response, plus `error` and `message`. Show the holder's `claimedBy.name` and disable the decision controls.
- **Other errors:** `409 case_not_graded`, `404 case_not_found`, `401 unauthenticated`.

### `GET /api/v1/cases/:caseId/report`  *(added 2026-09-20, backend plan §O)*
The per-case clinical-rationale PDF.
- **Response `200`:** `{ "reportUrl": "/media/cases/<id>/report.pdf", "generatedAt", "cached": true|false }`.
- **When it is generated:** on the first request, then cached. A case re-graded since the last PDF gets a fresh one automatically, and `?regenerate=1` forces one.
- **Timing:** 2–6 s when the MATLAB session is up, about 27 s when it is not (a MATLAB start).
- **Contents:** patient reference (never the raw ID), age, eye, site, capture time, the photo and Grad-CAM overlay, the grade with a plain-language description and its tier, both branches' grades and whether they agree, lesion evidence (with the disclosed limits of each detector), the evidence summary, and the "requires ophthalmologist review" disclaimer on every page.
- **Errors:** `409 case_not_graded`, `404 case_not_found`, `502 report_generation_failed`.
- **Auth:** ophthalmologist or district_admin. The PDF itself needs a session, like everything under `/media`.

### `GET /api/v1/cases/:caseId/reviews`  *(added 2026-09-20)*
Review history, newest first. Allowed roles: ophthalmologist or district_admin.
```json
[
  {
    "reviewId": "uuid",
    "decision": "override",
    "overrideReasonCategory": "wrong_severity",
    "overrideReasonText": "string|null",
    "correctedGrade": 3,
    "reviewDurationSeconds": 24,
    "reviewedAt": "2026-09-20T10:00:00.000Z",
    "reviewer": { "userId": "uuid", "name": "Dr. Demo Ophthalmologist" },
    "ophthalmologistId": "string|null"
  }
]
```
- An empty array means the case has never been reviewed.
- `reviewer` is `null` for reviews recorded before login existed, whose `ophthalmologistId` was free text from the client.
- `correctedGrade` is `null` on confirms and on overrides recorded before 2026-09-20.
- Errors: `404 case_not_found`.

### `GET /api/v1/patients/search?name=&age=&phone=`  *(added 2026-09-20, design doc §10.3)*
Duplicate check against every patient in the district. Callers are PHC apps, so it requires `X-PHC-Api-Key`.

**Parameters.** At least one of `name` or `phone` is required: `age` alone matches half the district, so it never selects a candidate and only raises the score.

**Matching and scoring:**
- **Name, whole query contained in the patient's name:** +3.
- **Name, otherwise any query word of 3+ letters contained:** +2. This catches reordered names and a missing surname.
- **Phone:** digits only, compared on the trailing digits (up to 10). +3.
- **Age within ±1 year:** +1.

Results are the top 20 by score.
```json
[
  {
    "patientId": "PHC001-lz3k9f-a2x9",
    "patientReference": "PT-K3M9XQ",
    "name": "Sunita Devi",
    "age": 52,
    "contactNumberMasked": "******3210",
    "registeredAt": "…",
    "matchedOn": ["name", "age"],
    "score": 4
  }
]
```
The phone is masked to its last four digits because this endpoint spans every PHC: enough for the technician to ask the patient to confirm the number, not enough to harvest numbers.

Errors: `400 invalid_field`, `401 phc_key_required | phc_key_invalid`.

### `GET /api/v1/admin/dashboard`
`casesToday` and `casesPerPhc` are both scoped to **today in the district's local timezone** (`REPORT_TIMEZONE`, default `Asia/Kolkata`), not UTC. A UTC day boundary would roll over at 05:30 local time in India, counting each morning's first hours of screening against the previous day — wrong in a way nobody notices. The two figures always reconcile: `casesPerPhc` counts sum exactly to `casesToday`, and cases that arrived without a `phcId` appear as a bucket with `phcId: null` rather than being dropped.
`averageReviewTurnaroundSeconds` is `null` — not `0` — when nothing has been reviewed. A `0` would read as reviews completing instantly, which is the opposite of "no data".

Response `200`:
```json
{
  "casesToday": 42,
  "casesPerPhc": [ { "phcId": "string", "phcName": "PHC Kharadi", "count": 18 } ],
  "averageReviewTurnaroundSeconds": 27
}
```

### `GET /api/v1/admin/referrals`
Response `200`: array of
```json
{ "referralId": "string", "patientReference": "PT-4821", "status": "referred", "assignedWorker": null, "updatedAt": "2026-09-06T09:20:00.000Z" }
```
`status` ∈ `"referred" | "contacted" | "attended" | "lost"`.

### `PATCH /api/v1/referrals/:referralId`
*(2026-09-20)* `status` ∈ `"referred" | "manual_follow_up" | "contacted" | "attended" | "lost"`. `manual_follow_up` is set automatically when the patient could not be reached by SMS (design doc §10.5) and means someone has to phone them; a worker can also set it by hand.
Request: `{ "status": "contacted", "assignedWorker": "ASHA-112" }`
Response `200`: the updated referral object, same shape as the list item above.

### `GET /api/v1/admin/resource-recommendations`  *(added 2026-09-20, backend plan §G)*
District admin. The latest run of the district resource model (`simulink-model/referenceQueueingModel.m`, the model the SimEvents `.slx` was validated against). It runs daily and on demand.
```json
{
  "generatedAt": "…",
  "minOphthalmologistsRoutine": 2,
  "minOphthalmologistsCamp": 4,
  "maxSearched": 12,
  "p95TargetMin": 60,
  "bottleneck": "ophthalmologist review",
  "recommendation": "Reviewer pool is the constraint (72% utilised, p95 wait 72 min). Add ophthalmologists: 1 -> 2.",
  "current": { "numOphthalmologists", "reviewUtilisationPct", "reviewWaitP95Min",
               "uploadUtilisationPct", "uploadWaitP95Min", "casesReviewed", "casesAutoCleared" },
  "params": { "…every input the model ran on…" },
  "inputsSource": { "tierFractions": "observed: 43 graded cases, last 90 days", "…": "…" },
  "model": "referenceQueueingModel",
  "runSeconds": 2.0
}
```
- **`minOphthalmologists*`:** the smallest reviewer pool that holds the p95 review wait under `p95TargetMin`. The first figure is for routine operation, the second for camp mode (the same annual volume in 50 days). It is `null` when even `maxSearched` reviewers would not meet the target; never show `null` as a number.
- **`inputsSource`:** says which inputs were **observed** in this system's own data and which are **modelled defaults**. The panel should show this, because the figures are planning estimates built on assumptions.
- **Errors:** `404 recommendations_not_generated` before the first run.

### `POST /api/v1/admin/resource-recommendations/refresh`
District admin (CSRF header required). Runs the model now, which takes about 10–30 s. Returns the new row in the same shape as above, or `502 resource_model_failed`.

### `GET /api/v1/admin/simulink-validation`  *(added 2026-09-20, backend plan §G.2)*
District admin. **Is the model behind those recommendations still validated?**

The recommendations above come from `referenceQueueingModel.m`. Its right to be believed comes from agreeing with the SimEvents `.slx`, which is the actual PS-requirement-5 deliverable. That comparison now runs weekly, and this reports the last run.
```json
{
  "ranAt": "2026-09-20T03:00:00Z",
  "status": "agree",
  "checks": [ { "metric": "auto-clear share", "simEvents": 71.0, "reference": 68.4,
                "tolerance": 5, "unit": "%", "agree": true } ],
  "simEvents": { "tierAAutoCleared", "reviewed", "uploadUtilisation",
                 "reviewerUtilisation", "reviewWaitMeanSec" },
  "reference": { "casesSimulated", "casesAutoCleared", "casesReviewed",
                 "uploadUtilisation", "reviewUtilisation", "reviewWaitMeanMin" },
  "params": { … }, "simSeconds": 31,
  "note": "All parameters are modelled assumptions, not measured field data."
}
```
- **`status`:** `"agree" | "diverged" | "error"`. These are three states, not two. `"error"` means the run could not happen at all — the model is then **unvalidated**, which is not the same as failing validation, and must not be shown as either a pass or a failure.
- **Upload figures are not compared** and have no entry in `checks`. The two models queue uploads differently by construction, so they are expected to differ.
- **Show `note` wherever these numbers appear.** Every parameter is a modelled assumption, not field data (design doc §16).
- **A `"diverged"` or `"error"` run also raises a `simulink_model_diverged` alert** in `GET /admin/system-health`, resolved automatically on the next run that agrees.
- **Errors:** `404 validation_not_run` before the first run on that machine.

### `POST /api/v1/admin/simulink-validation/refresh`
District admin (CSRF header required). Runs the `.slx` now: about **49 s**, most of it Simulink starting and simulating. Returns the same shape, or `502 simulink_validation_failed`.

### `GET /api/v1/admin/system-health`  *(added 2026-09-20, design doc §10.7)*
District admin. One call returns four checks: silent PHCs, stuck grading jobs, the MATLAB session and unreviewed referable cases.
```json
{
  "silentPhcs":      [ { "phcId", "phcName", "lastContactAt": "…|null", "hoursSilent": 52 } ],
  "stuckJobs":       [ { "caseId", "stuckSince", "autoRecoveredCount": 2,
                         "lastRecoveredAt": "…|null", "autoRecoveryExhausted": false } ],
  "matlabSessionStatus": "healthy",
  "unreviewedCases": [ { "caseId", "tier": "C", "createdAt", "hoursUnreviewed": 76 } ],
  "matlabSession":   { "status", "lastHeartbeatAt", "restartsInWindow", "lastError" },
  "alerts":          [ { "kind": "matlab_session_down", "subject", "message",
                         "firstSeenAt", "lastSeenAt", "occurrences" } ],
  "thresholds":      { "silentPhcHours": 24, "stuckJobMinutes": 15, "unreviewedCaseHours": 48 },
  "generatedAt": "…"
}
```

**The four checks:**
- **`silentPhcs`:** a PHC appears when it has had no contact of any kind (full case, summary packet or chunk) for `silentPhcHours` (env `PHC_SILENT_HOURS`, default 24), or has never made contact (`lastContactAt: null`). This is the same rule `GET /admin/phcs` uses for `status`, so the System Health count and the number of `"silent"` rows on the PHC Health page are always equal.
- **`stuckJobs`:** a case appears when it is still processing long after it arrived. The automatic watchdog re-queues such cases up to 3 times; once `autoRecoveryExhausted` is `true`, it needs a human.
- **`matlabSessionStatus`:** one of `"healthy" | "restarting" | "down" | "disabled"`. The supervisor restarts the session itself. It reports `"down"`, and raises an alert, when restarting has not worked.
- **`unreviewedCases`:** referable cases that have never been reviewed, older than `unreviewedCaseHours`.

### `GET /api/v1/admin/phcs`  *(added 2026-09-27)*
District admin (401 with no session, 403 for any other role, like every `/admin` route). One item per row of `phc_sites`, ordered by name; `[]` when no site is registered.
```json
[ { "phcId": "7b395269-…", "phcCode": "PHC001", "name": "PHC Kharadi", "district": null,
    "lastSyncAt": "2026-09-26T11:39:54.594Z", "lastContactAt": "2026-09-26T11:41:02.114Z",
    "casesLast24h": 8, "pendingOrFailedCount": 1, "status": "active" } ]
```
- **`phcCode`, `district`:** `null` when not recorded. Nothing is guessed.
- **`lastSyncAt`:** the latest case **central received** from that site, or `null` if it has never sent one. It is not `phc_sites.last_sync_at`, which keeps its own narrower meaning (full-sync completion, used by `GET /phc/:phcId/sync-status`).
- **`casesLast24h`:** cases received from the site in the last 24 hours.
- **`pendingOrFailedCount`:** what the PHC last reported as still queued (`pending_count`, accurate only as of its last contact) **plus** the site's cases whose grading failed here (status `error`).
- **`lastContactAt`:** `phc_sites.last_contact_at`, any authenticated contact from the site, or `null` if never.
- **`status`:** `"silent"` when `lastContactAt` is `null` or older than `PHC_SILENT_HOURS` (default 24), otherwise `"active"`. One definition: it is exactly the rule behind `silentPhcs` and `thresholds.silentPhcHours` in `GET /admin/system-health`.
- **The API key and its hash are never returned.**

### `GET /api/v1/phc/:phcId/sync-status`
*(2026-09-20)* Response also includes `lastContactAt` (`string|null`).
Response `200`: `{ "phcId": "string", "phcName": "PHC Kharadi", "lastSyncAt": "2026-09-06T08:00:00.000Z", "pendingCount": 5 }`
Response `404`: `{ "error": "phc_not_found", "message": "..." }`

**Read `lastSyncAt` and `pendingCount` together — `pendingCount` alone is misleading.** The sync queue lives in that PHC's local SQLite; central has no view into it, so this is the number the PHC last *reported*, true only as of `lastSyncAt`. The site whose backlog is genuinely growing is exactly the offline one whose count is frozen at whatever it was when it last made contact. A PHC reporting `pendingCount: 0` with a three-day-old `lastSyncAt` is a far bigger problem than one reporting `40` from a minute ago. Any UI built on this must surface the staleness, not just the count. `lastSyncAt` is `null` and `pendingCount` is `0` for a site that has never synced.

### `GET /api/v1/phc/cases/:captureRef/report`  *(added 2026-09-24)*
The graded result for a capture, read by the PHC that submitted it. `:captureRef` is the PHC's own capture id (the `captureIdRef` it uploaded with), not the central `caseId`: it is the one id an offline-first client is guaranteed to hold.

Auth: PHC key. A case submitted by a different site is `404`, never `403`, so one site cannot probe for another's captures.

Response `200`:
```json
{
  "captureRef": "PHC001-lz4a2b-c7f1",
  "caseId": "uuid",
  "status": "processing | awaiting_image | graded | error",
  "failureCode": null,
  "gradedAt": "2026-09-24T10:00:00.000Z",
  "modelVersion": "branchA_v2c",
  "drGradeCnn": 2,
  "drGradeRuleEngine": 2,
  "branchAgreement": true,
  "confidenceScore": 0.81,
  "uncertaintyScore": 0.07,
  "conformalTier": "B",
  "tierReason": "unvalidated_camera: ...",
  "lesionCounts": { "microaneurysms": 4, "hemorrhages": 1, "hardExudates": 0, "softExudates": null, "detail": { } },
  "nvSuspicionScore": null,
  "evidenceSummaryText": "…",
  "eyeLaterality": "right",
  "eyeLateralityMismatch": false,
  "foveaUnreliable": false,
  "gradCamAvailable": true,
  "review": { "decision": "confirm | override", "correctedGrade": null, "reviewedAt": "…" }
}
```
Every ML field follows the null rule of `GET /api/v1/cases/:caseId`: `null` means not produced, never zero. `review` is `null` until an ophthalmologist has decided. **Until then the grade is the AI's alone and the client must present it as unconfirmed** (design doc §1.5). On an override, `review.correctedGrade` is the grade of record.

Deliberately narrower than the reviewer's case detail: no questionnaire, patient reference, claim state or urgency score.

Errors: `404 case_not_found`, `401 phc_key_required | phc_key_invalid`.

### `GET /api/v1/phc/cases/:captureRef/gradcam`  *(added 2026-09-24)*
The GradCAM overlay as `image/png`, under the same own-case check. `/media` requires a user session, which a PHC device never has. `404 gradcam_not_available` when the report says `gradCamAvailable: false`.

---

## Authentication  *(added 2026-09-20, backend plan §A)*

### `POST /api/v1/auth/login`
Request: `{ "email": "string", "password": "string" }`

Response `200`:
```json
{
  "user": { "userId": "uuid", "name": "string", "email": "string", "role": "ophthalmologist" },
  "csrfToken": "string",
  "expiresAt": "…"
}
```
It also sets the `ns_session` cookie (`HttpOnly; Secure; SameSite=Lax`, or `SameSite=None` when `COOKIE_SAMESITE=none`).
- **The JWT is never in the body.** The frontend cannot read the cookie and should not try.
- **Keep `csrfToken` in memory.**
- **Sessions last 12 hours** (`JWT_TTL_HOURS`). There is no refresh; on expiry the user logs in again.

`role` ∈ `"ophthalmologist" | "district_admin"`.

Errors:
- `400 invalid_field`
- `401 invalid_credentials`: the same body for an unknown email and a wrong password, deliberately.
- `429 too_many_attempts`: after 10 failures in 15 minutes.

### `GET /api/v1/auth/me`
Same `200` body as login. Call it on page load to recover the user and `csrfToken` after a reload. Errors: `401 unauthenticated`.

### `POST /api/v1/auth/logout`
`204`. Clears the cookie.

### Rules for every browser call
- `fetch(url, { credentials: 'include' })`. Without it the cookie is neither stored nor sent.
- POST, PATCH and DELETE also send `X-CSRF-Token: <csrfToken>`. Missing or wrong: `403 csrf_invalid`.
- A frontend on a different site from the backend (for example `*.vercel.app` → `http://localhost:5000`) needs the backend set to `COOKIE_SAMESITE=none`, and its origin in `CORS_ALLOWED_ORIGINS`.

### PHC device authentication
PHC apps do not log in. They send their site's key as `X-PHC-Api-Key: phc_…`, issued once by `npm run provision-phc-key` on central and stored in that PHC's config (`PHC_API_KEY`). A key identifies its site, so a request that names a different `phcId` gets `403 phc_mismatch`. Errors: `401 phc_key_required | phc_key_invalid`.

### Who may call what (enforced when the flags are on)
| Endpoint | Allowed |
|---|---|
| `POST /api/v1/auth/*`, `GET /health` | anyone |
| `POST /api/v1/cases`, `/api/v1/cases/:captureRef/chunks…` | PHC key |
| `GET /api/v1/patients/search` | PHC key |
| `GET /api/v1/cases/:caseId/status` | PHC key **or** any logged-in user |
| `GET /api/v1/cases/:caseId`, `GET /api/v1/cases/:caseId/reviews`, `/media/…` | ophthalmologist or district_admin |
| `GET /api/v1/ophthalmologist/queue`, `POST …/claim`, `POST …/review` | ophthalmologist |
| `GET /api/v1/admin/*`, `PATCH /api/v1/referrals/:id`, `GET /api/v1/phc/:phcId/sync-status` | district_admin |

Reads and writes of patient data by a logged-in user are recorded in `access_log`.

Demo accounts, from `npm run seed-users`, are listed in `.env.example`. They are fake and clearly labelled.

## Error shape (applies to every endpoint above)
Any non-2xx response body is always: `{ "error": "snake_case_error_code", "message": "human-readable string" }` — never a bare string, never an HTML error page. Frontend error handling should read `.error` for logic and `.message` only for display.
