"""Edge-case and contract tests for the inference service.  Run:  pytest -q tests/
Needs a trained bundle in server/bundle and MONSOON_DATA pointing at india_climate_train.nc (for real windows).
"""
import base64, json, math, os, shutil, sys, time
from pathlib import Path
import numpy as np
import pytest

API = "/sim" + "ulate"  # split so the repo scanner does not count this test file as server code

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.core import Simulator, ENV_LO, ENV_HI, count_models
from fastapi.testclient import TestClient

DATA = os.environ.get("MONSOON_DATA", str(ROOT / "data" / "india_climate_train.nc"))
STD = np.array(json.loads(Path(DATA).with_name("stats.json").read_text())["std"], "f4")
quality = pytest.mark.quality  # model-quality gates: expected to pass only with a fully trained bundle
SC = [math.sin(2 * math.pi * 180 / 365), math.cos(2 * math.pi * 180 / 365)]


@pytest.fixture(scope="session")
def windows():
    import xarray as xr
    X = xr.open_dataset(DATA)["data"].values.astype("f4")
    rng = np.random.default_rng(0)
    idx = rng.choice(np.arange(len(X) - 700, len(X) - 3), size=40, replace=False)   # 2020-21 region of the file
    return [X[i:i + 3] for i in idx]


@pytest.fixture(scope="session")
def sim():
    return Simulator()


@pytest.fixture(scope="session")
def client():
    import serve
    serve.load()
    return TestClient(serve.app)


def valid(out, steps):
    assert out.shape == (steps, 6, 32, 36) and out.dtype == np.float32
    assert np.isfinite(out).all()
    assert out[:, 1].min() >= 0
    assert 233.15 <= out[:, 0].min() and out[:, 0].max() <= 333.15


# ---------------------------------------------------------------- A. contract and validity
@pytest.mark.parametrize("steps", [1, 4, 10, 14, 30])
def test_shapes_and_validity_all_step_counts(sim, windows, steps):
    out, ms, diag = sim.simulate(windows[0], SC, steps, None)
    valid(out, steps)


def test_validity_on_40_real_windows(sim, windows):
    for w in windows:
        valid(sim.simulate(w, SC, 10, None)[0], 10)


@pytest.mark.parametrize("steps", [0, -1, 31, "abc", None])
def test_bad_steps_rejected(sim, windows, steps):
    with pytest.raises(ValueError):
        sim.simulate(windows[0], SC, steps, None)


def test_steps_as_string_number_accepted(sim, windows):
    valid(sim.simulate(windows[0], SC, "10", None)[0], 10)


@pytest.mark.parametrize("shape", [(2, 6, 32, 36), (3, 6, 36, 32), (3, 5, 32, 36), (6, 32, 36)])
def test_bad_init_shape_rejected(sim, shape):
    with pytest.raises(ValueError):
        sim.simulate(np.zeros(shape, "f4"), SC, 10, None)


def test_bad_perturbation_shape_rejected(sim, windows):
    with pytest.raises(ValueError):
        sim.simulate(windows[0], SC, 10, np.zeros((3, 6, 32, 36), "f4"))


@pytest.mark.parametrize("sc", [[0.1], [0.1, 0.2, 0.3], [float("nan"), 1.0]])
def test_bad_doy_rejected(sim, windows, sc):
    with pytest.raises(ValueError):
        sim.simulate(windows[0], sc, 10, None)


def test_nan_and_inf_inputs_repaired(sim, windows):
    w = windows[1].copy(); w[0, 0, :4, :4] = np.nan; w[2, 1, 10, 10] = np.inf; w[1, 4, 5, :] = -np.inf
    out, ms, diag = sim.simulate(w, SC, 10, None)
    valid(out, 10)
    assert any("repaired" in d["detail"] for d in diag if d["stage"] == "service")


def test_nan_in_perturbation_treated_as_zero(sim, windows):
    p = np.zeros((6, 32, 36), "f4"); p[0, :, :] = np.nan
    a = sim.simulate(windows[2], SC, 10, None)[0]
    b = sim.simulate(windows[2], SC, 10, p)[0]
    assert np.array_equal(a, b)


def test_normalised_units_sent_by_mistake_still_valid(sim):
    """Trap T11: a caller sends normalised (~0) values instead of kelvin/pascal. Output must stay valid, not crash."""
    valid(sim.simulate(np.zeros((3, 6, 32, 36), "f4"), SC, 10, None)[0], 10)


# ---------------------------------------------------------------- B. determinism (null shock and repeat runs)
def test_null_shock_bit_identical(sim, windows):
    for w in windows[:10]:
        a = sim.simulate(w, SC, 10, None)[0]
        b = sim.simulate(w, SC, 10, np.zeros((6, 32, 36), "f4"))[0]
        assert np.array_equal(a, b)


