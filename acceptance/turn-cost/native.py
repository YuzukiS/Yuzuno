#!/usr/bin/env python3
"""T-9 minimal real-native check on an isolated Core (own port and data,
never 4317): one tiny read-only Turn each through the real Codex app-server
and the real Claude SDK bridge. Checks the streamed answer, the final status,
that streamed output (deltas) was not journaled while the completed content
was, that the written record holds the answer and every journaled event it
applies (only evidence-only kinds may follow its lastSeq), and that it
survives a Core restart unchanged.

  native.py --core BIN [--bridge PATH]
The bridge defaults to the main checkout's (unchanged by T-9), whose SDK
dependencies are installed; it is only read.
"""
from pathlib import Path
import argparse
import json
import os
import pathlib
import shutil
import signal
import sqlite3
import subprocess
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
# Kinds Core keeps as evidence only (store::Route::Evidence): journaled, never
# applied, so they may follow the record's lastSeq.
EVIDENCE = ("hook/", "account/", "item/autoApprovalReview/", "guardianWarning", "warning", "deprecationNotice",
            "item/commandExecution/terminalInteraction", "thread/goal/", "remoteControl/",
            "claude/system", "claude/tool_progress", "claude/command_lifecycle")
NODE_BIN = pathlib.Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"


def call(base, method, path, body=None, timeout=120):
    request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                     headers={"Content-Type": "application/json", "x-yuzuno-client": "desktop"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
        return json.loads(raw) if raw else {}


def start(args, run, log):
    env = dict(os.environ, PATH=f"{NODE_BIN}:{os.environ['PATH']}", YUZUNO_CLAUDE_BRIDGE=args.bridge)
    proc = subprocess.Popen([args.core, "--port", str(args.port), "--data-dir", str(run / "data"), "--web-dir", str(ROOT / "web/dist"),
                             "--cwd", str(run / "task"), "--codex", str(NODE_BIN / "codex")],
                            env=env, stdout=log, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{args.port}"
    for _ in range(100):
        try:
            call(base, "GET", "/api/workspace")
            return proc, base
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("Core did not start")


def stop(proc):
    proc.send_signal(signal.SIGINT)
    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def answer(turns):
    for turn in reversed(turns):
        for item in reversed(turn.get("items", [])):
            if item.get("type") == "agentMessage" and item.get("text"):
                return turn.get("status"), item["text"]
    return None, None


def record(run, agent):
    with sqlite3.connect(f"file:{run / 'data/workspace.sqlite'}?mode=ro", uri=True) as c:
        data = json.loads(c.execute("SELECT data FROM agents WHERE id=?", [agent]).fetchone()[0])
        kinds = dict(c.execute("SELECT kind, COUNT(*) FROM journal WHERE agent_id=? GROUP BY kind", [agent]).fetchall())
        top = c.execute("SELECT MAX(seq) FROM journal WHERE agent_id=? AND kind NOT IN ('workspace/reviewed')", [agent]).fetchone()[0]
        after = [k for (k,) in c.execute("SELECT kind FROM journal WHERE agent_id=? AND seq>? AND kind!='workspace/reviewed' ORDER BY seq",
                                         [agent, data["agent"]["lastSeq"]])]
    return data, kinds, top, after


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", required=True)
    parser.add_argument("--port", type=int, default=4361)
    parser.add_argument("--bridge", default=(str(Path.home() / 'yuzuno-next/runtimes/claude/bridge.mjs')))
    args = parser.parse_args()
    run = ROOT / "target/turn-cost/runs/native"
    if run.exists():
        shutil.rmtree(run)
    for sub in ("data", "task"):
        (run / sub).mkdir(parents=True)
    log = (run / "core.log").open("w")
    proc, base = start(args, run, log)
    result = {"core": args.core}
    ids = {}
    try:
        for harness in ("codex", "claude"):
            ids[harness] = call(base, "POST", "/api/agents", {"name": f"native-{harness}", "cwd": str(run / "task"),
                                                               "harness": harness, "model": ""})["id"]
            if harness == "claude":
                call(base, "POST", f"/api/agents/{ids[harness]}/reconnect")
        for harness, agent in ids.items():
            for _ in range(150):
                if call(base, "GET", f"/api/agents/{agent}")["agent"]["connectionState"] == "connected":
                    break
                time.sleep(0.2)
            prompt = f"Reply with exactly the word {'gamma' if harness == 'codex' else 'delta'} and nothing else. Do not use any tools."
            if harness == "codex":
                call(base, "POST", f"/api/agents/{agent}/messages", {"clientMessageId": f"native-{time.time_ns()}", "text": prompt})
            else:
                call(base, "POST", f"/api/agents/{agent}/turns", {"text": prompt})
        for harness, agent in ids.items():
            for _ in range(300):
                detail = call(base, "GET", f"/api/agents/{agent}")
                status, text = answer(detail["turns"])
                if status in ("completed", "failed", "interrupted"):
                    break
                time.sleep(1)
            result[harness] = {"turnStatus": status, "answer": text, "agentStatus": detail["agent"]["status"],
                               "error": detail["agent"].get("error")}
        time.sleep(4)  # the Turn end wrote the record already; let the ticker settle
        for harness, agent in ids.items():
            data, kinds, top, after = record(run, agent)
            result[harness].update({"recordAnswer": answer(data["turns"])[1], "recordLastSeq": data["agent"]["lastSeq"],
                                    "journalTop": top, "journaledAfterRecord": after,
                                    "completedJournaled": {k: v for k, v in kinds.items()
                                                           if k in ("item/started", "item/completed", "claude/assistant", "claude/user")},
                                    "deltasJournaled": {k: v for k, v in kinds.items()
                                                        if k in ("item/agentMessage/delta", "claude/stream_event") or k.endswith("Delta")}})
    finally:
        stop(proc)
    proc, base = start(args, run, log)
    try:
        for harness, agent in ids.items():
            result[harness]["answerAfterRestart"] = answer(call(base, "GET", f"/api/agents/{agent}")["turns"])[1]
    finally:
        stop(proc)
        log.close()
    for harness in ids:
        r = result[harness]
        r["passed"] = (r["turnStatus"] == "completed" and r["agentStatus"] == "idle" and bool(r["answer"])
                       and r["recordAnswer"] == r["answer"] == r["answerAfterRestart"]
                       and all(kind.startswith(EVIDENCE) for kind in r["journaledAfterRecord"])
                       and sum(r["completedJournaled"].values()) > 0 and not r["deltasJournaled"])
    (run / "result.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(json.dumps(result, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
