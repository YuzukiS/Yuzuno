// T-107: a running job can be paused and resumed from its details. A paused
// job says so in its row and details, says its memory and GPU memory stay
// reserved and that its timeout still counts, and is resumed only by the
// user's button. A pause that has not taken hold says it is pausing; a
// finished job never offers pause or resume.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/job-pause-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};window.renderJobs=p=>createRoot(document.getElementById('root')).render(<Jobs {...p}/>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'JobPauseUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 120; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const agent = { id: 'a', name: 'Mori', cwd: '/workspace', status: 'working' };
const resources = { cpuMillis: 500, memoryMiB: 96, swapMiB: 0 };
const started = new Date(Date.now() - 60_000).toISOString();
const base = { id: 'job-1', name: 'Train small model', requestId: 'r', taskRef: 'T-107', agentId: 'a', agent: { name: 'Mori' }, machine: { name: 'WSL' }, resources,
  reservation: { cpuMillis: 600, memoryMiB: 160, swapMiB: 0 }, createdAt: started, startedAt: started, finishedAt: null, argv: ['/usr/bin/python3', 'train.py'],
  cwd: '/workspace', env: {}, cursor: 1, reserved: true, status: 'running', reason: 'Running with verified cgroup limits', timeoutSeconds: 3600 };
const paused = { ...base, pause: { intent: 'pause', state: 'paused', requestedAt: started, confirmedAt: started,
  reason: 'Paused: every process in the job is frozen; memory and GPU memory are kept' } };
const page = jobs => ({ jobs, liveJobs: [], hasMore: false, nextBefore: null });

function mount(state, gpus) {
  const vc = new VirtualConsole(), errors = [], calls = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    let value;
    if (url === '/api/jobs/budget') value = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 1, queuedCount: 0, collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 }, machine: { name: 'WSL', memoryAvailableMiB: 2000, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, logicalCpus: 32, memoryTotalMiB: 40107, swapTotalMiB: 16384, hostHeadroomMiB: 2048 }, ...(gpus ? { gpus: gpus() } : {}) };
    else if (/^\/api\/jobs\/gpus\/[^/]+\/(pause|resume)$/.test(url)) value = { device: {}, jobs: url.endsWith('/pause')
      ? [{ id: 'job-9', name: 'Eval', error: 'Only a running job can be paused; this one is succeeded' }, { id: 'job-1', name: 'Train small model', status: 'running', pause: { state: 'paused' } }]
      : [] };
    else if (url.endsWith('/logs')) value = { text: '', oldestOffset: 0, totalBytes: 0 };
    else if (url === '/api/jobs/job-1/pause') { state.job = { ...base, pause: { intent: 'pause', state: 'requested', requestedAt: started, reason: 'Freeze requested, but not every process had stopped after 10 s (one may be inside a driver or kernel call)' } }; value = state.job; }
    else if (url === '/api/jobs/job-1/resume') { if (state.hold) await state.hold; state.job = { ...base }; value = state.job; }
    else if (url === '/api/jobs/job-1') value = state.job;
    else value = page([state.job]);
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  w.renderJobs({ workspaceId: 'w', agent, revision: '1', disabled: false });
  return { window: w, doc: w.document, calls, errors, close: () => w.close() };
}
const button = (p, text) => [...p.doc.querySelectorAll('.job-detail button')].find(b => b.textContent.trim() === text);
async function open(p) { await until(() => p.doc.querySelector('[aria-label="Jobs"]')); p.doc.querySelector('[aria-label="Jobs"]').click(); await until(() => p.doc.querySelector('[role="dialog"]')); }
const row = p => p.doc.querySelector('.job-row');
async function select(p) { await open(p); await until(() => row(p)); row(p).click(); await until(() => p.doc.querySelector('.job-detail-heading h3')); }
const posts = p => p.calls.filter(c => c.method === 'POST').map(c => c.url);

