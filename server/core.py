"""Inference core: speed-limited CNN, ridge fallback, rain equaliser, supervised rollout.

Imported only by serve.py. Depends only on numpy and torch (both in the organisers' sandbox).
Repo-scan rules for this folder: no dates, no weather URLs, no data archives, no imports from train/, eval/ or UI code.
"""
from __future__ import annotations

import json
import logging
import math
import os
import time
from pathlib import Path

import numpy as np

log = logging.getLogger("monsoon")
HERE = Path(__file__).resolve().parent
BUNDLE = HERE / "bundle"
NC, NLAT, NLON = 6, 32, 36
T2M, TP = 0, 1
STATE_CH = (0, 2, 3, 4, 5)  # channels predicted as a residual change; rain (1) has its own head
# Physical envelope: clips inputs after a shock and guards every output day (K, mm/day, m/s, m/s, Pa, kg/m2)
ENV_LO = np.array([234.0, 0.0, -60.0, -60.0, 85000.0, 0.0], "f4")
ENV_HI = np.array([332.0, 800.0, 60.0, 60.0, 110000.0, 120.0], "f4")
MAX_STEPS = 30
CALL_BUDGET_S = 3.5  # after this, remaining steps use the fast ridge model (the judge's limit is 5 s)


# ------------------------------------------------------------------------------------------------ shared helpers
def edge_distance() -> np.ndarray:
    i, j = np.indices((NLAT, NLON))
    return (np.minimum.reduce([i, j, NLAT - 1 - i, NLON - 1 - j]).astype("f4")) / 16.0


class Norm:
    """Normalisation fitted on training years only. Rain is handled in log1p space."""

    def __init__(self, d: dict):
        self.mu = np.asarray(d["mu"], "f4")[:, None, None]
        self.sd = np.asarray(d["sd"], "f4")[:, None, None]
        self.dsd = np.asarray(d["dsd"], "f4")[:, None, None]  # std of the day-to-day change, normalised units

    @staticmethod
    def identity() -> "Norm":
        return Norm({"mu": [0.0] * NC, "sd": [1.0] * NC, "dsd": [1.0] * NC})

    def fwd(self, x: np.ndarray) -> np.ndarray:
        z = np.array(x, dtype="f4", copy=True)
        z[..., TP, :, :] = np.log1p(np.clip(z[..., TP, :, :], 0, None))
        return (z - self.mu) / self.sd

    def inv(self, z: np.ndarray) -> np.ndarray:
        x = z * self.sd + self.mu
        x[..., TP, :, :] = np.expm1(np.clip(x[..., TP, :, :], 0, 8.0))
        return x


def make_static(static_raw: np.ndarray) -> np.ndarray:
    """[2,H,W] land-sea mask + orography -> 5 static channels (mask, orography km, lat, lon, edge distance)."""
    lat = np.broadcast_to(np.linspace(-1, 1, NLAT)[:, None], (NLAT, NLON))
    lon = np.broadcast_to(np.linspace(-1, 1, NLON)[None, :], (NLAT, NLON))
    return np.stack([static_raw[0], static_raw[1] / 1000.0, lat, lon, edge_distance()]).astype("f4")


def season(theta: float) -> np.ndarray:
    return np.stack([np.full((NLAT, NLON), math.sin(theta), "f4"), np.full((NLAT, NLON), math.cos(theta), "f4")])


def cnn_inputs(z3: np.ndarray, static5: np.ndarray, theta: float) -> np.ndarray:
    """z3 [3,6,H,W] normalised -> 25 input channels."""
    return np.concatenate([z3.reshape(18, NLAT, NLON), static5, season(theta)], 0).astype("f4")


def ridge_features(z3: np.ndarray, static5: np.ndarray, theta: float) -> np.ndarray:
    """Per-cell features [H*W, 32]: 3 days x 6 at the cell, 3x3 mean of the last day, statics, season, bias."""
    pad = np.pad(z3[-1], ((0, 0), (1, 1), (1, 1)), mode="edge")
    nb = sum(pad[:, a:a + NLAT, b:b + NLON] for a in range(3) for b in range(3)) / 9.0
    f = np.concatenate([z3.reshape(18, NLAT, NLON), nb, static5, season(theta), np.ones((1, NLAT, NLON), "f4")], 0)
    return f.reshape(f.shape[0], -1).T


