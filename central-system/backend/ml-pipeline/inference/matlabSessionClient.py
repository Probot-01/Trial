

import json
import os
import tempfile
import time
import uuid

import numpy as np
import scipy.io as sio

HERE = os.path.dirname(os.path.abspath(__file__))
SESSION_DIR = os.path.join(HERE, "matlabSession")
REQUEST_DIR = os.path.join(SESSION_DIR, "requests")
RESPONSE_DIR = os.path.join(SESSION_DIR, "responses")
POLL_S = 0.02
TIMEOUT_S = float(os.environ.get("MATLAB_SESSION_TIMEOUT_MS", "30000")) / 1000.0


class MatlabSessionError(RuntimeError):
    pass


def forward(model_name, x_nchw):
    """x_nchw: float32 N x C x H x W (N must be 1). Returns C x H x W."""
    if x_nchw.shape[0] != 1:
        raise ValueError("forward() expects a batch of exactly 1")
    os.makedirs(REQUEST_DIR, exist_ok=True)
    os.makedirs(RESPONSE_DIR, exist_ok=True)

    req_id = f"seg_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
    tmp = tempfile.gettempdir()
    in_path = os.path.join(tmp, f"{req_id}_in.mat")
    out_path = os.path.join(tmp, f"{req_id}_out.mat")
    req_path = os.path.join(REQUEST_DIR, req_id + ".json")
    resp_path = os.path.join(RESPONSE_DIR, req_id + ".json")

    try:
        hwcn = np.ascontiguousarray(np.transpose(x_nchw, (2, 3, 1, 0)).astype(np.float32))
        sio.savemat(in_path, {"x": hwcn})
        with open(req_path + ".tmp", "w", encoding="utf-8") as f:
            json.dump({"model": model_name, "tensorPath": in_path.replace("\\", "/"),
                       "outPath": out_path.replace("\\", "/")}, f)
        os.replace(req_path + ".tmp", req_path)

        deadline = time.time() + TIMEOUT_S
        while not os.path.exists(resp_path):
            if time.time() > deadline:
                
                try:
                    os.remove(req_path)
                except OSError:
                    pass
                raise MatlabSessionError(
                    f"no response from the MATLAB session within {TIMEOUT_S:.0f}s "
                    "(is it running? manageMatlabSession.ps1 status)")
            time.sleep(POLL_S)

        while True:
            try:
                with open(resp_path, encoding="utf-8") as f:
                    body = json.load(f)
                break
            except (PermissionError, json.JSONDecodeError):
                if time.time() > deadline:
                    raise
                time.sleep(POLL_S)
        if body.get("error"):
            raise MatlabSessionError(body["error"])

        y = np.asarray(sio.loadmat(out_path)["y"], dtype=np.float32)
        # MATLAB drops trailing singleton dims: H x W x C x 1 is saved as
        # H x W x C, and H x W x 1 x 1 as H x W. Restore the channel axis.
        if y.ndim == 2:
            y = y[:, :, None]
        elif y.ndim == 4:
            y = y[:, :, :, 0]
        return np.transpose(y, (2, 0, 1))
    finally:
        for p in (in_path, out_path, resp_path):
            try:
                os.remove(p)
            except OSError:
                pass
