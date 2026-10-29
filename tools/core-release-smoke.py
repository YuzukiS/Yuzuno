#!/usr/bin/env python3
"""One resumable isolated package upgrade; scripted native protocol, no models.
With --new-data-directory, for a candidate its baseline cannot upgrade to in
place (docs/adr/0002-session-store-new-data-directory.md): the baseline's
refusal, and the candidate's own new installation."""
import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_common import digest, inventory, read, write

TOOLS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('update_checks', TOOLS / 'updates-acceptance.py')
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)


class Events:
    def __init__(self, origin):
        self.events = queue.Queue(maxsize=8192)
        self.closed = False
        self.stream = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(origin + '/api/events', timeout=90)
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        try:
            for line in self.stream:
                if self.closed:
                    return
                if line.startswith(b'data:'):
                    self.events.put_nowait(True)
            if not self.closed:
                self.events.put_nowait(RuntimeError('SSE ended before the fixture completed'))
        except Exception as error:
            if not self.closed:
                self.events.put_nowait(error)

    def until(self, check):
        deadline = time.monotonic() + 60
        while not check():
            event = self.events.get(timeout=max(.001, deadline - time.monotonic()))
            if isinstance(event, Exception):
                raise event

    def close(self):
        self.closed = True
        try:
            self.stream.fp.raw._sock.shutdown(socket.SHUT_RDWR)
        except (AttributeError, OSError):
            pass
        self.stream.close()


def free_port(port=0):
    with socket.socket() as probe:
        # A dead previous listener's TIME_WAIT is not a running Core.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', port))
        return probe.getsockname()[1]


def validate_bundle(path):
    manifest = read(path / 'manifest.json')
    actual = inventory(path)
    actual.pop('manifest.json')
    if actual != manifest['files']:
        raise ValueError(f'Bundle changed: {path}')
    return manifest


def save_fixture_budget(api):
    machine = api('jobs/budget')['machine']
    # Cores before T-160 cap a budget at a share of the host; later ones do not.
    suggested, maximum = machine['suggestedBudget'], machine.get('maximumBudget')
    # Keep the disposable budget small and distinct from the fallback, including
    # on resume: comparing two unsaved defaults would not prove restoration.
    budget = {'cpuMillis': 201 if suggested['cpuMillis'] == 200 else 200,
              'memoryMiB': 128, 'swapMiB': 0}
    if maximum and any(value > maximum[key] for key, value in budget.items()):
        raise ValueError('Host cannot accommodate the disposable saved-budget fixture')
    api('jobs/budget', budget)
    if api('jobs/budget')['budget'] != budget:
        raise ValueError('Disposable budget was not saved before upgrade')
    return {'suggested': suggested, 'saved': budget}


# What this smoke reads from a Workspace backup, in two layouts, told apart
# as Core tells them (record_rows::check_store): a `sessionStore` mark of
# exactly '2' is the session store (core.20 on: `agents(id, data)`, the
# Agent's metadata without its Turns); no mark at all is the record layout of
# core.11 to core.19, with each Agent's `layout` column at 1. Any other mark,
# or neither, is refused rather than guessed at.
BACKUP_TABLES = {
    'workspace_meta': {'key', 'value'},
    'agents': {'id', 'data'},
    'agent_turns': {'agent_id', 'turn_id', 'ord', 'items', 'data'},
    'agent_items': {'agent_id', 'turn_id', 'item_id', 'ord', 'payloads', 'data', 'previews'},
    'project_agents': {'agent_id', 'project_id'},
}
SESSION_STORE = '2'
# The session store keeps the start of a long streamed field in its own rows.
STREAM_CHUNKS = {'agent_id', 'turn_id', 'item_id'}
# An Item that holds part of itself elsewhere (client_view, record_rows).
ELSEWHERE = ('_yuzunoTruncated', '_yuzunoSpilled')
MESSAGE_TYPES = ('userMessage', 'agentMessage')


def columns_of(db, table):
    return {row[1] for row in db.execute(f'PRAGMA table_info({table})')}


