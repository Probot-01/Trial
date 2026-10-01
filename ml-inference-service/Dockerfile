# syntax=docker/dockerfile:1
#
# NetraSetu remote ML inference service -- wraps the EXISTING, unmodified
# branchAInfer.py / segInfer.py CLI scripts behind HTTP, for Hugging Face
# Spaces (Docker SDK, free CPU tier). See app.py's own header for why this
# exists (Render's free web-service RAM is too small for this stack).
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

# The existing ML pipeline source this service wraps, unmodified.
COPY central-system/backend/ml-pipeline/inference ./ml-pipeline/inference
COPY central-system/backend/ml-pipeline/preprocessing ./ml-pipeline/preprocessing
COPY central-system/backend/ml-pipeline/training/export_to_onnx.py ./ml-pipeline/training/export_to_onnx.py

# Model weights: fetched from the private release at build time (see
# fetch_models.py's own header) using a BuildKit secret mount, so the token
# never lands in an image layer. MODELS_ARCHIVE_URL is not secret (just a
# stable asset API URL) and is passed as a normal build arg.
ARG MODELS_ARCHIVE_URL
ENV MODELS_ARCHIVE_URL=${MODELS_ARCHIVE_URL}
RUN --mount=type=secret,id=MODELS_REPO_TOKEN \
    MODELS_REPO_TOKEN="$(cat /run/secrets/MODELS_REPO_TOKEN 2>/dev/null || true)" \
    python fetch_models.py

# HF Spaces' Docker SDK expects the app on port 7860 by default.
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
