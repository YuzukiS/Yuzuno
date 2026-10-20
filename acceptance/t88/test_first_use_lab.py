"""Guard the guide runner against accidentally installing into real defaults."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from first_use_lab import REPO, install_script


class GuideTest(unittest.TestCase):
    def test_paths_with_shell_metacharacters_are_quoted(self):
        import shlex
        document = (REPO / 'docs/independent-core.md').read_text()
        lab = Path("/tmp/lab space ' $(touch BAD)")
        script = install_script(document, lab, 'core-test')
        self.assertNotIn('~/', script)
        self.assertIn('ROOT=' + shlex.quote(str(lab / 'install')), script)
        self.assertEqual(script.count(shlex.quote(str(lab / 'download'))), 2)
        self.assertIn('minisign -Vm', script)
        self.assertIn('--manifest-sha256', script)

    def test_changed_guide_defaults_are_refused(self):
        document = (REPO / 'docs/independent-core.md').read_text()
        with self.assertRaisesRegex(ValueError, 'path choices'):
            install_script(document.replace('~/yuzuno-download', '~/somewhere-else'), Path('/tmp/lab'), 'core-test')
        with self.assertRaisesRegex(ValueError, 'four installation blocks'):
            install_script(document.replace('4. **Allow later updates**', '```sh\necho unexpected\n```\n4. **Allow later updates**'), Path('/tmp/lab'), 'core-test')


if __name__ == '__main__':
    unittest.main()
