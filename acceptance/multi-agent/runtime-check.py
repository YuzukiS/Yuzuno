#!/usr/bin/env python3
"""Real recovery acceptance restricted to the existing multi-agent lab (4327).

No models/Agents are created by this runner. Each task is journaled before sending;
an incomplete stage is never automatically resent. All process control verifies
lab ownership. The normal Core, desktop windows and global CLIs are untouched.
"""
import argparse
import contextlib
import datetime
import importlib.util
import json
import os
from pathlib import Path
import shlex
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
LAB = ROOT / 'acceptance/multi-agent'
RESULTS = LAB / 'results.json'
BASE = 'http://127.0.0.1:4327'
REMOTE_ID = '3fca0686-0f2f-4573-a342-bc5db1783b55'
STATE = LAB / 'exercise-slice-20261012-state.json'
SPEC = importlib.util.spec_from_file_location('slice_lab', ROOT / 'scripts/slice-lab.py')
lab = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lab)
REPORT = {}
CURRENT = None
LAST_PROGRESS = 0


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def save():
    RESULTS.write_text(json.dumps(REPORT, indent=2, ensure_ascii=False) + '\n')


def note(text):
    global LAST_PROGRESS
    LAST_PROGRESS = time.monotonic()
    print(now() + ' ' + text, flush=True)
    if CURRENT:
        CURRENT.setdefault('progress', []).append({'at': now(), 'message': text})
    save()


def api(path, data=None):
    if not path.startswith('/api/'):
        raise RuntimeError('Only lab API paths are allowed')
    request = urllib.request.Request(BASE + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Content-Type':'application/json', 'x-yuzuno-client':'desktop'},
        method='GET' if data is None else 'POST')
    try:
        with urllib.request.urlopen(request, timeout=70) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read().decode()
        raise RuntimeError(f'HTTP {error.code} {path}: {body}') from None


def detail(agent_id=REMOTE_ID):
    return api('/api/agents/' + agent_id)


def wait_for(description, predicate, seconds=150):
    began = time.monotonic()
    last_error = None
    while time.monotonic() - began < seconds:
        try:
            result = predicate()
            if result:
                return result
        except (OSError, urllib.error.URLError) as error:
            last_error = str(error)
        if time.monotonic() - LAST_PROGRESS > 20:
            note('Still waiting: ' + description)
        time.sleep(0.25)
    raise TimeoutError(description + (': ' + last_error if last_error else ''))


def pause(seconds, description):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if time.monotonic() - LAST_PROGRESS > 15:
            note(description + f' ({max(0, int(until-time.monotonic()))} s remaining)')
        time.sleep(min(1, max(0, until-time.monotonic())))


def checked_agent():
    result = detail()
    configured = json.loads(STATE.read_text())['agents']
    original = next(a for a in configured if a['id'] == REMOTE_ID)
    agent = result['agent']
    for key in ('id','cwd','threadId'):
        if agent[key] != original[key]:
            raise RuntimeError('Remote lab identity changed: ' + key)
    remote_home = Path(os.environ.get('YUZUNO_REMOTE_HOME', ''))
    if not remote_home.is_absolute() or '..' in remote_home.parts:
        raise RuntimeError('Set YUZUNO_REMOTE_HOME to the authorized remote lab user home')
    namespace = remote_home / '.yuzuno-next/runtimes'
    runtime_root = Path(agent['remote']['runtime']['root'])
    if '..' in runtime_root.parts or runtime_root == namespace or not runtime_root.is_relative_to(namespace):
        raise RuntimeError('Runtime is not in the lab user namespace')
    for key in ('root','socket'):
        if agent['remote']['runtime'][key]!=original['remote']['runtime'][key]:
            raise RuntimeError('Runtime escaped the original lab directory: '+key)
    if agent['remote']['machine']['target'] != os.environ.get('YUZUNO_SSH_TARGET', 'tester@192.0.2.10'):
        raise RuntimeError('Unexpected remote host')
    return result


def owned_core():
    process = lab.owned_process()
    if not process:
        raise RuntimeError('The isolated lab Core is not running')
    if process['pid'] == 2241574 or '4317' in process['argv']:
        raise RuntimeError('Refusing daily Core process control')
    return process


