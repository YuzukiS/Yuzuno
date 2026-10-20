#!/usr/bin/env python3
"""T-65 acceptance: several follow-ups while Claude works, none holding up the next.

  python3 acceptance/t65/live.py start      # lab Core on 4493 (this checkout's build and bridge)
  python3 acceptance/t65/live.py several    # two follow-ups during a multi-step turn: both queued, each
                                            # confirmed by its own uuid; a repeat sends nothing again and a
                                            # changed reuse of an id is refused as not submitted
  python3 acceptance/t65/live.py next       # two follow-ups right after a tool-free prompt: both run after it
                                            # (together or one by one; Claude decides) and both are confirmed
  python3 acceptance/t65/live.py stop       # stop the lab Core, compare the daily Core

Real Claude (Haiku) with the normal CLI login and manual permissions; the lab
approves only its own `python3 -c ... sleep` commands. Each start and stop
records a receipt: source HEAD, Core/bridge/web hashes, the Core's PID and
start time, and that it exited. The daily Core is only compared by listener
and web/dist digest.
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
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LAB = HERE / "lab"
PORT = 4493
BASE = f"http://127.0.0.1:{PORT}"
STATE = LAB / "state.json"
EVIDENCE = HERE / "evidence"
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
STEP = "python3 -c 'import time; time.sleep({s}); print({n})'"


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
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def record(name, value):
    EVIDENCE.mkdir(exist_ok=True)
    (EVIDENCE / f"{name}.json").write_text(json.dumps(value, indent=2, ensure_ascii=False))


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def starttime(pid):
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat[stat.rindex(")") + 2:].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def built():
    vcs = lambda *args: subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True).stdout.strip()
    web = ROOT / "target/t65/web-dist"
    return {"head": vcs("rev-parse", "HEAD"), "dirty": bool(vcs("status", "--porcelain", "--untracked-files=no")),
            "core": sha256(ROOT / "target/debug/yuzuno-workspace"), "bridge": sha256(ROOT / "runtimes/claude/bridge.mjs"),
            "webIndex": sha256(web / "index.html")}


def bridges_left():
    bridge = str(ROOT / "runtimes/claude/bridge.mjs").encode()
    left = []
    for proc in Path("/proc").iterdir():
        try:
            if proc.name.isdigit() and bridge in (proc / "cmdline").read_bytes():
                left.append(int(proc.name))
        except OSError:
            pass
    return left


def launch(state):
    (LAB / "work").mkdir(parents=True, exist_ok=True)
    log = (LAB / "core.log").open("ab")
    # A shell inside a Yuzuno session inherits the daily release's bridge.
    env = {**os.environ, "PATH": f"{NODE_BIN}:{os.environ['PATH']}",
           "YUZUNO_CLAUDE_BRIDGE": str(ROOT / "runtimes/claude/bridge.mjs")}
    child = subprocess.Popen(
        [str(ROOT / "target/debug/yuzuno-workspace"), "--port", str(PORT), "--data-dir", str(LAB / "core-data"),
         "--web-dir", str(ROOT / "target/t65/web-dist"), "--cwd", str(LAB / "work"), "--codex", str(NODE_BIN / "codex")],
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
    state["started"] = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "pid": child.pid,
                        "starttime": starttime(child.pid), **built()}
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
        time.sleep(3)
        started = state.get("started", {})
        state.setdefault("receipts", []).append({"started": started, "stopped": {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "coreExited": starttime(pid) != started.get("starttime"), "bridgesLeft": bridges_left()}})
        record("lab-receipts", state["receipts"])
    save(state)


def detail(agent):
    return call("GET", f"/api/agents/{agent}")


def approve(d):
    for request in d["pending"]:
        if request["method"] == "claude/canUseTool" and not request.get("stale") \
                and "import time; time.sleep(" in json.dumps(request["params"]) and not request["params"].get("_responseSent"):
            call("POST", f"/api/requests/{request['id']}/respond", {"response": {"decision": "allow"}})


def wait(agent, ready, what, seconds=300):
    deadline = time.time() + seconds
    while time.time() < deadline:
        d = detail(agent)
        if ready(d):
            return d
        approve(d)
        time.sleep(0.5)
    raise SystemExit(f"Timed out waiting for {what}")


def new_agent(state, name):
    catalog = call("GET", "/api/models?harness=claude", timeout=180)
    models = [m.get("value") or m.get("id") for m in catalog.get("models", catalog.get("data", []))]
    model = next((m for m in models if m and "haiku" in m), models[0] if models else "")
    agent = call("POST", "/api/agents", {"name": name, "harness": "claude", "cwd": str(LAB / "work"), "model": model},
                 timeout=180)["id"]
    call("POST", f"/api/agents/{agent}/settings", {"model": model, "permissionMode": "default"})
    state.setdefault("agents", {})[name] = agent
    save(state)
    return agent


def text_of(item):
    return item.get("text") or "".join(c.get("text", "") for c in item.get("content", []))


def turn(d, turn_id):
    return next((t for t in d["turns"] if t["id"] == turn_id), None)


def follow_up(agent, turn_id, text, client=None):
    body = {"clientMessageId": client or str(uuid.uuid4()), "text": text, "expectedTurnId": turn_id, "question": None}
    return body, call("POST", f"/api/agents/{agent}/messages", body, timeout=180)


def receipt(d, client):
    return next(r for r in d["messageReceipts"] if r["input"]["clientMessageId"] == client)


def requested(agent, client):
    """How many times Core recorded sending this message (journal rows)."""
    db = sqlite3.connect(f"file:{LAB / 'core-data/workspace.sqlite'}?mode=ro", uri=True)
    rows = db.execute("SELECT data FROM journal WHERE agent_id=? AND kind='message/requested'", [agent]).fetchall()
    return sum(1 for (data,) in rows if json.loads(data)["input"]["clientMessageId"] == client)


def check(condition, message, failures):
    if not condition:
        failures.append(message)


def summary(d, ids):
    return [{"id": t["id"], "status": t["status"], "source": t.get("_yuzunoSource"),
             "items": [{"type": i["type"], "clientId": i.get("clientId"), "delivery": i.get("_yuzunoDelivery"),
                        "text": text_of(i)[:120]}
                       for i in t["items"] if i["type"] in ("userMessage", "agentMessage")]}
            for t in d["turns"] if t["id"] in ids]


def start():
    state = load()
    if state.get("pid"):
        raise SystemExit("A lab Core is recorded as running; run stop first.")
    state["dailyBefore"] = daily()
    launch(state)
    print(json.dumps({"core": BASE, "started": state["started"]}, indent=2))


def post_raw(path, body):
    """A POST whose refusal is the result: (status, body)."""
    try:
        return 200, call("POST", path, body, timeout=180)
    except RuntimeError as error:
        status, _, text = str(error).partition(": ")[2].partition(" ")
        return int(status), json.loads(text or "null")


def several():
    state = load()
    agent = new_agent(state, "T-65 several")
    steps = [STEP.format(s=8, n=n) for n in (1, 2, 3)]
    prompt = ("T-65 acceptance. Use the Bash tool three separate times, one after another, waiting for each: "
              + ", then ".join(f"`{s}`" for s in steps) + ". Do not combine them. Then reply with one short sentence.")
    turn_id = call("POST", f"/api/agents/{agent}/turns", {"text": prompt}, timeout=180)["turnId"]
    wait(agent, lambda d: any(i["type"] == "claudeToolUse" for i in turn(d, turn_id)["items"]), "the first tool")
    first_body, first = follow_up(agent, turn_id, "T-65 follow-up one: also put the word banana in your final reply.")
    # The first is still waiting at Claude; the second must go too.
    second_body, second = follow_up(agent, turn_id, "T-65 follow-up two: also put the word kiwi in your final reply.")
    again = call("POST", f"/api/agents/{agent}/messages", first_body, timeout=180)
    refused_status, refused = post_raw(f"/api/agents/{agent}/messages", {**first_body, "text": "changed text"})
    d = wait(agent, lambda d: d["agent"]["status"] == "idle" and all(t["status"] != "inProgress" for t in d["turns"]),
             "every turn to end", 500)
    time.sleep(2)
    d = detail(agent)
    failures = []
    check([first["status"], second["status"]] == ["queued", "queued"],
          f"receipts {first['status']}, {second['status']}: both queued, the second not held back", failures)
    check(again["input"]["clientMessageId"] == first_body["clientMessageId"], "a repeat got another receipt", failures)
    # The id was submitted: other content under it is refused, but not as
    # "not submitted", so the client keeps the id (T-65 R2).
    check(refused_status == 400 and (refused or {}).get("code") != "message_not_submitted"
          and "不同的内容" in (refused or {}).get("error", ""),
          f"a changed reuse of an id: {refused_status} {refused}", failures)
    replies = []
    for body, word in ((first_body, "banana"), (second_body, "kiwi")):
        final = receipt(d, body["clientMessageId"])
        holder = turn(d, final["turnId"]) if final.get("turnId") else None
        check(final["status"] == "accepted" and holder is not None, f"not confirmed: {final}", failures)
        check(requested(agent, body["clientMessageId"]) == 1, f"{word} sent more than once", failures)
        shown = [i for t in d["turns"] for i in t["items"] if i.get("clientId") == body["clientMessageId"]]
        check(len(shown) == 1 and "_yuzunoDelivery" not in shown[0], f"{word} shown {shown}", failures)
        replies.append(" ".join(text_of(i) for t in d["turns"] for i in t["items"] if i["type"] == "agentMessage"))
        check(word in replies[-1].lower(), f"Claude did not act on {word}", failures)
    check(len(d["messageReceipts"]) == 2, f"receipts {[r['input']['clientMessageId'] for r in d['messageReceipts']]}",
          failures)
    result = {"agent": agent, "turnId": turn_id, "receipts": [first["status"], second["status"]],
              "notSubmitted": [refused_status, refused], "final": d["messageReceipts"], "failures": failures,
              "turns": summary(d, [t["id"] for t in d["turns"]])}
    record("several", result)
    print(json.dumps({k: result[k] for k in ("receipts", "notSubmitted", "failures")}, indent=2, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


def next_turn():
    state = load()
    agent = new_agent(state, "T-65 next")
    turn_id = call("POST", f"/api/agents/{agent}/turns",
                   {"text": "T-65 acceptance. Do not use any tool. Reply with exactly: first"}, timeout=180)["turnId"]
    bodies = []
    for word in ("second", "third"):
        # Not "reply with exactly": run together, two such instructions conflict.
        body, first = follow_up(agent, turn_id, f"T-65 follow-up. Do not use any tool. Include the word {word} in your reply.")
        bodies.append((body, first, word))
    d = wait(agent, lambda d: d["agent"]["status"] == "idle"
             and all(t["status"] != "inProgress" for t in d["turns"]), "every turn to end", 300)
    time.sleep(2)
    d = detail(agent)
    failures = []
    outcomes = []
    for body, first, word in bodies:
        final = receipt(d, body["clientMessageId"])
        if first["status"] == "rejected":
            outcomes.append(f"{word}: refused, its turn had already ended at the bridge")
            continue
        check(first["status"] == "queued", f"{word} first receipt {first['status']}", failures)
        holder = turn(d, final["turnId"]) if final.get("turnId") else None
        check(final["status"] == "accepted" and holder is not None, f"{word} not confirmed: {final}", failures)
        check(holder and any(word in text_of(i).lower() for i in holder["items"] if i["type"] == "agentMessage"),
              f"Claude did not answer {word}", failures)
        check(requested(agent, body["clientMessageId"]) == 1, f"{word} sent more than once", failures)
        outcomes.append(f"{word}: {'its own turn' if final['turnId'] != turn_id else 'the prompt turn'} {final['turnId'][:8]}")
    result = {"agent": agent, "promptTurn": turn_id, "outcomes": outcomes, "failures": failures,
              "turns": summary(d, [t["id"] for t in d["turns"]])}
    record("next", result)
    print(json.dumps({k: result[k] for k in ("outcomes", "failures")}, indent=2, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


def stop():
    state = load()
    halt(state)
    after = daily()
    print(json.dumps({"unchanged": state.get("dailyBefore") == after, "receipt": state.get("receipts", [])[-1:]}, indent=2))


if __name__ == "__main__":
    {"start": start, "several": several, "next": next_turn, "stop": stop}[sys.argv[1]]()
