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

/** `answer(body)`: what Core answers a reply; a thrown error is a lost connection. */
function mount(answer = accepted) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://ask.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  const posts = [];
  let ids = 0;
  window.crypto.randomUUID = () => `client-${++ids}`;
  // A form copies its answers on submit (clarification-ui.test.mjs does the same).
  window.structuredClone = structuredClone;
  const box = { answer, sent: 0 };
  window.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    posts.push({ url: String(url), method: init.method || "GET", body });
    const { status, body: reply } = await box.answer(body);
    return { ok: status < 400, status, json: async () => reply, text: async () => JSON.stringify(reply) };
  };
  window.eval(bundle);
  const document = window.document;
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
  return { window, document, errors, posts, replies, render, field, sendButton, type, button, notes, box, close: () => window.close() };
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
