#!/usr/bin/env python3
"""T-39: a read-only recheck of a finished lab's decline, with no Agent Turn.

  YUZUNO_LAB_CORE=<candidate Core> YUZUNO_LAB_WEB=<candidate web/dist> \\
    python3 acceptance/t39-task-status/recheck.py <lab folder>

Starts the candidate Core again on the lab's own data, opens the declined
proposal (browser.mjs declined), and checks:
- the page shows the decline and offers nothing more;
- Core still has the decline as the proposal's only decision;
- T-2 is unchanged.
It appends to <lab>/recheck.json. The daily Core is never touched.
"""
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAB = Path(sys.argv[1]).resolve()
CORE, WEB = Path(os.environ["YUZUNO_LAB_CORE"]), Path(os.environ["YUZUNO_LAB_WEB"])
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
PORT, BASE = 4598, "http://127.0.0.1:4598"
ENV = {"HOME": str(Path.home()), "PATH": f"{NODE_BIN}:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
       "YUZUNO_CLAUDE_BRIDGE": str(HERE.parents[1] / "runtimes/claude/bridge.mjs"), "YUZUNO_NODE": str(NODE_BIN / "node")}
checks = []


def check(ok, claim, **facts):
    checks.append({"ok": bool(ok), "check": claim, **facts})
    print(("PASS " if ok else "FAIL ") + claim, json.dumps(facts, ensure_ascii=False)[:600], flush=True)


db = sqlite3.connect(f"file:{LAB}/core-data/workspace.sqlite?mode=ro", uri=True)
agent = db.execute("SELECT id FROM agents").fetchone()[0]
db.close()
import urllib.request
log = (LAB / "recheck-core.log").open("ab")
child = subprocess.Popen([str(CORE), "--port", str(PORT), "--data-dir", str(LAB / "core-data"), "--cwd", str(LAB / "core-work"),
                          "--web-dir", str(WEB), "--codex", str(NODE_BIN / "codex")],
                         cwd=LAB, env=ENV, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    get = lambda path: json.loads(opener.open(urllib.request.Request(BASE + path, headers={"X-Yuzuno-Client": "desktop"}), timeout=10).read())
    post = lambda path, body: json.loads(opener.open(urllib.request.Request(BASE + path, data=json.dumps(body).encode(), method="POST",
                                         headers={"X-Yuzuno-Client": "desktop", "Content-Type": "application/json"}), timeout=10).read())
    for _ in range(120):
        try:
            get("/api/health")
            break
        except OSError:
            time.sleep(0.5)
    out = subprocess.run([str(NODE_BIN / "node"), str(HERE / "browser.mjs"), BASE, agent, "declined", str(LAB / "screenshots")],
                         capture_output=True, text=True, timeout=300, env=ENV)
    (LAB / "browser-declined.log").write_text(out.stdout + out.stderr)
    seen = json.loads(out.stdout.strip().splitlines()[-1]) if out.returncode == 0 else {"error": out.stderr[-1500:]}
    check("declined it. T-2 was not changed by this proposal." in seen.get("declined", {}).get("text", "") and seen["declined"]["buttons"] == []
          and not seen.get("errors"), "browser (recheck): the declined proposal shows the decline and offers nothing more", seen=seen)
    narrow = seen.get("narrow", {})
    check(narrow.get("theme") == "dark" and narrow.get("overflow") is False and narrow.get("fits") and narrow.get("styled"),
          "browser (recheck): dark, 390 px wide, styled, without overflow", narrow=narrow)
    turns = get(f"/api/agents/{agent}")["turns"]
    result = turns[-1]["_yuzunoResults"][-1]["id"]
    view = get(f"/api/results/{result}/task-status")
    two = post("/api/collaboration/task_get", {"taskId": "T-2"})["task"]
    check([a["state"] for a in view["attempts"]] == ["declined"] and view["proposal"]["taskId"] == "T-2" and two["status"] == "todo" and two["version"] == 1,
          "Core (recheck): the decline is the proposal's only decision; T-2 is unchanged",
          attempts=view["attempts"], t2={k: two[k] for k in ("status", "version")})
finally:
    os.killpg(child.pid, signal.SIGTERM)
    child.wait(timeout=20)
report = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "core": str(CORE), "checks": checks,
          "failed": [c["check"] for c in checks if not c["ok"]]}
previous = json.loads((LAB / "recheck.json").read_text()) if (LAB / "recheck.json").exists() else []
(LAB / "recheck.json").write_text(json.dumps(previous + [report], ensure_ascii=False, indent=2))
sys.exit(1 if report["failed"] else 0)
