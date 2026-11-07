#!/usr/bin/env python3
"""A stand-in `opencode serve`, for tests/opencode_transport.rs and the
suites that start OpenCode. It starts, answers `/api/info` and stops as
OpenCode 2.x does (T-32 slice 2: 2.2.5's flags, listening line, password
variable and teardown on SIGTERM); its other calls still have OpenCode
1.19.3's shape, until their slices of T-32. It reads only its arguments and
the environment Core starts it with, and keeps its state in memory. It writes
what it saw to the folder of OPENCODE_DB (start.json, calls.jsonl), where a
test may leave a switch before it starts: `host` (the address it reports),
`version` (the version it reports), `exit` (exit before listening), `noise`
(a long line that is not UTF-8 before listening), `line1x` (it says it
listens as 1.x does), `starting` (seconds it answers `/api/info` with 503,
as 2.x does while it starts), `mcp` (the status an MCP server it connects ends in: `connected`, `failed`,
`needs_auth`, or `pending`, which it never leaves), `stubborn`
(it and a child of its own ignore SIGTERM), `tool` (it starts a process in a
session of its own, as OpenCode's tools run, which only its teardown after
SIGTERM ends), `teardown` (seconds its teardown takes before it ends that
process and exits), `closeStreamsFirst` (its teardown first ends its event
streams and cuts every request still being served, before that wait, as 2.x
closes what it serves early), `xdg-data` (a folder it takes as its XDG_DATA_HOME, as
if started with it) or `slowSave` (seconds each save of its state waits with its file open, before it writes).
MCP servers are 2.x's (T-61 slice 1): added at runtime per folder (`PUT /api/experimental/mcp/:server`), listed
with their status only (`GET /api/mcp`), connected again (`…/connect`), kept in memory, and dropped with the folder
(control `mcpDrop`, as 2.x unloads an idle folder). Mode `mcpPendingFor` (seconds) lists one as `pending` that long
after it is added, as 2.x may for a folder's first, before its status settles; `mcpRefuse` answers an add with 400
quoting the request, as a schema rejection may; `mcpErrorEcho` puts the request's Authorization in a failed one's
error. 1.19.3's `POST /mcp` and `GET /mcp` are answered only in the 1.19.3 mode (`v1Messages`).
Permission requests and forms are 2.x's (T-61 slice 2), in every mode, the 1.19.3 mode too: made by controls `ask` and
`question`, listed per session (`GET /api/session/:id/permission`, `…/form`) and answered by 2.x's routes (`POST
…/permission/:id/reply`, `POST …/form/:id/reply`, `DELETE …/form/:id`): 204, 404 for one not pending in that session,
400 for a form answer 2.x can't take (the form stays pending). A reject or a declined form ends the run as 2.2.5 ends
one shutting down (`session.execution.interrupted`, reason `shutdown`, and no idle message); an interrupt drops the
session's permission requests with nothing said and cancels its forms. Control `forget` drops one with nothing said, as
if OpenCode no longer held it. 1.19.3's request routes (`/permission`, `/question`) are gone.
Commands are 2.x's (T-61 slice 3): listed by name and description (`GET /api/command`) and run by `POST
/api/session/:id/command` (mode `command`); 1.19.3's `POST /session/:id/command` is gone.
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
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(os.environ['OPENCODE_DB']).parent
# As 2.x (cli/src/env.ts): OPENCODE_PASSWORD first, then the 1.x name; the user is always `opencode`.
PASSWORD_FROM = next((name for name in ('OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD') if os.environ.get(name)), None)
PASSWORD = os.environ.get(PASSWORD_FROM, '') if PASSWORD_FROM else ''
USERNAME = 'opencode'
STARTED = time.monotonic()
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
# names a model of its own (`pinned`) and one is a sub-agent's (`delegate`,
# `subtask`, its agent naming a model). 2.x lists only their names and
# descriptions (`GET /api/command`) and runs them by name (`command_v2`).
# `mode` replaces it.
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
# The connections of the requests being served, for a teardown that cuts them (`closeStreamsFirst`).
active = set()
counter = [0]
# `permissions` and `forms`: 2.x's pending permission requests and forms (T-61 slice 2), in the order asked.
sessions, messages, statuses, permissions, forms, mcp = {}, {}, {}, [], [], {}
# 2.x's MCP servers added at runtime (T-61 slice 1), by name: their configuration, status and folder; and each
# connection it made of one (a name and why), which the same configuration added again does not make.
mcp_servers, mcp_connects = {}, []
# Each command request 2.x's route took (T-61 slice 3), in order: its session, `name`, `text` and the body's keys (control
# `commands`).
commands_seen = []
modes = {'prompt': 'store', 'mcp': 'connected', 'fail': {}, 'slow': {}, 'heartbeat': 0.2, 'abortEvidence': True,
         'abortOrder': 'answer-first', 'refuseEventsUntil': 0, 'providers': PROVIDERS, 'config': CONFIG,
         'command': 'run', 'summarize': 'run', 'defaultModel': None, 'deletePart': 'ok', 'failListOnce': False,
         'holdPermission': False, 'revert': 'ok', 'unrevert': 'ok', 'directory': None, 'fork': 'ok', 'history': 'ok',
         'replay': 'ok', 'html': [], 'activeShape': 'object', 'integrations': [], 'oauth': {}, 'loginRefuse': False,
         'holdOauthStatus': False, 'replyLost': None}
# 2.x's logins (T-32 slice 4b): its credentials, values included, as its database keeps them; its sign-in attempts;
# and those cancelled.
credentials, attempts, cancelled = {}, {}, []
# Reads of the permission list held (mode `holdPermission`, once): what lets them answer.
held_reads = []
# Compactions whose run ended but whose answer waits (`summarize` mode `late`), by session.
late = {}
# Compactions held open (`summarize` mode `hold`), by session: what ends one.
held = {}
# Reverts or unreverts held (mode `hold`) or answered late (mode `late`), by session: what lets them go on.
reverting = {}
# OpenCode's durable events (T-10 Fork), as its database keeps them (`core/src/event.ts`): every v1
# session, message and part event, under its session (the aggregate), numbered from 0 in each.
DURABLE = {'session.created', 'session.updated', 'session.deleted', 'message.updated', 'message.removed',
           'message.part.updated', 'message.part.removed'}
durable, aggregates = [], {}
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


# The last time and count `v2_message_id` made an ID with.
last_v2_id = [0, 0]


def v2_message_id():
    """A message ID as 2.x makes one for what it admits itself, a command's message among them (schema/src/identifier.ts):
    `msg_`, 12 hex digits of `ms × 4096 + n`, 14 base62 characters. These ascend with Core's own (opencode.rs MessageId),
    as 2.x's do, which `new_id`'s counter does not."""
    chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    with lock:
        now = int(time.time() * 1000)
        last_v2_id[:] = [now, last_v2_id[1] + 1 if last_v2_id[0] == now else 1]
        value = (now * 0x1000 + last_v2_id[1]) & 0xffff_ffff_ffff
    return f'msg_{value:012x}' + ''.join(chars[b % 62] for b in os.urandom(14))


def publish(kind, properties):
    """An event of the stand-in's own store, kept in 1.19.3's shape: sent as 2.x sends its own (T-32 slice 3b), or as it
    is in the 1.19.3 mode (switch or mode `v1Messages`), which only the tests of compaction, rewind and fork use until
    their slices move them. Durable ones are kept for `/sync/history` as they are."""
    if v1():
        sent = send(kind, properties)
    else:
        sent = None
        for kind2, data, *created in v2_events(kind, properties):
            send(kind2, data, *created)
    kept = kind in DURABLE and isinstance(properties.get('sessionID'), str)
    if kept:
        evt = sent or new_id('evt')
        with lock:
            aggregate = properties['sessionID']
            seq = aggregates.get(aggregate, -1) + 1
            aggregates[aggregate] = seq
            durable.append({'id': evt, 'aggregate_id': aggregate, 'seq': seq, 'type': kind + '.1',
                            'data': json.loads(json.dumps(properties))})
        save()
    elif sent is None and kind == 'session.status':
        # What an execution's end changed in 2.x's own store: its idle message, and the inbox it delivered.
        save()


def send(kind, data, created=None, event_id=None):
    # 2.x's envelope (schema/src/event.ts): `data`, and the time it was made (control `event` may give it).
    event = {'id': event_id or new_id('evt'), 'type': kind, 'created': created or int(time.time() * 1000), 'data': data}
    with lock:
        for stream in streams:
            stream.put(event)
    return event['id']


def v1():
    # The switch beside every Agent's folder applies to each of them (a fork's new Agent too).
    return bool(modes.get('v1Messages')) or switch('v1Messages') is not None or (ROOT.parent / 'v1Messages').exists()


# What sending the store's events as 2.x's needs to remember, by session (T-32 slice 3b).
v2_state = {}


def v2_of(session):
    # `shutdown`: the execution ending now ends as one shutting down (`shut_down`).
    return v2_state.setdefault(session, {'delivered': set(), 'started': set(), 'ended': set(), 'parts': set(),
                                         'error': None, 'idles': [], 'pending': [], 'steer': set(), 'shells': [],
                                         'shutdown': False})


def v2_models():
    """What 2.x's `GET /api/model` lists (schema/src/model.ts Model.Info), made of the 1.19.3-shaped providers mode
    `providers` holds: each with the fields that can hold credentials (`settings`, `headers`), here fake."""
    out = []
    for provider in modes['providers']['providers']:
        for key, m in (provider.get('models') or {}).items():
            image = ((m.get('capabilities') or {}).get('input') or {}).get('image') is True
            out.append({'id': m.get('id', key), 'modelID': m.get('id', key), 'providerID': provider['id'], 'name': m.get('name', key),
                        'capabilities': {'tools': True, 'input': ['text', 'image'] if image else ['text'], 'output': ['text']},
                        'variants': [{'id': name, 'settings': settings} for name, settings in (m.get('variants') or {}).items()],
                        'status': m.get('status', 'active'), 'enabled': True, 'limit': m.get('limit') or {'context': 0, 'output': 0},
                        'cost': [], 'time': {'released': 0},
                        'settings': {'apiKey': SECRETS[1]}, 'headers': {'Authorization': f'Bearer {SECRETS[2]}'}})
    return out


def v2_providers():
    """What 2.x's `GET /api/provider` lists (schema/src/provider.ts Provider.Info), with a fake key in its settings."""
    return [{'id': p['id'], 'name': p['name'], 'activation': 'enabled', 'package': '@ai-sdk/openai-compatible',
             'settings': {'apiKey': SECRETS[0]}} for p in modes['providers']['providers']]


def between_reads(session):
    """Mode `deliverBetweenReads` (T-32 slice 4a, R5 728f7e52), once: 2.x delivers what waits in the session's inbox
    right after the first read of one message or of the inbox is answered, so the other read finds it moved."""
    if modes.get('deliverBetweenReads'):
        modes['deliverBetweenReads'] = False
        with lock:
            v2_deliver(session)
        save()


