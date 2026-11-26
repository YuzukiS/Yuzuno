"""Fixtures for pr_scope.py: real Git repositories with a merge commit shaped
like the one actions/checkout prepares for a pull request (first parent the
base, second the head). Run: python3 -m unittest discover -s .github/scripts
"""
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
import unittest.mock

import pr_scope

ROOT = Path(__file__).resolve().parents[2]

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
    # What Core's CI reads under web/ (YN-235), in each form core_reads knows.
    "web/package.json": json.dumps({"scripts": {"build:result-validator": "node --experimental-strip-types tools/result-validator.mjs",
                                                "build": "vite build"}}) + "\n",
    "web/tools/result-validator.mjs": textwrap.dedent("""\
        import { describe } from "../src/contract/contract.ts";
        import { rolldown } from "rolldown";
        const entry = new URL("result-validator-entry.mjs", import.meta.url);
        const output = new URL("../../runtimes/result-validator/", import.meta.url);
        const web = new URL("..", import.meta.url);
        """),
    "web/tools/result-validator-entry.mjs": textwrap.dedent("""\
        import { createInterface } from "node:readline";
        import {
          check,
          limits,
        } from "../src/contract/check.ts";
        export { face } from "../src/home/face.ts";
        import "./side-effect.mjs";
        const later = () => import("../src/contract/later.ts");
        """),
    "web/tools/side-effect.mjs": "globalThis.x = 1;\n",
    "web/src/contract/contract.ts": textwrap.dedent("""\
        import { z } from "zod";
        import { key } from "./key";
        import type { Shape } from "../Shapes.tsx";
        export type { Other } from "../Other.tsx";
        // An import (one of a kind) in prose, and import() in a comment.
        """),
    "web/src/contract/key.ts": "export const key = 1;\n",
    "web/src/contract/check.ts": "export const check = 1, limits = 2;\n",
    "web/src/contract/later.ts": "export {};\n",
    "web/src/home/face.ts": 'import { helper } from "./helper";\n',
    "web/src/home/helper/index.ts": "export const helper = 1;\n",
    "web/src/Shapes.tsx": "export type Shape = 1;\n",
    "web/src/Other.tsx": "export type Other = 1;\n",
    "web/src/App.tsx": "export const App = 1;\n",
    "web/src/app.css": "body {}\n",
    "web/src/limits.ts": "export const LIMIT = 1;\n",
    "web/src/assets/icon.png": "png\n",
    "web/tools/app.test.mjs": "// a web test\n",
    "web/tools/fixtures/included.json": "{}\n",
    "web/tools/fixtures/joined.json": "{}\n",
    "web/tools/fixtures/other.json": "{}\n",
    "core/src/web_fixtures.rs": textwrap.dedent("""\
        const VIEWS: &str = include_str!("../../web/tools/fixtures/included.json");
        fn kept() -> &'static str { concat!(env!("CARGO_MANIFEST_DIR"), "/../web/tools/fixtures/joined.json") }
        // The same limit as web/src/limits.ts.
        """),
    "desktop/src/icon.rs": 'const ICON: &[u8] = include_bytes!("../../web/src/assets/icon.png");\n',
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

    def advance_base(self, change):
        """Commit `change` on main before the pull request branches from it."""
        self.git("checkout", "-q", "main")
        change(self)
        self.commit("main moves on")
        self.base = self.rev("HEAD")

    def record(self, change):
        """might_skip for a pull request of `change`, as main() computes it."""
        base, head = self.pull_request(change)
        docs_only, reason, entries = self.decide(base, head)
        assert not docs_only, reason
        return pr_scope.might_skip(self.root, entries)


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


