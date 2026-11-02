import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-18: a section's report, a page over Home. The real Home, with Core
// answered here and the app's links stood in for. Synthetic data only; no
// Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "home-report-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Home} from ${JSON.stringify(path.join(root, "src/home/Home.tsx"))};
import {MessageLinks, reportLinkHref} from ${JSON.stringify(path.join(root, "src/deep-link.ts"))};
const root=createRoot(document.getElementById('root'));
const links={href:()=>null,open:(link)=>window.actions.push(['open',link]),
  reportHref:(link)=>reportLinkHref('https://report.test/',{workspaceId:'ws-1',...link}),
  openReport:(link,from)=>window.actions.push(['report',link,from])};
window.renderHome=(report=null,revision=0)=>root.render(<MessageLinks.Provider value={links}><Home workspaceId="ws-1" revision={revision} jobsRevision={0} agents={[]} projects={[]} readOnly={false} onNavigate={()=>{}} onChanged={()=>{}} onBackToReply={(link)=>window.actions.push(['back',link])} report={report}/></MessageLinks.Provider>);`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "HomeReport", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

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

// Home, as Core reads it. Section `id` is Core's identity on Home: kept
// through edits, a resolve and a seen card written again; new for a key
// written anew. Versions only rise under a key.
const owner = { agentId: "a", name: "Mori", state: "active" };
const longText = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the method notes.`).join("\n\n");
const reportBody = (conclusion = "Model B lowers validation loss by 4% on the synthetic set.") => ({ root: "body", elements: {
  body: { type: "BriefBody", props: {}, children: ["answer", "method", "loss", "long", "results", "sources"] },
  answer: { type: "Group", props: { tone: "accent" }, children: ["answer-text"] },
  "answer-text": { type: "Markdown", props: { text: conclusion } },
  method: { type: "Group", props: { title: "Method" }, children: ["method-text"] },
  "method-text": { type: "Markdown", props: { text: "Three seeds per arm, the same data order." } },
  loss: { type: "Metrics", props: { items: [{ label: "Validation loss", value: 0.412, previous: 0.429 }] } },
  long: { type: "Markdown", props: { text: longText } },
  results: { type: "Table", props: { id: "results", title: "Results", columns: [{ key: "model", label: "Model" }, { key: "loss", label: "Loss" }],
    rows: [{ id: "a", cells: { model: "A", loss: 0.429 }, sourceIds: ["run-a"] }, { id: "b", cells: { model: "B", loss: 0.412 }, sourceIds: ["run-b"] }] } },
  sources: { type: "Sources", props: { items: [{ id: "run-a", label: "Run A log", href: "https://example.test/run-a" }, { id: "run-b", label: "Run B log", href: "https://example.test/run-b" }] } },
} });
const section = (key, id, version, extra = {}) => ({ id, key, kind: "report", title: "Synthetic eval: model B vs A", version, owner,
  updatedAt: "2026-11-02T10:05:00Z", updatedTurnId: null, body: reportBody(), attachments: [], refs: {}, seen: null, history: false, ...extra });
const ask = section("paging", 10, 2, { kind: "ask", title: "Rows per page?", body: { root: "b", elements: { b: { type: "BriefBody", props: {}, children: [] } } },
  ask: { question: "How many rows per page?", reply: { options: [{ id: "fifty", label: "50" }], freeText: true }, state: "open" } });
const homeData = (sections, history = []) => ({
  generatedAt: "2026-11-02T10:30:00Z", order: ["p1"], needsYou: [],
  projects: [{ project: { id: "p1", name: "atlas-notes" }, agents: { working: 0, idle: 0, waiting: 0, error: 0, offline: 0, total: 0 },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 3, sections, history } }],
});
const machine = { at: "2026-11-02T10:30:00Z", cpu: { cores: 4, totalPct: 0, jobsPct: 0, agentsPct: 0, otherPct: 0 },
  memory: { totalMiB: 4096, usedMiB: 0, availableMiB: 4096, jobsMiB: 0, agentsMiB: 0 }, gpus: null, jobs: [] };
