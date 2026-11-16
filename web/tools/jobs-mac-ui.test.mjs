// YN-108 M2c: on a macOS Core this host's Jobs run on This Mac in the limited
// mode (as on a Mac over SSH, YN-104). The new-Job form says so beside what
// runs and sends guardGit false, which Core refuses there; Settings → Jobs
// says its budget only queues and records them. A Linux Core's view (no
// `mac`) shows neither. Against fixture answers in this file only: no Core.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/jobs-mac-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  const src = (file) => JSON.stringify(path.join(root, 'src', file));
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs, targetNote} from ${src('Jobs.tsx')};import {JobsBudgetEditor} from ${src('JobsSettings.tsx')};
const root = createRoot(document.getElementById('root'));
window.targetNote = targetNote;
window.renderJobs = p => root.render(<Jobs {...p}/>);
window.renderHost = () => root.render(<JobsBudgetEditor active/>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'JobsMacUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn, what) { for (let n = 0; n < 160; n++) { if (fn()) return; await wait(); } assert.fail(`timed out waiting until ${what}`); }
const agent = { id: 'a', name: 'Mori', cwd: '/Users/sample/work', status: 'working' };
const resources = { cpuMillis: 500, memoryMiB: 128, swapMiB: 0 };
const page = { jobs: [], liveJobs: [], hasMore: false, nextBefore: null };
const budget = (mac) => ({ budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 0, queuedCount: 0,
  maxActive: 4, maxActiveSet: false, maxActiveDefault: 4, maxActiveBounds: { minimum: 1, maximum: 64 },
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 },
  budgetBounds: { minimum: { cpuMillis: 200, memoryMiB: 128, swapMiB: 0 }, maximum: { cpuMillis: 4096000, memoryMiB: 67108864, swapMiB: 67108864 } },
  machine: { name: 'sample-mac', memoryAvailableMiB: null, logicalCpus: 10, memoryTotalMiB: 16384, swapTotalMiB: null, hostHeadroomMiB: 1024,
    suggestedBudget: { cpuMillis: 4000, memoryMiB: 4096, swapMiB: 0 }, scope: 'Only Jobs managed by this Core share this budget.' },
  windows: { available: false, maxJobs: 2, set: false, defaultMaxJobs: 2, activeCount: 0 },
  ...(mac ? { mac: { available: true, limits: 'declared' } } : {}) });

function mount(mac) {
  const vc = new VirtualConsole(), errors = [], calls = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const value = url === '/api/jobs/budget' && !body ? budget(mac)
      : url === '/api/jobs' && body ? { ...body, id: 'job-m', cursor: 1, status: 'queued', reserved: false, agent: { name: 'Mori' }, machine: { name: 'This Mac' },
        executor: { kind: 'mac', machineId: 'mac', machineName: 'This Mac' }, resources, reservation: resources, createdAt: new Date().toISOString(),
        startedAt: null, finishedAt: null, argv: body.argv, env: {}, artifacts: [], result: null, reason: 'Waiting for a slot on This Mac' }
      : url.startsWith('/api/jobs/') ? { text: '', oldestOffset: 0, totalBytes: 0 } : page;
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  return { window: w, doc: w.document, calls, errors, close: () => w.close() };
}
const button = (p, text) => [...p.doc.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const field = (p, text) => [...p.doc.querySelectorAll('label')].find(l => l.textContent.startsWith(text))?.querySelector('input,textarea');
async function fill(p, text, value) { const el = field(p, text); assert.ok(el, `Missing ${text} field`); Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? p.window.HTMLTextAreaElement.prototype : p.window.HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new p.window.Event('input', { bubbles: true })); await wait(); }
async function openForm(p) {
  p.window.renderJobs({ workspaceId: 'w', agent, revision: '1', disabled: false });
  await until(() => p.doc.querySelector('[aria-label="Jobs"]'), 'the Jobs button shows');
  p.doc.querySelector('[aria-label="Jobs"]').click();
  await until(() => p.doc.querySelector('.jobs-budget'), 'the budget is read');
  button(p, 'New job').click();
  await until(() => p.doc.querySelector('.job-form'), 'the form opens');
}
const macNote = 'This Mac · macOS · limits declared only: CPU and RAM queue and record the job; nothing holds them while it runs.';
const budgetNote = 'Used only to queue and record Jobs: macOS can’t enforce CPU or RAM, so nothing is held while a Job runs. Each job still declares its own CPU and RAM.';

test('on a macOS Core the new-Job form says the job runs on This Mac with its limits declared only, and sends guardGit false', async () => {
  const p = mount(true);
  try {
    await openForm(p);
    assert.equal(p.doc.querySelector('.job-mac-host')?.textContent, macNote);
    const guard = field(p, 'Check Git HEAD');
    assert.equal(guard.disabled, true);
    assert.equal(guard.checked, false);
    assert.ok([...p.doc.querySelectorAll('.job-footnote')].some(n => n.textContent === 'Not available on macOS: list the files to freeze as inputs.'));
    await fill(p, 'Name', 'mac job'); await fill(p, 'Existing task', 'T-1'); await fill(p, 'Command', 'echo ok');
    button(p, 'Submit job').click();
    await until(() => p.calls.some(c => c.url === '/api/jobs' && c.body), 'the job is submitted');
    const sent = p.calls.find(c => c.url === '/api/jobs' && c.body).body;
    assert.equal(sent.guardGit, false);
    assert.equal('machineId' in sent, false, 'no machine named: Core resolves this host to This Mac');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('on a Linux Core the form is as before: no Mac note, guardGit on and sent as set', async () => {
  const p = mount(false);
  try {
    await openForm(p);
    assert.equal(p.doc.querySelector('.job-mac-host'), null);
    const guard = field(p, 'Check Git HEAD');
    assert.equal(guard.checked, true);
    assert.equal(guard.disabled, false);
    await fill(p, 'Name', 'linux job'); await fill(p, 'Existing task', 'T-1'); await fill(p, 'Command', 'echo ok');
    button(p, 'Submit job').click();
    await until(() => p.calls.some(c => c.url === '/api/jobs' && c.body), 'the job is submitted');
    assert.equal(p.calls.find(c => c.url === '/api/jobs' && c.body).body.guardGit, true);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Settings → Jobs says a macOS Core’s budget only queues and records its Jobs, and a Linux Core’s says nothing of it', async () => {
  for (const mac of [true, false]) {
    const p = mount(mac);
    try {
      p.window.renderHost();
      await until(() => p.doc.querySelector('.jobs-settings-budget'), 'the budget editor shows');
      assert.equal(p.doc.querySelector('.jobs-settings-mac')?.textContent ?? null, mac ? budgetNote : null, `mac: ${mac}`);
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
});

test('a job on This Mac is marked as on the Core host, as a local one is', () => {
  const p = mount(true);
  try {
    const note = p.window.targetNote;
    assert.equal(note({ target: { requested: null, kind: 'mac', machineId: 'mac', machineName: 'This Mac' }, executor: { kind: 'mac' } }), 'Core host');
    assert.equal(note({ target: { requested: 'agent', kind: 'mac', machineId: 'mac', machineName: 'This Mac' }, executor: { kind: 'mac' } }), 'Core host, where the submitting Agent runs');
    assert.equal(note({ target: { requested: null, kind: 'ssh', machineId: 'm1', machineName: 'lab box' }, executor: { kind: 'ssh' } }), '');
  } finally { p.close(); }
});
