import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// A reply to an ask names the version of the ask the user answered and the
// Workspace that page showed (T-9): every way of answering (an option, a
// choice, a form, free text) sends `askVersion` and `workspaceId`, never a
// card's `version`. Core refuses a reply to a version that is no longer the
// live ask, sending nothing; the reply box says so and what was written
// stays. A retry of a send not confirmed goes again exactly as it was. The
// real AskReply, with Core answered here.
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

/** `answer(body)`: what Core answers a reply; a thrown error is a lost connection. */
function mount(answer = accepted) {
  const errors = [];
  const posts = [];
  let ids = 0;
  const box = { answer, sent: 0 };
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
  return {
    get window() { return window; }, get document() { return document; },
    errors, posts, replies, render, field, sendButton, type, button, notes, box, reload, outbox, close: () => window.close(),
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
  assert.deepEqual(page.errors, []);
});

test("refused because the ask changed: nothing more is sent, the words stay, and they go to the new version only when the user says so", async (t) => {
  const page = mount((body) => body.askVersion === 2 ? refused("ask_changed: the ask is now version 3") : accepted(body));
  t.after(page.close);
  page.render(section("plan", 2));
  await page.type("Plan A, as discussed.");
  page.sendButton().click();
  await tick();
  assert.equal(page.replies().length, 1);
  assert.ok(page.notes().some((n) => /The question changed before your reply was sent, so nothing was sent/.test(n)), JSON.stringify(page.notes()));
  assert.equal(page.box.sent, 1, "Home reads the ask again");
  assert.equal(page.field().value, "Plan A, as discussed.", "the words stay");
  assert.equal(page.window.localStorage.getItem("yuzuno.home-outbox.v1"), null, "never submitted: no retry record");
  // Home shows the question as it is now: the reply waits for the user.
  page.render(section("plan", 3));
  assert.ok(page.notes().some((n) => /You began this reply on version 2 of this ask; Home shows version 3/.test(n)), JSON.stringify(page.notes()));
  assert.equal(page.sendButton().disabled, true, "not sent to version 3 by itself");
  page.button("Refer it to version 3").click();
  await tick();
  page.sendButton().click();
  await tick();
  const sent = page.replies();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].askVersion, 3);
  assert.equal(sent[1].text, "Plan A, as discussed.");
  assert.notEqual(sent[1].clientMessageId, sent[0].clientMessageId, "a reply to another version is another message");
  assert.deepEqual(page.errors, []);
});

test("a send not confirmed goes again exactly as it was, even after the ask is asked again", async (t) => {
  let lost = true;
  const page = mount((body) => {
    if (lost) { lost = false; throw new TypeError("Failed to fetch"); }
    return accepted(body);
  });
  t.after(page.close);
  page.render(section("plan", 2));
  await page.type("Ship on Friday.");
  page.sendButton().click();
  await tick();
  assert.ok(page.notes().some((n) => /not confirmed/.test(n)), JSON.stringify(page.notes()));
  // The owner asked again meanwhile; the retry still answers version 2.
  page.render(section("plan", 3));
  assert.equal(page.sendButton().disabled, false, "the unconfirmed reply can be sent again");
  page.sendButton().click();
  await tick();
  const [first, second] = page.replies();
  assert.deepEqual(second, first, "same version, words and client id");
  assert.equal(second.askVersion, 2);
  assert.deepEqual(page.errors, []);
});

test("a send not confirmed goes again as it was when its words had spaces around them, here and after a reload", async (t) => {
  let lost = true;
  const page = mount((body) => {
    if (lost) { lost = false; throw new TypeError("Failed to fetch"); }
    return accepted(body);
  });
  t.after(page.close);
  const referNote = (n) => /You began this reply on version/.test(n);
  page.render(section("plan", 2));
  // Sent trimmed; the draft keeps the words as written.
  await page.type("  Ship on Friday.\n");
  page.sendButton().click();
  await tick();
  assert.equal(page.replies()[0].text, "Ship on Friday.");
  page.render(section("plan", 3));
  assert.ok(!page.notes().some(referNote), JSON.stringify(page.notes()));
  assert.equal(page.sendButton().disabled, false, "the unconfirmed reply can be sent again");
  // Reloaded: the draft and the retry record are read again.
  page.render(section("other", 1));
  page.render(section("plan", 3));
  assert.equal(page.field().value, "  Ship on Friday.\n");
  assert.ok(page.notes().some((n) => /Kept from before, not sent yet: your reply to version 2/.test(n)), JSON.stringify(page.notes()));
  assert.ok(page.notes().some((n) => /not confirmed/.test(n)), JSON.stringify(page.notes()));
  assert.ok(!page.notes().some(referNote), JSON.stringify(page.notes()));
  assert.equal(page.sendButton().disabled, false);
  page.sendButton().click();
  await tick();
  const [first, second] = page.replies();
  assert.deepEqual(second, first, "same version, words and client id");
  assert.equal(second.askVersion, 2);
  assert.deepEqual(page.errors, []);
});

