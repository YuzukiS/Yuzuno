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
/global/dispose ends), `dispose` (`refuse`: it answers that with 500;
`hang`: it answers only after 30 s, ending nothing) or `xdg-data` (a folder
it takes as its XDG_DATA_HOME, as if started with it).
Sessions and messages are kept in state.json there, as OpenCode keeps them
in its database; pending requests, as in OpenCode, live only in the process. Routes under
/__fixture/ are the test's own controls and need no password.
Its folders are worked out as OpenCode's (XDG_* and HOME), and `GET /path` and `GET /project/current`
answer them. Snapshots of the work folder go into a real Git store in OpenCode's own layout
(<data>/snapshot/<project>/<sha1 of the worktree>), only when XDG_DATA_HOME is a folder a test marked
with a `.yuzuno-fixture` file; otherwise they are off, as with OpenCode's `snapshot: false`, and no Git
runs on any store (a revert then deletes each file it would send back, as OpenCode does with no store).
"""
import base64
import hashlib
import json
import os
import pwd
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
modes = {'prompt': 'store', 'mcp': 'connected', 'fail': {}, 'slow': {}, 'heartbeat': 0.2, 'abortEvidence': True,
         'abortOrder': 'answer-first', 'refuseEventsUntil': 0, 'providers': PROVIDERS, 'config': CONFIG,
         'command': 'run', 'summarize': 'run', 'defaultModel': None, 'deletePart': 'ok', 'failListOnce': False,
         'holdPermission': False, 'revert': 'ok', 'unrevert': 'ok'}
# Reads of the permission list held (mode `holdPermission`, once): what lets them answer.
held_reads = []
# Compactions whose run ended but whose answer waits (`summarize` mode `late`), by session.
late = {}
# Compactions held open (`summarize` mode `hold`), by session: what ends one.
held = {}
# Reverts or unreverts held (mode `hold`) or answered late (mode `late`), by session: what lets them go on.
reverting = {}
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


def store(session, message_id, text, files=(), announce=True, model=None):
    info = {'id': message_id, 'sessionID': session, 'role': 'user', 'time': {'created': int(time.time() * 1000)}}
    if model:
        info['model'] = model
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


def answer_prompt(session, text=None, error=None, completed=True, parent=None, extra=None, files=None, raw_patches=None):
    """An assistant message answering the session's last prompt (or `parent`), with a text part.
    `extra` adds to its info what OpenCode reports of an answer: `tokens`, `providerID`/`modelID`, `summary`.
    `files` ({relative path: text, or None to delete}) are changed in the work folder as a run's tools change
    them, and named in a `patch` part whose hash is the snapshot from before (`session/processor.ts`); with
    snapshots off, no part. `raw_patches` are patch parts as they are ({hash, files}), such as one whose snapshot
    is gone."""
    now = int(time.time() * 1000)
    info = {'id': new_id('msg'), 'sessionID': session, 'role': 'assistant', 'parentID': parent or last_prompt(session),
            'time': {'created': now}, 'finish': 'stop'}
    if completed:
        info['time']['completed'] = now
    if error:
        info['error'] = error
    info.update(extra or {})
    parts = []
    if text is not None:
        parts.append({'id': new_id('prt'), 'sessionID': session, 'messageID': info['id'], 'type': 'text', 'text': text})
    if files:
        before = track()
        for rel, content in files.items():
            write(rel, content)
        if before:
            parts.append({'id': new_id('prt'), 'sessionID': session, 'messageID': info['id'], 'type': 'patch', 'hash': before,
                          'files': [str(WORK / rel) for rel in files]})
    for patch in raw_patches or []:
        parts.append({'id': new_id('prt'), 'sessionID': session, 'messageID': info['id'], 'type': 'patch', **patch})
    with lock:
        messages.setdefault(session, {})[info['id']] = {'info': info, 'parts': parts}
    save()
    publish('message.updated', {'sessionID': session, 'info': info})
    for part in parts:
        publish('message.part.updated', {'sessionID': session, 'part': part, 'time': now})
    return info


WORK = Path.cwd().resolve()
# OpenCode's own folders (`core/src/global.ts`: xdg-basedir and `os.homedir()`), from the environment it runs with.
HOME = os.environ['HOME'] if 'HOME' in os.environ else pwd.getpwuid(os.getuid()).pw_dir


def xdg(name, *default):
    return os.path.normpath(os.path.join(os.environ.get(name) or os.path.join(HOME, *default), 'opencode'))


XDG_DATA = switch('xdg-data') or os.environ.get('XDG_DATA_HOME')
if XDG_DATA:
    os.environ['XDG_DATA_HOME'] = XDG_DATA
DATA, STATE, CONFIG = xdg('XDG_DATA_HOME', '.local', 'share'), xdg('XDG_STATE_HOME', '.local', 'state'), xdg('XDG_CONFIG_HOME', '.config')
# The project OpenCode names this folder's (`core/src/project.ts`; a fixed one here).
PROJECT = 'fixtureproject'
# The project `/project/current` names now (control `project`); snapshots stay under PROJECT's store.
current_project = [PROJECT]
# OpenCode's snapshot store for this worktree (`snapshot/index.ts`: data/snapshot/<project>/<sha1 of the worktree>).
STORE = Path(DATA) / 'snapshot' / PROJECT / hashlib.sha1(str(WORK).encode()).hexdigest()
# Snapshots are taken only into a data folder a test made for them (marked `.yuzuno-fixture`), never under anyone's
# own home; without one they are off, as with OpenCode's `snapshot: false`.
SNAPSHOTS = bool(XDG_DATA) and (Path(XDG_DATA) / '.yuzuno-fixture').is_file()


def git(*args, check=True):
    """Git on the snapshot store, with the work folder as its work tree, as OpenCode runs it."""
    result = subprocess.run(['git', '--git-dir', str(STORE), '--work-tree', str(WORK), '-c', 'core.autocrlf=false',
                             '-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=true', *args],
                            cwd=WORK, capture_output=True, env={**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'})
    if check and result.returncode != 0:
        raise RuntimeError(f'git {args}: {result.stderr.decode()}')
    return result


def folder():
    """The work folder's text files now, as a snapshot takes them: every one but Git's own and this
    stand-in's (its database folder may be inside the work folder in a test)."""
    found = {}
    for path in sorted(WORK.rglob('*')):
        if not path.is_file() or '.git' in path.relative_to(WORK).parts or ROOT.resolve() in path.resolve().parents:
            continue
        try:
            found[str(path.relative_to(WORK))] = path.read_text()
        except (UnicodeDecodeError, OSError):
            continue
    return found


