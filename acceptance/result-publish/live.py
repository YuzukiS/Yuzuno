#!/usr/bin/env python3
"""T-37 acceptance: Agents publish interactive results with result_publish.

  live.py start [normal|no-node|no-validator|rules]  lab Core on 4494 from this checkout
  live.py agent <key> codex|claude [work|rules-work] [model]  create a lab Agent (kept across restarts)
  live.py ask <key> <case>                     one real Turn (cases below); records what happened
  live.py probe codex                          simulated Harness calls: retries, late and stale Turns
  live.py basics                               simulated Harness calls: peers, tasks, mail, result_publish
  live.py stop                                 stop the lab Core; daily 4317 and web/dist unchanged

Real: the lab Core built from this checkout, its validator, Codex and Claude with
their normal CLI logins (no credential copied), their Turns and tool calls.
Simulated: `probe` and `basics` call the lab's MCP endpoint themselves with the
lab Agent's credential, read from the lab database, standing in for its Harness.
`no-node` points Core's Node at a missing file (the validator's only Node use
besides the Claude bridge, so Claude cannot run in that lab); `no-validator`
is a release without the bundle; `rules` gives Codex a configured
developer_instructions through a `codex -c` wrapper (the sessionFlags layer;
~/.codex is not written), and Agents in lab/rules-work get project rules from
its AGENTS.md / CLAUDE.md. Nothing here touches the daily Core, its data or
web/dist, which are compared before and after.
"""
import hashlib
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LAB = HERE / "lab"
PORT = 4494
BASE = f"http://127.0.0.1:{PORT}"
STATE = HERE / "live-state.json"
EVIDENCE = HERE / "evidence"
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
DEV_RULE = "Lab developer rule: end every reply with the exact line -- dev rule"
PROJECT_RULE = "Lab project rule: start every reply with the exact line -- project rule"
CASES = {
    # No mention of interactive results, tools or templates.
    "useful": "We're choosing a cache for a small single-server web app: an in-process LRU, Redis, or a SQLite "
              "table. Compare them on latency, operational work, persistence and memory use, and recommend one.",
    # The same, plus the one line the Interactive result button now adds
    # (examples.ts interactiveRequest("comparison")); no template.
    "intent": "We're choosing a cache for a small single-server web app: an in-process LRU, Redis, or a SQLite "
              "table. Compare them on latency, operational work, persistence and memory use, and recommend one.\n\n"
              "If it helps, show the options as an interactive result: a table I can sort and select from.",
    # The user's own words, without the button.
    "asked": "We're choosing a cache for a small single-server web app: an in-process LRU, Redis, or a SQLite "
             "table. Compare them on latency, operational work, persistence and memory use, and recommend one. "
             "Show the comparison as a table I can sort.",
    "simple": "What is the capital of Australia? Answer in one sentence.",
    # Round 2 (capability notice): fixed tasks worth a table or chart, with no
    # word about tables, charts, results or tools.
    "cache": "We're choosing a cache for a small single-server web app: an in-process LRU, Redis, or a SQLite "
             "table. Compare them on latency, operational work, persistence and memory use, and recommend one.",
    "latency": "Last week's API latencies per endpoint, p50/p95 in ms: /login 45/120, /search 80/410, /cart 30/95, "
               "/checkout 140/620, /profile 25/70, /orders 60/380. Which endpoints should we look at first, and why?",
    "deps": "Our team must pick a Python dependency manager for a monorepo: pip-tools, Poetry, uv or PDM. Compare "
            "them on install speed, lockfiles, monorepo/workspace support and maturity, and suggest one.",
    "confirm": "Quick check: we are keeping the release on Friday as planned, right? Just confirm in one sentence.",
    "textonly": "Compare an in-process LRU, Redis and a SQLite table as the cache for a small single-server web app. "
                "Plain text only please: no tables, charts or interactive results.",
    # Deliberately induced, to watch the feedback loop with a real model.
    "induced": "This is an acceptance test of result_publish's error feedback. First publish a deliberately invalid "
               "result: a Table with two columns whose only row leaves out one of the two cells. Read the problems "
               "Core returns, fix exactly that, and publish again. Then reply with one sentence saying what was wrong.",
}


def call(method, path, body=None, timeout=120):
    request = urllib.request.Request(
        BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Yuzuno-Client": "desktop"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            return json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{method} {path}: {error.code} {error.read().decode()}") from None


