#!/usr/bin/env python3
"""Real, bounded normal/urgent mailbox acceptance, exclusively on lab Core 4379.

Run only after the lab Core has been rebuilt/restarted by its owner:
  python3 acceptance/collaboration/priority-check.py run
  python3 acceptance/collaboration/priority-check.py cleanup

Codex and Claude run sequentially, one new live Agent at a time. Existing Agents,
tasks, native sessions and the daily Core are never changed. No prompt is replayed
after an ambiguous outcome. Evidence remains in ignored priority-state.json.
"""
import datetime
import json
from pathlib import Path
import shlex
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
LAB = Path(__file__).resolve().parent
STATE = LAB / 'priority-state.json'
BASE = 'http://127.0.0.1:4379/api'
SLEEP = 'sleep 12'
TERMINAL = {'completed', 'failed', 'interrupted', 'unknown'}


def api(path, body=None):
    request = urllib.request.Request(BASE + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    try:
        with urllib.request.urlopen(request, timeout=75) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'HTTP {error.code} {path}: {error.read().decode()}') from None


def call(operation, **arguments):
    if operation not in {'task_list', 'task_get', 'peer_read', 'peers_list'}:
        arguments.setdefault('requestId', str(uuid.uuid4()))
    return api('/collaboration/' + operation, arguments)


def save(state):
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')


def note(state, stage, **details):
    state['stage'] = stage
    state.setdefault('observations', []).append({'at': time.time(), 'stage': stage, **details})
    save(state)
    print(stage, json.dumps(details, ensure_ascii=False), flush=True)


def ensure_lab():
    assert api('/health')['application'] == 'yuzuno-next'
    owned = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            argv = [part.decode() for part in (proc / 'cmdline').read_bytes().split(b'\0') if part]
            if not argv or not argv[0].endswith('yuzuno-workspace') or '--port' not in argv:
                continue
            if argv[argv.index('--port') + 1] != '4379' or (proc / 'cwd').resolve() != ROOT:
                continue
            if '--data-dir' in argv and (ROOT / argv[argv.index('--data-dir') + 1]).resolve() == LAB / 'core-data':
                owned.append(int(proc.name))
        except (OSError, UnicodeError, ValueError, IndexError):
            continue
    assert len(owned) == 1, f'Expected exactly one owned 4379 Core: {owned}'
    return owned[0]


def tasks():
    rows = {}
    for archived in (False, True):
        cursor = 0
        while True:
            page = call('task_list', archived=archived, afterSeq=cursor, limit=100)
            rows.update((task['id'], task) for task in page['tasks'])
            if not page['hasMore']:
                break
            cursor = page['nextAfterSeq']
    return rows


def detail(attempt):
    value = api('/agents/' + attempt['agentId'])
    assert value['agent']['cwd'] == attempt['cwd'], 'Agent escaped its isolated directory'
    assert value['agent']['harness'] == attempt['harness']
    return value


def exact_sleep(command):
    if isinstance(command, str):
        try:
            parts = shlex.split(command)
        except ValueError:
            return False
    elif isinstance(command, list) and all(isinstance(part, str) for part in command):
        parts = command
    else:
        return False
    if parts == ['sleep', '12']:
        return True
    # Native Codex wraps its fixed command in the user's shell. No arbitrary
    # shell syntax, environment prefix or additional command is authorized.
    return (len(parts) == 3 and Path(parts[0]).name in {'zsh', 'bash', 'sh'}
        and parts[1] in {'-c', '-lc'} and parts[2] == SLEEP)


def handle_approvals(state, attempt, current):
    for request in current.get('pending', []):
        if request.get('stale'):
            continue
        if request['id'] in attempt.setdefault('approvedRequests', []):
            continue
        params = request['params']
        assert request['agentId'] == attempt['agentId'], 'Approval Agent mismatch'
        assert params.get('turnId') == attempt['originalTurnId'], 'Approval Turn mismatch'
        assert not attempt['approvedRequests'], 'Only one fixed sleep approval is authorized per experiment'
        if request['method'] == 'claude/canUseTool':
            assert params.get('toolName') == 'Bash' and params.get('input', {}).get('command') == SLEEP, \
                'Unknown Claude approval; no automatic answer'
            assert params['input'].get('run_in_background') is not True
            response = {'decision': 'allow'}
        else:
            assert request['method'] == 'item/commandExecution/requestApproval', \
                'Unknown Codex approval; no automatic answer'
            assert exact_sleep(params.get('command')), 'Only the exact sleep command may be approved'
            assert not params.get('networkApprovalContext') and not params.get('additionalPermissions'), \
                'Unexpected permission expansion'
            if params.get('cwd'):
                assert Path(params['cwd']).resolve() == Path(attempt['cwd']).resolve()
            response = {'decision': 'accept'}
        # This grants only this one native request. No remembered rule or session
        # permission is sent, and an unknown question is never answered here.
        api('/requests/' + request['id'] + '/respond', {'response': response})
        attempt['approvedRequests'].append(request['id'])
        note(state, 'approved-fixed-sleep-once', harness=attempt['harness'], requestId=request['id'])


