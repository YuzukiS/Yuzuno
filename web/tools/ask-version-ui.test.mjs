import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// A reply to an ask names the version of the ask it answers and the
// Workspace that page showed (T-9): every way of answering (an option, a
// choice, a form, free text) sends `askVersion` and `workspaceId`, never a
// card's `version`. It always answers the latest version (YN-38): the one on
// screen, and when Core refuses that because it has a newer one, Home reads
// the ask again and the reply goes there, as long as it answers the same
// thing there; words always do. Answers begun on an earlier version are
// carried to the latest by field and option ID, never to an option the user
// did not pick, and the form says what changed. A retry of a send not
// confirmed goes again exactly as it was. The real AskReply, with Core
// answered here.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "ask-version-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {AskReply} from ${JSON.stringify(path.join(root, "src/home/AskReply.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderAsk=(props)=>flushSync(()=>root.render(<AskReply {...props}/>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "AskVersion", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const agents = [
  { id: "mori", name: "Mori", harness: "codex", status: "idle", cwd: "/fixture", model: "", color: "sage",
    createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" },
];
const form = {
  id: "plan", title: "Which parts ship first?",
  fields: [{ id: "part", type: "single", label: "First part", required: false,
    options: [{ id: "ui", label: "The UI" }, { id: "core", label: "Core" }] }],
};
const everything = {
  options: [{ id: "ship", label: "Ship today" }, { id: "wait", label: "Wait" }],
  choice: { a: { id: "plan-a", label: "Plan A" }, b: { id: "plan-b", label: "Plan B" } },
  form,
};
/** An ask as Core sends it, at `version`. */
const section = (key, version, reply = everything, ask = {}) => ({
  key, kind: "ask", title: "Which plan?", version,
  owner: { agentId: "mori", name: "Mori", state: "active" },
  updatedAt: new Date().toISOString(), updatedTurnId: null, attachments: [], refs: {}, seen: null, history: false,
  body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: [] } } },
  ask: { question: "Which plan should we take?", state: "open", reply, ...ask },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const accepted = (body) => ({ status: 200, body: { input: { text: body.text, clientMessageId: body.clientMessageId },
  status: "accepted", turnId: "mori-t2", error: null } });
// Core's refusal before anything is sent (project_brief/home.rs).
const refused = (message) => ({ status: 409, body: { error: message, code: "message_not_submitted" } });

/**
 * Core as these cases need it: it delivers a client id once, and a retry of
 * one it has returns the same receipt even if the ask changed since
 * (project_brief/home.rs). `lose(taken)`: the next answer is lost, after
 * Core took the reply or before it. `refuse(body)`: why Core refuses a reply
 * it does not have yet, or nothing.
 */
function core(refuse = () => null) {
  const delivered = new Map();
  const lost = [];
  return {
    delivered,
    lose: (taken) => lost.push(taken),
    answer(body) {
      if (lost.length && !lost[0]) { lost.shift(); throw new TypeError("Failed to fetch"); }
      if (!delivered.has(body.clientMessageId)) {
        const why = refuse(body);
        if (why) return refused(why);
        delivered.set(body.clientMessageId, body);
      }
      if (lost.length) { lost.shift(); throw new TypeError("Failed to fetch"); }
      return accepted(body);
    },
  };
}

/** `answer(body)`: what Core answers a reply; a thrown error is a lost connection.
 * `box.asks`: the sections Core's Home read has now, by key (YN-38). */
function mount(answer = accepted) {
  const errors = [];
  const posts = [];
  let ids = 0;
  const box = { answer, sent: 0, asks: {} };
  let window;
  let document;
  // A new page, with what the one before kept in this browser.
  function open(kept = {}) {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (error) => errors.push(error.message));
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: "https://ask.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
    });
    window = dom.window;
    document = window.document;
    for (const [name, value] of Object.entries(kept)) window.localStorage.setItem(name, value);
    window.crypto.randomUUID = () => `client-${++ids}`;
    // A form copies its answers on submit (clarification-ui.test.mjs does the same).
    window.structuredClone = structuredClone;
    window.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      posts.push({ url: String(url), method: init.method || "GET", body });
      if (String(url).endsWith("/api/home")) {
        const home = { projects: [{ project: { id: "p1", name: "P1" }, brief: { version: 1, history: [], sections: Object.values(box.asks) } }] };
        return { ok: true, status: 200, json: async () => home, text: async () => JSON.stringify(home) };
      }
      const { status, body: reply } = await box.answer(body);
      return { ok: status < 400, status, json: async () => reply, text: async () => JSON.stringify(reply) };
    };
    window.eval(bundle);
  }
  open();
  const reload = () => {
    const kept = Object.fromEntries(Object.keys(window.localStorage).map((name) => [name, window.localStorage.getItem(name)]));
    window.close();
    open(kept);
  };
  const outbox = () => Object.values(JSON.parse(window.localStorage.getItem("yuzuno.home-outbox.v1") || "{}"));
  const render = (sectionValue, extra = {}) =>
    // One reply box per section, as SectionCard keys it.
    window.renderAsk({
      key: sectionValue.key, section: sectionValue, projectId: "p1", workspaceId: "ws-1", agents, readOnly: false,
      onSent: () => { box.sent++; }, ...extra,
    });
  const field = () => document.querySelector(".home-text-reply textarea");
  const sendButton = () => document.querySelector(".home-text-reply button[type=submit]");
  const type = async (text) => {
    const area = field();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(area, text);
    area.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  };
  const button = (text) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  const replies = () => posts.filter((post) => post.method === "POST" && /\/brief\/reply$/.test(post.url)).map((post) => post.body);
  const notes = () => [...document.querySelectorAll(".home-note, .inline-error")].map((n) => n.textContent);
  /** Home's reads of the asks (YN-38: only after Core refused a reply because the ask moved on). */
  const homeReads = () => posts.filter((post) => post.url.endsWith("/api/home")).length;
  return {
    get window() { return window; }, get document() { return document; },
    errors, posts, replies, render, field, sendButton, type, button, notes, box, reload, outbox, homeReads, close: () => window.close(),
  };
}

