import asyncio,json,pathlib,os,re
OUT=pathlib.Path(os.environ['YUZUNO_CONTEXT_PROBE_OUTPUT']).resolve()
OUT.mkdir(parents=True,exist_ok=True)
(OUT/'cwd').mkdir(exist_ok=True)
CODEX=os.environ.get('YUZUNO_CONTEXT_PROBE_CODEX','codex')
report={'version':'0.162.1','checks':[]}
class RPC:
 async def start(self):
  self.pending={};self.events=[];self.num=0
  self.p=await asyncio.create_subprocess_exec(CODEX,'app-server','--stdio',cwd=OUT/'cwd',stdin=-1,stdout=-1,stderr=-1,env={**os.environ,'RUST_LOG':'codex_core::codex=debug','NO_COLOR':'1'})
  self.reader=asyncio.create_task(self.read());self.err=asyncio.create_task(self.stderr())
  await self.req('initialize',{'clientInfo':{'name':'yuzuno_context_probe','version':'1'},'capabilities':{'experimentalApi':True}})
  await self.send({'method':'initialized'})
  return self
 async def send(self,d):self.p.stdin.write((json.dumps(d)+'\n').encode());await self.p.stdin.drain()
 async def req(self,m,p):
  self.num+=1; n=self.num;f=asyncio.get_running_loop().create_future();self.pending[n]=f
  await self.send({'id':n,'method':m,'params':p});return await asyncio.wait_for(f,100)
 async def read(self):
  async for line in self.p.stdout:
   try:d=json.loads(line)
   except ValueError:continue
   if 'id'in d and ('result'in d or 'error'in d):
    f=self.pending.pop(d['id'],None)
    if f and not f.done():f.set_result(d)
   elif 'id'in d:await self.send({'id':d['id'],'error':{'code':-32601,'message':'probe refuses tool requests'}})
   else:self.events.append(d)
 async def stderr(self):
  async for line in self.p.stderr:
   s=line.decode(errors='replace')
   # Never retain raw stderr, requests, prompts, headers or credentials.
   nums=dict(re.findall(r'\b(auto_compact[^\s=]*|model_context_window|total_tokens|context_window|token_count)[=:]\s*(\d+)',s))
   if nums:report.setdefault('nativeNumericDiagnostics',[]).append(nums)
 async def turn(self,thread,label):
  start=len(self.events)
  r=await self.req('turn/start',{'threadId':thread,'input':[{'type':'text','text':'Reply with exactly OK. Do not use tools.'}],'effort':'low'})
  if 'error'in r:raise RuntimeError('native turn rejected')
  tid=r['result']['turn']['id']
  async def wait():
   while not any(e.get('method')=='turn/completed' and e['params']['turn']['id']==tid for e in self.events[start:]):await asyncio.sleep(.1)
  await asyncio.wait_for(wait(),130)
  ev=self.events[start:];usage=[e['params']['tokenUsage'] for e in ev if e.get('method')=='thread/tokenUsage/updated']
  terminal=[e['params']['turn']['status'] for e in ev if e.get('method')=='turn/completed']
  report['checks'].append({'label':label,'usage':usage[-1:] ,'terminal':terminal,'compactions':sum(e.get('method')=='thread/compacted' for e in ev)})
 async def stop(self):
  self.p.stdin.close()
  try:await asyncio.wait_for(self.p.wait(),8)
  except TimeoutError:self.p.terminate();await self.p.wait()
  await self.reader;await self.err

def args(window,limit):return {'cwd':str(OUT/'cwd'),'model':'gpt-6-astra','approvalPolicy':'never','sandbox':'read-only','config':{'model_context_window':window,'model_auto_compact_token_limit':limit,'model_reasoning_effort':'low'},'baseInstructions':'You are a minimal configuration probe. Do not use tools; reply OK.'}
async def main():
 r=await RPC().start()
 try:
  c=await r.req('config/read',{'cwd':str(OUT/'cwd'),'includeLayers':False})
  report['configKeys']=[k for k in c.get('result',{}).get('config',{}) if k in ['model_context_window','model_auto_compact_token_limit','model_auto_compact_token_limit_scope']]
  d=await r.req('thread/start',args(872000,700000));assert 'result'in d,'native request rejected'
  thread=d['result']['thread']['id'];report['threadId']=thread
  await r.turn(thread,'start-872000-700000')
  d=await r.req('thread/resume',{'threadId':thread,**args(600000,450000)})
  report['checks'].append({'label':'resume-loaded-response','ok':'result'in d,'errorCode':d.get('error',{}).get('code')})
  if 'result'in d:await r.turn(thread,'resume-loaded-600000-450000')
 finally:await r.stop()
 r=await RPC().start()
 try:
  d=await r.req('thread/resume',{'threadId':thread,**args(600000,450000)});assert 'result'in d,'native request rejected'
  await r.turn(thread,'resume-new-process-600000-450000')
  d=await r.req('thread/unsubscribe',{'threadId':thread});report['checks'].append({'label':'unsubscribe','result':d.get('result'),'errorCode':d.get('error',{}).get('code')})
  d=await r.req('thread/resume',{'threadId':thread,**args(None,None)});report['checks'].append({'label':'resume-null-config','ok':'result'in d,'errorCode':d.get('error',{}).get('code')})
  if 'result'in d:await r.turn(thread,'resume-null-defaults')
 finally:await r.stop()
try:asyncio.run(main())
except Exception as e:report['failureType']=type(e).__name__;raise
finally:
 (OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
