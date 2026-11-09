#!/usr/bin/env python3
"""A stand-in `opencode serve`, for tests/opencode_transport.rs and the
suites that start OpenCode. It starts, answers `/api/info` and stops as
OpenCode 2.x does (T-32 slice 2: 2.2.5's flags, listening line, password
variable and teardown on SIGTERM); its other routes are 2.x's too (T-32,
T-61), over a store kept in OpenCode 1.19.3's shape (`v2_events`, `v2_view`).
It reads only its arguments and
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
error.
Permission requests and forms are 2.x's (T-61 slice 2): made by controls `ask` and
`question`, listed per session (`GET /api/session/:id/permission`, `…/form`) and answered by 2.x's routes (`POST
…/permission/:id/reply`, `POST …/form/:id/reply`, `DELETE …/form/:id`): 204, 404 for one not pending in that session,
400 for a form answer 2.x can't take (the form stays pending). A reject or a declined form ends the run as 2.2.5 ends
one shutting down (`session.execution.interrupted`, reason `shutdown`, and no idle message); an interrupt drops the
session's permission requests with nothing said and cancels its forms. Control `forget` drops one with nothing said, as
if OpenCode no longer held it.
Commands are 2.x's (T-61 slice 3): listed by name and description (`GET /api/command`) and run by `POST
/api/session/:id/command` (mode `command`).
Compaction is 2.x's (T-61 slice 4): `POST /api/session/:id/compact` admits one into the session's inbox and answers at
once; it then runs as 2.x's does (`session.compaction.*`), its message under the ID it was admitted under (`compact_v2`).
Mode `compact`: `run`, `hold` (until control `finishCompaction` or an interrupt), `fail`, `unavailable`, `late`, `drop`,
`drop-unadmitted`, `refuse-404`, `invalid-400`, `conflict-409`, `500`, `500-admitted`, `other-pending`. Control
`autoCompact` runs one of 2.x's own; `compacts` lists what the route was sent.
Reverts are 2.x's too (T-61 slice 6): staged from each later step's snapshot (`POST
/api/session/:id/revert/stage`, mode `stage`, `stage_v2`), committed (`POST …/revert/commit`, mode `commit`) or cleared
(`DELETE …/revert`); new input (a prompt, a command, a compaction) commits a staged one first (`v2_commit`).
Sessions are 2.x's (T-61 slice 7, `v2_info`): `POST /api/session`, `GET /api/session/:id` and the
list answer `location: {directory}`, `cost`, `tokens` and `time` (ms; `busy`, `idle` and `outcome` as each execution
starts and ends, `v2_mark`), and no top-level `directory` or `workspaceID`. A session is imported (`POST
/api/experimental/session/import`, `import_v2`) under the ID its body gives, and exported (`GET
/api/experimental/session/:id/export`), settled messages only (`settled`); what was imported is listed as it was sent,
before what the session stores later (`v2_view`). Mode `import`: `ok`, `lost`, `hold` (until `goOn` with that ID), `fail`,
`tamper`, `conflict-other`.
Sessions and messages are kept in state.json there, as OpenCode keeps them
in its database; pending requests, as in OpenCode, live only in the process. Routes under
/__fixture/ are the test's own controls and need no password.
Its data folder is worked out as OpenCode's (XDG_DATA_HOME, else HOME). Snapshots of the work folder go
into a real Git store in OpenCode's own layout (<data>/snapshot/<project>/<sha1 of the worktree>), only
when XDG_DATA_HOME is a folder a test marked with a `.yuzuno-fixture` file; otherwise they are off, as
with OpenCode's `snapshot: false`, and no Git runs on any store (a restore is then refused, as 2.x
refuses one: `v2_restore`).
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

# OpenCode's configured providers (T-10), which 2.x's lists are made of (`v2_models`, `v2_providers`,
# `v2_integrations`): each with the fields that can hold credentials (`key`, `options`, `env`, and
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

# OpenCode's whole configuration (T-10). As in
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
sessions, messages, statuses, permissions, forms = {}, {}, {}, [], []
# The messages 2.x imported into a session (T-61 slice 7, `import_v2`), by session: in 2.x's shape, as they were sent.
imported = {}
# 2.x's MCP servers added at runtime (T-61 slice 1), by name: their configuration, status and folder; and each
# connection it made of one (a name and why), which the same configuration added again does not make.
mcp_servers, mcp_connects = {}, []
# Each command request 2.x's route took (T-61 slice 3), in order: its session, `name`, `text` and the body's keys (control
# `commands`).
commands_seen = []
# Each compaction request 2.x's route took (T-61 slice 4), in order: its session, the body's `id`, `delivery` and keys
# (control `compacts`).
compacts_seen = []
modes = {'prompt': 'store', 'mcp': 'connected', 'fail': {}, 'slow': {}, 'heartbeat': 0.2, 'abortEvidence': True,
         'abortOrder': 'answer-first', 'refuseEventsUntil': 0, 'providers': PROVIDERS, 'config': CONFIG,
         'command': 'run', 'compact': 'run', 'defaultModel': None, 'failListOnce': False,
         'holdPermission': False, 'directory': None, 'html': [], 'activeShape': 'object', 'integrations': [], 'oauth': {},
         'loginRefuse': False, 'holdOauthStatus': False, 'replyLost': None, 'stage': 'ok', 'commit': 'ok', 'import': 'ok'}
# 2.x's logins (T-32 slice 4b): its credentials, values included, as its database keeps them; its sign-in attempts;
# and those cancelled.
credentials, attempts, cancelled = {}, {}, []
# Reads of the permission list held (mode `holdPermission`, once): what lets them answer.
held_reads = []
# Compactions held running (`compact` mode `hold`), by session: their message's ID, until `finishCompaction` or an
# interrupt ends one.
compacting = {}
# Revert stages held (`stage` mode `hold`) or answered late (`late`), and imports held (`import` mode `hold`), by
# session: what lets them go on (`goOn`).
reverting = {}
# The store's events whose changes are saved once sent (`publish`): each session, message and part event naming its
# session.
SAVED = {'session.created', 'session.updated', 'session.deleted', 'message.updated', 'message.removed',
         'message.part.updated', 'message.part.removed'}
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
    """An event of the stand-in's own store, kept in 1.19.3's shape, sent as 2.x sends its own (T-32 slice 3b,
    `v2_events`); what it changed is then saved (`SAVED`), as is what an execution's end changed in 2.x's own store: its
    idle message, and the inbox it delivered."""
    for kind2, data, *created in v2_events(kind, properties):
        send(kind2, data, *created)
    if kind == 'session.status' or (kind in SAVED and isinstance(properties.get('sessionID'), str)):
        save()


def send(kind, data, created=None, event_id=None):
    # 2.x's envelope (schema/src/event.ts): `data`, and the time it was made (control `event` may give it).
    event = {'id': event_id or new_id('evt'), 'type': kind, 'created': created or int(time.time() * 1000), 'data': data}
    with lock:
        for stream in streams:
            stream.put(event)
    return event['id']


# What sending the store's events as 2.x's needs to remember, by session (T-32 slice 3b).
v2_state = {}


def v2_of(session):
    # `shutdown`: the execution ending now ends as one shutting down (`shut_down`). `compacts`: the compactions waiting
    # in the inbox (their IDs are in `pending`, in order), each's `delivery` and `created`.
    return v2_state.setdefault(session, {'delivered': set(), 'started': set(), 'ended': set(), 'parts': set(),
                                         'error': None, 'idles': [], 'pending': [], 'steer': set(), 'shells': [],
                                         'shutdown': False, 'compacts': {}})


def zero_tokens():
    # The token counts of a session nothing has run in yet (2.2.5 schema/src/token-usage.ts).
    return {'input': 0, 'output': 0, 'reasoning': 0, 'cache': {'read': 0, 'write': 0}}


def v2_info(stored):
    """A stored session as 2.x answers it (2.2.5 core/src/session/info.ts fromRow, protocol/src/groups/session.ts
    PublicSessionInfo; T-61 slice 7): its folder as `location: {directory}` (a sub-agent's, its parent's; else the work
    folder), no top-level `directory` or `workspaceID`; `cost`, `tokens` and `time` (ms) always; a model without a variant
    as its "default" one; nothing unset."""
    # Copied at once first, as another request's thread may add to it (`v2_mark`).
    info = json.loads(json.dumps({k: v for k, v in dict(stored).items()
                                  if k not in ('directory', 'workspaceID') and v is not None}))
    parent = sessions.get(stored.get('parentID')) or {}
    info['location'] = {'directory': stored.get('directory') or parent.get('directory') or str(WORK)}
    info.setdefault('cost', 0)
    info.setdefault('tokens', zero_tokens())
    info['time'] = {'created': 0, **(info.get('time') or {})}
    info['time'].setdefault('updated', info['time']['created'])
    if info.get('model'):
        info['model'] = {**info['model'], 'variant': info['model'].get('variant') or 'default'}
    return info


def v2_mark(session, outcome=None):
    """What an execution's start (no `outcome`) or end changes on 2.x's session (2.2.5 core/src/session/projector.ts
    `Execution.Started`, projectIdle): its start `time.busy`; its end `time.idle`, always later than the one before, and
    `outcome`. An end as one shutting down changes neither (`shut_down`)."""
    now = int(time.time() * 1000)
    with lock:
        stored = sessions.get(session)
        if stored is None:
            return
        times = stored.setdefault('time', {})
        if outcome is None:
            times['busy'] = now
        else:
            times['idle'] = max(now, times['idle'] + 1) if isinstance(times.get('idle'), (int, float)) else now
            stored['outcome'] = outcome


def settled(message):
    # What 2.x imports and exports of a session (2.2.5 core/src/session/transfer.ts isSettled).
    if message.get('type') == 'assistant':
        return (message.get('time') or {}).get('completed') is not None
    if message.get('type') in ('shell', 'compaction'):
        return message.get('status') != 'running'
    return True


def has_message(session, mid):
    # A message 2.x holds in the session: one it stored, or one imported into it.
    return mid in messages.get(session, {}) or any(m.get('id') == mid for m in imported.get(session, []))


def v2_idle_base(session):
    """The first number free for the session's own idle messages (`v2_idle`): after every one imported into it, whose IDs
    came from the session they were exported from. 2.x names each by its event, so none repeats."""
    taken = [int(m['id'][len('msg_idle'):]) for m in imported.get(session, [])
             if isinstance(m.get('id'), str) and re.fullmatch(r'msg_idle\d+', m['id'])]
    return max(taken) + 1 if taken else 0


# The types of 2.x's messages (2.2.5 schema/src/session-message.ts Info).
MESSAGE_TYPES = ('agent-switched', 'model-switched', 'location-switched', 'user', 'synthetic', 'system', 'skill', 'shell',
                 'assistant', 'compaction', 'idle')
# The modes of `import` (`import_v2`).
IMPORT_MODES = ('ok', 'lost', 'hold', 'fail', 'tamper', 'conflict-other')


def import_refused(body):
    """Why 2.x can't decode an import's body (2.2.5 protocol/src/groups/session.ts session.import), or None: its `info`
    lacks one of what a session's info needs (`id`, `projectID`, `cost`, `tokens`, `time.created`, `time.updated`,
    `location.directory`) or holds one of the wrong type, its `location` is not an absolute folder, or one of its
    `messages` is not a message (an `msg_` ID, one of 2.x's types, `time.created`). Each message's other fields are taken
    as they are; an unset field (null) as one left out."""
    number = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
    unset_or = lambda v, ok: v is None or ok(v)
    if not isinstance(body, dict) or not isinstance(body.get('info'), dict):
        return 'an import takes an object with an info'
    info, times, tokens = body['info'], body['info'].get('time'), body['info'].get('tokens')
    checks = [
        ('info.id', isinstance(info.get('id'), str) and info['id'].startswith('ses')),
        ('info.projectID', isinstance(info.get('projectID'), str)),
        ('info.cost', number(info.get('cost'))),
        ('info.tokens', isinstance(tokens, dict) and all(number(tokens.get(k)) for k in ('input', 'output', 'reasoning'))
         and isinstance(tokens.get('cache'), dict) and all(number(tokens['cache'].get(k)) for k in ('read', 'write'))),
        ('info.time', isinstance(times, dict) and number(times.get('created')) and number(times.get('updated'))
         and all(unset_or(times.get(k), number) for k in ('busy', 'idle', 'viewed', 'archived'))),
        ('info.location', isinstance(info.get('location'), dict) and isinstance(info['location'].get('directory'), str)),
        ('info.parentID', unset_or(info.get('parentID'), lambda v: isinstance(v, str) and v.startswith('ses'))),
        ('info.outcome', info.get('outcome') in (None, 'succeeded', 'failed', 'interrupted')),
        ('info.title', unset_or(info.get('title'), lambda v: isinstance(v, str))),
        ('info.agent', unset_or(info.get('agent'), lambda v: isinstance(v, str))),
        ('info.model', unset_or(info.get('model'), lambda v: isinstance(v, dict) and isinstance(v.get('id'), str)
                                and isinstance(v.get('providerID'), str))),
        ('info.metadata', unset_or(info.get('metadata'), lambda v: isinstance(v, dict))),
        ('info.permissions', unset_or(info.get('permissions'), lambda v: isinstance(v, list))),
        ('location', unset_or(body.get('location'), lambda v: isinstance(v, dict) and isinstance(v.get('directory'), str)
                              and os.path.isabs(v['directory']))),
        ('messages', isinstance(body.get('messages'), list)),
    ]
    for name, ok in checks:
        if not ok:
            return f'Invalid {name}'
    for n, m in enumerate(body['messages']):
        if not (isinstance(m, dict) and isinstance(m.get('id'), str) and m['id'].startswith('msg_')
                and m.get('type') in MESSAGE_TYPES and isinstance(m.get('time'), dict) and number(m['time'].get('created'))):
            return f'Invalid messages[{n}]'
    return None


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
    # those enqueued up to `upto`, or all of them. A compaction waiting there is delivered only as it runs (`compact_run`).
    state = v2_of(session)
    if upto is not None and upto not in state['pending']:
        return []
    count = state['pending'].index(upto) + 1 if upto is not None else len(state['pending'])
    delivered = [mid for mid in state['pending'][:count] if mid not in state['compacts']]
    state['pending'] = [mid for mid in state['pending'] if mid not in delivered]
    return [('session.inbox.delivered', {'sessionID': session, 'inboxID': mid}) for mid in delivered]


def v2_error(error):
    # 2.x's error (schema/src/session-error.ts) from 1.19.3's {name, data: {message}}.
    return {'type': (error or {}).get('name') or 'UnknownError', 'message': ((error or {}).get('data') or {}).get('message') or ''}


def v2_content_index(session, message_id, part_id, kind):
    """A text's or reasoning's ordinal as 2.x numbers it: its place among its answer's entries of the same kind, each kind
    counted from 0 (2.2.5 core/src/session/runner/publish-llm-event.ts `fragments`, one counter per kind, YN-48). Its
    place in the answer's content, which a whole read keys it by (`v2_view`), counts every kind."""
    stored = messages.get(session, {}).get(message_id) or {}
    entries = [q for q in stored.get('parts', []) if (v2_entry(q) or {}).get('type') == kind]
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
    """What 2.x's `/api/session/:id/inbox` lists: the messages steered in and not yet delivered, and the compactions
    admitted and not yet started (`v2_compact_item`), oldest first."""
    state = v2_of(session)
    return [v2_compact_item(session, mid) if mid in state['compacts'] else
            {'id': mid, 'sessionID': session, 'type': 'user', 'delivery': 'steer', 'payload': v2_payload(session, mid),
             'time': {'created': ((messages.get(session, {}).get(mid) or {}).get('info') or {}).get('time', {}).get('created', 0)}}
            for mid in state['pending']]


def v2_compact_item(session, mid):
    """A compaction waiting in the inbox, as 2.x lists one and answers its admission with (schema/src/session-inbox.ts)."""
    item = v2_of(session)['compacts'][mid]
    return {'id': mid, 'sessionID': session, 'time': {'created': item['created']}, 'type': 'compaction', 'payload': {},
            'delivery': item['delivery']}


def v2_event_of(mid):
    # The event ID whose message ID is `mid` (SessionMessage.ID.fromEvent: `evt_…` → `msg_…`).
    return 'evt_' + mid[len('msg_'):] if mid.startswith('msg_') else mid


def v2_reason(session, info):
    """Why a stored compaction ran, as 2.x says (schema/src/session-event.ts Compaction): `manual` for one asked for,
    `auto` for 2.x's own. One the 2.x route ran says so itself; a 1.19.3-shaped summary is manual when the compaction
    part it answers (its `parentID`) was asked for (`auto` false), else auto."""
    if info.get('reason'):
        return info['reason']
    asked = (messages.get(session, {}).get(info.get('parentID')) or {}).get('parts') or []
    return 'manual' if any(q.get('type') == 'compaction' and q.get('auto') is False for q in asked) else 'auto'


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
            # A compaction's summary is 2.x's compaction (session-event.ts Compaction), manual or 2.x's own (`v2_reason`).
            done = (info.get('time') or {}).get('completed')
            reason = v2_reason(session, info)
            out = []
            if mid not in state['started']:
                state['started'].add(mid)
                # 2.x names the compaction's message by its input's ID (core/src/session/message-updater.ts), as here; its
                # own has no input, and its message is named by this event's ID (SessionMessage.ID.fromEvent).
                if reason == 'manual':
                    out.append(('session.compaction.started', {'sessionID': session, 'reason': 'manual', 'inputID': mid}))
                else:
                    out.append(('session.compaction.started', {'sessionID': session, 'reason': 'auto'}, None, v2_event_of(mid)))
            if done and mid not in state['ended']:
                state['ended'].add(mid)
                out.append(('session.compaction.ended', {'sessionID': session, 'reason': reason, 'text': '', 'tokens': info.get('tokens')}))
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
        ordinal = v2_content_index(session, mid, q.get('id'), entry['type'])
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
            v2_mark(session)
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
                v2_mark(session, 'interrupted')
                return ahead + [('session.execution.interrupted', {'sessionID': session, 'reason': 'user'})]
            if error:
                state['idles'].append({'after': last, 'outcome': 'failed', 'error': v2_error(error)})
                v2_mark(session, 'failed')
                return ahead + [('session.execution.failed', {'sessionID': session, 'error': v2_error(error)})]
            state['idles'].append({'after': last, 'outcome': 'succeeded'})
            v2_mark(session, 'succeeded')
            return ahead + [('session.execution.succeeded', {'sessionID': session})]
        return []
    if kind == 'session.error':
        # 2.x reports it with the execution's end (session-event.ts Execution); with none running, at once.
        if session not in statuses:
            v2_mark(session, 'failed')
            return [('session.execution.failed', {'sessionID': session, 'error': v2_error(p.get('error'))})]
        v2_of(session)['error'] = p.get('error')
        return []
    if kind == 'session.created':
        info = p.get('info') or {}
        return [('session.created', {'sessionID': info.get('id'), 'projectID': info.get('projectID', PROJECT), 'parentID': info.get('parentID'),
                                     'title': info.get('title'), 'agent': info.get('agent'), 'slug': info.get('id'), 'version': '2.2.5',
                                     'location': {'directory': info.get('directory') or str(WORK)},
                                     # An imported one's own (`import_v2`), as 2.x's event carries them.
                                     **{k: info[k] for k in ('model', 'metadata', 'permissions', 'subpath') if info.get(k) is not None}})]
    if kind in ('session.updated', 'message.removed', 'message.part.removed', 'message.part.delta'):
        return []
    return [(kind, p)]


def v2_view(session):
    """The session's stored messages as 2.x's `/api/session/:id/message` lists them (schema/src/session-message.ts): in
    the order 2.x stored them, with each execution's idle message after the message it ended at. A message steered in
    is stored when 2.x delivers it (`v2_deliver`): before the first step answering it or a later one, or at the
    execution's end; not yet delivered, it is in the inbox only (`v2_inbox`). What was imported into it (`import_v2`)
    comes first, as it was sent, as 2.x stored it before anything else; its own idle messages are numbered after those."""
    state = v2_of(session)
    idles = {}
    for n, idle in enumerate(state['idles'], start=v2_idle_base(session)):
        idles.setdefault(idle['after'], []).append((n, idle))
    shells = {}
    for shell in state['shells']:
        shells.setdefault(shell['after'], []).append(shell)
    out, waiting = json.loads(json.dumps(imported.get(session, []))), []

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
            # 2.x's compaction message (schema/src/session-message.ts Compaction): its summary and model once completed.
            text = ''.join(q.get('text', '') for q in stored.get('parts', []) if q.get('type') == 'text')
            done = (info.get('time') or {}).get('completed')
            entry = {'id': mid, 'type': 'compaction', 'status': 'completed' if done else 'running', 'reason': v2_reason(session, info),
                     'summary': text, 'time': {'created': created}}
            if info.get('error'):
                entry.update(status='failed', error=v2_error(info['error']))
            elif done and info.get('providerID') and info.get('modelID'):
                entry['model'] = {'id': info['modelID'], 'providerID': info['providerID'],
                                  **({'variant': info['variant']} if info.get('variant') else {})}
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
            if stored.get('snapshot'):
                answer['snapshot'] = stored['snapshot']
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
                           # 2.x stores its idle messages with the session's others,
                           # and its inbox.
                           'idles': {s: v['idles'] for s, v in v2_state.items()},
                           'inbox': {s: {'pending': v['pending'], 'steer': sorted(v['steer']), 'compacts': v['compacts']}
                                     for s, v in v2_state.items()},
                           'shells': {s: v['shells'] for s, v in v2_state.items()},
                           'imported': imported})
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
        for s, idles in state.get('idles', {}).items():
            v2_of(s)['idles'] = idles
        for s, inbox in state.get('inbox', {}).items():
            v2_of(s).update(pending=inbox['pending'], steer=set(inbox['steer']), compacts=inbox.get('compacts', {}))
        for s, shells in state.get('shells', {}).items():
            v2_of(s)['shells'] = shells
        imported.update(state.get('imported', {}))
        # A compaction its process ended in the middle of is failed when it starts again, with nothing said (no stream
        # is open yet), as 2.x's `compaction.interrupted` (core/src/session/compaction.ts).
        for s, stored in messages.items():
            for message in stored.values():
                info = message.get('info') or {}
                if info.get('reason') and info.get('summary') and not info.get('error') and not (info.get('time') or {}).get('completed'):
                    info['error'] = {'name': 'compaction.interrupted', 'data': {'message': 'fixture: the process ended'}}


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


