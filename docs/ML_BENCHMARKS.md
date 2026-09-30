# NetraSetu — ML Benchmarks

Prepared for SIH portal submission. Every number below is measured on real data by real code
already in this repository — nothing is estimated or projected. Each figure cites the exact file
it came from so it can be independently reproduced. Where a number is optimistic for a stated
reason (calibration contamination, small sample size, etc.), that caveat is stated next to the
number, not omitted — this project's own standing rule is that a reported result that hasn't been
cleanly validated says so, rather than reading as more solid than it is.

**Served model versions** (per `docs/RELEASE.md`, confirmed live): classifier `branchA_v2c`,
vessel segmentation `vessel_unet_v1`, optic-disc/fovea localization `localization_v1`, hard-exudate
segmentation `bright_lesion_unet_v1`, red-lesion (microaneurysm+haemorrhage) segmentation
`red_lesion_unet_v2` (confirmed live — see §5).

---

## 1. Headline result — DR severity classification (Branch A, deployed model)

Independent run of the served classifier (`branchA_v2c`, calibrated, the exact `branchAInfer.py`
code path used in production) against the **103 official IDRiD test-set images** and their
ground-truth grades. Reproducible with `python scripts/audit/eval_idrid_test.py`.

| Metric | Result | SIH problem-statement target |
|---|---|---|
| Referable-DR (grade ≥ 2) sensitivity — live referral flag | **100%** (64/64) | > 90% ✅ |
| Referable-DR sensitivity — by raw grade argmax | 96.9% | |
| Referable-DR specificity — live referral flag | **82.1%** | > 85% ❌ (below target) |
| Referable-DR specificity — by raw grade argmax | 79.5% | |
| Quadratic-weighted kappa (QWK) | **0.841** | |
| Exact-grade accuracy | 77.7% | |
| Within-one-grade accuracy | 91.3% | |
| Grade-4 (proliferative DR) recall | **13/13 (100%)** | |
| Confidence-tier distribution (of 103) | Tier A: 4 · Tier B: 70 · Tier C: 29 | |
| Tier-A cases that were actually referable (false auto-clear) | **0** | |
| Conformal prediction sets that are contiguous (no gaps, e.g. not {0,3}) | 83.5% | |

**Reference point, not a like-for-like comparison:** the FDA-pivotal-trial benchmark for
autonomous DR screening (IDx-DR, 900 patients, 10 primary-care sites) reported 87.2% sensitivity /
90.7% specificity for referable DR. NetraSetu is a decision-support system with a human
ophthalmologist confirming every result, not an autonomous diagnostic, so this is a scale
reference, not a claim of equivalence.

**Read this as a smoke test on the deployed model, not a clean validation.** The temperature
scaling and referral threshold were fit on a pool that includes these same 103 test images
(`calibration_branchA_v2c.json`: "pooled val+test, n=1161") — source:
`docs/STALE_CLAIMS_AUDIT.md` §3.1. What this table *does* establish: the deployed model is not
broken, no case in this set was silently under-graded to a false negative, and grade-4 recall —
previously a known ship-blocking weakness at 0.444 on an older model version — is resolved on
this population. What it does *not* establish: a clean, held-out, publication-grade accuracy
number, and specificity is honestly below the target even though sensitivity clears it — meaning
only about 4% of cases fully auto-clear, and roughly 96% still reach a human reviewer at this
calibration.

**Prior model versions, for context** (`central-system/backend/ml-pipeline/diagnostics/MODEL_INTERFACE_REFERENCE.md`):
v1 (384×384 input): test QWK 0.869, referable sensitivity/specificity 0.86/0.94, grade-4 recall
0.444 — this is the version v2c replaced specifically because of that grade-4 weakness.

---

## 2. Statistical safety validation — conformal confidence tiers

Class-conditional conformal calibration determines which cases can safely skip human review
(Tier A). This is evaluated separately from raw accuracy because it's a *coverage guarantee*, not
a point estimate: source `central-system/backend/ml-pipeline/diagnostics/out/conformal_v3_crossfit_report_branchA_v2c.json`,
a cross-fit study on the pooled val+test population (n=1161).

