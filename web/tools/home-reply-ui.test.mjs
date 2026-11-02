import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-9: a reply the user sent from Home shows in the conversation as its
// answer (Dev 7's hr5), drawn only from `_yuzunoHome`, the snapshot Core
// keeps with its receipt. The real Turn, with the app's Send to Agent and
// "Open on Home" stood in for; the real Home, with Core answered here.
// Synthetic data only; no Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "home-reply-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
import {Home} from ${JSON.stringify(path.join(root, "src/home/Home.tsx"))};
import {HandoffContext} from ${JSON.stringify(path.join(root, "src/SendToAgent.tsx"))};
import {HomeReplyLinks} from ${JSON.stringify(path.join(root, "src/home-reply/HomeReply.tsx"))};
const root=createRoot(document.getElementById('root'));
const handoff={agents:()=>window.fixtureAgents,send:(source,agentId)=>{window.actions.push(['handoff',source,agentId]);return true;}};
const links={open:(origin,from)=>window.actions.push(['open',origin,from])};
window.renderTurn=(turn,agent,withLinks=true)=>flushSync(()=>root.render(<HandoffContext.Provider value={handoff}><HomeReplyLinks.Provider value={withLinks?links:null}><Turn turn={turn} index={0} agent={agent} onFile={()=>{}}/></HomeReplyLinks.Provider></HandoffContext.Provider>));
window.renderHome=(arrival)=>root.render(<Home workspaceId="ws-1" revision={0} jobsRevision={0} agents={[]} projects={[]} readOnly={false} onNavigate={()=>{}} onChanged={()=>{}} arrival={arrival} onBackToReply={(link)=>window.actions.push(['back',link])}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "HomeReply", formats: ["iife"] } },
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

const PHONE = "(max-width: 520px), (max-height: 500px) and (hover: none) and (pointer: coarse)";
function mount({ phone = false, respond } = {}) {
  const errors = [];
  const requests = [];
  const copied = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://reply.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = (query) => ({ matches: phone && query === PHONE, media: query, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (text) => { copied.push(text); } } });
  window.actions = [];
  window.fixtureAgents = [{ ...agent, id: "b", name: "Bo" }];
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    const { status = 200, body = {} } = (await respond?.(String(url))) ?? {};
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  const document = window.document;
  const message = (id) => document.querySelector(`.user-message[data-item-id="${id}"]`);
  const card = (id) => message(id)?.querySelector(".home-reply") ?? null;
  const actions = (id) => [...card(id).querySelectorAll(":scope > footer > button")].map((b) => b.textContent.trim());
  // React applies a click's update after the event: read the page after it.
  const press = async (id, label) => {
    const button = [...card(id).querySelectorAll("button")].find((b) => b.textContent.trim() === label);
    assert.ok(button, `${id}: no button ${label} in ${actions(id)}`);
    button.click();
    await tick();
    return button;
  };
  return { window, document, errors, requests, copied, message, card, actions, press, close: () => window.close() };
}

