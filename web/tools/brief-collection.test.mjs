import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// YN-128 (YN-113 §3.6): a Collection drawn by Home's renderer, on its page
// (the section body, as the report page draws it) and on its card. The real
// BriefSectionBody and SummaryCard in JSDOM, with bodies first accepted by
// the real brief contract; Core is a fetch stub. Synthetic content only.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "brief-collection-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {BriefSectionBody} from ${JSON.stringify(path.join(root, "src/home/brief/BriefSectionBody.tsx"))};
import {CardFoldWorkspace} from ${JSON.stringify(path.join(root, "src/home/card-fold.tsx"))};
import {checkBriefSection} from ${JSON.stringify(path.join(root, "src/intelligent-ui/brief-contract.ts"))};
import {saveLanguagePreferences} from ${JSON.stringify(path.join(root, "src/i18n.ts"))};
import {SummaryCard} from ${JSON.stringify(path.join(root, "src/home/SummaryCard.tsx"))};
import {ReportOpen} from ${JSON.stringify(path.join(root, "src/home/report/report-open.ts"))};
import {sectionMarkdown} from ${JSON.stringify(path.join(root, "src/home/brief/brief-copy.ts"))};
window.sectionMarkdown=sectionMarkdown;
window.checkBriefSection=checkBriefSection;
window.chooseLanguage=(language)=>saveLanguagePreferences({language});
const root=createRoot(document.getElementById('root'));
window.renderSection=(section,projectId)=>flushSync(()=>root.render(<CardFoldWorkspace.Provider value=""><BriefSectionBody section={section} projectId={projectId}/></CardFoldWorkspace.Provider>));
window.renderCard=(section,projectId)=>flushSync(()=>root.render(<ReportOpen.Provider value={()=>{}}><SummaryCard section={section} projectId={projectId} workspaceId="ws" agents={[]} readOnly={true} onSeen={async()=>{}} deck/></ReportOpen.Provider>));
window.unmount=()=>flushSync(()=>root.render(null));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "BriefCollection", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick();
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const PROJECT = "proj-1";
const KEY = "digest/news";
const base = `/api/projects/${PROJECT}/brief`;

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
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}", blob: async () => new window.Blob(["x"], { type: "image/png" }) };
  };
  window.eval(bundle);
  return { window, document: window.document, errors, requests, close: () => window.close() };
}

const at = "2026-11-14T00:00:00Z";
const kept = (name, extra = {}) => ({ name, kind: "image", mime: "image/png", size: 2048, snapshot: true, mayChange: false, takenAt: at, width: 640, height: 360, ...extra });
/** Nine news items: the first two with pictures, every one with a link and a line; tags on some. */
const news = () => Array.from({ length: 9 }, (_, i) => ({
  id: `n${i}`, title: `Story ${i}`, text: `Line ${i}`, meta: i % 2 ? "Papers · 07:40" : "News · 08:10", href: `https://example.com/${i}`,
  ...(i < 2 ? { image: `n${i}.png`, alt: `Picture ${i}` } : {}),
  ...(i === 0 ? { tags: ["Agent", "RAG"] } : i === 3 ? { tags: ["Agent"] } : i === 5 ? { tags: ["Data"] } : {}),
}));
/** A report whose summary names the Collection; attachments as Core reports them. */
function report(page, layout, { size = "wide", items = news(), attachments = [kept("n0.png"), kept("n1.png")], title = "Picks" } = {}) {
  const names = [...new Set(items.flatMap((item) => (item.image ? [item.image] : [])))];
  const put = {
    key: KEY, kind: "report", title: "Today's news",
    attachments: names.map((name) => ({ name, path: `/runs/digest/${name}` })),
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "top", size } }, children: ["lead", "top"] },
      lead: { type: "Markdown", props: { text: "Nine stories today." } },
      top: { type: "Collection", props: { id: "top", ...(title ? { title } : {}), layout, items } },
    } },
  };
  const normalized = page.window.checkBriefSection(put);
  return {
    key: normalized.key, kind: normalized.kind, title: normalized.title, version: 3,
    owner: { agentId: "agent-a", name: "Digest", state: "active" },
    updatedAt: "2026-11-14T00:01:00Z", updatedTurnId: "turn-1", body: normalized.body,
    attachments, seen: null, history: false,
  };
}
const type = (window, input, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};