// One reply, however it is given (an option, a choice, a form, free text):
// once sent, its version, client id and words are fixed, and a retry after an
// unknown outcome sends exactly those, after the ask changed and after a
// reload too. Only a reply begun on, or referred to, the version shown is a
// new one; a discarded draft does not take back a send whose outcome is
// unknown (Lead 975, T-9 S2 R2).
test("① an option whose outcome is unknown, pressed again after the ask changed and the page reloaded, goes as it was; Core delivers it once", async (t) => {
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
  assert.ok(page.notes().some((n) => /not confirmed/.test(n)), JSON.stringify(page.notes()));
  page.button("Ship today").click();
  await tick();
  const [first, second] = page.replies();
  assert.deepEqual(second, first, "the same version, option and client id");
  assert.equal(second.askVersion, 2);
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

test("② the same choice after the question changed is never sent as the new version: it goes as it was, and Core refuses it there", async (t) => {
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
  planB().click();
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

/** The form's controls in `page`. */
const formOf = (page) => ({
  radio: (label) => [...page.document.querySelectorAll(".clarification label")].find((l) => l.textContent.includes(label)).querySelector("input"),
  submit: () => page.document.querySelector(".clarification footer .primary-button"),
  notes: () => [...page.document.querySelectorAll(".clarification-delivery")].map((n) => n.textContent),
});
const formReferNote = (n) => /You began this reply on version 2 of this ask; Home shows version 3/.test(n);
/** The same form ID, asking something else. */
const changedForm = {
  id: "plan", title: "Which part ships first now?",
  fields: [{ id: "part", type: "single", label: "First part to ship", required: false,
    options: [{ id: "ui", label: "The UI" }, { id: "core", label: "Core" }, { id: "docs", label: "The docs" }] }],
};

test("③ answers begun on a form that keeps its ID but asks something else go to the new version only once the user refers them", async (t) => {
  const c = core();
  const page = mount((body) => c.answer(body));
  t.after(page.close);
  const f = formOf(page);
  page.render(section("form", 2, { form }));
  f.radio("Core").click();
  await tick();
  page.reload();
  page.render(section("form", 3, { form: changedForm }));
  assert.ok(f.notes().some(formReferNote), JSON.stringify(f.notes()));
  assert.equal(f.submit().disabled, true, "not sent to version 3 by itself");
  assert.equal(f.radio("Core").checked, true, "the answers stay");
  page.button("Refer it to version 3").click();
  await tick();
  assert.ok(!f.notes().some(formReferNote), JSON.stringify(f.notes()));
  f.submit().click();
  await tick();
  const [referred] = page.replies();
  assert.equal(referred.askVersion, 3);
  assert.match(referred.text, /^Answers to “Which part ships first now\?”:\n- First part to ship: Core/);
  assert.equal(c.delivered.size, 1);
  assert.deepEqual(page.errors, []);
});

test("④ discarded, answers begun on the earlier form are gone and the form answers the new version", async (t) => {
  const page = mount();
  t.after(page.close);
  const f = formOf(page);
  page.render(section("form", 2, { form }));
  f.radio("Core").click();
  await tick();
  page.render(section("form", 3, { form: changedForm }));
  page.button("Discard").click();
  await tick();
  assert.ok(!f.notes().some(formReferNote), JSON.stringify(f.notes()));
  assert.equal(f.radio("Core").checked, false, "the answers begun on version 2 are gone");
  f.radio("The docs").click();
  await tick();
  f.submit().click();
  await tick();
  const [fresh] = page.replies();
  assert.equal(fresh.askVersion, 3);
  assert.match(fresh.text, /- First part to ship: The docs/);
  assert.deepEqual(page.errors, []);
});

test("① a form whose outcome is unknown goes again as it was after the ask changed and the page reloaded; Core delivers it once", async (t) => {
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
  page.reload();
  page.render(section("form", 3, { form }));
  assert.ok(!f.notes().some(formReferNote), JSON.stringify(f.notes()));
  assert.equal(f.submit().disabled, false, "the unconfirmed answers can be sent again");
  f.submit().click();
  await tick();
  const [first, second] = page.replies();
  assert.deepEqual(second, first, "the same version, answers and client id");
  assert.equal(second.askVersion, 2);
  assert.equal(c.delivered.size, 1, "Core delivered it once");
  assert.ok(page.notes().some((n) => /Your reply to version 2 of this ask was delivered before/.test(n)), JSON.stringify(page.notes()));
  assert.deepEqual(page.errors, []);
});

test("④ discarding a draft does not take back a send whose outcome is unknown: its record stays, and the same words go as it was", async (t) => {
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
  await page.type("Ship on Monday.");
  assert.ok(page.notes().some((n) => /You began this reply on version 2 of this ask; Home shows version 3/.test(n)), JSON.stringify(page.notes()));
  page.button("Discard").click();
  await tick();
  assert.equal(page.field().value, "");
  const [sent] = page.replies();
  assert.deepEqual(page.outbox().map((o) => [o.clientMessageId, o.askVersion, o.text]), [[sent.clientMessageId, 2, "Ship on Friday."]], "still kept");
  assert.ok(page.notes().some((n) => /not confirmed/.test(n)), JSON.stringify(page.notes()));
  await page.type("Ship on Friday.");
  page.sendButton().click();
  await tick();
  assert.deepEqual(page.replies()[1], sent, "the same version, words and client id");
  // A form.
  c.lose(true);
  page.render(section("form", 2, { form }));
  f.radio("The UI").click();
  await tick();
  f.submit().click();
  await tick();
  page.render(section("form", 3, { form }));
  f.radio("Core").click();
  await tick();
  assert.ok(f.notes().some(formReferNote), JSON.stringify(f.notes()));
  page.button("Discard").click();
  await tick();
  const formSent = page.replies()[2];
  assert.deepEqual(page.outbox().map((o) => [o.clientMessageId, o.askVersion]), [[formSent.clientMessageId, 2]], "still kept");
  assert.ok(page.notes().some((n) => /not confirmed/.test(n)), JSON.stringify(page.notes()));
  f.radio("The UI").click();
  await tick();
  f.submit().click();
  await tick();
  assert.deepEqual(page.replies()[3], formSent, "the same version, answers and client id");
  assert.equal(c.delivered.size, 2, "Core delivered each once");
  assert.deepEqual(page.errors, []);
});

/** The same form ID, with `value` as its field's default. */
const defaulted = (value) => ({
  ...form,
  fields: [{ ...form.fields[0], default: { value, source: "The plan" } }],
});

test("in place, an unedited form shows the new question's own defaults; a form sent with its defaults keeps them for its retry", async (t) => {
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
  assert.ok(!f.notes().some((n) => /You began this reply on version/.test(n)), JSON.stringify(f.notes()));
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
  assert.ok(!f.notes().some((n) => /You began this reply on version/.test(n)), JSON.stringify(f.notes()));
  f.submit().click();
  await tick();
  const [, sent, retried] = page.replies();
  assert.deepEqual(retried, sent, "the same version, answers and client id");
  assert.equal(retried.askVersion, 1);
  assert.equal(c.delivered.size, 2);
  assert.deepEqual(page.errors, []);
});

test("when this browser keeps nothing, a form begun on version 1 is still held at version 2, and a retry here keeps its client id", async (t) => {
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
  assert.ok(f.notes().some((n) => /You began this reply on version 1 of this ask; Home shows version 2/.test(n)), JSON.stringify(f.notes()));
  assert.equal(f.submit().disabled, true, "not sent to version 2 by itself");
  assert.equal(f.radio("Core").checked, true, "the answers stay");
  assert.ok(page.button("Refer it to version 2") && page.button("Discard"));
  assert.equal(page.replies().length, 0, "nothing sent");
  // Free text whose outcome is unknown goes again under its client id.
  c.lose(true);
  page.render(section("plan", 1));
  await page.type("Ship on Friday.");
  page.sendButton().click();
  await tick();
  page.render(section("plan", 2));
  assert.ok(page.notes().some((n) => /not confirmed/.test(n)), JSON.stringify(page.notes()));
  page.sendButton().click();
  await tick();
  const [first, second] = page.replies();
  assert.deepEqual(second, first, "the same version, words and client id");
  assert.equal(c.delivered.size, 1, "Core delivered it once");
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
