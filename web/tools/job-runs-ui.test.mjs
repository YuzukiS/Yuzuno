// T-105: a job that is one attempt of a run's stage shows its run (stages,
// attempts, what waits and why), the artifacts it verified, its recorded cost
// and progress, and offers the run's retry and cancel instead of a free rerun.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/job-runs-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};window.renderJobs=p=>createRoot(document.getElementById('root')).render(<Jobs {...p}/>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'JobRunsUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 120; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const agent = { id: 'a', name: 'Mori', cwd: '/workspace', status: 'working' };
const resources = { cpuMillis: 500, memoryMiB: 96, swapMiB: 0 };
const base = { requestId: 'r#api', taskRef: 'T-105', agentId: 'a', agent: { name: 'Mori' }, machine: { name: 'WSL' }, resources,
  reservation: { cpuMillis: 600, memoryMiB: 160, swapMiB: 0 }, createdAt: new Date().toISOString(), argv: ['/usr/bin/python3', 'api.py'], cwd: '/workspace', env: {} };
const run = { id: 'run-1', name: 'Skillevo replay', experiment: 'pathb', status: 'failed', costLimitUsd: 12, cancelRequestedAt: null,
  cost: { knownUsd: 0.722326, unknownEntries: 1, attemptsRunning: 0, complete: false },
  stages: [
    { key: 'api', status: 'failed', needs: [], retry: { attempts: 3 }, reusedFrom: null, attempts: [
      { id: 'job-1', status: 'failed', reason: 'exit-code. Declared retryable: attempt 2 of 3 is job job-2', run: { attempt: 1 } },
      { id: 'job-2', status: 'failed', reason: 'exit-code', run: { attempt: 2 }, retryOf: 'job-1' }] },
    { key: 'judge', status: 'waiting', needs: ['api'], retry: null, reusedFrom: null, attempts: [
      { id: 'job-3', status: 'waiting', reason: 'Upstream stage api attempt 2 failed. This stage starts only after api succeeds', run: { attempt: 1 } }] },
  ] };
const failed = { ...base, id: 'job-2', name: 'Skillevo replay · api', status: 'failed', reserved: false, cursor: 2, reason: 'exit-code',
  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), run: { id: 'run-1', stage: 'api', attempt: 2 }, retryOf: 'job-1',
  artifacts: [{ path: 'answers.json', format: 'json' }, { path: 'transcript.jsonl', format: 'jsonl' }],
  result: { reason: 'exit-code', evidence: { systemd: { Result: 'exit-code' } },
    artifacts: [{ path: 'answers.json', ok: true, bytes: 12, sha256: 'abcdef0123456789'.repeat(4) }, { path: 'transcript.jsonl', ok: false, problem: 'the last line is not terminated: the file may be partly written' }],
    cost: { knownUsd: 0.63, unknownEntries: 1, complete: false }, progress: { value: { trial: 48, of: 48 }, updatedAtUnix: 1760000000 } } };
const waiting = { ...base, id: 'job-3', name: 'Skillevo replay · judge', status: 'waiting', reserved: false, cursor: 3, startedAt: null, finishedAt: null,
  reason: run.stages[1].attempts[0].reason, run: { id: 'run-1', stage: 'judge', attempt: 1 } };
const page = jobs => ({ jobs, liveJobs: jobs.filter(j => j.status === 'waiting'), hasMore: false, nextBefore: null });

function mount(handler) {
  const vc = new VirtualConsole(), errors = [], calls = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    let value;
    if (url === '/api/jobs/budget') value = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 0, queuedCount: 0, collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 }, machine: { name: 'WSL', memoryAvailableMiB: 2000, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, maximumBudget: { cpuMillis: 24000, memoryMiB: 20053, swapMiB: 4096 } } };
    else if (url.endsWith('/logs')) value = { text: '', oldestOffset: 0, totalBytes: 0 };
    else value = await handler(url, body);
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  w.renderJobs({ workspaceId: 'w', agent, revision: '1', disabled: false });
  return { window: w, doc: w.document, calls, errors, close: () => w.close() };
}
const button = (p, text) => [...p.doc.querySelectorAll('button')].find(b => b.textContent.trim() === text);
async function open(p) { await until(() => p.doc.querySelector('[aria-label="Jobs"]')); p.doc.querySelector('[aria-label="Jobs"]').click(); await until(() => p.doc.querySelector('[role="dialog"]')); }
const row = (p, name) => [...p.doc.querySelectorAll('.job-row')].find(r => r.textContent.includes(name));

