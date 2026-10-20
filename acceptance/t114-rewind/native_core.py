#!/usr/bin/env python3
"""Real Core + real Codex, fresh profile and loopback Responses fixture only."""
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'experiments/runtime'))
from probe_local import Rpc,clean_environment
if len(sys.argv) != 4:
    raise SystemExit('Usage: native_core.py CORE_BINARY WEB_DIR REPORT_JSON')
root=Path(tempfile.mkdtemp(prefix='t114-native-core-'))
profile=root/'profile';profile.mkdir()
report={'root':str(root),'providerRequests':0}
class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length','0')))
        report['providerRequests']+=1
        rid='resp_'+uuid.uuid4().hex;mid='msg_'+uuid.uuid4().hex
        item={'id':mid,'type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':'Native isolated fixture reply.','annotations':[]}]}
        response={'id':rid,'object':'response','status':'completed','output':[item],'usage':{'input_tokens':10,'output_tokens':5,'total_tokens':15}}
        events=[{'type':'response.created','response':dict(response,status='in_progress',output=[])},{'type':'response.output_item.added','output_index':0,'item':dict(item,status='in_progress',content=[])},{'type':'response.content_part.added','item_id':mid,'output_index':0,'content_index':0,'part':{'type':'output_text','text':'','annotations':[]}},{'type':'response.output_text.delta','item_id':mid,'output_index':0,'content_index':0,'delta':'Native isolated fixture reply.'},{'type':'response.output_item.done','output_index':0,'item':item},{'type':'response.completed','response':response}]
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        for event in events:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode())
        self.wfile.flush()
provider=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider)
threading.Thread(target=provider.serve_forever,daemon=True).start()
(profile/'config.toml').write_text(f'''cli_auth_credentials_store = "file"
model_provider = "fixture"
model = "gpt-6.1-sol"
[model_providers.fixture]
name = "T114 isolated fixture"
base_url = "http://127.0.0.1:{provider.server_port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
''')
rpc=Rpc(profile,'t114-user-turns');core=None
def request(path,data=None):
    req=urllib.request.Request(base+'/api'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json','X-Yuzuno-Client':'desktop'})
    with urllib.request.urlopen(req,timeout=50) as response:return json.load(response)
def start_core():
    global core,base
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    base=f'http://127.0.0.1:{port}'
    env=clean_environment();env['CODEX_HOME']=str(profile)
    core=subprocess.Popen([sys.argv[1],'--port',str(port),'--data-dir',str(root/'core'),'--cwd',str(root),'--web-dir',sys.argv[2]],env=env,stdout=(root/'core.log').open('a'),stderr=subprocess.STDOUT,start_new_session=True)
    for _ in range(200):
        try:request('/health');return
        except Exception:time.sleep(.05)
    raise RuntimeError('Isolated Core did not start')
def stop_core():
    global core
    if core:
        os.killpg(core.pid,signal.SIGTERM);core.wait(timeout=10);core=None
try:
    report['initialize']=rpc.initialize()
    start=rpc.call('thread/start',{'cwd':str(root),'approvalPolicy':'never','sandbox':'read-only','ephemeral':False})
    thread=start['result']['thread']['id'];report['thread']=thread
    turns=[]
    for i in range(4):
        started=rpc.call('turn/start',{'threadId':thread,'input':[{'type':'text','text':f'T114 isolated original prompt {i+1}'}]})
        turn=started['result']['turn']['id'];deadline=time.monotonic()+25
        while True:
            event=next((e for e in rpc.events if e.get('method')=='turn/completed' and e.get('params',{}).get('turn',{}).get('id')==turn),None)
            if event:break
            if time.monotonic()>deadline:raise TimeoutError('Native user turn did not complete')
            rpc.events.append(rpc.messages.get(timeout=max(.01,deadline-time.monotonic())))
        assert event['params']['turn']['status']=='completed',event
        turns.append(turn)
    report['turns']=turns
    native_turns=rpc.call('thread/turns/list',{'threadId':thread,'sortDirection':'asc','itemsView':'full','limit':100})['result']['data']
    rpc.close()
    # A later external file effect must survive conversation rewind.
    sentinel=root/'external-effect.txt';sentinel.write_text('keep this file\n')
    start_core()
    agent=request('/codex/sessions/import',{'threadId':thread,'name':'Isolated Rewind','permissionPreset':'config'})
    aid=agent['id'];report['agent']=aid
    request('/agents/'+aid+'/reconnect',{})
    # Inject only a lost-before-dispatch journal into this stopped fixture Core.
    # Resolution then uses real native idle/shutdown/resume/history reads.
    before=request('/agents/'+aid);stop_core()
    operation=str(uuid.uuid4())
    unknown={'id':operation,'agent':aid,'thread':thread,'target':turns[1],'kept':turns[:1],'draft':'T114 isolated original prompt 2','state':'unknown','message':'Injected crash before native dispatch'}
    with sqlite3.connect(root/'core/workspace.sqlite') as db:
        db.execute('INSERT INTO conversation_rewinds VALUES(?,?,?,?,?,?,?)',(operation,aid,'unknown',json.dumps(unknown),json.dumps(native_turns[1:]),json.dumps(before),'2026-10-18T00:00:00Z'))
    start_core();request('/agents/'+aid+'/reconnect',{})
    pending=request('/agents/'+aid+'/rewind/preview',{'turnId':turns[1]})
    assert pending['attempt']['status']=='unknown',pending
    resolved=request('/agents/'+aid+'/rewind/resolve',{'attemptId':operation})
    report['resolvedInjectedUnknown']=resolved
    assert resolved['status']=='resolved',resolved
    assert report['providerRequests']==4,'resolution sent a hidden prompt'
    preview=request('/agents/'+aid+'/rewind/preview',{'turnId':turns[0]})
    report['preview']=preview
    assert preview['available'] and preview['removedTurns']==4 and preview['keptTurns']==0,preview
    requests_before=report['providerRequests']
    result=request('/agents/'+aid+'/rewind/confirm',{'previewId':preview['previewId']});report['result']=result
    assert result['status']=='completed',result
    assert report['providerRequests']==requests_before,'rewind sent a model prompt'
    assert sentinel.read_text()=='keep this file\n'
    assert request('/agents/'+aid)['turns']==[]
    again=request('/agents/'+aid+'/rewind/confirm',{'previewId':preview['previewId']});assert again==result
    stop_core();start_core();request('/agents/'+aid+'/reconnect',{})
    report['afterRestart']=request('/agents/'+aid)
    assert report['afterRestart']['turns']==[]
    assert report['afterRestart']['agent']['lastMessage'] is None
    report['verified']=True
except Exception as error:
    report['error']=str(error)
finally:
    rpc.close();stop_core();provider.shutdown()
    Path(sys.argv[3]).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'verified':report.get('verified'),'error':report.get('error'),'report':sys.argv[3]}))
    if not report.get('verified'):sys.exit(1)
