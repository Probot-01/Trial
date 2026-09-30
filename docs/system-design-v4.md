# PS 26038 — Explainable AI for Diabetic Retinopathy Screening
## Master System Design Document — v4 (Locked)

**Team:** Tanuj (lead, ML), Saad (backend, MATLAB/Simulink), Kankshi, Parth, Vedant — "Game Of Codes"
**Solution name:** NetraSetu

This document defines the system: what it does, how its parts fit together, and why each design choice was made. It is not a status tracker. Current measured performance lives in §15; open risks and limitations live in §17; what's left to build lives in §16. Everywhere else, a description of a component is a description of the design, full stop. This revision is built on a full, evidence-based codebase scan (file:line citations, live behavioral tests, git history) that resolved every open question from the previous pass, including two direct contradictions between earlier audits, and now formally brings the mobile app into scope as a second front-end.

---

## 0. Changelog vs. v3

v4 restructures and extends v3 using national-round research, multiple full codebase scans, and teammate findings. Resolved: Simulink and SMS are both confirmed real, built, and live; confidence routing is confirmed consolidated into one real decision point with camera-mismatch and quality-forced overrides genuinely wired in; Branch A now runs live in MATLAB by default via a verified ONNX import path. Corrected: a metric previously attributed to the neovascularization score actually belongs to the classifier's own grade-4 recall; the vessel model's earlier "domain shift" diagnosis was wrong (an annotation-convention mismatch, not a model failure); the bright-lesion model only ever detected hard exudates, with soft-exudate detection now an explicit, disclosed scope exclusion. New: class-conditional ordinal conformal prediction, a per-site/per-camera trust-earning period, a unified clinical-rationale report as a real PDF artifact, a stated scope-extension rationale, a full Resilience & Edge-Case Handling section (extended outages, ungradable images, duplicate patients, per-eye capture, failed patient contact, collision-safe identity, idempotent ingestion, active system-health monitoring, concurrent-review claiming, mandatory resolution on branch disagreement, patient consent capture), and an explicit statement that this round's MATLAB architecture does not solve unlicensed rural PHC deployment (§3, §17). **New this revision:** the Expo mobile app, previously an unauthorized parallel effort pointed at an external inference service, is formally brought into scope as a second front-end for the same PHC technician workflow — see §1.21, §4.4.

---

## 1. Ideation & Design Rationale

### 1.1 The Problem, Restated
India has ~1 ophthalmologist per 100,000 rural people, and diabetic retinopathy (DR) affects ~18% of the country's 77M+ diabetic adults. Early screening prevents 90% of DR-related blindness, but there aren't enough specialists to manually screen at population scale. The task isn't "build an AI that detects DR" — it's "let a non-specialist technician at a Primary Health Centre (PHC) do what only a specialist could do before, and let that specialist trust and act on the AI's output in seconds, not minutes." Every design choice below traces back to that sentence.

### 1.2 Why the Edge/Cloud Split Looks the Way It Does
Rural PHCs have unreliable or absent internet and modest computers. The PS's accuracy bar (>90% sensitivity, sub-pixel microaneurysm detection) is hard enough to hit with a *full-capacity* model — compressing it to survive on modest edge hardware risks losing exactly the accuracy the PS grades on. The only thing that genuinely benefits from running locally is the image-quality check, because a technician needs an instant retake decision before the patient leaves the chair. So: **local does quality gating and nothing else; central does all grading.** This applies identically regardless of which local front-end a technician is using (§4.4).

### 1.3 Why Capture Uses a Dedicated Fundus Camera, and Why Nothing Talks to an Outside Service
The team standardized on a dedicated fundus camera as the only way a fundus image enters this system. A phone's own camera cannot produce a usable fundus photograph on its own — photographing a retina needs purpose-built optics to see through the pupil, which is an optical limitation, not a software one — so no front-end offers a live phone-camera capture path (§1.21). This keeps the image source trustworthy regardless of which front-end a technician is using, and keeps every prediction traceable to the one grading pipeline this document defines (§3, §6) — a second, undocumented path to a diagnosis-shaped output would undermine every safety property built into that pipeline (dual-branch checking, calibration, human confirmation). **This is a hard rule, not aspirational**: an earlier, unauthorized version of the mobile app, and a live shortcut inside the desktop app's own capture screen, both pointed at an external, unversioned inference endpoint with none of this system's safety properties. Neither is acceptable in any form, in either app — the mobile app now brought into scope (§4.4) is a full rebuild against this system's own backend, not a continuation of that earlier version's behavior.

### 1.4 Why Connectivity Handling Looks the Way It Does
Offline-first isn't a nice-to-have — it's the difference between the system working at a real rural PHC or not. The local app always stores locally first, then transmits opportunistically: immediately and in real time if the network is up, or queued (chunked if bandwidth is poor) if it isn't. Patient communication follows the same logic: in-person if the technician can give an answer before the patient leaves; SMS if not. §10 extends this principle to outages measured in days, not minutes.

### 1.5 Why a DR-Positive Result Always Waits for Ophthalmologist Confirmation
The AI never gets to directly tell a patient they have a disease. Every "probably have DR" outcome — real-time or delayed — is confirmed by an ophthalmologist before it becomes an SMS. This is both a safety requirement and the definition of the human-in-the-loop workflow the PS asks for.

### 1.6 Why the District Admin View Is Aggregate-First
An admin managing a whole district needs to know where the system is backed up and where resources should move, not a push per patient. Individual case detail is one click away, not the default view. The one deliberate exception is §10.1's PHC-offline alert and §1.17's broader system-health surfacing.

### 1.7 Why the Symptom/Risk Questionnaire Is a Helper, Not a Diagnostic Input
Early DR is very often symptomless — that's the entire reason population screening exists. Known DR *risk factors* (diabetes duration, glycemic control, blood pressure) are more predictive than symptoms, so the combined form captures both, but it only ever nudges the image model's confidence — it never overrides what the image shows. No dataset given by SIH links patient history to outcomes, so this is a transparent, clinically-referenced scoring layer, not a trained model.

### 1.8 Why "Continual Learning," Not "Reinforcement Learning"
An ophthalmologist flagging a false positive with a reason, and the model retraining on that correction, is supervised correction over time — not an agent learning through reward signals. Calling it reinforcement learning would collapse under a technically literate question. A validation gate — a newly retrained model cannot replace the live one unless it holds up on a held-out test set — is a safety requirement, not a suggestion.

### 1.9 Why the Non-ML Features Exist
Each one closes a gap that shows up in real screening programs: referral loss-to-follow-up, camp/batch screening matching how outreach actually happens in India, ASHA worker handoff plugging into an existing community health workforce, camera-source tagging costing nothing now and paying off the moment a second camera model enters the field.

### 1.10 Why There's a Second, Separate Questionnaire — Capture Metadata, Not Patient Health
The patient symptom/risk questionnaire (§1.7) is about the patient's health. It has nothing to do with whether the photo itself is technically good. A second, separate structured form — filled in by the technician about the capture (device, pupil dilation, lighting, anything they noticed, their own rough usability read) — gives the quality gate and the central camera-calibration step a human-observed cross-check that pixel analysis alone never has.

### 1.11 Why Grading Has Two Independent Branches, Not Just One Classifier
A single CNN can't explain *why* it might be wrong on a given image, and it can't be audited against the exact clinical criteria an ophthalmologist trained on. Running an explicit rule engine alongside the CNN gives a second, independent opinion. When they agree, that's real evidence the grade is right. When they disagree, that's a safety signal, not noise to average away — the case gets mandatory review, and per §10.9, that review must end in an explicit grade choice, not a pass-through confirm. This is also the reason branch disagreement is one of the hard, unconditional inputs to the confidence-routing decision in §6.8, not a soft signal among several.

### 1.12 Why Neovascularization Gets a Suspicion Score, Not a Segmentation Claim
Neovascularization defines the most severe DR stage and has the least public pixel-level training data of any lesion type here. Claiming a validated segmentation result for it would be a claim the available datasets can't support. Instead, the system computes a proxy suspicion score from vessel-pattern features — density, branching complexity, and localized tortuosity in the disc-proximal region (§6.6) — and treats a CNN-predicted grade-4 as an independent trigger for mandatory review regardless of what the suspicion score says. Both signals stay labeled for what they are: a suspicion, not a confirmed finding.

### 1.13 Why This Project Reports What It Hasn't Proven, Not Just What It Has
A screening system built for clinical deployment is judged on whether its stated results can be trusted, not just on how good the results look. Every validation result this project produces distinguishes a measured number from an unmeasured one, and every number that later turns out to have been measured on the wrong split, or attributed to the wrong component, gets corrected in place rather than quietly dropped.