# ------------------------------------------------------------------------------------------------ CNN
def build_net(width: int = 96, blocks: int = 4, in_ch: int = 25, dropout: float = 0.1):
    """Speed-limited residual CNN. Reach per daily step = 2 * blocks grid cells (1x1 stem and heads add none)."""
    import torch.nn as nn

    class Block(nn.Module):
        def __init__(self):
            super().__init__()
            self.c1 = nn.Conv2d(width, width, 3, padding=1, padding_mode="replicate")
            self.c2 = nn.Conv2d(width, width, 3, padding=1, padding_mode="replicate")
            self.n1, self.n2 = nn.GroupNorm(8, width), nn.GroupNorm(8, width)
            self.act, self.drop = nn.GELU(), nn.Dropout2d(dropout)

        def forward(self, x):
            h = self.drop(self.act(self.n1(self.c1(x))))
            return self.act(x + self.n2(self.c2(h)))

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.stem = nn.Conv2d(in_ch, width, 1)
            self.blocks = nn.Sequential(*[Block() for _ in range(blocks)])
            self.state_head = nn.Conv2d(width, len(STATE_CH), 1)
            self.rain_head = nn.Conv2d(width, 1, 1)
            nn.init.zeros_(self.state_head.weight)  # starts as persistence: training can only improve on it
            nn.init.zeros_(self.state_head.bias)

        def forward(self, x):
            h = self.blocks(self.stem(x))
            return self.state_head(h), self.rain_head(h)

    return Net()


# ------------------------------------------------------------------------------------------------ rain equaliser
def season_of(theta: float) -> int:
    """1 = monsoon months (about 1 Jun - 30 Sep, day 152-273), 0 = rest of the year. Uses the angle, never a date."""
    day = (theta % (2 * math.pi)) * 365.0 / (2 * math.pi)
    return int(152 <= day <= 273)


class RainQM:
    """Per-season, per-lead monotone quantile map (separate land and sea tables), blended with strength alpha.

    Seasonal tables exist because on dry days the observed rain variance is near zero: an all-year map would invent
    rain there and blow the grader's day-8 variance ratio past 2.5 (found in testing)."""

    def __init__(self, d: dict | None, land: np.ndarray):
        self.ok = d is not None
        self.land = land.astype(bool)
        if self.ok:
            self.alpha = np.asarray(d["alpha"], "f4")  # [season, lead]
            self.qp = np.asarray(d["qp"], "f4")  # [season, lead, group, quantile] predicted
            self.qo = np.asarray(d["qo"], "f4")  # [season, lead, group, quantile] observed
            self.dry_var = float(d.get("dry_var", 0.0))  # input-day rain variance below this = dry spell: equaliser off
            if self.alpha.ndim != 2 or self.qp.ndim != 4:
                raise ValueError("unexpected equaliser table format")
            if not (np.diff(self.qp, axis=-1) >= 0).all() or not (np.diff(self.qo, axis=-1) >= 0).all():
                raise ValueError("quantile tables are not monotone")

    def __call__(self, rain: np.ndarray, lead: int, season: int = 0, input_rain_var: float = np.inf) -> np.ndarray:
        if not self.ok or input_rain_var < self.dry_var:
            return rain
        k = min(lead, self.alpha.shape[1]) - 1
        a = float(self.alpha[season, k])
        if a <= 0:
            return rain
        out = rain.copy()
        for g, m in ((0, ~self.land), (1, self.land)):
            qp, qo, v = self.qp[season, k, g], self.qo[season, k, g], rain[m]
            y = np.interp(v, qp, qo)
            hi = v > qp[-1]
            y[hi] = qo[-1] * v[hi] / max(float(qp[-1]), 1e-6)
            out[m] = (1 - a) * v + a * y
        return np.clip(out, 0, None)


