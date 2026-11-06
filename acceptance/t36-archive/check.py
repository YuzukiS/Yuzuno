#!/usr/bin/env python3
"""T-36 S2: releasing an executor whose work is still going, with real Jobs on
an isolated lab Core (local_jobs_lab, its stub Codex app-server). Never uses a
paid model or the daily Core.

- lab-a (Mori) leads the Project "Lab"; it dispatches T-2 from the "worker"
  template, and Core creates and starts the executor.
- The executor cannot set T-2 done, and asks the user a question on Home.
- A Job of the executor's runs and a second waits for the budget. lab-a
  releases it: the release is archiving, naming the running Job; the
  executor starts nothing new (job_submit refused) but can still comment,
  and its queued Job is held.
- The running Job ends: within seconds the executor is closed and released.
  The held Job is refused, saying it was released, and that result mail
  reaches lab-a, naming the executor as its original recipient.
- peer_send to the released executor is refused with executor_archived.
- Its Ask is lab-a's now: the user's Home reply, from a Home that still
  showed the executor, reaches lab-a, and lab-a resolves it.
- lab-a sets T-3 done, and T-3's executor is released with it.
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
# target/t36 unless the Job names its own path in T36_LAB_REPORT.
LAB = ROOT / 'target' / 't47' / ('lab-' + uuid.uuid4().hex[:10])
PORT = int(os.environ.get('T36_LAB_PORT', '4495'))
BASE = 'http://127.0.0.1:' + str(PORT)
CORE = None
REPORT = {'task': 'T-36 S2', 'checks': [], 'jobs': {}, 'reasons': {}, 'events': [], 'mail': {},
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


class MCP:
    """An Agent's MCP session, from the lab's connection for it."""

    def __init__(self, config):
        self.url, self.headers = config['url'], config['headers']
        self.headers = {**self.headers, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        self.seq = 0
        self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 't36-archive-acceptance', 'version': '1'}})
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

    def answer(self, tool, args):
        return self.rpc('tools/call', {'name': tool, 'arguments': args})

    def call(self, tool, args):
        value = self.answer(tool, args)
        assert not value.get('isError'), (tool, value)
        return value['structuredContent']

    def refused(self, tool, args, code):
        value = self.answer(tool, args)
        assert value.get('isError'), (tool, 'was answered', value)
        text = json.dumps(value)
        assert code in text, (tool, code, value)
        return (value.get('structuredContent') or {}).get('error') or text


def collaboration(operation, body):
    status, value = request('/collaboration/' + operation, body)
    assert status == 200, (operation, status, value)
    return value


def task(title, project):
    created = collaboration('task_create', {'requestId': str(uuid.uuid4()), 'title': title, 'projectId': project, 'status': 'doing'})
    return created['task']


def agent(agent_id):
    return next(a for a in get('/workspace')['agents'] if a['id'] == agent_id)


def dispatch(lead, t):
    answer = lead.call('task_dispatch', {'requestId': str(uuid.uuid4()), 'taskId': t['id'], 'expectedVersion': t['version'],
                                         'executor': {'templateId': 'worker'}})
    # Over MCP a task write answers with its short receipt: the executor is the task's assignee now.
    REPORT.setdefault('dispatches', []).append(answer)
    executor = answer.get('agentId') or answer['task']['assignee']['id']
    wait_for(lambda: agent(executor), lambda a: a.get('connectionState') == 'connected' and a.get('status') == 'idle',
             'the executor of ' + t['id'] + ' starts and finishes its dispatch turn', seconds=90)
    return executor


HOLD = """import pathlib,time
pathlib.Path("started-hold").write_text(str(time.time()))
while not pathlib.Path("stop-hold").exists(): time.sleep(0.2)
"""


def submit(name, executor, t, memory):
    body = {'requestId': str(uuid.uuid4()), 'taskId': t, 'agentId': executor, 'name': name,
            'cwd': str(LAB / 'work'), 'argv': ['/usr/bin/python3', '-u', '-c', HOLD], 'env': {}, 'guardGit': False,
            'resources': {'cpuMillis': 500, 'memoryMiB': memory, 'swapMiB': 0}, 'timeoutSeconds': 300}
    status, value = request('/jobs', body)
    assert status == 200, value
    REPORT['jobs'][name] = value['id']
    return value


def main():
    assert os.environ.get('XDG_RUNTIME_DIR') and os.environ.get('DBUS_SESSION_BUS_ADDRESS'), 'the user systemd manager is needed'
    LAB.mkdir(parents=True, mode=0o700)
    (LAB / 'work').mkdir()
    print(str(LAB), flush=True)
    try:
        start_core()
        request('/jobs/budget', {'cpuMillis': 4000, 'memoryMiB': 4096, 'swapMiB': 0})
        status, project = request('/projects', {'name': 'Lab', 'defaultDirs': {'local': str(LAB / 'work')}})
        assert status == 200, project
        p = project['id']
        assert request('/agents/lab-a/project', {'projectId': p})[0] == 200
        req = urllib.request.Request(BASE + '/api/projects/' + p + '/leads', method='PUT',
                                     data=json.dumps({'expectedVersion': 0, 'leadAgentIds': ['lab-a']}).encode(),
                                     headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
        urllib.request.urlopen(req, timeout=30).read()
        req = urllib.request.Request(BASE + '/api/executor-templates', method='PUT',
                                     data=json.dumps({'expectedVersion': 0, 'templates': [{'id': 'worker', 'label': 'Worker', 'harness': 'codex',
                                                                                           'instructions': 'Lab executor.'}]}).encode(),
                                     headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
        urllib.request.urlopen(req, timeout=30).read()
        lead = MCP(json.loads((LAB / 'connection.json').read_text()))
        t2, t3 = task('Release with a running Job', p), task('Released with its task done', p)
        executor = dispatch(lead, t2)
        REPORT['executor'] = executor
        exe = MCP(json.load(urllib.request.urlopen(BASE + '/lab/connection/' + executor, timeout=30)))
        check('lab-a, a lead of Lab, dispatched %s from a template; Core created and started its executor' % t2['id'])
        current = collaboration('task_get', {'taskId': t2['id']})['task']
        REPORT['reasons']['own done'] = exe.refused('task_update', {'requestId': 'done', 'taskId': t2['id'], 'expectedVersion': current['version'],
                                                                     'patch': {'status': 'done'}}, 'executor_done_refused')
        REPORT['reasons']['own done result'] = exe.refused('task_submit_result', {'requestId': 'done-result', 'taskId': t2['id'],
            'expectedVersion': current['version'], 'summary': 'Finished.', 'status': 'done'}, 'executor_done_refused')
        check('the executor cannot set its own task done, with task_update or with its result (executor_done_refused)')
        brief = exe.call('brief_get', {})
        exe.call('brief_update', {'requestId': 'ask', 'expectedVersion': brief['version'], 'changes': [{
            'op': 'put', 'key': 'question', 'kind': 'ask', 'title': 'Which way?',
            'body': {'root': 'body', 'elements': {'body': {'type': 'BriefBody', 'props': {}, 'children': ['note']},
                                                  'note': {'type': 'Markdown', 'props': {'text': 'Left or right?'}}}},
            'ask': {'question': 'Which way?', 'reply': {'options': [{'id': 'left', 'label': 'Left'}, {'id': 'right', 'label': 'Right'}], 'freeText': True}}}]})
        check('the executor asks the user on Home, as any member may')
        held = submit('hold', executor, t2['id'], 3000)
        wait_for(lambda: get('/jobs/' + held['id']), lambda j: j['status'] == 'running', 'its Job runs')
        later = submit('later', executor, t2['id'], 2000)
        wait_for(lambda: get('/jobs/' + later['id']), lambda j: j['status'] == 'queued' and 'Waiting for shared RAM' in (j['reason'] or ''),
                 'its second Job waits for the budget')
        note('release')
        released = lead.call('executor_release', {'requestId': 'release', 'agentId': executor})
        REPORT['release'] = released
        reason = (released.get('archiving') or {}).get('reason', '')
        assert reason == 'Waiting to close: a Job is still running: hold (%s).' % held['id'], released
        assert released.get('releasedAt') is None and agent(executor).get('closedAt') is None, released
        check('released while its Job runs, the executor is archiving: "%s"' % reason)
        REPORT['reasons']['job_submit while archiving'] = exe.refused('job_submit', {
            'requestId': 'more', 'taskId': t2['id'], 'name': 'more', 'cwd': str(LAB / 'work'), 'argv': ['/usr/bin/true'],
            'resources': {'cpuMillis': 100, 'memoryMiB': 64, 'swapMiB': 0}}, 'executor_archiving')
        exe.call('task_comment', {'requestId': 'note', 'taskId': t2['id'], 'body': 'Still finishing the Job.'})
        waiting = wait_for(lambda: get('/jobs/' + later['id']), lambda j: (j['reason'] or '').startswith('Held: its executor is being released'),
                           'its queued Job is held')
        REPORT['reasons']['held'] = waiting['reason']
        check('while archiving it starts nothing new (job_submit: executor_archiving), can still comment, and its queued Job is held')
        (LAB / 'work/stop-hold').write_text('go')
        ended = wait_for(lambda: get('/jobs/' + held['id']), lambda j: j['status'] in ('succeeded', 'failed', 'cancelled'), 'the Job ends')
        assert ended['status'] == 'succeeded', ended
        began = time.monotonic()
        closed = wait_for(lambda: agent(executor), lambda a: a.get('releasedAt'), 'the executor is released once its Job ended', seconds=30)
        REPORT['releasedAfterSeconds'] = round(time.monotonic() - began, 2)
        assert closed.get('closedAt') and closed.get('releasedBy') == 'agent:lab-a', closed
        check('its Job ended, and %.1f s later it is closed and released, as lab-a\'s release' % REPORT['releasedAfterSeconds'])
        refused = wait_for(lambda: get('/jobs/' + later['id']), lambda j: j['status'] == 'rejected', 'the held Job is refused')
        REPORT['reasons']['held refused'] = refused['reason']
        assert refused['reason'].startswith('Its executor was released before launch'), refused['reason']
        mail = wait_for(lambda: [m for m in lead.call('peer_read', {})['messages'] if m.get('jobId') == later['id']], bool,
                        'the held Job\'s result mail reaches lab-a')
        REPORT['mail']['redirected'] = mail[0]
        assert mail[0]['originalRecipient']['id'] == executor and mail[0]['recipient']['id'] == 'lab-a', mail[0]
        assert mail[0]['body'].startswith('Sent to %s, the archived executor of %s you dispatched' % (closed['name'], t2['id'])), mail[0]['body']
        check('the held Job is refused, saying its executor was released, and its result mail reaches lab-a, naming the executor')
        REPORT['reasons']['peer_send'] = lead.refused('peer_send', {'requestId': 'after', 'toAgentId': executor, 'body': 'One more thing'},
                                                      'executor_archived')
        check('peer_send to the released executor is refused with executor_archived')
        brief = lead.call('brief_get', {})
        section = next(s for s in brief['sections'] if s['key'] == 'question')
        REPORT['section'] = section.get('owner')
        assert section['owner']['agentId'] == 'lab-a', section.get('owner')
        workspace = get('/workspace')['workspace']['id']
        assert 'Which way?' not in json.dumps(get('/agents/lab-a')), 'lab-a has not seen the question before'
        status, receipt = request('/projects/' + p + '/brief/reply', {'key': 'question', 'agentId': executor, 'text': '', 'choice': 'left',
                                                                      'clientMessageId': 't36-home-reply-1', 'askVersion': section['version'],
                                                                      'workspaceId': workspace})
        assert status == 200, (status, receipt)
        wait_for(lambda: json.dumps(get('/agents/lab-a')), lambda text: 'Which way?' in text, 'the reply is in lab-a\'s conversation')
        brief = lead.call('brief_get', {})
        lead.call('brief_update', {'requestId': 'resolve', 'expectedVersion': brief['version'], 'changes': [{'op': 'resolve', 'key': 'question'}]})
        assert not [s for s in lead.call('brief_get', {})['sections'] if s['key'] == 'question'], 'resolved'
        check('its Ask is lab-a\'s now: the Home reply, from a Home that showed the executor, reaches lab-a, and lab-a resolves it')
        executor3 = dispatch(lead, t3)
        current = collaboration('task_get', {'taskId': t3['id']})['task']
        lead.call('task_update', {'requestId': 'done-t3', 'taskId': t3['id'], 'expectedVersion': current['version'], 'patch': {'status': 'done'}})
        done = wait_for(lambda: agent(executor3), lambda a: a.get('releasedAt'), 'T-3\'s executor is released with its task done', seconds=30)
        assert done.get('releasedBy') == 'agent:lab-a', done
        check('lab-a sets %s done, and its executor is released with it' % t3['id'])
        REPORT['passed'] = True
    finally:
        stop_core()
        for spec in (LAB / 'data/jobs').glob('*/spec.json'):
            saved = json.loads(spec.read_text())
            for key in ('supervisorUnit', 'unit'):
                subprocess.run(['systemctl', '--user', 'stop', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
                subprocess.run(['systemctl', '--user', 'reset-failed', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        out = Path(os.environ.get('T36_LAB_REPORT', str(ROOT / 'target' / 't36' / ('archive-report-' + LAB.name + '.json'))))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
        print(str(out), flush=True)


if __name__ == '__main__':
    sys.exit(main())
