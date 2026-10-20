#!/usr/bin/env python3
"""T-39 acceptance: a real Agent proposes a task status change; the user
edits, confirms or declines it in the browser; Core changes the task.

  YUZUNO_LAB_CORE=<candidate Core> YUZUNO_LAB_WEB=<candidate web/dist> \\
    python3 acceptance/t39-task-status/live.py <empty lab folder>

One lab Core: the candidate binary and web, its own data and port, the real
Claude bridge, so the Agent is real Claude Code (installed CLI, normal
login, `sonnet`) in ~/.t39-lab/<lab name>. Its tasks are created in the
lab only, so no daily task is ever proposed or changed. The case is T-88's:
merged, but the acceptance on another host is still open.

Real:
- **propose:** asked in plain words, the Agent publishes a TaskStatus for
  T-1 (review) with result_publish. Its Turn changes nothing on T-1.
- **decide:** in Chromium (browser.mjs confirm), each step by keyboard:
  - another window changes T-1 first, so the first confirmation is refused
    as stale and nothing changes;
  - the user picks another status (blocked) and writes a reason;
  - Core's answer to the next confirmation is lost on the way back
    (the request reached Core; the page saw a reset); "Check again" sends
    the same decision once more;
  - T-1 is changed exactly once, as the user, with the user's status and
    reason; its activity names the proposal, the Agent's original status
    and the user's reason;
  - a second window shows the outcome and offers nothing more;
  - dark at 390 px without overflow.
- **decline:** a second proposal (T-2) is declined with the keyboard; T-2
  is unchanged.
- **daily:** the daily Core's listener and web, and ~/.claude/settings.json,
  are the same before and after.

Checks are judged by Core's records and API, never by the Agent's wording.
Everything goes to <lab>/evidence.json.
"""
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CORE = Path(os.environ["YUZUNO_LAB_CORE"])
WEB = Path(os.environ["YUZUNO_LAB_WEB"])
BRIDGE = ROOT / "runtimes/claude/bridge.mjs"
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
CLAUDE_SETTINGS = Path.home() / ".claude/settings.json"
MODEL = os.environ.get("YUZUNO_LAB_MODEL", "sonnet")
LAB = Path(sys.argv[1]).resolve()
LAB.mkdir(parents=True)
WORK = Path.home() / ".t39-lab" / LAB.name
PORT = 4597
BASE = f"http://127.0.0.1:{PORT}"
ENV = {"HOME": str(Path.home()), "PATH": f"{NODE_BIN}:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
       "YUZUNO_CLAUDE_BRIDGE": str(BRIDGE), "YUZUNO_NODE": str(NODE_BIN / "node")}
evidence = {"lab": str(LAB), "model": MODEL, "checks": [], "observations": {}}
started = time.monotonic()


def call(method, path, body=None, timeout=120):
    request = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", "X-Yuzuno-Client": "desktop"})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as error:
        text = error.read().decode()
        try:
            return error.code, json.loads(text)
        except ValueError:
            return error.code, text


def ok(method, path, body=None):
    status, result = call(method, path, body)
    if status != 200:
        raise SystemExit(f"{method} {path}: {status} {result}")
    return result


def check(condition, claim, **facts):
    evidence["checks"].append({"ok": bool(condition), "check": claim, **facts, "t": round(time.monotonic() - started, 1)})
    print(("PASS " if condition else "FAIL ") + claim, json.dumps(facts, ensure_ascii=False)[:800], flush=True)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest() if Path(path).exists() else None


def daily():
    listener = subprocess.run(["ss", "-ltnp", "sport = :4317"], text=True, capture_output=True).stdout
    tree = hashlib.sha256()
    for path in sorted(DAILY_DIST.rglob("*")):
        if path.is_file():
            tree.update(str(path.relative_to(DAILY_DIST)).encode() + path.read_bytes())
    return {"listener": listener.split("users:")[-1].strip() if "users:" in listener else None,
            "webDist": tree.hexdigest(), "claudeSettings": digest(CLAUDE_SETTINGS)}


def wait(what, ready, seconds=120):
    deadline = time.time() + seconds
    while time.time() < deadline:
        value = ready()
        if value:
            return value
        time.sleep(0.5)
    raise SystemExit(f"Timed out waiting for {what}")


def task(reference):
    return ok("POST", "/api/collaboration/task_get", {"taskId": reference})


def turn(agent_id, text):
    turn_id = ok("POST", f"/api/agents/{agent_id}/turns", {"text": text})["turnId"]
    return wait(f"turn {text[:30]}", lambda: next((t for t in ok("GET", f"/api/agents/{agent_id}")["turns"]
                                                  if t["id"] == turn_id and t.get("status") not in (None, "inProgress")), None), 600)


