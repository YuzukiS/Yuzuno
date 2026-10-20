#!/usr/bin/env python3
"""One-shot real native acceptance. Only a fresh isolated Core/data directory.

Reads credentials only from its own DB into memory. Reports booleans, never
argv, credential values, raw native responses or user account files.
Run via target/heavy-slot.sh; --remote adds one new Mac mini Agent/runtime.
"""
import argparse
import json
import os
from pathlib import Path
import shlex
import signal
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
TARGET = os.environ.get('YUZUNO_SSH_TARGET', 'tester@192.0.2.10')
CODEX = os.environ.get('YUZUNO_REMOTE_CODEX', '/opt/homebrew/bin/codex')
args = argparse.ArgumentParser()
args.add_argument('--port', type=int, default=4487)
args.add_argument('--remote', action='store_true')
args = args.parse_args()
assert args.port != 4317
lab = ROOT / 'target' / ('credentials-' + uuid.uuid4().hex[:12])
lab.mkdir(parents=True, mode=0o700)
cwd = lab / 'task'
cwd.mkdir()
(cwd / 'AGENTS.md').write_text('Isolated acceptance. Only call the requested Yuzuno peers_list tool. Do not use shell, file, task or peer-message tools.\n')
base = f'http://127.0.0.1:{args.port}'
report = {'lab': str(lab), 'port': args.port, 'agents': [], 'checks': []}
core = None
log = None
secrets = set()

def save():
    (lab / 'result.json').write_text(json.dumps(report, indent=2) + '\n')

def note(check):
    report['checks'].append(check)
    save()
    print(check, flush=True)

