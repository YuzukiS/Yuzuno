#!/usr/bin/env python3
"""Contract probe of the published DeepSeek Harness (dsh) (YN-126).

Core connects to dsh over its ACP interface (`dsh --profile acp`, JSON-RPC on
stdio), as YN-119's design v1 lays out. That design rests on what its section
2 probed by hand on the published 0.2.2-rc.1 and 0.2.2-rc.3. This script
repeats that probe against any installed dsh and asserts every row of that
table, so the daily workflow (.github/workflows/dsh-contract.yml) turns red
when a new npm `latest` or `next` changes one of them.

Nothing real is contacted and no secret is used: each dsh process gets a
synthetic HOME and DSH_HOME and a placeholder key; a scripted
Anthropic-Messages endpoint on 127.0.0.1 stands in for DeepSeek (dsh's own
DEEPSEEK_BASE_URL recipe), and a scripted MCP endpoint with a Bearer token
for Core's /mcp. Every overlay is the one Core writes (design 3.2): session
log and plugin inventory uploads off, telemetry off, and the model, sandbox
and approval policy as literal values.

Usage: dsh_contract_probe.py --dsh BIN --out DIR
DIR is emptied first; it receives report.json, every ACP frame, the fake
endpoints' request logs and each command's output. Exit 0 when every check
holds, 1 when any fails (the output and report.json name them), 2 on a usage
error.
"""
import argparse
import base64
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
import traceback
import zlib
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = 'probe-token-not-a-secret'
KEY = 'probe-placeholder-not-a-key'
MARKER = 'YN126-AGENTS-MARKER'
SEMVER = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)

# Time limits are Core's own, from the design, so a slower dsh fails here
# before it fails a user's start.
VERSION_LIMIT = 10   # 5.1: `dsh --version`, 10 s
DUMP_LIMIT = 15      # 3.3: `--dump-config`, 15 s
START_LIMIT = 20     # 3.9: initialize and session/new of the model catalog, 20 s at most
CANCEL_LIMIT = 10    # 3.5: the prompt answers `cancelled` within 10 s of session/cancel
EXIT_LIMIT = 5       # 3.1: Core waits 5 s after closing stdin, then 5 s after SIGTERM
SCHEMA_LIMIT = 60    # the schema is read once per (binary, version) and cached
TURN_LIMIT = 90      # the probe's own: one scripted turn against the local fake model

# Design 3.2: the rows Core's overlay patches. The first two switch off the
# uploads the user chose to keep off.
UPLOAD_ROWS = ['session-log-deepseek', 'plugin-package-inventory-deepseek']
OVERLAY_ROWS = UPLOAD_ROWS + ['session-telemetry-otel', 'acp', 'sandbox-policy', 'approval']


def overlay_text(rows, mode, policy, ws, extra):
    blocks = {
        'session-log-deepseek': ['  config:', '    enabled: false'],
        'plugin-package-inventory-deepseek': ['  config:', '    enabled: false'],
        'session-telemetry-otel': ['  disabled: true'],
        'acp': ['  config:', '    provider: deepseek-official', '    model: deepseek-flash'],
        'sandbox-policy': ['  config:', f'    mode: {mode}', f'    workspaceRoot: {json.dumps(ws)}',
                           '    additionalWritableRoots:', f'      - {json.dumps(extra)}'],
        'approval': ['  config:', f'    policy: {policy}'],
    }
    lines = []
    for row in rows:
        lines += [f'- id: {row}'] + blocks[row]
    return '\n'.join(lines) + '\n'


def scalars(row, mode, policy):
    """What Core finds again, as text, in its row of the composed configuration."""
    return {'session-log-deepseek': ['enabled: false'],
            'plugin-package-inventory-deepseek': ['enabled: false'],
            'session-telemetry-otel': ['disabled: true'],
            'acp': ['provider: deepseek-official', 'model: deepseek-flash'],
            'sandbox-policy': [f'mode: {mode}'],
            'approval': [f'policy: {policy}']}[row]


class Checks:
    def __init__(self):
        self.items = []

    def add(self, row, name, ok, detail=None):
        ok = bool(ok)
        self.items.append({'row': row, 'check': name, 'ok': ok, 'detail': detail})
        text = '' if ok or detail is None else ' -- ' + json.dumps(detail, default=str)[:800]
        print(f"{'PASS' if ok else 'FAIL'} [{row}] {name}{text}", flush=True)
        return ok

    def failed(self):
        return [c for c in self.items if not c['ok']]


