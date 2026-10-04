

import sys
import platform


for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

print("=" * 60)
print("DR Screening ML Environment — CUDA Verification")
print("=" * 60)

print(f"\nPython:   {sys.version}")
print(f"Platform: {platform.platform()}")

# ---- PyTorch ---- #
try:
    import torch
    print(f"\nPyTorch version : {torch.__version__}")
    print(f"CUDA available  : {torch.cuda.is_available()}")

    if torch.cuda.is_available():
        print(f"CUDA version    : {torch.version.cuda}")
        print(f"Device count    : {torch.cuda.device_count()}")
        for i in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(i)
            print(f"\nGPU [{i}]:")
            print(f"  Name          : {torch.cuda.get_device_name(i)}")
            print(f"  Total memory  : {props.total_memory / 1024**3:.1f} GB")
            print(f"  CUDA capability: {props.major}.{props.minor}")
            print(f"  Multiprocessors: {props.multi_processor_count}")

        # Quick tensor op on GPU
        x = torch.randn(1000, 1000, device="cuda")
        y = torch.matmul(x, x.T)
        print(f"\nGPU tensor test : PASSED  (1000x1000 matmul, result shape={tuple(y.shape)})")
    else:
        print("\n[WARNING] CUDA not available. Check your PyTorch installation.")
        print("  - Make sure you installed the CUDA build: --index-url https://download.pytorch.org/whl/cu121")
        print("  - Verify NVIDIA drivers are installed: nvidia-smi")
        sys.exit(1)

except ImportError:
    print("[ERROR] PyTorch not installed. Run: pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121")
    sys.exit(1)

# ---- torchvision ---- #
try:
    import torchvision
    print(f"\ntorchvision     : {torchvision.__version__}  ✓")
except ImportError:
    print("\n[WARNING] torchvision not installed.")

# ---- timm ---- #
try:
    import timm
    print(f"timm            : {timm.__version__}  ✓")
except ImportError:
    print("[WARNING] timm not installed.")

# ---- segmentation_models_pytorch ---- #
try:
    import segmentation_models_pytorch as smp
    print(f"smp             : {smp.__version__}  ✓")
except ImportError:
    print("[WARNING] segmentation-models-pytorch not installed.")

# ---- albumentations ---- #
try:
    import albumentations as A
    print(f"albumentations  : {A.__version__}  ✓")
except ImportError:
    print("[WARNING] albumentations not installed.")

# ---- opencv ---- #
try:
    import cv2
    print(f"opencv-python   : {cv2.__version__}  ✓")
except ImportError:
    print("[WARNING] opencv-python not installed.")

# ---- other packages ---- #
for pkg_name, import_name in [
    ("pandas", "pandas"),
    ("numpy", "numpy"),
    ("scikit-learn", "sklearn"),
    ("matplotlib", "matplotlib"),
    ("scipy", "scipy"),
]:
    try:
        mod = __import__(import_name)
        version = getattr(mod, "__version__", "?")
        print(f"{pkg_name:<16}: {version}  ✓")
    except ImportError:
        print(f"[WARNING] {pkg_name} not installed.")

print("\n" + "=" * 60)
print("Environment verification complete.")
print("=" * 60)
