"""tools/core-release-run.py (YN-54): no network, keys, build or Core.

GitHub is tools/fixtures/fake-gh-read.py on PATH as `gh`, which logs every
call and refuses any write a test does not expect; minisign and curl are
small stand-ins written by the test.
"""
import contextlib
import functools
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from release_common import archive_tree, digest, inventory, read, write

TOOLS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('release_run', TOOLS / 'core-release-run.py')
run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run)

PREV, REPO = 'core-20261108-0cbd2fa', 'owner/repo'
NAMES = ('yuzuno-core-linux-x86_64.json', 'yuzuno-core-linux-x86_64.json.minisig', 'yuzuno-core-linux-x86_64.tar.gz')


def git(cwd, *argv):
    return subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', *argv], cwd=cwd,
                          text=True, capture_output=True, check=True).stdout.strip()


def script(path, body):
    path.write_text(f'#!{sys.executable}\n{body}')
    path.chmod(0o755)
    return path


class ReleaseCase(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='yzrun-'))
        self.addCleanup(shutil.rmtree, self.temp)
        self.w = self.temp / 'w'
        self.w.mkdir()
        git(self.w, 'init', '-q', '-b', 'main')
        (self.w / '.gitignore').write_text('target/\n')
        git(self.w, 'add', '.gitignore')
        git(self.w, 'commit', '-q', '-m', 'base')
        self.sha = git(self.w, 'rev-parse', 'HEAD')
        self.rundir = self.w / 'target/core.29-run'
        self.rundir.mkdir(parents=True)
        self.t = self.temp / 't'
        self.bin = self.temp / 'bin'
        self.bin.mkdir()
        (self.bin / 'gh').symlink_to(TOOLS / 'fixtures/fake-gh-read.py')
        self.minisign = script(self.bin / 'minisign', 'import os, sys\nprint("Signature and comment signature verified")\n'
                               'print("Trusted comment: Yuzuno Core " + os.environ.get("FAKE_MINISIGN_TAG", ""))\n'
                               'sys.exit(int(os.environ.get("FAKE_MINISIGN_RC", "0")))\n')
        self.tag = f'core-20261109-{self.sha[:7]}'
        self.values = {'SHA': self.sha, 'CI_RUN': '101', 'RELEASE_ID': self.tag, 'VERSION': '2026.11.09-core.29',
                       'MILESTONE': 'core.29', 'PREV_TAG': PREV, 'REPO': REPO, 'W': str(self.w), 'T': str(self.t),
                       'MINISIGN': str(self.minisign), 'MINISIGN_SHA256': digest(self.minisign)}
        self.reads, self.writes = {}, {}
        self.log = self.temp / 'gh.jsonl'
        self.log.touch()
        for p in (patch.dict(os.environ, {'PATH': f"{self.bin}:{os.environ['PATH']}", 'FAKE_GH_LOG': str(self.log),
                                          'FAKE_GH_READS': str(self.temp / 'reads.json'),
                                          'FAKE_GH_WRITES': str(self.temp / 'writes.json'), 'FAKE_MINISIGN_TAG': self.tag}),
                  patch.object(run, 'ROOT', self.w.resolve())):
            p.start()
            self.addCleanup(p.stop)

    def env(self, **changes):
        values = {**self.values, **changes}
        path = self.rundir / 'release-run.env'
        path.write_text('# synthetic\n' + ''.join(f'{k}={v}  # value\n' for k, v in values.items() if v is not None))
        return path

    def files(self):
        (self.temp / 'reads.json').write_text(json.dumps(self.reads))
        (self.temp / 'writes.json').write_text(json.dumps(self.writes))

    def call(self, *argv, env=None):
        self.files()
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = run.main([argv[0], '--env', str(env or self.env()), *argv[1:]])
        return rc, out.getvalue(), err.getvalue()

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]


