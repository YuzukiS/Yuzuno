import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { JSDOM, VirtualConsole } from "jsdom";
import { composerText, composerView, setComposerText } from "./composer-driver.mjs";

// YN-91: a long reply from Home goes to the Agent whole. A field that stops
// at 20,000 characters cut a longer paste short without a word, and 8,000
// Chinese characters (24,000 bytes) were refused by Core. The real card and
// ask replies and what is said to a project (YN-86 §4.2: a request, under
// the same limit), with Core answered here; nothing is sent but what a test
// sends on purpose.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "home-long-reply-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {AskReply} from ${JSON.stringify(path.join(root, "src/home/AskReply.tsx"))};
import {ProjectTalk} from ${JSON.stringify(path.join(root, "src/home/ProjectTalk.tsx"))};
import {CardReply} from ${JSON.stringify(path.join(root, "src/home/CardReply.tsx"))};
import {HOME_REPLY_MAX_BYTES, utf8Bytes} from ${JSON.stringify(path.join(root, "src/home/reply-limit.tsx"))};
import {draftFromTextBlocks, draftTextBlocks} from ${JSON.stringify(path.join(root, "src/message-content.ts"))};
import {draftText} from ${JSON.stringify(path.join(root, "src/composer-draft.ts"))};
window.replyLimit={HOME_REPLY_MAX_BYTES, utf8Bytes};
window.drafts={draftFromTextBlocks, draftTextBlocks, draftText};
const root=createRoot(document.getElementById('root'));
window.renderCard=(props)=>flushSync(()=>root.render(<CardReply {...props}/>));
window.renderAsk=(props)=>flushSync(()=>root.render(<AskReply {...props}/>));
window.renderProject=(props)=>flushSync(()=>root.render(<ProjectTalk {...props}/>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "HomeLongReply", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

/** Longer than the 20,000 characters a reply field stopped at. */
const LONG = `${"Pasted log line 0123456789 abcdefghij\n".repeat(650)}end`;
/** 8,000 Chinese characters: 24,000 bytes, more than Core took before. */
const CHINESE = "长".repeat(8_000);
assert.ok(LONG.length > 20_000 && new TextEncoder().encode(CHINESE).length === 24_000);

const agents = [
  { id: "mori", name: "Mori", harness: "codex", status: "idle", cwd: "/fixture", model: "", color: "sage",
    createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" },
];
const owner = { agentId: "mori", name: "Mori", state: "active" };
const body = { root: "body", elements: { body: { type: "BriefBody", props: {}, children: [] } } };
const base = { owner, updatedAt: new Date().toISOString(), updatedTurnId: null, attachments: [], refs: {}, seen: null, history: false, body };
const report = { ...base, key: "notes", kind: "report", title: "Notes", version: 2 };
const ask = { ...base, key: "words", kind: "ask", title: "Anything before we ship?", version: 1,
  ask: { question: "Anything before we ship?", state: "open", reply: { freeText: true } } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
/** A reply sent to Core: a card's or an ask's, or what is said to a project (a request). */
const replied = (post) => post.url.endsWith("/brief/reply") || post.url.endsWith("/requests");

function mount({ lang = "en", storage = {} } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://home-long-reply.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  // JSDOM does no layout: CodeMirror measures text ranges (ui-test-bundle.mjs does the same).
  window.Range.prototype.getClientRects ||= () => [];
  window.Range.prototype.getBoundingClientRect ||= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  const posts = [];
  window.crypto.randomUUID ??= () => `id-${posts.length}-${Math.random().toString(16).slice(2)}`;
  window.fetch = async (url, init = {}) => {
    const sent = init.body ? JSON.parse(init.body) : null;
    const method = init.method || "GET";
    // What a project's page reads: its front desk and its requests (none yet).
    const read = method === "GET" && /\/front-desk$/.test(String(url)) ? { version: 1, agentId: "mori", effectiveAgentId: "mori" }
      : method === "GET" && /\/requests$/.test(String(url)) ? { requests: [], hasMore: false } : null;
    if (!read) posts.push({ url: String(url), method, body: sent });
    const receipt = { input: { text: sent?.text ?? "", clientMessageId: sent?.clientMessageId ?? "" },
      status: "accepted", turnId: "mori-t2", error: null };
    return {
      ok: true, status: 200,
      json: async () => read ?? (/\/requests$/.test(String(url)) ? { request: { n: 1 }, receipt } : receipt),
      text: async () => "",
    };
  };
  window.eval(bundle);
  const document = window.document;
  const context = { projectId: "p1", workspaceId: "ws", agents, readOnly: false, onSent: () => {} };
  const closed = { n: 0 };
  const shapes = {
    card: () => window.renderCard({ section: report, projectId: "p1", workspaceId: "ws", agents, opened: true, onClose: () => { closed.n++; } }),
    ask: () => window.renderAsk({ section: ask, ...context }),
    project: async () => {
      window.renderProject({ projectId: "p1", projectName: "Yuzuno app", workspaceId: "ws", readOnly: false, revision: 0,
        leadCount: 1, onCard: () => {}, onNavigate: () => {} });
      await tick();
    },
  };
  // The reply's writing field: a plain one, or the composer's.
  const field = () => document.querySelector(":is(.home-text-reply, .project-talk-field) :is(textarea, [data-composer-input])");
  const type = async (text) => {
    const area = field();
    if (area.matches("textarea")) {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(area, text);
      area.dispatchEvent(new window.Event("input", { bubbles: true }));
    } else setComposerText(area, text);
    await tick();
  };
  const send = async () => {
    const before = posts.length;
    submit().click();
    for (let i = 0; i < 40 && posts.length === before; i++) await tick();
    await tick();
    return posts.slice(before).filter(replied).map((p) => p.body);
  };
  const note = () => document.querySelector(".home-reply-length");
  /** Pasted into the reply's field, as the clipboard gives it. */
  const paste = async (text) => {
    const area = field();
    area.focus();
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (kind) => (kind === "text/plain" ? text : "") } });
    area.dispatchEvent(event);
    await tick();
  };
  /** Words added at the end of what the field holds. */
  const append = async (text) => {
    const view = composerView(field());
    view.dispatch({ changes: { from: view.state.doc.length, insert: text }, selection: { anchor: view.state.doc.length + text.length } });
    await tick();
  };
  const chips = () => [...document.querySelectorAll(":is(.home-text-reply, .project-talk-field) .pasted-text-chip")];
  const button = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  const stored = () => Object.fromEntries(Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i))
    .map((key) => [key, window.localStorage.getItem(key)]));
  const submit = () => document.querySelector(":is(.home-text-reply, .project-talk-compose) button[type=submit]");
  return { window, document, errors, posts, shapes, field, type, send, note, submit, paste, append, chips, button, stored, closed, close: () => window.close() };
}

