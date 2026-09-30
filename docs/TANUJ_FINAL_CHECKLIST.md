# Tanuj — final checklist

**2026-09-29, deadline tomorrow night. Both sides are done.** Saad has pushed and completed everything on
`TASKS_SAAD.md` (P0-1 auth-on-by-default, P1-2 MC-dropout genuinely wired on the MATLAB path, P1-5 npm audit
clean on both backends, all P2 items) — merged into this branch, re-verified (his `verifyCameraCalibration.m`
and `verifyPhase4.m` fixes both confirmed passing here, both frontends rebuild clean, the core backend suites
all still pass post-merge) and pushed. He also read `docs/STALE_CLAIMS_AUDIT.md` and fixed the `RED_LESION_MODEL_VERSION`
doc discrepancies it found. Everything below is what's left that's genuinely only yours — either it needs your
own credentials/decisions, or it needs a real phone in your hand. Evidence for every claim below is in the
commits on `integration` and in `docs/STALE_CLAIMS_AUDIT.md`.

---

## 1. Twilio — fixed, but re-test once more on your end

**What happened:** you'd put real credentials in `SIH_2026/.env` (the main checkout's repo root), which is a
different, independent file from `SIH_2026-integration/central-system/backend/.env` — `.env` is git-ignored, so
every worktree has its own copy, and `dev-up.js`'s root-`.env` fallback is only used for its own console output,
never actually forwarded into the spawned server's environment. Copied your real values into the file this
worktree's server actually reads, restarted it, and confirmed at the code level `SMS_DRY_RUN=0` is handled
correctly (strict `=== '1'` check, no truthy-string bug).

**Verified live, end to end, with a synthetic (non-real) recipient number so nothing hit a real phone:** submitted
a case, confirmed it in the review queue, and got back `"smsStatus":"failed"` — no longer `dry_run`. Checked the
actual notification row: `error_detail` is Twilio's own real API response, "The number +91999999XXXX is
unverified. Trial accounts cannot send messages to unverified numbers..." — this is the correct, expected result
for a fake test number on your trial account. It proves the whole chain end to end: real credentials, a real API
call actually reaching Twilio, a real (redacted) error back, and the referral correctly falling back to manual
follow-up per design §10.5 rather than silently losing the case. (One earlier attempt still showed `dry_run`
because the server process hadn't picked up my restart yet — traced and fixed with a clean kill+respawn,
confirmed `isConfigured()` returns `true` in a fresh process load before retesting.)

**What's left for you:** send yourself one real referral through the actual demo flow and check your phone,
since that's the one thing I deliberately did not do (an SMS to your real verified number costs a credit and I
don't send messages on your behalf without asking). Everything up to that point is confirmed working.

## 2. Mobile — specific steps for your phone

**Already fully proven without your phone, so you're not starting from zero and don't need to re-check these:**
every mobile test suite was re-run today against this live stack — phone↔PC peer sync (continuous replication,
power-cut resilience, USB bundle fallback: 12/12), pairing/revoke/TLS (24/24), phone↔central direct upload
(happy path, chunked upload, offline queueing, idempotent resend, failed-data handling: 9/9), the mobile unit
suite (28/28), and the mobile quality-gate parity check against the same MATLAB reference (all passed, largest
score difference 2.55e-3). None of these needed a fix.

**What only a real phone can tell us — do these, in this order, and report back what you see:**

1. **Fixed address check.** Run `ipconfig` (or check your router) and confirm the laptop's LAN IP hasn't changed
   since the phone last paired — it changed once before (per `docs/DEMO.md`) and broke a saved server address.
   If it changed, re-pair or update the saved address in the app.
2. **Cold open in Expo Go.** Scan the QR / open the dev URL, let the app load fully. Report: does it load at
   all, how long does it take, any error banner on first screen?
3. **Login.** Use the paired-PC path if already paired, or a dev/offline account if not. Report: which path
   fired, did it succeed.
4. **Register a new patient** (or use an existing one) through the mobile UI — full questionnaire, consent.
   Report: any field that behaves oddly, any validation message that seems wrong.
5. **Capture a real fundus image** with whatever camera/lens setup you'll actually use in the demo (phone
   camera, or phone + fundus lens attachment). This is the one thing I structurally cannot test from here — the
   desktop app's "camera" is a file picker, but the phone app really does need to drive a camera. Report: does
   the camera view open, does the lens attachment (if used) focus/frame correctly, is the shutter/capture
   button responsive.
6. **Quality gate result.** After capture, the phone runs its own on-device quality check (`js-device` engine,
   not MATLAB). Report: what verdict you get (pass/borderline/retake), and whether the score/reason shown looks
   sane for the image you actually took.
7. **Sync.** With the PC reachable, confirm the capture appears in the PC's local queue within the normal ~15s
   replication window. Then, if you want to test the outage path: turn off Wi-Fi on the phone, capture one more
   patient, turn Wi-Fi back on, confirm it syncs once reconnected without you doing anything else.
8. **End to end to a grade.** Let one real phone-captured case ride all the way to central and get graded, then
   open it in the ophthalmologist queue from a browser and confirm the image, capture metadata, and engine
   provenance (should read `js-device` for the phone's own quality gate, `matlab`/`branchA_v2c` for the
   classifier) all look right.

Build an installable APK first if the demo needs the app off Wi-Fi (`eas build --platform android --profile
preview`, needs a free Expo account) — otherwise a fixed IP/hostname plus Expo Go is fine and cheaper right now.

## 3. Model weights to Saad — moot now

He finished everything on his list without needing them (PHC auth default, npm audit, MC-dropout — he found his
own way to wire it on the MATLAB path, and the P2 items). Nothing to send.

