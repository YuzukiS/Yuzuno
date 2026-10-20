"""One-shot SSH helper for Yuzuno Jobs on a remote Linux machine.

A JSON request on stdin, a JSON reply on stdout. It reads no credentials
and leaves nothing resident but each attempt's own supervisor, which exits
once nothing of its command's process group is left. Each attempt has a
private folder, <root>/jobs/<jobId>/<attempt>/, under the machine's data
root that Core recorded for the attempt and names in each of its requests
(~/.yuzuno unless the machine names another; remote.rs validate_root):
  lock                 every action on the attempt holds it, one at a time
  intent.json          the start: Workspace, machine entry, this machine, its
                       boot and the request digest. Written and synced before
                       anything is launched, and never rewritten
  fenced.json          Core gave up on a start that had not arrived; a late
                       start is refused
  spec.json            what to run
  supervisor.py        the supervisor's code
  supervisor.lock      held by the supervisor for its whole life
  supervisor.json      the supervisor's process identity
  launching.json       written before the command's process is forked
  limits.json          the transient systemd scope holding the command's
                       waiting process and the limits read back from its
                       cgroup, written before started.json (only when the
                       attempt's plan limits something on this machine)
  started.json         the command's process identity (boot, PID, /proc
                       starttime, process group and session), written before
                       that process may run the command
  log-0.bin, log-1.bin the output ring (2 MiB, as for local jobs)
  cancel.json          cancellation intent
  paused.json, resumed.json
                       the last pause or resume this helper confirmed
  artifacts.json       the declared artifacts as checked after a clean exit,
                       with this attempt's id
  result.json          the outcome, written once, and only when nothing of
                       the command's process group is left

Inputs and artifacts are files on this machine. inspect (no attempt, nothing
written) reads a job's inputs for Core to freeze at submit; a start carries
them as frozen and the supervisor checks them again last thing before the
command may run, which never runs if one changed. After a clean exit it
checks each declared artifact as local jobs do, and records whether its path
already held a file before the command ran and whether that file is
unchanged: an observation, never a verdict on who wrote it.

Every request names the machine it was pinned to (expectHost, from hello)
and the Workspace, machine entry and digest of its attempt. Another machine
answers other_host and another record answers conflict; neither is ever
taken for this attempt. The reply is one line: "YUZUNO-JOBS-REPLY ", the
request's replyNonce and a space, then JSON, so that nothing the account's
login scripts print passes for it. A refusal (nothing was started) replies
{"error": ...} and exits 3.

Resources: a start carries the attempt's declared limits and the machine's
mode. This helper reads what the account can enforce (its systemd user
manager, the cgroup controllers delegated to it, whether it lingers) and
plans before the commit point: strict refuses unless every limit is held and
outlives the account's sessions; limited holds what it can and names what
is only declared. Held limits are applied to the command's process in its
own transient scope before it may run, and read back from its cgroup.

Pause and resume (as local jobs, T-107) freeze or thaw that scope through
the account's systemd and read the result back from its cgroup.events, only
once the scope is proven to be this attempt's (its name, systemd's
description and cgroup, the boot). An attempt with no scope of its own (a
record-only machine, or an account that does not linger) cannot be paused:
nothing is ever stopped with signals instead. The supervisor, outside the
scope, keeps counting the timeout while it is frozen; cancel and timeouts
thaw it before stopping its process group.

YUZUNO_JOBS_MACHINE_ID_FILE and YUZUNO_JOBS_BOOT_ID_FILE replace the
system's files, YUZUNO_JOBS_CAPABILITIES_FILE what the account can enforce
and YUZUNO_JOBS_BUSCTL the busctl program, for tests only.
"""
import platform
import pwd
import re
import shutil
import stat
import subprocess
import sys

