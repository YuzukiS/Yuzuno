"""Darwin's primitives in remote_job.py's COMMON, checked on a Mac (T-186).

These exercise the code the helper actually ships: COMMON is read out of
remote_job.py and run, as exec(COMMON) does in the helper and as the written
supervisor.py (COMMON + SUPERVISOR) does on the machine. Nothing here is a
second copy of those functions.

Each check starts its own short-lived processes and writes only under a
temporary directory of its own. No Core, no Serve, no Simulator and no
machine's real Jobs state is touched.

What these do NOT show, stated so that nothing reads further than it should:
they are platform primitives only. No attempt is reconciled, nothing is
signalled, and no reservation is released or held here; a PID that truly
changed hands is not produced (the check builds a record whose start time
differs), and no machine is actually restarted (the boot UUID is injected
through the file the helper already reads for tests).
"""

import os
import re
import subprocess
import sys
import tempfile
import time
import unittest

HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "remote_job.py")


def common():
    """COMMON as the helper runs it."""
    source = open(HELPER, encoding="utf-8").read()
    block = re.search(r"COMMON = r'''(.*?)'''", source, re.S)
    assert block, "COMMON not found in remote_job.py"
    namespace = {}
    exec(block.group(1), namespace)  # noqa: S102 - the helper does the same
    return namespace


COMMON = common()


class Children:
    def __init__(self):
        self.live = []

    def start(self, *argv):
        child = subprocess.Popen(list(argv))
        self.live.append(child)
        return child

    def stop(self):
        for child in self.live:
            try:
                child.kill()
                child.wait(timeout=5)
            except Exception:
                pass
        self.live = []


class Shipped(unittest.TestCase):
    def test_common_runs_on_this_mac(self):
        """exec(COMMON) is what the helper and the supervisor both do."""
        self.assertTrue(COMMON["DARWIN"], "this check is for macOS")
        self.assertFalse(COMMON["PIDFD"], "macOS has no pidfd; send() falls back to kill(2)")

    def test_the_supervisor_as_written_compiles(self):
        """supervisor.py is COMMON + SUPERVISOR, written to the attempt's
        folder: the Darwin code has to be in it, not only importable here."""
        source = open(HELPER, encoding="utf-8").read()
        block = re.search(r"SUPERVISOR = r'''(.*?)'''", source, re.S)
        self.assertIsNotNone(block)
        text = re.search(r"COMMON = r'''(.*?)'''", source, re.S).group(1) + block.group(1)
        compile(text, "supervisor.py", "exec")
        self.assertIn("darwin_proc", text, "the supervisor carries Darwin's proc()")
        self.assertIn("kern.bootsessionuuid", text, "and Darwin's boot identity")


class ProcessIdentity(unittest.TestCase):
    def setUp(self):
        self.kids = Children()
        self.addCleanup(self.kids.stop)

    def test_same_second_starts_are_told_apart(self):
        first = self.kids.start("sleep", "10")
        second = self.kids.start("sleep", "10")
        time.sleep(0.3)
        one, two = COMMON["proc"](first.pid), COMMON["proc"](second.pid)
        self.assertIsNotNone(one)
        self.assertIsNotNone(two)
        self.assertEqual(one["starttime"] // 1000000, two["starttime"] // 1000000,
                         "only meaningful if both started in the same second")
        self.assertNotEqual(one["starttime"], two["starttime"])

    def test_start_time_does_not_move(self):
        child = self.kids.start("sleep", "10")
        time.sleep(0.2)
        first = COMMON["proc"](child.pid)["starttime"]
        time.sleep(0.4)
        self.assertEqual(COMMON["proc"](child.pid)["starttime"], first)

    def test_gone_and_zombie_are_not_processes(self):
        pid = os.fork()
        if pid == 0:
            os._exit(7)
        time.sleep(0.3)
        self.assertIsNone(COMMON["proc"](pid), "an unreaped zombie is not a process to act on")
        os.waitpid(pid, 0)
        self.assertIsNone(COMMON["proc"](pid))

    def test_alive_refuses_a_record_whose_start_time_differs(self):
        """alive() is the helper's own check. This builds a record that does
        not match the live process; it does not produce a reused PID."""
        child = self.kids.start("sleep", "10")
        time.sleep(0.2)
        now = COMMON["proc"](child.pid)
        good = {"bootId": COMMON["boot_id"](), "pid": child.pid, "starttime": now["starttime"]}
        self.assertTrue(COMMON["alive"](good))
        stale = dict(good, starttime=now["starttime"] - 1)
        self.assertFalse(COMMON["alive"](stale))

    def test_alive_refuses_a_record_from_another_boot(self):
        child = self.kids.start("sleep", "10")
        time.sleep(0.2)
        now = COMMON["proc"](child.pid)
        other = {"bootId": "11111111-1111-1111-1111-111111111111",
                 "pid": child.pid, "starttime": now["starttime"]}
        self.assertFalse(COMMON["alive"](other),
                         "another boot means the process and its whole group are gone")


class GroupMembership(unittest.TestCase):
    def setUp(self):
        self.kids = Children()
        self.addCleanup(self.kids.stop)

    def test_members_finds_the_group_without_proc(self):
        """members() lists through all_pids(); on macOS that is proc_listpids."""
        child = self.kids.start("/bin/sh", "-c", "sleep 10")
        time.sleep(0.3)
        info = COMMON["proc"](child.pid)
        group = {"bootId": COMMON["boot_id"](), "pgid": info["pgrp"], "sid": info["session"],
                 "starttime": COMMON["proc"](info["session"])["starttime"]}
        self.assertIn(child.pid, COMMON["members"](group))

    def test_members_is_empty_on_another_boot(self):
        child = self.kids.start("sleep", "10")
        time.sleep(0.2)
        info = COMMON["proc"](child.pid)
        group = {"bootId": "22222222-2222-2222-2222-222222222222",
                 "pgid": info["pgrp"], "sid": info["session"], "starttime": info["starttime"]}
        self.assertEqual(COMMON["members"](group), [])


class BootIdentity(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("YUZUNO_JOBS_BOOT_ID_FILE", None)

    def test_the_machine_has_a_boot_uuid(self):
        self.assertRegex(COMMON["boot_id"](), r"^[0-9A-Fa-f-]{36}$")

    def test_a_machine_that_started_again_is_injected_by_file(self):
        directory = tempfile.mkdtemp(prefix="yuzuno-t186-")
        self.addCleanup(lambda: __import__("shutil").rmtree(directory, ignore_errors=True))
        path = os.path.join(directory, "boot")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("11111111-1111-1111-1111-111111111111\n")
        os.environ["YUZUNO_JOBS_BOOT_ID_FILE"] = path
        self.assertEqual(COMMON["boot_id"](), "11111111-1111-1111-1111-111111111111")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("22222222-2222-2222-2222-222222222222\n")
        self.assertEqual(COMMON["boot_id"](), "22222222-2222-2222-2222-222222222222")


class PidListing(unittest.TestCase):
    def test_the_list_has_this_process(self):
        self.assertIn(os.getpid(), COMMON["all_pids"]())

    def test_the_list_is_a_real_enumeration(self):
        pids = COMMON["all_pids"]()
        self.assertGreater(len(pids), 10, "proc_listpids answered a machine's worth of PIDs")
        self.assertTrue(all(isinstance(pid, int) and pid > 0 for pid in pids))


if __name__ == "__main__":
    unittest.main(verbosity=2)
