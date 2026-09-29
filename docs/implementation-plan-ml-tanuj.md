# ML Implementation Plan — Tanuj (+ Claude Code)
## NetraSetu, National Round — derived from system-design-v4.md

**Scope:** You own the trained model files and every piece of validation-metric-tuned classical-CV logic — conformal prediction, camera-fingerprint calibration, the neovascularization suspicion score, fovea reliability, and two new lesion-signal detectors. You do not own how any of these get *called* from the orchestrator, the rule engine's if/else structure, or anything in the Node.js backend — that's Saad's. Everywhere your file's output feeds his code, this plan states the exact field name and shape so he can build against it without waiting for you, and so you're not guessing what he needs.

**Scope clarification, since it's come up directly: "MATLAB conversion" in this plan means Branch A only.** Branch A's move to a MATLAB-served ONNX import is done (§0). Segmentation (vessel, optic disc/fovea, lesion models — M2 through M5) stays Python-trained-and-served — this was an explicit decision from the same session that moved Branch A, not an oversight, and it's a decision this plan doesn't revisit: a separate proposal to replace trained segmentation models with a MATLAB/Frangi-only heuristic was considered and rejected elsewhere in this project specifically because it risks degrading an already-fragile microaneurysm pipeline. Nothing in this plan asks you to convert M2–M5 to MATLAB.

**Also don't re-attempt this:** MATLAB's direct `importNetworkFromPyTorch` converter was tried on Branch A and produced garbage (8–11% class agreement, −0.25 correlation) despite the network looking structurally fine. The ONNX-export-then-import path is what actually works and is what's live. If anyone suggests the direct converter again for a future model, this is a known dead end, not worth re-testing.

---

## 0. Already done — do not re-touch

- **ONNX conversion status correction — check this today, it's blocking Saad.** An earlier pass of this plan said all 5 models were exported and imported into MATLAB with verified parity, based on the session where `branchA_v1`, `vessel_unet_v1`, `localization_v1`, `bright_lesion_unet_v1`, and `red_lesion_unet_v1` were all run through `torch.onnx.export` → `importNetworkFromONNX` and parity-checked at 2e-6 to 4e-5 against 10 real IDRiD images, with the `+<modelname>/` custom-layer package folders correctly identified and copied alongside each `.mat`. **That work happened, but the artifacts aren't in the shared repo Saad is actually working from** — his `models/` folder has `vessel_unet_v1.onnx` and `localization_v1.onnx` (the export step, but no `.mat` — the import step either didn't run in that environment or the output wasn't committed) and **nothing at all** for the bright-lesion model. Check your local files from that session first — if the `.mat` files and the bright-lesion `.onnx` exist locally, commit and push them immediately, this is the fastest fix. If they genuinely don't exist anywhere, the import step (for vessel/localization) or the full export-import-parity sequence (for bright-lesion) needs redoing before Saad can build anything on top of it — he's explicitly blocked on this in his plan (§S) until you confirm one way or the other.
- **Grad-CAM + the lesion-attention consistency safeguard.** Confirmed real and live, validated (n=12, expected-direction confidence drop on all 12 cases). No further work needed here.
- **Once M2/M3/M4's artifacts are actually in place, parity-check more than tensors.** Tensor-level agreement (2e-6 to 4e-5) doesn't guarantee identical *downstream discrete outputs* — a per-pixel difference small enough to be invisible at that scale can still flip whether a borderline connected component gets counted as a blob, which changes a lesion count, which can change the rule engine's output grade. For every segmentation model you verify, also confirm the final lesion counts and the resulting rule-engine grade match between the Python and MATLAB paths on the same reference images — not just the raw tensor output. Treat any discrepancy here as blocking, the same way a tensor-parity failure would be.
- **M5's conversion needs doing fresh regardless of how the above resolves.** Whatever state its current conversion is in, it reflects the *current* 2-class merged model, which the retrain in §4 replaces with a new 3-class architecture. Once that retrain lands, the export→import→parity-check process needs running against the new checkpoint, not the old one — don't let anyone treat an existing M5 conversion as reusable.
- **The interim grade-3/grade-4 safety check** (`P(grade3)+P(grade4) > 0.5` forces referable regardless of argmax) is already live and doing real work — 5 currently-missed PDR referrals recovered by this check. **Make sure your M1 v2 retrain and rollout keeps this check in place** until the retrained model's own grade-4 recall is validated as good enough to retire it. Don't let a model swap silently drop this safety net.

