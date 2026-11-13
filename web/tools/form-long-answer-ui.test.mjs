import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { composerText, setComposerText } from "./composer-driver.mjs";
import { clarificationMessage } from "../src/intelligent-ui/clarification.ts";

// YN-103: a form's text answer is written in the conversation's composer,
// in the conversation's forms and in Home's asks alike. A long paste folds
// into a block and goes whole; the answers are counted as Core counts the
// one message they go in, against Core's own limit; over it the form says
// by how much and sends nothing, keeping what was written; Return and an
// input method act as in the conversation; and answers sent show a long
// text as one block. The real forms, with Core answered here.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "form-long-answer-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {ClarificationHost, PublishedClarification} from ${src("intelligent-ui/ClarificationHost.tsx")};
import {ResultProvider} from ${src("intelligent-ui/ResultContext.tsx")};
import {AskReply} from ${src("home/AskReply.tsx")};
import {HomeReply} from ${src("home-reply/HomeReply.tsx")};
import {Turn} from ${src("components.tsx")};
import {HOME_REPLY_MAX_BYTES, MESSAGE_MAX_BYTES, utf8Bytes} from ${src("home/reply-limit.tsx")};
window.limits={HOME_REPLY_MAX_BYTES, MESSAGE_MAX_BYTES, utf8Bytes};
const root=createRoot(document.getElementById('root'));
window.renderChat=(host, spec, form)=>flushSync(()=>root.render(
  <ClarificationHost.Provider value={host}>
    <ResultProvider spec={spec} identity="a:r1" resultId="r1"><PublishedClarification form={form}/></ResultProvider>
  </ClarificationHost.Provider>));
window.renderAsk=(props)=>flushSync(()=>root.render(<AskReply {...props}/>));
window.renderHomeReply=(props)=>flushSync(()=>root.render(<HomeReply {...props}/>));
window.renderTurn=(turn,agent,receipts)=>flushSync(()=>root.render(<Turn turn={turn} index={0} agent={agent} receipts={receipts} onFile={()=>{}}/>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "FormLongAnswer", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick(15);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
const utf8 = (text) => new TextEncoder().encode(text).length;

/** A pasted review: 500 lines, CRLF endings, tabs, quotes, a backslash and Chinese. */
const LONG = Array.from({ length: 500 }, (_, n) => `${n + 1}\t"评审" 第 ${n + 1} 行：C:\\work\\round-28 ok`).join("\r\n");
const DEEP = "第 400 行";
assert.ok(LONG.length > 2000 && LONG.includes(DEEP));

const form = {
  id: "round",
  title: "After round 28",
  fields: [
    { id: "next", type: "single", label: "Next step", required: true, options: [{ id: "plan", label: "Write the plan" }, { id: "stop", label: "Stop here" }] },
    { id: "review", type: "text", label: "Codex review", required: false, placeholder: "Paste Codex's review of round 28" },
    { id: "note", type: "text", label: "Note", required: false },
  ],
};
const spec = {
  root: "result",
  elements: {
    result: { type: "Result", props: { title: "Round 28", summary: "Answer once." }, children: ["form"] },
    form: { type: "Clarification", props: form },
  },
};
const agent = { id: "a", name: "Mori", harness: "codex", color: "sage", status: "idle", cwd: "/w", goal: "", model: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0 };
const owner = { agentId: "a", name: "Mori", state: "active" };
const body = { root: "body", elements: { body: { type: "BriefBody", props: {}, children: [] } } };
const ask = { owner, updatedAt: new Date().toISOString(), updatedTurnId: null, attachments: [], refs: {}, seen: null, history: false, body,
  key: "after", kind: "ask", title: "After round 28", version: 1,
  ask: { question: "What next after round 28?", state: "open", reply: { form } } };

/** What Home sends for this form's answers (AskReply.tsx, formReply; Core's
 * home.rs form_answers): each answer in its line, then by id as JSON. */
function homeText(values) {
  const answers = { next: values.next ?? "", review: values.review ?? "", note: values.note ?? "" };
  const label = { plan: "Write the plan", stop: "Stop here" }[answers.next] ?? "";
  const line = (name, said) => `- ${name}: ${said || "(no answer)"}`;
  return `Answers to “After round 28”:\n${[line("Next step", label), line("Codex review", answers.review), line("Note", answers.note)].join("\n")}\n\n${JSON.stringify({ formId: "round", answers })}`;
}

function mount({ lang = "en", respond } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://form-long-answer.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.structuredClone = structuredClone;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  // JSDOM does no layout: the composer measures text ranges.
  window.Range.prototype.getClientRects ||= () => [];
  window.Range.prototype.getBoundingClientRect ||= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  const posts = [];
  window.crypto.randomUUID ??= () => `id-${posts.length}-${Math.random().toString(16).slice(2)}`;
  window.fetch = async (url, init = {}) => {
    const sent = init.body ? JSON.parse(init.body) : null;
    posts.push({ url: String(url), method: init.method || "GET", body: sent });
    const { status = 200, body: answer } = (await respond?.(String(url))) ?? {};
    return {
      ok: status < 400, status,
      json: async () => answer ?? { input: { text: sent?.text ?? "", clientMessageId: sent?.clientMessageId ?? "" }, status: "accepted", turnId: "t2", error: null },
      text: async () => "",
    };
  };
  window.eval(bundle);
  const document = window.document;
  const fields = () => [...document.querySelectorAll(".clarification [data-composer-input]")];
  const page = {
    window, document, errors, posts,
    /** The text field of the question labelled `label`. */
    field: (label) => fields().find((field) => field.getAttribute("aria-label") === label),
    chips: () => [...document.querySelectorAll(".clarification .pasted-text-chip")],
    note: () => document.querySelector(".clarification .home-reply-length"),
    submit: () => [...document.querySelectorAll(".clarification footer button")].find((b) => /Submit answers|提交答案/.test(b.textContent)),
    radio: (id) => document.querySelector(`.clarification input[value="${id}"]`),
    /** Pasted into a field, as the clipboard gives it. */
    async paste(field, text) {
      field.focus();
      const event = new window.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { getData: (kind) => (kind === "text/plain" ? text : ""), files: [], items: [] } });
      field.dispatchEvent(event);
      await tick();
    },
    async type(field, text) {
      setComposerText(field, text);
      await tick();
    },
    async key(field, init) {
      field.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
      await tick();
    },
    close: () => window.close(),
  };
  return page;
}