test("a grid on its page: every tile, its picture and link; tags filter, All shows all again, More shows tags past twelve; no search", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  // Fifteen tags across fourteen items: twelve shown, three behind More.
  const items = Array.from({ length: 14 }, (_, i) => ({ id: `g${i}`, title: `Tile ${i}`, tags: i === 0 ? ["Agent", "T0"] : [`T${i}`], ...(i === 1 ? { tags: ["Agent", "T1"] } : {}) }));
  items[0] = { ...items[0], image: "n0.png", alt: "Picture 0", href: "https://example.com/0" };
  items[2] = { ...items[2], image: "n1.png", alt: "Picture 1" };
  // n1.png is only referenced, not kept: no picture, its text alone.
  window.renderSection(report(page, "grid", { items, attachments: [kept("n0.png"), kept("n1.png", { snapshot: false })] }), PROJECT);
  const collection = document.querySelector('.brief-collection[data-layout="grid"]');
  assert.ok(collection && !collection.hasAttribute("data-face"));
  assert.equal(collection.querySelector("h4").textContent, "Picks");
  const tiles = () => [...collection.querySelectorAll(".brief-collection-items > li")].map((li) => li.getAttribute("data-item"));
  assert.equal(tiles().length, 14);
  const first = collection.querySelector('[data-item="g0"]');
  const img = first.querySelector("img");
  assert.equal(img.getAttribute("src"), `${base}/attachments/${encodeURIComponent(KEY)}/n0.png?version=3`);
  assert.equal(img.getAttribute("alt"), "Picture 0");
  assert.equal(first.querySelector(".brief-collection-picture").getAttribute("aria-label"), "Open image Picture 0");
  const link = first.querySelector(".brief-collection-title a");
  assert.deepEqual([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel"), link.textContent], ["https://example.com/0", "_blank", "noopener noreferrer", "Tile 0"]);
  assert.ok(!collection.querySelector('[data-item="g2"] img'), "a picture not kept is not drawn");
  assert.equal(collection.querySelector('[data-item="g2"] .brief-collection-title').textContent, "Tile 2");
  // The filter: All, then the first twelve tags in the order they first appear, then More.
  const group = collection.querySelector('.brief-collection-filters[role="group"]');
  assert.equal(group.getAttribute("aria-label"), "Filter by tag");
  const buttons = () => [...group.querySelectorAll("button")];
  assert.deepEqual(buttons().map((b) => b.textContent), ["All", "Agent", "T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "3 more"]);
  assert.deepEqual(buttons().slice(0, 3).map((b) => b.getAttribute("aria-pressed")), ["true", "false", "false"]);
  buttons()[1].click();
  await until(() => tiles().join() === "g0,g1", "only the items tagged Agent");
  assert.equal(buttons()[1].getAttribute("aria-pressed"), "true");
  assert.equal(collection.querySelector('.brief-collection-shown[role="status"]').textContent, "2 of 14 shown");
  const more = group.querySelector(".brief-collection-more-tags");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  more.click();
  await until(() => buttons().length === 17, "every tag");
  assert.equal(group.querySelector(".brief-collection-more-tags").textContent, "Fewer");
  group.querySelector('[data-tag="T13"]').click();
  await until(() => tiles().join() === "g13", "a tag past twelve filters too");
  group.querySelector(".brief-collection-more-tags").click();
  await until(() => buttons().length === 15, "fewer tags, the chosen one still shown");
  assert.equal(group.querySelector('[data-tag="T13"]').getAttribute("aria-pressed"), "true");
  buttons()[0].click();
  await until(() => tiles().length === 14, "All shows every item again");
  assert.ok(!collection.querySelector(".brief-collection-shown"));
  assert.ok(!collection.querySelector(".brief-collection-search"), "a grid has no search");
  assert.deepEqual(page.requests, [], "pictures are read by the browser from their address; nothing is fetched or sent");
  assert.deepEqual(page.errors, []);
});

test("a list on its page: a search in any case over titles, lines and meta, with the tag chosen; and when none matches", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.renderSection(report(page, "list"), PROJECT);
  const collection = document.querySelector('.brief-collection[data-layout="list"]');
  const rows = () => [...collection.querySelectorAll(".brief-collection-items > li")].map((li) => li.getAttribute("data-item"));
  assert.equal(rows().length, 9);
  assert.ok(collection.querySelector('[data-item="n0"] .brief-collection-row img'), "a row's small picture");
  assert.ok(!collection.querySelector('[data-item="n4"] img'));
  assert.deepEqual([...collection.querySelectorAll('[data-item="n0"] .brief-collection-tags li')].map((li) => li.textContent), ["Agent", "RAG"]);
  const search = collection.querySelector(".brief-collection-search input");
  assert.equal(search.getAttribute("aria-label"), "Search titles, text and sources");
  assert.ok(!collection.querySelector('.brief-collection-search button[aria-label="Clear search"]'), "nothing to clear yet");
  type(window, search, "STORY 3");
  await until(() => rows().join() === "n3", "the title, in any case");
  type(window, search, "papers");
  await until(() => rows().join() === "n1,n3,n5,n7", "the meta");
  assert.equal(collection.querySelector(".brief-collection-shown").textContent, "4 of 9 shown");
  collection.querySelector('[data-tag="Agent"]').click();
  await until(() => rows().join() === "n3", "the search with the tag");
  // Clear empties the search; the tag stays.
  collection.querySelector('.brief-collection-search button[aria-label="Clear search"]').click();
  await until(() => search.value === "" && rows().join() === "n0,n3", "cleared, the tag still on");
  type(window, search, "line 8");
  await until(() => collection.querySelector(".brief-collection-none")?.textContent === "No item matches.", "none matches");
  collection.querySelector(".brief-collection-filters button").click();
  await until(() => rows().join() === "n8", "All, the search still on");
  window.chooseLanguage("zh-Hans");
  window.renderSection(report(page, "list"), PROJECT);
  await until(() => document.querySelector(".brief-collection-shown")?.textContent === "显示 1 条，共 9 条", "Chinese, the search kept");
  assert.equal(document.querySelector(".brief-collection-filters button").textContent, "全部");
  window.chooseLanguage("en");
  assert.deepEqual(page.errors, []);
});

test("a carousel: a region of slides for screen readers; arrows and ← → move one page; dots up to twelve, n / N always; nothing moves by itself", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  window.renderSection(report(page, "carousel", { items: news().slice(0, 5) }), PROJECT);
  const region = document.querySelector('.brief-carousel[role="region"]');
  assert.deepEqual([region.getAttribute("aria-roledescription"), region.getAttribute("aria-label")], ["carousel", "Picks"]);
  const track = region.querySelector(".brief-carousel-track");
  assert.equal(track.getAttribute("tabindex"), "0");
  const slides = [...track.querySelectorAll('[role="group"]')];
  assert.deepEqual(slides.map((s) => [s.getAttribute("aria-roledescription"), s.getAttribute("aria-label")]), [1, 2, 3, 4, 5].map((n) => ["slide", `${n} / 5`]));
  assert.ok(slides[0].querySelector(".brief-collection-tile img"));
  const [previous, next] = [...region.querySelectorAll(".brief-carousel-move")];
  assert.deepEqual([previous.getAttribute("aria-label"), next.getAttribute("aria-label")], ["Previous", "Next"]);
  assert.equal(previous.getAttribute("aria-controls"), track.id);
  const count = () => region.querySelector(".brief-carousel-count").textContent;
  const dots = () => [...region.querySelectorAll(".brief-carousel-dots li")].map((li) => li.hasAttribute("data-current"));
  assert.equal(count(), "1 / 5");
  assert.deepEqual(dots(), [true, false, false, false, false]);
  assert.ok(previous.disabled && !next.disabled);
  next.click();
  await until(() => count() === "2 / 5", "Next");
  assert.deepEqual(dots(), [false, true, false, false, false]);
  assert.ok(!previous.disabled);
  track.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await until(() => count() === "3 / 5", "→");
  slides[2].querySelector("a").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await until(() => count() === "2 / 5", "← from a link in a page");
  // Nothing turns the pages by itself (WCAG 2.2.2).
  await tick(400);
  assert.equal(count(), "2 / 5");
  // One press at a time, as a reader's taps arrive: each is drawn before the next.
  for (const n of [3, 4, 5]) {
    next.click();
    await until(() => count() === `${n} / 5`, `page ${n}`);
  }
  assert.ok(next.disabled, "Next stops at the last page");
  assert.ok(!region.closest(".brief-collection").querySelector(".brief-collection-filters"), "a carousel has no filter");
  // Past twelve pages: n / N alone. (A section drawn anew; the same block redrawn keeps the page the reader is on, as Steps keeps its step.)
  const many = Array.from({ length: 13 }, (_, i) => ({ id: `m${i}`, title: `Page ${i}` }));
  window.unmount();
  window.renderSection(report(page, "carousel", { items: many, attachments: [], title: null }), PROJECT);
  assert.ok(!document.querySelector(".brief-carousel-dots"));
  assert.equal(document.querySelector(".brief-carousel-count").textContent, "1 / 13");
  assert.equal(document.querySelector(".brief-carousel").getAttribute("aria-label"), "Items", "named for what it is without a title");
  assert.deepEqual(page.errors, []);
});

test("on a card: a carousel whole, a grid's row or two, a list's first rows, a small card's first item, with how many there are; no filter or search", async (t) => {
  const page = mount();
  t.after(page.close);
  const { document, window } = page;
  const drawn = () => [...document.querySelectorAll(".home-card-frame.kind-collection .brief-collection-items > li, .home-card-frame.kind-collection .brief-carousel-page")].map((li) => li.getAttribute("data-item"));
  const total = () => document.querySelector(".home-card-frame .brief-collection-total")?.textContent ?? null;
  for (const [layout, size, items, count, opens] of [
    ["grid", "wide", ["n0", "n1", "n2"], "9 items", true],
    ["grid", "large", ["n0", "n1", "n2", "n3", "n4", "n5"], "9 items", true],
    ["list", "wide", ["n0", "n1", "n2"], "9 items", true],
    ["list", "large", ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"], "9 items", true],
    ["carousel", "wide", ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"], null, false],
    ["carousel", "large", ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"], null, false],
    ["carousel", "small", ["n0"], "9 items", true],
    ["grid", "small", ["n0"], "9 items", true],
    ["list", "small", ["n0"], "9 items", true],
  ]) {
    window.renderCard(report(page, layout, { size }), PROJECT);
    const label = `${layout} ${size}`;
    const card = document.querySelector(".home-summary-card");
    assert.equal(card.getAttribute("data-card-size"), size, label);
    const frame = card.querySelector(".home-card-frame.kind-collection");
    assert.ok(frame && !frame.closest("[inert]"), `${label}: works on the card`);
    assert.ok(card.querySelector(".home-summary-body.has-figure.has-collection"), `${label}: under the text`);
    assert.equal(frame.querySelector(".brief-collection").getAttribute("data-face"), size, label);
    assert.deepEqual(drawn(), items, label);
    assert.equal(total(), count, label);
    assert.ok(!frame.querySelector(".brief-collection-filters, input, h4"), `${label}: no filter, search or title`);
    assert.equal(!!card.querySelector(".home-report-open"), opens, `${label}: Open report`);
    assert.equal(frame.querySelector('[data-item="n0"] .brief-collection-title a').getAttribute("target"), "_blank", label);
    window.unmount();
  }
  window.chooseLanguage("zh-Hans");
  window.renderCard(report(page, "grid", { size: "wide" }), PROJECT);
  assert.equal(total(), "共 9 条");
  window.chooseLanguage("en");
  assert.deepEqual(page.errors, []);
});

test("Copy report writes a line per item: its title linked to its page, its line, its tags", (t) => {
  const page = mount();
  t.after(page.close);
  const copied = page.window.sectionMarkdown(report(page, "list"), "en", { clock: "h24", timeZone: "UTC" });
  assert.match(copied, /#+ Picks\n+- \[Story 0\]\(<https:\/\/example\.com\/0>\) — Line 0 #Agent #RAG\n- \[Story 1\]\(<https:\/\/example\.com\/1>\) — Line 1\n/);
  const plain = report(page, "grid", { items: [{ id: "a", title: "1. First" }, { id: "b", title: "Second", text: "Uses *stars*", tags: ["C#"] }], attachments: [], title: null });
  assert.match(page.window.sectionMarkdown(plain, "en", { clock: "h24", timeZone: "UTC" }), /- 1\\\. First\n- Second — Uses \\\*stars\\\* #C\\#/);
  assert.deepEqual(page.errors, []);
});
