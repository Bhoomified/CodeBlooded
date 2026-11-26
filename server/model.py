"""Model wrapper used by serve.py. Swap the placeholder for the real model later; keep these two function signatures.

Rules for this folder (repo-scan): no dates, no weather URLs, no imports from train/, eval/ or dashboard/.
"""
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
MODEL_NAME = "placeholder-persistence"
NC, NLAT, NLON = 6, 32, 36


def load_model():
    """Load weights once from files in this folder (e.g. HERE / 'cnn.pt'). Placeholder: nothing to load."""
    return None


def simulate(model, init_states, doy_sincos, steps, perturbation):
    """init_states [3,6,32,36] physical units, oldest first; perturbation [6,32,36] or None.
    Returns [steps,6,32,36] physical units. doy_sincos is for init_states[-1]."""
    x = np.asarray(init_states, dtype="f4")
    if x.shape != (3, NC, NLAT, NLON):
        raise ValueError(f"init_states must be [3,6,32,36], got {list(x.shape)}")
    if not 1 <= steps <= 30:
        raise ValueError("steps must be between 1 and 30")
    last = x[-1].copy()
    if perturbation is not None:
        p = np.asarray(perturbation, dtype="f4")
        if p.shape != (NC, NLAT, NLON):
            raise ValueError(f"perturbation must be [6,32,36], got {list(p.shape)}")
        last = last + p  # the shock is added to the last input day before simulating
    last[1] = np.clip(last[1], 0, None)  # rain can never be negative
    return np.repeat(last[None], steps, axis=0)  # PLACEHOLDER (persistence): replace with the real model