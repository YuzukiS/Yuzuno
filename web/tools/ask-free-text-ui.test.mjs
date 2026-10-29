import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// An open Ask always takes a reply in the user's own words (T-9), whatever
// the Agent declared: options, a choice or a form never take the writing
// field away, and `freeText.prompt` only names it. The real AskReply, with
// Core answered here; nothing is sent but what a test sends on purpose.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "ask-free-text-"));
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
    build: { write: false, lib: { entry, name: "AskFreeText", formats: ["iife"] } },
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
/** An ask as Core sends it: `reply` is what its Agent declared. */
const section = (key, reply, ask = {}) => ({
  key, kind: "ask", title: "Which plan?", version: 2,
  owner: { agentId: "mori", name: "Mori", state: "active" },
  updatedAt: new Date().toISOString(), updatedTurnId: null, attachments: [], refs: {}, seen: null, history: false,
  body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: [] } } },
  ask: { question: "Which plan should we take?", state: "open", reply, ...ask },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

function mount() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://ask.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  const posts = [];
  window.crypto.randomUUID ??= () => `id-${posts.length}-${Math.random().toString(16).slice(2)}`;
  window.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    posts.push({ url: String(url), method: init.method || "GET", body });
    return {
      ok: true, status: 200,
      json: async () => ({ input: { text: body?.text ?? "", clientMessageId: body?.clientMessageId ?? "" },
        status: "accepted", turnId: "mori-t2", error: null }),
      text: async () => "",
    };
  };
  window.eval(bundle);
  const document = window.document;
  const render = (sectionValue, extra = {}) =>
    window.renderAsk({
      section: sectionValue, projectId: "p1", workspaceId: "ws", agents, readOnly: false,
      onSent: () => {}, ...extra,
    });
  const field = () => document.querySelector(".home-text-reply textarea");
  const sendButton = () => document.querySelector(".home-text-reply button[type=submit]");
  const type = async (text) => {
    const area = field();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(area, text);
    area.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  };
  return { window, document, errors, posts, render, field, sendButton, type, close: () => window.close() };
}

test("every open ask takes free text, whatever its Agent declared", (t) => {
  const page = mount();
  t.after(page.close);
  const shapes = {
    "options only": section("a", { options: [{ id: "ship", label: "Ship today" }, { id: "wait", label: "Wait" }] }),
    "choice only": section("b", { choice: { a: { id: "plan-a", label: "Plan A" }, b: { id: "plan-b", label: "Plan B" } } }),
    "form only": section("c", { form }),
    "nothing declared": section("d", {}),
    "free text declared": section("e", { freeText: true }),
  };
  for (const [what, value] of Object.entries(shapes)) {
    page.render(value);
    assert.ok(page.field(), `${what}: the ask takes a written reply`);
    // What the Agent declared is still there, with its own way to send.
    if (value.ask.reply.options)
      assert.equal(page.document.querySelectorAll(".home-ask-options button").length, 2, what);
    if (value.ask.reply.choice)
      assert.equal(page.document.querySelectorAll(".home-choice").length, 2, what);
    if (value.ask.reply.form) assert.ok(page.document.querySelector(".clarification"), what);
  }
  assert.deepEqual(page.posts, [], "drawing an ask sends nothing");
  assert.deepEqual(page.errors, []);
});

test("freeText only names the field; it never decides whether there is one", (t) => {
  const page = mount();
  t.after(page.close);
  page.render(section("a", { options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }));
  const standard = page.field().placeholder;
  assert.match(standard, /\S/);
  page.render(section("b", { freeText: true }));
  assert.equal(page.field().placeholder, standard, "declaring free text changes nothing");
  page.render(section("c", { choice: { a: { id: "a", label: "A" }, b: { id: "b", label: "B" } },
    freeText: { prompt: "Say which and why" } }));
  assert.equal(page.field().placeholder, "Say which and why", "a prompt names the field");
});

test("an empty reply cannot be sent", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render(section("a", { options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }));
  assert.equal(page.sendButton().disabled, true);
  await page.type("   ");
  assert.equal(page.sendButton().disabled, true, "blank text is not a reply");
  page.sendButton().click();
  await tick();
  assert.deepEqual(page.posts, []);
  await page.type("Yes, but after the docs land");
  assert.equal(page.sendButton().disabled, false);
});

test("a choice-only ask answered in words sends the text, with no choice id", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render(section("plan", { choice: { a: { id: "plan-a", label: "Plan A" }, b: { id: "plan-b", label: "Plan B" } } }));
  await page.type("Plan B, but keep the old import for a week.");
  page.sendButton().click();
  await tick();
  const sent = page.posts.filter((post) => post.method === "POST");
  assert.equal(sent.length, 1, JSON.stringify(page.posts));
  assert.match(sent[0].url, /\/api\/projects\/p1\/brief\/reply$/);
  assert.equal(sent[0].body.key, "plan");
  assert.equal(sent[0].body.text, "Plan B, but keep the old import for a week.");
  assert.equal(sent[0].body.choice, undefined, "written words are not a choice id");
  assert.equal(sent[0].body.agentId, "mori", "to the ask's owner unless the user picks another");
  // Answered: it waits for its owner, with no field until the user asks again.
  assert.ok(page.document.querySelector(".home-ask-replied"), "shown as replied");
  assert.equal(page.field(), null);
});

test("an ask already replied to keeps its answer until the user replies again", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render(section("a", { options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] },
    { state: "replied", repliedAt: new Date().toISOString(), replyText: "Yes, ship it" }));
  assert.equal(page.field(), null, "a replied ask is not a field to fill in again");
  const again = [...page.document.querySelectorAll("button")].find((button) => /again/i.test(button.textContent));
  assert.ok(again, "the user may reply again");
  again.click();
  await tick();
  assert.ok(page.field(), "and then writes in their own words");
  assert.deepEqual(page.posts, [], "asking to reply again sends nothing");
});
