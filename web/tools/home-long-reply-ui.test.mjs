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
import { setComposerText } from "./composer-driver.mjs";

// YN-91: a long reply from Home goes to the Agent whole. A field that stops
// at 20,000 characters cut a longer paste short without a word, and 8,000
// Chinese characters (24,000 bytes) were refused by Core. The real card,
// ask and project replies, with Core answered here; nothing is sent but
// what a test sends on purpose.
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
import {AskReply, ProjectReply} from ${JSON.stringify(path.join(root, "src/home/AskReply.tsx"))};
import {CardReply} from ${JSON.stringify(path.join(root, "src/home/CardReply.tsx"))};
import {HOME_REPLY_MAX_BYTES, utf8Bytes} from ${JSON.stringify(path.join(root, "src/home/reply-limit.tsx"))};
window.replyLimit={HOME_REPLY_MAX_BYTES, utf8Bytes};
const root=createRoot(document.getElementById('root'));
window.renderCard=(props)=>flushSync(()=>root.render(<CardReply {...props}/>));
window.renderAsk=(props)=>flushSync(()=>root.render(<AskReply {...props}/>));
window.renderProject=(props)=>flushSync(()=>root.render(<ProjectReply {...props}/>));`,
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

function mount({ lang = "en" } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://home-long-reply.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  const posts = [];
  window.crypto.randomUUID ??= () => `id-${posts.length}-${Math.random().toString(16).slice(2)}`;
  window.fetch = async (url, init = {}) => {
    const sent = init.body ? JSON.parse(init.body) : null;
    posts.push({ url: String(url), method: init.method || "GET", body: sent });
    return {
      ok: true, status: 200,
      json: async () => ({ input: { text: sent?.text ?? "", clientMessageId: sent?.clientMessageId ?? "" },
        status: "accepted", turnId: "mori-t2", error: null }),
      text: async () => "",
    };
  };
  window.eval(bundle);
  const document = window.document;
  const context = { projectId: "p1", workspaceId: "ws", agents, readOnly: false, onSent: () => {} };
  const shapes = {
    card: () => window.renderCard({ section: report, projectId: "p1", workspaceId: "ws", agents, opened: true }),
    ask: () => window.renderAsk({ section: ask, ...context }),
    project: async () => {
      window.renderProject({ ...context, projectName: "Yuzuno app" });
      document.querySelector(".home-project-reply-open").click();
      await tick();
      const select = document.querySelector(".home-project-reply select");
      select.value = "mori";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await tick();
    },
  };
  // The reply's writing field: a plain one, or the composer's.
  const field = () => document.querySelector(".home-text-reply textarea, .home-text-reply [data-composer-input]");
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
    document.querySelector(".home-text-reply button[type=submit]").click();
    for (let i = 0; i < 40 && posts.length === before; i++) await tick();
    await tick();
    return posts.slice(before).filter((p) => p.url.endsWith("/brief/reply")).map((p) => p.body);
  };
  const note = () => document.querySelector(".home-reply-length");
  const submit = () => document.querySelector(".home-text-reply button[type=submit]");
  return { window, document, errors, posts, shapes, field, type, send, note, submit, close: () => window.close() };
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
      assert.equal(page.posts.filter((p) => p.url.endsWith("/brief/reply")).length, 0, `${shape}/${lang}: nothing sent`);
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
