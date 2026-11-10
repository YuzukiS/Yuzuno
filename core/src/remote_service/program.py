"""The remote session program: hello, frames, and a bounded exit.

Core uploads this file once per digest and starts it through boot.py. It reads
newline-delimited JSON frames, answers ping and watch, and writes one bye when
it stops. Sampling and the connection manager are later slices; this one still
tracks in-flight reads and registered children so its exit order is the final
one. It uses only the standard library and Python 3.6 syntax.
"""
import hashlib
import json
import os
import platform
import re
import select
import shlex
import subprocess
import sys
import threading
import time

PROTOCOL = 1
FRAME_LIMIT = 256 * 1024
QUEUE_LIMIT = 64
CHILD_OUTPUT = 64 * 1024
HOST = re.compile(r"[0-9a-f]{32}")


def seconds(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)


SILENCE = seconds("YUZUNO_REMOTE_SILENCE", 30)
WRITE_STALL = seconds("YUZUNO_REMOTE_WRITE_STALL", 30)
READ_WAIT = seconds("YUZUNO_REMOTE_READ_WAIT", 2)
CHILD_WAIT = seconds("YUZUNO_REMOTE_CHILD_WAIT", 1)
CHILD_TIMEOUT = seconds("YUZUNO_REMOTE_CHILD_TIMEOUT", 5)
BYE_WAIT = seconds("YUZUNO_REMOTE_BYE_WAIT", 1)

QUEUE_LOCK = threading.Lock()
CONTROL = []
LOAD = [None]
WAKE = threading.Event()
FINISHING = False
STOPPING = False
BYE_DONE = threading.Event()
SHUTDOWN_LOCK = threading.Lock()
SAMPLE_BUSY = [False]


class Deadline(Exception):
    pass


class TooMuch(Exception):
    pass


class Reads:
    def __init__(self):
        self.lock = threading.Lock()
        self.active = set()

    def begin(self, key):
        with self.lock:
            self.active.add(key)

    def end(self, key):
        with self.lock:
            self.active.discard(key)

    def wait(self, limit):
        end = time.monotonic() + limit
        while True:
            with self.lock:
                if not self.active:
                    return True
            if time.monotonic() >= end:
                with self.lock:
                    return not self.active
            time.sleep(0.02)


class Children:
    def __init__(self):
        self.lock = threading.Lock()
        self.live = {}
        self.stuck = set()

    def spawn(self, kind, argv, capture=False):
        with self.lock:
            if kind in self.stuck or kind in self.live:
                return None
        try:
            process = subprocess.Popen(
                argv, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, close_fds=True)
        except OSError:
            return None
        with self.lock:
            self.live[kind] = process
        return process

    def forget(self, kind):
        with self.lock:
            self.live.pop(kind, None)

    def stop_all(self):
        with self.lock:
            items = list(self.live.items())
        for _, process in items:
            try:
                process.kill()
            except OSError:
                pass
        clean = True
        for kind, process in items:
            try:
                process.wait(timeout=CHILD_WAIT)
            except subprocess.TimeoutExpired:
                with self.lock:
                    self.stuck.add(kind)
                clean = False
            else:
                self.forget(kind)
        with self.lock:
            return clean and not self.live and not self.stuck


READS = Reads()
CHILDREN = Children()


def read_text(path):
    with open(path, "r") as source:
        return source.read()


def parse_ioreg(out):
    found = re.search(r'"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"', out)
    if not found:
        return None
    value = found.group(1).replace("-", "").lower()
    return value if HOST.fullmatch(value) else None