def v2_integrations():
    """What 2.x's `GET /api/integration` lists (schema/src/integration.ts Info): each configured provider with a key
    method (core/src/config/plugin/provider.ts), then mode `integrations`' own, each with its connections. Each carries
    metadata holding a fake secret, which Core must not pass on."""
    def connections(integration):
        return [{'type': 'credential', 'id': cid, 'label': c['label'], 'method': c['method']}
                for cid, c in credentials.items() if c['integration'] == integration]
    listed = [{'id': p['id'], 'name': p['name'], 'metadata': {'token': SECRETS[0]},
               'methods': [{'type': 'key', 'label': 'Manually enter API Key'}]} for p in modes['providers']['providers']]
    listed += [dict(i, metadata={'token': SECRETS[0]}) for i in modes['integrations']]
    return [dict(i, connections=connections(i['id'])) for i in listed]


def v2_method(integration, kind, method_id=None):
    """The method of that kind (and ID) an integration lists, or None."""
    for listed in v2_integrations():
        if listed['id'] == integration:
            return next((m for m in listed['methods'] if m['type'] == kind and (method_id is None or m.get('id') == method_id)), None)
    return None


def v2_answer_refused(method, answer, kind):
    """Why 2.x refuses a method's form answer (core/src/form.ts validateAnswer, core/src/integration.ts), or None: a
    field it doesn't have, a required one missing or one answered while its conditions don't hold; and an answer to a
    key method with no form."""
    form, answer = (method or {}).get('form'), answer or {}
    if not form:
        return 'Key method does not accept a form answer' if kind == 'key' and answer else None
    for key in answer:
        if key not in {field['key'] for field in form}:
            return f'Unknown form field: {key}'
    for field in form:
        active = field_active(field, answer)
        if field['key'] not in answer:
            if field.get('required') and active:
                return f'Missing required form field: {field["key"]}'
        elif not active:
            return f'Form field is not active: {field["key"]}'
    return None


def field_active(field, answer):
    # A form field's `when` conditions hold (2.2.5 core/src/form.ts): each names another field's value, equal or not.
    return all(answer.get(w['key']) is not None and (answer.get(w['key']) == w['value']) == (w['op'] == 'eq')
               for w in field.get('when') or [])


def form_answer_refused(form, answer):
    """Why 2.2.5 refuses an answer to a session's form (core/src/form.ts:235-255 validateAnswer), or None: a key the
    form has no field for; then, field by field, a required one missing, one answered while its conditions don't hold,
    or a value it can't take. A `string` field takes a string: one of its options' values, or any when `custom` is not
    false; a `multiselect` a list of such strings. A field not required may go unanswered. The stand-in's forms have
    only those two types; a value of any other is taken as it is."""
    for key in answer:
        if key not in {field['key'] for field in form['fields']}:
            return f'Unknown form field: {key}'
    for field in form['fields']:
        key, active = field['key'], field_active(field, answer)
        if key not in answer:
            if field.get('required') and active:
                return f'Missing required form field: {key}'
            continue
        if not active:
            return f'Form field is not active: {key}'
        values = {option.get('value') for option in field.get('options') or []}
        one = lambda value: isinstance(value, str) and (field.get('custom') is not False or value in values)
        value = answer[key]
        if field.get('type') == 'string' and not one(value):
            return f'Invalid value for form field: {key}'
        if field.get('type') == 'multiselect' and not (isinstance(value, list) and all(one(v) for v in value)):
            return f'Invalid value for form field: {key}'
    return None


def add_credential(integration, method, label, value):
    cid = new_id('crd')
    with lock:
        credentials[cid] = {'integration': integration, 'method': method, 'label': label, 'value': value}
    return cid


def v2_deliver(session, upto=None):
    # 2.x delivers a message steered into a busy session at its next step's start (core/src/session/projector.ts):
    # those enqueued up to `upto`, or all of them.
    state = v2_of(session)
    if upto is not None and upto not in state['pending']:
        return []
    count = state['pending'].index(upto) + 1 if upto is not None else len(state['pending'])
    delivered, state['pending'] = state['pending'][:count], state['pending'][count:]
    return [('session.inbox.delivered', {'sessionID': session, 'inboxID': mid}) for mid in delivered]


def v2_error(error):
    # 2.x's error (schema/src/session-error.ts) from 1.19.3's {name, data: {message}}.
    return {'type': (error or {}).get('name') or 'UnknownError', 'message': ((error or {}).get('data') or {}).get('message') or ''}


def v2_content_index(session, message_id, part_id):
    """A part's ordinal among its answer's entries (text, reasoning, tool), as 2.x numbers them."""
    stored = messages.get(session, {}).get(message_id) or {}
    entries = [q for q in stored.get('parts', []) if v2_entry(q) is not None]
    return next((n for n, q in enumerate(entries) if q.get('id') == part_id), len(entries))


def v2_tool_name(part):
    # 2.x's sub-agent tool (core/src/tool/plugin/subagent.ts) is 1.19.3's `task`.
    return 'subagent' if part.get('tool') == 'task' else part.get('tool')


def v2_tool_metadata(part):
    metadata = dict((part.get('state') or {}).get('metadata') or {})
    if part.get('tool') == 'task' and metadata.get('sessionId'):
        metadata = {'sessionID': metadata['sessionId'], 'status': 'running'}
    return metadata


def v2_entry(q):
    """A stored part as an entry of 2.x's assistant `content`, or None for what 2.x keeps elsewhere."""
    kind = q.get('type')
    if kind == 'text' and not q.get('synthetic'):
        return {'type': 'text', 'text': q.get('text', '')}
    if kind == 'reasoning':
        return {'type': 'reasoning', 'text': q.get('text', '')}
    if kind == 'tool':
        state = q.get('state') or {}
        status = state.get('status')
        name = v2_tool_name(q)
        if status == 'completed':
            out = {'status': 'completed', 'input': state.get('input', {}),
                   'content': [{'type': 'text', 'text': str(state.get('output', ''))}], 'metadata': v2_tool_metadata(q)}
        elif status == 'error':
            out = {'status': 'error', 'input': state.get('input', {}), 'error': {'type': 'tool', 'message': str(state.get('error', ''))}}
        elif status == 'running':
            out = {'status': 'running', 'input': state.get('input', {}), 'metadata': v2_tool_metadata(q)}
        else:
            out = {'status': 'streaming', 'input': ''}
        return {'type': 'tool', 'id': q.get('callID') or q.get('id'), 'name': name, 'state': out}
    return None


def v2_payload(session, mid):
    """A stored user message as 2.x's inbox payload (schema/src/session-inbox.ts UserPayload)."""
    stored = messages.get(session, {}).get(mid) or {}
    text = ''.join(q.get('text', '') for q in stored.get('parts', []) if q.get('type') == 'text')
    payload = {'text': text}
    # A file as 2.x sends one (schema/src/prompt.ts): its bytes as base64 `data`, not a `data:` URL.
    files = [{'data': (q.get('url') or '').split(',', 1)[-1], 'mime': q.get('mime'), 'name': q.get('filename'),
              'source': {'type': 'inline'}} for q in stored.get('parts', []) if q.get('type') == 'file']
    if files:
        payload['files'] = files
    return payload


def v2_inbox(session):
    """What 2.x's `/api/session/:id/inbox` lists: the messages steered in and not yet delivered, oldest first."""
    state = v2_of(session)
    return [{'id': mid, 'sessionID': session, 'type': 'user', 'delivery': 'steer', 'payload': v2_payload(session, mid),
             'time': {'created': ((messages.get(session, {}).get(mid) or {}).get('info') or {}).get('time', {}).get('created', 0)}}
            for mid in state['pending']]


