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
// request's own conversation. The Project's own block (R-27): its open Asks
// each on their own, its cards in a group of their own. Synthetic data only;
// nothing is sent.
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
import {RequestBlockView, ProjectAsks, ProjectCards, useAsksUpFront} from ${JSON.stringify(path.join(root, "src/home/RequestBlocks.tsx"))};
import {pageBlocks, projectCardsCount} from ${JSON.stringify(path.join(root, "src/home/request-blocks.ts"))};
import {CardAgents} from ${JSON.stringify(path.join(root, "src/home/card-responsible.ts"))};
import {ProjectNow} from ${JSON.stringify(path.join(root, "src/home/ProjectNow.tsx"))};
import {ReportOpen} from ${JSON.stringify(path.join(root, "src/home/report/report-open.ts"))};
const root=createRoot(document.getElementById('root'));
const nowRoot=createRoot(document.getElementById('now'));
window.renderNow=({readOnly, note, ...props})=>flushSync(()=>nowRoot.render(<CardAgents.Provider value={new Map(window.agents.map((a)=>[a.id,a]))}>
  <ReportOpen.Provider value={(projectId, section, from) => window.calls.push({open: section.key, projectId, from: from.className})}>
  <ProjectNow onMore={() => window.calls.push({more: true})} common={{projectId: 'p1', workspaceId: 'ws', agents: window.agents, readOnly: !!readOnly,
    onSeen: async (marks) => { window.calls.push({seen: marks}); }, onChanged: () => {}, onReport: () => {}, upFront: () => false,
    notice: (s) => (note && s.key === note ? <p className="home-reply-arrival">A reply landed here</p> : undefined)}} {...props}/></ReportOpen.Provider></CardAgents.Provider>));
window.calls=[];
function Page({requests, sections, readOnly}) {
  const {blocks, project} = pageBlocks(requests, sections);
  const [open, setOpen] = useState(new Set(window.opened || []));
  const toggle = (key) => setOpen((was) => { const next = new Set(was); if (!next.delete(key)) next.add(key); return next; });
  const choose = (key, on) => setOpen((was) => { if (was.has(key) === on) return was; const next = new Set(was); if (on) next.add(key); else next.delete(key); return next; });
  const upFront = useAsksUpFront([...blocks.flatMap((block) => block.asks), ...(project?.asks ?? [])]);
  const common = {projectId: 'p1', workspaceId: 'ws', agents: window.agents, readOnly: !!readOnly, onSeen: async () => {}, onChanged: () => {},
    onReport: (link) => window.calls.push({report: link}), upFront};
  return <div>{blocks.map((block) => <RequestBlockView key={block.key} block={block} open={open.has(block.key)} onToggle={() => toggle(block.key)}
    onAction={(action, n, key) => window.calls.push({action, n, key: key ?? null})} onShowBlock={(n) => window.calls.push({show: n})} common={common}/>)}
    {project && <div className="needs"><ProjectAsks block={project} common={common}/></div>}
    {project && <ProjectCards block={project} count={projectCardsCount(project, project.asks.filter((ask) => !upFront(ask)).length, null)}
      open={open.has('project')} onToggle={(on) => choose('project', on)} common={common}/>}</div>;
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
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="now"></div></body></html>', {
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
  // W5: R-7's open Ask is its first look, whole and answerable there; no line repeats its question, no Answer.
  const asks = page.block(7).querySelector(".request-block-asks");
  assert.equal(asks.getAttribute("aria-label"), "Questions for you in “Request 7”");
  assert.deepEqual([...asks.querySelectorAll("[data-section-key]")].map((el) => el.dataset.sectionKey), ["yn-91/pick"]);
  assert.match(page.text(asks), /Which layout\?/);
  assert.ok(asks.querySelector("textarea, [data-composer-input], button"), "its reply is there");
  assert.equal(page.block(7).querySelector(".request-block-fact"), null);
  assert.equal(action(7), null);
  assert.equal(page.document.activeElement, page.document.body, "shown, nothing takes the focus");
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
  assert.equal(page.block(7).querySelector(".request-block-asks").getAttribute("aria-label"), "「Request 7」里等你回答的问题");
  assert.equal(page.block(7).querySelector(".request-block-action"), null, "no 回答 before the Ask: it is there");
  assert.equal(fact(8), "YN-92 已完成 · 交付 2 项");
  assert.equal(page.text(page.block(8).querySelector(".request-block-action")), "确认完成");
  assert.equal(page.text(page.block(9).querySelector(".request-block-action")), "追问");
  assert.match(page.text(page.block(9).querySelector(".request-block-fact-meta")), /^卡片已过有效期 · YN-93 · Export 写 · /);
  assert.equal(page.text(page.block(7).querySelector(".request-block-more")), "1 个任务 · 对话 3 条");
  const group = page.document.querySelector("[data-project-block] > summary");
  assert.equal(page.text(group.querySelector(".request-group-note")), "不属于任何请求");
  assert.equal(page.text(group), "项目卡 1新不属于任何请求", "its card not read yet: 新");
});

