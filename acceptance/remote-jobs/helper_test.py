#!/usr/bin/env python3
"""The remote job helper (core/src/jobs/remote_job.py) run directly, as SSH
would run it, with HOME and the machine's identity in a temporary folder.
Short shell commands only."""
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

HELPER = Path(os.environ.get("REMOTE_JOB_PY") or Path(__file__).resolve().parents[2] / "core/src/jobs/remote_job.py")
_spec = importlib.util.spec_from_file_location("remote_job", HELPER)
remote_job = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(remote_job)

MACHINE = "0123456789abcdef0123456789abcdef"
# What one reply frame may take: Core reads 256 KiB of a call, 32 KiB are left for login scripts.
FRAME = 224 * 1024
OTHER = "fedcba9876543210fedcba9876543210"
# This host's own facts when its systemd user manager can make scopes with
# the memory controller; the tests of limits really in force need it.
_FACTS = remote_job.capabilities()
USER_MANAGER = _FACTS if _FACTS["manager"] and _FACTS["busctl"] and "memory" in _FACTS["delegated"] else None
USER_MANAGER_BUSCTL = shutil.which("busctl") or "busctl"


def host_of(machine_id):
    return hashlib.sha256(b"yuzuno-jobs-host-v1:" + machine_id.encode()).hexdigest()[:32]