def daily():
    listener = subprocess.run(["ss", "-ltnp", "sport = :4317"], text=True, capture_output=True).stdout
    digest = hashlib.sha256()
    for path in sorted(DAILY_DIST.rglob("*")):
        if path.is_file():
            digest.update(str(path.relative_to(DAILY_DIST)).encode() + path.read_bytes())
    return {"listener": listener.split("users:")[-1].strip() if "users:" in listener else None,
            "webDist": digest.hexdigest()}


def load():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save(state):
    STATE.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def record(name, value):
    EVIDENCE.mkdir(exist_ok=True)
    (EVIDENCE / f"{name}.json").write_text(json.dumps(value, indent=2, ensure_ascii=False))
    print(json.dumps(value, indent=2, ensure_ascii=False)[:6000])


def db():
    return sqlite3.connect(f"file:{LAB}/core-data/workspace.sqlite?mode=ro", uri=True)


def detail(agent):
    return call("GET", f"/api/agents/{agent}")


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def receipt(pid):
    """What this lab run is: source, the artifacts it runs, and its process."""
    git = lambda *args: subprocess.run(["git", "-C", str(ROOT), *args], text=True, capture_output=True).stdout.strip()
    dist = hashlib.sha256()
    for path in sorted((ROOT / "web/dist").rglob("*")):
        if path.is_file():
            dist.update(str(path.relative_to(ROOT / "web/dist")).encode() + path.read_bytes())
    listener = subprocess.run(["ss", "-ltnp", f"sport = :{PORT}"], text=True, capture_output=True).stdout
    return {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "head": git("rev-parse", "HEAD"),
            "dirty": git("status", "--porcelain", "--", "core", "web/src", "runtimes"),
            "artifacts": {"core": sha256(ROOT / "target/debug/yuzuno-workspace"),
                          "validator": sha256(ROOT / "runtimes/result-validator/validator.mjs"),
                          "contract": sha256(ROOT / "runtimes/result-validator/contract.json"),
                          "bridge": sha256(ROOT / "runtimes/claude/bridge.mjs"), "webDist": dist.hexdigest()},
            "corePid": pid, "listener": listener.split("users:")[-1].strip() if "users:" in listener else None}


