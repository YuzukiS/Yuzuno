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
  deadline.json        the deadline the supervisor counts the timeout to, on
                       this boot's monotonic clock (boot_clock, named in it),
                       with the command's identity: applied by status if the
                       supervisor is gone
  stopping.json        when this helper first sent TERM to a lost attempt's
                       group, on the same clock, with the same identity: KILL
                       follows 5 s later, at whichever call reaches it
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
command may run, which never runs if one changed; with guardGit, so is
cwd's Git work tree (git_snapshot, by host.py's rules), read again once the
command exits by itself (exit_guard: a change is recorded, never a failure).
After a clean exit it
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
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import selectors
import signal
import stat
import subprocess
import time
import uuid

SEGMENT = 1024 * 1024
PIDFD = hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")
# macOS keeps none of /proc, and has no pidfd. The few facts this helper needs
# about a process come from libproc instead, in the same shapes; everything
# cgroup is simply absent there and is refused rather than imitated.
DARWIN = platform.system() == "Darwin"
# As for local jobs: inputs are small files; artifacts are hashed up to 1 GiB
# and parsed as JSON up to 16 MiB.
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


DARWIN_PROC_PIDTBSDINFO = 3
DARWIN_PROC_ALL_PIDS = 1


class DarwinBSDInfo(ctypes.Structure):
    """struct proc_bsdinfo, sys/proc_info.h. proc_pidinfo answers the whole
    structure or nothing: a shorter answer is not read as a process."""

    _fields_ = [
        ("pbi_flags", ctypes.c_uint32), ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32), ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32), ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32), ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32), ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16), ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32), ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32), ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32), ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64), ("pbi_start_tvusec", ctypes.c_uint64),
    ]


LIBPROC = ctypes.CDLL("/usr/lib/libproc.dylib") if DARWIN else None


def darwin_boot_id():
    """kern.bootsessionuuid: a UUID of this boot, as Linux's boot_id is."""
    out = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         universal_newlines=True, check=True)
    return out.stdout.strip()


def darwin_proc(pid):
    """proc()'s fields on macOS. starttime is microseconds of the clock
    kern.boottime is on and never changes for a PID's lifetime, so boot + PID
    + starttime names one process, as it does on Linux; two processes started
    in the same second differ here, which a second-resolution start time
    cannot show. A process that is gone and an unreaped zombie both answer
    None, as reading /proc/<pid>/stat does for Z and X."""
    if pid <= 0:
        return None
    info = DarwinBSDInfo()
    read = LIBPROC.proc_pidinfo(int(pid), DARWIN_PROC_PIDTBSDINFO, 0,
                                ctypes.byref(info), ctypes.sizeof(info))
    if read != ctypes.sizeof(info):
        return None
    try:
        session = os.getsid(int(pid))
    except OSError:
        return None
    return {"ppid": int(info.pbi_ppid), "pgrp": int(info.pbi_pgid), "session": session,
            "starttime": int(info.pbi_start_tvsec) * 1000000 + int(info.pbi_start_tvusec)}


