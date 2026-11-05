#!/usr/bin/env python3
"""T-38: bounded backfill with real Jobs on an isolated lab Core (local_jobs_lab).

Never uses a paid model or the daily Core. Each Job waits for its own release
file, so the order of events is the test's, not a timer's. The numbers are
tonight's scaled down to a 4,096 MiB lab budget, so the declared limits stay
far below the host's free memory:
- an earlier Job holds 1,600 MiB (1,536 + collector);
- the head needs 2,624 MiB, 2,496 are free: short 128; 1,472 left beside it;
- a 1,088 MiB Job passes it; a 448 MiB Job then does not (1,088 + 448 > 1,472)
  although 1,408 MiB are free;
- the earlier Job ends: the head starts, before the 448 MiB Job.
Then three Projects take turns (review e06d83e8), their keys sorted P < Q < R:
- an earlier Job of P holds 1,600 MiB; P's head needs 2,624, short 128;
- 1,088 MiB Jobs of Q and of R come before the head in the turns: one passes
  it, marked, and the other waits behind it (1,088 + 1,088 > 1,472);
- the earlier Job ends: the head starts before the waiting Job, which starts
  once the passer ends.
Needs XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS (the user's systemd).
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
# The lab Core (core/examples/local_jobs_lab.rs) runs only in a target/t47/lab-*
# directory, the root every lab check shares; this check's report goes under
# target/t38 unless the Job names its own path in T38_LAB_REPORT.
LAB = ROOT / 'target' / 't47' / ('lab-' + uuid.uuid4().hex[:10])
PORT = int(os.environ.get('T38_LAB_PORT', '4491'))
BASE = 'http://127.0.0.1:' + str(PORT)
CORE = None
REPORT = {'task': 'T-38', 'checks': [], 'jobs': {}, 'reasons': {}, 'admission': {}, 'events': [],
          'fixture': 'Actual systemd user services and an independent lab Core; no model'}


def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + '/api' + path, data=data,
                                 headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def wait_for(read, accept, what, seconds=40):
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


def job(name, memory, task='T-1'):
    """A Job that holds `memory` MiB declared and waits for its release file."""
    code = ('import pathlib,time\n'
            f'pathlib.Path("started-{name}").write_text(str(time.time()))\n'
            f'while not pathlib.Path("release-{name}").exists(): time.sleep(0.2)\n')
    body = {'requestId': str(uuid.uuid4()), 'taskId': task, 'agentId': 'lab-a', 'name': name,
            'cwd': str(LAB / 'work'), 'argv': ['/usr/bin/python3', '-u', '-c', code], 'env': {}, 'guardGit': False,
            'resources': {'cpuMillis': 500, 'memoryMiB': memory, 'swapMiB': 0}, 'timeoutSeconds': 300}
    value = request('/jobs', body)
    REPORT['jobs'][name] = value['id']
    return value


def read(value):
    return request('/jobs/' + value['id'])


def release(name):
    (LAB / 'work' / ('release-' + name)).write_text('go')


def note(event):
    REPORT['events'].append({'at': time.time(), 'event': event})


def three_projects():
    """Review e06d83e8: the head is decided before the scan and keeps its place."""
    ids = sorted(request('/projects', {'name': 'Lab project ' + n})['id'] for n in ('one', 'two', 'three'))
    tasks = [request('/collaboration/task_create', {'requestId': str(uuid.uuid4()), 'title': 'Lab task ' + str(i),
                                                     'status': 'doing', 'projectId': pid})['task']['id']
             for i, pid in enumerate(ids)]
    p, q, r = tasks
    REPORT['threeProjects'] = {'projects': ids, 'tasks': tasks}
    earlier = job('earlier3', 1536, p)
    wait_for(lambda: read(earlier), lambda j: j['status'] == 'running', 'the earlier Job of P runs')
    note('earlier3 running')
    head = job('head3', 2560, p)
    wait_for(lambda: read(head), lambda j: (j['reason'] or '').endswith('may start ahead of it meanwhile'), "P's head waits")
    # After P the turns go Q, R: both small Jobs come before P's head.
    qa, ra = job('q3', 1024, q), job('r3', 1024, r)
    ran = wait_for(lambda: [read(qa), read(ra)], lambda pair: any(j['status'] == 'running' for j in pair), 'one small Job starts')
    passer, other = (ran[0], ra) if ran[0]['status'] == 'running' else (ran[1], qa)
    REPORT['admission']['three projects passer'] = passer.get('admission')
    assert (passer.get('admission') or {}).get('passed', {}).get('jobId') == head['id'], passer.get('admission')
    waiting = wait_for(lambda: read(other), lambda j: (j['reason'] or '').startswith('Waiting behind head3'), 'the other waits behind the head')
    REPORT['reasons']['three projects other'] = waiting['reason']
    time.sleep(3)
    assert read(other)['status'] == 'queued' and read(head)['status'] == 'queued'
    check('three Projects: the head is found before the turns; one 1,088 MiB Job passes it, marked, the other waits behind it')
    release('earlier3')
    note('earlier3 released')
    wait_for(lambda: read(head), lambda j: j['status'] == 'running', "P's head starts once the earlier Job ends")
    note('head3 running')
    assert read(other)['status'] == 'queued', 'the head started first'
    assert read(head).get('admission') is None
    check('three Projects: the earlier Job ends and the head keeps its place: it starts before the waiting Job')
    release(passer['name'])
    wait_for(lambda: read(other), lambda j: j['status'] == 'running', 'the waiting Job starts once the passer ends')
    for name in ('head3', other['name']):
        release(name)
    for value in (earlier, head, qa, ra):
        ended = wait_for(lambda: read(value), lambda j: j['status'] in ('succeeded', 'failed', 'cancelled', 'rejected'), 'each Job ends')
        assert ended['status'] == 'succeeded', ended
    starts = {name: float((LAB / 'work' / ('started-' + name)).read_text()) for name in ('earlier3', 'head3', 'q3', 'r3')}
    REPORT['threeProjects']['commandStarts'] = starts
    assert starts[passer['name']] < starts['head3'] < starts[other['name']], starts
    check('three Projects: the commands started passer, head, other; all four succeeded')


def main():
    assert os.environ.get('XDG_RUNTIME_DIR') and os.environ.get('DBUS_SESSION_BUS_ADDRESS'), 'the user systemd manager is needed'
    LAB.mkdir(parents=True, mode=0o700)
    (LAB / 'work').mkdir()
    print(str(LAB), flush=True)
    try:
        start_core()
        request('/jobs/budget', {'cpuMillis': 4000, 'memoryMiB': 4096, 'swapMiB': 0})
        earlier = job('earlier', 1536)
        wait_for(lambda: read(earlier), lambda j: j['status'] == 'running', 'the earlier Job runs')
        note('earlier running')
        head = job('head', 2560)
        small = job('small', 1024)
        second = job('second', 384)
        ran = wait_for(lambda: read(small), lambda j: j['status'] == 'running', 'the 1,088 MiB Job starts ahead of the head')
        note('small running')
        passed = ran['admission']['passed']
        REPORT['admission']['small'] = passed
        assert passed['jobId'] == head['id'], passed
        assert passed['room']['memoryMiB'] == 1472, passed
        held = read(head)
        assert held['status'] == 'queued', held
        # Read after the pass that started it, or the next one: either names
        # the head's need and what may still start ahead of it.
        REPORT['reasons']['head (small started)'] = held['reason']
        assert held['reason'].startswith('Waiting for shared RAM reservation: needs 2624 MiB including collector, '), held['reason']
        assert held['reason'].endswith('may start ahead of it meanwhile'), held['reason']
        check('outcome 1: a 1,088 MiB Job starts ahead of the 2,624 MiB head, marked with it, within the 1,472 MiB its need leaves')
        waiting = wait_for(lambda: read(second), lambda j: j['status'] == 'queued' and (j['reason'] or '').startswith('Waiting behind head'),
                           'the 448 MiB Job waits behind the head')
        REPORT['reasons']['second'] = waiting['reason']
        assert 'this job needs 600 mCPU / 448 MiB RAM / 0 MiB swap; ' in waiting['reason'] and '/ 384 MiB RAM /' in waiting['reason'], waiting['reason']
        # It stays: a few admission rounds go by and it is still queued.
        time.sleep(3)
        assert read(second)['status'] == 'queued'
        assert read(head)['status'] == 'queued'
        REPORT['reasons']['head (second waiting)'] = read(head)['reason']
        check('outcome 2: a 448 MiB Job does not pass (1,088 + 448 > 1,472) although 1,408 MiB are free')
        release('earlier')
        note('earlier released')
        wait_for(lambda: read(head), lambda j: j['status'] == 'running', 'the head starts once the earlier Job ends')
        note('head running')
        assert read(second)['status'] == 'queued', 'the head started first'
        REPORT['reasons']['second (head running)'] = read(second)['reason']
        assert read(head).get('admission') is None
        check('outcome 3: the earlier Job ends and the head starts first, before the waiting 448 MiB Job')
        release('small')
        note('small released')
        wait_for(lambda: read(second), lambda j: j['status'] == 'running', 'the 448 MiB Job starts once room is back')
        note('second running')
        for name in ('head', 'second'):
            release(name)
        for value in (earlier, small, head, second):
            ended = wait_for(lambda: read(value), lambda j: j['status'] in ('succeeded', 'failed', 'cancelled', 'rejected'), 'each Job ends')
            assert ended['status'] == 'succeeded', ended
        starts = {name: float((LAB / 'work' / ('started-' + name)).read_text()) for name in ('earlier', 'small', 'head', 'second')}
        REPORT['commandStarts'] = starts
        assert starts['small'] < starts['head'] < starts['second'], starts
        check('the commands started in that order: small, head, second; all four succeeded')
        three_projects()
        REPORT['passed'] = True
    finally:
        stop_core()
        for spec in (LAB / 'data/jobs').glob('*/spec.json'):
            saved = json.loads(spec.read_text())
            for key in ('supervisorUnit', 'unit'):
                subprocess.run(['systemctl', '--user', 'stop', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
                subprocess.run(['systemctl', '--user', 'reset-failed', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        out = Path(os.environ.get('T38_LAB_REPORT', str(ROOT / 'target' / 't38' / ('backfill-report-' + LAB.name + '.json'))))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
        print(str(out), flush=True)


if __name__ == '__main__':
    sys.exit(main())
