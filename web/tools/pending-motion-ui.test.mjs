// A pending request's card as Core records and resolves its answer (T-19
// CV:Q-03): the "Response sent" hint fades in when it appears while the card
// shows, and a resolved card leaves through a copy where it was (aria-hidden,
// inert, without the card's ids, names and tab stops) that fades out and goes.
// A card that opens sent, another Agent opened and reduced motion leave
// nothing behind and play nothing. A card answered here is resolved once
// Core answers its request, before a refresh marks it sent. `animate` is
// recorded by its id.
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/pending-motion-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  // As App.tsx: one conversation element that stays across Agents and says whose it is (data-agent-id), its rows
  // and cards keyed by the Agent, as ConversationWindow is.
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {PendingCard} from ${JSON.stringify(path.join(root, 'src/components.tsx'))};const r=createRoot(document.getElementById('root'));window.renderCards=(requests,agent='a',key=agent)=>flushSync(()=>r.render(<div className="conversation-scroll" data-agent-id={agent}><React.Fragment key={key}>{requests.map((q)=><PendingCard key={q.id} request={{...q,agentId:agent}} refresh={()=>{}} disabled={false} onViewChanges={()=>{}}/>)}</React.Fragment><p className="read-end-marker"/></div>));`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'PendingMotionUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let n = 0; n < 150; n++) { if (fn()) return; await wait(); } assert.fail(`Expected state did not appear: ${what}`); }
const codex = (id, sent = false) => ({ id, agentId: 'a', method: 'item/tool/requestUserInput', createdAt: '',
  params: { questions: [{ id: 'q1', question: 'Which fixture branch?', options: [{ label: 'main', description: 'The main fixture' }] }],
    ...(sent ? { _responseSent: true } : {}) } });
const claude = (id, sent = false) => ({ id, agentId: 'a', method: 'claude/canUseTool', createdAt: '',
  params: { toolName: 'Bash', input: { command: 'ls fixture' }, ...(sent ? { _responseSent: true } : {}) } });
const opencode = (id) => ({ id, agentId: 'a', method: 'opencode/permission', createdAt: '',
  params: { id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['ls fixture'], metadata: {}, _responseSent: false } });

function mount({ reduced = false } = {}) {
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  const page = { w, doc: w.document, errors, played: [], answers: [] };
  w.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST' && /\/api\/requests\/[^/]+\/respond$/.test(url)) page.answers.push(url);
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };
  w.matchMedia = (media) => ({ media, matches: reduced && /reduce/.test(media), addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  // On Element, where motion.ts looks for the Web Animations API; each animation ends when the test says.
  w.Element.prototype.animate = function (keyframes, options) {
    const handlers = [];
    const animation = { addEventListener: (type, fn) => type === 'finish' && handlers.push(fn), cancel() {}, finished: Promise.resolve() };
    if (/^pending-/.test(options?.id ?? '')) page.played.push({ id: options.id, el: this, duration: options.duration, end: () => handlers.forEach((fn) => fn()) });
    return animation;
  };
  w.eval(bundle);
  page.render = async (requests, agent, key) => { w.renderCards(requests, agent, key); await wait(); };
  page.take = () => page.played.splice(0).map((p) => p.id).sort();
  page.close = () => w.close();
  return page;
}
const card = (p, id) => p.doc.getElementById(`request-${id}`);
const copies = (p) => [...p.doc.querySelectorAll('.pending-card-leaving')];
const sentHint = (el) => [...(el?.querySelectorAll('.field-hint') ?? [])].find((n) => n.textContent.startsWith('Response sent'));

test('answered, a Codex question says "Response sent" fading in; resolved, the card goes at once and a copy where it was fades out over exit-small and goes (T-19 CV:Q-03)', async () => {
  const p = mount();
  try {
    await p.render([codex('ask')]);
    assert.deepEqual(p.take(), [], 'what opens does not move');
    card(p, 'ask').querySelector('label.answer-option input').click();
    await wait();
    [...card(p, 'ask').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send answer').click();
    await until(() => sentHint(card(p, 'ask')), 'the hint');
    const hint = p.played.find((a) => a.id === 'pending-hint-in');
    assert.equal(!!hint && hint.el === sentHint(card(p, 'ask')), true, 'the hint fades in');
    assert.equal(hint.duration, 180);
    assert.equal(p.answers.length, 1);
    p.take();
    await p.render([]);
    assert.equal(!!card(p, 'ask'), false, 'the card itself is gone at once');
    const [copy] = copies(p);
    assert.equal(!!copy, true, 'a copy where the card was');
    assert.equal(copy.nextElementSibling?.classList.contains('read-end-marker'), true, 'in the card\'s place');
    assert.equal(copy.getAttribute('aria-hidden'), 'true');
    assert.equal(copy.hasAttribute('inert'), true);
    assert.equal(copy.querySelectorAll('[id], [tabindex], [name]').length + (copy.id ? 1 : 0), 0, 'no ids, names or tab stops');
    assert.equal(copy.contains(p.doc.activeElement), false, 'and no focus');
    const exit = p.played.find((a) => a.id === 'pending-card-exit');
    assert.equal(!!exit && exit.el === copy, true, 'the copy fades out');
    assert.equal(exit.duration, 130);
    exit.end();
    assert.equal(copies(p).length, 0, 'gone when its fade ends');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a Claude card: the hint fades in as Core records the answer, and resolved it leaves through a copy (T-19 CV:Q-03)', async () => {
  const p = mount();
  try {
    await p.render([claude('perm')]);
    await p.render([claude('perm', true)]);
    assert.equal(!!sentHint(card(p, 'perm')), true);
    assert.deepEqual(p.take(), ['pending-hint-in'], 'the hint fades in as it appears');
    await p.render([]);
    assert.equal(copies(p).length, 1, 'a copy where the card was');
    assert.deepEqual(p.take(), ['pending-card-exit']);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a card that opens sent plays nothing, another Agent opened leaves no copy, and under reduced motion a resolved card simply goes (T-19 CV:Q-03)', async () => {
  const p = mount();
  try {
    await p.render([codex('sent', true), codex('open')]);
    assert.equal(!!sentHint(card(p, 'sent')), true);
    assert.deepEqual(p.take(), [], 'a card that opens sent shows its hint as it is');
    await p.render([], 'b');
    assert.equal(copies(p).length, 0, "another Agent opened leaves no copy of the last one's cards");
    assert.deepEqual(p.take(), [], 'and plays nothing');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
  const q = mount({ reduced: true });
  try {
    await q.render([codex('ask')]);
    await q.render([codex('ask', true)]);
    await q.render([]);
    assert.equal(copies(q).length, 0, 'nothing left in its place');
    assert.deepEqual(q.take(), [], 'nothing plays');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('a card taken out while its request still waits leaves no copy, nor one put in again under a parent keyed anew; a resolved one still leaves through the copy (T-19 CV:Q-03, R1 4a8e5cfe)', async () => {
  const p = mount();
  try {
    await p.render([codex('waits')]);
    await p.render([]);
    assert.equal(copies(p).length, 0, 'a card taken out while its request still waits leaves no copy');
    assert.deepEqual(p.take(), [], 'and plays nothing');
    await p.render([codex('sent', true)], 'a', 'one');
    await p.render([codex('sent', true)], 'a', 'two');
    assert.equal(!!card(p, 'sent'), true);
    assert.equal(copies(p).length, 0, 'the same request put in again under a parent keyed anew leaves no copy');
    assert.deepEqual(p.take(), []);
    await p.render([], 'a', 'two');
    assert.equal(copies(p).length, 1, 'a resolved card still leaves through the copy');
    assert.deepEqual(p.take(), ['pending-card-exit']);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

// One test each, so each card's own red shows.
for (const [name, request] of [['a Claude permission', claude('perm')], ['an OpenCode request', opencode('oc')]]) {
  test(`${name} answered here (Core answered 200) and gone from the next refresh before Core marks it sent still leaves through the copy (T-19 CV:Q-03, R2 e5c4a849)`, async () => {
    const p = mount();
    try {
      await p.render([request]);
      [...card(p, request.id).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Allow once').click();
      // Sent and answered: no longer sending, and still locked.
      await until(() => p.answers.length === 1 && !card(p, request.id).querySelector('.spin')
        && card(p, request.id).querySelector('.primary-button')?.disabled === true, `${name} answered`);
      assert.equal(!!sentHint(card(p, request.id)), false, 'Core has not marked it sent yet');
      // Core resolved it at once: the next refresh no longer lists it.
      await p.render([]);
      assert.equal(!!card(p, request.id), false);
      assert.equal(copies(p).length, 1, `${name} answered here still leaves through the copy`);
      assert.deepEqual(p.take(), ['pending-card-exit'], 'the copy fades out; no hint was shown to fade in');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  });
}