### 1.14 Why Every Uncertainty Signal Feeds One Routing Decision, Not Four Separate Checks
A camera the system doesn't recognize, a capture the technician flagged as borderline, and a case where the two grading branches disagree are all the same kind of fact: a reason not to trust this particular prediction as much as usual. Treating them as separate mechanisms bolted onto the pipeline means multiple places a signal could be silently dropped, and inconsistent definitions of "how much do we trust this case." So every uncertainty signal in this system feeds one routing decision that produces one tier per case. Any new uncertainty signal the team adds in future should be wired into that same decision point, not given its own separate side-channel — this project has already once let two override conditions sit fully specified in intent and completely unwired in practice, discovered only by a targeted behavioral test rather than by reading the design doc. That failure mode is exactly what this principle exists to prevent going forward.

### 1.15 Why Long Outages Are a Designed Scenario, Not a Failure Mode
A PHC losing connectivity for a few hours is the normal case this system was always built around. A PHC losing connectivity for several days — a real possibility in rural India — is different: local storage can fill up, the district has no visibility into a site gone silent, and a patient with a genuinely urgent finding could sit unprocessed for a week with no safety net. §10 specs this as a scenario the system degrades gracefully through, not an edge case worth a disclaimer.

### 1.16 Why the System Only Grades One Disease, On Purpose
Some other screening efforts aim for broad retinal-disease coverage from one fundus photo. This system deliberately doesn't, for the same reason it doesn't claim NV segmentation (§1.12): a claim is only as good as the validation behind it, and every dataset this system trains and validates against is DR-specific. Segmentation and rule-engine logic are separated from the orchestration layer specifically so a new lesion type or disease's rule set could be added as another module feeding the same confidence-routing and explainability pipeline later — a stated extension point, not a build target for this round.

### 1.17 Why Silence Gets Escalated, Everywhere It Can Hide
A PHC that's gone quiet for days, a grading job stuck mid-pipeline because the process that was handling it restarted, a MATLAB inference session that died and nobody noticed, and a referable case sitting in the review queue for three days unread are four different failures with the exact same shape: something that should be moving has stopped, and nothing is watching for that specifically. A dashboard that shows correct numbers only when someone remembers to look at it isn't actually monitoring anything. So each of these gets an active check with a real threshold, not a passive number sitting on a screen — see §10.7 for the concrete specification, which handles all four cases the same way rather than as four unrelated features.

### 1.18 Why Patient Identity and Case Submission Are Built to Survive Retries and Resets
A rural PHC's local device can be reset, reinstalled, or simply have its storage wiped between deployments — and a flaky network connection means the same upload can genuinely be attempted more than once. A naive incrementing patient-ID counter can regenerate an ID that's already in use centrally after a reset, silently merging two unrelated patients' records — a real patient-safety issue, not a cosmetic one. And a retried upload of the same capture can create a second, duplicate case and a second, wasted grading run if nothing recognizes it as the same submission. Both get solved the same way identity problems always get solved: give every submission an identity that's safe against being generated twice, rather than trying to detect and clean up collisions after the fact. See §10.6 — and, since it now applies to two independently-built front-ends rather than one, §4.4 states plainly that both must use the exact same scheme, not two that happen to look similar.

### 1.19 Why Consent Is Captured, Not Assumed
This system collects and processes a patient's retinal image and health information through an AI pipeline before a specialist ever sees it. That's exactly the kind of processing India's DPDP Act treats as requiring informed consent, and a system that's already built a security and audit-logging story (§11.1) shouldn't leave consent as the one privacy-relevant step with no record at all. Given the realities of a rural PHC — variable literacy, no digital-signature infrastructure, a technician who needs this to take seconds, not minutes — a verbal-consent confirmation with a timestamp is the honest, achievable version of this, not a full consent-management system. See §9.7.

### 1.20 Why This Round's MATLAB Architecture Has an Honest Ceiling
Branch A now runs live in MATLAB, on a persistent session, by default — a real and verified capability, not a demo trick. But that capability assumes a MATLAB license on whatever machine is running inference, which is true of the demo machine and not true of an actual unlicensed rural PHC. Solving that requires packaging with MATLAB Compiler and the free MATLAB Runtime — a distinct, unstarted step, not a byproduct of anything built this round. This is stated here, plainly, so the answer to "how does this run in the field without a MATLAB seat" is something the team says on purpose, not something a judge discovers by asking. See §3 and §17.

### 1.21 Why the Mobile App Captures Nothing New, and Imports From the Same Camera Instead
A phone's bare camera cannot take a usable fundus photograph — that's an optical limitation, not something a bigger model or better software fixes, since photographing a retina needs purpose-built optics to see through the pupil. A clip-on lens attachment could solve this properly, but it's a physical product that needs sourcing and testing against this system's own camera-family calibration work (§6.3), and that isn't happening this round. So the mobile app's scope is exactly what's actually buildable now: the same dedicated fundus camera captures the image precisely as it does in the desktop flow, and the mobile app takes over everything from there — registration, questionnaires, sync, and results — via a gallery import of that same image onto the phone. This makes the mobile app a second front-end onto one unchanged, trusted capture method, not a second capture method competing with it. A phone-plus-lens-attachment path stays a stated future extension (§18), not a build target now.

### 1.22 Why a Failure Never Gets to Look Like a Success
A network failure, a timeout, and a working result all need to be told apart by whoever's looking at the screen — a technician who sees a normal-looking result has no way to know it was fabricated rather than earned, and a patient told "you're fine" on the strength of a silently-substituted fake result is a worse outcome than the app plainly saying "something went wrong, try again." This system already applies this principle once, explicitly, for the local quality gate's own metric display (§4.1) — this states it as a system-wide rule rather than one screen's convention: any front-end, encountering any failure, either surfaces the failure to whoever's using it or genuinely queues the attempt for retry. It never substitutes a plausible-looking result for one that didn't actually happen. An earlier version of the mobile app violated exactly this principle — any network error, timeout, or non-success response fell back to showing a normal-looking result anyway — and that behavior does not carry forward into the rebuilt version (§4.4).

---

## 2. Actors & Personas

| Actor | Role | Touches |
|---|---|---|
| PHC Technician | Non-medical, minimally trained | The local PHC application — either front-end (§4.4) |
| Patient | Never touches software | Receives in-person message and/or SMS; gives verbal consent recorded at registration (§9.7) |
| Ophthalmologist | Remote specialist | Central website — ophthalmologist interface |
| District Health Administrator | Never reviews individual images | Central website — admin interface, including system-health alerts (§10.7) |
| ASHA / Community Health Worker | Referral follow-up, including cases where SMS contact failed (§10.5) | Referred-case status, via admin interface hand-off |

---

## 3. High-Level Architecture

![Pipeline layers](diagram_pipeline_layers.svg)

![PHC and central system architecture](diagram_phc_central_architecture.svg)

**Where MATLAB lives:** the PS's MATLAB/toolbox requirement applies to the image-analysis and modeling code — quality gate, preprocessing, camera calibration, segmentation, the rule engine, calibration math, explainability, and the Simulink resource model. It does not mean the UI, database, or API layer must be MATLAB. Branch A (the CNN classifier) runs as a trained network imported into MATLAB via ONNX — trained in PyTorch, then exported and imported so the actual inference call happens inside MATLAB's Deep Learning Toolbox, served by a persistent MATLAB session the backend calls into per case. The explicit ICDR rule engine (§6.7) is plain, testable MATLAB code with no toolbox dependency, which keeps it easy to unit-test directly against the clinical rule text.

**Two front-ends implement the Local PHC Application spec in §4**: a desktop web app and an Expo-based mobile app (§4.4). Both talk to the same central backend through the exact same API contract (§5.6) — neither has, or is permitted to have, its own separate backend, response shape, or capture-time inference call (§1.3).

**This does not solve rural deployment, and that gap is stated here on purpose.** The persistent MATLAB session that serves Branch A requires a MATLAB license and the Deep Learning Toolbox on whatever machine runs it — fine for a demo machine, not true of an actual unlicensed rural PHC. The local quality gate solves this exact problem for itself via MATLAB Compiler and the free MATLAB Runtime (§4.2) — the same packaging approach would need to be applied to the central inference path before this system could run centrally without a MATLAB seat, and that packaging work has not been done this round. Say this plainly if asked; don't let a working demo imply it's already solved.

**No external inference services.** Neither local front-end talks to anything but this system's own backend. Nothing in this system calls an external, undocumented, or ngrok-tunneled endpoint for any grading, quality, or severity output (§1.3).

**Modularity for future scope (§1.16):** segmentation models, the rule engine, and the confidence-routing/explainability layer are three distinct stages with a defined interface between them (lesion counts and coordinates in; a grade, a tier, and a rationale report out). A future pathology or lesion type is added as a new segmentation module and a new rule-engine branch feeding the same downstream interface.

---

## 4. Local PHC Application — Full Spec

### 4.1 Frontend Components