COMMON = r'''
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import time
import uuid

SEGMENT = 1024 * 1024
PIDFD = hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")
# As for local jobs: inputs are small files; artifacts are hashed up to 1 GiB
# and parsed as JSON up to 16 MiB.
INPUT_LIMIT = 2 * 1024 * 1024
INPUTS_LIMIT = 16 * 1024 * 1024
HASH_LIMIT = 1 << 30
JSON_LIMIT = 16 * 1024 * 1024


class Unclear(Exception):
    """A record exists but cannot be read: the attempt's state is unknown."""


def read_text(path):
    with open(str(path)) as stream:
        return stream.read()


def read_json(path):
    try:
        return json.loads(read_text(path))
    except FileNotFoundError:
        return None
    except ValueError:
        raise Unclear("%s cannot be read" % Path(path).name)


def atomic(path, value):
    path = Path(path)
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex)
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(str(temporary), str(path))
    directory = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def boot_id():
    return read_text(os.environ.get("YUZUNO_JOBS_BOOT_ID_FILE") or "/proc/sys/kernel/random/boot_id").strip()


def proc(pid):
    """A live process's fields from /proc/<pid>/stat, or None if it is gone
    or a zombie. starttime (clock ticks after boot) never changes for a PID's
    lifetime, so boot + PID + starttime names one process."""
    try:
        data = read_text("/proc/%d/stat" % pid)
    except (OSError, ValueError):
        return None
    fields = data[data.rindex(")") + 2:].split()
    if fields[0] in ("Z", "X"):
        return None
    return {"ppid": int(fields[1]), "pgrp": int(fields[2]), "session": int(fields[3]),
            "starttime": int(fields[19])}


def alive(identity):
    """Whether the recorded process is still the same running process."""
    if not identity or identity.get("bootId") != boot_id():
        return False
    now = proc(identity["pid"])
    return now is not None and now["starttime"] == identity["starttime"]


def member(info, group):
    return (info is not None and info["pgrp"] == group["pgid"] and info["session"] == group["sid"]
            and info["starttime"] >= group["starttime"])


def members(group):
    """The live processes of the attempt's process group, on its boot only."""
    if group.get("bootId") != boot_id():
        return []
    leader = proc(group["sid"])
    if leader is not None and leader["starttime"] != group["starttime"]:
        # The number belongs to another process: Linux reuses it only once
        # nothing of the attempt's session is left.
        return []
    return [int(name) for name in os.listdir("/proc") if name.isdigit() and member(proc(int(name)), group)]


def send(pid, signum, group):
    """Signal one process, only after checking that it is still a member of
    the attempt's group; through a pidfd, opened before the check, where the
    system has one, so the PID cannot change hands in between."""
    handle = None
    try:
        handle = os.pidfd_open(pid) if PIDFD else None
    except ProcessLookupError:
        return
    except OSError:
        handle = None
    try:
        if not member(proc(pid), group):
            return
        if handle is None:
            os.kill(pid, signum)
        else:
            signal.pidfd_send_signal(handle, signum)
    except OSError:
        pass
    finally:
        if handle is not None:
            os.close(handle)


def stop(group, limit=None):
    """TERM the group's checked members, KILL whatever is left from 5 s on,
    and go on until none is left (or for `limit` seconds). True once empty."""
    begin = time.monotonic()
    for pid in members(group):
        send(pid, signal.SIGTERM, group)
    while True:
        left = members(group)
        if not left:
            return True
        waited = time.monotonic() - begin
        if limit is not None and waited >= limit:
            return False
        if waited >= 5:
            for pid in left:
                send(pid, signal.SIGKILL, group)
        time.sleep(0.1)


def input_facts(cwd, given):
    """An input as it is now on this machine: the file its path leads to (a
    relative one from the job's cwd), its SHA-256 and identity, or why it
    cannot be an input."""
    entry = {"path": given}
    try:
        path = (Path(given) if os.path.isabs(given) else Path(cwd) / given).resolve(strict=True)
        before = path.stat()
        if not stat.S_ISREG(before.st_mode):
            entry["problem"] = "not a regular file"
            return entry
        if before.st_size > INPUT_LIMIT:
            entry["problem"] = "%d bytes: an input is a small file (at most 2 MiB)" % before.st_size
            return entry
        with path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            data = stream.read(INPUT_LIMIT + 1)
            read = os.fstat(stream.fileno())
        after = path.stat()
        # The file read is the one the path led to before and after, and it
        # did not change meanwhile: a replaced path or a write is never one.
        if len({identity(s) for s in (before, opened, read, after)}) != 1 or len(data) != after.st_size:
            entry["problem"] = "changed while it was being read"
            return entry
        entry.update({"absolutePath": str(path), "sha256": hashlib.sha256(data).hexdigest(), "bytes": after.st_size,
                      "dev": after.st_dev, "inode": after.st_ino, "mtimeNs": after.st_mtime_ns})
    except FileNotFoundError:
        entry["problem"] = "missing"
    except OSError as error:
        entry["problem"] = "cannot be read: %s" % (error.strerror or error)
    except RuntimeError as error:
        # A symlink loop as Python before 3.13 reports it (3.13 raises OSError):
        # named like any unreadable input, so the check before the start
        # still rejects the attempt with its reason.
        entry["problem"] = "cannot be read: %s" % error
    return entry


def inputs_changed(spec):
    """The frozen inputs that are no longer what Core recorded at submit, by
    path: another content, another file the path leads to, or none."""
    changed = []
    for frozen in spec.get("inputs") or []:
        now = input_facts(spec["cwd"], frozen["path"])
        if now.get("problem"):
            changed.append("%s (%s)" % (frozen["path"], now["problem"]))
        elif now["absolutePath"] != frozen["absolutePath"]:
            changed.append("%s (now %s)" % (frozen["path"], now["absolutePath"]))
        elif now["sha256"] != frozen["sha256"]:
            changed.append("%s (its content changed)" % frozen["path"])
    return changed


def identity(found):
    return (found.st_dev, found.st_ino, found.st_size, found.st_mtime_ns, found.st_ctime_ns)


def identity_of(cwd, given):
    """What a declared artifact's path holds before the command runs, or None
    if nothing: recorded with the check, never a verdict on who wrote it."""
    try:
        return list(identity((Path(cwd) / given).stat()))
    except OSError:
        return None


def check_artifact(cwd, artifact, before=None):
    """A declared artifact as it is now, checked as for local jobs (host.py): a
    complete regular file inside cwd, its size, whole JSON or JSON lines, its
    SHA-256. Structure only: whether the content is valid is the project's
    call. `before` is what its path held before the command ran; the entry
    says whether a file was there then and whether it is still unchanged.
    That is an observation: an unchanged file can be a legitimate cached
    output, and a changed one need not be this attempt's."""
    fmt = artifact.get("format") or "bytes"
    minimum = artifact.get("minBytes", 1)
    entry = {"path": artifact["path"], "format": fmt, "minBytes": minimum, "ok": False,
             "preExisting": before is not None}
    try:
        base = Path(cwd).resolve(strict=True)
        path = (base / artifact["path"]).resolve(strict=True)
        if path != base and base not in path.parents:
            entry["problem"] = "resolves outside the working directory"
            return entry
        first = path.stat()
        if not stat.S_ISREG(first.st_mode):
            entry["problem"] = "not a regular file"
            return entry
        entry.update({"absolutePath": str(path), "bytes": first.st_size, "mtimeNs": first.st_mtime_ns})
        if first.st_size < minimum:
            entry["problem"] = "%d bytes, fewer than the required %d" % (first.st_size, minimum)
            return entry
        if first.st_size > HASH_LIMIT:
            entry["sha256"] = None
            entry["hash"] = "Not hashed: larger than 1 GiB; identified by size and modification time"
            if fmt != "bytes":
                entry["problem"] = "larger than 1 GiB, too large to check as %s; declare it as bytes" % fmt
                return entry
        else:
            hasher = hashlib.sha256()
            whole = bytearray() if fmt == "json" and first.st_size <= JSON_LIMIT else None
            pending = b""
            lines = 0
            with path.open("rb") as stream:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    hasher.update(chunk)
                    if whole is not None:
                        whole.extend(chunk)
                    if fmt == "jsonl":
                        parts = (pending + chunk).split(b"\n")
                        pending = parts.pop()
                        if len(pending) > JSON_LIMIT:
                            entry["problem"] = "a line longer than 16 MiB"
                            return entry
                        for line in parts:
                            if line.strip():
                                json.loads(line)
                                lines += 1
            entry["sha256"] = hasher.hexdigest()
            if fmt == "json":
                if whole is None:
                    entry["problem"] = "larger than 16 MiB, too large to check as JSON"
                    return entry
                json.loads(bytes(whole))
            if fmt == "jsonl":
                if pending:
                    entry["problem"] = "the last line is not terminated: the file may be partly written"
                    return entry
                entry["lines"] = lines
        last = path.stat()
        if (last.st_size, last.st_mtime_ns) != (first.st_size, first.st_mtime_ns):
            entry["problem"] = "changed while it was being checked"
            return entry
        if before is not None:
            entry["unchangedSinceStart"] = before == list(identity(last))
    except FileNotFoundError:
        entry["problem"] = "missing"
        return entry
    except (ValueError, UnicodeDecodeError, RecursionError) as error:
        entry["problem"] = "not complete %s: %s" % ("JSON" if fmt == "json" else "JSON lines", str(error)[:200])
        return entry
    except OSError as error:
        entry["problem"] = "cannot be read: %s" % (error.strerror or error)
        return entry
    entry["ok"] = True
    return entry


def outcome(root, intent, status, reason, code=None, signum=None, extra=None):
    existing = read_json(Path(root) / "result.json")
    if existing:
        return existing
    value = {"jobId": intent["jobId"], "attempt": intent["attempt"], "status": status, "reason": reason,
             "exitCode": code, "signal": signum, "finishedAtUnix": time.time()}
    value.update(extra or {})
    atomic(Path(root) / "result.json", value)
    return value


def cgroup_of(pid):
    """The process's cgroup v2 path under /sys/fs/cgroup, or None."""
    try:
        for line in read_text("/proc/%d/cgroup" % pid).splitlines():
            if line.startswith("0::"):
                return line[3:]
    except OSError:
        pass
    return None


# Pause and resume freeze or thaw the attempt's own transient scope through
# this account's systemd, as local jobs do (T-107): memory and the machine's
# reservation stay, the supervisor (outside the scope) keeps counting the
# timeout, and cancel and timeouts thaw the scope before stopping it.
# Each step is bounded so that a pause or resume answers within Core's 30 s
# for one SSH call: two systemd reads (5 s), the freeze or thaw (8 s) and the
# wait for the cgroup to report it (8 s).
PAUSE_WAIT = 8


def freezer_of(cgroup):
    """The cgroup's own report of being frozen (cgroup.events), or None if
    it is gone. systemd's FreezerState is not evidence: only this is."""
    try:
        values = dict(line.split() for line in read_text("/sys/fs/cgroup" + cgroup + "/cgroup.events").splitlines())
    except (OSError, ValueError):
        return None
    return {"populated": values.get("populated") == "1", "frozen": values.get("frozen") == "1"}


def wait_freezer(cgroup, frozen, seconds):
    deadline = time.monotonic() + seconds
    while True:
        now = freezer_of(cgroup)
        if now is None or now["frozen"] == frozen or time.monotonic() >= deadline:
            return now
        time.sleep(0.02)


def own_scope(root, intent):
    """The attempt's own transient scope, proven before anything is frozen or
    thawed: the unit named for this attempt, recorded by its supervisor
    (limits.json) with its cgroup, which this account's systemd still
    describes as this attempt's with that cgroup, in the boot its processes
    started in. Nothing named by a request is ever used. (scope, None), or
    (None, why) when there is none: then nothing may be frozen."""
    unit = "yuzuno-remote-job-%s.scope" % intent["attempt"]
    held = read_json(Path(root) / "limits.json")
    if not held:
        return None, ("this attempt runs without a scope of its own on this machine "
                      "(no limits are held for it here: a record-only machine, or an account that does not linger)")
    group = held.get("cgroup")
    if not (held.get("unit") == unit and isinstance(group, str) and group.startswith("/") and group.endswith("/" + unit)
            and "/../" not in group + "/" and "/./" not in group + "/"):
        return None, "the scope it recorded is not this attempt's"
    started = read_json(Path(root) / "started.json")
    if not started or started.get("bootId") != boot_id():
        return None, "its processes are not from this boot of the machine"
    try:
        shown = subprocess.run(["systemctl", "--user", "show", "-p", "Description", "-p", "ControlGroup",
                                "-p", "ActiveState", "--", unit],
                               stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError) as error:
        return None, "this account's systemd could not be asked about its scope (%s)" % error
    props = dict(line.split("=", 1) for line in shown.stdout.splitlines() if "=" in line)
    if (shown.returncode != 0 or props.get("Description") != "Yuzuno job " + intent["attempt"]
            or props.get("ControlGroup") != group):
        return None, "this account's systemd does not describe %s as this attempt's scope with %s" % (unit, group)
    return {"unit": unit, "cgroup": group, "activeState": props.get("ActiveState")}, None


def scope_control(scope, verb):
    """systemctl --user freeze or thaw of the attempt's own scope:
    (return code, error text)."""
    try:
        done = subprocess.run(["systemctl", "--user", verb, "--", scope["unit"]], stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=8)
    except (OSError, subprocess.SubprocessError) as error:
        return None, str(error)[:300]
    return done.returncode, done.stderr.strip()[:500]


def thaw_for_stop(root, intent):
    """Processes in a frozen scope act on TERM only once thawed: thaw the
    attempt's own scope before it is stopped (its processes may run briefly
    while they handle the signal). None when it was not frozen."""
    scope, _ = own_scope(root, intent)
    if scope is None:
        return None
    now = freezer_of(scope["cgroup"])
    if not (now and now["frozen"]):
        return None
    code, error = scope_control(scope, "thaw")
    return {"wasFrozen": True, "thawReturnCode": code, "thawError": error,
            "freezer": wait_freezer(scope["cgroup"], False, 3)}
'''