test("every way of answering an ask names the version answered and the Workspace, never a card's version", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render(section("opt", 4));
  page.button("Ship today").click();
  await tick();
  page.render(section("pick", 4));
  page.document.querySelectorAll(".home-choice button")[1].click();
  await tick();
  page.render(section("form", 4), { workspaceId: "ws-2" });
  page.document.querySelector(".clarification footer .primary-button").click();
  await tick();
  page.render(section("words", 4));
  await page.type("Plan B, after the docs land.");
  page.sendButton().click();
  await tick();
  const sent = page.replies();
  assert.equal(sent.length, 4, JSON.stringify(page.posts));
  assert.deepEqual(sent.map((b) => [b.key, b.askVersion, b.workspaceId]),
    [["opt", 4, "ws-1"], ["pick", 4, "ws-1"], ["form", 4, "ws-2"], ["words", 4, "ws-1"]]);
  for (const body of sent) {
    assert.equal(body.version, undefined, "a card's version is not an ask's");
    assert.equal(body.title, undefined);
  }
  assert.equal(sent[0].choice, "ship");
  assert.equal(sent[1].choice, "plan-b");
  assert.match(sent[2].text, /Answers to “Which parts ship first\?”/);
  assert.equal(sent[3].text, "Plan B, after the docs land.");
  // A form's answers also go beside the text that says them (T-9), the same ids.
  assert.deepEqual(sent[2].form, { formId: "plan", answers: { part: "" } });
  assert.ok(sent[2].text.endsWith(`\n\n${JSON.stringify(sent[2].form)}`), sent[2].text);
  for (const body of [sent[0], sent[1], sent[3]]) assert.equal(body.form, undefined);
  assert.deepEqual(page.errors, []);
});

// One form reply both sides read (T-9): Core takes `sent` for this form and
// keeps `kept` of it (core/src/project_brief/tests.rs). Here, the real
// AskReply sends exactly `sent` for the form's defaults: long Chinese words,
// quotes and a backslash, optional answers left empty, several options in
// the order chosen.
const homeFormReply = JSON.parse(await readFile(new URL("./fixtures/home-form-reply.json", import.meta.url), "utf8"));

test("a form's answers go as the text Home writes of them with the same ids beside it, as Core takes them", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render(section("setup", 1, { form: homeFormReply.form }));
  page.document.querySelector(".clarification footer .primary-button").click();
  await tick();
  const sent = page.replies();
  assert.equal(sent.length, 1, JSON.stringify(page.posts));
  assert.equal(sent[0].text, homeFormReply.sent.text);
  assert.deepEqual(sent[0].form, homeFormReply.sent.form);
  assert.deepEqual(page.errors, []);
});

test("YN-38 words Core refuses because the ask moved on go to its latest version, read then, as a new message; no step, no other read", async (t) => {
  const page = mount((body) => body.askVersion === 2 ? refused("ask_changed: version 2 of the ask `plan` can't be answered now") : accepted(body));
  t.after(page.close);
  page.render(section("plan", 2));
  await page.type("Plan A, as discussed.");
  // Core already has version 3; this page has not read it yet.
  page.box.asks.plan = section("plan", 3, everything, { question: "Which plan should we take now?" });
  page.sendButton().click();
  await tick();
  const sent = page.replies();
  assert.equal(sent.length, 2, JSON.stringify(page.posts));
  assert.deepEqual(sent.map((b) => [b.askVersion, b.text]), [[2, "Plan A, as discussed."], [3, "Plan A, as discussed."]]);
  assert.notEqual(sent[1].clientMessageId, sent[0].clientMessageId, "Core never had the refused one: a new message");
  assert.equal(page.homeReads(), 1, "Home read the ask once, after the refusal");
  assert.ok(!page.notes().some((n) => /nothing was sent/.test(n)), JSON.stringify(page.notes()));
  assert.equal(page.outbox().length, 0);
  // Answered: the answer shows in place, and the draft is gone.
  assert.match(page.document.querySelector(".home-ask-replied")?.textContent ?? "", /Plan A, as discussed\./);
  assert.ok(!page.button("Refer it to version 3"));
  assert.deepEqual(page.errors, []);
});

