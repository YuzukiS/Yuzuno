import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
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

function mount() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://home-long-reply.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
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
  return { window, document, errors, posts, shapes, field, type, send, close: () => window.close() };
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
