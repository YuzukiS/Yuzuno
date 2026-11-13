import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// YN-86: Home's own jumps, and a report recorded as read once its page has
// shown that very live version whole. The real Home, with a stand-in Core
// that keeps the receipts it is sent. Synthetic data only; no Core, browser
// or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "home-opened-"));
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
const links={href:()=>null,open:()=>{},reportHref:(link)=>reportLinkHref('https://opened.test/',{workspaceId:'ws-1',...link}),openReport:()=>{}};
// A Project's page, where its cards are (YN-86): p1's unless a test starts on the whole of Home (startProject null),
// opened as the app opens it, at the card named.
function Shell({report,revision,workspaceId,readOnly}){
  const [project,setProject]=React.useState(window.startProject===undefined?'p1':window.startProject);
  const [jump,setJump]=React.useState(null);
  return <MessageLinks.Provider value={links}><Home workspaceId={workspaceId} revision={revision} jobsRevision={0} agents={[]} projects={[]} readOnly={readOnly} onNavigate={()=>{}} onChanged={()=>{}} report={report} visit={0}
    project={project} jumpTo={jump} onOpenProject={(id,key)=>{setProject(id);setJump((j)=>({projectId:id,sectionKey:key,n:(j?.n??0)+1}));}} onCloseProject={()=>setProject(null)}/></MessageLinks.Provider>;
}
window.renderHome=({report=null,revision=0,workspaceId='ws-1',readOnly=false}={})=>root.render(<Shell report={report} revision={revision} workspaceId={workspaceId} readOnly={readOnly}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "HomeOpened", formats: ["iife"] } },
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

const owner = { agentId: "a", name: "Mori", state: "active" };
const body = (text) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: { summary: { lead: "answer" } }, children: ["answer", "notes"] },
  answer: { type: "Markdown", props: { text } },
  notes: { type: "Markdown", props: { text: "Three seeds per arm." } },
} });
// A body no part of the page can draw: its Sources carry a prop the contract has not (home-ui.test.mjs).
const unreadable = { root: "body", elements: {
  body: { type: "BriefBody", props: {}, children: ["links"] },
  links: { type: "Sources", props: { items: [{ id: "s1", label: "Spec", href: "https://example.test/spec" }], note: "older" } },
} };
const report = (key, id, version, extra = {}) => ({ id, key, kind: "report", title: `About ${key}`, version, owner,
  updatedAt: "2026-11-10T01:00:00Z", updatedTurnId: null, body: body(`${key} v${version}`), attachments: [], refs: {},
  seen: null, history: false, ...extra });
const ask = (key, id) => ({ ...report(key, id, 1), kind: "ask", title: `Ask ${key}`,
  body: { root: "b", elements: { b: { type: "BriefBody", props: {}, children: [] } } },
  ask: { question: `Which way for ${key}?`, reply: { options: [{ id: "left", label: "Left" }], freeText: true }, state: "open" } });

/**
 * A stand-in Core: Home's read from `state`, with each live section's
 * receipt as Core keeps it, and the receipts it is sent. `opened` decides
 * each answer: the record, or an Error that refuses it.
 */
function core(state) {
  state.opened ??= {};
  const panel = (project) => ({
    project: { id: project.id, name: project.name },
    agents: { working: 0, idle: 0, waiting: 0, error: 0, offline: 0, total: 0 },
    errors: [], pending: [], jobs: [], missing: [],
    unseen: project.sections.filter((s) => (Math.max(s.seen?.version ?? 0, state.opened[s.id]?.version ?? 0)) < s.version).length,
    brief: { version: 3, history: project.history ?? [],
      sections: project.sections.map((s) => ({ ...s, opened: state.opened[s.id] ?? null })) },
  });
  return {
    read: () => ({ generatedAt: "2026-11-10T02:00:00Z", order: state.projects.map((p) => p.id), needsYou: state.needsYou ?? [],
      projects: state.projects.map(panel) }),
    open(url, receipt) {
      const refused = state.refuse?.(receipt);
      if (refused) return refused;
      const project = state.projects.find((p) => url === `/api/projects/${p.id}/brief/opened`);
      const live = project?.sections.find((s) => s.id === receipt.sectionId && s.key === receipt.key && s.version === receipt.version);
      if (!live) return new Error("version_changed: that version is not live. Nothing was recorded.");
      const recorded = (state.opened[live.id]?.version ?? 0) < live.version;
      if (recorded) state.opened[live.id] = { version: live.version, at: "2026-11-10T02:01:00Z" };
      return { projectId: project.id, sectionId: live.id, key: live.key, version: live.version, at: state.opened[live.id].at, recorded };
    },
  };
}

