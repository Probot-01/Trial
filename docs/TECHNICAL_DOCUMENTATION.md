# NetraSetu — Technical Documentation

**PS 26038 — Explainable AI for Diabetic Retinopathy Screening in Rural India**
**Team:** Tanuj (lead, ML), Saad (backend, MATLAB/Simulink), Kankshi, Parth, Vedant — "Game Of Codes"

This document explains what the system is, how its parts fit together, and what state each part
is actually in today. It is built from `docs/system-design-v4.md` (the team's locked design
document) reconciled against `docs/STALE_CLAIMS_AUDIT.md` (a fresh, code-verified audit of what in
v4 is still accurate vs. now resolved) and this project's own final integration-testing pass —
so where v4 describes something as unbuilt or broken and it has since been fixed and verified
live, this document says so, with the same file:line discipline v4 itself uses. Full ML numbers
live in `docs/ML_BENCHMARKS.md`; this document explains *why* the system is built the way it is
and *what* each piece does.

---

## 1. The Problem, and Why the Architecture Looks the Way It Does

India has roughly one ophthalmologist per 100,000 rural people, and diabetic retinopathy affects
about 18% of the country's 77M+ diabetic adults. Early screening prevents 90% of DR-related
blindness, but there aren't enough specialists to screen at population scale. The actual task
isn't "build an AI that detects DR" — it's "let a non-specialist technician at a rural Primary
Health Centre (PHC) do what only a specialist could do before, and let that specialist trust and
act on the AI's output in seconds." Every architectural choice below traces back to that sentence.

**Edge/cloud split.** Rural PHCs have unreliable or absent internet and modest hardware. The
problem statement's accuracy bar is hard enough to hit with a full-capacity model — compressing it
to survive on edge hardware risks losing exactly the accuracy the system is graded on. The only
thing that genuinely benefits from running locally is the image-quality check, because a
technician needs an instant retake decision before the patient leaves the chair. So: **local does
quality gating only; central does all grading.** This applies identically to both front-ends.

**Capture source.** A phone's bare camera cannot produce a usable fundus photograph — this is an
optical limitation (purpose-built optics are needed to see through the pupil), not something
software fixes. Both front-ends require a dedicated fundus camera as the only way an image enters
the system; the mobile app's "capture" step is a gallery import of an image taken on that same
camera, not a second, competing capture method. Nothing in either front-end calls an external,
unversioned inference endpoint — an earlier prototype iteration of both the desktop capture screen
and the mobile app did exactly that, and neither behavior carries forward into the current system.

**Human-in-the-loop, always.** The AI never tells a patient they have a disease directly. Every
"probably has DR" outcome — real-time or delayed — is confirmed by an ophthalmologist before it
becomes an SMS to the patient.

**Two front-ends, one spec.** A desktop web app and an Expo mobile app both implement the same PHC
technician workflow against the exact same central API contract — neither has its own backend,
response shape, or capture-time inference call. They differ in exactly one respect: how the image
gets onto the device (camera SDK vs. gallery import of an image from the same camera). Everything
after that point — quality gate, questionnaires, sync, identity scheme, definition of "synced" —
is the same spec, met the same way on both.

**No result ever substitutes for a failure.** A network failure, a timeout, and a working result
must be distinguishable on screen. A failed request either surfaces as an error or genuinely
queues for retry — never a plausible-looking fabricated result. This is a system-wide rule, not
one screen's convention, and it is why mock data is only ever shown behind an explicit, visible
"DEMO DATA" banner (`DATA_MODE=mock`), never as an automatic fallback on error.

---

## 2. Actors

| Actor | Touches |
|---|---|
| PHC Technician | Either local front-end (desktop or mobile) |
| Patient | Receives an in-person result and/or SMS; gives verbal consent, timestamped at registration |
| Ophthalmologist | Central web app — review queue, case detail, decision controls |
| District Health Administrator | Central web app — dashboard, system health, referral tracker, resource recommendations |
| ASHA / Community Health Worker | Referral follow-up, assigned via the admin interface |