const agent = { id: "a", name: "Mori", harness: "codex", status: "idle", cwd: "/fixture", model: "", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const identity = (key, version) => ({ projectId: "p1", key, version, workspaceId: "ws-1" });
const snapshot = (fields) => ({ format: 1, projectName: "atlas-notes", sectionKind: null, title: null, question: null, options: null,
  choice: null, text: null, form: null, ...fields });
const options = [{ id: "fifty", label: "每页 50 行（推荐）" }, { id: "hundred", label: "每页 100 行" }, { id: "scroll", label: "不分页，保持滚动" }];
// What Core composed and sent the Agent (project_brief/home.rs): its keys,
// option ids and handling instructions show only as the original message.
const raw = {
  both: "Reply from the user on Home, to version 3 of the Project Brief section `export-paging` (\"导出页分页方案\") of atlas-notes (Workspace ws-1, Project p1):\n> 导出页表格改为分页后，每页显示多少行？\n\nChose: 每页 50 行（推荐） (fifty)\n\n先用 50 行；手机上再看一下底部翻页按钮会不会挡住最后一行。\n\nThe ask is now replied and out of the user's Needs you. Act on this reply, then resolve it with brief_update {op:\"resolve\", key:\"export-paging\"}.",
  form: "Reply from the user on Home, to version 1 of the Project Brief section `weekly` (\"周报需要哪些部分？\") of atlas-notes (Workspace ws-1, Project p1):\n> 周报需要哪些部分？\n\nAnswers to “周报内容”:\n- 包含的部分: 进展, 风险\n- 截止时间: 周五 18:00\n- 补充说明: 风险部分请列出负责人。\n- 附件: (no answer)\n\n{\"formId\":\"weekly-form\",\"answers\":{\"parts\":[\"progress\",\"risks\"],\"due\":\"friday\",\"note\":\"风险部分请列出负责人。\",\"files\":[]}}\n\nThe ask is now replied … brief_update {op:\"resolve\", key:\"weekly\"}.",
  card: "Reply from the user on Home, to version 4 of the Project Brief section `progress` (\"本周进展\") of atlas-notes (Workspace ws-1, Project p1):\n\n第三项的数字和附件里的不一致，请核对后更新这张卡片。",
  project: "Reply from the user on Home, about the Project Brief of atlas-notes:\n\n这周先别加新卡片了，把已有的两张整理完再说。",
  earlier: "Reply from the user on Home, to the Project Brief section `weekly-plan` (\"本周计划\") of atlas-notes:\n> 本周先做哪一项？\n\nChose: 先做导出页 (export-first)\n\nThe ask is now replied … brief_update {op:\"resolve\", key:\"weekly-plan\"}.",
};
const user = (id, text, extra) => ({ id, type: "userMessage", clientId: `c-${id}`, content: [{ type: "text", text }], ...extra });
const home = (id, text, origin) => user(id, text, { _yuzunoInput: "home", _yuzunoHome: origin });
const bothOrigin = { ...identity("export-paging", 3), snapshot: snapshot({ sectionKind: "ask", title: "导出页分页方案",
  question: "导出页表格改为分页后，每页显示多少行？", options, choice: options[0], text: "先用 50 行；手机上再看一下底部翻页按钮会不会挡住最后一行。" }) };
const formOrigin = { ...identity("weekly", 1), snapshot: snapshot({ sectionKind: "ask", title: "周报需要哪些部分？", question: "周报需要哪些部分？",
  options: [], form: { id: "weekly-form", title: "周报内容", fields: [
    { id: "parts", label: "包含的部分", type: "multi", answer: ["进展", "风险"] },
    { id: "due", label: "截止时间", type: "single", answer: "周五 18:00" },
    { id: "note", label: "补充说明", type: "text", answer: "风险部分请列出负责人。" },
    { id: "files", label: "附件", type: "multi", answer: [] },
  ] } }) };
const cardOrigin = { ...identity("progress", 4), snapshot: snapshot({ sectionKind: "report", title: "本周进展", text: "第三项的数字和附件里的不一致，请核对后更新这张卡片。" }) };
const projectOrigin = { ...identity(null, null), snapshot: snapshot({ text: "这周先别加新卡片了，把已有的两张整理完再说。" }) };
const earlierOrigin = identity("weekly-plan", 2);
const turn = {
  id: "t1", status: "completed",
  items: [
    home("i-both", raw.both, bothOrigin),
    home("i-form", raw.form, formOrigin),
    home("i-card", raw.card, cardOrigin),
    home("i-project", raw.project, projectOrigin),
    home("i-earlier", raw.earlier, earlierOrigin),
    // The same words typed in the composer, even carrying a snapshot: not a reply from Home.
    user("i-typed", raw.both, { _yuzunoInput: "you", _yuzunoHome: bothOrigin }),
    // From Home by its receipt, with no identity Core attached: shown as sent.
    user("i-bare", raw.earlier, { _yuzunoInput: "home" }),
    { id: "r1", type: "agentMessage", text: "Noted." },
  ],
};
// Where the protocol shows: never in a card's default view.
const protocol = ["export-paging", "fifty", "brief_update", "Reply from the user on Home", "weekly-form", "progress)", "Workspace ws-1"];

test("a reply from Home shows its answer first, where it came from on one line, and no protocol until asked", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderTurn(turn, agent);
  const both = page.card("i-both");
  assert.equal(both.querySelector(".home-reply-source").textContent, "From Home·导出页分页方案·atlas-notes");
  assert.equal(both.querySelector(".home-reply-choice").textContent, "每页 50 行（推荐）");
  assert.equal(both.querySelector(".home-reply-words").textContent, bothOrigin.snapshot.text);
  assert.deepEqual(page.actions("i-both"), ["Copy answer", "Question", "Original message", "Open on Home"]);
  // A form: each field with its answer, several as pills, an empty one said so.
  const form = page.card("i-form");
  assert.equal(form.querySelector(".home-reply-form-title").textContent, "Answers to “周报内容”");
  assert.deepEqual([...form.querySelectorAll("dt")].map((d) => d.textContent), ["包含的部分", "截止时间", "补充说明", "附件"]);
  assert.deepEqual([...form.querySelectorAll("dd")].map((d) => [d.textContent, d.hasAttribute("data-empty")]),
    [["进展风险", false], ["周五 18:00", false], ["风险部分请列出负责人。", false], ["Not answered", true]]);
  assert.deepEqual([...form.querySelectorAll("dd li")].map((li) => li.textContent), ["进展", "风险", "周五 18:00"]);
  // A card's version, and a reply to the whole Brief; neither has a Question.
  assert.equal(page.card("i-card").querySelector(".home-reply-source").textContent, "From Home·本周进展version 4·atlas-notes");
  assert.deepEqual(page.actions("i-card"), ["Copy answer", "Original message", "Open on Home"]);
  assert.equal(page.card("i-project").querySelector(".home-reply-source").textContent, "From Home·Project Brief·atlas-notes");
  for (const id of ["i-both", "i-form", "i-card", "i-project", "i-earlier"])
    for (const word of protocol) assert.ok(!page.card(id).textContent.includes(word), `${id} shows ${word}`);
  // The header is a message's: You, Send to Agent.
  assert.match(page.message("i-both").querySelector(".message-label").textContent, /You.*Send to Agent/);
  assert.deepEqual(page.errors, []);
});

