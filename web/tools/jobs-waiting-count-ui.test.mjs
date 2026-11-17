// T-69: the Jobs badge counts running / queued / waiting, the last being the
// Jobs that wait for an earlier stage of their run (budget waitingCount),
// in neither of the other two. So do the panel's budget line and its "This
// machine" tab. A Core that sends no waitingCount keeps the two numbers.
import './jsdom-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readTip, tipOf } from "./tip-dom.mjs";
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'node_modules/.cache'), { recursive: true });
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/jobs-waiting-count-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};window.renderJobs=p=>createRoot(document.getElementById('root')).render(<Jobs {...p}/>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'JobsWaitingCountUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 120; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const agent = { id: 'a', name: 'Mori', cwd: '/workspace', status: 'working' };
const resources = { cpuMillis: 500, memoryMiB: 128, swapMiB: 0 };
const page = { jobs: [], liveJobs: [], hasMore: false, nextBefore: null };
const budget = (counts) => ({ budget: { cpuMillis: 4000, memoryMiB: 4096, swapMiB: 0 }, reserved: resources, ...counts, maxActive: 4, maxActiveSet: false,
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 }, machine: { name: 'WSL', memoryAvailableMiB: 2000,
    suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, logicalCpus: 32, memoryTotalMiB: 40107, swapTotalMiB: 16384, hostHeadroomMiB: 2048 } });

