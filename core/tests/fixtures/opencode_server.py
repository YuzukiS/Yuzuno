#!/usr/bin/env python3
"""A stand-in `opencode serve` with OpenCode 1.19.3's server shape, for
tests/opencode_transport.rs. It reads only its arguments and the environment
Core starts it with, and keeps its state in memory. It writes what it saw to
the folder of OPENCODE_DB (start.json, calls.jsonl), where a test may leave a
switch before it starts: `host` (the address it reports), `version` (the
version it reports), `exit` (exit before listening), `noise` (a long line
that is not UTF-8 before listening), `mcp` (the MCP status it reports) or
`stubborn` (it and a child of its own ignore SIGTERM).
Sessions and messages are kept in state.json there, as OpenCode keeps them
in its database; pending requests, as in OpenCode, live only in the process. Routes under
/__fixture/ are the test's own controls and need no password.
"""
import base64
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(os.environ['OPENCODE_DB']).parent
PASSWORD = os.environ.get('OPENCODE_SERVER_PASSWORD', '')
USERNAME = os.environ.get('OPENCODE_SERVER_USERNAME', 'opencode')
AUTHORIZATION = 'Basic ' + base64.b64encode(f'{USERNAME}:{PASSWORD}'.encode()).decode()

lock = threading.Lock()
counter = [0]
sessions, messages, statuses, permissions, questions, mcp = {}, {}, {}, [], [], {}
modes = {'prompt': 'store', 'mcp': 'connected', 'fail': {}, 'heartbeat': 0.2, 'abortEvidence': True, 'refuseEventsUntil': 0}
streams = []
generation = [0]  # a new generation ends every open event stream


def switch(name):
    path = ROOT / name
    return path.read_text().strip() if path.exists() else None


def new_id(prefix):
    with lock:
        counter[0] += 1
        return f'{prefix}_{counter[0]:06d}'


def publish(kind, properties):
    event = {'id': new_id('evt'), 'type': kind, 'properties': properties}
    with lock:
        for stream in streams:
            stream.put(event)


def log(entry):
    with lock, (ROOT / 'calls.jsonl').open('a') as out:
        out.write(json.dumps(entry) + '\n')


def save():
    with lock:
        (ROOT / 'state.json').write_text(json.dumps({'sessions': sessions, 'messages': messages, 'counter': counter[0]}))


def load():
    path = ROOT / 'state.json'
    if path.exists():
        state = json.loads(path.read_text())
        sessions.update(state['sessions'])
        messages.update(state['messages'])
        counter[0] = state['counter']


def store(session, message_id, text):
    info = {'id': message_id, 'sessionID': session, 'role': 'user', 'time': {'created': int(time.time() * 1000)}}
    message = {'info': info, 'parts': [{'id': new_id('prt'), 'sessionID': session, 'messageID': message_id,
                                         'type': 'text', 'text': text}]}
    with lock:
        # As in OpenCode, the same ID replaces the stored message.
        messages.setdefault(session, {})[message_id] = message
    save()
    publish('message.updated', {'sessionID': session, 'info': info})
    return message


def last_prompt(session):
    users = [m for m in messages.get(session, {}).values() if m['info']['role'] == 'user']
    return max(users, key=lambda m: m['info']['time']['created'])['info']['id'] if users else None


def answer_prompt(session, text=None, error=None, completed=True):
    """An assistant message answering the session's last prompt, with a text part."""
    now = int(time.time() * 1000)
    info = {'id': new_id('msg'), 'sessionID': session, 'role': 'assistant', 'parentID': last_prompt(session),
            'time': {'created': now}, 'finish': 'stop'}
    if completed:
        info['time']['completed'] = now
    if error:
        info['error'] = error
    parts = []
    if text is not None:
        parts.append({'id': new_id('prt'), 'sessionID': session, 'messageID': info['id'], 'type': 'text', 'text': text})
    with lock:
        messages.setdefault(session, {})[info['id']] = {'info': info, 'parts': parts}
    save()
    publish('message.updated', {'sessionID': session, 'info': info})
    for part in parts:
        publish('message.part.updated', {'sessionID': session, 'part': part, 'time': now})
    return info


def go_idle(session):
    statuses.pop(session, None)
    publish('session.status', {'sessionID': session, 'status': {'type': 'idle'}})


def without(pending, gone):
    pending[:] = [r for r in pending if all(r is not g for g in gone)]


