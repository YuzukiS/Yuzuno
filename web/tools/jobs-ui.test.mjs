import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { JSDOM, VirtualConsole } from 'jsdom';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'node_modules/.cache'), { recursive: true });
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/jobs-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs,ConversationJobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};const root=createRoot(document.getElementById('root'));window.renderJobs=p=>root.render(<><Jobs key={p.workspaceId} {...p}/>{p.agent && <ConversationJobs key={p.agent.id} agentId={p.agent.id} revision={p.revision} disabled={p.disabled}/>}</>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'JobsUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }
const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 100; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const agent = { id: 'a', name: 'Mori', cwd: '/workspace', status: 'working' };
const props = { workspaceId: 'workspace-one', agent, revision: '1', disabled: false };
const ciRun = { id:'github:123:42:2', name:'Matrix CI', repository:'o/r', runId:'42', attempt:'2', headSha:'a'.repeat(40), status:'passed', rawStatus:'completed', conclusion:'success', url:'https://github.com/o/r/actions/runs/42/attempts/2', observedAt:'2026-10-15T01:00:00Z', cursor:1 };
const ciSub = { id:'sub', agentId:'a', agent:{name:'Mori'}, taskRef:'T-47', active:true, expiresAt:'2026-10-22T01:00:00Z', watch:{kind:'pull',number:7,url:'https://github.com/o/r/pull/7',expectedSha:'a'.repeat(40),currentHeadSha:'b'.repeat(40),state:'older_commit',observedAt:'2026-10-15T01:00:00Z',error:null} };
const ciPage = {runs:[ciRun],subscriptions:[ciSub],hasMore:false,nextBefore:null};
const resources = { cpuMillis: 500, memoryMiB: 128, swapMiB: 0 };
const job = { usage:{MemoryCurrent:'18446744073709551615',MemoryPeak:'18446744073709551615'}, id: 'job-one', requestId: 'accepted', name: '中文 training', taskRef: 'T-47', agentId: 'a', agent: { name: 'Mori' }, machine: { name: 'Local WSL' }, status: 'unknown', reserved: true, reason: 'Reservation held until process groups are verified', resources, reservation: { cpuMillis: 600, memoryMiB: 192, swapMiB: 0 }, cursor: 1, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null, argv: ['/usr/bin/true'], cwd: '/workspace', env: {}, outputs: ['report.json'] };
const page = jobs => ({ jobs, hasMore: false, nextBefore: null });
function mount(handler = () => page([]), stored = {}) {
  const vc = new VirtualConsole(), errors = [], calls = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  for (const [k, v] of Object.entries(stored)) w.localStorage.setItem(k, v);
  w.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    let value;
    if (url === '/api/jobs/budget' && !body) value = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 1, queuedCount: 1, collectorOverhead: {cpuMillis:100,memoryMiB:64,swapMiB:0}, budgetBounds: {minimum:{cpuMillis:200,memoryMiB:128,swapMiB:0},maximum:{cpuMillis:4096000,memoryMiB:67108864,swapMiB:67108864}}, machine: { name: 'WSL', memoryAvailableMiB: 2000, logicalCpus: 32, memoryTotalMiB: 40107, swapTotalMiB: 16384, hostHeadroomMiB: 2048, suggestedBudget:{cpuMillis:4000,memoryMiB:8192,swapMiB:0} } };
    else if (url.endsWith('/logs')) value = { text: 'bounded output', oldestOffset: 1000, totalBytes: 1200 };
    else value = await handler(url, body);
    if (value instanceof Error) throw value;
    const status = value?.httpStatus || 200;
    return { ok: status < 400, status, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle); w.renderJobs(props);
  return { window: w, doc: w.document, calls, errors, close: () => w.close() };
}
const button = (p, text) => [...p.doc.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const field = (p, text) => [...p.doc.querySelectorAll('label')].find(l => l.textContent.startsWith(text))?.querySelector('input,textarea');
async function fill(p, text, value) { const el = field(p, text); assert.equal(!!el, true, `Missing ${text} field`); Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? p.window.HTMLTextAreaElement.prototype : p.window.HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new p.window.Event('input', { bubbles: true })); await wait(); }
async function open(p) { await until(() => p.doc.querySelector('[aria-label="Jobs"]')); p.doc.querySelector('[aria-label="Jobs"]').click(); await until(() => p.doc.querySelector('[role="dialog"]')); }

test('unknown job stays protected, shows resources and bounded output, Escape only dismisses dialog', async () => {
  const p = mount((url, body) => url === '/api/jobs/job-one' ? job : url.endsWith('/cancel') ? { ...job, status: 'cancelling' } : page([job]));
  try {
    await until(() => p.doc.querySelector('.conversation-job'));
    p.doc.querySelector('.conversation-job').click();
    await until(() => p.doc.querySelector('.job-log'));
    assert.equal(!!button(p, 'Run again…'), false);
    assert.match(p.doc.querySelector('.job-detail').textContent, /Outcome unknown/);
    assert.match(p.doc.querySelector('.job-log').textContent, /bounded output/);
    assert.equal([...p.doc.querySelectorAll('.job-detail dd')].filter(el=>el.textContent==='Not available').length,2);
    assert.match(p.doc.body.textContent, /Older output was rotated out/);
    assert.equal(!!p.doc.querySelector('a[download]'), true);
    let interrupts = 0;
    p.window.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented) interrupts++; });
    p.doc.querySelector('[role="dialog"]').dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await until(() => !p.doc.querySelector('[role="dialog"]'));
    assert.equal(interrupts, 0); assert.equal(p.calls.some(c => c.url.endsWith('/cancel')), false);
  } finally { p.close(); }
});

test('completed job retains its actual process/thread limit and failure evidence', async () => {
  const reason='Process/thread limit reached (128 tasks); pids.events max increased by 1 while the command failed';
  const finished={...job,status:'failed',reserved:false,usage:null,reason,
    result:{reason,evidence:{systemd:{Result:'exit-code',TasksMax:'128'},pids:{after:{max:128,peak:128,events:{max:1}}}}}};
  const p=mount(url=>url==='/api/jobs/job-one'?finished:page([finished]));
  try {
    await until(()=>p.doc.querySelector('.conversation-job'));p.doc.querySelector('.conversation-job').click();
    await until(()=>p.doc.querySelector('.job-log'));
    const label=[...p.doc.querySelectorAll('.job-detail dt')].find(el=>el.textContent==='Process/thread limit');
    assert.equal(label.nextElementSibling.textContent,'128');
    assert.match(p.doc.querySelector('.job-detail').textContent,/Process\/thread limit reached \(128 tasks\)/);
    assert.match(p.doc.querySelector('.job-evidence').textContent,/"peak": 128/);
  } finally {p.close();}
});

