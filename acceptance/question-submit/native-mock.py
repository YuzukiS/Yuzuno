#!/usr/bin/python3
"""Isolated protocol timing fixture. No model, commands, network or user data."""
import json
import pathlib
import sys
import time

root = pathlib.Path(__file__).parent
thread_file = root / "thread.json"
config = json.loads((root / "config.json").read_text())
delay = config["delayMs"] / 1000


def log(kind, **fields):
    with (root / "native.jsonl").open("a") as output:
        output.write(json.dumps({"at": time.time_ns() / 1e6, "kind": kind, **fields}) + "\n")


def emit(value):
    print(json.dumps(value), flush=True)


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    params = request.get("params", {})
    if method is None and request.get("id") == "native-question":
        log("native_answer_received", response=request.get("result"))
        time.sleep(delay)
        emit({"method": "serverRequest/resolved", "params": {"threadId": "thread", "requestId": "native-question"}})
        log("native_answer_resolved")
        continue
    if "id" not in request:
        continue
    log("rpc_received", method=method, clientId=params.get("clientUserMessageId"))
    result = {}
    if method in ("thread/start", "thread/resume", "thread/read"):
        thread = json.loads(thread_file.read_text())
        result = {"thread": thread, "model": "test-model"}
    elif method == "model/list":
        result = {"data": [{"id": "test-model", "model": "test-model", "defaultReasoningEffort": "low", "supportedReasoningEfforts": [{"reasoningEffort": "low"}]}], "nextCursor": None}
    elif method == "config/read":
        result = {"config": {"approvals_reviewer": "auto_review", "sandbox_mode": "workspace-write"}}
    elif method == "configRequirements/read":
        result = {"requirements": None}
    elif method in ("turn/start", "turn/steer"):
        time.sleep(delay)
        thread = json.loads(thread_file.read_text())
        turn = thread["turns"][-1]
        if method == "turn/start":
            turn = {"id": "new-turn", "status": "inProgress", "items": []}
            thread["turns"].append(turn)
        item = {"id": "input-" + str(len(turn["items"])), "clientId": params.get("clientUserMessageId"), "type": "userMessage", "content": params["input"]}
        turn["items"].append(item)
        thread_file.write_text(json.dumps(thread))
        if method == "turn/start":
            emit({"method": "turn/started", "params": {"threadId": "thread", "turn": turn}})
        emit({"method": "item/completed", "params": {"threadId": "thread", "turnId": turn["id"], "item": item}})
        result = {"turnId": turn["id"]} if method == "turn/steer" else {"turn": turn}
    emit({"id": request["id"], "result": result})
    log("rpc_replied", method=method, clientId=params.get("clientUserMessageId"))
    if method == "thread/resume":
        emit({"id": "native-question", "method": "item/tool/requestUserInput", "params": {
            "threadId": "thread", "turnId": "active", "itemId": "native-question-item",
            "questions": [{"id": "answer", "question": "Native timing question"}]
        }})
