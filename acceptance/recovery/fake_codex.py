#!/usr/bin/env python3
"""Scripted Codex app-server for T-15. Native state lives in $T15_STATE, so it
outlives Core: a started Turn is shown to Core as running, but natively it is
already finished, as if it completed while Core was away. thread/read and
thread/resume report that truth. If $T15_STATE/fail_resume exists, resume is
refused (a recoverable failure). Every request is logged to calls.jsonl.
"""
import json
import os
import pathlib
import sys
import uuid

state = pathlib.Path(os.environ["T15_STATE"])
state.mkdir(parents=True, exist_ok=True)


def emit(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


def thread_file(tid):
    return state / f"thread-{tid}.json"


def turns(tid):
    path = thread_file(tid)
    return json.loads(path.read_text()) if path.exists() else []


def thread(tid):
    return {"id": tid, "status": {"type": "idle"}, "turns": turns(tid), "cwd": str(state)}


for line in sys.stdin:
    request = json.loads(line)
    with (state / "calls.jsonl").open("a") as log:
        log.write(json.dumps({"method": request.get("method"), "params": request.get("params")}) + "\n")
    if "id" not in request or "method" not in request:
        continue
    method, params = request["method"], request.get("params", {})
    result = {}
    if method == "thread/start":
        tid = str(uuid.uuid4())
        thread_file(tid).write_text("[]")
        result = {"thread": thread(tid), "model": "bench-model"}
    elif method == "thread/resume":
        if (state / "fail_resume").exists():
            emit({"id": request["id"], "error": {"code": -32603, "message": "native session store is busy; try again"}})
            continue
        result = {"thread": thread(params["threadId"]), "model": "bench-model"}
    elif method == "thread/read":
        result = {"thread": thread(params["threadId"])}
    elif method == "thread/turns/list":
        result = {"data": [], "nextCursor": None}
    elif method == "model/list":
        result = {"data": [{"id": "bench-model", "model": "bench-model", "defaultReasoningEffort": "low",
                            "supportedReasoningEfforts": [{"reasoningEffort": "low"}]}], "nextCursor": None}
    elif method == "config/read":
        result = {"config": {"approval_policy": "on-request", "sandbox_mode": "workspace-write"}}
    elif method == "configRequirements/read":
        result = {"requirements": None}
    elif method == "turn/start":
        tid = params["threadId"]
        turn_id = f"turn-{uuid.uuid4()}"
        user = {"id": f"{turn_id}:input", "type": "userMessage", "clientId": params.get("clientUserMessageId"),
                "content": params["input"]}
        answer = {"id": f"{turn_id}:answer", "type": "agentMessage", "text": "Finished while Core was away."}
        # Natively this Turn finishes; Core only ever hears that it started.
        thread_file(tid).write_text(json.dumps(turns(tid) + [{"id": turn_id, "status": "completed", "items": [user, answer]}]))
        running = {"id": turn_id, "status": "inProgress", "items": [user]}
        emit({"id": request["id"], "result": {"turn": running}})
        emit({"method": "turn/started", "params": {"threadId": tid, "turn": running}})
        emit({"method": "item/completed", "params": {"threadId": tid, "turnId": turn_id, "item": user}})
        continue
    emit({"id": request["id"], "result": result})
