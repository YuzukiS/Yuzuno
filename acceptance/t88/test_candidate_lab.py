"""The final-candidate entry's own rules; these do not claim product acceptance."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import candidate_lab
from candidate_lab import (ASSETS, core_quote, descriptor_mismatches, file_mismatches, guide_mismatches,
                           link_tools, load_spec, manager_group, sign_in_environment, sign_in_findings)
from first_use_lab import REPO, guide_release_source
import first_use_lab
from package_lab import sha256

GUIDE = (REPO / 'docs/independent-core.md').read_text()
KEY = 'RWSX8DdJd8/UQ/CyT737AvEnpKM3vpI4npuO1aMf6h1Tx+e40VVWG03r'


def spec(**changes):
    value = {'repository': 'YuzukiS/Yuzuno', 'tag': 'core-20261019-f5626f7', 'publicKey': KEY,
             'sourceSha': 'f' * 40, 'manifestSha256': 'a' * 64, 'assets': {name: 'b' * 64 for name in ASSETS}}
    value.update(changes)
    return value


def with_gh_line(line):
    """The guide with its `gh` prerequisite replaced, whatever it says now."""
    changed, count = re.subn(r'^- \*\*`gh`\*\*.*$', lambda _: line, GUIDE, flags=re.M)
    assert count == 1, 'the guide has no single gh prerequisite line'
    return changed


def refused(argv):
    """main's argument errors: exit status 2 and the message."""
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr), self_raises(SystemExit) as caught:
        candidate_lab.main(argv)
    return caught.exception.code, stderr.getvalue()


class self_raises(contextlib.AbstractContextManager):
    def __init__(self, kind):
        self.kind, self.exception = kind, None

    def __exit__(self, kind, value, _traceback):
        if kind is None or not issubclass(kind, self.kind):
            raise AssertionError(f'{self.kind.__name__} not raised')
        self.exception = value
        return True


class GuideTests(unittest.TestCase):
    def test_reads_the_guides_repository_key_and_update_source(self):
        # The guide's gh prerequisite names no repository since it went public:
        # any GitHub account can read it.
        self.assertEqual(guide_release_source(GUIDE), {
            'downloadRepository': 'YuzukiS/Yuzuno', 'publicKey': KEY,
            'updateRepository': 'YuzukiS/Yuzuno', 'readAccessRepository': None})
        self.assertEqual(guide_mismatches(spec(), guide_release_source(GUIDE)), [])

    def test_another_repository_or_key_is_named_for_each_place(self):
        problems = guide_mismatches(spec(repository='someone/public-yuzuno'), guide_release_source(GUIDE))
        self.assertEqual([p.split(' is ')[0] for p in problems],
                         ["the guide's downloadRepository", "the guide's updateRepository"])
        other_key = 'RW' + 'A' * 54
        self.assertEqual(len(guide_mismatches(spec(publicKey=other_key), guide_release_source(GUIDE))), 1)

    def test_both_prerequisite_wordings_name_the_repository(self):
        for line in ['- **`gh`**, signed in (`gh auth login`) to an account that can read `YuzukiS/Yuzuno`, for the download.',
                     '- **`gh`**, signed in (`gh auth login`), for the download. While the repository is private, the '
                     'account must be able to read `YuzukiS/Yuzuno`. Once it is public, any GitHub account should do.']:
            with self.subTest(line=line[:60]):
                guide = guide_release_source(with_gh_line(line))
                self.assertEqual(guide['readAccessRepository'], 'YuzukiS/Yuzuno')
                self.assertEqual(len(guide_mismatches(spec(repository='someone/public-yuzuno'), guide)), 3)

    def test_a_prerequisite_without_a_repository_is_not_a_mismatch(self):
        guide = guide_release_source(with_gh_line('- **`gh`**, signed in (`gh auth login`) to any GitHub account.'))
        self.assertIsNone(guide['readAccessRepository'])
        self.assertEqual(guide_mismatches(spec(), guide), [])

    def test_a_missing_or_doubled_line_reads_as_none(self):
        doubled = GUIDE.replace('   KEY=' + KEY, '   KEY=' + KEY + '\n   KEY=' + KEY)
        self.assertIsNone(guide_release_source(doubled)['publicKey'])
        self.assertTrue(guide_mismatches(spec(), guide_release_source(doubled)))


