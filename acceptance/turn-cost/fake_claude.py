#!/usr/bin/env python3
"""Scripted Claude SDK bridge (NDJSON, same protocol as runtimes/claude/bridge.mjs)
for T-9 cost measurements. Started by Core via YUZUNO_NODE=python3 and
YUZUNO_CLAUDE_BRIDGE=<this file>. No model, no CLI, no credentials.

The prompt selects the script, as for fake_codex.py:
  warmup:N:KB          N tool calls whose results are KB kilobytes each
  run:D:O:A:R          D text deltas, O 2 KB tool-result blocks, A permission requests, R events/s
  mix:PATH:N:A:R       the first N real SDK events from PATH (mix.py), then A permission requests, R events/s
  killtest             kill.py: msg-1 streamed and completed; msg-2 thinks (completed thinking block),
                       streams text for 12.5 s and completes; then msg-3 streams until Core is killed
Every bridge message carries _bench = k; emit times go to $T9_TIMELINE/claude-<pid>.jsonl.
"""
import json
import os
import pathlib
import sys
import threading
import time
import uuid

timeline_dir = pathlib.Path(os.environ.get("T9_TIMELINE", "."))
timeline_dir.mkdir(parents=True, exist_ok=True)
timeline = (timeline_dir / f"claude-{os.getpid()}.jsonl").open("a", buffering=1)
out = threading.Lock()
replies = {}
replied = threading.Condition()
counter = [0]
state = {"session": None, "turn": None}


def emit(value):
    with out:
        sys.stdout.write(json.dumps(value) + "\n")
        sys.stdout.flush()


def note(kind, k, **extra):
    timeline.write(json.dumps({"k": k, "m": kind, "thread": state["session"], "t": time.time(), **extra}) + "\n")


def event(turn, body):
    counter[0] += 1
    k = counter[0]
    note(f"claude/{body['type']}", k)
    emit({"type": "event", "turnId": turn, "event": dict(body, session_id=state["session"]), "_bench": k})


def permission(turn, request):
    counter[0] += 1
    k = counter[0]
    note("permission", k, request=request)
    emit({"type": "permission", "turnId": turn, "requestId": request, "toolName": "Bash",
          "input": {"command": "rm -rf build"}, "_bench": k})
    with replied:
        replied.wait_for(lambda: request in replies, timeout=600)
    note("reply", k, request=request, ok=request in replies)


def pace(rate):
    if rate > 0:
        time.sleep(1 / rate)