def start(mode="normal"):
    state = load()
    if state.get("pid"):
        raise SystemExit("A lab Core is recorded as running; run stop first.")
    state = {**state, "mode": mode, "dailyBefore": state.get("dailyBefore") or daily(), "agents": state.get("agents", {})}
    (LAB / "work").mkdir(parents=True, exist_ok=True)
    log = (LAB / "core.log").open("ab")
    env = {**os.environ, "PATH": f"{NODE_BIN}:{os.environ['PATH']}",
           # Agent shells inherit the daily Core's bridge; use this checkout's.
           "YUZUNO_CLAUDE_BRIDGE": str(ROOT / "runtimes/claude/bridge.mjs"),
           "YUZUNO_NODE": str(NODE_BIN / "node")}
    env.pop("YUZUNO_RESULT_VALIDATOR", None)
    if mode == "no-node":
        env["YUZUNO_NODE"] = str(LAB / "missing/node")
    elif mode == "no-validator":
        env["YUZUNO_RESULT_VALIDATOR"] = ""
    elif mode not in ("normal", "rules"):
        raise SystemExit(f"Unknown mode {mode}")
    codex = NODE_BIN / "codex"
    if mode == "rules":
        # A user's configured developer_instructions, without writing ~/.codex.
        codex = LAB / "codex-with-developer-rule"
        codex.write_text(f'#!/bin/sh\ncommand=$1; shift\nexec "{NODE_BIN / "codex"}" "$command" '
                         f"-c 'developer_instructions=\"{DEV_RULE}\"' \"$@\"\n")
        codex.chmod(0o700)
    (LAB / "rules-work").mkdir(parents=True, exist_ok=True)
    for name in ("AGENTS.md", "CLAUDE.md"):
        (LAB / "rules-work" / name).write_text(PROJECT_RULE + "\n")
    log.write(f"\n=== start {mode} {time.strftime('%Y-%m-%dT%H:%M:%S')} ===\n".encode())
    log.flush()
    # Core, its validator and the Harnesses it starts share one capped scope.
    child = subprocess.Popen(
        ["systemd-run", "--user", "--scope", "--quiet", "-p", "MemoryMax=4G", "-p", "MemorySwapMax=0",
         str(ROOT / "target/debug/yuzuno-workspace"), "--port", str(PORT), "--data-dir", str(LAB / "core-data"),
         "--web-dir", str(ROOT / "web/dist"), "--cwd", str(LAB / "work"), "--codex", str(codex)],
        cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    for _ in range(300):
        try:
            health = call("GET", "/api/health")
            break
        except Exception:
            if child.poll() is not None:
                raise SystemExit("Lab Core exited; see lab/core.log")
            time.sleep(0.1)
    state["pid"] = child.pid
    # Kept with every Turn recorded from now on (older records have none).
    state["receipt"] = receipt(child.pid)
    save(state)
    print(json.dumps({"core": BASE, "mode": mode, "health": health, "receipt": state["receipt"],
                      "daily": state["dailyBefore"]}, indent=2))


def stop():
    state = load()
    pid = state.pop("pid", None)
    if pid:
        try:
            os.killpg(pid, signal.SIGTERM)
            for _ in range(100):
                os.kill(pid, 0)
                time.sleep(0.1)
        except ProcessLookupError:
            pass
    after = daily()
    save(state)
    result = {"dailyBefore": state.get("dailyBefore"), "dailyAfter": after,
              "dailyUnchanged": state.get("dailyBefore") == after}
    record("daily", result)


def make_agent(key, harness=None, work="work", model=None):
    harness = harness or key
    state = load()
    if key in state["agents"]:
        return state["agents"][key]
    name = f"T-37 {harness}" if key == harness else f"T-37 {key}"
    body = {"name": name, "harness": harness, "cwd": str(LAB / work), "model": ""}
    if harness == "claude":
        catalog = call("GET", "/api/models?harness=claude", timeout=180)
        models = [m.get("value") or m.get("id") for m in catalog.get("models", catalog.get("data", []))]
        body["model"] = model or next((m for m in models if m and "haiku" in m), models[0] if models else "")
    agent = state.get("created", {}).get(key) or call("POST", "/api/agents", body, timeout=180)["id"]
    state.setdefault("created", {})[key] = agent
    save(state)
    if harness == "codex":
        models = call("GET", f"/api/agents/{agent}/models", timeout=180)["models"]
        body["model"] = next(m["id"] for m in models if m.get("isDefault"))
        call("POST", f"/api/agents/{agent}/settings", {"model": body["model"], "settings": {
            "reasoningEffort": "low", "approvalPolicy": "never", "sandbox": "workspace-write"}})
    else:
        call("POST", f"/api/agents/{agent}/settings", {"model": body["model"], "permissionMode": "default"})
    state["agents"][key] = agent
    state.setdefault("keys", {})[key] = {"harness": harness, "work": work, "name": name}
    save(state)
    print(json.dumps({"key": key, "harness": harness, "agent": agent, "work": work, "model": body["model"] or "default"}))
    return agent


def wait(agent, ready, what, seconds=600):
    deadline = time.time() + seconds
    while time.time() < deadline:
        d = detail(agent)
        if ready(d):
            return d
        for request in d["pending"]:
            # The lab answers no native prompt for the Agent: a request for
            # another tool (web search, shell) is declined so the Turn goes on.
            if request["method"] == "claude/canUseTool" and not request.get("stale") \
                    and not request["params"].get("_responseSent"):
                call("POST", f"/api/requests/{request['id']}/respond", {"response": {"decision": "deny"}})
        time.sleep(2)
    raise SystemExit(f"Timed out waiting for {what}")


def ended(before):
    return lambda d: len(d["turns"]) > before and d["turns"][-1]["status"] in ("completed", "failed", "interrupted")


def tool_calls(turn, names=("result_publish", "peers_list")):
    calls = []
    for item in turn["items"]:
        raw = json.dumps(item, ensure_ascii=False)
        name = next((n for n in names if n in str(item.get("tool") or item.get("name") or "")), None)
        if name:
            result = item.get("result") or item.get("output") or item.get("error")
            calls.append({"tool": name, "type": item["type"], "status": item.get("status"),
                          "arguments": json.dumps(item.get("arguments") or item.get("input"), ensure_ascii=False)[:400],
                          "result": json.dumps(result, ensure_ascii=False)[:900], "bytes": len(raw)})
    return calls


def turn_facts(agent, turn):
    text = "\n".join(i.get("text") or "" for i in turn["items"] if i["type"] == "agentMessage")
    shown = []
    for ref in turn.get("_yuzunoResults") or []:
        published = call("GET", f"/api/agents/{agent}/results/{ref['id']}")
        root = published["spec"]["elements"][published["spec"]["root"]]
        shown.append({**ref, "title": root["props"]["title"], "defaults": published["defaults"],
                      "components": sorted({e["type"] for e in published["spec"]["elements"].values()})})
    with db() as connection:
        rows = {table: connection.execute(f"SELECT COUNT(*) FROM {table} WHERE agent_id=? AND turn_id=?",
                                          (agent, turn["id"])).fetchone()[0]
                for table in ("interactive_results", "interactive_result_rejections")}
    return {"turnId": turn["id"], "status": turn["status"], "reply": text[:700],
            "replyRepeatsResult": "```yuzuno-ui" in text or '"elements"' in text,
            "toolCalls": tool_calls(turn), "shown": shown, "stored": rows}


def ask(key, case):
    state = load()
    agent = state["agents"][key]
    info = state.get("keys", {}).get(key, {"harness": key, "work": "work"})
    before = len(detail(agent)["turns"])
    sent = time.strftime("%Y-%m-%dT%H:%M:%S")
    prompt = CASES["useful"] if case == "unavailable" else CASES[case]
    call("POST", f"/api/agents/{agent}/turns", {"text": prompt}, timeout=180)
    d = wait(agent, ended(before), f"{key} {case}")
    facts = {"harness": info["harness"], "key": key, "case": case, "mode": state.get("mode"), "agent": agent,
             "sentAt": sent, "prompt": prompt, "receipt": state.get("receipt"), **turn_facts(agent, d["turns"][-1])}
    # peers_list's activeTurnId as the Agent read it, against the Turn Core recorded.
    # (from the full tool output; toolCalls keeps only its start)
    for item in d["turns"][-1]["items"]:
        if "peers_list" in str(item.get("tool") or item.get("name") or ""):
            output = json.dumps(item.get("result") or item.get("output"))
            facts["activeTurnIdSeen"] = f'activeTurnId\\":\\"{d["turns"][-1]["id"]}' in output \
                or f'"activeTurnId": "{d["turns"][-1]["id"]}"' in output
    if info["work"] == "rules-work":
        reply = "\n".join(i.get("text") or "" for i in d["turns"][-1]["items"] if i["type"] == "agentMessage")
        facts["rules"] = {"project": "-- project rule" in reply,
                          "developer": "-- dev rule" in reply if info["harness"] == "codex" else None}
    prefix = info["harness"] if key == info["harness"] else key
    record(f"{prefix}-{case}-{before + 1}", facts)


def token(agent):
    with db() as connection:
        return connection.execute("SELECT value FROM workspace_meta WHERE key=?",
                                  (f"collaboration.mcp.agent.{agent}",)).fetchone()[0]


def mcp(agent, name, arguments=None, method="tools/call"):
    """One MCP request as the Agent's Harness would send it (simulated)."""
    params = {"name": name, "arguments": arguments or {}} if method == "tools/call" else {}
    request = urllib.request.Request(
        f"{BASE}/mcp/{agent}", data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                 "Authorization": "Bearer " + token(agent)})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=40) as response:
        result = json.load(response)["result"]
    return result if method != "tools/call" else {"isError": bool(result.get("isError")),
                                                   "content": result.get("structuredContent")}


