"""The remote session program: hello, frames, load samples and a bounded exit.

Core uploads this file once per digest and starts it through boot.py. It reads
newline-delimited JSON frames, answers ping, starts sampling on watch, and
writes one bye when it stops, always as its last frame.

Sampling. Three daemon threads, cpu, memory and disk, each write only their
own cache entry and never stdout; every LOAD_PERIOD the writer turns the
caches into the one latest load frame.

  cpu, Linux      /proc/stat's aggregate line every 2 s. The first 8 fields
                  (guest and guest_nice are already inside user and nice);
                  idle = idle + iowait; pct = 100 * dbusy / dtotal over all
                  CPUs, dbusy clipped to [0, dtotal]; dtotal <= 0 is null
                  (counter_reset). cores counts the cpuN lines.
  cpu, Darwin     host_statistics(HOST_CPU_LOAD_INFO) ticks through ctypes
                  every 2 s, by the same window rule; cores is os.cpu_count().
  memory, Linux   /proc/meminfo MemTotal and MemAvailable every 2 s; without
                  MemAvailable it is null, never MemFree.
  memory, Darwin  vm_stat every 5 s: (free + speculative + inactive) times
                  its page size; hw.memsize once per session. An estimate.
  disk            os.stat and os.statvfs of the watched data root every 5 s,
                  through Reads; f_bavail is the space this account can use.

Ages and windows use the monotonic clock. A load never carries a path.

Job records (YN-83 S2 PR4). While Core holds remote Jobs on this machine it
names their attempts with `jobs`, as one numbered set that replaces the one
before. A scanner thread then lstats, every LOAD_PERIOD, each attempt's fixed
record files under <root>/jobs/<job>/<attempt>/ (RECORDS), and notes which
attempts' (exists, inode, size, mtime) changed. It never opens, follows or
writes a file there, nor touches `lock` or `supervisor.lock`; a folder on the
way that is a link is not read through. One scan is one bounded read, by the
rules of Reads (SCANS). Every LOAD_PERIOD while the set is not empty the
writer sends a jobs event: the set the newest scan was for, its age, every
attempt that changed since the last jobs event written (each kept until one
that names it is written whole) and, when the scan did not answer,
`unanswered`. It says only that a record changed: Core then asks the Jobs
helper, whose answer alone is the attempt's state.

One gate. STOPPING, the busy marks, reads in flight and the child registry
change only under GATE, and each start (a sample, a read, a child) is checked
and registered in the same critical section, so nothing new starts once the
exit has begun. Linux sampling starts no child process and opens no socket.
It uses only the standard library and Python 3.6 syntax.
"""
import hashlib
import json
import math
import os
import re
import select
import shlex
import stat
import subprocess
import sys
import threading
import time

PROTOCOL = 1
FRAME_LIMIT = 256 * 1024
QUEUE_LIMIT = 64
CHILD_OUTPUT = 64 * 1024
HOST = re.compile(r"[0-9a-f]{32}")
ROOT_PART = re.compile(r"[A-Za-z0-9._-]+")
# os.uname is one system call; platform.system() runs `uname -p` on Python
# before 3.9, and a Linux session starts no child.
SYSTEM = os.uname().sysname


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

# Design v4 A8: a load every 2 s; cpu and memory every 2 s (Darwin memory
# every 5 s); disk every 5 s with one 5 s wait; at most 4 disk reads out.
LOAD_PERIOD = 2.0
CPU_PERIOD = 2.0
MEMORY_PERIOD = 2.0
DARWIN_MEMORY_PERIOD = 5.0
DISK_PERIOD = 5.0
DISK_TIMEOUT = 5.0
DISK_READS = 4
VM_STAT = ["/usr/bin/vm_stat"]
MEMSIZE = ["/usr/sbin/sysctl", "-n", "hw.memsize"]
LIBSYSTEM = "/usr/lib/libSystem.B.dylib"
HOST_CPU_LOAD_INFO = 3

