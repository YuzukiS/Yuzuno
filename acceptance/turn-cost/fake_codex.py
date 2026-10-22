#!/usr/bin/env python3
"""Scripted Codex app-server for T-9 cost measurements. No model, no tools.

The user message selects the script:
  warmup:N:KB          N completed command Items of KB kilobytes (builds a large record)
  run:D:O:A:R          D message deltas, O 2 KB output deltas, A approvals, R events/s (0 = as fast as possible)
  mix:PATH:N:A:R       the first N real notifications from PATH (mix.py), then A approvals, R events/s
  question             one native question (requestUserInput); the Turn ends once it is answered
  killtest             kill.py: msg-1 streamed and completed, msg-2 streamed for 12.5 s and completed,
                       then msg-3 streams until Core is killed
Every notification carries params._bench = k; its emit time is logged to
$T9_TIMELINE/codex-<pid>.jsonl, so ingestion lag can be read off the journal.
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
timeline = (timeline_dir / f"codex-{os.getpid()}.jsonl").open("a", buffering=1)
out = threading.Lock()
replies = {}
replied = threading.Condition()
counter = [0]


def emit(value):
    with out:
        sys.stdout.write(json.dumps(value) + "\n")
        sys.stdout.flush()


def note(method, thread, k, **extra):
    timeline.write(json.dumps({"k": k, "m": method, "thread": thread, "t": time.time(), **extra}) + "\n")


def notify(method, params, thread):
    counter[0] += 1
    k = counter[0]
    params = dict(params, threadId=thread, _bench=k)
    note(method, thread, k)
    emit({"method": method, "params": params})
    return k


def ask(method, params, thread):
    counter[0] += 1
    k = counter[0]
    rid = f"bench-{os.getpid()}-{k}"
    params = dict(params, threadId=thread, _bench=k)
    note(method, thread, k, request=rid)
    emit({"id": rid, "method": method, "params": params})
    with replied:
        replied.wait_for(lambda: rid in replies, timeout=600)
    note("reply", thread, k, request=rid, ok=rid in replies)


def pace(rate):
    if rate > 0:
        time.sleep(1 / rate)


def replay(method, params, thread, turn):
    """A real notification, moved into this thread and Turn; otherwise as recorded."""
    counter[0] += 1
    k = counter[0]
    params = dict(params, _bench=k)
    if "threadId" in params:
        params["threadId"] = thread
    if "turnId" in params:
        params["turnId"] = turn
    note(method, thread, k)
    emit({"method": method, "params": params})


def script(thread, turn, text):
    parts = text.split(":")
    if parts[0] == "warmup":
        count, kb = int(parts[1]), int(parts[2])
        block = ("x" * 99 + "\n") * (kb * 1024 // 100)
        for n in range(count):
            item = {"id": f"warm-{turn}-{n}", "type": "commandExecution", "command": f"cat big-{n}.log",
                    "status": "completed", "aggregatedOutput": block, "exitCode": 0}
            notify("item/completed", {"turnId": turn, "item": item}, thread)
    elif parts[0] == "run":
        deltas, outputs, approvals, rate = (int(p) for p in parts[1:5])
        message = f"msg-{turn}"
        notify("item/started", {"turnId": turn, "item": {"id": message, "type": "agentMessage", "text": ""}}, thread)
        text = []
        for n in range(deltas):
            chunk = f"Streaming chunk {n} of a long answer. "
            text.append(chunk)
            notify("item/agentMessage/delta", {"turnId": turn, "itemId": message, "delta": chunk}, thread)
            pace(rate)
        command = f"cmd-{turn}"
        notify("item/started", {"turnId": turn, "item": {"id": command, "type": "commandExecution",
                                                         "command": "make test", "status": "inProgress"}}, thread)
        output = []
        for n in range(outputs):
            chunk = (f"line {n} " + "o" * 2040)[:2047] + "\n"
            output.append(chunk)
            notify("item/commandExecution/outputDelta", {"turnId": turn, "itemId": command, "delta": chunk}, thread)
            pace(rate)
        notify("item/completed", {"turnId": turn, "item": {"id": command, "type": "commandExecution", "command": "make test",
                                                           "status": "completed", "aggregatedOutput": "".join(output), "exitCode": 0}}, thread)
        for n in range(approvals):
            ask("item/commandExecution/requestApproval", {"turnId": turn, "itemId": f"approve-{turn}-{n}",
                                                         "command": "rm -rf build", "reason": "bench"}, thread)
        notify("item/completed", {"turnId": turn, "item": {"id": message, "type": "agentMessage", "text": "".join(text)}}, thread)
    elif parts[0] == "question":
        ask("item/tool/requestUserInput", {"turnId": turn, "itemId": f"question-{turn}",
                                           "questions": [{"id": "answer", "header": "Check",
                                                          "question": "Which colour should the label be?"}]}, thread)
    elif parts[0] == "killtest":
        for n, (deltas, rate) in enumerate([(30, 200), (250, 20), (2000, 20)], start=1):
            message = f"msg-{n}"
            notify("item/started", {"turnId": turn, "item": {"id": message, "type": "agentMessage", "text": ""}}, thread)
            text = []
            for d in range(deltas):
                chunk = f"Chunk {d} of {message}. "
                text.append(chunk)
                notify("item/agentMessage/delta", {"turnId": turn, "itemId": message, "delta": chunk}, thread)
                pace(rate)
            if n < 3:
                notify("item/completed", {"turnId": turn, "item": {"id": message, "type": "agentMessage", "text": "".join(text)}}, thread)
                note(f"marker/{message}", thread, 0)
    elif parts[0] == "mix":
        path, count, approvals, rate = parts[1], int(parts[2]), int(parts[3]), float(parts[4])
        with open(path) as rows:
            for n, line in enumerate(rows):
                if n == count:
                    break
                row = json.loads(line)
                replay(row["method"], row["params"], thread, turn)
                pace(rate)
        for n in range(approvals):
            ask("item/commandExecution/requestApproval", {"turnId": turn, "itemId": f"approve-{turn}-{n}",
                                                         "command": "rm -rf build", "reason": "bench"}, thread)
    notify("turn/completed", {"turn": {"id": turn, "status": "completed", "items": []}}, thread)


def handle(request):
    method, params = request.get("method"), request.get("params", {})
    result = {}
    if method in ("thread/start", "thread/resume", "thread/read"):
        thread = params.get("threadId") or str(uuid.uuid4())
        result = {"thread": {"id": thread, "status": {"type": "idle"}, "turns": []}, "model": "bench-model"}
    elif method == "thread/turns/list":
        result = {"data": [], "nextCursor": None}
    elif method == "model/list":
        result = {"data": [{"id": "bench-model", "model": "bench-model", "defaultReasoningEffort": "low",
                            "supportedReasoningEfforts": [{"reasoningEffort": "low"}]}], "nextCursor": None}
    elif method == "config/read":
        result = {"config": {"approval_policy": "on-request", "sandbox_mode": "workspace-write"}}
    elif method == "configRequirements/read":
        result = {"requirements": None}
    elif method == "turn/steer":
        # A mailbox doorbell for a running Turn; logged for its delay.
        note("received/steer", params["threadId"], 0, text=params["input"][0]["text"][:80])
        result = {"turnId": params.get("expectedTurnId")}
    elif method == "turn/start":
        thread = params["threadId"]
        turn = f"turn-{uuid.uuid4()}"
        text = params["input"][0]["text"]
        note("received/start", thread, 0, text=text[:80])
        # Codex echoes the client message ID on its user message as clientId.
        user = {"id": f"{turn}:input", "type": "userMessage", "clientId": params.get("clientUserMessageId"),
                "content": params["input"]}
        result = {"turn": {"id": turn, "status": "inProgress", "items": [user]}}
        emit({"id": request["id"], "result": result})
        notify("turn/started", {"turn": {"id": turn, "status": "inProgress", "items": [user]}}, thread)
        threading.Thread(target=script, args=(thread, turn, text), daemon=True).start()
        return
    emit({"id": request["id"], "result": result})


for line in sys.stdin:
    message = json.loads(line)
    if "method" not in message and "id" in message:
        with replied:
            replies[message["id"]] = message
            replied.notify_all()
    elif "id" in message:
        handle(message)
