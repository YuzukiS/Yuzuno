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

// YN-134 S3: Home's field takes images as the conversation's composer does,
// first on a Project's "Talk to the project": paste, drop or "+" saves them to
// the Project's images (POST /api/projects/{id}/images), the thumbnails show
// under the text and stay with the draft across a reload, a request or a
// follow-up sends their IDs (only when there are any), the page says when the
// front desk can't take images and an older Core refused them, and Point &
// Fix adds to the field itself, with no Agent to choose. The real components
// with a stand-in Core; synthetic data only.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "home-attachments-"));
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
const root=createRoot(document.getElementById('root'));
window.renderTalk=(props={})=>flushSync(()=>root.render(<CardAgents.Provider value={new Map(window.agents.map((a)=>[a.id,a]))}><ProjectTalk projectId="p1" projectName="Atlas" workspaceId="ws" readOnly={false} revision={0} leadCount={1} onCard={()=>{}} onNavigate={()=>{}} {...props}/></CardAgents.Provider>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "HomeAttachments", formats: ["iife"] } },
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
/** A content-addressed ID as Core makes them: 64 hex digits and the type. */
const id = (n) => `${String(n).padStart(64, "0")}.png`;
const DRAFTS = "yuzuno.project-talk-drafts.v1";
const OUTBOX = "yuzuno.project-talk-outbox.v1";
const SLOT = JSON.stringify(["ws", "p1", "request"]);

