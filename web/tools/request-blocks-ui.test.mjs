import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// YN-212 W3a, YN-237 ②: a request's block, the real components over the blocks request-blocks.ts makes, in English and
// Chinese. Folded, four lines (what goes on now and since when, what needs the user, its newest result, its newest
// follow-up), each one step from the whole of it, and its one action; unfolded, its bar, what goes on now in full, its
// Asks, its result's card and the follow-ups, and under one Details its tasks with their cards, its PRs, what it
// delivered and the user's decisions; or its own conversation. The Project's head (YN-237 ①): the release, the groups'
// counts, what changed per request, the lead's one line and "Other", the Project's cards of no request. Synthetic data
// only; nothing is sent.
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
import {RequestBlockView, ProjectAsks, useAsksUpFront} from ${JSON.stringify(path.join(root, "src/home/RequestBlocks.tsx"))};
import {ProjectHead} from ${JSON.stringify(path.join(root, "src/home/ProjectHead.tsx"))};
import {blockCounts, headChanges, pageBlocks, projectLine} from ${JSON.stringify(path.join(root, "src/home/request-blocks.ts"))};
import {CardAgents} from ${JSON.stringify(path.join(root, "src/home/card-responsible.ts"))};
import {ReportOpen} from ${JSON.stringify(path.join(root, "src/home/report/report-open.ts"))};
const root=createRoot(document.getElementById('root'));
const headRoot=createRoot(document.getElementById('head'));
window.calls=[];
const opener = (projectId, section, from) => window.calls.push({open: section.key, from: from.dataset.step ?? from.className});
function Head({requests, sections, installed = null, readOnly, note, othersOpen = false}) {
  const {blocks, project} = pageBlocks(requests, sections);
  const [open, setOpen] = useState(othersOpen);
  const line = project ? projectLine(project.sections, ['d']) : null;
  const common = {projectId: 'p1', workspaceId: 'ws', agents: window.agents, readOnly: !!readOnly, onSeen: async (marks) => { window.calls.push({seen: marks}); },
    onChanged: () => {}, onReport: (link) => window.calls.push({report: link}), upFront: () => false,
    notice: (s) => (note && s.key === note ? <p className="home-reply-arrival">A reply landed here</p> : undefined)};
  return <ProjectHead line={line} others={[...(project?.sections ?? []).filter((s) => s.key !== line?.key), ...(project?.asks ?? []).filter((a) => a.ask?.state !== 'open')]}
    installed={installed} counts={blockCounts(blocks)} changes={headChanges(blocks)} related={[]} onShowBlock={(n) => window.calls.push({show: n})}
    onGroup={(group) => window.calls.push({group})} othersOpen={open} onOthers={(on) => { window.calls.push({others: on}); setOpen(on); }} common={common}/>;
}
window.renderHead=(props)=>flushSync(()=>headRoot.render(<CardAgents.Provider value={new Map(window.agents.map((a)=>[a.id,a]))}>
  <ReportOpen.Provider value={opener}><Head {...props}/></ReportOpen.Provider></CardAgents.Provider>));
