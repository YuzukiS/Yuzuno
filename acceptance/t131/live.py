#!/usr/bin/env python3
"""T-131 acceptance: an Agent of another project, with no checkout of this
repository and no yuzuno skill on disk, finds Yuzuno's working guide through
the connected Core and reads it; that Core serves it without its source tree.

  YUZUNO_LAB_CORE=<candidate Core binary> python3 acceptance/t131/live.py <lab name>

The lab folder is ~/.t131-lab/<lab name>, outside any checkout. The candidate
Core runs from a copy in <lab>/install with the runtimes it needs beside it,
like a managed release, inside bubblewrap with the source checkout hidden:
nothing of this repository is readable while it serves the guide. The hidden
root defaults to the common Git checkout; YUZUNO_LAB_HIDE_ROOT can name it
explicitly when the repository has a separate Git directory.
It listens on its own port with its own data; the daily Core is never used.

Checks, in <lab>/evidence.json:
  install   the sandbox cannot see the repository; the Core starts from the copy
  direct    MCP initialize instructions and tools/list name yuzuno_guide; the
            overview and the jobs topic answer with this Core's identity and a
            revision equal to the SHA-256 the lab computes from the sources
            (no model turn)
  claude    one real Claude (Sonnet) turn, normal login: it calls
            mcp__yuzuno__yuzuno_guide, completed, with that revision, and no
            tool reads a yuzuno skill file
  codex     one real Codex turn, normal login: the same, as an mcpToolCall

The prompt asks how to wait for a Job here and to quote the guide revision; it
does not name the tool. Every native permission request is denied: Yuzuno's
tools are pre-approved and nothing else is needed.
"""
import hashlib
import json
import os
import shutil
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
REPO = (Path(os.environ["YUZUNO_LAB_HIDE_ROOT"]).resolve()
        if os.environ.get("YUZUNO_LAB_HIDE_ROOT") else
        (ROOT / subprocess.check_output(
            ["git", "rev-parse", "--git-common-dir"], cwd=ROOT, text=True
        ).strip()).resolve().parent)
if not ROOT.is_relative_to(REPO):
    raise ValueError("YUZUNO_LAB_HIDE_ROOT must contain the source checkout")
CORE = Path(os.environ["YUZUNO_LAB_CORE"]).resolve()
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
PORT = 4561
LAB = Path.home() / ".t131-lab" / sys.argv[1]
if LAB.is_relative_to(REPO):
    raise ValueError("The lab folder must stay outside the hidden source root")
LAB.mkdir(parents=True)
INSTALL, DATA, PROJECT = LAB / "install", LAB / "data", LAB / "other-project"
BASE = f"http://127.0.0.1:{PORT}"
SKILL = ROOT / ".agents/skills/yuzuno"
PROMPT = ("In this Yuzuno Workspace, after I submit a Job, how should I wait for its result? Answer from this "
          "Core's own working guidance, in two sentences, and end with the line 'guide revision: <first 12 "
          "characters of the guide revision you read>'.")
evidence = {"lab": str(LAB), "checks": [], "turns": {}, "core": {}}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def check(condition, text, **facts):
    evidence["checks"].append({"ok": bool(condition), "check": text, **facts})
    print(("PASS " if condition else "FAIL ") + text, flush=True)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def expected_revision():
    """guide::revision, computed here from the sources the candidate compiled."""
    h = hashlib.sha256()
    for name, path in [("SKILL.md", SKILL / "SKILL.md")] + [
            (n, SKILL / "references" / n) for n in ["jobs.md", "delivery.md", "rewind.md", "maintenance.md"]]:
        h.update(name.encode() + b"\0" + path.read_bytes() + b"\0")
    return h.hexdigest()


def call(method, path, body=None, timeout=60):
    request = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", "x-yuzuno-client": "desktop"})
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode(errors="replace")


def ok(method, path, body=None):
    status, value = call(method, path, body)
    if status != 200:
        raise SystemExit(f"{method} {path}: {status} {value}")
    return value


def install():
    """The Core copy and the runtimes it reads, as a release ships them."""
    (INSTALL / "bin").mkdir(parents=True)
    shutil.copy2(CORE, INSTALL / "bin/yuzuno-workspace")
    claude = INSTALL / "runtimes/claude"
    shutil.copytree(ROOT / "runtimes/claude", claude, ignore=shutil.ignore_patterns("node_modules", "*.test.mjs"))
    subprocess.run([str(NODE_BIN / "npm"), "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=claude, check=True,
                   env={**os.environ, "PATH": f"{NODE_BIN}:/usr/bin:/bin"}, stdout=subprocess.DEVNULL)
    shutil.copytree(ROOT / "runtimes/result-validator", INSTALL / "runtimes/result-validator")
    evidence["core"]["binary"] = {"source": str(CORE), "sha256": digest(CORE), "copy": str(INSTALL / "bin/yuzuno-workspace")}
    evidence["core"]["bridgeSha256"] = digest(claude / "bridge.mjs")


def sandbox(command):
    """bubblewrap: the system read-only, the home folder writable for the
    native runtimes' own state, and the repository replaced by an empty
    folder (bound last, so it wins)."""
    args = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
            "--bind", "/tmp", "/tmp", "--bind", f"/run/user/{os.getuid()}", f"/run/user/{os.getuid()}",
            "--bind", str(Path.home()), str(Path.home()), "--tmpfs", str(REPO)]
    return args + ["--die-with-parent", "--"] + command


