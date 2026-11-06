#!/usr/bin/env python3
"""T-57: a retry of the same value confirms a lowering whose answer was lost,
with real Jobs on an isolated lab Core (local_jobs_lab). Never uses a paid
model or the daily Core.

- A Job asking 4,096 MiB holds about 200 MiB; a second asking 1,024 MiB
  waits: 4,160 + 1,088 MiB exceed the 4,500 MiB lab budget.
- Its lowering to 1,024 MiB takes effect, but the answer never reaches Core:
  the check applies it to the worker unit itself, exactly as host.py does
  (systemctl --user set-property --runtime ... MemoryMax=1024M), and tells
  Core nothing. The cgroup reads 1 GiB; Core still holds 4,160 MiB, and the
  second still waits.
- The same value asked through Core is confirmed: nothing more is applied
  (memory.max was 1 GiB before and after), the request and reservation drop
  to 1,024 / 1,088 MiB with one audit entry marked confirmedByRetry, the task
  activity says so, and the second starts at once.
Needs XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS (the user's systemd).
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
# The lab Core (core/examples/local_jobs_lab.rs) runs only in a target/t47/lab-*
# directory, the root every lab check shares; this check's report goes under
# target/t57 unless the Job names its own path in T57_LAB_REPORT.
LAB = ROOT / 'target' / 't47' / ('lab-' + uuid.uuid4().hex[:10])
PORT = int(os.environ.get('T57_LAB_PORT', '4494'))
BASE = 'http://127.0.0.1:' + str(PORT)
CORE = None
REPORT = {'task': 'T-57', 'checks': [], 'jobs': {}, 'reasons': {}, 'events': [],
          'fixture': 'Actual systemd user services and an independent lab Core; no model'}
MIB = 1024 * 1024


def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + '/api' + path, data=data,
                                 headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b'{}')


def get(path):
    status, value = request(path)
    assert status == 200, (path, status, value)
    return value


def wait_for(read, accept, what, seconds=60):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        last = read()
        if accept(last):
            return last
        time.sleep(.2)
    raise AssertionError(what + ': ' + json.dumps(last)[:1500])


def start_core():
    global CORE
    log = (LAB / 'core.log').open('ab')
    CORE = subprocess.Popen([str(ROOT / 'target/debug/examples/local_jobs_lab'), str(LAB), str(PORT)], stdout=log, stderr=log)
    log.close()
    for _ in range(100):
        if CORE.poll() is not None:
            raise AssertionError('Isolated Core exited: ' + (LAB / 'core.log').read_text()[-2000:])
        try:
            request('/health')
            return
        except OSError:
            time.sleep(.1)
    raise AssertionError('Isolated Core did not listen')


def stop_core():
    global CORE
    if CORE:
        CORE.terminate()
        CORE.wait(timeout=10)
        CORE = None


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def note(event):
    REPORT['events'].append({'at': time.time(), 'event': event})


def submit(name, memory, code):
    body = {'requestId': str(uuid.uuid4()), 'taskId': 'T-1', 'agentId': 'lab-a', 'name': name,
            'cwd': str(LAB / 'work'), 'argv': ['/usr/bin/python3', '-u', '-c', code], 'env': {}, 'guardGit': False,
            'resources': {'cpuMillis': 500, 'memoryMiB': memory, 'swapMiB': 0}, 'timeoutSeconds': 300}
    status, value = request('/jobs', body)
    assert status == 200, value
    REPORT['jobs'][name] = value['id']
    return value


# About 200 MiB held, touched page by page, until told to stop.
CALIBRATION = '''import pathlib,time
keep=bytearray(200*1024*1024)
for i in range(0,len(keep),4096): keep[i]=1
pathlib.Path("started-calibration").write_text(str(time.time()))
while not pathlib.Path("stop-calibration").exists(): time.sleep(0.2)
'''
SECOND = '''import pathlib,time
pathlib.Path("started-second").write_text(str(time.time()))
while not pathlib.Path("release-second").exists(): time.sleep(0.2)
'''


def memory_max(job):
    group = job['result']['started']['controlGroup']
    return (Path('/sys/fs/cgroup') / group.lstrip('/') / 'memory.max').read_text().strip()


def main():
    assert os.environ.get('XDG_RUNTIME_DIR') and os.environ.get('DBUS_SESSION_BUS_ADDRESS'), 'the user systemd manager is needed'
    LAB.mkdir(parents=True, mode=0o700)
    (LAB / 'work').mkdir()
    print(str(LAB), flush=True)
    try:
        start_core()
        request('/jobs/budget', {'cpuMillis': 4000, 'memoryMiB': 4500, 'swapMiB': 0})
        calibration = submit('calibration', 4096, CALIBRATION)
        wait_for(lambda: get('/jobs/' + calibration['id']), lambda j: j['status'] == 'running', 'the calibration runs')
        wait_for(lambda: (LAB / 'work/started-calibration').exists(), bool, 'the calibration holds its 200 MiB')
        running = get('/jobs/' + calibration['id'])
        assert memory_max(running) == str(4096 * MIB), memory_max(running)
        second = submit('second', 1024, SECOND)
        waiting = wait_for(lambda: get('/jobs/' + second['id']), lambda j: j['status'] == 'queued' and 'Waiting for shared RAM' in (j['reason'] or ''),
                           'the second waits for the budget')
        REPORT['reasons']['second before'] = waiting['reason']
        check('a 1,024 MiB Job waits while the calibration holds 4,160 of the 4,500 MiB budget')
        # The lowering takes effect, and its answer never reaches Core.
        note('lowering applied without Core')
        unit = running['unit']
        applied = subprocess.run(['systemctl', '--user', 'set-property', '--runtime', unit, 'MemoryMax=1024M'],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)
        REPORT['appliedWithoutCore'] = {'unit': unit, 'returnCode': applied.returncode, 'stderr': applied.stderr.strip()[:300]}
        assert applied.returncode == 0, applied.stderr
        assert memory_max(get('/jobs/' + calibration['id'])) == str(1024 * MIB)
        time.sleep(2)
        unconfirmed = get('/jobs/' + calibration['id'])
        REPORT['unconfirmed'] = {'resources': unconfirmed['resources'], 'reservation': unconfirmed['reservation'],
                                 'limitChanges': unconfirmed.get('limitChanges'), 'memoryMax': memory_max(unconfirmed)}
        assert unconfirmed['resources']['memoryMiB'] == 4096 and unconfirmed['reservation']['memoryMiB'] == 4160, unconfirmed['resources']
        assert not unconfirmed.get('limitChanges'), unconfirmed.get('limitChanges')
        assert get('/jobs/' + second['id'])['status'] == 'queued'
        check('the lowering took effect (memory.max 1 GiB) without its answer: Core still holds 4,096 / 4,160 MiB, and the second still waits')
        note('retry')
        began = time.monotonic()
        status, confirmed = request('/jobs/' + calibration['id'] + '/memory', {'memoryMiB': 1024})
        assert status == 200, confirmed
        assert confirmed['resources']['memoryMiB'] == 1024 and confirmed['reservation']['memoryMiB'] == 1088, (confirmed['resources'], confirmed['reservation'])
        assert confirmed['resources']['swapMiB'] == 0
        changes = confirmed['limitChanges']
        REPORT['limitChanges'] = changes
        assert len(changes) == 1, changes
        change = changes[0]
        assert (change['fromMiB'], change['toMiB'], change['by']['kind'], change.get('confirmedByRetry')) == (4096, 1024, 'user', True), change
        assert (change['evidence']['memoryMaxBefore'], change['evidence']['memoryMaxAfter']) == (1024 * MIB, 1024 * MIB), change['evidence']
        assert 'setPropertyReturnCode' not in change['evidence'], 'the retry applied nothing: ' + json.dumps(change['evidence'])
        assert not confirmed.get('limitRefusal'), confirmed.get('limitRefusal')
        assert memory_max(get('/jobs/' + calibration['id'])) == str(1024 * MIB)
        check('the same value again is confirmed: nothing more applied (memory.max 1 GiB before and after), request and reservation 1,024 / 1,088 MiB, one audit entry marked confirmedByRetry')
        wait_for(lambda: get('/jobs/' + second['id']), lambda j: j['status'] == 'running', 'the second starts once room is back', seconds=20)
        REPORT['secondStartedAfterSeconds'] = round(time.monotonic() - began, 2)
        check('the queued 1,024 MiB Job starts at once (%.1f s after the retry)' % REPORT['secondStartedAfterSeconds'])
        status, task = request('/collaboration/task_get', {'taskId': 'T-1', 'view': 'activity'})
        assert status == 200, task
        lines = [a.get('body', '') for a in task.get('activities', []) if a.get('jobId') == calibration['id']]
        REPORT['taskActivity'] = lines
        assert any('lowered from 4096 MiB to 1024 MiB by You, confirmed by a retry of the same value' in line for line in lines), lines
        check('the task activity records it: from 4,096 to 1,024 MiB, by the user, confirmed by a retry of the same value')
        (LAB / 'work/stop-calibration').write_text('go')
        (LAB / 'work/release-second').write_text('go')
        for job in (calibration, second):
            done = wait_for(lambda: get('/jobs/' + job['id']), lambda j: j['status'] in ('failed', 'succeeded', 'cancelled'), 'a job ends')
            assert done['status'] == 'succeeded', done
        REPORT['passed'] = True
    finally:
        stop_core()
        for spec in (LAB / 'data/jobs').glob('*/spec.json'):
            saved = json.loads(spec.read_text())
            for key in ('supervisorUnit', 'unit'):
                subprocess.run(['systemctl', '--user', 'stop', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
                subprocess.run(['systemctl', '--user', 'reset-failed', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        out = Path(os.environ.get('T57_LAB_REPORT', str(ROOT / 'target' / 't57' / ('limit-retry-report-' + LAB.name + '.json'))))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
        print(str(out), flush=True)


if __name__ == '__main__':
    sys.exit(main())
