#!/usr/bin/env python3
"""Bounded real Harness acceptance against the separately started 4379 Core.

Creates only new Agents in this lab and records their IDs. Never restarts the
daily Core. No approvals are auto-accepted. Run cleanup after browser inspection.
"""
import json
from pathlib import Path
import sys
import time
import urllib.request
import urllib.error
import uuid

LAB = Path(__file__).resolve().parent
BASE = 'http://127.0.0.1:4379/api'
MANIFEST = LAB / 'native-state.json'

def api(path, body=None):
    request = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type':'application/json','X-Yuzuno-Client':'desktop'})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)

def call(operation, **args):
    if operation not in ['task_list','task_get','peer_read','peers_list']:
        args.setdefault('requestId', str(uuid.uuid4()))
    return api('/collaboration/' + operation, args)

def save(value):
    MANIFEST.write_text(json.dumps(value, ensure_ascii=False, indent=2))

def wait(check, label, seconds=150):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        result=check()
        if result: return result
        time.sleep(1)
    raise RuntimeError('Timed out: '+label)

def ready(agent_id):
    d=api('/agents/'+agent_id)
    if d['agent']['status'] in ['error','uncertain'] and d['agent'].get('error'):
        raise RuntimeError(d['agent']['error'])
    if any(not r.get('stale') for r in d['pending']):
        raise RuntimeError('Native approval requires inspection; no auto-approval: '+agent_id)
    return d if d['agent']['status']=='idle' and d['agent']['connectionState']=='connected' else None

def local():
    assert not MANIFEST.exists(), 'One-shot lab: preserve existing acceptance history'
    (LAB/'task').mkdir(exist_ok=True)
    (LAB/'task'/'AGENTS.md').write_text('This is an isolated Yuzuno collaboration acceptance. Use only the Yuzuno MCP tools requested by the user. Do not run shell commands, change files, or change any service/configuration. Keep the same task ID across turns.\n')
    manifest={'agents':[], 'checks':[], 'kind':'real Codex + Claude, no mock runtime'}
    save(manifest)
    for name,harness,model in [('Mikan · collaboration','codex','gpt-6.1-sol'),('Mori · reviewer','claude','haiku')]:
        a=api('/agents',{'name':name,'harness':harness,'model':model,'cwd':str(LAB/'task')})
        manifest['agents'].append(a['id']); save(manifest)
        wait(lambda:ready(a['id']),name)
        print('Ready:', name, flush=True)
    sender,reviewer=manifest['agents']
    task=call('task_create',title='验证 Codex 与 Claude 共用一个协作任务',description='Codex 发出核对请求；Claude 在同一任务提交结论并回复。卡片保留目标，原始执行可回溯。')['task']
    manifest['taskId']=task['id']; save(manifest)
    call('task_dispatch',taskId=task['id'],expectedVersion=task['version'],toAgentId=sender,
        body=f'Use only Yuzuno MCP. Read this task. Send exactly one peer_send to Agent {reviewer}, linked to task {task["id"]}, asking it to verify 17 × 19 = 323, submit task_submit_result with status review and a short Chinese conclusion on this same task, then send you exactly one peer reply linked to the received message. Do not submit the result yourself. Finish this turn after sending. When its result arrives later, read it and finish without another peer message. Do not create tasks, invoke shell/file tools, or reply merely to acknowledge receipt.')
    verify(manifest)

