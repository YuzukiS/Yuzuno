import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// YN-212 W3a: a request's block and the Project's own block, the real
// components over the blocks request-blocks.ts makes (W1), in English and
// Chinese: the first look is one fact and one action, what was delivered,
// and, unfolded, the tasks with one card each, the joined tasks and the
// request's own conversation. Synthetic data only; nothing is sent.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "request-blocks-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React, {useState} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {RequestBlockView, ProjectBlockView} from ${JSON.stringify(path.join(root, "src/home/RequestBlocks.tsx"))};
import {pageBlocks} from ${JSON.stringify(path.join(root, "src/home/request-blocks.ts"))};
import {CardAgents} from ${JSON.stringify(path.join(root, "src/home/card-responsible.ts"))};
const root=createRoot(document.getElementById('root'));
window.calls=[];
function Page({requests, sections, readOnly}) {
  const {blocks, project} = pageBlocks(requests, sections);
  const [open, setOpen] = useState(new Set(window.opened || []));
  const toggle = (key) => setOpen((was) => { const next = new Set(was); if (!next.delete(key)) next.add(key); return next; });
  const common = {projectId: 'p1', workspaceId: 'ws', agents: window.agents, readOnly: !!readOnly, onSeen: async () => {}, onChanged: () => {},
    onReport: (link) => window.calls.push({report: link})};
  return <div>{blocks.map((block) => <RequestBlockView key={block.key} block={block} open={open.has(block.key)} onToggle={() => toggle(block.key)}
    onAction={(action, n, key) => window.calls.push({action, n, key: key ?? null})} onShowBlock={(n) => window.calls.push({show: n})} common={common}/>)}
    {project && <ProjectBlockView block={project} open={open.has('project')} onToggle={() => toggle('project')} common={common}/>}</div>;
}
window.renderPage=(props)=>flushSync(()=>root.render(<CardAgents.Provider value={new Map(window.agents.map((a)=>[a.id,a]))}><Page {...props}/></CardAgents.Provider>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "RequestBlocks", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const base = { model: "m", color: "sage", cwd: "/w/atlas", goal: "", createdAt: "2026-11-12T00:00:00Z", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", harness: "codex" };
const agents = [
  { ...base, id: "d", name: "Dev Lead", kind: "lead", status: "idle" },
  { ...base, id: "x", name: "YN-91 · Design", kind: "executor", status: "working",
    executor: { agentId: "x", state: "running", task: { id: "YN-91", title: "Settings layout", shortName: "Design" }, dispatchedAt: ago(30) } },
];
const desk = { agentId: "d", name: "Dev Lead" };
const lead = { agentId: "d", name: "Dev Lead", state: "active" };
const designer = { agentId: "x", name: "YN-91 · Design", kind: "executor", state: "running" };
let id = 100;
const section = (key, kind, title, minutes, extra = {}) => ({
  id: id++, key, kind, title, version: 2, owner: lead, updatedAt: ago(minutes), updatedTurnId: "t",
  body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["a"] }, a: { type: "Markdown", props: { text: `${title}.` } } } },
  attachments: [], refs: {}, seen: null, history: false, ...extra,
});
const bind = (task, status = "doing", responsible = designer) => ({ task: { id: task, title: task, status, archived: false }, responsible });
const routed = (s, task, status = "doing", responsible = designer, items = null, minutes = 0) => ({
  sectionId: s?.id ?? null, key: s?.key ?? null, title: s?.title ?? null, live: !!s, task: { id: task, status, archived: false }, responsible,
  ...(items ? { result: { id: `r-${task}`, status: "review", reportedAt: ago(minutes) }, deliverables: { resultId: `r-${task}`, reportedAt: ago(minutes), items } } : {}),
});
const request = (n, minutes, state, cards, extra = {}) => ({
  id: `req-${n}`, n, text: `Words of R-${n}`, textBlocks: null, images: [], files: [], title: `Request ${n}`, createdAt: ago(minutes),
  frontAgentId: "d", messageId: `m${n}`, delivery: "accepted", replies: [], notes: [{ note: "On it.", by: desk, at: ago(minutes - 1) }],
  routes: [], cards, state, progress: { cards: cards.length, ended: 0 }, lines: [], ...extra,
});