| Metric | Result | Gate |
|---|---|---|
| Referable-case coverage (lower confidence bound) | 0.9416 | ≥ 0.93 ✅ |
| False auto-clear rate, referable cases | **0.0000** | ≤ 0.05 ✅ |
| False auto-clear rate, grade ≥ 3 cases | **0.0000** | ≤ 0.02 ✅ |
| Mean prediction-set size | 2.01 | (smaller = more decisive) |
| Tier distribution (pooled) | A: 38.4% · B: 43.8% · C: 17.8% | |
| Grade-4 cases auto-cleared to Tier A, across 1000 fold-assignments | **0** | |
| Pooled sensitivity (95% CI) | 0.9503 [0.9277, 0.9661] (478/503) | |
| Pooled specificity (95% CI) | 0.9103 [0.8861, 0.9298] (599/658) | |

**The clinical safety claim this supports:** across a cross-fit study covering the model's full
calibration population, **no grade-4 case has ever auto-cleared without human review**. This is
the property the tiering system exists to guarantee, and it held with zero exceptions.

**Cross-implementation parity:** the calibrated classifier's Python and MATLAB inference paths
were checked against each other on 10 real IDRiD images — exact grade and tier agreement 10/10,
max calibrated-probability difference 5.14×10⁻⁷ (effectively floating-point noise, not a real
divergence). Source: same report file.

---

## 3. Segmentation models

| Model | Role | Test set | n | Dice | Sensitivity | Specificity | IoU |
|---|---|---|---|---|---|---|---|
| Vessel U-Net (`vessel_unet_v1`) | Vessel map — feeds NV suspicion, MA false-positive suppression | CHASE_DB1 (training domain) | 28 | **0.8024** | 0.799 | 0.986 | 0.670 |
| Vessel U-Net (same model, no retraining) | Cross-dataset generalization check | DRIVE (unseen domain) | 20 | 0.6186 | 0.463 | 0.995 | 0.448 |
| Hard-exudate U-Net (`bright_lesion_unet_v1`) | Bright lesion segmentation | IDRiD heldout | 27 | **0.6676** | 0.723 | 0.994 | 0.501 |
| Red-lesion U-Net, **v1** (single-class MA+HE) | Predecessor to the deployed v2 model | IDRiD heldout | 16 | 0.6105 | 0.570 | 0.997 | 0.439 |

Source: `central-system/backend/ml-pipeline/diagnostics/out/m2_metrics.json`,
`m45_metrics.json`.

**Optic disc / fovea localization** (`localization_v1`), IDRiD heldout, n=77
(`diagnostics/out/m3_metrics.json`):

| Target | Mean error (native px) | Mean error (512-space px) | Within one disc radius |
|---|---|---|---|
| Optic disc | 26.9 | 4.07 | **98.7%** |
| Fovea | 85.6 | 12.2 | **96.1%** |

