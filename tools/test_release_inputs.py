"""tools/release-inputs-check.py, the release-inputs workflow's check before
upload (T-159); no network, build or keys."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from claude_sdk_release import leave_out_sdk
from release_common import CLAUDE_SDK_PLACEHOLDER, archive_tree, claude_sdk_files, digest, write

CHECK = Path(__file__).with_name('release-inputs-check.py')
spec = importlib.util.spec_from_file_location('release_inputs_check', CHECK)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

SDK = 'claude/node_modules/@anthropic-ai/claude-agent-sdk'
PLACEHOLDER = f'{SDK}/package.json'


class ReleaseInputsCheck(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.env = {'GITHUB_SHA': 'a' * 40, 'GITHUB_REPOSITORY': 'owner/repo',
                    'GITHUB_RUN_ID': '51', 'GITHUB_RUN_ATTEMPT': '1'}

    def product(self, extra=(), contents=()):
        base = Path(tempfile.mkdtemp(dir=self.base))
        source = base / 'inputs'
        for name in ('bin/yuzuno-workspace', 'claude/bridge.mjs',
                     'claude/node_modules/@anthropic-ai/sdk/package.json', *extra):
            (source / name).parent.mkdir(parents=True, exist_ok=True)
            (source / name).write_text(f'fixture {name}')
        for name, data in dict(contents).items():
            (source / name).parent.mkdir(parents=True, exist_ok=True)
            (source / name).write_bytes(data)
        product = base / 'product'
        product.mkdir()
        files = archive_tree(source, product / 'inputs.tar.gz')
        write(product / 'build.json', {'source': 'a' * 40, 'repository': 'owner/repo', 'runId': '51',
                                       'runAttempt': '1', 'files': files,
                                       'archiveSha256': digest(product / 'inputs.tar.gz')})
        return product

    def test_inputs_of_this_run_without_the_sdk_pass(self):
        self.assertEqual(check.problems(self.product(), self.env), [])

    def test_another_commit_run_attempt_or_repository_is_reported(self):
        product = self.product()
        for variable, value in [('GITHUB_SHA', 'b' * 40), ('GITHUB_RUN_ID', '52'),
                                ('GITHUB_RUN_ATTEMPT', '2'), ('GITHUB_REPOSITORY', 'owner/other')]:
            with self.subTest(variable):
                found = check.problems(product, {**self.env, variable: value})
                self.assertEqual(len(found), 1, found)
                self.assertIn(variable, found[0])
        with self.subTest('outside a workflow run'):
            self.assertEqual(len(check.problems(product, {})), 4)

    def test_a_changed_archive_is_reported(self):
        product = self.product()
        (product / 'inputs.tar.gz').write_bytes(b'other bytes')
        self.assertIn('inputs.tar.gz is not the archive build.json describes', check.problems(product, self.env))

    def test_any_sdk_file_is_reported_and_the_cli_fails(self):
        for extra in (f'{SDK}/package.json', f'{SDK}/sdk.mjs', f'{SDK}-linux-x64/claude'):
            with self.subTest(extra):
                product = self.product([extra])
                found = check.problems(product, self.env)
                self.assertEqual(len(found), 1, found)
                self.assertIn('Claude Agent SDK', found[0])
                run = subprocess.run([sys.executable, str(CHECK), str(product)], env=self.env,
                                     capture_output=True, text=True)
                self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
                self.assertIn('::error::the inputs carry the Claude Agent SDK', run.stdout)

    def test_the_placeholder_alone_with_exactly_its_bytes_passes(self):
        self.assertEqual(check.problems(self.product(contents={PLACEHOLDER: CLAUDE_SDK_PLACEHOLDER}), self.env), [])
        for name, contents, reported in [
                ('a file beside it', {PLACEHOLDER: CLAUDE_SDK_PLACEHOLDER, f'{SDK}/sdk.mjs': b'x'}, f'{SDK}/sdk.mjs'),
                ('other bytes', {PLACEHOLDER: CLAUDE_SDK_PLACEHOLDER + b' '}, PLACEHOLDER),
                ('its bytes at another path', {f'{SDK}/sdk.mjs': CLAUDE_SDK_PLACEHOLDER}, f'{SDK}/sdk.mjs'),
                ('its bytes in a platform package', {f'{SDK}-linux-x64/package.json': CLAUDE_SDK_PLACEHOLDER},
                 f'{SDK}-linux-x64/package.json')]:
            with self.subTest(name):
                found = check.problems(self.product(contents=contents), self.env)
                self.assertEqual(len(found), 1, found)
                self.assertIn(f'1 files, for example {reported}', found[0])

    def test_the_placeholder_entry_must_match_in_every_field(self):
        exact = {'sha256': hashlib.sha256(CLAUDE_SDK_PLACEHOLDER).hexdigest(),
                 'bytes': len(CLAUDE_SDK_PLACEHOLDER), 'executable': False}
        self.assertEqual(claude_sdk_files({PLACEHOLDER: exact}), [])
        for change in ({'executable': True}, {'bytes': exact['bytes'] + 1}, {'sha256': '0' * 64}, {'extra': 1}):
            with self.subTest(change):
                self.assertEqual(claude_sdk_files({PLACEHOLDER: {**exact, **change}}), [PLACEHOLDER])

    def test_a_runtime_the_build_left_the_sdk_out_of_passes(self):
        runtime = self.base / 'built/claude'
        sdk = runtime / 'node_modules/@anthropic-ai/claude-agent-sdk'
        sdk.mkdir(parents=True)
        (sdk / 'package.json').write_text(json.dumps({'name': '@anthropic-ai/claude-agent-sdk', 'version': '0.3.296'}))
        (sdk / 'sdk.mjs').write_text('export const query = () => {};\n')
        (runtime / 'package-lock.json').write_text(json.dumps({'packages': {
            'node_modules/@anthropic-ai/claude-agent-sdk': {
                'version': '0.3.296', 'integrity': 'sha512-' + 'A' * 86 + '==',
                'resolved': 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.296.tgz'}}}))
        leave_out_sdk(runtime)
        contents = {f'claude/{path.relative_to(runtime).as_posix()}': path.read_bytes()
                    for path in runtime.rglob('*') if path.is_file()}
        self.assertIn(PLACEHOLDER, contents)
        self.assertEqual(check.problems(self.product(contents=contents), self.env), [])

    def test_only_the_sdk_packages_are_sdk_files(self):
        files = {f'{SDK}/package.json': {}, f'{SDK}-darwin-arm64/claude': {}, SDK: {},
                 'claude/node_modules/@anthropic-ai/sdk/package.json': {},
                 'claude/node_modules/@anthropic-ai/claude-agent-sdkx/package.json': {},
                 'claude/bridge.mjs': {}}
        self.assertEqual(claude_sdk_files(files), [SDK, f'{SDK}-darwin-arm64/claude', f'{SDK}/package.json'])


if __name__ == '__main__':
    unittest.main()
