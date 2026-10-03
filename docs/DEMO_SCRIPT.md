# NetraSetu — SIH demo video script (click tour)

**Target runtime: ~6:10** (inside the 5–7 minute window). A live click tour of the prototype, with short explanations at the key moments.

**The one rule for every line:** say only what the screen shows or what `docs/ML_BENCHMARKS.md` states. Say numbers exactly as written here.

---

## Recording setup and roles

- **Tanuj's machine runs everything:** central web, PHC desktop web, MATLAB and Simulink.
- **Parth drives the UI over AnyDesk and does the voiceover** for everything except the mobile app.
- **Record the screen locally on Tanuj's machine** with OBS at 1080p, not through AnyDesk (its stream is compressed and laggy).
- **Record Parth's voice on a headset at his end** and sync it in editing.
- **Tanuj records the mobile segment himself,** on his phone, and it gets spliced in at the marked point.

**Before recording (Tanuj):**

1. Run `node scripts/demo-reset.js` (~4 min). Relay the credentials to Parth privately. **The credentials terminal must never appear on screen.**
2. Clear the mobile app's local store (demo-reset prints how).
3. Load each web app once, wait ~10 s, then reload.
4. Open MATLAB with `simulink-model/netraSetuPipeline.slx` loaded (not yet run).
5. Use a fictional patient name and a dummy phone number.

---

## [PARTH] 0:00 – 0:25 — Cold open

*Voiceover over a title card or the login screen.*

> "India has about fifteen ophthalmologists per million people, and blindness is more common in rural India than in its cities — yet nine in ten cases of vision loss from diabetic retinopathy are preventable if caught in time. NetraSetu lets a technician at a rural health centre screen a patient in minutes. The photo is checked on the spot, graded centrally by two independent methods, and every positive result is confirmed by a specialist before it reaches the patient. Let's walk through it."

---

## [PARTH] 0:25 – 1:00 — PHC login and patient registration (desktop, :5173)

1. Log in as the technician with the password demo-reset printed.
2. Say: *"This is the PHC app — the only screen a rural technician uses. Every technician has a real account."*
3. Click to add a new patient. Fill in name, age, gender, contact number and address. Answer the risk questionnaire: known diabetic, years since diagnosis, glycemic control, BP, symptoms.
4. Say: *"This questionnaire can't be skipped. It only nudges the system's confidence — it never overrides what the image shows."*
5. Tick informed verbal consent, then click **INITIATE CAPTURE →**.

---

## [PARTH] 1:00 – 2:10 — Capture, quality-gate reject, retake, accept

1. Choose the eye (Left/OS) and the camera preset. Import `idrid_164_bad_blur_dark.jpg` (from `tests/fixtures/`). Click **RUN QUALITY CHECK →**.
2. While it runs (~10–15 s), say: *"The quality check runs right here on the clinic's machine, in MATLAB, on hardware a rural PHC can actually afford. A bad photo should be caught before the patient leaves the chair — not after a specialist in another city has wasted time on it, and not after someone's made a return trip they couldn't easily afford."*
3. Expect: Quality fail, "Image below diagnostic threshold", engine MATLAB, issue "Image is too dark". Say: *"It says exactly what's wrong — the image is too dark."* Click **↺ RETAKE IMAGE (RESOLVE DEFECT)**.
4. Import `idrid_010_good_pass_w1800.jpg` and click **RUN QUALITY CHECK →**. Expect: Quality pass. Click **ACCEPT & CONTINUE →**.
5. Complete the capture questionnaire (dilated, indoor clinic, none noticed), then click **SAVE & SYNC TO SERVER →**. (There is no separate "clear" step on this form — the questionnaire submits directly.)
6. Say: *"The image, both questionnaires and the quality result now go to the central server for grading."*

---

## [PARTH] 2:10 – 2:35 — Offline resilience

1. Off screen, run `node scripts/demo-offline.js stop`. Wait ~15 s until the header turns amber and shows OFFLINE.
2. Say: *"Rural connectivity is unreliable, so everything is stored locally first. If the network drops, nothing is lost and nothing pretends to have synced — cases queue in order of urgency and send when the connection returns."*
3. Run `node scripts/demo-offline.js restore`. Wait for ONLINE (~10 s), then cut.

---

## [PARTH] 2:35 – 4:10 — Central: dual-branch grading, Grad-CAM, confidence tiers (:5174)

