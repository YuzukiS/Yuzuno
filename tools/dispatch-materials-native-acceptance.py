#!/usr/bin/env python3
"""One real Codex repair from an empty-body dispatch, in a fresh isolated Core.

Run in a bounded Yuzuno Job. Native progress is observed through SSE, not status
polling. Pending approvals fail the check; permissions are never changed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import socket
import subprocess
import threading
import time
import urllib.request


def main(args):
    source = Path(__file__).resolve().parent.parent
    root = args.run_dir.resolve()
    assert root.is_relative_to(source / 'target') and not root.exists()
    assert 4400 <= args.port <= 4999
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', args.port))
    root.mkdir(parents=True)
    work = root / 'work'
    work.mkdir()
    (work / 'AGENTS.md').write_text(
        'Isolated Yuzuno dispatch-materials acceptance. Work only in this directory on the assigned existing task. '
        'Do not modify tests, install dependencies, use network, create extra tasks/Agents, change permissions, '
        'accept approval prompts, or contact other Agents. No commit or push is needed.\n')
    (work / '.gitignore').write_text('__pycache__/\n')
    (work / 'line_reference.py').write_text('''def parse_reference(value):
    if ":" in value:
        path, suffix = value.rsplit(":", 1)
        if suffix.isdecimal():
            line = int(suffix)
            if line < 1:
                raise ValueError("Line numbers start at 1")
            return path, line
    return value, None
''')
    (work / 'test_line_reference.py').write_text('''import unittest
from line_reference import parse_reference


class ReferenceTests(unittest.TestCase):
    def test_colon(self):
        self.assertEqual(parse_reference("web/src/App.tsx:42"), ("web/src/App.tsx", 42))

    def test_hash_line(self):
        self.assertEqual(parse_reference("web/src/App.tsx#L42"), ("web/src/App.tsx", 42))

    def test_plain_and_other_fragments(self):
        for value in ["README.md", "docs/guide.md#intro", "src/file:note", "src/file#Lx"]:
            self.assertEqual(parse_reference(value), (value, None))

    def test_unicode_path(self):
        self.assertEqual(parse_reference("文档/说明.md#L3"), ("文档/说明.md", 3))

    def test_zero_rejected(self):
        for value in ["src/file:0", "src/file#L0"]:
            with self.assertRaises(ValueError):
                parse_reference(value)


if __name__ == "__main__":
    unittest.main()
''')

    def command(argv):
        return subprocess.run(argv, cwd=work, capture_output=True, text=True, timeout=30)

    for argv in [['git', 'init', '-q'], ['git', 'add', '.'],
                 ['git', '-c', 'user.name=Yuzuno Acceptance', '-c', 'user.email=acceptance@example.invalid',
                  'commit', '-qm', 'Fixture baseline']]:
        result = command(argv)
        assert result.returncode == 0, result.stderr
    baseline = command(['git', 'rev-parse', 'HEAD']).stdout.strip()
    before = command(['python3', '-m', 'unittest', '-v'])
    (root / 'before-tests.log').write_text(before.stdout + before.stderr)
    assert before.returncode != 0 and 'FAILED (failures=3)' in before.stderr, 'Fixture must reproduce only the missing #L support'
    receipt = {'passed': False, 'mode': 'real-native-Codex-empty-body-development',
               'root': str(root), 'port': args.port, 'baseline': baseline, 'agentId': None,
               'coreSha256': hashlib.sha256(args.core.read_bytes()).hexdigest(),
               'checks': [], 'cleanupErrors': []}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    events = queue.Queue(maxsize=2048)
    stop = threading.Event()

    def save():
        (root / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')

    def api(path, body=None, timeout=30):
        request = urllib.request.Request(f'http://127.0.0.1:{args.port}/api{path}',
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
        with opener.open(request, timeout=timeout) as response:
            return json.load(response)

    def call(operation, **kwargs):
        return api('/collaboration/' + operation, kwargs)

    def pump(stream):
        try:
            lines = []
            for raw in stream:
                if stop.is_set():
                    return
                line = raw.decode().rstrip('\r\n')
                if line.startswith('data:'):
                    lines.append(line[5:].lstrip())
                elif not line and lines:
                    event = json.loads('\n'.join(lines))
                    lines = []
                    if event.get('type') in ('reset', 'agent.changed') or event.get('collaboration'):
                        events.put_nowait(event)
            events.put_nowait({'error': 'SSE ended before acceptance completed'})
        except Exception as error:
            events.put({'error': str(error)}, timeout=1)

    def changed_until(check, seconds):
        deadline = time.monotonic() + seconds
        while True:
            value = check()
            if value:
                return value
            event = events.get(timeout=max(.001, deadline - time.monotonic()))
            assert 'error' not in event, event
            while True:
                try:
                    event = events.get_nowait()
                    assert 'error' not in event, event
                except queue.Empty:
                    break
            assert time.monotonic() < deadline, 'Acceptance event deadline exceeded'

    def detail_ready():
        detail = api('/agents/' + receipt['agentId'])
        if any(not pending.get('stale') for pending in detail['pending']):
            raise AssertionError('Pending native approval; no automatic approval')
        agent = detail['agent']
        if agent['status'] in ('error', 'uncertain') and agent.get('error'):
            raise AssertionError('Native Agent failed: ' + str(agent['error']))
        return detail if agent['status'] == 'idle' and agent['connectionState'] == 'connected' else None

    core = stream = None
    try:
        with (root / 'core.log').open('wb') as log:
            core = subprocess.Popen([str(args.core.resolve(strict=True)), '--port', str(args.port),
                '--data-dir', str(root / 'data'), '--cwd', str(work), '--web-dir', str(root / 'no-ui'),
                '--codex', str(args.codex.resolve(strict=True))], cwd=work, stdin=subprocess.DEVNULL,
                stdout=log, stderr=log, start_new_session=True)
        receipt['corePid'] = core.pid
        # Bounded startup barrier only; native execution below is event-driven.
        for _ in range(100):
            assert core.poll() is None, 'Core exited during startup'
            try:
                receipt['health'] = api('/health', timeout=1)
                break
            except OSError:
                time.sleep(.1)
        else:
            raise AssertionError('Core did not bind within 10 seconds')
        stream = opener.open(f'http://127.0.0.1:{args.port}/api/events', timeout=45)
        threading.Thread(target=pump, args=(stream,), daemon=True).start()
        agent = api('/agents', {'name': 'T59 isolated executor', 'harness': 'codex',
                              'model': 'gpt-6.1-sol', 'cwd': str(work)})
        receipt['agentId'] = agent['id']
        save()
        ready = changed_until(detail_ready, 90)
        receipt['initialSettings'] = ready['agent']['settings']
        task = call('task_create', requestId='native-create', title='Support #L file references in the parser',
                    description='Fix line_reference.py so file references using :42 and #L42 both return the path and line. Preserve ordinary file references and existing validation.')['task']
        task_id = receipt['taskId'] = task['id']
        decision = call('task_comment', requestId='native-decision', taskId=task_id,
                        body='Decision: only a trailing :<decimal> or #L<decimal> denotes a line. Other suffixes/fragments remain part of the path. Zero is invalid. Preserve Unicode paths.')['activity']
        materials = {'acceptance': 'All five existing unittest cases pass with python3 -m unittest -v. Change only line_reference.py; do not edit tests.',
                     'baseline': 'Local acceptance repository initial commit ' + baseline, 'worktree': str(work),
                     'references': [{'kind': 'decision', 'label': 'Reference syntax decision',
                                     'taskId': task_id, 'activitySeq': decision['seq']}],
                     'returnRequirements': 'Read the original fixed dispatch materials using the received dispatchId and open the registered decision reference. After fixing and testing, submit the outcome on this task with the original dispatchId, status review, and report the tests and the fixed material task version. Do not create a new task or send peer messages.'}
        task = call('task_get', taskId=task_id)['task']
        task = call('task_update', requestId='native-materials', taskId=task_id,
                    expectedVersion=task['version'], patch={'materials': materials})['task']
        sent = call('task_dispatch', requestId='native-empty-dispatch', taskId=task_id,
                    expectedVersion=task['version'], toAgentId=agent['id'], body='')
        dispatch_id = receipt['dispatchId'] = sent['message']['dispatchId']
        fixed = call('task_get', taskId=task_id, dispatchId=dispatch_id)['dispatchMaterials']
        assert fixed['supplement'] == '' and fixed['effective'] == materials
        assert fixed['returnTo'] is None, 'GUI dispatch has no invented Agent result recipient'
        call('task_update', requestId='native-later-progress', taskId=task_id,
             expectedVersion=sent['task']['version'], patch={'progress': 'Awaiting execution of the original fixed dispatch.'})
        save()

        def completed():
            ready = detail_ready()
            current = call('task_get', taskId=task_id)
            return (ready, current) if ready and current['task'].get('result') else None

        ready, current = changed_until(completed, 300)
        result = current['task']['result']
        assert result['dispatchId'] == dispatch_id and result['reportedBy']['id'] == agent['id']
        assert current['task']['status'] == 'review' and len(call('task_list')['tasks']) == 1
        assert ready['agent']['settings'] == receipt['initialSettings'], 'Permissions/settings changed'
        assert len(ready['turns']) == 1, 'Expected one mail-started turn without a copied user prompt'
        messages = call('peer_read')['messages']
        assert len(messages) == 1 and messages[0]['dispatchId'] == dispatch_id and messages[0]['firstReadAt']
        calls = [{'tool': item.get('tool'), 'arguments': item.get('arguments')}
                 for turn in ready['turns'] for item in turn.get('items', [])
                 if item.get('type') == 'mcpToolCall']
        (root / 'tool-calls.json').write_text(json.dumps(calls, ensure_ascii=False, indent=2) + '\n')
        (root / 'task-after.json').write_text(json.dumps(current, ensure_ascii=False, indent=2) + '\n')
        assert any(c['tool'] == 'task_get' and isinstance(c['arguments'], dict)
                   and c['arguments'].get('dispatchId') == dispatch_id for c in calls), 'Executor did not read the fixed materials'
        assert any(c['tool'] == 'task_get' and isinstance(c['arguments'], dict)
                   and c['arguments'].get('taskId') == task_id
                   and not c['arguments'].get('dispatchId')
                   and c['arguments'].get('afterSeq', 0) < decision['seq']
                   and c['arguments'].get('limit', 50) >= decision['seq'] - c['arguments'].get('afterSeq', 0)
                   for c in calls), 'Executor did not open the decision reference'
        assert call('task_get', taskId=task_id, dispatchId=dispatch_id)['dispatchMaterials'] == fixed
        after = command(['python3', '-m', 'unittest', '-v'])
        (root / 'after-tests.log').write_text(after.stdout + after.stderr)
        assert after.returncode == 0, 'Independent check of the actual repair failed'
        changed = command(['git', 'status', '--porcelain']).stdout.strip()
        assert changed == 'M line_reference.py', changed
        diff = command(['git', 'diff', '--', 'line_reference.py']).stdout
        (root / 'repair.diff').write_text(diff)
        receipt.update(passed=True, fixedMaterials=fixed, result=result, mcpCalls=calls,
                       finalSettings=ready['agent']['settings'], turnId=ready['turns'][0]['id'],
                       checks=['empty body started one real native development turn',
                               'executor read fixed materials and opened the decision reference',
                               'parser repaired; five independent unchanged tests pass',
                               'later progress did not change original material snapshot',
                               'same task and dispatch; review submission retains original executor',
                               'permissions unchanged; no peer messages or extra tasks'])
    except BaseException as error:
        receipt['error'] = str(error)
        raise
    finally:
        stop.set()
        if core:
            if receipt['agentId']:
                try:
                    detail = api('/agents/' + receipt['agentId'])
                    if detail['agent']['status'] == 'working':
                        api('/agents/' + receipt['agentId'] + '/interrupt', {})
                    api('/agents/' + receipt['agentId'] + '/close', {})
                except Exception as error:
                    receipt['cleanupErrors'].append(str(error))
            try:
                os.killpg(core.pid, signal.SIGINT)
                core.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(core.pid, signal.SIGKILL)
                core.wait(timeout=10)
            except ProcessLookupError:
                pass
            try:
                os.killpg(core.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            receipt['ownedCoreStopped'] = core.poll() is not None
            receipt['coreExit'] = core.returncode
        save()
        print(json.dumps({k: receipt[k] for k in ['passed', 'mode', 'checks', 'cleanupErrors']}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--core', type=Path, required=True)
    parser.add_argument('--codex', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=4506)
    main(parser.parse_args())
