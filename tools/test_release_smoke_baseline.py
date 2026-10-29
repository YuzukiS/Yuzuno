"""The release smoke's conversation baseline (T-145): the operation's own
backup, read in the record layout of core.11 to core.19 and in the session
store of core.20 on (T-5), and the API's conversation window it is compared
with. Fixture databases and answers only; no Core."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
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


# No sessionStore row at all: the record layout before core.20.
NO_MARK = object()


def write_backup(path, turns, *, layout=1, workspace=WORKSPACE, reviewed=7, payloads=0, drop_column=None, wal=False,
                 store=NO_MARK, meta=None, spilled=False, chunk=False, count=None, rows=None):
    """A backup in the layout before core.20 (each Agent's `layout` column;
    `layout=None` leaves the column out), or with `store` the session store
    of core.20 on: `agents(id, data)`, the mark written as given ('2', or ''
    or None for an empty or NULL one) and agent_stream_chunks. Session-store
    variants: `meta` replaces the Agent's metadata row, `spilled` notes the
    first message's start as spilled, `chunk` keeps a chunk of the first
    agent message, `count` is the first Turn's Item count as recorded and
    `rows` drops all but that many of its Item rows."""
    db = sqlite3.connect(path)
    if wal:
        db.execute('PRAGMA journal_mode=WAL')
    columns = {'agent_items': 'agent_id, turn_id, item_id, ord, payloads, data, previews',
               'agent_stream_chunks': 'agent_id, turn_id, item_id, field, seq, data'}
    if drop_column:
        table, column = drop_column
        columns[table] = ', '.join(c for c in columns[table].split(', ') if c != column)
    session_store = store is not NO_MARK
    agents = 'id TEXT PRIMARY KEY, data TEXT' + ('' if session_store or layout is None else ', layout INTEGER')
    db.executescript(f"""
        CREATE TABLE workspace_meta(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE agents({agents});
        CREATE TABLE agent_turns(agent_id TEXT, turn_id TEXT, ord INTEGER, items INTEGER, data TEXT);
        CREATE TABLE agent_items({columns['agent_items']});
        CREATE TABLE project_agents(agent_id TEXT, project_id TEXT, assigned_at TEXT);""")
    db.execute('INSERT INTO workspace_meta VALUES (?, ?)', ('workspaceId', workspace))
    agent = {'id': AGENT, 'threadId': 'thread-1', 'settings': SETTINGS, 'reviewedSeq': reviewed, 'status': 'idle'}
    if session_store:
        db.execute(f"CREATE TABLE agent_stream_chunks({columns['agent_stream_chunks']})")
        db.execute('INSERT INTO workspace_meta VALUES (?, ?)', ('sessionStore', store))
        row = json.dumps({'agent': agent, 'pending': [], 'artifacts': []} if meta is None else meta)
        db.execute('INSERT INTO agents VALUES (?, ?)', (AGENT, row))
    elif layout is None:
        db.execute('INSERT INTO agents VALUES (?, ?)', (AGENT, json.dumps({'agent': agent, 'pending': []})))
    else:
        db.execute('INSERT INTO agents VALUES (?, ?, ?)', (AGENT, json.dumps({'agent': agent, 'pending': []}), layout))
    db.execute('INSERT INTO project_agents VALUES (?, ?, ?)', (AGENT, PROJECT, 'now'))
    # Rows are inserted out of order: the reader must order by ord.
    for order, (turn, items) in reversed(list(enumerate(turns))):
        recorded = (count if count is not None else len(items)) if order == 0 else len(items)
        if count == 'null' and order == 0:
            recorded = None
        db.execute('INSERT INTO agent_turns VALUES (?, ?, ?, ?, ?)', (AGENT, turn, order, recorded, json.dumps({'id': turn})))
        kept = items if rows is None or order != 0 else items[:rows]
        for n, entry in reversed(list(enumerate(kept))):
            if spilled and order == 0 and entry['type'] == 'userMessage':
                entry = {**entry, '_yuzunoSpilled': {'content': {'bytes': 1048576}}}
            if chunk and order == 0 and entry['type'] == 'agentMessage':
                db.execute('INSERT INTO agent_stream_chunks VALUES (?, ?, ?, ?, ?, ?)', (AGENT, turn, entry['id'], 'text', 0, '"the start"'))
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



class SessionStoreBackup(unittest.TestCase):
    """core.20 on: the same conversation, read from the session store's rows."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.backup = Path(self.tmp.name) / 'op-1.sqlite3'
        self.seeded = api_snapshot([SEEDED_TURN])

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, **kwargs):
        self.backup.unlink(missing_ok=True)
        write_backup(self.backup, [SEEDED_TURN, REMINDER_TURN], **{'store': '2', **kwargs})
        smoke.plain_backup(self.backup)
        return smoke.backup_conversation(self.backup, AGENT, WORKSPACE)

    def test_the_session_store_backup_reads_as_the_api_snapshot_in_order(self):
        before = self.read()
        self.assertEqual(before, api_snapshot([SEEDED_TURN, REMINDER_TURN]))
        self.assertEqual(before['turnIds'], ['turn-1', 'turn-2'])
        self.assertEqual([m[0] for m in before['messages']], ['turn-1:0', 'turn-1:2', 'turn-2:0', 'turn-2:1'])
        self.assertIsNone(smoke.conversation_problem(self.seeded, before, api_snapshot([SEEDED_TURN, REMINDER_TURN])))
        # The same conversation reads the same from either layout.
        layout_one = Path(self.tmp.name) / 'layout-1.sqlite3'
        write_backup(layout_one, [SEEDED_TURN, REMINDER_TURN])
        self.assertEqual(smoke.backup_conversation(layout_one, AGENT, WORKSPACE), before)

    def test_a_session_store_backup_still_fails_a_lost_or_changed_conversation(self):
        before = self.read()
        changed = copy.deepcopy(REMINDER_TURN)
        changed[1][1]['text'] = 'other'
        for label, after in {'the reminder turn was lost': api_snapshot([SEEDED_TURN]),
                             'a message changed': api_snapshot([SEEDED_TURN, changed]),
                             'the read cursor moved': api_snapshot([SEEDED_TURN, REMINDER_TURN], reviewed=8)}.items():
            with self.subTest(label):
                self.assertEqual(smoke.conversation_problem(self.seeded, before, after),
                                 'Conversation identity/history/settings/read cursor changed')

    def test_an_unknown_mark_a_bad_record_or_a_message_kept_elsewhere_is_refused(self):
        agent = {'id': AGENT, 'threadId': 'thread-1', 'settings': SETTINGS, 'reviewedSeq': 7}
        cases = {
            'session store 3': (dict(store='3'), "session store '3'"),
            'an empty mark': (dict(store=''), "session store ''"),
            'a NULL mark': (dict(store=None), 'session store None'),
            'metadata that is not an object': (dict(meta=[agent]), 'not an object with its agent'),
            'metadata without its agent': (dict(meta={'pending': []}), 'not an object with its agent'),
            'metadata carrying Turns': (dict(meta={'agent': agent, 'turns': []}), 'carries Turns or receipts'),
            'metadata carrying receipts': (dict(meta={'agent': agent, 'messageReceipts': []}), 'carries Turns or receipts'),
            'another Agent in the row': (dict(meta={'agent': {**agent, 'id': 'agent-9'}}), 'another Agent'),
            'another Workspace': (dict(workspace='ws-2'), 'another Workspace'),
            'a message kept in agent_payloads': (dict(payloads=1), 'keeps fields in agent_payloads'),
            'a message whose start was spilled': (dict(spilled=True), 'keeps part of itself outside its row'),
            'a message with stream chunks': (dict(chunk=True), 'keeps its start in agent_stream_chunks'),
            'an Item row missing': (dict(rows=2), "2 of Turn turn-1's 3 Item rows"),
            'a Turn recording more Items than it has': (dict(count=4), "3 of Turn turn-1's 4 Item rows"),
            'a Turn kept whole in its row': (dict(count='null'), "3 of Turn turn-1's None Item rows"),
            'agent_stream_chunks without item_id': (dict(drop_column=('agent_stream_chunks', 'item_id')), 'agent_stream_chunks lacks'),
        }
        for label, (kwargs, message) in cases.items():
            with self.subTest(label):
                with self.assertRaisesRegex(ValueError, re.escape(message)):
                    self.read(**kwargs)

    def test_an_unmarked_backup_without_the_layout_column_is_refused(self):
        write_backup(self.backup, [SEEDED_TURN], layout=None)
        with self.assertRaisesRegex(ValueError, 'no session store mark and no agent record layout'):
            smoke.backup_conversation(self.backup, AGENT, WORKSPACE)


