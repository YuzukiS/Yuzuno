#!/usr/bin/env python3
"""Real installed app-server; fresh unauthenticated profile, fixture-only turns."""
import json
from pathlib import Path
import queue
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'experiments/runtime'))
from probe_local import Rpc, run, clean_environment

root = Path(tempfile.mkdtemp(prefix='t114-codex-'))
profile = root / 'profile'
profile.mkdir()
(profile / 'config.toml').write_text('cli_auth_credentials_store = "file"\n')
report = {'root': str(root), 'version': run(['codex', '--version'], clean_environment())}
rpc = Rpc(profile, 't114-rewind')

def completed():
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        message = rpc.messages.get(timeout=max(.01, deadline - time.monotonic()))
        rpc.events.append(message)
        if message.get('method') == 'turn/completed':
            return message['params']['turn']
    raise TimeoutError('native turn did not complete')

try:
    report['initialize'] = rpc.initialize()
    start = rpc.call('thread/start', {'cwd': str(root), 'approvalPolicy': 'never', 'sandbox': 'read-only', 'ephemeral': False})
    report['start'] = start
    thread = start['result']['thread']['id']
    turns = []
    for text in ['t114-first', 't114-second', 't114-third']:
        result = rpc.call('thread/shellCommand', {'threadId': thread, 'command': 'echo ' + text, 'timeoutMs': 2000})
        turns.append({'ack': result, 'completed': completed()})
    report['turns'] = turns
    report['before'] = rpc.call('thread/turns/list', {'threadId': thread, 'sortDirection': 'asc', 'limit': 100, 'itemsView': 'full'})
    target = turns[1]['completed']['id']
    report['revert'] = rpc.call('thread/revert', {'threadId': thread, 'beforeTurnId': target})
    report['after'] = rpc.call('thread/turns/list', {'threadId': thread, 'sortDirection': 'asc', 'limit': 100, 'itemsView': 'full'})
    report['staleTarget'] = rpc.call('thread/revert', {'threadId': thread, 'beforeTurnId': target})
    rpc.close()
    rpc = Rpc(profile, 't114-reconnect')
    rpc.initialize()
    report['resume'] = rpc.call('thread/resume', {'threadId': thread})
    report['reconnected'] = rpc.call('thread/turns/list', {'threadId': thread, 'sortDirection': 'asc', 'limit': 100, 'itemsView': 'full'})
    report['rollbackRemoved'] = rpc.call('thread/rollback', {'threadId': thread, 'numTurns': 1})
    expected = [turns[0]['completed']['id']]
    report['verified'] = all([x['id'] for x in report[key].get('result', {}).get('data', [])] == expected for key in ['after', 'reconnected'])
except Exception as e:
    report['error'] = str(e)
finally:
    rpc.close()
    report['stderr'] = rpc.errors[-8:]
    output = Path(sys.argv[1])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'output': str(output), 'verified': report.get('verified'), 'error': report.get('error')}))
