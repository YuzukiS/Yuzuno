import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("launch", Path(__file__).with_name("launch.py"))
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


class IndependentLaunchTests(unittest.TestCase):
    def test_desktop_does_not_inspect_core_files_or_spawn_core(self):
        args = launch.parser().parse_args(["desktop", "--core-url", "http://localhost:9321"])
        with patch.object(Path, "is_file", side_effect=AssertionError("client must not inspect Core files")):
            command = launch.desktop_command(args)
        self.assertIn("desktop/Cargo.toml", command[command.index("--manifest-path") + 1])
        self.assertEqual(command[-2:], ["--core-url", "http://localhost:9321"])
        self.assertNotIn("yuzuno-workspace", " ".join(command))

    def test_prebuilt_client_needs_no_rust_or_workspace(self):
        args = launch.parser().parse_args(["desktop", "--desktop-bin", "/tmp/yuzuno.exe"])
        with patch.object(launch.shutil, "which", side_effect=AssertionError("must not require cargo")):
            self.assertEqual(launch.desktop_command(args)[0], "/tmp/yuzuno.exe")

    def test_core_origin_rejects_ambient_credentials_and_http_lan(self):
        for url in ["http://127.0.0.1:4317", "http://localhost:9321/", "https://workspace.example"]:
            self.assertTrue(launch.core_url(url))
        for url in ["http://user:secret@127.0.0.1:4317", "http://192.168.0.2:4317", "http://localhost:0", "file:///tmp/core", "http://localhost:4317/api", "http://localhost:4317?token=x"]:
            with self.assertRaises(launch.argparse.ArgumentTypeError):
                launch.core_url(url)


if __name__ == "__main__":
    unittest.main()
