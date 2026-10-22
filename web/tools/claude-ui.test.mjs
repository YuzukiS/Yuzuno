import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// Bundle the components in memory, without replacing the running UI's dist.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "claude-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ClaudePermission, ClaudeRuntimeFacts} from ${JSON.stringify(path.join(root, "src/ClaudeControls.tsx"))};
import {RemoteControls} from ${JSON.stringify(path.join(root, "src/RemoteControls.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderPermission=(props)=>root.render(<ClaudePermission {...props}/>);
window.renderFacts=(props)=>root.render(<dl><ClaudeRuntimeFacts {...props}/></dl>);
window.renderControls=(props)=>root.render(<RemoteControls {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: {
      write: false,
      lib: { entry, name: "RemoteUI", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (item) => item.type === "chunk",
  ).code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise(resolve => setTimeout(resolve, 30));
function mount(handler) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "http://isolated.test/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
      virtualConsole,
    },
  );
  const { window } = dom;
  window.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body && JSON.parse(init.body) });
    const body = await handler?.(url, init) ?? {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  return { dom, window, document: window.document, calls, errors, close: () => window.close() };
}
function button(page, text) {
  return [...page.document.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === text,
  );
}
function input(page, label) {
  return [...page.document.querySelectorAll("label")]
    .find((node) => node.textContent.trim().startsWith(label))
    ?.querySelector("input,textarea,select");
}
async function value(page, node, text) {
  const prototype =
    node.tagName === "TEXTAREA"
      ? page.window.HTMLTextAreaElement.prototype
      : node.tagName === "SELECT"
        ? page.window.HTMLSelectElement.prototype
        : page.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, text);
  node.dispatchEvent(
    new page.window.Event(node.tagName === "SELECT" ? "change" : "input", {
      bubbles: true,
    }),
  );
  await tick();
}
const request = {id:'permission-id', agentId:'agent', method:'claude/canUseTool', createdAt:'now', params:{toolName:'Bash', input:{command:'echo hello'}}};
test('allow once sends correlated Claude decision without permission-rule mutation', async () => {
  const p=mount();
  p.window.renderPermission({request,refresh(){},disabled:false}); await tick();
  button(p,'Allow once').click(); await tick();
  assert.equal(p.calls.length,1);
  assert.match(p.calls[0].url,/requests\/permission-id\/respond$/);
  assert.deepEqual(p.calls[0].body,{response:{decision:'allow'}});
  p.close();
});
test('stale permissions cannot submit', async () => {
  const p=mount(); p.window.renderPermission({request:{...request,stale:true},refresh(){},disabled:false}); await tick();
  assert.equal(button(p,'Allow once').disabled,true); button(p,'Allow once').click();
  await tick(); assert.equal(p.calls.length,0); p.close();
});
test('question answers preserve native input and use question strings as keys', async () => {
  const p=mount();
  const input={questions:[{question:'Which fruit?',options:[{label:'Yuzu'},{label:'Peach'}],multiSelect:true}]};
  p.window.renderPermission({request:{...request,params:{toolName:'AskUserQuestion',input}},refresh(){},disabled:false}); await tick();
  assert.equal(button(p,'Send answer').disabled,true);
  for(const el of p.document.querySelectorAll('input[type=checkbox]')) el.click(); await tick();
  button(p,'Send answer').click(); await tick();
  assert.deepEqual(p.calls[0].body,{response:{decision:'allow',updatedInput:{...input,answers:{'Which fruit?':'Yuzu, Peach'}}}});
  p.close();
});
// T-170: an unsent answer is kept in this browser, for this native request only.
test('an unsent answer to a Claude question survives a reload, into the same request only', async () => {
  const input={questions:[{question:'Which fruit?',options:[{label:'Yuzu'},{label:'Peach'}],multiSelect:true},{question:'Why?'}]};
  const ask=(id,requestId='native-1',agentId='agent')=>({...request,id,agentId,params:{toolName:'AskUserQuestion',requestId,turnId:'t1',input}});
  const why=(page)=>page.document.querySelector('input[aria-label="Your answer: Why?"]');
  const reload=(from)=>{const next=mount(); for(let i=0;i<from.window.localStorage.length;i++){const key=from.window.localStorage.key(i); next.window.localStorage.setItem(key,from.window.localStorage.getItem(key));} return next;};
  const first=mount();
  first.window.renderPermission({request:ask('p1'),refresh(){},disabled:false,draftScope:'ws-1'}); await tick();
  first.document.querySelector('input[type=checkbox]').click(); await tick();
  await value(first,why(first),'Sweet enough');
  for(const [id,requestId,agentId,restored] of [['p2','native-1','agent',true],['p3','native-2','agent',false],['p4','native-1','other',false]]){
    const page=reload(first);
    page.window.renderPermission({request:ask(id,requestId,agentId),refresh(){},disabled:false,draftScope:'ws-1'}); await tick();
    const boxes=[...page.document.querySelectorAll('input[type=checkbox]')];
    assert.deepEqual([boxes[0].checked,boxes[1].checked,why(page).value],restored?[true,false,'Sweet enough']:[false,false,''],`${requestId} ${agentId}`);
    assert.equal(page.calls.length,0,'restoring sends nothing');
    page.close();
  }
  // Sent and recorded: nothing is left to restore.
  first.window.renderPermission({request:ask('p1'),refresh(){},disabled:false,draftScope:'ws-1'}); await tick();
  button(first,'Send answer').click(); await tick();
  assert.equal(first.calls.length,1);
  assert.equal(first.window.localStorage.length,0);
  first.close();
  // Without a Workspace to keep it in (a preview), nothing is kept.
  const preview=mount();
  preview.window.renderPermission({request:ask('p5'),refresh(){},disabled:false}); await tick();
  await value(preview,why(preview),'Not kept');
  assert.equal(preview.window.localStorage.length,0);
  preview.close();
});
test('session approval shows exactly the bridge offer, never raw suggestions', async () => {
  const p=mount();
  // Raw suggestions alone (e.g. from an older bridge) offer nothing.
  const suggestions=[{type:'addRules',behavior:'allow',destination:'localSettings',rules:[{toolName:'Bash',ruleContent:'npm test:*'}]}];
  p.window.renderPermission({request:{...request,params:{...request.params,suggestions}},refresh(){},disabled:false}); await tick();
  assert.ok(button(p,'Allow for this session') === undefined, 'no "Allow for this session" button');
  const sessionPermissions=[{type:'addRules',behavior:'allow',destination:'session',rules:[{toolName:'Bash',ruleContent:'npm test:*'}]}];
  p.window.renderPermission({request:{...request,params:{...request.params,suggestions,sessionPermissions}},refresh(){},disabled:false}); await tick();
  assert.match(p.document.body.textContent,/also allows Bash\(npm test:\*\) until this Claude session restarts/);
  button(p,'Allow for this session').click(); await tick();
  assert.deepEqual(p.calls[0].body,{response:{decision:'allow',scope:'session'}});
  p.close();
  const edits=mount();
  edits.window.renderPermission({request:{...request,params:{toolName:'Edit',input:{file_path:'/x',old_string:'a',new_string:'b'},
    sessionPermissions:[{type:'setMode',mode:'acceptEdits',destination:'session'}]}},refresh(){},disabled:false}); await tick();
  assert.ok(button(edits,'Allow edits for this session'));
  assert.match(edits.document.body.textContent,/all file edits \(switches to acceptEdits mode\)/);
  edits.close();
});
test('plan usage ages out windows that have reset and scopes a warning to its window', async () => {
  const p=mount();
  const now=Date.now()/1000;
  const runtime={account:{email:'a@example.com',subscriptionType:'Claude Max'},rateLimitsAt:new Date().toISOString(),
    rateLimits:{status:'rejected',rateLimitType:'five_hour',resetsAt:now-60,
      unifiedWindows:{five_hour:{utilization:1,resetsAt:now-60},seven_day:{utilization:0.36,resetsAt:now+86400}}}};
  p.window.renderFacts({runtime}); await tick();
  const text=p.document.body.textContent;
  assert.match(text,/5h reset · 7d 36%/);
  assert.doesNotMatch(text,/limit reached/);
  p.window.renderFacts({runtime:{...runtime,rateLimits:{...runtime.rateLimits,resetsAt:now+600,
    unifiedWindows:{...runtime.rateLimits.unifiedWindows,five_hour:{utilization:1,resetsAt:now+600}}}}}); await tick();
  assert.match(p.document.body.textContent,/5h 100% · 7d 36% · 5h limit reached/);
  p.close();
});
test('a denial can carry a reason for Claude, and allowing never sends it', async () => {
  const p=mount();
  p.window.renderPermission({request,refresh(){},disabled:false}); await tick();
  await value(p,input(p,'Reason for Claude'),'  Use git status instead  ');
  button(p,'Deny with reason').click(); await tick();
  assert.deepEqual(p.calls[0].body,{response:{decision:'deny',message:'Use git status instead'}});
  p.close();
  const q=mount();
  q.window.renderPermission({request,refresh(){},disabled:false}); await tick();
  await value(q,input(q,'Reason for Claude'),'only for denials');
  button(q,'Allow once').click(); await tick();
  assert.deepEqual(q.calls[0].body,{response:{decision:'allow'}});
  q.close();
});