exec(COMMON)

SUPERVISOR = r'''
import re
import shutil
import subprocess
import sys
import threading

MIB = 1024 * 1024
# What systemd without OOMPolicy for scopes (249, Ubuntu 22.04) answers, and
# only that: refused while the properties were read, before any unit existed.
NO_OOM_POLICY = re.compile(r"Call failed: Cannot set property OOMPolicy, or unknown property\.")


def unit_absent(unit):
    """Whether this account's systemd has no unit by that name (it answered)."""
    try:
        state = subprocess.run(["systemctl", "--user", "show", "-p", "LoadState", "--value", unit],
                               stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return state.returncode == 0 and state.stdout.strip() == "not-found"


def keeper():
    """A process that only waits in the scope beside the command, so that the
    scope (and its accounting) outlives the command until the supervisor has
    read it. It leaves when the supervisor closes the pipe, or dies."""
    keep_r, keep_w = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            # Nothing of the supervisor's: not its lock, nor the command's pipes.
            os.closerange(3, keep_r)
            os.closerange(keep_r + 1, 65536)
            os.read(keep_r, 1)
        finally:
            os._exit(0)
    os.close(keep_r)
    return pid, keep_w


def confine(pids, attempt, plan):
    """Move the command's process, still waiting for the go byte, and its
    keeper into their own transient scope of this account's systemd with the
    planned limits, and read them back from its cgroup. (facts, None), or
    (None, why) when they are not in force: the command must then never run."""
    pid = pids[0]
    # Apart from this account's other units, including a Core's own local
    # Jobs (yuzuno-job-<id>.service) when Core runs on this machine too.
    unit = "yuzuno-remote-job-%s.scope" % attempt
    props = []
    # A plan from before swap was planned on its own held swap with memory.
    swap = plan.get("swap", plan.get("memory")) == "limited"
    if plan.get("memory") == "limited":
        props += [("MemoryMax", plan["memoryMiB"] * MIB)]
    if swap:
        props += [("MemorySwapMax", plan["swapMiB"] * MIB)]
    if plan.get("cpu") == "limited":
        props += [("CPUQuotaPerSecUSec", plan["cpuMillis"] * 1000)]
    busctl = os.environ.get("YUZUNO_JOBS_BUSCTL") or shutil.which("busctl") or "busctl"

    def ask(oom_policy):
        named = [("Description", "s", "Yuzuno job " + attempt)] + [(name, "t", str(value)) for name, value in props]
        if oom_policy:
            # An OOM kill ends only the process the kernel chose; the
            # supervisor stops what is left of the group, and the keeper stays
            # until the scope's accounting is read.
            named.append(("OOMPolicy", "s", "continue"))
        args = [busctl, "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
                "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail",
                str(len(named) + 1), "PIDs", "au", str(len(pids))] + [str(p) for p in pids]
        for name, kind, value in named:
            args += [name, kind, value]
        args.append("0")
        return subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15)
    before = cgroup_of(pid)
    try:
        done, oom_policy = ask(True), "continue"
        # Asked again without OOMPolicy only on systemd's own answer that the
        # property does not exist, once no unit by that name exists and the
        # waiting process is still where it was (older systemd neither has
        # the policy for scopes nor stops a scope after an OOM kill). A
        # timeout or any other refusal is never retried.
        if (done.returncode != 0 and NO_OOM_POLICY.fullmatch(done.stderr.strip())
                and unit_absent(unit) and cgroup_of(pid) == before):
            done, oom_policy = ask(False), None
    except (OSError, subprocess.SubprocessError) as error:
        return None, "this account's systemd could not be asked for its scope (%s)" % error
    if done.returncode != 0:
        return None, "this account's systemd refused its scope: %s" % (done.stderr.strip()[:300] or done.returncode)
    group = None
    for _ in range(100):
        group = cgroup_of(pid)
        if group and group.endswith("/" + unit):
            break
        time.sleep(0.05)
    else:
        return None, "its process did not arrive in the scope %s (it is in %s)" % (unit, group)
    found = {"unit": unit, "cgroup": group, "oomPolicy": oom_policy}
    for name in ("memory.max", "memory.swap.max", "cpu.max"):
        try:
            found[name] = read_text("/sys/fs/cgroup" + group + "/" + name).strip()
        except OSError:
            found[name] = None
    if plan.get("memory") == "limited" and (found["memory.max"] != str(plan["memoryMiB"] * MIB)
                                            or swap and found["memory.swap.max"] != str(plan["swapMiB"] * MIB)):
        return None, "its cgroup does not hold the memory limit (memory.max %s, memory.swap.max %s)" % (
            found["memory.max"], found["memory.swap.max"])
    if plan.get("cpu") == "limited" and (found["cpu.max"] or "").split(" ")[0] != str(plan["cpuMillis"] * 100):
        return None, "its cgroup does not hold the CPU limit (cpu.max %s)" % found["cpu.max"]
    return found, None


def sample(held, seen):
    """The scope's peak memory and OOM kills so far (it vanishes with its last
    process, so they are read while it lives)."""
    base = "/sys/fs/cgroup" + held["cgroup"] + "/"
    try:
        seen["peakBytes"] = max(seen.get("peakBytes", 0), int(read_text(base + "memory.peak").strip()))
    except (OSError, ValueError):
        pass
    try:
        for line in read_text(base + "memory.events").splitlines():
            key, _, value = line.partition(" ")
            if key == "oom_kill":
                seen["oomKills"] = max(seen.get("oomKills", 0), int(value))
    except (OSError, ValueError):
        pass


root = Path(sys.argv[1])
# supervisor.lock, locked by the start that launched this supervisor and
# kept open for its whole life: whoever can take the lock knows it is gone.
hold = int(sys.argv[2])
intent = read_json(root / "intent.json")
spec = read_json(root / "spec.json")
atomic(root / "supervisor.json", {"pid": os.getpid(), "starttime": proc(os.getpid())["starttime"],
                                  "bootId": boot_id(), "startedAtUnix": time.time()})
if (root / "cancel.json").exists():
    outcome(root, intent, "cancelled", "Cancelled before the command started")
    sys.exit(0)
atomic(root / "launching.json", {"atUnix": time.time()})


class Ring:
    """Two segments of 1 MiB, each headed by its start offset, as for local jobs."""
    def __init__(self):
        self.total, self.index, self.used, self.file = 0, 0, 0, None
        self.open(0)

    def open(self, index):
        if self.file:
            self.file.close()
        self.index, self.used = index, 0
        fd = os.open(str(root / ("log-%d.bin" % index)), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        self.file = os.fdopen(fd, "wb", buffering=0)
        self.file.write(self.total.to_bytes(8, "big"))

    def write(self, data):
        while data:
            room = SEGMENT - self.used
            if room <= 0:
                self.open(1 - self.index)
                continue
            part = data[:room]
            self.file.write(part)
            self.used += len(part)
            self.total += len(part)
            data = data[room:]


ring = Ring()
out_r, out_w = os.pipe()
go_r, go_w = os.pipe()
err_r, err_w = os.pipe()
pid = os.fork()
if pid == 0:
    # The command's process: its own session and process group, the output
    # pipe on stdout and stderr, nothing else of the supervisor's. It runs
    # the command only once the supervisor has recorded it.
    try:
        os.close(hold)
        os.setsid()
        for fd in (out_r, go_w, err_r):
            os.close(fd)
        null = os.open(os.devnull, os.O_RDONLY)
        os.dup2(null, 0)
        os.dup2(out_w, 1)
        os.dup2(out_w, 2)
        for name in os.listdir("/proc/self/fd"):
            if int(name) > 2:
                try:
                    os.set_inheritable(int(name), False)
                except OSError:
                    pass
        for name in ("SIGPIPE", "SIGXFSZ"):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), signal.SIG_DFL)
        if os.read(go_r, 1) != b"g":
            # The supervisor is gone before recording this process: never
            # run the command.
            os._exit(125)
        os.close(go_r)
        os.chdir(spec["cwd"])
        os.execvpe(spec["argv"][0], spec["argv"], spec["env"])
    except BaseException as error:
        try:
            os.write(err_w, (str(error) or "exec failed").encode("utf-8", "replace")[:500])
        finally:
            os._exit(127)
for fd in (out_w, go_r, err_w):
    os.close(fd)
child = proc(pid)
plan = intent.get("limits") or {}
held = kept = None
if child and "limited" in (plan.get("memory"), plan.get("cpu")):
    # The process waits for the go byte, so the command has not run: if the
    # limits cannot be put in force it never does.
    kept = keeper()
    held, problem = confine([pid, kept[0]], intent["attempt"], plan)
    if problem:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        os.close(kept[1])
        os.waitpid(kept[0], 0)
        outcome(root, intent, "rejected", "Not started on this machine: %s" % problem)
        sys.exit(0)
    atomic(root / "limits.json", held)
# The inputs Core froze at submit, checked again here last thing before the
# command may run (as local jobs do): if one changed, it never runs.
changed = inputs_changed(spec) if child else []
if changed:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    if kept:
        os.close(kept[1])
        os.waitpid(kept[0], 0)
    shown = ", ".join(changed[:5]) + (" and %d more" % (len(changed) - 5) if len(changed) > 5 else "")
    outcome(root, intent, "rejected", "Inputs changed on this machine while queued (%s); command was not started" % shown)
    sys.exit(0)
# What each declared artifact's path holds now, recorded with the check after
# exit (preExisting, unchangedSinceStart): an observation, not a verdict.
artifacts_before = {a["path"]: identity_of(spec["cwd"], a["path"]) for a in spec.get("artifacts") or []}
group = {"jobId": intent["jobId"], "attempt": intent["attempt"], "pid": pid, "pgid": pid, "sid": pid,
         "starttime": child["starttime"] if child else -1, "bootId": boot_id(),
         "supervisorPid": os.getpid(), "startedAtUnix": time.time()}
if child:
    atomic(root / "started.json", group)
    os.write(go_w, b"g")
os.close(go_w)
failure = b""
while True:
    chunk = os.read(err_r, 512)
    if not chunk:
        break
    failure += chunk
os.close(err_r)
if failure or not child:
    os.waitpid(pid, 0)
    outcome(root, intent, "rejected", "Not started on this machine: %s" % (
        failure.decode("utf-8", "replace") or "its process ended before running the command"))
    sys.exit(0)


def pump():
    with os.fdopen(out_r, "rb", buffering=0) as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            ring.write(chunk)


reader = threading.Thread(target=pump, daemon=True)
reader.start()
deadline = time.monotonic() + spec["timeoutSeconds"]
why = None
seen = {}
sampled = 0.0
thawed = None
while True:
    if held and time.monotonic() - sampled >= 1:
        sample(held, seen)
        sampled = time.monotonic()
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        break
    if why is None:
        if (root / "cancel.json").exists():
            why = "cancel"
        elif time.monotonic() > deadline:
            # The timeout counts while the job is paused, as for local jobs.
            why = "timeout"
        if why:
            # A paused job is thawed first, so its processes can act on TERM.
            thawed = thaw_for_stop(root, intent) if held else None
            # Until nothing of the group is left; the leader is then a zombie.
            stop(group)
    time.sleep(0.2)
# The command has exited; nothing of its group may outlive it, and the
# outcome is written only once nothing is left.
leftovers = len(members(group))
if held and leftovers:
    thawed = thaw_for_stop(root, intent) or thawed
stop(group)
reader.join(5)
if held:
    # Its keeper still holds the scope: the final accounting, then let it go.
    sample(held, seen)
if kept:
    os.close(kept[1])
    os.waitpid(kept[0], 0)
    # Its own, uniquely named unit: never left behind as a failed unit.
    try:
        subprocess.run(["systemctl", "--user", "reset-failed", held["unit"]], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass
code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)
signum = -code if code < 0 else None
note = "; %d process(es) left in its process group were stopped" % leftovers if leftovers and why is None else ""
extra = None
if plan:
    used = dict(plan, held=held)
    if held:
        used.update(seen)
        # The scope lives in the account's systemd user manager: whether that
        # manager still answered when the command ended.
        runtime = os.environ.get("XDG_RUNTIME_DIR")
        used["managerAtEnd"] = bool(runtime) and os.path.exists(os.path.join(runtime, "systemd", "private"))
        if seen.get("oomKills") and code < 0:
            note += "; out of memory: its limit is %d MiB" % plan["memoryMiB"]
    extra = {"limits": used}
if thawed:
    extra = dict(extra or {}, thawedToStop=thawed)
if why == "cancel" or (root / "cancel.json").exists():
    outcome(root, intent, "cancelled", "Cancelled; its process group was stopped", code, signum, extra)
elif why == "timeout":
    outcome(root, intent, "failed", "timeout after %d s; its process group was stopped" % spec["timeoutSeconds"],
            code, signum, extra)
elif code == 0 and spec.get("artifacts"):
    # As for local jobs, after a clean exit only: each declared artifact on
    # this machine, recorded with this attempt.
    try:
        checked = [check_artifact(spec["cwd"], a, artifacts_before.get(a["path"])) for a in spec["artifacts"]]
        atomic(root / "artifacts.json", {"attempt": intent["attempt"], "checkedAt": time.time(), "artifacts": checked})
    except Exception:
        checked = None
    extra = dict(extra or {}, artifacts=checked)
    problems = ["%s: %s" % (a["path"], a.get("problem", "not verified")) for a in checked or [] if a.get("ok") is not True]
    if checked is None:
        outcome(root, intent, "failed", "Exit 0, but artifact verification did not complete" + note, 0, None, extra)
    elif problems:
        outcome(root, intent, "failed", ("Exit 0, but declared artifacts failed verification: " + "; ".join(problems))[:1000]
                + note, 0, None, extra)
    else:
        outcome(root, intent, "succeeded", "success" + note, 0, None, extra)
elif code == 0:
    outcome(root, intent, "succeeded", "success" + note, 0, None, extra)
elif code < 0:
    outcome(root, intent, "failed", "killed by signal %d%s" % (-code, note), code, signum, extra)
else:
    outcome(root, intent, "failed", "exit-code %d%s" % (code, note), code, None, extra)
'''

ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
KEY = re.compile(r"[A-Za-z0-9._:-]{1,128}")
HEX64 = re.compile(r"[0-9a-f]{64}")
HOST = re.compile(r"[0-9a-f]{32}")
ROOT_PART = re.compile(r"[A-Za-z0-9._-]+")
PAGE = 32768
MARK = "YUZUNO-JOBS-REPLY "
NONCE = re.compile(r"[0-9a-f]{32}")


