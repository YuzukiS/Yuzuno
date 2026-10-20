#!/usr/bin/env python3
"""Detail payload size and fetch time through an isolated Core on a DB copy.

Usage: bench.py <core-binary> <label> <port> [web-dir]

Copies data/orig (the daily DB copy) to data/lab-<label>, starts the given
Core on 127.0.0.1:<port> with a non-runnable Codex, and times
GET /api/agents/{id} for the largest records. Prints sizes and times only.
"""
import json
import os
import shutil
import signal
import statistics
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = 10


def get(port, path):
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"Host": f"127.0.0.1:{port}"})
    start = time.perf_counter()
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read()
    return body, time.perf_counter() - start


def main():
    binary, label, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
    web = sys.argv[4] if len(sys.argv) > 4 else os.path.join(HERE, "no-web")
    assert 4460 <= port <= 4469, "use the isolated port range"
    data = os.path.join(HERE, "data", f"lab-{label}")
    shutil.rmtree(data, ignore_errors=True)
    os.makedirs(data)
    for name in ("workspace.sqlite", "workspace.sqlite-wal", "workspace.sqlite-shm"):
        source = os.path.join(HERE, "data", "orig", name)
        if os.path.exists(source):
            shutil.copy(source, os.path.join(data, name))
    log = open(os.path.join(data, "core.log"), "w")
    core = subprocess.Popen([binary, "--port", str(port), "--data-dir", data, "--web-dir", web,
                             "--codex", "/bin/false", "--cwd", data], stdout=log, stderr=log)
    try:
        for _ in range(600):
            try:
                get(port, "/api/health")
                break
            except Exception:
                time.sleep(0.1)
        workspace, listed = get(port, "/api/workspace")
        agents = sorted(json.loads(workspace)["agents"], key=lambda a: a["id"])
        print(f"[{label}] /api/workspace {len(workspace)} B in {listed*1000:.0f} ms (cold)")
        results = {}
        for agent in agents:
            path = f"/api/agents/{agent['id']}"
            body, _ = get(port, path)  # warm-up
            times = []
            for _ in range(RUNS):
                body, elapsed = get(port, path)
                times.append(elapsed)
            detail = json.loads(body)
            items = sum(len(t.get("items") or []) for t in detail["turns"])
            truncated = sum(1 for t in detail["turns"] for i in t.get("items") or [] if "_yuzunoTruncated" in i)
            results[agent["id"]] = {"bytes": len(body), "median_ms": statistics.median(times) * 1000,
                                    "min_ms": min(times) * 1000, "max_ms": max(times) * 1000,
                                    "items": items, "truncated": truncated}
            print(f"[{label}] {agent['id'][:8]} {agent.get('harness','?'):6} {len(body)/1e6:6.2f} MB  "
                  f"median {statistics.median(times)*1000:6.0f} ms  min {min(times)*1000:6.0f}  max {max(times)*1000:6.0f}  "
                  f"items {items}  truncated {truncated}")
        with open(os.path.join(HERE, f"bench-{label}.json"), "w") as out:
            json.dump(results, out, indent=1)
    finally:
        core.send_signal(signal.SIGINT)
        try:
            core.wait(timeout=20)
        except subprocess.TimeoutExpired:
            core.terminate()
            core.wait(timeout=20)
        log.close()


if __name__ == "__main__":
    main()
