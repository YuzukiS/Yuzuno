#!/usr/bin/env python3
"""Artifact, upstream and usage checks of the job host helper; no real services."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
MODULE = importlib.util.spec_from_file_location(
    'job_host', os.environ.get('JOB_HOST_PY') or Path(__file__).resolve().parents[2] / 'core/src/jobs/host.py')
host = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(host)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(self.tmp.name) / 'work'
        self.cwd.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, path, **contract):
        return host.check_artifact(str(self.cwd), {'path': path, **contract})

    def test_a_complete_file_is_identified_by_size_and_sha256(self):
        (self.cwd / 'final.json').write_text('{"return": 1}')
        entry = self.check('final.json', format='json')
        self.assertTrue(entry['ok'], entry)
        self.assertEqual(entry['bytes'], 13)
        self.assertEqual(len(entry['sha256']), 64)
        self.assertEqual(entry['absolutePath'], str((self.cwd / 'final.json').resolve()))

    def test_missing_empty_and_partly_written_files_are_not_artifacts(self):
        # The snn-rl case: final.json existing is not final.json complete.
        self.assertEqual(self.check('final.json')['problem'], 'missing')
        (self.cwd / 'final.json').write_text('')
        self.assertIn('fewer than the required 1', self.check('final.json')['problem'])
        (self.cwd / 'final.json').write_text('{"return": 1, "steps": 40')
        entry = self.check('final.json', format='json')
        self.assertFalse(entry['ok'])
        self.assertIn('not complete JSON', entry['problem'])
        (self.cwd / 'metrics.jsonl').write_text('{"step": 1}\n{"step": 2}\n{"step": 3')
        self.assertIn('not terminated', self.check('metrics.jsonl', format='jsonl')['problem'])
        (self.cwd / 'metrics.jsonl').write_text('{"step": 1}\nnot json\n')
        self.assertIn('not complete JSON lines', self.check('metrics.jsonl', format='jsonl')['problem'])
        (self.cwd / 'metrics.jsonl').write_text('{"step": 1}\n\n{"step": 2}\n')
        entry = self.check('metrics.jsonl', format='jsonl')
        self.assertTrue(entry['ok'], entry)
        self.assertEqual(entry['lines'], 2)
        (self.cwd / 'empty.txt').write_text('')
        self.assertTrue(self.check('empty.txt', minBytes=0)['ok'])
        (self.cwd / 'model.pt').write_bytes(b'x' * 10)
        self.assertIn('fewer than the required 100', self.check('model.pt', minBytes=100)['problem'])

    def test_only_regular_files_inside_cwd_count(self):
        (self.cwd / 'checkpoint').mkdir()
        self.assertEqual(self.check('checkpoint')['problem'], 'not a regular file')
        outside = Path(self.tmp.name) / 'elsewhere.json'
        outside.write_text('{}')
        os.symlink(outside, self.cwd / 'link.json')
        self.assertEqual(self.check('link.json')['problem'], 'resolves outside the working directory')
        (self.cwd / 'real.json').write_text('{}')
        os.symlink(self.cwd / 'real.json', self.cwd / 'inside.json')
        self.assertTrue(self.check('inside.json')['ok'])

    def test_large_files_are_identified_without_parsing(self):
        (self.cwd / 'big.bin').write_bytes(b'x' * 64)
        with patch.object(host, 'HASH_LIMIT', 32):
            entry = self.check('big.bin')
            self.assertTrue(entry['ok'], entry)
            self.assertIsNone(entry['sha256'])
            self.assertIn('size and modification time', entry['hash'])
            self.assertIn('declare it as bytes', self.check('big.bin', format='json')['problem'])
        with patch.object(host, 'JSON_LIMIT', 8):
            (self.cwd / 'large.json').write_text('{"a": "0123456789"}')
            self.assertIn('too large to check as JSON', self.check('large.json', format='json')['problem'])

    def test_every_artifact_left_out_of_the_guard_is_checked_not_only_the_direct_upstream(self):
        # a -> b -> c, and b rewrote a's file but declared only its own.
        (self.cwd / 'a.json').write_text('{"a": 1}')
        (self.cwd / 'b.json').write_text('{"b": 1}')
        a, b = self.check('a.json', format='json'), self.check('b.json', format='json')
        spec = {'upstream': [{'stage': 'b', 'cwd': str(self.cwd), 'artifacts': [b]}],
                'guardChecks': [{'stage': 'a', 'cwd': str(self.cwd), 'artifacts': [a]},
                                {'stage': 'b', 'cwd': str(self.cwd), 'artifacts': [b]}]}
        self.assertIsNone(host.upstream_problem(spec))
        (self.cwd / 'a.json').write_text('{"a": 2}')
        self.assertIn('Upstream stage a artifact a.json is no longer the one it succeeded with',
                      host.upstream_problem(spec) or '')

    def test_an_upstream_artifact_must_be_the_one_its_stage_succeeded_with(self):
        (self.cwd / 'final.json').write_text('{"return": 1}')
        recorded = self.check('final.json', format='json')
        spec = {'upstream': [{'stage': 'train', 'cwd': str(self.cwd), 'artifacts': [recorded]}]}
        self.assertIsNone(host.upstream_problem(spec))
        (self.cwd / 'final.json').write_text('{"return": 2}')
        problem = host.upstream_problem(spec)
        self.assertIn('Upstream stage train artifact final.json is no longer the one it succeeded with', problem)
        self.assertIn('command was not started', problem)
        (self.cwd / 'final.json').unlink()
        self.assertIn('(missing)', host.upstream_problem(spec))
        (self.cwd / 'empty.txt').write_text('')
        empty = self.check('empty.txt', minBytes=0)
        self.assertIsNone(host.upstream_problem({'upstream': [{'stage': 's', 'cwd': str(self.cwd), 'artifacts': [empty]}]}))
        large = dict(recorded, sha256=None, mtimeNs=1)
        (self.cwd / 'final.json').write_text('{"return": 1}')
        self.assertFalse(host.same_artifact(large, self.check('final.json', format='json')))


class StageGuardTests(unittest.TestCase):
    """A later stage's Git guard leaves out what its earlier stages declare."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        def git(*args):
            return subprocess.run(['git', '-C', str(self.repo), *args], check=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.git = git
        git('init', '-q')
        for name in ('code.py', 'results.json', 'notes.txt'):
            (self.repo / name).write_text('first')
        git('add', '.')
        git('-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', 'commit', '-qm', 'fixture')

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_rename_onto_a_declared_artifact_still_guards_its_source(self):
        stage = {'cwd': str(self.repo), 'guardGit': True, 'run': {'id': 'r'},
                 'guardExclude': [str(self.repo / 'renamed.dat')]}
        frozen = host.snapshot(stage)
        self.git('mv', 'code.py', 'renamed.dat')
        current = host.snapshot(stage)
        self.assertNotEqual(current, frozen, 'renaming undeclared code.py away is a change')
        self.git('mv', 'renamed.dat', 'code.py')
        self.assertEqual(host.snapshot(stage), frozen)
        self.git('rm', '-q', '--cached', 'notes.txt')
        (self.repo / 'renamed.dat').write_text('first')
        self.git('add', 'renamed.dat')
        self.git('-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', 'commit', '-qm', 'declared artifact tracked')
        frozen = host.snapshot(stage)
        (self.repo / 'renamed.dat').write_text('written by the earlier stage')
        self.assertEqual(host.snapshot(stage), frozen, 'a declared artifact rewritten in place is left out')

    def test_declared_upstream_artifacts_are_left_out_and_everything_else_is_named(self):
        (self.repo / 'results.json').write_text('dirty before the run')
        plain = {'cwd': str(self.repo), 'guardGit': True}
        status = subprocess.run(['git', '-C', str(self.repo), 'status', '--porcelain=v1', '-z',
                                 '--untracked-files=no', '--ignore-submodules=all'],
                                check=True, stdout=subprocess.PIPE).stdout
        # Without exclusions nothing changes for jobs recorded before runs existed.
        self.assertEqual(host.snapshot(plain)['git']['statusSha256'], hashlib.sha256(status).hexdigest())
        stage = {**plain, 'guardExclude': [str(self.repo / 'results.json')], 'run': {'id': 'r'}}
        frozen = host.snapshot(stage)
        self.assertNotIn(str(self.repo / 'results.json'), [f['path'] for f in frozen['files']])
        (self.repo / 'results.json').write_text('written by the earlier stage')
        self.assertEqual(host.snapshot(stage), frozen)
        self.assertIn(str(self.repo / 'results.json'), [f['path'] for f in host.snapshot(plain)['files']],
                      'a plain job still guards it')
        (self.repo / 'notes.txt').write_text('an undeclared change')
        current = host.snapshot(stage)
        self.assertNotEqual(current, frozen)
        reason = host.guard_reason({**stage, 'snapshot': frozen}, current)
        self.assertIn(str(self.repo / 'notes.txt'), reason)
        self.assertNotIn('results.json', reason)
        self.assertIn("declare it as that stage's artifact", reason)
        self.assertTrue(reason.startswith('Guarded inputs changed while queued ('))
        self.git('-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', 'commit', '-qam', 'later')
        self.assertIn('the Git commit', host.guard_reason({**stage, 'snapshot': frozen}, host.snapshot(stage)))
        self.assertNotIn('artifact', host.guard_reason({**plain, 'snapshot': frozen}, host.snapshot(stage)))


class AttemptReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.cwd = self.folder / 'work'
        self.cwd.mkdir()
        self.spec = {'id': 'job', 'attempt': 'attempt', 'bootId': host.boot_id(), 'unit': 'worker',
                     'supervisorUnit': 'collector', 'cwd': str(self.cwd),
                     'artifacts': [{'path': 'final.json', 'format': 'json'}]}
        host.atomic(self.folder / 'started.json', {'jobId': 'job', 'attempt': 'attempt', 'bootId': host.boot_id(),
                                                  'invocationId': 'invocation', 'controlGroup': '/fake'})

    def tearDown(self):
        self.tmp.cleanup()

    def test_usage_is_summed_with_unknown_and_broken_lines_kept_apart(self):
        self.assertIsNone(host.usage_summary(self.folder))
        (self.folder / 'usage.jsonl').write_text(
            '{"usd": 0.092326, "source": "openrouter usage.cost"}\n'
            '{"usd": null, "source": "response lost"}\n'
            '{"usd": -1}\n[1]\nnot json\n'
            '{"usd": 0.5, "source": "openrouter usage.cost"}\n'
            '{"usd": 0.1')
        cost = host.usage_summary(self.folder)
        self.assertEqual(cost['knownUsd'], 0.592326)
        self.assertEqual(cost['entries'], 4)
        self.assertEqual(cost['unknownEntries'], 1)
        self.assertEqual(cost['invalidLines'], 3)
        self.assertEqual(cost['incompleteLines'], 1)
        self.assertEqual(cost['sources'], ['openrouter usage.cost', 'response lost'])
        self.assertFalse(cost['complete'])
        (self.folder / 'usage.jsonl').write_text('{"usd": true}\n{"usd": 0.25}\n')
        cost = host.usage_summary(self.folder)
        self.assertEqual((cost['knownUsd'], cost['invalidLines'], cost['complete']), (0.25, 1, False))
        (self.folder / 'usage.jsonl').write_text('{"usd": 0.25}\n')
        self.assertTrue(host.usage_summary(self.folder)['complete'])
        with patch.object(host, 'USAGE_LIMIT', 8):
            cost = host.usage_summary(self.folder)
            self.assertTrue(cost['truncated'])
            self.assertFalse(cost['complete'])

    def test_progress_is_kept_as_reported(self):
        self.assertIsNone(host.progress(self.folder))
        (self.folder / 'progress.json').write_text('{"step": 1200000, "of": 4000000}')
        self.assertEqual(host.progress(self.folder)['value'], {'step': 1200000, 'of': 4000000})
        (self.folder / 'progress.json').write_text('{"step": 12')
        self.assertEqual(host.progress(self.folder)['problem'], 'not complete JSON of finite numbers')

    def test_the_attempt_knows_where_to_report_and_cannot_be_told_otherwise(self):
        env = host.attempt_env({**self.spec, 'run': {'id': 'run', 'stage': 'train', 'attempt': 2}}, self.folder)
        self.assertEqual(env['YUZUNO_JOB_USAGE_FILE'], str(self.folder / 'usage.jsonl'))
        self.assertEqual(env['YUZUNO_RUN_ATTEMPT'], '2')
        self.assertNotIn('YUZUNO_RUN_ID', host.attempt_env(self.spec, self.folder))

    @patch.object(host, 'group_empty', return_value=True)
    def test_a_clean_exit_succeeds_only_with_every_declared_artifact_verified(self, _):
        state = {'MainPID': '0', 'SubState': 'exited', 'Result': 'success', 'ExecMainCode': '1',
                 'ExecMainStatus': '0', 'InvocationID': 'invocation'}
        # The rlft D23 case: "train; echo done" exits 0 without its checkpoint.
        self.assertEqual(host.classify(self.spec, self.folder, state), 'failed')
        self.assertEqual(host.terminal_reason(self.spec, self.folder, 'failed', state, None),
                         'Exit 0, but artifact verification did not complete')
        checked = [host.check_artifact(str(self.cwd), a) for a in self.spec['artifacts']]
        host.atomic(self.folder / 'artifacts.json', {'attempt': 'attempt', 'artifacts': checked})
        self.assertEqual(host.classify(self.spec, self.folder, state), 'failed')
        self.assertEqual(host.terminal_reason(self.spec, self.folder, 'failed', state, None),
                         'Exit 0, but declared artifacts failed verification: final.json: missing')
        (self.cwd / 'final.json').write_text('{}')
        checked = [host.check_artifact(str(self.cwd), a) for a in self.spec['artifacts']]
        host.atomic(self.folder / 'artifacts.json', {'attempt': 'old-attempt', 'artifacts': checked})
        self.assertEqual(host.classify(self.spec, self.folder, state), 'failed', 'another attempt proves nothing')
        host.atomic(self.folder / 'artifacts.json', {'attempt': 'attempt', 'artifacts': checked})
        self.assertEqual(host.classify(self.spec, self.folder, state), 'succeeded')
        self.assertEqual(host.classify({**self.spec, 'artifacts': []}, self.folder, state), 'succeeded')
        failed = {**state, 'Result': 'exit-code', 'ExecMainStatus': '7'}
        self.assertEqual(host.terminal_reason(self.spec, self.folder, 'failed', failed, None), 'exit-code')

    @patch.object(host, 'group_empty', return_value=True)
    def test_reports_the_command_wrote_badly_never_keep_the_outcome_from_being_recorded(self, _):
        # NaN/Infinity (Python's json default), numbers out of range, deep
        # nesting, a directory, a pipe or a link where a report file should be.
        strict = lambda text: json.loads(text, parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))
        progress = self.folder / 'progress.json'
        for raw, problem in [('{"loss": NaN}', 'not complete JSON of finite numbers'),
                             ('{"loss": -Infinity}', 'not complete JSON of finite numbers'),
                             ('{"step": 1e999}', 'not complete JSON of finite numbers'),
                             ('{"step": ' + '9' * 30 + '}', 'not complete JSON of finite numbers'),
                             ('[' * 60000, 'not complete JSON of finite numbers')]:
            progress.write_text(raw)
            self.assertEqual(host.progress(self.folder)['problem'], problem, raw[:20])
        progress.unlink()
        progress.mkdir()
        self.assertEqual(host.progress(self.folder)['problem'], 'not a regular file')
        progress.rmdir()
        os.mkfifo(progress)
        self.assertEqual(host.progress(self.folder)['problem'], 'not a regular file')
        progress.unlink()
        (self.folder / 'elsewhere.json').write_text('{"a": 1}')
        os.symlink(self.folder / 'elsewhere.json', progress)
        self.assertIn('cannot be read', host.progress(self.folder)['problem'])
        usage = self.folder / 'usage.jsonl'
        usage.mkdir()
        cost = host.usage_summary(self.folder)
        self.assertEqual((cost['problem'], cost['complete']), ('not a regular file', False))
        usage.rmdir()
        usage.write_text('{"usd": NaN}\n{"usd": 1e12}\n{"usd": 0.5}\n' + '[' * 100000 + '\n')
        cost = host.usage_summary(self.folder)
        self.assertEqual((cost['knownUsd'], cost['invalidLines'], cost['complete']), (0.5, 3, False))
        (self.folder / 'artifacts.json').write_text('{"attempt": "attempt", "artifacts": [')
        state = {'MainPID': '0', 'SubState': 'exited', 'Result': 'success', 'ExecMainCode': '1',
                 'ExecMainStatus': '0', 'InvocationID': 'invocation'}
        self.assertEqual(host.classify(self.spec, self.folder, state), 'failed')
        self.assertEqual(host.terminal_reason(self.spec, self.folder, 'failed', state, None),
                         'Exit 0, but artifact verification did not complete')
        saved = host.result(self.spec, self.folder, 'failed', {}, 'exit-code')
        self.assertEqual(saved['status'], 'failed')
        self.assertEqual(strict(json.dumps(saved, allow_nan=False)), saved)
        self.assertEqual(host.read(self.folder / 'result.json'), saved)
        with patch.object(host, 'usage_summary', side_effect=RuntimeError('broken')):
            self.assertIn('could not be read', host.reports(self.spec, self.folder)['reportProblem'])
        (self.cwd / 'deep.json').write_text('[' * 100000 + ']' * 100000)
        self.assertIn('not complete JSON', host.check_artifact(str(self.cwd), {'path': 'deep.json', 'format': 'json'})['problem'])

    @patch.object(host, 'group_empty', return_value=True)
    def test_the_outcome_keeps_the_attempts_own_reports(self, _):
        (self.cwd / 'final.json').write_text('{}')
        checked = [host.check_artifact(str(self.cwd), a) for a in self.spec['artifacts']]
        host.atomic(self.folder / 'artifacts.json', {'attempt': 'attempt', 'artifacts': checked})
        (self.folder / 'usage.jsonl').write_text('{"usd": 0.63, "source": "provider"}\n')
        saved = host.result(self.spec, self.folder, 'failed', {}, 'exit-code')
        self.assertEqual(saved['cost']['knownUsd'], 0.63)
        self.assertTrue(saved['artifacts'][0]['ok'])
        self.assertEqual(host.read(self.folder / 'result.json'), saved)
        self.assertEqual(host.reports(self.spec, self.folder)['cost']['knownUsd'], 0.63)


if __name__ == '__main__':
    unittest.main()
