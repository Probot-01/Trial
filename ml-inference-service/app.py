"""
app.py -- HTTP wrapper around the EXISTING, unmodified branchAInfer.py and
segInfer.py CLI scripts, for the online (Render) demo deployment where the
central Node backend can't run the Python ML stack itself (too little RAM
on Render's free web-service plan for PyTorch + several U-Nets loaded at
once -- see docs/TECHNICAL_DOCUMENTATION.md deployment section).

Deployed separately (Hugging Face Spaces, Docker SDK, free CPU tier: 16GB
RAM). Central's gradingOrchestrator.js calls this over HTTP instead of
spawning a local `python branchAInfer.py` subprocess, when
INFERENCE_BACKEND=remote / SEG_INFERENCE_BACKEND=remote is set -- an
additive, opt-in code path. Local dev and the existing `matlab`/`python`
backends are completely unaffected; this service does not change a single
line of branchAInfer.py or segInfer.py.

Design: for each request, write the uploaded image to a temp file, spawn
the SAME CLI script the Node backend already spawns locally, parse its
stdout JSON exactly as gradingOrchestrator.js already does, and -- the one
real difference -- read back any output image files (Grad-CAM, lesion
masks) and base64-encode them into the JSON response, since this service
and the central backend do not share a filesystem.

Endpoints:
  GET  /health
  POST /infer/branch-a      multipart: image=<file>; optional mcDropout=<int>
  POST /infer/segmentation  multipart: image=<file>
"""
import base64
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

        proc = subprocess.run(
            [PYTHON_EXE, BRANCH_A_INFER, img_path, "--gradcam", gradcam_path, "--mc-dropout", str(mcDropout)],
            capture_output=True, text=True, timeout=180,
        )
        if proc.returncode != 0:
            return JSONResponse(status_code=422, content={"error": "branchAInfer_failed", "code": proc.returncode, "stderr": proc.stderr[-2000:]})
        try:
            result = json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception as exc:  # noqa: BLE001
            return JSONResponse(status_code=502, content={"error": "unparseable_output", "detail": str(exc), "stdout": proc.stdout[-2000:]})

        result["gradcamBase64"] = _b64_if_exists(gradcam_path)
        return result


@app.post("/infer/segmentation")
async def infer_segmentation(image: UploadFile = File(...)):
    with tempfile.TemporaryDirectory() as tmp:
        img_path = os.path.join(tmp, f"input_{int(time.time() * 1000)}{os.path.splitext(image.filename or '.jpg')[1] or '.jpg'}")
        with open(img_path, "wb") as f:
            f.write(await image.read())
        outdir = os.path.join(tmp, "out")
        os.makedirs(outdir, exist_ok=True)

        proc = subprocess.run(
            [PYTHON_EXE, SEG_INFER, img_path, "--outdir", outdir],
            capture_output=True, text=True, timeout=180,
            env={**os.environ, "SEG_INFERENCE_BACKEND": "python"},  # no MATLAB here -- always python on this service
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
