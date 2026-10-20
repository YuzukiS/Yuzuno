"""CLI preflight must work with safe imports and reject before creating a lab."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('cross-machine-lab.py')


class CrossMachinePreflightTest(unittest.TestCase):
    def test_help_with_safe_path(self):
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), '--help'],
                                capture_output=True, text=True,
                                env=dict(os.environ, PYTHONSAFEPATH='1'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--mac', result.stdout)

    def test_invalid_inputs_do_not_start_or_create_lab(self):
        with tempfile.TemporaryDirectory() as directory:
            lab = Path(directory)/'lab'
            report = Path(directory)/'report.json'
            args = [sys.executable, '-B', str(SCRIPT), '--lab', str(lab), '--report', str(report),
                    '--tag', 'core-probe', '--public-key', 'unused', '--minisign', '/bin/true',
                    '--node', '/bin/true', '--sshd', '/bin/true', '--mac', 'test@example.invalid',
                    '--linux-host', '192.168.1.10', '--port', '4611', '--ssh-port', '4612',
                    '--mac-port', '5611', '--cdp-port', '9611']
            cases = [('--mac', '-option@example.invalid', 'authorized user@host'),
                     ('--tag', '--option', 'explicit release tag'),
                     ('--linux-host', '8.8.8.8', 'private/CGNAT'),
                     ('--cdp-port', '4611', 'four distinct')]
            for flag, value, expected in cases:
                with self.subTest(flag=flag):
                    current = args.copy()
                    index = current.index(flag)
                    current[index:index+2] = [flag+'='+value]
                    result = subprocess.run(current, capture_output=True, text=True,
                                            env=dict(os.environ, PYTHONSAFEPATH='1'))
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn(expected, result.stderr)
                    self.assertFalse(lab.exists())
                    self.assertFalse(report.exists())


if __name__ == '__main__':
    unittest.main()