def verify(manifest):
    sender,reviewer=manifest['agents'][:2]
    task={'id':manifest['taskId']}
    def result():
        for agent_id in manifest['agents']:
            d=api('/agents/'+agent_id)
            if d['pending']: raise RuntimeError('Pending native approval: '+agent_id)
        return call('task_get',taskId=task['id'])['task']['result']
    outcome=wait(result,'Claude result',240)
    assert outcome['reportedBy']['id']==reviewer, outcome
    for agent_id in manifest['agents']: wait(lambda:ready(agent_id), 'idle after collaboration',180)
    time.sleep(12) # More than the minimum doorbell interval: detect receipt-only loops.
    for agent_id in manifest['agents']: wait(lambda:ready(agent_id), 'settled collaboration',90)
    detail=call('task_get',taskId=task['id'])
    tasks=call('task_list')['tasks']
    assert len(tasks)==1 and detail['task']['status']=='review'
    assert {e['agentId'] for e in detail['executions']}==set(manifest['agents'])
    mail=call('peer_read')['messages']
    expected=manifest.get('expectedMessages',3)
    assert len(mail)==expected, 'Unexpected messages / reply loop: '+str(len(mail))
    assert len({m['id'] for m in mail})==expected
    manifest['checks'] += ['real MCP read/send/reply across Codex and Claude','same task through implementation and review','task result linked to native turns',f'{expected} messages, no receipt-only loop']
    manifest['task']=detail
    manifest['messages']=mail
    manifest['turnCounts']={a:len(api('/agents/'+a)['turns']) for a in manifest['agents']}
    save(manifest)
    print(json.dumps({'checks':manifest['checks'],'turnCounts':manifest['turnCounts']},ensure_ascii=False),flush=True)

def resume():
    manifest=json.loads(MANIFEST.read_text())
    for index,agent_id in enumerate(manifest['agents'][:]):
        try:
            api('/agents/'+agent_id+'/reconnect',{})
        except urllib.error.HTTPError as error:
            message=error.read().decode()
            detail=api('/agents/'+agent_id)
            if index!=1 or detail['turns'] or 'No conversation found' not in message: raise
            # Preserve this unrelated empty-session observation. No production
            # recovery code is changed to make this MCP acceptance pass.
            api('/agents/'+agent_id+'/close',{})
            manifest['emptyClaudeSessionObservation']={'agentId':agent_id,'error':message,'nativeTurns':0}
            fresh=api('/agents',{'name':'Mori · reviewer','harness':'claude','model':'haiku','cwd':str(LAB/'task')})
            agent_id=fresh['id'];manifest['agents'][index]=agent_id;save(manifest)
        wait(lambda:ready(agent_id),'resume same native session')
    api('/agents/'+manifest['agents'][0]+'/turns',{'text':f'The built-in Yuzuno MCP grant is now configured. Read your existing mailbox with afterSeq 0 and carry out its original collaboration request on the same task. Correction: the reviewer Agent ID is now {manifest["agents"][1]}; use this instead of the old reviewer ID in that initial mail. No new tasks, shell, or file tools. Do not resend any message already recorded in the mailbox.'})
    verify(manifest)

def cleanup():
    manifest=json.loads(MANIFEST.read_text())
    for agent_id in manifest['agents']:
        d=api('/agents/'+agent_id)
        if not d['agent'].get('closedAt'):
            if d['agent']['status']=='working': api('/agents/'+agent_id+'/interrupt',{})
            wait(lambda:ready(agent_id),'finish before close',90)
            api('/agents/'+agent_id+'/close',{})
    print('Closed only lab Agents; history retained')

def retry_mail():
    manifest=json.loads(MANIFEST.read_text())
    manifest['notificationObservation']='Initial Haiku turn asked permission to fetch; explicit built-in Workspace protocol and active mailbox instruction added.'
    manifest['expectedMessages']=4;save(manifest)
    for agent_id in manifest['agents']:
        api('/agents/'+agent_id+'/reconnect',{})
        wait(lambda:ready(agent_id),'resume existing native session')
    call('peer_send',toAgentId=manifest['agents'][1],taskId=manifest['taskId'],
        body='Continue the original verification request in your mailbox. Read from afterSeq=0 if needed. Use Yuzuno MCP task_get then task_submit_result on the SAME task with status review, verify 17 × 19 = 323 and a concise Chinese conclusion. Send exactly one useful peer reply to the original requesting Codex Agent (replyTo the original peer request). Do not send an acknowledgement-only message, create new tasks, or ask the user whether to fetch mail.')
    verify(manifest)

if __name__=='__main__':
    {'local':local,'resume':resume,'retry-mail':retry_mail,'cleanup':cleanup}[sys.argv[1]]()
