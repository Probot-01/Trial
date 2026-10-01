---
title: NetraSetu ML Inference
emoji: 🔬
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# NetraSetu ML inference (remote)

HTTP wrapper around the project's existing, unmodified `branchAInfer.py` and
`segInfer.py` CLI scripts, deployed here (Hugging Face Spaces, free CPU tier,
16GB RAM) because Render's free web-service plan doesn't have enough RAM to
run the PyTorch classifier plus several U-Net segmentation models at once.

This is the ML inference backend for the **online demo deployment only**
(this SIH round). The real, full system runs this same code locally via
MATLAB by default — see `docs/TECHNICAL_DOCUMENTATION.md`.

Not a standalone product: central's Node backend calls this service over
HTTP (`INFERENCE_BACKEND=remote` / `SEG_INFERENCE_BACKEND=remote`) instead
of spawning a local Python subprocess. See `app.py` for the two endpoints.

Source of truth for this repo: `SIH_2026` on GitHub — this Space is built
from a copy of `ml-inference-service/` plus `central-system/backend/
ml-pipeline/{inference,preprocessing,training/export_to_onnx.py}` at deploy
time, not maintained independently.
