// T-65: the Jobs panel's merge queue, opened as a person opens it (the Jobs
// dialog's Merge queue source), with every Core answer given here. The state
// and stop-reason codes are read from docs/merge-queue.md, so a code the doc
// adds without a word here fails.
import './jsdom-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { JSDOM, VirtualConsole } from 'jsdom';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'node_modules/.cache'), { recursive: true });
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/merge-queue-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};const root=createRoot(document.getElementById('root'));window.renderJobs=p=>root.render(<Jobs {...p}/>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'MergeQueueUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

// The doc's vocabulary: the States table's codes and the stopped row's reasons.
const doc = await readFile(path.join(root, '../docs/merge-queue.md'), 'utf8');
const table = doc.slice(doc.indexOf('## States'), doc.indexOf('`merge_retry` checks'));
const docStates = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map(m => m[1]);
const stoppedRow = table.split('\n').find(line => line.startsWith('| `stopped` |'));
const docReasons = [...stoppedRow.slice(stoppedRow.indexOf('`reason` is')).matchAll(/`([a-z_]+)`/g)].map(m => m[1]);

const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn, what = 'Expected bounded UI state did not appear') { for (let n = 0; n < 120; n++) { if (fn()) return; await wait(); } assert.fail(what); }
const sha = c => c.repeat(40);
const project = { id: 'p1', name: 'Synthetic project', defaultDirs: {}, createdAt: '', updatedAt: '' };
const agents = [
  { id: 'lead-1', name: 'Lead Sora', kind: 'lead', projectId: 'p1', status: 'idle', cwd: '/fixture' },
  { id: 'dev-1', name: 'Dev Kai', projectId: 'p1', status: 'idle', cwd: '/fixture' },
];
const at = '2026-11-06T10:00:00Z';
const entry = (id, state, extra = {}) => ({
  id, entryId: id, taskId: `task-${id}`, taskReference: 'T-41', repositoryId: 7, repository: 'owner/repo', number: 12,
  url: 'https://github.com/owner/repo/pull/12', headSha: sha('a'), baseBranch: 'main', mainAtRelease: sha('b'), mainAnchoredAt: at,
  release: { by: { kind: 'agent', id: 'dev-1', name: 'Dev Kai' }, at, reviewId: 'review-1' },
  state, reason: null, detail: null, batch: null, merge: null, evidence: null, queueVersion: 2, createdAt: at, updatedAt: at, ...extra,
});
const stopped = entry('e-stopped', 'stopped', { reason: 'ci_red', detail: 'Synthetic CI run 501 ended failure' });
const queued = entry('e-queued', 'queued', { number: 13, url: 'https://github.com/owner/repo/pull/13', release: { by: { kind: 'user', id: 'user', name: 'You' }, at } });
const waiting = entry('e-waiting', 'waiting', { number: 14, detail: 'Synthetic run still in progress' });
const dry = entry('e-dry', 'stopped', { number: 15, reason: 'dry_run_ended', detail: 'Synthetic dry run ended' });
const done = entry('e-done', 'done', {
  number: 16, taskReference: 'T-43', url: 'https://github.com/owner/repo/pull/16',
  batch: { branch: 'queue/merge-e-done', main: sha('b'), commit: sha('d'), tree: sha('e'), pr: 90, closed: true, deleted: true, cleanup: 'done' },
  evidence: { gate: { kind: 'batch', tree: sha('e'), batch: { branch: 'queue/merge-e-done', commit: sha('d'), pr: 90, main: sha('b') },
    runs: [{ workflow: 'CI', run: 700, attempt: 1, conclusion: 'success' }, { workflow: 'Lint', run: 701, attempt: 2, conclusion: 'skipped' }] } },
  merge: { expectedMain: sha('b'), tree: sha('e'), gate: 'batch', head: sha('a'), attempts: 1, sha: sha('f'), mergedAt: at,
    post: { ok: true, commit: sha('f'), at }, mainCi: { run: 800, attempt: 1, conclusion: 'success', url: 'https://github.com/owner/repo/actions/runs/800' } },
});
const history = [
  { at, state: 'queued', reason: null, detail: 'released' },
  { at, state: 'ready', reason: null, detail: 'Synthetic checks held' },
  { at, state: 'done', reason: null, detail: 'Synthetic main CI green' },
];
const redPause = { reason: 'main_red', at, entryId: 'e-stopped', number: 12, main: sha('c'), run: 9001, base: 'main', detail: 'Synthetic main CI run 9001 failed' };
const repositories = {
  7: { repositoryId: 7, enabled: true, paused: redPause, pauses: [], switches: [] },
  8: { repositoryId: 8, enabled: false, paused: null, switches: [],
    pauses: [{ reason: 'main_red', at, number: 3, main: sha('c'), run: 77, clearedAt: at, clearedBy: { by: 'Lead Sora', actor: { kind: 'agent', id: 'lead-1', name: 'Lead Sora' }, reason: 'looked' }, reanchoredAt: sha('c'), acceptedRun: { id: 77, headSha: sha('c') } }] },
};
const linked = { repositories: [{ id: 7, fullName: 'owner/repo' }, { id: 8, fullName: 'owner/other' }], links: [] };
const all = [queued, waiting, stopped, dry, done];