test('a paused job says it is paused, what it keeps, when its timeout stops it, and resumes only on the button', async () => {
  const state = { job: paused };
  const p = mount(state);
  try {
    await select(p);
    assert.match(row(p).textContent, /Paused/);
    assert.match(row(p).textContent, /memory and GPU memory are kept/);
    assert.ok(row(p).querySelector('.status-mark.state-paused'), 'a paused mark, not a running one');
    const heading = p.doc.querySelector('.job-detail-heading').textContent;
    assert.match(heading, /^.*Paused · 1m/);
    const note = p.doc.querySelector('.job-pause-note').textContent;
    assert.match(note, /Memory and GPU memory stay reserved; only you can resume it\./);
    const ends = new Date(Date.parse(started) + 3600_000).toLocaleString();
    assert.ok(note.includes(`The timeout still counts: it stops at ${ends}.`), note);
    assert.equal(button(p, 'Pause'), undefined);
    assert.deepEqual(posts(p), [], 'nothing is resumed by opening it');
    button(p, 'Resume').click();
    await until(() => button(p, 'Pause'));
    assert.deepEqual(posts(p), ['/api/jobs/job-1/resume']);
    assert.match(p.doc.querySelector('.job-detail-heading').textContent, /Running/);
    assert.equal(p.doc.querySelector('.job-pause-note'), null);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('pausing a running job that has not frozen yet says Pausing and offers to resume it', async () => {
  const state = { job: base };
  const p = mount(state);
  try {
    await select(p);
    assert.ok(button(p, 'Pause'));
    assert.match(button(p, 'Pause').title, /memory, GPU memory and reservation stay; GPU work already sent finishes first/);
    assert.ok(button(p, 'Cancel'), 'cancel stays available beside pause');
    button(p, 'Pause').click();
    await until(() => button(p, 'Resume'));
    assert.deepEqual(posts(p), ['/api/jobs/job-1/pause']);
    assert.match(p.doc.querySelector('.job-detail-heading').textContent, /Pausing/);
    assert.match(p.doc.querySelector('.job-pause-note').textContent, /not every process had stopped/);
    assert.ok(!row(p).querySelector('.status-mark.state-paused'), 'not drawn paused before it is confirmed');
  } finally { p.close(); }
});

test('a finished job shows its outcome, not its last pause, and offers neither pause nor resume', async () => {
  const state = { job: { ...paused, status: 'failed', reserved: false, reason: 'timeout', finishedAt: new Date().toISOString() } };
  const p = mount(state);
  try {
    await select(p);
    assert.match(p.doc.querySelector('.job-detail-heading').textContent, /Failed/);
    assert.equal(button(p, 'Pause'), undefined);
    assert.equal(button(p, 'Resume'), undefined);
    assert.equal(p.doc.querySelector('.job-pause-note'), null);
  } finally { p.close(); }
});

test('a failed pause says so and offers to pause again', async () => {
  const state = { job: { ...base, pause: { intent: 'pause', state: 'failed', reason: 'systemd did not freeze the job: Unit is not active' } } };
  const p = mount(state);
  try {
    await select(p);
    assert.match(p.doc.querySelector('.job-detail-heading').textContent, /Pause failed/);
    assert.match(p.doc.querySelector('.job-pause-note').textContent, /Unit is not active/);
    assert.ok(button(p, 'Pause'));
    assert.equal(button(p, 'Resume'), undefined);
  } finally { p.close(); }
});

const GPU0 = 'GPU-560174b1-ee9f-e64c-950c-657b47f3fd73', GPU1 = 'GPU-11111111-2222-3333-4444-555555555555', GPU2 = 'GPU-99999999-8888-7777-6666-555555555555';
const device = extra => ({ uuid: GPU0, index: 0, name: 'NVIDIA GeForce RTX 5090', memoryTotalMiB: 32607, memoryFreeMiB: 16972,
  admission: 'open', closedReason: null, closedBy: null, sharing: false, headroomMiB: 1024, reservations: [], ...extra });
const devices = () => ({ observedAt: new Date().toISOString(), problem: null, scope: 'Admission among managed jobs.', devices: [
  device({ reservations: [{ jobId: 'job-1', name: 'Train small model', memoryMiB: 4096, mode: 'exclusive' }] }),
  device({ uuid: GPU1, index: 1, admission: 'closed', closedBy: 'user', closedReason: 'A game is running' }),
  device({ uuid: GPU2, index: 2, admission: 'closed', closedBy: 'user', closedReason: 'Paused by the user' }),
] });
const gpuRow = (p, index) => [...p.doc.querySelectorAll('.jobs-gpu')][index];
const gpuButton = (p, index) => gpuRow(p, index).querySelector('.jobs-gpu-pause');

test('each GPU offers to pause its work, or to resume what the user paused there', async () => {
  const onGpu0 = { ...paused, gpu: { memoryMiB: 4096 }, gpuReservation: [{ uuid: GPU0, index: 0, name: 'NVIDIA GeForce RTX 5090', memoryMiB: 4096, mode: 'exclusive' }] };
  const p = mount({ job: onGpu0 }, devices);
  try {
    await open(p);
    await until(() => gpuRow(p, 2) && row(p));
    // A job the user paused holds GPU 0; GPU 2 is closed by a GPU pause; GPU 1 is closed for another reason.
    assert.equal(gpuButton(p, 0).textContent.trim(), 'Resume GPU work');
    assert.equal(gpuButton(p, 1).textContent.trim(), 'Pause GPU work');
    assert.equal(gpuButton(p, 2).textContent.trim(), 'Resume GPU work');
    assert.match(gpuButton(p, 1).title, /Stop new jobs on this GPU and pause the managed jobs using it/);
    assert.ok(gpuRow(p, 1).textContent.includes('Closed to new jobs (A game is running). Jobs already on it keep it.'), 'the other close is shown as it is');
    gpuButton(p, 0).click();
    await until(() => posts(p).length === 1);
    assert.deepEqual(posts(p), [`/api/jobs/gpus/${GPU0}/resume`]);
    gpuButton(p, 1).click();
    await until(() => posts(p).length === 2);
    assert.equal(posts(p)[1], `/api/jobs/gpus/${GPU1}/pause`);
    // A job that ended meanwhile is named, not hidden, and the others were still paused.
    await until(() => p.doc.querySelector('.jobs-gpus-error'));
    assert.equal(p.doc.querySelector('.jobs-gpus-error').textContent,
      'Not paused: Eval (Only a running job can be paused; this one is succeeded)');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a resume that has not taken hold can be asked again, also after reopening, once at a time', async () => {
  // The thaw was still pending after 10 s, or Core restarted between saving
  // the request and the answer: the job stays frozen and marked resuming, and
  // Core never resumes it by itself. On b0dae5d the button was disabled here.
  let release;
  const state = { job: { ...base, pause: { intent: 'resume', state: 'resuming', reason: 'Thaw requested, but the job was still frozen after 10 s' } },
    hold: new Promise((resolve) => { release = resolve; }) };
  const p = mount(state);
  try {
    await select(p);
    assert.match(p.doc.querySelector('.job-detail-heading').textContent, /Resuming/);
    assert.equal(button(p, 'Resume').disabled, false, 'resume can be asked again');
    // Closing and reopening the details changes nothing: it is the saved state that offers the retry.
    p.doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => !p.doc.querySelector('[role="dialog"]'));
    await select(p);
    assert.equal(button(p, 'Resume').disabled, false, 'still offered after reopening');
    // While the request is in flight the button is disabled, so a second press sends nothing.
    button(p, 'Resume').click();
    await until(() => button(p, 'Resume').disabled);
    button(p, 'Resume').click();
    await wait();
    assert.deepEqual(posts(p), ['/api/jobs/job-1/resume'], 'one request while one is in flight');
    // The host thaws it: the job reads Running, the pause note goes, and Pause is offered.
    release();
    await until(() => button(p, 'Pause'));
    assert.match(p.doc.querySelector('.job-detail-heading').textContent, /Running/);
    assert.equal(p.doc.querySelector('.job-pause-note'), null);
    assert.deepEqual(posts(p), ['/api/jobs/job-1/resume']);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