USER_STATE = [Path.home() / ".claude/settings.json", Path.home() / ".codex/config.toml"]
USER_SKILLS = [Path.home() / ".claude/skills/yuzuno", Path.home() / ".agents/skills/yuzuno", Path.home() / ".codex/skills/yuzuno"]


def start():
    DATA.mkdir()
    (LAB / "core-work").mkdir()
    PROJECT.mkdir()
    (PROJECT / "NOTES.md").write_text("A project unrelated to Yuzuno's source.\n")
    seen = subprocess.run(sandbox(["sh", "-c", 'test -e "$1/.agents" && echo seen || echo hidden; ls -A "$1" | wc -l',
                                   "check-hidden-source", str(REPO)]),
                          capture_output=True, text=True)
    check(seen.stdout.split() == ["hidden", "0"], "inside the sandbox the repository is empty", sandbox=seen.stdout.split())
    env = {"HOME": str(Path.home()), "PATH": f"{NODE_BIN}:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
           "YUZUNO_CLAUDE_BRIDGE": str(INSTALL / "runtimes/claude/bridge.mjs"),
           "YUZUNO_RESULT_VALIDATOR": str(INSTALL / "runtimes/result-validator/validator.mjs")}
    log = (LAB / "core.log").open("ab")
    child = subprocess.Popen(sandbox([str(INSTALL / "bin/yuzuno-workspace"), "--port", str(PORT), "--data-dir", str(DATA),
                                      "--cwd", str(LAB / "core-work"), "--codex", str(NODE_BIN / "codex")]),
                             cwd=LAB, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    for _ in range(300):
        try:
            if call("GET", "/api/health", timeout=2)[0] == 200:
                break
        except OSError:
            pass
        if child.poll() is not None:
            raise SystemExit("the lab Core exited; see core.log")
        time.sleep(0.2)
    evidence["core"]["pid"] = child.pid
    return child


def stop(child):
    try:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=20)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=10)


def token(agent):
    db = sqlite3.connect(f"file:{DATA / 'workspace.sqlite'}?mode=ro", uri=True)
    row = db.execute("SELECT value FROM workspace_meta WHERE key=?", [f"collaboration.mcp.agent.{agent}"]).fetchone()
    db.close()
    return row[0] if row else None


def mcp(agent, method, params, session=None):
    """One MCP request to the lab Core as that Agent; the token stays in memory."""
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
               "Authorization": f"Bearer {token(agent)}"}
    if session:
        headers["Mcp-Session-Id"] = session
    request = urllib.request.Request(f"{BASE}/mcp/{agent}", method="POST", headers=headers,
                                     data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode())
    with opener.open(request, timeout=30) as response:
        raw = response.read().decode()
        session = response.headers.get("Mcp-Session-Id") or session
    lines = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")] or [raw]
    return json.loads(lines[-1])["result"], session


def direct(agent):
    initialized, session = mcp(agent, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                                     "clientInfo": {"name": "t131-lab", "version": "1"}})
    check("yuzuno_guide" in initialized.get("instructions", ""), "MCP server instructions name yuzuno_guide",
          instructions=initialized.get("instructions", "")[:600])
    tools = [tool["name"] for tool in mcp(agent, "tools/list", {}, session)[0]["tools"]]
    check("yuzuno_guide" in tools, "tools/list has yuzuno_guide", tools=tools)
    answers = {}
    for topic in [None, "jobs", "stages"]:
        arguments = {} if topic is None else {"topic": topic}
        result = mcp(agent, "tools/call", {"name": "yuzuno_guide", "arguments": arguments}, session)[0]
        answers[topic or "overview"] = {"isError": result.get("isError"), "structured": result.get("structuredContent")}
    overview, jobs, unknown = answers["overview"]["structured"], answers["jobs"]["structured"], answers["stages"]
    revision = expected_revision()
    check(overview["revision"] == revision and jobs["revision"] == revision,
          "the answers' revision is the SHA-256 of the compiled sources", revision=overview["revision"], expected=revision)
    check(overview["core"]["releaseId"] == "development" and overview["core"]["managed"] is False,
          "an unmanaged lab Core names itself development", core=overview["core"])
    check(len(overview["topics"]) == 9 and overview["guide"].startswith("# Working in a Yuzuno Workspace"),
          "the overview lists the topics", topics=[t["topic"] for t in overview["topics"]])
    check("## Runs of stages" in jobs["guide"] and "Do not poll" not in overview["guide"],
          "the jobs topic is its own part", length=len(jobs["guide"]))
    check(unknown["isError"] is True and "topic is one of" in unknown["structured"]["error"],
          "an unknown topic is an error naming the topics", error=unknown["structured"]["error"])
    evidence["direct"] = {"tools": tools, "overviewLength": len(overview["guide"]), "jobsLength": len(jobs["guide"])}
    return revision


