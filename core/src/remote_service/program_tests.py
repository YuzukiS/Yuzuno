"""Load sampling of the remote program (YN-83 PR3), run by tests.rs:

    python3 -I program_tests.py <program.py> <machine_load.rs>

Everything is synthetic: data roots are temporary folders, children are
stand-ins with the test's own environment, and nothing runs SSH, a GPU tool
or a model. In-process tests load a fresh copy of program.py for each test,
so its module state (the gate, caches, registry) never leaks from one test to
the next. Session tests run program.main() in a child Python through WRAPPER,
which can replace a module value, os.statvfs, os.write or the reap step
before the session starts; program.py itself has no hook for them.
"""
import importlib.util
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

PROGRAM = None
MACHINE_LOAD = None
LOADED = [0]

SLEEPER = ("import os, sys, time\n"
           "with open(sys.argv[1], 'a') as out:\n"
           "    out.write(str(os.getpid()) + '\\n')\n"
           "time.sleep(60)\n")

VM_STAT_16K = (
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
    "Pages free:                              100000.\n"
    "Pages active:                            400000.\n"
    "Pages inactive:                          300000.\n"
    "Pages speculative:                        20000.\n"
    "Pages throttled:                              0.\n"
    "Pages wired down:                        150000.\n"
    "Pages purgeable:                           5000.\n"
    "\"Translation faults\":                 123456789.\n"
    "Pages copy-on-write:                    1234567.\n")

WRAPPER = r'''
import importlib.util, json, os, sys, threading, time
spec = importlib.util.spec_from_file_location("remote_program", sys.argv[1])
program = importlib.util.module_from_spec(spec)
spec.loader.exec_module(program)
scenario = json.loads(sys.argv[2])
for name, value in scenario.get("set", {}).items():
    setattr(program, name, value)
if "readsTimeout" in scenario:
    program.READS.timeout = scenario["readsTimeout"]
if scenario.get("hangStatvfs"):
    # os.stat still answers; only the filesystem query never returns.
    def hang(path):
        threading.Event().wait()
    os.statvfs = hang
if scenario.get("noReapMarked"):
    # A marked stand-in is killed but never confirmed reaped.
    real_reap = program.CHILDREN.reap
    def reap(process, timeout):
        if "stand-in-sleeper" in (process.args or []):
            time.sleep(min(timeout, 0.2))
            return False
        return real_reap(process, timeout)
    program.CHILDREN.reap = reap
if scenario.get("shortWrites"):
    # Every write to stdout takes at most 7 bytes: frames go out in pieces.
    real_write = os.write
    def short(fd, data):
        if fd == 1:
            return real_write(fd, bytes(data[:7]))
        return real_write(fd, data)
    os.write = short
sys.exit(program.main())
'''


def fresh():
    LOADED[0] += 1
    spec = importlib.util.spec_from_file_location("remote_program_%d" % LOADED[0], PROGRAM)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rust_fixture(name):
    """A fixture string from machine_load.rs's tests: both sides read one text."""
    with open(MACHINE_LOAD, "r", encoding="utf-8") as source:
        text = source.read()
    found = re.search(r'const %s: &str = "((?:[^"\\]|\\.)*)";' % name, text)
    if not found:
        raise AssertionError("machine_load.rs has no fixture " + name)
    return found.group(1).encode("utf-8").decode("unicode_escape")


