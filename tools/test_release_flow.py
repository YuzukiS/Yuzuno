"""Release integrity and continuation checks; no network, keys, build or Core."""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from release_common import CLAUDE_SDK_PLACEHOLDER, archive_tree, digest, extract, inventory, read, write

spec = importlib.util.spec_from_file_location('release_flow', Path(__file__).with_name('core-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

spec = importlib.util.spec_from_file_location('release_smoke', Path(__file__).with_name('core-release-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


# What tools/build-core-artifact.py writes to inputs/licenses (T-90).
LICENSE_FILES = ['licenses/LICENSE', 'licenses/THIRD_PARTY_NOTICES-core.txt', 'licenses/rust-std-COPYRIGHT-library.html',
                 'licenses/THIRD_PARTY_NOTICES-claude-runtime.txt']


class DownloadTests(unittest.TestCase):
    def test_failed_download_never_adopts_partial_bytes(self):
        endpoint = 'repos/owner/repo/actions/artifacts/7/zip'
        for existing in (None, b'previous complete download'):
            for error in (subprocess.CalledProcessError(1, ['gh', 'api', endpoint]),
                          subprocess.TimeoutExpired(['gh', 'api', endpoint], 300)):
                with self.subTest(existing=existing, error=type(error).__name__), tempfile.TemporaryDirectory() as temp:
                    target = Path(temp) / 'artifact.zip'
                    if existing is not None:
                        target.write_bytes(existing)
                    def fail(argv, *, stdout, check, timeout):
                        stdout.write(b'incomplete response')
                        raise error
                    with patch.object(release.subprocess, 'run', side_effect=fail), self.assertRaises(type(error)):
                        release.download(endpoint, target)
                    self.assertFalse(target.with_suffix('.zip.part').exists())
                    if existing is None:
                        self.assertFalse(target.exists())
                    else:
                        self.assertEqual(target.read_bytes(), existing)


class SmokeBudgetTests(unittest.TestCase):
    def test_saves_a_distinct_valid_budget_and_reuses_it_on_seed_retry(self):
        for cpu, ceiling in ((200, True), (500, True), (4000, True), (500, False)):
            with self.subTest(suggested_cpu=cpu, ceiling=ceiling):
                suggested = {'cpuMillis': cpu, 'memoryMiB': 8192, 'swapMiB': 0}
                maximum = {'cpuMillis': max(750, cpu), 'memoryMiB': 16384, 'swapMiB': 0} if ceiling else None
                saved, writes = None, []
                def api(path, body=None):
                    nonlocal saved
                    self.assertEqual(path, 'jobs/budget')
                    if body is not None:
                        self.assertTrue(not maximum or all(body[key] <= maximum[key] for key in body))
                        self.assertGreaterEqual(body['cpuMillis'], 200)
                        self.assertGreaterEqual(body['memoryMiB'], 128)
                        writes.append(body.copy())
                        saved = body.copy()
                        return body
                    # A Core from T-160 on reports no ceiling.
                    machine = {'suggestedBudget': suggested, **({'maximumBudget': maximum} if maximum else {})}
                    return {'budget': saved or suggested, 'machine': machine}
                first = smoke.save_fixture_budget(api)
                self.assertNotEqual(first['saved'], suggested)
                self.assertEqual(first['saved'], saved)
                self.assertEqual(first, smoke.save_fixture_budget(api))
                self.assertEqual(writes, [first['saved'], first['saved']])

    def test_unsaved_default_does_not_pass_as_a_saved_budget(self):
        budget = {'cpuMillis': 500, 'memoryMiB': 8192, 'swapMiB': 0}
        def api(path, body=None):
            # Simulate an accepted write that failed to persist anything.
            return {'budget': budget, 'machine': {'suggestedBudget': budget, 'maximumBudget': budget}}
        with self.assertRaisesRegex(ValueError, 'not saved before upgrade'):
            smoke.save_fixture_budget(api)

    def test_insufficient_host_budget_fails_before_posting(self):
        budget = {'cpuMillis': 100, 'memoryMiB': 64, 'swapMiB': 0}
        def api(path, body=None):
            self.assertIsNone(body)
            return {'budget': budget, 'machine': {'suggestedBudget': budget, 'maximumBudget': budget}}
        with self.assertRaisesRegex(ValueError, 'cannot accommodate'):
            smoke.save_fixture_budget(api)


class SmokeRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.managed = self.root / 'managed'
        inputs = {}
        for key, release_id in (('baseline', 'before'), ('candidate', 'after')):
            bundle = self.root / key
            write(bundle / 'manifest.json', {'releaseId': release_id})
            inputs[key] = str(bundle)
            inputs[key + 'Sha256'] = digest(bundle / 'manifest.json')
        self.old = {'pid': 10, 'startTicks': 1, 'executable': str(self.managed / 'releases/before/bin/yuzuno-workspace')}
        self.helper = {'pid': 11, 'startTicks': 2, 'executable': str(self.managed / 'releases/before/bin/yuzuno-update-helper')}
        self.state = {'inputs': inputs, 'requestId': 'same-request', 'workspaceId': 'same-workspace', 'owned': [self.old]}
        self.op = {'id': 'same-operation', 'requestId': 'same-request', 'workspaceId': 'same-workspace',
                   'releaseId': 'after', 'phase': 'waiting', 'oldProcess': self.old, 'helperProcess': self.helper,
                   'previous': {'releaseId': 'before', 'manifestSha256': inputs['baselineSha256']},
                   'candidate': {'releaseId': 'after', 'manifestSha256': inputs['candidateSha256']}}
        self.journal = self.managed / 'updates/state.json'
        write(self.journal, {'operation': self.op})

    def test_waits_for_same_operation_and_helper_exit(self):
        alive, observations = True, []
        def advance(_):
            nonlocal alive
            if self.op['phase'] == 'waiting':
                self.op['phase'] = 'complete'
                write(self.journal, {'operation': self.op})
            else:
                alive = False
        with patch.object(smoke.common, 'identity', side_effect=lambda _: self.helper if alive else None), \
             patch.object(smoke.time, 'sleep', side_effect=advance):
            result = smoke.reconcile_upgrade(self.managed, self.state, observations.append)
        self.assertEqual(result['id'], 'same-operation')
        self.assertEqual([(o['phase'], o['helperAlive']) for o in observations],
                         [('waiting', True), ('complete', True), ('complete', False)])

    def test_timeout_or_dead_helper_preserves_journal(self):
        original = self.journal.read_bytes()
        for process, error in ((None, RuntimeError), ({**self.helper, 'startTicks': 99}, RuntimeError), (self.helper, TimeoutError)):
            with self.subTest(process=process), patch.object(smoke.common, 'identity', return_value=process):
                with self.assertRaisesRegex(error, 'preserving'):
                    smoke.reconcile_upgrade(self.managed, self.state, lambda _: None, timeout=0)
                self.assertEqual(self.journal.read_bytes(), original)

    def test_changed_operation_or_process_identity_rejected(self):
        for key, value in (('requestId', 'another-request'), ('workspaceId', 'another-workspace'),
                           ('oldProcess', {**self.old, 'startTicks': 99}),
                           ('helperProcess', {**self.helper, 'executable': '/another/helper'})):
            with self.subTest(key=key):
                write(self.journal, {'operation': {**self.op, key: value}})
                with self.assertRaises(ValueError):
                    smoke.reconcile_upgrade(self.managed, self.state, lambda _: self.fail('accepted changed identity'))


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.sha = 'a' * 40
        self.baseline = self.base / 'baseline'
        self.baseline.mkdir()
        write(self.baseline / 'manifest.json', {'releaseId': 'core-before'})
        (self.base / 'publisher.pub').write_text('unit test placeholder, never signed')
        (self.base / 'notes.txt').write_text('Reviewed changes')
        self.root = self.base / 'release'
        args = argparse.Namespace(work_dir=self.root, repository='owner/repo', sha=self.sha,
            release_id='core-test', version='test.1', review='Accepted PR review reference', ci_run=42,
            artifact_id=7, baseline=self.baseline, public_key=self.base / 'publisher.pub', notes=self.base / 'notes.txt')
        release.initialize(args)
        self.flow = release.Flow(self.root)
        self.run = {'id': 42, 'head_sha': self.sha, 'head_repository': {'full_name': 'owner/repo'},
                    'status': 'completed', 'conclusion': 'success', 'event': 'push', 'head_branch': 'main',
                    'path': '.github/workflows/ci.yml', 'run_attempt': 2, 'html_url': 'https://github.com/owner/repo/actions/runs/42'}
        self.artifact = {'expired': False, 'name': f'core-inputs-{self.sha}-2', 'digest': 'sha256:' + 'b' * 64,
                         'workflow_run': {'id': 42, 'head_sha': self.sha}}

    def inputs(self, sdk=True, run_id='42', attempt='2'):
        source = self.base / 'inputs'
        (source / 'bin').mkdir(parents=True)
        for name in ('yuzuno-workspace', 'yuzuno-update-helper'):
            p = source / 'bin' / name
            p.write_text('fixture executable, never started')
            p.chmod(0o755)
        (source / 'licenses').mkdir()
        for name in LICENSE_FILES:
            (source / name).write_text(f'fixture {name}')
        (source / 'web/licenses').mkdir(parents=True)
        (source / 'web/index.html').write_text('<html><head></head><body>UI</body></html>')
        (source / 'web/licenses/THIRD_PARTY_NOTICES.txt').write_text('fixture web notices')
        (source / 'claude/node_modules/@anthropic-ai/sdk').mkdir(parents=True)
        (source / 'claude/node_modules/@anthropic-ai/sdk/package.json').write_text('{}')
        if sdk:
            (source / 'claude/node_modules/@anthropic-ai/claude-agent-sdk').mkdir(parents=True)
            (source / 'claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json').write_bytes(
                CLAUDE_SDK_PLACEHOLDER if sdk == 'placeholder' else b'{}')
        (source / 'result-validator').mkdir()
        (source / 'result-validator/validator.mjs').write_text('// unit fixture')
        (source / 'result-validator/THIRD_PARTY_NOTICES.txt').write_text('fixture validator notices')
        write(source / 'result-validator/contract.json', {'validator': {'sha256': digest(source / 'result-validator/validator.mjs')}})
        (source / 'windows-jobs').mkdir()
        helper = source / 'windows-jobs/yuzuno-jobs-helper.exe'
        helper.write_bytes(b'MZ fixture Windows helper, never started')
        helper.chmod(0o755)
        write(source / 'windows-jobs/windows-helper.json', {'format': 1, 'file': helper.name, 'sha256': digest(helper),
            'bytes': helper.stat().st_size, 'protocol': 1})
        product = self.base / 'product'
        product.mkdir()
        files = archive_tree(source, product / 'inputs.tar.gz')
        write(product / 'build.json', {'source': self.sha, 'tree': 'c' * 40, 'runId': run_id, 'runAttempt': attempt,
            'repository': 'owner/repo', 'platform': 'linux-x86_64', 'files': files,
            'archiveSha256': digest(product / 'inputs.tar.gz')})
        archive = self.base / 'artifact.zip'
        with zipfile.ZipFile(archive, 'w') as output:
            for name in ('build.json', 'inputs.tar.gz'):
                output.write(product / name, name)
        self.artifact['digest'] = 'sha256:' + digest(archive)
        return archive

    def fetch(self):
        archive = self.inputs()
        with patch.object(release, 'gh_json', side_effect=[self.run, self.artifact]), \
             patch.object(release, 'download', side_effect=lambda endpoint, target: shutil.copy2(archive, target)):
            self.flow.run('fetch', self.flow.fetch)

    def test_exact_successful_ci_and_artifact_are_required(self):
        release.ci_identity(self.run, self.artifact, self.flow.config)
        for key, value in [('conclusion', 'failure'), ('head_sha', 'd' * 40),
                           ('event', 'pull_request'), ('head_branch', 'other'),
                           ('path', '.github/workflows/other.yml'), ('run_attempt', 3)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                release.ci_identity({**self.run, key: value}, self.artifact, self.flow.config)
        with self.assertRaises(ValueError):
            release.ci_identity(self.run, {**self.artifact, 'expired': True}, self.flow.config)

    def inputs_flow(self):
        """A release whose artifact comes from a release-inputs run (51,
        attempt 1) and whose tests are the main CI run (42)."""
        args = argparse.Namespace(work_dir=self.base / 'release-inputs', repository='owner/repo', sha=self.sha,
            release_id='core-test', version='test.1', review='Accepted PR review reference', ci_run=42,
            artifact_id=7, inputs_run=51, baseline=self.baseline, public_key=self.base / 'publisher.pub',
            notes=self.base / 'notes.txt')
        release.initialize(args)
        self.inputs_run = {'id': 51, 'head_sha': self.sha, 'head_repository': {'full_name': 'owner/repo'},
                           'status': 'completed', 'conclusion': 'success', 'event': 'workflow_dispatch',
                           'head_branch': 'main', 'path': '.github/workflows/release-inputs.yml', 'run_attempt': 1,
                           'html_url': 'https://github.com/owner/repo/actions/runs/51'}
        self.artifact = {**self.artifact, 'name': f'core-inputs-{self.sha}-1', 'workflow_run': {'id': 51, 'head_sha': self.sha}}
        return release.Flow(self.base / 'release-inputs')

    def test_an_inputs_run_is_frozen_only_when_named(self):
        self.assertNotIn('inputsRunId', self.flow.config)
        self.assertEqual(self.inputs_flow().config['inputsRunId'], 51)

    def test_inputs_on_request_come_from_the_release_inputs_run_and_the_tests_from_main_ci(self):
        flow = self.inputs_flow()
        self.assertIs(release.ci_identity(self.run, self.artifact, flow.config, self.inputs_run), self.inputs_run)
        for key, value in [('conclusion', 'failure'), ('head_sha', 'd' * 40), ('event', 'push'),
                           ('head_branch', 'other'), ('path', '.github/workflows/ci.yml'), ('id', 52),
                           ('run_attempt', 2)]:
            with self.subTest(inputs_run=key), self.assertRaises(ValueError):
                release.ci_identity(self.run, self.artifact, flow.config, {**self.inputs_run, key: value})
        for key, value in [('conclusion', 'failure'), ('event', 'workflow_dispatch'), ('path', '.github/workflows/release-inputs.yml')]:
            with self.subTest(tests_run=key), self.assertRaises(ValueError):
                release.ci_identity({**self.run, key: value}, self.artifact, flow.config, self.inputs_run)
        with self.subTest('the artifact of the tests run'), self.assertRaisesRegex(ValueError, 'another run'):
            release.ci_identity(self.run, {**self.artifact, 'workflow_run': {'id': 42, 'head_sha': self.sha}},
                                flow.config, self.inputs_run)
        with self.subTest('the inputs run not read'), self.assertRaisesRegex(ValueError, 'not read'):
            release.ci_identity(self.run, self.artifact, flow.config)

    def test_fetch_binds_the_build_to_the_inputs_run_and_refuses_the_sdk(self):
        flow = self.inputs_flow()
        def fetch(**inputs):
            archive = self.inputs(**inputs)
            try:
                with patch.object(release, 'gh_json', side_effect=[self.run, self.inputs_run, self.artifact]), \
                     patch.object(release, 'download', side_effect=lambda endpoint, target: shutil.copy2(archive, target)):
                    flow.run('fetch', flow.fetch)
            finally:
                for path in (self.base / 'inputs', self.base / 'product'):
                    shutil.rmtree(path)
        with self.assertRaisesRegex(ValueError, 'Build metadata differs'):
            fetch(sdk=False, run_id='42', attempt='2')
        # A refused artifact was saved but never extracted; a new one replaces it.
        self.assertFalse((flow.root / 'inputs').exists())
        shutil.rmtree(flow.root / 'artifact')
        with self.assertRaisesRegex(ValueError, 'carry the Claude Agent SDK'):
            fetch(sdk=True, run_id='51', attempt='1')
        self.assertFalse((flow.root / 'inputs').exists())
        shutil.rmtree(flow.root / 'artifact')
        # As a build leaves it: the placeholder alone, with exactly its bytes.
        fetch(sdk='placeholder', run_id='51', attempt='1')
        stage = read(flow.root / 'report.json')['stages']['fetch']
        self.assertEqual(stage['inputsUrl'], self.inputs_run['html_url'])
        self.assertEqual(read(flow.root / 'ci.json')['inputsRun']['id'], 51)

    def test_download_digest_mismatch_never_adopts_artifact(self):
        archive = self.inputs()
        self.artifact['digest'] = 'sha256:' + '0' * 64
        with patch.object(release, 'gh_json', side_effect=[self.run, self.artifact]), \
             patch.object(release, 'download', side_effect=lambda endpoint, target: shutil.copy2(archive, target)), \
             self.assertRaisesRegex(ValueError, 'digest mismatch'):
            self.flow.run('fetch', self.flow.fetch)
        self.assertFalse((self.root / 'artifact').exists())
        report = read(self.root / 'report.json')
        self.assertEqual(report['resumeAt'], 'fetch')
        self.assertEqual(report['attempts'][0]['status'], 'failed')

    def test_fetch_download_uses_default_github_api_headers(self):
        archive = self.inputs()
        def download(argv, *, stdout, check, timeout):
            self.assertEqual(argv, ['gh', 'api', 'repos/owner/repo/actions/artifacts/7/zip'])
            self.assertTrue(check)
            self.assertEqual(timeout, 300)
            stdout.write(archive.read_bytes())
        with patch.object(release, 'gh_json', side_effect=[self.run, self.artifact]), \
             patch.object(release.subprocess, 'run', side_effect=download) as calls:
            self.flow.run('fetch', self.flow.fetch)
        self.assertEqual(calls.call_count, 1)
        self.assertEqual((self.root / 'artifact/artifact.zip').read_bytes(), archive.read_bytes())

    def test_verify_download_requests_release_asset_bytes(self):
        signed = self.root / 'signed'
        signed.mkdir()
        payloads, assets, expected = {}, [], []
        for asset_id, suffix in enumerate(('.json', '.json.minisig', '.tar.gz'), start=1):
            name = 'yuzuno-core-linux-x86_64' + suffix
            path = signed / name
            path.write_bytes(('signed fixture ' + suffix).encode())
            payloads[str(asset_id)] = path.read_bytes()
            assets.append({'id': asset_id, 'name': name})
            expected.append({'name': name, 'bytes': path.stat().st_size, 'sha256': digest(path)})
        self.flow.report['stages']['sign'] = {'assets': expected}
        remote = {'id': 10, 'draft': False, 'prerelease': False, 'assets': assets,
                  'html_url': 'https://github.com/owner/repo/releases/tag/core-test'}
        def download(argv, *, stdout, check, timeout):
            asset_id = argv[-1].rsplit('/', 1)[1]
            self.assertEqual(argv, ['gh', 'api', '-H', 'Accept: application/octet-stream',
                                    f'repos/owner/repo/releases/assets/{asset_id}'])
            self.assertTrue(check)
            self.assertEqual(timeout, 300)
            stdout.write(payloads[asset_id])
        def verify(directory):
            self.assertEqual(sorted(p.name for p in directory.iterdir()), sorted(a['name'] for a in assets))
            for asset in assets:
                self.assertEqual((directory / asset['name']).read_bytes(), payloads[str(asset['id'])])
        with patch.object(self.flow, 'remote_release', return_value=remote), \
             patch.object(self.flow, 'tag'), patch.object(self.flow, 'signed', side_effect=verify) as verified, \
             patch.object(release.subprocess, 'run', side_effect=download) as calls:
            result = self.flow.verify_download()
        self.assertEqual(calls.call_count, 3)
        verified.assert_called_once()
        self.assertEqual(result['receipt']['assets'], expected)
        self.assertTrue(read(self.root / 'download.json')['passed'])

    def test_prepare_packaging_and_crash_recovery_reuse_same_bytes(self):
        self.fetch()
        # Simulate package completing before its stage receipt was saved.
        result = self.flow.package()
        manifest = (self.root / 'bundle/manifest.json').read_bytes()
        recovered = release.Flow(self.root)
        with patch.object(recovered, 'execute', side_effect=AssertionError('must not package again')):
            recovered.run('package', recovered.package)
        self.assertEqual(result['manifestSha256'], recovered.report['stages']['package']['manifestSha256'])
        self.assertEqual(manifest, (self.root / 'bundle/manifest.json').read_bytes())

    def test_the_bundle_carries_the_project_license_and_every_notices_file(self):
        self.fetch()
        self.flow.package()
        files = json.loads((self.root / 'bundle/manifest.json').read_text())['files']
        for name in [*LICENSE_FILES, 'web/licenses/THIRD_PARTY_NOTICES.txt',
                     'runtimes/result-validator/THIRD_PARTY_NOTICES.txt']:
            self.assertIn(name, files)
            self.assertEqual(files[name]['sha256'], digest(self.root / 'bundle' / name))

    def test_the_bundle_carries_the_windows_helper_from_the_fixed_inputs(self):
        self.fetch()
        self.flow.package()
        files = json.loads((self.root / 'bundle/manifest.json').read_text())['files']
        inputs = self.root / 'inputs/windows-jobs'
        self.assertEqual(files['runtimes/windows-jobs/yuzuno-jobs-helper.exe'],
                         {'sha256': digest(inputs / 'yuzuno-jobs-helper.exe'), 'bytes': (inputs / 'yuzuno-jobs-helper.exe').stat().st_size,
                          'executable': True})
        self.assertFalse(files['runtimes/windows-jobs/windows-helper.json']['executable'])

    def test_a_windows_helper_swapped_after_ci_is_not_packaged(self):
        self.fetch()
        helper = self.root / 'inputs/windows-jobs/yuzuno-jobs-helper.exe'
        helper.write_bytes(b'MZ another helper')
        with self.assertRaisesRegex(ValueError, 'contents changed'):
            self.flow.run('package', self.flow.package)
        self.assertFalse((self.root / 'bundle').exists())

    def test_changed_bundle_cannot_be_adopted_after_interruption(self):
        self.fetch()
        self.flow.package()
        path = self.root / 'bundle/web/index.html'
        path.chmod(0o644)
        path.write_text('modified UI')
        with self.assertRaisesRegex(ValueError, 'contents differ'):
            self.flow.run('package', self.flow.package)

    def test_resume_skips_completed_stages_and_preserves_failure(self):
        output = self.root / 'product'
        output.write_text('fixed artifact')
        self.flow.run('fetch', lambda: {'outputs': {'product': digest(output)}})
        with self.assertRaisesRegex(RuntimeError, 'specific assertion'):
            self.flow.run('package', lambda: (_ for _ in ()).throw(RuntimeError('specific assertion')))
        resumed = release.Flow(self.root)
        resumed.run('fetch', lambda: self.fail('completed stage repeated'))
        resumed.run('package', lambda: {'evidence': 'only failed stage continued'})
        self.assertEqual([a['status'] for a in resumed.report['attempts']], ['passed', 'failed', 'passed'])
        self.assertEqual(resumed.report['resumeAt'], 'sign')
        output.write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'output changed'):
            resumed.run('sign', lambda: self.fail('must reject tampered bytes before signing'))

    def test_frozen_identity_cannot_change(self):
        changed = {**read(self.root / 'release.json'), 'source': 'b' * 40}
        write(self.root / 'release.json', changed)
        with self.assertRaisesRegex(ValueError, 'Frozen inputs changed'):
            release.Flow(self.root)

    def test_resume_never_publishes(self):
        calls = []
        with patch.object(self.flow, 'run', side_effect=lambda name, action: calls.append(name)), \
             patch.object(self.flow, 'publish', side_effect=AssertionError('unexpected publication')):
            self.flow.prepare()
        self.assertEqual(calls, ['fetch', 'package', 'sign', 'smoke'])

    def test_health_can_refresh_without_repeating_other_stages(self):
        calls = []
        self.flow.run('health', lambda: calls.append(1), fresh=True)
        self.flow.run('health', lambda: calls.append(2), fresh=True)
        self.assertEqual(calls, [1, 2])

    def test_network_failure_is_not_absent_release(self):
        result = argparse.Namespace(returncode=1, stdout='', stderr='HTTP 403 denied')
        with patch.object(release.subprocess, 'run', return_value=result), self.assertRaises(RuntimeError):
            release.optional_gh_json('repos/owner/repo/releases/tags/core-test')

    def test_interrupted_sign_receipt_reuses_the_existing_signature(self):
        self.flow.signing_key = self.base / 'existing-key-path-not-read'
        signed = self.root / 'signed'
        paths = [signed / ('asset' + suffix) for suffix in ('.json', '.minisig', '.tar.gz')]
        def signer(argv):
            self.assertIn('sign-core-release.py', str(argv[1]))
            signed.mkdir()
            for path in paths:
                path.write_text('signed fixture bytes')
        with patch.object(self.flow, 'execute', side_effect=signer) as calls, \
             patch.object(self.flow, 'signed', return_value=paths):
            first = self.flow.sign()  # process lost its receipt after rename
            self.flow.run('sign', self.flow.sign)
        self.assertEqual(calls.call_count, 1)
        self.assertEqual(first['assets'], self.flow.report['stages']['sign']['assets'])

    def test_lost_upload_reply_resumes_only_missing_assets_then_publishes(self):
        signed = self.root / 'signed'
        signed.mkdir()
        paths = [signed / ('asset' + suffix) for suffix in ('.json', '.minisig', '.tar.gz')]
        for path in paths:
            path.write_text(path.name)
        self.flow.report['stages']['smoke'] = {'status': 'passed'}
        remote = {'id': 10, 'draft': True, 'assets': [], 'html_url': 'https://github.com/owner/repo/releases/tag/core-test',
                  'upload_url': 'https://uploads.github.com/repos/owner/repo/releases/10/assets{?name,label}'}
        uploads = []
        def mutate(argv):
            if '--input' in argv:
                path = Path(argv[argv.index('--input') + 1])
                self.assertEqual(argv[4], f'https://uploads.github.com/repos/owner/repo/releases/10/assets?name={path.name}')
                uploads.append(path.name)
                remote['assets'].append({'name': path.name, 'size': path.stat().st_size, 'digest': 'sha256:' + digest(path)})
                if len(uploads) == 1:
                    raise RuntimeError('reply lost after accepted upload')
            elif argv == ['--method', 'PATCH', 'repos/owner/repo/releases/10', '-F', 'draft=false']:
                remote['draft'] = False
            else:
                self.fail(f'Unexpected mutation: {argv}')
        with patch.object(self.flow, 'signed', return_value=paths), \
             patch.object(self.flow, 'tag'), patch.object(self.flow, 'api', side_effect=mutate), \
             patch.object(self.flow, 'execute', side_effect=AssertionError('no other write')), \
             patch.object(self.flow, 'remote_release', side_effect=lambda **kwargs: remote), \
             patch.object(release, 'optional_gh_json', return_value=remote):
            with self.assertRaisesRegex(RuntimeError, 'reply lost'):
                self.flow.run('publish', self.flow.publish)
            self.flow.run('publish', self.flow.publish)
        self.assertEqual(uploads, [p.name for p in paths])
        self.assertFalse(remote['draft'])
        self.assertEqual([a['status'] for a in self.flow.report['attempts']], ['failed', 'passed'])

    def test_draft_creation_and_restart_reuse_same_remote_id(self):
        for lost_at in ('create', 'upload'):
            with self.subTest(lost_at=lost_at):
                root = self.base / ('lost-' + lost_at)
                shutil.copytree(self.root, root)
                flow = release.Flow(root)
                signed = root / 'signed'
                signed.mkdir()
                paths = [signed / ('asset' + suffix) for suffix in ('.json', '.minisig', '.tar.gz')]
                for path in paths:
                    path.write_text(path.name)
                flow.report['stages']['smoke'] = {'status': 'passed'}
                remote, lost, creates, edits, uploads, reads = None, False, [], [], [], []
                endpoint = 'repos/owner/repo/releases'
                def optional_api(url):
                    if '/git/ref/tags/' in url:
                        return {'object': {'type': 'commit', 'sha': self.sha}}
                    self.assertEqual(url, endpoint + '/tags/core-test')
                    return remote if remote and not remote['draft'] else None
                def api(url):
                    reads.append(url)
                    if '/git/ref/tags/' in url:
                        return {'object': {'type': 'commit', 'sha': self.sha}}
                    if url == endpoint + '?per_page=100&page=1':
                        return [remote] if remote else []
                    if url == endpoint + '/10':
                        return remote
                    if url == endpoint + '/tags/core-test':
                        if not remote or remote['draft']:
                            raise RuntimeError('gh: Not Found (HTTP 404)')
                        return remote
                    self.fail(f'Unexpected API read: {url}')
                def mutate(argv):
                    nonlocal remote, lost
                    if argv[:3] == ['--method', 'POST', endpoint]:
                        operation = 'create'
                        creates.append(argv)
                        self.assertIn('draft=true', argv)
                        self.assertIn(f'target_commitish={self.sha}', argv)
                        remote = {'id': 10, 'tag_name': 'core-test', 'target_commitish': self.sha,
                                  'draft': True, 'assets': [], 'html_url': 'https://github.com/owner/repo/releases/tag/core-test',
                                  'upload_url': 'https://uploads.github.com/repos/owner/repo/releases/10/assets{?name,label}'}
                    elif '--input' in argv:
                        operation = 'upload'
                        path = Path(argv[argv.index('--input') + 1])
                        uploads.append(path.name)
                        remote['assets'].append({'name': path.name, 'size': path.stat().st_size,
                                                 'digest': 'sha256:' + digest(path)})
                    elif argv[:3] == ['--method', 'PATCH', endpoint + '/10']:
                        operation = 'edit'
                        edits.append(argv)
                        remote['draft'] = False
                    else:
                        self.fail(f'Unexpected mutation: {argv}')
                    if operation == lost_at and not lost:
                        lost = True
                        raise RuntimeError('reply lost after accepted mutation')
                    return remote
                with patch.object(release, 'optional_gh_json', side_effect=optional_api), \
                     patch.object(release, 'gh_json', side_effect=api), \
                     patch.object(release.Flow, 'signed', return_value=paths), \
                     patch.object(release.Flow, 'api', side_effect=mutate), \
                     patch.object(release.Flow, 'execute', side_effect=AssertionError('no other write')):
                    with self.assertRaisesRegex(RuntimeError, 'reply lost'):
                        flow.run('publish', flow.publish)
                    recovered = release.Flow(root)
                    recovered.run('publish', recovered.publish)
                    release.Flow(root).publish()  # also reconcile an already published release
                self.assertEqual(len(creates), 1)
                self.assertEqual(uploads, [p.name for p in paths])
                self.assertEqual(len(edits), 1)
                self.assertFalse(remote['draft'])
                self.assertIn(endpoint + '/10', reads)
                self.assertNotIn(endpoint + '/tags/core-test', reads)
                self.assertEqual(read(root / 'remote-release.json')['id'], 10)
                self.assertEqual(read(root / 'publication.json')['id'], 10)
                self.assertEqual([a['status'] for a in recovered.report['attempts']], ['failed', 'passed'])

    def test_draft_discovery_paginates_and_pins_id_for_restart(self):
        value = {'id': 10, 'tag_name': 'core-test', 'target_commitish': self.sha, 'draft': True}
        with patch.object(release, 'optional_gh_json', return_value=None), \
             patch.object(release, 'gh_json', side_effect=[[{'tag_name': 'other'}] * 100, [value], value]) as calls:
            self.assertEqual(self.flow.remote_release(), value)
        self.assertEqual([c.args[0] for c in calls.call_args_list],
                         ['repos/owner/repo/releases?per_page=100&page=1',
                          'repos/owner/repo/releases?per_page=100&page=2', 'repos/owner/repo/releases/10'])
        with patch.object(release, 'optional_gh_json', side_effect=AssertionError('must use saved ID')), \
             patch.object(release, 'gh_json', return_value=value) as calls:
            self.assertEqual(release.Flow(self.root).remote_release(), value)
        calls.assert_called_once_with('repos/owner/repo/releases/10')

    def test_only_tag_404_allows_draft_discovery(self):
        for status in (403, 404, 500):
            with self.subTest(status=status):
                response = argparse.Namespace(returncode=1, stdout='', stderr=f'gh: failed (HTTP {status})')
                with patch.object(release.subprocess, 'run', return_value=response), \
                     patch.object(release, 'gh_json', return_value=[]) as reads:
                    if status == 404:
                        self.assertIsNone(self.flow.remote_release(missing_ok=True))
                        reads.assert_called_once_with('repos/owner/repo/releases?per_page=100&page=1')
                    else:
                        with self.assertRaisesRegex(RuntimeError, f'HTTP {status}'):
                            self.flow.remote_release(missing_ok=True)
                        reads.assert_not_called()

    def test_pinned_release_rejects_changed_tag_source_or_id(self):
        write(self.root / 'remote-release.json', {'repository': 'owner/repo', 'tag': 'core-test',
                                                'source': self.sha, 'id': 10})
        value = {'id': 10, 'tag_name': 'core-test', 'target_commitish': self.sha}
        for key, changed in (('id', 11), ('tag_name', 'another-tag'), ('target_commitish', 'b' * 40)):
            with self.subTest(key=key), patch.object(release, 'gh_json', return_value={**value, key: changed}), \
                 self.assertRaisesRegex(ValueError, 'Remote release'):
                self.flow.remote_release()
        with patch.object(release, 'gh_json', side_effect=RuntimeError('HTTP 404')), \
             patch.object(release, 'optional_gh_json', side_effect=AssertionError('must not replace saved ID')), \
             self.assertRaisesRegex(RuntimeError, 'HTTP 404'):
            self.flow.remote_release()

    def test_unknown_create_without_visible_draft_cannot_create_again(self):
        write(self.root / 'remote-release.json', {'repository': 'owner/repo', 'tag': 'core-test',
                                                'source': self.sha, 'id': None})
        self.flow.report['stages']['smoke'] = {'status': 'passed'}
        def lookup(url):
            return {'object': {'type': 'commit', 'sha': self.sha}} if '/git/ref/' in url else None
        with patch.object(release, 'optional_gh_json', side_effect=lookup), \
             patch.object(release, 'gh_json', return_value=[]), patch.object(self.flow, 'tag'), \
             patch.object(self.flow, 'signed', return_value=[]), patch.object(self.flow, 'execute') as mutations, \
             patch.object(self.flow, 'api') as writes:
            with self.assertRaisesRegex(ValueError, 'already attempted'):
                self.flow.publish()
        mutations.assert_not_called()
        writes.assert_not_called()

    def test_existing_draft_assets_are_not_overwritten(self):
        path = self.base / 'asset.json'
        path.write_text('expected signed bytes')
        self.flow.report['stages']['smoke'] = {'status': 'passed'}
        for asset in ({'name': 'unexpected'}, {'name': path.name, 'size': path.stat().st_size,
                                              'digest': 'sha256:' + '0' * 64}):
            value = {'id': 10, 'tag_name': 'core-test', 'target_commitish': self.sha,
                     'draft': True, 'assets': [asset]}
            def optional_api(url):
                return {'object': {'type': 'commit', 'sha': self.sha}} if '/git/ref/' in url else None
            def api(url):
                return [value] if '?per_page=' in url else value
            with self.subTest(asset=asset), patch.object(release, 'optional_gh_json', side_effect=optional_api), \
                 patch.object(release, 'gh_json', side_effect=api), patch.object(self.flow, 'tag'), \
                 patch.object(self.flow, 'signed', return_value=[path]), patch.object(self.flow, 'execute') as mutations, \
                 patch.object(self.flow, 'api') as writes:
                with self.assertRaisesRegex(ValueError, 'Unexpected remote|Remote asset differs'):
                    self.flow.publish()
            mutations.assert_not_called()
            writes.assert_not_called()

    def test_ambiguous_or_truncated_discovery_does_not_report_absence(self):
        for entries, error in (([{'tag_name': 'core-test'}] * 2, 'Multiple releases'),
                               ([{'tag_name': 'other'}] * 100, 'discovery limit')):
            with self.subTest(error=error), patch.object(release, 'optional_gh_json', return_value=None), \
                 patch.object(release, 'gh_json', return_value=entries), self.assertRaisesRegex(ValueError, error):
                self.flow.remote_release(missing_ok=True)
        self.assertFalse((self.root / 'remote-release.json').exists())

    def test_fresh_failed_health_is_not_reported_as_current_success(self):
        self.flow.run('health', lambda: {'evidence': 'earlier health'}, fresh=True)
        with self.assertRaises(RuntimeError):
            self.flow.run('health', lambda: (_ for _ in ()).throw(RuntimeError('Core not reachable')), fresh=True)
        self.assertEqual(self.flow.report['stages']['health']['status'], 'failed')
        self.assertEqual(self.flow.report['stages']['health']['previous']['status'], 'passed')

    # Publication against tools/fixtures/fake-gh.py, run as `gh`: the real subprocess calls, with
    # GitHub's tags and releases in a JSON file. T-183: core.17's first publish created the draft,
    # then found no release for the tag and stopped with "Remote release not found".

    def fake_github(self, releases=(), refs=None, **faults):
        bin_dir = self.base / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'gh').symlink_to(Path(__file__).resolve().with_name('fixtures') / 'fake-gh.py')
        state = self.base / 'github.json'
        write(state, {'repository': 'owner/repo', 'refs': {'core-test': self.sha} if refs is None else refs,
                      'releases': list(releases), 'nextId': 10, 'nextAsset': 100, 'faults': faults, 'calls': [],
                      'writes': {'tag': 0, 'create': [], 'upload': [], 'publish': 0}})
        for patcher in (patch.dict(os.environ, {'PATH': f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                                                'FAKE_GH_STATE': str(state)}),
                        patch.object(release.Flow, 'signed', return_value=self.signed_files())):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.flow.report['stages']['smoke'] = {'status': 'passed'}
        write(self.flow.report_path, self.flow.report)
        return lambda: read(state)

    def signed_files(self):
        signed = self.root / 'signed'
        signed.mkdir()
        self.paths = [signed / ('yuzuno-core-linux-x86_64' + suffix) for suffix in ('.json', '.json.minisig', '.tar.gz')]
        for path in self.paths:
            path.write_text(f'signed fixture {path.name}')
        return self.paths

    def publish(self):
        """One publish attempt, as a new process would make it; returns its error or None."""
        flow = release.Flow(self.root)
        try:
            flow.run('publish', flow.publish)
        except (Exception, KeyboardInterrupt) as error:
            return f'{type(error).__name__}: {error}'

    def lists(self, state):
        return [i for i, call in enumerate(state['calls']) if '?per_page=' in call[-1]]

    def creates(self, state):
        return [i for i, call in enumerate(state['calls'])
                if call[:4] == ['api', '--method', 'POST', 'repos/owner/repo/releases'] or call[:2] == ['release', 'create']]

    def assert_published_once(self, state, release_id, creates=1):
        self.assertEqual(len(state['writes']['create']), creates)
        self.assertEqual(sorted(state['writes']['upload']), sorted(p.name for p in self.paths), 'each asset uploaded once')
        self.assertEqual(state['writes']['publish'], 1)
        self.assertEqual(state['writes']['tag'], 0)
        [remote] = [r for r in state['releases'] if r['tag_name'] == 'core-test']
        self.assertEqual((remote['id'], remote['target_commitish'], remote['draft']), (release_id, self.sha, False))
        self.assertEqual({a['name']: (a['size'], a['digest']) for a in remote['assets']},
                         {p.name: (p.stat().st_size, 'sha256:' + digest(p)) for p in self.paths})
        self.assertEqual(state['refs'], {'core-test': self.sha})
        self.assertEqual(read(self.root / 'remote-release.json'),
                         {'repository': 'owner/repo', 'tag': 'core-test', 'source': self.sha, 'id': release_id})
        self.assertEqual(read(self.root / 'publication.json')['id'], release_id)
        self.assertEqual(read(self.root / 'report.json')['stages']['publish']['releaseId'], release_id)

    def receipt_id(self):
        return read(self.root / 'remote-release.json')['id']

    def test_a_listing_that_misses_the_new_draft_does_not_stop_publication(self):
        github = self.fake_github(listHides=1)
        self.assertIsNone(self.publish())
        state = github()
        self.assert_published_once(state, 10)
        self.assertEqual(state['writes']['create'], [{'tag_name': 'core-test', 'target_commitish': self.sha, 'name': 'test.1',
                                                      'body': 'Reviewed changes', 'draft': True, 'prerelease': False}])
        # Only the lookup before creation listed releases; the miss it would have hit was never used.
        [listed], [created] = self.lists(state), self.creates(state)
        self.assertLess(listed, created)
        self.assertEqual(state['faults']['listHides'], 1)
        [remote] = state['releases']
        self.assertEqual([a['content_type'] for a in remote['assets']],
                         ['application/json', 'application/octet-stream', 'application/x-gtar'])

    def test_a_draft_not_yet_readable_by_id_is_resumed_by_that_id(self):
        github = self.fake_github(listHides=99, idHides=1)
        first = self.publish()
        self.assertEqual(first, 'RuntimeError: GitHub read failed: gh: Not Found (HTTP 404)')
        self.assertEqual(self.receipt_id(), 10)
        self.assertEqual(github()['writes']['upload'], [])
        self.assertIsNone(self.publish())
        state = github()
        self.assert_published_once(state, 10)
        self.assertEqual(len(self.lists(state)), 1, 'the draft was never looked up by tag')
        attempts = read(self.root / 'report.json')['attempts']
        self.assertEqual([(a['status'], a.get('error')) for a in attempts], [('failed', first), ('passed', None)])

    def test_a_lost_create_reply_adopts_the_one_listed_draft_and_never_creates_again(self):
        github = self.fake_github(loseReply=['create'], listHides=1)
        first = self.publish()
        self.assertRegex(first, r"^CalledProcessError: Command '\['gh', 'api', '--method', 'POST', 'repos/owner/repo/releases'")
        self.assertIsNone(self.receipt_id())
        log = (self.root / read(self.root / 'report.json')['attempts'][0]['log']).read_text()
        self.assertIn('error connecting to api.github.com', log)
        # Until the draft is listed, resuming stops rather than creating another.
        self.assertEqual(self.publish(), 'ValueError: Draft creation was already attempted; reconcile before creating another release')
        self.assertEqual((len(github()['writes']['create']), github()['writes']['upload']), (1, []))
        self.assertIsNone(self.publish())
        state = github()
        self.assert_published_once(state, 10)
        self.assertEqual(len(self.creates(state)), 1)
        attempts = read(self.root / 'report.json')['attempts']
        self.assertEqual([a['status'] for a in attempts], ['failed', 'failed', 'passed'])
        self.assertEqual(attempts[0]['error'], first)

    def test_an_interruption_between_reply_and_receipt_adopts_the_listed_draft(self):
        github = self.fake_github()
        written = release.write
        def interrupted(path, value):
            if Path(path).name == 'remote-release.json' and value['id'] is not None:
                raise KeyboardInterrupt
            written(path, value)
        with patch.object(release, 'write', side_effect=interrupted):
            self.assertEqual(self.publish(), 'KeyboardInterrupt: ')
        self.assertIsNone(self.receipt_id())
        self.assertEqual(len(github()['writes']['create']), 1)
        self.assertIsNone(self.publish())
        self.assert_published_once(github(), 10)

    def test_an_interruption_before_the_create_request_never_creates(self):
        github = self.fake_github()
        with patch.object(release.Flow, 'api', side_effect=KeyboardInterrupt):
            self.assertEqual(self.publish(), 'KeyboardInterrupt: ')
        self.assertIsNone(self.receipt_id())
        # No release exists and none is created: the stop is left for inspection.
        self.assertEqual(self.publish(), 'ValueError: Draft creation was already attempted; reconcile before creating another release')
        state = github()
        self.assertEqual((state['releases'], self.creates(state), state['writes']['upload']), ([], [], []))

    def test_two_listed_drafts_after_a_lost_reply_stop_before_any_upload(self):
        github = self.fake_github(loseReply=['create'])
        self.assertRegex(self.publish(), '^CalledProcessError')
        state = github()
        state['releases'].append({**state['releases'][0], 'id': 11, '_new': False})
        write(self.base / 'github.json', state)
        for _ in range(2):
            self.assertEqual(self.publish(), 'ValueError: Multiple releases match the frozen tag; reconcile before continuing')
        state = github()
        self.assertIsNone(self.receipt_id())
        self.assertEqual((len(state['writes']['create']), state['writes']['upload'], state['writes']['publish']), (1, [], 0))

    def test_a_created_release_with_another_source_is_neither_pinned_nor_used(self):
        github = self.fake_github(createSource='b' * 40)
        for _ in range(2):  # the reply, then the listed release on resume
            self.assertEqual(self.publish(), 'ValueError: Remote release tag/source differs from frozen release')
            self.assertIsNone(self.receipt_id())
        state = github()
        self.assertEqual((len(state['writes']['create']), state['writes']['upload'], state['writes']['publish']), (1, [], 0))

    def test_a_pinned_release_whose_tag_changed_stops(self):
        github = self.fake_github(listHides=99, idHides=1)
        self.assertRegex(self.publish(), 'HTTP 404')
        state = github()
        state['releases'][0]['tag_name'] = 'core-other'
        write(self.base / 'github.json', state)
        self.assertEqual(self.publish(), 'ValueError: Remote release tag/source differs from frozen release')
        self.assertEqual(self.receipt_id(), 10)
        self.assertEqual((github()['writes']['upload'], github()['writes']['publish']), ([], 0))

    def test_a_tag_on_another_commit_stops_before_creation(self):
        github = self.fake_github(refs={'core-test': 'c' * 40})
        self.assertEqual(self.publish(), 'ValueError: Release tag points at another commit')
        state = github()
        self.assertEqual((state['releases'], state['writes']['tag'], state['refs']), ([], 0, {'core-test': 'c' * 40}))
        self.assertFalse((self.root / 'remote-release.json').exists())

    def test_an_upload_url_for_another_release_stops_before_uploading(self):
        github = self.fake_github(uploadUrlId=999)
        self.assertEqual(self.publish(), 'ValueError: Upload URL names another release')
        state = github()
        self.assertEqual((len(state['writes']['create']), state['writes']['upload'], state['writes']['publish']), (1, [], 0))
        self.assertTrue(state['releases'][0]['draft'])

    def test_a_lost_upload_reply_reuses_the_uploaded_asset(self):
        github = self.fake_github(loseReply=['upload'])
        self.assertRegex(self.publish(), "^CalledProcessError: Command '\\['gh', 'api', '--method', 'POST', '-H'")
        self.assertEqual(github()['writes']['upload'], [self.paths[0].name])
        self.assertIsNone(self.publish())
        self.assert_published_once(github(), 10)

    def test_a_pinned_draft_with_some_assets_gets_only_the_missing_ones(self):
        path = self.base / 'existing.json'
        path.write_text('signed fixture yuzuno-core-linux-x86_64.json')
        asset = {'id': 1, 'name': 'yuzuno-core-linux-x86_64.json', 'size': path.stat().st_size,
                 'digest': 'sha256:' + digest(path), 'content_type': 'application/json'}
        github = self.fake_github(releases=[{'id': 7, 'tag_name': 'core-test', 'target_commitish': self.sha, 'name': 'test.1',
                                             'body': 'Reviewed changes', 'draft': True, 'prerelease': False,
                                             'assets': [asset], '_untagged': '7'}])
        write(self.root / 'remote-release.json', {'repository': 'owner/repo', 'tag': 'core-test', 'source': self.sha, 'id': 7})
        self.assertIsNone(self.publish())
        state = github()
        self.assertEqual(state['writes']['upload'], [p.name for p in self.paths[1:]])
        self.assertEqual((state['writes']['create'], state['writes']['publish']), ([], 1))
        self.assertEqual(read(self.root / 'publication.json')['id'], 7)

    def test_a_remote_asset_with_another_digest_stops_without_changes(self):
        asset = {'id': 1, 'name': 'yuzuno-core-linux-x86_64.json', 'size': len('signed fixture yuzuno-core-linux-x86_64.json'),
                 'digest': 'sha256:' + '0' * 64, 'content_type': 'application/json'}
        github = self.fake_github(releases=[{'id': 7, 'tag_name': 'core-test', 'target_commitish': self.sha, 'name': 'test.1',
                                             'body': 'Reviewed changes', 'draft': True, 'prerelease': False,
                                             'assets': [asset], '_untagged': '7'}])
        before = github()['releases']
        for _ in range(2):
            self.assertEqual(self.publish(), 'ValueError: Remote asset differs; do not clobber or sign again')
        state = github()
        self.assertEqual((state['releases'], state['writes']), (before, {'tag': 0, 'create': [], 'upload': [], 'publish': 0}))
        self.assertEqual(self.receipt_id(), 7)

    def test_an_uploaded_asset_with_another_digest_is_not_published(self):
        github = self.fake_github(uploadDigest='sha256:' + '0' * 64)
        self.assertEqual(self.publish(), 'ValueError: Uploaded asset digest differs')
        state = github()
        self.assertEqual((len(state['writes']['upload']), state['writes']['publish']), (3, 0))
        self.assertTrue(state['releases'][0]['draft'])

    def test_a_lost_publish_reply_is_confirmed_without_another_write(self):
        github = self.fake_github(loseReply=['publish'])
        self.assertRegex(self.publish(), "^CalledProcessError: Command '\\['gh', 'api', '--method', 'PATCH'")
        self.assertFalse(github()['releases'][0]['draft'])
        self.assertIsNone(self.publish())
        self.assert_published_once(github(), 10)


class ArchiveTests(unittest.TestCase):
    def test_traversal_links_duplicates_and_file_directory_conflicts_are_rejected(self):
        for members in [('../outside',), ('/absolute',), ('link',), ('same', 'same'), ('parent', 'parent/file')]:
            with self.subTest(members=members), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                archive = root / 'input.tar'
                with tarfile.open(archive, 'w') as tar:
                    for name in members:
                        item = tarfile.TarInfo(name)
                        if name == 'link':
                            item.type, item.linkname = tarfile.SYMTYPE, '/tmp'
                            tar.addfile(item)
                        else:
                            item.size = 1
                            tar.addfile(item, io.BytesIO(b'x'))
                with self.assertRaises(ValueError):
                    extract(archive, root / 'output')
                self.assertFalse((root / 'output').exists())


if __name__ == '__main__':
    unittest.main()