class EnvTests(ReleaseCase):
    def test_values_comments_and_blanks(self):
        path = self.env(INPUTS_RUN='')
        env = run.Env(path)
        self.assertEqual((env.SHA, env.n, env.run, env.work), (self.sha, 29, self.rundir.resolve(), self.t / 'release'))
        with self.assertRaisesRegex(run.Refused, 'INPUTS_RUN not set'):
            env.INPUTS_RUN

    def test_the_example_reads_with_its_later_values_blank(self):
        env = run.Env(TOOLS / 'release-run.env.example')
        self.assertEqual((env.MILESTONE, env.n), ('core.29', 29))
        self.assertFalse({'INPUTS_RUN', 'ARTIFACT_ID', 'NOTES_SHA256', 'REVIEW_SHA256', 'BASE_SHA256'} & set(env.values))

    def test_refuses_what_is_not_a_plain_release_value(self):
        for line, why in (('FOO=1', 'not a release value'), ('SHA = x', 'not NAME=value'), ('W=/a b', 'not NAME=value'),
                          ('W=/a;rm', 'shell character'), ('W=/$(id)', 'shell character'), ('W=/a`id`', 'shell character'),
                          ('NOTES_SHA256="ab"', 'shell character'), ('CI_RUN=1\nCI_RUN=2', 'set twice'),
                          ('SHA=abc', 'malformed'), ('KEY=relative/key', 'malformed')):
            with self.subTest(line=line):
                path = self.rundir / 'bad.env'
                path.write_text(line + '\n')
                with self.assertRaisesRegex(run.Refused, why):
                    run.Env(path)

    def test_values_that_disagree(self):
        for changes, why in (({'RELEASE_ID': 'core-20261109-0000000'}, 'does not name SHA'),
                             ({'VERSION': '2026.11.10-core.29'}, 'different days'),
                             ({'MILESTONE': 'core.30'}, 'is not milestone'),
                             ({'PREV_TAG': self.tag}, 'PREV_TAG is this release')):
            with self.subTest(changes=changes), self.assertRaisesRegex(run.Refused, why):
                run.Env(self.env(**changes))

    def test_a_command_refuses_to_start_without_a_value_it_needs(self):
        rc, _, err = self.call('gate', env=self.env(CI_RUN=None))
        self.assertEqual(rc, 2)
        self.assertIn('CI_RUN not set', err)
        self.assertEqual(self.calls(), [])


class TextsTests(ReleaseCase):
    def texts(self, notes='# notes\n', review='Accepted source changes.\n'):
        (self.rundir / 'notes-final.md').write_text(notes)
        (self.rundir / 'review-string.txt').write_text(review)
        return self.env(NOTES_SHA256=digest(self.rundir / 'notes-final.md'), REVIEW_SHA256=digest(self.rundir / 'review-string.txt'))

    def test_final_texts_and_what_init_is_given(self):
        env = run.Env(self.texts(review='Accepted.\n\n'))
        run.texts_final(env)
        self.assertEqual(run.review_text(env), 'Accepted.')

    def test_placeholders_changed_bytes_and_length_are_refused(self):
        for notes, review, why in (('# {{TODO}}\n', 'ok\n', 'still holds'), ('# n\n', '{{QUEUE: x}}\n', 'still holds'),
                                   ('# TODO\n', 'ok\n', 'still holds'), ('#' * 32769, 'ok\n', 'over 32768')):
            with self.subTest(notes=notes[:12], review=review), self.assertRaisesRegex(ValueError, why):
                run.texts_final(run.Env(self.texts(notes, review)))
        env = run.Env(self.texts())
        (self.rundir / 'notes-final.md').write_text('# changed\n')
        with self.assertRaisesRegex(ValueError, 'not the approved file'):
            run.texts_final(env)