function Page({requests, sections, readOnly}) {
  const {blocks, project} = pageBlocks(requests, sections);
  const [open, setOpen] = useState(new Set(window.opened || []));
  // As ProjectHome keeps them (R-45 §3.4): each block's view, and the jump whose lines stay marked until it folds.
  const [views, setViews] = useState(new Map());
  const [focus, setFocus] = useState(null);
  const toggle = (key) => {
    if (open.has(key)) setFocus((was) => (was?.block === key ? null : was));
    setOpen((was) => { const next = new Set(was); if (!next.delete(key)) next.add(key); return next; });
  };
  const show = (key, to) => { setViews((was) => new Map(was).set(key, to)); setOpen((was) => new Set(was).add(key)); };
  const showThread = (n, at) => { show('r' + n, 'thread'); setFocus({ ...at, block: 'r' + n, seq: (window.jumps = (window.jumps ?? 0) + 1) }); };
  window.jump = (n, at) => flushSync(() => showThread(n, at));
  const upFront = useAsksUpFront([...blocks.flatMap((block) => block.asks), ...(project?.asks ?? [])]);
  const common = {projectId: 'p1', workspaceId: 'ws', agents: window.agents, readOnly: !!readOnly, onSeen: async () => {}, onChanged: () => {},
    onReport: (link) => window.calls.push({report: link}), upFront};
  return <div>{blocks.map((block) => <RequestBlockView key={block.key} block={block} open={open.has(block.key)} onToggle={() => toggle(block.key)}
    view={views.get(block.key)} onView={(to) => show(block.key, to)} focus={focus?.block === block.key ? focus : null}
    onShowThread={showThread} onResendFollowUp={(n, m) => window.calls.push({resend: n, reply: m})}
    onAction={(action, n, key) => window.calls.push({action, n, key: key ?? null})} onShowBlock={(n) => window.calls.push({show: n})}
    onDecide={(key) => { window.calls.push({decide: key}); show(block.key, 'cards'); }} common={common}/>)}
    {project && <div className="needs"><ProjectAsks block={project} common={common}/></div>}</div>;
}
window.renderPage=(props)=>flushSync(()=>root.render(<CardAgents.Provider value={new Map(window.agents.map((a)=>[a.id,a]))}>
  <ReportOpen.Provider value={opener}><Page {...props}/></ReportOpen.Provider></CardAgents.Provider>));`,
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
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="head"></div></body></html>', {
    url: "https://request-blocks.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.Range.prototype.getClientRects ||= () => [];
  window.Range.prototype.getBoundingClientRect ||= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  window.HTMLElement.prototype.scrollTo = function () {};
  window.scrolled = [];
  window.HTMLElement.prototype.scrollIntoView = function (options) { window.scrolled.push([this.dataset.threadItem ?? this.className, options?.block]); };
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

const look = (page, n) => page.block(n).querySelector(".request-look");
const lineOf = (page, n, kind) => page.block(n).querySelector(`.request-look-line[data-look="${kind}"]`);
const lookText = (page, n, kind) => page.text(lineOf(page, n, kind)?.querySelector(".request-look-text"));

// YN-237 ②: folded, each request says in four lines what goes on now and since when, what needs the user, its newest
// result and its newest follow-up, each with one step; nothing else of its tasks is drawn, an Ask not either.
test("each request's first look: what goes on now, what needs you, its result and its follow-up, in English", () => {
  const page = mount();
  const action = (n) => page.block(n).querySelector(".request-block-action");
  // R-7: its status card's first sentence, as of its time, and the open Ask as one line with Decide.
  assert.equal(page.text(lineOf(page, 7, "now").querySelector(".request-look-said")), "Two layouts drawn.");
  assert.match(page.text(lineOf(page, 7, "now").querySelector(".request-look-meta")), /^as of 30 min ago$/);
  assert.equal(page.text(lineOf(page, 7, "now").querySelector(".request-look-label")), "Now");
  assert.equal(lookText(page, 7, "ask"), "Which layout?");
  assert.equal(page.text(lineOf(page, 7, "ask").querySelector(".request-look-label")), "Needs you");
  assert.equal(page.text(lineOf(page, 7, "ask").querySelector('[data-step="decide"]')), "Decide");
  assert.equal(page.block(7).querySelector(".request-block-asks, [data-section-key]"), null, "folded: no card or Ask is drawn");
  assert.equal(lineOf(page, 7, "result"), null, "nothing delivered yet");
  assert.equal(action(7), null);
  assert.equal(page.document.activeElement, page.document.body, "shown, nothing takes the focus");
  // R-8: ended with its deliverables, waiting for the user: Core's fact is its now; the report is its result.
  assert.equal(page.text(lineOf(page, 8, "fact").querySelector(".request-block-fact-line")), "YN-92 is done · delivered 2 items");
  assert.equal(page.text(lineOf(page, 8, "result").querySelector(".request-look-said")), "Export formats compared");
  assert.equal(page.text(lineOf(page, 8, "result").querySelector(".request-look-label")), "Result");
  assert.equal(page.text(lineOf(page, 8, "result").querySelector(".request-look-meta")), "10 min ago", "when it was delivered");
  assert.ok(lineOf(page, 8, "result").querySelector('[data-step="deliverable"]'), "the report Home no longer has opens as its deliverable does");
  assert.equal(action(8).dataset.action, "confirm");
  // R-9: its status is past its validity: said, and dimmed; its follow-up not confirmed delivered.
  const now9 = lineOf(page, 9, "now");
  assert.equal(now9.dataset.dim, "", "dimmed");
  assert.match(page.text(now9.querySelector(".request-look-meta")), /past its validity/);
  assert.equal(page.text(lineOf(page, 9, "follow").querySelector(".request-look-label")), "Follow-up #1");
  assert.equal(page.text(lineOf(page, 9, "follow").querySelector(".request-look-tag")), "Not confirmed delivered");
  assert.equal(page.text(lineOf(page, 9, "follow").querySelector(".request-look-said")), "And JSON too");
  assert.equal(page.text(page.block(9).querySelector(".request-block-follow")), "↩ Follow up");
  assert.equal(action(9), null);
  // R-10 joined R-9's task: its now is that task's.
  assert.equal(page.text(lineOf(page, 10, "now").querySelector(".request-look-said")), "Halfway through the export.");
  const state = (n) => page.text(page.block(n).querySelector(".request-state"));
  assert.deepEqual([7, 8, 9, 11].map(state), ["Your decision", "For you to accept", "Team on it", "Done"]);
  assert.match(page.text(lineOf(page, 11, "fact").querySelector(".request-block-fact-meta")), /^Confirmed by you · /);
  assert.equal(page.block(11).querySelector(".request-block-action"), null, "a confirmed request has nothing to do");
  // R-45 §3.4, YN-237: its progress and results, and its conversation, each its own way in.
  assert.deepEqual([...page.block(7).querySelectorAll(".request-block-foot > .request-block-more")].map((b) => [b.dataset.view, page.text(b)]),
    [["cards", "Progress and results"], ["thread", "Conversation 3"]]);
  assert.deepEqual(page.errors, []);
});

test("the same in Chinese", () => {
  const page = mount({ lang: "zh" });
  assert.deepEqual([...look(page, 7).querySelectorAll(".request-look-label")].map(page.text), ["现在", "需要你"]);
  assert.equal(page.text(lineOf(page, 7, "ask").querySelector('[data-step="decide"]')), "去决定");
  assert.match(page.text(lineOf(page, 7, "now").querySelector(".request-look-meta")), /^截至 30 分钟前$/);
  assert.equal(page.text(page.block(8).querySelector(".request-block-fact-line")), "YN-92 已完成 · 交付 2 项");
  assert.equal(page.text(lineOf(page, 8, "result").querySelector('[data-step="deliverable"]')), "全文");
  assert.equal(page.text(page.block(8).querySelector(".request-block-action")), "确认完成");
  assert.equal(page.text(page.block(9).querySelector(".request-block-follow")), "↩ 追问");
  assert.equal(page.text(page.block(9).querySelector(".request-state")), "团队在办");
  assert.match(page.text(lineOf(page, 9, "now").querySelector(".request-look-meta")), /已过有效期/);
  assert.equal(page.text(lineOf(page, 9, "follow").querySelector(".request-look-label")), "追问 #1");
  assert.deepEqual([...page.block(7).querySelectorAll(".request-block-foot > .request-block-more")].map(page.text), ["进展与结果", "对话 3"]);
  assert.deepEqual(page.errors, []);
});

test("each line's one step: the status's page, Decide, the result's full text; an action says which request it is for", async () => {
  const page = mount();
  lineOf(page, 7, "now").querySelector('[data-step="status"]').click();
  lineOf(page, 8, "result").querySelector('[data-step="deliverable"]').click();
  lineOf(page, 7, "ask").querySelector('[data-step="decide"]').click();
  await tick();
  assert.deepEqual(page.calls(), [
    { open: "yn-91", from: "status" },
    { report: { key: "yn-92", version: 3, sectionId: 999 } },
    { decide: "yn-91/pick" },
  ]);
  assert.equal(lineOf(page, 7, "ask"), null, "unfolded: the lines give way");
  assert.ok(page.block(7).querySelector('.request-block-asks [data-section-key="yn-91/pick"]'), "Decide unfolds it at its Ask");
  page.block(8).querySelector(".request-block-action").click();
  page.block(9).querySelector(".request-block-follow").click();
  assert.deepEqual(page.calls().slice(-2), [{ action: "confirm", n: 8, key: null }, { action: "follow", n: 9, key: null }]);
  assert.equal(page.block(8).querySelector(".request-block-action").getAttribute("aria-label"), "Confirm done: R-8");
  assert.equal(page.block(9).querySelector(".request-block-follow").getAttribute("aria-label"), "Follow up: R-9");
  // A report Home has opens on its page: R-8's, once its report is on the page.
  const { requests, sections } = fixtures();
  const report8 = section("yn-92", "report", "Export formats compared", 10, { id: 999, version: 3, card: bind("YN-92", "done", null),
    body: { root: "body", elements: { body: { type: "BriefBody", props: { summary: { lead: "lead", size: "wide" } }, children: ["lead"] },
      lead: { type: "Markdown", props: { text: "**CSV is enough for now.** JSON can wait." } } } } });
  page.window.renderPage({ requests, sections: [...sections, report8] });
  await tick();
  assert.equal(page.text(lineOf(page, 8, "result").querySelector(".request-look-said")), "CSV is enough for now.", "its conclusion's first sentence");
  lineOf(page, 8, "result").querySelector('[data-step="report"]').click();
  assert.deepEqual(page.calls().at(-1), { open: "yn-92", from: "report" });
  assert.deepEqual(page.errors, []);
});

// R-30: a delivery waiting for the user's confirmation has Follow up beside Confirm done, which goes to the same
// request and confirms nothing; its now line says it waits for the user, and a confirmed one says so.
test("Confirm done has Follow up beside it; waiting for you and confirmed by you are said apart from a task being done", () => {
  const page = mount();
  const actions = (n) => [...page.block(n).querySelectorAll(".request-block-action")];
  assert.deepEqual(actions(8).map((b) => [b.dataset.action, page.text(b), b.getAttribute("aria-label"), b.classList.contains("is-primary")]), [
    ["confirm", "Confirm done", "Confirm done: R-8", true],
    ["follow", "Follow up", "Follow up: R-8", false],
  ]);
  assert.deepEqual(actions(9).map((b) => b.dataset.action), [], "in progress: no action; Follow up is in its foot (R-38 §2.7)");
  actions(8)[1].click();
  assert.deepEqual(page.calls(), [{ action: "follow", n: 8, key: null }], "Follow up confirms nothing");
  assert.match(page.text(page.block(8).querySelector(".request-block-fact-meta")), /^Waiting for you to confirm · /);
  assert.match(page.text(page.block(11).querySelector(".request-block-fact-meta")), /^Confirmed by you · /);
  assert.doesNotMatch(page.text(page.block(9).querySelector(".request-look")), /to confirm|Confirmed by you/);
  const zh = mount({ lang: "zh" });
  assert.deepEqual([...zh.block(8).querySelectorAll(".request-block-action")].map(zh.text), ["确认完成", "继续跟进"]);
  assert.match(zh.text(zh.block(8).querySelector(".request-block-fact-meta")), /^等你确认 · /);
  assert.match(zh.text(zh.block(11).querySelector(".request-block-fact-meta")), /^你已确认 · /);
  assert.deepEqual([...page.errors, ...zh.errors], []);
});

test("unfolded: what goes on now whole, its Asks, then under Details its tasks, joined tasks and the decisions made", async () => {
  const page = mount({ opened: ["r7", "r10", "r9"] });
  const r7 = page.block(7);
  assert.equal(r7.querySelector(".request-look"), null, "unfolded, the lines give way to the whole");
  const opened = r7.querySelector(".request-opened");
  assert.deepEqual([...opened.querySelectorAll(":scope > * [data-section-key], :scope > [data-section-key]")].map((el) => el.dataset.sectionKey),
    ["yn-91", "yn-91/pick"], "its status card, then its open Ask, answerable there");
  assert.equal(r7.querySelectorAll('[data-section-key="yn-91"]').length, 1, "the card once: not again under Details");
  const toggle = r7.querySelector(".request-details-toggle");
  assert.deepEqual([page.text(toggle), toggle.getAttribute("aria-expanded")], ["Details", "false"]);
  const details = r7.querySelector(".request-block-details");
  assert.equal(details.hidden, true, "folded until asked");
  toggle.click();
  await tick();
  assert.equal(details.hidden, false);
  assert.equal(page.text(details.querySelector('.request-task[data-task="YN-91"] .request-task-line .request-task-meta')), "YN-91 · Design · in progress");
  const line = details.querySelector(".request-details-decisions .request-task-answered");
  assert.equal(page.text(line), "Answered: Casual copy? → Yes");
  // YN-223: the line opens, in place, its answer card: the question, the reply; its owner resolved it, so nothing
  // more is sent from it; a reply from before Core kept the question with it, said so.
  assert.equal(line.getAttribute("aria-expanded"), "false");
  assert.equal(r7.querySelector('[data-section-key="yn-91/copy"]'), null, "compact until opened");
  line.click();
  await tick(40);
  const answered = r7.querySelector('[data-section-key="yn-91/copy"]');
  assert.ok(answered.classList.contains("is-answer"), "its answer card");
  assert.equal(answered.querySelector(".home-answer-ask").textContent, "Casual copy?");
  assert.deepEqual([...answered.querySelectorAll(".home-answer-bar button")].map((b) => b.textContent.trim()), ["Hide record"],
    "resolved: nothing more is sent from it");
  // R-45 §3.4: its progress and its conversation are two views; the first first.
  assert.deepEqual([...r7.querySelectorAll('.request-block-tabs [role="tab"]')].map((tab) => [page.text(tab), tab.getAttribute("aria-selected")]),
    [["Progress and results", "true"], ["Conversation 3", "false"]]);
  assert.equal(r7.querySelector(".request-thread"), null);
  // R-10 joined R-9's task: one line under its Details, which shows R-9.
  const joined = page.block(10).querySelector(".request-block-details .request-block-joined");
  assert.match(page.text(joined), /^Joined YN-93 “Halfway through the export” · its card is under R-9/);
  assert.equal(page.block(10).querySelector(".request-task"), null, "the task is under R-9 only");
  joined.querySelector("button").click();
  assert.deepEqual(page.calls().at(-1), { show: 9 });
  assert.equal(page.text(page.block(9).querySelector(".request-task-also")), "Also for R-10");
  // Folding again shows its lines.
  r7.querySelector('.request-block-foot > .request-block-more[data-view="cards"]').click();
  await tick();
  assert.equal(page.block(7).querySelector(".request-block-body"), null);
  assert.ok(page.block(7).querySelector(".request-look"));
  assert.deepEqual(page.errors, []);
});

// R-45 §3.4: unfolded, a request's block shows its progress or its conversation, one view at a time. Its foot opens
// each; the one shown folds it again; its tabs switch between them, by pointer or by the arrow keys. A request with no
// task has its conversation only, with no tabs. The conversation is unfolded in its view, each line named.
test("R-45 two views: its foot opens each, its tabs switch them, the one shown folds it; with no task, its conversation only", async () => {
  const page = mount();
  const b = () => page.block(7);
  const foot = (view) => b().querySelector(`.request-block-foot > .request-block-more[data-view="${view}"]`);
  const tabs = () => [...b().querySelectorAll('.request-block-tabs [role="tab"]')];
  foot("thread").click();
  await tick();
  assert.equal(b().querySelector(".request-block-body").dataset.view, "thread");
  assert.deepEqual([...b().querySelectorAll(".request-thread > li")].map((li) => li.dataset.threadItem), ["mine", "note:1", "line:0"]);
  assert.equal(b().querySelector(".request-thread details, .request-thread summary"), null, "unfolded in its view");
  assert.equal(b().querySelector(".request-opened"), null, "its progress is the other view");
  assert.deepEqual([foot("cards").getAttribute("aria-expanded"), foot("thread").getAttribute("aria-expanded")], ["false", "true"]);
  assert.deepEqual(tabs().map((tab) => [tab.getAttribute("aria-selected"), tab.tabIndex]), [["false", -1], ["true", 0]]);
  const panel = b().querySelector('.request-block-view[role="tabpanel"]');
  assert.equal(panel.getAttribute("aria-labelledby"), tabs()[1].id);
  assert.equal(tabs()[1].getAttribute("aria-controls"), panel.id);
  tabs()[0].click();
  await tick();
  assert.ok(b().querySelector('.request-task[data-task="YN-91"]'), "the progress view, its tasks under Details");
  assert.equal(b().querySelector(".request-thread"), null);
  assert.deepEqual([foot("cards").getAttribute("aria-expanded"), foot("thread").getAttribute("aria-expanded")], ["true", "false"]);
  // The arrow keys move between the tabs, and the focus with them.
  b().querySelector(".request-block-tabs").dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await tick();
  assert.equal(tabs()[1].getAttribute("aria-selected"), "true");
  assert.equal(page.document.activeElement, tabs()[1]);
  assert.ok(b().querySelector(".request-thread"));
  // The one shown, pressed again in the foot, folds it; so does Fold at the end of what it shows.
  foot("thread").click();
  await tick();
  assert.equal(b().querySelector(".request-block-body"), null);
  foot("cards").click();
  await tick();
  assert.equal(page.text(b().querySelector(".request-block-fold")), "Fold");
  b().querySelector(".request-block-fold").click();
  await tick();
  assert.equal(b().querySelector(".request-block-body"), null);
  // No task: only its conversation, in the foot and unfolded, with no tabs.
  const { requests, sections } = fixtures();
  page.window.renderPage({ requests: [...requests, request(12, 10, "waiting", [])], sections });
  await tick();
  const r12 = page.block(12);
  assert.deepEqual([...r12.querySelectorAll(".request-block-foot > .request-block-more")].map((el) => [el.dataset.view, page.text(el)]),
    [["thread", "Conversation 2"]]);
  r12.querySelector('.request-block-more[data-view="thread"]').click();
  await tick();
  assert.equal(page.block(12).querySelector(".request-block-tabs"), null);
  assert.equal(page.block(12).querySelector(".request-block-view").getAttribute("role"), null);
  assert.deepEqual([...page.block(12).querySelectorAll(".request-thread > li")].map((li) => li.dataset.threadItem), ["mine", "note:1"]);
  const zh = mount({ lang: "zh", opened: ["r7"] });
  assert.deepEqual([...zh.block(7).querySelectorAll('.request-block-tabs [role="tab"]')].map(zh.text), ["进展与结果", "对话 3"]);
  assert.equal(zh.block(7).querySelector(".request-block-tabs").getAttribute("aria-label"), "「Request 7」显示的内容");
  assert.equal(zh.text(zh.block(7).querySelector(".request-block-fold")), "收起");
  assert.equal(zh.text(zh.block(7).querySelector(".request-details-toggle")), "详情");
  assert.deepEqual([...page.errors, ...zh.errors], []);
});

// R-45 §3.4: a jump into a request's conversation opens its block there and lands on the follow-up, in the middle of
// the scroller with the focus; that line and the lines named with it are marked, and stay so across the views until
// the block folds. A follow-up the conversation does not have lands on the conversation itself.
test("R-45 a jump lands on its follow-up in the conversation, with the focus; it and the lines named with it stay marked", async () => {
  const page = mount();
  const b = () => page.block(9);
  const marked = () => [...b().querySelectorAll(".request-thread > li[data-focus]")].map((li) => li.dataset.threadItem);
  page.window.jump(9, { reply: 1, with: ["note:1"] });
  await tick();
  assert.equal(b().querySelector(".request-block-body").dataset.view, "thread");
  const reply = b().querySelector('.request-thread > li[data-reply="1"]');
  assert.equal(page.document.activeElement, reply, "the focus on the follow-up");
  assert.deepEqual(marked(), ["note:1", "reply:1"]);
  assert.deepEqual(page.window.scrolled, [["reply:1", "center"]], "in the middle of the scroller");
  // Its progress and back: the marks stay, and it does not land again.
  b().querySelector('.request-block-tabs [data-view="cards"]').click();
  await tick();
  b().querySelector('.request-block-tabs [data-view="thread"]').click();
  await tick();
  assert.deepEqual(marked(), ["note:1", "reply:1"]);
  assert.equal(page.window.scrolled.length, 1);
  // Folded, the marks go; the next jump marks again.
  b().querySelector('.request-block-foot > .request-block-more[data-view="thread"]').click();
  await tick();
  b().querySelector('.request-block-foot > .request-block-more[data-view="thread"]').click();
  await tick();
  assert.deepEqual(marked(), []);
  page.window.jump(9, { reply: 5 });
  await tick();
  assert.equal(page.document.activeElement, b().querySelector(".request-thread"), "no such follow-up: the conversation itself");
  assert.deepEqual(marked(), []);
  assert.deepEqual(page.errors, []);
});

// PR 1089 R1 (P3): a task's other statuses and reports, from before one task had one card, fold under its card.
test("a task's earlier cards fold under it in Details; what goes on now is its newest live status", async () => {
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
  assert.equal(page.block(7).querySelector('.request-opened [data-section-key]').dataset.sectionKey, "yn-91", "the newest is what goes on now");
  assert.equal(page.text(lineOf(page, 12, "now").querySelector(".request-look-said")), "Nine's card.");
  assert.deepEqual(page.errors, []);
});

// YN-212 W4: who wrote the version shown (Core's author, C1; else its owner), a card older than the user's reply on
// its task, and the card's earlier versions (C2), each opening the report page at that version by its identity.
test("what goes on now says who wrote it and that it was written before your reply, and opens its earlier versions", async () => {
  const page = mount({ opened: ["r7", "r9"] });
  const { requests, sections } = fixtures();
  const card7 = sections.find((s) => s.key === "yn-91");
  card7.updatedAt = ago(70);
  card7.revisions = [{ version: 1, author: { agentId: "x", name: "YN-91 · Design" }, at: ago(90) }];
  page.window.renderPage({ requests, sections });
  await tick();
  const now = page.block(7).querySelector('.request-opened .request-task-card[data-task="YN-91"]');
  assert.equal(page.text(now.querySelector(".request-task-before")), "Written before your reply", "the reply at 55 min, the card at 70");
  assert.equal(page.text(now.querySelector('[data-section-key="yn-91"] .home-card-author')), "Written by Dev Lead", "no author from Core: its owner");
  assert.equal(page.text(page.block(9).querySelector(".home-card-author")), "Written by YN-93 · Export", "Core's author");
  const versions = now.querySelector(".request-task-versions");
  assert.equal(versions.open, false, "folded");
  assert.equal(page.text(versions.querySelector("summary")), "Earlier version 1");
  versions.querySelector("button").click();
  assert.deepEqual(page.calls().at(-1), { report: { key: "yn-91", version: 1, sectionId: card7.id } });
  assert.equal(page.block(9).querySelector(".request-task-versions, .request-task-before"), null);
  assert.deepEqual(page.errors, []);
});

// W5, YN-237 ②: every open Ask is in its block once, unfolded; folded, the block says it in one line with Decide. A
// task two requests share shows its Ask under the first; the other says where, and its Decide goes there. Answered in
// this visit, an Ask stays where it was; the Project's own Asks stand in Needs you.
test("every open Ask is in its unfolded block once: two of one task, one of a shared task, one answered now, the Project's", async () => {
  const page = mount({ opened: ["r7", "r9", "r10"] });
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
  assert.match(page.text(page.block(10).querySelector(".request-opened .request-block-joined")), /^Waiting for you under R-9: JSON too\?/);
  // Folded, R-10 says it in one line, under R-9, and its Decide goes there.
  page.block(10).querySelector('.request-block-foot > .request-block-more[data-view="cards"]').click();
  await tick();
  assert.equal(lookText(page, 10, "ask"), "JSON too?under R-9");
  lineOf(page, 10, "ask").querySelector('[data-step="decide"]').click();
  assert.deepEqual(page.calls().at(-1), { action: "answer", n: 9, key: "yn-93/scope" }, "its Decide goes to the Ask under R-9");
  // The Project's own Ask stands on its own (in Needs you on the page, R-27 §3.5), saying whose it is.
  const own = [...page.document.querySelectorAll(".project-ask")];
  assert.deepEqual(own.map((el) => el.dataset.projectAsk), ["pick"]);
  assert.equal(page.text(own[0].querySelector(".home-from")), "Project · From Dev Lead");
  assert.equal(page.document.querySelectorAll('[data-section-key="yn-91/pick"], [data-section-key="yn-93/scope"], [data-section-key="pick"]').length, 3);
  // Core's next read: R-7's first Ask answered. It stays where it was for the visit, its answer in its place.
  const replied = data.sections.map((s) => s.key === "yn-91/pick"
    ? { ...s, version: 3, ask: { ...s.ask, state: "replied", repliedAt: ago(0), replyText: "A" } }
    : s);
  render([...replied, font, shared, mine]);
  await tick();
  assert.deepEqual(keys(page.block(7)), ["yn-91/pick", "yn-91/font"], "nothing moved");
  assert.equal(page.block(7).querySelectorAll('[data-section-key="yn-91/pick"]').length, 1, "not drawn again");
  assert.deepEqual([...page.block(7).querySelectorAll(".request-task-answered")].map(page.text), ["Answered: Casual copy? → Yes"],
    "the Ask answered now is not a line under Details as well");
  assert.deepEqual(page.errors, []);
});

// PR 1098 R1: an Ask kept in History under a key a new open Ask uses again is another section (another identity):
// only the new one is shown as an Ask, held there once answered; the old one stays an Answered line, never a second card.
test("an older Ask in History under the same key stays an Answered line beside the new one", async () => {
  const page = mount({ opened: ["r7"] });
  const data = fixtures();
  const old = section("yn-91/pick", "ask", "Pick a layout", 300, {
    history: true, historyReason: "resolved", card: bind("YN-91"),
    ask: { question: "Which layout, first round?", state: "resolved", reply: { freeText: true }, repliedAt: ago(290), replyText: "B" },
  });
  page.window.renderPage({ requests: data.requests, sections: [...data.sections, old], readOnly: false });
  await tick();
  const block = page.block(7);
  const asks = () => [...block.querySelectorAll(".request-block-asks [data-section-key]")].map((el) => el.dataset.sectionKey);
  assert.deepEqual(asks(), ["yn-91/pick"]);
  assert.equal(page.document.querySelectorAll('[id="home-section-p1-yn-91/pick"]').length, 1, "one card by that id");
  assert.deepEqual([...block.querySelectorAll(".request-task-answered")].map(page.text),
    ["Answered: Casual copy? → Yes", "Answered: Which layout, first round? → B"], "the live one first, then History's");
  const answered = data.sections.map((s) => s.key === "yn-91/pick" ? { ...s, version: 3, ask: { ...s.ask, state: "replied", repliedAt: ago(0), replyText: "A" } } : s);
  page.window.renderPage({ requests: data.requests, sections: [...answered, old], readOnly: false });
  await tick();
  assert.deepEqual(asks(), ["yn-91/pick"]);
  assert.equal(page.document.querySelectorAll('[id="home-section-p1-yn-91/pick"]').length, 1);
  assert.deepEqual(page.errors, []);
});

// PR 1098 R2: the same visit. The user answers the Ask; its Agent resolves it into History and asks again under the
// same key: the new one is shown alone, the earlier one an Answered line again, and so once the new one is answered.
test("an Ask answered in this visit, resolved and asked again under its key, gives way to the new one", async () => {
  const page = mount({ opened: ["r7"] });
  const data = fixtures();
  const render = (sections) => page.window.renderPage({ requests: data.requests, sections, readOnly: false });
  const block = () => page.block(7);
  const answeredLines = () => [...block().querySelectorAll(".request-task-answered")].map(page.text);
  const first = data.sections.find((s) => s.key === "yn-91/pick");
  const rest = data.sections.filter((s) => s.key !== "yn-91/pick");
  await tick();
  const replied = { ...first, version: 3, ask: { ...first.ask, state: "replied", repliedAt: ago(1), replyText: "A" } };
  render([...rest, replied]);
  await tick();
  assert.equal(block().querySelectorAll(".request-block-asks [data-section-key]").length, 1);
  const resolved = { ...replied, version: 4, history: true, historyReason: "resolved", ask: { ...replied.ask, state: "resolved" } };
  const again = section("yn-91/pick", "ask", "Pick a layout again", 0, {
    owner: { agentId: "x", name: "YN-91 · Design", state: "active" }, card: bind("YN-91"),
    ask: { question: "Which layout, now that A is in?", state: "open", reply: { freeText: true } },
  });
  render([...rest, resolved, again]);
  await tick();
  const cards = () => [...block().querySelectorAll(".request-block-asks [data-section-key]")];
  assert.equal(cards().length, 1, "the new one alone");
  assert.match(page.text(cards()[0]), /now that A is in/);
  assert.equal(page.document.querySelectorAll('[id="home-section-p1-yn-91/pick"]').length, 1, "one card by that id");
  assert.ok(answeredLines().includes("Answered: Which layout? → A"), JSON.stringify(answeredLines()));
  render([...rest, resolved, { ...again, version: 2, ask: { ...again.ask, state: "replied", repliedAt: ago(0), replyText: "B" } }]);
  await tick();
  assert.equal(cards().length, 1);
  assert.match(page.text(cards()[0]), /now that A is in/);
  assert.ok(answeredLines().includes("Answered: Which layout? → A"));
  assert.deepEqual(page.errors, []);
});

test("read only: no action; the lines and, unfolded, what was delivered stay", async () => {
  const page = mount({ readOnly: true, opened: ["r8"] });
  assert.equal(page.document.querySelectorAll(".request-block-action, .request-block-follow").length, 0);
  assert.equal(page.block(8).querySelectorAll(".request-block-details .request-deliverable").length, 2);
  assert.equal(page.block(9).querySelector(".request-look-line[data-look='follow'] button.talk-link"), null, "no Send again");
});

// YN-237 ①: the Project's head: the release and what waits for the next one, the groups' counts, what changed in each
// request since the user last read it, the lead's one line across requests, and "Other", one row until opened.
test("the head: the release, the counts, what changed per request, the lead's line, and Other closed until opened", async () => {
  const page = mount();
  const { requests, sections } = fixtures();
  const notes = section("notes", "report", "Maintenance notes", 50);
  const window = section("window", "ask", "Release window", 50, {
    ask: { question: "Ship on Friday?", state: "replied", reply: { freeText: true }, repliedAt: ago(45), replyText: "Yes" },
  });
  page.window.renderHead({ requests, sections: [...sections, notes, window],
    installed: { release: { releaseId: "core-20261126-abcdef0", version: "core.40", gitSha: "a".repeat(40) }, mergedAfter: 1 } });
  const head = page.document.querySelector("#head .project-head");
  assert.equal(head.getAttribute("aria-label"), "Across requests");
  assert.equal(page.text(head.querySelector(".project-head-release")), "Running core.40");
  assert.equal(page.text(head.querySelector(".project-head-pending")), "1 merged PR waits for the next release");
  assert.deepEqual([...head.querySelectorAll(".project-head-counts button")].map((b) => [b.dataset.group, page.text(b)]),
    [["needs", "2 for you to decide"], ["doing", "2 in progress"], ["done", "Done"]]);
  head.querySelector('.project-head-counts [data-group="done"]').click();
  assert.deepEqual(page.calls().at(-1), { group: "done" });
  // What changed since the user last read: each request once, by what it says first; done ones left out.
  assert.deepEqual([...head.querySelectorAll(".project-head-change")].map((b) => [b.dataset.change, page.text(b)]), [
    ["ask", "R-7Waiting for you: Which layout?"], ["now", "R-10Halfway through the export."], ["now", "R-9Halfway through the export."]]);
  head.querySelector(".project-head-change").click();
  assert.deepEqual(page.calls().at(-1), { show: 7 });
  // The lead's one line: its card's first sentence, as of when, its page one step away; its id there, for a jump.
  const lead = head.querySelector(".project-head-lead");
  assert.equal(lead.id, "home-section-p1-development");
  assert.equal(page.text(lead.querySelector(".project-head-who")), "Dev Lead");
  assert.equal(page.text(lead.querySelector(".project-head-said")), "Development state.");
  assert.match(page.text(lead.querySelector(".project-head-meta")), /^Data as of /, "as its card says it");
  lead.querySelector('[data-step="lead"]').click();
  assert.deepEqual(page.calls().at(-1), { open: "development", from: "lead" });
  // Other: one row, its cards and answered Asks counted, nothing drawn until opened; opened, its deck.
  const other = head.querySelector("details.project-head-others");
  assert.equal(other.open, false);
  assert.equal(page.text(other.querySelector("summary")), "Other 2NewCards of no request");
  assert.equal(other.querySelector("[data-section-key]"), null, "nothing drawn while folded");
  other.open = true;
  other.dispatchEvent(new page.window.Event("toggle"));
  await tick(40);
  assert.deepEqual(page.calls().at(-1), { others: true });
  assert.deepEqual([...other.querySelectorAll(".project-block-cards [data-section-key]")].map((el) => el.dataset.sectionKey), ["notes", "window"],
    "its card whole, and its answered Ask as its answer card");
  assert.equal(other.querySelector('[data-section-key="notes"]').id, "home-section-p1-notes", "a jump to it lands on its card");
  assert.equal(page.document.querySelectorAll('#head [id="home-section-p1-development"]').length, 1, "the lead's card once: its line");
  assert.equal(page.document.querySelectorAll('#head [data-section-key="development"]').length, 0, "never also a card under Other");
  // No change and no lead's card: the first line alone.
  page.window.renderHead({ requests: [], sections: [] });
  assert.deepEqual([...page.document.querySelectorAll("#head .project-head > *")].map((el) => el.className), ["project-head-facts"]);
  const zh = mount({ lang: "zh" });
  zh.window.renderHead({ requests, sections, installed: { release: { releaseId: "r", version: "core.40", gitSha: "a".repeat(40) }, mergedAfter: 2 } });
  const zhHead = zh.document.querySelector("#head .project-head");
  assert.equal(zh.text(zhHead.querySelector(".project-head-facts")), "运行 core.402 个已合入 PR 等下一版2 等你决定2 进行中已完成");
  assert.match(zh.text(zhHead.querySelector(".project-head-change")), /^R-7等你决定：Which layout\?$/);
  assert.match(zh.text(zhHead.querySelector(".project-head-meta")), /^数据截至 /);
  assert.deepEqual([...page.errors, ...zh.errors], []);
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

test("the lead's line lists what its author names forYou, says when it is past its validity, and takes a reply's note", () => {
  const page = mount();
  const items = [{ id: "a", text: "Check for updates in 0.5.0", done: false }, { id: "b", text: "Done already", done: true },
    { id: "c", text: "Drag a file into the composer", done: false }, { id: "d", text: "Open a report", done: false }];
  page.window.renderHead({ requests: [], sections: [nowCard({ forYou: items })] });
  const lead = () => page.document.querySelector("#head .project-head-lead");
  assert.equal(page.text(lead().querySelector(".project-head-said")), "core.38 is installed; the new page is on.", "its bold opening, plain");
  assert.equal(page.text(lead().querySelector(".project-head-todo")), "33 for you · Try the new pageCheck for updates in 0.5.0Drag a file into the composer",
    "how many, then the first two open ones");
  page.window.renderHead({ requests: [], sections: [nowCard({ stale: true })], note: "development" });
  assert.ok(lead().classList.contains("is-stale"));
  assert.ok(lead().querySelector(".project-head-meta .home-stale"), "past its validity, as its card says it");
  assert.equal(page.text(lead().querySelector(".home-reply-arrival")), "A reply landed here", "a reply's Open on Home lands on its line");
  assert.deepEqual(page.errors, []);
});

// YN-230 (R-41's design): an answered Ask under Other reads the question as the user answered it, then one line of what
// they chose; its record, one toggle away, has the form's answers by field. Read only, nothing can be sent from it.
test("an answered Ask under Other, as R-41 settled it: a form's answers on one line and in its record, read only, in Chinese", async () => {
  const page = mount({ lang: "zh" });
  const question = "R-26 的七项建议，这一轮你想推进哪些？每项都可以之后再加。";
  const picks = ["首页历史按需加载（首选）", "精简已释放执行者列表（推荐）", "减少重复刷新，恢复窗口时补齐（推荐）"];
  const answered = section("yn-221/ask", "ask", "R-31 · 这轮做哪些运行改进？", 50, {
    ask: { question, state: "replied", repliedAt: ago(45), replyText: "Answers to “选择开发范围”:\n- 这轮要做哪些？可多选: …",
      reply: { form: { id: "r31", title: "选择开发范围", fields: [{ id: "picks", type: "multi", label: "这轮要做哪些？可多选", options: [] }] } },
      replySnapshot: { format: 1, projectName: "yuzuno-next", sectionKind: "ask", title: "R-31 · 这轮做哪些运行改进？", question, options: [],
        choice: null, text: null, form: { id: "r31", title: "选择开发范围", fields: [{ id: "picks", type: "multi", label: "这轮要做哪些？可多选", answer: picks }] } } },
  });
  page.window.renderHead({ requests: [], sections: [answered], readOnly: true, othersOpen: true });
  await tick(40);
  const card = page.document.querySelector('#head [data-section-key="yn-221/ask"]');
  assert.ok(card.classList.contains("is-answer"), "its answer card");
  assert.equal(card.querySelector(".home-answer-ask").textContent, "R-26 的七项建议，这一轮你想推进哪些？");
  assert.equal(card.querySelector(".home-answer-picks").textContent, picks.join("、"));
  assert.deepEqual([...card.querySelectorAll(".home-answer-bar button")].map((b) => b.textContent.trim()), ["查看回答记录"]);
  card.querySelector(".home-answer-toggle").click();
  await tick(40);
  const record = card.querySelector(".home-answer-record");
  assert.deepEqual([...record.querySelectorAll(".home-answer-fields > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]),
    [["这轮要做哪些？可多选", picks.join("、")]], "each field and its answer");
  assert.deepEqual(page.errors, []);
});

// YN-221 S2: an ended task's card kept in Home's history index (S1) has no body until it is read; where a request's
// block shows it (its result, a task's card under Details), it says it is reading, and those drawn together are read
// in one request.
test("ended tasks' cards in Home's history index are read whole where they show, together in one request", async () => {
  const page = mount({ opened: ["r12"] });
  const reads = [];
  page.window.fetch = async (url) => {
    reads.push(String(url));
    return { ok: true, status: 200, json: async () => ({ entries: [], missing: [] }), text: async () => "{}" };
  };
  const data = fixtures();
  const index = (s) => {
    const { body: _b, attachments: _a, refs: _r, ...rest } = s;
    return { ...rest, bodyOmitted: true, attachmentCount: 0 };
  };
  const shipped = index(section("yn-94", "report", "Export shipped", 50, { history: true, historyReason: "archived", card: bind("YN-94", "done", null) }));
  const finished = index(section("yn-95", "status", "Import finished", 60, { history: true, historyReason: "archived", card: bind("YN-95", "done", null) }));
  const ended = request(12, 70, "ended", [{ ...routed(shipped, "YN-94", "done", null), live: false }, { ...routed(finished, "YN-95", "done", null), live: false }]);
  page.window.renderPage({ requests: [...data.requests, ended], sections: [...data.sections, shipped, finished], readOnly: false });
  await tick(60);
  const states = [...page.block(12).querySelectorAll("[data-history-body]")];
  assert.deepEqual(states.map((el) => el.querySelector("strong")?.textContent), ["Export shipped", "Import finished"], "its result, then the other task's card");
  assert.deepEqual(reads, [`/api/projects/p1/brief/history?entries=${shipped.id}:2,${finished.id}:2`], "one read for both");
  await tick(60);
  assert.equal(page.block(12).querySelectorAll('[data-history-body="missing"]').length, 2, "Core no longer keeps them: said so");
  assert.deepEqual(page.errors, []);
});

// YN-223 with YN-221 S2: an Ask answered before this visit and resolved since, kept in Home's history index, is one
// compact line under Details; opened, its card is read whole first, saying so under its title, then drawn.
test("an answered Ask in Home's history index opens from its line to its card read whole, reading meanwhile", async () => {
  const page = mount({ opened: ["r7"] });
  const reads = [];
  page.window.fetch = async (url) => {
    reads.push(String(url));
    return { ok: true, status: 200, json: async () => ({ entries: [], missing: [] }), text: async () => "{}" };
  };
  const data = fixtures();
  const kept = section("yn-91/tone", "ask", "Which tone?", 90, {
    history: true, historyReason: "resolved", card: bind("YN-91"),
    ask: { question: "Formal or casual tone?", state: "resolved", repliedAt: ago(85), replyText: "Casual",
      reply: { options: [{ id: "f", label: "Formal" }, { id: "c", label: "Casual" }] } },
  });
  const { body: _b, attachments: _a, refs: _r, ...rest } = kept;
  const indexed = { ...rest, bodyOmitted: true, attachmentCount: 0 };
  page.window.renderPage({ requests: data.requests, sections: [...data.sections, indexed], readOnly: false });
  await tick(60);
  const line = page.block(7).querySelector('[data-answered="yn-91/tone"] .request-task-answered');
  assert.equal(page.text(line), "Answered: Formal or casual tone? → Casual", "the index row's question and reply, in one line");
  assert.deepEqual(reads, [], "nothing read while it is a line");
  line.click();
  await tick(60);
  const reading = page.block(7).querySelector('[data-answered="yn-91/tone"] [data-history-body]');
  assert.ok(reading, "opened: its card is read whole first");
  assert.deepEqual(reads, [`/api/projects/p1/brief/history?entries=${kept.id}:2`]);
  assert.deepEqual(page.errors, []);
});

// R-38 §2.2, §3, unfolded (YN-237 ②): R-38 itself, its design delivered, the same task implementing; each outcome a
// segment, a button that says it under the bar; its PRs under Details. Its PR 1121 merged: S1 is merged whatever its
// author marked; 1122 open: S2 in progress.
test("R-38 unfolded: its bar by outcome, the outcome a segment opens, one next step; its PRs under Details", async () => {
  const page = mount({ opened: ["r38"] });
  const plan = (steps) => ({ root: "body", elements: {
    body: { type: "BriefBody", props: { summary: { lead: "lead", progress: "plan", size: "wide" } }, children: ["lead", "plan"] },
    lead: { type: "Markdown", props: { text: "Implementing." } }, plan: { type: "Plan", props: { steps } } } });
  const card = section("yn-227", "status", "R-38 in progress", 4, { status: { asOf: ago(4), validFor: 3600, stale: false }, card: bind("YN-227"),
    author: { agentId: "x", name: "YN-91 · Design" }, body: plan([
      { id: "s1", text: "Contract — summary.progress", state: "done", prs: [1121] },
      { id: "s2", text: "Core — progress and installs", state: "doing", prs: [1122] },
      { id: "s3", text: "View", state: "todo" }]) });
  const pull = (number, state, installed) => ({ number, title: `PR ${number}`, url: `https://example.test/pull/${number}`, repository: "o/r", state,
    mergedAt: state === "merged" ? ago(30) : null, installed });
  const routedCard = { ...routed(card, "YN-227"), prs: { items: [pull(1121, "merged", false), pull(1122, "open", null)] } };
  page.window.renderPage({ requests: [request(38, 300, "doing", [routedCard])], sections: [card] });
  await tick();
  const b = page.block(38);
  assert.equal(page.text(b.querySelector(".request-state")), "Team on it", "a design delivered is no request done");
  assert.equal(page.text(b.querySelector(".request-bar-label")), "Done 1/3 · 1 merged · install not verified");
  const segs = [...b.querySelectorAll(".request-bar-seg")];
  assert.deepEqual(segs.map((s) => [s.dataset.state, s.getAttribute("aria-label")]), [
    ["merged", "Contract: merged · install not verified"], ["doing", "Core: in progress"], ["todo", "View: not started"]]);
  segs[0].click();
  await tick();
  assert.equal(page.text(b.querySelector(".request-bar-detail")), "Contract — merged · install not verified: summary.progress; #1121 merged · install not verified");
  assert.equal(page.text(b.querySelector(".request-next")), "NextYN-91 · Design: Core");
  assert.deepEqual([...b.querySelectorAll(".request-block-details .request-evidence section")].map((s) => [s.dataset.evidence, page.text(s.querySelector("h4"))]),
    [["pending", "Merged · install not verified 1"], ["open", "Not merged yet 1"]]);
  assert.deepEqual(page.errors, []);
});

