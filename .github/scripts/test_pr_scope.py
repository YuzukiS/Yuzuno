"""Fixtures for pr_scope.py: real Git repositories with a merge commit shaped
like the one actions/checkout prepares for a pull request (first parent the
base, second the head). Run: python3 -m unittest discover -s .github/scripts
"""
import os
import subprocess
import tempfile
import unittest

import pr_scope

# Fixture repositories get no Git background work. Commit and merge otherwise
# start a detached `git maintenance run --auto` that can outlive them and write
# into .git while TemporaryDirectory removes it: main CI runs 39053639946 and
# 39054953740 failed in tearDown with ENOTEMPTY inside .git. GIT_CONFIG_COUNT
# also replaces any GIT_CONFIG_KEY_* the caller's environment carries.
GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_COUNT": "2",
           "GIT_CONFIG_KEY_0": "maintenance.auto", "GIT_CONFIG_VALUE_0": "false",
           "GIT_CONFIG_KEY_1": "gc.auto", "GIT_CONFIG_VALUE_1": "0",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}

BASE_FILES = {
    "README.md": "# Readme\n",
    "CONTRIBUTING.md": "# Contributing\n",
    "docs/guide.md": "# Guide\n",
    "docs/deep/notes.md": "# Notes\n",
    "core/src/lib.rs": "fn main() {}\n",
    "scripts/tool.md": "# Tool\n",
    "Cargo.lock": "# lock\n",
    "web/package-lock.json": "{}\n",
    ".github/workflows/ci.yml": "name: CI\n",
    ".agents/skills/yuzuno/SKILL.md": "# Skill\n",
    "runtimes/claude/README.md": "# Bridge\n",
}


class Repo:
    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)
        self.git("init", "-q", "-b", "main")
        for path, text in BASE_FILES.items():
            self.write(path, text)
        self.commit("base")
        self.base = self.rev("HEAD")

    def git(self, *args):
        return subprocess.run(["git", "-C", self.root, *args], env=GIT_ENV, check=True, capture_output=True).stdout.decode()

    def rev(self, name):
        return self.git("rev-parse", name).strip()

    def write(self, path, text):
        full = os.path.join(self.root, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(text)

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)

    def pull_request(self, change):
        """Commit `change` on a branch, then build the merge commit; returns (base, head)."""
        self.git("checkout", "-q", "-b", "pr", self.base)
        change(self)
        self.commit("change")
        head = self.rev("HEAD")
        self.git("checkout", "-q", "--detach", self.base)
        self.git("merge", "-q", "--no-ff", "--allow-unrelated-histories", "-m", "merge", head)
        return self.base, head

    def decide(self, base=None, head=None):
        return pr_scope.decide(self.root, base, head)


