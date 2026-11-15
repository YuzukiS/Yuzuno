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

// YN-145 F7: a card's reply and an Ask's words take files as Home's field
// takes images (YN-134 S4): saved to the Project's files, sent with the
// reply, only when there are any, by the reference Core answered with. The
// page says when the Agent chosen can't take files, an older Core refused
// them, and an answered Ask shows the files its reply took. The real
// components with a stand-in Core.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "home-reply-files-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {AskReply} from ${JSON.stringify(path.join(root, "src/home/AskReply.tsx"))};
import {CardReply} from ${JSON.stringify(path.join(root, "src/home/CardReply.tsx"))};
import * as files from ${JSON.stringify(path.join(root, "src/home/home-files.ts"))};
const root=createRoot(document.getElementById('root'));
window.renderCard=(props)=>flushSync(()=>root.render(<CardReply {...props}/>));
window.renderAsk=(props)=>flushSync(()=>root.render(<AskReply {...props}/>));
window.homeFiles=files;`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "HomeReplyFiles", formats: ["iife"] } },
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
const id = (n) => String(n).padStart(64, "0");
const CARD_DRAFTS = "yuzuno.home-card-drafts.v1";
const ASK_DRAFTS = "yuzuno.home-ask-drafts.v1";
const OUTBOX = "yuzuno.home-outbox.v1";

const agent = (id, name, harness, extra = {}) => ({ id, name, harness, status: "idle", cwd: "/fixture", model: "", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "", ...extra });
// Lab is an Agent whose harness takes no files; Far is on another machine, where
// Core copies files to a Codex or Claude Agent (F4); Way is an OpenCode Agent,
// which Core never puts on one, so the page refuses it all the same.
const agents = [agent("mori", "Mori", "codex"), agent("oc", "Ocean", "opencode"), agent("lab", "Lab", "dsh"),
  agent("far", "Far", "claude", { remote: { machine: { id: "m", name: "Mac", target: "x", codex: "", defaultCwd: "/w" } } }),
  agent("way", "Way", "opencode", { remote: { machine: { id: "m", name: "Mac", target: "x", codex: "", defaultCwd: "/w" } } })];
const owner = { agentId: "mori", name: "Mori", state: "active" };
const body = { root: "body", elements: { body: { type: "BriefBody", props: {}, children: [] } } };
const base = { owner, updatedAt: new Date().toISOString(), updatedTurnId: null, attachments: [], refs: {}, seen: null, history: false, body };
const report = { ...base, key: "notes", kind: "report", title: "Notes", version: 2 };
const ask = (reply, extra = {}) => ({ ...base, key: "pick", kind: "ask", title: "Which layout?", version: 3,
  ask: { question: "Which layout?", state: "open", reply, ...extra } });

function mount({ lang = "en", storage = {}, older = false, replyStatus = "accepted" } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://home-reply-files.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.Range.prototype.getClientRects ||= () => [];
  window.Range.prototype.getBoundingClientRect ||= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.matchMedia = (query) => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  const posts = [];
  const uploads = [];
  const saved = new Map();
  const state = { fail: 0 };
  const answer = (value, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(value), text: async () => JSON.stringify(value) });
  const read = (blob) => new Promise((done) => {
    const reader = new window.FileReader();
    reader.onload = () => done(String(reader.result));
    reader.readAsText(blob);
  });
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const address = new URL(String(url), "https://home-reply-files.test/");
    if (method === "POST" && address.pathname === "/api/projects/p1/files") {
      const content = await read(init.body);
      if (!saved.has(content)) saved.set(content, id(saved.size + 1));
      const name = address.searchParams.get("name") || "file";
      uploads.push({ name, type: init.headers["Content-Type"], content });
      return answer({ id: saved.get(content), name, bytes: init.body.size });
    }
    const sent = init.body ? JSON.parse(init.body) : null;
    posts.push({ url: String(url), method, body: sent });
    if (older && sent?.files)
      // A Core from before Home's files: serde's own words, a plain body.
      return { ok: false, status: 422, text: async () => "Failed to deserialize the JSON body into the target type: unknown field `files`, expected one of `key`, `agentId`, `text`",
        json: async () => { throw new Error("plain"); } };
    if (state.fail > 0) {
      state.fail -= 1;
      throw new TypeError("Failed to fetch");
    }
    return answer({ input: { text: sent?.text ?? "", clientMessageId: sent?.clientMessageId ?? "" }, status: replyStatus, turnId: "t2", error: replyStatus === "accepted" || replyStatus === "queued" ? null : "Not delivered." });
  };
  window.eval(bundle);
  const document = window.document;
  const context = { projectId: "p1", workspaceId: "ws", agents, readOnly: false, onSent: () => {} };
  const field = () => document.querySelector(".home-text-reply [data-composer-input]");
  const chips = () => [...document.querySelectorAll(".home-text-reply .input-file")];
  const choose = (files, label = "Choose files", scope = document) => {
    const picker = scope.querySelector(`input[aria-label="${label}"]`);
    Object.defineProperty(picker, "files", { configurable: true, value: files });
    picker.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  const file = (name, content, type = "application/pdf") => new window.File([content], name, { type });
  const stored = (name, slot) => JSON.parse(window.localStorage.getItem(name) || "{}")[slot] ?? null;
  const postsTo = (suffix) => posts.filter((post) => post.method === "POST" && String(post.url).endsWith(suffix));
  return { window, document, errors, posts, uploads, state, context, field, chips, choose, file, stored, postsTo,
    close: () => window.close() };
}

async function card(options = {}) {
  const page = mount(options);
  const section = options.section ?? report;
  page.window.renderCard({ section, ...page.context });
  await until(() => page.document.querySelector(".home-card-reply"), "the reply opens");
  await tick();
  return page;
}

test("Home keeps a file's reference as Core answered it, and checks one before trusting it", async (t) => {
  const page = await card();
  t.after(page.close);
  const files = page.window.homeFiles;
  assert.equal(files.takesFiles("codex"), true);
  assert.equal(files.takesFiles("dsh"), false);
  assert.equal(files.agentTakesFiles({ harness: "codex", remote: { machine: "m" } }), true, "Core copies them to another machine (F4)");
  assert.equal(files.agentTakesFiles({ harness: "claude", remote: { machine: "m" } }), true);
  assert.equal(files.agentTakesFiles({ harness: "opencode", remote: { machine: "m" } }), false, "no OpenCode Agent is on another machine");
  assert.equal(files.agentTakesFiles({ harness: "dsh" }), false);
  assert.equal(files.homeFileUrl("p 1", id(1), "q3 report.pdf"), "/api/projects/p%201/files/" + id(1) + "/q3%20report.pdf");
  const one = { id: id(1), name: "a.txt", bytes: 3 };
  assert.equal(files.sameFiles([one], [one]), true);
  assert.equal(files.sameFiles([one], [{ ...one, bytes: 4 }]), false);
  assert.equal(files.validHomeFiles([one]), true);
  assert.equal(files.validHomeFiles([{ ...one, id: "../x" }]), false);
  assert.equal(files.validHomeFiles([{ ...one, name: "" }]), false);
  assert.deepEqual(page.errors, []);
});

test("a card's reply saves files to the project, shows them, keeps them with the draft, and sends them once", async (t) => {
  const page = await card();
  t.after(page.close);
  const slot = JSON.stringify(["ws", "p1", "notes", "card"]);
  setComposerText(page.field(), "  Here are the files  ");
  page.choose([page.file("q3 report.pdf", "report-bytes"), page.file("log.csv", "csv-bytes", "text/csv")]);
  await until(() => page.chips().length === 2, "both files are saved and shown");
  assert.deepEqual(page.uploads.map((upload) => [upload.name, upload.type, upload.content]),
    [["q3 report.pdf", "application/octet-stream", "report-bytes"], ["log.csv", "application/octet-stream", "csv-bytes"]],
    "saved to the Project's files as raw bytes, under the name given");
  assert.deepEqual(page.chips().map((chip) => chip.querySelector(".input-file-name").textContent), ["q3 report.pdf", "log.csv"]);
  assert.equal(page.chips()[0].querySelector(".input-file-size").textContent, "12 B");
  assert.deepEqual(page.stored(CARD_DRAFTS, slot).files.map((file) => [file.id, file.name, file.bytes]),
    [[id(1), "q3 report.pdf", 12], [id(2), "log.csv", 9]], "kept with the draft in this browser");

  const sendCard = () => page.document.querySelector(".home-card-reply button[type=submit]");
  await until(() => sendCard() && !sendCard().disabled, "the reply can be sent");
  sendCard().click();
  await until(() => page.postsTo("/brief/reply").length === 1, "the reply is sent");
  const [sent] = page.postsTo("/brief/reply");
  assert.deepEqual(sent.body.files, [{ id: id(1), name: "q3 report.pdf", bytes: 12 }, { id: id(2), name: "log.csv", bytes: 9 }]);
  assert.equal(sent.body.text, "Here are the files");
  assert.equal("images" in sent.body, false, "nothing else is added");
  await until(() => page.document.querySelector(".home-card-reply .home-note[role=status]")?.textContent.includes("2 files went with it"),
    "the sent line counts its files");
  assert.equal(page.document.querySelector(".home-card-reply .home-note[role=status]").textContent,
    "Sent to Mori, referring to version 2. 2 files went with it.");
  await until(() => !page.chips().length && !page.document.querySelector(".home-text-reply .input-file"), "the files leave with it");

  setComposerText(page.field(), "No files this time");
  await tick();
  const nextSend = () => page.document.querySelector(".home-card-reply button[type=submit]");
  await until(() => nextSend() && !nextSend().disabled, "the second reply can be sent");
  nextSend().click();
  await until(() => page.postsTo("/brief/reply").length === 2, "the second reply is sent");
  assert.equal("files" in page.postsTo("/brief/reply")[1].body, false, "no files, no field: an older Core takes it as before");
  assert.deepEqual(page.errors, []);
});

test("a file is removed from the draft, and nothing goes while a file saves", async (t) => {
  const page = await card();
  t.after(page.close);
  const slot = JSON.stringify(["ws", "p1", "notes", "card"]);
  setComposerText(page.field(), "One of them");
  page.choose([page.file("keep.txt", "keep"), page.file("drop.txt", "drop", "text/plain")]);
  await until(() => page.chips().length === 2, "both saved");
  page.document.querySelector('.home-card-reply button[aria-label="Remove drop.txt"]').click();
  await until(() => page.chips().length === 1, "it is removed");
  assert.deepEqual(page.stored(CARD_DRAFTS, slot).files.map((file) => file.name), ["keep.txt"]);

  // A draft read back without the files this page keeps shows the words only.
  const again = await card({ storage: { [CARD_DRAFTS]: JSON.stringify({ [slot]: { key: "notes", title: "Notes", agentId: "mori",
    at: new Date().toISOString(), text: "Kept words", files: [{ id: "../x", name: "a.txt", bytes: 1 }] } }) } });
  t.after(again.close);
  assert.equal(composerText(again.field()), "Kept words");
  assert.equal(again.chips().length, 0);
  assert.deepEqual([...page.errors, ...again.errors], []);
});

test("who can't take files is said before sending; an older Core's refusal sends nothing; a retry carries the files", async (t) => {
  // A harness that reads no files: the page knows, and says why.
  const lab = await card({ section: { ...report, owner: { agentId: "lab", name: "Lab", state: "active" } } });
  t.after(lab.close);
  setComposerText(lab.field(), "For the lab");
  lab.choose([lab.file("data.txt", "data", "text/plain")]);
  await until(() => lab.chips().length === 1, "saved");
  assert.equal(lab.document.querySelector('.home-card-reply .home-composer-note[role=status]').textContent,
    "Lab can't receive files; Codex, Claude and OpenCode Agents can. Remove the files or choose someone else.");
  assert.equal(lab.document.querySelector(".home-card-reply button[type=submit]").disabled, true, "not with files Lab can't take");
  lab.document.querySelector('.home-card-reply button[aria-label="Remove data.txt"]').click();
  await until(() => !lab.chips().length, "removed");

  // A remote Codex or Claude Agent takes files: Core copies them to its machine (F4).
  const far = await card({ section: { ...report, owner: { agentId: "far", name: "Far", state: "active" } } });
  t.after(far.close);
  setComposerText(far.field(), "For Far");
  far.choose([far.file("data.txt", "data", "text/plain")]);
  await until(() => far.chips().length === 1, "saved");
  assert.equal(far.document.querySelector(".home-card-reply .home-composer-note[role=status]"), null,
    "a remote Claude Agent takes files now that Core carries them there");
  // The chip shows before the upload finishes; the reply waits for it.
  await until(() => !far.document.querySelector(".home-card-reply button[type=submit]").disabled,
    "the files go with the reply");

  // An OpenCode Agent is refused on another machine, where Core copies files to Codex and Claude only.
  const way = await card({ section: { ...report, owner: { agentId: "way", name: "Way", state: "active" } } });
  t.after(way.close);
  setComposerText(way.field(), "For Way");
  way.choose([way.file("data.txt", "data", "text/plain")]);
  await until(() => way.chips().length === 1, "saved");
  assert.match(way.document.querySelector(".home-card-reply .home-composer-note[role=status]").textContent, /Way can't receive files/);

  // An older Core refused them before reading the reply: nothing was sent, and no retry record is kept.
  const older = await card({ older: true });
  t.after(older.close);
  setComposerText(older.field(), "Older Core");
  older.choose([older.file("a.txt", "a", "text/plain")]);
  await until(() => older.chips().length === 1, "saved");
  const olderSend = () => older.document.querySelector(".home-card-reply button[type=submit]");
  await until(() => olderSend() && !olderSend().disabled, "the reply can be sent");
  olderSend().click();
  await until(() => older.document.querySelector(".home-card-reply .inline-error"), "the refusal is shown");
  assert.equal(older.document.querySelector(".home-card-reply .inline-error").textContent,
    "This Core can't take files with a reply yet, so nothing was sent. Update Core, or remove the files and send again.");
  assert.equal(older.stored(OUTBOX, JSON.stringify(["ws", "p1", "notes", "card"])), null, "not kept for a retry");
  assert.equal(older.chips().length, 1, "the files stay in the draft");

  // A send with no answer goes again as it was, files and client ID included.
  const retry = await card();
  t.after(retry.close);
  setComposerText(retry.field(), "Again");
  retry.choose([retry.file("b.txt", "b", "text/plain")]);
  await until(() => retry.chips().length === 1, "saved");
  retry.state.fail = 1;
  const retrySend = () => retry.document.querySelector(".home-card-reply button[type=submit]");
  await until(() => retrySend() && !retrySend().disabled, "the reply can be sent");
  retrySend().click();
  await until(() => retry.document.querySelector(".home-card-reply .inline-error"), "the failure is shown");
  await tick();
  await until(() => !retrySend().disabled, "it can go again");
  retrySend().click();
  await until(() => retry.postsTo("/brief/reply").length === 2, "it goes again");
  const [first, second] = retry.postsTo("/brief/reply");
  assert.deepEqual(second.body.files, first.body.files);
  assert.equal(second.body.clientMessageId, first.body.clientMessageId, "the same attempt, never twice");
  assert.deepEqual([...lab.errors, ...far.errors, ...way.errors, ...older.errors, ...retry.errors], []);
});

test("an Ask's words carry files; a pick does not; the answer card shows the files its reply took", async (t) => {
  const page = mount();
  t.after(page.close);
  const open = ask({ freeText: true });
  page.window.renderAsk({ section: open, ...page.context });
  await until(() => page.document.querySelector(".home-ask-reply"), "the ask opens");
  setComposerText(page.field(), "Here it is");
  page.choose([page.file("report.pdf", "pdf")]);
  await until(() => page.chips().length === 1, "saved");
  const sendButton = () => page.document.querySelector(".home-ask-reply form.home-text-reply button[type=submit]");
  await until(() => sendButton() && !sendButton().disabled, "the reply can be sent");
  sendButton().click();
  await until(() => page.postsTo("/brief/reply").length === 1, "the reply is sent");
  const [sent] = page.postsTo("/brief/reply");
  assert.deepEqual(sent.body.files, [{ id: id(1), name: "report.pdf", bytes: 3 }]);
  assert.equal(sent.body.askVersion, 3);
  await until(() => page.document.querySelector(".home-ask-replied"), "the reply is shown");

  // A pick sends only its id: the files stay in the draft, as images do.
  const picks = mount();
  t.after(picks.close);
  picks.window.renderAsk({ section: ask({ options: [{ id: "a", label: "Option A" }] }), ...picks.context });
  await until(() => picks.document.querySelector(".home-ask-reply"), "the ask opens");
  picks.choose([picks.file("left.pdf", "left")]);
  await until(() => picks.chips().length === 1, "saved");
  const button = [...picks.document.querySelectorAll(".home-ask-options button")].find((b) => b.textContent === "Option A");
  button.click();
  await until(() => picks.postsTo("/brief/reply").length === 1, "the pick is sent");
  assert.equal("files" in picks.postsTo("/brief/reply")[0].body, false, "a pick carries no files");
  assert.equal(picks.chips().length, 1, "the file stays in the draft");

  // What Core kept of the reply: the answer card shows its files, downloaded from the Project.
  const answered = mount();
  t.after(answered.close);
  answered.window.renderAsk({
    section: ask({ freeText: true }, { state: "replied", replyText: "Here it is", repliedAt: new Date().toISOString(),
      replyFiles: [{ id: id(7), name: "kept.pdf", bytes: 1200 }] }),
    ...answered.context,
  });
  await until(() => answered.document.querySelector(".home-ask-replied"), "the answered ask opens");
  const link = answered.document.querySelector(".home-ask-replied .input-file a");
  assert.equal(link.getAttribute("href"), `/api/projects/p1/files/${id(7)}/kept.pdf`);
  assert.equal(link.getAttribute("download"), "kept.pdf");
  assert.deepEqual([...page.errors, ...picks.errors, ...answered.errors], []);
});

test("the field and its files are named in Chinese too", async (t) => {
  const page = mount({ lang: "zh" });
  t.after(page.close);
  page.window.renderAsk({ section: ask({ freeText: true }), ...page.context });
  await until(() => page.document.querySelector(".home-ask-reply"), "the ask opens");
  setComposerText(page.field(), "文件在这里");
  page.choose([page.file("报告.pdf", "报告")], "选择文件");
  await until(() => page.chips().length === 1, "saved");
  assert.equal(page.document.querySelector('.home-ask-reply button[aria-label="移除 报告.pdf"]') !== null, true);
  const zhSend = () => page.document.querySelector(".home-ask-reply form.home-text-reply button[type=submit]");
  await until(() => zhSend() && !zhSend().disabled, "the reply can be sent");
  zhSend().click();
  await until(() => page.postsTo("/brief/reply").length === 1, "sent");
  assert.deepEqual(page.postsTo("/brief/reply")[0].body.files, [{ id: id(1), name: "报告.pdf", bytes: 6 }]);
  await until(() => page.document.querySelector(".home-ask-replied"), "shown as replied");
  assert.deepEqual(page.errors, []);
});
