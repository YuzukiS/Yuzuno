#!/usr/bin/env python3
"""T-170: a lab Core with the phone entry, for a phone through Tailscale Serve.

    python3 acceptance/t170/lab.py --core BIN --web DIST --dir LAB \
        --port 4419 --remote-port 4318 --origin https://<node>:8444 --login <login> \
        (--verify | --hold MINUTES)

It never touches the daily Core or its data: its own ports (never 4317), a
new data folder under LAB, and the scripted Codex stand-in
acceptance/turn-cost/fake_codex.py instead of a model.

It seeds a synthetic Workspace: a project, one Agent with a finished
conversation, a native command approval waiting for an answer, and on Home a
status section and an Ask written through the Agent's own MCP brief_update.
The stand-in raises native approvals only; a native question typed into a
text field (requestUserInput) is not covered, and nothing here is a real
Codex or Claude session.

--verify plays Serve's part on the remote port, with the headers Serve 1.102.4
sends (from its source): the page, the API, live events, answering the
approval, a message, a reply to the Ask, the refusals, and the local port
refusing a proxied request. It does not go through Serve.

--hold keeps the lab up for a person with a phone, until MINUTES pass or
LAB/stop exists; LAB/again raises another approval (the stand-in waits 600 s
for each). Core is stopped at the end; LAB keeps its data and report.
"""
import argparse
import hashlib
import http.client
import json
import os
import pathlib
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
FAKE_CODEX = ROOT / 'acceptance/turn-cost/fake_codex.py'
DAILY_PORT = 4317


