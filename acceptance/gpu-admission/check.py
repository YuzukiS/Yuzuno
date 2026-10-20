#!/usr/bin/env python3
"""T-106 GPU admission on an isolated Core with real systemd user services and
the real local GPU, through a small CUDA fixture (gpu_fixture.cu: a few
hundred MiB for a few seconds; no model, training or network).

- the GPUs are sampled by UUID (NVML, as nvidia-smi names them);
- a GPU job is the only managed GPU job on its device by default: a second
  waits with the device named, while a CPU job behind it starts and finishes;
- the command sees exactly the reserved device (CUDA_VISIBLE_DEVICES = UUID);
- a device closed to new jobs holds new GPU jobs, with the reason, until it is
  opened again;
- shared mode waits until the user opens the device for sharing, then two
  shared jobs run on it together;
- a request no device can hold, or for an unknown UUID, is refused at submit.

Uses the local_jobs_lab example (lab folders under target/t47/lab-*) on its
own port and data. Every lab job is a systemd user unit with its own
MemoryMax/CPUQuota inside the lab budget; cleanup stops only units whose specs
are in this lab's folder. GPU UUIDs are kept in the report by prefix only.
"""
from datetime import datetime
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
LAB = ROOT / 'target' / 't47' / ('lab-r106-' + uuid.uuid4().hex[:8])
WORK = LAB / 'work'
PORT = int(os.environ.get('T106_PORT', '4606'))
BASE = 'http://127.0.0.1:' + str(PORT)
FIXTURE = Path(os.environ['T106_FIXTURE'])
CORE = None
REPORT = {'checks': [], 'fixture': 'Isolated Core + real systemd user units + the local GPU; gpu_fixture (CUDA) only'}


def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + '/api' + path, data=data,
                                 headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def wait_for(read, accept=lambda v: bool(v), seconds=90):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        last = read()
        if accept(last):
            return last
        time.sleep(.25)
    raise AssertionError('Expected state did not arrive: ' + json.dumps(last)[:2000])


def start_core():
    global CORE
    log = (LAB / 'core.log').open('ab')
    CORE = subprocess.Popen([os.environ.get('T106_LAB_BIN') or str(ROOT / 'target/debug/examples/local_jobs_lab'),
                             str(LAB), str(PORT)], stdout=log, stderr=log)
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
        CORE.wait(timeout=15)
        CORE = None


class MCP:
    def __init__(self):
        config = json.loads((LAB / 'connection.json').read_text())
        self.url = config['url']
        self.headers = {**config['headers'], 'Content-Type': 'application/json',
                        'Accept': 'application/json, text/event-stream'}
        self.seq = 0
        self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                                'clientInfo': {'name': 'gpu-admission-acceptance', 'version': '1'}})
        self.rpc('notifications/initialized', None, notice=True)

    def rpc(self, method, params, notice=False):
        body = {'jsonrpc': '2.0', 'method': method}
        if not notice:
            self.seq += 1
            body['id'] = self.seq
        if params is not None:
            body['params'] = params
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=self.headers)
        with urllib.request.urlopen(req, timeout=60) as response:
            session = response.headers.get('Mcp-Session-Id')
            if session:
                self.headers['Mcp-Session-Id'] = session
            if notice:
                return None
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

    def call(self, tool, args, error=False):
        value = self.rpc('tools/call', {'name': tool, 'arguments': args})
        if error:
            assert value.get('isError'), value
            return value['content'][0]['text']
        assert not value.get('isError'), value
        return value['structuredContent']


def at(value):
    """An RFC 3339 time from Core, nanoseconds cut to what Python reads."""
    return datetime.fromisoformat(re.sub(r'(\.\d{6})\d+', r'\1', value))


def short(value):
    return value[:12] + '…' if isinstance(value, str) and value.startswith('GPU-') else value


def body(name, argv, gpu=None, memory=512, cpu=300):
    value = {'requestId': str(uuid.uuid4()), 'taskId': 'T-1', 'name': name, 'cwd': str(WORK), 'argv': argv,
             'env': {}, 'guardGit': False, 'timeoutSeconds': 120,
             'resources': {'cpuMillis': cpu, 'memoryMiB': memory, 'swapMiB': 0}}
    if gpu:
        value['gpu'] = gpu
    return value


def gpu_job(mcp, name, seconds, mib=256, **gpu):
    return mcp.call('job_submit', body(name, [str(WORK / 'gpu_fixture'), '--mib', str(mib), '--seconds', str(seconds),
                                              '--progress', str(WORK / f'{name}.progress.json')],
                                       gpu={'memoryMiB': 1024, **gpu}))