test("no Home reply field cuts a long paste short", async (t) => {
  for (const shape of ["card", "ask", "project"]) {
    const page = mount();
    t.after(page.close);
    await page.shapes[shape]();
    await tick();
    const area = page.field();
    assert.ok(area, `${shape}: a reply field`);
    // A browser stops a paste at maxLength and says nothing.
    const cap = area.maxLength;
    assert.ok(!(typeof cap === "number" && cap >= 0 && cap < LONG.length),
      `${shape}: the field takes a ${LONG.length}-character paste whole, not cut at maxLength ${cap}`);
    assert.deepEqual(page.errors, []);
  }
});

test("8,000 Chinese characters and a paste over 20,000 characters go to the Agent whole", async (t) => {
  for (const shape of ["card", "ask", "project"]) {
    for (const words of [CHINESE, LONG]) {
      const page = mount();
      t.after(page.close);
      await page.shapes[shape]();
      await tick();
      await page.type(words);
      const sent = await page.send();
      assert.equal(sent.length, 1, `${shape}: one reply sent`);
      assert.ok(sent[0].text === words.trim(), `${shape}: the reply's ${words.length} characters, whole (sent ${sent[0].text.length})`);
      assert.ok(!page.document.querySelector("[role=alert]"), `${shape}: no refusal shown`);
      assert.deepEqual(page.errors, []);
    }
  }
});

