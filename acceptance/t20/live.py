#!/usr/bin/env python3
"""T-20 acceptance: Claude's own turns after a background task stay apart.

  python3 acceptance/t20/live.py start       # lab Core on 4483 (this checkout's build)
  python3 acceptance/t20/live.py background  # real Claude: prompt starts a background shell,
                                             # its completion makes Claude continue on its own
  python3 acceptance/t20/live.py restart     # leave a shell running, restart Core, send again:
                                             # the stopped shell's notice must not take the prompt
  python3 acceptance/t20/live.py stop        # stop the lab Core, compare the daily Core

  python3 acceptance/t20/live.py start --fake   # controlled: the real Core, bridge and web, with
  python3 acceptance/t20/live.py stuck --fake   # fake-sdk.mjs naming no prompt: Close ends the
  python3 acceptance/t20/live.py stop --fake    # stuck turn, reopening continues (stuck-ui.mjs)

The lab Core uses its own data folder (lab/ or lab-fake/), this checkout's
Core build and the web build in target/t20/web-dist. Claude runs with its
normal CLI login; no credential is copied. Only the lab Agent's own shell
commands are approved. Each start and stop records a receipt: source HEAD,
Core/bridge/web hashes, the Core's PID and start time, and that it exited.
The daily Core's listener and web/dist digest are compared before and after.
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
FAKE = "--fake" in sys.argv
LAB = HERE / ("lab-fake" if FAKE else "lab")
PORT = 4483
BASE = f"http://127.0.0.1:{PORT}"
STATE = LAB / "state.json"
EVIDENCE = HERE / "evidence"
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
FINISHED = "sleep 20; echo t20-finished"
LEFT_RUNNING = "sleep 600; echo t20-never"


def background_prompt(shell):
    return (f"T-20 acceptance. Use the Bash tool with run_in_background set to true to run `{shell}`. "
            "Do not wait for it and do not check on it. Then reply with one short sentence saying it was started.")


def call(method, path, body=None, timeout=120):
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
    listener = subprocess.run(["ss", "-ltnp", "sport = :4317"], text=True, capture_output=True).stdout
    digest = hashlib.sha256()
    for path in sorted(DAILY_DIST.rglob("*")):
        if path.is_file():
            digest.update(str(path.relative_to(DAILY_DIST)).encode() + path.read_bytes())
    return {"listener": listener.split("users:")[-1].strip() if "users:" in listener else None,
            "webDist": digest.hexdigest()}


def load():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def record(name, value):
    EVIDENCE.mkdir(exist_ok=True)
    (EVIDENCE / f"{name}.json").write_text(json.dumps(value, indent=2, ensure_ascii=False))


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def starttime(pid):
    """The process's start time in clock ticks (/proc/PID/stat field 22), or None."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat[stat.rindex(")") + 2:].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def built():
    """What this lab runs: source HEAD (and whether tracked files differ) and artifact hashes."""
    vcs = lambda *args: subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True).stdout.strip()
    web = ROOT / "target/t20/web-dist"
    return {"head": vcs("rev-parse", "HEAD"), "dirty": bool(vcs("status", "--porcelain", "--untracked-files=no")),
            "core": sha256(ROOT / "target/debug/yuzuno-workspace"),
            "bridge": sha256(ROOT / "runtimes/claude/bridge.mjs"),
            "webIndex": sha256(web / "index.html"),
            "webAssets": {p.name: sha256(p) for p in sorted((web / "assets").glob("*.js"))}}


def bridges_left():
    """Processes still running this checkout's bridge."""
    bridge = str(ROOT / "runtimes/claude/bridge.mjs").encode()
    left = []
    for proc in Path("/proc").iterdir():
        try:
            if proc.name.isdigit() and bridge in (proc / "cmdline").read_bytes():
                left.append(int(proc.name))
        except OSError:
            pass
    return left


