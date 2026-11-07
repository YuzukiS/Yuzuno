import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest

spec = importlib.util.spec_from_file_location("package_release", Path(__file__).with_name("package-release.py"))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ["YUZUNO_TEST_TMP"])
        self.root = Path(self.tmp.name)
        for name in ["core", "helper"]:
            (self.root / name).write_text("fixture binary")
            (self.root / name).chmod(0o700)
        (self.root / "licenses").mkdir()
        for name in ["LICENSE", "THIRD_PARTY_NOTICES-core.txt", "rust-std-COPYRIGHT-library.html",
                     "THIRD_PARTY_NOTICES-claude-runtime.txt"]:
            (self.root / "licenses" / name).write_text(f"fixture {name}")
        (self.root / "web/licenses").mkdir(parents=True)
        (self.root / "web/index.html").write_text("<html><head></head><body>Ready</body></html>")
        (self.root / "web/licenses/THIRD_PARTY_NOTICES.txt").write_text("fixture web notices")
        runtime = self.root / "claude"
        (runtime / "node_modules/@anthropic-ai/claude-agent-sdk").mkdir(parents=True)
        (runtime / "node_modules/@anthropic-ai/claude-agent-sdk/package.json").write_text('{"version":"fixture"}')
        (runtime / "package.json").write_text("{}")
        (runtime / "bridge.mjs").write_text("// fixture")
        (self.root / "notes").write_text("Tested release")
        validator = self.root / "result-validator"
        validator.mkdir()
        (validator / "contract.json").write_text(json.dumps({"name": "fixture"}) + "\n")
        body = b"// fixture validator\n"
        header = (f"// yuzuno-result-validator contract={packager.digest(validator / 'contract.json')} "
                  f"body={hashlib.sha256(body).hexdigest()}")
        (validator / "validator.mjs").write_bytes(b"// Generated fixture\n" + header.encode() + b"\n" + body)
        # A release Core carries its validator's SHA-256 (YN-22).
        (self.root / "core").write_text(f"fixture binary {packager.digest(validator / 'validator.mjs')}")
        (validator / "THIRD_PARTY_NOTICES.txt").write_text("fixture validator notices")
        (validator / "README.md").write_text("not packaged")
        windows = self.root / "windows-jobs"
        windows.mkdir()
        (windows / "yuzuno-jobs-helper.exe").write_bytes(b"MZ fixture Windows helper")
        (windows / "yuzuno-jobs-helper.exe").chmod(0o755)
        (windows / "windows-helper.json").write_text(json.dumps({"format": 1, "file": "yuzuno-jobs-helper.exe", "protocol": 1,
            "sha256": packager.digest(windows / "yuzuno-jobs-helper.exe"), "bytes": (windows / "yuzuno-jobs-helper.exe").stat().st_size}))
        self.args = types.SimpleNamespace(core=self.root / "core", helper=self.root / "helper", licenses=self.root / "licenses", web=self.root / "web", claude=runtime, result_validator=validator, windows_helper=windows, out=self.root / "out", release_id="test-A", version="2026.10.13", git_sha="a" * 40, notes_file=self.root / "notes")

    def tearDown(self):
        self.tmp.cleanup()

    def test_complete_bundle_has_matching_identity_and_hashes(self):
        capture = io.StringIO()
        with contextlib.redirect_stdout(capture):
            packager.assemble(self.args)
        receipt = json.loads(capture.getvalue())
        manifest = json.loads((self.args.out / "manifest.json").read_text())
        self.assertEqual(receipt["manifestSha256"], packager.digest(self.args.out / "manifest.json"))
        self.assertIn('content="test-A"', (self.args.out / "web/index.html").read_text())
        for name, asset in manifest["files"].items():
            self.assertEqual(asset["sha256"], packager.digest(self.args.out / name))
        self.assertTrue(manifest["files"]["bin/yuzuno-workspace"]["executable"])
        self.assertEqual(sorted(name for name in manifest["files"] if "result-validator" in name),
                         ["runtimes/result-validator/THIRD_PARTY_NOTICES.txt", "runtimes/result-validator/contract.json",
                          "runtimes/result-validator/validator.mjs"])
        for name in ["licenses/LICENSE", "licenses/THIRD_PARTY_NOTICES-core.txt",
                     "licenses/rust-std-COPYRIGHT-library.html", "licenses/THIRD_PARTY_NOTICES-claude-runtime.txt",
                     "web/licenses/THIRD_PARTY_NOTICES.txt"]:
            self.assertIn(name, manifest["files"])
        self.assertEqual(sorted(name for name in manifest["files"] if "windows-jobs" in name),
                         ["runtimes/windows-jobs/windows-helper.json", "runtimes/windows-jobs/yuzuno-jobs-helper.exe"])
        self.assertTrue(manifest["files"]["runtimes/windows-jobs/yuzuno-jobs-helper.exe"]["executable"])
        with self.assertRaisesRegex(ValueError, "already exists"):
            packager.assemble(self.args)

    def test_a_release_without_a_matching_windows_helper_is_not_packaged(self):
        helper = self.args.windows_helper / "yuzuno-jobs-helper.exe"
        helper.write_bytes(b"MZ another helper, 25 byte")
        with self.assertRaisesRegex(ValueError, "does not match its windows-helper.json"):
            packager.assemble(self.args)
        helper.unlink()
        with self.assertRaisesRegex(ValueError, "missing"):
            packager.assemble(self.args)
        self.assertFalse(self.args.out.exists())

    def test_a_release_without_its_notices_is_not_packaged(self):
        for path, message in [(self.root / "licenses/THIRD_PARTY_NOTICES-core.txt", "missing licenses/THIRD_PARTY_NOTICES-core.txt"),
                              (self.root / "licenses/THIRD_PARTY_NOTICES-claude-runtime.txt",
                               "missing licenses/THIRD_PARTY_NOTICES-claude-runtime.txt"),
                              (self.root / "web/licenses/THIRD_PARTY_NOTICES.txt", "no licenses/THIRD_PARTY_NOTICES.txt")]:
            with self.subTest(path=path.name):
                text = path.read_text()
                path.unlink()
                with self.assertRaisesRegex(ValueError, message):
                    packager.assemble(self.args)
                self.assertFalse(self.args.out.exists())
                path.write_text(text)

    def test_a_validator_that_does_not_match_its_contract_is_not_packaged(self):
        (self.args.result_validator / "validator.mjs").write_text("// edited by hand")
        with self.assertRaisesRegex(ValueError, "does not match its contract"):
            packager.assemble(self.args)
        self.assertFalse(self.args.out.exists())

    def test_a_core_not_built_for_this_validator_is_packaged_only_as_a_lab_bundle(self):
        (self.root / "core").write_text("fixture binary built without a pinned validator")
        with self.assertRaisesRegex(ValueError, "not built for this result validator"):
            packager.assemble(self.args)
        self.assertFalse(self.args.out.exists())
        # Only a caller of assemble() may opt out; the command line cannot.
        self.args.unpinned_validator = True
        with contextlib.redirect_stdout(io.StringIO()):
            packager.assemble(self.args)
        self.assertTrue((self.args.out / "runtimes/result-validator/validator.mjs").is_file())

    def test_a_missing_validator_names_the_command_that_makes_it(self):
        (self.args.result_validator / "validator.mjs").unlink()
        with self.assertRaisesRegex(ValueError, "missing; generate it with npm --prefix web run build:result-validator"):
            packager.assemble(self.args)
        self.assertFalse(self.args.out.exists())

    @unittest.skipUnless((Path(__file__).resolve().parent.parent / "runtimes/result-validator/validator.mjs").is_file(),
                         "validator.mjs is not generated in this checkout")
    def test_the_generated_validator_matches_the_committed_contract(self):
        packager.check_result_validator(Path(__file__).resolve().parent.parent / "runtimes/result-validator", None, pinned=False)

    def test_missing_runtime_never_publishes_partial_release(self):
        (self.args.claude / "node_modules/@anthropic-ai/claude-agent-sdk/package.json").unlink()
        with self.assertRaisesRegex(ValueError, "dependencies are missing"):
            packager.assemble(self.args)
        self.assertFalse(self.args.out.exists())
        self.assertEqual(list(self.root.glob(".release-*")), [])

    def test_unreviewed_symlink_input_is_rejected(self):
        (self.args.web / "outside").symlink_to(self.root / "notes")
        with self.assertRaisesRegex(ValueError, "symlinks"):
            packager.assemble(self.args)
        self.assertFalse(self.args.out.exists())


if __name__ == "__main__":
    unittest.main()
