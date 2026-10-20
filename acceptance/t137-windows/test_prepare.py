"""prepare.py on fixtures only: no guest, no Windows host, and the identity
reader replaced by a fake (test_admission.py runs the real one on given facts).
python3 test_prepare.py"""
import hashlib
import importlib.util
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)

# Made-up identities; no real machine's.
HOST = {'machineGuid': '1b4e28ba-2fa1-11d2-883f-0016d3cca427', 'smbiosUuid': 'a0b1c2d3-e4f5-4a6b-8c7d-0e1f2a3b4c5d',
        'computerName': 'HOST-PC'}
GUEST = {'machineGuid': '6f9619ff-8b86-d011-b42d-00c04fc964ff', 'smbiosUuid': '9a3e4d10-55b2-4c8e-9f6a-2d7c1b0e8a41'}


def fake_identity(token, guest=None, facts=None):
    def digests(found):
        return {k: hashlib.sha256(f'{token}:{k}:{v.lower()}'.encode()).hexdigest() for k, v in found.items()}
    found = {'host': digests(facts or HOST)}
    if guest:
        found['guest'] = digests(guest)
    return found


class Prepare(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mount = Path(self.tmp.name) / 'c'
        self.lab = self.mount / 'yuzuno-lab' / 't137'
        for folder in ('in', 'harness'):
            (self.lab / folder).mkdir(parents=True)
        for file in ('guest-accept.ps1', 'guest-lib.ps1'):
            (self.lab / 'harness' / file).write_text('# harness')
        self.real_identity, prepare.identity = prepare.identity, fake_identity
        self.packages = {}
        for name, body in (('old-setup.exe', b'old package'), ('new-setup.exe', b'new package')):
            (self.lab / 'in' / name).write_bytes(body)
            self.packages[name] = hashlib.sha256(body).hexdigest()

    def tearDown(self):
        prepare.identity = self.real_identity
        self.tmp.cleanup()

    def args(self, **change):
        values = {'lab_root': r'C:\yuzuno-lab\t137', 'installers': r'C:\yuzuno-lab\t137\in',
                  'results': r'C:\yuzuno-lab\t137\out-1', 'harness': r'C:\yuzuno-lab\t137\harness',
                  'config': r'C:\yuzuno-lab\t137\run-1',
                  'old': 'old-setup.exe', 'old_sha256': self.packages['old-setup.exe'], 'old_version': '0.2.0',
                  'new': 'new-setup.exe', 'new_sha256': self.packages['new-setup.exe'], 'new_version': '0.3.0',
                  'memory_mib': 4096,
                  'host_path_prefix': f'C:\\={self.mount}'}
        values.update(change)
        return prepare.parser().parse_args(sum((
            [f"--{k.replace('_', '-')}", str(v)] for k, v in values.items() if v is not None), []))

    def test_a_prepared_guest_maps_only_the_lab_and_turns_off_what_could_leak(self):
        done = prepare.prepare(self.args())
        # The configuration lives only where the guest cannot write; the one
        # guest-writable folder starts empty.
        self.assertEqual(Path(done['params']).parent, self.lab / 'run-1')
        self.assertEqual(Path(done['wsb']), self.lab / 'run-1' / 't137.wsb')
        self.assertEqual(list((self.lab / 'out-1').iterdir()), [])
        params = json.loads(Path(done['params']).read_text())
        self.assertEqual(params['old'], {'path': r'C:\t137\in\old-setup.exe', 'sha256': self.packages['old-setup.exe'], 'version': '0.2.0'})
        self.assertEqual(params['new']['version'], '0.3.0')
        self.assertEqual(len(params['token']), 32)
        # The host's identity only as digests salted with the token; no raw value.
        self.assertEqual(params['hostIdentity'], fake_identity(params['token'])['host'])
        self.assertIsNone(params['guestIdentity'])
        text = Path(done['params']).read_text().lower()
        for value in HOST.values():
            self.assertNotIn(value.lower(), text)
        config = ET.fromstring(Path(done['wsb']).read_text())
        for setting in ('VGpu', 'Networking', 'AudioInput', 'VideoInput', 'ClipboardRedirection', 'PrinterRedirection'):
            self.assertEqual(config.findtext(setting), 'Disable', setting)
        self.assertEqual(config.findtext('ProtectedClient'), 'Enable')
        self.assertEqual(config.findtext('MemoryInMB'), '4096')
        self.assertIsNone(config.find('LogonCommand'), 'nothing runs at logon')
        mapped = {m.findtext('SandboxFolder'): (m.findtext('HostFolder'), m.findtext('ReadOnly'))
                  for m in config.iter('MappedFolder')}
        self.assertEqual(mapped, {
            r'C:\t137\in': (r'C:\yuzuno-lab\t137\in', 'true'),
            r'C:\t137\harness': (r'C:\yuzuno-lab\t137\harness', 'true'),
            r'C:\t137\config': (r'C:\yuzuno-lab\t137\run-1', 'true'),
            r'C:\t137\out': (r'C:\yuzuno-lab\t137\out-1', 'false'),
        })

    def test_unsafe_or_unclear_inputs_are_refused_before_anything_is_written(self):
        cases = {
            'drive root as lab': (dict(lab_root='C:\\'), 'drive root'),
            'a profile as lab': (dict(lab_root=r'C:\Users\someone', installers=r'C:\Users\someone\in',
                                      results=r'C:\Users\someone\out', harness=r'C:\Users\someone\h',
                                      config=r'C:\Users\someone\run'), 'user profile'),
            'outside the lab': (dict(installers=r'C:\elsewhere\in'), 'inside the lab root'),
            'nested folders': (dict(results=r'C:\yuzuno-lab\t137\in\out'), 'separate'),
            'same version': (dict(new_version='0.2.0'), 'not an upgrade'),
            'wrong hash': (dict(new_sha256='0' * 64), 'SHA-256 is not'),
            'a path as package': (dict(old=r'..\old-setup.exe'), 'file name only'),
            'too much memory': (dict(memory_mib=65536), '512..'),
            'config inside results': (dict(config=r'C:\yuzuno-lab\t137\out-1\run'), 'separate'),
            'config is the results': (dict(config=r'C:\yuzuno-lab\t137\out-1'), 'separate'),
            'relative path': (dict(results=r'out-1'), 'absolute Windows path'),
            # Windows would resolve these outside the lab root.
            'dot-dot out of the lab': (dict(installers=r'C:\yuzuno-lab\t137\..\..\Windows'), 'without "." or ".."'),
            'dot-dot results': (dict(results=r'C:\yuzuno-lab\t137\..\..\new-dir'), 'without "." or ".."'),
            'dot part': (dict(config=r'C:\yuzuno-lab\t137\.\run-1'), 'without "." or ".."'),
            'only one guest GUID': (dict(guest_machine_guid=GUEST['machineGuid']), 'both --guest-machine-guid'),
            'a guest GUID in braces': (dict(guest_machine_guid='{%s}' % GUEST['machineGuid'],
                                            guest_smbios_uuid=GUEST['smbiosUuid']), 'as Windows shows it'),
            'the host registered as the guest': (dict(guest_machine_guid=GUEST['machineGuid'],
                                                      guest_smbios_uuid=HOST['smbiosUuid']), "this host's smbiosUuid"),
        }
        for label, (change, message) in cases.items():
            with self.subTest(label):
                with self.assertRaisesRegex(prepare.Refused, message):
                    prepare.prepare(self.args(**change))
                self.assertFalse((self.lab / 'out-1').exists() or (self.lab / 'run-1').exists(), 'nothing written')

    def test_a_registered_guest_is_recorded_as_digests(self):
        done = prepare.prepare(self.args(guest_machine_guid=GUEST['machineGuid'], guest_smbios_uuid=GUEST['smbiosUuid']))
        params = json.loads(Path(done['params']).read_text())
        self.assertEqual(params['guestIdentity'], fake_identity(params['token'], GUEST)['guest'])
        self.assertNotIn(GUEST['machineGuid'], Path(done['params']).read_text())

    def test_a_host_identity_that_cannot_be_read_refuses(self):
        for label, found in {'no answer': {}, 'one fact missing': {'host': {'machineGuid': '0' * 64, 'smbiosUuid': '1' * 64}},
                             'not a digest': {'host': {'machineGuid': '', 'smbiosUuid': '1' * 64, 'computerName': '2' * 64}}}.items():
            with self.subTest(label):
                prepare.identity = lambda token, guest=None, facts=None, found=found: found
                with self.assertRaisesRegex(prepare.Refused, 'could not be read'):
                    prepare.prepare(self.args())
                self.assertFalse((self.lab / 'run-1').exists() or (self.lab / 'out-1').exists(), 'nothing written')

    def test_extra_files_secrets_or_a_used_results_folder_are_refused(self):
        cases = {
            'another file beside the packages': (lambda: (self.lab / 'in' / 'notes.txt').write_text('x'), 'other files'),
            'a .ssh folder mapped': (lambda: (self.lab / 'harness' / '.ssh').mkdir(), '.ssh'),
            'results not empty': (lambda: ((self.lab / 'out-1').mkdir(), (self.lab / 'out-1' / 'old.json').write_text('{}')),
                                  'new or empty'),
            'config not empty': (lambda: ((self.lab / 'run-1').mkdir(), (self.lab / 'run-1' / 'old.wsb').write_text('x')),
                                 'new or empty'),
            'no harness': (lambda: (self.lab / 'harness' / 'guest-accept.ps1').unlink(), 'no guest-accept.ps1'),
            'no admission library': (lambda: (self.lab / 'harness' / 'guest-lib.ps1').unlink(), 'no guest-lib.ps1'),
        }
        for label, (change, message) in cases.items():
            with self.subTest(label):
                self.tearDown()
                self.setUp()
                change()
                with self.assertRaisesRegex(prepare.Refused, message):
                    prepare.prepare(self.args())
                self.assertFalse((self.lab / 'run-1' / 'params.json').exists())


if __name__ == '__main__':
    unittest.main()