| Screen | Components |
|---|---|
| Patient Lookup / Registration | ID/search field; new-patient form (name, age, contact number — required on every front-end, the only channel for delayed/offline results); a verbal-consent confirmation the technician checks before capture proceeds, timestamped (§9.7). On submission, checks the new entry against existing local records by name, age, and phone number (fuzzy-matched) and flags likely duplicates for the technician to confirm or merge before a new patient ID is created (§10.3). Patient IDs are generated with enough entropy (PHC code + timestamp + random suffix, not a simple incrementing counter) so a reset or reinstalled device can never regenerate an ID already in use centrally (§10.6) — and generated the same way on every front-end (§4.4). |
| Capture | On the desktop app: camera trigger, live/last-capture preview, "Retake" and "Accept" actions, talking only to the Capture Handler (§4.2). On the mobile app: a gallery-import step for an image already captured by the same dedicated fundus camera (§1.21, §4.4) — no live-capture path on either front-end offers a phone's own camera as the image source. Every capture is tagged left or right eye (§10.4). Neither front-end displays a severity or diagnostic result before central grading has happened (§1.3). |
| Quality Result | Pass/fail badge with a specific reason (blur / dark / off-centre / poor field of view / glare / motion artifact / eyelash occlusion / poor color balance / excessive border), and a retake button. A real quality metric is always shown when one exists; when it doesn't, the screen says "not available" — never a fabricated-looking number, and never, on any front-end, a fabricated-looking result of any kind in place of a genuine failure (§1.22). After a fixed number of failed retakes (default 3), the technician can mark the capture "best effort — proceed as ungradable" instead of retrying indefinitely (§10.2). |
| Patient Questionnaire (symptom + risk, combined form) | Structured fields — §9.1 — regional-language labels, toggle/dropdown, no free text, no skip option on any front-end. |
| Capture Metadata Questionnaire | Structured fields — §9.6 — tap-only, under 45 seconds, present on every front-end. |
| Local Queue | Table of today's patients, tracking each capture through Captured / Quality-Passed / Synced / Result-Pending / Result-Delivered. Surfaces a storage-pressure indicator as the local queue approaches capacity (§10.1). |
| Sync Status | Always-visible online/offline indicator and a count of items pending upload, with "synced" meaning the same thing on every front-end: the central backend has actually accepted the case, not merely that some remote call returned successfully (§4.4). |

### 4.2 Local Backend / Services

| Service | Responsibility |
|---|---|
| Capture Handler | On the desktop app, interfaces with the fundus camera directly. On the mobile app, this role is the gallery-import step (§4.4). Either way, the resulting image is tagged by eye before anything else touches it. |
| Quality-Gate Engine | On the desktop app, MATLAB-built, packaged via MATLAB Compiler + MATLAB Runtime so no MATLAB license is required on the PHC machine — this is the exact packaging pattern that hasn't yet been applied to the central inference path (§1.20, §3). Runs through a three-tier fallback (compiled exe → `matlab -batch` → a pure-JS reimplementation using the same logic), so the pipeline runs on a dev machine with no MATLAB license at all. **This fallback chain is a deliberate resilience and deployment-cost feature and stays exactly as-is.** That same pure-JS reimplementation — genuinely portable logic, not a Node-specific implementation — is what the mobile app runs as its own local quality gate (§4.4), so both front-ends apply identical quality-gate rules without maintaining two independently-drifting copies of them (§6.2). |
| Local API | Small internal service wrapping Capture Handler and Quality-Gate Engine, reading/writing the Local DB. |
| Sync Manager | Prioritizes the sync queue by urgency tier first, then age. Sends a lightweight case-summary packet ahead of the full image whenever connectivity is thin (§10.1). Full images transfer via chunked, resumable upload. Every submission — summary or full — carries the local `capture_id` as an idempotency key, so a retried upload never creates a second case or a second grading run centrally (§10.6). Includes a manual "export queue to external drive" utility as a fallback for outages severe enough that even intermittent connectivity isn't available. Implemented identically in contract and behavior on both front-ends, even though the underlying storage technology differs (§4.4). |

### 4.3 Local Database Schema (SQLite, or an equivalent structured embedded store on mobile — §4.4)

**patients**
| Field | Type | Notes |
|---|---|---|
| patient_id | TEXT (PK) | Generated as PHC code + timestamp + random suffix — collision-safe against device resets (§10.6), not a simple counter, and identical across front-ends |
| name | TEXT | |
| age | INTEGER | |
| contact_number | TEXT | Required |
| consent_given_at | DATETIME | Verbal consent confirmation timestamp (§9.7) |
| duplicate_of | TEXT | Nullable FK → patients; set when a technician confirms a merge (§10.3) |
| registered_at | DATETIME | |

**captures**
| Field | Type | Notes |
|---|---|---|
| capture_id | TEXT (PK) | Also serves as the idempotency key for central ingestion (§10.6) |
| patient_id | TEXT (FK → patients) | |
| eye | TEXT | left / right |
| camera_device_id | TEXT | The dedicated fundus camera that produced the image, regardless of which front-end is submitting it (§6.3) |
| image_path | TEXT | |
| quality_status | TEXT | pass / retake / borderline-enhanced / ungradable |
| quality_reason | TEXT | Nullable |
| retake_count | INTEGER | |
| captured_at | DATETIME | |

**questionnaire_responses**, **capture_metadata_responses**, **sync_queue** — as previously specified, with `sync_queue.priority` derived from urgency tier plus age rather than fixed at creation, and a structure that supports per-record queries and updates on every front-end (§4.4) rather than one serialized blob.

### 4.4 Two Front-Ends, One Spec — the Mobile App

The Expo mobile app is a second implementation of this section's spec, for the same PHC technicians, not a separate workflow. It differs from the desktop app in exactly one respect: how the image arrives on the device that's about to submit it — everything after that point is the same spec, met the same way.

**Capture is gallery import, not a phone camera.** The dedicated fundus camera captures the image exactly as it does in the desktop flow (§1.21); the technician transfers that image onto the phone by whatever means the camera supports, and imports it into the app from the gallery. The mobile app does not offer its own live-capture path.

**The local quality gate still runs before the questionnaires, on-device, same as desktop.** MATLAB Compiler's Runtime doesn't run inside an Expo app, but the desktop app's own JS-only fallback tier (§4.2) is portable logic and is reused as the mobile app's local quality check — one rule set, ported, not reinvented.

**Local persistence is a structured, per-record store, not one serialized blob.** A single object holding the entire queue is fine at a handful of pending cases; under an extended outage (§10.1) with dozens or hundreds queued, rewriting the whole thing on every change is slow and fragile in exactly the scenario this system is designed to handle gracefully. The mobile app uses a real embedded database (e.g. `expo-sqlite`), giving it the same guarantees the desktop app's SQLite already provides — per-record queries, safe partial writes, genuine support for urgency-and-age sync ordering, and a real storage-pressure warning, not a JS array sorted in memory after being loaded whole.

**Identity uses the one shared scheme, not a second one that happens to look similar.** Patient and capture IDs are generated by the exact same format (§10.6) the desktop app already implements, ideally from the same shared module rather than two independent reimplementations that could quietly drift apart. A mobile-specific ID prefix or encoding is exactly the kind of divergence that silently breaks central-side validation.

**Both questionnaires apply in full, on both front-ends.** The patient symptom/risk questionnaire (§9.1) has no skip option on either front-end — a nudge signal that can always be skipped stops being a reliable signal. The capture-metadata questionnaire (§9.6) applies exactly as written to a gallery-imported image as to a directly-captured one; its camera-device field records which dedicated camera produced the source image, same meaning as on desktop.

**Contact number is required, not optional**, matching the central schema's own constraint on both front-ends.

**Sync status means the same thing everywhere it's shown**: a case is "synced" once the central backend has actually accepted it, never merely once some remote call has returned successfully. Neither front-end is allowed its own private definition of that word.

**A design pattern worth carrying forward regardless of which front-end it originates from:** representing each queued case as one object with an explicit sync-state field, with pending/processing/synced views derived from that one collection rather than re-queried from raw storage each time, is a cleaner queue abstraction than reading raw local-database rows directly into a table view. Both front-ends' local queue implementations should converge toward this pattern over time.

---

## 5. Central System — Full Spec

### 5.1 Shared Website Shell & Auth
One website, role-based routing (`ophthalmologist`, `district_admin`). Access requires a real login, checked against a stored credential hash; every endpoint enforces the caller's role server-side, not just in frontend routing. See §11.1 — this is currently the single most urgent gap in the whole system and is treated as such throughout this document.

### 5.2 Ophthalmologist Interface — Frontend Components

| Screen | Components |
|---|---|
| Review Queue | Sorted by priority: referable, high-uncertainty, and branch-disagreement cases first. Each row: patient reference, eye, PHC, capture time, predicted grade(s), confidence tier, and whether the case is currently claimed by another reviewer (§10.8). |
| Case Detail | The fundus image with an in-place, toggleable Grad-CAM overlay restricted to the retinal ROI; a four-category lesion-evidence panel; both grading branches shown side by side with a clear disagreement flag when they differ; the calibrated confidence and conformal tier; questionnaire summaries shown alongside, not blended into, the image evidence; and the unified clinical-rationale report (§6.9), generated as a downloadable PDF. An open-to-decision timer runs automatically, recording real review duration for every case. |
| Decision Controls | Opening a case claims it for review (§10.8) — a second reviewer sees who holds it and cannot submit a conflicting decision while it's claimed. Confirm, or Override with a structured reason category plus optional free text and a captured corrected grade. **When the two branches disagree, "Confirm" alone is not an available action** — the reviewer must explicitly select which grade they're finalizing, so a disagreement always produces a recorded, deliberate resolution rather than a pass-through (§10.9). Reviewer identity comes from the authenticated session (§5.1). |
| Case History | A per-patient longitudinal view — a grade-over-time trend strip across visits, per eye — distinct from the system-level access log (§11.1). |

