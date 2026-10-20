#!/usr/bin/env python3
"""T-23 acceptance: the reasoning effort chosen for a Claude Agent, and the one
Claude Code reports a turn actually ran at, through a real Claude session.

  python3 acceptance/claude-effort/live.py <empty lab folder>

Starts a lab Core from this checkout (target/debug/yuzuno-workspace unless
YUZUNO_LAB_CORE names another build, and this checkout's bridge) on its own
port, data folder and working folder under the lab folder, then:

  catalog    the Agent's catalog lists effort levels per model; Haiku takes none
  default    no choice saved: the turn reports what Claude Code chose itself
  between    low saved between turns: the next turn reports low
  running    high saved while a turn runs: that turn stays low, the next is high
  refused    a model that takes no effort keeps a saved effort only if it is
             cleared; refusals leave the saved model and effort unchanged
  no-effort  Haiku with no effort: the turn reports none; the last report stays
             with the turn it came from
  recovery   medium saved, lab Core restarted: the resumed session starts with
             medium and the choice and last report survive
  cleared    default saved mid-session: Claude falls back to the model default

Real Claude with the normal CLI login and manual permissions; the only tool the
lab approves is its own `python3 -c ... sleep` command. Short replies, Sonnet
and Haiku. Every receipt goes to <lab>/evidence.json. The daily Core is only
compared by its listener and web/dist digest; ~/.claude/settings.json only by
digest, plus its effortLevel key, which explains the default case.
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

ROOT = Path(__file__).resolve().parents[2]
CORE = Path(os.environ.get("YUZUNO_LAB_CORE", ROOT / "target/debug/yuzuno-workspace"))
BRIDGE = ROOT / "runtimes/claude/bridge.mjs"
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
PORT = 4523
BASE = f"http://127.0.0.1:{PORT}"
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
CLAUDE_SETTINGS = Path.home() / ".claude/settings.json"
SLEEP = "python3 -c 'import time; time.sleep(6); print(23)'"
LAB = Path(sys.argv[1]).resolve()
LAB.mkdir(parents=True)
WORK = LAB / "work"
WORK.mkdir()
evidence = {"lab": str(LAB), "port": PORT, "checks": [], "turns": {}, "receipts": []}
started = time.monotonic()


def call(method, path, body=None, timeout=180):
    """(status, body); a refusal is a result here, not an exception."""
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
    evidence["checks"].append({"ok": bool(condition), "check": text, **facts,
                               "t": round(time.monotonic() - started, 1)})
    print(("PASS " if condition else "FAIL ") + text, json.dumps(facts, ensure_ascii=False)[:400], flush=True)


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


def source():
    vcs = lambda *args: subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True).stdout.strip()
    return {"head": vcs("rev-parse", "HEAD"), "trackedChanges": vcs("status", "--porcelain", "--untracked-files=no"),
            "core": digest(CORE), "bridge": digest(BRIDGE)}


def starttime(pid):
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat[stat.rindex(")") + 2:].split()[19]
    except OSError:
        return None


def bridges_left():
    marker = str(BRIDGE).encode()
    left = []
    for proc in Path("/proc").iterdir():
        try:
            if proc.name.isdigit() and marker in (proc / "cmdline").read_bytes():
                left.append(int(proc.name))
        except OSError:
            pass
    return left


def launch():
    log = (LAB / "core.log").open("ab")
    env = {**os.environ, "HOME": str(Path.home()), "PATH": f"{NODE_BIN}:/usr/local/bin:/usr/bin:/bin",
           "YUZUNO_CLAUDE_BRIDGE": str(BRIDGE)}
    child = subprocess.Popen(
        [str(CORE), "--port", str(PORT), "--data-dir", str(LAB / "core-data"), "--cwd", str(WORK),
         "--codex", str(NODE_BIN / "codex")],
        cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    for _ in range(300):
        try:
            if call("GET", "/api/health", timeout=2)[0] == 200:
                break
        except OSError:
            pass
        if child.poll() is not None:
            raise SystemExit("Lab Core exited; see core.log")
        time.sleep(0.2)
    evidence["receipts"].append({"started": {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "pid": child.pid,
                                             "starttime": starttime(child.pid), **source()}})
    return child


def halt(child):
    stamp = starttime(child.pid)
    try:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=20)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=10)
    time.sleep(3)
    evidence["receipts"][-1]["stopped"] = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                                           "coreExited": starttime(child.pid) != stamp,
                                           "bridgesLeft": bridges_left()}


def detail(agent):
    return ok("GET", f"/api/agents/{agent}")


def turn(d, turn_id):
    return next((t for t in d["turns"] if t["id"] == turn_id), None)


def reported(d):
    return (d.get("claudeRuntime") or {}).get("effort")


def chosen(d):
    return d["agent"]["model"], (d["agent"].get("settings") or {}).get("reasoningEffort")


def approve(d):
    for request in d["pending"]:
        if request["method"] == "claude/canUseTool" and not request.get("stale") \
                and "import time; time.sleep(" in json.dumps(request["params"]) \
                and not request["params"].get("_responseSent"):
            ok("POST", f"/api/requests/{request['id']}/respond", {"response": {"decision": "allow"}})


def wait(agent, ready, what, seconds=300, answer=True):
    deadline = time.time() + seconds
    while time.time() < deadline:
        d = detail(agent)
        if ready(d):
            return d
        if answer:
            approve(d)
        time.sleep(0.5)
    raise SystemExit(f"Timed out waiting for {what}")


def ended(turn_id):
    return lambda d: d["agent"]["status"] == "idle" and (turn(d, turn_id) or {}).get("status") == "completed"


def run_turn(agent, name, text):
    turn_id = ok("POST", f"/api/agents/{agent}/turns", {"text": text})["turnId"]
    d = wait(agent, ended(turn_id), f"turn {name}")
    time.sleep(1)
    d = detail(agent)
    evidence["turns"][name] = {"turnId": turn_id, "reported": reported(d), "chosen": chosen(d),
                               "session": d["agent"].get("claudeSessionId")}
    return turn_id, d


def save(agent, body):
    return call("POST", f"/api/agents/{agent}/settings", {"permissionMode": "default", **body})


def lab():
    evidence["dailyBefore"] = daily()
    try:
        effort_level = json.loads(CLAUDE_SETTINGS.read_text()).get("effortLevel")
    except (OSError, ValueError):
        effort_level = None
    evidence["claudeSettingsEffortLevel"] = effort_level
    core = launch()
    try:
        agent = ok("POST", "/api/agents", {"name": "T-23 effort", "harness": "claude", "cwd": str(WORK),
                                           "model": "sonnet"})["id"]
        catalog = ok("GET", f"/api/agents/{agent}/models")
        rows = {m["model"]: {k: m.get(k) for k in ("supportsEffort", "supportedEffortLevels", "resolvedModel")}
                for m in catalog["models"]}
        evidence["catalog"] = rows
        sonnet = rows.get("sonnet") or {}
        check(sonnet.get("supportsEffort") and {"low", "medium", "high"} <= set(sonnet.get("supportedEffortLevels") or []),
              "catalog: Sonnet lists its effort levels", sonnet=sonnet)
        check(rows.get("haiku", {}).get("supportsEffort") is False and rows["haiku"].get("supportedEffortLevels") == [],
              "catalog: Haiku takes no effort", haiku=rows.get("haiku"))
        status, _ = save(agent, {"model": "sonnet", "effort": None})
        check(status == 200, "Sonnet with Claude Code default saves", status=status)

        a, d = run_turn(agent, "default", "T-23 acceptance. Do not use any tool. Reply with exactly: A")
        check(chosen(d)[1] is None and (reported(d) or {}).get("turnId") == a,
              "default: nothing chosen, and Claude Code reported what the turn ran at",
              reported=reported(d), settingsEffortLevel=effort_level)

        status, _ = save(agent, {"model": "sonnet", "effort": "low"})
        b, d = run_turn(agent, "between", "T-23 acceptance. Do not use any tool. Reply with exactly: B")
        check(status == 200 and chosen(d) == ("sonnet", "low") and reported(d) == {"level": "low", "turnId": b},
              "between turns: low saved, the next turn ran at low", reported=reported(d))

        c = ok("POST", f"/api/agents/{agent}/turns", {"text": (
            f"T-23 acceptance. Use the Bash tool once to run `{SLEEP}`, then reply with exactly: C")})["turnId"]
        wait(agent, lambda d: any(p["method"] == "claude/canUseTool" and not p.get("stale") for p in d["pending"]),
             "turn C's tool request", answer=False)
        status, saved = save(agent, {"model": "sonnet", "effort": "high"})
        mid = chosen(detail(agent))
        wait(agent, ended(c), "turn C")
        time.sleep(1)
        d = detail(agent)
        evidence["turns"]["running"] = {"turnId": c, "reported": reported(d), "chosen": chosen(d)}
        check(status == 200 and mid == ("sonnet", "high") and reported(d) == {"level": "low", "turnId": c},
              "running turn: high saved mid-turn, the running turn stayed at low", reported=reported(d),
              savedStatus=status)
        e, d = run_turn(agent, "after-running", "T-23 acceptance. Do not use any tool. Reply with exactly: D")
        check(reported(d) == {"level": "high", "turnId": e}, "the turn after it ran at high", reported=reported(d))

        refusals = {}
        for name, body in (("haiku keeping high", {"model": "haiku"}),
                           ("haiku with high", {"model": "haiku", "effort": "high"}),
                           ("an unknown level", {"model": "sonnet", "effort": "turbo"})):
            status, result = save(agent, body)
            refusals[name] = {"status": status, "error": (result or {}).get("error") if isinstance(result, dict) else result,
                              "after": chosen(detail(agent))}
        evidence["refusals"] = refusals
        check(all(r["status"] == 400 and r["after"] == ("sonnet", "high") for r in refusals.values()),
              "refused saves explain why and change neither model nor effort", refusals=refusals)

        status, _ = save(agent, {"model": "haiku", "effort": None})
        f, d = run_turn(agent, "no-effort", "T-23 acceptance. Do not use any tool. Reply with exactly: E")
        check(status == 200 and chosen(d) == ("haiku", None) and reported(d) == {"level": "high", "turnId": e},
              "Haiku: no effort reported; the last report stays with its own earlier turn", reported=reported(d))

        status, _ = save(agent, {"model": "sonnet", "effort": "medium"})
        session = d["agent"].get("claudeSessionId")
        halt(core)
        core = launch()
        d = detail(agent)
        check(status == 200 and chosen(d) == ("sonnet", "medium") and reported(d) == {"level": "high", "turnId": e},
              "after a Core restart the choice and the last report are both kept apart", reported=reported(d))
        g, d = run_turn(agent, "recovery", "T-23 acceptance. Do not use any tool. Reply with exactly: F")
        check(reported(d) == {"level": "medium", "turnId": g} and d["agent"].get("claudeSessionId") == session,
              "the resumed session started with medium", reported=reported(d), session=session)

        status, _ = save(agent, {"model": "sonnet", "effort": None})
        h, d = run_turn(agent, "cleared", "T-23 acceptance. Do not use any tool. Reply with exactly: G")
        check(status == 200 and chosen(d) == ("sonnet", None) and (reported(d) or {}).get("turnId") == h,
              "default saved mid-session: Claude reported the effort it fell back to", reported=reported(d))
        evidence["agent"] = agent
    finally:
        halt(core)
        evidence["dailyAfter"] = daily()
        check(evidence["dailyBefore"] == evidence["dailyAfter"],
              "daily Core listener, its web/dist and ~/.claude/settings.json unchanged")
        check(all(r["stopped"]["coreExited"] and not r["stopped"]["bridgesLeft"] for r in evidence["receipts"]),
              "every lab Core exited and left no bridge")
        (LAB / "evidence.json").write_text(json.dumps(evidence, indent=2, ensure_ascii=False))
    failed = [c["check"] for c in evidence["checks"] if not c["ok"]]
    print(json.dumps({"checks": len(evidence["checks"]), "failed": failed}, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(lab())
