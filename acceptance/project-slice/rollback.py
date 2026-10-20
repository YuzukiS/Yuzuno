#!/usr/bin/env python3
"""Rollback check for project membership with real Core binaries.

new Core creates projects, members and tasks -> an older Core (without
projects) edits a task and deletes a closed Agent -> the new Core reopens.
Uses a temporary Workspace and a non-functional Codex path; it never touches
the daily Workspace or starts a model.

  python3 acceptance/project-slice/rollback.py --new target/debug/yuzuno-workspace \
      --old /tmp/yuzuno-old-target/debug/yuzuno-workspace
"""
import argparse
import json
import signal
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--new", required=True)
parser.add_argument("--old", required=True)
parser.add_argument("--port", type=int, default=4341)
parser.add_argument("--out", default=str(Path(__file__).with_name("rollback-result.json")))
args = parser.parse_args()

root = Path(tempfile.mkdtemp(prefix="yuzuno-rollback-"))
data, web = root / "data", root / "web"
app, worktree, research = root / "app", root / "app-hotfix", root / "research"
for folder in (web, app, worktree, research):
    folder.mkdir(parents=True)
base = f"http://127.0.0.1:{args.port}"
checks = []


def check(name, ok, detail=None):
    checks.append({"check": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" :: {detail}"))


def call(method, path, body=None):
    request = urllib.request.Request(
        base + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Yuzuno-Client": "desktop"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{method} {path}: {error.code} {error.read().decode()}") from None


def collab(operation, body):
    return call("POST", f"/api/collaboration/{operation}", body)


class Core:
    def __init__(self, binary, label):
        self.label = label
        log = open(root / f"{label}.log", "w")
        self.process = subprocess.Popen(
            [binary, "--port", str(args.port), "--data-dir", str(data), "--cwd", str(app),
             "--web-dir", str(web), "--codex", "/bin/false"],
            stdout=log, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                call("GET", "/api/health")
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError(f"{label} Core did not start; see {root / (label + '.log')}")

    def stop(self):
        self.process.send_signal(signal.SIGINT)
        self.process.wait(timeout=20)


def db():
    connection = sqlite3.connect(data / "workspace.sqlite")
    return connection


# 1. New Core: explicit projects, members and tasks.
core = Core(args.new, "new-1")
p_app = call("POST", "/api/projects", {"name": "App", "defaultDirs": {"local": str(app)}})["id"]
p_res = call("POST", "/api/projects", {"name": "Research"})["id"]
main = call("POST", "/api/agents", {"name": "Main", "cwd": str(app), "projectId": p_app})["id"]
hotfix = call("POST", "/api/agents", {"name": "Hotfix", "cwd": str(worktree), "projectId": p_app})["id"]
reader = call("POST", "/api/agents", {"name": "Reader", "cwd": str(research), "projectId": p_res})["id"]
loose = call("POST", "/api/agents", {"name": "Loose", "cwd": str(research)})["id"]
time.sleep(1.0)  # let the failing background start-ups settle before closing
t1 = collab("task_create", {"requestId": "rb-1", "title": "Ship", "projectId": p_app})["task"]
t2 = collab("task_create", {"requestId": "rb-2", "title": "Read", "projectId": p_res,
                            "assigneeAgentId": hotfix})["task"]
call("POST", f"/api/agents/{reader}/close")
workspace = call("GET", "/api/workspace")
members = {a["id"]: a.get("projectId") for a in workspace["agents"]}
check("new: external worktree agent is in the same project", members[hotfix] == p_app, members)
check("new: cross-project assignment keeps the task's project", t2["projectId"] == p_res, t2)
with db() as connection:
    before = dict(connection.execute("SELECT agent_id,project_id FROM project_agents"))
check("new: the closed Agent still has its link before the old Core runs", before.get(reader) == p_res, before)
core.stop()

# 2. Older Core, which knows nothing about projects.
core = Core(args.old, "old")
listed = collab("task_list", {})["tasks"]
check("old: opens the Workspace and lists both tasks", len(listed) == 2, [t["id"] for t in listed])
updated = collab("task_update", {"requestId": "rb-old-1", "taskId": t1["id"], "expectedVersion": 1,
                                 "patch": {"title": "Ship v2", "status": "doing"}})["task"]
check("old: edits a task", updated["title"] == "Ship v2", updated)
call("DELETE", f"/api/agents/{reader}")
core.stop()

with db() as connection:
    links = dict(connection.execute("SELECT agent_id,project_id FROM project_agents"))
    task_links = dict(connection.execute("SELECT task_id,project_id FROM project_tasks"))
    task_ids = dict(connection.execute("SELECT seq,id FROM collaboration_tasks"))
    raw_agents = [json.loads(r[0]) for r in connection.execute("SELECT data FROM agents")]
check("after old: closed Agent's link removed by cascade", reader not in links, links)
check("after old: remaining memberships kept", links.get(main) == p_app and links.get(hotfix) == p_app, links)
check("after old: task links kept", task_links.get(task_ids[1]) == p_app and task_links.get(task_ids[2]) == p_res, task_links)
check("after old: Agent JSON never carried membership", all("projectId" not in a["agent"] for a in raw_agents))

# A manual edit with foreign keys off leaves an orphan behind.
connection = db()
connection.execute("PRAGMA foreign_keys=OFF")
connection.execute("INSERT INTO project_agents(agent_id,project_id,assigned_at) VALUES('ghost',?,'manual')", [p_app])
connection.commit()
connection.close()

# 3. New Core again.
core = Core(args.new, "new-2")
workspace = call("GET", "/api/workspace")
members = {a["id"]: a.get("projectId") for a in workspace["agents"]}
check("reopen: memberships intact", members.get(main) == p_app and members.get(hotfix) == p_app and members.get(loose) is None, members)
check("reopen: deleted Agent absent", reader not in members, list(members))
app_tasks = collab("task_list", {"projectId": p_app})
check("reopen: old edit visible in its project", [t["title"] for t in app_tasks["tasks"]] == ["Ship v2"]
      and app_tasks["counts"]["doing"] == 1, app_tasks)
research_tasks = collab("task_list", {"projectId": p_res})["tasks"]
check("reopen: cross-project task still assigned", research_tasks and research_tasks[0]["assigneeAgentId"] == hotfix, research_tasks)
moved = collab("task_update", {"requestId": "rb-new-1", "taskId": t1["id"], "expectedVersion": updated["version"],
                               "patch": {"projectId": None}})["task"]
check("reopen: project changes still share the version check", moved["projectId"] is None
      and moved["version"] == updated["version"] + 1, moved)
core.stop()
with db() as connection:
    ghost = connection.execute("SELECT COUNT(*) FROM project_agents WHERE agent_id='ghost'").fetchone()[0]
check("reopen: migration reran and swept the orphan", ghost == 0, ghost)

result = {"workspace": str(root), "passed": all(c["ok"] for c in checks), "checks": checks,
          "binaries": {"new": args.new, "old": args.old}}
Path(args.out).write_text(json.dumps(result, indent=2))
print(("ALL PASSED" if result["passed"] else "FAILED") + f" -> {args.out}")
raise SystemExit(0 if result["passed"] else 1)