/** R-7 waits for an answer, R-8 delivered and ended, R-9 is in progress with a card, R-10 joined R-9's task, R-11 was
 * confirmed done; the Project's own status. */
function fixtures() {
  id = 100;
  const card7 = section("yn-91", "status", "Two layouts drawn", 30, { status: { asOf: ago(30), validFor: 3600, stale: false }, card: bind("YN-91") });
  const ask7 = section("yn-91/pick", "ask", "Pick a layout", 20, {
    owner: { agentId: "x", name: "YN-91 · Design", state: "active" },
    ask: { question: "Which layout?", state: "open", reply: { options: [{ id: "a", label: "A" }], freeText: true } }, card: bind("YN-91"),
  });
  const answered7 = section("yn-91/copy", "ask", "Copy tone", 60, {
    ask: { question: "Casual copy?", state: "resolved", reply: { freeText: true }, repliedAt: ago(55), replyText: "Yes" }, card: bind("YN-91"),
  });
  const card9 = section("yn-93", "status", "Halfway through the export", 5, { author: { agentId: "x", name: "YN-93 · Export" },
    status: { asOf: ago(5), validFor: 3600, stale: true }, card: bind("YN-93") });
  const report8 = { kind: "report", title: "Export formats compared", note: null, key: "yn-92", version: 3, sectionId: 999, state: "live", currentVersion: 3 };
  const pr8 = { kind: "pr", title: "Export as CSV", note: null, url: "https://example.test/pull/7", repository: "o/r", number: 7, state: "merged", observedAt: ago(9) };
  const own = section("development", "status", "Development state", 40, { status: { asOf: ago(40), validFor: 86400, stale: false } });
  const requests = [
    request(11, 300, "done", [routed(null, "YN-80", "done", null)], { confirmedAt: ago(200) }),
    request(10, 90, "doing", [routed(card9, "YN-93")]),
    request(9, 100, "doing", [routed(card9, "YN-93")], { replies: [{ n: 1, text: "And JSON too", textBlocks: null, images: [], files: [], at: ago(80), messageId: "m9-1", deliveredTo: [] }] }),
    request(8, 200, "ended", [routed(null, "YN-92", "done", null, [report8, pr8], 10)]),
    request(7, 120, "doing", [routed(card7, "YN-91")], {
      lines: [{ kind: "ask", sectionId: ask7.id, key: ask7.key, title: ask7.title, state: "open", at: ago(20), task: "YN-91", cardSectionId: card7.id }],
    }),
  ];
  return { requests, sections: [card7, ask7, answered7, card9, own] };
}

function mount({ lang = "en", readOnly = false, opened = [] } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://request-blocks.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.Range.prototype.getClientRects ||= () => [];
  window.Range.prototype.getBoundingClientRect ||= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  window.HTMLElement.prototype.scrollTo = function () {};
  window.matchMedia = (query) => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {} });
  window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  window.agents = agents;
  window.opened = opened;
  window.fetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" });
  window.eval(bundle);
  window.renderPage({ ...fixtures(), readOnly });
  const document = window.document;
  const block = (n) => document.querySelector(`[data-request-block="${n}"]`);
  const text = (el) => el?.textContent.replace(/\s+/g, " ").trim() ?? "";
  return { window, document, errors, block, text, calls: () => JSON.parse(JSON.stringify(window.calls)) };
}

test("each request's first look: its one fact, its one action and what it delivered, in English", () => {
  const page = mount();
  const fact = (n) => page.text(page.block(n).querySelector(".request-block-fact-line"));
  const meta = (n) => page.text(page.block(n).querySelector(".request-block-fact-meta"));
  const action = (n) => page.block(n).querySelector(".request-block-action");
  assert.equal(fact(7), "Waiting for you: Which layout?");
  assert.match(meta(7), /^YN-91 · /);
  assert.equal(action(7).dataset.action, "answer");
  assert.ok(action(7).classList.contains("is-primary"));
  assert.equal(fact(8), "YN-92 is done · delivered 2 items");
  assert.equal(action(8).dataset.action, "confirm");
  assert.equal(page.block(8).querySelectorAll(".request-block-delivered li").length, 2);
  assert.equal(fact(9), "Halfway through the export");
  assert.match(meta(9), /^Card past its validity · by YN-93 · Export · /, "the author named for its task says which task");
  assert.equal(action(9).dataset.action, "follow");
  assert.ok(!action(9).classList.contains("is-primary"));
  assert.equal(fact(10), "Halfway through the export", "a joined request reads its task's fact");
  assert.equal(page.block(11).querySelector(".request-block-action"), null, "a confirmed request has nothing to do");
  assert.equal(page.text(page.block(7).querySelector(".request-block-more")), "1 task · 3 in the conversation");
  assert.deepEqual(page.errors, []);
});