// YN-237 ③: a request no Plan names the outcomes of: Core draws its bar from its tasks and PRs, one segment each.
test("with no Plan, Core's bar from its tasks and PRs, unfolded; with one PR and one task, no bar", async () => {
  const page = mount({ opened: ["r60"] });
  const one = section("yn-61", "status", "Two PRs going", 4, { status: { asOf: ago(4), validFor: 3600, stale: false }, card: bind("YN-61") });
  const pull = (number, state, installed) => ({ number, title: `Slice ${number}`, url: `https://example.test/pull/${number}`, repository: "o/r", state,
    mergedAt: state === "merged" ? ago(30) : null, installed });
  const cards = [{ ...routed(one, "YN-61"), prs: { items: [pull(1301, "merged", true), pull(1302, "open", null)] } }];
  page.window.renderPage({ requests: [request(60, 300, "doing", cards)], sections: [one] });
  await tick();
  const b = page.block(60);
  assert.ok(b.querySelector('.request-block-now[data-track]'), "Core's bar");
  assert.deepEqual([...b.querySelectorAll(".request-bar-seg")].map((s) => [s.dataset.state, s.getAttribute("aria-label")]),
    [["available", "#1301 Slice 1301: usable"], ["doing", "#1302 Slice 1302: in progress"]]);
  page.window.renderPage({ requests: [request(60, 300, "doing", [{ ...cards[0], prs: { items: [pull(1301, "merged", true)] } }])], sections: [one] });
  await tick();
  assert.equal(page.block(60).querySelector(".request-bar-seg"), null);
  assert.deepEqual(page.errors, []);
});