def children(core_pid, socket):
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / 'stat').read_text().rsplit(') ', 1)[1].split()
            current = lab.process_info(int(entry.name))
            if int(stat[1]) == core_pid and current and '-N' in current['argv'] and '-L' in current['argv']:
                index = current['argv'].index('-L')
                if current['argv'][index+1].endswith(':' + socket):
                    found.append(current)
        except (FileNotFoundError, ProcessLookupError):
            pass
    if len(found) != 1:
        raise RuntimeError('Expected exactly one owned SSH tunnel, found ' + str(len(found)))
    return found


@contextlib.contextmanager
def broken_tunnel(runtime):
    core = owned_core()
    tunnels = children(core['pid'], runtime['socket'])
    os.kill(core['pid'], signal.SIGSTOP)
    try:
        for tunnel in tunnels:
            current = lab.process_info(tunnel['pid'])
            if not current or current['startTicks'] != tunnel['startTicks'] or current['argv'] != tunnel['argv']:
                raise RuntimeError('Tunnel identity changed before signal')
            os.kill(tunnel['pid'], signal.SIGTERM)
        CURRENT.setdefault('tunnelBreaks', []).append({'core':core, 'tunnels':tunnels, 'at':now()})
        save()
        yield
    finally:
        current = lab.process_info(core['pid'])
        if current and current['startTicks'] == core['startTicks'] and current['argv'] == core['argv']:
            os.kill(core['pid'], signal.SIGCONT)
            note('Resumed only the owned lab Core; automatic reconnect can proceed')


def ssh_python(machine, script):
    result = subprocess.run(['ssh','-T','-o','BatchMode=yes','-o','ConnectTimeout=10',
        '-o','ControlMaster=no','-o','ControlPath=none','-o','StrictHostKeyChecking=yes',
        '-o','UpdateHostKeys=no',machine['target'],'python3 -c ' + shlex.quote(script)],
        text=True, capture_output=True, timeout=25)
    if result.returncode:
        raise RuntimeError('Remote bounded helper failed: ' + result.stderr[-2000:])
    return json.loads(result.stdout)


def stop_runtime(agent, hard=False):
    runtime = agent['remote']['runtime']
    # Confirm the private metadata, birth time and socket before signalling only
    # this specific app-server PID. Never pkill or process-name-wide operations.
    script = '''import json,os,signal,subprocess
from pathlib import Path
expected=EXPECTED
saved=json.loads((Path(expected['root'])/'runtime.json').read_text())
assert all(saved[k]==expected[k] for k in ('pid','root','socket','instanceId'))
p=subprocess.run(['ps','-p',str(expected['pid']),'-o','stat=','-o','lstart=','-o','args='],capture_output=True,text=True,check=True)
state,identity=p.stdout.strip().split(None,1)
assert not state.startswith('Z')
assert ' '.join(identity.split()[:5])==' '.join(saved['processIdentity'].split()[:5])
assert expected['socket'] in identity and 'app-server' in identity
if HARD:
    # The JS launcher may own a native child. Select only its own executable
    # with this exact private socket; never kill a process group or all Codexes.
    rows=subprocess.check_output(['ps','-axo','pid=,ppid=,lstart=,args='],text=True).splitlines()
    candidates=[]
    for row in rows:
        fields=row.strip().split(None,7)
        if len(fields)!=8: continue
        pid,parent=int(fields[0]),int(fields[1])
        started=' '.join(fields[2:7]); command=fields[7]
        executable=command.split()[0]
        if (pid==expected['pid'] or parent==expected['pid']) and Path(executable).name=='codex' and expected['socket'] in command and 'app-server' in command:
            candidates.append((pid,started))
    assert len(candidates)==1,candidates
    target,started=candidates[0]
    current=subprocess.check_output(['ps','-p',str(target),'-o','lstart=','-o','args='],text=True).strip()
    assert ' '.join(current.split()[:5])==started and expected['socket'] in current and 'app-server' in current
    os.kill(target,signal.SIGKILL)
    print(json.dumps({'hardKilledOwnedNativePid':target,'launcherPid':expected['pid'],'birth':started,'instanceId':expected['instanceId']}))
else:
    os.kill(expected['pid'],signal.SIGTERM)
    print(json.dumps({'signalledOwnedPid':expected['pid'],'instanceId':expected['instanceId']}))
'''.replace('EXPECTED', repr(runtime)).replace('HARD', repr(hard))
    return ssh_python(agent['remote']['machine'], script)


