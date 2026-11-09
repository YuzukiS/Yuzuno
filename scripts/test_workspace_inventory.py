"""workspace_inventory.py on throwaway repositories and synthetic folders
(YN-74 ④a, design 7): its output keeps its schema, every rule it shares with
Core recognizes its fixture and nothing else, Git's facts are what Git says
when asked directly, and it writes nothing but its output. It runs the
script the way Core does: `python3 -I -c <source>`.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "workspace_inventory.py"
CORE_CHECK = HERE.parent / "core" / "src" / "cleanup_plans" / "check.rs"
TAG = "Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by {}.\n"


def git(cwd, *args):
    done = subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main",
                           "-C", str(cwd)] + list(args), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return done.stdout.decode().strip()


def snapshot(root):
    """Every path below root with its size and mtime, to see nothing changed."""
    seen = {}
    for folder, dirs, files in os.walk(root):
        for name in dirs + files:
            path = os.path.join(folder, name)
            info = os.lstat(path)
            seen[path] = (info.st_size, info.st_mtime_ns)
    return seen


class Inventory(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(os.path.realpath(self.tmp.name))
        self.root = root
        self.remote = root / "remote.git"
        git(root, "init", "-q", "--bare", "remote.git")
        self.project = root / "work" / "demo"
        self.project.mkdir(parents=True)
        git(self.project, "init", "-q")
        (self.project / ".gitignore").write_text("target/\n.worktrees/\nnode_modules/\n")
        (self.project / "README.md").write_text("demo\n")
        git(self.project, "add", ".")
        git(self.project, "commit", "-q", "-m", "first")
        git(self.project, "remote", "add", "origin", str(self.remote))
        git(self.project, "push", "-q", "origin", "main")
        git(self.project, "remote", "set-head", "origin", "main")
        self.scratch = root / "scratch"
        self.scratch.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, *extra, expect=0):
        out = self.root / "out" / "inventory.json"
        argv = [sys.executable, "-I", "-c", SCRIPT.read_text(), "--project", str(self.project), "--out", str(out)] + list(extra)
        # Git looks for no repository above the throwaway root (a temporary
        # folder can be inside a checkout, as in a Job whose TMPDIR is).
        env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(self.root))
        done = subprocess.run(argv, cwd=str(self.root), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(done.returncode, expect, done.stderr.decode())
        return json.loads(out.read_text()) if expect == 0 else done

    def cargo(self, folder, profiles=("debug",)):
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "CACHEDIR.TAG").write_text(TAG.format("cargo"))
        for name in profiles:
            (folder / name / ".fingerprint").mkdir(parents=True, exist_ok=True)
            (folder / name / ".cargo-lock").write_text("")
            (folder / name / "deps").mkdir(exist_ok=True)
            (folder / name / "deps" / "blob").write_bytes(b"x" * 20000)

    def test_the_schema_the_rules_and_git_facts_are_what_git_says(self):
        tree = self.project / ".worktrees" / "ahead"
        git(self.project, "worktree", "add", "-q", "-b", "feat/ahead", str(tree))
        (tree / "mine.txt").write_text("mine\n")
        git(tree, "add", "mine.txt")
        git(tree, "commit", "-q", "-m", "mine")
        (tree / "draft.md").write_text("untracked\n")
        (tree / "README.md").write_text("changed\n")
        self.cargo(tree / "target")
        self.cargo(self.project / "target", profiles=("debug", "release"))
        pytest = self.scratch / "job-1" / ".pytest_cache"
        pytest.mkdir(parents=True)
        (pytest / "CACHEDIR.TAG").write_text(TAG.format("pytest"))
        forged = self.scratch / "job-1" / "forged"
        forged.mkdir()
        (forged / "CACHEDIR.TAG").write_text("Signature: 0000\n")
        # A rule file in the repository adds no rule.
        (self.project / "node_modules").mkdir()
        (self.project / ".yuzuno-cleanup.json").write_text('{"rules":[{"name":"node_modules"}]}')
        before = snapshot(self.root / "work") | snapshot(self.scratch)
        result = self.run_script("--scratch", str(self.scratch))
        # It wrote nothing but its output (asked before this test's own git calls refresh an index).
        self.assertEqual(snapshot(self.root / "work") | snapshot(self.scratch), before)
        self.assertEqual((result["schema"], result["version"]), ("yuzuno.cleanup-inventory", 1))
        for key in ("generatedAt", "host", "project", "rules", "worktrees", "cacheDirs", "scratch", "skipped", "complete", "bounds"):
            self.assertIn(key, result)
        self.assertTrue(result["complete"])
        self.assertEqual(result["project"]["upstream"], "refs/remotes/origin/main")
        by_path = {w["path"]: w for w in result["worktrees"]}
        main, ahead = by_path[str(self.project)], by_path[str(tree)]
        self.assertTrue(main["main"] and not ahead["main"])
        self.assertEqual(ahead["branch"], "feat/ahead")
        # Git's facts, as Git gives them when asked directly.
        status = git(tree, "status", "--porcelain=v1", "--untracked-files=normal", "--ignored=no").splitlines()
        self.assertEqual(ahead["git"]["untrackedFiles"], sum(1 for l in status if l.startswith("??")))
        self.assertEqual(ahead["git"]["trackedChanges"], sum(1 for l in status if not l.startswith("??")))
        self.assertEqual(ahead["git"]["uniqueCommits"], int(git(tree, "rev-list", "--count", "HEAD", "--not", "--remotes")))
        cherry = git(tree, "cherry", "refs/remotes/origin/main", "HEAD").splitlines()
        self.assertEqual(ahead["git"]["cherryUnmerged"], sum(1 for l in cherry if l.startswith("+")))
        self.assertEqual((ahead["git"]["uniqueCommits"], ahead["git"]["cherryUnmerged"], ahead["git"]["merged"]), (1, 1, False))
        self.assertEqual((main["git"]["uniqueCommits"], main["git"]["merged"]), (0, True))
        # Each rule's fixture, and nothing else.
        caches = {c["path"]: c for c in result["cacheDirs"]}
        self.assertEqual(caches[str(tree / "target")]["rule"], "cargo")
        self.assertTrue(caches[str(tree / "target")]["ignored"])
        self.assertEqual(caches[str(self.project / "target")]["rule"], "cargo")
        self.assertEqual(caches[str(pytest)]["rule"], "cachedir-tag")
        self.assertIn("pytest", caches[str(pytest)]["basis"])
        self.assertNotIn(str(forged), caches)
        self.assertNotIn(str(self.project / "node_modules"), caches, "no rule recognizes it yet; a repository file adds none")
        self.assertEqual([e["path"] for e in result["scratch"][0]["entries"]], [str(self.scratch / "job-1")])

    def test_each_file_is_measured_once_and_facts_outlast_the_bounds(self):
        tree = self.project / ".worktrees" / "ahead"
        git(self.project, "worktree", "add", "-q", "-b", "feat/ahead", str(tree))
        self.cargo(tree / "target")
        self.cargo(self.project / "target")
        entry = self.scratch / "copy"
        self.cargo(entry / "target")
        (entry / "notes.txt").write_text("notes\n")
        result = self.run_script("--scratch", str(self.scratch))
        by_path = {w["path"]: w for w in result["worktrees"]}

        def files(root, leave_out=()):
            count = 0
            for folder, dirs, names in os.walk(str(root)):
                dirs[:] = [d for d in dirs if os.path.join(folder, d) not in leave_out]
                count += len(names)
            return count
        # A worktree's own size: without the worktree inside it and its rules' folders.
        main = by_path[str(self.project)]["size"]
        self.assertEqual(main["files"], files(self.project, {str(tree), str(self.project / "target")}))
        self.assertEqual(by_path[str(tree)]["size"]["files"], files(tree, {str(tree / "target")}))
        caches = {c["path"]: c for c in result["cacheDirs"]}
        self.assertEqual(caches[str(tree / "target")]["size"]["files"], files(tree / "target"))
        # A scratch entry's size is whole: it goes whole.
        self.assertEqual(result["scratch"][0]["entries"][0]["size"]["files"], files(entry))
        # Out of bounds: sizes are cut short, never Git's facts.
        cut = self.run_script("--scratch", str(self.scratch), "--max-entries", "1")
        self.assertFalse(cut["complete"])
        self.assertEqual({w["path"] for w in cut["worktrees"]}, set(by_path))
        for worktree in cut["worktrees"]:
            self.assertEqual(worktree["git"], by_path[worktree["path"]]["git"])

    def test_protected_paths_and_links_are_left_out(self):
        keep = self.scratch / "keep"
        keep.mkdir()
        (self.scratch / "junk").mkdir()
        os.symlink(str(keep), str(self.scratch / "link"))
        result = self.run_script("--scratch", str(self.scratch), "--protected", str(keep))
        entries = [e["path"] for e in result["scratch"][0]["entries"]]
        self.assertEqual(entries, [str(self.scratch / "junk")])
        why = {s["path"]: s["why"] for s in result["skipped"]}
        self.assertIn("protected", why[str(keep)])
        self.assertEqual(why[str(self.scratch / "link")], "a link")

    def test_a_folder_that_is_missing_or_not_git_writes_nothing_and_fails(self):
        out = self.root / "out" / "inventory.json"
        self.project = self.root / "nowhere"
        done = self.run_script(expect=1)
        self.assertIn("does not exist", done.stderr.decode())
        self.assertFalse(out.exists(), "no inventory is written: never an empty one")
        plain = self.root / "plain"
        plain.mkdir()
        self.project = plain
        done = self.run_script(expect=1)
        self.assertIn("not a Git checkout", done.stderr.decode())
        self.assertFalse(out.exists())

    def test_its_rules_are_core_s(self):
        source = SCRIPT.read_text()
        self.assertIn('RULE_IDS = ("cargo", "cachedir-tag")', source)
        # Core's recognize() names exactly these two; ③ adds rules on both sides.
        core = CORE_CHECK.read_text()
        self.assertIn('Some(("cargo", basis))', core)
        self.assertIn('("cachedir-tag", ', core)


if __name__ == "__main__":
    unittest.main()