def all_pids():
    """Every PID on the machine: /proc on Linux, proc_listpids on macOS.

    Raises Unclear when the machine cannot be asked. A machine never has no
    processes at all, so proc_listpids answering 0 or less means the question
    failed, not that nothing is running. Returning [] for that would report a
    live process group as gone: its reservation would be let go and its
    outcome written while its processes still ran."""
    # A test hook, inert unless the variable is set, in the shape of the ones
    # this helper already reads: while that file exists this machine cannot be
    # asked. It is the only way to reach, on any host, the failure that in
    # truth only proc_listpids produces.
    refuse = os.environ.get("YUZUNO_JOBS_PIDS_UNREADABLE_FILE")
    if refuse and os.path.exists(refuse):
        raise Unclear("this machine's processes could not be listed")
    if not DARWIN:
        return [int(name) for name in os.listdir("/proc") if name.isdigit()]
    size = LIBPROC.proc_listpids(DARWIN_PROC_ALL_PIDS, 0, None, 0)
    if size <= 0:
        raise Unclear("this machine's processes could not be listed")
    # Room for processes that start between the two calls.
    buf = (ctypes.c_int32 * (size // ctypes.sizeof(ctypes.c_int32) + 64))()
    got = LIBPROC.proc_listpids(DARWIN_PROC_ALL_PIDS, 0, ctypes.byref(buf), ctypes.sizeof(buf))
    if got <= 0:
        raise Unclear("this machine's processes could not be listed")
    return [int(each) for each in buf[:got // ctypes.sizeof(ctypes.c_int32)] if each > 0]


# What deadline.json and stopping.json are timed on: one clock for every
# process of this boot, so that a call can read a time another process wrote.
# time.monotonic() is that clock (CLOCK_MONOTONIC) on Linux, but on macOS each
# process's starts near 0 (the Command Line Tools' python3 3.9; YN-144, Job
# 2c6fc88d), so there it never applies a lost attempt's deadline and never
# KILLs after a TERM another call sent. CLOCK_MONOTONIC is one clock on both.
BOOT_CLOCK = "CLOCK_MONOTONIC"


def boot_clock():
    return time.clock_gettime(time.CLOCK_MONOTONIC)


def on_boot_clock(record):
    """Whether a record's time is on boot_clock: marked so, or, on Linux,
    written before the mark, when time.monotonic() already was that clock.
    An unmarked record on a Mac is on a clock no other process has."""
    clock = record.get("clock")
    return clock == BOOT_CLOCK or (clock is None and not DARWIN)


def boot_id():
    override = os.environ.get("YUZUNO_JOBS_BOOT_ID_FILE")
    if override:
        return read_text(override).strip()
    if DARWIN:
        return darwin_boot_id()
    return read_text("/proc/sys/kernel/random/boot_id").strip()


def proc(pid):
    """A live process's fields from /proc/<pid>/stat, or None if it is gone
    or a zombie. starttime (clock ticks after boot) never changes for a PID's
    lifetime, so boot + PID + starttime names one process. On macOS the same
    fields come from libproc (darwin_proc), where starttime is microseconds."""
    if DARWIN:
        return darwin_proc(pid)
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
    return [pid for pid in all_pids() if member(proc(pid), group)]


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


def live(group):
    """The group's live processes, or None when this machine could not be
    asked. None is not an empty group: a caller that cannot tell must not
    report the group as stopped."""
    try:
        return members(group)
    except Unclear:
        return None


# How long enumeration may keep failing before stop() gives its answer as
# "not empty" rather than wait on a machine that cannot be asked at all.
BLIND_LIMIT = 5


def stop(group, limit=None, since=None):
    """TERM the group's checked members, KILL whatever is left from 5 s after
    the first TERM (`since`, this boot's monotonic time an earlier call sent
    it, or now), and go on until none is left (or for `limit` seconds of this
    call). True only once the group is known to be empty: while the machine
    cannot be asked, nothing is signalled and nothing is called stopped, and
    after BLIND_LIMIT of that this answers False rather than waiting on it.

    The TERM goes to the first membership this call can actually see, which is
    not always at its start: while the machine cannot be asked there is
    nothing to signal, and a group that became visible later would otherwise
    be KILLed without ever being asked to end. Without `since` the 5 s before
    a KILL runs from that TERM rather than from a time nothing was signalled.
    `since` is the TERM an earlier call already sent, checked against this
    attempt, boot and process; it is kept, so a grace already given is never
    restarted by a later call. Times are on boot_clock, as `since` is."""
    begin = boot_clock()
    first = since
    termed = False
    blind = None
    while True:
        left = live(group)
        if left == []:
            return True
        now = boot_clock()
        if limit is not None and now - begin >= limit:
            return False
        if left is None:
            blind = now if blind is None else blind
            if now - blind >= BLIND_LIMIT:
                return False
        else:
            blind = None
            if not termed:
                for pid in left:
                    send(pid, signal.SIGTERM, group)
                termed = True
                if first is None:
                    first = now
            elif now - first >= 5:
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
        if before.st_size > INPUT_FILE_LIMIT:
            entry["problem"] = "%d bytes: an input is a small file (at most 2 MiB)" % before.st_size
            return entry
        with path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            data = stream.read(INPUT_FILE_LIMIT + 1)
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
        if frozen["sha256"] is None:
            # A tracked file Git listed as deleted (guardGit): still none.
            if now.get("problem") != "missing":
                changed.append("%s (%s)" % (frozen["path"], now.get("problem") or "it now exists"))
        elif now.get("problem"):
            changed.append("%s (%s)" % (frozen["path"], now["problem"]))
        elif now["absolutePath"] != frozen["absolutePath"]:
            changed.append("%s (now %s)" % (frozen["path"], now["absolutePath"]))
        elif now["sha256"] != frozen["sha256"]:
            changed.append("%s (its content changed)" % frozen["path"])
    return changed


# guardGit as for local jobs: host.py's snapshot, with the same rules, bounds
# and words (remote_git_parity_tests.py holds the two to the same answers).
# Git is the one on this account's PATH, as python3 is.
# >>> guard rules (source: core/src/jobs/guard_rules.py; generated by scripts/sync_guard_rules.py) >>>
# The input guard's rules, without I/O (YN-207): the bounds, the one refusal,
# which Git and file facts count as a change, the order a change is named in,
# the words of a refusal, the decision before a command may start, and what a
# finished attempt reports. Each end reads its own facts; nothing here opens a
# file, runs a command, talks to a process manager or writes a Job's state.
INPUT_FILE_LIMIT = 2 * 1024 * 1024
INPUT_TOTAL_LIMIT = 16 * 1024 * 1024
INPUT_COUNT_LIMIT = 128
GIT_STATUS_LIMIT = 64 * 1024


class InputGuard(RuntimeError):
    """The input guard refuses these inputs. A RuntimeError, so the wrapper's
    check before the command starts fails exactly as it always did. `detail`
    is what a local refusal reports to Core (host.rs); the other end keeps the
    same words and does not read it."""

    def __init__(self, problem, **detail):
        RuntimeError.__init__(self, problem)
        self.detail = dict({'problem': problem}, **detail)


def guard_scope(paths, cwd, root):
    """The paths guardPaths names (T-50), as the caller gave them and relative
    to the Git root ('' for the root itself). Taken as Git tracks them: joined
    to cwd and normalised, never through a link. One outside the work tree is
    refused."""
    scope = []
    for given in paths:
        full = Path(os.path.normpath(os.path.join(str(cwd), given)))
        try:
            inside = full.relative_to(root).as_posix()
        except ValueError:
            raise InputGuard('guardPaths must be inside the Git work tree of cwd (%s): %s is not' % (root, given),
                             limit='guardPath', path=given)
        if '\n' in inside:
            raise InputGuard('guardPaths cannot contain a line break: %r' % (given,), limit='guardPath', path=given)
        scope.append((given, '' if inside == '.' else inside))
    return scope


def guarded(name, scope):
    """A path relative to the Git root is under one of the guarded paths."""
    return any(not part or name == part or name.startswith(part + '/') for _, part in scope)


def guard_objects_from(scope, answers):
    """guard_objects' rule: one `git cat-file --batch-check` answer per guarded
    path, in order: that object's id and type, or neither where the frozen
    commit has nothing there."""
    objects = []
    for (given, _), answer in zip(scope, answers):
        found = answer.split(' ')
        known = len(found) == 3 and found[1] in ('blob', 'tree', 'commit')
        objects.append({'path': given, 'object': found[0] if known else None, 'type': found[1] if known else None})
    return objects


def git_compared(git):
    """What the check before the start compares. With guardPaths (T-50) the
    HEAD commit itself is left out: a commit that leaves the guarded paths
    alone does not stop the command; their content at HEAD, and the status
    digest, still count."""
    if isinstance(git, dict) and 'guardPaths' in git:
        return dict((key, value) for key, value in git.items() if key != 'head')
    return git


def git_changes(frozen, now):
    """What differs in the Git facts: the committed content of each guarded
    path (T-50), else the commit itself. The status digest is not a change of
    content: staging alone leaves every file as it was."""
    before = frozen if isinstance(frozen, dict) else {}
    after = now if isinstance(now, dict) else {}
    if 'guardPaths' in before:
        found = dict((g['path'], (g['object'], g['type'])) for g in after.get('guardPaths') or [])
        return ['the committed content of guarded path %s' % g['path'] for g in before['guardPaths']
                if found.get(g['path']) != (g['object'], g['type'])]
    return ['the Git commit'] if before.get('head') != after.get('head') else []


def file_changes(frozen, now):
    """Each named file whose recorded digest differs, by path, sorted: a file
    that is missing both times is named by neither, and a missing digest is
    only equal to another missing one."""
    before = dict((f['path'], f.get('sha256')) for f in frozen or [])
    after = dict((f['path'], f.get('sha256')) for f in now or [])
    return [path for path in sorted(set(before) | set(after)) if before.get(path) != after.get(path)]


def shown_list(changed):
    return ', '.join(changed[:5]) + (' and %d more' % (len(changed) - 5) if len(changed) > 5 else '')


def check_start(differs, frozen_git, now_git, changed_files, changed_tracked=(), resume_changed=False, hint=''):
    """None when the command may start, else why not, naming the facts in the
    order both ends have always named them: the Git commit (or the guarded
    paths' content), each changed file, each tracked file guardGit added, then
    the checkpoint a resume would use. A fact no item can name (staging
    alone, or a snapshot entry added later) still gets the fallback sentence.

    `differs` is the caller's own verdict over all its frozen facts, as it
    was before this rule was shared: host.py compares every key of the
    snapshot, so cwd, scope and any key added later still stop a start;
    remote_job.py asks whether a frozen input changed or the compared Git
    state does. The facts after it only choose the words, so an item named
    for explanation can never become a new reason to refuse."""
    if not differs:
        return None
    items = git_changes(frozen_git, now_git) + list(changed_files) + list(changed_tracked)
    if resume_changed:
        items.append('the checkpoint it resumes from')
    return 'Guarded inputs changed while queued (%s); command was not started.%s' % (
        shown_list(items) or 'the list of changed tracked files', hint)


def exit_changes(frozen_git, now_git, changed_inputs, changed_tracked, own):
    """The changes a finished attempt reports, in the order both ends have
    always named them: the Git commit (or each guarded path's committed
    content), then each frozen input whose content differs, then each tracked
    file that was not an input. `changed_inputs` and `changed_tracked` are
    (normalised path, the name to show) pairs; `own` is the normalised set of
    paths this attempt declared it writes (its artifacts and outputs). Only
    the file items leave out what the command wrote: the Git facts are
    compared whole, so a commit is still named."""
    changes = git_changes(frozen_git, now_git)
    changes += [shown for path, shown in changed_inputs if path not in own]
    changes += [shown for path, shown in changed_tracked if path not in own]
    return changes


def exit_reason(changes):
    """The words both ends report a work tree that changed while the command
    ran: what the two observations show, never who changed it or whether the
    result still stands."""
    return ('The guarded work tree changed while the command ran (%s), by the command or by someone else: '
            'its results may not match the code it was submitted with.' % shown_list(changes))
# <<< guard rules <<<


def git_env():
    return dict(os.environ, GIT_OPTIONAL_LOCKS="0")


def git_text(args):
    done = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8)
    return done.returncode, done.stdout.decode("utf-8", "surrogateescape").strip(), done.stderr.decode("utf-8", "replace")


def guard_objects(root, head, scope):
    lines = "".join("%s:%s\n" % (head, part) for _, part in scope).encode()
    try:
        done = subprocess.run(["git", "-C", str(root), "cat-file", "--batch-check"], input=lines, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=8, env=git_env())
    except subprocess.TimeoutExpired:
        raise InputGuard("Git could not read the guarded paths within eight seconds")
    answers = done.stdout.decode("utf-8", "surrogateescape").splitlines()
    if done.returncode or len(answers) != len(scope):
        raise InputGuard("Git could not read the guarded paths at HEAD")
    return guard_objects_from(scope, answers)


def git_status(args):
    with subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          env=git_env()) as process:
        status, complete = bytearray(), False
        try:
            with selectors.DefaultSelector() as poll:
                poll.register(process.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 8
                while len(status) <= GIT_STATUS_LIMIT:
                    left = deadline - time.monotonic()
                    if left <= 0 or not poll.select(left):
                        raise InputGuard("Git input guard exceeded its eight-second limit; use explicit inputs and guardGit=false")
                    chunk = os.read(process.stdout.fileno(), min(8192, GIT_STATUS_LIMIT + 1 - len(status)))
                    if not chunk:
                        complete = True
                        break
                    status.extend(chunk)
        finally:
            if not complete and process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise
        if complete and process.returncode:
            raise InputGuard("Git status could not verify the input guard")
    if len(status) > GIT_STATUS_LIMIT:
        raise InputGuard("Git change list exceeds 64 KiB; use explicit inputs and guardGit=false")
    return bytes(status)


def git_snapshot(cwd, paths, exclude, explicit=()):
    """host.py snapshot's Git state and bounds: (git, the changed tracked files
    it guards, by absolute path). git is None when cwd is in no work tree."""
    cwd = Path(cwd).resolve()
    excluded = {str(Path(p).parent.resolve() / Path(p).name) for p in exclude}
    git, tracked = None, set()
    code, top, _ = git_text(["git", "-C", str(cwd), "rev-parse", "--show-toplevel"])
    if code and paths:
        raise InputGuard("guardPaths need cwd inside a Git work tree: guardGit found none there")
    if not code:
        root = Path(top).resolve()
        code, head, error = git_text(["git", "-C", str(root), "rev-parse", "HEAD"])
        if code:
            raise InputGuard(error.strip()[:1000] or "Git could not read HEAD")
        scope = guard_scope(paths, cwd, root) if paths else None
        args = ["git", "-c", "core.fsmonitor=false", "-C", str(root), "status", "--porcelain=v1", "-z",
                "--untracked-files=no", "--ignore-submodules=all"]
        if scope is not None and all(part for _, part in scope):
            args += ["--"] + [":(literal)" + part for _, part in scope]
        status = git_status(args)
        kept = []
        entries = iter(status.split(b"\0"))
        for entry in entries:
            if not entry:
                continue
            record = [entry]
            moved = b"R" in entry[:2] or b"C" in entry[:2]
            if moved:
                record.append(next(entries, b""))
            name = os.fsdecode(entry[3:])
            if scope is not None and not (guarded(name, scope) or moved and guarded(os.fsdecode(record[1]), scope)):
                continue
            if not moved and str(root / name) in excluded:
                continue
            tracked.add(str(root / name))
            kept.append(b"\0".join(record))
        listed = b"\0".join(kept) if excluded or scope is not None else status
        git = {"root": str(root), "head": head, "statusSha256": hashlib.sha256(listed).hexdigest()}
        if scope is not None:
            git["guardPaths"] = guard_objects(root, head, scope)
    files = set(explicit) | tracked
    if len(files) > INPUT_COUNT_LIMIT:
        why = (" (%d of them changed tracked Git files, guarded because guardGit is true)" % len(tracked)) if tracked else ""
        raise InputGuard("At most %d guarded input files are supported; these are %d%s" % (INPUT_COUNT_LIMIT, len(files), why))
    total = from_git_bytes = 0
    for name in sorted(files):
        path = Path(name) if os.path.isabs(name) else cwd / name
        try:
            shown = str(path.relative_to(cwd))
        except ValueError:
            shown = str(path)
        if not path.exists():
            continue
        if not path.is_file():
            raise InputGuard("Guarded inputs must be files: " + shown)
        size = path.stat().st_size
        total += size
        from_git_bytes += size if name in tracked else 0
        if size > INPUT_FILE_LIMIT or total > INPUT_TOTAL_LIMIT:
            what = ("%s is %d bytes, over the 2 MiB per-file limit" % (shown, size) if size > INPUT_FILE_LIMIT else
                    "guarded inputs reach %d bytes with %s, over the 16 MiB total limit" % (total, shown))
            if name in tracked:
                why = (" It is a changed tracked Git file, guarded because guardGit is true: commit it, or submit with "
                       "guardGit=false and list the inputs the command reads.")
            elif from_git_bytes:
                why = " Changed tracked Git files, guarded because guardGit is true, are %d bytes of that." % from_git_bytes
            else:
                why = ""
            raise InputGuard("%s: guarded inputs are at most 2 MiB each and 16 MiB together, and large data is not "
                             "snapshotted.%s" % (what, why))
    return git, sorted(tracked)


def exit_guard(spec, attempt):
    """host.py exit_guard on this machine (YN-194): the work tree read again
    once the command exited, compared with the start's by commit (or guarded
    paths) and by each file's content. The files the job declared it writes
    are left out of the file items, and so is the status digest, which those
    writes alter. None without a frozen Git state, and a work tree that cannot
    be read again is neither unchanged nor changed."""
    frozen = spec["git"]["frozen"]
    if not frozen:
        return None
    record = {"attempt": attempt, "checkedAt": time.time()}
    try:
        now, tracked = git_snapshot(spec["cwd"], [g["path"] for g in frozen.get("guardPaths") or []],
                                    spec["git"].get("guardExclude") or [])
    except Exception as error:
        return dict(record, unchanged=None, problem=("the work tree could not be read again: %s" % error)[:300])
    cwd = Path(spec["cwd"]).resolve()

    def real(path):
        # As snapshots name files: through the resolved folder.
        path = cwd / path
        return str(path.parent.resolve() / path.name)
    own = {real(p) for p in [a["path"] for a in spec.get("artifacts") or []] + (spec.get("outputs") or [])}
    inputs = spec.get("inputs") or []
    named = {i["path"] for i in inputs}
    # Read as at the start, and only what this attempt did not declare it writes.
    checked = [(real(i["path"]), i["path"]) for i in inputs if real(i["path"]) not in own
               and inputs_changed(dict(spec, inputs=[i]))]
    extra = [(real(p), p) for p in tracked if p not in named]
    changed = exit_changes(frozen, now or {}, checked, extra, own)
    if not changed:
        return dict(record, unchanged=True)
    return dict(record, unchanged=False, changed=[c[:300] for c in changed[:20]],
                reason=exit_reason(changed)[:1000])


def upstream_problem(spec):
    """host.py's: why the artifacts this stage depends on are no longer what
    their stages produced (every earlier stage it depends on when its run
    recorded them, else its direct upstream). A stage the digest binds as
    needed with no upstream record is never taken as checked."""
    named = {u["stage"] for u in spec["upstream"]}
    missing = [need for need in spec["needs"] if need not in named]
    if missing:
        return "Not started on this machine: no upstream record came for stage %s" % ", ".join(missing)
    for upstream in spec["guardChecks"] or spec["upstream"]:
        for recorded in upstream.get("artifacts") or []:
            now = check_artifact(upstream["cwd"], dict({"format": "bytes", "minBytes": 1}, **recorded))
            same = now.get("ok") and now.get("bytes") == recorded.get("bytes") and (
                now.get("sha256") == recorded["sha256"] if recorded.get("sha256") else now.get("mtimeNs") == recorded.get("mtimeNs"))
            if not same:
                return ("Upstream stage %s artifact %s is no longer the one it succeeded with (%s); command was not started"
                        % (upstream["stage"], recorded["path"], now.get("problem") or "its content changed"))
    return None


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
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, universal_newlines=True, timeout=5)
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
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, timeout=8)
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
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, universal_newlines=True, timeout=10)
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
        return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True, timeout=15)
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
        # The process's own open files: /proc/self/fd on Linux, /dev/fd on
        # macOS, which has no /proc. Reading the wrong one raises here, and
        # this is the command's process: it would die before the go byte and
        # the supervisor's write would find no reader.
        for name in os.listdir("/dev/fd" if DARWIN else "/proc/self/fd"):
            if not name.isdigit():
                continue
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
        # The GPUs reserved for this attempt, and only those (as host.py).
        reserved = (spec.get("gpu") or {}).get("reserved") or []
        env = dict(spec["env"], CUDA_VISIBLE_DEVICES=",".join(reserved), YUZUNO_JOB_GPUS=",".join(reserved)) if reserved else spec["env"]
        os.execvpe(spec["argv"][0], spec["argv"], env)
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
# command may run (as local jobs do): if one changed, it never runs. With
# guardGit the work tree is read again as at submit, and named as local jobs
# name it.
changed = inputs_changed(spec) if child else []
guard = spec.get("git")
refused = checked_guard = None
if child and guard is not None:
    frozen = guard["frozen"]
    try:
        now, tracked = git_snapshot(spec["cwd"], [g["path"] for g in (frozen or {}).get("guardPaths") or []],
                                    guard.get("guardExclude") or [])
        named = set(i["path"] for i in spec.get("inputs") or [])
        hint = (" If an earlier stage writes a tracked file, declare it as that stage's artifact."
                if "needs" in spec else "")
        refused = check_start(bool(changed) or git_compared(now) != git_compared(frozen), frozen, now,
                              changed, [p for p in tracked if p not in named], hint=hint)
        if refused is None and frozen and "guardPaths" in frozen:
            # What the start found, as local jobs record it (guard.json).
            checked_guard = {"checkedAt": time.time(), "headAtSubmit": frozen["head"], "headAtStart": now["head"],
                             "guardedUnchanged": True}
    except Exception as error:
        refused = "Not started on this machine: the Git input guard could not be checked again (%s)" % error