UNSET = object()


def answer_prompt(session, text=None, error=None, completed=True, parent=None, extra=None, files=None, raw_patches=None, raw_parts=None,
                  snapshot=UNSET):
    """An assistant message answering the session's last prompt (or `parent`), with a text part.
    `extra` adds to its info what OpenCode reports of an answer: `tokens`, `providerID`/`modelID`, `summary`.
    `files` ({relative path: text, or None to delete}) are changed in the work folder as a run's tools change
    them, and named in a `patch` part whose hash is the snapshot from before (`session/processor.ts`); with
    snapshots off, no part. `raw_patches` are patch parts as they are ({hash, files}), such as one whose snapshot
    is gone; `raw_parts` any other parts, as they are (such as a `task` tool's, naming its sub-agent).
    With snapshots on, 2.x keeps each step's snapshot on its message (T-61 slice 5; schema/src/session-message.ts
    Assistant.snapshot): the tree from before its tools ran and the files they changed, relative to the Git top level
    (here the work folder). `snapshot` sets it as it is instead ({start?, files?}, or None for none)."""
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
    # Each step is snapshotted as it starts, whatever its tools then change (2.2.5 core/src/session/runner/step.ts).
    before = track()
    if files:
        for rel, content in files.items():
            write(rel, content)
        if before:
            parts.append({'id': new_id('prt'), 'sessionID': session, 'messageID': info['id'], 'type': 'patch', 'hash': before,
                          'files': [str(WORK / rel) for rel in files]})
    step = {'start': before, 'files': list(files or {})} if before else None
    if snapshot is not UNSET:
        step = snapshot
    for patch in raw_patches or []:
        parts.append({'id': new_id('prt'), 'sessionID': session, 'messageID': info['id'], 'type': 'patch', **patch})
    for part in raw_parts or []:
        parts.append({'id': new_id('prt'), 'sessionID': session, 'messageID': info['id'], **part})
    with lock:
        messages.setdefault(session, {})[info['id']] = {'info': info, 'parts': parts, **({'snapshot': step} if step is not None else {})}
    save()
    publish('message.updated', {'sessionID': session, 'info': info})
    for part in parts:
        publish('message.part.updated', {'sessionID': session, 'part': part, 'time': now})
    return info