### 5.3 District Admin Interface — Frontend Components

| Screen | Components |
|---|---|
| Dashboard | Patients screened per PHC per day/week, average review turnaround. |
| System Health | One consolidated alert view: PHC sites gone silent past threshold, grading jobs stuck past threshold, the MATLAB inference session's own health, and referable cases sitting unreviewed past threshold (§10.7, §1.17) — one place, not four separate places to remember to check. |
| Referral Tracker | referred → contacted → attended / lost, an assigned-worker field, and a manual-follow-up state that a failed SMS delivery routes into automatically (§10.5). |
| Resource Recommendations | Plain-language staffing and routing guidance sourced from the Simulink resource model (§7), refreshed on a periodic run. |

### 5.4 Central Backend Services

| Service | Responsibility |
|---|---|
| Ingestion API | Receives image + patient questionnaire + capture-metadata questionnaire from either front-end, deduplicating on `capture_id` (§10.6) so a retried upload never creates a duplicate case or grading run. |
| Grading Pipeline Orchestrator | Runs, in sequence: preprocessing → camera-fingerprint calibration → segmentation (optic disc/fovea, vessels, four lesion categories, NV suspicion) → dual-branch grading → the confidence-routing decision (§6.8) → the clinical-rationale report. |
| Referral & Notification Service | Routes referable/uncertain/disagreement cases to the ophthalmologist queue; triggers SMS via Twilio once a decision is finalized; on delivery failure, flips the referral to the manual-follow-up state (§10.5). |
| Continual Learning Service | Consumes override reasons and corrected grades (already persisted as part of the review transaction — §5.5), runs scheduled retraining against original data plus weighted corrections, enforces the validation gate before any promotion. **This round: capture + export only (§6.11) — retraining is a manual, future-round step, not a running service.** |
| Admin Analytics Aggregator | Computes dashboard metrics, aggregate-only with no per-case push; tracks per-PHC last-contact time for the System Health view. |
| Simulink Integration | Runs the resource-allocation simulation on a schedule and writes the current recommendation for the admin dashboard to read (§7). |
| Grading Job Watchdog | Continuously — not only at server restart — scans for cases stuck mid-pipeline past a timeout and re-enqueues or escalates them to System Health (§10.7). |
| MATLAB Session Supervisor | Monitors the persistent MATLAB session Branch A depends on; restarts it automatically if it dies, and raises a System Health alert if a restart attempt fails (§10.7). |
| Auth Service | Issues and verifies session credentials; enforces role checks on every endpoint (§11.1). |
| Audit Logging | Records every access to patient data — who, what, when (§11.1). |
| Site & Camera Probation Tracking | Tracks how long a given PHC site or camera family has been in service and whether its early cases have been validated against the existing calibration baseline, gating eligibility for Tier-A auto-clear (§6.3). |

### 5.5 Central Database Schema (PostgreSQL)

**patients** — mirrors local patient records, including `consent_given_at` and the collision-safe `patient_id` (§10.6), regardless of which front-end registered the patient.

**cases**
| Field | Type | Notes |
|---|---|---|
| case_id | UUID (PK) | |
| patient_id | UUID (FK) | |
| eye | TEXT | left / right |
| phc_id | UUID (FK → phc_sites) | |
| capture_id_ref | TEXT | The local `capture_id` — unique-constrained here so a retried submission is rejected or merged rather than duplicated (§10.6) |
| camera_device_id | TEXT | Worker-reported |
| camera_family_detected | TEXT | From image-based classification, compared against camera_device_id |
| image_path | TEXT | Nullable until the full image arrives, if a summary-only packet was received first |
| questionnaire_data | JSON | |
| capture_metadata | JSON | |
| received_at | DATETIME | |

**grading_results**
| Field | Type | Notes |
|---|---|---|
| result_id | UUID (PK) | |
| case_id | UUID (FK) | |
| dr_grade_cnn | INTEGER | Branch A output, 0–4 |
| dr_grade_rule_engine | INTEGER | Branch B output, 0–4 |
| branch_agreement | BOOLEAN | False triggers mandatory review and mandatory explicit resolution (§10.9) |
| referable | BOOLEAN | Derived: either branch's grade ≥ 2, or the grade-3/grade-4 probability-sum safety check (§6.7) fires |
| confidence_score | FLOAT | Post-calibration, CNN branch |
| uncertainty_score | FLOAT | From MC Dropout variance |
| conformal_tier | TEXT | A / B / C, computed by the one confidence-routing decision (§6.8) |
| claimed_by | UUID (FK → users) | Nullable; set when a reviewer opens the case (§10.8) |
| model_version | TEXT (FK → model_versions) | |
| graded_at | DATETIME | |

**segmentation_outputs**
| Field | Type | Notes |
|---|---|---|
| case_id | UUID (FK) | |
| lesion_masks_path | TEXT | |
| lesion_counts | JSON | Four independent categories: microaneurysms, hemorrhages, hard_exudates — a genuine, separately-trained category, not a post-hoc split of a fused mask (§6.6) — and soft_exudates, explicitly and permanently null this round (§6.6) |
| nv_suspicion_score | FLOAT | Nullable until a validated computation is wired into the live path (§6.6); never treated as a confirmed finding |
| vessel_map_path | TEXT | |
| optic_disc_coords | POINT | |
| fovea_coords | POINT | |
| fovea_unreliable | BOOLEAN | Set by the fovea peak-confidence gate (§6.4); true forces mandatory review and skips quadrant-axis-dependent rule-engine logic |

**explainability_outputs**
| Field | Type | Notes |
|---|---|---|
| case_id | UUID (FK) | |
| gradcam_path | TEXT | |
| lesion_attention_consistency_score | FLOAT | |
| rationale_report_path | TEXT | The unified clinical-rationale report, generated as a PDF (§6.9) |
| review_duration_seconds | INTEGER | |

**ophthalmologist_reviews** — decision, override reason category and text, corrected grade, review duration. This table, together with **corrections** (linking a review to the case for the continual-learning consumer), is the real feedback-persistence mechanism.

**referrals**, **notifications**, **model_versions**, **phc_sites** (including `last_contact_at` for System Health), **users** (credential hash, role) — as previously specified.

**access_log**
| Field | Type | Notes |
|---|---|---|
| log_id | UUID (PK) | |
| user_id | UUID (FK → users) | |
| action | TEXT | e.g. view_case, modify_review, login |
| resource_type | TEXT | |
| resource_id | UUID | |
| timestamp | DATETIME | |

### 5.6 API Endpoints (Local ↔ Central)

One contract, consumed identically by both local front-ends (§4.4) — neither has its own shape.

| Method & Path | Purpose |
|---|---|
| POST /api/v1/auth/login | Authenticate and issue a session |
| POST /api/v1/cases | Submit a new case, deduplicated on capture_id (§10.6) |
| POST /api/v1/cases/summary | Submit a lightweight case-summary packet ahead of the full image |
| POST /api/v1/cases/{case_id}/chunks | Chunked image upload |
| GET /api/v1/cases/{case_id}/status | Poll processing status |
| POST /api/v1/cases/{case_id}/claim | Claim a case for review; fails if already claimed by another active reviewer (§10.8) |
| GET /api/v1/ophthalmologist/queue | Fetch review queue |
| POST /api/v1/cases/{case_id}/review | Submit confirm/override + reason; rejects "confirm" alone on a disagreement case (§10.9) |
| GET /api/v1/cases/{case_id}/reviews | Per-case review history |
| GET /api/v1/patients/search | Fuzzy name/age/phone lookup for duplicate detection at registration (§10.3) |
| GET /api/v1/admin/dashboard | Aggregate stats |
| GET /api/v1/admin/system-health | PHC-offline, stuck-job, MATLAB-session, and unreviewed-case alerts, consolidated (§10.7) |
| GET /api/v1/admin/referrals | Referral tracker list |
| PATCH /api/v1/referrals/{referral_id} | Update referral status |
| GET /api/v1/phc/{phc_id}/sync-status | PHC sync health |
| GET /api/v1/admin/resource-recommendations | Serves the Simulink Integration service's periodic output |

---

## 6. ML Layer — Full Pipeline Spec

