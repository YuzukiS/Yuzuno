#!/usr/bin/env python3
"""Device injection of the job host helper; no real GPU calls. GPU sampling
is Core's GPU sampler's alone (T-58), not the helper's."""
import importlib.util
import os
from pathlib import Path
import unittest
MODULE = importlib.util.spec_from_file_location(
    'job_host', os.environ.get('JOB_HOST_PY') or Path(__file__).resolve().parents[2] / 'core/src/jobs/host.py')
host = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(host)

GPU0 = 'GPU-00000000-1111-2222-3333-444444444444'
GPU1 = 'GPU-55555555-6666-7777-8888-999999999999'
class GpuTests(unittest.TestCase):
    def test_an_attempt_sees_only_the_devices_reserved_for_it(self):
        spec = {'id': 'j', 'attempt': 'a', 'gpuReservation': [{'uuid': GPU1, 'memoryMiB': 4096}, {'uuid': GPU0}]}
        env = host.attempt_env(spec, Path('/nonexistent'))
        self.assertEqual(env['CUDA_VISIBLE_DEVICES'], f'{GPU1},{GPU0}')
        self.assertEqual(env['YUZUNO_JOB_GPUS'], f'{GPU1},{GPU0}')
        for spec in ({'id': 'j', 'attempt': 'a'}, {'id': 'j', 'attempt': 'a', 'gpuReservation': None},
                     {'id': 'j', 'attempt': 'a', 'gpuReservation': [{'memoryMiB': 1}]}):
            with self.subTest(spec=spec):
                env = host.attempt_env(spec, Path('/nonexistent'))
                self.assertNotIn('CUDA_VISIBLE_DEVICES', env)
                self.assertNotIn('YUZUNO_JOB_GPUS', env)


if __name__ == '__main__':
    unittest.main()