WORK = Path.cwd().resolve()
# OpenCode's folders and switches as Core started it (T-32), before a switch below changes one.
GIVEN = {name: os.environ.get(name) for name in ('XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
                                                  'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_MODELS_FETCH')}
# A routing key Core gives one Agent's server (YN-34 S1c), recorded apart so `env` stays as it was.
ROUTING_KEYS = {name: os.environ.get(name) for name in ('DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY')}
# An executor's permission level as OpenCode's rules (YN-56 S3), recorded apart too.
CONFIG_CONTENT = os.environ.get('OPENCODE_CONFIG_CONTENT')


def config_rules():
    """As 2.2.5 lists an agent's rules when OPENCODE_CONFIG_CONTENT gives a top-level `permission`
    (lab Jobs 07d33af5, ae58aecc): its defaults, the configuration's rules in their order, then its
    browser denies. Switch `permission-after`: JSON rules a later configuration adds (a managed one)."""
    if not CONFIG_CONTENT:
        return []
    rules = [{'action': '*', 'resource': '*', 'effect': 'allow'}, {'action': 'read', 'resource': '*.env', 'effect': 'ask'},
             {'action': 'read', 'resource': '*.env.*', 'effect': 'ask'}, {'action': 'read', 'resource': '*.env.example', 'effect': 'allow'}]
    permission = json.loads(CONFIG_CONTENT).get('permission', {})
    for action, rule in ({'*': permission} if isinstance(permission, str) else permission).items():
        if isinstance(rule, str):
            rules.append({'action': action, 'resource': '*', 'effect': rule})
        else:
            rules.extend({'action': action, 'resource': pattern, 'effect': effect} for pattern, effect in rule.items())
    rules.extend(json.loads(switch('permission-after') or '[]'))
    return rules + [{'action': 'browser', 'resource': '*', 'effect': 'deny'}, {'action': 'skill', 'resource': 'browser', 'effect': 'deny'}]
