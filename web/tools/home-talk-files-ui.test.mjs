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

// YN-145 F7: a Project's "Talk to the project" takes files as it takes images
// (YN-134 S3): chosen, dropped or pasted, saved to the Project's files, shown
// under the text, kept with the draft, sent with a request or follow-up (only
// when there are any), and shown with what was sent, downloaded from the
// Project's route. The page says when the front desk can't take files, and
// when an older Core refused them. The real components with a stand-in Core.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "home-talk-files-"));
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
    build: { write: false, lib: { entry, name: "HomeTalkFiles", formats: ["iife"] } },
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
const id = (n) => String(n).padStart(64, "0");
const DRAFTS = "yuzuno.project-talk-drafts.v1";
const OUTBOX = "yuzuno.project-talk-outbox.v1";
const SLOT = JSON.stringify(["ws", "p1", "request"]);

const base = { model: "m", color: "sage", cwd: "/w/atlas", goal: "", createdAt: "2026-11-12T00:00:00Z", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", status: "idle" };
const agents = [
  { ...base, id: "d", name: "Dev Lead", kind: "lead", harness: "codex" },
  // A harness that takes no files (none of today's three): the page says so before Core would.
  { ...base, id: "z", name: "Lab Lead", kind: "lead", harness: "other" },
];
const file = (n, name, bytes = 20) => ({ id: id(n), name, bytes });
const request = (n, extra = {}) => ({
  id: `r${n}`, n, text: `Request ${n}`, textBlocks: null, title: `Title ${n}`, createdAt: ago(60 - n), frontAgentId: "d",
  messageId: `m${n}`, delivery: "accepted", replies: [], notes: [], routes: [], cards: [], state: "waiting",
  progress: { cards: 0, ended: 0 }, lines: [], files: [], ...extra,
});
/** R-2 took files and so did its follow-up; R-1 is as an older Core lists it, without `files`. */
const requests = () => [
  request(2, {
    files: [file(900, "plan.pdf", 1200)],
    replies: [{ n: 1, text: "And this one", textBlocks: null, images: [], files: [file(901, "log.csv", 90)], at: ago(30),
      messageId: "m2-1", deliveredTo: [{ agentId: "d", delivery: "accepted" }] }],
  }),
  request(1),
];

function mount({ lang = "en", storage = {}, front = { version: 1, agentId: null, effectiveAgentId: "d" }, older = false } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://home-talk-files.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
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
  const calls = [];
  const uploads = [];
  const saved = new Map();
  const state = { front, requests: requests() };
  const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
  const read = (blob) => new Promise((done) => {
    const reader = new window.FileReader();
    reader.onload = () => done(String(reader.result));
    reader.readAsText(blob);
  });
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const address = new URL(String(url), "https://home-talk-files.test/");
    const call = { url: String(url), method, headers: init.headers ?? {} };
    calls.push(call);
    if (method === "POST" && address.pathname === "/api/projects/p1/files") {
      const content = await read(init.body);
      if (!saved.has(content)) saved.set(content, id(saved.size + 1));
      const name = address.searchParams.get("name") || "file";
      uploads.push({ name, type: call.headers["Content-Type"], content });
      return answer({ id: saved.get(content), name, bytes: init.body.size });
    }
    if (method === "POST" && address.pathname === "/api/projects/p1/images") {
      const content = await read(init.body);
      return answer({ id: id(500 + content.length), width: 40, height: 30, bytes: init.body.size });
    }
    call.body = init.body ? JSON.parse(init.body) : null;
    if (method === "GET" && call.url.endsWith("/front-desk")) return answer(state.front);
    if (method === "GET" && /\/requests(\?|$)/.test(call.url)) return answer({ requests: state.requests, hasMore: false });
    // A Core from before Home's files: serde's own words for a field it does not know.
    if (method === "POST" && older && call.body?.files)
      return answer({ error: "Failed to deserialize the JSON body into the target type: unknown field `files`, expected one of `workspaceId`, `text`, `textBlocks`, `clientMessageId`" }, 422);
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
  const chips = () => [...document.querySelectorAll(".project-talk-field .input-file")];
  const send = () => document.querySelector(".project-talk-send");
  const posts = (pattern) => calls.filter((c) => c.method === "POST" && pattern.test(c.url));
  const stored = () => JSON.parse(window.localStorage.getItem(DRAFTS) || "{}")[SLOT] ?? null;
  const newFile = (name, content, type = "application/pdf") => new window.File([content], name, { type });
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
  function drop(files) {
    const event = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], items: files.map((f) => ({ kind: "file", getAsFile: () => f })), files } });
    document.querySelector(".project-talk-field .home-composer").dispatchEvent(event);
  }
  return { window, document, errors, calls, uploads, state, compose, button, field, chips, send, posts, stored, newFile, paste, choose, drop,
    close: () => window.close() };
}