test('a waiting stage is live, says what it waits for, and names its stage and attempt', async () => {
  const p = mount(url => url === '/api/jobs/job-3' ? waiting : url === '/api/jobs/runs/run-1' ? run : page([waiting, failed]));
  try {
    await open(p);
    await until(() => row(p, '· judge'));
    const text = row(p, '· judge').textContent;
    assert.match(text, /Waiting for upstream/);
    assert.match(text, /judge · attempt 1/);
    assert.match(text, /Upstream stage api attempt 2 failed/);
    assert.equal(row(p, '· judge').closest('.job-group-active') !== null, true);
    row(p, '· judge').click();
    await until(() => p.doc.querySelector('.job-run'));
    assert.equal(!!button(p, 'Cancel'), true, 'a waiting stage can be cancelled like a queued job');
    assert.equal(!!button(p, 'Retry stage'), false);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a failed attempt shows its run, verified and rejected artifacts and recorded cost, and retries the stage once', async () => {
  let current = run;
  const p = mount((url, body) => {
    if (url === '/api/jobs/job-2') return failed;
    if (url === '/api/jobs/runs/run-1/retry') {
      current = { ...run, status: 'running', stages: [{ ...run.stages[0], status: 'queued', attempts: [...run.stages[0].attempts, { id: 'job-4', status: 'queued', reason: null, run: { attempt: 3 }, retryOf: 'job-2' }] }, run.stages[1]] };
      return current;
    }
    if (url === '/api/jobs/runs/run-1/cancel') return { ...current, status: 'cancelling', cancelRequestedAt: new Date().toISOString() };
    if (url === '/api/jobs/runs/run-1') return current;
    return page([waiting, failed]);
  });
  try {
    await open(p);
    await until(() => row(p, '· api'));
    row(p, '· api').click();
    await until(() => p.doc.querySelector('.job-run') && p.doc.querySelector('.job-artifacts'));
    const card = p.doc.querySelector('.job-run');
    assert.match(card.textContent, /Skillevo replay · pathb/);
    assert.match(card.textContent, /A stage did not succeed/);
    assert.match(card.textContent, /attempt 1 of 3attempt 2 of 3/);
    assert.match(card.textContent, /Waiting for upstream/);
    assert.match(card.textContent, /\$0\.7223 · plus 1 of unknown cost · soft limit \$12\.00/);
    assert.match(card.textContent, /unknown is not zero/);
    assert.equal(card.querySelector('[aria-current="true"]').textContent.trim(), 'attempt 2 of 3');
    const artifacts = p.doc.querySelector('.job-artifacts').textContent;
    assert.match(artifacts, /answers\.json.*Verified · 12 bytes · SHA-256 abcdef012345…/);
    assert.match(artifacts, /transcript\.jsonl.*Not accepted: the last line is not terminated/);
    const downloads = [...p.doc.querySelectorAll('.job-artifacts a[download]')].map(a => a.getAttribute('href'));
    assert.deepEqual(downloads, ['/api/jobs/job-2/artifacts/0'], 'only a verified artifact is offered, bound to its attempt');
    const detail = p.doc.querySelector('.job-detail').textContent;
    assert.match(detail, /Recorded cost\$0\.6300 · plus 1 of unknown cost/);
    assert.match(detail, /Progress\{"trial":48,"of":48\}/);
    assert.equal(!!button(p, 'Run again…'), false, 'a stage is retried in its run, not rerun as a free job');
    button(p, 'Retry stage').click();
    await until(() => p.calls.some(c => c.url === '/api/jobs/runs/run-1/retry'));
    const retry = p.calls.find(c => c.url === '/api/jobs/runs/run-1/retry').body;
    assert.deepEqual(retry, { requestId: 'retry:job-2', stage: 'api' });
    await until(() => !button(p, 'Retry stage'));
    assert.match(p.doc.querySelector('.job-run').textContent, /attempt 3 of 3/);
    button(p, 'Cancel run').click();
    await until(() => p.calls.some(c => c.url === '/api/jobs/runs/run-1/cancel'));
    await until(() => !button(p, 'Cancel run'));
    assert.match(p.doc.querySelector('.job-run').textContent, /Cancelling/);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a successful final-stage job stays finished while its run waits for an explicit gate decision', async () => {
  const completed = { ...failed, status: 'succeeded', reason: 'success', run: { id: 'gate-run', stage: 'api', attempt: 2 } };
  let current = { ...run, id: 'gate-run', status: 'waiting_analysis', awaitingAnalysis: true, stages: [
    { key: 'api', needs: [], status: 'waiting_analysis', attempts: [{ id: completed.id, status: 'succeeded', run: { attempt: 2 } }],
      analysis: { id: 'gate-1', state: 'waiting', jobId: completed.id, attemptId: 'attempt-2', execution: 'succeeded' } },
  ] };
  const p = mount((url, body) => {
    if (url.startsWith('/api/jobs/runs?')) return { runs: current.awaitingAnalysis ? [{ id: current.id, name: current.name }] : [], hasMore: false };
    if (url === '/api/jobs/job-2') return completed;
    if (url === '/api/jobs/runs/gate-run') return current;
    if (url === '/api/jobs/runs/gate-run/decide') {
      current = { ...current, status: 'succeeded', awaitingAnalysis: false, stages: [{ ...current.stages[0], status: 'succeeded', analysis: { ...current.stages[0].analysis, state: 'continued' } }] };
      return current;
    }
    return page([completed]);
  });
  try {
    await open(p);
    await until(() => row(p, '· api') && p.doc.querySelector('[aria-label="Runs awaiting analysis"]'));
    assert.equal(row(p, '· api').closest('.job-group-active'), null);
    row(p, '· api').click();
    await until(() => button(p, 'Continue after api'));
    assert.equal(!!button(p, 'Cancel'), false, 'a successful Job is not cancellable');
    assert.equal(!!button(p, 'Retry stage'), false);
    assert.match(p.doc.querySelector('.job-run').textContent, /Execution succeeded · no resources held/);
    button(p, 'Continue after api').click();
    await until(() => p.calls.some(c => c.url.endsWith('/decide')));
    assert.deepEqual(p.calls.find(c => c.url.endsWith('/decide')).body, {
      requestId: 'analysis:gate-1:continue', stage: 'api', gateId: 'gate-1', attemptId: 'attempt-2', decision: 'continue',
    });
    await until(() => !button(p, 'Continue after api') && !p.doc.querySelector('[aria-label="Runs awaiting analysis"]'));
    assert.match(p.doc.querySelector('.job-run').textContent, /Completed/);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('an all-reused run with no new Jobs remains reachable and can be cancelled at its own gate', async () => {
  let current = { ...run, id: 'reuse-run', status: 'waiting_analysis', stages: [
    { key: 'reuse', needs: [], status: 'waiting_analysis', attempts: [], reusedFrom: { jobId: 'old-job' },
      analysis: { id: 'fresh-gate', state: 'waiting', jobId: 'old-job', attemptId: 'old-attempt', execution: 'reused' } },
  ] };
  const p = mount((url, body) => {
    if (url.startsWith('/api/jobs/runs?')) return { runs: current.cancelRequestedAt ? [] : [{ id: current.id, name: current.name }], hasMore: false };
    if (url === '/api/jobs/runs/reuse-run') return current;
    if (url === '/api/jobs/runs/reuse-run/decide') {
      current = { ...current, status: 'cancelled', cancelRequestedAt: 'now' };
      return current;
    }
    return page([]);
  });
  try {
    await open(p);
    await until(() => p.doc.querySelector('.job-analysis-runs summary'));
    p.doc.querySelector('.job-analysis-runs summary').click();
    await until(() => button(p, 'Cancel run at reuse'));
    assert.match(p.doc.querySelector('.job-analysis-runs').textContent, /Successful result reused · no resources held/);
    button(p, 'Cancel run at reuse').click();
    await until(() => p.calls.some(c => c.url.endsWith('/decide')));
    assert.deepEqual(p.calls.find(c => c.url.endsWith('/decide')).body, {
      requestId: 'analysis:fresh-gate:cancel', stage: 'reuse', gateId: 'fresh-gate', attemptId: 'old-attempt', decision: 'cancel',
    });
    await until(() => !p.doc.querySelector('[aria-label="Runs awaiting analysis"]'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
