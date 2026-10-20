#!/usr/bin/env python3
"""Own only reading acceptance on 4357; never writes a daily Core or source file.

`prepare` takes a consistent, read-only SQLite backup of accepted Claude history.
Additional rows are explicitly synthetic browser fixtures, not harness evidence.
No command in this script starts or resumes a harness/model task.
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request

LAB = Path(__file__).resolve().parent
ROOT = LAB.parents[1]
PORT = 4357
RECORD = LAB / 'core-process.json'
BINARY = Path('/tmp/yuzuno-next-reading-target/debug/yuzuno-workspace')
DATA = LAB / 'core-data'
SOURCE_DB = ROOT / 'acceptance/claude/core-data/workspace.sqlite'

def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def process(pid):
    proc = Path('/proc') / str(pid)
    try:
        stat = (proc / 'stat').read_text()
        fields = stat[stat.rfind(')') + 2:].split()
        if fields[0] == 'Z': return None
        return {'pid': pid, 'startTicks': fields[19],
                'argv': (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')}
    except FileNotFoundError:
        return None

def owned():
    if not RECORD.exists(): return None
    record = json.loads(RECORD.read_text())
    current = process(record['pid'])
    if current is None: return None
    if current != {k: record[k] for k in ['pid', 'startTicks', 'argv']}:
        raise RuntimeError('Lab process identity changed; refusing to signal it')
    expected = ['--port', str(PORT), '--data-dir', str(DATA),
                '--web-dir', str(LAB / 'source/web/dist'), '--cwd', str(LAB / 'task')]
    if current['argv'][1:] != expected:
        raise RuntimeError('Not the isolated reading Core')
    return record

def daily_state():
    spec = importlib.util.spec_from_file_location('slice_lab', ROOT / 'scripts/slice-lab.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.daily_state()

def prepare():
    if owned(): raise RuntimeError('Stop the owned reading Core before seeding')
    if (DATA / 'workspace.sqlite').exists():
        raise RuntimeError('Preserving existing reading data; prepare is intentionally one-shot')
    baseline = LAB / 'daily-baseline.json'
    if not baseline.exists(): save(baseline, daily_state())
    DATA.mkdir(parents=True, exist_ok=True)
    (LAB / 'task').mkdir(exist_ok=True)
    (LAB / 'task/TASK-SCOPE.txt').write_text('Reading acceptance only. Work only in this folder. Do not change the repository, other Core services, authentication, or system configuration.\n')
    source = sqlite3.connect(f'file:{SOURCE_DB}?mode=ro', uri=True)
    dest = sqlite3.connect(DATA / 'workspace.sqlite')
    source.backup(dest)
    source.close()
    history = []
    for agent_id, raw in dest.execute('SELECT id,data FROM agents').fetchall():
        d = json.loads(raw)
        history.append({'agentId': agent_id, 'name': d['agent']['name'], 'turns': len(d['turns']), 'nativeSessionId': d['agent'].get('claudeSessionId')})
    # Each fixture is isolated so one observed review cannot change another case.
    names = ['foreground', 'old-scroll', 'modal', 'background', 'source-jump', 'pending', 'working']
    fixture_data = {}
    for scenario in names:
        agent_id = f'reading-{scenario}'
        at = '2026-10-12T22:00:00Z'
        turns = []
        for n in range(1, 15):
            turns.append({'id': f'{agent_id}-turn-{n}', 'status': 'completed', 'items': [
                {'id': f'{agent_id}-user-{n}', 'type': 'userMessage', 'content': [{'type': 'text', 'text': f'Reading fixture task {n}: inspect the document and report the result.'}]},
                {'id': f'{agent_id}-reply-{n}', 'type': 'agentMessage', 'phase': 'final_answer', 'text': f'Fixture delivery {n}. This is explicitly synthetic reading evidence.\n\n' + ('The review includes the visible conversation and keeps approvals independent. ' * 7)}]})
        if scenario == 'working':
            turns.append({'id': f'{agent_id}-current', 'status': 'inProgress', 'items': [
                {'id': f'{agent_id}-new-task', 'type': 'userMessage', 'content': [{'type': 'text', 'text': 'Implement the new keyboard navigation for the conversation.'}]},
                {'id': f'{agent_id}-new-progress', 'type': 'agentMessage', 'phase': 'commentary', 'text': 'I am checking keyboard navigation and focus behavior.'}]})
        pending = []
        if scenario == 'pending':
            pending = [{'id': f'{agent_id}-request', 'agentId': agent_id, 'method': 'claude/canUseTool', 'params': {'toolName': 'Write', 'input': {'file_path': str(LAB / 'task/fixture-never-write.txt'), 'content': 'Never execute this synthetic request'}, 'turnId': turns[-1]['id']}, 'createdAt': at, 'stale': True}]
        completed = [t for t in turns if t['status'] == 'completed']
        for turn in completed:
            dest.execute('INSERT INTO journal(agent_id,kind,data,at) VALUES(?,?,?,?)', (agent_id, 'turn/completed', json.dumps({'turn': turn, 'acceptanceFixture': True}), at))
        if pending:
            dest.execute('INSERT INTO journal(agent_id,kind,data,at) VALUES(?,?,?,?)', (agent_id, 'request', json.dumps(pending[0]), at))
        last_seq = dest.execute('SELECT MAX(seq) FROM journal WHERE agent_id=?', (agent_id,)).fetchone()[0]
        agent = {'id': agent_id, 'name': f'Reading · {scenario}', 'goal': 'OBSOLETE_GOAL_MUST_NOT_DISPLAY', 'cwd': str(LAB / 'task'), 'model': 'haiku', 'color': 'sage', 'harness': 'claude', 'claudeSessionId': None, 'threadId': None, 'status': 'working' if scenario == 'working' else 'idle', 'connectionState': 'disconnected', 'createdAt': at, 'updatedAt': at, 'unreadCount': len(completed) + len(pending), 'pendingCount': len(pending), 'lastMessage': completed[-1]['items'][-1]['text'], 'lastSeq': last_seq, 'reviewedSeq': 0, 'error': None}
        detail = {'agent': agent, 'turns': turns, 'pending': pending, 'artifacts': []}
        dest.execute('INSERT INTO agents(id,data) VALUES(?,?)', (agent_id, json.dumps(detail)))
        fixture_data[scenario] = {'id': agent_id, 'name': agent['name'], 'latestReplyId': completed[-1]['items'][-1]['id'], 'latestTurnId': turns[-1]['id'], 'unreadCount': agent['unreadCount']}
    dest.commit()
    dest.close()
    save(LAB / 'fixture-manifest.json', {'historicalReplay': {'sourceDatabase': str(SOURCE_DB), 'method': 'SQLite read-only connection backup; no source writes', 'agents': history}, 'syntheticFixtures': fixture_data, 'limitations': 'Historical replay and synthetic view cases are not proof of new Claude execution. No native session is resumed by prepare.'})
    print('Historical backup and explicitly synthetic reading fixtures ready')

def start():
    if owned(): raise RuntimeError('Reading Core already running')
    listeners = subprocess.check_output(['ss', '-ltnp', f'sport = :{PORT}'], text=True)
    if len(listeners.strip().splitlines()) > 1:
        raise RuntimeError('Port 4357 already in use; no process changed')
    if not (LAB / 'source/web/dist/index.html').exists(): raise RuntimeError('Build isolated UI first')
    if not BINARY.exists(): raise RuntimeError('Build isolated Core first')
    argv = [str(BINARY), '--port', str(PORT), '--data-dir', str(DATA), '--web-dir', str(LAB / 'source/web/dist'), '--cwd', str(LAB / 'task')]
    env = dict(os.environ, YUZUNO_CLAUDE_BRIDGE=str(ROOT / 'runtimes/claude/bridge.mjs'))
    with (LAB / 'core.log').open('ab') as log:
        child = subprocess.Popen(argv, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    # /proc/cmdline can briefly be empty across exec. Do not persist that
    # transient value as the owned process identity.
    identity = None
    for _ in range(100):
        identity = process(child.pid)
        if identity and identity['argv'] == argv: break
        if child.poll() is not None: raise RuntimeError('Reading Core exited immediately')
        time.sleep(.01)
    if not identity or identity['argv'] != argv:
        raise RuntimeError('Could not confirm launched Core argv; inspect child PID ' + str(child.pid))
    save(RECORD, {**identity, 'baseUrl': f'http://127.0.0.1:{PORT}', 'dataDir': str(DATA)})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(100):
        try:
            with opener.open(f'http://127.0.0.1:{PORT}/api/health', timeout=1) as response:
                print(response.read().decode(), f'PID {child.pid}')
                return
        except OSError:
            if child.poll() is not None: raise RuntimeError('Core exited; inspect reading/core.log')
            time.sleep(.1)
    raise RuntimeError('Core not ready; inspect the owned process')

def stop():
    record = owned()
    if not record: print('No owned reading Core running'); return
    os.kill(record['pid'], signal.SIGINT)
    for _ in range(100):
        if process(record['pid']) is None: print('Stopped owned reading Core'); return
        time.sleep(.1)
    raise RuntimeError('Core did not stop; no other process signalled')

def reset_read():
    if owned(): raise RuntimeError('Stop the owned reading Core before resetting test read cursors')
    db = sqlite3.connect(DATA / 'workspace.sqlite')
    for agent_id, raw in db.execute("SELECT id,data FROM agents WHERE id LIKE 'reading-%'").fetchall():
        detail = json.loads(raw)
        detail['agent']['reviewedSeq'] = 0
        detail['agent']['unreadCount'] = db.execute("SELECT COUNT(*) FROM journal WHERE agent_id=? AND kind IN ('turn/completed','request','runtime/error')", (agent_id,)).fetchone()[0]
        db.execute('UPDATE agents SET data=? WHERE id=?', (json.dumps(detail), agent_id))
    db.commit()
    db.close()
    print('Reset only synthetic reading fixture cursors; historical transcript preserved')

def add_source_fixtures():
    if not owned(): raise RuntimeError('Start the owned reading Core before adding live-shaped synthetic snapshots')
    # Deliberately insert only disposable synthetic rows after startup: a real
    # in-progress snapshot loaded during Store.open is correctly made uncertain.
    # SQLite transactions preserve the real Core's other Agents/read cursors.
    db = sqlite3.connect(DATA / 'workspace.sqlite')
    manifest_path = LAB / 'fixture-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    for scenario in ('plan', 'history-drag'):
        original = 'reading-working' if scenario == 'plan' else 'reading-source-jump'
        raw = db.execute('SELECT data FROM agents WHERE id=?', (original,)).fetchone()[0]
        agent_id = f'reading-{scenario}'
        detail = json.loads(raw.replace(original, agent_id))
        agent = detail['agent']
        agent.update({'id': agent_id, 'name': f'Reading · {scenario}', 'reviewedSeq': 0, 'error': None, 'status': 'working' if scenario == 'plan' else 'idle', 'connectionState': 'disconnected'})
        if scenario == 'plan':
            agent['harness'] = 'codex'
            detail['turns'][-1]['_yuzunoPlan'] = [{'step': 'Verify native plan source', 'status': 'inProgress'}]
        db.execute('DELETE FROM journal WHERE agent_id=?', (agent_id,))
        completed = [t for t in detail['turns'] if t['status'] == 'completed']
        for turn in completed:
            db.execute('INSERT INTO journal(agent_id,kind,data,at) VALUES(?,?,?,?)', (agent_id, 'turn/completed', json.dumps({'turn': turn, 'acceptanceFixture': True}), agent['updatedAt']))
        if scenario == 'plan':
            db.execute('INSERT INTO journal(agent_id,kind,data,at) VALUES(?,?,?,?)', (agent_id, 'turn/plan/updated', json.dumps({'turnId': detail['turns'][-1]['id'], 'plan': detail['turns'][-1]['_yuzunoPlan'], 'acceptanceFixture': True}), agent['updatedAt']))
        agent['lastSeq'] = db.execute('SELECT MAX(seq) FROM journal WHERE agent_id=?', (agent_id,)).fetchone()[0]
        agent['unreadCount'] = len(completed)
        db.execute('INSERT OR REPLACE INTO agents(id,data) VALUES(?,?)', (agent_id, json.dumps(detail)))
        manifest['syntheticFixtures'][scenario] = {'id': agent_id, 'name': agent['name'], 'latestReplyId': completed[-1]['items'][-1]['id'], 'latestTurnId': detail['turns'][-1]['id'], 'unreadCount': len(completed), 'seededAfterCoreStartup': True, 'nativeExecution': False}
    db.commit()
    db.close()
    save(manifest_path, manifest)
    print('Added clearly synthetic plan/source-drag snapshots to the isolated DB only')

def verify_daily():
    old, new = json.loads((LAB / 'daily-baseline.json').read_text()), daily_state()
    identity = lambda records: [{k: v for k, v in x.items() if k != 'state'} for x in records if x]
    result = {'sameDailyProcess': identity(old['processes']) == identity(new['processes']), 'dailyWebDistUnchanged': old['webDist'] == new['webDist'], 'currentHealth': new['health'], 'note': 'Read-only comparison; concurrent changes are reported, never reverted.'}
    save(LAB / 'daily-verification.json', result)
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    {'prepare': prepare, 'start': start, 'stop': stop, 'reset-read': reset_read, 'add-source-fixtures': add_source_fixtures, 'status': lambda: print(json.dumps(owned())), 'verify-daily': verify_daily}[sys.argv[1]]()
