#!/usr/bin/env python3
"""The Windows acceptance run's isolation, without Windows: it claims only a
data root it creates itself, removes nothing (its root is kept as evidence),
stops at once on Stop, and starts only a fresh lab Core."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("check", Path(__file__).with_name("check.py"))
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)


class Ownership(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.root = self.base / "yuzuno-next-acceptance" / "run"

    def test_an_existing_root_is_not_claimed_and_is_left_as_it_is(self):
        self.root.mkdir(parents=True)
        (self.root / "someone-elses.txt").write_text("keep")
        self.assertFalse(check.claim_root(self.root))
        done = check.cleanup(self.root, False, [])
        self.assertFalse(done["removed"])
        self.assertEqual((self.root / "someone-elses.txt").read_text(), "keep")

    def test_a_setup_failure_before_the_claim_removes_nothing(self):
        self.root.mkdir(parents=True)
        self.assertFalse(check.cleanup(self.root, False, [])["removed"])
        self.assertTrue(self.root.exists())

    def test_the_runs_own_root_is_kept_as_evidence_whatever_the_probes_say(self):
        self.assertTrue(check.claim_root(self.root))
        (self.root / "jobs" / "j1" / "a1").mkdir(parents=True)
        for probes in ([], [{"jobId": "j1", "attempt": "a1", "probe": {"status": "processes", "supervisorAlive": False,
                                                                          "processes": None, "commandRecorded": False}}]):
            done = check.cleanup(self.root, True, probes)
            self.assertFalse(done["removed"])
            self.assertEqual(done["probes"], probes)
            self.assertTrue((self.root / "jobs" / "j1" / "a1").exists())

    def test_claiming_twice_claims_once(self):
        self.assertTrue(check.claim_root(self.root))
        self.assertFalse(check.claim_root(self.root))

    def test_every_attempt_folder_is_found_not_only_recorded_jobs(self):
        root = Path(tempfile.mkdtemp())
        for job, attempt in (("j1", "a1"), ("j1", "a2"), ("j2", "a3")):
            (root / "jobs" / job / attempt).mkdir(parents=True)
        self.assertEqual(check.attempts_under(root), [("j1", "a1"), ("j1", "a2"), ("j2", "a3")])
        self.assertEqual(check.attempts_under(Path(tempfile.mkdtemp())), [])


class Isolation(unittest.TestCase):
    class Never:
        """A Core that must not be started."""
        def start(self):
            raise AssertionError("started although the lab was not fresh")

    def test_an_old_connection_file_stops_before_starting(self):
        lab = Path(tempfile.mkdtemp())
        (lab / "connection.json").write_text('{"url": "http://127.0.0.1:4999/mcp"}')
        with self.assertRaises(check.Stop):
            check.start_fresh(self.Never(), lab, 4999)

    def test_a_port_in_use_stops_before_starting(self):
        import socket
        with socket.socket() as busy:
            busy.bind(("127.0.0.1", 0))
            busy.listen()
            port = busy.getsockname()[1]
            self.assertEqual(check.listener_pid(port), __import__("os").getpid())
            with self.assertRaises(check.Stop):
                check.start_fresh(self.Never(), Path(tempfile.mkdtemp()), port)

    def test_a_stop_ends_the_run_and_no_later_item_starts(self):
        report, ran = {"items": []}, []

        def stops():
            raise check.Stop("not safe")

        def fails():
            raise AssertionError("an ordinary failure")

        with self.assertRaises(check.Stop):
            for name, step in (("fails", fails), ("stops", stops), ("later", lambda: ran.append("later"))):
                check.run_item(report, name, "test", step)
        self.assertEqual(ran, [], "no item after the Stop ran (no later submit)")
        self.assertEqual([(i["item"], i["passed"]) for i in report["items"]], [("fails", False), ("stops", False)])


class Fixture(unittest.TestCase):
    def test_the_fixture_release_carries_the_committed_helper_unchanged(self):
        import json
        lab = Path(tempfile.mkdtemp())
        for name in ("core", "update-helper"):
            (lab / name).write_text("fixture binary, never started")
            (lab / name).chmod(0o755)
        check.package_fixture(lab, "t108w-test", "a" * 40, lab / "core", lab / "update-helper")
        manifest = json.loads((lab / "bundle/manifest.json").read_text())
        record = json.loads((check.HELPER_DIR / "windows-helper.json").read_text())
        self.assertEqual(manifest["files"][check.RELEASE_HELPER]["sha256"], record["sha256"])
        self.assertTrue(manifest["files"][check.RELEASE_HELPER]["executable"])
        self.assertEqual((lab / "bundle" / check.RELEASE_HELPER).read_bytes(),
                         (check.HELPER_DIR / "yuzuno-jobs-helper.exe").read_bytes())


if __name__ == "__main__":
    unittest.main()
