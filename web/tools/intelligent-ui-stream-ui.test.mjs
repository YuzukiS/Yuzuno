import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// YN-15: a reply's result block drawn as it is written. The real AgentReply
// and InteractiveResult in JSDOM, given the reply's text as it grows; no
// Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "intelligent-ui-stream-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {AgentReply} from ${JSON.stringify(path.join(root, "src/intelligent-ui/AgentReply.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderReply=(props)=>flushSync(()=>root.render(<AgentReply identity="a" onDraft={()=>{}} {...props}/>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "IntelligentUIStream", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const spec = {
  root: "result",
  elements: {
    result: { type: "Result", props: { title: "Two options", summary: "B is cheaper." }, children: ["options", "sources"] },
    options: {
      type: "Table",
      props: {
        id: "options",
        title: "Options",
        selectable: true,
        columns: [{ key: "name", label: "Option" }, { key: "cost", label: "Cost" }],
        rows: [
          { id: "a", cells: { name: "Plan Alder", cost: 12 }, sourceIds: ["price"] },
          { id: "b", cells: { name: "Plan Birch", cost: 9 } },
        ],
      },
    },
    sources: { type: "Sources", props: { items: [{ id: "price", label: "Price list", href: "https://example.com/prices" }] } },
  },
};
const body = JSON.stringify(spec);
const lead = "Plan Birch costs less.\n\n```yuzuno-ui\n";
/** The reply written up to and including `marker` in its block (all of it without one). */
const upTo = (marker, text = body) => lead + (marker ? text.slice(0, text.indexOf(marker) + marker.length) : text);
const closed = (text = body) => `${lead}${text}\n\`\`\`\n\nPick one.`;
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick(15);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function mount() {
  const errors = [];
  const requests = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
  window.eval(bundle);
  const document = window.document;
  const text = () => document.getElementById("root").textContent;
  const card = () => document.querySelector(".interactive-result");
  const live = () => document.querySelector(".interactive-result[data-live]");
  return { window, document, errors, requests, text, card, live, close: () => window.close() };
}

test("a block being written draws its checked parts in order, keeps room for the rest, and is inert until it closes", async (t) => {
  const page = mount();
  t.after(page.close);
  // The root is whole and the table's type is read: the card, with the table's room kept.
  page.window.renderReply({ text: upTo('"type":"Table"'), complete: false });
  const card = await until(page.live, "the card while it is written");
  assert.match(page.text(), /Plan Birch costs less\./);
  assert.match(card.querySelector("h3").textContent, /Two options/);
  assert.ok(card.hasAttribute("inert"), "nothing in it can be used yet");
  assert.equal(card.getAttribute("aria-busy"), "true");
  assert.match(card.querySelector(".result-live[role=status]").textContent, /Generating interactive result…/);
  const pending = [...card.querySelectorAll(".result-pending")].map((p) => [p.dataset.kind, p.style.minHeight]);
  assert.deepEqual(pending, [["table", "180px"], ["line", ""]]);
  assert.doesNotMatch(page.text(), /Plan Alder/, "a part still being written shows nothing of itself");
  assert.doesNotMatch(page.text(), /"root"|"type"/, "the JSON is never shown while it is written");
  assert.equal(card.querySelector(".result-original"), null, "its JSON is offered once it is whole");
  // The table has closed: drawn whole, the sources still to come.
  page.window.renderReply({ text: upTo('"sources":'), complete: false });
  await until(() => /Plan Alder/.test(page.text()), "the table");
  assert.equal(page.live(), card, "the same card");
  assert.match(page.text(), /Plan Birch/);
  assert.deepEqual([...card.querySelectorAll(".result-pending")].map((p) => p.dataset.kind), ["line"]);
  // Written whole but not closed: every part drawn, still inert until the whole check.
  page.window.renderReply({ text: upTo(null), complete: false });
  await tick();
  assert.equal(page.live(), card);
  assert.match(card.textContent, /Price list/);
  assert.equal(card.querySelectorAll(".result-pending").length, 0);
  assert.ok(card.hasAttribute("inert"));
  // Closed and checked whole: the same card, now usable, nothing in place of a part.
  page.window.renderReply({ text: closed(), complete: false });
  await until(() => !page.live() && page.card(), "the card once checked");
  assert.equal(page.card(), card, "it stays mounted: no second arrival");
  assert.ok(!card.hasAttribute("inert"));
  assert.equal(card.getAttribute("aria-busy"), null);
  assert.equal(card.querySelector(".result-live"), null);
  assert.equal(card.querySelectorAll(".result-pending").length, 0);
  assert.ok(card.querySelector(".result-original"), "its JSON can be read now");
  assert.match(page.text(), /Pick one\./);
  // A row chosen, then the same text again: the same card, the choice kept.
  card.querySelector('input[type="checkbox"]').click();
  await until(() => /1 selected/.test(card.textContent), "a row selected");
  page.window.renderReply({ text: closed(), complete: false });
  await tick();
  assert.equal(page.card(), card);
  assert.match(card.textContent, /1 selected/);
  // A later, different text is a new result: drawn anew, the choice not carried over (R1 P3).
  const changed = structuredClone(spec);
  changed.elements.result.props.title = "Two plans";
  page.window.renderReply({ text: closed(JSON.stringify(changed)), complete: false });
  const next = await until(() => page.card() !== card && /Two plans/.test(page.text()) && page.card(), "a new card for new text");
  assert.match(next.textContent, /0 selected/);
  assert.equal(page.requests.length, 0, "nothing is asked of Core");
  assert.deepEqual(page.errors, []);
});

