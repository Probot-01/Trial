
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
MODELS_DIR = os.path.join(ML_ROOT, "models")


CHECKPOINTS = {
    "classifier":     "branchA_v1.pt",
    "classifier_v2a": "branchA_v2a.pt",   # BRANCH_A_MODEL_VERSION=branchA_v2a -- see branchAInfer.py
    "classifier_v2b": "branchA_v2b.pt",   # BRANCH_A_MODEL_VERSION=branchA_v2b -- see branchAInfer.py
    "classifier_v2c": "branchA_v2c.pt",   # BRANCH_A_MODEL_VERSION=branchA_v2c -- see branchAInfer.py
    "vessel":         "vessel_unet_v1.pt",
    "localization":   "localization_v1.pt",
    "hard_exudate":   "bright_lesion_unet_v1.pt",   # GATE 4: role renamed, filename (artifact) unchanged
    "red_lesion":     "red_lesion_unet_v1.pt",
    "red_lesion_v2":  "red_lesion_unet_v2.pt",   # RED_LESION_MODEL_VERSION=v2 -- see segInfer.py
}


class CheckpointMissing(FileNotFoundError):
    """Raised when a checkpoint is not under models/. Distinct from a generic
    FileNotFoundError so callers can tell 'the operator has not installed the
    weights' apart from 'the image path was wrong'."""


def find_checkpoints(filename, models_dir=MODELS_DIR):
    """Every path under models_dir whose basename matches. May be empty."""
    hits = []
    for dirpath, _dirnames, filenames in os.walk(models_dir):
        if filename in filenames:
            hits.append(os.path.join(dirpath, filename))
    return sorted(hits)


def resolve_checkpoint(filename, models_dir=MODELS_DIR):
    """The one path for this checkpoint, or raise with something actionable."""
    hits = find_checkpoints(filename, models_dir)

    if len(hits) == 1:
        return hits[0]

    if not hits:
        raise CheckpointMissing(
            f"checkpoint '{filename}' not found under {models_dir}.\n"
            f"Model weights are NOT stored in git (16-280 MB each, two of them "
            f"over GitHub's 100 MB file limit) and must be copied in "
            f"separately. Obtain it from the team's model drop and place it "
            f"anywhere under {models_dir} — the folder name does not matter, "
            f"the filename does.")

    raise CheckpointMissing(
        f"checkpoint '{filename}' is AMBIGUOUS — {len(hits)} copies under "
        f"{models_dir}:\n  " + "\n  ".join(hits) +
        "\nRefusing to guess. Two copies of the same checkpoint are usually a "
        "half-finished reorganisation or a stale older version, and loading "
        "whichever one the filesystem returned first would make grades depend "
        "on directory iteration order. Delete the one that is not current.")


def resolve(role, models_dir=MODELS_DIR):
    """resolve_checkpoint by role name ('classifier', 'vessel', ...)."""
    if role not in CHECKPOINTS:
        raise KeyError(f"unknown model role '{role}'; "
                       f"known roles: {sorted(CHECKPOINTS)}")
    return resolve_checkpoint(CHECKPOINTS[role], models_dir)


def audit(models_dir=MODELS_DIR):
  
    out = {}
    for role, fname in CHECKPOINTS.items():
        hits = find_checkpoints(fname, models_dir)
        out[role] = hits[0] if len(hits) == 1 else (hits or None)
    return out


if __name__ == "__main__":
    import json
    status = audit()
    print(json.dumps({k: (v if isinstance(v, (str, type(None))) else v)
                      for k, v in status.items()}, indent=2))
    missing = [k for k, v in status.items() if not v]
    if missing:
        print(f"\nMISSING: {', '.join(missing)}")
        raise SystemExit(1)
    print(f"\nall {len(status)} checkpoints resolved")
