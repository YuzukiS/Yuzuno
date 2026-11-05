#!/usr/bin/env python3
"""T-38 C: a request suggested from an earlier run's measured peak, with real
Jobs on an isolated lab Core (local_jobs_lab). Never uses a paid model or the
daily Core.

- A first "calibration" Job holds about 900 MiB and keeps one core busy for
  4 s, then succeeds; Core measures its peak memory and average cores.
- A second submission of the same name answers with a suggestion computed
  from that measurement (peak × 1.5, RAM rounded up to 512 MiB and at least
  1 GiB, CPU rounded up to 100 mCPU), based on the first Job, while its own
  request stays as sent.
- A run whose stage has that name answers with the same suggestion for it.
- The submit form's question (GET /api/jobs/suggestion) gives the same, and
  none for a name and command never run in the task.
Needs XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS (the user's systemd).
"""
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
# The lab Core (core/examples/local_jobs_lab.rs) runs only in a target/t47/lab-*
# directory, the root every lab check shares; this check's report goes under
# target/t38 unless the Job names its own path in T38_LAB_REPORT.
LAB = ROOT / 'target' / 't47' / ('lab-' + uuid.uuid4().hex[:10])
PORT = int(os.environ.get('T38_LAB_PORT', '4493'))
BASE = 'http://127.0.0.1:' + str(PORT)
CORE = None
REPORT = {'task': 'T-38 C', 'checks': [], 'jobs': {}, 'answers': {},
          'fixture': 'Actual systemd user services and an independent lab Core; no model'}


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


# About 900 MiB held, touched page by page, and one core busy for 4 s.
CALIBRATION = '''import time
keep=bytearray(900*1024*1024)
for i in range(0,len(keep),4096): keep[i]=1
end=time.monotonic()+4
n=0
while time.monotonic()<end: n+=1
'''


def body(name, argv, memory):
    return {'requestId': str(uuid.uuid4()), 'taskId': 'T-1', 'agentId': 'lab-a', 'name': name,
            'cwd': str(LAB / 'work'), 'argv': argv, 'env': {}, 'guardGit': False,
            'resources': {'cpuMillis': 2000, 'memoryMiB': memory, 'swapMiB': 0}, 'timeoutSeconds': 300}


def up_to(value, step):
    """As Core rounds: float noise below a thousandth ignored, then up to a multiple of step."""
    return math.ceil(round(value * 1000) / 1000 / step) * step


def main():
    assert os.environ.get('XDG_RUNTIME_DIR') and os.environ.get('DBUS_SESSION_BUS_ADDRESS'), 'the user systemd manager is needed'
    LAB.mkdir(parents=True, mode=0o700)
    (LAB / 'work').mkdir()
    print(str(LAB), flush=True)
    try:
        start_core()
        request('/jobs/budget', {'cpuMillis': 4000, 'memoryMiB': 8192, 'swapMiB': 0})
        status, first = request('/jobs', body('calibration', ['/usr/bin/python3', '-u', '-c', CALIBRATION], 4096))
        assert status == 200, first
        REPORT['jobs']['calibration'] = first['id']
        assert 'suggestion' not in first, first.get('suggestion')
        check('the first run of its name and command has no suggestion')
        done = wait_for(lambda: get('/jobs/' + first['id']), lambda j: j['status'] in ('succeeded', 'failed', 'cancelled'), 'the calibration ends')
        assert done['status'] == 'succeeded', done
        actual = done['resourceSummary']['actual']
        REPORT['measured'] = done['resourceSummary']
        assert done['resourceSummary']['measurement'] == 'complete', done['resourceSummary']
        peak, cores = actual['memoryPeakMiB'], actual['averageCpuCores']
        assert 900 <= peak < 1100 and cores is not None and cores > 0.5, actual
        memory = max(1024, up_to(peak * 1.5, 512))
        cpu = max(100, up_to(cores * 1.5 * 1000, 100))
        REPORT['expected'] = {'memoryMiB': memory, 'cpuMillis': cpu}
        check('the calibration is measured: peak %.0f MiB, %.2f average cores' % (peak, cores))
        # The same name again, another command: suggested from the measurement, request as sent.
        status, second = request('/jobs', body('calibration', ['/usr/bin/true'], 4096))
        assert status == 200, second
        REPORT['jobs']['second'] = second['id']
        suggestion = second.get('suggestion')
        REPORT['answers']['job_submit'] = suggestion
        assert suggestion and (suggestion['memoryMiB'], suggestion['cpuMillis']) == (memory, cpu), (suggestion, memory, cpu)
        assert [r['jobId'] for r in suggestion['basedOn']] == [first['id']], suggestion['basedOn']
        assert second['resources'] == {'cpuMillis': 2000, 'memoryMiB': 4096, 'swapMiB': 0}, second['resources']
        assert get('/jobs/' + second['id'])['resources']['memoryMiB'] == 4096
        assert 'suggestion' not in get('/jobs/' + second['id']), 'not kept on the Job'
        check('a second submission of that name answers with %d MiB / %d mCPU from the first run, and its request stays 4096 MiB / 2000 mCPU' % (memory, cpu))
        # A run whose stage has that name.
        run_body = {'requestId': str(uuid.uuid4()), 'taskId': 'T-1', 'agentId': 'lab-a', 'name': 'sweep',
                    'stages': [{'key': 'calib', 'name': 'calibration', 'cwd': str(LAB / 'work'), 'argv': ['/usr/bin/true'], 'env': {},
                                'guardGit': False, 'resources': {'cpuMillis': 2000, 'memoryMiB': 4096, 'swapMiB': 0}, 'timeoutSeconds': 300}]}
        status, run = request('/jobs/runs', run_body)
        assert status == 200, run
        REPORT['jobs']['run'] = run['id']
        REPORT['answers']['job_run_submit'] = run.get('suggestions')
        stage = (run.get('suggestions') or [{}])[0]
        assert (stage.get('stage'), stage.get('memoryMiB'), stage.get('cpuMillis')) == ('calib', memory, cpu), run.get('suggestions')
        check('a run whose stage has that name answers with the same suggestion for the stage')
        # The submit form's question.
        query = urllib.parse.urlencode({'taskId': 'T-1', 'name': 'calibration'})
        form = get('/jobs/suggestion?' + query)['suggestion']
        REPORT['answers']['form'] = form
        assert (form['memoryMiB'], form['cpuMillis']) == (memory, cpu), form
        query = urllib.parse.urlencode({'taskId': 'T-1', 'name': 'never run', 'argv': json.dumps(['/bin/sh', '-c', 'never run'])})
        none = get('/jobs/suggestion?' + query)
        assert none == {'suggestion': None}, none
        check('the submit form gets the same suggestion, and none for a name and command never run in the task')
        for job in [second['id']] + [a['jobId'] for s in run.get('stages', []) for a in s.get('attempts', []) if a.get('jobId')]:
            wait_for(lambda: get('/jobs/' + job), lambda j: j['status'] in ('succeeded', 'failed', 'cancelled'), 'a quick job ends')
        REPORT['passed'] = True
    finally:
        stop_core()
        for spec in (LAB / 'data/jobs').glob('*/spec.json'):
            saved = json.loads(spec.read_text())
            for key in ('supervisorUnit', 'unit'):
                subprocess.run(['systemctl', '--user', 'stop', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
                subprocess.run(['systemctl', '--user', 'reset-failed', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        out = Path(os.environ.get('T38_LAB_REPORT', str(ROOT / 'target' / 't38' / ('suggest-report-' + LAB.name + '.json'))))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
        print(str(out), flush=True)


if __name__ == '__main__':
    sys.exit(main())