# OpenCode's own folders (`core/src/global.ts`: xdg-basedir and `os.homedir()`), from the environment it runs with.
HOME = os.environ['HOME'] if 'HOME' in os.environ else pwd.getpwuid(os.getuid()).pw_dir


def xdg(name, *default):
    return os.path.normpath(os.path.join(os.environ.get(name) or os.path.join(HOME, *default), 'opencode'))


XDG_DATA = switch('xdg-data') or os.environ.get('XDG_DATA_HOME')
if XDG_DATA:
    os.environ['XDG_DATA_HOME'] = XDG_DATA
DATA = xdg('XDG_DATA_HOME', '.local', 'share')
# The project OpenCode names this folder's (`core/src/project.ts`; a fixed one here).
PROJECT = 'fixtureproject'
# The project `/api/location` names now (control `project`), an import's too; snapshots stay under PROJECT's store.
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


def write(rel, content):
    path = WORK / rel
    if content is None:
        path.unlink(missing_ok=True)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)


def busy(session):
    """OpenCode's 409 for a busy session (`SessionBusyError`: 1.19.3's `packages/sdk/openapi.json`, the same in 2.2.5's
    protocol/src/errors.ts)."""
    return {'_tag': 'SessionBusyError', 'sessionID': session, 'message': f'Session is busy: {session}'}


def ordered(session):
    return sorted(messages.get(session, {}).values(), key=lambda m: (m['info']['time']['created'], m['info']['id']))


def v2_commit(session):
    """As 2.x commits a revert staged in the session (2.2.5 core/src/session/revert.ts `commit`, projected in
    core/src/session/projector.ts), on its route or before new input is admitted (core/src/session/session.ts `prompt`,
    `compact`): every stored message from its boundary on, the boundary too, is deleted (an execution's idle message
    and a shell's after one of them go with it), with what waits in the inbox from it on (a message steered in is one of
    those stored; a compaction counts from when it was admitted), the revert is cleared, then `session.revert.committed`
    is sent; files are left as they are. A boundary no longer stored deletes nothing. Whether one was held."""
    revert = sessions[session].get('revert')
    if not revert:
        return False
    stored = ordered(session)
    at = next((i for i, m in enumerate(stored) if m['info']['id'] == revert.get('messageID')), None)
    gone = {m['info']['id'] for m in stored[at:]} if at is not None else set()
    since = stored[at]['info']['time']['created'] if at is not None else None
    state = v2_of(session)
    with lock:
        for mid in gone:
            messages[session].pop(mid, None)
        dropped = {mid for mid, item in state['compacts'].items() if since is not None and item['created'] >= since}
        for mid in dropped:
            state['compacts'].pop(mid)
        state['pending'] = [mid for mid in state['pending'] if mid not in gone and mid not in dropped]
        state['steer'] -= gone
        state['shells'] = [s for s in state['shells'] if s['after'] not in gone]
        sessions[session].pop('revert', None)
    save()
    send('session.revert.committed', {'sessionID': session, 'to': revert.get('messageID')})
    return True


def v2_tree_entry(tree, rel):
    """What the snapshot `tree` lists for the path `rel` (relative to the work folder): its mode, type and object, or
    None when it lists nothing there. With snapshots off no Git runs: refused as 2.x refuses it."""
    if not SNAPSHOTS:
        raise RuntimeError('Snapshots are disabled')
    listed = git('ls-tree', tree, '--', rel, check=False)
    line = listed.stdout.decode(errors='replace').strip() if listed.returncode == 0 else ''
    return line.split('\t', 1)[0] if line else None


def v2_restore(files):
    """As 2.x's Snapshot.restore (2.2.5 core/src/snapshot.ts, core/src/git.ts `tree.restore`): each path ({relative
    path: tree}) checked out of its tree when that lists it, else deleted. With snapshots off 2.x refuses it ("Snapshots
    are disabled"), and here no Git runs."""
    if files and not SNAPSHOTS:
        raise RuntimeError('Snapshots are disabled')
    with lock:
        for rel, tree in files.items():
            if v2_tree_entry(tree, rel):
                git('checkout', tree, '--', str(WORK / rel))
            else:
                (WORK / rel).unlink(missing_ok=True)


def v2_diff(before, after, paths):
    """As 2.x's Snapshot.diff limited to `paths` (2.2.5 core/src/snapshot.ts `diff`): a FileDiff of each one whose entry
    differs from tree `before` to tree `after`, by path, `added`, `deleted` or `modified`; its patch and counts are left
    empty here. No paths: none."""
    out = []
    for rel in sorted(set(paths)):
        old, new = v2_tree_entry(before, rel), v2_tree_entry(after, rel)
        if old == new:
            continue
        status = 'added' if old is None else 'deleted' if new is None else 'modified'
        out.append({'file': rel, 'patch': '', 'additions': 0, 'deletions': 0, 'status': status})
    return out


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
    interrupt ends one (`interrupt`) but as a shutdown: the requests left go with it, its answer is marked aborted
    ("Step interrupted"), and the execution ends with `session.execution.interrupted`, reason `shutdown`, the session
    idle and no idle message written."""
    end_requests(session)
    if session in statuses and modes['abortEvidence']:
        answer_prompt(session, error=STEP_INTERRUPTED)
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
    if name == 'compacts':
        # What 2.x's compaction route was sent (T-61 slice 4), read only.
        with lock:
            return {'seen': list(compacts_seen)}
    if name == 'finishCompaction':
        # A held compaction ends as one that runs through (`compact_run`); its message as 2.x lists it, or None.
        with lock:
            mid = compacting.pop(body['sessionID'], None)
        if mid is None:
            return None
        compaction_ended(body['sessionID'], mid, body.get('text', COMPACTION_SUMMARY))
        go_idle(body['sessionID'])
        return v2_listed(body['sessionID'], mid)
    if name == 'autoCompact':
        # A compaction of 2.x's own (core/src/session/runner/llm.ts, on an overflowing context): no inbox item and no
        # input, its message named by its start event's ID; run in the execution going on, else in one of its own.
        session = body['sessionID']
        own = session not in statuses
        if own:
            statuses[session] = {'type': 'busy'}
            publish('session.status', {'sessionID': session, 'status': {'type': 'busy'}})
        started = new_id('evt')
        mid = 'msg_' + started[len('evt_'):]
        compaction_started(session, mid, 'auto', event_id=started)
        compaction_ended(session, mid, body.get('text', COMPACTION_SUMMARY))
        if own:
            go_idle(session)
        return v2_listed(session, mid)
    if name == 'ask':
        # A permission request as 2.2.5 makes one (core/src/permission.ts), sent as 2.x sends it.
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
        # A form as 2.2.5's question tool makes one (core/src/form.ts); `kind` another form's.
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
                             body.get('info'), body.get('files'), body.get('patches'), body.get('parts'),
                             body['snapshot'] if 'snapshot' in body else UNSET)
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
        # A revert staged in the session, as 2.x keeps one until it is committed or cleared.
        sessions[body['sessionID']]['revert'] = {'messageID': body.get('messageID', 'msg_reverted')}
        save()
        return True
    if name == 'project':
        # The folder held for another project from now on (T-10 Revert), as when its repository changed.
        current_project[0] = body['id']
        return True
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
        # A held revert stage or import goes on, or a late stage is answered.
        reverting.pop(body['sessionID']).set()
        return True
    raise ValueError(name)


# The summary a compaction writes here (2.x's starts with `## Objective`, core/src/session/compaction.ts).
COMPACTION_SUMMARY = '## Objective\nfixture summary'
# The modes of `compact` (`compact_v2`).
COMPACT_MODES = ('run', 'hold', 'fail', 'unavailable', 'late', 'drop', 'drop-unadmitted', 'refuse-404', 'invalid-400',
                 'conflict-409', '500', '500-admitted', 'other-pending', 'forget')
# What the modes of `compact` that fail fail with (core/src/session/compaction.ts): its error's type and message.
COMPACT_FAILURES = {'fail': ('compaction.failed', 'fixture: the summary failed'),
                    'unavailable': ('compaction.unavailable', 'fixture: nothing to compact')}
# What an interrupt leaves a held compaction's run with: it ends as interrupted (`v2_events`, an idle session.status).
ABORTED = {'name': 'MessageAbortedError', 'data': {'message': 'The operation was aborted.'}}


def compaction_model(session):
    """The model a compaction runs on: the session's, as `POST …/model` set it (its variant too), else mode
    `defaultModel`'s."""
    current = sessions.get(session, {}).get('model') or {}
    if current.get('id') and current.get('providerID'):
        return {k: current[k] for k in ('id', 'providerID', 'variant') if current.get(k)}
    default = modes['defaultModel'] or {}
    return {'id': default.get('modelID') or 'fixture', 'providerID': default.get('providerID') or 'fixture'}