test('lost submission reply retains command and idempotency key across remount; retry does not create another attempt', async () => {
  let accepted = null, count = 0;
  const handler = (url, body) => {
    if (url === '/api/jobs' && body) { count++; accepted = { ...job, ...body, id: 'job-one', status: 'queued' }; if (count === 1) return new Error('Response lost'); return accepted; }
    return url === '/api/jobs/job-one' ? accepted : page(accepted ? [accepted] : []);
  };
  let p = mount(handler), stored, firstId;
  try {
    await open(p); button(p, 'New job').click(); await wait();
    await fill(p, 'Name', '中文 job'); await fill(p, 'Existing task', 'T-47'); await fill(p, 'Command', 'printf hello');
    assert.equal(field(p, 'Exclusive execution').checked, false);
    field(p, 'Exclusive execution').click(); await wait();
    button(p, 'Submit job').click(); await until(() => p.doc.querySelector('[role="alert"]'));
    firstId = p.calls.find(c => c.url === '/api/jobs' && c.body).body.requestId;
    assert.equal(p.calls.find(c => c.url === '/api/jobs' && c.body).body.exclusive, true);
    stored = Object.fromEntries(Object.entries(p.window.localStorage));
    assert.equal(Object.keys(stored).some(k => k.startsWith('yuzuno.job-submission')), true);
  } finally { p.close(); }
  p = mount(handler, stored);
  try {
    await open(p); await until(() => button(p, 'Retry same submission'));
    assert.equal(field(p, 'Command').value, 'printf hello');
    assert.equal(field(p, 'Exclusive execution').checked, true);
    assert.equal(field(p, 'Exclusive execution').disabled, true);
    button(p, 'Retry same submission').click(); await until(() => p.calls.some(c => c.url === '/api/jobs' && c.body));
    await until(() => !p.doc.querySelector('.job-form'));
    assert.equal(p.calls.find(c => c.url === '/api/jobs' && c.body).body.requestId, firstId);
    assert.equal(p.calls.find(c => c.url === '/api/jobs' && c.body).body.exclusive, true);
    assert.equal(count, 2);
    assert.equal(Object.keys(p.window.localStorage).some(k => k.startsWith('yuzuno.job-submission')), false);
  } finally { p.close(); }
});

