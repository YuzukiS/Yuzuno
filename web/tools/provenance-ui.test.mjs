// T-168: a Job's provenance is previewed before it is saved, what is saved is
// exactly what was previewed, a stage attempt can export its whole run, and a
// failed export says why and can be asked again.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/provenance-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};window.renderJobs=p=>createRoot(document.getElementById('root')).render(<Jobs {...p}/>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'ProvenanceUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 120; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const agent = { id: 'a', name: 'Mori', cwd: '/workspace', status: 'working' };
const resources = { cpuMillis: 500, memoryMiB: 128, swapMiB: 0 };
const base = { requestId: 'r', taskRef: 'T-168', agentId: 'a', agent: { name: 'Mori' }, resources, reservation: resources,
  createdAt: new Date().toISOString(), startedAt: null, finishedAt: new Date().toISOString(), argv: ['/bin/true'], env: {}, reserved: false,
  status: 'succeeded', reason: 'Exit 0', result: null, cwd: '/work', machine: { name: 'WSL' } };
const jobs = [
  { ...base, id: 'job-alone-0001', cursor: 1, name: 'alone' },
  { ...base, id: 'job-stage-0002', cursor: 2, name: 'stage', run: { id: 'run-0003', stage: 'train', attempt: 2 } },
];
const byId = Object.fromEntries(jobs.map(j => [j.id, j]));
const page = { jobs: [...jobs].reverse(), liveJobs: [], hasMore: false, nextBefore: null };
const run = { id: 'run-0003', name: 'Fixture run', status: 'succeeded', stages: [{ key: 'train', status: 'succeeded', needs: [], attempts: [] }], cost: null };
const attempt = (machineName, files, withheld) => ({ target: { kind: 'local', machineName }, artifacts: { files }, inputs: { withheld } });
const exports = {
  '/api/jobs/job-alone-0001/provenance': { manifest: { schema: 'yuzuno.provenance', version: 1, scope: { kind: 'job', id: 'job-alone-0001', attempts: 1 },
    attempts: [attempt('WSL', [{ path: 'out.json' }], 1)], omitted: ['output and logs'] }, report: '# Provenance of job alone\n\n- Ran on this Core\'s host WSL\n' },
  '/api/jobs/runs/run-0003/provenance': { manifest: { schema: 'yuzuno.provenance', version: 1, scope: { kind: 'run', id: 'run-0003', attempts: 2 },
    attempts: [attempt('WSL', [], 0), attempt('WSL', [{ path: 'model.json' }], 0)], omitted: [] }, report: '# Provenance of run Fixture run\n' },
};

function mount() {
  const vc = new VirtualConsole(), errors = [], requests = [], saved = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  let failNext = false;
  w.fetch = async url => {
    requests.push(url);
    if (url.endsWith('/provenance') && failNext) {
      failNext = false;
      const body = JSON.stringify({ error: 'Job not found' });
      return { ok: false, status: 404, json: async () => JSON.parse(body), text: async () => body };
    }
    let value;
    if (url === '/api/jobs/budget') value = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 0, queuedCount: 0, collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 }, machine: { name: 'WSL', memoryAvailableMiB: 2000, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, logicalCpus: 32, memoryTotalMiB: 40107, swapTotalMiB: 16384, hostHeadroomMiB: 2048 } };
    else if (url.endsWith('/logs')) value = { text: '', oldestOffset: 0, totalBytes: 0 };
    else if (exports[url]) value = exports[url];
    else if (url === '/api/jobs/runs/run-0003') value = run;
    else value = byId[url.replace('/api/jobs/', '')] ?? page;
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  // Saving hands a Blob to a link; keep what each link would save.
  const blobs = new Map();
  w.URL.createObjectURL = blob => { const url = `blob:${blobs.size}`; blobs.set(url, blob); return url; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { saved.push({ name: this.download, blob: blobs.get(this.href) }); };
  w.eval(bundle);
  w.renderJobs({ workspaceId: 'w', agent, revision: '1', disabled: false });
  return { w, doc: w.document, errors, requests, saved, fail: () => { failNext = true; }, close: () => w.close() };
}
async function open(p) { await until(() => p.doc.querySelector('[aria-label="Jobs"]')); p.doc.querySelector('[aria-label="Jobs"]').click(); await until(() => p.doc.querySelector('[role="dialog"]')); }
const row = (p, name) => [...p.doc.querySelectorAll('.job-row')].find(r => r.textContent.includes(name));
const button = (p, text) => [...p.doc.querySelectorAll('.job-provenance button')].find(b => b.textContent.trim() === text);
async function select(p, name) {
  await until(() => row(p, name));
  row(p, name).click();
  await until(() => p.doc.querySelector('.job-detail-title h3')?.textContent === name && p.doc.querySelector('.job-provenance'));
}
const read = (p, blob) => new Promise((resolve, reject) => { const r = new p.w.FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsText(blob); });

test('an export is previewed first and saves exactly what was shown', async () => {
  const p = mount();
  try {
    await open(p);
    await select(p, 'alone');
    assert.equal(button(p, 'Preview whole run'), undefined, 'a Job outside a run has no run to export');
    assert.ok(!p.requests.some(u => u.endsWith('/provenance')), 'nothing is exported before it is asked for');
    button(p, 'Preview export').click();
    await until(() => p.doc.querySelector('.job-provenance-report'));
    assert.equal(p.doc.querySelector('.job-provenance-scope').textContent, '1 attempt · on WSL · 1 artifact reference · 1 input path withheld');
    assert.equal(p.doc.querySelector('.job-provenance-report').textContent, exports['/api/jobs/job-alone-0001/provenance'].report);
    assert.equal(p.saved.length, 0, 'a preview saves nothing');
    button(p, 'Save JSON').click();
    button(p, 'Save report').click();
    assert.deepEqual(p.saved.map(s => s.name), ['provenance-job-job-alon.json', 'provenance-job-job-alon.md']);
    assert.deepEqual(JSON.parse(await read(p, p.saved[0].blob)), exports['/api/jobs/job-alone-0001/provenance'].manifest);
    assert.equal(await read(p, p.saved[1].blob), exports['/api/jobs/job-alone-0001/provenance'].report);
    button(p, 'Close').click();
    await until(() => !p.doc.querySelector('.job-provenance-report'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a stage attempt can export its whole run, and a failed export can be asked again', async () => {
  const p = mount();
  try {
    await open(p);
    await select(p, 'stage');
    p.fail();
    button(p, 'Preview whole run').click();
    await until(() => p.doc.querySelector('.job-provenance [role="alert"]'));
    assert.equal(p.doc.querySelector('.job-provenance [role="alert"]').textContent, 'Job not found');
    assert.equal(p.doc.querySelector('.job-provenance-report'), null, 'nothing is shown in place of a failed export');
    button(p, 'Preview whole run').click();
    await until(() => p.doc.querySelector('.job-provenance-report'));
    assert.equal(p.doc.querySelector('[role="alert"]'), null);
    assert.equal(p.doc.querySelector('.job-provenance-scope').textContent, '2 attempts · on WSL · 1 artifact reference');
    assert.equal(p.requests.filter(u => u === '/api/jobs/runs/run-0003/provenance').length, 2);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
