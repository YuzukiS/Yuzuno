#!/usr/bin/env python3
"""Real Mac mini MCP acceptance, restricted to collaboration lab Core 4379.

No account files or global configuration are read or changed. The runner waits
for the local acceptance to finish, comments on its existing task, and interrupts
only its own reverse SSH forward. Incomplete native turns are never replayed.
"""
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
LAB = Path(__file__).resolve().parent
STATE = LAB / 'remote-state.json'
LOCAL_STATE = LAB / 'native-state.json'
BASE = 'http://127.0.0.1:4379/api'
TARGET = os.environ.get('YUZUNO_SSH_TARGET', 'tester@192.0.2.10')
CODEX = os.environ.get('YUZUNO_REMOTE_CODEX', '/opt/homebrew/bin/codex')
FORWARD_PREFIX = '127.0.0.1:4379:127.0.0.1:'


def api(path, body=None):
    req = urllib.request.Request(BASE + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    try:
        with urllib.request.urlopen(req, timeout=80) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'HTTP {error.code} {path}: {error.read().decode()}') from None


def save(state):
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')


def note(state, stage, **details):
    state['stage'] = stage
    state.setdefault('observations', []).append({'stage': stage, 'at': time.time(), **details})
    save(state)
    print(stage, json.dumps(details, ensure_ascii=False), flush=True)


def ssh(command):
    result = subprocess.run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
        '-o', 'ForwardAgent=no', TARGET, command], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('Isolated SSH operation failed: ' + result.stderr.strip())
    return result.stdout.strip()


def wait(predicate, label, seconds=180):
    deadline, last_notice = time.monotonic() + seconds, time.monotonic()
    while time.monotonic() < deadline:
        found = predicate()
        if found:
            return found
        if time.monotonic() - last_notice >= 20:
            print('Waiting:', label, flush=True)
            last_notice = time.monotonic()
        time.sleep(1)
    raise TimeoutError(label)


def detail(state):
    value = api('/agents/' + state['agentId'])
    agent = value['agent']
    assert agent['cwd'] == state['remoteCwd'], 'Agent cwd escaped this experiment'
    assert agent['remote']['machine']['target'] == TARGET
    assert agent['remote']['machine']['id'] == state['machineId']
    return value


def ready(state):
    value = detail(state)
    agent = value['agent']
    if value['pending']:
        raise RuntimeError('Native approval needs inspection; no automatic approval')
    if agent['status'] in ('error', 'uncertain') and agent.get('error'):
        raise RuntimeError(agent['error'])
    return value if agent['status'] == 'idle' and agent['connectionState'] == 'connected' else None


def process(pid):
    root = Path('/proc') / str(pid)
    try:
        argv = [part.decode() for part in (root / 'cmdline').read_bytes().split(b'\0') if part]
        stat = (root / 'stat').read_text().rsplit(') ', 1)[1].split()
        return {'pid': int(pid), 'ppid': int(stat[1]), 'born': stat[19], 'argv': argv,
                'cwd': str((root / 'cwd').resolve())}
    except (OSError, ValueError, UnicodeError):
        return None


def core_process():
    found = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        p = process(path.name)
        if not p or not p['argv'] or not p['argv'][0].endswith('yuzuno-workspace'):
            continue
        argv = p['argv']
        if '--port' not in argv or argv[argv.index('--port') + 1] != '4379':
            continue
        if p['cwd'] != str(ROOT) or '--data-dir' not in argv:
            continue
        data = Path(argv[argv.index('--data-dir') + 1])
        if (ROOT / data).resolve() != (LAB / 'core-data').resolve():
            continue
        found.append(p)
    assert len(found) == 1, f'Expected exactly one owned 4379 lab Core, found {len(found)}'
    return found[0]


def tunnel(core_pid):
    found = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        p = process(path.name)
        if not p or p['ppid'] != core_pid or not p['argv'] or Path(p['argv'][0]).name != 'ssh':
            continue
        argv = p['argv']
        forward = argv[argv.index('-R') + 1] if '-R' in argv else ''
        port = forward.removeprefix(FORWARD_PREFIX)
        if forward.startswith(FORWARD_PREFIX) and port.isdecimal() and 0 < int(port) < 65536 and TARGET in argv:
            found.append(p)
    assert len(found) <= 1, 'Multiple owned reverse tunnels; refusing process control'
    return found[0] if found else None