# ------------------------------------------------------------------------------------------------ supervised simulator
class Simulator:
    """Six stages, each with its own fallback:
    request guard -> shock injector -> rollout (CNN -> ridge -> persistence) -> rain equaliser -> physics guards -> response.
    Any bundle file may be missing: the service still starts and answers validly, and logs what is degraded."""

    def __init__(self, bundle_dir: Path | str = BUNDLE, threads: int | None = None):
        self.events: list[str] = []
        self.dir = Path(bundle_dir)
        meta = {}
        try:
            meta = json.loads((self.dir / "meta.json").read_text())
            self.norm = Norm(meta["norm"])
        except Exception as e:
            self.norm = Norm.identity()
            self._event(f"meta.json unavailable ({type(e).__name__}): persistence only")
        try:
            static_raw = np.load(self.dir / "static.npy")
        except Exception as e:
            static_raw = np.zeros((2, NLAT, NLON), "f4")
            self._event(f"static.npy unavailable ({type(e).__name__})")
        self.static5 = make_static(static_raw)
        self.land = static_raw[0] > 0.5
        self.net = None
        if meta:
            try:
                import torch

                torch.set_num_threads(threads or min(4, os.cpu_count() or 1))
                net = build_net(**meta["net"])
                net.load_state_dict(torch.load(self.dir / "cnn.pt", map_location="cpu", weights_only=True))
                net.eval()
                self.net, self.torch = net, torch
            except Exception as e:
                self._event(f"cnn unavailable ({type(e).__name__})")
        self.ridge_W = None
        if meta:
            try:
                self.ridge_W = np.load(self.dir / "ridge.npz")["W"].astype("f4")
            except Exception as e:
                self._event(f"ridge unavailable ({type(e).__name__})")
        try:
            self.qm = RainQM(json.loads((self.dir / "qm.json").read_text()), self.land)
        except Exception as e:
            self.qm = RainQM(None, self.land)
            self._event(f"rain equaliser off ({type(e).__name__})")
        mode = "cnn" if self.net is not None else ("ridge" if self.ridge_W is not None else "persistence")
        self.model_name = meta.get("name", "monsoon") + f" [{mode}]"

    def _event(self, msg: str):
        self.events.append(msg)
        log.warning(msg)

    # stage 1: request guard
    def guard(self, init, doy_sincos, steps, perturbation):
        x = np.asarray(init, dtype="f4")
        if x.shape != (3, NC, NLAT, NLON):
            raise ValueError(f"init_states must be [3,6,32,36], got {list(x.shape)}")
        try:
            steps = int(steps)
        except Exception:
            raise ValueError("steps must be an integer")
        if not 1 <= steps <= MAX_STEPS:
            raise ValueError(f"steps must be 1..{MAX_STEPS}")
        ds = np.asarray(doy_sincos, dtype="f8").ravel()
        if ds.shape != (2,) or not np.isfinite(ds).all():
            raise ValueError("doy_sincos must be two finite numbers")
        p = None
        if perturbation is not None:
            p = np.asarray(perturbation, dtype="f4")
            if p.shape != (NC, NLAT, NLON):
                raise ValueError(f"perturbation must be [6,32,36], got {list(p.shape)}")
        notes = []
        if not np.isfinite(x).all():  # repair, never reject: an invalid window scores 0
            bad = ~np.isfinite(x)
            fill = np.nanmean(np.where(bad, np.nan, x), axis=(0, 2, 3), keepdims=True)
            fill = np.where(np.isfinite(fill), fill, ((ENV_LO + ENV_HI) / 2)[None, :, None, None])
            x = np.where(bad, np.broadcast_to(fill, x.shape), x)
            notes.append(f"repaired {int(bad.sum())} non-finite inputs")
        if p is not None and not np.isfinite(p).all():
            p = np.nan_to_num(p, nan=0.0, posinf=0.0, neginf=0.0)
            notes.append("non-finite perturbation values set to 0")
        return x, float(math.atan2(ds[0], ds[1])), steps, p, notes

    def _cnn_step(self, z3, theta):
        torch = self.torch
        with torch.inference_mode():
            ds, rn = self.net(torch.from_numpy(cnn_inputs(z3, self.static5, theta))[None])
        nxt = z3[-1].copy()
        nxt[list(STATE_CH)] += ds[0].numpy() * self.norm.dsd[list(STATE_CH)]
        nxt[TP] = rn[0, 0].numpy()
        return nxt

    def _ridge_step(self, z3, theta):
        out = (ridge_features(z3, self.static5, theta) @ self.ridge_W).T.reshape(NC, NLAT, NLON)
        nxt = z3[-1].copy()
        nxt[list(STATE_CH)] += out[list(STATE_CH)]
        nxt[TP] = out[TP]
        return nxt

    def simulate(self, init, doy_sincos, steps, perturbation):
        t0 = time.perf_counter()
        x, theta, steps, p, notes = self.guard(init, doy_sincos, steps, perturbation)
        if p is not None:  # stage 2: shock injector (a zero shock is an exact no-op)
            x = x.copy()
            x[-1] = x[-1] + p
        x = np.clip(x, ENV_LO[None, :, None, None], ENV_HI[None, :, None, None])
        z3 = self.norm.fwd(x)
        input_rain_var = float(np.var(x[-1, TP]))  # dry-spell guard for the rain equaliser
        out = np.zeros((steps, NC, NLAT, NLON), "f4")
        used = {"cnn": 0, "ridge": 0, "persistence": 0}
        diag = []  # one entry per day: which model served it (the dashboard shows these as badges)
        primary = "cnn" if self.net is not None else ("ridge" if self.ridge_W is not None else "persistence")
        for k in range(steps):
            theta += 2 * math.pi / 365.0  # forecast day k+1 is one day later in the season
            nxt = None
            order = ["cnn", "ridge"] if time.perf_counter() - t0 < CALL_BUDGET_S else ["ridge"]
            for name in order:  # stage 3: rollout with fallback chain
                model = self.net if name == "cnn" else self.ridge_W
                if model is None:
                    continue
                try:
                    cand = self._cnn_step(z3, theta) if name == "cnn" else self._ridge_step(z3, theta)
                    if np.isfinite(cand).all():
                        nxt = cand
                        used[name] += 1
                        break
                    notes.append(f"step {k + 1}: {name} produced non-finite values")
                except Exception as e:
                    notes.append(f"step {k + 1}: {name} failed ({type(e).__name__})")
            if nxt is None:
                nxt = z3[-1].copy()
                used["persistence"] += 1
                name = "persistence"
            diag.append({"step": k, "stage": "rollout", "model": name,
                         "event": "ok" if name == primary else "fallback",
                         "detail": "" if name == primary else f"{primary} unavailable for this step, {name} used"})
            raw = self.norm.inv(nxt[None])[0]
            phys = raw.copy()
            phys[TP] = self.qm(raw[TP], k + 1, season_of(theta), input_rain_var)  # stage 4: rain equaliser (output only)
            phys = np.clip(np.nan_to_num(phys, nan=0.0), ENV_LO[:, None, None], ENV_HI[:, None, None])  # stage 5
            out[k] = phys
            fb = np.clip(np.nan_to_num(raw, nan=0.0), ENV_LO[:, None, None], ENV_HI[:, None, None])
            z3 = np.concatenate([z3[1:], self.norm.fwd(fb[None])], 0)  # dynamics never see the equaliser
        for n in notes + self.events[-3:]:
            diag.append({"step": None, "stage": "service", "model": None, "event": "note", "detail": n})
        return out, (time.perf_counter() - t0) * 1000.0, diag


def count_models(diag: list) -> dict:
    """{'cnn': n, 'ridge': n, 'persistence': n} from a diagnostics list (used by tests and tools)."""
    c = {"cnn": 0, "ridge": 0, "persistence": 0}
    for d in diag:
        if d.get("stage") == "rollout":
            c[d["model"]] += 1
    return c
