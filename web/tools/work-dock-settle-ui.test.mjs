// A node on the conversation's dock whose run ends while it shows settles
// once (T-19 CV:WD-05): its fill fades in, and a run that succeeded springs
// too. A poll reading the same status again, a node that first shows ended,
// what is not an end (queued, running, cancelling) and an unknown status play
// nothing; a run read as unknown is judged against what it was before.
// `animate` is recorded by the id each animation carries.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/work-dock-settle-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {ConversationJobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};const r=createRoot(document.getElementById('root'));window.renderDock=(revision)=>flushSync(()=>r.render(<ConversationJobs agentId="a" revision={String(revision)} disabled={false}/>));`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'WorkDockSettleUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = (ms = 25) => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let n = 0; n < 120; n++) { if (fn()) return; await wait(); } assert.fail(`Expected state did not appear: ${what}`); }
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const base = { requestId: 'r', taskRef: 'T-1', agentId: 'a', agent: { name: 'Mori' }, machine: { name: 'WSL' },
  resources: { cpuMillis: 500, memoryMiB: 96, swapMiB: 0 }, reservation: { cpuMillis: 600, memoryMiB: 160, swapMiB: 0 },
  argv: ['/usr/bin/true'], cwd: '/workspace', env: {}, reserved: false, reason: '', cursor: 1 };
const job = (id, name, status) => ({ ...base, id, name, status, createdAt: at(30), startedAt: at(25),
  finishedAt: ['running', 'queued', 'cancelling'].includes(status) ? null : at(1) });

function mount({ reduced = false } = {}) {
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  const page = { w, doc: w.document, errors, jobs: [], played: [], revision: 0 };
  w.fetch = async (url) => {
    const value = url.startsWith('/api/ci') ? { runs: [], subscriptions: [], hasMore: false, nextBefore: null }
      : url.startsWith('/api/reviews') ? { reviews: [], hasMore: false, nextBefore: null }
      : { jobs: page.jobs, liveJobs: [], hasMore: false, nextBefore: null };
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.matchMedia = (media) => ({ media, matches: reduced && /reduce/.test(media), addEventListener() {}, removeEventListener() {} });
  // On Element, where motion.ts looks for the Web Animations API.
  w.Element.prototype.animate = function (keyframes, options) {
    if (/^dock-settle-/.test(options?.id ?? '')) {
      const name = this.closest('.conversation-job')?.querySelector('strong')?.textContent ?? '?';
      page.played.push({ id: options.id, name, keyframes, duration: options.duration });
    }
    return { addEventListener() {}, cancel() {}, finished: Promise.resolve() };
  };
  w.eval(bundle);
  /** Core answers with `jobs` now: the dock reads them again, as on a jobs event. */
  page.read = async (jobs) => {
    page.jobs = jobs;
    const names = jobs.map((j) => `${j.name}:${j.status}`).sort().join(',');
    w.renderDock(++page.revision);
    await until(() => [...page.doc.querySelectorAll('.conversation-job')]
      .map((el) => `${el.querySelector('strong')?.textContent}:${[...el.classList].find((c) => c.startsWith('state-'))?.slice(6)}`)
      .sort().join(',') === names, `the dock showing ${names}`);
    await wait();
  };
  page.take = () => page.played.splice(0).map(({ id, name }) => `${name}:${id}`).sort();
  page.close = () => w.close();
  return page;
}

test('a node settles once as its run ends: a success fills and springs, a failure fills, a cancel fades in; the same status read again plays nothing (T-19 CV:WD-05)', async () => {
  const p = mount();
  try {
    await p.read([job('j1', 'train', 'running'), job('j2', 'lint', 'running'), job('j3', 'eval', 'running')]);
    assert.deepEqual(p.take(), [], 'what the dock first shows does not move');
    await p.read([job('j1', 'train', 'succeeded'), job('j2', 'lint', 'failed'), job('j3', 'eval', 'cancelled')]);
    const played = [...p.played];
    assert.deepEqual(p.take(), ['eval:dock-settle-fill', 'lint:dock-settle-fill', 'train:dock-settle-fill', 'train:dock-settle-spring'],
      'each ended run settles once; only the success springs');
    const spring = played.find((a) => a.id === 'dock-settle-spring');
    assert.deepEqual(Array.from(spring.keyframes, (k) => k.scale), ['0.96', '1.02', '1'], 'from .96, overshooting to 1.02 at most');
    assert.equal(spring.duration, 120);
    const fills = played.filter((a) => a.id === 'dock-settle-fill');
    assert.equal(fills.every((a) => a.duration === 180), true, 'the fills over small');
    assert.equal('backgroundColor' in played.find((a) => a.name === 'train' && a.id === 'dock-settle-fill').keyframes[0], true, 'a filled node fades its fill in');
    assert.equal('opacity' in played.find((a) => a.name === 'eval').keyframes[0], true, 'a ring fades in');
    await p.read([job('j1', 'train', 'succeeded'), job('j2', 'lint', 'failed'), job('j3', 'eval', 'cancelled')]);
    assert.deepEqual(p.take(), [], 'a poll that reads the same ends plays nothing');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a node first shown ended, a run that starts or is being cancelled, and an unknown status play nothing; a run read as unknown is judged against what it was before (T-19 CV:WD-05)', async () => {
  const p = mount();
  try {
    await p.read([job('j1', 'train', 'queued'), job('j2', 'lint', 'running'), job('j3', 'done', 'succeeded')]);
    await p.read([job('j1', 'train', 'running'), job('j2', 'lint', 'cancelling'), job('j3', 'done', 'succeeded')]);
    assert.deepEqual(p.take(), [], 'queued → running, running → cancelling and a node first shown ended play nothing');
    await p.read([job('j1', 'train', 'unknown'), job('j2', 'lint', 'cancelling'), job('j3', 'done', 'unknown')]);
    assert.deepEqual(p.take(), [], 'an unknown status never looks settled');
    await p.read([job('j1', 'train', 'succeeded'), job('j2', 'lint', 'cancelled'), job('j3', 'done', 'succeeded')]);
    assert.deepEqual(p.take(), ['lint:dock-settle-fill', 'train:dock-settle-fill', 'train:dock-settle-spring'],
      'a run that was going before it was unknown settles once it is read ended; one already ended does not settle again');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('under reduced motion a run that ends plays nothing (T-19 CV:WD-05)', async () => {
  const p = mount({ reduced: true });
  try {
    await p.read([job('j1', 'train', 'running')]);
    await p.read([job('j1', 'train', 'succeeded')]);
    assert.deepEqual(p.take(), [], 'nothing plays');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