async function talk(options) {
  const page = mount(options);
  page.window.renderTalk();
  await until(() => page.document.querySelector('.project-talk-mine[data-words="2"]'), "the requests are read");
  await tick();
  return page;
}

test("files chosen, dropped or pasted are saved to the project, shown, removed, and kept with the draft", async (t) => {
  const page = await talk();
  t.after(page.close);
  assert.ok(page.button("Add", page.compose()), "the field has its “+”");
  setComposerText(page.field(), "Two documents");
  page.paste([page.newFile("plan.pdf", "plan")]);
  await until(() => page.chips().length === 1, "the pasted file is saved and shown");
  const upload = page.calls.find((c) => c.method === "POST" && c.url.includes("/files?"));
  assert.match(upload.url, /\/api\/projects\/p1\/files\?name=plan\.pdf$/, "to the project's files, not an Agent's");
  assert.equal(upload.headers["Content-Type"], "application/octet-stream");
  page.choose("Choose files", [page.newFile("notes.txt", "notes", "text/plain"), page.newFile("data.csv", "csv", "text/csv")]);
  await until(() => page.chips().length === 3, "the chosen files are saved and shown");
  // A drop with an image and a file: the PNG is an image, the PDF a file.
  page.drop([page.newFile("shot.png", "png", "image/png"), page.newFile("spec.pdf", "spec")]);
  await until(() => page.chips().length === 4, "the dropped file is saved and shown");
  await until(() => page.document.querySelectorAll(".project-talk-field .input-image").length === 1, "the dropped image goes with the images");
  assert.deepEqual(page.uploads.map((u) => u.content), ["plan", "notes", "csv", "spec"]);
  assert.equal(page.chips()[0].querySelector(".input-file-name").textContent, "plan.pdf");
  assert.equal(page.chips()[0].querySelector(".input-file-size").textContent, "4 B");
  assert.equal(composerText(page.field()), "Two documents", "the words stay as written");
  assert.deepEqual(page.stored().files.map((file) => [file.id, file.name, file.bytes]),
    [[id(1), "plan.pdf", 4], [id(2), "notes.txt", 5], [id(3), "data.csv", 3], [id(4), "spec.pdf", 4]], "kept with the draft");

  page.document.querySelector('.project-talk-field button[aria-label="Remove notes.txt"]').click();
  await until(() => page.chips().length === 3, "the file is removed");
  assert.deepEqual(page.stored().files.map((file) => file.name), ["plan.pdf", "data.csv", "spec.pdf"]);

  // Another visit finds the draft with its files; files not as this page keeps them are left out.
  const again = await talk({ storage: { [DRAFTS]: page.window.localStorage.getItem(DRAFTS) } });
  t.after(again.close);
  assert.equal(composerText(again.field()), "Two documents");
  assert.deepEqual(again.chips().map((chip) => chip.querySelector(".input-file-name").textContent), ["plan.pdf", "data.csv", "spec.pdf"]);
  const bad = await talk({ storage: { [DRAFTS]: JSON.stringify({ [SLOT]: { text: "Kept words", at: new Date().toISOString(), files: [{ id: "../x" }] } }) } });
  t.after(bad.close);
  assert.equal(composerText(bad.field()), "Kept words");
  assert.equal(bad.chips().length, 0);
  assert.deepEqual([...page.errors, ...again.errors, ...bad.errors], []);
});