def track():
    """A snapshot of the work folder (`Snapshot.track`): everything but this stand-in's own files added to the
    store's index, then the tree written; its ID, or None with snapshots off."""
    if not SNAPSHOTS:
        return None
    with lock:
        if not STORE.exists():
            STORE.parent.mkdir(parents=True, exist_ok=True)
            git('init', '-q')
        root = ROOT.resolve()
        exclude = [f':(exclude){root.relative_to(WORK)}'] if WORK in root.parents else []
        git('add', '-A', '--', '.', *exclude)
        return git('write-tree').stdout.decode().strip()


def restore(snapshot):
    """The whole snapshot written back (`Snapshot.restore`: read-tree, then checkout-index -a -f)."""
    with lock:
        git('read-tree', snapshot)
        git('checkout-index', '-a', '-f')


def revert_file(hash, file):
    """One file back as `hash` holds it (`Snapshot.revert`): checked out; if that fails, kept when the snapshot
    lists it, else deleted. What became of it."""
    rel = os.path.relpath(file, WORK)
    if not SNAPSHOTS:
        # No store a test made: as OpenCode with none, the checkout and the listing fail.
        Path(file).unlink(missing_ok=True)
        return 'deleted'
    with lock:
        if git('checkout', hash, '--', file, check=False).returncode == 0:
            return 'restored'
        listed = git('ls-tree', hash, '--', rel, check=False)
    if listed.returncode == 0 and listed.stdout.strip():
        log({'fixture': 'checkout failed, kept', 'file': rel})
        return 'kept'
    Path(file).unlink(missing_ok=True)
    return 'deleted'


def write(rel, content):
    path = WORK / rel
    if content is None:
        path.unlink(missing_ok=True)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)


def busy(session):
    """OpenCode 1.19.3's 409 for a busy session (`SessionBusyError`, `packages/sdk/openapi.json`)."""
    return {'_tag': 'SessionBusyError', 'sessionID': session, 'message': f'Session is busy: {session}'}


def ordered(session):
    return sorted(messages.get(session, {}).values(), key=lambda m: (m['info']['time']['created'], m['info']['id']))


