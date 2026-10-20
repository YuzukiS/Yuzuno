#!/usr/bin/env python3
"""Pause and resume through the real Jobs host helper and systemd (T-107).

Builds attempt folders the way Core does and launches host.py's collector
exactly as host.rs does, so the worker and collector units, their
RuntimeMaxSec values and the worker's own cgroup checks are the real ones.
Only the unit names differ: t107-probe-<run>-*, so no Core job is touched.
The command is fixture.py's process tree. No Core, model or GPU.

  pause-resume   pause, pause again, a fresh reconcile while paused, resume,
                 resume again, then the job finishes by itself and succeeds
  cancel-paused  cancel a paused job: thawed, stopped, groups empty
  timeout-paused the worker's RuntimeMaxSec expires while paused
  refusals       not this attempt's invocation, cancel requested, finished
  cancel-frozen  control for an unchanged helper (T107_HOST=<host.py>): the
                 unit is frozen with systemctl, then cancelled

Usage: [T107_HOST=host.py] host_pause_check.py OUT_DIR [scenario...]
"""
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOST = Path(os.environ.get('T107_HOST') or HERE.parents[1] / 'core' / 'src' / 'jobs' / 'host.py').resolve()
FIXTURE = HERE / 'fixture.py'
RUN = uuid.uuid4().hex[:8]
UNITS = []
CHECKS = []


def check(name, ok, detail=None):
    CHECKS.append({'check': name, 'ok': bool(ok), 'detail': detail})
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'  {json.dumps(detail, default=str)[:600]}'), flush=True)


def helper(mode, spec_path, timeout=60):
    done = subprocess.run(['/usr/bin/python3', str(HOST), mode, str(spec_path)],
                          capture_output=True, text=True, timeout=timeout)
    if done.returncode:
        raise RuntimeError(f'{mode} failed: {done.stderr[-1500:]}')
    return json.loads(done.stdout) if done.stdout.strip() else None


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def launch(out, name, timeout_seconds, steps=None):
    """An attempt folder and its collector, as host.rs launch() makes them."""
    job, attempt = str(uuid.uuid4()), str(uuid.uuid4())
    folder = out / 'jobs' / job
    work = out / 'work' / name
    folder.mkdir(parents=True)
    work.mkdir(parents=True)
    state_dir = out / 'state' / name
    unit = f't107-probe-{RUN}-{name}.service'
    spec = {'id': job, 'attempt': attempt, 'bootId': boot_id(), 'unit': unit,
            'supervisorUnit': f't107-probe-{RUN}-{name}-collector.service',
            'timeoutSeconds': timeout_seconds, 'cwd': str(work), 'guardGit': False, 'inputs': [],
            'resources': {'memoryMiB': 128, 'swapMiB': 0, 'cpuMillis': 200},
            'argv': [sys.executable, str(FIXTURE), 'tree', str(state_dir)] + ([str(steps)] if steps else []),
            'env': {'PATH': os.environ.get('PATH', '/usr/bin:/bin')}}
    snap = subprocess.run(['/usr/bin/python3', str(HOST), 'snapshot'], input=json.dumps(spec),
                          capture_output=True, text=True, check=True)
    spec['snapshot'] = json.loads(snap.stdout)
    path = folder / 'spec.json'
    path.write_text(json.dumps(spec))
    (folder / 'dispatched.json').write_text(json.dumps({'jobId': job, 'attempt': attempt, 'bootId': spec['bootId']}))
    UNITS.extend([spec['unit'], spec['supervisorUnit']])
    subprocess.run(['systemd-run', '--user', '--quiet', '--collect', '--service-type=exec', '--expand-environment=no',
                    '--unit=' + spec['supervisorUnit'], '-p', 'Description=Yuzuno job ' + attempt,
                    '-p', 'MemoryMax=64M', '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=10%', '-p', 'TasksMax=16',
                    '-p', 'Restart=no', '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=3s',
                    '-p', 'StandardOutput=null', '-p', 'StandardError=null',
                    '-p', f'RuntimeMaxSec={timeout_seconds + 60}s',
                    '--', '/usr/bin/python3', str(HOST), 'supervise', str(path)], check=True)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        seen = progress(state_dir)
        if (folder / 'started.json').exists() and len(seen) == 5 and all(v['count'] > 3 for v in seen.values()):
            return spec, path, folder, state_dir
        time.sleep(0.1)
    raise RuntimeError(f'{name} did not start: {progress(state_dir)}')