test("the same in Chinese", () => {
  const page = mount({ lang: "zh" });
  const fact = (n) => page.text(page.block(n).querySelector(".request-block-fact-line"));
  assert.equal(fact(7), "等你决定：Which layout?");
  assert.equal(fact(8), "YN-92 已完成 · 交付 2 项");
  assert.equal(page.text(page.block(7).querySelector(".request-block-action")), "回答");
  assert.equal(page.text(page.block(8).querySelector(".request-block-action")), "确认完成");
  assert.equal(page.text(page.block(9).querySelector(".request-block-action")), "追问");
  assert.match(page.text(page.block(9).querySelector(".request-block-fact-meta")), /^卡片已过有效期 · YN-93 · Export 写 · /);
  assert.equal(page.text(page.block(7).querySelector(".request-block-more")), "1 个任务 · 对话 3 条");
  assert.equal(page.text(page.document.querySelector("[data-project-block] .request-block-title")), "不属于任何请求");
});

test("an action says which request it is for; an answer names its Ask; a deliverable opens its version", () => {
  const page = mount();
  for (const n of [7, 8, 9]) page.block(n).querySelector(".request-block-action").click();
  assert.deepEqual(page.calls(), [
    { action: "answer", n: 7, key: "yn-91/pick" },
    { action: "confirm", n: 8, key: null },
    { action: "follow", n: 9, key: null },
  ]);
  assert.equal(page.block(7).querySelector(".request-block-action").getAttribute("aria-label"), "Answer: R-7");
  page.block(8).querySelector('.request-deliverable[data-kind="report"]').click();
  assert.deepEqual(page.calls().at(-1), { report: { key: "yn-92", version: 3, sectionId: 999 } });
});

test("unfolded: open Asks first, then the task's one card, the answered Asks, joined tasks and the request's own conversation", async () => {
  const page = mount({ opened: ["r7", "r10", "r9"] });
  const r7 = page.block(7);
  const parts = [...r7.querySelector(".request-task").children].map((el) => el.dataset.sectionKey ?? el.querySelector("[data-section-key]")?.dataset.sectionKey ?? el.className);
  assert.deepEqual(parts, ["yn-91/pick", "yn-91", "request-task-answered"], "the open Ask, the one card, the answered Ask");
  assert.equal(page.text(r7.querySelector(".request-task-answered")), "Answered: Casual copy? → Yes");
  assert.equal(page.text(r7.querySelector(".request-thread > summary")), "Conversation 3");
  // R-10 joined R-9's task: one line, which shows R-9.
  const joined = page.block(10).querySelector(".request-block-joined");
  assert.match(page.text(joined), /^Joined YN-93 “Halfway through the export” · its card is under R-9/);
  assert.equal(page.block(10).querySelector(".request-task"), null, "the task's card is under R-9 only");
  joined.querySelector("button").click();
  assert.deepEqual(page.calls().at(-1), { show: 9 });
  assert.equal(page.text(page.block(9).querySelector(".request-task-also")), "Also for R-10");
  // Folding again keeps the first look.
  r7.querySelector(".request-block-more").click();
  await tick();
  assert.equal(page.block(7).querySelector(".request-block-body"), null);
});