def gone(pid, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    return False


def group_gone(group, seconds=5):
    """Like gone(), for every member of a process group."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            os.killpg(group, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    return False


def end_attempts(jobs):
    """Before a test's folder goes: what is left of each attempt's group under
    `jobs` (a data root's jobs folder) is killed, checked as the helper checks
    it, then each attempt's supervisor is waited for. A supervisor holds
    supervisor.lock for its whole life and writes the outcome into that folder
    once its command is gone, so removing the folder before it exits races
    with that write. One still running after 20 s fails the test."""
    for started in jobs.glob("*/*/started.json"):
        try:
            group = json.loads(started.read_text())
        except ValueError:
            continue
        for pid in remote_job.members(group):
            remote_job.send(pid, signal.SIGKILL, group)
    left = [lock.parent for lock in jobs.glob("*/*/supervisor.lock")]
    deadline = time.monotonic() + 20
    while True:
        left = [folder for folder in left if remote_job.supervisor_alive(folder)]
        if not left or time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    if left:
        raise AssertionError("a supervisor is still running for " + ", ".join(map(str, left)))


def kept(tmp, error):
    """A test folder whose supervisor still runs is kept, not removed under
    it, now or when the object goes; the error says where it is."""
    tmp._finalizer.detach()
    return AssertionError(f"{error}; {tmp.name} is kept")


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home, self.work = root / "home", root / "work"
        self.home.mkdir()
        self.work.mkdir()
        self.machine = root / "machine-id"
        self.machine.write_text(MACHINE + "\n")
        self.boot = root / "boot_id"
        self.boot.write_text(Path("/proc/sys/kernel/random/boot_id").read_text())

    def tearDown(self):
        # Leave no command of a failed test running, nor a supervisor writing
        # into the folder about to be removed: one that is still running keeps it.
        try:
            end_attempts(self.home / ".yuzuno" / "jobs")
        except AssertionError as error:
            raise kept(self.tmp, error) from error
        self.tmp.cleanup()

    def call(self, request, expect=0, nonce=None, env_extra=None):
        # Core names the machine's data root in each request.
        request = dict({"root": "~/.yuzuno"}, **request)
        nonce = nonce or uuid.uuid4().hex
        env = dict(os.environ, HOME=str(self.home), YUZUNO_JOBS_MACHINE_ID_FILE=str(self.machine),
                   YUZUNO_JOBS_BOOT_ID_FILE=str(self.boot), **(env_extra or {}))
        out = subprocess.run([sys.executable, "-c", HELPER.read_text()], input=json.dumps(dict(request, replyNonce=nonce)),
                             capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(out.returncode, expect, out.stderr + out.stdout)
        # The reply is the one line marked with this call's nonce, and nothing else is printed.
        lines = out.stdout.splitlines()
        prefix = f"{remote_job.MARK}{nonce} "
        self.assertEqual(len(lines), 1, out.stdout)
        self.assertTrue(lines[0].startswith(prefix), out.stdout)
        return json.loads(lines[0][len(prefix):])

    def test_the_reply_carries_the_calls_nonce_and_only_a_well_formed_one(self):
        nonce = "0123456789abcdef0123456789abcdef"
        self.assertEqual(self.call({"action": "hello"}, nonce=nonce)["status"], "hello")
        refused = self.call({"action": "nothing"}, expect=3, nonce=nonce)
        self.assertEqual(refused["error"], "Unknown action")
        env = dict(os.environ, HOME=str(self.home), YUZUNO_JOBS_MACHINE_ID_FILE=str(self.machine))
        out = subprocess.run([sys.executable, "-c", HELPER.read_text()],
                             input=json.dumps({"action": "hello", "replyNonce": "not-a-nonce\nYUZUNO"}),
                             capture_output=True, text=True, env=env, timeout=60)
        # A malformed nonce is never echoed: the line carries no nonce Core would accept.
        self.assertTrue(out.stdout.startswith(remote_job.MARK + "{"), out.stdout)

    def attempt(self, script, timeout=60, workspace="ws-1", limits=None):
        spec = {"argv": ["/bin/sh", "-c", script], "cwd": str(self.work), "env": {"PATH": "/usr/bin:/bin"},
                "timeoutSeconds": timeout}
        if limits is not None:
            spec["limits"] = limits
        return dict(spec, jobId=str(uuid.uuid4()), attempt=str(uuid.uuid4()), workspaceKey=workspace,
                    machineId="m1", digest=remote_job.digest(spec), expectHost=host_of(MACHINE))

    def bound(self, attempt, action, **extra):
        keys = ("jobId", "attempt", "workspaceKey", "machineId", "digest", "expectHost")
        return dict({key: attempt[key] for key in keys}, action=action, **extra)

    def start(self, attempt):
        return self.call(dict(attempt, action="start"))

    def folder(self, attempt):
        return self.home / ".yuzuno" / "jobs" / attempt["jobId"] / attempt["attempt"]

    def settle(self, attempt, seconds=20):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            state = self.call(self.bound(attempt, "status"))
            if state["status"] == "terminal":
                return state
            time.sleep(0.1)
        self.fail("no outcome: " + json.dumps(state))

    def wait_for(self, path, seconds=5):
        deadline = time.monotonic() + seconds
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        return int(path.read_text())

    def test_hello_names_this_machine_and_boot_without_the_raw_machine_id(self):
        reply = self.call({"action": "hello"})
        self.assertEqual((reply["status"], reply["platform"]), ("hello", "Linux"))
        self.assertEqual(reply["hostId"], host_of(MACHINE))
        self.assertEqual(reply["bootId"], self.boot.read_text().strip())
        # The absolute root a start would go to; hello creates nothing.
        self.assertEqual(reply["root"], str(self.home / ".yuzuno"))
        self.assertFalse((self.home / ".yuzuno").exists())
        self.assertNotIn(MACHINE, json.dumps(reply))
        self.machine.write_text("")
        self.assertIn("no machine-id", self.call({"action": "hello"}, expect=3)["error"])

    def test_a_command_runs_once_in_its_own_group_and_its_output_and_outcome_are_kept(self):
        job = self.attempt("echo begin; echo once >> runs.txt; sleep 1; echo end")
        reply = self.start(job)
        self.assertFalse(reply["duplicate"])
        started = reply["started"]
        self.assertEqual((started["pgid"], started["sid"]), (started["pid"], started["pid"]))
        self.assertEqual(os.getpgid(started["pid"]), started["pid"])
        self.assertEqual(started["bootId"], self.boot.read_text().strip())
        stat = Path(f"/proc/{started['pid']}/stat").read_text()
        self.assertEqual(int(stat[stat.rindex(")") + 2:].split()[19]), started["starttime"])
        self.assertEqual(self.call(self.bound(job, "status"))["status"], "running")
        intent = json.loads((self.folder(job) / "intent.json").read_text())
        self.assertEqual((intent["workspaceKey"], intent["machineId"], intent["digest"], intent["hostId"]),
                         ("ws-1", "m1", job["digest"], host_of(MACHINE)))
        # A repeated start (a lost reply, retried) finds the same attempt.
        again = self.start(job)
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["started"]["pid"], started["pid"])
        state = self.settle(job)
        self.assertEqual((state["result"]["status"], state["result"]["exitCode"]), ("succeeded", 0))
        self.assertEqual((self.work / "runs.txt").read_text(), "once\n")
        log = self.call(self.bound(job, "logs"))
        self.assertEqual(log["text"], "begin\nend\n")
        self.assertEqual((log["offset"], log["totalBytes"]), (0, 10))

    def test_a_failure_and_a_timeout_are_outcomes_not_successes(self):
        job = self.attempt("echo DONE; exit 3")
        self.start(job)
        self.assertEqual(self.settle(job)["result"]["status"], "failed")
        self.assertEqual(self.call(self.bound(job, "status"))["result"]["exitCode"], 3)
        slow = self.attempt("sleep 30", timeout=1)
        self.start(slow)
        result = self.settle(slow)["result"]
        self.assertEqual(result["status"], "failed")
        self.assertIn("timeout after 1 s", result["reason"])
        missing = self.attempt("x")
        missing["argv"] = ["/nonexistent/program"]
        missing["digest"] = remote_job.digest(missing)
        self.start(missing)
        result = self.settle(missing)["result"]
        self.assertEqual(result["status"], "rejected")
        self.assertIn("No such file", result["reason"])

    def test_cancel_stops_the_whole_process_tree_and_only_it(self):
        bystander = subprocess.Popen(["sleep", "60"])
        try:
            job = self.attempt("sleep 60 & echo $! > child.pid; sleep 60")
            self.start(job)
            grandchild = self.wait_for(self.work / "child.pid")
            reply = self.call(self.bound(job, "cancel"))
            if reply["status"] != "terminal":
                reply = self.settle(job)
            self.assertEqual(reply["result"]["status"], "cancelled")
            self.assertTrue(gone(grandchild))
            self.assertIsNone(bystander.poll(), "an unrelated sleep is untouched")
        finally:
            bystander.kill()
            bystander.wait()

    def test_a_command_that_exits_leaving_a_child_ends_only_once_the_child_is_stopped(self):
        job = self.attempt("sleep 60 & echo $! > child.pid; exit 0")
        self.start(job)
        child = self.wait_for(self.work / "child.pid")
        state = self.settle(job)
        self.assertEqual(state["result"]["status"], "succeeded")
        self.assertIn("1 process(es) left in its process group were stopped", state["result"]["reason"])
        # The outcome was written after the child was gone, never before.
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    def test_a_supervisor_that_dies_leaves_the_attempt_lost_until_cancel_stops_its_group(self):
        # exec: the attempt is exactly one process whatever /bin/sh is. dash
        # (Ubuntu's sh) forks a lone command and stays as the group's leader;
        # bash replaces itself with it.
        job = self.attempt("exec sleep 60")
        started = self.start(job)["started"]
        os.kill(started["supervisorPid"], signal.SIGKILL)
        self.assertTrue(gone(started["supervisorPid"]))
        for _ in range(3):
            state = self.call(self.bound(job, "status"))
            self.assertEqual((state["status"], state["leaderAlive"], state["processes"]), ("lost", True, 1))
        self.assertFalse((self.folder(job) / "result.json").exists())
        reply = self.call(self.bound(job, "cancel"))
        self.assertEqual((reply["status"], reply["result"]["status"]), ("terminal", "cancelled"))
        self.assertTrue(gone(started["pid"]))
        # The leader started its own session, so its PID is the group's.
        self.assertTrue(group_gone(started["pid"]), "a member of the attempt's group is left")

    def test_after_the_supervisor_dies_a_leader_that_exits_leaving_a_child_is_not_an_outcome(self):
        job = self.attempt("sleep 60 & echo $! > child.pid; while [ ! -e go ]; do sleep 0.05; done")
        started = self.start(job)["started"]
        child = self.wait_for(self.work / "child.pid")
        os.kill(started["supervisorPid"], signal.SIGKILL)
        self.assertTrue(gone(started["supervisorPid"]))
        (self.work / "go").write_text("")
        self.assertTrue(gone(started["pid"]))
        state = self.call(self.bound(job, "status"))
        self.assertEqual((state["status"], state["leaderAlive"], state["processes"]), ("lost", False, 1))
        self.assertFalse((self.folder(job) / "result.json").exists())
        os.kill(child, 0)
        reply = self.call(self.bound(job, "cancel"))
        self.assertEqual((reply["status"], reply["result"]["status"]), ("terminal", "cancelled"))
        self.assertTrue(gone(child))

    def lose(self, job):
        """Start the attempt and kill its supervisor once it has recorded its
        deadline: (started, when that deadline began on this boot's monotonic
        clock). The supervisor records it after started.json, which is all a
        start waits for, so killed at once it may record none."""
        started = self.start(job)["started"]
        path = self.folder(job) / "deadline.json"
        limit = time.monotonic() + 10
        while not path.exists() and time.monotonic() < limit:
            time.sleep(0.02)
        self.assertTrue(path.exists(), "the supervisor recorded no deadline")
        recorded = json.loads(path.read_text())
        os.kill(started["supervisorPid"], signal.SIGKILL)
        self.assertTrue(gone(started["supervisorPid"]))
        return started, recorded["monotonic"] - recorded["timeoutSeconds"]

    def past(self, since, timeout):
        """Sleep past the attempt's deadline: when it began, plus its timeout."""
        time.sleep(max(0.0, since + timeout + 1 - time.monotonic()))

    def test_a_lost_command_still_running_at_its_timeout_is_stopped_at_the_next_status(self):
        job = self.attempt("exec sleep 60", timeout=3)
        started, since = self.lose(job)
        # Before its deadline nothing is stopped: it stays lost.
        state = self.call(self.bound(job, "status"))
        self.assertEqual((state["status"], state["leaderAlive"], state["processes"]), ("lost", True, 1))
        self.past(since, 3)
        state = self.call(self.bound(job, "status"))
        self.assertEqual(state["status"], "terminal", state)
        self.assertEqual(state["result"]["status"], "failed")
        self.assertEqual(state["result"]["reason"],
                         "timeout after 3 s; its supervisor was gone, so its process group was stopped here")
        self.assertTrue(gone(started["pid"]))
        self.assertTrue(group_gone(started["pid"]), "a member of the attempt's group is left")
        # Settled once: a later status, cancel or repeated start finds the same outcome.
        for request in (self.bound(job, "status"), self.bound(job, "cancel"), dict(job, action="start")):
            self.assertEqual(self.call(request)["result"], state["result"])

    def test_a_lost_command_that_has_exited_is_not_given_an_outcome_at_its_timeout(self):
        # Its exit status was not recorded: neither a group left empty nor a
        # child left behind is taken for a timeout.
        for script, left in (("while [ ! -e go ]; do sleep 0.05; done", 0),
                             ("sleep 60 & echo $! > child.pid; while [ ! -e go ]; do sleep 0.05; done", 1)):
            with self.subTest(left=left):
                (self.work / "go").unlink(missing_ok=True)
                job = self.attempt(script, timeout=2)
                started, since = self.lose(job)
                (self.work / "go").write_text("")
                self.assertTrue(gone(started["pid"]))
                self.past(since, 2)
                state = self.call(self.bound(job, "status"))
                self.assertEqual((state["status"], state["leaderAlive"], state["processes"]), ("lost", False, left))
                self.assertFalse((self.folder(job) / "result.json").exists())

    def test_a_deadline_record_that_is_not_this_starts_stops_nothing(self):
        job = self.attempt("exec sleep 60", timeout=600)
        started, _ = self.lose(job)
        path = self.folder(job) / "deadline.json"
        recorded = json.loads(path.read_text())
        self.assertEqual({key: recorded[key] for key in ("bootId", "pid", "starttime", "timeoutSeconds")},
                         {"bootId": started["bootId"], "pid": started["pid"], "starttime": started["starttime"],
                          "timeoutSeconds": 600})
        overdue = dict(recorded, monotonic=time.monotonic() - 1)
        for case, record in (("another boot", dict(overdue, bootId="other")),
                             ("another process", dict(overdue, pid=started["pid"] + 1)),
                             ("another start", dict(overdue, starttime=started["starttime"] + 1)),
                             ("another timeout", dict(overdue, timeoutSeconds=1)),
                             ("no clock reading", dict(overdue, monotonic="soon")),
                             ("unreadable", None), ("missing", None)):
            with self.subTest(case=case):
                if case == "missing":
                    path.unlink()
                else:
                    path.write_text("{" if record is None else json.dumps(record))
                state = self.call(self.bound(job, "status"))
                self.assertEqual((state["status"], state["leaderAlive"]), ("lost", True))
                self.assertFalse((self.folder(job) / "result.json").exists())
        # The same record, overdue: the attempt's own deadline is applied.
        path.write_text(json.dumps(overdue))
        self.assertEqual(self.call(self.bound(job, "status"))["result"]["status"], "failed")
        self.assertTrue(group_gone(started["pid"]))

    def test_a_leader_that_is_not_the_recorded_process_is_not_stopped_at_the_timeout(self):
        job = self.attempt("exec sleep 60", timeout=600)
        started, _ = self.lose(job)
        folder = self.folder(job)
        recorded = json.loads((folder / "deadline.json").read_text())
        # As if its PID now named another process: another start time, or
        # another process group and session.
        try:
            for case, fields in (("another start", {"starttime": started["starttime"] + 1}),
                                 ("another group", {"pgid": started["pid"] + 1, "sid": started["pid"] + 1})):
                with self.subTest(case=case):
                    (folder / "started.json").write_text(json.dumps(dict(started, **fields)))
                    (folder / "deadline.json").write_text(json.dumps(dict(
                        recorded, monotonic=time.monotonic() - 1, starttime=fields.get("starttime", started["starttime"]))))
                    state = self.call(self.bound(job, "status"))
                    self.assertEqual(state["status"], "lost", state)
                    self.assertFalse((folder / "result.json").exists())
                    os.kill(started["pid"], 0)
        finally:
            # tearDown finds the command by its real record.
            (folder / "started.json").write_text(json.dumps(started))

    def stopping(self, job):
        return json.loads((self.folder(job) / "stopping.json").read_text())

    def own_stopping(self, job, started, at):
        return dict({key: started[key] for key in ("bootId", "pid", "pgid", "sid", "starttime")},
                    attempt=job["attempt"], monotonic=at)

    def test_a_lost_command_that_ignores_term_is_killed_by_a_later_status_after_its_timeout(self):
        job = self.attempt("trap '' TERM; exec sleep 60", timeout=2)
        started, since = self.lose(job)
        self.past(since, 2)
        # One call waits 4 s after its TERM: nothing is recorded as stopped.
        before = time.monotonic()
        state = self.call(self.bound(job, "status"))
        self.assertEqual((state.get("status"), state.get("leaderAlive")), ("lost", True), state)
        self.assertFalse((self.folder(job) / "result.json").exists())
        os.kill(started["pid"], 0)
        first = self.stopping(job)
        self.assertEqual(first, self.own_stopping(job, started, first["monotonic"]))
        self.assertTrue(before <= first["monotonic"] <= time.monotonic(), first)
        # The next call goes on from that first TERM: KILL 5 s after it.
        state = self.call(self.bound(job, "status"))
        self.assertEqual(state.get("status"), "terminal", state)
        self.assertEqual(state["result"]["reason"],
                         "timeout after 2 s; its supervisor was gone, so its process group was stopped here")
        self.assertTrue(group_gone(started["pid"]))
        self.assertEqual(self.stopping(job), first, "the first TERM's time is never moved")

    def test_a_timeout_that_began_goes_on_once_the_leader_ended_and_a_child_ignores_term(self):
        job = self.attempt("(trap '' TERM; exec sleep 60) & echo $! > child.pid; exec sleep 60", timeout=2)
        started, since = self.lose(job)
        child = self.wait_for(self.work / "child.pid")
        self.past(since, 2)
        # The call that applies the timeout: the leader ends on its TERM, the child does not.
        state = self.call(self.bound(job, "status"))
        self.assertEqual((state.get("status"), state.get("leaderAlive"), state.get("processes")), ("lost", False, 1), state)
        self.assertTrue(gone(started["pid"]))
        os.kill(child, 0)
        first = self.stopping(job)
        # The next status goes on with that timeout, without its leader: KILL 5 s after the first TERM.
        state = self.call(self.bound(job, "status"))
        self.assertEqual(state.get("status"), "terminal", state)
        self.assertEqual(state["result"]["reason"],
                         "timeout after 2 s; its supervisor was gone, so its process group was stopped here")
        self.assertTrue(gone(child))
        self.assertEqual(self.stopping(job), first, "the first TERM's time is never moved")

    def test_a_stop_a_cancel_began_is_never_taken_for_a_timeout(self):
        # Whether the leader has ended and a child ignores TERM, or the leader
        # itself ignores it and is still running past its deadline (review R2).
        for case, script in (
                ("leader ended", "trap '' TERM; sleep 60 & echo $! > child.pid; while [ ! -e go ]; do sleep 0.05; done"),
                ("leader runs", "trap '' TERM; exec sleep 60")):
            with self.subTest(case=case):
                (self.work / "child.pid").unlink(missing_ok=True)
                (self.work / "go").unlink(missing_ok=True)
                job = self.attempt(script, timeout=2)
                started, since = self.lose(job)
                if case == "leader ended":
                    left = self.wait_for(self.work / "child.pid")
                    (self.work / "go").write_text("")
                    self.assertTrue(gone(started["pid"]))
                else:
                    left = started["pid"]
                self.past(since, 2)
                self.assertEqual(self.call(self.bound(job, "cancel")).get("status"), "lost")
                # Past the deadline, with the cancel's first TERM recorded: a status leaves the stop to cancel.
                state = self.call(self.bound(job, "status"))
                self.assertEqual((state.get("status"), state.get("processes")), ("lost", 1), state)
                os.kill(left, 0)
                reply = self.call(self.bound(job, "cancel"))
                self.assertEqual((reply.get("status"), reply.get("result", {}).get("status")), ("terminal", "cancelled"),
                                 reply)
                self.assertTrue(gone(left))

    def test_a_cancel_of_a_lost_attempt_kills_a_child_that_ignores_term_at_a_later_call(self):
        job = self.attempt("trap '' TERM; sleep 60 & echo $! > child.pid; while [ ! -e go ]; do sleep 0.05; done")
        started, _ = self.lose(job)
        child = self.wait_for(self.work / "child.pid")
        (self.work / "go").write_text("")
        self.assertTrue(gone(started["pid"]))
        reply = self.call(self.bound(job, "cancel"))
        self.assertEqual((reply.get("status"), reply.get("processes")), ("lost", 1), reply)
        os.kill(child, 0)
        first = self.stopping(job)
        reply = self.call(self.bound(job, "cancel"))
        self.assertEqual((reply.get("status"), reply.get("result", {}).get("status")), ("terminal", "cancelled"), reply)
        self.assertTrue(gone(child))
        self.assertEqual(self.stopping(job), first, "the first TERM's time is never moved")

    def test_a_stopping_record_that_is_not_this_attempts_never_brings_a_kill_forward(self):
        long_ago = time.monotonic() - 100
        for case, change in (("another attempt", {"attempt": "other"}), ("another boot", {"bootId": "other"}),
                             ("another process", {"pid": 1}), ("another start", {"starttime": 1}),
                             ("another group", {"pgid": 1, "sid": 1}), ("a later clock", {"monotonic": long_ago + 10 ** 6}),
                             ("no clock reading", {"monotonic": "soon"}), ("unreadable", None), ("its own", {})):
            with self.subTest(case=case):
                job = self.attempt("trap '' TERM; exec sleep 60", timeout=600)
                started, _ = self.lose(job)
                record = self.own_stopping(job, started, long_ago)
                (self.folder(job) / "stopping.json").write_text("{" if change is None else json.dumps(dict(record, **change)))
                before = time.monotonic()
                reply = self.call(self.bound(job, "cancel"))
                if case == "its own":
                    # This attempt's own record, 100 s old: KILL at once.
                    self.assertEqual(reply.get("result", {}).get("status"), "cancelled", reply)
                    self.assertTrue(gone(started["pid"]))
                    continue
                self.assertEqual(reply.get("status"), "lost", reply)
                os.kill(started["pid"], 0)
                # Replaced by this call's own first TERM.
                now = self.stopping(job)
                self.assertEqual(now, self.own_stopping(job, started, now["monotonic"]))
                self.assertTrue(before <= now["monotonic"] <= time.monotonic(), now)

    def test_a_first_term_whose_time_cannot_be_recorded_is_reported_and_brings_no_outcome(self):
        job = self.attempt("trap '' TERM; exec sleep 60", timeout=2)
        started, since = self.lose(job)
        self.past(since, 2)
        folder = self.folder(job)
        mode = folder.stat().st_mode & 0o777
        folder.chmod(0o500)
        try:
            state = self.call(self.bound(job, "status"))
        finally:
            folder.chmod(mode)
        self.assertEqual((state.get("status"), state.get("leaderAlive")), ("lost", True), state)
        self.assertIn("the time of its first TERM could not be recorded", state.get("stopRecord", ""), state)
        self.assertFalse((folder / "stopping.json").exists())
        self.assertFalse((folder / "result.json").exists())
        os.kill(started["pid"], 0)

    def test_a_thaw_that_failed_is_recorded_with_the_timeout_it_preceded(self):
        # In this process, with the thaw answered by a stand-in for systemd's
        # refusal: no real scope is made or frozen.
        job = self.attempt("exec sleep 60", timeout=600)
        started, _ = self.lose(job)
        folder = self.folder(job)
        intent = json.loads((folder / "intent.json").read_text())
        refused = {"wasFrozen": True, "thawReturnCode": 1, "thawError": "Failed to thaw unit",
                   "freezer": {"populated": True, "frozen": True}}
        saved = remote_job.thaw_for_stop
        remote_job.thaw_for_stop = lambda root, of: refused
        try:
            reply = remote_job.time_out(folder, intent, remote_job.state(folder, intent))
        finally:
            remote_job.thaw_for_stop = saved
        self.assertEqual(reply.get("status"), "terminal", reply)
        self.assertEqual((reply["result"]["status"], reply["result"]["thawedToStop"]), ("failed", refused))
        self.assertTrue(group_gone(started["pid"]))

    def test_after_a_restart_a_lost_attempt_is_interrupted_not_timed_out(self):
        job = self.attempt("exec sleep 60", timeout=2)
        _, since = self.lose(job)
        self.past(since, 2)
        self.boot.write_text(str(uuid.uuid4()) + "\n")
        result = self.call(self.bound(job, "status"))["result"]
        self.assertEqual((result["status"], result["reason"]),
                         ("interrupted", "The machine restarted; this attempt's processes ended with that boot"))

    def test_a_start_key_is_bound_to_its_request_workspace_and_machine(self):
        job = self.attempt("sleep 1")
        first = self.start(job)
        other = self.attempt("echo different")
        reused = dict(other, jobId=job["jobId"], attempt=job["attempt"])
        reply = self.start(reused)
        self.assertEqual((reply["status"], reply["reason"]), ("conflict", "its digest differs"))
        elsewhere = dict(job, workspaceKey="ws-2")
        self.assertEqual(self.start(elsewhere)["status"], "conflict")
        self.assertEqual(self.call(self.bound(elsewhere, "status"))["status"], "conflict")
        self.assertEqual(self.call(self.bound(elsewhere, "cancel"))["status"], "conflict")
        forged = dict(job, argv=["/bin/sh", "-c", "echo forged"])
        refused = self.call(dict(forged, action="start"), expect=3)
        self.assertIn("digest does not match", refused["error"])
        self.assertEqual(self.settle(job)["started"]["pid"], first["started"]["pid"])
        self.assertFalse((self.work / "forged").exists())

    def test_another_machine_behind_the_same_name_never_answers_for_the_attempt(self):
        job = self.attempt("sleep 60")
        self.start(job)
        self.machine.write_text(OTHER + "\n")
        for action in ("status", "cancel", "logs"):
            reply = self.call(self.bound(job, action))
            self.assertEqual((reply["status"], reply["hostId"]), ("other_host", host_of(OTHER)))
        fresh = self.attempt("echo never")
        self.assertEqual(self.start(fresh)["status"], "other_host")
        self.assertFalse(self.folder(fresh).exists(), "nothing written on the other machine")
        self.machine.write_text(MACHINE + "\n")
        self.assertEqual(self.call(self.bound(job, "status"))["status"], "running")

    def test_a_fence_makes_a_start_that_never_arrived_final(self):
        job = self.attempt("echo late >> late.txt")
        self.assertEqual(self.call(self.bound(job, "status"))["status"], "absent")
        self.assertEqual(self.call(self.bound(job, "status", fence=True))["status"], "fenced")
        late = self.call(dict(job, action="start"), expect=3)
        self.assertIn("gave up on this start", late["error"])
        self.assertFalse((self.work / "late.txt").exists())
        cancelled = self.attempt("echo late >> late.txt")
        self.assertEqual(self.call(self.bound(cancelled, "cancel", fence=True))["status"], "fenced")
        self.call(dict(cancelled, action="start"), expect=3)
        # A fence never touches an attempt that exists.
        running = self.attempt("sleep 1")
        self.start(running)
        self.assertEqual(self.call(self.bound(running, "status", fence=True))["status"], "running")

    def test_a_record_lost_after_it_was_acknowledged_is_absent_never_fenced(self):
        job = self.attempt("sleep 60")
        started = self.start(job)["started"]
        os.kill(started["supervisorPid"], signal.SIGKILL)
        self.assertTrue(gone(started["supervisorPid"]))
        try:
            os.killpg(started["pgid"], signal.SIGKILL)
        except ProcessLookupError:
            # Killed before it sent the go byte, the supervisor leaves its
            # command nothing to wait for: it exits on its own, never runs.
            pass
        self.assertTrue(gone(started["pid"]))
        for path in sorted(self.folder(job).iterdir()):
            path.unlink()
        self.folder(job).rmdir()
        # Without a fence (Core sends none once acknowledged) a cancel finds
        # nothing to settle: absent, and nothing is written.
        self.assertEqual(self.call(self.bound(job, "cancel"))["status"], "absent")
        self.assertEqual(self.call(self.bound(job, "status"))["status"], "absent")
        self.assertFalse(self.folder(job).exists())

    def test_later_arguments_may_be_empty_as_core_allows(self):
        job = self.attempt("x")
        job["argv"] = ["/bin/sh", "-c", 'printf "[%s]" "$1"', "sh", ""]
        job["digest"] = remote_job.digest(job)
        self.start(job)
        self.assertEqual(self.settle(job)["result"]["status"], "succeeded")
        self.assertEqual(self.call(self.bound(job, "logs"))["text"], "[]")
        unnamed = self.attempt("x")
        unnamed["argv"] = ["", "x"]
        unnamed["digest"] = remote_job.digest(unnamed)
        self.assertIn("first names the program", self.call(dict(unnamed, action="start"), expect=3)["error"])

    def test_a_restarted_machine_interrupts_the_attempt(self):
        job = self.attempt("sleep 60")
        started = self.start(job)["started"]
        self.boot.write_text(str(uuid.uuid4()) + "\n")
        state = self.call(self.bound(job, "status"))
        self.assertEqual((state["status"], state["result"]["status"]), ("terminal", "interrupted"))
        # Simulated: the command still runs on this real boot; tearDown stops it.
        self.assertTrue(remote_job.alive(started))

    def test_an_unreadable_record_is_unclear(self):
        job = self.attempt("sleep 1")
        self.start(job)
        (self.folder(job) / "intent.json").write_text("{")
        self.assertEqual(self.call(self.bound(job, "status"))["status"], "unclear")
        self.assertEqual(self.call(self.bound(job, "cancel"))["status"], "unclear")

    def test_refusals_start_nothing(self):
        job = self.attempt("echo never")
        job["cwd"] = str(self.work / "missing")
        job["digest"] = remote_job.digest(job)
        refused = self.call(dict(job, action="start"), expect=3)
        self.assertIn("does not exist on this machine", refused["error"])
        self.assertEqual(self.call(self.bound(job, "status"))["status"], "absent")
        bad = self.call({"action": "status", "jobId": "../x", "attempt": "y", "workspaceKey": "w", "machineId": "m",
                         "digest": "0" * 64, "expectHost": host_of(MACHINE)}, expect=3)
        self.assertIn("UUIDs", bad["error"])
        unbound = self.call({"action": "status", "jobId": job["jobId"], "attempt": job["attempt"]}, expect=3)
        self.assertIn("expectHost are required", unbound["error"])
        jobs = self.home / ".yuzuno" / "jobs"
        self.assertFalse(jobs.exists() and any(jobs.glob("*/*/intent.json")))

    # Resources (T-108): what the account can enforce, strict and limited.

    def facts(self, **values):
        path = Path(self.tmp.name) / "capabilities.json"
        path.write_text(json.dumps(dict({"manager": False, "busctl": False, "delegated": [], "linger": False}, **values)))
        return {"YUZUNO_JOBS_CAPABILITIES_FILE": str(path)}

    LIMITS = {"mode": "strict", "cpuMillis": 500, "memoryMiB": 64, "swapMiB": 0}

    def lingering(self, **env):
        """This host's own facts, as if the account lingered: limited holds
        limits in a scope only then, and these tests are about that scope."""
        return dict(self.facts(**dict(USER_MANAGER, linger=True)), **env)

    def test_hello_says_what_this_account_can_enforce(self):
        env = self.facts(manager=True, busctl=True, delegated=["memory", "pids"])
        self.assertEqual(self.call({"action": "hello"}, env_extra=env)["resources"],
                         {"manager": True, "busctl": True, "delegated": ["memory", "pids"], "linger": False})
        found = self.call({"action": "hello"})["resources"]
        self.assertEqual(sorted(found), ["busctl", "delegated", "linger", "manager", "swap"])

    def test_a_kernel_without_swap_accounting_holds_memory_and_declares_swap(self):
        facts = {"manager": True, "busctl": True, "delegated": ["cpu", "memory"], "linger": True, "swap": False}
        plan = remote_job.limit_plan(dict(self.LIMITS, mode="limited"), facts)
        self.assertEqual((plan["memory"], plan["swap"], plan["cpu"]), ("limited", "declared", "limited"))
        self.assertEqual(plan["caveats"], ["swap is declared only, not limited: this kernel does not account "
                                           "swap for cgroups (no memory.swap.max)"])
        with self.assertRaises(remote_job.Refused) as refused:
            remote_job.limit_plan(self.LIMITS, facts)
        self.assertIn("swap cannot be limited here: this kernel does not account swap", str(refused.exception))
        # With swap accounted (or a facts file from before it was reported) swap is held with memory.
        self.assertEqual(remote_job.limit_plan(self.LIMITS, dict(facts, swap=True))["swap"], "limited")
        del facts["swap"]
        self.assertEqual(remote_job.limit_plan(self.LIMITS, facts)["swap"], "limited")

    def test_the_digest_binds_the_limits_and_keeps_v1_without_them(self):
        spec = {"argv": ["true"], "cwd": "/", "env": {}, "timeoutSeconds": 5}
        v1 = remote_job.digest(spec)
        # The value main 6f29d20d's helper (and Core) computed: attempts
        # recorded before limits keep matching.
        self.assertEqual(v1, "97e21ef01001cc6f6bc38ede77727d86c87bde08287b9dc863233c78d0e91cdd")
        with_limits = remote_job.digest(dict(spec, limits=self.LIMITS))
        self.assertNotEqual(v1, with_limits)
        self.assertNotEqual(with_limits, remote_job.digest(dict(spec, limits=dict(self.LIMITS, mode="limited"))))
        attempt = self.attempt("touch ran", limits=self.LIMITS)
        attempt["limits"] = dict(self.LIMITS, memoryMiB=4096)
        self.assertIn("digest does not match", self.call(dict(attempt, action="start"), expect=3)["error"])
        self.assertFalse((self.work / "ran").exists())

    def test_strict_starts_nothing_on_a_machine_that_cannot_hold_its_limits(self):
        env = self.facts(manager=True, busctl=True, delegated=["memory", "pids"], linger=False)
        attempt = self.attempt("touch ran", limits=self.LIMITS)
        error = self.call(dict(attempt, action="start"), expect=3, env_extra=env)["error"]
        self.assertIn("nothing was started", error)
        self.assertIn("CPU cannot be limited here: the cpu controller is not delegated", error)
        self.assertIn("linger is off", error)
        self.assertNotIn("memory cannot", error)
        self.assertFalse((self.folder(attempt) / "intent.json").exists())
        self.assertFalse((self.work / "ran").exists())
        # A machine with no reachable user manager names that instead.
        attempt = self.attempt("touch ran", limits=self.LIMITS)
        error = self.call(dict(attempt, action="start"), expect=3, env_extra=self.facts())["error"]
        self.assertIn("memory cannot be limited here: this account's systemd user manager does not answer", error)

    def test_limited_runs_with_what_it_can_hold_and_says_what_is_only_declared(self):
        limits = dict(self.LIMITS, mode="limited")
        attempt = self.attempt("echo ran", limits=limits)
        # Any state the start answers with is fine (an echo may already be
        # stopping or terminal); the outcome below is what this test checks.
        self.call(dict(attempt, action="start"), env_extra=self.facts())
        state = self.settle(attempt)
        result = state["result"]
        self.assertEqual(result["status"], "succeeded")
        used = result["limits"]
        self.assertEqual((used["memory"], used["cpu"], used["held"]), ("declared", "declared", None))
        self.assertEqual(len(used["caveats"]), 2)
        self.assertTrue(all("declared only" in c for c in used["caveats"]), used["caveats"])
        self.assertEqual(state["started"]["limits"]["mode"], "limited")
        self.assertFalse((self.folder(attempt) / "limits.json").exists())

    def test_a_scope_that_cannot_be_made_means_the_command_never_ran(self):
        env = self.facts(manager=True, busctl=True, delegated=["memory", "pids"], linger=True)
        env["YUZUNO_JOBS_BUSCTL"] = "/bin/false"
        attempt = self.attempt("touch ran", limits=dict(self.LIMITS, mode="limited"))
        self.call(dict(attempt, action="start"), env_extra=env)
        result = self.settle(attempt)["result"]
        self.assertEqual(result["status"], "rejected")
        self.assertIn("Not started on this machine: this account's systemd refused its scope", result["reason"])
        self.assertFalse((self.work / "ran").exists())
        self.assertFalse((self.folder(attempt) / "started.json").exists())

    # The limits really in force, in this host's own systemd user manager (the
    # mode is limited, so whether it lingers only shows in the plan).

    @unittest.skipUnless(USER_MANAGER, "no systemd user manager with the memory controller here")
    def test_the_memory_limit_is_read_back_and_an_overrun_is_reported_as_out_of_memory(self):
        load = Path(__file__).resolve().parent / "load.py"
        limits = {"mode": "limited", "cpuMillis": 500, "memoryMiB": 64, "swapMiB": 0}
        attempt = self.attempt("exec /usr/bin/python3 %s memory --step-mib 16 --max-mib 256" % load, limits=limits)
        self.call(dict(attempt, action="start"), env_extra=self.lingering())
        result = self.settle(attempt, seconds=60)["result"]
        used = result["limits"]
        self.assertEqual(used["memory"], "limited")
        self.assertEqual((used["held"]["memory.max"], used["held"]["memory.swap.max"]), (str(64 << 20), "0"))
        self.assertTrue(used["held"]["unit"].startswith("yuzuno-remote-job-"), used["held"])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["signal"], 9)
        self.assertGreaterEqual(used.get("oomKills", 0), 1, used)
        self.assertIn("out of memory: its limit is 64 MiB", result["reason"])
        if "cpu" in USER_MANAGER["delegated"]:
            self.assertEqual(used["cpu"], "limited")
            self.assertEqual(used["held"]["cpu.max"], "50000 100000")

    @unittest.skipUnless(USER_MANAGER, "no systemd user manager with the memory controller here")
    def test_limited_on_an_account_that_does_not_linger_holds_nothing_and_runs_outside_any_scope(self):
        # This host's facts with linger off: a scope would belong to a user
        # manager that may stop when the last session ends, so none is made.
        env = self.facts(**dict(USER_MANAGER, linger=False))
        limits = {"mode": "limited", "cpuMillis": 500, "memoryMiB": 64, "swapMiB": 0}
        attempt = self.attempt("cat /proc/self/cgroup > cgroup.txt", limits=limits)
        self.call(dict(attempt, action="start"), env_extra=env)
        result = self.settle(attempt)["result"]
        self.assertEqual(result["status"], "succeeded", result)
        used = result["limits"]
        self.assertEqual((used["memory"], used["cpu"], used["swap"], used["held"]), ("declared", "declared", "declared", None))
        self.assertIn("this account does not linger", " ".join(used["caveats"]))
        self.assertFalse((self.folder(attempt) / "limits.json").exists())
        self.assertNotIn("yuzuno-remote-job-", (self.work / "cgroup.txt").read_text())
        # strict still refuses there.
        attempt = self.attempt("touch ran", limits=dict(limits, mode="strict"))
        error = self.call(dict(attempt, action="start"), expect=3, env_extra=env)["error"]
        self.assertIn("linger is off", error)
        self.assertFalse((self.work / "ran").exists())

    @unittest.skipUnless(USER_MANAGER, "no systemd user manager with the memory controller here")
    def test_without_swap_accounting_the_scope_holds_memory_and_the_command_runs(self):
        # As this host's facts, but as a kernel without swap accounting reports them.
        env = self.facts(**dict(USER_MANAGER, swap=False, linger=True))
        limits = {"mode": "limited", "cpuMillis": 500, "memoryMiB": 64, "swapMiB": 0}
        attempt = self.attempt("echo ran", limits=limits)
        self.call(dict(attempt, action="start"), env_extra=env)
        result = self.settle(attempt, seconds=60)["result"]
        self.assertEqual(result["status"], "succeeded", result)
        used = result["limits"]
        self.assertEqual((used["memory"], used["swap"]), ("limited", "declared"))
        self.assertEqual(used["held"]["memory.max"], str(64 << 20))
        self.assertIn("swap is declared only", " ".join(used["caveats"]))

    @unittest.skipUnless(USER_MANAGER, "no systemd user manager with the memory controller here")
    def test_a_systemd_without_oom_policy_for_scopes_still_holds_the_limits(self):
        # As systemd 249 (Ubuntu 22.04) answers: no OOMPolicy property on a
        # scope. The scope is asked for again without it.
        fake = Path(self.tmp.name) / "busctl"
        fake.write_text("#!/bin/sh\ncase \"$*\" in *OOMPolicy*) echo 'Call failed: Cannot set property OOMPolicy, "
                        "or unknown property.' >&2; exit 1;; esac\nexec %s \"$@\"\n" % USER_MANAGER_BUSCTL)
        fake.chmod(0o755)
        load = Path(__file__).resolve().parent / "load.py"
        limits = {"mode": "limited", "cpuMillis": 500, "memoryMiB": 64, "swapMiB": 0}
        attempt = self.attempt("exec /usr/bin/python3 %s memory --step-mib 16 --max-mib 256" % load, limits=limits)
        self.call(dict(attempt, action="start"), env_extra=self.lingering(YUZUNO_JOBS_BUSCTL=str(fake)))
        result = self.settle(attempt, seconds=60)["result"]
        held = result["limits"]["held"]
        self.assertEqual((held["oomPolicy"], held["memory.max"]), (None, str(64 << 20)), result)
        self.assertEqual((result["status"], result["signal"]), ("failed", 9), result)

    @unittest.skipUnless(USER_MANAGER, "no systemd user manager with the memory controller here")
    def test_any_other_refusal_naming_oom_policy_is_not_retried_and_nothing_runs(self):
        fake = Path(self.tmp.name) / "busctl"
        fake.write_text("#!/bin/sh\ncase \"$*\" in *OOMPolicy*) echo 'Call failed: Access denied (OOMPolicy)' >&2; exit 1;; esac\n"
                        "touch %s\nexec %s \"$@\"\n" % (Path(self.tmp.name) / "retried", USER_MANAGER_BUSCTL))
        fake.chmod(0o755)
        limits = {"mode": "limited", "cpuMillis": 500, "memoryMiB": 64, "swapMiB": 0}
        attempt = self.attempt("touch ran", limits=limits)
        self.call(dict(attempt, action="start"), env_extra=self.lingering(YUZUNO_JOBS_BUSCTL=str(fake)))
        result = self.settle(attempt)["result"]
        self.assertEqual(result["status"], "rejected", result)
        self.assertIn("refused its scope: Call failed: Access denied (OOMPolicy)", result["reason"])
        self.assertFalse((Path(self.tmp.name) / "retried").exists(), "asked again")
        self.assertFalse((self.work / "ran").exists())

    @unittest.skipUnless(USER_MANAGER, "no systemd user manager with the memory controller here")
    def test_within_its_limit_the_command_succeeds_with_its_peak_recorded(self):
        load = Path(__file__).resolve().parent / "load.py"
        limits = {"mode": "limited", "cpuMillis": 500, "memoryMiB": 256, "swapMiB": 0}
        attempt = self.attempt("exec /usr/bin/python3 %s memory --step-mib 16 --max-mib 64 --hold-seconds 2" % load,
                               limits=limits)
        self.call(dict(attempt, action="start"), env_extra=self.lingering())
        result = self.settle(attempt, seconds=60)["result"]
        self.assertEqual(result["status"], "succeeded", result)
        self.assertGreater(result["limits"].get("peakBytes", 0), 64 << 20)
        self.assertEqual(result["limits"].get("oomKills", 0), 0)


class InputsAndArtifactsTests(unittest.TestCase):
    """Inputs and artifacts are files on the machine: frozen by inspect, checked
    again before the command may run, artifacts checked after a clean exit.
    The data root is named by its absolute path; HOME is left as it is."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.data, self.work, self.elsewhere = base / "data", base / "work", base / "elsewhere"
        self.work.mkdir()
        self.elsewhere.mkdir()
        machine = base / "machine-id"
        machine.write_text(MACHINE + "\n")
        boot = base / "boot_id"
        boot.write_text(Path("/proc/sys/kernel/random/boot_id").read_text())
        self.env = dict(os.environ, YUZUNO_JOBS_MACHINE_ID_FILE=str(machine), YUZUNO_JOBS_BOOT_ID_FILE=str(boot))

    def tearDown(self):
        try:
            end_attempts(self.data / "jobs")
        except AssertionError as error:
            raise kept(self.tmp, error) from error
        self.tmp.cleanup()

    def call(self, request, expect=0):
        nonce = uuid.uuid4().hex
        out = subprocess.run([sys.executable, "-c", HELPER.read_text()],
                             input=json.dumps(dict({"root": str(self.data)}, **request, replyNonce=nonce)),
                             capture_output=True, text=True, env=self.env, timeout=60)
        self.assertEqual(out.returncode, expect, out.stderr + out.stdout)
        line = out.stdout.splitlines()[-1]
        return json.loads(line[len(f"{remote_job.MARK}{nonce} "):])

    def inspect(self, *paths):
        return self.call({"action": "inspect", "cwd": str(self.work), "inputs": list(paths)})

    def attempt(self, script, inputs=None, artifacts=None):
        spec = {"argv": ["/bin/sh", "-c", script], "cwd": str(self.work), "env": {"PATH": "/usr/bin:/bin"},
                "timeoutSeconds": 30}
        if inputs is not None:
            spec["inputs"] = [{k: f[k] for k in ("path", "absolutePath", "sha256")} for f in inputs]
        if artifacts is not None:
            spec["artifacts"] = [dict({"format": "bytes", "minBytes": 1}, **a) for a in artifacts]
        return dict(spec, jobId=str(uuid.uuid4()), attempt=str(uuid.uuid4()), workspaceKey="ws-1", machineId="m1",
                    digest=remote_job.digest(spec), expectHost=host_of(MACHINE))

    def run_to_end(self, attempt):
        self.call(dict(attempt, action="start"))
        bound = {k: attempt[k] for k in ("jobId", "attempt", "workspaceKey", "machineId", "digest", "expectHost")}
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            state = self.call(dict(bound, action="status"))
            if state["status"] == "terminal":
                return state["result"]
            time.sleep(0.1)
        self.fail("no outcome")

    def folder(self, attempt):
        return self.data / "jobs" / attempt["jobId"] / attempt["attempt"]

    def test_inspect_reads_inputs_where_their_paths_lead_on_this_machine_and_writes_nothing(self):
        (self.work / "in.txt").write_text("relative input\n")
        (self.elsewhere / "abs.txt").write_text("absolute input\n")
        (self.work / "big.bin").write_bytes(b"x" * (2 * 1024 * 1024 + 1))
        (self.work / "folder").mkdir()
        (self.work / "link.txt").symlink_to(self.elsewhere / "abs.txt")
        reply = self.inspect("in.txt", str(self.elsewhere / "abs.txt"), "missing.txt", "folder", "big.bin", "link.txt")
        files = {f["path"]: f for f in reply["files"]}
        self.assertEqual(reply["status"], "inspected")
        self.assertEqual(files["in.txt"]["absolutePath"], str((self.work / "in.txt").resolve()))
        self.assertEqual(files["in.txt"]["sha256"], hashlib.sha256(b"relative input\n").hexdigest())
        self.assertEqual(files["in.txt"]["bytes"], 15)
        self.assertEqual(files[str(self.elsewhere / "abs.txt")]["sha256"], hashlib.sha256(b"absolute input\n").hexdigest())
        # A link is followed: the file it leads to is what is frozen.
        self.assertEqual(files["link.txt"]["absolutePath"], str((self.elsewhere / "abs.txt").resolve()))
        self.assertEqual(files["missing.txt"]["problem"], "missing")
        self.assertEqual(files["folder"]["problem"], "not a regular file")
        self.assertEqual(files["big.bin"]["problem"], "2097153 bytes: an input is a small file (at most 2 MiB)")
        self.assertNotIn("sha256", files["missing.txt"])
        self.assertFalse(self.data.exists())

    def test_inspect_names_inputs_over_16_MiB_together(self):
        for index in range(9):
            (self.work / f"part{index}.bin").write_bytes(b"y" * (2 * 1024 * 1024))
        reply = self.inspect(*[f"part{index}.bin" for index in range(9)])
        self.assertEqual(reply["problem"], "18874368 bytes in all: inputs are small files (at most 16 MiB together)")

    def test_an_input_changed_while_queued_stops_the_start_before_the_command_runs(self):
        (self.work / "in.txt").write_text("v1\n")
        (self.elsewhere / "a.txt").write_text("a\n")
        (self.elsewhere / "b.txt").write_text("b\n")
        (self.work / "pointer").symlink_to(self.elsewhere / "a.txt")
        (self.work / "gone.txt").write_text("soon gone\n")
        frozen = self.inspect("in.txt", "pointer", "gone.txt")["files"]
        attempt = self.attempt("touch ran", inputs=frozen)
        (self.work / "in.txt").write_text("v2\n")
        (self.work / "pointer").unlink()
        (self.work / "pointer").symlink_to(self.elsewhere / "b.txt")
        (self.work / "gone.txt").unlink()
        result = self.run_to_end(attempt)
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "Inputs changed on this machine while queued (in.txt (its content changed), "
                         f"pointer (now {(self.elsewhere / 'b.txt').resolve()}), gone.txt (missing)); command was not started")
        self.assertFalse((self.work / "ran").exists())
        self.assertFalse((self.folder(attempt) / "started.json").exists())

    def test_unchanged_inputs_start_the_command(self):
        (self.work / "in.txt").write_text("same\n")
        attempt = self.attempt("cat in.txt > copy.txt", inputs=self.inspect("in.txt")["files"])
        result = self.run_to_end(attempt)
        self.assertEqual((result["status"], result["reason"]), ("succeeded", "success"))
        self.assertEqual((self.work / "copy.txt").read_text(), "same\n")

    def test_artifacts_are_checked_after_a_clean_exit_and_recorded_with_the_attempt(self):
        script = "printf '{\"a\": 1}' > out.json; printf '{\"n\":1}\\n{\"n\":2}\\n' > out.jsonl; printf data > out.bin"
        attempt = self.attempt(script, artifacts=[{"path": "out.json", "format": "json"},
                                                  {"path": "out.jsonl", "format": "jsonl"}, {"path": "out.bin"}])
        result = self.run_to_end(attempt)
        self.assertEqual((result["status"], result["reason"]), ("succeeded", "success"))
        checked = {a["path"]: a for a in result["artifacts"]}
        self.assertTrue(all(a["ok"] for a in checked.values()), checked)
        self.assertEqual(checked["out.json"]["sha256"], hashlib.sha256(b'{"a": 1}').hexdigest())
        self.assertEqual(checked["out.jsonl"]["lines"], 2)
        self.assertEqual(checked["out.bin"]["absolutePath"], str((self.work / "out.bin").resolve()))
        record = json.loads((self.folder(attempt) / "artifacts.json").read_text())
        self.assertEqual((record["attempt"], record["artifacts"]), (attempt["attempt"], result["artifacts"]))

    def test_a_missing_or_malformed_artifact_fails_the_job_with_its_own_reason(self):
        attempt = self.attempt("printf '{\"a\":' > bad.json; printf '{\"n\":1}' > cut.jsonl",
                               artifacts=[{"path": "bad.json", "format": "json"}, {"path": "cut.jsonl", "format": "jsonl"},
                                          {"path": "none.txt"}])
        result = self.run_to_end(attempt)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["exitCode"], 0)
        self.assertTrue(result["reason"].startswith("Exit 0, but declared artifacts failed verification: bad.json: "
                                                    "not complete JSON: "), result["reason"])
        self.assertIn("cut.jsonl: the last line is not terminated: the file may be partly written", result["reason"])
        self.assertIn("none.txt: missing", result["reason"])

    def test_an_artifact_is_checked_as_it_is_at_exit_and_what_its_path_held_before_is_recorded(self):
        # As for local jobs: the file at exit is checked, whoever wrote it. A
        # file left there earlier is a legitimate (cached) output too, so it
        # is not refused; the record says it was there and is unchanged.
        (self.work / "out.txt").write_text("from before\n")
        untouched = self.run_to_end(self.attempt("true", artifacts=[{"path": "out.txt"}]))
        self.assertEqual((untouched["status"], untouched["reason"]), ("succeeded", "success"))
        self.assertEqual((untouched["artifacts"][0]["preExisting"], untouched["artifacts"][0]["unchangedSinceStart"]), (True, True))
        rewritten = self.run_to_end(self.attempt("sleep 0.01; printf 'from before\\n' > out.txt", artifacts=[{"path": "out.txt"}]))
        self.assertEqual((rewritten["status"], rewritten["reason"]), ("succeeded", "success"))
        self.assertEqual((rewritten["artifacts"][0]["preExisting"], rewritten["artifacts"][0]["unchangedSinceStart"]), (True, False))
        fresh = self.run_to_end(self.attempt("printf new > new.txt", artifacts=[{"path": "new.txt"}]))
        self.assertEqual(fresh["artifacts"][0]["preExisting"], False)
        self.assertNotIn("unchangedSinceStart", fresh["artifacts"][0])
        # The receipt is this attempt's own: another attempt's is never read.
        self.assertNotEqual(json.loads((self.folder(rewritten) / "artifacts.json").read_text())["attempt"],
                            json.loads((self.folder(fresh) / "artifacts.json").read_text())["attempt"])

    def test_artifact_bounds_are_the_local_ones(self):
        # JSON over 16 MiB and a JSON line longer than 16 MiB are never verified.
        big = "printf '[' > big.json; head -c 16777217 /dev/zero | tr '\\0' 1 >> big.json; printf ']' >> big.json; " \
              "head -c 16777217 /dev/zero | tr '\\0' 1 > long.jsonl"
        result = self.run_to_end(self.attempt(big, artifacts=[{"path": "big.json", "format": "json"},
                                                               {"path": "long.jsonl", "format": "jsonl"},
                                                               {"path": "big.json", "minBytes": 0}]))
        self.assertEqual(result["status"], "failed")
        checked = result["artifacts"]
        self.assertEqual(checked[0]["problem"], "larger than 16 MiB, too large to check as JSON")
        self.assertEqual(checked[1]["problem"], "a line longer than 16 MiB")
        self.assertTrue(checked[2]["ok"], checked[2])
        self.assertFalse(checked[0]["ok"] or checked[1]["ok"])
        # A file outside cwd, or not a regular file, is never one either.
        (self.work / "dir").mkdir()
        (self.work / "away").symlink_to(self.elsewhere / "x.txt")
        (self.elsewhere / "x.txt").write_text("x")
        result = self.run_to_end(self.attempt("true", artifacts=[{"path": "dir"}, {"path": "away"}, {"path": "../x"}]))
        self.assertEqual([a["problem"] for a in result["artifacts"]],
                         ["not a regular file", "resolves outside the working directory", "missing"])

    def framed(self, request, expect=0):
        """The reply, and the bytes of the whole stdout a call leaves, as Core counts them."""
        nonce = uuid.uuid4().hex
        out = subprocess.run([sys.executable, "-c", HELPER.read_text()],
                             input=json.dumps(dict({"root": str(self.data)}, **request, replyNonce=nonce)).encode(),
                             capture_output=True, env=self.env, timeout=60)
        self.assertEqual(out.returncode, expect, (out.stderr + out.stdout).decode("utf-8", "replace"))
        line = out.stdout.decode().splitlines()[-1]
        return json.loads(line[len(f"{remote_job.MARK}{nonce} "):]), len(out.stdout)

    def long_paths(self, unit, count, budget=None):
        """`count` distinct relative paths of about `budget` bytes of `unit`, in
        components of at most 255 bytes, each a 1-byte file under the work
        folder; the absolute paths stay within PATH_MAX."""
        budget = budget or 4095 - len(str(self.work)) - 64
        per = 255 // len(unit.encode())
        paths = []
        for i in range(count):
            parts, used, tag = [], 0, "%03d" % i
            while used + 512 < budget:
                parts.append(unit * per)
                used += len(parts[-1].encode()) + 1
            parts.append(tag + unit * min(per - len(tag), max(1, (budget - used - len(tag)) // len(unit.encode()))))
            path = "/".join(parts)
            (self.work / path).parent.mkdir(parents=True, exist_ok=True)
            (self.work / path).write_bytes(b"x")
            paths.append(path)
        return paths

    def projected(self, attempt, reply, paths):
        """A terminal reply too long for Core, as projected: each artifact's
        check with its index and the SHA-256 of its path, its paths left out
        and said so, the full check kept in the attempt's own artifacts.json."""
        result = reply["result"]
        self.assertEqual({k: v for k, v in result["artifactsOmitted"].items() if k != "replyBytes"},
                         {"fields": ["path", "absolutePath"], "count": len(paths), "record": "artifacts.json"})
        self.assertGreater(result["artifactsOmitted"]["replyBytes"], 256 * 1024)
        for i, (entry, path) in enumerate(zip(result["artifacts"], paths)):
            self.assertEqual((entry["index"], entry["ok"], entry["bytes"], entry["sha256"]),
                             (i, True, 1, hashlib.sha256(b"x").hexdigest()), entry)
            self.assertEqual(entry["pathSha256"], hashlib.sha256(path.encode("utf-8", "surrogateescape")).hexdigest())
            self.assertNotIn("path", entry)
            self.assertNotIn("absolutePath", entry)
        kept = json.loads((self.folder(attempt) / "artifacts.json").read_text())
        self.assertEqual([a["path"] for a in kept["artifacts"]], paths)
        self.assertTrue(all(a["ok"] and a["absolutePath"] for a in kept["artifacts"]))
        return result

    def test_a_terminal_reply_too_long_for_core_keeps_each_check_and_says_what_it_left_out(self):
        # The minimal sample of Job 85755f3e: 18 artifacts with paths of about
        # 3.8 KB of CJK characters made a 281,327-byte reply, more than Core reads.
        paths = self.long_paths("中", 18)
        attempt = self.attempt("true", artifacts=[{"path": p} for p in paths])
        self.call(dict(attempt, action="start"))
        bound = {k: attempt[k] for k in ("jobId", "attempt", "workspaceKey", "machineId", "digest", "expectHost")}
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            reply, size = self.framed(dict(bound, action="status"))
            if reply["status"] == "terminal":
                break
            time.sleep(0.1)
        self.assertLessEqual(size, FRAME)
        result = self.projected(attempt, reply, paths)
        self.assertEqual((result["status"], result["exitCode"], result["jobId"], result["attempt"]),
                         ("succeeded", 0, attempt["jobId"], attempt["attempt"]))
        self.assertEqual(reply["hostId"], host_of(MACHINE))
        # A cancel or a repeated start of that attempt answers the same, as briefly
        # (only the size of the reply it would have been differs).
        same = lambda r: dict(r, artifactsOmitted={k: v for k, v in r["artifactsOmitted"].items() if k != "replyBytes"})
        for request in (dict(bound, action="cancel"), dict(attempt, action="start")):
            again, size = self.framed(request)
            self.assertLessEqual(size, FRAME)
            self.assertEqual(same(again["result"]), same(result))

    def test_the_longest_terminal_reply_submit_allows_stays_within_the_frame(self):
        # 20 artifacts (submit's limit) with paths of about 4 KB that JSON
        # writes at six bytes a byte: control characters, emoji at three, and
        # one whose absolute path passes a folder named in bytes that are not UTF-8.
        paths = self.long_paths("\x01", 18) + self.long_paths("😀", 1)
        odd = os.fsencode(self.work) + b"/\xff\xfe-" + b"\x02" * 200
        os.mkdir(odd)
        (Path(os.fsdecode(odd)) / "f").write_bytes(b"x")
        (self.work / "odd").symlink_to(os.fsdecode(odd))
        paths.append("odd/f")
        attempt = self.attempt("true", artifacts=[{"path": p} for p in paths])
        self.run_to_end(attempt)
        bound = {k: attempt[k] for k in ("jobId", "attempt", "workspaceKey", "machineId", "digest", "expectHost")}
        reply, size = self.framed(dict(bound, action="status"))
        self.assertLessEqual(size, FRAME)
        self.assertEqual(self.projected(attempt, reply, paths)["status"], "succeeded")
        kept = json.loads((self.folder(attempt) / "artifacts.json").read_text())
        self.assertIn("\udcff\udcfe-", kept["artifacts"][-1]["absolutePath"])

    def test_an_inspect_too_long_for_core_is_refused_with_its_size_and_freezes_nothing(self):
        # 128 inputs (submit's limit) with ASCII paths of 1,791 bytes made a
        # 486,129-byte inspect reply in Job 85755f3e.
        paths = self.long_paths("a", 128, budget=1800)
        refused, size = self.framed({"action": "inspect", "cwd": str(self.work), "inputs": paths}, expect=3)
        found = re.fullmatch(r"The inputs' details would make a (\d+)-byte reply, more than one reply to Core may carry "
                             r"\(229376 bytes\); nothing was frozen\. Name fewer inputs, or ones with shorter paths",
                             refused["error"])
        self.assertIsNotNone(found, refused["error"])
        self.assertGreater(int(found.group(1)), 256 * 1024)
        self.assertLess(size, 1024)
        # Short paths, as ever.
        self.assertEqual(self.inspect(*self.long_paths("a", 2, budget=40))["status"], "inspected")

    def test_a_frame_is_measured_with_its_mark_nonce_and_newline(self):
        self.assertEqual(remote_job.FRAME_BUDGET, FRAME)
        mark = remote_job.MARK + uuid.uuid4().hex + " "
        room = FRAME - len(mark) - 1
        filler = room - len(json.dumps({"status": "logs", "text": ""}))
        fits = {"status": "logs", "text": "a" * filler}
        self.assertEqual(remote_job.within_frame(fits, mark, "logs"), json.dumps(fits))
        over = dict(fits, text="a" * (filler + 1))
        text = remote_job.within_frame(over, mark, "logs")
        self.assertLessEqual(len(mark) + len(text) + 1, FRAME)
        self.assertEqual(json.loads(text)["status"], "unclear")
        self.assertIn("a %d-byte reply" % (FRAME + 1), json.loads(text)["reason"])

    def test_an_input_whose_path_became_a_symlink_loop_is_named_and_the_start_rejected(self):
        (self.work / "in.txt").write_text("frozen\n")
        attempt = self.attempt("touch ran", inputs=self.inspect("in.txt")["files"])
        (self.work / "in.txt").unlink()
        (self.work / "in.txt").symlink_to(self.work / "loop")
        (self.work / "loop").symlink_to(self.work / "in.txt")
        self.assertTrue(remote_job.input_facts(str(self.work), "in.txt")["problem"].startswith("cannot be read: "))
        result = self.run_to_end(attempt)
        self.assertEqual(result["status"], "rejected", result)
        self.assertTrue(result["reason"].startswith("Inputs changed on this machine while queued (in.txt (cannot be read: "),
                        result["reason"])
        self.assertFalse((self.work / "ran").exists())
        # Python before 3.13 reports a loop as RuntimeError, not OSError (R2
        # 536e7e97): named the same way, never an uncaught error.
        real = Path.resolve

        def looping(path, strict=False):
            raise RuntimeError("Symlink loop from %r" % str(path))
        Path.resolve = looping
        try:
            entry = remote_job.input_facts(str(self.work), "other.txt")
        finally:
            Path.resolve = real
        self.assertEqual(entry["problem"], "cannot be read: Symlink loop from %r" % str(self.work / "other.txt"))
        self.assertNotIn("sha256", entry)

    def test_an_input_read_while_its_path_is_replaced_is_never_frozen(self):
        (self.work / "in.txt").write_text("first\n")
        real_open = Path.open
        swapped = []
        def opening(path, *args, **kwargs):
            stream = real_open(path, *args, **kwargs)
            if path.name == "in.txt" and not swapped:
                swapped.append(path)
                replacement = self.work / "in.new"
                replacement.write_text("second\n")
                os.replace(replacement, path)
            return stream
        Path.open = opening
        try:
            entry = remote_job.input_facts(str(self.work), "in.txt")
        finally:
            Path.open = real_open
        self.assertEqual(entry["problem"], "changed while it was being read")
        self.assertNotIn("sha256", entry)
        self.assertEqual(remote_job.input_facts(str(self.work), "in.txt")["sha256"], hashlib.sha256(b"second\n").hexdigest())

    def test_a_failed_command_is_reported_as_such_and_its_artifacts_are_not_checked(self):
        result = self.run_to_end(self.attempt("printf x > out.txt; exit 3", artifacts=[{"path": "out.txt"}]))
        self.assertEqual((result["status"], result["reason"], result["exitCode"]), ("failed", "exit-code 3", 3))
        self.assertNotIn("artifacts", result)

    def test_a_start_with_malformed_inputs_or_artifacts_is_refused(self):
        attempt = self.attempt("true")
        bad_inputs = dict(attempt, inputs=[{"path": "in.txt"}])
        self.assertIn("inputs must be the files Core froze", self.call(dict(bad_inputs, action="start"), expect=3)["error"])
        bad_artifacts = dict(attempt, artifacts=[{"path": "a", "format": "xml", "minBytes": 1}])
        self.assertIn("artifacts must be declared", self.call(dict(bad_artifacts, action="start"), expect=3)["error"])

    def test_digest_v3_binds_inputs_and_artifacts_and_leaves_v1_and_v2_as_they_were(self):
        base = {"argv": ["true"], "cwd": "/w", "env": {}, "timeoutSeconds": 5}
        v1 = remote_job.digest(base)
        v2 = remote_job.digest(dict(base, limits={"mode": "strict", "cpuMillis": 500, "memoryMiB": 64, "swapMiB": 0}))
        inputs = [{"path": "in.txt", "absolutePath": "/w/in.txt", "sha256": "a" * 64}]
        artifacts = [{"path": "out.json", "format": "json", "minBytes": 1}]
        v3 = remote_job.digest(dict(base, inputs=inputs, artifacts=artifacts))
        # v1 and v2 as the helper before inputs and artifacts computed them;
        # the same vectors as core/src/jobs/remote_tests.rs.
        self.assertEqual(v1, "9fd6c28e5279171ad00e05426404968e28d63227503f7d147a3a41a5c78ad84b")
        self.assertEqual(v2, "206e040dcf5f2adf8433f931d68dd450a5f7a30dec60129ae8e9538314b11d81")
        self.assertEqual(v3, "09a436e958f0430dc2f7578eab4d6e9c2805c2c3bc8942e9a942f78d269b369e")
        self.assertNotEqual(v3, remote_job.digest(dict(base, inputs=[dict(inputs[0], sha256="b" * 64)], artifacts=artifacts)))
        self.assertNotEqual(v3, remote_job.digest(dict(base, inputs=inputs, artifacts=[dict(artifacts[0], minBytes=2)])))
        self.assertNotEqual(v3, remote_job.digest(dict(base, inputs=inputs)))
        self.assertEqual(remote_job.digest(dict(base, inputs=inputs, artifacts=artifacts, limits={"mode": "strict", "cpuMillis": 500, "memoryMiB": 64, "swapMiB": 0})),
                         "03a9297c3650f42ee3f5e5e374206e2d315e156144c52231ab8baeb96c42c795")
        # Empty lists are no inputs or artifacts: v1 and v2 as before.
        self.assertEqual(remote_job.digest(dict(base, inputs=[], artifacts=[])), v1)


class PauseTests(unittest.TestCase):
    """Pause and resume of an attempt's own scope (T-108), against this host's
    systemd user manager where it has one. The data root is an absolute folder
    here and HOME is this account's own (Lead seq 4297)."""

    LIMITS = {"mode": "limited", "cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0}
    TICKS = "trap 'echo term > term.txt; exit 0' TERM; while :; do date +%s%N >> ticks; sleep 0.05; done"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.data, self.work = base / "data", base / "work"
        self.work.mkdir()
        machine = base / "machine-id"
        machine.write_text(MACHINE + "\n")
        boot = base / "boot_id"
        boot.write_text(Path("/proc/sys/kernel/random/boot_id").read_text())
        self.env = dict(os.environ, YUZUNO_JOBS_MACHINE_ID_FILE=str(machine), YUZUNO_JOBS_BOOT_ID_FILE=str(boot))
        self.facts_file = base / "capabilities.json"

    def tearDown(self):
        # Nothing of a failed test may stay frozen or running: this test's own
        # scopes are thawed, their commands killed, and the scopes stopped.
        units = []
        for path in self.data.glob("jobs/*/*/limits.json"):
            try:
                units.append(json.loads(path.read_text())["unit"])
            except (ValueError, KeyError):
                pass
        for unit in units:
            subprocess.run(["systemctl", "--user", "thaw", "--", unit], capture_output=True, timeout=15)
        try:
            end_attempts(self.data / "jobs")
        except AssertionError as error:
            raise kept(self.tmp, error) from error
        finally:
            # This test's own scopes are stopped even if a supervisor is still
            # running; its folder then stays.
            for unit in units:
                subprocess.run(["systemctl", "--user", "stop", "--", unit], capture_output=True, timeout=15)
        self.tmp.cleanup()

    def facts(self, linger):
        """This host's own facts (limited holds limits in a scope only on an
        account that lingers), or none at all: no scope."""
        values = dict(USER_MANAGER, linger=True) if linger else {"manager": False, "busctl": False, "delegated": [],
                                                                  "linger": False}
        self.facts_file.write_text(json.dumps(values))
        return {"YUZUNO_JOBS_CAPABILITIES_FILE": str(self.facts_file)}

    def call(self, request, expect=0, env_extra=None):
        nonce = uuid.uuid4().hex
        out = subprocess.run([sys.executable, "-c", HELPER.read_text()],
                             input=json.dumps(dict({"root": str(self.data)}, **request, replyNonce=nonce)),
                             capture_output=True, text=True, env=dict(self.env, **(env_extra or {})), timeout=60)
        self.assertEqual(out.returncode, expect, out.stderr + out.stdout)
        line = out.stdout.splitlines()[-1]
        return json.loads(line[len(f"{remote_job.MARK}{nonce} "):])

    def attempt(self, script, timeout=60):
        spec = {"argv": ["/bin/sh", "-c", script], "cwd": str(self.work), "env": {"PATH": "/usr/bin:/bin"},
                "timeoutSeconds": timeout, "limits": self.LIMITS}
        return dict(spec, jobId=str(uuid.uuid4()), attempt=str(uuid.uuid4()), workspaceKey="ws-1", machineId="m1",
                    digest=remote_job.digest(spec), expectHost=host_of(MACHINE))

    def bound(self, attempt, action):
        keys = ("jobId", "attempt", "workspaceKey", "machineId", "digest", "expectHost")
        return dict({key: attempt[key] for key in keys}, action=action)

    def folder(self, attempt):
        return self.data / "jobs" / attempt["jobId"] / attempt["attempt"]

    def running(self, attempt, env):
        self.call(dict(attempt, action="start"), env_extra=env)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            state = self.call(self.bound(attempt, "status"))
            if state["status"] == "running" and (self.work / "ticks").exists():
                return state
            time.sleep(0.05)
        self.fail("not running: " + json.dumps(state))

    def settle(self, attempt, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            state = self.call(self.bound(attempt, "status"))
            if state["status"] == "terminal":
                return state
            time.sleep(0.1)
        self.fail("no outcome: " + json.dumps(state))

    def ticking(self, seconds=0.6):
        before = (self.work / "ticks").read_text().count("\n")
        time.sleep(seconds)
        return (self.work / "ticks").read_text().count("\n") > before

    def test_an_attempt_without_a_scope_of_its_own_is_never_paused(self):
        attempt = self.attempt(self.TICKS)
        state = self.running(attempt, self.facts(linger=False))
        self.assertNotIn("freezer", state)
        paused = self.call(self.bound(attempt, "pause"))
        self.assertEqual(paused["state"], "notPaused")
        self.assertIn("Pause freezes only an attempt's own scope, and this attempt runs without a scope of its own "
                      "on this machine", paused["reason"])
        # Nothing was stopped by other means: it keeps running.
        self.assertTrue(self.ticking())
        self.assertFalse((self.folder(attempt) / "paused.json").exists())
        self.call(self.bound(attempt, "cancel"))
        self.assertEqual(self.settle(attempt)["result"]["status"], "cancelled")

    def test_a_recorded_scope_that_is_not_this_attempts_is_never_frozen(self):
        attempt = self.attempt(self.TICKS)
        self.running(attempt, self.facts(linger=False))
        # As if its record named another scope (the account's session, or
        # another attempt's): refused before anything is asked of systemd.
        for held in ({"unit": "session-1.scope", "cgroup": "/user.slice/user-1000.slice/session-1.scope"},
                     {"unit": "yuzuno-remote-job-%s.scope" % uuid.uuid4(), "cgroup": "/x/yuzuno-remote-job-y.scope"},
                     {"unit": "yuzuno-remote-job-%s.scope" % attempt["attempt"], "cgroup": "/user.slice/../evil.scope"}):
            remote_job.atomic(self.folder(attempt) / "limits.json", held)
            paused = self.call(self.bound(attempt, "pause"))
            self.assertEqual((paused["state"], paused["reason"]),
                             ("notPaused", "Pause freezes only an attempt's own scope, and the scope it recorded is "
                                           "not this attempt's; nothing was paused"))
            self.assertTrue(self.ticking(0.3))
        (self.folder(attempt) / "limits.json").unlink()
        self.call(self.bound(attempt, "cancel"))
        self.assertEqual(self.settle(attempt)["result"]["status"], "cancelled")

    @unittest.skipUnless(USER_MANAGER, "no systemd user manager with the memory controller here")
    def test_its_own_scope_is_frozen_read_back_and_resumed(self):
        attempt = self.attempt(self.TICKS)
        state = self.running(attempt, self.facts(linger=True))
        held = json.loads((self.folder(attempt) / "limits.json").read_text())
        self.assertEqual(state["freezer"], {"populated": True, "frozen": False})
        paused = self.call(self.bound(attempt, "pause"))
        self.assertEqual(paused["state"], "paused", paused)
        self.assertEqual(paused["evidence"]["unit"], "yuzuno-remote-job-%s.scope" % attempt["attempt"])
        self.assertEqual(paused["evidence"]["freezer"]["frozen"], True)
        events = Path("/sys/fs/cgroup" + held["cgroup"] + "/cgroup.events").read_text()
        self.assertIn("frozen 1", events)
        self.assertFalse(self.ticking())
        self.assertEqual(self.call(self.bound(attempt, "status"))["freezer"]["frozen"], True)
        # Again: nothing more is done.
        self.assertEqual(self.call(self.bound(attempt, "pause"))["reason"], "Already paused")
        resumed = self.call(self.bound(attempt, "resume"))
        self.assertEqual((resumed["state"], resumed["reason"]), ("running", "Resumed: the same processes continue"))
        self.assertTrue(self.ticking())
        self.assertEqual(self.call(self.bound(attempt, "status"))["freezer"]["frozen"], False)
        self.assertEqual(self.call(self.bound(attempt, "resume"))["reason"], "Already running")
        self.call(self.bound(attempt, "cancel"))
        self.assertEqual(self.settle(attempt)["result"]["status"], "cancelled")

    @unittest.skipUnless(USER_MANAGER, "no systemd user manager with the memory controller here")
    def test_cancel_of_a_paused_attempt_thaws_it_so_its_processes_act_on_term(self):
        attempt = self.attempt(self.TICKS)
        self.running(attempt, self.facts(linger=True))
        self.assertEqual(self.call(self.bound(attempt, "pause"))["state"], "paused")
        self.call(self.bound(attempt, "cancel"))
        result = self.settle(attempt)["result"]
        self.assertEqual(result["status"], "cancelled", result)
        self.assertEqual(result["thawedToStop"]["wasFrozen"], True, result)
        self.assertEqual((self.work / "term.txt").read_text(), "term\n")
        started = json.loads((self.folder(attempt) / "started.json").read_text())
        self.assertEqual(remote_job.members(started), [])

    @unittest.skipUnless(USER_MANAGER, "no systemd user manager with the memory controller here")
    def test_a_paused_attempt_that_reaches_its_timeout_is_stopped(self):
        attempt = self.attempt(self.TICKS, timeout=3)
        self.running(attempt, self.facts(linger=True))
        self.assertEqual(self.call(self.bound(attempt, "pause"))["state"], "paused")
        result = self.settle(attempt, seconds=30)["result"]
        self.assertEqual((result["status"], result["reason"]), ("failed", "timeout after 3 s; its process group was stopped"))
        self.assertEqual(result["thawedToStop"]["wasFrozen"], True, result)

    @unittest.skipUnless(USER_MANAGER, "no systemd user manager with the memory controller here")
    def test_a_paused_attempt_whose_supervisor_is_gone_is_thawed_and_stopped_by_cancel(self):
        # With its supervisor gone nothing reads the output pipe, so a write
        # there ends on SIGPIPE: dash, Ubuntu's /bin/sh, reports the sleep
        # the TERM ended ("Terminated") on stderr before it runs the trap.
        # Its stderr goes to a file, so the trap shows the TERM was acted on.
        attempt = self.attempt("exec 2>>stderr.txt; " + self.TICKS)
        self.running(attempt, self.facts(linger=True))
        self.assertEqual(self.call(self.bound(attempt, "pause"))["state"], "paused")
        supervisor = json.loads((self.folder(attempt) / "supervisor.json").read_text())["pid"]
        os.kill(supervisor, signal.SIGKILL)
        self.assertTrue(gone(supervisor))
        self.assertEqual(self.call(self.bound(attempt, "status"))["status"], "lost")
        cancelled = self.call(self.bound(attempt, "cancel"))
        self.assertEqual(cancelled["status"], "terminal", cancelled)
        self.assertEqual(cancelled["result"]["status"], "cancelled")
        self.assertEqual((self.work / "term.txt").read_text(), "term\n")

    @unittest.skipUnless(USER_MANAGER, "no systemd user manager with the memory controller here")
    def test_a_paused_attempt_whose_supervisor_is_gone_is_thawed_and_stopped_at_its_timeout(self):
        attempt = self.attempt("exec 2>>stderr.txt; " + self.TICKS, timeout=3)
        self.running(attempt, self.facts(linger=True))
        since = time.monotonic()
        self.assertEqual(self.call(self.bound(attempt, "pause"))["state"], "paused")
        supervisor = json.loads((self.folder(attempt) / "supervisor.json").read_text())["pid"]
        os.kill(supervisor, signal.SIGKILL)
        self.assertTrue(gone(supervisor))
        # The timeout counts while it is paused.
        time.sleep(max(0.0, since + 4 - time.monotonic()))
        state = self.call(self.bound(attempt, "status"))
        self.assertEqual(state["status"], "terminal", state)
        self.assertEqual(state["result"]["status"], "failed")
        self.assertEqual(state["result"]["thawedToStop"]["wasFrozen"], True, state["result"])
        self.assertEqual((self.work / "term.txt").read_text(), "term\n")


if __name__ == "__main__":
    unittest.main()