---

## 3. High-Level Architecture

```
                     ┌─────────────────────────┐
   PHC Desktop  ───▶ │                         │
   (React+Vite)      │   Central Backend        │──▶ PostgreSQL
                     │   (Node/Express)         │
   PHC Mobile   ───▶ │   - Ingestion API        │──▶ Grading pipeline (MATLAB + Python)
   (Expo/RN)         │   - Grading orchestrator │──▶ media/ (encrypted at rest)
                     │   - Referral/SMS (Twilio)│
   Both also talk    │   - Admin analytics      │
   to a PHC-local     │   - Simulink integration │──▶ Central Web (ophthalmologist / admin)
   backend for the   └─────────────────────────┘    (React+Vite)
   local queue + on-
   device quality
   gate first.
```

**Where MATLAB lives:** the quality gate, preprocessing, camera calibration, segmentation
orchestration, the rule engine, calibration math, explainability, and the Simulink resource model
are MATLAB/toolbox territory. The UI, database, and API layers are not. Branch A (the CNN
classifier) is trained in PyTorch, exported to ONNX, and imported into MATLAB's Deep Learning
Toolbox so the actual inference call runs inside a persistent MATLAB session the backend calls
into per case — a real, verified capability, not a demo trick, though it assumes a MATLAB license
on whichever machine runs it (see §10, Honest Limitations).

**No Redis.** The grading queue runs in-process in the central backend.

---

## 4. Local PHC Application (Both Front-Ends)

### 4.1 Screens

| Screen | What it does |
|---|---|
| Patient Registration | New-patient form; fuzzy duplicate check by name/age/phone before a new patient ID is minted; verbal-consent checkbox, timestamped |
| Capture | Desktop: camera trigger. Mobile: gallery import of an image from the same dedicated camera. Both tag the capture left/right eye before anything else touches it |
| Quality Result | Pass / borderline / fail with a specific reason (blur, dark, poor field of view, glare, motion, eyelash occlusion, etc.); a real quality score is always shown when one exists, "not available" when it doesn't — never a fabricated number |
| Patient Symptom/Risk Questionnaire | Diabetes duration, glycemic control, BP, pregnancy status, symptom toggles — no free text, no skip |
| Capture Metadata Questionnaire | Device, pupil status, lighting, observed issues — tap-only, under 45 seconds |
| Local Queue | Captured → Quality-Passed → Synced → Result-Pending → Result-Delivered, with a storage-pressure indicator |
| Sync Status | Online/offline indicator, pending count; "synced" means the central backend actually accepted the case, never merely that a request returned |

### 4.2 Local Backend

| Service | Responsibility |
|---|---|
| Capture Handler | Desktop: camera driver interface. Mobile: gallery-import step. Either way, tags the image by eye |
| Quality-Gate Engine | Desktop: MATLAB (`matlab -batch`, with a compiled-exe tier and a pure-JS fallback tier if MATLAB is unavailable — deliberate resilience, not a gap). Mobile: the same JS reimplementation as the desktop's fallback tier, ported once, not reinvented, so both front-ends apply identical rules |
| Local API | Wraps Capture Handler + Quality-Gate Engine, reads/writes the local DB |
| Sync Manager | Prioritizes by urgency tier then age; sends a lightweight case-summary packet ahead of the full image on thin connectivity; full images go through resumable, chunked upload; every submission carries the local `capture_id` as an idempotency key so a retried upload never creates a duplicate case |

### 4.3 What Differs on Mobile, and Only This

- **Local persistence** is a real embedded database (`expo-sqlite`), not a single serialized blob —
  per-record queries and safe partial writes under an extended outage with dozens of cases queued.