class Refused(Exception):
    pass


class Busy(Exception):
    pass


def host_id():
    """This machine, as an app-specific hash of its machine-id (the raw ID is
    meant to stay on the machine), or None if it has none."""
    override = os.environ.get("YUZUNO_JOBS_MACHINE_ID_FILE")
    for path in [override] if override else ["/etc/machine-id", "/var/lib/dbus/machine-id"]:
        try:
            value = read_text(path).strip()
        except OSError:
            continue
        if HOST.fullmatch(value):
            return hashlib.sha256(b"yuzuno-jobs-host-v1:" + value.encode()).hexdigest()[:32]
    return None


def digest(spec):
    """What the attempt runs, encoded without ambiguity; Core computes the same.
    A start that carries limits is v2 and binds them too; one that carries
    frozen inputs or declared artifacts is v3 and binds those as well. An
    attempt recorded with an earlier version keeps the digest it was recorded
    with: v1 and v2 are unchanged."""
    hasher = hashlib.sha256()

    def put(text):
        data = text.encode("utf-8")
        hasher.update(b"%d:" % len(data))
        hasher.update(data)
        hasher.update(b",")
    limits = spec.get("limits")
    # None or empty: no inputs or artifacts, so v1 or v2 exactly as before.
    v3 = bool(spec.get("inputs") or spec.get("artifacts"))
    put("yuzuno-remote-job-v3" if v3 else "yuzuno-remote-job-v2" if limits is not None else "yuzuno-remote-job-v1")
    put(str(len(spec["argv"])))
    for item in spec["argv"]:
        put(item)
    put(spec["cwd"])
    put(str(len(spec["env"])))
    for key in sorted(spec["env"]):
        put(key)
        put(spec["env"][key])
    put(str(spec["timeoutSeconds"]))
    if v3:
        put("limits" if limits is not None else "no limits")
    if limits is not None:
        put(str(limits.get("mode")))
        for key in ("cpuMillis", "memoryMiB", "swapMiB"):
            put(str(limits.get(key)))
    if v3:
        inputs, artifacts = spec.get("inputs") or [], spec.get("artifacts") or []
        put(str(len(inputs)))
        for item in inputs:
            put(item["path"])
            put(item["absolutePath"])
            put(item["sha256"])
        put(str(len(artifacts)))
        for item in artifacts:
            put(item["path"])
            put(item["format"])
            put(str(item["minBytes"]))
    return hasher.hexdigest()