// PR 1089 R1 (P3): a task's other statuses and reports, from before one task had one card, fold under its card; a
// card's task is said unless its author is named for that very task (YN-9 is not YN-93).
test("a task's earlier cards fold under its one card; its task is said unless its author is named for that very task", async () => {
  const page = mount({ opened: ["r7"] });
  const { requests, sections } = fixtures();
  const earlier = section("yn-91/lead", "status", "Lead notes on the layouts", 90, { status: { asOf: ago(90), validFor: 3600, stale: false }, card: bind("YN-91") });
  const nine = section("yn-9", "status", "Nine's card", 3, { author: { agentId: "x", name: "YN-93 · Export" },
    status: { asOf: ago(3), validFor: 3600, stale: false }, card: bind("YN-9") });
  page.window.renderPage({ requests: [...requests, request(12, 10, "doing", [routed(nine, "YN-9")])], sections: [...sections, earlier, nine] });
  await tick();
  const fold = page.block(7).querySelector('.request-task[data-task="YN-91"] > .request-task-earlier');
  assert.equal(page.text(fold.querySelector("summary")), "Earlier card 1");
  assert.equal(fold.open, false, "folded");
  assert.ok(fold.querySelector('[data-section-key="yn-91/lead"]'), "the earlier card, in the fold");
  assert.equal(page.block(7).querySelector('.request-task-card [data-section-key]').dataset.sectionKey, "yn-91", "the newest is its one card");
  assert.match(page.text(page.block(12).querySelector(".request-block-fact-meta")), /^YN-9 · by YN-93 · Export/);
  assert.match(page.text(page.block(9).querySelector(".request-block-fact-meta")), /^Card past its validity · by YN-93 · Export/);
  assert.deepEqual(page.errors, []);
});

// YN-212 W4: who wrote the version shown (Core's author, C1; else its owner), a card older than the user's reply on
// its task, and the card's earlier versions (C2), each opening the report page at that version by its identity.
test("a task's card says who wrote it and that it was written before your reply, and opens its earlier versions", async () => {
  const page = mount({ opened: ["r7", "r9"] });
  const { requests, sections } = fixtures();
  const card7 = sections.find((s) => s.key === "yn-91");
  card7.updatedAt = ago(70);
  card7.revisions = [{ version: 1, author: { agentId: "x", name: "YN-91 · Design" }, at: ago(90) }];
  page.window.renderPage({ requests, sections });
  await tick();
  const task = page.block(7).querySelector('.request-task[data-task="YN-91"]');
  assert.equal(page.text(task.querySelector(".request-task-before")), "Written before your reply", "the reply at 55 min, the card at 70");
  assert.equal(page.text(task.querySelector('.request-task-card [data-section-key="yn-91"] .home-card-author')), "Written by Dev Lead",
    "no author from Core: its owner");
  assert.equal(page.text(page.block(9).querySelector(".home-card-author")), "Written by YN-93 · Export", "Core's author");
  const versions = task.querySelector(".request-task-versions");
  assert.equal(versions.open, false, "folded");
  assert.equal(page.text(versions.querySelector("summary")), "Earlier version 1");
  assert.match(page.text(versions.querySelector("li")), /^Version 1\s*by YN-91 · Design/);
  versions.querySelector("button").click();
  assert.deepEqual(page.calls().at(-1), { report: { key: "yn-91", version: 1, sectionId: card7.id } });
  // A card with no earlier version, or read the same time as the reply, says neither.
  assert.equal(page.block(9).querySelector(".request-task-versions, .request-task-before"), null);
  assert.deepEqual(page.errors, []);
});

test("read only: no action, the first look and what was delivered stay", () => {
  const page = mount({ readOnly: true });
  assert.equal(page.document.querySelectorAll(".request-block-action").length, 0);
  assert.equal(page.block(8).querySelectorAll(".request-deliverable").length, 2);
});

test("the Project's own block: one line a card until opened, then the cards", async () => {
  const page = mount();
  const own = page.document.querySelector("[data-project-block]");
  assert.deepEqual([...own.querySelectorAll(".project-block-line-title")].map(page.text), ["Development state"]);
  assert.equal(page.text(own.querySelector(".request-block-more")), "1 card");
  own.querySelector(".project-block-lines button").click();
  await tick();
  const opened = page.document.querySelector("[data-project-block]");
  assert.equal(opened.querySelector(".project-block-lines"), null);
  assert.deepEqual([...opened.querySelectorAll(".project-block-cards [data-section-key]")].map((el) => el.dataset.sectionKey), ["development"]);
});
