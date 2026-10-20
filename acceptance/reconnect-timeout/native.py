#!/usr/bin/env python3
"""Deterministic stdio peer. Logs identities/methods only, never credentials."""
import json
import os
import pathlib
import sys

root = pathlib.Path(os.environ["T19_NATIVE"])
root.mkdir(parents=True, exist_ok=True)
state = root / "thread.json"

def emit(value):
    print(json.dumps(value), flush=True)

def log(method, thread=None):
    with (root / "calls.jsonl").open("a") as out:
        out.write(json.dumps({"pid": os.getpid(), "method": method, "thread": thread}) + "\n")

log("process/started")
for line in sys.stdin:
    r = json.loads(line)
    m, p = r.get("method"), r.get("params", {})
    log(m, p.get("threadId"))
    if m is None or "id" not in r:
        continue
    result = {}
    if m == "thread/start":
        state.write_text(json.dumps({"id": "thread-t19", "status": {"type": "idle"}, "turns": []}))
        result = {"thread": json.loads(state.read_text()), "model": "fixture"}
    elif m == "thread/resume":
        if (root / "lose-resume").exists():
            (root / "resume-received").write_text(str(os.getpid()))
            continue
        result = {"thread": json.loads(state.read_text()), "model": "fixture"}
    elif m == "thread/read":
        result = {"thread": json.loads(state.read_text())}
    elif m == "turn/start":
        thread = json.loads(state.read_text())
        turn = {"id": "turn-t19", "status": "inProgress", "items": []}
        thread["turns"] = [turn]
        thread["status"] = {"type": "active"}
        state.write_text(json.dumps(thread))
        result = {"turn": turn}
    elif m == "config/read":
        result = {"config": {"approval_policy": "on-request", "sandbox_mode": "workspace-write"}}
    elif m == "configRequirements/read":
        result = {"requirements": None}
    emit({"id": r["id"], "result": result})