def sha256(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def tree_sha256(root):
    """One digest for a folder: its files' relative paths and digests."""
    root = pathlib.Path(root)
    lines = [f'{p.relative_to(root)} {sha256(p)}' for p in sorted(root.rglob('*')) if p.is_file()]
    return hashlib.sha256('\n'.join(lines).encode()).hexdigest(), len(lines)


def free(port):
    with socket.socket() as s:
        try:
            s.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


class Lab:
    def __init__(self, a):
        self.a = a
        self.dir = pathlib.Path(a.dir).resolve()
        self.authority = urllib.parse.urlsplit(a.origin).netloc
        self.report = {'startedAt': time.time(), 'checks': [], 'facts': {}}
        self.core = None

    def check(self, name, ok, fact=None):
        self.report['checks'].append({'name': name, 'ok': bool(ok), **({'fact': fact} if fact is not None else {})})
        print(('PASS ' if ok else 'FAIL ') + name, flush=True)
        return ok

    def save(self):
        (self.dir / 'report.json').write_text(json.dumps(self.report, indent=1))

    # ---- HTTP ---------------------------------------------------------------
    def call(self, port, method, path, body=None, headers=None, timeout=15):
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
        data = None if body is None else json.dumps(body).encode()
        conn.request(method, path, body=data, headers=headers or {})
        response = conn.getresponse()
        text = response.read().decode(errors='replace')
        conn.close()
        return response.status, text

    def local(self, method, path, body=None):
        status, text = self.call(self.a.port, method, path, body, {
            'Host': f'127.0.0.1:{self.a.port}', 'X-Yuzuno-Client': 'desktop', 'Content-Type': 'application/json'})
        if status >= 400:
            raise RuntimeError(f'{method} {path}: {status} {text[:300]}')
        return json.loads(text) if text else {}

    def remote_headers(self, write=False, **extra):
        headers = {'Host': self.authority, 'Tailscale-User-Login': self.a.login}
        if write:
            headers.update({'Origin': self.a.origin, 'X-Yuzuno-Client': 'desktop', 'Content-Type': 'application/json'})
        headers.update(extra)
        return {k: v for k, v in headers.items() if v is not None}

    def remote(self, method, path, body=None, **extra):
        return self.call(self.a.remote_port, method, path, body,
                         self.remote_headers(write=method not in ('GET', 'HEAD'), **extra))

    # ---- Core ---------------------------------------------------------------
    def start(self):
        a = self.a
        for port in (a.port, a.remote_port):
            if port == DAILY_PORT:
                raise SystemExit(f'Port {port} is the daily Core\'s; choose another')
            if not free(port):
                raise SystemExit(f'Port {port} is in use on 127.0.0.1; nothing was started')
        if (self.dir / 'data').exists():
            raise SystemExit(f'{self.dir}/data exists: use a new LAB folder')
        for sub in ('data', 'task', 'timeline'):
            (self.dir / sub).mkdir(parents=True)
        web_digest, web_files = tree_sha256(a.web)
        self.report['facts']['sources'] = {
            'core': {'path': str(pathlib.Path(a.core).resolve()), 'sha256': sha256(a.core)},
            'web': {'path': str(pathlib.Path(a.web).resolve()), 'treeSha256': web_digest, 'files': web_files},
            'fakeCodex': {'path': str(FAKE_CODEX), 'sha256': sha256(FAKE_CODEX)},
            'sourceCommit': a.source_commit,
        }
        env = dict(os.environ, YUZUNO_REMOTE_PORT=str(a.remote_port), YUZUNO_REMOTE_ORIGIN=a.origin,
                   YUZUNO_REMOTE_LOGIN=a.login, T9_TIMELINE=str(self.dir / 'timeline'))
        log = (self.dir / 'core.log').open('ab')
        self.core = subprocess.Popen(
            [a.core, '--port', str(a.port), '--data-dir', str(self.dir / 'data'), '--web-dir', a.web,
             '--cwd', str(self.dir / 'task'), '--codex', str(FAKE_CODEX)],
            env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(200):
            try:
                self.local('GET', '/api/health')
                break
            except (OSError, RuntimeError):
                if self.core.poll() is not None:
                    raise RuntimeError('Core exited: ' + (self.dir / 'core.log').read_text()[-1500:])
                time.sleep(0.1)
        else:
            raise RuntimeError('Core did not answer')
        self.check('the lab Core started on its own ports with the remote entry',
                   'Remote entry: http://127.0.0.1:%d' % a.remote_port in (self.dir / 'core.log').read_text())

    def stop(self):
        if self.core and self.core.poll() is None:
            os.killpg(self.core.pid, signal.SIGTERM)
            try:
                self.core.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(self.core.pid, signal.SIGKILL)
                self.core.wait(timeout=5)
        self.report['facts']['coreStopped'] = self.core is None or self.core.poll() is not None

    # ---- Synthetic Workspace -------------------------------------------------
    def agent(self):
        return self.local('GET', f'/api/agents/{self.agent_id}')

    def wait(self, test, what, seconds=60):
        end = time.time() + seconds
        while time.time() < end:
            value = test()
            if value:
                return value
            time.sleep(0.3)
        raise RuntimeError(f'Timed out waiting for {what}')

    def send(self, text):
        self.local('POST', f'/api/agents/{self.agent_id}/messages', {'clientMessageId': str(uuid.uuid4()), 'text': text})

    def completed(self):
        return sum(1 for turn in self.agent().get('turns', []) if turn.get('status') == 'completed')

    def finished(self, before):
        """Waits until a Turn more than `before` has completed and the Agent is idle."""
        return self.wait(lambda: self.completed() > before and self.agent()['agent']['status'] == 'idle',
                         'the Turn to complete')

    def run(self, text):
        before = self.completed()
        self.send(text)
        self.finished(before)

    def pending(self):
        return self.wait(lambda: self.agent()['pending'], 'a pending approval')

    def mcp(self, method, params):
        with sqlite3.connect(f'file:{self.dir / "data/workspace.sqlite"}?mode=ro', uri=True) as db:
            token = db.execute('SELECT value FROM workspace_meta WHERE key = ?',
                               (f'collaboration.mcp.agent.{self.agent_id}',)).fetchone()[0]
        status, text = self.call(self.a.port, 'POST', f'/mcp/{self.agent_id}',
                                 {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params},
                                 {'Host': f'127.0.0.1:{self.a.port}', 'Content-Type': 'application/json',
                                  'Accept': 'application/json, text/event-stream', 'Authorization': f'Bearer {token}',
                                  'MCP-Protocol-Version': '2025-03-26'})
        if text.startswith(('data:', 'event:')):
            text = next(line[5:] for line in text.splitlines() if line.startswith('data:'))
        value = json.loads(text)
        if status != 200 or value.get('error'):
            raise RuntimeError(f'MCP {method}: {status} {text[:300]}')
        return value['result'].get('structuredContent', value['result'])

    def seed(self):
        self.project_id = self.local('POST', '/api/projects', {'name': 'Phone check'})['id']
        self.agent_id = self.local('POST', '/api/agents', {
            'name': 'Phone check', 'cwd': str(self.dir / 'task'), 'harness': 'codex', 'model': 'bench-model',
            'projectId': self.project_id})['id']
        self.wait(lambda: self.agent()['agent'].get('connectionState') == 'connected', 'the Agent to connect')
        self.run('warmup:3:2')
        self.run('run:40:2:0:20')
        self.send('run:4:0:1:0')
        request = self.pending()[0]
        body = lambda text: {'root': 'body', 'elements': {
            'body': {'type': 'BriefBody', 'props': {}, 'children': ['text']},
            'text': {'type': 'Markdown', 'props': {'text': text}}}}
        brief = self.mcp('tools/call', {'name': 'brief_get', 'arguments': {}})
        self.mcp('tools/call', {'name': 'brief_update', 'arguments': {
            'requestId': 'lab-seed', 'expectedVersion': brief['version'], 'changes': [
                {'op': 'put', 'key': 'phone-status', 'kind': 'status', 'title': 'Phone check status',
                 'body': body('A synthetic status section, written by the lab Agent.'),
                 'status': {'asOf': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'validFor': 7200}},
                {'op': 'put', 'key': 'phone-ask', 'kind': 'ask', 'title': 'Phone check question',
                 'body': body('Reply from the phone to check Home replies.'),
                 'ask': {'question': 'Does this read well on the phone?', 'reply': {'freeText': True}}}]}})
        self.report['facts']['seed'] = {'projectId': self.project_id, 'agentId': self.agent_id,
                                        'pendingRequest': request['id']}
        (self.dir / 'lab.json').write_text(json.dumps({
            'localUrl': f'http://127.0.0.1:{self.a.port}', 'remotePort': self.a.remote_port,
            'origin': self.a.origin, **self.report['facts']['seed']}, indent=1))
        self.check('the synthetic Workspace is seeded: a conversation, a pending approval, a Home status and Ask', True)

    # ---- Serve's part, on the remote port ------------------------------------
    def verify(self):
        a = self.a
        status, text = self.remote('GET', '/')
        self.check('the page loads through the remote entry', status == 200 and 'id="root"' in text, status)
        status, _ = self.remote('GET', '/api/health')
        self.check('the API answers through the remote entry', status == 200, status)
        status, text = self.remote('GET', '/api/home')
        self.check('Home and its Ask read through the remote entry', status == 200 and 'phone-ask' in text, status)

        events = http.client.HTTPConnection('127.0.0.1', a.remote_port, timeout=15)
        events.request('GET', '/api/events', headers=self.remote_headers(Accept='text/event-stream'))
        stream = events.getresponse()
        # The raw stream is chunked: read on to the first event itself.
        first = ''
        end = time.time() + 10
        while time.time() < end and not first.startswith('data:'):
            first = stream.fp.readline().decode()
        self.check('live events open through the remote entry', stream.status == 200
                   and stream.getheader('content-type') == 'text/event-stream' and first.startswith('data:'),
                   first.strip()[:120])

        request = self.agent()['pending'][0]['id']
        before = self.completed()
        status, text = self.remote('POST', f'/api/requests/{request}/respond', {'response': {'decision': 'accept'}})
        self.check('a native approval is answered through the remote entry', status == 200, (status, text[:200]))
        got = []
        end = time.time() + 15
        while time.time() < end and not any('agent.' in line for line in got):
            line = stream.fp.readline().decode()
            if line.startswith('data:'):
                got.append(line[5:].strip()[:120])
        events.close()
        self.check('live events stream what the answer changed', any('agent.' in line for line in got), got[:5])
        self.finished(before)

        before = self.completed()
        status, text = self.remote('POST', f'/api/agents/{self.agent_id}/messages',
                                   {'clientMessageId': str(uuid.uuid4()), 'text': 'run:10:0:0:20'})
        receipt = json.loads(text) if status == 200 else {}
        self.check('a message is sent through the remote entry and has its receipt',
                   status == 200 and receipt.get('status') in ('accepted', 'queued'), (status, receipt.get('status')))
        self.finished(before)
        status, text = self.remote('POST', f'/api/projects/{self.project_id}/brief/reply', {
            'key': 'phone-ask', 'agentId': self.agent_id, 'text': 'Reads well.', 'clientMessageId': str(uuid.uuid4())})
        self.check('the Home Ask is replied to through the remote entry', status == 200, (status, text[:200]))

        refused = {
            'no login (a tagged node, the host itself)': self.remote('GET', '/api/health', **{'Tailscale-User-Login': None})[0],
            'another login': self.remote('GET', '/api/health', **{'Tailscale-User-Login': 'visitor@example.org'})[0],
            'another host': self.remote('GET', '/api/health', Host=f'127.0.0.1:{a.remote_port}')[0],
            'Funnel': self.remote('GET', '/api/health', **{'Tailscale-Funnel-Request': '?1'})[0],
            'a change without the page Origin': self.remote('POST', f'/api/agents/{self.agent_id}/review',
                                                            {'throughSeq': 0}, Origin=None)[0],
        }
        self.check('the remote entry refuses anyone else', all(s == 403 for s in refused.values()), refused)
        plain = self.call(a.port, 'GET', '/api/health', headers={'Host': f'127.0.0.1:{a.port}'})[0]
        proxied = self.call(a.port, 'GET', '/api/health', headers={'Host': f'127.0.0.1:{a.port}',
                                                                    'X-Forwarded-For': '100.64.0.9'})[0]
        self.check('the local port is unchanged and refuses a proxied request', plain == 200 and proxied == 403,
                   {'plain': plain, 'proxied': proxied})

    def hold(self, minutes):
        end = time.time() + minutes * 60
        print(f'Lab up: open {self.a.origin} on the phone. Stop: touch {self.dir}/stop', flush=True)
        while time.time() < end and not (self.dir / 'stop').exists():
            if (self.dir / 'again').exists():
                (self.dir / 'again').unlink()
                if self.agent()['agent']['status'] == 'idle':
                    self.send('run:4:0:1:0')
                    print('Another approval is waiting', flush=True)
            if self.core.poll() is not None:
                self.check('the lab Core kept running', False, self.core.returncode)
                return
            time.sleep(2)
        self.check('the lab ran until it was stopped', True, {'stopFile': (self.dir / 'stop').exists()})


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--core', required=True)
    p.add_argument('--web', required=True)
    p.add_argument('--dir', required=True)
    p.add_argument('--port', type=int, required=True)
    p.add_argument('--remote-port', type=int, required=True)
    p.add_argument('--origin', required=True)
    p.add_argument('--login', required=True)
    p.add_argument('--source-commit', default=None)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--verify', action='store_true')
    mode.add_argument('--hold', type=float, metavar='MINUTES')
    lab = Lab(p.parse_args())
    try:
        lab.start()
        lab.seed()
        lab.verify() if lab.a.verify else lab.hold(lab.a.hold)
    except Exception as error:
        lab.check('the run completed', False, f'{type(error).__name__}: {error}')
    finally:
        lab.stop()
        lab.report['finishedAt'] = time.time()
        lab.report['passed'] = all(c['ok'] for c in lab.report['checks'])
        lab.save()
        print('passed', lab.report['passed'], flush=True)
    sys.exit(0 if lab.report['passed'] else 1)


if __name__ == '__main__':
    main()
