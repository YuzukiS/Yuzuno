"""One-shot upgrade after the user rebooted WSL; refuses a live daily Core."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
LAB=ROOT/'acceptance/agent-management'
BACKUP=LAB/'daily-pre-upgrade'
DATA=ROOT/'acceptance/live/core-data'
BINARY=ROOT/'target/debug/yuzuno-workspace'
ASSETS=ROOT/'web/dist'
RECORD=LAB/'deployment.json'
assert not RECORD.exists(), 'One-shot deployment record already exists'
assert len(subprocess.check_output(['ss','-ltnp','sport = :4317'],text=True).strip().splitlines())==1, 'Daily port is occupied; no running Core will be stopped'
assert (BACKUP/'core').is_file() and (BACKUP/'workspace.sqlite').is_file()
with sqlite3.connect('file:'+str(DATA/'workspace.sqlite')+'?mode=ro',uri=True) as db:
    before={aid:json.loads(raw) for aid,raw in db.execute('SELECT id,data FROM agents')}
    with sqlite3.connect(LAB/'workspace-at-upgrade.sqlite') as snapshot:db.backup(snapshot)
(LAB/'details-at-upgrade.json').write_text(json.dumps(before,ensure_ascii=False,indent=2)+'\n')
def identity(pid):
    try:
        proc=Path('/proc')/str(pid); raw=(proc/'stat').read_text(); fields=raw[raw.rfind(')')+2:].split()
        if fields[0]=='Z': return None
        return {'pid':pid,'startTicks':fields[19],'argv':(proc/'cmdline').read_bytes().decode().rstrip('\0').split('\0')}
    except FileNotFoundError:return None
def api(path):
    with urllib.request.urlopen('http://127.0.0.1:4317/api'+path,timeout=5) as response:return json.load(response)
stage=ROOT/'web/dist.management-stage'
assert not stage.exists()
shutil.copytree(LAB/'web-dist',stage)
shutil.copy2('/tmp/yuzuno-next-management-target/debug/yuzuno-workspace',BINARY.with_suffix('.management-stage'))
BINARY.with_suffix('.management-stage').replace(BINARY)
ASSETS.rename(BACKUP/'retired-live-web-dist');stage.rename(ASSETS)
argv=[str(BINARY),'--port','4317','--data-dir',str(DATA),'--cwd',str(ROOT/'acceptance/live/task'),'--web-dir',str(ASSETS)]
record={'status':'starting','reason':'User rebooted WSL; no daily process was running','startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'dataDir':str(DATA),'backup':str(BACKUP)}
RECORD.write_text(json.dumps(record,indent=2)+'\n')
with (ROOT/'acceptance/live/core.log').open('ab') as log:
    child=subprocess.Popen(argv,cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
for _ in range(100):
    current=identity(child.pid)
    if current and current['argv']==argv:break
    assert child.poll() is None, 'New daily Core exited'
    time.sleep(.01)
assert current and current['argv']==argv
record['process']=current
RECORD.write_text(json.dumps(record,indent=2)+'\n')
for _ in range(100):
    try:
        assert api('/health')['application']=='yuzuno-next';break
    except OSError:
        assert child.poll() is None,'New daily Core exited';time.sleep(.1)
else:raise RuntimeError('Daily Core not ready; backup retained')
workspace=api('/workspace')
assert {a['id'] for a in workspace['agents']}==set(before)
for a in workspace['agents']:
    old=before[a['id']]; new=api('/agents/'+a['id'])
    for key in ('id','name','cwd','harness','threadId','claudeSessionId'):
        assert new['agent'].get(key)==old['agent'].get(key),(a['name'],key)
    assert new['turns']==old['turns'],a['name']+' transcript changed during startup'
    assert new['agent']['reviewedSeq']==old['agent']['reviewedSeq']
with urllib.request.urlopen('http://127.0.0.1:4317/',timeout=5) as response:
    assert response.read()==(ASSETS/'index.html').read_bytes()
record.update(status='running',agentsPreserved=len(before),transcripts='Exact startup match',nativeWorkSent=False,
    binarySha256=hashlib.sha256(BINARY.read_bytes()).hexdigest())
RECORD.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
(ROOT/'acceptance/live/core.pid').write_text(str(child.pid)+'\n')
(ROOT/'acceptance/live/core-process.json').write_text(json.dumps({**current,'baseUrl':'http://127.0.0.1:4317','dataDir':str(DATA),'switchRecord':str(RECORD)},indent=2)+'\n')
print(json.dumps({'pid':child.pid,'agentsPreserved':len(before),'transcripts':'Exact startup match','url':'http://localhost:4317'}))
