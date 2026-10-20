"""The release smoke's conversation baseline (T-145): the operation's own
backup, read in the core.11/core.12 layout. Fixture databases only; no Core."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release_smoke', Path(__file__).with_name('core-release-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

WORKSPACE = 'ws-1'
AGENT = 'agent-1'
PROJECT = 'project-1'
SETTINGS = {'model': 'fake', 'effort': 'low'}


def item(turn, n, kind, **fields):
    return {'id': f'{turn}:{n}', 'type': kind, **fields}


# The seeded Turn, then the Brief reminder Turn Core starts by itself.
SEEDED_TURN = ('turn-1', [item('turn-1', 0, 'userMessage', content=[{'type': 'text', 'text': 'run:2:0:0:100'}]),
                          item('turn-1', 1, 'reasoning', text='thinking'),
                          item('turn-1', 2, 'agentMessage', text='done')])
REMINDER_TURN = ('turn-2', [item('turn-2', 0, 'userMessage', content=[{'type': 'text', 'text': 'Brief reminder'}]),
                            item('turn-2', 1, 'agentMessage', text='noted')])


def api_snapshot(turns, reviewed=7, settings=SETTINGS, project=PROJECT):
    """What the smoke's snapshot() makes of GET /api/agents/<id>, after a JSON round trip."""
    return json.loads(json.dumps({
        'id': AGENT, 'threadId': 'thread-1', 'projectId': project, 'settings': settings, 'reviewedSeq': reviewed,
        'turnIds': [turn for turn, _ in turns],
        'messages': [(i.get('id'), i.get('text'), i.get('content')) for _, items in turns for i in items
                     if i['type'] in ('userMessage', 'agentMessage')]}))


def write_backup(path, turns, *, layout=1, workspace=WORKSPACE, reviewed=7, payloads=0, drop_column=None, wal=False):
    db = sqlite3.connect(path)
    if wal:
        db.execute('PRAGMA journal_mode=WAL')
    columns = {'agent_items': 'agent_id, turn_id, item_id, ord, payloads, data, previews'}
    if drop_column:
        table, column = drop_column
        columns[table] = ', '.join(c for c in columns[table].split(', ') if c != column)
    db.executescript(f"""
        CREATE TABLE workspace_meta(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT, layout INTEGER);
        CREATE TABLE agent_turns(agent_id TEXT, turn_id TEXT, ord INTEGER, items INTEGER, data TEXT);
        CREATE TABLE agent_items({columns['agent_items']});
        CREATE TABLE project_agents(agent_id TEXT, project_id TEXT, assigned_at TEXT);""")
    db.execute('INSERT INTO workspace_meta VALUES (?, ?)', ('workspaceId', workspace))
    agent = {'id': AGENT, 'threadId': 'thread-1', 'settings': SETTINGS, 'reviewedSeq': reviewed, 'status': 'idle'}
    db.execute('INSERT INTO agents VALUES (?, ?, ?)', (AGENT, json.dumps({'agent': agent, 'pending': []}), layout))
    db.execute('INSERT INTO project_agents VALUES (?, ?, ?)', (AGENT, PROJECT, 'now'))
    # Rows are inserted out of order: the reader must order by ord.
    for order, (turn, items) in reversed(list(enumerate(turns))):
        db.execute('INSERT INTO agent_turns VALUES (?, ?, ?, ?, ?)', (AGENT, turn, order, len(items), json.dumps({'id': turn})))
        for n, entry in reversed(list(enumerate(items))):
            values = {'agent_id': AGENT, 'turn_id': turn, 'item_id': entry['id'], 'ord': n,
                      'payloads': payloads if entry['type'] == 'userMessage' else 0, 'data': json.dumps(entry), 'previews': None}
            names = columns['agent_items'].split(', ')
            db.execute(f"INSERT INTO agent_items VALUES ({', '.join('?' * len(names))})", [values[c] for c in names])
    db.commit()
    db.close()