function mount(state, { visible = true } = {}) {
  const fake = core(state);
  const errors = [];
  const requests = [];
  const scrolls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://opened.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLElement.prototype.scrollIntoView = function (options) { scrolls.push({ how: "intoView", el: this, options }); };
  window.HTMLElement.prototype.scrollTo = function (options) { scrolls.push({ how: "to", el: this, options }); };
  let shown = visible;
  Object.defineProperty(window.document, "visibilityState", { configurable: true, get: () => (shown ? "visible" : "hidden") });
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    requests.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : null });
    let answer;
    if (String(url) === "/api/home") answer = await (state.hold ?? fake.read)();
    else if (String(url).endsWith("/brief/opened")) answer = await fake.open(String(url), JSON.parse(init.body));
    else if (String(url) === "/api/machine-load") answer = { at: "2026-11-10T02:00:00Z", cpu: { cores: 4, totalPct: 0, jobsPct: 0, agentsPct: 0, otherPct: 0 },
      memory: { totalMiB: 4096, usedMiB: 0, availableMiB: 4096, jobsMiB: 0, agentsMiB: 0 }, gpus: null, jobs: [] };
    else answer = { repositories: [], links: [] };
    if (answer instanceof Error) {
      const refused = { error: answer.message };
      return { ok: false, status: 400, json: async () => refused, text: async () => JSON.stringify(refused) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(answer), text: async () => JSON.stringify(answer) };
  };
  window.eval(bundle);
  const document = window.document;
  const page = () => document.querySelector(".home-report");
  const card = (key) => document.querySelector(`.home-view [data-section-key="${key}"]`);
  const receipts = () => requests.filter((r) => r.method === "POST" && r.url.endsWith("/brief/opened"));
  const reads = () => requests.filter((r) => r.url === "/api/home").length;
  const jump = (kind) => document.querySelector(`.home-jumps [data-jump="${kind}"]`);
  return {
    window, document, errors, requests, scrolls, page, card, receipts, reads, jump,
    setVisible(value) {
      shown = value;
      document.dispatchEvent(new window.Event("visibilitychange"));
    },
    close: () => window.close(),
  };
}
async function openHome(state, options, render = {}, project = "p1") {
  const p = mount(state, options);
  p.window.startProject = project;
  p.window.renderHome(render);
  await until(() => p.document.querySelector(".project-home, .home-layout [data-glance-project]"), "Home read");
  await tick(40);
  return p;
}
async function openReport(p, key) {
  p.card(key).querySelector(".home-report-open").click();
  return until(() => p.page()?.querySelector(".report-head h1") && p.page(), `the report ${key}`);
}
const writes = (p) => p.requests.filter((r) => r.method !== "GET" && !r.url.endsWith("/github_repositories"));
const mark = (scope) => scope?.querySelector(".home-changed")?.textContent ?? null;
const one = (sections, needsYou = []) => ({ projects: [{ id: "p1", name: "atlas-notes", sections }], needsYou });