test("YN-38 a pick Core refuses because the ask moved on goes to the latest only where it asks the same and offers the same option, worded the same", async (t) => {
  const cases = [
    // [what the latest version is, whether the pick goes there]
    ["the body changed, the question and options did not", (v) => section("opt", v), true],
    ["the option is worded otherwise", (v) => section("opt", v, { ...everything, options: [{ id: "ship", label: "Ship tomorrow" }, everything.options[1]] }), false],
    ["the option is gone", (v) => section("opt", v, { ...everything, options: [everything.options[1], { id: "hold", label: "Hold" }] }), false],
    ["the question changed", (v) => section("opt", v, everything, { question: "Ship the hotfix today?" }), false],
  ];
  for (const [how, latest, goes] of cases) {
    const page = mount((body) => body.askVersion === 2 ? refused("ask_changed: version 2 of the ask `opt` can't be answered now") : accepted(body));
    try {
      page.render(section("opt", 2));
      page.box.asks.opt = latest(3);
      page.button("Ship today").click();
      await tick();
      const sent = page.replies();
      assert.deepEqual(sent.map((b) => [b.askVersion, b.choice]), goes ? [[2, "ship"], [3, "ship"]] : [[2, "ship"]], `${how}: ${JSON.stringify(sent)}`);
      assert.equal(page.homeReads(), 1, how);
      if (!goes) {
        assert.ok(page.notes().some((n) => /The question changed before your reply was sent, so nothing was sent/.test(n)), `${how}: ${JSON.stringify(page.notes())}`);
        assert.equal(page.box.sent, 1, `${how}: Home reads the ask again, to show the latest`);
      }
      assert.deepEqual(page.errors, [], how);
    } finally {
      page.close();
    }
  }
});

// One reply, however it is given (an option, a choice, a form, free text):
// once sent, its version, client id and words are fixed. After an unknown
// outcome it goes again only as it was, from its own record and whatever the
// screen shows now, after the ask changed and after a reload too; nothing
// else is sent from that ask until then, and discarding it says it may have
// been delivered. Answers kept without the version they were begun on are
// never taken for the version shown (Lead 975, 1090; T-9 S2 R2–R4).

/** The way an unconfirmed reply goes again: exactly as it was sent. */
const sendAgainButton = (page) => page.button("Retry previous reply");
/** The unconfirmed reply's block: its whole text, and what it quotes as sent. */
const unconfirmedOf = (page) => {
  const box = page.document.querySelector(".home-ask-unconfirmed");
  return box ? { text: box.textContent, preview: box.querySelector("blockquote").textContent } : null;
};
/** The form's controls in `page`. */
const formOf = (page) => ({
  radio: (label) => [...page.document.querySelectorAll(".clarification label")].find((l) => l.textContent.includes(label)).querySelector("input"),
  submit: () => page.document.querySelector(".clarification footer .primary-button"),
  notes: () => [...page.document.querySelectorAll(".clarification-delivery")].map((n) => n.textContent),
  /** What the form says changed on the field labelled `label` (YN-38). */
  carried: (label) => {
    const field = [...page.document.querySelectorAll(".clarification-field")].find((f) => f.querySelector("legend").textContent.startsWith(label));
    return [...(field?.querySelectorAll(".clarification-carried p") ?? [])].map((n) => n.textContent);
  },
  /** What the form says about answers to fields it no longer asks. */
  gone: () => [...page.document.querySelectorAll(".clarification form > .clarification-carried")].map((n) => n.textContent),
  errors: () => [...page.document.querySelectorAll(".clarification-error")].map((n) => n.textContent),
});
/** Said above a form whose answers were given on an earlier version (YN-38). */
const carriedNote = (n) => /This ask is now version \d+\. Your answers are kept where they still fit/.test(n);
/** The same form ID, asking something else. */
const changedForm = {
  id: "plan", title: "Which part ships first now?",
  fields: [{ id: "part", type: "single", label: "First part to ship", required: false,
    options: [{ id: "ui", label: "The UI" }, { id: "core", label: "Core" }, { id: "docs", label: "The docs" }] }],
};
/** The same form ID, with `value` as its field's default. */
const defaulted = (value) => ({
  ...form,
  fields: [{ ...form.fields[0], default: { value, source: "The plan" } }],
});

test("a send not confirmed goes again exactly as it was, even after the ask is asked again; nothing else goes meanwhile", async (t) => {
  const c = core();
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  c.lose(true);
  page.render(section("plan", 2));
  await page.type("Ship on Friday.");
  page.sendButton().click();
  await tick();
  assert.equal(unconfirmedOf(page)?.preview, "Ship on Friday.");
  assert.match(unconfirmedOf(page).text, /Previous reply not confirmed yet.*Sent to version 2 of this ask\..*It may already have been delivered/);
  // The owner asked again meanwhile; the retry still answers version 2.
  page.render(section("plan", 3));
  assert.equal(page.sendButton().disabled, true, "nothing else is sent from here meanwhile");
  assert.equal(page.button("Ship today").disabled, true);
  sendAgainButton(page, 2).click();
  await tick();
  const [first, second] = page.replies();
  assert.deepEqual(second, first, "the same version, words and client id");
  assert.equal(c.delivered.size, 1);
  assert.equal(page.field().value, "", "the draft of those words was that reply");
  assert.deepEqual(page.errors, []);
});

test("a send not confirmed goes again as it was sent, trimmed, whatever spaces its draft keeps, after a reload too", async (t) => {
  const c = core();
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  c.lose(true);
  page.render(section("plan", 2));
  await page.type("  Ship on Friday.\n");
  page.sendButton().click();
  await tick();
  assert.equal(page.replies()[0].text, "Ship on Friday.");
  page.render(section("plan", 3));
  assert.ok(!page.notes().some((n) => /You began this reply on version/.test(n)), JSON.stringify(page.notes()));
  page.reload();
  page.render(section("plan", 3));
  assert.equal(page.field().value, "  Ship on Friday.\n", "the draft as written");
  sendAgainButton(page, 2).click();
  await tick();
  const [first, second] = page.replies();
  assert.deepEqual(second, first, "the same version, words and client id");
  assert.equal(page.field().value, "", "the draft of those words was that reply");
  assert.equal(c.delivered.size, 1);
  assert.deepEqual(page.errors, []);
});

