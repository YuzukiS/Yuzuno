"""A scripted remote session for link_tests.rs: one way to behave per mode.

Run by a test's stand-in for OpenSSH as `python3 -I -B link_fake.py MODE LAB
DIGEST`. It reads Core's first line byte by byte (so nothing after it is
taken), writes every frame it receives to LAB/frames, and answers as MODE
says. Test code only: Core never uploads or runs this file.
"""
import fcntl
import json
import os
import sys
import time

MODE, LAB, DIGEST = sys.argv[1], sys.argv[2], sys.argv[3]
MARK = "YUZUNO-REMOTE "
F_SETPIPE_SZ = 1031


def out(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    view = memoryview(data)
    while view:
        view = view[os.write(1, view):]


def frame(value):
    out(json.dumps(value, separators=(",", ":")) + "\n")


def readline():
    data = bytearray()
    while True:
        byte = os.read(0, 1)
        if not byte:
            return None
        if byte == b"\n":
            return bytes(data)
        data.extend(byte)


def record(value):
    with open(os.path.join(LAB, "frames"), "a") as frames:
        frames.write(json.dumps(value) + "\n")


FIRST = json.loads(readline().decode("utf-8"))
NONCE = FIRST["nonce"]
record({"first": FIRST})


def marked(value):
    out(MARK + NONCE + " " + json.dumps(value, separators=(",", ":")) + "\n")


def hello(**changes):
    data = {
        "protocol": 1, "version": DIGEST, "sessionId": os.urandom(16).hex(),
        "hostId": None, "bootId": None, "accountKey": None,
        "platform": "Linux", "python": "3.12.4",
        "load": {"cpu": "proc-stat", "memory": "meminfo", "disk": "statvfs", "gpu": None,
                 "why": ["gpu:not_enabled"]},
    }
    data.update(changes)
    frame({"ev": "hello", "data": data})


def load(window):
    return {"ev": "load", "data": {
        "cpu": {"pct": 12.5, "windowMs": window, "cores": 4, "ageMs": 100},
        "memory": {"totalMiB": 1000.0, "usedMiB": 400.0, "availableMiB": 600.0, "measure": "meminfo",
                   "ageMs": 100},
        "disks": [{"roles": ["root"], "totalMiB": 2000.0, "availableMiB": 500.0, "ageMs": 100}],
        "gpu": None, "why": ["gpu:not_enabled"]}}


def online():
    marked({"ready": True})
    hello()


def serve(bye=None, code=0, loads=1):
    """Answer until close (bye, then exit `code`) or stdin's end (exit 0)."""
    while True:
        line = readline()
        if line is None:
            os._exit(0)
        request = json.loads(line.decode("utf-8"))
        record(request)
        op = request.get("op")
        if op == "ping":
            frame({"re": request["id"], "ok": {}})
        elif op == "watch":
            frame({"re": request["id"], "ok": {}})
            for window in range(loads):
                frame(load(window))
        elif op == "close":
            if bye is not None:
                frame({"ev": "bye", "data": bye})
            os._exit(code)


CLEAN = {"code": 0, "clean": True, "why": []}

if MODE == "online":
    online()
    serve(CLEAN)
elif MODE == "bye-read-pending":
    online()
    serve({"code": 0, "clean": False, "why": ["read_pending"]})
elif MODE == "bye-child-stuck":
    online()
    serve({"code": 0, "clean": False, "why": ["child_stuck"]})
elif MODE == "no-bye":
    online()
    serve(None)
elif MODE == "exit-1":
    online()
    serve(CLEAN, code=1)
elif MODE == "flood":
    online()
    serve(CLEAN, loads=20000)
elif MODE == "stderr-flood":
    # 1 MiB on stderr before anything else: it blocks unless Core drains it.
    os.write(2, b"e" * (1024 * 1024))
    online()
    serve(CLEAN)
elif MODE == "need-twice":
    marked({"need": True})
    count = int(readline())
    left = count
    while left:
        left -= len(os.read(0, left))
    marked({"need": True})
    time.sleep(60)
elif MODE == "bad-hello":
    marked({"ready": True})
    hello(sessionId="not-hex")
    time.sleep(60)
elif MODE == "version":
    marked({"ready": True})
    hello(version="2" * 64)
    time.sleep(60)
elif MODE == "forged":
    # Only lines that look like a session, none marked with this nonce.
    out(MARK + "f" * 32 + ' {"ready":true}\n')
    hello()
    os._exit(0)
elif MODE == "ready-255":
    marked({"ready": True})
    os.write(2, b"ssh: connect to host box-a port 22: Connection refused\n")
    os._exit(255)
elif MODE == "partial":
    online()
    # Bytes, never a newline: no complete frame.
    while True:
        out(b"x")
        time.sleep(0.05)
elif MODE == "oversize":
    online()
    out(b"x" * (256 * 1024 + 1))
    time.sleep(60)
elif MODE == "exact":
    online()
    pad = 256 * 1024 - len('{"re":0,"ok":{},"pad":""}')
    out('{"re":0,"ok":{},"pad":"' + "p" * pad + '"}\n')
    serve(CLEAN)
elif MODE == "after-bye":
    online()
    readline()
    frame({"ev": "bye", "data": CLEAN})
    frame({"re": 0, "ok": {}})
    time.sleep(60)
elif MODE == "eof-alive":
    online()
    with open(os.path.join(LAB, "frames"), "a") as frames:
        frames.write("{}\n")
    os.close(1)
    os.execvp("sleep", ["sleep", "300"])
elif MODE == "slow-boot":
    time.sleep(60)
elif MODE == "need-no-read":
    # A one-page stdin that is never read: the upload cannot go through.
    fcntl.fcntl(0, F_SETPIPE_SZ, 4096)
    marked({"need": True})
    time.sleep(60)
elif MODE == "no-read":
    fcntl.fcntl(0, F_SETPIPE_SZ, 4096)
    online()
    # Frames keep coming, but stdin is never read again.
    while True:
        frame({"re": 0, "ok": {}})
        time.sleep(0.05)
elif MODE == "epipe":
    # stdin closes, then the boot step asks for the program anyway.
    os.close(0)
    marked({"need": True})
    time.sleep(0.3)
    marked({"error": {"code": "upload_short", "msg": "eof"}})
    os._exit(3)
else:
    sys.exit("unknown mode " + MODE)