class GateTests(ReleaseCase):
    def setUp(self):
        super().setUp()
        sha, tag = self.sha, self.tag
        self.reads = {
            f'repos/{REPO}/git/ref/heads/main': {'json': {'object': {'sha': sha}}},
            f'repos/{REPO}/actions/runs/101': {'json': {'path': '.github/workflows/ci.yml', 'event': 'push', 'head_branch': 'main',
                                                        'head_sha': sha, 'status': 'completed', 'conclusion': 'success', 'run_attempt': 1}},
            f'repos/{REPO}/actions/workflows/release-inputs.yml/runs?head_sha={sha}&per_page=100': {'json': {'total_count': 0, 'workflow_runs': []}},
            f'repos/{REPO}/git/ref/tags/{tag}': {'status': 404},
            f'repos/{REPO}/releases?per_page=100&page=1': {'json': [{'id': 5, 'tag_name': PREV, 'name': '2026.11.08-core.28', 'draft': False}]},
            f'repos/{REPO}/releases/latest': {'json': {'tag_name': PREV, 'name': '2026.11.08-core.28'}},
            f'repos/{REPO}/milestones?state=open&per_page=100&page=1': {'json': [{'number': 3, 'title': 'core.28'}, {'number': 4, 'title': 'core.29'}]},
        }

    def test_passes_with_reads_only_and_names_the_next_command(self):
        rc, out, _ = self.call('gate')
        self.assertEqual(rc, 0, out)
        self.assertIn(f'gh workflow run release-inputs.yml --repo {REPO} --ref main', out)
        self.assertTrue(read(self.rundir / 'gate.json')['passed'])
        self.assertEqual({c['verdict'] for c in self.calls()}, {'read'})

    def test_reports_every_problem(self):
        r = self.reads
        r[f'repos/{REPO}/git/ref/heads/main']['json']['object']['sha'] = '1' * 40
        r[f'repos/{REPO}/actions/runs/101']['json']['conclusion'] = 'failure'
        r[f'repos/{REPO}/actions/workflows/release-inputs.yml/runs?head_sha={self.sha}&per_page=100']['json']['total_count'] = 1
        r[f'repos/{REPO}/git/ref/tags/{self.tag}'] = {'json': {'object': {'sha': self.sha}}}
        r[f'repos/{REPO}/releases?per_page=100&page=1']['json'] += [{'id': 6, 'tag_name': 'x', 'name': 'draft', 'draft': True}]
        r[f'repos/{REPO}/releases/latest']['json'] = {'tag_name': 'core-20261101-1234567', 'name': '2026.11.01-core.27'}
        r[f'repos/{REPO}/milestones?state=open&per_page=100&page=1']['json'] = [{'number': 5, 'title': 'core.30'}]
        (self.w / 'stray').write_text('x')
        git(self.w, 'add', 'stray')
        rc, out, _ = self.call('gate')
        self.assertEqual(rc, 1)
        problems = read(self.rundir / 'gate.json')['problems']
        self.assertEqual([p.split(':')[0] for p in problems], ['W', 'main', 'CI', 'inputs', 'tag', 'releases', 'previous', 'milestone'])
        self.assertEqual({c['verdict'] for c in self.calls()}, {'read'})

    def test_a_used_version_or_number_is_a_problem(self):
        for name in ('2026.11.09-core.29', '2026.11.07-core.29'):
            with self.subTest(name=name):
                self.reads[f'repos/{REPO}/releases?per_page=100&page=1']['json'][1:] = [
                    {'id': 7, 'tag_name': 'core-20261107-7654321', 'name': name, 'draft': False}]
                self.assertEqual(self.call('gate')[0], 1)
                self.assertIn('releases: a release already uses', read(self.rundir / 'gate.json')['problems'][0])

    def test_minisign_must_be_the_pinned_binary(self):
        rc, _, _ = self.call('gate', env=self.env(MINISIGN_SHA256='0' * 64))
        self.assertEqual(rc, 1)
        self.assertTrue(read(self.rundir / 'gate.json')['problems'][0].startswith('minisign'))


