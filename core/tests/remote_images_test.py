"""Controlled transport/filesystem tests. No SSH account or model is used."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

HELPER = os.environ["YUZUNO_IMAGE_HELPER"]
PNG = b"\x89PNG\r\n\x1a\n" + b"transport-fixture"
STUB = """
import socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.bind(sys.argv[-1]);s.listen(10)
print('ready',flush=True)
while True:
 c,_=s.accept();c.close()
"""


class Transfers(unittest.TestCase):
    # The Agent's data root, as Core names it in each request.
    ROOT = "~/.yuzuno"

    def setUp(self):
        # macOS's per-user TMPDIR can exceed AF_UNIX's socket path limit.
        # mkdtemp still creates a private, unique fixture directory here.
        self.temp = tempfile.TemporaryDirectory(prefix="images-", dir="/tmp")
        self.home = Path(self.temp.name)
        self.base = self.home / self.ROOT[2:]
        self.base.parent.mkdir(exist_ok=True)
        self.owner = dict(workspace="workspace-a", agent="agent-a", machine="mac-a",
                          target="test@machine", harness="codex")
        self.request = dict(self.owner, op="install", instance="instance-a",
                            scope=dict(session="session-a", cwd="/work", generation=1))
        self.start_runtime()

    def start_runtime(self):
        key = hashlib.sha256(json.dumps([self.owner["workspace"], self.owner["agent"]]).encode()).hexdigest()[:24]
        self.runtime = self.base / ("claude" if self.owner["harness"] == "claude" else "runtimes") / key
        self.runtime.mkdir(mode=0o700, parents=True)
        for path in (self.runtime.parent, self.runtime.parent.parent):
            path.chmod(0o700)
        sock = str(self.runtime / "rpc.sock")
        kind = "remote-host.mjs" if self.owner["harness"] == "claude" else "app-server"
        self.process = subprocess.Popen([sys.executable, "-c", STUB, kind, sock], stdout=subprocess.PIPE, text=True)
        self.assertEqual(self.process.stdout.readline().strip(), "ready")
        identity = subprocess.check_output(["ps", "-p", str(self.process.pid), "-o", "stat=", "-o", "lstart=", "-o", "args="], text=True).strip().split(None, 1)[1]
        meta = dict(pid=self.process.pid, processIdentity=identity, instanceId="instance-a", root=str(self.runtime), socket=sock)
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

    def file(self, data=PNG):
        digest = hashlib.sha256(data).hexdigest()
        return dict(id=digest + ".png", sha256=digest, bytes=len(data), mediaType="image/png")

    def call(self, request=None, bodies=PNG, ok=True):
        request = dict(self.request if request is None else request)
        request.setdefault("root", self.ROOT)
        if request["op"] == "install":
            request.setdefault("files", [self.file()])
        result = subprocess.run([sys.executable, "-c", HELPER],
                                env={**os.environ, "HOME": str(self.home)},
                                input=json.dumps(request).encode() + b"\n" + bodies,
                                capture_output=True, timeout=20)
        self.assertEqual(result.returncode == 0, ok, result.stderr.decode())
        return json.loads(result.stdout) if ok else result.stderr.decode()

    def test_retry_preserves_bytes_and_path_across_sessions(self):
        first = self.call()
        path = Path(first["files"][0]["path"])
        self.assertEqual(path.read_bytes(), PNG)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        before = path.stat().st_mtime_ns
        self.assertEqual(first, self.call())
        self.assertEqual(path.stat().st_mtime_ns, before)
        changed = dict(self.request, scope=dict(session="another-session", cwd="/work", generation=2))
        self.assertEqual(first["files"][0]["path"], self.call(changed)["files"][0]["path"])
        self.assertEqual(path.read_bytes(), PNG)

    def test_reconnect_does_not_accumulate_bytes_or_entries(self):
        path = Path(self.call()["files"][0]["path"])
        root = next(self.home.rglob("owner.json")).parent
        def usage():
            entries = list(root.rglob("*"))
            return len(entries), sum(p.stat().st_size for p in entries if p.is_file())
        before = usage()
        metadata = self.runtime / "runtime.json"
        for generation in range(2, 12):
            instance = "instance-" + str(generation)
            meta = json.loads(metadata.read_text())
            meta["instanceId"] = instance
            metadata.write_text(json.dumps(meta))
            request = dict(self.request, instance=instance,
                           scope=dict(session="session-" + str(generation), cwd="/other", generation=generation))
            self.assertEqual(self.call(request)["files"][0]["path"], str(path))
            self.assertEqual(usage(), before)
            self.assertEqual(path.read_bytes(), PNG)

    def test_truncation_partial_batch_and_retry(self):
        second = PNG + b"2"
        request = dict(self.request, files=[self.file(), self.file(second)])
        self.assertIn("truncated", self.call(request, PNG + second[:-1], ok=False))
        result = self.call(request, PNG + second)
        self.assertEqual([Path(f["path"]).read_bytes() for f in result["files"]], [PNG, second])
        self.assertFalse(list(self.home.rglob(".upload-*")))

    def test_reuses_legacy_scope_without_invalidating_native_paths(self):
        path = Path(self.call()["files"][0]["path"])
        old_scope = path.parents[2]
        legacy_scope = old_scope.with_name("f" * 64)
        old_scope.rename(legacy_scope)
        legacy_path = legacy_scope / "input-images" / self.owner["agent"] / path.name
        request = dict(self.request, scope=dict(session="resumed", cwd="/work", generation=99))
        self.assertEqual(self.call(request)["files"][0]["path"], str(legacy_path))
        self.assertEqual(legacy_path.read_bytes(), PNG)
        self.assertFalse(old_scope.exists())

    def test_full_cache_reuses_content_but_rejects_new_content_and_entries(self):
        path = Path(self.call()["files"][0]["path"])
        root = next(self.home.rglob("owner.json")).parent
        used = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
        quota = root / "quota-fixture"
        with quota.open("wb") as stream:
            stream.truncate(256 * 1024 * 1024 - used)
        quota.chmod(0o600)
        changed = dict(self.request, scope=dict(session="resumed", cwd="/work", generation=99))
        self.assertEqual(self.call(changed)["files"][0]["path"], str(path))
        second = PNG + b"new"
        self.assertIn("256 MiB", self.call(dict(changed, files=[self.file(second)]), second, ok=False))
        quota.unlink()
        for i in range(4096 - len(list(root.rglob("*")))):
            entry = root / ("entry-" + str(i))
            entry.write_bytes(b"")
            entry.chmod(0o600)
        self.assertEqual(self.call(changed)["files"][0]["path"], str(path))
        self.assertIn("too many files", self.call(dict(changed, files=[self.file(second)]), second, ok=False))
        self.assertEqual(len(list(root.rglob("*"))), 4096)

    def test_changed_bytes_or_format_and_foreign_owner_are_refused(self):
        self.assertIn("changed", self.call(bodies=PNG[:-1] + b"!", ok=False))
        self.assertIn("format", self.call(dict(self.request, files=[dict(self.file(), mediaType="image/jpeg")]), ok=False))
        self.call()
        owner = next(self.home.rglob("owner.json"))
        owner.write_text(json.dumps(dict(self.owner, agent="other-agent"), sort_keys=True))
        self.assertIn("owner mismatch", self.call(ok=False))

    def test_count_size_total_and_duplicate_limits(self):
        for files in [[], [self.file()] * 9, [self.file(), self.file()],
                      [dict(self.file(), bytes=10 * 1024 * 1024 + 1)]]:
            self.call(dict(self.request, files=files), b"", ok=False)
        files = [dict(self.file(), id=str(i) * 64 + ".png", sha256=str(i) * 64, bytes=10 * 1024 * 1024) for i in range(5)]
        self.assertIn("40 MiB", self.call(dict(self.request, files=files), b"", ok=False))

    def test_tamper_and_symlink_never_overwrite_user_files(self):
        path = Path(self.call()["files"][0]["path"])
        path.write_bytes(b"tampered")
        self.assertIn("refusing to overwrite", self.call(ok=False))
        user = self.home / "user-file"
        user.write_bytes(b"leave me alone")
        path.unlink()
        path.symlink_to(user)
        self.call(ok=False)
        self.assertEqual(user.read_bytes(), b"leave me alone")

    def test_invalid_path_runtime_and_target_are_refused(self):
        self.call(dict(self.request, files=[dict(self.file(), id="../../user-file")]), ok=False)
        self.assertIn("runtime changed", self.call(dict(self.request, instance="old-instance"), ok=False))
        self.call(dict(self.request, agent="other-agent"), ok=False)
        first = self.call()
        other = self.call(dict(self.request, machine="another-machine", target="other@host"))
        self.assertNotEqual(first["files"][0]["path"], other["files"][0]["path"])

    def test_quota_and_abandoned_temporary_recovery(self):
        self.call()
        root = next(self.home.rglob("owner.json")).parent
        abandoned = root / (".upload-" + "a" * 32)
        abandoned.write_bytes(b"incomplete")
        abandoned.chmod(0o600)
        self.call()
        self.assertFalse(abandoned.exists())
        quota = root / "quota-fixture"
        with quota.open("wb") as stream:
            stream.truncate(256 * 1024 * 1024)
        quota.chmod(0o600)
        second = PNG + b"new"
        self.assertIn("256 MiB", self.call(dict(self.request, files=[self.file(second)]), second, ok=False))

    def test_delete_refuses_live_runtime_and_preserves_other_files(self):
        first = self.call()
        path = Path(first["files"][0]["path"])
        delete = dict(self.owner, op="delete")
        self.assertIn("may still use images", self.call(delete, b"", ok=False))
        self.assertTrue(path.exists())
        user = self.home / "user-image.png"
        user.write_bytes(PNG)
        self.stop_runtime()
        self.assertEqual(self.call(delete, b""), {"deleted": True})
        self.assertFalse(path.exists())
        self.assertEqual(user.read_bytes(), PNG)
        self.assertEqual(self.call(delete, b""), {"deleted": True})

    def test_claude_copy_keeps_original_id_and_has_lower_budget(self):
        self.stop_runtime()
        self.owner["harness"] = "claude"
        self.request["harness"] = "claude"
        self.start_runtime()
        reference = dict(self.file(), id="f" * 64 + ".jpg")
        response = self.call(dict(self.request, files=[reference]))
        self.assertTrue(response["files"][0]["path"].endswith(reference["id"]))
        self.call(dict(self.request, files=[dict(reference, bytes=512001)]), b"", ok=False)

    def test_delete_waits_for_detached_runtime_to_finish_stopping(self):
        path = Path(self.call()["files"][0]["path"])
        stopping = threading.Timer(0.2, self.stop_runtime)
        stopping.start()
        try:
            self.assertEqual(self.call(dict(self.owner, op="delete"), b""), {"deleted": True})
            self.assertFalse(path.exists())
        finally:
            stopping.join()

    def test_claude_reuses_actual_send_bytes_and_retains_prior_variants(self):
        self.stop_runtime()
        self.owner["harness"] = "claude"
        self.request["harness"] = "claude"
        self.start_runtime()
        original_id = "f" * 64 + ".jpg"
        def send(data, generation):
            return self.call(dict(self.request,
                scope=dict(session="resumed", cwd="/work", generation=generation),
                files=[dict(self.file(data), id=original_id)]), data)["files"][0]["path"]
        first = Path(send(PNG, 1))
        second = Path(send(PNG + b"different-fit", 2))
        self.assertNotEqual(first, second)
        self.assertEqual(first.read_bytes(), PNG)
        self.assertEqual(second.read_bytes(), PNG + b"different-fit")
        root = next(self.home.rglob("owner.json")).parent
        entries = set(root.rglob("*"))
        self.assertEqual(send(PNG, 3), str(first))
        self.assertEqual(send(PNG + b"different-fit", 4), str(second))
        self.assertEqual(set(root.rglob("*")), entries)

    def interrupted_owner_cache(self):
        key = hashlib.sha256("\0".join(self.owner[k] for k in
            ("workspace", "agent", "machine", "target", "harness")).encode()).hexdigest()
        root = self.base / "image-cache" / key
        root.mkdir(mode=0o700, parents=True)
        root.parent.chmod(0o700)
        return root

    def test_delete_recovers_interrupted_owner_record_creation(self):
        self.stop_runtime()
        for names in [[], ["lock"], ["lock", ".upload-" + "a" * 32]]:
            root = self.interrupted_owner_cache()
            for name in names:
                path = root / name
                path.write_bytes(b"partial owner" if name.startswith(".upload-") else b"")
                path.chmod(0o600)
            self.assertEqual(self.call(dict(self.owner, op="delete"), b""), {"deleted": True})
            self.assertFalse(root.exists())

    def test_missing_owner_never_allows_deleting_unknown_content(self):
        root = self.interrupted_owner_cache()
        temporary = root / (".upload-" + "a" * 32)
        temporary.write_bytes(b"partial owner")
        temporary.chmod(0o600)
        foreign = root / "unknown.png"
        foreign.write_bytes(PNG)
        foreign.chmod(0o600)
        self.stop_runtime()
        self.call(dict(self.owner, op="delete"), b"", ok=False)
        self.assertEqual(foreign.read_bytes(), PNG)
        self.assertEqual(temporary.read_bytes(), b"partial owner")
        foreign.unlink()
        foreign.mkdir(mode=0o700)
        self.call(dict(self.owner, op="delete"), b"", ok=False)
        self.assertTrue(foreign.is_dir())
        self.assertEqual(temporary.read_bytes(), b"partial owner")
        foreign.rmdir()
        outside = self.home / "user-file"
        outside.write_bytes(PNG)
        temporary.unlink()
        temporary.symlink_to(outside)
        self.call(dict(self.owner, op="delete"), b"", ok=False)
        self.assertEqual(outside.read_bytes(), PNG)

    def test_copies_go_only_into_the_root_the_request_names(self):
        path = Path(self.call()["files"][0]["path"])
        self.assertEqual(path.parts[-7:-5], (self.base.name, "image-cache"))
        self.assertTrue(path.is_relative_to(self.base.resolve()))
        self.assertEqual([p.name for p in self.home.iterdir()], [self.base.relative_to(self.home).parts[0]])
        for root in ("~/../outside", "~/a b", "~/missing/.yuzuno", None):
            request = dict(self.request, root=root)
            self.call(request, ok=False)
        self.assertFalse((self.home / "missing").exists() or (self.home.parent / "outside").exists())


class LegacyRoot(Transfers):
    """An Agent from before data roots keeps its copies where they were."""
    ROOT = "~/.yuzuno-next"


class NestedRoot(Transfers):
    """A machine whose data root is a folder below its home (lab_host)."""
    ROOT = "~/jobs-lab/.yuzuno"


def only_root_tests(*cases):
    """The other roots repeat what depends on where the root is: copies, a
    retry finding them, and deleting them."""
    for case in cases:
        for name in dir(Transfers):
            if name.startswith("test_") and name not in (
                    "test_copies_go_only_into_the_root_the_request_names",
                    "test_retry_preserves_bytes_and_path_across_sessions",
                    "test_delete_recovers_interrupted_owner_record_creation"):
                setattr(case, name, None)


only_root_tests(LegacyRoot, NestedRoot)


unittest.main()
