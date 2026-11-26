"""Multiverse of Monsoon - inference server (Round 1 contract).
The judge runs this exact file offline:  python serve.py --port 8000
Rules: listen on 0.0.0.0, load weights once at startup from files inside the repo, return finite numbers in
physical units, answer a 10-step rollout in under 5 s.
"""
import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # works from any folder / launcher

import numpy as np
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from server.model import MODEL_NAME, load_model, simulate

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])  # lets the dashboard call us
MODEL = load_model()  # loaded once, at import time, before the first request


def _arr(x):
    """Accept nested lists (the contract) or {'b64': ..., 'shape': [...]} (tolerated)."""
    if isinstance(x, dict):
        import base64
        return np.frombuffer(base64.b64decode(x["b64"]), dtype="<f4").reshape(x["shape"]).astype("f4")
    return np.asarray(x, dtype="f4")


@app.post("/health")
@app.get("/health")  # GET only for humans/browsers; the judge uses POST
def health():
    return {"status": "ready", "model_name": MODEL_NAME}


@app.post("/simulate")
async def simulate_endpoint(request: Request):
    t0 = time.perf_counter()
    try:
        body = await request.json()
        init = _arr(body["init_states"])
        pert = None if body.get("perturbation") is None else _arr(body["perturbation"])
        out = simulate(MODEL, init, body["doy_sincos"], int(body["steps"]), pert)
    except (KeyError, ValueError, TypeError) as e:  # bad input -> clear 422, never a 500 crash
        return JSONResponse({"error": str(e)[:300]}, status_code=422)
    return {"rollout": np.asarray(out, dtype="f4").tolist(), "inference_ms": (time.perf_counter() - t0) * 1000.0}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    port = ap.parse_args().port
    print(f"Model '{MODEL_NAME}' loaded. Serving on http://localhost:{port}  (Ctrl+C to stop)", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level=os.environ.get("LOG_LEVEL", "info"))