def gone(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


def wait_until(predicate, timeout):
    end = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > end:
            return False
        time.sleep(0.02)
    return True


def stand_in(text):
    return [sys.executable, "-I", "-c", "import sys; sys.stdout.write(sys.argv[1])", text]


class Formulas(unittest.TestCase):
    def setUp(self):
        self.p = fresh()

    def test_rust_fixtures_give_the_same_cpu_and_memory(self):
        p = self.p
        first = p.parse_proc_stat(rust_fixture("STAT"))
        later = p.parse_proc_stat(rust_fixture("STAT_LATER"))
        # user..steal, guest inside user (machine_load.rs proc_fixtures_parse).
        self.assertEqual(first, (9585, 8100, 2))
        value, why = p.cpu_window((first[0], first[1], 10.0), (later[0], later[1], 12.0))
        self.assertIsNone(why)
        # machine_load.rs: totalPct 32.5 over 2 cores for the same two samples.
        self.assertEqual(value, {"pct": 32.5, "windowMs": 2000})
        self.assertEqual(later[2], 2)
        total, available = p.parse_meminfo(rust_fixture("MEMINFO"))
        self.assertEqual((total, available), (65536000, 49152000))
        self.assertEqual(p.memory_value(total * 1024, available * 1024, "meminfo"),
                         {"totalMiB": 64000.0, "usedMiB": 16000.0, "availableMiB": 48000.0,
                          "measure": "meminfo"})

    def test_a_step_needs_two_samples_and_keeps_the_cores(self):
        readings = iter([((9585, 8100), 2, None), ((9785, 8235), 2, None)])
        step = self.p.cpu_step(lambda: next(readings))
        state, entry = step(None)
        self.assertEqual((entry[0], entry[2]), (None, "warming"))
        time.sleep(0.01)
        state, entry = step(state)
        self.assertEqual((entry[0]["pct"], entry[0]["cores"], entry[2]), (32.5, 2, None))

    def test_counter_rules(self):
        p = self.p
        window = p.cpu_window
        # The total going back (a reset, a wrapped counter) and an empty window.
        self.assertEqual(window((1000, 500, 1.0), (900, 450, 3.0)), (None, "counter_reset"))
        self.assertEqual(window((1000, 500, 1.0), (1000, 500, 3.0)), (None, "counter_reset"))
        self.assertEqual(window((1000, 500, 1.0), (1200, 600, 1.0)), (None, "counter_reset"))

        def pct(before, after):
            first = p.parse_proc_stat(before)
            second = p.parse_proc_stat(after)
            value, why = window((first[0], first[1], 0.0), (second[0], second[1], 2.0))
            return value and value["pct"], why

        # iowait alone going back still gives a number; busy is clipped to the window.
        self.assertEqual(pct("cpu  100 0 100 1000 300 0 0 0 0 0\n",
                             "cpu  200 0 100 1000 250 0 0 0 0 0\n"), (100.0, None))
        self.assertEqual(pct("cpu  100 0 100 1000 300 0 0 0 0 0\n",
                             "cpu  150 0 100 1100 250 0 0 0 0 0\n"), (50.0, None))
        # guest and guest_nice are already in user and nice: never counted again.
        plain = pct("cpu  100 0 100 1000 0 0 0 0 0 0\n", "cpu  150 0 100 1050 0 0 0 0 0 0\n")
        guest = pct("cpu  100 0 100 1000 0 0 0 0 999999999 999999999\n",
                    "cpu  150 0 100 1050 0 0 0 0 1999999999 1999999999\n")
        self.assertEqual(plain, (50.0, None))
        self.assertEqual(guest, plain)
        # Unreadable lines.
        self.assertIsNone(p.parse_proc_stat("cpu  1 2 3\n"))
        self.assertIsNone(p.parse_proc_stat("cpu  1 2 x 4\n"))
        self.assertIsNone(p.parse_proc_stat("intr 1\n"))
        self.assertEqual(p.parse_proc_stat("cpu  1 2 3 4\ncpu0 1 2 3 4\ncpufreq 9\ncpu11 1 2 3 4\n"),
                         (10, 4, 2))

    def test_memory_without_mem_available_is_null_not_mem_free(self):
        p = self.p
        text = "MemTotal:       1024000 kB\nMemFree:         512000 kB\n"
        self.assertEqual(p.parse_meminfo(text), (1024000, None))
        p.read_text = lambda path: text
        state, entry = p.linux_memory_step(None)
        self.assertEqual((entry[0], entry[2]), (None, "no_mem_available"))
        self.assertIsNone(p.parse_meminfo("MemFree: 1 kB\n"))

    def test_darwin_fixtures(self):
        p = self.p
        available = p.parse_vm_stat(VM_STAT_16K)
        self.assertEqual(available, (100000 + 20000 + 300000) * 16384)
        self.assertEqual(p.memory_value(17179869184, available, "darwin-free+inactive"),
                         {"totalMiB": 16384.0, "usedMiB": 9821.5, "availableMiB": 6562.5,
                          "measure": "darwin-free+inactive"})
        self.assertIsNone(p.parse_vm_stat(VM_STAT_16K.split("\n", 1)[1]))
        self.assertIsNone(p.parse_vm_stat(VM_STAT_16K.replace("Pages speculative", "Pages other")))
        self.assertEqual(p.parse_memsize(b"17179869184\n"), 17179869184)
        self.assertIsNone(p.parse_memsize(b"0\n"))
        self.assertIsNone(p.parse_memsize(b"n/a\n"))
        # user, system, idle, nice: busy is user + system + nice.
        first = p.darwin_counters((100, 50, 850, 0))
        second = p.darwin_counters((150, 70, 950, 30))
        self.assertEqual(p.cpu_window(first + (0.0,), second + (2.0,)), ({"pct": 50.0, "windowMs": 2000}, None))
        # A uint32 tick wrapping makes the total go back: null, not a huge share.
        wrapped = p.darwin_counters((4294967000, 100, 5000, 0))
        after = p.darwin_counters((200, 150, 5100, 0))
        self.assertEqual(p.cpu_window(wrapped + (0.0,), after + (2.0,)), (None, "counter_reset"))
        self.assertIsNone(p.darwin_counters(None))
        self.assertIsNone(p.darwin_counters((1, 2, 3)))

    def test_darwin_memory_runs_its_stand_in_commands(self):
        p = self.p
        p.VM_STAT = stand_in(VM_STAT_16K)
        p.MEMSIZE = stand_in("17179869184\n")
        state, entry = p.darwin_memory_step(None)
        self.assertEqual(entry[0]["availableMiB"], 6562.5)
        self.assertEqual(entry[0]["totalMiB"], 16384.0)
        # hw.memsize is read once per session.
        p.MEMSIZE = [sys.executable, "-I", "-c", "raise SystemExit(1)"]
        state, entry = p.darwin_memory_step(state)
        self.assertEqual(entry[0]["totalMiB"], 16384.0)
        p.VM_STAT = stand_in(VM_STAT_16K.split("\n", 1)[1])
        state, entry = p.darwin_memory_step(state)
        self.assertEqual((entry[0], entry[2]), (None, "unparsed"))
        fresh_state, entry = p.darwin_memory_step(None)
        self.assertEqual((entry[0], entry[2]), (None, "child_failed"))
        self.assertEqual((p.CHILDREN.live, p.CHILDREN.stuck), ({}, {}))

    def test_mach_is_null_where_there_is_no_libsystem(self):
        if os.uname().sysname == "Darwin":
            self.skipTest("a real Mac has libSystem")
        p = self.p
        self.assertIsNone(p.Mach().ticks())
        self.assertEqual(p.mach_reader()(), (None, None, "unavailable"))

    def test_the_load_frame_has_ages_roles_and_no_path(self):
        p = self.p
        p.CACHE["cpu"] = ({"pct": 1.5, "windowMs": 2000, "cores": 4}, 10.0, None)
        p.CACHE["memory"] = (None, 10.0, "no_mem_available")
        p.CACHE["disk"] = ({"device": 5, "totalMiB": 100.0, "availableMiB": 50.0}, 9.0, None)
        self.assertEqual(p.load_frame(12.5), {"ev": "load", "data": {
            "cpu": {"pct": 1.5, "windowMs": 2000, "cores": 4, "ageMs": 2500},
            "memory": None,
            "disks": [{"roles": ["root"], "totalMiB": 100.0, "availableMiB": 50.0, "ageMs": 3500}],
            "gpu": None,
            "why": ["memory:no_mem_available", "gpu:not_enabled"]}})
        p.CACHE["disk"] = ({"error": "timeout", "permanent": False}, 9.0, None)
        self.assertEqual(p.load_frame(12.5)["data"]["disks"],
                         [{"roles": ["root"], "error": "timeout", "permanent": False}])
        p.CACHE["disk"] = (None, None, "pending")
        self.assertEqual(p.load_frame(12.5)["data"]["disks"],
                         [{"roles": ["root"], "error": "pending", "permanent": False}])

    def test_watch_takes_one_data_root(self):
        p = self.p
        args = lambda path, role="root": {"paths": [{"role": role, "path": path}]}
        self.assertEqual(p.watched_path(args("/srv/yuzuno-data")), "/srv/yuzuno-data")
        self.assertEqual(p.watched_path(args("~/data")), os.path.join(os.path.expanduser("~"), "data"))
        for bad in [None, {}, {"paths": []}, args("relative"), args("/a/../b"), args("/"),
                    args("/data", "work"), {"paths": [{"role": "root", "path": "/a"}] * 2},
                    {"paths": ["/a"]}]:
            self.assertIsNone(p.watched_path(bad), bad)

    def test_disk_read_and_its_permanent_errors(self):
        p = self.p
        temp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, temp, True)
        value = p.disk_read(temp)
        self.assertEqual(sorted(value), ["availableMiB", "device", "totalMiB"])
        self.assertTrue(0 <= value["availableMiB"] <= value["totalMiB"])
        self.assertEqual(p.disk_read(os.path.join(temp, "missing")), {"error": "not_found", "permanent": True})
        name = os.path.join(temp, "file")
        with open(name, "w") as out:
            out.write("x")
        self.assertEqual(p.disk_read(name), {"error": "not_directory", "permanent": True})
        self.assertEqual(p.disk_read(os.path.join(name, "x")), {"error": "not_directory", "permanent": True})
        if os.getuid() != 0:
            closed = os.path.join(temp, "closed")
            os.mkdir(closed, 0o000)
            self.addCleanup(os.chmod, closed, 0o700)
            self.assertEqual(p.disk_read(os.path.join(closed, "x")), {"error": "permission", "permanent": True})
        real = os.statvfs

        def failing(path):
            raise OSError(5, "Input/output error")
        os.statvfs = failing
        try:
            self.assertEqual(p.disk_read(temp), {"error": "io", "permanent": False})
        finally:
            os.statvfs = real