test("① an option whose outcome is unknown goes again as it was after the ask changed and the page reloaded; Core delivers it once", async (t) => {
  const c = core();
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  c.lose(true);
  page.render(section("opt", 2));
  page.button("Ship today").click();
  await tick();
  page.render(section("opt", 3, everything, { question: "Ship on Monday instead?" }));
  page.reload();
  page.render(section("opt", 3, everything, { question: "Ship on Monday instead?" }));
  assert.equal(unconfirmedOf(page)?.preview, "Ship today", JSON.stringify(unconfirmedOf(page)));
  assert.equal(page.button("Ship today").disabled, true, "the same option is neither its retry nor a new reply meanwhile");
  sendAgainButton(page, 2).click();
  await tick();
  const [first, second] = page.replies();
  assert.deepEqual(second, first, "the same version, option and client id");
  assert.equal(c.delivered.size, 1, "Core delivered it once");
  assert.ok(page.notes().some((n) => /Your reply to version 2 of this ask was delivered before, so nothing more was sent\. Home shows version 3/.test(n)),
    JSON.stringify(page.notes()));
  // Answering version 3 is a new reply, given once the earlier one is settled.
  page.button("Ship today").click();
  await tick();
  const third = page.replies()[2];
  assert.deepEqual([third.choice, third.askVersion], ["ship", 3]);
  assert.notEqual(third.clientMessageId, first.clientMessageId);
  assert.equal(c.delivered.size, 2);
  assert.deepEqual(page.errors, []);
});

test("② a choice whose outcome is unknown goes again as it was after its labels changed, and Core refuses it there; the next one answers the new version", async (t) => {
  const c = core((body) => body.askVersion === 2 && "ask_changed: version 2 of the ask `pick` can't be answered now");
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  const planB = () => page.document.querySelectorAll(".home-choice button")[1];
  c.lose(false);
  page.render(section("pick", 2));
  planB().click();
  await tick();
  const changed = { ...everything, choice: { a: { id: "plan-a", label: "Plan A, now in one release" }, b: { id: "plan-b", label: "Plan B, now in two" } } };
  page.reload();
  page.render(section("pick", 3, changed));
  assert.equal(unconfirmedOf(page)?.preview, "I choose: Plan B", `shown as it went, not as the ask names it now: ${JSON.stringify(unconfirmedOf(page))}`);
  assert.equal(planB().disabled, true, "the same choice is neither its retry nor a new reply meanwhile");
  sendAgainButton(page, 2).click();
  await tick();
  const [first, second] = page.replies();
  assert.deepEqual(second, first, "the same version, choice and client id");
  assert.equal(c.delivered.size, 0, "nothing delivered");
  assert.ok(page.notes().some((n) => /The question changed before your reply was sent, so nothing was sent/.test(n)), JSON.stringify(page.notes()));
  assert.deepEqual(page.outbox(), [], "never submitted: no retry record");
  planB().click();
  await tick();
  const third = page.replies()[2];
  assert.deepEqual([third.choice, third.askVersion], ["plan-b", 3]);
  assert.notEqual(third.clientMessageId, first.clientMessageId);
  assert.equal(c.delivered.size, 1);
  assert.deepEqual(page.errors, []);
});

test("③ YN-38 answers begun on a form that keeps its ID but is worded otherwise are kept after a reload, said so, and go to the new version as they are", async (t) => {
  const c = core();
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  const f = formOf(page);
  page.render(section("form", 2, { form }));
  f.radio("Core").click();
  await tick();
  page.reload();
  page.render(section("form", 3, { form: changedForm }));
  assert.ok(page.notes().some(carriedNote), JSON.stringify(page.notes()));
  assert.deepEqual(f.carried("First part to ship"), ["Reworded after you answered. Check your answer."]);
  assert.equal(f.radio("Core").checked, true, "the answer stays: the same field and option");
  assert.equal(f.submit().disabled, false, "no step before it can be sent");
  assert.ok(!page.button("Refer it to version 3") && !page.button("Discard"));
  f.submit().click();
  await tick();
  const [sent] = page.replies();
  assert.equal(sent.askVersion, 3);
  assert.match(sent.text, /^Answers to “Which part ships first now\?”:\n- First part to ship: Core/);
  assert.deepEqual(sent.form, { formId: "plan", answers: { part: "core" } });
  assert.equal(c.delivered.size, 1);
  assert.ok(!page.notes().some(carriedNote), "said until sent");
  assert.deepEqual(page.errors, []);
});

/** The same form ID, required, before and after an option and a field go and a required field comes (YN-38). */
const strict = {
  id: "plan", title: "Which parts ship first?",
  fields: [
    { id: "part", type: "single", label: "First part", required: true,
      options: [{ id: "ui", label: "The UI" }, { id: "core", label: "Core" }] },
    { id: "when", type: "text", label: "When", required: false },
  ],
};
const strictLater = {
  id: "plan", title: "Which parts ship first?",
  fields: [
    { id: "part", type: "single", label: "First part", required: true,
      options: [{ id: "ui", label: "The UI" }, { id: "docs", label: "The docs" }] },
    { id: "owner", type: "single", label: "Who ships it", required: true,
      options: [{ id: "mori", label: "Mori" }, { id: "hana", label: "Hana" }] },
  ],
};