1. Log out of the intro, choose OPHTHALMOLOGIST, and log in as `ophthalmologist@demo.netrasetu.local`.
2. On the CASES queue, say: *"This is the specialist's review queue. Cases the system is least sure about come first. Only cases the calibrated system is confident are non-referable can skip this queue — everything else is reviewed by an ophthalmologist."*
3. Open a referable case where the branches agree. Point at the two grade columns and say: *"This is where 'explainable' stops being a buzzword. Every image is graded twice, independently: by a deep-learning classifier, and by a rule engine applying the clinical ICDR criteria to microaneurysms, haemorrhages and exudates counted in each quadrant. When they agree, confidence goes up."*
4. Click **○ GRAD-CAM OFF** to turn the heatmap on (it becomes **✦ GRAD-CAM ON**). Say: *"This heatmap shows which regions of the retina most influenced the classifier's decision, so the doctor can check it's looking at real lesions — not a black box."*
5. Scroll to the lesion evidence and the confidence tier. Say: *"The doctor doesn't just see a grade — they see the actual lesions counted, the exact clinical rule that fired, and a calibrated confidence tier, not a raw model score. That tier decides whether a case needs full review, AI-assisted review, or can be cleared — every one of those decisions is traceable back to a reason, not a guess."*

---

## [PARTH] 4:10 – 4:50 — Confirm and override

1. On the agreeing case: **CLINICAL DECISION & SAFETY AUDIT** → **CONFIRM** → **SUBMIT CONFIRM (PRESS ENTER)**. A green flash appears and the case leaves the queue. Say: *"The doctor confirms in seconds."*
2. Open the flagged disagreement case. Say: *"Here the two methods disagree. That's treated as a safety signal — the doctor can't just click Confirm; they must choose the final grade."*
3. **On a disagreement case the button reads RESOLVE, not OVERRIDE** (OVERRIDE only appears on an agreeing case where the reviewer disagrees with the AI). Click **RESOLVE**, pick a **referable grade (2 or higher)** so it produces a referral for the next scene, choose a reason, and submit (**SUBMIT RESOLUTION (PRESS ENTER)**).
4. Say: *"Every correction is recorded with its reason, ready for improving the model in future."*

---

## [PARTH] 4:50 – 5:15 — Referral tracking (district admin)

1. Log out, choose the district admin role (use the label exactly as the login screen shows it), and log in as `admin@demo.netrasetu.local`.
2. Click REFERRALS. Narrate what is actually on screen:
   - **SMS sent:** *"Every confirmed referable case becomes a tracked referral, and the patient is notified automatically."*
   - **Manual follow-up:** *"The system couldn't send the SMS, so it flagged the referral for a health worker to call instead of silently failing."*
3. Say: *"The district tracks every referral through to the patient actually attending."*

---

## [PARTH] 5:15 – 5:35 — Simulink resource model

1. Switch to the pre-loaded MATLAB window and click Run on `netraSetuPipeline.slx`.
2. Say: *"For district planning, this discrete-event simulation in Simulink and SimEvents models images flowing from clinics, across the network, to specialist review — showing where the bottleneck will be. It's a real, working model, not a slide."*

(Verified: the Resource Recommendations screen's live numbers come from a separate queueing-model function that this Simulink model periodically cross-validates against — not a per-refresh run of the `.slx` itself. Don't claim its output feeds that screen directly.)

---

## [TANUJ — own phone] 5:35 – 5:55 — Mobile app

1. Screen-record: registration → gallery or lens import → on-device quality check → sync.
2. Voiceover: *"The same workflow runs as a phone app for clinics without a dedicated workstation — same server, same rules, same specialist review."*

---

## [PARTH] 5:55 – 6:10 — Results and close

*Results card on screen.*

> "On images it was never trained on, the classifier reaches ninety-five percent sensitivity and ninety-one percent specificity for referable retinopathy. On a camera it has never seen, sensitivity drops to seventy-five percent — so images from a camera that hasn't been locally validated are never cleared without human review. Screening at the clinic, a specialist always in control, every decision explained. That's NetraSetu."

**Card text:**

- Referable DR, in-domain: 95.0% sensitivity · 91.0% specificity
- Unseen camera (Messidor-2): 75.2% sensitivity → unvalidated cameras always get human review
- 0 grade-4 cases auto-cleared (in-domain safety study)

---

## Optional (7-minute cut)

After 4:50, add ~30 s on the **PHC Health** screen, showing a PHC gone silent. Say: *"The district admin immediately sees a health centre that has stopped syncing."*

---

## Recovery notes

| Problem | Action |
|---|---|
| Quality check stuck | Click retry; the saved image re-checks |
| "502 Bad Gateway" on login | Tanuj re-runs demo-reset |
| A case still shows "processing" after 30 s | Wait, then reload; grading takes ~21–25 s |
| AnyDesk lag | Pause narration rather than clicking twice |
| Anything unexpected on screen | Stop the take and re-run demo-reset |
