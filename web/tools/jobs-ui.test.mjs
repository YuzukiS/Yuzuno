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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/jobs-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs,ConversationJobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};const root=createRoot(document.getElementById('root'));window.renderJobs=p=>root.render(<><Jobs key={p.workspaceId} {...p}/>{p.agent && <ConversationJobs key={p.agent.id} agentId={p.agent.id} revision={p.revision} disabled={p.disabled}/>}</>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'JobsUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }
const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 100; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const agent = { id: 'a', name: 'Mori', cwd: '/workspace', status: 'working' };
const props = { workspaceId: 'workspace-one', agent, revision: '1', disabled: false };
const ciRun = { id:'github:123:42:2', name:'Matrix CI', repository:'o/r', runId:'42', attempt:'2', headSha:'a'.repeat(40), status:'passed', rawStatus:'completed', conclusion:'success', url:'https://github.com/o/r/actions/runs/42/attempts/2', observedAt:'2026-10-15T01:00:00Z', cursor:1 };
const ciSub = { id:'sub', agentId:'a', agent:{name:'Mori'}, taskRef:'T-47', active:true, expiresAt:'2026-10-22T01:00:00Z', watch:{kind:'pull',number:7,url:'https://github.com/o/r/pull/7',expectedSha:'a'.repeat(40),currentHeadSha:'b'.repeat(40),state:'older_commit',observedAt:'2026-10-15T01:00:00Z',error:null} };
const ciPage = {runs:[ciRun],subscriptions:[ciSub],hasMore:false,nextBefore:null};
const resources = { cpuMillis: 500, memoryMiB: 128, swapMiB: 0 };
const job = { usage:{MemoryCurrent:'18446744073709551615',MemoryPeak:'18446744073709551615'}, id: 'job-one', requestId: 'accepted', name: '中文 training', taskRef: 'T-47', agentId: 'a', agent: { name: 'Mori' }, machine: { name: 'Local WSL' }, status: 'unknown', reserved: true, reason: 'Reservation held until process groups are verified', resources, reservation: { cpuMillis: 600, memoryMiB: 192, swapMiB: 0 }, cursor: 1, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null, argv: ['/usr/bin/true'], cwd: '/workspace', env: {}, outputs: ['report.json'] };
const page = jobs => ({ jobs, hasMore: false, nextBefore: null });
// `pollMs`: the panel's 3 s poll runs every pollMs instead, its firings
// counted (`ticks`); every other timer is as the product sets it (T-60).
// `logs`: answers a job's output instead of the fixed one.
function mount(handler = () => page([]), stored = {}, { pollMs, logs } = {}) {
  const vc = new VirtualConsole(), errors = [], calls = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  for (const [k, v] of Object.entries(stored)) w.localStorage.setItem(k, v);
  w.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    let value;
    if (url === '/api/jobs/budget' && !body) value = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 1, queuedCount: 1, collectorOverhead: {cpuMillis:100,memoryMiB:64,swapMiB:0}, budgetBounds: {minimum:{cpuMillis:200,memoryMiB:128,swapMiB:0},maximum:{cpuMillis:4096000,memoryMiB:67108864,swapMiB:67108864}}, machine: { name: 'WSL', memoryAvailableMiB: 2000, logicalCpus: 32, memoryTotalMiB: 40107, swapTotalMiB: 16384, hostHeadroomMiB: 2048, suggestedBudget:{cpuMillis:4000,memoryMiB:8192,swapMiB:0} } };
    else if (url.endsWith('/logs')) value = logs ? await logs(url) : { text: 'bounded output', oldestOffset: 1000, totalBytes: 1200 };
    else value = await handler(url, body);
    if (value instanceof Error) throw value;
    const status = value?.httpStatus || 200;
    return { ok: status < 400, status, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  let ticks = 0;
  if (pollMs) {
    const every = w.setInterval.bind(w);
    w.setInterval = (fn, ms, ...rest) => ms === 3000 ? every(() => { ticks++; fn(); }, pollMs, ...rest) : every(fn, ms, ...rest);
  }
  w.eval(bundle); w.renderJobs(props);
  return { window: w, doc: w.document, calls, errors, ticks: () => ticks, close: () => w.close() };
}
// The page shown, or hidden as a hidden tab is, with its visibilitychange.
function showPage(p, shown) {
  Object.defineProperty(p.doc, 'visibilityState', { configurable: true, get: () => shown ? 'visible' : 'hidden' });
  p.doc.dispatchEvent(new p.window.Event('visibilitychange'));
}
// Until `n` of the page's own 3 s intervals (mapped to pollMs) have really
// fired, counted on a timer of the test's: an interval passed, not a sleep.
async function intervals(p, n) {
  let fired = 0;
  const probe = p.window.setInterval(() => fired++, 3000);
  try { await until(() => fired >= n); } finally { p.window.clearInterval(probe); }
}
const reads = (p, url) => p.calls.filter(c => c.url === url).length;
const button = (p, text) => [...p.doc.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const field = (p, text) => [...p.doc.querySelectorAll('label')].find(l => l.textContent.startsWith(text))?.querySelector('input,textarea');
async function fill(p, text, value) { const el = field(p, text); assert.equal(!!el, true, `Missing ${text} field`); Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? p.window.HTMLTextAreaElement.prototype : p.window.HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new p.window.Event('input', { bubbles: true })); await wait(); }
async function open(p) { await until(() => p.doc.querySelector('[aria-label="Jobs"]')); p.doc.querySelector('[aria-label="Jobs"]').click(); await until(() => p.doc.querySelector('[role="dialog"]')); }

test('unknown job stays protected, shows resources and bounded output, Escape only dismisses dialog', async () => {
  const p = mount((url, body) => url === '/api/jobs/job-one' ? job : url.endsWith('/cancel') ? { ...job, status: 'cancelling' } : page([job]));
  try {
    await until(() => p.doc.querySelector('.conversation-job'));
    p.doc.querySelector('.conversation-job').click();
    await until(() => p.doc.querySelector('.job-log'));
    assert.equal(!!button(p, 'Run again…'), false);
    assert.match(p.doc.querySelector('.job-detail').textContent, /Outcome unknown/);
    assert.match(p.doc.querySelector('.job-log').textContent, /bounded output/);
    assert.equal([...p.doc.querySelectorAll('.job-detail dd')].filter(el=>el.textContent==='Not available').length,2);
    assert.match(p.doc.body.textContent, /Older output was rotated out/);
    assert.equal(!!p.doc.querySelector('a[download]'), true);
    let interrupts = 0;
    p.window.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented) interrupts++; });
    p.doc.querySelector('[role="dialog"]').dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await until(() => !p.doc.querySelector('[role="dialog"]'));
    assert.equal(interrupts, 0); assert.equal(p.calls.some(c => c.url.endsWith('/cancel')), false);
  } finally { p.close(); }
});