---

## 1. M1 v2 Retrain — Ship-Blocking Priority

Current state: grade-4 (PDR) recall is 0.444 on the real, non-contaminated held-out split — 5 of 54 true PDR cases fall below the referral threshold entirely. Root cause: 384px input resolution can't resolve the fine neovascular structures separating grade 3 from grade 4. The v2 notebook is already built and unit-verified (forward/backward pass, loss asymmetry, weight-ordering reversal all confirmed) — **not yet executed**, pending GPU.

1. **Open decision, not yet resolved — make this call before anything else in this section:** Kaggle's free T4, or the college's 96GB card. Kaggle is available immediately with no dependency on anyone else; the college card is more capable but its actual availability (queue, approval, shared access) isn't confirmed. Pick one explicitly rather than letting this stay undecided — it's the actual blocker on this entire item, not remaining design work.
2. Run the v2 training: 512/640px input, dual head (5-class ordinal + a separate binary referable head), EyePACS data for the binary head only (Messidor-2 stays untouched, reserved for external validation — don't accidentally train on it), cost-sensitive/ordinal loss, corrected grade-4 class weighting, locked sensitivity threshold (target ≥90%).
3. **Validate specifically on grade-4 recall, not pooled QWK** — pooled QWK is insensitive to 54 images out of 628 and will look fine even if grade-4 recall hasn't actually improved. Report grade-4 recall as its own number in every validation pass on this model.
4. **Mandatory last step, not optional:** once v2 is trained, a full conformal recalibration against v2's output distribution is required before it goes live — a new `qhat` fit against the new model's probabilities, not the old one reused. `calibration_v1.json` already carries a `trainedImgSize` field, and both inference paths already refuse to apply calibration if it doesn't match the loaded model's actual input size — this guard exists specifically to catch exactly this kind of mismatch, so don't work around it; make sure the new calibration artifact actually has the correct `trainedImgSize` for v2.
5. **Also mandatory:** repeat the exact ONNX-export → MATLAB-import → parity-check process already used for v1 (see §0) against the new v2 checkpoint — a new `torch.onnx.export`, a new `importNetworkFromONNX`, a fresh parity check against real images, and confirming the `+<modelname>/` package folders for the new model are copied into `models/`. The v1 `.mat` file currently serving live traffic needs to be replaced by the v2 one, not run alongside it.
5. Report kappa as **IDRiD-only**, not pooled with APTOS, in any validation claim for v2 as well as v1 — APTOS is easier and inflates the number.
6. **Before quoting any performance numbers publicly (PPT, judge Q&A), confirm the referable-DR sensitivity/specificity figures (currently cited as 86.0%/93.8%) come from the same recovered, non-contaminated split as the corrected kappa (0.8242) and grade-4 recall (0.444).** These three numbers were established at different points, and it isn't confirmed here that sensitivity/specificity were measured on the same clean split rather than an earlier, possibly-contaminated one. If they weren't, re-measure them on the recovered split the same way kappa and grade-4 recall were corrected — don't present a mix of a freshly-corrected number next to a stale one without checking they're comparable. These should not be treated as the *only* numbers presented, either — sensitivity/specificity for referable DR is the PS's own primary target and belongs alongside kappa and grade-4 recall, not instead of them.

---

## 2. Conformal Prediction — Fix the Nonconformity Score

Confirmed current state: `conformalCalibrate.m:35` computes `s_i = 1 - p_i(true grade)` and `conformalCalibrate.m:104` fits **one global scalar** `qhat` pooled across all grades; `conformalTiering.m:85` applies that single threshold to all 5 classes. This is a plain (marginal, LAC-style) score — correct for a generic multiclass problem, wrong for this specific 5-class *ordinal* one, since it can return non-contiguous sets like `{0,3}`. Confirmed empirically: this happens on 14.6% of a 103-image sample.

1. Replace the nonconformity score construction so the returned prediction set is **guaranteed contiguous by construction** — an ordinal/cumulative scoring approach (e.g., using the cumulative distribution across ordered grades rather than a per-class probability comparison) rather than the current per-class LAC comparison.
2. Make the calibration quantile **class-conditional (Mondrian)** — a separate `qhat` per grade, not one pooled global value — so the rarest, highest-stakes grades (severe NPDR, PDR) get their own coverage guarantee instead of being swamped by the far more common early-grade calibration examples.
3. This requires a fresh `qhat` fit once the scoring method changes — don't reuse the old `qhat=0.8432` with the new score construction, it was fit for a different formula.
4. **This file is already correctly wired as the live decision site** (`conformalTiering.m` is called from `branchAInferMatlab.m:157`, which is what the default MATLAB backend runs per case) — you're changing the math inside it, not fixing how or whether it's called. No coordination with Saad needed for this specific task; it's contained entirely inside files you own.
5. **Open question, not yet resolved — flag it for a team decision rather than guessing:** does tiering route through the MATLAB session regardless of which `INFERENCE_BACKEND` handles grading, or does the Python path need its own separately-implemented ordinal-aware version too? Since MATLAB is now the live default, this is lower urgency than it looked a week ago, but confirm the answer rather than leaving it open indefinitely.

---

## 3. Neovascularization Suspicion Score — Complete the Formula

Confirmed current state: `neovascularizationSuspicion.m` computes vessel density in a disc-centered annulus (`:100,104`) and tortuosity (median arc-length/chord ratio, `:142,145`), combining them as `score = min(1, 0.5*normDensity + 0.5*normTort)` (`:155`). Two things the design (§6.6) calls for are missing:

1. **Fractal/box-counting complexity is entirely absent** — no such computation exists anywhere in this file. Add it: a simplified box-counting or fractal-dimension estimate on the vessel mask, restricted to the same disc-proximal ROI already used for density and tortuosity.
2. **Branch/junction point counts and `branchDensity` are already computed** (`:108-112,148,161-164`) but **not used in the score** — they're populated into the detail struct for the evidence panel only. Decide whether incorporating them into the final formula improves the score (they're a reasonable signal — new vessels create dense local branching) and, if so, fold them in alongside density and tortuosity rather than leaving genuinely-computed data unused.
3. Once the formula is updated, re-derive the score's weighting (currently a flat 50/50 split between two components — with a third or fourth component added, the weights need reconsidering, not just appended at some arbitrary share).
4. **This score has never been measured on its own** — it's never been wired into the live path (see below), so there's no existing recall/precision number to compare against. Once Saad's orchestration wiring (his plan, §J) is in place, validate this score's own performance as a distinct metric — don't report it as if it were the same thing as Branch A's grade-4 recall (§15 of the design doc already flags this exact conflation as a mistake made once before; don't repeat it).
5. **Coordination note, not a blocker:** Saad is building the orchestration call that invokes this file from the live pipeline (his plan, §J) — his work can proceed against the *current* version of this file's signature. Improving the formula's internals doesn't change the function's inputs/outputs, so there's no need to sequence this behind his wiring work, or vice versa.
6. **Confirmed decision — cap stays at 3 for now.** Branch B (the rule engine) is capped at grade 3, with grade ≥3 treated as a floor rather than the rule engine itself asserting grade 4 — your original requirement, based on real results. Design §6.7 separately states "proliferative DR = the neovascularization suspicion flag present," which would let the rule engine assert grade 4 once the NV score crosses a threshold — but that stays off until the NV score has a real, independent recall/precision number behind it (item 4 above), since letting an unvalidated signal directly assert the most severe grade risks manufacturing false branch-agreement on PDR calls that only one weak signal actually drove. Revisit once that validation exists, not before. The threshold for that future decision is **0.6 on `neovascularizationSuspicion.m`'s own output score** (the 0–1 value from `score = min(1, 0.5*normDensity + 0.5*normTort)`, §3) — confirmed as a real, data-derived number, not a placeholder.

---

## 4. M5 Lesion Retrain — MA/HE 3-Class Split

Confirmed current state: prompt written, execution not yet confirmed. Splits M5 into a true 3-class output (background/MA/HE) using IDRiD's original separate mask folders (not the merged one v1 used), plus a class-specific minimum-area filter — a much lower size floor for microaneurysms than hemorrhages, since 67.6% of true MAs are under 10px and a shared filter tuned for hemorrhage-scale noise was discarding 41.4% of predicted components, concentrated exactly in the MA size range.

1. Run this retrain once GPU access allows (same resource constraint as §1).
2. **Hard rule, not optional:** the moment this retrain changes the model's lesion-counting characteristics, the rule engine's `redFloor`/`grade3QuadMin` thresholds need recalibration in the same change — not a follow-up someone remembers later. Run `diagnostics/recalibrate_rule.py` (or whatever the current equivalent is) as part of landing this retrain, and **tell Saad explicitly when you do this** — his rule-engine work (his plan, §H) reads lesion counts that this retrain will change the meaning of.
3. **Also mandatory once trained:** repeat the ONNX-export → MATLAB-import → parity-check process (§0) against the new 3-class checkpoint. The current `red_lesion_unet_v1.mat` reflects the old 2-class model and becomes stale the moment this retrain lands — don't let anyone (including Saad, once he wires M2–M4's already-converted models into the live path) accidentally point at the old M5 conversion.
4. **Already investigated and rejected, don't redo this experiment:** feeding M5's raw MA count into an automatic grade-0→1 override at inference time was tested and produces spurious detections on true grade-0 images (3 of 6 tested misfired badly). Don't revisit this without a materially different approach — the existing branch-disagreement safety net (CNN=0 vs. rule-engine≥1 forces Tier C) is the interim answer, not this override.
5. Cotton-wool spot (soft exudate) detection stays an explicit, disclosed scope exclusion this round — only 40 of 81 IDRiD images have any SE annotation, not enough to support a real detector. Don't attempt to build one under time pressure; document the exclusion, don't fabricate coverage.