def proposals(turn_record):
    """What Core shows for the Turn's published results that propose a task change."""
    shown = []
    for result in turn_record.get("_yuzunoResults") or []:
        status, view = call("GET", f"/api/results/{result['id']}/task-status")
        if status == 200:
            shown.append(view)
    return shown


def tools(agent_id, turn_id):
    """The Turn's tool calls, by name and status."""
    d = ok("GET", f"/api/agents/{agent_id}")
    items = next((t for t in d["turns"] if t["id"] == turn_id), {}).get("items", [])
    return [{"tool": i.get("tool") or i.get("name"), "status": i.get("status")} for i in items if i.get("type") in ("mcpToolCall", "dynamicToolCall", "toolCall")]


def browser(agent_id, step):
    out = subprocess.run([str(NODE_BIN / "node"), str(HERE / "browser.mjs"), BASE, agent_id, step, str(LAB / "screenshots")],
                         capture_output=True, text=True, timeout=600, env=ENV)
    (LAB / f"browser-{step}.log").write_text(out.stdout + out.stderr)
    if out.returncode != 0:
        raise SystemExit(f"browser.mjs {step} failed: {out.stderr[-3000:]}")
    seen = json.loads(out.stdout.strip().splitlines()[-1])
    evidence["observations"][f"browser {step}"] = seen
    return seen


