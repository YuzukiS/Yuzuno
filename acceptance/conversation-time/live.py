#!/usr/bin/env python3
"""T-14 acceptance: message times, turn footer facts and background shells.

  python3 acceptance/conversation-time/live.py start          # lab Core on 4414
  python3 acceptance/conversation-time/live.py codex|claude   # real short task with a background shell
  python3 acceptance/conversation-time/live.py watch <agent>  # follow backgroundShells until it settles
  python3 acceptance/conversation-time/live.py large          # Codex: a large foreground output (trimmed, on demand)
  python3 acceptance/conversation-time/live.py sse <agent>    # stream a short reply, then resume the SSE stream
  python3 acceptance/conversation-time/live.py migrated       # times recorded by f239bc7 survive the row migration
  python3 acceptance/conversation-time/live.py restart        # restart Core, compare persisted times
  python3 acceptance/conversation-time/live.py stop           # stop the lab Core, verify daily

The lab Core uses this checkout's build, web/dist and its own data folder.
Codex and Claude run with their normal CLI logins; no credential is copied.
The daily Core (4317), its web/dist and data are compared before and after.
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
PORT = 4414
BASE = f"http://127.0.0.1:{PORT}"
STATE = HERE / "live-state.json"
EVIDENCE = HERE / "evidence"
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
SHELL = os.environ.get("T14_SHELL", "sleep 50; echo t14-finished")
PROMPTS = {
    "codex": (
        f"T-14 acceptance. Start the shell command `{SHELL}` as a background terminal: launch it with "
        "your command tool and a short yield so it keeps running, do not wait for it and do not use "
        "nohup or &. Then reply with one short sentence saying it was started."
    ),
    "claude": (
        f"T-14 acceptance. Use the Bash tool with run_in_background set to true to run `{SHELL}`. "
        "Do not wait for it. Then reply with one short sentence saying it was started."
    ),
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
    pids = subprocess.run(["ss", "-ltnp", "sport = :4317"], text=True, capture_output=True).stdout
    digest = hashlib.sha256()
    for path in sorted(DAILY_DIST.rglob("*")):
        if path.is_file():
            digest.update(str(path.relative_to(DAILY_DIST)).encode() + path.read_bytes())
    return {"listener": pids.split("users:")[-1].strip() if "users:" in pids else None, "webDist": digest.hexdigest()}


def load():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save(state):
    STATE.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def record(name, value):
    EVIDENCE.mkdir(exist_ok=True)
    (EVIDENCE / f"{name}.json").write_text(json.dumps(value, indent=2, ensure_ascii=False))


def launch(state):
    (LAB / "work").mkdir(parents=True, exist_ok=True)
    log = (LAB / "core.log").open("ab")
    env = {**os.environ, "PATH": f"{NODE_BIN}:{os.environ['PATH']}"}
    child = subprocess.Popen(
        [str(ROOT / "target/debug/yuzuno-workspace"), "--port", str(PORT), "--data-dir", str(LAB / "core-data"),
         "--web-dir", str(ROOT / "web/dist"), "--cwd", str(LAB / "work"), "--codex", str(NODE_BIN / "codex")],
        cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    for _ in range(150):
        try:
            call("GET", "/api/health")
            break
        except Exception:
            if child.poll() is not None:
                raise SystemExit("Lab Core exited; see lab/core.log")
            time.sleep(0.1)
    state["pid"] = child.pid
    save(state)


def halt(state):
    pid = state.pop("pid", None)
    if pid:
        try:
            os.killpg(pid, signal.SIGTERM)
            for _ in range(100):
                os.kill(pid, 0)
                time.sleep(0.1)
        except ProcessLookupError:
            pass
    save(state)


def detail(agent):
    return call("GET", f"/api/agents/{agent}")


def summary(d):
    """Only the facts this card is about, in a stable shape."""
    turns = []
    for turn in d["turns"]:
        turns.append({
            "id": turn["id"], "status": turn["status"],
            "native": {k: turn.get(k) for k in ("startedAt", "completedAt", "durationMs")},
            "core": {k: turn.get(k) for k in ("_yuzunoStartedAt", "_yuzunoCompletedAt", "_yuzunoDurationMs")},
            "messages": [
                {"id": item["id"], "type": item["type"], "time": item.get("_yuzunoTime"),
                 "text": (item.get("text") or "".join(c.get("text", "") for c in item.get("content", [])))[:80]}
                for item in turn["items"] if item["type"] in ("userMessage", "agentMessage")
            ],
            "shellItems": [
                {"id": item["id"], "type": item["type"], "status": item.get("status"),
                 "command": str(item.get("command") or (item.get("input") or {}).get("command") or "")[:80]}
                for item in turn["items"] if item["type"] in ("commandExecution", "claudeToolUse")
            ],
        })
    return {"status": d["agent"]["status"], "backgroundShells": d.get("backgroundShells"), "turns": turns}


def wait(agent, ready, what, seconds=300):
    deadline = time.time() + seconds
    while time.time() < deadline:
        d = detail(agent)
        if ready(d):
            return d
        for request in d["pending"]:
            # Only this lab agent's own sleep/echo shell is approved, once.
            if request["method"] == "claude/canUseTool" and not request.get("stale") \
                    and SHELL in json.dumps(request["params"]) and not request["params"].get("_responseSent"):
                call("POST", f"/api/requests/{request['id']}/respond", {"response": {"decision": "allow"}})
        time.sleep(2)
    raise SystemExit(f"Timed out waiting for {what}: {json.dumps(summary(detail(agent)), ensure_ascii=False)[:2000]}")


def start():
    state = load()
    if state.get("pid"):
        raise SystemExit("A lab Core is recorded as running; run stop first.")
    # The lab's agents (and their records) carry over between runs.
    state = {"dailyBefore": daily(), "agents": state.get("agents", {})}
    launch(state)
    print(json.dumps({"core": BASE, "daily": state["dailyBefore"]}, indent=2))


def run_task(harness):
    state = load()
    agent = state["agents"].get(harness) or state.get("pendingAgents", {}).get(harness)
    if not agent or harness not in state["agents"]:
        body = {"name": f"T-14 {harness}", "harness": harness, "cwd": str(LAB / "work"), "model": ""}
        if harness == "claude":
            catalog = call("GET", "/api/models?harness=claude", timeout=180)
            models = [m.get("value") or m.get("id") for m in catalog.get("models", catalog.get("data", []))]
            body["model"] = next((m for m in models if m and "haiku" in m), models[0] if models else "")
        if not agent:
            agent = call("POST", "/api/agents", body, timeout=180)["id"]
            state.setdefault("pendingAgents", {})[harness] = agent
            save(state)
        if harness == "codex":
            call("POST", f"/api/agents/{agent}/settings", {"model": detail(agent)["agent"]["model"], "settings": {
                "reasoningEffort": "low", "approvalPolicy": "never", "sandbox": "workspace-write"}})
        else:
            # Haiku has no auto mode; the lab approves its own Bash prompt below.
            call("POST", f"/api/agents/{agent}/settings", {"model": body["model"], "permissionMode": "default"})
        state["agents"][harness] = agent
        save(state)
    before = len(detail(agent)["turns"])
    sent_at = int(time.time() * 1000)
    call("POST", f"/api/agents/{agent}/turns", {"text": PROMPTS[harness]}, timeout=180)
    d = wait(agent, lambda d: len(d["turns"]) > before
             and d["turns"][-1]["status"] in ("completed", "failed", "interrupted"), "turn end")
    ended_at = int(time.time() * 1000)
    result = {"agent": agent, "sentAt": sent_at, "endedSeenAt": ended_at, **summary(d)}
    record(f"{harness}-turn-{before + 1}", result)
    print(json.dumps(result, indent=2, ensure_ascii=False))


def turn(harness, text, seconds=400):
    """Sends `text` to the lab Agent and waits for its Turn to end."""
    agent = load()["agents"][harness]
    before = len(detail(agent)["turns"])
    call("POST", f"/api/agents/{agent}/turns", {"text": text}, timeout=180)
    return agent, wait(agent, lambda d: len(d["turns"]) > before
                       and d["turns"][-1]["status"] in ("completed", "failed", "interrupted"), "turn end", seconds)


def large():
    agent, d = turn("codex", "T-14 acceptance. Run `seq 1 4000` in the foreground and wait for it. "
                    "Then reply with one short sentence saying how many lines it printed.")
    shell = [i for i in d["turns"][-1]["items"] if i["type"] == "commandExecution"]
    result = {"agent": agent, "turnId": d["turns"][-1]["id"], "shell": [
        {"id": i["id"], "command": i.get("command"), "outputChars": len(i.get("aggregatedOutput") or ""),
         "truncated": i.get("_yuzunoTruncated")} for i in shell], **summary(d)}
    record("codex-large", result)
    print(json.dumps({k: result[k] for k in ("turnId", "shell")}, indent=2))


def sse(harness):
    """Streams a short reply while reading /api/events, then resumes the
    stream from the last id: pushed message Items carry their time, deltas
    never ask for a refetch, and a resume replays without a reset."""
    import threading
    agent = load()["agents"][harness]
    seen, stop_reading = [], threading.Event()

    def read(last_id=None, limit=None):
        headers = {"Accept": "text/event-stream", "X-Yuzuno-Client": "desktop"}
        if last_id:
            headers["Last-Event-ID"] = last_id
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        out, event = [], {}
        with opener.open(urllib.request.Request(BASE + "/api/events", headers=headers), timeout=600) as stream:
            for raw in stream:
                line = raw.decode().rstrip("\n")
                if line.startswith("id:"):
                    event["id"] = line[3:].strip()
                elif line.startswith("data:"):
                    event["data"] = json.loads(line[5:].strip())
                elif not line and event:
                    out.append(event)
                    event = {}
                    if (limit and len(out) >= limit) or stop_reading.is_set():
                        break
        return out

    reader = threading.Thread(target=lambda: seen.extend(read()), daemon=True)
    reader.start()
    time.sleep(1)
    _, d = turn(harness, "T-14 acceptance. Reply with five short numbered sentences about tea. Do not use any tool.")
    time.sleep(2)
    stop_reading.set()
    reader.join(timeout=30)
    mine = [e for e in seen if e.get("data", {}).get("agentId") == agent]
    items = [e["data"]["item"] for e in mine if e["data"]["type"] == "agent.item"
             and e["data"]["item"]["type"] in ("agentMessage", "userMessage")]
    ids = [e["id"] for e in seen if "id" in e]
    resumed = read(ids[len(ids) // 2], limit=2) if ids else []
    result = {
        "agent": agent, "turnId": d["turns"][-1]["id"],
        "types": {t: sum(1 for e in mine if e["data"]["type"] == t) for t in {e["data"]["type"] for e in mine}},
        "messageItems": [{"id": i["id"], "type": i["type"], "time": i.get("_yuzunoTime")} for i in items],
        "allMessageItemsTimed": bool(items) and all(i.get("_yuzunoTime") for i in items),
        "resumeFrom": ids[len(ids) // 2] if ids else None,
        "resumedFirst": [e.get("data", {}).get("type") for e in resumed],
        "recordTimes": [m for m in summary(d)["turns"][-1]["messages"]],
    }
    record(f"{harness}-sse", result)
    print(json.dumps({k: result[k] for k in ("types", "messageItems", "allMessageItemsTimed", "resumedFirst")}, indent=2))


def migrated():
    """Times f239bc7 recorded before the row migration, as read now."""
    before = json.loads((EVIDENCE / "restart.json").read_text())["after"]
    state = load()
    strip = lambda s: [{k: t[k] for k in ("id", "status", "native", "core", "messages")} for t in s["turns"]]
    result = {}
    for harness, agent in state["agents"].items():
        now = strip(summary(detail(agent)))[: len(before[harness]["turns"])]
        result[harness] = now == strip(before[harness])
    record("migrated", result)
    print(json.dumps({"timesUnchangedAcrossRowMigration": result}, indent=2))


def watch(harness, seconds=150):
    agent = load()["agents"][harness]
    seen = []
    deadline = time.time() + seconds
    while time.time() < deadline:
        shells = detail(agent).get("backgroundShells")
        if not seen or seen[-1]["shells"] != shells:
            seen.append({"at": int(time.time() * 1000), "shells": shells})
            print(json.dumps(seen[-1]))
        if seen and shells and shells.get("state") == "known" and shells.get("count") == 0 and len(seen) > 1:
            break
        time.sleep(2)
    record(f"{harness}-shells", seen)


def journal(agent, kinds):
    db = sqlite3.connect(f"file:{LAB / 'core-data/workspace.sqlite'}?mode=ro", uri=True)
    rows = db.execute(
        f"SELECT seq, kind, at, data FROM journal WHERE agent_id=? AND kind IN ({','.join('?' * len(kinds))}) ORDER BY seq",
        (agent, *kinds)).fetchall()
    return [{"seq": s, "kind": k, "at": a, "data": json.loads(d)} for s, k, a, d in rows]


def restart():
    state = load()
    before = {h: summary(detail(a)) for h, a in state["agents"].items()}
    halt(state)
    launch(state)
    after = {h: summary(detail(a)) for h, a in state["agents"].items()}
    strip = lambda s: [{k: t[k] for k in ("id", "status", "native", "core", "messages")} for t in s["turns"]]
    result = {
        "timesUnchanged": {h: strip(before[h]) == strip(after[h]) for h in before},
        "shellsAfterRestart": {h: after[h]["backgroundShells"] for h in after},
        "before": before, "after": after,
    }
    record("restart", result)
    print(json.dumps({k: result[k] for k in ("timesUnchanged", "shellsAfterRestart")}, indent=2))


def stop():
    state = load()
    halt(state)
    state["dailyAfter"] = daily()
    state["dailyUnchanged"] = state["dailyAfter"] == state.get("dailyBefore")
    save(state)
    print(json.dumps({"dailyUnchanged": state["dailyUnchanged"], "daily": state["dailyAfter"]}, indent=2))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "start":
        start()
    elif command in PROMPTS:
        run_task(command)
    elif command == "large":
        large()
    elif command == "sse":
        sse(sys.argv[2])
    elif command == "migrated":
        migrated()
    elif command == "watch":
        watch(sys.argv[2])
    elif command == "journal":
        print(json.dumps(journal(load()["agents"][sys.argv[2]], sys.argv[3:]), indent=1, ensure_ascii=False)[:20000])
    elif command == "restart":
        restart()
    elif command == "stop":
        stop()
    else:
        raise SystemExit(__doc__)
