"""The desktop notices (T-90): the generator on fixture crates and recorded
texts, and the installer check on synthetic NSIS installers. No cargo,
network or Windows."""
import hashlib
import importlib.util
import json
import lzma
from pathlib import Path
import shutil
import struct
import tempfile
import unittest
from unittest.mock import patch
import zlib


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f'{name}.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


desktop = load('desktop_notices')
check = load('desktop_installer_check')

REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index'
LOADER = b'loader bytes'


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()


class GeneratorTests(Fixture):
    def crate(self, name, version, license, files=()):
        root = self.root / 'crates' / f'{name}-{version}'
        root.mkdir(parents=True)
        (root / 'Cargo.toml').write_text('[package]')
        for file, data in files:
            (root / file).parent.mkdir(parents=True, exist_ok=True)
            (root / file).write_bytes(data)
        return {'name': name, 'version': version, 'license': license, 'license_file': None, 'source': REGISTRY,
                'repository': None, 'manifest_path': str(root / 'Cargo.toml')}

    def sources(self, loader_sha=None):
        folder = self.root / 'sources'
        folder.mkdir(exist_ok=True)
        texts = {'MS-LICENSE.txt': 'Microsoft terms', 'NSIS-COPYING': 'NSIS terms\r\nline two'}
        for name, text in texts.items():
            (folder / name).write_bytes(text.encode())
        entry = lambda name: {'file': name, 'sha256': sha(texts[name].encode())}
        (folder / 'sources.json').write_text(json.dumps({
            'linked': [{'name': 'Loader', 'crate': 'loader-sys', 'version': '1.0.0', 'file': 'x64/Loader.lib',
                        'fileSha256': loader_sha or sha(LOADER), 'texts': [entry('MS-LICENSE.txt')],
                        'upstream': {'package': 'Vendor.Loader', 'version': '9.9', 'path': 'native/x64/Loader.lib'}}],
            'installer': [{'name': 'NSIS 3.13', 'role': 'the installer code',
                           'files': [{'path': 'COPYING', 'sha256': 'ab' * 32}], 'texts': [entry('NSIS-COPYING')]}]}))
        return folder

    def test_a_linked_file_gets_its_recorded_texts_and_the_installer_texts_are_always_there(self):
        shipped = [self.crate('loader-sys', '1.0.0', 'MIT', [('x64/Loader.lib', LOADER)]),
                   self.crate('dual', '2.0.0', 'MIT OR Apache-2.0', [('LICENSE-MIT', b'dual MIT text')])]
        text, summary = desktop.notices(shipped, [], desktop.recorded(self.sources()))
        self.assertEqual(summary['recorded'], ['Loader', 'NSIS 3.13'])
        self.assertEqual(summary['withoutText'], ['loader-sys 1.0.0'])
        self.assertIn('Loader\n  Linked by: loader-sys 1.0.0 (x64/Loader.lib)\n'
                      '  From: Vendor.Loader 9.9, native/x64/Loader.lib (the same bytes)\n'
                      '  License texts: [2] MS-LICENSE.txt\n', text)
        self.assertIn('NSIS 3.13\n  In the installer: the installer code\n  License texts: [3] NSIS-COPYING\n', text)
        # Each text is reproduced once, as stored.
        self.assertEqual(text.count('Microsoft terms'), 1)
        self.assertIn('NSIS terms\r\nline two', text)
        self.assertIn('[1] from:\n  dual 2.0.0 LICENSE-MIT\n', text)

    def test_a_linked_crate_the_record_does_not_match_is_refused(self):
        index = desktop.recorded(self.sources())
        cases = {
            'other bytes': self.crate('loader-sys', '1.0.0', 'MIT', [('x64/Loader.lib', b'other bytes')]),
            'another version': self.crate('loader-sys', '1.1.0', 'MIT', [('x64/Loader.lib', LOADER)]),
            'no such file': self.crate('loader-sys', '1.2.0', 'MIT'),
        }
        for label, crate in cases.items():
            with self.subTest(label), self.assertRaisesRegex(ValueError, f"loader-sys {crate['version']} links Loader"):
                desktop.notices([crate], [], index)

    def with_dependency(self, text_sha):
        folder = self.sources()
        index = json.loads((folder / 'sources.json').read_text())
        index['installer'][0].update(note='core is in it too.', dependencies=[
            {'crate': 'helper', 'version': '0.9.0', 'texts': [{'file': 'LICENSE-MIT', 'sha256': text_sha}]}])
        (folder / 'sources.json').write_text(json.dumps(index))
        return desktop.recorded(folder)

    def test_a_plugin_dependency_points_to_a_text_the_app_ships_or_is_refused(self):
        shipped = [self.crate('dual', '2.0.0', 'MIT OR Apache-2.0', [('LICENSE-MIT', b'dual MIT text')])]
        text, _ = desktop.notices(shipped, [], self.with_dependency(sha(b'dual MIT text')))
        self.assertIn('NSIS 3.13\n  In the installer: the installer code\n  License texts: [2] NSIS-COPYING\n'
                      '  Its Rust crates (versions inferred; see tools/desktop-license-sources):\n'
                      '    helper 0.9.0: [1] LICENSE-MIT\n  Note: core is in it too.\n', text)
        self.assertIn('[1] from:\n  dual 2.0.0 LICENSE-MIT\n  NSIS 3.13: helper 0.9.0 LICENSE-MIT\n', text)
        with self.assertRaisesRegex(ValueError, 'links helper 0.9.0, whose LICENSE-MIT .* no crate of the app ships'):
            desktop.notices(shipped, [], self.with_dependency(sha(b'another MIT text')))

    def test_without_the_crate_its_record_is_not_used(self):
        text, summary = desktop.notices([self.crate('dual', '2.0.0', 'MIT', [('LICENSE', b'MIT')])], [],
                                        desktop.recorded(self.sources()))
        self.assertEqual(summary['recorded'], ['NSIS 3.13'])
        self.assertNotIn('Microsoft terms', text)

    def test_a_recorded_text_that_changed_or_lies_outside_the_folder_is_refused(self):
        folder = self.sources()
        (folder / 'MS-LICENSE.txt').write_text('Microsoft terms, edited')
        with self.assertRaisesRegex(ValueError, 'does not match its SHA-256'):
            desktop.recorded(folder)
        index = json.loads((folder / 'sources.json').read_text())
        index['linked'][0]['texts'][0]['file'] = '../outside.txt'
        (self.root / 'outside.txt').write_text('x')
        (folder / 'sources.json').write_text(json.dumps(index))
        with self.assertRaisesRegex(ValueError, 'is not in'):
            desktop.recorded(folder)

    def test_generate_writes_the_notices_the_license_and_what_the_bundle_checks(self):
        loader = self.crate('loader-sys', '1.0.0', 'MIT', [('x64/Loader.lib', LOADER)])

        def cargo(*args):
            if args[0] == 'metadata':
                self.assertIn('x86_64-pc-windows-msvc', args)
                return json.dumps({'packages': [loader]})
            self.assertEqual(args[args.index('--manifest-path') + 1], str(desktop.MANIFEST))
            return 'loader-sys v1.0.0\n'

        out = self.root / 'out'
        with patch.object(desktop.core, 'cargo', side_effect=cargo):
            record = desktop.generate(out, self.sources())
        self.assertEqual(record['target'], 'x86_64-pc-windows-msvc')
        self.assertEqual(record['cargoLockSha256'], sha((desktop.ROOT / 'desktop/Cargo.lock').read_bytes()))
        self.assertEqual(record['files'], {name: sha((out / name).read_bytes())
                                           for name in ('THIRD_PARTY_NOTICES-desktop.txt', 'LICENSE')})
        self.assertEqual((out / 'LICENSE').read_bytes(), (desktop.ROOT / 'LICENSE').read_bytes())
        self.assertEqual(record['installer'], [{'name': 'NSIS 3.13', 'files': [{'path': 'COPYING', 'sha256': 'ab' * 32}]}])
        self.assertEqual(json.loads((out / 'notices.json').read_text()), record)

    def test_the_repository_record_loads_and_names_files_only_relative_to_the_nsis_folder(self):
        index = desktop.recorded()
        self.assertEqual([e['crate'] for e in index['linked']], ['webview2-com-sys'])
        plugin = next(e for e in index['installer'] if e['name'].startswith('nsis_tauri_utils'))
        self.assertEqual([(d['crate'], d['version']) for d in plugin['dependencies']],
                         [('windows-sys', '0.61.2'), ('windows-link', '0.2.1'), ('semver', '1.0.27')])
        for dep in plugin['dependencies']:
            for text in dep['texts']:
                self.assertRegex(text['sha256'], '^[0-9a-f]{64}$')
        for entry in index['installer']:
            for file in entry.get('files', []):
                self.assertFalse(file['path'].startswith(('/', '\\')) or '..' in file['path'], file)
                self.assertRegex(file['sha256'], '^[0-9a-f]{64}$')


