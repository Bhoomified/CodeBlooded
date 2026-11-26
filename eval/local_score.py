"""Local replica of the automated grader (70 of 100 points: forecast 45 + dynamics 25), using the kit's own scoring.py.

  python eval/local_score.py --data india_climate_train.nc [--years 2020 2021] [--every 5] [--out results.json]

Assumption (the kit does not ship the grader driver): per-window RMSE skill = mean over 6 channels and leads 1/4/8 of
skill vs the better of persistence and climatology; per-window CSI skill pools leads 1/4/8.
"""
from __future__ import annotations
import argparse, datetime as dt, json, math, sys, time
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from monsoon_r1 import scoring as S, stats as KS
from monsoon_r1.contract import BOX_BAY_OF_BENGAL, BOX_ARABIAN_SEA, box_mask, LEAD_DAYS
from server.core import Simulator, NC

STD = np.array([8.0, 8.0, 3.5, 2.5, 450.0, 20.0], "f4")  # replaced in main() by the kit's stats.json


def load(path):
    import xarray as xr
    ds = xr.open_dataset(path)
    X = ds["data"].values.astype("f4"); t = ds["time"].values
    dates = np.array([int(str(d)[:10].replace("-", "")) for d in t.astype("datetime64[D]")])
    years = dates // 10000
    doy = np.array([dt.date(d // 10000, d // 100 % 100, d % 100).timetuple().tm_yday for d in dates])
    return X, dates, years, doy


def sincos(doy_t):
    return [math.sin(2 * math.pi * doy_t / 365.0), math.cos(2 * math.pi * doy_t / 365.0)]


def energy_radius(delta, box, frac=0.9):
    """Per day: radius (cells from the box) holding `frac` of the std-scaled response energy."""
    e = ((delta / STD[None, :, None, None]) ** 2).sum(1)
    bm = box_mask(box); bi, bj = np.where(bm); ii, jj = np.indices(bm.shape)
    dist = np.sqrt(((ii[..., None] - bi) ** 2 + (jj[..., None] - bj) ** 2)).min(-1)
    out = []
    for k in range(e.shape[0]):
        tot = e[k].sum()
        if tot <= 0: out.append(0.0); continue
        order = np.argsort(dist.ravel()); c = np.cumsum(e[k].ravel()[order]) / tot
        out.append(float(dist.ravel()[order][np.searchsorted(c, frac)]))
    return out


def evaluate(name, forecast, X, dates, years, doy, clim, starts, shock_starts, shocks=True):
    ss_w, csi_w, ratios, invalid, ss4p = [], [], [], 0, []
    per_ch = np.zeros(NC); per_ch_n = 0; times = []
    for t in starts:
        x3 = X[t - 2:t + 1]
        t0 = time.perf_counter(); out = forecast(x3, doy[t], 10, None); times.append(time.perf_counter() - t0)
        if S.validity(out, 10): invalid += 1; ss_w.append(float("nan")); continue
        sv, cp, cm, cc = [], [], [], []
        for L in LEAD_DAYS:
            true = X[t + L]; pers = x3[-1]
            cl = KS.clim_for(clim, dt.date(dates[t + L] // 10000, dates[t + L] // 100 % 100, dates[t + L] % 100))
            r = S.skill_vs_best_ref(out[L - 1][None], true[None], pers[None], cl[None])
            sv.append(np.nanmean(r["ss"])); per_ch += np.nan_to_num(r["ss"]); per_ch_n += 1
            if L == 4: ss4p.append(float(np.nanmean(r["ss_persist"])))
            cm.append(out[L - 1][1]); cc.append(true[1]); cp.append((pers[1], cl[1]))
        ss_w.append(float(np.mean(sv)))
        pm, tm = np.stack(cm), np.stack(cc)
        csi_w.append(S.csi_skill(S.csi(pm, tm), S.csi(np.stack([p for p, _ in cp]), tm), S.csi(np.stack([c for _, c in cp]), tm)))
        ratios.append(S.variance_ratio(out[7], X[t + 8]))
    fp = S.forecast_points(ss_w, csi_w)
    blur = S.anti_blur_points(np.array(ratios))
    res = {"model": name, "windows": len(starts), "invalid_windows": invalid,
           "mean_skill": round(fp["mean_ss"], 4), "mean_csi_skill": round(fp["mean_csi_skill"], 4),
           "forecast_points_45": round(fp["points"], 2), "rmse_points_30": round(fp["rmse_pts"], 2), "csi_points_15": round(fp["csi_pts"], 2),
           "anti_blur_points_10": round(blur, 2), "day8_variance_ratio_by_channel": np.round(np.nanmean(ratios, 0), 3).tolist(),
           "rain_day8_ratio_windows_over_2.5": round(float(np.mean([r[1] > 2.5 for r in ratios])), 3) if ratios else None,
           "skill_by_channel": np.round(per_ch / max(per_ch_n, 1), 4).tolist(),
           "beats_persistence_day4": bool(np.nanmean(ss4p) > 0), "day4_skill_vs_persistence": round(float(np.nanmean(ss4p)), 4),
           "latency_ms_mean": round(1000 * float(np.mean(times)), 1), "latency_ms_max": round(1000 * float(np.max(times)), 1)}
    if shocks:
        pts, checks, radii, null_ok_all = [], [], {"warm_ocean": [], "monsoon_stall": []}, True
        for t in shock_starts:
            x3 = X[t - 2:t + 1]; base = forecast(x3, doy[t], 10, None)
            null = forecast(x3, doy[t], 10, np.zeros((NC, 32, 36), "f4"))
            nok = S.null_consistent(base, null, STD); null_ok_all &= nok
            rs = []
            for nm, box in (("warm_ocean", BOX_BAY_OF_BENGAL), ("monsoon_stall", BOX_ARABIAN_SEA)):
                d = S.make_shock(nm, x3[-1], STD)
                sh = forecast(x3, doy[t], 10, d)
                c = S.causality_checks(base, sh, box, STD); c["shock"] = nm; rs.append(c); checks.append(c)
                radii[nm].append(energy_radius(sh - base, box))
            pts.append(S.causality_points(rs, nok))
        def rate(nm, key): return round(float(np.mean([c[key] for c in checks if c["shock"] == nm])), 3)
        res["causality_points_15"] = round(float(np.mean(pts)), 2)
        res["null_identical_all"] = bool(null_ok_all)
        res["shock_pass_rates"] = {nm: {k: rate(nm, k) for k in ("nonzero", "localized", "propagates", "stable", "no_teleport")}
                                   for nm in ("warm_ocean", "monsoon_stall")}
        res["day1_near_fraction"] = {nm: round(float(np.mean([c["near_frac_day1"] for c in checks if c["shock"] == nm])), 3) for nm in radii}
        res["response_radius_90pct_cells_by_day"] = {nm: np.round(np.mean(v, 0), 1).tolist() for nm, v in radii.items()}
    else:
        res["causality_points_15"] = 0.0
    res["total_auto_70"] = round(res["forecast_points_45"] + res["anti_blur_points_10"] + res["causality_points_15"], 2)
    return res


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--years", nargs=2, type=int, default=[2020, 2021])
    ap.add_argument("--every", type=int, default=5); ap.add_argument("--out", default="eval/results.json")
    ap.add_argument("--stats", default=None, help="kit stats.json (default: next to --data)")
    ap.add_argument("--bundle", default=str(ROOT / "server" / "bundle"))
    a = ap.parse_args()
    STD[:] = np.array(json.loads(Path(a.stats or Path(a.data).with_name("stats.json")).read_text())["std"], "f4")
    X, dates, years, doy = load(a.data)
    tr = (years >= 2005) & (years <= 2018)
    clim = KS.climatology(X[tr], dates[tr])
    starts = [t for t in range(2, len(years) - 10) if years[t - 2] >= a.years[0] and years[t + 10] <= a.years[1]][::a.every]
    shock_starts = starts[::6]
    sim = Simulator(a.bundle)
    def make(net_on, ridge_on, qm_on):
        def f(x3, d, steps, pert):
            n0, r0, q0 = sim.net, sim.ridge_W, sim.qm.ok
            if not net_on: sim.net = None
            if not ridge_on: sim.ridge_W = None
            sim.qm.ok = q0 and qm_on
            try: return sim.simulate(x3, sincos(d), steps, pert)[0]
            finally: sim.net, sim.ridge_W, sim.qm.ok = n0, r0, q0
        return f
    def persistence(x3, d, steps, pert):
        last = x3[-1] + (0 if pert is None else pert); return np.repeat(last[None], steps, 0)
    def climatology(x3, d, steps, pert):
        base = dt.date(2001, 1, 1) + dt.timedelta(days=int(d) - 1)
        return np.stack([KS.clim_for(clim, base + dt.timedelta(days=k + 1)) for k in range(steps)])
    results = [
        evaluate("persistence", persistence, X, dates, years, doy, clim, starts, shock_starts),
        evaluate("climatology", climatology, X, dates, years, doy, clim, starts, shock_starts, shocks=False),
        evaluate("ridge (fallback model)", make(False, True, False), X, dates, years, doy, clim, starts, shock_starts),
        evaluate("CNN raw", make(True, True, False), X, dates, years, doy, clim, starts, shock_starts),
        evaluate("CNN + rain equaliser (ship candidate)", make(True, True, True), X, dates, years, doy, clim, starts, shock_starts),
    ]
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(results, indent=1))
    gates = {"D1 beats persistence at day 4 (qualifying)": results[-1]["beats_persistence_day4"],
             "D3 CNN beats ridge": results[-2]["mean_skill"] > results[2]["mean_skill"],
             "E1 equaliser raises CSI skill": results[-1]["mean_csi_skill"] > results[-2]["mean_csi_skill"],
             "E3 equaliser raises total points": results[-1]["total_auto_70"] > results[-2]["total_auto_70"],
             "C1 null shock identical": results[-1].get("null_identical_all", False)}
    print("\nGATES"); [print(f"  {'PASS' if v else 'FAIL'}  {k}") for k, v in gates.items()]
    if not gates["E3 equaliser raises total points"]:
        print("  -> E3 failed: run  python tools/set_equaliser.py --off  then re-run this scorer")
    if not gates["D3 CNN beats ridge"]:
        print("  -> D3 failed: train longer/wider on Kaggle; if still failing, the server can ship ridge-only (see PDF)")
    print(f"  rain day-8 variance ratio: share of windows over 2.5 = {results[-1]['rain_day8_ratio_windows_over_2.5']}")
    for r in results:
        print(f"{r['model']:40s} total {r['total_auto_70']:6.2f}/70 | fc {r['forecast_points_45']:5.2f} (rmse {r['rmse_points_30']:5.2f}, csi {r['csi_points_15']:5.2f}) "
              f"| blur {r['anti_blur_points_10']:5.2f} | caus {r['causality_points_15']:5.2f} | ss {r['mean_skill']:+.3f} csiS {r['mean_csi_skill']:+.3f} "
              f"| d4>pers {r['beats_persistence_day4']} | {r['latency_ms_mean']}ms")