/** The conversation's form, its host recording what it would send. */
function chat(page) {
  const sent = [];
  const host = {
    workspaceId: "ws-1",
    detail: { agent, turns: [], messageReceipts: [] },
    outgoing: [],
    pendingInputs: {},
    readOnly: false,
    submit: async (text, question, images, answer) => {
      sent.push({ text, answer });
      return undefined;
    },
    refresh() {},
  };
  page.window.renderChat(host, spec, form);
  return { sent, host };
}
/** Home's ask with this form; what it sends is in page.posts. */
function home(page) {
  page.window.renderAsk({ section: ask, projectId: "p1", workspaceId: "ws", agents: [agent], readOnly: false, onSent: () => {} });
  return { sent: () => page.posts.filter((post) => post.url.endsWith("/brief/reply")).map((post) => post.body) };
}
const shapes = { chat, home };

test("a long paste in a form's text field folds into one block and goes to the Agent whole", async (t) => {
  for (const shape of ["chat", "home"]) {
    const page = mount();
    t.after(page.close);
    const shaped = shapes[shape](page);
    await tick();
    const review = page.field("Codex review");
    assert.ok(review, `${shape}: the text answer is the conversation's composer`);
    assert.ok(!!review.id && page.document.getElementById(review.id) === review, `${shape}: it has its field's id`);
    await page.paste(review, LONG);
    assert.equal(page.chips().length, 1, `${shape}: the paste is one block`);
    assert.match(page.chips()[0].getAttribute("aria-label"), /· 500 lines\. View and edit$/);
    assert.equal(composerText(review), "\ufffc", `${shape}: the field holds the block, not the text`);
    assert.ok(!page.document.body.textContent.includes(DEEP), `${shape}: the whole text is not drawn`);
    page.radio("plan").click();
    await tick();
    page.submit().click();
    await tick(60);
    if (shape === "chat") {
      assert.equal(shaped.sent.length, 1, "sent once");
      assert.ok(shaped.sent[0].answer.answers.review === LONG, "the answer is the paste, byte for byte");
      assert.equal(shaped.sent[0].text, clarificationMessage("r1", form, { next: "plan", review: LONG, note: "" }));
    } else {
      const [sent] = shaped.sent();
      assert.ok(sent, "sent");
      assert.ok(sent.form.answers.review === LONG, "the answer is the paste, byte for byte");
      assert.ok(sent.text === homeText({ next: "plan", review: LONG }), "the reply is the answers as Home writes them");
    }
    assert.deepEqual(page.errors, []);
  }
});

