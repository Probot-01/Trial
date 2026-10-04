# NetraSetu — Research & References Register

Everything we cited, verified, or relied on across the PPT, portal fields and design work, grouped by how solid the backing is. Use it for the README, technical documentation and Q&A prep. **Status key:** **Fetched** = opened and read in this project; **Logged** = verified in the team's earlier pass (locked-content verification log); **Canonical** = standard method reference, cited from memory and *not* re-fetched here, so confirm the bibliographic details before using it in a formal document; **Estimate** = our own figure with no external source.

## 1. Clinical evidence and benchmarks

| Reference | What we use it for | Status | Link |
| --- | --- | --- | --- |
| Abràmoff et al., IDx-DR pivotal trial, *npj Digital Medicine* 2018 | 87.2% sensitivity / 90.7% specificity (900 patients, 10 sites) — benchmark on Slide 4 and in the chart | Logged | https://doi.org/10.1038/s41746-018-0040-6 |
| Medios AI / Remidio SMART study (India), PMC7039584, PubMed 32049632 | 93.0% sensitivity (91.3–94.7) / 92.5% specificity (90.8–94.2), referable DR, n=900 | Fetched | https://pmc.ncbi.nlm.nih.gov/articles/PMC7039584/ |
| AIDRSS (Kolkata), arXiv 2501.05826 | 92.0% sensitivity / 88.0% specificity for any DR, 5,029 participants / 10,058 images | Fetched | https://arxiv.org/abs/2501.05826 |
| Wilkinson et al., International Clinical DR and DME Severity Scales, *Ophthalmology* 2003;110(9):1677–1682, PMID 13129861 | Defines the 5-level (0–4) ICDR scale our grades and rule engine follow | Logged | https://pubmed.ncbi.nlm.nih.gov/13129861/ |
| Lu et al., comparative accuracy of handheld/smartphone fundus cameras, *PLOS Digital Health* 2022 (10.1371/journal.pdig.0000131) | Mobile-lens feasibility: Peek Retina 18% / 96%, iNview 72% / 86%, Pictor Plus 77% / 91% DR sensitivity/specificity; all tested with dilated pupils | Fetched | https://journals.plos.org/digitalhealth/article?id=10.1371%2Fjournal.pdig.0000131 |

## 2. Health-system, policy and economics

| Reference | What we use it for | Status | Link |
| --- | --- | --- | --- |
| Purohit et al., cost-effectiveness of DR screening at Indian PHCs, *PharmacoEconomics Open* 2025, PMID 40205319 (PMC12209073) | $354/QALY for AI-supported screening in patients with 10+ years of diabetes (\~₹30,000 at \~₹84/$); 17.3% / 38.5% national reductions in vision-threatening DR / blindness belong to the **tele-supported** arm; AI-supported screening was dominated in most scenarios and only led if AI sensitivity reached \~96.5% | Fetched | https://pmc.ncbi.nlm.nih.gov/articles/PMC12209073 · https://link.springer.com/article/10.1007/s41669-025-00572-4 |
| IDF Diabetes Atlas, 11th ed. (2024 data), India | \~90 million adults with diabetes (our earlier log used 89.8M — same figure) | Fetched | https://diabetesatlas.org/data-by-location/country/india/ |
| AIIMS Delhi national ophthalmic workforce survey (Vashist et al.), *Indian Journal of Ophthalmology*, Oct 2025 | 20,944 ophthalmologists, \~15 per million, 1 per 65,221 people | Fetched (via news coverage) | https://www.dtnext.in/lifestyle/wellbeing/india-has-one-ophthalmologist-for-every-65000-people-reveals-aiims-delhi-survey-852242 |
| Ayushman Bharat — DR screening added to the PHC / HWC eye-care package, April 2022 | Regulatory and economic feasibility (camera is already mandated) | Logged (PubMed/PMC paper, IHOPE journal, RSSDI/VRSI 2023 position statement) | — |
| NPCBVI, MoHFW | Programme our referral model operationalises | Logged | https://npcbvi.mohfw.gov.in/ |
| National Health Policy target: blindness prevalence 0.25% | Slide 5 alignment | Logged (PIB releases 2022–24) | — |
| National Blindness and Visual Impairment Survey 2015–19 (Vashist et al., PMC8725073) | Context: \~6.2M blind, \~55M visually impaired nationally; 1.99% blindness among people 50+ | Fetched (summary only) | https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8725073/ |
| IAPB estimate of visual-impairment cost to India (\~$54.4B/year, \~0.6% of GDP) | Cost-of-inaction backdrop | Fetched (via workforce-survey coverage) | — |