test('exclusive queue shows mode and wait reason; rerun preserves mode but requires explicit submission', async () => {
  let current={...job,exclusive:true,status:'queued',reserved:false,reason:'Waiting for running jobs to finish and their process groups to be cleared'};
  const p=mount(url=>url==='/api/jobs/job-one'?current:page([current]));
  try {
    await until(()=>p.doc.querySelector('.conversation-job'));
    assert.match(p.doc.querySelector('.conversation-job').textContent,/Exclusive/);
    p.doc.querySelector('.conversation-job').click(); await until(()=>p.doc.querySelector('.job-log'));
    assert.match(p.doc.querySelector('.job-row').textContent,/Exclusive/);
    assert.match(p.doc.querySelector('.job-row').textContent,/Waiting for running jobs/);
    assert.match(p.doc.querySelector('.job-detail').textContent,/Exclusive — this Core's managed local jobs/);
    current={...current,status:'succeeded',finishedAt:new Date().toISOString(),reason:'success'};
    p.doc.querySelector('[aria-label="Refresh jobs"]').click(); await until(()=>button(p,'Run again…'));
    button(p,'Run again…').click(); await wait();
    assert.equal(field(p,'Exclusive execution').checked,true);
    assert.equal(p.calls.some(c=>c.url==='/api/jobs' && c.body),false);
  } finally {p.close();}
});

test('legacy unconfirmed ordinary submission retries with the same payload and request ID', async () => {
  const draft={agentId:'a',taskId:'T-47',name:'legacy',cwd:'/workspace',command:'true',cpu:'1',memory:'512',swap:'0',timeout:'30',env:'{}',inputs:'',outputs:'',guardGit:true};
  const body={agentId:'a',taskId:'T-47',name:'legacy',cwd:'/workspace',argv:['/bin/sh','-c','true'],env:{},inputs:[],outputs:[],guardGit:true,resources:{cpuMillis:1000,memoryMiB:512,swapMiB:0},timeoutSeconds:30};
  const stored={'yuzuno.job-submission.v1:["workspace-one"]':JSON.stringify({draft,key:JSON.stringify(body),requestId:'legacy-request'})};
  const p=mount((url,posted)=>url==='/api/jobs' && posted?{...job,...posted,status:'queued'}:url==='/api/jobs/job-one'?job:page([]),stored);
  try {
    await open(p); await until(()=>button(p,'Retry same submission'));
    assert.equal(field(p,'Exclusive execution').checked,false);
    button(p,'Retry same submission').click(); await until(()=>!p.doc.querySelector('.job-form'));
    assert.deepEqual(p.calls.find(c=>c.url==='/api/jobs' && c.body).body,{...body,requestId:'legacy-request'});
    assert.equal(!!p.doc.querySelector('[role="alert"]'),false);
  } finally {p.close();}
});

test('known rejection permits editing and a completed job only reruns after a new explicit submit', async () => {
  const finished = { ...job, status: 'succeeded', reserved: false, finishedAt: new Date().toISOString() };
  const p = mount((url, body) => body && url === '/api/jobs' ? { httpStatus: 400, error: 'Never fits budget' } : url === '/api/jobs/job-one' ? finished : page([finished]));
  try {
    await until(() => p.doc.querySelector('.conversation-job')); p.doc.querySelector('.conversation-job').click();
    await until(() => button(p, 'Run again…')); button(p, 'Run again…').click(); await wait();
    assert.equal(p.calls.some(c => c.url === '/api/jobs' && c.body), false);
    button(p, 'Submit job').click(); await until(() => p.doc.querySelector('[role="alert"]'));
    assert.match(p.doc.querySelector('[role="alert"]').textContent, /Never fits/);
    await fill(p, 'RAM limit', '64'); button(p, 'Submit job').click();
    await until(() => p.calls.filter(c => c.url === '/api/jobs' && c.body).length === 2);
    const posts = p.calls.filter(c => c.url === '/api/jobs' && c.body);
    assert.notEqual(posts[0].body.requestId, posts[1].body.requestId);
    assert.equal(posts[0].body.exclusive, undefined);
  } finally { p.close(); }
});

test('Agent switch clears previous cards and in-flight UI state without reacting to ordinary render churn', async () => {
  const p = mount(url => page(url.includes('agentId=b') ? [] : [job]));
  try {
    await until(() => p.doc.querySelector('.conversation-job'));
    const count = p.calls.length;
    for (let i = 0; i < 20; i++) p.window.renderJobs({ ...props, agent: { ...agent, status: 'working', lastMessage: String(i) } });
    await wait(); assert.equal(p.calls.length, count);
    p.window.renderJobs({ ...props, agent: { ...agent, id: 'b', name: 'Hana' } });
    await until(() => p.calls.some(c => c.url.includes('agentId=b'))); await wait();
    assert.equal(!!p.doc.querySelector('.conversation-job'), false);
    assert.equal(!!p.doc.querySelector('[role="dialog"]'), false);
  } finally { p.close(); }
});


test('workspace entry exists without a selected Agent, task scope shares the panel, and counts use complete machine totals', async () => {
  const p=mount(url=>page([job]));
  try {
    p.window.renderJobs({...props,agent:null,agents:[]});
    await open(p);
    await until(()=>p.calls.some(c=>c.url==='/api/jobs?'));
    assert.equal(button(p,'New job').disabled,true);
    assert.equal(p.doc.querySelector('[aria-label="1 active jobs, 1 queued jobs"]').textContent,'1 / 1');
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job',{detail:{taskId:'T-47'}}));
    await until(()=>p.calls.some(c=>c.url==='/api/jobs?taskId=T-47'));
    assert.equal(p.doc.querySelector('.job-task-scope').textContent,'Task T-47');
    assert.equal(p.doc.querySelectorAll('[role="dialog"]').length,1);
    button(p,'Workspace').click();await wait();
    assert.equal(!!p.doc.querySelector('.job-task-scope'),false);
  } finally {p.close();}
});

test('Actions share the Jobs shell, preserve old SHA and show paged jobs without local controls', async () => {
  const detail = number => ({run:ciRun,error:null,details:{jobs:[{id:number,name:number===1?'Build passed':'Optional skipped',status:number===1?'passed':'skipped',url:'https://github.com/o/r/actions/runs/42/job/'+number,steps:[{number:1,name:'Compile',status:'completed',conclusion:'success'}]}],page:number,hasMore:number===1,nextPage:number===1?2:null,observedAt:ciRun.observedAt}});
  const p=mount(url=>url.startsWith('/api/ci/')?detail(url.endsWith('page=2')?2:1):url.startsWith('/api/ci?')?ciPage:page([]));
  try {
    await open(p);button(p,'GitHub Actions').click();
    await until(()=>p.doc.querySelector('.ci-jobs .job-row'));
    assert.equal(p.doc.querySelectorAll('[role="dialog"]').length,1);
    assert.equal(!!p.doc.querySelector('.jobs-budget'),false);
    assert.equal(!!button(p,'New job'),false);
    p.doc.querySelector('.ci-jobs .job-row').click();
    await until(()=>p.doc.querySelector('.ci-child-job'));
    assert.match(p.doc.querySelector('.ci-jobs .job-detail').textContent,/Older PR commit/);
    assert.match(p.doc.querySelector('.ci-jobs .job-detail').textContent,/a{40}/);
    assert.equal(!!button(p,'Run again…'),false);assert.equal(!!button(p,'Cancel'),false);
    button(p,'More jobs').click();await until(()=>p.doc.querySelectorAll('.ci-child-job').length===2);
    assert.match(p.doc.querySelector('.ci-jobs').textContent,/Optional skipped/);
    assert.equal(p.calls.some(c=>/\/jobs\/github/.test(c.url)),false);
    p.window.renderJobs({...props,revision:'2'});await wait();
    assert.equal(p.doc.querySelectorAll('.ci-child-job').length,2);
  }finally{p.close();}
});

test('explicit CI subscription pins commit, retries same request and stops without cancelling a run',async()=>{
  let count=0;
  const p=mount((url,body)=>{
    if(url==='/api/ci' && body){count++;if(count===1)throw new Error('Response lost');return ciSub;}
    return url.startsWith('/api/ci?')?ciPage:page([]);
  });
  try{
    await open(p);
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job',{detail:{taskId:'T-47',source:'github_actions',url:'https://github.com/o/r/pull/7',expectedSha:'a'.repeat(40)}}));
    await until(()=>button(p,'Subscribe to CI'));
    button(p,'Subscribe to CI').click();await until(()=>p.doc.querySelector('.ci-jobs [role="alert"]'));
    button(p,'Subscribe to CI').click();await until(()=>count===2);await until(()=>button(p,'Watch CI'));
    const sends=p.calls.filter(c=>c.url==='/api/ci'&&c.body);assert.equal(sends[0].body.requestId,sends[1].body.requestId);assert.equal(sends[0].body.expectedSha,'a'.repeat(40));assert.equal(sends[0].body.agentId,'a');
    // A PR URL sends no commit-watch target (Core refuses one there).
    assert.equal('branch' in sends[0].body || 'event' in sends[0].body,false);
    button(p,'Stop watching').click();await until(()=>p.calls.some(c=>c.url==='/api/ci/subscriptions/sub/stop'));
    assert.equal(p.calls.some(c=>/\/cancel|\/rerun|\/dispatch/.test(c.url)),false);
  }finally{p.close();}
});

const commitUrl = 'https://github.com/o/r/commit/'+'a'.repeat(40);
const commitSub = { ...ciSub, id:'commit-sub', watch:{kind:'commit',number:0,url:commitUrl,expectedSha:'a'.repeat(40),currentHeadSha:'a'.repeat(40),branch:'main',event:'push',state:'waiting_for_run',observedAt:'2026-10-15T01:00:00Z',error:null} };
test('a commit watch names its exact target, says it waits for a run, and its form sends branch and event',async()=>{
  const p=mount((url,body)=>{
    if(url==='/api/ci' && body)return commitSub;
    return url.startsWith('/api/ci?')?{runs:[],subscriptions:[commitSub],hasMore:false,nextBefore:null}:page([]);
  });
  try{
    await open(p);
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job',{detail:{taskId:'T-47',source:'github_actions',url:commitUrl,expectedSha:'a'.repeat(40)}}));
    await until(()=>button(p,'Subscribe to CI'));
    // The target is not guessed: both fields start empty and are required.
    assert.equal(field(p,'Branch of its runs').value,'');assert.equal(field(p,'Event of its runs').required,true);
    await fill(p,'Branch of its runs','main');await fill(p,'Event of its runs','push');
    button(p,'Subscribe to CI').click();await until(()=>p.calls.some(c=>c.url==='/api/ci'&&c.body));
    const sent=p.calls.find(c=>c.url==='/api/ci'&&c.body).body;
    assert.equal(sent.url,commitUrl);assert.equal(sent.branch,'main');assert.equal(sent.event,'push');assert.equal(sent.expectedSha,'a'.repeat(40));
    await until(()=>p.doc.querySelector('.ci-subscription'));
    const row=p.doc.querySelector('.ci-subscription');
    assert.match(row.textContent,/Commit aaaaaaaa · main · push/);
    assert.match(row.textContent,/Waiting for a run of aaaaaaaa/);
    assert.equal(row.querySelector('a').getAttribute('href'),commitUrl);
  }finally{p.close();}
});

test('CI detail read failure retains the last observed run and does not invent a terminal failure',async()=>{
  const p=mount(url=>url.startsWith('/api/ci/')?{run:ciRun,error:'rate_limited: retry later',details:null}:url.startsWith('/api/ci?')?ciPage:page([]));
  try{
    await open(p);button(p,'GitHub Actions').click();await until(()=>p.doc.querySelector('.ci-jobs .job-row'));p.doc.querySelector('.ci-jobs .job-row').click();
    await until(()=>p.doc.querySelector('.ci-jobs [role="alert"]'));
    assert.match(p.doc.querySelector('.ci-jobs .job-detail').textContent,/Passed/);
    assert.match(p.doc.querySelector('.ci-jobs [role="alert"]').textContent,/rate_limited/);
    assert.equal(p.calls.some(c=>c.body && c.url.includes('/peer_read')),false);
  }finally{p.close();}
});

const ciRunning = (observedAt, step) => ({run:{...ciRun,status:'running',rawStatus:'in_progress',conclusion:null,observedAt},error:null,details:{jobs:[{id:1,name:'Build',status:'running',url:'https://github.com/o/r/actions/runs/42/job/1',steps:[{number:1,name:'Compile',status:step,conclusion:step==='completed'?'success':null}]}],page:1,hasMore:false,nextPage:null,observedAt}});
const refreshButton = p => p.doc.querySelector('button[aria-label="Check CI with GitHub now"]');
const checkLine = p => p.doc.querySelector('.ci-check')?.textContent || '';
function hide(p, hidden) {
  Object.defineProperty(p.doc, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(p.doc, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  p.doc.dispatchEvent(new p.window.Event('visibilitychange'));
}

test('manual CI refresh asks GitHub through Core once, shows it is busy, then the check and the new steps',async()=>{
  const before=ciRunning('2026-10-15T01:00:00Z','in_progress'),after=ciRunning('2026-10-15T01:05:00Z','completed');
  let listed=before.run,release;const held=new Promise(r=>{release=r;});
  const p=mount(async(url,body)=>{
    if(url==='/api/ci/refresh'&&body){await held;listed=after.run;return {status:'checked',checkedAt:after.run.observedAt,retryAt:null,error:null,paused:0,more:0,runWatched:true,run:after.run,details:[after.details]};}
    if(url.startsWith('/api/ci/'))return before;
    return url.startsWith('/api/ci?')?{...ciPage,runs:[listed]}:page([]);
  });
  const reads=()=>p.calls.filter(c=>c.url.startsWith('/api/ci/github')).length;
  try{
    await open(p);button(p,'GitHub Actions').click();await until(()=>p.doc.querySelector('.ci-jobs .job-row'));p.doc.querySelector('.ci-jobs .job-row').click();
    await until(()=>p.doc.querySelector('.ci-child-job li .ci-step-state')?.textContent==='in_progress');
    refreshButton(p).click();await until(()=>checkLine(p).includes('Checking with GitHub'));
    assert.equal(refreshButton(p).disabled,true);assert.equal(refreshButton(p).getAttribute('aria-busy'),'true');
    refreshButton(p).click();await wait();
    const asks=p.calls.filter(c=>c.url==='/api/ci/refresh');
    assert.equal(asks.length,1);assert.equal(asks[0].body.runKey,ciRun.id);assert.equal(asks[0].body.pages,1);
    // The old steps stay on screen while GitHub is asked.
    assert.equal(p.doc.querySelector('.ci-child-job li .ci-step-state').textContent,'in_progress');
    const listsBefore=p.calls.filter(c=>c.url.startsWith('/api/ci?')).length;
    release();
    await until(()=>checkLine(p).startsWith('Checked with GitHub at'));
    await until(()=>p.doc.querySelector('.ci-child-job li .ci-step-state')?.textContent==='success');
    await until(()=>p.calls.filter(c=>c.url.startsWith('/api/ci?')).length>listsBefore);await wait();
    assert.equal(refreshButton(p).disabled,false);
    // Its steps came with the check: no second read of the same observation.
    assert.equal(reads(),1);
    assert.equal(p.doc.querySelector('.ci-jobs-observed').textContent.includes('predates'),false);
    assert.equal(p.calls.some(c=>/\/cancel|\/rerun|\/dispatch|\/subscriptions/.test(c.url)||(c.url==='/api/ci'&&c.body)),false);
  }finally{release();p.close();}
});

test('a failed, rate-limited or empty CI check keeps the last observation and says why',async()=>{
  const before=ciRunning('2026-10-15T01:00:00Z','in_progress');
  const answers=[{httpStatus:400,error:'busy: CI reads are busy; retry shortly'},{status:'cooldown',checkedAt:null,retryAt:'2026-10-15T02:00:00Z',error:'rate_limited: GitHub rate limit reached; retry later',paused:1,more:0,runWatched:true,run:null,details:null},{status:'nothing',checkedAt:null,retryAt:null,error:null,paused:0,more:0,runWatched:false,run:null,details:null}];
  const p=mount((url,body)=>{
    if(url==='/api/ci/refresh'&&body)return answers.shift();
    if(url.startsWith('/api/ci/'))return before;
    return url.startsWith('/api/ci?')?{...ciPage,runs:[before.run],cooldownUntil:'2026-10-15T01:30:00Z'}:page([]);
  });
  try{
    await open(p);button(p,'GitHub Actions').click();await until(()=>p.doc.querySelector('.ci-jobs .job-row'));
    assert.match(checkLine(p),/GitHub is limiting reads until .*last successful observation/);
    p.doc.querySelector('.ci-jobs .job-row').click();await until(()=>p.doc.querySelector('.ci-child-job'));
    refreshButton(p).click();await until(()=>checkLine(p).startsWith("Couldn't check GitHub: busy"));
    assert.match(checkLine(p),/last successful observation/);
    assert.equal(p.doc.querySelector('.ci-child-job li .ci-step-state').textContent,'in_progress');
    assert.match(p.doc.querySelector('.ci-jobs .job-detail').textContent,/Running/);
    refreshButton(p).click();await until(()=>checkLine(p).startsWith('GitHub is limiting reads until'));
    assert.match(checkLine(p),/1 watch paused after repeated failures was not checked; subscribe again to resume/);
    assert.equal(p.doc.querySelector('.ci-child-job li .ci-step-state').textContent,'in_progress');
    refreshButton(p).click();await until(()=>checkLine(p).includes('not being watched'));
    assert.equal(p.calls.filter(c=>c.url==='/api/ci/refresh').length,3);
    assert.equal(p.doc.querySelectorAll('.ci-child-job').length,1);
  }finally{p.close();}
});

test('a CI check that returns after another run was chosen does not replace its steps',async()=>{
  const other={...ciRun,id:'github:123:43:1',runId:'43',name:'Docs',attempt:'1'};
  const running=ciRunning('2026-10-15T01:00:00Z','in_progress');
  let release;const held=new Promise(r=>{release=r;});
  const p=mount(async(url,body)=>{
    if(url==='/api/ci/refresh'&&body){await held;return {status:'checked',checkedAt:'2026-10-15T01:05:00Z',retryAt:null,error:null,paused:0,more:0,runWatched:true,run:ciRunning('2026-10-15T01:05:00Z','completed').run,details:[ciRunning('2026-10-15T01:05:00Z','completed').details]};}
    if(url===`/api/ci/${encodeURIComponent(other.id)}?page=1`)return {run:other,error:null,details:{jobs:[{id:9,name:'Docs build',status:'passed',url:'https://github.com/o/r/actions/runs/43/job/9',steps:[]}],page:1,hasMore:false,nextPage:null,observedAt:other.observedAt}};
    if(url.startsWith('/api/ci/'))return running;
    return url.startsWith('/api/ci?')?{...ciPage,runs:[running.run,other]}:page([]);
  });
  try{
    await open(p);button(p,'GitHub Actions').click();await until(()=>p.doc.querySelectorAll('.ci-jobs .job-row').length===2);
    p.doc.querySelectorAll('.ci-jobs .job-row')[0].click();await until(()=>p.doc.querySelector('.ci-child-job'));
    refreshButton(p).click();await until(()=>checkLine(p).includes('Checking'));
    p.doc.querySelectorAll('.ci-jobs .job-row')[1].click();await until(()=>p.doc.querySelector('.ci-child-job summary')?.textContent.startsWith('Docs build'));
    release();await until(()=>!refreshButton(p).disabled);await wait();
    assert.ok(!checkLine(p).includes('Checked with GitHub'), 'the old selection check is not shown for the new run');
    assert.equal(p.doc.querySelector('.ci-child-job summary').textContent.startsWith('Docs build'),true);
    assert.equal(p.doc.querySelectorAll('.ci-child-job').length,1);
  }finally{release();p.close();}
});

test('open CI details refresh loaded pages on a run transition or a running run\'s new observation, not unrelated revisions or while hidden',async()=>{
  let run={...ciRun,status:'running',rawStatus:'in_progress',conclusion:null},hold=null,release=null;
  const detail=number=>({run,error:null,details:{jobs:[{id:number,name:'Job '+number,status:run.status,url:'https://github.com/o/r/actions/runs/42/job/'+number,steps:[{number:1,name:'Compile',status:run.rawStatus,conclusion:run.conclusion}]}],page:number,hasMore:number===1,nextPage:number===1?2:null,observedAt:run.observedAt}});
  const p=mount(async url=>{
    if(url.startsWith('/api/ci/')){if(hold)await hold;return detail(url.endsWith('page=2')?2:1);}
    return url.startsWith('/api/ci?')?{...ciPage,runs:[run]}:page([]);
  });
  const reads=()=>p.calls.filter(c=>c.url.startsWith('/api/ci/')).length;
  try{
    await open(p);button(p,'GitHub Actions').click();await until(()=>p.doc.querySelector('.ci-jobs .job-row'));p.doc.querySelector('.ci-jobs .job-row').click();
    await until(()=>p.doc.querySelector('.ci-child-job'));button(p,'More jobs').click();await until(()=>p.doc.querySelectorAll('.ci-child-job').length===2);assert.equal(reads(),2);
    // Hidden: a new observation of the running run reads no steps.
    hide(p,true);
    run={...run,observedAt:'2026-10-15T01:01:00Z'};p.window.renderJobs({...props,revision:'2'});
    await until(()=>p.doc.querySelector('.ci-jobs-observed')?.textContent.includes('predates'));await wait();assert.equal(reads(),2);
    // Shown again: one catch-up read of the loaded pages.
    hide(p,false);
    await until(()=>reads()===4);await until(()=>!p.doc.querySelector('.ci-jobs-observed').textContent.includes('predates'));
    hide(p,false);await wait();assert.equal(reads(),4);
    hold=new Promise(r=>{release=r;});run={...ciRun,observedAt:'2026-10-15T01:02:00Z'};p.window.renderJobs({...props,revision:'3'});
    await until(()=>reads()===5);
    // An unrelated revision during the detail request must not discard it.
    p.window.renderJobs({...props,revision:'4'});await wait();release();hold=null;
    await until(()=>[...p.doc.querySelectorAll('.ci-child-job summary')].length===2 && [...p.doc.querySelectorAll('.ci-child-job summary')].every(el=>el.textContent.includes('Passed')));
    assert.equal(reads(),6);assert.equal(!!button(p,'More jobs'),false);
    assert.equal([...p.doc.querySelectorAll('.ci-child-job li .ci-step-state')].every(el=>el.textContent==='success'),true);
    assert.equal(p.doc.querySelector('.ci-jobs-observed').textContent.includes('predates'),false);
    for(let n=5;n<8;n++){p.window.renderJobs({...props,revision:String(n)});await wait();}
    assert.equal(reads(),6);
  }finally{release?.();p.close();}
});

test('terminal detail refresh failure retains paged snapshots and their own observation time',async()=>{
  let terminal=false;
  const run=()=>terminal?{...ciRun,observedAt:'2026-10-15T01:02:00Z'}:{...ciRun,status:'running',rawStatus:'in_progress',conclusion:null};
  const p=mount(url=>{
    if(url.startsWith('/api/ci/')){
      const number=url.endsWith('page=2')?2:1;
      if(terminal&&number===2)return {run:run(),details:null,error:'rate_limited: retry later'};
      return {run:run(),error:null,details:{jobs:[{id:number,name:'Job '+number,status:run().status,url:'https://github.com/o/r/actions/runs/42/job/'+number,steps:[]}],page:number,hasMore:number===1,nextPage:number===1?2:null,observedAt:run().observedAt}};
    }
    return url.startsWith('/api/ci?')?{...ciPage,runs:[run()]}:page([]);
  });
  try{
    await open(p);button(p,'GitHub Actions').click();await until(()=>p.doc.querySelector('.ci-jobs .job-row'));p.doc.querySelector('.ci-jobs .job-row').click();
    await until(()=>p.doc.querySelector('.ci-child-job'));button(p,'More jobs').click();await until(()=>p.doc.querySelectorAll('.ci-child-job').length===2);
    const oldStamp=p.doc.querySelector('.ci-jobs-observed').textContent;
    terminal=true;p.window.renderJobs({...props,revision:'2'});await until(()=>p.doc.querySelector('.ci-jobs [role="alert"]'));
    assert.equal(p.doc.querySelectorAll('.ci-child-job').length,2);
    assert.equal([...p.doc.querySelectorAll('.ci-child-job summary')].every(el=>el.textContent.includes('Running')),true);
    assert.ok(p.doc.querySelector('.ci-jobs-observed').textContent.startsWith(oldStamp));
    assert.match(p.doc.querySelector('.ci-jobs-observed').textContent,/predates/);
    assert.match(p.doc.querySelector('.ci-jobs .job-detail').textContent,/Passed/);
    p.window.renderJobs({...props,revision:'3'});await wait();assert.equal(p.calls.filter(c=>c.url.startsWith('/api/ci/')).length,4);
  }finally{p.close();}
});


test('the machine card puts what jobs use on the bars of what they reserve, and use it cannot read is unknown', async () => {
  // 5% of 8 cores is 0.4 CPU of a 2 CPU budget; 0.5 CPU and 128 MiB are reserved.
  const reading = { at: '2026-10-18T19:00:00Z', cpu: { cores: 8, totalPct: 50, jobsPct: 5, agentsPct: null, otherPct: null },
    memory: { totalMiB: 16384, usedMiB: 8000, availableMiB: 8000, jobsMiB: 64, agentsMiB: null }, gpus: null, jobs: [] };
  const p = mount(url => url === '/api/machine-load' ? reading : page([]));
  try {
    await open(p);
    await until(() => p.doc.querySelector('.jobs-budget .jobs-meter-used'));
    const [cpu, ram] = p.doc.querySelectorAll('.jobs-budget .jobs-meter');
    assert.equal(cpu.querySelector('.jobs-meter-value').textContent, '0.4 in use');
    assert.equal(cpu.querySelector('.jobs-reserved-text').textContent, '0.5 / 2 reserved');
    assert.equal(cpu.querySelector('.jobs-meter-used').style.width, '20%');
    assert.equal(cpu.querySelector('.jobs-meter-reserved').style.width, '25%');
    assert.equal(cpu.querySelector('[role="meter"]').getAttribute('aria-label'), 'CPU: 0.4 in use, 0.5 of 2 reserved');
    assert.equal(ram.querySelector('.jobs-meter-value').textContent, '64 MiB in use');
    assert.equal(ram.querySelector('.jobs-reserved-text').textContent, '128 MiB / 2.0 GiB reserved');
    assert.equal(ram.querySelector('.jobs-meter-used').style.width, '3.125%');
    assert.equal(ram.querySelector('.jobs-meter-reserved').style.width, '6.25%');
    assert.equal(ram.querySelector('.jobs-budget-host').textContent, '2.0 GiB free on the host');
    assert.match(p.doc.querySelector('.jobs-budget-key').title, /bounded result collector/);
    // Hidden, the card stops reading the machine; shown again, it reads at once.
    Object.defineProperty(p.doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
    p.doc.dispatchEvent(new p.window.Event('visibilitychange'));
    await wait();
    const reads = () => p.calls.filter(c => c.url === '/api/machine-load').length;
    const hiddenReads = reads();
    await new Promise(resolve => setTimeout(resolve, 3_300));
    assert.equal(reads(), hiddenReads, 'no reading while hidden');
    Object.defineProperty(p.doc, 'visibilityState', { configurable: true, get: () => 'visible' });
    p.doc.dispatchEvent(new p.window.Event('visibilitychange'));
    await until(() => reads() > hiddenReads);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
  // An older Core, or a failed reading: reservations as before, use unknown and not drawn.
  const q = mount(url => url === '/api/machine-load' ? { httpStatus: 404, error: 'not found' } : page([]));
  try {
    await open(q);
    await until(() => q.doc.querySelector('.jobs-budget .jobs-meter-reserved'));
    await until(() => q.calls.some(c => c.url === '/api/machine-load'));
    await wait();
    const [cpu] = q.doc.querySelectorAll('.jobs-budget .jobs-meter');
    assert.equal(cpu.querySelector('.jobs-meter-value').textContent, 'unknown in use');
    assert.equal(cpu.querySelector('.jobs-reserved-text').textContent, '0.5 / 2 reserved');
    assert.equal(q.doc.querySelector('.jobs-budget .jobs-meter-used'), null);
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('machine budget takes the whole host, keeps the default apart, includes collectors and retains validation errors', async () => {
  let saves=0;
  const p=mount((url, body) => {
    if(url==='/api/jobs/budget' && body) return ++saves===1 ? {httpStatus:400,error:'Budget must be 200–4096000 mCPU, 128–67108864 MiB RAM and 0–67108864 MiB swap (including collectors)'} : body;
    return page([]);
  });
  try {
    await open(p);
    p.doc.querySelector('.job-budget-settings summary').click(); await wait();
    const form=p.doc.querySelector('.job-budget-settings');
    // T-160: this host's totals are for reference; no share of them is a ceiling.
    assert.match(form.textContent,/this host has 32 CPU · 40107 MiB RAM · 16384 MiB swap; the budget may use all of it\. Conservative default: 4 CPU/);
    assert.match(form.textContent,/has the RAM it needs free at that moment, keeping 2048 MiB for Core and the desktop\. CPU is a shared quota, not reserved cores/);
    assert.doesNotMatch(form.textContent,/ceiling/i);
    assert.match(form.textContent,/4.2 CPU and 8320 MiB/);
    assert.match(form.textContent,/Running jobs keep their original limits/);
    assert.deepEqual(['CPU quota','RAM (MiB)','Swap (MiB)'].map(name=>[field(p,name).min,field(p,name).max]),[['0.2','4096'],['128','67108864'],['0','67108864']]);
    await fill(p,'CPU quota','32'); await fill(p,'RAM (MiB)','40107'); await fill(p,'Swap (MiB)','16384');
    for (const name of ['CPU quota','RAM (MiB)','Swap (MiB)']) assert.equal(field(p,name).validity.valid,true,name);
    button(p,'Save budget').click(); await until(()=>form.querySelector('[role="alert"]'));
    assert.match(form.textContent,/Budget must be 200–4096000 mCPU/);
    assert.equal(field(p,'CPU quota').value,'32');
    assert.equal(form.open,true);
    const payload=p.calls.find(c=>c.url==='/api/jobs/budget' && c.body).body;
    assert.deepEqual(payload,{cpuMillis:32000,memoryMiB:40107,swapMiB:16384});
    button(p,'Save budget').click(); await until(()=>!form.open);
    assert.equal(saves,2);
    assert.equal(p.calls.some(c=>c.url.endsWith('/cancel') || (c.url==='/api/jobs' && c.body)),false);
  } finally {p.close();}
});

const review = (id, cursor, patch = {}) => ({ id, taskId: 'task-one', taskRef: 'T-1', taskTitle: 'Deliver PR', linkId: '7:pull:1', repository: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', round: 1, status: 'completed', phase: 'completed', conclusion: 'no_findings', requestedHarness: 'codex', requestedModel: 'gpt-6.1-sol', actualHarness: 'codex', actualModel: 'gpt-6.1-sol', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40), createdAt: '2026-10-15T01:00:00Z', finishedAt: '2026-10-15T01:10:00Z', error: null, requestedBy: { kind: 'agent', id: 'a', name: 'Mori' }, findingsCount: 0, outdated: false, cursor, ...patch });
const reviewPage = (reviews, more = null) => ({ reviews, hasMore: more != null, nextBefore: more });

test('Reviews are a read-only Jobs source: scopes, paging, states and the requester identity', async () => {
  const newest = [
    review('changes', 9, { conclusion: 'changes_requested', findingsCount: 2, outdated: true, round: 2 }),
    review('pre-model', 8, { status: 'failed', conclusion: 'unknown', actualHarness: null, actualModel: null, headSha: null, baseSha: null, outdated: null, error: 'Patch is incomplete', requestedBy: { kind: 'user', id: 'user', name: 'You' } }),
    review('lost', 7, { status: 'unknown', conclusion: 'unknown', error: 'Review deadline exceeded; completion is unknown', taskId: 'task-two', taskRef: 'T-2', taskTitle: 'Other PR', number: 8 }),
  ];
  let older = [review('legacy', 3, { requestedBy: null })];
  const p = mount(url => url === '/api/reviews?' ? reviewPage(newest, 4) : url === '/api/reviews?before=4' ? reviewPage(older) : url === '/api/reviews?agentId=a' ? reviewPage([newest[0]]) : page([]));
  try {
    await open(p); button(p, 'Reviews').click();
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 3);
    const rows = [...p.doc.querySelectorAll('.review-jobs .job-row')].map(r => r.textContent);
    assert.match(rows[0], /Changes requested · Outdated/); assert.match(rows[0], /o\/r#7 · Round 2/); assert.match(rows[0], /Requested by Mori/);
    // Each row: its name and time, its state and task, then who reviewed it.
    const part = (n, name) => p.doc.querySelectorAll('.review-jobs .job-row')[n].querySelector(name).textContent;
    assert.match(part(0, '.job-row-note'), /^Codex · gpt-6\.1-sol · head bbbbbbb · Requested by Mori$/); assert.equal(part(0, '.job-row-time'), '10m 0s');
    assert.match(part(1, '.job-state'), /^Failed$/); assert.match(rows[1], /Requested by you/);
    assert.match(part(1, '.job-row-note'), /^Codex · gpt-6\.1-sol \(requested\) · Requested by you$/); assert.equal(part(1, '.job-row-time'), '10m 0s'); assert.doesNotMatch(rows[1], /head/);
    assert.match(rows[2], /Outcome unknown/); assert.match(rows[2], /T-2 · Other PR/);
    assert.equal(!!p.doc.querySelector('.jobs-budget'), false);
    for (const label of ['New job', 'Review PR', 'Cancel review', 'Run again…']) assert.equal(!!button(p, label), false, label);
    p.doc.querySelectorAll('.review-jobs .job-row')[1].click(); await wait();
    const detail = () => p.doc.querySelector('.review-jobs .job-detail').textContent;
    assert.match(detail(), /Model not confirmed/); assert.match(detail(), /Patch is incomplete/); assert.doesNotMatch(detail(), /Findings\d/);
    p.doc.querySelectorAll('.review-jobs .job-row')[2].click(); await wait();
    assert.match(detail(), /Unknown is not a passing review/);
    p.doc.querySelectorAll('.review-jobs .job-row')[0].click(); await wait();
    assert.match(detail(), /Outdated · the PR's base or head changed/); assert.match(detail(), /Findings2/);
    button(p, 'Earlier reviews').click();
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 4);
    assert.match(p.doc.querySelectorAll('.review-jobs .job-row')[3].textContent, /Requester unknown \(older record\)/);
    assert.equal(!!button(p, 'Earlier reviews'), false);
    // A Jobs refresh re-reads the older page that was loaded too: its PR
    // changed, and the retained row and its detail must say so.
    p.doc.querySelectorAll('.review-jobs .job-row')[3].click(); await wait();
    assert.doesNotMatch(detail(), /Outdated/);
    older = [review('legacy', 3, { requestedBy: null, outdated: true })];
    p.window.renderJobs({ ...props, revision: '2' });
    await until(() => p.calls.filter(c => c.url === '/api/reviews?before=4').length === 2);
    await until(() => /Outdated/.test(p.doc.querySelectorAll('.review-jobs .job-row')[3]?.textContent || ''));
    assert.match(detail(), /Outdated · the PR's base or head changed/);
    assert.equal(p.doc.querySelectorAll('.review-jobs .job-row').length, 4);
    assert.equal(!!button(p, 'Earlier reviews'), false);
    assert.equal(p.calls.filter(c => c.url === '/api/reviews?').length, 2);
    button(p, 'Mori').click();
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 1);
    assert.match(p.doc.querySelector('.review-jobs').textContent, /Showing reviews Mori requested itself/);
    assert.equal(p.calls.some(c => c.url.startsWith('/api/reviews') && c.body), false);
    assert.equal(p.calls.some(c => c.url.includes('/api/pr-reviews')), false);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Opening a review report closes Jobs and names its task and review; nothing is started', async () => {
  const p = mount(url => url.startsWith('/api/reviews?') ? reviewPage([review('one', 2)]) : page([]));
  const opened = [];
  p.window.addEventListener('yuzuno:open-task-review', e => opened.push(e.detail));
  try {
    await open(p); button(p, 'Reviews').click();
    await until(() => p.doc.querySelector('.review-jobs .job-row'));
    p.doc.querySelector('.review-jobs .job-row').click(); await wait();
    button(p, 'Open full report in T-1').click();
    await until(() => !p.doc.querySelector('[role="dialog"]'));
    assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ taskId: 'T-1', reviewId: 'one' }]);
    assert.equal(p.calls.some(c => c.body), false);
  } finally { p.close(); }
});

test('A link to an old review reads it directly; late, hidden and failed reads stay bounded', async () => {
  let releaseWorkspace;
  const slow = new Promise(r => { releaseWorkspace = r; });
  let fail = false;
  const p = mount(url => {
    if (url === '/api/reviews?taskId=task-one&reviewId=old') return reviewPage([review('old', 1, { status: 'cancelled', conclusion: 'unknown' })]);
    if (url === '/api/reviews?taskId=task-one') return reviewPage([review('new', 30)], 30);
    if (url === '/api/reviews?') return slow;
    if (url === '/api/reviews?agentId=a') return fail ? { httpStatus: 503, error: 'Core is restarting' } : reviewPage([]);
    return page([]);
  });
  try {
    await until(() => p.doc.querySelector('[aria-label="Jobs"]'));
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job', { detail: { source: 'reviews', taskId: 'task-one', reviewId: 'old' } }));
    await until(() => p.doc.querySelector('.review-jobs .job-detail h3'));
    assert.match(p.doc.querySelector('.review-jobs .job-detail').textContent, /Cancelled/);
    assert.equal(p.doc.querySelector('.job-task-scope').textContent, 'Task task-one');
    assert.equal(p.calls.filter(c => c.url.startsWith('/api/reviews?taskId=task-one&before')).length, 0, 'no paging to find it');
    // A slow Workspace read finishing after the scope moved on is dropped.
    button(p, 'Workspace').click(); await wait();
    // The link belonged to its task's scope; another scope starts unselected.
    assert.match(p.doc.querySelector('.review-jobs .job-detail').textContent, /Select a review/);
    button(p, 'Mori').click();
    await until(() => p.doc.querySelector('.review-jobs .jobs-empty')?.textContent.startsWith('No reviews requested by Mori'));
    assert.match(p.doc.querySelector('.review-jobs .job-detail').textContent, /Select a review/);
    assert.equal(p.calls.filter(c => c.url.includes('reviewId=old')).length, 1);
    releaseWorkspace(reviewPage([review('stale-workspace', 99)])); await wait(); await wait();
    assert.doesNotMatch(p.doc.body.textContent, /stale-workspace/);
    // Hidden: Jobs changes wait until the window is visible again, then read once.
    Object.defineProperty(p.doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const before = p.calls.filter(c => c.url === '/api/reviews?agentId=a').length;
    p.window.renderJobs({ ...props, revision: '7' }); await wait();
    assert.equal(p.calls.filter(c => c.url === '/api/reviews?agentId=a').length, before);
    fail = true;
    Object.defineProperty(p.doc, 'visibilityState', { configurable: true, get: () => 'visible' });
    p.doc.dispatchEvent(new p.window.Event('visibilitychange'));
    await until(() => p.doc.querySelector('.review-jobs [role="alert"]'));
    assert.equal(p.calls.filter(c => c.url === '/api/reviews?agentId=a').length, before + 1);
    assert.match(p.doc.querySelector('.review-jobs [role="alert"]').textContent, /Core is restarting/);
    fail = false;
    p.doc.querySelector('[aria-label="Refresh reviews"]').click();
    await until(() => !p.doc.querySelector('.review-jobs [role="alert"]'));
    assert.equal(p.calls.some(c => c.body), false);
  } finally { p.close(); }
});

test('A linked review outside the newest page refreshes with Jobs, and Refresh retries a failed read', async () => {
  let state = 'fail';
  const p = mount(url => {
    if (url === '/api/reviews?taskId=task-one&reviewId=old') {
      if (state === 'fail') return { httpStatus: 503, error: 'Core is restarting' };
      return reviewPage([review('old', 1, state === 'running'
        ? { status: 'running', phase: 'Reviewing full PR', conclusion: 'unknown', finishedAt: null }
        : { conclusion: 'changes_requested', findingsCount: 3, outdated: true })]);
    }
    if (url === '/api/reviews?taskId=task-one') return reviewPage([review('new', 30)], 30);
    return page([]);
  });
  const linkedReads = () => p.calls.filter(c => c.url === '/api/reviews?taskId=task-one&reviewId=old').length;
  const detail = () => p.doc.querySelector('.review-jobs .job-detail').textContent;
  try {
    await until(() => p.doc.querySelector('[aria-label="Jobs"]'));
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job', { detail: { source: 'reviews', taskId: 'task-one', reviewId: 'old' } }));
    await until(() => p.doc.querySelector('.review-jobs .job-detail [role="alert"]'));
    assert.match(detail(), /Core is restarting/);
    state = 'running';
    p.doc.querySelector('[aria-label="Refresh reviews"]').click();
    await until(() => p.doc.querySelector('.review-jobs .job-detail h3'));
    assert.match(detail(), /Reviewing · Reviewing full PR/);
    assert.equal(!!p.doc.querySelector('.review-jobs .job-detail [role="alert"]'), false);
    state = 'done';
    p.window.renderJobs({ ...props, revision: '9' });
    await until(() => /Changes requested/.test(detail()));
    assert.match(detail(), /Outdated · the PR's base or head changed/);
    assert.match(detail(), /Findings3/);
    assert.equal(linkedReads(), 3);
    // Once another review is chosen, the link is no longer re-read.
    p.doc.querySelector('.review-jobs .job-row').click(); await wait();
    const lists = p.calls.filter(c => c.url === '/api/reviews?taskId=task-one').length;
    p.window.renderJobs({ ...props, revision: '10' });
    await until(() => p.calls.filter(c => c.url === '/api/reviews?taskId=task-one').length === lists + 1);
    await wait();
    assert.equal(linkedReads(), 3);
    assert.equal(p.calls.some(c => c.body), false);
  } finally { p.close(); }
});

test('A refresh re-reads at most ten loaded pages and drops older rows instead of keeping them stale', async () => {
  const all = Array.from({ length: 300 }, (_, i) => review(`r${300 - i}`, 300 - i));
  const p = mount(url => {
    if (!url.startsWith('/api/reviews?')) return page([]);
    const before = Number(new URL(url, 'http://x').searchParams.get('before')) || Infinity;
    const rows = all.filter(r => r.cursor < before).slice(0, 20);
    const more = all.some(r => r.cursor < rows.at(-1).cursor);
    return reviewPage(rows, more ? rows.at(-1).cursor : null);
  });
  const lists = () => p.calls.filter(c => c.url.startsWith('/api/reviews?')).length;
  try {
    await open(p); button(p, 'Reviews').click();
    // Finished reviews fold after ten; earlier pages come once all show.
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 10);
    assert.equal(!!button(p, 'Earlier reviews'), false);
    button(p, 'Show 10 more').click();
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 20);
    for (let n = 2; n <= 12; n++) {
      button(p, 'Earlier reviews').click();
      await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === n * 20);
    }
    const before = lists();
    p.window.renderJobs({ ...props, revision: '5' });
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 200);
    await wait();
    assert.equal(lists() - before, 10);
    assert.ok(button(p, 'Earlier reviews'), 'older reviews can be loaded again');
  } finally { p.close(); }
});
test('each kind keeps to its own limit from Settings, and 0 leaves its group off the conversation dock', async () => {
  const running = n => ({ ...ciRun, id: `github:123:4${n}:1`, runId: `4${n}`, attempt: '1', name: `CI ${n}`, status: 'running', rawStatus: 'in_progress', conclusion: null });
  const finished = n => ({ ...job, id: `job-done-${n}`, name: `done ${n}`, status: 'succeeded', reserved: false, finishedAt: new Date(Date.now() - n * 60_000).toISOString() });
  const answer = url => url.startsWith('/api/ci') ? { runs: [1, 2, 3, 4, 5].map(running), subscriptions: [], hasMore: false, nextBefore: null } : page([3, 1, 2].map(finished));
  const group = (p, label) => p.doc.querySelector(`.work-dock [role="group"][aria-label="${label}"]`);
  const marks = (p, label) => [...(group(p, label)?.querySelectorAll('.conversation-job .work-dock-label strong') || [])].map(s => s.textContent);
  const more = (p, label) => group(p, label)?.querySelector('.work-dock-more')?.getAttribute('aria-label');
  const limits = dock => ({ 'yuzuno.appearance': JSON.stringify({ dock }) });
  // Unchanged: up to five local jobs, the latest finished first, and two runs.
  let p = mount(answer);
  try {
    await until(() => marks(p, 'Local jobs').length === 3 && marks(p, 'GitHub Actions').length === 2);
    assert.deepEqual(marks(p, 'Local jobs'), ['done 1', 'done 2', 'done 3']);
    assert.equal(more(p, 'Local jobs'), undefined);
    assert.equal(more(p, 'GitHub Actions'), 'GitHub Actions: 3 more, open the list');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
  p = mount(answer, limits({ jobs: 1, actions: 0, subAgents: 5 }));
  try {
    await until(() => marks(p, 'Local jobs').length === 1 && p.calls.some(c => c.url.startsWith('/api/ci?')));
    await wait();
    assert.deepEqual(marks(p, 'Local jobs'), ['done 1']);
    assert.equal(more(p, 'Local jobs'), 'Local jobs: 2 more, open the list');
    assert.equal(group(p, 'GitHub Actions'), null, 'no runs, no notice and no more link');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
  p = mount(answer, limits({ jobs: 0, actions: 3, subAgents: 5 }));
  try {
    await until(() => marks(p, 'GitHub Actions').length === 3);
    assert.equal(group(p, 'Local jobs'), null);
    assert.equal(more(p, 'GitHub Actions'), 'GitHub Actions: 2 more, open the list');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('the dock keeps its marks while a refresh or a return to the conversation is still loading, so the conversation keeps its place', async () => {
  // A conversation whose dock holds only CI marks: every refresh reads CI
  // again, and the dock must not empty out while that read is out.
  let release = () => {};
  let hold = false;
  const p = mount(async url => {
    if (url.startsWith('/api/ci?')) {
      if (hold) await new Promise(r => { release = r; });
      return url.includes('agentId=b') ? { runs: [], subscriptions: [], hasMore: false, nextBefore: null } : ciPage;
    }
    return page([]);
  });
  const marks = () => p.doc.querySelectorAll('.work-dock .conversation-job').length;
  try {
    await until(() => marks() === 1);
    hold = true;
    p.window.renderJobs({ ...props, revision: '2' });
    await until(() => p.calls.filter(c => c.url.startsWith('/api/ci?')).length === 2);
    await wait();
    assert.equal(marks(), 1, 'a refresh in flight keeps the CI mark');
    release(); await wait();
    // Away to another conversation and back: the last answer shows at once.
    hold = false;
    p.window.renderJobs({ ...props, agent: { ...agent, id: 'b', name: 'Hana' } });
    await until(() => p.calls.some(c => c.url.includes('/api/ci?agentId=b'))); await wait();
    assert.equal(marks(), 0);
    hold = true;
    p.window.renderJobs({ ...props, revision: '3' });
    await wait();
    assert.equal(marks(), 1, 'coming back shows the last marks before the new read answers');
    release(); await wait();
    assert.deepEqual(p.errors, []);
  } finally { release(); p.close(); }
});