def send_task(prompt, key='turn'):
    before = checked_agent()
    if before['agent']['status'] in ('offline','uncertain'):
        api('/api/agents/' + REMOTE_ID + '/reconnect', {})
        before = checked_agent()
    if before['agent']['status'] not in ('idle','error') or any(t['status']=='inProgress' for t in before['turns']):
        raise RuntimeError('Existing remote work is active; task was not sent')
    CURRENT[key] = {'intentAt':now(), 'prompt':prompt, 'before':before}
    save()  # Crash or HTTP uncertainty never triggers automatic resubmission.
    reply = api('/api/agents/' + REMOTE_ID + '/turns', {'text':prompt})
    CURRENT[key]['response'] = reply
    save()
    return reply['turnId']


def turn_of(data, turn_id):
    return next((turn for turn in data['turns'] if turn['id']==turn_id), None)


def started(turn_id):
    data = checked_agent()
    turn = turn_of(data, turn_id)
    commands = [item for item in (turn or {}).get('items',[]) if item['type']=='commandExecution' and item.get('status')=='inProgress']
    if commands:
        return {'detail':data,'command':commands[-1]}


def completed(turn_id):
    data = checked_agent()
    turn = turn_of(data, turn_id)
    if turn and turn['status'] in ('completed','failed','interrupted'):
        return data


def completion_count(turn_id):
    with sqlite3.connect('file:' + str(LAB/'core-data/workspace.sqlite') + '?mode=ro', uri=True) as db:
        return db.execute("SELECT COUNT(*) FROM journal WHERE agent_id=? AND kind='turn/completed' AND json_extract(data,'$.turn.id')=?",(REMOTE_ID,turn_id)).fetchone()[0]


def same_session(before, after, runtime_same=True):
    for key in ('id','threadId','cwd'):
        assert before['agent'][key] == after['agent'][key], key
    if runtime_same:
        assert before['agent']['remote']['runtime']['instanceId'] == after['agent']['remote']['runtime']['instanceId']


def offline():
    marker = 'offline-' + uuid.uuid4().hex[:10] + '.txt'
    command = 'python3 -c ' + shlex.quote("import time,pathlib; time.sleep(25); pathlib.Path("+repr(marker)+").write_text('YUZUNO_REMOTE_OFFLINE_OK'); print('YUZUNO_REMOTE_OFFLINE_OK')")
    turn_id = send_task('Bounded acceptance in this cwd only. Run exactly this command with exec_command, wait for completion, then reply exactly YUZUNO_REMOTE_OFFLINE_OK. Do not run any other command or inspect files: '+command)
    observed = wait_for('remote command begins', lambda: started(turn_id))
    CURRENT['started'] = observed
    agent = observed['detail']['agent']
    with broken_tunnel(agent['remote']['runtime']):
        note('Remote command started; SSH closed and only lab Core paused for 35 seconds')
        pause(35, 'Remote execution continuing without a client')
        source = str(Path(agent['cwd'])/marker)
        CURRENT['offlineArtifact'] = ssh_python(agent['remote']['machine'], 'import json,pathlib\np=pathlib.Path('+repr(source)+')\nprint(json.dumps({"exists":p.exists(),"text":p.read_text() if p.exists() else None}))')
        assert CURRENT['offlineArtifact']['text'] == 'YUZUNO_REMOTE_OFFLINE_OK'
    after = wait_for('automatic recovery and original Turn completion', lambda: completed(turn_id))
    CURRENT['after'] = after
    same_session(observed['detail'], after)
    assert after['agent']['connectionState']=='connected'
    assert completion_count(turn_id)==1
    catchup = api('/api/catchup')
    assert any(item.get('turnId')==turn_id for item in catchup['items'])
    CURRENT['catchup'] = catchup
    CURRENT['checks'] = {'offlineArtifactExists':True,'sameAgentThreadRuntime':True,'oneCompletionJournal':True,'catchupHasRecoveredTurn':True}


