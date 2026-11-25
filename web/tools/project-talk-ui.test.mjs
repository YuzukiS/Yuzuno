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

// YN-86 S3b, YN-212 W3: "Talk to the project" on a Project's page. It reads
// the requests for the page's blocks, draws the conversation (the words,
// the project's short replies, follow-ups, Core's lines) as the page's
// Conversation view, runs the blocks' actions (follow up, confirm done,
// send again) and keeps the composer; what is said goes to Core as a request
// or a follow-up, sent again as it was. And the front desk chosen among the
// leads in a Project's settings. The real components with a stand-in Core;
// synthetic data only.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "project-talk-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {ProjectTalk} from ${JSON.stringify(path.join(root, "src/home/ProjectTalk.tsx"))};
import {CardAgents} from ${JSON.stringify(path.join(root, "src/home/card-responsible.ts"))};
import {ProjectMembers} from ${JSON.stringify(path.join(root, "src/ProjectLeads.tsx"))};
const root=createRoot(document.getElementById('root'));
window.navigated=[];
window.shownRequests=[];
window.chats=0;
window.busy=null;
window.read=null;
window.arrivals=[];
window.dismissed=0;
window.renderTalk=(props={})=>flushSync(()=>root.render(<CardAgents.Provider value={new Map(window.agents.map((a)=>[a.id,a]))}><ProjectTalk projectId="p1" projectName="Atlas" workspaceId="ws" readOnly={false} revision={0} leadCount={1} onArrival={(arrival)=>window.arrivals.push(arrival)} onDismissNotice={()=>window.dismissed++} onNavigate={(target)=>window.navigated.push(target)} onShowRequest={(n)=>window.shownRequests.push(n)} onShowChat={()=>window.chats++} onBusy={(busy)=>{window.busy={confirming:[...busy.confirming],resending:[...busy.resending],errors:[...busy.errors]};}} onRequests={(requests)=>{window.read=requests.map((r)=>r.n);}} {...props}/></CardAgents.Provider>));
window.renderMembers=(props)=>flushSync(()=>root.render(<ProjectMembers {...props}/>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "ProjectTalk", formats: ["iife"] } },
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
/** Read across the window's realm as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const base = { model: "m", color: "sage", cwd: "/w/atlas", goal: "", createdAt: "2026-11-12T00:00:00Z", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", harness: "codex" };
const agents = [
  { ...base, id: "d", name: "Dev Lead", kind: "lead", status: "idle" },
  { ...base, id: "e", name: "Ops Lead", kind: "lead", status: "idle" },
  { ...base, id: "x", name: "YN-91 · Design", kind: "executor", status: "working",
    executor: { agentId: "x", state: "running", task: { id: "YN-91", title: "Settings layout", shortName: "Design" }, dispatchedAt: ago(30) } },
];
const desk = { agentId: "d", name: "Dev Lead" };
const LONG = `${"A long line of pasted log text, 0123456789.\n".repeat(60)}end`;
const done = (status) => ({ id: "YN-90", status, archived: false });
/** Four requests, newest first as Core gives them: R-1 done (joined to a card), R-2 not confirmed, R-3 in progress
 * with two cards, a follow-up and an Ask, R-4 just said and long. */