- **Identity** uses the exact same collision-safe ID scheme as desktop (PHC code + timestamp +
  random suffix), not a second format that could silently drift apart from it.
- **Both questionnaires apply in full** — no skip option, same field set, on either front-end.
- A dedicated on-device **fundus-lens capture mode** exists (`mobile_lens` camera preset) in
  addition to gallery import, with its own lens-specific capture guidance (attach the lens, dim the
  room, find the red reflex, align the optic disc in the guide circle).

---

## 5. Central System

### 5.1 Ophthalmologist Interface

| Screen | Components |
|---|---|
| Review Queue | Sorted by urgency tier first (least-confident cases surface first, not most severe); patient ref, eye, PHC, capture time, both branches' grades, confidence tier, claim status |
| Case Detail | Fundus image with a toggleable Grad-CAM overlay; four-category lesion-evidence panel; both grading branches side by side with a disagreement flag; calibrated confidence and conformal tier; an automatic review-duration timer; a "show technical/engine details" toggle (collapsed by default, auto-opened only if a fallback engine actually ran) |
| Decision Controls | Opening a case claims it (a second reviewer sees who holds it and cannot submit a conflicting decision). Confirm, or Override with a structured reason + optional free text + corrected grade. **On branch disagreement, "Confirm" is not available** — the reviewer must pick an explicit final grade |
| Case History | Per-patient longitudinal view — grade-over-time trend across visits, per eye, including prior lesion counts and prior review/referral status |

### 5.2 District Admin Interface

| Screen | Components |
|---|---|
| Dashboard | Cases today/week/total, average review time, override rate, average confidence, cases by PHC |
| System Health | One consolidated view: PHC sites gone silent, grading jobs stuck, the MATLAB session's own health, referable cases sitting unreviewed past a threshold — plain-language summaries by default, raw technical detail behind a toggle |
| Referral Tracker | referred → contacted → attended / lost, assigned-worker field, automatic manual-follow-up state on SMS delivery failure |
| Resource Recommendations | Staffing/routing guidance from the Simulink resource model, refreshed periodically; the SimEvents co-validation detail is collapsed behind a toggle by default |

### 5.3 Central Backend Services

Ingestion API (dedup on `capture_id`) · Grading Pipeline Orchestrator (preprocessing → camera
calibration → segmentation → dual-branch grading → confidence routing → rationale) · Referral &
Notification Service (Twilio SMS, manual-follow-up on failure) · Admin Analytics Aggregator ·
Simulink Integration (scheduled resource-model run) · Grading Job Watchdog · MATLAB Session
Supervisor · Auth Service · Audit Logging · Site & Camera Probation Tracking (a new PHC/camera
family runs through mandatory review while its early outcomes are compared against the existing
calibration baseline, before it graduates to normal tiering).

### 5.4 Database

PostgreSQL, with real migration tooling (`node-pg-migrate`). Core tables: `patients`, `cases`,
`grading_results` (both branches' grades, agreement flag, confidence, uncertainty, conformal tier,
claim state), `segmentation_outputs` (lesion counts per category, NV suspicion score, fovea
reliability flag), `explainability_outputs` (Grad-CAM path, rationale report path, engine
provenance), `ophthalmologist_reviews`, `referrals`, `phc_sites`, `users`, `access_log`.

### 5.5 API Contract

One contract (`docs/api-contracts.md`), consumed identically by both local front-ends. Core
endpoints: `POST /api/v1/cases` (idempotent on `capture_id`), `POST /api/v1/cases/summary`
(lightweight packet ahead of the image), chunked upload endpoints, `GET
/api/v1/ophthalmologist/queue`, `POST /api/v1/cases/:id/review`, `GET
/api/v1/phc/cases/:captureRef/report` (the PHC-scoped report a technician's own front-end reads
back), `GET /api/v1/admin/*` (dashboard, system-health, referrals).

---

## 6. ML Pipeline

