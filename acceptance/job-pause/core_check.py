#!/usr/bin/env python3
"""Pause and resume through an isolated Core and real systemd Jobs (T-107).

Uses the no-model lab host target/debug/examples/local_jobs_lab, with its
own data under <worktree>/target/t47/lab-t107-*, port 4594 and its own
transient yuzuno-job-<uuid> units. Never touches daily Core data or units.
The commands are fixture.py process trees. Run it directly, not in a Job:
it starts and restarts the lab Core.

Usage: core_check.py [OUT_DIR]
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent / 'fixture.py'
LAB = ROOT / 'target' / 't47' / ('lab-t107-' + uuid.uuid4().hex[:8])
PORT = 4594
BASE = f'http://127.0.0.1:{PORT}'
CORE = None
CHECKS = []
JOBS = {}


def check(name, ok, detail=None):
    CHECKS.append({'check': name, 'ok': bool(ok), 'detail': detail})
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + json.dumps(detail, default=str)[:800]), flush=True)
    return ok


def request(path, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + '/api' + path, data=data, method=method or ('POST' if data is not None else 'GET'),
                                 headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def refused(path):
    """(status, body text) of a request expected to fail."""
    try:
        return 200, json.dumps(request(path, {}))
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode(errors='replace')


def wait_for(read, accept, seconds=40):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        last = read()
        if accept(last):
            return last
        time.sleep(0.25)
    raise AssertionError('Expected state did not arrive: ' + json.dumps(last, default=str)[:1200])


def start_core():
    global CORE
    log = (LAB / 'core.log').open('ab')
    CORE = subprocess.Popen(['systemd-run', '--user', '--scope', '--quiet', '-p', 'MemoryMax=1G', '-p', 'MemorySwapMax=0',
                             str(ROOT / 'target/debug/examples/local_jobs_lab'), str(LAB), str(PORT)], stdout=log, stderr=log)
    log.close()
    for _ in range(100):
        if CORE.poll() is not None:
            raise AssertionError('Lab Core exited: ' + (LAB / 'core.log').read_text()[-2000:])
        try:
            request('/health')
            return
        except OSError:
            time.sleep(0.1)
    raise AssertionError('Lab Core did not listen')


def stop_core():
    global CORE
    if CORE:
        CORE.terminate()
        CORE.wait(timeout=15)
        CORE = None


class MCP:
    """The lab Agent lab-a's own MCP session."""

    def __init__(self):
        config = json.loads((LAB / 'connection.json').read_text())
        self.url = config['url']
        self.headers = {**config['headers'], 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        self.seq = 0
        self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 't107-pause', 'version': '1'}})
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
            if response.headers.get('Mcp-Session-Id'):
                self.headers['Mcp-Session-Id'] = response.headers['Mcp-Session-Id']
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
                        raise AssertionError('MCP stream ended before the response')
            else:
                value = json.load(response)
        assert 'error' not in value, value
        return value['result']

    def call(self, tool, args):
        value = self.rpc('tools/call', {'name': tool, 'arguments': args})
        assert not value.get('isError'), value
        return value['structuredContent']


def submit(name, steps=None, timeout=300, code=None, gpu=None):
    state = LAB / 'state' / name
    argv = (['/usr/bin/python3', '-c', code] if code else
            ['/usr/bin/python3', str(FIXTURE), 'tree', str(state)] + ([str(steps)] if steps else []))
    job = request('/jobs', {'requestId': str(uuid.uuid4()), 'taskId': 'T-1', 'agentId': 'lab-a', 'name': name,
                            'cwd': str(LAB / 'work'), 'argv': argv, 'env': {}, 'guardGit': False,
                            'resources': {'cpuMillis': 500, 'memoryMiB': 128, 'swapMiB': 0}, 'timeoutSeconds': timeout,
                            **({'gpu': gpu} if gpu else {})})
    JOBS[name] = job['id']
    return job, state


def progress(state):
    out = {}
    for p in Path(state).glob('*.json'):
        try:
            v = json.loads(p.read_text())
            out[v['name']] = {'pid': v['pid'], 'count': v['count']}
        except (OSError, ValueError, KeyError):
            pass
    return out


def tree_running(state):
    return wait_for(lambda: progress(state), lambda p: len(p) == 5 and all(v['count'] > 3 for v in p.values()))


def start_ticks(pids):
    out = {}
    for pid in pids:
        try:
            raw = Path(f'/proc/{pid}/stat').read_text()
            out[pid] = int(raw[raw.rindex(')') + 2:].split()[19])
        except OSError:
            out[pid] = None
    return out


def still(state, seconds=2):
    before = progress(state)
    time.sleep(seconds)
    after = progress(state)
    return len(before) == 5 and all(after[n]['count'] == before[n]['count'] for n in before), {'before': before, 'after': after}


def job(name):
    return request('/jobs/' + JOBS[name])


def terminal(name, seconds=60):
    return wait_for(lambda: job(name), lambda j: j['status'] in ('succeeded', 'failed', 'cancelled', 'rejected', 'interrupted'), seconds)