def job(job_id):
    return request('/jobs/' + job_id)


def status(job_id, *statuses, seconds=90):
    return wait_for(lambda: job(job_id), lambda j: j['status'] in statuses, seconds)


def events(job_id):
    text = request(f'/jobs/{job_id}/logs')['text']
    return [json.loads(line) for line in text.splitlines() if line.startswith('{"event"')]


def saw(job_id):
    """What the command itself saw: the device CUDA gave it."""
    device = next(e for e in events(job_id) if e['event'] == 'device')
    return device


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def main():
    LAB.mkdir(parents=True, mode=0o700)
    WORK.mkdir()
    shutil.copy(FIXTURE, WORK / 'gpu_fixture')
    print(str(LAB), flush=True)
    try:
        start_core()
        request('/jobs/budget', {'cpuMillis': 1200, 'memoryMiB': 1600, 'swapMiB': 0})
        mcp = MCP()
        names = {t['name'] for t in mcp.rpc('tools/list', {})['tools']}
        assert {'job_submit', 'job_budget', 'job_gpu_admission'} <= names, names

        # 1. Devices by UUID, from NVML; the same UUIDs nvidia-smi names.
        gpus = wait_for(lambda: request('/jobs/gpus'), lambda v: v['devices'] and not v['problem'])
        assert gpus['source'] == 'nvml', gpus['source']
        device = gpus['devices'][0]
        uid = device['uuid']
        smi = shutil.which('nvidia-smi') or '/usr/lib/wsl/lib/nvidia-smi'
        smi_uuids = subprocess.run([smi, '--query-gpu=uuid', '--format=csv,noheader'], stdout=subprocess.PIPE,
                                   text=True, timeout=20, check=True).stdout.split()
        assert [d['uuid'] for d in gpus['devices']] == smi_uuids, 'NVML and nvidia-smi name the same devices'
        assert device['memoryTotalMiB'] > 0 and device['memoryFreeMiB'] is not None and device['admission'] == 'open'
        REPORT['device'] = {'uuid': short(uid), 'name': device['name'], 'memoryTotalMiB': device['memoryTotalMiB'],
                            'memoryFreeMiBAtStart': device['memoryFreeMiB'], 'source': gpus['source']}
        check('GPUs are sampled by UUID through NVML, the same UUIDs nvidia-smi reports, with total and free memory')

        # 2. Exclusive by default; a CPU job behind a GPU waiter starts.
        a = gpu_job(mcp, 'gpu-a', 10)
        a = status(a['id'], 'running')
        assert a['gpuReservation'][0]['uuid'] == uid and a['gpuReservation'][0]['mode'] == 'exclusive', a['gpuReservation']
        b = gpu_job(mcp, 'gpu-b', 2)
        c = mcp.call('job_submit', body('cpu-c', ['/usr/bin/python3', '-c', 'import time; time.sleep(1)'], memory=96, cpu=200))
        b = wait_for(lambda: job(b['id']), lambda j: 'is in use by managed job gpu-a' in (j['reason'] or ''))
        assert b['status'] == 'queued', b
        c = status(c['id'], 'succeeded', 'failed')
        assert c['status'] == 'succeeded', c
        assert job(a['id'])['status'] == 'running', 'the CPU job finished while the GPU job still held the device'
        assert job(b['id'])['status'] == 'queued'
        REPORT['secondGpuJobWaited'] = b['reason'].replace(uid[:12], short(uid))
        a = status(a['id'], 'succeeded', 'failed')
        b = status(b['id'], 'succeeded', 'failed')
        assert a['status'] == 'succeeded' and b['status'] == 'succeeded', (a['reason'], b['reason'])
        assert at(b['startedAt']) >= at(a['finishedAt']), (a['finishedAt'], b['startedAt'])
        check('A second exclusive GPU job waits, naming the device and its holder, while a CPU job behind it runs; it starts after the first ends')

        # 3. The command sees exactly the reserved device.
        for j in (a, b):
            seen = saw(j['id'])
            assert seen['uuid'] == uid and seen['cudaVisibleDevices'] == uid and seen['visible'] == 1, seen
            done = next(e for e in events(j['id']) if e['event'] == 'done')
            assert done['sample'] > 0, done
        REPORT['fixtureSaw'] = {'uuid': short(seen['uuid']), 'visible': seen['visible'], 'kernelRan': True}
        check('Each GPU job sees only its reserved device (CUDA_VISIBLE_DEVICES = UUID), and its kernel ran')

        # 4. Closed to new jobs, then open again.
        closed = mcp.call('job_gpu_admission', {'uuid': uid, 'open': False, 'reason': 'lab: closed for a check'})
        assert closed['devices'][0]['admission'] == 'closed', closed
        d = gpu_job(mcp, 'gpu-d', 2)
        d = wait_for(lambda: job(d['id']), lambda j: 'closed to new jobs (lab: closed for a check)' in (j['reason'] or ''))
        time.sleep(12)  # past a GPU resample: still held
        d = job(d['id'])
        assert d['status'] == 'queued' and d['startedAt'] is None, d
        REPORT['closedReason'] = d['reason'].replace(uid[:12], short(uid))
        mcp.call('job_gpu_admission', {'uuid': uid, 'open': True})
        d = status(d['id'], 'succeeded', 'failed')
        assert d['status'] == 'succeeded' and d['gpuReservation'][0]['uuid'] == uid, d
        # A close the user made (the panel's route) is not the Agent's to undo.
        request(f'/jobs/gpus/{uid}/admission', {'open': False, 'reason': 'lab: kept by the user'})
        refused = mcp.call('job_gpu_admission', {'uuid': uid, 'open': True}, error=True)
        assert 'only the user can open it again' in refused, refused
        kept = request('/jobs/gpus')['devices'][0]
        assert kept['admission'] == 'closed' and kept['closedBy'] == 'user', kept
        request(f'/jobs/gpus/{uid}/admission', {'open': True})
        assert request('/jobs/gpus')['devices'][0]['admission'] == 'open'
        REPORT['agentReopenRefused'] = refused
        check('A device closed to new jobs holds a new GPU job with the reason; opened again, the job starts; an Agent cannot reopen a close the user made')

        # 5. Shared mode needs the user's opt-in; then two run together.
        e1, e2 = gpu_job(mcp, 'gpu-e1', 5, mode='shared'), gpu_job(mcp, 'gpu-e2', 5, mode='shared')
        wait_for(lambda: job(e1['id']), lambda j: 'is not open for sharing' in (j['reason'] or ''))
        assert job(e1['id'])['status'] == 'queued' and job(e2['id'])['status'] == 'queued'
        request(f'/jobs/gpus/{uid}/settings', {'sharing': True})
        both = wait_for(lambda: [job(e1['id']), job(e2['id'])], lambda js: all(j['status'] == 'running' for j in js))
        assert all(j['gpuReservation'][0]['mode'] == 'shared' for j in both)
        held = request('/jobs/gpus')['devices'][0]['reservations']
        assert sorted(r['name'] for r in held) == ['gpu-e1', 'gpu-e2'], held
        for j in (e1, e2):
            assert status(j['id'], 'succeeded', 'failed')['status'] == 'succeeded'
        request(f'/jobs/gpus/{uid}/settings', {'sharing': False})
        assert request('/jobs/gpus')['devices'][0]['sharing'] is False
        check('Shared GPU jobs wait until the user opens the device for sharing, then run on it together')

        # 6. Refused at submit.
        never = mcp.call('job_submit', body('too-big', ['/usr/bin/true'], gpu={'memoryMiB': device['memoryTotalMiB'] + 1}), error=True)
        assert 'can never fit' in never, never
        # Within the total but above what admission can ever give.
        edge = mcp.call('job_submit', body('edge', ['/usr/bin/true'],
                                           gpu={'memoryMiB': device['memoryTotalMiB'] - device['headroomMiB'] + 1}), error=True)
        assert 'can never fit' in edge, edge
        unknown = mcp.call('job_submit', body('unknown', ['/usr/bin/true'],
                                              gpu={'memoryMiB': 256, 'devices': ['GPU-00000000-0000-0000-0000-000000000000']}), error=True)
        assert 'is not known on this machine' in unknown, unknown
        REPORT['refusals'] = {'neverFits': never, 'aboveTotalLessKeptFree': edge, 'unknownUuid': unknown}
        check('A request larger than any device can give one job (total less memory kept free), or for an unknown UUID, is refused at submit')
        REPORT['passed'] = True
    finally:
        stop_core()
        for spec in (LAB / 'data/jobs').glob('*/spec.json'):
            saved = json.loads(spec.read_text())
            for key in ('supervisorUnit', 'unit'):
                subprocess.run(['systemctl', '--user', 'stop', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
                subprocess.run(['systemctl', '--user', 'reset-failed', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        (LAB / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))
        print(str(LAB / 'report.json'), flush=True)


if __name__ == '__main__':
    main()
    sys.exit(0 if REPORT.get('passed') else 1)
