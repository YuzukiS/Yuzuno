"""Real disposable Agent lifecycle tests; never operates daily Agents.

One-shot state prevents accidental duplicate tasks after an interrupted run.
Native transcripts are retained even when the disposable Workspace Agent is deleted.
"""
import hashlib
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

LAB=Path(__file__).resolve().parent
BASE='http://127.0.0.1:4377/api'
REPORT=LAB/'native-report.json'
STATE=LAB/'native-state.json'
report={'status':'running','checks':[],'agents':[]}

def save(): REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
def check(name, **details):
    report['checks'].append({'name':name,**details});save();print(name,flush=True)
def api(path, data=None, method=None):
    req=urllib.request.Request(BASE+path,data=json.dumps(data).encode() if data is not None else None,
        method=method or ('POST' if data is not None else 'GET'),
        headers={'Content-Type':'application/json','X-Yuzuno-Client':'desktop'})
    with urllib.request.urlopen(req,timeout=90) as response:return json.load(response)
def detail(a):return api('/agents/'+a['id'])
def wait(a, predicate, seconds=150):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        d=detail(a)
        if predicate(d):return d
        if d['agent']['status']=='error':raise RuntimeError(d['agent'].get('error'))
        time.sleep(.2)
    raise TimeoutError(a['name'])
def post(a, op, data=None):return api('/agents/'+a['id']+'/'+op,{} if data is None else data)
def native_files(harness, session):
    base=Path.home()/('.claude/projects' if harness=='claude' else '.codex/sessions')
    return [str(p) for p in base.rglob('*'+session+'*') if p.is_file()]

def exercise(harness, model='', machine_id=None, cwd=None):
    a=api('/agents',{'name':'Management acceptance '+harness+(' remote' if machine_id else ''),
       'harness':harness,'model':model,'cwd':cwd or str(LAB/'task'),**({'machineId':machine_id} if machine_id else {})})
    report['agents'].append({'id':a['id'],'harness':harness,'remote':bool(machine_id)})
    STATE.write_text(json.dumps(report['agents'],indent=2));save()
    path='/agents/'+a['id']
    # Exact replies require no tools, permissions, account changes or project writes.
    post(a,'turns',{'text':'Reply with exactly MANAGEMENT_READY. Do not use tools or change any files.'})
    before=wait(a,lambda d:len(d['turns'])==1 and d['agent']['status']=='idle')
    key='claudeSessionId' if harness=='claude' else 'threadId'
    session=before['agent'][key];assert session
    turns=before['turns']
    files=[] if machine_id else native_files(harness,session)
    assert machine_id or files, 'Native transcript must exist before deletion'
    closed=post(a,'close')
    assert closed['closedAt'] and closed[key]==session
    after=detail(a);assert after['turns']==turns
    assert after['agent']['connectionState']=='disconnected'
    check(harness+(' remote' if machine_id else '')+' idle close preserves native session and history',session=session)
    # A closed Agent must not revive through a message or reconnect endpoint.
    for operation, data in [('turns',{'text':'THIS_CLOSED_TASK_MUST_NOT_RUN'}),('reconnect',{})]:
        try:post(a,operation,data)
        except urllib.error.HTTPError as e:assert e.code==400
        else:raise AssertionError('Closed Agent accepted '+operation)
    reopened=post(a,'reopen');assert not reopened.get('closedAt') and reopened[key]==session
    restored=detail(a);assert restored['turns']==turns
    check(harness+(' remote' if machine_id else '')+' reopen keeps identity and original session',agentId=a['id'])
    if harness=='claude':
        catalog=api(path+'/models')['models'];assert catalog
        selected=next((m for m in catalog if m['model']=='haiku'),catalog[0])['model']
        changed=post(a,'settings',{'model':selected})
        assert changed['model']==selected and changed[key]==session
        try:post(a,'settings',{'model':'yuzuno-invalid-model-must-be-rejected'})
        except urllib.error.HTTPError as e:assert e.code==400
        else:raise AssertionError('Invalid Claude model accepted')
        check('Claude native model list and validated next-turn selection',models=[m['model'] for m in catalog])
    if not machine_id:
        # Close immediately after native turn acceptance; it must stop/settle the turn.
        post(a,'turns',{'text':'Without tools, write 200 numbered lines explaining how a quiet garden grows. Do not change files.'})
        active=wait(a,lambda d:any(t.get('status')=='inProgress' for t in d['turns']),30)
        post(a,'close')
        settled=detail(a)
        assert settled['agent']['closedAt']
        assert all(t.get('status')!='inProgress' for t in settled['turns'])
        assert settled['agent']['pendingCount']==0
        check(harness+' active close settles execution and pending requests')
    removed=api(path,method='DELETE');assert removed['deleted']
    assert all(agent['id']!=a['id'] for agent in api('/workspace')['agents'])
    assert all(Path(f).exists() for f in files)
    check(harness+(' remote' if machine_id else '')+' delete removes only Workspace record',nativeTranscriptPreserved=bool(files) if not machine_id else 'remote transcript retained by helper contract')

try:
    if STATE.exists():raise RuntimeError('One-shot script already has state; inspect existing results instead of resending tasks')
    keeper=LAB/'task/KEEP.txt';original=hashlib.sha256(keeper.read_bytes()).hexdigest()
    catalog=api('/models?harness=claude');assert catalog['models']
    check('Creation catalog comes from native Claude SDK',models=[m['displayName'] for m in catalog['models']])
    if '--remote-only' not in sys.argv:
        exercise('codex')
        claude_model=next((m['model'] for m in catalog['models'] if m['model']=='haiku'),catalog['models'][0]['model'])
        exercise('claude',claude_model)
    if '--remote' in sys.argv or '--remote-only' in sys.argv:
        config=json.loads((LAB/'remote-config.json').read_text())
        machine=api('/machines',config)
        exercise('codex',machine_id=machine['id'],cwd=config['defaultCwd'])
    assert hashlib.sha256(keeper.read_bytes()).hexdigest()==original
    check('Project sentinel unchanged after every close and delete')
    report['status']='passed';save()
except Exception as error:
    report['status']='failed';report['error']=str(error);save();raise