def backup_conversation(path, agent_id, workspace_id):
    """The fixture Agent's conversation as the operation's own backup holds
    it, in snapshot()'s shape. The update helper takes that backup after the
    old Core stopped taking work, so it also holds what Core added after the
    fixture's Turn by itself (a Brief reminder Turn, for one). Every message
    must be whole in its own row: one whose text lies partly elsewhere is
    refused, not compared by its preview."""
    db = sqlite3.connect(f'file:{path}?mode=ro&immutable=1', uri=True)
    try:
        for table, columns in BACKUP_TABLES.items():
            missing = columns - columns_of(db, table)
            if missing:
                raise ValueError(f'Unsupported backup layout: {table} lacks {sorted(missing)}')
        row = db.execute("SELECT value FROM workspace_meta WHERE key='workspaceId'").fetchone()
        if not row or row[0] != workspace_id:
            raise ValueError('The operation backup is of another Workspace')
        mark = db.execute("SELECT value FROM workspace_meta WHERE key='sessionStore'").fetchone()
        if mark is not None:
            if not (isinstance(mark[0], str) and mark[0] == SESSION_STORE):
                raise ValueError(f'Unsupported backup layout: session store {mark[0]!r}')
            missing = STREAM_CHUNKS - columns_of(db, 'agent_stream_chunks')
            if missing:
                raise ValueError(f'Unsupported backup layout: agent_stream_chunks lacks {sorted(missing)}')
            row = db.execute('SELECT data FROM agents WHERE id=?', (agent_id,)).fetchone()
            if not row:
                raise ValueError('The operation backup has no record of the fixture Agent')
            # As record_rows::from_meta reads it: an object, without Turns or receipts.
            meta = json.loads(row[0])
            if not isinstance(meta, dict) or not isinstance(meta.get('agent'), dict):
                raise ValueError('Unsupported backup layout: the Agent metadata is not an object with its agent')
            if 'turns' in meta or 'messageReceipts' in meta:
                raise ValueError('Unsupported backup layout: the Agent metadata carries Turns or receipts')
            agent = meta['agent']
            if agent.get('id') != agent_id:
                raise ValueError('The operation backup holds another Agent under the fixture Agent')
        else:
            if 'layout' not in columns_of(db, 'agents'):
                raise ValueError('Unsupported backup layout: no session store mark and no agent record layout')
            row = db.execute('SELECT data, layout FROM agents WHERE id=?', (agent_id,)).fetchone()
            if not row:
                raise ValueError('The operation backup has no record of the fixture Agent')
            if row[1] != 1:
                raise ValueError(f'Unsupported backup layout: agent record layout {row[1]}')
            agent = json.loads(row[0])['agent']
        project = db.execute('SELECT project_id FROM project_agents WHERE agent_id=?', (agent_id,)).fetchone()
        turns = []
        for turn, count in db.execute('SELECT turn_id, items FROM agent_turns WHERE agent_id=? ORDER BY ord', (agent_id,)):
            if mark is not None:
                # Its Item rows, all of them: a Turn kept whole in its own row, or
                # with rows missing, would hide messages from the comparison.
                rows = db.execute('SELECT COUNT(*) FROM agent_items WHERE agent_id=? AND turn_id=?', (agent_id, turn)).fetchone()[0]
                if count is None or rows != count:
                    raise ValueError(f'The operation backup has {rows} of Turn {turn}\'s {count} Item rows')
            turns.append(turn)
        messages = []
        for turn, item_id, payloads, data in db.execute(
                'SELECT i.turn_id, i.item_id, i.payloads, i.data FROM agent_items i JOIN agent_turns t '
                'ON t.agent_id=i.agent_id AND t.turn_id=i.turn_id WHERE i.agent_id=? ORDER BY t.ord, i.ord', (agent_id,)):
            item = json.loads(data)
            if item.get('type') not in MESSAGE_TYPES:
                continue
            if payloads:
                raise ValueError(f'Unsupported backup layout: message {item_id} keeps fields in agent_payloads')
            if any(key in item for key in ELSEWHERE):
                raise ValueError(f'Unsupported backup layout: message {item_id} keeps part of itself outside its row')
            if mark is not None and db.execute('SELECT 1 FROM agent_stream_chunks WHERE agent_id=? AND turn_id=? AND item_id=? LIMIT 1',
                                               (agent_id, turn, item_id)).fetchone():
                raise ValueError(f'Unsupported backup layout: message {item_id} keeps its start in agent_stream_chunks')
            messages.append([item.get('id'), item.get('text'), item.get('content')])
    finally:
        db.close()
    return {'id': agent.get('id'), 'threadId': agent.get('threadId'), 'projectId': project[0] if project else None,
            'settings': agent.get('settings'), 'reviewedSeq': agent.get('reviewedSeq'),
            'turnIds': turns, 'messages': messages}