def mails(mcp, job_id):
    messages = mcp.call('peer_read', {'priority': 'normal', 'afterSeq': 0, 'limit': 200})['messages']
    return [m['metadata']['status'] for m in messages if m.get('jobId') == job_id and m.get('metadata')]


def pause_restart_resume(session):
    mcp = session[0]
    first, state = submit('pause-me', steps=500)
    wait_for(lambda: job('pause-me'), lambda j: j['status'] == 'running')
    seen = tree_running(state)
    ticks = start_ticks(v['pid'] for v in seen.values())
    second, _ = submit('waits-for-capacity', code='print("second ran")')
    budget = request('/jobs/budget')
    paused = request(f'/jobs/{first["id"]}/pause', {})
    check('pause answers with the confirmed state: paused, still running and reserved',
          paused.get('pause', {}).get('state') == 'paused' and paused['status'] == 'running' and paused['reserved'] is True, paused.get('pause'))
    ok, detail = still(state)
    check('no process of the job advances while it is paused', ok, detail)
    time.sleep(4)  # two collector ticks
    check('the queued job does not take the paused job\'s capacity',
          job('waits-for-capacity')['status'] == 'queued' and request('/jobs/budget')['reserved'] == budget['reserved'],
          {'second': job('waits-for-capacity')['status'], 'reserved': request('/jobs/budget')['reserved'], 'before': budget['reserved']})
    check("the job's Agent is told it was paused", mails(mcp, first['id']) == ['paused'], mails(mcp, first['id']))
    again = request(f'/jobs/{first["id"]}/pause', {})
    check('pausing again is a no-op without another mail', again['pause'] == paused['pause'] and mails(mcp, first['id']) == ['paused'])
    listed = request('/jobs')['jobs']
    check('the job list shows the pause and the timeout', any(j['id'] == first['id'] and j.get('pause', {}).get('state') == 'paused'
                                                              and j.get('timeoutSeconds') == 300 for j in listed))
    stop_core()
    ok, detail = still(state, 2)
    check('with Core stopped the job stays frozen', ok, detail)
    start_core()
    # The restarted Core issues its Agent a new MCP connection.
    mcp = session[0] = MCP()
    time.sleep(5)  # reconciliation passes after the restart
    after = job('pause-me')
    ok, detail = still(state, 2)
    check('after a Core restart the job is still paused and frozen; Core did not resume it',
          after['status'] == 'running' and after.get('pause', {}).get('state') == 'paused' and ok, {'pause': after.get('pause'), **detail})
    check('the queued job still waits after the restart', job('waits-for-capacity')['status'] == 'queued')
    resumed = request(f'/jobs/{first["id"]}/resume', {})
    check('resume answers running with the pause cleared and recorded', 'pause' not in resumed and len(resumed.get('pauses', [])) == 1, resumed.get('pauses'))
    time.sleep(1)
    moved = progress(state)
    check('the same processes continue after resume',
          start_ticks(v['pid'] for v in seen.values()) == ticks and all(moved[n]['count'] > seen[n]['count'] for n in seen), {'ticks': ticks})
    done = terminal('pause-me', 90)
    check('the resumed job finishes by itself and succeeds', done['status'] == 'succeeded', done.get('reason'))
    check('then the queued job runs', terminal('waits-for-capacity', 60)['status'] == 'succeeded')
    check("the Agent is told of the pause and the resume, then the outcome",
          mails(mcp, first['id']) == ['paused', 'resumed', 'succeeded'], mails(mcp, first['id']))
    status, body = refused(f'/jobs/{first["id"]}/pause')
    check('a finished job cannot be paused', status >= 400 and 'Only a running job can be paused' in body, {'status': status, 'body': body[:300]})


def cancel_paused():
    cancelled, state = submit('cancel-while-paused')
    wait_for(lambda: job('cancel-while-paused'), lambda j: j['status'] == 'running')
    tree_running(state)
    check('cancel test: paused first', request(f'/jobs/{cancelled["id"]}/pause', {})['pause']['state'] == 'paused')
    request(f'/jobs/{cancelled["id"]}/cancel', {})
    done = terminal('cancel-while-paused', 40)
    check('cancelling a paused job ends cancelled and releases its reservation',
          done['status'] == 'cancelled' and not done['reserved'] and done['result']['evidence'].get('thawedToStop', {}).get('wasFrozen') is True,
          {'status': done['status'], 'thawed': done['result']['evidence'].get('thawedToStop')})
    terms = sorted(p.stem for p in state.glob('*.term'))
    check('its processes handled termination after the thaw', len(terms) == 5, terms)


def timeout_paused():
    timed, state = submit('timeout-while-paused', timeout=10)
    running = wait_for(lambda: job('timeout-while-paused'), lambda j: j['status'] == 'running')
    tree_running(state)
    check('timeout test: paused first', request(f'/jobs/{timed["id"]}/pause', {})['pause']['state'] == 'paused')
    done = terminal('timeout-while-paused', 60)
    began = running['result']['started']['at']
    took = done['result']['finishedAtUnix'] - began if done.get('result') else None
    check('the timeout still ends a paused job: failed, Result=timeout, near 10 s + 3 s',
          done['status'] == 'failed' and done['result']['evidence']['systemd']['Result'] == 'timeout' and took is not None and 10 <= took <= 20,
          {'status': done['status'], 'took': took})
    check('it did not run again before it was stopped', not list(state.glob('*.term')))