test("answers counted as Core counts their one message: at the limit they go, one byte over they are kept and not sent", async (t) => {
  for (const shape of ["chat", "home"]) {
    for (const lang of ["en", "zh"]) {
      const page = mount({ lang });
      t.after(page.close);
      const shaped = shapes[shape](page);
      await tick();
      const { MESSAGE_MAX_BYTES, HOME_REPLY_MAX_BYTES } = page.window.limits;
      page.radio("plan").click();
      await tick();
      // Letters only: in the conversation each is one byte of the message; on Home
      // one in its line and one in the JSON, and a quote one and two.
      let review;
      if (shape === "chat") {
        const empty = utf8(clarificationMessage("r1", form, { next: "plan", review: "", note: "" }));
        review = "a".repeat(MESSAGE_MAX_BYTES - empty);
      } else {
        const room = HOME_REPLY_MAX_BYTES - (utf8(homeText({ next: "plan" })) - "(no answer)".length);
        review = `${"\"".repeat(room % 2)}${"a".repeat((room - 3 * (room % 2)) / 2)}`;
      }
      const max = shape === "chat" ? MESSAGE_MAX_BYTES : HOME_REPLY_MAX_BYTES;
      const field = page.field("Codex review");
      await page.type(field, review);
      assert.equal(page.note()?.dataset.over, undefined, `${shape}/${lang}: at the limit, not over`);
      assert.match(page.note()?.textContent ?? "", lang === "en" ? /^0 bytes left: these answers go as one message of at most/ : /^还能输入 0 字节：这些答案作为一条消息发送/);
      // One byte more: a letter in the conversation, a letter turned into a quote on Home.
      const over = shape === "chat" ? `${review}a` : review.replace(/a$/, '"');
      await page.type(field, over);
      const note = page.note();
      assert.ok(note && note.dataset.over === "", `${shape}/${lang}: over`);
      assert.match(note.textContent, lang === "en"
        ? new RegExp(`^1 byte too long to send: these answers go as one message of at most ${max.toLocaleString("en-US")} bytes`)
        : new RegExp(`^超出 1 字节，发不出去：这些答案作为一条消息发送，最多 ${max.toLocaleString("en-US")} 字节`));
      assert.equal(page.submit().disabled, true, `${shape}/${lang}: Submit is held`);
      await page.key(field, { key: "Enter" });
      page.submit().click();
      await tick(60);
      const count = shape === "chat" ? shaped.sent.length : shaped.sent().length;
      assert.equal(count, 0, `${shape}/${lang}: nothing is sent, by key or button`);
      assert.ok(composerText(field) === over, `${shape}/${lang}: what was written is kept`);
      const saved = Object.keys(page.window.localStorage).find((key) => key.startsWith("yuzuno.clarification.v1:"));
      assert.ok(saved && JSON.parse(page.window.localStorage.getItem(saved)).values.review === over, `${shape}/${lang}: and saved as the draft`);
      // Back at the limit, it goes, whole.
      await page.type(field, review);
      assert.equal(page.submit().disabled, false);
      page.submit().click();
      await tick(60);
      if (shape === "chat") {
        assert.equal(shaped.sent.length, 1);
        assert.equal(utf8(shaped.sent[0].text), max, "exactly the limit");
        assert.ok(shaped.sent[0].answer.answers.review === review);
      } else {
        const sent = shaped.sent();
        assert.equal(sent.length, 1);
        assert.equal(utf8(sent[0].text), max, "exactly the limit");
        assert.ok(sent[0].form.answers.review === review);
      }
      assert.deepEqual(page.errors, []);
    }
  }
});

test("Return submits the form as the conversation sends, never while an input method composes", async (t) => {
  for (const shape of ["chat", "home"]) {
    const page = mount();
    t.after(page.close);
    const shaped = shapes[shape](page);
    await tick();
    page.radio("stop").click();
    await tick();
    const note = page.field("Note");
    await page.type(note, "选");
    const count = () => (shape === "chat" ? shaped.sent.length : shaped.sent().length);
    note.dispatchEvent(new page.window.CompositionEvent("compositionstart", { bubbles: true }));
    await page.key(note, { key: "Enter", isComposing: true });
    await page.key(note, { key: "Enter", keyCode: 229 });
    assert.equal(count(), 0, `${shape}: the input method's Return is its own`);
    note.dispatchEvent(new page.window.CompositionEvent("compositionend", { bubbles: true }));
    await tick();
    await page.key(note, { key: "Enter", shiftKey: true });
    assert.equal(count(), 0, `${shape}: Shift+Return is a new line`);
    await page.key(note, { key: "Enter" });
    await tick(60);
    assert.equal(count(), 1, `${shape}: Return submits the answers`);
    assert.deepEqual(page.errors, []);
  }
});

