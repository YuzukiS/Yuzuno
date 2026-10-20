#!/usr/bin/env python3
"""What systemd's freezer really does to a Jobs-shaped unit (T-107).

Starts its own transient user units (prefix t107-probe-, bounded memory,
CPU and tasks), runs fixture.py inside them, and records:

  freeze-thaw   whole tree frozen (cgroup.events, per-process CPU time and
                progress), the same processes resume, memory is retained;
                repeated freeze/thaw
  timeout       RuntimeMaxSec expiring while the unit is frozen
  stop          systemctl stop (Jobs cancel) while the unit is frozen

Only units this run started are ever frozen, stopped or reset.
Usage: probe.py OUT_DIR [experiment...]
"""
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / 'fixture.py'
RUN = uuid.uuid4().hex[:8]
OWNED = set()


def sh(*args, timeout=20):
    started = time.monotonic()
    done = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    return {'argv': list(args), 'code': done.returncode, 'stdout': done.stdout.strip()[:2000],
            'stderr': done.stderr.strip()[:2000], 'seconds': round(time.monotonic() - started, 3)}


def show(unit):
    props = 'ActiveState,SubState,Result,FreezerState,InvocationID,MainPID,ControlGroup,MemoryCurrent,Description'
    out = sh('systemctl', '--user', 'show', unit, '--property=' + props)['stdout']
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


def groups(control_group):
    """The unit's cgroup and every cgroup below it."""
    if not control_group:
        return []
    root = Path('/sys/fs/cgroup') / control_group.lstrip('/')
    if not root.is_dir():
        return []
    return [root] + sorted(p for p in root.rglob('*') if p.is_dir())


def events(group):
    try:
        return dict(line.split() for line in (group / 'cgroup.events').read_text().splitlines())
    except OSError:
        return None


def proc(pid):
    """Identity (start time) and state of one process, from /proc."""
    try:
        raw = Path(f'/proc/{pid}/stat').read_text()
    except OSError:
        return None
    fields = raw[raw.rindex(')') + 2:].split()
    # fields[0] is field 3 (state); utime/stime are fields 14/15; starttime is 22.
    return {'state': fields[0], 'cpuTicks': int(fields[11]) + int(fields[12]), 'startTicks': int(fields[19])}


def tree(unit):
    state = show(unit)
    found = {}
    for group in groups(state.get('ControlGroup', '')):
        try:
            pids = [int(p) for p in (group / 'cgroup.procs').read_text().split()]
        except OSError:
            continue
        for pid in pids:
            info = proc(pid)
            if info:
                found[pid] = {**info, 'cgroup': str(group)}
    return state, found


def progress(state_dir):
    out = {}
    for path in Path(state_dir).glob('*.json'):
        try:
            value = json.loads(path.read_text())
            out[value['name']] = {'pid': value['pid'], 'count': value['count']}
        except (OSError, ValueError, KeyError):
            pass
    return out


def terms(state_dir):
    return sorted(p.stem for p in Path(state_dir).glob('*.term'))


def start(name, out, runtime='120s'):
    unit = f't107-probe-{RUN}-{name}.service'
    state_dir = out / f'{name}-state'
    state_dir.mkdir(parents=True, exist_ok=True)
    launched = sh('systemd-run', '--user', '--quiet', '--unit=' + unit, '--service-type=exec',
                  '-p', f'Description=T-107 probe {RUN} {name}', '-p', 'RemainAfterExit=yes',
                  '-p', 'Restart=no', '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=3s',
                  '-p', 'RuntimeMaxSec=' + runtime, '-p', 'MemoryMax=128M', '-p', 'MemorySwapMax=0',
                  '-p', 'CPUQuota=20%', '-p', 'TasksMax=32',
                  '--', sys.executable, str(FIXTURE), 'tree', str(state_dir))
    if launched['code']:
        raise RuntimeError(launched)
    OWNED.add(unit)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        seen = progress(state_dir)
        if len(seen) == 5 and all(v['count'] > 3 for v in seen.values()):
            return unit, state_dir
        time.sleep(0.1)
    raise RuntimeError(f'fixture did not start: {progress(state_dir)}')


