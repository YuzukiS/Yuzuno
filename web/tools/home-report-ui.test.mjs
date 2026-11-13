import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { composerText, setComposerText } from "./composer-driver.mjs";
import { checkBriefSection } from "../src/intelligent-ui/brief-contract.ts";
import { doseStudy, fixtureFiles } from "./research-fixtures.mjs";

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
import {flushSync} from 'react-dom';
import {Home} from ${JSON.stringify(path.join(root, "src/home/Home.tsx"))};
import {MessageLinks, reportLinkHref} from ${JSON.stringify(path.join(root, "src/deep-link.ts"))};
const root=createRoot(document.getElementById('root'));
const links={href:()=>null,open:(link)=>window.actions.push(['open',link]),
  reportHref:(link)=>reportLinkHref('https://report.test/',{workspaceId:'ws-1',...link}),
  openReport:(link,from)=>window.actions.push(['report',link,from])};
// A Project's page, where its cards are (YN-86): p1's unless a test starts on the whole of Home (startProject null);
// opening one is recorded, and opens it as the app does, at the card named.
function Shell({report,revision,workspaceId,visit,arrival}){
  const [project,setProject]=React.useState(window.startProject===undefined?'p1':window.startProject);
  const [jump,setJump]=React.useState(null);
  return <MessageLinks.Provider value={links}><Home workspaceId={workspaceId} revision={revision} jobsRevision={0} agents={[]} projects={[]} readOnly={false} onNavigate={()=>{}} onChanged={()=>{}} onBackToReply={(link)=>window.actions.push(['back',link])}
    project={project} jumpTo={jump} onCloseProject={()=>setProject(null)}
    onOpenProject={(id,key)=>{window.actions.push(['project',id,key]);setProject(id);setJump((j)=>({projectId:id,sectionKey:key,n:(j?.n??0)+1}));}} report={report} visit={visit} arrival={arrival}/></MessageLinks.Provider>;
}
const home=(report,revision,workspaceId,visit,arrival)=><Shell report={report} revision={revision} workspaceId={workspaceId} visit={visit} arrival={arrival}/>;
// visit: bumped on each explicit way to Home (App's goHome); arrival: a reply's Open on Home.
window.renderHome=(report=null,revision=0,workspaceId='ws-1',visit=0,arrival=null)=>root.render(home(report,revision,workspaceId,visit,arrival));
// Drawn before returning: what the first frame shows.
window.renderHomeNow=(report=null,revision=0,workspaceId='ws-1')=>flushSync(()=>root.render(home(report,revision,workspaceId,0,null)));`,
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
const longText = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the notes.`).join("\n\n");
// The author names the summary (conclusion, conditions, one figure) and the
// part that starts folded on the root (T-18 contract), by the blocks' ids.
const reportBody = (conclusion = "Model B lowers validation loss by 4% on the synthetic set.") => ({ root: "body", elements: {
  body: { type: "BriefBody", props: { summary: { lead: "answer", visual: "loss", conditions: "holds" }, details: ["method"] },
    children: ["answer", "holds", "loss", "method", "long", "evidence", "sources"] },
  answer: { type: "Markdown", props: { text: conclusion } },
  holds: { type: "Checklist", props: { items: [{ id: "def", text: "Scoring definition v2", done: true }, { id: "data", text: "Synthetic data, 100 items per arm", done: true }] } },
  loss: { type: "Metrics", props: { items: [{ label: "Validation loss", value: 0.412, previous: 0.429 }] } },
  method: { type: "Group", props: { title: "Method" }, children: ["method-text"] },
  "method-text": { type: "Markdown", props: { text: "Three seeds per arm, the same data order." } },
  long: { type: "Markdown", props: { text: longText } },
  evidence: { type: "Group", props: { title: "Evidence" }, children: ["results"] },
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
    // Something unseen, so the panel is open (a quiet one starts folded).
    errors: [], pending: [], jobs: [], unseen: 1, missing: [], brief: { version: 3, sections, history } }],
});
const machine = { at: "2026-11-02T10:30:00Z", cpu: { cores: 4, totalPct: 0, jobsPct: 0, agentsPct: 0, otherPct: 0 },
  memory: { totalMiB: 4096, usedMiB: 0, availableMiB: 4096, jobsMiB: 0, agentsMiB: 0 }, gpus: null, jobs: [] };
const linkTo = (version, extra = {}) => ({ workspaceId: "ws-1", projectId: "p1", key: "eval", version, sectionId: 7, ...extra });
const address = (version) => `#/report?w=ws-1&p=p1&k=eval&v=${version}&s=7`;
const back = { workspaceId: "ws-1", agentId: "a", turnId: "t1", itemId: "i-2" };

