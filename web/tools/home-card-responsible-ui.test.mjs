import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { tipOf } from "./tip-dom.mjs";

// YN-86 S2b: a card bound to a task says at its foot who answers for it, in
// the rail's words; Reply goes to them by default, Open session opens their
// conversation, the task's key and Reassign open the task; a card archived
// with its task is in Done, with who did it. The real Home on a Project's
// page, with a stand-in Core. Synthetic data only; no Core, browser or
// web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "home-card-responsible-"));
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
window.renderHome=({agents, projects})=>root.render(<Home workspaceId="ws-1" revision={0} jobsRevision={0} agents={agents} projects={projects} readOnly={false} onNavigate={(target)=>window.navigated.push(target)} onChanged={()=>{}} visit={0} project="p1" onOpenProject={()=>{}} onCloseProject={()=>{}}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "HomeCardResponsible", formats: ["iife"] } },
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
const owner = (agentId, name) => ({ agentId, name, state: "active" });
const mori = owner("a", "Mori");
const body = (text) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: {}, children: ["text"] },
  text: { type: "Markdown", props: { text } },
} });
const ids = { spec: 11, question: 12, plain: 13, late: 14, design: 15, old: 16 };
const section = (key, kind, title, version, by, extra = {}) => ({ id: ids[key], key, kind, title, version, owner: by,
  updatedAt: ago(20), updatedTurnId: null, body: body(`${title}: what it says.`), attachments: [], refs: {}, seen: null,
  history: false, ...extra });
const read = (version) => ({ seen: { version, at: ago(10) } });
/** What the page handed over, as plain data of this realm: its objects are the jsdom window's. */
const plain = (value) => JSON.parse(JSON.stringify(value));

// Two tasks: YN-7 goes on with its executor x; YN-5 is done, its executor z released since.
const buildTask = { id: "YN-7", title: "Build the page", shortName: "Build page", status: "doing", archived: false };
const designTask = { id: "YN-5", title: "Design the page", shortName: "Design page", status: "done", archived: false };
const builder = { agentId: "x", name: "YN-7 · Build page", kind: "executor", state: "running" };

const base = { model: "m", color: "sage", cwd: "/w/atlas", goal: "", createdAt: "2026-11-12T00:00:00Z", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1" };
const agents = [
  { ...base, id: "a", name: "Mori", kind: "lead", status: "idle" },
  { ...base, id: "x", name: "YN-7 · Build page", kind: "executor", status: "working",
    executor: { state: "running", agentId: "x", task: { id: "YN-7", title: "Build the page", shortName: "Build page" }, dispatchedAt: ago(90) } },
  { ...base, id: "z", name: "YN-5 · Design page", kind: "executor", status: "idle", closedAt: ago(60),
    executor: { state: "archived", agentId: "z", task: { id: "YN-5", title: "Design the page", shortName: "Design page" }, dispatchedAt: ago(600), since: ago(60) } },
];
const projects = [{ id: "p1", name: "atlas-notes", defaultDirs: {}, createdAt: "", updatedAt: "" }];

function homeData() {
  return {
    generatedAt: ago(0),
    order: ["p1"],
    needsYou: [{ kind: "ask", projectId: "p1", agentId: "a", agentName: "Mori", sectionKey: "question", title: "Which layout?", since: ago(30) }],
    projects: [{
      project: { id: "p1", name: "atlas-notes" },
      contentEditors: { version: 1, editorAgentIds: ["a"] },
      agents: { working: 1, idle: 1, waiting: 0, error: 0, offline: 0, total: 2 },
      errors: [], pending: [], jobs: [], missing: [], unseen: 2,
      brief: {
        version: 9,
        sections: [
          // Read, but its task goes on: in progress (§2.2).
          section("spec", "report", "Page spec", 3, mori, { ...read(3), card: { task: buildTask, responsible: builder } }),
          section("question", "ask", "Which layout?", 1, mori, {
            ask: { question: "Left or right?", state: "open", reply: { options: [{ id: "left", label: "Left" }], freeText: true } },
            card: { task: buildTask, responsible: builder } }),
          // No task: as before.
          section("plain", "report", "Plain notes", 1, mori, read(1)),
          // Its task is done, not read yet: in Done until it is (§3.4). Core has no responsible Agent for it now.
          section("late", "report", "Design notes", 2, mori, { card: { task: designTask, responsible: null } }),
        ],
        history: [
          // Archived with its task, never marked seen; Core reads its assignee as responsible now.
          section("design", "report", "Design v2", 4, mori, { history: true, historyReason: "archived",
            card: { task: designTask, responsible: { agentId: "a", name: "Mori", kind: "lead", state: "idle" } } }),
          section("old", "report", "Last week", 1, mori, { ...read(1), history: true, historyReason: "seen" }),
        ],
      },
    }],
  };
}

function mount({ language } = {}) {
  const errors = [];
  const requests = [];
  const opened = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://responsible.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  if (language) window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.scrollTo = function () {};
  window.addEventListener("yuzuno:open-task-review", (event) => opened.push(event.detail));
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const request = { url: String(url), method, body: init.body ? JSON.parse(init.body) : null };
    requests.push(request);
    let answer = { repositories: [], links: [] };
    if (request.url === "/api/home") answer = homeData();
    else if (request.url.endsWith("/brief/reply"))
      answer = { input: { ...request.body, expectedTurnId: null, question: null }, status: "accepted", turnId: "t2", error: null };
    return { ok: true, status: 200, json: async () => structuredClone(answer), text: async () => JSON.stringify(answer) };
  };
  window.eval(bundle);
  const document = window.document;
  const card = (key) => document.querySelector(`.project-home [data-section-key="${key}"]`);
  const strip = (key) => card(key)?.querySelector(".home-card-responsible") ?? null;
  const group = (name) => document.querySelector(`[aria-labelledby="home-project-p1-${name}"]`);
  const words = (element) => element.textContent.replace(/\s+/g, " ").trim();
  return { window, document, errors, requests, opened, card, strip, group, words, close: () => window.close() };
}

