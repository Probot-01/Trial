# Release: `video-demo`

The state the demo was recorded from. Tag: **`video-demo`** on branch `integration` (the commit that adds this file).
Everything below was checked on 2026-09-28 (IST) on the machine the runs were done on.

## What this release is

- The whole local stack from `integration`: PHC desktop (`phc-local-app/frontend` + `backend`), central
  (`central-system/backend` + `frontend`), the Expo mobile app (`phc-local-app/mobile`).
- Reset and run scripts: `node scripts/demo-reset.js`, `node scripts/demo-offline.js`.
- Script for the recording: `docs/DEMO_RUNBOOK.md`. What broke while rehearsing it: `docs/BUGLOG.md`.
- Two consecutive clean runs of the runbook from `demo-reset` (see the run log in `docs/BUGLOG.md`).

## Models

**Nothing was retrained, modified or re-exported** in this work (no `.pt`, `.mat` or `.onnx` file is in the
diff since commit `b099381`), and the rule-engine thresholds (`RED_FLOOR=3`, `GRADE3_QUAD_MIN=3`,
`RULE_MAX_GRADE=3`) are untouched. The weight files are git-ignored (only the ONNX exports and parity data are
tracked), so this list is how you know you have the same ones.

**Served in the demo** (defaults: `BRANCH_A_MODEL_VERSION=branchA_v2c`):

| Role | File (under `central-system/backend/ml-pipeline/`) | Engine |
|---|---|---|
| Classifier (Branch A) | `models/branchA_v2c.mat` | MATLAB session |
| Vessel segmentation | `models/vessel_unet_v1.mat` | MATLAB session |
| Localisation | `models/localization_v1.mat` | MATLAB session |
| Hard exudates | `models/bright_lesion_unet_v1.mat` | MATLAB session |
| Red lesions (MA + HE) | `models/red_lesion_unet_v2.pt` | Python (PyTorch) |
| Conformal / temperature | `models/conformal_v1.mat`, `models/temperature_v1.mat` | MATLAB session |
| PHC quality gate | `phc-local-app/backend/quality-gate-matlab/*.m` (source, run by `matlab -batch`) | MATLAB |
| Mobile quality gate | `phc-local-app/mobile/netrasetu/lib/quality/qualityGate.ts` | on-device (`js-device`) |

## Checksums (SHA-256)

Every model file present under `central-system/backend/ml-pipeline/models/` on the recording machine, the
served ones included. The block below is also tracked as
`central-system/backend/ml-pipeline/models.sha256`, so a fresh clone can check what it has without retyping
it: `npm run models:verify` (repo root) reports exactly which files are missing or byte-different, no network
needed. `npm run models:fetch` (or `node scripts/fetch-models.js --url <archive-link>`) additionally downloads
and extracts an archive first, then runs the same check — point it at wherever the weights end up shared
(Drive folder / GitHub Release asset), via `--url` or a `MODELS_ARCHIVE_URL` env var.

Verify by hand instead, from `central-system/backend/ml-pipeline/`:

```
sha256sum -c models.sha256
```

```
f8b69e5813fb39ec467f45c7b25f030779bc204cc582b7f941fbd00c872d5235  models/branchA_v1.mat
09a73c2accf271884f4d884f54c9ffd5630a7a05b87356f6c216646bb04df47f  models/branchA_v2a.mat
f638e7ceed3d1c9942c8f831a32547c5d48d0ee34c9d576966228faf8a42c9f8  models/branchA_v2b.mat
8b3991ea117344dd595c60f60e81e7bc9981ef402cc311e7cb854ea62ed64c9e  models/branchA_v2c.mat
3ab372217ab660cd2fee52b46c711310d7d8eec8fc20b56db3471efc477cefbf  models/bright_lesion_unet_v1.mat
393d24eaff4fcab7ea83010b1ab527ecf9373ec0665df9d7ba8771d63ae49851  models/conformal_v1.mat
3af2285d7c00585ea8a30a3d98bf17cd4c20c15233bb21bf33576dff4b59e482  models/evaluation_branchA_v1.mat
286751b8dbeceb2a924f6945bc7bee617e5e654ac10ba79486ca840d4a8b6c6a  models/localization_v1.mat
3eca16736b939fd2b39b94ccc2650f09a3c7cfdcb132d9381ab37a7a7a584267  models/Model1/branchA_v1.pt
a008f8d3cfd012df65aa77fc005dd7940f37bf710077d6d8aee2881bbc5c270f  models/Model1/branchA_v2a.onnx
2631aa01deef8663e097e395734a2642935a5d3cc31a4eff862a0f3cf6b27409  models/Model1/branchA_v2b.onnx
db5cd8f89854092e720397dff3db6207f047be988fb80a50858f208d0eafe0dc  models/Model1/branchA_v2c.onnx
44742bc781ae7bdf6fe4a997cc16b3177dd2b52b9ae5733f02ecac77a8ae61be  models/Model1/v2a/branchA_v2a.pt
6e18c5d8cf602a05c72c9f59266555739814084b167cb0c262dd213d13485b9f  models/Model1/v2a/branchA_v2a_last.pt
592d62227d9de0dc37ee30b096e59fef089b26e4ea07288fca0060700495bce8  models/Model1/v2b/branchA_v2b.pt
416f3d5df968a75aae8faae4ad1af0cfaa336a44f1c63966e93d421ed3c4cfb5  models/Model1/v2b/branchA_v2b_last.pt
685aecf75a81fbb578b6ba77268df3e5076d6b8d96c06f35893427fbeb93607e  models/Model1/v2c/branchA_v2c.pt
5876b6b7571790309e3f9bf8cd4e3b2bbaf8d26e952accaf70e72fb498410832  models/Model1/v2c/branchA_v2c_last.pt
02dff24af47700778b94af81d276da7428ddf8ab69d4b7f4736e2e506324a6d2  models/Model3/localization_v1.pt
a37c894bea28035940329e99c667727084b56a3065397ff5b7104bccebd7449e  models/Model4/bright_lesion_unet_v1.pt
211537da30a725554569a51f5a1b4dc8fd5037147fd405c3b69e539501b78660  models/red_lesion_predictions(model5)/red_lesion_unet_v1.pt
3d7c20dbe88588570ff6070c6145f38963852d2d6813cf47fb8a02c8603b094f  models/red_lesion_unet_v1.mat
27465dbb549a27a25232aa54a456609585930402e47b9388880ac4c37225cfda  models/red_lesion_unet_v2.mat
a1f498b2e2307a4ea18210b7047f7ae0b4122670b2a1231924aed3f76ff99410  models/red_lesion_unet_v2.pt
e3b72de784ce2045b3223c139f55f8ef4693e4bb8b3a76ac027c173c92ffb1e4  models/temperature_v1.mat
cb63df305abdf153f8c9a747c7c163d60603e44951fc36ce37590d9053e78ea4  models/vessel_predictions(Model2)/vessel_unet_v1.pt
81eebc0b75ff96464893bc738d93f2e0682f30ae2187dd93249c128924db8245  models/vessel_unet_v1.mat
```

The quality-gate thresholds are in `phc-local-app/backend/quality-gate-matlab/cameraPresets.json`
(tracked; see `git log -- <file>`).
