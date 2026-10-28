#!/usr/bin/env python3
"""T-5: a Project service served by an ordinary Job, on an isolated Core with real systemd user services.

The independent lab Core of acceptance/local-jobs (target/debug/examples/local_jobs_lab) runs a real
HTTP server as a service Job. The services list must say whose listener answers the port, and a restart
must be a new Job only once the earlier one has ended. Never uses a paid model or the daily Core; every
process and unit it starts belongs to its own lab folder and is stopped at the end.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
LAB = ROOT / 'target' / 't47' / ('lab-t5sj-' + uuid.uuid4().hex[:10])
PORT = int(os.environ.get('T5_SJ_PORT', '4521'))
BASE = 'http://127.0.0.1:' + str(PORT)
CORE = None
REPORT = {'checks': [], 'jobs': {}, 'fixture': 'Isolated Core, actual systemd user services, python3 http.server as the served command'}


def request(path, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + '/api' + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def refused(path, body):
    try:
        request(path, body)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    raise AssertionError('expected a refusal for ' + path)


def wait_for(read, accept=lambda v: bool(v), seconds=35):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        last = read()
        if accept(last):
            return last
        time.sleep(.25)
    raise AssertionError('Expected state did not arrive: ' + str(last)[:1500])


def start_core():
    global CORE
    log = (LAB / 'core.log').open('ab')
    CORE = subprocess.Popen([str(ROOT / 'target/debug/examples/local_jobs_lab'), str(LAB), str(PORT)], stdout=log, stderr=log)
    log.close()
    for _ in range(80):
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


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def server(port, name, task, **service):
    return {'requestId': str(uuid.uuid4()), 'taskId': task, 'agentId': 'lab-a', 'name': name,
            'cwd': str(LAB / 'work'), 'argv': ['/usr/bin/python3', '-u', '-m', 'http.server', str(port), '--bind', '127.0.0.1'],
            'env': {}, 'guardGit': False, 'resources': {'cpuMillis': 300, 'memoryMiB': 128, 'swapMiB': 0},
            'timeoutSeconds': 120, 'service': service}


def submit(body):
    job = request('/jobs', body)
    REPORT['jobs'][body['name'] + ' ' + body['requestId'][:8]] = job['id']
    return job


def ended(job, expected):
    result = wait_for(lambda: request('/jobs/' + job['id']),
                      lambda v: v['status'] in ('succeeded', 'failed', 'cancelled', 'rejected', 'interrupted'))
    assert result['status'] == expected, result
    return result


def listed(project, service_id):
    return next(s for s in request('/projects/' + project + '/services')['services'] if s['id'] == service_id)


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def main():
    LAB.mkdir(parents=True, mode=0o700)
    (LAB / 'work').mkdir()
    (LAB / 'external').mkdir()
    print(str(LAB), flush=True)
    external = None
    try:
        start_core()
        request('/jobs/budget', {'cpuMillis': 1200, 'memoryMiB': 640, 'swapMiB': 0})
        project = request('/projects', {'name': 'Lab portal'})['id']
        task = request('/collaboration/task_create', {'requestId': 'lab-portal-task', 'title': 'Serve the lab page',
                                                      'status': 'doing', 'projectId': project})['task']['id']

        # 1. A served service: process running, then its listener proven to be the Job's, then healthy.
        port = free_port()
        first = submit(server(port, 'lab-web', task, name='Lab web', port=port, healthPath='/'))
        assert first['service'] == {'name': 'Lab web', 'port': port, 'healthPath': '/'}, first['service']
        service = next(s['id'] for s in request('/projects/' + project + '/services')['services'] if s['port'] == port)
        wait_for(lambda: request('/jobs/' + first['id']), lambda j: j['status'] == 'running')
        view = wait_for(lambda: listed(project, service), lambda v: v['job']['owner'] == 'verified')
        assert view['job']['jobId'] == first['id'] and view['job']['status'] == 'running', view
        assert view['job']['canStop'] is True and view['job']['earlierJobIds'] == [], view
        healthy = wait_for(lambda: listed(project, service), lambda v: v['health'].get('state') == 'ok')
        assert healthy['health']['httpStatus'] == 200 and healthy['health']['path'] == '/', healthy['health']
        check('A service Job runs an ordinary unit; the list shows it running, its own listener verified and its declared health ok')

        # 2. An external service: something else serves it, so no Job and nothing to stop.
        other = free_port()
        external = subprocess.Popen(['/usr/bin/python3', '-u', '-m', 'http.server', str(other), '--bind', '127.0.0.1'],
                                    cwd=str(LAB / 'external'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_for(lambda: socket.socket().connect_ex(('127.0.0.1', other)) == 0, seconds=10)
        outside = request('/projects/' + project + '/services', {'name': 'Outside', 'machineId': 'local', 'port': other, 'path': '/'})['id']
        view = listed(project, outside)
        assert view['job'] is None and view['health'] == {'declared': False}, view
        check('A registered external service has job null: Yuzuno offers no stop for it')

        # 3. A Job whose declared port another process holds: never shown as its own.
        squatter = submit({**server(other, 'squatter', task, name='Squatter', port=other, path='/squat'),
                           'argv': ['/usr/bin/python3', '-u', '-c', 'import time; time.sleep(60)']})
        squat = next(s['id'] for s in request('/projects/' + project + '/services')['services'] if s['path'] == '/squat')
        wait_for(lambda: request('/jobs/' + squatter['id']), lambda j: j['status'] == 'running')
        view = wait_for(lambda: listed(project, squat), lambda v: v['job']['status'] == 'running')
        assert view['job']['owner'] == 'otherProcess', view
        assert view['health'] == {'declared': False}, view
        check('A running service Job whose port another process answers is otherProcess, not ours')

        # 4. A restart while the first Job serves is refused; cancel, then the restart is a new Job of the same service.
        code, text = refused('/jobs', server(port, 'lab-web-too-early', task, serviceId=service))
        assert code >= 400 and 'still served by Job' in text and first['id'] in text, (code, text)
        request('/jobs/' + first['id'] + '/cancel', {})
        ended(first, 'cancelled')
        view = wait_for(lambda: listed(project, service), lambda v: v['job']['owner'] == 'notListening')
        assert view['job']['status'] == 'cancelled' and view['job']['canStop'] is False, view
        assert view['health']['state'] == 'unknown', view
        second = submit(server(port, 'lab-web-restart', task, serviceId=service, healthPath='/'))
        wait_for(lambda: request('/jobs/' + second['id']), lambda j: j['status'] == 'running')
        view = wait_for(lambda: listed(project, service), lambda v: v['job']['owner'] == 'verified')
        assert view['job']['jobId'] == second['id'] and view['job']['earlierJobIds'] == [first['id']], view
        check('A restart is refused while the earlier Job serves; after its cancel, a new Job serves the same service')

        # 5. Core restarts: the unit lives on, and the list proves the listener is still the same Job's.
        stop_core()
        start_core()
        view = wait_for(lambda: listed(project, service), lambda v: v['job']['owner'] == 'verified')
        assert view['job']['jobId'] == second['id'] and view['job']['status'] == 'running', view
        check('After a Core restart the service Job still runs and its listener is still verified as its own')

        for job in (second, squatter):
            request('/jobs/' + job['id'] + '/cancel', {})
            ended(job, 'cancelled')
        REPORT['passed'] = True
    finally:
        if external:
            external.terminate()
            external.wait(timeout=10)
        stop_core()
        # Clean up only units whose specs belong to this unique lab directory.
        for spec in (LAB / 'data/jobs').glob('*/spec.json'):
            saved = json.loads(spec.read_text())
            for key in ('supervisorUnit', 'unit'):
                subprocess.run(['systemctl', '--user', 'stop', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
                subprocess.run(['systemctl', '--user', 'reset-failed', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        (LAB / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))
        print(str(LAB / 'report.json'), flush=True)


if __name__ == '__main__':
    main()
