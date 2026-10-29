#!/usr/bin/env python3
"""A stand-in `opencode serve` with OpenCode 1.19.3's server shape, for
tests/opencode_transport.rs. It reads only its arguments and the environment
Core starts it with, and keeps its state in memory. It writes what it saw to
the folder of OPENCODE_DB (start.json, calls.jsonl), where a test may leave a
switch before it starts: `host` (the address it reports), `version` (the
version it reports), `exit` (exit before listening), `noise` (a long line
that is not UTF-8 before listening), `mcp` (the MCP status it reports),
`stubborn` (it and a child of its own ignore SIGTERM), `tool` (it starts a
process in a session of its own, as OpenCode's tools run, which only
/global/dispose ends) or `dispose` (`refuse`: it answers that with 500;
`hang`: it answers only after 30 s, ending nothing).
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

# What `GET /config/providers` answers (T-10): OpenCode's configured providers,
# each with the fields that can hold credentials (`key`, `options`, `env`, and
# a model's `options` and `headers`), here fake; `mode` replaces it.
SECRETS = ['fixture-secret-key', 'fixture-secret-option', 'fixture-secret-header', 'FIXTURE_SECRET_ENV']


def model(provider, id, name, status='active', variants=None):
    return {'id': id, 'providerID': provider, 'name': name, 'status': status, 'release_date': '2026-01-01',
            **({'variants': variants} if variants is not None else {}),
            'api': {'id': id, 'url': 'https://api.example.invalid', 'npm': '@ai-sdk/openai-compatible'},
            'capabilities': {}, 'cost': {'input': 0, 'output': 0}, 'limit': {'context': 1000, 'output': 100},
            'options': {'apiKey': SECRETS[1]}, 'headers': {'Authorization': f'Bearer {SECRETS[2]}'}}


PROVIDERS = {'providers': [
    {'id': 'openrouter', 'name': 'OpenRouter', 'source': 'config', 'env': [SECRETS[3]], 'key': SECRETS[0],
     'options': {'apiKey': SECRETS[1]}, 'models': {'anthropic/claude-x': model('openrouter', 'anthropic/claude-x', 'Claude X', 'beta')}},
    {'id': 'deepseek', 'name': 'DeepSeek', 'source': 'api', 'env': [SECRETS[3]], 'key': SECRETS[0],
     'options': {'baseURL': 'https://api.example.invalid', 'apiKey': SECRETS[1]},
     'models': {'deepseek-flash': model('deepseek', 'deepseek-flash', 'DeepSeek Flash', variants={
         'max': {'thinking': {'budgetTokens': 32000}, 'apiKey': SECRETS[1]}, 'high': {'reasoningEffort': 'high'}})}},
], 'default': {'openrouter': 'anthropic/claude-x', 'deepseek': 'deepseek-flash'}}

# What `GET /config` answers (T-10): OpenCode's whole configuration. As in
# OpenCode it holds provider keys and options (here fake) beside the commands
# (`command`), whose templates may hold paths and shell lines; one command
# names a model of its own and one an agent that does. `mode` replaces it.
TEMPLATE_SECRET = 'fixture-template-secret'
CONFIG = {
    '$schema': 'https://opencode.ai/config.json',
    'provider': {'deepseek': {'options': {'apiKey': SECRETS[1], 'headers': {'Authorization': f'Bearer {SECRETS[2]}'}}}},
    'agent': {'reviewer': {'model': 'deepseek/deepseek-flash', 'mode': 'subagent', 'prompt': f'Read /home/example/{TEMPLATE_SECRET}'}},
    'command': {
        'explain': {'template': 'Explain $1 briefly.', 'description': 'Explain one thing'},
        'review': {'template': f'Review $ARGUMENTS against /home/example/{TEMPLATE_SECRET}/rules.md', 'description': 'Review\na change'},
        'status': {'template': f'!`cat /home/example/{TEMPLATE_SECRET}` Summarise the status.'},
        'pinned': {'template': 'Answer as the pinned model.', 'description': 'Uses its own model', 'model': 'openrouter/anthropic/claude-x'},
        'delegate': {'template': 'Investigate $ARGUMENTS', 'description': 'Ask a sub-agent', 'agent': 'reviewer', 'subtask': True},
    },
}

lock = threading.Lock()
counter = [0]
sessions, messages, statuses, permissions, questions, mcp = {}, {}, {}, [], [], {}
modes = {'prompt': 'store', 'mcp': 'connected', 'fail': {}, 'heartbeat': 0.2, 'abortEvidence': True,
         'abortOrder': 'answer-first', 'refuseEventsUntil': 0, 'providers': PROVIDERS, 'config': CONFIG,
         'command': 'run'}
streams = []
generation = [0]  # a new generation ends every open event stream
tools = []


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


def store(session, message_id, text, files=(), announce=True):
    info = {'id': message_id, 'sessionID': session, 'role': 'user', 'time': {'created': int(time.time() * 1000)}}
    message = {'info': info, 'parts': [{'id': new_id('prt'), 'sessionID': session, 'messageID': message_id,
                                         'type': 'text', 'text': text}]}
    # A file part as OpenCode stores one sent inline: its `data:` URL kept as it is.
    message['parts'] += [{'id': new_id('prt'), 'sessionID': session, 'messageID': message_id, **f} for f in files]
    with lock:
        # As in OpenCode, the same ID replaces the stored message.
        messages.setdefault(session, {})[message_id] = message
    save()
    if not announce:
        # Stored, with no event Core sees (as when its stream missed them).
        return message
    publish('message.updated', {'sessionID': session, 'info': info})
    # As OpenCode 1.19.3 saves a prompt (`createUserMessage`): each part
    # follows, whole, a file part's `data:` URL included.
    for part in message['parts']:
        publish('message.part.updated', {'sessionID': session, 'part': part, 'time': info['time']['created']})
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
    if name == 'child':
        # As OpenCode 1.19.3's task tool starts a sub-agent: a session of its
        # own under the one that called it (`parentID`), announced as created.
        session = {'id': new_id('ses'), 'parentID': body['parentID'], 'title': body.get('title', ''),
                   'agent': body.get('agent'), 'directory': ''}
        with lock:
            sessions[session['id']] = session
        save()
        if body.get('announce', True):
            publish('session.created', {'sessionID': session['id'], 'info': session})
        return session
    if name == 'close':
        # A session's run ending: its pending requests go, and nothing says so.
        with lock:
            without(permissions, [r for r in permissions if r['sessionID'] == body['sessionID']])
            without(questions, [r for r in questions if r['sessionID'] == body['sessionID']])
        return True
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
                                  'error': {'name': body.get('name', 'UnknownError'),
                                            'data': {'message': body.get('message', 'fixture: session error')}}})
        return True
    if name == 'halt':
        # As OpenCode 1.19.3's processor halts a run with an error: the
        # session error and idle first, the answer carrying it only after its
        # cleanup, then the runner's own idle.
        error = {'name': body['name'], 'data': {'message': body.get('message', 'fixture: halted')}}
        publish('session.error', {'sessionID': body['sessionID'], 'error': error})
        go_idle(body['sessionID'])
        answer_prompt(body['sessionID'], error=error)
        go_idle(body['sessionID'])
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
        if key == ('POST', 'global', 'dispose'):
            return self.dispose()
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
        if key == ('GET', 'config', 'providers'):
            return self.reply(200, modes['providers'])
        if key == ('GET', 'config'):
            return self.reply(200, modes['config'])
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
        if (method, *rest) == ('GET', 'children'):
            return self.reply(200, [s for s in sessions.values() if s.get('parentID') == session])
        if (method, *rest) == ('POST', 'prompt_async'):
            return self.prompt(session, body)
        if (method, *rest) == ('POST', 'command'):
            return self.run_command(session, body)
        if (method, *rest) == ('GET', 'message'):
            stored = sorted(messages.get(session, {}).values(), key=lambda m: m['info']['time']['created'])
            return self.reply(200, stored)
        if method == 'GET' and len(rest) == 2 and rest[0] == 'message':
            if modes.get('failMessageReads'):
                return self.reply(500, {'name': 'UnknownError', 'data': {'message': 'fixture: message read failed'}})
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
            aborted = {'name': 'MessageAbortedError', 'data': {'message': 'The operation was aborted.'}}
            if running and modes['abortEvidence'] and modes['abortOrder'] == 'native':
                # As OpenCode 1.19.3's processor halts an aborted run: the
                # session error and idle first, the aborted answer only after
                # its cleanup, then the runner's own idle.
                publish('session.error', {'sessionID': session, 'error': aborted})
                go_idle(session)
                answer_prompt(session, error=aborted)
                go_idle(session)
                return None
            if running and modes['abortEvidence'] and modes['abortOrder'] == 'late':
                # Idle first, and the aborted answer after it, with no session error.
                go_idle(session)
                answer_prompt(session, error=aborted)
                return None
            if running and modes['abortEvidence']:
                answer_prompt(session, error=aborted)
            go_idle(session)
            return None
        return self.missing('/'.join(rest))

    def prompt(self, session, body):
        message_id = body.get('messageID') or new_id('msg')
        text = ''.join(p.get('text', '') for p in body.get('parts', []) if p.get('type') == 'text')
        # As OpenCode 1.19.3's `FilePartInput` (`schema/src/v1/session.ts`):
        # a `mime` and a `url` are required, anything else is refused (400).
        files = [p for p in body.get('parts', []) if p.get('type') == 'file']
        if any(not isinstance(f.get('mime'), str) or not isinstance(f.get('url'), str) for f in files):
            return self.reply(400, {'name': 'BadRequest', 'data': {'message': 'fixture: a file part needs mime and url'}})
        files = [{k: f[k] for k in ('type', 'mime', 'filename', 'url') if k in f} for f in files]
        mode = modes['prompt']
        if mode == 'store':
            store(session, message_id, text, files)
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
        if mode == 'store-then-400':
            # Stored and announced, then answered as refused.
            store(session, message_id, text, files)
            return self.reply(400, {'name': 'BadRequest', 'data': {'message': 'fixture: refused after storing'}})
        if mode == 'store-then-drop':
            store(session, message_id, text)
        # store-then-drop and drop: the connection ends without an answer.
        self.close_connection = True
        return None

    def run_command(self, session, body):
        """As OpenCode 1.19.3's command endpoint (`handlers/session.ts`,
        `session/prompt.ts` command): an unknown command is published as a
        session error and refused before any message exists; a known one is
        expanded here, stored under the given ID as a prompt is, and answered
        only once its run has ended (an answer to it, then idle), with that
        answer; every failure is a 400. A `subtask` command's run starts a
        sub-agent session under this one, as the task tool does. Mode
        `command`: `run`, `fail` (stored, then the run fails: 400),
        `fail-unannounced` (as `fail`, with no event for the stored message)
        or `drop` (the connection ends with nothing stored or answered).
        `failMessageReads` makes reading one message a 500."""
        command = modes['config'].get('command', {}).get(body.get('command'))
        if command is None or not isinstance(body.get('arguments'), str) or not isinstance(body.get('model', ''), str):
            error = {'name': 'UnknownError', 'data': {'message': f'Command not found: "{body.get("command")}".'}}
            publish('session.error', {'sessionID': session, 'error': error})
            return self.reply(400, error)
        mode = modes['command']
        if mode == 'drop':
            self.close_connection = True
            return None
        message_id = body.get('messageID') or new_id('msg')
        arguments = body['arguments'].split()
        text = command['template'].replace('$ARGUMENTS', body['arguments'])
        for n in range(1, 10):
            text = text.replace(f'${n}', arguments[n - 1] if n <= len(arguments) else '')
        store(session, message_id, text, announce=mode != 'fail-unannounced')
        statuses[session] = {'type': 'busy'}
        publish('session.status', {'sessionID': session, 'status': {'type': 'busy'}})
        if command.get('subtask'):
            agent = command.get('agent', 'general')
            control('child', {'parentID': session, 'title': f'{command.get("description", "")} (@{agent} subagent)', 'agent': agent})
        if mode in ('fail', 'fail-unannounced'):
            return self.reply(400, {'name': 'UnknownError', 'data': {'message': 'fixture: the run failed'}})
        deadline = time.time() + 60
        while time.time() < deadline:
            answers = [m for m in messages.get(session, {}).values() if m['info'].get('parentID') == message_id]
            if answers and session not in statuses:
                return self.reply(200, answers[-1])
            time.sleep(0.02)
        return self.reply(400, {'name': 'UnknownError', 'data': {'message': 'fixture: no answer'}})

    def dispose(self):
        how = switch('dispose')
        if how == 'refuse':
            return self.reply(500, {'name': 'UnknownError', 'data': {'message': 'fixture: dispose failed'}})
        if how == 'hang':
            time.sleep(30)
            return self.reply(200, True)
        # As OpenCode releasing its instances: what its tools run is ended
        # (SIGTERM to its session's group, then waited for), the instance's
        # disposal is announced, and its event streams end.
        for tool in tools:
            try:
                os.killpg(tool.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            tool.wait()
        publish('server.instance.disposed', {'directory': os.getcwd()})
        time.sleep(0.05)
        with lock:
            generation[0] += 1
        return self.reply(200, True)

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
    if switch('tool'):
        tool = subprocess.Popen(['sleep', '600'], start_new_session=True, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tools.append(tool)
        seen['tool'] = tool.pid
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
