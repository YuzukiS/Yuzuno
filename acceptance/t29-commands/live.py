#!/usr/bin/env python3
"""T-29 acceptance: a Claude Agent's composer lists the commands and Skills its
Claude Code lists, and a chosen command runs natively, as typed text would.

  YUZUNO_LAB_CORE=<candidate Core binary> YUZUNO_LAB_WEB=<candidate web/dist> \
    python3 acceptance/t29-commands/live.py <empty lab folder>

One lab Core with its own data and port, never the daily one. Real Claude
Code (the installed CLI, normal login) works in an empty folder outside any
checkout (~/.t29-lab/<lab name>) that has one project Skill. Checks:

  native     Core's list for the running session is Claude Code's own list
             for that folder (the SDK's supportedCommands, read directly by
             probe.mjs here, no prompt), minus terminal-only commands
  browser    browser.mjs in Chromium: "/" lists them, "/cont" narrows, the
             arrows move, Enter fills in /context without sending, Enter
             sends it, and a slash after other text opens nothing
  runs       the sent /context, an unknown /command and /reload-skills are
             native turns: judged by the turn's status and native items, not
             by any model wording
  skills     after a turn's init the project Skill is marked a Skill; a Skill
             added while the session runs is listed after /reload-skills
  folder     after the lab Core restarts the Agent has no session, and the
             list comes from Claude Code in its folder
  daily      the daily Core's listener and web, and ~/.claude/settings.json,
             are the same before and after

Every check goes to <lab>/evidence.json. The lab answers no permission
request: these commands need none.
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
SDK = ROOT / "runtimes/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
CLAUDE = Path(os.path.realpath(NODE_BIN / "claude"))
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
CLAUDE_SETTINGS = Path.home() / ".claude/settings.json"
PORT = 4571
LAB = Path(sys.argv[1]).resolve()
LAB.mkdir(parents=True)
AGENT_CWD = Path.home() / ".t29-lab" / LAB.name
SKILL = "t29-lab-skill"
LATE = "t29-late-skill"
BASE = f"http://127.0.0.1:{PORT}"
evidence = {"lab": str(LAB), "agentCwd": str(AGENT_CWD), "checks": [], "observations": {}}
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


def check(condition, text, **facts):
    evidence["checks"].append({"ok": bool(condition), "check": text, **facts, "t": round(time.monotonic() - started, 1)})
    print(("PASS " if condition else "FAIL ") + text, json.dumps(facts, ensure_ascii=False)[:500], flush=True)


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


class Core:
    def start(self, name):
        log = (LAB / f"{name}-core.log").open("ab")
        env = {**os.environ, "HOME": str(Path.home()), "PATH": f"{NODE_BIN}:/usr/local/bin:/usr/bin:/bin",
               "YUZUNO_CLAUDE_BRIDGE": str(BRIDGE), "YUZUNO_WEB_DIR": str(WEB)}
        (LAB / "work").mkdir(exist_ok=True)
        self.child = subprocess.Popen(
            [str(CORE), "--port", str(PORT), "--data-dir", str(LAB / "data"), "--cwd", str(LAB / "work"),
             "--codex", str(NODE_BIN / "codex")],
            cwd=LAB, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(300):
            try:
                if call("GET", "/api/health", timeout=2)[0] == 200:
                    break
            except OSError:
                pass
            if self.child.poll() is not None:
                raise SystemExit(f"{name} Core exited; see its log")
            time.sleep(0.2)
        evidence.setdefault("cores", []).append({"name": name, "binary": str(CORE), "binarySha256": digest(CORE),
                                                 "bridgeSha256": digest(BRIDGE), "pid": self.child.pid})

    def stop(self):
        try:
            os.killpg(self.child.pid, signal.SIGTERM)
            self.child.wait(timeout=20)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            os.killpg(self.child.pid, signal.SIGKILL)
            self.child.wait(timeout=10)
        time.sleep(2)


def detail(agent):
    return ok("GET", f"/api/agents/{agent}")


def turn_of(d, turn_id):
    return next((t for t in d["turns"] if t["id"] == turn_id), None)


def wait(agent, ready, what, seconds=300):
    deadline = time.time() + seconds
    while time.time() < deadline:
        d = detail(agent)
        if ready(d):
            return d
        time.sleep(0.5)
    raise SystemExit(f"Timed out waiting for {what}")


def ended(turn_id):
    return lambda d: d["agent"]["status"] == "idle" and (turn_of(d, turn_id) or {}).get("status") in ("completed", "failed", "interrupted")


def summary(t):
    """A turn as its native record has it: status, error, the text the user's
    own input item carried, and each item's type and status."""
    items = t.get("items", [])
    prompt = next((i for i in items if i.get("type") == "userMessage"), {})
    return {"status": t.get("status"), "error": t.get("error"),
            "input": "".join(c.get("text", "") for c in prompt.get("content", []) if isinstance(c, dict)),
            "items": [{"type": i.get("type"), "status": i.get("status"), "name": i.get("name") or i.get("tool")} for i in items]}


