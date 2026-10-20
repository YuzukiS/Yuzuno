#!/usr/bin/env python3
"""Does a CUDA process survive a long freeze and continue correctly? (T-107)

One gpu_probe workload in its own transient user unit (t107-probe-<run>-*):
runs a few seconds, is frozen for FROZEN_SECONDS, is thawed, runs a few
seconds more, exits and checks its own result. Records launches per second
before and after, nvidia-smi memory while frozen, and the process identity.

Usage: gpu_long_pause.py OUT_DIR BINARY FROZEN_SECONDS [KERNEL_MS] [MIB]
"""
import json
import statistics
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # PYTHONSAFEPATH may be set
import probe  # noqa: E402
import gpu_yield  # noqa: E402


def main():
    out, binary = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    frozen_for = float(sys.argv[3])
    kernel_ms = float(sys.argv[4]) if len(sys.argv) > 4 else 4
    mib = int(sys.argv[5]) if len(sys.argv) > 5 else 256
    out.mkdir(parents=True, exist_ok=True)
    run_before = run_after = 5
    record = {'run': probe.RUN, 'frozenSeconds': frozen_for, 'kernelMs': kernel_ms, 'mib': mib}
    samples, stop = [], threading.Event()
    threading.Thread(target=gpu_yield.smi, args=(stop, samples), daemon=True).start()
    try:
        time.sleep(1.5)
        idle_until = time.time()
        unit = gpu_yield.start('L', binary, out, run_before + frozen_for + run_after, mib, kernel_ms, 1)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and len(gpu_yield.lines(out / 'L.jsonl')) < 3:
            time.sleep(0.1)
        _, before = probe.tree(unit)
        t1 = time.time()
        time.sleep(run_before)
        t2 = time.time()
        record['freeze'] = probe.control('freeze', unit)
        record['secondsToFrozen'] = probe.wait_events(unit, 'frozen', '1')
        time.sleep(frozen_for)
        t3 = time.time()
        record['thaw'] = probe.control('thaw', unit)
        record['secondsToThawed'] = probe.wait_events(unit, 'frozen', '0')
        time.sleep(1)
        _, after = probe.tree(unit)
        record['sameProcess'] = ({p: v['startTicks'] for p, v in before.items()}
                                 == {p: v['startTicks'] for p, v in after.items()})
        deadline = time.monotonic() + run_after + 30
        while time.monotonic() < deadline and not (out / 'L.result.json').exists():
            time.sleep(0.2)
        time.sleep(2)
        t4 = time.time()
    finally:
        stop.set()
        probe.cleanup()
    lines = gpu_yield.lines(out / 'L.jsonl')
    record['times'] = {'running': t1, 'freeze': t2, 'thaw': t3, 'end': t4}
    record['rates'] = {'beforeFreeze': gpu_yield.rate(lines, t1 + 1, t2),
                       'frozen': gpu_yield.rate(lines, t2 + 1, t3),
                       'afterThaw': gpu_yield.rate(lines, t3 + 1, t3 + run_after)}
    record['result'] = json.loads((out / 'L.result.json').read_text()) if (out / 'L.result.json').exists() else None

    def used(lo, hi):
        picked = [s['usedMiB'] for s in samples if lo <= s['t'] <= hi]
        return {'n': len(picked), 'median': statistics.median(picked) if picked else None,
                'min': min(picked) if picked else None, 'max': max(picked) if picked else None}
    record['nvidiaSmiUsedMiB'] = {'before': used(0, idle_until), 'running': used(t1 + 1, t2),
                                  'frozen': used(t2 + 1, t3), 'afterExit': used(t4 - 1.5, t4 + 5)}
    path = out / f'gpu-long-pause-{probe.RUN}.json'
    path.write_text(json.dumps({**record, 'samples': samples}, indent=1, default=str))
    print(json.dumps(record, indent=1, default=str))
    print(path)


if __name__ == '__main__':
    main()
