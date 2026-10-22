import './jsdom-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { JSDOM } from 'jsdom';

await mkdir('target', { recursive: true });
const fixture = await mkdtemp(resolve('target/mcp-status-test-'));
let bundle;
try {
  const entry = `${fixture}/entry.js`;
  await writeFile(entry, `import React from 'react';import{createRoot}from'react-dom/client';
import{ClaudeMcpStatus}from${JSON.stringify(resolve('src/ClaudeMcpStatus.tsx'))};
const root=createRoot(document.getElementById('root'));window.setAgent=agent=>root.render(React.createElement(ClaudeMcpStatus,{agent}));`);
  const built = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
    build: { write: false, lib: { entry, name: 'McpTest', formats: ['iife'] } } });
  bundle = (Array.isArray(built) ? built[0] : built).output.find(o => o.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await pause(10); } assert.ok(check(), 'condition settles'); }
const agent = { id: 'a', cwd: '/a', claudeSessionId: 'session-a', connectionState: 'connected' };
const ready = (name = 'local', extra = {}) => ({ state: 'ready', reason: 'observed', generation: 1, sessionId: 'session-a', stale: false,
  freshForSeconds: 60, checkedAt: new Date().toISOString(), observation: { observedAt: new Date().toISOString(),
    servers: [{ name, status: 'connected' }], total: 1, truncated: false }, ...extra });
function mount() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://fixture.test', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document, calls = [];
  w.AbortController = AbortController;
  w.fetch = (path, init) => new Promise(resolve => calls.push({ path, init, resolve }));
  w.setInterval = callback => { w.age = callback; return 1; };
  w.eval(bundle);
  w.setAgent(agent);
  return { w, d, calls, reply(index, value, ok = true) { calls[index].resolve({ ok, status: ok ? 200 : 500,
    json: async () => value, text: async () => String(value) }); }, close: () => w.close() };
}

test('native states, safe failures, coalesced refresh and recovery remain in a compact independent section', async () => {
  const p = mount();
  try {
    await until(() => p.calls.length === 1);
    const observation = { observedAt: new Date().toISOString(), total: 6, truncated: false,
      servers: ['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'future'].map((status, i) => ({ name: `service-${i}`, status, reason: 'timeout' })) };
    p.reply(0, ready('x', { observation }));
    await until(() => p.d.querySelectorAll('.mcp-server-state').length === 6);
    assert.deepEqual([...p.d.querySelectorAll('.mcp-server-state')].map(e => e.textContent),
      ['Connected', 'Failed', 'Needs authentication', 'Connecting', 'Disabled', 'Unknown']);
    assert.match(p.d.body.textContent, /did not respond in time/);
    assert.match(p.d.querySelector('a').href, /^https:\/\/code.claude.com\/docs\/en\/mcp#/);
    const refresh = p.d.querySelector('button');
    refresh.click(); refresh.click();
    assert.equal(p.calls.length, 2);
    assert.equal(p.calls[1].init.method, 'POST');
    p.reply(1, ready('x', { state: 'failed', reason: 'read_failed', stale: true, observation }));
    await until(() => p.d.body.textContent.includes('Could not read'));
    assert.match(p.d.body.textContent, /Previous observation/);
    assert.equal(p.d.querySelectorAll('[data-state=connected]').length, 0);
    refresh.click();
    await until(() => refresh.disabled);
    p.reply(2, 'raw native-secret failure', false);
    await until(() => !refresh.disabled);
    assert.doesNotMatch(p.d.body.textContent, /native-secret/);
    refresh.click(); p.reply(3, ready('recovered'));
    await until(() => p.d.body.textContent.includes('recovered'));
    assert.doesNotMatch(p.d.body.textContent, /Previous observation|Could not read/);
    p.w.setAgent({ ...agent, rev: 200, name: 'new label' }); await pause(25);
    assert.equal(p.calls.length, 4, 'ordinary Agent deltas do not query the SDK');
  } finally { p.close(); }
});

test('Agent/session/environment changes synchronously replace the panel and reject late callbacks', async () => {
  const p = mount();
  try {
    await until(() => p.calls.length === 1);
    for (const [index, next] of [[1, { ...agent, id: 'b' }], [2, { ...agent, id: 'b', claudeSessionId: 'new' }],
      [3, { ...agent, id: 'b', claudeSessionId: 'new', cwd: '/different' }]]) {
      p.w.setAgent(next); await until(() => p.calls.length === index + 1);
      assert.equal(p.calls[index - 1].init.signal.aborted, true);
      p.reply(index - 1, ready('stale-old-result')); await pause(25);
      assert.doesNotMatch(p.d.body.textContent, /stale-old-result/);
    }
    p.reply(3, ready('current')); await until(() => p.d.body.textContent.includes('current'));
    assert.match(p.calls[3].path, /agents\/b\/claude\/mcp-status$/);
  } finally { p.close(); }
});

test('age, disconnected and unsupported observations never look currently healthy', async () => {
  const p = mount();
  try {
    await until(() => p.calls.length === 1);
    const old = ready(); old.observation.observedAt = new Date(Date.now() - 65_000).toISOString();
    p.reply(0, old); await until(() => p.d.body.textContent.includes('over a minute old'));
    assert.match(p.d.body.textContent, /Previous observation/);
    assert.equal(p.d.querySelectorAll('[data-state=connected]').length, 0);
    p.w.setAgent({ ...agent, connectionState: 'disconnected' }); await until(() => p.calls.length === 2);
    p.reply(1, ready('cached', { state: 'unavailable', reason: 'not_connected', stale: true }));
    await until(() => p.d.body.textContent.includes('cached'));
    assert.match(p.d.body.textContent, /disconnected|not started/);
    assert.ok(p.d.querySelector('button').disabled);
    p.w.setAgent({ ...agent }); await until(() => p.calls.length === 3);
    p.reply(2, ready('x', { state: 'unsupported', reason: 'unsupported', stale: true, observation: null }));
    await until(() => p.d.body.textContent.includes('does not support'));
    assert.equal(p.d.querySelectorAll('.mcp-server-state').length, 0);
  } finally { p.close(); }
});
