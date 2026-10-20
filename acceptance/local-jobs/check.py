#!/usr/bin/env python3
"""Actual isolated Core + systemd + MCP acceptance, with a scripted native peer.
Never uses a paid model or daily Core. Run under heavy-slot and memory limits.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
LAB = ROOT / 'target' / 't47' / ('lab-' + uuid.uuid4().hex[:10])
PORT = 4487
BASE = 'http://127.0.0.1:' + str(PORT)
CORE = None
REPORT = {'checks': [], 'jobs': {}, 'fixture': 'Actual systemd user services and independent Core; scripted Codex protocol peer, no paid model'}

def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + '/api' + path, data=data, headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)

def wait_for(read, accept=lambda v: bool(v), seconds=35):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        last = read()
        if accept(last):
            return last
        time.sleep(.2)
    raise AssertionError('Expected state did not arrive: ' + str(last)[:1200])

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

class MCP:
    def __init__(self):
        config = json.loads((LAB / 'connection.json').read_text())
        self.url, self.headers = config['url'], config['headers']
        self.headers = {**self.headers, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        self.seq = 0
        self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'isolated-jobs-acceptance', 'version': '1'}})
        self.rpc('notifications/initialized', None, notice=True)

    def rpc(self, method, params, notice=False):
        body = {'jsonrpc': '2.0', 'method': method}
        if not notice:
            self.seq += 1
            body['id'] = self.seq
        if params is not None:
            body['params'] = params
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=self.headers)
        with urllib.request.urlopen(req, timeout=45) as response:
            session = response.headers.get('Mcp-Session-Id')
            if session:
                self.headers['Mcp-Session-Id'] = session
            if notice:
                return
            if response.headers.get('Content-Type', '').startswith('text/event-stream'):
                while True:
                    line = response.readline().decode()
                    if line.startswith('data: '):
                        value = json.loads(line[6:])
                        if value.get('id') == self.seq:
                            break
                    if not line:
                        raise AssertionError('MCP stream ended before response')
            else:
                value = json.load(response)
        assert 'error' not in value, value
        return value['result']

    def call(self, tool, args):
        value = self.rpc('tools/call', {'name': tool, 'arguments': args})
        assert not value.get('isError'), value
        return value['structuredContent']

def payload(name, code, **overrides):
    return {'requestId': str(uuid.uuid4()), 'taskId': 'T-1', 'agentId': 'lab-a', 'name': name,
            'cwd': str(LAB / 'work'), 'argv': ['/usr/bin/python3', '-u', '-c', code],
            'env': {}, 'guardGit': False, 'resources': {'cpuMillis': 500, 'memoryMiB': 96, 'swapMiB': 0}, 'timeoutSeconds': 40, **overrides}

def submit(body, mcp=None):
    job = mcp.call('job_submit', {k: v for k, v in body.items() if k != 'agentId'}) if mcp else request('/jobs', body)
    REPORT['jobs'][body['name']] = job['id']
    return job

def done(job, expected):
    result = wait_for(lambda: request('/jobs/' + job['id']), lambda v: v['status'] in ('succeeded', 'failed', 'cancelled', 'rejected', 'interrupted'))
    assert result['status'] == expected, result
    assert not result['reserved']
    return result

def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)

def main():
    LAB.mkdir(parents=True, mode=0o700)
    (LAB / 'work').mkdir()
    print(str(LAB), flush=True)
    try:
        start_core()
        request('/jobs/budget', {'cpuMillis': 600, 'memoryMiB': 160, 'swapMiB': 0})
        mcp = MCP()
        tools = mcp.rpc('tools/list', {})
        assert any(t['name'] == 'job_submit' for t in tools['tools'])
        request('/agents/lab-a/reconnect', {})
        request('/agents/lab-a/messages', {'clientMessageId': str(uuid.uuid4()), 'text': 'Controlled source Turn; no model.'})
        body = payload('mcp-after-turn', 'import time,pathlib; pathlib.Path("once.txt").write_text("one"); time.sleep(6); print("中文 done")', outputs=['once.txt'])
        began = time.monotonic()
        first = submit(body, mcp)
        assert time.monotonic() - began < 3, 'Submission should not wait for execution'
        duplicate = mcp.call('job_submit', {k: v for k, v in body.items() if k != 'agentId'})
        assert first['id'] == duplicate['id']
        second = submit(payload('queued-failure', 'import sys; print("intentional failure"); sys.exit(7)'))
        wait_for(lambda: request('/jobs/' + first['id']), lambda j: j['status'] == 'running')
        assert request('/jobs/' + second['id'])['status'] == 'queued'
        budget = request('/jobs/budget')
        assert budget['reserved']['memoryMiB'] <= 160 and budget['reserved']['cpuMillis'] <= 600
        wait_for(lambda: request('/agents/lab-a'), lambda d: d['agent']['status'] == 'idle')
        assert request('/jobs/' + first['id'])['status'] == 'running'
        finished = done(first, 'succeeded')
        failed = done(second, 'failed')
        assert failed['result']['evidence']['systemd']['ExecMainStatus'] == '7'
        assert finished['result']['started']['limits']['memory.max'] == str(96 * 1024 * 1024)
        assert finished['result']['started']['limits']['memory.swap.max'] == '0'
        assert '中文 done' in request('/jobs/' + first['id'] + '/logs')['text']
        with urllib.request.urlopen(BASE + '/api/jobs/' + first['id'] + '/outputs/0') as response:
            assert response.read() == b'one'
        wait_for(lambda: len((LAB / 'native-starts.jsonl').read_text().splitlines()) >= 2)
        delivered = mcp.call('peer_read', {'priority': 'normal', 'afterSeq': 0, 'limit': 50})
        assert any(m.get('jobId') == first['id'] for m in delivered['messages'])
        check('MCP returns durable ID, duplicate submit stays one job, Turn ends while job runs; bounded queue and exit 0/7')

        offline = submit(payload('core-offline', 'import time,pathlib; p=pathlib.Path("offline-starts"); p.write_text(p.read_text()+"start\\n" if p.exists() else "start\\n"); time.sleep(6); print("offline completion")'))
        queued = submit(payload('offline-queue', 'print("started after Core returned")'))
        wait_for(lambda: request('/jobs/' + offline['id']), lambda j: j['status'] == 'running')
        stop_core()
        result_file = LAB / 'data/jobs' / offline['id'] / 'result.json'
        wait_for(lambda: result_file.exists(), seconds=15)
        machine = json.loads(result_file.read_text())
        assert machine['status'] == 'succeeded' and machine['evidence']['systemd']['InvocationID']
        assert not (LAB / 'data/jobs' / queued['id'] / 'dispatched.json').exists()
        start_core()
        done(offline, 'succeeded'); done(queued, 'succeeded')
        assert (LAB / 'work/offline-starts').read_text() == 'start\n'
        mails = request('/collaboration/peer_read', {'agentId': 'lab-a', 'priority': 'normal', 'limit': 50})['messages']
        matching = [m for m in mails if m.get('jobId') == offline['id']]
        assert len(matching) == 1 and matching[0]['sender']['kind'] == 'system'
        stop_core(); start_core()
        mails2 = request('/collaboration/peer_read', {'agentId': 'lab-a', 'priority': 'normal', 'limit': 50})['messages']
        assert len([m for m in mails2 if m.get('jobId') == offline['id']]) == 1
        assert request('/collaboration/task_get', {'taskId': 'T-1'})['task']['status'] == 'doing'
        check('Core offline completion leaves OS evidence; queued work waits; two restarts neither rerun nor duplicate system mail/task completion')

        cancel = submit(payload('cancel-child', 'import subprocess,pathlib,time; p=subprocess.Popen(["/usr/bin/sleep","35"]); pathlib.Path("child.pid").write_text(str(p.pid)); time.sleep(35)'))
        pid_file = LAB / 'work/child.pid'
        wait_for(lambda: pid_file.exists()); child = int(pid_file.read_text())
        request('/jobs/' + cancel['id'] + '/cancel', {})
        cancelled = done(cancel, 'cancelled')
        assert not Path('/proc', str(child)).exists()
        assert cancelled['result']['evidence']['groupsEmpty']
        check('Cancellation persists intent and confirms launcher/worker group plus child exit before release')

        uncertain = submit(payload('unknown-then-cancel', 'import time;time.sleep(30)'))
        running = wait_for(lambda: request('/jobs/' + uncertain['id']), lambda j: j['status'] == 'running')
        subprocess.run(['systemctl', '--user', 'stop', running['supervisorUnit']], check=True, timeout=8)
        folder = LAB / 'data/jobs' / uncertain['id']
        (folder / 'result.json').write_text(json.dumps({'jobId': running['id'], 'attempt': running['attempt'],
            'status': 'unknown', 'reason': 'Lab: collector outcome unavailable'}))
        request('/jobs/' + uncertain['id'] + '/cancel', {})
        done(uncertain, 'cancelled')
        check('A retained unknown outcome can still be cancelled after collector loss; verified process groups release reservation')

        oom = submit(payload('bounded-oom', 'a=[]\nwhile True:a.append(bytearray(1024*1024))'))
        ended = done(oom, 'failed')
        assert ended['result']['evidence']['systemd']['Result'] == 'oom-kill'
        assert int(ended['result']['evidence']['systemd']['MemoryPeak']) <= 100 * 1024 * 1024
        check('96 MiB/zero-swap OOM kills only the isolated job; external collector durably records oom-kill')

        blocker = submit(payload('guard-blocker', 'import time;time.sleep(5)'))
        config = LAB / 'work/small-config.txt'; config.write_text('first')
        guarded = submit(payload('changed-input', 'print("must not run")', inputs=['small-config.txt']))
        config.write_text('second')
        done(blocker, 'succeeded'); done(guarded, 'rejected')
        assert 'must not run' not in request('/jobs/' + guarded['id'] + '/logs')['text']
        check('Non-Git command snapshots work; changed declared input rejects queued execution without running command')

        noisy = submit(payload('bounded-log', 'import os;os.write(1,b"x"*(5*1024*1024));print("TAIL-END")'))
        done(noisy, 'succeeded')
        output = request('/jobs/' + noisy['id'] + '/logs')
        assert 'TAIL-END' in output['text'] and len(output['text'].encode()) <= 32768
        assert output['oldestOffset'] > 0 and output['totalBytes'] >= 5 * 1024 * 1024
        assert sum(p.stat().st_size for p in (LAB / 'data/jobs' / noisy['id']).glob('log-*.bin')) <= 2 * 1024 * 1024 + 16
        stale = request('/jobs/' + noisy['id'] + '/logs?offset=0'); assert stale['truncated']
        check('Disk logs stay within two MiB; bounded tail/paging reports overwritten bytes')
        REPORT['passed'] = True
    finally:
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