test("only Core's own marking makes a card: typed words, a message with no identity, and an earlier reply", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderTurn(turn, agent);
  // The same text typed in the composer, a snapshot on it or not, is your message as written.
  assert.equal(page.card("i-typed"), null);
  assert.equal(page.message("i-typed").querySelector(".user-text").textContent, raw.both);
  assert.equal(page.card("i-bare"), null);
  assert.equal(page.message("i-bare").querySelector(".user-text").textContent, raw.earlier);
  // An earlier reply: a small container, nothing read from its text, the message as sent one click away.
  const earlier = page.card("i-earlier");
  assert.ok(earlier.classList.contains("earlier"));
  assert.equal(earlier.querySelector(".home-reply-source").textContent, "From Home·an earlier reply, shown as sent");
  assert.deepEqual(page.actions("i-earlier"), ["Original message", "Open on Home"]);
  assert.ok(!earlier.textContent.includes("先做导出页"), "nothing is read from an earlier reply's text");
  await page.press("i-earlier", "Original message");
  assert.equal(earlier.querySelector(".home-reply-original pre").textContent, raw.earlier);
  assert.deepEqual(page.errors, []);
});

test("Copy answer copies the answer as shown; Copy original and Send to Agent the message exactly as sent", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderTurn(turn, agent);
  await page.press("i-both", "Copy answer");
  await page.press("i-form", "Copy answer");
  await page.press("i-card", "Copy answer");
  await until(() => page.copied.length === 3, "three answers copied");
  assert.deepEqual(page.copied, [
    `每页 50 行（推荐）\n\n${bothOrigin.snapshot.text}`,
    "包含的部分: 进展, 风险\n截止时间: 周五 18:00\n补充说明: 风险部分请列出负责人。\n附件: Not answered",
    cardOrigin.snapshot.text,
  ]);
  await until(() => page.actions("i-both")[0] === "Copied", "Copied shown");
  // The original message: exactly as sent, with its own copy.
  const toggle = await page.press("i-both", "Original message");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const region = page.document.getElementById(toggle.getAttribute("aria-controls"));
  assert.equal(region.getAttribute("role"), "region");
  assert.equal(region.querySelector("pre").textContent, raw.both);
  await page.press("i-both", "Copy original");
  await until(() => page.copied.length === 4, "original copied");
  assert.equal(page.copied[3], raw.both);
  // Send to Agent hands on the message as sent, never the card's summary.
  [...page.message("i-both").querySelectorAll(".message-label button")].find((b) => /Send to Agent/.test(b.textContent)).click();
  await until(() => page.document.querySelector("[role=menuitem]"), "the Agent menu");
  [...page.document.querySelectorAll("[role=menuitem]")].find((b) => b.textContent.includes("Bo")).click();
  const [, source, to] = page.window.actions.find(([kind]) => kind === "handoff");
  assert.equal(to, "b");
  assert.equal(source.text, raw.both);
  assert.deepEqual(page.errors, []);
});