const base = { model: "m", color: "sage", cwd: "/w/atlas", goal: "", createdAt: "2026-11-12T00:00:00Z", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", status: "idle" };
const agents = [
  { ...base, id: "d", name: "Dev Lead", kind: "lead", harness: "codex" },
  // A harness that takes no images (none of today's three): the page says so before Core would.
  { ...base, id: "z", name: "Lab Lead", kind: "lead", harness: "other" },
];
const request = (n, extra = {}) => ({
  id: `r${n}`, n, text: `Request ${n}`, textBlocks: null, title: `Title ${n}`, createdAt: ago(60 - n), frontAgentId: "d",
  messageId: `m${n}`, delivery: "accepted", replies: [], notes: [], routes: [], cards: [], state: "waiting",
  progress: { cards: 0, ended: 0 }, lines: [], ...extra,
});
/** R-2 took an image and so did its follow-up; R-1 is as an older Core lists it, without `images`. */
const requests = () => [
  request(2, {
    images: [id(900)],
    replies: [{ n: 1, text: "And this one", textBlocks: null, images: [id(901)], at: ago(30), messageId: "m2-1",
      deliveredTo: [{ agentId: "d", delivery: "accepted" }] }],
  }),
  request(1),
];

// What Point & Fix needs from a browser, which jsdom lacks (as ui.test.mjs): decoding an image, drawing, object URLs.
function pointFixBrowser(window) {
  window.createImageBitmap = async () => ({ width: 40, height: 30, close() {} });
  window.URL.createObjectURL = () => "blob:point-fix";
  window.URL.revokeObjectURL = () => {};
  window.HTMLCanvasElement.prototype.getContext = function () {
    const canvas = this;
    canvas.areas = [];
    return { drawImage() {}, beginPath() {}, arc() {}, fill() {}, fillText() {}, strokeRect: (...box) => canvas.areas.push(box) };
  };
  window.HTMLCanvasElement.prototype.toBlob = function (done, type) {
    done(new window.Blob([`annotated ${JSON.stringify(this.areas)}`], { type }));
  };
}

function mount({ lang = "en", storage = {}, front = { version: 1, agentId: null, effectiveAgentId: "d" }, older = false } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://home-attachments.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.Range.prototype.getClientRects ||= () => [];
  window.Range.prototype.getBoundingClientRect ||= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  window.HTMLElement.prototype.scrollTo = function () {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.matchMedia = (query) => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  window.agents = agents;
  pointFixBrowser(window);
  const calls = [];
  const uploads = [];
  const saved = new Map();
  const state = { front, requests: requests(), hold: null };
  const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
  const read = (blob) => new Promise((done) => {
    const reader = new window.FileReader();
    reader.onload = () => done(String(reader.result));
    reader.readAsText(blob);
  });
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const call = { url: String(url), method, headers: init.headers ?? {} };
    calls.push(call);
    if (method === "POST" && call.url.endsWith("/api/projects/p1/images")) {
      if (state.hold) await state.hold;
      const content = await read(init.body);
      uploads.push({ type: call.headers["Content-Type"], content });
      // Content-addressed: the same bytes are the same image.
      if (!saved.has(content)) saved.set(content, id(saved.size + 1));
      return answer({ id: saved.get(content), width: 40, height: 30, bytes: content.length });
    }
    if (method === "GET" && /\/api\/projects\/p1\/images\/[0-9a-f]{64}\.png$/.test(call.url))
      return { ok: true, status: 200, blob: async () => new window.Blob(["png-bytes"], { type: "image/png" }) };
    call.body = init.body ? JSON.parse(init.body) : null;
    if (method === "GET" && call.url.endsWith("/front-desk")) return answer(state.front);
    if (method === "GET" && /\/requests(\?|$)/.test(call.url)) return answer({ requests: state.requests, hasMore: false });
    // A Core from before Home's images: serde's own words for a field it does not know.
    if (method === "POST" && older && call.body?.images)
      return answer({ error: "Failed to deserialize the JSON body into the target type: unknown field `images`, expected one of `workspaceId`, `text`, `textBlocks`, `clientMessageId`" }, 422);
    const receipt = { input: { text: call.body?.text, clientMessageId: call.body?.clientMessageId }, status: "accepted", turnId: "t1", error: null };
    if (method === "POST" && call.url.endsWith("/replies")) return answer({ reply: { n: 2 }, receipts: [receipt] });
    if (method === "POST" && call.url.endsWith("/requests")) return answer({ request: { n: 3 }, receipt });
    return answer({});
  };
  window.eval(bundle);
  const document = window.document;
  const compose = () => document.querySelector(".project-talk-compose");
  const button = (label, scope = document) =>
    [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
  const field = () => document.querySelector(".project-talk-field [data-composer-input]");
  const thumbs = () => [...document.querySelectorAll(".project-talk-field .input-image")];
  const send = () => document.querySelector(".project-talk-send");
  const posts = (pattern) => calls.filter((c) => c.method === "POST" && pattern.test(c.url));
  const stored = () => JSON.parse(window.localStorage.getItem(DRAFTS) || "{}")[SLOT] ?? null;
  const file = (name, content) => new window.File([content], name, { type: "image/png" });
  function paste(files, text = "") {
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: files.map((f) => ({ kind: "file", getAsFile: () => f })), files, getData: (type) => (type === "text/plain" ? text : "") },
    });
    field().dispatchEvent(event);
  }
  function choose(label, files) {
    const picker = document.querySelector(`.project-talk-field input[aria-label="${label}"]`);
    Object.defineProperty(picker, "files", { configurable: true, value: files });
    picker.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  function type(input, value) {
    const prototype = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  return { window, document, errors, calls, uploads, state, compose, button, field, thumbs, send, posts, stored, file, paste, choose, type,
    close: () => window.close() };
}

async function talk(options) {
  const page = mount(options);
  page.window.renderTalk();
  await until(() => page.document.querySelector('.project-talk-mine[data-words="2"]'), "the requests are read");
  await tick();
  return page;
}

test("images pasted, chosen or dropped are saved to the project, shown under the text, removed, and kept with the draft", async (t) => {
  const page = await talk();
  t.after(page.close);
  assert.ok(page.button("Add", page.compose()), "the field has its “+”");
  setComposerText(page.field(), "The card overflows");
  page.paste([page.file("one.png", "one")]);
  await until(() => page.thumbs().length === 1, "the pasted image is saved and shown");
  const upload = page.calls.find((c) => c.method === "POST" && c.url.endsWith("/images"));
  assert.match(upload.url, /\/api\/projects\/p1\/images$/, "to the project's images, not an Agent's");
  assert.equal(upload.headers["Content-Type"], "image/png");
  page.choose("Choose images", [page.file("two.png", "two"), page.file("three.png", "three")]);
  await until(() => page.thumbs().length === 3, "the chosen images are saved and shown");
  const drop = new page.window.Event("drop", { bubbles: true, cancelable: true });
  const dropped = page.file("four.png", "four");
  Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], items: [{ kind: "file", getAsFile: () => dropped }], files: [dropped] } });
  page.document.querySelector(".project-talk-field .home-composer .input-images").dispatchEvent(drop);
  await until(() => page.thumbs().length === 4, "the dropped image is saved and shown");
  assert.deepEqual(page.uploads.map((u) => u.content), ["one", "two", "three", "four"]);
  assert.equal(page.thumbs()[0].querySelector("img").getAttribute("src"), `/api/projects/p1/images/${id(1)}?thumb=true`);
  assert.equal(composerText(page.field()), "The card overflows", "the words stay as written");
  assert.deepEqual(page.stored().images.map((image) => [image.id, image.name]),
    [[id(1), "one.png"], [id(2), "two.png"], [id(3), "three.png"], [id(4), "four.png"]], "kept with the draft in this browser");

  page.button("Remove image 2").click();
  await until(() => page.thumbs().length === 3, "the image is removed");
  assert.deepEqual(page.stored().images.map((image) => image.name), ["one.png", "three.png", "four.png"]);

  // Another visit finds the draft with its images; images not as this page keeps them are left out.
  const again = await talk({ storage: { [DRAFTS]: page.window.localStorage.getItem(DRAFTS) } });
  t.after(again.close);
  assert.equal(composerText(again.field()), "The card overflows");
  assert.deepEqual(again.thumbs().map((thumb) => thumb.querySelector("img").getAttribute("src")),
    [id(1), id(3), id(4)].map((image) => `/api/projects/p1/images/${image}?thumb=true`));
  const bad = await talk({ storage: { [DRAFTS]: JSON.stringify({ [SLOT]: { text: "Kept words", at: new Date().toISOString(), images: [{ id: "../x" }] } }) } });
  t.after(bad.close);
  assert.equal(composerText(bad.field()), "Kept words");
  assert.equal(bad.thumbs().length, 0);
  assert.deepEqual([...page.errors, ...again.errors, ...bad.errors], []);
});

