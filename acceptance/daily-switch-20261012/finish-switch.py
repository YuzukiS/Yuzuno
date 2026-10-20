from pathlib import Path
import hashlib,json,os,shutil,signal,sqlite3,subprocess,time,urllib.request,datetime
ROOT=(Path.home() / 'yuzuno-next');OUT=ROOT/'acceptance/daily-switch-20261012'
record=json.loads((OUT/'switch.json').read_text());old=record['oldProcess'];opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def save(): (OUT/'switch.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
def identity(pid):
 try:
  p=Path('/proc')/str(pid);raw=(p/'stat').read_text();v=raw[raw.rfind(')')+2:].split()
  if v[0]=='Z':return None
  return {'pid':pid,'startTicks':v[19],'argv':(p/'cmdline').read_bytes().decode().rstrip('\0').split('\0')}
 except (FileNotFoundError,ProcessLookupError):return None
def same(pid,expected):return identity(pid)=={k:expected[k] for k in ('pid','startTicks','argv')}
def api(path):
 with opener.open('http://127.0.0.1:4317/api'+path,timeout=5) as r:return json.load(r)
def hashes(folder):return {str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.rglob('*') if p.is_file()}
assert record["status"]=="original-core-stopped"
assert identity(old["pid"]) is None
env=dict(os.environ)
stage=ROOT/"web/dist.switch-staged"
assert stage.is_dir()
# Final WAL-aware backup after all original writes have ceased.
db=Path(record['dataDir'])/'workspace.sqlite'
with sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True) as src,sqlite3.connect(OUT/'workspace-cutover.sqlite') as dst:
 src.backup(dst);assert dst.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
 if dst.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_meta'").fetchone():
  row=dst.execute("SELECT value FROM workspace_meta WHERE key='workspaceId'").fetchone();record['workspaceId']=row[0] if row else None
 else:record['workspaceId']=None
 record['legacyWorkspaceMetadata']=record['workspaceId'] is None
 snapshots={aid:json.loads(raw) for aid,raw in dst.execute('SELECT id,data FROM agents')}
 (OUT/'cutover-details.json').write_text(json.dumps(snapshots,ensure_ascii=False))
retired=OUT/'retired-web-dist';(ROOT/'web/dist').rename(retired);stage.rename(ROOT/'web/dist')
child=None
try:
 with (ROOT/'acceptance/live/core.log').open('ab') as log:
  child=subprocess.Popen(old['argv'],cwd=old['cwd'],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
 for _ in range(100):
  current=identity(child.pid)
  if current and current['argv']==old['argv']:break
  if child.poll() is not None:raise RuntimeError('New Core exited during startup')
  time.sleep(.05)
 assert current and current['argv']==old['argv']
 record['newProcess']=current;record['status']='new-core-starting';save()
 for _ in range(100):
  try:
   if api('/health').get('application')=='yuzuno-next':break
  except OSError:pass
  if child.poll() is not None:raise RuntimeError('New Core exited; see daily core.log')
  time.sleep(.1)
 else:raise RuntimeError('New Core health check timed out')
 after=api('/workspace');assert {a['id'] for a in after['agents']}==set(snapshots),'Agent list changed'
 for a in after['agents']:
  before=snapshots[a['id']];d=api('/agents/'+a['id'])
  for key in ('id','name','cwd','threadId','claudeSessionId'):assert d['agent'].get(key)==before['agent'].get(key),(a['name'],key)
  assert d['turns']==before['turns'],a['name']+' transcript changed during startup'
  assert d['agent']['reviewedSeq']==before['agent']['reviewedSeq'],a['name']+' read cursor changed'
  assert 'workSummary' in d['agent'] or not d['turns']
 with opener.open('http://127.0.0.1:4317/',timeout=5) as r:assert r.read()==(ROOT/'web/dist/index.html').read_bytes()
 record['status']='switched-awaiting-native-reconnect';record['startupVerifiedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
 (ROOT/'acceptance/live/core.pid').write_text(str(child.pid)+'\n')
 (ROOT/'acceptance/live/core-process.json').write_text(json.dumps({**current,'baseUrl':'http://127.0.0.1:4317','dataDir':record['dataDir'],'switchRecord':str(OUT/'switch.json')},indent=2)+'\n')
 print(json.dumps({'newCorePid':child.pid,'agentsPreserved':len(snapshots),'transcripts':'exact match at startup','sameWorkspaceId':record['workspaceId'],'status':record['status']},ensure_ascii=False))
except Exception as error:
 # Startup rollback keeps the original database; its consistent backups are separate.
 if child and identity(child.pid):
  assert same(child.pid,record['newProcess']);os.kill(child.pid,signal.SIGTERM);child.wait(timeout=8)
 (ROOT/'web/dist').rename(OUT/'failed-new-web-dist');retired.rename(ROOT/'web/dist')
 binary=ROOT/'target/debug/yuzuno-workspace';tmp=binary.with_suffix('.rollback');shutil.copy2(OUT/'previous-core',tmp);tmp.replace(binary)
 with (ROOT/'acceptance/live/core.log').open('ab') as log:
  restored=subprocess.Popen(old['argv'],cwd=old['cwd'],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
 record['status']='startup-rolled-back';record['error']=str(error);record['rollbackPid']=restored.pid;save()
 (ROOT/'acceptance/live/core.pid').write_text(str(restored.pid)+'\n')
 raise