SIGNATURE = check.SIGNATURE


def installer(files, script=b'install script', *, stub=1024, first_byte=None, crc=None, cut=0, size_of=None):
    """A minimal NSIS installer: a stub, the first header, one solid LZMA stream
    (the script, then each file as a length and its bytes) and the CRC32."""
    raw = struct.pack('<I', len(script)) + script
    for data in files:
        raw += struct.pack('<I', size_of if size_of is not None else len(data)) + data
    packed = lzma.compress(raw, format=lzma.FORMAT_ALONE,
                           filters=[{'id': lzma.FILTER_LZMA1, 'dict_size': 1 << 16, 'lc': 3, 'lp': 0, 'pb': 2}])
    stream = packed[:5] + packed[13:]
    if cut:
        stream = stream[:-cut]
    if first_byte is not None:
        stream = first_byte + stream[1:]
    head = struct.pack('<I', 0) + SIGNATURE + struct.pack('<II', len(script), 28 + len(stream) + 4)
    body = b'MZ' + b'\0' * (stub - 2) + head + stream
    value = zlib.crc32(body[512:]) & 0xffffffff if crc is None else crc
    return body + struct.pack('<I', value)


class InstallerCheckTests(Fixture):
    def setUp(self):
        super().setUp()
        self.licenses = self.root / 'licenses'
        self.licenses.mkdir()
        self.files = {name: f'{name} text\n'.encode() for name in check.SHIPPED}
        for name, data in self.files.items():
            (self.licenses / name).write_bytes(data)
        (self.licenses / 'notices.json').write_text('{}')

    def run_check(self, data):
        path = self.root / 'setup.exe'
        path.write_bytes(data)
        return check.check(path, self.licenses)

    def test_an_installer_that_stores_every_shipped_file_passes(self):
        report = self.run_check(installer([b'app exe', *self.files.values(), b'icon']))
        self.assertTrue(report['passed'], report)
        self.assertEqual(report['blocks'], 5)
        self.assertTrue(all(f['inInstaller'] for f in report['files'].values()))

    def test_a_missing_or_changed_file_fails(self):
        files = list(self.files.values())
        cases = {
            'one file not stored': [b'app exe', *files[1:]],
            'one byte different': [b'app exe', files[0][:-1] + b'!', *files[1:]],
            'only a longer block holding it': [b'app exe', files[0] + b'more', *files[1:]],
        }
        for label, stored in cases.items():
            with self.subTest(label):
                report = self.run_check(installer(stored))
                self.assertFalse(report['passed'])
                self.assertFalse(report['files']['LICENSE']['inInstaller'])
        (self.licenses / 'LICENSE').unlink()
        report = self.run_check(installer([b'app exe', *files]))
        self.assertFalse(report['passed'])
        self.assertEqual(report['files']['LICENSE'], {'error': 'not in the licenses folder'})

    def test_an_installer_it_cannot_read_exactly_is_refused(self):
        files = [b'app exe', *self.files.values()]
        cases = {
            'no NSIS header': (b'MZ' + b'\0' * 4096, 'no first header'),
            'a header off the 512-byte boundary': (installer(files, stub=1000), 'no first header'),
            'a wrong CRC': (installer(files, crc=1), 'CRC does not match'),
            'not solid LZMA': (installer(files, first_byte=b'\x80'), 'not one solid LZMA stream'),
            'a stream cut short': (installer(files, cut=6), 'LZMA'),
            'a block past the stream': (installer(files, size_of=1 << 20), 'runs past the stream'),
            'a script of another size': (installer(files, script=b'x'), None),
        }
        for label, (data, message) in cases.items():
            with self.subTest(label):
                if label == 'a script of another size':
                    # The first header names the script's size; patch it to disagree.
                    start = data.find(SIGNATURE) - 4
                    data = bytearray(data)
                    data[start + 20:start + 24] = struct.pack('<I', 99)
                    data[-4:] = struct.pack('<I', zlib.crc32(bytes(data[512:-4])) & 0xffffffff)
                    data, message = bytes(data), 'first block is not the install script'
                report = self.run_check(data)
                self.assertFalse(report['passed'])
                self.assertIn(message, report.get('refused', ''))
                self.assertEqual(report['files'], {})


if __name__ == '__main__':
    unittest.main()
