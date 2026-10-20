#!/usr/bin/env python3
"""Machine-check acceptance on an isolated Core (port 4337).

  python3 acceptance/machine-checks/live.py run     # Core, machines, checks, restart, aged result
  node    acceptance/machine-checks/live-ui.mjs     # browser checks against the same Core
  python3 acceptance/machine-checks/live.py stop    # stop the lab Core, verify daily

Only this checkout's build and a lab Workspace under this folder are used.
The Mac mini is checked with the existing SSH configuration through the
read-only probe; no runtime is started or stopped there. The daily Core
(4317), its web/dist and data are compared before and after.
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
DATA, TASKS = LAB / "core-data", LAB / "tasks"
PORT = 4337
BASE = f"http://127.0.0.1:{PORT}"
STATE = HERE / "live-state.json"
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
MAC = {"target": os.environ.get("YUZUNO_SSH_TARGET", "tester@192.0.2.10"),
       "codex": os.environ.get("YUZUNO_REMOTE_CODEX", "/opt/homebrew/bin/codex"),
       "defaultCwd": os.environ.get("YUZUNO_REMOTE_CWD", "/tmp/yuzuno-lab")}


def call(method, path, body=None, timeout=90):
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


def start(state):
    TASKS.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PATH=f"{NODE_BIN}{os.pathsep}{os.environ.get('PATH', '')}")
    log = (LAB / "core.log").open("ab")
    child = subprocess.Popen(
        [str(ROOT / "target/debug/yuzuno-workspace"), "--port", str(PORT), "--data-dir", str(DATA),
         "--web-dir", str(ROOT / "web/dist"), "--cwd", str(TASKS), "--codex", str(NODE_BIN / "codex")],
        cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
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


def stop_core(state):
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
    save(state)


def harness(check, name):
    return next((h for h in check["harnesses"] if h["harness"] == name), None)


def run():
    state = load()
    if state.get("pid"):
        raise SystemExit("A lab Core is recorded as running; run stop first.")
    state = {"dailyBefore": daily(), "checks": []}
    LAB.mkdir(parents=True, exist_ok=True)
    start(state)
    ok = lambda name, passed, detail=None: state["checks"].append({"check": name, "ok": bool(passed), "detail": detail}) or \
        print(("PASS " if passed else "FAIL ") + name + ("" if passed else f" :: {detail}"))

    machines = {m["name"]: m for m in call("GET", "/api/machines")["machines"]}
    for name, body in [("Mac mini", MAC), ("Mac mini · wrong Codex path", {**MAC, "codex": "/Users/developer/no-such-codex"}),
                       ("Unreachable", {"target": "nobody@host.invalid", "codex": "codex", "defaultCwd": "/srv"})]:
        if name not in machines:
            machines[name] = call("POST", "/api/machines", {"name": name, **body})
    ids = {name: m["id"] for name, m in machines.items()}
    state["machines"] = ids
    ok("never-checked machines report no result", all(m.get("lastCheck") is None
        for m in call("GET", "/api/machines")["machines"]))
    # A local Codex agent shows up under the Core host on the page.
    agent = call("POST", "/api/agents", {"name": "Lab local agent", "cwd": str(TASKS)})
    state["agent"] = agent["id"]

    local = call("POST", "/api/machines/local/check")
    ok("Core host: reachable with real Codex found", local["reachable"] and harness(local, "codex")["found"], local)
    claude = harness(local, "claude")
    ok("Core host: Claude reported on its own", claude is not None and claude["supported"], claude)
    mac = call("POST", f"/api/machines/{ids['Mac mini']}/check")
    ok("Mac mini over existing SSH: reachable, Codex found, folder resolved",
       mac["reachable"] and harness(mac, "codex")["found"] and (mac.get("defaultFolder") or {}).get("resolved"), mac)
    wrong = call("POST", f"/api/machines/{ids['Mac mini · wrong Codex path']}/check")
    ok("Mac mini with a wrong Codex path: reachable but Codex not found",
       wrong["reachable"] and not harness(wrong, "codex")["found"] and harness(wrong, "codex").get("error"), wrong)
    gone = call("POST", f"/api/machines/{ids['Unreachable']}/check")
    ok("unreachable SSH target: recorded failure with its error", not gone["reachable"] and gone.get("error"), gone)
    state["results"] = {"local": local, "mac": mac, "wrong": wrong, "gone": gone}
    save(state)

    # Restart: results persist. While stopped, age the Mac mini's result by
    # three hours in the lab database to show how an old result is labelled.
    stop_core(state)
    db = sqlite3.connect(DATA / "workspace.sqlite")
    data = json.loads(db.execute("SELECT data FROM machine_checks WHERE machine_id=?", [ids["Mac mini"]]).fetchone()[0])
    aged = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 3 * 3600))
    data["startedAt"] = data["checkedAt"] = aged
    db.execute("UPDATE machine_checks SET data=? WHERE machine_id=?", [json.dumps(data), ids["Mac mini"]])
    db.commit()
    db.close()
    start(state)
    after = {m["id"]: m.get("lastCheck") for m in call("GET", "/api/machines")["machines"]}
    ok("after restart: every result is still there with its time",
       after["local"] == local and after[ids["Unreachable"]] == gone and after[ids["Mac mini · wrong Codex path"]] == wrong,
       {k: (v or {}).get("checkedAt") for k, v in after.items()})
    ok("after restart: the aged result keeps its old time", after[ids["Mac mini"]]["checkedAt"] == aged)
    state["agedAt"] = aged
    save(state)
    print(f"Lab Core {BASE} pid {state['pid']} — run live-ui.mjs, then stop")


def stop():
    state = load()
    stop_core(state)
    state["dailyAfter"] = daily()
    state["dailyUnchanged"] = state["dailyAfter"] == state.get("dailyBefore")
    save(state)
    print(json.dumps({"dailyUnchanged": state["dailyUnchanged"], **state["dailyAfter"]}, indent=2))


if __name__ == "__main__":
    {"run": run, "stop": stop}[sys.argv[1]]()