test("a live report its page drew whole is recorded once at that version, apart from Seen: it stays on Home and is New again only when it changes", async (t) => {
  const state = one([report("eval", 7, 3), report("other", 8, 1)]);
  const p = await openHome(state);
  t.after(p.close);
  assert.equal(mark(p.card("eval")), "New");
  assert.equal(p.document.querySelector(".project-home-head .home-chip.is-new")?.textContent, "2 new");
  assert.equal(p.receipts().length, 0, "nothing is sent by Home showing the card");
  const shown = await openReport(p, "eval");
  await until(() => p.receipts().length === 1, "the receipt");
  assert.deepEqual(p.receipts()[0], { url: "/api/projects/p1/brief/opened", method: "POST",
    body: { workspaceId: "ws-1", sectionId: 7, key: "eval", version: 3 } }, "the Workspace, identity, key and version shown");
  // Core has it at the next read: the page's mark goes; its Seen stays offered.
  await until(() => mark(shown.querySelector(".report-head")) === null, "the page no longer says New");
  assert.ok([...shown.querySelectorAll(".report-actions button")].some((b) => b.textContent.trim() === "Seen"), "Seen is still offered");
  // Drawn again, read again, it is not sent again.
  p.window.renderHome({ revision: 1 });
  await tick(80);
  assert.equal(p.receipts().length, 1, "once for this version");
  shown.querySelector(".report-back").click();
  await until(() => !p.page(), "back on Home");
  // On Home in its place, not New, still offered Seen; the count follows Core's.
  assert.deepEqual([...p.document.querySelectorAll(".project-home [data-section-key]")].map((el) => el.dataset.sectionKey), ["eval", "other"]);
  assert.equal(mark(p.card("eval")), null);
  assert.ok(p.card("eval").querySelector(".home-seen"), "Seen stays on the card: it is what puts a report into History");
  assert.equal(p.document.querySelector(".project-home-head .home-chip.is-new")?.textContent, "1 new");
  assert.deepEqual(writes(p).map((r) => r.url), ["/api/projects/p1/brief/opened"], "nothing marked seen");
  // Its next version is Updated, and opening it records that one.
  state.projects[0].sections[0] = report("eval", 7, 4);
  p.window.renderHome({ revision: 2 });
  await until(() => mark(p.card("eval")) === "Updated", "Updated at its next version");
  await openReport(p, "eval");
  await until(() => p.receipts().length === 2, "the next version's receipt");
  assert.equal(p.receipts()[1].body.version, 4);
  // Seen still archives it, as before.
  const before = writes(p).length;
  p.page().querySelector(".report-back").click();
  await until(() => !p.page(), "back on Home");
  p.card("eval").querySelector(".home-seen").click();
  await until(() => writes(p).length > before, "Seen sent");
  assert.deepEqual(writes(p).at(-1), { url: "/api/projects/p1/brief/seen", method: "POST", body: { sections: [{ key: "eval", version: 4 }] } });
  assert.deepEqual(p.errors, []);
});

test("nothing is recorded for a version not drawn whole and live: History, unknown, unreadable, while hidden, or replaced meanwhile", async (t) => {
  // A version kept in History, while a newer one is live.
  {
    const state = { projects: [{ id: "p1", name: "atlas-notes", sections: [report("eval", 7, 3)],
      history: [report("eval", 7, 2, { history: true, historyReason: "seen", seen: { version: 2 } })] }] };
    const p = await openHome(state, undefined, { report: { link: { workspaceId: "ws-1", projectId: "p1", key: "eval", version: 2, sectionId: 7 }, back: null, fromAddress: false, n: 1 } });
    t.after(p.close);
    await until(() => p.page()?.querySelector(".report-head h1"), "the History version");
    await tick(120);
    assert.equal(p.receipts().length, 0, "History");
  }
  // A link Home can't tie to any section it has.
  {
    const p = await openHome(one([report("eval", 7, 3)]), undefined, { report: { link: { workspaceId: "ws-1", projectId: "p1", key: "eval", version: 3, sectionId: 99 }, back: null, fromAddress: false, n: 1 } });
    t.after(p.close);
    await until(() => p.page()?.querySelector(".report-notice"), "the unknown note");
    await tick(120);
    assert.equal(p.receipts().length, 0, "unknown");
  }
  // A body the page could not draw at all.
  {
    const p = await openHome(one([report("eval", 7, 3, { body: unreadable })]), undefined,
      { report: { link: { workspaceId: "ws-1", projectId: "p1", key: "eval", version: 3, sectionId: 7 }, back: null, fromAddress: false, n: 1 } });
    t.after(p.close);
    await until(() => p.page().querySelector(".result-part-error")?.textContent === "This section couldn't be displayed.", "the unreadable note");
    await tick(120);
    assert.equal(p.receipts().length, 0, "unreadable");
    assert.equal(mark(p.page().querySelector(".report-head")), "New", "still New");
  }
  // The page hidden: sent when it shows, unless the version was replaced meanwhile (it is then kept, not live).
  {
    const state = one([report("eval", 7, 3), report("next", 9, 1)]);
    const p = await openHome(state, { visible: false });
    t.after(p.close);
    await openReport(p, "eval");
    await tick(120);
    assert.equal(p.receipts().length, 0, "nothing while the page is hidden");
    state.projects[0].sections[0] = report("eval", 7, 4);
    p.window.renderHome({ revision: 1 });
    await until(() => p.page().querySelector(".report-notice"), "the page says a newer version arrived");
    p.setVisible(true);
    await tick(120);
    assert.equal(p.receipts().length, 0, "the kept version, no longer live, is not recorded; nor is the newer one, not shown");
    p.page().querySelector(".report-back").click();
    await until(() => !p.page(), "back on Home");
    p.setVisible(false);
    await openReport(p, "next");
    await tick(120);
    assert.equal(p.receipts().length, 0, "drawn while hidden: not yet");
    p.setVisible(true);
    await until(() => p.receipts().length === 1, "shown, it is sent");
    assert.equal(p.receipts()[0].body.key, "next");
  }
});