// Core's limit, and the unit it counts in: the page says the same number and
// counts as Rust's str::len does, so what Home lets you send Core takes.
test("Home counts a reply as Core does, against Core's own limit", async (t) => {
  const page = mount();
  t.after(page.close);
  const { HOME_REPLY_MAX_BYTES, utf8Bytes } = page.window.replyLimit;
  const rust = await readFile(path.join(root, "../core/src/project_brief/home.rs"), "utf8");
  const core = Number(rust.match(/const MAX_REPLY: usize = ([\d_]+);/)?.[1].replaceAll("_", ""));
  assert.equal(HOME_REPLY_MAX_BYTES, core, "the page's limit is Core's MAX_REPLY");
  const encoder = new TextEncoder();
  for (const text of ["", "plain ascii", "é ß ø", CHINESE, "😀 emoji 👩‍💻", "mixed 长 é 😀\n\r\t", "\u{10ffff}"])
    assert.equal(utf8Bytes(text), encoder.encode(text).length, JSON.stringify(text.slice(0, 20)));
});

/** `bytes` bytes of Chinese characters, then ASCII to make up the rest. */
const ofBytes = (bytes) => "长".repeat(Math.floor(bytes / 3)) + "a".repeat(bytes % 3);

test("a reply over the limit says how far over and why, sends nothing and keeps its words", async (t) => {
  for (const shape of ["card", "ask", "project"]) {
    for (const lang of ["en", "zh"]) {
      const page = mount({ lang });
      t.after(page.close);
      await page.shapes[shape]();
      await tick();
      const most = page.window.replyLimit.HOME_REPLY_MAX_BYTES;
      assert.ok(!page.note(), `${shape}/${lang}: nothing said of a short reply`);
      // Near the limit: how much it can still take.
      await page.type(ofBytes(most - 1200));
      assert.ok(page.note(), `${shape}/${lang}: near the limit, it says so`);
      assert.ok(page.note().textContent === (lang === "zh"
        ? "还能输入 1,200 字节，上限 92,000 字节（UTF-8，一个汉字 3 字节）。"
        : "1,200 bytes left of 92,000 (UTF-8: a Chinese character is 3)."), page.note().textContent);
      assert.ok(!page.submit().disabled, `${shape}/${lang}: it can still be sent`);
      // Over: how far, and why it is not sent.
      const over = ofBytes(most + 31);
      await page.type(over);
      assert.ok(page.note().textContent === (lang === "zh"
        ? "超出 31 字节，发不出去：Home 的一条回复最多 92,000 字节（UTF-8，一个汉字 3 字节）。删减后才能发送，已写的内容不会丢。"
        : "31 bytes too long to send: a reply from Home is at most 92,000 bytes in UTF-8, where a Chinese character is 3. Shorten it to send; what you wrote is kept."),
        page.note().textContent);
      assert.ok(page.submit().disabled, `${shape}/${lang}: Send is held`);
      // Return, as the device's send key, sends nothing either.
      page.field().dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
      page.field().closest("form").requestSubmit();
      await tick();
      assert.equal(page.posts.filter(replied).length, 0, `${shape}/${lang}: nothing sent`);
      // The words are kept as written, the field whole.
      const kept = page.field().matches("textarea") ? page.field().value : null;
      if (kept !== null) assert.ok(kept === over, `${shape}/${lang}: the field keeps all ${over.length} characters`);
      if (shape === "card") {
        const saved = JSON.parse(page.window.localStorage.getItem("yuzuno.home-card-drafts.v1") || "{}");
        assert.ok(Object.values(saved).some((draft) => draft.text === over), "the card's draft is kept in this browser");
      }
      if (shape === "ask") {
        const saved = JSON.parse(page.window.localStorage.getItem("yuzuno.home-ask-drafts.v1") || "{}");
        assert.ok(Object.values(saved).some((draft) => draft.text === over), "the ask's draft is kept in this browser");
      }
      if (shape === "project") {
        const saved = JSON.parse(page.window.localStorage.getItem("yuzuno.project-talk-drafts.v1") || "{}");
        assert.ok(Object.values(saved).some((draft) => draft.text === over), "what is said to the project is kept in this browser");
      }
      // Shortened to the limit, it goes.
      await page.type(ofBytes(most));
      assert.ok(!page.submit().disabled, `${shape}/${lang}: at the limit it can be sent`);
      const sent = await page.send();
      assert.equal(sent.length, 1);
      assert.equal(page.window.replyLimit.utf8Bytes(sent[0].text), most);
      assert.deepEqual(page.errors, []);
    }
  }
});

