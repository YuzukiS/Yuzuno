"""tools/claude_sdk_release.py: the Claude Agent SDK left out of a release's
Claude runtime (T-159); no network, build or keys."""
import json
from pathlib import Path
import tempfile
import unittest
from claude_sdk_release import leave_out_sdk, sdk_left_out
from release_common import CLAUDE_SDK_PLACEHOLDER, digest, read

LOCKED = {'version': '0.3.296', 'license': 'SEE LICENSE IN README.md',
          'resolved': 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.296.tgz',
          'integrity': 'sha512-' + 'A' * 86 + '=='}


class LeaveOutSdk(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.runtime = Path(temp.name) / 'claude'
        self.sdk = self.runtime / 'node_modules/@anthropic-ai/claude-agent-sdk'
        (self.sdk / 'vendor').mkdir(parents=True)
        (self.sdk / 'package.json').write_text(json.dumps({'name': '@anthropic-ai/claude-agent-sdk', 'version': '0.3.296'}))
        (self.sdk / 'sdk.mjs').write_text('export const query = () => {};\n')
        (self.sdk / 'vendor/x.js').write_text('vendored\n')
        (self.runtime / 'node_modules/zod').mkdir(parents=True)
        (self.runtime / 'node_modules/zod/package.json').write_text('{"name":"zod","version":"4.6.7"}')
        self.lock(LOCKED)

    def lock(self, entry):
        (self.runtime / 'package-lock.json').write_text(json.dumps({'packages': {
            '': {'name': '@yuzuno/claude-runtime'},
            'node_modules/@anthropic-ai/claude-agent-sdk': entry,
            'node_modules/zod': {'version': '4.6.7'}}}))

    def test_the_sdk_is_replaced_by_its_manifest_and_the_placeholder(self):
        files = {'package.json': digest(self.sdk / 'package.json'), 'sdk.mjs': digest(self.sdk / 'sdk.mjs'),
                 'vendor/x.js': digest(self.sdk / 'vendor/x.js')}
        manifest = leave_out_sdk(self.runtime)
        self.assertEqual(manifest, read(self.runtime / 'claude-agent-sdk.json'))
        self.assertEqual({k: manifest[k] for k in ('name', 'version', 'resolved', 'integrity')},
                         {'name': '@anthropic-ai/claude-agent-sdk', 'version': '0.3.296',
                          'resolved': LOCKED['resolved'], 'integrity': LOCKED['integrity']})
        self.assertEqual({path: entry['sha256'] for path, entry in manifest['files'].items()}, files)
        self.assertEqual(manifest['files']['vendor/x.js']['bytes'], len('vendored\n'))
        self.assertEqual(sorted(p.name for p in self.sdk.iterdir()), ['package.json'])
        self.assertEqual((self.sdk / 'package.json').read_bytes(), CLAUDE_SDK_PLACEHOLDER)
        self.assertTrue(sdk_left_out(self.runtime))
        # Other packages stay.
        self.assertTrue((self.runtime / 'node_modules/zod/package.json').is_file())

    def test_the_placeholder_is_not_the_sdk(self):
        placeholder = json.loads(CLAUDE_SDK_PLACEHOLDER)
        self.assertTrue(placeholder['yuzunoPlaceholder'])
        self.assertIn('not the Claude Agent SDK', placeholder['description'])
        self.assertNotIn('name', placeholder)
        self.assertNotIn('license', placeholder)
        self.assertNotIn('version', placeholder)
        self.assertNotIn('main', placeholder)
        self.assertNotIn('exports', placeholder)

    def test_another_version_or_a_lock_without_source_and_integrity_is_refused(self):
        for entry in ({**LOCKED, 'version': '0.3.297'}, {**LOCKED, 'integrity': 'sha1-x'},
                      {**LOCKED, 'resolved': 'http://registry.npmjs.org/x.tgz'}):
            with self.subTest(entry=entry):
                self.lock(entry)
                with self.assertRaises(ValueError):
                    leave_out_sdk(self.runtime)
                self.assertTrue((self.sdk / 'sdk.mjs').is_file(), 'a refused runtime is left as it was')
                self.assertFalse((self.runtime / 'claude-agent-sdk.json').exists())

    def test_a_runtime_that_still_has_the_sdk_is_not_left_out(self):
        self.assertFalse(sdk_left_out(self.runtime))
        leave_out_sdk(self.runtime)
        (self.sdk / 'sdk.mjs').write_text('back')
        self.assertFalse(sdk_left_out(self.runtime))


if __name__ == '__main__':
    unittest.main()