def v2_listed(session, mid):
    # A message as 2.x's `/api/session/:id/message` lists it, or None.
    return next((m for m in v2_view(session) if m['id'] == mid), None)


def compaction_started(session, mid, reason, input_id=None, event_id=None, delta=True):
    """A compaction's start (core/src/session/compaction.ts): its message stored under `mid`, running, after the
    session's others; `session.compaction.started`, with an `inputID` only for one asked for; then one
    `session.compaction.delta` (`delta`)."""
    now = int(time.time() * 1000)
    info = {'id': mid, 'sessionID': session, 'role': 'assistant', 'mode': 'compaction', 'agent': 'compaction', 'summary': True,
            'reason': reason, 'time': {'created': now}}
    with lock:
        messages.setdefault(session, {})[mid] = {'info': info, 'parts': []}
    save()
    send('session.compaction.started', {'sessionID': session, 'reason': reason, **({'inputID': input_id} if input_id else {})},
         now, event_id)
    if delta:
        send('session.compaction.delta', {'sessionID': session, 'text': COMPACTION_SUMMARY.split('\n')[0] + '\n'})


def compaction_ended(session, mid, text):
    """A compaction ending well: its message completed with its summary and model, and `session.compaction.ended`
    (no `inputID`), the model the session's."""
    model = compaction_model(session)
    part = {'id': new_id('prt'), 'sessionID': session, 'messageID': mid, 'type': 'text', 'text': text}
    with lock:
        stored = messages.get(session, {}).get(mid)
        reason = stored['info'].get('reason', 'manual') if stored else 'manual'
        if stored:
            stored['info'].update(providerID=model['providerID'], modelID=model['id'], finish='stop')
            if model.get('variant'):
                stored['info']['variant'] = model['variant']
            stored['info']['time']['completed'] = int(time.time() * 1000)
            stored['parts'] = [part]
    save()
    send('session.compaction.ended', {'sessionID': session, 'reason': reason, 'model': model, 'text': text})


def compaction_failed(session, mid, kind, message):
    """A compaction failing (core/src/session/compaction.ts): its message failed with 2.x's error, and
    `session.compaction.failed` with its `inputID`. Its run still ends as succeeded, unless an interrupt ended it."""
    with lock:
        stored = messages.get(session, {}).get(mid)
        reason = stored['info'].get('reason', 'manual') if stored else 'manual'
        if stored:
            stored['info']['error'] = {'name': kind, 'data': {'message': message}}
    save()
    send('session.compaction.failed', {'sessionID': session, 'reason': reason, 'error': {'type': kind, 'message': message},
                                       **({'inputID': mid} if reason == 'manual' else {})})


def compact_run(session, mid, mode):
    """A compaction admitted under `mid` runs (core/src/session/compaction.ts): `session.inbox.delivered`, the
    execution's start, `session.compaction.started` (its message running); then by mode held (`hold`, until
    `finishCompaction` or an interrupt), failed (`fail`, `unavailable`: and the run still ends as succeeded) or ended
    with its summary; and the session idle, its idle message after the compaction's."""
    with lock:
        state = v2_of(session)
        if state['compacts'].pop(mid, None) is None:
            return
        state['pending'] = [m for m in state['pending'] if m != mid]
    save()
    send('session.inbox.delivered', {'sessionID': session, 'inboxID': mid})
    statuses[session] = {'type': 'busy'}
    publish('session.status', {'sessionID': session, 'status': {'type': 'busy'}})
    compaction_started(session, mid, 'manual', input_id=mid, delta=mode not in COMPACT_FAILURES)
    if mode == 'hold':
        with lock:
            compacting[session] = mid
        return
    if mode in COMPACT_FAILURES:
        compaction_failed(session, mid, *COMPACT_FAILURES[mode])
    else:
        compaction_ended(session, mid, COMPACTION_SUMMARY)
    go_idle(session)