// YN-91: Home's reply fields are the conversation's composer. A long paste
// folds into a block that opens to be read and edited, or is removed, as it
// does there; the Agent gets the whole text, as from the conversation.
const words = {
  en: { label: /^Pasted\slog\S* · 651 lines\. View and edit$/, title: "Pasted text #1", full: "Full pasted text", save: "Save changes", remove: "Remove block" },
  zh: { label: /^Pasted\slog\S* · 651 行。查看并编辑$/, title: "粘贴的文本 #1", full: "完整的粘贴文本", save: "保存更改", remove: "移除此块" },
};
const dialogTitle = (page) => page.document.querySelector('[role="dialog"] h2')?.textContent ?? null;
const source = (page, lang) => page.document.querySelector(`[role="dialog"] textarea[aria-label="${words[lang].full}"]`);
async function setSource(page, area, text) {
  Object.getOwnPropertyDescriptor(page.window.HTMLTextAreaElement.prototype, "value").set.call(area, text);
  area.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await tick();
}

test("a long paste in every Home reply folds into a block that opens, is edited or removed, and goes to the Agent whole", async (t) => {
  for (const shape of ["card", "ask", "project"]) {
    for (const lang of ["en", "zh"]) {
      const w = words[lang];
      const page = mount({ lang });
      t.after(page.close);
      await page.shapes[shape]();
      await tick();
      await page.type("Before ");
      await page.paste(LONG);
      assert.equal(page.chips().length, 1, `${shape}/${lang}: the paste is one block`);
      assert.match(page.chips()[0].getAttribute("aria-label"), w.label);
      assert.equal(composerText(page.field()), "Before \ufffc", "the field holds the block, not the text");
      await page.append(" after");
      // Opened: the whole paste, to read and edit.
      page.chips()[0].click();
      await tick();
      assert.equal(dialogTitle(page), w.title, `${shape}/${lang}: the block's dialog`);
      assert.ok(source(page, lang)?.value === LONG, `${shape}/${lang}: the whole paste, ${LONG.length} characters`);
      await setSource(page, source(page, lang), `${LONG}\nEdited.`);
      page.button(w.save).click();
      await tick();
      assert.ok(!page.document.querySelector('[role="dialog"]'), "saved and closed");
      assert.equal(page.chips().length, 1, "still one block");
      assert.equal(page.posts.length, 0, `${shape}/${lang}: opening and editing send nothing`);
      // Sent: the words around it and the block's text, whole.
      const sent = await page.send();
      assert.equal(sent.length, 1);
      assert.ok(sent[0].text === `Before ${LONG}\nEdited. after`, `${shape}/${lang}: the whole reply (${sent[0].text.length} characters)`);
      assert.equal(page.chips().length, 0, `${shape}/${lang}: the field is empty once sent`);
      // An Ask answered shows the reply in its place; Reply again brings the field back.
      if (shape === "ask") {
        page.document.querySelector(".home-ask-replied button").click();
        await tick();
      }
      // Removed: the block goes, and nothing of it is sent.
      await page.type("Only this");
      await page.paste(LONG);
      page.chips()[0].click();
      await tick();
      page.button(w.remove).click();
      await tick();
      assert.equal(page.chips().length, 0, `${shape}/${lang}: the block is removed`);
      assert.equal(composerText(page.field()), "Only this");
      const second = await page.send();
      assert.ok(second[0]?.text === "Only this", `${shape}/${lang}: only the words left`);
      assert.deepEqual(page.errors, []);
    }
  }
});