def host_id():
    override = os.environ.get("YUZUNO_JOBS_MACHINE_ID_FILE")
    if platform.system() == "Darwin" and not override:
        out = run_bounded("ioreg", ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
        value = parse_ioreg(out.decode("utf-8", "replace")) if out else None
        if value:
            return hashlib.sha256(("yuzuno-jobs-host-v1:" + value).encode("utf-8")).hexdigest()[:32]
        return None
    paths = [override] if override else ["/etc/machine-id", "/var/lib/dbus/machine-id"]
    for path in paths:
        try:
            value = read_text(path).strip()
        except OSError:
            continue
        if HOST.fullmatch(value):
            return hashlib.sha256(("yuzuno-jobs-host-v1:" + value).encode("utf-8")).hexdigest()[:32]
    return None


def boot_id():
    override = os.environ.get("YUZUNO_JOBS_BOOT_ID_FILE")
    if override:
        try:
            return read_text(override).strip() or None
        except OSError:
            return None
    if platform.system() == "Darwin":
        out = run_bounded("sysctl", ["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"])
        return out.decode("utf-8", "replace").strip() if out else None
    try:
        return read_text("/proc/sys/kernel/random/boot_id").strip() or None
    except OSError:
        return None


def account_key(host, root):
    if host is None or not root:
        return None
    try:
        real = os.path.realpath(root)
    except OSError:
        return None
    value = "yuzuno-remote-account-v1:" + host + ":" + str(os.getuid()) + ":" + real
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]


def version():
    given = os.environ.get("YUZUNO_REMOTE_DIGEST")
    if given:
        return given
    try:
        hasher = hashlib.sha256()
        with open(__file__, "rb") as source:
            while True:
                chunk = source.read(65536)
                if not chunk:
                    break
                hasher.update(chunk)
        return hasher.hexdigest()
    except OSError:
        return ""


def run_bounded(kind, argv):
    try:
        process = CHILDREN.spawn(kind, argv, capture=True)
    except OSError:
        return None
    if process is None:
        return None
    output = bytearray()
    end = time.monotonic() + CHILD_TIMEOUT
    try:
        while True:
            left = end - time.monotonic()
            if left <= 0:
                raise Deadline()
            ready, _, _ = select.select([process.stdout], [], [], left)
            if not ready:
                raise Deadline()
            data = os.read(process.stdout.fileno(), 65536)
            if not data:
                break
            output.extend(data)
            if len(output) > CHILD_OUTPUT:
                raise TooMuch()
        code = process.wait(timeout=CHILD_WAIT)
        CHILDREN.forget(kind)
        return bytes(output) if code == 0 else None
    except (Deadline, TooMuch, subprocess.TimeoutExpired, OSError):
        try:
            process.kill()
        except OSError:
            pass
        try:
            process.wait(timeout=CHILD_WAIT)
            CHILDREN.forget(kind)
        except subprocess.TimeoutExpired:
            with CHILDREN.lock:
                CHILDREN.stuck.add(kind)
        return None
    finally:
        try:
            process.stdout.close()
        except Exception:
            pass


def json_line(value):
    return json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n"


def enqueue(value):
    data = json_line(value)
    with QUEUE_LOCK:
        if len(CONTROL) >= QUEUE_LIMIT:
            full = True
        else:
            CONTROL.append(data)
            full = False
    if full:
        shutdown(5)
    else:
        WAKE.set()


def writer():
    pending = b""
    pending_since = None
    while True:
        with QUEUE_LOCK:
            if pending:
                data = pending
            elif CONTROL:
                data = CONTROL.pop(0)
                # Keep it until it is fully written: the next select or write
                # may fail, and a frame taken off the queue must not vanish.
                pending = data
            elif LOAD[0] is not None:
                data = LOAD[0]
                LOAD[0] = None
                pending = data
            else:
                data = None
            finishing = FINISHING
        if data is None:
            if finishing:
                BYE_DONE.set()
                return
            WAKE.wait(1.0)
            WAKE.clear()
            continue
        if pending_since is None:
            pending_since = time.monotonic()
        if time.monotonic() - pending_since > WRITE_STALL:
            shutdown(5)
            return
        try:
            _, writable, _ = select.select([], [1], [], min(1.0, WRITE_STALL))
        except OSError:
            shutdown(5)
            return
        if not writable:
            continue
        try:
            wrote = os.write(1, data)
        except InterruptedError:
            continue
        except BlockingIOError:
            continue
        except OSError:
            shutdown(5)
            return
        if wrote:
            pending = data[wrote:]
            pending_since = time.monotonic()
            if not pending:
                pending_since = None


