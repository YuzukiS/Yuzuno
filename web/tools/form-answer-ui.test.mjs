import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { clarificationMessage } from "../src/intelligent-ui/clarification.ts";

// T-9: a message that answered a published form shows as that form's
// questions and the labels chosen, not as the JSON sent to the Agent. Only
// its send receipt names the form. The real Turn and OutgoingMessages, in
// JSDOM, with Core answered by a fixture; no Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "form-answer-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
import {OutgoingMessages} from ${JSON.stringify(path.join(root, "src/OutgoingMessages.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderTurn=(turn,agent,receipts)=>flushSync(()=>root.render(<Turn turn={turn} index={0} agent={agent} receipts={receipts} onFile={()=>{}}/>));
window.renderOutgoing=(messages)=>flushSync(()=>root.render(<OutgoingMessages agentId="a" messages={messages} detail={null}/>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "FormAnswer", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick(15);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function mount(respond) {
  const errors = [];
  const requests = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    const { status = 200, body = {} } = (await respond?.(String(url), requests.length)) ?? {};
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  const document = window.document;
  /** Text a reader sees: closed <details> content excluded. */
  const visible = () => {
    const clone = document.getElementById("root").cloneNode(true);
    for (const details of clone.querySelectorAll("details:not([open])"))
      for (const child of [...details.childNodes]) if (child.nodeName !== "SUMMARY") child.remove();
    return clone.textContent;
  };
  return { window, document, errors, requests, visible, close: () => window.close() };
}

// A synthetic form, published as a result (as result_publish stores it).
const form = {
  id: "weekly-check",
  title: "Weekly check",
  fields: [
    { id: "build", type: "single", label: "Did the build start?", required: true,
      options: [{ id: "ok", label: "Started normally" }, { id: "slow", label: "Started slowly" }] },
    { id: "devices", type: "multi", label: "Devices tried", required: false,
      options: [{ id: "phone", label: "Phone" }, { id: "laptop", label: "Laptop" }, { id: "tablet", label: "Tablet" }] },
    { id: "issue", type: "single", label: "Any wrong content?", required: false,
      options: [{ id: "none", label: "None seen" }, { id: "some", label: "Some" }] },
    { id: "notes", type: "text", label: "Anything else", required: false },
  ],
};
const spec = (props = form) => ({
  root: "result",
  elements: {
    result: { type: "Result", props: { title: "Check-in" }, children: ["form"] },
    form: { type: "Clarification", props },
  },
});
const answers = { build: "ok", devices: ["tablet", "phone"], issue: "", notes: "Line one\nline two" };
const text = clarificationMessage("r1", form, answers);
const agent = { id: "a", name: "Mori", harness: "codex", color: "sage", status: "idle", cwd: "/w", goal: "", model: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0 };
const receipt = (input = {}, status = "accepted") => ({
  input: { clientMessageId: "c1", text, images: [], clarification: { resultId: "r1", formId: form.id, answers }, ...input },
  status, turnId: "t", error: null,
});
const turn = (item) => ({ id: "t", status: "completed", items: [
  { id: "u", type: "userMessage", content: [{ type: "text", text }], ...item },
  { id: "m", type: "agentMessage", text: "Thanks." },
] });
const published = (body = spec()) => (url) =>
  url.endsWith("/api/agents/a/results/r1") ? { body: { id: "r1", spec: body } } : { status: 404, body: { error: "not here" } };

test("a form's answers show as its questions and labels, with the text sent folded away", async (t) => {
  const page = mount(published());
  t.after(page.close);
  page.window.renderTurn(turn({ clientId: "c1" }), agent, [receipt()]);
  const card = await until(() => page.document.querySelector('.clarification-answer[data-state="ready"]'), "the answers");
  assert.ok(card.closest(".user-message"), "in place of the message's text");
  assert.equal(card.querySelector("h4").textContent, "Weekly check");
  const rows = [...card.querySelectorAll("dl > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]);
  assert.deepEqual(rows, [
    ["Did the build start?", "Started normally"],
    ["Devices tried", "PhoneTablet"],
    ["Any wrong content?", "Not answered"],
    ["Anything else", "Line one\nline two"],
  ], "each question with its labels, in the form's own order");
  assert.deepEqual([...card.querySelectorAll("dl > div:nth-child(2) li")].map((li) => li.textContent), ["Phone", "Tablet"]);
  assert.equal(card.querySelector("dl > div:nth-child(3) dd").dataset.empty, "true");
  for (const hidden of ["resultId", "formId", "answers", "weekly-check", "{"])
    assert.ok(!page.visible().includes(hidden), `${hidden} is not on screen`);
  const sent = card.querySelector("details.clarification-answer-sent:not([open])");
  assert.equal(sent.querySelector("summary").textContent, "Text sent to the Agent");
  assert.equal(sent.querySelector("pre").textContent, text, "the exact text sent, one click away");
  assert.deepEqual(page.requests.map((r) => [r.method, new URL(r.url).pathname]), [["GET", "/api/agents/a/results/r1"]]);
  assert.deepEqual(page.errors, []);
});

test("after a reload, an older history page or a new Claude Turn, the message's client ID names the same answers", async (t) => {
  const page = mount(published());
  t.after(page.close);
  // Core restores the receipt's client ID on a history item (item-N) it binds.
  page.window.renderTurn(turn({ id: "item-3", clientId: "c1" }), agent, [receipt({}, "accepted")]);
  await until(() => page.document.querySelector('[data-item-id="item-3"] .clarification-answer[data-state="ready"]'), "restored history");
  // A new Claude Turn names its first message before Claude confirms it.
  page.window.renderTurn(turn({ _yuzunoClientMessageId: "c1" }), { ...agent, harness: "claude" }, [receipt({}, "sending")]);
  await until(() => page.document.querySelector('[data-item-id="u"] .clarification-answer[data-state="ready"]'), "a new Claude Turn");
  assert.equal(page.requests.length, 1, "a published version is read once");
});

test("a message is never taken for a form's answers by how it looks", async (t) => {
  const page = mount(() => assert.fail("nothing is read"));
  t.after(page.close);
  const plain = (item, receipts, why) => {
    page.window.renderTurn(turn(item), agent, receipts);
    assert.equal(page.document.querySelector(".clarification-answer"), null, why);
    assert.ok(page.document.querySelector('[data-item-id="u"] .user-text').textContent.includes('"formId": "weekly-check"'), `${why}: shown as written`);
  };
  plain({}, [receipt()], "no client ID");
  plain({ clientId: "c1" }, undefined, "no receipts");
  plain({ clientId: "c2" }, [receipt()], "another message's receipt");
  plain({ clientId: "c1" }, [receipt({ clarification: undefined })], "a receipt that answered no form");
  plain({ clientId: "c1" }, [receipt({ text: text + " " })], "other text than the receipt checked");
  await tick(60);
  assert.equal(page.requests.length, 0);
});

test("a form that can't be shown says so and leaves the text as sent", async (t) => {
  const unavailable = async (respond, why) => {
    const page = mount(respond);
    t.after(page.close);
    page.window.renderTurn(turn({ clientId: "c1" }), agent, [receipt()]);
    const card = await until(() => page.document.querySelector('.clarification-answer[data-state="unavailable"]'), why);
    assert.match(card.textContent, /The original form can't be shown, so this is the text that was sent\./, why);
    assert.ok(card.querySelector(".clarification-answer-text").textContent.includes('"formId": "weekly-check"'), `${why}: the text as sent`);
    return { page, card };
  };
  const gone = await unavailable(() => ({ status: 404, body: { error: "gone" } }), "a result that is gone");
  assert.equal(gone.card.querySelector("button"), null, "nothing to try again");
  await unavailable(published(spec({ ...form, id: "another-form" })), "a result without that form");
  await unavailable(published(spec({ ...form, fields: form.fields.filter((f) => f.id !== "devices") })), "answers the form does not take");
  // A failed read can be tried again; the second read shows the answers.
  const { page, card } = await unavailable((url, n) => (n === 1 ? { status: 503, body: { error: "busy" } } : published()(url)), "a failed read");
  card.querySelector("button").click();
  await until(() => page.document.querySelector('.clarification-answer[data-state="ready"]'), "the answers after trying again");
  assert.equal(page.requests.length, 2);
});

test("answers still sending show the same card, with their delivery note", async (t) => {
  const page = mount(published());
  t.after(page.close);
  page.window.renderOutgoing([{ agentId: "a", receipt: receipt({}, "sending") }]);
  const card = await until(() => page.document.querySelector('.outgoing-message .clarification-answer[data-state="ready"]'), "the card");
  assert.equal(card.querySelector("h4").textContent, "Weekly check");
  assert.ok(page.document.querySelector('.outgoing-message [role="status"]').textContent.trim(), "the delivery note stays");
  assert.ok(!page.visible().includes("resultId"));
});