def launch(state):
    (LAB / "work").mkdir(parents=True, exist_ok=True)
    modules = ROOT / "runtimes/claude/node_modules"
    if not modules.exists():
        # The bridge path is compiled in; its SDK comes from the main checkout.
        modules.symlink_to((str(Path.home() / 'yuzuno-next/runtimes/claude/node_modules')))
    log = (LAB / "core.log").open("ab")
    # A shell inside a Yuzuno session inherits the daily release's bridge.
    env = {**os.environ, "PATH": f"{NODE_BIN}:{os.environ['PATH']}",
           "YUZUNO_CLAUDE_BRIDGE": str(ROOT / "runtimes/claude/bridge.mjs")}
    if FAKE:
        # The real bridge, with fake-sdk.mjs in place of the Claude Agent SDK.
        env.update({"YUZUNO_NODE": str(HERE / "fake-node.sh"), "T20_FAKE_MODE_FILE": str(LAB / "mode")})
    child = subprocess.Popen(
        [str(ROOT / "target/debug/yuzuno-workspace"), "--port", str(PORT), "--data-dir", str(LAB / "core-data"),
         "--web-dir", str(ROOT / "target/t20/web-dist"), "--cwd", str(LAB / "work"), "--codex", str(NODE_BIN / "codex")],
        cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    for _ in range(150):
        try:
            call("GET", "/api/health")
            break
        except Exception:
            if child.poll() is not None:
                raise SystemExit("Lab Core exited; see lab/core.log")
            time.sleep(0.1)
    state["pid"] = child.pid
    state["started"] = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "pid": child.pid,
                        "starttime": starttime(child.pid), "lab": LAB.name, **built()}
    save(state)


def halt(state):
    pid = state.pop("pid", None)
    if pid:
        try:
            os.killpg(pid, signal.SIGTERM)
            for _ in range(100):
                os.kill(pid, 0)
                time.sleep(0.1)
        except ProcessLookupError:
            pass
        # Owned processes only: this Core (same PID and start time) and the
        # bridges started from this checkout.
        time.sleep(3)
        started = state.get("started", {})
        receipts = state.setdefault("receipts", [])
        receipts.append({"started": started, "stopped": {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "coreExited": starttime(pid) != started.get("starttime"), "bridgesLeft": bridges_left()}})
        record(f"lab-receipts-{LAB.name}", receipts)
    save(state)


def detail(agent):
    return call("GET", f"/api/agents/{agent}")


def text_of(item):
    return item.get("text") or "".join(c.get("text", "") for c in item.get("content", []))


def summary(d):
    return {"status": d["agent"]["status"], "backgroundShells": d.get("backgroundShells"), "turns": [{
        "id": turn["id"], "status": turn["status"], "source": turn.get("_yuzunoSource"),
        "origin": turn.get("_yuzunoOrigin"), "durationMs": turn.get("_yuzunoDurationMs"),
        "items": [{"type": item["type"], "status": item.get("status"), "phase": item.get("phase"),
                   "text": text_of(item)[:120]} for item in turn["items"]],
    } for turn in d["turns"]]}


def approve(d, shell):
    for request in d["pending"]:
        if request["method"] == "claude/canUseTool" and not request.get("stale") \
                and shell in json.dumps(request["params"]) and not request["params"].get("_responseSent"):
            call("POST", f"/api/requests/{request['id']}/respond", {"response": {"decision": "allow"}})


def wait(agent, ready, what, shell, seconds=300, samples=None):
    deadline = time.time() + seconds
    while time.time() < deadline:
        d = detail(agent)
        if samples is not None:
            running = [t["id"] for t in d["turns"] if t["status"] == "inProgress"]
            samples.append({"at": int(time.time() * 1000), "status": d["agent"]["status"], "running": running})
        if ready(d):
            return d
        approve(d, shell)
        time.sleep(0.25 if samples is not None else 1)
    raise SystemExit(f"Timed out waiting for {what}: {json.dumps(summary(detail(agent)), ensure_ascii=False)[:3000]}")


def agent_for(state):
    if state.get("agent"):
        return state["agent"]
    catalog = call("GET", "/api/models?harness=claude", timeout=180)
    models = [m.get("value") or m.get("id") for m in catalog.get("models", catalog.get("data", []))]
    model = next((m for m in models if m and "haiku" in m), models[0] if models else "")
    agent = call("POST", "/api/agents", {"name": "T-20 Claude", "harness": "claude", "cwd": str(LAB / "work"),
                                          "model": model}, timeout=180)["id"]
    # Haiku has no auto mode; the lab approves only its own shell.
    call("POST", f"/api/agents/{agent}/settings", {"model": model, "permissionMode": "default"})
    state["agent"] = agent
    save(state)
    return agent