def v2_events(kind, p):
    """The 2.x events one of the store's 1.19.3-shaped events stands for (schema/src/session-event.ts)."""
    session = p.get('sessionID')
    if kind == 'message.updated':
        info = p['info']
        state = v2_of(session)
        mid = info['id']
        if info.get('role') == 'user':
            if mid in state['delivered']:
                return []
            state['delivered'].add(mid)
            payload = v2_payload(session, mid)
            # Steered in: sent while a run went on (`prompt`); a message the store holds already was delivered.
            steered = mid in state['steer']
            enqueued = ('session.inbox.enqueued', {'sessionID': session, 'inboxID': mid, 'item': {'type': 'user', 'payload': payload,
                                                                                               'delivery': 'steer' if steered else 'queue'}})
            if steered:
                state['pending'].append(mid)
                return [enqueued]
            return [enqueued, ('session.inbox.delivered', {'sessionID': session, 'inboxID': mid})]
        if info.get('summary'):
            # A compaction's summary is 2.x's compaction (session-event.ts Compaction).
            done = (info.get('time') or {}).get('completed')
            out = []
            if mid not in state['started']:
                state['started'].add(mid)
                # 2.x names the compaction's message by its input's ID (core/src/session/message-updater.ts), as here.
                out.append(('session.compaction.started', {'sessionID': session, 'reason': 'auto', 'inputID': mid}))
            if done and mid not in state['ended']:
                state['ended'].add(mid)
                out.append(('session.compaction.ended', {'sessionID': session, 'reason': 'manual' if info.get('mode') == 'manual' else 'auto',
                                                         'text': '', 'tokens': info.get('tokens')}))
            return out
        out = []
        if mid not in state['started']:
            state['started'].add(mid)
            # A step answering a message steered in starts once it is delivered; one answering an earlier one, before.
            out += v2_deliver(session, info.get('parentID'))
            out.append(('session.step.started', {'sessionID': session, 'assistantMessageID': mid, 'agent': info.get('agent') or 'build',
                                                 'model': {'id': info.get('modelID') or 'fixture', 'providerID': info.get('providerID') or 'fixture'},
                                                 'started': (info.get('time') or {}).get('created') or int(time.time() * 1000)}))
        done = (info.get('time') or {}).get('completed') is not None or info.get('error')
        if done and mid not in state['ended']:
            state['ended'].add(mid)
            if (info.get('error') or {}).get('name') == 'MessageAbortedError':
                # An aborted answer: 2.x ends that execution as interrupted.
                state['error'] = info['error']
            # 2.x stores the answer's end as its end event's time (core/src/session/message-updater.ts).
            at = (info.get('time') or {}).get('completed') or int(time.time() * 1000)
            if info.get('error'):
                out.append(('session.step.failed', {'sessionID': session, 'assistantMessageID': mid, 'error': v2_error(info['error'])}, at))
            else:
                out.append(('session.step.ended', {'sessionID': session, 'assistantMessageID': mid, 'finish': info.get('finish') or 'stop',
                                                   'cost': info.get('cost', 0), 'tokens': info.get('tokens')}, at))
        return out
    if kind == 'message.part.updated':
        q = p['part']
        mid = q.get('messageID')
        stored = messages.get(session, {}).get(mid) or {}
        info = stored.get('info') or {}
        entry = v2_entry(q)
        if info.get('role') != 'assistant' or info.get('summary') or entry is None:
            return []
        ordinal = v2_content_index(session, mid, q.get('id'))
        state = v2_of(session)
        first = (mid, q.get('id')) not in state['parts']
        state['parts'].add((mid, q.get('id')))
        if entry['type'] in ('text', 'reasoning'):
            name = 'session.' + entry['type']
            out = [(name + '.started', {'sessionID': session, 'assistantMessageID': mid, 'ordinal': ordinal})] if first else []
            return out + [(name + '.ended', {'sessionID': session, 'assistantMessageID': mid, 'ordinal': ordinal, 'text': entry['text']})]
        tool = {'sessionID': session, 'assistantMessageID': mid, 'id': entry['id']}
        status = entry['state']['status']
        out = [('session.tool.input.started', {**tool, 'name': entry['name']})] if first else []
        if status == 'running':
            out.append(('session.tool.called', {**tool, 'input': entry['state']['input'], 'executed': True}))
            if entry['state'].get('metadata'):
                out.append(('session.tool.progress', {**tool, 'metadata': entry['state']['metadata']}))
        elif status == 'completed':
            out.append(('session.tool.called', {**tool, 'input': entry['state']['input'], 'executed': True}))
            out.append(('session.tool.success', {**tool, 'content': entry['state']['content'], 'metadata': entry['state'].get('metadata') or {},
                                                 'executed': True}))
        elif status == 'error':
            out.append(('session.tool.failed', {**tool, 'error': entry['state']['error'], 'executed': True}))
        return out
    if kind == 'session.status':
        status = (p.get('status') or {}).get('type')
        state = v2_of(session)
        if status == 'busy':
            return [('session.execution.started', {'sessionID': session})]
        if status == 'retry':
            return [('session.retry.scheduled', {'sessionID': session, 'assistantMessageID': '', 'attempt': 1, 'at': 0,
                                                 'error': {'type': 'retry', 'message': (p.get('status') or {}).get('message', '')}})]
        if status == 'idle':
            if state['shutdown']:
                # An execution 2.x ended as one shutting down (`shut_down`): no idle message (probe p0), and what was
                # steered in waits in the inbox for the next execution.
                state['shutdown'], state['error'] = False, None
                return [('session.execution.interrupted', {'sessionID': session, 'reason': 'shutdown'})]
            # An execution's end, and the idle message 2.x writes for it (core/src/session/projector.ts); what was
            # steered in and not yet taken up is delivered into this turn first.
            ahead = v2_deliver(session)
            error, state['error'] = state['error'], None
            last = next(reversed(messages.get(session, {})), None)
            if error and error.get('name') == 'MessageAbortedError':
                state['idles'].append({'after': last, 'outcome': 'interrupted', 'error': v2_error(error)})
                return ahead + [('session.execution.interrupted', {'sessionID': session, 'reason': 'user'})]
            if error:
                state['idles'].append({'after': last, 'outcome': 'failed', 'error': v2_error(error)})
                return ahead + [('session.execution.failed', {'sessionID': session, 'error': v2_error(error)})]
            state['idles'].append({'after': last, 'outcome': 'succeeded'})
            return ahead + [('session.execution.succeeded', {'sessionID': session})]
        return []
    if kind == 'session.error':
        # 2.x reports it with the execution's end (session-event.ts Execution); with none running, at once.
        if session not in statuses:
            return [('session.execution.failed', {'sessionID': session, 'error': v2_error(p.get('error'))})]
        v2_of(session)['error'] = p.get('error')
        return []
    if kind == 'session.created':
        info = p.get('info') or {}
        return [('session.created', {'sessionID': info.get('id'), 'projectID': info.get('projectID', PROJECT), 'parentID': info.get('parentID'),
                                     'title': info.get('title'), 'agent': info.get('agent'), 'slug': info.get('id'), 'version': '2.2.5',
                                     'location': {'directory': info.get('directory') or str(WORK)}})]
    if kind in ('session.updated', 'message.removed', 'message.part.removed', 'message.part.delta'):
        return []
    return [(kind, p)]


def v2_view(session):
    """The session's stored messages as 2.x's `/api/session/:id/message` lists them (schema/src/session-message.ts): in
    the order 2.x stored them, with each execution's idle message after the message it ended at. A message steered in
    is stored when 2.x delivers it (`v2_deliver`): before the first step answering it or a later one, or at the
    execution's end; not yet delivered, it is in the inbox only (`v2_inbox`)."""
    state = v2_of(session)
    idles = {}
    for n, idle in enumerate(state['idles']):
        idles.setdefault(idle['after'], []).append((n, idle))
    shells = {}
    for shell in state['shells']:
        shells.setdefault(shell['after'], []).append(shell)
    out, waiting = [], []

    def delivered(upto=None):
        # Those waiting, up to `upto` (all of them when None), as 2.x stored them on delivery.
        count = waiting.index(upto) + 1 if upto in waiting else (len(waiting) if upto is None else 0)
        for mid in waiting[:count]:
            info = messages[session][mid]['info']
            out.append({'id': mid, 'type': 'user', 'text': v2_payload(session, mid)['text'],
                        'time': {'created': (info.get('time') or {}).get('created', 0)}})
        del waiting[:count]

    for mid, stored in list(messages.get(session, {}).items()):
        info = stored['info']
        created = (info.get('time') or {}).get('created', 0)
        if info.get('role') == 'user' and mid in state['steer']:
            if mid in state['pending']:
                continue
            waiting.append(mid)
            if mid in idles:
                # Delivered at the execution's end that came right after it.
                delivered()
                for n, idle in idles.pop(mid):
                    out.append(v2_idle(n, idle, created))
            continue
        if info.get('role') == 'assistant' and not info.get('summary'):
            delivered(info.get('parentID'))
        if info.get('role') == 'user':
            if any(q.get('type') == 'compaction' for q in stored.get('parts', [])):
                pass
            else:
                text = ''.join(q.get('text', '') for q in stored.get('parts', []) if q.get('type') == 'text')
                out.append({'id': mid, 'type': 'user', 'text': text, 'time': {'created': created}})
        elif info.get('summary'):
            text = ''.join(q.get('text', '') for q in stored.get('parts', []) if q.get('type') == 'text')
            done = (info.get('time') or {}).get('completed')
            entry = {'id': mid, 'type': 'compaction', 'status': 'completed' if done else 'running', 'reason': 'auto', 'summary': text,
                     'time': {'created': created}}
            if info.get('error'):
                entry.update(status='failed', error=v2_error(info['error']))
            out.append(entry)
        else:
            content = [e for e in (v2_entry(q) for q in stored.get('parts', [])) if e is not None]
            answer = {'id': mid, 'type': 'assistant', 'agent': info.get('agent') or 'build',
                      'model': {'id': info.get('modelID') or 'fixture', 'providerID': info.get('providerID') or 'fixture'},
                      'content': content, 'time': {'created': created}}
            done = (info.get('time') or {}).get('completed')
            if done is not None:
                answer['time']['completed'] = done
            for name in ('finish', 'cost', 'tokens'):
                if info.get(name) is not None:
                    answer[name] = info[name]
            if info.get('error'):
                answer['error'] = v2_error(info['error'])
            out.append(answer)
        out.extend(v2_shell(shell) for shell in shells.pop(mid, []))
        ending = idles.pop(mid, [])
        if ending:
            delivered()
        for n, idle in ending:
            out.append(v2_idle(n, idle, created))
    delivered()
    for rest in shells.values():
        out.extend(v2_shell(shell) for shell in rest)
    return out


def v2_shell(shell):
    """A shell command's message as 2.x stores it (schema/src/session-message.ts Shell)."""
    entry = {'id': shell['id'], 'type': 'shell', 'shellID': shell['shellID'], 'command': shell['command'], 'status': shell['status'],
             'time': {'created': shell['created']}}
    if shell.get('exit') is not None:
        entry['exit'] = shell['exit']
        entry['output'] = {'output': shell['output'], 'cursor': len(shell['output']), 'size': len(shell['output']), 'truncated': False}
        entry['time']['completed'] = shell['created']
    return entry


def v2_idle(n, idle, created):
    entry = {'id': f'msg_idle{n:06d}', 'type': 'idle', 'outcome': idle['outcome'], 'time': {'created': created}}
    if idle.get('error'):
        entry['error'] = idle['error']
    return entry


def log(entry):
    with lock, (ROOT / 'calls.jsonl').open('a') as out:
        out.write(json.dumps(entry) + '\n')


def cursor_of(query):
    try:
        return json.loads(base64.urlsafe_b64decode(query['cursor'][0].encode())) if 'cursor' in query else {}
    except ValueError:
        return {}


def page(items, query, kept):
    """One page of a 2.x list (server/src/handlers/message.ts): `limit` (1..200, 50 by default), newest first unless
    `order` says, or the page a `cursor` names, which carries the rest and is not combined with `order`. Its
    `cursor.next` is set on every page that is not empty. The status and body to answer."""
    if 'cursor' in query and 'order' in query:
        return 400, {'_tag': 'InvalidRequestError', 'message': 'cursor cannot be combined with order'}
    if 'cursor' in query:
        at = cursor_of(query)
        if not at:
            return 400, {'_tag': 'InvalidCursorError', 'message': 'Invalid cursor'}
        start, order = at['at'], at['order']
        if any(query.get(name, [None])[0] not in (None, at['kept'].get(name)) for name in at['kept']):
            return 400, {'_tag': 'InvalidCursorError', 'message': 'the cursor is not of this list'}
    else:
        start, order = 0, query.get('order', ['desc'])[0]
    limit = int(query.get('limit', ['50'])[0])
    if not 1 <= limit <= 200:
        return 400, {'_tag': 'InvalidRequestError', 'message': 'limit must be 1..200'}
    ordered = items if order == 'asc' else list(reversed(items))
    data = ordered[start:start + limit]
    cursor = {}
    if data:
        token = json.dumps({'at': start + limit, 'order': order, 'kept': kept})
        cursor['next'] = base64.urlsafe_b64encode(token.encode()).decode()
    return 200, {'data': data, 'cursor': cursor}


def save():
    # Written whole or not at all (T-61 S0): into a file of its own beside state.json, then put in its place, so a process
    # ended in the middle of a save never leaves a cut state.json that its next start can't read (CI 42314910718).
    with lock:
        data = json.dumps({'sessions': sessions, 'messages': messages, 'counter': counter[0],
                           'durable': durable, 'aggregates': aggregates,
                           # 2.x stores its idle messages with the session's others,
                           # and its inbox.
                           'idles': {s: v['idles'] for s, v in v2_state.items()},
                           'inbox': {s: {'pending': v['pending'], 'steer': sorted(v['steer'])}
                                     for s, v in v2_state.items()},
                           'shells': {s: v['shells'] for s, v in v2_state.items()}})
        written = ROOT / f'state.json.{os.getpid()}.tmp'
        with open(written, 'w') as out:
            time.sleep(float(switch('slowSave') or 0))
            out.write(data)
        os.replace(written, ROOT / 'state.json')


