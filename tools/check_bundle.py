"""Check the model bundle before committing or submitting (tests J3 and H-group basics).

  python tools/check_bundle.py            # checks server/bundle
Fails loudly if a file is missing, is a Git LFS pointer instead of real weights, or the server would run degraded.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.core import BUNDLE, Simulator  # noqa: E402

REQUIRED = {"meta.json": 100, "static.npy": 1000, "ridge.npz": 500, "cnn.pt": 1025, "qm.json": 1000}
ok = True
for name, min_bytes in REQUIRED.items():
    p = BUNDLE / name
    if not p.exists():
        print(f"FAIL  {name}: missing"); ok = False; continue
    head = p.read_bytes()[:64]
    if head.startswith(b"version https://git-lfs"):
        print(f"FAIL  {name}: is a Git LFS pointer, not the real file (get the real file: git lfs pull, or copy it from the trained bundle zip)"); ok = False; continue
    size = p.stat().st_size
    flag = "OK  " if size >= min_bytes else "FAIL"
    ok &= size >= min_bytes
    print(f"{flag}  {name}: {size:,} bytes")
sim = Simulator(BUNDLE)
print(f"model: {sim.model_name}")
for e in sim.events:
    print(f"FAIL  degraded: {e}"); ok = False
if "[cnn]" not in sim.model_name:
    print("FAIL  the CNN is not active"); ok = False
print("BUNDLE OK" if ok else "BUNDLE NOT READY")
sys.exit(0 if ok else 1)