elif changed:
    refused = "Inputs changed on this machine while queued (%s); command was not started" % (
        ", ".join(changed[:5]) + (" and %d more" % (len(changed) - 5) if len(changed) > 5 else ""))
if child and not refused and "needs" in spec:
    # A run's stage: its upstream artifacts as they succeeded, as local jobs check them.
    try:
        refused = upstream_problem(spec)
    except Exception as error:
        refused = "Not started on this machine: its upstream artifacts could not be checked (%s)" % error
if refused:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    if kept:
        os.close(kept[1])
        os.waitpid(kept[0], 0)
    outcome(root, intent, "rejected", refused)
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
deadline = boot_clock() + spec["timeoutSeconds"]
# The same deadline for status, if this supervisor is gone before it.
# boot_clock is one clock for this boot's processes, so the record names the
# clock, the boot and the command's identity. Without it nothing is applied in
# this supervisor's place.
try:
    atomic(root / "deadline.json", {"bootId": group["bootId"], "pid": pid, "starttime": group["starttime"],
                                    "timeoutSeconds": spec["timeoutSeconds"], "monotonic": deadline,
                                    "clock": BOOT_CLOCK})
except OSError:
    pass
why = None
# Whether the stop this supervisor asked for was confirmed; nothing to stop
# yet counts as settled.
stopped = True
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
        elif boot_clock() > deadline:
            # The timeout counts while the job is paused, as for local jobs.
            why = "timeout"
        if why:
            # A paused job is thawed first, so its processes can act on TERM.
            thawed = thaw_for_stop(root, intent) if held else None
            # Until nothing of the group is left; the leader is then a zombie.
            stopped = stop(group)
    elif not stopped:
        # Last time this machine could not be asked, so nothing was
        # signalled. A group that was never reached is not a stopped one:
        # keep trying while the command is still being waited on.
        stopped = stop(group)
    time.sleep(0.2)