test("the question as the user saw it opens on demand, its options with the chosen one marked", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderTurn(turn, agent);
  const toggle = await page.press("i-both", "Question");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const region = page.document.getElementById(toggle.getAttribute("aria-controls"));
  assert.equal(region.querySelector(".home-reply-meta").textContent, "The question as you saw it · version 3");
  assert.equal(region.querySelector("p").textContent, bothOrigin.snapshot.question);
  assert.deepEqual([...region.querySelectorAll("li")].map((li) => [li.textContent, li.classList.contains("chosen")]),
    [["每页 50 行（推荐） (your choice)", true], ["·每页 100 行", false], ["·不分页，保持滚动", false]]);
  // The dot is drawn only: what is read out is the option.
  assert.ok([...region.querySelectorAll("li .dot")].every((dot) => dot.getAttribute("aria-hidden") === "true"));
  await page.press("i-both", "Question");
  assert.equal(page.document.getElementById(toggle.getAttribute("aria-controls")), null);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.deepEqual(page.errors, []);
});

test("Open on Home names the version answered and the message to come back to", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderTurn(turn, agent);
  await page.press("i-both", "Open on Home");
  await page.press("i-earlier", "Open on Home");
  const opened = page.window.actions.filter(([kind]) => kind === "open");
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [
    ["open", bothOrigin, { agentId: "a", turnId: "t1", itemId: "i-both" }],
    ["open", earlierOrigin, { agentId: "a", turnId: "t1", itemId: "i-earlier" }],
  ]);
  // Where Home can't be opened from here, there is no such button.
  page.window.renderTurn(turn, agent, false);
  assert.deepEqual(page.actions("i-both"), ["Copy answer", "Question", "Original message"]);
  assert.deepEqual(page.errors, []);
});

test("a long reply is read whole: its original message is read in full before it is shown or copied", async (t) => {
  const full = `${"很长的补充说明。".repeat(1500)}结尾`;
  const page = mount({
    respond: (url) => url.includes("/items/i-long/payload")
      ? { body: { fields: { content: [{ type: "text", text: full }] } } }
      : undefined,
  });
  t.after(page.close);
  const long = home("i-long", full.slice(0, 2000), { ...identity(null, null), snapshot: snapshot({ text: "也请看附件。" }) });
  long._yuzunoTruncated = { content: { bytes: new TextEncoder().encode(full).length, lines: 1, keep: "head" } };
  page.window.renderTurn({ id: "t2", status: "completed", items: [long] }, agent);
  await page.press("i-long", "Original message");
  await until(() => page.card("i-long").querySelector(".home-reply-original pre")?.textContent === full, "the whole message");
  assert.ok(page.requests.some((r) => r.url.includes("/items/i-long/payload?") && r.url.includes("turnId=t2")));
  await page.press("i-long", "Copy original");
  await until(() => page.copied.length === 1, "original copied");
  assert.equal(page.copied[0], full);
  assert.deepEqual(page.errors, []);
});

test("on a phone the actions go in the rows they show: Copy answer and Open on Home, then the rest", async (t) => {
  const page = mount({ phone: true });
  t.after(page.close);
  page.window.renderTurn(turn, agent);
  assert.equal(page.card("i-both").dataset.layout, "phone");
  assert.deepEqual(page.actions("i-both"), ["Copy answer", "Open on Home", "Question", "Original message"]);
  assert.deepEqual(page.actions("i-card"), ["Copy answer", "Open on Home", "Original message"]);
  assert.deepEqual(page.actions("i-earlier"), ["Original message", "Open on Home"]);
  assert.deepEqual([...page.card("i-both").querySelectorAll("footer > button.second")].map((b) => b.textContent.trim()), ["Question", "Original message"]);
  assert.deepEqual(page.errors, []);
});