def cleanup(session):
    """As OpenCode 1.19.3 applies a revert waiting in the session at its next prompt, command or summarize
    (`session/revert.ts` cleanup): the messages from its boundary on are deleted, each announced, and the
    revert is cleared; files are left as they are."""
    revert = sessions[session].get('revert')
    if not revert:
        return
    stored = ordered(session)
    index = next((i for i, m in enumerate(stored) if m['info']['id'] == revert['messageID']), -1)
    remove = [] if index < 0 else stored[index + (1 if revert.get('partID') else 0):]
    for message in remove:
        with lock:
            messages[session].pop(message['info']['id'], None)
        publish('message.removed', {'sessionID': session, 'messageID': message['info']['id']})
    if revert.get('partID') and index >= 0:
        target = stored[index]
        at = next((i for i, p in enumerate(target['parts']) if p['id'] == revert['partID']), -1)
        if at >= 0:
            gone, target['parts'] = target['parts'][at:], target['parts'][:at]
            for part in gone:
                publish('message.part.removed', {'sessionID': session, 'messageID': target['info']['id'], 'partID': part['id']})
    sessions[session].pop('revert', None)
    save()
    publish('session.updated', {'sessionID': session, 'info': sessions[session]})


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
        info = answer_prompt(body['sessionID'], body.get('text'), body.get('error'), body.get('completed', True), body.get('parentID'),
                             body.get('info'), body.get('files'), body.get('patches'))
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
    if name == 'revert':
        # A revert waiting in the session, as OpenCode keeps one until its next prompt.
        sessions[body['sessionID']]['revert'] = {'messageID': body.get('messageID', 'msg_reverted')}
        save()
        return True
    if name == 'project':
        # The folder held for another project from now on (T-10 Revert), as when its repository changed.
        current_project[0] = body['id']
        return True
    if name == 'compaction':
        # A compaction message in the session (T-10): one asked for, or OpenCode's own (`auto`).
        return compaction(body['sessionID'], body.get('model', {'providerID': 'deepseek', 'modelID': 'deepseek-flash'}),
                          body.get('auto', True))
    if name == 'held':
        # How many reads wait at the permission list now: ready to be released.
        with lock:
            return len(held_reads)
    if name == 'release':
        with lock:
            for waiter in held_reads:
                waiter.set()
            held_reads.clear()
        return True
    if name == 'folder':
        # The work folder as it is now (T-10).
        return folder()
    if name == 'write':
        # A change to the work folder from outside OpenCode: the user, or another Agent there.
        for rel, content in body['files'].items():
            write(rel, content)
        return True
    if name == 'goOn':
        # A held revert or unrevert goes on, or a late one is answered.
        reverting.pop(body['sessionID']).set()
        return True
    if name == 'answerLate':
        late.pop(body['sessionID']).set()
        return True
    if name == 'finishSummary':
        # A held compaction's run ends with its summary.
        summary = held.pop(body['sessionID'])
        finish(body['sessionID'], summary['info'], body.get('text', 'The conversation so far, in short.'), body.get('completed', True))
        summary['ended'].set()
        return summary['info']
    raise ValueError(name)


def compaction(session, model, auto):
    """A compaction's user message under an ID of OpenCode's own, with its
    `compaction` part (`session/compaction.ts` create), announced as stored."""
    info = {'id': new_id('msg'), 'sessionID': session, 'role': 'user', 'agent': 'build', 'model': model,
            'time': {'created': int(time.time() * 1000)}}
    part = {'id': new_id('prt'), 'sessionID': session, 'messageID': info['id'], 'type': 'compaction', 'auto': auto}
    with lock:
        messages.setdefault(session, {})[info['id']] = {'info': info, 'parts': [part]}
    save()
    publish('message.updated', {'sessionID': session, 'info': info})
    publish('message.part.updated', {'sessionID': session, 'part': part, 'time': info['time']['created']})
    return info


def summary_for(session, parent):
    """The compaction's summary, as OpenCode writes it before the run: `summary`, no completion, no finish."""
    info = {'id': new_id('msg'), 'sessionID': session, 'role': 'assistant', 'parentID': parent, 'mode': 'compaction',
            'agent': 'compaction', 'summary': True, 'time': {'created': int(time.time() * 1000)}}
    with lock:
        messages.setdefault(session, {})[info['id']] = {'info': info, 'parts': []}
    save()
    publish('message.updated', {'sessionID': session, 'info': info})
    return info