SPEC = {"root": "result", "elements": {
    "result": {"type": "Result", "props": {"title": "Probe", "summary": "Published by the simulated client."},
               "children": ["table"]},
    "table": {"type": "Table", "props": {"id": "probe", "columns": [{"key": "step", "label": "Step"}],
                                         "rows": [{"id": "one", "cells": {"step": "retry"}}]}}}}


def probe(harness="codex"):
    agent = load()["agents"][harness]
    d = detail(agent)
    assert d["agent"]["status"] == "idle", "start from an idle Agent"
    previous = d["turns"][-1]["id"]
    steps = {"idleActiveTurnId": mcp(agent, "peers_list")["content"]["yuzuno"]["activeTurnId"]}
    steps["lateWhileIdle"] = mcp(agent, "result_publish", {"requestId": "probe-late", "expectedTurnId": previous,
                                                           "spec": SPEC})
    before = len(d["turns"])
    call("POST", f"/api/agents/{agent}/turns",
         {"text": "Run the shell command `sleep 45`, wait for it to finish, then reply with the single word: slept."})
    running = wait(agent, lambda d: len(d["turns"]) > before and d["turns"][-1]["status"] == "inProgress"
                   and d["agent"]["status"] == "working" and d["agent"]["connectionState"] == "connected",
                   "running Turn", 120)
    current = running["turns"][-1]["id"]
    steps["runningTurnId"] = current
    steps["activeTurnId"] = mcp(agent, "peers_list")["content"]["yuzuno"]["activeTurnId"]
    steps["staleWhileRunning"] = mcp(agent, "result_publish", {"requestId": "probe-stale", "expectedTurnId": previous,
                                                               "spec": SPEC})
    publish = {"requestId": "probe-retry", "expectedTurnId": current, "spec": SPEC}
    steps["first"] = mcp(agent, "result_publish", publish)
    steps["retry"] = mcp(agent, "result_publish", publish)
    changed = json.loads(json.dumps(SPEC))
    changed["elements"]["result"]["props"]["title"] = "Changed"
    steps["conflict"] = mcp(agent, "result_publish", {**publish, "spec": changed})
    done = wait(agent, ended(before), "probe Turn end", 240)
    steps["retryAfterTurn"] = mcp(agent, "result_publish", publish)
    steps["newAfterTurn"] = mcp(agent, "result_publish", {**publish, "requestId": "probe-after"})
    with db() as connection:
        steps["storedForRetry"] = connection.execute(
            "SELECT COUNT(*) FROM interactive_results WHERE request_id='probe-retry' AND agent_id=?", (agent,)).fetchone()[0]
        steps["receipts"] = connection.execute(
            "SELECT request_id FROM collaboration_requests WHERE actor=? AND operation='result_publish' "
            "AND request_id LIKE 'probe-%' ORDER BY request_id", (f"agent:{agent}",)).fetchall()
    steps["turn"] = turn_facts(agent, done["turns"][-1])
    checks = {
        "noTurnWhileIdle": steps["idleActiveTurnId"] is None,
        "lateRefusedWhileIdle": steps["lateWhileIdle"]["isError"] and "no_active_turn" in json.dumps(steps["lateWhileIdle"]),
        "activeTurnIsTheRunningOne": steps["activeTurnId"] == current,
        "staleRefused": steps["staleWhileRunning"]["isError"] and "stale_turn" in json.dumps(steps["staleWhileRunning"]),
        "retryReplaysFirst": steps["first"] == steps["retry"] and not steps["first"]["isError"],
        "conflictRefused": steps["conflict"]["isError"] and "idempotency_conflict" in json.dumps(steps["conflict"]),
        "retryAfterTurnReplaysFirst": steps["retryAfterTurn"] == steps["first"],
        "newAfterTurnRefused": steps["newAfterTurn"]["isError"] and "no_active_turn" in json.dumps(steps["newAfterTurn"]),
        "publishedOnce": steps["storedForRetry"] == 1,
        "shownWithItsTurn": [r["id"] for r in steps["turn"]["shown"]] == [steps["first"]["content"]["resultId"]],
    }
    record("probe", {"simulated": "MCP calls made by this script with the Agent's credential", "agent": agent,
                     "checks": checks, "allPassed": all(checks.values()), "steps": steps})


