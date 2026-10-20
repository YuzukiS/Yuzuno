#!/usr/bin/env python3
"""Read-only: how does the installed Codex list a fork in thread/list?"""
import json
import subprocess
import sys
from pathlib import Path

LAB = Path(__file__).resolve().parents[2] / "target/fork-lab"
source = json.loads((LAB / "state/source.json").read_text())["threadId"]
fork = sys.argv[1]
server = subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True, bufsize=1)


def ask(i, method, params):
    server.stdin.write(json.dumps({"id": i, "method": method, "params": params}) + "\n")
    server.stdin.flush()
    while True:
        message = json.loads(server.stdout.readline())
        if message.get("id") == i and "method" not in message:
            return message


try:
    ask(1, "initialize", {"clientInfo": {"name": "yuzuno_t4_list", "title": "T-4 list probe", "version": "0.1.0"}})
    server.stdin.write(json.dumps({"method": "initialized"}) + "\n")
    server.stdin.flush()
    fork_meta = ask(2, "thread/read", {"threadId": fork, "includeTurns": False})["result"]["thread"]
    print("fork:", json.dumps({k: fork_meta.get(k) for k in ("id", "cwd", "source", "forkedFromId", "createdAt", "originator", "sessionId", "historyMode")}))
    src = ask(90, "thread/read", {"threadId": source, "includeTurns": False})["result"]["thread"]
    print("source:", json.dumps({k: src.get(k) for k in ("id", "source", "createdAt", "sessionId", "historyMode")}))
    listed = ask(91, "thread/list", {"limit": 5, "cwd": fork_meta["cwd"]})["result"]["data"]
    print("listed in cwd:", json.dumps([{k: t.get(k) for k in ("id", "forkedFromId", "sessionId")} for t in listed]))
    variants = {
        "cwd + kinds": {"cwd": fork_meta["cwd"], "sourceKinds": ["cli", "vscode", "exec", "appServer", "unknown"]},
        "cwd only": {"cwd": fork_meta["cwd"]},
        "all kinds": {"sourceKinds": ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"]},
        "default": {},
    }
    for n, (name, params) in enumerate(variants.items(), start=3):
        result = ask(n, "thread/list", {"limit": 100, **params})
        rows = result.get("result", {}).get("data", [])
        hit = [r for r in rows if r["id"] == fork]
        print(f"{name}: {len(rows)} threads; fork listed={bool(hit)}; error={result.get('error')}",
              json.dumps({k: hit[0].get(k) for k in ("source", "forkedFromId", "createdAt")}) if hit else "")
finally:
    server.terminate()
    server.wait(timeout=10)