def capabilities():
    """What this account can hold a job to here, read fresh each time: whether
    its systemd user manager answers, the cgroup controllers that manager was
    delegated, and whether the account lingers (that manager keeps running
    when the account has no session)."""
    override = os.environ.get("YUZUNO_JOBS_CAPABILITIES_FILE")
    if override:
        return json.loads(read_text(override))
    facts = {"manager": False, "busctl": shutil.which("busctl") is not None, "delegated": [], "linger": False,
             "swap": False}
    try:
        facts["linger"] = os.path.exists("/var/lib/systemd/linger/" + pwd.getpwuid(os.getuid()).pw_name)
    except KeyError:
        pass
    try:
        group = subprocess.run(["systemctl", "--user", "show", "-p", "ControlGroup", "--value"],
                               stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return facts
    if group.startswith("/"):
        facts["manager"] = True
        try:
            facts["delegated"] = read_text("/sys/fs/cgroup" + group + "/cgroup.controllers").split()
        except OSError:
            pass
        # A kernel without swap accounting (CONFIG_MEMCG_SWAP off or
        # swapaccount=0) has no memory.swap.max: swap cannot be limited there.
        facts["swap"] = os.path.exists("/sys/fs/cgroup" + group + "/memory.swap.max")
    return facts


LIMIT_MODES = ("strict", "limited")


def limit_plan(limits, facts):
    """How an attempt's declared resources are held here. strict starts it
    only when its memory and CPU are both limited and the limits outlive the
    account's sessions; limited holds what this machine can and names what
    is only declared. Limits are held only in a scope that lasts: on an
    account that does not linger, limited holds nothing (no scope of a user
    manager that may stop when the last session ends) and declares it all.
    A refusal is raised before anything is started."""
    if not (isinstance(limits, dict) and limits.get("mode") in LIMIT_MODES
            and all(type(limits.get(key)) is int for key in ("cpuMillis", "memoryMiB", "swapMiB"))
            and limits["cpuMillis"] >= 1 and limits["memoryMiB"] >= 1 and limits["swapMiB"] >= 0):
        raise Refused("limits must name mode strict or limited, and cpuMillis, memoryMiB and swapMiB")
    if facts.get("manager") is not True:
        why = "this account's systemd user manager does not answer"
    elif facts.get("busctl") is not True:
        why = "busctl is missing"
    else:
        why = None
    delegated = facts.get("delegated") or []
    gaps = {}
    for kind, controller in (("memory", "memory"), ("cpu", "cpu")):
        if why:
            gaps[kind] = why
        elif controller not in delegated:
            gaps[kind] = "the %s controller is not delegated to this account's systemd" % controller
    # Swap is held beside memory only where the kernel accounts it (a facts
    # file of an older helper or test without "swap" meant it was).
    swap_gap = None
    if "memory" not in gaps and facts.get("swap", True) is not True:
        swap_gap = "this kernel does not account swap for cgroups (no memory.swap.max)"
    lifetime = None
    if len(gaps) < 2 and facts.get("linger") is not True:
        lifetime = ("its limits are held by this account's systemd user manager, which stops when the "
                    "account's last session ends (linger is off), and stops this job with it")
    if limits["mode"] == "strict" and (gaps or swap_gap or lifetime):
        problems = ["%s cannot be limited here: %s" % ("memory" if kind == "memory" else "CPU", gap)
                    for kind, gap in sorted(gaps.items())]
        if swap_gap:
            problems.append("swap cannot be limited here: " + swap_gap)
        if lifetime:
            problems.append(lifetime)
        raise Refused("This machine cannot hold strict limits, so nothing was started: %s. The limited mode, "
                      "chosen for the machine, runs with what it can hold" % "; ".join(problems))
    caveats = ["%s is declared only, not limited: %s" % ("memory" if kind == "memory" else "CPU", gap)
               for kind, gap in sorted(gaps.items())]
    if swap_gap:
        caveats.append("swap is declared only, not limited: " + swap_gap)
    if lifetime:
        # Not put in a scope that this manager could stop with it: the job
        # runs in its own process group as before limits. That is not a
        # promise that it outlives the session; the host's logind settings
        # decide that.
        caveats.append("nothing is held in a scope: this account does not linger, so its systemd user manager "
                       "may stop when the account's last session ends and would stop such a scope with it; "
                       "CPU, memory and swap are declared only (lingering lets limited hold them)")
        gaps = {"memory": "linger is off", "cpu": "linger is off"}
    memory = "declared" if "memory" in gaps else "limited"
    return {"mode": limits["mode"], "cpuMillis": limits["cpuMillis"], "memoryMiB": limits["memoryMiB"],
            "swapMiB": limits["swapMiB"], "memory": memory,
            "swap": "limited" if memory == "limited" and not swap_gap else "declared",
            "cpu": "declared" if "cpu" in gaps else "limited", "caveats": caveats, "facts": facts}


def private_dir(path):
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Refused(f"{path} must be a private folder of this user, not a link")


def data_root(request):
    """The data root the request names: ~/<folder> in this account's home or
    an absolute folder, of plain names only."""
    given = request.get("root")
    if not isinstance(given, str):
        raise Refused("root must name the machine's data folder")
    parts = given[2:].split("/") if given.startswith("~/") else given[1:].split("/") if given.startswith("/") else []
    if len(given) > 1024 or not parts or any(p in (".", "..") or not ROOT_PART.fullmatch(p) for p in parts):
        raise Refused("root must be ~/<folder> or an absolute folder of plain names")
    return (Path.home() if given.startswith("~/") else Path("/")).joinpath(*parts)


def attempt_dir(request, create=False):
    job, attempt = request.get("jobId"), request.get("attempt")
    if not (isinstance(job, str) and ID.fullmatch(job) and isinstance(attempt, str) and ID.fullmatch(attempt)):
        raise Refused("jobId and attempt must be job and attempt UUIDs")
    base = data_root(request)
    if create and not base.parent.is_dir():
        raise Refused(f"{base.parent} does not exist; the data root's parent must exist")
    chain = [base, base / "jobs", base / "jobs" / job, base / "jobs" / job / attempt]
    if not create:
        if not chain[-1].exists():
            return None
        for directory in chain:
            if directory.is_symlink() or not directory.is_dir():
                raise Refused(f"{directory} is not this helper's folder")
        return chain[-1]
    for directory in chain:
        private_dir(directory)
    return chain[-1]


def locked(root):
    fd = os.open(str(root / "lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    lock = os.fdopen(fd, "r+")
    deadline = time.monotonic() + 20
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock
        except BlockingIOError:
            if time.monotonic() >= deadline:
                lock.close()
                raise Busy()
            time.sleep(0.1)


def supervisor_alive(root):
    try:
        fd = os.open(str(root / "supervisor.lock"), os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return False
    except BlockingIOError:
        return True
    finally:
        os.close(fd)


def binding(request):
    """The attempt's binding from a request; malformed is refused."""
    value = {key: request.get(key) for key in ("workspaceKey", "machineId", "digest", "expectHost")}
    if not (isinstance(value["workspaceKey"], str) and KEY.fullmatch(value["workspaceKey"])
            and isinstance(value["machineId"], str) and KEY.fullmatch(value["machineId"])
            and isinstance(value["digest"], str) and HEX64.fullmatch(value["digest"])
            and isinstance(value["expectHost"], str) and HOST.fullmatch(value["expectHost"])):
        raise Refused("workspaceKey, machineId, digest and expectHost are required")
    return value


def conflict(intent, bound):
    for key in ("workspaceKey", "machineId", "digest"):
        if intent.get(key) != bound[key]:
            return f"its {key} differs"
    return None


def state(root, intent):
    """Where the attempt is, from its records and /proc. Writes the outcome
    when it is settled for certain (a restarted machine, a command never run)."""
    result = read_json(root / "result.json")
    started = read_json(root / "started.json")
    if started and intent.get("limits"):
        # The plan and, when something is held, the scope read back from its cgroup.
        started = dict(started, limits=dict(intent["limits"], held=read_json(root / "limits.json")))
    if result:
        return {"status": "terminal", "result": result, "started": started}
    boot = boot_id()
    supervised = supervisor_alive(root)
    if started:
        if started["bootId"] != boot:
            return {"status": "terminal", "started": started, "result": outcome(
                root, intent, "interrupted", "The machine restarted; this attempt's processes ended with that boot")}
        left = members(started)
        leader = alive(started)
        if supervised:
            return {"status": "running" if leader else ("stopping" if left else "settling"),
                    "started": started, "processes": len(left)}
        return {"status": "lost", "started": started, "leaderAlive": leader, "processes": len(left)}
    if supervised:
        return {"status": "starting"}
    # The supervisor is gone and recorded no command. The command's process
    # runs it only after started.json is written, so nothing ran.
    if (root / "cancel.json").exists():
        return {"status": "terminal", "result": outcome(root, intent, "cancelled", "Cancelled before the command started")}
    why = "the machine restarted before the command started" if intent["bootId"] != boot else \
        "its supervisor exited before starting the command"
    return {"status": "terminal", "result": outcome(root, intent, "rejected", "Not started on this machine: " + why)}


def hello(request, host):
    reply = {"status": "hello", "platform": platform.system(), "python": platform.python_version(), "pidfd": PIDFD,
             "resources": capabilities()}
    # The absolute root a start would go to, which Core pins with the
    # machine. Nothing is created.
    if "root" in request:
        reply["root"] = str(data_root(request))
    return reply


def inspect(request, host):
    """A job's inputs as they are on this machine, for Core to freeze at
    submit: what each path leads to, its SHA-256 and identity, or why it
    cannot be an input. Reads only; no attempt, nothing written."""
    cwd, paths = request.get("cwd"), request.get("inputs")
    if not (isinstance(cwd, str) and os.path.isabs(cwd)):
        raise Refused("cwd must be an absolute path")
    if not (isinstance(paths, list) and 1 <= len(paths) <= 128
            and all(isinstance(p, str) and p and len(p) <= 4096 and "\0" not in p for p in paths)):
        raise Refused("inputs must be 1-128 paths")
    if not os.path.isdir(cwd):
        raise Refused(f"The working directory {cwd!r} does not exist on this machine")
    files = [input_facts(cwd, p) for p in paths]
    total = sum(f.get("bytes", 0) for f in files)
    reply = {"status": "inspected", "cwd": cwd, "files": files, "totalBytes": total}
    if total > INPUTS_LIMIT:
        reply["problem"] = f"{total} bytes in all: inputs are small files (at most 16 MiB together)"
    return reply


def start(request, host):
    argv, cwd, env = request.get("argv"), request.get("cwd"), request.get("env")
    timeout_seconds = request.get("timeoutSeconds")
    # As Core's own check: the program is named, later arguments may be empty.
    if not (isinstance(argv, list) and argv and all(isinstance(a, str) for a in argv) and argv[0]):
        raise Refused("argv must be a list of strings whose first names the program")
    if not (isinstance(env, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in env.items())):
        raise Refused("env must map strings to strings")
    if not (isinstance(timeout_seconds, int) and 1 <= timeout_seconds <= 604800):
        raise Refused("timeoutSeconds must be 1-604800")
    if not (isinstance(cwd, str) and os.path.isabs(cwd)):
        raise Refused("cwd must be an absolute path")
    bound = binding(request)
    spec = {"jobId": request.get("jobId"), "attempt": request.get("attempt"), "argv": argv, "cwd": cwd, "env": env,
            "timeoutSeconds": timeout_seconds}
    if "limits" in request:
        spec["limits"] = request["limits"]
    if "inputs" in request:
        inputs = request["inputs"]
        if not (isinstance(inputs, list) and len(inputs) <= 128 and all(
                isinstance(i, dict) and all(isinstance(i.get(k), str) for k in ("path", "absolutePath", "sha256"))
                for i in inputs)):
            raise Refused("inputs must be the files Core froze: path, absolutePath and sha256 of each")
        if inputs:
            spec["inputs"] = inputs
    if "artifacts" in request:
        artifacts = request["artifacts"]
        if not (isinstance(artifacts, list) and len(artifacts) <= 20 and all(
                isinstance(a, dict) and isinstance(a.get("path"), str) and a.get("format") in ("bytes", "json", "jsonl")
                and isinstance(a.get("minBytes"), int) and a["minBytes"] >= 0 for a in artifacts)):
            raise Refused("artifacts must be declared as path, format (bytes, json or jsonl) and minBytes")
        if artifacts:
            spec["artifacts"] = artifacts
    if digest(spec) != bound["digest"]:
        raise Refused("The digest does not match the command sent with it; nothing was started")
    if host != bound["expectHost"]:
        return {"status": "other_host"}
    root = attempt_dir(request, create=True)
    with locked(root):
        intent = read_json(root / "intent.json")
        if intent is not None:
            # This start key was used before: the same request finds its
            # attempt, another one is never taken for it.
            reason = conflict(intent, bound)
            if reason:
                return {"status": "conflict", "reason": reason}
            reply = state(root, intent)
            reply["duplicate"] = True
            return reply
        if (root / "fenced.json").exists():
            raise Refused("Core gave up on this start before it arrived; nothing was started")
        if not os.path.isdir(cwd):
            raise Refused(f"The working directory {cwd!r} does not exist on this machine")
        # Decided before the commit point: a machine that cannot hold what
        # the mode demands starts nothing.
        plan = limit_plan(spec["limits"], capabilities()) if "limits" in spec else None
        atomic(root / "spec.json", spec)
        (root / "supervisor.py").write_text(COMMON + SUPERVISOR)
        intent = dict(bound, jobId=spec["jobId"], attempt=spec["attempt"], hostId=host, bootId=boot_id(),
                      createdAtUnix=time.time())
        if plan is not None:
            intent["limits"] = plan
        del intent["expectHost"]
        # The commit point: from here on this attempt exists on this machine.
        atomic(root / "intent.json", intent)
        hold = os.open(str(root / "supervisor.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(hold, fcntl.LOCK_EX | fcntl.LOCK_NB)
            subprocess.Popen([sys.executable, str(root / "supervisor.py"), str(root), str(hold)], pass_fds=(hold,),
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True, cwd=str(root))
        except OSError as error:
            os.close(hold)
            outcome(root, intent, "rejected", f"Not started on this machine: its supervisor could not start: {error}")
            return state(root, intent)
        os.close(hold)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if (root / "started.json").exists() or (root / "result.json").exists():
                break
            time.sleep(0.05)
        reply = state(root, intent)
        reply["duplicate"] = False
        return reply


def find(request, host, fence):
    """The attempt's folder and intent for a bound request, or a reply that
    says why there is none to act on. A fence makes a missing start final."""
    bound = binding(request)
    if host != bound["expectHost"]:
        return None, None, {"status": "other_host"}
    root = attempt_dir(request, create=fence)
    if root is None:
        return None, None, {"status": "absent"}
    return root, bound, None


def checked(root, bound, fence):
    intent = read_json(root / "intent.json")
    if intent is None:
        if not fence:
            return None, {"status": "absent"}
        if not (root / "fenced.json").exists():
            atomic(root / "fenced.json", {"atUnix": time.time()})
        return None, {"status": "fenced"}
    reason = conflict(intent, bound)
    if reason:
        return None, {"status": "conflict", "reason": reason}
    return intent, None


def status(request, host):
    fence = request.get("fence") is True
    root, bound, reply = find(request, host, fence)
    if reply:
        return reply
    with locked(root):
        intent, reply = checked(root, bound, fence)
        if reply:
            return reply
        reply = state(root, intent)
        if reply["status"] in ("running", "stopping") and (root / "limits.json").exists():
            # Whether its own scope is frozen, so Core settles a pause or
            # resume whose reply was lost, and sees one made outside Yuzuno.
            scope, _ = own_scope(root, intent)
            if scope is not None:
                reply["freezer"] = freezer_of(scope["cgroup"])
        return reply


def control(request, host, freeze):
    """Pause (freeze) or resume (thaw) the attempt's own scope and read it
    back from its cgroup. Only a scope proven to be this attempt's is ever
    touched (own_scope); without one nothing is changed and the reply says
    why. Repeating one that already took hold changes nothing."""
    root, bound, reply = find(request, host, False)
    if reply:
        return reply
    verb, not_done = ("paused", "notPaused") if freeze else ("resumed", "notResumed")
    with locked(root):
        intent, reply = checked(root, bound, False)
        if reply:
            return reply

        def answer(state, reason, evidence=None):
            return dict({"status": "control", "state": state, "reason": reason},
                        **({"evidence": evidence} if evidence else {}))
        finished = read_json(root / "result.json")
        if finished:
            return answer(not_done, "The job has already finished; nothing was %s" % verb)
        if freeze and (root / "cancel.json").exists():
            return answer(not_done, "Cancellation was requested; nothing was paused")
        now_state = state(root, intent)
        if now_state["status"] != "running":
            return answer(not_done, "The job is not running here (%s); nothing was %s" % (now_state["status"], verb))
        scope, why = own_scope(root, intent)
        if scope is None:
            return answer(not_done, "Pause freezes only an attempt's own scope, and %s; nothing was %s" % (why, verb))
        now = freezer_of(scope["cgroup"])
        if now is None:
            return answer(not_done, "Its scope no longer exists; nothing was %s" % verb)
        evidence = {"unit": scope["unit"], "cgroup": scope["cgroup"], "freezer": now, "at": time.time()}
        if now["frozen"] == freeze:
            return answer("paused" if freeze else "running", "Already paused" if freeze else "Already running", evidence)
        code, error = scope_control(scope, "freeze" if freeze else "thaw")
        now = wait_freezer(scope["cgroup"], freeze, PAUSE_WAIT)
        after, _ = own_scope(root, intent)
        evidence = dict(evidence, freezer=now, returnCode=code, error=error, at=time.time())
        if after is None or now is None:
            return answer("unknown", "The scope changed or ended while it was being %s" % verb, evidence)
        if now["frozen"] == freeze:
            atomic(root / ("paused.json" if freeze else "resumed.json"), dict(evidence, attempt=intent["attempt"]))
            if freeze:
                return answer("paused", "Paused: every process in its scope on this machine is frozen; "
                                        "its memory and the machine's reservation are kept", evidence)
            return answer("running", "Resumed: the same processes continue", evidence)
        if code:
            return answer(not_done, "This account's systemd did not %s it: %s" % ("freeze" if freeze else "thaw",
                                                                               error[:300] or code), evidence)
        return answer("pausing" if freeze else "resuming",
                      "%s requested, but its scope was not %s after %d s%s" % (
                          "Freeze" if freeze else "Thaw", "frozen" if freeze else "thawed", PAUSE_WAIT,
                          " (a process may be inside a kernel call)" if freeze else ""), evidence)


def pause(request, host):
    return control(request, host, True)


def resume(request, host):
    return control(request, host, False)


def cancel(request, host):
    # Only a start this machine never acknowledged may be fenced: a record
    # lost after it was acknowledged is absent, never "not started".
    fence = request.get("fence") is True
    root, bound, reply = find(request, host, fence)
    if reply:
        return reply
    with locked(root):
        intent, reply = checked(root, bound, fence)
        if reply:
            return reply
        if not (root / "cancel.json").exists():
            atomic(root / "cancel.json", {"requestedAtUnix": time.time()})
        reply = state(root, intent)
        if reply["status"] in ("starting", "running", "stopping", "settling"):
            # The supervisor stops the group and records the outcome.
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and not (root / "result.json").exists():
                time.sleep(0.1)
            return state(root, intent)
        if reply["status"] == "lost":
            # Its supervisor is gone: a paused scope is thawed first, so its
            # processes act on TERM (frozen, they would stop only at KILL).
            thaw_for_stop(root, intent)
            if stop(reply["started"], limit=4):
                outcome(root, intent, "cancelled",
                        "Cancelled; its supervisor was gone, so what was left of its process group was stopped here")
                return state(root, intent)
        return reply


def logs(request, host):
    root, bound, reply = find(request, host, False)
    if reply and reply["status"] != "absent":
        return reply
    chunks = []
    if root is not None:
        intent, refusal = checked(root, bound, False)
        if refusal and refusal["status"] == "conflict":
            return refusal
        for index in (0, 1):
            path = root / f"log-{index}.bin"
            if path.exists():
                data = path.read_bytes()[: SEGMENT + 8]
                if len(data) >= 8:
                    chunks.append((int.from_bytes(data[:8], "big"), data[8:]))
    chunks.sort(key=lambda c: c[0])
    oldest = chunks[0][0] if chunks else 0
    total = chunks[-1][0] + len(chunks[-1][1]) if chunks else 0
    offset = request.get("offset")
    requested = offset if isinstance(offset, int) and offset >= 0 else max(0, total - PAGE)
    begin = min(max(requested, oldest), total)
    end = min(begin + PAGE, total)
    out = b""
    for at, part in chunks:
        lo, hi = max(0, min(begin - at, len(part))), max(0, min(end - at, len(part)))
        if hi > lo:
            out += part[lo:hi]
    return {"status": "logs", "jobId": request.get("jobId"), "offset": begin, "nextOffset": end,
            "oldestOffset": oldest, "totalBytes": total, "truncated": requested < oldest,
            "text": out.decode("utf-8", "replace"), "retainedBytesLimit": 2 * SEGMENT}


ACTIONS = {"hello": hello, "inspect": inspect, "start": start, "status": status, "cancel": cancel, "logs": logs,
           "pause": pause, "resume": resume}


def main():
    # The reply line carries the call's nonce: only this helper, which reads
    # it from stdin, can echo it, so nothing a login script prints passes.
    mark = MARK
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise Refused("The request must be a JSON object")
        nonce = request.get("replyNonce")
        if isinstance(nonce, str) and NONCE.fullmatch(nonce):
            mark = f"{MARK}{nonce} "
        if platform.system() != "Linux":
            raise Refused(f"This executor runs jobs on Linux machines; this one is {platform.system()}")
        host = host_id()
        if host is None:
            raise Refused("This machine has no machine-id, so Core cannot tell it apart from another machine "
                          "reached by the same name")
        action = ACTIONS.get(request.get("action"))
        if action is None:
            raise Refused("Unknown action")
        try:
            reply = action(request, host)
        except Busy:
            reply = {"status": "busy", "reason": "Another connection is working on this attempt"}
        except Unclear as error:
            reply = {"status": "unclear", "reason": str(error)}
    except Refused as error:
        print(mark + json.dumps({"error": str(error)}))
        sys.exit(3)
    reply["hostId"] = host
    reply["bootId"] = boot_id()
    print(mark + json.dumps(reply))


if __name__ == "__main__":
    main()