class InputsTests(ReleaseCase):
    def runs(self, *runs):
        self.reads[f'repos/{REPO}/actions/workflows/release-inputs.yml/runs?head_sha={self.sha}&event=workflow_dispatch&per_page=100'] = {
            'json': {'total_count': len(runs), 'workflow_runs': list(runs)}}

    def a_run(self, **changes):
        return {'id': 900, 'run_attempt': 1, 'status': 'completed', 'conclusion': 'success', 'head_sha': self.sha,
                'head_branch': 'main', 'path': '.github/workflows/release-inputs.yml', 'head_repository': {'full_name': REPO},
                'created_at': '2026-11-09T00:00:00Z', 'html_url': 'https://example.invalid/run', **changes}

    def test_a_running_build_lets_the_hold_lift(self):
        self.runs(self.a_run(status='in_progress', conclusion=None))
        rc, out, _ = self.call('inputs')
        self.assertEqual(rc, 0)
        self.assertIn('the hold can lift', out)
        self.assertEqual(read(self.rundir / 'inputs.json')['status'], 'in_progress')

    def test_a_finished_build_names_its_one_artifact(self):
        self.runs(self.a_run(run_attempt=2))
        artifact = {'id': 77, 'name': f'core-inputs-{self.sha}-2', 'size_in_bytes': 9, 'digest': 'sha256:' + 'a' * 64, 'expired': False}
        self.reads[f'repos/{REPO}/actions/runs/900/artifacts'] = {'json': {'artifacts': [
            artifact, {**artifact, 'id': 78, 'name': f'core-inputs-{self.sha}-1'}]}}
        rc, out, _ = self.call('inputs')
        self.assertEqual(rc, 0)
        self.assertIn('INPUTS_RUN=900\nARTIFACT_ID=77', out)
        self.assertEqual(self.call('inputs', env=self.env(ARTIFACT_ID='78'))[0], 1)

    def test_two_runs_or_another_commit_stop(self):
        self.runs(self.a_run(), self.a_run(id=901))
        self.assertIn('2 release-inputs runs', self.call('inputs')[2])
        self.runs(self.a_run(head_branch='other'))
        self.assertIn('is not', self.call('inputs')[2])


class BaselineTests(ReleaseCase):
    def setUp(self):
        super().setUp()
        self.pub = self.temp / 'publisher.pub'
        self.pub.write_text('untrusted comment: test\nRWQ\n')
        self.bundle = self.temp / 'core28-bundle'
        (self.bundle / 'bin').mkdir(parents=True)
        (self.bundle / 'bin/yuzuno-workspace').write_bytes(b'core')
        (self.bundle / 'bin/yuzuno-workspace').chmod(0o755)
        (self.bundle / 'web').mkdir()
        (self.bundle / 'web/index.html').write_text('<html></html>')
        write(self.bundle / 'manifest.json', {'releaseId': PREV, 'files': inventory(self.bundle)})
        archive = self.temp / 'assets'
        archive.mkdir()
        archive_tree(self.bundle, archive / NAMES[2])
        write(archive / NAMES[0], {'tag': PREV, 'repository': REPO, 'manifestSha256': digest(self.bundle / 'manifest.json'),
                                   'archiveSha256': digest(archive / NAMES[2]), 'archiveBytes': (archive / NAMES[2]).stat().st_size})
        (archive / NAMES[1]).write_text('signature')
        assets = [{'id': n, 'name': name, 'digest': 'sha256:' + digest(archive / name)} for n, name in enumerate(NAMES, 1)]
        self.reads = {f'repos/{REPO}/releases/tags/{PREV}': {'json': {'tag_name': PREV, 'draft': False, 'assets': assets}},
                      **{f'repos/{REPO}/releases/assets/{a["id"]}': {'file': str(archive / a['name'])} for a in assets}}
        self.values.update(PUB=str(self.pub), PUB_SHA256=digest(self.pub), BASE=str(self.bundle))
        os.environ['FAKE_MINISIGN_TAG'] = PREV

    def test_the_previous_bundle_is_the_signed_one(self):
        rc, out, err = self.call('baseline')
        self.assertEqual(rc, 0, err)
        self.assertIn(f"BASE_SHA256={digest(self.bundle / 'manifest.json')}", out)
        self.assertNotIn(f'repos/{REPO}/releases/assets/3', [c['endpoint'] for c in self.calls()], 'the archive is fetched only to fill BASE')

    def test_a_changed_bundle_or_signature_is_refused(self):
        os.environ['FAKE_MINISIGN_RC'] = '1'
        self.assertIn('descriptor signature', self.call('baseline')[2])
        del os.environ['FAKE_MINISIGN_RC']
        (self.bundle / 'web/index.html').write_text('<html>changed</html>')
        self.assertIn('differs from its manifest', self.call('baseline')[2])
        write(self.bundle / 'manifest.json', {'files': {}})
        self.assertIn("is not core-20261108-0cbd2fa's signed manifest", self.call('baseline')[2])

    def test_fetch_fills_a_missing_base_from_the_signed_archive(self):
        target = self.temp / 'rebuilt'
        rc, _, err = self.call('baseline', '--fetch', env=self.env(BASE=str(target)))
        self.assertEqual(rc, 0, err)
        self.assertEqual(inventory(target), inventory(self.bundle))
        self.assertIn('exists', self.call('baseline', '--fetch', env=self.env(BASE=str(target)))[2])

    def test_an_asset_that_is_not_its_github_digest_is_refused(self):
        self.reads[f'repos/{REPO}/releases/tags/{PREV}']['json']['assets'][0]['digest'] = 'sha256:' + '0' * 64
        self.assertIn('differs from its GitHub digest', self.call('baseline')[2])


