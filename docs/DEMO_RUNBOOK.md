# Demo runbook: scene by scene

The recording script for the local demo. Everything runs on one machine, with real services and no
mock data. `docs/DEMO.md` explains what `demo-reset` builds; this file says what to click.

**Ports** are read from each checkout's own `.env` files. This runbook uses the integration
checkout's: PHC web **5173**, central web **5174**, PHC backend **4200**, central backend **5200**.
A default checkout uses 4000 / 5000 instead. Substitute yours.

**Logins** are generated per run and printed once at the end of `demo-reset`. Nothing is stored.
Keep that terminal window visible off-camera.

## Before you record

1. Docker Desktop running, then `npm run db:up`.
2. `node scripts/demo-reset.js` (about 4 minutes). It must end with `DEMO STACK READY` and exit 0.
   Exit 2 means a demo case did not get the outcome it needs (the table says which): re-run it.
3. Open two browser windows: PHC desktop `http://localhost:5173`, central `http://localhost:5174`.
   **Load each once, wait about 10 s and reload it.** The Vite dev servers were just started and reload
   the page the first time they optimise dependencies; anything typed during that reload is lost.
   If the browser still holds a previous run's session, the PHC app sends you to the login screen by
   itself (it drops a stale session).
4. Fixtures are in `tests/fixtures/`: `idrid_164_bad_blur_dark.jpg` (the reject),
   `idrid_010_good_pass_w1800.jpg` (passes) and `idrid_163_good_borderline.jpg` (accepted, borderline).
5. Do not click **Log out** or reload the central web app while central is stopped (scene 4).
6. If you rehearse, run `demo-reset` again before recording: a rehearsal leaves extra cases behind.

Times are rough seconds on camera, at a normal speaking pace.

---

## Scene 1: Login (about 25 s)

**PHC desktop (`:5173`).**
Click **Username**, type `technician`, click **Password**, type the technician password from the reset
output, click **INITIATE SESSION**.
*Expect:* the registration page. Header shows the PHC name, **ONLINE**, **0 PENDING**.
*Recovery:* "Cannot reach the PHC backend at ..." means the web app is pointed at the wrong backend
port: run `demo-reset` again (it pins the port). "Invalid credentials": you typed a password from a
previous run; scroll the reset output.

**Central (`:5174`).** Show this one later (scene 7). The page opens on a scroll-driven intro.

## Scene 2: Register a patient, with consent and the patient questionnaire (about 60 s)

Nothing here is skippable, and nothing is pre-filled.
1. Click **NEW PATIENT** if you are not on the form.
2. Fill **First name** `Runbook`, **Last name** `Patient`, **Gender** Female, **Age** 54,
   **Address** `12 Demo Lane`, **State** Maharashtra, **District** `Pune`, **Contact number** `9876543210`.
3. Questionnaire (section 03): **Known diabetic** YES, **Years since diagnosis** 5-10 YRS,
   **Glycemic control** MODERATE, **Blood pressure** Normal, **Currently pregnant** N / A,
   **Symptoms** BLURRED VISION.
4. Tick **Informed verbal consent**.
5. Click **INITIATE CAPTURE**.

*Expect:* the red "Still to answer before capture: ..." line, and the submit button's own label, list
what is missing and clear as you answer; **INITIATE CAPTURE** opens the Image Capture page for this patient.
*Say:* the questionnaire cannot be skipped, and consent is timestamped.
*Recovery:* if the button does nothing, read the red line above it.

## Scene 3: Capture, quality-gate reject, retake (about 75 s)

1. On **1. CAPTURE**, click **LEFT (OS)** and choose **Remidio FOP** in **Camera**. The eye and the
   camera are chosen, never defaulted.
2. Click the black image frame (a file dialog opens), pick `idrid_164_bad_blur_dark.jpg`.
   The image appears. Click **RUN QUALITY CHECK**.
3. Wait about 10-15 s (a real `matlab -batch` runs).
   *Expect:* **Quality fail**, "Image below diagnostic threshold", engine **MATLAB**
   (`qualityGateMain.m via matlab -batch`), detected issue "Image is too dark", and a red
   **RETAKE IMAGE** button. Nothing is uploaded.
4. Click **RETAKE IMAGE**. The eye and camera stay selected. Click the frame again and pick
   `idrid_010_good_pass_w1800.jpg`, then **RUN QUALITY CHECK**.
   *Expect (10 s):* "RETAKE ATTEMPT 2 FOR THIS PATIENT TODAY", **Quality pass**, engine **MATLAB**.
5. Click **ACCEPT & CONTINUE**.

