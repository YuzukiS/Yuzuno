#!/usr/bin/env python3
"""Run Core's test binaries in parallel processes, each one test at a time (T-150).

`cargo test -- --test-threads=1` ran every test binary in turn. Each process
here still runs one test at a time: with parallel threads, Store
drop-and-reopen tests intermittently failed with "lock acquisition failed
because the operation would block", since a child that another thread was
spawning held the Workspace lock's file until it exec'd. Separate processes
share no file descriptors or environment, every test makes its own temporary
directory, and no test binds a fixed port.

1. `cargo test --locked --no-run --message-format=json` names the test
   executables `cargo test` would run (it builds nothing after the Build step).
2. Each one lists its tests (`--list --format terse`). One with at least SPLIT
   tests is split by sorted name, round-robin, into one shard per worker; the
   others run whole.
3. CORE_TEST_JOBS processes (default: the CPU count) run at once, largest
   first, each `<executable> --test-threads=1 [--exact NAME...]` in its
   package's directory, as cargo runs it. Each process's output is kept and
   printed whole when it ends; its process group is killed then.
4. A process passes only if it exits 0 and its libtest summary accounts for
   exactly the tests it was given: passed + ignored equals that number and
   none failed. A test that did not run therefore fails the step.
Doc tests are not run here; the workflow runs `cargo test --doc` itself.
"""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
SPLIT = 100
SUMMARY = re.compile(r'^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; \d+ measured; \d+ filtered out', re.M)
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


def executables():
    """(label, executable, package directory) of each test binary."""
    run = subprocess.run(['cargo', 'test', '--locked', '--no-run', '--message-format=json'],
                         cwd=ROOT, stdout=subprocess.PIPE, text=True)
    if run.returncode:
        raise RuntimeError(f'cargo test --no-run exited {run.returncode}')
    found = []
    for line in run.stdout.splitlines():
        message = json.loads(line) if line.startswith('{') else {}
        if message.get('reason') == 'compiler-artifact' and message['profile']['test'] and message.get('executable'):
            target = message['target']
            found.append((f'{target["kind"][0]} {target["name"]}', message['executable'],
                          str(Path(message['manifest_path']).parent)))
    if not found:
        raise RuntimeError('cargo test --no-run named no test executables')
    return found


def listed(executable, cwd):
    run = subprocess.run([executable, '--list', '--format', 'terse'], cwd=cwd, stdout=subprocess.PIPE, text=True)
    if run.returncode:
        raise RuntimeError(f'{executable} --list exited {run.returncode}')
    names = []
    for line in run.stdout.splitlines():
        if not line.endswith(': test'):
            raise RuntimeError(f'{executable} --list printed an unexpected line: {line!r}')
        names.append(line[:-len(': test')])
    return sorted(names)


def plan(jobs):
    items = []
    for label, executable, cwd in executables():
        names = listed(executable, cwd)
        if len(names) >= SPLIT and jobs > 1:
            for shard in range(jobs):
                part = names[shard::jobs]
                items.append(dict(label=f'{label} [{shard + 1}/{jobs}]', cwd=cwd, count=len(part),
                                  command=[executable, '--test-threads=1', '--exact', *part]))
        else:
            items.append(dict(label=label, cwd=cwd, count=len(names), command=[executable, '--test-threads=1']))
    return sorted(items, key=lambda item: -item['count'])


def verdict(item):
    """Why this process failed, or None."""
    rc = item['rc']
    if rc < 0:
        return f'killed by signal {-rc}'
    if rc:
        return f'exit {rc}'
    results = SUMMARY.findall(item['log'].read_text(errors='replace'))
    if not results:
        return 'no libtest summary'
    passed, failed, ignored = map(int, results[-1])
    if failed or passed + ignored != item['count']:
        return f'{passed} passed, {failed} failed and {ignored} ignored of {item["count"]} tests given'
    return None


def emit(item):
    label = item['label']
    print(f'::group::{escape(label)}' if os.environ.get('GITHUB_ACTIONS') else f'=== {label}', flush=True)
    sys.stdout.buffer.write(item['log'].read_bytes() + b'\n')
    sys.stdout.buffer.flush()
    if os.environ.get('GITHUB_ACTIONS'):
        print('::endgroup::', flush=True)
        if item['reason']:
            print(f'::error title=Core tests failed::{escape(label)} ({escape(item["reason"])})', flush=True)


def run(items, jobs, logdir):
    pending, running, done = list(items), [], []
    try:
        while (pending or running) and not STOP:
            while pending and len(running) < jobs and not STOP:
                item = pending.pop(0)
                item.update(start=time.monotonic(), log=logdir / f'{len(done) + len(running)}.log')
                print(f'START {item["label"]} ({item["count"]} tests)', flush=True)
                with item['log'].open('wb') as output:
                    item['process'] = subprocess.Popen(
                        item['command'], cwd=item['cwd'], stdout=output, stderr=subprocess.STDOUT,
                        env=dict(os.environ, CARGO_MANIFEST_DIR=item['cwd']), start_new_session=True)
                running.append(item)
            time.sleep(.05)
            for item in [item for item in running if item['process'].poll() is not None]:
                running.remove(item)
                # A test may have left a background child behind.
                kill_group(item['process'], signal.SIGKILL)
                item.update(rc=item['process'].returncode, seconds=time.monotonic() - item['start'])
                item['reason'] = verdict(item)
                done.append(item)
                emit(item)
    finally:
        # Cancellation, or an error in this script: stop what still runs.
        for item in running:
            kill_group(item['process'], signal.SIGTERM)
        if running:
            time.sleep(.1)
        for item in running:
            kill_group(item['process'], signal.SIGKILL)
            item['process'].wait()
            item.update(rc=item['process'].returncode, seconds=time.monotonic() - item['start'],
                        reason='cancelled' if STOP else 'scheduler stopped')
            done.append(item)
            emit(item)
    return done


def main():
    jobs = os.environ.get('CORE_TEST_JOBS') or str(os.cpu_count() or 1)
    if not re.fullmatch(r'[1-9]\d*', jobs):
        raise ValueError('CORE_TEST_JOBS must be a positive integer')
    jobs = int(jobs)
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupt)
    items = plan(jobs)
    print(f'{sum(item["count"] for item in items)} tests in {len(items)} processes, {jobs} at a time', flush=True)
    with tempfile.TemporaryDirectory(prefix='yuzuno-core-tests-') as directory:
        done = run(items, jobs, Path(directory))
    failures = sum(bool(item['reason']) for item in done)
    title = f'Core test processes: {len(done)} run, {failures} failed'
    if len(done) != len(items):
        title += f', {len(items) - len(done)} not started (cancelled)'
    lines = [f'{"FAIL" if item["reason"] else "PASS"}  {item["seconds"]:.2f}s  {item["label"]} ({item["count"]} tests)'
             + (f' ({item["reason"]})' if item['reason'] else '') for item in done]
    print('\n' + title + '\n' + '\n'.join(lines), flush=True)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write(f'### {title}\n\n```\n' + '\n'.join(lines) + '\n```\n')
    if STOP:
        return 128 + STOP
    return int(failures > 0 or len(done) != len(items))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError, KeyError, json.JSONDecodeError) as error:
        print(f'core-tests: {error}', file=sys.stderr)
        sys.exit(1)
