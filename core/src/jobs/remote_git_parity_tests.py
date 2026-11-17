#!/usr/bin/env python3
"""guardGit on a machine gives the answers guardGit gives on this host (YN-83
S2): remote_job.py's git_snapshot, run on the same work tree as host.py's
snapshot, finds the same Git state, the same guarded files with the same
SHA-256, and refuses the same work trees in the same words.

Run by remote_tests.rs, with HOME and TMPDIR in a test folder:
    python3 -I -B remote_git_parity_tests.py <host.py> <remote_job.py>
"""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOST = load("host", sys.argv[1])
REMOTE = load("remote_job", sys.argv[2])
# A synthetic identity for the tests' own commits, and no system Git config.
os.environ.update(GIT_AUTHOR_NAME="Lab", GIT_AUTHOR_EMAIL="lab@example.invalid", GIT_COMMITTER_NAME="Lab",
                  GIT_COMMITTER_EMAIL="lab@example.invalid", GIT_CONFIG_NOSYSTEM="1")
MIB = 1024 * 1024


def git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


class Parity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        # A test folder may be inside another checkout: Git never looks above it.
        os.environ["GIT_CEILING_DIRECTORIES"] = str(self.base)
        self.work = self.base / "work"
        (self.work / "src").mkdir(parents=True)
        self.commit({"a.txt": "a\n", "b.txt": "b\n", "src/x.txt": "x\n", "src/y.txt": "y\n"}, init=True)

    def tearDown(self):
        self.tmp.cleanup()

    def commit(self, files, init=False):
        for name, text in files.items():
            path = self.work / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(text if isinstance(text, bytes) else text.encode())
        if init:
            git(self.work, "init", "-q")
        git(self.work, "add", ".")
        git(self.work, "commit", "-qm", "commit")

    def both(self, cwd=None, paths=(), exclude=()):
        """Each side's answer: (git, guarded files with their SHA-256), or
        the words of its refusal."""
        cwd = str(cwd or self.work)
        try:
            local = HOST.snapshot({"cwd": cwd, "guardGit": True, "guardPaths": list(paths),
                                   "guardExclude": list(exclude), "inputs": []})
            local = (local["git"], local["files"])
        except HOST.InputGuard as error:
            local = str(error)
        try:
            state, tracked = REMOTE.git_snapshot(cwd, list(paths), list(exclude))
            # A file Git lists as deleted has no SHA-256 on either side.
            remote = (state, [{"path": p, "sha256": REMOTE.input_facts(cwd, p).get("sha256")} for p in tracked])
        except REMOTE.InputGuard as error:
            remote = str(error)
        return local, remote

    def same(self, **kwargs):
        local, remote = self.both(**kwargs)
        self.assertEqual(remote, local)
        return local

    def guarded(self, answer):
        self.assertIsInstance(answer, tuple, answer)
        return [Path(f["path"]).relative_to(self.work).as_posix() for f in answer[1]]

    def test_a_clean_work_tree(self):
        answer = self.same()
        self.assertEqual(answer[0]["root"], str(self.work))
        self.assertEqual(self.guarded(answer), [])

    def test_a_changed_tracked_file_is_guarded_and_untracked_ones_are_not(self):
        (self.work / "a.txt").write_text("changed\n")
        (self.work / "new.txt").write_text("untracked\n")
        self.assertEqual(self.guarded(self.same()), ["a.txt"])

    def test_a_deleted_and_a_renamed_tracked_file(self):
        (self.work / "b.txt").unlink()
        git(self.work, "mv", "a.txt", "c.txt")
        answer = self.same()
        self.assertEqual(self.guarded(answer), ["b.txt", "c.txt"])
        self.assertIsNone(answer[1][0]["sha256"])

    def test_a_submodules_content_is_not_guarded(self):
        origin = self.base / "origin"
        origin.mkdir()
        (origin / "s.txt").write_text("s\n")
        git(origin, "init", "-q")
        git(origin, "add", ".")
        git(origin, "commit", "-qm", "sub")
        git(self.work, "-c", "protocol.file.allow=always", "submodule", "add", "-q", str(origin), "sub")
        git(self.work, "commit", "-qm", "with sub")
        (self.work / "sub" / "s.txt").write_text("changed in the submodule\n")
        self.assertEqual(self.guarded(self.same()), [])

    def test_guard_paths_freeze_only_what_is_under_them(self):
        (self.work / "a.txt").write_text("changed\n")
        (self.work / "src" / "x.txt").write_text("changed\n")
        answer = self.same(paths=["src", "missing"])
        self.assertEqual(self.guarded(answer), ["src/x.txt"])
        self.assertEqual([(o["path"], o["type"]) for o in answer[0]["guardPaths"]], [("src", "tree"), ("missing", None)])
        self.same(paths=["src/x.txt"])
        self.same(paths=["."])

    def test_guard_exclude_leaves_out_an_earlier_stages_artifact(self):
        (self.work / "a.txt").write_text("written by an earlier stage\n")
        (self.work / "b.txt").write_text("changed\n")
        self.assertEqual(self.guarded(self.same(exclude=[str(self.work / "a.txt")])), ["b.txt"])

    def test_from_a_folder_below_the_root(self):
        (self.work / "a.txt").write_text("changed\n")
        self.assertEqual(self.guarded(self.same(cwd=self.work / "src", paths=["x.txt"])), [])
        self.same(cwd=self.work / "src")

    def test_more_than_128_changed_files_are_refused_alike(self):
        self.commit({"many/%03d.txt" % i: "%d\n" % i for i in range(129)})
        for i in range(129):
            (self.work / "many" / ("%03d.txt" % i)).write_text("changed\n")
        answer = self.same()
        self.assertEqual(answer, "At most 128 guarded input files are supported; these are 129 (129 of them changed "
                                 "tracked Git files, guarded because guardGit is true)")

    def test_a_changed_file_over_2_mib_and_over_16_mib_together_are_refused_alike(self):
        self.commit({"big.bin": b"small"})
        (self.work / "big.bin").write_bytes(b"x" * (2 * MIB + 1))
        self.assertIn("big.bin is 2097153 bytes, over the 2 MiB per-file limit", self.same())
        (self.work / "big.bin").write_bytes(b"small")
        self.commit({"part%d.bin" % i: b"p" for i in range(9)})
        for i in range(9):
            (self.work / ("part%d.bin" % i)).write_bytes(b"y" * (2 * MIB - 1))
        self.assertIn("over the 16 MiB total limit", self.same())

    def exits(self, change, artifacts=()):
        """Each side's check again at exit (YN-194), frozen on this tree and
        read after `change` ran: True, or the names of what changed."""
        cwd, declared = str(self.work), [{"path": p} for p in artifacts]
        local = {"cwd": cwd, "guardGit": True, "guardPaths": [], "guardExclude": [], "inputs": [], "attempt": "a",
                 "artifacts": declared}
        local["snapshot"] = HOST.snapshot(local)
        state, tracked = REMOTE.git_snapshot(cwd, [], [])
        inputs = [REMOTE.input_facts(cwd, p) for p in tracked]
        remote = {"cwd": cwd, "git": {"frozen": state, "guardExclude": []}, "inputs": inputs, "artifacts": declared}
        change()
        answers = [HOST.exit_guard(local), REMOTE.exit_guard(remote, "a")]
        return [True if a["unchanged"] else sorted(Path(n).name if os.path.isabs(n) else n for n in a["changed"])
                for a in answers]

    def test_the_check_at_exit_names_the_same_changes(self):
        (self.work / "b.txt").write_text("dirty at submit\n")
        self.assertEqual(self.exits(lambda: None), [True, True])
        self.assertEqual(self.exits(lambda: (self.work / "a.txt").write_text("changed\n")), [["a.txt"]] * 2)
        self.assertEqual(self.exits(lambda: (self.work / "b.txt").write_text("again\n")), [["b.txt"]] * 2)
        # Its own declared artifact is left out, dirty at submit or not.
        own = lambda: [(self.work / n).write_text("its output\n") for n in ("a.txt", "b.txt")]
        self.assertEqual(self.exits(own, artifacts=["a.txt", "b.txt"]), [True, True])

    def test_a_commit_while_it_ran_is_named_alike_at_exit(self):
        self.assertEqual(self.exits(lambda: git(self.work, "commit", "-q", "--allow-empty", "-m", "later")),
                         [["the Git commit"]] * 2)

    def test_outside_a_work_tree(self):
        plain = self.base / "plain"
        plain.mkdir()
        self.assertEqual(self.same(cwd=plain), (None, []))
        self.assertEqual(self.same(cwd=plain, paths=["data"]),
                         "guardPaths need cwd inside a Git work tree: guardGit found none there")
        self.assertTrue(self.same(paths=["../plain"]).startswith("guardPaths must be inside the Git work tree of cwd"))


if __name__ == "__main__":
    if shutil.which("git") is None:
        sys.exit("git is needed")
    unittest.main(argv=[sys.argv[0]], verbosity=2)
