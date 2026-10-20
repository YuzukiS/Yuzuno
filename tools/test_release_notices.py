"""The Core notices generator (T-90), on fixture crates; no cargo, network or build."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('third_party_notices', Path(__file__).with_name('third_party_notices.py'))
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)

APACHE = 'Apache License\nVersion 2.0, January 2004\n'
REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index'


class NoticesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def crate(self, name, version, license, files=(), source=REGISTRY, license_file=None):
        root = self.root / f'{name}-{version}'
        root.mkdir()
        (root / 'Cargo.toml').write_text('[package]')
        (root / 'README.md').write_text('not a license')
        for file, text in files:
            (root / file).write_text(text)
        return {'name': name, 'version': version, 'license': license, 'license_file': license_file,
                'source': source, 'repository': f'https://example.invalid/{name}',
                'manifest_path': str(root / 'Cargo.toml')}

    def test_linked_crates_carry_their_own_texts_and_compile_only_crates_only_their_names(self):
        packages = [
            self.crate('dual', '1.0.0', 'MIT OR Apache-2.0', [('LICENSE-APACHE', APACHE), ('LICENSE-MIT', 'MIT text of dual')]),
            self.crate('other', '2.1.0', 'Apache-2.0', [('LICENSE', APACHE)]),
            self.crate('bare', '3.5.1', 'Apache-2.0'),
            self.crate('custom', '0.1.0', None, [('COPYING.txt', 'custom terms')], license_file='COPYING.txt'),
            self.crate('derive', '1.0.0', 'MIT', [('LICENSE', 'derive MIT text')]),
            self.crate('yuzuno-workspace', '0.1.0', 'Apache-2.0', [('LICENSE', APACHE)], source=None),
        ]
        linked = {('dual', '1.0.0'), ('other', '2.1.0'), ('bare', '3.5.1'), ('custom', '0.1.0'), ('yuzuno-workspace', '0.1.0')}
        compile_all = linked | {('derive', '1.0.0')}
        text, summary = notices.notices('x86_64-unknown-linux-gnu', linked, compile_all, packages, 'rustc 1.0.0 (fixture)')
        self.assertEqual(summary, {'crates': 4, 'compileOnly': 1, 'texts': 3, 'withoutText': ['bare 3.5.1']})
        # The project itself is not third-party software.
        self.assertNotIn('yuzuno-workspace 0.1.0', text)
        # The declared expression is kept as written; nothing is chosen.
        self.assertIn('dual 1.0.0\n  License (as declared): MIT OR Apache-2.0', text)
        self.assertIn('License texts: [2] LICENSE-APACHE, [3] LICENSE-MIT', text)
        # An identical text is reproduced once, naming every crate file it came from.
        self.assertEqual(text.count(APACHE.rstrip()), 1)
        self.assertIn('[2] from:\n  dual 1.0.0 LICENSE-APACHE\n  other 2.1.0 LICENSE\n', text)
        self.assertIn('custom 0.1.0\n  License (as declared): none declared', text)
        self.assertIn('License texts: [1] COPYING.txt', text)
        self.assertIn('bare 3.5.1\n  License (as declared): Apache-2.0\n', text)
        self.assertIn('License texts: none shipped in the package', text)
        self.assertIn('These crates ship no license text; only their declared license is listed above:\n  bare 3.5.1 (Apache-2.0)', text)
        self.assertIn('Crates used only while compiling, not part of the binaries (1)\n\nderive 1.0.0: MIT', text)
        self.assertNotIn('derive MIT text', text)
        self.assertNotIn('not a license', text)

    def test_the_build_graph_is_read_from_cargo_tree(self):
        out = '\n'.join(['yuzuno-workspace v0.1.0 (/work/core)', 'serde v1.0.228', 'serde v1.0.228 (*)',
                         'serde_derive v1.0.228 (proc-macro)', '', 'git-dep v0.2.0 (https://example.invalid/x#abc)'])
        with patch.object(notices, 'cargo', return_value=out) as cargo:
            found = notices.tree('x86_64-unknown-linux-gnu', 'normal,no-proc-macro')
        self.assertEqual(found, {('yuzuno-workspace', '0.1.0'), ('serde', '1.0.228'),
                                 ('serde_derive', '1.0.228'), ('git-dep', '0.2.0')})
        argv = cargo.call_args.args
        self.assertEqual(argv[:4], ('tree', '--locked', '--offline', '-p'))
        self.assertIn('normal,no-proc-macro', argv)
        self.assertIn('x86_64-unknown-linux-gnu', argv)

    def test_generate_writes_the_notices_and_the_toolchain_std_notices(self):
        packages = [self.crate('dual', '1.0.0', 'MIT OR Apache-2.0', [('LICENSE-MIT', 'MIT text')])]
        sysroot = self.root / 'sysroot'
        (sysroot / 'share/doc/rust').mkdir(parents=True)
        (sysroot / 'share/doc/rust/COPYRIGHT-library.html').write_text('<html>std notices</html>')

        def cargo(*args):
            if args[0] == 'metadata':
                return json.dumps({'packages': packages})
            return 'dual v1.0.0\n'

        def rustc(argv, **kwargs):
            out = str(sysroot) if '--print' in argv else 'rustc 1.97.1 (fixture)'
            return subprocess.CompletedProcess(argv, 0, out + '\n', '')

        out = self.root / 'out'
        with patch.object(notices, 'cargo', side_effect=cargo), patch.object(notices.subprocess, 'run', side_effect=rustc):
            summary = notices.generate('x86_64-unknown-linux-gnu', out)
        self.assertEqual(summary['crates'], 1)
        self.assertIn('Rust standard library: rustc 1.97.1 (fixture)', (out / 'THIRD_PARTY_NOTICES-core.txt').read_text())
        self.assertEqual((out / 'rust-std-COPYRIGHT-library.html').read_text(), '<html>std notices</html>')
        (sysroot / 'share/doc/rust/COPYRIGHT-library.html').unlink()
        with patch.object(notices, 'cargo', side_effect=cargo), patch.object(notices.subprocess, 'run', side_effect=rustc), \
             self.assertRaisesRegex(ValueError, 'standard library notices'):
            notices.generate('x86_64-unknown-linux-gnu', self.root / 'again')


spec = importlib.util.spec_from_file_location('runtime_notices', Path(__file__).with_name('runtime_notices.py'))
runtime_notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime_notices)


class RuntimeNoticesTests(unittest.TestCase):
    """The Claude runtime's installed packages against its lock file."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.tmp.name) / 'claude'
        lock = {'lockfileVersion': 3, 'packages': {
            '': {'name': '@yuzuno/claude-runtime', 'version': '0.1.0', 'license': 'Apache-2.0'},
            'node_modules/a': {'version': '1.0.0', 'license': 'MIT'},
            'node_modules/@s/sdk': {'version': '2.0.0', 'license': 'SEE LICENSE IN README.md'},
            'node_modules/a/node_modules/c': {'version': '3.0.0', 'license': 'ISC'},
            'node_modules/devdep': {'version': '4.0.0', 'license': 'MIT', 'dev': True},
            'node_modules/opt': {'version': '5.0.0', 'license': 'MIT', 'optional': True},
        }}
        self.runtime.mkdir()
        (self.runtime / 'package-lock.json').write_text(json.dumps(lock))
        self.package('node_modules/a', 'a', '1.0.0', 'MIT', {'LICENSE': 'MIT text of a'})
        self.package('node_modules/@s/sdk', '@s/sdk', '2.0.0', 'SEE LICENSE IN README.md',
                     {'README.md': 'Use is subject to the vendor terms.'})
        self.package('node_modules/a/node_modules/c', 'c', '3.0.0', 'ISC', {})
        self.out = Path(self.tmp.name) / 'notices.txt'
        # No recorded source texts unless a test adds one (not the repository's own).
        self.sources = Path(self.tmp.name) / 'sources'
        self.sources.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def package(self, path, name, version, license, files):
        root = self.runtime / path
        root.mkdir(parents=True)
        (root / 'package.json').write_text(json.dumps({'name': name, 'version': version, 'license': license}))
        for file, text in files.items():
            (root / file).write_text(text)
        return root

    def test_the_production_set_gets_notices_with_the_texts_each_package_ships(self):
        summary = runtime_notices.generate(self.runtime, self.out, self.sources)
        self.assertEqual(summary, {'packages': 3, 'texts': 2, 'withoutText': ['c 3.0.0'],
                                   'fromRecordedSource': [], 'recordedSourceNotUsed': []})
        text = self.out.read_text()
        self.assertIn('a 1.0.0\n  License (as declared): MIT\n', text)
        # A declared "SEE LICENSE IN" file is reproduced as the package's text.
        self.assertIn('@s/sdk 2.0.0\n  License (as declared): SEE LICENSE IN README.md\n', text)
        self.assertIn('Use is subject to the vendor terms.', text)
        self.assertIn('c 3.0.0 (at node_modules/a/node_modules/c)', text)
        self.assertIn('These packages ship no license text; only their declared license is listed above:\n  c 3.0.0 (ISC)', text)
        # Development and optional packages are not installed for the release, and not listed.
        self.assertNotIn('devdep', text)
        self.assertNotIn('opt 5.0.0', text)
        self.assertNotIn('@yuzuno/claude-runtime', text)

    def test_a_missing_package_a_wrong_version_or_an_extra_package_is_refused(self):
        cases = {
            'missing': (lambda: (self.runtime / 'node_modules/a/node_modules/c/package.json').unlink(),
                        'missing: node_modules/a/node_modules/c 3.0.0'),
            'version': (lambda: (self.runtime / 'node_modules/a/package.json').write_text(
                            json.dumps({'name': 'a', 'version': '1.0.1', 'license': 'MIT'})),
                        'differs from the lock file: node_modules/a is a 1.0.1, locked a 1.0.0'),
            'extra': (lambda: self.package('node_modules/opt', 'opt', '5.0.0', 'MIT', {}),
                      'not a production package of the lock file: node_modules/opt 5.0.0'),
        }
        for label, (change, message) in cases.items():
            with self.subTest(label):
                self.tearDown()
                self.setUp()
                change()
                with self.assertRaisesRegex(ValueError, re.escape(message)):
                    runtime_notices.generate(self.runtime, self.out, self.sources)
                self.assertFalse(self.out.exists(), 'no notices are written for a mismatched install')

    def record(self, name='c', version='3.0.0', integrity='sha512-locked', text='MIT text of c from its source\n',
               file='c-LICENSE', sha=None):
        # Written where the entry points, also outside the folder (that must be refused).
        (self.sources / file).write_text(text)
        entry = {'name': name, 'version': version, 'integrity': integrity, 'declaredLicense': 'ISC', 'text': file,
                 'textSha256': sha or hashlib.sha256(text.encode()).hexdigest(),
                 'upstream': {'repository': 'https://example.invalid/c', 'commit': 'f' * 40, 'path': 'lib/LICENSE',
                              'gitBlob': 'e' * 40}, 'evidence': ['test']}
        (self.sources / 'sources.json').write_text(json.dumps({'packages': [entry]}))

    def lock_integrity(self, value):
        lock = json.loads((self.runtime / 'package-lock.json').read_text())
        lock['packages']['node_modules/a/node_modules/c']['integrity'] = value
        (self.runtime / 'package-lock.json').write_text(json.dumps(lock))

    def test_a_recorded_source_text_fills_only_the_exact_package_that_ships_none(self):
        self.lock_integrity('sha512-locked')
        self.record()
        summary = runtime_notices.generate(self.runtime, self.out, self.sources)
        self.assertEqual((summary['withoutText'], summary['fromRecordedSource'], summary['recordedSourceNotUsed']),
                         ([], ['c 3.0.0'], []))
        text = self.out.read_text()
        label = f"lib/LICENSE at https://example.invalid/c {'f' * 40} (its source; not shipped in the package)"
        self.assertIn(f'c 3.0.0 (at node_modules/a/node_modules/c)\n  License (as declared): ISC\n', text)
        self.assertIn(f'  License texts: [3] from {label}\n', text)
        self.assertIn(f'  c 3.0.0 {label}\n\nMIT text of c from its source\n', text)
        self.assertNotIn('These packages ship no license text', text)

    def test_a_recorded_source_for_other_bytes_is_not_used(self):
        cases = {
            # Another tarball of the same name and version: not the one traced.
            'other integrity': (lambda: (self.lock_integrity('sha512-other'), self.record()),
                                'c 3.0.0: the recorded text is for integrity sha512-locked, the lock has sha512-other'),
            # The package now ships a text of its own: that one is used.
            'ships its own': (lambda: (self.lock_integrity('sha512-locked'), self.record(),
                                       (self.runtime / 'node_modules/a/node_modules/c/LICENSE').write_text('own')),
                              'c 3.0.0: the package ships its own license text'),
            'not installed': (lambda: self.record(name='gone', version='9.9.9'),
                              'gone 9.9.9: not a package of this install'),
        }
        for label, (change, message) in cases.items():
            with self.subTest(label):
                self.tearDown()
                self.setUp()
                change()
                summary = runtime_notices.generate(self.runtime, self.out, self.sources)
                self.assertEqual((summary['fromRecordedSource'], summary['recordedSourceNotUsed']), ([], [message]))
                self.assertNotIn('from its source', self.out.read_text())
                self.assertNotIn('MIT text of c from its source', self.out.read_text())

    def test_a_recorded_text_that_does_not_match_its_hash_or_folder_is_refused(self):
        cases = {
            'changed text': (lambda: self.record(sha='0' * 64), 'does not match its recorded SHA-256'),
            'outside the folder': (lambda: self.record(file='../escape'), 'is not in'),
        }
        for label, (change, message) in cases.items():
            with self.subTest(label):
                self.tearDown()
                self.setUp()
                self.lock_integrity('sha512-locked')
                change()
                with self.assertRaisesRegex(ValueError, re.escape(message)):
                    runtime_notices.generate(self.runtime, self.out, self.sources)
                self.assertFalse(self.out.exists())

    def test_the_repository_record_matches_its_text_and_the_locked_package(self):
        sources = runtime_notices.recorded_sources(runtime_notices.SOURCES)
        lock = json.loads((Path(__file__).resolve().parent.parent / 'runtimes/claude/package-lock.json').read_text())
        for (name, version), entry in sources.items():
            locked = lock['packages'].get(f'node_modules/{name}', {})
            with self.subTest(f'{name} {version}'):
                self.assertTrue(entry['upstream']['commit'] and entry['evidence'])
                # Only checked while the lock still has this version; otherwise the
                # record is simply not used (the notices list the package without a text).
                if locked.get('version') == version:
                    self.assertEqual(locked.get('integrity'), entry['integrity'])


if __name__ == '__main__':
    unittest.main()
