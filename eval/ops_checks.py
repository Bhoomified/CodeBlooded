"""Grader-conditions check. Run INSIDE a network-less namespace against a read-only copy of the repo:

  unshare -n sh -c 'ip link set lo up; python3 eval/ops_checks.py /tmp/sub /path/to/india_climate_train.nc'

Starts serve.py as the grader does, then: health time, kit schema validator, latency of real 10-step calls with JSON
lists (kit client), 4 concurrent calls, peak memory, no files written into the repo, repo scan.
"""
import hashlib, json, os, subprocess, sys, time, threading
from pathlib import Path
import numpy as np

sub = Path(sys.argv[1]); data = sys.argv[2]
from monsoon_r1 import client as K, contract as C
from monsoon_r1.repo_scan import scan

def tree_hash(root):
    h = {}
    for p in sorted(root.rglob("*")):
        if p.is_file(): h[str(p.relative_to(root))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return h

report = {}
before = tree_hash(sub)
try:
    socket_test = subprocess.run([sys.executable, "-c", "import urllib.request;urllib.request.urlopen('https://pypi.org',timeout=3)"],
                                 capture_output=True)
    report["internet_reachable_from_sandbox"] = socket_test.returncode == 0
except Exception:
    report["internet_reachable_from_sandbox"] = False

env = dict(os.environ, OMP_NUM_THREADS="4", TMPDIR="/tmp")
t0 = time.time()
srv = subprocess.Popen([sys.executable, "serve.py", "--port", "8000"], cwd=sub, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
ok, why = K.wait_ready("http://127.0.0.1:8000", 120, allow_private=True)
report["health_ready"] = ok; report["seconds_to_ready"] = round(time.time() - t0, 1)

val = subprocess.run([sys.executable, "-m", "monsoon_r1.schema_validator", "http://127.0.0.1:8000"], capture_output=True, text=True)
report["schema_validator"] = val.stdout.strip().splitlines()

import xarray as xr
X = xr.open_dataset(data)["data"].values.astype("f4")
rng = np.random.default_rng(3); starts = rng.choice(np.arange(len(X) - 700, len(X) - 13), 20, replace=False)
walls, server_ms = [], []
for t in starts:
    payload = {"init_states": C.encode_list(X[t - 2:t + 1]), "doy_sincos": C.doy_sincos(180), "steps": 10, "perturbation": None}
    r = K.call_simulate("http://127.0.0.1:8000", payload, allow_private=True)
    assert r.ok, r.error
    walls.append(r.wall_s); server_ms.append(r.server_ms or 0)
report["latency_10step_wall_s"] = {"mean": round(float(np.mean(walls)), 3), "max": round(float(np.max(walls)), 3)}
report["latency_server_ms_mean"] = round(float(np.mean(server_ms)), 1)

res = [None] * 4
def worker(i):
    payload = {"init_states": C.encode_list(X[starts[i] - 2:starts[i] + 1]), "doy_sincos": C.doy_sincos(180), "steps": 10, "perturbation": None}
    res[i] = K.call_simulate("http://127.0.0.1:8000", payload, allow_private=True)
th = [threading.Thread(target=worker, args=(i,)) for i in range(4)]; [x.start() for x in th]; [x.join() for x in th]
report["concurrent_4_all_ok"] = all(r.ok for r in res); report["concurrent_4_max_wall_s"] = round(max(r.wall_s for r in res), 3)

status = Path(f"/proc/{srv.pid}/status").read_text()
report["server_peak_rss_mb"] = int([l for l in status.splitlines() if l.startswith("VmHWM")][0].split()[1]) // 1024
srv.terminate(); srv.wait(10)
after = tree_hash(sub)
report["repo_unchanged_after_run"] = before == after
s = scan(sub)
report["repo_scan"] = {"points": s["points"], "flags": s["flags"], "health": s["health"], "inference_files": s["inference_files"]}
print(json.dumps(report, indent=1))
