import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { unfoldBlocks } from "./request-blocks-driver.mjs";

// YN-208: what each card of a request delivered, opened from the request
// (YN-212: from its block on the Project's page, under its fact; why a task
// that ended delivered nothing is in its row, inside the block).
// A report opens at the version its result named, over Home (the report
// link's own way, so Back returns to the button that opened it); a version
// no longer kept is said, with the same report's version Home keeps; a PR
// says GitHub's state and when Core read it; a release is a link Core never
// checked; a short answer reads whole. A card whose task ended with nothing
// named says why and opens its task. Nothing is guessed, nothing is posted:
// opening is not confirming. An older Core, which names no deliverables,
// shows none. The real components with a stand-in Core; synthetic data only.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "request-deliverables-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {Home} from ${JSON.stringify(path.join(root, "src/home/Home.tsx"))};
import {MessageLinks} from ${JSON.stringify(path.join(root, "src/deep-link.ts"))};
const root=createRoot(document.getElementById('root'));
window.reports=[];
window.tasks=[];
window.addEventListener('yuzuno:open-task-review',(event)=>window.tasks.push(event.detail.taskId));
const links={href:()=>null,open:()=>{},reportHref:()=>null,openReport:(link)=>window.reports.push({link,focused:document.activeElement?.className||''})};
const projects=[{id:'p1',name:'Atlas',defaultDirs:{},createdAt:'',updatedAt:''}];
window.renderTalk=(revision=0)=>flushSync(()=>root.render(<MessageLinks.Provider value={links}><Home workspaceId="ws" revision={revision} jobsRevision={0} agents={[]} projects={projects} readOnly={false} onNavigate={()=>{}} onChanged={()=>{}} visit={0} project="p1" onOpenProject={()=>{}} onCloseProject={()=>{}}/></MessageLinks.Provider>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "RequestDeliverables", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
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
const plain = (value) => JSON.parse(JSON.stringify(value));
const desk = { agentId: "d", name: "Dev Lead" };
const result = (minutes, status = "done") => ({ id: `res-${minutes}`, status, reportedAt: ago(minutes) });
const delivered = (items, minutes = 60) => ({ resultId: `res-${minutes}`, reportedAt: ago(minutes), items });
const card = (sectionId, task, status, extra = {}) =>
  ({ sectionId, key: task.toLowerCase(), title: `Card ${task}`, live: status === "doing", task: { id: task, status, archived: false }, responsible: null, ...extra });
const request = (n, title, state, cards, extra = {}) => ({
  id: `r${n}`, n, text: `Words of R-${n}`, textBlocks: null, title, createdAt: ago(300 - n), frontAgentId: "d", messageId: `m${n}`,
  delivery: "accepted", replies: [], notes: [{ note: "OK", by: desk, at: ago(299 - n) }], routes: [], cards, state,
  progress: { cards: cards.length, ended: cards.filter((c) => c.task.status !== "doing").length }, lines: [], ...extra,
});
const report = (version, state, currentVersion, extra = {}) =>
  ({ kind: "report", title: "Atlas review", note: "Six improvements, in order", key: "audit-review", version, sectionId: 518, state, currentVersion, ...extra });
const ANSWER = "The default is JSON; Settings → Export switches it to CSV or Markdown, and each project keeps its own choice.";

/** A request the user confirmed done, its one card done with nothing named. */
const finished = (n, minutes) => request(n, `Finished R-${n}`, "done", [card(600 + n, `YN-${50 + n}`, "done", { result: result(minutes), deliverables: null })],
  { confirmedAt: ago(minutes - 1) });
/** `arrived`: a request confirmed during the visit, newer than every one shown (PR 1093 R1). */
let arrived = false;
/** R-9 as R-18: a review whose report is out while the release it asked for goes on. R-8: every other way a card stands. */
const requests = () => [
  ...(arrived ? [finished(10, 2)] : []),
  request(9, "Review the architecture, then release", "doing", [
    card(516, "YN-96", "done", { result: result(70), deliverables: delivered([report(2, "live", 2)], 70) }),
    card(530, "YN-97", "doing", { result: null, deliverables: null }),
  ]),
  request(8, "Export, every way it went", "ended", [
    card(501, "YN-81", "done", { result: result(90), deliverables: delivered([
      report(1, "history", 3, { key: "backup-time", sectionId: 480, title: "Backup time" }),
      report(2, "replaced", 3, { key: "export-formats", sectionId: 505, title: "Export formats" }),
      report(1, "gone", null, { key: "old-notes", sectionId: 470, title: "Old notes" }),
    ]) }),
    card(502, "YN-82", "done", { result: result(80, "review"), deliverables: delivered([
      { kind: "pr", title: "[YN-82] Export Markdown", note: "Tables kept", url: "https://github.com/example/atlas/pull/81", repository: "example/atlas",
        number: 81, state: "merged", observedAt: ago(120) },
      { kind: "release", title: "Atlas 0.9.0", note: null, url: "https://github.com/example/atlas/releases/tag/v0.9.0", repository: "example/atlas", tag: "v0.9.0" },
      { kind: "answer", title: null, text: ANSWER },
    ]) }),
    card(503, "YN-83", "cancelled", { result: null, deliverables: null }),
    card(504, "YN-84", "done", { result: result(85), deliverables: null }),
    card(505, "YN-85", "done", { result: null, deliverables: null }),
    card(506, "YN-86", "done", { result: result(86), deliverables: delivered([], 86) }),
  ]),
  // From an older Core: no result or deliverables at all.
  request(7, "From an older Core", "ended", [{ sectionId: 507, key: "yn-80", title: "Old card", live: false,
    task: { id: "YN-80", status: "done", archived: false }, responsible: null }]),
  // Done when the page is first read.
  finished(6, 400),
];
/** Older, done, read only when asked: its report still opens from it. */
const older = () => [
  request(3, "An older review", "done", [card(400, "YN-70", "done", { result: result(5000), deliverables: delivered([report(4, "history", 4, { key: "older-review", sectionId: 400, title: "Older review" })], 5000) })],
    { confirmedAt: ago(4900) }),
  finished(2, 6000),
];

/** Home's read: the Project and nothing of its Brief; its requests are read apart. */
const home = () => ({
  generatedAt: ago(0), order: ["p1"], needsYou: [],
  projects: [{
    project: { id: "p1", name: "Atlas" }, contentEditors: { version: 1, editorAgentIds: ["d"] },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], missing: [], unseen: 0, brief: { version: 1, sections: [], history: [] },
  }],
});

function mount({ lang = "en" } = {}) {
  arrived = false;
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://request-deliverables.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.Range.prototype.getClientRects ||= () => [];
  window.Range.prototype.getBoundingClientRect ||= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  window.HTMLElement.prototype.scrollTo = function () {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = (query) => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {} });
  window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  window.localStorage.setItem("yuzuno.projectTalkView.ws.p1", JSON.stringify("requests"));
  const calls = [];
  const answer = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
  window.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET" };
    calls.push(call);
    if (call.url === "/api/home") return answer(home());
    if (call.url.endsWith("/front-desk")) return answer({ version: 1, agentId: null, effectiveAgentId: "d" });
    if (/\/requests\?before=/.test(call.url)) return answer({ requests: older(), hasMore: false });
    if (/\/requests$/.test(call.url)) return answer({ requests: requests(), hasMore: true });
    return answer({ repositories: [], links: [] });
  };
  window.eval(bundle);
  const document = window.document;
  // A request's block; what one of its tasks delivered, under the block's fact; that task's row, in the block opened.
  const cardOf = (n) => document.querySelector(`[data-request-block="${n}"]`);
  const delivered = (n, task) => [...(cardOf(n)?.querySelectorAll(`.request-block-delivered > li[data-task="${task}"] .request-deliverable`) ?? [])];
  // YN-237 ②: what it delivered is under its Details, in the block opened: opened, then drawn.
  const evidence = async (n) => {
    cardOf(n)?.querySelector('.request-block-foot > .request-block-more[data-view="cards"][aria-expanded="false"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const lines = (n, task) => (unfoldBlocks(document), cardOf(n)?.querySelector(`.request-task[data-task="${task}"]`) ?? null);
  const posts = () => calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/github_repositories"));
  return { window, document, errors, calls, cardOf, delivered, evidence, lines, posts, close: () => window.close() };
}

async function talk(options) {
  const page = mount(options);
  page.window.renderTalk();
  await until(() => page.cardOf(9), "the requests are read");
  page.lines(9, "YN-96");
  await until(() => page.lines(8, "YN-83"), "the blocks opened");
  return page;
}

test("R-18's shape: the review's report opens from its request at the version named while the release goes on", async (t) => {
  const page = await talk();
  t.after(page.close);
  const [open] = page.delivered(9, "YN-96");
  assert.equal(open.dataset.kind, "report");
  assert.equal(open.tagName, "BUTTON");
  assert.equal(open.getAttribute("aria-label"), "Open the report “Atlas review”, version 2");
  assert.match(open.textContent, /Atlas review.*Open report.*Report · version 2 · Six improvements, in order/);
  open.click();
  assert.deepEqual(plain(page.window.reports), [{ link: { workspaceId: "ws", projectId: "p1", key: "audit-review", version: 2, sectionId: 518 },
    focused: "request-deliverable" }], "the very version, by its identity; the button holds focus for Back");
  assert.deepEqual(page.delivered(9, "YN-97"), []);
  assert.equal(page.lines(9, "YN-97").querySelector(".request-deliverables-none"), null, "going on, nothing named: nothing said");
  assert.deepEqual(page.posts(), [], "opening confirms nothing");
  assert.deepEqual(page.errors, []);
});

test("each report as it stands, PRs with when GitHub was read, releases unchecked, an answer whole", async (t) => {
  const page = await talk();
  t.after(page.close);
  const items = page.delivered(8, "YN-81");
  // In History with a newer version: still the version named.
  items[0].click();
  assert.match(items[0].textContent, /Report · version 1 in History · version 3 is current/);
  // Replaced: said, and the same report's version Home keeps opens.
  assert.match(items[1].textContent, /Report · version 2 was replaced by version 3.*/);
  assert.match(items[1].textContent, /Open version 3/);
  items[1].click();
  // Gone: said, and its task opens.
  assert.match(items[2].textContent, /Report · version 1 is no longer on Home \(History keeps 30 days\)/);
  items[2].click();
  assert.deepEqual(plain(page.window.reports).map((r) => r.link), [
    { workspaceId: "ws", projectId: "p1", key: "backup-time", version: 1, sectionId: 480 },
    { workspaceId: "ws", projectId: "p1", key: "export-formats", version: 3, sectionId: 505 },
  ]);
  assert.deepEqual(plain(page.window.tasks), ["YN-81"]);

  const [pr, release, answer] = page.delivered(8, "YN-82");
  assert.equal(pr.tagName, "A");
  assert.equal(pr.getAttribute("href"), "https://github.com/example/atlas/pull/81");
  assert.equal(pr.getAttribute("target"), "_blank");
  assert.match(pr.textContent, /PR #81 · merged · as of 2 h ago · Tables kept/);
  assert.equal(release.getAttribute("href"), "https://github.com/example/atlas/releases/tag/v0.9.0");
  assert.match(release.textContent, /Release page · v0\.9\.0 · not checked by Core/);
  assert.equal(answer.tagName, "P");
  assert.ok(answer.textContent.includes(ANSWER), "the answer whole, never cut to a tip");
  assert.deepEqual(page.posts(), []);
  assert.deepEqual(page.errors, []);
});

test("an ended card with nothing named says why and opens its task; an older Core shows nothing", async (t) => {
  const page = await talk();
  t.after(page.close);
  const why = (task) => page.lines(8, task).querySelector(".request-deliverables-none span")?.textContent;
  assert.equal(why("YN-83"), "Nothing delivered", "cancelled");
  assert.equal(why("YN-84"), "Its result names nothing to open");
  assert.equal(why("YN-85"), "Ended with no result");
  assert.equal(why("YN-86"), "Its result names nothing to open", "a cleared list");
  // Its task opens from its line under Details (YN-237 ②), beside why it delivered nothing.
  const openTask = [...page.lines(8, "YN-84").querySelectorAll(".request-task-line button")].find((b) => b.textContent === "Open task");
  openTask.click();
  assert.deepEqual(plain(page.window.tasks), ["YN-84"]);
  const old = page.cardOf(7);
  assert.equal(old.querySelector(".request-block-delivered, .request-deliverables-none"), null, "an older Core: nothing new, nothing guessed");
  assert.deepEqual(page.errors, []);
});

test("older requests are read from the requests side, and a done one's report still opens", async (t) => {
  const page = await talk({ lang: "zh" });
  t.after(page.close);
  const more = [...page.document.querySelectorAll(".project-talk-earlier")].find((b) => b.textContent.trim() === "读更早的请求");
  assert.ok(more, "the page reads older requests itself");
  more.click();
  await until(() => page.cardOf(3), "the older request is read");
  assert.ok(page.calls.some((c) => c.url.endsWith("/requests?before=6")));
  // PR 1093 R1: what the page held stays where it was, and the page read from before comes after it, newest first;
  // a request newer than every one shown comes in at the top of its group.
  const done = () => [...page.document.querySelectorAll(".request-done [data-request-block]")].map((el) => Number(el.dataset.requestBlock));
  assert.deepEqual(done(), [6, 3, 2], "the older ones after R-6, in their own order");
  arrived = true;
  // The Workspace changed, as its events say: the page reads its requests again.
  page.window.renderTalk(1);
  await until(() => page.cardOf(10), "R-10, confirmed meanwhile");
  assert.deepEqual(done(), [10, 6, 3, 2], "the new one on top; the rest where they were");
  const fold = page.document.querySelector(".request-done");
  fold.open = true;
  await page.evidence(3);
  const [open] = page.delivered(3, "YN-70");
  assert.equal(open.getAttribute("aria-label"), "打开报告「Older review」第 4 版");
  assert.match(open.textContent, /报告 · 第 4 版 · 在 History/);
  open.click();
  assert.deepEqual(plain(page.window.reports).map((r) => r.link.version), [4]);
  assert.deepEqual(page.posts(), []);
  assert.deepEqual(page.errors, []);
});
