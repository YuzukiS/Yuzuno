"""guest-lib.ps1's Get-Admission and digests on given facts only (python3 test_admission.py).

Windows PowerShell gets the library and the fixtures as commands on stdin:
no script file runs, no execution policy is changed, guest-accept.ps1 is never
run, and this machine's own identity is never read. Skipped without Windows
PowerShell.
"""
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)

try:
    prepare.powershell('@{ ok = $true } | ConvertTo-Json -Compress')
    HAVE_POWERSHELL = True
except prepare.Refused:
    HAVE_POWERSHELL = False

TOKEN = '0123456789abcdef0123456789abcdef'
# Made-up machines; no real one's identity.
HOST = {'userName': 'someone', 'computerName': 'HOST-PC', 'machineGuid': '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
        'smbiosUuid': 'A0B1C2D3-E4F5-4A6B-8C7D-0E1F2A3B4C5D', 'manufacturer': 'Example Inc.', 'model': 'Desk 9'}
SANDBOX = {'userName': 'WDAGUtilityAccount', 'computerName': '5C1E9A2F3B7D', 'machineGuid': '6f9619ff-8b86-d011-b42d-00c04fc964ff',
           'smbiosUuid': '9A3E4D10-55B2-4C8E-9F6A-2D7C1B0E8A41', 'manufacturer': 'Microsoft Corporation', 'model': 'Virtual Machine'}
