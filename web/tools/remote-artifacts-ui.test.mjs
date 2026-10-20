// T-108: a remote job's artifacts are checked on its machine and stay there.
// The panel names the machine and each file's path there and offers no
// download; a job on this host keeps its download of verified files.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/remote-artifacts-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs} from ${JSON.stringify(path.join(root, 'src/Jobs.tsx'))};window.renderJobs=p=>createRoot(document.getElementById('root')).render(<Jobs {...p}/>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'RemoteArtifactsUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = () => new Promise(r => setTimeout(r, 25));
async function until(fn) { for (let n = 0; n < 120; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const agent = { id: 'a', name: 'Mori', cwd: '/workspace', status: 'working' };
const resources = { cpuMillis: 500, memoryMiB: 128, swapMiB: 0 };
const sha = 'abcdef0123456789'.repeat(4);
const base = { requestId: 'r', taskRef: 'T-108', agentId: 'a', agent: { name: 'Mori' }, resources, reservation: resources,
  createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  argv: ['/bin/sh', '-c', 'make'], env: {}, reserved: false, status: 'succeeded', reason: 'success',
  artifacts: [{ path: 'out.json', format: 'json' }, { path: 'cache.bin' }] };
// The same path on both: only the machine tells them apart.
const remote = { ...base, id: 'job-r', cursor: 2, name: 'eval on lab box', cwd: '/home/u/work', machine: { name: 'lab box' },
  executor: { kind: 'ssh', machineId: 'm1' },
  result: { reason: 'success', artifactsOn: { machineId: 'm1', name: 'lab box', hostId: '0123456789abcdef0123456789abcdef' },
    artifacts: [{ path: 'out.json', ok: true, bytes: 9, sha256: sha, absolutePath: '/home/u/work/out.json', preExisting: false },
      { path: 'cache.bin', ok: true, bytes: 4, sha256: sha, absolutePath: '/home/u/work/cache.bin', preExisting: true, unchangedSinceStart: true }] } };
const queued = { ...remote, id: 'job-q', cursor: 3, name: 'queued on lab box', status: 'queued', reason: 'Waiting for a slot', startedAt: null,
  finishedAt: null, result: null };
const local = { ...base, id: 'job-l', cursor: 1, name: 'eval here', cwd: '/home/u/work', machine: { name: 'WSL' },
  result: { reason: 'success', artifacts: [{ path: 'out.json', ok: true, bytes: 9, sha256: sha, absolutePath: '/home/u/work/out.json' },
    { path: 'cache.bin', ok: true, bytes: 4, sha256: sha, absolutePath: '/home/u/work/cache.bin' }] } };
const byId = { 'job-r': remote, 'job-q': queued, 'job-l': local };
const page = { jobs: [queued, remote, local], liveJobs: [queued], hasMore: false, nextBefore: null };

function mount() {
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async url => {
    let value;
    if (url === '/api/jobs/budget') value = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 0, queuedCount: 0, collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 }, machine: { name: 'WSL', memoryAvailableMiB: 2000, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, maximumBudget: { cpuMillis: 24000, memoryMiB: 20053, swapMiB: 4096 } } };
    else if (url.endsWith('/logs')) value = { text: '', oldestOffset: 0, totalBytes: 0 };
    else value = byId[url.replace('/api/jobs/', '')] ?? page;
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  w.renderJobs({ workspaceId: 'w', agent, revision: '1', disabled: false });
  return { window: w, doc: w.document, errors, close: () => w.close() };
}
async function open(p) { await until(() => p.doc.querySelector('[aria-label="Jobs"]')); p.doc.querySelector('[aria-label="Jobs"]').click(); await until(() => p.doc.querySelector('[role="dialog"]')); }
const row = (p, name) => [...p.doc.querySelectorAll('.job-row')].find(r => r.textContent.includes(name));
// The selected job's card, once it shows what tells that job apart.
async function show(p, name, ready) {
  await until(() => row(p, name));
  row(p, name).click();
  await until(() => { const card = p.doc.querySelector('.job-artifacts'); return card && ready(card); });
  return p.doc.querySelector('.job-artifacts');
}

test("a remote job's artifacts name their machine and path there, with no download; a local job's keep theirs", async () => {
  const p = mount();
  try {
    await open(p);
    let card = await show(p, 'eval on lab box', c => c.textContent.includes('Verified'));
    assert.match(card.textContent, /Checked on lab box and kept there; not copied to this host\./);
    const where = [...card.querySelectorAll('.job-artifact-where')].map(s => s.textContent);
    assert.deepEqual(where, ['On lab box: /home/u/work/out.json', 'On lab box: /home/u/work/cache.bin']);
    assert.match(card.textContent, /out\.json.*Verified · 9 bytes · SHA-256 abcdef012345…/);
    assert.equal(card.querySelectorAll('a[download]').length, 0, 'nothing on another machine is offered for download');
    // A file that was already there is noted, not judged: it is still verified.
    const cached = [...card.querySelectorAll('li')].find(li => li.textContent.includes('cache.bin'));
    assert.match(cached.textContent, /Verified.*Already there before the command ran, unchanged/);
    assert.equal(cached.className, 'verified');

    card = await show(p, 'queued on lab box', c => !c.textContent.includes('Verified'));
    assert.match(card.textContent, /Checked on lab box and kept there/);
    assert.match(card.textContent, /out\.jsonNot checked yet/);
    assert.equal(card.querySelectorAll('a[download]').length, 0);

    card = await show(p, 'eval here', c => c.querySelector('a[download]'));
    assert.doesNotMatch(card.textContent, /Checked on|kept there|On WSL/);
    assert.equal(card.querySelectorAll('.job-artifact-where').length, 0);
    const downloads = [...card.querySelectorAll('a[download]')].map(a => a.getAttribute('href'));
    assert.deepEqual(downloads, ['/api/jobs/job-l/artifacts/0', '/api/jobs/job-l/artifacts/1']);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