def basics():
    state = load()
    agents = state["agents"]
    agent = agents["codex"]
    # Credentials are issued per Core start, when the Agent connects.
    call("POST", f"/api/agents/{agent}/reconnect", timeout=180)
    wait(agent, lambda d: d["agent"]["connectionState"] == "connected", "connection", 120)
    listed = mcp(agent, "", method="tools/list")
    names = [tool["name"] for tool in listed["tools"]]
    steps = {"mode": state.get("mode"), "health": call("GET", "/api/health"), "tools": names,
             "peers": len(mcp(agent, "peers_list")["content"]["peers"])}
    created = mcp(agent, "task_create", {"requestId": f"basics-{state['mode']}", "title": f"T-37 basics ({state['mode']})"})
    steps["taskCreate"] = not created["isError"]
    task = created["content"]["task"]["id"]
    steps["taskGet"] = not mcp(agent, "task_get", {"taskId": task})["isError"]
    steps["taskComment"] = not mcp(agent, "task_comment", {"requestId": f"basics-comment-{state['mode']}", "taskId": task,
                                                           "body": "Comment while the validator is unavailable"})["isError"]
    # Reading mail changes nothing; sending some could start another Turn.
    steps["peerRead"] = not mcp(agent, "peer_read", {"afterSeq": 0, "limit": 1})["isError"]
    steps["updates"] = call("GET", "/api/updates")
    steps["publish"] = mcp(agent, "result_publish", {"requestId": f"basics-publish-{state['mode']}",
                                                     "expectedTurnId": "none", "spec": SPEC})
    with db() as connection:
        steps["publishReceipts"] = connection.execute(
            "SELECT COUNT(*) FROM collaboration_requests WHERE operation='result_publish' AND request_id LIKE 'basics-%'").fetchone()[0]
    record(f"basics-{state['mode']}", steps)


if __name__ == "__main__":
    command, *args = sys.argv[1:] or ["help"]
    if command == "start":
        start(*args)
    elif command == "stop":
        stop()
    elif command == "agent":
        make_agent(*args)
    elif command == "ask":
        ask(*args)
    elif command == "probe":
        probe(*args)
    elif command == "basics":
        basics()
    else:
        print(__doc__)