test("a reply's blocks are kept with its draft and come back as blocks after a reload", async (t) => {
  for (const shape of ["card", "ask"]) {
    const page = mount();
    t.after(page.close);
    await page.shapes[shape]();
    await tick();
    await page.type("Note: ");
    await page.paste(LONG);
    await page.append(" — see above.");
    const store = shape === "card" ? "yuzuno.home-card-drafts.v1" : "yuzuno.home-ask-drafts.v1";
    const [kept] = Object.values(JSON.parse(page.stored()[store]));
    // The draft's text is the whole reply, as before; its blocks say where the paste is in it.
    assert.ok(kept.text === `Note: ${LONG} — see above.`, `${shape}: the whole text is kept`);
    assert.deepEqual(kept.blocks.map(({ start, end }) => [start, end]), [[6, 6 + LONG.length]], `${shape}: where its block is`);
    const again = mount({ storage: page.stored() });
    t.after(again.close);
    await again.shapes[shape]();
    await tick();
    assert.equal(again.chips().length, 1, `${shape}: the block is back`);
    assert.equal(composerText(again.field()), "Note: \ufffc — see above.");
    again.chips()[0].click();
    await tick();
    assert.ok(source(again, "en")?.value === LONG, `${shape}: with its whole text`);
    again.document.querySelector('[role="dialog"] button[aria-label="Close dialog"]')?.click();
    await tick();
    const sent = await again.send();
    assert.ok(sent[0]?.text === `Note: ${LONG} — see above.`, `${shape}: sent whole`);
    assert.deepEqual(again.errors, []);
  }
});

test("a draft kept before blocks, or with blocks that don't fit its text, comes back as its text", async (t) => {
  const draft = (blocks) => JSON.stringify({ [JSON.stringify(["ws", "p1", "notes", "card"])]:
    { key: "notes", text: `Note: ${LONG}`, title: "Notes", agentId: "mori", at: new Date().toISOString(), ...(blocks ? { blocks } : {}) } });
  for (const [what, blocks] of [["no blocks", null], ["past its end", [{ id: "x", start: 6, end: LONG.length + 99 }]],
    ["out of order", [{ id: "x", start: 10, end: 20 }, { id: "y", start: 5, end: 8 }]], ["the same id twice", [{ id: "x", start: 1, end: 2 }, { id: "x", start: 3, end: 4 }]]]) {
    const page = mount({ storage: { "yuzuno.home-card-drafts.v1": draft(blocks) } });
    t.after(page.close);
    await page.shapes.card();
    await tick();
    assert.equal(page.chips().length, 0, `${what}: no block made up`);
    assert.ok(composerText(page.field()) === `Note: ${LONG}`, `${what}: the text whole`);
    assert.deepEqual(page.errors, []);
  }
});

test("Home keeps a paste's place in its text as the conversation marks it on a message", (t) => {
  const page = mount();
  t.after(page.close);
  const { draftFromTextBlocks, draftTextBlocks, draftText } = page.window.drafts;
  const text = `a${LONG}b${CHINESE}c`;
  const blocks = [{ id: "one", start: 1, end: 1 + LONG.length }, { id: "two", start: 2 + LONG.length, end: 2 + LONG.length + CHINESE.length }];
  const draft = draftFromTextBlocks(text, blocks);
  // Read across the window's realm as plain data.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.equal(draftText(draft), text);
  assert.deepEqual(plain(draftTextBlocks(draft)), blocks);
  assert.deepEqual(plain(draft.parts.filter((p) => p.kind === "paste").map((p) => [p.id, p.number])), [["one", 1], ["two", 2]]);
  assert.equal(draft.nextNumber, 3);
});

// Escape in a card's reply closes it, as before the composer; Escape that ends
// an input method's composition (a Chinese one, say) only ends it.
test("Escape closes a card's reply, but not while an input method composes", async (t) => {
  const page = mount();
  t.after(page.close);
  await page.shapes.card();
  await tick();
  await page.type("长回复");
  const escape = (init = {}) =>
    page.field().dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init }));
  escape({ isComposing: true });
  escape({ keyCode: 229 });
  await tick();
  assert.equal(page.closed.n, 0, "an input method's Escape leaves the reply open");
  escape();
  await tick();
  assert.equal(page.closed.n, 1, "Escape closes the reply");
  assert.deepEqual(page.errors, []);
});
