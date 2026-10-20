#!/usr/bin/env python3
"""Focused real-package regression for an interrupted release smoke runner.

Run as a bounded Job under target/heavy-slot.sh. Uses two new disposable
installations and existing immutable bundles; never builds or calls models.
"""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / 'tools'
sys.path.insert(0, str(TOOLS))
from release_common import read, write


def load_smoke(revision):
    path = TOOLS / 'core-release-smoke.py'
    spec = importlib.util.spec_from_file_location('tested_smoke', path)
    module = importlib.util.module_from_spec(spec)
    source = subprocess.check_output(['git', 'show', f'{revision}:tools/core-release-smoke.py'], cwd=ROOT) if revision else path.read_bytes()
    exec(compile(source, str(path), 'exec'), module.__dict__)
    return module


def wait_for(check, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.05)
    raise AssertionError('Recovery fixture condition timed out')


def worker(args):
    module = load_smoke(args.revision)
    original_open, original_kill = urllib.request.OpenerDirector.open, os.kill
    def traced_kill(pid, sig):
        state = read(args.state)
        op = read(Path(state['root']) / 'managed/updates/state.json').get('operation') or {}
        with (args.control / 'signals.jsonl').open('a') as log:
            log.write(json.dumps({'pid': pid, 'signal': sig, 'phase': op.get('phase'), 'operationId': op.get('id')}) + '\n')
        original_kill(pid, sig)
    os.kill = traced_kill
    def controlled_open(opener, request, *positional, **keywords):
        is_apply = isinstance(request, urllib.request.Request) and request.full_url.endswith('/api/updates/apply')
        if not is_apply:
            return original_open(opener, request, *positional, **keywords)
        with (args.control / 'applies.jsonl').open('a') as log:
            log.write(request.data.decode() + '\n')
        if args.worker == 'resume':
            if args.revision:
                return original_open(opener, request, *positional, **keywords)
            raise AssertionError('Resume attempted another apply')
        write(args.control / 'before-apply.json', {'ready': True})
        wait_for(lambda: (args.control / 'allow-apply').exists(), 15)
        response = original_open(opener, request, *positional, **keywords)
        response.close()
        state = read(args.state)
        journal = Path(state['root']) / 'managed/updates/state.json'
        op = wait_for(lambda: (op if (op := read(journal)['operation']).get('helperProcess') else None), 5)
        assert op['phase'] == 'waiting' and op['requestId'] == state['requestId']
        write(args.control / 'accepted.json', {key: op[key] for key in ('id', 'requestId', 'phase', 'helperProcess', 'oldProcess')})
        if args.worker == 'crash':
            os._exit(73)
        raise RuntimeError('Injected lost apply response: exercise finally before runner interruption')
    urllib.request.OpenerDirector.open = controlled_open
    return module.smoke(args)


def scenario(args, name, old):
    out = args.out / name
    out.mkdir(parents=True, exist_ok=False)
    state_path = out / 'smoke.json'
    base = [sys.executable, str(Path(__file__).resolve()), '--baseline', str(args.baseline),
            '--candidate', str(args.candidate), '--state', str(state_path), '--control', str(out)]
    if old:
        base += ['--revision', args.old_revision]
    children, lock = [], None
    common = load_smoke(None).common
    def start(mode):
        with (out / f'{mode}.log').open('wb') as log:
            child = subprocess.Popen(base + ['--worker', mode], cwd=ROOT, stdout=log, stderr=log)
        children.append(child)
        return child
    def signals():
        path = out / 'signals.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
    def reconciling():
        state = read(state_path)
        return state['attempts'][-1].get('reconciliation', {}).get('helperAlive')
    try:
        first = start('crash' if old else 'exception')
        wait_for(lambda: (out / 'before-apply.json').exists())
        state = read(state_path)
        managed = Path(state['root']) / 'managed'
        lock = os.open(managed / 'updates/helper.lock', os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        (out / 'allow-apply').touch()
        wait_for(lambda: (out / 'accepted.json').exists())
        accepted = read(out / 'accepted.json')
        helper = accepted['helperProcess']
        if old:
            assert first.wait(timeout=5) == 73
        else:
            # Exception cleanup must wait, not signal the live helper. Then
            # hard-kill only the runner to exercise its next invocation too.
            wait_for(reconciling, 5)
            time.sleep(.3)
            assert common.identity(helper['pid']) == helper and not signals()
            write(out / 'finally-waiting.json', read(state_path))
            first.kill()
            assert first.wait(timeout=5) == -signal.SIGKILL
        resumed = start('resume')
        if old:
            wait_for(lambda: any(s['pid'] == helper['pid'] and s['phase'] == 'waiting' for s in signals()), 10)
            wait_for(lambda: common.identity(helper['pid']) != helper, 5)
        else:
            wait_for(lambda: len(read(state_path)['attempts']) == 2 and reconciling(), 5)
            time.sleep(.3)
            assert common.identity(helper['pid']) == helper and not signals()
            write(out / 'resume-waiting.json', read(state_path))
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)
        lock = None
        code = resumed.wait(timeout=90)
        state = read(state_path)
        journal = read(managed / 'updates/state.json')
        op = journal['operation']
        applies = (out / 'applies.jsonl').read_text().splitlines()
        assert len(journal['requests']) == 1, 'Another accepted apply'
        assert op['id'] == accepted['id'] and op['requestId'] == accepted['requestId']
        assert common.identity(helper['pid']) != helper
        assert state['cleanup'] == {'processesStopped': True, 'portReusable': True}
        if old:
            assert code != 0 and not state['passed'] and op['phase'] == 'failed'
        else:
            assert len(applies) == 1, 'Resume attempted another apply'
            assert code == 0 and state['passed'] and op['phase'] == 'complete'
            assert not any(s['phase'] not in ('complete', 'failed', 'rolledBack', 'cancelled') for s in signals())
        result = {'expectedOutcomeObserved': True, 'revision': args.old_revision if old else 'working-tree',
                  'operationId': op['id'], 'phase': op['phase'], 'exitCode': code, 'applyCount': len(applies),
                  'runnerInterruptedWhileHelperAlive': True, 'finallyWaitProved': not old,
                  'resumeWaitProved': not old, 'oldHelperStoppedWhileWaiting': old,
                  'cleanup': state['cleanup'], 'root': state['root'], 'state': str(state_path)}
        write(out / 'result.json', result)
        return result
    finally:
        if lock is not None:
            os.close(lock)  # allow the owned helper to finish before any cleanup
        for child in children:
            if child.poll() is None:
                # A failed assertion must not leave the test runner behind.
                # SIGINT enters its guarded cleanup; never signal a Core here.
                child.send_signal(signal.SIGINT)
                child.wait(timeout=200)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--old-revision')
    parser.add_argument('--worker', choices=('crash', 'exception', 'resume'))
    parser.add_argument('--revision')
    parser.add_argument('--state', type=Path)
    parser.add_argument('--control', type=Path)
    args = parser.parse_args()
    if args.worker:
        raise SystemExit(worker(args))
    if not args.out or not args.old_revision:
        parser.error('--out and --old-revision are required for the regression')
    args.out = args.out.resolve()
    outcomes = [scenario(args, 'old-interrupted', True), scenario(args, 'fixed-interrupted', False)]
    write(args.out / 'result.json', {'passed': True, 'scenarios': outcomes})
    print(json.dumps({'passed': True, 'evidence': str(args.out / 'result.json')}))