def approval(approval_mode):
    turn_id = send_task('Bounded approval recovery test. First run exactly `/bin/sleep 12` using exec_command with default permissions and wait until it finishes. Then call exec_command with command exactly `printf YUZUNO_REMOTE_APPROVAL_OK`, sandbox_permissions `require_escalated`, justification `Yuzuno lab: allow printing this fixed marker?`. You must request this explicit human approval, never print the marker with default permissions. After approval and command completion reply exactly YUZUNO_REMOTE_APPROVAL_DONE. Run no other commands; work only in this cwd.')
    observed = wait_for('approval prelude sleep starts', lambda: started(turn_id))
    agent = observed['detail']['agent']
    with broken_tunnel(agent['remote']['runtime']):
        note('Disconnected before the fixed print approval is generated')
        pause(22, 'Waiting for a native approval while disconnected')
    def live_pending():
        data=checked_agent()
        pending=next((p for p in data['pending'] if p['params'].get('turnId')==turn_id and not p['stale']),None)
        return {'detail':data,'pending':pending} if pending else None
    first=wait_for('native approval replay',live_pending)
    request=first['pending']
    command=request['params'].get('command','')
    parts=shlex.split(command)
    if len(parts)==3 and parts[0] in ('/bin/zsh','/bin/bash','/bin/sh') and parts[1]=='-lc':
        parts=shlex.split(parts[2])
    assert parts==['printf','YUZUNO_REMOTE_APPROVAL_OK'], 'Unexpected approval command; nothing approved'
    assert request['params'].get('cwd')==agent['cwd'], 'Unexpected approval cwd'
    assert request['method']=='item/commandExecution/requestApproval'
    CURRENT['firstReplay']=first
    # Mark only this lab view reviewed so replay cannot masquerade as new unread.
    api('/api/agents/'+REMOTE_ID+'/review',{'throughSeq':first['detail']['agent']['lastSeq']})
    CURRENT['beforeSecondDisconnect']=checked_agent()
    with broken_tunnel(agent['remote']['runtime']):
        pause(0.5,'Breaking the same lab tunnel again')
    stale_error=None
    began=time.monotonic()
    while time.monotonic()-began<3:
        data=checked_agent()
        old=next((p for p in data['pending'] if p['id']==request['id']),None)
        if old is None or old.get('stale'):
            try:
                api('/api/requests/'+request['id']+'/respond',{'response':{'decision':'accept'}})
            except RuntimeError as error:
                stale_error=str(error)
            else:
                raise AssertionError('Old disconnected request unexpectedly accepted')
            break
        time.sleep(0.02)
    assert stale_error, 'Could not observe and check obsolete approval safely'
    CURRENT['staleResponseRejected']=stale_error
    second=wait_for('same approval replays on the next connection',live_pending)
    assert second['pending']['id']!=request['id'], 'Cross-generation replay invalidates old page actions'
    assert second['pending']['params']['_runtimeGeneration']!=request['params']['_runtimeGeneration']
    assert second['pending']['params']['itemId']==request['params']['itemId']
    assert len([p for p in second['detail']['pending'] if p['params'].get('turnId')==turn_id])==1
    assert second['detail']['agent']['unreadCount']==0, 'Repeated approval became unread again'
    CURRENT['secondReplay']=second
    save()
    finish_approval(turn_id, request, second, approval_mode)


