# CodeBlooded — Multiverse of Monsoon (Yugaantar DevForge, Track 2)

A fast, physically constrained digital twin of India's daily weather. From 3 days of state it rolls the weather forward
day by day, and it propagates localized shocks (a warmer Bay of Bengal, a weaker monsoon wind) local-first, then outward
at a bounded speed. Includes **Forecastrophe**, a fully offline 3D dashboard driven live by the model.

## Architecture (one supervised process, six stages)

request guard -> shock injector -> rollout engine (speed-limited CNN -> ridge -> persistence)
-> rain equaliser (per season and lead, dry-spell guard) -> physics guards -> response

- **Speed-limited CNN:** 4 residual blocks of 3x3 convolutions, so one daily step sees at most 8 grid cells.
- **Residual step** scaled by typical day-to-day change; separate rain head; trained on its own 1 -> 4 -> 8-step rollouts.
- **Every stage has a fallback;** the server answers validly even if a model file is missing or corrupt.
- Inference is CPU-only, offline, under 1 GB RAM; a 10-step call takes about 0.15 s.

## Run (what the judge runs)

    pip install -r requirements.txt
    python serve.py --port 8000

## Dashboard (live model)

    python tools/make_presets.py --data data/india_climate_train.nc
    python serve.py --port 8000                       # terminal 1
    cd dashboard && python -m http.server 8080        # terminal 2 -> http://localhost:8080

## Train and verify

    pip install -r requirements-dev.txt
    # Kaggle GPU: kaggle/train_on_kaggle.ipynb  |  CPU backup: kaggle/train_local_cpu.ipynb
    python tools/check_bundle.py
    python eval/local_score.py --data data/india_climate_train.nc --out eval/results.json
    pytest

## Layout

| Path | What |
| --- | --- |
| `serve.py` | API on the organisers' contract (`/health`, `/simulate`) |
| `server/core.py` | Model, fallbacks, rain equaliser, supervised rollout (the only code `serve.py` imports) |
| `server/bundle/` | Trained files as plain git files (under 5 MB, no Git LFS, so any copy of the repo has them): `cnn.pt`, `ridge.npz`, `qm.json`, `meta.json`, `static.npy` |
| `train/pipeline.py` | Training (train 2005-18, validate 2019; 2020-21 never touched) |
| `eval/` | Grader replica (`local_score.py`) and grader-conditions check (`ops_checks.py`) |
| `tests/` | 52 contract, validity, shock and fallback tests |
| `tools/` | `check_bundle.py`, `set_equaliser.py`, `make_presets.py` |
| `kaggle/` | Training notebooks |
| `dashboard/` | Forecastrophe front end (vanilla JS, vendored MapLibre and uPlot, no CDN) |

## Data

`india_climate_train.nc` and `stats.json` from https://github.com/OfficialAbhinavSingh/yug-monsoon-kit/releases/tag/v1.0.0
go in `data/` (git-ignored, never committed).

## Team

Bhoomi (repository and integration), Vaishnavi (model training and review), Joel (dashboard).

## Credits

API contract, scoring functions and validator: organisers' kit (MIT). Design draws on Rasp & Thuerey (2021),
Keisler (2022), Choudhury et al. (BharatBench, 2024) and Hakim & Masanam (2024). All model, server, training and
dashboard code written by the team.