def window_answer(turns, *, has_before=False, has_after=False, total=None, part=None, preview=False, window_preview=False):
    """GET /api/agents/<id>?view=window for `turns`, as Core answers it.
    `window_preview` sends the first message as conversation_window::bounded_item
    sends one over its size limit: a `historyPreview` in its place."""
    shells = []
    for t, (turn, items) in enumerate(turns):
        shells.append({'id': turn, 'items': copy.deepcopy(items), '_yuzunoSlice': {'start': 0, 'total': len(items), 'index': t}})
    if part:
        shells[0]['_yuzunoSlice'].update(part)
    if preview:
        shells[0]['items'][0]['_yuzunoTruncated'] = {'content': {'bytes': 1048576}}
    if window_preview:
        first = shells[0]['items'][0]
        shells[0]['items'][0] = {'id': first['id'], 'type': 'historyPreview', 'status': first.get('status'),
                                 '_yuzunoWindowPreview': {'type': first['type'], 'bytes': 40000}, 'text': 'run:2:0:0:100'}
    return json.loads(json.dumps({
        'agent': {'id': AGENT, 'threadId': 'thread-1', 'projectId': PROJECT, 'settings': SETTINGS, 'reviewedSeq': 7},
        'turns': shells,
        'conversation': {'hasBefore': has_before, 'hasAfter': has_after,
                         'totalItems': sum(len(items) for _, items in turns) if total is None else total}}))


