#!/usr/bin/env python3
"""Does freezing a GPU job's cgroup give its GPU time to another job? (T-107)

Runs two small CUDA workloads (gpu_probe.cu), A and B, each in its own
transient user unit (prefix t107-probe-, bounded memory, CPU and tasks).
Three equal windows: both run; A frozen; A thawed. Records each workload's
completed launches per second, how soon B speeds up after A is frozen
(queued GPU work keeps running), nvidia-smi samples, A's process identity
before and after, and whether A's final result recomputes exactly.

Only units this run started are frozen, thawed or stopped.
Usage: gpu_yield.py OUT_DIR BINARY KERNEL_MS QUEUE [WINDOW_SECONDS] [MIB] [EXTRA_SECONDS]
"""
import json
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # PYTHONSAFEPATH may be set
import probe  # noqa: E402


def start(name, binary, out, seconds, mib, kernel_ms, queue, rounds=None):
    unit = f't107-probe-{probe.RUN}-{name}.service'
    launched = probe.sh('systemd-run', '--user', '--quiet', '--unit=' + unit, '--service-type=exec',
                        '-p', f'Description=T-107 probe {probe.RUN} {name}', '-p', 'RemainAfterExit=yes',
                        '-p', 'Restart=no', '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=3s',
                        '-p', f'RuntimeMaxSec={int(seconds) + 60}s', '-p', 'MemoryMax=2G',
                        '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=100%', '-p', 'TasksMax=64',
                        '--', str(binary), name, str(out), str(seconds), str(mib), str(kernel_ms), str(queue),
                        *([str(rounds)] if rounds else []))
    if launched['code']:
        raise RuntimeError(launched)
    probe.OWNED.add(unit)
    return unit


def lines(path):
    try:
        return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]
    except (OSError, ValueError):
        return []


def rate(entries, lo, hi):
    inside = [e for e in entries if lo <= e['t'] <= hi]
    if len(inside) < 2 or inside[-1]['t'] == inside[0]['t']:
        return 0.0 if inside or entries else None
    return (inside[-1]['kernels'] - inside[0]['kernels']) / (inside[-1]['t'] - inside[0]['t'])


def series(entries, lo, hi, step=0.2):
    """Launch rate in consecutive step-second bins."""
    out, t = [], lo
    while t + step <= hi:
        before = [e for e in entries if e['t'] <= t]
        after = [e for e in entries if e['t'] <= t + step]
        if before and after:
            out.append({'t': round(t - lo, 2), 'rate': (after[-1]['kernels'] - before[-1]['kernels']) / step})
        t += step
    return out


def smi(stop, samples):
    while not stop.is_set():
        done = subprocess.run(['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,power.draw',
                               '--format=csv,noheader,nounits'], capture_output=True, text=True)
        if done.returncode == 0:
            util, used, power = [v.strip() for v in done.stdout.strip().split(',')]
            samples.append({'t': time.time(), 'util': float(util), 'usedMiB': float(used), 'powerW': float(power)})
        time.sleep(0.5)


