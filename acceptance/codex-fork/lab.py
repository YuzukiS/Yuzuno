#!/usr/bin/env python3
"""T-4 live acceptance against the isolated lab Core (port 4347) only.

  lab.py conflict   import the dedicated source and hit the real writer conflict
  lab.py preview    read-only fork preview
  lab.py verify     compare the fork's native history with the source boundary
  lab.py continue   one read-only Turn in the fork (never in the source)
  lab.py repeat     a second explicit request for the same boundary
  lab.py reconflict R2: reconnect the source again while the holder owns it
Evidence goes to target/fork-lab/evidence.json (not committed).
"""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LAB = ROOT / "target/fork-lab"
BASE = "http://127.0.0.1:4347/api"
SOURCE = json.loads((LAB / "state/source.json").read_text())
EVIDENCE = LAB / "evidence.json"


def call(method, path, body=None, timeout=180):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(BASE + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", "x-yuzuno-client": "desktop"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        return {"httpError": error.code, "body": error.read().decode()[:600]}


def record(step, value):
    evidence = json.loads(EVIDENCE.read_text()) if EVIDENCE.exists() else {}
    evidence[step] = value
    EVIDENCE.write_text(json.dumps(evidence, indent=2, ensure_ascii=False))
    print(json.dumps({step: value}, ensure_ascii=False)[:2000])


def agents():
    return call("GET", "/workspace")["agents"]


def by_thread(thread):
    return next((a for a in agents() if a.get("threadId") == thread), None)


def native_turns(thread):
    """Turn IDs/statuses, oldest first, read by a separate read-only app-server."""
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
        ask(1, "initialize", {"clientInfo": {"name": "yuzuno_t4_verify", "title": "T-4 verify", "version": "0.1.0"}})
        server.stdin.write(json.dumps({"method": "initialized"}) + "\n")
        server.stdin.flush()
        meta = ask(2, "thread/read", {"threadId": thread, "includeTurns": False})["result"]["thread"]
        listed = ask(99, "thread/list", {"cwd": meta["cwd"], "limit": 100,
                                        "sourceKinds": ["cli", "vscode", "exec", "appServer", "unknown"]})["result"]["data"]
        meta["nativeForksOfSource"] = sum(1 for t in listed if t.get("forkedFromId") == SOURCE["threadId"])
        rows, cursor, n = [], None, 3
        while True:
            page = ask(n, "thread/turns/list", {"threadId": thread, "cursor": cursor, "limit": 100,
                                               "sortDirection": "asc", "itemsView": "notLoaded"})["result"]
            rows += [{"id": t["id"], "status": t["status"]} for t in page["data"]]
            cursor, n = page.get("nextCursor"), n + 1
            if not cursor:
                return meta, rows
    finally:
        server.terminate()
        server.wait(timeout=10)


def main(step):
    if step == "conflict":
        preview = call("POST", "/codex/sessions/preview", {"threadId": SOURCE["threadId"]})
        project = call("POST", "/projects", {"name": "T-4 fork lab"})
        imported = call("POST", "/codex/sessions/import", {"threadId": SOURCE["threadId"], "name": "Fork lab source", "permissionPreset": "ask"})
        call("POST", f"/agents/{imported['id']}/project", {"projectId": project.get("id")})
        reconnect = call("POST", f"/agents/{imported['id']}/reconnect")
        detail = call("GET", f"/agents/{imported['id']}")
        record("conflict", {"previewTurns": preview.get("turnCount"), "agentId": imported["id"],
                            "reconnect": reconnect, "handoff": detail.get("codexHandoff"),
                            "connection": detail["agent"]["connectionState"], "error": detail["agent"].get("error")})
    elif step == "preview":
        source = by_thread(SOURCE["threadId"])
        record("preview", call("POST", f"/agents/{source['id']}/codex/fork/preview"))
    elif step == "reconflict":
        # R2: the holder owns the source again; a reconnect must still be refused.
        source = by_thread(SOURCE["threadId"])
        reconnect = call("POST", f"/agents/{source['id']}/reconnect")
        detail = call("GET", f"/agents/{source['id']}")
        record("reconflict", {"reconnect": reconnect, "handoff": detail.get("codexHandoff"),
                              "connection": detail["agent"]["connectionState"], "agents": len(agents())})
    elif step == "verify":
        source = by_thread(SOURCE["threadId"])
        link = call("GET", f"/agents/{source['id']}")["codexHandoff"]["forkedTo"]
        fork = call("GET", f"/agents/{link['agentId']}")
        source_meta, source_turns = native_turns(SOURCE["threadId"])
        fork_meta, fork_turns = native_turns(link["threadId"])
        end = [t["id"] for t in source_turns].index(link["throughTurnId"])
        record("verify", {
            "forkThread": link["threadId"], "forkedFromId": fork_meta.get("forkedFromId"),
            "historyMatches": fork_turns == source_turns[:end + 1], "sourceTurns": len(source_turns), "forkTurns": len(fork_turns),
            "sourceThreadUnchanged": source_meta["id"] == SOURCE["threadId"],
            "nativeForksOfSource": source_meta["nativeForksOfSource"],
            "agent": {k: fork["agent"].get(k) for k in ("name", "cwd", "model", "projectId", "connectionState", "unreadCount")},
            "settings": fork["agent"]["settings"], "sourceAgentOpen": source.get("closedAt") is None,
            "forkTurnsInYuzuno": [t["id"] for t in fork["turns"]],
        })
    elif step == "continue":
        source = by_thread(SOURCE["threadId"])
        fork_id = call("GET", f"/agents/{source['id']}")["codexHandoff"]["forkedTo"]["agentId"]
        call("POST", f"/agents/{fork_id}/messages", {"clientMessageId": str(uuid.uuid4()), "text": "Reply with exactly the word gamma and nothing else."})
        for _ in range(120):
            detail = call("GET", f"/agents/{fork_id}")
            if detail["agent"]["status"] not in ("working", "waiting"):
                break
            time.sleep(2)
        last = detail["turns"][-1]
        record("continue", {"status": last["status"], "reply": [i.get("text") for i in last["items"] if i["type"] == "agentMessage"],
                            "sourceTurnsAfter": len(native_turns(SOURCE["threadId"])[1])})
    elif step in ("combined", "reopen"):
        # With T-5 Machines in the same isolated database: a machine check and
        # the fork must both survive a Core restart, with Projects and links.
        if step == "combined":
            call("POST", "/machines/local/check")
        source = by_thread(SOURCE["threadId"])
        source_detail = call("GET", f"/agents/{source['id']}")
        link = source_detail["codexHandoff"]["forkedTo"]
        if step == "reopen":
            call("POST", f"/agents/{link['agentId']}/reconnect")
        fork = call("GET", f"/agents/{link['agentId']}")
        again = call("POST", f"/agents/{source['id']}/codex/fork",
                     {"requestId": str(uuid.uuid4()), "throughTurnId": link["throughTurnId"], "name": "Fork lab source"})
        local = next(m for m in call("GET", "/machines")["machines"] if m["id"] == "local")
        record(step, {
            "machineCheckAt": (local.get("lastCheck") or {}).get("checkedAt"),
            "machineReachable": (local.get("lastCheck") or {}).get("reachable"),
            "sourceProject": source.get("projectId"), "forkProject": fork["agent"].get("projectId"),
            "forkedTo": link["agentId"], "forkedFrom": (fork.get("codexHandoff") or {}).get("forkedFrom", {}).get("agentId"),
            "forkConnection": fork["agent"]["connectionState"],
            "repeatSameAgent": (again.get("agent") or {}).get("id") == link["agentId"],
            "agents": len(agents()),
        })
    elif step == "repeat":
        source = by_thread(SOURCE["threadId"])
        link = call("GET", f"/agents/{source['id']}")["codexHandoff"]["forkedTo"]
        again = call("POST", f"/agents/{source['id']}/codex/fork",
                     {"requestId": str(uuid.uuid4()), "throughTurnId": link["throughTurnId"], "name": "Fork lab source"})
        record("repeat", {"state": again.get("state"), "sameAgent": (again.get("agent") or {}).get("id") == link["agentId"],
                          "agentsWithSourceName": sum(1 for a in agents() if a["name"] == "Fork lab source")})


if __name__ == "__main__":
    main(sys.argv[1])