A dedicated peak-confidence gate (threshold 0.37, chosen as "the smallest threshold with 100%
validation gross-miss sensitivity" — `diagnostics/out/fovea_gate_report.json`) catches the cases
where fovea localization has no real confidence peak, marks them `fovea_unreliable`, and routes
them to mandatory review instead of grading on a silently-wrong quadrant axis.

**Important honesty note on the red-lesion model — read before quoting a number:**
The model actually running in production for microaneurysm/haemorrhage detection is **v2**
(a 3-class architecture separating microaneurysms from haemorrhages, each with its own
minimum-lesion-size filter) — confirmed live: `segInfer.py:116` defaults
`RED_LESION_MODEL_VERSION` to `"v2"`, no environment override exists, and real production
database rows carry non-null, non-zero microaneurysm/haemorrhage counts under
`redLesionModelVersion: "v2"`. **However, v2 has no independently measured Dice/sensitivity score
of its own anywhere in this codebase** — the 0.6105 Dice figure in the table above is v1's, a
different (single-class) architecture it replaced. v2's improvement over v1 is architectural and
qualitative (it can report a microaneurysm count and a haemorrhage count separately, which v1
could not do at all — v1 could only report a combined red-lesion total), not yet backed by its
own quantitative accuracy benchmark. **Do not state a Dice/sensitivity number for v2 specifically
— none exists yet.** This is worth commissioning before the next round, not before this
submission.

**Not detected, by explicit design decision, not a bug:** cotton-wool spots (soft exudates) have
no dedicated detector this round — the available pixel-level training data for this lesion type
was judged too sparse to support a real detector, so this field is always reported as
unmeasured, never as a false zero.

**Neovascularization** is reported as a suspicion score (vessel-density/branching/tortuosity
proxy near the optic disc), not a segmentation claim, because it has the least public pixel-level
training data of any lesion type here. Its own measured performance (AUC 0.286 on IDRiD, 0.379 on
Messidor-2 — both **below chance**, source `docs/STALE_CLAIMS_AUDIT.md` §3.4) means it is
currently gated off and does not influence any grade or tier — a CNN-predicted grade-4 triggers
mandatory review on its own, independent of what this score says.

---

## 4. Rule engine (Branch B — explicit ICDR/ETDRS criteria)

Branch B is plain, testable code implementing the standard ICDR "4-2-1" rule directly on
quadrant-mapped lesion counts (no learned weights), so it can be audited against the clinical
rule text line by line rather than trusted as a black box. Live thresholds (frozen, not to be
changed without an explicit decision — `CLAUDE.md`): `RED_FLOOR=3`, `GRADE3_QUAD_MIN=3`,
`RULE_MAX_GRADE=3`.

**No system-wide Branch A/B agreement-rate statistic is reported here** — the only file that
looks like one (`diagnostics/out/agreement_results.csv`) is a small, curated set of disagreement
examples used for debugging, not a representative sample, and computing a percentage from it
would misrepresent what it measures. When the two branches disagree, the case is forced into
mandatory review with a required explicit grade resolution — a disagreement is treated as a safety
signal, not noise to be averaged away, so this system doesn't need a single agreement percentage
to make its safety case.

A separate, **proposed but not adopted** recalibration study exists
(`diagnostics/out/gate2_recalibration_report.json`) exploring alternate thresholds on IDRiD; it is
explicitly marked "not read by any production code yet" and is not what ships.

---

## 5. System-level reliability (not an accuracy metric)

A full-dataset backend soak test (`scripts/test-full-dataset.js`) submitted every IDRiD image
present on disk (447 images) through the real capture → quality-gate → sync → grading pipeline
end-to-end, exactly as a PHC technician's submission would flow:

| Metric | Result |
|---|---|
| Images submitted | 447 |
| Successfully graded | **447 (100%)** |
| Failed | 0 |
| Timed out | 0 |

This is a throughput/reliability result (the pipeline completes without crashing or dropping a
case under real load), not a claim about grading accuracy — accuracy is reported separately in §1.

---

## 6. Honest limitations (stated on purpose, not omitted)

- Specificity (82.1%) is below the >85% target even though sensitivity clears it — only ~4% of
  cases fully auto-clear at the current calibration.
- The §1 and §2 numbers are measured on a population that overlaps with the model's own
  calibration set — a genuinely clean, held-out validation has not been run.
- Messidor-2 (external, different-population validation) was used for model *selection* between
  v2a/v2b/v2c, not as an untouched external test set — so it does not substitute for one.
- The red-lesion model actually running in production (v2) has no independently measured
  accuracy score of its own — see §3.
- Neovascularization detection is measured and has failed (below-chance AUC) — it is gated off,
  not merely unmeasured.
- Cotton-wool spot (soft exudate) detection is out of scope this round, not a weak metric.
- Vessel segmentation shows a real cross-domain gap (Dice 0.80 in-domain vs. 0.62 on an unseen
  camera/dataset) — a live, fixed 0.5 threshold is used, not a per-domain-adjusted one.
- No system-wide Branch A/B agreement rate has been measured on a representative sample.