function mount(counts, language) {
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  if (language) w.localStorage.setItem('yuzuno.language', JSON.stringify({ language }));
  w.fetch = async url => {
    const value = url === '/api/jobs/budget' ? budget(counts) : page;
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  w.renderJobs({ workspaceId: 'w', agent, revision: '1', disabled: false });
  return { w, doc: w.document, errors, close: () => w.close() };
}
const badge = p => p.doc.querySelector('.jobs-nav .nav-count');
async function open(p) {
  await until(() => badge(p));
  p.doc.querySelector('.jobs-nav').click();
  await until(() => p.doc.querySelector('.jobs-budget-counts'));
}

test('the badge counts running, queued and waiting for an earlier stage, and says so', async () => {
  const p = mount({ activeCount: 2, queuedCount: 0, waitingCount: 1 });
  try {
    await until(() => badge(p));
    assert.equal(badge(p).textContent, '2 / 0 / 1');
    assert.equal(badge(p).getAttribute('aria-label'), '2 active jobs, 0 queued jobs, 1 jobs waiting for an earlier stage');
    // The entry's one tip says the three in words (YN-44): no title of the badge's own.
    assert.equal(badge(p).hasAttribute('title'), false);
    assert.equal((await readTip(p.w, p.doc.querySelector('.jobs-nav')))[1], '2 active · 0 queued · 1 waiting for an earlier stage of their run');
    await open(p);
    assert.equal(p.doc.querySelector('.jobs-budget-counts').textContent, '2 of 4 active · 0 queued · 1 waiting');
    const tab = p.doc.querySelector('.jobs-rail-count');
    assert.equal(tab.textContent, '3', 'the local tab counts all three');
    // One tip for the whole tab (YN-44), its count in words.
    assert.deepEqual(await tipOf(tab.closest('button')), ['2 active · 0 queued · 1 waiting for an earlier stage on this machine']);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a 0 is shown as the third number too', async () => {
  const p = mount({ activeCount: 1, queuedCount: 1, waitingCount: 0 });
  try {
    await until(() => badge(p));
    assert.equal(badge(p).textContent, '1 / 1 / 0');
  } finally { p.close(); }
});

test('in Simplified Chinese the three are named in it', async () => {
  const p = mount({ activeCount: 2, queuedCount: 0, waitingCount: 1 }, 'zh-Hans');
  try {
    await until(() => badge(p));
    assert.equal(badge(p).textContent, '2 / 0 / 1');
    assert.equal(badge(p).getAttribute('aria-label'), '2 个活跃 Job，0 个排队 Job，1 个等待上游阶段的 Job');
    assert.equal((await readTip(p.w, p.doc.querySelector('.jobs-nav')))[1], '2 个活跃 · 0 个排队 · 1 个等待所在运行的上游阶段');
    await open(p);
    assert.equal(p.doc.querySelector('.jobs-budget-counts').textContent, '2 / 4 个活跃 · 0 个排队 · 1 个等待上游');
    assert.deepEqual(await tipOf(p.doc.querySelector('.jobs-rail-count').closest('button')), ['此机器上 2 个活跃 · 0 个排队 · 1 个等待上游阶段']);
  } finally { p.close(); }
});

test('a Core that sends no waitingCount keeps its two numbers', async () => {
  const p = mount({ activeCount: 2, queuedCount: 0 });
  try {
    await until(() => badge(p));
    assert.equal(badge(p).textContent, '2 / 0');
    assert.equal(badge(p).getAttribute('aria-label'), '2 active jobs, 0 queued jobs');
    await open(p);
    assert.equal(p.doc.querySelector('.jobs-budget-counts').textContent, '2 of 4 active · 0 queued');
  } finally { p.close(); }
});

// YN-194: the budget card names the first Job in the queue, what it waits for
// and how much it lacks, and the running Jobs that hold most of that.
const queueHead = {
  jobId: 'big', name: 'train-24g', taskRef: 'TT-3', waitingSince: new Date(Date.now() - 72 * 60 * 1000).toISOString(), waits: 'memory',
  reason: 'Waiting for shared RAM reservation: needs 24640 MiB including collector, 18496 MiB available; short 6144 MiB',
  need: { cpuMillis: 6100, memoryMiB: 24640, swapMiB: 0 }, free: { cpuMillis: 23700, memoryMiB: 18496, swapMiB: 0 },
  short: { cpuMillis: 0, memoryMiB: 6144, swapMiB: 0 },
  holders: [
    { jobId: 'h1', name: 'eval-big', reservation: { cpuMillis: 4100, memoryMiB: 18496, swapMiB: 0 }, startedAt: '2026-11-16T13:20:00Z',
      endsBy: '2026-11-16T14:20:00Z', typicalSeconds: 2400 },
    { jobId: 'h2', name: 'prep-shards', reservation: { cpuMillis: 2100, memoryMiB: 8192, swapMiB: 0 }, startedAt: null, endsBy: null, typicalSeconds: null },
  ],
};

test('the budget names the queue head, what it lacks and who holds it, in English and Chinese', async () => {
  for (const [language, line, holders] of [
    [undefined, /^Head of the queue: train-24g waits for memory, 6.0 GiB short · waiting 1h 1[12]m$/,
      /^Holding most of it: eval-big 18.1 GiB · usually about 40m · timeout at .+; prep-shards 8.0 GiB$/],
    ['zh-Hans', /^队首：train-24g 等内存，还差 6.0 GiB · 已等 1h 1[12]m$/, /^占用最多：eval-big 18.1 GiB · 通常约 40m · 最晚 .+ 超时；prep-shards 8.0 GiB$/],
  ]) {
    const p = mount({ activeCount: 2, queuedCount: 12, waitingCount: 0, queueHead }, language);
    try {
      await open(p);
      await until(() => p.doc.querySelector('.jobs-queue-head'));
      assert.match(p.doc.querySelector('.jobs-queue-head-line').textContent.replace(/\s+/g, ' ').trim(), line);
      assert.match(p.doc.querySelector('.jobs-queue-head-holders').textContent.replace(/\s+/g, ' ').trim(), holders);
      assert.deepEqual(await tipOf(p.doc.querySelector('.jobs-queue-head-line')), [queueHead.reason], "admission's reason as it came");
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
});

test('nothing queued, or a Core that sends no queueHead, shows no line', async () => {
  for (const counts of [{ activeCount: 1, queuedCount: 0, queueHead: null }, { activeCount: 1, queuedCount: 0 }]) {
    const p = mount(counts);
    try {
      await open(p);
      assert.equal(p.doc.querySelector('.jobs-queue-head'), null);
    } finally { p.close(); }
  }
});
