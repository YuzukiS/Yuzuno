// T-105: a job that is one attempt of a run's stage shows its run (stages,
// attempts, what waits and why), the artifacts it verified, its recorded cost
// and progress, and offers the run's retry and cancel instead of a free rerun.
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
    if (url === '/api/jobs/budget') value = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 0, queuedCount: 0, collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 }, machine: { name: 'WSL', memoryAvailableMiB: 2000, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, logicalCpus: 32, memoryTotalMiB: 40107, swapTotalMiB: 16384, hostHeadroomMiB: 2048 } };
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

test("a run's cost and an attempt's say what recorded none, and a known $0 stays $0 (T-17)", async () => {
  // A run's total as Core now gives it, and an attempt's own usage summary
  // as the host writes it, read in a fresh panel each.
  const shownFor = async (total, attemptCost) => {
    const current = { ...run, cost: total };
    const detail = { ...failed, result: { ...failed.result, cost: attemptCost } };
    const p = mount(url => url === '/api/jobs/job-2' ? detail : url === '/api/jobs/runs/run-1' ? current : page([waiting, failed]));
    const shown = () => [p.doc.querySelector('.job-run dd')?.textContent,
      [...p.doc.querySelectorAll('.job-detail dd')].find(d => d.previousElementSibling?.textContent === 'Recorded cost')?.textContent];
    try {
      await open(p);
      await until(() => row(p, '· api'));
      row(p, '· api').click();
      await until(() => shown()[0] && shown()[1]);
      assert.deepEqual(p.errors, []);
      return [...shown(), p.doc.querySelector('.job-run').textContent];
    } finally { p.close(); }
  };
  const summary = (entries) => ({ entries, knownUsd: 0, unknownEntries: 0, invalidLines: 0, incompleteLines: 0, truncated: false, complete: true });
  // Some attempts reported, some recorded none, some an unknown amount; this
  // attempt's file was empty.
  const [mixed, empty, card] = await shownFor({ knownUsd: 1.5, unknownEntries: 1, invalidLines: 1, attemptsReporting: 3, attemptsNotRecorded: 3,
    attemptsWithUnknown: 3, attemptsRunning: 0, truncated: false, complete: false }, summary(0));
  assert.equal(mixed, '$1.5000 · plus 2 of unknown cost · 3 with an unknown amount · 3 attempts recorded none · soft limit $12.00');
  assert.equal(empty, 'None recorded');
  assert.match(card, /an attempt that recorded none is said apart/);
  // None of the run's attempts reported: none recorded, not $0. This
  // attempt's entry says $0: a known $0.
  const [none, zero] = await shownFor({ knownUsd: 0, unknownEntries: 0, invalidLines: 0, attemptsReporting: 0, attemptsNotRecorded: 2,
    attemptsWithUnknown: 0, attemptsRunning: 0, truncated: false, complete: false }, summary(1));
  assert.equal(none, 'None recorded · soft limit $12.00');
  assert.equal(zero, '$0.0000');
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

test('a run names the method record it follows, and a decided gate the record that explains it (T-17)', async () => {
  const completed = { ...failed, status: 'succeeded', reason: 'success', run: { id: 'method-run', stage: 'api', attempt: 2 } };
  const current = { ...run, id: 'method-run', status: 'cancelled', cancelRequestedAt: 'now',
    method: { activitySeq: 3, id: 'timing', title: 'Timing protocol', version: 1 },
    methodNow: { state: 'readable', revisedBy: 6, latestActivitySeq: 6 },
    stages: [{ key: 'api', needs: [], status: 'succeeded', attempts: [{ id: completed.id, status: 'succeeded', run: { attempt: 2 } }],
      analysis: { id: 'gate-1', state: 'cancelled', jobId: completed.id, attemptId: 'attempt-2', execution: 'succeeded',
        record: { activitySeq: 9, version: 1, record: { type: 'observation', id: 'ranking-flips', title: 'Ranking flips with link order' },
          next: { action: 'stop', text: 'Time fresh processes before any further stage.' } },
        recordNow: { state: 'readable', revisedBy: null, latestActivitySeq: 9 } } }] };
  const p = mount(url => {
    if (url.startsWith('/api/jobs/runs?')) return { runs: [], hasMore: false };
    if (url === '/api/jobs/job-2') return completed;
    if (url === '/api/jobs/runs/method-run') return current;
    return page([completed]);
  });
  try {
    await open(p);
    await until(() => row(p, '· api'));
    row(p, '· api').click();
    await until(() => p.doc.querySelector('.job-run-method'));
    const card = p.doc.querySelector('.job-run').textContent;
    assert.match(card, /Follows the method “Timing protocol”, activity 3, version 1; a newer version is activity 6, and the run keeps the version it followed/);
    assert.match(card, /Cancelled, as the observation “Ranking flips with link order” \(activity 9, version 1\) explains · It proposed to stop: Time fresh processes before any further stage\./);
    assert.equal(p.calls.filter(c => c.url.includes('/decide')).length, 0, 'reading a decision decides nothing');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a decided gate keeps the version it cited and says where that record stands now, deciding nothing (T-17)', async () => {
  const completed = { ...failed, status: 'succeeded', reason: 'success', run: { id: 'gates-run', stage: 'a', attempt: 1 } };
  const decided = (key, state, now) => ({ key, needs: [], status: 'succeeded', attempts: [{ id: completed.id, status: 'succeeded', run: { attempt: 1 } }],
    analysis: { id: `gate-${key}`, state, jobId: completed.id, attemptId: `attempt-${key}`, execution: 'succeeded',
      record: { activitySeq: 9, version: 2, record: { type: 'claim', id: 'faster', title: 'Layout B is faster' } }, recordNow: now } });
  const current = { ...run, id: 'gates-run', status: 'succeeded', cancelRequestedAt: null, stages: [
    decided('a', 'continued', { state: 'readable', revisedBy: 12, latestActivitySeq: 12 }),
    decided('b', 'continued', { state: 'missing' }),
    decided('c', 'cancelled', { state: 'readable', revisedBy: 10, latestActivitySeq: null }),
  ] };
  const p = mount(url => {
    if (url.startsWith('/api/jobs/runs?')) return { runs: [], hasMore: false };
    if (url === '/api/jobs/job-2') return completed;
    if (url === '/api/jobs/runs/gates-run') return current;
    return page([completed]);
  });
  try {
    await open(p);
    await until(() => row(p, '· a'));
    row(p, '· a').click();
    await until(() => p.doc.querySelectorAll('.job-run-explained').length === 3);
    const [newer, missing, unknown] = [...p.doc.querySelectorAll('.job-run-explained')].map(n => n.textContent);
    assert.equal(newer, 'Continued, as the claim “Layout B is faster” (activity 9, version 2) explains; a newer version is activity 12, and the decision keeps the version it cited');
    assert.equal(missing, 'Continued, as the claim “Layout B is faster” (activity 9, version 2) explains; this record can no longer be read');
    assert.equal(unknown, 'Cancelled, as the claim “Layout B is faster” (activity 9, version 2) explains; a newer version exists, and the decision keeps the version it cited');
    assert.equal(p.calls.filter(c => /\/(decide|retry|cancel)$/.test(c.url)).length, 0, 'reading where a record stands decides nothing');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("a task's Jobs show what it recorded spending: every attempt once, unknown apart, nothing limited (T-17)", async () => {
  const spend = { taskId: 'T-105', attempts: 4, byStatus: { cancelled: 1, failed: 1, running: 1, succeeded: 1 },
    usd: { knownUsd: 1.75, attemptsReporting: 2, attemptsNotRecorded: 1, attemptsWithUnknown: 1, unknownEntries: 1, invalidLines: 0, attemptsRunning: 1, complete: false },
    compute: { cpuSeconds: 12.34, workerWallSeconds: 20, attemptsMeasured: 2, attemptsUnmeasured: 1 },
    gpu: { attemptsReserving: 1, measured: false }, runs: 1, reusedStages: 1, truncated: false };
  const p = mount((url, body) => {
    if (url === '/api/collaboration/job_cost') return body.taskId === 'T-105' ? spend : { error: 'unexpected task' };
    if (url.startsWith('/api/jobs/runs?')) return { runs: [], hasMore: false };
    return page([]);
  });
  try {
    await open(p);
    assert.equal(p.doc.querySelector('.job-task-spend'), null, 'only for one task');
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job', { detail: { taskId: 'T-105' } }));
    await until(() => p.doc.querySelector('.job-task-spend dd'));
    const text = p.doc.querySelector('.job-task-spend').textContent;
    for (const expected of ['Recorded spend on this task',
      '$1.75 · 1 with an unknown amount · 1 attempt recorded none · 1 still running',
      '12.3 s of CPU over 2 attempts that measured both CPU and wall time · whether 1 attempt measured CPU is not said · GPU use is not measured; 1 attempt reserved a GPU',
      '4 attempts, each counted once, in 1 run and single Jobs · 1 reused stage ran nothing and is not counted again',
      'unknown is never zero', 'nothing resets when the method or the run changes'])
      assert.ok(text.includes(expected), `${expected}: ${text}`);
    assert.deepEqual(p.calls.find(c => c.url === '/api/collaboration/job_cost').body, { taskId: 'T-105' });
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("a task's spend says which of its counts stop at the newest attempts or runs (T-17)", async () => {
  const base = { taskId: 'T-105', attempts: 5000, byStatus: { succeeded: 5000 },
    usd: { knownUsd: 2, attemptsReporting: 5000, attemptsNotRecorded: 0, attemptsWithUnknown: 0, unknownEntries: 0, invalidLines: 0, attemptsRunning: 0, complete: true },
    compute: { cpuSeconds: 10, workerWallSeconds: 20, attemptsMeasured: 5000, attemptsUnmeasured: 0 },
    gpu: { attemptsReserving: 0, measured: false }, runs: 5000, reusedStages: 5000, limit: 5000 };
  let answer = { ...base, attemptsTruncated: false, runsTruncated: true, truncated: true };
  const p = mount((url) => {
    if (url === '/api/collaboration/job_cost') return answer;
    if (url.startsWith('/api/jobs/runs?')) return { runs: [], hasMore: false };
    return page([]);
  });
  const lines = () => [...p.doc.querySelectorAll('.job-task-spend dd')].map(n => n.textContent);
  try {
    await open(p);
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job', { detail: { taskId: 'T-105' } }));
    await until(() => p.doc.querySelector('.job-task-spend dd'));
    let [cost, compute, attempts] = lines();
    assert.equal(cost, '$2.00', 'every attempt was read: the cost is whole');
    assert.ok(!compute.includes('partial'), compute);
    assert.ok(attempts.endsWith(' · runs and reused stages partial: only the newest 5000 runs are read'), attempts);
    // Past the newest attempts, the cost, compute and attempt counts say so.
    answer = { ...base, usd: { ...base.usd, complete: false }, attemptsTruncated: true, runsTruncated: false, truncated: true };
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job', { detail: { taskId: 'T-106' } }));
    await until(() => lines()[0]?.includes('partial'));
    [cost, compute, attempts] = lines();
    for (const line of [cost, compute, attempts])
      assert.ok(line.includes('partial: only the newest 5000 attempts are read'), line);
    assert.ok(!attempts.includes('runs are read'), attempts);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("a task's CPU time is said over the attempts that measured CPU, whatever their wall time (T-17)", async () => {
  const base = { taskId: 'T-105', attempts: 4, byStatus: { succeeded: 4 },
    usd: { knownUsd: 1, attemptsReporting: 4, attemptsNotRecorded: 0, attemptsWithUnknown: 0, unknownEntries: 0, invalidLines: 0, attemptsRunning: 0, complete: true },
    gpu: { attemptsReserving: 0, measured: false }, runs: 0, reusedStages: 0, truncated: false };
  const answers = {
    // Three measured CPU, one of them without a wall time: not two.
    'T-201': { cpuSeconds: 3.5, attemptsWithCpu: 3, attemptsWithoutCpu: 1, workerWallSeconds: 9, attemptsWithWall: 3, attemptsWithoutWall: 1, attemptsMeasured: 2, attemptsUnmeasured: 2 },
    'T-202': { cpuSeconds: 0, attemptsWithCpu: 0, attemptsWithoutCpu: 4, workerWallSeconds: 12, attemptsWithWall: 4, attemptsWithoutWall: 0, attemptsMeasured: 0, attemptsUnmeasured: 4 },
    // An explicit zero is a measurement.
    'T-203': { cpuSeconds: 0, attemptsWithCpu: 1, attemptsWithoutCpu: 3, workerWallSeconds: 0, attemptsWithWall: 0, attemptsWithoutWall: 4, attemptsMeasured: 0, attemptsUnmeasured: 4 },
    // An older Core's answer has the pair counts only: said as pairs, with
    // nothing inferred about the other attempts' CPU.
    'T-204': { cpuSeconds: 3, workerWallSeconds: 9, attemptsMeasured: 2, attemptsUnmeasured: 1 },
    'T-205': { cpuSeconds: 0, workerWallSeconds: 0, attemptsMeasured: 0, attemptsUnmeasured: 3 },
  };
  const p = mount((url, body) => {
    if (url === '/api/collaboration/job_cost') return { ...base, taskId: body.taskId, compute: answers[body.taskId] };
    if (url.startsWith('/api/jobs/runs?')) return { runs: [], hasMore: false };
    return page([]);
  });
  const compute = () => p.doc.querySelectorAll('.job-task-spend dd')[1]?.textContent;
  try {
    await open(p);
    for (const [task, expected] of [
      ['T-201', '3.5 s of CPU over 3 measured attempts · 1 without a CPU measurement'],
      ['T-202', 'CPU not measured · 4 without a CPU measurement'],
      ['T-203', '0.0 s of CPU over 1 measured attempt · 3 without a CPU measurement'],
      ['T-204', '3.0 s of CPU over 2 attempts that measured both CPU and wall time · whether 1 attempt measured CPU is not said'],
      ['T-205', 'No attempt measured both CPU and wall time · whether 3 attempts measured CPU is not said'],
    ]) {
      p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job', { detail: { taskId: task } }));
      await until(() => p.calls.some(c => c.url === '/api/collaboration/job_cost' && c.body.taskId === task) && compute() === expected);
      assert.equal(compute(), expected, task);
    }
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("an answer that is not a spend summary is said, and the task's panel stays (T-17)", async () => {
  const p = mount(url => url.startsWith('/api/jobs/runs?') ? { runs: [], hasMore: false } : page([]));
  try {
    await open(p);
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job', { detail: { taskId: 'T-105' } }));
    await until(() => p.doc.querySelector('.job-task-spend'));
    assert.match(p.doc.querySelector('.job-task-spend').textContent, /Could not read the recorded spend: Core's answer was not a spend summary/);
    assert.equal(p.doc.querySelector('.job-task-scope').textContent, 'Task T-105', 'the panel around it stays');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