def whole_conversation(detail):
    """The Agent's conversation in snapshot()'s shape, from GET
    /api/agents/<id>?view=window (core.18 on). Core answers with a window of
    the newest Items, and an Item over its size limits as a preview, so the
    answer is the whole conversation only when the window says it holds
    every Item of every Turn it lists, and nothing before or after, and no
    Item is a preview. The smoke's conversation is small; anything less is
    refused rather than compared."""
    window = detail.get('conversation')
    if not isinstance(window, dict):
        raise ValueError('Core answered without its conversation window')
    if window.get('hasBefore') is not False or window.get('hasAfter') is not False:
        raise ValueError('The conversation window does not hold the whole conversation')
    turns = detail['turns']
    for turn in turns:
        part = turn.get('_yuzunoSlice')
        if part is not None and (part.get('start') != 0 or part.get('total') != len(turn['items'])):
            raise ValueError(f"The conversation window holds part of Turn {turn['id']}")
        if any(key in item for item in turn['items'] for key in ELSEWHERE):
            raise ValueError(f"The conversation window shows an Item of Turn {turn['id']} as a preview")
    if window.get('totalItems') != sum(len(turn['items']) for turn in turns):
        raise ValueError('The conversation window does not hold every Item')
    agent = detail['agent']
    return {key: agent.get(key) for key in ('id', 'threadId', 'projectId', 'settings', 'reviewedSeq')} | {
        'turnIds': [t['id'] for t in turns],
        'messages': [(i.get('id'), i.get('text'), i.get('content')) for t in turns
                     for i in t['items'] if i['type'] in MESSAGE_TYPES]}


def plain_backup(path):
    """Whether the main file alone is the whole backup, which is all an
    immutable read sees. The helper's online backup keeps the live database's
    WAL mode, and opening it later leaves an empty -wal and a -shm (an index)
    beside it: those are fine. A -wal with frames in it, or any rollback
    journal, holds content the main file lacks; a link may be someone else's
    file. Each is refused. Returns what lies beside the file, with sizes."""
    if path.is_symlink() or not path.is_file():
        raise ValueError('The operation backup is missing or not a regular file')
    with path.open('rb') as file:
        header = file.read(100)
    if len(header) < 100 or header[:16] != b'SQLite format 3\x00':
        raise ValueError('The operation backup is not an SQLite database')
    beside = {suffix: Path(f'{path}{suffix}').stat().st_size
              for suffix in ('-wal', '-journal', '-shm') if Path(f'{path}{suffix}').exists()}
    if beside.get('-wal'):
        raise ValueError('The operation backup has a non-empty -wal beside it; its frames are not in the main file')
    if '-journal' in beside:
        raise ValueError('The operation backup has a -journal beside it; refusing a read that may miss it')
    return beside


def holds_seeded(seeded, backup):
    """Whether the backup is of the conversation this fixture seeded: the same
    Agent, thread, Project, settings and read cursor, with the seeded Turns and
    messages first and unchanged."""
    return (bool(seeded['turnIds'])
            and all(seeded[key] == backup[key] for key in ('id', 'threadId', 'projectId', 'settings', 'reviewedSeq'))
            and backup['turnIds'][:len(seeded['turnIds'])] == seeded['turnIds']
            and backup['messages'][:len(seeded['messages'])] == seeded['messages'])


def conversation_problem(seeded, before, after):
    """None when the upgrade kept the conversation as the old Core left it."""
    if not holds_seeded(seeded, before):
        return 'The operation backup does not hold the seeded conversation'
    if after != before:
        return 'Conversation identity/history/settings/read cursor changed'
    return None


IN_PLACE, NEW_DIRECTORY = 'inPlace', 'newDataDirectory'


def upgrades_in_place(before, after):
    """Whether a Core of release `before` takes `after` as an update: the
    checks of Core's update admission (`compatible_with`,
    core/src/updates/package.rs), both ways, as rollback needs the old
    release to read what the new one writes."""
    def reads(span, version):
        return span['readsMin'] <= version <= span['readsMax']
    return (reads(after['schema'], before['schema']['writes']) and reads(before['schema'], after['schema']['writes'])
            and reads(after['records'], before['records']['writes']) and reads(before['records'], after['records']['writes']))


def data_files(path):
    """Every regular file of a stopped Core's data directory, with its SHA-256
    (a socket left behind is not data)."""
    return {str(p.relative_to(path)): digest(p) for p in sorted(path.rglob('*')) if p.is_file() and not p.is_symlink()}