function mount(read, answer = () => undefined) {
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
  // jsdom has no element scrolling; a Project's page starts at its top (Home.tsx).
  window.HTMLElement.prototype.scrollTo = function () {};
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (text) => { copied.push(text); } } });
  window.actions = [];
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET", body: init.body ?? null });
    // Home's read may be held (a promise) or refused (an Error), as Core's can.
    const body = String(url) === "/api/home" ? await read() : String(url) === "/api/machine-load" ? machine : answer(String(url)) ?? { repositories: [], links: [] };
    if (body instanceof Error) {
      const refused = { error: body.message };
      return { ok: false, status: 503, json: async () => refused, text: async () => JSON.stringify(refused) };
    }
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
async function openHome(read, incoming = null, answer, project = "p1") {
  const page = mount(read, answer);
  page.window.startProject = project;
  page.window.renderHome(incoming);
  await until(() => page.document.querySelector(".project-home, .home-layout"), "Home read");
  await tick(40);
  return page;
}
const notice = (page) => page.report()?.querySelector(".report-notice p")?.textContent ?? null;
const flow = (page) => [...page.report().querySelectorAll(".report-main > .report-block")].map((b) => b.id.replace("report-block-", ""));
const once = (page, text) => page.report().textContent.split(text).length - 1;

test("a card opens its report as a page over Home: the summary its author named first, each block once, then the rest in order", async (t) => {
  const page = await openHome(() => homeData([section("eval", 7, 3), ask]));
  t.after(page.close);
  // An Ask keeps its quick reply on Home and has no report.
  assert.equal(page.card("paging").querySelector(".home-report-open"), null);
  const opener = page.card("eval").querySelector(".home-report-open");
  assert.equal(opener.textContent.trim(), "Open report");
  const before = page.window.history.length;
  opener.click();
  const report = await until(page.report, "the report");
  // Home stays mounted below, laid out but out of reach.
  const view = page.document.querySelector(".home-view");
  assert.ok(view.hasAttribute("inert") && view.classList.contains("is-under-report"));
  assert.ok(page.card("eval"), "the card is still there");
  // One history entry of its own, with the report's link in the address.
  assert.equal(page.window.history.length, before + 1);
  assert.equal(typeof page.window.history.state?.yuzunoReport, "number");
  assert.equal(page.window.location.hash, address(3));
  const heading = report.querySelector(".report-head h1");
  assert.equal(heading.textContent, "Synthetic eval: model B vs A");
  assert.equal(page.document.activeElement, heading, "the title takes focus");
  assert.match(report.querySelector(".report-meta").textContent, /Mori.*version 3/);
  assert.match(report.querySelector(".report-crumb").textContent, /atlas-notes.*Report.*Synthetic eval/);
  // The summary, as named: the conclusion, what it holds under (whole), the figure.
  assert.equal(report.querySelector(".report-lead").textContent.trim(), "Model B lowers validation loss by 4% on the synthetic set.");
  assert.match(report.querySelector(".report-conditions").textContent, /Conditions.*Scoring definition v2.*Synthetic data, 100 items per arm/);
  assert.match(report.querySelector(".report-hero").textContent, /Validation loss.*0\.412/);
  // Each block once; the rest in the author's order; sources beside the body, not in it.
  for (const text of ["Model B lowers validation loss", "Scoring definition v2", "Validation loss"]) assert.equal(once(page, text), 1, text);
  assert.deepEqual(flow(page), ["method", "long", "evidence"]);
  assert.ok(report.querySelector(".report-rail #report-block-sources"));
  assert.equal(report.querySelector(".report-main #report-block-sources"), null);
  // Nothing folds but what the author named: long text whole, the method folded under its title.
  assert.equal(report.querySelector("#report-block-long .report-detail-toggle"), null);
  assert.match(report.querySelector("#report-block-long").textContent, /Line 30 of the notes\./);
  const method = report.querySelector("#report-block-method");
  const toggle = method.querySelector(".report-detail-toggle");
  assert.equal(toggle.textContent, "Method");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.ok(method.querySelector(".report-detail-body").hasAttribute("inert"), "a folded preview is not reached");
  toggle.click();
  await tick();
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.ok(!method.querySelector(".report-detail-body").hasAttribute("inert"));
  // The outline and figures: titled parts in the rail, and as Contents with the sources.
  const outline = (selector) => [...report.querySelectorAll(`${selector} .report-outline button`)].map((b) => b.textContent);
  assert.deepEqual(outline("nav.report-rail-part"), ["Method", "Evidence"]);
  assert.deepEqual(outline(".report-contents"), ["Method", "Evidence", "Sources & attachments"]);
  assert.deepEqual([...report.querySelectorAll(".report-figures button")].map((b) => b.textContent), ["Results2 rows"]);
  // Jumping in the outline adds no history entry.
  const length = page.window.history.length;
  report.querySelector(".report-contents .report-outline button").click();
  await tick();
  assert.equal(page.window.history.length, length);
  assert.equal(page.window.location.hash, address(3));
  assert.deepEqual(page.errors, []);
});