test("a request and a follow-up send their images' IDs, only when there are any; the conversation shows them", async (t) => {
  const page = await talk();
  t.after(page.close);
  // What was sent before shows its images, read from the project's; R-1, as an older Core lists it, shows none.
  const shown = (selector) => [...page.document.querySelectorAll(`${selector} .input-image img`)].map((img) => img.getAttribute("src"));
  assert.deepEqual(shown('.project-talk-mine[data-words="2"]'), [`/api/projects/p1/images/${id(900)}?thumb=true`]);
  assert.deepEqual(shown('.project-talk-mine[data-reply="2:1"]'), [`/api/projects/p1/images/${id(901)}?thumb=true`]);
  assert.deepEqual(shown('.project-talk-mine[data-words="1"]'), []);
  assert.equal(page.document.querySelector('.project-talk-mine[data-words="2"] .input-image-remove'), null, "nothing to remove there");

  setComposerText(page.field(), "  See the screenshot  ");
  page.paste([page.file("shot.png", "shot")]);
  await until(() => page.thumbs().length === 1, "the image is saved");
  page.send().click();
  await until(() => page.posts(/\/requests$/).length === 1, "the request is sent");
  const [first] = page.posts(/\/requests$/);
  assert.deepEqual(Object.keys(first.body).sort(), ["clientMessageId", "images", "text", "workspaceId"]);
  assert.deepEqual(first.body.images, [id(1)]);
  assert.equal(first.body.text, "See the screenshot");
  await until(() => !page.thumbs().length && !composerText(page.field()), "sent and emptied");
  assert.equal(page.stored(), null);

  setComposerText(page.field(), "No picture this time");
  await tick();
  page.send().click();
  await until(() => page.posts(/\/requests$/).length === 2, "the second request is sent");
  assert.equal("images" in page.posts(/\/requests$/)[1].body, false, "no images, no field: an older Core takes it as before");
  await until(() => !composerText(page.field()) && !page.send().querySelector(".spin"), "the second is sent and emptied");

  page.button("Follow up “Title 2”").click();
  await tick();
  setComposerText(page.field(), "One more");
  page.paste([page.file("more.png", "more")]);
  await until(() => page.thumbs().length === 1, "the follow-up's image is saved");
  await tick();
  assert.equal(page.send().disabled, false,
    `the follow-up can be sent: ${page.compose().textContent} | ${page.window.localStorage.getItem(DRAFTS)} | ${page.window.localStorage.getItem(OUTBOX)}`);
  page.send().click();
  await until(() => page.posts(/\/replies$/).length || page.compose().querySelector('[role="alert"]') || page.posts(/\/requests$/).length === 3,
    "the follow-up is sent or refused");
  assert.equal(page.posts(/\/requests\/2\/replies$/).length, 1,
    `the follow-up is sent: ${JSON.stringify(page.calls.filter((c) => c.method === "POST").map((c) => [c.url, c.body]))} | ${page.compose().textContent}`);
  assert.deepEqual(page.posts(/\/requests\/2\/replies$/)[0].body.images, [id(2)]);
  assert.deepEqual(page.errors, []);
});

