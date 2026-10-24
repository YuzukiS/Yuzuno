"""A managed attempt on this Mac, end to end through the real helper (T-186).

Each check runs core/src/jobs/remote_job.py as Core runs it: one JSON request
on stdin, one framed reply on stdout, one process per call. The helper's own
code decides everything; nothing here reimplements it, and the digest each
request carries is computed with the helper's own digest(), as Core computes
the same.

The SSH hop itself is NOT exercised here: Core reaches the Mac over SSH and
these calls reach the same program directly on it. What is exercised is the
Mac end of the contract -- start, status, logs, artifacts, cancel, timeout,
a second start of the same attempt, and the refusals.

Every attempt writes under a data root of this test's own making, inside a
temporary directory removed afterwards. No Core, no Serve, no Simulator and
no real machine state is touched.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "remote_job.py")
MARK = "YUZUNO-JOBS-REPLY "
# What a start answers once the command is launched: still running, its group
# settling after a command that already exited, or already terminal.
STARTED_STATES = ("running", "settling", "stopping", "terminal")


def helper_namespace():
    """The helper's own functions, for the digest a request must carry."""
    source = open(HELPER, encoding="utf-8").read()
    namespace = {"__name__": "remote_job_under_test"}
    exec(compile(source, HELPER, "exec"), namespace)  # noqa: S102
    return namespace


HELPER_NS = helper_namespace()


class Reply(dict):
    """A helper reply, with the process's exit code."""

    def __init__(self, data, code):
        super().__init__(data)
        self.code = code


def call(request, timeout=120):
    """One helper call, as Core makes it."""
    nonce = os.urandom(16).hex()
    request = dict(request, replyNonce=nonce)
    done = subprocess.run([sys.executable, HELPER], input=json.dumps(request),
                          capture_output=True, text=True, timeout=timeout)
    for line in done.stdout.splitlines():
        if line.startswith(MARK + nonce + " "):
            return Reply(json.loads(line[len(MARK) + len(nonce) + 1:]), done.returncode)
    raise AssertionError("no framed reply (code %s): %r / %r"
                         % (done.returncode, done.stdout[-2000:], done.stderr[-2000:]))


class Attempt:
    """One job attempt's requests, bound as Core binds them."""

    def __init__(self, root, host, argv, cwd, timeout_seconds=30, limits=None, artifacts=None):
        self.root = root
        self.host = host
        self.job = str(uuid.uuid4())
        self.attempt = str(uuid.uuid4())
        self.spec = {"jobId": self.job, "attempt": self.attempt, "argv": argv, "cwd": cwd,
                     "env": {}, "timeoutSeconds": timeout_seconds}
        if limits is not None:
            self.spec["limits"] = limits
        if artifacts is not None:
            self.spec["artifacts"] = artifacts

    def request(self, action, **extra):
        base = {"action": action, "root": self.root, "jobId": self.job, "attempt": self.attempt,
                "workspaceKey": "ws-t186", "machineId": "mac-t186",
                "digest": HELPER_NS["digest"](self.spec), "expectHost": self.host}
        if action == "start":
            base.update({key: value for key, value in self.spec.items()
                         if key not in ("jobId", "attempt")})
        base.update(extra)
        return base

    def start(self, **extra):
        return call(self.request("start", **extra))

    def status(self):
        return call(self.request("status"))

    def cancel(self):
        return call(self.request("cancel"))

    def logs(self):
        return call(self.request("logs"))

    def pause(self):
        return call(self.request("pause"))

    def settle(self, seconds=90):
        """Status until the attempt is terminal."""
        deadline = time.monotonic() + seconds
        reply = self.status()
        while reply.get("status") != "terminal" and time.monotonic() < deadline:
            time.sleep(0.3)
            reply = self.status()
        return reply


