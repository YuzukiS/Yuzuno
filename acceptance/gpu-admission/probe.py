#!/usr/bin/env python3
"""What GPU sampling can and cannot see on this host (T-106). Read-only: it
allocates nothing on the GPU and changes no setting.

Compares nvidia-smi with NVML through ctypes: device identity (UUID, index,
PCI bus), memory, utilization and the compute process list, and how long
each takes. On WSL the process list can be empty while the card is in use,
so it must never be read as "idle".
"""
import ctypes
import json
import subprocess
import sys
import time


def smi():
    started = time.monotonic()
    fields = 'index,uuid,name,pci.bus_id,memory.total,memory.used,memory.free,utilization.gpu'
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=' + fields, '--format=csv,noheader,nounits'],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        apps = subprocess.run(['nvidia-smi', '--query-compute-apps=pid,gpu_uuid,used_memory',
                               '--format=csv,noheader,nounits'],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'error': str(error)}
    devices = []
    for line in out.stdout.strip().splitlines():
        index, uuid, name, bus, total, used, free, util = [v.strip() for v in line.split(',')]
        devices.append({'index': int(index), 'uuid': uuid, 'name': name, 'pciBusId': bus,
                        'memoryTotalMiB': int(total), 'memoryUsedMiB': int(used),
                        'memoryFreeMiB': int(free), 'utilizationPercent': None if util in ('[N/A]', '') else int(util)})
    return {'returnCode': out.returncode, 'devices': devices,
            'computeApps': [line for line in apps.stdout.strip().splitlines() if line],
            'computeAppsReturnCode': apps.returncode, 'seconds': round(time.monotonic() - started, 3)}


class Memory(ctypes.Structure):
    _fields_ = [('total', ctypes.c_ulonglong), ('free', ctypes.c_ulonglong), ('used', ctypes.c_ulonglong)]


class Utilization(ctypes.Structure):
    _fields_ = [('gpu', ctypes.c_uint), ('memory', ctypes.c_uint)]


def nvml():
    started = time.monotonic()
    try:
        lib = ctypes.CDLL('libnvidia-ml.so.1')
    except OSError as error:
        return {'error': f'libnvidia-ml.so.1 not loadable: {error}'}
    if lib.nvmlInit_v2() != 0:
        return {'error': 'nvmlInit failed'}
    try:
        count = ctypes.c_uint()
        lib.nvmlDeviceGetCount_v2(ctypes.byref(count))
        devices = []
        for index in range(count.value):
            handle = ctypes.c_void_p()
            lib.nvmlDeviceGetHandleByIndex_v2(index, ctypes.byref(handle))
            uuid = ctypes.create_string_buffer(96)
            lib.nvmlDeviceGetUUID(handle, uuid, 96)
            memory = Memory()
            memory_rc = lib.nvmlDeviceGetMemoryInfo(handle, ctypes.byref(memory))
            util = Utilization()
            util_rc = lib.nvmlDeviceGetUtilizationRates(handle, ctypes.byref(util))
            procs = ctypes.c_uint(0)
            # Size query: NVML_ERROR_INSUFFICIENT_SIZE (7) means processes exist.
            procs_rc = lib.nvmlDeviceGetComputeRunningProcesses_v3(handle, ctypes.byref(procs), None)
            devices.append({'index': index, 'uuid': uuid.value.decode(),
                            'memoryTotalMiB': memory.total // 1048576 if memory_rc == 0 else None,
                            'memoryUsedMiB': memory.used // 1048576 if memory_rc == 0 else None,
                            'utilizationPercent': util.gpu if util_rc == 0 else None,
                            'computeProcessesReturnCode': procs_rc, 'computeProcesses': procs.value})
        return {'devices': devices, 'seconds': round(time.monotonic() - started, 3)}
    finally:
        lib.nvmlShutdown()


def main():
    report = {'observedAt': time.time(), 'nvidiaSmi': smi(), 'nvml': nvml()}
    devices = report['nvidiaSmi'].get('devices') or []
    report['findings'] = {
        'stableIdentity': 'uuid' if all(d['uuid'].startswith('GPU-') for d in devices) and devices else 'unavailable',
        'emptyProcessListWhileInUse': any(d['memoryUsedMiB'] > 0 for d in devices) and not report['nvidiaSmi'].get('computeApps'),
        'smiAndNvmlAgreeOnUuid': sorted(d['uuid'] for d in devices) == sorted(d['uuid'] for d in report['nvml'].get('devices') or []),
    }
    json.dump(report, sys.stdout, indent=2)
    print()


if __name__ == '__main__':
    main()