def control(name, body):
    if name == 'mode':
        modes.update(body)
        return modes
    if name == 'ask':
        request = {'id': new_id('per'), 'sessionID': body['sessionID'], 'permission': 'bash', 'patterns': ['ls'],
                   'metadata': {}, 'always': ['ls *'], 'tool': {'messageID': 'msg_fixture', 'callID': 'call_1'}}
        with lock:
            permissions.append(request)
        publish('permission.asked', request)
        return request
    if name == 'question':
        request = {'id': new_id('que'), 'sessionID': body['sessionID'],
                   'questions': [{'question': 'Which one?', 'header': 'Pick',
                                  'options': [{'label': 'A', 'description': 'the first'}]}]}
        with lock:
            questions.append(request)
        publish('question.asked', request)
        return request
    if name == 'busy':
        statuses[body['sessionID']] = {'type': 'busy'}
        publish('session.status', {'sessionID': body['sessionID'], 'status': {'type': 'busy'}})
        return True
    if name == 'event':
        publish(body['type'], body['properties'])
        return True
    if name == 'store':
        return store(body['sessionID'], body['messageID'], body.get('text', ''))
    if name == 'reply':
        info = answer_prompt(body['sessionID'], body.get('text'), body.get('error'), body.get('completed', True))
        if body.get('idle', True):
            go_idle(body['sessionID'])
        return info
    if name == 'idle':
        go_idle(body['sessionID'])
        return True
    if name == 'error':
        # As OpenCode's session.error: it names no message.
        publish('session.error', {'sessionID': body['sessionID'],
                                  'error': {'name': 'UnknownError', 'data': {'message': 'fixture: session error'}}})
        return True
    if name == 'die':
        threading.Timer(0.1, lambda: os._exit(9)).start()
        return True
    if name == 'refuseEvents':
        modes['refuseEventsUntil'] = time.time() + body['seconds']
        return True
    if name == 'print':
        # Output that is not UTF-8, more than a pipe holds; it fails if Core stopped draining.
        sys.stdout.buffer.write(b'\xff' * body['bytes'] + b'\n')
        sys.stdout.buffer.flush()
        return True
    if name == 'drop':
        with lock:
            generation[0] += 1
        return True
    raise ValueError(name)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.route('GET')

    def do_POST(self):
        self.route('POST')

    def do_PATCH(self):
        self.route('PATCH')

    def do_DELETE(self):
        self.route('DELETE')

    def reply(self, code, value=None):
        data = b'' if value is None else json.dumps(value).encode()
        self.send_response(code)
        if code == 401:
            self.send_header('www-authenticate', 'Basic realm="Secure Area"')
        if value is not None:
            self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def missing(self, what):
        return self.reply(404, {'name': 'NotFoundError', 'data': {'message': f'{what} not found'}})

    def route(self, method):
        url = urlsplit(self.path)
        length = int(self.headers.get('content-length') or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        parts = [p for p in url.path.split('/') if p]
        if parts[:1] == ['__fixture']:
            return self.reply(200, control(parts[1], body or {}))
        authorized = self.headers.get('authorization') == AUTHORIZATION
        log({'method': method, 'path': url.path, 'query': parse_qs(url.query), 'body': body, 'authorized': authorized})
        if not authorized:
            return self.reply(401)
        if url.path in modes['fail']:
            return self.reply(modes['fail'][url.path], {'name': 'UnknownError', 'data': {'message': 'fixture failure'}})
        key = (method, *parts)
        if key == ('GET', 'global', 'health'):
            return self.reply(200, {'healthy': True, 'version': switch('version') or '1.19.3'})
        if key == ('GET', 'event'):
            if time.time() < modes['refuseEventsUntil']:
                return self.reply(503, {'name': 'UnknownError', 'data': {'message': 'fixture: not now'}})
            return self.stream()
        if key == ('POST', 'session'):
            session = {'id': new_id('ses'), 'title': (body or {}).get('title', ''),
                       'directory': parse_qs(url.query).get('directory', [''])[0]}
            sessions[session['id']] = session
            save()
            publish('session.created', {'sessionID': session['id'], 'info': session})
            return self.reply(200, session)
        if key == ('GET', 'session', 'status'):
            return self.reply(200, statuses)
        if key == ('GET', 'permission'):
            return self.reply(200, permissions)
        if key == ('GET', 'question'):
            return self.reply(200, questions)
        if key == ('GET', 'mcp'):
            return self.reply(200, mcp)
        if key == ('POST', 'mcp'):
            status = {'status': modes['mcp']}
            if modes['mcp'] == 'failed':
                status['error'] = 'fixture: connection refused'
            mcp[body['name']] = status
            return self.reply(200, {body['name']: status})
        if len(parts) >= 2 and parts[0] == 'session':
            return self.session(method, parts[1], parts[2:], body)
        if method == 'POST' and len(parts) == 3 and parts[0] == 'permission' and parts[2] == 'reply':
            return self.answer(permissions, parts[1], body['reply'], body)
        if method == 'POST' and len(parts) == 3 and parts[0] == 'question' and parts[2] in ('reply', 'reject'):
            return self.answer(questions, parts[1], parts[2], body)
        return self.missing(url.path)

    def session(self, method, session, rest, body):
        if session not in sessions:
            return self.missing(f'Session {session}')
        if (method, *rest) == ('GET',):
            return self.reply(200, sessions[session])
        if (method, *rest) == ('POST', 'prompt_async'):
            return self.prompt(session, body)
        if (method, *rest) == ('GET', 'message'):
            stored = sorted(messages.get(session, {}).values(), key=lambda m: m['info']['time']['created'])
            return self.reply(200, stored)
        if method == 'GET' and len(rest) == 2 and rest[0] == 'message':
            found = messages.get(session, {}).get(rest[1])
            return self.reply(200, found) if found else self.missing(f'Message {rest[1]}')
        if (method, *rest) == ('POST', 'abort'):
            # The run ends; its pending requests go with it, and (as OpenCode
            # does) its answer is marked aborted.
            running = session in statuses
            with lock:
                without(permissions, [p for p in permissions if p['sessionID'] == session])
                without(questions, [q for q in questions if q['sessionID'] == session])
            self.reply(200, True)
            if running and modes['abortEvidence']:
                answer_prompt(session, error={'name': 'MessageAbortedError', 'data': {'message': 'The operation was aborted.'}})
            go_idle(session)
            return None
        return self.missing('/'.join(rest))

    def prompt(self, session, body):
        message_id = body.get('messageID') or new_id('msg')
        text = ''.join(p.get('text', '') for p in body.get('parts', []))
        mode = modes['prompt']
        if mode == 'store':
            store(session, message_id, text)
            self.reply(204)
            # The run starts: OpenCode is busy until it ends.
            statuses[session] = {'type': 'busy'}
            publish('session.status', {'sessionID': session, 'status': {'type': 'busy'}})
            return None
        if mode == 'unstored':
            # Answered, then storing failed; OpenCode's session.error names no message.
            self.reply(204)
            publish('session.error', {'sessionID': session,
                                      'error': {'name': 'UnknownError', 'data': {'message': 'fixture: not stored'}}})
            return None
        if mode == 'error':
            return self.reply(500, {'name': 'UnknownError', 'data': {'message': 'fixture failure'}})
        if mode == 'store-then-drop':
            store(session, message_id, text)
        # store-then-drop and drop: the connection ends without an answer.
        self.close_connection = True
        return None

    def answer(self, pending, request_id, reply, body):
        with lock:
            found = next((r for r in pending if r['id'] == request_id), None)
            # OpenCode: rejecting a permission rejects the rest pending in its session.
            cascade = found is not None and pending is permissions and reply == 'reject'
            gone = [r for r in pending if r is found or (cascade and r['sessionID'] == found['sessionID'])]
            without(pending, gone)
        if found is None:
            return self.missing(f'Request {request_id}')
        for request in gone:
            properties = {'sessionID': request['sessionID'], 'requestID': request['id']}
            if pending is permissions:
                publish('permission.replied', {**properties, 'reply': reply if request is found else 'reject'})
            elif reply == 'reply':
                publish('question.replied', {**properties, 'answers': body['answers']})
            else:
                publish('question.rejected', properties)
        return self.reply(200, True)

    def stream(self):
        mine = queue.Queue()
        with lock:
            streams.append(mine)
            current = generation[0]
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('cache-control', 'no-cache')
        self.end_headers()
        self.close_connection = True

        def send(event):
            self.wfile.write(b'data: ' + json.dumps(event).encode() + b'\n\n')
            self.wfile.flush()

        try:
            # As in OpenCode, the subscriber exists before server.connected.
            send({'id': new_id('evt'), 'type': 'server.connected', 'properties': {}})
            beat = time.monotonic()
            while generation[0] == current:
                try:
                    send(mine.get(timeout=0.02))
                except queue.Empty:
                    pass
                every = modes['heartbeat']
                if every and time.monotonic() - beat >= every:
                    send({'id': new_id('evt'), 'type': 'server.heartbeat', 'properties': {}})
                    beat = time.monotonic()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with lock:
                streams.remove(mine)


def main():
    argv = sys.argv[1:]
    load()
    modes['mcp'] = switch('mcp') or 'connected'
    # Stands in for OpenCode's own children (language servers, MCP servers).
    child = subprocess.Popen(['sleep', '600'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
    seen = {'argv': argv, 'cwd': os.getcwd(), 'pid': os.getpid(), 'pgid': os.getpgid(0), 'child': child.pid,
            'database': os.environ.get('OPENCODE_DB'), 'username': USERNAME, 'passwordLength': len(PASSWORD),
            'passwordInArgv': bool(PASSWORD) and any(PASSWORD in arg for arg in argv)}
    if switch('stubborn'):
        # As a server, or a tool it runs, that does not stop on SIGTERM.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        seen['stubborn'] = subprocess.Popen(
            [sys.executable, '-c', 'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(600)'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).pid
    if switch('exit'):
        (ROOT / 'start.json').write_text(json.dumps(seen))
        sys.exit(3)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    seen['port'] = server.server_address[1]
    (ROOT / 'start.json').write_text(json.dumps(seen))
    if switch('noise'):
        # A line longer than Core reads at once, and not UTF-8.
        sys.stdout.buffer.write(b'\xfe' * 100_000 + b'\n')
    print('INFO fixture starting', flush=True)
    print(f'opencode server listening on http://{switch("host") or "127.0.0.1"}:{seen["port"]}', flush=True)
    server.serve_forever()


main()
