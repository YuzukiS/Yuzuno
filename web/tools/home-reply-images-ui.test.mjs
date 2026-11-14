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

// YN-134 S4: a card's reply and an Ask's words take images as Home's field
// does since S3: saved to the Project's images, sent by ID with the reply,
// only when there are any. The page says when the Agent chosen can't take
// images, and when an older Core refused them; a pick and a form's answers
// never carry images, which stay in the draft; an answered Ask shows the
// images its reply took. The real components with a stand-in Core.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "home-reply-images-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {AskReply} from ${JSON.stringify(path.join(root, "src/home/AskReply.tsx"))};
import {CardReply, KeptCardReplies} from ${JSON.stringify(path.join(root, "src/home/CardReply.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderCard=(props)=>flushSync(()=>root.render(<CardReply {...props}/>));
window.renderAsk=(props)=>flushSync(()=>root.render(<AskReply {...props}/>));
window.renderKept=(props)=>flushSync(()=>root.render(<KeptCardReplies {...props}/>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "HomeReplyImages", formats: ["iife"] } },
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
const id = (n) => `${String(n).padStart(64, "0")}.png`;
const CARD_DRAFTS = "yuzuno.home-card-drafts.v1";
const ASK_DRAFTS = "yuzuno.home-ask-drafts.v1";
const OUTBOX = "yuzuno.home-outbox.v1";

const agent = (id, name, harness) => ({ id, name, harness, status: "idle", cwd: "/fixture", model: "", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" });
// Lab is an Agent whose harness takes no images (Core's input_images::takes_images).
const agents = [agent("mori", "Mori", "codex"), agent("oc", "Ocean", "opencode"), agent("lab", "Lab", "dsh")];
const owner = { agentId: "mori", name: "Mori", state: "active" };
const body = { root: "body", elements: { body: { type: "BriefBody", props: {}, children: [] } } };
const base = { owner, updatedAt: new Date().toISOString(), updatedTurnId: null, attachments: [], refs: {}, seen: null, history: false, body };
const report = { ...base, key: "notes", kind: "report", title: "Notes", version: 2 };
const form = { id: "plan", title: "Which parts ship first?",
  fields: [{ id: "part", type: "single", label: "First part", required: false, options: [{ id: "ui", label: "The UI" }, { id: "core", label: "Core" }] }] };
const ask = (reply, extra = {}) => ({ ...base, key: "pick", kind: "ask", title: "Which layout?", version: 3,
  ask: { question: "Which layout?", state: "open", reply, ...extra } });

function mount({ lang = "en", storage = {}, older = false } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://home-reply-images.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.Range.prototype.getClientRects ||= () => [];
  window.Range.prototype.getBoundingClientRect ||= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.matchMedia = (query) => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {} });
  // A form's answers are copied with it (as ask-version-ui.test.mjs gives it); jsdom has none.
  window.structuredClone ??= structuredClone;
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  const posts = [];
  const saved = new Map();
  const answer = (value, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(value), text: async () => JSON.stringify(value) });
  const read = (blob) => new Promise((done) => {
    const reader = new window.FileReader();
    reader.onload = () => done(String(reader.result));
    reader.readAsText(blob);
  });
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    if (method === "POST" && String(url).endsWith("/api/projects/p1/images")) {
      const content = await read(init.body);
      if (!saved.has(content)) saved.set(content, id(saved.size + 1));
      posts.push({ url: String(url), upload: content });
      return answer({ id: saved.get(content), width: 40, height: 30, bytes: content.length });
    }
    const sent = init.body ? JSON.parse(init.body) : null;
    posts.push({ url: String(url), method, body: sent });
    if (older && sent?.images)
      return answer({ error: "Failed to deserialize the JSON body into the target type: unknown field `images`, expected one of `key`, `agentId`, `text`" }, 422);
    return answer({ input: { text: sent?.text ?? "", clientMessageId: sent?.clientMessageId ?? "" }, status: "accepted", turnId: "t2", error: null });
  };
  window.eval(bundle);
  const document = window.document;
  const context = { projectId: "p1", workspaceId: "ws", agents, readOnly: false, onSent: () => {} };
  const field = () => document.querySelector(".home-text-reply [data-composer-input]");
  const thumbs = () => [...document.querySelectorAll(".home-text-reply .input-image")];
  const sendButton = () => document.querySelector(".home-text-reply button[type=submit]");
  const replies = () => posts.filter((p) => p.url.endsWith("/brief/reply"));
  const uploads = () => posts.filter((p) => p.upload !== undefined);
  const note = () => document.querySelector('.home-text-reply .home-composer-note[role="status"]');
  const pick = (agentId) => {
    const select = document.querySelector(".home-reply-target select");
    select.value = agentId;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  function paste(name, content) {
    const file = new window.File([content], name, { type: "image/png" });
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { items: [{ kind: "file", getAsFile: () => file }], files: [file], getData: () => "" } });
    field().dispatchEvent(event);
  }
  const button = (label, scope = document) =>
    [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
  return {
    window, document, errors, posts, context, field, thumbs, sendButton, replies, uploads, note, pick, paste, button,
    card: () => window.renderCard({ section: report, projectId: "p1", workspaceId: "ws", agents, opened: true, onClose: () => {} }),
    ask: (section) => window.renderAsk({ section, ...context }),
    close: () => window.close(),
  };
}

test("a card's reply takes images: saved to the project, sent by their IDs, said once sent, and kept with the draft", async (t) => {
  const page = mount();
  t.after(page.close);
  page.card();
  await until(page.field, "the reply field");
  assert.ok(page.button("Add", page.document.querySelector(".home-text-reply")), "its “+”");
  setComposerText(page.field(), "Check the numbers");
  page.paste("one.png", "one");
  await until(() => page.thumbs().length === 1, "the image is saved and shown");
  assert.match(page.uploads()[0].url, /\/api\/projects\/p1\/images$/);
  const stored = JSON.parse(page.window.localStorage.getItem(CARD_DRAFTS));
  assert.deepEqual(Object.values(stored)[0].images.map((image) => [image.id, image.name]), [[id(1), "one.png"]], "kept with the draft");

  // Another visit finds the draft with its image; a draft of images only is kept too.
  const again = mount({ storage: { [CARD_DRAFTS]: page.window.localStorage.getItem(CARD_DRAFTS) } });
  t.after(again.close);
  again.card();
  await until(() => again.thumbs().length === 1, "the kept image");
  assert.equal(composerText(again.field()), "Check the numbers");

  page.sendButton().click();
  await until(() => page.replies().length === 1, "the reply is sent");
  const [sent] = page.replies();
  assert.equal(sent.body.key, "notes");
  assert.equal(sent.body.version, 2);
  assert.deepEqual(sent.body.images, [id(1)]);
  await until(() => page.document.querySelector(".home-card-reply .home-note[role=status]")?.textContent.includes("1 image went with it."), "said once sent");
  assert.match(page.document.querySelector(".home-card-reply").textContent, /Sent to Mori, referring to version 2\. 1 image went with it\./);
  assert.equal(page.thumbs().length, 0, "the next reply begins afresh");

  setComposerText(page.field(), "And no picture");
  await tick();
  page.sendButton().click();
  await until(() => page.replies().length === 2, "the second reply is sent");
  assert.equal("images" in page.replies()[1].body, false, "no images, no field");
  assert.deepEqual([...page.errors, ...again.errors], []);
});

test("an Agent that can't take images: said under them, in Chinese too, and nothing goes; an OpenCode Agent can", async (t) => {
  for (const [lang, expected] of [
    ["en", "Lab can't receive images; Codex, Claude and OpenCode Agents can. Remove the images or choose someone else."],
    ["zh", "Lab 不能接收图片（Codex、Claude 和 OpenCode Agent 可以）。移除图片，或换一个收件人。"],
  ]) {
    const page = mount({ lang });
    t.after(page.close);
    page.card();
    await until(page.field, "the reply field");
    page.pick("lab");
    setComposerText(page.field(), "Look");
    await tick();
    assert.equal(page.sendButton().disabled, false, "words alone go to Lab");
    page.paste("a.png", "a");
    await until(() => page.thumbs().length === 1, "saved");
    assert.equal(page.note()?.textContent, expected);
    assert.equal(page.sendButton().disabled, true);
    page.pick("oc");
    await tick();
    assert.equal(page.note(), null, "an OpenCode Agent takes images");
    assert.equal(page.sendButton().disabled, false);
    assert.deepEqual(page.errors, []);
  }
  // The same for an Ask's words.
  const page = mount();
  t.after(page.close);
  page.ask(ask({ freeText: true }));
  await until(page.field, "the Ask's field");
  page.pick("lab");
  setComposerText(page.field(), "Option A, see this");
  page.paste("b.png", "b");
  await until(() => page.thumbs().length === 1, "saved");
  assert.match(page.note().textContent, /^Lab can't receive images/);
  assert.equal(page.sendButton().disabled, true);
  assert.deepEqual(page.errors, []);
});

test("an Ask's words take images; a pick and a form's answers never do, and the images stay in the draft", async (t) => {
  const page = mount();
  t.after(page.close);
  page.ask(ask({ options: [{ id: "a", label: "Layout A" }, { id: "b", label: "Layout B" }], freeText: true }));
  await until(page.field, "the Ask's field");
  setComposerText(page.field(), "A, with the menu from B");
  page.paste("menu.png", "menu");
  await until(() => page.thumbs().length === 1, "saved");
  page.button("Layout A").click();
  await until(() => page.replies().length === 1, "the pick is sent");
  assert.equal(page.replies()[0].body.choice, "a");
  assert.equal("images" in page.replies()[0].body, false, "a pick goes without images");
  const kept = JSON.parse(page.window.localStorage.getItem(ASK_DRAFTS));
  assert.deepEqual(Object.values(kept)[0].images.map((image) => image.id), [id(1)], "the images stay with the words");

  // Answered again in words: they go with the images, to the version on screen.
  const words = mount({ storage: { [ASK_DRAFTS]: page.window.localStorage.getItem(ASK_DRAFTS) } });
  t.after(words.close);
  words.ask(ask({ freeText: true }));
  await until(() => words.thumbs().length === 1, "the kept image");
  words.sendButton().click();
  await until(() => words.replies().length === 1, "the words are sent");
  assert.deepEqual(words.replies()[0].body.images, [id(1)]);
  assert.equal(words.replies()[0].body.askVersion, 3);
  assert.equal(words.replies()[0].body.text, "A, with the menu from B");

  // A form takes no images: no "+" in it, and its answers go without the field's images.
  const formed = mount();
  t.after(formed.close);
  formed.ask(ask({ form }));
  await until(() => formed.document.querySelector(".clarification") && formed.field(), "the form and the words' field");
  assert.equal(formed.document.querySelector(".clarification .composer-plus"), null, "no “+” in the form");
  assert.equal(formed.document.querySelectorAll(".home-ask-reply .composer-plus").length, 1, "only the words' field has one");
  formed.paste("c.png", "c");
  await until(() => formed.thumbs().length === 1, "saved");
  const submitForm = formed.document.querySelector(".clarification footer .primary-button");
  assert.ok(submitForm && !submitForm.disabled, `the form can be sent: ${formed.document.querySelector(".clarification")?.textContent}`);
  submitForm.click();
  const said = () => formed.document.querySelector(".clarification-error, .clarification-delivery")?.textContent.trim();
  for (let i = 0; i < 80 && !formed.replies().length && !said(); i++) await tick(25);
  assert.equal(formed.replies().length, 1, `the form's answers are sent: ${formed.document.querySelector(".clarification")?.textContent}`);
  assert.ok(formed.replies()[0].body.form, "a form's answers");
  assert.equal("images" in formed.replies()[0].body, false, "a form's answers go without images");
  assert.equal(formed.thumbs().length, 1, "the images stay");
  assert.deepEqual([...page.errors, ...words.errors, ...formed.errors], []);
});

test("an older Core refuses the images: said, nothing waits to go again, and the draft keeps its words and images", async (t) => {
  for (const shape of ["card", "ask"]) {
    const page = mount({ older: true });
    t.after(page.close);
    if (shape === "card") page.card();
    else page.ask(ask({ freeText: true }));
    await until(page.field, "the field");
    setComposerText(page.field(), "With a picture");
    page.paste("pic.png", "pic");
    await until(() => page.thumbs().length === 1, "saved");
    page.sendButton().click();
    await until(() => page.document.querySelector('[role="alert"]'), "the refusal");
    assert.equal(page.document.querySelector('[role="alert"]').textContent,
      "This Core can't take images with a reply yet, so nothing was sent. Update Core, or remove the images and send again.", shape);
    assert.equal(composerText(page.field()), "With a picture");
    assert.equal(page.thumbs().length, 1);
    assert.equal(page.window.localStorage.getItem(OUTBOX), null, `${shape}: never submitted, so no retry record`);
    assert.deepEqual(page.errors, []);
  }
});

test("an answered Ask shows the images its reply took; a reply kept after its card left shows its images", async (t) => {
  const page = mount();
  t.after(page.close);
  page.ask(ask({ freeText: true }, { state: "replied", repliedAt: new Date().toISOString(), replyText: "B, see the screenshot", replyImages: [id(7), id(8)] }));
  await until(() => page.document.querySelector(".home-ask-replied"), "the replied block");
  assert.deepEqual([...page.document.querySelectorAll(".home-ask-replied .input-image img")].map((img) => img.getAttribute("src")),
    [id(7), id(8)].map((image) => `/api/projects/p1/images/${image}?thumb=true`));
  assert.equal(page.document.querySelector(".home-ask-replied .input-image-remove"), null, "nothing to remove there");

  const draft = { key: "gone", text: "About the old card", title: "Old card", agentId: "mori", at: new Date().toISOString(),
    images: [{ id: id(9), name: "old.png", width: 40, height: 30, bytes: 3 }] };
  const kept = mount({ storage: { [CARD_DRAFTS]: JSON.stringify({ [JSON.stringify(["ws", "p1", "gone", "card"])]: draft }) } });
  t.after(kept.close);
  kept.window.renderKept({ projectId: "p1", workspaceId: "ws", agents, cardKeys: [], referable: [] });
  await until(() => kept.document.querySelector(".home-kept-reply"), "the kept reply");
  assert.deepEqual([...kept.document.querySelectorAll(".home-kept-reply .input-image img")].map((img) => img.getAttribute("src")),
    [`/api/projects/p1/images/${id(9)}?thumb=true`]);
  assert.deepEqual([...page.errors, ...kept.errors], []);
});
