// T-169: a task's Workspace panel shows each registered folder's Git state
// and users, offers the materials' path only as a suggestion to register,
// lets only unprotected cleanup candidates be selected, sends exactly the
// previewed selection, and shows what Core actually did.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/task-workspaces-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {TaskWorkspaces} from ${JSON.stringify(path.join(root, 'src/TaskWorkspaces.tsx'))};window.renderPanel=p=>createRoot(document.getElementById('root')).render(<TaskWorkspaces {...p}/>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'TaskWorkspacesUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = () => new Promise(r => setTimeout(r, 20));
async function until(fn) { for (let n = 0; n < 150; n++) { if (fn()) return; await wait(); } assert.fail('Expected bounded UI state did not appear'); }
const workspace = {
  id: 'w1', path: '/work/demo-t1', origin: 'created', branch: 't-1', state: 'present',
  git: { branch: 't-1', head: '0123456789abcdef', origin: 'example/demo', repositoryId: 42, sameRepository: true, changes: { modified: 1, untracked: 2, complete: true } },
  users: { agents: [{ id: 'a', name: 'Mori', status: 'working', relation: 'inside', working: true }], liveJobs: [{ id: 'j1', name: 'build', status: 'running' }], taskJobs: 3 },
};
const preview = {
  id: 'p1', expiresAt: '2099-01-01T00:00:00Z', scope: 'Only Cargo profile output is offered.',
  bounds: { complete: true, visitedFolders: 12 },
  kept: [{ path: 'target/t110', reason: 'Not recognized as Cargo build output: it may be yours' }],
  candidates: [
    { id: 'c0', relative: 'target/debug', kind: 'Cargo', estimate: { bytes: 3 * 1024 * 1024 * 1024, sharedBytes: 0, files: 9, complete: true }, protected: [] },
    { id: 'c1', relative: 'target/release', kind: 'Cargo', estimate: { bytes: 1024, sharedBytes: 0, files: 1, complete: true }, protected: ['Cargo is building here now'] },
  ],
};

function mount(props, listing) {
  const vc = new VirtualConsole(), errors = [], calls = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method || 'GET', body });
    let value = listing;
    if (url.endsWith('/cleanup/preview')) value = preview;
    else if (url.endsWith('/cleanup')) value = { results: [{ id: 'c0', relative: 'target/debug', state: 'removed' }], freedBytes: String(3 * 1024 * 1024 * 1024), note: 'Freed is the filesystem free space after minus before.' };
    else if (init.method === 'POST') value = workspace;
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  w.renderPanel(props);
  return { doc: w.document, errors, calls, close: () => w.close() };
}
const button = (p, text) => [...p.doc.querySelectorAll('button')].find(b => b.textContent.trim() === text);