class Scope(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Repo(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_change(self, change):
        base, head = self.repo.pull_request(change)
        return self.repo.decide(base, head)

    def assertFull(self, result, mention):
        docs_only, reason, _ = result
        self.assertFalse(docs_only, reason)
        self.assertIn(mention, reason)

    def test_docs_only_change_is_light(self):
        def change(r):
            r.write("README.md", "# Readme\nMore.\n")
            r.write("CONTRIBUTING.md", "# Contributing\nMore.\n")
            r.write("docs/new.md", "# New\n")
            r.write("docs/deep/notes.md", "# Notes\nMore.\n")
        docs_only, reason, entries = self.run_change(change)
        self.assertTrue(docs_only, reason)
        self.assertEqual(sorted((e[2], e[3]) for e in entries),
                         [("A", "docs/new.md"), ("M", "CONTRIBUTING.md"), ("M", "README.md"), ("M", "docs/deep/notes.md")])

    def test_deleting_a_doc_is_light(self):
        docs_only, reason, entries = self.run_change(lambda r: r.git("rm", "-q", "docs/guide.md"))
        self.assertTrue(docs_only, reason)
        self.assertEqual([(e[2], e[3]) for e in entries], [("D", "docs/guide.md")])

    def test_rename_inside_docs_is_light(self):
        docs_only, reason, entries = self.run_change(lambda r: r.git("mv", "docs/guide.md", "docs/moved.md"))
        self.assertTrue(docs_only, reason)
        self.assertEqual(sorted((e[2], e[3]) for e in entries), [("A", "docs/moved.md"), ("D", "docs/guide.md")])

    def test_docs_with_code_is_full(self):
        def change(r):
            r.write("README.md", "# Readme\nMore.\n")
            r.write("core/src/lib.rs", "fn main() { }\n")
        self.assertFull(self.run_change(change), "core/src/lib.rs")

    def test_workflow_lockfiles_and_skill_are_full(self):
        for path in [".github/workflows/ci.yml", "Cargo.lock", "web/package-lock.json",
                     ".agents/skills/yuzuno/SKILL.md", "runtimes/claude/README.md", "scripts/tool.md"]:
            with self.subTest(path=path):
                self.tearDown()
                self.setUp()
                self.assertFull(self.run_change(lambda r, p=path: r.write(p, "changed\n")), path)

    def test_markdown_outside_the_list_is_full(self):
        for path in ["web/README.md", "docs.md", "docs/guide.MD", "docs/image.png", "notes/docs/x.md", "AGENTS.md"]:
            with self.subTest(path=path):
                self.tearDown()
                self.setUp()
                self.assertFull(self.run_change(lambda r, p=path: r.write(p, "x\n")), path)

    def test_rename_across_the_list_checks_both_paths(self):
        # Out of docs: the new path is not on the list.
        self.assertFull(self.run_change(lambda r: r.git("mv", "docs/guide.md", "scripts/guide.md")), "scripts/guide.md")
        self.tearDown()
        self.setUp()
        # Into docs: the old path is not on the list.
        self.assertFull(self.run_change(lambda r: r.git("mv", "scripts/tool.md", "docs/tool.md")), "scripts/tool.md")

    def test_symlink_and_executable_docs_are_full(self):
        def link(r):
            os.symlink("../core/src/lib.rs", os.path.join(r.root, "docs/link.md"))
        self.assertFull(self.run_change(link), "docs/link.md")
        self.tearDown()
        self.setUp()
        self.assertFull(self.run_change(lambda r: os.chmod(os.path.join(r.root, "docs/guide.md"), 0o755)), "docs/guide.md")

    def test_no_change_is_full(self):
        self.assertFull(self.run_change(lambda r: None), "empty list is never taken as documentation only")

    def test_stale_or_wrong_base_and_head_are_full(self):
        base, head = self.repo.pull_request(lambda r: r.write("docs/new.md", "# New\n"))
        self.assertTrue(self.repo.decide(base, head)[0])
        # A newer push: the event's head is no longer the merge commit's second parent.
        self.assertFull(self.repo.decide(base, base), "are not the PR's base")
        # The base moved after the merge commit was made.
        self.assertFull(self.repo.decide(head, head), "are not the PR's base")
        self.assertFull(self.repo.decide("0" * 40, head), "are not the PR's base")

    def test_head_that_is_not_a_merge_commit_is_full(self):
        self.repo.git("checkout", "-q", "--detach", self.repo.base)
        self.assertFull(self.repo.decide(self.repo.base, self.repo.base), "git rev-parse failed")

    def test_not_a_repository_is_full(self):
        with tempfile.TemporaryDirectory() as empty:
            docs_only, reason, _ = pr_scope.decide(empty, "a" * 40, "b" * 40)
        self.assertFalse(docs_only)
        self.assertIn("git rev-parse failed", reason)


class FixtureGit(unittest.TestCase):
    def test_fixture_commits_and_merges_start_no_background_maintenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Repo(os.path.join(tmp, "repo"))
            traced = {**GIT_ENV, "GIT_TRACE": "1"}
            repo.write("docs/new.md", "# New\n")
            repo.git("add", "-A")
            commit = subprocess.run(["git", "-C", repo.root, "commit", "-q", "-m", "x"], env=traced,
                                    capture_output=True, text=True, check=True).stderr
            repo.git("checkout", "-q", "--detach", repo.base)
            merge = subprocess.run(["git", "-C", repo.root, "merge", "-q", "--no-ff", "-m", "m", "main"], env=traced,
                                   capture_output=True, text=True, check=True).stderr
        for trace in (commit, merge):
            self.assertNotIn("maintenance run", trace)
            self.assertNotIn("gc --auto", trace)


class Parse(unittest.TestCase):
    def test_well_formed(self):
        data = b":100644 100644 aaaaaaa bbbbbbb M\0docs/a.md\0:000000 100644 0000000 ccccccc A\0README.md\0"
        self.assertEqual(pr_scope.parse_raw(data), [("100644", "100644", "M", "docs/a.md"), ("000000", "100644", "A", "README.md")])
        self.assertEqual(pr_scope.parse_raw(b""), [])

    def test_incomplete_or_malformed_lists_are_unknown(self):
        for data in [b":100644 100644 a b M\0docs/a.md",            # truncated: no final separator
                     b":100644 100644 a b M\0",                      # path missing
                     b"M\0docs/a.md\0",                              # not --raw output
                     b":100644 100644 a b M\0\0",                    # empty path
                     b":100644 100644 a b M\0\xff\xfe.md\0"]:        # not UTF-8
            with self.subTest(data=data), self.assertRaises(pr_scope.Unknown):
                pr_scope.parse_raw(data)

    def test_unusual_statuses_are_not_documentation(self):
        for status in ["T", "U", "X", "C75", "R100"]:
            with self.subTest(status=status):
                self.assertEqual(len(pr_scope.outside([("100644", "100644", status, "docs/a.md")])), 1)


class Main(unittest.TestCase):
    def test_outputs_and_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Repo(os.path.join(tmp, "repo"))
            base, head = repo.pull_request(lambda r: r.write("docs/new.md", "# New\n"))
            out, summary = os.path.join(tmp, "out"), os.path.join(tmp, "summary")
            old = {k: os.environ.get(k) for k in ("GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY")}
            os.environ.update(GITHUB_OUTPUT=out, GITHUB_STEP_SUMMARY=summary)
            try:
                self.assertEqual(pr_scope.main(["pr_scope.py", base, head, repo.root]), 0)
                self.assertEqual(pr_scope.main(["pr_scope.py", base, base, repo.root]), 0)
            finally:
                for k, v in old.items():
                    os.environ.pop(k) if v is None else os.environ.__setitem__(k, v)
            with open(out) as f:
                self.assertEqual(f.read(), "docs_only=true\ndocs_only=false\n")
            with open(summary) as f:
                text = f.read()
            self.assertIn("**Documentation only.**", text)
            self.assertIn("did not run", text)
            self.assertIn("**Full checks.**", text)
            self.assertIn("| A | `docs/new.md` |", text)

    def test_usage(self):
        self.assertEqual(pr_scope.main(["pr_scope.py"]), 2)


if __name__ == "__main__":
    unittest.main()
