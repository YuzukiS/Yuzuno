"""Small harness safety checks; these do not claim product acceptance."""
import io
import os
import signal
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from lab_environment import authenticated_environment
from package_lab import Lab, LabInterrupted, check_port_available, extract_bundle, interrupt, main, owns_listener


class PackageLabTests(unittest.TestCase):
    def test_authenticated_environment_preserves_login_without_shell_overrides(self):
        inherited = {'HOME': '/users/operator', 'GH_TOKEN': 'test-token', 'LANG': 'old',
                     'OLDPWD': '/checkout', 'VIRTUAL_ENV': '/checkout/venv', 'PATH': '/checkout/bin',
                     'YUZUNO_DATA_DIR': '/daily-data', 'HTTP_PROXY': 'http://proxy'}
        env = authenticated_environment(inherited, '/lab/tools', '/tools/node/bin')
        self.assertEqual(env['HOME'], '/users/operator')
        self.assertEqual(env['GH_TOKEN'], 'test-token')
        self.assertEqual(set(env), {'HOME', 'GH_TOKEN', 'LANG', 'PATH'})
        self.assertNotIn('/checkout', ':'.join(env.values()))
        self.assertEqual(inherited['PATH'], '/checkout/bin')

    def test_stop_signal_escapes_health_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            lab = Lab(SimpleNamespace(lab=Path(temp), package_dir=Path(temp), port=4567))
            lab.release = 'test'
            previous = signal.signal(signal.SIGTERM, interrupt)
            try:
                with patch('package_lab.check_port_available'), patch('package_lab.owns_listener', return_value=True), \
                     patch('package_lab.subprocess.Popen') as spawn, patch.object(lab, 'request') as request:
                    spawn.return_value.poll.return_value = None
                    request.side_effect = lambda *_: signal.raise_signal(signal.SIGTERM)
                    with self.assertRaises(LabInterrupted):
                        lab.start('signal')
                    request.assert_called_once_with('/api/health')
            finally:
                signal.signal(signal.SIGTERM, previous)

    def test_rootfs_runner_rejects_lab_inside_package_before_launch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'rootfs').mkdir()
            (root/'package').mkdir()
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('rootfs-lab.py')),
                                     '--rootfs', str(root/'rootfs'), '--package-dir', str(root/'package'),
                                     '--lab', str(root/'package/lab'), '--port', '4567', '--tag', 'test',
                                     '--public-key', 'unused', '--bwrap', '/bin/false'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('package and lab must not overlap', result.stderr)
            self.assertFalse((root/'package/lab').exists())

    def test_rejects_unsafe_archive_before_writing_any_member(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE),
                           ('link', tarfile.SYMTYPE), ('link', tarfile.LNKTYPE), ('fifo', tarfile.FIFOTYPE)]:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                archive = root/'bundle.tar.gz'
                with tarfile.open(archive, 'w:gz') as bundle:
                    good = tarfile.TarInfo('safe')
                    good.size = 2
                    bundle.addfile(good, io.BytesIO(b'ok'))
                    bad = tarfile.TarInfo(name)
                    bad.type, bad.linkname = kind, '../escape'
                    bundle.addfile(bad)
                with self.assertRaises(ValueError):
                    extract_bundle(archive, root/'unpacked')
                self.assertFalse((root/'unpacked').exists())

    def test_extracts_regular_executable_and_refuses_existing_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root/'bundle.tar.gz'
            with tarfile.open(archive, 'w:gz') as bundle:
                member = tarfile.TarInfo('bin/program')
                member.mode, member.size = 0o755, 2
                bundle.addfile(member, io.BytesIO(b'ok'))
            extract_bundle(archive, root/'unpacked')
            self.assertEqual((root/'unpacked/bin/program').read_bytes(), b'ok')
            self.assertTrue((root/'unpacked/bin/program').stat().st_mode & 0o100)
            with self.assertRaises(FileExistsError):
                extract_bundle(archive, root/'unpacked')

    def test_rejects_existing_or_dangling_lab_without_running_verifier(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            link = root/'link'
            link.symlink_to(root/'absent')
            with patch('package_lab.subprocess.run') as run:
                for path in (root, link):
                    with self.assertRaises(SystemExit) as exit:
                        main(['--package-dir', temp, '--lab', str(path), '--port', '4567',
                              '--tag', 'test', '--public-key', 'unused'])
                    self.assertEqual(exit.exception.code, 2)
                run.assert_not_called()

    def test_busy_port_cannot_start_or_contact_another_core(self):
        with tempfile.TemporaryDirectory() as temp, socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            port = listener.getsockname()[1]
            self.assertTrue(owns_listener(os.getpid(), port))
            self.assertFalse(owns_listener(999999999, port))
            args = SimpleNamespace(lab=Path(temp), package_dir=Path(temp), port=port)
            lab = Lab(args)
            with patch('package_lab.subprocess.Popen') as spawn:
                with self.assertRaises(OSError):
                    lab.start('occupied')
                spawn.assert_not_called()
            with patch.object(lab.opener, 'open') as request:
                with self.assertRaises(RuntimeError):
                    lab.request('/api/projects', {'name': 'must not send'})
                request.assert_not_called()

    def test_closed_server_time_wait_allows_restart(self):
        with socket.socket() as server, socket.socket() as client:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(('127.0.0.1', 0))
            server.listen()
            port = server.getsockname()[1]
            client.settimeout(2)
            client.connect(('127.0.0.1', port))
            accepted, _ = server.accept()
            accepted.close()  # The server actively closes: TIME_WAIT on its port.
            self.assertEqual(client.recv(1), b'')
        with socket.socket() as naive_probe:
            with self.assertRaises(OSError):
                naive_probe.bind(('127.0.0.1', port))
        check_port_available(port)


if __name__ == '__main__':
    unittest.main()
