#!/usr/bin/env python3
"""Small, bounded loads for the T-108 resource acceptance (Python 3.10+).

    load.py cpu --workers N --seconds S
    load.py memory --step-mib M --max-mib X [--hold-seconds H]

Each prints one JSON line per event to stdout, flushed at once, so a job's
log shows how far it got even when a limit stops it:

- cpu: N busy processes for S seconds, then {"load": "cpu", "wall": seconds,
  "cpu": seconds of CPU all workers used, "cores": cpu / wall}. Under a CPU
  quota of Q cores the cores figure stays near Q however large N is; without
  one it comes near N (on an idle enough machine).
- memory: allocates M MiB at a time, writing every page so the memory is
  really in use, printing {"load": "memory", "mib": total} after each step,
  up to X MiB, holds it H seconds and exits 0. Under a memory limit below X
  the process is stopped (Linux cgroup: killed; a Windows Job Object
  commit limit: the allocation fails) and the last line names the last step
  that fitted.

Nothing is written to disk and nothing outlives the command.
"""
import argparse
import json
import multiprocessing
import os
import sys
import time

MIB = 1024 * 1024


def say(**fields):
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


def spin(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        pass


def cpu(workers, seconds):
    start, before = time.monotonic(), os.times()
    # Forked, so the workers are this process's own children and their CPU
    # time is counted below (Python 3.14 defaults to a forkserver on Linux).
    fork = multiprocessing.get_context("fork")
    procs = [fork.Process(target=spin, args=(seconds,)) for _ in range(workers)]
    for p in procs:
        p.start()
    say(load="cpu", started=workers, pids=[p.pid for p in procs])
    for p in procs:
        p.join()
    wall, after = time.monotonic() - start, os.times()
    used = (after.children_user - before.children_user) + (after.children_system - before.children_system)
    say(load="cpu", workers=workers, wall=round(wall, 3), cpu=round(used, 3), cores=round(used / wall, 3),
        exitcodes=[p.exitcode for p in procs])
    return 0 if all(p.exitcode == 0 for p in procs) else 1


def memory(step, maximum, hold):
    chunks, total = [], 0
    try:
        while total + step <= maximum:
            chunks.append(bytearray(b"\x01") * (step * MIB))
            total += step
            say(load="memory", mib=total)
    except MemoryError:
        say(load="memory", mib=total, refused=step)
        return 3
    say(load="memory", mib=total, holding=hold)
    time.sleep(hold)
    say(load="memory", mib=total, done=True)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="kind", required=True)
    c = sub.add_parser("cpu")
    c.add_argument("--workers", type=int, default=2)
    c.add_argument("--seconds", type=float, default=5)
    m = sub.add_parser("memory")
    m.add_argument("--step-mib", type=int, default=16)
    m.add_argument("--max-mib", type=int, default=256)
    m.add_argument("--hold-seconds", type=float, default=0)
    args = parser.parse_args()
    if args.kind == "cpu":
        if not (1 <= args.workers <= 16 and 0 < args.seconds <= 120):
            parser.error("cpu: 1-16 workers for up to 120 s")
        return cpu(args.workers, args.seconds)
    if not (1 <= args.step_mib <= 256 and args.step_mib <= args.max_mib <= 4096 and 0 <= args.hold_seconds <= 120):
        parser.error("memory: steps of 1-256 MiB up to 4096 MiB, held up to 120 s")
    return memory(args.step_mib, args.max_mib, args.hold_seconds)


if __name__ == "__main__":
    sys.exit(main())
