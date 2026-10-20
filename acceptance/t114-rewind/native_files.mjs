// Real installed Claude SDK/CLI file checkpoint; disposable profile and file.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=await mkdtemp(join(tmpdir(),'t114-native-files-'));
const profile=join(root,'profile');await mkdir(profile);process.env.CLAUDE_CONFIG_DIR=profile;
const {query,getSessionMessages}=await import(pathToFileURL(process.argv[2]).href);
const file=join(root,'fixture.txt');await writeFile(file,'before native write\n');
const report={requests:0,root};let active,release;
const server=createServer(async(req,res)=>{
 let text='';for await(const b of req)text+=b;const body=JSON.parse(text||'{}');
 if(req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":10}');return;}
 report.requests++;
 const results=body.messages?.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='tool_result')||[];
 const toolDone=results.length>=2;const readDone=results.length>=1;
 const tool=readDone?'Write':'Read';
 const block=toolDone?{type:'text',text:''}:{type:'tool_use',id:'toolu_'+tool,name:tool,input:{}};
 const delta=toolDone?{type:'text_delta',text:'Fixture written.'}:{type:'input_json_delta',partial_json:JSON.stringify(readDone?{file_path:file,content:'after native write\n'}:{file_path:file})};
 const events=[{type:'message_start',message:{id:'msg_'+report.requests,type:'message',role:'assistant',content:[],model:'claude-sonnet-4-6',stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}},{type:'content_block_start',index:0,content_block:block},{type:'content_block_delta',index:0,delta},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:toolDone?'end_turn':'tool_use',stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}];
 res.writeHead(200,{'content-type':'text/event-stream'});for(const event of events)res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const env=Object.fromEntries(['PATH','HOME','USER','LOGNAME','SHELL','LANG','TERM'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{CLAUDE_CONFIG_DIR:profile,ANTHROPIC_API_KEY:'t114-isolated-fixture',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION:'false'});
const wait=new Promise(r=>release=r);
async function* input(){yield {type:'user',message:{role:'user',content:'Change the disposable fixture file.'}};await wait;}
try{
 active=query({prompt:input(),options:{cwd:root,pathToClaudeCodeExecutable:process.argv[3],env,model:'claude-sonnet-4-6',tools:['Read','Write'],settingSources:[],persistSession:true,enableFileCheckpointing:true,permissionMode:'default',canUseTool:async(name,input)=>['Read','Write'].includes(name)&&input.file_path===file?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'Only fixture Write allowed'}}});
 const messages=[];
 let ready,failed;const completed=new Promise((resolve,reject)=>{ready=resolve;failed=reject});
 void (async()=>{try{for await(const m of active){messages.push(m);if(m.type==='result')ready();}}catch(e){failed(e);}})();
 await completed;
 report.result=messages.find(m=>m.type==='result');assert.equal(report.result?.is_error,false);
 const session=messages.find(m=>m.session_id)?.session_id;assert.ok(session);
 const before=await getSessionMessages(session,{dir:root});report.beforeMessages=before.length;
 const user=before.find(m=>m.type==='user');assert.ok(user?.uuid);report.userMessageId=user.uuid;
 assert.equal(await readFile(file,'utf8'),'after native write\n');
 report.preview=await active.rewindFiles(user.uuid,{dryRun:true});assert.equal(report.preview.canRewind,true);assert.ok(report.preview.filesChanged.some(p=>p.endsWith('fixture.txt')));
 const requests=report.requests;
 report.restore=await active.rewindFiles(user.uuid);assert.equal(await readFile(file,'utf8'),'before native write\n');
 assert.equal(report.requests,requests,'file restore sent another prompt');
 report.afterMessages=(await getSessionMessages(session,{dir:root})).length;assert.equal(report.afterMessages,report.beforeMessages);
 report.verified=true;
}catch(error){report.error=String(error);}
finally{active?.close();release();server.close();await writeFile(process.argv[4],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({verified:report.verified,error:report.error,report:process.argv[4]}));if(!report.verified)process.exitCode=1;}
