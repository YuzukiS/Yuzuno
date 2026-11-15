"""Controlled transport/filesystem tests for the file copies (YN-145 F4).

No SSH account or model is used: the same helper `remote_images.py` runs here
with a temporary HOME, as it does on a machine over SSH.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

HELPER = os.environ["YUZUNO_FILE_HELPER"]
STUB = """
import socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.bind(sys.argv[-1]);s.listen(10)
print('ready',flush=True)
while True:
 c,_=s.accept();c.close()
"""


def content(name, data):
    digest = hashlib.sha256(data).hexdigest()
    return {"id": digest, "name": name, "bytes": len(data)}


class Files(unittest.TestCase):
    # The Agent's data root, as Core names it in each request.
    ROOT = "~/.yuzuno"

    def setUp(self):
        # macOS's per-user TMPDIR can exceed AF_UNIX's socket path limit.
        self.temp = tempfile.TemporaryDirectory(prefix="files-", dir="/tmp")
        self.home = Path(self.temp.name)
        self.base = self.home / self.ROOT[2:]
        self.base.parent.mkdir(exist_ok=True)
        self.owner = dict(workspace="workspace-a", agent="agent-a", machine="mac-a",
                          target="test@machine", harness="codex")
        self.request = dict(self.owner, op="install-files", instance="instance-a")
        self.start_runtime()

    def start_runtime(self):
        key = hashlib.sha256(json.dumps([self.owner["workspace"], self.owner["agent"]]).encode()).hexdigest()[:24]
        self.runtime = self.base / ("claude" if self.owner["harness"] == "claude" else "runtimes") / key
        self.runtime.mkdir(mode=0o700, parents=True)
        for path in (self.runtime.parent, self.runtime.parent.parent):
            path.chmod(0o700)
        sock = str(self.runtime / "rpc.sock")
        kind = "remote-host.mjs" if self.owner["harness"] == "claude" else "app-server"
        self.process = subprocess.Popen([sys.executable, "-c", STUB, kind, sock],
                                        stdout=subprocess.PIPE, text=True)
        self.assertEqual(self.process.stdout.readline().strip(), "ready")
        identity = subprocess.check_output(
            ["ps", "-p", str(self.process.pid), "-o", "stat=", "-o", "lstart=", "-o", "args="],
            text=True).strip().split(None, 1)[1]
        meta = dict(pid=self.process.pid, processIdentity=identity, instanceId="instance-a",
                    root=str(self.runtime), socket=sock)
        path = self.runtime / ("host.json" if self.owner["harness"] == "claude" else "runtime.json")
        path.write_text(json.dumps(meta))
        path.chmod(0o600)

    def stop_runtime(self):
        self.process.terminate()
        self.process.wait(timeout=5)
        self.process.stdout.close()

    def tearDown(self):
        if self.process.poll() is None:
            self.stop_runtime()
        self.temp.cleanup()

    def call(self, request=None, bodies=b"", ok=True):
        request = dict(self.request if request is None else request)
        request.setdefault("root", self.ROOT)
        result = subprocess.run([sys.executable, "-c", HELPER],
                                env={**os.environ, "HOME": str(self.home)},
                                input=json.dumps(request).encode() + b"\n" + bodies,
                                capture_output=True, timeout=30)
        self.assertEqual(result.returncode == 0, ok, result.stderr.decode())
        return json.loads(result.stdout) if ok else result.stderr.decode()

    def root(self):
        return next(self.home.rglob("owner.json")).parent

    def test_install_keeps_bytes_and_mode_and_reuses_them(self):
        first, second = b"the report", b"\x00\x01binary\n"
        request = dict(self.request, files=[content("q3-report.pdf", first),
                                            content("sensor-log.csv", second)])
        response = self.call(request, first + second)
        paths = [Path(file["path"]) for file in response["files"]]
        self.assertEqual([p.read_bytes() for p in paths], [first, second])
        for path in paths:
            self.assertEqual(path.stat().st_mode & 0o777, 0o400)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(path.parts[-5:-3], (self.base.name, "file-cache"))
        before = [p.stat().st_mtime_ns for p in paths]
        self.assertEqual(self.call(request, first + second), response)
        self.assertEqual([p.stat().st_mtime_ns for p in paths], before)
        # The same content under another name is a separate copy.
        renamed = self.call(dict(self.request, files=[content("report-copy.pdf", first)]), first)
        self.assertNotEqual(renamed["files"][0]["path"], response["files"][0]["path"])
        self.assertEqual(Path(renamed["files"][0]["path"]).read_bytes(), first)

    def test_names_are_checked_again(self):
        data = b"named"
        for name in ["q3 报告.pdf", "_hidden", "a.b.c", "x" * 196 + ".txt"]:
            self.assertEqual(self.call(dict(self.request, files=[content(name, data)]), data)
                             ["files"][0]["path"].split("/")[-1], name)
        for name in ["../x", "a/b", "\\x", ".env", "-rf", "trailing.", "a\x01b",
                     "back`tick", "x" * 300, ""]:
            self.assertIn("Invalid file name", self.call(dict(self.request, files=[content(name, data)]),
                                                         data, ok=False), name)

    def test_count_size_total_and_duplicate_limits(self):
        data = b"small"
        one = content("a.txt", data)
        for files in [[], [one] * 9, [one, one],
                      [dict(one, bytes=0)], [dict(one, bytes=40 * 1024 * 1024 + 1)]]:
            self.call(dict(self.request, files=files), data, ok=False)
        big = [dict(content(str(i) + ".bin", b""), bytes=21 * 1024 * 1024) for i in range(2)]
        self.assertIn("40 MiB", self.call(dict(self.request, files=big), b"", ok=False))
        # A truncated body, or one that does not hash to its id, keeps nothing.
        self.assertIn("truncated", self.call(dict(self.request, files=[one]), data[:-2], ok=False))
        self.assertIn("truncated", self.call(dict(self.request, files=[one]), b"other", ok=False))
        self.assertFalse(list(self.home.rglob(".upload-*")))

    def test_cache_quota_and_entry_limit(self):
        data = b"kept"
        path = Path(self.call(dict(self.request, files=[content("kept.txt", data)]), data)["files"][0]["path"])
        root = self.root()
        used = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
        quota = root / "quota-fixture"
        with quota.open("wb") as stream:
            stream.truncate(256 * 1024 * 1024 - used)
        quota.chmod(0o600)
        # Existing content is found by digest, not written again.
        self.assertEqual(self.call(dict(self.request, files=[content("kept.txt", data)]), data)
                         ["files"][0]["path"], str(path))
        changed = b"a different file"
        self.assertIn("256 MiB", self.call(dict(self.request, files=[content("changed.txt", changed)]),
                                           changed, ok=False))
        quota.unlink()
        for i in range(4096 - len(list(root.rglob("*")))):
            entry = root / ("entry-" + str(i))
            entry.write_bytes(b"")
            entry.chmod(0o600)
        self.assertEqual(self.call(dict(self.request, files=[content("kept.txt", data)]), data)
                         ["files"][0]["path"], str(path))
        self.assertIn("too many files", self.call(dict(self.request, files=[content("new.txt", changed)]),
                                                  changed, ok=False))
        self.assertEqual(len(list(root.rglob("*"))), 4096)

    def test_tamper_and_symlink_never_overwrite_user_files(self):
        data = b"original"
        path = Path(self.call(dict(self.request, files=[content("a.txt", data)]), data)["files"][0]["path"])
        path.chmod(0o600)
        path.write_bytes(b"tampered")
        self.assertIn("refusing to overwrite", self.call(dict(self.request, files=[content("a.txt", data)]),
                                                         data, ok=False))
        user = self.home / "user-file"
        user.write_bytes(b"leave me alone")
        path.unlink()
        path.symlink_to(user)
        self.call(dict(self.request, files=[content("a.txt", data)]), data, ok=False)
        self.assertEqual(user.read_bytes(), b"leave me alone")

    def test_foreign_owner_and_live_runtime_are_refused(self):
        data = b"owned"
        self.call(dict(self.request, files=[content("a.txt", data)]), data)
        owner = next(self.home.rglob("owner.json"))
        owner.write_text(json.dumps(dict(self.owner, agent="other-agent"), sort_keys=True))
        self.assertIn("owner mismatch", self.call(dict(self.request, files=[content("a.txt", data)]),
                                                  data, ok=False))
        owner.write_text(json.dumps(self.owner, sort_keys=True))
        # A live runtime still holds the cache; the delete waits for it.
        self.assertIn("may still use", self.call(dict(self.owner, op="delete"), ok=False))
        self.assertTrue(self.root().exists())

    def test_delete_removes_the_file_cache_and_an_image_cache(self):
        files = self.call(dict(self.request, files=[content("a.txt", b"file")]), b"file")
        self.assertTrue(Path(files["files"][0]["path"]).exists())
        # A file-only transfer never creates an image cache.
        self.assertFalse((self.base / "image-cache" / self.key()).exists())
        self.stop_runtime()
        self.assertEqual(self.call(dict(self.owner, op="delete")), {"deleted": True})
        self.assertFalse((self.base / "file-cache" / self.key()).exists())
        self.assertEqual(self.call(dict(self.owner, op="delete")), {"deleted": True})

    def test_delete_removes_both_kinds_of_copy(self):
        png = b"\x89PNG\r\n\x1a\n" + b"image"
        digest = hashlib.sha256(png).hexdigest()
        image = dict(id=digest + ".png", sha256=digest, bytes=len(png), mediaType="image/png")
        installed = self.call(dict(self.request, op="install",
                                   scope=dict(session="s", cwd="/work", generation=1),
                                   files=[image]), png)
        image_path = Path(installed["files"][0]["path"])
        data = b"file"
        file_path = Path(self.call(dict(self.request, files=[content("a.txt", data)]), data)
                         ["files"][0]["path"])
        self.stop_runtime()
        self.assertEqual(self.call(dict(self.owner, op="delete")), {"deleted": True})
        self.assertFalse(image_path.exists())
        self.assertFalse(file_path.exists())

    def test_delete_waits_for_a_stopping_runtime(self):
        data = b"file"
        path = Path(self.call(dict(self.request, files=[content("a.txt", data)]), data)["files"][0]["path"])
        stopping = threading.Timer(0.2, self.stop_runtime)
        stopping.start()
        try:
            self.assertEqual(self.call(dict(self.owner, op="delete")), {"deleted": True})
            self.assertFalse(path.exists())
        finally:
            stopping.join()

    def key(self):
        return hashlib.sha256("\0".join(self.owner[k] for k in
            ("workspace", "agent", "machine", "target", "harness")).encode()).hexdigest()

    def test_delete_with_no_runtime_folder_or_cache_succeeds(self):
        # An Agent whose data root was wiped, or whose runtime folder is gone,
        # still deletes when there is nothing to remove (review 95b22f32).
        self.stop_runtime()
        shutil.rmtree(self.runtime)
        self.assertEqual(self.call(dict(self.owner, op="delete")), {"deleted": True})
        self.assertEqual(self.call(dict(self.owner, op="delete")), {"deleted": True})

    def test_copies_go_only_into_the_root_the_request_names(self):
        data = b"file"
        path = Path(self.call(dict(self.request, files=[content("a.txt", data)]), data)["files"][0]["path"])
        self.assertTrue(path.is_relative_to(self.base.resolve()))
        for root in ("~/../outside", "~/a b", "~/missing/.yuzuno", None):
            self.call(dict(self.request, root=root, files=[content("a.txt", data)]), data, ok=False)
        self.assertFalse((self.home / "missing").exists() or (self.home.parent / "outside").exists())


class NestedRoot(Files):
    """A machine whose data root is a folder below its home (lab_host)."""
    ROOT = "~/jobs-lab/.yuzuno"


def only_root_tests(*cases):
    """The other root repeats where copies go, a retry finding them, and
    deleting them."""
    for case in cases:
        for name in dir(Files):
            if name.startswith("test_") and name not in (
                    "test_install_keeps_bytes_and_mode_and_reuses_them",
                    "test_delete_removes_the_file_cache_and_an_image_cache"):
                setattr(case, name, None)


only_root_tests(NestedRoot)


if __name__ == "__main__":
    unittest.main()
