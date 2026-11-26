// YN-234: an Agent's long reply, streamed to the real app (the built UI,
// flattened as ui-test-bundle does) as Core streams it, `agent.delta` by
// `agent.delta`. What was already written keeps its nodes: a paragraph two
// screens up is the same element after more arrives, and so is a selection
// in it. The reply then reads exactly as it reads when opened again later,
// and short replies, Markdown that spans blocks and the text around a
// structured result's card read as before (an edit: ui.test.mjs).
//   YUZUNO_UI_DIST=<isolated build> node tools/stream-prose-ui.test.mjs
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

const dist = pathToFileURL(resolve(process.env.YUZUNO_UI_DIST || "dist") + "/");
const index = await readFile(new URL("index.html", dist), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)[1];
const bundle = await uiTestBundle(new URL(entry, dist));
const pause = (ms = 45) => new Promise((r) => setTimeout(r, ms));
async function until(check, label = "condition", ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await pause(20);
  }
  assert.ok(check(), `${label} should settle`);
}
// detail-sync.ts applies streamed changes at most this long after they came.
const settle = () => pause(100 + 80);

const para = (i) => `第 ${i} 段比较 **请求卡** 和 *项目状态*。查看 [这份记录](https://example.invalid/report/${i})，再核对 \`currentState\` 的结果。`;

async function mount({ text = "", second = null } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4452/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};
  const realInterval = w.setInterval;
  w.setInterval = function (handler, delay, ...args) {
    return delay === 5_000 || delay === 60_000 ? 0 : realInterval.call(w, handler, delay, ...args);
  };
  w.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" }));
  w.localStorage.setItem("yuzuno.selected.ws-stream", JSON.stringify("a1"));
  const base = { harness: "codex", cwd: "/w", model: "m", color: "sage", createdAt: "", updatedAt: "",
    unreadCount: 0, pendingCount: 0, reviewedSeq: 0, connectionState: "connected", lastSeq: 10, rev: 10 };
  const core = {
    agents: [
      { ...base, id: "a1", name: "Writer", status: "working" },
      { ...base, id: "a2", name: "Other", status: "idle" },
    ],
    rev: 10,
    reply: { id: "m1", type: "agentMessage", text },
    status: "inProgress",
    streams: [],
  };
  w.EventSource = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      core.streams.push(this);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  w.fetch = async (url) => {
    const { pathname: path } = new URL(String(url), w.location.href);
    if (/^\/api\/agents\/[^/]+\/codex\/usage$/.test(path))
      return { ok: false, status: 404, json: async () => ({ error: "No usage" }), text: async () => '{"error":"No usage"}' };
    let body = {};
    if (path === "/api/workspace")
      body = { workspace: { id: "ws-stream" }, agents: core.agents, projects: [], runtime: { connected: true }, defaultCwd: "/w" };
    else if (path === "/api/agents/a1") {
      const agent = { ...core.agents[0], rev: core.rev, lastSeq: core.rev, status: core.status === "inProgress" ? "working" : "idle" };
      body = { agent, pending: [], artifacts: [], messageReceipts: [], turns: [{ id: "t1", status: core.status, items: [
        { id: "u1", type: "userMessage", content: [{ type: "text", text: "Write it up." }] },
        core.reply,
      ] }] };
    } else if (path === "/api/agents/a2") {
      body = { agent: core.agents[1], pending: [], artifacts: [], messageReceipts: [], turns: [{ id: "t2", status: "completed", items: [
        { id: "u2", type: "userMessage", content: [{ type: "text", text: "Hi." }] },
        { id: "m2", type: "agentMessage", text: second ?? "Hello." },
      ] }] };
    } else if (path === "/api/catchup") body = { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } };
    else if (path === "/api/merge-queue") body = { entries: [] };
    else if (path === "/api/ci/live" || path === "/api/waits/live" || path === "/api/jobs/live") body = { agents: {} };
    else if (path === "/api/home") body = { generatedAt: "", order: [], needsYou: [], projects: [] };
    return { ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
  };
  w.eval(bundle);
  const d = w.document;
  const p = { w, d, core, errors, close: () => w.close() };
  try {
    await until(() => d.querySelector('[data-item-id="m1"]'), "the reply shown");
    const stream = core.streams.at(-1);
    stream.readyState = 1;
    stream.onopen?.({});
    p.send = (data) => stream.onmessage?.({ data: JSON.stringify(data), lastEventId: "" });
    p.send({ type: "reset", reason: "open" });
    await pause(400);
  } catch (error) {
    w.close();
    throw error;
  }
  p.prose = () => d.querySelector('[data-item-id="m1"] .prose');
  /** Text appended to the reply, as Core streams it. */
  p.append = (more) => {
    core.reply = { ...core.reply, text: core.reply.text + more };
    core.rev += 1;
    p.send({ type: "agent.delta", agentId: "a1", rev: core.rev, turnId: "t1", itemId: "m1", op: "append", field: "text", text: more });
  };
  /** The reply's Item completed and its Turn ended, as Core says so. */
  p.finish = async () => {
    core.reply = { ...core.reply, _yuzunoCompletedText: core.reply.text };
    core.rev += 1;
    p.send({ type: "agent.item", agentId: "a1", rev: core.rev, turnId: "t1", item: core.reply });
    core.status = "completed";
    core.rev += 1;
    p.send({ type: "agent.changed", agentId: "a1", rev: core.rev, lastSeq: core.rev });
    await settle();
    await pause(300);
  };
  p.open = async (id, item) => {
    d.querySelector(`.agent-row[data-agent-id="${id}"] .agent-select`).click();
    await until(() => d.querySelector(`[data-item-id="${item}"] .prose`), `${id}'s conversation`);
    await pause(200);
  };
  return p;
}