// Home, as Core reads it, for arrivals. Section `id` is Core's identity on
// Home: kept through edits, a resolve and a seen card written again; new for
// a key written anew. Versions only rise under a key; resolving adds one,
// removing and marking seen keep the version (project_brief, update.rs).
const owner = { agentId: "a", name: "Mori", state: "active" };
const body = { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["note"] }, note: { type: "Markdown", props: { text: "手机上翻页按钮会挡住最后一行。" } } } };
const section = (key, id, version, extra = {}) => ({ id, key, kind: "report", title: `About ${key}`, version, owner,
  updatedAt: "2026-11-01T14:05:00Z", updatedTurnId: null, body, attachments: [], refs: {}, seen: null, history: false, ...extra });
const ask = (key, id, version, extra = {}) => section(key, id, version, { kind: "ask", title: "导出页分页方案",
  ask: { question: "改成每页 40 行？", reply: { options: [{ id: "forty", label: "每页 40 行" }, { id: "keep", label: "保持 50 行" }] }, state: "open" }, ...extra });
const ended = (make, key, id, version, reason) => make(key, id, version, { history: true, historyReason: reason,
  ...(make === ask ? { ask: { question: "?", reply: { freeText: true }, state: reason === "resolved" ? "resolved" : "open" } } : {}) });
const homeData = (sections, history = [], teamSections = undefined) => ({
  generatedAt: "2026-11-01T14:30:00Z", order: ["p1"], needsYou: [],
  projects: [{ project: { id: "p1", name: "atlas-notes" }, agents: { working: 0, idle: 0, waiting: 0, error: 0, offline: 0, total: 0 },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 3, sections, history, ...(teamSections ? { teamSections } : {}) } }],
});
const machine = { at: "2026-11-01T14:30:00Z", cpu: { cores: 4, totalPct: 0, jobsPct: 0, agentsPct: 0, otherPct: 0 },
  memory: { totalMiB: 4096, usedMiB: 0, availableMiB: 4096, jobsMiB: 0, agentsMiB: 0 }, gpus: null, jobs: [] };
const back = { workspaceId: "ws-1", agentId: "a", turnId: "t1", itemId: "i-both" };
// The ask answered at version 3, section 10; a report answered at version 1, section 30.
const askReply = { ...bothOrigin, sectionId: 10 };
const reportReply = { ...identity("plan", 1), sectionId: 30, snapshot: snapshot({ sectionKind: "report", title: "About plan", text: "Looks right." }) };
async function arrive(data, origin, n = 1) {
  const page = mount({ respond: (url) => ({ body: url === "/api/home" ? data : url === "/api/machine-load" ? machine : { repositories: [], links: [] } }) });
  page.window.renderHome({ origin, back, n });
  await until(() => page.document.querySelector(".home-panel"), "Home read");
  await tick(40);
  return page;
}
const note = (page) => page.document.querySelector(".home-reply-arrival");
const cardOf = (page, key) => page.document.querySelector(`[data-section-key="${key}"]`);
const pressBack = (page) => [...note(page).querySelectorAll("button")].find((b) => b.textContent === "Back to your reply").click();
async function arrivals(cases) {
  for (const [label, data, origin, check] of cases) {
    const page = await arrive(data, origin);
    try {
      await check(page);
      assert.deepEqual(page.errors, [], label);
    } catch (error) {
      error.message = `${label}: ${error.message}`;
      throw error;
    } finally {
      page.close();
    }
  }
}
const above = (page, said) => {
  assert.equal(note(page)?.textContent, said);
  assert.ok(note(page).parentElement.classList.contains("home-panel-content"), "above the project's cards");
};

test("on Home, the same section later says which version was answered, in its card, with the way back", async (t) => {
  const page = await arrive(homeData([ask("export-paging", 10, 4)]), askReply);
  t.after(page.close);
  assert.equal(note(page).closest('[data-section-key="export-paging"]'), cardOf(page, "export-paging"));
  assert.equal(note(page).textContent, "You replied to version 3 of this ask. It has changed since; this is version 4, not the one you answered.Back to your reply");
  assert.equal(page.document.activeElement, cardOf(page, "export-paging"), "the card it answered is focused");
  pressBack(page);
  assert.deepEqual(JSON.parse(JSON.stringify(page.window.actions)), [["back", back]]);
  assert.deepEqual(page.errors, []);
});