class BackupBaseline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.backup = self.dir / 'op-1.sqlite3'
        self.seeded = api_snapshot([SEEDED_TURN])

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, **kwargs):
        write_backup(self.backup, [SEEDED_TURN, REMINDER_TURN], **kwargs)
        smoke.plain_backup(self.backup)
        return smoke.backup_conversation(self.backup, AGENT, WORKSPACE)

    def test_the_backup_reads_as_the_api_snapshot_including_a_turn_core_added(self):
        before = self.read()
        self.assertEqual(before, api_snapshot([SEEDED_TURN, REMINDER_TURN]))
        # The seeded snapshot alone would have failed this upgrade (the bug).
        self.assertNotEqual(api_snapshot([SEEDED_TURN, REMINDER_TURN]), self.seeded)

    def test_an_upgrade_that_kept_everything_passes(self):
        before = self.read()
        self.assertIsNone(smoke.conversation_problem(self.seeded, before, api_snapshot([SEEDED_TURN, REMINDER_TURN])))

    def test_a_lost_added_or_changed_message_or_cursor_fails(self):
        before = self.read()
        changed = copy.deepcopy(REMINDER_TURN)
        changed[1][1]['text'] = 'other'
        edited_seeded = copy.deepcopy(SEEDED_TURN)
        edited_seeded[1][0]['content'] = [{'type': 'text', 'text': 'edited'}]
        extra = ('turn-3', [item('turn-3', 0, 'agentMessage', text='new')])
        cases = {
            'the reminder turn was lost': api_snapshot([SEEDED_TURN]),
            'a message was added': api_snapshot([SEEDED_TURN, REMINDER_TURN, extra]),
            'a message after the seeded ones changed': api_snapshot([SEEDED_TURN, changed]),
            'a seeded message changed': api_snapshot([edited_seeded, REMINDER_TURN]),
            'the read cursor moved': api_snapshot([SEEDED_TURN, REMINDER_TURN], reviewed=8),
            'the settings changed': api_snapshot([SEEDED_TURN, REMINDER_TURN], settings={'model': 'other'}),
        }
        for label, after in cases.items():
            with self.subTest(label):
                self.assertEqual(smoke.conversation_problem(self.seeded, before, after),
                                 'Conversation identity/history/settings/read cursor changed')

    def test_a_backup_that_is_not_of_the_seeded_conversation_is_refused(self):
        before = self.read()
        edited_seeded = copy.deepcopy(SEEDED_TURN)
        edited_seeded[1][2]['text'] = 'edited'
        cases = {
            'the seeded turn is missing': api_snapshot([REMINDER_TURN]),
            'a seeded message differs': api_snapshot([edited_seeded, REMINDER_TURN]),
            'the read cursor differs from the seeded one': api_snapshot([SEEDED_TURN], reviewed=6),
            'another project': api_snapshot([SEEDED_TURN], project='project-2'),
            'nothing was seeded': api_snapshot([]),
        }
        for label, seeded in cases.items():
            with self.subTest(label):
                # Even an after that equals the backup cannot pass then.
                self.assertEqual(smoke.conversation_problem(seeded, before, before),
                                 'The operation backup does not hold the seeded conversation')

    def test_unsupported_layouts_and_another_workspace_are_refused(self):
        cases = {
            'agent record layout 2': (dict(layout=2), 'agent record layout 2'),
            'a message kept in agent_payloads': (dict(payloads=1), 'keeps fields in agent_payloads'),
            'agent_items without payloads': (dict(drop_column=('agent_items', 'payloads')), 'agent_items lacks'),
            'another Workspace': (dict(workspace='ws-2'), 'another Workspace'),
        }
        for label, (kwargs, message) in cases.items():
            with self.subTest(label):
                self.backup.unlink(missing_ok=True)
                with self.assertRaisesRegex(ValueError, message):
                    self.read(**kwargs)
        self.backup.unlink()
        write_backup(self.backup, [SEEDED_TURN])
        with self.assertRaisesRegex(ValueError, 'no record of the fixture Agent'):
            smoke.backup_conversation(self.backup, 'agent-2', WORKSPACE)

    def test_only_a_backup_whose_main_file_is_complete_is_read(self):
        write_backup(self.backup, [SEEDED_TURN])
        self.assertEqual(smoke.plain_backup(self.backup), {})
        with self.subTest('as the helper leaves it: WAL mode, an empty -wal and a -shm beside it'):
            # The online backup keeps the live database's WAL mode; a later
            # read-only open leaves these two behind (seen on operation 04b5c677).
            wal = self.dir / 'wal.sqlite3'
            write_backup(wal, [SEEDED_TURN, REMINDER_TURN], wal=True)
            with wal.open('rb') as file:
                self.assertEqual(file.read(20)[18:20], b'\x02\x02', 'the fixture is in WAL mode')
            Path(f'{wal}-wal').write_bytes(b'')
            Path(f'{wal}-shm').write_bytes(b'\0' * 32768)
            self.assertEqual(smoke.plain_backup(wal), {'-wal': 0, '-shm': 32768})
            self.assertEqual(smoke.backup_conversation(wal, AGENT, WORKSPACE), api_snapshot([SEEDED_TURN, REMINDER_TURN]))
        with self.subTest('a -wal with frames in it'):
            Path(f'{self.backup}-wal').write_bytes(b'frame')
            with self.assertRaisesRegex(ValueError, 'non-empty -wal'):
                smoke.plain_backup(self.backup)
            Path(f'{self.backup}-wal').unlink()
        for content in (b'', b'journal'):
            with self.subTest(f'a -journal of {len(content)} bytes'):
                Path(f'{self.backup}-journal').write_bytes(content)
                with self.assertRaisesRegex(ValueError, '-journal beside it'):
                    smoke.plain_backup(self.backup)
                Path(f'{self.backup}-journal').unlink()
        with self.subTest('a link'):
            link = self.dir / 'link.sqlite3'
            os.symlink(self.backup, link)
            with self.assertRaisesRegex(ValueError, 'not a regular file'):
                smoke.plain_backup(link)
        with self.subTest('not SQLite'):
            other = self.dir / 'other.sqlite3'
            other.write_bytes(b'not a database' * 10)
            with self.assertRaisesRegex(ValueError, 'not an SQLite database'):
                smoke.plain_backup(other)
        with self.subTest('missing'):
            with self.assertRaisesRegex(ValueError, 'missing'):
                smoke.plain_backup(self.dir / 'absent.sqlite3')


if __name__ == '__main__':
    unittest.main()
