import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// YN-86 S3b-2: a card a request was routed to says where it came from, in
// one line above who answers for it: "Request: <title>", how many cards that
// request made, how many more were joined to it; its details list each
// request with "See words →", which goes back to the words in "Talk to the
// project", the request's other cards, and the card's handoffs, never the
// user's words. Reassign gives the card to another open Agent of the
// Project or a new executor, the same reassignment again when sent again.
// The real Home on a Project's page, with a stand-in Core; synthetic data only.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "card-source-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Home} from ${JSON.stringify(path.join(root, "src/home/Home.tsx"))};
const root=createRoot(document.getElementById('root'));
window.navigated=[];
window.renderHome=({agents, projects})=>root.render(<Home workspaceId="ws-1" revision={0} jobsRevision={0} agents={agents} projects={projects} readOnly={false} onNavigate={(target)=>window.navigated.push(target)} onChanged={()=>{}} visit={0} project="p1" onOpenProject={(projectId, sectionKey)=>window.navigated.push({kind:"project", projectId, sectionKey})} onCloseProject={()=>{}}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "CardSource", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick(15);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const realm = (value) => JSON.parse(JSON.stringify(value));

const base = { model: "m", color: "sage", cwd: "/w/atlas", goal: "", createdAt: "2026-11-12T00:00:00Z", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", harness: "codex" };
const agents = [
  { ...base, id: "a", name: "Mori", kind: "lead", status: "idle" },
  { ...base, id: "b", name: "Sora", kind: "lead", status: "idle" },
  { ...base, id: "x", name: "YN-7 · Build page", kind: "executor", status: "working",
    executor: { state: "running", agentId: "x", task: { id: "YN-7", title: "Settings layout", shortName: "Build page" }, dispatchedAt: ago(90) } },
];
const projects = [{ id: "p1", name: "atlas-notes", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const owner = (agentId, name) => ({ agentId, name, state: "active" });
const mori = owner("a", "Mori");
const body = (text) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text } } } });
const ids = { "yn-7": 21, "yn-7/findings": 23, "yn-8": 22, plain: 24 };
const section = (key, kind, title, extra = {}) => ({ id: ids[key], key, kind, title, version: 2, owner: mori, updatedAt: ago(20),
  updatedTurnId: null, body: body(`${title}: what it says.`), attachments: [], refs: {}, seen: null, history: false, ...extra });
const buildTask = { id: "YN-7", title: "Settings layout", shortName: "Build page", status: "doing", archived: false };
const copyTask = { id: "YN-8", title: "Casual copy", shortName: "Copy", status: "doing", archived: false };
const builder = { agentId: "x", name: "YN-7 · Build page", kind: "executor", state: "running" };
const desk = { agentId: "a", name: "Mori" };
const at = { r3: ago(60), r4: ago(40) };
const route = (kind, request, index, sectionId, cardKey, task, to, why, title) =>
  ({ kind, index, request, at: request === 3 ? at.r3 : at.r4, state: "done", why, by: desk, to, task, cardKey, sectionId, ...(title ? { title } : {}) });