def owned(unit):
    state = show(unit)
    if unit not in OWNED or not state.get('Description', '').startswith(f'T-107 probe {RUN} '):
        raise RuntimeError(f'refusing to act on {unit}: not started by this run')
    return state


def control(verb, unit):
    owned(unit)
    return sh('systemctl', '--user', verb, unit)


def wait_events(unit, key, value, seconds=10):
    started = time.monotonic()
    group = groups(show(unit).get('ControlGroup', ''))[:1]
    while time.monotonic() - started < seconds:
        if group and (events(group[0]) or {}).get(key) == value:
            return round(time.monotonic() - started, 3)
        time.sleep(0.01)
    return None


def freeze_thaw(out):
    unit, state_dir = start('freeze', out)
    record = {'unit': unit}
    before_state, before = tree(unit)
    record['before'] = {'systemd': before_state, 'processes': before, 'progress': progress(state_dir)}
    record['freeze'] = control('freeze', unit)
    record['secondsToFrozen'] = wait_events(unit, 'frozen', '1')
    record['frozenState'] = show(unit)
    record['frozenEvents'] = {str(g): events(g) for g in groups(record['frozenState']['ControlGroup'])}
    _, frozen1 = tree(unit)
    progress1 = progress(state_dir)
    time.sleep(2)
    _, frozen2 = tree(unit)
    progress2 = progress(state_dir)
    record['whileFrozen'] = {
        'processes': frozen2,
        'cpuTicksAdvanced': {pid: frozen2[pid]['cpuTicks'] - frozen1[pid]['cpuTicks'] for pid in frozen2 if pid in frozen1},
        'progressAdvanced': {n: progress2[n]['count'] - progress1[n]['count'] for n in progress2 if n in progress1},
        'memoryCurrent': show(unit).get('MemoryCurrent'),
    }
    record['freezeAgain'] = control('freeze', unit)
    record['thaw'] = control('thaw', unit)
    record['secondsToThawed'] = wait_events(unit, 'frozen', '0')
    record['thawAgain'] = control('thaw', unit)
    time.sleep(1)
    after_state, after = tree(unit)
    progress3 = progress(state_dir)
    record['after'] = {
        'systemd': after_state, 'processes': after, 'progress': progress3,
        'sameProcesses': {pid: before[pid]['startTicks'] for pid in before} == {pid: after[pid]['startTicks'] for pid in after},
        'progressAdvanced': {n: progress3[n]['count'] - progress2[n]['count'] for n in progress3 if n in progress2},
    }
    record['stop'] = control('stop', unit)
    record['terms'] = terms(state_dir)
    return record


def watch(unit, seconds):
    """Every change of the unit's state, with seconds since the watch began."""
    started = time.monotonic()
    timeline, last = [], None
    while time.monotonic() - started < seconds:
        state = show(unit)
        group = groups(state.get('ControlGroup', ''))[:1]
        now = (state.get('ActiveState'), state.get('SubState'), state.get('Result'), state.get('FreezerState'),
               json.dumps(events(group[0]) if group else None))
        if now != last:
            timeline.append({'at': round(time.monotonic() - started, 2), 'ActiveState': now[0], 'SubState': now[1],
                             'Result': now[2], 'FreezerState': now[3], 'events': json.loads(now[4])})
            last = now
        if state.get('ActiveState') in ('inactive', 'failed') or state.get('SubState') == 'exited':
            break
        time.sleep(0.1)
    return timeline


def timeout(out):
    unit, state_dir = start('timeout', out, runtime='6s')
    record = {'unit': unit, 'runtimeMaxSec': 6}
    record['freeze'] = control('freeze', unit)
    record['secondsToFrozen'] = wait_events(unit, 'frozen', '1')
    frozen_at = time.monotonic()
    record['timeline'] = watch(unit, 20)
    record['secondsFromFreezeToEnd'] = round(time.monotonic() - frozen_at, 2)
    record['final'] = show(unit)
    record['processesLeft'] = tree(unit)[1]
    record['terms'] = terms(state_dir)
    return record


def stop(out):
    unit, state_dir = start('stop', out)
    record = {'unit': unit}
    record['freeze'] = control('freeze', unit)
    record['secondsToFrozen'] = wait_events(unit, 'frozen', '1')
    record['stop'] = control('stop', unit)
    record['final'] = show(unit)
    record['processesLeft'] = tree(unit)[1]
    record['terms'] = terms(state_dir)
    return record


