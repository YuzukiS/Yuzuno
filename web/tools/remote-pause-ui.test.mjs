// T-108: a job on another machine offers pause only when its attempt runs in
// a scope of its own there (as Core decides, remote.rs pause_refusal); one
// without, and one on Windows, say why and send nothing. A paused remote job
// says where it is paused and what stays.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/remote-pause-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};window.renderJobs=p=>createRoot(document.getElementById('root')).render(<Jobs {...p}/>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'RemotePauseUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 120; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const agent = { id: 'a', name: 'Mori', cwd: '/workspace', status: 'working' };
const resources = { cpuMillis: 500, memoryMiB: 128, swapMiB: 0 };
const started = new Date(Date.now() - 60_000).toISOString();
const base = { id: 'job-1', name: 'Eval on lab box', requestId: 'r', taskRef: 'T-108', agentId: 'a', agent: { name: 'Mori' },
  machine: { name: 'lab box' }, executor: { kind: 'ssh', machineId: 'm1' }, resources, reservation: resources,
  createdAt: started, startedAt: started, finishedAt: null, argv: ['/bin/sh', '-c', 'make'], cwd: '/home/u/work', env: {},
  cursor: 1, reserved: true, status: 'running', reason: 'Running on lab box in its own process group (4242)', timeoutSeconds: 3600 };
const scoped = { ...base, result: { started: { limits: { mode: 'limited', held: { unit: 'yuzuno-remote-job-a.scope' } } } } };
const bare = { ...base, result: { started: { limits: { mode: 'limited', held: null } } } };
const windows = { ...base, machine: { name: 'Windows on this PC' }, executor: { kind: 'windows', machineId: 'windows' } };
const page = jobs => ({ jobs, liveJobs: [], hasMore: false, nextBefore: null });

function mount(state) {
  const vc = new VirtualConsole(), errors = [], calls = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    let value;
    if (url === '/api/jobs/budget') value = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 1, queuedCount: 0, collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 }, machine: { name: 'WSL', memoryAvailableMiB: 2000, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, logicalCpus: 32, memoryTotalMiB: 40107, swapTotalMiB: 16384, hostHeadroomMiB: 2048 } };
    else if (url.endsWith('/logs')) value = { text: '', oldestOffset: 0, totalBytes: 0 };
    else if (url === '/api/jobs/job-1/pause') {
      state.job = { ...state.job, pause: { intent: 'pause', state: 'paused', requestedAt: started, confirmedAt: started,
        reason: 'Paused: every process in its scope on this machine is frozen; its memory and the machine\'s reservation are kept' } };
      value = state.job;
    } else if (url === '/api/jobs/job-1') value = state.job;
    else value = page([state.job]);
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  w.renderJobs({ workspaceId: 'w', agent, revision: '1', disabled: false });
  return { window: w, doc: w.document, calls, errors, close: () => w.close() };
}
const button = (p, text) => [...p.doc.querySelectorAll('.job-detail button')].find(b => b.textContent.trim() === text);
async function select(p) {
  await until(() => p.doc.querySelector('[aria-label="Jobs"]'));
  p.doc.querySelector('[aria-label="Jobs"]').click();
  await until(() => p.doc.querySelector('.job-row'));
  p.doc.querySelector('.job-row').click();
  await until(() => p.doc.querySelector('.job-detail-heading h3'));
}
const posts = p => p.calls.filter(c => c.method === 'POST').map(c => c.url);

test('a remote job in a scope of its own is paused there, and says where and what stays', async () => {
  const state = { job: scoped };
  const p = mount(state);
  try {
    await select(p);
    assert.equal(button(p, 'Pause').disabled, false);
    button(p, 'Pause').click();
    await until(() => button(p, 'Resume'));
    assert.deepEqual(posts(p), ['/api/jobs/job-1/pause']);
    assert.match(p.doc.querySelector('.job-pause-note').textContent,
      /^Paused on lab box\. Its memory and the machine's reservation stay; only you can resume it\./);
    assert.equal(button(p, 'Resume').disabled, false);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a remote job without a scope of its own, and one on Windows, cannot be paused and say why', async () => {
  for (const [job, why] of [[bare, /^Not available: this job runs without a scope of its own on lab box \(no limits are held for it there\)/],
    [windows, /^Not available for jobs on Windows on this PC$/]]) {
    const p = mount({ job });
    try {
      await select(p);
      const pause = button(p, 'Pause');
      assert.equal(pause.disabled, true);
      assert.match(pause.title, why);
      pause.click();
      await wait();
      assert.deepEqual(posts(p), [], 'nothing is sent');
      assert.equal(button(p, 'Cancel').disabled, false, 'cancel stays available');
    } finally { p.close(); }
  }
});
