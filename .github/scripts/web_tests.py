#!/usr/bin/env python3
"""Run each discovered Node test file once, serially, with attributable logs.

The two-worker experiment did not pass; see acceptance/web-ci/README.md.
The existing 2 GiB old-space cap is not an RSS limit; the runner's VM bounds memory.
Each test and its ordinary descendants share a private process group, killed
on completion, timeout or cancellation. Tests must not daemonize/escape it.
"""
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

WEB = Path(__file__).resolve().parents[2] / 'web'
STOP = 0


def interrupt(signum, _frame):
    global STOP
    STOP = signum


def kill_group(process, signum):
    try:
        os.killpg(process.pid, signum)
    except ProcessLookupError:
        pass


def escape(message):
    return message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')


def emit_result(job):
    label = job['file']
    print(f'::group::{escape(label)}' if os.environ.get('GITHUB_ACTIONS') else f'=== {label}', flush=True)
    with job['log'].open('rb') as stream:
        shutil.copyfileobj(stream, sys.stdout.buffer)
    sys.stdout.buffer.write(b'\n')
    sys.stdout.buffer.flush()
    if os.environ.get('GITHUB_ACTIONS'):
        print('::endgroup::', flush=True)
    if job['rc'] and os.environ.get('GITHUB_ACTIONS'):
        print(f'::error title=Web test failed::{escape(label)} ({escape(job["reason"])})', flush=True)


def run(files, timeout, logdir):
    results = []
    active = None
    timeout_label = timeout if timeout[-1] in 'smhd' else timeout + 's'
    try:
        for index, file in enumerate(files):
            if STOP:
                break
            job = dict(file=file, start=time.monotonic(), log=logdir / f'{index}.log')
            print(f'START {file} (old-space 2048 MiB)', flush=True)
            with job['log'].open('wb') as output:
                try:
                    # A private group also contains ordinary child processes.
                    # GNU timeout keeps the existing 10-second kill grace.
                    job['process'] = subprocess.Popen(
                        ['timeout', '--kill-after=10', timeout, 'node',
                         '--max-old-space-size=2048', '--experimental-strip-types', file],
                        cwd=WEB, stdout=output, stderr=subprocess.STDOUT,
                        start_new_session=True)
                except OSError as error:
                    output.write(f'Could not start test: {error}\n'.encode())
                    job.update(rc=127, reason='could not start test')
            if 'process' in job:
                active = job
                process = job['process']
                while process.poll() is None and not STOP:
                    time.sleep(.025)
                if STOP:
                    break
                # A successful parent may still have left a background child.
                kill_group(process, signal.SIGKILL)
                rc = process.returncode
                job.update(rc=rc, reason=f'timed out after {timeout_label}' if rc == 124 else f'exit {rc}')
                active = None
            job['seconds'] = time.monotonic() - job['start']
            results.append(job)
            emit_result(job)
    finally:
        # CI cancellation, Ctrl+C and unexpected scheduler errors all clean up
        # before writing more logs (which itself could fail on a closed pipe).
        if active:
            process = active['process']
            kill_group(process, signal.SIGTERM)
            time.sleep(.1)
            kill_group(process, signal.SIGKILL)
            process.wait()
            active.update(rc=128 + STOP if STOP else 1,
                          seconds=time.monotonic()-active['start'],
                          reason='cancelled' if STOP else 'scheduler stopped')
            results.append(active)
            emit_result(active)
    return results


def main():
    workers = os.environ.get('WEB_TEST_JOBS', '1')
    timeout = os.environ.get('WEB_TEST_TIMEOUT', '300')
    if workers != '1':
        raise ValueError('WEB_TEST_JOBS must be 1; parallel execution has not passed validation')
    if not re.fullmatch(r'(?:\d+(?:\.\d*)?|\.\d+)[smhd]?', timeout) or float(timeout.rstrip('smhd')) <= 0:
        raise ValueError('WEB_TEST_TIMEOUT must be a positive duration (seconds, or s/m/h/d suffix)')
    files = sys.argv[1:] or sorted(str(p.relative_to(WEB)) for p in (WEB / 'tools').glob('*.test.mjs') if not p.name.startswith('.'))
    if not files:
        raise ValueError('No web/tools/*.test.mjs files found')
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupt)
    with tempfile.TemporaryDirectory(prefix='yuzuno-web-tests-') as directory:
        results = run(files, timeout, Path(directory))
    failures = sum(job['rc'] != 0 for job in results)
    title = f'Web test files: {len(results)} run, {failures} failed'
    if len(results) != len(files):
        title += f', {len(files)-len(results)} not started (cancelled)'
    lines = [f'{"FAIL" if job["rc"] else "PASS"}  {job["seconds"]:.2f}s  {job["file"]}' + (f' ({job["reason"]})' if job['rc'] else '') for job in results]
    print('\n' + title + '\n' + '\n'.join(lines), flush=True)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write(f'### {title}\n\n```\n' + '\n'.join(lines) + '\n```\n')
    return 128 + STOP if STOP else int(failures > 0)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError) as error:
        print(f'web-tests: {error}', file=sys.stderr)
        sys.exit(1)