test("nothing is sent while images save, nor with images the front desk can't take; it says why, in Chinese too", async (t) => {
  const page = await talk({ front: { version: 1, agentId: "z", effectiveAgentId: "z" } });
  t.after(page.close);
  setComposerText(page.field(), "Look at this");
  await tick();
  assert.equal(page.send().disabled, false, "words alone go");
  let release;
  page.state.hold = new Promise((resolve) => (release = resolve));
  page.paste([page.file("slow.png", "slow")]);
  await until(() => page.button("Add", page.compose())?.getAttribute("aria-busy") === "true", "“+” turns while it saves");
  assert.equal(page.send().disabled, true, "not while images are saving");
  page.state.hold = null;
  release();
  await until(() => page.thumbs().length === 1, "saved");
  const note = () => page.document.querySelector('.project-talk-field .home-composer-note[role="status"]');
  assert.equal(note().textContent,
    "Lab Lead, the project's front desk, can't receive images; Codex, Claude and OpenCode Agents can. Remove the images, or choose another front desk in settings.");
  assert.equal(page.send().disabled, true, "not with images the front desk can't take");
  page.button("Remove image 1").click();
  await until(() => !note(), "said only while there are images");
  assert.equal(page.send().disabled, false);

  const zh = await talk({ lang: "zh", front: { version: 1, agentId: "z", effectiveAgentId: "z" } });
  t.after(zh.close);
  zh.paste([zh.file("a.png", "a")]);
  await until(() => zh.thumbs().length === 1, "saved");
  assert.equal(zh.document.querySelector('.project-talk-field .home-composer-note[role="status"]').textContent,
    "Lab Lead（项目的前台）不能接收图片（Codex、Claude 和 OpenCode Agent 可以）。移除图片，或在设置里换一个前台。");
  assert.ok(zh.button("添加", zh.compose()), "“+” in Chinese");
  assert.deepEqual([...page.errors, ...zh.errors], []);
});

test("an older Core refuses the images: it says so, sends nothing, and the draft keeps its words and images", async (t) => {
  const page = await talk({ older: true });
  t.after(page.close);
  setComposerText(page.field(), "With a picture");
  page.paste([page.file("pic.png", "pic")]);
  await until(() => page.thumbs().length === 1, "saved");
  page.send().click();
  await until(() => page.compose().querySelector('[role="alert"]'), "the refusal is shown");
  assert.equal(page.compose().querySelector('[role="alert"]').textContent,
    "This Core can't take images with what you say yet, so nothing was sent. Update Core, or remove the images and send again.");
  assert.equal(composerText(page.field()), "With a picture");
  assert.equal(page.thumbs().length, 1);
  assert.equal(page.window.localStorage.getItem(OUTBOX), null, "nothing was sent, so nothing waits to be sent again");
  assert.doesNotMatch(page.compose().textContent, /No answer from Core yet/);
  assert.deepEqual(page.errors, []);
});