def check_remote_boundary(state, stage):
    owned = tunnel(state['corePid'])
    assert owned, 'Owned reverse SSH tunnel missing'
    forwarding = owned['argv'][owned['argv'].index('-R') + 1]
    assert int(forwarding.removeprefix(FORWARD_PREFIX)) != 4379, 'SSH still exports the desktop API port'
    # Probe GUI routes without model calls. Only a read-only tool operation is
    # included, so an unfixed server cannot accidentally create or modify data.
    script = '''import json, urllib.request, urllib.error
results=[]
for path,method in [("/api/health","GET"),("/api/workspace","GET"),("/api/collaboration/task_list","POST")]:
 request=urllib.request.Request("http://127.0.0.1:4379"+path,
  data=b"{}" if method=="POST" else None,
  headers={"Content-Type":"application/json","X-Yuzuno-Client":"desktop"},method=method)
 try:
  with urllib.request.urlopen(request,timeout=5) as response:status=response.status
 except urllib.error.HTTPError as error:status=error.code
 results.append({"path":path,"method":method,"status":status})
print(json.dumps(results))
'''
    results = json.loads(ssh('python3 -c ' + shlex.quote(script)))
    assert all(result['status'] == 404 for result in results), results
    state.setdefault('boundaryEvidence', []).append({'stage': stage, 'forward': forwarding, 'responses': results})
    state['checks'].append(stage + ': remote GUI/API routes return 404 even with desktop header')
    note(state, stage + '-boundary-verified', forward=forwarding, responses=results)


def preflight():
    assert not STATE.exists(), 'Preserve prior observations; this is a one-shot experiment'
    remote_cwd = '/tmp/yuzuno-next-collaboration-' + uuid.uuid4().hex[:12]
    script = (
        'from pathlib import Path; import json; '
        f'p=Path({remote_cwd!r}); p.mkdir(mode=0o700); '
        'p.joinpath("AGENTS.md").write_text('
        '"This is isolated Yuzuno MCP acceptance. Use only the requested Yuzuno MCP tools. "'
        '+"Do not run shell commands, modify files, send peer messages, create tasks, or change task state. "'
        '+"Comment only on the task specified by the user.\\n"); '
        'print(json.dumps({"cwd":str(p.resolve())}))'
    )
    version = ssh('PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ' + shlex.quote(CODEX) + ' --version')
    assert version == 'codex-cli 0.162.1', version
    remote = json.loads(ssh('python3 -c ' + shlex.quote(script)))
    state = {'kind': 'real Mac mini Codex + native MCP over isolated SSH reverse forward',
             'target': TARGET, 'codex': CODEX, 'version': version,
             'remoteCwd': remote['cwd'], 'checks': [], 'runId': uuid.uuid4().hex[:12]}
    note(state, 'preflight-complete', version=version, remoteCwd=remote['cwd'])


def check_turn(state, stage):
    before = detail(state)
    marker = f'yuzuno-remote-mcp-{stage}-{state["runId"]}'
    text = (
        f'This is a narrowly authorized real MCP acceptance. Use only yuzuno MCP tools. '
        f'Call task_list, then task_get for task {state["taskId"]}. '
        f'Call task_comment exactly once on that same task with a concise Chinese verification '
        f'that this remote Mac mini Agent can read the existing shared task. '
        f'Include the exact marker {marker} in the comment. '
        f'Use requestId {marker}. Do not send peer messages, create a task, change task fields/status, '
        f'call shell/file tools, or claim to have verified anything beyond these MCP calls. '
        f'Finish with the marker and one short sentence.'
    )
    # Persist intent before calling turn/start. A failed run is never auto-replayed.
    note(state, stage + '-send-intent', marker=marker)
    response = api('/agents/' + state['agentId'] + '/turns', {'text': text})
    turn_id = response['turnId']
    state.setdefault('turnIds', []).append(turn_id)
    note(state, stage + '-accepted', turnId=turn_id)

    def completed():
        current = ready(state)
        if not current:
            return None
        turn = next((turn for turn in current['turns'] if turn['id'] == turn_id), None)
        if not turn:
            return None
        if turn['status'] != 'completed':
            raise RuntimeError('Native turn did not succeed: ' + turn['status'])
        return current, turn

    current, turn = wait(completed, stage + ' native turn', 240)
    task = api('/collaboration/task_get', {'taskId': state['taskId'], 'limit': 200})
    comments = [activity for activity in task['activities']
                if activity['kind'] == 'comment' and marker in activity.get('body', '')]
    assert len(comments) == 1, 'Expected one durable MCP comment with the verification marker'
    comment = comments[0]
    assert comment['actor']['id'] == state['agentId']
    assert comment['source']['agentId'] == state['agentId']
    assert comment['source']['turnId'] == turn_id
    assert comment['source']['sessionId'] == current['agent']['threadId']
    assert any(e['agentId'] == state['agentId'] and e['turnId'] == turn_id for e in task['executions'])
    assert current['agent']['threadId'] == before['agent']['threadId']
    assert task['task']['version'] == state['originalTaskVersion']
    assert task['task']['status'] == state['originalTaskStatus']
    native_tools = [item.get('tool') for item in turn['items'] if item.get('type') == 'mcpToolCall']
    assert {'task_list', 'task_get', 'task_comment'}.issubset(native_tools), native_tools
    state['checks'].append(stage + ': real remote task_list/task_get/task_comment, authenticated source and native execution link')
    state.setdefault('evidence', []).append({'marker': marker, 'comment': comment,
        'turnId': turn_id, 'nativeTools': native_tools, 'threadId': current['agent']['threadId']})
    note(state, stage + '-verified', turnId=turn_id, nativeTools=native_tools)