def finish_approval(turn_id, request, second, approval_mode):
    if approval_mode=='api':
        # A single explicit decision for the exact previously checked print.
        assert second['pending']['params']['command']==request['params']['command']
        api('/api/requests/'+second['pending']['id']+'/respond',{'response':{'decision':'accept'}})
        CURRENT['approvalMethod']='single bounded API accept'
        note('Accepted only the exact fixed printf approval, once')
    else:
        CURRENT['approvalMethod']='GUI pending; runner will not approve'
        note('APPROVAL_READY: approve fixed printf YUZUNO_REMOTE_APPROVAL_OK in lab GUI only')
    after=wait_for('approved Turn completes',lambda:completed(turn_id),seconds=300)
    turn=turn_of(after,turn_id)
    assert turn['status']=='completed'
    assert any(i.get('type')=='commandExecution' and i.get('exitCode')==0 and 'YUZUNO_REMOTE_APPROVAL_OK' in (i.get('aggregatedOutput') or '') for i in turn['items'])
    assert not any(p['params'].get('turnId')==turn_id for p in after['pending'])
    CURRENT['after']=after
    CURRENT['checks']={'offlineApprovalReplayed':True,'oldRequestRejected':True,'matchingReplayReplacedStale':True,'replayDidNotAddUnread':True,'exactPrintExecutedAfterApproval':True}


def resume_approval(approval_mode):
    """Explicitly continue the existing request after the replay identity fix.

    Sends no new model task, creates no request, and preserves initial failure.
    """
    global CURRENT
    CURRENT=REPORT['stages']['approval']
    if CURRENT.get('state')!='failed' or not CURRENT.get('staleResponseRejected'):
        raise RuntimeError('No failed-but-obsolete-request-checked approval to continue')
    request=CURRENT['firstReplay']['pending']
    data=checked_agent()
    pending=next(p for p in data['pending'] if p['params'].get('turnId')==request['params']['turnId'] and not p['stale'])
    assert pending['id']!=request['id'], 'Old page action must remain invalid after reconnect finishes'
    assert pending['params']['_runtimeGeneration']!=request['params']['_runtimeGeneration']
    for key in ('itemId','turnId','command','cwd'):
        assert pending['params'][key]==request['params'][key]
    assert len(data['pending'])==1 and data['agent']['unreadCount']==0
    try:
        api('/api/requests/'+request['id']+'/respond',{'response':{'decision':'accept'}})
    except RuntimeError as error:
        CURRENT['postReconnectOldUUIDRejected']=str(error)
    else:
        raise AssertionError('Old request UUID unexpectedly authorized a replayed request')
    CURRENT.setdefault('attemptHistory',[]).append({'error':CURRENT.pop('error'),'failedAt':CURRENT.pop('failedAt'),
        'detail':CURRENT.pop('detailAtFailure',None),'explanation':'GUI wait deliberately stopped by root before any approval while cross-generation request identity was fixed.'})
    if 'initialFailure' in CURRENT:
        CURRENT['initialFailure']['explanation']='Cross-generation replay incorrectly reused the UI request UUID. Core now rotates UUID while deduplicating unread independently; original failed evidence retained.'
    CURRENT['state']='running'
    CURRENT['resumedExistingPendingAt']=now()
    second={'detail':data,'pending':pending}
    CURRENT['secondReplay']=second
    save()
    try:
        finish_approval(request['params']['turnId'],request,second,approval_mode)
        CURRENT['state']='passed'
        CURRENT['finishedAt']=now()
        note('Passed approval after replay identity fix; old page action rejected after reconnect, no task resent')
    except BaseException as error:
        CURRENT['state']='failed'
        CURRENT['error']={'type':type(error).__name__,'message':str(error)}
        CURRENT['failedAt']=now()
        save()
        raise


def interrupt(control_mode):
    turn_id=send_task('Bounded interruption test. Run exactly `/bin/sleep 45` using exec_command with yield_time_ms 30000. Do not run other commands, inspect files, or create background jobs. If the command finishes, reply SLEEP_DONE. Stay in this cwd.')
    observed=wait_for('long sleep begins',lambda:started(turn_id))
    CURRENT['started']=observed
    if control_mode=='api':
        api('/api/agents/'+REMOTE_ID+'/interrupt',{})
        CURRENT['interruptMethod']='bounded API interrupt'
    else:
        CURRENT['interruptMethod']='GUI pending; runner will not interrupt'
        note('INTERRUPT_READY: use Stop for the active sleep Turn in the lab GUI')
    after=wait_for('native interrupted Turn',lambda:completed(turn_id))
    assert turn_of(after,turn_id)['status']=='interrupted'
    same_session(observed['detail'],after)
    CURRENT['after']=after
    CURRENT['checks']={'nativeInterrupted':True,'sameSessionAndRuntime':True}


