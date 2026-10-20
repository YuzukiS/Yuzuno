"""Foreground, one-shot Core/UI cutover explicitly authorized by the user.

Only --run mutates the deployment. No task, user message, approval, or read
receipt is sent. Credentials/environment remain in memory; rollback never
replaces the user's database. Generated reports/backups are gitignored.
"""
from pathlib import Path
import collections
import datetime
import hashlib
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request

OUT = Path(__file__).resolve().parent
ROOT = OUT.parent.parent
PLAN = json.loads((OUT / 'plan.json').read_text())
OLD = PLAN['old']
DATA = Path(PLAN['dataDir']).resolve()
BINARY = Path(OLD['argv'][0])
if not BINARY.is_absolute():
    BINARY = Path(OLD['cwd']) / BINARY
CANDIDATE = Path(PLAN.get('candidatePath', PLAN.get('candidate', OUT / 'candidate-core'))).resolve()
STAGE = Path(PLAN['uiStage']).resolve()
WEB = ROOT / 'web/dist'
BASE = 'http://127.0.0.1:4317'
REPORT = OUT / 'switch.json'
BACKUP = OUT / 'workspace-cutover.sqlite'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
record = {'status': 'preflight', 'oldPid': OLD['pid'],
          'candidateSha256': PLAN['candidateSha256'], 'backup': str(BACKUP)}


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def save(status, **fields):
    record.update(status=status, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), **fields)
    temporary = REPORT.with_suffix('.tmp')
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(REPORT)


def identity(pid):
    try:
        proc = Path('/proc') / str(pid)
        raw = (proc / 'stat').read_text()
        fields = raw[raw.rfind(')') + 2:].split()
        if fields[0] == 'Z':
            return None
        return {'pid': pid, 'startTicks': fields[19],
                'argv': os.fsdecode((proc / 'cmdline').read_bytes()).rstrip('\0').split('\0'),
                'cwd': str((proc / 'cwd').resolve(strict=True))}
    except (FileNotFoundError, ProcessLookupError):
        return None


def same(process):
    expected = {key: process[key] for key in ('pid', 'startTicks', 'argv', 'cwd')}
    expected['startTicks'] = str(expected['startTicks'])
    expected['cwd'] = str(Path(expected['cwd']).resolve())
    return identity(process['pid']) == expected


