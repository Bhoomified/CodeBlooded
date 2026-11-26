# Forecastrophe: Climate Digital Twin of India
> Multiverse of Monsoon (Track 2)

Forecastrophe is a standalone, browser-based climate digital twin dashboard designed for India. It allows meteorologists, disaster response officers, and agriculture planners to explore up to 14-day forecast rollouts from the team's speed-limited CNN emulator (served by `serve.py`), apply targeted what-if shocks (e.g. heated Bay of Bengal waters, stall of Arabian Sea winds), and inspect the spatial response in 3D fill-extrusion columns.

---

## Architecture & Technology Stack

- **Pure Vanilla Web Stack:** Pure HTML5, CSS3 with custom properties, and Vanilla ES Modules (`import`/`export`).
- **No Bundlers / No Node Build:** Runs directly in any modern browser without npm, webpack, or Vite.
- **Single 3D Map Library:** MapLibre GL JS v4.7.1 vendored locally offline with fill-extrusion 3D columns and dark theme.
- **Synced Wind Particles:** Real-time 2D canvas overlay syncing particle advection with MapLibre's camera matrix.
- **Zero External CDNs:** Offline-first design. All fonts (Inter, JetBrains Mono) and libraries (MapLibre, uPlot) are locally vendored under `vendor/`.
- **Live by default:** `config.json` has `"mode": "live"`, so every map is real `/simulate` output (a judging requirement). The in-browser `mock-engine.js` is kept for UI work only and shows a red MOCK ENGINE badge.

---

## Quickstart

Run a local HTTP server directly from the `dashboard/` directory:

```bash
cd dashboard
python -m http.server 8080
```

Open your browser to:
```
http://localhost:8080
```

---

## Configuration & Switching to Live API

All parameters are configured in `dashboard/config.json`:

```json
{
  "apiBase": "http://localhost:8000",
  "mode": "mock",
  "transport": "lists",
  "doyConvention": "default",
  "maxSteps": 14,
  "endpoints": {
    "health": "/health",
    "simulate": "/simulate",
    "presets": "/presets",
    "meta": "/meta"
  }
}
```

### Switching to Live Backend:
1. Change `"mode": "mock"` to `"mode": "live"`.
2. Point `"apiBase"` to your team's backend server URL (e.g. `http://192.168.1.50:8000`).
3. Reload the browser. The mock engine will never be loaded.

### Optional MapTiler Basemap Tiles:
To use high-resolution MapTiler vector basemaps, create `dashboard/config.local.json` (gitignored):

```json
{
  "maptilerKey": "YOUR_MAPTILER_API_KEY"
}
```

*Note: If no key is provided, or the machine is offline, Forecastrophe automatically and gracefully falls back to an offline dark style with local boundary layers (`assets/india.geojson`).*

---

## API Contract Specifications

### 1. Health (`POST /health` with `GET` fallback)
- Returns: `{"status": "ready" | "loading" | "error", "model_name": "speed-limited-cnn-w96-b4 [cnn]", "reason": "optional"}`

### 2. Rollout Simulation (`POST /simulate`)
Payload:
```json
{
  "init_states": [[[[...]]]], // [3][6][32][36] (K, mm/day, m/s, m/s, Pa, kg/m2)
  "doy_sincos": [sin, cos],
  "steps": 14,
  "perturbation": [[[[...]]]] // [6][32][36] physical deltas or null
}
```
Response:
```json
{
  "rollout": [[[[...]]]], // [steps][6][32][36]
  "inference_ms": 240,
  "diagnostics": [...]
}
```

---

## Keyboard Shortcuts

- `Space`: Play / Pause 14-day timeline animation
- `ArrowRight` / `ArrowLeft`: Step forward / backward by 1 day
- `D`: Switch to Difference (Multiverse) mode
- `S`: Switch to Shocked branch mode
- `P`: Toggle Presentation Mode (hides sidebars, enlarges 3D map)

---

## Running with the real model (live mode, what judges see)

From the repo root, three terminals:

```bash
python tools/make_presets.py --data data/india_climate_train.nc   # once: real starting days -> dashboard/presets/
python serve.py --port 8000                                       # terminal 1: the model
cd dashboard && python -m http.server 8080                        # terminal 2: the dashboard
```

Open http://localhost:8080. The **Starting Weather** list holds real days from 2020-2021 (years held out from training):
monsoon onset, active monsoon, heavy rain, pre-monsoon heat, two cyclones, winter. Each per-day model badge comes from
the server's `diagnostics` list (`cnn`, or `ridge` / `persistence` if a fallback fired).

The grader's two shocks (`warm_ocean`, `monsoon_stall`) in `js/shock-presets.json` match the kit exactly
(`monsoon_r1/contract.py`, `scoring.make_shock`). Everything runs offline; no CDN, no internet.
