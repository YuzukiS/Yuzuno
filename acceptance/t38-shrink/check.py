#!/usr/bin/env python3
"""T-38 B: lowering a running Job's memory limit, with real Jobs on an
isolated lab Core (local_jobs_lab). Never uses a paid model or the daily Core.

- A Job asking 4,096 MiB holds about 200 MiB; a second asking 1,024 MiB
  waits: 4,160 + 1,088 MiB exceed the 4,500 MiB lab budget.
- The first is lowered to 1,024 MiB through Core: its worker cgroup reads
  memory.max 1 GiB back, its reservation drops to 1,088 MiB, and the second
  starts at once.
- The first then allocates past 1 GiB: it is killed for memory, and its
  reason names the lowered limit and who lowered it.
- A raise and a limit below what a Job uses now plus 256 MiB are refused.
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
LAB = ROOT / 'target' / 't47' / ('lab-' + uuid.uuid4().hex[:10])
PORT = int(os.environ.get('T38_LAB_PORT', '4492'))
BASE = 'http://127.0.0.1:' + str(PORT)
CORE = None
REPORT = {'task': 'T-38 B', 'checks': [], 'jobs': {}, 'reasons': {}, 'events': [],
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


# About 200 MiB held, touched page by page; on "grow", 64 MiB more each 50 ms.
CALIBRATION = '''import pathlib,time
keep=[bytearray(200*1024*1024)]
for i in range(0,len(keep[0]),4096): keep[0][i]=1
pathlib.Path("started-calibration").write_text(str(time.time()))
while not pathlib.Path("grow").exists(): time.sleep(0.2)
while True:
    b=bytearray(64*1024*1024)
    for i in range(0,len(b),4096): b[i]=1
    keep.append(b)
    time.sleep(0.05)
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
        REPORT['usageBefore'] = running.get('usage')
        second = submit('second', 1024, SECOND)
        waiting = wait_for(lambda: get('/jobs/' + second['id']), lambda j: j['status'] == 'queued' and 'Waiting for shared RAM' in (j['reason'] or ''),
                           'the second waits for the budget')
        REPORT['reasons']['second before'] = waiting['reason']
        time.sleep(2)
        assert get('/jobs/' + second['id'])['status'] == 'queued'
        check('a 1,024 MiB Job waits while the calibration holds 4,160 of the 4,500 MiB budget')
        # A raise is refused before the host is asked.
        status, refused = request('/jobs/' + calibration['id'] + '/memory', {'memoryMiB': 8192})
        REPORT['reasons']['raise'] = refused
        assert status >= 400 and 'only lowered, never raised' in json.dumps(refused), (status, refused)
        note('lowering')
        began = time.monotonic()
        status, lowered = request('/jobs/' + calibration['id'] + '/memory', {'memoryMiB': 1024})
        assert status == 200, lowered
        assert lowered['resources']['memoryMiB'] == 1024 and lowered['reservation']['memoryMiB'] == 1088, lowered
        assert lowered['resources']['swapMiB'] == 0
        change = lowered['limitChanges'][-1]
        REPORT['limitChange'] = change
        assert (change['fromMiB'], change['toMiB'], change['by']['kind']) == (4096, 1024, 'user'), change
        assert change['evidence']['memoryMaxAfter'] == 1024 * MIB, change
        assert memory_max(get('/jobs/' + calibration['id'])) == str(1024 * MIB)
        check('lowered to 1,024 MiB: the worker cgroup reads memory.max 1 GiB back, the reservation drops to 1,088 MiB, swap stays 0')
        wait_for(lambda: get('/jobs/' + second['id']), lambda j: j['status'] == 'running', 'the second starts once room is back', seconds=20)
        REPORT['secondStartedAfterSeconds'] = round(time.monotonic() - began, 2)
        note('second running')
        check('the queued 1,024 MiB Job starts at once (%.1f s after the lowering)' % REPORT['secondStartedAfterSeconds'])
        # Below what it uses now plus 256 MiB: the host refuses, nothing changes.
        status, refusal = request('/jobs/' + calibration['id'] + '/memory', {'memoryMiB': 300})
        assert status == 200, refusal
        REPORT['reasons']['too low'] = refusal.get('limitRefusal')
        assert 'below what the job uses now plus 256 MiB' in refusal['limitRefusal']['reason'], refusal.get('limitRefusal')
        assert refusal['resources']['memoryMiB'] == 1024
        assert memory_max(get('/jobs/' + calibration['id'])) == str(1024 * MIB)
        check('a limit below what the job uses now plus 256 MiB is refused by the host; the limit stays 1 GiB')
        (LAB / 'work/grow').write_text('go')
        note('grow')
        ended = wait_for(lambda: get('/jobs/' + calibration['id']), lambda j: j['status'] in ('failed', 'succeeded', 'cancelled'), 'the calibration ends')
        REPORT['reasons']['calibration'] = ended['reason']
        REPORT['calibrationResult'] = ended['result']['evidence']['systemd'].get('Result')
        assert ended['status'] == 'failed' and ended['result']['evidence']['systemd']['Result'] == 'oom-kill', ended['result']
        assert ended['reason'].startswith('Out of memory at the lowered limit of 1024 MiB: You lowered it from 4096 MiB at '), ended['reason']
        check('past 1 GiB the calibration is killed for memory, and its reason names the lowered limit and who lowered it')
        (LAB / 'work/release-second').write_text('go')
        done = wait_for(lambda: get('/jobs/' + second['id']), lambda j: j['status'] in ('failed', 'succeeded', 'cancelled'), 'the second ends')
        assert done['status'] == 'succeeded', done
        # The task's activity says so too.
        status, task = request('/collaboration/task_get', {'taskId': 'T-1', 'view': 'activity'})
        assert status == 200, task
        lines = [a.get('body', '') for a in task.get('activities', []) if a.get('jobId') == calibration['id']]
        REPORT['taskActivity'] = lines
        assert any('lowered from 4096 MiB to 1024 MiB by You' in line for line in lines), lines
        check('the task activity records the lowering: from 4,096 to 1,024 MiB, by the user')
        REPORT['passed'] = True
    finally:
        stop_core()
        for spec in (LAB / 'data/jobs').glob('*/spec.json'):
            saved = json.loads(spec.read_text())
            for key in ('supervisorUnit', 'unit'):
                subprocess.run(['systemctl', '--user', 'stop', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
                subprocess.run(['systemctl', '--user', 'reset-failed', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        out = Path(os.environ.get('T38_LAB_REPORT', str(LAB / 'report.json')))
        out.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
        print(str(out), flush=True)


if __name__ == '__main__':
    sys.exit(main())