def send(agent, text):
    turn_id = ok("POST", f"/api/agents/{agent}/turns", {"text": text})["turnId"]
    d = wait(agent, ended(turn_id), f"turn {text}")
    t = turn_of(d, turn_id)
    evidence["observations"][f"turn {text}"] = summary(t)
    return t


def commands(agent):
    view = ok("GET", f"/api/agents/{agent}/claude/commands")
    evidence["observations"].setdefault("lists", []).append(
        {k: view.get(k) for k in ("state", "reason", "source", "sessionId", "total", "truncated", "skillsKnown")}
        | {"names": [c["name"] for c in view.get("commands", [])]})
    return view


def native():
    """Claude Code's own list for the Agent's folder, read straight from the SDK."""
    out = subprocess.run([str(NODE_BIN / "node"), str(HERE / "probe.mjs"), str(SDK), str(CLAUDE), str(AGENT_CWD)],
                         capture_output=True, text=True, timeout=180,
                         env={**os.environ, "HOME": str(Path.home()), "PATH": f"{NODE_BIN}:/usr/local/bin:/usr/bin:/bin"})
    if out.returncode != 0:
        raise SystemExit(f"probe failed: {out.stderr[-2000:]}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def skill(name, text):
    folder = AGENT_CWD / ".claude/skills" / name
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {text}\n---\n\nReply with the word ready.\n")


def main():
    AGENT_CWD.mkdir(parents=True)
    skill(SKILL, "T-29 lab project skill")
    before = daily()
    evidence["dailyBefore"] = before
    core = Core()
    core.start("first")
    try:
        agent = ok("POST", "/api/agents", {"name": "T-29 lab", "harness": "claude", "cwd": str(AGENT_CWD), "model": "haiku"})["id"]
        evidence["agent"] = agent
        wait(agent, lambda d: d["agent"]["connectionState"] == "connected", "the Agent's Claude to connect")

        listed = commands(agent)
        names = [c["name"] for c in listed["commands"]]
        own = native()
        check(listed["state"] == "ready" and listed["source"] == "session", "the running session lists its commands",
              state=listed["state"], source=listed["source"], count=len(names))
        check(set(names) == set(own["names"]) - set(own["terminal"]) and len(names) == len(set(names)),
              "the list is Claude Code's own for this folder, no more and no less",
              listed=len(names), native=len(own["names"]), onlyListed=sorted(set(names) - set(own["names"])),
              onlyNative=sorted(set(own["names"]) - set(names)))
        by_name = {c["name"]: c for c in listed["commands"]}
        check(SKILL in by_name and by_name[SKILL]["source"] == "custom" and not listed["skillsKnown"],
              "the project Skill is listed; before a turn it is not yet told apart", entry=by_name.get(SKILL))
        check(by_name.get("context", {}).get("source") == "builtin" and by_name.get("compact", {}).get("argumentHint"),
              "Claude Code's own commands carry their marker and argument hints",
              context=by_name.get("context"), compact=by_name.get("compact"))

        shots = LAB / "screenshots"
        out = subprocess.run([str(NODE_BIN / "node"), str(HERE / "browser.mjs"), BASE, agent, str(shots)],
                             capture_output=True, text=True, timeout=240,
                             env={**os.environ, "HOME": str(Path.home()), "PATH": f"{NODE_BIN}:/usr/local/bin:/usr/bin:/bin"})
        (LAB / "browser.log").write_text(out.stdout + out.stderr)
        if out.returncode != 0:
            raise SystemExit(f"browser.mjs failed: {out.stderr[-2000:]}")
        page = json.loads(out.stdout.strip().splitlines()[-1])
        evidence["observations"]["browser"] = page
        check(page["opened"]["count"] == len(names) and set(page["opened"]["names"]) == {f"/{n}" for n in names},
              "typing / in the composer shows the same list", shown=page["opened"]["count"])
        check(page["placement"]["menuBottom"] <= page["placement"]["composerTop"] and page["placement"]["menuTop"] >= 0,
              "the list sits above the composer box, inside the window", placement=page["placement"])
        check(all("cont" in o["name"] for o in page["narrowed"]) and page["chosen"] == "/context",
              "typing narrows the list and the arrows move the choice", narrowed=[o["name"] for o in page["narrowed"]])
        check(page["filled"] == "/context " and page["menuAfterFill"] == 0,
              "Enter fills in the command without sending it", filled=page["filled"])
        check(page["midText"]["menu"] == 0, "a slash after other text opens nothing", typed=page["midText"]["text"])

        # The turn browser.mjs sent: the Agent's newest.
        last = detail(agent)["turns"][-1]
        d = wait(agent, ended(last["id"]), "the /context turn")
        context = summary(turn_of(d, last["id"]))
        evidence["observations"]["turn /context"] = context
        # Claude Code answers /context itself: the prompt as typed, then its
        # own output as one agent message, and no tool.
        check(context["status"] == "completed" and not context["error"] and context["input"] == "/context"
              and [i["type"] for i in context["items"]] == ["userMessage", "agentMessage"],
              "the chosen /context is sent as typed and runs natively", turn=context)

        unknown = send(agent, "/t29-no-such-command")
        check(unknown["status"] in ("completed", "failed"), "an unknown command ends as Claude Code ends it, shown as such",
              turn=summary(unknown))

        after = commands(agent)
        entry = next((c for c in after["commands"] if c["name"] == SKILL), None)
        check(after["skillsKnown"] and entry and entry["source"] == "skill",
              "after a turn's init the project Skill is marked a Skill", entry=entry)

        skill(LATE, "T-29 Skill added while the session runs")
        reload = send(agent, "/reload-skills")
        check(reload["status"] == "completed", "/reload-skills runs natively", turn=summary(reload))
        late = commands(agent)
        check(any(c["name"] == LATE for c in late["commands"]),
              "a Skill added while the session runs is listed after Claude Code reloads its Skills",
              count=len(late["commands"]))
    finally:
        core.stop()

    core.start("restarted")
    try:
        folder = commands(evidence["agent"])
        folder_names = {c["name"] for c in folder["commands"]}
        check(folder["state"] == "ready" and folder["source"] == "folder" and {SKILL, LATE} <= folder_names,
              "with no session after a restart, the list is Claude Code's for the folder",
              source=folder["source"], count=len(folder_names))
    finally:
        core.stop()
    after = daily()
    evidence["dailyAfter"] = after
    check(after == before, "the daily Core and Claude settings are unchanged", before=before, after=after)


try:
    main()
finally:
    evidence["passed"] = sum(c["ok"] for c in evidence["checks"])
    evidence["failed"] = sum(not c["ok"] for c in evidence["checks"])
    (LAB / "evidence.json").write_text(json.dumps(evidence, indent=2, ensure_ascii=False))
    print(f"{evidence['passed']} passed, {evidence['failed']} failed")
sys.exit(1 if evidence.get("failed") else 0)