*Recovery:* "Quality check could not run" / a red notice with **RETRY QUALITY CHECK ON THE SAVED IMAGE**:
MATLAB failed to start (a known intermittent Windows start-up failure, exit 3221225794). Click the
retry button; the saved image is checked again without a new photograph. If it keeps failing, run
`demo-reset` and start over.

## Scene 4: Capture-metadata questionnaire (about 30 s)

Step **3. METADATA & SYNC**. The header now reads **1 AWAITING QUESTIONNAIRE**, which is honest:
the image is not queued yet.
Click **DILATED**, **INDOOR CLINIC**, **NONE NOTICED** and **CLEAR** (scroll the panel to reach it).

Do not press **SAVE & SYNC TO SERVER** yet if you want the offline scene next (scene 5). To show the
online path, press it now: the queue page opens and the row moves to **AI PENDING** within seconds.
*Recovery:* the red "Still to answer: ..." line names the missing answer.

## Scene 5: Offline queue (about 60 s)

1. In a terminal: `node scripts/demo-offline.js stop`. Wait about 15 seconds.
   *Expect:* the header turns amber: **OFFLINE**, **0 PENDING**. The PHC keeps working.
2. Register a patient (scene 2) or open **NEW PATIENT** and capture again. Use
   `idrid_163_good_borderline.jpg`: the gate still runs locally (**Borderline quality**, engine
   **MATLAB**). Answer scene 4's questions and click **SAVE & SYNC TO SERVER**.
   *Expect:* the queue shows the header **OFFLINE, 1 PENDING** and the row
   **QUEUED - PENDING UPLOAD**, action **WAITING (SYNC)**. Nothing pretends to be sent.

*Recovery:* if the header still says ONLINE after 20 s, run `node scripts/demo-offline.js status`.
Do not open the central web app while it is stopped.

## Scene 6: Reconnect and sync (about 30 s)

1. `node scripts/demo-offline.js restore` (central is healthy again after about 6 s).
2. Watch the header: within about 10 s **ONLINE, 0 PENDING**. About 20 s later the row reads
   **RESULT READY** ("Central has graded this case. This station does not display the grade yet.").

*Recovery:* if the row is still **QUEUED** after 30 s, check
`node scripts/demo-offline.js status` (both lines must be up), then reload the queue page.

## Scene 7: Grading result: both branches, confidence tier, Grad-CAM, engines (about 90 s)

**Central (`:5174`), as the ophthalmologist.**
1. The page opens on the intro. Click **SKIP**, or scroll to the end. Click the **OPHTHALMOLOGIST**
   card. Click **Email**, type `ophthalmologist@demo.netrasetu.local`, click **Password**, type the
   password from the reset output, click **INITIATE SESSION**.
   (If you have reduced motion on, the role cards show at once.)
2. *Expect:* **CASES**. The queue lists the unreviewed referables (grade 2, Tier B, both branches
   agree) and any new case from scenes 3-6, with **CNN GRADE**, **RULE ENGINE**, **AGREEMENT**,
   **CONFIDENCE** and **TIER** columns. A branch disagreement is red **DISAGREE**.
3. Click a referable row (for example `PT-YHZMDW` from the reset table).
   *Expect:* the case is **CLAIMED BY YOU**. **GRADING COMPARISON**: CNN Branch A and Rule Engine B,
   "BRANCHES AGREE". Click **GRAD-CAM OFF** to turn the overlay on. Scroll: lesion evidence (red and
   bright lesions per quadrant), NV suspicion, AI evidence summary, confidence (for example 92%),
   **UNCERTAINTY** and **LESION-ATTENTION CONSISTENCY** read **NOT COMPUTED** (the pipeline does not
   produce them; that is honest, not a bug).
4. Scroll to **PATIENT / CAPTURE CONTEXT**. The **ENGINES** tile lists the engine of every output:
   quality gate, classifier, four segmentation models, rule engine. Mostly **MATLAB**; **SEG RED
   LESION** is **PYTHON**. A case from the phone reads **QUALITY GATE: JS-DEVICE** (scene 10).

*Recovery:* a blank page after login: reload once. "502 Bad Gateway from /api/v1/auth/login": the
central web app is pointed at the wrong backend port; run `demo-reset`. If a case is still
`processing` (no grade), wait 20-30 s and click **CASES** again.

## Scene 8: Confirm one case, override another (about 90 s)

1. On the agreeing referable, scroll to **CLINICAL DECISION & SAFETY AUDIT**. Click **CONFIRM** and
   then **SUBMIT CONFIRM (PRESS ENTER)**. The screen flashes green and returns to the queue; the case
   leaves the queue. (Confirm exists only when the branches agree.)
