

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

COPY central-system/backend/ml-pipeline/inference ./ml-pipeline/inference
COPY central-system/backend/ml-pipeline/preprocessing ./ml-pipeline/preprocessing
COPY central-system/backend/ml-pipeline/training/export_to_onnx.py ./ml-pipeline/training/export_to_onnx.py

COPY central-system/backend/ml-pipeline/models/calibration_branchA_v2c.json ./ml-pipeline/models/calibration_branchA_v2c.json
COPY central-system/backend/ml-pipeline/models/red_lesion_v2_config.json ./ml-pipeline/models/red_lesion_v2_config.json
COPY central-system/backend/ml-pipeline/models/Model1/v2c/branchA_v2c_meta.json ./ml-pipeline/models/Model1/v2c/branchA_v2c_meta.json

EXPOSE 7860
CMD python fetch_models.py && exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-7860}
