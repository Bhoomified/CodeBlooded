# CodeBlooded - Multiverse of Monsoon (Yugaantar DevForge, Track 2)

Physics-aware climate digital twin for India: rolls the weather forward day by day and simulates localized shocks.

## Run the server (what the judge runs)
    pip install -r requirements.txt
    python serve.py --port 8000

## Check it like the judge does (second terminal)
    pip install -r requirements-dev.txt
    python -m monsoon_r1.schema_validator http://localhost:8000
    python -c "from monsoon_r1.repo_scan import scan; import json; print(json.dumps(scan('.'), indent=1))"

## Layout
- serve.py - API only (contract from the organisers' kit)
- server/ - model code and weights (Git LFS), loaded by serve.py
- train/ - training pipeline (data: india_climate_train.nc from the kit release, kept out of git)
- eval/ - local scoring with the kit's scoring functions
- dashboard/ - separate front end, calls the live /simulate

## Data
Download india_climate_train.nc and stats.json from https://github.com/OfficialAbhinavSingh/yug-monsoon-kit/releases/tag/v1.0.0 into data/ (ignored by git).