def thaw_stop(out):
    """Jobs cancel of a paused job: thaw, then stop at once."""
    unit, state_dir = start('thawstop', out)
    record = {'unit': unit}
    record['freeze'] = control('freeze', unit)
    record['secondsToFrozen'] = wait_events(unit, 'frozen', '1')
    record['thaw'] = control('thaw', unit)
    record['stop'] = control('stop', unit)
    record['final'] = show(unit)
    record['processesLeft'] = tree(unit)[1]
    record['terms'] = terms(state_dir)
    return record


def kill_frozen(out):
    """SIGKILL delivered to a frozen unit, then stop."""
    unit, state_dir = start('kill', out)
    record = {'unit': unit}
    record['freeze'] = control('freeze', unit)
    record['secondsToFrozen'] = wait_events(unit, 'frozen', '1')
    owned(unit)
    record['kill'] = sh('systemctl', '--user', 'kill', '--signal=SIGKILL', unit)
    record['timeline'] = watch(unit, 10)
    record['final'] = show(unit)
    record['processesLeft'] = tree(unit)[1]
    record['terms'] = terms(state_dir)
    return record


def runtime_property(out):
    """Whether RuntimeMaxSec can be changed on a running unit."""
    unit, state_dir = start('runtimeprop', out, runtime='60s')
    owned(unit)
    record = {'unit': unit,
              'before': sh('systemctl', '--user', 'show', unit, '--property=RuntimeMaxUSec')['stdout'],
              'setProperty': sh('systemctl', '--user', 'set-property', '--runtime', unit, 'RuntimeMaxSec=90s')}
    record['after'] = sh('systemctl', '--user', 'show', unit, '--property=RuntimeMaxUSec')['stdout']
    record['stop'] = control('stop', unit)
    return record


def exited(out):
    """Freezing a unit whose processes have all exited (RemainAfterExit)."""
    unit, state_dir = start('exited', out)
    owned(unit)
    sh('systemctl', '--user', 'kill', '--signal=SIGKILL', unit)
    time.sleep(1)
    record = {'unit': unit, 'state': show(unit), 'freeze': control('freeze', unit), 'after': show(unit)}
    return record


def dead_frozen(out):
    """What stop, reset-failed and thaw do on a unit that died while frozen
    (the collector's cleanup and Jobs cancel after a timeout while paused)."""
    unit, state_dir = start('deadfrozen', out)
    owned(unit)
    record = {'unit': unit, 'freeze': control('freeze', unit)}
    record['kill'] = sh('systemctl', '--user', 'kill', '--signal=SIGKILL', unit)
    watch(unit, 10)
    record['dead'] = show(unit)
    record['stop'] = control('stop', unit)
    record['afterStop'] = show(unit)
    record['resetFailed'] = control('reset-failed', unit)
    record['afterReset'] = show(unit)
    return record


def cleanup():
    for unit in sorted(OWNED):
        state = show(unit)
        if state.get('Description', '').startswith(f'T-107 probe {RUN} '):
            if state.get('FreezerState') not in ('running', None):
                sh('systemctl', '--user', 'thaw', unit)
            sh('systemctl', '--user', 'stop', unit)
            sh('systemctl', '--user', 'reset-failed', unit)


def main():
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    chosen = sys.argv[2:] or ['freeze-thaw', 'timeout', 'stop']
    experiments = {'freeze-thaw': freeze_thaw, 'timeout': timeout, 'stop': stop, 'thaw-stop': thaw_stop,
                   'kill-frozen': kill_frozen, 'runtime-property': runtime_property, 'exited': exited, 'dead-frozen': dead_frozen}
    results = {'run': RUN, 'systemd': sh('systemctl', '--version')['stdout'].splitlines()[0],
               'kernel': os.uname().release}
    try:
        for name in chosen:
            try:
                results[name] = experiments[name](out)
            except Exception as error:
                results[name] = {'error': repr(error)}
    finally:
        cleanup()
    (out / f'probe-{RUN}.json').write_text(json.dumps(results, indent=1, default=str))
    print(out / f'probe-{RUN}.json')


if __name__ == '__main__':
    main()
