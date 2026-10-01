# NetraSetu ML inference (remote)

HTTP wrapper around the project's `branchAInfer.py` and `segInfer.py` CLI
scripts, deployed as its own Render free web service because Render's free
plan (512MB RAM) can't hold PyTorch loaded at all -- torch alone costs
~350MB just to import, before a single model is loaded.

Both branch-a and segmentation run their additive ONNX Runtime backend
here instead of the original PyTorch path:

- **branch-a**: `BRANCH_A_INFERENCE_ENGINE=onnx` (branchAInfer.py). Grad-CAM
  and MC-dropout are computed in CLOSED FORM from the classifier head's own
  frozen weights instead of via autograd -- not an approximation, the exact
  same formula, derivable because everything after the Grad-CAM target
  layer is global-average-pool -> dropout -> one Linear layer. Verified
  against the real torch path (logits, the Grad-CAM map itself, and a
  deterministic same-dropout-mask head-math cross-check) before being
  trusted -- see branchAInfer.py's own comment for the full derivation.
  Peak measured: ~75-90MB, torch never imported.
- **segmentation**: `SEG_INFERENCE_BACKEND=onnx` (segInfer.py). Loads one of
  the four U-Nets at a time instead of PyTorch loading all four at once.
  Verified against the real torch forward pass (pixel-identical masks, same
  lesion counts) before being trusted -- see segInfer.py's own comment.
  Peak measured: ~250-270MB.

`app.py` still serialises the two endpoints with a lock even though real
headroom now exists running them concurrently (~75 + ~270 + baseline is
comfortably under 512MB) -- `gradingOrchestrator.js` calls both
concurrently for every case, and keeping them serialised costs only a few
seconds of latency per case in exchange for not depending on that margin
holding under every image size and GC timing.

This is the ML inference backend for the **online demo deployment only**
(this SIH round). The real, full system runs this same code locally via
MATLAB by default, with both branch-a and segmentation running in parallel
as usual — see `docs/TECHNICAL_DOCUMENTATION.md`.

Not a standalone product: central's Node backend calls this service over
HTTP (`INFERENCE_BACKEND=remote`) instead of spawning a local Python
subprocess. See `app.py` for the two endpoints.

Model weights (branch-A's ONNX export + extracted head weights, the four
segmentation ONNX exports) are not in this repo -- `fetch_models.py` pulls
them from a private GitHub release at Docker build time; see its own
header and the Dockerfile's `RUN --mount=type=secret` step.