test('a workspace shows its Git state and users, and cleanup sends only the selected, unprotected candidate', async () => {
  const p = mount({ taskId: 'T-1' }, { taskId: 'T-1', repositories: [], workspaces: [workspace] });
  try {
    await until(() => p.doc.querySelector('.task-workspace-git'));
    assert.equal(p.calls[0].url, '/api/tasks/T-1/workspaces');
    assert.equal(p.doc.querySelector('.task-workspace-git').textContent, 'on t-1 · 01234567 · 1 changed, 2 untracked · example/demo');
    assert.equal(p.doc.querySelector('.task-workspace-users').textContent, 'Used by Mori (working), Job build (running) · 3 Jobs of this task');
    button(p, 'Preview cleanup').click();
    await until(() => p.doc.querySelector('[aria-label="Cleanup candidates"]'));
    const boxes = [...p.doc.querySelectorAll('[aria-label="Cleanup candidates"] input')];
    assert.deepEqual(boxes.map(b => b.disabled), [false, true], 'a protected candidate cannot be selected');
    assert.match(p.doc.querySelector('.task-workspace-kept').textContent, /Cargo is building here now/);
    assert.equal(button(p, 'Remove selected').disabled, true, 'nothing is removed without a selection');
    boxes[0].click();
    await until(() => !button(p, 'Remove selected').disabled);
    button(p, 'Remove selected').click();
    await until(() => p.doc.querySelector('[aria-label="Cleanup results"]'));
    const removal = p.calls.find(c => c.url.endsWith('/cleanup'));
    assert.deepEqual(removal.body, { previewId: 'p1', candidates: ['c0'] });
    assert.equal(p.doc.querySelector('[aria-label="Cleanup results"]').textContent, 'target/debug: removed');
    assert.equal(p.doc.querySelector('[aria-label="Cleanup candidates"]'), null, 'a used preview is not offered again');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('the materials path is only a suggestion, and creating sends the chosen branch and folder', async () => {
  const p = mount({ taskId: 'T-1', materialsWorktree: '/work/demo' }, { taskId: 'T-1', repositories: [], workspaces: [] });
  try {
    await until(() => p.doc.querySelector('.task-workspace-suggestion'));
    assert.ok(!p.calls.some(c => c.method === 'POST'), 'nothing is registered by itself');
    button(p, 'Register it').click();
    await until(() => p.calls.some(c => c.method === 'POST'));
    assert.deepEqual(p.calls.find(c => c.method === 'POST'), { url: '/api/tasks/T-1/workspaces', method: 'POST', body: { path: '/work/demo' } });
    p.doc.querySelector('details summary').click();
    // The list is read again after registering; the form waits for it.
    await until(() => !button(p, 'Create worktree').disabled);
    button(p, 'Create worktree').click();
    await until(() => p.calls.some(c => c.url.endsWith('/create')));
    assert.deepEqual(p.calls.find(c => c.url.endsWith('/create')).body,
      { repository: '/work/demo', branch: 't-1', base: 'origin/main', path: '/work/demo-t-1' });
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

// T-189: the panel follows the interface language, changed in another window.
async function type(p, input, value) {
  const w = p.doc.defaultView;
  Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  await wait();
}
test('the Workspace panel follows a language change; what is typed, open and selected stays and nothing is asked again (T-189)', async () => {
  const p = mount({ taskId: 'T-1', materialsWorktree: '/work/other' }, { taskId: 'T-1', repositories: [], workspaces: [workspace] });
  const w = p.doc.defaultView;
  const create = () => p.doc.querySelector('.task-workspaces > details');
  try {
    await until(() => p.doc.querySelector('.task-workspace-git') && p.doc.querySelector('.task-workspace-suggestion'));
    await type(p, p.doc.querySelector('[aria-label="Folder to register"]'), '/work/typed 草稿');
    create().open = true;
    await until(() => create().open);
    await type(p, create().querySelectorAll('input')[1], 't-1-zh');
    button(p, 'Preview cleanup').click();
    await until(() => p.doc.querySelector('[aria-label="Cleanup candidates"]'));
    p.doc.querySelectorAll('[aria-label="Cleanup candidates"] input')[0].click();
    await until(() => !button(p, 'Remove selected').disabled);
    const before = p.calls.length;
    w.localStorage.setItem('yuzuno.language', JSON.stringify({ language: 'zh-Hans' }));
    w.dispatchEvent(new w.StorageEvent('storage', { key: 'yuzuno.language' }));
    await wait();
    await wait();
    const section = p.doc.querySelector('.task-workspaces');
    assert.equal(section.getAttribute('aria-label'), '工作区');
    assert.equal(p.doc.querySelector('.task-workspace-path').textContent, '/work/demo-t1 · Core 主机 · 在 t-1 上创建');
    assert.equal(p.doc.querySelector('.task-workspace-git').textContent, '在 t-1 上 · 01234567 · 1 个已修改，2 个未跟踪 · example/demo');
    assert.equal(p.doc.querySelector('.task-workspace-users').textContent, '正在使用：Mori（working）、Job build（running） · 此任务的 3 个 Job');
    for (const label of ['再次检查', '预览清理', '移除登记', '登记它', '登记文件夹', '创建 worktree', '删除所选']) assert.ok(button(p, label), label);
    const candidates = p.doc.querySelector('[aria-label="清理候选"]');
    assert.ok(candidates, 'the preview stays');
    assert.match(candidates.textContent, /target\/debug · 约 3\.0 GiB/);
    assert.equal(p.doc.querySelector('.task-workspace-kept').textContent, '保留：Cargo is building here now');
    assert.ok(section.textContent.includes('保留 1 项'));
    // As written: Core's scope and the reason it keeps a folder.
    assert.ok(section.textContent.includes('Only Cargo profile output is offered.'));
    assert.ok(section.textContent.includes('Not recognized as Cargo build output: it may be yours'));
    assert.ok(candidates.querySelectorAll('input')[0].checked, 'the selection stays');
    assert.ok(p.doc.querySelector('.task-workspace-suggestion').textContent.startsWith('任务材料中提到了 /work/other（仅供参考）。'));
    assert.equal(p.doc.querySelector('[aria-label="要登记的文件夹"]').value, '/work/typed 草稿');
    assert.ok(create().open, 'the create form stays open');
    assert.equal(create().querySelector('summary').textContent, '创建 worktree…');
    assert.equal(create().querySelectorAll('input')[1].value, 't-1-zh');
    // Nothing asked of Core: no listing, preview, cleanup, register, create or forget.
    assert.deepEqual(p.calls.slice(before).map(c => c.url), []);
    button(p, '删除所选').click();
    await until(() => p.doc.querySelector('[aria-label="清理结果"]'));
    assert.equal(p.doc.querySelector('[aria-label="清理结果"]').textContent, 'target/debug: 已删除');
    assert.ok(section.textContent.includes('可用空间变化了 3.0 GiB。Freed is the filesystem free space after minus before.'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