def send(agent, text, shell, seconds=300):
    before = [t["id"] for t in detail(agent)["turns"]]
    turn_id = call("POST", f"/api/agents/{agent}/turns", {"text": text}, timeout=180)["turnId"]
    d = wait(agent, lambda d: any(t["id"] == turn_id and t["status"] != "inProgress" for t in d["turns"]),
             "the prompt's turn to end", shell, seconds)
    return before, turn_id, d


def check(condition, message, failures):
    if not condition:
        failures.append(message)


def start():
    state = load()
    if state.get("pid"):
        raise SystemExit("A lab Core is recorded as running; run stop first.")
    state = {**state, "dailyBefore": daily()}
    launch(state)
    print(json.dumps({"core": BASE, "daily": state["dailyBefore"]}, indent=2))


def background():
    state = load()
    agent = agent_for(state)
    before, turn_id, d = send(agent, background_prompt(FINISHED), FINISHED)
    prompt_turn = next(t for t in d["turns"] if t["id"] == turn_id)
    samples = []
    # The shell ends ~20s later; Claude then continues on its own.
    d = wait(agent, lambda d: any(t["id"] not in before and t["id"] != turn_id and t["status"] != "inProgress"
                                  for t in d["turns"]) and d["agent"]["status"] in ("idle", "error"),
             "Claude's own continuation", FINISHED, 180, samples)
    time.sleep(3)
    d = detail(agent)
    new = [t for t in d["turns"] if t["id"] not in before]
    own = [t for t in new if t["id"] != turn_id]
    failures = []
    check(len(new) == 2, f"expected the prompt's turn and one of Claude's own, got {[t['id'] for t in new]}", failures)
    check(next(t for t in new if t["id"] == turn_id)["items"] == prompt_turn["items"],
          "the prompt's turn changed after it ended", failures)
    check(own and own[0]["id"].startswith("native-") and own[0].get("_yuzunoSource") == "native",
          "the continuation is not a native turn", failures)
    check(own and own[0].get("_yuzunoOrigin") == "task-notification", "the continuation's origin is not recorded", failures)
    check(own and not any(i["type"] == "userMessage" for i in own[0]["items"]), "the continuation shows a user message", failures)
    check(own and any(i["type"] == "agentMessage" and text_of(i).strip() for i in own[0]["items"]),
          "the continuation's reply is not visible", failures)
    check(any(s["status"] == "working" and own and own[0]["id"] in s["running"] for s in samples) or not samples,
          "never seen working while Claude continued", failures)
    result = {"agent": agent, "promptTurn": turn_id, "failures": failures,
              "workingSeen": [s for s in samples if s["running"]][:20], **summary({**d, "turns": new})}
    record("background", result)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


