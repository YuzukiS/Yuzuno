"""identity-command.py's command, and that every script parses (python3 test_identity.py).

Windows PowerShell only parses the scripts, given as text on stdin: nothing
runs, no script file is executed and no execution policy is changed. Those
tests are skipped without Windows PowerShell.
"""
import base64
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = load('prepare', 'prepare.py')
composer = load('identity_command', 'identity-command.py')
SHA_OLD, SHA_NEW = 'a' * 64, 'B' * 64
GOOD = (r'C:\t137-lab\out-1', r'C:\t137-lab\in\Yuzuno T137_0.2.0_x64-setup.exe', SHA_OLD,
        r'C:\t137-lab\in\Yuzuno T137_0.2.1_x64-setup.exe', SHA_NEW)

try:
    prepare.powershell('@{ ok = $true } | ConvertTo-Json -Compress')
    HAVE_POWERSHELL = True
except prepare.Refused:
    HAVE_POWERSHELL = False


def parse_errors(text):
    """PowerShell's parser on the text; it is parsed, never run."""
    encoded = base64.b64encode(text.encode('utf-8')).decode()
    return prepare.powershell(
        f"$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}'))\n"
        "$tokens = $null; $errors = $null\n"
        "[void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)\n"
        "@{ errors = @($errors | ForEach-Object { $_.Message }) } | ConvertTo-Json -Compress\n")['errors']


class Command(unittest.TestCase):
    def test_inputs_come_first_then_both_scripts_as_they_are(self):
        result = composer.command(*GOOD)
        argv = result['argv']
        self.assertEqual(argv[:4], ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command'])
        text = argv[4]
        self.assertTrue(text.startswith("$T137Out = 'C:\\t137-lab\\out-1'\n$T137Old = "))
        self.assertIn(f"$T137OldSha256 = '{SHA_OLD}'\n", text)
        self.assertIn(f"$T137NewSha256 = '{SHA_NEW.lower()}'\n", text)
        steps, check = ((HERE / name).read_text(encoding='utf-8') for name in composer.PARTS)
        self.assertLess(text.index(steps), text.index(check))
        self.assertLessEqual(result['bytes'], composer.LIMIT)

    def test_refuses_what_is_not_an_absolute_path_or_a_sha256(self):
        for bad in ('t137-lab\\out', 'C:t137', 'C:\\t137-lab\\..\\Users', 'C:\\t137-lab\\.\\out', '\\\\server\\share\\out',
                    'C:\\out"; Remove-Item C:\\'):
            with self.subTest(path=bad), self.assertRaises(composer.Refused):
                composer.command(bad, *GOOD[1:])
        for bad in ('a' * 63, 'g' * 64, ''):
            with self.subTest(sha256=bad), self.assertRaises(composer.Refused):
                composer.command(GOOD[0], GOOD[1], bad, GOOD[3], GOOD[4])

    def test_a_quote_in_a_path_stays_inside_its_string(self):
        text = composer.command(r"C:\t137-lab\it's", *GOOD[1:])['argv'][4]
        self.assertTrue(text.startswith("$T137Out = 'C:\\t137-lab\\it''s'\n"))

    def test_only_the_test_identitys_paths_are_removed(self):
        check = (HERE / 'identity-check.ps1').read_text(encoding='utf-8')
        # One removal, in the loop over $own, after the guard on each path's name.
        self.assertEqual(check.count('Remove-Item'), 1)
        guard = check.index("-notin $ownLeaves) { throw")
        self.assertLess(check.index('foreach ($name in @($own.Keys))'), guard)
        self.assertLess(guard, check.index('Remove-Item'))
        self.assertIn("$ownLeaves = @($p.product, $identity, \"$($p.product).lnk\")", check)


@unittest.skipUnless(HAVE_POWERSHELL, 'needs Windows PowerShell')
class Parses(unittest.TestCase):
    def test_every_script_and_the_composed_command_parse(self):
        texts = {name: (HERE / name).read_text(encoding='utf-8')
                 for name in ('guest-lib.ps1', 'upgrade-steps.ps1', 'guest-accept.ps1', 'identity-check.ps1')}
        texts['composed command'] = composer.command(*GOOD)['argv'][4]
        texts['composed, a quote in a path'] = composer.command(r"C:\t137-lab\it's", *GOOD[1:])['argv'][4]
        for name, text in texts.items():
            with self.subTest(name):
                self.assertEqual(parse_errors(text), [])

    def test_a_broken_script_does_not_parse(self):
        # The check itself: a missing brace is reported.
        self.assertNotEqual(parse_errors('function Broken { if ($true) {'), [])


if __name__ == '__main__':
    unittest.main()
