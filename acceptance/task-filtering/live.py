#!/usr/bin/env python3
"""Task-board filtering acceptance on an isolated Core (port 4393).

  python3 acceptance/task-filtering/live.py run    # Core, 210 tasks, server-side checks
  node    acceptance/task-filtering/live-ui.mjs    # one headless Chromium against it
  python3 acceptance/task-filtering/live.py stop   # stop the lab Core, verify daily

Uses this checkout's build and a lab Workspace under this folder. Agents are
records only (`--codex /bin/false`): no model or Codex process does work.
The daily Core (4317), its web/dist and data are compared before and after.
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
LAB = HERE / "lab"
PORT = 4393
BASE = f"http://127.0.0.1:{PORT}"
STATE = HERE / "live-state.json"
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
OPEN = ["todo", "doing", "blocked", "review"]


def call(method, path, body=None):
    request = urllib.request.Request(
        BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Yuzuno-Client": "desktop"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=60) as response:
            return json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{method} {path}: {error.code} {error.read().decode()}") from None


def collab(operation, body):
    return call("POST", f"/api/collaboration/{operation}", body)


def daily():
    pids = subprocess.run(["ss", "-ltnp", "sport = :4317"], text=True, capture_output=True).stdout
    digest = hashlib.sha256()
    for path in sorted(DAILY_DIST.rglob("*")):
        if path.is_file():
            digest.update(str(path.relative_to(DAILY_DIST)).encode() + path.read_bytes())
    return {"listener": pids.split("users:")[-1].strip() if "users:" in pids else None, "webDist": digest.hexdigest()}


def save(state):
    STATE.write_text(json.dumps(state, indent=2))


def run():
    if STATE.exists() and json.loads(STATE.read_text()).get("pid"):
        raise SystemExit("A lab Core is recorded as running; run stop first.")
    (LAB / "tasks").mkdir(parents=True, exist_ok=True)
    state = {"dailyBefore": daily(), "checks": []}
    log = (LAB / "core.log").open("ab")
    child = subprocess.Popen(
        [str(ROOT / "target/debug/yuzuno-workspace"), "--port", str(PORT), "--data-dir", str(LAB / "core-data"),
         "--web-dir", str(ROOT / "web/dist"), "--cwd", str(LAB / "tasks"), "--codex", "/bin/false"],
        cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    for _ in range(100):
        try:
            call("GET", "/api/health")
            break
        except Exception:
            if child.poll() is not None:
                raise SystemExit("Lab Core exited; see lab/core.log")
            time.sleep(0.1)
    state["pid"] = child.pid
    save(state)
    ok = lambda name, passed, detail=None: state["checks"].append({"check": name, "ok": bool(passed), "detail": detail}) or \
        print(("PASS " if passed else "FAIL ") + name + ("" if passed else f" :: {detail}"))

    mori = call("POST", "/api/agents", {"name": "Mori", "cwd": str(LAB / "tasks")})["id"]
    hana = call("POST", "/api/agents", {"name": "Hana", "cwd": str(LAB / "tasks")})["id"]
    app = call("POST", "/api/projects", {"name": "App"})["id"]
    owned, expected_mori = 0, []
    # 210 tasks: Mori owns 137 open ones spread across all pages; Hana owns
    # exactly one, at #140; the rest are done, cancelled or unassigned.
    for n in range(1, 211):
        body = {"requestId": f"seed-{n}", "title": f"Seed task {n}", "projectId": app if n % 5 == 0 else None}
        if n == 140:
            body.update(status="doing", assigneeAgentId=hana)
        elif owned < 137 and n % 3 != 0:
            body.update(status=OPEN[n % 4], assigneeAgentId=mori)
            owned += 1
        else:
            body.update(status=["done", "cancelled", "todo"][n % 3])
        task = collab("task_create", body)["task"]
        if body.get("assigneeAgentId") == mori:
            expected_mori.append(task["id"])
    state.update({"agents": {"mori": mori, "hana": hana}, "project": app, "expectedMori": expected_mori})
    hana_page = collab("task_list", {"statuses": OPEN, "assigneeAgentId": hana, "limit": 100})
    ok("Core: Hana's only task (#140) is on the first page", [t["id"] for t in hana_page["tasks"]] == ["T-140"], hana_page["counts"])
    first = collab("task_list", {"statuses": OPEN, "assigneeAgentId": mori, "limit": 100})
    second = collab("task_list", {"statuses": OPEN, "assigneeAgentId": mori, "limit": 100, "afterSeq": first["nextAfterSeq"]})
    seen = [t["id"] for t in first["tasks"] + second["tasks"]]
    ok("Core: 137 open tasks for Mori over two pages, once each", seen == expected_mori and not second["hasMore"],
       {"first": len(first["tasks"]), "second": len(second["tasks"])})
    ok("Core: the old single status filter still works", all(t["status"] == "done" for t in collab("task_list", {"status": "done"})["tasks"]))
    save(state)
    print(f"Lab Core {BASE} pid {child.pid} — run live-ui.mjs, then stop")


def stop():
    state = json.loads(STATE.read_text())
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
    {"run": run, "stop": stop}[sys.argv[1]]()