2. Open the other unreviewed referable. Click **OVERRIDE**. Choose **Corrected grade** 3 and
   **Override reason** "Wrong severity", type a short note, click **SUBMIT OVERRIDE (PRESS ENTER)**.
   It returns to the queue.

*Recovery:* if **SUBMIT** stays disabled, a required field (corrected grade, reason) is empty.
"Claimed by another reviewer": you are on the wrong login, or the case is claimed; pick another row.

## Scene 9: Referral (about 30 s)

Switch to the district admin: **LOG OUT**, choose **DISTRICT WORKER**, email
`admin@demo.netrasetu.local` and the admin password from the reset output.
Click **REFERRALS**.
*Expect:* **REFERRAL TRACKER** with one row per confirmed or overridden referable case (patient
reference, PHC, **DR GRADE**, **REFERRED**). The override shows **GRADE 3**, the disagreement case from
the reset shows **GRADE 4**. Status buttons **CONTACTED** / **LOST** are the follow-up actions.
*Recovery:* if a row is missing, the review was not submitted; return to the case (scene 8).

## Scene 10: Admin: dashboard, referrals, PHC health (about 75 s)

Same admin session.
1. **OVERVIEW**: the district summary. **DASHBOARD**: cases today / this week / total processed,
   average review time, **OVERRIDE RATE**, average confidence, weekly trend, cases by PHC.
2. **PHC HEALTH**: PHC Kharadi **ACTIVE**. A red banner reads "1 OF 4 CHECKS TRIPPED" because the
   seeded second site (PHC Wagholi) has never contacted central and is **SILENT**. Decide before
   recording whether to show this page (it is correct, but red). If you do not want the banner, do
   not open this page before a Wagholi case exists.
3. **RESOURCE PLANNING** reads "Simulation results not yet generated."

*Recovery:* a page that will not load after central was restarted: reload once.

## Scene 11: A mobile capture appearing in the queue (about 90 s)

Phone on the same Wi-Fi as the laptop, running the app with
`EXPO_PUBLIC_CENTRAL_API_URL=http://<laptop LAN IP>:5200` and the **new** PHC001 key from
`phc-local-app/backend/.env` (the key changes on every reset). Clear the app's data first
(Expo Go: Settings > Apps > Expo Go > Storage > Clear data). Setup steps: `phc-local-app/mobile/.env.example`.
1. Register a patient (all questions, consent). Import `idrid_010_good_pass_w1800.jpg` from the phone's
   gallery. Quality result appears on the phone. Answer the capture questions, press **SAVE & SYNC**.
2. The phone's queue goes **QUALITY PASS** to **SYNCED** to **RESULT READY** in about 30 s.
3. On the central **CASES** page (ophthalmologist login), the new case appears. Open it: the **ENGINES**
   tile reads **QUALITY GATE: JS-DEVICE**.

*Recovery:* "Cannot reach the central server": the phone is on another network, the LAN IP changed,
or Windows Firewall blocks node.exe on this network profile. A stale on-device setting overrides
`.env`: open **Menu > Device settings** on the phone and check the address and key. If the phone is
not available, `cd phc-local-app/mobile` and run
`EXPO_PUBLIC_PHC_API_KEY=<key> CENTRAL=http://localhost:5200 npm run test:sync` (the app's real sync stack
against live central) and show the case it creates; say that it is the automated stand-in.

---

## Setup steps that have no UI, so say them out loud

Two things a fresh PHC needs are command-line only. Nothing is broken; there is
just no screen to point at, so if the recording shows a PHC being set up,
narrate them rather than cutting to a working state and leaving a judge to
wonder how it got there.

- **Technician accounts:** `npm run technician -- add <username> "<Full Name>" [--admin]`
  in `phc-local-app/backend`. The password is generated and printed once.
  `demo-reset` already creates the demo technician, so you only do this by hand
  for an extra account. Worth a sentence, because the PHC login screen is real
  (bcrypt, sessions) and enforced by default -- the accounts simply come from
  the CLI.
- **Pairing a phone:** `npm run peer -- pair "Asha's phone"` on the PC, which
  prints a QR the phone scans. **Revoking is in the UI** -- the DEVICES screen
  in the PHC app lists every paired device and a PHC admin can cut one off,
  which is the half that actually matters if a phone is lost. So: pairing is
  CLI, revocation is on screen.

---

## Known behaviours to avoid surprising you on camera

- PHC desktop **does not show the grade**; it shows **RESULT READY**. The grade is a clinician's screen.
- Central's fonts fall back to the system font when this checkout's `node_modules` is a junction to
  another checkout (Vite refuses to serve them). A normal checkout is not affected.
- The quality gate is a fresh `matlab -batch` per capture (10-15 s). Fill that time with the narration.
