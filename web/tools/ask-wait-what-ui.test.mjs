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

// YN-213: an Ask with a decision to make (options, A/B, a form) has one
// button that sends it, the user's words and what they attach together,
// named for the decision; a default is a suggestion, never chosen for the
// user. "Wait, what?" beside it opens a field of its own: what is written
// there goes to the Agent as a note that answers nothing (`intent: "note"`),
// the ask stays open, and the pick and the answers begun stay as they were.
// The real AskReply, with Core answered here.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "ask-wait-what-"));
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
    build: { write: false, lib: { entry, name: "AskWaitWhat", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const agents = [
  { id: "mori", name: "Mori", harness: "codex", status: "idle", cwd: "/fixture", model: "", color: "sage",
    createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" },
];
const options = { options: [{ id: "full", label: "Implement it all" }, { id: "later", label: "Not now" }] };
const form = {
  id: "plan", title: "Ship the design?",
  fields: [{ id: "verdict", type: "single", label: "Verdict", required: true,
    options: [{ id: "go", label: "Approve" }, { id: "fix", label: "Needs changes" }], default: { value: "go", source: "The design note" } }],
};
const section = (key, version, reply = options, ask = {}) => ({
  key, kind: "ask", title: "Implement it?", version,
  owner: { agentId: "mori", name: "Mori", state: "active" },
  updatedAt: new Date().toISOString(), updatedTurnId: null, attachments: [], refs: {}, seen: null, history: false,
  body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: [] } } },
  ask: { question: "Implement the approved design?", state: "open", reply, ...ask },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const accepted = (body) => ({ status: 200, body: { input: { text: body.text, clientMessageId: body.clientMessageId },
  status: "accepted", turnId: "mori-t2", error: null } });
const refused = (message) => ({ status: 409, body: { error: message, code: "message_not_submitted" } });

function mount(answer = accepted) {
  const errors = [];
  const posts = [];
  let ids = 0;
  let window;
  let document;
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
    window.structuredClone = structuredClone;
    window.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      posts.push({ url: String(url), method: init.method || "GET", body });
      const { status, body: reply } = await answer(body);
      // A plain body, as serde words a refusal, is no JSON.
      const plain = typeof reply === "string";
      return { ok: status < 400, status, json: async () => { if (plain) throw new Error("plain"); return reply; },
        text: async () => (plain ? reply : JSON.stringify(reply)) };
    };
    window.eval(bundle);
  }
  open();
  const reload = () => {
    const kept = Object.fromEntries(Object.keys(window.localStorage).map((name) => [name, window.localStorage.getItem(name)]));
    window.close();
    open(kept);
  };
  const render = (sectionValue) =>
    window.renderAsk({ key: sectionValue.key, section: sectionValue, projectId: "p1", workspaceId: "ws-1", agents, readOnly: false, onSent: () => {} });
  const button = (text) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  const primary = () => document.querySelector(".home-ask-decision .clarification footer .primary-button, .home-ask-decision .home-ask-actions .primary-button");
  const radio = (label) => [...document.querySelectorAll(".home-ask-decision fieldset label, .clarification label")]
    .find((l) => l.textContent.includes(label))?.querySelector("input");
  const decision = () => document.querySelector(".home-ask-decision");
  // The words with the decision, and the note's own field.
  const words = () => document.querySelector(".home-ask-decision .home-ask-words [data-composer-input]");
  const noteField = () => document.querySelector(".home-ask-note [data-composer-input]");
  const type = async (field, text) => {
    setComposerText(field, text);
    await tick();
  };
  const replies = () => posts.filter((post) => post.method === "POST" && /\/brief\/reply$/.test(post.url)).map((post) => post.body);
  const notes = () => [...document.querySelectorAll(".home-ask-notes")].map((n) => n.textContent);
  const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((n) => n.textContent);
  const outbox = () => Object.values(JSON.parse(window.localStorage.getItem("yuzuno.home-outbox.v1") || "{}"));
  return {
    get window() { return window; }, get document() { return document; },
    errors, posts, render, reload, button, primary, radio, decision, words, noteField, type, replies, notes, alerts, outbox,
    close: () => window.close(),
  };
}

test("one button sends the decision with the words beside it; nothing is picked for the user and words alone decide nothing", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render(section("ship", 2));
  assert.ok(["Implement it all", "Not now"].every((label) => !page.radio(label).checked), "no option picked for the user");
  assert.equal(page.primary().textContent.trim(), "Submit decision");
  assert.equal(page.primary().disabled, true);
  assert.ok(page.button("Wait, what?"), "Wait, what? from the start, beside the one button");
  await page.type(page.words(), "After the preview is fixed.");
  assert.equal(page.primary().disabled, true, "words alone are no decision here");
  page.radio("Implement it all").click();
  await tick();
  assert.equal(page.primary().textContent.trim(), "Submit: Implement it all");
  page.primary().click();
  await tick();
  const [sent] = page.replies();
  assert.deepEqual([sent.choice, sent.text, sent.askVersion, sent.intent, sent.note], ["full", "After the preview is fixed.", 2, undefined, undefined]);
  // Shown as the reply: the decision and the words together.
  assert.match(page.document.querySelector(".home-ask-replied").textContent, /Implement it all\s*After the preview is fixed\./);
  assert.deepEqual(page.errors, []);
});