test("the fixture is a section the contract accepts, and its card shows the named conclusion with its conditions and figure, and no other block", async (t) => {
  // The body this page reads is one Core takes (brief-contract.ts), summary and details included.
  const checked = checkBriefSection({ key: "eval", kind: "report", title: "Synthetic eval: model B vs A", body: reportBody() });
  assert.deepEqual(checked.body.elements.body.props, { summary: { lead: "answer", visual: "loss", conditions: "holds" }, details: ["method"] });
  const page = await openHome(() => homeData([section("eval", 7, 3)]));
  t.after(page.close);
  const card = page.card("eval");
  assert.equal(card.querySelector(".home-summary-lead").textContent.trim(), "Model B lowers validation loss by 4% on the synthetic set.");
  const conditions = card.querySelector(".home-card-conditions");
  assert.equal(conditions.getAttribute("aria-label"), "Conditions");
  assert.deepEqual([...conditions.querySelectorAll(".home-card-condition-chips li")].map((li) => li.textContent), ["Scoring definition v2", "Synthetic data, 100 items per arm"]);
  // Two Metrics values make a small card: its figure as big numbers, no frame (T-18, Dev 7's v12).
  assert.equal(card.dataset.cardSize, "small");
  assert.ok(!card.querySelector(".home-card-frame"), "a small card has no frame");
  assert.match(card.querySelector(".home-card-numbers").textContent, /Validation loss.*0\.412/);
  // Nothing else of the body is on Home: the method, the notes and the table are read on the page.
  assert.doesNotMatch(card.textContent, /Three seeds per arm|Line 1 of the notes|Results/);
  assert.equal(card.querySelector(".home-fold"), null, "no fold: the body is read on its page");
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
  assert.match(page.copied[0], /Line 30 of the notes\./, "the whole body, the folded part and the long text too");
  assert.equal(page.copied[2], `https://report.test/${address(3)}`);
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
    assert.equal(page.window.history.state?.yuzunoReport, undefined, `${how}: the report's entry is left`);
    assert.equal(page.window.location.hash, "", `${how}: the address is Home's again`);
  }
  // Escape in a text field is the field's; a draft written there stays the card's.
  opener.click();
  const report = await until(page.report, "the report again");
  await page.press(report.querySelector(".report-actions"), "Reply");
  const field = await until(() => report.querySelector(".home-card-reply [data-composer-input]"), "the reply field");
  field.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  assert.ok(page.report(), "Escape in the reply field leaves the report open");
  // Nothing was marked seen by opening and closing: each opening of the live version it drew only says it was
  // opened (YN-86), that version and no other.
  const written = page.requests.filter((r) => r.method !== "GET" && !r.url.endsWith("/github_repositories"));
  assert.ok(written.length > 0 && written.every((r) => r.url === "/api/projects/p1/brief/opened"), JSON.stringify(written.map((r) => r.url)));
  assert.deepEqual(JSON.parse(written[0].body), { workspaceId: "ws-1", sectionId: 7, key: "eval", version: 3 });
  assert.deepEqual(page.errors, []);
});

