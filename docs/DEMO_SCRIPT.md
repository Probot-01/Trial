# NetraSetu — 6-minute demo video script

A condensed, timed script for the SIH submission video. Target runtime: **6 minutes** (fits the
5-7 minute window with margin). Adapted from the full `docs/DEMO_RUNBOOK.md` (11 scenes, ~11
minutes) by cutting narration overlap and trimming the offline/reconnect demonstration to its
essential beat. If you have the full 7 minutes, the optional B-roll notes at the end give you
somewhere to spend it.

**Before recording:** run `node scripts/demo-reset.js` (~4 min, not part of the video) and keep
its output terminal visible off-camera — it prints every login you need below. Load each web app
once, wait ~10s, and reload before you start recording (Vite's first-request dependency
optimization eats anything typed during it).

**Say the number on screen, not a rounded one** — every metric a judge might screenshot should
match the live app exactly.

---

## 0:00 – 0:20 — Cold open (problem statement, voiceover over a static title card or the login screen)

*"India has roughly one ophthalmologist per 100,000 rural people, but diabetic retinopathy
affects nearly a fifth of the country's diabetic adults. NetraSetu lets a minimally-trained
technician at a rural clinic screen a patient in minutes, with two independent AI models
cross-checking each other, and a specialist confirming every positive result before it reaches
the patient."*

## 0:20 – 1:05 — PHC login and patient registration (desktop, `:5173`)

1. Log in as `technician` with the password `demo-reset` printed.
2. **Say:** "Every technician login is real — bcrypt-checked, session-based."
3. New patient: fill name, age, gender, contact number, address. Answer the risk questionnaire
   (known diabetic, years since diagnosis, glycemic control, BP, symptoms) — **say**: "This
   questionnaire can't be skipped, and it only ever nudges the AI's confidence — it never
   overrides what the image shows."
4. Tick informed verbal consent, click **INITIATE CAPTURE**.

## 1:05 – 2:15 — Capture, quality-gate reject, retake, accept

1. Choose eye (Left/OS) and camera preset. Import `idrid_164_bad_blur_dark.jpg`
   (`tests/fixtures/`). Click **RUN QUALITY CHECK**.
2. While it runs (~10-15s, a real `matlab -batch` call): **say**: "This quality check runs
   on-device, on real MATLAB code — not a placeholder. A rural clinic can't afford to send a bad
   photo to the cloud and find out five minutes later."
3. **Expect:** Quality fail, "Image below diagnostic threshold," engine **MATLAB**, issue "Image
   is too dark." Click **RETAKE IMAGE**.
4. Import `idrid_010_good_pass_w1800.jpg`, **RUN QUALITY CHECK** again.
5. **Expect:** Quality pass. Click **ACCEPT & CONTINUE**.
6. Complete the capture-metadata questionnaire (dilated, indoor clinic, none noticed), click
   **CLEAR**, then **SAVE & SYNC TO SERVER**.
7. **Say:** "The image, both questionnaires, and the quality result sync to central now — or
   queue locally the moment connectivity drops."

## 2:15 – 2:40 — Offline resilience (compressed beat)

1. Terminal: `node scripts/demo-offline.js stop`. Wait ~15s — header turns amber, **OFFLINE**.
2. **Say, over the amber header:** "If the network drops mid-shift, nothing is lost and nothing
   pretends to have synced — it queues, ordered by urgency, and sends the moment connectivity
   returns."
3. `node scripts/demo-offline.js restore`. Wait for **ONLINE** (~10s). Don't wait for the full
   RESULT READY transition on camera — cut to the next scene once it reads ONLINE.

## 2:40 – 4:15 — Central: dual-branch grading, Grad-CAM, confidence tiers (`:5174`)

1. Log out of the intro, choose **OPHTHALMOLOGIST**, log in with
   `ophthalmologist@demo.netrasetu.local` and its printed password.
2. **CASES** queue: **say**: "Every referable and uncertain case lands here — the queue is sorted
   so the model's least-confident cases surface first, not the most severe. High-confidence,
   low-risk cases never reach a human at all."
3. Open a referable row. **Say, pointing at the two grade columns**: "Two independent models grade
   every image — a deep-learning classifier, and a separate rule engine implementing the actual
   clinical ICDR criteria by counting lesions per quadrant. When they agree, that's real evidence.
   When they disagree" *(open the flagged disagreement case if the reset seeded one — it does)*
   "the case is forced to mandatory review — a reviewer can't just click Confirm, they have to
   pick an explicit final grade."
4. Click **GRAD-CAM OFF** to turn the heatmap on. **Say:** "This shows exactly which pixels drove
   the AI's decision — not a black box."
5. Scroll to lesion evidence (red/bright lesions per quadrant) and the confidence tier. **Say:**
   "Every case also gets a statistically calibrated confidence tier, not just a raw softmax score
   — that's what decides whether a case needs full manual review or can auto-clear."

## 4:15 – 4:55 — Confirm and override

1. On the agreeing case: **CLINICAL DECISION & SAFETY AUDIT** → **CONFIRM** → **SUBMIT CONFIRM**.
   Green flash, case leaves the queue.
2. Open the disagreement case: **OVERRIDE**, pick the corrected grade and a reason, submit.
   **Say:** "Every override is captured with its reason — that's the raw material for the
   system's continual-learning loop."

## 4:55 – 5:20 — Referral tracking (district admin)

1. Log out, choose **DISTRICT WORKER**, log in as `admin@demo.netrasetu.local`.
2. Click **REFERRALS**. **Say:** "Every confirmed or overridden referable case becomes a tracked
   referral — SMS'd to the patient automatically, and if that fails, flagged for a human to call
   instead. Nothing about patient follow-up is left to chance."

## 5:20 – 5:45 — Admin overview (quick pass)

1. **DASHBOARD**: cases today/week, override rate, average review time. **Say:** "A district
   administrator sees screening volume and system load at a glance — not a per-patient feed."

## 5:45 – 6:00 — Mobile app (second front-end)

1. Cut to phone screen recording (pre-captured, or live if reliable): registration → gallery
   import of a fundus photo → on-device quality check → sync.
2. **Say:** "The same workflow also runs as a phone app for a technician without a dedicated
   station — same backend, same rules, same safety guarantees, not a separate simplified path."

## 6:00 – 6:00 — Close

*"Two independent AI models, a specialist always in the loop, offline-first for real rural
connectivity, and every decision explainable down to the pixel. That's NetraSetu."*

---

## If you have the extra 60-90s (7-minute cut)

Insert after 4:15 (before override), ~45s: PHC Health screen — show a PHC gone silent past
threshold, explaining the system-health alerting most screening tools don't have. Or insert after
2:40, ~30s: show the local queue's storage-pressure warning / manual export utility, since
"multi-day outage" is a real rural-India scenario, not a hypothetical.

## Recovery notes (only matters if something breaks on camera)

- Quality check stuck / MATLAB start-up failure: click the retry button that appears; the saved
  image re-checks without a new photo.
- "502 Bad Gateway" on central login: the web app is pointed at the wrong backend port — this
  means `demo-reset` wasn't re-run after a `.env` change; re-run it.
- A case still shows `processing` after 30s in the review queue: wait, then reload — grading is a
  real ~21-25s MATLAB + segmentation pipeline, not instant by design.