class WholeConversation(unittest.TestCase):
    """The API side of the comparison is the whole conversation, or refused."""
    def test_a_window_holding_everything_reads_as_the_snapshot(self):
        self.assertEqual(json.loads(json.dumps(smoke.whole_conversation(window_answer([SEEDED_TURN, REMINDER_TURN])))),
                         api_snapshot([SEEDED_TURN, REMINDER_TURN]))

    def test_a_partial_window_or_a_preview_is_refused(self):
        answer = window_answer([SEEDED_TURN, REMINDER_TURN])
        no_window = {k: v for k, v in answer.items() if k != 'conversation'}
        unknown = copy.deepcopy(answer)
        del unknown['conversation']['hasBefore']
        cases = {
            'no window (an answer without view=window)': (no_window, 'without its conversation window'),
            'earlier Items exist': (window_answer([SEEDED_TURN, REMINDER_TURN], has_before=True), 'whole conversation'),
            'later Items exist': (window_answer([SEEDED_TURN, REMINDER_TURN], has_after=True), 'whole conversation'),
            'hasBefore not stated': (unknown, 'whole conversation'),
            'a Turn shown from its second Item': (window_answer([SEEDED_TURN], part={'start': 1}), 'holds part of Turn turn-1'),
            'a Turn with more Items than shown': (window_answer([SEEDED_TURN], part={'total': 4}), 'holds part of Turn turn-1'),
            'an Item shown as a preview': (window_answer([SEEDED_TURN], preview=True), 'as a preview'),
            'a message sent as the window\'s historyPreview': (window_answer([SEEDED_TURN, REMINDER_TURN], window_preview=True), 'as a preview'),
            'more Items than the window holds': (window_answer([SEEDED_TURN], total=9), 'every Item'),
        }
        for label, (detail, message) in cases.items():
            with self.subTest(label):
                with self.assertRaisesRegex(ValueError, message):
                    smoke.whole_conversation(detail)


if __name__ == '__main__':
    unittest.main()
