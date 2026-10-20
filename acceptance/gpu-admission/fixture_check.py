#!/usr/bin/env python3
"""Validate the CUDA fixture once on this host (T-106), small and bounded:
256 MiB for 4 seconds on the device selected by UUID through
CUDA_VISIBLE_DEVICES, sampling memory while it runs; then an unknown UUID,
which must leave the fixture with no visible device. Usage:
fixture_check.py <out dir> (with gpu_fixture built there)."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

out = Path(sys.argv[1])
fixture = out / 'gpu_fixture'
# A Job's PATH has no /usr/lib/wsl/lib, where WSL keeps nvidia-smi.
SMI = shutil.which('nvidia-smi') or next(
    (p for p in ('/usr/lib/wsl/lib/nvidia-smi', '/usr/bin/nvidia-smi') if Path(p).exists()), 'nvidia-smi')


def sample():
    try:
        line = subprocess.run([SMI, '--query-gpu=uuid,memory.used,memory.free,utilization.gpu',
                               '--format=csv,noheader,nounits'], stdout=subprocess.PIPE, text=True,
                              timeout=10).stdout.strip().splitlines()[0]
    except (OSError, subprocess.TimeoutExpired, IndexError) as error:
        return {'error': str(error), 'at': time.time()}
    uuid, used, free, util = [v.strip() for v in line.split(',')]
    return {'uuid': uuid, 'usedMiB': int(used), 'freeMiB': int(free), 'utilization': util, 'at': time.time()}


def run(uuid, mib, seconds):
    env = {'PATH': '/usr/bin:/bin', 'CUDA_VISIBLE_DEVICES': uuid}
    process = subprocess.Popen([str(fixture), '--mib', str(mib), '--seconds', str(seconds),
                                '--progress', str(out / 'progress.json')],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    during = []
    while process.poll() is None:
        during.append(sample())
        time.sleep(.5)
    stdout, stderr = process.communicate()
    events = [json.loads(line) for line in stdout.splitlines() if line.startswith('{')]
    return {'exit': process.returncode, 'events': events, 'stderr': stderr.strip()[:500], 'during': during}


before = sample()
uuid = before.get('uuid')
report = {'before': before}
if uuid:
    report['selected'] = run(uuid, 256, 4)
    report['after'] = sample()
    report['unknownUuid'] = run('GPU-00000000-0000-0000-0000-000000000000', 64, 1)
    seen = [e for e in report['selected']['events'] if e.get('event') == 'device']
    peak = max((s.get('usedMiB', 0) for s in report['selected']['during']), default=0)
    report['findings'] = {
        'fixtureSawSelectedUuid': bool(seen) and seen[0]['uuid'] == uuid,
        'fixtureCompleted': report['selected']['exit'] == 0,
        # A kernel that really ran moved the buffer away from zero.
        'kernelRan': any(e.get('event') == 'done' and e.get('sample', 0) > 0 for e in report['selected']['events']),
        'unknownUuidHasNoDevice': report['unknownUuid']['exit'] == 3,
        'observedPeakDeltaMiB': peak - before['usedMiB'],
        'note': 'memory.used is the whole card (other users included); the delta is indicative, not attribution',
    }
json.dump(report, sys.stdout, indent=2)
