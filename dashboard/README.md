# Forecastrophe: Climate Digital Twin of India
> Multiverse of Monsoon (Track 2)

Forecastrophe is a standalone, browser-based climate digital twin dashboard designed for India. It allows meteorologists, disaster response officers, and agriculture planners to explore 14-day forecast rollouts from GenCast, apply targeted what-if shocks (e.g. heated Bay of Bengal waters, stall of Arabian Sea winds), and inspect the spatial response in 3D fill-extrusion columns.

---

## Architecture & Technology Stack

- **Pure Vanilla Web Stack:** Pure HTML5, CSS3 with custom properties, and Vanilla ES Modules (`import`/`export`).
- **No Bundlers / No Node Build:** Runs directly in any modern browser without npm, webpack, or Vite.
- **Single 3D Map Library:** MapLibre GL JS v4.7.1 vendored locally offline with fill-extrusion 3D columns and dark theme.
- **Synced Wind Particles:** Real-time 2D canvas overlay syncing particle advection with MapLibre's camera matrix.
- **Zero External CDNs:** Offline-first design. All fonts (Inter, JetBrains Mono) and libraries (MapLibre, uPlot) are locally vendored under `vendor/`.
- **Dual Engine Architecture:** Runs instantly out of the box with an in-browser `mock-engine.js` (seasonal climatology, physical advection and diffusion). Switchable to live backend APIs by toggling a single field in `config.json`.

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
- Returns: `{"status": "ready" | "loading" | "error", "model_name": "gencast-mini", "reason": "optional"}`

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