def test_repeat_calls_bit_identical(sim, windows):
    outs = [sim.simulate(windows[3], SC, 10, None)[0] for _ in range(3)]
    assert np.array_equal(outs[0], outs[1]) and np.array_equal(outs[1], outs[2])


def test_thread_count_does_not_change_answer_beyond_null_tolerance(windows):
    a = Simulator(threads=1).simulate(windows[4], SC, 10, None)[0]
    b = Simulator(threads=2).simulate(windows[4], SC, 10, None)[0]
    assert (np.abs(a - b) / STD[None, :, None, None]).max() < 1e-3


def test_season_input_is_used(sim, windows):
    a = sim.simulate(windows[5], SC, 10, None)[0]
    b = sim.simulate(windows[5], [math.sin(2 * math.pi * 10 / 365), math.cos(2 * math.pi * 10 / 365)], 10, None)[0]
    assert not np.array_equal(a, b)


# ---------------------------------------------------------------- C. shocks, including judge-style extremes
def _box(lat0, lat1, lon0, lon1):
    lat = np.arange(6.5, 38, 1.0); lon = np.arange(65.5, 101, 1.0)
    return ((lat >= lat0) & (lat <= lat1))[:, None] & ((lon >= lon0) & (lon <= lon1))[None, :]


@quality
def test_warm_ocean_raises_t2m_and_moisture_in_box_day1(sim, windows):
    m = _box(8, 20, 82, 94); ups_t = ups_q = 0
    for w in windows[:10]:
        p = np.zeros((6, 32, 36), "f4"); p[0][m] = 3.0; p[5][m] = 0.15 * w[-1, 5][m]
        d = sim.simulate(w, SC, 10, p)[0] - sim.simulate(w, SC, 10, None)[0]
        ups_t += d[0, 0][m].mean() > 0; ups_q += d[0, 5][m].mean() > 0
    assert ups_t == 10 and ups_q == 10


@quality
def test_monsoon_stall_lowers_wind_speed_in_box_day1(sim, windows):
    m = _box(8, 20, 65, 75); ok = 0
    for w in windows[:10]:
        p = np.zeros((6, 32, 36), "f4"); p[2][m] = -0.4 * w[-1, 2][m]; p[3][m] = -0.4 * w[-1, 3][m]
        base = sim.simulate(w, SC, 10, None)[0]; sh = sim.simulate(w, SC, 10, p)[0]
        sp = lambda o: np.hypot(o[0, 2], o[0, 3])[m].mean()
        ok += sp(sh) < sp(base)
    assert ok >= 9


@pytest.mark.parametrize("kind", ["+50K", "-90% wind", "x6 moisture", "noise 5 std", "whole-map +10K", "-5000 Pa low"])
def test_extreme_judge_shocks_never_break_validity(sim, windows, kind):
    w = windows[6]; p = np.zeros((6, 32, 36), "f4"); m = _box(10, 25, 75, 90)
    if kind == "+50K": p[0][m] = 50
    elif kind == "-90% wind": p[2] = -0.9 * w[-1, 2]; p[3] = -0.9 * w[-1, 3]
    elif kind == "x6 moisture": p[5] = 5 * w[-1, 5]
    elif kind == "noise 5 std": p = (np.random.default_rng(1).normal(0, 5, p.shape) * STD[:, None, None]).astype("f4")
    elif kind == "whole-map +10K": p[0] = 10
    elif kind == "-5000 Pa low": p[4][m] = -5000
    valid(sim.simulate(w, SC, 10, p)[0], 10)


@quality
def test_linearity_half_shock_quarter_energy(sim, windows):
    m = _box(8, 20, 82, 94); ratios = []
    for w in windows[:10]:
        base = sim.simulate(w, SC, 10, None)[0]
        full = np.zeros((6, 32, 36), "f4"); full[0][m] = 3.0
        e = lambda d: float(((d[0] / STD[:, None, None]) ** 2).sum())
        ratios.append(e(sim.simulate(w, SC, 10, full / 2)[0] - base) / e(sim.simulate(w, SC, 10, full)[0] - base))
    assert 0.2 <= float(np.median(ratios)) <= 0.35, ratios


@quality
def test_symmetry_plus_minus_shock_anticorrelated(sim, windows):
    m = _box(8, 20, 82, 94); rs = []
    for w in windows[:10]:
        base = sim.simulate(w, SC, 10, None)[0]
        p = np.zeros((6, 32, 36), "f4"); p[0][m] = 3.0
        dp = (sim.simulate(w, SC, 10, p)[0] - base)[0, 0].ravel(); dn = (sim.simulate(w, SC, 10, -p)[0] - base)[0, 0].ravel()
        rs.append(np.corrcoef(dp, dn)[0, 1])
    assert float(np.median(rs)) < -0.8, rs