---

## 5. Fovea Peak-Confidence Gate — New Build

Confirmed current state: does not exist anywhere in the codebase, in any form — checked broadly (fovea+reliability, peakConfidence, foveaUnreliable naming patterns) across `.js/.ts/.tsx/.m/.py`, zero matches outside dataset paths. This is new work, not a reconnection of something partially built.

1. The existing fovea-localization model already outputs a confidence heatmap. Add a peak-confidence check: below a fixed threshold (start around 0.40, tune against your own validation data), the localization is unreliable.
2. **Exact output contract Saad's backend plan depends on:** add a boolean field, `foveaUnreliable`, to the localization result JSON. This is the only interface he needs — he wires it into the schema, the rule engine's fallback path, and the tier-decision overrides on his side.
3. Validate this gate the same way the original design called for: it should catch known gross-miss cases (a rare, ~2.6%-of-held-out failure mode where the localization heatmap has no real peak) with a low false-alarm rate. Aim for something close to the previously-cited target (AUC ~1.0 detector, catching known gross misses for a small number of false alarms across the validation set) — treat this as a real number to report, not just a threshold you picked and moved on from.

---

## 6. Two New Rule-Engine Signal Detectors — Venous Beading and IRMA

Confirmed current state: only the hemorrhage-count leg of the "4-2-1" severe-NPDR rule has a working detector. Venous beading and IRMA have no computation behind them at all.

