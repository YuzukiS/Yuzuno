#!/usr/bin/env python3
"""A small process tree that reports its own progress (T-107 pause fixture).

  fixture.py tree STATE_DIR [STEPS]   parent + 2 children, each with 1 grandchild

With STEPS, the parent exits 0 after that many of its own steps (frozen time
does not count) and stops its children first.

Every process rewrites STATE_DIR/<name>.json about every 20 ms with its pid
and a counter that only grows while it runs. SIGTERM is recorded in
STATE_DIR/<name>.term before exiting, so a check can tell whether a process
ran its handler (it was thawed) or was killed while frozen.
"""
import json
import os
import signal
import subprocess
import sys
import time


def report(state, name, count):
    path = os.path.join(state, name + '.json')
    tmp = path + '.new'
    with open(tmp, 'w') as f:
        json.dump({'name': name, 'pid': os.getpid(), 'count': count, 'at': time.time()}, f)
    os.replace(tmp, path)


def loop(state, name, children=(), steps=None):
    def term(signum, frame):
        with open(os.path.join(state, name + '.term'), 'w') as f:
            f.write(str(time.time()))
        for child in children:
            child.terminate()
        sys.exit(143)
    signal.signal(signal.SIGTERM, term)
    count = 0
    while True:
        # A little CPU work per step, so CPU time also shows progress.
        sum(i * i for i in range(2000))
        count += 1
        report(state, name, count)
        if steps and count >= steps:
            for child in children:
                child.terminate()
                child.wait()
            return
        time.sleep(0.02)


def spawn(state, name, role):
    return subprocess.Popen([sys.executable, os.path.abspath(__file__), role, state, name])


def main():
    role, state = sys.argv[1], sys.argv[2]
    if role == 'tree':
        os.makedirs(state, exist_ok=True)
        children = [spawn(state, f'child{i}', 'child') for i in (1, 2)]
        loop(state, 'parent', children, int(sys.argv[3]) if len(sys.argv) > 3 else None)
    elif role == 'child':
        name = sys.argv[3]
        grandchild = spawn(state, name + '-grandchild', 'leaf')
        loop(state, name, [grandchild])
    elif role == 'leaf':
        loop(state, sys.argv[3])


if __name__ == '__main__':
    main()