# The command has exited; nothing of its group may outlive it, and the
# outcome is written only once nothing is left.
# None when this machine could not be asked: not reported as none left.
remaining = live(group)
leftovers = None if remaining is None else len(remaining)
if held and leftovers != 0:
    thawed = thaw_for_stop(root, intent) or thawed
settled = stop(group)
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
if why is not None:
    note = ""
elif leftovers is None:
    # Said rather than counted as none: the outcome never claims a group was
    # empty on a machine that could not be asked.
    note = "; whether any process was left in its process group could not be checked on this machine"
elif leftovers:
    note = "; %d process(es) left in its process group were stopped" % leftovers
else:
    note = ""
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
if checked_guard:
    extra = dict(extra or {}, guard=checked_guard)
# The Git guard again, now that the command exited by itself (YN-194, as
# host.py's worker checks it): a change is said, never a failure.
if guard is not None and why is None and settled:
    try:
        at_exit = exit_guard(spec, intent["attempt"])
    except Exception:
        at_exit = None
    if at_exit:
        extra = dict(extra or {}, guardAtExit=at_exit)
if not settled:
    # Stopping was never confirmed: this machine could not be asked whether
    # anything of the group is left. Nothing terminal is written here, and
    # saying so in an outcome would not help -- an outcome releases the
    # attempt's reservation while its processes may still be running. Instead
    # this supervisor leaves no result.json and ends, which is the state Core
    # already reads as lost: it keeps the slot and checks this same attempt
    # again, and once the machine can be asked the existing recovery settles
    # it. Before this, an unbounded stop() could only return once the group
    # was empty, so the outcome below was safe to write unconditionally.
    pass