# S2 design v3 §3.5: a jobs set names at most 64 attempts, maxJobs' ceiling
# (remote.rs MAX_JOBS_RANGE), by remote_job.py's ID; a scan waits 5 s, as a
# disk read does, and at most one is out.
JOBS_LIMIT = 64
JOB_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
SCAN_TIMEOUT = 5.0
# The records remote_job.py writes in an attempt's folder, each <name>.json.
RECORDS = ("intent", "launching", "started", "limits", "stopping", "cancel", "paused", "resumed",
           "artifacts", "result", "fenced", "supervisor")

QUEUE_LOCK = threading.Lock()
CONTROL = []
LOAD = [None]
# The newest jobs event and the changes it carries, waiting for the writer.
JOBS_OUT = [None]
PUBLISH = [True]
WAKE = threading.Event()
FINISHING = False
BYE_DONE = threading.Event()

# The set Core named (its version and attempts, in order), what the last scan
# found of each attempt, the changes not yet written (attempt -> a count, so a
# change after an event was built is not cleared by it), and the newest scan:
# (version, monotonic time, why) or None.
JOBS_LOCK = threading.Lock()
JOBS = {"set": None, "attempts": [], "seen": {}, "changed": {}, "count": 0, "scan": None,
        "started": False}
JOBS_WAKE = threading.Event()

GATE = threading.Condition(threading.Lock())
STOPPING = False
STOP = threading.Event()
BUSY = {"cpu": False, "memory": False, "disk": False}
# (value or None, monotonic time or None, why or None) for each kind.
CACHE = {"cpu": (None, None, "warming"), "memory": (None, None, "warming"),
         "disk": (None, None, "pending")}
WATCH = {"path": None, "started": False}


class Deadline(Exception):
    pass


def begin(kind):
    """Mark one sample of `kind` as running, unless the exit has begun."""
    with GATE:
        if STOPPING:
            return False
        BUSY[kind] = True
        return True


def end(kind):
    with GATE:
        BUSY[kind] = False
        GATE.notify_all()


class Out(object):
    def __init__(self):
        self.started = time.monotonic()
        self.result = None


class Reads(object):
    """Disk reads still waiting on their filesystem, as jobs/disk.rs keeps them.

    A read that timed out keeps its thread until the kernel answers, which on
    a hung mount may be never. So a path with a read out shares it; once that
    read has gone unanswered past the timeout the path is unanswered at once,
    without another thread, until it returns; and at most `limit` reads are
    out together. Each read is registered under GATE, never after STOPPING.
    """

    def __init__(self, limit, timeout, read):
        self.limit = limit
        self.timeout = timeout
        self.read = read
        self.out = {}

    def sample(self, path):
        with GATE:
            if STOPPING:
                return {"error": "stopping", "permanent": False}
            out = self.out.get(path)
            if out is None:
                if len(self.out) >= self.limit:
                    return {"error": "busy", "permanent": False}
                out = Out()
                self.out[path] = out
                thread = threading.Thread(target=self.run, args=(path, out))
                thread.daemon = True
                try:
                    thread.start()
                except RuntimeError:
                    del self.out[path]
                    return {"error": "io", "permanent": False}
            elif time.monotonic() - out.started >= self.timeout:
                return {"error": "unanswered", "permanent": False}
            end_at = out.started + self.timeout
            while out.result is None and not STOPPING:
                left = end_at - time.monotonic()
                if left <= 0:
                    break
                GATE.wait(left)
            if out.result is not None:
                return out.result
            return {"error": "stopping" if STOPPING else "timeout", "permanent": False}

    def run(self, path, out):
        try:
            result = self.read(path)
        except Exception:
            result = {"error": "io", "permanent": False}
        with GATE:
            out.result = result
            if self.out.get(path) is out:
                del self.out[path]
            GATE.notify_all()

    def hold(self, key):
        """A read that never returns (the PR2 exit test)."""
        with GATE:
            self.out[key] = Out()