test("a body that shows nothing but unreadable notes is not recorded; a readable block beside one is (PR 883, Lead's P2)", async (t) => {
  const link = { report: { link: { workspaceId: "ws-1", projectId: "p1", key: "eval", version: 3, sectionId: 7 }, back: null, fromAddress: false, n: 1 } };
  const bodyOf = (children, elements) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children }, ...elements } });
  const unknown = { type: "Code", props: { text: "print('synthetic')" } };
  // A Checklist without items throws inside its part: its boundary shows the note in its place.
  const broken = { type: "Checklist", props: { title: "Steps", items: null } };
  const notes = (page) => [...page.querySelectorAll(".result-part-error")].map((p) => p.textContent);
  for (const [what, body, count] of [
    ["the only block an unknown component", bodyOf(["x"], { x: unknown }), 1],
    ["every block failing in its part", bodyOf(["a", "b"], { a: broken, b: broken }), 2],
  ]) {
    const p = await openHome(one([report("eval", 7, 3, { body })]), undefined, link);
    t.after(p.close);
    await until(() => p.page()?.querySelector(".report-head h1") && notes(p.page()).length === count, `${what}: its notes`);
    assert.deepEqual(notes(p.page()), Array(count).fill("This part of the section couldn't be displayed."), what);
    await tick(150);
    assert.equal(p.receipts().length, 0, `${what}: nothing recorded`);
    assert.equal(mark(p.page().querySelector(".report-head")), "New", `${what}: still New`);
  }
  // One readable block beside an unknown one: the page shows the report, the note in its place, and records it.
  const p = await openHome(one([report("eval", 7, 3, { body: bodyOf(["lead", "x"], { lead: { type: "Markdown", props: { text: "The synthetic result holds." } }, x: unknown }) })]),
    undefined, link);
  t.after(p.close);
  await until(() => p.page()?.querySelector(".report-head h1") && notes(p.page()).length === 1, "the readable report with one note");
  await until(() => p.receipts().length === 1, "recorded");
  assert.deepEqual(p.receipts()[0].body, { workspaceId: "ws-1", sectionId: 7, key: "eval", version: 3 });
  assert.deepEqual(p.errors, []);
});

test("a receipt Core refuses is said on the page, never sent again from it, and tried again the next time the report is opened", async (t) => {
  const state = one([report("eval", 7, 3)]);
  let refusals = 1;
  state.refuse = () => (refusals-- > 0 ? new Error("version_changed: version 4 is live, not version 3. Nothing was recorded.") : null);
  const p = await openHome(state);
  t.after(p.close);
  const shown = await openReport(p, "eval");
  const note = await until(() => shown.querySelector(".report-opened-note"), "the note");
  assert.equal(note.textContent, "Not recorded as read: version 4 is live, not version 3. Nothing was recorded. It stays marked as changed; opening it again tries again.");
  assert.equal(mark(shown.querySelector(".report-head")), "New");
  p.window.renderHome({ revision: 1 });
  await tick(120);
  assert.equal(p.receipts().length, 1, "not tried again by drawing");
  shown.querySelector(".report-back").click();
  await until(() => !p.page(), "back on Home");
  assert.equal(mark(p.card("eval")), "New", "the card stays New");
  await openReport(p, "eval");
  await until(() => p.receipts().length === 2, "opened again, it tries again");
  await until(() => !p.page().querySelector(".report-opened-note") && mark(p.page().querySelector(".report-head")) === null, "recorded");
  assert.deepEqual(p.errors, []);
});

