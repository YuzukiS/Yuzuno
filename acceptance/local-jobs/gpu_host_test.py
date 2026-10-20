#!/usr/bin/env python3
"""GPU sampling and device injection of the job host helper; no real GPU calls."""
import importlib.util
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
MODULE = importlib.util.spec_from_file_location(
    'job_host', os.environ.get('JOB_HOST_PY') or Path(__file__).resolve().parents[2] / 'core/src/jobs/host.py')
host = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(host)

GPU0 = 'GPU-00000000-1111-2222-3333-444444444444'
GPU1 = 'GPU-55555555-6666-7777-8888-999999999999'
SMI = (f'0, {GPU0}, NVIDIA GeForce RTX 5090, 32607, 16972, 15215, 15\n'
       f'1, {GPU1}, NVIDIA RTX A4000, 16376, 16000, 0, [N/A]\n')


def ran(stdout):
    return subprocess.CompletedProcess([], 0, stdout=stdout, stderr='')


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

    def test_nvidia_smi_is_found_outside_path_and_read_by_uuid_and_memory(self):
        calls = []
        with patch.object(host.shutil, 'which', return_value=None), \
                patch.object(host.Path, 'exists', lambda p: str(p) == '/usr/lib/wsl/lib/nvidia-smi'), \
                patch.object(host, 'command', lambda args, timeout=8: calls.append(args) or ran(SMI)):
            devices = host.smi_devices()
        self.assertEqual(calls[0][0], '/usr/lib/wsl/lib/nvidia-smi')
        # Memory and utilization only: the compute process list is never asked for.
        self.assertTrue(calls[0][1].startswith('--query-gpu='))
        self.assertFalse(any('compute-apps' in a or 'pmon' in a for a in calls[0]))
        self.assertEqual(devices, [
            {'index': 0, 'uuid': GPU0, 'name': 'NVIDIA GeForce RTX 5090', 'memoryTotalMiB': 32607,
             'memoryFreeMiB': 16972, 'memoryUsedMiB': 15215, 'utilizationPercent': 15},
            {'index': 1, 'uuid': GPU1, 'name': 'NVIDIA RTX A4000', 'memoryTotalMiB': 16376,
             'memoryFreeMiB': 16000, 'memoryUsedMiB': 0, 'utilizationPercent': None}])

    def test_without_nvml_the_sample_comes_from_nvidia_smi_and_says_so(self):
        with patch.object(host, 'nvml_devices', side_effect=OSError('libnvidia-ml.so.1: cannot open')), \
                patch.object(host, 'smi_devices', return_value=[{'uuid': GPU0}]):
            sample = host.gpus()
        self.assertEqual(sample['source'], 'nvidia-smi')
        self.assertEqual(sample['devices'], [{'uuid': GPU0}])
        self.assertIn('cannot open', sample['nvmlError'])

    def test_no_reader_is_an_error_not_an_empty_idle_host(self):
        with patch.object(host, 'nvml_devices', side_effect=OSError('no NVML')), \
                patch.object(host, 'smi_devices', side_effect=RuntimeError('nvidia-smi not found')):
            sample = host.gpus()
        self.assertEqual(sample['devices'], [])
        self.assertEqual(sample['error'], 'NVML: no NVML; nvidia-smi: nvidia-smi not found')
        self.assertNotIn('source', sample)
        with patch.object(host.shutil, 'which', return_value=None), \
                patch.object(host.Path, 'exists', lambda p: False):
            with self.assertRaisesRegex(RuntimeError, 'nvidia-smi not found'):
                host.smi_devices()


if __name__ == '__main__':
    unittest.main()