elif why == "cancel" or (root / "cancel.json").exists():
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
# A folder name of a data root: plain characters, and spaces inside one but
# never at either end, as in a macOS Core's own data folder under
# "Application Support" (YN-108 M2c). Core's check of a registered machine's
# root (remote.rs validate_root) still allows no space.
ROOT_PART = re.compile(r"[A-Za-z0-9._-](?:[A-Za-z0-9._ -]*[A-Za-z0-9._-])?")
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
    if DARWIN and not override:
        # macOS has no machine-id. IOPlatformUUID names the machine the same
        # way: hashed here as the Linux one is, and written in its shape
        # (32 hex digits) so that nothing downstream tells the two apart.
        try:
            out = subprocess.run(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 universal_newlines=True, check=True).stdout
        except (OSError, subprocess.CalledProcessError):
            return None
        found = re.search(r'"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"', out)
        if not found:
            return None
        value = found.group(1).replace("-", "").lower()
        if HOST.fullmatch(value):
            return hashlib.sha256(b"yuzuno-jobs-host-v1:" + value.encode()).hexdigest()[:32]
        return None
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
    frozen inputs or declared artifacts is v3 and binds those as well; one
    with git, outputs, needs or gpu is v4: v3's fields and those. An attempt
    recorded with an earlier version keeps the digest it was recorded with:
    v1 to v3 are unchanged."""
    hasher = hashlib.sha256()

    def put(text):
        data = text.encode("utf-8")
        hasher.update(b"%d:" % len(data))
        hasher.update(data)
        hasher.update(b",")
    limits = spec.get("limits")
    v4 = any(spec.get(key) is not None for key in ("git", "outputs", "needs", "gpu"))
    # None or empty: no inputs or artifacts, so v1 or v2 exactly as before.
    v3 = v4 or bool(spec.get("inputs") or spec.get("artifacts"))
    put("yuzuno-remote-job-v4" if v4 else "yuzuno-remote-job-v3" if v3 else "yuzuno-remote-job-v2"
        if limits is not None else "yuzuno-remote-job-v1")
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
            # None: a tracked file Git listed as deleted (v4 only).
            put(item["sha256"] or "")
        put(str(len(artifacts)))
        for item in artifacts:
            put(item["path"])
            put(item["format"])
            put(str(item["minBytes"]))
    if v4:
        git = spec.get("git")
        put("git")
        frozen = (git or {}).get("frozen")
        put("none" if git is None else "no work tree" if frozen is None else "work tree")
        if frozen is not None:
            for key in ("root", "head", "statusSha256"):
                put(frozen[key])
            objects = frozen.get("guardPaths")
            put("whole work tree" if objects is None else str(len(objects)))
            for item in objects or []:
                for key in ("path", "object", "type"):
                    put(item.get(key) or "")
        if git is not None:
            put(str(len(git["guardExclude"])))
            for path in git["guardExclude"]:
                put(path)
        # A list of names by count, or "none": declared outputs and a
        # stage's needs; then a GPU request with the devices reserved for it.
        gpu = spec.get("gpu")
        for key in ("outputs", "needs", "gpu"):
            items = spec.get(key) if key != "gpu" else None
            put(key)
            if key == "gpu" and gpu is not None:
                items = None
                for value in (gpu["count"], gpu["memoryMiB"]):
                    put(str(value))
                put(gpu["mode"])
                for names in (gpu["devices"], gpu["reserved"]):
                    put("unreserved" if names is None else str(len(names)))
                    for name in names or []:
                        put(name)
                continue
            put("none" if items is None else str(len(items)))
            for item in items or []:
                put(item)
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
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, universal_newlines=True,
                               timeout=10).stdout.strip()
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
    if DARWIN:
        # Not "systemd did not answer": macOS has no systemd and no cgroup at
        # all, so no hard limit exists to be held here. Saying it the Linux
        # way would read as a machine that could hold limits once something
        # answered.
        why = ("macOS has no cgroup: this platform holds no hard CPU or RAM limit, so a declared limit is "
               "reserved for admission and recorded, never enforced (RLIMIT_RSS is not enforced there, "
               "RLIMIT_AS bounds one process's address space without holding its children, RLIMIT_CPU bounds "
               "CPU seconds rather than a share, and taskpolicy lowers quality of service without bounding)")
    elif facts.get("manager") is not True:
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
    an absolute folder, of plain names only (ROOT_PART)."""
    given = request.get("root")
    if not isinstance(given, str):
        raise Refused("root must name the machine's data folder")
    parts = given[2:].split("/") if given.startswith("~/") else given[1:].split("/") if given.startswith("/") else []
    if len(given) > 1024 or not parts or any(p in (".", "..") or not ROOT_PART.fullmatch(p) for p in parts):
        raise Refused("root must be ~/<folder> or an absolute folder of plain names (letters, digits, . _ - and spaces "
                      "inside a name)")
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
    # executable: the python3 answering, which a Core-built command such as
    # the cleanup inventory (YN-74) runs, so it is the same interpreter.
    reply = {"status": "hello", "platform": platform.system(), "python": platform.python_version(), "pidfd": PIDFD,
             "executable": sys.executable or "", "resources": capabilities()}
    # The absolute root a start would go to, which Core pins with the
    # machine. Nothing is created.
    if "root" in request:
        reply["root"] = str(data_root(request))
    return reply