def restart():
    state = load()
    agent = agent_for(state)
    send(agent, background_prompt(LEFT_RUNNING), LEFT_RUNNING)
    kept = summary(detail(agent))
    halt(state)
    launch(state)
    before, turn_id, d = send(agent, "T-20 acceptance after a restart. Do not use any tool. "
                              "Reply with exactly: t20-resumed", LEFT_RUNNING, 400)
    time.sleep(5)
    d = detail(agent)
    turn = next(t for t in d["turns"] if t["id"] == turn_id)
    replies = [text_of(i) for i in turn["items"] if i["type"] == "agentMessage"]
    failures = []
    check(turn["status"] == "completed" and any("t20-resumed" in r for r in replies),
          f"the prompt's turn lost its reply: {turn['status']} {replies}", failures)
    check([t["id"] for t in d["turns"] if t["id"] not in before] == [turn_id],
          "the stopped shell's empty notice turn added a turn", failures)
    check(summary({**d, "turns": [t for t in d["turns"] if t["id"] in before]})["turns"] == kept["turns"],
          "turns from before the restart changed", failures)
    result = {"agent": agent, "promptTurn": turn_id, "failures": failures, **summary(d)}
    record("restart", result)
    print(json.dumps({k: result[k] for k in ("promptTurn", "failures", "status")}, indent=2, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


def probe():
    """Results whose prompt uuid a turn's end depends on: a local slash
    command and an interrupted tool. Records what Claude reported."""
    state = load()
    agent = agent_for(state)
    out, failures = {}, []
    for name, text in [("slash", "/cost")] if "--slash" in sys.argv else []:
        before = [t["id"] for t in detail(agent)["turns"]]
        turn_id = call("POST", f"/api/agents/{agent}/turns", {"text": text}, timeout=180)["turnId"]
        try:
            wait(agent, lambda d: any(t["id"] == turn_id and t["status"] != "inProgress" for t in d["turns"]),
                 name, FINISHED, 90)
        except SystemExit:
            pass
        time.sleep(2)
        d = detail(agent)
        turn = next(t for t in d["turns"] if t["id"] == turn_id)
        replies = [text_of(i) for i in turn["items"] if i["type"] == "agentMessage"]
        # Its reply comes without the prompt's uuid; only its result names the prompt.
        check(turn["status"] == "completed" and any("subscription" in r or "cost" in r.lower() for r in replies),
              f"/cost reply not in its own turn: {turn['status']} {replies}", failures)
        check([t["id"] for t in d["turns"] if t["id"] not in before] == [turn_id], "/cost added another turn", failures)
        out[name] = {"turnId": turn_id, "status": turn["status"], "replies": replies}
    if "--interrupt" not in sys.argv:
        out["failures"] = failures
        record("probe-slash", out)
        print(json.dumps(out, indent=2))
        raise SystemExit(1 if failures else 0)
    # Claude's Bash tool refuses a long foreground `sleep`.
    slow = "python3 -c 'import time; time.sleep(45)'"
    turn_id = call("POST", f"/api/agents/{agent}/turns", {"text": f"T-20 acceptance. Use the Bash tool in the foreground "
                   f"(not in the background) to run `{slow}` and wait for it. Then say done."}, timeout=180)["turnId"]
    wait(agent, lambda d: any(i["type"] == "claudeToolUse" and i.get("status") == "inProgress"
                              for t in d["turns"] if t["id"] == turn_id for i in t["items"])
         and not d["pending"], "the foreground tool to run", slow, 180)
    time.sleep(3)
    call("POST", f"/api/agents/{agent}/interrupt", {})
    try:
        wait(agent, lambda d: any(t["id"] == turn_id and t["status"] != "inProgress" for t in d["turns"]),
             "the interrupted turn to end", slow, 90)
    except SystemExit:
        pass
    status = next(t["status"] for t in detail(agent)["turns"] if t["id"] == turn_id)
    check(status == "interrupted", f"the interrupted turn ended as {status}", failures)
    out["interrupt"] = {"turnId": turn_id, "status": status}
    out["failures"] = failures
    record("probe", out)
    print(json.dumps(out, indent=2))
    if failures:
        raise SystemExit(1)


def stuck():
    """Controlled (--fake): a producer naming no prompt leaves the prompt's turn
    running; the user's Close ends it as unknown and reopening continues."""
    if not FAKE:
        raise SystemExit("stuck needs the controlled lab: add --fake")
    state = load()
    (LAB / "mode").write_text("unattributed\n")
    agent_for(state)
    env = {**os.environ, "PATH": f"{NODE_BIN}:{os.environ['PATH']}"}
    ran = subprocess.run(["node", str(HERE / "stuck-ui.mjs")], cwd=ROOT, env=env)
    if ran.returncode:
        raise SystemExit(ran.returncode)


def stop():
    state = load()
    halt(state)
    after = daily()
    print(json.dumps({"dailyBefore": state.get("dailyBefore"), "dailyAfter": after,
                      "unchanged": state.get("dailyBefore") == after}, indent=2))


if __name__ == "__main__":
    {"start": start, "background": background, "restart": restart, "probe": probe, "stuck": stuck,
     "stop": stop}[sys.argv[1]]()
