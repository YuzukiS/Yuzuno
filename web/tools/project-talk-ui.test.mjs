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

// YN-86 S3b: "Talk to the project" on a Project's page. The requests on one
// side (the project's titles, never the user's words), the conversation on
// the other (the words, the project's short replies, follow-ups, Core's
// lines), linked by selection; one switch shows either side or both, kept
// per project on this device, two tabs where the page is narrow; what is
// said goes to Core as a request or a follow-up, sent again as it was. And
// the front desk chosen among the leads in a Project's settings. The real
// components with a stand-in Core; synthetic data only.
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
window.shownCards=[];
window.renderTalk=(props={})=>flushSync(()=>root.render(<CardAgents.Provider value={new Map(window.agents.map((a)=>[a.id,a]))}><ProjectTalk projectId="p1" projectName="Atlas" workspaceId="ws" readOnly={false} revision={0} leadCount={1} onCard={(key)=>window.shownCards.push(key)} onNavigate={(target)=>window.navigated.push(target)} {...props}/></CardAgents.Provider>));
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
const requests = (t39 = ago(39)) => [
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
    messageId: "m1", delivery: "accepted", replies: [], notes: [{ note: "Same thing as the export card", by: desk, at: ago(119) }],
    routes: [{ kind: "existing", index: 0, request: 1, at: ago(119), state: "done", why: "The same thing as the earlier request", by: desk,
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
    const receipt = { input: { text: call.body?.text, clientMessageId: call.body?.clientMessageId }, status: "accepted", turnId: "t1", error: null };
    if (method === "POST" && call.url.endsWith("/replies")) return answer({ reply: { n: 2 }, receipts: [receipt] });
    if (method === "POST" && call.url.endsWith("/requests")) return answer({ request: { n: 5 }, receipt });
    return answer({});
  };
  window.eval(bundle);
  const document = window.document;
  const talk = () => document.querySelector(".project-talk");
  const side = (name) => document.querySelector(`.project-talk-${name}`);
  const tabs = () => [...document.querySelectorAll('.project-talk-tabs [role="tab"]')];
  const tab = (label) => tabs().find((b) => b.textContent.trim().startsWith(label));
  const request = (n) => document.querySelector(`.request-card[data-request="${n}"]`);
  const words = (n) => document.querySelector(`.project-talk-mine[data-words="${n}"]`);
  const button = (label, scope = document) =>
    [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
  const field = () => document.querySelector(".project-talk-field [data-composer-input]");
  const posts = () => calls.filter((c) => c.method !== "GET");
  return { window, document, errors, calls, state, talk, side, tabs, tab, request, words, button, field, posts, close: () => window.close() };
}

async function talk(options) {
  const page = mount(options);
  page.window.renderTalk();
  await until(() => page.request(3), "the requests are read");
  await tick();
  return page;
}

test("wide, both sides show by default; a side chosen fills the width, the other inert, kept for the project", async (t) => {
  const page = await talk();
  t.after(page.close);
  assert.equal(page.talk().dataset.view, "both");
  assert.deepEqual(page.tabs().map((b) => b.textContent.trim()), ["Requests 4", "Both", "Conversation"]);
  assert.equal(page.tab("Both").getAttribute("aria-selected"), "true");
  assert.ok(!page.side("requests").hasAttribute("inert") && !page.side("chat").hasAttribute("inert"), "both sides take part");
  assert.ok(!page.side("chat").dataset.motion, "nothing moves as the page opens");

  page.tab("Requests").click();
  await tick();
  assert.equal(page.talk().dataset.view, "requests");
  assert.ok(page.side("chat").hasAttribute("inert"), "the closed side is inert");
  assert.ok(!page.side("requests").hasAttribute("inert"));
  assert.equal(page.side("chat").dataset.motion, "out", "the conversation leaves as its column closes");
  assert.equal(page.window.localStorage.getItem("yuzuno.projectTalkView.ws.p1"), JSON.stringify("requests"), "kept on this device for p1");

  page.tab("Conversation").click();
  await tick();
  assert.equal(page.talk().dataset.view, "chat");
  assert.ok(page.side("requests").hasAttribute("inert"));
  assert.equal(page.side("chat").dataset.motion, "in", "the conversation comes in from its side");
  assert.equal(page.side("requests").dataset.motion, "out");

  // The keyboard moves along the tabs, as tabs do.
  page.tab("Conversation").dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await tick();
  assert.equal(page.talk().dataset.view, "both");
  assert.equal(page.document.activeElement, page.tab("Both"));
  assert.equal(page.side("requests").dataset.motion, "in");

  // Another visit to the project shows what was chosen; another project shows both.
  page.tab("Conversation").click();
  await tick();
  const again = await talk({ storage: { "yuzuno.projectTalkView.ws.p1": JSON.stringify("chat") } });
  t.after(again.close);
  assert.equal(again.talk().dataset.view, "chat");
  const other = mount({ storage: { "yuzuno.projectTalkView.ws.p1": JSON.stringify("chat") } });
  t.after(other.close);
  other.window.renderTalk({ projectId: "p2" });
  await until(() => other.talk(), "the other project's talk");
  assert.equal(other.talk().dataset.view, "both");
  assert.deepEqual(page.errors, []);
});

test("narrow, two tabs and the requests first; a tab switches in place", async (t) => {
  const page = await talk({ width: 600, storage: { "yuzuno.projectTalkView.ws.p1": JSON.stringify("both") } });
  t.after(page.close);
  assert.deepEqual(page.tabs().map((b) => b.textContent.trim()), ["Requests 4", "Conversation"]);
  assert.equal(page.talk().dataset.view, "requests", "both, where they do not fit, is the requests");
  assert.ok(page.side("chat").hasAttribute("inert"));
  page.tab("Conversation").click();
  await tick();
  assert.equal(page.talk().dataset.view, "chat");
  assert.equal(page.side("chat").dataset.motion, "switch");
  assert.ok(!page.side("requests").dataset.motion, "the side going away just goes");
  assert.deepEqual(page.errors, []);
});

test("the requests show the project's titles, states, cards and handoffs; never the user's words", async (t) => {
  const page = await talk();
  t.after(page.close);
  const three = page.request(3);
  assert.equal(three.querySelector(".request-card-title span").textContent, "Settings page layout");
  assert.equal(three.querySelector(".request-card-state").textContent, "In progress");
  assert.equal(three.querySelector(".request-card-count").textContent, "2 cards · 0/2 done");
  const rows = [...three.querySelectorAll(".request-card-row")];
  assert.deepEqual(rows.map((r) => r.querySelector(".request-card-row-title").textContent), ["Settings layout", "Casual copy"]);
  assert.deepEqual(rows.map((r) => r.querySelector(".request-card-row-who").textContent), ["YN-91 · Design", "Dev Lead"]);
  rows[0].click();
  assert.deepEqual(plain(page.window.shownCards), ["yn-91"], "a card's row shows that card on the page");

  const four = page.request(4);
  assert.equal(four.querySelector(".request-card-title").dataset.untitled, "");
  assert.equal(four.querySelector(".request-card-title span").textContent, "Waiting for a title · A long line of paste…");
  assert.equal(four.querySelector(".request-card-state").textContent, "Waiting for the front desk");
  assert.equal(four.querySelector(".request-card-wait").textContent, "The project is looking at it; no card yet.");

  const two = page.request(2);
  assert.equal(two.querySelector(".request-card-state").textContent, "Not confirmed delivered");
  assert.ok(page.button("Send again", two), "it can be sent again");

  // Done ones are folded apart; a joined request says where it went.
  const fold = page.document.querySelector(".project-talk-done");
  assert.equal(fold.querySelector("summary").textContent, "Done 1");
  assert.equal(fold.open, false);
  assert.ok(fold.contains(page.request(1)));
  assert.equal(page.request(1).querySelector(".request-card-merged").textContent, "Joined “Export research”");
  assert.equal(page.document.querySelector(".project-talk-requests-title span").textContent, "3 in progress");

  // The handoffs are folded until asked for: who did what, to whom, why below.
  const trail = page.button("Handoffs 3", three);
  assert.equal(trail.getAttribute("aria-expanded"), "false");
  assert.ok(!three.querySelector(".routing-events"));
  trail.click();
  await tick();
  const events = [...three.querySelectorAll(".routing-event")];
  assert.deepEqual(events.map((e) => e.dataset.kind), ["card", "card", "note"]);
  assert.equal(events[0].querySelector(".routing-event-text").textContent, "Project opened the card “Settings layout” → YN-91 · DesignA design with an end");
  assert.equal(events[2].querySelector(".routing-event-text").textContent, "Project: OK, split into two cards");
  page.button("Open card", events[0]).click();
  assert.deepEqual(plain(page.window.shownCards), ["yn-91", "yn-91"]);
  page.button("Handoffs 3", page.request(1)).click();
  await tick();
  assert.match(page.request(1).querySelector('.routing-event[data-kind="existing"]').textContent, /Project added this to the card “Export research” → YN-91 · Design/);
  assert.match(page.request(1).querySelector('.routing-event[data-kind="done"]').textContent, /All done/);
  assert.equal(page.button("See archive", page.request(1))?.textContent, "See archive", "a card no longer live is in the archive");

  // The user's words are nowhere in the requests.
  const list = page.side("requests").textContent;
  for (const said of ["Rework the settings page", "Make the backup faster", "Compare export formats"]) assert.ok(!list.includes(said), said);
  assert.deepEqual(page.errors, []);
});

test("the conversation has each request's words once, the project's short replies, follow-ups and Core's lines", async (t) => {
  const page = await talk();
  t.after(page.close);
  const chat = page.side("chat");
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

test("selection links the sides: a request's title shows its words, a reply's Request → its request", async (t) => {
  const page = await talk();
  t.after(page.close);
  const note = [...page.side("chat").querySelectorAll(".project-talk-project")].find((li) => li.textContent.includes("OK, split"));
  page.button("Request →", note).click();
  await tick();
  assert.equal(page.request(3).dataset.selected, "", "the request is selected");
  assert.equal(page.document.activeElement, page.request(3));
  // With only the conversation shown, Request → goes over to the requests.
  page.tab("Conversation").click();
  await tick();
  page.button("Answer", page.side("chat")).click();
  await tick();
  assert.equal(page.talk().dataset.view, "requests");
  assert.equal(page.request(3).dataset.selected, "");
  // A title shows its words: over to the conversation, the earlier part opened when they are in it.
  page.request(1).querySelector(".request-card-title").click();
  await tick();
  assert.equal(page.talk().dataset.view, "chat");
  assert.ok(page.words(1), "the earlier conversation is open");
  assert.equal(page.document.activeElement, page.words(1));
  assert.equal(page.request(1).dataset.selected, "");
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

  // A follow-up: quoted, sent to that request.
  page.button("Follow up “Settings page layout”").click();
  await tick();
  assert.equal(page.document.querySelector(".project-talk-quoting span").textContent, "Follow-up to “Settings page layout”");
  setComposerText(page.field(), "And the phone");
  await tick();
  send().click();
  await until(() => page.posts().length === 3, "the follow-up is sent");
  assert.match(page.posts()[2].url, /\/api\/projects\/p1\/requests\/3\/replies$/);
  assert.equal(page.posts()[2].body.text, "And the phone");
  await until(() => !page.document.querySelector(".project-talk-quoting"), "no longer quoting");

  // R-2 did not reach the front desk: sent again as Core keeps it.
  page.button("Send again", page.request(2)).click();
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

test("with several leads and no front desk, it says so and links to the settings", async (t) => {
  const page = await talk({ front: { version: 2, agentId: null, effectiveAgentId: null } });
  t.after(page.close);
  page.window.renderTalk({ leadCount: 2 });
  await tick();
  assert.match(page.document.querySelector(".project-talk-desk").textContent, /^Choose a front desk first/);
  assert.equal(page.document.querySelector(".project-talk-compose .home-composer").dataset.readonly, "");
  page.button("Choose in settings").click();
  assert.deepEqual(plain(page.window.navigated), [{ kind: "projectSettings", projectId: "p1" }]);
  assert.deepEqual(page.errors, []);
});

test("in Chinese", async (t) => {
  const page = await talk({ lang: "zh" });
  t.after(page.close);
  assert.deepEqual(page.tabs().map((b) => b.textContent.trim()), ["需求单 4", "两者", "对话"]);
  assert.equal(page.document.querySelector(".project-talk-head h2").textContent, "对项目说");
  assert.equal(page.document.querySelector(".project-talk-desk").textContent, "项目由 Dev Lead 兼任前台");
  assert.equal(page.request(3).querySelector(".request-card-state").textContent, "进行中");
  assert.equal(page.request(3).querySelector(".request-card-count").textContent, "2 张卡 · 已完成 0/2");
  assert.equal(page.request(4).querySelector(".request-card-title span").textContent, "等项目起标题 · A long line of paste…");
  assert.equal(page.document.querySelector('[data-reply="3:1"] .project-talk-receipt').textContent, "已转给 YN-91 · Design、Dev Lead");
  assert.ok(page.button("更早的对话 3 条"));
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
