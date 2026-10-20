#!/usr/bin/env python3
"""Opt-in real remote image acceptance. Only new isolated Core/Agent sessions.

Requires explicit T31_REMOTE_TARGET, T31_REMOTE_CODEX and T31_CORE_BIN. Does
not copy credentials, change global configuration, or resend unknown inputs.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
TARGET = os.environ["T31_REMOTE_TARGET"]
CODEX = os.environ["T31_REMOTE_CODEX"]
CORE = Path(os.environ["T31_CORE_BIN"]).resolve(strict=True)
RUN = Path(os.environ.get("T31_RUN_DIR", ROOT / "target" / "t31-remote" / ("native-" + uuid.uuid4().hex))).resolve()
assert RUN.parent == ROOT / "target" / "t31-remote" and RUN.name.startswith("native-")
RUN.mkdir(parents=True, mode=0o700)
(RUN / "project").mkdir()
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    PORT = sock.getsockname()[1]
assert PORT != 4317
BASE = f"http://127.0.0.1:{PORT}/api"
REPORT = {"run": str(RUN), "port": PORT, "head": subprocess.check_output(
    ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
    "target": TARGET, "remoteCodex": CODEX, "binarySourceHead": os.environ.get("T31_CORE_SOURCE_HEAD"), "agents": [], "checks": [], "errors": []}
SOURCE = None
SOURCE_REPORT = None
if os.environ.get("T31_FINISH_SOURCE"):
    SOURCE = Path(os.environ["T31_FINISH_SOURCE"]).resolve(strict=True)
    assert SOURCE.parent == ROOT / "target/t31-remote" and SOURCE.name.startswith("native-") and SOURCE != RUN
    SOURCE_REPORT = json.loads((SOURCE / "report.json").read_text())
    assert SOURCE_REPORT["target"] == TARGET and SOURCE_REPORT.get("coreExit") == 0
    REPORT["sourceRun"] = str(SOURCE)
DATA = (SOURCE or RUN) / "data"


def save():
    (RUN / "report.json").write_text(json.dumps(REPORT, indent=2) + "\n")


def note(check, **details):
    REPORT["checks"].append({"check": check, **details})
    save()
    print(check, json.dumps(details), flush=True)


def api(path, body=None, method=None, raw=False):
    data = body if isinstance(body, bytes) else None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + path, data=data, method=method,
        headers={"Content-Type": "application/octet-stream" if isinstance(body, bytes) else "application/json",
                 "X-Yuzuno-Client": "desktop"})
    try:
        with urllib.request.urlopen(request, timeout=100) as response:
            return response.read() if raw else json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"HTTP {error.code} {path}: {error.read().decode()}") from None


def ssh(code, payload=None):
    command = "python3 -c " + shlex.quote(code)
    result = subprocess.run(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none",
        "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", TARGET, command],
        input=json.dumps(payload).encode() if payload is not None else b"", capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError(result.stderr.decode()[:1000])
    return json.loads(result.stdout)


def wait(predicate, label, timeout=180):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.3)
    raise TimeoutError(label)


def detail(agent):
    data = api("/agents/" + agent["id"])
    assert data["agent"]["remote"]["machine"]["target"] == TARGET
    assert data["agent"]["cwd"] == REPORT["remoteCwd"]
    return data


def ready(agent):
    data = detail(agent)
    # Codex briefly uses uncertain while its new thread is being attached;
    # a recorded error distinguishes an actual failed/unknown startup.
    if data["agent"]["status"] == "error" or (data["agent"]["status"] == "uncertain" and data["agent"].get("error")):
        REPORT["startupFailure"] = {key: data["agent"].get(key) for key in
                                    ("id", "status", "connectionState", "error")}
        save()
        raise RuntimeError(data["agent"].get("error"))
    return data if data["agent"]["connectionState"] == "connected" else None


def text(data):
    return "\n".join(item.get("text", "") for turn in data.get("turns", [])
                     for item in turn.get("items", []) if item.get("type") == "agentMessage")


def completed(agent, expected):
    data = detail(agent)
    if any(not pending.get("stale") for pending in data.get("pending", [])):
        raise RuntimeError("Native approval requires inspection; no automatic approval")
    if data["agent"]["status"] in ("error", "uncertain"):
        raise RuntimeError(data["agent"].get("error") or data["agent"]["status"])
    if any(turn.get("status") == "inProgress" for turn in data["turns"]):
        return None
    answer = text(data)
    return data if all(code in answer for code in expected) else None


def fixture(index, large=False):
    code = uuid.uuid4().hex[:6].upper()
    size = (3000, 1800) if large else (700, 360)
    picture = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(picture)
    font = ImageFont.load_default(size=220 if large else 90)
    draw.text((80 if large else 30, 80 if large else 30), code, fill="black", font=font)
    if large:
        noise = Image.frombytes("RGB", (1100, 900), os.urandom(1100 * 900 * 3))
        picture.paste(noise, (1700, 800))
        draw.rectangle((100, 600, 800, 1300), fill="red")
    else:
        draw.ellipse((40, 170, 190, 320), fill="blue")
    path = RUN / f"image-{index}.png"
    picture.save(path)
    return {"path": path, "code": code, "bytes": path.read_bytes()}


def upload(agent, image):
    result = api(f"/agents/{agent['id']}/images", image["bytes"])
    assert result["id"].startswith(hashlib.sha256(image["bytes"]).hexdigest())
    return result["id"]


def send(agent, prompt, images, turn=None):
    request = {"clientMessageId": str(uuid.uuid4()), "text": prompt, "images": images,
               "expectedTurnId": turn, "question": None}
    result = api(f"/agents/{agent['id']}/messages", request)
    agent.setdefault("messages", []).append({"input": request, "receipt": result})
    usage = os.environ.get("YUZUNO_JOB_USAGE_FILE")
    if usage:
        with open(usage, "a") as stream:
            stream.write(json.dumps({"usd": None, "source": "native image acceptance; provider cost unavailable"}) + "\n")
    save()
    assert result["status"] in ("accepted", "queued"), result
    return request, result


def exercise(harness):
    agent = api("/agents", {"name": f"T31 isolated remote {harness} images", "harness": harness,
        "cwd": REPORT["remoteCwd"], "machineId": REPORT["machineId"], "model": ""})
    REPORT["agents"].append(agent)
    save()
    current = wait(lambda: ready(agent), harness + " connection")
    if os.environ.get("T31_START_ONLY") == "1":
        note(harness + " prompt-free Core initialization", provenance=(current.get("claudeRuntime") or {}).get("provenance"))
        return agent
    catalog = api(f"/agents/{agent['id']}/models")
    if harness == "claude":
        choices = catalog["models"]
        chosen = next((model["model"] for model in choices if "haiku" in model["model"].lower()), None)
        assert chosen, "No Haiku model in this remote CLI; inspect before a more expensive test"
        api(f"/agents/{agent['id']}/settings", {"model": chosen})
    else:
        chosen = current["agent"]["model"]
        model = next(m for m in catalog["models"] if m.get("model", m.get("id")) == chosen)
        assert "image" in model.get("inputModalities", ["text", "image"])
        settings = dict(current["agent"]["settings"])
        if any(e["reasoningEffort"] == "low" for e in model["supportedReasoningEfforts"]):
            settings["reasoningEffort"] = "low"
            api(f"/agents/{agent['id']}/settings", {"model": chosen, "settings": settings})
    agent["testedModel"] = chosen
    pictures = [fixture(harness + str(i), large=(harness == "claude" and i == 0)) for i in range(4)]
    ids = [upload(agent, picture) for picture in pictures]
    agent["imageIds"] = ids
    agent["expectedCodes"] = [p["code"] for p in pictures]
    prompt = "Without tools, read the exact large code and name the colored shape in each attached image, in attachment order. Keep it brief. For later images without text, do the same."
    # The unique codes exist only in image pixels, never in the prompt.
    assert not any(p["code"] in prompt for p in pictures)
    request, receipt = send(agent, prompt, ids[:2])
    first = wait(lambda: completed(agent, [p["code"] for p in pictures[:2]]), harness + " multi-image recognition")
    agent["multiImageAnswer"] = text(first)
    duplicate = api(f"/agents/{agent['id']}/messages", request)
    assert duplicate["turnId"] == receipt["turnId"] and duplicate["status"] == receipt["status"]
    assert len(detail(agent)["turns"]) == len(first["turns"])
    try:
        api(f"/agents/{agent['id']}/messages", dict(request, images=[ids[2]]))
    except RuntimeError as error:
        agent["changedImageRejected"] = str(error)
    else:
        raise AssertionError("Same client id accepted a changed image")
    note(harness + " multi-image native recognition and request identity", agentId=agent["id"], model=chosen)
    send(agent, "", [ids[2]])
    second = wait(lambda: completed(agent, [pictures[2]["code"]]), harness + " image-only recognition")
    agent["imageOnlyAnswer"] = text(second)
    note(harness + " image-only native recognition")
    # Enough bounded output to keep a turn active while a second small image
    # crosses SSH. No command/tool approvals or deliberate environment mutation.
    _, main = send(agent, "Without tools, write a numbered list of forty short visual observations about the attached image, then repeat its large code. I will send another image while you are working.", [ids[0]])
    active = detail(agent)
    assert any(t["id"] == main["turnId"] and t["status"] == "inProgress" for t in active["turns"]), "Turn ended before follow-up; no follow-up sent"
    _, follow = send(agent, "Read the large code in this added image too; end with that code.", [ids[3]], main["turnId"])
    final = wait(lambda: completed(agent, [pictures[3]["code"]]), harness + " in-progress image recognition", timeout=240)
    agent["followUpAnswer"] = text(final)
    agent["followUpReceipt"] = follow
    (RUN / (harness + "-detail.json")).write_text(json.dumps(final, indent=2) + "\n")
    for image_id, picture in zip(ids, pictures):
        assert api(f"/agents/{agent['id']}/images/{image_id}", raw=True) == picture["bytes"]
    note(harness + " in-progress native image recognition and retained originals")
    return agent


def remote_copies(agent):
    owner = dict(workspace=REPORT["workspaceId"], agent=agent["id"], machine=REPORT["machineId"],
                 target=TARGET, harness=agent["harness"])
    key = hashlib.sha256("\0".join(owner[k] for k in ("workspace", "agent", "machine", "target", "harness")).encode()).hexdigest()
    result = ssh('''import hashlib,json,sys
from pathlib import Path
request=json.load(sys.stdin)
root=Path.home()/".yuzuno-next"/"image-cache"/request["key"]
if not root.exists():
 print(json.dumps({"exists":False}))
else:
 assert json.loads((root/"owner.json").read_text())==request["owner"]
 files=[]
 for path in root.glob("*/input-images/"+request["owner"]["agent"]+"/*"):
  assert not path.is_symlink()
  data=path.read_bytes()
  files.append({"path":str(path),"id":path.name,"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()})
 print(json.dumps({"exists":True,"files":files}))''', {"key":key,"owner":owner})
    agent["remoteCopies"] = result
    return result


def transfer_failure(agent, owner_record=False):
    copies = remote_copies(agent)
    assert copies["exists"]
    if agent["harness"] == "claude":
        assert all(f["bytes"] <= 512000 for f in copies["files"])
    file = next(f for f in copies["files"] if f["id"] == agent["imageIds"][-1])
    path = str(Path(file["path"]).parents[3] / "owner.json") if owner_record else file["path"]
    mutation = {"path":path, "agent":agent["id"], "ownerRecord":owner_record}
    ssh('''import json,os,sys
from pathlib import Path
p=json.load(sys.stdin); path=Path(p["path"])
assert "/.yuzuno-next/image-cache/" in str(path)
assert (path.name=="owner.json" and path.parent.parent.name=="image-cache") if p["ownerRecord"] else (path.parent.name==p["agent"] and path.parent.parent.name=="input-images")
assert not path.is_symlink()
if p["ownerRecord"]:
 owner=json.loads(path.read_text()); assert owner["agent"]==p["agent"]
 owner["agent"]="different-acceptance-owner"; damaged=json.dumps(owner).encode()
else: damaged=b"deliberately damaged acceptance copy"
backup=path.with_name(path.name+".validation-backup")
assert not backup.exists()
os.rename(path,backup)
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"wb") as stream: stream.write(damaged)
print("true")''', mutation)
    try:
        before = len(detail(agent)["turns"])
        request = {"clientMessageId":str(uuid.uuid4()), "text":"Read this image briefly without tools.",
                   "images":[agent["imageIds"][-1]], "expectedTurnId":None, "question":None}
        receipt = api(f"/agents/{agent['id']}/messages", request)
        assert receipt["status"] == "rejected", receipt
        retry = api(f"/agents/{agent['id']}/messages", request)
        assert retry["status"] == "rejected" and retry["input"] == receipt["input"]
        assert len(detail(agent)["turns"]) == before
        agent["transferFailureReceipt"] = receipt
        note(agent["harness"] + (" changed remote owner" if owner_record else " damaged remote copy") + " rejected before native submission; same receipt on retry")
    finally:
        ssh('''import json,os,sys
from pathlib import Path
p=json.load(sys.stdin); path=Path(p["path"])
assert "/.yuzuno-next/image-cache/" in str(path)
assert (path.name=="owner.json" and path.parent.parent.name=="image-cache") if p["ownerRecord"] else path.parent.name==p["agent"]
os.replace(path.with_name(path.name+".validation-backup"),path)
print("true")''', mutation)


core = None
try:
    REPORT["remoteCwd"] = SOURCE_REPORT["remoteCwd"] if SOURCE_REPORT else ssh('''import json,os,stat,sys
from pathlib import Path
name=json.load(sys.stdin)
assert name.startswith("t31-images-") and len(name)==43
root=Path.home()/".yuzuno-next"
for path in [root,root/"labs",root/"labs"/name]:
 path.mkdir(mode=0o700,exist_ok=True)
 info=path.lstat()
 assert stat.S_ISDIR(info.st_mode) and info.st_uid==os.getuid() and info.st_mode&0o077==0
print(json.dumps(str(path)))''', "t31-images-" + uuid.uuid4().hex)
    environment = dict(os.environ)
    environment.pop("YUZUNO_INSTALL_DIR", None)
    environment["YUZUNO_CLAUDE_BRIDGE"] = os.environ.get("T31_DIAGNOSTIC_BRIDGE", str(ROOT / "runtimes/claude/bridge.mjs"))
    log = (RUN / "core.log").open("wb")
    core = subprocess.Popen([str(CORE), "--port", str(PORT), "--data-dir", str(DATA),
        "--web-dir", str(ROOT / "web/dist"), "--cwd", str(RUN / "project")],
        cwd=ROOT, env=environment, stdout=log, stderr=log, start_new_session=True)
    def health():
        if core.poll() is not None:
            raise RuntimeError("Isolated Core exited before health")
        try:
            return api("/health")
        except OSError:
            return None
    wait(health, "isolated Core health", timeout=25)
    if SOURCE_REPORT:
        REPORT["machineId"] = SOURCE_REPORT["machineId"]
    else:
        machine = api("/machines", {"name":"T31 image acceptance Mac", "target":TARGET,
            "codex":CODEX, "defaultCwd":REPORT["remoteCwd"]})
        REPORT["machineId"] = machine["id"]
    REPORT["workspaceId"] = api("/workspace")["workspace"]["id"]
    save()
    for harness in os.environ.get("T31_HARNESSES", "codex,claude").split(","):
        if SOURCE_REPORT:
            # Continue only a positively completed image session, never an
            # unknown input. No model prompt is sent by this finishing mode.
            assert REPORT["workspaceId"] == SOURCE_REPORT["workspaceId"]
            agent = next(a for a in SOURCE_REPORT["agents"] if a["harness"] == harness)
            assert all(code in agent["followUpAnswer"] for code in agent["expectedCodes"])
            REPORT["agents"].append(agent)
            saved = detail(agent)
            assert not any(t["status"] in ("inProgress", "outcomeUnknown") for t in saved["turns"])
            identity = "claudeSessionId" if harness == "claude" else "threadId"
            session = saved["agent"][identity]
            assert session and saved["agent"]["closedAt"]
            api(f"/agents/{agent['id']}/reopen", {})
            reopened = wait(lambda: ready(agent), harness + " confirmed-session reopen")
            assert reopened["agent"][identity] == session
            assert all(code in text(reopened) for code in agent["expectedCodes"])
            for image_id in agent["imageIds"]:
                original = api(f"/agents/{agent['id']}/images/{image_id}", raw=True)
                assert hashlib.sha256(original).hexdigest() == image_id.split('.')[0]
            note(harness + " reopens the confirmed native session and retains original images without resending prompts")
        else:
            exercise(harness)
    if os.environ.get("T31_START_ONLY") == "1":
        REPORT["result"] = "PASS"
        save()
        raise SystemExit(0)
    for agent in REPORT["agents"]:
        transfer_failure(agent, owner_record=SOURCE is not None)
    save()
    subprocess.run(["node", str(ROOT / "acceptance/t31-remote/preview.mjs"), str(RUN)], check=True, timeout=120)
    note("real remote conversation thumbnails and original previews survive reload")
    for agent in REPORT["agents"]:
        api(f"/agents/{agent['id']}/close", {})
        assert remote_copies(agent)["exists"], "Close removed resume images"
        api(f"/agents/{agent['id']}", method="DELETE")
        agent["deleted"] = True
        assert not remote_copies(agent)["exists"]
        assert (DATA / "input-images" / agent["id"]).is_dir(), "Remote cleanup removed Core originals"
    note("close retains copies; explicit deletion removes owned remote copies and retains Core originals")
    REPORT["result"] = "PASS"
except BaseException as error:
    if isinstance(error, SystemExit) and error.code == 0:
        raise
    REPORT["errors"].append(str(error))
    REPORT["result"] = "FAIL"
    raise
finally:
    if core is not None and core.poll() is None:
        for agent in REPORT["agents"]:
            if agent.get("deleted"):
                continue
            try:
                api(f"/agents/{agent['id']}/close", {})
            except Exception as error:
                REPORT.setdefault("cleanupErrors", []).append(str(error))
        core.send_signal(signal.SIGINT)
        try:
            core.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(core.pid, signal.SIGKILL)
            core.wait(timeout=5)
        REPORT["coreExit"] = core.returncode
    save()
    print("REPORT", RUN / "report.json", flush=True)
