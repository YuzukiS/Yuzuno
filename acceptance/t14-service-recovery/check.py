#!/usr/bin/env python3
"""Exercise a managed service's opt-in automatic retry (T-14, design v3.4) on an
isolated Core with real systemd Jobs.

Build core/examples/local_jobs_lab first. Every process belongs to this
script's unique lab directory; it never contacts the daily Workspace. The
synthetic app reads what to do from an unguarded mode file, so each retry of
the same retained launch can serve, exit or crash. Real delays (30 s, 2 min)
are used; the budget's end at three retries and the queue's window are
covered by the Store tests.
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
LAB = ROOT / 'target' / 't47' / ('lab-t14r-' + uuid.uuid4().hex[:10])
BINARY = Path(os.environ.get('T14_LAB_BINARY', ROOT / 'target/debug/examples/local_jobs_lab'))
REPORT_PATH = Path(os.environ.get('T14_REPORT', LAB / 'report.json'))
CORE = None
PORT = None
REPORT = {'passed': False, 'checks': [], 'jobs': [],
          'fixture': 'Isolated Core, real systemd Job units, synthetic HTTP app that serves, exits or crashes; no daily Workspace'}
TERMINAL = {'succeeded', 'failed', 'cancelled', 'rejected', 'interrupted'}
# What the app does is read at its start from mode.txt (not a guarded input):
# "serve", "exit <seconds> <code>" or "segv <seconds>".
APP = '''import http.server, os, signal, sys, threading, time
port = int(sys.argv[1])
here = os.path.dirname(os.path.abspath(__file__))
# A sentinel: one line for every time the command itself really starts.
with open(os.path.join(here, 'ran.log'), 'a') as ran:
    ran.write('ran\\n')
mode = open(os.path.join(here, 'mode.txt')).read().split()
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *args):
        pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
if mode[0] == 'exit':
    time.sleep(float(mode[1])); os._exit(int(mode[2]))
if mode[0] == 'segv':
    time.sleep(float(mode[1])); os.kill(os.getpid(), signal.SIGSEGV)
while True:
    time.sleep(60)
'''


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
        return text
    raise AssertionError('Expected refusal: ' + path)


def wait_for(read, accept=bool, seconds=40):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        last = read()
        if accept(last):
            return last
        time.sleep(.25)
    raise AssertionError('Expected observation did not arrive: ' + str(last)[:2000])


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


def terminal(job_id, seconds=60):
    return wait_for(lambda: job(job_id), lambda value: value['status'] in TERMINAL and not value.get('reserved'), seconds)


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def epoch(at):
    """RFC 3339 from Core (nanoseconds) as Unix seconds."""
    from datetime import datetime
    import re
    trimmed = re.sub(r'(\.\d{6})\d+', r'\1', at.replace('Z', '+00:00'))
    return datetime.fromisoformat(trimmed).timestamp()


class Lab:
    """One project, task and service, driven through the browser routes."""

    def __init__(self, name):
        self.project = request('/projects', {'name': name})['id']
        self.task = request('/collaboration/task_create', {
            'requestId': 'task-' + uuid.uuid4().hex, 'title': name, 'status': 'doing',
            'projectId': self.project})['task']['id']
        self.work = LAB / ('work-' + uuid.uuid4().hex[:6])
        self.work.mkdir()
        (self.work / 'app.py').write_text(APP)
        (self.work / 'config.txt').write_text('original\n')
        self.port = available_port()
        self.mode('exit 1 1')
        first = request('/jobs', self.launch({'name': name, 'port': self.port, 'healthPath': '/'}))
        REPORT['jobs'].append(first['id'])
        self.id = next(v['id'] for v in request('/projects/' + self.project + '/services')['services'] if v['port'] == self.port)
        terminal(first['id'])

    def mode(self, text):
        (self.work / 'mode.txt').write_text(text + '\n')

    def launch(self, service):
        return {'requestId': str(uuid.uuid4()), 'taskId': self.task, 'agentId': 'lab-a', 'name': 'Lab app',
                'cwd': str(self.work), 'argv': ['/usr/bin/python3', '-u', 'app.py', str(self.port)],
                'env': {}, 'guardGit': False, 'inputs': ['config.txt'],
                'resources': {'cpuMillis': 300, 'memoryMiB': 128, 'swapMiB': 0},
                'timeoutSeconds': 600, 'service': service}

    def view(self):
        return next(v for v in request('/projects/' + self.project + '/services')['services'] if v['id'] == self.id)

    def until(self, accept, seconds=60):
        return wait_for(self.view, accept, seconds)

    def start(self, view, lifetime, bounded):
        body = {'requestId': str(uuid.uuid4()), 'expectedJobId': view['job']['jobId'],
                'expectedIntentRevision': view['lifecycle']['intent']['revision'],
                'sourceJobId': view['job']['jobId'], 'timeoutSeconds': lifetime}
        if bounded:
            body['recovery'] = {'mode': 'bounded'}
        receipt = request('/services/' + self.id + '/start', body)
        REPORT['jobs'].append(receipt['jobId'])
        return receipt

    def stop(self, view):
        return request('/services/' + self.id + '/stop', {'requestId': str(uuid.uuid4()), 'expectedJobId': view['job']['jobId'],
                       'expectedIntentRevision': view['lifecycle']['intent']['revision']})

    def opt_out(self, view):
        return request('/services/' + self.id + '/recovery', {'requestId': str(uuid.uuid4()),
                       'expectedJobId': view['job']['jobId'],
                       'expectedIntentRevision': view['lifecycle']['intent']['revision'], 'mode': 'manual'})


def recovery(view):
    return view['lifecycle']['recovery']


def main():
    global PORT
    assert BINARY.is_file(), 'Build local_jobs_lab or set T14_LAB_BINARY to its copied binary'
    LAB.mkdir(parents=True, mode=0o700)
    PORT = available_port(4600, 4700)
    print(str(LAB), flush=True)
    try:
        start_core()
        request('/jobs/budget', {'cpuMillis': 2400, 'memoryMiB': 1280, 'swapMiB': 0})

        # 1. Manual by default: a crash is not retried.
        manual = Lab('Manual')
        receipt = manual.start(manual.view(), 600, bounded=False)
        assert receipt['intent']['recoveryMode'] == 'manual'
        ended = terminal(receipt['jobId'])
        assert ended['status'] == 'failed', ended
        time.sleep(2)
        view = manual.view()
        assert view['job']['jobId'] == receipt['jobId'] and recovery(view)['state'] == 'off'
        check('Without the opt-in a crash starts nothing')

        # 2. Opted in: a crash queues one retry after 30 s; it waits, then runs.
        main_lab = Lab('Retry')
        root = main_lab.start(main_lab.view(), 900, bounded=True)
        assert root['intent']['recoveryMode'] == 'bounded'
        waiting = main_lab.until(lambda v: recovery(v)['state'] == 'waiting')
        retry1 = waiting['job']['jobId']
        assert retry1 != root['jobId']
        crashed = job(root['jobId'])
        assert crashed['status'] == 'failed' and crashed['retriedBy'] == retry1
        delay = epoch(recovery(waiting)['notBefore']) - epoch(crashed['finishedAt'])
        assert 25 <= delay <= 35, delay
        assert recovery(waiting)['retry']['scheduled'] == 1 and recovery(waiting)['launch'] == 'queued'
        time.sleep(15)
        assert job(retry1)['status'] == 'queued', 'not before its delay'
        main_lab.mode('segv 2')
        # Started counts the command's own creation, which the host records
        # right after the worker's start; a reading or two later shows it.
        running = main_lab.until(lambda v: v['job']['jobId'] == retry1 and recovery(v)['launch'] == 'running'
                                 and recovery(v)['retry']['started'] == 1, 45)
        assert recovery(running)['state'] == 'retry', recovery(running)
        second = main_lab.until(lambda v: recovery(v)['state'] == 'waiting' and v['job']['jobId'] != retry1, 45)
        retry2 = second['job']['jobId']
        assert recovery(second)['lastFailure']['kind'] in ('signal', 'core_dump'), recovery(second)['lastFailure']
        assert recovery(second)['retry']['scheduled'] == 2
        outcomes = [(a['retry'], a['jobId'], a['outcome']) for a in recovery(second)['attempts']]
        assert outcomes[0] == (0, root['jobId'], 'exit:1'), outcomes
        assert outcomes[1][:2] == (1, retry1) and outcomes[1][2] in ('signal:SIGSEGV', 'core_dump'), outcomes
        assert outcomes[2] == (2, retry2, None), outcomes
        check('A confirmed crash queues one retry after its delay; a crash of that retry queues the next')

        # 3. A Stop from the reading taken before retry 2 still stops the period:
        # retry 2 is cancelled and never starts.
        receipt = main_lab.stop(running)
        assert receipt['jobId'] == retry2 and receipt['status'] == 'cancelled', receipt
        time.sleep(3)
        stopped = main_lab.view()
        assert recovery(stopped)['state'] == 'halted' and recovery(stopped)['haltedReason'] == 'user_stop'
        assert job(retry2)['status'] == 'cancelled' and not job(retry2).get('startedAt')
        check('Stop ends the recovery period from an older reading; the queued retry never starts')

        # 4. Opt-out while a retry waits: it is cancelled and never starts;
        # the user's intent to run is unchanged.
        out = Lab('Opt-out')
        out.start(out.view(), 900, bounded=True)
        waiting = out.until(lambda v: recovery(v)['state'] == 'waiting')
        receipt = out.opt_out(waiting)
        assert receipt['cancelledRetryJobId'] == waiting['job']['jobId'] and receipt['action'] == 'recovery', receipt
        before = waiting['lifecycle']['intent']
        assert (receipt['intent']['revision'], receipt['intent']['recoveryMode'], receipt['intent']['desiredState']) \
            == (before['revision'] + 1, 'manual', before['desiredState']), receipt
        after = out.view()
        assert recovery(after)['state'] == 'off' and recovery(after)['haltedReason'] == 'opted_out'
        assert job(waiting['job']['jobId'])['status'] == 'cancelled'
        check('Turning automatic retry off cancels a waiting retry; it never starts')

        # 5. A guarded input changed while it waited: the retry is refused at launch.
        guarded = Lab('Guarded')
        guarded.start(guarded.view(), 900, bounded=True)
        waiting = guarded.until(lambda v: recovery(v)['state'] == 'waiting')
        (guarded.work / 'config.txt').write_text('changed\n')
        refused_retry = terminal(waiting['job']['jobId'], 60)
        assert refused_retry['status'] == 'rejected', refused_retry
        halted = guarded.until(lambda v: recovery(v)['state'] == 'halted')
        assert recovery(halted)['haltedReason'] == 'inputs_changed', recovery(halted)
        check('Changed guarded inputs refuse the retry before its command starts and end recovery')

        # 6. Too little time: with less than 60 s left after the delay, no retry.
        short = Lab('Short')
        short.start(short.view(), 80, bounded=True)
        ended = short.until(lambda v: recovery(v)['state'] == 'ended', 30)
        assert recovery(ended)['haltedReason'] == 'insufficient_time', recovery(ended)
        assert ended['job']['jobId'] == recovery(ended)['attempts'][-1]['jobId']
        check('No retry is queued when less than 60 s would remain before the end time')

        # 7. The end time holds for a retry: the host stops it there.
        timed = Lab('End time')
        root = timed.start(timed.view(), 100, bounded=True)
        waiting = timed.until(lambda v: recovery(v)['state'] == 'waiting')
        timed.mode('serve')
        retry = waiting['job']['jobId']
        end = epoch(recovery(waiting)['deadlineAt'])
        finished = terminal(retry, 140)
        evidence = finished['result']['evidence']
        # The collector's stop at the end time; RuntimeMaxSec is only a backstop
        # (it counts from activation, so it fires later), and either reads as
        # the end time.
        by = 'collector' if (evidence.get('deadline') or {}).get('kind') == 'stop' else evidence['systemd']['Result']
        assert by in ('collector', 'timeout'), finished['result']
        late = epoch(finished['finishedAt']) - end
        REPORT['endTime'] = {'stoppedBy': by, 'secondsAfterEnd': round(late, 3)}
        assert -1 <= late <= 8, late
        final = timed.until(lambda v: recovery(v)['state'] == 'ended')
        assert recovery(final)['haltedReason'] == 'lifetime_reached'
        check('A retry runs only until the run\'s fixed end time and is stopped there; nothing follows')

        # 8. Core restart while a retry waits: it never starts, recovery is manual.
        restart = Lab('Restart')
        restart.start(restart.view(), 900, bounded=True)
        waiting = restart.until(lambda v: recovery(v)['state'] == 'waiting')
        stop_core()
        start_core()
        halted = restart.view()
        assert recovery(halted)['state'] == 'halted' and recovery(halted)['haltedReason'] == 'core_restart'
        refused_retry = terminal(waiting['job']['jobId'], 60)
        assert refused_retry['status'] == 'rejected' and refused_retry['result']['evidence']['recoveryRefusal'] == 'core_restart'
        assert restart.view()['job']['jobId'] == waiting['job']['jobId'], 'nothing after it'
        check('After a Core restart a retry queued before it never starts; recovery is manual')

        # 9. Another run taking over never inherits recovery.
        taken = short.view()
        short.mode('exit 1 1')
        other = request('/jobs', short.launch({'serviceId': short.id, 'healthPath': '/'}))
        REPORT['jobs'].append(other['id'])
        over = short.view()
        assert recovery(over)['haltedReason'] == 'superseded', recovery(over)
        terminal(other['id'])
        time.sleep(2)
        assert short.view()['job']['jobId'] == other['id'], 'its crash starts nothing'
        refused('/services/' + short.id + '/stop', {'requestId': str(uuid.uuid4()), 'expectedJobId': taken['job']['jobId'],
                'expectedIntentRevision': taken['lifecycle']['intent']['revision']}, 'stale_service_state')
        check('A run that takes over does not inherit recovery, and an older Stop never touches it')

        # 10. A guarded input that can no longer be checked while a retry waits
        # (now a directory, or past the 2 MiB guard): the wrapper fails before
        # creating the command, which never runs, and nothing follows.
        broken = {'directory': Lab('Input directory'), 'oversize': Lab('Input oversize')}
        waiting = {}
        for name, lab in broken.items():
            lab.start(lab.view(), 900, bounded=True)
            waiting[name] = lab.until(lambda v: recovery(v)['state'] == 'waiting')
        for name, lab in broken.items():
            config = lab.work / 'config.txt'
            if name == 'directory':
                config.unlink()
                config.mkdir()
            else:
                config.write_bytes(b'x' * (3 * 1024 * 1024))
        for name, lab in broken.items():
            runs = (lab.work / 'ran.log').read_text().count('ran')
            retry = waiting[name]['job']['jobId']
            ended = terminal(retry, 90)
            evidence = ended['result']['evidence']
            assert (evidence.get('notLaunched') or {}).get('stage') == 'inputs', (name, ended['result'])
            assert 'command' not in evidence, (name, evidence)
            halted = lab.until(lambda v: recovery(v)['state'] == 'halted')
            assert recovery(halted)['haltedReason'] == 'inputs_changed', (name, recovery(halted))
            assert recovery(halted)['retry']['scheduled'] == 1, (name, recovery(halted))
            assert (lab.work / 'ran.log').read_text().count('ran') == runs, (name, 'the retry\'s command never ran')
            assert job(retry).get('retriedBy') is None and lab.view()['job']['jobId'] == retry, (name, 'nothing follows')
            REPORT.setdefault('notLaunched', {})[name] = {'jobId': retry, 'status': ended['status'], 'notLaunched': evidence['notLaunched']}
        check('A guarded input that became a directory or outgrew the guard stops a retry before its command; nothing follows')
        REPORT['passed'] = True
    finally:
        stop_core()
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
                                pass
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