const handoffs = {
  requests: [
    { n: 3, title: "Settings page layout", at: at.r3, merged: false, messageId: "m3" },
    { n: 4, title: "Export CSV", at: at.r4, merged: true, messageId: "m4" },
  ],
  events: [
    route("card", 3, 0, 21, "yn-7", "YN-7", { agentId: "x", name: "YN-7 · Build page" }, "A design with an end", "Settings layout"),
    route("existing", 4, 0, 21, "yn-7", "YN-7", { agentId: "x", name: "YN-7 · Build page" }, "The same thing as R-3"),
  ],
};
const sections = [
  section("yn-7", "status", "Settings layout", { status: { asOf: ago(10), validFor: 86_400, stale: false },
    card: { task: buildTask, responsible: builder, handoffs } }),
  section("yn-7/findings", "report", "What the layout keeps", { owner: owner("x", "YN-7 · Build page"),
    card: { task: buildTask, responsible: builder, handoffs } }),
  section("yn-8", "status", "Casual copy", { status: { asOf: ago(10), validFor: 86_400, stale: false },
    card: { task: copyTask, responsible: { agentId: "a", name: "Mori", kind: "lead", state: "idle" },
      handoffs: { requests: [handoffs.requests[0]], events: [route("card", 3, 1, 22, "yn-8", "YN-8", desk, "Words only", "Casual copy")] } } }),
  section("plain", "report", "Plain notes"),
];
const homeData = () => ({
  generatedAt: ago(0), order: ["p1"], needsYou: [],
  projects: [{
    project: { id: "p1", name: "atlas-notes" },
    contentEditors: { version: 1, editorAgentIds: ["a", "b"] },
    agents: { working: 1, idle: 2, waiting: 0, error: 0, offline: 0, total: 3 },
    errors: [], pending: [], jobs: [], missing: [], unseen: 2, brief: { version: 9, sections, history: [] },
  }],
});
const card = (sectionId, key, title, task, responsible) => ({ sectionId, key, title, live: true, task: { id: task.id, status: task.status, archived: false }, responsible });
const requests = () => [
  { id: "r4", n: 4, text: "Export also as CSV, as said before", textBlocks: null, title: "Export CSV", createdAt: at.r4, frontAgentId: "a",
    messageId: "m4", delivery: "accepted", replies: [], notes: [{ note: "Joined it to the layout card.", by: desk, at: at.r4 }],
    routes: [handoffs.events[1]], cards: [card(21, "yn-7", "Settings layout", buildTask, builder)], state: "doing", progress: { cards: 1, ended: 0 }, lines: [] },
  { id: "r3", n: 3, text: "Rework the settings page and make the copy casual", textBlocks: null, title: "Settings page layout", createdAt: at.r3,
    frontAgentId: "a", messageId: "m3", delivery: "accepted", replies: [], notes: [{ note: "Two cards.", by: desk, at: at.r3 }],
    routes: [handoffs.events[0], sections[2].card.handoffs.events[0]],
    cards: [card(21, "yn-7", "Settings layout", buildTask, builder), card(22, "yn-8", "Casual copy", copyTask, { agentId: "a", name: "Mori", kind: "lead", state: "idle" })],
    state: "doing", progress: { cards: 2, ended: 0 }, lines: [] },
  // Its card archived longer ago than Home keeps it: no longer on the page.
  { id: "r2", n: 2, text: "Compare the export formats", textBlocks: null, title: "Export formats", createdAt: ago(60 * 24 * 40), frontAgentId: "a",
    messageId: "m2", delivery: "accepted", replies: [], notes: [{ note: "A research card.", by: desk, at: ago(60 * 24 * 40) }],
    routes: [{ kind: "card", index: 0, request: 2, at: ago(60 * 24 * 40), state: "done", why: "Research", by: desk, to: { agentId: "x", name: "YN-6 · Research" },
      task: "YN-6", cardKey: "yn-6", sectionId: 19, title: "Export research" }],
    cards: [{ sectionId: 19, key: "yn-6", title: "Export research", live: false, task: { id: "YN-6", status: "done", archived: false }, responsible: null }],
    state: "done", progress: { cards: 1, ended: 1 }, lines: [] },
];

function mount({ language, refuse = 0 } = {}) {
  const errors = [];
  const calls = [];
  const opened = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://card-source.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  if (language) window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.scrollTo = function () {};
  window.Range.prototype.getClientRects ||= () => [];
  window.Range.prototype.getBoundingClientRect ||= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  window.addEventListener("yuzuno:open-task-review", (event) => opened.push(event.detail));
  const state = { refuse };
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const call = { url: String(url), method, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const answer = (value, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(value), text: async () => JSON.stringify(value) });
    if (call.url === "/api/home") return answer(homeData());
    if (call.url.endsWith("/front-desk")) return answer({ version: 1, agentId: "a", effectiveAgentId: "a" });
    if (method === "GET" && /\/requests(\?|$)/.test(call.url)) return answer({ requests: requests(), hasMore: false });
    if (call.url === "/api/executor-templates")
      return answer({ available: [{ template: { id: "design", label: "Design", whenToChoose: "A design with an end" }, source: "workspace" }] });
    if (/\/cards\/\d+\/reassign$/.test(call.url)) {
      if (state.refuse > 0) {
        state.refuse--;
        return answer({ error: "release_failed: x was not released" }, 400);
      }
      const to = call.body.to.agentId ? { agentId: call.body.to.agentId, name: agents.find((a) => a.id === call.body.to.agentId).name } : { agentId: "n", name: "YN-7 · Design" };
      return answer({ route: { kind: "reassign", index: null, request: null, at: ago(0), state: "done", why: call.body.why ?? "", by: null, to,
        task: "YN-7", cardKey: "yn-7", sectionId: 21, from: { agentId: "x", name: "YN-7 · Build page" } },
        released: { agentId: "x", note: "Releasing ends what the earlier executor was doing." } });
    }
    return answer({ repositories: [], links: [] });
  };
  window.eval(bundle);
  const document = window.document;
  const cardOf = (key) => document.querySelector(`.project-home [data-section-key="${key}"]`);
  const source = (key) => cardOf(key)?.querySelector(":scope .card-source") ?? null;
  const button = (label, scope = document) =>
    [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
  const words = (element) => element.textContent.replace(/\s+/g, " ").trim();
  return { window, document, errors, calls, opened, cardOf, source, button, words, close: () => window.close() };
}