class ReadsTests(unittest.TestCase):
    def setUp(self):
        self.p = fresh()
        self.release = threading.Event()
        self.calls = []

        def read(path):
            self.calls.append(path)
            self.release.wait(10)
            return {"device": 1, "totalMiB": 10.0, "availableMiB": 5.0}
        self.read = read
        self.reads = self.p.Reads(4, 0.2, read)

    def tearDown(self):
        self.release.set()

    def test_a_hung_read_is_unknown_then_unanswered_without_more_threads(self):
        before = threading.active_count()
        start = time.monotonic()
        self.assertEqual(self.reads.sample("/a"), {"error": "timeout", "permanent": False})
        self.assertGreaterEqual(time.monotonic() - start, 0.15)
        self.assertLessEqual(threading.active_count(), before + 1)
        for _ in range(20):
            start = time.monotonic()
            self.assertEqual(self.reads.sample("/a"), {"error": "unanswered", "permanent": False})
            self.assertLess(time.monotonic() - start, 0.05)
        self.assertLessEqual(threading.active_count(), before + 1)
        self.assertEqual(self.calls, ["/a"])
        # The filesystem answers: the read leaves and the next one runs.
        self.release.set()
        with self.p.GATE:
            self.assertTrue(self.p.GATE.wait_for(lambda: not self.reads.out, 5))
        self.assertEqual(self.reads.sample("/a"), {"device": 1, "totalMiB": 10.0, "availableMiB": 5.0})
        self.assertEqual(self.calls, ["/a", "/a"])

    def test_a_caller_within_the_timeout_shares_the_read(self):
        reads = self.p.Reads(4, 5.0, self.read)
        first = []
        thread = threading.Thread(target=lambda: first.append(reads.sample("/b")))
        thread.start()
        self.assertTrue(wait_until(lambda: self.calls == ["/b"], 2))
        threading.Timer(0.5, self.release.set).start()
        self.assertEqual(reads.sample("/b")["totalMiB"], 10.0)
        thread.join(5)
        self.assertEqual(first[0]["totalMiB"], 10.0)
        self.assertEqual(self.calls, ["/b"])

    def test_at_most_four_reads_are_out(self):
        reads = self.p.Reads(4, 0.05, self.read)
        for index in range(4):
            self.assertEqual(reads.sample("/p%d" % index)["error"], "timeout")
        start = time.monotonic()
        self.assertEqual(reads.sample("/p4"), {"error": "busy", "permanent": False})
        self.assertLess(time.monotonic() - start, 0.05)
        self.assertEqual(len(self.calls), 4)

    def test_no_read_starts_once_the_exit_began(self):
        self.p.stop_work()
        before = threading.active_count()
        self.assertEqual(self.reads.sample("/d"), {"error": "stopping", "permanent": False})
        self.assertEqual(self.calls, [])
        self.assertLessEqual(threading.active_count(), before)

    def test_the_exit_wakes_a_waiting_caller(self):
        reads = self.p.Reads(4, 30.0, self.read)
        threading.Timer(0.2, self.p.stop_work).start()
        start = time.monotonic()
        self.assertEqual(reads.sample("/e"), {"error": "stopping", "permanent": False})
        self.assertLess(time.monotonic() - start, 2.0)
        self.assertEqual(list(reads.out), ["/e"], "the hung read is still out: the exit is unclean")