def wait(state, attempt, predicate, label, seconds=180):
    deadline, last_notice = time.monotonic() + seconds, time.monotonic()
    while time.monotonic() < deadline:
        current = detail(attempt)
        if attempt.get('originalTurnId'):
            handle_approvals(state, attempt, current)
        elif current.get('pending'):
            raise RuntimeError('Unexpected approval before the original task')
        if current['agent']['status'] in {'error', 'uncertain'} and current['agent'].get('error'):
            raise RuntimeError(current['agent']['error'])
        value = predicate(current)
        if value:
            return value
        if time.monotonic() - last_notice > 20:
            print('Waiting:', attempt['harness'], label, flush=True)
            last_notice = time.monotonic()
        time.sleep(0.35)
    raise TimeoutError(attempt['harness'] + ': ' + label)


def is_ready(current):
    return current if (current['agent']['status'] == 'idle'
        and current['agent']['connectionState'] == 'connected' and not current.get('pending')) else None


def sleep_item(current, turn_id):
    for turn in current['turns']:
        if turn['id'] != turn_id or turn['status'] != 'inProgress':
            continue
        for item in turn.get('items', []):
            command = item.get('command') if item.get('type') == 'commandExecution' else None
            if item.get('type') == 'claudeToolUse' and item.get('name') == 'Bash':
                command = item.get('input', {}).get('command')
            if item.get('status') == 'inProgress' and exact_sleep(command):
                return item
    return None


def reads(current):
    found = []
    for turn in current['turns']:
        for item in turn.get('items', []):
            arguments = None
            if item.get('type') == 'mcpToolCall' and item.get('server') == 'yuzuno' and item.get('tool') == 'peer_read':
                arguments = item.get('arguments')
            elif item.get('type') == 'claudeToolUse' and item.get('name') == 'mcp__yuzuno__peer_read':
                arguments = item.get('input')
            if arguments is not None:
                if isinstance(arguments, str):
                    arguments = json.loads(arguments)
                found.append({'turnId': turn['id'], 'itemId': item['id'],
                    'status': item.get('status'), 'arguments': arguments})
    return found


def mailbox(attempt):
    # GUI reads are inspection only: they never create the Agent's firstReadAt.
    return {message['priority']: message for message in call('peer_read',
        agentId=attempt['agentId'], afterSeq=0, limit=100)['messages']
        if message['id'] in attempt.get('messageIds', {}).values()}


