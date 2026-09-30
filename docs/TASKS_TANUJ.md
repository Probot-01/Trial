# Tanuj's task list — integration finish line

From `docs/INTEGRATION_AUDIT.md` (2026-09-29), split so you and Saad can work in parallel. Full evidence for every
item is in that file; this is the action list. Saad's half is `docs/TASKS_SAAD.md` — don't duplicate his items.
**All frontend work, both web apps, is deliberately kept under you** — one person on frontend beats two.

Deployment (Vercel frontends, Render backends, where the models and DB live) is explicitly **out of scope until
after the video** — do not spend time on it now.

Rule thresholds: **no action needed, already correct.** `models/rule_thresholds_by_red_version.json` is already
wired into both grading engines (`gradingOrchestrator.js:1455` → `caseRuleOpts()` → `runCasePipeline.m`), keyed by
whichever red-lesion model version actually produced the counts, so v2's counts already get v2's thresholds
(9/8/11/7), not v1's. `CLAUDE.md`'s "don't change thresholds" rule is already being honoured — this is wiring, not a
threshold change. The file you might be thinking of, `rule_thresholds_red_v2.json`, is a **different, unused**
proposal (12/4/5, Saad's `recalibrateRuleGate2.py`) that nothing reads — leave it alone, no decision needed.

---

## P0 — do first

### 1. Get the model weights to Saad (and anyone else who needs to run this)
1.5 GB under `central-system/backend/ml-pipeline/models/` is git-ignored and only on your machine. A fresh clone —
Saad's, or a judge's — cannot grade a single case without it.
- Put the whole `models/` folder (all `.mat`, `.pt`, `.onnx` — the tree `docs/RELEASE.md` lists with checksums) somewhere shared: a Drive folder, or zip it as a GitHub Release asset.
- Send Saad the link today — everything below depends on him having a working stack. **This link is the one thing here that's genuinely only yours to do** — nobody else has the files.
- ~~Optional but cheap: `scripts/fetch-models.js`~~ — **DONE, commit `<pending>`, pushed.** `npm run models:verify` (repo root) checks whatever's already on disk against `central-system/backend/ml-pipeline/models.sha256` (the same 27-file list from `docs/RELEASE.md`, now also tracked as a plain file instead of only markdown prose) — no network, no URL needed, tested against this machine's own files (27/27 OK, and tested the MISSING-file report by temporarily removing one). Once you have a share link, `npm run models:fetch` (or `MODELS_ARCHIVE_URL=<link> npm run models:fetch`) downloads and extracts it into place, then runs the same check. Send Saad the link plus "then `npm run models:verify`" — that's the whole instruction.

### 2. Twilio — wire it in
You said you have credentials. Put them in `central-system/backend/.env` (git-ignored, never commit them):
```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+1XXXXXXXXXX        # the Twilio number, E.164 format
SMS_DRY_RUN=                     # blank or delete the line — 1 means "don't actually send"
```
Restart the central backend after saving. Verify: get a case referred (the demo already produces one — the
disagreement/override case), check `notifications.status` in Postgres is no longer `dry_run`, and check your phone.
**If this is a Twilio trial account**, it can only text numbers you've verified in the Twilio console first — verify
whatever number you'll use for the demo before you need it live.

### 3. Central Profile & Settings pages show invented data
`central-system/frontend/src/components/shared/CentralProfileDrawer.jsx` — a fabricated personal email
(`krrishgadekar@gmail.com`), phone number, "Level 4 · District Chief", a fake badge code, "7 PHCs / 64 villages / 18
reports", an assigned-PHC list with 5 sites the system doesn't have (only Kharadi and Wagholi exist), "Last login
today, 9:12 AM from Pune". `CentralSettingsPage.jsx`'s toggles (PIN/fingerprint, Wi-Fi-only sync, low-data mode,
"Last synced") are stored in `localStorage` and do nothing.
- Bind the profile card to `GET /api/v1/auth/me` (name, email, role — real fields, already served) and
  `GET /api/v1/admin/phcs` (the real PHC list) instead of the hardcoded strings.
- Either wire the settings toggles to something real (language and theme already work) or delete the ones that
  don't and are not coming back (PIN unlock, Wi-Fi-only, low-data mode aren't relevant to a web app anyway).