// T-60: the panel's 3 s poll asks Core for the list, the budget (a GPU
// sample), and the selected job's details and output. None of it while the
// page is hidden; shown again, it reads at once, then every 3 s.
test('the Jobs panel reads nothing while the page is hidden, and reads at once when it is shown again', async () => {
  const running = { ...job, status: 'running', reason: 'Running with verified cgroup limits' };
  const p = mount(url => url === '/api/jobs/job-one' ? running : page([running]), {}, { pollMs: 1000 });
  try {
    await until(() => p.doc.querySelector('.conversation-job'));
    p.doc.querySelector('.conversation-job').click();
    await until(() => p.doc.querySelector('.job-log'));
    await until(() => p.ticks() >= 1);
    const jobsReads = () => p.calls.filter(c => c.url.startsWith('/api/jobs')).length;
    showPage(p, false);
    await wait();
    const hidden = jobsReads();
    await intervals(p, 2);
    assert.equal(jobsReads(), hidden, 'no Jobs read while the page is hidden, over two intervals');
    const shownAt = Date.now();
    showPage(p, true);
    await until(() => jobsReads() > hidden);
    assert.ok(Date.now() - shownAt < 600, `the Jobs panel reads at once when it is shown again (after ${Date.now() - shownAt} ms)`);
    for (const url of ['/api/jobs/budget', '/api/jobs/job-one', '/api/jobs/job-one/logs'])
      assert.ok(reads(p, url) > 0, `${url} is read`);
    const ticked = p.ticks(), budget = reads(p, '/api/jobs/budget');
    await until(() => p.ticks() > ticked && reads(p, '/api/jobs/budget') > budget);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

// T-60: a finished job's details and output no longer change. Read once it
// is seen finished; again only once the list shows it changed (a new
// attempt), or on Refresh. The list goes on being read.
test('a finished job: its details and output are read once, until it changes or Refresh', async () => {
  const finished = { ...job, status: 'succeeded', reserved: false, attempt: 'attempt-one', finishedAt: new Date().toISOString() };
  const p = mount(url => url === '/api/jobs/job-one' ? finished : page([finished]), {}, { pollMs: 300 });
  try {
    await until(() => p.doc.querySelector('.conversation-job'));
    p.doc.querySelector('.conversation-job').click();
    await until(() => p.doc.querySelector('.job-log'));
    const list = () => p.calls.filter(c => c.url.startsWith('/api/jobs?')).length;
    const listed = list(), ticked = p.ticks();
    await until(() => p.ticks() >= ticked + 3);
    await wait();
    assert.equal(reads(p, '/api/jobs/job-one'), 1, 'a finished job: its details are read once over three ticks');
    assert.equal(reads(p, '/api/jobs/job-one/logs'), 1, 'a finished job: its output is read once over three ticks');
    assert.ok(list() >= listed + 3, 'the list goes on being read');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
  // Running, then finished: read each tick, once more when the list shows
  // it finished, then no more. A new attempt in the list, or Refresh, reads
  // it again.
  let current = { ...job, status: 'running', reason: 'Running with verified cgroup limits', attempt: 'attempt-one' };
  const q = mount(url => url === '/api/jobs/job-one' ? current : page([current]), {}, { pollMs: 300 });
  try {
    await until(() => q.doc.querySelector('.conversation-job'));
    q.doc.querySelector('.conversation-job').click();
    await until(() => q.doc.querySelector('.job-log'));
    await until(() => reads(q, '/api/jobs/job-one') >= 2);
    const ticks = async n => { const at = q.ticks(); await until(() => q.ticks() >= at + n); await wait(); };
    current = { ...current, status: 'failed', reserved: false, finishedAt: new Date().toISOString() };
    const before = reads(q, '/api/jobs/job-one');
    await ticks(3);
    assert.equal(reads(q, '/api/jobs/job-one'), before + 1, 'read once more when the list shows it finished, then no more');
    current = { ...current, status: 'failed', attempt: 'attempt-two' };
    const settled = reads(q, '/api/jobs/job-one');
    await ticks(2);
    assert.equal(reads(q, '/api/jobs/job-one'), settled + 1, 'a new attempt in the list reads it again');
    const again = reads(q, '/api/jobs/job-one'), listed = q.calls.filter(c => c.url.startsWith('/api/jobs?')).length;
    q.doc.querySelector('button[aria-label="Refresh jobs"]').click();
    await until(() => q.calls.filter(c => c.url.startsWith('/api/jobs?')).length > listed);
    await wait(); await wait();
    assert.equal(reads(q, '/api/jobs/job-one'), again + 1, 'Refresh reads it again');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

// T-60: unknown is not finished. Core holds the reservation and checks the
// attempt again, so its details and output go on being read.
test('an unknown job: its details and output keep being read', async () => {
  const p = mount(url => url === '/api/jobs/job-one' ? job : page([job]), {}, { pollMs: 300 });
  try {
    await until(() => p.doc.querySelector('.conversation-job'));
    p.doc.querySelector('.conversation-job').click();
    await until(() => p.doc.querySelector('.job-log'));
    const ticked = p.ticks(), details = reads(p, '/api/jobs/job-one'), output = reads(p, '/api/jobs/job-one/logs');
    await until(() => p.ticks() >= ticked + 3);
    await wait();
    assert.ok(reads(p, '/api/jobs/job-one') >= details + 2, 'an unknown job: its details keep being read');
    assert.ok(reads(p, '/api/jobs/job-one/logs') >= output + 2, 'an unknown job: its output keeps being read');
  } finally { p.close(); }
});

// T-60, #642 R2 1e487ee9: the job finishes while its details are being read.
// Its output answered before then lacks the last lines, so the job settles
// only on output read after its finish was seen: one more read, then none.
test('a job that finishes during a read settles on output read after its finish, not on output read beside it', async () => {
  const running = { ...job, status: 'running', reserved: true, reason: 'Running with verified cgroup limits', attempt: 'attempt-one' };
  let finishing = false, finished = false, readAfterFinish = 0;
  const current = () => finished ? { ...running, status: 'succeeded', reserved: false, finishedAt: new Date().toISOString() } : running;
  const p = mount(async url => {
    if (url !== '/api/jobs/job-one') return page([current()]);
    // The detail read the finish lands in: answered after the output.
    if (finishing && !finished) { await new Promise(r => setTimeout(r, 60)); finished = true; }
    return current();
  }, {}, {
    pollMs: 300,
    logs: () => {
      if (finished) readAfterFinish++;
      return finished ? { text: 'first lines\nlast lines', oldestOffset: 0, totalBytes: 22 } : { text: 'first lines', oldestOffset: 0, totalBytes: 11 };
    },
  });
  try {
    await until(() => p.doc.querySelector('.conversation-job'));
    p.doc.querySelector('.conversation-job').click();
    await until(() => p.doc.querySelector('.job-log')?.textContent.includes('first lines'));
    finishing = true;
    await until(() => finished);
    const ticked = p.ticks();
    await until(() => p.ticks() >= ticked + 3);
    await wait();
    assert.match(p.doc.querySelector('.job-log').textContent, /last lines/, 'the output read after its finish is shown');
    assert.equal(readAfterFinish, 1, 'its output is read once after its finish, then no more');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('completed job retains its actual process/thread limit and failure evidence', async () => {
  const reason='Process/thread limit reached (128 tasks); pids.events max increased by 1 while the command failed';
  const finished={...job,status:'failed',reserved:false,usage:null,reason,
    result:{reason,evidence:{systemd:{Result:'exit-code',TasksMax:'128'},pids:{after:{max:128,peak:128,events:{max:1}}}}}};
  const p=mount(url=>url==='/api/jobs/job-one'?finished:page([finished]));
  try {
    await until(()=>p.doc.querySelector('.conversation-job'));p.doc.querySelector('.conversation-job').click();
    await until(()=>p.doc.querySelector('.job-log'));
    const label=[...p.doc.querySelectorAll('.job-detail dt')].find(el=>el.textContent==='Process/thread limit');
    assert.equal(label.nextElementSibling.textContent,'128');
    assert.match(p.doc.querySelector('.job-detail').textContent,/Process\/thread limit reached \(128 tasks\)/);
    assert.match(p.doc.querySelector('.job-evidence').textContent,/"peak": 128/);
  } finally {p.close();}
});

// T-50 (elasticLM): a finished job whose completion mail could not wake its
// Agent says so in its details, in Core's words; a mail that went through says nothing.
test('a completion mail whose delivery failed says why in the job details', async () => {
  const problem = "delivery failed: Effort changes must wait until the current turn finishes; it is tried again at the recipient's next wake-up. The mail stays in the mailbox.";
  const finished = { ...job, status: 'succeeded', reserved: false, usage: null, reason: 'success', result: { reason: 'success' },
    mail: { succeeded: { messageId: 'm1', delivery: 'error', problem } } };
  const p = mount(url => url === '/api/jobs/job-one' ? finished : page([finished]));
  try {
    await until(() => p.doc.querySelector('.conversation-job')); p.doc.querySelector('.conversation-job').click();
    await until(() => p.doc.querySelector('.job-mail-problem'));
    assert.equal(p.doc.querySelector('.job-mail-problem').textContent, `Mail to its Agent: ${problem}`);
  } finally { p.close(); }
  const delivered = { ...finished, mail: { succeeded: { messageId: 'm1', delivery: 'delivered', problem: null } } };
  const q = mount(url => url === '/api/jobs/job-one' ? delivered : page([delivered]));
  try {
    await until(() => q.doc.querySelector('.conversation-job')); q.doc.querySelector('.conversation-job').click();
    await until(() => q.doc.querySelector('.job-log'));
    assert.ok(!q.doc.querySelector('.job-mail-problem'), 'a mail that went through says nothing');
  } finally { q.close(); }
});

test('lost submission reply retains command and idempotency key across remount; retry does not create another attempt', async () => {
  let accepted = null, count = 0;
  const handler = (url, body) => {
    if (url === '/api/jobs' && body) { count++; accepted = { ...job, ...body, id: 'job-one', status: 'queued' }; if (count === 1) return new Error('Response lost'); return accepted; }
    return url === '/api/jobs/job-one' ? accepted : page(accepted ? [accepted] : []);
  };
  let p = mount(handler), stored, firstId;
  try {
    await open(p); button(p, 'New job').click(); await wait();
    await fill(p, 'Name', '中文 job'); await fill(p, 'Existing task', 'T-47'); await fill(p, 'Command', 'printf hello');
    assert.equal(field(p, 'Exclusive execution').checked, false);
    field(p, 'Exclusive execution').click(); await wait();
    button(p, 'Submit job').click(); await until(() => p.doc.querySelector('[role="alert"]'));
    firstId = p.calls.find(c => c.url === '/api/jobs' && c.body).body.requestId;
    assert.equal(p.calls.find(c => c.url === '/api/jobs' && c.body).body.exclusive, true);
    stored = Object.fromEntries(Object.entries(p.window.localStorage));
    assert.equal(Object.keys(stored).some(k => k.startsWith('yuzuno.job-submission')), true);
  } finally { p.close(); }
  p = mount(handler, stored);
  try {
    await open(p); await until(() => button(p, 'Retry same submission'));
    assert.equal(field(p, 'Command').value, 'printf hello');
    assert.equal(field(p, 'Exclusive execution').checked, true);
    assert.equal(field(p, 'Exclusive execution').disabled, true);
    button(p, 'Retry same submission').click(); await until(() => p.calls.some(c => c.url === '/api/jobs' && c.body));
    await until(() => !p.doc.querySelector('.job-form'));
    assert.equal(p.calls.find(c => c.url === '/api/jobs' && c.body).body.requestId, firstId);
    assert.equal(p.calls.find(c => c.url === '/api/jobs' && c.body).body.exclusive, true);
    assert.equal(count, 2);
    assert.equal(Object.keys(p.window.localStorage).some(k => k.startsWith('yuzuno.job-submission')), false);
  } finally { p.close(); }
});

test('exclusive queue shows mode and wait reason; rerun preserves mode but requires explicit submission', async () => {
  let current={...job,exclusive:true,status:'queued',reserved:false,reason:'Waiting for running jobs to finish and their process groups to be cleared'};
  const p=mount(url=>url==='/api/jobs/job-one'?current:page([current]));
  try {
    await until(()=>p.doc.querySelector('.conversation-job'));
    // In the name the dock item is read by. Its tip, which shows the mode to
    // a pointer, is drawn into the page rather than inside the item, so the
    // item's own text is the label beside its node (T-15, #459: the dock
    // scrolls within itself and `.main-panel`'s container-type pins even
    // `position: fixed` to it, so the tip cannot live inside and be seen).
    assert.match(p.doc.querySelector('.conversation-job').getAttribute('aria-label'),/Exclusive/);
    p.doc.querySelector('.conversation-job').click(); await until(()=>p.doc.querySelector('.job-log'));
    assert.match(p.doc.querySelector('.job-row').textContent,/Exclusive/);
    assert.match(p.doc.querySelector('.job-row').textContent,/Waiting for running jobs/);
    assert.match(p.doc.querySelector('.job-detail').textContent,/Exclusive — this Core's managed local jobs/);
    current={...current,status:'succeeded',finishedAt:new Date().toISOString(),reason:'success'};
    p.doc.querySelector('[aria-label="Refresh jobs"]').click(); await until(()=>button(p,'Run again…'));
    button(p,'Run again…').click(); await wait();
    assert.equal(field(p,'Exclusive execution').checked,true);
    assert.equal(p.calls.some(c=>c.url==='/api/jobs' && c.body),false);
  } finally {p.close();}
});

test('a job started ahead of a blocked queue head says which and why it fitted; the head and the job behind it say how much may pass (T-38)', async () => {
  const head={...job,id:'job-head',name:'check',status:'queued',reserved:false,cursor:3,
    reason:'Waiting for shared RAM reservation: needs 24640 MiB including collector, 24512 MiB available; short 128 MiB. Up to 14900 mCPU / 16320 MiB RAM / 0 MiB swap may start ahead of it meanwhile'};
  const behind={...job,id:'job-behind',name:'w10',status:'queued',reserved:false,cursor:2,
    reason:'Waiting behind check, which waits for shared RAM reservation: this job needs 1100 mCPU / 4160 MiB RAM / 0 MiB swap; 13800 mCPU / 3968 MiB RAM / 0 MiB swap may start ahead of it now'};
  const passed={...job,name:'k5',status:'running',reason:'Running with verified cgroup limits',
    admission:{passed:{jobId:'job-head',name:'check',waits:'shared RAM reservation',need:{cpuMillis:1100,memoryMiB:12352,swapMiB:0},
      room:{cpuMillis:14900,memoryMiB:16320,swapMiB:0},headNeed:{cpuMillis:1100,memoryMiB:24640,swapMiB:0},at:new Date().toISOString()}}};
  const p=mount(url=>url==='/api/jobs/job-one'?passed:page([head,behind,passed]));
  try {
    await until(()=>[...p.doc.querySelectorAll('.conversation-job')].some(r=>r.textContent.includes('k5')));
    [...p.doc.querySelectorAll('.conversation-job')].find(r=>r.textContent.includes('k5')).click();
    await until(()=>p.doc.querySelector('.job-detail'));
    await wait();
    assert.ok(p.doc.querySelector('.job-admission'), 'the detail says the job started ahead of check');
    assert.equal(p.doc.querySelector('.job-admission').textContent,
      "Started ahead of check, which waited for the shared RAM reservation: this job's 12.1 GiB RAM fitted in the 15.9 GiB RAM left beside check's 24.1 GiB RAM");
    const rows=[...p.doc.querySelectorAll('.job-row')].map(r=>r.textContent);
    assert.ok(rows.some(r=>r.includes('check') && r.includes('Up to 14900 mCPU / 16320 MiB RAM / 0 MiB swap may start ahead of it meanwhile')), 'the head says how much may pass');
    assert.ok(rows.some(r=>r.includes('w10') && r.includes('Waiting behind check')), 'the job behind it says what it waits for');
    assert.deepEqual(p.errors,[]);
  } finally {p.close();}
});

test('a running job\'s memory limit is lowered from its card: twice the peak at least, sent as asked, then said; a refusal says why; not on another machine (T-38 B)', async () => {
  const mib = n => String(n * 1048576);
  const base = {...job,status:'running',reserved:true,reason:'Running with verified cgroup limits',resources:{cpuMillis:500,memoryMiB:4096,swapMiB:0},
    reservation:{cpuMillis:600,memoryMiB:4160,swapMiB:0},usage:{MemoryCurrent:mib(150),MemoryPeak:mib(200)}};
  let current = base;
  const p = mount((url, body) => {
    if (url === '/api/jobs/job-one/memory') {
      current = {...base,resources:{...base.resources,memoryMiB:body.memoryMiB},reservation:{...base.reservation,memoryMiB:body.memoryMiB + 64},
        limitChanges:[{by:{kind:'user',name:'You'},at:'2026-11-05T08:30:00Z',fromMiB:4096,toMiB:body.memoryMiB}]};
      return current;
    }
    return url === '/api/jobs/job-one' ? current : page([current]);
  });
  try {
    await until(() => p.doc.querySelector('.conversation-job'));
    p.doc.querySelector('.conversation-job').click(); await until(() => p.doc.querySelector('.job-log'));
    assert.ok(button(p, 'Lower memory limit…'), 'a running job on this host can be lowered');
    button(p, 'Lower memory limit…').click(); await wait();
    // Twice the 200 MiB peak is less than what it uses now plus 256 MiB.
    assert.equal(field(p, 'New memory limit').value, '406');
    assert.match(p.doc.querySelector('.job-lower-memory small').textContent, /Swap stays as reserved/);
    await fill(p, 'New memory limit', '1024');
    button(p, 'Lower limit').click();
    await until(() => p.doc.querySelector('.job-limit-changes'));
    assert.deepEqual(p.calls.filter(c => c.url === '/api/jobs/job-one/memory').map(c => c.body), [{ memoryMiB: 1024 }]);
    assert.match(p.doc.querySelector('.job-limit-changes').textContent, /^Lowered from 4\.0 GiB to 1\.0 GiB by You, /);
    assert.equal(p.doc.querySelector('.job-lower-memory'), null, 'the form closes');
    // A refusal says why, and the request stays.
    current = {...base,limitRefusal:{at:'2026-11-05T08:31:00Z',toMiB:300,state:'notLimited',reason:'300 MiB is below what the job uses now plus 256 MiB (406 MiB); nothing was changed'}};
    p.doc.querySelector('[aria-label="Refresh jobs"]').click();
    await until(() => p.doc.querySelector('.job-limit-note'));
    assert.equal(p.doc.querySelector('.job-limit-note').textContent, 'Not lowered: 300 MiB is below what the job uses now plus 256 MiB (406 MiB); nothing was changed');
    // On another machine there is nothing to lower with.
    current = {...base,executor:{kind:'ssh',machineName:'owl'}};
    p.doc.querySelector('[aria-label="Refresh jobs"]').click();
    await until(() => !button(p, 'Lower memory limit…'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('legacy unconfirmed ordinary submission retries with the same payload and request ID', async () => {
  const draft={agentId:'a',taskId:'T-47',name:'legacy',cwd:'/workspace',command:'true',cpu:'1',memory:'512',swap:'0',timeout:'30',env:'{}',inputs:'',outputs:'',guardGit:true};
  const body={agentId:'a',taskId:'T-47',name:'legacy',cwd:'/workspace',argv:['/bin/sh','-c','true'],env:{},inputs:[],outputs:[],guardGit:true,resources:{cpuMillis:1000,memoryMiB:512,swapMiB:0},timeoutSeconds:30};
  const stored={'yuzuno.job-submission.v1:["workspace-one"]':JSON.stringify({draft,key:JSON.stringify(body),requestId:'legacy-request'})};
  const p=mount((url,posted)=>url==='/api/jobs' && posted?{...job,...posted,status:'queued'}:url==='/api/jobs/job-one'?job:page([]),stored);
  try {
    await open(p); await until(()=>button(p,'Retry same submission'));
    assert.equal(field(p,'Exclusive execution').checked,false);
    button(p,'Retry same submission').click(); await until(()=>!p.doc.querySelector('.job-form'));
    assert.deepEqual(p.calls.find(c=>c.url==='/api/jobs' && c.body).body,{...body,requestId:'legacy-request'});
    assert.equal(!!p.doc.querySelector('[role="alert"]'),false);
  } finally {p.close();}
});

test('the submit form shows what earlier runs of the same name or command suggest, and sends the limits as set unless asked to use it (T-38 C)', async () => {
  // The K4 calibration of 2026-11-04: 20 GiB asked, 2.6 GiB at its peak on 1.2 cores.
  const suggestion = { memoryMiB: 4096, cpuMillis: 1800, memoryPeakMiB: 2662, averageCpuCores: 1.2, basedOn: [{ jobId: 'k4' }] };
  const asked = [];
  const handler = (url, body) => {
    if (url.startsWith('/api/jobs/suggestion?')) {
      const q = Object.fromEntries(new URL(url, 'http://isolated.test').searchParams);
      asked.push(q);
      return { suggestion: q.name === 'K4 calibration' ? suggestion : null };
    }
    if (url === '/api/jobs' && body) return { ...job, ...body, id: 'job-one', status: 'queued' };
    return page([]);
  };
  const posted = p => p.calls.filter(c => c.url === '/api/jobs' && c.body).map(c => c.body.resources);
  // The submit form's own fields, wherever else a CPU quota is named.
  const limit = (p, text) => [...p.doc.querySelectorAll('.job-form label')].find(l => l.textContent.startsWith(text))?.querySelector('input');
  async function set(p, text, value) {
    const el = limit(p, text);
    assert.ok(el, `Missing ${text} field in the form`);
    Object.getOwnPropertyDescriptor(p.window.HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    await wait();
  }
  let p = mount(handler);
  try {
    await open(p); button(p, 'New job').click(); await wait();
    await fill(p, 'Name', 'first of its kind'); await fill(p, 'Existing task', 'T-38'); await fill(p, 'Command', 'python3 calib.py');
    for (let n = 0; n < 40 && !asked.some(q => q.name === 'first of its kind'); n++) await wait();
    assert.ok(asked.some(q => q.name === 'first of its kind'), 'the form asks what earlier runs suggest');
    await wait();
    assert.ok(!p.doc.querySelector('.job-suggestion'), 'no history, no suggestion');
    await fill(p, 'Name', 'K4 calibration');
    await until(() => p.doc.querySelector('.job-suggestion'));
    assert.deepEqual(asked.at(-1), { taskId: 'T-38', name: 'K4 calibration', argv: JSON.stringify(['/bin/sh', '-c', 'python3 calib.py']) });
    assert.equal(p.doc.querySelector('.job-suggestion p').textContent,
      'The last measured run of this name or command in this task peaked at 2.6 GiB RAM and 1.20 CPU cores. Suggested: 4.0 GiB RAM and 1.8 CPU (peak × 1.5, rounded up). Your limits stay as you set them.');
    // Shown, never applied: what is in the fields is sent.
    await set(p, 'RAM limit', '20480'); await set(p, 'CPU quota', '4');
    assert.ok(p.doc.querySelector('.job-suggestion'), 'still shown');
    button(p, 'Submit job').click(); await until(() => posted(p).length === 1);
    assert.deepEqual(posted(p), [{ cpuMillis: 4000, memoryMiB: 20480, swapMiB: 0 }]);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
  // Asked to use it, the fields take it, and that is sent.
  p = mount(handler);
  try {
    await open(p); button(p, 'New job').click(); await wait();
    await fill(p, 'Name', 'K4 calibration'); await fill(p, 'Existing task', 'T-38'); await fill(p, 'Command', 'python3 calib.py');
    await set(p, 'RAM limit', '20480'); await set(p, 'CPU quota', '4');
    await until(() => button(p, 'Use suggestion'));
    button(p, 'Use suggestion').click(); await wait();
    assert.deepEqual([limit(p, 'RAM limit').value, limit(p, 'CPU quota').value], ['4096', '1.8']);
    button(p, 'Submit job').click(); await until(() => posted(p).length === 1);
    assert.deepEqual(posted(p), [{ cpuMillis: 1800, memoryMiB: 4096, swapMiB: 0 }]);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('the suggestion for the last draft goes as soon as the name changes, and the new one comes with its answer (T-38 C)', async () => {
  const byName = {
    'K4 calibration': { memoryMiB: 4096, cpuMillis: 1800, memoryPeakMiB: 2662, averageCpuCores: 1.2, basedOn: [{ jobId: 'k4' }] },
    'K5 calibration': { memoryMiB: 8192, cpuMillis: 3000, memoryPeakMiB: 5000, averageCpuCores: 2.0, basedOn: [{ jobId: 'k5' }] },
  };
  const p = mount(url => {
    if (url.startsWith('/api/jobs/suggestion?')) {
      const q = Object.fromEntries(new URL(url, 'http://isolated.test').searchParams);
      return { suggestion: byName[q.name] ?? null };
    }
    return page([]);
  });
  try {
    await open(p); button(p, 'New job').click(); await wait();
    await fill(p, 'Name', 'K4 calibration'); await fill(p, 'Existing task', 'T-38'); await fill(p, 'Command', 'python3 calib.py');
    await until(() => p.doc.querySelector('.job-suggestion'));
    assert.match(p.doc.querySelector('.job-suggestion p').textContent, /Suggested: 4\.0 GiB RAM and 1\.8 CPU/);
    // Another name: the last draft's note and its button go at once, before the next answer.
    await fill(p, 'Name', 'K5 calibration');
    assert.ok(!p.doc.querySelector('.job-suggestion'), 'the note for the last draft goes at once');
    assert.ok(!button(p, 'Use suggestion'), 'nothing from the last draft can be used');
    await until(() => p.doc.querySelector('.job-suggestion'));
    assert.match(p.doc.querySelector('.job-suggestion p').textContent, /Suggested: 8\.0 GiB RAM and 3\.0 CPU/);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('T-56 the form asks what earlier runs suggest for a task named by a Project task key, and for no lowercase or malformed one', async () => {
  const asked = [];
  const p = mount(url => {
    if (url.startsWith('/api/jobs/suggestion?')) {
      asked.push(Object.fromEntries(new URL(url, 'http://isolated.test').searchParams).taskId);
      return { suggestion: null };
    }
    return page([]);
  });
  try {
    await open(p); button(p, 'New job').click(); await wait();
    await fill(p, 'Name', 'K4 calibration'); await fill(p, 'Command', 'python3 calib.py');
    // Each stays past the 300 ms the form waits before it asks.
    for (const typed of ['yn-3', 'YN3', 'Y-3']) {
      await fill(p, 'Existing task', typed);
      await new Promise(r => setTimeout(r, 600));
    }
    await fill(p, 'Existing task', 'YN-3');
    // Bounded: a form that never asks fails at the assertion below, in its words.
    for (let n = 0; n < 100 && !asked.length; n++) await wait();
    // Asked in order: one asked for any of those would be ahead of this one.
    assert.deepEqual(asked, ['YN-3'], 'a Project task key is asked about, and nothing before it');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('known rejection permits editing and a completed job only reruns after a new explicit submit', async () => {
  const finished = { ...job, status: 'succeeded', reserved: false, finishedAt: new Date().toISOString() };
  const p = mount((url, body) => body && url === '/api/jobs' ? { httpStatus: 400, error: 'Never fits budget' } : url === '/api/jobs/job-one' ? finished : page([finished]));
  try {
    await until(() => p.doc.querySelector('.conversation-job')); p.doc.querySelector('.conversation-job').click();
    await until(() => button(p, 'Run again…')); button(p, 'Run again…').click(); await wait();
    assert.equal(p.calls.some(c => c.url === '/api/jobs' && c.body), false);
    button(p, 'Submit job').click(); await until(() => p.doc.querySelector('[role="alert"]'));
    assert.match(p.doc.querySelector('[role="alert"]').textContent, /Never fits/);
    await fill(p, 'RAM limit', '64'); button(p, 'Submit job').click();
    await until(() => p.calls.filter(c => c.url === '/api/jobs' && c.body).length === 2);
    const posts = p.calls.filter(c => c.url === '/api/jobs' && c.body);
    assert.notEqual(posts[0].body.requestId, posts[1].body.requestId);
    assert.equal(posts[0].body.exclusive, undefined);
  } finally { p.close(); }
});

test('Agent switch clears previous cards and in-flight UI state without reacting to ordinary render churn', async () => {
  const p = mount(url => page(url.includes('agentId=b') ? [] : [job]));
  try {
    await until(() => p.doc.querySelector('.conversation-job'));
    const count = p.calls.length;
    for (let i = 0; i < 20; i++) p.window.renderJobs({ ...props, agent: { ...agent, status: 'working', lastMessage: String(i) } });
    await wait(); assert.equal(p.calls.length, count);
    p.window.renderJobs({ ...props, agent: { ...agent, id: 'b', name: 'Hana' } });
    await until(() => p.calls.some(c => c.url.includes('agentId=b'))); await wait();
    assert.equal(!!p.doc.querySelector('.conversation-job'), false);
    assert.equal(!!p.doc.querySelector('[role="dialog"]'), false);
  } finally { p.close(); }
});


test('workspace entry exists without a selected Agent, task scope shares the panel, and counts use complete machine totals', async () => {
  const p=mount(url=>page([job]));
  try {
    p.window.renderJobs({...props,agent:null,agents:[]});
    await open(p);
    await until(()=>p.calls.some(c=>c.url==='/api/jobs?'));
    assert.equal(button(p,'New job').disabled,true);
    assert.equal(p.doc.querySelector('[aria-label="1 active jobs, 1 queued jobs"]').textContent,'1 / 1');
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job',{detail:{taskId:'T-47'}}));
    await until(()=>p.calls.some(c=>c.url==='/api/jobs?taskId=T-47'));
    assert.equal(p.doc.querySelector('.job-task-scope').textContent,'Task T-47');
    assert.equal(p.doc.querySelectorAll('[role="dialog"]').length,1);
    button(p,'Workspace').click();await wait();
    assert.equal(!!p.doc.querySelector('.job-task-scope'),false);
  } finally {p.close();}
});

test('Actions share the Jobs shell, preserve old SHA and show paged jobs without local controls', async () => {
  const detail = number => ({run:ciRun,error:null,details:{jobs:[{id:number,name:number===1?'Build passed':'Optional skipped',status:number===1?'passed':'skipped',url:'https://github.com/o/r/actions/runs/42/job/'+number,steps:[{number:1,name:'Compile',status:'completed',conclusion:'success'}]}],page:number,hasMore:number===1,nextPage:number===1?2:null,observedAt:ciRun.observedAt}});
  const p=mount(url=>url.startsWith('/api/ci/')?detail(url.endsWith('page=2')?2:1):url.startsWith('/api/ci?')?ciPage:page([]));
  try {
    await open(p);button(p,'GitHub Actions').click();
    await until(()=>p.doc.querySelector('.ci-jobs .job-row'));
    assert.equal(p.doc.querySelectorAll('[role="dialog"]').length,1);
    assert.equal(!!p.doc.querySelector('.jobs-budget'),false);
    assert.equal(!!button(p,'New job'),false);
    p.doc.querySelector('.ci-jobs .job-row').click();
    await until(()=>p.doc.querySelector('.ci-child-job'));
    assert.match(p.doc.querySelector('.ci-jobs .job-detail').textContent,/Older PR commit/);
    assert.match(p.doc.querySelector('.ci-jobs .job-detail').textContent,/a{40}/);
    assert.equal(!!button(p,'Run again…'),false);assert.equal(!!button(p,'Cancel'),false);
    button(p,'More jobs').click();await until(()=>p.doc.querySelectorAll('.ci-child-job').length===2);
    assert.match(p.doc.querySelector('.ci-jobs').textContent,/Optional skipped/);
    assert.equal(p.calls.some(c=>/\/jobs\/github/.test(c.url)),false);
    p.window.renderJobs({...props,revision:'2'});await wait();
    assert.equal(p.doc.querySelectorAll('.ci-child-job').length,2);
  }finally{p.close();}
});

test('explicit CI subscription pins commit, retries same request and stops without cancelling a run',async()=>{
  let count=0;
  const p=mount((url,body)=>{
    if(url==='/api/ci' && body){count++;if(count===1)throw new Error('Response lost');return ciSub;}
    return url.startsWith('/api/ci?')?ciPage:page([]);
  });
  try{
    await open(p);
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job',{detail:{taskId:'T-47',source:'github_actions',url:'https://github.com/o/r/pull/7',expectedSha:'a'.repeat(40)}}));
    await until(()=>button(p,'Subscribe to CI'));
    button(p,'Subscribe to CI').click();await until(()=>p.doc.querySelector('.ci-jobs [role="alert"]'));
    button(p,'Subscribe to CI').click();await until(()=>count===2);await until(()=>button(p,'Watch CI'));
    const sends=p.calls.filter(c=>c.url==='/api/ci'&&c.body);assert.equal(sends[0].body.requestId,sends[1].body.requestId);assert.equal(sends[0].body.expectedSha,'a'.repeat(40));assert.equal(sends[0].body.agentId,'a');
    // A PR URL sends no commit-watch target (Core refuses one there).
    assert.equal('branch' in sends[0].body || 'event' in sends[0].body,false);
    button(p,'Stop watching').click();await until(()=>p.calls.some(c=>c.url==='/api/ci/subscriptions/sub/stop'));
    assert.equal(p.calls.some(c=>/\/cancel|\/rerun|\/dispatch/.test(c.url)),false);
  }finally{p.close();}
});

const commitUrl = 'https://github.com/o/r/commit/'+'a'.repeat(40);
const commitSub = { ...ciSub, id:'commit-sub', watch:{kind:'commit',number:0,url:commitUrl,expectedSha:'a'.repeat(40),currentHeadSha:'a'.repeat(40),branch:'main',event:'push',state:'waiting_for_run',observedAt:'2026-10-15T01:00:00Z',error:null} };
test('a commit watch names its exact target, says it waits for a run, and its form sends branch and event',async()=>{
  const p=mount((url,body)=>{
    if(url==='/api/ci' && body)return commitSub;
    return url.startsWith('/api/ci?')?{runs:[],subscriptions:[commitSub],hasMore:false,nextBefore:null}:page([]);
  });
  try{
    await open(p);
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job',{detail:{taskId:'T-47',source:'github_actions',url:commitUrl,expectedSha:'a'.repeat(40)}}));
    await until(()=>button(p,'Subscribe to CI'));
    // The target is not guessed: both fields start empty and are required.
    assert.equal(field(p,'Branch of its runs').value,'');assert.equal(field(p,'Event of its runs').required,true);
    await fill(p,'Branch of its runs','main');await fill(p,'Event of its runs','push');
    button(p,'Subscribe to CI').click();await until(()=>p.calls.some(c=>c.url==='/api/ci'&&c.body));
    const sent=p.calls.find(c=>c.url==='/api/ci'&&c.body).body;
    assert.equal(sent.url,commitUrl);assert.equal(sent.branch,'main');assert.equal(sent.event,'push');assert.equal(sent.expectedSha,'a'.repeat(40));
    await until(()=>p.doc.querySelector('.ci-subscription'));
    const row=p.doc.querySelector('.ci-subscription');
    assert.match(row.textContent,/Commit aaaaaaaa · main · push/);
    assert.match(row.textContent,/Waiting for a run of aaaaaaaa/);
    assert.equal(row.querySelector('a').getAttribute('href'),commitUrl);
  }finally{p.close();}
});

test('CI detail read failure retains the last observed run and does not invent a terminal failure',async()=>{
  const p=mount(url=>url.startsWith('/api/ci/')?{run:ciRun,error:'rate_limited: retry later',details:null}:url.startsWith('/api/ci?')?ciPage:page([]));
  try{
    await open(p);button(p,'GitHub Actions').click();await until(()=>p.doc.querySelector('.ci-jobs .job-row'));p.doc.querySelector('.ci-jobs .job-row').click();
    await until(()=>p.doc.querySelector('.ci-jobs [role="alert"]'));
    assert.match(p.doc.querySelector('.ci-jobs .job-detail').textContent,/Passed/);
    assert.match(p.doc.querySelector('.ci-jobs [role="alert"]').textContent,/rate_limited/);
    assert.equal(p.calls.some(c=>c.body && c.url.includes('/peer_read')),false);
  }finally{p.close();}
});

const ciRunning = (observedAt, step) => ({run:{...ciRun,status:'running',rawStatus:'in_progress',conclusion:null,observedAt},error:null,details:{jobs:[{id:1,name:'Build',status:'running',url:'https://github.com/o/r/actions/runs/42/job/1',steps:[{number:1,name:'Compile',status:step,conclusion:step==='completed'?'success':null}]}],page:1,hasMore:false,nextPage:null,observedAt}});
const refreshButton = p => p.doc.querySelector('button[aria-label="Check CI with GitHub now"]');
const checkLine = p => p.doc.querySelector('.ci-check')?.textContent || '';
function hide(p, hidden) {
  Object.defineProperty(p.doc, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(p.doc, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  p.doc.dispatchEvent(new p.window.Event('visibilitychange'));
}

test('manual CI refresh asks GitHub through Core once, shows it is busy, then the check and the new steps',async()=>{
  const before=ciRunning('2026-10-15T01:00:00Z','in_progress'),after=ciRunning('2026-10-15T01:05:00Z','completed');
  let listed=before.run,release;const held=new Promise(r=>{release=r;});
  const p=mount(async(url,body)=>{
    if(url==='/api/ci/refresh'&&body){await held;listed=after.run;return {status:'checked',checkedAt:after.run.observedAt,retryAt:null,error:null,paused:0,more:0,runWatched:true,run:after.run,details:[after.details]};}
    if(url.startsWith('/api/ci/'))return before;
    return url.startsWith('/api/ci?')?{...ciPage,runs:[listed]}:page([]);
  });
  const reads=()=>p.calls.filter(c=>c.url.startsWith('/api/ci/github')).length;
  try{
    await open(p);button(p,'GitHub Actions').click();await until(()=>p.doc.querySelector('.ci-jobs .job-row'));p.doc.querySelector('.ci-jobs .job-row').click();
    await until(()=>p.doc.querySelector('.ci-child-job li .ci-step-state')?.textContent==='in_progress');
    refreshButton(p).click();await until(()=>checkLine(p).includes('Checking with GitHub'));
    assert.equal(refreshButton(p).disabled,true);assert.equal(refreshButton(p).getAttribute('aria-busy'),'true');
    refreshButton(p).click();await wait();
    const asks=p.calls.filter(c=>c.url==='/api/ci/refresh');
    assert.equal(asks.length,1);assert.equal(asks[0].body.runKey,ciRun.id);assert.equal(asks[0].body.pages,1);
    // The old steps stay on screen while GitHub is asked.
    assert.equal(p.doc.querySelector('.ci-child-job li .ci-step-state').textContent,'in_progress');
    const listsBefore=p.calls.filter(c=>c.url.startsWith('/api/ci?')).length;
    release();
    await until(()=>checkLine(p).startsWith('Checked with GitHub at'));
    await until(()=>p.doc.querySelector('.ci-child-job li .ci-step-state')?.textContent==='success');
    await until(()=>p.calls.filter(c=>c.url.startsWith('/api/ci?')).length>listsBefore);await wait();
    assert.equal(refreshButton(p).disabled,false);
    // Its steps came with the check: no second read of the same observation.
    assert.equal(reads(),1);
    assert.equal(p.doc.querySelector('.ci-jobs-observed').textContent.includes('predates'),false);
    assert.equal(p.calls.some(c=>/\/cancel|\/rerun|\/dispatch|\/subscriptions/.test(c.url)||(c.url==='/api/ci'&&c.body)),false);
  }finally{release();p.close();}
});

test('a failed, rate-limited or empty CI check keeps the last observation and says why',async()=>{
  const before=ciRunning('2026-10-15T01:00:00Z','in_progress');
  const answers=[{httpStatus:400,error:'busy: CI reads are busy; retry shortly'},{status:'cooldown',checkedAt:null,retryAt:'2026-10-15T02:00:00Z',error:'rate_limited: GitHub rate limit reached; retry later',paused:1,more:0,runWatched:true,run:null,details:null},{status:'nothing',checkedAt:null,retryAt:null,error:null,paused:0,more:0,runWatched:false,run:null,details:null}];
  const p=mount((url,body)=>{
    if(url==='/api/ci/refresh'&&body)return answers.shift();
    if(url.startsWith('/api/ci/'))return before;
    return url.startsWith('/api/ci?')?{...ciPage,runs:[before.run],cooldownUntil:'2026-10-15T01:30:00Z'}:page([]);
  });
  try{
    await open(p);button(p,'GitHub Actions').click();await until(()=>p.doc.querySelector('.ci-jobs .job-row'));
    assert.match(checkLine(p),/GitHub is limiting reads until .*last successful observation/);
    p.doc.querySelector('.ci-jobs .job-row').click();await until(()=>p.doc.querySelector('.ci-child-job'));
    refreshButton(p).click();await until(()=>checkLine(p).startsWith("Couldn't check GitHub: busy"));
    assert.match(checkLine(p),/last successful observation/);
    assert.equal(p.doc.querySelector('.ci-child-job li .ci-step-state').textContent,'in_progress');
    assert.match(p.doc.querySelector('.ci-jobs .job-detail').textContent,/Running/);
    refreshButton(p).click();await until(()=>checkLine(p).startsWith('GitHub is limiting reads until'));
    assert.match(checkLine(p),/1 watch paused after repeated failures was not checked; subscribe again to resume/);
    assert.equal(p.doc.querySelector('.ci-child-job li .ci-step-state').textContent,'in_progress');
    refreshButton(p).click();await until(()=>checkLine(p).includes('not being watched'));
    assert.equal(p.calls.filter(c=>c.url==='/api/ci/refresh').length,3);
    assert.equal(p.doc.querySelectorAll('.ci-child-job').length,1);
  }finally{p.close();}
});

test('a CI check that returns after another run was chosen does not replace its steps',async()=>{
  const other={...ciRun,id:'github:123:43:1',runId:'43',name:'Docs',attempt:'1'};
  const running=ciRunning('2026-10-15T01:00:00Z','in_progress');
  let release;const held=new Promise(r=>{release=r;});
  const p=mount(async(url,body)=>{
    if(url==='/api/ci/refresh'&&body){await held;return {status:'checked',checkedAt:'2026-10-15T01:05:00Z',retryAt:null,error:null,paused:0,more:0,runWatched:true,run:ciRunning('2026-10-15T01:05:00Z','completed').run,details:[ciRunning('2026-10-15T01:05:00Z','completed').details]};}
    if(url===`/api/ci/${encodeURIComponent(other.id)}?page=1`)return {run:other,error:null,details:{jobs:[{id:9,name:'Docs build',status:'passed',url:'https://github.com/o/r/actions/runs/43/job/9',steps:[]}],page:1,hasMore:false,nextPage:null,observedAt:other.observedAt}};
    if(url.startsWith('/api/ci/'))return running;
    return url.startsWith('/api/ci?')?{...ciPage,runs:[running.run,other]}:page([]);
  });
  try{
    await open(p);button(p,'GitHub Actions').click();await until(()=>p.doc.querySelectorAll('.ci-jobs .job-row').length===2);
    p.doc.querySelectorAll('.ci-jobs .job-row')[0].click();await until(()=>p.doc.querySelector('.ci-child-job'));
    refreshButton(p).click();await until(()=>checkLine(p).includes('Checking'));
    p.doc.querySelectorAll('.ci-jobs .job-row')[1].click();await until(()=>p.doc.querySelector('.ci-child-job summary')?.textContent.startsWith('Docs build'));
    release();await until(()=>!refreshButton(p).disabled);await wait();
    assert.ok(!checkLine(p).includes('Checked with GitHub'), 'the old selection check is not shown for the new run');
    assert.equal(p.doc.querySelector('.ci-child-job summary').textContent.startsWith('Docs build'),true);
    assert.equal(p.doc.querySelectorAll('.ci-child-job').length,1);
  }finally{release();p.close();}
});

test('open CI details refresh loaded pages on a run transition or a running run\'s new observation, not unrelated revisions or while hidden',async()=>{
  let run={...ciRun,status:'running',rawStatus:'in_progress',conclusion:null},hold=null,release=null;
  const detail=number=>({run,error:null,details:{jobs:[{id:number,name:'Job '+number,status:run.status,url:'https://github.com/o/r/actions/runs/42/job/'+number,steps:[{number:1,name:'Compile',status:run.rawStatus,conclusion:run.conclusion}]}],page:number,hasMore:number===1,nextPage:number===1?2:null,observedAt:run.observedAt}});
  const p=mount(async url=>{
    if(url.startsWith('/api/ci/')){if(hold)await hold;return detail(url.endsWith('page=2')?2:1);}
    return url.startsWith('/api/ci?')?{...ciPage,runs:[run]}:page([]);
  });
  const reads=()=>p.calls.filter(c=>c.url.startsWith('/api/ci/')).length;
  try{
    await open(p);button(p,'GitHub Actions').click();await until(()=>p.doc.querySelector('.ci-jobs .job-row'));p.doc.querySelector('.ci-jobs .job-row').click();
    await until(()=>p.doc.querySelector('.ci-child-job'));button(p,'More jobs').click();await until(()=>p.doc.querySelectorAll('.ci-child-job').length===2);assert.equal(reads(),2);
    // Hidden: a new observation of the running run reads no steps.
    hide(p,true);
    run={...run,observedAt:'2026-10-15T01:01:00Z'};p.window.renderJobs({...props,revision:'2'});
    await until(()=>p.doc.querySelector('.ci-jobs-observed')?.textContent.includes('predates'));await wait();assert.equal(reads(),2);
    // Shown again: one catch-up read of the loaded pages.
    hide(p,false);
    await until(()=>reads()===4);await until(()=>!p.doc.querySelector('.ci-jobs-observed').textContent.includes('predates'));
    hide(p,false);await wait();assert.equal(reads(),4);
    hold=new Promise(r=>{release=r;});run={...ciRun,observedAt:'2026-10-15T01:02:00Z'};p.window.renderJobs({...props,revision:'3'});
    await until(()=>reads()===5);
    // An unrelated revision during the detail request must not discard it.
    p.window.renderJobs({...props,revision:'4'});await wait();release();hold=null;
    await until(()=>[...p.doc.querySelectorAll('.ci-child-job summary')].length===2 && [...p.doc.querySelectorAll('.ci-child-job summary')].every(el=>el.textContent.includes('Passed')));
    assert.equal(reads(),6);assert.equal(!!button(p,'More jobs'),false);
    assert.equal([...p.doc.querySelectorAll('.ci-child-job li .ci-step-state')].every(el=>el.textContent==='success'),true);
    assert.equal(p.doc.querySelector('.ci-jobs-observed').textContent.includes('predates'),false);
    for(let n=5;n<8;n++){p.window.renderJobs({...props,revision:String(n)});await wait();}
    assert.equal(reads(),6);
  }finally{release?.();p.close();}
});

test('terminal detail refresh failure retains paged snapshots and their own observation time',async()=>{
  let terminal=false;
  const run=()=>terminal?{...ciRun,observedAt:'2026-10-15T01:02:00Z'}:{...ciRun,status:'running',rawStatus:'in_progress',conclusion:null};
  const p=mount(url=>{
    if(url.startsWith('/api/ci/')){
      const number=url.endsWith('page=2')?2:1;
      if(terminal&&number===2)return {run:run(),details:null,error:'rate_limited: retry later'};
      return {run:run(),error:null,details:{jobs:[{id:number,name:'Job '+number,status:run().status,url:'https://github.com/o/r/actions/runs/42/job/'+number,steps:[]}],page:number,hasMore:number===1,nextPage:number===1?2:null,observedAt:run().observedAt}};
    }
    return url.startsWith('/api/ci?')?{...ciPage,runs:[run()]}:page([]);
  });
  try{
    await open(p);button(p,'GitHub Actions').click();await until(()=>p.doc.querySelector('.ci-jobs .job-row'));p.doc.querySelector('.ci-jobs .job-row').click();
    await until(()=>p.doc.querySelector('.ci-child-job'));button(p,'More jobs').click();await until(()=>p.doc.querySelectorAll('.ci-child-job').length===2);
    const oldStamp=p.doc.querySelector('.ci-jobs-observed').textContent;
    terminal=true;p.window.renderJobs({...props,revision:'2'});await until(()=>p.doc.querySelector('.ci-jobs [role="alert"]'));
    assert.equal(p.doc.querySelectorAll('.ci-child-job').length,2);
    assert.equal([...p.doc.querySelectorAll('.ci-child-job summary')].every(el=>el.textContent.includes('Running')),true);
    assert.ok(p.doc.querySelector('.ci-jobs-observed').textContent.startsWith(oldStamp));
    assert.match(p.doc.querySelector('.ci-jobs-observed').textContent,/predates/);
    assert.match(p.doc.querySelector('.ci-jobs .job-detail').textContent,/Passed/);
    p.window.renderJobs({...props,revision:'3'});await wait();assert.equal(p.calls.filter(c=>c.url.startsWith('/api/ci/')).length,4);
  }finally{p.close();}
});


test('the machine card puts what jobs use on the bars of what they reserve, and use it cannot read is unknown', async () => {
  // 5% of 8 cores is 0.4 CPU of a 2 CPU budget; 0.5 CPU and 128 MiB are reserved.
  const reading = { at: '2026-10-18T19:00:00Z', cpu: { cores: 8, totalPct: 50, jobsPct: 5, agentsPct: null, otherPct: null },
    memory: { totalMiB: 16384, usedMiB: 8000, availableMiB: 8000, jobsMiB: 64, agentsMiB: null }, gpus: null, jobs: [] };
  const p = mount(url => url === '/api/machine-load' ? reading : page([]));
  try {
    await open(p);
    await until(() => p.doc.querySelector('.jobs-budget .jobs-meter-used'));
    const [cpu, ram] = p.doc.querySelectorAll('.jobs-budget .jobs-meter');
    assert.equal(cpu.querySelector('.jobs-meter-value').textContent, '0.4 in use');
    assert.equal(cpu.querySelector('.jobs-reserved-text').textContent, '0.5 / 2 reserved');
    assert.equal(cpu.querySelector('.jobs-meter-used').style.width, '20%');
    assert.equal(cpu.querySelector('.jobs-meter-reserved').style.width, '25%');
    assert.equal(cpu.querySelector('[role="meter"]').getAttribute('aria-label'), 'CPU: 0.4 in use, 0.5 of 2 reserved');
    assert.equal(ram.querySelector('.jobs-meter-value').textContent, '64 MiB in use');
    assert.equal(ram.querySelector('.jobs-reserved-text').textContent, '128 MiB / 2.0 GiB reserved');
    assert.equal(ram.querySelector('.jobs-meter-used').style.width, '3.125%');
    assert.equal(ram.querySelector('.jobs-meter-reserved').style.width, '6.25%');
    assert.equal(ram.querySelector('.jobs-budget-host').textContent, '2.0 GiB free on the host');
    assert.match(p.doc.querySelector('.jobs-budget-key').title, /bounded result collector/);
    // Hidden, the card stops reading the machine; shown again, it reads at once.
    Object.defineProperty(p.doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
    p.doc.dispatchEvent(new p.window.Event('visibilitychange'));
    await wait();
    const reads = () => p.calls.filter(c => c.url === '/api/machine-load').length;
    const hiddenReads = reads();
    await new Promise(resolve => setTimeout(resolve, 3_300));
    assert.equal(reads(), hiddenReads, 'no reading while hidden');
    Object.defineProperty(p.doc, 'visibilityState', { configurable: true, get: () => 'visible' });
    p.doc.dispatchEvent(new p.window.Event('visibilitychange'));
    await until(() => reads() > hiddenReads);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
  // An older Core, or a failed reading: reservations as before, use unknown and not drawn.
  const q = mount(url => url === '/api/machine-load' ? { httpStatus: 404, error: 'not found' } : page([]));
  try {
    await open(q);
    await until(() => q.doc.querySelector('.jobs-budget .jobs-meter-reserved'));
    await until(() => q.calls.some(c => c.url === '/api/machine-load'));
    await wait();
    const [cpu] = q.doc.querySelectorAll('.jobs-budget .jobs-meter');
    assert.equal(cpu.querySelector('.jobs-meter-value').textContent, 'unknown in use');
    assert.equal(cpu.querySelector('.jobs-reserved-text').textContent, '0.5 / 2 reserved');
    assert.equal(q.doc.querySelector('.jobs-budget .jobs-meter-used'), null);
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

// The machine budget's editor, with its guarantees (the whole host, the default
// apart, collectors, validation errors kept), is in Settings now (T-55):
// jobs-settings-ui.test.mjs; the card itself is read only.

const review = (id, cursor, patch = {}) => ({ id, taskId: 'task-one', taskRef: 'T-1', taskTitle: 'Deliver PR', linkId: '7:pull:1', repository: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', round: 1, status: 'completed', phase: 'completed', conclusion: 'no_findings', requestedHarness: 'codex', requestedModel: 'gpt-6.1-sol', actualHarness: 'codex', actualModel: 'gpt-6.1-sol', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40), createdAt: '2026-10-15T01:00:00Z', finishedAt: '2026-10-15T01:10:00Z', error: null, requestedBy: { kind: 'agent', id: 'a', name: 'Mori' }, findingsCount: 0, outdated: false, cursor, ...patch });
const reviewPage = (reviews, more = null) => ({ reviews, hasMore: more != null, nextBefore: more });

test('Reviews are a read-only Jobs source: scopes, paging, states and the requester identity', async () => {
  const newest = [
    review('changes', 9, { conclusion: 'changes_requested', findingsCount: 2, outdated: true, round: 2 }),
    review('pre-model', 8, { status: 'failed', conclusion: 'unknown', actualHarness: null, actualModel: null, headSha: null, baseSha: null, outdated: null, error: 'Patch is incomplete', requestedBy: { kind: 'user', id: 'user', name: 'You' } }),
    review('lost', 7, { status: 'unknown', conclusion: 'unknown', error: 'Review deadline exceeded; completion is unknown', taskId: 'task-two', taskRef: 'T-2', taskTitle: 'Other PR', number: 8 }),
  ];
  let older = [review('legacy', 3, { requestedBy: null })];
  const p = mount(url => url === '/api/reviews?' ? reviewPage(newest, 4) : url === '/api/reviews?before=4' ? reviewPage(older) : url === '/api/reviews?agentId=a' ? reviewPage([newest[0]]) : page([]));
  try {
    await open(p); button(p, 'Reviews').click();
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 3);
    const rows = [...p.doc.querySelectorAll('.review-jobs .job-row')].map(r => r.textContent);
    assert.match(rows[0], /Changes requested · Outdated/); assert.match(rows[0], /o\/r#7 · Round 2/); assert.match(rows[0], /Requested by Mori/);
    // Each row: its name and time, its state and task, then who reviewed it.
    const part = (n, name) => p.doc.querySelectorAll('.review-jobs .job-row')[n].querySelector(name).textContent;
    assert.match(part(0, '.job-row-note'), /^Codex · gpt-6\.1-sol · head bbbbbbb · Requested by Mori$/); assert.equal(part(0, '.job-row-time'), '10m 0s');
    assert.match(part(1, '.job-state'), /^Failed$/); assert.match(rows[1], /Requested by you/);
    assert.match(part(1, '.job-row-note'), /^Codex · gpt-6\.1-sol \(requested\) · Requested by you$/); assert.equal(part(1, '.job-row-time'), '10m 0s'); assert.doesNotMatch(rows[1], /head/);
    assert.match(rows[2], /Outcome unknown/); assert.match(rows[2], /T-2 · Other PR/);
    assert.equal(!!p.doc.querySelector('.jobs-budget'), false);
    for (const label of ['New job', 'Review PR', 'Cancel review', 'Run again…']) assert.equal(!!button(p, label), false, label);
    p.doc.querySelectorAll('.review-jobs .job-row')[1].click(); await wait();
    const detail = () => p.doc.querySelector('.review-jobs .job-detail').textContent;
    assert.match(detail(), /Model not confirmed/); assert.match(detail(), /Patch is incomplete/); assert.doesNotMatch(detail(), /Findings\d/);
    p.doc.querySelectorAll('.review-jobs .job-row')[2].click(); await wait();
    assert.match(detail(), /Unknown is not a passing review/);
    p.doc.querySelectorAll('.review-jobs .job-row')[0].click(); await wait();
    assert.match(detail(), /Outdated · the PR's base or head changed/); assert.match(detail(), /Findings2/);
    button(p, 'Earlier reviews').click();
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 4);
    assert.match(p.doc.querySelectorAll('.review-jobs .job-row')[3].textContent, /Requester unknown \(older record\)/);
    assert.equal(!!button(p, 'Earlier reviews'), false);
    // A Jobs refresh re-reads the older page that was loaded too: its PR
    // changed, and the retained row and its detail must say so.
    p.doc.querySelectorAll('.review-jobs .job-row')[3].click(); await wait();
    assert.doesNotMatch(detail(), /Outdated/);
    older = [review('legacy', 3, { requestedBy: null, outdated: true })];
    p.window.renderJobs({ ...props, revision: '2' });
    await until(() => p.calls.filter(c => c.url === '/api/reviews?before=4').length === 2);
    await until(() => /Outdated/.test(p.doc.querySelectorAll('.review-jobs .job-row')[3]?.textContent || ''));
    assert.match(detail(), /Outdated · the PR's base or head changed/);
    assert.equal(p.doc.querySelectorAll('.review-jobs .job-row').length, 4);
    assert.equal(!!button(p, 'Earlier reviews'), false);
    assert.equal(p.calls.filter(c => c.url === '/api/reviews?').length, 2);
    button(p, 'Mori').click();
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 1);
    assert.match(p.doc.querySelector('.review-jobs').textContent, /Showing reviews Mori requested itself/);
    assert.equal(p.calls.some(c => c.url.startsWith('/api/reviews') && c.body), false);
    assert.equal(p.calls.some(c => c.url.includes('/api/pr-reviews')), false);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Opening a review report closes Jobs and names its task and review; nothing is started', async () => {
  const p = mount(url => url.startsWith('/api/reviews?') ? reviewPage([review('one', 2)]) : page([]));
  const opened = [];
  p.window.addEventListener('yuzuno:open-task-review', e => opened.push(e.detail));
  try {
    await open(p); button(p, 'Reviews').click();
    await until(() => p.doc.querySelector('.review-jobs .job-row'));
    p.doc.querySelector('.review-jobs .job-row').click(); await wait();
    button(p, 'Open full report in T-1').click();
    await until(() => !p.doc.querySelector('[role="dialog"]'));
    assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ taskId: 'T-1', reviewId: 'one' }]);
    assert.equal(p.calls.some(c => c.body), false);
  } finally { p.close(); }
});

test('A link to an old review reads it directly; late, hidden and failed reads stay bounded', async () => {
  let releaseWorkspace;
  const slow = new Promise(r => { releaseWorkspace = r; });
  let fail = false;
  const p = mount(url => {
    if (url === '/api/reviews?taskId=task-one&reviewId=old') return reviewPage([review('old', 1, { status: 'cancelled', conclusion: 'unknown' })]);
    if (url === '/api/reviews?taskId=task-one') return reviewPage([review('new', 30)], 30);
    if (url === '/api/reviews?') return slow;
    if (url === '/api/reviews?agentId=a') return fail ? { httpStatus: 503, error: 'Core is restarting' } : reviewPage([]);
    return page([]);
  });
  try {
    await until(() => p.doc.querySelector('[aria-label="Jobs"]'));
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job', { detail: { source: 'reviews', taskId: 'task-one', reviewId: 'old' } }));
    await until(() => p.doc.querySelector('.review-jobs .job-detail h3'));
    assert.match(p.doc.querySelector('.review-jobs .job-detail').textContent, /Cancelled/);
    assert.equal(p.doc.querySelector('.job-task-scope').textContent, 'Task task-one');
    assert.equal(p.calls.filter(c => c.url.startsWith('/api/reviews?taskId=task-one&before')).length, 0, 'no paging to find it');
    // A slow Workspace read finishing after the scope moved on is dropped.
    button(p, 'Workspace').click(); await wait();
    // The link belonged to its task's scope; another scope starts unselected.
    assert.match(p.doc.querySelector('.review-jobs .job-detail').textContent, /Select a review/);
    button(p, 'Mori').click();
    await until(() => p.doc.querySelector('.review-jobs .jobs-empty')?.textContent.startsWith('No reviews requested by Mori'));
    assert.match(p.doc.querySelector('.review-jobs .job-detail').textContent, /Select a review/);
    assert.equal(p.calls.filter(c => c.url.includes('reviewId=old')).length, 1);
    releaseWorkspace(reviewPage([review('stale-workspace', 99)])); await wait(); await wait();
    assert.doesNotMatch(p.doc.body.textContent, /stale-workspace/);
    // Hidden: Jobs changes wait until the window is visible again, then read once.
    Object.defineProperty(p.doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const before = p.calls.filter(c => c.url === '/api/reviews?agentId=a').length;
    p.window.renderJobs({ ...props, revision: '7' }); await wait();
    assert.equal(p.calls.filter(c => c.url === '/api/reviews?agentId=a').length, before);
    fail = true;
    Object.defineProperty(p.doc, 'visibilityState', { configurable: true, get: () => 'visible' });
    p.doc.dispatchEvent(new p.window.Event('visibilitychange'));
    await until(() => p.doc.querySelector('.review-jobs [role="alert"]'));
    assert.equal(p.calls.filter(c => c.url === '/api/reviews?agentId=a').length, before + 1);
    assert.match(p.doc.querySelector('.review-jobs [role="alert"]').textContent, /Core is restarting/);
    fail = false;
    p.doc.querySelector('[aria-label="Refresh reviews"]').click();
    await until(() => !p.doc.querySelector('.review-jobs [role="alert"]'));
    assert.equal(p.calls.some(c => c.body), false);
  } finally { p.close(); }
});

test('A linked review outside the newest page refreshes with Jobs, and Refresh retries a failed read', async () => {
  let state = 'fail';
  const p = mount(url => {
    if (url === '/api/reviews?taskId=task-one&reviewId=old') {
      if (state === 'fail') return { httpStatus: 503, error: 'Core is restarting' };
      return reviewPage([review('old', 1, state === 'running'
        ? { status: 'running', phase: 'Reviewing full PR', conclusion: 'unknown', finishedAt: null }
        : { conclusion: 'changes_requested', findingsCount: 3, outdated: true })]);
    }
    if (url === '/api/reviews?taskId=task-one') return reviewPage([review('new', 30)], 30);
    return page([]);
  });
  const linkedReads = () => p.calls.filter(c => c.url === '/api/reviews?taskId=task-one&reviewId=old').length;
  const detail = () => p.doc.querySelector('.review-jobs .job-detail').textContent;
  try {
    await until(() => p.doc.querySelector('[aria-label="Jobs"]'));
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job', { detail: { source: 'reviews', taskId: 'task-one', reviewId: 'old' } }));
    await until(() => p.doc.querySelector('.review-jobs .job-detail [role="alert"]'));
    assert.match(detail(), /Core is restarting/);
    state = 'running';
    p.doc.querySelector('[aria-label="Refresh reviews"]').click();
    await until(() => p.doc.querySelector('.review-jobs .job-detail h3'));
    assert.match(detail(), /Reviewing · Reviewing full PR/);
    assert.equal(!!p.doc.querySelector('.review-jobs .job-detail [role="alert"]'), false);
    state = 'done';
    p.window.renderJobs({ ...props, revision: '9' });
    await until(() => /Changes requested/.test(detail()));
    assert.match(detail(), /Outdated · the PR's base or head changed/);
    assert.match(detail(), /Findings3/);
    assert.equal(linkedReads(), 3);
    // Once another review is chosen, the link is no longer re-read.
    p.doc.querySelector('.review-jobs .job-row').click(); await wait();
    const lists = p.calls.filter(c => c.url === '/api/reviews?taskId=task-one').length;
    p.window.renderJobs({ ...props, revision: '10' });
    await until(() => p.calls.filter(c => c.url === '/api/reviews?taskId=task-one').length === lists + 1);
    await wait();
    assert.equal(linkedReads(), 3);
    assert.equal(p.calls.some(c => c.body), false);
  } finally { p.close(); }
});

test('A refresh re-reads at most ten loaded pages and drops older rows instead of keeping them stale', async () => {
  const all = Array.from({ length: 300 }, (_, i) => review(`r${300 - i}`, 300 - i));
  const p = mount(url => {
    if (!url.startsWith('/api/reviews?')) return page([]);
    const before = Number(new URL(url, 'http://x').searchParams.get('before')) || Infinity;
    const rows = all.filter(r => r.cursor < before).slice(0, 20);
    const more = all.some(r => r.cursor < rows.at(-1).cursor);
    return reviewPage(rows, more ? rows.at(-1).cursor : null);
  });
  // The Reviews list's own reads; the conversation dock reads its reviews apart (T-25).
  const lists = () => p.calls.filter(c => c.url.startsWith('/api/reviews?') && !c.url.includes('involving=')).length;
  try {
    await open(p); button(p, 'Reviews').click();
    // Finished reviews fold after ten; earlier pages come once all show.
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 10);
    assert.equal(!!button(p, 'Earlier reviews'), false);
    button(p, 'Show 10 more').click();
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 20);
    for (let n = 2; n <= 12; n++) {
      button(p, 'Earlier reviews').click();
      await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === n * 20);
    }
    const before = lists();
    p.window.renderJobs({ ...props, revision: '5' });
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 200);
    await wait();
    assert.equal(lists() - before, 10);
    assert.ok(button(p, 'Earlier reviews'), 'older reviews can be loaded again');
  } finally { p.close(); }
});
test('each kind keeps to its own limit from Settings, and 0 leaves its group off the conversation dock', async () => {
  const running = n => ({ ...ciRun, id: `github:123:4${n}:1`, runId: `4${n}`, attempt: '1', name: `CI ${n}`, status: 'running', rawStatus: 'in_progress', conclusion: null });
  const finished = n => ({ ...job, id: `job-done-${n}`, name: `done ${n}`, status: 'succeeded', reserved: false, finishedAt: new Date(Date.now() - n * 60_000).toISOString() });
  const answer = url => url.startsWith('/api/ci') ? { runs: [1, 2, 3, 4, 5].map(running), subscriptions: [], hasMore: false, nextBefore: null } : page([3, 1, 2].map(finished));
  const group = (p, label) => p.doc.querySelector(`.work-dock [role="group"][aria-label="${label}"]`);
  const marks = (p, label) => [...(group(p, label)?.querySelectorAll('.conversation-job .work-dock-label strong') || [])].map(s => s.textContent);
  const more = (p, label) => group(p, label)?.querySelector('.work-dock-more')?.getAttribute('aria-label');
  const limits = dock => ({ 'yuzuno.appearance': JSON.stringify({ dock }) });
  // Unchanged: up to five local jobs, the latest finished first, and two runs.
  let p = mount(answer);
  try {
    await until(() => marks(p, 'Local jobs').length === 3 && marks(p, 'GitHub Actions').length === 2);
    assert.deepEqual(marks(p, 'Local jobs'), ['done 1', 'done 2', 'done 3']);
    assert.equal(more(p, 'Local jobs'), undefined);
    assert.equal(more(p, 'GitHub Actions'), 'GitHub Actions: 3 more, open the list');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
  p = mount(answer, limits({ jobs: 1, actions: 0, subAgents: 5 }));
  try {
    await until(() => marks(p, 'Local jobs').length === 1 && p.calls.some(c => c.url.startsWith('/api/ci?')));
    await wait();
    assert.deepEqual(marks(p, 'Local jobs'), ['done 1']);
    assert.equal(more(p, 'Local jobs'), 'Local jobs: 2 more, open the list');
    assert.equal(group(p, 'GitHub Actions'), null, 'no runs, no notice and no more link');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
  p = mount(answer, limits({ jobs: 0, actions: 3, subAgents: 5 }));
  try {
    await until(() => marks(p, 'GitHub Actions').length === 3);
    assert.equal(group(p, 'Local jobs'), null);
    assert.equal(more(p, 'GitHub Actions'), 'GitHub Actions: 2 more, open the list');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('the dock keeps its marks while a refresh or a return to the conversation is still loading, so the conversation keeps its place', async () => {
  // A conversation whose dock holds only CI marks: every refresh reads CI
  // again, and the dock must not empty out while that read is out.
  let release = () => {};
  let hold = false;
  const p = mount(async url => {
    if (url.startsWith('/api/ci?')) {
      if (hold) await new Promise(r => { release = r; });
      return url.includes('agentId=b') ? { runs: [], subscriptions: [], hasMore: false, nextBefore: null } : ciPage;
    }
    return page([]);
  });
  const marks = () => p.doc.querySelectorAll('.work-dock .conversation-job').length;
  try {
    await until(() => marks() === 1);
    hold = true;
    p.window.renderJobs({ ...props, revision: '2' });
    await until(() => p.calls.filter(c => c.url.startsWith('/api/ci?')).length === 2);
    await wait();
    assert.equal(marks(), 1, 'a refresh in flight keeps the CI mark');
    release(); await wait();
    // Away to another conversation and back: the last answer shows at once.
    hold = false;
    p.window.renderJobs({ ...props, agent: { ...agent, id: 'b', name: 'Hana' } });
    await until(() => p.calls.some(c => c.url.includes('/api/ci?agentId=b'))); await wait();
    assert.equal(marks(), 0);
    hold = true;
    p.window.renderJobs({ ...props, revision: '3' });
    await wait();
    assert.equal(marks(), 1, 'coming back shows the last marks before the new read answers');
    release(); await wait();
    assert.deepEqual(p.errors, []);
  } finally { release(); p.close(); }
});

test("a review's reasons follow a language change in Jobs too; one this version doesn't know keeps its code (T-189)", async () => {
  const p = mount(url => url.startsWith('/api/reviews?') ? reviewPage([review('why', 2, { conclusion: 'unknown', reasonCodes: ['coverage_incomplete', 'brand_new_reason'] })]) : page([]));
  try {
    await open(p); button(p, 'Reviews').click();
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 1);
    p.doc.querySelector('.review-jobs .job-row').click(); await wait();
    const reasons = label => [...p.doc.querySelectorAll(`.review-jobs .job-detail [aria-label="${label}"] li`)].map(li => li.textContent);
    assert.deepEqual(reasons('Review reasons'), ['Review coverage is incomplete', 'Unrecognized review reason: brand_new_reason']);
    p.window.localStorage.setItem('yuzuno.language', JSON.stringify({ language: 'zh-Hans' }));
    p.window.dispatchEvent(new p.window.StorageEvent('storage', { key: 'yuzuno.language' })); await wait();
    assert.deepEqual(reasons('审查原因'), ['审查覆盖不完整', '无法识别的审查原因：brand_new_reason']);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

// T-19 F1: before Core answers, a list or a chosen job or run says it is being
// read. On main it said there were none, or that nothing was chosen.
const texts = (p, selector) => [...p.doc.querySelectorAll(selector)].map(el => el.textContent);
function held() { let answer; const promise = new Promise(r => { answer = r; }); return { promise, answer }; }

test('the job list reads as being read until Core first answers, and only then as empty (T-19 JB-04)', async () => {
  const list = held();
  const p = mount(async url => url.startsWith('/api/jobs?') ? (await list.promise, page([])) : page([]));
  try {
    await open(p);
    await until(() => p.doc.querySelector('.jobs-browser .jobs-empty'));
    await wait();
    assert.equal(texts(p, '.jobs-browser .jobs-empty').includes('No jobs yet.'), false, 'not "none" before the answer');
    assert.equal(texts(p, '.jobs-browser .jobs-empty').includes('Reading jobs…'), true);
    list.answer();
    await until(() => texts(p, '.jobs-browser .jobs-empty').includes('No jobs yet.'));
    assert.equal(texts(p, '.jobs-browser .jobs-empty').includes('Reading jobs…'), false);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a chosen job reads as being read until its answer comes; a narrow window brings it into view, at once under reduced motion (T-19 JB-07)', async () => {
  for (const reduced of [false, true]) {
    const detail = held();
    const p = mount(async url => url === '/api/jobs/job-one' ? (await detail.promise, job) : page([job]));
    const scrolled = [];
    p.window.matchMedia = query => ({ matches: query === '(max-width: 720px)' || (reduced && query === '(prefers-reduced-motion: reduce)'), addEventListener() {}, removeEventListener() {} });
    // Only the job's own box is counted: other parts may scroll themselves.
    p.window.HTMLElement.prototype.scrollIntoView = function (options) { if (this.classList.contains('job-detail')) scrolled.push({ className: this.className, options }); };
    try {
      await open(p);
      await until(() => p.doc.querySelector('.jobs-browser .job-row'));
      p.doc.querySelector('.jobs-browser .job-row').click();
      // Its read is on its way (held): what shows meanwhile.
      await until(() => p.calls.some(c => c.url === '/api/jobs/job-one'));
      await wait();
      const box = p.doc.querySelector('.job-detail');
      assert.doesNotMatch(box.textContent, /Select a job/, 'not "unchosen" while it is read');
      assert.match(box.textContent, /Reading this job…/);
      assert.equal(box.getAttribute('aria-busy'), 'true');
      // The options object is the page's own; compare its values.
      assert.deepEqual(JSON.parse(JSON.stringify(scrolled)), [{ className: 'job-detail', options: { block: 'start', behavior: reduced ? 'auto' : 'smooth' } }]);
      detail.answer();
      await until(() => p.doc.querySelector('.job-log'));
      assert.equal(p.doc.querySelector('.job-detail').getAttribute('aria-busy'), null);
      assert.doesNotMatch(p.doc.querySelector('.job-detail').textContent, /Reading this job/);
      assert.equal(scrolled.length, 1, 'brought into view once, when chosen');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
});

test('a wide window leaves the list where it is when a job is chosen (T-19 JB-07)', async () => {
  const p = mount(url => url === '/api/jobs/job-one' ? job : page([job]));
  const scrolled = [];
  p.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  p.window.HTMLElement.prototype.scrollIntoView = function () { if (this.classList.contains('job-detail')) scrolled.push(this.className); };
  try {
    await open(p);
    await until(() => p.doc.querySelector('.jobs-browser .job-row'));
    p.doc.querySelector('.jobs-browser .job-row').click();
    await until(() => p.doc.querySelector('.job-log'));
    assert.deepEqual(scrolled, []);
  } finally { p.close(); }
});

test('Actions runs, a linked run and its jobs and steps read as being read until Core answers (T-19 JB-04, CI-04)', async () => {
  const list = held(), report = held();
  const steps = { run: ciRun, error: null, details: { jobs: [{ id: 1, name: 'Build passed', status: 'passed', url: 'https://github.com/o/r/actions/runs/42/job/1', steps: [{ number: 1, name: 'Compile', status: 'completed', conclusion: 'success' }] }], page: 1, hasMore: false, nextPage: null, observedAt: ciRun.observedAt } };
  const p = mount(async url => url.startsWith('/api/ci/') ? (await report.promise, steps) : url.startsWith('/api/ci?') ? (await list.promise, ciPage) : page([]));
  try {
    await until(() => p.doc.querySelector('[aria-label="Jobs"]'));
    p.window.dispatchEvent(new p.window.CustomEvent('yuzuno:open-job', { detail: { source: 'github_actions', runKey: ciRun.id } }));
    await until(() => p.doc.querySelector('.ci-jobs .job-detail'));
    await wait();
    const ci = () => p.doc.querySelector('.ci-jobs');
    const box = () => p.doc.querySelector('.ci-jobs .job-detail');
    assert.doesNotMatch(ci().textContent, /No Actions runs observed yet/, 'not "none" before the answer');
    assert.match(ci().textContent, /Reading runs…/);
    assert.doesNotMatch(box().textContent, /Select a run/, 'not "unchosen" while the linked run is read');
    assert.match(box().textContent, /Reading this run…/);
    assert.equal(box().getAttribute('aria-busy'), 'true');
    list.answer();
    await until(() => ci().querySelector('.job-row'));
    await until(() => /a{40}/.test(box().textContent));
    assert.match(box().textContent, /Reading its jobs and steps…/, 'the steps card is there, saying it is being read');
    assert.equal(box().getAttribute('aria-busy'), 'true');
    report.answer();
    await until(() => p.doc.querySelector('.ci-child-job'));
    assert.doesNotMatch(box().textContent, /Reading/);
    assert.equal(box().getAttribute('aria-busy'), null);
    assert.equal(box().querySelectorAll('.job-card').length >= 2, true);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a job whose read failed keeps its failure; choosing another shows that one being read, without the first one\'s failure (T-19 JB-07)', async () => {
  const second = { ...job, id: 'job-two', name: 'Second synthetic job', cursor: 2 };
  const reads = { 'job-one': [], 'job-two': [] };
  const p = mount(url => {
    const id = url.match(/^\/api\/jobs\/(job-one|job-two)$/)?.[1];
    if (!id) return page([job, second]);
    const read = held();
    reads[id].push(read);
    return read.promise;
  });
  const row = name => [...p.doc.querySelectorAll('.jobs-browser .job-row')].find(r => r.textContent.includes(name));
  const alert = () => p.doc.querySelector('[role="dialog"] [role="alert"]')?.textContent || '';
  const box = () => p.doc.querySelector('.job-detail');
  try {
    await open(p);
    await until(() => row('Second synthetic job'));
    row('中文 training').click();
    await until(() => reads['job-one'].length === 1);
    // As Core answers a failed read: an HTTP error with its reason.
    reads['job-one'][0].answer({ httpStatus: 500, error: 'The first job could not be read' });
    await until(() => /could not be read/.test(alert()));
    assert.doesNotMatch(box().textContent, /Reading this job/, 'a failed read is not still being read');
    assert.equal(box().getAttribute('aria-busy'), null);
    row('Second synthetic job').click();
    await until(() => reads['job-two'].length === 1);
    await wait();
    assert.match(box().textContent, /Reading this job…/, 'the second job, held, is being read');
    assert.equal(box().getAttribute('aria-busy'), 'true');
    assert.doesNotMatch(alert(), /could not be read/, 'the first job\'s failure stays with it');
    reads['job-two'][0].answer(second);
    await until(() => p.doc.querySelector('.job-log'));
    assert.equal(box().getAttribute('aria-busy'), null);
    assert.match(box().textContent, /Second synthetic job/);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a run whose jobs and steps could not be read keeps saying so when only the runs list is read again (T-19 CI-04)', async () => {
  const p = mount(url => url.startsWith('/api/ci/') ? { httpStatus: 500, error: 'Steps unavailable for this run' } : url.startsWith('/api/ci?') ? ciPage : page([]));
  const box = () => p.doc.querySelector('.ci-jobs .job-detail');
  const alert = () => p.doc.querySelector('.ci-jobs [role="alert"]')?.textContent || '';
  const reportReads = () => p.calls.filter(c => c.url.startsWith('/api/ci/')).length;
  const listReads = () => p.calls.filter(c => c.url.startsWith('/api/ci?')).length;
  try {
    await open(p); button(p, 'GitHub Actions').click();
    await until(() => p.doc.querySelector('.ci-jobs .job-row'));
    p.doc.querySelector('.ci-jobs .job-row').click();
    await until(() => /Steps unavailable/.test(alert()));
    assert.doesNotMatch(box().textContent, /Reading its jobs and steps/);
    assert.equal(box().getAttribute('aria-busy'), null);
    const reads = reportReads(), lists = listReads();
    p.window.renderJobs({ ...props, revision: '2' });
    await until(() => listReads() > lists);
    await wait(); await wait();
    assert.equal(reportReads(), reads, 'only the list was read again');
    assert.match(alert(), /Steps unavailable/, 'the list\'s answer does not clear the run\'s failure');
    assert.doesNotMatch(box().textContent, /Reading its jobs and steps/, 'nor shows the run as being read');
    assert.equal(box().getAttribute('aria-busy'), null);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a run whose jobs and steps could not be read shows them without its failure once a check with GitHub brings them (T-19 CI-04)', async () => {
  const after = ciRunning('2026-10-15T01:05:00Z', 'completed');
  let listed = ciRun;
  const p = mount((url, body) => {
    if (url === '/api/ci/refresh' && body) { listed = after.run; return { status: 'checked', checkedAt: after.run.observedAt, retryAt: null, error: null, paused: 0, more: 0, runWatched: true, run: after.run, details: [after.details] }; }
    if (url.startsWith('/api/ci/')) return { httpStatus: 500, error: 'Steps unavailable for this run' };
    return url.startsWith('/api/ci?') ? { ...ciPage, runs: [listed] } : page([]);
  });
  const box = () => p.doc.querySelector('.ci-jobs .job-detail');
  const alert = () => p.doc.querySelector('.ci-jobs [role="alert"]')?.textContent || '';
  const reportReads = () => p.calls.filter(c => c.url.startsWith('/api/ci/') && c.url !== '/api/ci/refresh').length;
  const listReads = () => p.calls.filter(c => c.url.startsWith('/api/ci?')).length;
  try {
    await open(p); button(p, 'GitHub Actions').click();
    await until(() => p.doc.querySelector('.ci-jobs .job-row'));
    p.doc.querySelector('.ci-jobs .job-row').click();
    await until(() => /Steps unavailable/.test(alert()));
    const lists = listReads();
    p.window.renderJobs({ ...props, revision: '2' });
    await until(() => listReads() > lists);
    await wait(); await wait();
    assert.match(alert(), /Steps unavailable/, 'the list alone read again leaves the run\'s failure');
    const reads = reportReads();
    refreshButton(p).click();
    await until(() => checkLine(p).startsWith('Checked with GitHub at'));
    await until(() => p.doc.querySelector('.ci-child-job li .ci-step-state')?.textContent === 'success');
    await wait(); await wait();
    assert.doesNotMatch(alert(), /Steps unavailable/, 'the steps the check brought end the run\'s failed read');
    assert.doesNotMatch(box().textContent, /Reading/);
    assert.equal(box().getAttribute('aria-busy'), null);
    assert.equal(reportReads(), reads, 'its steps came with the check');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('the conversation dock lists its PR reviews after its runs, follows Core to their end and opens each in its task (T-25)', async () => {
  // Mori's reviews (Core's `involving`): a round the Lead started on Mori's PR, preparing; one that requested
  // changes; one that passed; one whose end Core could not confirm.
  let reviews = [
    review('third', 12, { status: 'preparing', phase: 'Fetching fixed PR revision', conclusion: 'unknown', round: 3, createdAt: '2026-10-15T02:00:00Z', finishedAt: null, requestedBy: { kind: 'agent', id: 'lead', name: 'Lead' } }),
    review('changes', 11, { conclusion: 'changes_requested', findingsCount: 3, round: 2, finishedAt: '2026-10-15T01:50:00Z' }),
    review('clean', 10, { round: 1 }),
    review('lost', 9, { status: 'unknown', conclusion: 'unknown', finishedAt: null, number: 8, round: 1 }),
  ];
  const p = mount(url => {
    if (url === '/api/reviews?involving=a') return reviewPage(reviews);
    if (url === '/api/reviews?taskId=task-one&reviewId=changes') return reviewPage([reviews.find(r => r.id === 'changes')]);
    if (url.startsWith('/api/reviews?taskId=task-one')) return reviewPage(reviews);
    return page([]);
  });
  const group = () => p.doc.querySelector('.work-dock [role="group"][aria-label="PR reviews"]');
  const items = () => [...(group()?.querySelectorAll('.conversation-review') || [])];
  const names = () => items().map(i => i.querySelector('.work-dock-label strong').textContent);
  const states = () => items().map(i => [...i.classList].find(c => c.startsWith('state-')));
  const reads = () => p.calls.filter(c => c.url === '/api/reviews?involving=a').length;
  try {
    await until(() => items().length === 2);
    // What is still going first, then the latest ended: two shown, the rest behind More.
    assert.deepEqual(names(), ['PR #7 · round 3', 'PR #7 · round 2']);
    assert.deepEqual(states(), ['state-pending', 'state-rejected']);
    assert.match(items()[0].textContent, /Preparing/);
    assert.match(items()[1].textContent, /Changes requested · 3 findings/);
    assert.equal(group().querySelector('.work-dock-more')?.getAttribute('aria-label'), 'PR reviews: 2 more, open the list');
    // Read once, and again only when Core says something changed: no timer.
    for (let n = 0; n < 12; n++) await wait();
    assert.equal(reads(), 1);
    assert.equal(p.calls.some(c => c.url === '/api/reviews?agentId=a'), false, 'not only what Mori requested itself');
    // Core says a review changed (the jobs scope): the round runs, then ends with no findings, the one mark of passing.
    reviews = [{ ...reviews[0], status: 'running', phase: 'Reviewing' }, ...reviews.slice(1)];
    p.window.renderJobs({ ...props, revision: '2' });
    await until(() => states()[0] === 'state-running');
    assert.match(items()[0].textContent, /Reviewing/);
    reviews = [{ ...reviews[0], status: 'completed', conclusion: 'no_findings', finishedAt: '2026-10-15T02:20:00Z' }, ...reviews.slice(1)];
    p.window.renderJobs({ ...props, revision: '3' });
    await until(() => states()[0] === 'state-passed');
    assert.deepEqual(names(), ['PR #7 · round 3', 'PR #7 · round 2']);
    assert.match(items()[0].textContent, /No actionable findings/);
    assert.equal(reads(), 3);
    // Opened from the dock: the Jobs panel's Reviews, that review in its task.
    items()[1].click();
    await until(() => p.doc.querySelector('.review-jobs .job-detail h3'));
    assert.match(p.doc.querySelector('.review-jobs .job-detail').textContent, /Changes requested/);
    assert.equal(p.doc.querySelector('.job-task-scope').textContent, 'Task task-one');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }

  // An end Core could not confirm stays unknown, never a failure.
  let q = mount(url => url === '/api/reviews?involving=a' ? reviewPage([review('lost', 9, { status: 'unknown', conclusion: 'unknown', finishedAt: null })]) : page([]));
  try {
    await until(() => q.doc.querySelector('.work-dock .conversation-review'));
    const item = q.doc.querySelector('.work-dock .conversation-review');
    assert.ok(item.classList.contains('state-unknown'), item.className);
    assert.match(item.textContent, /Outcome unknown/);
    assert.equal(!!q.doc.querySelector('.work-dock .work-dock-more'), false);
  } finally { q.close(); }
  // No reviews, or a Core without `involving`: no group, no placeholder, no error.
  for (const answer of [reviewPage([]), { httpStatus: 400, error: 'unknown field `involving`' }]) {
    q = mount(url => url === '/api/reviews?involving=a' ? answer : page([]));
    try {
      await until(() => q.calls.some(c => c.url === '/api/reviews?involving=a'));
      for (let n = 0; n < 4; n++) await wait();
      assert.ok(!q.doc.querySelector('.work-dock [role="group"][aria-label="PR reviews"]'), 'no reviews group');
      assert.deepEqual(q.errors, []);
    } finally { q.close(); }
  }
});

test('the dock keeps to Settings for its PR reviews (0 removes the group and its read), and its More opens this Agent\'s own reviews (T-25 R1)', async () => {
  const many = [1, 2, 3, 4].map(n => review(`r${n}`, 10 + n, { round: n, finishedAt: `2026-10-15T0${n}:00:00Z` }));
  const handler = url => url === '/api/reviews?involving=a' ? reviewPage(many) : url.startsWith('/api/reviews?') ? reviewPage([]) : page([]);
  const group = p => p.doc.querySelector('.work-dock [role="group"][aria-label="PR reviews"]');
  const limits = dock => ({ 'yuzuno.appearance': JSON.stringify({ dock }) });
  // 0: no group, and nothing is read for it.
  let p = mount(handler, limits({ jobs: 5, actions: 2, reviews: 0, subAgents: 5 }));
  try {
    await until(() => p.calls.some(c => c.url.startsWith('/api/ci?')));
    for (let n = 0; n < 4; n++) await wait();
    assert.ok(!group(p), 'no reviews group at 0');
    assert.equal(p.calls.some(c => c.url.includes('involving=')), false, 'and no read for it');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
  // 1: the latest ended one, the rest behind More.
  p = mount(handler, limits({ jobs: 5, actions: 2, reviews: 1, subAgents: 5 }));
  try {
    await until(() => group(p)?.querySelectorAll('.conversation-review').length === 1);
    assert.equal(group(p).querySelector('.conversation-review .work-dock-label strong').textContent, 'PR #7 · round 4');
    const more = group(p).querySelector('.work-dock-more');
    assert.equal(more.getAttribute('aria-label'), 'PR reviews: 3 more, open the list');
    // More opens the Jobs panel's Reviews on the same reviews the dock lists: requested by, sent to, or on Mori's tasks.
    const before = p.calls.filter(c => c.url === '/api/reviews?involving=a').length;
    more.click();
    await until(() => p.doc.querySelectorAll('.review-jobs .job-row').length === 4);
    assert.ok(p.calls.filter(c => c.url === '/api/reviews?involving=a').length > before, 'the list reads involving');
    assert.equal(p.calls.some(c => c.url === '/api/reviews?agentId=a'), false, 'not only what Mori requested itself');
    assert.match(p.doc.querySelector('.review-jobs').textContent, /Showing Mori's reviews, as its conversation lists them/);
    // The panel's other sources keep Mori's scope, never `involving`.
    const jobReads = () => p.calls.filter(c => c.url === '/api/jobs?agentId=a').length;
    const jobsBefore = jobReads();
    // The source tabs by their ids: Local's own name carries its queue count.
    p.doc.getElementById('jobs-tab-local').click();
    await until(() => jobReads() > jobsBefore);
    assert.equal(p.calls.some(c => c.url.startsWith('/api/jobs?') && c.url.includes('involving')), false);
    // Mori's own button is the requester scope again, as before.
    p.doc.getElementById('jobs-tab-reviews').click();
    await until(() => p.doc.querySelector('.review-jobs'));
    button(p, 'Mori').click();
    await until(() => p.calls.some(c => c.url === '/api/reviews?agentId=a'));
    await until(() => /Showing reviews Mori requested itself/.test(p.doc.querySelector('.review-jobs')?.textContent || ''));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