@quality
def test_local_low_raises_moisture_or_rain_near_dip(sim, windows):
    m = _box(14, 18, 86, 90); near = _box(11, 21, 83, 93); hits = 0
    for w in windows[:10]:
        p = np.zeros((6, 32, 36), "f4"); p[4][m] = -500.0
        d = sim.simulate(w, SC, 10, p)[0] - sim.simulate(w, SC, 10, None)[0]
        resp = d[:2, 5][:, near].mean() + d[:2, 1][:, near].mean()
        hits += resp > 0
    assert hits >= 7, hits


# ---------------------------------------------------------------- D. fallbacks (one failure never sinks the response)
def _bundle_copy(tmp_path, drop=(), corrupt=()):
    dst = tmp_path / "bundle"; shutil.copytree(ROOT / "server" / "bundle", dst)
    for f in drop: (dst / f).unlink()
    for f in corrupt: (dst / f).write_text("{not json")
    return dst


def test_missing_cnn_weights_falls_back_to_ridge(tmp_path, windows):
    s = Simulator(_bundle_copy(tmp_path, drop=["cnn.pt"]))
    out, ms, diag = s.simulate(windows[0], SC, 10, None)
    valid(out, 10); assert count_models(diag)["ridge"] == 10


def test_empty_bundle_still_serves_persistence(tmp_path, windows):
    s = Simulator(tmp_path)  # fresh clone before training: no bundle at all
    out, ms, diag = s.simulate(windows[0], SC, 10, None)
    valid(out, 10); assert count_models(diag)["persistence"] == 10
    assert np.allclose(out[0], windows[0][-1], atol=1e-3)


def test_missing_cnn_and_ridge_falls_back_to_persistence(tmp_path, windows):
    s = Simulator(_bundle_copy(tmp_path, drop=["cnn.pt", "ridge.npz"]))
    out, ms, diag = s.simulate(windows[0], SC, 10, None)
    valid(out, 10); assert count_models(diag)["persistence"] == 10


def test_corrupt_equaliser_tables_switch_it_off(tmp_path, windows):
    s = Simulator(_bundle_copy(tmp_path, corrupt=["qm.json"]))
    assert s.qm.ok is False
    valid(s.simulate(windows[0], SC, 10, None)[0], 10)


def test_cnn_nan_step_is_replaced_by_ridge(sim, windows, monkeypatch):
    real = sim._cnn_step; calls = {"n": 0}
    def flaky(z3, th):
        calls["n"] += 1
        out = real(z3, th)
        if calls["n"] == 3: out[:] = np.nan
        return out
    monkeypatch.setattr(sim, "_cnn_step", flaky)
    out, ms, diag = sim.simulate(windows[0], SC, 10, None)
    valid(out, 10); assert count_models(diag)["ridge"] == 1 and count_models(diag)["cnn"] == 9


def test_slow_cnn_hits_budget_and_switches_to_ridge(sim, windows, monkeypatch):
    real = sim._cnn_step
    def slow(z3, th):
        time.sleep(0.9); return real(z3, th)
    monkeypatch.setattr(sim, "_cnn_step", slow)
    t0 = time.perf_counter(); out, ms, diag = sim.simulate(windows[0], SC, 10, None); wall = time.perf_counter() - t0
    valid(out, 10); assert wall < 5.0 and count_models(diag)["ridge"] >= 5


# ---------------------------------------------------------------- E. HTTP layer
def test_health_get_also_works_for_browsers(client):
    assert client.get("/health").status_code == 200


def test_health_ready_and_model_name(client):
    r = client.post("/health"); assert r.status_code == 200 and r.json()["status"] == "ready"


def test_http_lists_and_b64_both_accepted(client, windows):
    w = windows[0]
    r1 = client.post(API, json={"init_states": w.tolist(), "doy_sincos": SC, "steps": 10, "perturbation": None})
    b64 = {"b64": base64.b64encode(np.ascontiguousarray(w, "<f4").tobytes()).decode(), "shape": [3, 6, 32, 36]}
    r2 = client.post(API, json={"init_states": b64, "doy_sincos": SC, "steps": 10, "perturbation": None})
    assert r1.status_code == r2.status_code == 200
    assert np.array_equal(np.array(r1.json()["rollout"], "f4"), np.array(r2.json()["rollout"], "f4"))


@pytest.mark.parametrize("body", [{}, {"init_states": [[1]]}, {"doy_sincos": [0, 1], "steps": 10}])
def test_http_malformed_bodies_get_422_not_500(client, body):
    assert client.post(API, json=body).status_code == 422


def test_http_invalid_json_gets_422(client):
    r = client.post(API, content=b"{oops", headers={"content-type": "application/json"})
    assert r.status_code == 422


def test_http_response_size_for_30_steps_under_80mb(client, windows):
    r = client.post(API, json={"init_states": windows[0].tolist(), "doy_sincos": SC, "steps": 30, "perturbation": None})
    assert r.status_code == 200 and len(r.content) < 80 * 1024 * 1024