class FactsTests(ReleaseCase):
    def setUp(self):
        super().setUp()
        self.prev = self.sha
        self.merges = []
        for number in (11, 12):
            git(self.w, 'checkout', '-q', '-b', f'b{number}', self.prev if number == 11 else 'main')
            (self.w / f'f{number}').write_text('x')
            git(self.w, 'add', f'f{number}')
            git(self.w, 'commit', '-q', '-m', f'change {number}')
            git(self.w, 'checkout', '-q', 'main')
            git(self.w, 'merge', '-q', '--no-ff', '-m', f'Merge pull request #{number} from owner/b{number}', f'b{number}')
            self.merges.append(git(self.w, 'rev-parse', 'HEAD'))
        self.sha = self.merges[-1]
        self.tag = f'core-20261109-{self.sha[:7]}'
        self.values.update(SHA=self.sha, RELEASE_ID=self.tag)
        issue = lambda n: {'number': n, 'title': f'[YN-{n}] change', 'pull_request': {}, 'labels': [{'name': f'task:YN-{n}'}, {'name': 'other'}]}
        run_of = lambda i, attempt: {'id': 500 + i, 'status': 'completed', 'conclusion': 'success', 'run_attempt': attempt}
        self.reads = {
            f'repos/{REPO}/git/ref/tags/{PREV}': {'json': {'object': {'type': 'commit', 'sha': self.prev}}},
            f'repos/{REPO}/milestones?state=all&per_page=100&page=1': {'json': [{'number': 4, 'title': 'core.29'}, {'number': 3, 'title': 'core.28'}]},
            f'repos/{REPO}/issues?milestone=4&state=all&per_page=100&page=1': {'json': [issue(11), issue(12), {'number': 13, 'title': 'an issue', 'labels': []}]},
            f'repos/{REPO}/actions/runs/101': {'json': {'run_attempt': 1}},
            **{f'repos/{REPO}/actions/workflows/ci.yml/runs?head_sha={c}&event=push&branch=main&per_page=100':
               {'json': {'workflow_runs': [run_of(i, 1 if i == 0 else 2)]}} for i, c in enumerate(self.merges)},
        }

    def test_merges_milestone_and_main_ci_make_the_review_string_draft(self):
        rc, out, err = self.call('facts')
        self.assertEqual(rc, 0, err)
        draft = (self.rundir / 'review-string-draft.txt').read_text()
        self.assertIn(f'Accepted source changes through {self.sha}; main CI 101/1 passed. 2 PRs merged since {self.prev} (core.28), '
                      'milestone core.29: #11, #12. {{QUEUE:', draft)
        self.assertIn(f"1 of the 2 merge commits have a main push CI run of their own that passed on its first attempt; "
                      f"#12's own run ({self.merges[1][:8]}): run 501 completed/success on attempt 2 {{{{WHY #12}}}}.", draft)
        self.assertEqual((self.rundir / 'facts/milestone.tsv').read_text().splitlines()[0], '11\ttask:YN-11\t[YN-11] change')
        self.assertEqual(len((self.rundir / 'facts/merges.tsv').read_text().splitlines()), 2)
        self.assertEqual({c['verdict'] for c in self.calls()}, {'read'})

    def test_a_merge_the_milestone_lacks_stops(self):
        self.reads[f'repos/{REPO}/issues?milestone=4&state=all&per_page=100&page=1']['json'].pop(1)
        rc, out, _ = self.call('facts')
        self.assertEqual(rc, 1)
        self.assertIn('"onlyMerged": [12]', out)