class Children(object):
    """Child processes, at most one of each kind, registered under GATE.

    A child that could not be reaped stays registered as stuck, and no child
    of its kind starts again until that same process is confirmed reaped.
    """

    def __init__(self):
        self.live = {}
        self.stuck = {}
        self.popen = subprocess.Popen

    def reap(self, process, timeout):
        try:
            process.wait(timeout=timeout)
            return True
        except subprocess.TimeoutExpired:
            return False

    def spawn(self, kind, argv, capture=True):
        with GATE:
            if STOPPING:
                return None, "stopping"
            held = self.stuck.get(kind)
            if held is not None:
                if not self.reap(held, 0):
                    return None, "child_stuck"
                del self.stuck[kind]
            if kind in self.live:
                return None, "child_busy"
            try:
                process = self.popen(
                    argv, stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, close_fds=True)
            except (OSError, ValueError):
                return None, "child_failed"
            self.live[kind] = process
            return process, None

    def settle(self, kind, process, reaped):
        """Record what became of this exact process."""
        with GATE:
            if self.live.get(kind) is process:
                del self.live[kind]
            if reaped:
                if self.stuck.get(kind) is process:
                    del self.stuck[kind]
            else:
                self.stuck[kind] = process
            GATE.notify_all()

    def stop_all(self):
        with GATE:
            items = list(self.live.items()) + list(self.stuck.items())
        for _, process in items:
            try:
                process.kill()
            except OSError:
                pass
        for kind, process in items:
            self.settle(kind, process, self.reap(process, CHILD_WAIT))


CHILDREN = Children()


def read_text(path):
    with open(path, "r") as source:
        return source.read()


def one_decimal(value):
    return math.floor(value * 10 + 0.5) / 10.0


def mib(count):
    return one_decimal(count / 1048576.0)


def run_bounded(kind, argv):
    """Run one registered child: at most CHILD_TIMEOUT and CHILD_OUTPUT bytes.

    Returns (stdout, None) on exit 0, else (None, why). A child past its limit
    is killed and waited for CHILD_WAIT; one that is still not reaped is left
    registered as stuck.
    """
    process, why = CHILDREN.spawn(kind, argv)
    if process is None:
        return None, why
    output = bytearray()
    failure = None
    end_at = time.monotonic() + CHILD_TIMEOUT
    try:
        while True:
            left = end_at - time.monotonic()
            if left <= 0:
                failure = "child_timeout"
                break
            ready, _, _ = select.select([process.stdout], [], [], left)
            if not ready:
                failure = "child_timeout"
                break
            data = os.read(process.stdout.fileno(), 65536)
            if not data:
                break
            output.extend(data)
            if len(output) > CHILD_OUTPUT:
                failure = "child_output"
                break
    except OSError:
        failure = "child_failed"
    finally:
        try:
            process.stdout.close()
        except Exception:
            pass
    if failure is None:
        if CHILDREN.reap(process, CHILD_WAIT):
            CHILDREN.settle(kind, process, True)
            if process.returncode == 0:
                return bytes(output), None
            return None, "child_failed"
        failure = "child_timeout"
    try:
        process.kill()
    except OSError:
        pass
    reaped = CHILDREN.reap(process, CHILD_WAIT)
    CHILDREN.settle(kind, process, reaped)
    return None, failure if reaped else "child_stuck"


def parse_ioreg(out):
    found = re.search(r'"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"', out)
    if not found:
        return None
    value = found.group(1).replace("-", "").lower()
    return value if HOST.fullmatch(value) else None