### 6.1 Image Quality Assessment (local, either front-end)
Classical CV heuristics — focus/blur, illumination, contrast, field-of-view, glare, motion
artifact, eyelash occlusion, colour balance, border proportion — per-camera-family preset,
implemented once in MATLAB and once as an equivalent JS reimplementation that both the desktop
fallback tier and the entire mobile app run.

### 6.2 Preprocessing (central)
CLAHE, illumination normalization, denoising, Ben Graham-style circular crop — implemented exactly
once, and that one implementation is what both trains and serves the classifier. A prior MATLAB
reimplementation of this exact chain was removed after it was found to flip real grades on real
images via a residual invisible on synthetic test tensors — a second implementation expected to
agree with the first is treated as a standing risk, not a convenience.

### 6.3 Camera-Fingerprint Calibration (central)
Identifies the capture device family from vignetting, aspect ratio, and colour-channel gains,
cross-checked against the worker-reported device field. A mismatch feeds the confidence-routing
decision as a reason for mandatory review, not a pixel-level correction. New sites/camera families
earn trust through mandatory review before graduating to normal tiering.

### 6.4 Optic Disc / Fovea Localization (central)
A U-Net regressor. Optic-disc localization: mean error 4.07px in 512-space, 98.7% within one disc
radius (n=77). Fovea localization has a rare failure mode where the confidence heatmap has no real
peak, silently rotating the quadrant axis used by the rule engine — a peak-confidence gate
(threshold 0.37) catches this, marks the case `fovea_unreliable`, falls back to the plain
image-axis convention, and forces mandatory review. Full numbers: `docs/ML_BENCHMARKS.md` §3.

### 6.5 Vessel Segmentation (central)
A U-Net trained on CHASE_DB1 (Dice 0.80 in-domain), complemented by a Frangi vesselness filter.
An earlier "domain shift" diagnosis on cross-dataset performance was corrected: the true cause is
an annotation-convention difference between datasets (different conventions mark thin vessels
differently), not the model failing to generalize — though a genuinely lower cross-dataset Dice
(0.62 on DRIVE) remains, and the live inference threshold is a fixed 0.5, not yet adjusted
per-domain as originally specified. Feeds NV-suspicion scoring and false-positive suppression for
microaneurysm detection.

### 6.6 Lesion Segmentation (central)
Two models: a **red-lesion model** for microaneurysms+haemorrhages, and a **hard-exudate model**
(Dice 0.67, n=27) — "bright lesion" is exactly and only hard exudates. **The red-lesion model
actually deployed is v2**, a 3-class architecture (background/MA/HE) with a class-specific
minimum-size filter — a much lower size floor for microaneurysms, since most true microaneurysms
are only a few pixels across and a filter tuned for haemorrhage-scale noise would discard most of
them. v1 (a single combined-class predecessor) is the only version with its own measured Dice
score (0.61); v2's own segmentation accuracy has not yet been independently re-measured, though it
is confirmed live in production (real per-case, non-zero microaneurysm/haemorrhage counts in the
database). As of 2026-09-30, v2 also runs through the MATLAB session by default like every other
segmentation model (ONNX-imported to `red_lesion_unet_v2.mat`, parity-checked against its PyTorch
source), rather than always running PyTorch — see `docs/ML_BENCHMARKS.md` §3 for the full, honest
breakdown of this gap.
**Cotton-wool spots (soft exudates) are an explicit, disclosed scope exclusion** — training data
for this specific lesion type was judged too sparse to support a real detector; the field is
always reported as unmeasured, never as a false zero.

**Neovascularization** is a suspicion score (vessel density/branching/tortuosity near the optic
disc), not a segmentation claim, because it has the least public training data of any lesion type
here. Its own measured performance (AUC 0.29 on IDRiD, 0.38 on Messidor-2 — both below chance) means
it is currently gated off and decides nothing; a CNN-predicted grade-4 triggers mandatory review
on its own, independent of this score.

