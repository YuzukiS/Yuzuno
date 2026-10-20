"""One-shot, user-authorized cutover after the hosting conversation turn ends."""
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

ROOT = (Path.home() / 'yuzuno-next')
OUT = ROOT / 'acceptance/turn-flow-switch'
PLAN = json.loads((OUT / 'plan.json').read_text())
OLD = PLAN['old']
DATA = Path(PLAN['dataDir'])
BINARY = Path(OLD['argv'][0])
WEB = ROOT / 'web/dist'
REPORT = OUT / 'switch.json'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
record = {'status': 'preflight', 'includesClaudeAutoMode': True,
          'oldPid': OLD['pid'], 'candidateSha256': PLAN['candidateSha256'],
          'watchedTurnId': PLAN['turnId'], 'backup': str(OUT / 'workspace-cutover.sqlite')}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(status, **fields):
    record.update(status=status, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), **fields)
    temporary = REPORT.with_suffix('.tmp')
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(REPORT)


def identity(pid):
    try:
        proc = Path('/proc') / str(pid)
        raw = (proc / 'stat').read_text()
        fields = raw[raw.rfind(')') + 2:].split()
        if fields[0] == 'Z': return None
        return {'pid': pid, 'startTicks': fields[19],
                'argv': (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')}
    except FileNotFoundError:
        return None


def same(process):
    return identity(process['pid']) == {key: process[key] for key in ('pid', 'startTicks', 'argv')}


def api(path, post=False):
    request = urllib.request.Request('http://127.0.0.1:4317/api' + path,
        data=b'{}' if post else None,
        headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    with opener.open(request, timeout=45 if post else 5) as response:
        return json.load(response)


def preflight():
    assert same(OLD), 'Daily Core identity changed; refusing to touch another process'
    assert '--data-dir' in OLD['argv'] and OLD['argv'][OLD['argv'].index('--data-dir') + 1] == str(DATA)
    assert digest(OUT / 'candidate-core') == PLAN['candidateSha256']
    assert digest(WEB / 'index.html') == PLAN['previousIndexSha256'], 'Daily UI changed since staging'
    for path, sha in PLAN['sourceHashes'].items():
        assert digest(ROOT / path) == sha, 'Source changed since combined validation: ' + path
    staged = Path(PLAN['uiStage'])
    manifest = json.loads((staged / '.refresh-ui.json').read_text())
    for path, sha in manifest['outputs'].items():
        assert digest(staged / path) == sha, 'Staged UI changed: ' + path
    assert api('/health')['application'] == 'yuzuno-next'


def quiet():
    workspace = api('/workspace')
    if any(not a.get('closedAt') and (a['status'] in ('working', 'waiting', 'uncertain') or a.get('pendingCount'))
           for a in workspace['agents']):
        return False
    detail = api('/agents/' + PLAN['agentId'])
    return (detail['agent'].get('threadId') == PLAN['threadId']
            and any(t['id'] == PLAN['turnId'] and t['status'] == 'completed' for t in detail['turns']))


def stop(process):
    assert same(process), 'Process identity changed before stop'
    os.kill(process['pid'], signal.SIGINT)
    for _ in range(60):
        if identity(process['pid']) is None: return
        time.sleep(0.1)
    assert same(process), 'Process identity changed during stop'
    os.kill(process['pid'], signal.SIGTERM)
    for _ in range(60):
        if identity(process['pid']) is None: return
        time.sleep(0.1)
    raise RuntimeError('Core did not exit; no second instance will be started')


def atomic_copy(source, destination):
    destination = Path(destination)
    temporary = destination.with_name(destination.name + '.turn-flow-stage')
    shutil.copy2(source, temporary)
    temporary.replace(destination)


def launch(env):
    with (ROOT / 'acceptance/live/core.log').open('ab') as log:
        child = subprocess.Popen(OLD['argv'], cwd=OLD['cwd'], env=env,
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    for _ in range(150):
        if child.poll() is not None: raise RuntimeError('New Core exited during startup')
        try:
            process = identity(child.pid)
            if process and process['argv'] == OLD['argv'] and api('/health')['application'] == 'yuzuno-next':
                return process
        except OSError:
            pass
        time.sleep(0.1)
    # Only terminate this known child, never an unrelated listener.
    child.terminate()
    child.wait(timeout=8)
    raise RuntimeError('New Core health check timed out')


def register(process):
    (ROOT / 'acceptance/live/core.pid').write_text(str(process['pid']) + '\n')
    (ROOT / 'acceptance/live/core-process.json').write_text(json.dumps({**process,
        'baseUrl': 'http://127.0.0.1:4317', 'dataDir': str(DATA), 'switchRecord': str(REPORT)}, indent=2) + '\n')


def messages(turn):
    return collections.Counter(json.dumps({k: item.get(k) for k in ('type','content','text','phase','questions')},
        ensure_ascii=False, sort_keys=True) for item in turn['items'] if item['type'] in ('userMessage','agentMessage'))


def smoke():
    """Boot the exact candidate with disposable data before arming cutover."""
    argv = [str(OUT / 'candidate-core'), '--port', '4387', '--data-dir', str(OUT / 'smoke-data'),
            '--web-dir', PLAN['uiStage'], '--cwd', str(ROOT)]
    with (OUT / 'smoke.log').open('ab') as log:
        child = subprocess.Popen(argv, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    try:
        for _ in range(100):
            if child.poll() is not None: raise RuntimeError('Isolated candidate exited; see smoke.log')
            try:
                with opener.open('http://127.0.0.1:4387/api/health', timeout=1) as response:
                    assert json.load(response)['application'] == 'yuzuno-next'
                break
            except OSError:
                time.sleep(0.1)
        else: raise RuntimeError('Isolated candidate did not become healthy')
        with opener.open('http://127.0.0.1:4387/api/workspace', timeout=3) as response:
            assert json.load(response)['agents'] == []
        with opener.open('http://127.0.0.1:4387/', timeout=3) as response:
            assert response.read() == (Path(PLAN['uiStage']) / 'index.html').read_bytes()
        (OUT / 'smoke.json').write_text(json.dumps({'status': 'passed', 'port': 4387,
            'binarySha256': digest(OUT / 'candidate-core'), 'emptyIsolatedWorkspace': True,
            'dailyCoreUntouched': same(OLD)}, indent=2) + '\n')
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=8)


def cutover():
    preflight()
    save('waiting-for-turn', workerPid=os.getpid())
    # The process is detached; the current reply must be fully saved before its
    # owning Core can be stopped. New work delays this cutover instead of losing it.
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        assert same(OLD), 'Daily Core changed while waiting'
        if quiet():
            time.sleep(2)
            if quiet(): break
        time.sleep(1)
    else:
        raise RuntimeError('Workspace did not become idle within 30 minutes; nothing was stopped')
    preflight()
    # Original environment stays in memory and is never written to the report.
    raw = (Path('/proc') / str(OLD['pid']) / 'environ').read_bytes()
    env = {k.decode(): v.decode() for part in raw.split(b'\0') if b'=' in part
           for k, v in [part.split(b'=', 1)]}
    shutil.copy2(Path('/proc') / str(OLD['pid']) / 'exe', OUT / 'previous-core')
    shutil.copy2(WEB / 'index.html', OUT / 'previous-index.html')
    if (WEB / 'design-preview.html').exists():
        shutil.copy2(WEB / 'design-preview.html', OUT / 'previous-preview.html')
    assert digest(OUT / 'previous-core') == OLD['sha256']
    assert quiet(), 'New work arrived; retry the switch after it finishes'
    save('stopping-old-core')
    stop(OLD)
    current = None
    try:
        with sqlite3.connect('file:' + str(DATA / 'workspace.sqlite') + '?mode=ro', uri=True) as source:
            with sqlite3.connect(OUT / 'workspace-cutover.sqlite') as backup:
                source.backup(backup)
                assert backup.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
                before = {aid: json.loads(value) for aid, value in backup.execute('SELECT id,data FROM agents')}
                workspace_id = backup.execute("SELECT value FROM workspace_meta WHERE key='workspaceId'").fetchone()[0]
        save('backed-up', agentsPreserved=len(before), workspaceId=workspace_id)
        atomic_copy(OUT / 'candidate-core', BINARY)
        current = launch(env)
        assert digest(Path('/proc') / str(current['pid']) / 'exe') == PLAN['candidateSha256']
        assert {a['id'] for a in api('/workspace')['agents']} == set(before)
        for aid, previous in before.items():
            detail = api('/agents/' + aid)
            for key in ('id','name','cwd','threadId','claudeSessionId','settings','closedAt'):
                assert detail['agent'].get(key) == previous['agent'].get(key), (aid, key)
            assert detail['turns'] == previous['turns'], 'Transcript changed at startup: ' + aid
            assert detail['agent']['reviewedSeq'] >= previous['agent']['reviewedSeq'], 'Read cursor regressed'
        subprocess.run([PLAN['node'], str(ROOT / 'web/tools/refresh-ui.mjs'), '--publish', PLAN['uiStage']],
            cwd=ROOT / 'web', check=True)
        with opener.open('http://127.0.0.1:4317/', timeout=5) as response:
            assert response.read() == (Path(PLAN['uiStage']) / 'index.html').read_bytes()
        with sqlite3.connect('file:' + str(DATA / 'workspace.sqlite') + '?mode=ro', uri=True) as db:
            assert db.execute("SELECT value FROM workspace_meta WHERE key='workspaceId'").fetchone()[0] == workspace_id
        register(current)
        save('core-and-ui-switched', newProcess=current, uiSha256=digest(WEB / 'index.html'),
             transcripts='Exact startup match', permissionSettings='Preserved')
    except Exception:
        if current and same(current): stop(current)
        assert identity(OLD['pid']) is None
        atomic_copy(OUT / 'previous-core', BINARY)
        atomic_copy(OUT / 'previous-index.html', WEB / 'index.html')
        if (OUT / 'previous-preview.html').exists():
            atomic_copy(OUT / 'previous-preview.html', WEB / 'design-preview.html')
        restored = launch(env)
        register(restored)
        save('rolled-back', restoredProcess=restored)
        raise
    # Reattach only previously connected, open sessions; never send a task,
    # resolve a request, enable Auto mode, or mark conversation content read.
    recoveries = []
    for aid, previous in before.items():
        agent = previous['agent']
        if agent.get('closedAt') or agent.get('connectionState') != 'connected': continue
        try:
            api('/agents/' + aid + '/reconnect', post=True)
            detail = api('/agents/' + aid)
            for key in ('threadId','claudeSessionId'):
                assert detail['agent'].get(key) == agent.get(key), 'Native identity changed'
            actual = {t['id']: t for t in detail['turns']}
            for turn in previous['turns']:
                assert turn['id'] in actual and not (messages(turn) - messages(actual[turn['id']])), 'Message evidence missing'
            recoveries.append({'agentId': aid, 'name': agent['name'], 'status': detail['agent']['status'],
                               'sameSession': True, 'messagesPreserved': True})
        except Exception as error:
            recoveries.append({'agentId': aid, 'name': agent['name'], 'error': str(error)})
    save('complete' if all('error' not in r for r in recoveries) else 'switched-with-reconnect-warning',
         reconnected=recoveries, newTasksSent=False, nativeWindowTouched=False)


if __name__ == '__main__':
    if sys.argv[1:] == ['--arm']:
        preflight()
        assert not REPORT.exists(), 'One-shot worker already has a report'
        smoke()
        preflight()
        with (OUT / 'switch.log').open('ab') as log:
            worker = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--run'], cwd=ROOT,
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(30):
            if worker.poll() is not None: raise RuntimeError('Cutover worker exited; inspect switch.log')
            if REPORT.exists() and json.loads(REPORT.read_text())['status'] == 'waiting-for-turn': break
            time.sleep(0.1)
        else: raise RuntimeError('Worker did not reach waiting state')
        print(json.dumps({'status': 'armed', 'workerPid': worker.pid, 'report': str(REPORT)}))
    elif sys.argv[1:] == ['--run']:
        try:
            cutover()
        except Exception as error:
            save('rolled-back' if record['status'] == 'rolled-back' else 'failed', error=str(error))
            raise
    else:
        raise SystemExit('Use --arm to run once after the current hosting turn completes')