test("an answer for a Workspace no longer shown changes nothing there; on the whole of Home, a report opened from it counts as read once Core has it", async (t) => {
  // Opened in ws-1, its answer held; ws-2 is shown when it comes.
  {
    const state = one([report("eval", 7, 3)]);
    const p = await openHome(state);
    t.after(p.close);
    let answer;
    state.refuse = () => new Promise((resolve) => { answer = resolve; });
    await openReport(p, "eval");
    await until(() => p.receipts().length === 1, "the receipt sent");
    const reads = p.reads();
    p.window.renderHome({ workspaceId: "ws-2" });
    await tick(80);
    answer({ projectId: "p1", sectionId: 7, key: "eval", version: 3, at: "2026-11-10T02:01:00Z", recorded: true });
    await tick(120);
    const after = p.reads();
    p.window.renderHome({ workspaceId: "ws-2", revision: 0 });
    await tick(40);
    assert.ok(after - reads <= 1, "ws-2 read itself once; the late answer read nothing more");
    assert.equal(p.receipts().filter((r) => r.body.workspaceId === "ws-2").length, 0, "nothing was sent as ws-2's");
    const kept = [...Array(p.window.localStorage.length).keys()].map((i) => p.window.localStorage.key(i));
    assert.deepEqual(kept.filter((key) => key.startsWith("yuzuno.home-seen-blocks")), [], "nothing of it kept as read on this device");
  }
  // The whole of Home (YN-86 §2.1): the report updated last opens from the bar; its project's glance counts it read
  // once Core's next read has the receipt, and the other report stays new.
  {
    const state = one([report("eval", 7, 3, { updatedAt: "2026-11-10T01:30:00Z" }), report("other", 8, 1)]);
    const p = await openHome(state, undefined, {}, null);
    t.after(p.close);
    const chip = () => p.document.querySelector('[data-glance-project="p1"] .home-chip.is-new')?.textContent;
    assert.equal(chip(), "2 new");
    p.jump("report").click();
    await until(() => p.page()?.querySelector(".report-head h1")?.textContent === "About eval", "the report updated last");
    await until(() => p.receipts().length === 1, "the receipt");
    p.page().querySelector(".report-back").click();
    await until(() => !p.page(), "back on Home");
    await until(() => chip() === "1 new", "the glance counts it read");
    assert.deepEqual(writes(p).map((r) => r.url), ["/api/projects/p1/brief/opened"], "nothing marked seen");
    assert.deepEqual(p.errors, []);
  }
});