def shutdown(code):
    global STOPPING, FINISHING
    with SHUTDOWN_LOCK:
        owner = not STOPPING
        if owner:
            STOPPING = True
    if not owner:
        # Another thread already owns the exit with its own code. Wait for its
        # os._exit; returning would let the caller exit 0 and hide a write
        # failure (or lose the bye it is still trying to write).
        while True:
            time.sleep(1.0)
    clean_children = CHILDREN.stop_all()
    clean_reads = READS.wait(READ_WAIT)
    clean = clean_children and clean_reads and not SAMPLE_BUSY[0]
    why = []
    if not clean_reads:
        why.append("read_pending")
    if not clean_children:
        why.append("child_stuck")
    if SAMPLE_BUSY[0]:
        why.append("sample_busy")
    with QUEUE_LOCK:
        CONTROL.append(json_line({"ev": "bye", "data": {"code": code, "clean": clean, "why": why}}))
        FINISHING = True
    WAKE.set()
    BYE_DONE.wait(BYE_WAIT)
    os._exit(code)


def hello():
    root = os.environ.get("YUZUNO_REMOTE_ROOT")
    host = host_id()
    boot = boot_id()
    return {"ev": "hello", "data": {
        "protocol": PROTOCOL,
        "version": version(),
        "sessionId": os.urandom(16).hex(),
        "hostId": host,
        "bootId": boot,
        "accountKey": account_key(host, root),
        "platform": platform.system(),
        "python": platform.python_version(),
        "load": {"cpu": None, "memory": None, "disk": None, "gpu": None,
                 "why": ["sampling_not_enabled"]},
    }}


def handle(line):
    if len(line) > FRAME_LIMIT:
        shutdown(4)
        return
    try:
        frame = json.loads(line.decode("utf-8"))
    except Exception:
        shutdown(4)
        return
    if not isinstance(frame, dict):
        shutdown(4)
        return
    ident = frame.get("id")
    op = frame.get("op")
    if op == "ping":
        enqueue({"re": ident, "ok": {}})
    elif op == "watch":
        enqueue({"re": ident, "ok": {}})
    elif op == "close":
        shutdown(0)
    else:
        enqueue({"re": ident, "err": {"code": "unknown_op"}})


def main():
    if sys.version_info < (3, 6):
        return 3
    thread = threading.Thread(target=writer)
    thread.daemon = True
    thread.start()
    if os.environ.get("YUZUNO_REMOTE_TEST_HOLD_READ"):
        READS.begin("test")
    child = os.environ.get("YUZUNO_REMOTE_TEST_CHILD")
    if child:
        parts = shlex.split(child)
        if parts:
            CHILDREN.spawn("test", parts)
    enqueue(hello())
    last_frame = time.monotonic()
    buffer = b""
    while True:
        if time.monotonic() - last_frame > SILENCE:
            shutdown(6)
            return 6
        try:
            ready, _, _ = select.select([0], [], [], 1.0)
        except OSError:
            shutdown(4)
            return 4
        if not ready:
            continue
        try:
            data = os.read(0, 65536)
        except InterruptedError:
            continue
        except OSError:
            shutdown(0)
            return 0
        if not data:
            shutdown(0)
            return 0
        buffer += data
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            last_frame = time.monotonic()
            if len(line) > FRAME_LIMIT:
                shutdown(4)
                return 4
            handle(line)
        if len(buffer) > FRAME_LIMIT:
            shutdown(4)
            return 4


if __name__ == "__main__":
    sys.exit(main())