class ChildTests(unittest.TestCase):
    def setUp(self):
        self.p = fresh()
        self.p.CHILD_TIMEOUT = 0.3
        self.p.CHILD_WAIT = 0.5
        self.temp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.temp, True)
        self.created = []
        real = self.p.CHILDREN.popen

        def popen(*args, **kwargs):
            process = real(*args, **kwargs)
            self.created.append(process)
            return process
        self.p.CHILDREN.popen = popen

    def tearDown(self):
        for process in self.created:
            try:
                process.kill()
            except OSError:
                pass
            try:
                process.wait(timeout=5)
            except Exception:
                pass

    def sleeper(self, name):
        return [sys.executable, "-I", "-c", SLEEPER, os.path.join(self.temp, name)]

    def test_a_child_past_its_deadline_is_killed_and_reaped(self):
        start = time.monotonic()
        self.assertEqual(self.p.run_bounded("vm_stat", self.sleeper("a.pid")), (None, "child_timeout"))
        self.assertLess(time.monotonic() - start, 2.0)
        process = self.created[0]
        self.assertIsNotNone(process.returncode)
        self.assertTrue(gone(process.pid))
        self.assertEqual((self.p.CHILDREN.live, self.p.CHILDREN.stuck), ({}, {}))

    def test_limits_and_failures(self):
        p = self.p
        self.assertEqual(p.run_bounded("a", [sys.executable, "-I", "-c", "print('ok')"]), (b"ok\n", None))
        self.assertEqual(p.run_bounded("b", [sys.executable, "-I", "-c", "raise SystemExit(2)"]),
                         (None, "child_failed"))
        big = "import sys; sys.stdout.write('x' * 70000); sys.stdout.flush()"
        self.assertEqual(p.run_bounded("c", [sys.executable, "-I", "-c", big]), (None, "child_output"))
        self.assertEqual(p.run_bounded("d", [os.path.join(self.temp, "missing")]), (None, "child_failed"))
        for process in self.created:
            self.assertIsNotNone(process.returncode)
        self.assertEqual((p.CHILDREN.live, p.CHILDREN.stuck), ({}, {}))

    def test_a_child_that_cannot_be_reaped_stays_stuck_until_that_process_is(self):
        p = self.p
        allow = [False]
        real_reap = p.CHILDREN.reap

        def reap(process, timeout):
            if process is self.created[0] and not allow[0]:
                time.sleep(timeout)
                return False
            return real_reap(process, timeout)
        p.CHILDREN.reap = reap
        self.assertEqual(p.run_bounded("vm_stat", self.sleeper("b.pid")), (None, "child_stuck"))
        stuck = self.created[0]
        self.assertIs(p.CHILDREN.stuck.get("vm_stat"), stuck)
        self.assertEqual(p.unclean(), ["child_stuck"])
        # No second child of that kind while the first is not reaped.
        self.assertEqual(p.run_bounded("vm_stat", self.sleeper("b.pid")), (None, "child_stuck"))
        self.assertEqual(len(self.created), 1)
        # Another kind still runs; its reaping does not clear the stuck one.
        ok = [sys.executable, "-I", "-c", "print('ok')"]
        self.assertEqual(p.run_bounded("sysctl", ok), (b"ok\n", None))
        p.CHILDREN.settle("vm_stat", self.created[1], True)
        self.assertIs(p.CHILDREN.stuck.get("vm_stat"), stuck)
        # The exit cannot confirm it either.
        p.CHILDREN.stop_all()
        self.assertIs(p.CHILDREN.stuck.get("vm_stat"), stuck)
        # Once that same process is confirmed reaped, the kind runs again.
        allow[0] = True
        self.assertEqual(p.run_bounded("vm_stat", ok), (b"ok\n", None))
        self.assertIsNotNone(stuck.returncode)
        self.assertTrue(gone(stuck.pid))
        self.assertEqual((p.CHILDREN.live, p.CHILDREN.stuck), ({}, {}))
        with open(os.path.join(self.temp, "b.pid")) as source:
            self.assertEqual(len(source.read().split()), 1)


