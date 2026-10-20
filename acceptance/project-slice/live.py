#!/usr/bin/env python3
"""Real-model project acceptance on an isolated Core (port 4337).

  python3 acceptance/project-slice/live.py start   # lab repo + worktree, Core
  python3 acceptance/project-slice/live.py seed    # projects, Codex agents, turns
  python3 acceptance/project-slice/live.py mcp     # projects_list, archived default
  node    acceptance/project-slice/live-ui.mjs     # browser checks
  python3 acceptance/project-slice/live.py stop    # stop the lab Core, verify daily

Uses only this checkout's build, a lab Workspace under this folder and the
official Codex login. It never restarts, rebuilds or writes the daily Core
(port 4317) or its web/dist; `stop` compares them with the recorded baseline.
"""
import hashlib
import json
import os
import shutil
import signal
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
DATA, TASKS = LAB / "core-data", LAB / "tasks"
APP, HOTFIX, RESEARCH = LAB / "app", LAB / "app-hotfix", LAB / "research"
PORT = 4337
BASE = f"http://127.0.0.1:{PORT}"
STATE = HERE / "live-state.json"
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
CODEX = NODE_BIN / "codex"
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')


def call(method, path, body=None, timeout=30):
    request = urllib.request.Request(
        BASE + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
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
    return {"listener": pids.split("users:")[-1].strip() if "users:" in pids else None,
            "webDist": digest.hexdigest()}


def save(value):
    STATE.write_text(json.dumps(value, indent=2))


def load():
    return json.loads(STATE.read_text())


def git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def start():
    if STATE.exists() and load().get("pid"):
        raise SystemExit("A lab Core is recorded as running; run stop first.")
    for folder in (DATA, TASKS, RESEARCH):
        folder.mkdir(parents=True, exist_ok=True)
    if not APP.exists():
        APP.mkdir(parents=True)
        (APP / "README.md").write_text("Lab app for Yuzuno project acceptance.\n")
        git("init", "-q", "-b", "main", cwd=APP)
        git("-c", "user.name=Lab", "-c", "user.email=lab@example.invalid", "add", ".", cwd=APP)
        git("-c", "user.name=Lab", "-c", "user.email=lab@example.invalid", "commit", "-qm", "lab", cwd=APP)
        # The worktree lives outside the main folder, as `git worktree add ../x` does.
        git("worktree", "add", "-q", "-b", "hotfix", str(HOTFIX), cwd=APP)
    (RESEARCH / "TASK-SCOPE.txt").write_text("Lab research folder. Work only here.\n")
    binary = ROOT / "target/debug/yuzuno-workspace"
    env = dict(os.environ, PATH=f"{NODE_BIN}{os.pathsep}{os.environ.get('PATH', '')}")
    log = (LAB / "core.log").open("ab")
    child = subprocess.Popen(
        [str(binary), "--port", str(PORT), "--data-dir", str(DATA), "--web-dir", str(ROOT / "web/dist"),
         "--cwd", str(TASKS), "--codex", str(CODEX)],
        cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    for _ in range(100):
        try:
            call("GET", "/api/health")
            break
        except Exception:
            if child.poll() is not None:
                raise SystemExit("Lab Core exited; see lab/core.log")
            time.sleep(0.1)
    state = load() if STATE.exists() else {}
    state.update({"pid": child.pid, "baseUrl": BASE, "dailyBefore": state.get("dailyBefore") or daily()})
    save(state)
    print(f"Lab Core {BASE} pid {child.pid}")


def wait_for(agent_id, done, label, limit=240):
    deadline = time.time() + limit
    while time.time() < deadline:
        detail = call("GET", f"/api/agents/{agent_id}")
        if done(detail):
            return detail
        time.sleep(2)
    raise RuntimeError(f"Timed out waiting for {label}")


def turn_finished(detail):
    turns = detail["turns"]
    return detail["agent"]["status"] in ("idle", "error") and turns and turns[-1]["status"] != "inProgress"


def send(agent_id, text):
    return call("POST", f"/api/agents/{agent_id}/messages",
                {"clientMessageId": str(uuid.uuid4()), "text": text}, timeout=120)


def settings(agent_id, sandbox):
    detail = call("GET", f"/api/agents/{agent_id}")["agent"]
    return call("POST", f"/api/agents/{agent_id}/settings", {"model": detail["model"], "settings": {
        "reasoningEffort": "low", "approvalPolicy": "on-request", "sandbox": sandbox}})


def seed():
    state = load()
    app = call("POST", "/api/projects", {"name": "App", "defaultDirs": {"local": str(APP)}})
    research = call("POST", "/api/projects", {"name": "Research", "defaultDirs": {"local": str(RESEARCH)}})
    main = call("POST", "/api/agents", {"name": "Main", "cwd": str(APP), "projectId": app["id"]})
    hotfix = call("POST", "/api/agents", {"name": "Hotfix", "cwd": str(HOTFIX), "projectId": app["id"]})
    reader = call("POST", "/api/agents", {"name": "Reader", "cwd": str(RESEARCH), "projectId": research["id"]})
    for agent in (main, hotfix, reader):
        wait_for(agent["id"], lambda d: d["agent"].get("threadId"), f"{agent['name']} session", 120)
    settings(main["id"], "workspace-write")
    settings(hotfix["id"], "workspace-write")
    # Read-only makes a file write ask for approval: a real request elsewhere.
    settings(reader["id"], "read-only")
    state.update({"projects": {"app": app["id"], "research": research["id"]},
                  "agents": {"main": main["id"], "hotfix": hotfix["id"], "reader": reader["id"]}})
    save(state)

    send(hotfix["id"], "Run `git rev-parse --abbrev-ref HEAD` and `git rev-parse --show-toplevel`, "
         "then reply with both values on one line. Do not change any files.")
    send(main["id"], "Use your Yuzuno collaboration tools: call peers_list to find the agent named Reader, "
         "then call task_create with title 'Review the hotfix notes' and assigneeAgentId set to Reader's id. "
         "Do not pass projectId. Reply with only the task ID and the projectId shown in the result.")
    hotfix_done = wait_for(hotfix["id"], turn_finished, "Hotfix turn")
    main_done = wait_for(main["id"], turn_finished, "Main turn")
    send(reader["id"], "Create a file named note.txt in the current folder containing the word hello. "
         "If the sandbox blocks the write, request approval for it.")
    reader_waiting = wait_for(reader["id"], lambda d: d["pending"], "Reader approval request")

    tasks = call("POST", "/api/collaboration/task_list", {})["tasks"]
    created = next((t for t in tasks if t["title"] == "Review the hotfix notes"), None)
    reply = lambda d: next((i.get("text") for i in reversed(d["turns"][-1]["items"])
                            if i.get("type") == "agentMessage"), None)
    workspace = call("GET", "/api/workspace")
    state["seed"] = {
        "hotfixReply": reply(hotfix_done),
        "mainReply": reply(main_done),
        "task": created,
        "readerPending": [{"method": p["method"], "stale": p.get("stale")} for p in reader_waiting["pending"]],
        "members": {a["name"]: a.get("projectId") for a in workspace["agents"]},
        "checks": {
            "worktreeAgentInApp": workspace and next(a for a in workspace["agents"] if a["name"] == "Hotfix").get("projectId") == app["id"],
            "taskDefaultsToCreatorsProject": bool(created) and created["projectId"] == app["id"],
            "taskAssignedAcrossProjects": bool(created) and created.get("assigneeAgentId") == reader["id"],
            "realApprovalInResearch": bool(reader_waiting["pending"]),
        },
    }
    save(state)
    print(json.dumps(state["seed"], indent=2))


def mcp():
    """Real Codex MCP calls: projects_list, and a task from an archived project."""
    state = load()
    main, hotfix, app = state["agents"]["main"], state["agents"]["hotfix"], state["projects"]["app"]
    reply = lambda d: next((i.get("text") for i in reversed(d["turns"][-1]["items"])
                            if i.get("type") == "agentMessage"), None)
    send(main, "Call the Yuzuno projects_list tool and reply with only its JSON result.")
    listed = reply(wait_for(main, turn_finished, "Main projects_list"))
    archive = call("POST", "/api/projects", {"name": f"Archive test {uuid.uuid4().hex[:6]}"})
    call("POST", f"/api/agents/{hotfix}/project", {"projectId": archive["id"]})
    call("PATCH", f"/api/projects/{archive['id']}", {"archived": True})
    send(hotfix, "Call the Yuzuno task_create tool with title 'Archived project check' and no projectId. "
         "Reply with only the task's projectId value and the projectNotice code from the result.")
    archived_reply = reply(wait_for(hotfix, turn_finished, "Hotfix archived task"))
    tasks = call("POST", "/api/collaboration/task_list", {})["tasks"]
    task = [t for t in tasks if t["title"] == "Archived project check"][-1]
    # Put Hotfix back in App for the browser checks.
    call("PATCH", f"/api/projects/{archive['id']}", {"archived": False})
    call("POST", f"/api/agents/{hotfix}/project", {"projectId": app})
    call("PATCH", f"/api/projects/{archive['id']}", {"archived": True})
    state["mcpCheck"] = {"projectsListReply": listed, "archivedReply": archived_reply,
                         "archivedTaskProjectId": task["projectId"],
                         "checks": {"projectsListIncludesArchivedFlag": '"archived"' in (listed or ""),
                                    "archivedDefaultIsNoProject": task["projectId"] is None}}
    save(state)
    print(json.dumps(state["mcpCheck"], indent=2))


def stop():
    state = load()
    pid = state.get("pid")
    if pid:
        try:
            os.kill(pid, signal.SIGINT)
            for _ in range(100):
                if not Path(f"/proc/{pid}").exists() or "zombie" in Path(f"/proc/{pid}/status").read_text():
                    break
                time.sleep(0.1)
        except ProcessLookupError:
            pass
    state["pid"] = None
    state["dailyAfter"] = daily()
    state["dailyUnchanged"] = state["dailyAfter"] == state.get("dailyBefore")
    save(state)
    print(json.dumps({"dailyUnchanged": state["dailyUnchanged"], **state["dailyAfter"]}, indent=2))


if __name__ == "__main__":
    {"start": start, "seed": seed, "mcp": mcp, "stop": stop}[sys.argv[1]]()
