"""
app.py -- HTTP wrapper around the EXISTING branchAInfer.py and segInfer.py
CLI scripts, for the online (Render) demo deployment where the central Node
backend can't run the Python ML stack itself (too little RAM on Render's
free web-service plan to hold PyTorch plus several models at once -- see
docs/TECHNICAL_DOCUMENTATION.md deployment section).

Deployed separately on its own Render free web service. Central's
gradingOrchestrator.js calls this over HTTP instead of spawning a local
`python branchAInfer.py`/`segInfer.py` subprocess, when
INFERENCE_BACKEND=remote is set -- an additive, opt-in code path. Local dev
and the existing `matlab`/`python` backends are completely unaffected.

Design: for each request, write the uploaded image to a temp file, spawn
the SAME CLI script the Node backend already spawns locally, parse its
stdout JSON exactly as gradingOrchestrator.js already does, and -- the one
real difference -- read back any output image files (Grad-CAM, lesion
masks) and base64-encode them into the JSON response, since this service
and the central backend do not share a filesystem.

Both scripts run their additive ONNX Runtime backend here, NOT the original
PyTorch path: branch-a with BRANCH_A_INFERENCE_ENGINE=onnx, segmentation
with SEG_INFERENCE_BACKEND=onnx (see each script's own comment). Neither
subprocess imports torch at all (measured: ~75-90MB peak for branch-a,
~250-270MB for segmentation, one U-Net at a time) -- torch alone costs
~350MB just to import, which this host does not have to spare. Grad-CAM and
MC-dropout are NOT lost: both are computed in closed form from the model's
own frozen head weights instead of via autograd, verified numerically
against the real torch path (logits, Grad-CAM map, a deterministic
same-mask head-math cross-check) before being trusted -- see
branchAInfer.py's own comment for the derivation.

_LOCK below still serialises the two endpoints: real headroom now exists
even running them concurrently (~75 + ~270 + baseline is comfortably under
512MB), but gradingOrchestrator.js calls both concurrently for every case,
and keeping them serialised costs only a few seconds of latency per case
in exchange for not depending on that margin holding under every possible
image size and GC timing. The final round (MATLAB, on-prem, real RAM) is
untouched and still runs both in parallel.

Endpoints:
  GET  /health
  POST /infer/branch-a      multipart: image=<file>; optional mcDropout=<int>
  POST /infer/segmentation  multipart: image=<file>
"""
import asyncio
import base64
import functools
import json
import os
import subprocess
import sys
import tempfile
import time

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

ML_ROOT = os.path.dirname(os.path.abspath(__file__)) + "/ml-pipeline"
BRANCH_A_INFER = os.path.join(ML_ROOT, "inference", "branchAInfer.py")
SEG_INFER = os.path.join(ML_ROOT, "inference", "segInfer.py")
PYTHON_EXE = sys.executable

app = FastAPI(title="NetraSetu ML inference (remote)", version="1.0")

# Serialises branch-a and segmentation -- see module docstring. A plain
# asyncio.Lock (not a multiprocessing one): this service always runs as a
# single uvicorn worker (one process), which a free-tier host enforces
# anyway (no horizontal scaling on Render's free plan), so one event loop is
# the whole story.
_LOCK = asyncio.Lock()


async def _run_subprocess(args, **kwargs):
    """subprocess.run, off the event loop (so /health stays responsive
    during a long inference call) and inside _LOCK (so branch-a and
    segmentation never run at the same time -- see module docstring)."""
    loop = asyncio.get_running_loop()
    async with _LOCK:
        return await loop.run_in_executor(
            None, functools.partial(subprocess.run, args, **kwargs))


@app.get("/health")
def health():
    return {"status": "ok", "branchAInferExists": os.path.exists(BRANCH_A_INFER), "segInferExists": os.path.exists(SEG_INFER)}


def _b64_if_exists(path):
    if path and os.path.exists(path):
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")
    return None


@app.post("/infer/branch-a")
async def infer_branch_a(image: UploadFile = File(...), mcDropout: int = Form(20)):
    with tempfile.TemporaryDirectory() as tmp:
        img_path = os.path.join(tmp, f"input_{int(time.time() * 1000)}{os.path.splitext(image.filename or '.jpg')[1] or '.jpg'}")
        with open(img_path, "wb") as f:
            f.write(await image.read())
        gradcam_path = os.path.join(tmp, "gradcam.png")

        proc = await _run_subprocess(
            [PYTHON_EXE, BRANCH_A_INFER, img_path, "--gradcam", gradcam_path, "--mc-dropout", str(mcDropout)],
            capture_output=True, text=True, timeout=180,
            # onnx, not torch: real gradients computed in closed form instead
            # of via autograd (see branchAInfer.py's own comment) -- torch
            # alone costs ~350MB to import, which this host doesn't have to
            # spare. Grad-CAM and MC-dropout are unaffected: verified
            # numerically against the torch path before this was trusted.
            env={**os.environ, "BRANCH_A_INFERENCE_ENGINE": "onnx"},
        )
        if proc.returncode != 0:
            return JSONResponse(status_code=422, content={"error": "branchAInfer_failed", "code": proc.returncode, "stderr": proc.stderr[-2000:]})
        try:
            result = json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception as exc:  # noqa: BLE001
            return JSONResponse(status_code=502, content={"error": "unparseable_output", "detail": str(exc), "stdout": proc.stdout[-2000:]})

        result["gradcamBase64"] = _b64_if_exists(gradcam_path)
        result.pop("gradcamPath", None)  # only valid on this service's own filesystem
        return result


@app.post("/infer/segmentation")
async def infer_segmentation(image: UploadFile = File(...)):
    with tempfile.TemporaryDirectory() as tmp:
        img_path = os.path.join(tmp, f"input_{int(time.time() * 1000)}{os.path.splitext(image.filename or '.jpg')[1] or '.jpg'}")
        with open(img_path, "wb") as f:
            f.write(await image.read())
        outdir = os.path.join(tmp, "out")
        os.makedirs(outdir, exist_ok=True)

        proc = await _run_subprocess(
            [PYTHON_EXE, SEG_INFER, img_path, "--outdir", outdir],
            capture_output=True, text=True, timeout=180,
            # onnx, not python: loads one U-Net at a time instead of all four
            # -- see segInfer.py's own comment and this file's module
            # docstring for why that's required on a 512MB host.
            env={**os.environ, "SEG_INFERENCE_BACKEND": "onnx"},
        )
        if proc.returncode != 0:
            return JSONResponse(status_code=422, content={"error": "segInfer_failed", "code": proc.returncode, "stderr": proc.stderr[-2000:]})
        try:
            result = json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception as exc:  # noqa: BLE001
            return JSONResponse(status_code=502, content={"error": "unparseable_output", "detail": str(exc), "stdout": proc.stdout[-2000:]})

        # Replace local file paths with base64 payloads -- this service and
        # the central backend share no filesystem, unlike the local-subprocess path.
        masks = result.get("masks", {})
        result["masksBase64"] = {name: _b64_if_exists(p) for name, p in masks.items()}
        result.pop("masks", None)
        return result