def inspect(request, host):
    """A job's inputs as they are on this machine, for Core to freeze at
    submit: what each path leads to, its SHA-256 and identity, or why it
    cannot be an input. Reads only; no attempt, nothing written. With git
    (guardGit) also the work tree's state, and its changed tracked files
    after the explicit inputs (tracked; one Git lists as deleted is frozen as
    missing, sha256 null, as for local jobs)."""
    cwd, paths, guard = request.get("cwd"), request.get("inputs"), request.get("git")
    if not (isinstance(cwd, str) and os.path.isabs(cwd)):
        raise Refused("cwd must be an absolute path")
    if not (isinstance(paths, list) and (paths or guard is not None) and len(paths) <= 128
            and all(isinstance(p, str) and p and len(p) <= 4096 and "\0" not in p for p in paths)):
        raise Refused("inputs must be 1-128 paths")
    if guard is not None and not (isinstance(guard, dict) and all(
            isinstance(guard.get(k), list) and all(isinstance(p, str) and "\0" not in p for p in guard[k])
            for k in ("guardPaths", "guardExclude"))):
        raise Refused("git must name guardPaths and guardExclude, lists of paths")
    if not os.path.isdir(cwd):
        raise Refused(f"The working directory {cwd!r} does not exist on this machine")
    files = [input_facts(cwd, p) for p in paths]
    reply = {"status": "inspected", "cwd": cwd, "files": files}
    if guard is not None:
        try:
            problem = git_usable()
            if problem:
                raise InputGuard(problem)
            reply["git"], tracked = git_snapshot(cwd, guard["guardPaths"], guard["guardExclude"], paths)
        except (InputGuard, OSError, subprocess.SubprocessError) as error:
            reply["problem"] = str(error)
            tracked = []
        for path in tracked:
            if path not in paths:
                entry = input_facts(cwd, path)
                if entry.get("problem") == "missing":
                    entry = {"path": path, "absolutePath": path, "sha256": None}
                files.append(dict(entry, tracked=True))
    total = reply["totalBytes"] = sum(f.get("bytes", 0) for f in files)
    if total > INPUT_TOTAL_LIMIT and "problem" not in reply:
        reply["problem"] = f"{total} bytes in all: inputs are small files (at most 16 MiB together)"
    return reply


def git_usable():
    """Why this account's git cannot guard here: none on its PATH, or Apple's
    stand-in without the Command Line Tools (as for python3, remote.rs)."""
    if shutil.which("git") is None:
        return "`git` is not on this account's PATH there"
    done = subprocess.run(["git", "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, timeout=5)
    said = done.stdout.decode("utf-8", "replace")
    if "xcode-select" in said or "xcrun" in said:
        return ("its git is Apple's stand-in, which runs nothing until the Command Line Tools are installed "
                "(xcode-select --install)")
    return "`git --version` exited %d there" % done.returncode if done.returncode else None


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
                isinstance(i, dict) and all(isinstance(i.get(k), str) for k in ("path", "absolutePath"))
                and (isinstance(i.get("sha256"), str) or "git" in request and "sha256" in i and i["sha256"] is None)
                for i in inputs)):
            raise Refused("inputs must be the files Core froze: path, absolutePath and sha256 of each")
        if inputs:
            spec["inputs"] = inputs
    if "outputs" in request:
        outputs = request["outputs"]
        if not (isinstance(outputs, list) and 1 <= len(outputs) <= 20 and all(
                isinstance(p, str) and p and not os.path.isabs(p) and ".." not in p.split("/") for p in outputs)):
            raise Refused("outputs must be 1-20 paths relative to cwd")
        spec["outputs"] = outputs
    if "git" in request:
        git = request["git"]
        frozen = git.get("frozen", 0) if isinstance(git, dict) else 0
        if not (isinstance(git, dict) and isinstance(git.get("guardExclude"), list)
                and all(isinstance(p, str) for p in git["guardExclude"])
                and (frozen is None or isinstance(frozen, dict)
                     and all(isinstance(frozen.get(k), str) for k in ("root", "head", "statusSha256"))
                     and isinstance(frozen.get("guardPaths", []), list)
                     and all(isinstance(g, dict) and isinstance(g.get("path"), str) and all(
                         g.get(k) is None or isinstance(g.get(k), str) for k in ("object", "type"))
                         for g in frozen.get("guardPaths", [])))):
            raise Refused("git must be the Git state Core froze (root, head, statusSha256, guardPaths) and guardExclude")
        spec["git"] = {"frozen": frozen, "guardExclude": git["guardExclude"]}
    if "artifacts" in request:
        artifacts = request["artifacts"]
        if not (isinstance(artifacts, list) and len(artifacts) <= 20 and all(
                isinstance(a, dict) and isinstance(a.get("path"), str) and a.get("format") in ("bytes", "json", "jsonl")
                and isinstance(a.get("minBytes"), int) and a["minBytes"] >= 0 for a in artifacts)):
            raise Refused("artifacts must be declared as path, format (bytes, json or jsonl) and minBytes")
        if artifacts:
            spec["artifacts"] = artifacts
    if "gpu" in request:
        # A GPU request (YN-83 S2 PR6), with the devices reserved for it by UUID.
        gpu = request["gpu"]
        if not (isinstance(gpu, dict) and all(type(gpu.get(k)) is int and gpu[k] > 0 for k in ("count", "memoryMiB"))
                and gpu.get("mode") in ("exclusive", "shared") and all(
                    isinstance(gpu.get(k), list) and all(isinstance(u, str) and u.startswith("GPU-") for u in gpu[k])
                    for k in ("devices", "reserved"))):
            raise Refused("gpu must be the request with the devices reserved for it, by UUID")
        spec["gpu"] = {k: gpu[k] for k in ("count", "memoryMiB", "mode", "devices", "reserved")}
    if "needs" in request:
        # A run's stage (YN-83 S2): the stages it needs, bound by the digest,
        # and the artifacts their attempts succeeded with, checked again by
        # the supervisor before the command may run.
        needs, checks = request["needs"], [request.get(k) or [] for k in ("upstream", "guardChecks")]
        if not (isinstance(needs, list) and len(needs) <= 64 and all(isinstance(n, str) for n in needs) and all(
                isinstance(c, list) and all(isinstance(u, dict) and isinstance(u.get("stage"), str) and isinstance(u.get("cwd"), str)
                                            and isinstance(u.get("artifacts", []), list) and all(
                    isinstance(a, dict) and isinstance(a.get("path"), str) for a in u.get("artifacts", [])) for u in c)
                for c in checks)):
            raise Refused("needs must name stages, with upstream and guardChecks as the artifacts their attempts succeeded with")
        spec.update(needs=needs, upstream=checks[0], guardChecks=checks[1])
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


