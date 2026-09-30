# Stale-claims audit — what the docs say vs. what the code does right now

**Date:** 2026-09-29. **Trigger:** Tanuj noticed a task-list item (`system-design-v4.md`'s grade-4 recall
figure, driving a "schedule the M1 v2 retrain" roadmap line) was actually already resolved by the deployed
model, and asked: is this bigger than the integration task lists? It is. This file is the answer — a sweep of
`docs/TASKS_SAAD.md`, `docs/TASKS_TANUJ.md`, `docs/system-design-v4.md`, `docs/api-contracts.md`,
`docs/backend-plan-status.md`, `docs/ppt-audit/*.md`, and `docs/NetraSetu_Build_Audit.md` against the actual
running code, re-verified today rather than trusted from any doc's own word.

**This file does not edit any of the docs above.** Per Tanuj's instruction, `system-design-v4.md` is untouched;
corrections live here instead, each with the exact line/claim they apply to, for a deliberate decision on
whether and how to fold them back in.

**Method:** every finding below was checked directly — `grep`/`cat` against live `.env` files and source code, or
by re-running `scripts/audit/eval_idrid_test.py` fresh (read-only inference; no weight file was touched, per
`CLAUDE.md`'s non-negotiable). Where a doc already contained the correct current information, that's noted so
this file doesn't duplicate good work. Where two docs disagree, both are cited and the code is the tiebreaker.

---

## 1. How to read this

| Tag | Meaning |
|---|---|
| **DONE-NOT-MARKED** | The task list says open; the code shows it's already fixed. |
| **METRIC-STALE** | A specific number in a doc was measured on an old model/split and never re-run after the model changed. |
| **VERSION-DRIFT** | Docs disagree with each other and with the code about which model/config is actually active. |
| **DOC-VS-DOC** | Two of the project's own docs contradict each other, independent of the code. |
| **SUPERSEDED-WHOLESALE** | The entire file is old enough that spot-checking individual lines isn't the right unit — don't use it without re-auditing. |
| **STILL OPEN** | Checked and confirmed still accurate / still needs the work. Listed so it's clear this file isn't just good news. |

---

## 2. Task-list items already done but still marked open

| File | Item | Status |
|---|---|---|
| `TASKS_SAAD.md` P2 | "Tracked `__pycache__/*.pyc`... `git rm --cached` them" | **DONE-NOT-MARKED.** Fixed in commit `75eb82e` (this session, Tanuj's side) without anyone updating Saad's file. `git ls-files \| grep __pycache__` = 0 right now. |
| `TASKS_TANUJ.md` (already corrected in this session before this file existed) | Simulink table floats, best-effort path, use-existing-patient, i18n, PHC session flash | All confirmed DONE with live verification — not re-litigated here, just noted for completeness so this file's silence on them isn't read as "unchecked." |

Everything else on both task lists was individually re-verified against current code and is **STILL OPEN**,
confirmed accurate as written:

- Saad P0-1 (PHC `LOCAL_AUTH_ENABLED=false`) — confirmed still `false` in both `.env` and `.env.example`.
- Saad P1-2 (MC-dropout null under MATLAB) — `branchAInferMatlab.m:345` still hardcodes `'uncertaintyScore', []`.
- Saad P1-3 (quality-gate `.exe`) — `quality-gate-matlab/dist/` still doesn't exist.
- Saad P1-4 (hardcoded verify-script paths) — `verify_fovea_e2e.js`/`verify_demo_dryrun.js` still reference `C:\Users\91740\...`.
- Saad P1-5 (`npm audit`) — PHC backend matches exactly (1 high + 3 moderate); central backend now shows 5 moderate vs. the audit's "4" (a dependency advisory changed since, not a stale report — still open either way).
- Saad P2 (repo clutter, encryption/backup note, pairing UI) — all confirmed still present/missing as described.

---

## 3. `system-design-v4.md` — stale metrics and a stale severity claim

**Not edited, per instruction.** Every line below is quoted from the live file with its line number; the
correction and evidence sit beside it.

### 3.1 Classifier metrics (§15 "Metrics & Validation Plan", mirrored in §17 "Risks")

The root cause is the same for all three: `models/evaluation_branchA_v1.mat` (a named artifact in
`RELEASE.md`'s own checksum list) is where these numbers come from — measured once against **`branchA_v1`**,
frozen into the design doc, and never re-run after `branchA_v2c` became the default on 2026-09-23
(`backend-plan-status.md`, "Classifier: branchA_v1 (384 px) -> branchA_v2c (512 px)"). `docs/ppt-audit/02-ml-and-data.md` already caught this on 2026-09-25 (its own §6.1 "V4-STALE" table) and it was never folded back into v4.

| v4 claim | Line | v1 (what's quoted) | v2c (deployed, actually measured) |
|---|---|---|---|
| "Grade-4 (proliferative DR) recall is the ship-blocking finding: 0.444" | §15 | 0.444 | **1.0 (13/13)** on the 103 official IDRiD test images (`docs/INTEGRATION_AUDIT.md` §5, and reproduced fresh today: `python scripts/audit/eval_idrid_test.py` → `grade4_recall: 1.0, n_grade4: 13`). On the larger pooled 628-image set (contaminated by calibration overlap, see 3.2) it's **0.574** — still far above 0.444, but not 1.0. Pick the population before quoting either. |
| "Grade-1 recall is 0.000... only 4 true grade-1 cases" | §15 | 0.000 (n=4) | **0.5** (n=4, IDRiD-only, `ppt-audit/02` §6.1) or **0.55** (n=60, pooled, §3.1). On the 103-image official test set specifically: **0.40** (2/5, reproduced today). Never 0.000 under v2c on any population checked. |
| "QWK... 0.8242 on IDRiD alone" | §15 | 0.8242 | **0.8559** (IDRiD-only, n=78, `ppt-audit/02` §3.1) / **0.841** (103-image official test, reproduced today). |
| §16 Tier 1 item 2: "schedule the M1 v2 retrain as soon as GPU access allows" | §16 | — | **This roadmap line is moot.** The grade-4 recall crisis it was written for is resolved by the model already shipping. If there's a real reason to retrain further (e.g. genuinely clean held-out re-validation, or the specificity gap below), it's a different justification than this one. |

**Caveat that applies to all three v2c numbers above, stated plainly (from `INTEGRATION_AUDIT.md` §5 and
`ppt-audit/02` §0.4):** the shipped calibration (temperature, conformal qhat, referable threshold) was fitted
on a pool that includes the 628 or 103 test images being scored, so these are optimistic, not a clean
held-out result. What they do establish: the deployed model is not broken and the specific 0.444/0.000 figures
are definitely gone. What they don't establish: a clean, publication-grade number. Also still true and *not*
contradicted by any of the above: **specificity (82.1%) remains below the >85% PS target** even though
sensitivity clears it (100%/96.9%) — this part of the picture hasn't changed.

### 3.2 §17 "There is currently no authentication anywhere in this system. **The single most severe limitation**"

Also §16 Tier 1 item 1: "Authentication and access control — currently completely absent across every app,
ahead of any accuracy concern."

**METRIC-STALE, but for a system property, not a number.** `docs/ppt-audit/05-security-reliability.md` §0
already flagged this exact line as "V4-STALE" on 2026-09-25 ("It says 'this system has none — no login route
in any application, no auth middleware.' That's no longer true"), and it's gotten *more* true since:

- **Central:** `AUTH_ENABLED=true` in the live `.env`; verified this session by logging in as both
  `district_admin` and `ophthalmologist` through the real `POST /api/v1/auth/login` (bcrypt-checked, real
  401 on a wrong password). The ppt-audit's own separate claim that "central login is fake... any password of
  4+ characters" (`ppt-audit/04` §0.8, and `ppt-audit/05`) is **itself now stale**: `EyeJourneyLogin.jsx`'s
  `demoCheck()` shortcut only fires when `USE_MOCK_DATA` is true (`DATA_MODE=mock`), which is not the default
  — `config.js:23`: `DATA_MODE === 'mock'`, and `rawMode` defaults to `'live'`. In live mode `submitLogin`
  calls the real endpoint. Same fix applies to the "no `credentials: 'include'`" claim — `centralApiClient.js`
  sends it on every request now.
- **PHC desktop:** real bcrypt/session code exists and works (`routes/auth.js`, `GET /auth/me`, used directly
  this session to test P2-7's stale-session fix) — it's switched **off** by default (`LOCAL_AUTH_ENABLED=false`).
  That's Saad's P0-1, correctly scoped there as a config flip, not "build auth." Calling it "completely absent"
  here is a much bigger claim than the real gap.
- **Mobile:** `AuthContext.tsx` calls a real `/peer/login` against the paired PC's real technician accounts,
  with an honest offline-cache and dev-account fallback chain (not a silent success fabrication).

**Net:** the single most severe limitation, if it's a config-default problem, is Saad's P0-1 alone. The v4
sentence as written overstates it into "nothing works," which isn't a small wording issue if it ends up on a
judge-facing slide claiming the opposite of what's true.

### 3.3 Vessel segmentation domain-shift claim — the one finding that runs the *other* direction

§6.5 / §15: "out-of-domain performance (0.8136 Dice) matches in-domain performance (0.8024 Dice)... once a
per-domain threshold is applied." Flagged by `ppt-audit/02` §6.1: **0.8136 is DRIVE scored with thin vessels
(GT half-width ≤1px) excluded as don't-care — not a threshold result.** The true DRIVE Dice is **0.6186**. The
live vessel threshold is a fixed 0.5 (`segInfer.py:326`), not a per-domain one. **This is the opposite kind of
error from the others in this file: v4 is falsely optimistic here, not falsely pessimistic.** Domain shift on
vessel segmentation is not actually resolved the way §15 implies. Worth knowing before it's used to argue the
system generalizes well.

### 3.4 Other `ppt-audit/02` §6.1 "V4-STALE" findings, spot-checked, still standing

These weren't independently re-verified as deeply as 3.1-3.3 above but are consistent with everything else
found in this sweep, so they're carried forward as likely still accurate (source: `ppt-audit/02-ml-and-data.md`
§6.1, dated 2026-09-25):

- "Messidor-2 external validation has never been run" (§15, §17) — it was, for v2a/v2b/v2c.
- Messidor-2 "never used in training or model selection" (§14) — the selection half was used for model selection.
- NV suspicion score "has never been measured" (§15, §17) — it was: AUC 0.2863 (IDRiD) / 0.3793 (Messidor-2),
  **both below chance**. It's measured *and failed*, a different and arguably more important fact than "unmeasured."
- Fovea gate "specified, not yet built" (§16) — built, threshold 0.37, with a validation report.
- Conformal method switch (§18 open item) — switched to `ordinal_mode_interval_stratified_v3`, though only 2
  strata are actually implemented (non-referable/referable), which is itself a V4-MISSING gap against the
  "class-conditional" description — so this one is half-resolved, not fully.

---

## 4. Model-version bookkeeping disagrees with the code (VERSION-DRIFT)

**`RED_LESION_MODEL_VERSION` defaults to `v2` right now** — confirmed directly: `segInfer.py:116`:
`os.environ.get("RED_LESION_MODEL_VERSION", "v2")`, and neither `central-system/backend/.env` nor
`.env.example` overrides it. This is the 3-class MA/HE split model (`red_lesion_unet_v2.pt`), not the
single-class red-lesion model.

Three docs currently disagree with this and with each other:

| Doc | Claim |
|---|---|
| `backend-plan-status.md` (one line) | "M5 v2 (3-class red lesions)... **Now the default**" — correct |
| `backend-plan-status.md` (a different, later-looking line) | "M5 v2... Merged behind `RED_LESION_MODEL_VERSION`, still **v1**" — **DOC-VS-DOC, contradicts its own other line** |
| `TASKS_TANUJ.md` (this session's own file) | "still v1" — **wrong, matches the stale line above, not the code** |
| `api-contracts.md:462` (dated "as of 2026-09-20") | "`microaneurysms` and `hemorrhages` are `null`... M5 detects red lesions as a SINGLE class today... They become real numbers when Tanuj's 3-class retrain lands" | **Stale.** The retrain has landed and is the default. `services/lesionCounts.js`'s mapping (`toContractShape`) already reads `stored.maTotal`/`stored.heTotal` and emits real numbers whenever they're present — confirmed by reading the code, not assumed. Any case graded right now under the default config should already return non-null `microaneurysms`/`hemorrhages`, not null. |

**Confirmed live, not just theoretical:** queried the central Postgres DB directly
(`segmentation_outputs.lesion_counts`) — every stored row checked carries `"redLesionModelVersion": "v2"` with
real, non-zero `maTotal`/`heTotal` (e.g. one real case: `maTotal: 45, heTotal: 15, redTotal: 41`). So this
isn't a "should be fixed by now" — it's already happening on every case in the live database. If a screenshot
or the demo shows `microaneurysms`/`hemorrhages` as real numbers, that is correct and matches the database, not
a bug against the stale `api-contracts.md` line. `api-contracts.md:462`'s "as of 2026-09-20... null" note should
be updated (or dated-and-superseded) whenever contract doc edits are next in scope — it's simply wrong today.

---

## 5. `docs/ppt-audit/*.md` — itself partly stale now, in the opposite direction

Six files, ~296KB, one commit (`f9a406d`), dated 2026-09-25/26, never touched since. Built with real rigor —
it's the source for most of the corrections in §3 above — but **some of its own "this is broken" findings have
since been fixed**, which matters just as much: if someone treats this directory as the current punch list,
they'll re-do already-done work, or worse, tell a judge something is broken/mock when it no longer is.

**Confirmed fixed since 2026-09-25 (checked directly against current code):**

- `ppt-audit/04-frontend-mobile-sync.md` §0.1: "Both web front-ends run in MOCK mode by default... unless
  `VITE_USE_MOCK_DATA` is the string `false`" — **fixed.** Both `central-system/frontend/src/config.js` and
  `phc-local-app/frontend/src/config.js` now default to `DATA_MODE='live'`, gated by the string `'mock'`
  specifically, not the old always-mock-unless-opted-out pattern.
- `ppt-audit/04` §0.2: "Even in real mode, most web calls fall back to mock data on any error" — **fixed** for
  the central client at least: `centralApiClient.js`'s catch path throws `ApiError`, no mock fallback found.
  (Not independently re-checked for every one of the specific screens the audit lists — worth a targeted
  re-check if this is going in front of judges, rather than trusting either this file or the old audit.)
- `ppt-audit/04` §0.4: "The last step of PHC desktop capture is broken at HEAD... `questionnaire`... never
  declared... ReferenceError" — **fixed.** `CaptureScreen.jsx:51` properly declares
  `const [questionnaire] = useState(...)`, with an honest error path (`IncompleteAnswers`) when none exists
  for the patient, not a crash. **This was the highest-stakes item in this whole sweep to check** — a live
  demo-breaking bug, now confirmed not present.
- `ppt-audit/04` §0.8: "Central login is fake... `AUTH_ENABLED` is off" — **fixed**, see §3.2 above.
- `ppt-audit/04` §0.9: "Delete the stale code... `phc-local-app/mobile/src/` is the old app" — **already
  deleted.** `ls phc-local-app/mobile/src` → no such directory.
- `ppt-audit/05-security-reliability.md` §0.5: "The segmentation worker is broken... `KeyError: unknown model
  role 'bright_lesion'`" — **not re-checked in this sweep** (would need the worker actually running); flagged
  here only so it isn't assumed fixed just because neighboring items were.

**Confirmed still accurate (spot-checked, not just carried over):**

- `validatedCameras.json`'s `"validatedBy": "DEMO SEED -- NOT A REAL VALIDATION"` — exactly matches
  `ppt-audit/04`'s claim, word for word. Still one seeded camera, still not a real validation.
- The MathWorks toolbox installed-vs-licensed gap (`ppt-audit/03`) — not re-checked this session, no reason
  to think it changed (needs a fresh `matlab -batch "ver"` to confirm either way before quoting on a slide).

**Recommendation for this whole directory:** treat every individual claim in `ppt-audit/01-06` as needing a
fresh check before it goes on a slide or gets acted on as a to-do — same rule the files themselves state about
trusting markdown docs. It was excellent, rigorous work for 2026-09-25; it is not a living document and nobody
has re-run it since.

---

## 6. `NetraSetu_Build_Audit.md` — superseded wholesale

**SUPERSEDED-WHOLESALE.** Dated **2026-09-11** (18 days before this sweep) and audited against
`system-design-v3-final.md`, the design doc version that v4 itself supersedes. Its own opening line says
"the project is materially further along than its own most recent planning docs admit" — true then, and
almost certainly *more* true now, three weeks and (per this sweep alone) dozens of fixes later. Nothing in it
was individually re-checked for this file; it's flagged here as a category, not a line-by-line source, because
its baseline (v3, pre-v2c, pre-auth, pre-i18n-work, pre- everything this session did) is too far behind to be
worth reconciling claim-by-claim. If anyone opens it looking for current status, the first thing to know is
that it predates most of what's true today.

---

## 7. Not audited in this sweep — flagged as a category, not cleared

Given the size of the remaining doc surface, these were **not** individually verified and shouldn't be assumed
either stale or current:

- `docs/implementation-plan-backend-ml.md`, `-backend-saad.md`, `-frontend.md`, `-frontend-team.md`,
  `-ui-kankshi.md` (and their tracked `(1).md` duplicates, already on the repo-clutter list) — task
  assignments for Kankshi, Krrish, Vedant, Parth. Whether these are current depends on whether those
  teammates are still active on this deadline, which this sweep has no visibility into.
- `docs/RUNTIME.md`, `docs/COMMANDS.md`, `docs/SECURITY.md` — reference docs that could drift the same way
  if a command or a security claim changed since they were written; not checked here.
- `docs/system-design-v3-final.md` itself — superseded by v4 by definition; only a risk if something still
  points to it as current (nothing found doing so in this sweep, but not exhaustively checked).

---

## 8. Decisions this file surfaces but doesn't make

- Which grade-4/grade-1/QWK numbers (and which evaluation population) should actually go on a slide or into
  a corrected v4, given the calibration-contamination caveat in §3.1.
- Whether to fold the §3 corrections back into `system-design-v4.md` now, later, or not at all before the
  video (explicitly held out of scope for this file, per instruction).
- Whether it's worth re-running `ppt-audit`'s methodology fresh before the video, given how much of it has
  already flipped in both directions since 2026-09-25.