def host_id():
    override = os.environ.get("YUZUNO_JOBS_MACHINE_ID_FILE")
    if SYSTEM == "Darwin" and not override:
        out, _ = run_bounded("ioreg", ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
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
    if SYSTEM == "Darwin":
        out, _ = run_bounded("sysctl", ["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"])
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


# CPU.

def parse_proc_stat(text):
    """/proc/stat's aggregate line as (total, idle) ticks, and its cpuN lines."""
    counters = None
    cores = 0
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            continue
        name = fields[0]
        if name == "cpu":
            try:
                values = [int(value) for value in fields[1:9]]
            except ValueError:
                return None
            if len(values) < 4:
                return None
            idle = values[3] + (values[4] if len(values) > 4 else 0)
            counters = (sum(values), idle)
        elif name.startswith("cpu") and name[3:].isdigit():
            cores += 1
    if counters is None:
        return None
    return counters[0], counters[1], cores


def darwin_counters(ticks):
    """HOST_CPU_LOAD_INFO's user, system, idle and nice ticks as (total, idle)."""
    if ticks is None or len(ticks) != 4:
        return None
    return sum(ticks), ticks[2]


def cpu_window(before, after):
    """The busy share of all CPUs between two (total, idle, monotonic) readings."""
    total = after[0] - before[0]
    window = after[2] - before[2]
    if total <= 0 or window <= 0:
        return None, "counter_reset"
    busy = (after[0] - min(after[1], after[0])) - (before[0] - min(before[1], before[0]))
    busy = min(max(busy, 0), total)
    return {"pct": one_decimal(100.0 * busy / total), "windowMs": int(window * 1000)}, None


def read_linux_cpu():
    parsed = parse_proc_stat(read_text("/proc/stat"))
    if parsed is None:
        return None, None, "unreadable"
    return (parsed[0], parsed[1]), parsed[2] or None, None


class Mach(object):
    """host_statistics(HOST_CPU_LOAD_INFO) through ctypes; mach_host_self once."""

    def __init__(self):
        self.call = None
        self.failed = False

    def ticks(self):
        if self.failed:
            return None
        if self.call is None:
            try:
                import ctypes
                lib = ctypes.CDLL(LIBSYSTEM)
                lib.mach_host_self.restype = ctypes.c_uint
                lib.mach_host_self.argtypes = []
                lib.host_statistics.restype = ctypes.c_int
                lib.host_statistics.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_void_p,
                                                ctypes.POINTER(ctypes.c_uint)]
                host = lib.mach_host_self()
            except (ImportError, OSError, AttributeError):
                self.failed = True
                return None

            def call():
                info = (ctypes.c_uint * 4)()
                count = ctypes.c_uint(4)
                code = lib.host_statistics(host, HOST_CPU_LOAD_INFO,
                                           ctypes.cast(info, ctypes.c_void_p), ctypes.byref(count))
                if code != 0 or count.value != 4:
                    return None
                return tuple(int(value) for value in info)
            self.call = call
        return self.call()


def mach_reader():
    mach = Mach()

    def read():
        counters = darwin_counters(mach.ticks())
        if counters is None:
            return None, None, "unavailable"
        return counters, os.cpu_count(), None
    return read


def cpu_step(read):
    def step(before):
        counters, cores, why = read()
        now = time.monotonic()
        if counters is None:
            return None, (None, now, why)
        after = (counters[0], counters[1], now)
        if before is None:
            return after, (None, now, "warming")
        value, why = cpu_window(before, after)
        if value is not None:
            value["cores"] = cores
        return after, (value, now, why)
    return step


# Memory.

def parse_meminfo(text):
    """MemTotal and MemAvailable in KiB; MemAvailable is None when absent."""
    values = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] in ("MemTotal:", "MemAvailable:"):
            try:
                values[parts[0]] = int(parts[1])
            except ValueError:
                return None
    if "MemTotal:" not in values:
        return None
    return values["MemTotal:"], values.get("MemAvailable:")


def parse_vm_stat(text):
    """Available bytes: (free + speculative + inactive) times vm_stat's page size."""
    header = re.search(r"page size of (\d+) bytes", text)
    if not header:
        return None
    pages = {}
    for found in re.finditer(r"^Pages (free|speculative|inactive):\s+(\d+)\.?\s*$", text, re.M):
        pages[found.group(1)] = int(found.group(2))
    if len(pages) != 3:
        return None
    return (pages["free"] + pages["speculative"] + pages["inactive"]) * int(header.group(1))


def parse_memsize(out):
    try:
        value = int(out.decode("utf-8", "replace").strip())
    except ValueError:
        return None
    return value if value > 0 else None