**Standing rule:** the lesion-count size filter and the rule engine's severity thresholds are one
coupled, jointly-calibrated unit — changing one without recalibrating the other silently rescales
what the thresholds mean.

### 6.7 DR Severity Classification — Two Independent Branches (central)

**Branch A (CNN):** EfficientNet-B0, transfer-learned with an ordinal-aware loss (grade confusions
closer together on the severity scale count as smaller errors) plus class-weighted terms for
severe-grade imbalance. A dedicated safety check runs alongside the argmax grade: if the combined
probability of grade 3 and grade 4 exceeds 0.5, the case is marked referable regardless of the
single most likely grade — because the most severe grade is also the hardest to resolve, and a
near-miss on the top grade should never silently become a non-referral. **Currently deployed:
`branchA_v2c`** (512×512 input), which replaced an earlier version specifically because that
version's grade-4 (proliferative DR) recall was a ship-blocking 0.444 — on the official 103-image
IDRiD test set, v2c's grade-4 recall is 13/13 (see `docs/ML_BENCHMARKS.md` §1 for the full table
and the caveats that come with it).

**Branch B (rule engine):** plain, testable code implementing the ICDR/ETDRS "4-2-1" rule directly
on quadrant-mapped lesion counts — auditable against the clinical rule text line by line, not a
black box. Falls back to the plain image-axis convention (skipping quadrant logic) whenever
`fovea_unreliable` is set. Live, frozen thresholds: `RED_FLOOR=3`, `GRADE3_QUAD_MIN=3`,
`RULE_MAX_GRADE=3` — not to be changed without an explicit decision (`CLAUDE.md`). A separate
recalibration study exists but is explicitly marked "not read by any production code" and is not
what ships.

**Fusion:** agreement between the branches is itself evidence supporting the case's confidence
tier. Disagreement is an unconditional trigger for mandatory review with a required explicit
resolution — never averaged away as noise. No system-wide agreement-rate statistic is currently
reported (the only candidate data file is a small curated set of disagreement examples, not a
representative sample — see `docs/ML_BENCHMARKS.md` §4).

### 6.8 Confidence Routing (central)
Every case's tier is the output of **one decision**, combining: temperature-scaled classifier
confidence, Monte Carlo Dropout uncertainty, class-conditional ordinal conformal prediction,
branch agreement (a disagreement is an unconditional override), camera-family mismatch / probation
status, and capture-quality flags (including `fovea_unreliable`).

| Tier | Meaning | Consequence |
|---|---|---|
| A — auto-clear | Singleton conformal set, high confidence, branch agreement, no probation/quality flag | Skips the ophthalmologist queue entirely |
| B — AI-assisted review | Narrow conformal interval | Full rationale report, target under 30s review |
| C — full manual review | Wide interval, disagreement, CNN grade-4, probation, or a quality flag | No shortcuts |

A cross-fit safety study on the deployed model's calibration population (n=1161, 50 folds) found
**zero grade-4 cases auto-cleared to Tier A** across 1000 fold-assignments, and a 0% false
auto-clear rate for both referable and grade≥3 cases — the core safety property this tiering
system exists to guarantee, holding with no exceptions found. Full numbers:
`docs/ML_BENCHMARKS.md` §2.

### 6.9 Explainability (central)
Grad-CAM/Grad-CAM++ on the classifier's final convolutional layer, restricted to the retinal ROI.
**Important display detail:** the Grad-CAM image is the model's own cropped working image, not the
original capture — the crop can look tighter or offset from the photo shown elsewhere on the case,
and both frontends now caption this explicitly rather than letting it read as a bug. Assembled,
together with the four-category lesion evidence and which rule-engine criteria fired, into one
per-case rationale. A trailing methodology caveat that the underlying evidence-summary text
sometimes carries (e.g., a threshold being provisional) is now split into its own labeled
"methodology note" on both the central and mobile UIs, rather than reading as additional clinical
evidence.