test("drawn as it was written, a block that fails the whole check ends as the format note", async (t) => {
  const page = mount();
  t.after(page.close);
  const missing = structuredClone(spec);
  missing.elements.sources.props.items[0].id = "elsewhere"; // the table cites "price"
  const text = JSON.stringify(missing);
  page.window.renderReply({ text: upTo('"sources":', text), complete: false });
  await until(() => page.live() && /Plan Alder/.test(page.text()), "the table, checked on its own");
  page.window.renderReply({ text: closed(text), complete: false });
  const note = await until(() => page.document.querySelector('[data-result-state="format"]'), "the format note");
  assert.equal(page.card(), null, "nothing of the result stays");
  assert.match(note.textContent, /missing_source/);
  assert.ok(note.querySelector("details:not([open])"), "details and JSON are folded");
  assert.match(page.text(), /Plan Birch costs less\./);
});

test("a reply that ends before its block closes ends as the unfinished note", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderReply({ text: upTo('"sources":'), complete: false });
  await until(() => page.live() && /Plan Alder/.test(page.text()), "the table");
  page.window.renderReply({ text: upTo('"sources":'), complete: true });
  await until(() => page.document.querySelector('[data-result-state="unfinished"]'), "the unfinished note");
  assert.equal(page.card(), null);
  assert.doesNotMatch(page.text(), /Generating/);
});

test("text that cannot be JSON, or a root still being written, shows only the line said while it is generated", async (t) => {
  const page = mount();
  t.after(page.close);
  for (const text of [upTo('"title":"Two'), `${upTo('"type":"Table"')}]`, `${lead}// a note\n${body}`]) {
    page.window.renderReply({ text, complete: false });
    await tick();
    assert.equal(page.card(), null, text.slice(-20));
    assert.match(page.text(), /Generating interactive result…/);
  }
});

test("only a reply's first block is drawn as it is written", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderReply({ text: `${closed()}\n\n\`\`\`yuzuno-ui\n${body.slice(0, body.indexOf('"type":"Table"'))}`, complete: false });
  await until(() => page.card() && !page.live(), "the first result");
  assert.equal(page.document.querySelectorAll(".interactive-result").length, 1);
  assert.ok([...page.document.querySelectorAll(".result-placeholder")].some((p) => /Generating/.test(p.textContent)));
});
