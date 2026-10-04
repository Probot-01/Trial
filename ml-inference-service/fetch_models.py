
import os
import sys
import urllib.request
import zipfile

URL = os.environ.get("MODELS_ARCHIVE_URL")
TOKEN = os.environ.get("MODELS_REPO_TOKEN")
DEST_ZIP = "/tmp/models.zip"
DEST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml-pipeline")

SENTINEL = os.path.join(DEST_DIR, "training", "onnx_out", "bright_lesion_unet_v1.onnx")


def main():
    if os.path.exists(SENTINEL):
        print(f"{SENTINEL} already present -- skipping re-fetch.", file=sys.stderr)
        return
    if not URL:
        print("MODELS_ARCHIVE_URL not set -- skipping model fetch (expected only for a local, model-less build).", file=sys.stderr)
        return
    headers = {}
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
        headers["Accept"] = "application/octet-stream"
        headers["User-Agent"] = "netrasetu-ml-inference-service"

    req = urllib.request.Request(URL, headers=headers)
    print(f"Downloading models from {URL} ...")
    with urllib.request.urlopen(req) as resp, open(DEST_ZIP, "wb") as out:
       
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
    print("Extracting...")
    os.makedirs(DEST_DIR, exist_ok=True)
    with zipfile.ZipFile(DEST_ZIP) as zf:
        zf.extractall(DEST_DIR)
    os.remove(DEST_ZIP)
    print("Done.")


if __name__ == "__main__":
    main()