class FreezeCase(ReleaseCase):
    """init, resume and publish, with tools/core-release.py replaced by a recorder."""

    def setUp(self):
        super().setUp()
        (self.rundir / 'notes-final.md').write_text('# notes\n')
        (self.rundir / 'review-string.txt').write_text('Accepted.\n')
        self.base = self.temp / 'base'
        self.base.mkdir()
        (self.base / 'manifest.json').write_text('{}')
        self.pub = self.temp / 'publisher.pub'
        self.pub.write_text('key\n')
        self.key = self.temp / 'secret.key'
        self.key.write_text('never read')
        self.values.update(INPUTS_RUN='900', ARTIFACT_ID='77', NOTES_SHA256=digest(self.rundir / 'notes-final.md'),
                           REVIEW_SHA256=digest(self.rundir / 'review-string.txt'), BASE=str(self.base),
                           BASE_SHA256=digest(self.base / 'manifest.json'), PUB=str(self.pub), PUB_SHA256=digest(self.pub),
                           KEY=str(self.key))
        self.recorded = []
        recorder = patch.object(run, 'core_release', side_effect=self.core_release)
        recorder.start()
        self.addCleanup(recorder.stop)
        self.outcome = {}

    def core_release(self, env, command, *argv):
        self.recorded.append([command, *map(str, argv)])
        work = self.t / 'release'
        if command == 'init':
            work.mkdir(parents=True)
            write(work / 'release.json', {'repository': REPO, 'source': self.sha, 'ciRunId': 101, 'inputsRunId': 900, 'artifactId': 77,
                                          'releaseId': self.tag, 'version': '2026.11.09-core.29', 'notesSha256': self.values['NOTES_SHA256'],
                                          'baselineManifestSha256': self.values['BASE_SHA256'], 'publicKeySha256': self.values['PUB_SHA256'],
                                          'acceptedReview': argv[argv.index('--review') + 1], 'baseline': str(self.base)})
        if command == 'resume':
            o = self.outcome
            write(work / 'report.json', {'stages': {s: {'status': o.get(s, 'passed')} for s in ('fetch', 'package', 'sign', 'smoke')},
                                         'resumeAt': o.get('resumeAt', 'publish (only with release authorization)')})
            (work / 'signed').mkdir(exist_ok=True)
            for name in NAMES[:o.get('signed', 3)]:
                (work / 'signed' / name).write_text(name)
            (work / 'bundle').mkdir(exist_ok=True)
            (work / 'bundle/manifest.json').write_text('{}')
            write(work / 'smoke.json', {'passed': o.get('smokePassed', True), 'inputs': {'mode': o.get('mode', 'inPlace')},
                                        'addedFields': {'core-20261109': {'project': ['key']}}})
            return o.get('rc', 0)
        return 0

    def resume(self):
        self.call('init')
        return self.call('resume', '--release-json-sha', digest(self.t / 'release/release.json'))