async function openPage(options) {
  const p = mount(options);
  p.window.renderHome({ agents, projects });
  await until(() => p.card("spec") && p.card("design"), "the Project's page with its cards");
  await tick(40);
  return p;
}

test("a card bound to a task says who answers for it at its foot, in the rail's words; its key and Reassign open the task, Open session the conversation (YN-86 S2b)", async (t) => {
  const p = await openPage();
  t.after(p.close);
  const spec = p.card("spec");
  const strip = p.strip("spec");
  assert.ok(strip, "the card has its responsible line");
  assert.equal(strip.getAttribute("aria-label"), "Who answers for “Page spec”");
  assert.equal(strip.querySelector(".home-card-responsible-label").textContent, "Responsible");
  assert.equal(strip.querySelector(".home-card-responsible-name strong").textContent, "YN-7 · Build page");
  // The executor's state as its row on the rail says it (executorView, ExecutorRowState.tsx): running and working.
  assert.equal(strip.querySelector(".home-card-responsible-state").textContent, "Working");
  assert.ok(strip.querySelector(".status-dot").classList.contains("working"));
  // It takes the author's byline: the author is named in its tip, being someone else.
  assert.equal(spec.querySelector(".home-summary-byline .home-owner"), null, "no byline with the author");
  assert.deepEqual(await tipOf(strip.querySelector(".home-card-responsible-name")), ["Card written by Mori"]);
  // Reply moved into the line: not also in the card's head.
  assert.equal(spec.querySelector(".home-summary-head .home-reply-open"), null);
  assert.deepEqual([...strip.querySelectorAll(".home-card-responsible-actions button")].map(p.words), ["Reply", "Open session", "Reassign"]);
  // The key opens its task, and so does Reassign for now (§3.3), where it is assigned or dispatched again.
  const key = strip.querySelector(".home-card-task");
  assert.equal(key.textContent, "YN-7");
  assert.equal(key.getAttribute("aria-label"), "Open task YN-7");
  key.click();
  strip.querySelector(".home-card-reassign").click();
  assert.deepEqual(plain(p.opened), [{ taskId: "YN-7" }, { taskId: "YN-7" }]);
  // Open session: the executor's conversation (App opens an executor on its Overview first).
  strip.querySelector(".home-card-session").click();
  assert.deepEqual(plain(p.window.navigated), [{ kind: "agent", agentId: "x" }]);
  assert.equal(strip.querySelector(".home-card-session").getAttribute("aria-label"), "Open YN-7 · Build page's session");
  // A card with no task is as before: its author's byline and the Reply in its head; no line.
  const plain = p.card("plain");
  assert.equal(p.strip("plain"), null);
  assert.equal(plain.querySelector(".home-summary-byline .home-owner").textContent, "Mori");
  assert.ok(plain.querySelector(".home-summary-head .home-reply-open"));
  assert.deepEqual(p.requests.filter((r) => r.method !== "GET" && !r.url.endsWith("/github_repositories")), [], "showing and opening writes nothing");
  assert.deepEqual(p.errors, []);
});

