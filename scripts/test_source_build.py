"""source_build.py on two small source trees that share one target directory.

Each tree is a Cargo workspace with one member, `app`, at the same relative
path; only the text the program prints differs. That is the T-39 case: a red
tree (an old commit's source) and a green worktree with the same layout.
The fixtures live under this checkout's target/ and have no dependencies, so
each build takes about a second. Skipped without cargo.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "source_build.py"
spec = importlib.util.spec_from_file_location("source_build", SCRIPT)
source_build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source_build)
CARGO = shutil.which("cargo")


def host_triple() -> str:
    out = subprocess.run(["rustc", "-vV"], capture_output=True, text=True, check=True).stdout
    return next(line.split(": ", 1)[1] for line in out.splitlines() if line.startswith("host: "))


def verify_record(record: Path) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), "verify", "--record", str(record)], capture_output=True, text=True)

MAIN = """use std::io::Write;
fn main() {{
    // A run that edits its own source, to change the inputs mid-run.
    if std::env::var_os("EDIT_SOURCE").is_some() {{
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs");
        let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        writeln!(file, "// edited during the run").unwrap();
    }}
    // A copy a lab keeps running.
    if let Some(ms) = std::env::var("SLEEP_MS").ok().and_then(|ms| ms.parse().ok()) {{
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }}
    println!("{text}");
}}
"""


def tree(parent: Path, name: str, text: str, mtime: float | None = None) -> Path:
    root = parent / name
    (root / "app/src").mkdir(parents=True)
    (root / "Cargo.toml").write_text('[workspace]\nmembers = ["app"]\nresolver = "2"\n')
    (root / "app/Cargo.toml").write_text('[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n')
    (root / "app/src/main.rs").write_text(MAIN.format(text=text))
    subprocess.run([CARGO, "generate-lockfile", "--offline"], cwd=root, check=True, capture_output=True)
    if mtime is not None:
        for path in root.rglob("*"):
            os.utime(path, (mtime, mtime))
    return root


def plain_run(root: Path, target: Path) -> str:
    """`cargo run` in root on target, without source_build."""
    out = subprocess.run([CARGO, "run", "-q", "--target-dir", str(target)], cwd=root,
                         capture_output=True, text=True, check=True)
    return out.stdout.strip()


def checked(root: Path, target: Path, *extra: str, env=None) -> subprocess.CompletedProcess:
    """`cargo run` in root through source_build."""
    return subprocess.run([sys.executable, str(SCRIPT), "run", "--target-dir", str(target), *extra, "--", "cargo", "run", "-q"],
                          cwd=root, capture_output=True, text=True, env={**os.environ, **(env or {})})


@unittest.skipUnless(CARGO, "cargo is not installed")
class SharedTargetTests(unittest.TestCase):
    def setUp(self):
        base = HERE.parent / "target"
        base.mkdir(exist_ok=True)
        self.dir = Path(tempfile.mkdtemp(prefix="source-build-test-", dir=base))
        self.target = self.dir / "shared-target"
        self.past = time.time() - 3600

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_plain_cargo_runs_the_other_trees_build_when_this_tree_is_older(self):
        # The cause, with plain Cargo: same relative paths, and this tree's
        # files older than the other tree's last build in the shared target.
        green = tree(self.dir, "green", "green", mtime=self.past)
        red = tree(self.dir, "red", "red")
        self.assertEqual(plain_run(red, self.target), "red")
        self.assertEqual(plain_run(green, self.target), "red",
                         "Cargo treats green's older files as unchanged and reuses red's binary")
        # A newer file in green makes Cargo build it.
        os.utime(green / "app/src/main.rs")
        self.assertEqual(plain_run(green, self.target), "green")

    def test_each_tree_gets_its_own_build_and_the_same_source_reuses_it(self):
        green = tree(self.dir, "green", "green", mtime=self.past)
        red = tree(self.dir, "red", "red")
        record = self.dir / "record.json"
        first = checked(red, self.target)
        self.assertEqual((first.returncode, first.stdout.strip()), (0, "red"))
        # The case plain Cargo gets wrong: green, older, right after red.
        switched = checked(green, self.target, "--record", str(record), "--artifact", "app")
        self.assertEqual((switched.returncode, switched.stdout.strip()), (0, "green"), switched.stderr)
        self.assertIn("last built from another tree", switched.stderr)
        facts = json.loads(record.read_text())
        self.assertEqual((facts["root"], facts["exitCode"], facts["cleaned"]), (str(green.resolve()), 0, "last built from another tree"))
        self.assertEqual(facts["artifacts"]["app"], source_build.sha256(self.target / "debug/app"))
        self.assertEqual(facts["digest"], source_build.digest(green.resolve(), [green.resolve() / p for p in facts["inputs"]]))
        # Back and forth.
        back = checked(red, self.target)
        self.assertEqual((back.returncode, back.stdout.strip()), (0, "red"))
        # The same source again: nothing cleaned, nothing compiled.
        again = subprocess.run([sys.executable, str(SCRIPT), "run", "--target-dir", str(self.target), "--", "cargo", "build"],
                               cwd=red, capture_output=True, text=True)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertNotIn("cleaned", again.stderr)
        self.assertNotIn("Compiling app", again.stderr)
        # An edit in the same tree is Cargo's own business: rebuilt, not cleaned.
        (red / "app/src/main.rs").write_text(MAIN.format(text="red, edited"))
        edited = checked(red, self.target)
        self.assertEqual((edited.returncode, edited.stdout.strip()), (0, "red, edited"), edited.stderr)
        self.assertNotIn("cleaned", edited.stderr)

    def test_runs_from_two_trees_at_once_each_get_their_own_build(self):
        green = tree(self.dir, "green", "green", mtime=self.past)
        red = tree(self.dir, "red", "red")
        results = {}
        threads = [threading.Thread(target=lambda name, root: results.__setitem__(name, checked(root, self.target)), args=(name, root))
                   for name, root in (("red", red), ("green", green), ("red2", red))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=300)
        self.assertEqual({name: (r.returncode, r.stdout.strip()) for name, r in results.items()},
                         {"red": (0, "red"), "green": (0, "green"), "red2": (0, "red")})

    def test_a_source_change_during_the_run_is_rejected_and_nothing_is_recorded_as_built(self):
        red = tree(self.dir, "red", "red")
        record = self.dir / "record.json"
        edited = checked(red, self.target, "--record", str(record), env={"EDIT_SOURCE": "1"})
        self.assertEqual(edited.returncode, source_build.SOURCE_CHANGED, edited.stderr)
        self.assertIn("changed during the run", edited.stderr)
        self.assertIn("rejected", json.loads(record.read_text()))
        self.assertFalse((self.target / ".source-build/built-debug.json").exists())
        verify = subprocess.run([sys.executable, str(SCRIPT), "verify", "--record", str(record)], capture_output=True, text=True)
        self.assertEqual(verify.returncode, source_build.SOURCE_CHANGED)
        # The next run builds the edited source instead of trusting the old build.
        next_run = checked(red, self.target)
        self.assertEqual((next_run.returncode, next_run.stdout.strip()), (0, "red"))
        self.assertIn("cleaned", next_run.stderr)

    def test_verify_matches_only_the_same_source_and_artifacts(self):
        red = tree(self.dir, "red", "red")
        record, copies = self.dir / "record.json", self.dir / "copies"
        built = checked(red, self.target, "--record", str(record), "--artifact", "app", "--copy-to", str(copies))
        self.assertEqual(built.returncode, 0, built.stderr)
        ok = subprocess.run([sys.executable, str(SCRIPT), "verify", "--record", str(record)], capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        # The copy is what verify checks: a later build in the target does not disturb it.
        (copies / "app").write_bytes(b"not the build")
        replaced = subprocess.run([sys.executable, str(SCRIPT), "verify", "--record", str(record)], capture_output=True, text=True)
        self.assertEqual(replaced.returncode, source_build.SOURCE_CHANGED)
        self.assertIn("is not the artifact", replaced.stderr)
        shutil.copy2(self.target / "debug/app", copies / "app")
        (red / "app/src/main.rs").write_text(MAIN.format(text="red, edited"))
        changed = subprocess.run([sys.executable, str(SCRIPT), "verify", "--record", str(record)], capture_output=True, text=True)
        self.assertEqual(changed.returncode, source_build.SOURCE_CHANGED)
        self.assertIn("source changed since this build", changed.stderr)

    def test_a_failed_run_still_records_the_tree_so_the_next_tree_is_told_why(self):
        green = tree(self.dir, "green", "green", mtime=self.past)
        red = tree(self.dir, "red", "red")
        failing = subprocess.run([sys.executable, str(SCRIPT), "run", "--target-dir", str(self.target), "--", "cargo", "run", "-q", "--bin", "missing"],
                                 cwd=red, capture_output=True, text=True)
        self.assertNotEqual(failing.returncode, 0)
        switched = checked(green, self.target)
        self.assertEqual((switched.returncode, switched.stdout.strip()), (0, "green"))
        self.assertIn("last built from another tree", switched.stderr)

    def test_copy_to_replaces_a_copy_that_is_running(self):
        red = tree(self.dir, "red", "red")
        record, copies = self.dir / "record.json", self.dir / "copies"
        first = checked(red, self.target, "--artifact", "app", "--copy-to", str(copies))
        self.assertEqual(first.returncode, 0, first.stderr)
        # A lab runs the copy while the tree is built and copied again.
        running = subprocess.Popen([str(copies / "app")], stdout=subprocess.PIPE, text=True, env={**os.environ, "SLEEP_MS": "4000"})
        try:
            time.sleep(0.3)
            self.assertIsNone(running.poll(), "the copy is running")
            again = checked(red, self.target, "--record", str(record), "--artifact", "app", "--copy-to", str(copies))
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertNotIn("Traceback", again.stderr)
            self.assertIsNone(running.poll(), "the copy was replaced while it ran")
        finally:
            output = running.communicate(timeout=30)[0]
        self.assertEqual(output.strip(), "red")
        verify = subprocess.run([sys.executable, str(SCRIPT), "verify", "--record", str(record)], capture_output=True, text=True)
        self.assertEqual(verify.returncode, 0, verify.stderr)
        self.assertFalse((self.target / ".source-build/holder.json").exists())
        self.assertEqual(sorted(p.name for p in copies.iterdir()), ["app"], "no temporary copies left")

    def test_a_target_triple_from_the_environment_or_config_is_refused_and_a_stale_build_never_endorsed(self):
        # The Lead's probe: an earlier ordinary build left target/debug/app;
        # a target triple sends the next build to target/<triple>/debug.
        red = tree(self.dir, "red", "red")
        record, copies = self.dir / "record.json", self.dir / "copies"
        ordinary = checked(red, self.target, "--record", str(record), "--artifact", "app", "--copy-to", str(copies))
        self.assertEqual(ordinary.returncode, 0, ordinary.stderr)
        (copies / "app").write_text("OLD COPY")
        (red / "app/src/main.rs").write_text(MAIN.format(text="red, edited"))
        cases = [({"CARGO_BUILD_TARGET": host_triple()}, None),
                 ({}, f'[build]\ntarget = "{host_triple()}"\n')]
        for env, config in cases:
            with self.subTest(env=env, config=config):
                if config:
                    (red / ".cargo").mkdir(exist_ok=True)
                    (red / ".cargo/config.toml").write_text(config)
                run = subprocess.run([sys.executable, str(SCRIPT), "run", "--target-dir", str(self.target), "--record", str(record),
                                      "--artifact", "app", "--copy-to", str(copies), "--", "cargo", "build", "--offline"],
                                     cwd=red, capture_output=True, text=True, env={**os.environ, **env})
                self.assertEqual(run.returncode, source_build.USAGE, run.stderr)
                self.assertIn("target triple", run.stderr)
                self.assertIn("rejected", json.loads(record.read_text()))
                self.assertNotEqual(verify_record(record).returncode, 0, "the refused run's record never verifies")
                self.assertEqual((copies / "app").read_text(), "OLD COPY", "nothing stale is copied as this build")
                shutil.rmtree(red / ".cargo", ignore_errors=True)

    def test_a_requested_artifact_this_run_did_not_produce_fails_closed(self):
        red = tree(self.dir, "red", "red")
        record = self.dir / "record.json"
        missing = checked(red, self.target, "--record", str(record), "--artifact", "not-built")
        self.assertEqual(missing.returncode, source_build.NOT_PRODUCED, missing.stderr)
        facts = json.loads(record.read_text())
        self.assertEqual((facts["requestedArtifacts"], facts["artifacts"]), (["not-built"], {}))
        self.assertIn("not produced by this run", facts["rejected"])
        self.assertNotEqual(verify_record(record).returncode, 0)
        # Without --artifact, a record of what built is still valid, and says so.
        plain = checked(red, self.target, "--record", str(record))
        self.assertEqual(plain.returncode, 0, plain.stderr)
        ok = verify_record(record)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn("no artifacts were requested", ok.stdout)

    def test_the_command_must_be_cargo_and_the_target_given_once_without_cross_builds(self):
        red = tree(self.dir, "red", "red")
        for command in (["make"], ["cargo", "build", "--target-dir", "x"], ["cargo", "build", "--target", "x86_64-unknown-linux-musl"],
                        ["cargo", "--config", "build.target='x86_64-unknown-linux-musl'", "build"]):
            result = subprocess.run([sys.executable, str(SCRIPT), "run", "--", *command], cwd=red, capture_output=True, text=True)
            self.assertEqual(result.returncode, source_build.USAGE, result.stderr)


class SliceLabTests(unittest.TestCase):
    """scripts/slice-lab.py builds through source_build and starts only a matching copy."""

    def setUp(self):
        spec = importlib.util.spec_from_file_location("slice_lab", HERE / "slice-lab.py")
        self.lab = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.lab)
        base = HERE.parent / "target"
        base.mkdir(exist_ok=True)
        self.dir = Path(tempfile.mkdtemp(prefix="slice-lab-test-", dir=base))
        self.lab.LAB, self.lab.WEB = self.dir, self.dir / "web"
        self.lab.PROCESS = self.dir / "core-process.json"

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_the_default_target_is_on_disk_and_build_core_records_and_copies_its_binary(self):
        self.assertFalse(str(self.lab.TARGET).startswith("/tmp/"))
        calls = []
        self.lab.command = lambda args, cwd=None, env=None: calls.append([str(a) for a in args])
        with unittest.mock.patch.object(self.lab.shutil, "which", return_value=sys.executable):
            self.lab.build_core()
        args = calls[0]
        self.assertEqual(args[1:3], [str(SCRIPT), "run"])
        self.assertEqual(args[args.index("--record") + 1], str(self.dir / "core-build.json"))
        self.assertEqual(args[args.index("--copy-to") + 1], str(self.dir / "core-bin"))
        self.assertEqual(args[args.index("--") + 1:], ["cargo", "build", "--locked", "-p", "yuzuno-workspace"])

    def test_start_core_refuses_a_binary_that_does_not_match_the_source(self):
        (self.dir / "web/dist").mkdir(parents=True)
        (self.dir / "web/dist/index.html").write_text("ui")
        (self.dir / "core-bin").mkdir()
        (self.dir / "core-bin/yuzuno-workspace").write_text("an older build")
        (self.dir / "core-build.json").write_text(json.dumps({
            "root": str(self.dir), "inputs": ["web/dist/index.html"], "digest": "0" * 64, "exitCode": 0,
            "outputDir": str(self.dir), "copiedTo": str(self.dir / "core-bin"), "artifacts": {}}))
        with self.assertRaisesRegex(RuntimeError, "not this source's build"):
            self.lab.start_core("codex")


class OutputDirTests(unittest.TestCase):
    def test_profiles_map_to_cargos_output_directories(self):
        self.assertEqual(source_build.output_dir(["build"]), ("debug", []))
        self.assertEqual(source_build.output_dir(["test", "--lib"]), ("debug", []))
        self.assertEqual(source_build.output_dir(["build", "--release"]), ("release", ["--release"]))
        self.assertEqual(source_build.output_dir(["bench"]), ("release", ["--release"]))
        self.assertEqual(source_build.output_dir(["build", "--profile", "test"]), ("debug", ["--profile", "dev"]))
        self.assertEqual(source_build.output_dir(["build", "--profile=ci"]), ("ci", ["--profile", "ci"]))


if __name__ == "__main__":
    unittest.main()