## 3. Hardware and cost inputs

| Item | Value | Status | Source |
| --- | --- | --- | --- |
| Forus 3nethra Classic+ non-mydriatic camera | ₹6.75 lakh list | Fetched (IndiaMART listing; volume/tender prices likely lower) | IndiaMART listing, Sept 2026 |
| Camera vendor minimum PC spec | i5 9th gen, 8 GB RAM, 500 GB SSD | Fetched | Forus spec sheet |
| Remidio Fundus-on-Phone NM-10 (non-mydriatic) | €6,900 sale (€9,900 regular) | Fetched | Remidio retail page |
| Smartphone fundus attachments | Peek Retina $220–420, D-Eye \~$390, Volk iNview $800–1,000 (2022 prices) | Fetched | Lu et al. 2022 |
| PHC PC (~~₹45,000), Android phone (~~₹12,000), SMS (₹0.10–0.30), mobile data (₹10–15/GB), central server (\~₹2 lakh) | Retail/market estimates | Estimate | none — label as estimates |
| ₹0.20/eye compute; 4.3× specialist-hour gain; 100 cases/hour district need | Derived from our own measurements and SimEvents parameters (240 s full review, 30 s assisted) | Derived | Idea Description, Section 12 |

## 4. Datasets (as actually used)

| Dataset | Role in NetraSetu | Link |
| --- | --- | --- |
| APTOS 2019 (3,662 images) | Classifier training/validation/test | https://www.kaggle.com/c/aptos2019-blindness-detection |
| EyePACS, Kaggle resized (14,559 curated images used from a 35,126-image pool) | Classifier training | https://www.kaggle.com/c/diabetic-retinopathy-detection |
| IDRiD (81 segmentation + 516 grading + 516 localisation) | Lesion segmentation, grading, optic disc / fovea localisation; official split | https://ieee-dataport.org/open-access/indian-diabetic-retinopathy-image-dataset-idrid |
| CHASE\_DB1 (28 images) | Vessel model training | https://blogs.kingston.ac.uk/retinal/chasedb1/ |
| DRIVE (20 images) | Vessel model out-of-domain test **only** | https://drive.grand-challenge.org/ |
| Messidor-2 (1,748 images; 872 report half) | External validation only, never used for training or model selection | https://www.adcis.net/en/third-party/messidor2/ |

*Correction carried from the internal round:* DRIVE was listed as a training set; it is evaluation-only. EyePACS and CHASE\_DB1 were missing.

## 5. Method references (standard techniques we implement)

Status for every row: **Canonical** — confirm details before formal citation.

| Technique in NetraSetu | Reference |
| --- | --- |
| U-Net segmentation | Ronneberger et al., 2015, arXiv:1505.04597 |
| EfficientNet-B0 classifier | Tan & Le, 2019, arXiv:1905.11946 |
| Temperature scaling | Guo et al., "On Calibration of Modern Neural Networks", 2017, arXiv:1706.04599 |
| MC Dropout uncertainty | Gal & Ghahramani, 2016, arXiv:1506.02142 |
| Conformal prediction (split/inductive) | Vovk, Gammerman & Shafer, *Algorithmic Learning in a Random World*, 2005; Angelopoulos & Bates, "A Gentle Introduction to Conformal Prediction", arXiv:2107.07511 |
| Class-conditional (Mondrian) conformal | Vovk, "Conditional validity of inductive conformal predictors", 2012 |
| Grad-CAM / Grad-CAM++ | Selvaraju et al., 2017, arXiv:1610.02391; Chattopadhay et al., 2018, arXiv:1710.11063 |
| CLAHE | Zuiderveld, *Graphics Gems IV*, 1994 |
| Ben Graham preprocessing | Graham, Kaggle Diabetic Retinopathy competition winning write-up, 2015 |
| Frangi vesselness | Frangi et al., MICCAI 1998 |
| Youden's J threshold | Youden, "Index for rating diagnostic tests", *Cancer* 1950 |
| Quadratic-weighted kappa | Cohen, 1968 |
| ONNX model interchange (PyTorch to MATLAB) | https://onnx.ai/ |
| IDRiD / Messidor / CHASE\_DB1 / DRIVE dataset papers | Porwal et al. 2018/2020; Decencière et al. 2014; Owen et al. 2009; Staal et al. 2004 |

## 6. Research that shaped design choices