class FreezeTests(FreezeCase):
    def test_init_freezes_the_texts_and_refuses_a_second_work_dir(self):
        rc, out, err = self.call('init')
        self.assertEqual(rc, 0, err)
        argv = self.recorded[0]
        self.assertEqual(argv[argv.index('--review') + 1], 'Accepted.')
        self.assertEqual(argv[argv.index('--notes') + 1], str(self.rundir.resolve() / 'notes-final.md'))
        self.assertIn('exists: a new release needs a new work directory', self.call('init')[2])

    def test_init_refuses_a_dirty_or_other_checkout(self):
        (self.w / 'tracked').write_text('x')
        git(self.w, 'add', 'tracked')
        self.assertIn('W has changes', self.call('init')[2])
        git(self.w, 'reset', '-q')
        (self.w / 'tracked').unlink()
        with patch.object(run, 'ROOT', self.temp):
            self.assertIn('Run the tools of the frozen checkout W', self.call('init')[2])
        self.assertEqual(self.recorded, [])

    def test_resume_writes_the_summary_publish_takes(self):
        rc, _, err = self.resume()
        self.assertEqual(rc, 0, err)
        summary = read(self.rundir / 'resume.json')
        self.assertTrue(summary['asExpected'])
        self.assertEqual(summary['addedFields'], {'core-20261109': {'project': ['key']}})
        self.assertEqual(self.recorded[1], ['resume', '--work-dir', str(self.t / 'release'), '--signing-key', str(self.key),
                                            '--minisign', str(self.minisign)])

    def test_each_condition_of_a_passing_resume(self):
        for outcome in ({'rc': 1}, {'smoke': 'failed'}, {'signed': 2}, {'smokePassed': False}, {'mode': 'newDataDirectory'},
                        {'resumeAt': 'smoke'}):
            with self.subTest(outcome=outcome):
                shutil.rmtree(self.t, ignore_errors=True)
                self.outcome = outcome
                rc, _, _ = self.resume()
                self.assertEqual(rc, 1)
                self.assertFalse(read(self.rundir / 'resume.json')['asExpected'])

    def test_resume_refuses_a_key_inside_the_checkout_or_another_release_json(self):
        inside = self.rundir / 'secret.key'
        inside.write_text('x')
        self.call('init')
        sha = digest(self.t / 'release/release.json')
        self.assertIn('The signing key is inside', self.call('resume', '--release-json-sha', sha, env=self.env(KEY=str(inside)))[2])
        self.assertIn('not the one init wrote', self.call('resume', '--release-json-sha', '0' * 64)[2])
        self.assertEqual([c[0] for c in self.recorded], ['init'])

    def test_a_publish_whose_read_back_fails_still_reports_the_publication(self):
        self.resume()
        rc, out, _ = self.call('publish', '--resume-sha', digest(self.rundir / 'resume.json'))
        self.assertEqual(rc, 0)
        self.assertIn('published; reading the tag and release back for the receipts failed', out)
        self.assertEqual([c[0] for c in self.recorded], ['init', 'resume', 'publish', 'status'])

    def test_publish_takes_only_the_passing_summary_it_is_given(self):
        self.resume()
        sha = digest(self.rundir / 'resume.json')
        self.assertIn('is not the summary', self.call('publish', '--resume-sha', '0' * 64)[2])
        summary = read(self.rundir / 'resume.json')
        write(self.rundir / 'resume.json', {**summary, 'asExpected': False})
        self.assertIn('not a passing summary', self.call('publish', '--resume-sha', digest(self.rundir / 'resume.json'))[2])
        write(self.rundir / 'resume.json', summary)
        (self.rundir / 'review-string.txt').write_text('Changed.\n')
        self.assertIn('not the approved file', self.call('publish', '--resume-sha', sha)[2])
        self.assertNotIn('publish', [c[0] for c in self.recorded])


class VerifyTests(FreezeCase):
    def test_the_anonymous_download_must_be_the_signed_bytes(self):
        self.resume()
        served = self.temp / 'served'
        served.mkdir()
        for name in NAMES:
            (served / name).write_text(name)
        fake = self.temp / 'anon-bin'
        fake.mkdir()
        script(fake / 'curl', f'import shutil, sys\nargs = sys.argv[1:]\nshutil.copy({str(served)!r} + "/" + args[-1].rsplit("/", 1)[1], args[args.index("-o") + 1])\n')
        with patch.object(run, 'ANON_PATH', str(fake)), patch.object(run, 'ANON_BASE', 'https://example.invalid'):
            os.environ['FAKE_MINISIGN_TAG'] = self.tag
            rc, out, err = self.call('verify')
            self.assertEqual(rc, 0, err)
            self.assertIn('verify-download', [c[0] for c in self.recorded])
            (served / NAMES[2]).write_text('other bytes')
            self.assertIn('differs from the signed file', self.call('verify')[2])
            self.assertTrue((self.t / 'anonymous-download-2').is_dir(), 'a second attempt downloads into its own directory')
            self.assertEqual((self.t / 'anonymous-download' / NAMES[2]).read_text(), NAMES[2], 'the first is kept')


