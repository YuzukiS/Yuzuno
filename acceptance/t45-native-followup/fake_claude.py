#!/usr/bin/env python3
"""Scripted Claude bridge for the T-45 check: the NDJSON protocol of
runtimes/claude/bridge.mjs, with no model, no CLI and no credentials. Core
starts it through YUZUNO_NODE=python3 and YUZUNO_CLAUDE_BRIDGE=<this file>.

- Once $T45_STATE/wake exists, Claude runs a turn of its own, as after a
  background task's notice: native-wake, shown at once (no prompt is in
  flight) and still running.
- A follow-up sent to that turn is queued there, as bridge.mjs queues it.
  Any other target is refused, as bridge.mjs refuses it.
- Once $T45_STATE/read exists, Claude names the follow-up in that same turn
  (message_delivery accepted on native-wake), answers it and ends the turn.

Every command is logged to $T45_STATE/calls.jsonl.
"""
import json
import os
import pathlib
import sys
import threading
import time
import uuid

STATE = pathlib.Path(os.environ["T45_STATE"])
STATE.mkdir(parents=True, exist_ok=True)
NATIVE = "native-wake"
out = threading.Lock()
session = {"id": None, "running": False, "follow_up": None}


def emit(value):
    with out:
        sys.stdout.write(json.dumps(value) + "\n")
        sys.stdout.flush()


def frame(event):
    emit({"type": "event", "turnId": NATIVE, "nativeTurnId": NATIVE,
          "event": {"session_id": session["id"], "parent_tool_use_id": None, "uuid": str(uuid.uuid4()), **event}})


def reply(text, **extra):
    frame({"type": "assistant", "message": {"id": f"msg-{uuid.uuid4()}", "role": "assistant",
                                            "content": [{"type": "text", "text": text}]}, **extra})


def wait_for(name):
    while not (STATE / name).exists():
        time.sleep(0.1)


def claude_on_its_own():
    wait_for("wake")
    session["running"] = True
    reply("A background check finished. Reading the mail it left.")
    wait_for("read")
    follow_up = session["follow_up"]
    if follow_up:
        emit({"type": "message_delivery", "clientMessageId": follow_up["clientMessageId"], "status": "accepted", "turnId": NATIVE})
        reply(f"Noted: {follow_up['text']}", user_message_uuid=follow_up["uuid"], user_message_uuids=[follow_up["uuid"]])
    frame({"type": "result", "subtype": "success", "is_error": False, "duration_ms": 1200, "num_turns": 1, "result": "Noted.",
           "origin": {"kind": "task-notification"},
           **({"user_message_uuids": [follow_up["uuid"]]} if follow_up else {})})
    session["running"] = False


for line in sys.stdin:
    command = json.loads(line)
    op, rid = command.get("op"), command.get("id")
    with (STATE / "calls.jsonl").open("a") as log:
        log.write(json.dumps({"op": op, "expectedTurnId": command.get("expectedTurnId"),
                              "clientMessageId": command.get("clientMessageId"), "text": command.get("text")}) + "\n")
    if op == "start":
        session["id"] = command.get("sessionId") or str(uuid.uuid4())
        emit({"type": "response", "id": rid, "result": {"started": True, "sessionId": session["id"], "executable": "fake-claude",
                                                        "account": {"email": "lab@example.invalid"}, "version": "2.1.280"}})
        threading.Thread(target=claude_on_its_own, daemon=True).start()
    elif op == "append":
        if not session["running"] or command.get("expectedTurnId") != NATIVE or session["follow_up"]:
            emit({"type": "response", "id": rid, "error": "The turn to add to has already ended"})
            continue
        session["follow_up"] = {"clientMessageId": command["clientMessageId"], "uuid": command.get("uuid") or str(uuid.uuid4()),
                                "text": command.get("text", "")}
        emit({"type": "response", "id": rid, "result": {"queued": True, "uuid": session["follow_up"]["uuid"], "turnId": NATIVE}})
    elif op == "send":
        emit({"type": "response", "id": rid, "error": "This check sends no prompt"})
    elif op == "close":
        emit({"type": "response", "id": rid, "result": {"closed": True}})
        sys.exit(0)
    elif op == "interrupt":
        emit({"type": "response", "id": rid, "result": {"interrupted": False}})
    else:
        emit({"type": "response", "id": rid, "result": {"models": []} if op == "models" else {}})