def api(path, body=None, expect_not_submitted=False):
    request = urllib.request.Request(base + '/api' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            assert not expect_not_submitted, 'Expected input admission to refuse before submission'
            return json.load(response)
    except urllib.error.HTTPError as e:
        if expect_not_submitted and e.code == 400:
            assert json.load(e).get('code') == 'message_not_submitted'
            return None
        # Do not put a native error (which might echo a secret) in reports.
        raise RuntimeError(f'API {path}: HTTP {e.code}') from None

def wait(predicate, label, timeout=150):
    deadline = time.monotonic() + timeout
    last = time.monotonic()
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        if time.monotonic() - last > 20:
            print('Waiting: ' + label, flush=True)
            last = time.monotonic()
        time.sleep(1)
    raise RuntimeError('Timed out: ' + label)

def start():
    global core, log
    log = (lab / 'core.log').open('ab')
    core = subprocess.Popen([str(ROOT / 'target/debug/yuzuno-workspace'), '--port', str(args.port),
        '--data-dir', str(lab / 'data'), '--cwd', str(cwd), '--web-dir', str(ROOT / 'web/dist')],
        cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
    def healthy():
        if core.poll() is not None:
            raise RuntimeError('Isolated Core exited')
        try:
            return api('/health')['application'] == 'yuzuno-next'
        except OSError:
            return False
    wait(healthy, 'Core health', 20)

def stop():
    global core, log
    if core and core.poll() is None:
        core.send_signal(signal.SIGINT)
        core.wait(timeout=20)
    if log:
        log.close()
    core = None

def detail(a):
    return api('/agents/' + a['id'])

def ready(a):
    d = detail(a)
    if d['pending']:
        raise RuntimeError('Native approval pending; no automatic approval')
    if d['agent']['status'] in ['error', 'uncertain'] and d['agent'].get('error'):
        raise RuntimeError('Native startup or turn error for ' + a['harness'])
    return d if d['agent']['connectionState'] == 'connected' and d['agent']['status'] == 'idle' else None

def tokens():
    with sqlite3.connect(f'file:{lab}/data/workspace.sqlite?mode=ro', uri=True) as db:
        values = dict(db.execute("SELECT substr(key,25),value FROM workspace_meta WHERE key GLOB 'collaboration.mcp.agent.*'"))
    secrets.update(values.values())
    return values

def mcp_status(agent_id, token):
    data = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
        'params': {'name': 'peers_list', 'arguments': {}}}).encode()
    request = urllib.request.Request(base + '/mcp/' + agent_id, data=data,
        headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
                 'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.load(response)
            assert result['result'].get('isError') is not True
            assert result['result']['structuredContent']['yuzuno']['agentId'] == agent_id
            return response.status
    except urllib.error.HTTPError as e:
        return e.code

def diagnostics_clean():
    # Read only our own descendants' argv, never print or save argv itself.
    processes = {}
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():
            continue
        try:
            stat = (p / 'stat').read_text().rsplit(') ', 1)[1].split()
            processes[int(p.name)] = (int(stat[1]), p)
        except (OSError, ValueError):
            pass
    descendants = {core.pid}
    for _ in range(20):
        added = {pid for pid, (parent, _) in processes.items() if parent in descendants}
        if added <= descendants:
            break
        descendants |= added
    checked = 0
    for pid in descendants:
        try:
            argv = (processes[pid][1] / 'cmdline').read_bytes()
        except (KeyError, OSError):
            continue
        assert all(secret.encode() not in argv for secret in secrets), 'Credential in owned process argv'
        checked += 1
    assert checked >= 3
    logs = (lab / 'core.log').read_bytes()
    assert all(secret.encode() not in logs for secret in secrets), 'Credential in Core diagnostics'

def check_turn(a):
    before = detail(a)
    api('/agents/' + a['id'] + '/turns', {'text':
        'Call the built-in Yuzuno peers_list exactly once. This read is authorized. '
        'Then reply T17_OK if it succeeded, or T17_FAILED if it failed. Do not use other tools or send messages.'})
    d = wait(lambda: ready(a), 'real ' + a['harness'] + ' peers_list', 180)
    assert len(d['turns']) == len(before['turns']) + 1
    items = d['turns'][-1]['items']
    replies = ' '.join(i.get('text', '') for i in items if i.get('type') == 'agentMessage')
    calls = [i for i in items if (i.get('name') == 'mcp__yuzuno__peers_list'
        or i.get('tool') == 'peers_list' or i.get('toolName') == 'peers_list')]
    assert len(calls) == 1 and calls[0]['status'] == 'completed', 'Expected one successful native peers_list'
    assert 'T17_OK' in replies and 'T17_FAILED' not in replies, 'Native final answer must confirm success'
    return d

def identity(d):
    a = d['agent']
    return (a['id'], a.get('threadId'), a.get('claudeSessionId'))

try:
    start()
    report['versions'] = {bin: subprocess.check_output([bin, '--version'], text=True, stderr=subprocess.DEVNULL).strip()
        for bin in ['claude', 'codex']}
    machine = None
    if args.remote:
        remote_cwd = os.environ.get('YUZUNO_REMOTE_CWD', '/tmp').rstrip('/') + '/yuzuno-t17-' + uuid.uuid4().hex[:12]
        if not Path(remote_cwd).is_absolute() or '..' in Path(remote_cwd).parts:
            raise RuntimeError('YUZUNO_REMOTE_CWD must be an absolute remote lab parent')
        subprocess.run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', TARGET,
            'mkdir -m 700 -p ' + shlex.quote(remote_cwd)], check=True, capture_output=True, timeout=20)
        machine = api('/machines', {'name': 'T17 isolated Mac mini', 'target': TARGET, 'codex': CODEX, 'defaultCwd': remote_cwd})
        report['remoteCwd'] = remote_cwd
    for harness, model, remote in [('claude', 'haiku', False), ('codex', 'gpt-6.1-sol', False)] + ([('codex', 'gpt-6.1-sol', True)] if machine else []):
        a = api('/agents', {'name': 'T17 ' + harness + (' remote' if remote else ' local'), 'harness': harness,
            'model': model, 'cwd': remote_cwd if remote else str(cwd), **({'machineId': machine['id']} if remote else {})})
        report['agents'].append(a)
        save()
        wait(lambda: ready(a), 'native startup')
        d = check_turn(a)
        a['beforeIdentity'], a['beforeTurns'] = identity(d), len(d['turns'])
        if remote:
            a['beforeRuntime'] = d['agent']['remote']['runtime']['instanceId']
        note('real peers_list succeeded: ' + a['name'])
    for a in report['agents']:
        if not a.get('beforeRuntime'):
            continue
        api('/agents/' + a['id'] + '/turns', {'text':
            'For this isolated restart acceptance only: run /bin/sleep 120 once with the shell tool. '
            'Keep waiting for it to finish using the native wait tool if needed. Do not modify files, '
            'send peer messages or create tasks. When done reply SLEEP_DONE. The test may interrupt you.'})
        def sleeping():
            d = detail(a)
            if d['pending']:
                raise RuntimeError('Sleep acceptance requires manual approval; not auto-approved')
            found = any(i.get('type') == 'commandExecution' and 'sleep 120' in str(i.get('command'))
                and i.get('status') == 'inProgress' for t in d['turns'] for i in t.get('items', []))
            return d if found else None
        d = wait(sleeping, 'owned remote sleep running', 60)
        a['beforeTurns'], a['activeTurn'] = len(d['turns']), d['turns'][-1]['id']
        note('remote native turn active before Core restart')
    old = tokens()
    assert len(old) == len(report['agents'])
    diagnostics_clean()
    note('owned argv and Core diagnostics contain no credential')
    stop()
    start()
    for a in report['agents']:
        # The explicit same-session action does not send a model prompt.
        api('/agents/' + a['id'] + '/reconnect', {})
        d = wait(lambda: (v if (v := detail(a))['agent']['connectionState'] == 'connected' else None), 'same native session reconnect')
        assert list(identity(d)) == list(a['beforeIdentity'])
        assert len(d['turns']) == a['beforeTurns']
        if a.get('beforeRuntime'):
            assert d['agent']['remote']['runtime']['instanceId'] == a['beforeRuntime']
            assert d['collaboration']['ready'] is False
            assert d['agent']['status'] == 'working'
            report['remoteProbeReason'] = d['collaboration']['reason']
            # Admission refuses before recording a receipt or a model turn.
            client_id = str(uuid.uuid4())
            api('/agents/' + a['id'] + '/messages', {'text': 'This input must not reach the model',
                'clientMessageId': client_id, 'expectedTurnId': a['activeTurn']}, expect_not_submitted=True)
            after = detail(a)
            assert len(after['turns']) == a['beforeTurns']
            assert not any(r['input']['clientMessageId'] == client_id for r in after.get('messageReceipts', []))
            api('/agents/' + a['id'] + '/interrupt', {})
            wait(lambda: ready(a), 'remote interrupt remains available', 45)
            api('/agents/' + a['id'] + '/close', {})
            api('/agents/' + a['id'] + '/reopen', {})
            d = wait(lambda: ready(a), 'explicit remote reopen')
            assert list(identity(d)) == list(a['beforeIdentity'])
            assert d['agent']['remote']['runtime']['instanceId'] != a['beforeRuntime']
            assert d['collaboration']['ready'] is True
            note('surviving remote blocked only new input; explicit close/reopen restored same session')
        else:
            assert d['collaboration']['ready'] is True
    new = tokens()
    assert set(old) == set(new)
    for agent_id in old:
        assert old[agent_id] != new[agent_id]
        assert mcp_status(agent_id, old[agent_id]) == 401
        assert mcp_status(agent_id, new[agent_id]) == 200
    note('same Agents after restart: old credentials rejected, new credentials accepted; no replay')
    for a in report['agents']:
        check_turn(a)
        note('real peers_list succeeded after restart: ' + a['name'])
    diagnostics_clean()
    note('post-restart owned argv and diagnostics contain no old or new credential')
    report['passed'] = True
finally:
    # Close only these isolated Agents. Never stop the daily Core or other runtimes.
    if core and core.poll() is None:
        for a in report['agents']:
            try:
                d = detail(a)
                if d['agent']['status'] == 'working':
                    api('/agents/' + a['id'] + '/interrupt', {})
                    wait(lambda: ready(a), 'finish isolated cleanup', 30)
                api('/agents/' + a['id'] + '/close', {})
            except Exception:
                report.setdefault('cleanupNeedsInspection', []).append(a['id'])
        stop()
    save()
    print('Sanitized report: ' + str(lab / 'result.json'), flush=True)