test("④ YN-38 a removed option leaves its field empty, never at another option, and says so on the field; a new required field and a field no longer asked are said too; the user answers and sends", async (t) => {
  const page = mount();
  t.after(page.close);
  const f = formOf(page);
  page.render(section("form", 2, { form: strict }));
  f.radio("Core").click();
  await tick();
  const when = page.document.querySelector(".clarification textarea");
  Object.getOwnPropertyDescriptor(page.window.HTMLTextAreaElement.prototype, "value").set.call(when, "Friday");
  when.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await tick();
  // The owner asks again in place, while the user is answering.
  page.render(section("form", 3, { form: strictLater }));
  await tick();
  assert.deepEqual(f.carried("First part"), ["No longer offered: “Core”. Choose again."]);
  assert.deepEqual(f.carried("Who ships it"), ["New since you began answering."]);
  assert.deepEqual(f.gone(), ["No longer asked: “When”. That answer won't be sent."]);
  assert.ok(page.notes().some(carriedNote), JSON.stringify(page.notes()));
  assert.ok(["The UI", "The docs"].every((label) => !f.radio(label).checked), "no option picked for the user");
  // Sent as it is: the form says what is missing, and nothing goes.
  f.submit().click();
  await tick();
  assert.equal(page.replies().length, 0, "nothing sent");
  assert.deepEqual(f.errors(), ["Choose an option.", "Choose an option."]);
  f.radio("The docs").click();
  await tick();
  assert.deepEqual(f.carried("First part"), [], "answered again: said no more");
  f.radio("Hana").click();
  await tick();
  f.submit().click();
  await tick();
  const [sent] = page.replies();
  assert.equal(sent.askVersion, 3);
  assert.deepEqual(sent.form, { formId: "plan", answers: { part: "docs", owner: "hana" } });
  assert.doesNotMatch(sent.text, /Friday|When/, "a field no longer asked sends nothing");
  assert.deepEqual(page.errors, []);
});

test("YN-38 a form's answers Core refuses because the ask moved on go to the latest only when it asks the same with the same form; otherwise they stay, carried, to be sent", async (t) => {
  const c = core((body) => body.askVersion === 2 && "ask_changed: version 2 of the ask `form` can't be answered now");
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  const f = formOf(page);
  // The same question and form: sent there as they are.
  page.render(section("same", 2, { form }));
  page.box.asks.same = section("same", 3, { form });
  f.radio("Core").click();
  await tick();
  f.submit().click();
  await tick();
  assert.deepEqual(page.replies().map((b) => [b.key, b.askVersion]), [["same", 2], ["same", 3]]);
  assert.equal(c.delivered.size, 1);
  // Another form: nothing more goes; the latest shows with the answers carried.
  page.render(section("other", 2, { form: strict }));
  page.box.asks.other = section("other", 3, { form: strictLater });
  f.radio("Core").click();
  await tick();
  f.submit().click();
  await tick();
  assert.deepEqual(page.replies().slice(2).map((b) => [b.key, b.askVersion]), [["other", 2]], "not sent to a form the user has not seen");
  assert.ok(page.notes().some((n) => /The question changed before your reply was sent, so nothing was sent/.test(n)), JSON.stringify(page.notes()));
  page.render(section("other", 3, { form: strictLater }));
  await tick();
  assert.deepEqual(f.carried("First part"), ["No longer offered: “Core”. Choose again."]);
  assert.equal(c.delivered.size, 1);
  assert.deepEqual(page.errors, []);
});

test("① a form whose outcome is unknown goes again as it was after its wording changed and the page reloaded; a new submit is no retry; Core delivers it once", async (t) => {
  const c = core();
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  const f = formOf(page);
  c.lose(true);
  page.render(section("form", 2, { form }));
  f.radio("The UI").click();
  await tick();
  f.submit().click();
  await tick();
  const [first] = page.replies();
  page.reload();
  page.render(section("form", 3, { form: changedForm }));
  // Whatever the form shows now, nothing mints a new id for that reply.
  f.submit().click();
  await tick();
  assert.ok(page.replies().every((body) => body.clientMessageId === first.clientMessageId),
    `an unconfirmed reply is never replaced by one with a new client id: ${JSON.stringify(page.replies())}`);
  assert.ok(f.notes().some((n) => /Retry or clear the previous reply first/.test(n)), JSON.stringify(f.notes()));
  assert.equal(unconfirmedOf(page)?.preview, "Answers to “Which parts ship first?”:\n- First part: The UI",
    `shown as it went, not in the form's words now: ${JSON.stringify(unconfirmedOf(page))}`);
  sendAgainButton(page, 2).click();
  await tick();
  const second = page.replies()[1];
  assert.deepEqual(second, first, "the same version, answers and client id");
  assert.equal(c.delivered.size, 1, "Core delivered it once");
  assert.ok(page.notes().some((n) => /Your reply to version 2 of this ask was delivered before/.test(n)), JSON.stringify(page.notes()));
  assert.deepEqual(page.errors, []);
});

const formVersions = (page) => Object.keys(JSON.parse(page.window.localStorage.getItem("yuzuno.home-ask-form-versions.v1") || "{}"));