async function openPage(options) {
  const p = mount(options);
  p.window.renderHome({ agents, projects });
  await until(() => p.cardOf("yn-7") && p.document.querySelector('.request-card[data-request="3"]'), "the Project's page, its cards and its requests");
  await tick(40);
  return p;
}

test("a card says which request it came from, above who answers for it; its details list the requests, the request's other card and the handoffs", async (t) => {
  const p = await openPage();
  t.after(p.close);
  const source = p.source("yn-7");
  assert.ok(source, "the card has its source line");
  const line = source.querySelector(".card-source-line");
  assert.equal(p.words(line.querySelector(".card-source-text")), "Request: Settings page layout (2 cards) · 1 more request joined");
  assert.equal(line.querySelector(".card-source-more").textContent, "Details");
  assert.equal(line.getAttribute("aria-expanded"), "false");
  // Above who answers for the card, in its foot.
  assert.equal(source.nextElementSibling?.classList.contains("home-card-responsible"), true);
  // A sub-section bound to the same task has no line of its own; a card with no request none.
  assert.equal(p.cardOf("yn-7/findings").querySelector(".card-source"), null);
  assert.equal(p.cardOf("plain").querySelector(".card-source"), null);
  assert.equal(p.words(p.source("yn-8").querySelector(".card-source-text")), "Request: Settings page layout (2 cards)");

  line.click();
  await tick();
  assert.equal(line.getAttribute("aria-expanded"), "true");
  const detail = source.querySelector(".card-source-detail");
  assert.deepEqual([...detail.querySelectorAll(".card-source-request")].map(p.words), ["Settings page layout", "Export CSV joined"]);
  assert.equal(detail.querySelectorAll(".card-source-requests .talk-link").length, 2, "See words → for each");
  assert.deepEqual([...detail.querySelectorAll(".card-source-others .talk-link")].map(p.words), ["Its other card: Casual copy →"]);
  const events = [...detail.querySelectorAll(".routing-event")];
  assert.deepEqual(events.map((e) => e.dataset.kind), ["card", "existing"]);
  assert.equal(events[0].querySelector(".routing-event-text").textContent, "Project opened the card “Settings layout” → YN-7 · Build pageA design with an end");
  assert.equal(detail.querySelector(".routing-event-link"), null, "no link to this very card");
  // Never the user's words on the card.
  for (const said of ["Rework the settings page", "Export also as CSV"]) assert.ok(!p.cardOf("yn-7").textContent.includes(said), said);
  // The other card is shown on this page, where it is: focused there, no task opened, nowhere else gone to.
  p.button("Its other card: Casual copy →", detail).click();
  await until(() => p.document.activeElement === p.cardOf("yn-8"), "the other card focused");
  assert.deepEqual(realm(p.window.navigated), []);
  assert.deepEqual(realm(p.opened), []);
  assert.deepEqual(p.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/github_repositories")), [], "reading writes nothing");
  assert.deepEqual(p.errors, []);
});

test("See words → goes back to the words in Talk to the project: shown, the request selected with its handoffs open", async (t) => {
  const p = await openPage();
  t.after(p.close);
  p.source("yn-7").querySelector(".card-source-line").click();
  await tick();
  p.button("Show your words for “Export CSV” in the conversation").click();
  await until(() => p.document.querySelector('.request-card[data-request="4"][data-selected]'), "R-4 selected");
  const request = p.document.querySelector('.request-card[data-request="4"]');
  assert.ok(request.querySelector(".routing-events"), "its handoffs open");
  const words = p.document.querySelector('.project-talk-mine[data-words="4"]');
  assert.equal(words.querySelector(".project-talk-bubble").textContent, "Export also as CSV, as said before");
  await until(() => p.document.activeElement === words, "the words have the focus");
  assert.deepEqual(p.errors, []);
});

test("Reassign gives the card to another open Agent or a new executor; sent again, it is the same reassignment", async (t) => {
  const p = await openPage({ refuse: 1 });
  t.after(p.close);
  const foot = p.cardOf("yn-7").querySelector(".home-card-responsible");
  p.button("Reassign", foot).click();
  const dialog = await until(() => p.document.querySelector('[role="dialog"]'), "the reassign dialog");
  await until(() => dialog.querySelector('input[value="template:design"]'), "the templates are read");
  assert.equal(dialog.querySelector("h2").textContent, "Reassign “Settings layout”");
  assert.match(p.words(dialog.querySelector(".reassign-now")), /^YN-7 · Build page answers for it now\. The new responsible Agent takes the card first/);
  // Open Agents of the Project that are no executor, not the one answering now.
  assert.deepEqual([...dialog.querySelectorAll('input[name^="reassign-"]')].map((i) => i.value), ["agent:a", "agent:b", "template:design"]);
  const send = () => [...dialog.querySelectorAll("button[type=submit]")][0];
  assert.ok(send().disabled, "nothing chosen yet");
  dialog.querySelector('input[value="agent:b"]').click();
  const why = dialog.querySelector(".reassign-why input");
  Object.getOwnPropertyDescriptor(p.window.HTMLInputElement.prototype, "value").set.call(why, "Sora knows the copy");
  why.dispatchEvent(new p.window.Event("input", { bubbles: true }));
  await tick();
  send().click();
  await until(() => dialog.querySelector('[role="alert"]'), "Core's refusal is shown");
  assert.match(dialog.querySelector('[role="alert"]').textContent, /release_failed/);
  send().click();
  await until(() => !p.document.querySelector('[role="dialog"]'), "the dialog closed");
  const sent = p.calls.filter((c) => /\/cards\/21\/reassign$/.test(c.url));
  assert.equal(sent.length, 2);
  assert.match(sent[0].url, /\/api\/projects\/p1\/cards\/21\/reassign$/);
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["clientRequestId", "to", "why", "workspaceId"]);
  assert.deepEqual(realm(sent[0].body.to), { agentId: "b" });
  assert.equal(sent[0].body.why, "Sora knows the copy");
  assert.equal(sent[0].body.workspaceId, "ws-1");
  assert.equal(sent[1].body.clientRequestId, sent[0].body.clientRequestId, "the same reassignment, sent again");
  assert.equal(p.words(p.cardOf("yn-7").querySelector(".home-card-reassigned")),
    "Reassigned to Sora. YN-7 · Build page is being released: archived first, never cut off.");
  // A new executor from a template: another reassignment.
  p.button("Reassign", foot).click();
  const again = await until(() => p.document.querySelector('[role="dialog"]'), "the dialog again");
  again.querySelector('input[value="template:design"]').click();
  await tick();
  [...again.querySelectorAll("button[type=submit]")][0].click();
  await until(() => p.calls.filter((c) => /\/reassign$/.test(c.url)).length === 3, "sent");
  const third = p.calls.filter((c) => /\/reassign$/.test(c.url))[2];
  assert.deepEqual(realm(third.body.to), { executor: { templateId: "design" } });
  assert.equal("why" in third.body, false, "no why given, none sent");
  assert.notEqual(third.body.clientRequestId, sent[0].body.clientRequestId);
  assert.deepEqual(p.errors, []);
});