test("Wait, what? opens its own field at once; its note goes alone, the decision and its words stay, and the Ask still waits", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render(section("ship", 2));
  page.radio("Implement it all").click();
  await tick();
  await page.type(page.words(), "Approve, with the docs.");
  page.button("Wait, what?").click();
  await tick();
  assert.equal(page.decision().hidden, true, "the decision is set aside, not cleared");
  assert.ok(page.noteField(), "its own field");
  assert.equal(page.document.activeElement, page.noteField(), "the cursor in it");
  assert.equal(composerText(page.noteField()), "", "empty: nothing of the decision's words is in it");
  assert.equal(page.button("Send to Agent").disabled, true, "nothing to send yet");
  await page.type(page.noteField(), "The preview won't open. Can you send a screenshot first?");
  page.button("Send to Agent").click();
  await tick();
  const [sent] = page.replies();
  assert.deepEqual(sent, {
    key: "ship", agentId: "mori", text: "The preview won't open. Can you send a screenshot first?", clientMessageId: sent.clientMessageId,
    askVersion: 2, workspaceId: "ws-1", intent: "note",
  }, "a note: no choice, no form, no words of the decision");
  // Back at the decision, as it was; the note is listed, and the Ask is not replied.
  assert.equal(page.decision().hidden, false);
  assert.equal(page.document.activeElement, page.button("Wait, what?"), "focus back on Wait, what?");
  assert.equal(page.radio("Implement it all").checked, true, "the pick stays");
  assert.equal(composerText(page.words()), "Approve, with the docs.", "and the words with it");
  assert.equal(page.primary().textContent.trim(), "Submit: Implement it all");
  assert.equal(page.document.querySelector(".home-ask-replied"), null, "not answered");
  assert.match(page.notes()[0], /Note sent · still waiting for your decision.*The preview won't open/);
  // The decision then goes on its own, with its words.
  page.primary().click();
  await tick();
  const second = page.replies()[1];
  assert.deepEqual([second.choice, second.text, second.intent], ["full", "Approve, with the docs.", undefined]);
  assert.notEqual(second.clientMessageId, sent.clientMessageId);
  assert.deepEqual(page.errors, []);
});

test("Back to the question keeps the note's words, a reload keeps both drafts, and a form's default is only suggested", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render(section("plan", 1, { form }));
  assert.equal(page.radio("Approve").checked, false, "the default is not the user's answer");
  assert.match(page.document.querySelector(".clarification-note").textContent, /Suggested: “Approve” \(The design note\)\. Choose it yourself to send it\./);
  page.primary().click();
  await tick();
  assert.equal(page.replies().length, 0, "an untouched form sends nothing: the required field is the user's to answer");
  page.radio("Needs changes").click();
  await tick();
  page.button("Wait, what?").click();
  await tick();
  await page.type(page.noteField(), "Which preview is this about?");
  page.button("Back to the question").click();
  await tick();
  assert.equal(page.radio("Needs changes").checked, true);
  page.reload();
  page.render(section("plan", 1, { form }));
  assert.ok(page.noteField(), "the note kept from before opens where it was left");
  assert.equal(composerText(page.noteField()), "Which preview is this about?");
  page.button("Back to the question").click();
  await tick();
  assert.equal(page.radio("Needs changes").checked, true, "the form's answer kept too");
  assert.deepEqual(page.replies(), [], "nothing sent by any of it");
  assert.deepEqual(page.errors, []);
});

test("a form's answers go with the words and what they attach, as one reply, shown without its IDs", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render(section("plan", 1, { form }));
  page.radio("Approve").click();
  await tick();
  await page.type(page.words(), "Ship it once the preview loads.");
  assert.equal(page.primary().textContent.trim(), "Submit answers");
  page.primary().click();
  await tick();
  const [sent] = page.replies();
  assert.deepEqual(sent.form, { formId: "plan", answers: { verdict: "go" } });
  assert.equal(sent.note, "Ship it once the preview loads.");
  assert.equal(sent.text, `Answers to “Ship the design?”:\n- Verdict: Approve\n\n${JSON.stringify(sent.form)}`, "the text says exactly the answers");
  const shown = page.document.querySelector(".home-ask-replied p").textContent;
  assert.equal(shown, "Answers to “Ship the design?”:\n- Verdict: Approve\n\nShip it once the preview loads.");
  // Core's record of it, read back: the same, without the IDs.
  page.render(section("plan", 1, { form }, { state: "replied", repliedAt: new Date().toISOString(),
    replyText: `${sent.text}\n\nShip it once the preview loads.` }));
  assert.equal(page.document.querySelector(".home-ask-replied p").textContent, shown);
  assert.deepEqual(page.errors, []);
});

