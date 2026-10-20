"""The portable ZIP carries the installer's own app and notices (T-148)."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f'{name}.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


portable = load('desktop_portable')
installer = load('test_release_desktop_notices').installer

MARKER = portable.MARKER
APP = b'MZ app ' + MARKER + b'UNK' + b' and the rest'
# The installer's copy: Tauri's bundler wrote the bundle type (NSIS) into it.
INSTALLED = APP.replace(MARKER + b'UNK', MARKER + b'NSS')


APP_REFUSED = "--app is the installer's app, with no bundle type (UNK) where the installer's copy has NSIS"


class PortableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.licenses = self.root / 'licenses'
        self.licenses.mkdir()
        self.files = {name: f'{name} text\n'.encode() for name in portable.installer_check.SHIPPED}
        for name, data in self.files.items():
            (self.licenses / name).write_bytes(data)
        self.app = self.root / 'yuzuno-desktop.exe'
        self.app.write_bytes(APP)

    def tearDown(self):
        self.temp.cleanup()

    def setup_exe(self, files, name='Yuzuno_0.3.0_x64-setup.exe'):
        path = self.root / name
        path.write_bytes(installer(files))
        return path

    def build(self, setup, version='0.3.0', out='out', configs=()):
        return portable.build(setup, self.app, self.licenses, version, self.root / out, configs)

    def test_the_zip_holds_the_installer_app_its_notices_and_the_readme(self):
        report = self.build(self.setup_exe([INSTALLED, *self.files.values(), b'icon']))
        self.assertTrue(report['passed'], report)
        with zipfile.ZipFile(report['zip']['path']) as archive:
            names = archive.namelist()
            self.assertEqual(names, sorted(names))
            folder = 'Yuzuno 0.3.0 portable'
            self.assertEqual(set(names), {f'{folder}/Yuzuno.exe', f'{folder}/README.txt',
                                          *(f'{folder}/licenses/{name}' for name in self.files)})
            self.assertEqual(archive.read(f'{folder}/Yuzuno.exe'), APP)
            for name, data in self.files.items():
                self.assertEqual(archive.read(f'{folder}/licenses/{name}'), data)
            readme = archive.read(f'{folder}/README.txt').decode()
            self.assertIn('\r\n', readme)
            self.assertIn(r'%APPDATA%\dev.yuzuno.workspace\core.json', readme)
            self.assertIn(r'%LOCALAPPDATA%\dev.yuzuno.workspace', readme)
            self.assertIn('does not update itself', readme)
            self.assertIn('run Yuzuno.exe', readme)
            self.assertTrue(all(info.date_time == portable.STAMP for info in archive.infolist()))

    def test_the_same_inputs_make_the_same_zip(self):
        setup = self.setup_exe([INSTALLED, *self.files.values()])
        first = self.build(setup, out='a')
        second = self.build(setup, out='b')
        self.assertEqual(first['zip']['sha256'], second['zip']['sha256'])

    def test_an_app_or_notices_file_the_installer_does_not_store_is_refused(self):
        changed = dict(self.files)
        changed['LICENSE'] = b'another license\n'
        for files, refused in [
            ([INSTALLED.replace(b'the rest', b'the REST'), *self.files.values()], APP_REFUSED),
            ([INSTALLED, *changed.values()], 'LICENSE is, byte for byte, the one the installer stores'),
        ]:
            with self.subTest(refused=refused):
                report = self.build(self.setup_exe(files), out=refused[:6])
                self.assertFalse(report['passed'])
                self.assertEqual(report['refused'], refused)
                self.assertNotIn('zip', report)
                self.assertFalse((self.root / refused[:6] / portable.NAME).exists())

    def test_only_the_unpatched_app_with_the_installers_bytes_is_taken(self):
        setup = self.setup_exe([INSTALLED, *self.files.values()])
        for app in (INSTALLED, APP.replace(MARKER, b'__TAURI_BUNDLE_KIND_VAR_'), APP + MARKER + b'UNK', APP[:-1] + b'X'):
            with self.subTest(app=app[-20:]):
                self.app.write_bytes(app)
                self.assertEqual(self.build(setup)['refused'], APP_REFUSED)

    def test_a_version_the_installer_name_contradicts_or_an_unreadable_installer_is_refused(self):
        setup = self.setup_exe([INSTALLED, *self.files.values()])
        report = self.build(setup, version='0.3.1')
        self.assertEqual(report['refused'], "the installer's file name, if it has one, names that version")
        self.assertEqual(self.build(setup, version='v0.3')['refused'], 'the version is plain semver')
        broken = self.root / 'yuzuno-desktop-windows-x86_64-setup.exe'
        broken.write_bytes(b'MZ' + b'\0' * 2048)
        self.assertIn('not an NSIS installer', self.build(broken)['refused'])
        self.app.write_bytes(b'#!/bin/sh\n')
        self.assertEqual(self.build(setup)['refused'], '--app is a Windows executable')

    def test_a_merged_config_names_the_lab_identity(self):
        overlay = self.root / 'lab.json'
        overlay.write_text(json.dumps({'productName': 'Yuzuno T148', 'identifier': 'dev.yuzuno.workspace.t148'}))
        report = self.build(self.setup_exe([INSTALLED, *self.files.values()]), configs=[overlay])
        self.assertTrue(report['passed'], report)
        self.assertEqual((report['product'], report['identifier']), ('Yuzuno T148', 'dev.yuzuno.workspace.t148'))
        entries = report['zip']['entries']
        self.assertIn('Yuzuno T148 0.3.0 portable/Yuzuno T148.exe', entries)
        self.assertEqual(entries['Yuzuno T148 0.3.0 portable/Yuzuno T148.exe'], hashlib.sha256(APP).hexdigest())

    def test_merge_follows_json_merge_patch(self):
        self.assertEqual(portable.merge({'a': {'b': 1, 'c': 2}, 'd': 3}, {'a': {'b': None, 'e': 4}, 'd': [5]}),
                         {'a': {'c': 2, 'e': 4}, 'd': [5]})


if __name__ == '__main__':
    unittest.main()