test("YN-38 answers whose version record was evicted are kept after a reload where they fit, said so, and sent as they are; a new form's defaults are not said to be kept", async (t) => {
  const page = mount();
  t.after(page.close);
  const f = formOf(page);
  page.render(section("form", 1, { form }));
  f.radio("Core").click();
  await tick();
  // Fifty forms begun since: that store keeps the newest 50 (for 30 days), so this one's record goes; its answers stay.
  for (let i = 0; i < 50; i += 1) {
    page.render(section(`other-${i}`, 1, { form }));
    f.radio("The UI").click();
    await tick();
  }
  assert.equal(formVersions(page).length, 50);
  assert.ok(!formVersions(page).some((k) => k.includes(":p1:form:")), "its version record was evicted");
  assert.ok(Object.keys(page.window.localStorage).some((k) => k.startsWith("yuzuno.clarification.v1:") && k.includes(":p1:form:")), "its answers were not");
  page.reload();
  page.render(section("form", 2, { form }));
  assert.ok(page.notes().some(carriedNote), `answers of an unknown version are said to be kept: ${JSON.stringify(page.notes())}`);
  assert.equal(f.radio("Core").checked, true, "the answers stay");
  assert.equal(f.submit().disabled, false, "no step before they can be sent");
  assert.equal(page.replies().length, 0, "nothing sent by itself");
  f.submit().click();
  await tick();
  const [sent] = page.replies();
  assert.equal(sent.askVersion, 2);
  assert.match(sent.text, /- First part: Core/);
  // A new form at its defaults has nothing kept: never said to be.
  page.render(section("fresh", 2, { form: defaulted("ui") }));
  assert.ok(!page.notes().some(carriedNote), JSON.stringify(page.notes()));
  assert.equal(f.submit().disabled, false);
  assert.deepEqual(page.errors, []);
});

test("a changed schema alone is never an edit: an untouched form follows the question in place and keeps no answers or version", async (t) => {
  const page = mount();
  t.after(page.close);
  const f = formOf(page);
  page.render(section("form", 1, { form: defaulted("ui") }));
  page.render(section("form", 2, { form: { ...changedForm, fields: [{ ...changedForm.fields[0], default: { value: "docs", source: "The plan" } }] } }));
  assert.equal(f.radio("The docs").checked, true, "version 2's own default");
  page.render(section("form", 3, { form: defaulted("core") }));
  assert.equal(f.radio("Core").checked, true, "version 3's own default");
  assert.ok(!page.notes().some(carriedNote) && !page.document.querySelector(".clarification-carried"), JSON.stringify([page.notes(), f.notes()]));
  assert.ok(!Object.keys(page.window.localStorage).some((k) => k.startsWith("yuzuno.clarification.v1:")), "no answers kept");
  assert.deepEqual(formVersions(page), [], "no version kept");
  assert.equal(f.submit().disabled, false);
  assert.deepEqual(page.errors, []);
});

test("a new edit is told apart from the unconfirmed send: that send goes again as it was, the edit stays and goes on its own", async (t) => {
  const c = core();
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  c.lose(true);
  page.render(section("plan", 1));
  await page.type("Ship on Friday.");
  page.sendButton().click();
  await tick();
  await page.type("Ship on Monday, after the docs.");
  assert.equal(page.sendButton().disabled, true, "a new edit does not go while the earlier reply is unconfirmed");
  sendAgainButton(page, 1).click();
  await tick();
  const [first, second] = page.replies();
  assert.deepEqual(second, first, "the earlier reply as it was, not the edit");
  assert.ok(page.notes().some((n) => /A reply you wrote here is kept, not sent/.test(n)), JSON.stringify(page.notes()));
  page.button("Reply again").click();
  await tick();
  assert.equal(page.field().value, "Ship on Monday, after the docs.", "the edit stays");
  page.sendButton().click();
  await tick();
  const third = page.replies()[2];
  assert.deepEqual([third.text, third.askVersion], ["Ship on Monday, after the docs.", 1]);
  assert.notEqual(third.clientMessageId, first.clientMessageId, "the edit is a new reply");
  assert.equal(c.delivered.size, 2);
  assert.deepEqual(page.errors, []);
});

test("a draft written after the unconfirmed send stays when that send goes again, even with the same words", async (t) => {
  const c = core();
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  c.lose(true);
  page.render(section("plan", 2));
  await page.type("Ship on Friday.");
  page.sendButton().click();
  await tick();
  await page.type("");
  await page.type("Ship on Friday.");
  sendAgainButton(page, 2).click();
  await tick();
  assert.ok(page.notes().some((n) => /A reply you wrote here is kept, not sent/.test(n)), JSON.stringify(page.notes()));
  page.button("Reply again").click();
  await tick();
  assert.equal(page.field().value, "Ship on Friday.", "the newer draft stays, though its words are the same");
  assert.equal(c.delivered.size, 1);
  assert.deepEqual(page.errors, []);
});