class SpecTests(unittest.TestCase):
    def test_accepts_a_complete_spec(self):
        self.assertEqual(load_spec(json.dumps(spec(note='stand-in'))), spec(note='stand-in'))

    def test_refuses_missing_malformed_and_unknown_fields(self):
        for value, expected in [
            ({k: v for k, v in spec().items() if k != 'sourceSha'}, 'sourceSha is missing'),
            (spec(publicKey='RWshort'), 'publicKey is missing or malformed'),
            (spec(repository='no-slash'), 'repository is missing or malformed'),
            (spec(assets={ASSETS[0]: 'b' * 64}), 'assets must map exactly'),
            (spec(assets={**spec()['assets'], ASSETS[1]: 'B' * 64}), 'assets must map exactly'),
            (spec(mirror='https://example.invalid'), 'unknown fields: mirror'),
        ]:
            with self.subTest(expected=expected), self.assertRaisesRegex(ValueError, expected):
                load_spec(json.dumps(value))


class FileTests(unittest.TestCase):
    def test_files_must_be_exactly_the_candidates(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            for name in ASSETS:
                (folder / name).write_bytes(name.encode())
            exact = spec(assets={name: sha256(folder / name) for name in ASSETS})
            self.assertEqual(file_mismatches(exact, folder), [])
            (folder / ASSETS[0]).write_bytes(b'changed')
            (folder / ASSETS[2]).unlink()
            problems = file_mismatches(exact, folder)
            self.assertEqual(len(problems), 2)
            self.assertIn(f'{ASSETS[0]} has SHA-256 {sha256(folder / ASSETS[0])}', problems[0])
            self.assertEqual(problems[1], f'{ASSETS[2]} is missing')

    def test_signed_descriptor_must_name_the_candidate(self):
        signed = {'tag': 'core-20261019-f5626f7', 'repository': 'YuzukiS/Yuzuno',
                  'manifest': {'gitSha': 'f' * 40}, 'manifestSha256': 'a' * 64}
        self.assertEqual(descriptor_mismatches(spec(), signed), [])
        problems = descriptor_mismatches(spec(), {**signed, 'repository': 'other/repo', 'manifest': {}})
        self.assertEqual([p.split(' is ')[0] for p in problems], ['the signed repository', 'the signed sourceSha'])


def host_check(profile, state='signedOut', folder=None, executable='/home/u/.local/bin/claude'):
    """The shape Core's POST /api/machines/local/check returns (core/src/machines.rs)."""
    folder = str(profile) if folder is None else folder
    claude = {'harness': 'claude', 'supported': True, 'found': state != 'signedOut', 'executable': executable,
              'version': '2.1.295 (Claude Code)', 'signIn': {'state': state, 'method': 'none', 'folder': folder}}
    if state == 'signedOut':
        claude['error'] = (
            'Claude Code on the Core host (labhost) is not signed in for Core: `claude auth status`, run as Core runs '
            'it, reports not logged in (auth method: none). Sign in on labhost as the user Core runs as, in its '
            f"configuration folder {folder} (Core's CLAUDE_CONFIG_DIR): for example "
            f'`CLAUDE_CONFIG_DIR={core_quote(str(profile))} {core_quote(executable)} auth login`, or another method '
            "from Claude Code's authentication guide. Then check the machine again.")
    return {'machineId': 'local', 'reachable': True, 'host': {'hostname': 'labhost', 'platform': 'Linux', 'home': '/home/u'},
            'harnesses': [{'harness': 'codex', 'supported': True, 'found': False}, claude]}


class SignInTests(unittest.TestCase):
    profile = Path('/lab/new candidate/claude-profile')
    chosen = '/home/u/.local/bin/claude'

    def test_signed_out_check_with_folder_and_command_passes(self):
        findings = sign_in_findings(host_check(self.profile), self.profile, self.chosen)
        self.assertEqual([ok for _, ok, _ in findings], [True] * 5)

    def test_signed_in_unknown_other_folder_or_no_tip_fail(self):
        for check, failing in [
            (host_check(self.profile, state='signedIn'), [1, 3]),
            (host_check(self.profile, state='unknown'), [1, 3]),
            (host_check(self.profile, folder='/home/u/.claude'), [2]),
            ({**host_check(self.profile), 'host': {}}, [3]),
            ({'harnesses': []}, [0, 1, 2, 3, 4]),
            (host_check(self.profile, executable='/usr/bin/claude'), [4]),
        ]:
            with self.subTest(check=check.get('harnesses', [{}])[-1:]):
                findings = sign_in_findings(check, self.profile, self.chosen)
                self.assertEqual([i for i, (_, ok, _) in enumerate(findings) if not ok], failing)

    def test_linked_installs_are_found_by_name_as_given(self):
        """npm's and the native installer's claude are links to a file with
        another name; Core must still find `claude`, and that very file."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'pkg').mkdir()
            (root / 'pkg/cli.js').write_text('#!/usr/bin/env node\n')
            (root / 'pkg/cli.js').chmod(0o755)
            (root / 'bin').mkdir()
            (root / 'bin/claude').symlink_to(root / 'pkg/cli.js')
            (root / 'node-22').write_text('')
            (root / 'node-22').chmod(0o755)
            tools = link_tools(root / 'lab-bin', root / 'node-22', root / 'bin/claude')
            found = shutil.which('claude', path=str(tools))
            self.assertEqual(found, str(tools / 'claude'))
            self.assertEqual(os.path.realpath(found), str((root / 'pkg/cli.js').resolve()))
            self.assertEqual(os.path.realpath(shutil.which('node', path=str(tools))), str((root / 'node-22').resolve()))
            self.assertEqual(sorted(p.name for p in tools.iterdir()), ['claude', 'node'])

    def test_node_and_claude_must_be_absolute_executables(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'spec.json'
            path.write_text(json.dumps(spec()))
            (Path(temp) / 'plain').write_text('')
            common = ['sign-in', '--spec', str(path), '--report', str(Path(temp) / 'r.json'), '--package-dir', temp,
                      '--minisign', '/bin/true', '--lab', str(Path(temp) / 'lab'), '--port', '4599']
            for node, claude, name in [('bin/true', '/bin/true', 'node'), ('/bin/true', str(Path(temp) / 'plain'), 'claude')]:
                with self.subTest(name=name):
                    code, message = refused(common + ['--node', node, '--claude', claude])
                    self.assertIn(f'--{name} must be the absolute path of an executable', message)
            self.assertFalse((Path(temp) / 'lab').exists())

    def test_environment_keeps_home_and_passes_no_sign_in_variables(self):
        inherited = {'HOME': '/home/u', 'USER': 'u', 'ANTHROPIC_API_KEY': 'k', 'CLAUDE_CODE_OAUTH_TOKEN': 't',
                     'CLAUDE_CONFIG_DIR': '/home/u/.claude', 'YUZUNO_DATA_DIR': '/daily', 'HTTPS_PROXY': 'http://p'}
        env = sign_in_environment(inherited, Path('/lab'), Path('/lab/bin'))
        self.assertEqual(env['HOME'], '/home/u')
        self.assertEqual(env['CLAUDE_CONFIG_DIR'], '/lab/claude-profile')
        self.assertEqual(env['PATH'], '/lab/bin:/usr/local/bin:/usr/bin:/bin')
        for name in ('ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'YUZUNO_DATA_DIR', 'HTTPS_PROXY'):
            self.assertNotIn(name, env)
        self.assertTrue(all(v.startswith('/lab/') for k, v in env.items() if k.startswith('XDG_') or k == 'TMPDIR'))


class JobsHostTests(unittest.TestCase):
    def test_the_user_manager_group_is_found_from_a_job_or_session(self):
        job = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/yuzuno-job-1.service\n'
        self.assertEqual(manager_group(job), '/user.slice/user-1000.slice/user@1000.service')
        self.assertEqual(manager_group('0::/user.slice/user-7.slice/user@7.service\n'), '/user.slice/user-7.slice/user@7.service')
        for other in ['0::/user.slice/user-1000.slice/session-3.scope\n', '0::/system.slice/x.service\n',
                      '0::/user.slice/user-1000.slice/user@1001.service/app.slice\n', '']:
            with self.subTest(other=other):
                self.assertIsNone(manager_group(other))


class EntryTests(unittest.TestCase):
    def test_stage_needs_are_refused_before_anything_is_made(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'spec.json'
            path.write_text(json.dumps(spec()))
            code, message = refused(['sign-in', '--spec', str(path), '--report', str(Path(temp) / 'r.json')])
            self.assertEqual(code, 2)
            self.assertIn('sign-in needs --package-dir, --minisign, --lab, --port, --node, --claude', message)
            inside = REPO / 'target/t88-candidate-test-lab'
            code, message = refused(['package', '--spec', str(path), '--report', str(Path(temp) / 'r.json'),
                                     '--package-dir', temp, '--minisign', '/bin/true', '--lab', str(inside),
                                     '--port', '4599'])
            self.assertIn('--lab must be a new absolute folder outside the checkout', message)
            self.assertFalse(inside.exists())
            (Path(temp) / 'r.json').write_text('{}')
            code, message = refused(['check', '--spec', str(path), '--report', str(Path(temp) / 'r.json')])
            self.assertIn('--report must be a new file', message)

    def test_check_stage_reports_a_guide_mismatch_and_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            path, report = Path(temp) / 'spec.json', Path(temp) / 'report.json'
            path.write_text(json.dumps(spec(repository='someone/public-yuzuno')))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(candidate_lab.main(['check', '--spec', str(path), '--report', str(report)]), 1)
            result = json.loads(report.read_text())
            self.assertFalse(result['passed'])
            self.assertEqual(len(result['checks'][0]['mismatches']), 2)
            self.assertEqual(result['specSha256'], sha256(path))

    def test_check_stage_passes_for_the_guides_own_release_source(self):
        with tempfile.TemporaryDirectory() as temp:
            path, report = Path(temp) / 'spec.json', Path(temp) / 'report.json'
            path.write_text(json.dumps(spec()))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(candidate_lab.main(['check', '--spec', str(path), '--report', str(report)]), 0)
            self.assertTrue(json.loads(report.read_text())['passed'])


class FirstUseStageTests(unittest.TestCase):
    def run_stage(self, temp, signed):
        """first_use with the inner workflow stood in: it 'downloads' files
        whose digests the spec holds, with this descriptor, and passes."""
        lab, report = Path(temp) / 'lab', Path(temp) / 'report.json'

        def workflow(command, **_):
            (lab / 'download').mkdir(parents=True)
            (lab / 'download' / ASSETS[0]).write_bytes(b'archive')
            (lab / 'download' / ASSETS[1]).write_text(json.dumps(signed))
            (lab / 'download' / ASSETS[2]).write_bytes(b'signature')
            Path(command[command.index('--report') + 1]).write_text('{"passed": true}')
            return SimpleNamespace(returncode=0)
        args = SimpleNamespace(report=report, lab=lab, minisign=Path('/m'), node=Path('/n'), browser=Path('/b'),
                               port=4599, doc=REPO / 'docs/independent-core.md')
        record = candidate_lab.Record()
        digests = {ASSETS[0]: hashlib.sha256(b'archive').hexdigest(),
                   ASSETS[1]: hashlib.sha256(json.dumps(signed).encode()).hexdigest(),
                   ASSETS[2]: hashlib.sha256(b'signature').hexdigest()}
        with patch('candidate_lab.subprocess.run', side_effect=workflow), contextlib.redirect_stdout(io.StringIO()):
            candidate_lab.first_use(args, spec(assets=digests), record)
        return record

    def test_the_downloaded_descriptor_must_name_the_candidate(self):
        signed = {'tag': 'core-20261019-f5626f7', 'repository': 'YuzukiS/Yuzuno',
                  'manifest': {'gitSha': 'f' * 40}, 'manifestSha256': 'a' * 64}
        with tempfile.TemporaryDirectory() as temp:
            record = self.run_stage(temp, signed)
            self.assertEqual([c['ok'] for c in record.report['checks']], [True] * 3)
        with tempfile.TemporaryDirectory() as temp, self.assertRaisesRegex(RuntimeError, 'descriptor names'):
            self.run_stage(temp, {**signed, 'manifest': {'gitSha': 'e' * 40}})


class FirstUseRepositoryTests(unittest.TestCase):
    def test_first_use_refuses_a_repository_the_guide_does_not_download_from(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self_raises(SystemExit) as caught:
            first_use_lab.main(['--lab', '/nonexistent/lab', '--tag', 'core-test', '--public-key', KEY,
                                '--minisign', '/bin/true', '--node', '/bin/true', '--browser', '/bin/true',
                                '--port', '4599', '--report', '/nonexistent/report.json',
                                '--repository', 'someone/public-yuzuno'])
        self.assertEqual(caught.exception.code, 2)
        self.assertIn('--repository must be the repository the guide downloads from', stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
