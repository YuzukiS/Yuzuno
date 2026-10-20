// Real GUI against the isolated Core; never attaches to a user's window.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const lab = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(pathToFileURL(resolve(lab, '../../web/node_modules/playwright-core/index.mjs')));
const base = 'http://127.0.0.1:4337';
const mode = process.argv[2] || 'create';
assert.ok(['create', 'question', 'interrupt', 'resume', 'capture', 'cancel'].includes(mode));
const proc = JSON.parse(await readFile(resolve(lab, 'core-process.json'), 'utf8'));
assert.equal(proc.baseUrl, base);
const stat = await readFile(`/proc/${proc.pid}/stat`, 'utf8');
assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], proc.startTicks);
assert.ok(proc.argv.includes(resolve(lab, 'core-data')));
const report = {mode, startedAt:new Date().toISOString(),checks:[],browserErrors:[]};
const record = (name, data={}) => { report.checks.push({name,...data}); console.log(name); };
const api = async path => { const r=await fetch(base+'/api'+path); assert.ok(r.ok,await r.clone().text()); return r.json(); };
const statePath=resolve(lab,'gui-state.json');
let state=mode==='create'?{name:`Claude lab ${Date.now()}`,marker:`YUZU_${Date.now()}`} : JSON.parse(await readFile(statePath,'utf8'));
const save=()=>writeFile(statePath,JSON.stringify(state,null,2));
const current=()=>api(`/agents/${state.agentId}`);
async function wait(predicate, timeout=150000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    const d=await current(); if(predicate(d)) return d;
    if(['error','uncertain'].includes(d.agent.status)) throw Error(d.agent.error || d.agent.status);
    await new Promise(done=>setTimeout(done,400));
  }
  throw Error('Timed out; no task was retried. Inspect the preserved lab state.');
}
const browser=await chromium.launch({headless:true,executablePath:'/usr/sbin/chromium'});
const context=await browser.newContext({viewport:{width:1440,height:960},permissions:['clipboard-read','clipboard-write']});
const page=await context.newPage();
page.on('pageerror',e=>report.browserErrors.push(e.message));
await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
async function send(text) {
  await page.getByRole('textbox',{name:`Message ${state.name}`,exact:true}).fill(text);
  await page.getByRole('button',{name:'Send message',exact:true}).click();
}
try {
  await page.goto(base+'/?shell=desktop');
  if(mode==='create') {
    await page.getByRole('button',{name:'Create agent',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByLabel('Name',{exact:true}).fill(state.name);
    await dialog.getByLabel(/^A lasting purpose/).fill('Small Claude GUI acceptance tasks, only in this folder.');
    await dialog.getByLabel(/^Working folder/).fill(resolve(lab,'task'));
    await dialog.getByLabel('Harness',{exact:true}).selectOption('claude');
    await dialog.getByLabel('Model',{exact:true}).fill('haiku');
    await dialog.getByRole('button',{name:'Create agent',exact:true}).click();
    await page.getByRole('heading',{name:state.name,exact:true}).waitFor();
    state.agentId=(await api('/workspace')).agents.find(a=>a.name===state.name).id; await save();
    await wait(d=>d.agent.status==='idle' && d.agent.connectionState==='connected');
    record('gui-created-native-wsl-claude-agent',{agentId:state.agentId});
    await send(`Remember the secret fruit marker ${state.marker} for this conversation. Use the Write tool to create ${resolve(lab,'task/report.md')} containing exactly: "# Claude report\\n${state.marker}\\ndone\\n" (real newline characters). Do not use any other tools or access other paths. Then reply with the marker and [report.md](report.md:2).`);
    const pending=await wait(d=>d.pending.some(p=>!p.stale));
    const request=pending.pending.find(p=>!p.stale);
    assert.equal(request.params.toolName,'Write'); assert.equal(request.params.input.file_path,resolve(lab,'task/report.md'));
    state.approvalId=request.id; await save();
    await page.locator('.claude-permission').waitFor();
    await page.reload(); await page.locator('.claude-permission').waitFor();
    assert.equal((await current()).pending[0].id,request.id);
    await page.screenshot({path:resolve(lab,'approval.png')});
    record('pending-survives-gui-reload');
    await page.getByRole('button',{name:'Allow once',exact:true}).click();
    const done=await wait(d=>d.turns.at(-1)?.status==='completed');
    state.sessionId=done.agent.claudeSessionId; await save();
    assert.ok(state.sessionId); assert.equal(done.agent.threadId,null); assert.equal(done.pending.length,0);
    assert.ok(done.turns.at(-1).items.some(i=>i.type==='claudeToolUse' && i.status==='completed'));
    assert.match(await readFile(resolve(lab,'task/report.md'),'utf8'),new RegExp(state.marker));
    const reply=page.locator('.final-message').filter({hasText:state.marker}).last(); await reply.waitFor();
    await reply.getByRole('button',{name:'Copy reply',exact:true}).click();
    assert.match(await page.evaluate(()=>navigator.clipboard.readText()),new RegExp(state.marker));
    await reply.locator('a').filter({hasText:'report.md'}).click();
    await page.getByRole('dialog').locator('[data-line="2"].source-line-highlight').waitFor();
    await page.screenshot({path:resolve(lab,'artifact.png')});
    await page.getByRole('dialog').getByRole('button',{name:'Close dialog'}).click();
    record('gui-approved-tool-final-copy-and-artifact-source',{sessionId:state.sessionId});
  } else {
    await page.locator('.agent-row').filter({has:page.locator('.agent-name',{hasText:state.name})}).click();
    await page.getByRole('heading',{name:state.name,exact:true}).waitFor();
    const before=await current(),count=before.turns.length;
    if(mode==='cancel') {
      const target=resolve(lab,'task/must-not-write.md');
      await send(`Use Write to create ${target} containing CANCELLED_ACTION_SHOULD_NOT_RUN. Do not use other tools. Then say done.`);
      const d=await wait(d=>d.pending.some(p=>p.params.toolName==='Write'&&!p.stale));
      const request=d.pending.find(p=>p.params.toolName==='Write'&&!p.stale);
      assert.equal(request.params.input.file_path,target);
      await page.locator('.claude-permission').waitFor();
      await page.screenshot({path:resolve(lab,'approval-reviewed.png')});
      await page.locator('.interrupt-button').click();
      const done=await wait(d=>d.turns.length>count && d.turns.at(-1)?.status==='interrupted');
      assert.equal(done.pending.length,0);
      await assert.rejects(readFile(target),e=>e.code==='ENOENT');
      const replay=await fetch(`${base}/api/requests/${request.id}/respond`,{method:'POST',headers:{'content-type':'application/json','x-yuzuno-client':'desktop'},body:JSON.stringify({response:{decision:'allow'}})});
      assert.equal(replay.ok,false); record('interrupt-pending-approval-never-runs-tool-and-rejects-late-action');
    } else if(mode==='question') {
      await send('Use AskUserQuestion now to ask exactly one question: "Which fruit should we pick?", with two choices "Yuzu" and "Peach", single select. Do not answer it yourself. After I answer, reply only "Picked: " followed by my answer. No other tools.');
      const d=await wait(d=>d.pending.some(p=>p.params.toolName==='AskUserQuestion'));
      assert.equal(d.pending.filter(p=>!p.stale).length,1);
      await page.getByRole('radio').first().check();
      await page.getByRole('button',{name:'Send answer',exact:true}).click();
      const done=await wait(d=>d.turns.length>count&&d.turns.at(-1)?.status==='completed');
      assert.match(done.agent.lastMessage,/Picked:.*Yuzu/s); record('gui-native-question-answer');
    } else if(mode==='interrupt') {
      await send('Run exactly this foreground Bash command: sleep 20; printf CLAUDE_SLEEP_DONE. Do not use any other tools or start background work. Then reply done.');
      await wait(d=>d.turns.length>count && (d.pending.some(p=>p.params.toolName==='Bash'&&!p.stale) || d.turns.at(-1).items.some(i=>i.type==='claudeToolUse'&&i.name==='Bash'&&i.status==='inProgress')));
      await new Promise(done=>setTimeout(done,2000));
      const pending=await current();
      const request=pending.pending.find(p=>p.params.toolName==='Bash'&&!p.stale);
      if(request) {
        assert.match(request.params.input.command,/^sleep 20; printf CLAUDE_SLEEP_DONE$/);
        await page.getByRole('button',{name:'Allow once',exact:true}).click();
        await wait(d=>d.agent.status==='working'&&d.pending.length===0);
      }
      assert.ok((await current()).turns.at(-1).items.some(i=>i.type==='claudeToolUse'&&i.name==='Bash'&&i.status==='inProgress'));
      await page.locator('.interrupt-button').click();
      await wait(d=>d.turns.at(-1)?.status==='interrupted');
      const replay=await fetch(`${base}/api/requests/${request?.id || state.approvalId}/respond`,{method:'POST',headers:{'content-type':'application/json','x-yuzuno-client':'desktop'},body:JSON.stringify({response:{decision:'allow'}})});
      assert.equal(replay.ok,false);
      record('gui-native-interrupt-and-old-approval-rejected');
      await send('What is the secret fruit marker from earlier? Reply only that marker. No tools.');
      const resumed=await wait(d=>d.turns.length>count+1&&d.turns.at(-1)?.status==='completed');
      assert.match(resumed.agent.lastMessage,new RegExp(state.marker)); assert.equal(resumed.agent.claudeSessionId,state.sessionId);
      record('same-session-continues-after-interrupt');
    } else if(mode==='resume') {
      assert.equal(before.agent.claudeSessionId,state.sessionId);
      await send('Recall the secret fruit marker from earlier. Reply only the marker. Do not read files or use tools.');
      const done=await wait(d=>d.turns.length>count&&d.turns.at(-1)?.status==='completed');
      assert.equal(done.agent.claudeSessionId,state.sessionId); assert.match(done.agent.lastMessage,new RegExp(state.marker));
      record('native-session-resume-after-core-restart');
    }
  }
  await page.screenshot({path:resolve(lab,`${mode}-workspace.png`)});
  assert.equal(report.browserErrors.length,0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  record('no-browser-errors-or-horizontal-overflow'); report.passed=true;
} catch(e) { await page.screenshot({path:resolve(lab,`${mode}-failure.png`)}).catch(()=>{}); report.error=e.stack; report.passed=false; throw e; }
finally { await writeFile(resolve(lab,`gui-${mode}-report.json`),JSON.stringify(report,null,2)); await browser.close(); }