def main():
    out, binary = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    kernel_ms, queue = float(sys.argv[3]), int(sys.argv[4])
    window = float(sys.argv[5]) if len(sys.argv) > 5 else 8
    mib = int(sys.argv[6]) if len(sys.argv) > 6 else 256
    # Long kernels need longer to start and to finish their last launch.
    extra = float(sys.argv[7]) if len(sys.argv) > 7 else 4
    out.mkdir(parents=True, exist_ok=True)
    record = {'run': probe.RUN, 'kernelMs': kernel_ms, 'queue': queue, 'windowSeconds': window, 'mib': mib}
    samples, stop = [], threading.Event()
    sampler = threading.Thread(target=smi, args=(stop, samples), daemon=True)
    sampler.start()
    try:
        time.sleep(1.5)
        idle_until = time.time()
        seconds = 3 * window + extra
        # A calibrates alone; B then does exactly the same work per launch.
        units = {'A': start('A', binary, out, seconds, mib, kernel_ms, queue)}
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not lines(out / 'A.jsonl'):
            time.sleep(0.05)
        record['rounds'] = lines(out / 'A.jsonl')[0]['rounds']
        units['B'] = start('B', binary, out, seconds, mib, kernel_ms, queue, record['rounds'])
        record['units'] = units
        # Both are launching.
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not all(len(lines(out / f'{n}.jsonl')) > 3 for n in units):
            time.sleep(0.1)
        _, procs = probe.tree(units['A'])
        record['aProcessesBefore'] = procs
        t1 = time.time()
        time.sleep(window)
        t2 = time.time()
        record['freeze'] = probe.control('freeze', units['A'])
        record['secondsToFrozen'] = probe.wait_events(units['A'], 'frozen', '1')
        record['frozenState'] = {k: probe.show(units['A']).get(k) for k in ('FreezerState', 'MemoryCurrent', 'InvocationID')}
        _, frozen_procs = probe.tree(units['A'])
        record['aProcessStatesFrozen'] = {pid: v['state'] for pid, v in frozen_procs.items()}
        time.sleep(window)
        t3 = time.time()
        _, frozen_later = probe.tree(units['A'])
        record['aCpuTicksWhileFrozen'] = {pid: frozen_later[pid]['cpuTicks'] - frozen_procs[pid]['cpuTicks']
                                         for pid in frozen_later if pid in frozen_procs}
        record['thaw'] = probe.control('thaw', units['A'])
        record['secondsToThawed'] = probe.wait_events(units['A'], 'frozen', '0')
        time.sleep(window)
        t4 = time.time()
        _, procs_after = probe.tree(units['A'])
        record['aProcessesAfter'] = procs_after
        record['aSameProcesses'] = ({p: v['startTicks'] for p, v in procs.items()}
                                    == {p: v['startTicks'] for p, v in procs_after.items()})
        deadline = time.monotonic() + seconds + 30
        while time.monotonic() < deadline and not all((out / f'{n}.result.json').exists() for n in units):
            time.sleep(0.2)
        time.sleep(2)
        after_until = time.time()
    finally:
        stop.set()
        probe.cleanup()
    record['times'] = {'bothRunning': t1, 'freeze': t2, 'thaw': t3, 'end': t4}
    a, b = lines(out / 'A.jsonl'), lines(out / 'B.jsonl')
    record['bReportsAroundFreeze'] = [(round(e['t'] - t2, 2), e['kernels']) for e in b if t2 - 4 <= e['t'] <= t2 + 6]
    edge = 1.0  # skip a second after each change
    record['windows'] = {
        'bothRunning': {'A': rate(a, t1 + edge, t2), 'B': rate(b, t1 + edge, t2)},
        'aFrozen': {'A': rate(a, t2 + edge, t3), 'B': rate(b, t2 + edge, t3)},
        'aThawed': {'A': rate(a, t3 + edge, t4), 'B': rate(b, t3 + edge, t4)},
    }
    record['bAroundFreeze'] = series(b, t2 - 1, t2 + 3)
    record['aAroundThaw'] = series(a, t3 - 1, t3 + 3)
    record['results'] = {n: json.loads((out / f'{n}.result.json').read_text()) if (out / f'{n}.result.json').exists() else None
                         for n in ('A', 'B')}
    record['aPid'] = a[0].get('pid') if a else None
    record['bDeviceFreeMiB'] = {'bothRunning': [e.get('deviceFreeMiB') for e in b if t1 <= e['t'] <= t2][-1:],
                                'aFrozen': [e.get('deviceFreeMiB') for e in b if t2 <= e['t'] <= t3][-1:]}
    def smi_in(lo, hi):
        picked = [s for s in samples if lo <= s['t'] <= hi]
        return {'n': len(picked),
                'utilMean': round(statistics.mean(s['util'] for s in picked), 1) if picked else None,
                'usedMiBMedian': statistics.median(s['usedMiB'] for s in picked) if picked else None}
    record['nvidiaSmi'] = {'beforeStart': smi_in(0, idle_until), 'bothRunning': smi_in(t1 + edge, t2),
                           'aFrozen': smi_in(t2 + edge, t3), 'aThawed': smi_in(t3 + edge, t4),
                           'afterExit': smi_in(after_until - 1.5, after_until + 5)}
    record['nvidiaSmiSamples'] = samples
    path = out / f'gpu-yield-{probe.RUN}.json'
    path.write_text(json.dumps(record, indent=1, default=str))
    summary = {k: record[k] for k in ('kernelMs', 'queue', 'rounds', 'secondsToFrozen', 'secondsToThawed', 'aSameProcesses',
                                      'windows', 'nvidiaSmi', 'bDeviceFreeMiB', 'aCpuTicksWhileFrozen', 'aProcessStatesFrozen')}
    summary['valid'] = {n: (r or {}).get('valid') for n, r in record['results'].items()}
    summary['bAroundFreeze'] = record['bAroundFreeze']
    print(json.dumps(summary, indent=1, default=str))
    print(path)


if __name__ == '__main__':
    main()