def finish(session, info, text, completed=True):
    """A compaction's run ending well: its summary's text, finish (and completion), then idle."""
    part = {'id': new_id('prt'), 'sessionID': session, 'messageID': info['id'], 'type': 'text', 'text': text}
    now = int(time.time() * 1000)
    if completed:
        info['time']['completed'] = now
    info['finish'] = 'stop'
    with lock:
        messages[session][info['id']] = {'info': info, 'parts': [part]}
    save()
    publish('message.part.updated', {'sessionID': session, 'part': part, 'time': now})
    publish('message.updated', {'sessionID': session, 'info': info})
    go_idle(session)


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
        # A route that answers late (T-10), as a busy OpenCode might.
        if url.path in modes['slow']:
            time.sleep(modes['slow'][url.path])
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
        if key == ('GET', 'path'):
            # `handlers/instance.ts` getPath: OpenCode's own folders and the instance's worktree and directory.
            return self.reply(200, {'home': HOME, 'state': STATE, 'config': CONFIG, 'worktree': str(WORK), 'directory': str(WORK)})
        if key == ('GET', 'project', 'current'):
            return self.reply(200, {'id': current_project[0], 'worktree': str(WORK), 'vcs': 'git'})
        if key == ('POST', 'session'):
            session = {'id': new_id('ses'), 'projectID': PROJECT, 'title': (body or {}).get('title', ''),
                       'directory': parse_qs(url.query).get('directory', [''])[0]}
            sessions[session['id']] = session
            save()
            publish('session.created', {'sessionID': session['id'], 'info': session})
            return self.reply(200, session)
        if key == ('GET', 'session', 'status'):
            return self.reply(200, statuses)
        if key == ('GET', 'permission'):
            if modes['holdPermission']:
                # Once: this read waits for `release`, after the reads before it in a whole
                # session read (its messages, its status) have answered.
                modes['holdPermission'] = False
                waiter = threading.Event()
                with lock:
                    held_reads.append(waiter)
                waiter.wait(30)
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
        if (method, *rest) == ('POST', 'summarize'):
            return self.summarize(session, body)
        if (method, *rest) == ('POST', 'revert'):
            return self.revert(session, body)
        if (method, *rest) == ('POST', 'unrevert'):
            return self.unrevert(session)
        if method == 'DELETE' and len(rest) == 4 and rest[0] == 'message' and rest[2] == 'part':
            return self.delete_part(session, rest[1], rest[3])
        if (method, *rest) == ('GET', 'message'):
            if modes['failListOnce']:
                modes['failListOnce'] = False
                return self.reply(500, {'name': 'UnknownError', 'data': {'message': 'fixture: list read failed'}})
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
            if session in held:
                # As OpenCode 1.19.3 halts an aborted compaction: the session
                # error and idle first, then its summary with the error and no
                # finish, then the runner's own idle.
                summary = held.pop(session)
                publish('session.error', {'sessionID': session, 'error': aborted})
                go_idle(session)
                summary['info']['error'] = aborted
                summary['info']['time']['completed'] = int(time.time() * 1000)
                save()
                publish('message.updated', {'sessionID': session, 'info': summary['info']})
                go_idle(session)
                summary['ended'].set()
                return None
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
        if mode != 'error':
            # `prompt` applies a revert waiting in the session before its message (`session/prompt.ts`).
            cleanup(session)
        model = body.get('model') or modes['defaultModel']
        if mode == 'store':
            store(session, message_id, text, files, model=model)
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
        if mode == 'idle-then-400':
            # The run ends (its answer, then idle) while this prompt is being
            # refused: the 400 comes only after those events.
            answer_prompt(session, text='Done.')
            go_idle(session)
            time.sleep(0.3)
            return self.reply(400, {'name': 'BadRequest', 'data': {'message': 'fixture: refused after the run ended'}})
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
        # A command is a prompt: a revert waiting in the session is applied first.
        cleanup(session)
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

    def summarize(self, session, body):
        """As OpenCode 1.19.3's summarize (`handlers/session.ts`): a body
        without a provider and model is refused (400) before the handler; the
        compaction's message is written, the run goes on, and the answer
        (`true`) comes only once it ends. Mode `summarize`: `run`, `hold`
        (written, its summary too, then held until `finishSummary` or an
        abort), `drop` (run, then the connection ends with no answer),
        `refuse` / `refuse-404` (refused, nothing written), `refuse-late` (written,
        then refused), `silent` (nothing written, no answer for 30 s), `auto`
        (only a compaction of OpenCode's own is written, then idle, answered),
        `double` (two compactions asked for are written, then idle, answered), `proxy500` (written, its
        summary too, then idle and a 500, as OpenCode's proxy answers a broken upstream)."""
        if not isinstance(body, dict) or not isinstance(body.get('providerID'), str) or not isinstance(body.get('modelID'), str):
            return self.reply(400, {'name': 'BadRequest', 'data': {'message': 'fixture: providerID and modelID are required'}})
        mode = modes['summarize']
        model = {'providerID': body['providerID'], 'modelID': body['modelID']}
        # The handler applies a revert waiting in the session first (`handlers/session.ts` summarize).
        if mode not in ('refuse', 'refuse-404'):
            cleanup(session)
        if mode == 'refuse':
            return self.reply(400, {'name': 'BadRequest', 'data': {'message': 'fixture: refused'}})
        if mode == 'refuse-404':
            return self.reply(404, {'name': 'NotFoundError', 'data': {'message': 'fixture: not found'}})
        if mode == 'silent':
            time.sleep(30)
            self.close_connection = True
            return None
        statuses[session] = {'type': 'busy'}
        publish('session.status', {'sessionID': session, 'status': {'type': 'busy'}})
        if mode == 'auto':
            compaction(session, model, True)
            go_idle(session)
            return self.reply(200, True)
        if mode == 'double':
            compaction(session, model, False)
            compaction(session, model, False)
            go_idle(session)
            return self.reply(200, True)
        user = compaction(session, model, body.get('auto', False))
        if mode == 'refuse-late':
            go_idle(session)
            return self.reply(400, {'name': 'BadRequest', 'data': {'message': 'fixture: refused after writing'}})
        if mode == 'proxy500':
            # Written, its summary too, then the upstream broke: OpenCode's
            # proxy answers 500 (`middleware/proxy.ts`), and the session is idle.
            summary_for(session, user['id'])
            go_idle(session)
            return self.reply(500, {'name': 'UnknownError', 'data': {'message': 'fixture: upstream broke'}})
        info = summary_for(session, user['id'])
        if mode == 'hold':
            ended = threading.Event()
            held[session] = {'info': info, 'ended': ended}
            ended.wait(60)
            # Aborted or not, the run ended and the waiting request is
            # answered (`effect/runner.ts`: a cancelled run's waiters get
            # its onInterrupt), so the handler returns true.
            return self.reply(200, True)
        time.sleep(0.05)
        finish(session, info, 'The conversation so far, in short.')
        if mode == 'late':
            # The run ended, as its events say; its answer comes only on `answerLate`.
            ended = threading.Event()
            late[session] = ended
            ended.wait(60)
            return self.reply(200, True)
        if mode == 'drop':
            self.close_connection = True
            return None
        return self.reply(200, True)

    def delete_part(self, session, message_id, part_id):
        """As OpenCode 1.19.3's part removal (`session.ts` removePart and
        `core/src/session/projector.ts`): announced, then deleted by its ID
        and session alone, with no check that it exists or is that
        message's, and answered true. Mode `deletePart`: `ok`, `drop`
        (removed, then the connection ends with no answer) or `lie`
        (answered true, nothing removed)."""
        mode = modes['deletePart']
        if mode == 'read-fails':
            # Removed and answered; the next read of the session's messages fails.
            modes['failListOnce'] = True
        if mode != 'lie':
            with lock:
                for m in messages.get(session, {}).values():
                    m['parts'] = [p for p in m['parts'] if p['id'] != part_id]
            save()
            publish('message.part.removed', {'sessionID': session, 'messageID': message_id, 'partID': part_id})
        if mode == 'drop':
            self.close_connection = True
            return None
        return self.reply(200, True)

    def revert(self, session, body):
        """As OpenCode 1.19.3's revert (`session/revert.ts`), refused while the session runs (409): the
        boundary is the message asked for, or the user message before an answer asked for; none found
        answers the session unchanged. A snapshot of the whole folder is taken (a revert already waiting
        is restored first), each file a later patch names is checked out of its first such patch's
        snapshot (kept if that fails and the snapshot lists it, deleted otherwise, as when it did not exist
        or the snapshot is gone), and the revert is kept in the session with that snapshot.
        Mode `revert`: `ok`, `files-fail` (every checkout taken as failed with the snapshot listing the
        file: only logged, the answer the same), `refuse` (409 as when busy, nothing done), `error` (500,
        nothing done), `drop` (done, then the
        connection ends with no answer), `late` (done, answered only on `goOn`), `hold` (nothing done
        until `goOn`), `conflict` (409 with another body, nothing done), `unmarked` (200 with the session
        unchanged, nothing done, as when no message matches), `unmarked-files` (the files checked out,
        then 200 with no revert kept)."""
        if statuses.get(session, {}).get('type') == 'busy':
            return self.reply(409, busy(session))
        mode = modes['revert']
        if mode == 'refuse':
            return self.reply(409, busy(session))
        if mode == 'error':
            return self.reply(500, {'name': 'UnknownError', 'data': {'message': 'fixture: revert failed'}})
        if mode == 'conflict':
            return self.reply(409, {'_tag': 'ConflictError', 'message': 'fixture: not a busy session'})
        if mode == 'unmarked':
            return self.reply(200, sessions[session])
        if mode == 'hold':
            go_on = threading.Event()
            reverting[session] = go_on
            go_on.wait(60)
        target, part = body.get('messageID'), body.get('partID')
        last_user, revert, patches = None, None, []
        for message in ordered(session):
            if message['info']['role'] == 'user':
                last_user = message['info']
            remaining = []
            for p in message['parts']:
                if revert:
                    if p['type'] == 'patch':
                        patches.append(p)
                    continue
                if (message['info']['id'] == target and not part) or p['id'] == part:
                    kept = part if any(r['type'] in ('text', 'tool') for r in remaining) else None
                    revert = {'messageID': last_user['id'] if not kept and last_user else message['info']['id']}
                    if kept:
                        revert['partID'] = kept
                remaining.append(p)
        info = sessions[session]
        if revert:
            waiting = info.get('revert') or {}
            snapshot = waiting.get('snapshot') or track()
            if waiting.get('snapshot'):
                restore(waiting['snapshot'])
            seen, restored = set(), []
            for p in patches:
                for file in p['files']:
                    if file in seen:
                        continue
                    seen.add(file)
                    if mode == 'files-fail':
                        log({'fixture': 'checkout failed, kept', 'file': os.path.relpath(file, WORK)})
                        continue
                    if revert_file(p['hash'], file) != 'kept':
                        restored.append(os.path.relpath(file, WORK))
            if mode == 'unmarked-files':
                return self.reply(200, info)
            if snapshot:
                revert['snapshot'] = snapshot
                revert['diff'] = git('diff', snapshot, check=False).stdout.decode(errors='replace')
            info['revert'] = revert
            info['summary'] = {'additions': 0, 'deletions': 0, 'files': len(restored)}
            save()
            publish('session.diff', {'sessionID': session, 'diff': [{'file': rel} for rel in restored]})
            publish('session.updated', {'sessionID': session, 'info': info})
        if mode == 'drop':
            self.close_connection = True
            return None
        if mode == 'late':
            go_on = threading.Event()
            reverting[session] = go_on
            go_on.wait(60)
        return self.reply(200, info)

    def unrevert(self, session):
        """As OpenCode 1.19.3's unrevert, refused while the session runs (409): the whole folder goes back
        to the revert's snapshot (every file it holds written again, none deleted) and the revert is cleared.
        Mode `unrevert`: `ok`, `error`, `drop`, `late`, `hold`, as for a revert."""
        if statuses.get(session, {}).get('type') == 'busy':
            return self.reply(409, busy(session))
        mode = modes['unrevert']
        if mode == 'error':
            return self.reply(500, {'name': 'UnknownError', 'data': {'message': 'fixture: unrevert failed'}})
        if mode == 'hold':
            go_on = threading.Event()
            reverting[session] = go_on
            go_on.wait(60)
        info = sessions[session]
        revert = info.get('revert')
        if revert:
            if revert.get('snapshot'):
                restore(revert['snapshot'])
            info.pop('revert', None)
            save()
            publish('session.updated', {'sessionID': session, 'info': info})
        if mode == 'drop':
            self.close_connection = True
            return None
        if mode == 'late':
            go_on = threading.Event()
            reverting[session] = go_on
            go_on.wait(60)
        return self.reply(200, info)

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