/** A prose element's HTML without the spans of words still fading in. */
function plain(element) {
  const copy = element.cloneNode(true);
  for (const span of copy.querySelectorAll(".stream-word")) span.replaceWith(...span.childNodes);
  copy.normalize();
  return copy.innerHTML;
}

test("a long reply keeps what it already shows as more streams in, and then reads as it does when opened again", async () => {
  const p = await mount({ text: Array.from({ length: 6 }, (_, i) => para(i + 1)).join("\n\n") });
  try {
    const first = p.prose().querySelector("p");
    assert.match(first.textContent, /^第 1 段/);
    // The reader selects a word in the first paragraph.
    const strong = first.querySelector("strong");
    const selection = p.d.getSelection();
    const range = p.d.createRange();
    range.selectNodeContents(strong);
    selection.removeAllRanges();
    selection.addRange(range);
    for (let i = 7; i <= 12; i++) {
      for (const piece of ["\n\n", `第 ${i} 段比较 `, "**请求卡** 和 *项目", "状态*。查看 [这份记录](https://example.invalid/report/", `${i})，再核对 \`currentState\` 的结果。`]) {
        p.append(piece);
        await settle();
      }
    }
    await until(() => p.prose().textContent.includes("第 12 段比较 请求卡 和 项目状态。查看 这份记录，再核对 currentState 的结果。"), "the last paragraph shown");
    assert.equal(p.prose().querySelector("p"), first, "the first paragraph is the same element");
    assert.equal(p.prose().querySelectorAll("p").length, 12);
    assert.equal(selection.rangeCount, 1, "the selection is still there");
    assert.equal(selection.toString(), "请求卡", "and still selects the same word");
    assert.equal(selection.getRangeAt(0).startContainer, strong);
    selection.removeAllRanges();

    await p.finish();
    const streamed = plain(p.prose());
    // Opened again: the same reply, drawn whole as any finished reply is.
    await p.open("a2", "m2");
    await p.open("a1", "m1");
    assert.equal(p.prose().querySelectorAll(".stream-word").length, 0);
    assert.equal(plain(p.prose()), streamed, "the streamed reply reads as the reply opened again");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("lists, a code fence still open, reference links and raw HTML read as when opened again", async () => {
  const p = await mount({ text: "Intro paragraph.\n\n" });
  try {
    const pieces = [
      "Steps:\n- one\n- two", "\n\n- three, now", " loose\n\n  more of three\n\n", "1. first\n2. sec", "ond\n\n",
      "See [the report][r] and **bold", " across** a chunk.\n\n", "```ts\nconst a = 1;\n\n", "# not a heading\n", "```\n\n",
      "中文**粗体。**汉字 <b>raw</b> HTML.\n\n", "[r]: https://example.invalid/report\n\nEnd",
    ];
    for (const piece of pieces) {
      p.append(piece);
      await settle();
    }
    await until(() => p.prose().textContent.includes("End"), "the end shown");
    const prose = p.prose();
    assert.equal(prose.querySelectorAll("ul").length, 1, "one loose list");
    assert.ok(prose.querySelector("ul li p"), "its items are paragraphs");
    assert.equal(prose.querySelector("ol").children.length, 2);
    assert.equal(prose.querySelector("pre code").textContent, "const a = 1;\n\n# not a heading\n");
    assert.equal(prose.querySelector('a[href="https://example.invalid/report"]').textContent, "the report", "a link to a definition below it");
    assert.equal(prose.querySelector("p b")?.textContent, "raw");
    await p.finish();
    const streamed = plain(p.prose());
    await p.open("a2", "m2");
    await p.open("a1", "m1");
    assert.equal(plain(p.prose()), streamed);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a short reply, and the Markdown around a structured result's card, read as before", async () => {
  const result = { root: "result", elements: { result: { type: "Result", props: { title: "Two numbers", summary: "Both measured." }, children: [] } } };
  const p = await mount({ text: "Done" });
  try {
    for (const piece of [".", " Here is", " the result:\n\n"]) {
      p.append(piece);
      await settle();
    }
    assert.match(p.prose().textContent, /^Done\. Here is the result:/);
    p.append(`\`\`\`yuzuno-ui\n${JSON.stringify(result)}\n\`\`\`\n\nAfter the card.`);
    await settle();
    await until(() => [...p.d.querySelectorAll('[data-item-id="m1"] .prose')].some((e) => e.textContent.includes("After the card.")), "the text after it");
    await p.finish();
    await until(() => p.d.querySelector('[data-item-id="m1"] .interactive-result'), "the result's card", 5000);
    assert.match(p.d.querySelector('[data-item-id="m1"] .interactive-result h3').textContent, /Two numbers/);
    const texts = [...p.d.querySelectorAll('[data-item-id="m1"] .prose')].map((e) => e.textContent.trim());
    assert.deepEqual(texts, ["Done. Here is the result:", "After the card."]);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