before = daily()
child = None
try:
    WORK.mkdir(parents=True, exist_ok=True)
    data, cwd = LAB / "core-data", LAB / "core-work"
    cwd.mkdir()
    log = (LAB / "core.log").open("ab")
    child = subprocess.Popen(
        [str(CORE), "--port", str(PORT), "--data-dir", str(data), "--cwd", str(cwd), "--web-dir", str(WEB), "--codex", str(NODE_BIN / "codex")],
        cwd=LAB, env=ENV, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    def healthy():
        if child.poll() is not None:
            raise SystemExit("the lab Core exited; see core.log")
        try:
            return call("GET", "/api/health", timeout=2)[0] == 200
        except OSError:
            return False
    wait("the lab Core", healthy, 60)
    evidence["observations"]["core"] = {"binarySha256": digest(CORE), "pid": child.pid, "port": PORT}

    # The lab's own tasks: T-88's case, and one more to decline.
    t1 = ok("POST", "/api/collaboration/task_create", {"requestId": "t1", "title": "Independent Core: install from a release (lab copy of T-88)",
            "description": "PR merged. The install still has to be accepted on a second host with a new account."})["task"]
    t1 = ok("POST", "/api/collaboration/task_update", {"requestId": "t1-doing", "taskId": t1["id"], "expectedVersion": t1["version"],
            "patch": {"status": "doing"}})["task"]
    t2 = ok("POST", "/api/collaboration/task_create", {"requestId": "t2", "title": "Windows updater lab run (lab task)"})["task"]
    check(t1["id"] == "T-1" and t1["status"] == "doing" and t2["id"] == "T-2" and t2["status"] == "todo", "the lab has its own tasks T-1 (doing) and T-2 (todo)",
          t1={k: t1[k] for k in ("id", "status", "version")}, t2={k: t2[k] for k in ("id", "status", "version")})

    a = ok("POST", "/api/agents", {"name": "T39 Lead lab", "cwd": str(WORK), "harness": "claude", "machineId": "local", "model": MODEL})["id"]
    wait("the agent to connect", lambda: ok("GET", f"/api/agents/{a}")["agent"]["connectionState"] == "connected", 120)

    # Real: the Agent proposes, in plain words; it is not told how.
    t = turn(a, "T-1 on our task board is merged, but the install still has to be accepted on a second host. "
                "Propose moving T-1 to review for that reason, as a proposal I confirm myself in Yuzuno. Don't change the task yourself.")
    shown = proposals(t)
    evidence["observations"]["propose turn"] = {"status": t["status"], "tools": tools(a, t["id"]), "results": [r.get("id") for r in t.get("_yuzunoResults") or []]}
    p = shown[0] if shown else None
    check(t["status"] == "completed" and p and p["proposal"]["taskId"] == "T-1" and p["proposal"]["status"] == "review" and p["blocked"] is None,
          "real: the Agent published a TaskStatus proposal for T-1 (review)", proposal=p and p["proposal"], turn=t["status"])
    now = task("T-1")["task"]
    check(now["status"] == "doing" and now["version"] == t1["version"], "real: the Agent's Turn changed nothing on T-1",
          status=now["status"], version=now["version"])
    if not p:
        raise SystemExit("no proposal to decide")
    check(p["task"] == {"id": "T-1", "title": t1["title"], "status": "doing", "version": t1["version"], "blocker": "", "assignee": None, "archived": False},
          "the card's facts are Core's, read now", task=p["task"])

    seen = browser(a, "confirm")
    first = seen["first"]
    check(first["buttons"] == ["Change T-1 to In review", "Decline"] and "NowDoing · version" in first["text"] and "Agent proposesIn review" in first["text"],
          "browser: the card shows Core's T-1 beside the proposal, with confirm and decline", first=first)
    elsewhere = seen["elsewhere"]
    stale_post = seen["posts"][0] if seen["posts"] else {}
    check("changed while you were deciding" in seen["stale"]["text"] and stale_post.get("expectedVersion") == t1["version"],
          "browser: a confirmation after another window changed T-1 is refused as stale", stale=seen["stale"]["text"][-300:], post=stale_post)
    lost_post, check_post = (seen["posts"][1:3] + [{}, {}])[:2]
    check("was lost" in seen["lost"]["text"] and lost_post.get("status") == "blocked" and lost_post.get("expectedVersion") == elsewhere["version"]
          and check_post == lost_post and len(seen["posts"]) == 3,
          "browser: the edited decision's answer was lost; Check again sent the same decision, once", posts=seen["posts"])
    final = task("T-1")
    activity = [e for e in final["activities"] if e.get("kind") == "updated"]
    last = activity[-1] if activity else {}
    check(final["task"]["status"] == "blocked" and final["task"]["blocker"] == "Waits for the second-host install check"
          and final["task"]["version"] == elsewhere["version"] + 1,
          "T-1 changed exactly once: to the user's status, with the user's reason as its blocker",
          task={k: final["task"][k] for k in ("status", "blocker", "version")}, elsewhereVersion=elsewhere["version"])
    check(last.get("actor", {}).get("kind") == "user" and last.get("source", {}).get("via") == "taskProposal"
          and last["source"].get("proposedBy", {}).get("agentId") == a and last["source"].get("proposed", {}).get("status") == "review"
          and last["source"].get("reason") == "Waits for the second-host install check",
          "T-1's activity: the user changed it, from the Agent's proposal (review), with the user's reason", activity=last)
    check("confirmed it: T-1 is now Blocked" in seen["applied"]["text"] and seen["applied"]["buttons"] == []
          and "confirmed it: T-1 is now Blocked" in seen["secondWindow"]["text"] and seen["secondWindow"]["buttons"] == [],
          "browser: the outcome is shown, and a second window offers nothing more", applied=seen["applied"]["text"][-200:])
    narrow = seen["narrow"]
    check(narrow["theme"] == "dark" and not narrow["overflow"] and narrow["fits"], "browser: dark, 390 px wide, without overflow", narrow=narrow)
    check(not seen["errors"], "browser: no page errors", errors=seen["errors"])
    attempts = ok("GET", f"/api/results/{p['resultId']}/task-status")["attempts"]
    check([x["state"] for x in attempts] == ["failed", "applied"], "Core kept both decisions: the stale one failed, the edited one applied",
          attempts=[{k: x[k] for k in ("state", "status", "expectedVersion", "taskVersion")} for x in attempts])

    # Real: a second proposal, declined.
    t = turn(a, "Also propose starting T-2 (moving it to doing), again only as a proposal for me to confirm.")
    shown = proposals(t)
    evidence["observations"]["second turn"] = {"status": t["status"], "tools": tools(a, t["id"])}
    q = shown[0] if shown else None
    check(q and q["proposal"]["taskId"] == "T-2" and q["proposal"]["status"] == "doing", "real: a second proposal, for T-2 (doing)", proposal=q and q["proposal"])
    if q:
        seen = browser(a, "decline")
        two = task("T-2")["task"]
        check("declined it" in seen["declined"]["text"] and seen["declined"]["buttons"] == [] and two["status"] == "todo" and two["version"] == t2["version"],
              "browser: declined with the keyboard; T-2 unchanged", declined=seen["declined"]["text"][-200:], t2={k: two[k] for k in ("status", "version")})
finally:
    if child and child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
    after = daily()
    evidence["observations"]["dailyBefore"], evidence["observations"]["dailyAfter"] = before, after
    check(after == before, "the daily Core, its web and Claude settings are unchanged", before=before, after=after)
    failed = [c["check"] for c in evidence["checks"] if not c["ok"]]
    evidence["result"] = {"passed": len(evidence["checks"]) - len(failed), "failed": failed}
    (LAB / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    print(json.dumps(evidence["result"], ensure_ascii=False))
sys.exit(1 if evidence["result"]["failed"] else 0)
