#!/usr/bin/env python3
"""Reproduce T19 on the published core.6 binary in disposable local data."""
import hashlib
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

root = pathlib.Path(__file__).resolve().parents[2]
lab = root / "target/t19/baseline"
lab.mkdir(parents=True, exist_ok=False)
binary = pathlib.Path(sys.argv[1]).resolve()
for sub in ["task", "native", "web"]:
    (lab / sub).mkdir()
native = root / "acceptance/reconnect-timeout/native.py"
native.chmod(0o755)
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
assert port != 4317
base = f"http://127.0.0.1:{port}/api"
env = dict(os.environ, T19_NATIVE=str(lab / "native"))

def call(method, path, body=None):
    req = urllib.request.Request(base + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "X-Yuzuno-Client": "desktop"})
    try:
        with urllib.request.urlopen(req, timeout=65) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)

def start(index):
    log = (lab / f"core-{index}.log").open("w")
    proc = subprocess.Popen([str(binary), "--port", str(port), "--data-dir", str(lab / "data"),
        "--web-dir", str(lab / "web"), "--cwd", str(lab / "task"), "--codex", str(native)],
        env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            if call("GET", "/workspace")[0] == 200:
                return proc
        except OSError:
            pass
        time.sleep(.05)
    raise RuntimeError("isolated Core did not start")

def stop(proc):
    proc.send_signal(signal.SIGINT)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

def detail(agent):
    return call("GET", f"/agents/{agent}")[1]

first = start(1)
try:
    status, agent = call("POST", "/agents", {"name": "T19 baseline", "cwd": str(lab / "task"), "model": ""})
    assert status == 200, (status, agent)
    aid = agent["id"]
    for _ in range(100):
        if detail(aid)["agent"]["connectionState"] == "connected":
            break
        time.sleep(.05)
    assert detail(aid)["agent"]["connectionState"] == "connected"
    status, receipt = call("POST", f"/agents/{aid}/messages", {"clientMessageId": "t19-original", "text": "Only original task"})
    assert status == 200, (status, receipt)
finally:
    stop(first)
(lab / "native/lose-resume").touch()
second = start(2)
try:
    started = time.monotonic()
    status, error = call("POST", f"/agents/{aid}/reconnect", {})
    elapsed = time.monotonic() - started
    after = detail(aid)
    assert status == 400 and "超时" in error["error"], (status, error)
    assert after["agent"]["connectionState"] == "connecting", after["agent"]
    old_pid = int((lab / "native/resume-received").read_text())
    os.kill(old_pid, 0)
    (lab / "native/lose-resume").unlink()
    retry_status, retry = call("POST", f"/agents/{aid}/reconnect", {})
    calls = [json.loads(line) for line in (lab / "native/calls.jsonl").read_text().splitlines()]
    resumes = [c for c in calls if c["method"] == "thread/resume"]
    assert retry_status == 200, (retry_status, retry)
    assert len(resumes) == 2 and resumes[0]["pid"] != resumes[1]["pid"], resumes
    assert sum(c["method"] == "turn/start" for c in calls) == 1
    try:
        os.kill(old_pid, 0)
        old_alive = True
    except ProcessLookupError:
        old_alive = False
    report = {"binary": str(binary), "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "port": port, "afterTimeout": {"status": after["agent"]["status"], "connectionState": after["agent"]["connectionState"], "error": error},
        "elapsedSeconds": round(elapsed, 2), "originalResumePid": old_pid, "retryResumePid": resumes[1]["pid"],
        "originalProcessStillAliveAfterRetry": old_alive, "sameThread": retry["agent"]["threadId"] == "thread-t19",
        "originalTaskSubmissions": 1, "reproduced": True}
    (lab / "result.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(report, ensure_ascii=False))
finally:
    stop(second)