def load():
    path = ROOT / 'state.json'
    if path.exists():
        state = json.loads(path.read_text())
        sessions.update(state['sessions'])
        messages.update(state['messages'])
        counter[0] = state['counter']
        durable.extend(state.get('durable', []))
        aggregates.update(state.get('aggregates', {}))
        for s, idles in state.get('idles', {}).items():
            v2_of(s)['idles'] = idles
        for s, inbox in state.get('inbox', {}).items():
            v2_of(s).update(pending=inbox['pending'], steer=set(inbox['steer']))
        for s, shells in state.get('shells', {}).items():
            v2_of(s)['shells'] = shells


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


def admit(session, message_id, text, files=(), model=None, announce=True, answered=None):
    """A user message admitted as 2.x admits a prompt's or a command's: steered in while a run goes on (delivered at
    that run's next step, v2_deliver), else queued and delivered at once; stored (`announce` false: with no event Core
    sees, as when its stream missed it, in the inbox only while a run goes on); `answered`; then the run starts and the
    session is busy until it ends."""
    if session in statuses:
        v2_of(session)['steer'].add(message_id)
        if not announce:
            v2_of(session)['pending'].append(message_id)
    store(session, message_id, text, files, model=model, announce=announce)
    if answered:
        answered()
    statuses[session] = {'type': 'busy'}
    publish('session.status', {'sessionID': session, 'status': {'type': 'busy'}})


def expand(template, text):
    """A command's template with its text (core/src/config/plugin/command.ts): `$ARGUMENTS` the whole text, `$1`…`$9` its
    whitespace-split words, one missing empty; in one pass, so nothing of the text is expanded again."""
    words = text.split()
    word = lambda n: words[n - 1] if n <= len(words) else ''
    return re.sub(r'\$(ARGUMENTS|[1-9])', lambda m: text if m.group(1) == 'ARGUMENTS' else word(int(m.group(1))), template)


def select(session, command):
    """A command's own `model` ("provider/model") and `agent` made the session's (core/src/config/plugin/command.ts), as
    switchModel makes a model its (`POST …/model`): kept for its next steps. 2.x also publishes `session.model.selected`
    and `session.agent.selected`; the stand-in sends neither, as it sends nothing for switchModel."""
    with lock:
        if isinstance(command.get('model'), str):
            provider, _, model_id = command['model'].partition('/')
            sessions[session]['model'] = {'id': model_id, 'providerID': provider}
        if isinstance(command.get('agent'), str):
            sessions[session]['agent'] = command['agent']
    save()


def answer_prompt(session, text=None, error=None, completed=True, parent=None, extra=None, files=None, raw_patches=None, raw_parts=None):
    """An assistant message answering the session's last prompt (or `parent`), with a text part.
    `extra` adds to its info what OpenCode reports of an answer: `tokens`, `providerID`/`modelID`, `summary`.
    `files` ({relative path: text, or None to delete}) are changed in the work folder as a run's tools change
    them, and named in a `patch` part whose hash is the snapshot from before (`session/processor.ts`); with
    snapshots off, no part. `raw_patches` are patch parts as they are ({hash, files}), such as one whose snapshot
    is gone; `raw_parts` any other parts, as they are (such as a `task` tool's, naming its sub-agent)."""
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
    for part in raw_parts or []:
        parts.append({'id': new_id('prt'), 'sessionID': session, 'messageID': info['id'], **part})
    with lock:
        messages.setdefault(session, {})[info['id']] = {'info': info, 'parts': parts}
    save()
    publish('message.updated', {'sessionID': session, 'info': info})
    for part in parts:
        publish('message.part.updated', {'sessionID': session, 'part': part, 'time': now})
    return info


WORK = Path.cwd().resolve()
# OpenCode's folders and switches as Core started it (T-32), before a switch below changes one.
GIVEN = {name: os.environ.get(name) for name in ('XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
                                                  'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_MODELS_FETCH')}
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


def forked_title(title):
    # `session/session.ts` getForkedTitle.
    found = re.match(r'^(.+) \(fork #(\d+)\)$', title)
    return f'{found.group(1)} (fork #{int(found.group(2)) + 1})' if found else f'{title} (fork #1)'


def project(event):
    """What OpenCode's v1 projectors make of a replayed durable event (T-10 Fork): here only the events a fork
    writes. Called with `lock` held. Afterwards this process's own IDs come after every ID it took in."""
    kind, data = event['type'], event['data']
    session = data['sessionID']
    if kind == 'session.created.1':
        sessions[session] = data['info']
        taken = [session]
    elif kind == 'message.updated.1':
        found = messages.setdefault(session, {}).get(data['info']['id'])
        messages[session][data['info']['id']] = {'info': data['info'], 'parts': found['parts'] if found else []}
        taken = [data['info']['id']]
    elif kind == 'message.part.updated.1':
        part = data['part']
        message = messages.setdefault(session, {}).setdefault(part['messageID'], {'info': None, 'parts': []})
        at = next((i for i, p in enumerate(message['parts']) if p['id'] == part['id']), None)
        if at is None:
            message['parts'].append(part)
        else:
            message['parts'][at] = part
        taken = [part['id']]
    else:
        raise ValueError(f'Unknown durable event type {kind}')
    for id in taken:
        tail = id.rsplit('_', 1)[-1]
        if tail.isdigit():
            counter[0] = max(counter[0], int(tail))


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


def pending_in(pending, session, request_id):
    # 2.x answers a request only as one pending in the session the route names. Called with `lock` held.
    return next((r for r in pending if r['id'] == request_id and r['sessionID'] == session), None)


def end_requests(session):
    """A run's requests ending with it, as 2.2.5's interrupt ends them: each permission request dropped with no event
    (probe p3), each form cancelled with `form.cancelled`."""
    with lock:
        dropped = [r for r in permissions if r['sessionID'] == session]
        ended = [f for f in forms if f['sessionID'] == session]
        without(permissions, dropped)
        without(forms, ended)
    for form in ended:
        send('form.cancelled', {'id': form['id'], 'sessionID': session})


# The error 2.2.5 leaves on the answer of a run it ended as one shutting down (probe p0: `{type: aborted}`).
STEP_INTERRUPTED = {'name': 'aborted', 'data': {'message': 'Step interrupted'}}


def shut_down(session):
    """As 2.2.5 ends a run once a permission request of it is rejected or its form declined (probe p0), as the
    interrupt ends one (the abort below) but as a shutdown: the requests left go with it, its answer is marked aborted
    ("Step interrupted"), and the execution ends with `session.execution.interrupted`, reason `shutdown`, the session
    idle and no idle message written. In the 1.19.3 mode, as the interrupt there: the aborted answer, then idle."""
    end_requests(session)
    if session in statuses and modes['abortEvidence']:
        answer_prompt(session, error=STEP_INTERRUPTED)
    if not v1():
        with lock:
            v2_of(session)['shutdown'] = True
    go_idle(session)


def mcp_settled(config):
    # The status an MCP server ends in (switch or mode `mcp`), with 2.x's error for one not connected.
    status = modes['mcp']
    if status in ('connected', 'pending'):
        return {'status': status}
    error = 'fixture: needs authentication' if status == 'needs_auth' else 'fixture: connection refused'
    if modes.get('mcpErrorEcho'):
        error += ' with ' + str((config.get('headers') or {}).get('Authorization'))
    return {'status': status, 'error': error}


def mcp_connect(name, config, location, why):
    # 2.x's startServer: `pending`, then the status it settles in, each with an `mcp.status.changed` (mcp/index.ts).
    settled, wait = mcp_settled(config), float(modes.get('mcpPendingFor') or 0)
    with lock:
        mcp_servers[name] = {'config': config, 'location': location, 'status': {'status': 'pending'} if wait else settled}
        mcp_connects.append({'name': name, 'why': why})
    if not wait:
        send('mcp.status.changed', {'server': name})
        return

    def later():
        time.sleep(wait)
        with lock:
            held = mcp_servers.get(name)
            if held is None or held['config'] != config:
                return
            held['status'] = settled
        send('mcp.status.changed', {'server': name})
    threading.Thread(target=later, daemon=True).start()