def script(turn, text):
    parts = text.split(":")
    message = f"msg-{uuid.uuid4()}"
    if parts[0] == "warmup":
        count, kb = int(parts[1]), int(parts[2])
        block = ("x" * 99 + "\n") * (kb * 1024 // 100)
        for n in range(count):
            tool = f"warm-{turn}-{n}"
            event(turn, {"type": "assistant", "message": {"id": f"{message}-{n}", "content": [
                {"type": "tool_use", "id": tool, "name": "Bash", "input": {"command": f"cat big-{n}.log"}}]}})
            event(turn, {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": tool, "content": block, "is_error": False}]}})
    elif parts[0] == "run":
        deltas, outputs, approvals, rate = (int(p) for p in parts[1:5])
        event(turn, {"type": "stream_event", "event": {"type": "message_start", "message": {"id": message}}})
        text = []
        for n in range(deltas):
            chunk = f"Streaming chunk {n} of a long answer. "
            text.append(chunk)
            event(turn, {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                                                           "delta": {"type": "text_delta", "text": chunk}}})
            pace(rate)
        event(turn, {"type": "assistant", "message": {"id": message, "content": [{"type": "text", "text": "".join(text)}]}})
        for n in range(outputs):
            tool = f"tool-{turn}-{n}"
            event(turn, {"type": "assistant", "message": {"id": f"{message}-tool-{n}", "content": [
                {"type": "tool_use", "id": tool, "name": "Bash", "input": {"command": "make test"}}]}})
            event(turn, {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": tool, "content": (f"line {n} " + "o" * 2040)[:2047], "is_error": False}]}})
            pace(rate)
        for n in range(approvals):
            permission(turn, f"perm-{os.getpid()}-{n}-{uuid.uuid4()}")
    elif parts[0] == "killtest":
        for n, (deltas, rate) in enumerate([(30, 200), (250, 20), (2000, 20)], start=1):
            mid = f"msg-{n}"
            event(turn, {"type": "stream_event", "event": {"type": "message_start", "message": {"id": mid}}})
            if n == 2:
                thinking = "Thinking it over."
                event(turn, {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                                                               "delta": {"type": "thinking_delta", "thinking": thinking}}})
                event(turn, {"type": "assistant", "uuid": f"{mid}-0", "message": {"id": mid, "content": [
                    {"type": "thinking", "thinking": thinking}]}})
            text = []
            for d in range(deltas):
                chunk = f"Chunk {d} of {mid}. "
                text.append(chunk)
                event(turn, {"type": "stream_event", "event": {"type": "content_block_delta", "index": 1,
                                                               "delta": {"type": "text_delta", "text": chunk}}})
                pace(rate)
            if n < 3:
                event(turn, {"type": "assistant", "uuid": f"{mid}-1", "message": {"id": mid, "content": [
                    {"type": "text", "text": "".join(text)}]}})
                note(f"marker/{mid}", 0)
    elif parts[0] == "mix":
        path, count, approvals, rate = parts[1], int(parts[2]), int(parts[3]), float(parts[4])
        with open(path) as rows:
            for n, line in enumerate(rows):
                if n == count:
                    break
                # Real events, in this session and Turn (event() sets the session).
                event(turn, json.loads(line)["event"])
                pace(rate)
        for n in range(approvals):
            permission(turn, f"perm-{os.getpid()}-{n}-{uuid.uuid4()}")
    event(turn, {"type": "result", "is_error": False, "result": "done", "subtype": "success"})
    state["turn"] = None


def handle(command):
    op, rid = command.get("op"), command.get("id")
    result = {}
    if op == "start":
        state["session"] = command.get("sessionId") or str(uuid.uuid4())
        result = {"started": True, "sessionId": state["session"], "executable": "fake-claude",
                  "account": {"email": "bench@example.invalid"}, "version": "2.1.280",
                  "models": [{"value": "bench", "displayName": "Bench"}]}
        emit({"type": "response", "id": rid, "result": result})
        event(None, {"type": "system", "subtype": "init", "model": "bench", "permissionMode": "default"})
        return
    if op == "models":
        result = {"models": [{"value": "bench", "displayName": "Bench"}]}
    elif op == "notify_mailbox":
        # A mailbox doorbell for a running Turn; logged for its delay.
        note("received/steer", 0, text=command["text"][:80])
        emit({"type": "response", "id": rid, "result": {"queued": True}})
        emit({"type": "mailbox_delivery", "turnId": command["expectedTurnId"],
              "clientMessageId": command["clientMessageId"], "status": "injected"})
        return
    elif op == "send":
        note("received/start", 0, text=command["text"][:80])
        state["turn"] = command["turnId"]
        result = {"queued": True, "turnId": command["turnId"]}
        emit({"type": "response", "id": rid, "result": result})
        threading.Thread(target=script, args=(command["turnId"], command["text"]), daemon=True).start()
        return
    elif op == "respond":
        with replied:
            replies[command.get("requestId")] = command
            replied.notify_all()
        result = {"responded": True}
    elif op == "interrupt":
        result = {"interrupted": False}
    elif op == "close":
        emit({"type": "response", "id": rid, "result": {"closed": True}})
        sys.exit(0)
    emit({"type": "response", "id": rid, "result": result})


for line in sys.stdin:
    handle(json.loads(line))