test("sent again on an ask resolved or removed since, the unconfirmed reply is refused there: its record goes, the refusal shows and the ask opens again", async (t) => {
  for (const [code, said] of [["ask_resolved", /This ask was resolved before your reply was sent/], ["section_removed", /This ask was removed before your reply was sent/]]) {
    const c = core(() => `${code}: version 2 of the ask \`opt\` can't be answered now`);
    const page = mount((body) => c.answer(body));
    try {
      c.lose(false);
      page.render(section("opt", 2));
      page.button("Ship today").click();
      await tick();
      assert.equal(page.button("Ship today").disabled, true, code);
      sendAgainButton(page, 2).click();
      await tick();
      const [first, second] = page.replies();
      assert.deepEqual(second, first, `${code}: sent again as it was`);
      assert.ok(page.notes().some((n) => said.test(n)), `${code}: ${JSON.stringify(page.notes())}`);
      assert.deepEqual(page.outbox(), [], `${code}: never submitted, no record`);
      assert.equal(page.button("Ship today").disabled, false, `${code}: open again`);
      assert.equal(c.delivered.size, 0);
      assert.deepEqual(page.errors, []);
    } finally {
      page.close();
    }
  }
});

test("while the unconfirmed reply is being sent again it can be neither sent again nor discarded; its record goes only with its own answer", async (t) => {
  let calls = 0;
  let release;
  const page = mount((body) => {
    calls += 1;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return new Promise((resolve) => { release = () => resolve(accepted(body)); });
  });
  t.after(page.close);
  page.render(section("plan", 2));
  await page.type("Ship on Friday.");
  page.sendButton().click();
  await tick();
  sendAgainButton(page, 2).click();
  await tick();
  assert.equal(sendAgainButton(page), undefined, "not sent twice at once");
  assert.equal(page.button("Sending…")?.disabled, true, "shown as on its way, in its place");
  assert.equal(page.button("Clear pending record")?.disabled, true, "not cleared while its answer may still come");
  assert.equal(page.outbox().length, 1, "its record stays while it is on its way");
  release();
  await tick();
  assert.deepEqual(page.outbox(), [], "gone with its own answer");
  assert.equal(page.replies().length, 2);
  assert.deepEqual(page.errors, []);
});

test("a reply whose answer was lost or uncertain stays to be sent again; one Core rejected, or says it can never confirm, does not", async (t) => {
  for (const [status, kept] of [["uncertain", true], ["rejected", false], ["unknown", false]]) {
    const page = mount((body) => ({ status: 200, body: { input: { text: body.text, clientMessageId: body.clientMessageId }, status, turnId: null,
      error: status === "rejected" ? "The Agent refused it." : null } }));
    try {
      page.render(section("plan", 2));
      await page.type("Ship on Friday.");
      page.sendButton().click();
      await tick();
      assert.equal(!!sendAgainButton(page, 2), kept, status);
      assert.equal(page.outbox().length, kept ? 1 : 0, status);
      assert.equal(page.field().value, "Ship on Friday.", `${status}: the words stay`);
      assert.deepEqual(page.errors, []);
    } finally {
      page.close();
    }
  }
});

test("④ discarding the unconfirmed reply forgets it here and says it may have been delivered; clearing a draft does not discard it", async (t) => {
  const c = core();
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  const f = formOf(page);
  // Free text.
  c.lose(true);
  page.render(section("plan", 2));
  await page.type("Ship on Friday.");
  page.sendButton().click();
  await tick();
  page.reload();
  page.render(section("plan", 3));
  await page.type("");
  const [sent] = page.replies();
  assert.deepEqual(page.outbox().map((o) => [o.clientMessageId, o.askVersion, o.text]), [[sent.clientMessageId, 2, "Ship on Friday."]], "still kept");
  assert.ok(page.notes().some((n) => /not confirmed/.test(n)), JSON.stringify(page.notes()));
  page.button("Clear pending record").click();
  await tick();
  assert.deepEqual(page.outbox(), []);
  assert.ok(page.notes().some((n) => /Cleared here only: it may already have been delivered/.test(n)), JSON.stringify(page.notes()));
  assert.equal(page.replies().length, 1, "nothing sent");
  // A form: its answers stay version 2's.
  c.lose(true);
  page.render(section("form", 2, { form }));
  f.radio("The UI").click();
  await tick();
  f.submit().click();
  await tick();
  page.render(section("form", 3, { form }));
  assert.ok(f.notes().some((n) => /Retry or clear the previous reply first/.test(n)), JSON.stringify(f.notes()));
  page.button("Clear pending record").click();
  await tick();
  assert.deepEqual(page.outbox(), []);
  // The answers stay, for the version on screen now (YN-38).
  assert.equal(f.radio("The UI").checked, true);
  assert.equal(f.submit().disabled, false);
  assert.equal(page.replies().length, 2, "nothing more sent");
  assert.equal(c.delivered.size, 2, "both had reached Core: discarding here takes back neither");
  assert.deepEqual(page.errors, []);
});

test("in place, an unedited form shows the new question's own defaults; a form sent with its defaults goes again with them", async (t) => {
  const c = core();
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  const f = formOf(page);
  // Nothing written in it: the ask changes in place, without a reload.
  page.render(section("form", 1, { form: defaulted("ui"), freeText: true }));
  assert.equal(f.radio("The UI").checked, true);
  page.field().focus();
  page.render(section("form", 2, { form: defaulted("core"), freeText: true }));
  assert.equal(f.radio("Core").checked, true, "the default of version 2");
  assert.equal(f.radio("The UI").checked, false, "not version 1's");
  assert.equal(page.document.activeElement, page.field(), "focus stays where the user is");
  assert.ok(!page.notes().some(carriedNote) && !page.document.querySelector(".clarification-carried"), JSON.stringify(f.notes()));
  f.submit().click();
  await tick();
  const [fresh] = page.replies();
  assert.equal(fresh.askVersion, 2);
  assert.match(fresh.text, /- First part: Core/);
  // Sent with its defaults, unconfirmed: those answers are that send's, here and after a reload.
  c.lose(true);
  page.render(section("sent", 1, { form: defaulted("ui") }));
  f.submit().click();
  await tick();
  page.render(section("sent", 2, { form: defaulted("core") }));
  assert.equal(f.radio("The UI").checked, true, "the answers sent stay");
  page.reload();
  page.render(section("sent", 2, { form: defaulted("core") }));
  assert.equal(f.radio("The UI").checked, true, "and after a reload");
  sendAgainButton(page, 1).click();
  await tick();
  const [, sent, retried] = page.replies();
  assert.deepEqual(retried, sent, "the same version, answers and client id");
  assert.equal(retried.askVersion, 1);
  assert.equal(c.delivered.size, 2);
  assert.deepEqual(page.errors, []);
});