VM = {'userName': 'tester', 'computerName': 'LAB-VM', 'machineGuid': '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'smbiosUuid': '7D1C0B2A-3E4F-4A5B-8C6D-9E0F1A2B3C4D', 'manufacturer': 'Example Hypervisor', 'model': 'Standard PC'}
NEITHER = 'neither Windows Sandbox (its account on a Hyper-V virtual machine) nor the guest registered in params.json'
THE_HOSTS = [f"{name} is the host's: this is the host or a copy of it" for name in ('machineGuid', 'smbiosUuid', 'computerName')]


def literal(value):
    return "('" + json.dumps(value).replace("'", "''") + "' | ConvertFrom-Json)"


@unittest.skipUnless(HAVE_POWERSHELL, 'needs Windows PowerShell')
class Admission(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        found = prepare.identity(TOKEN, guest={'machineGuid': VM['machineGuid'], 'smbiosUuid': VM['smbiosUuid']}, facts=HOST)
        cls.found = found
        params = {'token': TOKEN, 'hostIdentity': found['host'], 'guestIdentity': None}
        registered = dict(params, guestIdentity=found['guest'])
        partial = dict(params, hostIdentity={k: v for k, v in found['host'].items() if k != 'computerName'})
        cls.cases = {
            # Admitted.
            'windows sandbox': (SANDBOX, params, True),
            'the registered guest': (VM, registered, True),
            # The host, however it is dressed up: the token in params.json is valid on the host too.
            'the host with a valid params.json': (HOST, params, True),
            'the host under the sandbox account name': (dict(HOST, userName='WDAGUtilityAccount'), params, True),
            'the host with every sandbox fact': (dict(HOST, userName='WDAGUtilityAccount',
                                                      manufacturer='Microsoft Corporation', model='Virtual Machine'), params, True),
            'the host renamed': (dict(HOST, computerName='OTHER-PC'), params, True),
            'a sandbox with the host machine GUID': (dict(SANDBOX, machineGuid=HOST['machineGuid'].upper()), params, True),
            'the host registered as the guest': (HOST, dict(params, guestIdentity=found['host']), True),
            # Missing or unclear identity.
            'no machine GUID': (dict(SANDBOX, machineGuid=''), params, True),
            'a zero SMBIOS UUID': (dict(SANDBOX, smbiosUuid='00000000-0000-0000-0000-000000000000'), params, True),
            'an all-F SMBIOS UUID': (dict(SANDBOX, smbiosUuid='FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'), params, True),
            'no host identity recorded': (SANDBOX, dict(params, hostIdentity=None), True),
            'host computer name not recorded': (SANDBOX, partial, True),
            # Not a supported guest.
            'a virtual machine not registered': (VM, params, True),
            'the registered guest with another SMBIOS UUID': (dict(VM, smbiosUuid=SANDBOX['smbiosUuid']), registered, True),
            'the sandbox account on a physical machine': (dict(SANDBOX, model='Desk 9', manufacturer='Example Inc.'), params, True),
            # Not blank.
            'yuzuno already there': (SANDBOX, params, False),
        }
        script = (prepare.LIB.read_text() + f"\n$cases = {literal({k: dict(zip(('facts', 'params', 'blank'), v)) for k, v in cls.cases.items()})}\n"
                  "$out = [ordered]@{}\n"
                  "foreach ($c in $cases.PSObject.Properties) { $out[$c.Name] = Get-Admission $c.Value.facts $c.Value.params ([bool]$c.Value.blank) }\n"
                  "$out | ConvertTo-Json -Depth 5 -Compress\n")
        cls.results = prepare.powershell(script)

    def check(self, label, admitted, kind, reasons):
        with self.subTest(label):
            got = self.results[label]
            self.assertEqual((got['admitted'], got['kind'], list(got['reasons'])), (admitted, kind, reasons))

    def test_every_case_was_evaluated(self):
        self.assertEqual(sorted(self.results), sorted(self.cases))

    def test_a_disposable_guest_that_is_not_the_host_is_admitted(self):
        self.check('windows sandbox', True, 'sandbox', [])
        self.check('the registered guest', True, 'registered', [])

    def test_the_host_is_refused_whatever_it_claims(self):
        self.check('the host with a valid params.json', False, None, THE_HOSTS + [NEITHER])
        self.check('the host under the sandbox account name', False, None, THE_HOSTS + [NEITHER])
        self.check('the host with every sandbox fact', False, 'sandbox', THE_HOSTS)
        self.check('the host renamed', False, None, THE_HOSTS[:2] + [NEITHER])
        self.check('a sandbox with the host machine GUID', False, 'sandbox', THE_HOSTS[:1])
        self.check('the host registered as the guest', False, 'registered', THE_HOSTS)

    def test_missing_or_placeholder_identity_is_refused(self):
        self.check('no machine GUID', False, 'sandbox', ["this machine's machineGuid is missing"])
        self.check('a zero SMBIOS UUID', False, 'sandbox', ["this machine's smbiosUuid is missing"])
        self.check('an all-F SMBIOS UUID', False, 'sandbox', ["this machine's smbiosUuid is missing"])
        self.check('no host identity recorded', False, 'sandbox',
                   [f"the host's {name} is not recorded" for name in ('machineGuid', 'smbiosUuid', 'computerName')])
        self.check('host computer name not recorded', False, 'sandbox', ["the host's computerName is not recorded"])

    def test_an_unsupported_guest_or_a_used_one_is_refused(self):
        self.check('a virtual machine not registered', False, None, [NEITHER])
        self.check('the registered guest with another SMBIOS UUID', False, None, [NEITHER])
        self.check('the sandbox account on a physical machine', False, None, [NEITHER])
        self.check('yuzuno already there', False, 'sandbox', ['Yuzuno is already installed or has data here'])

    def test_digests_are_salted_and_hold_no_raw_value(self):
        other = prepare.identity('f' * 32, facts=HOST)['host']
        for name in ('machineGuid', 'smbiosUuid', 'computerName'):
            self.assertRegex(self.found['host'][name], '^[0-9a-f]{64}$')
            self.assertNotEqual(self.found['host'][name], other[name], 'another token, another digest')
        text = json.dumps(self.found).lower()
        for value in (HOST['machineGuid'], HOST['smbiosUuid'], HOST['computerName'], VM['machineGuid']):
            self.assertNotIn(value.lower(), text)


if __name__ == '__main__':
    unittest.main()
