#!/usr/bin/env python3
"""Exercise explicit service stop/start on an isolated Core and real Jobs.

Build core/examples/local_jobs_lab first. Every process belongs to this
script's unique lab directory; it never contacts the daily Workspace. The
API checks are observations of this bounded experiment, not a poller for
the managed Job that invokes it.
"""
from concurrent.futures import ThreadPoolExecutor
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
LAB = ROOT / 'target' / 't47' / ('lab-t14-' + uuid.uuid4().hex[:10])
BINARY = Path(os.environ.get('T14_LAB_BINARY', ROOT / 'target/debug/examples/local_jobs_lab'))
REPORT_PATH = Path(os.environ.get('T14_REPORT', LAB / 'report.json'))
CORE = None
PORT = None
REPORT = {'passed': False, 'checks': [], 'jobs': [],
          'fixture': 'Isolated Core, real systemd Job units, synthetic HTTP service; no daily Workspace'}
TERMINAL = {'succeeded', 'failed', 'cancelled', 'rejected', 'interrupted'}


def request(path, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request('http://127.0.0.1:' + str(PORT) + '/api' + path,
                                 data=data, method=method,
                                 headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def refused(path, body, containing=None):
    try:
        request(path, body)
    except urllib.error.HTTPError as error:
        text = error.read().decode()
        assert 400 <= error.code < 500, (error.code, text)
        if containing:
            assert containing in text, (containing, text)
        return
    raise AssertionError('Expected refusal: ' + path)


def wait_for(read, accept=bool, seconds=40):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        last = read()
        if accept(last):
            return last
        time.sleep(.2)
    raise AssertionError('Expected observation did not arrive: ' + str(last)[:1500])


def available_port(low=None, high=None):
    if low is None:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            return sock.getsockname()[1]
    for port in range(low, high):
        with socket.socket() as sock:
            try:
                sock.bind(('127.0.0.1', port))
                return port
            except OSError:
                pass
    raise AssertionError('No isolated Core port available')


def start_core():
    global CORE
    with (LAB / 'core.log').open('ab') as log:
        CORE = subprocess.Popen([str(BINARY), str(LAB), str(PORT)], stdout=log, stderr=log)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        assert CORE.poll() is None, (LAB / 'core.log').read_text()[-2000:]
        try:
            health = request('/health')
            # The no-update-controller lab reports identity, not managed
            # installation readiness fields.
            if health.get('workspaceId') and health.get('product') == 'yuzuno':
                return
        except OSError:
            pass
        time.sleep(.1)
    raise AssertionError('Isolated Core did not become ready')


def stop_core():
    global CORE
    if CORE is not None:
        CORE.terminate()
        try:
            CORE.wait(timeout=10)
        except subprocess.TimeoutExpired:
            CORE.kill()
            CORE.wait(timeout=5)
        CORE = None


def job(job_id):
    return request('/jobs/' + job_id)


def terminal(job_id):
    return wait_for(lambda: job(job_id), lambda value: value['status'] in TERMINAL and not value.get('reserved'))


def service(project, service_id):
    return next(value for value in request('/projects/' + project + '/services')['services'] if value['id'] == service_id)


def server(task, port, declared, timeout=180):
    return {'requestId': str(uuid.uuid4()), 'taskId': task, 'agentId': 'lab-a', 'name': 'Lab web',
            'cwd': str(LAB / 'work'),
            'argv': ['/usr/bin/python3', '-u', '-m', 'http.server', str(port), '--bind', '127.0.0.1'],
            'env': {'T14_SYNTHETIC_VALUE': 'kept-from-source-run'}, 'guardGit': False,
            'inputs': ['config.txt'], 'resources': {'cpuMillis': 300, 'memoryMiB': 128, 'swapMiB': 0},
            'timeoutSeconds': timeout, 'service': declared}


def action_input(view, **extra):
    return {'requestId': str(uuid.uuid4()), 'expectedJobId': view['job']['jobId'],
            'expectedIntentRevision': view['lifecycle']['intent']['revision'], **extra}


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def assert_public(view):
    encoded = json.dumps(view)
    for private in ('kept-from-source-run', 'T14_SYNTHETIC_VALUE', str(LAB / 'work'), '"argv"', '"env"', '"snapshot"'):
        assert private not in encoded, private


def main():
    global PORT
    assert BINARY.is_file(), 'Build local_jobs_lab or set T14_LAB_BINARY to its copied binary'
    LAB.mkdir(parents=True, mode=0o700)
    (LAB / 'work').mkdir()
    config = LAB / 'work/config.txt'
    config.write_text('original\n')
    PORT = available_port(4530, 4600)
    print(str(LAB), flush=True)
    try:
        start_core()
        request('/jobs/budget', {'cpuMillis': 1200, 'memoryMiB': 640, 'swapMiB': 0})
        project = request('/projects', {'name': 'Lifecycle lab'})['id']
        task = request('/collaboration/task_create', {
            'requestId': 'lifecycle-lab-task', 'title': 'Serve the isolated preview',
            'status': 'doing', 'projectId': project})['task']['id']
        port = available_port()
        first = request('/jobs', server(task, port, {'name': 'Lab preview', 'port': port, 'healthPath': '/'}))
        REPORT['jobs'].append(first['id'])
        service_id = next(value['id'] for value in request('/projects/' + project + '/services')['services'] if value['port'] == port)
        view = wait_for(lambda: service(project, service_id),
                        lambda value: value['job']['owner'] == 'verified' and value['health'].get('state') == 'ok')
        assert view['job']['jobId'] == first['id']
        assert view['lifecycle']['intent']['desiredState'] == 'unspecified'
        assert view['lifecycle']['canStart'] is False
        assert view['job']['startedAt'] and view['job']['timeoutSeconds'] == 180
        assert_public(view)
        check('Ordinary service run is healthy; legacy intent is unspecified and duplicate start unavailable')

        # Preview connection is a separate resource; it cannot change the run.
        request('/services/' + service_id + '/open', {})
        request('/services/' + service_id + '/close', {})
        unchanged = service(project, service_id)
        assert unchanged['job']['jobId'] == first['id'] and unchanged['job']['status'] == 'running'
        assert unchanged['lifecycle']['intent'] == view['lifecycle']['intent']
        check('Opening and closing preview preserves running Job and intent')

        stop_path = '/services/' + service_id + '/stop'
        start_path = '/services/' + service_id + '/start'
        stop_input = action_input(view)
        stopped_receipt = request(stop_path, stop_input)
        assert stopped_receipt['intent']['desiredState'] == 'stopped'
        assert stopped_receipt['intent']['requestedBy'] == {'kind': 'user'}
        assert request(stop_path, stop_input) == stopped_receipt
        assert terminal(first['id'])['status'] == 'cancelled'
        stopped = service(project, service_id)
        assert stopped['lifecycle']['canStart'] is True
        assert stopped['lifecycle']['intent']['appliesToJobId'] == first['id']
        refused(stop_path, {**stop_input, 'expectedIntentRevision': 999})
        check('Explicit stop persists a user choice; identical replay is stable and different payload conflicts')

        stop_core()
        start_core()
        after_restart = service(project, service_id)
        assert after_restart['job']['jobId'] == first['id']
        assert after_restart['job']['status'] == 'cancelled'
        assert after_restart['lifecycle']['intent'] == stopped['lifecycle']['intent']
        refused('/jobs', server(task, port, {'serviceId': service_id, 'healthPath': '/'}))
        check('Core restart retains stopped intent and same run; ordinary submission cannot clear user stop')

        start_input = action_input(after_restart, sourceJobId=first['id'], timeoutSeconds=3600)
        refused(start_path, {**start_input, 'requestId': str(uuid.uuid4()), 'expectedIntentRevision': 0})
        refused(start_path, {**start_input, 'requestId': str(uuid.uuid4()), 'argv': ['/bin/false']})
        refused(start_path, {**start_input, 'requestId': str(uuid.uuid4()), 'env': {'UNEXPECTED': 'value'}})
        with ThreadPoolExecutor(max_workers=2) as pool:
            receipts = list(pool.map(lambda _: request(start_path, start_input), range(2)))
        assert receipts[0] == receipts[1]
        second_id = receipts[0]['jobId']
        assert second_id != first['id']
        REPORT['jobs'].append(second_id)
        running = wait_for(lambda: service(project, service_id),
                           lambda value: value['job']['jobId'] == second_id and value['job']['owner'] == 'verified')
        second = job(second_id)
        assert second['argv'] == first['argv'] and second['env'] == first['env']
        assert second['timeoutSeconds'] == 3600 and running['job']['earlierJobIds'] == [first['id']]
        assert_public(running)
        stop_core()
        start_core()
        assert request(start_path, start_input) == receipts[0]
        running = wait_for(lambda: service(project, service_id),
                           lambda value: value['job']['jobId'] == second_id and value['job']['owner'] == 'verified')
        assert request(stop_path, stop_input) == stopped_receipt
        refused(stop_path, {**stop_input, 'requestId': str(uuid.uuid4())})
        assert job(second_id)['status'] == 'running'
        check('Concurrent identical start creates one new run; old stop replay never cancels it; original specification retained')

        request(stop_path, action_input(running))
        assert terminal(second_id)['status'] == 'cancelled'
        stopped_again = service(project, service_id)
        guarded_start = action_input(stopped_again, sourceJobId=second_id, timeoutSeconds=3)
        config.write_text('changed\n')
        refused(start_path, guarded_start)
        still_stopped = service(project, service_id)
        assert still_stopped['job']['jobId'] == second_id
        assert still_stopped['lifecycle']['intent'] == stopped_again['lifecycle']['intent']
        config.write_text('original\n')
        expiring = request(start_path, {**guarded_start, 'requestId': str(uuid.uuid4())})
        REPORT['jobs'].append(expiring['jobId'])
        check('Changed guarded inputs refuse restart without clearing stop intent or adding a run')

        external = request('/projects/' + project + '/services', {
            'name': 'External registration', 'machineId': 'local', 'port': available_port(), 'path': '/'})
        outside = service(project, external['id'])
        assert outside['job'] is None and outside.get('lifecycle') is None
        invalid = {'requestId': str(uuid.uuid4()), 'expectedJobId': second_id, 'expectedIntentRevision': 0}
        refused('/services/' + external['id'] + '/stop', invalid)
        refused('/services/' + external['id'] + '/start', {**invalid, 'sourceJobId': second_id, 'timeoutSeconds': 60})
        check('External registrations expose no lifecycle and cannot start or stop another service run')

        expired = wait_for(lambda: job(expiring['jobId']),
                           lambda value: value['status'] in TERMINAL and not value.get('reserved'), seconds=40)
        assert expired['status'] == 'failed' and expired['result']['reason'] == 'timeout', expired
        expired_view = service(project, service_id)
        assert expired_view['job']['jobId'] == expiring['jobId']
        assert expired_view['job']['finishedAt']
        assert expired_view['lifecycle']['canStart'] is True
        stop_core()
        start_core()
        assert service(project, service_id)['job']['jobId'] == expiring['jobId']
        check('Actual timeout ends and releases the run; Core restart does not automatically renew it')
        REPORT['passed'] = True
    finally:
        stop_core()
        # Only stop units named in this unique lab's retained specifications.
        cleanup_errors = []
        cleanup = []
        for spec in (LAB / 'data/jobs').glob('*/spec.json'):
            saved = json.loads(spec.read_text())
            for key in ('supervisorUnit', 'unit'):
                unit = saved.get(key)
                if not unit:
                    continue
                try:
                    stopped = subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True,
                                             text=True, timeout=8, check=False)
                    shown = subprocess.run(['systemctl', '--user', 'show', unit, '--property=LoadState',
                                            '--property=ActiveState', '--property=MainPID', '--property=ControlGroup'],
                                           capture_output=True, text=True, timeout=8, check=False)
                    properties = dict(line.split('=', 1) for line in shown.stdout.splitlines() if '=' in line)
                    gone = properties.get('LoadState') == 'not-found'
                    inactive = properties.get('ActiveState') in ('inactive', 'failed') and properties.get('MainPID') == '0'
                    processes = []
                    group = properties.get('ControlGroup')
                    if group:
                        cgroup = Path('/sys/fs/cgroup') / group.lstrip('/')
                        for members in cgroup.rglob('cgroup.procs'):
                            try:
                                processes.extend(members.read_text().split())
                            except FileNotFoundError:
                                pass  # Kernel removed the exited group during inspection.
                    verified = (gone or (shown.returncode == 0 and inactive)) and not processes
                    cleanup.append({'unit': unit, 'stopExitCode': stopped.returncode, 'verifiedExited': verified,
                                    'state': properties.get('ActiveState'), 'remainingProcesses': processes})
                    if not verified:
                        cleanup_errors.append(unit)
                    subprocess.run(['systemctl', '--user', 'reset-failed', unit], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=8, check=False)
                except subprocess.TimeoutExpired:
                    cleanup_errors.append(unit)
        REPORT['cleanup'] = cleanup
        REPORT['cleanupFailures'] = cleanup_errors
        REPORT['lab'] = str(LAB)
        if cleanup_errors:
            REPORT['passed'] = False
        REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        REPORT_PATH.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
        print(str(REPORT_PATH), flush=True)
        assert not cleanup_errors, cleanup_errors


if __name__ == '__main__':
    main()