function mount({ entries = all, answer = () => undefined, language } = {}) {
  const vc = new VirtualConsole(), errors = [], calls = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  if (language) w.localStorage.setItem('yuzuno.language', JSON.stringify({ language }));
  w.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method || 'GET', body });
    let value = await answer(url, body, init);
    if (value === undefined) {
      const byId = Object.fromEntries(entries.map(e => [e.id, e]));
      const one = /^\/api\/merge-queue\/([a-z-]+)$/.exec(url)?.[1];
      const repo = /^\/api\/merge-queue\/repositories\/(\d+)$/.exec(url)?.[1];
      if (url === '/api/collaboration/github_repositories') value = linked;
      else if (url === '/api/merge-queue' || url.startsWith('/api/merge-queue?')) value = { entries: entries.map(({ history: _h, ...e }) => e) };
      else if (repo) value = repositories[repo];
      else if (one && byId[one]) value = { ...byId[one], history };
      else if (url.startsWith('/api/jobs')) value = url === '/api/jobs/budget' ? { httpStatus: 404, error: 'not here' } : { jobs: [], hasMore: false, nextBefore: null };
      else value = {};
    }
    if (value instanceof Error) throw value;
    // A lost answer: fetch itself rejects, as the page's own TypeError.
    if (value === 'lost') throw new w.TypeError('Failed to fetch');
    const status = value?.httpStatus || 200;
    return { ok: status < 400, status, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  const props = { workspaceId: 'w', agents, projects: [project], revision: '1', mergeQueueRevision: '1', disabled: false };
  w.renderJobs(props);
  return {
    window: w, doc: w.document, calls, errors, close: () => w.close(),
    rerender: extra => w.renderJobs({ ...props, ...extra }),
    open: detail => w.dispatchEvent(new w.CustomEvent('yuzuno:open-job', { detail: { source: 'merge_queue', ...detail } })),
  };
}
const panel = p => p.doc.querySelector('.merge-queue');
const rows = p => [...p.doc.querySelectorAll('.merge-queue .job-row')];
const rowOf = (p, number) => rows(p).find(r => r.querySelector('strong').textContent === `owner/repo #${number}`);
const button = (scope, text) => [...scope.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const repoCard = (p, name) => [...p.doc.querySelectorAll('.merge-repository')].find(c => c.getAttribute('aria-label') === name);
async function opened(p, detail) { p.open(detail); await until(() => panel(p) && rows(p).length > 0, 'the merge queue did not list its entries'); }
async function choose(p, number) { rowOf(p, number).click(); await until(() => p.doc.querySelector('.job-detail h3')?.textContent === `owner/repo #${number}`); await until(() => !p.doc.querySelector('.job-detail').textContent.includes('Reading the history')); }
async function type(p, el, value) { Object.getOwnPropertyDescriptor(p.window.HTMLTextAreaElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new p.window.Event('input', { bubbles: true })); await wait(); }
const detailText = (p, label) => [...p.doc.querySelectorAll('.job-detail dt')].find(dt => dt.textContent === label)?.nextElementSibling;

test('the merge queue source lists entries with state, PR, frozen head and task, going apart from ended', async () => {
  const p = mount();
  try {
    await opened(p);
    const tab = p.doc.querySelector('#jobs-tab-merge_queue');
    assert.equal(tab.getAttribute('aria-selected'), 'true');
    assert.equal(tab.textContent.trim(), 'Merge queue');
    const groups = [...p.doc.querySelectorAll('.merge-queue .job-group')];
    assert.deepEqual(groups.map(g => g.querySelectorAll('.job-row').length), [2, 3]);
    assert.deepEqual([...groups[0].querySelectorAll('.job-row strong')].map(s => s.textContent), ['owner/repo #13', 'owner/repo #14']);
    const row = rowOf(p, 12);
    assert.match(row.textContent, /Stopped · CI red · T-41 · head aaaaaaa/);
    assert.match(row.querySelector('.job-row-note').textContent, /Synthetic CI run 501 ended failure/);
    assert.equal(row.querySelector('.status-mark').classList.contains('state-failed'), true);
    assert.equal(rowOf(p, 16).querySelector('.status-mark').classList.contains('state-succeeded'), true);
    // Read from Core's routes only: the list, each repository, and the Project's repositories.
    const reads = [...new Set(p.calls.map(c => `${c.method} ${c.url}`))].filter(u => /merge-queue|collaboration/.test(u));
    assert.deepEqual(reads.sort(), ['GET /api/merge-queue', 'GET /api/merge-queue/repositories/7', 'GET /api/merge-queue/repositories/8', 'POST /api/collaboration/github_repositories'].sort());
    assert.deepEqual(p.calls.find(c => c.url === '/api/collaboration/github_repositories').body, { projectId: 'p1' });
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('every state and stop reason of the merge queue doc has its word, in English and in Chinese', async () => {
  assert.deepEqual(docStates, ['queued', 'waiting', 'ready', 'merging', 'merged', 'done', 'stopped', 'cancelled']);
  assert.equal(docReasons.length, 20);
  const entries = [
    ...docStates.map((state, n) => entry(`s-${n}`, state, { number: 100 + n })),
    ...docReasons.map((reason, n) => entry(`r-${n}`, 'stopped', { number: 200 + n, reason })),
  ];
  const en = { queued: 'Queued', waiting: 'Waiting', ready: 'Ready', merging: 'Merging', merged: 'Merged', done: 'Done', stopped: 'Stopped', cancelled: 'Cancelled' };
  const zh = { queued: '已排队', waiting: '等待中', ready: '就绪', merging: '合并中', merged: '已合并', done: '已完成', stopped: '已停止', cancelled: '已取消' };
  for (const [language, words, unknown] of [['en', en, /Unknown state|Other reason/], ['zh-Hans', zh, /未知状态|其他原因/]]) {
    const p = mount({ entries, language });
    try {
      await opened(p);
      await until(() => rows(p).length === entries.length);
      docStates.forEach((state, n) => assert.equal(rowOf(p, 100 + n).querySelector('.job-state').textContent, words[state], state));
      for (const [n, reason] of docReasons.entries()) {
        const said = rowOf(p, 200 + n).querySelector('.job-state').textContent;
        assert.doesNotMatch(said, unknown, `${language} has no word for ${reason}`);
        assert.ok(said.startsWith(`${words.stopped} · `), said);
      }
      const reasonWords = docReasons.map((_, n) => rowOf(p, 200 + n).querySelector('.job-state').textContent);
      assert.equal(new Set(reasonWords).size, docReasons.length, 'each reason has its own word');
      if (language === 'zh-Hans') assert.doesNotMatch(reasonWords.join(' ').replace(/\b(PR|CI|GitHub|gh)\b/g, ''), /[A-Za-z]{2,}/, 'no English in the Chinese reasons');
    } finally { p.close(); }
  }
});

test('the pause banner names the reason, the entry and PR that caused it, the red run, and who can unpause', async () => {
  const p = mount();
  try {
    await opened(p);
    const paused = repoCard(p, 'owner/repo');
    const banner = paused.querySelector('.merge-pause');
    assert.match(banner.querySelector('.merge-pause-title').textContent, /^Paused: Main CI red/);
    assert.match(paused.querySelector('.merge-switch').textContent, /^On: Core merges released PRs here$/);
    assert.match(banner.textContent, /the entry for #12 · PR #12 · on main ccccccc/);
    assert.equal([...banner.querySelectorAll('a')].find(a => a.textContent === 'PR #12').href, 'https://github.com/owner/repo/pull/12');
    assert.equal([...banner.querySelectorAll('a')].find(a => a.textContent === 'run 9001').href, 'https://github.com/owner/repo/actions/runs/9001');
    assert.match(banner.textContent, /Synthetic main CI run 9001 failed/);
    assert.match(banner.textContent, /Unpausing while main is still ccccccc accepts red run 9001/);
    assert.equal(banner.querySelector('.merge-action-who').textContent, 'Who can unpause: a lead of Synthetic project (Lead Sora), or you.');
    // The entry that caused it opens from the banner.
    button(banner, 'the entry for #12').click();
    await until(() => p.doc.querySelector('.job-detail h3')?.textContent === 'owner/repo #12');
    // A repository that is not paused has no banner and no unpause; its last pause stays readable.
    const other = repoCard(p, 'owner/other');
    assert.equal(other.querySelector('.merge-pause'), null);
    assert.equal(button(other, 'Unpause'), undefined);
    assert.match(other.querySelector('.merge-switch').textContent, /^Off: Core writes nothing to GitHub here$/);
    assert.match(other.querySelector('.merge-last-pause').textContent, /Last pause: Main CI red, ended .* by Lead Sora · accepted red run 77/);
  } finally { p.close(); }
});

test('unpause asks a reason, sends it on the unpause route, shows the refusal text, and keeps its request id only across a lost answer', async () => {
  const sent = [];
  let replies = [
    () => ({ httpStatus: 403, error: 'merge_unpause_not_allowed: only a lead of a Project this repository is linked to, or the user, can unpause its merge queue' }),
    () => 'lost',
    () => ({ repository: { ...repositories[7], paused: null }, reanchored: ['e-queued', 'e-waiting'], main: sha('c'), acceptedRun: { id: 9001, headSha: sha('c') } }),
  ];
  const p = mount({ answer: (url, body, init) => {
    if (url === '/api/merge-queue/repositories/7/unpause') { sent.push({ method: init.method, body }); return replies.shift()(); }
  } });
  try {
    await opened(p);
    const banner = () => repoCard(p, 'owner/repo').querySelector('.merge-pause');
    button(banner(), 'Unpause').click();
    await until(() => banner().querySelector('textarea'));
    assert.match(banner().querySelector('label').textContent, /Reason \(optional, kept in the record\)/);
    await type(p, banner().querySelector('textarea'), '  Synthetic red run looked at  ');
    button(banner(), 'Unpause').click();
    await until(() => banner().querySelector('.merge-refusal'));
    assert.equal(banner().querySelector('.merge-refusal').textContent, 'Refused: merge_unpause_not_allowed: only a lead of a Project this repository is linked to, or the user, can unpause its merge queue');
    button(banner(), 'Unpause').click();
    await until(() => banner().querySelector('.merge-unconfirmed'));
    assert.equal(banner().querySelector('.merge-unconfirmed').textContent, 'No answer from Core: it may or may not have arrived. Trying again sends the same request.');
    assert.equal(banner().querySelector('.merge-refusal'), null);
    button(banner(), 'Unpause').click();
    await until(() => p.doc.querySelector('.merge-action-done'));
    assert.equal(p.doc.querySelector('.merge-action-done').textContent, 'Unpaused. 2 waiting entries re-anchored at main ccccccc. Red run 9001 is accepted at that main.');
    assert.deepEqual(sent.map(s => s.method), ['POST', 'POST', 'POST']);
    assert.deepEqual(sent.map(s => s.body.reason), ['Synthetic red run looked at', 'Synthetic red run looked at', 'Synthetic red run looked at']);
    assert.ok(sent.every(s => Object.keys(s.body).sort().join() === 'reason,requestId'));
    // A refusal is Core's answer, so the next try is a new request; a lost answer is the same request again.
    assert.notEqual(sent[1].body.requestId, sent[0].body.requestId);
    assert.equal(sent[2].body.requestId, sent[1].body.requestId);
  } finally { p.close(); }
});

test('retry and cancel show by state, each with who may take it', async () => {
  const p = mount();
  try {
    await opened(p);
    const actions = () => [...p.doc.querySelectorAll('.job-detail .merge-action')].map(a => [a.dataset.action, a.querySelector('.merge-action-who').textContent]);
    await choose(p, 12);
    assert.deepEqual(actions(), [['retry', 'Who can: the Agent that released it (Dev Kai), or you.']]);
    await choose(p, 13);
    assert.deepEqual(actions(), [['cancel', 'You released it, so only you can.']]);
    await choose(p, 14);
    assert.deepEqual(actions(), [['cancel', 'Who can: the Agent that released it (Dev Kai), or you.']]);
    await choose(p, 16);
    assert.deepEqual(actions(), []);
    await choose(p, 15);
    assert.deepEqual(actions(), []);
    assert.match(p.doc.querySelector('.job-detail').textContent, /Released before Core merged for real: release the PR again instead of retrying/);
    // Unpause is on the paused repository only, never on an entry.
    assert.equal([...p.doc.querySelectorAll('.merge-action[data-action="unpause"]')].length, 1);
  } finally { p.close(); }
});

test('retry and cancel post to their routes with the reason given, and show the refusal or the answer', async () => {
  const sent = [];
  const p = mount({ answer: (url, body) => {
    if (url.endsWith('/retry')) { sent.push({ url, body }); return { httpStatus: 409, error: 'merge_not_stopped: only a stopped entry can be retried; it is waiting' }; }
    if (url.endsWith('/cancel')) { sent.push({ url, body }); return { ...queued, state: 'cancelled' }; }
  } });
  try {
    await opened(p);
    await choose(p, 12);
    const retry = () => p.doc.querySelector('.job-detail .merge-action-retry');
    button(retry(), 'Retry').click();
    await until(() => retry().querySelector('textarea'));
    await type(p, retry().querySelector('textarea'), 'Synthetic job rerun');
    button(retry(), 'Retry').click();
    await until(() => retry().querySelector('.merge-refusal'));
    assert.equal(retry().querySelector('.merge-refusal').textContent, 'Refused: merge_not_stopped: only a stopped entry can be retried; it is waiting');
    await choose(p, 13);
    const cancel = () => p.doc.querySelector('.job-detail .merge-action-cancel');
    button(cancel(), 'Cancel entry').click();
    await until(() => cancel().querySelector('textarea'));
    button(cancel(), 'Cancel entry').click();
    await until(() => cancel().querySelector('.merge-action-done'));
    assert.equal(cancel().querySelector('.merge-action-done').textContent, 'Cancelled.');
    assert.equal(sent[0].url, '/api/merge-queue/e-stopped/retry');
    assert.equal(sent[0].body.reason, 'Synthetic job rerun');
    assert.equal(sent[1].url, '/api/merge-queue/e-queued/cancel');
    assert.deepEqual(Object.keys(sent[1].body), ['requestId'], 'no reason given, none sent');
    // Only the three routes write; nothing else was posted.
    const posts = p.calls.filter(c => c.method === 'POST' && c.url !== '/api/collaboration/github_repositories').map(c => c.url);
    assert.deepEqual(posts, ['/api/merge-queue/e-stopped/retry', '/api/merge-queue/e-queued/cancel']);
  } finally { p.close(); }
});

test('the chosen entry shows its anchor, batch, merge commit, post-check, main CI and history, and opens its task and PR', async () => {
  const p = mount();
  try {
    await opened(p);
    await choose(p, 16);
    assert.equal(detailText(p, 'Frozen head').textContent, 'aaaaaaa');
    assert.equal(detailText(p, 'Frozen head').querySelector('a').href, `https://github.com/owner/repo/commit/${sha('a')}`);
    assert.match(detailText(p, 'Anchor main').textContent, /^bbbbbbb · since /);
    assert.equal(detailText(p, 'Released by').textContent.startsWith('Dev Kai'), true);
    assert.equal(detailText(p, 'Branch').textContent, 'queue/merge-e-done');
    assert.equal(detailText(p, 'Batch PR').querySelector('a').href, 'https://github.com/owner/repo/pull/90');
    assert.equal(detailText(p, 'CI on the batch').textContent, 'CI · run 700 · Passed');
    assert.equal(detailText(p, 'Removal').textContent, 'Removed');
    assert.equal(detailText(p, 'Tested as').textContent, 'Core’s batch');
    assert.deepEqual([...detailText(p, 'CI runs').querySelectorAll('li')].map(li => li.textContent), ['CI · run 700 · Passed', 'Lint · run 701, attempt 2 · Skipped']);
    assert.equal(detailText(p, 'Merge commit').textContent, 'fffffff');
    assert.equal(detailText(p, 'Post-check').textContent, 'Parents and tree as tested');
    assert.equal(detailText(p, 'Main CI').querySelector('a').href, 'https://github.com/owner/repo/actions/runs/800');
    assert.equal(detailText(p, 'Main CI').textContent, 'CI · run 800 · Passed');
    // Newest first, each after its time.
    const lines = [...p.doc.querySelectorAll('.merge-history li')].map(li => li.children[1].textContent);
    assert.deepEqual(lines, ['Done · Synthetic main CI green', 'Ready · Synthetic checks held', 'Queued · released']);
    assert.equal([...p.doc.querySelectorAll('.job-detail a')].find(a => a.textContent === 'Open PR').href, 'https://github.com/owner/repo/pull/16');
    const opened = [];
    p.window.addEventListener('yuzuno:open-task-review', e => opened.push(e.detail));
    button(p.doc.querySelector('.job-detail'), 'Open T-43').click();
    await until(() => !p.doc.querySelector('[role="dialog"]'), 'Jobs did not close for the task');
    assert.deepEqual(opened, [{ taskId: 'task-e-done' }]);
  } finally { p.close(); }
});

test('in Chinese the pause, actions and refusals are Chinese, and Core text stays as it came', async () => {
  const p = mount({ language: 'zh-Hans', answer: url => url.endsWith('/unpause') ? { httpStatus: 409, error: 'merge_not_paused: the merge queue of this repository is not paused' } : undefined });
  try {
    await opened(p);
    assert.equal(p.doc.querySelector('#jobs-tab-merge_queue').textContent.trim(), '合并队列');
    const banner = repoCard(p, 'owner/repo').querySelector('.merge-pause');
    assert.match(banner.querySelector('.merge-pause-title').textContent, /^已暂停：主分支 CI 失败/);
    assert.equal(banner.querySelector('.merge-action-who').textContent, '可恢复者：Synthetic project 的负责人（Lead Sora），或你。');
    button(banner, '恢复').click();
    await until(() => banner.querySelector('textarea'));
    button(banner, '恢复').click();
    await until(() => banner.querySelector('.merge-refusal'));
    const refusal = banner.querySelector('.merge-refusal');
    assert.equal(refusal.querySelector('span').textContent, '已拒绝：此仓库的合并队列没有暂停。');
    assert.equal(refusal.querySelector('small').textContent, 'merge_not_paused: the merge queue of this repository is not paused');
    assert.equal(refusal.querySelector('small').getAttribute('lang'), 'en');
    await choose(p, 12);
    // The panel's own words have no English: what is left once the data
    // (names, repositories, SHAs, task references, Core's text) is taken out.
    const box = panel(p).cloneNode(true);
    for (const el of box.querySelectorAll('code, .merge-core-text, .job-row-note, [lang="en"], textarea')) el.remove();
    const data = ['owner/repo', 'owner/other', 'Synthetic project', 'Lead Sora', 'Dev Kai', 'T-41', 'T-43', 'review-1', 'queue/merge-e-done'];
    let text = box.textContent;
    for (const d of data) text = text.split(d).join(' ');
    // Short SHAs, and clock times in the browser's own locale (as every Jobs source shows them).
    text = text.replace(/\b[0-9a-f]{7,40}\b/g, ' ').replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|AM|PM)\b/g, ' ');
    const words = [...new Set(text.match(/[A-Za-z][A-Za-z-]+/g) || [])];
    assert.deepEqual(words.filter(w => !['PR', 'CI', 'Core', 'Agent', 'GitHub', 'gh'].includes(w)), []);
  } finally { p.close(); }
});

test('a merge queue change from Core re-reads the list, the repositories and the chosen entry', async () => {
  const p = mount();
  try {
    await opened(p);
    await choose(p, 12);
    const count = url => p.calls.filter(c => c.url === url).length;
    const before = [count('/api/merge-queue'), count('/api/merge-queue/repositories/7'), count('/api/merge-queue/e-stopped')];
    p.rerender({ mergeQueueRevision: '2' });
    await until(() => count('/api/merge-queue') > before[0] && count('/api/merge-queue/repositories/7') > before[1] && count('/api/merge-queue/e-stopped') > before[2]);
    // A task's view reads that task's entries only.
    p.open({ taskId: 'T-41' });
    await until(() => p.calls.some(c => c.url === '/api/merge-queue?taskId=T-41'));
    await until(() => /Entries of T-41 only/.test(panel(p)?.textContent || ''));
  } finally { p.close(); }
});
