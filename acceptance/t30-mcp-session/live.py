#!/usr/bin/env python3
"""T-30 acceptance: a new Claude Agent's MCP service status is read from its
own session, though Claude Code named that session on a hook before Core
named it. Read-only: no model turn is needed for the fresh-Agent check.

  YUZUNO_LAB_OLD_CORE=<Core with main's MCP read> YUZUNO_LAB_CORE=<candidate> \
    python3 acceptance/t30-mcp-session/live.py <empty lab folder>

Two lab Cores, one after the other, each with its own data and port (never
the daily one), both with this checkout's bridge (its MCP reader is main's).
Real Claude Code (installed CLI, normal login) works in an empty folder
outside any checkout (~/.t30-lab/<lab name>). Checks:

  old    a fresh Agent (Core has not named its session) reads as
         failed/changed: the false report this fixes
  new    the same reads as ready, listing Claude Code's own servers for the
         folder (probe.mjs: the SDK's mcpServerStatus, no prompt) plus Core's
         own `yuzuno` server; nothing else
  named  after a local /context turn (Claude Code answers it itself; no
         model call) Core has named the session, and the status reads again
         as ready for it
  gone   after the lab Core stops and starts again, the Agent is not
         connected and the status says so
  daily  the daily Core's listener and web, and ~/.claude/settings.json,
         are the same before and after

Judged by the endpoint's own fields (state, reason, sessionId, servers) and
Core's record of the Agent, never by wording. Every check goes to
<lab>/evidence.json.
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
OLD_CORE = Path(os.environ["YUZUNO_LAB_OLD_CORE"])
NEW_CORE = Path(os.environ["YUZUNO_LAB_CORE"])
BRIDGE = ROOT / "runtimes/claude/bridge.mjs"
SDK = ROOT / "runtimes/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
CLAUDE = Path(os.path.realpath(NODE_BIN / "claude"))
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
CLAUDE_SETTINGS = Path.home() / ".claude/settings.json"
LAB = Path(sys.argv[1]).resolve()
LAB.mkdir(parents=True)
CWD_ROOT = Path.home() / ".t30-lab" / LAB.name
evidence = {"lab": str(LAB), "checks": [], "observations": {}, "cores": []}
started = time.monotonic()
BASE = None
ENV = {**os.environ, "HOME": str(Path.home()), "PATH": f"{NODE_BIN}:/usr/local/bin:/usr/bin:/bin"}


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
    print(("PASS " if condition else "FAIL ") + claim, json.dumps(facts, ensure_ascii=False)[:500], flush=True)


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
    def __init__(self, name, binary, port):
        self.name, self.binary, self.port = name, binary, port
        self.data = LAB / f"{name}-data"

    def start(self, label):
        global BASE
        BASE = f"http://127.0.0.1:{self.port}"
        log = (LAB / f"{self.name}-core.log").open("ab")
        (LAB / f"{self.name}-work").mkdir(exist_ok=True)
        self.child = subprocess.Popen(
            [str(self.binary), "--port", str(self.port), "--data-dir", str(self.data), "--cwd", str(LAB / f"{self.name}-work"),
             "--codex", str(NODE_BIN / "codex")],
            cwd=LAB, env={**ENV, "YUZUNO_CLAUDE_BRIDGE": str(BRIDGE)},
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(300):
            try:
                if call("GET", "/api/health", timeout=2)[0] == 200:
                    break
            except OSError:
                pass
            if self.child.poll() is not None:
                raise SystemExit(f"{self.name} Core exited; see its log")
            time.sleep(0.2)
        evidence["cores"].append({"core": self.name, "start": label, "binary": str(self.binary),
                                  "binarySha256": digest(self.binary), "bridgeSha256": digest(BRIDGE), "pid": self.child.pid})

    def stop(self):
        try:
            os.killpg(self.child.pid, signal.SIGTERM)
            self.child.wait(timeout=20)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            os.killpg(self.child.pid, signal.SIGKILL)
            self.child.wait(timeout=10)
        time.sleep(2)


def agent_record(agent):
    return ok("GET", f"/api/agents/{agent}")["agent"]


def wait(what, ready, seconds=180):
    deadline = time.time() + seconds
    while time.time() < deadline:
        value = ready()
        if value:
            return value
        time.sleep(0.5)
    raise SystemExit(f"Timed out waiting for {what}")


def status(agent, label, refresh=False):
    view = ok("POST" if refresh else "GET", f"/api/agents/{agent}/claude/mcp-status")
    servers = [(s["name"], s["status"]) for s in ((view.get("observation") or {}).get("servers") or [])]
    evidence["observations"][label] = {k: view.get(k) for k in ("state", "reason", "sessionId", "generation", "stale")} | {"servers": servers}
    return view, servers


def fresh_agent(core, name):
    cwd = CWD_ROOT / name
    cwd.mkdir(parents=True)
    agent = ok("POST", "/api/agents", {"name": f"T-30 {name}", "harness": "claude", "cwd": str(cwd), "model": "haiku"})["id"]
    wait(f"{name} to connect", lambda: agent_record(agent)["connectionState"] == "connected")
    return agent, cwd


def native(cwd):
    out = subprocess.run([str(NODE_BIN / "node"), str(HERE / "probe.mjs"), str(SDK), str(CLAUDE), str(cwd)],
                         capture_output=True, text=True, timeout=180, env=ENV)
    if out.returncode != 0:
        raise SystemExit(f"probe failed: {out.stderr[-2000:]}")
    return json.loads(out.stdout.strip().splitlines()[-1])["servers"]


def main():
    before = daily()
    evidence["dailyBefore"] = before

    old = Core("old", OLD_CORE, 4581)
    old.start("first")
    try:
        agent, _ = fresh_agent(old, "old")
        time.sleep(3)  # Claude Code's SessionStart hook has run by now.
        record = agent_record(agent)
        view, _ = status(agent, "old fresh")
        check(record.get("claudeSessionId") is None and (view["state"], view["reason"]) == ("failed", "changed"),
              "old: a fresh Agent's status reads as a changed session (the false report)",
              claudeSessionId=record.get("claudeSessionId"), state=view["state"], reason=view["reason"])
    finally:
        old.stop()

    new = Core("new", NEW_CORE, 4582)
    new.start("first")
    try:
        agent, cwd = fresh_agent(new, "new")
        evidence["agent"] = agent
        record = agent_record(agent)
        view, servers = wait("a settled status", lambda: (lambda r: r if not any(s == "pending" for _, s in r[1]) else None)(
            status(agent, "new fresh", refresh=True)), seconds=60)
        own = native(cwd)
        evidence["observations"]["native"] = own
        names = {n for n, _ in servers}
        native_names = {s["name"] for s in own}
        check(record.get("claudeSessionId") is None and (view["state"], view["reason"]) == ("ready", "observed"),
              "new: the fresh Agent's own session is read, before Core names it",
              claudeSessionId=record.get("claudeSessionId"), state=view["state"], reason=view["reason"])
        check(native_names <= names and names - native_names <= {"yuzuno"},
              "the servers are Claude Code's own for the folder, plus Core's yuzuno server",
              listed=sorted(names), native=sorted(native_names))

        turn = ok("POST", f"/api/agents/{agent}/turns", {"text": "/context"})["turnId"]
        wait("the /context turn", lambda: (lambda d: next((t for t in d["turns"] if t["id"] == turn and t["status"] in ("completed", "failed", "interrupted")), None))(
            ok("GET", f"/api/agents/{agent}")))
        named = agent_record(agent).get("claudeSessionId")
        view, servers = status(agent, "new named")
        check(named and (view["state"], view["reason"]) == ("ready", "observed") and view.get("sessionId") == named,
              "once Core names the session, its status reads as ready for that session",
              claudeSessionId=named, sessionId=view.get("sessionId"), state=view["state"])
    finally:
        new.stop()

    new.start("restarted")
    try:
        view, servers = status(evidence["agent"], "new after restart")
        check((view["state"], view["reason"]) == ("unavailable", "not_connected"),
              "after Core restarts the Agent is not connected, and the status says so",
              state=view["state"], reason=view["reason"])
    finally:
        new.stop()

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