1. **Venous beading detector:** measure caliber (diameter) variation along traced venous segments in the existing vessel mask — a beaded vein shows periodic, localized diameter irregularity rather than a healthy vessel's smooth taper. Classical vessel-caliber analysis, not a new trained model.
2. **IRMA detector:** reuse the same fine-vessel-irregularity feature family as the NV suspicion score (§3), but scoped to *intraretinal* regions away from the optic disc and major arcades — the NV score's ROI is disc-proximal; this one is deliberately not. Be honest in any write-up that this is a best-effort classical heuristic distinguishing IRMA from early neovascularization by location and scale, not a clinically validated distinction — even published angiography-comparison literature finds these genuinely hard to separate from color fundus photographs alone.
3. **Exact output contract Saad's backend plan depends on:** two arrays, `venousBeadingQuadrants: [bool,bool,bool,bool]` and `irmaQuadrants: [bool,bool,bool,bool]`, one entry per retinal quadrant, added to the segmentation/vessel-analysis result JSON that already flows to the rule engine. He builds his two new `if/else` branches against these exact field names — confirm the names with him before finalizing if you want to change them, since he may already be coding against this plan's naming.
4. **Move quadrant assignment itself from Python to MATLAB while you're in this territory.** Currently `segInfer.py` assigns quadrants (relative to the fovea-disc axis) before the rule engine ever sees the data — the rule engine only receives four counts, and that interface doesn't change. Quadrant mapping is deterministic geometry, not a trained model, so it's a clean, low-risk port, and it's a direct instance of the broader push to maximize genuine MATLAB usage wherever a trained-model risk isn't in play. It also gives the fovea-unreliable fallback (§5) one home instead of two: once quadrant assignment lives in MATLAB, the image-axis fallback for an unreliable fovea reading sits right next to it, rather than split across languages. Do this alongside the venous-beading/IRMA work above, since all three touch the same vessel-and-quadrant computation.