def request(path, body=None, headers=None, timeout=8):
    req = urllib.request.Request(BASE + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop', **(headers or {})})
    with opener.open(req, timeout=timeout) as response:
        return json.load(response)


def api(path, body=None, timeout=8):
    return request('/api' + path, body, timeout=timeout)


def idle_details():
    workspace = api('/workspace')
    details = {agent['id']: api('/agents/' + agent['id']) for agent in workspace['agents']}
    for aid, detail in details.items():
        agent = detail['agent']
        if agent.get('closedAt'):
            continue
        assert agent['status'] == 'idle', 'Agent is not idle: ' + aid
        assert not agent.get('activeTurnId'), 'Agent has an active turn: ' + aid
        assert not agent.get('pendingCount') and not detail.get('pending'), 'Agent has a pending request: ' + aid
        assert not any(turn['status'] == 'inProgress' for turn in detail['turns']), 'Unfinished turn: ' + aid
    connected = {aid for aid, d in details.items()
                 if not d['agent'].get('closedAt') and d['agent'].get('connectionState') == 'connected'}
    expected = set(PLAN.get('reconnectAgentIds', connected))
    assert len(connected) == 2 and connected == expected, 'Previously connected/open Agent set changed'
    return details, connected


def preflight():
    assert same(OLD), 'Daily Core process identity changed'
    assert digest(Path('/proc') / str(OLD['pid']) / 'exe') == OLD['sha256'], 'Old executable changed'
    assert BINARY.is_file(), 'Original executable path is missing'
    argv = OLD['argv']
    assert '--data-dir' in argv and (Path(OLD['cwd']) / argv[argv.index('--data-dir') + 1]).resolve() == DATA
    assert '--port' in argv and argv[argv.index('--port') + 1] == '4317'
    assert '--web-dir' in argv and (Path(OLD['cwd']) / argv[argv.index('--web-dir') + 1]).resolve() == WEB
    assert CANDIDATE != BINARY.resolve() and digest(CANDIDATE) == PLAN['candidateSha256'], 'Candidate identity changed'
    manifest = json.loads((STAGE / '.refresh-ui.json').read_text())
    previous = PLAN.get('previousIndexSha256', manifest['previousIndex'])
    assert manifest['previousIndex'] == previous and digest(WEB / 'index.html') == previous, 'Daily UI changed since staging'
    assert PLAN['sourceHashes'], 'Source hashes must not be empty'
    for path, sha in PLAN['sourceHashes'].items():
        resolved = (ROOT / path).resolve()
        assert resolved.is_relative_to(ROOT), 'Source hash path outside repository'
        assert digest(resolved) == sha, 'Validated source changed: ' + path
    assert STAGE != WEB and 'index.html' in manifest['outputs']
    for path, sha in manifest['outputs'].items():
        resolved = (STAGE / path).resolve()
        assert resolved.is_relative_to(STAGE) and digest(resolved) == sha, 'Staged output changed: ' + path
    assert api('/health')['application'] == 'yuzuno-next'
    return idle_details()


def stop(process):
    assert same(process), 'Process identity changed before stop'
    for sig in (signal.SIGINT, signal.SIGTERM):
        assert same(process), 'Process identity changed before signal'
        os.kill(process['pid'], sig)
        for _ in range(60):
            if identity(process['pid']) is None:
                return
            time.sleep(0.1)
    raise RuntimeError('Core did not exit; no second instance will be started')


def atomic_copy(source, destination):
    destination = Path(destination)
    temporary = destination.with_name(destination.name + '.collaboration-stage')
    shutil.copy2(source, temporary)
    temporary.replace(destination)


def launch(env):
    with (ROOT / 'acceptance/live/core.log').open('ab') as log:
        child = subprocess.Popen(OLD['argv'], cwd=OLD['cwd'], env=env,
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    process = None
    try:
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError('New Core exited during startup; see daily core.log')
            process = identity(child.pid)
            assert process is None or (process['argv'] == OLD['argv'] and process['cwd'] == str(Path(OLD['cwd']).resolve()))
            try:
                if process and api('/health', timeout=1)['application'] == 'yuzuno-next':
                    return process
            except OSError:
                pass
            time.sleep(0.1)
        raise RuntimeError('New Core health check timed out')
    except Exception:
        if process and same(process):
            stop(process)
        elif child.poll() is None:
            # Popen still owns this unreaped child; it cannot be a reused PID.
            child.terminate()
            child.wait(timeout=8)
        raise


def register(process):
    (ROOT / 'acceptance/live/core.pid').write_text(str(process['pid']) + '\n')
    (ROOT / 'acceptance/live/core-process.json').write_text(json.dumps({**process,
        'baseUrl': BASE, 'dataDir': str(DATA), 'switchRecord': str(REPORT)}, indent=2) + '\n')


def database_backup():
    with sqlite3.connect('file:' + str(DATA / 'workspace.sqlite') + '?mode=ro', uri=True) as source:
        with sqlite3.connect(BACKUP) as backup:
            source.backup(backup)
            assert backup.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            before = {aid: json.loads(value) for aid, value in backup.execute('SELECT id,data FROM agents')}
            row = backup.execute("SELECT value FROM workspace_meta WHERE key='workspaceId'").fetchone()
            workspace_id = row[0] if row else None
    BACKUP.chmod(0o600)
    return before, workspace_id


IDENTITY_KEYS = ('id', 'name', 'cwd', 'model', 'harness', 'threadId', 'claudeSessionId', 'settings', 'closedAt', 'remote')


def assert_startup(before, workspace_id):
    assert {a['id'] for a in api('/workspace')['agents']} == set(before), 'Agent identity set changed'
    for aid, previous in before.items():
        detail = api('/agents/' + aid)
        for key in IDENTITY_KEYS:
            assert detail['agent'].get(key) == previous['agent'].get(key), 'Agent field changed: ' + aid + '/' + key
        assert detail['turns'] == previous['turns'], 'Transcript changed at startup: ' + aid
        assert detail.get('artifacts') == previous.get('artifacts'), 'Artifacts changed at startup: ' + aid
        assert detail.get('pending') == previous.get('pending'), 'Requests changed at startup: ' + aid
        assert detail['agent']['reviewedSeq'] == previous['agent']['reviewedSeq'], 'Read cursor changed: ' + aid
    with sqlite3.connect('file:' + str(DATA / 'workspace.sqlite') + '?mode=ro', uri=True) as db:
        assert db.execute("SELECT value FROM workspace_meta WHERE key='workspaceId'").fetchone()[0] == workspace_id


def messages(turn):
    return collections.Counter(json.dumps({key: item.get(key) for key in ('type', 'content', 'text', 'phase', 'questions')},
        ensure_ascii=False, sort_keys=True) for item in turn['items'] if item['type'] in ('userMessage', 'agentMessage'))


def mcp_health(aid):
    # Read the native credential only into memory. Calling task_list is read-only;
    # unlike peer_read under Agent identity it cannot manufacture a read receipt.
    with sqlite3.connect('file:' + str(DATA / 'workspace.sqlite') + '?mode=ro', uri=True) as db:
        row = db.execute('SELECT value FROM workspace_meta WHERE key=?', ('collaboration.mcp.agent.' + aid,)).fetchone()
    assert row, 'Reconnected Agent has no MCP credential'
    result = request('/mcp/' + aid, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
        'params': {'name': 'task_list', 'arguments': {'limit': 1}}},
        headers={'Authorization': 'Bearer ' + row[0], 'Accept': 'application/json, text/event-stream'})
    assert 'error' not in result and not result.get('result', {}).get('isError'), 'MCP task_list failed'
    content = result['result'].get('structuredContent')
    assert isinstance(content, dict) and isinstance(content.get('tasks'), list), 'MCP task_list response shape is invalid'


def cutover():
    assert not REPORT.exists() and not BACKUP.exists(), 'One-shot cutover already has a report or backup'
    _, connected = preflight()
    # Do not copy environment variables or MCP credentials to any file or log.
    raw = (Path('/proc') / str(OLD['pid']) / 'environ').read_bytes()
    env = {os.fsdecode(k): os.fsdecode(v) for part in raw.split(b'\0') if b'=' in part
           for k, v in [part.split(b'=', 1)]}
    shutil.copy2(Path('/proc') / str(OLD['pid']) / 'exe', OUT / 'previous-core')
    shutil.copy2(WEB / 'index.html', OUT / 'previous-index.html')
    had_preview = (WEB / 'design-preview.html').exists()
    if had_preview:
        shutil.copy2(WEB / 'design-preview.html', OUT / 'previous-preview.html')
    assert digest(OUT / 'previous-core') == OLD['sha256']
    database_backup()  # SQLite online backup includes committed WAL content.
    preflight()  # Re-check source, process and quiet state immediately before stop.
    save('stopping-old-core', reconnectAgentIds=sorted(connected))
    stop(OLD)
    current = None
    try:
        before, workspace_id = database_backup()  # Capture the final shutdown flush too.
        assert {aid for aid, detail in before.items() if aid in connected} == connected
        save('backed-up', agentsPreserved=len(before), workspaceId=workspace_id)
        atomic_copy(CANDIDATE, BINARY)
        current = launch(env)
        assert digest(Path('/proc') / str(current['pid']) / 'exe') == PLAN['candidateSha256']
        assert_startup(before, workspace_id)
        subprocess.run([PLAN['node'], str(ROOT / 'web/tools/refresh-ui.mjs'), '--publish', str(STAGE)],
            cwd=ROOT / 'web', check=True, timeout=40)
        with opener.open(BASE + '/', timeout=8) as response:
            assert response.read() == (STAGE / 'index.html').read_bytes(), 'Served UI differs from validated stage'
        register(current)
        save('core-and-ui-switched', newProcess=current, uiSha256=digest(WEB / 'index.html'),
             transcripts='Exact startup match', permissionSettings='Preserved', readState='Preserved')
    except Exception:
        if current and same(current):
            stop(current)
        assert identity(OLD['pid']) is None
        atomic_copy(OUT / 'previous-core', BINARY)
        atomic_copy(OUT / 'previous-index.html', WEB / 'index.html')
        if had_preview:
            atomic_copy(OUT / 'previous-preview.html', WEB / 'design-preview.html')
        else:
            (WEB / 'design-preview.html').unlink(missing_ok=True)
        restored = launch(env)
        register(restored)
        save('rolled-back', restoredProcess=restored, databaseRestored=False)
        raise

    recoveries = []
    for aid in sorted(connected):
        previous = before[aid]
        try:
            api('/agents/' + aid + '/reconnect', {}, timeout=40)
            detail = api('/agents/' + aid)
            for key in IDENTITY_KEYS:
                assert detail['agent'].get(key) == previous['agent'].get(key), 'Agent field changed after reconnect: ' + key
            actual = {turn['id']: turn for turn in detail['turns']}
            assert set(actual) == {turn['id'] for turn in previous['turns']}, 'Reconnect started or removed a Turn'
            for turn in previous['turns']:
                assert not (messages(turn) - messages(actual[turn['id']])), 'Native message evidence missing'
            assert detail['agent']['reviewedSeq'] == previous['agent']['reviewedSeq'], 'Read cursor changed after reconnect'
            assert detail['agent']['connectionState'] == 'connected', 'Agent did not reconnect'
            assert detail['agent']['status'] == 'idle' and not detail.get('pending'), 'Agent became busy on reconnect'
            mcp_health(aid)
            recoveries.append({'agentId': aid, 'name': previous['agent']['name'], 'sameSession': True,
                               'messagesPreserved': True, 'noNewTurn': True, 'mcpTaskList': 'passed'})
        except Exception as error:
            recoveries.append({'agentId': aid, 'name': previous['agent']['name'], 'error': str(error)})
    complete = all('error' not in item for item in recoveries)
    save('complete' if complete else 'switched-with-reconnect-warning', reconnected=recoveries,
         newTasksSent=False, readReceiptsSent=False, nativeWindowTouched=False)
    if not complete:
        raise RuntimeError('Core/UI switched; reconnect checks need review (see switch.json)')


if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1:] == ['--preflight']:
        details, connected = preflight()
        print(json.dumps({'status': 'preflight-passed', 'agents': len(details), 'reconnectAgents': len(connected)}))
    elif sys.argv[1:] == ['--run']:
        if REPORT.exists() or BACKUP.exists():
            raise SystemExit('Existing cutover evidence is preserved; inspect switch.json instead of rerunning this one-shot script')
        try:
            cutover()
        except Exception as error:
            if record['status'] not in ('rolled-back', 'switched-with-reconnect-warning'):
                save('failed', error=str(error))
            else:
                save(record['status'], error=str(error))
            print(json.dumps({'status': record['status'], 'error': str(error), 'report': str(REPORT)}, ensure_ascii=False))
            raise SystemExit(1)
        print(json.dumps({'status': record['status'], 'newPid': record['newProcess']['pid'],
                          'agentsPreserved': record['agentsPreserved'], 'reconnected': len(record['reconnected']),
                          'report': str(REPORT)}, ensure_ascii=False))
    else:
        raise SystemExit('Use --preflight for checks only; --run for the approved foreground cutover')