def compact_later(session, mid, mode, delay):
    """`compact_run` in a thread of its own, after `delay` seconds and once no run goes on in the session: one admitted
    while a run goes on runs after it (2.x takes it up at that run's next step, core/src/session/runner/llm.ts). A run
    still going on 120 s later leaves it in the inbox."""
    def run():
        time.sleep(delay)
        deadline = time.monotonic() + 120
        while session in statuses:
            if time.monotonic() > deadline:
                return
            time.sleep(0.05)
        compact_run(session, mid, mode)
    threading.Thread(target=run, daemon=True).start()


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
        if key == ('GET', 'api', 'agent'):
            # 2.x's agents for a folder (protocol/src/groups/agent.ts, schema/src/agent.ts Info; T-61 slice 8): `build` and
            # `plan` primary, `general` a sub-agent, `title` hidden; mode `agents`: another list.
            asked = parse_qs(url.query).get('location[directory]', [None])[0]
            listed = modes['agents'] if modes.get('agents') is not None else [
                {'id': name, 'name': name, 'mode': mode, 'hidden': hidden, 'permissions': config_rules(),
                 'request': {'settings': {}, 'headers': {}, 'body': {}}}
                for name, mode, hidden in (('build', 'primary', False), ('plan', 'primary', False), ('general', 'subagent', False),
                                           ('title', 'primary', True))]
            return self.reply(200, {'location': {'directory': modes['directory'] or (str(Path(asked).resolve()) if asked else str(WORK))},
                                    'data': listed})
        if key == ('GET', 'api', 'location'):
            # 2.x's location (server/src/handlers/location.ts, T-61 slice 5): the folder asked for
            # (`location[directory]`), resolved, and the project held for it now (control `project`), whose directory
            # is the Git top level its snapshots are of, here the work folder. Mode `directory`: another folder.
            asked = parse_qs(url.query).get('location[directory]', [None])[0]
            directory = modes['directory'] or (str(Path(asked).resolve()) if asked else str(WORK))
            return self.reply(200, {'directory': directory,
                                    'project': {'id': current_project[0], 'directory': str(WORK), 'canonical': str(WORK)}})
        if key == ('POST', 'api', 'session'):
            # 2.x takes the session's folder from the body (server/src/handlers/session.ts).
            session = {'id': new_id('ses'), 'projectID': PROJECT, 'title': (body or {}).get('title', ''),
                       'directory': ((body or {}).get('location') or {}).get('directory', '')}
            # 2.x's own info (`v2_info`): its folder the body's, else the server's own (process.cwd()).
            now = int(time.time() * 1000)
            session.update(directory=session['directory'] or str(WORK), cost=0, tokens=zero_tokens(),
                           time={'created': now, 'updated': now})
            sessions[session['id']] = session
            save()
            publish('session.created', {'sessionID': session['id'], 'info': session})
            return self.reply(200, {'data': v2_info(session)})
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
            listed = [v2_info(s) for s in list(sessions.values()) if parent is None or s.get('parentID') == parent]
            return self.reply(*page(listed, query, {'parentID': parent}))
        if parts[:2] in (['api', 'integration'], ['api', 'credential']):
            return self.login(method, parts[1], parts[2:], body or {})
        if len(parts) >= 3 and parts[:2] == ['api', 'session']:
            return self.api_session(method, parts[2], parts[3:], parse_qs(url.query), body)
        if key == ('GET', 'api', 'mcp'):
            # Each server of the folder, its status only (2.2.5 core/src/mcp/index.ts `servers()`).
            location = parse_qs(url.query).get('location[directory]', [str(WORK)])[0]
            with lock:
                listed = [{'name': name, 'status': dict(server['status'])} for name, server in mcp_servers.items()
                          if server['location'] == location]
            return self.reply(200, {'location': {'directory': location}, 'data': listed})
        if parts[:3] == ['api', 'experimental', 'mcp'] and len(parts) in (4, 5):
            return self.mcp_v2(method, parts[3], parts[4:], parse_qs(url.query), body)
        # 2.x's session transfer (T-61 slice 7).
        if key == ('POST', 'api', 'experimental', 'session', 'import'):
            return self.import_v2(body)
        if method == 'GET' and len(parts) == 5 and parts[:3] == ['api', 'experimental', 'session'] and parts[4] == 'export':
            return self.export_v2(parts[3])
        if key == ('GET', 'api', 'command'):
            # 2.x's own list (protocol/src/groups/command.ts): each command's name and description, nothing else of it.
            listed = [{'name': name, **({'description': c['description']} if c.get('description') else {})}
                      for name, c in (modes['config'].get('command') or {}).items()]
            return self.reply(200, {'location': {'directory': str(WORK)}, 'data': listed})
        if key == ('GET', 'api', 'model'):
            return self.reply(200, {'location': {'directory': str(WORK)}, 'data': v2_models()})
        if key == ('GET', 'api', 'model', 'default'):
            # The model 2.x runs a session on with none of its own (2.2.5 core/src/model.ts `default`): mode
            # `defaultModel`'s, else the first it lists (all are released 0 here); null with none (YN-48).
            listed, wanted = v2_models(), modes['defaultModel'] or {}
            found = next((m for m in listed if m['providerID'] == wanted.get('providerID') and m['id'] == wanted.get('modelID')),
                         None if wanted else (listed[0] if listed else None))
            return self.reply(200, {'location': {'directory': str(WORK)}, 'data': found})
        if key == ('GET', 'api', 'provider'):
            return self.reply(200, {'location': {'directory': str(WORK)}, 'data': v2_providers()})
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
        # 2.x's own routes of one session (protocol/src/groups/session.ts, message.ts).
        if session not in sessions:
            return self.reply(404, {'_tag': 'SessionNotFoundError', 'message': f'Session not found: {session}'})
        if (method, *rest) == ('GET',):
            return self.reply(200, {'data': v2_info(sessions[session])})
        if (method, *rest) == ('POST', 'prompt'):
            return self.prompt_v2(session, body or {})
        if (method, *rest) == ('POST', 'command'):
            return self.command_v2(session, body)
        if (method, *rest) == ('POST', 'compact'):
            return self.compact_v2(session, body)
        # 2.x's revert routes (T-61 slice 6).
        if (method, *rest) == ('POST', 'revert', 'stage'):
            return self.stage_v2(session, body)
        if (method, *rest) == ('POST', 'revert', 'commit'):
            return self.commit_v2(session)
        if (method, *rest) == ('DELETE', 'revert'):
            return self.clear_v2(session)
        if (method, *rest) == ('POST', 'model'):
            # 2.x's switchModel (T-32 slice 4a): the session's model for its next steps; 204.
            with lock:
                sessions[session]['model'] = (body or {}).get('model')
            save()
            return self.reply(204)
        if (method, *rest) == ('POST', 'interrupt'):
            return self.interrupt(session)
        if method == 'GET' and len(rest) == 2 and rest[0] == 'message':
            # 2.x's one message, as its list holds it: once delivered (a message steered in waits in the inbox).
            if modes.get('failMessageReads'):
                return self.reply(500, {'_tag': 'UnknownError', 'message': 'fixture: message read failed'})
            found = next((m for m in v2_view(session) if m.get('id') == rest[1]), None)
            between_reads(session)
            if found is None:
                return self.reply(404, {'_tag': 'MessageNotFoundError', 'message': f'Message not found: {rest[1]}'})
            return self.reply(200, {'data': found})
        if (method, *rest) == ('GET', 'message'):
            if modes['failListOnce']:
                modes['failListOnce'] = False
                return self.reply(500, {'_tag': 'UnknownError', 'message': 'fixture: list read failed'})
            return self.reply(*page(v2_view(session), query, {}))
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
            listed = v2_inbox(session)
            between_reads(session)
            return self.reply(200, {'data': listed})
        return self.reply(404)

    def interrupt(self, session):
        """2.x's interrupt, answered with whether a run was going on: the run ends; its pending requests go with it (as
        2.2.5's interrupt ends them: `end_requests`), and (as OpenCode does) its answer is marked aborted."""
        running = session in statuses
        end_requests(session)
        self.reply(200, {'interrupted': running})
        aborted = ABORTED
        with lock:
            held = compacting.pop(session, None)
        if held:
            # As 2.x interrupts a compaction (core/src/session/compaction.ts): it fails as `aborted`, and its run
            # ends as interrupted (`session.execution.interrupted`), with no aborted answer.
            compaction_failed(session, held, 'aborted', 'fixture: interrupted')
            with lock:
                v2_of(session)['error'] = aborted
            go_idle(session)
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
        session holds already. Its model is the session's, as switchModel made it. A revert staged in the session is
        committed before it is admitted (`v2_commit`). Mode `prompt` applies (`prompt`)."""
        files = []
        for f in body.get('files') or []:
            uri = f.get('uri') or ''
            if not uri.startswith('data:'):
                return self.reply(400, {'_tag': 'InvalidRequestError', 'message': 'fixture: a file here is a data: URI'})
            files.append({'type': 'file', 'mime': uri[5:].split(';', 1)[0], 'filename': f.get('name'), 'url': uri})
        message_id = body.get('id') or new_id('msg')
        if has_message(session, message_id) or message_id in v2_of(session)['pending']:
            return self.reply(409, {'_tag': 'ConflictError', 'message': f'Message already exists: {message_id}'})
        old = {'messageID': message_id, 'parts': [{'type': 'text', 'text': body.get('text', '')}, *files]}
        current = sessions[session].get('model')
        if current:
            old['model'] = {'providerID': current.get('providerID'), 'modelID': current.get('id')}
            if current.get('variant'):
                old['variant'] = current['variant']
        return self.prompt(session, old)

    def prompt(self, session, body):
        # A prompt `prompt_v2` read, its parts in the store's shape. 2.x answers with the message admitted. Mode
        # `renamed`: stored, and answered as another message's admission.
        accepted = lambda: self.reply(200, {'data': {'id': new_id('msg') if mode == 'renamed' else message_id, 'sessionID': session,
                                                     'type': 'user', 'delivery': 'steer',
                                                     'payload': {'text': text}, 'time': {'created': int(time.time() * 1000)}}})
        message_id = body.get('messageID') or new_id('msg')
        text = ''.join(p.get('text', '') for p in body.get('parts', []) if p.get('type') == 'text')
        files = [p for p in body.get('parts', []) if p.get('type') == 'file']
        mode = modes['prompt']
        if mode != 'error':
            # 2.x commits a staged revert after its preparation, before it admits the message (2.2.5
            # core/src/session/session.ts).
            v2_commit(session)
        model = body.get('model') or modes['defaultModel']
        if mode in ('store', 'renamed', 'store-unannounced'):
            # `store-unannounced`: admitted with no event Core sees (its stream missed it).
            admit(session, message_id, text, files, model=model, announce=mode != 'store-unannounced', answered=accepted)
            return None
        if mode == 'unstored':
            # Answered, then storing failed: 2.x says nothing of it.
            accepted()
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
        command's own `model` and `agent` become the session's (`select`), a staged revert is committed (`v2_commit`),
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
        # 2.x runs a command as a prompt (core/src/config/plugin/command.ts), which commits a staged revert first.
        v2_commit(session)
        select(session, command)
        current = sessions[session].get('model')
        model = {'providerID': current.get('providerID'), 'modelID': current.get('id')} if current else modes['defaultModel']
        admit(session, v2_message_id(), expand(command['template'], text), model=model, announce=mode != 'unannounced',
              answered=None if mode == 'fail-after' else (lambda: self.reply(204)))
        return failed() if mode == 'fail-after' else None

    def compact_v2(self, session, body):
        """As 2.x's compaction (2.2.5 protocol/src/groups/session.ts session.compact, core/src/session/inbox.ts; T-61 slice
        4): `{id?, delivery?}` and no model (it runs on the session's, `compaction_model`); each request is kept in
        `compacts_seen`. A staged revert is committed (`v2_commit`), then it is admitted into the inbox at
        once under its `id` (else a 2.x ID, `v2_message_id`), `delivery` by default `steer` while a run goes on, else
        `queue`: `session.inbox.enqueued`, answered 200 with the item, then run (`compact_run`), or once the run going
        on ends (`compact_later`). Its `id` again: the same item while it waits in the inbox, a ConflictError (409) once
        it is a message; another compaction waiting there answers in place of it, nothing admitted. A body 2.x can't
        read: InvalidRequestError (400, kind `Payload`). Mode `compact`: `run`; `hold` (run, then held until control
        `finishCompaction`, or an interrupt: failed `aborted`, the run interrupted); `fail`, `unavailable` (run, then
        failed, the run succeeded); `late` (run `compactDelay` seconds later, 2 by default); `drop`, `500-admitted`
        (admitted and run, then no answer, or a 500); `drop-unadmitted`, `refuse-404`, `invalid-400`, `conflict-409`,
        `500` (no answer, or that status, nothing admitted); `other-pending` (another compaction, made up and never
        run, waits in the inbox and answers in place of it); `forget` (answered as admitted, then no record of it is
        kept: nothing in the inbox, no message, nothing run)."""
        given = body if isinstance(body, dict) else {}
        with lock:
            compacts_seen.append({'sessionID': session, 'id': given.get('id'), 'delivery': given.get('delivery'), 'keys': sorted(given)})
        mode, mid, delivery = modes['compact'], given.get('id'), given.get('delivery')
        invalid = lambda why: self.reply(400, {'_tag': 'InvalidRequestError', 'kind': 'Payload', 'message': f'fixture: {why}'})
        conflict = lambda: self.reply(409, {'_tag': 'ConflictError', 'message': f'Message already exists: {mid}'})
        if mode not in COMPACT_MODES:
            return self.reply(500, {'_tag': 'UnknownError', 'message': f'fixture: no compact mode {mode}'})
        if mode == 'drop-unadmitted':
            self.close_connection = True
            return None
        if mode == 'refuse-404':
            return self.reply(404, {'_tag': 'SessionNotFoundError', 'message': f'Session not found: {session}'})
        if mode == 'invalid-400':
            return invalid('refused')
        if mode == 'conflict-409':
            return conflict()
        if mode == '500':
            return self.reply(500, {'_tag': 'UnknownError', 'message': 'fixture: the compaction was not admitted'})
        if not isinstance(body, dict) or (mid is not None and not (isinstance(mid, str) and mid.startswith('msg'))):
            return invalid('a compaction takes an object, its id a message ID')
        if delivery not in (None, 'steer', 'queue'):
            return invalid(f'Invalid delivery: {delivery}')
        state = v2_of(session)
        if mode == 'other-pending' and not any(m in state['compacts'] for m in state['pending']):
            made = v2_message_id()
            with lock:
                state['compacts'][made] = {'delivery': 'queue', 'created': int(time.time() * 1000)}
                state['pending'].append(made)
            save()
            send('session.inbox.enqueued', {'sessionID': session, 'inboxID': made, 'item': {'type': 'compaction', 'delivery': 'queue',
                                                                                         'payload': {}}})
        with lock:
            same = mid in state['compacts']
            other = next((m for m in state['pending'] if m in state['compacts']), None)
        if same:
            return self.reply(200, {'data': v2_compact_item(session, mid)})
        if has_message(session, mid):
            return conflict()
        if other:
            return self.reply(200, {'data': v2_compact_item(session, other)})
        if mode == 'forget':
            mid = mid or v2_message_id()
            return self.reply(200, {'data': {'id': mid, 'sessionID': session, 'time': {'created': int(time.time() * 1000)},
                                             'type': 'compaction', 'payload': {}, 'delivery': delivery or 'queue'}})
        # 2.x commits a staged revert before it admits a compaction (2.2.5 core/src/session/session.ts `compact`).
        v2_commit(session)
        mid, running = mid or v2_message_id(), session in statuses
        delivery = delivery or ('steer' if running else 'queue')
        with lock:
            state['compacts'][mid] = {'delivery': delivery, 'created': int(time.time() * 1000)}
            state['pending'].append(mid)
        save()
        send('session.inbox.enqueued', {'sessionID': session, 'inboxID': mid, 'item': {'type': 'compaction', 'delivery': delivery,
                                                                                    'payload': {}}})
        item = v2_compact_item(session, mid)
        runs = 'run' if mode in ('late', 'drop', '500-admitted') else mode
        later = mode == 'late' or running
        if later:
            compact_later(session, mid, runs, float(modes.get('compactDelay', 2)) if mode == 'late' else 0)
        elif mode in ('drop', '500-admitted'):
            # Run through before the answer is lost: what became of it is its message's.
            compact_run(session, mid, runs)
        if mode == 'drop':
            self.close_connection = True
            return None
        if mode == '500-admitted':
            return self.reply(500, {'_tag': 'UnknownError', 'message': 'fixture: admitted, then the answer failed'})
        self.reply(200, {'data': item})
        if not later:
            compact_run(session, mid, runs)
        return None

    def stage_v2(self, session, body):
        """As 2.x stages a revert (2.2.5 protocol/src/groups/session.ts session.revert.stage, core/src/session/revert.ts
        `stage`; T-61 slice 6): `{messageID, files?}`; a body 2.x can't read is refused (400 InvalidRequestError, kind
        `Payload`), a busy session too (409 SessionBusyError), nothing done. The folder is captured first (`track`, best
        effort: a capture that fails is none), or the held revert's snapshot is taken instead; then the plan is made:
        each file a step stored after the boundary changed (its message's `snapshot`), from the first such step's
        `start`. A boundary the session does not store: 404 MessageNotFoundError, only the capture done. The held
        revert's files go back as that capture holds them, then each planned file as its tree does (`v2_restore`; none of
        the plan's with `files` false); the revert kept is {messageID, snapshot (none without a capture), files}, its
        files what changed from the capture to the folder now among the plan's (`v2_diff`; none without a capture or
        with `files` false); then `session.revert.staged`, and 200 {data: revert}. A restore or a diff that fails (with
        snapshots off, any restore): 500 UnknownError, nothing kept or sent. Mode `stage`: `ok`; `restore-fail` (only
        the plan's first file restored, then 500 UnknownError, nothing kept or sent); `diff-fail` (every file restored,
        then that 500); `capture-fail` (no capture: the plan's files restored, a revert kept with no snapshot and no
        files); `drop` (done, then the connection ends with no answer); `late` (done, answered only on `goOn`); `hold`
        (nothing done until `goOn`, then as `ok`); `body-400` (done, then 400 InvalidRequestError of kind `Body`, as 2.x
        before 2.2.0 answered a response it could not encode); `busy-409` (409 SessionBusyError, idle or not),
        `conflict-409` (409 ConflictError), `500` (500 UnknownError): each answered before anything is captured or
        restored, nothing kept or sent."""
        mid = body.get('messageID') if isinstance(body, dict) else None
        if not isinstance(body, dict) or not (isinstance(mid, str) and mid.startswith('msg')) \
                or not isinstance(body.get('files', False), bool):
            return self.reply(400, {'_tag': 'InvalidRequestError', 'kind': 'Payload',
                                    'message': 'fixture: a revert stage takes an object, its messageID a message ID'})
        mode = modes['stage']
        if mode not in ('ok', 'restore-fail', 'diff-fail', 'capture-fail', 'drop', 'late', 'hold', 'body-400', 'busy-409',
                        'conflict-409', '500'):
            return self.reply(500, {'_tag': 'UnknownError', 'message': f'fixture: no stage mode {mode}'})
        if mode == 'busy-409':
            return self.reply(409, busy(session))
        if mode == 'conflict-409':
            return self.reply(409, {'_tag': 'ConflictError', 'message': 'fixture: not a busy session'})
        if mode == '500':
            return self.reply(500, {'_tag': 'UnknownError', 'message': 'fixture: the stage failed', 'ref': 'err_fixture'})
        if mode == 'hold':
            go_on = threading.Event()
            reverting[session] = go_on
            go_on.wait(60)
        if statuses.get(session, {}).get('type') == 'busy':
            return self.reply(409, busy(session))
        failed = lambda why: self.reply(500, {'_tag': 'UnknownError', 'message': f'fixture: {why}', 'ref': 'err_fixture'})

        def capture():
            # 2.x's capture is best effort (core/src/snapshot.ts `capture`): one that fails is none.
            if mode == 'capture-fail':
                return None
            try:
                return track()
            except RuntimeError:
                return None
        held = sessions[session].get('revert') or {}
        original = held.get('snapshot') or capture()
        # The messages 2.x stores: one steered in is only in the inbox until it is delivered.
        listed = [m for m in ordered(session) if m['info']['id'] not in v2_of(session)['pending']]
        at = next((i for i, m in enumerate(listed) if m['info']['id'] == mid), None)
        if at is None:
            return self.reply(404, {'_tag': 'MessageNotFoundError', 'sessionID': session, 'messageID': mid,
                                    'message': f'Message not found: {mid}'})
        plan = {}
        for message in listed[at + 1:]:
            step = message.get('snapshot') or {}
            if message['info'].get('role') != 'assistant' or message['info'].get('summary') or not step.get('start'):
                continue
            for rel in step.get('files') or []:
                plan.setdefault(rel, step['start'])
        files = body.get('files') is not False
        # One restore, as 2.x's: a file both held and planned goes back as the plan has it.
        restore = {f['file']: original for f in held.get('files') or [] if isinstance(f, dict) and f.get('file')} if original else {}
        if files:
            restore.update(plan)
        try:
            if mode == 'restore-fail':
                v2_restore(dict(list(plan.items())[:1]))
                return failed('the restore failed')
            v2_restore(restore)
            if mode == 'diff-fail':
                return failed('the diff failed')
            changed = v2_diff(original, capture() or original, plan if files else []) if original else []
        except RuntimeError as error:
            return failed(error)
        revert = {'messageID': mid, **({'snapshot': original} if original else {}), 'files': changed}
        with lock:
            sessions[session]['revert'] = revert
        save()
        send('session.revert.staged', {'sessionID': session, 'revert': revert})
        if mode == 'drop':
            self.close_connection = True
            return None
        if mode == 'body-400':
            return self.reply(400, {'_tag': 'InvalidRequestError', 'kind': 'Body', 'message': 'fixture: the response could not be encoded'})
        if mode == 'late':
            go_on = threading.Event()
            reverting[session] = go_on
            go_on.wait(60)
        return self.reply(200, {'data': revert})

    def commit_v2(self, session):
        """As 2.x commits a staged revert on its route (2.2.5 protocol/src/groups/session.ts session.revert.commit,
        core/src/session/session.ts; T-61 slice 6): refused while the session runs (409 SessionBusyError), nothing done;
        else what `v2_commit` does, and 204; with none held, 204 and nothing sent. Mode `commit`: `ok`; `drop` (done,
        then the connection ends with no answer); `500` (nothing done, 500 UnknownError)."""
        if statuses.get(session, {}).get('type') == 'busy':
            return self.reply(409, busy(session))
        mode = modes['commit']
        if mode not in ('ok', 'drop', '500'):
            return self.reply(500, {'_tag': 'UnknownError', 'message': f'fixture: no commit mode {mode}'})
        if mode == '500':
            return self.reply(500, {'_tag': 'UnknownError', 'message': 'fixture: the commit failed', 'ref': 'err_fixture'})
        v2_commit(session)
        if mode == 'drop':
            self.close_connection = True
            return None
        return self.reply(204)

    def clear_v2(self, session):
        """As 2.x clears a staged revert (2.2.5 protocol/src/groups/session.ts session.revert.clear,
        core/src/session/revert.ts `clear`; T-61 slice 6): refused while the session runs (409 SessionBusyError), nothing
        done; else the held revert's files go back as its snapshot holds them (`v2_restore`; none without one), the
        revert is cleared, then `session.revert.cleared`, and 204. None held: 204, nothing done. A restore that fails
        (with snapshots off, any): 500 UnknownError, the revert kept and nothing sent."""
        if statuses.get(session, {}).get('type') == 'busy':
            return self.reply(409, busy(session))
        held = sessions[session].get('revert')
        if not held:
            return self.reply(204)
        original = held.get('snapshot')
        try:
            if original:
                v2_restore({f['file']: original for f in held.get('files') or [] if isinstance(f, dict) and f.get('file')})
        except RuntimeError as error:
            return self.reply(500, {'_tag': 'UnknownError', 'message': f'fixture: {error}', 'ref': 'err_fixture'})
        with lock:
            sessions[session].pop('revert', None)
        save()
        send('session.revert.cleared', {'sessionID': session})
        return self.reply(204)

    def import_v2(self, body):
        """As 2.x imports a session (2.2.5 protocol/src/groups/session.ts session.import, server/src/handlers/session.ts,
        core/src/session/transfer.ts; T-61 slice 7): `{info, messages, location?}`, all or nothing. A body 2.x can't
        decode (`import_refused`): 400 InvalidRequestError, kind `Payload`. A session stored under `info.id` already: 409
        ConflictError; a `parentID` not stored: 404 SessionNotFoundError; nothing done. Else the session is stored under
        `info.id` in the body's `location`, else the server's folder, for the project held now (control `project`; its
        `projectID` and `location` are not taken), with its `title`, `agent`, `model`, `metadata`, `permissions`,
        `parentID`, `cost`, `tokens`, `time.created`, `time.idle` (and `outcome` only with it; `busy` and `viewed` no later
        than it), `time.archived`, and `time.updated` now; nothing else of it (`fork`, `revert`). Only its settled messages
        are kept (`settled`), as they were sent, in order (`v2_view`); one `session.created` is sent; 200 {data: the
        session as `GET /api/session/:id` answers it}. Mode `import`: `ok`; `lost` (done, then the connection ends with no
        answer); `hold` (nothing done until `goOn` with `info.id`, then as `ok`); `fail` (500 UnknownError, nothing done);
        `tamper` (done with its first message kept changed: a user's text, else a `tampered` key, then 200, as a target
        that does not keep what it was sent); `conflict-other` (another session, `other` and with no messages, stored under
        `info.id`, as if held before, then the 409)."""
        why = import_refused(body)
        if why:
            return self.reply(400, {'_tag': 'InvalidRequestError', 'kind': 'Payload', 'message': f'fixture: {why}'})
        mode = modes['import']
        if mode not in IMPORT_MODES:
            return self.reply(500, {'_tag': 'UnknownError', 'message': f'fixture: no import mode {mode}'})
        if mode == 'fail':
            return self.reply(500, {'_tag': 'UnknownError', 'message': 'fixture: the import failed', 'ref': 'err_fixture'})
        info, times = body['info'], body['info']['time']
        sid = info['id']
        if mode == 'hold':
            go_on = threading.Event()
            reverting[sid] = go_on
            go_on.wait(60)
        directory = (body.get('location') or {}).get('directory') or str(WORK)
        kept = [json.loads(json.dumps(m)) for m in body['messages'] if settled(m)]
        if len({m['id'] for m in kept}) != len(kept):
            # 2.x's insert of a message ID twice dies (core/src/session/transfer.ts), and nothing is written.
            return self.reply(500, {'_tag': 'UnknownError', 'message': 'fixture: a message ID repeats', 'ref': 'err_fixture'})
        if mode == 'tamper' and kept:
            if kept[0]['type'] == 'user':
                kept[0]['text'] = str(kept[0].get('text', '')) + ' (tampered)'
            else:
                kept[0]['tampered'] = True
        now = int(time.time() * 1000)
        stored = {'id': sid, 'projectID': current_project[0], 'directory': directory, 'cost': info['cost'],
                  'tokens': json.loads(json.dumps(info['tokens'])), 'time': {'created': times['created'], 'updated': now}}
        if directory.startswith(str(WORK) + os.sep):
            # Its folder relative to the project's (2.x's `subpath`); the project's own folder has none.
            stored['subpath'] = os.path.relpath(directory, WORK)
        for name in ('title', 'agent', 'model', 'metadata', 'permissions', 'parentID'):
            if info.get(name) is not None:
                stored[name] = json.loads(json.dumps(info[name]))
        if times.get('idle') is not None:
            stored['time']['idle'] = times['idle']
            for name in ('busy', 'viewed'):
                if times.get(name) is not None:
                    stored['time'][name] = min(times['idle'], times[name])
            if info.get('outcome') is not None:
                stored['outcome'] = info['outcome']
        if times.get('archived') is not None:
            stored['time']['archived'] = times['archived']
        conflict = lambda: self.reply(409, {'_tag': 'ConflictError', 'message': f'Session already exists: {sid}', 'resource': sid})
        with lock:
            if sid in sessions:
                held = 'conflict'
            elif info.get('parentID') is not None and info['parentID'] not in sessions:
                held = 'parent'
            elif mode == 'conflict-other':
                sessions[sid] = {'id': sid, 'projectID': current_project[0], 'directory': directory, 'title': 'other', 'cost': 0,
                                 'tokens': zero_tokens(), 'time': {'created': now, 'updated': now}}
                held = 'other'
            else:
                sessions[sid] = stored
                imported[sid] = kept
                held = None
        if held == 'conflict':
            return conflict()
        if held == 'parent':
            parent = info['parentID']
            return self.reply(404, {'_tag': 'SessionNotFoundError', 'sessionID': parent, 'message': f'Session not found: {parent}'})
        save()
        if held == 'other':
            return conflict()
        publish('session.created', {'sessionID': sid, 'info': stored})
        if mode == 'lost':
            self.close_connection = True
            return None
        return self.reply(200, {'data': v2_info(stored)})

    def export_v2(self, session):
        """As 2.x exports a session (2.2.5 protocol/src/groups/session.ts session.export, core/src/session/transfer.ts;
        T-61 slice 7): 200 {data: {info, messages}}, its info as `GET /api/session/:id` answers it and its settled messages
        (`settled`), oldest first; 404 SessionNotFoundError for one not stored. `sanitize` is not mirrored."""
        if session not in sessions:
            return self.reply(404, {'_tag': 'SessionNotFoundError', 'sessionID': session, 'message': f'Session not found: {session}'})
        return self.reply(200, {'data': {'info': v2_info(sessions[session]), 'messages': [m for m in v2_view(session) if settled(m)]}})

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
            'database': os.environ.get('OPENCODE_DB'), 'env': GIVEN, 'routingKeys': ROUTING_KEYS, 'configContent': CONFIG_CONTENT, 'passwordFrom': PASSWORD_FROM, 'passwordLength': len(PASSWORD),
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