def run(empty_retry=False, replace_empty=False, reuse_machine=False):
    state = json.loads(STATE.read_text())
    if replace_empty:
        assert state.get('closed') and 'list_turns is not supported yet' in state.get('failure', '')
        assert not detail(state)['turns'], 'Do not replace an Agent with an executed acceptance turn'
        state.setdefault('retiredAgents', []).append({'agentId': state['agentId'], 'closed': True,
            'reason': state['failure'], 'threadId': state['threadId']})
    elif empty_retry:
        assert state.get('closed') and state.get('failure', '').startswith('HTTP 405 ')
        assert not detail(state)['turns'], 'Only the known, never-executed HTTP routing failure may retry'
    else:
        assert state['stage'] == 'preflight-complete' and not state.get('agentId'), 'Do not replay an incomplete run'
    local = json.loads(LOCAL_STATE.read_text())
    assert local.get('checks'), 'Wait until local Codex + Claude assertions have completed'
    assert api('/health')['application'] == 'yuzuno-next'
    core = core_process()
    state['corePid'] = core['pid']
    state['taskId'] = local['taskId']
    task = api('/collaboration/task_get', {'taskId': state['taskId']})['task']
    state['taskId'] = task['id']  # Prefer the canonical T-N in new native prompts.
    state['originalTaskVersion'], state['originalTaskStatus'] = task['version'], task['status']
    if not empty_retry and not replace_empty and not reuse_machine:
        machine = api('/machines', {'name': 'Mac mini · collaboration acceptance', 'target': TARGET,
                                   'codex': CODEX, 'defaultCwd': state['remoteCwd']})
        state['machineId'] = machine['id']
        note(state, 'machine-created', machineId=machine['id'])
    try:
        if empty_retry:
            api('/agents/' + state['agentId'] + '/reopen', {})
            state['closed'] = False
            state.pop('failure', None)
            note(state, 'empty-agent-reopened', agentId=state['agentId'])
        else:
            agent = api('/agents', {'name': 'Sora · remote MCP acceptance', 'harness': 'codex',
                'model': 'gpt-6.1-sol', 'cwd': state['remoteCwd'], 'machineId': state['machineId']})
            state['agentId'] = agent['id']
            state['closed'] = False
            state.pop('failure', None)
            note(state, 'agent-created', agentId=agent['id'])
        initial = wait(lambda: ready(state), 'remote native session ready')
        state['threadId'] = initial['agent']['threadId']
        state['runtime'] = initial['agent']['remote']['runtime']
        if state.get('verifyMcpOnly'):
            check_remote_boundary(state, 'before-repair')
        check_turn(state, 'before-repair')
        original = tunnel(core['pid'])
        assert original, 'Owned reverse tunnel not found'
        assert process(original['pid']) == original, 'SSH process changed before signal'
        assert core_process() == core, 'Core changed before tunnel interruption'
        note(state, 'tunnel-interrupt-intent', pid=original['pid'], argv=original['argv'])
        os.kill(original['pid'], signal.SIGTERM)

        def replaced():
            current = tunnel(core['pid'])
            return current if current and current['pid'] != original['pid'] else None

        replacement = wait(replaced, 'Core independently repairs the reverse SSH tunnel', 65)
        current = wait(lambda: ready(state), 'remote remains connected after tunnel repair')
        assert current['agent']['threadId'] == state['threadId']
        assert current['agent']['remote']['runtime'] == state['runtime'], 'Native Harness was replaced'
        note(state, 'tunnel-repaired', oldPid=original['pid'], newPid=replacement['pid'])
        if state.get('verifyMcpOnly'):
            check_remote_boundary(state, 'after-repair')
        check_turn(state, 'after-repair')
        state['checks'].append('SSH reverse tunnel replaced automatically while native session and runtime remained unchanged')
        state['passed'] = True
        note(state, 'remote-acceptance-passed', checks=state['checks'])
    except Exception as error:
        state['passed'], state['failure'] = False, str(error)
        note(state, 'failed', error=str(error))
        raise
    finally:
        if state.get('agentId'):
            cleanup(state)