test("a request and a follow-up send their files, only when there are any; the conversation shows them", async (t) => {
  const page = await talk();
  t.after(page.close);
  // What was sent before shows its files, downloaded from the project; R-1, as an older Core lists it, shows none.
  const link = page.document.querySelector('.project-talk-mine[data-words="2"] .input-file a');
  assert.equal(link.getAttribute("href"), `/api/projects/p1/files/${id(900)}/plan.pdf`);
  assert.equal(link.getAttribute("download"), "plan.pdf");
  assert.equal(page.document.querySelector('.project-talk-mine[data-reply="2:1"] .input-file a').getAttribute("href"),
    `/api/projects/p1/files/${id(901)}/log.csv`);
  assert.equal(page.document.querySelector('.project-talk-mine[data-words="1"] .input-file'), null);
  assert.equal(page.document.querySelector('.project-talk-mine[data-words="2"] .input-file-remove'), null, "nothing to remove there");

  setComposerText(page.field(), "  See the plan  ");
  page.paste([page.newFile("plan.pdf", "plan")]);
  await until(() => page.chips().length === 1, "the file is saved");
  await until(() => !page.send().disabled, "the request can be sent");
  page.send().click();
  await until(() => page.posts(/\/requests$/).length === 1, "the request is sent");
  const [first] = page.posts(/\/requests$/);
  assert.deepEqual(Object.keys(first.body).sort(), ["clientMessageId", "files", "text", "workspaceId"]);
  assert.deepEqual(first.body.files, [{ id: id(1), name: "plan.pdf", bytes: 4 }]);
  assert.equal(first.body.text, "See the plan");
  await until(() => !page.chips().length && !composerText(page.field()), "sent and emptied");
  assert.equal(page.stored(), null);

  setComposerText(page.field(), "No file this time");
  await until(() => !page.send().disabled, "the second request can be sent");
  page.send().click();
  await until(() => page.posts(/\/requests$/).length === 2, "the second request is sent");
  assert.equal("files" in page.posts(/\/requests$/)[1].body, false, "no files, no field: an older Core takes it as before");
  await until(() => !composerText(page.field()) && !page.send().querySelector(".spin"), "the second is sent and emptied");

  page.button("Follow up “Title 2”").click();
  await tick();
  setComposerText(page.field(), "One more");
  page.paste([page.newFile("more.txt", "more", "text/plain")]);
  await until(() => page.chips().length === 1, "the follow-up's file is saved");
  await until(() => !page.send().disabled, "the follow-up can be sent");
  page.send().click();
  await until(() => page.posts(/\/replies$/).length || page.compose().querySelector('[role="alert"]'),
    "the follow-up is sent or refused");
  assert.equal(page.posts(/\/requests\/2\/replies$/).length, 1,
    `the follow-up is sent: ${JSON.stringify(page.calls.filter((c) => c.method === "POST").map((c) => [c.url, c.body]))}`);
  assert.deepEqual(page.posts(/\/requests\/2\/replies$/)[0].body.files, [{ id: id(2), name: "more.txt", bytes: 4 }]);
  assert.deepEqual(page.errors, []);
});

test("a field held for a missing front desk still downloads its kept files from the project", async (t) => {
  const kept = { id: id(800), name: "kept.pdf", bytes: 10 };
  const page = await talk({
    front: { version: 1, agentId: null, effectiveAgentId: null },
    storage: { [DRAFTS]: JSON.stringify({ [SLOT]: { text: "Kept words", files: [kept], at: new Date().toISOString() } }) },
  });
  t.after(page.close);
  assert.equal(page.send().disabled, true, "no front desk: nothing can be sent");
  const link = page.document.querySelector(".project-talk-field .input-file a");
  assert.equal(link.getAttribute("href"), `/api/projects/p1/files/${id(800)}/kept.pdf`,
    "a read-only draft downloads from the project, never /api/agents//files/...");
  assert.equal(link.getAttribute("download"), "kept.pdf");
  assert.deepEqual(page.errors, []);
});

test("nothing is sent with files the front desk can't take, nor while they save; an older Core's files stay here", async (t) => {
  const page = await talk({ front: { version: 1, agentId: "z", effectiveAgentId: "z" } });
  t.after(page.close);
  setComposerText(page.field(), "Look at this");
  await tick();
  assert.equal(page.send().disabled, false, "words alone go");
  page.paste([page.newFile("plan.pdf", "plan")]);
  await until(() => page.chips().length === 1, "saved");
  const note = () => page.document.querySelector('.project-talk-field .home-composer-note[role="status"]');
  assert.equal(note().textContent,
    "Lab Lead, the project's front desk, can't receive files; Codex, Claude and OpenCode Agents can. Remove the files, or choose another front desk in settings.");
  assert.equal(page.send().disabled, true, "not with files the front desk can't take");
  page.document.querySelector('.project-talk-field button[aria-label="Remove plan.pdf"]').click();
  await until(() => !page.chips().length, "removed");

  // A follow-up's Agents are Core's to know: the page sends, and Core refuses for them.
  const older = await talk({ older: true });
  t.after(older.close);
  setComposerText(older.field(), "An older Core");
  older.paste([older.newFile("kept.pdf", "kept")]);
  await until(() => older.chips().length === 1, "saved");
  await until(() => !older.send().disabled, "it can be sent");
  older.send().click();
  await until(() => older.compose().querySelector('[role="alert"]'), "the refusal is shown");
  assert.match(older.compose().querySelector('[role="alert"]').textContent,
    /This Core can't take files with what you say yet, so nothing was sent\. Update Core, or remove the files and send again\./);
  assert.equal(older.window.localStorage.getItem(OUTBOX), null, "not kept for a retry");
  assert.equal(older.chips().length, 1, "the files stay in the draft");
  assert.deepEqual([...page.errors, ...older.errors], []);
});
