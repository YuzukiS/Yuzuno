// T-88: a Core whose host cannot run local Jobs (macOS, for one) refuses
// their budget. The Jobs panel still lists its Jobs, here one on a
// registered machine, and shows the refusal where the budget would be.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/jobs-host-refusal-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};window.renderJobs=p=>createRoot(document.getElementById('root')).render(<Jobs {...p}/>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'JobsHostRefusalUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 120; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const agent = { id: 'a', name: 'Mori', cwd: '/workspace', status: 'working' };
const resources = { cpuMillis: 500, memoryMiB: 128, swapMiB: 0 };
const remote = { id: 'job-r', cursor: 1, requestId: 'r', taskRef: 'T-88', agentId: 'a', agent: { name: 'Mori' }, name: 'eval on lab box',
  cwd: '/home/u/work', machine: { name: 'lab box' }, executor: { kind: 'ssh', machineId: 'm1' }, resources, reservation: resources,
  createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, argv: ['/bin/sh', '-c', 'make'], env: {}, reserved: false,
  status: 'queued', reason: 'Waiting for a slot', artifacts: [], result: null };
const page = { jobs: [remote], liveJobs: [remote], hasMore: false, nextBefore: null };
const refusal = 'Local Jobs need Linux with a systemd user manager, and this Core runs on macos: nothing was written, run or queued on this host. A Job for a registered remote machine (machineId) is not affected by this.';
const budget = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 0, queuedCount: 0,
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 }, machine: { name: 'WSL', memoryAvailableMiB: 2000,
    suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, logicalCpus: 32, memoryTotalMiB: 40107, swapTotalMiB: 16384, hostHeadroomMiB: 2048 } };

function mount({ refused }) {
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async url => {
    // As Core answers an error: 400 with {"error": ...}.
    if (url === '/api/jobs/budget' && refused) {
      const body = JSON.stringify({ error: refusal });
      return { ok: false, status: 400, json: async () => JSON.parse(body), text: async () => body };
    }
    const value = url === '/api/jobs/budget' ? budget : url.endsWith('/logs') ? { text: '', oldestOffset: 0, totalBytes: 0 }
      : url === '/api/jobs/job-r' ? remote : page;
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  w.renderJobs({ workspaceId: 'w', agent, revision: '1', disabled: false });
  return { doc: w.document, errors, close: () => w.close() };
}
async function open(p) { await until(() => p.doc.querySelector('[aria-label="Jobs"]')); p.doc.querySelector('[aria-label="Jobs"]').click(); await until(() => p.doc.querySelector('[role="dialog"]')); }
const row = (p, name) => [...p.doc.querySelectorAll('.job-row')].find(r => r.textContent.includes(name));
const note = p => [...p.doc.querySelectorAll('[role="status"]')].find(n => n.textContent === refusal);

test("a refused budget leaves the list: the Job on a registered machine shows, and so does why", async () => {
  const p = mount({ refused: true });
  try {
    await open(p);
    await until(() => row(p, 'eval on lab box') && note(p));
    assert.equal(note(p).className, 'job-footnote');
    assert.equal(p.doc.querySelector('.jobs-budget'), null, 'no budget meters without a budget');
    assert.equal(p.doc.querySelectorAll('[role="alert"]').length, 0, 'not an error of the panel');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("with a budget, it shows and no refusal does", async () => {
  const p = mount({ refused: false });
  try {
    await open(p);
    await until(() => row(p, 'eval on lab box') && p.doc.querySelector('.jobs-budget'));
    assert.equal(note(p), undefined);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
