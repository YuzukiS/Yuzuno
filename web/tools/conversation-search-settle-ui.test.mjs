// A search result chosen where no caller locates it (ConversationSearch without onLocate; App always passes one and
// lands it as a source) settles the message it lands on once (T-19 C18, M4): `data-settle`, taken off when the
// settle's time is up, instead of search's own 2.6 s highlight. jsdom plays no animation; the ring the app's landing
// plays is the Chromium check's (landing-settle-check.mjs).
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
const fixture = await mkdtemp(path.join(root, 'node_modules/.cache/conversation-search-settle-ui-'));
let bundle;
try {
  const entry = path.join(fixture, 'entry.tsx');
  // The conversation as App renders it, for search to find a result's message: a Turn by its id, its items by theirs.
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationSearch} from ${JSON.stringify(path.join(root, 'src/ConversationSearch.tsx'))};const turns=[{id:'t1',status:'completed',items:[{id:'u1',type:'userMessage',content:[{type:'text',text:'Where is the fixture?'}]},{id:'r1',type:'agentMessage',phase:'final_answer',text:'The LandingToken reply.'}]}];createRoot(document.getElementById('root')).render(<><ConversationSearch agentName="Mori" turns={turns} disabled={false} onNavigate={()=>{}}/><div className="conversation-scroll">{turns.map(t=><section key={t.id} id={'turn-'+t.id} data-turn-id={t.id}>{t.items.map(i=><div key={i.id} data-item-id={i.id} tabIndex={-1}>{i.text||i.content[0].text}</div>)}</section>)}</div></>);`);
  const result = await build({ root, configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, logLevel: 'silent', plugins: [react()], build: { write: false, lib: { entry, name: 'ConversationSearchSettleUI', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(v => v.type === 'chunk').code;
} finally { await rm(fixture, { recursive: true, force: true }); }

const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let n = 0; n < 150; n++) { if (fn()) return; await wait(); } assert.fail(`Expected state did not appear: ${what}`); }

test('a result chosen where no caller locates it lands on its message and settles it once, with no 2.6 s highlight (T-19 C18)', async () => {
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://isolated.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, doc = w.document;
  w.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.fetch = async () => { throw new Error('no request expected'); };
  try {
    w.eval(bundle);
    await until(() => doc.querySelector('.conversation-search-trigger'), 'the search button');
    doc.querySelector('.conversation-search-trigger').click();
    await until(() => doc.querySelector('.conversation-search-input'), 'the search field');
    const input = doc.querySelector('.conversation-search-input');
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(input, 'landingtoken');
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await until(() => doc.querySelector('.conversation-search-result'), 'a result');
    doc.querySelector('.conversation-search-result').click();
    const message = doc.querySelector('[data-item-id="r1"]');
    await until(() => doc.activeElement === message, 'the message focused');
    assert.equal(message.hasAttribute('data-settle'), true, "the result's message settles");
    assert.equal(message.hasAttribute('data-search-highlight'), false, "and search's own highlight is gone");
    await wait(1450);
    assert.equal(message.hasAttribute('data-settle'), false, "it goes once the settle's time is up");
    assert.deepEqual(errors, []);
  } finally { w.close(); }
});