def past_deadline(root, started):
    """Whether the deadline a lost attempt's supervisor counted to has passed:
    its deadline.json for the process started.json names, in this boot, on the
    same monotonic clock. Whatever cannot be confirmed has not passed."""
    try:
        deadline = read_json(root / "deadline.json")
        spec = read_json(root / "spec.json")
    except Unclear:
        return False
    if not (isinstance(deadline, dict) and isinstance(spec, dict)):
        return False
    at = deadline.get("monotonic")
    if not isinstance(at, (int, float)) or isinstance(at, bool):
        return False
    return (all(deadline.get(key) == started.get(key) for key in ("bootId", "pid", "starttime"))
            and deadline["bootId"] == boot_id() and deadline.get("timeoutSeconds") == spec.get("timeoutSeconds")
            and on_boot_clock(deadline) and boot_clock() > at)


def overdue(root, started):
    """Whether a lost attempt's command still runs past that deadline, as the
    leader of the attempt's group: only then does a status apply the timeout,
    and nothing is stopped for what cannot be confirmed."""
    return past_deadline(root, started) and alive(started) and started["pid"] in members(started)


STOPPING = ("bootId", "pid", "pgid", "sid", "starttime")


def first_term(root, intent, started):
    """The monotonic time this helper first sent TERM to a lost attempt's
    group (stopping.json), when the record is for this attempt, boot and
    recorded process and on this clock; None otherwise."""
    try:
        record = read_json(root / "stopping.json")
    except Unclear:
        return None
    at = record.get("monotonic") if isinstance(record, dict) else None
    if (isinstance(at, (int, float)) and not isinstance(at, bool) and record.get("attempt") == intent["attempt"]
            and all(record.get(key) == started.get(key) for key in STOPPING)
            and record["bootId"] == boot_id() and on_boot_clock(record) and at <= boot_clock()):
        return at
    return None


def timing_out(root, intent, started):
    """Whether a status has already begun applying this lost attempt's
    timeout: its own first TERM is recorded, past the deadline (status asks only
    when no cancel was asked for, so that TERM was the timeout's). The leader
    was confirmed running then, so the timeout goes on until nothing of the
    group is left, also once the leader has ended on that TERM and only others
    of its group are left."""
    return first_term(root, intent, started) is not None and past_deadline(root, started)


def stop_lost(root, intent, started):
    """Stop what is left of a lost attempt's group from this helper, for at
    most 4 s of this call: TERM, and KILL once 5 s have passed since the first
    TERM any call sent it. That time is kept in stopping.json, for this
    attempt, boot and recorded process, under the attempt's lock, and is never
    moved later. A record that cannot be read, is another's or is not on this
    clock counts as none: it never brings a KILL forward, and this call's own
    first TERM replaces it. (whether nothing is left, why the time could not be
    recorded or None.)"""
    at = first_term(root, intent, started)
    if at is not None:
        return stop(started, limit=4, since=at), None
    first = boot_clock()
    left = members(started)
    for pid in left:
        send(pid, signal.SIGTERM, started)
    since, problem = None, None
    if left:
        try:
            atomic(root / "stopping.json", dict({key: started[key] for key in STOPPING}, attempt=intent["attempt"],
                                                monotonic=first, clock=BOOT_CLOCK))
            since = first
        except OSError as error:
            problem = "the time of its first TERM could not be recorded (%s), so no later call KILLs it" % (
                error.strerror or error)
    return stop(started, limit=4, since=since), problem


def time_out(root, intent, reply):
    """The timeout of a lost attempt, which its supervisor is no longer there
    to apply, stopped as cancel stops one: a paused scope thawed first, and
    the outcome recorded only once nothing of the group is left. Until then
    it stays lost, and the next status goes on. Bounded within Core's 30 s for
    one call, as cancel is."""
    thawed = thaw_for_stop(root, intent)
    stopped, problem = stop_lost(root, intent, reply["started"])
    if stopped:
        outcome(root, intent, "failed", "timeout after %d s; its supervisor was gone, so its process group was stopped here"
                % read_json(root / "spec.json")["timeoutSeconds"], extra={"thawedToStop": thawed} if thawed else None)
    reply = state(root, intent)
    if problem and reply["status"] != "terminal":
        reply["stopRecord"] = problem
    return reply


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
        # A cancel writes cancel.json before it stops anything: once one was
        # asked for, the stop is the cancel's, and is never taken for a timeout.
        if (reply["status"] == "lost" and not (root / "cancel.json").exists()
                and (overdue(root, reply["started"]) or timing_out(root, intent, reply["started"]))):
            reply = time_out(root, intent, reply)
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
            stopped, problem = stop_lost(root, intent, reply["started"])
            if stopped:
                outcome(root, intent, "cancelled",
                        "Cancelled; its supervisor was gone, so what was left of its process group was stopped here")
                return state(root, intent)
            if problem:
                reply["stopRecord"] = problem
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


def verify(request, host):
    """Declared artifacts as they are now, checked as after a clean exit, for
    Core to reuse an earlier attempt's (a run's stage). Reads only."""
    cwd, artifacts = request.get("cwd"), request.get("artifacts")
    if not (isinstance(cwd, str) and os.path.isabs(cwd) and isinstance(artifacts, list) and len(artifacts) <= 20
            and all(isinstance(a, dict) and isinstance(a.get("path"), str) for a in artifacts)):
        raise Refused("verify needs an absolute cwd and at most 20 artifacts")
    return {"status": "verified", "artifacts": [check_artifact(cwd, dict({"format": "bytes", "minBytes": 1}, **a))
                                                for a in artifacts]}

