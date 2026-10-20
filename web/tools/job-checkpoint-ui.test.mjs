// T-109: a running job that declared a checkpoint can be stopped there from
// its details, apart from Pause and saying how it differs. A stopping job
// says what was sent and when it is cancelled if it has not stopped; a job
// stopped at a verified checkpoint offers to resume it as a new job, once;
// one without a verified checkpoint says why and offers nothing.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/job-checkpoint-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};window.renderJobs=p=>createRoot(document.getElementById('root')).render(<Jobs {...p}/>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'JobCheckpointUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 120; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const agent = { id: 'a', name: 'Mori', cwd: '/workspace', status: 'working' };
const resources = { cpuMillis: 500, memoryMiB: 96, swapMiB: 0 };
const started = new Date(Date.now() - 60_000).toISOString();
const deadline = new Date(Date.now() + 60_000).toISOString();
const declared = { signal: 'SIGTERM', graceSeconds: 120, stoppedExitCode: 75 };
const base = { id: 'job-1', name: 'Train small model', requestId: 'r', taskRef: 'T-109', agentId: 'a', agent: { name: 'Mori' }, machine: { name: 'WSL' }, resources,
  reservation: { cpuMillis: 600, memoryMiB: 160, swapMiB: 0 }, createdAt: started, startedAt: started, finishedAt: null, argv: ['/usr/bin/python3', 'train.py'],
  cwd: '/workspace', env: {}, cursor: 1, reserved: true, status: 'running', reason: 'Running with verified cgroup limits', timeoutSeconds: 3600, checkpoint: declared };
const signalled = { ...base, checkpointStop: { state: 'signalled', graceSeconds: 120, deadline,
  reason: `Sent SIGTERM to the command; it has until ${deadline} to save and exit` } };
const finished = { reserved: false, status: 'cancelled', finishedAt: new Date().toISOString() };
const stopped = { ...base, ...finished, reason: "Stopped at the user's request at a verified checkpoint; only the user resumes it",
  checkpointStop: { state: 'checkpointed', reason: 'Stopped at a verified checkpoint; only the user resumes it' },
  result: { checkpoint: { ok: true, files: [{ path: 'last.ckpt', bytes: 12 }, { path: 'state.json', bytes: 2 }] } } };
const resumed = { ...base, id: 'job-2', name: 'Train small model', status: 'queued', reserved: false, startedAt: null, cursor: 2, resumeOf: 'job-1', reason: 'Waiting for shared machine capacity' };
const page = jobs => ({ jobs, liveJobs: [], hasMore: false, nextBefore: null });

function mount(state) {
  const vc = new VirtualConsole(), errors = [], calls = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    let value;
    if (url === '/api/jobs/budget') value = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 1, queuedCount: 0, collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 }, machine: { name: 'WSL', memoryAvailableMiB: 2000, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, maximumBudget: { cpuMillis: 24000, memoryMiB: 20053, swapMiB: 4096 } } };
    else if (url.endsWith('/logs')) value = { text: '', oldestOffset: 0, totalBytes: 0 };
    else if (url === '/api/jobs/job-1/checkpoint') { state.job = signalled; value = state.job; }
    else if (url === '/api/jobs/job-1/resume-checkpoint') {
      state.job = { ...stopped, checkpointStop: { ...stopped.checkpointStop, resumedAs: 'job-2' } }; state.next = resumed; value = resumed;
    }
    else if (url === '/api/jobs/job-2') value = state.next;
    else if (url === '/api/jobs/job-1') value = state.job;
    else value = page([state.next, state.job].filter(Boolean));
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  w.renderJobs({ workspaceId: 'w', agent, revision: '1', disabled: false });
  return { window: w, doc: w.document, calls, errors, close: () => w.close() };
}
const button = (p, text) => [...p.doc.querySelectorAll('.job-detail button')].find(b => b.textContent.trim() === text);
const heading = p => p.doc.querySelector('.job-detail-heading').textContent;
const note = p => p.doc.querySelector('.job-checkpoint-note')?.textContent;
async function open(p) { await until(() => p.doc.querySelector('[aria-label="Jobs"]')); p.doc.querySelector('[aria-label="Jobs"]').click(); await until(() => p.doc.querySelector('[role="dialog"]')); }
const row = p => p.doc.querySelector('.job-row');
async function select(p) { await open(p); await until(() => row(p)); row(p).click(); await until(() => p.doc.querySelector('.job-detail-heading h3')); }
const posts = p => p.calls.filter(c => c.method === 'POST').map(c => c.url);