def progress(state_dir):
    out = {}
    for p in Path(state_dir).glob('*.json'):
        try:
            v = json.loads(p.read_text())
            out[v['name']] = {'pid': v['pid'], 'count': v['count']}
        except (OSError, ValueError, KeyError):
            pass
    return out


def terms(state_dir):
    return sorted(p.stem for p in Path(state_dir).glob('*.term'))


def show(unit, props='ActiveState,SubState,Result,FreezerState,InvocationID,ControlGroup'):
    out = subprocess.run(['systemctl', '--user', 'show', unit, '--property=' + props],
                         capture_output=True, text=True).stdout
    return dict(l.split('=', 1) for l in out.splitlines() if '=' in l)


def start_ticks(pids):
    out = {}
    for pid in pids:
        try:
            raw = Path(f'/proc/{pid}/stat').read_text()
            out[pid] = int(raw[raw.rindex(')') + 2:].split()[19])
        except OSError:
            out[pid] = None
    return out


def wait_result(folder, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if (folder / 'result.json').exists():
            return json.loads((folder / 'result.json').read_text())
        time.sleep(0.2)
    return None


def pause_resume(out):
    spec, path, folder, state_dir = launch(out, 'pauseresume', 120, steps=400)
    pids = {n: v['pid'] for n, v in progress(state_dir).items()}
    ticks = start_ticks(pids.values())
    paused = helper('pause', path)
    check('pause confirms the whole worker cgroup is frozen', paused['state'] == 'paused'
          and paused['evidence']['freezer'] == {'populated': True, 'frozen': True}, paused)
    before = progress(state_dir)
    time.sleep(1.5)
    after = progress(state_dir)
    check('no process in the tree advances while paused',
          len(before) == 5 and all(after[n]['count'] == before[n]['count'] for n in before), {'before': before, 'after': after})
    again = helper('pause', path)
    check('pausing again is a no-op that reports paused', again['state'] == 'paused' and again['reason'] == 'Already paused', again)
    seen = helper('reconcile', path)
    check('a fresh reconcile (as after a Core restart) sees the frozen worker and does not resume it',
          seen['status'] == 'unresolved' and seen['freezer'] == {'populated': True, 'frozen': True}
          and seen['systemd'].get('SubState') == 'running', seen)
    check('the collector keeps running while the worker is paused',
          show(spec['supervisorUnit'])['ActiveState'] == 'active', show(spec['supervisorUnit']))
    resumed = helper('resume', path)
    check('resume confirms the cgroup is thawed', resumed['state'] == 'running'
          and resumed['evidence']['freezer']['frozen'] is False, resumed)
    check('resume continues the same processes', start_ticks(pids.values()) == ticks, {'before': ticks, 'after': start_ticks(pids.values())})
    again = helper('resume', path)
    check('resuming again is a no-op', again['state'] == 'running' and again['reason'] == 'Already running', again)
    result = wait_result(folder, 60)
    check('the resumed job finishes by itself and succeeds', result and result['status'] == 'succeeded', result)
    check('pausing a finished job changes nothing', helper('pause', path)['state'] == 'notPaused')


def cancel_paused(out):
    spec, path, folder, state_dir = launch(out, 'cancelpaused', 120)
    paused = helper('pause', path)
    check('cancel test: paused first', paused['state'] == 'paused', paused)
    (folder / 'cancel.json').write_text(json.dumps({'attempt': spec['attempt'], 'requestedAt': time.time()}))
    started = time.monotonic()
    cancelled = helper('cancel', path)
    seconds = round(time.monotonic() - started, 2)
    check('cancelling a paused job thaws it, stops it and confirms empty groups',
          cancelled['status'] == 'cancelled' and (cancelled['evidence'].get('thawedToStop') or {}).get('wasFrozen') is True,
          {'seconds': seconds, 'result': cancelled})
    check('its processes ran their termination handlers after the thaw', terms(state_dir) == [
        'child1', 'child1-grandchild', 'child2', 'child2-grandchild', 'parent'], terms(state_dir))
    check('a paused job cannot be paused once cancellation is requested', helper('pause', path)['state'] == 'notPaused')


def timeout_paused(out):
    spec, path, folder, state_dir = launch(out, 'timeoutpaused', 8)
    started = json.loads((folder / 'started.json').read_text())['at']
    paused = helper('pause', path)
    check('timeout test: paused first', paused['state'] == 'paused', paused)
    result = wait_result(folder, 40)
    elapsed = round(result['finishedAtUnix'] - started, 1) if result else None
    check("the worker's RuntimeMaxSec still ends a paused job: failed with Result=timeout",
          result and result['status'] == 'failed' and result['reason'] == 'timeout', result)
    check('it ends near timeout + TimeoutStopSec (8 s + 3 s), not after the collector deadline (timeout + 20 s)',
          elapsed is not None and 10 <= elapsed <= 16, {'secondsFromWorkerStart': elapsed})
    check('no process ran again: SIGTERM was not handled while frozen, SIGKILL ended it', terms(state_dir) == [], terms(state_dir))
    time.sleep(2)
    check('the collector exited after recording the outcome', show(spec['supervisorUnit'])['ActiveState'] in ('inactive', 'failed', ''),
          show(spec['supervisorUnit']))


def refusals(out):
    spec, path, folder, state_dir = launch(out, 'refusals', 120)
    other = dict(spec, attempt=str(uuid.uuid4()))
    other_path = folder.parent / (spec['id'] + '-other.json')
    other_path.write_text(json.dumps(other))
    refused = helper('pause', other_path)
    check('a spec for another attempt cannot pause this unit', refused['state'] == 'notPaused'
          and 'does not belong' in refused['reason'], refused)
    fake = dict(json.loads((folder / 'started.json').read_text()), invocationId='0' * 32)
    real = (folder / 'started.json').read_text()
    (folder / 'started.json').write_text(json.dumps(fake))
    refused = helper('pause', path)
    (folder / 'started.json').write_text(real)
    check('a different invocation than the one that started is never frozen', refused['state'] == 'notPaused'
          and 'invocation' in refused['reason'], refused)
    check('the unit was not frozen by refused requests', show(spec['unit'])['FreezerState'] == 'running', show(spec['unit']))
    (folder / 'cancel.json').write_text(json.dumps({'attempt': spec['attempt'], 'requestedAt': time.time()}))
    cancelled = helper('cancel', path)
    check('cancelling a running job needs no thaw', cancelled['status'] == 'cancelled'
          and cancelled['evidence'].get('thawedToStop') is None, cancelled)


def cancel_frozen(out):
    spec, path, folder, state_dir = launch(out, 'cancelfrozen', 120)
    subprocess.run(['systemctl', '--user', 'freeze', spec['unit']], check=True)
    (folder / 'cancel.json').write_text(json.dumps({'attempt': spec['attempt'], 'requestedAt': time.time()}))
    cancelled = helper('cancel', path)
    check('cancel of a frozen unit confirms empty groups', cancelled['status'] == 'cancelled', cancelled)


def cleanup():
    for unit in UNITS:
        state = show(unit, 'Description,FreezerState,LoadState')
        if state.get('LoadState') == 'not-found':
            continue
        if state.get('FreezerState') not in ('running', None, ''):
            subprocess.run(['systemctl', '--user', 'thaw', unit], capture_output=True)
        subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True)
        subprocess.run(['systemctl', '--user', 'reset-failed', unit], capture_output=True)


def main():
    out = Path(sys.argv[1]).resolve() / RUN
    out.mkdir(parents=True)
    scenarios = {'pause-resume': pause_resume, 'cancel-paused': cancel_paused,
                 'timeout-paused': timeout_paused, 'refusals': refusals, 'cancel-frozen': cancel_frozen}
    chosen = sys.argv[2:] or [s for s in scenarios if s != 'cancel-frozen']
    try:
        for name in chosen:
            try:
                scenarios[name](out)
            except Exception as error:
                check(f'{name} ran to completion', False, repr(error))
    finally:
        cleanup()
    report = {'run': RUN, 'host': str(HOST), 'checks': CHECKS,
              'passed': sum(c['ok'] for c in CHECKS), 'total': len(CHECKS)}
    (out / 'report.json').write_text(json.dumps(report, indent=1, default=str))
    print(f"{report['passed']}/{report['total']} passed; {out / 'report.json'}")
    sys.exit(0 if report['passed'] == report['total'] else 1)


if __name__ == '__main__':
    main()