test("an action says which request it is for; a deliverable opens its version", () => {
  const page = mount();
  for (const n of [8, 9]) page.block(n).querySelector(".request-block-action").click();
  assert.deepEqual(page.calls(), [
    { action: "confirm", n: 8, key: null },
    { action: "follow", n: 9, key: null },
  ]);
  assert.equal(page.block(8).querySelector(".request-block-action").getAttribute("aria-label"), "Confirm done: R-8");
  page.block(8).querySelector('.request-deliverable[data-kind="report"]').click();
  assert.deepEqual(page.calls().at(-1), { report: { key: "yn-92", version: 3, sectionId: 999 } });
});

// R-30: a delivery waiting for the user's confirmation has Follow up beside Confirm done, which goes to the same
// request and confirms nothing; the line under its fact says it waits for the user, and a confirmed one says so.
test("Confirm done has Follow up beside it; waiting for you and confirmed by you are said apart from a task being done", () => {
  const page = mount();
  const actions = (n) => [...page.block(n).querySelectorAll(".request-block-action")];
  assert.deepEqual(actions(8).map((b) => [b.dataset.action, page.text(b), b.getAttribute("aria-label"), b.classList.contains("is-primary")]), [
    ["confirm", "Confirm done", "Confirm done: R-8", true],
    ["follow", "Follow up", "Follow up: R-8", false],
  ]);
  assert.deepEqual(actions(9).map((b) => b.dataset.action), ["follow"], "in progress: Follow up alone");
  actions(8)[1].click();
  assert.deepEqual(page.calls(), [{ action: "follow", n: 8, key: null }], "Follow up confirms nothing");
  assert.match(page.text(page.block(8).querySelector(".request-block-fact-meta")), /^Waiting for you to confirm · /);
  assert.match(page.text(page.block(11).querySelector(".request-block-fact-meta")), /^Confirmed by you · /);
  assert.doesNotMatch(page.text(page.block(9).querySelector(".request-block-fact-meta")), /confirm/i);
  const zh = mount({ lang: "zh" });
  assert.deepEqual([...zh.block(8).querySelectorAll(".request-block-action")].map(zh.text), ["确认完成", "继续跟进"]);
  assert.match(zh.text(zh.block(8).querySelector(".request-block-fact-meta")), /^等你确认 · /);
  assert.match(zh.text(zh.block(11).querySelector(".request-block-fact-meta")), /^你已确认 · /);
  assert.deepEqual([...page.errors, ...zh.errors], []);
});