### 6.10 Symptom + Risk Fusion (central)
Rule-based weighted scoring applied as a confidence adjustment after the image model's calibrated
output — not a learned model, since no dataset currently links questionnaire data to outcomes.

### 6.11 Continual Learning (central, periodic)
Ophthalmologist overrides and their structured reasons are captured inside the same transaction as
the review decision and exported (`scripts/exportTrainingSet.js`, with consent enforcement, dedupe,
newest-label-per-case). **The scheduled fine-tuning job, validation gate, and promotion step are
not implemented this round** — this is a stated scope boundary, not an oversight: corrections are
captured and exportable; retraining is a manual, future-round step.

---

## 7. Systems Layer — Simulink Resource Model

A real, working discrete-event simulation (SimEvents), built as a script rather than hand-assembled
in a GUI. Entities are patient images; the arrival process is the acquisition rate per PHC; network
transmission is a bandwidth-constrained queue across good/poor/very-poor connectivity tiers;
ophthalmologist review is a limited-capacity server (~30s Tier B, several minutes Tier C, with Tier
C pre-empting Tier B on the shared reviewer pool). Outputs: queue length over time, average wait,
bottleneck location, a plain-language resource recommendation — feeding the Admin Analytics
Aggregator and Resource Recommendations screen. Bandwidth/timing parameters are modeled
assumptions, not measured field data.

---

## 8. Resilience & Edge-Case Handling

- **Extended outages:** urgency-then-age sync ordering, storage-pressure warnings, a lightweight
  summary packet ahead of the full image under thin connectivity, PHC last-contact time feeding
  System Health, and a manual export-to-drive fallback for outages severe enough that even
  intermittent connectivity isn't achievable.
- **Ungradable images:** after a fixed number of failed retakes, the technician can mark a capture
  "best effort — proceed as ungradable," forcing mandatory Tier C review rather than an infinite
  retry loop or a silently dropped case.
- **Duplicate patients:** fuzzy name/age/phone matching at registration, technician confirms or
  merges before a new ID is created.
- **Per-eye capture:** every capture is tagged left/right; one visit can produce two independent
  graded cases.
- **Failed patient contact:** an undeliverable SMS flips the referral straight to manual-follow-up.
- **Collision-safe identity:** patient/capture IDs use PHC code + timestamp + random suffix, not an
  incrementing counter — a reset or reinstalled device can never regenerate an ID already in use
  centrally. Every case submission carries its `capture_id` as an idempotency key, enforced with a
  uniqueness constraint centrally.
- **Active system-health monitoring:** a silent PHC, a stuck grading job, a dead MATLAB session,
  and an unreviewed referable case are treated as the same class of failure — each with its own
  continuously-running check and threshold, surfaced on one consolidated screen, with
  plain-language summaries by default and raw detail behind a toggle.
- **Concurrent review claiming:** opening a case claims it; a second reviewer sees who holds it and
  cannot submit a conflicting decision while it's claimed.
- **Mandatory resolution on disagreement:** "Confirm" is never an available action when the two
  branches disagree — the reviewer must pick an explicit final grade.

---

## 9. Security (Current State)

`docs/system-design-v4.md` §11.1 states, as written, that this system has no authentication
anywhere — this was accurate when written and is now **stale**, verified directly against the
live, running code this session:

- **Central:** `AUTH_ENABLED=true`. Verified by logging in as both `district_admin` and
  `ophthalmologist` through the real `POST /api/v1/auth/login` (bcrypt-checked; a wrong password
  returns a genuine 401). The login screen's demo-account shortcut only exists when
  `DATA_MODE=mock`, which is not the default.
- **PHC desktop and mobile:** `LOCAL_AUTH_ENABLED=true` (set explicitly this integration pass —
  previously shipped `false` by default, which is the actual severity of the gap v4 was
  describing: a config default, not "auth doesn't exist"). Real bcrypt/session code, technician
  accounts provisioned via CLI (`npm run technician -- add <username> "<name>"`), password
  generated and printed once.
