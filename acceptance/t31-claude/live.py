#!/usr/bin/env python3
"""T-31 acceptance, local Claude milestone: images sent to real Claude.

  python3 acceptance/t31-claude/live.py start    # lab Core on 4491 (this checkout's build and bridge)
  python3 acceptance/t31-claude/live.py new      # a new turn with two images and text, then one image alone
                                                 # (larger than Claude's budget, so Core fits it first)
  python3 acceptance/t31-claude/live.py follow   # an image sent as a follow-up while Claude runs tools
  python3 acceptance/t31-claude/live.py stop     # stop the lab Core, compare the daily Core

Real Claude (Haiku) with the normal CLI login and manual permissions; the lab
approves only its own `python3 -c ... sleep` commands. The images are made
here: a code in large letters on a plain background, and a shape. Each start
and stop records a receipt: source HEAD, Core/bridge/web hashes, the Core's
PID and start time, and that it exited. The daily Core is only compared by
listener and web/dist digest.
"""
import hashlib
import io
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LAB = HERE / "lab"
PORT = 4491
BASE = f"http://127.0.0.1:{PORT}"
STATE = LAB / "state.json"
EVIDENCE = HERE / "evidence"
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
WEB = ROOT / "target/t31c/web-dist"
STEP = "python3 -c 'import time; time.sleep({s}); print({n})'"


def call(method, path, body=None, timeout=120, raw=None, kind="application/json"):
    data = raw if raw is not None else None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + path, method=method, data=data,
                                     headers={"Content-Type": kind, "X-Yuzuno-Client": "desktop"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            payload = response.read()
            return payload if response.headers.get_content_type().startswith("image/") else json.loads(payload or b"null")
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
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat[stat.rindex(")") + 2:].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def built():
    vcs = lambda *args: subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True).stdout.strip()
    return {"head": vcs("rev-parse", "HEAD"), "dirty": bool(vcs("status", "--porcelain", "--untracked-files=no")),
            "core": sha256(ROOT / "target/debug/yuzuno-workspace"), "bridge": sha256(ROOT / "runtimes/claude/bridge.mjs"),
            "webIndex": sha256(WEB / "index.html")}


def bridges_left():
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
    log = (LAB / "core.log").open("ab")
    # A shell inside a Yuzuno session inherits the daily release's bridge.
    env = {**os.environ, "PATH": f"{NODE_BIN}:{os.environ['PATH']}",
           "YUZUNO_CLAUDE_BRIDGE": str(ROOT / "runtimes/claude/bridge.mjs")}
    child = subprocess.Popen(
        [str(ROOT / "target/debug/yuzuno-workspace"), "--port", str(PORT), "--data-dir", str(LAB / "core-data"),
         "--web-dir", str(WEB), "--cwd", str(LAB / "work"), "--codex", str(NODE_BIN / "codex")],
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
                        "starttime": starttime(child.pid), **built()}
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
        time.sleep(3)
        started = state.get("started", {})
        state.setdefault("receipts", []).append({"started": started, "stopped": {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "coreExited": starttime(pid) != started.get("starttime"), "bridgesLeft": bridges_left()}})
        record("lab-receipts", state["receipts"])
    save(state)


def detail(agent):
    return call("GET", f"/api/agents/{agent}")


def approve(d):
    for request in d["pending"]:
        if request["method"] == "claude/canUseTool" and not request.get("stale") \
                and "import time; time.sleep(" in json.dumps(request["params"]) and not request["params"].get("_responseSent"):
            call("POST", f"/api/requests/{request['id']}/respond", {"response": {"decision": "allow"}})


def wait(agent, ready, what, seconds=300):
    deadline = time.time() + seconds
    while time.time() < deadline:
        d = detail(agent)
        if ready(d):
            return d
        approve(d)
        time.sleep(0.5)
    raise SystemExit(f"Timed out waiting for {what}")


def new_agent(state, name):
    catalog = call("GET", "/api/models?harness=claude", timeout=180)
    models = [m.get("value") or m.get("id") for m in catalog.get("models", catalog.get("data", []))]
    model = next((m for m in models if m and "haiku" in m), models[0] if models else "")
    agent = call("POST", "/api/agents", {"name": name, "harness": "claude", "cwd": str(LAB / "work"), "model": model},
                 timeout=180)["id"]
    call("POST", f"/api/agents/{agent}/settings", {"model": model, "permissionMode": "default"})
    state.setdefault("agents", {})[name] = agent
    save(state)
    return agent


