"""
fetch_models.py -- same private-release mechanism as scripts/fetch-models.js,
reimplemented in plain Python (stdlib only) so this image doesn't need Node
just to pull its own weights. Downloads MODELS_ARCHIVE_URL (the private
release asset's stable API URL) using MODELS_REPO_TOKEN, extracts into
./ml-pipeline/.

Run at CONTAINER START (Dockerfile's CMD), not Docker build time. It was
originally a build-time RUN step using a BuildKit secret mount
(`--mount=type=secret,id=MODELS_REPO_TOKEN`) so the token would never land
in an image layer -- that is the textbook-correct pattern (confirmed for
plain Docker/BuildKit and for Hugging Face Spaces' own Docker builds), but
on Render it failed twice in a row with the exact same 404 Not Found even
after MODELS_REPO_TOKEN was set on the service, which is the same failure
as having no token at all -- strong evidence Render does not wire a
dashboard-configured env var into that secret mount for Docker builds the
way plain BuildKit or HF Spaces does. Rather than keep guessing at an
unverifiable build-time mechanism, this moved to runtime: Render
definitely passes configured env vars to the RUNNING container correctly
(ordinary, well-established behavior, unlike the build-time path that just
failed), and the token still never touches an image layer -- if anything
this is more conservative than the build-time version, not less.

Idempotent: skips the download entirely if the models already appear to be
present (a sentinel file from the extracted archive), so a second
invocation in the same container filesystem -- e.g. a crash that restarts
the process without a fresh deploy -- does not needlessly re-download
~340MB.
"""
import os
import sys
import urllib.request
import zipfile

URL = os.environ.get("MODELS_ARCHIVE_URL")
TOKEN = os.environ.get("MODELS_REPO_TOKEN")
DEST_ZIP = "/tmp/models.zip"
DEST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml-pipeline")
# Present only after a real extraction -- anything from the archive works
# as a sentinel; this one happens to be named first alphabetically among
# the onnx_out files, no other significance.
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