class MilestoneTests(ReleaseCase):
    def setUp(self):
        super().setUp()
        self.reads = {f'repos/{REPO}/milestones?state=all&per_page=100&page=1': {'json': [
            {'number': 3, 'title': 'core.28', 'state': 'closed'}, {'number': 4, 'title': 'core.29', 'state': 'open'}]}}
        self.writes = {f'POST repos/{REPO}/milestones': {'json': {'number': 5, 'title': 'core.30'}},
                       f'PATCH repos/{REPO}/milestones/4': {'json': {'number': 4, 'title': 'core.29', 'state': 'closed'}}}

    def test_opens_the_next_once_inputs_started_and_closes_this_once_published(self):
        self.assertIn('once the inputs run has started', self.call('milestone', '--open', 'core.30')[2])
        self.assertIn('The next milestone is core.30', self.call('milestone', '--open', 'core.31')[2])
        write(self.rundir / 'inputs.json', {})
        self.assertEqual(self.call('milestone', '--open', 'core.30')[0], 0)
        self.assertIn('once the release is published', self.call('milestone', '--close', 'core.29')[2])
        write(self.t / 'release/publication.json', {})
        self.assertIn('closed', self.call('milestone', '--close', 'core.29')[1])
        writes = [(c['method'], c['endpoint'], c['fields']) for c in self.calls() if c['verdict'] == 'write']
        self.assertEqual(writes, [('POST', f'repos/{REPO}/milestones', ['title=core.30']),
                                  ('PATCH', f'repos/{REPO}/milestones/4', ['state=closed'])])


class FakeGhTests(ReleaseCase):
    def test_writes_and_other_commands_are_refused_and_logged(self):
        self.reads = {'repos/o/r': {'json': {'ok': True}}}
        self.files()
        gh = str(self.bin / 'gh')
        for argv in (['api', 'repos/o/r', '-f', 'a=b'], ['api', '-X', 'POST', 'repos/o/r'], ['api', '--method', 'patch', 'repos/o/r'],
                     ['api', 'repos/o/r', '--input', 'x'], ['workflow', 'run', 'release-inputs.yml'], ['release', 'create', 'x']):
            with self.subTest(argv=argv):
                result = subprocess.run([gh, *argv], text=True, capture_output=True)
                self.assertEqual(result.returncode, 1)
                self.assertIn('fake gh: refused', result.stderr)
        read_back = subprocess.run([gh, 'api', '-X', 'GET', 'repos/o/r', '-f', 'q=1'], text=True, capture_output=True)
        self.assertEqual(json.loads(read_back.stdout), {'ok': True})
        self.assertEqual([c['verdict'] for c in self.calls()], ['refused'] * 6 + ['read'])

    def test_passthrough_reads_reach_the_real_gh_and_writes_never_do(self):
        real = script(self.temp / 'real-gh', 'import sys\nprint("real", *sys.argv[1:])\n')
        with patch.dict(os.environ, {'FAKE_GH_PASSTHROUGH': str(real)}):
            gh = str(self.bin / 'gh')
            self.assertEqual(subprocess.run([gh, 'api', 'repos/o/r'], text=True, capture_output=True).stdout, 'real api repos/o/r\n')
            self.writes = {'POST repos/o/r': {'json': {}}}
            self.files()
            self.assertEqual(subprocess.run([gh, 'api', '-X', 'POST', 'repos/o/r'], capture_output=True).returncode, 1)
        self.assertEqual([c['verdict'] for c in self.calls()], ['read', 'refused'])


class HealthTests(unittest.TestCase):
    def serve(self, directory):
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(directory)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f'http://127.0.0.1:{server.server_address[1]}'

    def test_served_ui_is_the_bundle_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as temp:
            web, served = Path(temp) / 'web', Path(temp) / 'served'
            for root in (web, served):
                (root / 'assets/fonts').mkdir(parents=True)
                (root / 'index.html').write_text('<head><meta name="yuzuno-release" content="core-20261109-abcdef0"></head>')
                (root / 'assets/app.js').write_text('js')
                (root / 'assets/fonts/a b.woff2').write_bytes(b'font')
            origin = self.serve(served)
            self.assertEqual(run.served_ui(origin, web), {'index': True, 'releaseMeta': ['core-20261109-abcdef0'], 'assets': 2, 'different': []})
            (served / 'assets/app.js').write_text('other')
            self.assertEqual(run.served_ui(origin, web)['different'], ['assets/app.js'])

    def test_only_an_explicit_localhost_origin(self):
        for origin in ('http://example.invalid:4317', 'http://127.0.0.1:4317/api', 'http://u:p@localhost:4317', 'file:///x'):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                run.local_origin(origin)
        self.assertEqual(run.local_origin('http://127.0.0.1:4317/'), 'http://127.0.0.1:4317')


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


if __name__ == '__main__':
    unittest.main()