class GateTests(unittest.TestCase):
    """Stopping, busy marks, reads and children share one critical section."""

    def setUp(self):
        self.p = fresh()

    def test_no_child_is_created_after_the_stop_or_left_unregistered(self):
        p = self.p
        created = []

        class Fake(object):
            def __init__(self, *args, **kwargs):
                time.sleep(0.001)
                created.append(self)
                self.returncode = None

            def kill(self):
                self.returncode = -9

            def wait(self, timeout=None):
                return self.returncode
        p.CHILDREN.popen = Fake
        stopped = threading.Event()
        late = []

        def spawner(index):
            after = 0
            number = 0
            while after < 20:
                was_stopped = stopped.is_set()
                process, why = p.CHILDREN.spawn("k%d-%d" % (index, number), ["stand-in"])
                number += 1
                if was_stopped:
                    after += 1
                    if process is not None or why != "stopping":
                        late.append((index, number, why))
        threads = [threading.Thread(target=spawner, args=(index,)) for index in range(8)]
        for thread in threads:
            thread.start()
        time.sleep(0.05)
        p.stop_work()
        at_stop = len(created)
        stopped.set()
        for thread in threads:
            thread.join(10)
        self.assertEqual(late, [])
        self.assertGreater(at_stop, 0)
        self.assertEqual(len(created), at_stop, "a child was created after the stop")
        with p.GATE:
            registered = set(id(process) for process in p.CHILDREN.live.values())
        self.assertEqual(registered, set(id(process) for process in created),
                         "every child created before the stop is registered for the exit to kill")

    def test_busy_marks_are_separate_and_none_begins_after_the_stop(self):
        p = self.p
        self.assertTrue(p.begin("cpu"))
        self.assertTrue(p.begin("disk"))
        p.end("cpu")
        self.assertEqual(p.BUSY, {"cpu": False, "memory": False, "disk": True})
        self.assertEqual(p.unclean(), ["sample_busy"])
        p.end("disk")
        self.assertEqual(p.unclean(), [])
        stopped = threading.Event()
        late = []

        def sampler(kind):
            after = 0
            while after < 50:
                was_stopped = stopped.is_set()
                began = p.begin(kind)
                if began:
                    p.end(kind)
                if was_stopped:
                    after += 1
                    if began:
                        late.append(kind)
        threads = [threading.Thread(target=sampler, args=(kind,)) for kind in ("cpu", "memory", "disk")]
        for thread in threads:
            thread.start()
        time.sleep(0.05)
        p.stop_work()
        stopped.set()
        for thread in threads:
            thread.join(10)
        self.assertEqual(late, [])
        self.assertEqual(p.BUSY, {"cpu": False, "memory": False, "disk": False})

    def test_sampling_never_starts_after_the_stop_and_its_threads_end(self):
        p = self.p
        temp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, temp, True)
        p.CPU_PERIOD = p.MEMORY_PERIOD = p.DISK_PERIOD = 0.01
        before = set(threading.enumerate())
        results = []
        threads = [threading.Thread(target=lambda: results.append(p.start_sampling(temp))) for _ in range(4)]
        for thread in threads:
            thread.start()
        p.stop_work()
        for thread in threads:
            thread.join(5)
        started = [thread for thread in threading.enumerate() if thread not in before and thread not in threads]
        for thread in started:
            thread.join(2)
            self.assertFalse(thread.is_alive(), "a sampler outlived the stop")
        self.assertFalse(p.start_sampling(temp))
        self.assertEqual(p.BUSY, {"cpu": False, "memory": False, "disk": False})

    def test_the_stop_clears_a_queued_load_and_nothing_follows_the_bye(self):
        p = self.p
        p.LOAD[0] = b"{}\n"
        p.stop_work()
        self.assertIsNone(p.LOAD[0])
        self.assertFalse(p.PUBLISH[0])
        p.FINISHING = True
        p.enqueue({"re": 1, "ok": {}})
        self.assertEqual(p.CONTROL, [])


