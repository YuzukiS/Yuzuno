#!/usr/bin/env python3
"""Scripted Claude SDK bridge (bridge.mjs protocol) for T-15. A sent prompt
starts streaming and never finishes, so a Core restart leaves its Turn
running in the record. Every command is logged to $T15_STATE/claude-calls.jsonl.
"""
import json
import os
import pathlib
import sys
import uuid

state = pathlib.Path(os.environ["T15_STATE"])
state.mkdir(parents=True, exist_ok=True)
session = {"id": None}


def emit(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    command = json.loads(line)
    with (state / "claude-calls.jsonl").open("a") as log:
        log.write(json.dumps({"op": command.get("op"), "sessionId": command.get("sessionId"),
                              "text": command.get("text")}) + "\n")
    op, rid = command.get("op"), command.get("id")
    if op == "start":
        session["id"] = command.get("sessionId") or str(uuid.uuid4())
        emit({"type": "response", "id": rid, "result": {"started": True, "sessionId": session["id"], "executable": "fake-claude",
                                                        "account": {"email": "lab@example.invalid"}, "version": "2.1.280"}})
        emit({"type": "event", "turnId": None, "event": {"type": "system", "subtype": "init", "model": "bench",
                                                         "permissionMode": "default", "session_id": session["id"]}})
    elif op == "send":
        emit({"type": "response", "id": rid, "result": {"queued": True, "turnId": command["turnId"]}})
        for event in ({"type": "message_start", "message": {"id": "m-1"}},
                      {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Working on it"}}):
            emit({"type": "event", "turnId": command["turnId"],
                  "event": {"type": "stream_event", "event": event, "session_id": session["id"]}})
    elif op == "close":
        emit({"type": "response", "id": rid, "result": {"closed": True}})
        sys.exit(0)
    else:
        emit({"type": "response", "id": rid, "result": {"models": []} if op == "models" else {}})