def deny(d):
    for request in d["pending"]:
        if not request.get("stale") and not request["params"].get("_responseSent"):
            evidence.setdefault("denied", []).append(request["method"])
            call("POST", f"/api/requests/{request['id']}/respond",
                 {"response": {"decision": "deny", "message": "Not needed for this lab."}})


def run_turn(agent, name, seconds=420):
    turn_id = ok("POST", f"/api/agents/{agent}/turns", {"text": PROMPT})["turnId"]
    deadline = time.time() + seconds
    while time.time() < deadline:
        d = ok("GET", f"/api/agents/{agent}")
        t = next((t for t in d["turns"] if t["id"] == turn_id), None)
        if d["agent"]["status"] == "idle" and t and t.get("status") in ("completed", "failed", "interrupted"):
            break
        deny(d)
        time.sleep(0.5)
    else:
        raise SystemExit(f"turn {name} timed out")
    time.sleep(1)
    t = next(t for t in ok("GET", f"/api/agents/{agent}")["turns"] if t["id"] == turn_id)
    # Every item as Core holds it, so the checks can be read again from the record.
    evidence["turns"][name] = {"turnId": turn_id, "status": t["status"], "items": t["items"]}
    return t


def text_of(item):
    return item.get("text") or "".join(c.get("text", "") for c in item.get("content", []) if isinstance(c, dict))


def judge(name, t, revision, guide_calls, file_reads):
    reply = "\n".join(text_of(i) for i in t["items"] if i.get("type") == "agentMessage")
    evidence["turns"][name]["reply"] = reply[-3000:]
    check(t["status"] == "completed", f"{name}: the turn completed", status=t["status"])
    check(len(guide_calls) >= 1, f"{name}: it called yuzuno_guide", calls=guide_calls)
    check(f"guide revision: {revision[:12]}" in reply.lower(), f"{name}: it quotes the revision it read", tail=reply[-300:])
    check(not file_reads, f"{name}: no tool read a yuzuno skill file", reads=file_reads)


def lab():
    before = {str(path): digest(path) for path in USER_STATE if path.exists()}
    check(not any(os.path.lexists(path) for path in USER_SKILLS), "no yuzuno skill in the user skill folders",
          looked=[str(path) for path in USER_SKILLS])
    install()
    child = start()
    try:
        project = ok("POST", "/api/projects", {"name": "t131-other-project", "defaultDirs": {"local": str(PROJECT)}})["id"]
        agents = {}
        for harness, model in [("claude", "sonnet"), ("codex", None)]:
            body = {"name": f"t131-{harness}", "harness": harness, "cwd": str(PROJECT), "projectId": project}
            if model:
                body["model"] = model
            agents[harness] = ok("POST", "/api/agents", body)["id"]
        ok("POST", f"/api/agents/{agents['claude']}/settings", {"model": "sonnet", "permissionMode": "default"})
        # The claude turn attaches its Agent; then the MCP credential exists for the direct checks.
        claude = run_turn(agents["claude"], "claude")
        revision = direct(agents["claude"])
        uses = [i for i in claude["items"] if i.get("type") == "claudeToolUse"]
        judge("claude", claude, revision,
              [{"name": i.get("name"), "status": i.get("status")} for i in uses
               if i.get("name") == "mcp__yuzuno__yuzuno_guide" and i.get("status") != "failed"],
              [i.get("input") for i in uses if "skills/yuzuno" in json.dumps(i.get("input"))])
        codex = run_turn(agents["codex"], "codex")
        items = codex["items"]
        judge("codex", codex, revision,
              [{"tool": i.get("tool"), "status": i.get("status")} for i in items
               if i.get("type") == "mcpToolCall" and i.get("server") == "yuzuno" and i.get("tool") == "yuzuno_guide"
               and i.get("status") == "completed"],
              [i.get("command") for i in items if "skills/yuzuno" in json.dumps(i.get("command"))])
    finally:
        stop(child)
        after = {str(path): digest(path) for path in USER_STATE if path.exists()}
        check(after == before, "user settings and Codex config are unchanged", files=list(before))
        evidence["passed"] = all(c["ok"] for c in evidence["checks"])
        (LAB / "evidence.json").write_text(json.dumps(evidence, indent=2))
    print(f"evidence: {LAB / 'evidence.json'} passed={evidence['passed']}")
    sys.exit(0 if evidence["passed"] else 1)


if __name__ == "__main__":
    lab()
