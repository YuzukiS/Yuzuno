#!/usr/bin/env python3
"""T-15 lab: an isolated Core (port 4415, data under target/t15/lab, never
4317) with scripted runtimes, left in the state the user hit.

  lab.py start   Core 1: a Codex and a Claude Agent each start a Turn that is
                 still running when Core stops. Core 2 then starts on the same
                 data (left running for browser.mjs) and both Agents are
                 offline with their last Turn unconfirmed.
  lab.py calls   what the runtimes received (no task may be sent twice)
  lab.py stop    stop Core 2
Core is a copy of the main checkout's release binary (main fe51b05; T-15
changes no Rust). The web UI is this worktree's web/dist (npm run build).
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
LAB = ROOT / "target/t15/lab"
BIN = ROOT / "target/t15/bin/yuzuno-workspace-fe51b05"
PORT = 4415
BASE = f"http://127.0.0.1:{PORT}/api"


def call(method, path, body=None):
    request = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                     headers={"Content-Type": "application/json", "x-yuzuno-client": "desktop"})
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read()
        return json.loads(raw) if raw else {}


def core(log_name, detached=False):
    env = dict(os.environ, T15_STATE=str(LAB / "native"), YUZUNO_NODE=sys.executable,
               YUZUNO_CLAUDE_BRIDGE=str(HERE / "fake_claude.py"))
    log = (LAB / log_name).open("w")
    proc = subprocess.Popen([str(BIN), "--port", str(PORT), "--data-dir", str(LAB / "data"), "--web-dir", str(ROOT / "web/dist"),
                             "--cwd", str(LAB / "task"), "--codex", str(HERE / "fake_codex.py")],
                            env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=detached)
    for _ in range(100):
        try:
            call("GET", "/workspace")
            return proc
        except Exception:
            time.sleep(0.1)
    raise RuntimeError(f"Core did not start; see {log_name}")


def wait(agent, check, what):
    for _ in range(100):
        detail = call("GET", f"/agents/{agent}")
        if check(detail):
            return detail
        time.sleep(0.2)
    raise RuntimeError(f"{agent}: {what}")


def stop(proc):
    proc.send_signal(signal.SIGINT)
    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        proc.terminate()
        proc.wait(timeout=10)


def start():
    if not BIN.exists():
        BIN.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2((str(Path.home() / 'yuzuno-next/target/release/yuzuno-workspace')), BIN)
    if LAB.exists():
        shutil.rmtree(LAB)
    for sub in ("data", "task", "native"):
        (LAB / sub).mkdir(parents=True)
    first = core("core-1.log")
    agents = {}
    try:
        for harness in ("codex", "claude"):
            agents[harness] = call("POST", "/agents", {"name": f"{harness.title()} lab", "cwd": str(LAB / "task"),
                                                       "harness": harness, "model": "bench" if harness == "claude" else ""})["id"]
        wait(agents["codex"], lambda d: d["agent"]["connectionState"] == "connected", "Codex did not connect")
        call("POST", f"/agents/{agents['codex']}/messages", {"clientMessageId": "t15-task-codex", "text": "Long task for Codex"})
        call("POST", f"/agents/{agents['claude']}/turns", {"text": "Long task for Claude"})
        for agent in agents.values():
            wait(agent, lambda d: any(t["status"] == "inProgress" for t in d["turns"]), "no running Turn")
    finally:
        stop(first)
    second = core("core-2.log", detached=True)
    state = {"pid": second.pid, "base": f"http://127.0.0.1:{PORT}", **agents}
    for harness, agent in agents.items():
        d = call("GET", f"/agents/{agent}")
        state[f"{harness}AfterRestart"] = {"status": d["agent"]["status"], "connection": d["agent"]["connectionState"],
                                           "lastTurn": d["turns"][-1]["status"], "error": d["agent"].get("error")}
    (LAB / "lab.json").write_text(json.dumps(state, indent=2, ensure_ascii=False))
    print(json.dumps(state, indent=1, ensure_ascii=False))


def calls():
    codex = [json.loads(line)["method"] for line in (LAB / "native/calls.jsonl").read_text().splitlines()]
    claude = [json.loads(line) for line in (LAB / "native/claude-calls.jsonl").read_text().splitlines()]
    print(json.dumps({
        "codexTurnStarts": codex.count("turn/start"), "codexSteers": codex.count("turn/steer"),
        "codexResumes": codex.count("thread/resume"), "claudeSends": sum(1 for c in claude if c["op"] == "send"),
        "claudeStarts": [c["sessionId"] for c in claude if c["op"] == "start"],
    }, indent=1))


def stop_lab():
    state = json.loads((LAB / "lab.json").read_text())
    try:
        os.kill(state["pid"], signal.SIGINT)
    except ProcessLookupError:
        return
    for _ in range(100):
        try:
            os.kill(state["pid"], 0)
        except ProcessLookupError:
            return
        time.sleep(0.2)
    os.kill(state["pid"], signal.SIGTERM)


if __name__ == "__main__":
    {"start": start, "calls": calls, "stop": stop_lab}[sys.argv[1]]()