test("R-43 with no word of its task yet, the front desk's newest reply is its now line, in both languages", async () => {
  const said = "I'll write the rule into what Agents see when they submit a Job, and check whether main allows a fast-forward.";
  const leadHere = { agentId: "d", name: "Dev Lead", kind: "lead", state: "active" };
  const r42 = request(42, 4, "doing", [routed(null, "YN-230", "doing", leadHere)], { notes: [{ note: said, by: desk, at: ago(3) }] });
  for (const lang of ["en", "zh"]) {
    const page = mount({ lang });
    page.window.renderPage({ requests: [r42], sections: [] });
    const reply = page.block(42).querySelector('.request-look .request-reply');
    assert.ok(reply, "in the first look");
    assert.equal(page.text(reply.querySelector(".request-reply-text")), said);
    assert.match(page.text(reply.querySelector(".request-block-fact-meta")), lang === "en" ? /^The project · / : /^项目 · /);
    assert.equal(reply.querySelector("time").getAttribute("datetime"), r42.notes[0].at);
    assert.deepEqual(page.errors, []);
  }
});

test("R-38 §2.2 unfolded, Details list the hand-offs its lead planned after the outcomes, in order, as words", async () => {
  for (const [lang, title] of [["en", "Planned hand-offs after this"], ["zh", "之后的接力（计划）"]]) {
    const page = mount({ lang, opened: ["r31"] });
    const card = section("yn-221", "status", "R-31 runtime", 4, { status: { asOf: ago(4), validFor: 3600, stale: false }, card: bind("YN-221"),
      body: { root: "body", elements: {
        body: { type: "BriefBody", props: { summary: { lead: "lead", progress: "plan", relay: "next", size: "wide" } }, children: ["lead", "plan", "next"] },
        lead: { type: "Markdown", props: { text: "Five of six usable." } },
        plan: { type: "Plan", props: { steps: [{ id: "a", text: "Caching", state: "done" }, { id: "b", text: "Locate Core CPU", state: "blocked" }] } },
        next: { type: "Plan", props: { steps: [{ id: "r", text: "Release", state: "doing" }, { id: "i", text: "You install", state: "todo" },
          { id: "c", text: "YN-221 re-measures", state: "todo" }] } } } } });
    page.window.renderPage({ requests: [request(31, 300, "doing", [routed(card, "YN-221")])], sections: [card] });
    await tick();
    const relay = page.block(31).querySelector(".request-block-details [data-relay]");
    assert.ok(relay, lang);
    assert.equal(page.text(relay.querySelector("h4")), title);
    assert.deepEqual([...relay.querySelectorAll("li")].map((li) => [page.text(li), li.dataset.state]),
      [["Release", "doing"], ["You install", "todo"], ["YN-221 re-measures", "todo"]]);
    assert.equal(page.block(31).dataset.group, "doing", "a planned step of the user's is no to-do");
    assert.deepEqual(page.errors, []);
  }
});