def timestamp(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def close_owned(state, attempt):
    if not attempt.get('agentId'):
        return
    current = detail(attempt)
    if current['agent'].get('closedAt'):
        return
    if any(turn.get('status') == 'inProgress' for turn in current['turns']):
        # Cleanup may stop this experiment's own incomplete turn; delivery never
        # uses interrupt as a way of making a message appear immediate.
        api('/agents/' + attempt['agentId'] + '/interrupt', {})
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            current = detail(attempt)
            if not any(turn.get('status') == 'inProgress' for turn in current['turns']):
                break
            time.sleep(0.5)
    api('/agents/' + attempt['agentId'] + '/close', {})
    current = detail(attempt)
    assert current['agent'].get('closedAt'), 'Owned Agent did not close'
    attempt['closedAt'] = current['agent']['closedAt']
    note(state, 'closed-owned-agent', harness=attempt['harness'], agentId=attempt['agentId'])


def one_harness(state, harness, model):
    token = uuid.uuid4().hex[:12]
    attempt = {'harness': harness, 'model': model, 'cwd': state['cwd'], 'checks': [],
        'markers': {'normal': 'NORMAL-' + token, 'urgent': 'URGENT-' + token}, 'messageIds': {}}
    state['attempts'].append(attempt)
    save(state)
    agent = api('/agents', {'name': f'Priority · {harness} · {token[:4]}',
        'harness': harness, 'model': model, 'cwd': state['cwd']})
    attempt['agentId'] = agent['id']
    note(state, 'created-owned-agent', harness=harness, agentId=agent['id'])
    try:
        wait(state, attempt, is_ready, 'native ready')
        prompt = (
            'This is an isolated priority-delivery acceptance task. Your working directory is disposable. '
            f'Run exactly one foreground shell command `{SLEEP}` now, with timeout at least 20000 ms '
            'and yield_time_ms=20000 if your shell tool supports it. Never background it. '
            'Do not change files, start services, change settings, or run any other shell command. '
            'Do not proactively poll the mailbox: only follow an actual Yuzuno Core mailbox notification if one arrives. '
            'Respect its priority filter, so an urgent notice never reads ordinary mail. '
            'If a notice arrives during this work, handle its linked message with the requested Yuzuno MCP comment '
            'at the next native opportunity, then complete this original task. '
            'Do not create tasks, send peer replies, or change task status. '
            'Finish with ORIGINAL-DONE after the sleep and any actual urgent notice have been handled.'
        )
        response = api('/agents/' + agent['id'] + '/turns', {'text': prompt})
        attempt['originalTurnId'] = response['turnId']
        save(state)
        slow = wait(state, attempt, lambda current: sleep_item(current, attempt['originalTurnId']),
            'foreground sleep entered native execution')
        note(state, 'original-slow-tool-running', harness=harness, turnId=attempt['originalTurnId'], item=slow)
        for priority in ('normal', 'urgent'):
            marker = attempt['markers'][priority]
            body = (
                f'Priority acceptance message {marker}. Read task {state["taskId"]} with task_get, '
                f'then add exactly one task_comment on that SAME task with requestId "comment-{marker}" '
                f'and body "{marker}: mailbox fetched and checked by {harness}." '
                'Do not create any task, change task status, send a peer reply, or run a shell command. '
                'Do not fetch any other priority class. After this comment, continue/finish the current work.'
            )
            message = call('peer_send', toAgentId=agent['id'], taskId=state['taskId'],
                priority=priority, body=body)['message']
            attempt['messageIds'][priority] = message['id']
            attempt.setdefault('sentAt', {})[priority] = time.time()
            save(state)
        note(state, 'sent-normal-then-urgent-while-working', harness=harness, messages=mailbox(attempt))

        def observe(current):
            original = next(turn for turn in current['turns'] if turn['id'] == attempt['originalTurnId'])
            mail = mailbox(attempt)
            assert set(mail) == {'normal', 'urgent'}
            signature = [original['status']] + [
                [mail[p]['delivery']['state'], mail[p].get('firstReadAt')] for p in ('normal', 'urgent')]
            if signature != attempt.get('lastSignature'):
                attempt['lastSignature'] = signature
                attempt.setdefault('timeline', []).append({'at': time.time(), 'originalStatus': original['status'],
                    'messages': mail, 'reads': reads(current)})
                save(state)
            if original['status'] == 'inProgress':
                assert mail['normal'].get('firstReadAt') is None, 'Ordinary mail was fetched during the original turn'
                assert mail['normal']['delivery']['state'] == 'pending', 'Ordinary mail rang during the original turn'
                if mail['urgent'].get('firstReadAt'):
                    attempt['urgentObservedDuringOriginalTurn'] = True
            elif 'originalCompletedObservedAt' not in attempt:
                assert original['status'] == 'completed', original
                attempt['originalCompletedObservedAt'] = time.time()
                save(state)
            if all(mail[p].get('firstReadAt') for p in ('normal', 'urgent')) and is_ready(current):
                return {'detail': current, 'messages': mail}
            return None

        outcome = wait(state, attempt, observe, 'urgent same-turn and normal next-turn processing', 300)
        attempt['detail'] = outcome['detail']
        attempt['messages'] = outcome['messages']
        attempt['reads'] = reads(outcome['detail'])
        task = call('task_get', taskId=state['taskId'], limit=100)
        comments = [activity for activity in task['activities'] if activity['kind'] == 'comment'
            and activity['actor']['id'] == agent['id']]
        assert len(comments) == 2, f'Expected exactly two useful comments: {comments}'
        by_priority = {priority: next(activity for activity in comments
            if attempt['markers'][priority] in activity.get('body', '')) for priority in ('normal', 'urgent')}
        urgent, normal = outcome['messages']['urgent'], outcome['messages']['normal']
        assert urgent['delivery']['state'] == 'delivered'
        assert urgent['delivery']['detail']['mode'] == ('hook' if harness == 'claude' else 'steer')
        assert urgent['delivery']['detail']['turnId'] == attempt['originalTurnId']
        assert by_priority['urgent']['source']['turnId'] == attempt['originalTurnId']
        normal_turn = by_priority['normal']['source']['turnId']
        assert normal_turn != attempt['originalTurnId']
        assert normal['delivery']['detail']['turnId'] == normal_turn
        assert normal['delivery']['detail']['mode'] == 'start'
        assert timestamp(urgent['firstReadAt']) <= timestamp(normal['firstReadAt'])
        assert attempt.get('urgentObservedDuringOriginalTurn'), 'No observed snapshot of urgent read while original turn active'
        assert len(outcome['detail']['turns']) == 2, 'Unexpected extra turn / receipt-only loop'
        session = (outcome['detail']['agent'].get('threadId')
            or outcome['detail']['agent'].get('claudeSessionId'))
        assert session and all(comment['source'].get('sessionId') == session for comment in by_priority.values()), \
            'Native session changed between priority classes'
        original = next(turn for turn in outcome['detail']['turns'] if turn['id'] == attempt['originalTurnId'])
        completed_sleep = next(item for item in original['items'] if item['id'] == slow['id'])
        assert completed_sleep['status'] == 'completed' and not original.get('interruptRequested'), \
            'Original tool did not finish naturally'
        if harness == 'codex':
            assert completed_sleep['exitCode'] == 0 and completed_sleep['durationMs'] >= 8_000
        for priority, turn_id in [('urgent', attempt['originalTurnId']), ('normal', normal_turn)]:
            native_reads = [read for read in attempt['reads'] if read['turnId'] == turn_id]
            assert native_reads and all(read['arguments'].get('priority') == priority for read in native_reads), native_reads
            assert any(read['status'] == 'completed' for read in native_reads), native_reads
        assert task['task']['status'] == state['taskStatus'] and task['task']['version'] == state['taskVersion'], \
            'Execution changed task semantics'
        assert set(tasks()) == set(state['baselineTasks']) | {state['taskId']}, 'Execution created extra task cards'
        attempt['comments'] = by_priority
        attempt['checks'] = ['urgent notice delivered inside the original native turn',
            'peer_read retained actual urgent/normal filters', 'normal remained pending and unfetched during original turn',
            'normal read in exactly one later turn', 'same task card and native comment sources; no status auto-completion']
        note(state, 'harness-priority-passed', harness=harness, originalTurnId=attempt['originalTurnId'],
            normalTurnId=normal_turn, checks=attempt['checks'])
    except BaseException as error:
        attempt['failure'] = f'{type(error).__name__}: {error}'
        try:
            attempt['detail'] = detail(attempt)
            attempt['messages'] = mailbox(attempt)
        except Exception as diagnostic_error:
            attempt['diagnosticError'] = str(diagnostic_error)
        save(state)
        raise
    finally:
        close_owned(state, attempt)


def run():
    assert not STATE.exists(), 'Preserve prior evidence; no automatic replay or replacement of this experiment'
    core_pid = ensure_lab()
    baseline_agents = api('/workspace')['agents']
    assert all(agent.get('closedAt') for agent in baseline_agents), 'Existing lab Agent is live; do not overlap native tests'
    state = {'kind': 'real priority delivery, no mock Harness', 'corePid': core_pid,
        'cwd': tempfile.mkdtemp(prefix='yuzuno-next-priority-'), 'attempts': [],
        'baselineTasks': tasks(), 'baselineAgents': baseline_agents}
    save(state)
    task = call('task_create', title='验证普通消息等待与紧急消息运行中投递',
        description='同一目标卡片，Codex 与 Claude 顺序验收；原始 Turn 取 urgent，后续 Turn 取 normal。')['task']
    state.update(taskId=task['id'], taskStatus=task['status'], taskVersion=task['version'])
    note(state, 'created-owned-priority-task', taskId=task['id'], cwd=state['cwd'])
    for harness, model in [('codex', 'gpt-6.1-sol'), ('claude', 'haiku')]:
        one_harness(state, harness, model)
    current_tasks = tasks()
    assert {key: value for key, value in current_tasks.items() if key != state['taskId']} == state['baselineTasks'], \
        'A prior task was modified'
    agents = {agent['id']: agent for agent in api('/workspace')['agents']}
    assert all(agents[old['id']] == old for old in state['baselineAgents']), 'A prior Agent was modified'
    current = call('task_get', taskId=state['taskId'])['task']
    call('task_update', taskId=state['taskId'], expectedVersion=current['version'], patch={'archived': True})
    state['task'] = call('task_get', taskId=state['taskId'], limit=100)
    note(state, 'all-priority-checks-passed-task-archived', agents=[a['agentId'] for a in state['attempts']])


def cleanup():
    ensure_lab()
    state = json.loads(STATE.read_text())
    for attempt in state['attempts']:
        close_owned(state, attempt)


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in {'run', 'cleanup'}:
        raise SystemExit('usage: priority-check.py run|cleanup')
    {'run': run, 'cleanup': cleanup}[sys.argv[1]]()