class DarwinManagedAttempt(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hello = call({"action": "hello", "root": "/tmp"})
        cls.host = cls.hello.get("hostId")

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="yuzuno-t186-e2e-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        # The helper creates its own data root, 0700, as it does on a real
        # machine; only the parent has to exist. A root this test pre-creates
        # with the default mode is refused, and should be.
        self.root = os.path.join(self.dir, "data")
        if not self.host:
            self.skipTest("hello did not name this host")

    def attempt(self, **kwargs):
        kwargs.setdefault("cwd", self.dir)
        return Attempt(self.root, self.host, **kwargs)

    # -- what the Mac says it is -------------------------------------------

    def test_hello_is_darwin_and_claims_nothing_it_cannot_hold(self):
        self.assertEqual(self.hello["platform"], "Darwin")
        self.assertFalse(self.hello["pidfd"], "macOS has no pidfd")
        resources = self.hello["resources"]
        self.assertFalse(resources["manager"], "no systemd user manager on macOS")
        self.assertEqual(resources["delegated"], [], "no delegated cgroup controllers")
        self.assertFalse(resources["swap"])

    # -- a short limited job, end to end -----------------------------------

    def test_a_limited_job_runs_and_its_output_and_artifact_are_recorded(self):
        path = os.path.join(self.dir, "out.txt")
        job = self.attempt(
            argv=["/bin/sh", "-c", "echo hello-from-mac; echo %s > %s" % ("written", path)],
            limits={"mode": "limited", "cpuMillis": 500, "memoryMiB": 256, "swapMiB": 0},
            artifacts=[{"path": "out.txt", "format": "bytes", "minBytes": 1}])
        started = job.start()
        # start answers the attempt's state: running, or already terminal for
        # a command this short.
        self.assertIn(started.get("status"), STARTED_STATES, started)
        final = job.settle()
        self.assertEqual(final.get("status"), "terminal", final)
        result = final["result"]
        self.assertEqual(result.get("status"), "succeeded", result)
        self.assertEqual(result.get("exitCode"), 0, result)
        # Declared, never held: macOS has no cgroup and the result says so.
        limits = result.get("limits") or {}
        self.assertIsNone(limits.get("held"), limits)
        self.assertEqual(limits.get("memory"), "declared", limits)
        self.assertEqual(limits.get("cpu"), "declared", limits)
        self.assertTrue(limits.get("caveats"), "the caveats name what is only declared")
        logs = job.logs()
        self.assertIn("hello-from-mac", json.dumps(logs), logs)
        artifacts = result.get("artifacts") or logs.get("artifacts") or []
        self.assertTrue(artifacts, "the declared artifact was checked: %s" % result)
        self.assertTrue(any(a.get("ok") for a in artifacts), artifacts)

    def test_a_failing_command_is_recorded_as_failed(self):
        job = self.attempt(argv=["/bin/sh", "-c", "exit 7"],
                           limits={"mode": "limited", "cpuMillis": 500, "memoryMiB": 256, "swapMiB": 0})
        self.assertIn(job.start().get("status"), STARTED_STATES)
        result = job.settle()["result"]
        self.assertEqual(result.get("exitCode"), 7, result)
        self.assertNotEqual(result.get("status"), "succeeded", result)

    # -- cancel and timeout ------------------------------------------------

    def test_cancel_stops_a_running_attempt(self):
        job = self.attempt(argv=["/bin/sh", "-c", "sleep 120"], timeout_seconds=600,
                           limits={"mode": "limited", "cpuMillis": 500, "memoryMiB": 256, "swapMiB": 0})
        self.assertIn(job.start().get("status"), STARTED_STATES)
        time.sleep(1.0)
        job.cancel()
        result = job.settle()["result"]
        self.assertEqual(result.get("status"), "cancelled", result)
        self.assertEqual(result.get("signal"), 15, "its process group was stopped")

    def test_a_timeout_ends_the_attempt(self):
        job = self.attempt(argv=["/bin/sh", "-c", "sleep 120"], timeout_seconds=2,
                           limits={"mode": "limited", "cpuMillis": 500, "memoryMiB": 256, "swapMiB": 0})
        self.assertIn(job.start().get("status"), STARTED_STATES)
        result = job.settle()["result"]
        self.assertEqual(result.get("status"), "failed", result)
        self.assertIn("timeout", result.get("reason", ""), result)
        self.assertEqual(result.get("signal"), 15, result)

    # -- the same attempt started twice ------------------------------------

    def test_a_second_start_of_the_same_attempt_does_not_run_it_again(self):
        """A lost reply makes Core ask again; the attempt must not start twice."""
        job = self.attempt(argv=["/bin/sh", "-c", "sleep 30"], timeout_seconds=120,
                           limits={"mode": "limited", "cpuMillis": 500, "memoryMiB": 256, "swapMiB": 0})
        first = job.start()
        self.assertIn(first.get("status"), STARTED_STATES, first)
        started = first.get("started") or {}
        again = job.start()
        # The same attempt again answers its state, never a second command:
        # the recorded process identity must be the one already running.
        self.assertEqual((again.get("started") or {}).get("pid"), started.get("pid"),
                         "a second start must not launch the command again: %s" % again)
        self.assertEqual((again.get("started") or {}).get("starttime"), started.get("starttime"), again)
        job.cancel()
        job.settle()

    # -- what Darwin refuses -----------------------------------------------

    def test_strict_limits_are_refused_not_quietly_downgraded(self):
        job = self.attempt(argv=["/bin/sh", "-c", "true"],
                           limits={"mode": "strict", "cpuMillis": 500, "memoryMiB": 256, "swapMiB": 0})
        refused = job.start()
        self.assertIn("error", refused, refused)
        self.assertIn("strict", refused["error"])
        self.assertEqual(refused.code, 3, "a refusal exits 3 and started nothing")
        self.assertIsNone(job.status().get("result"), "nothing was recorded for it")

    def test_pause_is_refused_on_a_machine_with_no_scope(self):
        job = self.attempt(argv=["/bin/sh", "-c", "sleep 30"], timeout_seconds=120,
                           limits={"mode": "limited", "cpuMillis": 500, "memoryMiB": 256, "swapMiB": 0})
        self.assertIn(job.start().get("status"), STARTED_STATES)
        paused = job.pause()
        self.assertEqual(paused.get("state"), "notPaused", paused)
        self.assertIn("scope", paused.get("reason", ""),
                      "pause is refused with its reason, never faked with signals: %s" % paused)
        job.cancel()
        job.settle()


class InspectAndResume(unittest.TestCase):
    """The two actions Core's flow calls that the lifecycle checks above do
    not reach: inputs read at submit, and resume."""

    @classmethod
    def setUpClass(cls):
        cls.host = call({"action": "hello", "root": "/tmp"}).get("hostId")

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="yuzuno-t186-e2e-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.root = os.path.join(self.dir, "data")
        if not self.host:
            self.skipTest("hello did not name this host")

    def test_inspect_reads_a_file_on_this_mac_with_its_sha256(self):
        """inspect writes nothing and makes no attempt: it is what Core freezes
        a job's inputs from at submit."""
        import hashlib
        body = b"t186 input\n" * 10
        path = os.path.join(self.dir, "input.txt")
        with open(path, "wb") as handle:
            handle.write(body)
        reply = call({"action": "inspect", "cwd": self.dir, "inputs": ["input.txt"]})
        self.assertEqual(reply.get("status"), "inspected", reply)
        self.assertEqual(reply.get("totalBytes"), len(body), reply)
        found = reply["files"][0]
        self.assertEqual(found.get("sha256"), hashlib.sha256(body).hexdigest(), found)
        self.assertFalse(os.path.exists(self.root), "inspect creates no data root")

    def test_inspect_names_a_missing_path_instead_of_failing(self):
        reply = call({"action": "inspect", "cwd": self.dir, "inputs": ["not-here.txt"]})
        self.assertEqual(reply.get("status"), "inspected", reply)
        found = reply["files"][0]
        self.assertIsNone(found.get("sha256"), found)
        self.assertTrue(found.get("problem"), "it says why the path cannot be an input: %s" % found)

    def test_inspect_refuses_a_working_directory_that_is_not_there(self):
        reply = call({"action": "inspect", "cwd": os.path.join(self.dir, "absent"),
                      "inputs": ["x"]})
        self.assertIn("error", reply, reply)
        self.assertEqual(reply.code, 3, "a refusal exits 3")

    def test_resume_is_refused_on_a_machine_with_no_scope(self):
        """As pause: macOS has no freezer, and nothing is thawed with signals."""
        job = Attempt(self.root, self.host, argv=["/bin/sh", "-c", "sleep 30"], cwd=self.dir,
                      timeout_seconds=120,
                      limits={"mode": "limited", "cpuMillis": 500, "memoryMiB": 256, "swapMiB": 0})
        self.assertIn(job.start().get("status"), STARTED_STATES)
        resumed = call(job.request("resume"))
        # resume answers notResumed, as pause answers notPaused.
        self.assertEqual(resumed.get("state"), "notResumed", resumed)
        self.assertIn("scope", resumed.get("reason", ""), resumed)
        job.cancel()
        job.settle()


if __name__ == "__main__":
    unittest.main(verbosity=2)
