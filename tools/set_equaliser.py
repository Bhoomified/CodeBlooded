"""Switch the rain equaliser off (or back on) without retraining. Use when gate E3 fails in eval/local_score.py.

  python tools/set_equaliser.py --off      # strengths set to 0, tables kept (backup written to qm_backup.json)
  python tools/set_equaliser.py --restore  # bring back the fitted strengths
"""
import argparse, json, shutil, sys
from pathlib import Path

B = Path(__file__).resolve().parents[1] / "server" / "bundle"
ap = argparse.ArgumentParser(); g = ap.add_mutually_exclusive_group(required=True)
g.add_argument("--off", action="store_true"); g.add_argument("--restore", action="store_true")
a = ap.parse_args()
if a.off:
    if not (B / "qm_backup.json").exists():
        shutil.copy(B / "qm.json", B / "qm_backup.json")
    d = json.loads((B / "qm.json").read_text())
    d["alpha"] = [[0.0] * len(row) for row in d["alpha"]]
    (B / "qm.json").write_text(json.dumps(d)); print("equaliser OFF (backup: server/bundle/qm_backup.json)")
else:
    if not (B / "qm_backup.json").exists():
        sys.exit("no backup to restore")
    shutil.copy(B / "qm_backup.json", B / "qm.json"); print("equaliser restored")