test("a Core older than notes refuses them: said, nothing waits to go again, nothing goes as an answer, and the words stay", async (t) => {
  const older = (field) => ({ status: 422, body: `Failed to deserialize the JSON body into the target type: unknown field \`${field}\`, expected one of \`key\`, \`agentId\`` });
  const page = mount((body) => (body.intent ? older("intent") : body.note ? older("note") : accepted(body)));
  t.after(page.close);
  page.render(section("ship", 2));
  page.button("Wait, what?").click();
  await tick();
  await page.type(page.noteField(), "What does this ship?");
  page.button("Send to Agent").click();
  await tick();
  assert.equal(page.replies().length, 1, "one try, never again as something else");
  assert.ok(page.alerts().some((a) => /can't take a note on its own.*Nothing was sent; what you wrote is kept/.test(a)), JSON.stringify(page.alerts()));
  assert.deepEqual(page.outbox(), [], "never submitted: no retry record");
  assert.equal(composerText(page.noteField()), "What does this ship?");
  // A form's answers with words, likewise.
  page.render(section("plan", 1, { form }));
  page.radio("Approve").click();
  await tick();
  await page.type(page.words(), "With the docs.");
  page.primary().click();
  await tick();
  assert.equal(page.replies().length, 2);
  assert.ok(page.alerts().some((a) => /can't take a note on its own/.test(a)), JSON.stringify(page.alerts()));
  assert.equal(page.document.querySelector(".home-ask-replied"), null, "not shown as answered");
  assert.deepEqual(page.outbox(), []);
  assert.deepEqual(page.errors, []);
});

test("a note not confirmed goes again as it was, a note still; refused because the ask moved on, to its latest version as a note", async (t) => {
  let lose = true;
  const page = mount((body) => {
    if (lose) { lose = false; throw new TypeError("Failed to fetch"); }
    return body.askVersion === 2 ? refused("ask_changed: version 2 of the ask `ship` can't be answered now") : accepted(body);
  });
  t.after(page.close);
  page.render(section("ship", 2));
  page.button("Wait, what?").click();
  await tick();
  await page.type(page.noteField(), "Is the preview the right one?");
  page.button("Send to Agent").click();
  await tick();
  assert.match(page.document.querySelector(".home-ask-unconfirmed").textContent, /Previous note not confirmed yet/);
  page.reload();
  // Home reads the latest version when Core refuses the one sent.
  page.window.fetch = ((own) => async (url, init) => String(url).endsWith("/api/home")
    ? { ok: true, status: 200, json: async () => ({ projects: [{ project: { id: "p1" }, brief: { version: 3, history: [], sections: [section("ship", 3)] } }] }) }
    : own(url, init))(page.window.fetch);
  page.render(section("ship", 2));
  page.button("Retry previous reply").click();
  await tick();
  const sent = page.replies();
  assert.deepEqual(sent.map((b) => [b.askVersion, b.intent, b.text]), [[2, "note", "Is the preview the right one?"], [2, "note", "Is the preview the right one?"],
    [3, "note", "Is the preview the right one?"]]);
  assert.equal(sent[1].clientMessageId, sent[0].clientMessageId, "the retry is the same message");
  assert.equal(page.document.querySelector(".home-ask-replied"), null, "a note never shows the Ask as answered");
  assert.deepEqual(page.errors, []);
});

test("the notes Core keeps show on the Ask, newest first, each with the version it was written on", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render(section("ship", 3, options, { notes: [
    { version: 3, at: new Date().toISOString(), text: "And the phone layout?", agentId: "mori" },
    { version: 2, at: new Date(Date.now() - 3_600_000).toISOString(), text: "Which preview?", agentId: "mori" },
  ] }));
  const items = [...page.document.querySelectorAll(".home-ask-notes li")].map((li) => li.textContent);
  assert.equal(items.length, 2);
  assert.match(items[0], /^And the phone layout\?/);
  assert.doesNotMatch(items[0], /version/);
  assert.match(items[1], /^Which preview\?.*on version 2/);
  assert.match(page.notes()[0], /^Note sent · still waiting for your decision/);
  // Answered since: the same notes, said as the user's own.
  page.render(section("ship", 3, options, { state: "replied", repliedAt: new Date().toISOString(), replyText: "Not now",
    notes: [{ version: 3, at: new Date().toISOString(), text: "And the phone layout?", agentId: "mori" }] }));
  page.button("Reply again").click();
  await tick();
  assert.match(page.notes()[0], /^Your notes/);
  assert.deepEqual(page.errors, []);
});

test("free text alone answers as before, with no Wait, what?", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render(section("words", 1, { freeText: true }));
  assert.equal(page.button("Wait, what?"), undefined, "its words are the answer already");
  const field = page.document.querySelector(".home-text-reply [data-composer-input]");
  await page.type(field, "Ship it Friday.");
  page.document.querySelector(".home-text-reply button[type=submit]").click();
  await tick();
  const [sent] = page.replies();
  assert.deepEqual([sent.text, sent.intent, sent.choice], ["Ship it Friday.", undefined, undefined]);
  assert.ok(page.document.querySelector(".home-ask-replied"));
  assert.deepEqual(page.errors, []);
});