test("a report link from a conversation opens the report over Home, and Back returns to that message", async (t) => {
  const page = await openHome(() => homeData([section("eval", 7, 3)]), { link: linkTo(3), back, fromAddress: false, n: 1 });
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

test("a link from the address takes its own history entry, and the page's Back stays in Yuzuno", async (t) => {
  const page = mount(() => homeData([section("eval", 7, 3)]));
  t.after(page.close);
  page.window.history.replaceState(null, "", `/${address(3)}`);
  const length = page.window.history.length;
  page.window.renderHome({ link: linkTo(3), back: null, fromAddress: true, n: 1 });
  const report = await until(() => page.report()?.querySelector(".report-head h1") && page.report(), "the report");
  assert.equal(page.window.history.length, length, "no entry added");
  assert.equal(page.window.location.hash, address(3));
  report.querySelector(".report-back").click();
  await until(() => !page.report(), "closed");
  assert.equal(page.window.history.length, length);
  assert.equal(page.window.location.hash, "");
  assert.equal(page.window.location.href, "https://report.test/", "still this page");
  assert.deepEqual(page.errors, []);
});

test("only the very version linked is shown, live or in History; otherwise the versions there are are offered", async (t) => {
  // Not kept: said, the current version offered, and no body of another version under its link.
  let page = await openHome(() => homeData([section("eval", 7, 5, { body: reportBody("Model B lowers loss by 5%.") })]), { link: linkTo(3), back: null, fromAddress: false, n: 1 });
  let report = await until(page.report, "the report");
  assert.equal(notice(page), "Version 3 of this report is not on Home: Home keeps a report's newest version and the versions in its History.");
  assert.equal(report.querySelector(".report-article"), null);
  await page.press(report, "Open version 5 (current)");
  report = await until(() => page.report()?.querySelector(".report-article") && page.report(), "version 5");
  assert.equal(notice(page), null);
  assert.match(report.querySelector(".report-meta").textContent, /version 5/);
  assert.equal(report.querySelector(".report-lead").textContent.trim(), "Model B lowers loss by 5%.");
  assert.equal(page.window.location.hash, address(5));
  page.close();

  // Kept in History while a newer one is live: that very version, why it is there, and the newer one offered.
  page = await openHome(() => homeData([section("eval", 7, 5, { body: reportBody("Model B lowers loss by 5%.") })],
    [section("eval", 7, 3, { history: true, historyReason: "seen", seen: { version: 3 } })]), { link: linkTo(3), back: null, fromAddress: false, n: 1 });
  report = await until(page.report, "the report");
  assert.equal(notice(page), "You marked this report seen; it is in History. Version 5 is current.");
  assert.equal(report.querySelector(".report-lead").textContent.trim(), "Model B lowers validation loss by 4% on the synthetic set.");
  assert.equal(page.button(report, "Seen"), undefined);
  assert.equal(page.button(report, "Reply"), undefined);
  assert.ok(page.button(report, "Open version 5"));
  page.close();

  // YN-86 S2a: archived with its card's task, said so, never as removed by its author.
  page = await openHome(() => homeData([], [section("eval", 7, 3, { history: true, historyReason: "archived" })]), { link: linkTo(3), back: null, fromAddress: false, n: 1 });
  report = await until(page.report, "the report");
  assert.equal(notice(page), "Archived: the task of this report's card ended; it is in History.");
  page.close();

  // Only other versions kept: each offered by where it is.
  page = await openHome(() => homeData([], [section("eval", 7, 4, { history: true, historyReason: "resolved" })]), { link: linkTo(3), back: null, fromAddress: false, n: 1 });
  report = await until(page.report, "the report");
  assert.match(notice(page), /^Version 3 of this report is not on Home/);
  assert.ok(page.button(report, "Open version 4 (in History)"));
  page.close();

  // Another section under the key now: never shown as the one linked. Over the whole of Home, it shows its project's page.
  page = await openHome(() => homeData([section("eval", 8, 3)]), { link: linkTo(3), back: null, fromAddress: false, n: 1 }, undefined, null);
  report = await until(page.report, "the report");
  assert.match(notice(page), /^Home has no report it can tell is the one linked/);
  assert.equal(report.querySelector(".report-article"), null);
  await page.press(report, "Show the project on Home");
  await until(() => !page.report(), "the report closed");
  await until(() => page.window.actions.some(([kind]) => kind === "project"), "the Project's page opened");
  assert.deepEqual(JSON.parse(JSON.stringify(page.window.actions.find(([kind]) => kind === "project"))), ["project", "p1", "eval"]);
  await until(() => page.document.querySelector('[data-project-home="p1"]'), "on the Project's page");
  page.close();

  // Its project is not on Home.
  page = await openHome(() => homeData([section("eval", 7, 3)]), { link: linkTo(3, { projectId: "p9" }), back: null, fromAddress: false, n: 1 });
  await until(page.report, "the report");
  assert.equal(notice(page), "This report's project is not on Home.");
  assert.equal(page.report().querySelector(".report-article"), null);
  page.close();
});

test("a version arriving while the report is read keeps the version on screen, never mixed, and offers the new one", async (t) => {
  let current = homeData([section("eval", 7, 3)]);
  const page = await openHome(() => current);
  t.after(page.close);
  page.card("eval").querySelector(".home-report-open").click();
  const report = await until(page.report, "the report");
  current = homeData([section("eval", 7, 4, { body: reportBody("Model B lowers loss by 6%.") })]);
  page.window.renderHome(null, 1);
  await until(() => notice(page), "the notice");
  assert.equal(notice(page), "You are reading version 3. Version 4 has arrived; parts of version 3 read from its files may no longer show.");
  assert.equal(report.querySelector(".report-lead").textContent.trim(), "Model B lowers validation loss by 4% on the synthetic set.");
  assert.equal(once(page, "Model B lowers loss by 6%."), 0, "nothing of version 4 under version 3");
  assert.match(report.querySelector(".report-meta").textContent, /version 3/);
  assert.equal(page.button(report, "Seen"), undefined);
  assert.equal(page.button(report, "Reply"), undefined);
  await page.press(report, "Open version 4");
  await until(() => page.report()?.querySelector(".report-lead")?.textContent.trim() === "Model B lowers loss by 6%.", "version 4");
  assert.equal(notice(page), null);
  assert.deepEqual(page.errors, []);
});

test("Seen on the report marks the version shown; Back then focuses its project's page, the card having moved to History", async (t) => {
  let current = homeData([section("eval", 7, 3)]);
  const page = await openHome(() => current);
  t.after(page.close);
  page.card("eval").querySelector(".home-report-open").click();
  const report = await until(page.report, "the report");
  // A reply being written on the page (T-174) stays through its Seen: the version
  // seen is still one a reply can refer to (T-18, Lead 2655).
  await page.press(report.querySelector(".report-actions"), "Reply");
  const field = await until(() => report.querySelector(".home-card-reply [data-composer-input]"), "the reply field");
  setComposerText(field, "Kept through Seen");
  await tick();
  current = homeData([], [section("eval", 7, 3, { history: true, historyReason: "seen", seen: { version: 3 } })]);
  await page.press(report.querySelector(".report-actions"), "Seen");
  const seen = await until(() => page.requests.find((r) => r.method === "POST" && r.url.endsWith("/seen")), "the seen request");
  assert.equal(seen.url, "/api/projects/p1/brief/seen");
  assert.deepEqual(JSON.parse(seen.body), { sections: [{ key: "eval", version: 3 }] });
  await until(() => notice(page) === "You marked this report seen; it is in History.", "the History note");
  assert.equal(report.querySelector(".home-card-reply [data-composer-input]") === field, true, "the same reply field");
  assert.equal(composerText(field), "Kept through Seen");
  assert.equal(page.button(report.querySelector(".report-actions"), "Reply")?.getAttribute("aria-expanded"), "true", "Reply stays, open");
  report.querySelector(".report-back").click();
  await until(() => !page.report(), "closed");
  await tick();
  assert.equal(page.card("eval"), null, "the card left for History");
  const head = page.document.querySelector('[data-project-home="p1"] .project-home-head h1');
  assert.ok(page.document.activeElement === head, "focus falls back to its project's page");
  assert.deepEqual(page.errors, []);
});

test("a body that names no summary opens as written: nothing lifted or folded", async (t) => {
  const plain = section("plain", 12, 2, { body: { root: "b", elements: {
    b: { type: "BriefBody", props: {}, children: ["t", "chart", "more"] },
    t: { type: "Markdown", props: { text: "Only words here." } },
    chart: { type: "Metrics", props: { items: [{ label: "Runs", value: 3 }] } },
    more: { type: "Markdown", props: { text: longText } },
  } } });
  const page = await openHome(() => homeData([plain]));
  t.after(page.close);
  page.card("plain").querySelector(".home-report-open").click();
  const report = await until(() => page.report()?.querySelector(".report-head h1") && page.report(), "the plain report");
  assert.equal(report.querySelector(".report-lead"), null);
  assert.equal(report.querySelector(".report-hero"), null);
  assert.equal(report.querySelector(".report-conditions"), null);
  assert.deepEqual(flow(page), ["t", "chart", "more"]);
  assert.equal(report.querySelector(".report-detail"), null);
  assert.deepEqual(page.errors, []);
});

test("a report open in one Workspace is gone from the first frame of another, even under the same project, key, identity and version (T-18 R2)", async (t) => {
  let current = homeData([section("eval", 7, 3)]);
  const page = await openHome(() => current);
  t.after(page.close);
  page.card("eval").querySelector(".home-report-open").click();
  await until(() => page.report()?.querySelector(".report-lead"), "the report in ws-1");
  // Core at this address answers as ws-2 now; its first read is held.
  let answer;
  current = new Promise((resolve) => { answer = resolve; });
  page.window.renderHomeNow(null, 0, "ws-2");
  assert.equal(page.report(), null, "not drawn in the first frame of ws-2");
  assert.doesNotMatch(page.document.body.textContent, /Model B lowers validation loss/);
  assert.ok(!page.document.querySelector(".home-view").hasAttribute("inert"), "ws-2's Home is not held under it");
  // Its read brings a section with the very same project, key, identity and version.
  answer(homeData([section("eval", 7, 3, { body: reportBody("Workspace two's own conclusion.") })]));
  await until(() => page.card("eval"), "ws-2's card");
  await tick(40);
  assert.equal(page.report(), null, "never drawn over ws-2's own section");
  assert.doesNotMatch(page.document.body.textContent, /Model B lowers validation loss/);
  assert.equal(page.window.location.hash, "", "the report's address is left");
  assert.equal(page.window.history.state?.yuzunoReport, undefined);
  // Only ws-1's own report said it was opened there (YN-86); nothing was done in ws-2.
  assert.deepEqual(page.requests.filter((r) => r.method !== "GET" && !r.url.endsWith("/github_repositories")
    && !(r.url === "/api/projects/p1/brief/opened" && JSON.parse(r.body).workspaceId === "ws-1")), [], "nothing was done in ws-2");
  // Back on ws-1, nothing of that report comes back by itself.
  page.window.renderHomeNow(null, 0, "ws-1");
  assert.equal(page.report(), null);
  assert.deepEqual(page.errors, []);
});

test("a report link whose first read of Home fails says so with Try again, never Reading; a failed refresh keeps the last reading (T-18 R2)", async (t) => {
  let refuse = true;
  const page = mount(() => (refuse ? new Error("Core is restarting") : homeData([section("eval", 7, 3)])));
  t.after(page.close);
  page.window.renderHome({ link: linkTo(3), back: null, fromAddress: false, n: 1 });
  const failure = await until(() => page.report()?.querySelector('.report-notice[role="alert"]'), "the failure");
  assert.match(failure.textContent, /Home couldn't be read, so this report can't be shown yet: .*Core is restarting/);
  assert.equal(page.report().querySelector(".loading-state"), null, "not shown as reading");
  assert.equal(page.report().querySelector(".report-article"), null);
  refuse = false;
  await page.press(failure, "Try again");
  await until(() => page.report()?.querySelector(".report-lead"), "the report after Try again");
  assert.equal(page.report().querySelector('.report-notice[role="alert"]'), null);
  // A later read that fails keeps what was read, and says so.
  refuse = true;
  page.window.renderHome(null, 1);
  await until(() => notice(page) === "Home couldn't be read just now; this is the last reading.", "the last-reading note");
  assert.ok(page.report().querySelector(".report-lead"), "the report stays as read");
  refuse = false;
  await page.press(page.report().querySelector(".report-notice"), "Try again");
  await until(() => notice(page) === null, "read again");
  assert.deepEqual(page.errors, []);
});

// T-18 R3: an explicit way to Home (the toolbar, a notification, a Home link, a
// reply's Open on Home) bumps App's visit; a report open over Home closes as its
// Back closes it, and then goes nowhere else.
const homeIsInReach = (page) => {
  const view = page.document.querySelector(".home-view");
  return !view.hasAttribute("inert") && !view.classList.contains("is-under-report");
};

test("an explicit way to Home closes a report a card opened: its entry left, the address Home's, Home in reach; not back to the card, and it does not come back (T-18 R3)", async (t) => {
  const page = await openHome(() => homeData([section("eval", 7, 3), ask]));
  t.after(page.close);
  const before = page.window.history.length;
  page.card("eval").querySelector(".home-report-open").click();
  await until(page.report, "the report");
  assert.equal(page.window.history.length, before + 1);
  page.window.renderHome(null, 0, "ws-1", 1);
  await until(() => !page.report(), "the report closed");
  assert.equal(page.window.location.hash, "", "no report in the address");
  assert.equal(page.window.history.state?.yuzunoReport, undefined, "no report entry under Home");
  assert.equal(page.window.history.length, before + 1, "its entry left, as its Back leaves it; none added");
  assert.ok(homeIsInReach(page), "Home in reach, no layer over it");
  assert.equal(page.card("eval").hasAttribute("data-report-return"), false, "not taken back to the card");
  assert.deepEqual(page.window.actions.filter(([kind]) => kind === "back"), []);
  // Drawn again, the same visit: nothing opens or closes.
  page.window.renderHome(null, 0, "ws-1", 1);
  await tick(60);
  assert.equal(page.report(), null);
  // A later visit with no report open changes nothing.
  page.window.renderHome(null, 0, "ws-1", 2);
  await tick(60);
  assert.equal(page.window.history.length, before + 1);
  assert.equal(page.window.location.href, "https://report.test/");
  assert.deepEqual(page.errors, []);
});

test("an explicit way to Home closes a report from the address or a message: its entry becomes Home's, not back to the message, and that link does not open it again (T-18 R3)", async (t) => {
  const page = mount(() => homeData([section("eval", 7, 3)]));
  t.after(page.close);
  page.window.history.replaceState(null, "", `/${address(3)}`);
  const length = page.window.history.length;
  const incoming = { link: linkTo(3), back, fromAddress: true, n: 1 };
  page.window.renderHome(incoming);
  await until(() => page.report()?.querySelector(".report-head h1"), "the report");
  page.window.renderHome(incoming, 0, "ws-1", 1);
  await until(() => !page.report(), "the report closed");
  assert.equal(page.window.location.hash, "");
  assert.equal(page.window.location.href, "https://report.test/", "still this page");
  assert.equal(page.window.history.length, length, "the same entry, Home's again");
  assert.equal(page.window.history.state?.yuzunoReport, undefined);
  assert.ok(homeIsInReach(page));
  assert.deepEqual(page.window.actions.filter(([kind]) => kind === "back"), [], "the report's way back to its message is not taken");
  await tick(60);
  assert.equal(page.report(), null, "the link it came from does not open it again");
  assert.deepEqual(page.errors, []);
});

test("an explicit way to Home while the report's own Back is under way keeps Home: that Back does not go on to the message, and the browser goes back once (T-18 R3)", async (t) => {
  const page = mount(() => homeData([section("eval", 7, 3)]));
  t.after(page.close);
  const history = page.window.history;
  const goBack = history.back.bind(history);
  // The browser's Back, held: its popstate comes when the test lets it.
  let backs = 0;
  history.back = () => { backs += 1; };
  const incoming = { link: linkTo(3), back, fromAddress: false, n: 1 };
  page.window.renderHome(incoming);
  await until(() => page.report()?.querySelector(".report-head h1"), "the report, opened from a message");
  page.report().querySelector(".report-back").click();
  await tick();
  assert.equal(backs, 1, "the report's Back asked the browser to go back");
  // Before its popstate, an explicit way to Home (the toolbar, a push).
  page.window.renderHome(incoming, 0, "ws-1", 1);
  await tick(40);
  assert.equal(backs, 1, "not a second Back");
  history.back = goBack;
  goBack();
  await until(() => !page.report(), "the report closed");
  assert.deepEqual(page.window.actions.filter(([kind]) => kind === "back"), [], "the latest way out, Home, holds: not on to the message");
  assert.equal(page.window.location.hash, "");
  assert.deepEqual(page.errors, []);
});

test("a reply's Open on Home while a report is open lands on its card once the report has gone (T-18 R3)", async (t) => {
  const page = await openHome(() => homeData([section("eval", 7, 3), ask]));
  t.after(page.close);
  page.card("eval").querySelector(".home-report-open").click();
  await until(page.report, "the report");
  const origin = { workspaceId: "ws-1", projectId: "p1", key: "eval", version: 3, sectionId: 7 };
  page.window.renderHome(null, 0, "ws-1", 1, { origin, back, n: 1 });
  await until(() => !page.report(), "the report closed");
  await until(() => page.card("eval").hasAttribute("data-home-highlight"), "the arrival lands on its card");
  assert.equal(page.document.activeElement, page.card("eval"), "the card has focus, Home being in reach");
  assert.equal(page.card("eval").hasAttribute("data-report-return"), false);
  assert.deepEqual(page.window.actions.filter(([kind]) => kind === "back"), []);
  assert.deepEqual(page.errors, []);
});

// YN-7 item 8: a card's conditions box is named by its Checklist's own title, and its open items come first, each
// group in the author's order, so a fold hides what is done first. (The fold and its count need layout: the browser
// check home-desk-cards-check.mjs.) The report page keeps the author's order under "Conditions".
test("a card's Checklist conditions take the Checklist's title, open items first, each group in the author's order (YN-7)", async (t) => {
  const body = reportBody();
  body.elements.holds = { type: "Checklist", props: { title: "Before the test run", items: [
    { id: "protocol", text: "Protocol written", done: true }, { id: "cache", text: "Unlabelled inputs cached", done: true },
    { id: "freeze", text: "Freeze the new method", done: false }, { id: "seeds", text: "Seeds fixed", done: true },
    { id: "register", text: "Register the run", done: false } ] } };
  checkBriefSection({ key: "gate", kind: "report", title: "Test gate", body });
  const page = await openHome(() => homeData([section("gate", 9, 1, { title: "Test gate", body })]));
  t.after(page.close);
  const box = page.card("gate").querySelector(".home-card-conditions");
  assert.equal(box.getAttribute("aria-label"), "Before the test run", "the box is named by the Checklist's title");
  assert.equal(box.querySelector(".home-card-conditions-label").textContent, "Before the test run");
  const chips = [...box.querySelectorAll(".home-card-condition-chips li")];
  assert.deepEqual(chips.map((li) => li.textContent), ["Freeze the new method", "Register the run", "Protocol written", "Unlabelled inputs cached", "Seeds fixed"],
    "open items first, each group in the author's order");
  assert.deepEqual(chips.map((li) => li.hasAttribute("data-done")), [false, false, true, true, true]);
  page.card("gate").querySelector(".home-report-open").click();
  const report = await until(page.report, "the report");
  assert.equal(report.querySelector(".report-conditions-label").textContent, "Conditions", "the page keeps its label");
  assert.deepEqual([...report.querySelectorAll(".report-conditions li")].map((li) => li.textContent.trim()),
    ["Protocol written", "Unlabelled inputs cached", "Freeze the new method", "Seeds fixed", "Register the run"], "and the author's order");
  assert.deepEqual(page.errors, []);
});

// YN-7 item 7: a research desk named as a wide card's visual draws its lead claim, with the author's status, and the
// interval of the row it leads with, each number read as the report page reads it; a small card names it in a line.
const deskWith = (size) => {
  const desk = doseStudy.body.elements.desk;
  const second = { id: "c2", title: "The low dose's effect is unclear", statement: "Its interval crosses zero under the v2 outcome.", status: "open", primary: "low-v2" };
  return { root: "body", elements: { ...doseStudy.body.elements,
    body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "desk", size } }, children: ["lead", "desk"] },
    lead: { type: "Markdown", props: { text: "Against placebo, the high dose shortens recovery under the v2 outcome." } },
    desk: { ...desk, props: { ...desk.props, claims: [...desk.props.claims, second] } } } };
};
/** Core's research read of the desk, from the fixture files, as research.rs answers it. */
function deskRead(version) {
  const values = {};
  for (const plot of doseStudy.body.elements.desk.props.plots)
    for (const row of plot.rows)
      for (const [id, estimate] of [[row.id, row.estimate], ...(row.parts ?? []).map((part) => [part.id, part.estimate])])
        for (const field of ["value", "low", "high"]) {
          const number = estimate[field];
          if (!number || typeof number !== "object") continue;
          const found = number.pointer.split("/").slice(1).reduce((value, part) => value?.[part], fixtureFiles[number.from]);
          values[`${id}.${field}`] = typeof found === "number" ? { status: "read", value: found, from: number.from } : { status: "missing", from: number.from };
        }
  return { key: "dose", version, elementId: "desk", values, sources: {} };
}
test("a wide card's research desk shows its lead claim with the author's status and the interval it leads with, read as its page reads it (YN-7)", async (t) => {
  for (const size of ["wide", "small"]) checkBriefSection({ ...doseStudy, key: "dose", body: deskWith(size) });
  const page = await openHome(() => homeData([section("dose", 12, 3, { title: doseStudy.title, body: deskWith("wide") }),
    section("dose-small", 13, 3, { title: "Dose study, small", body: deskWith("small") })]), null,
  (url) => (url.startsWith("/api/projects/p1/brief/research/dose/desk?") ? deskRead(3) : undefined));
  t.after(page.close);
  const card = page.card("dose");
  assert.equal(card.dataset.cardSize, "wide");
  const desk = card.querySelector(".home-card-frame.kind-desk .research-card");
  assert.ok(desk, "drawn in the card's frame");
  assert.equal(desk.querySelector(".research-card-question").textContent, "Does the higher dose shorten recovery?");
  assert.equal(desk.querySelector(".research-status").textContent, "Holds under conditions (the author's reading)");
  assert.equal(desk.querySelector(".research-status").dataset.status, "conditional");
  assert.equal(desk.querySelector(".research-card-claim").textContent, "High dose shortens recovery");
  assert.equal(desk.querySelector(".research-card-plot-title").textContent, "Recovery time vs placebo (v2)");
  // The claim's primary row, its numbers from the snapshot as the page reads them; signed, the reference being 0.
  const value = await until(() => desk.querySelector('.research-row-value .research-origin[data-origin="read"]')?.closest(".research-row-value"), "the read numbers");
  assert.equal(desk.querySelector(".research-row-label").textContent, "High dose");
  assert.equal(value.querySelector("b").textContent, "−2.04");
  assert.equal(value.querySelector(".research-row-interval").textContent, " [−3.12, −0.96]");
  assert.equal(desk.querySelectorAll(".research-row").length, 1, "only the row the claim leads with");
  assert.equal(desk.querySelector(".research-card-more").textContent, "+1 claim · interactive on the report page");
  assert.equal(card.querySelector(".home-card-desk"), null, "not the question and counts alone");
  assert.equal(page.requests.filter((request) => request.url === "/api/projects/p1/brief/research/dose/desk?version=3").length, 1);
  // A small card names the desk in a line and reads nothing for it.
  const small = page.card("dose-small");
  assert.equal(small.dataset.cardSize, "small");
  assert.equal(small.querySelector(".research-card"), null);
  assert.ok(small.querySelector(".home-card-figure-note"), "a line naming it");
  assert.equal(page.requests.filter((request) => request.url.includes("/research/dose-small/")).length, 0);
  assert.ok(page.requests.every((request) => request.method === "GET" || request.url.endsWith("/github_repositories")), JSON.stringify(page.requests.map((r) => [r.method, r.url])));
  assert.deepEqual(page.errors, []);
});


