"""
fetch_models.py -- same private-release mechanism as scripts/fetch-models.js,
reimplemented in plain Python (stdlib only) so this image doesn't need Node
just to pull its own weights. Downloads MODELS_ARCHIVE_URL (the private
release asset's stable API URL) using MODELS_REPO_TOKEN, extracts into
./ml-pipeline/. Run once, at Docker build time (see Dockerfile).

Not CLAUDE.md-relevant beyond the obvious: this moves bytes, nothing else.
"""
import os
import sys
import urllib.request
import zipfile

URL = os.environ.get("MODELS_ARCHIVE_URL")
TOKEN = os.environ.get("MODELS_REPO_TOKEN")
DEST_ZIP = "/tmp/models.zip"
DEST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml-pipeline")


def main():
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
        # urllib follows redirects by default, same semantics as the Node
        # version's "first request carries auth, redirect target doesn't".
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