test("Point & Fix adds to the field itself: no Agent to choose, the notes after the words, the images after the images", async (t) => {
  const page = await talk();
  t.after(page.close);
  const dialog = () => page.document.querySelector(".point-fix-dialog");
  setComposerText(page.field(), "Before");
  page.button("Add", page.compose()).click();
  await until(() => page.button("Mark up an image"), "the menu opens");
  assert.deepEqual([...page.document.querySelectorAll(".composer-add-item")].map((item) => item.getAttribute("aria-label")),
    ["Add images", "Mark up an image", "Add files"]);
  page.button("Mark up an image").click();
  page.choose("Choose an image to mark", [page.file("screen.png", "png-bytes")]);
  await until(() => dialog()?.querySelector(".point-fix-image svg"), "the chosen image opens for marking");
  assert.equal(dialog().querySelector(".point-fix-target select"), null, "no Agent to choose");
  assert.equal(dialog().querySelector(".point-fix-target").textContent, "Adds to: Talk to Atlas");
  page.button("Add area").click();
  await tick();
  page.type(dialog().querySelector('[aria-label="Area 1 comment"]'), "Too tight");
  page.button("Add", dialog()).click();
  await until(() => !dialog() && page.thumbs().length === 2, "added: the annotated image and the original");
  assert.deepEqual(page.uploads.map((u) => u.content), ["annotated [[10,7.5,20,15]]", "png-bytes"].map((c, i) => (i ? c : page.uploads[0].content)));
  assert.match(page.uploads[0].content, /^annotated /);
  const text = composerText(page.field());
  assert.ok(text.startsWith("Before\n\nPoint & Fix feedback on “screen.png” (40×30 px): 1 marked area in the attached annotated image, with the original image attached."), text);
  assert.match(text, /Source: an image you chose \(screen\.png\)/);
  assert.match(text, /1\. Area at .*: Too tight$/);
  assert.equal(page.stored().images.length, 2);

  // An image already in the field: only the annotated copy is added, and the notes say where the original is.
  page.button("Mark up image 2").click();
  await until(() => dialog()?.querySelector(".point-fix-image svg"), "the saved image opens for marking");
  assert.match(dialog().textContent, /The original is already there; only the annotated copy is added\./);
  page.button("Add area").click();
  await tick();
  // Another area than the first time: another annotated image.
  page.type(dialog().querySelector('[aria-label="Area 1 left (px)"]'), "1");
  await tick();
  page.button("Add", dialog()).click();
  await until(() => !dialog() && page.thumbs().length === 3, "only the annotated copy is added");
  assert.equal(page.uploads.length, 3);
  assert.match(composerText(page.field()), /the original is attached image 2 \(“screen\.png”\)/);
  assert.match(composerText(page.field()), /Source: the image screen\.png you attached/);

  // An image the conversation shows opens for marking too, and adds here.
  page.document.querySelector('.project-talk-mine[data-words="2"] .input-image-open').click();
  await until(() => page.button("Mark up"), "the image opens");
  page.button("Mark up").click();
  await until(() => dialog()?.querySelector(".point-fix-image svg"), "the sent image opens for marking");
  assert.equal(dialog().querySelector(".point-fix-target").textContent, "Adds to: Talk to Atlas");
  assert.ok(page.calls.some((c) => c.method === "GET" && c.url.endsWith(`/api/projects/p1/images/${id(900)}`)), "read from the project's images");
  page.button("Cancel", dialog()).click();
  await until(() => !dialog(), "closed");
  assert.deepEqual(page.errors, []);
});