test("YN-16 a report page's blocks share its variables, which are not its card's", async (t) => {
  // The summary's Group of inputs and a later part of the page are drawn apart; a switch in one shows a block in the other.
  const body = { root: "body", elements: {
    body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "try", size: "wide" } }, children: ["lead", "try", "method"] },
    lead: { type: "Markdown", props: { text: "Scones scale with the guests." } },
    try: { type: "Group", props: {}, children: ["vegan"] },
    vegan: { type: "Switch", props: { name: "vegan", label: "Vegan", value: false } },
    method: { type: "Group", props: { title: "Method" }, children: ["butter", "oil"] },
    butter: { type: "Markdown", visible: { $state: "/vegan", not: true }, props: { text: "Rub in the butter." } },
    oil: { type: "Markdown", visible: { $state: "/vegan" }, props: { text: "Stir in the olive oil." } },
  } };
  const scones = section("eval", 7, 3, { title: "Scones", body });
  assert.ok(checkBriefSection({ key: scones.key, kind: scones.kind, title: scones.title, body }), "the contract accepts it");
  const page = await openHome(() => homeData([scones]));
  t.after(page.close);
  // The card's switch is the card's own: set on the card, the page still starts from the section's value.
  const card = page.card("eval");
  card.querySelector('[role="switch"]').click();
  await until(() => card.querySelector('[role="switch"]').getAttribute("aria-checked") === "true", "the card's switch");
  card.querySelector(".home-report-open").click();
  const report = await until(page.report, "the report");
  const toggle = report.querySelector('.report-hero [role="switch"]');
  assert.equal(toggle.getAttribute("aria-checked"), "false", "the page's own value");
  assert.match(report.querySelector("#report-block-method").textContent, /Rub in the butter/);
  toggle.click();
  await until(() => /Stir in the olive oil/.test(report.querySelector("#report-block-method").textContent), "a block of another part follows");
  assert.doesNotMatch(report.querySelector("#report-block-method").textContent, /butter/);
  // Home reads its project's linked repositories with a POST (home-api.ts); nothing else is sent.
  // Nothing is written but that the report was opened (YN-86).
  assert.deepEqual(page.requests.filter((request) => request.method !== "GET").map((request) => request.url)
    .filter((url) => url !== "/api/collaboration/github_repositories" && url !== "/api/projects/p1/brief/opened"), [], "nothing is written");
  assert.deepEqual(page.errors, []);
});