class Session(object):
    """program.main() in a child Python, through WRAPPER, on a synthetic root."""

    def __init__(self, test, scenario, env=None):
        self.temp = tempfile.mkdtemp()
        test.addCleanup(shutil.rmtree, self.temp, True)
        home = os.path.join(self.temp, "home")
        os.mkdir(home)
        self.root = os.path.join(home, "data")
        os.mkdir(self.root, 0o700)
        with open(os.path.join(home, "machine-id"), "w") as out:
            out.write("0123456789abcdef0123456789abcdef")
        with open(os.path.join(home, "boot-id"), "w") as out:
            out.write("boot")
        own = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": home,
            "YUZUNO_JOBS_MACHINE_ID_FILE": os.path.join(home, "machine-id"),
            "YUZUNO_JOBS_BOOT_ID_FILE": os.path.join(home, "boot-id"),
            "YUZUNO_REMOTE_ROOT": self.root,
            "YUZUNO_REMOTE_DIGEST": "0" * 64,
            "YUZUNO_REMOTE_SILENCE": "20",
            "YUZUNO_REMOTE_WRITE_STALL": "5",
            "YUZUNO_REMOTE_READ_WAIT": "0.3",
            "YUZUNO_REMOTE_CHILD_WAIT": "0.3",
            "YUZUNO_REMOTE_CHILD_TIMEOUT": "1",
            "YUZUNO_REMOTE_BYE_WAIT": "1",
        }
        own.update(env or {})
        self.process = subprocess.Popen(
            [sys.executable, "-I", "-B", "-c", WRAPPER, PROGRAM, json.dumps(scenario)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=own)
        test.addCleanup(self.cleanup)
        self.lines = queue.Queue()
        self.raw = []
        self.loads = []
        self.errors = []
        self.readers = [threading.Thread(target=self.pump, daemon=True),
                        threading.Thread(target=self.drain, daemon=True)]
        for reader in self.readers:
            reader.start()
        hello = self.next(5)
        test.assertEqual(hello["ev"], "hello", hello)
        self.hello = hello

    def pump(self):
        for line in iter(self.process.stdout.readline, b""):
            self.lines.put(line)
        self.lines.put(None)

    def drain(self):
        self.errors.append(self.process.stderr.read())

    def cleanup(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(5)
        for reader in self.readers:
            reader.join(5)
        for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
            try:
                pipe.close()
            except (OSError, ValueError):
                pass

    def take(self, line):
        self.raw.append(line)
        # A cut or merged frame fails here.
        frame = json.loads(line.decode("utf-8"))
        if frame.get("ev") == "load":
            self.loads.append(frame)
        return frame

    def next(self, timeout):
        """The next frame, or None at EOF (which stays readable)."""
        try:
            line = self.lines.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError("no frame within %.1f s; stderr %r" % (timeout, self.errors))
        if line is None:
            self.lines.put(None)
            return None
        return self.take(line)

    def collect(self, seconds):
        """Every frame for `seconds`, or until EOF."""
        end = time.monotonic() + seconds
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return
            try:
                line = self.lines.get(timeout=left)
            except queue.Empty:
                return
            if line is None:
                self.lines.put(None)
                return
            self.take(line)

    def send(self, value):
        self.process.stdin.write(json.dumps(value).encode("utf-8") + b"\n")
        self.process.stdin.flush()

    def reply(self, ident, timeout):
        end = time.monotonic() + timeout
        while True:
            frame = self.next(max(0.001, end - time.monotonic()))
            if frame is None:
                raise AssertionError("EOF before the reply to %r" % ident)
            if frame.get("re") == ident:
                return frame

    def watch(self, test):
        self.send({"id": 1, "op": "watch", "args": {"paths": [{"role": "root", "path": self.root}]}})
        test.assertEqual(self.reply(1, 5), {"re": 1, "ok": {}})

    def load(self, predicate, timeout):
        end = time.monotonic() + timeout
        for frame in self.loads:
            if predicate(frame["data"]):
                return frame["data"]
        while time.monotonic() < end:
            try:
                frame = self.next(max(0.001, end - time.monotonic()))
            except AssertionError:
                break
            if frame is None:
                break
            if frame.get("ev") == "load" and predicate(frame["data"]):
                return frame["data"]
        raise AssertionError("no such load in %.1f s; loads %r; stderr %r"
                             % (timeout, self.loads[-3:], self.errors))

    def rest(self, timeout):
        """Every frame up to EOF."""
        frames = []
        end = time.monotonic() + timeout
        while True:
            frame = self.next(max(0.001, end - time.monotonic()))
            if frame is None:
                return frames
            frames.append(frame)

    def close(self, test, timeout=5):
        self.send({"id": 9, "op": "close"})
        frames = self.rest(timeout)
        test.assertTrue(frames, "no frame after close")
        test.assertEqual(frames[-1]["ev"], "bye", frames[-3:])
        code = self.process.wait(timeout)
        return frames, code


FAST = {"LOAD_PERIOD": 0.05, "CPU_PERIOD": 0.05, "MEMORY_PERIOD": 0.05, "DISK_PERIOD": 0.05,
        "DARWIN_MEMORY_PERIOD": 0.1}


class SessionTests(unittest.TestCase):
    def test_pings_and_cpu_stay_live_while_the_disk_hangs(self):
        # Real periods and the real 5 s disk wait: only statvfs never returns.
        session = Session(self, {"hangStatvfs": True})
        session.watch(self)
        for index in range(10):
            start = time.monotonic()
            session.send({"id": 100 + index, "op": "ping"})
            self.assertEqual(session.reply(100 + index, 1.0), {"re": 100 + index, "ok": {}})
            self.assertLessEqual(time.monotonic() - start, 0.2, "ping %d" % index)
            time.sleep(0.3)
        data = session.load(lambda data: data["cpu"] is not None, 8)
        self.assertLessEqual(data["cpu"]["ageMs"], 3000)
        for frame in session.loads:
            cpu = frame["data"]["cpu"]
            if cpu is not None:
                self.assertLessEqual(cpu["ageMs"], 3000, frame)
            row = frame["data"]["disks"]
            self.assertEqual(len(row), 1)
            self.assertIn(row[0]["error"], ("pending", "timeout", "unanswered"), frame)
            self.assertFalse(row[0]["permanent"])
        for line in session.raw:
            self.assertNotIn(session.root.encode("utf-8"), line)
        frames, code = session.close(self)
        bye = frames[-1]["data"]
        self.assertEqual((bye["clean"], code), (False, 0))
        self.assertIn("read_pending", bye["why"])

    def test_a_hung_statvfs_with_a_working_stat_makes_the_bye_unclean(self):
        session = Session(self, {"hangStatvfs": True, "readsTimeout": 0.2, "set": FAST})
        session.watch(self)
        session.load(lambda data: data["disks"][0].get("error") in ("timeout", "unanswered"), 5)
        frames, code = session.close(self)
        bye = frames[-1]["data"]
        self.assertEqual((bye["clean"], bye["code"], code), (False, 0, 0))
        self.assertEqual(bye["why"], ["read_pending"])

    def test_the_exit_kills_and_reaps_a_running_child(self):
        pid_file = os.path.join(tempfile.mkdtemp(), "vm_stat.pid")
        self.addCleanup(shutil.rmtree, os.path.dirname(pid_file), True)
        settings = dict(FAST)
        settings.update({"SYSTEM": "Darwin",
                         "VM_STAT": [sys.executable, "-I", "-c", SLEEPER, pid_file, "stand-in-sleeper"],
                         "MEMSIZE": stand_in("17179869184\n")})
        session = Session(self, {"set": settings}, env={"YUZUNO_REMOTE_CHILD_TIMEOUT": "30"})
        session.watch(self)
        self.assertTrue(wait_until(lambda: os.path.exists(pid_file) and os.path.getsize(pid_file), 5))
        with open(pid_file) as source:
            pid = int(source.read().split()[0])
        frames, code = session.close(self)
        bye = frames[-1]["data"]
        self.assertEqual((bye["clean"], bye["why"], code), (True, [], 0))
        self.assertTrue(gone(pid), "the stand-in outlived its session")

    def test_a_child_that_cannot_be_reaped_makes_the_bye_unclean(self):
        pid_file = os.path.join(tempfile.mkdtemp(), "vm_stat.pid")
        self.addCleanup(shutil.rmtree, os.path.dirname(pid_file), True)
        settings = dict(FAST)
        settings.update({"SYSTEM": "Darwin",
                         "VM_STAT": [sys.executable, "-I", "-c", SLEEPER, pid_file, "stand-in-sleeper"],
                         "MEMSIZE": stand_in("17179869184\n")})
        session = Session(self, {"set": settings, "noReapMarked": True},
                          env={"YUZUNO_REMOTE_CHILD_TIMEOUT": "0.3"})
        session.watch(self)
        data = session.load(lambda data: "memory:child_stuck" in data["why"], 6)
        self.assertIsNone(data["memory"])
        # Later samples (every 0.1 s) find the kind stuck and start no second child.
        session.collect(1.0)
        self.assertIn("memory:child_stuck", session.loads[-1]["data"]["why"])
        frames, code = session.close(self)
        bye = frames[-1]["data"]
        self.assertEqual((bye["clean"], code), (False, 0))
        self.assertIn("child_stuck", bye["why"])
        with open(pid_file) as source:
            pids = [int(value) for value in source.read().split()]
        self.assertEqual(len(pids), 1, "a second child of a stuck kind started")
        # It was killed; once its session is gone, init reaps it.
        self.assertTrue(wait_until(lambda: gone(pids[0]), 5), "the stand-in outlived its session")

    def test_bye_is_the_last_whole_frame_while_loads_go_out_in_pieces(self):
        for attempt in range(3):
            session = Session(self, {"shortWrites": True, "set": FAST})
            session.send({"id": 2, "op": "watch", "args": {"paths": [{"role": "work", "path": "/x"}]}})
            self.assertEqual(session.reply(2, 5), {"re": 2, "err": {"code": "bad_args"}})
            session.watch(self)
            session.load(lambda data: data["cpu"] is not None, 5)
            # Three whole load frames, however slowly the split writes go out
            # on this runner: a bound for a run that hangs, not a time the
            # child must keep (a loaded macOS runner wrote two in 0.3 s,
            # core-macos 43561271725, YN-147).
            deadline = time.monotonic() + 10
            while len(session.loads) < 3 and time.monotonic() < deadline:
                session.collect(0.25)
            self.assertGreaterEqual(len(session.loads), 3)
            frames, code = session.close(self)
            self.assertEqual(code, 0, attempt)
            self.assertEqual(frames[-1]["data"]["clean"], True, frames[-1])
            # Every line parsed as one JSON frame (next() would have failed on
            # a cut one), and nothing came after the bye.
            self.assertEqual([frame for frame in frames if frame.get("ev") == "bye"], [frames[-1]])
            for line in session.raw:
                self.assertTrue(line.endswith(b"\n"))

    def test_hello_names_the_load_sources(self):
        session = Session(self, {})
        load = session.hello["data"]["load"]
        expected = {"Linux": ("proc-stat", "meminfo"), "Darwin": ("mach", "darwin-free+inactive")}
        cpu, memory = expected.get(os.uname().sysname, (None, None))
        self.assertEqual((load["cpu"], load["memory"], load["disk"], load["gpu"]), (cpu, memory, "statvfs", None))
        self.assertIn("gpu:not_enabled", load["why"])
        session.process.stdin.close()
        self.assertEqual(session.process.wait(5), 0)


if __name__ == "__main__":
    PROGRAM = sys.argv[1]
    MACHINE_LOAD = sys.argv[2]
    unittest.main(argv=[sys.argv[0], "-v"])