// R-45 §3.2–3.4: R-44 as it was, delivered and followed up twice (synthetic data in its shape), in three states: the
// newest follow-up waiting for a reply, answered by a note that names it, and an unmarked note said after both.
function r44(kind) {
  id = 400;
  const exec = { agentId: "x", name: "YN-91 · Design" };
  const lead = { agentId: "d", name: "Dev Lead" };
  const card = section("yn-91", "report", "R-44 · the sidebar's rule", 13, { card: bind("YN-91", "done", null) });
  const reply = (n, minutes, text, to) => ({ n, text, textBlocks: null, images: [], files: [], at: ago(minutes), messageId: `f${n}`,
    deliveredTo: [{ ...to, delivery: "accepted" }] });
  const notes = [{ note: "I'll reproduce it first.", by: desk, at: ago(19) },
    ...(kind === "answered" ? [{ note: "Yes: until you look at the turn, the row says Between turns.", by: desk, at: ago(11), replyTo: [2] }] : []),
    ...(kind === "later" ? [{ note: "Ask on here any time; I missed coming back.", by: desk, at: ago(3) }] : [])];
  return {
    requests: [request(44, 20, "ended", [{ ...routed(card, "YN-91", "done", null, [{ kind: "report", title: "R-44", note: null, key: "yn-91", version: 3,
      sectionId: card.id, state: "live", currentVersion: 3 }], 13), task: { id: "YN-91", status: "done", archived: false, progress: "Read-only check done." } }], {
      replies: [reply(1, 13, "What is the unread rule?", exec), reply(2, 12, "Will this request not answer me?", lead)], notes,
      lines: [{ kind: "done", task: "YN-91", status: "done", at: ago(12.5), cardSectionId: card.id, title: "R-44" }],
    })],
    sections: [card],
  };
}