test('stop at a checkpoint is offered apart from pause, says how it differs, and says when it is cancelled', async () => {
  const p = mount({ job: base });
  try {
    await select(p);
    assert.ok(button(p, 'Pause'), 'pause stays available beside it');
    const stop = button(p, 'Stop at checkpoint');
    assert.match(stop.title, /Unlike Pause, this ends the attempt and frees its memory/);
    assert.match(stop.title, /It has 120 s: if it is still running then, it is cancelled and cannot be resumed\./);
    assert.match(p.doc.querySelector('.job-detail').textContent, /On stop: SIGTERM, 120 s to save, exits 75/);
    assert.deepEqual(posts(p), [], 'nothing is stopped by opening it');
    stop.click();
    await until(() => /Stopping at checkpoint/.test(heading(p)));
    assert.deepEqual(posts(p), ['/api/jobs/job-1/checkpoint']);
    assert.ok(note(p).startsWith(`Sent SIGTERM to the command; it has until ${deadline} to save and exit. If it has not stopped by`), note(p));
    assert.ok(note(p).includes(`If it has not stopped by ${new Date(deadline).toLocaleString()}, it is cancelled and cannot be resumed.`), note(p));
    // A stopping job is neither paused nor stopped again; cancel stays.
    assert.equal(button(p, 'Pause'), undefined);
    assert.equal(button(p, 'Stop at checkpoint'), undefined);
    assert.ok(button(p, 'Cancel'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a job without a checkpoint, or paused, is not stopped at one', async () => {
  const plain = mount({ job: { ...base, checkpoint: null } });
  try {
    await select(plain);
    assert.equal(button(plain, 'Stop at checkpoint'), undefined);
  } finally { plain.close(); }
  const paused = mount({ job: { ...base, pause: { intent: 'pause', state: 'paused', reason: 'Paused' } } });
  try {
    await select(paused);
    assert.equal(button(paused, 'Stop at checkpoint').disabled, true);
    assert.match(button(paused, 'Stop at checkpoint').title, /Resume it first: a paused command cannot save a checkpoint/);
  } finally { paused.close(); }
});

test('a verified checkpoint is resumed as a new job once, and each links to the other', async () => {
  const state = { job: stopped };
  const p = mount(state);
  try {
    await select(p);
    assert.match(heading(p), /Stopped at checkpoint/);
    assert.match(note(p), /Stopped at a verified checkpoint; only the user resumes it\. 2 checkpoint files checked by SHA-256\./);
    assert.ok(button(p, 'Run again…'), 'a fresh run stays possible');
    button(p, 'Resume from checkpoint').click();
    // The new job is selected: it is queued and links back.
    await until(() => p.doc.querySelector('.job-detail-heading h3') && /Queued/.test(heading(p)));
    assert.deepEqual(posts(p), ['/api/jobs/job-1/resume-checkpoint']);
    assert.ok(button(p, 'The job it continues from'));
    button(p, 'The job it continues from').click();
    await until(() => /Stopped at checkpoint/.test(heading(p)));
    assert.equal(button(p, 'Resume from checkpoint'), undefined, 'resumed once');
    assert.ok(button(p, 'Resumed as a new job'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a stop without a verified checkpoint says why and offers no resume', async () => {
  const p = mount({ job: { ...base, ...finished, reason: "Stopped at the user's request without a verified checkpoint (the command exited 1, not the declared stopped code 75); it cannot be resumed.",
    checkpointStop: { state: 'notResumable', reason: 'No verified checkpoint: the command exited 1, not the declared stopped code 75' },
    result: { checkpoint: { ok: false, reason: 'the command exited 1, not the declared stopped code 75' } } } });
  try {
    await select(p);
    assert.match(heading(p), /Cancelled/);
    assert.match(note(p), /No verified checkpoint: the command exited 1/);
    assert.equal(button(p, 'Resume from checkpoint'), undefined);
    assert.equal(button(p, 'Stop at checkpoint'), undefined);
  } finally { p.close(); }
});