def control(name, body):
    if name == 'mode':
        modes.update(body)
        return modes
    if name == 'mcpDrop':
        # As 2.x unloads an idle folder (location-activity.ts) or reloads it: its runtime MCP servers go with it.
        with lock:
            dropped = sorted(mcp_servers)
            mcp_servers.clear()
        send('location.shutdown', {'location': {'directory': str(WORK)}})
        return {'dropped': dropped}
    if name == 'mcp':
        with lock:
            return {'servers': {name: {'status': s['status'], 'location': s['location']} for name, s in mcp_servers.items()},
                    'connects': list(mcp_connects)}
    if name == 'commands':
        # What 2.x's command route was sent (T-61 slice 3), read only.
        with lock:
            return {'seen': list(commands_seen)}
    if name == 'ask':
        # A permission request as 2.2.5 makes one (core/src/permission.ts), sent as 2.x sends it in every mode, the
        # 1.19.3 mode too: Core reads only 2.x's requests.
        request = {'id': new_id('per'), 'sessionID': body['sessionID'], 'action': body.get('action', 'shell'),
                   'resources': body.get('resources', ['ls']), 'save': body.get('save', ['ls *']),
                   'source': {'type': 'tool', 'id': 'call_1', 'messageID': 'msg_fixture'}}
        if body.get('message') is not None:
            request['message'] = body['message']
        with lock:
            permissions.append(request)
        send('permission.asked', request)
        return request
    if name == 'question':
        # A form as 2.2.5's question tool makes one (core/src/form.ts), in every mode; `kind` another form's.
        form = {'id': new_id('frm'), 'sessionID': body['sessionID'], 'title': body.get('title', 'Questions'),
                'metadata': {'kind': body.get('kind', 'question'), 'tool': {'id': 'call_1', 'messageID': 'msg_fixture'}},
                'fields': body.get('fields', [{'key': 'q0', 'type': 'string', 'custom': True, 'title': 'Pick',
                                               'description': 'Which one?',
                                               'options': [{'value': 'A', 'label': 'A', 'description': 'the first'}]}])}
        with lock:
            forms.append(form)
        send('form.created', {'form': form})
        return form
    if name == 'forget':
        # A request OpenCode no longer holds, with nothing said: an answer to it then meets 2.x's 404.
        with lock:
            gone = [r for r in permissions + forms if r['id'] == body['id']]
            without(permissions, gone)
            without(forms, gone)
        return {'forgotten': bool(gone)}
    if name == 'seed':
        # `count` stored messages and no event: a session long enough to page through, oldest first by creation.
        base, made = int(time.time() * 1000), []
        for i in range(body['count']):
            message_id = new_id('msg')
            info = {'id': message_id, 'sessionID': body['sessionID'], 'role': 'user', 'time': {'created': base + i}}
            part = {'id': new_id('prt'), 'sessionID': body['sessionID'], 'messageID': message_id, 'type': 'text',
                    'text': f'seeded {i}'}
            with lock:
                messages.setdefault(body['sessionID'], {})[message_id] = {'info': info, 'parts': [part]}
            made.append(message_id)
        save()
        return made
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
    if name == 'oauthComplete':
        # The provider finished an auto sign-in: 2.x keeps its credential (T-32 slice 4b).
        attempt = attempts[body['attemptID']]
        attempt['status'] = body.get('status', 'complete')
        if attempt['status'] == 'complete':
            add_credential(attempt['integration'], 'oauth', 'default', {'type': 'oauth', 'access': 'fixture-oauth-token'})
        return True
    if name == 'logins':
        return {'credentials': credentials, 'cancelled': cancelled}
    if name == 'shell':
        # A shell command run in the session, as 2.x runs one (`!`, T-32 slice 4a): its start and end events, and
        # its message under its start event's ID (core/src/session/message-updater.ts), after the newest message.
        session = body['sessionID']
        started = new_id('evt')
        entry = {'id': 'msg_' + started[len('evt_'):], 'shellID': new_id('sh'), 'command': body['command'], 'status': 'running',
                 'exit': None, 'output': '', 'created': int(time.time() * 1000), 'after': next(reversed(messages.get(session, {})), None)}
        with lock:
            v2_of(session)['shells'].append(entry)

        def shell():
            info = {'id': entry['shellID'], 'status': entry['status'], 'command': entry['command'], 'cwd': str(WORK), 'shell': '/bin/sh',
                    'file': '/tmp/fixture-shell.out'}
            if entry['exit'] is not None:
                info['exit'] = entry['exit']
            return info
        send('session.shell.started', {'sessionID': session, 'shell': shell()}, event_id=started)
        if body.get('end', True):
            entry.update(status='exited', exit=body.get('exit', 0), output=body.get('output', ''))
            size = len(entry['output'])
            send('session.shell.ended', {'sessionID': session, 'shell': shell(),
                                         'output': {'output': entry['output'], 'cursor': size, 'size': size, 'truncated': False}})
        save()
        return entry['id']
    if name == 'close':
        # A session's run ending: its pending requests go, and nothing says so.
        with lock:
            without(permissions, [r for r in permissions if r['sessionID'] == body['sessionID']])
            without(forms, [r for r in forms if r['sessionID'] == body['sessionID']])
        return True
    if name == 'busy':
        statuses[body['sessionID']] = {'type': 'busy'}
        publish('session.status', {'sessionID': body['sessionID'], 'status': {'type': 'busy'}})
        return True
    if name == 'event':
        if body.get('created'):
            # A 2.x event as the test times it, sent as it is.
            send(body['type'], body['properties'], body['created'])
        else:
            publish(body['type'], body['properties'])
        return True
    if name == 'store':
        return store(body['sessionID'], body['messageID'], body.get('text', ''))
    if name == 'reply':
        info = answer_prompt(body['sessionID'], body.get('text'), body.get('error'), body.get('completed', True), body.get('parentID'),
                             body.get('info'), body.get('files'), body.get('patches'), body.get('parts'))
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
        out = sys.stderr if body.get('stderr') else sys.stdout
        out.buffer.write(b'\xff' * body['bytes'] + b'\n')
        out.buffer.flush()
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

    def handle(self):
        with lock:
            active.add(self.connection)
        try:
            super().handle()
        finally:
            with lock:
                active.discard(self.connection)

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.route('GET')

    def do_POST(self):
        self.route('POST')

    def do_PATCH(self):
        self.route('PATCH')

    def do_PUT(self):
        self.route('PUT')

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

    def mcp_v2(self, method, name, rest, query, body):
        # 2.x's runtime MCP routes (2.2.5 protocol/src/groups/mcp.ts, server/src/handlers/mcp.ts): 204 each.
        location = query.get('location[directory]', [str(WORK)])[0]
        if method == 'PUT' and not rest:
            config = (body or {}).get('config')
            if modes.get('mcpRefuse'):
                return self.reply(400, {'_tag': 'InvalidRequestError', 'message': 'schema rejection: ' + json.dumps(body)})
            if not isinstance(config, dict) or config.get('type') != 'remote' or not isinstance(config.get('url'), str):
                return self.reply(400, {'_tag': 'InvalidRequestError', 'message': 'Invalid config'})
            with lock:
                held = mcp_servers.get(name)
                same = held is not None and held['config'] == config and held['location'] == location
            # The same configuration again changes nothing, a failed server's included (mcp/index.ts reconcile).
            if not same:
                mcp_connect(name, config, location, 'added' if held is None else 'changed')
            return self.reply(204)
        if method == 'POST' and rest == ['connect']:
            with lock:
                held = mcp_servers.get(name)
            if held is None or held['location'] != location:
                return self.reply(404, {'_tag': 'McpServerNotFoundError', 'message': f'MCP server {name} not found'})
            mcp_connect(name, held['config'], location, 'connect')
            return self.reply(204)
        return self.missing(f'MCP route {method} {name}/{"/".join(rest)}')

    def route(self, method):
        url = urlsplit(self.path)
        length = int(self.headers.get('content-length') or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        parts = [p for p in url.path.split('/') if p]
        if parts[:1] == ['__fixture']:
            return self.reply(200, control(parts[1], body or {}))
        authorized = self.headers.get('authorization') == AUTHORIZATION
        log({'method': method, 'path': url.path, 'query': parse_qs(url.query), 'body': body, 'authorized': authorized})
        # The instance the request names (`?directory=`), as OpenCode routes one.
        self.directory = parse_qs(url.query).get('directory', [''])[0]
        if not authorized:
            return self.reply(401)
        # A route that answers late (T-10), as a busy OpenCode might.
        if url.path in modes['slow']:
            time.sleep(modes['slow'][url.path])
        if url.path in modes['fail']:
            return self.reply(modes['fail'][url.path], {'name': 'UnknownError', 'data': {'message': 'fixture failure'}})
        if url.path in modes['html']:
            # As a route 2.x does not have answers a GET: its web UI's page.
            return self.page_html()
        key = (method, *parts)
        if key == ('GET', 'api', 'info'):
            # As 2.x (server/src/process.ts): 503 with retry-after while it starts, then its identity.
            if time.monotonic() - STARTED < float(switch('starting') or 0):
                self.send_response(503)
                self.send_header('retry-after', '1')
                payload = json.dumps({'code': 'service_starting'}).encode()
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            return self.reply(200, {'version': switch('version') or '2.2.5', 'pid': os.getpid(),
                                    'urls': [f'http://127.0.0.1:{self.server.server_address[1]}'], 'paths': {'tmp': '/tmp'}})
        if key == ('GET', 'api', 'event'):
            if time.time() < modes['refuseEventsUntil']:
                return self.reply(503, {'name': 'UnknownError', 'data': {'message': 'fixture: not now'}})
            return self.stream()
        if key == ('GET', 'path'):
            # `handlers/instance.ts` getPath: OpenCode's own folders and the instance's worktree and directory
            # (mode `directory`: another one, as if the instance were another folder's).
            return self.reply(200, {'home': HOME, 'state': STATE, 'config': CONFIG, 'worktree': str(WORK),
                                    'directory': modes['directory'] or str(WORK)})
        if key == ('GET', 'project', 'current'):
            return self.reply(200, {'id': current_project[0], 'worktree': str(WORK), 'vcs': 'git'})
        if key == ('POST', 'api', 'session'):
            # 2.x takes the session's folder from the body (server/src/handlers/session.ts).
            session = {'id': new_id('ses'), 'projectID': PROJECT, 'title': (body or {}).get('title', ''),
                       'directory': ((body or {}).get('location') or {}).get('directory', '')}
            sessions[session['id']] = session
            save()
            publish('session.created', {'sessionID': session['id'], 'info': session})
            return self.reply(200, {'data': session})
        if key == ('GET', 'api', 'session', 'active'):
            # 2.x lists the sessions this process runs, each as running (server/src/handlers/session.ts); mode
            # `activeShape` `list` answers another shape than 2.x's.
            running = [sid for sid, status in statuses.items() if status.get('type') != 'idle']
            if modes['activeShape'] == 'list':
                return self.reply(200, {'data': [{'id': sid, 'type': 'running'} for sid in running]})
            return self.reply(200, {'data': {sid: {'type': 'running'} for sid in running}})
        if key == ('GET', 'api', 'session'):
            query = parse_qs(url.query)
            # A next page's cursor carries the list's filters, as 2.x's does (schema/src/session.ts).
            parent = query.get('parentID', [None])[0] or cursor_of(query).get('kept', {}).get('parentID')
            listed = [s for s in sessions.values() if parent is None or s.get('parentID') == parent]
            return self.reply(*page(listed, query, {'parentID': parent}))
        if parts[:2] in (['api', 'integration'], ['api', 'credential']):
            return self.login(method, parts[1], parts[2:], body or {})
        if len(parts) >= 3 and parts[:2] == ['api', 'session']:
            return self.api_session(method, parts[2], parts[3:], parse_qs(url.query), body)
        if key == ('GET', 'mcp') and v1():
            return self.reply(200, mcp)
        if key == ('GET', 'api', 'mcp'):
            # Each server of the folder, its status only (2.2.5 core/src/mcp/index.ts `servers()`).
            location = parse_qs(url.query).get('location[directory]', [str(WORK)])[0]
            with lock:
                listed = [{'name': name, 'status': dict(server['status'])} for name, server in mcp_servers.items()
                          if server['location'] == location]
            return self.reply(200, {'location': {'directory': location}, 'data': listed})
        if parts[:3] == ['api', 'experimental', 'mcp'] and len(parts) in (4, 5):
            return self.mcp_v2(method, parts[3], parts[4:], parse_qs(url.query), body)
        if key == ('GET', 'config', 'providers'):
            return self.reply(200, modes['providers'])
        if key == ('GET', 'api', 'command'):
            # 2.x's own list (protocol/src/groups/command.ts): each command's name and description, nothing else of it.
            listed = [{'name': name, **({'description': c['description']} if c.get('description') else {})}
                      for name, c in (modes['config'].get('command') or {}).items()]
            return self.reply(200, {'location': {'directory': str(WORK)}, 'data': listed})
        if key == ('GET', 'api', 'model'):
            return self.reply(200, {'location': {'directory': str(WORK)}, 'data': v2_models()})
        if key == ('GET', 'api', 'provider'):
            return self.reply(200, {'location': {'directory': str(WORK)}, 'data': v2_providers()})
        if key == ('GET', 'config'):
            return self.reply(200, modes['config'])
        if key == ('POST', 'mcp') and v1():
            status = {'status': modes['mcp']}
            if modes['mcp'] == 'failed':
                status['error'] = 'fixture: connection refused'
            mcp[body['name']] = status
            return self.reply(200, {body['name']: status})
        if key == ('POST', 'sync', 'history'):
            return self.history(body)
        if key == ('POST', 'sync', 'replay'):
            return self.replay(body)
        if len(parts) >= 2 and parts[0] == 'session':
            return self.session(method, parts[1], parts[2:], body)
        if parts[:1] == ['api']:
            # An /api route 2.x does not have: an empty 404 (cli/src/services/web-ui.ts).
            return self.reply(404)
        if method == 'GET':
            # Any other GET is the web UI's page, 200 and HTML, with no password asked (cli/src/services/web-ui.ts).
            return self.page_html()
        return self.missing(url.path)

    def page_html(self):
        data = b'<!doctype html><html><head><title>OpenCode</title></head><body></body></html>'
        self.send_response(200)
        self.send_header('content-type', 'text/html; charset=utf-8')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def api_session(self, method, session, rest, query, body=None):
        # 2.x's own routes of one session (protocol/src/groups/session.ts, message.ts); what they hold keeps
        # 1.19.3's shape here until their slices.
        if session not in sessions:
            return self.reply(404, {'_tag': 'SessionNotFoundError', 'message': f'Session not found: {session}'})
        if (method, *rest) == ('GET',):
            # 2.x reads a model without a variant as its "default" one (core/src/session/info.ts).
            info = dict(sessions[session])
            if info.get('model'):
                info['model'] = {**info['model'], 'variant': info['model'].get('variant') or 'default'}
            return self.reply(200, {'data': info})
        if (method, *rest) == ('POST', 'prompt'):
            return self.prompt_v2(session, body or {})
        if (method, *rest) == ('POST', 'command'):
            return self.command_v2(session, body)
        if (method, *rest) == ('POST', 'model'):
            # 2.x's switchModel (T-32 slice 4a): the session's model for its next steps; 204.
            with lock:
                sessions[session]['model'] = (body or {}).get('model')
            save()
            return self.reply(204)
        if (method, *rest) == ('POST', 'interrupt'):
            # 2.x's interrupt: what 1.19.3's abort did, answered with whether a run was going on.
            return self.session('POST', session, ['abort'], body, interrupt=True)
        if method == 'GET' and len(rest) == 2 and rest[0] == 'message':
            # 2.x's one message, as its list holds it: once delivered (a message steered in waits in the inbox).
            if modes.get('failMessageReads'):
                return self.reply(500, {'_tag': 'UnknownError', 'message': 'fixture: message read failed'})
            listed = list(messages.get(session, {}).values()) if v1() else v2_view(session)
            found = next((m for m in listed if (m.get('info') or m).get('id') == rest[1]), None)
            between_reads(session)
            if found is None:
                return self.reply(404, {'_tag': 'MessageNotFoundError', 'message': f'Message not found: {rest[1]}'})
            return self.reply(200, {'data': found})
        if (method, *rest) == ('GET', 'message'):
            if modes['failListOnce']:
                modes['failListOnce'] = False
                return self.reply(500, {'_tag': 'UnknownError', 'message': 'fixture: list read failed'})
            if v1():
                stored = sorted(messages.get(session, {}).values(), key=lambda m: m['info']['time']['created'])
            else:
                stored = v2_view(session)
            return self.reply(*page(stored, query, {}))
        if (method, *rest) == ('GET', 'permission'):
            if modes['holdPermission']:
                # Once: this read waits for `release`, after the reads before it in a whole
                # session read (its messages, its status) have answered.
                modes['holdPermission'] = False
                waiter = threading.Event()
                with lock:
                    held_reads.append(waiter)
                waiter.wait(30)
            return self.reply(200, {'data': [p for p in permissions if p['sessionID'] == session]})
        if (method, *rest) == ('GET', 'form'):
            return self.reply(200, {'data': [f for f in forms if f['sessionID'] == session]})
        if method == 'POST' and len(rest) == 3 and rest[0] == 'permission' and rest[2] == 'reply':
            return self.permission_reply(session, rest[1], body)
        if method == 'POST' and len(rest) == 3 and rest[0] == 'form' and rest[2] == 'reply':
            return self.form_reply(session, rest[1], body)
        if method == 'DELETE' and len(rest) == 2 and rest[0] == 'form':
            return self.form_cancel(session, rest[1], query)
        if (method, *rest) == ('GET', 'inbox'):
            listed = [] if v1() else v2_inbox(session)
            between_reads(session)
            return self.reply(200, {'data': listed})
        return self.reply(404)

    def session(self, method, session, rest, body, interrupt=False):
        if session not in sessions:
            return self.missing(f'Session {session}')
        if (method, *rest) == ('POST', 'prompt_async'):
            return self.prompt(session, body)
        if (method, *rest) == ('POST', 'summarize'):
            return self.summarize(session, body)
        if (method, *rest) == ('POST', 'revert'):
            return self.revert(session, body)
        if (method, *rest) == ('POST', 'unrevert'):
            return self.unrevert(session)
        if (method, *rest) == ('POST', 'fork'):
            return self.fork(session, body)
        if method == 'DELETE' and len(rest) == 4 and rest[0] == 'message' and rest[2] == 'part':
            return self.delete_part(session, rest[1], rest[3])
        if method == 'GET' and len(rest) == 2 and rest[0] == 'message':
            if modes.get('failMessageReads'):
                return self.reply(500, {'name': 'UnknownError', 'data': {'message': 'fixture: message read failed'}})
            found = messages.get(session, {}).get(rest[1])
            return self.reply(200, found) if found else self.missing(f'Message {rest[1]}')
        if (method, *rest) == ('POST', 'abort'):
            # The run ends; its pending requests go with it (as 2.2.5's interrupt ends them: `end_requests`), and
            # (as OpenCode does) its answer is marked aborted.
            running = session in statuses
            end_requests(session)
            self.reply(200, {'interrupted': running} if interrupt else True)
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

    def login(self, method, group, rest, body):
        """2.x's integration and credential routes (protocol/src/groups/integration.ts, credential.ts; T-32 slice 4b).
        A key is kept as given; mode `oauth` names each method's sign-in (`url`, `mode`), completed by control
        `oauthComplete` (auto) or by its code (code mode); mode `loginRefuse` refuses a key with 400, its answer echoing
        what it was sent. `GET /api/credential` answers the values, as 2.x's does: Core must never ask."""
        if group == 'credential':
            if method == 'GET' and not rest:
                return self.reply(200, {'data': [dict(c, id=cid) for cid, c in credentials.items()]})
            if method == 'DELETE' and len(rest) == 1 and rest[0] in credentials:
                with lock:
                    credentials.pop(rest[0])
                return self.reply(204)
            return self.reply(404, {'_tag': 'CredentialNotFoundError', 'message': 'fixture: no such credential'})
        if method == 'GET' and not rest:
            return self.reply(200, {'location': {'directory': str(WORK)}, 'data': v2_integrations()})
        if not rest or rest[0] not in {i['id'] for i in v2_integrations()}:
            return self.reply(404, {'_tag': 'IntegrationNotFoundError', 'message': 'fixture: no such integration'})
        integration, rest = rest[0], rest[1:]
        if (method, *rest) in (('POST', 'connect', 'key'), ('POST', 'connect', 'oauth')):
            kind = rest[1]
            why = v2_answer_refused(v2_method(integration, kind, body.get('methodID') if kind == 'oauth' else None), body.get('answer'), kind)
            if why:
                return self.reply(400, {'_tag': 'AuthorizationError', 'kind': 'integration_authorization', 'message': f'fixture: {why}'})
        if (method, *rest) == ('POST', 'connect', 'key'):
            if modes['loginRefuse']:
                return self.reply(400, {'_tag': 'InvalidRequestError', 'kind': 'integration_authorization',
                                        'message': f'fixture: refused {json.dumps(body)}'})
            add_credential(integration, 'key', body.get('label') or 'default', {'type': 'api', 'key': body.get('key')})
            return self.reply(204)
        if (method, *rest) == ('POST', 'connect', 'oauth'):
            flow = modes['oauth'].get(body.get('methodID'))
            if flow is None:
                return self.reply(400, {'_tag': 'InvalidRequestError', 'kind': 'integration_method', 'message': 'fixture: no such method'})
            attempt, now = new_id('con'), int(time.time() * 1000)
            with lock:
                attempts[attempt] = {'integration': integration, 'method': body.get('methodID'), 'status': 'pending',
                                     'mode': flow.get('mode', 'auto'), 'answer': body.get('answer'),
                                     'time': {'created': now, 'expires': now + 600000}}
            return self.reply(200, {'data': {'attemptID': attempt, 'url': flow['url'], 'mode': flow.get('mode', 'auto'),
                                             'instructions': flow.get('instructions', 'Enter code ABCD-1234'),
                                             'time': attempts[attempt]['time']}})
        if len(rest) >= 3 and rest[:2] == ['connect', 'oauth'] and rest[2] in attempts:
            attempt = attempts[rest[2]]
            if (method, *rest[3:]) == ('GET',):
                if modes['holdOauthStatus']:
                    # Once: this read of a sign-in waits for `release`, as held reads do.
                    modes['holdOauthStatus'] = False
                    waiter = threading.Event()
                    with lock:
                        held_reads.append(waiter)
                    waiter.wait(30)
                out = {'status': attempt['status'], 'time': attempt['time']}
                if attempt['status'] == 'failed':
                    out['message'] = 'fixture: the provider refused it'
                return self.reply(200, {'data': out})
            if (method, *rest[3:]) == ('DELETE',):
                with lock:
                    attempts.pop(rest[2])
                    cancelled.append(rest[2])
                return self.reply(204)
            if (method, *rest[3:]) == ('POST', 'complete'):
                if attempt['mode'] != 'code':
                    # 2.x dies on completing an auto attempt (core/src/integration.ts).
                    return self.reply(500, {'_tag': 'UnknownError', 'message': 'fixture: not a code attempt'})
                if not body.get('code'):
                    return self.reply(400, {'_tag': 'InvalidRequestError', 'kind': 'integration_code_required', 'message': 'fixture'})
                attempt['status'] = 'complete'
                add_credential(integration, 'oauth', 'default', {'type': 'oauth', 'access': 'fixture-oauth-' + body['code']})
                return self.reply(204)
        if len(rest) >= 3 and rest[:2] == ['connect', 'oauth']:
            return self.reply(404, {'_tag': 'IntegrationAttemptNotFoundError', 'message': 'fixture: no such attempt'})
        return self.reply(404)

    def prompt_v2(self, session, body):
        """As 2.x's prompt (protocol/src/groups/session.ts session.prompt, T-32 slice 4a): its text and files, each a
        `data:` URI, under its `id`; answered with the message as admitted, or a ConflictError (409) for an ID the
        session holds already. Its model is the session's, as switchModel made it. The 1.19.3 prompt's modes apply."""
        files = []
        for f in body.get('files') or []:
            uri = f.get('uri') or ''
            if not uri.startswith('data:'):
                return self.reply(400, {'_tag': 'InvalidRequestError', 'message': 'fixture: a file here is a data: URI'})
            files.append({'type': 'file', 'mime': uri[5:].split(';', 1)[0], 'filename': f.get('name'), 'url': uri})
        message_id = body.get('id') or new_id('msg')
        if message_id in messages.get(session, {}) or message_id in v2_of(session)['pending']:
            return self.reply(409, {'_tag': 'ConflictError', 'message': f'Message already exists: {message_id}'})
        old = {'messageID': message_id, 'parts': [{'type': 'text', 'text': body.get('text', '')}, *files]}
        current = sessions[session].get('model')
        if current:
            old['model'] = {'providerID': current.get('providerID'), 'modelID': current.get('id')}
            if current.get('variant'):
                old['variant'] = current['variant']
        return self.prompt(session, old, admitted=True)

    def prompt(self, session, body, admitted=False):
        # 2.x answers with the message admitted (`admitted`); 1.19.3's prompt_async, 204. Mode `renamed`: stored, and
        # answered as another message's admission.
        accepted = lambda: self.reply(200, {'data': {'id': new_id('msg') if mode == 'renamed' else message_id, 'sessionID': session,
                                                     'type': 'user', 'delivery': 'steer',
                                                     'payload': {'text': text}, 'time': {'created': int(time.time() * 1000)}}}) \
            if admitted else self.reply(204)
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
        if mode in ('store', 'renamed', 'store-unannounced'):
            # `store-unannounced`: admitted with no event Core sees (its stream missed it).
            admit(session, message_id, text, files, model=model, announce=mode != 'store-unannounced', answered=accepted)
            return None
        if mode == 'unstored':
            # Answered, then storing failed; OpenCode's session.error names no message. 2.x says nothing of it.
            accepted()
            if v1():
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

    def command_v2(self, session, body):
        """As 2.x's command (2.2.5 protocol/src/groups/session.ts session.command, core/src/config/plugin/command.ts; T-61
        slice 3): `{name, text}` (`files`, `agents`, `skills`, `delivery` may come too), no message ID and no model; each
        request is kept in `commands_seen`. A name mode `config` has no command of: 404 CommandNotFoundError. A config
        command's own `model` and `agent` become the session's (`select`), a revert waiting in the session is applied,
        and its template, expanded with the text (`expand`), is admitted as a prompt's message is (`admit`), under an ID
        of the stand-in's own, with the session's model; answered 204 once admitted, the run going on as a prompt's. A
        `subtask` one starts a sub-agent session under this one instead (control `child`) and admits nothing here. Mode
        `command`: `run`; `fail` (500 CommandExecutionError, nothing done); `fail-after` (admitted, then that 500);
        `nothing` (204, nothing done, as `/goal pause`); `unannounced` (admitted with no event for its message or a
        sub-agent's session, as prompt's `store-unannounced`); `slow` (`run` after `commandDelay` seconds, 3 by default);
        `drop` (nothing done, and the connection ends with no answer)."""
        body = body if isinstance(body, dict) else {}
        name, text = body.get('name'), body.get('text')
        with lock:
            commands_seen.append({'sessionID': session, 'name': name, 'text': text, 'keys': sorted(body)})
        if not isinstance(name, str) or not isinstance(text, str):
            return self.reply(400, {'_tag': 'InvalidRequestError', 'message': 'fixture: a command takes a name and a text'})
        command = (modes['config'].get('command') or {}).get(name)
        if command is None:
            # 2.2.5's own words for it (probe T-61 S3 p1 fecf3048).
            return self.reply(404, {'_tag': 'CommandNotFoundError', 'command': name, 'message': f'Command not found: {name}'})
        mode = modes['command']
        if mode not in ('run', 'fail', 'fail-after', 'nothing', 'unannounced', 'slow', 'drop'):
            return self.reply(500, {'_tag': 'UnknownError', 'message': f'fixture: no command mode {mode}'})
        failed = lambda: self.reply(500, {'_tag': 'CommandExecutionError', 'command': name, 'message': 'fixture: the command failed'})
        if mode == 'drop':
            self.close_connection = True
            return None
        if mode == 'fail':
            return failed()
        if mode == 'nothing':
            return self.reply(204)
        if mode == 'slow':
            time.sleep(float(modes.get('commandDelay', 3)))
        if command.get('subtask'):
            agent = command.get('agent', 'general')
            control('child', {'parentID': session, 'title': f'{command.get("description", "")} (@{agent} subagent)', 'agent': agent,
                              'announce': mode != 'unannounced'})
            return failed() if mode == 'fail-after' else self.reply(204)
        cleanup(session)
        select(session, command)
        current = sessions[session].get('model')
        model = {'providerID': current.get('providerID'), 'modelID': current.get('id')} if current else modes['defaultModel']
        admit(session, v2_message_id(), expand(command['template'], text), model=model, announce=mode != 'unannounced',
              answered=None if mode == 'fail-after' else (lambda: self.reply(204)))
        return failed() if mode == 'fail-after' else None

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
        then 200 with no revert kept), `encode-fail` (done, then 400 as OpenCode answers a response it
        cannot encode: `BadRequest` of kind `Body`)."""
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
        if mode == 'encode-fail':
            return self.reply(400, {'name': 'BadRequest', 'data': {'message': 'fixture: the answer could not be encoded', 'kind': 'Body'}})
        if mode == 'late':
            go_on = threading.Event()
            reverting[session] = go_on
            go_on.wait(60)
        return self.reply(200, info)

    def fork(self, session, body):
        """As OpenCode 1.19.3's `Session.fork` (`session/session.ts`, `handlers/session.ts`): a new session in
        the instance the request names, holding a copy of every message before `messageID` under new IDs, each
        part under a new ID, an answer's `parentID` mapped to its copied parent (kept as it was if that is not
        copied), a compaction part's `tail_start_id` mapped (dropped if not copied). Nothing is checked: a
        `messageID` the session does not hold copies every message, and a busy session or a waiting revert is
        copied as it is. The new session has no parent, agent, model, permission or revert. Modes (`fork`):
        `lost` (done, then no answer), `fail` (the session and its first message written, then a 500),
        `unmapped` (the first answer keeps its old `parentID`), `hold` (held until `goOn`, then done)."""
        cutoff = (body or {}).get('messageID')
        if cutoff is not None and not (isinstance(cutoff, str) and cutoff.startswith('msg')):
            return self.reply(400, {'name': 'BadRequest', 'data': {}})
        mode = modes['fork']
        if mode == 'hold':
            # Held before anything is written, until the test lets it go (`goOn`).
            waiter = threading.Event()
            with lock:
                reverting[session] = waiter
            waiter.wait(30)
        original = sessions[session]
        now = int(time.time() * 1000)
        info = {'id': new_id('ses'), 'projectID': PROJECT, 'directory': self.directory,
                'title': forked_title(original.get('title', '')), 'time': {'created': now, 'updated': now}}
        for name in ('workspaceID', 'metadata'):
            if original.get(name) is not None:
                info[name] = json.loads(json.dumps(original[name]))
        with lock:
            sessions[info['id']] = info
        save()
        publish('session.created', {'sessionID': info['id'], 'info': info})
        stored = ordered(session)
        target = next((i for i, m in enumerate(stored) if m['info']['id'] == cutoff), len(stored))
        ids, unmapped = {}, mode == 'unmapped'
        for index, message in enumerate(stored[:target]):
            copied = json.loads(json.dumps(message['info']))
            copied.update({'id': new_id('msg'), 'sessionID': info['id']})
            ids[message['info']['id']] = copied['id']
            parent = message['info'].get('parentID')
            if copied['role'] == 'assistant' and parent in ids:
                if unmapped:
                    unmapped = False
                else:
                    copied['parentID'] = ids[parent]
            parts = []
            for part in message['parts']:
                part = json.loads(json.dumps(part))
                part.update({'id': new_id('prt'), 'messageID': copied['id'], 'sessionID': info['id']})
                if part.get('type') == 'compaction' and part.get('tail_start_id'):
                    if part['tail_start_id'] in ids:
                        part['tail_start_id'] = ids[part['tail_start_id']]
                    else:
                        del part['tail_start_id']
                parts.append(part)
            with lock:
                messages.setdefault(info['id'], {})[copied['id']] = {'info': copied, 'parts': parts}
            save()
            publish('message.updated', {'sessionID': info['id'], 'info': copied})
            for part in parts:
                publish('message.part.updated', {'sessionID': info['id'], 'part': part, 'time': now})
            if mode == 'fail':
                return self.reply(500, {'name': 'UnknownError', 'data': {'message': 'fixture: fork failed part way'}})
        if mode == 'lost':
            self.close_connection = True
            return None
        return self.reply(200, info)

    def history(self, body):
        """As OpenCode 1.19.3's `/sync/history` (`handlers/sync.ts`): every durable event in the database, by
        sequence number across aggregates, but those at or before the sequence the body gives for their
        aggregate. Modes (`history`): `fail` (a 500), `{'noise': n}` (also an event of another session holding
        n bytes)."""
        known = body or {}
        if not isinstance(known, dict) or any(not isinstance(v, int) or v < 0 for v in known.values()):
            return self.reply(400, {'name': 'BadRequest', 'data': {}})
        mode = modes['history']
        if mode == 'fail':
            return self.reply(500, {'name': 'UnknownError', 'data': {'message': 'fixture: history failed'}})
        with lock:
            rows = [r for r in durable if not (r['aggregate_id'] in known and r['seq'] <= known[r['aggregate_id']])]
        if isinstance(mode, dict) and mode.get('noise'):
            rows = [{'id': 'evt_noise', 'aggregate_id': 'ses_noise', 'seq': 0, 'type': 'session.updated.1',
                     'data': {'sessionID': 'ses_noise', 'info': {'title': 'n' * mode['noise']}}}] + rows
        return self.reply(200, sorted(rows, key=lambda r: r['seq']))

    def replay(self, body):
        """As OpenCode 1.19.3's `/sync/replay` (`handlers/sync.ts`, `core/src/event.ts` replayAll): one
        aggregate's events, numbered on from the first with no gap; each committed on its own, projected first.
        One already stored at its number is passed over if it is the same event (ID, type, data); otherwise
        the replay ends there ("diverged"), as does a gap after what is stored or an event ID stored before.
        Modes (`replay`): `{'failAfter': k}` (k events committed, then a 500), `lost` (all committed, then no
        answer), `tamper` (each text part kept with other text, as a projection that went wrong)."""
        events = (body or {}).get('events')
        if not isinstance((body or {}).get('directory'), str) or not isinstance(events, list) or not events:
            return self.reply(400, {'name': 'BadRequest', 'data': {}})
        def fail(message):
            return self.reply(500, {'name': 'UnknownError', 'data': {'message': message}})
        source = events[0]['aggregateID']
        if any(e['aggregateID'] != source for e in events):
            return fail('Replay events must belong to the same aggregate')
        if any(e['seq'] != events[0]['seq'] + i for i, e in enumerate(events)):
            return fail('Replay sequence mismatch')
        mode = modes['replay']
        for index, event in enumerate(events):
            if isinstance(mode, dict) and index == mode.get('failAfter'):
                return fail('fixture: replay failed part way')
            refused = None
            with lock:
                latest = aggregates.get(source, -1)
                if event['seq'] <= latest:
                    stored = next((r for r in durable if r['aggregate_id'] == source and r['seq'] == event['seq']), None)
                    if not (stored and stored['id'] == event['id'] and stored['type'] == event['type']
                            and stored['data'] == event['data']):
                        refused = f"Replay diverged at aggregate {source} sequence {event['seq']}"
                elif event['seq'] != latest + 1:
                    refused = f"Sequence mismatch for aggregate {source}: expected {latest + 1}, got {event['seq']}"
                elif any(r['id'] == event['id'] for r in durable):
                    refused = f"Event {event['id']} already exists"
                else:
                    try:
                        if mode == 'tamper' and event['type'] == 'message.part.updated.1' and event['data']['part'].get('type') == 'text':
                            event = json.loads(json.dumps(event))
                            event['data']['part']['text'] = 'tampered'
                        project(event)
                    except ValueError as error:
                        refused = str(error)
                    else:
                        aggregates[source] = event['seq']
                        durable.append({'id': event['id'], 'aggregate_id': source, 'seq': event['seq'],
                                        'type': event['type'], 'data': event['data']})
            if refused:
                return fail(refused)
            save()
        if mode == 'lost':
            self.close_connection = True
            return None
        return self.reply(200, {'sessionID': source})

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

    def permission_reply(self, session, request_id, body):
        """2.x's answer to a permission request (2.2.5 core/src/permission.ts): `decision` `once` or `reject`, 204. One
        not pending in this session (unknown, answered, another session's) is a 404 that answers nothing. A reject
        rejects every other request pending in the session too, then the run ends as one shutting down (`shut_down`).
        Core never sends `always` or a `message`: each is refused (400) here, answering nothing."""
        body = body if isinstance(body, dict) else {}
        decision = body.get('decision')
        if decision == 'always':
            return self.reply(400, {'_tag': 'InvalidRequestError', 'message': 'fixture: always is not expected'})
        if decision not in ('once', 'reject'):
            return self.reply(400, {'_tag': 'InvalidRequestError', 'message': f'Invalid decision: {decision}'})
        if 'message' in body:
            return self.reply(400, {'_tag': 'InvalidRequestError', 'message': 'fixture: a message is not expected'})
        with lock:
            found = pending_in(permissions, session, request_id)
            gone = [found] if found else []
            if found and decision == 'reject':
                # 2.x rejects every other request pending in the session with it, each after it.
                gone += [r for r in permissions if r is not found and r['sessionID'] == session]
            without(permissions, gone)
        if found is None:
            return self.reply(404, {'_tag': 'PermissionNotFoundError', 'requestID': request_id, 'message': 'Permission request not found'})
        for request in gone:
            send('permission.replied', {'sessionID': session, 'requestID': request['id'], 'reply': decision})
        lost = modes['replyLost']
        if lost:
            # Taken, and its answer lost on the way back (T-61 S2 R1): the connection cut with no answer (`cut`), or
            # a server error (a status); a reject's run ends half a second after Core has read that.
            if decision == 'reject':
                threading.Timer(0.5, shut_down, [session]).start()
            if lost == 'cut':
                self.close_connection = True
                return None
            return self.reply(lost, {'_tag': 'UnknownError', 'message': 'the answer was lost'})
        self.reply(204)
        if decision == 'reject':
            shut_down(session)
        return None

    def form_reply(self, session, form_id, body):
        """2.x's answer to a form (2.2.5 core/src/form.ts): `answer`, each field's value by its key, 204 and
        `form.replied`. One not pending in this session is a 404; an answer it can't take (`form_answer_refused`) a 400,
        the form still pending."""
        answer = body.get('answer') if isinstance(body, dict) else None
        if not isinstance(answer, dict):
            return self.reply(400, {'_tag': 'InvalidRequestError', 'message': 'Invalid answer'})
        with lock:
            found = pending_in(forms, session, form_id)
            why = form_answer_refused(found, answer) if found else None
            if found and not why:
                without(forms, [found])
        if found is None:
            return self.reply(404, {'_tag': 'FormNotFoundError', 'id': form_id, 'message': 'Form not found'})
        if why:
            return self.reply(400, {'_tag': 'FormInvalidAnswerError', 'id': form_id, 'message': why})
        send('form.replied', {'id': form_id, 'sessionID': session, 'answer': answer})
        return self.reply(204)

    def form_cancel(self, session, form_id, query):
        """2.x's decline of a form (2.2.5 core/src/form.ts): 204 and `form.cancelled`, then the run ends as after a
        reject (`shut_down`). One not pending in this session is a 404. Core sends no `message`: one is refused (400)."""
        if 'message' in query:
            return self.reply(400, {'_tag': 'InvalidRequestError', 'message': 'fixture: a message is not expected'})
        with lock:
            found = pending_in(forms, session, form_id)
            if found:
                without(forms, [found])
        if found is None:
            return self.reply(404, {'_tag': 'FormNotFoundError', 'id': form_id, 'message': 'Form not found'})
        send('form.cancelled', {'id': form_id, 'sessionID': session})
        self.reply(204)
        shut_down(session)
        return None

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
            send({'id': new_id('evt'), 'type': 'server.connected', 'data': {}})
            beat = time.monotonic()
            while generation[0] == current:
                try:
                    send(mine.get(timeout=0.02))
                except queue.Empty:
                    pass
                every = modes['heartbeat']
                if every and time.monotonic() - beat >= every:
                    # 2.x's heartbeat is a comment, not an event (server/src/handlers/event.ts).
                    self.wfile.write(b': heartbeat\n\n')
                    self.wfile.flush()
                    beat = time.monotonic()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with lock:
                streams.remove(mine)


def teardown(signum, frame):
    """As 2.x after SIGTERM (cli/src/shutdown-deadline.ts): its teardown,
    which takes `teardown` seconds here, ends what its tools run (SIGTERM to
    each one's session, then waited for), and it exits."""
    if switch('closeStreamsFirst'):
        # 2.x closes what it serves early in its teardown, before its tools' processes end: its event streams,
        # and every request still being served, whose client then lets go of it.
        with lock:
            generation[0] += 1
            served = list(active)
        for connection in served:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
    time.sleep(float(switch('teardown') or 0))
    for tool in tools:
        try:
            os.killpg(tool.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        tool.wait()
    # No save is cut short: one under way holds `lock`, and ends before this exits (T-61 S0). Bounded, should the
    # handler run in the thread that holds it.
    lock.acquire(timeout=10)
    os._exit(0)


def main():
    argv = sys.argv[1:]
    if argv == ['--version']:
        # As `opencode --version`: 2.x prints `opencode v2.2.5`, 1.x its bare version (switch `versionLine`).
        print(switch('versionLine') or f"opencode v{switch('version') or '2.2.5'}")
        return
    if any(arg.startswith('--mdns') for arg in argv):
        # As 2.x, which has no mDNS option: a flag it does not know ends it.
        sys.stderr.write('\x1b[31mERROR\x1b[0m\nUnrecognized flag: --mdns in command opencode serve\n')
        sys.exit(1)
    new = not (ROOT / 'state.json').exists()
    # A save file a stand-in killed in the middle of a save left beside its state (T-61 S0, R1 note): never read,
    # removed once the process that wrote it is gone.
    for stale in ROOT.glob('state.json.*.tmp'):
        try:
            os.kill(int(stale.name.split('.')[2]), 0)
        except (ValueError, IndexError, ProcessLookupError):
            stale.unlink(missing_ok=True)
        except PermissionError:
            pass
    load()
    modes['mcp'] = switch('mcp') or 'connected'
    # The MCP modes a test needs before the Agent first connects, from switches of the same names.
    for name in ('mcpPendingFor', 'mcpRefuse', 'mcpErrorEcho'):
        if switch(name) is not None:
            modes[name] = switch(name) or True
    # Modes for a process started on a new database (T-10 Fork), as a fork's target is: a test cannot leave
    # a switch in a folder it does not know yet, so it leaves them beside every Agent's.
    planned = ROOT.parent / 'fixture-new.json'
    if new and planned.exists():
        modes.update(json.loads(planned.read_text()))
    with (ROOT / 'starts.jsonl').open('a') as out:
        out.write(json.dumps({'pid': os.getpid(), 'new': new}) + '\n')
    # Stands in for OpenCode's own children (language servers, MCP servers).
    child = subprocess.Popen(['sleep', '600'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
    seen = {'argv': argv, 'cwd': os.getcwd(), 'pid': os.getpid(), 'pgid': os.getpgid(0), 'child': child.pid,
            'database': os.environ.get('OPENCODE_DB'), 'env': GIVEN, 'passwordFrom': PASSWORD_FROM, 'passwordLength': len(PASSWORD),
            'passwordInArgv': bool(PASSWORD) and any(PASSWORD in arg for arg in argv)}
    if switch('stubborn'):
        # As a server, or a tool it runs, that does not stop on SIGTERM.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        seen['stubborn'] = subprocess.Popen(
            [sys.executable, '-c', 'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(600)'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).pid
    else:
        signal.signal(signal.SIGTERM, teardown)
    if switch('tool'):
        tool = subprocess.Popen(['sleep', '600'], start_new_session=True, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tools.append(tool)
        seen['tool'] = tool.pid
    if switch('exit'):
        (ROOT / 'start.json').write_text(json.dumps(seen))
        # What it says on stderr as it goes (switch `exitStderr`), as 2.x does for a flag it does not know.
        if switch('exitStderr'):
            sys.stderr.write(switch('exitStderr') + '\n')
            sys.stderr.flush()
        sys.exit(3)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    seen['port'] = server.server_address[1]
    (ROOT / 'start.json').write_text(json.dumps(seen))
    if switch('noise'):
        # A line longer than Core reads at once, and not UTF-8.
        sys.stdout.buffer.write(b'\xfe' * 100_000 + b'\n')
    print('INFO fixture starting', flush=True)
    said = 'opencode server listening on' if switch('line1x') else 'server listening on'
    print(f'{said} http://{switch("host") or "127.0.0.1"}:{seen["port"]}', flush=True)
    server.serve_forever()


main()