def core_restart():
    identities=json.loads(STATE.read_text())['agents']
    before={agent['id']:detail(agent['id']) for agent in identities}
    CURRENT['before']=before
    CURRENT['oldCore']=owned_core()
    save()
    lab.stop_core()
    lab.start_core('codex')
    CURRENT['newCore']=owned_core()
    note('Restarted only isolated Core; waiting for automatic remote attachment')
    after_remote=wait_for('automatic remote attach after Core restart',lambda:(lambda d:d if d['agent']['connectionState']=='connected' else None)(checked_agent()))
    same_session(before[REMOTE_ID],after_remote)
    local_after={}
    for agent in identities:
        if agent['id']==REMOTE_ID:continue
        resumed=api('/api/agents/'+agent['id']+'/reconnect',{})
        assert resumed['agent']['threadId']==before[agent['id']]['agent']['threadId']
        assert {t['id'] for t in resumed['turns']} >= {t['id'] for t in before[agent['id']]['turns']}
        local_after[agent['id']]=resumed
    CURRENT['afterRemote']=after_remote
    CURRENT['afterLocal']=local_after
    CURRENT['checks']={'remoteAutoAttachedSameRuntime':True,'bothLocalNativeThreadsResumed':True}


def runtime_restart():
    before=checked_agent()
    assert before['agent']['status']=='idle'
    CURRENT['before']=before
    CURRENT['stop']=stop_runtime(before['agent'])
    note('Stopped only completed lab app-server; automatic resume should retain history')
    def replaced():
        data=checked_agent()
        if data['agent']['connectionState']=='connected' and data['agent']['remote']['runtime']['instanceId']!=before['agent']['remote']['runtime']['instanceId']:
            return data
    after=wait_for('new owned Runtime with old native thread',replaced)
    same_session(before,after,False)
    assert {t['id'] for t in after['turns']} >= {t['id'] for t in before['turns']}
    assert after['agent']['status']=='idle'
    CURRENT['after']=after
    CURRENT['checks']={'newRuntimeInstance':True,'sameAgentAndThread':True,'completedHistoryRetained':True}


def runtime_loss():
    turn_id=send_task('Bounded process-loss test. Run exactly `/bin/sleep 45` using exec_command with yield_time_ms 30000. Do not run other commands, inspect files, or create background jobs. If it finishes reply RUNTIME_LOSS_SLEEP_DONE. Stay in this cwd.')
    observed=wait_for('runtime-loss sleep begins',lambda:started(turn_id))
    CURRENT['started']=observed
    CURRENT['stop']=stop_runtime(observed['detail']['agent'],hard=True)
    note('Hard-killed only the owned native lab app-server; checking honest interrupted/unknown recovery')
    def replaced():
        data=checked_agent()
        if data['agent']['connectionState']=='connected' and data['agent']['remote']['runtime']['instanceId']!=observed['detail']['agent']['remote']['runtime']['instanceId']:
            return data
    after=wait_for('replacement after mid-turn Runtime loss',replaced)
    same_session(observed['detail'],after,False)
    turn=turn_of(after,turn_id)
    CURRENT['after']=after
    assert turn, 'Original incomplete Turn disappeared'
    terminal=turn['status'] in ('interrupted','failed','completed')
    honest_unknown=after['agent']['status']=='uncertain'
    assert terminal or honest_unknown, 'Recovery claimed active work without new execution evidence'
    CURRENT['checks']={'newRuntimeInstance':True,'sameNativeThread':True,'nativeTurnStatus':turn['status'],'workspaceStatus':after['agent']['status'],'losslessExecutionResumeClaimed':False,'historicalCommandStatuses':[{'id':item['id'],'status':item.get('status'),'exitCode':item.get('exitCode')} for item in turn['items'] if item.get('type')=='commandExecution'],'toolCompletionInferredFromTurnStatus':False}


