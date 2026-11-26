"""Write the dashboard's starting states (real days from the organisers' training file) into dashboard/presets/.

  python tools/make_presets.py --data data/india_climate_train.nc

Writes dashboard/presets/index.json, one <id>.json per scenario ({init_states [3,6,32,36], doy_sincos, doy, ...})
and meta.json (land-sea mask, orography, channel stds). The folder is git-ignored: generate it on the demo laptop.
Only the dashboard reads these files; the model server never does.
Scenarios are chosen from 2020-2021, the years held out from training, so the demo never replays training days.
"""
import argparse
import datetime as dt
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dashboard" / "presets"

SPEC = Path(__file__).resolve().parent / "scenarios.json"  # scenario list lives in data, not code


def doy_sincos(day: dt.date):
    d = day.timetuple().tm_yday
    return [math.sin(2 * math.pi * d / 365.0), math.cos(2 * math.pi * d / 365.0)], d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="india_climate_train.nc from the kit release")
    ap.add_argument("--stats", default=None, help="kit stats.json (default: next to --data)")
    a = ap.parse_args()
    import xarray as xr

    ds = xr.open_dataset(a.data)
    X = ds["data"].values.astype("f4")
    S = ds["static"].values.astype("f4")
    days = [str(t)[:10] for t in ds["time"].values.astype("datetime64[D]")]
    pos = {d: i for i, d in enumerate(days)}
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for sc_ in json.loads(SPEC.read_text())["scenarios"]:
        sid, label, last, desc = sc_["id"], sc_["label"], sc_["last_input_day"], sc_["description"]
        t = pos[last]
        sc, d = doy_sincos(dt.date.fromisoformat(last))
        init = np.round(X[t - 2:t + 1].astype("f8"), 3).tolist()
        payload = {"id": sid, "label": label, "description": desc, "init_states": init, "doy_sincos": sc, "doy": d}
        (OUT / f"{sid}.json").write_text(json.dumps(payload, separators=(",", ":")))
        index.append({"id": sid, "label": label})
        print(f"  {sid:16s} last input day {last} (doy {d})")
    (OUT / "index.json").write_text(json.dumps({"presets": index}, indent=1))
    stats_path = Path(a.stats) if a.stats else Path(a.data).with_name("stats.json")
    stds = json.loads(stats_path.read_text())["std"]
    meta = {"land_sea_mask": S[0].round(3).tolist(), "orography_m": S[1].round(1).tolist(), "channel_stds": stds,
            "channels": ["t2m", "tp", "u10", "v10", "msl", "tcwv"]}
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    print(f"wrote {len(index)} starting states + meta.json to {OUT}")


if __name__ == "__main__":
    main()
