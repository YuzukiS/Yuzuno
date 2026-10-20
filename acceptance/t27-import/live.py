#!/usr/bin/env python3
"""T-27 acceptance: a Claude Code session saved on the Core host is listed,
previewed and imported as one Agent, then goes on as that same session.

  YUZUNO_LAB_CORE=<candidate Core> YUZUNO_LAB_WEB=<candidate web/dist> \\
    python3 acceptance/t27-import/live.py <empty lab folder>

Only sessions this lab creates are imported: real Claude Code (installed CLI,
normal login, `claude -p --model haiku`) works in folders made for the lab
under ~/.t27-lab/<lab name>. One lab Core with its own data and port, never
the daily one, with this checkout's bridge. Checks:

  native   the lab's sessions: S (two prompts, one Bash call, in app/),
           N (one prompt, in app/) and M (one prompt, in a folder then moved)
  list     a bounded page, filtered to app/: S and N with their folder; the
           unfiltered first page is bounded too (its count and time only:
           the user's own sessions are never recorded)
  preview  S's prompts and newest messages; occupancy is "unknown", never free
  refused  an unknown id, a malformed id, another folder than the session's,
           a session whose folder is gone: nothing created
  import   S into a lab Project: its saved turns, disconnected, no query
           started and S's file unchanged; again, and twice at once: the
           same Agent
  browser  browser.mjs imports N through the dialog (keyboard choice, Project
           and folder confirmed), and shows S as already imported, light and
           dark, wide and narrow
  continue a message to S's Agent resumes S: one new prompt in S, sent with
           the turn's id; no saved prompt sent again; Core's session stays S
  daily    the daily Core's listener and web, and ~/.claude/settings.json,
           are the same before and after

Judged by Core's records and the SDK's own reading of the sessions (probe.mjs),
never by the model's wording. Every check goes to <lab>/evidence.json.
"""
import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CORE = Path(os.environ["YUZUNO_LAB_CORE"])
WEB = Path(os.environ["YUZUNO_LAB_WEB"])
BRIDGE = ROOT / "runtimes/claude/bridge.mjs"
SDK = ROOT / "runtimes/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
CLAUDE = Path(os.path.realpath(NODE_BIN / "claude"))
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
CLAUDE_SETTINGS = Path.home() / ".claude/settings.json"
LAB = Path(sys.argv[1]).resolve()
LAB.mkdir(parents=True)
WORK = Path.home() / ".t27-lab" / LAB.name
APP, MOVED, OTHER = WORK / "app", WORK / "moved", WORK / "other"
PORT = 4591
BASE = f"http://127.0.0.1:{PORT}"
ENV = {"HOME": str(Path.home()), "PATH": f"{NODE_BIN}:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
evidence = {"lab": str(LAB), "work": str(WORK), "checks": [], "observations": {}}
started = time.monotonic()


def call(method, path, body=None, timeout=180):
    request = urllib.request.Request(
        BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Yuzuno-Client": "desktop"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        text = error.read().decode()
        try:
            return error.code, json.loads(text)
        except ValueError:
            return error.code, text


def ok(method, path, body=None, timeout=180):
    status, result = call(method, path, body, timeout)
    if status != 200:
        raise SystemExit(f"{method} {path}: {status} {result}")
    return result


def check(condition, claim, **facts):
    evidence["checks"].append({"ok": bool(condition), "check": claim, **facts, "t": round(time.monotonic() - started, 1)})
    print(("PASS " if condition else "FAIL ") + claim, json.dumps(facts, ensure_ascii=False)[:600], flush=True)


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


def claude(cwd, prompt, *extra):
    """One real Claude Code print-mode run in a lab folder; its JSON result."""
    out = subprocess.run([str(CLAUDE), "-p", prompt, "--model", "haiku", "--output-format", "json", *extra],
                         cwd=cwd, env=ENV, capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL)
    try:
        result = json.loads(out.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise SystemExit(f"claude -p failed ({out.returncode}): {out.stderr[-2000:]}")
    if result.get("is_error"):
        raise SystemExit(f"claude -p reported an error: {result.get('result')}")
    return result


def native(session, folder):
    """The session as Claude Code's own SDK reads it (probe.mjs, read only)."""
    out = subprocess.run([str(NODE_BIN / "node"), str(HERE / "probe.mjs"), str(SDK), session, str(folder)],
                         capture_output=True, text=True, timeout=120, env=ENV)
    if out.returncode != 0:
        raise SystemExit(f"probe failed: {out.stderr[-2000:]}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def listed(query):
    page = ok("GET", "/api/claude/sessions?" + urllib.parse.urlencode(query))
    return page, {s["sessionId"]: s for s in page["sessions"]}


def agents():
    return ok("GET", "/api/workspace")["agents"]


def detail(agent):
    return ok("GET", f"/api/agents/{agent}")


def wait(agent, ready, what, seconds=300):
    deadline = time.time() + seconds
    while time.time() < deadline:
        d = detail(agent)
        if ready(d):
            return d
        time.sleep(0.5)
    raise SystemExit(f"Timed out waiting for {what}")


def turns(d):
    return [{"id": t["id"], "status": t.get("status"), "origin": t.get("_yuzunoOrigin"),
             "items": [{"type": i.get("type"), "name": i.get("name"), "status": i.get("status")} for i in t.get("items", [])]}
            for t in d["turns"]]


before = daily()
evidence["observations"]["dailyBefore"] = before
for folder in (APP, MOVED, OTHER):
    folder.mkdir(parents=True)
(APP / "notes.txt").write_text("T-27 lab notes\n")
(APP / "plan.md").write_text("# T-27 lab plan\n")

# The lab's own native sessions, made by real Claude Code.
first = claude(APP, "Remember the code word KUMQUAT-27 for later in this session. Reply with only: OK")
S = first["session_id"]
second = claude(APP, "Use the Bash tool to run ls in this folder, then reply with only the file names.",
                "--resume", S, "--allowedTools", "Bash(ls)")
check(second["session_id"] == S, "print-mode --resume keeps the session id", first=S, second=second["session_id"])
N = claude(APP, "Reply with only: ready")["session_id"]
M = claude(MOVED, "Reply with only: moved")["session_id"]
MOVED.rename(WORK / "moved-away")
s_before = native(S, APP)
check(s_before["found"] and len(s_before["prompts"]) == 2 and s_before["cwd"] == str(APP),
      "S is saved in app/ with its two prompts", session=S, prompts=s_before["prompts"], cwd=s_before["cwd"])
n_before = native(N, APP)

log = (LAB / "core.log").open("ab")
core = subprocess.Popen(
    [str(CORE), "--port", str(PORT), "--data-dir", str(LAB / "core-data"), "--cwd", str(LAB / "work"),
     "--codex", str(NODE_BIN / "codex"), "--web-dir", str(WEB)],
    cwd=LAB, env={**ENV, "YUZUNO_CLAUDE_BRIDGE": str(BRIDGE)},
    stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
(LAB / "work").mkdir(exist_ok=True)
try:
    for _ in range(300):
        try:
            if call("GET", "/api/health", timeout=2)[0] == 200:
                break
        except OSError:
            pass
        if core.poll() is not None:
            raise SystemExit("lab Core exited; see core.log")
        time.sleep(0.2)
    evidence["core"] = {"binary": str(CORE), "binarySha256": digest(CORE), "bridgeSha256": digest(BRIDGE),
                        "sessionsSha256": digest(ROOT / "runtimes/claude/sessions.mjs"), "web": str(WEB), "pid": core.pid}
    project = ok("POST", "/api/projects", {"name": "T27 lab"})

    # The list: bounded pages; one folder's sessions.
    t0 = time.monotonic()
    page, _ = listed({"limit": 20})
    check(len(page["sessions"]) <= 20, "the unfiltered first page is bounded (count and time only)",
          count=len(page["sessions"]), more=page["next"] is not None, seconds=round(time.monotonic() - t0, 2))
    _, person = listed({"dir": str(APP)})
    page, scripted = listed({"dir": str(APP), "programmatic": "true", "limit": 1})
    check(len(page["sessions"]) == 1 and page["next"] == 1, "a page of one says another follows", next=page["next"])
    _, scripted = listed({"dir": str(APP), "programmatic": "true"})
    evidence["observations"]["claude -p sessions listed as person-started"] = sorted(set(person) & {S, N})
    check({S, N} <= set(scripted) and all(scripted[x]["cwd"] == str(APP) and scripted[x]["existingAgentId"] is None for x in (S, N)),
          "S and N are listed in app/, unbound", listed=sorted(scripted), s=scripted.get(S))
    check(M not in scripted, "M (saved in another folder) is not in app/'s list")

    # The preview.
    preview = ok("POST", "/api/claude/sessions/preview", {"sessionId": S})
    roles = [m["role"] for m in preview["recent"]]
    check(preview["prompts"] == 2 and roles[:1] == ["user"] and "KUMQUAT-27" in preview["recent"][0]["text"]
          and preview["folderExists"] and preview["existingAgentId"] is None and preview["occupancy"] == "unknown",
          "S's preview: its prompts and newest messages; occupancy unknown",
          prompts=preview["prompts"], roles=roles, subagents=preview["subagents"], model=preview["model"],
          occupancy=preview["occupancy"])

    # Refused, with nothing created.
    for claim, method, path, body, expect in [
        ("an unknown session", "POST", "/api/claude/sessions/preview", {"sessionId": str(uuid.uuid4())}, "找不到"),
        ("a malformed id", "POST", "/api/claude/sessions/preview", {"sessionId": "../" + S}, "UUID"),
        ("another folder than the session's", "POST", "/api/claude/sessions/import",
         {"sessionId": S, "name": "Wrong", "projectId": None, "cwd": str(OTHER)}, "与确认的目录不同"),
        ("a session whose folder is gone", "POST", "/api/claude/sessions/import",
         {"sessionId": M, "name": "Gone", "projectId": None, "cwd": str(APP)}, "已不存在"),
    ]:
        status, result = call(method, path, body)
        check(status == 400 and expect in str(result), f"refused: {claim}", status=status, error=result)
    gone = ok("POST", "/api/claude/sessions/preview", {"sessionId": M})
    check(gone["folderExists"] is False, "M's preview says its folder is gone", cwd=gone["session"]["cwd"])
    check(agents() == [], "nothing was created")

    # The import.
    body = {"sessionId": S, "name": "T27 lab import", "projectId": project["id"], "cwd": str(APP)}
    imported = ok("POST", "/api/claude/sessions/import", body)
    agent = imported["agent"]["id"]
    d = detail(agent)
    view = turns(d)
    call_items = [i for t in d["turns"] for i in t.get("items", []) if i.get("type") == "claudeToolUse"]
    check(not imported["existing"] and imported["turns"] == 2 and d["agent"]["claudeSessionId"] == S
          and d["agent"]["connectionState"] == "disconnected" and d["agent"]["projectId"] == project["id"]
          and d["agent"]["cwd"] == str(APP),
          "S is one new Agent in the lab Project, in app/, not connected",
          agent={k: d["agent"].get(k) for k in ("claudeSessionId", "connectionState", "status", "projectId", "cwd", "name")},
          imported={k: imported[k] for k in ("existing", "saved", "turns", "leftOut", "compacted")})
    check([t["id"] for t in view] == [f"native-{p['uuid']}" for p in s_before["prompts"]]
          and all(t["status"] == "completed" and t["origin"] == "outside" for t in view),
          "its turns are S's two prompts, completed, marked as sent outside Yuzuno", turns=view)
    check(len(call_items) == 1 and call_items[0].get("name") == "Bash" and call_items[0].get("status") == "completed"
          and "notes.txt" in str(call_items[0].get("output")),
          "S's Bash call is its real tool item, with its output",
          item={k: call_items[0].get(k) for k in ("type", "name", "status")} if call_items else None)
    s_after = native(S, APP)
    check(s_after == s_before, "S's saved file is unchanged by listing, previewing and importing",
          before={k: s_before[k] for k in ("fileSize", "lastModified", "messages")},
          after={k: s_after[k] for k in ("fileSize", "lastModified", "messages")})
    again = ok("POST", "/api/claude/sessions/import", {**body, "name": "Another name", "projectId": None})
    results = []
    threads = [threading.Thread(target=lambda: results.append(call("POST", "/api/claude/sessions/import", body))) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    check(again["existing"] and again["agent"]["id"] == agent
          and all(status == 200 and r["agent"]["id"] == agent and r["existing"] for status, r in results)
          and len(agents()) == 1,
          "importing S again, and twice at once, gives that same Agent", agents=len(agents()))
    _, now_listed = listed({"dir": str(APP), "programmatic": "true"})
    check(now_listed[S]["existingAgentId"] == agent
          and ok("POST", "/api/claude/sessions/preview", {"sessionId": S})["existingAgentId"] == agent,
          "the list and the preview point at S's Agent")

    # The dialog in a real browser: N through the UI, S shown as already imported.
    shots = LAB / "screenshots"
    out = subprocess.run([str(NODE_BIN / "node"), str(HERE / "browser.mjs"), BASE, str(APP), N, S, project["name"], str(shots)],
                         capture_output=True, text=True, timeout=300, env=ENV)
    (LAB / "browser.log").write_text(out.stdout + out.stderr)
    if out.returncode != 0:
        raise SystemExit(f"browser.mjs failed: {out.stderr[-2000:]}")
    seen = json.loads(out.stdout.strip().splitlines()[-1])
    evidence["observations"]["browser"] = seen
    check(seen["keyboardChose"] == N and seen["preview"]["folder"] == str(APP) and seen["preview"]["project"] == project["name"],
          "the dialog: N chosen with the keyboard, its folder and the Project shown for confirmation", preview=seen["preview"])
    n_agent = next((a for a in agents() if a.get("claudeSessionId") == N), None)
    check(n_agent is not None and n_agent["name"] == "T27 browser import" and n_agent["projectId"] == project["id"]
          and n_agent["connectionState"] == "disconnected" and native(N, APP) == n_before,
          "N was imported once through the dialog, in the Project, not connected; N's file unchanged",
          agent={k: (n_agent or {}).get(k) for k in ("name", "projectId", "connectionState")})
    check(seen["existing"]["heading"] == "Already in your workspace" and seen["existing"]["action"] == "Open agent"
          and seen["existing"]["theme"] == "dark" and not seen["existing"]["overflow"],
          "S shows as already imported; dark and narrow without overflow", existing=seen["existing"])
    check(seen["filterRow"]["direction"] == "row" and seen["filterRow"]["sameLine"] and seen["filterRow"]["checkboxWidth"] < 40,
          "the scripts filter is a checkbox on its label's line", row=seen["filterRow"])

    # Continue S: the first message resumes it.
    turn = ok("POST", f"/api/agents/{agent}/turns", {"text": "What is the code word I asked you to remember? Reply with only the code word."})["turnId"]
    d = wait(agent, lambda d: next((t for t in d["turns"] if t["id"] == turn and t.get("status") in ("completed", "failed", "interrupted")), None), "the resumed turn")
    t = next(t for t in d["turns"] if t["id"] == turn)
    reply = " ".join(i.get("text", "") for i in t.get("items", []) if i.get("type") == "agentMessage")
    evidence["observations"]["resumed reply"] = reply[:200]
    s_resumed = native(S, APP)
    new = s_resumed["prompts"][len(s_before["prompts"]):]
    check(t["status"] == "completed" and d["agent"]["claudeSessionId"] == S, "the turn completed in S", status=t["status"])
    check(s_resumed["prompts"][:2] == s_before["prompts"] and [p["uuid"] for p in new] == [turn],
          "S gained one prompt, sent with the turn's id; no saved prompt was sent again",
          prompts=[p["uuid"] for p in s_resumed["prompts"]], turn=turn)
    check([x["id"] for x in turns(d)] == [x["id"] for x in view] + [turn], "the Agent's turns: S's two, then the new one",
          turns=[x["id"] for x in turns(d)])
finally:
    try:
        os.killpg(core.pid, signal.SIGTERM)
        core.wait(timeout=20)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        os.killpg(core.pid, signal.SIGKILL)
        core.wait(timeout=10)
    after = daily()
    evidence["observations"]["dailyAfter"] = after
    check(after == before, "the daily Core, its web and Claude settings are unchanged", before=before, after=after)
    evidence["sessions"] = {"S": S, "N": N, "M": M}
    failed = [c["check"] for c in evidence["checks"] if not c["ok"]]
    evidence["result"] = {"passed": len(evidence["checks"]) - len(failed), "failed": failed}
    (LAB / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    print(json.dumps(evidence["result"], ensure_ascii=False))
sys.exit(1 if evidence["result"]["failed"] else 0)
