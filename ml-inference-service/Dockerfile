# syntax=docker/dockerfile:1
#
# NetraSetu remote ML inference service -- wraps the branchAInfer.py /
# segInfer.py CLI scripts behind HTTP, for Render (free web service, 512MB
# RAM). See app.py's own header for the full design; in short: both
# scripts run their additive ONNX Runtime backend here (branchAInfer.py's
# BRANCH_A_INFERENCE_ENGINE=onnx, segInfer.py's SEG_INFERENCE_BACKEND=onnx),
# not the original PyTorch path -- torch alone costs ~350MB to import,
# which this host does not have to spare. Neither script needs torch
# installed at all for this deployment (confirmed before trimming
# requirements.txt), which is why it is not in requirements.txt.
#
# Build context is the REPO ROOT (not this directory), so COPY paths below
# match the existing relative-import layout the Python scripts already
# assume (ml-pipeline/inference/, ml-pipeline/preprocessing/, etc.) rather
# than requiring the source tree to be rearranged for Docker's sake.

FROM python:3.11-slim

# libgl1/libglib2.0-0: opencv-python-headless still dlopens these at import
# time on Debian slim images, even "headless" -- a known, common gotcha.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency manifest first, for layer caching (optimization-guide.md).
COPY ml-inference-service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Application code.
COPY ml-inference-service/app.py ./app.py
COPY ml-inference-service/fetch_models.py ./fetch_models.py

# The existing ML pipeline source this service wraps -- unmodified except
# segInfer.py's and branchAInfer.py's additive onnx backends (see each
# script's own comment) and gradcam.py's torch import being made lazy
# (save_overlay() never needed it; only compute_gradcam() does, and this
# deployment never calls that function).
COPY central-system/backend/ml-pipeline/inference ./ml-pipeline/inference
COPY central-system/backend/ml-pipeline/preprocessing ./ml-pipeline/preprocessing
COPY central-system/backend/ml-pipeline/training/export_to_onnx.py ./ml-pipeline/training/export_to_onnx.py
# Small, git-tracked config/metadata files read directly (not weights --
# those come from fetch_models.py below): the v2c calibration curve, the v2
# red-lesion connected-component floors, and branch-A's preprocessing
# metadata (img_size/channel_order/normalize_mean/std) -- extracted once
# offline specifically so this path never has to open the .pt checkpoint
# (which would need torch) just to read five small values.
COPY central-system/backend/ml-pipeline/models/calibration_branchA_v2c.json ./ml-pipeline/models/calibration_branchA_v2c.json
COPY central-system/backend/ml-pipeline/models/red_lesion_v2_config.json ./ml-pipeline/models/red_lesion_v2_config.json
COPY central-system/backend/ml-pipeline/models/Model1/v2c/branchA_v2c_meta.json ./ml-pipeline/models/Model1/v2c/branchA_v2c_meta.json

# Model weights: fetched from the private release at build time (see
# fetch_models.py's own header) using a BuildKit secret mount, so the token
# never lands in an image layer. MODELS_ARCHIVE_URL is not secret (just a
# stable asset API URL) and is passed as a normal build arg. Contents:
# the four segmentation ONNX exports, branch-A's ONNX export (with an extra
# graph output tapping backbone.bn2.act for Grad-CAM) and its extracted
# head.weight/head.bias (branchAInfer.py's own comment explains why both
# are needed, and verifies them against the real torch path).
ARG MODELS_ARCHIVE_URL
ENV MODELS_ARCHIVE_URL=${MODELS_ARCHIVE_URL}
RUN --mount=type=secret,id=MODELS_REPO_TOKEN \
    MODELS_REPO_TOKEN="$(cat /run/secrets/MODELS_REPO_TOKEN 2>/dev/null || true)" \
    python fetch_models.py

# Render injects PORT at runtime and expects the service to bind to it, not
# a fixed port -- shell form (not exec-form JSON) so ${PORT} is expanded.
# 7860 is only the fallback for a plain local `docker run` with no PORT set.
# `exec` so uvicorn becomes PID 1 and receives SIGTERM directly, instead of
# an intermediate shell swallowing it -- graceful shutdown, not a hang on
# every deploy/restart.
EXPOSE 7860
CMD exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-7860}