def cleanup(state=None):
    state = state or json.loads(STATE.read_text())
    if not state.get('agentId'):
        return
    current = detail(state)
    if not current['agent'].get('closedAt'):
        closed = api('/agents/' + state['agentId'] + '/close', {})
        assert closed['closedAt']
    state['closed'] = True
    note(state, 'owned-remote-agent-closed', agentId=state['agentId'])
    if state.get('verifyMcpOnly'):
        assert core_process()['pid'] == state['corePid'], 'Do not clean a different Core generation'
        agents = api('/workspace')['agents']
        assert not any(a.get('remote', {}).get('machine', {}).get('id') == state['machineId']
                       and not a.get('closedAt') for a in agents), 'Remote machine still has an open lab Agent'
        owned = tunnel(state['corePid'])
        if owned:
            assert process(owned['pid']) == owned, 'SSH ownership changed before cleanup'
            os.kill(owned['pid'], signal.SIGTERM)
            wait(lambda: tunnel(state['corePid']) is None, 'owned SSH tunnel exits', 10)
            state['cleanedTunnelPid'] = owned['pid']
        runtime = state['runtime']
        script = ('from pathlib import Path; import json,subprocess; r=' + repr(runtime) + '; '
                  'p=subprocess.run(["ps","-p",str(r["pid"]),"-o","args="],capture_output=True,text=True); '
                  'print(json.dumps({"socketExists":Path(r["socket"]).exists(),'
                  '"ownedRuntimeStillRunning":r["root"] in p.stdout}))')
        evidence = json.loads(ssh('python3 -c ' + shlex.quote(script)))
        assert not evidence['socketExists'] and not evidence['ownedRuntimeStillRunning'], evidence
        state['cleanupEvidence'] = evidence
        note(state, 'owned-remote-resources-released', **evidence)


def boundary_round():
    """New evidence file and new Agent; never overwrite or replay the first run."""
    global STATE
    previous = json.loads(STATE.read_text())
    assert previous.get('passed') and previous.get('closed'), 'First experiment must be closed'
    assert detail(previous)['agent']['closedAt']
    STATE = LAB / 'remote-boundary-state.json'
    assert not STATE.exists(), 'Preserve prior boundary evidence; no automatic replay'
    state = {key: previous[key] for key in ['target', 'codex', 'version', 'remoteCwd', 'machineId']}
    state.update({'kind': 'real remote MCP-only boundary and tunnel repair', 'verifyMcpOnly': True,
                  'checks': [], 'runId': uuid.uuid4().hex[:12], 'previousEvidence': 'remote-state.json'})
    note(state, 'preflight-complete', reusedCwd=state['remoteCwd'], machineId=state['machineId'])
    run(reuse_machine=True)


def boundary_cleanup():
    global STATE
    STATE = LAB / 'remote-boundary-state.json'
    cleanup()


if __name__ == '__main__':
    {'preflight': preflight, 'run': run, 'retry-empty': lambda: run(True),
     'replace-empty': lambda: run(replace_empty=True), 'boundary': boundary_round,
     'boundary-cleanup': boundary_cleanup, 'cleanup': cleanup}[sys.argv[1]]()
