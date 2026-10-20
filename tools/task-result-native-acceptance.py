#!/usr/bin/env python3
"""Bounded two-native-Agent T58 acceptance, only in a fresh target directory.

Run as a resource-limited Yuzuno Job with the root heavy-slot wrapper. No daily
Core, windows, credentials or global configuration are changed. Approval prompts
fail the acceptance; none are accepted automatically.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import urllib.error
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
    (work / 'AGENTS.md').write_text('Isolated Yuzuno T58 acceptance. Use only the explicitly requested Yuzuno MCP operations. No shell, file changes, extra Agents, tasks, peer_send or unrelated tools. Never change permissions or auto-approve requests.\n')
    receipt = {'passed': False, 'mode': 'real-native-Codex-two-Agent', 'root': str(root),
               'port': args.port, 'agents': [], 'checks': [], 'cleanupErrors': []}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def save():
        (root / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')

    def api(path, body=None):
        request = urllib.request.Request(f'http://127.0.0.1:{args.port}/api{path}',
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
        with opener.open(request, timeout=30) as response:
            return json.load(response)

    def call(operation, **kwargs):
        return api('/collaboration/' + operation, kwargs)

    def until(check, seconds=120):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                value = check()
                if value:
                    return value
            except (ConnectionError, urllib.error.URLError):
                pass
            time.sleep(.5)
        raise AssertionError('Acceptance condition timed out')

    def ready(agent_id):
        detail = api('/agents/' + agent_id)
        if any(not pending.get('stale') for pending in detail['pending']):
            raise AssertionError('Native approval requires inspection; no automatic approval')
        # thread/createRequested temporarily reserves an uncertain identity
        # before native creation finishes; only a recorded error is terminal.
        if detail['agent']['status'] in ['error', 'uncertain'] and detail['agent'].get('error'):
            raise AssertionError('Native Agent failed: ' + str(detail['agent'].get('error')))
        return detail if detail['agent']['status'] == 'idle' and detail['agent']['connectionState'] == 'connected' else None

    core = None
    try:
        with (root / 'core.log').open('wb') as log:
            core = subprocess.Popen([str(args.core.resolve(strict=True)), '--port', str(args.port),
                '--data-dir', str(root / 'data'), '--cwd', str(work), '--web-dir', str(root / 'no-ui'),
                '--codex', str(args.codex.resolve(strict=True))], cwd=work, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        receipt['corePid'] = core.pid
        until(lambda: api('/health'))
        for name in ['T58 isolated lead', 'T58 isolated executor']:
            agent = api('/agents', {'name': name, 'harness': 'codex', 'model': 'gpt-6.1-sol', 'cwd': str(work)})
            receipt['agents'].append(agent['id'])
            save()
            until(lambda: ready(agent['id']))
        lead, dev = receipt['agents']
        task = call('task_create', requestId='native-create', title='Verify 17 times 19 through automatic result notification')['task']
        receipt['taskId'] = task['id']
        save()
        api('/agents/' + lead + '/turns', {'text':
            f'Isolated acceptance on task {task["id"]}. Use only Yuzuno MCP. Read task_get, then call task_dispatch exactly once to Agent {dev} on this same task. '
            'Its body must ask the executor to verify 17 × 19 = 323, then call task_submit_result with the dispatchId from that received dispatch message, status review, summary "17 × 19 = 323 verified", '
            'and evidence link https://example.test/t58-arithmetic labeled "Acceptance evidence". Use requestId "native-result" for that submission and retry that identical payload once to demonstrate idempotency. '
            'Tell it to finish after submission, with no peer_send. You also must not call peer_send. End your initial turn after dispatch. '
            'When the automatic system result notification arrives, read it using peer_read, verify its resultId and original author/source using task_get, '
            'then append exactly one task_comment on this same task with requestId "native-result-observed" and body "Automatic result received." Finish with no further messages, dispatches or submissions. '
            'No shell, file operations, new tasks or agents, unrelated tools, permissions changes or approval actions.'})

        def completed():
            for agent_id in receipt['agents']:
                ready(agent_id)
            detail = call('task_get', taskId=task['id'])
            if detail['task'].get('result') and any(a.get('body') == 'Automatic result received.' and a['actor']['id'] == lead for a in detail['activities']):
                return detail
            return None

        detail = until(completed, 240)
        for agent_id in receipt['agents']:
            until(lambda: ready(agent_id), 60)
        messages = call('peer_read')['messages']
        assert len(messages) == 2, 'Expected exactly dispatch + automatic result; no peer_send loop'
        sent = next(m for m in messages if m['recipient']['id'] == dev)
        result_mail = next(m for m in messages if m['recipient']['id'] == lead)
        result = detail['task']['result']
        assert result['dispatchId'] == sent['dispatchId'] and result_mail['dispatchId'] == sent['dispatchId']
        assert result_mail['resultId'] == result['id'] and result_mail['sender']['kind'] == 'system'
        assert result_mail['reportedBy']['id'] == result['reportedBy']['id'] == dev
        assert result_mail['source'] == result['source'] and result['source'].get('turnId') and result['source'].get('sessionId')
        assert result_mail['firstReadAt'] and result_mail['priority'] == 'normal'
        assert result['links'] == [{'label': 'Acceptance evidence', 'url': 'https://example.test/t58-arithmetic'}]
        assert detail['task']['status'] == 'review' and len(call('task_list')['tasks']) == 1
        assert len([a for a in detail['activities'] if a['kind'] == 'result']) == 1
        receipt.update(passed=True, task=detail, messages=messages,
            checks=['real native dispatch carries stable identity', 'executor result reaches original lead without peer_send',
                    'same task, one result activity and one automatic system notification', 'original author and native source retained',
                    'evidence links retained; review remains a submission, not approval', 'lead actually fetched and acknowledged result'])
    except BaseException as error:
        receipt['error'] = str(error)
        raise
    finally:
        if core:
            for agent_id in receipt['agents']:
                try:
                    detail = api('/agents/' + agent_id)
                    if detail['agent']['status'] == 'working':
                        api('/agents/' + agent_id + '/interrupt', {})
                    api('/agents/' + agent_id + '/close', {})
                except Exception as error:
                    receipt['cleanupErrors'].append(str(error))
            core.send_signal(signal.SIGINT)
            try:
                core.wait(timeout=20)
            except subprocess.TimeoutExpired:
                core.kill()
                core.wait(timeout=10)
            receipt['ownedCoreStopped'] = core.poll() is not None
        save()
        print(json.dumps({k: receipt[k] for k in ['passed', 'mode', 'checks', 'cleanupErrors']}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--core', type=Path, required=True)
    parser.add_argument('--codex', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=4502)
    main(parser.parse_args())