def resume_runtime_loss():
    """Resume observation of the original crashed Turn; never send a new task."""
    global CURRENT
    CURRENT=REPORT['stages']['runtime-loss']
    if CURRENT.get('state')!='failed' or not CURRENT.get('stop',{}).get('hardKilledOwnedNativePid'):
        raise RuntimeError('No previously observed hard crash to continue')
    CURRENT.setdefault('attemptHistory',[]).append({'error':CURRENT.pop('error'),'failedAt':CURRENT.pop('failedAt'),
        'detail':CURRENT.pop('detailAtFailure',None),'explanation':'Stopped observation after discovering the real macOS native shortened-socket symlink recovery bug; helper fixed before continuing this same Turn.'})
    CURRENT['state']='running'
    CURRENT['resumedExistingTurnAt']=now()
    before=CURRENT['started']['detail']
    turn_id=CURRENT['turn']['response']['turnId']
    note('Continuing original crashed Turn recovery after helper fix; no model task resent')
    try:
        def replaced():
            data=checked_agent()
            if data['agent']['connectionState']=='connected' and data['agent']['remote']['runtime']['instanceId']!=before['agent']['remote']['runtime']['instanceId']:
                return data
        after=wait_for('replacement after fixing stale native socket link',replaced)
        CURRENT['after']=after
        same_session(before,after,False)
        turn=turn_of(after,turn_id)
        assert turn, 'Original incomplete Turn disappeared'
        assert turn['status'] in ('interrupted','failed','completed') or after['agent']['status']=='uncertain', 'Recovery claimed active work without new execution evidence'
        CURRENT['checks']={'newRuntimeInstance':True,'sameNativeThread':True,'nativeTurnStatus':turn['status'],'workspaceStatus':after['agent']['status'],'losslessExecutionResumeClaimed':False,'historicalCommandStatuses':[{'id':item['id'],'status':item.get('status'),'exitCode':item.get('exitCode')} for item in turn['items'] if item.get('type')=='commandExecution'],'toolCompletionInferredFromTurnStatus':False}
        CURRENT['state']='passed'
        CURRENT['finishedAt']=now()
        note('Passed hard-crash recovery after native socket-link fix')
    except BaseException as error:
        CURRENT['state']='failed'
        CURRENT['error']={'type':type(error).__name__,'message':str(error)}
        CURRENT['failedAt']=now()
        save()
        raise


def main():
    global REPORT,CURRENT
    parser=argparse.ArgumentParser()
    parser.add_argument('--stage',choices=['all','offline','approval','approval-finish','interrupt','core-restart','runtime-restart','runtime-loss','runtime-loss-finish'],default='all')
    parser.add_argument('--approval-mode',choices=['gui','api'],default='gui')
    args=parser.parse_args()
    stages={'offline':offline,'approval':lambda:approval(args.approval_mode),'interrupt':lambda:interrupt(args.approval_mode),'core-restart':core_restart,'runtime-restart':runtime_restart,'runtime-loss':runtime_loss}
    REPORT=json.loads(RESULTS.read_text()) if RESULTS.exists() else {'kind':'real multi-agent runtime acceptance','createdAt':now(),'baseUrl':BASE,'agentId':REMOTE_ID,'stages':{},'noDailyCoreOrWindowOperations':True}
    owned_core()
    checked_agent()
    if args.stage=='approval-finish':
        resume_approval(args.approval_mode)
        return
    if args.stage=='runtime-loss-finish':
        resume_runtime_loss()
        return
    for name,operation in stages.items():
        if args.stage not in ('all',name):continue
        existing=REPORT['stages'].get(name)
        if existing:
            if existing.get('state')=='passed':
                print('Already passed; not repeated: '+name,flush=True)
                continue
            raise RuntimeError('Stage has existing intent/evidence; review before retry, no task resent: '+name)
        CURRENT={'state':'running','startedAt':now()}
        REPORT['stages'][name]=CURRENT
        note('Starting '+name)
        try:
            operation()
            CURRENT['state']='passed'
            CURRENT['finishedAt']=now()
            note('Passed '+name)
        except BaseException as error:
            CURRENT['state']='failed'
            CURRENT['error']={'type':type(error).__name__,'message':str(error)}
            CURRENT['failedAt']=now()
            with contextlib.suppress(Exception): CURRENT['detailAtFailure']=checked_agent()
            save()
            raise
    REPORT['updatedAt']=now()
    CURRENT=None
    save()


if __name__=='__main__':main()