class Log:
    """A thread-safe list of request records, also written as JSON lines."""

    def __init__(self, path):
        self.path = path
        self.records = []
        self.lock = threading.Lock()

    def add(self, record):
        with self.lock:
            record['n'] = len(self.records)
            self.records.append(record)
            with open(self.path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')

    def since(self, n):
        with self.lock:
            return list(self.records[n:])

    def mark(self):
        with self.lock:
            return len(self.records)


def text_of(content):
    if isinstance(content, str):
        return content
    return '\n'.join(b.get('text', '') for b in content or [] if isinstance(b, dict) and b.get('type') == 'text')


def tool_results(content):
    if isinstance(content, str):
        return []
    found = []
    for block in content or []:
        if isinstance(block, dict) and block.get('type') == 'tool_result':
            body = block.get('content')
            if isinstance(body, list):
                body = '\n'.join(b.get('text', '') for b in body if isinstance(b, dict))
            found.append({'id': block.get('tool_use_id'), 'text': str(body)[:600], 'isError': block.get('is_error')})
    return found


def has_image(messages):
    return any(isinstance(b, dict) and b.get('type') == 'image'
               for m in messages if isinstance(m.get('content'), list) for b in m['content'])


def fake_model(log, outside, extra):
    """A scripted Anthropic-Messages SSE endpoint. The newest user turn decides:
    PROBE-TEXT thinking and a text reply; PROBE-MCP the Yuzuno ping tool;
    PROBE-EXTRA a write into the extra writable root; PROBE-OUTSIDE a write
    outside the workspace and, after the sandbox refuses it, the same command
    with sandbox_permissions; PROBE-INSIDE the same inside the workspace;
    PROBE-SLEEP `sleep 47`; PROBE-IMAGE and PROBE-RESUME a text saying whether
    the request carried an image and how many messages."""
    counter = [0]

    def bash(call_id, command, extra=None):
        args = {'description': 'Probe command', 'command': command}
        args.update(extra or {})
        return ('tool', call_id, 'bash', args)

    def decide(messages):
        last = messages[-1] if messages else {}
        results = tool_results(last.get('content'))
        if results:
            r = results[0]
            rid = r['id'] or ''
            denied = 'sandbox' in r['text'].lower() or 'denied' in r['text'].lower()
            if rid == 'call-OUTSIDE-1' and denied:
                return bash('call-OUTSIDE-2', f'echo hi > {outside}/a.txt && echo wrote-outside',
                            {'sandbox_permissions': 'danger-full-access',
                             'justification': 'The probe needs to write outside the workspace.'})
            if rid == 'call-INSIDE-1' and denied:
                return bash('call-INSIDE-2', 'echo hi > inside.txt && echo wrote-inside',
                            {'sandbox_permissions': 'workspace-write',
                             'justification': 'The probe needs to write inside the workspace.'})
            return ('text', f"after {rid}: {r['text'][:200]}")
        user = text_of(last.get('content'))
        counter[0] += 1
        n = counter[0]
        if 'PROBE-TEXT' in user:
            return ('thinking-text', 'fake-text-reply')
        if 'PROBE-MCP' in user:
            return ('tool', f'call-MCP-{n}', 'mcp__yuzuno__ping', {})
        if 'PROBE-EXTRA' in user:
            return bash(f'call-EXTRA-{n}', f'echo hi > {extra}/b.txt && echo wrote-extra')
        if 'PROBE-OUTSIDE' in user:
            return bash('call-OUTSIDE-1', f'echo hi > {outside}/a.txt && echo wrote-outside')
        if 'PROBE-INSIDE' in user:
            return bash('call-INSIDE-1', 'echo hi > inside.txt && echo wrote-inside')
        if 'PROBE-SLEEP' in user:
            return bash(f'call-SLEEP-{n}', 'sleep 47 && echo slept')
        if 'PROBE-IMAGE' in user:
            return ('text', f'image-seen={has_image(messages)}')
        if 'PROBE-RESUME' in user:
            return ('text', f'history-messages={len(messages)}')
        return ('text', 'fake-default-reply')

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def do_GET(self):
            log.add({'kind': 'get', 'path': self.path, 'proc': PROC[0]})
            body = json.dumps({'object': 'list', 'data': []}).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def sse(self, payload):
            self.wfile.write(f"event: {payload['type']}\ndata: {json.dumps(payload)}\n\n".encode())
            self.wfile.flush()

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get('content-length') or 0))
            try:
                body = json.loads(raw)
            except Exception:
                body = {}
            if not isinstance(body, dict):
                body = {}
            messages = body.get('messages') or []
            system = body.get('system')
            system_text = system if isinstance(system, str) else json.dumps(system)
            tools = [t.get('name') for t in body.get('tools') or [] if isinstance(t, dict)]
            decision = decide(messages)
            log.add({
                'kind': 'post', 'path': self.path, 'proc': PROC[0],
                'headerNames': sorted(k.lower() for k in self.headers.keys()),
                'harnessHeaders': {k.lower(): v for k, v in self.headers.items()
                                   if k.lower().startswith('x-deepseek-harness-')},
                'apiKeyPresent': bool(self.headers.get('x-api-key') or self.headers.get('authorization')),
                'bodyKeys': sorted(body.keys()),
                'model': body.get('model'),
                'thinking': body.get('thinking'),
                'outputConfig': body.get('output_config'),
                'messageCount': len(messages),
                'lastText': text_of(messages[-1].get('content'))[:300] if messages else None,
                'toolResults': [r for m in messages for r in tool_results(m.get('content'))],
                'hasImage': has_image(messages),
                'toolNames': tools,
                'agentsMarker': MARKER in (system_text or '') or any(MARKER in json.dumps(m) for m in messages),
                'hasSessionLog': 'dsh_session_log' in body,
                'hasPluginPackages': 'dsh_plugin_packages' in body,
                'decision': decision[0],
                'decisionId': decision[1] if decision[0] == 'tool' else None,
            })
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('cache-control', 'no-cache')
            self.send_header('connection', 'close')
            self.end_headers()
            self.sse({'type': 'message_start', 'message': {
                'id': 'fake-msg', 'type': 'message', 'role': 'assistant', 'model': body.get('model'),
                'content': [], 'usage': {'input_tokens': 1234, 'output_tokens': 0, 'cache_read_input_tokens': 100}}})
            kind, index = decision[0], 0
            if kind == 'thinking-text':
                self.sse({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'thinking', 'thinking': ''}})
                self.sse({'type': 'content_block_delta', 'index': 0,
                          'delta': {'type': 'thinking_delta', 'thinking': 'fake thinking'}})
                self.sse({'type': 'content_block_stop', 'index': 0})
                kind, index = 'text', 1
            if kind == 'text':
                text = decision[1]
                self.sse({'type': 'content_block_start', 'index': index, 'content_block': {'type': 'text', 'text': ''}})
                # Two deltas: dsh is expected to pass the step on whole, not streamed.
                for part in (text[:len(text) // 2], text[len(text) // 2:]):
                    self.sse({'type': 'content_block_delta', 'index': index,
                              'delta': {'type': 'text_delta', 'text': part}})
                self.sse({'type': 'content_block_stop', 'index': index})
                stop = 'end_turn'
            else:
                _, call_id, name, args = decision
                self.sse({'type': 'content_block_start', 'index': 0,
                          'content_block': {'type': 'tool_use', 'id': call_id, 'name': name, 'input': {}}})
                self.sse({'type': 'content_block_delta', 'index': 0,
                          'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(args)}})
                self.sse({'type': 'content_block_stop', 'index': 0})
                stop = 'tool_use'
            self.sse({'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None},
                      'usage': {'output_tokens': 42}})
            self.sse({'type': 'message_stop'})
            self.close_connection = True

    return Handler


def fake_mcp(log):
    """A streamable-HTTP MCP endpoint with one tool, `ping`, that checks the
    Bearer token as Core's /mcp does and, like it, does not know server/discover."""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def reply(self, status, obj=None, extra=None):
            body = b'' if obj is None else json.dumps(obj).encode()
            self.send_response(status)
            if obj is not None:
                self.send_header('content-type', 'application/json')
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            log.add({'kind': 'get', 'path': self.path, 'proc': PROC[0]})
            self.reply(405)

        def do_DELETE(self):
            log.add({'kind': 'delete', 'path': self.path, 'proc': PROC[0]})
            self.reply(200)

        def do_POST(self):
            auth = self.headers.get('authorization') == f'Bearer {TOKEN}'
            try:
                msg = json.loads(self.rfile.read(int(self.headers.get('content-length') or 0)))
            except Exception:
                msg = {}
            if not isinstance(msg, dict):
                msg = {}
            method, mid = msg.get('method'), msg.get('id')
            log.add({'kind': 'post', 'path': self.path, 'proc': PROC[0], 'auth': auth, 'method': method,
                     'params': msg.get('params')})
            if not auth:
                return self.reply(401, {'error': 'unauthorized'})
            if mid is None:
                return self.reply(202)
            if method == 'initialize':
                pv = (msg.get('params') or {}).get('protocolVersion') or '2025-06-18'
                return self.reply(200, {'jsonrpc': '2.0', 'id': mid, 'result': {
                    'protocolVersion': pv, 'capabilities': {'tools': {}},
                    'serverInfo': {'name': 'fake-yuzuno', 'version': '0'}}}, {'mcp-session-id': 'probe-session'})
            if method == 'tools/list':
                result = {'tools': [{'name': 'ping', 'description': 'Probe ping.',
                                     'inputSchema': {'type': 'object', 'properties': {}}}]}
            elif method == 'tools/call':
                result = {'content': [{'type': 'text', 'text': 'pong'}]}
            elif method == 'ping':
                result = {}
            else:
                return self.reply(200, {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': 'not found'}})
            self.reply(200, {'jsonrpc': '2.0', 'id': mid, 'result': result})

    return Handler


def serve(handler):
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# Which dsh process the fake endpoints are serving, for their logs.
PROC = ['-']


class Acp:
    """One `dsh --profile acp` process, driven as Core's client would."""

    def __init__(self, name, argv, env, cwd, frames):
        self.name = name
        self.frames = frames
        self.stderr_path = os.path.join(OUT, f'{name}.stderr.txt')
        self.stderr = open(self.stderr_path, 'wb')
        PROC[0] = name
        self.p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
                                  env=env, cwd=cwd)
        self.next_id = 1
        self.responses, self.updates, self.requests = {}, [], []
        self.policy = 'reject'
        self.cond = threading.Condition()
        threading.Thread(target=self.read, daemon=True).start()

    def frame(self, direction, msg):
        with FRAMES_LOCK:
            self.frames.write(json.dumps({'t': round(time.monotonic() - T0, 3), 'proc': self.name,
                                          'dir': direction, 'msg': msg}) + '\n')
            self.frames.flush()

    def send(self, msg):
        self.frame('out', msg)
        self.p.stdin.write((json.dumps(msg) + '\n').encode())
        self.p.stdin.flush()

    def read(self):
        for line in self.p.stdout:
            try:
                msg = json.loads(line)
            except Exception:
                self.frame('in-raw', line.decode('utf-8', 'replace')[:2000])
                continue
            self.frame('in', msg)
            with self.cond:
                if 'id' in msg and ('result' in msg or 'error' in msg) and 'method' not in msg:
                    self.responses[msg['id']] = msg
                elif 'method' in msg and 'id' in msg:
                    self.requests.append(msg)
                    threading.Thread(target=self.answer, args=(msg,), daemon=True).start()
                elif 'method' in msg:
                    self.updates.append(msg)
                self.cond.notify_all()
        with self.cond:
            self.cond.notify_all()

    def answer(self, msg):
        if msg['method'] == 'session/request_permission':
            want = 'allow_once' if self.policy == 'allow' else 'reject_once'
            chosen = next((o['optionId'] for o in msg['params'].get('options') or [] if o.get('kind') == want), None)
            outcome = {'outcome': 'selected', 'optionId': chosen} if chosen else {'outcome': 'cancelled'}
            self.send({'jsonrpc': '2.0', 'id': msg['id'], 'result': {'outcome': outcome}})
        else:
            self.send({'jsonrpc': '2.0', 'id': msg['id'],
                       'error': {'code': -32601, 'message': 'the probe client does not serve this'}})

    def request_async(self, method, params):
        mid = self.next_id
        self.next_id += 1
        self.send({'jsonrpc': '2.0', 'id': mid, 'method': method, 'params': params})
        return mid

    def wait(self, mid, limit):
        deadline = time.monotonic() + limit
        with self.cond:
            while mid not in self.responses:
                left = deadline - time.monotonic()
                if left <= 0 or self.p.poll() is not None:
                    return self.responses.get(mid)
                self.cond.wait(min(left, 0.5))
            return self.responses[mid]

    def request(self, method, params, limit):
        return self.wait(self.request_async(method, params), limit)

    def notify(self, method, params):
        self.send({'jsonrpc': '2.0', 'method': method, 'params': params})

    def mark(self):
        with self.cond:
            return len(self.updates), len(self.requests)

    def updates_since(self, n):
        with self.cond:
            return [(u.get('params') or {}).get('update') or {} for u in self.updates[n:]]

    def close(self, how):
        t = time.monotonic()
        try:
            if how == 'eof':
                self.p.stdin.close()
            else:
                self.p.send_signal(signal.SIGTERM)
            code = self.p.wait(EXIT_LIMIT)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait()
            code = None
        self.stderr.close()
        return code, time.monotonic() - t

    def kill(self):
        if self.p.poll() is None:
            self.p.kill()
            self.p.wait()


def result_of(resp):
    return (resp or {}).get('result') if isinstance(resp, dict) else None


def config_option(options, oid):
    return next((o for o in options or [] if isinstance(o, dict) and o.get('id') == oid), None)


def option_values(option):
    """The values a config option offers, flat or in groups."""
    values = []
    for item in (option or {}).get('options') or []:
        if isinstance(item, dict) and 'value' in item:
            values.append(item['value'])
        elif isinstance(item, dict):
            values += [c.get('value') for c in item.get('options') or [] if isinstance(c, dict)]
    return values


def make_png():
    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)
    raw = b''.join(b'\x00' + b'\xff\x00\x00' * 2 for _ in range(2))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def sleepers():
    found = []
    for pid in os.listdir('/proc'):
        if pid.isdigit():
            try:
                with open(f'/proc/{pid}/cmdline', 'rb') as f:
                    cmd = f.read().replace(b'\0', b' ').decode('utf-8', 'replace')
            except OSError:
                continue
            if cmd.startswith('sleep 47'):
                found.append(pid)
    return found


def dump_rows(text):
    """The composed configuration as {row id: {'header': the `# ==` line above
    its group, 'lines': its lines}}. `--dump-config` prints each row as a
    top-level `- id: ...` item, under one header per group of rows that names
    the layers that made it."""
    rows, header, current = {}, None, None
    for line in text.splitlines():
        if line.startswith('# =='):
            header, current = line, None
        elif line.startswith('- '):
            match = re.match(r'^- id: (\S+)\s*$', line)
            current = {'header': header, 'lines': []}
            rows[match.group(1) if match else f'?{len(rows)}'] = current
        elif current is not None:
            current['lines'].append(line)
    return rows


def row_name(row):
    for line in row['lines']:
        match = re.match(r'^  name: (.+?)\s*$', line)
        if match:
            return match.group(1).strip('\'"')
    return None


def resolve(schema, node):
    """Follow local $refs (#/...) to the schema they name."""
    for _ in range(16):
        if not (isinstance(node, dict) and '$ref' in node):
            break
        ref = node['$ref']
        if not ref.startswith('#/'):
            return {}
        node = schema
        for part in ref[2:].split('/'):
            node = node.get(part.replace('~1', '/').replace('~0', '~'), {}) if isinstance(node, dict) else {}
    return node


def config_schemas(schema, package):
    """Design 3.3 step 3: the package's branch in $defs.entry.allOf and the
    config schemas its then.properties.config.anyOf refers to."""
    entry = resolve(schema, ((schema.get('$defs') or {}).get('entry')) or {})
    for branch in entry.get('allOf') or []:
        name = (((branch.get('if') or {}).get('properties') or {}).get('name') or {}).get('const')
        if name == package:
            config = ((branch.get('then') or {}).get('properties') or {}).get('config') or {}
            options = config.get('anyOf') or [config]
            return [resolve(schema, o) for o in options]
    return None


def properties(schema, node, depth=0):
    """The properties an object schema names, in it or in any of its
    anyOf/oneOf/allOf branches: dsh wraps each config as anyOf [the object,
    a !!js expression], whose own marker key is not a config key."""
    if isinstance(node, dict) and node.get('$ref') == '#/$defs/loaderExpression':
        return {}
    node = resolve(schema, node)
    found = {}
    if not isinstance(node, dict) or depth > 8:
        return found
    found.update(node.get('properties') or {})
    for key in ('anyOf', 'oneOf', 'allOf'):
        for sub in node.get(key) or []:
            found.update(properties(schema, sub, depth + 1))
    return found


def consts(schema, node, depth=0):
    """Every const and enum value a property schema allows."""
    node = resolve(schema, node)
    found = []
    if not isinstance(node, dict) or depth > 8:
        return found
    if 'const' in node:
        found.append(node['const'])
    found += list(node.get('enum') or [])
    for key in ('anyOf', 'oneOf', 'allOf'):
        for sub in node.get(key) or []:
            found += consts(schema, sub, depth + 1)
    return found


def main():
    global OUT, T0, FRAMES_LOCK
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--dsh', required=True, help='the dsh executable to probe')
    ap.add_argument('--out', required=True, help='a directory for the report and raw records (emptied first)')
    args = ap.parse_args()
    dsh = shutil.which(args.dsh) or args.dsh
    if not (os.path.isfile(dsh) and os.access(dsh, os.X_OK)):
        print(f'dsh_contract_probe: {args.dsh} is not an executable', file=sys.stderr)
        return 2
    node = shutil.which('node')
    if not node:
        print('dsh_contract_probe: no node on PATH', file=sys.stderr)
        return 2
    OUT = os.path.abspath(args.out)
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    T0 = time.monotonic()
    FRAMES_LOCK = threading.Lock()
    checks = Checks()
    report = {'dsh': os.path.realpath(dsh), 'node': None, 'version': None, 'checks': checks.items}
    frames = open(os.path.join(OUT, 'frames.jsonl'), 'w', encoding='utf-8')
    model_log = Log(os.path.join(OUT, 'model-requests.jsonl'))
    mcp_log = Log(os.path.join(OUT, 'mcp-requests.jsonl'))

    root = os.path.join(OUT, 'w')
    home = os.path.join(root, 'home')
    ws = os.path.join(root, 'ws')
    outside = os.path.join(root, 'outside')
    extra = os.path.join(root, 'extra')
    for d in (home, ws, outside, extra):
        os.makedirs(d)
    model = serve(fake_model(model_log, outside, extra))
    mcp = serve(fake_mcp(mcp_log))
    mcp_servers = [{'type': 'http', 'name': 'yuzuno', 'url': f'http://127.0.0.1:{mcp.server_address[1]}/mcp/probe-agent',
                    'headers': [{'name': 'Authorization', 'value': f'Bearer {TOKEN}'}]}]
    path = os.pathsep.join([os.path.dirname(os.path.realpath(node)), '/usr/bin', '/bin'])
    procs = []

    def env_for(home_name, mode):
        dsh_home = os.path.join(root, home_name)
        os.makedirs(dsh_home, exist_ok=True)
        # Core writes the session notice here at every start (design 3.1).
        with open(os.path.join(dsh_home, 'AGENTS.md'), 'w') as f:
            f.write(f'{MARKER}: the instructions Core writes for this Agent.\n')
        tmp = os.path.join(root, home_name + '-tmp')
        os.makedirs(tmp, exist_ok=True)
        return {'PATH': path, 'LANG': 'C.UTF-8', 'HOME': home, 'TMPDIR': tmp, 'DSH_HOME': dsh_home,
                'DSH_PERMISSION_MODE': mode, 'DSH_TELEMETRY_DISABLED': '1', 'DEEPSEEK_API_KEY': KEY,
                'DEEPSEEK_BASE_URL': f'http://127.0.0.1:{model.server_address[1]}/v1'}

    def write_overlay(name, rows, mode, policy):
        p = os.path.join(root, f'overlay-{name}.yml')
        with open(p, 'w') as f:
            f.write(overlay_text(rows, mode, policy, ws, extra))
        return p

    def run(name, argv, env, limit, stdin=None):
        t = time.monotonic()
        PROC[0] = name
        try:
            r = subprocess.run(argv, env=env, cwd=ws, input=stdin, capture_output=True, timeout=limit)
            out, err, code = r.stdout.decode('utf-8', 'replace'), r.stderr.decode('utf-8', 'replace'), r.returncode
        except subprocess.TimeoutExpired as e:
            out = (e.stdout or b'').decode('utf-8', 'replace')
            err = (e.stderr or b'').decode('utf-8', 'replace')
            code = 'timeout'
        for suffix, text in (('stdout', out), ('stderr', err)):
            with open(os.path.join(OUT, f'{name}.{suffix}.txt'), 'w', encoding='utf-8') as f:
                f.write(text)
        return code, out, err, time.monotonic() - t

    def start(name, overlay, env):
        acp = Acp(name, [dsh, '--profile', 'acp', '--patch', overlay], env, ws, frames)
        procs.append(acp)
        return acp

    def initialize(acp):
        return acp.request('initialize', {
            'protocolVersion': 1,
            'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False},
            'clientInfo': {'name': 'yuzuno-contract-probe', 'version': '0'}}, START_LIMIT)

    def prompt(acp, sid, text, policy='reject', image=False, cancel_after_tool=False):
        acp.policy = policy
        PROC[0] = acp.name
        u0, r0 = acp.mark()
        m0 = model_log.mark()
        blocks = [{'type': 'text', 'text': text}]
        if image:
            blocks.append({'type': 'image', 'mimeType': 'image/png', 'data': base64.b64encode(make_png()).decode()})
        t = time.monotonic()
        mid = acp.request_async('session/prompt', {'sessionId': sid, 'prompt': blocks})
        cancel_at = None
        if cancel_after_tool:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and not any(
                    u.get('sessionUpdate') == 'tool_call' for u in acp.updates_since(u0)):
                time.sleep(0.2)
            time.sleep(2)
            acp.notify('session/cancel', {'sessionId': sid})
            cancel_at = time.monotonic()
        resp = acp.wait(mid, TURN_LIMIT)
        done = time.monotonic()
        with acp.cond:
            requests = [r.get('params') for r in acp.requests[r0:]]
        return {'resp': resp, 'stop': (result_of(resp) or {}).get('stopReason'), 'updates': acp.updates_since(u0),
                'requests': requests, 'model': model_log.since(m0), 'seconds': done - t,
                'afterCancel': None if cancel_at is None else done - cancel_at}

    def kinds(turn):
        return Counter(u.get('sessionUpdate') for u in turn['updates'])

    def tool_call(turn, call_id):
        return next((u for u in turn['updates'] if u.get('sessionUpdate') == 'tool_call'
                     and u.get('toolCallId') == call_id), None)

    def check_dump(row, name, overlay, env, mode, policy):
        code, out, err, secs = run(name, [dsh, '--profile', 'acp', '--patch', overlay, '--dump-config'], env, DUMP_LIMIT)
        checks.add(row, f'{name}: exit 0 within {DUMP_LIMIT} s', code == 0, {'exit': code, 'seconds': round(secs, 2)})
        checks.add(row, f'{name}: stderr is empty', err == '', err[-800:])
        rows = dump_rows(out)
        for rid in OVERLAY_ROWS:
            found = rows.get(rid)
            checks.add(row, f'{name}: row {rid} is there', found is not None, sorted(k for k in rows if not k.startswith('?')))
            if found is None:
                continue
            header = found['header'] or ''
            checks.add(row, f'{name}: row {rid} is patched last by this overlay',
                       header.rstrip().endswith(f'patched by {overlay}'), header)
            body = '\n'.join(found['lines'])
            missing = [s for s in scalars(rid, mode, policy) if not re.search(rf'(^|\s){re.escape(s)}\s*$', body, re.M)]
            checks.add(row, f'{name}: row {rid} keeps the literal values', not missing, {'missing': missing, 'row': body[:600]})
        return rows

    try:
        # --- Version (design 1 and 5.1): `dsh --version` prints the bare version.
        env = env_for('dsh-home-ask', 'workspace-write')
        code, out, err, secs = run('version', [dsh, '--version'], env, VERSION_LIMIT)
        version = out.strip()
        report['version'] = version
        report['node'] = run('node-version', [node, '--version'], env, VERSION_LIMIT)[1].strip()
        checks.add('version', f'`dsh --version` exits 0 within {VERSION_LIMIT} s', code == 0, {'exit': code, 'stderr': err[-400:]})
        checks.add('version', '`dsh --version` prints a bare semver version', SEMVER.match(version), out[:200])

        # --- --dump-config: Core's read-back (3.3 step 2) of its own overlay at each level it keeps.
        ask_overlay = write_overlay('ask', OVERLAY_ROWS, 'workspace-write', 'ask')
        full_overlay = write_overlay('full', OVERLAY_ROWS, 'danger-full-access', 'never')
        ro_overlay = write_overlay('ro', OVERLAY_ROWS, 'read-only', 'ask')
        dumped = check_dump('dump-config', 'dump-ask', ask_overlay, env, 'workspace-write', 'ask')
        # Rows Core leaves to dsh's environment print as an unevaluated !!js expression.
        bare = write_overlay('bare', ['acp'], 'workspace-write', 'ask')
        code, out, err, _ = run('dump-bare', [dsh, '--profile', 'acp', '--patch', bare, '--dump-config'], env, DUMP_LIMIT)
        bare_rows = dump_rows(out)
        for rid in ('approval', 'session-telemetry-otel'):
            body = '\n'.join((bare_rows.get(rid) or {}).get('lines') or [])
            checks.add('dump-config', f'without Core\'s row, {rid} shows an unevaluated !!js expression',
                       '!!js' in body, body[:600])

        # --- Strictness (probe ea68fd90) and Core's schema check (3.3 step 3).
        code, out, err, secs = run('schema', [dsh, '--profile', 'acp', '--dump-config-schema'], env, SCHEMA_LIMIT)
        try:
            schema = json.loads(out)
        except ValueError as e:
            schema = None
            checks.add('strictness', '--dump-config-schema prints JSON', False, {'exit': code, 'error': str(e), 'stderr': err[-400:]})
        if schema is not None:
            checks.add('strictness', '--dump-config-schema prints JSON', True)
            report['schemaBytes'] = len(out)
            for rid in OVERLAY_ROWS:
                package = row_name(dumped.get(rid) or {'lines': []})
                if not checks.add('strictness', f'row {rid} names its package', package, (dumped.get(rid) or {}).get('lines')):
                    continue
                configs = config_schemas(schema, package)
                if not checks.add('strictness', f'the schema has an entry branch for {package}', configs is not None):
                    continue
                if rid == 'session-telemetry-otel':
                    # Core writes no config there, only the entry's own `disabled`.
                    meta = properties(schema, (schema.get('$defs') or {}).get('entryMetadata'))
                    checks.add('strictness', 'session-telemetry-otel: the entry schema has disabled', 'disabled' in meta,
                               sorted(meta))
                    continue
                props = {}
                for c in configs:
                    props.update(properties(schema, c))
                keys = {'session-log-deepseek': ['enabled'], 'plugin-package-inventory-deepseek': ['enabled'],
                        'acp': ['provider', 'model'], 'sandbox-policy': ['mode', 'workspaceRoot', 'additionalWritableRoots'],
                        'approval': ['policy']}[rid]
                missing = [k for k in keys if k not in props]
                checks.add('strictness', f'{rid}: the config schema lists every key Core writes', not missing,
                           {'missing': missing, 'properties': sorted(props)[:40]})
                checks.add('strictness', f'{rid}: the config schema refuses an unknown key',
                           'yuzunoUnknownKey' not in props)
                if rid == 'sandbox-policy':
                    allowed = consts(schema, props.get('mode'))
                    checks.add('strictness', 'sandbox-policy: mode allows the three presets',
                               {'read-only', 'workspace-write', 'danger-full-access'} <= set(allowed), allowed)
                    checks.add('strictness', 'sandbox-policy: mode refuses another value', 'yuzuno-no-such-mode' not in allowed)
                if rid == 'approval':
                    allowed = consts(schema, props.get('policy'))
                    checks.add('strictness', 'approval: policy allows ask and never', {'ask', 'never'} <= set(allowed), allowed)
        # dsh itself is lax, which is why Core checks: an unknown key boots, a missing row only warns,
        # a wrong value boots and complains on stderr.
        init_line = (json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                                 'params': {'protocolVersion': 1, 'clientCapabilities': {}}}) + '\n').encode()
        lax = os.path.join(root, 'overlay-lax-key.yml')
        with open(lax, 'w') as f:
            f.write('- id: session-log-deepseek\n  config:\n    enabled: false\n    yuzunoUnknownKey: 1\n')
        code, out, err, _ = run('boot-lax-key', [dsh, '--profile', 'acp', '--patch', lax], env, 60, stdin=init_line)
        checks.add('strictness', 'an unknown config key still boots and answers initialize', '"id":1' in out.replace(' ', ''), out[:300])
        gone = os.path.join(root, 'overlay-lax-row.yml')
        with open(gone, 'w') as f:
            f.write('- id: yuzuno-no-such-row\n  config:\n    enabled: false\n')
        code, out, err, _ = run('dump-lax-row', [dsh, '--profile', 'acp', '--patch', gone, '--dump-config'], env, DUMP_LIMIT)
        checks.add('strictness', 'a row that does not exist only warns on stderr, exit 0',
                   code == 0 and 'yuzuno-no-such-row' in err and 'not found' in err, {'exit': code, 'stderr': err[-400:]})
        bad = os.path.join(root, 'overlay-lax-mode.yml')
        with open(bad, 'w') as f:
            f.write(f'- id: sandbox-policy\n  config:\n    mode: yuzuno-no-such-mode\n    workspaceRoot: {json.dumps(ws)}\n')
        code, out, err, _ = run('boot-lax-mode', [dsh, '--profile', 'acp', '--patch', bad], env, 60, stdin=init_line)
        checks.add('strictness', 'a wrong value still answers initialize and complains on stderr',
                   '"id":1' in out.replace(' ', '') and err.strip() != '', {'stdout': out[:300], 'stderr': err[-400:]})

        # --- Start and initialize (ask level: workspace-write + ask).
        t = time.monotonic()
        ask = start('ask', ask_overlay, env)
        init = initialize(ask)
        res = result_of(init) or {}
        caps = res.get('agentCapabilities') or {}
        checks.add('start', 'initialize answers', res, init)
        checks.add('start', 'protocolVersion is 1', res.get('protocolVersion') == 1, res.get('protocolVersion'))
        checks.add('start', 'MCP over http', (caps.get('mcpCapabilities') or {}).get('http') is True, caps)
        checks.add('start', 'images with deepseek-flash', (caps.get('promptCapabilities') or {}).get('image') is True, caps)
        sc = caps.get('sessionCapabilities') or {}
        checks.add('start', 'sessionCapabilities has close, list and resume',
                   all(k in sc for k in ('close', 'list', 'resume')), sc)
        checks.add('start', 'authMethods is empty', res.get('authMethods') == [], res.get('authMethods'))

        # --- session/new.
        new = ask.request('session/new', {'cwd': ws, 'mcpServers': mcp_servers}, START_LIMIT)
        started = time.monotonic() - t
        res = result_of(new) or {}
        sid = res.get('sessionId')
        checks.add('start', f'start, initialize and session/new within {START_LIMIT} s', new and started <= START_LIMIT,
                   round(started, 2))
        checks.add('session-new', 'session/new returns a sessionId', isinstance(sid, str) and sid, new)
        if not sid:
            raise RuntimeError('no session; the turns cannot run')
        opts = res.get('configOptions') or []
        model_opt = config_option(opts, 'model')
        effort_opt = config_option(opts, 'reasoning_effort')
        checks.add('session-new', 'configOptions has model with an opaque string value',
                   model_opt and isinstance(model_opt.get('currentValue'), str) and model_opt['currentValue'], model_opt)
        efforts = option_values(effort_opt)
        checks.add('session-new', 'configOptions has reasoning_effort with low among its values', 'low' in efforts,
                   effort_opt)

        # --- A text turn: one thought, one message and one usage update, not streamed.
        turn = prompt(ask, sid, 'PROBE-TEXT hello')
        k = kinds(turn)
        checks.add('text-turn', 'stopReason end_turn', turn['stop'] == 'end_turn', turn['resp'])
        checks.add('text-turn', 'one thought, one message and one usage update',
                   k['agent_thought_chunk'] == 1 and k['agent_message_chunk'] == 1 and k['usage_update'] == 1, dict(k))
        message = next((u for u in turn['updates'] if u.get('sessionUpdate') == 'agent_message_chunk'), {})
        checks.add('text-turn', 'the message comes whole, not token by token',
                   (message.get('content') or {}).get('text') == 'fake-text-reply', message)
        usage = next((u for u in turn['updates'] if u.get('sessionUpdate') == 'usage_update'), {})
        checks.add('text-turn', 'usage_update has used and size', isinstance(usage.get('used'), int)
                   and isinstance(usage.get('size'), int), usage)

        # --- MCP: server/discover first, then initialize, tools/list and tools/call, each with the Bearer token.
        turn = prompt(ask, sid, 'PROBE-MCP call the ping tool')
        posts = [r for r in mcp_log.since(0) if r['kind'] == 'post' and r['proc'] == 'ask']
        methods = [r['method'] for r in posts]
        checks.add('mcp', 'every MCP request carries the Bearer token', posts and all(r['auth'] for r in posts), methods)
        order = [m for m in ('server/discover', 'initialize', 'tools/list', 'tools/call') if m in methods]
        checks.add('mcp', 'server/discover, initialize, tools/list, tools/call in that order',
                   order == ['server/discover', 'initialize', 'tools/list', 'tools/call']
                   and [methods.index(m) for m in order] == sorted(methods.index(m) for m in order), methods)
        results = [r for m in turn['model'] for r in m['toolResults'] if (r['id'] or '').startswith('call-MCP-')]
        checks.add('mcp', 'mcp__yuzuno__ping reaches the model as pong', any('pong' in r['text'] for r in results), results)
        checks.add('mcp', 'the turn ends end_turn', turn['stop'] == 'end_turn', turn['resp'])

        # --- Sandbox (workspace-write): the extra writable root needs no question.
        turn = prompt(ask, sid, 'PROBE-EXTRA')
        checks.add('sandbox', 'additionalWritableRoots: written without a question',
                   os.path.exists(os.path.join(extra, 'b.txt')) and not turn['requests'], turn['requests'])
        # Outside the workspace: refused, then asked; reject keeps the file away.
        turn = prompt(ask, sid, 'PROBE-OUTSIDE', policy='reject')
        first = [r for m in turn['model'] for r in m['toolResults'] if r['id'] == 'call-OUTSIDE-1']
        # dsh-sandbox's README ("Denied calls and escalation") names the denial
        # marker; the errno depends on the Linux backend it took (bwrap first,
        # then Landlock): a local bwrap host gave Read-only file system, the
        # GitHub ubuntu-24.04 runner Permission denied.
        refused = [r for r in first if '[sandbox: file access denied under workspace-write mode]' in r['text']
                   and any(e in r['text'].lower() for e in ('read-only file system', 'permission denied'))]
        checks.add('sandbox', 'a write outside the workspace is refused by the sandbox '
                   '(Read-only file system under bwrap, Permission denied under Landlock)',
                   bool(refused), first)
        perms = [r for r in turn['requests'] if r]
        checks.add('sandbox', 'the retry with sandbox_permissions sends session/request_permission', len(perms) == 1, perms)
        if perms:
            call = (perms[0].get('toolCall') or {}).get('toolCallId')
            raw = (tool_call(turn, call) or {}).get('rawInput') or {}
            checks.add('sandbox', 'the request names the toolCallId of an earlier tool_call',
                       tool_call(turn, call) is not None, perms[0])
            checks.add('sandbox', 'that tool_call gave rawInput with the command, sandbox_permissions and justification',
                       all(k in raw for k in ('command', 'sandbox_permissions', 'justification')), raw)
            kinds_offered = sorted(o.get('kind') for o in perms[0].get('options') or [])
            checks.add('sandbox', 'the options are allow_once and reject_once only',
                       kinds_offered == ['allow_once', 'reject_once'], perms[0].get('options'))
        checks.add('sandbox', 'after reject the file is not written', not os.path.exists(os.path.join(outside, 'a.txt')))
        turn = prompt(ask, sid, 'PROBE-OUTSIDE again', policy='allow')
        checks.add('sandbox', 'after allow the file is written', os.path.exists(os.path.join(outside, 'a.txt')),
                   turn['requests'])

        # --- Image: the ACP image block reaches the model; dsh also POSTs /v1/files.
        m0 = model_log.mark()
        turn = prompt(ask, sid, 'PROBE-IMAGE', image=True)
        reqs = model_log.since(m0)
        checks.add('image', 'the image block reaches the model request',
                   any(r.get('hasImage') for r in reqs if r['kind'] == 'post' and r.get('lastText', '') and 'PROBE-IMAGE' in r['lastText']),
                   [{k: r.get(k) for k in ('path', 'hasImage', 'lastText')} for r in reqs])
        checks.add('image', 'dsh POSTs /v1/files first',
                   any(r['kind'] == 'post' and r['path'].rstrip('/').endswith('/files') for r in reqs),
                   [r['path'] for r in reqs])

        # --- Cancel: session/cancel ends the prompt `cancelled` and the running command.
        turn = prompt(ask, sid, 'PROBE-SLEEP', cancel_after_tool=True)
        checks.add('cancel', 'stopReason cancelled', turn['stop'] == 'cancelled', turn['resp'])
        checks.add('cancel', f'within {CANCEL_LIMIT} s of session/cancel',
                   turn['afterCancel'] is not None and turn['afterCancel'] <= CANCEL_LIMIT, turn['afterCancel'])
        deadline = time.monotonic() + EXIT_LIMIT
        while sleepers() and time.monotonic() < deadline:
            time.sleep(0.2)
        checks.add('cancel', 'the running `sleep 47` is gone', not sleepers(), sleepers())
        aborted = 'tool call aborted' in json.dumps(turn['updates']).lower()
        cancel_turn = turn

        # --- Effort, list, close.
        r = ask.request('session/set_config_option', {'sessionId': sid, 'configId': 'reasoning_effort', 'value': 'low'},
                        TURN_LIMIT)
        checks.add('resume', 'session/set_config_option reasoning_effort low is accepted', result_of(r) is not None, r)
        before = prompt(ask, sid, 'PROBE-TEXT effort')
        if not aborted:
            aborted = any('tool call aborted' in t['text'].lower() for m in before['model'] for t in m['toolResults'])
        checks.add('cancel', 'the aborted command\'s result is `tool call aborted`', aborted, cancel_turn['updates'][-6:])
        r = ask.request('session/close', {'sessionId': sid}, TURN_LIMIT)
        checks.add('resume', 'session/close is accepted', result_of(r) is not None, r)
        code, secs = ask.close('eof')
        checks.add('exit', f'closing stdin: exit 0 within {EXIT_LIMIT} s', code == 0, {'exit': code, 'seconds': round(secs, 2)})
        last_count = max((m['messageCount'] for m in before['model'] if m['kind'] == 'post'), default=0)

        # --- Resume in a new process: no replay, the whole history to the model, effort kept.
        res_acp = start('resume', ask_overlay, env)
        initialize(res_acp)
        u0, _ = res_acp.mark()
        r = res_acp.request('session/resume', {'sessionId': sid, 'cwd': ws, 'mcpServers': mcp_servers}, START_LIMIT)
        checks.add('resume', 'session/resume in a new process succeeds', result_of(r) is not None, r)
        replayed = [u.get('sessionUpdate') for u in res_acp.updates_since(u0)
                    if u.get('sessionUpdate') in ('user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk',
                                                  'tool_call', 'tool_call_update')]
        checks.add('resume', 'session/resume replays no history', not replayed, replayed)
        effort_now = (config_option((result_of(r) or {}).get('configOptions'), 'reasoning_effort') or {}).get('currentValue')
        checks.add('resume', 'the changed effort (low) is kept', effort_now == 'low', effort_now)
        turn = prompt(res_acp, sid, 'PROBE-RESUME')
        count = max((m['messageCount'] for m in turn['model'] if m['kind'] == 'post'), default=0)
        checks.add('resume', 'the model request carries the whole history', last_count and count > last_count,
                   {'before': last_count, 'after': count})
        code, secs = res_acp.close('sigterm')
        checks.add('exit', f'SIGTERM: exit 0 within {EXIT_LIMIT} s', code == 0, {'exit': code, 'seconds': round(secs, 2)})

        # --- danger-full-access + never: writes outside without a question.
        os.remove(os.path.join(outside, 'a.txt'))
        full_env = env_for('dsh-home-full', 'danger-full-access')
        check_dump('dump-config', 'dump-full', full_overlay, full_env, 'danger-full-access', 'never')
        full = start('full', full_overlay, full_env)
        initialize(full)
        new = full.request('session/new', {'cwd': ws, 'mcpServers': mcp_servers}, START_LIMIT)
        turn = prompt(full, (result_of(new) or {}).get('sessionId'), 'PROBE-OUTSIDE')
        checks.add('sandbox', 'danger-full-access writes outside without a question',
                   os.path.exists(os.path.join(outside, 'a.txt')) and not turn['requests'], turn['requests'])
        full.close('eof')

        # --- read-only: not even the workspace; the escalation asks as well.
        ro_env = env_for('dsh-home-ro', 'read-only')
        check_dump('dump-config', 'dump-ro', ro_overlay, ro_env, 'read-only', 'ask')
        ro = start('ro', ro_overlay, ro_env)
        initialize(ro)
        new = ro.request('session/new', {'cwd': ws, 'mcpServers': mcp_servers}, START_LIMIT)
        turn = prompt(ro, (result_of(new) or {}).get('sessionId'), 'PROBE-INSIDE', policy='reject')
        checks.add('sandbox', 'read-only: the escalation sends session/request_permission', len(turn['requests']) == 1,
                   turn['requests'])
        checks.add('sandbox', 'read-only: nothing is written in the workspace', not os.path.exists(os.path.join(ws, 'inside.txt')))
        ro.close('eof')

        # --- Control: without Core's two upload rows dsh does attach both, so
        # their absence above means the overlay switched them off.
        control_env = env_for('dsh-home-control', 'workspace-write')
        control_overlay = write_overlay('control', [r for r in OVERLAY_ROWS if r not in UPLOAD_ROWS], 'workspace-write', 'ask')
        control = start('control', control_overlay, control_env)
        initialize(control)
        new = control.request('session/new', {'cwd': ws, 'mcpServers': mcp_servers}, START_LIMIT)
        turn = prompt(control, (result_of(new) or {}).get('sessionId'), 'PROBE-TEXT control')
        sent = [m for m in turn['model'] if m['kind'] == 'post' and m['path'].rstrip('/').endswith('/messages')]
        checks.add('data', 'control: with dsh\'s defaults the requests carry dsh_session_log and dsh_plugin_packages',
                   sent and all(m['hasSessionLog'] and m['hasPluginPackages'] for m in sent),
                   [{k: m.get(k) for k in ('n', 'hasSessionLog', 'hasPluginPackages', 'bodyKeys')} for m in sent])
        control.close('eof')

        # --- Uploads switched off, as the user chose: no session log or plugin inventory in any request.
        core = [m for m in model_log.since(0) if m['kind'] == 'post' and m['proc'] in ('ask', 'resume', 'full', 'ro')
                and m['path'].rstrip('/').endswith('/messages')]
        checks.add('data', 'the model saw requests from every process', {m['proc'] for m in core} == {'ask', 'resume', 'full', 'ro'},
                   sorted({m['proc'] for m in core}))
        checks.add('data', 'with Core\'s overlay no request carries dsh_session_log',
                   core and not any(m['hasSessionLog'] for m in core), [m['n'] for m in core if m['hasSessionLog']])
        checks.add('data', 'with Core\'s overlay no request carries dsh_plugin_packages',
                   core and not any(m['hasPluginPackages'] for m in core), [m['n'] for m in core if m['hasPluginPackages']])
        user_ids = {}
        for m in core:
            user_ids.setdefault(m['proc'], set()).add(m['harnessHeaders'].get('x-deepseek-harness-user-id'))
        checks.add('data', 'every request carries x-deepseek-harness-user-id and -session-id',
                   all('x-deepseek-harness-user-id' in m['harnessHeaders'] and 'x-deepseek-harness-session-id' in m['harnessHeaders']
                       for m in core), sorted({h for m in core for h in m['harnessHeaders']}))
        flat = {p: sorted(v, key=str) for p, v in user_ids.items()}
        checks.add('data', 'the user id is one anonymous UUID per DSH_HOME',
                   all(len(v) == 1 and UUID.match(str(next(iter(v)))) for v in user_ids.values())
                   and user_ids.get('ask') == user_ids.get('resume') and user_ids.get('ask') != user_ids.get('full'), flat)
        main_reqs = [m for m in core if m['toolNames']]
        checks.add('data', '$DSH_HOME/AGENTS.md reaches every main request',
                   main_reqs and all(m['agentsMarker'] for m in main_reqs), [m['n'] for m in main_reqs if not m['agentsMarker']])
        for name in ('dsh-home-ask', 'dsh-home-full', 'dsh-home-ro'):
            top = os.path.join(root, name)
            sizes, modules = 0, []
            for base, dirs, files in os.walk(top):
                if 'node_modules' in dirs:
                    modules.append(os.path.relpath(base, top))
                    dirs.remove('node_modules')
                sizes += sum(os.path.getsize(os.path.join(base, f)) for f in files if os.path.isfile(os.path.join(base, f)))
            checks.add('start', f'{name}: dsh installs nothing there (no node_modules, under 5 MiB)',
                       not modules and sizes < 5 * 1048576, {'node_modules': modules, 'bytes': sizes})
    except Exception:
        checks.add('probe', 'the probe ran to the end', False, traceback.format_exc())
    finally:
        for p in procs:
            p.kill()
        model.shutdown()
        mcp.shutdown()
        frames.close()
        with open(os.path.join(OUT, 'report.json'), 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=1, default=str)

    failed = checks.failed()
    print(f"dsh {report['version']} (node {report['node']}): {len(checks.items) - len(failed)} of "
          f"{len(checks.items)} checks hold", flush=True)
    for c in failed:
        print(f"::error title=dsh contract [{c['row']}]::{c['check']}", flush=True)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(f"### dsh {report['version']} contract\n\n"
                    f"{len(checks.items) - len(failed)} of {len(checks.items)} checks hold (node {report['node']}).\n\n")
            if failed:
                f.write('| Row | Failed check |\n|---|---|\n')
                for c in failed:
                    f.write(f"| {c['row']} | {c['check']} |\n")
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