test("on Home, a resolved, removed or seen section is said from its own record, the same version only shown", async () => {
  await arrivals([
    ["same version", homeData([ask("export-paging", 10, 3)]), askReply, (page) => {
      assert.equal(note(page), null);
      assert.equal(page.document.activeElement, cardOf(page, "export-paging"));
    }],
    // Resolving adds a version: the record is the section's by its identity, not by version.
    ["resolved", homeData([], [ended(ask, "export-paging", 10, 4, "resolved")]), askReply, (page) =>
      above(page, "You replied to version 3. Its author has resolved this ask; it is under History on this project.")],
    ["removed", homeData([], [ended(ask, "export-paging", 10, 3, "removed")]), askReply, (page) =>
      above(page, "You replied to version 3. Its author removed this card from Home.")],
    ["seen", homeData([], [ended(section, "plan", 30, 1, "seen")]), reportReply, (page) =>
      above(page, "You replied to version 1. This card is now under History on this project.")],
    // A seen card its owner writes again is the same section on Home.
    ["seen, written again", homeData([section("plan", 30, 2)]), reportReply, (page) => {
      assert.equal(note(page).textContent, "You replied to version 1 of this card. It has changed since; this is version 2, not the one you answered.Back to your reply");
      assert.ok(note(page).closest('[data-section-key="plan"]'));
    }],
  ]);
});

test("on Home, a key written anew is another section: its fate is never told as the one answered", async () => {
  const never = (page) => {
    assert.equal(note(page).querySelector("button")?.textContent, "Back to your reply");
    assert.ok(!cardOf(page, "plan") || page.document.activeElement !== cardOf(page, "plan"), "another card is not opened as the one answered");
    assert.ok(!cardOf(page, "plan")?.hasAttribute("data-home-highlight"));
    assert.ok(!note(page).closest("[data-section-key]"), "not in another card");
  };
  await arrivals([
    // The report answered was removed; its key was then written as an ask and resolved.
    ["removed, key asked anew and resolved", homeData([], [ended(section, "plan", 30, 1, "removed"), ended(ask, "plan", 31, 3, "resolved")]), reportReply,
      (page) => above(page, "You replied to version 1. Its author removed this card from Home.")],
    // The same, with the report's own History expired: nothing is said of it but that Home can't tell.
    ["history expired, key asked anew and resolved", homeData([], [ended(ask, "plan", 31, 3, "resolved")]), reportReply, (page) => {
      above(page, "You replied to version 1. Home has no record of what became of it.Back to your reply");
      never(page);
      pressBack(page);
      assert.deepEqual(JSON.parse(JSON.stringify(page.window.actions)), [["back", back]]);
    }],
    // Another live card under the key now.
    ["history expired, key live again", homeData([ask("plan", 31, 2)]), reportReply, (page) => {
      above(page, "You replied to version 1. Home can't tell whether this card is the one you answered; under this name it is version 2 now.Back to your reply");
      never(page);
    }],
    ["no record at all", homeData([section("other", 40, 1)]), reportReply, (page) => {
      above(page, "You replied to version 1. Home has no record of what became of it.Back to your reply");
    }],
  ]);
});

test("on Home, a reply that names no section is told only by its very version", async () => {
  const legacy = { ...bothOrigin };
  assert.equal(legacy.sectionId, undefined);
  await arrivals([
    ["same version", homeData([ask("export-paging", 10, 3)]), legacy, (page) => {
      assert.equal(note(page), null);
      assert.equal(page.document.activeElement, cardOf(page, "export-paging"));
    }],
    // A later version may be another section: Home can't tell, and opens no card as the one answered.
    ["later version", homeData([ask("export-paging", 11, 4)]), legacy, (page) => {
      above(page, "You replied to version 3. Home can't tell whether this card is the one you answered; under this name it is version 4 now.Back to your reply");
      assert.notEqual(page.document.activeElement, cardOf(page, "export-paging"));
    }],
    // Removing and marking seen keep the version: that very record is the one answered.
    ["removed at that version", homeData([], [ended(ask, "export-paging", 10, 3, "removed")]), legacy, (page) =>
      above(page, "You replied to version 3. Its author removed this card from Home.")],
    // Resolving adds a version: without the section's identity, nothing proves it was the one answered.
    ["resolved after", homeData([], [ended(ask, "export-paging", 10, 4, "resolved")]), legacy, (page) =>
      above(page, "You replied to version 3. Home has no record of what became of it.Back to your reply")],
  ]);
});

