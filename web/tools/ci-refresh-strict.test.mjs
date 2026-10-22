// The CI check under React.StrictMode, as the app root renders it. Only a
// development build runs effect setup, cleanup and setup again, so this file
// builds in development rather than sharing jobs-ui.test.mjs's bundle.
import './jsdom-guard.mjs';
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/ci-refresh-strict-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {CiJobs,runActive} from ${JSON.stringify(path.join(root, 'src/CiJobs.tsx'))};window.runActive=runActive;const agent={id:'a',name:'Mori',cwd:'/workspace',status:'working'};createRoot(document.getElementById('root')).render(<React.StrictMode><CiJobs scope={{agentId:'a'}} owners={[agent]} revision="1" initial={{}}/></React.StrictMode>);`);
  const result = await build({ root, configFile: false, mode: 'development', define: { 'process.env.NODE_ENV': JSON.stringify('development') }, logLevel: 'silent', plugins: [react()], build: { write: false, minify: false, lib: { entry, name: 'CiStrict', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }
const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 100; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }

test('a CI check under StrictMode finishes: its answer is shown and the button is usable again', async () => {
  const run = { id: 'github:123:42:1', name: 'CI', repository: 'o/r', runId: '42', attempt: '1', headSha: 'a'.repeat(40), status: 'running', rawStatus: 'in_progress', conclusion: null, url: 'https://github.com/o/r/actions/runs/42/attempts/1', observedAt: '2026-10-15T01:00:00Z', cursor: 1 };
  const vc = new VirtualConsole(), calls = [];
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    const value = url === '/api/ci/refresh'
      ? { status: 'checked', checkedAt: '2026-10-15T01:05:00Z', retryAt: null, error: null, paused: 0, more: 0, runWatched: null, run: null, details: null }
      : { runs: [run], subscriptions: [], hasMore: false, nextBefore: null };
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  try {
    w.eval(bundle);
    await until(() => w.document.querySelector('.ci-jobs .job-row'));
    const button = () => w.document.querySelector('button[aria-label="Check CI with GitHub now"]');
    button().click();
    await until(() => (w.document.querySelector('.ci-check')?.textContent || '').startsWith('Checked with GitHub at'));
    assert.equal(button().disabled, false);
    assert.equal(calls.filter(c => c.url === '/api/ci/refresh').length, 1);
  } finally { w.close(); }
});

test('closed CI subscriptions show the retained reason and no stop action', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true });
  const reasons = ['task_completed', 'task_cancelled', 'task_archived', 'pr_merged', 'verification_completed', 'explicit_stop', 'expired'];
  const calls = [];
  dom.window.fetch = async (url, init = {}) => {
    calls.push({url, method:init.method || 'GET'});
    const value = { runs: [], hasMore: false, nextBefore: null, subscriptions: reasons.map((reason, i) => ({
      id:`sub-${i}`, agentId:'a', agent:{name:'Mori'}, taskRef:`T-${i+1}`, active:false,
      expiresAt:'2026-10-22T01:00:00Z', closure:{reason, at:'2026-10-16T01:00:00Z'},
      watchId:`watch-${i}`, watch:{id:`watch-${i}`,kind:'pull',number:i+1,url:`https://github.com/o/r/pull/${i+1}`,
        expectedSha:'a'.repeat(40),currentHeadSha:'a'.repeat(40),state:'watching',error:null,observedAt:'2026-10-16T00:59:00Z'}
    })) };
    return {ok:true,status:200,json:async()=>structuredClone(value),text:async()=>JSON.stringify(value)};
  };
  try {
    dom.window.eval(bundle);
    await until(() => dom.window.document.querySelectorAll('.ci-subscription').length === reasons.length);
    const text = dom.window.document.body.textContent;
    for (const label of ['Task completed','Task cancelled','Task archived','PR merged','Run verification completed','Stopped explicitly','Subscription expired']) assert.ok(text.includes(label),label);
    assert.ok(text.includes('0 active'));
    assert.ok(![...dom.window.document.querySelectorAll('button')].some(b=>b.textContent.includes('Stop watching')));
    assert.ok(calls.every(c=>c.method === 'GET'));
  } finally { dom.window.close(); }
});

test('unwatched running history is not active; a single refresh shows the actual terminal result without subscribing', async () => {
  let run = { id:'github:123:42:1', name:'Old CI', repository:'o/r', runId:'42', attempt:'1', headSha:'a'.repeat(40), status:'running', rawStatus:'in_progress', conclusion:null, url:'https://github.com/o/r/actions/runs/42/attempts/1', observedAt:'2026-10-15T01:00:00Z', cursor:1, runWatched:false };
  let release;
  const held = new Promise(r => { release = r; });
  const dom = new JSDOM('<div id="root"></div>', {url:'http://isolated.test',runScripts:'outside-only',pretendToBeVisual:true});
  const w = dom.window, calls = [];
  const details = () => ({jobs:[{id:1,name:'Build',status:'cancelled',steps:[]}],page:1,hasMore:false,nextPage:null,observedAt:run.observedAt});
  w.fetch = async (url, init = {}) => {
    calls.push({url,method:init.method || 'GET',body:init.body && JSON.parse(init.body)});
    let value;
    if (url === '/api/ci/refresh') {
      await held;
      run = {...run,status:'cancelled',rawStatus:'completed',conclusion:'cancelled',observedAt:'2026-10-15T01:05:00Z'};
      value = {status:'checked',checkedAt:run.observedAt,runWatched:false,run,details:[details()]};
    } else if (url.startsWith('/api/ci/')) value = {run,details:details(),error:null};
    else value = {runs:[run],subscriptions:[],hasMore:false,nextBefore:null};
    return {ok:true,status:200,json:async()=>structuredClone(value)};
  };
  try {
    w.eval(bundle);
    await until(()=>w.document.querySelector('.job-row'));
    assert.equal(w.runActive(run),false);
    assert.equal(w.runActive({...run,runWatched:true}),true);
    assert.equal(w.runActive({...run,runWatched:undefined}),true,'older Core compatibility');
    assert.equal(w.document.querySelector('.job-group-active'),null);
    assert.match(w.document.querySelector('.job-group-title').textContent,/History/);
    assert.match(w.document.querySelector('.job-row').textContent,/Last seen running/);
    w.document.querySelector('.job-row').click();
    await until(()=>w.document.querySelector('.ci-child-job'));
    assert.match(w.document.querySelector('.job-detail').textContent,/Not being watched.*last observation/);
    assert.match(w.document.querySelector('.job-detail-heading').textContent,/Last seen running/,'finished jobs do not override run fact');
    const button = w.document.querySelector('button[aria-label="Check CI with GitHub now"]');
    button.click();button.click();
    await until(()=>button.disabled);
    release();
    await until(()=>w.document.querySelector('.job-detail-heading').textContent.includes('Cancelled'));
    assert.equal(w.runActive(run),false);
    const line = w.document.querySelector('.ci-check').textContent;
    assert.match(line,/Checked with GitHub.*does not restart monitoring/);
    assert.ok(!line.includes('was not checked'));
    assert.deepEqual(calls.filter(c=>c.method !== 'GET'),[{url:'/api/ci/refresh',method:'POST',body:{agentId:'a',runKey:'github:123:42:1',pages:1}}]);
  } finally {release();w.close();}
});