test("Reply on a bound card and an Ask on it go to whoever answers for the card by default; with no one, to its author (YN-86 §3.3)", async (t) => {
  const p = await openPage();
  t.after(p.close);
  const reply = p.strip("spec").querySelector(".home-reply-open");
  assert.equal(reply.getAttribute("aria-expanded"), "false");
  reply.click();
  const box = await until(() => p.card("spec").querySelector(".home-card-reply"), "the card's reply");
  assert.equal(reply.getAttribute("aria-expanded"), "true");
  const to = box.querySelector(".home-reply-target select");
  assert.equal(to.value, "x", "to the card's executor, not its author");
  assert.equal(to.selectedOptions[0].textContent, "YN-7 · Build page");
  assert.equal(box.querySelector(".home-note"), null, "nothing to choose: its responsible Agent is open here");
  // The ask on the same card: its reply goes to the card's executor too, until the user picks another.
  const ask = p.card("question");
  assert.equal(ask.querySelector(".home-ask-reply .home-reply-target select").value, "x");
  // An ask has its own reply in place: its line has no Reply, nor its author in the head.
  assert.deepEqual([...p.strip("question").querySelectorAll(".home-card-responsible-actions button")].map(p.words), ["Open session", "Reassign"]);
  assert.equal(ask.querySelector(".home-section-meta .home-owner"), null);
  // A card whose task is over has no responsible Agent from Core: its reply goes to its author.
  p.strip("late").querySelector(".home-reply-open").click();
  const late = await until(() => p.card("late").querySelector(".home-card-reply"), "the late card's reply");
  assert.equal(late.querySelector(".home-reply-target select").value, "a");
  assert.deepEqual(p.errors, []);
});

test("a card whose task is done is in Done: a report not read yet with its tag, an archived card with who did it and their session, nothing to reassign (YN-86 §3.4)", async (t) => {
  const p = await openPage();
  t.after(p.close);
  // A read report whose task goes on stays in progress; a read report of no task is done, as before.
  assert.ok(p.group("doing").contains(p.card("spec")), "bound, its task going on: in progress though read");
  assert.ok(p.group("needs").contains(p.card("question")));
  const done = p.document.querySelector(".project-deck-done");
  for (const key of ["plain", "late", "design"]) assert.ok(done.contains(p.card(key)), `${key} is in Done`);
  // Three cards there: the archived one among them, not in the 30-day list again.
  assert.match(done.querySelector("summary").textContent, /^Done · 3 cards · latest .* · 30-day history 1$/);
  done.querySelector("summary").click();
  await until(() => done.open, "Done opens");
  const listed = [...done.querySelectorAll(".home-history li summary")].map((s) => s.textContent);
  assert.equal(listed.length, 1);
  assert.match(listed[0], /Last week/);
  // Not read yet, its task done: it waits here with its tag, still taking a reply.
  const late = p.card("late");
  assert.equal(late.querySelector(".home-task-ended").textContent, "Task done");
  // Archived with its task: as it was, with who did it, from the Agent list, and their session to read.
  const design = p.card("design");
  assert.equal(design.querySelector(".home-task-ended").textContent, "Task done, archived");
  assert.equal(design.querySelector(".home-changed"), null, "nothing left to read on it: never New");
  for (const key of ["late", "design"]) {
    const strip = p.strip(key);
    assert.equal(strip.querySelector(".home-card-responsible-name strong").textContent, "YN-5 · Design page", `${key}: its executor`);
    assert.equal(strip.querySelector(".home-card-responsible-state").textContent, "Done · Archived", `${key}: as the rail says it`);
    assert.equal(strip.querySelector(".home-card-reassign"), null, `${key}: nothing to reassign`);
    assert.equal(strip.querySelector(".home-card-task").textContent, "YN-5");
  }
  assert.deepEqual([...p.strip("design").querySelectorAll(".home-card-responsible-actions button")].map(p.words), ["Open session"], "no reply to an archived card");
  assert.equal(design.querySelector(".home-seen"), null, "nothing to mark seen");
  p.strip("design").querySelector(".home-card-session").click();
  assert.deepEqual(plain(p.window.navigated), [{ kind: "agent", agentId: "z" }], "the released executor's session");
  assert.deepEqual(p.errors, []);
});

test("the responsible line and Done's archived cards in Chinese (YN-86 S2b)", async (t) => {
  const p = await openPage({ language: "zh-Hans" });
  t.after(p.close);
  const strip = p.strip("spec");
  assert.equal(strip.getAttribute("aria-label"), "“Page spec”的负责人");
  assert.equal(strip.querySelector(".home-card-responsible-label").textContent, "负责人");
  assert.equal(strip.querySelector(".home-card-responsible-state").textContent, "在做");
  assert.deepEqual([...strip.querySelectorAll(".home-card-responsible-actions button")].map(p.words), ["回复", "打开会话", "改派"]);
  assert.equal(strip.querySelector(".home-card-task").getAttribute("aria-label"), "打开任务 YN-7");
  assert.deepEqual(await tipOf(strip.querySelector(".home-card-responsible-name")), ["卡片由 Mori 写"]);
  assert.equal(p.card("late").querySelector(".home-task-ended").textContent, "任务已完成");
  assert.equal(p.card("design").querySelector(".home-task-ended").textContent, "任务完成，已归档");
  assert.equal(p.strip("design").querySelector(".home-card-responsible-state").textContent, "完成 · 已归档");
  assert.match(p.document.querySelector(".project-deck-done summary").textContent, /^已完成/);
  assert.deepEqual(p.errors, []);
});