// R1 839f91d1: a section kept out of view (its author no longer a content
// editor) is in the project's closed team details.
test("on Home, the section answered in the team area is shown: its details open, its card unfolded and focused, again on each opening", async (t) => {
  const team = (version) => homeData([section("other", 40, 1)], [], [ask("export-paging", 10, version)]);
  const details = (page) => page.document.querySelector(".home-team-details");
  await arrivals([
    ["same version", team(3), askReply, (page) => {
      assert.equal(details(page).open, true, "the team details hold it: open");
      assert.ok(!page.document.querySelector(".home-panel").classList.contains("is-collapsed"), "its project opened");
      assert.equal(note(page), null);
      assert.equal(page.document.activeElement, cardOf(page, "export-paging"));
    }],
    ["changed", team(4), askReply, (page) => {
      assert.equal(details(page).open, true);
      assert.equal(note(page).closest('[data-section-key="export-paging"]'), cardOf(page, "export-paging"), "the note in the card it answered");
      assert.equal(page.document.activeElement, cardOf(page, "export-paging"));
    }],
  ]);
  // Opened again after the user closed the details and folded the card: shown again.
  const page = await arrive(team(4), askReply);
  t.after(page.close);
  details(page).open = false;
  cardOf(page, "export-paging").querySelector(".home-fold").click();
  await tick(40);
  assert.ok(cardOf(page, "export-paging").querySelector(".home-card-body").hidden, "folded by the user");
  page.window.renderHome({ origin: askReply, back, n: 2 });
  await until(() => details(page).open && !cardOf(page, "export-paging").querySelector(".home-card-body").hidden, "shown again");
  await tick(40);
  assert.equal(page.document.activeElement, cardOf(page, "export-paging"));
  assert.ok(note(page).closest('[data-section-key="export-paging"]'));
  assert.deepEqual(page.errors, []);
});

test("on Home, another section under the key in the team area is not opened as the one answered", async () => {
  await arrivals([
    ["key written anew, kept out of view", homeData([section("other", 40, 1)], [], [ask("plan", 31, 2)]), reportReply, (page) => {
      above(page, "You replied to version 1. Home can't tell whether this card is the one you answered; under this name it is version 2 now.Back to your reply");
      assert.equal(page.document.querySelector(".home-team-details").open, false, "the team details stay closed");
      assert.notEqual(page.document.activeElement, cardOf(page, "plan"));
    }],
  ]);
});

test("on Home, a reply to the whole Brief opens its project; a project Home no longer has is said", async (t) => {
  const whole = await arrive(homeData([section("other", 40, 1)]), projectOrigin);
  t.after(whole.close);
  assert.equal(note(whole), null);
  assert.ok(whole.document.querySelector(".home-panel").hasAttribute("data-home-highlight"), "its project is shown");
  const gone = await arrive(homeData([]), { ...askReply, projectId: "p-gone" });
  t.after(gone.close);
  assert.equal(note(gone).textContent, "The project this reply was about is not on Home now.");
  assert.deepEqual([...whole.errors, ...gone.errors], []);
});

test("on a phone, Back to your reply is a 44px target too", async (t) => {
  const page = mount({ phone: true, respond: (url) => ({ body: url === "/api/home" ? homeData([ask("export-paging", 10, 4)]) : url === "/api/machine-load" ? machine : { repositories: [], links: [] } }) });
  t.after(page.close);
  page.window.renderHome({ origin: askReply, back, n: 1 });
  await until(() => note(page), "the arrival note");
  assert.equal(note(page).dataset.layout, "phone");
  assert.deepEqual(page.errors, []);
});
