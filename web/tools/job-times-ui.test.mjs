// The Jobs list keeps two groups, still going and ended, a failure included;
// each row says quietly when it was queued and, once it has, when it
// finished. The conversation's dock gives each job its latest moment:
// finished, else started, else queued.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/job-times-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs, ConversationJobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};window.renderJobs=p=>createRoot(document.getElementById('root')).render(<><Jobs {...p}/><ConversationJobs agentId={p.agent.id} revision={p.revision} disabled={false}/></>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'JobTimesUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 120; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const agent = { id: 'a', name: 'Mori', cwd: '/workspace', status: 'working' };
const resources = { cpuMillis: 500, memoryMiB: 96, swapMiB: 0 };
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
// As the panel writes a moment: its time, with its date when not today.
const clock = (iso) => {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
};
const base = { requestId: 'r', taskRef: 'T-1', agentId: 'a', agent: { name: 'Mori' }, machine: { name: 'WSL' }, resources,
  reservation: { cpuMillis: 600, memoryMiB: 160, swapMiB: 0 }, argv: ['/usr/bin/true'], cwd: '/workspace', env: {} };
const running = { ...base, id: 'job-run', name: 'train', status: 'running', reserved: true, cursor: 3,
  createdAt: at(30), startedAt: at(25), finishedAt: null, reason: 'Running with verified cgroup limits' };
const queued = { ...base, id: 'job-wait', name: 'evaluate', status: 'queued', reserved: false, cursor: 2,
  createdAt: at(10), startedAt: null, finishedAt: null, reason: 'Waiting for shared machine capacity' };
// A failure of a minute ago: it used to make a group of its own.
const failed = { ...base, id: 'job-fail', name: 'prepare', status: 'failed', reserved: false, cursor: 1,
  createdAt: at(50), startedAt: at(49), finishedAt: at(1), reason: 'exit-code' };
const jobs = [running, queued, failed];

function mount() {
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async (url) => {
    let value;
    if (url === '/api/jobs/budget') value = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 1, queuedCount: 1, collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 }, machine: { name: 'WSL', memoryAvailableMiB: 2000 } };
    else if (url.startsWith('/api/ci')) value = { runs: [], subscriptions: [], hasMore: false, nextBefore: null };
    else if (url.endsWith('/logs')) value = { text: '', oldestOffset: 0, totalBytes: 0 };
    else if (url.startsWith('/api/jobs/job-')) value = jobs.find(j => url.endsWith(j.id));
    else value = { jobs, liveJobs: [running, queued], hasMore: false, nextBefore: null };
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  w.renderJobs({ workspaceId: 'w', agent, revision: '1', disabled: false });
  return { window: w, doc: w.document, errors, close: () => w.close() };
}
const row = (p, name) => [...p.doc.querySelectorAll('.job-row')].find(r => r.querySelector('strong')?.textContent === name);
const dockItem = (p, name) => [...p.doc.querySelectorAll('.conversation-job')].find(r => r.querySelector('strong')?.textContent === name);

test('a failure is finished like any other end: two groups only', async () => {
  const p = mount();
  try {
    await until(() => p.doc.querySelector('[aria-label="Jobs"]'));
    p.doc.querySelector('[aria-label="Jobs"]').click();
    await until(() => row(p, 'prepare'));
    const groups = [...p.doc.querySelectorAll('.job-group-title')].map(g => g.textContent);
    assert.deepEqual(groups, ['Running and queued2', 'Finished1']);
    assert.equal(p.doc.querySelector('.job-group-attention'), null);
    assert.ok(row(p, 'prepare').closest('.job-group-done'), 'the failure is with the finished jobs');
    assert.ok(row(p, 'train').closest('.job-group-active') && row(p, 'evaluate').closest('.job-group-active'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('each row says when it was queued and, once it has, when it finished', async () => {
  const p = mount();
  try {
    await until(() => p.doc.querySelector('[aria-label="Jobs"]'));
    p.doc.querySelector('[aria-label="Jobs"]').click();
    await until(() => row(p, 'prepare'));
    const moments = name => row(p, name).querySelector('.job-row-moments')?.textContent;
    assert.equal(moments('prepare'), `Queued ${clock(failed.createdAt)} · Finished ${clock(failed.finishedAt)}`);
    assert.equal(moments('train'), `Queued ${clock(running.createdAt)}`);
    assert.equal(moments('evaluate'), `Queued ${clock(queued.createdAt)}`);
  } finally { p.close(); }
});

test("the dock gives each job its latest moment: finished, started or queued", async () => {
  const p = mount();
  try {
    await until(() => dockItem(p, 'prepare') && dockItem(p, 'train') && dockItem(p, 'evaluate'));
    const when = name => [...dockItem(p, name).querySelectorAll('.work-dock-when')].map(e => e.textContent);
    // Beside the node (wide conversations) and in its tip (narrow ones).
    assert.deepEqual(when('prepare'), [`Finished ${clock(failed.finishedAt)}`, `Finished ${clock(failed.finishedAt)}`]);
    assert.deepEqual(when('train'), [`Started ${clock(running.startedAt)}`, `Started ${clock(running.startedAt)}`]);
    assert.deepEqual(when('evaluate'), [`Queued ${clock(queued.createdAt)}`, `Queued ${clock(queued.createdAt)}`]);
    assert.match(dockItem(p, 'train').getAttribute('aria-label'), /Started /);
  } finally { p.close(); }
});
