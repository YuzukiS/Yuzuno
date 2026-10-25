import './jsdom-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { uiTestBundle } from './ui-test-bundle.mjs';
const dist=pathToFileURL(resolve(process.env.YUZUNO_UI_DIST || 'dist')+'/');
const html=await readFile(new URL('index.html',dist),'utf8');
const bundle=await uiTestBundle(new URL(html.match(/src="\/(assets\/[^" ]+\.js)"/)[1],dist));
const pause=(ms=40)=>new Promise(r=>setTimeout(r,ms));
async function waitFor(predicate,message) {
 const deadline=Date.now()+4000;
 while(!predicate() && Date.now()<deadline)await pause(25);
 assert.ok(predicate(),message);
}
const object=(n=8)=>({id:`7:pull:${n}`,repositoryId:7,repository:'owner/repo',kind:'pull',number:n,url:`https://github.com/owner/repo/pull/${n}`,syncedAt:new Date().toISOString(),stale:false,error:null,snapshot:{title:'修复 GitHub integration',state:'open',headSha:'a'.repeat(40),headBranch:'feature',baseBranch:'main',ci:{state:'success',headSha:'a'.repeat(40),complete:true,observedAt:new Date().toISOString(),checks:[{name:'Core',state:'success'}]}}});
async function mount({links=[object()],errorOnLink=false,workspaceDelay=0}={}) {
 const errors=[];const calls=[];let deferred;
 const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:'http://127.0.0.1:4491/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 const w=dom.window;w.matchMedia=media=>({media,matches:false,addEventListener(){},removeEventListener(){}});w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};w.EventSource=class{addEventListener(){}close(){}};w.HTMLElement.prototype.scrollIntoView=()=>{};w.HTMLElement.prototype.scrollTo=()=>{};
 const project={id:'p',name:'App',defaultDirs:{},createdAt:'',updatedAt:''};
 const person={kind:'user',id:'user',name:'You'};
 const task=id=>({id,title:id==='T-1'?'Ship GitHub links':'Another task',description:'Keep the goal',status:'doing',version:1,projectId:'p',createdAt:'',updatedAt:'',createdBy:person,updatedBy:person,github:id==='T-1'?links:[]});
 const response=(body,status=200)=>({ok:status===200,status,json:async()=>structuredClone(body),text:async()=>JSON.stringify(body)});
 w.fetch=async(url,init={})=>{
  const body=init.body?JSON.parse(init.body):{};calls.push({url,body});
  if(url.endsWith('/workspace')){await pause(workspaceDelay);return response({workspace:{id:'fixture'},agents:[],projects:[project],runtime:{connected:false},defaultCwd:'/fixture'});}
  if(url.endsWith('/catchup'))return response({items:[],coverage:{}});
  if(url.endsWith('/machines'))return response({machines:[]});
  if(url.endsWith('/task_list'))return response({tasks:[task('T-1'),task('T-2')],counts:{doing:2},hasMore:false});
  if(url.endsWith('/task_get'))return response({task:task(body.taskId),activities:[],executions:[],hasMore:false});
  if(url.includes('/github_')){
   if(body.action==='link' && errorOnLink)return response({error:'not_found: unavailable to this account'},400);
   if(body.action==='link'){if(!links.some(l=>l.url===body.input))links.push(object(Number(body.input.split('/').at(-1))));}
   if(body.action==='unlink')links=links.filter(l=>l.id!==body.linkId);
   if(body.action==='list'||!body.action){if(deferred && url.endsWith('/github_links')){const f=deferred;deferred=null;await f;}}
   return response({links:body.taskId==='T-2'?[]:links,repositories:body.projectId?[{id:7,fullName:'owner/repo',url:'https://github.com/owner/repo',syncedAt:new Date().toISOString()}]:[],refreshing:false});
  }
  return response({});
 };
 const button=text=>[...w.document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(text));
 try {
  w.eval(bundle);
  // The shell renders this button disabled before the workspace is loaded.
  // Clicking it then does nothing, regardless of how long we wait afterward.
  await waitFor(()=>{const b=button('Tasks & messages');return b && !b.disabled;},'workspace ready for task board');
  button('Tasks & messages').click();
  await waitFor(()=>w.document.querySelector('button[data-task-id="T-1"]'),'task list loaded');
 } catch(error) {
  // A setup failure must not leave app timers alive until the CI timeout.
  w.close();
  throw error;
 }
 return {w,doc:w.document,calls,errors,button,close:()=>w.close(),setLinks:v=>{links=v;},defer:v=>{deferred=v;}};
}
async function openTask(p,id='T-1'){p.doc.querySelector(`button[data-task-id="${id}"]`).click();await pause(100);}
async function type(p,input,value){Object.getOwnPropertyDescriptor(p.w.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new p.w.Event('input',{bubbles:true}));await pause();}
const panel=p=>p.doc.querySelector('[aria-label="GitHub delivery"]');
// Linking, unlinking and PR operations sit behind the Delivery section's Manage.
async function manage(p){const toggle=p.doc.querySelector('.collab-delivery button[aria-expanded]');assert.equal(toggle.getAttribute('aria-expanded'),'false');toggle.click();await pause();}

test('task cards and detail show exact-head checks; link/unlink stay on this task',async()=>{
 const p=await mount({workspaceDelay:150});try{
  assert.match(p.doc.querySelector('.github-summary').textContent,/repo#8.*Open.*Checks passed/);
  await openTask(p);assert.match(panel(p).textContent,/aaaaaaaa/);
  // Booleans only: a failing assert must never print a jsdom node.
  assert.ok(!panel(p).querySelector('.github-link-form'),'no link form until Manage');
  assert.ok(!panel(p).querySelector('[aria-label="Unlink owner/repo#8"]'),'no Unlink until Manage');
  await manage(p);
  await type(p,panel(p).querySelector('.github-link-form input'),'https://github.com/owner/repo/pull/9');
  panel(p).querySelector('button[type="submit"]').click();await pause(100);
  assert.equal(panel(p).querySelectorAll('.github-entry').length,2);
  panel(p).querySelector('[aria-label="Unlink owner/repo#8"]').click();await pause(100);
  assert.equal(panel(p).querySelectorAll('.github-entry').length,1);
  assert.ok(p.calls.filter(c=>c.body.action==='link'||c.body.action==='unlink').every(c=>c.body.taskId==='T-1'));
  assert.equal(p.calls.filter(c=>/task_update|task_submit_result|review$/.test(c.url)).length,0);
  assert.deepEqual(p.errors,[]);
 }finally{p.close();}
});
test('refresh preserves typed URL and stale last snapshot, and old-head checks never show success',async()=>{
 const link=object();link.snapshot.ci.headSha='b'.repeat(40);const p=await mount({links:[link]});try{
  await openTask(p);assert.match(panel(p).textContent,/Checks unknown/);assert.doesNotMatch(panel(p).querySelector('.github-facts').textContent,/Checks passed/);
  await manage(p);
  const input=panel(p).querySelector('.github-link-form input');await type(p,input,'unfinished 中文 draft');
  p.setLinks([{...link,stale:true,error:'unavailable: offline'}]);
  panel(p).querySelector('[aria-label="Refresh GitHub"]').click();await pause(100);
  assert.equal(panel(p).querySelector('.github-link-form input').value,'unfinished 中文 draft');assert.match(panel(p).textContent,/Out of date.*offline.*Last successful snapshot kept/s);
  assert.deepEqual(p.errors,[]);
 }finally{p.close();}
});
test('failed link keeps draft; switching tasks discards late replies',async()=>{
 const p=await mount({errorOnLink:true});try{
  await openTask(p);await manage(p);await type(p,panel(p).querySelector('.github-link-form input'),'https://github.com/owner/repo/pull/404');
  panel(p).querySelector('button[type="submit"]').click();await pause(100);
  assert.match(panel(p).textContent,/not_found/);assert.match(panel(p).querySelector('.github-link-form input').value,/404$/);
  let release; p.defer(new Promise(resolve=>{release=resolve;}));
  await openTask(p,'T-2'); await openTask(p,'T-1'); release(); await pause(100);
  assert.match(panel(p).textContent,/repo#8/);
  await openTask(p,'T-2');assert.match(panel(p).textContent,/No Issue or PR linked/);assert.ok(!panel(p).querySelector('.github-link-form'));
  [...panel(p).querySelectorAll('button')].find(b=>b.textContent.trim()==='Link a PR or Issue').click();await pause();assert.equal(panel(p).querySelector('.github-link-form input').value,'');assert.deepEqual(p.errors,[]);
 }finally{p.close();}
});
// T-189: a task's links follow the interface language, changed in another
// window. What GitHub and Core said, titles, branches, commits and check
// names stay as written; the typed URL, the open checks and the notice stay.
async function speak(p,language){p.w.localStorage.setItem('yuzuno.language',JSON.stringify({language}));p.w.dispatchEvent(new p.w.StorageEvent('storage',{key:'yuzuno.language'}));await pause(100);}
const taskPanel=p=>p.doc.querySelector('.collab-delivery .github-panel');
// What the task and its delivery panel ask of Core.
const collaboration=(p,from)=>p.calls.slice(from).map(c=>c.url).filter(u=>/\/collaboration\/|\/pr-reviews|\/pr-operations/.test(u));
test('a task\'s links follow a language change; the draft, open checks and notice stay and nothing is requested',async()=>{
 const stale={...object(9),stale:true,error:'unavailable: offline'};
 const p=await mount({links:[object(8),stale]});try{
  await openTask(p);await manage(p);
  await type(p,panel(p).querySelector('.github-link-form input'),'https://github.com/owner/repo/pull/10');
  panel(p).querySelector('button[type="submit"]').click();await pause(100);
  assert.match(panel(p).querySelector('.github-notice').textContent,/^Linked\./);
  const checks=panel(p).querySelector('.github-checks');checks.open=true;
  await type(p,panel(p).querySelector('.github-link-form input'),'https://github.com/owner/repo/pull/11 草稿');
  const before=p.calls.length;
  await speak(p,'zh-Hans');
  const zh=taskPanel(p);
  assert.equal(zh.getAttribute('aria-label'),'GitHub 交付');
  const text=zh.textContent;
  for(const words of ['拉取请求和 Issue','开放','检查通过','同步于','检查观察于','已过时','上次已知：检查通过','aaaaaaaa 上的 1 项检查','Issue 或拉取请求的 URL'])assert.ok(text.includes(words),words);
  // As written: the PR's title, branches, commit, check name and GitHub's reason.
  for(const kept of ['修复 GitHub integration','feature → main','aaaaaaaa','unavailable: offline · 已保留上次成功的快照。'])assert.ok(text.includes(kept),kept);
  assert.equal(zh.querySelector('.github-checks div span').textContent,'Core');
  assert.ok([...zh.querySelectorAll('button')].some(b=>b.textContent==='监视 aaaaaaaa 的 Actions…'));
  const unlink=zh.querySelector('[aria-label="取消链接 owner/repo#8"]');assert.ok(unlink&&unlink.title==='只移除关联');
  assert.equal(zh.querySelector('.github-notice').textContent,'已链接。GitHub 与任务状态彼此独立。');
  assert.equal(zh.querySelector('.github-link-form input').value,'https://github.com/owner/repo/pull/11 草稿');
  assert.ok(zh.querySelector('.github-checks').open,'the checks stay open');
  // The task's card: its summary too, the repository and number as they are.
  const summary=p.doc.querySelector('.github-summary');
  assert.equal(summary.getAttribute('aria-label'),'已链接的 GitHub 工作');
  assert.match(summary.textContent,/repo#8开放检查通过.*repo#9开放上次已知：检查通过/);
  // Nothing asked of the task's Core endpoints: no github_links,
  // github_refresh, task_list, task_get, task_update, pr-reviews or
  // pr-operations, no link or unlink.
  // (The status bar's own background read of jobs, reviews and CI may land
  // here; it follows Jobs events, not the language.)
  assert.deepEqual(collaboration(p,before),[]);
  await speak(p,'en');
  assert.equal(taskPanel(p).getAttribute('aria-label'),'GitHub delivery');
  assert.match(taskPanel(p).querySelector('.github-notice').textContent,/^Linked\./);
  assert.equal(taskPanel(p).querySelector('.github-link-form input').value,'https://github.com/owner/repo/pull/11 草稿');
  assert.deepEqual(collaboration(p,before),[]);
  assert.deepEqual(p.errors,[]);
 }finally{p.close();}
});
