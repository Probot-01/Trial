
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


_LOCK = asyncio.Lock()


async def _run_subprocess(args, **kwargs):

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
         
            env={**os.environ, "SEG_INFERENCE_BACKEND": "onnx"},
        )
        if proc.returncode != 0:
            return JSONResponse(status_code=422, content={"error": "segInfer_failed", "code": proc.returncode, "stderr": proc.stderr[-2000:]})
        try:
            result = json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception as exc:  # noqa: BLE001
            return JSONResponse(status_code=502, content={"error": "unparseable_output", "detail": str(exc), "stdout": proc.stdout[-2000:]})

        masks = result.get("masks", {})
        result["masksBase64"] = {name: _b64_if_exists(p) for name, p in masks.items()}
        result.pop("masks", None)
        return result