class Record(unittest.TestCase):
    """The record-only answer (YN-235): which jobs a pull request might not need."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Repo(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def fresh(self):
        self.tearDown()
        self.setUp()

    def assertMightSkip(self, change):
        jobs, why = self.repo.record(change)
        self.assertEqual(jobs, pr_scope.MIGHT_SKIP, why)
        return why

    def assertFull(self, change, *mentions):
        jobs, why = self.repo.record(change)
        self.assertEqual(jobs, (), why)
        for mention in mentions:
            self.assertIn(mention, why)
        return why

    def test_web_files_core_does_not_read_might_be_skipped(self):
        def change(r):
            r.write("web/src/App.tsx", "export const App = 2;\n")
            r.write("web/src/app.css", "body { margin: 0 }\n")
            r.write("web/src/New.tsx", "export const New = 1;\n")
            r.write("web/tools/app.test.mjs", "// changed\n")
            r.git("rm", "-q", "web/tools/fixtures/other.json")
            # Only type imports name these, so nothing loads them.
            r.write("web/src/Shapes.tsx", "export type Shape = 2;\n")
            r.git("mv", "web/src/Other.tsx", "web/src/Others.tsx")
        self.assertIn("all 8 changes are to web/ files that Core's CI does not read", self.assertMightSkip(change))

    def test_web_files_a_rust_source_names_are_full(self):
        cases = {"web/tools/fixtures/included.json": "named in core/src/web_fixtures.rs",  # include_str!
                 "web/tools/fixtures/joined.json": "named in core/src/web_fixtures.rs",    # concat!(env!(...), ...)
                 "web/src/limits.ts": "named in core/src/web_fixtures.rs",                 # a comment
                 "web/src/assets/icon.png": "named in desktop/src/icon.rs"}                # include_bytes! elsewhere
        for path, why in cases.items():
            with self.subTest(path=path):
                self.fresh()
                self.assertFull(lambda r, p=path: r.write(p, "changed\n"), path, why)

    def test_the_result_validators_inputs_are_full(self):
        cases = ["web/tools/result-validator.mjs",        # the script build:result-validator runs
                 "web/tools/result-validator-entry.mjs",  # new URL("name", import.meta.url)
                 "web/src/contract/contract.ts",          # import ... from
                 "web/src/contract/key.ts",               # a specifier without its extension
                 "web/src/contract/check.ts",             # an import over several lines
                 "web/src/home/face.ts",                  # export ... from
                 "web/src/home/helper/index.ts",          # a folder's index
                 "web/tools/side-effect.mjs",             # import "./x"
                 "web/src/contract/later.ts"]             # import("./x")
        for path in cases:
            with self.subTest(path=path):
                self.fresh()
                self.assertFull(lambda r, p=path: r.write(p, "changed\n"), path, "result validator")

    def test_files_at_webs_top_level_are_full(self):
        for path in ["web/package.json", "web/package-lock.json", "web/tsconfig.json", "web/README.md"]:
            with self.subTest(path=path):
                self.fresh()
                self.assertFull(lambda r, p=path: r.write(p, '{"changed": true}\n'), path, "top level")

    def test_mixed_or_unusual_changes_are_full(self):
        def with_docs(r):
            r.write("web/src/App.tsx", "export const App = 2;\n")
            r.write("README.md", "# Readme\nMore.\n")
        self.assertFull(with_docs, "1 of 2 changes are outside web/", "README.md")
        self.fresh()
        def with_core(r):
            r.write("web/src/App.tsx", "export const App = 2;\n")
            r.write("core/src/lib.rs", "fn main() { }\n")
        self.assertFull(with_core, "core/src/lib.rs")
        self.fresh()
        self.assertFull(lambda r: os.symlink("App.tsx", os.path.join(r.root, "web/src/Link.tsx")), "not a plain change", "web/src/Link.tsx")
        self.fresh()
        self.assertFull(lambda r: os.chmod(os.path.join(r.root, "web/src/App.tsx"), 0o755), "not a plain change")

    def test_what_the_base_or_the_merge_reads_counts(self):
        # Deleting a file the base's validator loads.
        self.assertFull(lambda r: r.git("rm", "-q", "web/src/contract/later.ts"), "web/src/contract/later.ts", "result validator")
        self.fresh()
        # Adding a file that a specifier without its extension can now name.
        self.assertFull(lambda r: r.write("web/src/contract/key.tsx", "export const key = 2;\n"), "web/src/contract/key.tsx")

    def test_what_core_reads_cannot_be_established_is_full(self):
        for label, text in {"a variable": "const m = await import(name);\n",
                            "a template": "const m = await import(`./${name}.ts`);\n",
                            "require of a variable": "const m = require(name);\n",
                            "a resolve hook": "const u = import.meta.resolve('./x.ts');\n",
                            "an absolute path": 'import { x } from "/abs/x.ts";\n',
                            "a URL": 'import { x } from "https://example.invalid/x.mjs";\n'}.items():
            with self.subTest(label):
                self.fresh()
                self.repo.advance_base(lambda r, t=text: r.write("web/src/contract/key.ts", "export const key = 1;\n" + t))
                self.assertFull(lambda r: r.write("web/src/App.tsx", "export const App = 2;\n"), "could not be established")
        for label, package in {"no script": {"scripts": {"build": "vite build"}},
                               "a script without a module": {"scripts": {"build:result-validator": "make validator"}},
                               "a module that is not there": {"scripts": {"build:result-validator": "node tools/missing.mjs"}}}.items():
            with self.subTest(label):
                self.fresh()
                self.repo.advance_base(lambda r, p=package: r.write("web/package.json", json.dumps(p)))
                self.assertFull(lambda r: r.write("web/src/App.tsx", "export const App = 2;\n"), "could not be established")

    def test_a_list_that_could_not_be_established_records_full_checks(self):
        self.assertEqual(pr_scope.might_skip(self.repo.root, []), ((), "no change list could be established"))

    def test_the_record_is_in_the_log_and_the_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Repo(os.path.join(tmp, "repo"))
            base, head = repo.pull_request(lambda r: r.write("web/src/App.tsx", "export const App = 2;\n"))
            summary = os.path.join(tmp, "summary")
            old = os.environ.get("GITHUB_STEP_SUMMARY")
            os.environ["GITHUB_STEP_SUMMARY"] = summary
            try:
                with unittest.mock.patch("sys.stdout", new_callable=io.StringIO) as out:
                    self.assertEqual(pr_scope.main(["pr_scope.py", base, head, repo.root]), 0)
            finally:
                os.environ.pop("GITHUB_STEP_SUMMARY") if old is None else os.environ.__setitem__("GITHUB_STEP_SUMMARY", old)
            with open(summary) as f:
                text = f.read()
        self.assertIn("record_only: might_skip=Core (build and test),Lint (report-only),Claude bridge (unit tests): all 1 changes", out.getvalue())
        self.assertIn("#### Might not be needed (record only)", text)
        self.assertIn("**Core (build and test), Lint (report-only), Claude bridge (unit tests).**", text)
        self.assertIn("decides nothing", text)

    def test_file_names_stay_on_their_line_and_in_their_cell(self):
        name = "docs/a`|<b>\n::warning::x.md"
        with tempfile.TemporaryDirectory() as tmp:
            repo = Repo(os.path.join(tmp, "repo"))
            base, head = repo.pull_request(lambda r: r.write(name, "# x\n"))
            summary = os.path.join(tmp, "summary")
            old = os.environ.get("GITHUB_STEP_SUMMARY")
            os.environ["GITHUB_STEP_SUMMARY"] = summary
            try:
                with unittest.mock.patch("sys.stdout", new_callable=io.StringIO) as out:
                    pr_scope.main(["pr_scope.py", base, head, repo.root])
            finally:
                os.environ.pop("GITHUB_STEP_SUMMARY") if old is None else os.environ.__setitem__("GITHUB_STEP_SUMMARY", old)
            with open(summary) as f:
                text = f.read()
        self.assertFalse([line for line in out.getvalue().splitlines() if line.strip().startswith("::")], out.getvalue())
        self.assertIn("| A | <code>docs/a&#96;&#124;&lt;b&gt;\\x0a::warning::x.md</code> |", text)


class RealRepository(unittest.TestCase):
    """What core_reads finds in this repository, against what Core and the
    validator's build really read: the Rust macros parsed here on their own,
    and, where web/node_modules is installed (CI's Core job), the modules
    rolldown itself loads."""

    @classmethod
    def setUpClass(cls):
        done = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--verify", "-q", "HEAD"], capture_output=True)
        if done.returncode != 0:
            raise unittest.SkipTest("not a Git checkout")
        cls.reads = pr_scope.core_reads(str(ROOT), ("HEAD",))
        listed = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"], capture_output=True, check=True).stdout.decode()
        cls.files = [f for f in listed.split("\0") if f]

    def assertRead(self, paths, how):
        unread = sorted(p for p in paths if not pr_scope.read_by_core(self.reads, p))
        self.assertEqual(unread, [], f"Core's CI reads these through {how}, but core_reads does not find them")

    def test_web_files_rust_macros_name_are_read(self):
        include = re.compile(r'include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)')
        manifest = re.compile(r'concat!\(\s*env!\(\s*"CARGO_MANIFEST_DIR"\s*\)\s*,\s*"([^"]+)"\s*\)'
                              r'|(?:Path::new|PathBuf::from)\(\s*env!\(\s*"CARGO_MANIFEST_DIR"\s*\)\s*\)\s*\.join\(\s*"([^"]+)"\s*\)')
        found = {"include": set(), "manifest": set()}
        for source in (f for f in self.files if f.endswith(".rs") and not f.startswith("web/")):
            text = (ROOT / source).read_text(errors="replace")
            here = os.path.dirname(source)
            package = here
            while package and not (ROOT / package / "Cargo.toml").exists():
                package = os.path.dirname(package)
            for path in include.findall(text):
                found["include"].add(os.path.normpath(os.path.join(here, path)))
            for groups in manifest.findall(text):
                found["manifest"].add(os.path.normpath(os.path.join(package, (groups[0] or groups[1]).lstrip("/"))))
        for kind, paths in found.items():
            web = {p for p in paths if p.startswith("web/")}
            with self.subTest(kind):
                # The parser still finds the kind it looks for, so an empty set
                # cannot pass by accident.
                self.assertTrue(web, f"no {kind} reference into web/ was found")
                self.assertRead(web, kind)

    def test_the_result_validators_build_is_read(self):
        self.assertRead(["web/tools/result-validator.mjs", "web/tools/result-validator-entry.mjs",
                         "web/src/intelligent-ui/contract.ts", "web/src/intelligent-ui/brief-contract.ts",
                         "web/package.json", "web/package-lock.json"], "the result validator's build")

    def test_every_module_rolldown_loads_for_the_validator_is_read(self):
        web = ROOT / "web"
        if not (web / "node_modules/rolldown/package.json").exists() or not shutil.which("node"):
            self.skipTest("web/node_modules (npm ci) and node are needed; CI's Core job has both")
        script = textwrap.dedent("""\
            import { rolldown } from "rolldown";
            import { isAbsolute } from "node:path";
            const ids = new Set();
            for (const input of JSON.parse(process.env.VALIDATOR_INPUTS)) {
              const build = await rolldown({ input, cwd: process.cwd(), platform: "node", logLevel: "silent",
                                             external: (id) => !id.startsWith(".") && !isAbsolute(id) });
              try {
                const { output } = await build.generate({ format: "esm" });
                for (const item of output) if (item.type === "chunk") for (const id of Object.keys(item.modules)) ids.add(id);
              } finally {
                await build.close();
              }
            }
            process.stdout.write(JSON.stringify([...ids]));
            """)
        inputs = ["tools/result-validator.mjs", "tools/result-validator-entry.mjs"]
        done = subprocess.run(["node", "--input-type=module", "-e", script], cwd=web, capture_output=True, text=True,
                              env={**os.environ, "VALIDATOR_INPUTS": json.dumps(inputs)}, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr)
        loaded = set()
        for module in json.loads(done.stdout):
            path = Path(module.split("?")[0])
            if path.is_absolute() and "node_modules" not in path.parts:
                loaded.add(path.resolve().relative_to(ROOT.resolve()).as_posix())
        self.assertIn("web/src/intelligent-ui/contract.ts", loaded)
        self.assertRead({p for p in loaded if p.startswith("web/")}, "rolldown's module graph")

    def test_most_web_files_are_not_read(self):
        # The answer is not trivially "everything": the UI's own files stay out.
        web = [f for f in self.files if f.startswith("web/src/") and f.endswith(".tsx")]
        unread = [f for f in web if not pr_scope.read_by_core(self.reads, f)]
        self.assertGreater(len(unread), len(web) // 2, sorted(self.reads))


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
            self.assertIn("| A | <code>docs/new.md</code> |", text)

    def test_usage(self):
        self.assertEqual(pr_scope.main(["pr_scope.py"]), 2)


if __name__ == "__main__":
    unittest.main()
