// T-162: a Job's detail says where it runs: the Core host, or the machine
// the submitting Agent runs on when the submission named machineId agent and
// Core resolved it, kept as the Job's target. Older Jobs have no target.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/job-target-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};window.renderJobs=p=>createRoot(document.getElementById('root')).render(<Jobs {...p}/>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'JobTargetUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 120; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const agent = { id: 'a', name: 'Mori', cwd: '/workspace', status: 'working' };
const resources = { cpuMillis: 500, memoryMiB: 128, swapMiB: 0 };
const base = { requestId: 'r', taskRef: 'T-162', agentId: 'a', agent: { name: 'Mori' }, resources, reservation: resources,
  createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, argv: ['/bin/true'], env: {}, reserved: false,
  status: 'queued', reason: 'Waiting', result: null, cwd: '/work' };
const jobs = [
  // Before T-162: no target; a Job without an executor ran on this host.
  { ...base, id: 'j-old', cursor: 1, name: 'older here', machine: { name: 'WSL' } },
  { ...base, id: 'j-agent-here', cursor: 2, name: 'agent here', machine: { name: 'WSL' },
    target: { requested: 'agent', kind: 'local', machineId: 'local', machineName: 'WSL' } },
  { ...base, id: 'j-agent-there', cursor: 3, name: 'agent there', machine: { name: 'lab box' },
    executor: { kind: 'ssh', machineId: 'm1', machineName: 'lab box' },
    target: { requested: 'agent', kind: 'ssh', machineId: 'm1', machineName: 'lab box' } },
  { ...base, id: 'j-named', cursor: 4, name: 'named there', machine: { name: 'lab box' },
    executor: { kind: 'ssh', machineId: 'm1', machineName: 'lab box' },
    target: { requested: 'm1', kind: 'ssh', machineId: 'm1', machineName: 'lab box' } },
];
const byId = Object.fromEntries(jobs.map(j => [j.id, j]));
const page = { jobs: [...jobs].reverse(), liveJobs: jobs, hasMore: false, nextBefore: null };

function mount() {
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async url => {
    let value;
    if (url === '/api/jobs/budget') value = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 0, queuedCount: 0, collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 }, machine: { name: 'WSL', memoryAvailableMiB: 2000, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, logicalCpus: 32, memoryTotalMiB: 40107, swapTotalMiB: 16384, hostHeadroomMiB: 2048 } };
    else if (url.endsWith('/logs')) value = { text: '', oldestOffset: 0, totalBytes: 0 };
    else value = byId[url.replace('/api/jobs/', '')] ?? page;
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  w.renderJobs({ workspaceId: 'w', agent, revision: '1', disabled: false });
  return { doc: w.document, errors, close: () => w.close() };
}
async function open(p) { await until(() => p.doc.querySelector('[aria-label="Jobs"]')); p.doc.querySelector('[aria-label="Jobs"]').click(); await until(() => p.doc.querySelector('[role="dialog"]')); }
const row = (p, name) => [...p.doc.querySelectorAll('.job-row')].find(r => r.textContent.includes(name));
const machineRow = p => [...p.doc.querySelectorAll('dt')].find(dt => dt.textContent === 'Machine')?.nextElementSibling?.textContent;
// The selected Job's Machine row, once its detail shows that Job.
async function machineOf(p, name, machine) {
  await until(() => row(p, name));
  row(p, name).click();
  await until(() => p.doc.querySelector('.job-detail-title h3')?.textContent === name && machineRow(p)?.startsWith(machine));
  return machineRow(p);
}

test('the Machine row says it is the Core host, or the machine Core resolved for the submitting Agent', async () => {
  const p = mount();
  try {
    await open(p);
    assert.equal(await machineOf(p, 'older here', 'WSL'), 'WSL · Core host');
    assert.equal(await machineOf(p, 'agent here', 'WSL'), 'WSL · Core host, where the submitting Agent runs');
    assert.equal(await machineOf(p, 'agent there', 'lab box'), 'lab box · the machine the submitting Agent runs on');
    assert.equal(await machineOf(p, 'named there', 'lab box'), 'lab box', 'a machine named by its id needs no note');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
