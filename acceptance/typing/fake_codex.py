#!/usr/bin/env python3
"""Scripted Codex app-server for T-18 typing measurements. No model.

The user message selects the Turn:
  history:N        one finished Turn: a Markdown answer (headings, a list, a
                   table, code) and a ~4 KB command output; N picks the wording
  stream:S:R       an answer streamed for S seconds at R deltas per second.
                   Each delta carries a marker ⟦k⟧; its emit time is logged to
                   $T18_TIMELINE/<pid>.jsonl so the page can time its arrival.
"""
import json
import os
import pathlib
import sys
import threading
import time
import uuid

timeline_dir = pathlib.Path(os.environ.get("T18_TIMELINE", "."))
timeline_dir.mkdir(parents=True, exist_ok=True)
timeline = (timeline_dir / f"{os.getpid()}.jsonl").open("a", buffering=1)
lock = threading.Lock()
counter = [0]


def emit(value):
    with lock:
        sys.stdout.write(json.dumps(value) + "\n")
        sys.stdout.flush()


def answer(n):
    return "\n".join([
        f"## Step {n}: what changed",
        f"I looked at the module behind turn {n} and checked the edge cases before touching anything.",
        "",
        "- The parser keeps **every** field it reads, including `optional` ones.",
        "- Errors now carry the original line, so the report points at the right place.",
        f"- A regression test covers case {n} and the two neighbours it used to break.",
        "",
        "| Check | Before | After |",
        "|---|---|---|",
        f"| parse time | {40 + n % 7} ms | {12 + n % 5} ms |",
        "| allocations | 3.1 MB | 0.4 MB |",
        "",
        "```rust",
        f"fn step_{n}(input: &str) -> Result<Vec<Field>> {{",
        "    input.lines().map(Field::parse).collect()",
        "}",
        "```",
        "",
        "Nothing else in the workspace was touched; the next step is the integration test.",
    ])


def script(thread, turn, text):
    parts = text.split(":")
    if parts[0] == "history":
        n = int(parts[1])
        output = "".join(f"test case {n}.{i} ... ok\n" for i in range(160))
        emit({"method": "item/completed", "params": {"threadId": thread, "turnId": turn, "item": {
            "id": f"{turn}:cmd", "type": "commandExecution", "command": "cargo test", "status": "completed",
            "aggregatedOutput": output, "exitCode": 0}}})
        emit({"method": "item/completed", "params": {"threadId": thread, "turnId": turn, "item": {
            "id": f"{turn}:answer", "type": "agentMessage", "text": answer(n)}}})
    elif parts[0] == "stream":
        seconds, rate = float(parts[1]), float(parts[2])
        message = f"{turn}:stream"
        emit({"method": "item/started", "params": {"threadId": thread, "turnId": turn,
                                                   "item": {"id": message, "type": "agentMessage", "text": ""}}})
        text = []
        deadline = time.time() + seconds
        while time.time() < deadline:
            with lock:
                counter[0] += 1
                k = counter[0]
            chunk = f"Streaming word ⟦{os.getpid()}-{k}⟧ of a long answer. "
            text.append(chunk)
            timeline.write(json.dumps({"marker": f"{os.getpid()}-{k}", "t": time.time()}) + "\n")
            emit({"method": "item/agentMessage/delta", "params": {"threadId": thread, "turnId": turn,
                                                                  "itemId": message, "delta": chunk}})
            time.sleep(1 / rate)
        emit({"method": "item/completed", "params": {"threadId": thread, "turnId": turn,
                                                     "item": {"id": message, "type": "agentMessage", "text": "".join(text)}}})
    emit({"method": "turn/completed", "params": {"threadId": thread, "turn": {"id": turn, "status": "completed", "items": []}}})


def handle(request):
    method, params = request["method"], request.get("params", {})
    result = {}
    if method in ("thread/start", "thread/resume", "thread/read"):
        result = {"thread": {"id": params.get("threadId") or str(uuid.uuid4()), "status": {"type": "idle"}, "turns": []},
                  "model": "bench-model"}
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
        # Accepted into the running Turn, as Codex echoes it back.
        thread, turn = params["threadId"], params.get("expectedTurnId")
        user = {"id": f"{turn}:steer-{uuid.uuid4()}", "type": "userMessage", "clientId": params.get("clientUserMessageId"),
                "content": params["input"]}
        emit({"id": request["id"], "result": {"turnId": turn}})
        emit({"method": "item/completed", "params": {"threadId": thread, "turnId": turn, "item": user}})
        return
    elif method == "turn/start":
        thread, turn = params["threadId"], f"turn-{uuid.uuid4()}"
        user = {"id": f"{turn}:input", "type": "userMessage", "clientId": params.get("clientUserMessageId"),
                "content": params["input"]}
        emit({"id": request["id"], "result": {"turn": {"id": turn, "status": "inProgress", "items": [user]}}})
        emit({"method": "turn/started", "params": {"threadId": thread, "turn": {"id": turn, "status": "inProgress", "items": [user]}}})
        emit({"method": "item/completed", "params": {"threadId": thread, "turnId": turn, "item": user}})
        threading.Thread(target=script, args=(thread, turn, params["input"][0]["text"]), daemon=True).start()
        return
    emit({"id": request["id"], "result": result})


for line in sys.stdin:
    message = json.loads(line)
    if "id" in message and "method" in message:
        handle(message)