const requests = (t39 = ago(39), t119 = ago(119)) => [
  { id: "r4", n: 4, text: LONG, textBlocks: null, title: null, createdAt: ago(5), frontAgentId: "d", messageId: "m4",
    delivery: "accepted", replies: [], notes: [], routes: [], cards: [], state: "waiting", progress: { cards: 0, ended: 0 }, lines: [] },
  { id: "r3", n: 3, text: "Rework the settings page and make the copy casual", textBlocks: null, title: "Settings page layout",
    createdAt: ago(40), frontAgentId: "d", messageId: "m3", delivery: "accepted",
    replies: [{ n: 1, text: "Also the phone layout", textBlocks: null, at: ago(30), messageId: "m3-1",
      deliveredTo: [{ agentId: "x", delivery: "accepted" }, { agentId: "d", delivery: "queued" }] }],
    notes: [{ note: "OK, split into two cards", by: desk, at: t39 }],
    routes: [
      { kind: "card", index: 0, request: 3, at: t39, state: "done", why: "A design with an end", by: desk,
        to: { agentId: "x", name: "YN-91 · Design" }, task: "YN-91", cardKey: "yn-91", sectionId: 21, title: "Settings layout" },
      { kind: "card", index: 1, request: 3, at: t39, state: "done", why: "Words only", by: desk,
        to: desk, task: "YN-92", cardKey: "yn-92", sectionId: 22, title: "Casual copy" },
    ],
    cards: [
      { sectionId: 21, key: "yn-91", title: "Settings layout", live: true, task: { id: "YN-91", status: "doing", archived: false },
        responsible: { agentId: "x", name: "YN-91 · Design", kind: "executor", state: "running" } },
      { sectionId: 22, key: "yn-92", title: "Casual copy", live: true, task: { id: "YN-92", status: "doing", archived: false },
        responsible: { agentId: "d", name: "Dev Lead", kind: "lead", state: "idle" } },
    ],
    state: "doing", progress: { cards: 2, ended: 0 },
    lines: [{ kind: "ask", sectionId: 31, key: "yn-91/pick", title: "Pick a layout", state: "open", at: ago(20), task: "YN-91", cardSectionId: 21 }] },
  { id: "r2", n: 2, text: "Make the backup faster please", textBlocks: null, title: null, createdAt: ago(50), frontAgentId: "d",
    messageId: "m2", delivery: "uncertain", replies: [], notes: [], routes: [], cards: [], state: "waiting", progress: { cards: 0, ended: 0 }, lines: [] },
  { id: "r1", n: 1, text: "Compare export formats again", textBlocks: null, title: "Export formats", createdAt: ago(120), frontAgentId: "d",
    messageId: "m1", delivery: "accepted", replies: [], notes: [{ note: "Same thing as the export card", by: desk, at: t119 }],
    routes: [{ kind: "existing", index: 0, request: 1, at: t119, state: "done", why: "The same thing as the earlier request", by: desk,
      to: { agentId: "x", name: "YN-91 · Design" }, task: "YN-90", cardKey: "yn-90", sectionId: 20 }],
    cards: [{ sectionId: 20, key: "yn-90", title: "Export research", live: false, task: done("done"), responsible: null }],
    state: "done", progress: { cards: 1, ended: 1 },
    lines: [{ kind: "done", task: "YN-90", status: "done", at: ago(100), cardSectionId: 20, title: "Export research" }] },
];