### 6.1 Image Quality Assessment — runs locally, on either front-end
Classical CV heuristics across nine factors: focus/blur, illumination uniformity, contrast, field-of-view completeness, glare, motion artifact, eyelash/eyelid occlusion, color balance, excessive black-border proportion. Selects a per-camera-family preset using the worker-reported device field. Implemented once as MATLAB (desktop's primary path) and once as an equivalent JS reimplementation (desktop's fallback tier and the mobile app's only local path, §4.4) — the two are required to agree, not merely resemble each other (§6.2).

### 6.2 Preprocessing & Enhancement — runs centrally
CLAHE (per-camera-family parameters), illumination normalization, denoising, Ben Graham-style circular-crop preprocessing — implemented exactly once, and that single implementation is what both trains and serves the classifier. This system does not maintain a second, independent preprocessing implementation expected to agree with the first: a MATLAB port of this exact chain once introduced a residual small enough to be invisible on synthetic test tensors and large enough to flip real grades and tiers on real images — the port was removed rather than reconciled. Whichever inference backend runs Branch A (§3), it receives an already-preprocessed tensor from this one implementation and only performs the forward pass.

### 6.3 Camera-Fingerprint Calibration — runs centrally
Identifies the capture device family from vignetting shape, aspect ratio, and colour-channel gain ratios, cross-checked against the worker-reported device field. Maintains a calibration profile bank of per-family correction parameters. This component has two jobs, not one: flagging a mismatch between the reported and detected camera family (feeding the confidence-routing decision, §6.8, as a signal toward mandatory review rather than a pixel-level correction — the classifier isn't trained on corrected pixels, so correcting them blindly would introduce a worse distribution shift than the one being solved), and classifying which training domain a given image is closer to, so vessel segmentation (§6.5) can select the right threshold for that domain. This runs identically regardless of which front-end submitted the image, since the source is always the same dedicated camera (§1.21).

**New sites and new cameras earn trust rather than inheriting it.** The first batch of cases from a PHC site or a camera family not yet represented in the calibration baseline runs through mandatory Tier B/C review regardless of confidence, while its outcomes are compared against the existing calibration set. Once its performance holds up, the site or camera family graduates into normal tiering.

### 6.4 Optic Disc / Fovea Localization — runs centrally
A U-Net regressor localizes the optic disc and fovea. Optic-disc localization is highly reliable across the validation set. Fovea localization has a rare but consequential failure mode: on a small fraction of images, the confidence heatmap has no real peak and the location picked is effectively noise — since the ICDR quadrant convention is defined relative to the fovea-to-disc axis, this doesn't fail visibly, it silently rotates the quadrant axis and produces a wrong grade. A peak-confidence gate addresses this directly: below a fixed confidence threshold, the localization is marked `fovea_unreliable`, quadrant-dependent rule-engine logic falls back to the plain image-axis convention instead, and the case is routed to mandatory review rather than graded on a rotated axis.

### 6.5 Vessel Segmentation — runs centrally
A U-Net trained on CHASE_DB1, complemented by a Frangi vesselness filter. Segmentation performance on out-of-training-domain images is not a domain-shift weakness — it reflects that different annotation conventions mark vessel boundaries differently, not that the model generalizes poorly. The system accounts for this with a per-domain segmentation threshold, selected using camera-fingerprint calibration's domain classification (§6.3) rather than one fixed threshold applied everywhere. Vessel output feeds microaneurysm false-positive suppression, the neovascularization suspicion score, and the venous-beading/IRMA detectors (§6.6, §6.7).

### 6.6 Lesion Segmentation — runs centrally
Two separate models: a **red-lesion model**, producing a joint microaneurysm/hemorrhage output further separated into two independent counts using a dedicated 3-class training target (background/MA/HE) and a class-specific minimum-component-size filter — a much lower size floor for microaneurysms than for hemorrhages, since a large fraction of true microaneurysms are only a few pixels across and a filter tuned for hemorrhage-scale noise discards most of them by construction; and a **hard-exudate model**, which is what the "bright lesion" detector actually and only is. **Cotton-wool spots (soft exudates) are an explicit, disclosed scope exclusion this round** — the available pixel-level training data for this specific lesion type is too sparse to support a real detector.

**Standing rule, not a one-off fix:** the lesion-count minimum-size filter and the rule engine's severity thresholds (§6.7) are one coupled unit, calibrated together. A change to one without recalibrating the other silently rescales what the thresholds mean — any change to lesion-counting logic requires rule-engine recalibration as part of the same change.

**Neovascularization** is handled as a suspicion score, computed from vessel-segmentation output (§6.5) restricted to a ring around the optic disc and major arcades: local vessel density, branch/junction point counts, a simplified fractal-dimension or box-counting complexity score, and localized tortuosity/bifurcation irregularity within that ROI specifically, not global main-vessel tortuosity. The score is always labeled "possible proliferative pattern — urgent review," never "confirmed neovascularization," and complements rather than replaces the existing safety net of escalating any CNN-predicted grade-4 straight to mandatory review (§6.7).

### 6.7 DR Severity Classification — runs centrally, two independent branches

**Branch A — CNN holistic grading:** an EfficientNet-B0, transfer-learned with an ordinal-aware loss reflecting that grade confusions closer together on the severity scale are smaller errors than confusions farther apart, plus class-weighted/focal terms for severe-grade imbalance. Output: a 5-class distribution plus a derived referable/non-referable flag. **A dedicated safety check runs alongside the argmax grade**: if the combined probability of grade 3 and grade 4 exceeds 0.5, the case is marked referable regardless of what the single most likely grade was — this exists specifically because the most severe grade is also the hardest for the classifier to resolve at its current input resolution, and a near-miss on the top grade should not silently become a non-referral.

**Branch B — explicit ICDR/ETDRS rule engine:** plain, testable MATLAB code operating directly on the quadrant-mapped lesion counts and NV suspicion score from §6.6, and skipping quadrant-dependent logic entirely (falling back to the image-axis convention) whenever `fovea_unreliable` is set (§6.4). Applies the standard criteria: no DR = no lesions; mild NPDR = microaneurysms only; moderate NPDR = microaneurysms plus other lesions short of severe criteria; severe NPDR = the "4-2-1 rule" — extensive hemorrhages across all four quadrants, or venous beading (caliber variation along traced venous segments) in two or more quadrants, or prominent IRMA (the same fine-vessel-irregularity features as NV suspicion, scoped to intraretinal regions away from the disc/arcades) in at least one quadrant; proliferative DR = the neovascularization suspicion flag present.

**Fusion:** when Branch A and Branch B agree, that agreement is itself evidence supporting the confidence tier the case receives (§6.8). When they disagree, that's an unconditional trigger for mandatory review with a required explicit resolution (§10.9), regardless of either branch's confidence.

### 6.8 Confidence Routing — runs centrally
Every case's routing tier is the output of **one decision**, not several independent checks (§1.14). Its inputs:
- **Temperature-scaled classifier confidence.**
- **Monte Carlo Dropout uncertainty.**
- **Class-conditional (Mondrian) ordinal conformal prediction**, using a nonconformity score constructed to guarantee the returned prediction set is a contiguous interval of grades, with the calibration quantile computed separately per grade so the rarest, highest-stakes grades aren't swamped by far more common early-grade calibration examples.
- **Branch agreement** — a disagreement is an unconditional override.
- **Camera-family mismatch and site/camera probation status.**
- **Capture-quality flags**, including an ungradable capture and a `fovea_unreliable` localization.

These combine into one tier per case:

| Tier | Meaning | Consequence |
|---|---|---|
| Tier A — auto-clear | A singleton conformal prediction set, high calibrated confidence, branch agreement, no probation flag, no quality flag | Skips the ophthalmologist queue entirely |
| Tier B — AI-assisted review | A narrow conformal interval, or a single lower-confidence signal without an override condition | Reviewed with the full clinical-rationale report, target under 30 seconds |
| Tier C — full manual review | A wide conformal interval, branch disagreement, a CNN-predicted grade 4, an unresolved probation status, or a quality flag | Full manual grading, no shortcuts |

### 6.9 Explainability — runs centrally
Grad-CAM/Grad-CAM++ runs on the classifier's final convolutional layer, restricted to the retinal ROI, with heatmap energy outside the ROI discounted and explanations dominated by the optic disc flagged unless hard-exudate logic actually supports that. A lesion-attention consistency score measures overlap between Grad-CAM energy and the real lesion masks, and a counterfactual occlusion test validates that the heatmap is causally meaningful, not just visually plausible.

All of this, together with the four-category lesion evidence, which rule-engine criteria fired or didn't, and the conformal tier and what it means, is assembled into **one unified clinical-rationale report per case** — generated as a real PDF — not four disconnected widgets on a screen. A real open-to-decision timer records review duration automatically.

### 6.10 Symptom + Risk Fusion — runs centrally
Rule-based weighted scoring, using clinically-referenced weights for the risk factors and symptoms collected in §9.1, applied as a confidence adjustment after the image model's calibrated output — not a learned model, since no dataset currently links questionnaire data to outcomes (§1.7).

### 6.11 Continual Learning — runs centrally, periodic
Ophthalmologist overrides and their structured reasons are captured as part of the same transaction as the review decision (§5.5) and feed a scheduled fine-tuning job against original training data plus weighted/oversampled corrections. A newly retrained model is evaluated against a held-out validation set and only promoted if it holds up on sensitivity, specificity, and kappa.

**Status (2026-09-29):** the capture half of this is real and done — every override reason and corrected grade is written inside the review transaction (`dataset_labels`, migration 0013) and `scripts/exportTrainingSet.js` exports it with consent enforcement, dedupe, and newest-label-per-case. The scheduled fine-tuning job, validation gate, and promotion step described above are **not implemented this round** — corrections are captured and exportable; retraining is a manual, future-round step, run by hand from the exported set if and when there's time for another round. Not dormant, not unclear: this is the deliberate scope line for this submission.

---

## 7. Systems Layer — Simulink Resource Model

**Approach:** discrete-event simulation (SimEvents). Entities are patient images. The arrival process is the image acquisition rate per PHC. Network transmission is modeled as a bandwidth-constrained queue across good/poor/very-poor connectivity tiers. Ophthalmologist review is a limited-capacity server, roughly 30 seconds for a Tier B case and several minutes for Tier C, with Tier C entities pre-empting Tier B on the shared reviewer resource pool.

**Inputs:** acquisition rate per PHC, number of PHCs, bandwidth distribution, number of ophthalmologists. **Outputs:** queue length over time, average wait time, bottleneck location, a plain-language resource recommendation. **Execution:** runs on a schedule against current volume data, feeding the Admin Analytics Aggregator and the Resource Recommendations screen. Bandwidth and sync-timing parameters are modeled assumptions rather than measured field data (§17).

The model is a real, working SimEvents model, built as a script rather than hand-assembled in a GUI.

---

## 8. End-to-End Data Flows

### 8.1 Online Real-Time Flow
1. Technician registers the patient (verbal consent confirmed and timestamped; duplicate check runs automatically; patient ID generated collision-safely, identically on either front-end — §4.1, §4.4) and obtains the image via the dedicated fundus camera — captured directly on the desktop app, or captured by camera and imported from the gallery on mobile (§1.21) — tagged by eye.
2. Quality-Gate Engine runs locally, on either front-end. Retake needed → loop to step 1. Repeated failure past the retake limit → the ungradable path (§10.2). Pass/borderline-enhanced → proceed.
3. Technician completes both questionnaires.
4. Sync Manager transmits image + patient data + both questionnaires to the Ingestion API in real time, keyed by `capture_id` so a retried transmission is never processed twice (§10.6).
5. Grading Pipeline Orchestrator runs the full sequence (§5.4).
6. The confidence-routing tier and branch-agreement result together determine the path: Tier A with agreement auto-clears; Tier B/C or disagreement routes to the ophthalmologist queue.
7. Result returns to the PHC. Technician tells the patient in person.
8. Non-referable, no disagreement: case closes, no SMS.
9. Referable, disagreement, or ungradable-with-risk-factors: ophthalmologist claims the case (§10.8), reviews it, and — on disagreement — makes an explicit resolution rather than a bare confirm (§10.9) → on confirmation, SMS sent, with delivery failure routed to manual follow-up (§10.5).
10. Case data feeds the Admin Analytics Aggregator.

### 8.2 Offline / Delayed Flow
1–3. Same as above, on either front-end.
4. Sync Manager finds no network → stores locally. If connectivity is thin but present, sends the lightweight case-summary packet first; the full image follows via chunked, resumable transfer prioritized by urgency and age. If there is no connectivity at all, the case queues and, in an extended outage, can be manually exported (§10.1).
5–9 (relabeled). Same pipeline runs centrally once the full case is received. Because the patient has already left, the result is delivered by SMS.

### 8.3 Ophthalmologist Review & Override Flow
1. Case appears in the Review Queue, regardless of which front-end it originated from.
2. Ophthalmologist claims the case (§10.8) and opens Case Detail: image, Grad-CAM, lesion evidence, both grading branches with any disagreement flagged, conformal tier, questionnaire summaries, and the clinical-rationale report — with an automatic review-duration timer.
3. Confirm (only available when branches agree) → notification flow proceeds.
4. Override, or explicit resolution on a disagreement (§10.9) → structured reason + optional free text + corrected grade → recorded as part of the same transaction as the review → feeds Continual Learning.

### 8.4 Continual Learning & System Health Flow
1. Corrections accumulate from the review transaction.
2. The Grading Job Watchdog and MATLAB Session Supervisor run continuously, catching stuck jobs and a down inference session in real time (§10.7).
3. On schedule, retraining runs on original data plus weighted corrections; a new model version is evaluated and promoted only if it passes the validation gate.

### 8.5 Referral & Patient Communication Flow
1. A referable, disagreement, or confirmed-ungradable-with-risk-factors case creates a `referrals` row.
2. SMS fires at confirmation. Delivery failure flips the referral straight to the manual-follow-up state (§10.5).
3. Admin or an assigned ASHA worker updates status: contacted → attended, or lost.

### 8.6 District Admin Aggregation Flow
1. Admin Analytics Aggregator computes dashboard metrics.
2. Simulink Integration writes a periodic resource recommendation.
3. System Health surfaces any PHC, grading job, MATLAB session, or unreviewed case past its threshold as one consolidated alert (§10.7).
4. Admin opens the Referral Tracker for follow-up-gap visibility.

---

## 9. Non-ML Feature Specifications

### 9.1 Symptom + Risk Questionnaire (patient) — Field List
Years since diabetes diagnosis, glycemic control, blood pressure status, pregnancy status, and four symptom toggles (blurred vision, floaters, sudden vision change, eye pain). Structured fields only — no free text, no skip option, on either front-end.

### 9.2 Bandwidth-Aware Sync
Full data for referable/uncertain cases; a lightweight case-summary packet under poor connectivity for others. Chunked, resumable transfer.

### 9.3 Referral Loss-to-Follow-Up Tracking
Referred → contacted → attended, with a "lost" state, an optional ASHA/health-worker assignment, and a manual-follow-up state fed automatically by SMS delivery failures (§10.5).

### 9.4 Camera-Source Tagging & Calibration
Every capture is tagged with the dedicated fundus camera that produced it. This drives the local quality gate's preset selection, is cross-checked centrally (§6.3), and a mismatch feeds directly into confidence routing (§6.8).

### 9.5 Camp / Batch Screening Mode
A full day of captures queues locally and syncs in one batch when connectivity returns, using the same urgency-and-age-prioritized sync logic as any other outage. For a genuinely co-located camp event where several capture stations share one hotspot with variable per-device signal, one designated relay device accepts local uploads from the other stations over the existing shared network and forwards them onward — a scoped, single-relay version of local sharing, not a general inter-PHC mesh network.

### 9.6 Capture Metadata Questionnaire (about the photo, not the patient)
Camera device model, pupil status, lighting environment, an observed-issues checklist (glare, patient blinked or moved, out of focus, possible media opacity, eyelash-eyelid obstruction, none noticed), and the technician's overall usability rating — tap-only, under 45 seconds, present in full on either front-end (§4.4).

### 9.7 Patient Consent Capture
Before capture proceeds, the technician confirms that verbal consent for image capture and AI-assisted screening has been obtained, and this confirmation is timestamped and stored with the patient record. This is a verbal, technician-attested confirmation, not a digital signature or a lengthy consent document.

---

## 10. Resilience & Edge-Case Handling

### 10.1 Extended PHC Network Outages
A multi-day outage needs more than "queue it and wait": the sync queue orders by urgency tier first, then age; the local app monitors its own storage and warns the technician well before capacity is reached; a lightweight case-summary packet transmits ahead of the full image under thin connectivity; every PHC's last-contact time feeds System Health (§10.7), surfaced as an active alert past a configurable threshold; and a manual export-to-drive utility exists as a genuine fallback for outages severe enough that even intermittent connectivity isn't achievable. This applies identically on either front-end (§4.4).

### 10.2 Ungradable Images
After a fixed number of failed retakes, the technician marks a capture "best effort — proceed as ungradable," forcing mandatory Tier C review with an explicit flag rather than an infinite retry loop or a silently dropped case. If the patient questionnaire also indicates elevated risk and no gradable image is ever achieved, the local app surfaces standing, non-diagnostic guidance: consider direct referral to a specialist based on reported risk factors — never framed as a result of image analysis.

### 10.3 Duplicate Patients
At registration, the local app checks the new entry against existing local records by name, age, and phone number (fuzzy-matched) and flags likely duplicates for the technician to confirm or merge before a new patient ID is created.

### 10.4 Per-Eye Capture
DR severity is a per-eye assessment. Every capture is explicitly tagged left or right eye; a single patient visit produces up to two independent cases, each graded, tiered, and reviewed on its own.

### 10.5 Failed Patient Contact
An undeliverable SMS flips the referral straight into the manual-follow-up state on the Referral Tracker.

### 10.6 Collision-Safe Identity & Idempotent Submission
Patient IDs are generated with real entropy (PHC code, timestamp, and a random suffix), not a simple incrementing counter, on every front-end (§4.4). Every case submission carries its local `capture_id` as an idempotency key, enforced with a uniqueness constraint centrally: a retried upload is recognized as the same case rather than creating a duplicate record and a wasted second grading run.

### 10.7 Active System-Health Monitoring
A PHC gone silent for days, a grading job stuck mid-pipeline, a persistent MATLAB inference session that has died, and a referable case sitting unreviewed for days are the same class of failure (§1.17). Each gets an active, continuously-running check with its own threshold, surfaced together on one System Health screen. A stuck grading job or a dead MATLAB session is additionally retried or restarted automatically where that's safe to do; the ones that can't be safely auto-resolved get surfaced for a human to act on.

### 10.8 Concurrent Review Claiming
Opening a case for review claims it; a second reviewer who opens the same case sees that it's already claimed and cannot submit a conflicting decision while it remains claimed.

### 10.9 Mandatory Resolution on Branch Disagreement
When Branch A and Branch B disagree, the ophthalmologist's only path forward is an explicit grade selection — "Confirm" without picking a grade is not an available action on a disagreement case.

---

## 11. Non-Functional Requirements

- **Offline capability:** both front-ends are fully functional with zero connectivity, and degrade gracefully rather than failing outright under extended outages (§10.1).
- **Performance:** the quality-gate decision is fast enough for a live retake call, on either front-end, backed by the fallback/portable-logic chain (§4.2, §4.4).
- **Scalability:** designed with the district-scale figure the PS names — 100,000+ patients/year — in mind, validated by the Simulink resource model (§7).
- **Schema change management:** schema changes go through real migration tooling with a version history, not a single file hand-edited and reapplied — a genuine gap today.
- **No frontend fabricates a result in place of a failure (§1.22):** a failed request either surfaces as an error or genuinely queues for retry, on every front-end, with no exception.
- **Deployment scope, stated plainly (§1.20, §3):** this round's architecture verifies that Branch A can run correctly and quickly inside MATLAB on a licensed machine. It does not solve running that same inference on an unlicensed rural PHC machine.

### 11.1 Data Security
Patient health data demands real protection. Today, this system has **none** — no login route in any application (desktop PHC app, mobile PHC app, or central system), no auth middleware on any backend route, patient records and retinal images served to any unauthenticated request. This is the single most urgent gap in the entire system. The minimum specification:

| Requirement | Implementation |
|---|---|
| Login | A real authentication endpoint, checked against a stored credential hash, in every application |
| Role-based access control | Server-side middleware enforcing role on every endpoint |
| Encryption in transit | TLS 1.2+ on every backend |
| Encryption at rest | AES-256 on the database and stored images |
| Audit logging | The `access_log` table, populated on every access to patient data |

This is a prototype-stage floor, not a production compliance claim.

---

## 12. Consolidated ML Models & Algorithms List

1. **Image quality assessment (local, either front-end):** classical CV heuristics across nine factors.
2. **Preprocessing:** CLAHE, illumination normalization, denoising, Ben Graham preprocessing — one canonical implementation.
3. **Camera-fingerprint calibration:** image-based camera-family classifier; drives confidence-routing and vessel-segmentation domain-threshold selection.
4. **Optic disc/fovea localization:** U-Net regressor with a peak-confidence gate on fovea output.
5. **Vessel segmentation:** U-Net (CHASE_DB1) plus a Frangi vesselness filter, with a per-domain segmentation threshold.
6. **Lesion segmentation:** a dedicated 3-class red-lesion model with a class-specific minimum-area filter, and a hard-exudate model. Soft-exudate detection excluded this round. **Neovascularization**: a vessel-pattern-derived proxy score.
7. **DR severity classification — Branch A:** EfficientNet-B0, ordinal-aware loss, with a grade-3/grade-4 probability-sum safety check.
8. **DR severity classification — Branch B:** explicit ICDR/ETDRS rule engine, implementing the full "4-2-1" severe-NPDR criteria.
9. **Confidence routing:** temperature scaling, MC Dropout, and class-conditional ordinal conformal prediction, combined with branch agreement, probation status, and quality flags into one tiering decision.
10. **Explainability:** Grad-CAM/Grad-CAM++, validated with a lesion-attention consistency score and a counterfactual occlusion test, assembled into one PDF clinical-rationale report.
11. **Symptom/risk fusion:** rule-based weighted scoring.
12. **Continual learning:** supervised fine-tuning on ophthalmologist corrections, validation-gated promotion.
13. **Resource allocation modeling:** discrete-event simulation (Simulink SimEvents).

---

## 13. Consolidated Architecture Components List

| Component | Layer | Technology | Purpose |
|---|---|---|---|
| Capture Handler | PHC backend | Camera SDK/driver (desktop) or gallery import (mobile) | Get the fundus image onto the device, tagged by eye |
| Quality-Gate Engine | PHC backend / ML | MATLAB Compiler + Runtime (desktop primary), portable JS logic (desktop fallback and mobile primary) | Local retake/ungradable decision |
| Local API | PHC backend | Node/Flask (desktop), in-app service layer (mobile) | Glue layer |
| Local Database | PHC backend | SQLite (desktop), embedded structured store e.g. expo-sqlite (mobile) | §4.3 schema |
| Sync Manager | PHC backend | Chunked/resumable, idempotent, summary-first | Online/offline/extended-outage transmission, identical contract on both front-ends |
| Local PHC App | PHC frontend | Web app (desktop), Expo/React Native (mobile) | §4.1/§4.4 screens |
| Ingestion API | Central backend | REST, idempotent on capture_id | Receive data from either front-end |
| Camera Calibration Service | Central backend / ML | MATLAB | Family classification, domain threshold, probation tracking |
| Grading Pipeline Orchestrator | Central backend / ML | MATLAB + Python | §6 pipeline |
| ICDR/ETDRS Rule Engine | Central backend / ML | Base MATLAB | Branch B grading |
| Central Database | Central backend | PostgreSQL, real migration tooling | §5.5 schema |
| Referral & Notification Service | Central backend | Twilio | Routing, SMS, manual-follow-up escalation |
| Continual Learning Service | Central backend / ML | Custom retraining pipeline | §6.11 — capture + export done, retraining pipeline itself deferred to a future round |
| Admin Analytics Aggregator | Central backend | Custom | Dashboard metrics |
| Grading Job Watchdog | Central backend | Custom, continuous polling | §10.7 |
| MATLAB Session Supervisor | Central backend | Process supervisor | §10.7 |
| Simulink Integration | Central / systems | Simulink + SimEvents | §7 |
| Ophthalmologist Interface | Central frontend | Web app | §5.2, review claiming |
| District Admin Interface | Central frontend | Web app | §5.3, System Health |
| Auth Service | Central backend | Session/credential-based, role-enforced | §11.1 |
| Access Log Store | Central backend | `access_log` table | §11.1 |

---

## 14. Datasets

| Dataset | Size | Labels | Used for |
|---|---|---|---|
| APTOS 2019 | 3,662 images | 5-class DR severity | Branch A classification training |
| IDRiD | 81 (segmentation, with separate MA/HE mask folders) + 516 (grading) + 516 (localization) | Pixel-level lesion + optic disc masks; DR+DME grades; coordinates | Segmentation, classification, localization |
| CHASE_DB1 | Standard vessel-segmentation set | Pixel-level vessel masks | Vessel segmentation training |
| Messidor-2 | ~1,748 images | DR grading (adjudicated reference) | External/domain-generalization validation, never used in training or model selection |

Additional datasets from teammates' own research are still to be incorporated once submitted — see §18.

---

## 15. Metrics & Validation Plan

- **Primary target:** referable DR (grade ≥ 2), >90% sensitivity and >85% specificity, benchmarked against the IDx-DR FDA pivotal trial's 87.2%/90.7% (900 patients, 10 primary-care sites).
- **Current measured performance** (recovered, non-contaminated held-out split — the earlier "all images on disk" numbers overstated performance by up to ~2.7× and are never quoted in a clinical claim): quadratic-weighted kappa **0.8242 on IDRiD alone** — report this figure, not the pooled APTOS+IDRiD number (0.883), which is inflated by APTOS being the easier dataset.
- **Grade-4 (proliferative DR) recall is the ship-blocking finding: 0.444**, on 54 true PDR cases in this split — and critically, 5 of those 54 fell below the referral threshold entirely. Root cause: the current input resolution can't resolve the fine neovascular structures that separate grade 3 from grade 4. An interim safety mitigation is already part of the design (§6.7's grade-3/grade-4 probability-sum check); the real fix — higher input resolution, a dual-head architecture, cost-sensitive/ordinal loss tuned against grade-4 recall, and a locked sensitivity threshold — is in progress, pending training compute. **This is a distinct fact from the neovascularization suspicion score's own performance, which has never been measured** — the two should never be reported as the same number.
- **Grade-1 recall is 0.000** on only 4 true grade-1 cases in this split — reported with the small-sample caveat stated plainly.
- **Vessel segmentation is not domain-shift-impaired.** The real cause of an apparent cross-dataset gap was an annotation-convention difference, and once a per-domain threshold is applied, out-of-domain performance (0.8136 Dice) matches in-domain performance (0.8024 Dice).
- **Hard-exudate detection: Dice 0.6676.** **Soft-exudate/cotton-wool detection is effectively absent (Dice 0.076)**, reported as an explicit scope exclusion, not a weak metric.
- **Microaneurysm detection is a size problem more than a lesion-type problem**: detection rate at matched lesion sizes is similar between microaneurysms and hemorrhages, but most true microaneurysms are small enough that a shared minimum-component-size filter was discarding a large share of correctly-detected candidates — the dedicated 3-class retrain with a class-specific size floor directly targets this.
- **Branch agreement:** measured at 46.2% with a 1.37× disagreement error-lift on an earlier 52-case slice — real, positive evidence the two-branch mechanism works, due for re-measurement now that the rule engine and confidence-routing consolidation have both changed since that measurement was taken.
- **Confidence-set contiguity:** the conformal prediction method has been measured to produce non-contiguous grade sets (e.g. {0,3}) on 14.6% of a 103-image sample when using a plain marginal nonconformity score — exactly the failure mode the ordinal, class-conditional method in §6.8 eliminates by construction; whether the currently-deployed method has completed that switch is tracked in §18.
- **Domain-generalization-gap experiment:** IDRiD test-split performance and synthetic portable-camera perturbations both have real measured results; Messidor-2 remains the missing piece.
- **Integrated pipeline vs. single-technique baseline:** confidence intervals overlap at matched coverage on the most recent comparison, so the "outperforms any single technique" claim is not yet statistically supported.
- **Explainability validation:** lesion-attention consistency and counterfactual occlusion checks are real and quantitative (n=12); a clinician plausibility rating and a real review-duration measurement both still need real people and real usage.

---

## 16. Build Roadmap

**Confirmed real and working, verified against actual running code:** Simulink SimEvents model; SMS/Twilio; Branch A running live in MATLAB by default via a verified ONNX import, with the persistent session confirmed faster than Python and failing loudly rather than silently falling back; confidence routing consolidated into one real decision site with branch-disagreement, camera-probation, and quality-forced overrides all genuinely wired in; override reasons genuinely persisted through the review transaction.

**Do these first — same-day, high-risk-reduction:**
- Remove the live ngrok inference call from the desktop app's config and Capture screen (§1.3).
- Disable the mobile app's silent mock-data fallback on failure (§1.22) before it's shown to anyone in any state — a fabricated result is worse than a visible error.
- Fix `simulink-model/README.md`'s stale "not built yet" line.
- Fix the "domain shift" comment in the vessel-segmentation code to reflect the real, corrected cause (§6.5).
- Rename the bright-lesion model's fields/outputs to `hard_exudate` everywhere.

**Tier 1 — the biggest remaining exposure:**
1. **Authentication and access control (§11.1)** — currently completely absent across every app, ahead of any accuracy concern.
2. **The grade-4 ship-blocking recall issue (§15)** — schedule the M1 v2 retrain as soon as GPU access allows.
3. **The fovea peak-confidence gate (§6.4)** — specified, not yet built.
4. **Mandatory explicit resolution on branch disagreement (§10.9)** and **concurrent-review claiming (§10.8)**.
5. **Collision-safe patient IDs and idempotent case ingestion (§10.6)** on both front-ends.
6. **Re-point the mobile app's entire API layer and type contracts at the real central backend (§4.4)** — currently zero code paths reach it; every field name in the app's types is shaped around the abandoned external service and needs rewriting, not adjusting.
7. **Give the mobile app a real local quality gate (§4.4)** — currently quality assessment is bundled into the same remote call as grading, which violates the edge/cloud split (§1.2) this whole design is built around.

**Tier 2 — designed but not yet built:**
8. Grading Job Watchdog and MATLAB Session Supervisor (§10.7).
9. The neovascularization suspicion score's real computation, validated on its own before being wired into the live path.
10. The MA/HE 3-class lesion retrain, completed together with the coupled rule-engine threshold recalibration (§6.6).
11. Consent capture (§9.7) and patient fuzzy-duplicate search (§10.3) — `GET /api/v1/patients/search` doesn't exist yet.
12. Schema migration tooling.
13. PDF clinical-rationale report generation (§6.9) and DICOM input support.
14. Replace the mobile app's single-blob local storage with a structured store (§4.4).
15. Unify patient/capture ID generation onto one shared scheme across both front-ends (§10.6) — the mobile app currently generates neither in a compatible format.
16. Build the capture-metadata questionnaire on the mobile app (§9.6) — currently absent entirely.
17. Bring the desktop app's patient questionnaire (§9.1) up to the full field set — the mobile app currently collects more of this questionnaire's intended fields (including pregnancy status and symptoms) than the desktop app does, so this is the desktop catching up, not the mobile app falling behind.
18. Add required contact-number and eye-laterality fields to the mobile app.

**Tier 3 — strengthens the submission if the above lands on schedule:**
19. Messidor-2 external validation; completing the local IDRiD dataset; re-running the integrated-pipeline-vs-baseline comparison with more data.
20. A small, targeted set of automated tests for the confidence-routing decision specifically.
21. Docker/CI setup.

**Explicitly rejected this round, with reasons:**
- Replacing the trained Python segmentation models with a Frangi-only heuristic.
- Removing the quality-gate's fallback chain to require MATLAB everywhere.
- A "trained" clinical risk score with no real outcome-labeled data to train on.
- A general inter-PHC peer-to-peer mesh network — the scoped camp-mode relay (§9.5) solves the version of this problem that's real.
- A phone-camera or phone-plus-lens live-capture path for the mobile app this round (§1.21) — gallery import from the existing dedicated camera is the scope for now.

---

## 17. Risks & Honest Limitations

- **This is a screening decision-support system, not an autonomous diagnostic.** Every positive result is confirmed by an ophthalmologist.
- **This round's MATLAB architecture does not solve unlicensed rural PHC deployment.** Running Branch A's inference on an actual unlicensed rural PHC machine requires MATLAB Compiler + MATLAB Runtime packaging of the central inference path, not done this round.
- **There is currently no authentication anywhere in this system.** The single most severe limitation in the system today.
- **Grade-4 (proliferative DR) recall is 0.444, with 5 of 54 true cases currently falling below the referral threshold entirely** — a mitigation is live, but it's a mitigation, not a fix.
- **Diabetic macular edema (DME) cannot be reliably ruled out from color fundus photographs alone.**
- **Neovascularization detection has no measured performance yet**, distinct from the grade-4 recall issue above.
- **Soft-exudate/cotton-wool detection is explicitly out of scope this round**, not a weak capability.
- **The grading queue is in-memory and only recovers stuck jobs at server restart today.**
- **Zero automated tests exist in any conventional framework.**
- **Simulink parameters are modeled assumptions, not measured field data.**
- **Conformal guarantees are only as good as the calibration set's representativeness**, and whether the deployed method has completed the switch to an ordinal, class-conditional score is tracked as an open item (§18), not assumed resolved.
- **The "integrated pipeline beats a single technique" claim is not yet statistically supported.**
- **Messidor-2 external validation has never been run.**
- **The mobile app is not currently safe to demo in its existing form.** It has zero contract compatibility with the real central backend, no real local quality gate, no capture-metadata questionnaire, an incompatible identity scheme, and — most seriously — silently substitutes a fabricated result for any failed request rather than surfacing the failure. Bringing it into the fold (§4.4) is a real scope of work, and none of its current behavior should be shown to anyone until at minimum the fake-success fallback is removed.
- **The security baseline described in §11.1, once built, is prototype-stage, not a production compliance claim.**

---

## 18. Open Items

- [ ] Confirm whether the deployed conformal-prediction nonconformity score has completed the switch from marginal LAC to the ordinal, class-conditional method specified in §6.8.
- [ ] Confirm whether idempotency is enforced at the case/capture level centrally (§10.6), not only at the patient level.
- [ ] A phone-plus-clip-on-fundus-lens capture path is a stated future extension to the mobile app, not built this round (§1.21) — revisit once hardware can be sourced and tested against camera-family calibration (§6.3).
- [ ] Confirm which dedicated camera model(s) support a convenient transfer path onto a phone for the mobile app's gallery-import capture method (§4.4).
- [ ] Additional datasets from teammates — see §14 checklist.
- [ ] Whether a quality-labeled dataset exists to upgrade §6.1 from heuristic to learned.
- [ ] Whether any dataset links patient history/symptoms to outcomes, to upgrade §6.10 from rule-based to learned.
- [ ] Confirm whether district admin wants per-case real-time alerts beyond the System Health exceptions already specified.
- [ ] Firm up retraining cadence/correction-count threshold for §6.11 once case volume is estimated.
- [ ] Decide whether ASHA workers get their own login/interface or remain admin-assigned only.
- [ ] Decide a realistic, scoped testing investment given zero current coverage and limited remaining time.
- [ ] Spot-check the Medios AI and AIDRSS figures in §15's reference framing before they go in the final PPT.
- [ ] Fold in teammates' own shortcoming/feature research once submitted.