test("answers sent show a long text as one block that opens to the whole text", async (t) => {
  // The conversation's form, locked on answers this window did not write.
  const page = mount();
  t.after(page.close);
  const answers = { next: "plan", review: LONG, note: "Short note" };
  const text = clarificationMessage("r1", form, answers);
  const receipt = { input: { clientMessageId: "c1", text, images: [], clarification: { resultId: "r1", formId: "round", answers } }, status: "accepted", turnId: "t", error: null };
  page.window.renderChat({ workspaceId: "ws-1", detail: { agent, turns: [], messageReceipts: [receipt] }, outgoing: [], pendingInputs: {},
    readOnly: false, submit: async () => {}, refresh() {} }, spec, form);
  await tick();
  assert.ok(!page.submit(), "sent: no Submit answers");
  assert.equal(page.chips().length, 1, "the long answer is one block");
  assert.ok(!page.document.body.textContent.includes(DEEP));
  assert.equal(composerText(page.field("Note")), "Short note", "a short one is its words");
  assert.equal(page.chips()[0].disabled, false, "its block still opens");
  page.chips()[0].click();
  await tick();
  const source = await until(() => page.document.querySelector('[role="dialog"] textarea'), "the whole text");
  // A textarea's value gives CRLF as LF; the answer itself is unchanged (above).
  assert.ok(source.value === LONG.replaceAll("\r\n", "\n"), `the whole answer (${source.value.length} characters)`);
  assert.equal(source.readOnly, true, "read-only once sent");

  // The message in the conversation: the form's answers, a long one as a block.
  const sent = mount({ respond: (url) => (url.endsWith("/api/agents/a/results/r1") ? { body: { id: "r1", spec } } : { status: 404, body: { error: "not here" } }) });
  t.after(sent.close);
  sent.window.renderTurn({ id: "t", status: "completed", items: [
    { id: "u", type: "userMessage", clientId: "c1", content: [{ type: "text", text }] },
    { id: "m", type: "agentMessage", text: "Thanks." },
  ] }, agent, [receipt]);
  const card = await until(() => sent.document.querySelector('.clarification-answer[data-state="ready"]'), "the answers");
  const rows = [...card.querySelectorAll("dl > div")];
  assert.equal(rows[1].querySelectorAll(".pasted-text-chip").length, 1, "the review is one block");
  assert.ok(!rows[1].textContent.includes(DEEP));
  assert.equal(rows[2].querySelector("dd").textContent, "Short note");

  // A reply from Home in the conversation, as Core kept it.
  const reply = mount();
  t.after(reply.close);
  reply.window.renderHomeReply({
    agentId: "a", turnId: "t",
    item: { id: "h", type: "userMessage", content: [{ type: "text", text: homeText(answers) }] },
    origin: { projectId: "p1", key: "after", version: 1, workspaceId: "ws", snapshot: {
      format: 1, projectName: "Code", sectionKind: "ask", title: "After round 28", question: "What next after round 28?", options: [], choice: null, text: null,
      form: { id: "round", title: "After round 28", fields: [
        { id: "next", label: "Next step", type: "single", answer: "Write the plan" },
        { id: "review", label: "Codex review", type: "text", answer: LONG },
        { id: "note", label: "Note", type: "text", answer: "Short note" },
      ] } } },
  });
  await tick();
  const answer = reply.document.querySelector(".home-reply-answer");
  assert.equal(answer.querySelectorAll(".pasted-text-chip").length, 1, "the review is one block");
  assert.ok(!answer.textContent.includes(DEEP));
  assert.match(answer.textContent, /Short note/);
  for (const p of [page, sent, reply]) assert.deepEqual(p.errors, []);
});

// Core's limit, and the unit it counts in: what the conversation's form lets
// you send is what Core takes (Home's own is checked by home-long-reply-ui).
test("the conversation's form counts against Core's own message limit", async (t) => {
  const page = mount();
  t.after(page.close);
  const rust = await readFile(path.join(root, "../core/src/model.rs"), "utf8");
  const core = Number(rust.match(/pub const MAX_MESSAGE_TEXT: usize = ([\d_]+);/)?.[1].replaceAll("_", ""));
  assert.equal(page.window.limits.MESSAGE_MAX_BYTES, core, "the page's limit is Core's MAX_MESSAGE_TEXT");
});
