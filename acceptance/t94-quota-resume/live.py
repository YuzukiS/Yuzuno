#!/usr/bin/env python3
"""T-94 acceptance: automatic continue after a Claude usage limit resets.

  YUZUNO_LAB_CORE=<candidate Core> YUZUNO_LAB_WEB=<candidate web/dist> \\
    python3 acceptance/t94-quota-resume/live.py <empty lab folder>

Lab Cores have their own data and ports, never the daily one. An account's
usage limit is never run into on purpose, so this lab has two phases.

The **scripted phase** uses the candidate Core binary and web over the
scripted SDK of the Core tests (core/tests/fixtures/claude_quota_bridge.mjs).
It reproduces the limit exactly as CLI 2.1.280 reported it on 2026-10-17:
`rate_limit_event` rejected five_hour with `resetsAt`, then the failed result.
It checks:
- **ui:** browser.mjs shows the notice of a waiting continue (light and wide;
  dark and 390 px wide), the agent's "Usage limit" row, and "Don't continue
  automatically" pressed with the keyboard.
- **restart:** a continue due in a few seconds; the lab Core stops before
  it is due and starts again from the same data. It is sent exactly once,
  in the same session, and the stopped prompt is never sent again.

The **real phase** runs one turn of real Claude Code (installed CLI, normal
login, `haiku`) in ~/.t94-lab/<lab name>, with automatic continue on. It
checks:
- **event:** the real `rate_limit_event` arrives during the turn, as the
  usage-limit check requires, with the fields it reads;
- **quiet:** a turn that completes arms nothing.

**daily:** the daily Core's listener and web, and ~/.claude/settings.json,
are the same before and after.

Checks are judged by Core's records and API, never by wording. Everything
goes to <lab>/evidence.json.
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
SCRIPTED = ROOT / "core/tests/fixtures/claude_quota_bridge.mjs"
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
CLAUDE_SETTINGS = Path.home() / ".claude/settings.json"
CONTINUE_PREFIX = "[Yuzuno · automatic continue]"
GRACE = 60
LAB = Path(sys.argv[1]).resolve()
LAB.mkdir(parents=True)
WORK = Path.home() / ".t94-lab" / LAB.name
ENV = {"HOME": str(Path.home()), "PATH": f"{NODE_BIN}:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
evidence = {"lab": str(LAB), "checks": [], "observations": {}, "cores": []}
started = time.monotonic()
BASE = ""


def call(method, path, body=None, timeout=120):
    request = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", "X-Yuzuno-Client": "desktop"})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as error:
        text = error.read().decode()
        try:
            return error.code, json.loads(text)
        except ValueError:
            return error.code, text


def ok(method, path, body=None):
    status, result = call(method, path, body)
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


class Core:
    def __init__(self, name, port, env):
        self.name, self.port, self.env, self.child = name, port, env, None
        self.data, self.cwd = LAB / f"{name}-data", LAB / f"{name}-work"
        self.cwd.mkdir(exist_ok=True)

    def start(self):
        global BASE
        BASE = f"http://127.0.0.1:{self.port}"
        log = (LAB / f"{self.name}-core.log").open("ab")
        self.child = subprocess.Popen(
            [str(CORE), "--port", str(self.port), "--data-dir", str(self.data), "--cwd", str(self.cwd), "--web-dir", str(WEB),
             "--codex", str(NODE_BIN / "codex")],
            cwd=LAB, env={**ENV, **self.env}, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(300):
            try:
                if call("GET", "/api/health", timeout=2)[0] == 200:
                    break
            except OSError:
                pass
            if self.child.poll() is not None:
                raise SystemExit(f"{self.name} Core exited; see its log")
            time.sleep(0.2)
        evidence["cores"].append({"core": self.name, "binarySha256": digest(CORE), "bridge": self.env.get("YUZUNO_CLAUDE_BRIDGE"), "pid": self.child.pid})

    def stop(self):
        if self.child and self.child.poll() is None:
            try:
                os.killpg(self.child.pid, signal.SIGTERM)
                self.child.wait(timeout=20)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                os.killpg(self.child.pid, signal.SIGKILL)
                self.child.wait(timeout=10)
        time.sleep(1)


def wait(what, ready, seconds=120):
    deadline = time.time() + seconds
    while time.time() < deadline:
        value = ready()
        if value:
            return value
        time.sleep(0.3)
    raise SystemExit(f"Timed out waiting for {what}")


def agent(model="m", cwd=None):
    a = ok("POST", "/api/agents", {"name": "T94 lab", "cwd": str(cwd), "harness": "claude", "machineId": "local", "model": model})
    wait("the agent to connect", lambda: ok("GET", f"/api/agents/{a['id']}")["agent"]["connectionState"] == "connected")
    return a["id"]


def turn(agent_id, text):
    """Sends `text` and waits for its turn to end; the turn, and when it was sent (ms)."""
    sent_ms = int(time.time() * 1000)
    turn_id = ok("POST", f"/api/agents/{agent_id}/turns", {"text": text})["turnId"]
    t = wait(f"turn {text}", lambda: next((t for t in ok("GET", f"/api/agents/{agent_id}")["turns"]
                                           if t["id"] == turn_id and t.get("status") not in (None, "inProgress")), None), 300)
    return t, sent_ms


def view(agent_id):
    return ok("GET", f"/api/agents/{agent_id}/claude/auto-continue")


def prompts(log, session):
    lines = [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []
    return [l["text"] for l in lines if l["session"] == session]


before = daily()
cores = []
try:
    # Scripted phase: the candidate Core and web over the scripted SDK.
    log = LAB / "scripted-prompts.jsonl"
    scripted = Core("scripted", 4595, {"YUZUNO_CLAUDE_BRIDGE": str(SCRIPTED), "YUZUNO_TEST_CLAUDE_PROMPTS": str(log)})
    cores.append(scripted)
    scripted.start()
    a = agent(cwd=scripted.cwd)
    ok("POST", f"/api/agents/{a}/claude/auto-continue", {"enabled": True})
    reset = int(time.time()) + 3600
    turn(a, f"limit {reset}")
    v = wait("the intent", lambda: (lambda v: v if v["intent"] else None)(view(a)), 30)
    check(v["intent"] and v["intent"]["state"] == "waiting" and v["intent"]["resetsAt"] == reset and v["intent"]["dueAt"] == reset + GRACE,
          "a turn the usage limit stopped waits for Claude's reset", intent=v["intent"])
    out = subprocess.run([str(NODE_BIN / "node"), str(HERE / "browser.mjs"), BASE, a, str(LAB / "screenshots")],
                         capture_output=True, text=True, timeout=300, env=ENV)
    (LAB / "browser.log").write_text(out.stdout + out.stderr)
    if out.returncode != 0:
        raise SystemExit(f"browser.mjs failed: {out.stderr[-2000:]}")
    seen = json.loads(out.stdout.strip().splitlines()[-1])
    evidence["observations"]["browser"] = seen
    check("usage limit stopped this agent" in seen["waiting"]["text"] and seen["waiting"]["buttons"] == ["Continue now", "Don’t continue automatically"],
          "the notice says what waits, with continue now and don't continue", waiting=seen["waiting"])
    check(seen["setting"]["value"] == "on" and seen["setting"]["fits"], "the agent's Usage limit row shows its own choice, not cut off",
          setting=seen["setting"])
    check(seen["narrow"]["theme"] == "dark" and not seen["narrow"]["overflow"] and seen["narrow"]["fits"], "dark, 390 px wide, without overflow",
          narrow=seen["narrow"])
    after = view(a)
    check("cancelled" in seen["cancelled"]["text"] and seen["cancelled"]["buttons"] == [] and after["intent"]["state"] == "cancelled",
          "Don't continue automatically, pressed with the keyboard, cancels it", cancelled=seen["cancelled"], intent=after["intent"])

    # A continue due in a few seconds survives a Core stop: sent once, after it starts again.
    b = agent(cwd=scripted.cwd)
    ok("POST", f"/api/agents/{b}/claude/auto-continue", {"enabled": True})
    soon = int(time.time()) - GRACE + 12
    turn(b, f"limit {soon}")
    waiting = wait("the intent", lambda: view(b)["intent"], 30)
    session = ok("GET", f"/api/agents/{b}")["agent"]["claudeSessionId"]
    scripted.stop()
    check(prompts(log, session) == [f"limit {soon}"], "nothing was sent before the Core stopped", prompts=prompts(log, session))
    time.sleep(max(0, waiting["dueAt"] - time.time()) + 1)
    scripted.start()
    sent = wait("the continue after the restart", lambda: (lambda i: i if i and i["state"] == "sent" else None)(view(b)["intent"]), 60)
    d = wait("its turn", lambda: (lambda d: d if d["turns"][-1]["id"] == sent["sentTurn"] and d["turns"][-1]["status"] == "completed" else None)(ok("GET", f"/api/agents/{b}")))
    sent_prompts = prompts(log, session)
    check(len(sent_prompts) == 2 and sent_prompts[0] == f"limit {soon}" and sent_prompts[1].startswith(CONTINUE_PREFIX)
          and d["agent"]["claudeSessionId"] == session,
          "after the restart: one continue, in the same session; the stopped prompt not sent again",
          prompts=[p[:40] for p in sent_prompts], intent=sent)
    time.sleep(3)
    check(len(prompts(log, session)) == 2, "still exactly one continue a few seconds later")
    scripted.stop()

    # Real phase: one real Claude Code turn with automatic continue on.
    if os.environ.get("YUZUNO_LAB_SKIP_REAL") != "1":
        WORK.mkdir(parents=True, exist_ok=True)
        real = Core("real", 4596, {"YUZUNO_CLAUDE_BRIDGE": str(BRIDGE)})
        cores.append(real)
        real.start()
        r = agent(model="haiku", cwd=WORK)
        ok("POST", f"/api/agents/{r}/claude/auto-continue", {"enabled": True})
        t, sent_ms = turn(r, "Reply with only: ok")
        d = ok("GET", f"/api/agents/{r}")
        runtime = d.get("claudeRuntime") or {}
        limits, reported = runtime.get("rateLimits"), runtime.get("rateLimitsAt")
        evidence["observations"]["real rateLimits"] = {k: (limits or {}).get(k) for k in ("status", "rateLimitType", "resetsAt", "isUsingOverage")}
        if limits:
            from datetime import datetime
            reported_ms = int(datetime.fromisoformat(reported).timestamp() * 1000)
            check(t["status"] == "completed" and limits.get("status") in ("allowed", "allowed_warning") and isinstance(limits.get("resetsAt"), (int, float))
                  and reported_ms >= t.get("_yuzunoStartedAt", sent_ms),
                  "real: rate_limit_event arrived during the turn, with status and resetsAt", reportedMs=reported_ms,
                  turnStartedMs=t.get("_yuzunoStartedAt"), sentMs=sent_ms)
        else:
            check(t["status"] == "completed", "real: this login reports no rate limits (API key); the turn completed", runtime=list(runtime))
        v = view(r)
        check(v["enabled"] and v["intent"] is None and v["stopped"] is None, "real: a completed turn arms nothing", view=v)
        real.stop()
finally:
    for core in cores:
        core.stop()
    after = daily()
    evidence["observations"]["dailyBefore"], evidence["observations"]["dailyAfter"] = before, after
    check(after == before, "the daily Core, its web and Claude settings are unchanged", before=before, after=after)
    failed = [c["check"] for c in evidence["checks"] if not c["ok"]]
    evidence["result"] = {"passed": len(evidence["checks"]) - len(failed), "failed": failed}
    (LAB / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    print(json.dumps(evidence["result"], ensure_ascii=False))
sys.exit(1 if evidence["result"]["failed"] else 0)
