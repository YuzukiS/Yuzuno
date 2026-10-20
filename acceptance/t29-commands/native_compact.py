#!/usr/bin/env python3
"""T-29 acceptance: /compact runs each Harness's own compaction.

  YUZUNO_LAB_CORE=<candidate Core binary> YUZUNO_LAB_WEB=<candidate web/dist> \
    python3 acceptance/t29-commands/native_compact.py <empty lab folder> [codex|claude ...]

Naming one Harness runs only that one, so a run that stopped before any model
call for the other is completed without repeating the calls already made.

One lab Core with its own data and port, never the daily one. One short-lived
Codex Agent and one Claude Agent, each in an empty folder outside any checkout
(~/.t29-lab/<lab parent>-<lab name>-<harness>), with the installed CLIs and their normal
login. Each Agent gets one tiny turn to have a history, then one /compact:

  codex   Core's /compact endpoint asks Codex itself (thread/compact/start).
          Its answer only accepts; a second /compact at once is refused
          without reaching Codex. The compaction is judged by Codex's own
          turn: its status and a contextCompaction item, never by wording.
  claude  /compact is sent as the message it is in the composer; Claude Code
          runs it as its own command. Judged by that turn's status and items.

Model calls are counted apart: one history turn and one compaction per
Harness (a compaction itself calls the model). Nothing is retried; a run that
fails, or whose outcome is unknown, is kept as it is in <lab>/evidence.json.
The lab answers no permission request: none of this needs one.
"""
import json
import os
import shutil
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
# The folder of the node, codex and claude this machine runs (on PATH).
NODE_BIN = Path(os.environ.get("YUZUNO_LAB_NODE_BIN") or Path(shutil.which("node") or "node").parent)
PORT = 4572
LAB = Path(sys.argv[1]).resolve()
ONLY = set(sys.argv[2:]) or {"codex", "claude"}
LAB.mkdir(parents=True)
BASE = f"http://127.0.0.1:{PORT}"
evidence = {"lab": str(LAB), "checks": [], "observations": {}, "modelCalls": {}}
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


class Core:
    def start(self):
        log = (LAB / "core.log").open("ab")
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
                    return
            except OSError:
                pass
            if self.child.poll() is not None:
                raise SystemExit("Lab Core exited; see its log")
            time.sleep(0.2)
        raise SystemExit("Lab Core did not answer")

    def stop(self):
        try:
            os.killpg(self.child.pid, signal.SIGTERM)
            self.child.wait(timeout=20)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            os.killpg(self.child.pid, signal.SIGKILL)
            self.child.wait(timeout=10)


def detail(agent):
    return ok("GET", f"/api/agents/{agent}")


def wait(agent, ready, what, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        d = detail(agent)
        if ready(d):
            return d
        time.sleep(0.5)
    evidence["observations"][f"timeout {what}"] = {"status": detail(agent)["agent"]["status"]}
    raise SystemExit(f"Timed out waiting for {what}")


def settled(d):
    return d["agent"]["status"] in ("idle", "error") and not any(t.get("status") == "inProgress" for t in d["turns"])


def summary(t):
    return {"status": t.get("status"), "error": t.get("error"),
            "items": [{"type": i.get("type"), "status": i.get("status")} for i in t.get("items", [])]}


def agent(harness):
    folder = Path.home() / ".t29-lab" / f"{LAB.parent.name}-{LAB.name}-{harness}"
    folder.mkdir(parents=True)
    created = ok("POST", "/api/agents", {"name": f"t29-{harness}", "harness": harness, "cwd": str(folder), "model": ""})
    return created["id"]


def history(agent_id, harness):
    """One tiny turn, so there is something to compact."""
    turn = ok("POST", f"/api/agents/{agent_id}/turns", {"text": "Reply with the single word OK."})["turnId"]
    evidence["modelCalls"][f"{harness} history turn"] = 1
    d = wait(agent_id, settled, f"{harness} history turn", 240)
    t = next(t for t in d["turns"] if t["id"] == turn)
    evidence["observations"][f"{harness} history turn"] = summary(t)
    check(t["status"] == "completed", f"{harness}: the history turn completed", status=t["status"])
    return {t["id"] for t in d["turns"]}


def compaction_turns(d, before):
    return [t for t in d["turns"] if t["id"] not in before]


def codex():
    a = agent("codex")
    before = history(a, "codex")
    status, accepted = call("POST", f"/api/agents/{a}/compact", {})
    evidence["modelCalls"]["codex compaction"] = 1 if status == 200 else 0
    check(status == 200 and accepted.get("accepted") is True, "codex: /compact is accepted by Codex itself", status=status, answer=accepted)
    if status != 200:
        return
    # At once again: refused by Core, so it never reaches Codex.
    again, refusal = call("POST", f"/api/agents/{a}/compact", {})
    check(again != 200, "codex: a second /compact before the first settles is refused", status=again, answer=refusal)
    d = wait(a, lambda d: settled(d) and compaction_turns(d, before), "codex compaction", 300)
    turns = compaction_turns(d, before)
    evidence["observations"]["codex compaction"] = [summary(t) for t in turns]
    items = [i for t in turns for i in t.get("items", [])]
    check(any(i.get("type") == "contextCompaction" for i in items), "codex: Codex's own turn carries a contextCompaction item",
          types=[i.get("type") for i in items])
    check(all(t.get("status") == "completed" for t in turns), "codex: the compaction turn completed", statuses=[t.get("status") for t in turns])
    check(not any(i.get("type") == "userMessage" for i in items), "codex: no prompt was sent for it")
    check(d["agent"]["status"] == "idle", "codex: the Agent is idle again", status=d["agent"]["status"])


def claude():
    a = agent("claude")
    before = history(a, "claude")
    turn = ok("POST", f"/api/agents/{a}/turns", {"text": "/compact"})["turnId"]
    evidence["modelCalls"]["claude compaction"] = 1
    d = wait(a, lambda d: settled(d) and any(t["id"] == turn and t.get("status") != "inProgress" for t in d["turns"]), "claude /compact", 300)
    turns = compaction_turns(d, before)
    evidence["observations"]["claude /compact"] = [summary(t) for t in turns]
    items = [i for t in turns for i in t.get("items", [])]
    check(any("ompact" in (i.get("type") or "") for i in items), "claude: Claude Code's own /compact left a compaction in the record",
          types=[i.get("type") for i in items])
    check(all(t.get("status") == "completed" for t in turns), "claude: the /compact turn completed", statuses=[t.get("status") for t in turns])
    check(d["agent"]["status"] == "idle", "claude: the Agent is idle again", status=d["agent"]["status"])


core = Core()
core.start()
try:
    for name, run in (("codex", codex), ("claude", claude)):
        if name not in ONLY:
            continue
        try:
            run()
        except (SystemExit, OSError) as stop:
            check(False, f"{name}: ran to the end", stopped=str(stop))
finally:
    core.stop()
    evidence["passed"] = sum(c["ok"] for c in evidence["checks"])
    evidence["failed"] = sum(not c["ok"] for c in evidence["checks"])
    (LAB / "evidence.json").write_text(json.dumps(evidence, indent=1, ensure_ascii=False))
    print(f"{evidence['passed']} passed, {evidence['failed']} failed; model calls {evidence['modelCalls']}")
sys.exit(0 if evidence["failed"] == 0 else 1)