- **Mobile:** authenticates against the paired PC's real technician accounts over an encrypted
  peer channel (`/peer/login`), with an honest offline-cache fallback and a dev-only demo account
  gated to Expo Go builds — never a silent success fabrication on failure.
- **Encryption:** AES-256-GCM at rest for stored images, Grad-CAM overlays, and report PDFs
  (`MEDIA_ENCRYPTION_KEY`); TLS supported for both backends.
- **Audit logging:** every access to patient data is recorded (`access_log` table).

**What remains a real, stated gap, not resolved by the above:** this is a prototype-stage security
floor, not a production compliance claim. Role-based access control is enforced server-side on
central's endpoints; a full security audit (rate limiting, secret rotation, penetration testing)
has not been performed.

---

## 10. Honest Limitations (Stated on Purpose)

- **This is a screening decision-support system, not an autonomous diagnostic** — every positive
  result is confirmed by an ophthalmologist before it reaches a patient.
- **Rural deployment without a MATLAB license is not solved this round.** The persistent MATLAB
  session serving Branch A requires a MATLAB license and the Deep Learning Toolbox on whatever
  machine runs it. The local quality gate solves this exact problem for itself (MATLAB Compiler +
  free Runtime); the same packaging has not yet been applied to the central inference path.
- **Specificity (82.1%) is below the >85% target** even though sensitivity clears its >90% target
  — meaning only ~4% of cases fully auto-clear at the current calibration; most cases still reach a
  human reviewer.
- **The red-lesion model actually running in production (v2) has no independently measured
  accuracy score of its own** — only its v1 predecessor's does (a different, single-class
  architecture). See `docs/ML_BENCHMARKS.md` §3.
- **Neovascularization detection is measured and has failed** (below-chance AUC) — it is gated
  off, a distinct fact from the grade-4 recall issue, which is resolved on the deployed model.
- **Diabetic macular edema cannot be reliably ruled out from color fundus photographs alone.**
- **The grading queue is in-memory** and only recovers stuck jobs at server restart plus the
  Grading Job Watchdog's periodic scan.
- **Automated test coverage is real but partial** — mobile (28 unit tests) and PHC backend (41
  tests) pass; central backend has no automated suite, relying on targeted manual verification
  scripts.
- **Simulink parameters are modeled assumptions, not measured field data.**
- **Messidor-2 was used for model selection between candidate classifier versions, not as an
  untouched external validation set** — so it does not substitute for one.
- **The "integrated pipeline beats a single technique" claim is not statistically supported yet**
  at matched coverage.

---

## 11. Datasets

| Dataset | Size | Used for |
|---|---|---|
| APTOS 2019 | 3,662 images, 5-class DR grade | Branch A classifier training |
| IDRiD | 81 (segmentation) + 516 (grading) + 516 (localization) | Segmentation, classification, localization, and the official held-out test evaluation |
| CHASE_DB1 | Standard vessel-segmentation set | Vessel segmentation training |
| Messidor-2 | ~1,748 images | Model selection across classifier candidates; external generalization check |

Only public datasets are used anywhere in this system — no real patient data, per project policy.

---

## 12. Where to Look for More

- **Full ML numbers, with sources and reproduction commands:** `docs/ML_BENCHMARKS.md`
- **API request/response shapes:** `docs/api-contracts.md`
- **Setup and running the system:** `README.md`
- **Demo walkthrough (scene by scene):** `docs/DEMO_RUNBOOK.md`; condensed video script: `docs/DEMO_SCRIPT.md`
- **What's been fixed vs. what v4 still describes accurately:** `docs/STALE_CLAIMS_AUDIT.md`
- **Original design rationale, in full:** `docs/system-design-v4.md`
