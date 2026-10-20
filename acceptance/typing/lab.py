#!/usr/bin/env python3
"""T-18 lab: an isolated Core (port 4416, data under target/t18/lab, never
4317) with a long conversation and two more Agents that can stream.

  lab.py start WEB_DIR   build the fixture once (80 finished Turns on "Long"),
                         then leave Core running and serving WEB_DIR
  lab.py serve WEB_DIR   restart Core on the existing fixture with another UI build
  lab.py stop
The fixture is reused across builds, so before/after runs see the same
conversation. Core is a copy of the main checkout's release binary (main
fe51b05); T-18 changes no Rust.
"""
from pathlib import Path
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LAB = ROOT / "target/t18/lab"
BIN = ROOT / "target/t18/bin/yuzuno-workspace-fe51b05"
PORT = 4416
BASE = f"http://127.0.0.1:{PORT}/api"
TURNS = 80


def call(method, path, body=None):
    request = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                     headers={"Content-Type": "application/json", "x-yuzuno-client": "desktop"})
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read()
        return json.loads(raw) if raw else {}


def serve(web):
    stop()
    env = dict(os.environ, T18_TIMELINE=str(LAB / "timeline"))
    log = (LAB / "core.log").open("a")
    proc = subprocess.Popen([str(BIN), "--port", str(PORT), "--data-dir", str(LAB / "data"), "--web-dir", str(pathlib.Path(web).resolve()),
                             "--cwd", str(LAB / "task"), "--codex", str(HERE / "fake_codex.py")],
                            env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(100):
        try:
            call("GET", "/workspace")
            break
        except Exception:
            time.sleep(0.1)
    else:
        raise RuntimeError("Core did not start; see core.log")
    state = json.loads((LAB / "lab.json").read_text()) if (LAB / "lab.json").exists() else {}
    state.update(pid=proc.pid, base=f"http://127.0.0.1:{PORT}", web=str(pathlib.Path(web).resolve()))
    (LAB / "lab.json").write_text(json.dumps(state, indent=2))
    return state


def wait_idle(agent):
    for _ in range(300):
        detail = call("GET", f"/agents/{agent}")
        if detail["agent"]["connectionState"] == "connected" and detail["agent"]["status"] in ("idle", "offline") \
                and not any(t["status"] == "inProgress" for t in detail["turns"]):
            return
        time.sleep(0.1)
    raise RuntimeError(f"{agent} did not finish")


def start(web):
    if not BIN.exists():
        BIN.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2((str(Path.home() / 'yuzuno-next/target/release/yuzuno-workspace')), BIN)
    stop()
    if LAB.exists():
        shutil.rmtree(LAB)
    for sub in ("data", "task", "timeline"):
        (LAB / sub).mkdir(parents=True)
    serve(web)
    agents = {name: call("POST", "/agents", {"name": name, "cwd": str(LAB / "task"), "harness": "codex", "model": ""})["id"]
              for name in ("Long", "Busy one", "Busy two")}
    for agent in agents.values():
        for _ in range(100):
            if call("GET", f"/agents/{agent}")["agent"]["connectionState"] == "connected":
                break
            time.sleep(0.1)
    for n in range(TURNS):
        call("POST", f"/agents/{agents['Long']}/messages", {"clientMessageId": f"history-{n}", "text": f"history:{n}"})
        wait_idle(agents["Long"])
    state = json.loads((LAB / "lab.json").read_text())
    state.update(agents=agents, turns=len(call("GET", f"/agents/{agents['Long']}")["turns"]))
    (LAB / "lab.json").write_text(json.dumps(state, indent=2))
    print(json.dumps(state, indent=1))


def stop():
    path = LAB / "lab.json"
    if not path.exists():
        return
    pid = json.loads(path.read_text()).get("pid")
    if not pid:
        return
    try:
        os.kill(pid, signal.SIGINT)
    except ProcessLookupError:
        return
    for _ in range(100):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.2)
    os.kill(pid, signal.SIGTERM)


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "start":
        start(sys.argv[2])
    elif command == "serve":
        print(json.dumps(serve(sys.argv[2]), indent=1))
    else:
        stop()