test("Home's jumps stay above Needs you and the projects: the next open Ask in Needs you, the report updated last opened as its page with the focus back on the jump, and My widgets; scrolling only Home", async (t) => {
  const state = {
    projects: [
      { id: "p1", name: "atlas-notes", sections: [ask("decide", 11), report("old", 7, 2, { updatedAt: "2026-11-09T08:00:00Z" }), ask("paging", 12)] },
      { id: "p2", name: "orbit-lab", sections: [report("fresh", 21, 5, { updatedAt: "2026-11-10T01:30:00Z" })] },
    ],
    needsYou: [
      { kind: "ask", projectId: "p1", agentId: "a", agentName: "Mori", sectionKey: "decide", title: "Ask decide", since: "2026-11-10T00:00:00Z" },
      { kind: "approval", projectId: "p1", agentId: "a", agentName: "Mori", requestId: "r1", title: "Run a command", since: "2026-11-10T00:10:00Z" },
      { kind: "ask", projectId: "p1", agentId: "a", agentName: "Mori", sectionKey: "paging", title: "Ask paging", since: "2026-11-10T00:20:00Z" },
    ],
  };
  const p = await openHome(state, undefined, {}, null);
  t.after(p.close);
  const bar = p.document.querySelector(".home-view > .home-jumps");
  assert.ok(bar, "in Home's own scroller, not the app's toolbar");
  assert.equal(bar.getAttribute("aria-label"), "Jump to");
  assert.deepEqual([...bar.querySelectorAll("button")].map((b) => b.textContent), ["Asks2", "Latest report", "My widgets1"]);
  assert.equal(p.jump("asks").getAttribute("aria-label"), "Asks waiting for you: 2", "Asks only, not the approval");
  assert.equal(p.jump("report").getAttribute("aria-description"), null, "it has a report to open");
  const focused = () => p.document.activeElement;
  const scrolledHome = () => p.scrolls.at(-1)?.how === "to" && p.scrolls.at(-1).el === p.document.querySelector(".home-view");
  // Asks: the first, the next, then the first again, each its card in Needs you.
  for (const key of ["decide", "paging", "decide"]) {
    p.jump("asks").click();
    await until(() => focused()?.dataset?.sectionKey === key && focused().closest(".home-needs-you"), `the Ask ${key}`);
  }
  assert.ok(scrolledHome(), "Home's own scroller moved, nothing around it");
  assert.equal(p.scrolls.filter((s) => s.how === "intoView").length, 0);
  // The report updated last: its card is on its project's page, so the bar opens its page over Home.
  const jump = p.jump("report");
  jump.click();
  const shown = await until(() => p.page()?.querySelector(".report-head h1") && p.page(), "the report updated last");
  assert.equal(shown.querySelector(".report-head h1").textContent, "About fresh");
  const view = p.document.querySelector(".home-view");
  assert.ok(view.hasAttribute("inert") && view.contains(bar), "the bar goes with Home under the report");
  // Back: Home as it was, the focus on the jump that opened it.
  shown.querySelector(".report-back").click();
  await until(() => !p.page(), "back on Home");
  await tick();
  assert.ok(focused() === jump, "the focus is back on Latest report");
  assert.ok(jump.hasAttribute("data-report-return"), "with the short ring");
  assert.ok(p.document.querySelector(".home-layout [data-glance-project]"), "still the whole of Home");
  p.jump("widgets").click();
  await until(() => focused()?.id === "home-widgets", "My widgets");
  // Each jump is a press: a later read moves nothing.
  const count = p.scrolls.length;
  p.window.renderHome({ revision: 1 });
  await tick(80);
  assert.equal(p.scrolls.length, count, "nothing scrolls by itself");
  assert.deepEqual(p.errors, []);
});

test("a jump with nothing to go to says why and does nothing: no open Ask, no report, every widget hidden", async (t) => {
  const p = mount({ projects: [{ id: "p1", name: "atlas-notes", sections: [{ ...report("load", 3, 1), kind: "status",
    status: { asOf: "2026-11-10T01:00:00Z", validFor: 86400, stale: false } }] }] });
  t.after(p.close);
  p.window.localStorage.setItem("yuzuno.homeWidgets.ws-1", JSON.stringify({ order: ["machines"], hidden: ["machines"], pins: [] }));
  p.window.startProject = null;
  p.window.renderHome();
  await until(() => p.document.querySelector(".home-layout [data-glance-project]"), "Home read");
  await tick(40);
  for (const [kind, why] of [["asks", "No Ask is waiting for you. Approvals and questions are in Needs you."], ["report", "No report on Home yet."],
    ["widgets", "No widgets on show. Organize in My widgets shows hidden ones."]]) {
    const button = p.jump(kind);
    assert.equal(button.getAttribute("aria-disabled"), "true", kind);
    assert.equal(button.getAttribute("aria-description"), why, kind);
    assert.equal(button.disabled, false, `${kind} stays focusable for its reason`);
    const scrolls = p.scrolls.length;
    button.click();
    await tick(40);
    assert.equal(p.scrolls.length, scrolls, `${kind} goes nowhere`);
  }
  assert.deepEqual(p.errors, []);
});