def memory_value(total, available, measure):
    """MiB from bytes; available is clipped to [0, total]."""
    available = min(max(available, 0), total)
    return {"totalMiB": mib(total), "usedMiB": mib(total - available),
            "availableMiB": mib(available), "measure": measure}


def linux_memory_step(state):
    parsed = parse_meminfo(read_text("/proc/meminfo"))
    now = time.monotonic()
    if parsed is None:
        return None, (None, now, "unreadable")
    total, available = parsed
    if available is None:
        return None, (None, now, "no_mem_available")
    return None, (memory_value(total * 1024, available * 1024, "meminfo"), now, None)


def darwin_memory_step(state):
    if state is None:
        out, why = run_bounded("sysctl", MEMSIZE)
        total = parse_memsize(out) if out is not None else None
        state = {"total": total, "why": why or "unparsed"}
    if state["total"] is None:
        return state, (None, time.monotonic(), state["why"])
    out, why = run_bounded("vm_stat", VM_STAT)
    now = time.monotonic()
    if out is None:
        return state, (None, now, why)
    available = parse_vm_stat(out.decode("utf-8", "replace"))
    if available is None:
        return state, (None, now, "unparsed")
    return state, (memory_value(state["total"], available, "darwin-free+inactive"), now, None)


# Disk.

def disk_read(path):
    """One read of a watched root: its device, size and this account's space."""
    try:
        info = os.stat(path)
        if not stat.S_ISDIR(info.st_mode):
            return {"error": "not_directory", "permanent": True}
        vfs = os.statvfs(path)
    except FileNotFoundError:
        return {"error": "not_found", "permanent": True}
    except NotADirectoryError:
        return {"error": "not_directory", "permanent": True}
    except PermissionError:
        return {"error": "permission", "permanent": True}
    except OSError:
        return {"error": "io", "permanent": False}
    unit = vfs.f_frsize or vfs.f_bsize
    return {"device": info.st_dev, "totalMiB": mib(vfs.f_blocks * unit),
            "availableMiB": mib(vfs.f_bavail * unit)}


READS = Reads(DISK_READS, DISK_TIMEOUT, disk_read)


def disk_step(state):
    result = READS.sample(WATCH["path"])
    return None, (result, time.monotonic(), None)


# Job records.

def jobs_args(args):
    """A jobs request: (version, [(job, attempt)]) in its order, or None."""
    if not isinstance(args, dict):
        return None
    version = args.get("set")
    given = args.get("attempts")
    if isinstance(version, bool) or not isinstance(version, int) or not 0 <= version < 2 ** 64:
        return None
    if not isinstance(given, list) or len(given) > JOBS_LIMIT:
        return None
    attempts = []
    for item in given:
        if not isinstance(item, dict):
            return None
        job, attempt = item.get("job"), item.get("attempt")
        if not (isinstance(job, str) and JOB_ID.fullmatch(job) and isinstance(attempt, str)
                and JOB_ID.fullmatch(attempt)):
            return None
        if (job, attempt) not in attempts:
            attempts.append((job, attempt))
    return version, attempts