function mount({ width = 1440, lang = "en", storage = {}, front = { version: 1, agentId: null, effectiveAgentId: "d" }, fail = 0 } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://project-talk.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.Range.prototype.getClientRects ||= () => [];
  window.Range.prototype.getBoundingClientRect ||= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  window.HTMLElement.prototype.scrollTo = function () {};
  window.HTMLElement.prototype.scrollIntoView ||= function () {};
  // JSDOM lays nothing out: the window's width, as a media query reads it, says whether the two sides fit.
  window.matchMedia = (query) => {
    const most = query.match(/\(max-width: (\d+)px\)/);
    return { media: query, matches: most ? width <= Number(most[1]) : false, addEventListener() {}, removeEventListener() {} };
  };
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  window.agents = agents;
  const calls = [];
  const state = { fail, front, requests: requests() };
  const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const call = { url: String(url), method, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (method === "GET" && call.url.endsWith("/front-desk")) return answer(state.front);
    if (method === "PUT" && call.url.endsWith("/front-desk")) {
      state.front = { version: state.front.version + 1, agentId: call.body.agentId, effectiveAgentId: call.body.agentId };
      return answer(state.front);
    }
    if (method === "GET" && call.url.endsWith("/leads")) return answer({ version: 1, leadAgentIds: ["d", "e"] });
    if (method === "GET" && /\/requests(\?|$)/.test(call.url)) return answer({ requests: state.requests, hasMore: false });
    if (method === "POST" && state.fail > 0) {
      state.fail--;
      throw new TypeError("Failed to fetch");
    }
    // YN-184: the user's confirmation; Core refuses it with state.refuse, else the request is done.
    const confirmed = call.url.match(/\/requests\/(\d+)\/confirm$/);
    if (method === "POST" && confirmed) {
      if (state.refuse) return answer({ error: state.refuse }, 400);
      const n = Number(confirmed[1]);
      state.requests = state.requests.map((r) => (r.n === n ? { ...r, state: "done", confirmedAt: new Date().toISOString() } : r));
      return answer({ request: state.requests.find((r) => r.n === n) });
    }
    const receipt = { input: { text: call.body?.text, clientMessageId: call.body?.clientMessageId }, status: "accepted", turnId: "t1", error: null };
    if (method === "POST" && call.url.endsWith("/replies")) return answer({ reply: { n: 2 }, receipts: [receipt] });
    // A new request (YN-226): Core keeps it, lists it from then on when state.listOnPost, answers when state.hold
    // lets it, with the whole request when state.full (as project_requests.rs does), else with its number only.
    if (method === "POST" && call.url.endsWith("/requests")) {
      const made = { id: "r5", n: 5, text: call.body.text, textBlocks: null, title: null, createdAt: new Date().toISOString(), frontAgentId: "d",
        messageId: call.body.clientMessageId, delivery: state.delivery ?? "accepted", replies: [], notes: [], routes: [], cards: [],
        state: "waiting", progress: { cards: 0, ended: 0 }, lines: [] };
      state.made = made;
      if (state.listOnPost) state.requests = [made, ...state.requests.filter((r) => r.n !== 5)];
      if (state.hold) await state.hold;
      return answer({ request: state.full ? made : { n: 5 }, receipt });
    }
    return answer({});
  };
  window.eval(bundle);
  const document = window.document;
  const talk = () => document.querySelector(".project-talk-page");
  const words = (n) => document.querySelector(`.project-talk-mine[data-words="${n}"]`);
  const button = (label, scope = document) =>
    [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
  const field = () => document.querySelector(".project-talk-field [data-composer-input]");
  const posts = () => calls.filter((c) => c.method !== "GET");
  return { window, document, errors, calls, state, talk, words, button, field, posts, close: () => window.close() };
}

async function talk(options, props = {}) {
  const page = mount(options);
  page.window.renderTalk(props);
  await until(() => page.window.read?.length, "the requests are read");
  await tick();
  return page;
}

test("the requests are read for the page, and the conversation is drawn only as its Conversation view", async (t) => {
  const page = await talk({}, { mode: "requests" });
  t.after(page.close);
  assert.deepEqual(plain(page.window.read), [4, 3, 2, 1], "every request read, for the blocks");
  assert.ok(page.talk().hidden, "the Requests view draws no conversation");
  assert.ok(page.document.querySelector(".project-talk-compose"), "the composer still");
  page.window.renderTalk({ mode: "chat" });
  await tick();
  assert.ok(!page.talk().hidden);
  // With a dock, the composer is there, not under the conversation.
  const dock = page.document.createElement("div");
  page.document.body.append(dock);
  page.window.renderTalk({ mode: "chat", dock });
  await tick();
  assert.ok(dock.querySelector(".project-talk-compose.project-dock-form"));
  assert.ok(!page.talk().querySelector(".project-talk-compose"));
  assert.deepEqual(page.errors, []);
});

test("the conversation has each request's words once, the project's short replies, follow-ups and Core's lines", async (t) => {
  const page = await talk();
  t.after(page.close);
  const chat = page.talk();
  // The words, in a bubble; nowhere else on the page.
  assert.equal(page.words(3).querySelector(".project-talk-bubble").textContent, "Rework the settings page and make the copy casual");
  assert.equal(page.document.body.textContent.split("Rework the settings page").length - 1, 1);
  // A long message without blocks is one block, its text not in the page until opened.
  const long = page.words(4).querySelector(".project-talk-bubble");
  assert.equal(long.querySelectorAll(".pasted-text-chip, [aria-haspopup='dialog']").length >= 1, true, "a long message is a block");
  assert.ok(long.textContent.length < 200, `the block's label, not its ${LONG.length} characters`);
  // The project's short reply, with its request; "looking at it" while there is none.
  const note = [...chat.querySelectorAll(".project-talk-project")].find((li) => li.textContent.includes("OK, split into two cards"));
  assert.ok(page.button("Request →", note));
  assert.equal(note.querySelector(".project-talk-who").textContent, "Project");
  const looking = chat.querySelector(".project-talk-project[data-looking]");
  assert.match(looking.textContent, /^ProjectLooking at it… \d+ min$/);
  // A follow-up quotes its request; Core says who it went to.
  const follow = chat.querySelector('[data-reply="3:1"]');
  assert.equal(follow.querySelector(".project-talk-quote-ref").textContent, "Follow-up to “Settings page layout”");
  assert.equal(follow.querySelector(".project-talk-receipt").textContent, "Passed to YN-91 · Design, Dev Lead");
  // Core's lines: an Ask to answer.
  const ask = chat.querySelector('.project-talk-line[data-line="ask"]');
  assert.equal(ask.querySelector(".project-talk-line-text").textContent, "“Pick a layout” needs you to choose");
  // R-2's words did not reach the front desk: said so, with Send again.
  assert.match(page.words(2).querySelector(".project-talk-unconfirmed").textContent, /^Not confirmed delivered · Send again$/);
  // Before the oldest request still going on, the conversation is folded.
  assert.ok(!page.words(1), "R-1 is earlier");
  const earlier = page.button("Earlier 3", chat);
  assert.ok(earlier, "R-1's words, its reply and its done line");
  earlier.click();
  await tick();
  assert.ok(page.words(1));
  assert.equal(chat.querySelector('.project-talk-line[data-line="done"] .project-talk-line-text').textContent, "“Export research” is done");
  // In time order, the newest last.
  const order = [...chat.querySelectorAll(".project-talk-thread > li")].map((li) => li.dataset.words ?? li.dataset.reply ?? li.dataset.line ?? (li.dataset.looking !== undefined ? "looking" : "note"));
  assert.deepEqual(order, ["1", "note", "done", "2", "3", "note", "3:1", "ask", "4", "looking"]);
  assert.deepEqual(page.errors, []);
});

test("a request's links in the conversation show its block; a card's See words shows its words here", async (t) => {
  const page = await talk();
  t.after(page.close);
  const note = [...page.talk().querySelectorAll(".project-talk-project")].find((li) => li.textContent.includes("OK, split"));
  page.button("Request →", note).click();
  page.button("Answer", page.talk()).click();
  assert.deepEqual(plain(page.window.shownRequests), [3, 3]);
  // See words: the page is asked for the conversation, the earlier part opened, the words focused.
  page.window.renderTalk({ reveal: { n: 1, seq: 1 } });
  await until(() => page.words(1), "the earlier conversation is open");
  await tick();
  assert.equal(page.window.chats, 1);
  assert.equal(page.document.activeElement, page.words(1));
  assert.deepEqual(page.errors, []);
});

test("a block's actions run here: Confirm done asks Core and says why it refused, Follow up quotes, Send again goes as kept", async (t) => {
  const page = mount();
  page.state.requests = page.state.requests.map((r) => (r.n === 1 ? { ...r, state: "ended" } : r));
  page.state.refuse = "request_not_ready: R-1 still has a card going on. Nothing was confirmed.";
  page.window.renderTalk({ mode: "requests" });
  await until(() => page.window.read?.length, "the requests are read");
  t.after(page.close);

  page.window.renderTalk({ mode: "requests", command: { kind: "confirm", n: 1, seq: 1 } });
  await until(() => page.window.busy?.errors.length, "Core's refusal is told to the page");
  assert.deepEqual(plain(page.window.busy.errors), [[1, "request_not_ready: R-1 still has a card going on. Nothing was confirmed."]]);
  assert.equal(page.posts().length, 1);
  assert.match(page.posts()[0].url, /\/api\/projects\/p1\/requests\/1\/confirm$/);
  assert.deepEqual(plain(page.posts()[0].body), { workspaceId: "ws" });
  // The same command again does nothing; a new one tries again.
  page.window.renderTalk({ mode: "requests", command: { kind: "confirm", n: 1, seq: 1 } });
  await tick();
  assert.equal(page.posts().length, 1);
  page.state.refuse = "";
  page.window.renderTalk({ mode: "requests", command: { kind: "confirm", n: 1, seq: 2 } });
  await until(() => page.posts().length === 2 && !page.window.busy.errors.length && !page.window.busy.confirming.length, "done, the refusal gone");

  // Follow up: the request quoted in the composer, which takes the focus; the view stays.
  page.window.renderTalk({ mode: "requests", command: { kind: "follow", n: 3, seq: 3 } });
  await until(() => page.document.querySelector(".project-talk-quoting"), "quoted");
  assert.equal(page.document.querySelector(".project-talk-quoting span").textContent, "Follow-up to “Settings page layout”");
  assert.ok(page.talk().hidden, "still the requests");

  // Send again: R-2's words as Core keeps them.
  page.window.renderTalk({ mode: "requests", command: { kind: "resend", n: 2, seq: 4 } });
  await until(() => page.posts().length === 3, "R-2 is sent again");
  assert.deepEqual(plain(page.posts()[2].body), { workspaceId: "ws", text: "Make the backup faster please", clientMessageId: "m2" });
  assert.deepEqual(page.errors, []);
});

test("what is said goes as a request or a follow-up; unconfirmed words go again as they were", async (t) => {
  const page = await talk({ fail: 1 });
  t.after(page.close);
  const send = () => page.document.querySelector(".project-talk-send");
  assert.ok(send().disabled, "nothing to send yet");
  // A new request, which fails to get an answer: kept, and sent again under the same ID.
  setComposerText(page.field(), "  Add a dark mode  ");
  await tick();
  send().click();
  await until(() => page.document.querySelector('.project-talk-compose [role="alert"]'), "the failure is shown");
  assert.match(page.document.querySelector(".project-talk-compose").textContent, /No answer from Core yet/);
  send().click();
  await until(() => page.posts().length === 2, "sent again");
  const [first, retry] = page.posts();
  assert.match(first.url, /\/api\/projects\/p1\/requests$/);
  assert.deepEqual(Object.keys(first.body).sort(), ["clientMessageId", "text", "workspaceId"]);
  assert.equal(first.body.text, "Add a dark mode", "trimmed, as replies are");
  assert.equal(first.body.workspaceId, "ws");
  assert.equal(retry.body.clientMessageId, first.body.clientMessageId, "the same message, never a second one");
  await until(() => !page.document.querySelector(".project-talk-compose [role=alert]") && !composerText(page.field()), "sent and emptied");
  assert.equal(page.window.localStorage.getItem("yuzuno.project-talk-outbox.v1"), null, "Core keeps it now");

  // A follow-up: quoted, sent to that request; Esc would let it go, × too.
  page.window.renderTalk({ command: { kind: "follow", n: 3, seq: 1 } });
  await until(() => page.document.querySelector(".project-talk-quoting"), "quoted");
  setComposerText(page.field(), "And the phone");
  await tick();
  send().click();
  await until(() => page.posts().length === 3, "the follow-up is sent");
  assert.match(page.posts()[2].url, /\/api\/projects\/p1\/requests\/3\/replies$/);
  assert.equal(page.posts()[2].body.text, "And the phone");
  await until(() => !page.document.querySelector(".project-talk-quoting"), "no longer quoting");

  // R-2 did not reach the front desk: sent again from its words, as Core keeps it.
  page.button("Send again", page.words(2)).click();
  await until(() => page.posts().length === 4, "R-2 is sent again");
  assert.deepEqual(plain(page.posts()[3].body), { workspaceId: "ws", text: "Make the backup faster please", clientMessageId: "m2" });
  assert.deepEqual(page.errors, []);
});

test("past the limit, nothing is sent and the words are kept", async (t) => {
  const page = await talk();
  t.after(page.close);
  setComposerText(page.field(), "长".repeat(30_667));
  await tick();
  assert.match(page.document.querySelector(".home-reply-length").textContent, /too long to send/);
  assert.ok(page.document.querySelector(".project-talk-send").disabled);
  page.document.querySelector(".project-talk-compose").requestSubmit();
  await tick();
  assert.equal(page.posts().length, 0);
  const kept = JSON.parse(page.window.localStorage.getItem("yuzuno.project-talk-drafts.v1"));
  assert.equal(Object.values(kept)[0].text.length, 30_667);
  assert.deepEqual(page.errors, []);
});

test("with several leads and no front desk, it says so under the field and links to the settings", async (t) => {
  const page = await talk({ front: { version: 2, agentId: null, effectiveAgentId: null } });
  t.after(page.close);
  page.window.renderTalk({ leadCount: 2 });
  await tick();
  assert.match(page.document.querySelector(".project-talk-compose .project-talk-hint[data-missing]").textContent, /^Choose a front desk first/);
  assert.equal(page.document.querySelector(".project-talk-compose .home-composer").dataset.readonly, "");
  page.button("Choose in settings").click();
  assert.deepEqual(plain(page.window.navigated), [{ kind: "projectSettings", projectId: "p1" }]);
  assert.deepEqual(page.errors, []);
});

test("in Chinese", async (t) => {
  const page = await talk({ lang: "zh" });
  t.after(page.close);
  assert.equal(page.document.querySelector('[data-reply="3:1"] .project-talk-receipt').textContent, "已转给 YN-91 · Design、Dev Lead");
  assert.ok(page.button("更早的对话 3 条"));
  assert.ok(page.button("请求 →"));
  assert.equal(page.document.querySelector(".project-talk-hint").textContent, "项目（前台 Dev Lead）会转给合适的负责人或新开卡片，你的原话原样带过去");
  assert.deepEqual(page.errors, []);
});

test("a Project's front desk is chosen among its saved leads, saved at once against the version read", async (t) => {
  const page = mount({ front: { version: 2, agentId: null, effectiveAgentId: null } });
  t.after(page.close);
  page.window.renderMembers({ project: { id: "p1", name: "Atlas" }, agents, projects: [{ id: "p1", name: "Atlas" }], disabled: false, onChanged: () => {} });
  const choices = await until(() => {
    const found = [...page.document.querySelectorAll(".project-front-desk input[type=radio]")];
    return found.length ? found : null;
  }, "the front desk choices");
  assert.deepEqual(choices.map((input) => input.value), ["d", "e"], "the open leads, not the executor");
  assert.ok(choices.every((input) => !input.checked));
  assert.match(page.document.querySelector(".project-front-desk").textContent, /No front desk yet/);
  choices[1].click();
  await until(() => page.calls.some((c) => c.method === "PUT"), "the choice is saved");
  assert.deepEqual(plain(page.calls.find((c) => c.method === "PUT").body), { expectedVersion: 2, agentId: "e" });
  await until(() => page.document.querySelector('.project-front-desk input[value="e"]').checked, "e is the front desk");
  assert.match(page.document.querySelector(".project-front-desk").textContent, /Chosen as the front desk/);
  assert.deepEqual(page.errors, []);
});

// YN-226: what the user sends lands once, as soon as Core's answer or a read of the requests has it.
const gate = () => {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
};
const requestReads = (page) => page.calls.filter((c) => c.method === "GET" && /\/requests$/.test(c.url)).length;
const count = (list, n) => list.filter((x) => x === n).length;

test("a new request lands once, drawn from Core's answer at once; a read that does not list it yet keeps it", async (t) => {
  const page = await talk({}, { mode: "requests" });
  t.after(page.close);
  page.state.full = true;
  setComposerText(page.field(), "Add a dark mode");
  await tick();
  const reads = requestReads(page);
  page.document.querySelector(".project-talk-send").click();
  await until(() => page.window.arrivals.length, "it lands");
  assert.deepEqual(plain(page.window.arrivals), [{ kind: "request", n: 5, seq: 1, fresh: true, delivered: true }]);
  await until(() => page.window.read?.[0] === 5, "drawn from Core's answer");
  // The read after the send does not list R-5 yet (it started before Core kept it here): R-5 stays.
  await until(() => requestReads(page) > reads, "read again");
  await tick();
  assert.deepEqual(plain(page.window.read), [5, 4, 3, 2, 1]);
  assert.equal(composerText(page.field()), "", "the words went");
  assert.equal(page.document.querySelector(".project-talk-compose").dataset.state, "idle");
  // Listed from now on; Home's reads read it again: one R-5, told once.
  page.state.requests = [page.state.made, ...page.state.requests];
  page.window.renderTalk({ mode: "requests", revision: 1 });
  await until(() => requestReads(page) > reads + 1, "Home's read");
  await tick();
  assert.equal(count(plain(page.window.read), 5), 1);
  assert.equal(page.window.arrivals.length, 1, "a read tells nothing");
  assert.deepEqual(page.errors, []);
});

test("while the words go, the field takes more, at its contrast; what the user wrote or chose meanwhile stays", async (t) => {
  const page = await talk({}, { mode: "requests" });
  t.after(page.close);
  const hold = gate();
  Object.assign(page.state, { full: true, hold: hold.promise });
  setComposerText(page.field(), "Add a dark mode");
  await tick();
  page.document.querySelector(".project-talk-send").click();
  const form = () => page.document.querySelector(".project-talk-compose");
  await until(() => form().dataset.state === "sending", "going");
  const status = form().querySelector('.project-talk-arrival[role="status"]');
  assert.ok(status.hasAttribute("data-sending"), "said, for reduced motion, where the spinner stands still");
  assert.equal(status.textContent, "Sending…");
  assert.equal(form().querySelector(".project-talk-send").getAttribute("aria-busy"), "true");
  assert.doesNotMatch(form().textContent, /No answer from Core yet/, "not while it goes");
  assert.equal(form().querySelector(".home-composer").dataset.readonly, undefined, "the field takes more");
  // More words after them, and another request to follow up.
  setComposerText(page.field(), "Add a dark mode and a light one");
  page.window.renderTalk({ mode: "requests", command: { kind: "follow", n: 3, seq: 1 } });
  await until(() => page.document.querySelector(".project-talk-quoting"), "R-3 chosen meanwhile");
  assert.equal(page.window.arrivals.length, 0, "nothing lands before Core answers");
  hold.open();
  await until(() => page.window.arrivals.length, "it lands");
  await tick();
  assert.equal(composerText(page.field()), "and a light one", "the words sent leave; those written after them stay");
  assert.ok(page.document.querySelector(".project-talk-quoting"), "R-3 is still the one followed up");
  const kept = JSON.parse(page.window.localStorage.getItem("yuzuno.project-talk-drafts.v1"));
  assert.deepEqual([Object.values(kept)[0].text, Object.values(kept)[0].quote], ["and a light one", 3]);
  assert.equal(page.posts()[0].body.text, "Add a dark mode", "only what was there when it went");
  // A press of Send leaves the focus in the field: a phone's keyboard stays up.
  const press = new page.window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  page.document.querySelector(".project-talk-send").dispatchEvent(press);
  assert.ok(press.defaultPrevented);
  assert.deepEqual(page.errors, []);
});

test("a read that lists the request before Core's answer tells it; the answer then tells nothing more", async (t) => {
  const page = await talk({}, { mode: "requests" });
  t.after(page.close);
  const hold = gate();
  Object.assign(page.state, { full: true, hold: hold.promise, listOnPost: true });
  setComposerText(page.field(), "Add a dark mode");
  await tick();
  page.document.querySelector(".project-talk-send").click();
  await until(() => page.state.made, "Core keeps it");
  // Home reads again (Core said the project changed) before the answer comes.
  page.window.renderTalk({ mode: "requests", revision: 1 });
  await until(() => page.window.arrivals.length, "it lands from the read");
  assert.deepEqual(plain(page.window.arrivals), [{ kind: "request", n: 5, seq: 1, fresh: true, delivered: true }]);
  assert.equal(page.document.querySelector(".project-talk-compose").dataset.state, "sending", "the answer is still to come");
  hold.open();
  await until(() => page.document.querySelector(".project-talk-compose").dataset.state === "idle", "answered");
  await tick(80);
  assert.equal(page.window.arrivals.length, 1, "once");
  assert.equal(count(plain(page.window.read), 5), 1);
  assert.deepEqual(page.errors, []);
});

test("an answer without the whole request goes the reading way; a send that fails tells nothing, its retry once", async (t) => {
  const page = await talk({ fail: 1 }, { mode: "requests" });
  t.after(page.close);
  page.state.listOnPost = true;
  setComposerText(page.field(), "Add a dark mode");
  await tick();
  const send = () => page.document.querySelector(".project-talk-send");
  send().click();
  await until(() => page.document.querySelector('.project-talk-compose [role="alert"]'), "the failure is shown");
  assert.equal(page.window.arrivals.length, 0, "nothing lands");
  assert.equal(composerText(page.field()), "Add a dark mode", "the draft stays");
  // Sent again under the same ID; Core answers with its number only (state.full unset): the read has it.
  send().click();
  await until(() => page.window.arrivals.length, "it lands from the read");
  assert.equal(page.posts()[1].body.clientMessageId, page.posts()[0].body.clientMessageId);
  assert.deepEqual(plain(page.window.arrivals), [{ kind: "request", n: 5, seq: 1, fresh: true, delivered: true }]);
  assert.equal(count(plain(page.window.read), 5), 1);
  assert.deepEqual(page.errors, []);
});

test("a follow-up lands on its request; a request Core kept but did not deliver says so", async (t) => {
  const page = await talk({}, { mode: "requests" });
  t.after(page.close);
  page.window.renderTalk({ mode: "requests", command: { kind: "follow", n: 3, seq: 1 } });
  await until(() => page.document.querySelector(".project-talk-quoting"), "quoted");
  setComposerText(page.field(), "And the phone");
  await tick();
  page.document.querySelector(".project-talk-send").click();
  await until(() => page.window.arrivals.length, "it lands");
  assert.deepEqual(plain(page.window.arrivals), [{ kind: "follow", n: 3, seq: 1, fresh: false, delivered: true }]);
  Object.assign(page.state, { full: true, delivery: "uncertain" });
  setComposerText(page.field(), "Make the export faster");
  await tick();
  page.document.querySelector(".project-talk-send").click();
  await until(() => page.window.arrivals.length === 2, "it lands");
  assert.deepEqual(plain(page.window.arrivals[1]), { kind: "request", n: 5, seq: 2, fresh: true, delivered: false });
  assert.deepEqual(page.errors, []);
});

test("the notice above the field says where it went, shows its request on Show and takes no focus", async (t) => {
  const page = await talk({}, { mode: "requests" });
  t.after(page.close);
  const notice = () => page.document.querySelector(".project-talk-notice");
  page.window.renderTalk({ mode: "requests", notice: { kind: "request", n: 5, seq: 1, fresh: true, delivered: true } });
  await tick();
  assert.equal(notice().closest('[role="status"]').className, "project-talk-arrival");
  assert.equal(notice().querySelector(".project-talk-notice-text").textContent, "Recorded as R-5");
  assert.equal(notice().dataset.tone, undefined);
  assert.ok(!notice().contains(page.document.activeElement), "no focus taken");
  const show = page.button("Show", notice());
  assert.equal(show.getAttribute("aria-label"), "Show request R-5");
  show.click();
  assert.deepEqual(plain(page.window.shownRequests), [5]);
  assert.equal(page.window.dismissed, 1);
  page.window.renderTalk({ mode: "requests", notice: { kind: "request", n: 5, seq: 2, fresh: true, delivered: false } });
  await tick();
  assert.equal(notice().querySelector(".project-talk-notice-text").textContent, "Recorded as R-5 · not confirmed delivered");
  assert.equal(notice().dataset.tone, "attention");
  page.window.renderTalk({ mode: "requests", notice: { kind: "follow", n: 3, seq: 3, fresh: false, delivered: true } });
  await tick();
  assert.equal(notice().querySelector(".project-talk-notice-text").textContent, "Added to R-3");
  page.button("Dismiss", notice()).click();
  assert.equal(page.window.dismissed, 2);
  // A new send closes it.
  setComposerText(page.field(), "Add a dark mode");
  await tick();
  page.document.querySelector(".project-talk-send").click();
  assert.equal(page.window.dismissed, 3);
  assert.deepEqual(page.errors, []);
});

test("the notice in Chinese", async (t) => {
  const page = await talk({ lang: "zh" }, { mode: "requests" });
  t.after(page.close);
  page.window.renderTalk({ mode: "requests", notice: { kind: "request", n: 5, seq: 1, fresh: true, delivered: false } });
  await tick();
  const notice = page.document.querySelector(".project-talk-notice");
  assert.equal(notice.querySelector(".project-talk-notice-text").textContent, "已记下为 R-5 · 没确认送达");
  assert.equal(page.button("查看", notice).getAttribute("aria-label"), "查看请求 R-5");
  assert.ok(page.button("关闭", notice));
  page.window.renderTalk({ mode: "requests", notice: { kind: "follow", n: 3, seq: 2, fresh: false, delivered: true } });
  await tick();
  assert.equal(page.document.querySelector(".project-talk-notice-text").textContent, "已追加到 R-3");
  assert.deepEqual(page.errors, []);
});