- Also delete `FieldOpsPage.jsx` (`central-system/frontend/src/components/screens/`) — it's dead code with its own
  fake PHC list, not routed anywhere, just clutter.

### 4. Decide + do: which P1 desktop features make the cut
You said "no single preference, but priority" — here's mine, in order. Pick where to stop:
1. ~~**Ungradable / "best effort" path**~~ — **DONE, commit `335fedd`, pushed.** Desktop now offers "PROCEED AS UNGRADABLE" after 3 failed retakes, queues with `bestEffort: true`, central shows a "⚠ BEST EFFORT — FAILED LOCAL QUALITY GATE" badge on the case.
2. ~~**Use-existing-patient / capture-other-eye**~~ — **DONE, commit `4d91ac1`, pushed.** "USE THIS PATIENT →" on a matched duplicate row and "CAPTURE OTHER EYE →" on every queue row both navigate straight to `/capture?patientId=...` for the existing patient — no new patient record. Verified live: consent guard, questionnaire-completeness guard, and the happy-path navigation all fire correctly.
3. ~~**Hindi + Marathi i18n**~~ — **DONE, commits `c205849` (login screen) + `3ff215d` (full registration form), pushed.** Every string on the PHC registration screen is now behind `t()`: patient-info, address (all 37 state names), the full clinical questionnaire, consent block, duplicate-match card (including the matchedOn badges, which were a raw backend enum value), and footer buttons — ~100 keys, `hi`/`mr` verified 0 missing/0 extra against `en.json`. Verified live end-to-end in both languages (temporary technician account, screenshotted every section). Salutations and blood-group notation deliberately left untranslated (standard on printed Indian forms in any language).

Stop at whichever number you reach by tomorrow afternoon — 1, 2 and 3 are all done.

### 5. Mobile: build something installable
No `eas.json` exists — right now the only way to show the mobile app is Expo Go over Wi-Fi, which broke once
already when your laptop's IP changed. If the mobile app is going in the video:
- Build an APK (`eas build --platform android --profile preview`, needs a free Expo account) so it isn't tied to your Wi-Fi during recording.
- Or, if that's too much for the time left, just make sure the laptop has a fixed IP or hostname for demo day and accept Expo Go as the delivery method.

---

## Also yours (quick, whenever there's a gap)

- **Continual learning wording** — per your call, it's DB-only for this round (doctor corrections stored, no retraining). Find the note in `docs/system-design-v4.md` (§16 Tier 2, item 9 / §17) and `docs/backend-plan-status.md` (Continual Learning row) that implies it's wired, and make sure they say "corrections captured and exportable; retraining is a manual, future-round step" — not "dormant" or "planned but unclear." One sentence each, so nobody reading the docs cold thinks it's broken.
- ~~**Simulink validation table formatting**~~ — **DONE, commit `ae701f8`, pushed.** Also found and fixed while verifying it live: the seeded `admin@demo.netrasetu.local` account couldn't log in (401) — its password had drifted from the documented demo value. Re-ran `npm run seed-users` (central-system/backend) to reset it; worth re-running once more right before recording as a cheap sanity check.
- ~~**P2-2** (tracked `.pyc` cache files) and **P2-7** (PHC desktop's stale-session flash)~~ — **DONE, commits `75eb82e` (also has the rest of P2-8) and `758808b`, pushed.** Picked up straight from `INTEGRATION_AUDIT.md` §3 P2 since they weren't otherwise on this list; both verified live.
- **Open the PR** `integration` → `main` once you and Saad are both done and `demo-reset` + the runbook (`docs/DEMO_RUNBOOK.md`) pass clean. `origin/main` is currently 6 of your commits behind `integration`.
- **Decide before recording:** is the video showing the mobile app? (affects item 5's urgency) — and are you showing `/admin/phc-health` on camera? It currently shows a real "1 OF 4 CHECKS TRIPPED" banner because the seeded second PHC never contacts central. Correct, but red; `docs/DEMO.md` already flags this as a presenter's call.

## When you're both done

Run, in order: `node scripts/demo-reset.js` (must exit 0), then `docs/DEMO_RUNBOOK.md` scene by scene, twice. Log
anything that breaks in `docs/BUGLOG.md` (same format as the entries already there) and restart from `demo-reset`.
Then record.
