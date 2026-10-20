#!/usr/bin/env python3
"""Real Codex + Claude update-pause acceptance in a fresh managed installation.

Run as a bounded Yuzuno Job through target/heavy-slot.sh, using prebuilt complete
bundles. Never changes daily Core, windows, native settings, or approvals. Only
the disposable Agents and exact processes created by this run are cleaned up.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid


def identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z':
            return None
        return {'pid': pid, 'startTicks': int(fields[19]),
                'executable': str(Path(f'/proc/{pid}/exe').readlink())}
    except (FileNotFoundError, ProcessLookupError):
        return None


def until(check, seconds=120):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (ConnectionError, urllib.error.URLError) as error:
            last = error
        time.sleep(.3)
    raise AssertionError(f'Acceptance condition timed out; last transport error: {last}')


def main(args):
    root = args.run_dir.resolve()
    project = (Path.home() / 'yuzuno-next').resolve()
    assert root.is_relative_to(project / 'target') and not root.exists()
    assert 4400 <= args.port <= 4999
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', args.port))
    root.mkdir(mode=0o700)
    managed, data, work = (root / name for name in ('managed', 'data', 'work'))
    work.mkdir()
    assert len(str(managed / 'updates/control.sock').encode()) < 104
    (work / 'AGENTS.md').write_text(
        'Disposable T62 acceptance. Use only the explicitly requested Yuzuno task and mailbox tools. '
        'No shell, file changes, new Agents/tasks, peer_send, unrelated tools, permission changes or approvals. '
        'Do not poll or sleep. Honor valid Core update control at native opportunities, save on the existing task and end the original Turn.\n')
    bundles = []
    for path in (args.a, args.b):
        path = path.resolve(strict=True)
        content = (path / 'manifest.json').read_bytes()
        bundles.append((path, json.loads(content), hashlib.sha256(content).hexdigest()))
    helper = bundles[0][0] / 'bin/yuzuno-update-helper'
    receipt = {'passed': False, 'mode': 'real-native-Codex-and-Claude-managed-update',
               'root': str(root), 'port': args.port, 'agents': [], 'checks': [], 'cleanup': []}
    owned = []
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def save():
        (root / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')

    def api(path, body=None, timeout=20):
        req = urllib.request.Request(f'http://127.0.0.1:{args.port}/api{path}',
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
        with opener.open(req, timeout=timeout) as response:
            return json.load(response)

    def call(operation, **kwargs):
        return api('/collaboration/' + operation, kwargs)

    def detail(agent_id):
        d = api('/agents/' + agent_id)
        assert not any(not p.get('stale') for p in d['pending']), 'Native approval requires inspection; never auto-approved'
        assert not (d['agent']['status'] in ('error', 'uncertain') and d['agent'].get('error')), d['agent'].get('error')
        return d

    def ready(agent_id):
        d = detail(agent_id)
        return d if d['agent']['status'] == 'idle' and d['agent']['connectionState'] == 'connected' and d.get('collaboration', {}).get('ready') else None

    def capture_processes():
        path = managed / 'updates/state.json'
        if path.exists():
            op = json.loads(path.read_text()).get('operation') or {}
            for key in ('oldProcess', 'newProcess', 'helperProcess'):
                process = op.get(key)
                if process and process not in owned:
                    assert Path(process['executable']).is_relative_to(managed / 'releases')
                    owned.append(process)

    child = None
    try:
        for index, (path, info, digest) in enumerate(bundles):
            command = [str(helper), 'register', '--install-dir', str(managed), '--bundle', str(path),
                       '--manifest-sha256', digest, '--reviewed-source', 'isolated T62 acceptance candidate']
            if index == 0:
                command.append('--initialize')
            subprocess.run(command, check=True, timeout=90)
            receipt.setdefault('bundles', []).append({'releaseId': info['releaseId'], 'gitSha': info['gitSha'], 'manifestSha256': digest})
        executable = managed / 'releases' / bundles[0][1]['releaseId'] / 'bin/yuzuno-workspace'
        with (root / 'core.log').open('wb') as log:
            child = subprocess.Popen([str(executable), '--install-dir', str(managed), '--data-dir', str(data),
                '--port', str(args.port), '--cwd', str(work), '--codex', str(args.codex.resolve(strict=True))],
                cwd=work, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        owned.append(until(lambda: identity(child.pid), 5))
        health = until(lambda: api('/health'))
        receipt['workspaceId'] = health['workspaceId']
        target = bundles[1][1]['releaseId']
        api('/updates/check', {}, 90)
        api('/updates/prepare', {'releaseId': target}, 90)
        prepared = until(lambda: (s if (s := api('/updates')).get('operation', {}).get('phase') in ('prepared', 'failed') else None), 90)
        assert prepared['operation']['phase'] == 'prepared', prepared
        for harness in ('codex', 'claude'):
            payload = {'name': f'T62 isolated {harness}', 'harness': harness, 'cwd': str(work)}
            if harness == 'codex':
                payload['model'] = 'gpt-6.1-sol'
            agent = api('/agents', payload)
            row = {'id': agent['id'], 'harness': harness}
            receipt['agents'].append(row)
            save()
            until(lambda: ready(agent['id']))
            api(f'/agents/{agent["id"]}/turns', {'text': 'Do not use tools. Reply only: update-pause-fixture-ready'})
            warm = until(lambda: (d if (d := ready(agent['id'])) and d['turns'] else None), 180)
            assert any('update-pause-fixture-ready' in item.get('text', '') for turn in warm['turns'] for item in turn.get('items', []) if item.get('type') == 'agentMessage')
            row['sessionId'] = warm['agent']['threadId' if harness == 'codex' else 'claudeSessionId']
            row['settings'] = warm['agent']['settings']
            task = call('task_create', requestId=f'create-{harness}', title=f'T62 {harness} arithmetic checkpoint fixture', status='doing', assigneeAgentId=agent['id'])['task']
            row['taskId'] = task['id']
        for row in receipt['agents']:
            prompt = (
                f'On existing task {row["taskId"]}, verify a bounded arithmetic sequence: for n=11 through 30, calculate n*(n+7). '
                'First task_get. For each value, calculate it and save one task_comment with that value before proceeding to the next. Do at most these 20 values; no polling or sleeping. '
                'While doing this, honor a Core update control reminder at the next native opportunity by fetching exactly its indicated mailbox message. '
                'Only if updateWait.active is true: stop starting further arithmetic, read this same task, and task_update its progress to '
                '"Saved for update <operationId>; remaining arithmetic stays on this task", substituting the actual operationId. Keep status doing, then finish this Turn with "Yielded for update". '
                'If no valid pause arrives, finish the finite arithmetic normally. No task creation, peer_send, shell, files, permission changes, approvals or unrelated tools.')
            api(f'/agents/{row["id"]}/turns', {'text': prompt})
        for row in receipt['agents']:
            active = until(lambda: next((t for t in detail(row['id'])['turns'] if t['status'] == 'inProgress'), None), 30)
            row['turnId'] = active['id']
        payload = {'releaseId': target, 'requestId': str(uuid.uuid4())}
        accepted = api('/updates/apply', payload, 90)
        operation = accepted['operationId']
        receipt['operationId'] = operation
        capture_processes()
        waiting = api('/updates')
        receipt['initialWait'] = waiting
        assert waiting['operation']['phase'] == 'waiting' and not waiting['acceptingWork'], waiting
        assert len(waiting['waitNotices']) == 2, waiting
        assert api('/updates/apply', payload)['operationId'] == operation
        try:
            api(f'/agents/{receipt["agents"][0]["id"]}/messages', {'clientMessageId': str(uuid.uuid4()), 'text': 'must not start while draining'})
            raise AssertionError('New work crossed the update fence')
        except urllib.error.HTTPError as error:
            assert 'workspace_updating:' in error.read().decode()
        receipt['checks'].append('both native Turns active; two original recipients; duplicate Apply stable; new work fenced')
        save()

        def completed():
            s = api('/updates')
            if s.get('operation', {}).get('phase') == 'waiting':
                for row in receipt['agents']:
                    detail(row['id'])  # Fail clearly on approval/native failure.
            return s if s.get('operation', {}).get('phase') in ('complete', 'failed', 'rolledBack', 'cancelled') else None

        final = until(completed, 300)
        receipt['finalUpdate'] = final
        capture_processes()
        assert final['operation']['phase'] == 'complete', final
        assert api('/health')['workspaceId'] == receipt['workspaceId']
        assert api('/health')['releaseId'] == target and final['acceptingWork']
        messages = call('peer_read', priority='urgent', limit=50)['messages']
        assert len(messages) == 2, 'Expected one logical update notice per original Agent'
        receipt['messages'] = messages
        for row in receipt['agents']:
            after = until(lambda: ready(row['id']), 90)
            assert len(after['turns']) == 2, 'Pause control or replacement Core started an extra Turn'
            original = next(t for t in after['turns'] if t['id'] == row['turnId'])
            assert original['status'] != 'inProgress'
            assert any('Yielded for update' in i.get('text', '') for i in original.get('items', []) if i.get('type') == 'agentMessage')
            assert after['agent']['threadId' if row['harness'] == 'codex' else 'claudeSessionId'] == row['sessionId']
            assert after['agent']['settings'] == row['settings']
            task = call('task_get', taskId=row['taskId'])
            assert task['task']['status'] == 'doing' and operation in task['task']['progress']
            assert any(a['actor']['id'] == row['id'] and a.get('source', {}).get('turnId') == row['turnId'] and operation in a.get('changes', {}).get('progress', '') for a in task['activities'])
            mail = next(m for m in messages if m['recipient']['id'] == row['id'])
            assert mail['metadata']['operationId'] == operation and mail['metadata']['turnId'] == row['turnId']
            assert mail['metadata']['sessionId'] == row['sessionId'] and mail['firstReadAt']
            assert mail['sender']['kind'] == 'system' and mail['delivery']['state'] == 'delivered'
            assert mail['delivery']['detail']['mode'] == ('steer' if row['harness'] == 'codex' else 'hook')
            assert mail['updateWait']['active'] is False, 'Completed update notice must be inert'
            row['savedTask'] = task
            row['finalAgent'] = after['agent']
        assert len(call('task_list')['tasks']) == 2
        receipt['checks'].extend(['real Codex steer and Claude native hook each fetched one original-Turn control notice',
            'both native Agents saved progress on their existing tasks and yielded without marking tasks complete',
            'actual managed Core/helper switch completed and preserved native identities/settings/history',
            'completion makes late notice reads inert; restored Agents stay idle with no replay or extra Turn'])
        receipt['passed'] = True
    except BaseException as error:
        receipt['error'] = str(error)
        raise
    finally:
        try:
            capture_processes()
            state = api('/updates')
            if state.get('operation', {}).get('phase') == 'waiting':
                api('/updates/cancel', {'operationId': state['operation']['id']})
            # Disposable test work only. Cleanup is never acceptance evidence.
            for row in receipt['agents']:
                try:
                    d = api('/agents/' + row['id'])
                    if d['agent']['status'] in ('working', 'waiting'):
                        api('/agents/' + row['id'] + '/interrupt', {})
                        receipt['cleanup'].append({'agentId': row['id'], 'interruptedFixtureAfterFailure': True})
                    api('/agents/' + row['id'] + '/close', {})
                except Exception as error:
                    receipt['cleanup'].append({'agentId': row['id'], 'error': str(error)})
        except Exception as error:
            receipt['cleanup'].append({'error': str(error)})
        for process in reversed(owned):
            if identity(process['pid']) == process:
                os.kill(process['pid'], signal.SIGINT)
                try:
                    until(lambda: identity(process['pid']) != process, 15)
                except AssertionError:
                    receipt['cleanup'].append({'pid': process['pid'], 'error': 'graceful shutdown unconfirmed'})
        if child:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                receipt['cleanup'].append({'pid': child.pid, 'error': 'original child still active'})
        receipt['ownedProcessesStopped'] = all(identity(p['pid']) != p for p in owned)
        save()
        print(json.dumps({k: receipt[k] for k in ('passed', 'checks', 'cleanup', 'ownedProcessesStopped')}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--a', type=Path, required=True)
    parser.add_argument('--b', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--codex', type=Path, required=True)
    parser.add_argument('--port', type=int, default=4504)
    main(parser.parse_args())