def gpu_device():
    """Pause GPU work on one device (T-106 admission + T-107 pause). The
    commands declare GPU memory but do not use the GPU; the GPU effect itself
    is gpu_yield.py's."""
    if os.environ.get('T107_NO_GPU'):
        return
    view = wait_for(lambda: request('/jobs/gpus'), lambda v: v.get('devices'), 30)
    uuid = view['devices'][0]['uuid']
    def device():
        return next(d for d in request('/jobs/gpus')['devices'] if d['uuid'] == uuid)
    request('/jobs/budget', {'cpuMillis': 1200, 'memoryMiB': 384, 'swapMiB': 0})
    held, state = submit('gpu-holder', gpu={'devices': [uuid], 'memoryMiB': 256})
    wait_for(lambda: job('gpu-holder'), lambda j: j['status'] == 'running')
    tree_running(state)
    waiting, _ = submit('gpu-waiter', code='print("ran")', gpu={'devices': [uuid], 'memoryMiB': 256})
    answer = request(f'/jobs/gpus/{uuid}/pause', {})
    now = device()
    check('pausing GPU work closes the GPU to new jobs and pauses the job on it',
          now['admission'] == 'closed' and now['closedReason'] == 'Paused by the user'
          and job('gpu-holder').get('pause', {}).get('state') == 'paused', {'device': now, 'answer': answer})
    ok, detail = still(state)
    check('the job on the GPU is frozen', ok, detail)
    time.sleep(4)
    check('a GPU job waiting for that GPU stays queued', job('gpu-waiter')['status'] == 'queued', job('gpu-waiter').get('reason'))
    request(f'/jobs/gpus/{uuid}/resume', {})
    now = device()
    check('resuming GPU work resumes the job and reopens the GPU the pause closed',
          now['admission'] == 'open' and 'pause' not in job('gpu-holder'), now)
    request(f'/jobs/{held["id"]}/cancel', {})
    terminal('gpu-holder', 40)
    check('the waiting GPU job then runs', terminal('gpu-waiter', 60)['status'] == 'succeeded')
    # A close the user made for a game is the user's: the pause keeps it, the resume leaves it.
    game, state = submit('gpu-game', gpu={'devices': [uuid], 'memoryMiB': 256})
    wait_for(lambda: job('gpu-game'), lambda j: j['status'] == 'running')
    tree_running(state)
    request(f'/jobs/gpus/{uuid}/admission', {'open': False, 'reason': 'A game is running'})
    request(f'/jobs/gpus/{uuid}/pause', {})
    paused_now = device()
    request(f'/jobs/gpus/{uuid}/resume', {})
    now = device()
    check("a user's own close survives a GPU pause and resume; only the job is paused and resumed",
          paused_now['closedReason'] == 'A game is running' and now['admission'] == 'closed'
          and now['closedReason'] == 'A game is running' and 'pause' not in job('gpu-game'), {'paused': paused_now, 'after': now})
    request(f'/jobs/gpus/{uuid}/admission', {'open': True})
    request(f'/jobs/{game["id"]}/cancel', {})
    terminal('gpu-game', 40)
    request('/jobs/budget', {'cpuMillis': 600, 'memoryMiB': 192, 'swapMiB': 0})


def main():
    out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else LAB
    LAB.mkdir(parents=True, mode=0o700)
    (LAB / 'work').mkdir()
    print(LAB, flush=True)
    try:
        start_core()
        request('/jobs/budget', {'cpuMillis': 600, 'memoryMiB': 192, 'swapMiB': 0})
        session = [MCP()]
        names = [t['name'] for t in session[0].rpc('tools/list', {})['tools']]
        check('Agents get no pause or resume tool', 'job_submit' in names and not {'job_pause', 'job_resume'} & set(names))
        for scenario in (lambda: pause_restart_resume(session), cancel_paused, timeout_paused, gpu_device):
            try:
                scenario()
            except Exception as error:
                check(f'scenario ran to completion ({error!r})'[:200], False, repr(error))
    finally:
        stop_core()
    report = {'lab': str(LAB), 'source': subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip(),
              'dirty': subprocess.run(['git', '-C', str(ROOT), 'status', '--porcelain', '--untracked-files=no'], capture_output=True, text=True).stdout,
              'jobs': JOBS, 'checks': CHECKS, 'passed': sum(c['ok'] for c in CHECKS), 'total': len(CHECKS)}
    out.mkdir(parents=True, exist_ok=True)
    (out / 'core-check.json').write_text(json.dumps(report, indent=1, default=str))
    print(f"{report['passed']}/{report['total']} passed; {out / 'core-check.json'}")
    sys.exit(0 if report['passed'] == report['total'] else 1)


if __name__ == '__main__':
    main()
