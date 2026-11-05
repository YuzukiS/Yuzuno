// The strips measure themselves only when what they show changes (T-51 #613 R2 5db2b3cc): App renders often while a
// Turn streams, and each measure reads the strips' height (a layout) and may write the conversation's --strips-height
// (a style change for all of it). Here ConversationStrips renders under a parent that renders again as App does, with
// the strips' height counted from what they show (jsdom lays nothing out) and every read and write of it recorded.
// Their wraps as the window narrows are the ResizeObserver's, which the Chromium check exercises.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const web = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(web, "node_modules/.cache"), { recursive: true });
const fixture = await mkdtemp(path.join(web, "node_modules/.cache/conversation-strips-measure-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  // As App passes them: the reading offer, then the source strip, each there or not.
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ConversationStrips} from ${JSON.stringify(path.join(web, "src/ConversationStrips.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderStrips=(n,offer,source)=>flushSync(()=>root.render(<div className="conversation-body"><ConversationStrips>{offer && <div className="source-navigation reading-offer">Offer</div>}{source && <div className="source-navigation">Linked message</div>}</ConversationStrips><p className="rendered">{n}</p></div>));`);
  const result = await build({ root: web, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "StripsMeasure", formats: ["iife"] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((v) => v.type === "chunk").code;
} finally { await rm(fixture, { recursive: true, force: true }); }

function mount() {
  const errors = [], vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  const reads = [], writes = [];
  // 36 px a strip, read from what the strips hold.
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { configurable: true, get() {
    if (!this.classList.contains("conversation-strips")) return 0;
    reads.push(this.children.length);
    return this.children.length * 36;
  } });
  const setProperty = w.CSSStyleDeclaration.prototype.setProperty;
  w.CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
    if (name === "--strips-height") writes.push(value);
    return setProperty.call(this, name, value, priority);
  };
  w.eval(bundle);
  const counts = () => ({ reads: reads.length, writes: [...writes] });
  return { w, errors, counts, close: () => w.close() };
}

test("re-rendered with the strips unchanged, they read and write nothing; a strip shown or gone is measured once, and written only if their height changed (T-51 #613 R2)", () => {
  const p = mount();
  try {
    p.w.renderStrips(0, false, false);
    const start = p.counts();
    assert.deepEqual(start.writes, ["0px"], "measured once as they mount");
    for (let n = 1; n <= 3; n++) p.w.renderStrips(n, false, false);
    assert.deepEqual(p.counts(), start, "re-rendered with the strips unchanged, they measure nothing and write nothing");
    p.w.renderStrips(4, true, false);
    const offer = p.counts();
    assert.deepEqual(offer.writes, ["0px", "36px"], "the offer shown: written once");
    for (let n = 5; n <= 7; n++) p.w.renderStrips(n, true, false);
    assert.deepEqual(p.counts(), offer, "and re-rendered with it unchanged, nothing again");
    // The offer goes as the source strip comes: what shows changed, their height did not.
    p.w.renderStrips(8, false, true);
    const swapped = p.counts();
    assert.equal(swapped.reads, offer.reads + 1, "what they show changed: measured");
    assert.deepEqual(swapped.writes, offer.writes, "writes nothing when its height has not changed");
    p.w.renderStrips(9, true, true);
    assert.deepEqual(p.counts().writes, ["0px", "36px", "72px"], "both shown: written once");
    p.w.renderStrips(10, false, false);
    assert.deepEqual(p.counts().writes, ["0px", "36px", "72px", "0px"], "none: written once");
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
