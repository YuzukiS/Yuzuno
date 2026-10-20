// Real installed CLI + pinned SDK, fresh profile, deterministic local API fixture.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const root = await mkdtemp(join(tmpdir(), 't114-claude-'));
const profile = join(root, 'profile'); await mkdir(profile);
process.env.CLAUDE_CONFIG_DIR = profile;
const { query, getSessionMessages } = await import(pathToFileURL(process.argv[2]).href);
const report = { root, requests: [] };
const server = createServer(async (req, res) => {
  let body = ''; for await (const b of req) body += b;
  report.requests.push(req.url);
  if (req.url.includes('count_tokens')) { res.writeHead(200, {'content-type':'application/json'}); res.end('{"input_tokens":10}'); return; }
  const id = 'msg_' + randomUUID().replaceAll('-', '');
  const msg = {id, type:'message', role:'assistant', content:[], model:'claude-sonnet-4-6', stop_reason:null, stop_sequence:null, usage:{input_tokens:10,output_tokens:0}};
  res.writeHead(200, {'content-type':'text/event-stream'});
  for (const event of [
    {type:'message_start',message:msg},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Isolated fixture reply.'}},
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}},
    {type:'message_stop'},
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = Object.fromEntries(['PATH','HOME','USER','LOGNAME','SHELL','LANG','TERM'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env, {CLAUDE_CONFIG_DIR:profile, ANTHROPIC_API_KEY:'t114-local-fixture', ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION:'false'});
const options = {cwd:root,pathToClaudeCodeExecutable:process.argv[3],env,model:'claude-sonnet-4-6',tools:[],settingSources:[],persistSession:true,permissionMode:'default'};
let active;
async function turn(prompt, extra={}) {
  active = query({prompt,options:{...options,...extra}});
  const messages=[]; for await (const m of active) messages.push(m);
  active.close(); active=undefined; return messages;
}
try {
  const first = await turn('T114 first fixture prompt.');
  report.first = first;
  const session = first.find(m=>m.session_id)?.session_id;
  if (!session || !first.some(m=>m.type==='assistant')) throw Error('First native turn failed');
  report.second = await turn('T114 second fixture prompt.', {resume:session});
  report.before = await getSessionMessages(session,{dir:root,includeSystemMessages:true});
  const boundary = first.filter(m=>m.type==='assistant').at(-1).uuid;
  // Empty live stream: initialize a truncating resume without sending a prompt.
  let release; const wait = new Promise(resolve=>release=resolve);
  async function* empty() { await wait; }
  const requests = report.requests.length;
  active = query({prompt:empty(),options:{...options,resume:session,resumeSessionAt:boundary}});
  report.commands = (await active.supportedCommands()).length;
  active.close(); release(); active=undefined;
  report.requestsDuringRewind = report.requests.length - requests;
  report.after = await getSessionMessages(session,{dir:root,includeSystemMessages:true});
  report.durableWithoutPrompt = report.after.length < report.before.length;
  report.third = await turn('T114 third fixture prompt after plain resume.',{resume:session});
  report.reconnected = await getSessionMessages(session,{dir:root,includeSystemMessages:true});
} catch (error) { report.error = String(error); }
finally {
  active?.close(); server.close();
  await writeFile(process.argv[4],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output:process.argv[4],durableWithoutPrompt:report.durableWithoutPrompt,error:report.error}));
}