def lstat_of(path):
    """What lstat says of a path, without following it: None when absent."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as error:
        return ("error", error.errno)
    return (stat.S_IFMT(info.st_mode), info.st_ino, info.st_size, info.st_mtime_ns)


def plain_dir(path):
    """'dir' for a folder that is not a link, else 'absent' or 'other'."""
    found = lstat_of(path)
    if found is None:
        return "absent"
    return "dir" if found[0] == stat.S_IFDIR else "other"


def scan_attempts(root, attempts):
    """Each attempt's records as lstat sees them, or why its folder is not read.

    Like remote_job.py's attempt_dir, no folder from the root down may be a
    link: a folder on the way that is one, or is not a folder, is 'other'.
    """
    jobs = os.path.join(root, "jobs")
    top = plain_dir(root)
    if top == "dir":
        top = plain_dir(jobs)
    found = {}
    for job, attempt in attempts:
        state = top
        folder = os.path.join(jobs, job, attempt)
        for step in (os.path.join(jobs, job), folder):
            if state == "dir":
                state = plain_dir(step)
        if state == "dir":
            state = tuple(lstat_of(os.path.join(folder, name + ".json")) for name in RECORDS)
        found[(job, attempt)] = state
    return found


def scan_read(key):
    root = os.environ.get("YUZUNO_REMOTE_ROOT")
    if not root:
        return {"error": "no_root", "permanent": True}
    return {"found": scan_attempts(root, key[1])}


SCANS = Reads(1, SCAN_TIMEOUT, scan_read)


def set_jobs(version, attempts):
    """Replace the set; start the scanner once. False once the exit began."""
    with GATE:
        if STOPPING:
            return False
        with JOBS_LOCK:
            keep = set(attempts)
            JOBS["set"] = version
            JOBS["attempts"] = list(attempts)
            JOBS["seen"] = dict((key, value) for key, value in JOBS["seen"].items() if key in keep)
            JOBS["changed"] = dict((key, value) for key, value in JOBS["changed"].items() if key in keep)
            if not attempts:
                JOBS["scan"] = None
            start = bool(attempts) and not JOBS["started"]
            if start:
                JOBS["started"] = True
        if start:
            thread = threading.Thread(target=jobs_loop)
            thread.daemon = True
            thread.start()
    JOBS_WAKE.set()
    return True


FIRST = object()


def record_scan(version, result, now):
    """Note what one scan found: an attempt it saw first, or saw change, changed."""
    with JOBS_LOCK:
        if "found" not in result:
            JOBS["scan"] = (version, now, "unanswered")
            return
        for key, state in result["found"].items():
            if key not in JOBS["attempts"]:
                # Left the set while it was scanned.
                continue
            if JOBS["seen"].get(key, FIRST) != state:
                JOBS["count"] += 1
                JOBS["changed"][key] = JOBS["count"]
            JOBS["seen"][key] = state
        JOBS["scan"] = (version, now, None)


def jobs_loop():
    while True:
        started = time.monotonic()
        with JOBS_LOCK:
            version, attempts = JOBS["set"], tuple(JOBS["attempts"])
        if attempts:
            result = SCANS.sample((version, attempts))
            if result.get("error") == "stopping":
                return
            record_scan(version, result, time.monotonic())
        JOBS_WAKE.wait(max(0.0, started + LOAD_PERIOD - time.monotonic()))
        JOBS_WAKE.clear()
        if STOP.is_set():
            return


def jobs_frame(now):
    """The jobs event to send now and the changes it carries, or (None, None)."""
    with JOBS_LOCK:
        if not JOBS["attempts"] or JOBS["scan"] is None:
            return None, None
        version, at, why = JOBS["scan"]
        written = dict(JOBS["changed"])
        changed = [{"job": job, "attempt": attempt} for job, attempt in JOBS["attempts"]
                   if (job, attempt) in written]
    event = {"ev": "jobs", "data": {"set": version, "ageMs": age(now, at), "changed": changed, "why": why}}
    return json_line(event), written


def jobs_written(written):
    """A jobs event went out whole: the changes it named are told."""
    with JOBS_LOCK:
        for key, count in written.items():
            if JOBS["changed"].get(key) == count:
                del JOBS["changed"][key]


def jobs_on():
    with JOBS_LOCK:
        return bool(JOBS["attempts"])


# Sampling threads and the load frame.

def sample_loop(kind, period, step):
    state = None
    while True:
        started = time.monotonic()
        if not begin(kind):
            return
        try:
            try:
                state, entry = step(state)
            except Exception:
                state, entry = None, (None, time.monotonic(), "unreadable")
        finally:
            end(kind)
        CACHE[kind] = entry
        if STOP.wait(max(0.0, started + period - time.monotonic())):
            return


def plan():
    disk = ("disk", DISK_PERIOD, disk_step)
    if SYSTEM == "Linux":
        return [("cpu", CPU_PERIOD, cpu_step(read_linux_cpu)),
                ("memory", MEMORY_PERIOD, linux_memory_step), disk]
    if SYSTEM == "Darwin":
        return [("cpu", CPU_PERIOD, cpu_step(mach_reader())),
                ("memory", DARWIN_MEMORY_PERIOD, darwin_memory_step), disk]
    return [("cpu", CPU_PERIOD, None), ("memory", MEMORY_PERIOD, None), disk]


def start_sampling(path):
    """Start the three samplers once (a later watch only moves the disk path)."""
    with GATE:
        if STOPPING:
            return False
        WATCH["path"] = path
        if not WATCH["started"]:
            for kind, period, step in plan():
                if step is None:
                    CACHE[kind] = (None, None, "unsupported")
                    continue
                thread = threading.Thread(target=sample_loop, args=(kind, period, step))
                thread.daemon = True
                thread.start()
            WATCH["started"] = True
    WAKE.set()
    return True


def watched_path(args):
    """S1 watches one path, the data root: ~/folder or absolute, as boot.py takes it."""
    if not isinstance(args, dict):
        return None
    paths = args.get("paths")
    if not isinstance(paths, list) or len(paths) != 1 or not isinstance(paths[0], dict):
        return None
    if paths[0].get("role") != "root":
        return None
    given = paths[0].get("path")
    if not isinstance(given, str) or not given or len(given) > 1024:
        return None
    if given.startswith("~/"):
        base, rest = os.path.expanduser("~"), given[2:]
    elif given.startswith("/"):
        base, rest = "/", given[1:]
    else:
        return None
    parts = rest.split("/")
    if any(not ROOT_PART.fullmatch(part) or part in (".", "..") for part in parts):
        return None
    return os.path.join(base, *parts)


def age(now, at):
    return max(0, int((now - at) * 1000))


def load_frame(now):
    why = []
    data = {}
    for kind in ("cpu", "memory"):
        value, at, code = CACHE[kind]
        if value is None:
            data[kind] = None
            why.append(kind + ":" + (code or "unknown"))
        else:
            item = dict(value)
            item["ageMs"] = age(now, at)
            data[kind] = item
    value, at, code = CACHE["disk"]
    row = {"roles": ["root"]}
    if value is None:
        row["error"] = code or "pending"
        row["permanent"] = False
    elif "error" in value:
        row["error"] = value["error"]
        row["permanent"] = bool(value["permanent"])
    else:
        row["totalMiB"] = value["totalMiB"]
        row["availableMiB"] = value["availableMiB"]
        row["ageMs"] = age(now, at)
    data["disks"] = [row]
    data["gpu"] = None
    why.append("gpu:not_enabled")
    data["why"] = why
    return {"ev": "load", "data": data}


# Frames out.

def json_line(value):
    return json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n"


def enqueue(value):
    data = json_line(value)
    with QUEUE_LOCK:
        if FINISHING:
            # The bye is queued: nothing may follow it.
            return
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
    # The changes a jobs event in `pending` carries, told once it is written.
    pending_jobs = None
    next_load = None
    while True:
        frame = None
        jobs = None
        watched = WATCH["started"]
        if (watched or jobs_on()) and not STOPPING:
            now = time.monotonic()
            if next_load is None:
                next_load = now + LOAD_PERIOD
            elif now >= next_load:
                if watched:
                    frame = json_line(load_frame(now))
                jobs = jobs_frame(now)
                next_load = now + LOAD_PERIOD
        with QUEUE_LOCK:
            if frame is not None and PUBLISH[0]:
                LOAD[0] = frame
            if jobs is not None and jobs[0] is not None and PUBLISH[0]:
                # A newer event names every change the one it replaces did:
                # nothing is told before an event naming it is written.
                JOBS_OUT[0] = jobs
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
            elif JOBS_OUT[0] is not None:
                data, pending_jobs = JOBS_OUT[0]
                JOBS_OUT[0] = None
                pending = data
            else:
                data = None
            finishing = FINISHING
        if data is None:
            if finishing:
                BYE_DONE.set()
                return
            wait = 1.0
            if next_load is not None:
                wait = min(wait, max(0.0, next_load - time.monotonic()))
            WAKE.wait(wait)
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
                if pending_jobs is not None:
                    jobs_written(pending_jobs)
                    pending_jobs = None


# The exit.

def stop_work():
    """Begin the exit: no new sample, read or child starts after this returns.

    Also clears a load not yet taken by the writer and stops new ones; a frame
    the writer has already started stays whole. True for the first caller.
    """
    global STOPPING
    with GATE:
        owner = not STOPPING
        STOPPING = True
        GATE.notify_all()
    STOP.set()
    JOBS_WAKE.set()
    with QUEUE_LOCK:
        PUBLISH[0] = False
        LOAD[0] = None
        JOBS_OUT[0] = None
    return owner


def settle(limit):
    """Wait up to `limit` for reads in flight and running samples to finish."""
    end_at = time.monotonic() + limit
    with GATE:
        while READS.out or SCANS.out or any(BUSY.values()):
            left = end_at - time.monotonic()
            if left <= 0:
                break
            GATE.wait(left)


def unclean():
    with GATE:
        why = []
        if READS.out or SCANS.out:
            why.append("read_pending")
        if CHILDREN.live or CHILDREN.stuck:
            why.append("child_stuck")
        if any(BUSY.values()):
            why.append("sample_busy")
        return why


def shutdown(code):
    global FINISHING
    if not stop_work():
        # Another thread already owns the exit with its own code. Wait for its
        # os._exit; returning would let the caller exit 0 and hide a write
        # failure (or lose the bye it is still trying to write).
        while True:
            time.sleep(1.0)
    CHILDREN.stop_all()
    settle(READ_WAIT)
    why = unclean()
    with QUEUE_LOCK:
        LOAD[0] = None
        CONTROL.append(json_line({"ev": "bye", "data": {"code": code, "clean": not why, "why": why}}))
        FINISHING = True
    WAKE.set()
    BYE_DONE.wait(BYE_WAIT)
    os._exit(code)


# Frames in.

def sources():
    if SYSTEM == "Linux":
        return "proc-stat", "meminfo"
    if SYSTEM == "Darwin":
        return "mach", "darwin-free+inactive"
    return None, None


def hello():
    root = os.environ.get("YUZUNO_REMOTE_ROOT")
    host = host_id()
    boot = boot_id()
    cpu, memory = sources()
    why = []
    if cpu is None:
        why.extend(["cpu:unsupported", "memory:unsupported"])
    why.append("gpu:not_enabled")
    return {"ev": "hello", "data": {
        "protocol": PROTOCOL,
        "version": version(),
        "sessionId": os.urandom(16).hex(),
        "hostId": host,
        "bootId": boot,
        "accountKey": account_key(host, root),
        "platform": SYSTEM,
        "python": "%d.%d.%d" % sys.version_info[:3],
        "load": {"cpu": cpu, "memory": memory, "disk": "statvfs", "gpu": None, "why": why},
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
        path = watched_path(frame.get("args"))
        if path is None:
            enqueue({"re": ident, "err": {"code": "bad_args"}})
        elif start_sampling(path):
            enqueue({"re": ident, "ok": {}})
        else:
            enqueue({"re": ident, "err": {"code": "stopping"}})
    elif op == "jobs":
        given = jobs_args(frame.get("args"))
        if given is None:
            enqueue({"re": ident, "err": {"code": "bad_args"}})
        elif set_jobs(given[0], given[1]):
            enqueue({"re": ident, "ok": {}})
        else:
            enqueue({"re": ident, "err": {"code": "stopping"}})
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
        READS.hold("test")
    child = os.environ.get("YUZUNO_REMOTE_TEST_CHILD")
    if child:
        parts = shlex.split(child)
        if parts:
            CHILDREN.spawn("test", parts, capture=False)
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
