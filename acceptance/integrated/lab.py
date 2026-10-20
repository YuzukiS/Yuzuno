#!/usr/bin/env python3
"""Unified acceptance, owned port 4367. Source work remains outside this script.

Reuse the reading lab's PID/start-time/argv guards and daily checks. Historical
SQLite copies are evidence only; this script never reconnects a native session.
"""
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import sys

LAB = Path(__file__).resolve().parent
ROOT = LAB.parents[1]
spec = importlib.util.spec_from_file_location('reading_lab', ROOT / 'acceptance/reading/lab.py')
reading = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reading)
reading.LAB = LAB
reading.PORT = 4367
reading.RECORD = LAB / 'core-process.json'
reading.BINARY = Path('/tmp/yuzuno-next-integrated-target/debug/yuzuno-workspace')
reading.DATA = LAB / 'core-data'

def readonly_backup(source_path, destination):
    source = sqlite3.connect(f'file:{source_path}?mode=ro', uri=True)
    try: source.backup(destination)
    finally: source.close()

def prepare():
    if reading.owned(): raise RuntimeError('Owned integrated Core is running; preserving its data')
    if (reading.DATA / 'workspace.sqlite').exists(): raise RuntimeError('Prepare is one-shot; preserving integrated data')
    LAB.mkdir(parents=True, exist_ok=True)
    reading.DATA.mkdir(exist_ok=True)
    (LAB / 'task').mkdir(exist_ok=True)
    (LAB / 'task/TASK-SCOPE.txt').write_text('Integrated acceptance only. Work only in this folder. Do not change source, services, configuration, or credentials.\n')
    reading.save(LAB / 'daily-baseline.json', reading.daily_state())
    db = sqlite3.connect(reading.DATA / 'workspace.sqlite')
    reading_db = ROOT / 'acceptance/reading/core-data/workspace.sqlite'
    readonly_backup(reading_db, db)
    manifest = json.loads((ROOT / 'acceptance/reading/fixture-manifest.json').read_text())
    manifest['copiedReadingEvidence'] = {'source': str(reading_db), 'method': 'read-only SQLite backup', 'newNativeExecution': False}
    interaction_db = ROOT / 'acceptance/interaction-settings/core-data/workspace.sqlite'
    interaction = sqlite3.connect(':memory:')
    readonly_backup(interaction_db, interaction)
    imported = []
    # Append journals with new database-wide sequence numbers and translate the
    # source cursor. Copying raw seq values would collide with reading history.
    for agent_id, raw in interaction.execute('SELECT id,data FROM agents').fetchall():
        if db.execute('SELECT 1 FROM agents WHERE id=?', (agent_id,)).fetchone():
            raise RuntimeError('Historical Agent ID collision; no replacement is permitted')
        detail = json.loads(raw)
        agent = detail['agent']
        old_reviewed = agent.get('reviewedSeq', 0)
        old_last = agent.get('lastSeq', 0)
        remap = {}
        for old_seq, kind, data, at in interaction.execute('SELECT seq,kind,data,at FROM journal WHERE agent_id=? ORDER BY seq', (agent_id,)):
            cursor = db.execute('INSERT INTO journal(agent_id,kind,data,at) VALUES(?,?,?,?)', (agent_id, kind, data, at))
            remap[old_seq] = cursor.lastrowid
        reviewed = max((new for old, new in remap.items() if old <= old_reviewed), default=0)
        last = max((new for old, new in remap.items() if old <= old_last), default=0)
        agent['reviewedSeq'], agent['lastSeq'] = reviewed, last
        agent['unreadCount'] = db.execute("SELECT COUNT(*) FROM journal WHERE agent_id=? AND seq>? AND kind IN ('turn/completed','request','runtime/error')", (agent_id, reviewed)).fetchone()[0]
        db.execute('INSERT INTO agents(id,data) VALUES(?,?)', (agent_id, json.dumps(detail)))
        imported.append({'agentId': agent_id, 'name': agent['name'], 'turns': len(detail['turns']), 'threadId': agent.get('threadId'), 'oldReviewedSeq': old_reviewed, 'newReviewedSeq': reviewed, 'journalRows': len(remap), 'acceptedMessageReceipts': sum(r.get('status') == 'accepted' for r in detail.get('messageReceipts', []))})
    db.commit()
    interaction.close()
    db.close()
    manifest['importedCodexHistory'] = {'source': str(interaction_db), 'method': 'read-only SQLite backup into memory, append per-Agent journal with sequence/cursor translation', 'agents': imported, 'nativeSessionResumed': False}
    reading.save(LAB / 'fixture-manifest.json', manifest)
    shutil.copy2(ROOT / 'acceptance/reading/live-state.json', LAB / 'historical-claude-state.json')
    reading.reset_read()
    print('Copied reading history and imported Codex history; no harness/session was resumed')

if __name__ == '__main__':
    commands = {'prepare': prepare, 'start': reading.start, 'stop': reading.stop, 'reset-read': reading.reset_read, 'add-source-fixtures': reading.add_source_fixtures, 'status': lambda: print(json.dumps(reading.owned())), 'verify-daily': reading.verify_daily}
    commands[sys.argv[1]]()
