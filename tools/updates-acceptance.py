#!/usr/bin/env python3
"""Run under target/heavy-slot.sh against isolated, prebuilt releases.

Uses prebuilt complete releases, a NEW on-disk directory and an isolated port.
Does not build, touch an existing installation or open/refresh any window.
Optional --native creates two disposable authenticated native sessions and sends
one no-tool prompt to each; omit it for the real Core/helper/storage smoke test.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
import uuid

PROJECT = (Path.home() / 'yuzuno-next').resolve()


def identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z':
            return None
        return {'pid': pid, 'startTicks': int(fields[19]),
                'executable': str(Path(f'/proc/{pid}/exe').readlink())}
    except (FileNotFoundError, ProcessLookupError):
        return None


def until(check, timeout=60):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            last = error
        time.sleep(0.2)
    raise AssertionError(f'Condition timed out; last transport error: {last}')


def manifest(bundle):
    path = bundle.resolve(strict=True)
    content = (path / 'manifest.json').read_bytes()
    return path, json.loads(content), hashlib.sha256(content).hexdigest()


def main(args):
    root = args.run_dir.resolve()
    assert root.is_relative_to(PROJECT / 'target'), 'Use a new directory under the project disk target/'
    assert not root.exists(), 'Refusing to reuse an installation or test data'
    assert 4300 <= args.port <= 4999 and args.port not in (4317, 4391), 'Use a dedicated non-daily port'
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', args.port))  # Never displace another listener.
    root.mkdir(mode=0o700)
    managed = root / 'managed'
    data = root / 'data'
    cwd = root / 'work'
    cwd.mkdir()
    assert len(str(managed / 'updates/control.sock').encode()) < 104, 'Use a shorter run directory'
    bundles = [manifest(args.a), manifest(args.b)]
    if args.failure_bundle:
        bundles.append(manifest(args.failure_bundle))
    helper = bundles[0][0] / 'bin/yuzuno-update-helper'
    receipt = {'port': args.port, 'root': str(root), 'checks': [], 'native': args.native, 'scripted': args.scripted}
    owned = []
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path, body=None, timeout=8):
        encoded = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f'http://127.0.0.1:{args.port}{path}', data=encoded,
                                     headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
        with opener.open(req, timeout=timeout) as response:
            raw = response.read()
        return json.loads(raw) if path.startswith('/api/') else raw.decode()

    def register(bundle, first=False):
        path, info, digest = bundle
        command = [str(helper), 'register', '--install-dir', str(managed), '--bundle', str(path),
                   '--manifest-sha256', digest, '--reviewed-source', 'isolated T-12 acceptance fixture']
        if first:
            command.append('--initialize')
        subprocess.run(command, check=True, timeout=90)
        receipt.setdefault('releases', []).append({'id': info['releaseId'], 'manifestSha256': digest})

    def status():
        return request('/api/updates')

    def capture_processes():
        path = managed / 'updates/state.json'
        if path.exists():
            op = json.loads(path.read_text()).get('operation') or {}
            for key in ('oldProcess', 'newProcess', 'helperProcess'):
                process = op.get(key)
                if process and process not in owned:
                    assert Path(process['executable']).is_relative_to(managed / 'releases')
                    owned.append(process)

    def snapshot(agent_id):
        detail = request(f'/api/agents/{agent_id}')
        agent = detail['agent']
        return {key: agent.get(key) for key in ('id', 'harness', 'threadId', 'claudeSessionId', 'reviewedSeq', 'settings', 'projectId')} | {
            'turnIds': [turn['id'] for turn in detail['turns']],
            'messages': [(item.get('id'), item.get('text'), item.get('content')) for turn in detail['turns'] for item in turn.get('items', []) if item.get('type') in ('userMessage', 'agentMessage')],
        }

    def payload_hashes(agents):
        hashes = {}
        for agent in agents:
            full = request(f'/api/agents/{agent["id"]}')
            for turn in full['turns']:
                for item in turn.get('items', []):
                    if not item.get('_yuzunoTruncated'):
                        continue
                    payload = request(f'/api/agents/{agent["id"]}/items/{item["id"]}/payload')['fields']
                    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
                    hashes[agent['id'] + '/' + item['id']] = hashlib.sha256(encoded).hexdigest()
        return hashes

    def credentials():
        # Only this disposable fixture DB; never print or save credentials in
        # the receipt. Hold the previous values in memory to prove revocation.
        with sqlite3.connect(f'file:{data / "workspace.sqlite"}?mode=ro', uri=True) as db:
            return {key.removeprefix('collaboration.mcp.agent.'): value for key, value in db.execute(
                "SELECT key,value FROM workspace_meta WHERE key GLOB 'collaboration.mcp.agent.*'")}

    def probe_credential(agent_id, token, revoked=False):
        body = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                'params': {'name': 'peers_list', 'arguments': {}}}
        req = urllib.request.Request(f'http://127.0.0.1:{args.port}/mcp/{agent_id}',
            data=json.dumps(body).encode(), headers={'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream', 'Authorization': f'Bearer {token}',
            'MCP-Protocol-Version': '2025-03-26'})
        try:
            with opener.open(req, timeout=8) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            assert revoked and error.code == 401, 'Unexpected fixture MCP authentication failure'
            return
        assert not revoked, 'Previous Core credential remained authorized'
        value = result.get('result', {})
        assert not value.get('isError') and value.get('structuredContent', {}).get('yuzuno', {}).get('agentId') == agent_id, 'Fresh fixture credential failed peers_list'

    try:
        register(bundles[0], True)
        register(bundles[1])
        release_a = bundles[0][1]['releaseId']
        executable = managed / 'releases' / release_a / 'bin/yuzuno-workspace'
        log = (root / 'initial-core.log').open('wb')
        child = subprocess.Popen([str(executable), '--install-dir', str(managed), '--data-dir', str(data),
                                  '--port', str(args.port), '--cwd', str(cwd), '--codex', args.codex if (args.native or args.scripted) else str(root / 'no-native-probe')],
                                 cwd=cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=dict(os.environ, T9_TIMELINE=str(root / "timeline")))
        log.close()
        owned.append(until(lambda: identity(child.pid), 5))
        health = until(lambda: (h if (h := request('/api/health')).get('releaseId') == release_a else None))
        workspace_id = health['workspaceId']
        assert health['storageReady'] and health['apiReady']
        project = request('/api/projects', {'name': 'Update acceptance sentinel'})
        agents = []
        if args.native or args.scripted:
            for harness in (('codex', 'claude') if args.native else ('codex',)):
                agent = request('/api/agents', {'name': f'Update {harness} fixture', 'cwd': str(cwd), 'harness': harness})
                agent_id = agent['id']
                until(lambda: (d := request(f'/api/agents/{agent_id}'))['agent']['connectionState'] == 'connected' and d.get('collaboration', {}).get('ready') is True, 120)
                request(f'/api/agents/{agent_id}/turns', {'text': 'warmup:2:32' if args.scripted else 'Do not use tools. Reply only: update-session-fixture-ready'})
                completed = until(lambda: (d if (d := request(f'/api/agents/{agent_id}'))['turns'] and d['agent']['status'] not in ('working', 'waiting') else None), 180)
                if args.native:
                    assert any('update-session-fixture-ready' in item.get('text', '')
                               for turn in completed['turns'] for item in turn.get('items', [])
                               if item.get('type') == 'agentMessage'), f'{harness} fixture did not answer'
                before = snapshot(agent_id)
                assert before['threadId'] if harness == 'codex' else before['claudeSessionId']
                agents.append(before)
            receipt['sessions'] = [{key: a[key] for key in ('id', 'harness', 'threadId', 'claudeSessionId', 'turnIds')} for a in agents]
            receipt['checks'].append('created disposable real Codex and Claude sessions' if args.native else 'created scripted native-protocol session with large payloads')
        (root / 'acceptance-workspace-id').write_text(workspace_id)
        before_payloads = payload_hashes(agents)
        if args.scripted: assert before_payloads, 'fixture must exercise full payloads'
        previous_credentials = credentials()
        for aid, token in previous_credentials.items():
            probe_credential(aid, token)
        for index, bundle in enumerate(bundles[1:], start=1):
            if index > 1:
                register(bundle)
            target = bundle[1]['releaseId']
            # Real complete-bundle hashing runs under the shared nice slot;
            # browser's shorter timeout/recovery is tested separately.
            request('/api/updates/check', {}, timeout=90)
            request('/api/updates/prepare', {'releaseId': target}, timeout=90)
            prepared = until(lambda: (s if (s := status()).get('operation', {}).get('phase') in ('prepared', 'failed') else None), 90)
            assert prepared['operation']['phase'] == 'prepared', prepared
            assert prepared['current']['releaseId'] == (release_a if index == 1 else bundles[1][1]['releaseId'])
            assert prepared['acceptingWork']
            if args.scripted and index == 1:
                # A corrupt persisted payload must fail deep readiness before
                # Stop, while public connectivity and the recovery UI remain up.
                with sqlite3.connect(data / 'workspace.sqlite') as db:
                    row = db.execute('SELECT agent_id,turn_id,item_id,field,data FROM agent_payloads LIMIT 1').fetchone()
                    assert row
                    db.execute('UPDATE agent_payloads SET data=? WHERE agent_id=? AND turn_id=? AND item_id=? AND field=?', ('invalid json', *row[:4]))
                request('/api/updates/apply', {'releaseId': target, 'requestId': str(uuid.uuid4())}, timeout=90)
                rejected = until(lambda: (s if (s := status()).get('operation', {}).get('phase') == 'failed' and s.get('acceptingWork') else None), 180)
                assert 'verification failed' in rejected['operation']['error']
                assert identity(child.pid) is not None, 'damaged records must not stop the old Core'
                assert request('/api/health')['workspaceId'] == workspace_id
                with sqlite3.connect(data / 'workspace.sqlite') as db:
                    db.execute('UPDATE agent_payloads SET data=? WHERE agent_id=? AND turn_id=? AND item_id=? AND field=?', (row[4], *row[:4]))
                receipt['checks'].append('damaged full payload refused before Stop; old Core/public health/recovery UI remain available')
                previous_credentials = credentials()
                request('/api/updates/prepare', {'releaseId': target}, timeout=90)
                until(lambda: status().get('operation', {}).get('phase') == 'prepared', 90)
            old_process = identity(child.pid) if index == 1 else next((p for p in reversed(owned) if identity(p['pid']) == p and p['executable'].endswith('/yuzuno-workspace')), None)
            if args.scripted and index == 1:
                # Deterministic stream + pending approval. The script executes
                # no actual tools; it is the same native-protocol fixture as T9.
                aid = agents[0]['id']
                request(f'/api/agents/{aid}/turns', {'text': 'run:120:5:1:60'})
            request_id = str(uuid.uuid4())
            payload = {'releaseId': target, 'requestId': request_id}
            accepted = request('/api/updates/apply', payload, timeout=90)
            capture_processes()
            if args.scripted and index == 1:
                waiting = status()
                assert waiting['operation']['phase'] == 'waiting' and not waiting['acceptingWork'], waiting
                assert identity(old_process['pid']) == old_process, 'busy Core must stay alive'
                assert request('/api/updates/apply', payload)['operationId'] == accepted['operationId']
                fresh_id = str(uuid.uuid4())
                try:
                    request(f'/api/agents/{aid}/messages', {'clientMessageId': fresh_id, 'text': 'must not reach native'})
                    raise AssertionError('new work crossed the update fence')
                except urllib.error.HTTPError as error:
                    assert 'workspace_updating:' in error.read().decode()
                request('/api/updates/cancel', {'operationId': accepted['operationId']})
                assert status()['acceptingWork'] and identity(old_process['pid']) == old_process
                payload = {'releaseId': target, 'requestId': str(uuid.uuid4())}
                accepted = request('/api/updates/apply', payload, timeout=90)
                pending = until(lambda: (d['pending'][0] if (d := request(f'/api/agents/{aid}')).get('pending') else None), 20)
                assert identity(old_process['pid']) == old_process
                assert status()['operation']['phase'] == 'waiting'
                request(f'/api/requests/{pending["id"]}/respond', {'response': {'decision': 'decline'}})
                # During final seal ordinary API reads are fenced too; inspect
                # the snapshot once the replacement is serving again below.
                receipt['checks'].append('busy/approval preserved; fresh send fenced; duplicate apply deduplicated; cancellation reopened; approval answered while waiting')
            # No connected browser is involved while the independent helper runs.
            time.sleep(1)
            final = until(lambda: (s if (s := status()).get('operation', {}).get('phase') in ('complete', 'rolledBack', 'failed') else None), 300)
            capture_processes()
            expected_phase = 'complete' if index == 1 else 'rolledBack'
            assert final['operation']['phase'] == expected_phase, final
            assert final['acceptingWork']
            assert request('/api/updates/apply', payload)['operationId'] == accepted['operationId'], 'Replay must return the durable receipt'
            health = request('/api/health')
            assert health['workspaceId'] == workspace_id
            assert health['releaseId'] == bundles[1][1]['releaseId']
            assert health['storageReady'] and health['apiReady']
            assert f'content="{health["releaseId"]}"' in request('/')
            assert project in request('/api/projects')['projects']
            after = [snapshot(a['id']) for a in agents]
            after_payloads = payload_hashes(agents)
            assert all(after_payloads.get(key) == digest for key, digest in before_payloads.items()), 'Full payload changed'
            if before_payloads:
                receipt.setdefault('payloadHashes', []).append({'phase': expected_phase, 'sha256': after_payloads})
            before_payloads = after_payloads
            if index > 1 and args.failure_sentinel:
                with sqlite3.connect(f'file:{data / "workspace.sqlite"}?mode=ro', uri=True) as db:
                    assert db.execute('SELECT value FROM update_fallback_sentinel').fetchall() == [('written-after-backup',)]
                backup = managed / 'backups' / (final['operation']['id'] + '.sqlite3')
                with sqlite3.connect(f'file:{backup}?mode=ro', uri=True) as db:
                    assert not db.execute("SELECT 1 FROM sqlite_master WHERE name='update_fallback_sentinel'").fetchall()
                receipt['checks'].append('candidate wrote sentinel after backup; compatible fallback preserved it; backup has no sentinel')
            if args.scripted and index == 1:
                for before, current in zip(agents, after):
                    assert all(current[key] == before[key] for key in ('id','harness','threadId','claudeSessionId','reviewedSeq','settings','projectId'))
                    assert current['turnIds'][:len(before['turnIds'])] == before['turnIds']
                    assert len(current['turnIds']) == len(before['turnIds']) + 1
                agents = after
                full = request(f'/api/agents/{agents[0]["id"]}')
                assert not any(r.get('input', {}).get('clientMessageId') == fresh_id for r in full.get('messageReceipts', []))
                assert not any(item.get('clientId') == fresh_id for turn in full['turns'] for item in turn.get('items', []))
                payload_item = next(item for turn in full['turns'] for item in turn.get('items', []) if item.get('_yuzunoTruncated'))
                loaded = request(f'/api/agents/{agents[0]["id"]}/items/{payload_item["id"]}/payload')
                assert len(loaded['fields']['aggregatedOutput']) > 8192
            else:
                assert after == agents, 'Native identity/history/read cursor/settings changed'
            assert old_process and identity(old_process['pid']) != old_process, 'the old packaged Core must really exit'
            with sqlite3.connect(f'file:{data / "workspace.sqlite"}?mode=ro', uri=True) as db:
                layouts = [row[0] for row in db.execute('SELECT DISTINCT layout FROM agents')]
                assert all(layout == 1 for layout in layouts)
            receipt.setdefault('storage', []).append({'phase': expected_phase, 'layouts': layouts, 'recordsReady': final['operation']['recordsProof']['recordsReady'], 'proof': final['operation']['recordsProof']})
            for a in agents:
                restored = request(f'/api/agents/{a["id"]}')
                assert restored['agent']['connectionState'] == 'connected'
                assert restored.get('collaboration', {}).get('ready') is True
            fresh_credentials = credentials()
            assert fresh_credentials.keys() == previous_credentials.keys()
            for aid, token in fresh_credentials.items():
                assert token != previous_credentials[aid], 'Core restart did not rotate the fixture credential'
                probe_credential(aid, previous_credentials[aid], revoked=True)
                probe_credential(aid, token)
            previous_credentials = fresh_credentials
            receipt['checks'].append(f'{expected_phase}: collaboration ready; old credentials return 401; fresh credentials call peers_list')
            receipt.setdefault('restoredSessions', []).append({'phase': expected_phase, 'sessions': [
                {key: a[key] for key in ('id', 'harness', 'threadId', 'claudeSessionId', 'turnIds')} for a in after]})
            receipt['checks'].append(f'{expected_phase}: same workspace/project/native identity; matching Core/UI; duplicate request receipt')
        if args.recover_stopping:
            # All test processes are idle. Model a host shutdown between the
            # acknowledged Stop and helper Starting, then manually launch B.
            for stopped_owner in ('oldCore', 'failedCandidate'):
                live = status()['operation']
                helper_process = live.get('helperProcess')
                state_path = managed / 'updates/state.json'
                journal = json.loads(state_path.read_text())
                helper_process = journal['operation'].get('helperProcess')
                if helper_process:
                    until(lambda: identity(helper_process['pid']) != helper_process, 30)
                current_core = next(p for p in reversed(owned) if identity(p['pid']) == p and p['executable'].endswith('/yuzuno-workspace'))
                assert all(a['status'] not in ('working', 'waiting', 'uncertain') and not a.get('pendingCount') for a in request('/api/workspace')['agents'])
                os.kill(current_core['pid'], signal.SIGINT)
                until(lambda: identity(current_core['pid']) != current_core, 20)
                journal = json.loads(state_path.read_text())
                op = journal['operation']
                op['phase'] = 'stopping'
                op['stoppingProcess'] = current_core
                if stopped_owner == 'oldCore': op['oldProcess'] = current_core
                else: op['newProcess'] = current_core
                op['error'] = None
                import datetime
                op['startedAt'] = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=60)).isoformat()
                temporary = state_path.with_suffix('.fixture')
                temporary.write_text(json.dumps(journal)); temporary.replace(state_path)
                executable = managed / 'releases' / bundles[1][1]['releaseId'] / 'bin/yuzuno-workspace'
                with (root / f'recovery-{stopped_owner}.log').open('wb') as log:
                    child = subprocess.Popen([str(executable), '--install-dir', str(managed), '--data-dir', str(data), '--port', str(args.port), '--cwd', str(cwd), '--codex', args.codex], cwd=cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=dict(os.environ, T9_TIMELINE=str(root / 'timeline')))
                owned.append(until(lambda: identity(child.pid), 5))
                recovered = until(lambda: (s if (s := status()).get('operation', {}).get('phase') == 'failed' and s.get('acceptingWork') else None), 240)
                assert 'restarted Core' in recovered['operation']['error']
                assert [snapshot(a['id']) for a in agents] == agents
                assert json.loads((managed / 'current.json').read_text())['releaseId'] == bundles[1][1]['releaseId']
                for a in agents:
                    assert request(f'/api/agents/{a["id"]}')['collaboration']['ready'] is True
                receipt['checks'].append(f'abandoned Stopping after {stopped_owner}: actual new Core restored same sessions, current pointer, visible failure and admission')
        receipt['passed'] = True
    except BaseException as error:
        receipt['passed'] = False
        receipt['error'] = str(error)
        raise
    finally:
        capture_processes()
        # Stop only this run's exact processes, and never an active native Turn.
        safe = False
        try:
            live_agents = request('/api/workspace')['agents']
            safe = all(a['status'] not in ('working', 'waiting', 'uncertain') and not a.get('pendingCount') for a in live_agents)
        except Exception:
            safe = not args.native
        cleanup = []
        for process in reversed(owned):
            if identity(process['pid']) != process:
                continue
            if not safe:
                cleanup.append({'pid': process['pid'], 'action': 'left running: active or unconfirmed native work'})
                continue
            os.kill(process['pid'], signal.SIGINT)
            try:
                until(lambda: identity(process['pid']) != process, 15)
                cleanup.append({'pid': process['pid'], 'action': 'gracefully stopped'})
            except AssertionError:
                cleanup.append({'pid': process['pid'], 'action': 'shutdown unconfirmed; no force kill'})
        receipt['cleanup'] = cleanup
        (root / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--a', type=Path, required=True)
    parser.add_argument('--b', type=Path, required=True)
    parser.add_argument('--failure-bundle', type=Path, help='Reviewed fixture with a failing Core executable and compatible schema')
    parser.add_argument('--recover-stopping', action='store_true', help='Restart the isolated idle Core from an abandoned Stopping journal')
    parser.add_argument('--failure-sentinel', action='store_true', help='Failure bundle uses tools/fixtures/update-failing-core.c')
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=4399)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--native', action='store_true')
    modes.add_argument('--scripted', action='store_true', help='Deterministic busy/approval/send race with T9 fake Codex, not a model')
    parser.add_argument('--codex', default='codex')
    main(parser.parse_args())