---

## 7. Camera-Fingerprint Calibration — Confirm/Finish Its Two Jobs

This component already has two jobs per the design (§6.3): flagging a mismatch between reported and detected camera family, and classifying which training domain (CHASE-like vs. DRIVE-like) a given image is closer to, so vessel segmentation can pick the right threshold. Confirm the current implementation (`classifyCameraFamily.m`) actually does both, not just the first — the domain-classification job is a newer requirement (it emerged from correcting the earlier, wrong "domain shift" diagnosis on the vessel model) and may not be built yet. If it isn't, add it: the same classifier's output (or a lightweight addition to it) needs to select between the 0.5 threshold (CHASE-like) and 0.10 threshold (DRIVE-like/off-domain) for vessel segmentation — a real, already-quantified +0.124 Dice gain sitting unclaimed if this isn't wired.

---

## 8. Messidor-2 External Validation

Still not started — dataset access is the stated bottleneck. Request access immediately if this hasn't already been done; this is a scheduling/access problem now, not a technical one, and it's the most literature-standard thing this submission is currently missing (§15, §16 of the design doc). Once access exists: run the same domain-generalization-gap protocol already used for the synthetic portable-camera perturbations — evaluate the frozen model, report the gap, don't let target labels influence any model selection or tuning.

---

## 9. Rename the Bright-Lesion Model's Output — `hard_exudate`, Everywhere

The bright-lesion model was found to only ever detect hard exudates (Dice 0.6676); against soft exudates/cotton-wool spots it's essentially non-functional (Dice 0.076). The field/output name needs to change from whatever generic "bright lesion" label it currently has to `hard_exudate`, in every place your code labels it: the model's own output field name, any JSON your segmentation code emits, and any evidence-report text your code generates. This is your side of a two-part fix — Saad is separately checking for and updating any downstream JS/Node references to the old name; you're the source of the field name itself.

## 10. Integrated Pipeline vs. Single-Technique Baseline — Re-Run With More Data

Not started as of the last check. This is the PS's own "outperforms any single technique" requirement, and it's a validation task, not a code-build one: run the full dual-branch pipeline and a plain single-CNN baseline on the same held-out set and compare. The last attempt (52 cases) had confidence intervals overlapping at matched coverage — not yet statistically significant either way. Re-run once M1 v2 and the M5 retrain have landed, on a larger sample than 52 cases if the completed-IDRiD-dataset task gets done in time — a bigger n is the actual fix here, not a different analysis of the same cases.

---

## Note on scope not covered in this plan

The ML-session findings also included a short section on what past SIH-MathWorks-PS winners did (using the full toolchain genuinely, iterating on mentor feedback) and a suggestion that a MATLAB App Designer dashboard tied to the Simulink model would mirror what those winners built. That's a presentation/pitch consideration, not an architecture or build task, and it's deliberately left out of this plan rather than dropped by accident — worth remembering for the pitch deck, not worth spending build time on this round.

---

## Summary — What You're Handing Saad, and When He Can Start

| You deliver | Field/contract | He can start before you finish? |
|---|---|---|
| §2 conformal fix | No new field — internal to files you own | N/A — no handoff needed |
| §3 NV score | `neovascularizationSuspicion.m`'s current call signature (unchanged) | Yes, immediately — his wiring doesn't depend on your formula improvement |
| §4 M5 retrain | New lesion counts + **recalibrated rule-engine thresholds together** | No — tell him explicitly when this lands, it changes what his existing thresholds mean |
| §5 fovea gate | `foveaUnreliable: boolean` | Yes, with a mocked `false` — real field can land later |
| §6 venous beading / IRMA | `venousBeadingQuadrants`, `irmaQuadrants` arrays | Yes, with mocked all-false arrays — real fields can land later |