test("the source line and the dialog in Chinese", async (t) => {
  const p = await openPage({ language: "zh-Hans" });
  t.after(p.close);
  assert.equal(p.source("yn-7").querySelector(".card-source-text").textContent, "需求：Settings page layout（共 2 张卡） · 另有 1 条补充需求并入");
  assert.equal(p.source("yn-7").querySelector(".card-source-more").textContent, "详情");
  p.source("yn-7").querySelector(".card-source-line").click();
  await tick();
  assert.equal(p.source("yn-7").querySelectorAll(".card-source-requests .talk-link")[0].textContent, "看原话 →");
  p.button("改派", p.cardOf("yn-7").querySelector(".home-card-responsible")).click();
  const dialog = await until(() => p.document.querySelector('[role="dialog"]'), "the reassign dialog");
  assert.equal(dialog.querySelector("h2").textContent, "改派「Settings layout」");
  assert.deepEqual([...dialog.querySelectorAll("legend")].map((l) => l.textContent), ["交给项目里的 Agent", "重新派执行者"]);
  assert.deepEqual(p.errors, []);
});

test("a card no longer on the page opens its task instead, from its request's row and its handoff (R1 56f63019 P3)", async (t) => {
  const p = await openPage();
  t.after(p.close);
  const request = await until(() => p.document.querySelector('.request-card[data-request="2"]'), "R-2 in Done");
  assert.equal(p.cardOf("yn-6"), null, "its card is not on the page");
  request.querySelector(".request-card-row").click();
  assert.deepEqual(realm(p.opened), [{ taskId: "YN-6" }]);
  p.button("Handoffs 3", request).click();
  await tick();
  p.button("See archive", request).click();
  assert.deepEqual(realm(p.opened), [{ taskId: "YN-6" }, { taskId: "YN-6" }]);
  // A card on the page is shown, not its task.
  p.document.querySelector('.request-card[data-request="3"] .request-card-row').click();
  assert.equal(p.opened.length, 2);
  assert.deepEqual(p.errors, []);
});