| Paper | Design decision it supports | Status | Link |
| --- | --- | --- | --- |
| Ensemble segmentation for microaneurysms, PMC10099354 (0.95 Dice / 0.91 IoU) | Dedicated small-lesion segmentation | Logged | https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10099354/ |
| Entropy-guided abstention ensemble, arXiv:2511.05529 | Selective referral from calibrated uncertainty | Logged | https://arxiv.org/abs/2511.05529 |
| Calibration under dataset shift, arXiv:2607.02569 | Why confidence needs re-testing on new cameras | Logged | https://arxiv.org/abs/2607.02569 |
| Bayesian uncertainty-aware DR detection, *Scientific Reports* 2025 | Uncertainty-gated referral | Logged | https://doi.org/10.1038/s41598-024-84478-x |
| Grad-CAM-style visualisations and clinician trust (general finding) | Lesion-attention consistency check; kept general, no specific percentage | Logged | — |

## 7. MathWorks references

| Reference | Use | Link |
| --- | --- | --- |
| Medical Imaging Toolbox: multilabel DR fundus classification example | Validated reference architecture for MATLAB-native DR classification | https://www.mathworks.com/help/medical-imaging/ug/multilabel-diabetic-retinopathy-fundus-image-classification-using-deep-learning.html |
| MathWorks Student Lounge: how Team TwinX won SIH 2025 | Judging insight: MATLAB as the end-to-end backbone, simulation results, practicality and cost | https://blogs.mathworks.com/student-lounge/2026/04/06/from-real-roads-to-real-simulations-how-team-twinx-won-smart-india-hackathon-2025/ |
| Simulink Student Challenge criteria (theme appropriateness 30, originality 40, depth of knowledge 30) | Proxy for how MathWorks engineers score; different contest | — |
| SIH idea-round rubric (novelty, complexity, clarity, feasibility, practicability, sustainability, scale of impact, user experience, future work) | Basis for the slide-by-criterion plan | SIH portal guidance |

## 8. Existing solutions landscape

IDx-DR / LumineticsCore (https://www.digitaldiagnostics.com/) · EyeArt (https://www.eyenuk.com/) — strong validation, clinic-based. Remidio Medios AI (https://remidio.com/) · Forus Health (https://www.forushealth.com/) — India-built portable devices, the closest real-world precedent.

## 9. Internal evidence (for the repo, README and benchmarks file)

Paths are relative to `central-system/backend/ml-pipeline/` unless noted.

| Claim | Evidence file |
| --- | --- |
| In-domain metrics, training size 17,576 | `models/Model1/v2c/branchA_v2c_metrics.json` |
| Messidor-2 external result | `diagnostics/out/messidor2_v2c_final_external_report.md` |
| Unvalidated-camera rule, 5/218 to 0/218 | `diagnostics/out/messidor2_site_conformal_recal_v2c.txt` |
| Branch disagreement, CNN wrong 61% vs 25% (pilot, n=52) | `experiments/comparison_task92_real.txt` |
| Quality-gate compression test (n=52) | `experiments/quality_gate_compression.json` |
| Conformal calibration | `models/calibration_branchA_v2c.json` |
| Tier decision logic | `central-system/backend/services/gradingOrchestrator.js`, `decideTier()` |
| Chunked upload and sync | `central-system/backend/services/chunkedUploadService.js`, migration 0005 |
| Quality gate | `phc-local-app/backend/quality-gate-matlab/qualityGateMain.m` |
| Full codebase audits (2026-09-25) | `docs/ppt-audit/01` to `06` |

## 10. Claims we dropped, corrected, or still need work

| Claim | Status |
| --- | --- |
| ₹4,230 cr funding / ₹287 cr programme cost / ₹47,200 cr economic gain | **Dropped** — unsourced after two independent checks |
| "3.9M at risk (NPCBVI)" and "10% screened annually (AIIMS)" | **Dropped** — unsourced |
| 165M rural vision-impaired | **Removed** — traced to a pitch submission; national survey says \~6.2M blind, \~55M impaired |
| Portable devices "1/5 the cost" | **Corrected** to a qualitative claim — ratio inconsistent across sources |
| 17.3% / 38.5% as our economic benefit | **Corrected** — health outcomes of the tele-supported arm, not ours, not economic |
| "Guaranteed" confidence | **Corrected** — camera-shift validation shows the assumptions break; use "calibrated, tested" |
| 1.37× rural vs urban blindness | **Open** — needs the RAAB report's own rural/urban table |
| "90% of DR blindness is preventable" | **Open** — needs a primary citation or softer wording |
| Camera-classifier accuracy, FROC curves, clinician review-time study, "integrated pipeline beats CNN alone" | **Never claimed** — no such measurement exists or it was refuted |
| Neovascularisation score (AUC 0.286 IDRiD / 0.379 Messidor-2) | **Built, failed, disabled and disclosed** |