## 4. Deployment — still explicitly parked

Unchanged: Vercel/Render/where the DB and models actually live is out of scope until after the video.

## 5. One thing I couldn't finish: the quality-gate compiled executable

Tried twice (including a MATLAB toolbox-cache refresh in between) — both times `mcc` fails during dependency
analysis on an unrelated MATLAB toolbox file (`internal.matlab.importtool...uiimportFile.m`) that exists on disk
and resolves fine under `which`, but that `mcc`'s static crawler can't cross-resolve. This looks like a
Compiler-specific quirk on this machine's `D:\`-rooted, manually-patched MATLAB install (per your earlier
Compiler setup notes), not a project code problem. **This doesn't block anything** — `matlab -batch` (the
fallback path) works correctly and is what every real capture in the walkthrough used today, including the
already-fixed same-machine timeout issue (see below). If you want the `.exe` for real, the next thing to try
would be a clean MATLAB Compiler reinstall or running the build on a different MATLAB install, not another
retry here.

## 6. Decisions before recording

- **Is the video showing the mobile app?** Affects how urgent §2 is tonight.
- **Is `/admin/phc-health` on camera?** Real "1 of 4 checks tripped" banner (seeded second PHC never contacts
  central) — correct, but red. Your call to present or avoid, per `docs/DEMO.md`.
- **The corrected v2c numbers in `docs/STALE_CLAIMS_AUDIT.md` §3.1** — only relevant if you want to correct a
  slide or answer a judge's question with current figures instead of `system-design-v4.md`'s stale ones.

## 7. The last step — you're the only one left

Saad's side is done. Once you've done §1 (real Twilio test) and §2 (mobile on your phone): `node
scripts/demo-reset.js` (must exit 0), then `docs/DEMO_RUNBOOK.md` scene by scene, twice, restarting from
`demo-reset` between runs. Log anything that breaks in `docs/BUGLOG.md`. Then open the `integration` → `main` PR.
Then record.

---

## Reference: the full test pass done today (for context, not action)

**Every Node test suite in the repo was run, not sampled** — 16 root `verify_*.js` scripts, all of PHC backend's
and mobile's `.test.js`/`.test.mjs` files, `verify_peer_device_admin.js` (via a temporary isolated auth-enabled
instance), `verify_mobile_quality_gate_parity.mjs`. All clean after fixing the same class of portability issue
already known elsewhere (stale hardcoded paths/ports/patient IDs/credentials — never a logic change), except one
**real bug**: `caseClinicalInputs()` in `gradingOrchestrator.js` let `Number(null) === 0` slip through as a false
"measured, 0 years diabetic" instead of honestly falling through to the bucket-substitution and labeling it
"assumed" — silently affecting every real registration, since the current intake forms never collect a raw
years-diabetic number. Fixed, confirmed against a real stored case, `verify_urgency_inputs.js` now 11/11 (was
10/11).

**The full MATLAB test suite (17 files) was run.** 12 fully clean. 2 already-known-red with root cause now
confirmed (`testCalibrationPhase6`'s stale check; `verifyPhase4` — genuinely missing Computer Vision Toolbox on
this machine, confirmed via the exact missing function). 1 newly-found stale test
(`verifyCameraCalibration.m`'s DoD check calls the default `model1` recipe, which deliberately never applies
camera calibration to Branch A's pixels — a design choice with its own explicit code comment, not a bug; the
test predates that recipe and checks the old `legacy`-only behavior. Not touched, per "never weaken or delete a
test" — flagging for your judgment instead). 2 need explicit file-path arguments by design (one-time
porting-verification tools, not bare regression tests). 1 blocked on a missing PyTorch Converter support
package.

**A full, real (no mocks, no scripts standing in for a person) desktop walkthrough**, done in the browser:
registered a real patient with the full questionnaire, uploaded a real IDRiD fundus image through the actual
file-picker capture flow, got a real MATLAB-graded "borderline quality" result with honest engine provenance
shown, filled real capture metadata, synced to central, watched it get graded (grade 2, agree), opened it in the
ophthalmologist queue, read the real evidence text and provenance chain (`branchA_v2c` via MATLAB), and
confirmed the review — the case correctly left the queue afterward. This also directly re-confirmed a bug the
2026-09-25 `ppt-audit` found (a `ReferenceError` on this exact save step) is genuinely still fixed.

**A genuine, demo-relevant bug was found and fixed along the way**: a cold `matlab -batch` start for the PHC
quality gate was timing out at 30s specifically when central's persistent classification session is also
resident on this same laptop (measured directly: 30.9s under that contention) — exactly this machine's setup,
and exactly what tomorrow's demo will look like if both apps run together. Bumped to 60s and fixed the error
message, which used to report this as an unexplained crash instead of naming the timeout.

**One more environment trap found and fixed**: running central's backend under `nodemon` (as opposed to the
plain `node server.js` `dev-up.js` actually uses) puts it into an endless restart loop — nodemon's default watch
picks up `ml-pipeline/inference/{matlabSession,segSession}/*.heartbeat`, which the persistent MATLAB/segmentation
sessions update constantly, as "file changes" and restarts on every tick, interrupting every in-flight grading
job before it can finish. This doesn't affect your normal `npm run dev:all` (which spawns `node server.js`
directly, bypassing nodemon entirely) but would bite anyone who runs `npm run dev` inside
`central-system/backend` standalone. Added `central-system/backend/nodemon.json` to ignore those files; the rest
of tonight's central-backend testing ran on a plain `node server.js` process instead, matching how it actually
runs in the real stack.
