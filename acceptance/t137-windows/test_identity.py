"""identity-command.py's command, that every script parses, and the shared
name check and snapshot (python3 test_identity.py).

Windows PowerShell gets the scripts as text on stdin: no script file is
executed and no execution policy is changed. The parse tests only parse.
The name tests run Test-Named and Snapshot on made-up names and made-up
folders, never a real place or registry key; install, uninstall and cleanup
never run. Those tests are skipped without Windows PowerShell.
"""
import base64
import importlib.util
import json
import shutil
import subprocess
import tempfile
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
        guard = check.index("-notin $ExactNames) { throw")
        self.assertLess(check.index('foreach ($name in @($own.Keys))'), guard)
        self.assertLess(guard, check.index('Remove-Item'))
        self.assertIn("$ExactNames = @($p.product, $identity, \"$($p.product).lnk\")", check)


def windows_path(path):
    """A WSL path as Windows reaches it (\\\\wsl.localhost\\...)."""
    return subprocess.run(['wslpath', '-w', str(path)], capture_output=True, text=True, check=True).stdout.strip()


HAVE_WSLPATH = shutil.which('wslpath') is not None
STEPS = (HERE / 'upgrade-steps.ps1').read_text(encoding='utf-8')
EXACT = "$ExactNames = @('Yuzuno T137', 'dev.yuzuno.workspace.t137', 'Yuzuno T137.lnk')\n"


def run_steps(body):
    """upgrade-steps.ps1's definitions, then body; only pure functions and reads."""
    encoded = base64.b64encode((STEPS + '\n' + body).encode('utf-8')).decode()
    return prepare.powershell(
        f"$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}'))\n"
        ". ([scriptblock]::Create($text))\n")


@unittest.skipUnless(HAVE_POWERSHELL, 'needs Windows PowerShell')
class Names(unittest.TestCase):
    """Only the test identity's exact names are its own (T-137: two leftover
    folders named dev.yuzuno.workspace.t137old/new stopped a run)."""

    def named(self, names, exact=True):
        prefix = EXACT if exact else "$Names = 'yuzuno'\n"
        return run_steps(prefix + f"@($('{json.dumps(names)}' | ConvertFrom-Json) | ForEach-Object {{ [ordered]@{{ name = $_; named = (Test-Named $_) }} }}) | ConvertTo-Json -Compress")

    def test_exact_names_ignore_case_and_nothing_else_of_the_family(self):
        own = ['Yuzuno T137', 'yuzuno t137', 'dev.yuzuno.workspace.t137', 'DEV.YUZUNO.WORKSPACE.T137', 'Yuzuno T137.lnk']
        others = ['dev.yuzuno.workspace.t137old', 'dev.yuzuno.workspace.t137new', 'Yuzuno T1370', 'Yuzuno T137 (old)',
                  'xYuzuno T137', 'Yuzuno T137.lnk.bak', 'Yuzuno', 'Yuzuno Lab', 'dev.yuzuno.workspace', 'Yuzuno T148']
        seen = {r['name']: r['named'] for r in self.named(own + others)}
        self.assertEqual({n for n, v in seen.items() if v}, set(own))

    def test_the_guest_still_counts_anything_named_like_yuzuno(self):
        seen = {r['name']: r['named'] for r in self.named(['dev.yuzuno.workspace.t137old', 'Yuzuno Lab', 'Other'], exact=False)}
        self.assertEqual(seen, {'dev.yuzuno.workspace.t137old': True, 'Yuzuno Lab': True, 'Other': False})

    @unittest.skipUnless(HAVE_WSLPATH, 'needs wslpath')
    def test_a_snapshot_finds_the_identity_and_not_its_neighbours(self):
        # Made-up folders and keys (folders standing in for keys); no real place or registry is read.
        with tempfile.TemporaryDirectory() as tmp:
            local, keys = Path(tmp, 'local'), Path(tmp, 'keys')
            for d in ('dev.yuzuno.workspace.t137old', 'dev.yuzuno.workspace.t137new', 'Yuzuno Lab'):
                (local / d).mkdir(parents=True)
            (keys / 'yuzuno' / 'Yuzuno T137old').mkdir(parents=True)
            (keys / 'yuzuno' / 'Yuzuno Lab').mkdir(parents=True)
            fake = (f"$places = @('{windows_path(local)}'); $keyRoot = '{windows_path(keys)}'; $uninstallKeys = @()\n"
                    "$p = [pscustomobject]@{ product = 'Yuzuno T137' }\n")
            snapshot = "Snapshot | ConvertTo-Json -Compress\n"
            # Neighbours only: nothing is the identity's, so the run would not refuse.
            clear = run_steps(EXACT + fake + snapshot)
            self.assertEqual((clear['files'], clear['keys'], clear['entries']), ([], [], []))
            # The identity's own folder and key exist: both are found, so the run refuses.
            (local / 'Yuzuno T137').mkdir()
            (local / 'dev.yuzuno.workspace.t137').mkdir()
            (keys / 'yuzuno' / 'Yuzuno T137').mkdir()
            found = run_steps(EXACT + fake + snapshot)
            self.assertEqual(sorted(Path(f.replace('\\', '/')).name for f in found['files']),
                             ['Yuzuno T137', 'dev.yuzuno.workspace.t137'])
            self.assertEqual([Path(k.replace('\\', '/')).name for k in found['keys']], ['Yuzuno T137'])


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