test("R-45 the first look says the newest follow-up and what came of it; a reply is not the delivery; waiting is not the user's to accept", async () => {
  for (const lang of ["en", "zh"]) {
    const page = mount({ lang });
    const t = (en, zh) => (lang === "en" ? en : zh);
    page.window.renderPage(r44("waiting"));
    await tick();
    const b = page.block(44);
    const follow = lineOf(page, 44, "follow");
    assert.equal(page.text(follow.querySelector(".request-look-label")), t("Follow-up #2", "追问 #2"));
    assert.equal(page.text(follow.querySelector(".request-look-said")), "Will this request not answer me?");
    assert.deepEqual([...follow.querySelectorAll(".request-look-tag")].map(page.text), [t("Waiting for the project's reply", "等项目回复")]);
    assert.doesNotMatch(page.text(follow), /Dev Lead|YN-91/, "only the project replies (YN-233)");
    assert.equal(page.text(b.querySelector(".request-state")), t("Waiting for a reply", "等回复"));
    assert.equal(b.dataset.group, "doing");
    const confirm = b.querySelector('.request-block-action[data-action="confirm"]');
    assert.ok(confirm && !confirm.classList.contains("is-primary"), "Confirm done stays, not as the main action");
    assert.equal(b.querySelector(".request-block-settle"), null, "nothing says it waits for the user to confirm");
    assert.equal(page.text(b.querySelector('.request-block-foot [data-view="thread"]')), t("Conversation 5", "对话 5"));
    // Unfolded, the whole of it: R-45's zone.
    b.querySelector('.request-block-foot [data-view="cards"]').click();
    await tick();
    const zone = page.block(44).querySelector(".request-opened .request-follow");
    assert.equal(zone.dataset.state, "waiting");
    assert.match(page.text(zone.querySelector(".request-follow-lines")),
      t(/^Delivered · waiting for the project to reply · waiting 12 min1 more waits for the project's reply$/, /^已送达 · 等项目回复 · 已等 12 分钟另 1 条也在等项目回复$/));
    assert.deepEqual(page.errors, []);
  }
  // Replied while the work goes on: replied and not delivered are two tags (the user's R-50).
  const data = r44("answered");
  data.requests[0] = { ...data.requests[0], state: "doing", cards: [{ ...data.requests[0].cards[0], task: { ...data.requests[0].cards[0].task, status: "doing" } }] };
  const page = mount();
  page.window.renderPage(data);
  await tick();
  assert.deepEqual([...lineOf(page, 44, "follow").querySelectorAll(".request-look-tag")].map(page.text), ["Replied", "Work still going on, not delivered"]);
  assert.equal(page.text(lineOf(page, 44, "follow").querySelector(".request-look-said")), "Yes: until you look at the turn, the row says Between turns.");
  assert.deepEqual(page.errors, []);
});

test("R-45 answered and an unmarked note: what came of it said in the line; the user's turn again, delivered once ended", async () => {
  const page = mount();
  page.window.renderPage(r44("answered"));
  await tick();
  let follow = lineOf(page, 44, "follow");
  assert.deepEqual([...follow.querySelectorAll(".request-look-tag")].map(page.text), ["Replied"], "ended: replied, and nothing says it is not delivered");
  assert.equal(page.text(page.block(44).querySelector(".request-state")), "For you to accept");
  assert.ok(page.block(44).querySelector('.request-block-action[data-action="confirm"]').classList.contains("is-primary"));
  page.window.renderPage(r44("later"));
  await tick();
  follow = lineOf(page, 44, "follow");
  assert.deepEqual([...follow.querySelectorAll(".request-look-tag")].map(page.text), ["Later note"]);
  assert.equal(page.text(follow.querySelector(".request-look-said")), "Ask on here any time; I missed coming back.");
  const zh = mount({ lang: "zh" });
  zh.window.renderPage(r44("later"));
  await tick();
  assert.deepEqual([...lineOf(zh, 44, "follow").querySelectorAll(".request-look-tag")].map(zh.text), ["后续留言"]);
  assert.deepEqual([...page.errors, ...zh.errors], []);
});

test("R-45 Conversation opens it at the follow-up, it and what came of it marked; each line says what it is", async () => {
  const page = mount();
  page.window.renderPage(r44("later"));
  await tick();
  const step = lineOf(page, 44, "follow").querySelector('[data-step="talk"]');
  assert.equal(step.getAttribute("aria-label"), "Show follow-up #2 in the conversation");
  assert.equal(page.text(step), "Conversation");
  step.click();
  await tick();
  const b = page.block(44);
  assert.equal(b.querySelector(".request-block-body").dataset.view, "thread");
  assert.equal(page.document.activeElement, b.querySelector('.request-thread > li[data-reply="2"]'));
  assert.deepEqual([...b.querySelectorAll(".request-thread > li[data-focus]")].map((li) => li.dataset.threadItem), ["reply:1", "reply:2", "note:2"],
    "both follow-ups and the note said after them");
  const tags = (key) => [...b.querySelectorAll(`.request-thread > li[data-thread-item="${key}"] .request-thread-tag`)].map(page.text);
  assert.deepEqual(tags("note:2"), ["Later note"]);
  assert.deepEqual(tags("line:0"), ["Core's record · not a reply"]);
  assert.equal(page.text(b.querySelector('.request-thread > li[data-note="2"] > b')), "Project", "only the project speaks; who, in its tip");
  page.window.renderPage(r44("answered"));
  await tick();
  assert.deepEqual(tags("reply:2"), ["Delivered", "Replied ↓"]);
  assert.deepEqual(tags("note:2"), ["Replies to #2"]);
  assert.deepEqual(page.errors, []);
});

test("R-45 a follow-up not confirmed delivered: said so in its line with Send again, which sends that one again; none read only", async () => {
  const data = r44("waiting");
  data.requests[0].replies[1].deliveredTo[0].delivery = "sending";
  const page = mount();
  page.window.renderPage(data);
  await tick();
  const follow = lineOf(page, 44, "follow");
  assert.deepEqual([...follow.querySelectorAll(".request-look-tag")].map(page.text), ["Not confirmed delivered"]);
  assert.equal(page.text(page.block(44).querySelector(".request-state")), "Waiting for a reply");
  follow.querySelector(".request-look-meta button").click();
  assert.deepEqual(page.calls().at(-1), { resend: 44, reply: 2 });
  page.window.renderPage({ ...data, readOnly: true });
  await tick();
  assert.equal(lineOf(page, 44, "follow").querySelector(".request-look-meta button"), null);
  assert.deepEqual(page.errors, []);
});

// YN-237 ④: a lead's proposal is asked in the request it was made under, bound to no task: Needs you there, with what
// "new" would open shown above the Ask; once opened, both requests say so, each one step from the other.
test("a proposal is asked under its request with what new opens; once opened, both requests link to each other", async () => {
  const page = mount({ opened: ["r31"] });
  const card = section("yn-221", "status", "R-31 runtime", 4, { status: { asOf: ago(4), validFor: 3600, stale: false }, card: bind("YN-221") });
  const proposal = section("r31/split", "ask", "Split it off?", 2, {
    ask: { question: "Make it a request of its own?", state: "open", proposal: { request: 31, title: "Read a stage Job once", text: "Read it once a pass." },
      reply: { options: [{ id: "new", label: "New request, linked" }, { id: "merge", label: "Fold into R-31" }, { id: "later", label: "Note it" }], freeText: true } },
  });
  const r31 = request(31, 300, "doing", [routed(card, "YN-221")]);
  page.window.renderPage({ requests: [r31], sections: [card, proposal] });
  await tick();
  const b = page.block(31);
  assert.equal(b.dataset.group, "needs", "the user's to decide");
  assert.equal(page.text(b.querySelector(".request-state")), "Your decision");
  assert.equal(page.document.querySelector(".project-ask"), null, "not the Project's own Ask");
  const shown = b.querySelector('.request-proposal[data-proposal="r31/split"]');
  assert.equal(page.text(shown.querySelector(".request-proposal-preview")), "On “new”, Core opens this request:Read a stage Job onceRead it once a pass.");
  assert.ok(shown.querySelector('[data-section-key="r31/split"]'), "its Ask, answerable there");
  assert.deepEqual([...shown.querySelectorAll(".home-ask-pick input")].map((input) => [input.value, page.text(input.closest("label"))]),
    [["new", "New request, linked"], ["merge", "Fold into R-31"], ["later", "Note it"]]);
  // Answered "new": R-51 opened from it; each request one step from the other.
  const replied = { ...proposal, version: 3, ask: { ...proposal.ask, state: "replied", repliedAt: ago(0), replyText: "New request, linked" } };
  const link = (n) => ({ n, key: "r31/split", sectionId: proposal.id, version: 2, at: ago(0) });
  const r51 = request(51, 0, "waiting", [], { title: "Read a stage Job once", text: "Read it once a pass.", from: link(31) });
  page.window.renderPage({ requests: [r51, { ...r31, proposals: [link(51)] }], sections: [card, replied] });
  await tick();
  const opened = page.block(31).querySelector(".request-proposal-opened button");
  assert.equal(page.text(opened), "R-51, opened from a proposal here");
  opened.click();
  assert.deepEqual(page.calls().at(-1), { show: 51 });
  assert.equal(page.text(lineOf(page, 51, "related")), "RelatedOpened from a proposal in R-31");
  lineOf(page, 51, "related").querySelector("button").click();
  assert.deepEqual(page.calls().at(-1), { show: 31 });
  // Its words are the lead's proposal, which the user made a request: never said to be the user's.
  page.block(51).querySelector('.request-block-foot > .request-block-more[data-view="thread"]').click();
  await tick();
  assert.equal(page.text(page.block(51).querySelector('.request-thread > li[data-thread-item="mine"] > b')), "The proposal from R-31, which you made a request");
  const zh = mount({ lang: "zh" });
  zh.window.renderPage({ requests: [r51], sections: [] });
  assert.equal(zh.text(lineOf(zh, 51, "related")), "相关从 R-31 的提议拆出");
  assert.deepEqual([...page.errors, ...zh.errors], []);
});
