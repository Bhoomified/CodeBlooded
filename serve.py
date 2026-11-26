"""Multiverse of Monsoon - inference server (Round 1 contract).

The judge runs this exact file offline:  python serve.py --port 8000
It listens on 0.0.0.0, loads the model bundle from server/bundle once, runs a warm-up rollout,
and only then answers "ready" on /health. Units on the wire are always physical.
"""
import argparse
import os
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # works from any folder or launcher
sys.dont_write_bytecode = True  # never write __pycache__ into the (read-only) repo

import numpy as np
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from server.core import Simulator

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])  # front end calls us
STATE = {"sim": None, "ready": False, "error": ""}
LOCK = threading.Lock()  # one rollout at a time keeps latency predictable


def load():
    try:
        sim = Simulator()
        warm = np.broadcast_to(((np.array([300, 2, 1, 1, 100800, 40], "f4"))[:, None, None]), (3, 6, 32, 36)).copy()
        sim.simulate(warm, [0.0, 1.0], 10, None)  # warm-up: "ready" is only reported once a rollout has succeeded
        STATE["sim"], STATE["ready"] = sim, True
        print(f"Model ready: {sim.model_name}", flush=True)
        for e in sim.events:
            print(f"  degraded: {e}", flush=True)
    except Exception as e:
        STATE["error"] = f"{type(e).__name__}: {e}"
        print(f"Model failed to load: {STATE['error']}", flush=True)


def _arr(x):
    """Accept nested lists (the contract) or {'b64': ..., 'shape': [...]} (tolerated)."""
    if isinstance(x, dict):
        import base64
        return np.frombuffer(base64.b64decode(x["b64"]), dtype="<f4").reshape(x["shape"]).astype("f4")
    return np.asarray(x, dtype="f4")


@app.post("/health")
@app.get("/health")  # GET is only for humans and browsers; the judge uses POST
def health():
    if STATE["ready"]:
        return {"status": "ready", "model_name": STATE["sim"].model_name}
    return JSONResponse({"status": "loading", "detail": STATE["error"]}, status_code=503)


@app.post("/simulate")
async def simulate(request: Request):
    if not STATE["ready"]:
        return JSONResponse({"error": "model not ready"}, status_code=503)
    try:
        body = await request.json()
        init = _arr(body["init_states"])
        pert = None if body.get("perturbation") is None else _arr(body["perturbation"])
        with LOCK:
            out, ms, diag = STATE["sim"].simulate(init, body["doy_sincos"], body.get("steps", 10), pert)
    except (KeyError, ValueError, TypeError) as e:  # bad input -> clear 422, never a 500
        return JSONResponse({"error": str(e)[:300]}, status_code=422)
    return {"rollout": out.astype("f4").tolist(), "inference_ms": ms, "diagnostics": diag}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    port = ap.parse_args().port
    threading.Thread(target=load, daemon=True).start()
    print(f"Serving on http://localhost:{port}  (leave this running; use a second terminal; Ctrl+C to stop)", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level=os.environ.get("LOG_LEVEL", "warning"))
