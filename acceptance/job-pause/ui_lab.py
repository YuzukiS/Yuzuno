#!/usr/bin/env python3
"""The pause UI in a real browser against an isolated lab Core (T-107).

Starts the no-model lab host (core_check.py's), serves this worktree's web
build from it, starts one fixture job, then runs ui_shots.mjs in a memory
capped scope: it clicks Pause and Resume in the real Jobs panel. Cancels
the job and stops the lab Core afterwards.

Usage: ui_lab.py OUT_DIR   (needs web/dist and target/debug/examples/local_jobs_lab)
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # PYTHONSAFEPATH may be set
import core_check as lab  # noqa: E402


def main():
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    dist = lab.ROOT / 'web' / 'dist'
    ui = lab.LAB.parent / 'ui'  # where the lab host serves the UI from
    if ui.exists():
        shutil.rmtree(ui)
    shutil.copytree(dist, ui)
    lab.LAB.mkdir(parents=True, mode=0o700)
    (lab.LAB / 'work').mkdir()
    code = 1
    try:
        lab.start_core()
        lab.request('/jobs/budget', {'cpuMillis': 600, 'memoryMiB': 192, 'swapMiB': 0})
        job, state = lab.submit('Train small model')
        lab.wait_for(lambda: lab.job('Train small model'), lambda j: j['status'] == 'running')
        lab.tree_running(state)
        env = {**os.environ, 'BASE': lab.BASE, 'OUT': str(out), 'JOB': 'Train small model'}
        code = subprocess.run(['systemd-run', '--user', '--scope', '--quiet', '-p', 'MemoryMax=2G', '-p', 'MemorySwapMax=0',
                               '-p', 'CPUQuota=200%', '/usr/bin/env', f'PATH={os.environ["PATH"]}', 'node',
                               str(Path(__file__).resolve().parent / 'ui_shots.mjs')], env=env, timeout=180).returncode
        lab.request(f'/jobs/{job["id"]}/cancel', {})
        lab.terminal('Train small model', 40)
    finally:
        lab.stop_core()
    print(f'lab {lab.LAB}; screenshots in {out}')
    sys.exit(code)


if __name__ == '__main__':
    main()