def picture(size, background, code=None, circle=None):
    """A self-made test image: a code in large letters, or a filled circle."""
    image = Image.new("RGB", size, background)
    draw = ImageDraw.Draw(image)
    if code:
        font = ImageFont.load_default(size=size[1] // 3)
        draw.text((size[0] // 2, size[1] // 2), code, fill="black", font=font, anchor="mm")
    if circle:
        r = min(size) // 3
        draw.ellipse((size[0] // 2 - r, size[1] // 2 - r, size[0] // 2 + r, size[1] // 2 + r), fill=circle)
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def upload(agent, data):
    return call("POST", f"/api/agents/{agent}/images", raw=data, kind="image/png", timeout=180)


def send(agent, text, images, expected=None, client=None):
    body = {"clientMessageId": client or str(uuid.uuid4()), "text": text, "images": images,
            "expectedTurnId": expected, "question": None}
    return body, call("POST", f"/api/agents/{agent}/messages", body, timeout=240)


def text_of(item):
    return item.get("text") or "".join(c.get("text", "") for c in item.get("content", []))


def turn(d, turn_id):
    return next((t for t in d["turns"] if t["id"] == turn_id), None)


def receipt(d, client):
    return next(r for r in d["messageReceipts"] if r["input"]["clientMessageId"] == client)


def requested(agent, client):
    """How many times Core recorded sending this message (journal rows)."""
    db = sqlite3.connect(f"file:{LAB / 'core-data/workspace.sqlite'}?mode=ro", uri=True)
    rows = db.execute("SELECT data FROM journal WHERE agent_id=? AND kind='message/requested'", [agent]).fetchall()
    return sum(1 for (data,) in rows if json.loads(data)["input"]["clientMessageId"] == client)


def shown_images(item):
    return [Path(c["path"]).name for c in item.get("content", []) if c.get("type") == "localImage"]


def check(condition, message, failures):
    if not condition:
        failures.append(message)


def summary(d, ids):
    return [{"id": t["id"], "status": t["status"],
             "items": [{"type": i["type"], "clientId": i.get("clientId"), "delivery": i.get("_yuzunoDelivery"),
                        "images": shown_images(i), "text": text_of(i)[:200]}
                       for i in t["items"] if i["type"] in ("userMessage", "agentMessage")]}
            for t in d["turns"] if t["id"] in ids]


def replies(t):
    return " ".join(text_of(i) for i in t["items"] if i["type"] == "agentMessage")


def start():
    state = load()
    if state.get("pid"):
        raise SystemExit("A lab Core is recorded as running; run stop first.")
    state["dailyBefore"] = daily()
    launch(state)
    print(json.dumps({"core": BASE, "started": state["started"]}, indent=2))


def idle(d):
    return d["agent"]["status"] == "idle" and all(t["status"] != "inProgress" for t in d["turns"])


def new_turn():
    state = load()
    agent = new_agent(state, "T-31 new")
    code = picture((900, 360), "#ffe066", code="K7Q4")
    circle = picture((600, 600), "white", circle="#1f5fd6")
    # Larger than Claude's budget: Core sends a fitted copy, the turn shows the original.
    large = picture((3000, 1200), "#c8f0c8", code="Z9M2")
    ids = [upload(agent, data)["id"] for data in (code, circle, large)]
    failures = []
    body, first = send(agent, "What code is written in the first image, and what shape and color fill the second? "
                              "Answer in one short line.", ids[:2])
    d = wait(agent, idle, "the first reply", 300)
    t = turn(d, first["turnId"])
    answer = replies(t)
    user = next(i for i in t["items"] if i["type"] == "userMessage")
    check(first["status"] == "accepted", f"first receipt {first}", failures)
    check(shown_images(user) == ids[:2], f"the turn does not show its images: {shown_images(user)}", failures)
    check("K7Q4" in answer.upper(), f"the code was not read: {answer}", failures)
    check("circle" in answer.lower() and "blue" in answer.lower(), f"the shape was not seen: {answer}", failures)
    # The same id with other images is a different message, never sent.
    try:
        send(agent, body["text"], ids[1:3], client=body["clientMessageId"])
        failures.append("a reused id with other images was accepted")
    except RuntimeError as error:
        check("不同的内容" in str(error), f"unexpected refusal: {error}", failures)
    check(requested(agent, body["clientMessageId"]) == 1, "the first message was sent more than once", failures)
    # An image alone, fitted by Core first.
    _, alone = send(agent, "", ids[2:])
    d = wait(agent, idle, "the reply to the image alone", 300)
    t2 = turn(d, alone["turnId"])
    alone_answer = replies(t2)
    fitted = sorted(p.name for p in (LAB / "core-data/input-images" / agent).glob(f"{ids[2]}.claude.*"))
    check(alone["status"] == "accepted", f"image-only receipt {alone}", failures)
    check(shown_images(next(i for i in t2["items"] if i["type"] == "userMessage")) == ids[2:], "image-only turn", failures)
    check(len(fitted) == 1, f"no fitted copy for Claude: {fitted}", failures)
    check("Z9M2" in alone_answer.upper(), f"the large image was not read: {alone_answer}", failures)
    previews = [len(call("GET", f"/api/agents/{agent}/images/{i}?thumb=true")) > 0 for i in ids]
    check(all(previews), "a preview could not be read back", failures)
    result = {"agent": agent, "images": ids, "fitted": fitted, "first": first, "imageOnly": alone,
              "answers": [answer, alone_answer], "failures": failures,
              "turns": summary(d, [first["turnId"], alone["turnId"]])}
    record("new", result)
    print(json.dumps({k: result[k] for k in ("answers", "fitted", "failures")}, indent=2, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


def follow():
    state = load()
    agent = new_agent(state, "T-31 follow")
    image = upload(agent, picture((900, 360), "#ffd6e8", code="P5X8"))["id"]
    steps = [STEP.format(s=8, n=n) for n in (1, 2, 3)]
    _, started = send(agent, "T-31 acceptance. Use the Bash tool three separate times, one after another, waiting for "
                             "each: " + ", then ".join(f"`{s}`" for s in steps)
                      + ". Do not combine them. Then reply with one short sentence.", [])
    turn_id = started["turnId"]
    wait(agent, lambda d: any(i["type"] == "claudeToolUse" for i in turn(d, turn_id)["items"]), "the first tool")
    body, first = send(agent, "Also end your final sentence with the code written in this image.", [image], turn_id)
    d = wait(agent, idle, "the turn to end", 400)
    time.sleep(2)
    d = detail(agent)
    final = receipt(d, body["clientMessageId"])
    holder = turn(d, final["turnId"]) if final.get("turnId") else None
    failures = []
    check(first["status"] == "queued", f"first receipt {first['status']}: queued at Claude, not read", failures)
    check(final["status"] == "accepted" and holder is not None, f"not confirmed read: {final}", failures)
    item = holder and next((i for i in holder["items"] if i.get("clientId") == body["clientMessageId"]), None)
    check(item is not None and shown_images(item) == [image] and "_yuzunoDelivery" not in item,
          f"the follow-up is not shown, read, with its image: {item}", failures)
    check(holder is not None and "P5X8" in replies(holder).upper(), f"the image was not read: {holder and replies(holder)}",
          failures)
    check(requested(agent, body["clientMessageId"]) == 1, "sent more than once", failures)
    result = {"agent": agent, "turnId": turn_id, "image": image, "firstReceipt": first["status"], "finalReceipt": final,
              "how": None if holder is None else ("same turn" if final["turnId"] == turn_id else "its own next turn"),
              "failures": failures, "turns": summary(d, [t["id"] for t in d["turns"]])}
    record("follow", result)
    print(json.dumps({k: result[k] for k in ("firstReceipt", "how", "failures")}, indent=2, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


def stop():
    state = load()
    halt(state)
    after = daily()
    print(json.dumps({"unchanged": state.get("dailyBefore") == after, "receipt": state.get("receipts", [])[-1:]}, indent=2))


if __name__ == "__main__":
    {"start": start, "new": new_turn, "follow": follow, "stop": stop}[sys.argv[1]]()