def fetch(request, host):
    """One artifact or output of this attempt as raw bytes on stdout (YN-83
    S2): a reply line with its size, then exactly those bytes from the file
    opened, then a reply line with their SHA-256. Its path comes only from
    this attempt's own records (artifacts.json, spec.json), never from the
    request, and must stay inside the job's cwd. Nothing is sent but a reply
    when it is refused; fewer bytes than said end it with no last line."""
    kind, index, nonce = request.get("kind"), request.get("index"), request.get("replyNonce")
    if kind not in ("artifact", "output") or type(index) is not int or index < 0 or not NONCE.fullmatch(str(nonce)):
        raise Refused("fetch needs kind artifact or output, an index and a reply nonce")
    root, bound, reply = find(request, host, False)
    if reply:
        return reply
    intent, reply = checked(root, bound, False)
    if reply:
        return reply
    spec, entry = read_json(root / "spec.json"), None
    if kind == "artifact":
        record = read_json(root / "artifacts.json")
        if isinstance(record, dict) and record.get("attempt") == intent["attempt"]:
            found = record.get("artifacts")
            entry = found[index] if isinstance(found, list) and index < len(found) else None
        if not (isinstance(entry, dict) and entry.get("ok") is True and isinstance(entry.get("path"), str)):
            raise Refused("This attempt has no verified artifact at that position")
        given = entry["path"]
    else:
        outputs = spec.get("outputs") or []
        if index >= len(outputs):
            raise Refused("This attempt declared no output at that position")
        given = outputs[index]
    base = os.path.realpath(spec["cwd"])
    path = os.path.realpath(os.path.join(base, given))
    if os.path.commonpath([base, path]) != base:
        raise Refused("%s resolves outside the working directory" % given)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return {"status": "missing", "reason": "%s is not there" % given}
    except OSError as error:
        raise Refused("%s cannot be opened here: %s" % (given, error.strerror or error))
    with os.fdopen(fd, "rb", buffering=0) as stream:
        first = os.fstat(fd)
        if not stat.S_ISREG(first.st_mode):
            raise Refused("%s is not a regular file" % given)
        if entry and (first.st_size != entry.get("bytes") or not entry.get("sha256") and first.st_mtime_ns != entry.get("mtimeNs")):
            raise Refused("%s is no longer the file this attempt produced (its size or modification time changed); it was "
                          "overwritten or removed after the attempt" % given)
        out, mark = sys.stdout.buffer, "%s%s " % (MARK, nonce)
        head = {"status": "fetch", "bytes": first.st_size, "sha256": entry.get("sha256") if entry else None,
                "name": os.path.basename(given), "hostId": host}
        out.write((mark + json.dumps(head) + "\n").encode())
        hasher, left = hashlib.sha256(), first.st_size
        while left:
            chunk = stream.read(min(SEGMENT, left))
            if not chunk:
                out.flush()
                sys.exit(4)
            hasher.update(chunk)
            out.write(chunk)
            left -= len(chunk)
        last = os.fstat(fd)
        # Identified by size and modification time only (over 1 GiB): the
        # same before and after the read, or no last line.
        if entry and not entry.get("sha256") and (last.st_size, last.st_mtime_ns) != (first.st_size, first.st_mtime_ns):
            out.flush()
            sys.exit(4)
        out.write((mark + json.dumps({"status": "fetched", "sha256": hasher.hexdigest()}) + "\n").encode())
        out.flush()
    return None

ACTIONS = {"hello": hello, "inspect": inspect, "start": start, "status": status, "cancel": cancel, "logs": logs,
           "pause": pause, "resume": resume, "fetch": fetch, "verify": verify}

# Core reads at most 256 KiB of a call's output (remote.rs REPLY_LIMIT), what
# the account's login scripts print before the reply included; more is no
# answer. A reply's whole frame (its mark, the call's nonce, its JSON and the
# newline) stays within FRAME_BUDGET, leaving the rest for them.
FRAME_LIMIT = 256 * 1024
FRAME_BUDGET = FRAME_LIMIT - 32 * 1024
# Each artifact's own check, which a reply too long for its frame keeps.
CHECKED = ("format", "minBytes", "ok", "problem", "bytes", "sha256", "hash", "lines", "mtimeNs", "preExisting",
           "unchangedSinceStart")


def frame_bytes(mark, text):
    return len((mark + text + "\n").encode("utf-8", "surrogateescape"))


def within_frame(reply, mark, action):
    """The reply's JSON, as long as its frame fits FRAME_BUDGET.

    A terminal reply too long for it is projected: the attempt, the outcome,
    its reason and exit, and each declared artifact's check stay, by index
    and with the SHA-256 of its path; the artifacts' paths and absolute paths
    are left out, which artifactsOmitted says (fields, count, the reply's
    size), and are kept, with the whole check, in the attempt's artifacts.json
    here. Bounded by construction: an artifact's check has no path in it, at
    most 20 artifacts are declared, a reason with them is at most 1,000
    characters plus a note, and guardAtExit names at most 20 changes of 300
    characters with a reason of 1,000. An inspect too long for it is refused, nothing
    frozen. Anything else too long for it (none, by construction) is
    unclear."""
    text = json.dumps(reply)
    full = frame_bytes(mark, text)
    if full <= FRAME_BUDGET:
        return text
    if action == "inspect":
        raise Refused("The inputs' details would make a %d-byte reply, more than one reply to Core may carry (%d bytes); "
                      "nothing was frozen. Name fewer inputs, or ones with shorter paths" % (full, FRAME_BUDGET))
    result = reply.get("result")
    if isinstance(result, dict) and isinstance(result.get("artifacts"), list):
        checks = [dict({key: a[key] for key in CHECKED if key in a}, index=i,
                       pathSha256=hashlib.sha256(a["path"].encode("utf-8", "surrogateescape")).hexdigest())
                  for i, a in enumerate(result["artifacts"])]
        omitted = {"fields": ["path", "absolutePath"], "count": len(checks), "replyBytes": full, "record": "artifacts.json"}
        text = json.dumps(dict(reply, result=dict(result, artifacts=checks, artifactsOmitted=omitted)))
        if frame_bytes(mark, text) <= FRAME_BUDGET:
            return text
    return json.dumps({"status": "unclear", "hostId": reply.get("hostId"), "bootId": reply.get("bootId"),
                       "reason": "its details would make a %d-byte reply, more than one reply to Core may carry (%d bytes)"
                       % (full, FRAME_BUDGET)})


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
        if platform.system() not in ("Linux", "Darwin"):
            raise Refused(f"This executor runs jobs on Linux and macOS machines; this one is {platform.system()}")
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
    if reply is None:
        return
    reply["hostId"] = host
    reply["bootId"] = boot_id()
    try:
        text = within_frame(reply, mark, request.get("action"))
    except Refused as error:
        print(mark + json.dumps({"error": str(error)}))
        sys.exit(3)
    print(mark + text)


if __name__ == "__main__":
    main()