def record_layouts(data_dir, scratch):
    """The records layouts a stopped Core's database holds, as Core's update
    admission reads them (`Storage::read`, core/src/updates/storage.rs): the
    session store's mark, else the Agents' layout column, else whole JSON
    rows (0). Read from a copy, so that nothing is written beside the original."""
    copy = Path(tempfile.mkdtemp(prefix='layouts-', dir=scratch))
    try:
        for name in ('workspace.sqlite', 'workspace.sqlite-wal'):
            if (data_dir / name).is_file():
                shutil.copyfile(data_dir / name, copy / name)
        db = sqlite3.connect(copy / 'workspace.sqlite')
        try:
            marked = db.execute("SELECT value FROM workspace_meta WHERE key='sessionStore'").fetchone()
            agents = db.execute('SELECT EXISTS(SELECT 1 FROM agents)').fetchone()[0]
            if marked:
                return [int(marked[0])] if agents else []
            if 'layout' in {row[1] for row in db.execute('PRAGMA table_info(agents)')}:
                return sorted(row[0] for row in db.execute('SELECT DISTINCT layout FROM agents'))
            return [0]
        finally:
            db.close()
    finally:
        shutil.rmtree(copy)


def reconcile_upgrade(managed, state, observe, timeout=180):
    """Leave an accepted replacement alone until its own helper has finished."""
    journal = managed / 'updates/state.json'
    operation_id = state.get('operationId')
    deadline = time.monotonic() + timeout
    last = None
    releases = None
    while True:
        op = (read(journal).get('operation') or {}) if journal.exists() else {}
        if not op.get('requestId'):
            if operation_id:
                raise ValueError('Accepted upgrade record disappeared; preserving processes')
            return None
        if releases is None:
            releases = [read(Path(state['inputs'][key]) / 'manifest.json')['releaseId']
                        for key in ('baseline', 'candidate')]
        before, after = releases
        expected = {'requestId': state['requestId'], 'workspaceId': state['workspaceId'],
                    'releaseId': after,
                    'previous': {'releaseId': before, 'manifestSha256': state['inputs']['baselineSha256']},
                    'candidate': {'releaseId': after, 'manifestSha256': state['inputs']['candidateSha256']}}
        if any(op.get(key) != value for key, value in expected.items()) or (operation_id and op['id'] != operation_id):
            raise ValueError('Accepted upgrade identity changed; preserving processes')
        operation_id = op['id']
        if op.get('oldProcess') not in state['owned']:
            raise ValueError('Upgrade original Core is not owned by this fixture')
        for key, executables in {
            'oldProcess': [managed / 'releases' / before / 'bin/yuzuno-workspace'],
            'helperProcess': [managed / 'releases' / before / 'bin/yuzuno-update-helper'],
            'newProcess': [managed / 'releases' / release / 'bin/yuzuno-workspace' for release in (before, after)],
        }.items():
            process = op.get(key)
            if process and Path(process['executable']) not in executables:
                raise ValueError('Upgrade process is outside the fixed releases')
        helper = op.get('helperProcess')
        alive = bool(helper and common.identity(helper['pid']) == helper)
        observation = {'operationId': operation_id, 'phase': op['phase'], 'helperAlive': alive}
        if observation != last:
            observe(observation)
            last = observation
        if op['phase'] in ('complete', 'failed', 'rolledBack', 'cancelled') and not alive:
            return op
        if op['phase'] not in ('waiting', 'flushing', 'stopping', 'starting', 'restoring',
                               'complete', 'failed', 'rolledBack', 'cancelled'):
            raise ValueError('Unknown accepted upgrade phase; preserving processes')
        if helper and not alive:
            # The helper may have committed its terminal record just after our
            # first read. Otherwise a dead/reused PID is not permission to retry.
            if read(journal).get('operation') != op:
                continue
            raise RuntimeError('Upgrade helper exited before a terminal record; preserving uncertain state, no reapply')
        if time.monotonic() >= deadline:
            raise TimeoutError('Upgrade still unresolved; preserving processes for later reconciliation, no reapply')
        # Also allow the bounded gap between accepted apply and helper identity.
        time.sleep(.2)