test("YN-38 when this browser keeps nothing, a form begun on version 1 answers version 2 as it is, and an unconfirmed reply goes again as it was here", async (t) => {
  const c = core();
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  // Private browsing or a full store: every write is refused.
  page.window.Storage.prototype.setItem = function () {
    throw new page.window.DOMException("The quota has been exceeded.", "QuotaExceededError");
  };
  const f = formOf(page);
  page.render(section("form", 1, { form }));
  f.radio("Core").click();
  await tick();
  page.render(section("form", 2, { form }));
  assert.equal(f.radio("Core").checked, true, "the answers stay");
  assert.equal(f.submit().disabled, false, "no step before they can be sent");
  assert.ok(!page.button("Refer it to version 2") && !page.button("Discard"));
  assert.equal(page.replies().length, 0, "nothing sent by itself");
  // Free text whose outcome is unknown goes again under its client id.
  c.lose(true);
  page.render(section("plan", 1));
  await page.type("Ship on Friday.");
  page.sendButton().click();
  await tick();
  page.render(section("plan", 2));
  assert.ok(page.notes().some((n) => /not confirmed/.test(n)), JSON.stringify(page.notes()));
  sendAgainButton(page, 1).click();
  await tick();
  const [first, second] = page.replies();
  assert.deepEqual(second, first, "the same version, words and client id");
  assert.equal(c.delivered.size, 1, "Core delivered it once");
  // So does a form.
  c.lose(true);
  page.render(section("sent", 1, { form }));
  f.radio("The UI").click();
  await tick();
  f.submit().click();
  await tick();
  page.render(section("sent", 2, { form }));
  sendAgainButton(page, 1).click();
  await tick();
  const [, , formFirst, formSecond] = page.replies();
  assert.deepEqual(formSecond, formFirst, "the same version, answers and client id");
  assert.equal(c.delivered.size, 2, "Core delivered each once");
  assert.deepEqual(page.errors, []);
});

test("a pick refused because the ask was resolved or removed says so and sends nothing more", async (t) => {
  const answers = [refused("ask_resolved: the ask was resolved"), refused("section_removed: no such section")];
  const page = mount(() => answers.shift());
  t.after(page.close);
  page.render(section("plan", 5));
  page.button("Wait").click();
  await tick();
  assert.ok(page.notes().some((n) => /This ask was resolved before your reply was sent, so nothing was sent\./.test(n)), JSON.stringify(page.notes()));
  page.button("Ship today").click();
  await tick();
  assert.ok(page.notes().some((n) => /This ask was removed before your reply was sent, so nothing was sent\./.test(n)), JSON.stringify(page.notes()));
  assert.equal(page.replies().length, 2, "one request per click, none repeated");
  assert.equal(page.box.sent, 2, "Home reads again each time");
});

test("another Workspace, or a Core older than the page: nothing sent, reload Home, no retry kept", async (t) => {
  const answers = [
    refused("workspace_changed: this is not the Workspace that page showed"),
    { status: 422, body: { error: "Failed to deserialize the JSON body into the target type: unknown field `askVersion`, expected one of `key`, `agentId`" } },
  ];
  const page = mount(() => answers.shift());
  t.after(page.close);
  page.render(section("plan", 2));
  await page.type("Yes.");
  page.sendButton().click();
  await tick();
  assert.ok(page.notes().some((n) => /Nothing was sent: reload Home to reply here\./.test(n)), JSON.stringify(page.notes()));
  page.sendButton().click();
  await tick();
  assert.ok(page.notes().some((n) => /Nothing was sent: reload Home to reply here\./.test(n)));
  assert.equal(page.window.localStorage.getItem("yuzuno.home-outbox.v1"), null, "an older Core read nothing: no retry record");
  assert.equal(page.field().value, "Yes.");
});

test("words written while a reply is being sent stay", async (t) => {
  let release;
  const page = mount((body) => new Promise((resolve) => { release = () => resolve(accepted(body)); }));
  t.after(page.close);
  page.render(section("plan", 2));
  await page.type("First thought.");
  page.sendButton().click();
  await tick();
  await page.type("A second thought, written while sending.");
  release();
  await tick();
  assert.equal(page.replies()[0].text, "First thought.");
  assert.equal(page.replies()[0].askVersion, 2);
  assert.equal(page.field()?.value ?? null, null, "shown as replied");
  const again = [...page.document.querySelectorAll("button")].find((b) => /again/i.test(b.textContent));
  again.click();
  await tick();
  assert.equal(page.field().value, "A second thought, written while sending.", "kept, not sent");
});