const linkTo = (version, extra = {}) => ({ workspaceId: "ws-1", projectId: "p1", key: "eval", version, sectionId: 7, ...extra });
const back = { workspaceId: "ws-1", agentId: "a", turnId: "t1", itemId: "i-2" };

function mount(read) {
  const errors = [];
  const requests = [];
  const copied = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://report.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (text) => { copied.push(text); } } });
  window.actions = [];
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET", body: init.body ?? null });
    const body = String(url) === "/api/home" ? read() : String(url) === "/api/machine-load" ? machine : { repositories: [], links: [] };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  const document = window.document;
  const report = () => document.querySelector(".home-report");
  const card = (key) => document.querySelector(`.home-view [data-section-key="${key}"]`);
  const button = (scope, label) => [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  const press = async (scope, label) => {
    const found = button(scope, label);
    assert.ok(found, `no button ${label}`);
    found.click();
    await tick();
    return found;
  };
  return { window, document, errors, requests, copied, report, card, button, press, close: () => window.close() };
}
async function openHome(read, incoming = null) {
  const page = mount(read);
  page.window.renderHome(incoming);
  await until(() => page.document.querySelector(".home-panel"), "Home read");
  await tick(40);
  return page;
}
const notice = (page) => page.report()?.querySelector(".report-notice p")?.textContent ?? null;
const blocks = (page) => [...page.report().querySelectorAll(".report-main > .report-block")].map((b) => b.id.replace("report-block-", ""));

test("a card opens its report over Home: the conclusion and key figure first, then the rest in the author's order", async (t) => {
  const page = await openHome(() => homeData([section("eval", 7, 3), ask]));
  t.after(page.close);
  // An Ask keeps its quick reply on Home and has no report.
  assert.equal(page.card("paging").querySelector(".home-report-open"), null);
  const opener = page.card("eval").querySelector(".home-report-open");
  assert.equal(opener.textContent.trim(), "Open report");
  opener.click();
  const report = await until(page.report, "the report");
  // Home stays mounted below, laid out but out of reach.
  const view = page.document.querySelector(".home-view");
  assert.ok(view.hasAttribute("inert") && view.classList.contains("is-under-report"));
  assert.ok(page.card("eval"), "the card is still there");
  // Its own history entry, so the browser's Back closes it.
  assert.equal(typeof page.window.history.state?.yuzunoReport, "number");
  const heading = report.querySelector(".report-head h1");
  assert.equal(heading.textContent, "Synthetic eval: model B vs A");
  assert.equal(page.document.activeElement, heading, "the title takes focus");
  assert.match(report.querySelector(".report-meta").textContent, /Mori.*version 3/);
  assert.match(report.querySelector(".report-crumb").textContent, /atlas-notes.*Report.*Synthetic eval/);
  // The summary: the same blocks the body has, the conclusion then the figure.
  assert.equal(report.querySelector(".report-lead").textContent.trim(), "Model B lowers validation loss by 4% on the synthetic set.");
  assert.match(report.querySelector(".report-hero").textContent, /Validation loss.*0\.412/);
  assert.deepEqual(blocks(page), ["method", "long", "results", "sources"]);
  // Each block once: the summary is not drawn again below it.
  assert.equal(report.textContent.split("Model B lowers validation loss").length - 1, 1);
  // Outline: the author's titled Groups and figures, in the rail and as Contents.
  const outline = (selector) => [...report.querySelectorAll(`${selector} .report-outline button`)].map((b) => b.textContent);
  assert.deepEqual(outline(".report-rail"), ["Method", "Results"]);
  assert.deepEqual(outline(".report-contents"), ["Method", "Results"]);
  // Sources on demand; long text whole in the page, folded by its height.
  const sources = report.querySelector("#report-block-sources");
  assert.equal(sources.tagName, "DETAILS");
  assert.equal(sources.open, false);
  assert.equal(sources.querySelector("summary").textContent, "2 sources");
  const long = report.querySelector("#report-block-long .report-fold");
  assert.ok(long.classList.contains("is-folded"));
  assert.match(long.textContent, /Line 30 of the method notes\./);
  // A table is the full one, rows and sources included.
  assert.match(report.querySelector("#report-block-results").textContent, /Results.*A.*0\.429.*B.*0\.412/s);
  assert.deepEqual(page.errors, []);
});

test("Copy report is the card's own, and Copy link names the section and version shown", async (t) => {
  const page = await openHome(() => homeData([section("eval", 7, 3)]));
  t.after(page.close);
  await page.press(page.card("eval"), "Copy report");
  page.card("eval").querySelector(".home-report-open").click();
  const report = await until(page.report, "the report");
  await page.press(report.querySelector(".report-actions"), "Copy report");
  await page.press(report.querySelector(".report-actions"), "Copy link");
  await until(() => page.copied.length === 3, "three copies");
  assert.equal(page.copied[1], page.copied[0]);
  assert.match(page.copied[0], /Model B lowers validation loss/);
  assert.equal(page.copied[2], "https://report.test/#/report?w=ws-1&p=p1&k=eval&v=3&s=7");
  assert.deepEqual(page.errors, []);
});

test("Back, Escape and the browser's Back close the report, and focus returns to the card's button", async (t) => {
  const page = await openHome(() => homeData([section("eval", 7, 3)]));
  t.after(page.close);
  const opener = page.card("eval").querySelector(".home-report-open");
  const closes = [
    ["Back", (report) => report.querySelector(".report-back").click()],
    ["Escape", (report) => report.querySelector(".report-head h1").dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
    ["browser Back", () => page.window.history.back()],
  ];
  for (const [how, close] of closes) {
    opener.click();
    const report = await until(page.report, `the report, before ${how}`);
    close(report);
    await until(() => !page.report(), `the report closed by ${how}`);
    await tick();
    assert.equal(page.document.activeElement, opener, `${how}: focus is back on Open report`);
    assert.ok(page.card("eval").hasAttribute("data-report-return"), `${how}: the card says where the page returned`);
    assert.ok(!page.document.querySelector(".home-view").hasAttribute("inert"));
    assert.equal(page.window.history.state?.yuzunoReport, undefined, `${how}: the report's entry is gone`);
  }
  // Escape in a text field is the field's.
  opener.click();
  const report = await until(page.report, "the report again");
  await page.press(report.querySelector(".report-actions"), "Reply");
  const field = await until(() => report.querySelector("textarea"), "the reply field");
  field.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  assert.ok(page.report(), "Escape in the reply field leaves the report open");
  assert.deepEqual(page.errors, []);
});

test("a report link from a conversation opens the report over Home, and Back returns to that message", async (t) => {
  const page = await openHome(() => homeData([section("eval", 7, 3)]), { link: linkTo(3), back, n: 1 });
  t.after(page.close);
  const report = await until(() => page.report()?.querySelector(".report-head h1") && page.report(), "the report");
  const backButton = report.querySelector(".report-back");
  assert.equal(backButton.textContent.trim(), "Back to the message");
  backButton.click();
  await until(() => page.window.actions.some(([kind]) => kind === "back"), "Back to the message");
  assert.deepEqual(page.window.actions.find(([kind]) => kind === "back")[1], back);
  assert.equal(page.report(), null);
  assert.deepEqual(page.errors, []);
});

test("what has become of the version linked is said from Home's reading, never guessed", async (t) => {
  // A later version: said, with a way to it, and no body of another version under the old one's link.
  let page = await openHome(() => homeData([section("eval", 7, 5, { body: reportBody("Model B lowers loss by 5%.") })]), { link: linkTo(3), back: null, n: 1 });
  let report = await until(page.report, "the report");
  assert.equal(notice(page), "This link is to version 3. The report is at version 5 now, and Home keeps only its newest version.");
  assert.equal(report.querySelector(".report-article"), null);
  await page.press(report, "Open version 5");
  report = await until(() => page.report()?.querySelector(".report-article") && page.report(), "version 5");
  assert.equal(notice(page), null);
  assert.match(report.querySelector(".report-meta").textContent, /version 5/);
  assert.equal(report.querySelector(".report-lead").textContent.trim(), "Model B lowers loss by 5%.");
  page.close();

  // In History: that row, with why, and nothing to mark seen or reply to.
  page = await openHome(() => homeData([], [section("eval", 7, 3, { history: true, historyReason: "seen", seen: { version: 3 } })]), { link: linkTo(3), back: null, n: 1 });
  report = await until(page.report, "the report");
  assert.equal(notice(page), "You marked this report seen; it is in History.");
  assert.ok(report.querySelector(".report-article"));
  assert.equal(page.button(report, "Seen"), undefined);
  assert.equal(page.button(report, "Reply"), undefined);
  page.close();

  // Another section under the key now: never shown as the one linked.
  page = await openHome(() => homeData([section("eval", 8, 4)]), { link: linkTo(3), back: null, n: 1 });
  report = await until(page.report, "the report");
  assert.match(notice(page), /^Home has no report it can tell is the one linked/);
  assert.equal(report.querySelector(".report-article"), null);
  await page.press(report, "Show the project on Home");
  await until(() => !page.report(), "the report closed");
  await until(() => page.document.getElementById("home-project-p1")?.hasAttribute("data-home-highlight"), "the project shown");
  page.close();

  // Its project is not on Home.
  page = await openHome(() => homeData([section("eval", 7, 3)]), { link: linkTo(3, { projectId: "p9" }), back: null, n: 1 });
  await until(page.report, "the report");
  assert.equal(notice(page), "This report's project is not on Home.");
  assert.equal(page.report().querySelector(".report-article"), null);
  page.close();

  // Another Workspace's link never reaches Home: App refuses it (deep-link test).
  t.diagnostic("version notices: later, History, another section, project gone");
});

test("a version arriving while the report is read keeps the version on screen and offers the new one", async (t) => {
  let current = homeData([section("eval", 7, 3)]);
  const page = await openHome(() => current);
  t.after(page.close);
  page.card("eval").querySelector(".home-report-open").click();
  const report = await until(page.report, "the report");
  current = homeData([section("eval", 7, 4, { body: reportBody("Model B lowers loss by 6%.") })]);
  page.window.renderHome(null, 1);
  await until(() => notice(page), "the notice");
  assert.equal(notice(page), "You are reading version 3. Version 4 has arrived.");
  assert.equal(report.querySelector(".report-lead").textContent.trim(), "Model B lowers validation loss by 4% on the synthetic set.");
  assert.match(report.querySelector(".report-meta").textContent, /version 3/);
  // Nothing of version 3 is offered as current: no Seen, no Reply on it.
  assert.equal(page.button(report, "Seen"), undefined);
  assert.equal(page.button(report, "Reply"), undefined);
  await page.press(report, "Open version 4");
  await until(() => page.report()?.querySelector(".report-lead")?.textContent.trim() === "Model B lowers loss by 6%.", "version 4");
  assert.equal(notice(page), null);
  assert.deepEqual(page.errors, []);
});

test("Seen on the report marks the version shown, and a body with only text still opens", async (t) => {
  const plain = section("plain", 12, 2, { body: { root: "b", elements: { b: { type: "BriefBody", props: {}, children: ["t"] }, t: { type: "Markdown", props: { text: "Only words here." } } } } });
  const page = await openHome(() => homeData([section("eval", 7, 3), plain]));
  t.after(page.close);
  page.card("eval").querySelector(".home-report-open").click();
  let report = await until(page.report, "the report");
  await page.press(report.querySelector(".report-actions"), "Seen");
  const seen = await until(() => page.requests.find((r) => r.method === "POST" && r.url.endsWith("/seen")), "the seen request");
  assert.equal(seen.url, "/api/projects/p1/brief/seen");
  assert.deepEqual(JSON.parse(seen.body), { sections: [{ key: "eval", version: 3 }] });
  report.querySelector(".report-back").click();
  await until(() => !page.report(), "closed");
  page.card("plain").querySelector(".home-report-open").click();
  report = await until(() => page.report()?.querySelector(".report-lead") && page.report(), "the plain report");
  assert.equal(report.querySelector(".report-lead").textContent.trim(), "Only words here.");
  assert.equal(report.querySelector(".report-hero"), null);
  assert.deepEqual(blocks(page), []);
  assert.equal(report.querySelector(".report-rail"), null);
  assert.deepEqual(page.errors, []);
});