def smoke(args):
    baseline, candidate = (p.resolve(strict=True) for p in (args.baseline, args.candidate))
    before_manifest, after_manifest = map(validate_bundle, (baseline, candidate))
    if before_manifest['releaseId'] == after_manifest['releaseId']:
        raise ValueError('Upgrade smoke requires two distinct releases')
    # Which smoke a candidate gets follows from both packages, as the release
    # declared it: neither one stands in for the other.
    mode = NEW_DIRECTORY if args.new_data_directory else IN_PLACE
    if upgrades_in_place(before_manifest, after_manifest) != (mode == IN_PLACE):
        raise ValueError('The baseline takes this candidate as an update: use the in-place smoke' if mode == NEW_DIRECTORY else
                         'The baseline cannot take this candidate as an update (schema or records); a release that needs '
                         'a new data directory is frozen with --new-data-directory')
    frozen = {'baseline': str(baseline), 'candidate': str(candidate),
              'baselineSha256': digest(baseline / 'manifest.json'), 'candidateSha256': digest(candidate / 'manifest.json'),
              **({'mode': mode} if mode == NEW_DIRECTORY else {})}
    if args.state.exists():
        state = read(args.state)
        if state['inputs'] != frozen:
            raise ValueError('Cannot change the packages of an existing smoke run')
    else:
        root = Path(tempfile.mkdtemp(prefix='yzrel-', dir='/tmp'))
        state = {'inputs': frozen, 'root': str(root), 'port': free_port(), 'nonce': str(uuid.uuid4()),
                 'requestId': str(uuid.uuid4()), 'phases': {}, 'attempts': [], 'owned': [], 'passed': False}
        write(root / 'owner.json', {'nonce': state['nonce'], 'inputs': frozen})
        write(args.state, state)
    root = Path(state['root'])
    if root.parent != Path('/tmp') or not root.name.startswith('yzrel-') or root.is_symlink():
        raise ValueError('Invalid disposable smoke location')
    if read(root / 'owner.json') != {'nonce': state['nonce'], 'inputs': frozen}:
        raise ValueError('Disposable installation identity mismatch')
    managed, data, work = (root / name for name in ('managed', 'data', 'work'))
    # The candidate's own installation and data directory (--new-data-directory).
    fresh, fresh_data = root / 'fresh', root / 'fresh-data'
    work.mkdir(exist_ok=True)
    (root / 'tmp').mkdir(exist_ok=True)
    if len(str(managed / 'updates/control.sock').encode()) >= 104:
        raise ValueError('Disposable path is too long for the helper socket')
    fixture = TOOLS.parent / 'acceptance/turn-cost/fake_codex.py'
    origin = f'http://127.0.0.1:{state["port"]}'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    child = None
    attempt = {'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'passed': False}
    state['attempts'].append(attempt)
    state.pop('cleanup', None)
    def save():
        write(args.state, state)

    def api(path, body=None, timeout=20):
        req = urllib.request.Request(origin + '/api/' + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
        with opener.open(req, timeout=timeout) as response:
            return json.load(response)

    def capture():
        path = managed / 'updates/state.json'
        if path.exists():
            operation = read(path).get('operation') or {}
            for key in ('oldProcess', 'newProcess', 'helperProcess'):
                process = operation.get(key)
                if process and process not in state['owned']:
                    if not Path(process['executable']).is_relative_to(managed / 'releases'):
                        raise ValueError('Unowned process in disposable update state')
                    state['owned'].append(process)
        save()

    # `into` is where a seeded Workspace is recorded: `state`, or for the new
    # installation of --new-data-directory, state['fresh'].
    def snapshot(into=None):
        return whole_conversation(api('agents/' + (into or state)['agentId'] + '?view=window'))

    def idle(into=None):
        detail = api('agents/' + (into or state)['agentId'])
        if any(not p.get('stale') for p in detail['pending']):
            raise ValueError('Unexpected scripted approval; never approve it')
        return detail['agent']['status'] == 'idle' and detail['agent']['connectionState'] == 'connected' and detail.get('collaboration', {}).get('ready')

    def stop_owned():
        def observed(value):
            state['operationId'] = value['operationId']
            attempt['reconciliation'] = value
            save()
        # This guard applies both to resumption and exception/finally cleanup.
        # Never terminate an independent helper while it still owns replacement.
        reconcile_upgrade(managed, state, observed)
        capture()
        for process in reversed(state['owned']):
            if not any(Path(process['executable']).is_relative_to(install / 'releases') for install in (managed, fresh)):
                raise ValueError('Refusing to signal a process outside this disposable installation')
            if common.identity(process['pid']) == process:
                os.kill(process['pid'], signal.SIGINT)
                try:
                    common.until(lambda: common.identity(process['pid']) != process, 12)
                except AssertionError:
                    # These are only our disposable Core/helper, with a
                    # scripted runtime that cannot execute tools or models.
                    if common.identity(process['pid']) == process:
                        os.kill(process['pid'], signal.SIGKILL)
                        common.until(lambda: common.identity(process['pid']) != process, 5)

    def launch(install, data_dir, log_name):
        """Starts the release `install` has as current, on `data_dir`, and
        returns its health once it serves."""
        nonlocal child
        running = read(install / 'current.json')['releaseId']
        executable = install / 'releases' / running / 'bin/yuzuno-workspace'
        with (root / log_name).open('wb') as log:
            child = subprocess.Popen([str(executable), '--install-dir', str(install), '--data-dir', str(data_dir),
                '--cwd', str(work), '--port', str(state['port']), '--codex', str(fixture)],
                cwd=work, env=dict(os.environ, TMPDIR=str(root / 'tmp'), T9_TIMELINE=str(root / 'timeline')),
                stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        state['owned'].append(common.until(lambda: common.identity(child.pid), 5))
        save()
        return common.until(lambda: (h if (h := api('health')).get('releaseId') == running else None))

    def seed(into):
        """A project, a conversation of one scripted Turn, a task and a saved
        budget in the running Core, recorded in `into` as each is made."""
        if 'project' not in into:
            into['project'] = api('projects', {'name': 'Release smoke retained project'})
            save()
        events = Events(origin)
        try:
            if 'agentId' not in into:
                into['agentId'] = api('agents', {'name': 'Release smoke conversation', 'harness': 'codex', 'cwd': str(work)})['id']
                save()
            else:
                # A manually restarted isolated Core restores records;
                # reconnect only this scripted fixture, never a user Agent.
                api('agents/' + into['agentId'] + '/reconnect', {})
            api('agents/' + into['agentId'] + '/project', {'projectId': into['project']['id']})
            events.until(lambda: idle(into))
            if not snapshot(into)['turnIds']:
                api('agents/' + into['agentId'] + '/turns', {'text': 'run:2:0:0:100'})
            events.until(lambda: idle(into) and len(snapshot(into)['messages']) >= 2)
            into['conversation'] = snapshot(into)
        finally:
            events.close()
        into['task'] = api('collaboration/task_create', {'requestId': state['nonce'], 'title': 'Release smoke retained task',
            'projectId': into['project']['id']})['task']
        into['budgetSeed'] = save_fixture_budget(api)
        into['budget'] = into['budgetSeed']['saved']

    def kept(into, health, release):
        """What `into` recorded, as the running Core now has it: its release
        and Workspace, the seeded conversation unchanged and first (Core may
        start a Turn by itself), project, task and saved budget."""
        if not (health['releaseId'] == release and health['workspaceId'] == into['workspaceId']
                and health['storageReady'] and health['apiReady']):
            raise ValueError('Release/Workspace/health mismatch')
        if not holds_seeded(json.loads(json.dumps(into['conversation'])), json.loads(json.dumps(snapshot(into)))):
            raise ValueError('Conversation identity/history/settings/read cursor changed')
        if (into['project'] not in api('projects')['projects']
                or api('collaboration/task_get', {'taskId': into['task']['id']})['task'] != into['task']
                or api('jobs/budget')['budget'] != into['budget']):
            raise ValueError('Project, task or budget changed')
        with opener.open(origin, timeout=15) as response:
            if f'content="{release}"' not in response.read().decode():
                raise ValueError('Served UI does not match the running release')

    def stopped():
        stop_owned()
        if child:
            child.wait(timeout=5)
        free_port(state['port'])

    def refused(path, body):
        """The running Core's refusal of an update request, as it answered."""
        try:
            api(path, body, timeout=90)
        except urllib.error.HTTPError as error:
            return {'path': path, 'status': error.code, 'error': error.read().decode(errors='replace')[:2000]}
        raise ValueError(f'The baseline accepted {path} for a candidate it cannot read')

    def new_directory():
        """The baseline, with a seeded Workspace, refuses the candidate before
        anything is applied, and keeps its release, Workspace and records
        layout; the candidate installs into a new directory of its own, beside
        the untouched old one, and keeps its own records across a restart."""
        phases = state['phases']
        if not phases.get('refused'):
            if not (managed / 'current.json').exists():
                subprocess.run([str(baseline / 'bin/yuzuno-update-helper'), 'register', '--install-dir', str(managed),
                    '--bundle', str(baseline), '--manifest-sha256', frozen['baselineSha256'],
                    '--reviewed-source', 'isolated fixed-release smoke', '--initialize'], check=True, timeout=90)
            if read(managed / 'current.json')['releaseId'] != before_manifest['releaseId']:
                raise ValueError('Unexpected installed release in fixture')
            if not phases.get('seeded'):
                health = launch(managed, data, f'core-{len(state["attempts"])}-baseline.log')
                state.setdefault('workspaceId', health['workspaceId'])
                seed(state)
                phases['seeded'] = True
                save()
                stopped()
            if not phases.get('offered'):
                # Offered as an update would be: to the baseline's own helper,
                # which registers a release only if its admission accepts it.
                offered = subprocess.run([str(baseline / 'bin/yuzuno-update-helper'), 'register', '--install-dir', str(managed),
                    '--bundle', str(candidate), '--manifest-sha256', frozen['candidateSha256'],
                    '--reviewed-source', 'isolated fixed-release smoke'], capture_output=True, text=True, timeout=90)
                if offered.returncode == 0:
                    raise ValueError('The baseline registered a candidate it cannot read')
                if not re.search(r'record format|records\.layout|schema', offered.stderr):
                    raise ValueError(f'The baseline refused the candidate for another reason than its storage: {offered.stderr[-500:]}')
                catalog = managed / 'catalog.json'
                if ((managed / 'releases' / after_manifest['releaseId']).exists()
                        or catalog.exists() and after_manifest['releaseId'] in catalog.read_text()):
                    raise ValueError('The refused candidate was staged or catalogued')
                state['refusals'] = [{'command': 'update-helper register', 'exit': offered.returncode, 'error': offered.stderr[-2000:]}]
                phases['offered'] = True
                save()
            health = launch(managed, data, f'core-{len(state["attempts"])}-baseline-after.log')
            state['refusals'][1:] = [refused('updates/prepare', {'releaseId': after_manifest['releaseId']}),
                refused('updates/apply', {'releaseId': after_manifest['releaseId'], 'requestId': state['requestId']})]
            status = api('updates')
            if status.get('operation') or not status['acceptingWork'] or read(managed / 'current.json')['releaseId'] != before_manifest['releaseId']:
                raise ValueError('The refused candidate started an update or became the current release')
            kept(state, health, before_manifest['releaseId'])
            stopped()
            layouts = record_layouts(data, root / 'tmp')
            if layouts != [before_manifest['records']['writes']]:
                raise ValueError(f'The baseline Workspace is not in its own records layout: {layouts}')
            state['baselineData'] = {'records': layouts, 'files': data_files(data)}
            phases['refused'] = True
            save()
        if not phases.get('installed'):
            into = state.setdefault('fresh', {})
            if not (fresh / 'current.json').exists():
                subprocess.run([str(candidate / 'bin/yuzuno-update-helper'), 'register', '--install-dir', str(fresh),
                    '--bundle', str(candidate), '--manifest-sha256', frozen['candidateSha256'],
                    '--reviewed-source', 'isolated fixed-release smoke', '--initialize'], check=True, timeout=90)
            if read(fresh / 'current.json')['releaseId'] != after_manifest['releaseId']:
                raise ValueError('Unexpected installed release in the new installation')
            health = launch(fresh, fresh_data, f'core-{len(state["attempts"])}-candidate.log')
            into.setdefault('workspaceId', health['workspaceId'])
            if into['workspaceId'] == state['workspaceId']:
                raise ValueError('The new installation opened the baseline Workspace')
            if 'conversation' not in into:
                seed(into)
                save()
            kept(into, health, after_manifest['releaseId'])
            stopped()
            kept(into, launch(fresh, fresh_data, f'core-{len(state["attempts"])}-restart.log'), after_manifest['releaseId'])
            stopped()
            if data_files(data) != state['baselineData']['files']:
                raise ValueError('The baseline data directory changed')
            state['health'] = health
            phases['installed'] = True
            save()
        phases['verified'] = True
        save()

    try:
        # Reconcile any accepted replacement before cleanup or another startup.
        stop_owned()
        free_port(state['port'])
        if mode == NEW_DIRECTORY:
            if not state['phases'].get('verified'):
                new_directory()
        elif not state['phases'].get('verified'):
            helper = baseline / 'bin/yuzuno-update-helper'
            for first, bundle, manifest in ((True, baseline, before_manifest), (False, candidate, after_manifest)):
                if first and (managed / 'current.json').exists():
                    continue
                if not first and state['phases'].get('registered'):
                    continue
                argv = [str(helper), 'register', '--install-dir', str(managed), '--bundle', str(bundle),
                        '--manifest-sha256', digest(bundle / 'manifest.json'), '--reviewed-source', 'isolated fixed-release smoke']
                if first:
                    argv.append('--initialize')
                subprocess.run(argv, check=True, timeout=90)
            state['phases']['registered'] = True
            save()
            running = read(managed / 'current.json')['releaseId']
            if running not in (before_manifest['releaseId'], after_manifest['releaseId']):
                raise ValueError('Unexpected installed release in fixture')
            health = launch(managed, data, f'core-{len(state["attempts"])}.log')
            if not state['phases'].get('seeded'):
                if running != before_manifest['releaseId']:
                    raise ValueError('Missing pre-upgrade record evidence')
                state['workspaceId'] = health['workspaceId']
                seed(state)
                state['phases']['seeded'] = True
                save()
            status = api('updates')
            operation = status.get('operation') or {}
            if operation.get('phase') in ('failed', 'rolledBack', 'cancelled'):
                raise ValueError('Upgrade failed; retain evidence and inspect instead of automatically upgrading again')
            if operation.get('phase') != 'complete':
                if not operation:
                    api('updates/check', {}, timeout=90)
                    api('updates/prepare', {'releaseId': after_manifest['releaseId']}, timeout=90)
                if not operation or operation.get('phase') == 'preparing':
                    prepared = common.until(lambda: (s if (s := api('updates')).get('operation', {}).get('phase') in ('prepared', 'failed') else None), 90)
                    if prepared['operation']['phase'] != 'prepared':
                        raise ValueError('Preparation failed')
                api('updates/apply', {'releaseId': after_manifest['releaseId'], 'requestId': state['requestId']}, timeout=90)
                capture()
                status = common.until(lambda: (s if (s := api('updates')).get('operation', {}).get('phase') in ('complete', 'failed', 'rolledBack') else None), 180)
            if status['operation']['phase'] != 'complete':
                raise ValueError('Upgrade did not complete')
            state['phases']['upgraded'] = True
            state['operationId'] = status['operation']['id']
            save()
            health = api('health')
            if not (health['releaseId'] == after_manifest['releaseId'] and health['workspaceId'] == state['workspaceId'] and health['storageReady'] and health['apiReady'] and status['acceptingWork']):
                raise ValueError('Candidate release/Workspace/health mismatch')
            # The baseline is what the old Core held when it stopped: the
            # operation's own backup. The snapshot taken after seeding can
            # miss a Turn Core starts by itself afterwards (a Brief reminder),
            # so it only proves the backup is this conversation's. Turns past
            # the seeded ones are recorded; none may be lost or added.
            backup = managed / 'backups' / f"{state['operationId']}.sqlite3"
            beside = plain_backup(backup)
            # JSON round-trip compares lists rather than in-memory tuples on resume.
            seeded = json.loads(json.dumps(state['conversation']))
            before = backup_conversation(backup, state['agentId'], state['workspaceId'])
            state['conversationBaseline'] = {
                'source': 'operation backup', 'path': str(backup), 'bytes': backup.stat().st_size, 'sha256': digest(backup),
                'beside': beside, 'snapshot': before, 'afterSeeded': {'turnIds': before['turnIds'][len(seeded['turnIds']):],
                                                    'messages': before['messages'][len(seeded['messages']):]}}
            save()
            problem = conversation_problem(seeded, before, json.loads(json.dumps(snapshot())))
            if problem:
                raise ValueError(problem)
            if state['project'] not in api('projects')['projects'] or api('collaboration/task_get', {'taskId': state['task']['id']})['task'] != state['task'] or api('jobs/budget')['budget'] != state['budget']:
                raise ValueError('Project, task or budget changed')
            proof = status['operation'].get('recordsProof') or {}
            if not (proof.get('recordsReady') and proof.get('phase') == 'afterRestore' and proof.get('workspaceId') == state['workspaceId'] and proof.get('releaseId') == after_manifest['releaseId']):
                raise ValueError('Missing successful restoration proof')
            with opener.open(origin, timeout=15) as response:
                if f'content="{after_manifest["releaseId"]}"' not in response.read().decode():
                    raise ValueError('Served UI does not match candidate')
            state['health'], state['recordsProof'] = health, proof
            state['phases']['verified'] = True
            save()
        attempt['passed'] = True
    except BaseException as error:
        attempt['error'] = f'{type(error).__name__}: {error}'
    finally:
        try:
            stop_owned()
            if child:
                child.wait(timeout=5)
            # Core owns the scripted app-server lifecycle; verify none remain.
            for path in (root / 'timeline').glob('codex-*.jsonl'):
                process = common.identity(int(path.stem.removeprefix('codex-')))
                if process and str(fixture).encode() in Path(f'/proc/{process["pid"]}/cmdline').read_bytes():
                    raise ValueError('Owned scripted process remains; retain its identity for inspection')
            free_port(state['port'])
            state['cleanup'] = {'processesStopped': True, 'portReusable': True}
        except BaseException as error:
            attempt['cleanupError'] = f'{type(error).__name__}: {error}'
            attempt['passed'] = False
            state['cleanup'] = {'processesStopped': False, 'portReusable': False}
        attempt['finishedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
        state['passed'] = attempt['passed'] and state['phases'].get('verified', False)
        save()
    print(json.dumps({'passed': state['passed'], 'phases': state['phases'], 'state': str(args.state), 'attempt': attempt}))
    return 0 if state['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('baseline', 'candidate', 'state'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--new-data-directory', action='store_true',
                        help='The candidate needs a new data directory: the baseline must refuse it as an update')
    raise SystemExit(smoke(parser.parse_args()))
