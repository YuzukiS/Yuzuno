#!/usr/bin/env python3
"""host.py `limit` (T-38 B, T-57): lowering a running attempt's memory limit.
A target equal to the cgroup's memory.max now is a lowering that already took
effect: it is confirmed as it is, and nothing is changed. Below it, the limit
is lowered as before; above it, refused as before. No real service changes:
the attempt's systemd unit, its cgroup and systemctl are stand-ins.
T57_HOST_PY names another host.py to run the same tests against."""
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HOST = Path(os.environ.get('T57_HOST_PY') or Path(__file__).resolve().parents[2] / 'core/src/jobs/host.py')
MODULE = importlib.util.spec_from_file_location('job_host', HOST)
host = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(host)
MIB = 1024 * 1024


class LimitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.spec = {'id': 'one', 'attempt': 'attempt', 'bootId': host.boot_id(), 'unit': 'worker', 'supervisorUnit': 'collector'}
        self.proof = {'jobId': 'one', 'attempt': 'attempt', 'bootId': host.boot_id(), 'invocationId': 'invocation',
                      'controlGroup': '/fake'}
        # A Job that asked 4,096 MiB and holds 200 MiB.
        self.cgroup = {'memory.current': 200 * MIB, 'memory.max': 4096 * MIB}
        self.set_property = []

    def tearDown(self):
        self.tmp.cleanup()

    def limit(self, mib):
        def live_worker(spec, folder):
            return {'ActiveState': 'active', 'SubState': 'running'}, self.proof

        def cgroup_bytes(proof, name):
            return self.cgroup.get(name)

        def command(args, timeout=8, check=True):
            # systemctl --user set-property --runtime <unit> MemoryMax=<n>M, as systemd applies it.
            self.set_property.append(args)
            self.cgroup['memory.max'] = int(args[-1].split('=')[1].rstrip('M')) * MIB
            return SimpleNamespace(returncode=0, stdout='', stderr='')

        with patch.object(host, 'live_worker', live_worker), patch.object(host, 'cgroup_bytes', cgroup_bytes), \
                patch.object(host, 'command', command):
            return host.limit(self.spec, self.folder, {'memoryMiB': mib})

    def test_a_target_equal_to_memory_max_is_a_lowering_in_effect_and_is_confirmed_as_it_is(self):
        # An earlier lowering to 1,024 MiB took effect, but its answer never reached Core.
        self.cgroup['memory.max'] = 1024 * MIB
        answer = self.limit(1024)
        self.assertEqual(answer['state'], 'limited', 'a retry of the applied value is confirmed: ' + str(answer))
        self.assertTrue(answer.get('confirmedByRetry'), 'the answer says a retry confirmed it')
        self.assertEqual(self.set_property, [], 'the same value again runs no set-property')
        self.assertEqual(self.cgroup['memory.max'], 1024 * MIB)
        self.assertEqual((answer['evidence']['memoryMaxBefore'], answer['evidence']['memoryMaxAfter']), (1024 * MIB, 1024 * MIB))
        self.assertIn('already 1024 MiB', answer['reason'])
        recorded = host.read(self.folder / 'limited.json')
        self.assertEqual((recorded['attempt'], recorded['confirmedByRetry'], recorded['memoryMaxAfter']), ('attempt', True, 1024 * MIB))

    def test_a_target_below_memory_max_is_lowered_as_before(self):
        answer = self.limit(1024)
        self.assertEqual(answer['state'], 'limited', answer)
        self.assertNotIn('confirmedByRetry', answer, 'an ordinary lowering is not a retry')
        self.assertEqual(len(self.set_property), 1, 'systemd is asked once')
        self.assertEqual(self.set_property[0][-2:], ['worker', 'MemoryMax=1024M'])
        self.assertEqual((answer['evidence']['memoryMaxBefore'], answer['evidence']['memoryMaxAfter']), (4096 * MIB, 1024 * MIB))

    def test_a_target_above_memory_max_is_refused_as_before(self):
        self.cgroup['memory.max'] = 1024 * MIB
        answer = self.limit(2048)
        self.assertEqual(answer['state'], 'notLimited', answer)
        self.assertIn('2048 MiB is not below the current limit of 1024 MiB; a limit is only lowered', answer['reason'])
        self.assertEqual(self.set_property, [], 'nothing is asked of systemd')
        self.assertEqual(self.cgroup['memory.max'], 1024 * MIB)

    def test_below_what_the_job_uses_now_plus_256_mib_is_still_refused(self):
        answer = self.limit(300)
        self.assertEqual(answer['state'], 'notLimited', answer)
        self.assertIn('below what the job uses now plus 256 MiB', answer['reason'])
        self.assertEqual(self.set_property, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