test("unfolded: open Asks first, then the task's one card, the answered Asks, joined tasks and the request's own conversation", async () => {
  const page = mount({ opened: ["r7", "r10", "r9"] });
  const r7 = page.block(7);
  const parts = [...r7.querySelector(".request-task").children].map((el) => el.dataset.sectionKey ?? el.querySelector("[data-section-key]")?.dataset.sectionKey ?? el.className);
  assert.deepEqual(parts, ["yn-91", "request-task-answered-ask"], "the one card, the answered Ask: the open Ask is in the first look only");
  assert.equal(r7.querySelectorAll('[data-section-key="yn-91/pick"]').length, 1, "unfolded, the Ask is not drawn again");
  const line = r7.querySelector(".request-task-answered");
  assert.equal(page.text(line), "Answered: Casual copy? → Yes");
  // YN-223: the line opens, in place, its answer card: the question, the reply; its owner resolved it, so nothing
  // more is sent from it; a reply from before Core kept the question with it, said so.
  assert.equal(line.tagName, "BUTTON");
  assert.equal(line.getAttribute("aria-expanded"), "false");
  assert.equal(r7.querySelector('[data-section-key="yn-91/copy"]'), null, "compact until opened");
  line.click();
  await tick(40);
  assert.equal(line.getAttribute("aria-expanded"), "true");
  const answered = r7.querySelector('[data-section-key="yn-91/copy"]');
  assert.equal(answered.closest(".request-task-answered-card").id, line.getAttribute("aria-controls"));
  assert.ok(answered.classList.contains("is-answer"), "its answer card");
  assert.equal(answered.querySelector(".home-kind").textContent.trim(), "Resolved by Dev Lead");
  assert.equal(answered.querySelector(".home-answer-ask").textContent, "Casual copy?");
  assert.equal(answered.querySelector(".home-reply-words").textContent.trim(), "Yes");
  assert.ok(answered.querySelector(".home-answer-unkept"), "an earlier reply, said so");
  assert.deepEqual([...answered.querySelectorAll(".home-answer-given footer button")].map((b) => b.textContent.trim()), ["Copy answer", "Details"],
    "resolved: nothing more is sent from it");
  assert.equal(answered.querySelector(".home-ask"), null, "no reply controls under it");
  line.click();
  await tick(40);
  assert.equal(r7.querySelector('[data-section-key="yn-91/copy"]'), null, "closed again: the line");
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

// W5 (R-20 follow-up): every open Ask is in its block's first look, each once. A task two requests share shows its
// Ask under the first; the other says where, and its Answer goes there. Answered in this visit, an Ask stays where it
// was; the Project's own Asks are up front too.
test("every open Ask is in the first look once: two of one task, one of a shared task, one answered now, the Project's", async () => {
  const page = mount();
  const data = fixtures();
  const extra = {
    owner: { agentId: "x", name: "YN-91 · Design", state: "active" },
    ask: { question: "Which font?", state: "open", reply: { options: [{ id: "s", label: "Serif" }], freeText: true } }, card: bind("YN-91"),
  };
  const font = section("yn-91/font", "ask", "Pick a font", 10, extra);
  const shared = section("yn-93/scope", "ask", "Export scope", 8, {
    ask: { question: "JSON too?", state: "open", reply: { freeText: true } }, card: bind("YN-93"),
  });
  const mine = section("pick", "ask", "Release window", 6, { ask: { question: "Ship on Friday?", state: "open", reply: { freeText: true } } });
  const render = (sections) => page.window.renderPage({ requests: data.requests, sections, readOnly: false });
  render([...data.sections, font, shared, mine]);
  await tick();
  const keys = (el) => [...el.querySelectorAll(".request-block-asks [data-section-key]")].map((card) => card.dataset.sectionKey);
  assert.deepEqual(keys(page.block(7)), ["yn-91/pick", "yn-91/font"], "both, in the order they were put, each answerable");
  assert.deepEqual(keys(page.block(9)), ["yn-93/scope"], "the shared task's Ask under R-9, where its card is");
  assert.deepEqual(keys(page.block(10)), [], "not drawn again under R-10");
  assert.equal(page.text(page.block(10).querySelector(".request-block-fact-line")), "Waiting for you under R-9: JSON too?");
  page.block(10).querySelector(".request-block-action").click();
  assert.deepEqual(page.calls().at(-1), { action: "answer", n: 10, key: "yn-93/scope" }, "its Answer goes to the Ask under R-9");
  // The Project's own Ask stands on its own (in Needs you on the page, R-27 §3.5), saying whose it is.
  const own = [...page.document.querySelectorAll(".project-ask")];
  assert.deepEqual(own.map((el) => el.dataset.projectAsk), ["pick"]);
  assert.equal(page.text(own[0].querySelector(".home-from")), "Project · From Dev Lead");
  assert.deepEqual([...own[0].querySelectorAll("[data-section-key]")].map((el) => el.dataset.sectionKey), ["pick"], "answerable there");
  assert.equal(page.text(page.document.querySelector("[data-project-block] > summary")), "Project cards 1NewNot part of a request", "its other card in the group");
  assert.equal(page.document.querySelectorAll('[data-section-key="yn-91/pick"], [data-section-key="yn-93/scope"], [data-section-key="pick"]').length, 3);

  // Core's next read: R-7's first Ask answered. It stays where it was for the visit, its answer in its place.
  const replied = data.sections.map((s) => s.key === "yn-91/pick"
    ? { ...s, version: 3, ask: { ...s.ask, state: "replied", repliedAt: ago(0), replyText: "A" } }
    : s);
  render([...replied, font, shared, mine]);
  await tick();
  assert.deepEqual(keys(page.block(7)), ["yn-91/pick", "yn-91/font"], "nothing moved");
  page.block(7).querySelector(".request-block-more").click();
  await tick();
  assert.equal(page.block(7).querySelectorAll('[data-section-key="yn-91/pick"]').length, 1, "unfolded, not drawn again");
  assert.deepEqual([...page.block(7).querySelectorAll(".request-task-answered")].map(page.text), ["Answered: Casual copy? → Yes"],
    "the Ask answered now is not a line below as well");
  assert.deepEqual(page.errors, []);
});

// PR 1098 R1: an Ask kept in History under a key a new open Ask uses again is another section (another identity):
// only the new one is up front, held there once answered; the old one stays an Answered line, never a second card.
test("an older Ask in History under the same key stays an Answered line beside the new one up front", async () => {
  const page = mount({ opened: ["r7"] });
  const data = fixtures();
  const old = section("yn-91/pick", "ask", "Pick a layout", 300, {
    history: true, historyReason: "resolved", card: bind("YN-91"),
    ask: { question: "Which layout, first round?", state: "resolved", reply: { freeText: true }, repliedAt: ago(290), replyText: "B" },
  });
  page.window.renderPage({ requests: data.requests, sections: [...data.sections, old], readOnly: false });
  await tick();
  const block = page.block(7);
  const upFront = () => [...block.querySelectorAll(".request-block-asks [data-section-key]")].map((el) => el.dataset.sectionKey);
  assert.deepEqual(upFront(), ["yn-91/pick"]);
  assert.equal(page.document.querySelectorAll('[id="home-section-p1-yn-91/pick"]').length, 1, "one card by that id");
  assert.deepEqual([...block.querySelectorAll(".request-task-answered")].map(page.text),
    ["Answered: Casual copy? → Yes", "Answered: Which layout, first round? → B"], "the live one first, then History's");
  // The new one answered meanwhile: still the only one up front.
  const answered = data.sections.map((s) => s.key === "yn-91/pick" ? { ...s, version: 3, ask: { ...s.ask, state: "replied", repliedAt: ago(0), replyText: "A" } } : s);
  page.window.renderPage({ requests: data.requests, sections: [...answered, old], readOnly: false });
  await tick();
  assert.deepEqual(upFront(), ["yn-91/pick"]);
  assert.equal(page.document.querySelectorAll('[id="home-section-p1-yn-91/pick"]').length, 1);
  assert.deepEqual(page.errors, []);
});

// PR 1098 R2: the same visit. The user answers the Ask; its Agent resolves it into History and asks again under the
// same key: the new one is up front alone, the earlier one an Answered line again, and so once the new one is answered.
test("an Ask answered in this visit, resolved and asked again under its key, gives way to the new one", async () => {
  const page = mount({ opened: ["r7"] });
  const data = fixtures();
  const render = (sections) => page.window.renderPage({ requests: data.requests, sections, readOnly: false });
  const block = () => page.block(7);
  const answeredLines = () => [...block().querySelectorAll(".request-task-answered")].map(page.text);
  const first = data.sections.find((s) => s.key === "yn-91/pick");
  const rest = data.sections.filter((s) => s.key !== "yn-91/pick");
  await tick();
  // Answered here: held where it was.
  const replied = { ...first, version: 3, ask: { ...first.ask, state: "replied", repliedAt: ago(1), replyText: "A" } };
  render([...rest, replied]);
  await tick();
  assert.equal(block().querySelectorAll(".request-block-asks [data-section-key]").length, 1);
  // Resolved into History, and asked again under its key: another section.
  const resolved = { ...replied, version: 4, history: true, historyReason: "resolved", ask: { ...replied.ask, state: "resolved" } };
  const again = section("yn-91/pick", "ask", "Pick a layout again", 0, {
    owner: { agentId: "x", name: "YN-91 · Design", state: "active" }, card: bind("YN-91"),
    ask: { question: "Which layout, now that A is in?", state: "open", reply: { freeText: true } },
  });
  render([...rest, resolved, again]);
  await tick();
  const cards = () => [...block().querySelectorAll(".request-block-asks [data-section-key]")];
  assert.equal(cards().length, 1, "the new one alone up front");
  assert.match(page.text(cards()[0]), /now that A is in/);
  assert.equal(page.document.querySelectorAll('[id="home-section-p1-yn-91/pick"]').length, 1, "one card by that id");
  assert.ok(answeredLines().includes("Answered: Which layout? → A"), JSON.stringify(answeredLines()));
  // The new one answered too: still the only one up front; the earlier one stays a line.
  render([...rest, resolved, { ...again, version: 2, ask: { ...again.ask, state: "replied", repliedAt: ago(0), replyText: "B" } }]);
  await tick();
  assert.equal(cards().length, 1);
  assert.match(page.text(cards()[0]), /now that A is in/);
  assert.ok(answeredLines().includes("Answered: Which layout? → A"));
  assert.deepEqual(page.errors, []);
});

test("read only: no action, the first look and what was delivered stay", () => {
  const page = mount({ readOnly: true });
  assert.equal(page.document.querySelectorAll(".request-block-action").length, 0);
  assert.equal(page.block(8).querySelectorAll(".request-deliverable").length, 2);
});

// R-27 §3.6: the Project's cards are a group of their own, closed with nothing drawn in it until opened; opened,
// its deck, an Ask answered before this visit among them as its answer card (YN-3), no card up front.
test("the Project's cards: a closed group drawing nothing until opened, then the deck with its answered Asks", async () => {
  const page = mount();
  const data = fixtures();
  const answered = section("window", "ask", "Release window", 50, {
    ask: { question: "Ship on Friday?", state: "replied", reply: { freeText: true }, repliedAt: ago(45), replyText: "Yes" },
  });
  page.window.renderPage({ requests: data.requests, sections: [...data.sections, answered], readOnly: false });
  await tick();
  const group = () => page.document.querySelector("details[data-project-block]");
  assert.equal(group().open, false);
  assert.equal(group().dataset.group, "project");
  assert.equal(page.text(group().querySelector("summary")), "Project cards 2NewNot part of a request", "a card and an answered Ask, one not read");
  assert.ok(group().querySelector("summary .home-chip.is-new"), "New while closed (#1102 R1)");
  assert.equal(group().querySelector(".project-block-cards, [data-section-key]"), null, "nothing drawn while closed");
  assert.equal(page.document.querySelectorAll(".project-ask").length, 0, "an Ask answered before this visit is not up front");
  group().querySelector("summary").click();
  await tick(40);
  assert.equal(group().open, true);
  assert.equal(group().dataset.open, "", "the page knows it is open");
  assert.deepEqual([...group().querySelectorAll(".project-block-cards [data-section-key]")].map((el) => el.dataset.sectionKey), ["window", "development"],
    "the answered Ask first, as before, then the card");
  assert.equal(group().querySelector('[data-section-key="window"]').id, "home-section-p1-window", "a jump to it lands on its card");
  assert.equal(page.document.querySelectorAll('[data-section-key="window"]').length, 1, "drawn once");
  group().querySelector("summary").click();
  await tick(40);
  assert.equal(group().querySelector(".project-block-cards"), null, "closed again, nothing drawn");
  // With nothing of its own but an open Ask, no group: the Ask is up front.
  const ask = section("pick", "ask", "Release window", 6, { ask: { question: "Ship on Friday?", state: "open", reply: { freeText: true } } });
  page.window.renderPage({ requests: data.requests, sections: data.sections.filter((s) => s.key !== "development").concat(ask), readOnly: false });
  await tick();
  assert.equal(group(), null);
  assert.deepEqual([...page.document.querySelectorAll(".project-ask")].map((el) => el.dataset.projectAsk), ["pick"]);
  assert.deepEqual(page.errors, []);
});

// YN-223 (R-29's settled design): an answered Ask in the Project's cards reads the question as the user answered it,
// its note, then the reply as given; a form's answers by field; folded, the question and what was chosen stay. Read
// only, nothing can be sent from it; in Chinese, its own words.
test("the Project's cards: an answered Ask as R-29 settled it, a form's answers, folded and read only, in Chinese", async () => {
  const page = mount({ lang: "zh", readOnly: true, opened: ["project"] });
  const data = fixtures();
  const question = "R-26 的七项建议，这一轮你想推进哪些？每项都可以之后再加。";
  const picks = ["首页历史按需加载（首选）", "精简已释放执行者列表（推荐）", "减少重复刷新，恢复窗口时补齐（推荐）",
    "定位 Agent 活动期间的 Core CPU 开销", "缓存、压缩静态资源", "补运行诊断，区分接口、线程和桌面状态"];
  const answered = section("yn-221/ask", "ask", "R-31 · 这轮做哪些运行改进？", 50, {
    ask: { question, state: "replied", repliedAt: ago(45), replyText: "Answers to “选择开发范围”:\n- 这轮要做哪些？可多选: …",
      reply: { form: { id: "r31", title: "选择开发范围", fields: [{ id: "picks", type: "multi", label: "这轮要做哪些？可多选", options: [] }] } },
      replySnapshot: { format: 1, projectName: "yuzuno-next", sectionKind: "ask", title: "R-31 · 这轮做哪些运行改进？", question, options: [],
        choice: null, text: null, form: { id: "r31", title: "选择开发范围", fields: [{ id: "picks", type: "multi", label: "这轮要做哪些？可多选", answer: picks }] } } },
  });
  page.window.renderPage({ requests: data.requests, sections: [...data.sections, answered], readOnly: true });
  await tick(40);
  const card = page.document.querySelector('[data-section-key="yn-221/ask"]');
  assert.ok(card.classList.contains("is-answer"), "its answer card");
  assert.equal(page.text(card.querySelector(".home-answer-source")), "R-31 · 这轮做哪些运行改进？·当时的问题");
  assert.equal(card.querySelector(".home-kind").textContent.trim(), "等 Dev Lead 跟进");
  assert.equal(card.querySelector(".home-answer-ask").textContent, "R-26 的七项建议，这一轮你想推进哪些？");
  assert.equal(card.querySelector(".home-answer-hint").textContent, "每项都可以之后再加。");
  assert.equal(card.querySelector(".home-answer-label").textContent, "你的回复");
  assert.equal(card.querySelector(".home-reply-form-title").textContent, "“选择开发范围”的回答");
  assert.deepEqual([...card.querySelectorAll("dd li")].map((li) => li.textContent), picks, "each choice of the form, as chosen");
  // Read only: Copy answer and Details, nothing that sends; a form has no options then.
  assert.deepEqual([...card.querySelectorAll(".home-answer-given footer button")].map((b) => b.textContent.trim()), ["复制回答", "详情"]);
  // Folded: the question and the answers stay, the form's title and the actions one unfold away.
  const fold = card.querySelector(".home-answer-byline .home-fold");
  assert.equal(fold.getAttribute("aria-controls"), card.querySelector(".home-answer").id);
  fold.click();
  await tick(40);
  assert.ok(card.classList.contains("is-folded"));
  assert.equal(card.querySelector(".home-answer-ask").textContent, "R-26 的七项建议，这一轮你想推进哪些？", "the question stays");
  assert.deepEqual([...card.querySelectorAll("dd li")].map((li) => li.textContent), picks, "what was chosen stays");
  assert.equal(card.querySelector(".home-reply-form-title"), null);
  assert.equal(card.querySelector(".home-answer-given footer"), null);
  const unfold = card.querySelector(".home-answer-unfold");
  assert.equal(unfold.textContent.trim(), "查看完整回复");
  unfold.click();
  await tick(40);
  assert.ok(!card.classList.contains("is-folded"), "unfolded again");
  assert.ok(card.querySelector(".home-answer-given footer"));
  assert.deepEqual(page.errors, []);
});

/** A lead's status for the banner (R-27); `forYou` items name the Checklist of what the user is asked to do. */
function nowCard({ stale = false, forYou = null, lead = "**core.38 is installed; the new page is on.** The long conversation's view is being fixed." } = {}) {
  const elements = {
    body: { type: "BriefBody", props: { summary: { lead: "lead", size: "wide", ...(forYou ? { forYou: "todo" } : {}) } }, children: ["lead", ...(forYou ? ["todo"] : []), "mine"] },
    lead: { type: "Markdown", props: { text: lead } },
    mine: { type: "Checklist", props: { items: [{ id: "own", text: "The lead's own step", done: false }] } },
  };
  if (forYou) elements.todo = { type: "Checklist", props: { title: "Try the new page", items: forYou } };
  return section("development", "status", "Development state", 15, {
    owner: { agentId: "d", name: "Dev Lead", state: "active" }, status: { asOf: ago(15), validFor: 3600, stale }, body: { root: "body", elements },
  });
}

// R-27 (the user's H4): where the project stands, under its name: the lead's opening as a heading, the rest under it,
// who wrote it and when; "Project cards N" to the group below, where the card itself is; Open status, and a click on
// the banner itself, open the card's page, once.
test("the banner: the conclusion as its heading, who and when, the Project cards below, and the card's page opened once", () => {
  const page = mount();
  page.window.renderNow({ section: nowCard(), more: 3 });
  const now = page.document.querySelector("#now .now-hero");
  assert.equal(now.getAttribute("aria-label"), "Where the project stands");
  assert.equal(page.text(now.querySelector(".now-hero-label")), "Now");
  assert.equal(page.text(now.querySelector(".now-hero-head")), "core.38 is installed; the new page is on.", "the bold opening, plain");
  assert.equal(page.text(now.querySelector(".now-hero-text")), "The long conversation's view is being fixed.");
  assert.deepEqual([...now.querySelectorAll(".now-meta-part")].map(page.text), ["Development state", "Dev Lead", "15 min ago"], "its title, who wrote it, when");
  assert.equal(now.querySelector(".now-hero-aside"), null, "no forYou named: the conclusion alone, never the lead's own list");
  assert.equal(now.id, "", "the card itself is in the group, by its id");
  assert.equal(now.dataset.sectionKey, undefined);
  assert.equal(now.querySelector(".now-card-actions, .home-changed"), null, "its actions and New are the card's, in the group");
  const [more, open] = now.querySelectorAll(".now-actions button");
  assert.equal(page.text(more), "Project cards 3");
  assert.equal(page.text(open), "Open status");
  assert.equal(open.getAttribute("aria-label"), "Open the report “Development state”");
  more.click();
  open.click();
  now.querySelector(".now-hero-head").click();
  assert.deepEqual(page.calls(), [{ more: true }, { open: "development", projectId: "p1", from: "home-report-open" },
    { open: "development", projectId: "p1", from: "now-hero" }], "each once: a button does what it says, the banner opens its page");
  assert.deepEqual(page.errors, []);
});

test("the banner lists what the author names forYou: two open items and how many more, past its validity in the attention colour", () => {
  const page = mount();
  const items = [{ id: "a", text: "Check for updates in 0.5.0", done: false }, { id: "b", text: "Done already", done: true },
    { id: "c", text: "Drag a file into the composer", done: false }, { id: "d", text: "Open a report", done: false }, { id: "e", text: "Reply on a card", done: false }];
  page.window.renderNow({ section: nowCard({ forYou: items }), more: 0 });
  const now = page.document.querySelector("#now .now-hero");
  assert.ok(now.classList.contains("has-side"));
  const aside = now.querySelector(".now-hero-aside");
  assert.equal(aside.getAttribute("aria-label"), "Try the new page");
  assert.equal(page.text(aside.querySelector(".now-todo-head")), "4for you · Try the new page");
  assert.deepEqual([...aside.querySelectorAll(".now-todo-list li")].map(page.text), ["Check for updates in 0.5.0", "Drag a file into the composer"], "the first two open ones");
  assert.equal(aside.querySelector("input, [role=checkbox]"), null, "the banner ticks nothing: the author does");
  const rest = aside.querySelector(".now-todo-more");
  assert.equal(page.text(rest), "2 more · on the status page");
  rest.click();
  assert.deepEqual(page.calls(), [{ open: "development", projectId: "p1", from: "now-todo-more" }]);
  // Two open: no "more"; every item done: the conclusion alone.
  page.window.renderNow({ section: nowCard({ forYou: items.slice(0, 3) }), more: 0 });
  assert.equal(now.querySelector(".now-todo-more"), null);
  page.window.renderNow({ section: nowCard({ forYou: items.map((i) => ({ ...i, done: true })) }), more: 0 });
  assert.equal(now.querySelector(".now-hero-aside"), null);
  // Past its validity: said, the same card, in the attention colour (with other cards; alone, its card's Data as of).
  page.window.renderNow({ section: nowCard({ stale: true }), more: 2 });
  assert.ok(now.classList.contains("is-stale"));
  assert.equal(page.text(now.querySelector(".now-hero-label")), "Past its validity");
  assert.ok([...now.querySelectorAll(".now-meta-part")].map(page.text).includes("Card past its validity"));
  // A lead with no sentence's end is the heading whole; with no lead at all, the card's title is, and the meta does
  // not say it again.
  page.window.renderNow({ section: nowCard({ lead: "Two cards run and one waits" }), more: 0 });
  assert.equal(page.text(now.querySelector(".now-hero-head")), "Two cards run and one waits");
  assert.equal(now.querySelector(".now-hero-text"), null);
  const untitled = nowCard();
  untitled.body.elements.body.props = {};
  untitled.body.elements.body.children = [];
  page.window.renderNow({ section: untitled, more: 0 });
  assert.equal(page.text(now.querySelector(".now-hero-head")), "Development state");
  assert.equal(now.querySelector(".now-meta-title"), null);
  assert.deepEqual(page.errors, []);
});

test("the banner in Chinese", () => {
  const page = mount({ lang: "zh" });
  page.window.renderNow({ section: nowCard({ forYou: [1, 2, 3].map((n) => ({ id: `i${n}`, text: `第 ${n} 项`, done: false })) }), more: 2 });
  const now = page.document.querySelector("#now .now-hero");
  assert.equal(now.getAttribute("aria-label"), "项目近况");
  assert.equal(page.text(now.querySelector(".now-hero-label")), "近况");
  assert.equal(page.text(now.querySelector(".now-todo-head")), "3项待你 · Try the new page");
  assert.equal(page.text(now.querySelector(".now-todo-more")), "另 1 项 · 在状态页");
  assert.deepEqual([...now.querySelectorAll(".now-actions button")].map(page.text), ["项目卡 2", "打开状态"]);
  page.window.renderNow({ section: nowCard({ stale: true }), more: 2 });
  assert.equal(page.text(now.querySelector(".now-hero-label")), "已过有效期");
  // Alone, the banner is the card and says 新 as its card would.
  page.window.renderNow({ section: nowCard({ stale: true }), more: 0 });
  assert.equal(page.text(now.querySelector(".now-hero-label")), "已过有效期新");
});

// The lead's call on YN-218 (seq 12072): with no other card, the banner is the card's one place: its id, a reply's
// note, a status's "Data as of", and the card's own Reply, Seen and More actions; none of them on a read-only Home.
test("alone, the banner is the card's one place: its id, the note, Data as of, Reply, Seen and More; read only, none", async () => {
  const page = mount();
  page.window.renderNow({ section: nowCard({ stale: true }), more: 0, note: "development" });
  const now = page.document.querySelector("#now .now-hero");
  assert.equal(now.id, "home-section-p1-development");
  assert.equal(now.dataset.sectionKey, "development");
  assert.ok(now.classList.contains("is-alone"));
  assert.equal(page.text(now.querySelector(".now-hero-label .home-changed")), "New", "not read yet: New, as its card says");
  assert.equal(page.text(now.querySelector(".home-reply-arrival")), "A reply landed here", "a reply's Open on Home lands here");
  assert.match(page.text(now.querySelector(".now-meta")), /Data as of .*older than its .* validity/, "as its card says it");
  assert.equal(now.querySelector(".now-actions .talk-link"), null, "no Project cards to go to");
  const reply = now.querySelector(".home-reply-open");
  assert.equal(reply.getAttribute("aria-label"), "Reply to “Development state”");
  reply.click();
  await tick();
  assert.ok(now.querySelector(".now-hero-reply .home-card-reply"), "the card's own reply, under the banner");
  now.querySelector(".now-hero-reply .home-card-reply").click();
  now.querySelector(".home-seen").click();
  await tick();
  assert.deepEqual(page.calls(), [{ seen: [{ key: "development", version: 2 }] }], "Seen marks this version; a click in the reply opens nothing");
  assert.ok(now.querySelector(".home-summary-more"), "More actions, as its card has them");
  // Read only: nothing that writes.
  const quiet = mount();
  quiet.window.renderNow({ section: nowCard(), more: 0, readOnly: true });
  const ro = quiet.document.querySelector("#now .now-hero");
  assert.equal(ro.querySelector(".home-reply-open, .home-seen, .home-summary-more"), null);
  assert.ok(ro.querySelector(".home-report-open"), "its page still opens");
  assert.deepEqual([...page.errors, ...quiet.errors], []);
});
