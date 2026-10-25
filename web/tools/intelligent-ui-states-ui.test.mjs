import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-36: replies stay readable while an interactive result is coming, when it
// cannot be shown, and when its viewer fails to load. The real AgentReply and
// InteractiveResult, rendered in JSDOM; no Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "intelligent-ui-states-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {AgentReply, resultChunk} from ${JSON.stringify(path.join(root, "src/intelligent-ui/AgentReply.tsx"))};
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
import {guarded} from ${JSON.stringify(path.join(root, "src/intelligent-ui/InteractiveResult.tsx"))};
const root=createRoot(document.getElementById('root'));
window.chunk=resultChunk;
window.realLoad=resultChunk.load;
window.renderReply=(props)=>flushSync(()=>root.render(<AgentReply identity="a" {...props}/>));
const Broken=guarded(()=>{throw new Error("chart library failed");});
const Fine=guarded(()=><p>Still here</p>);
window.renderTurn=(turn,agent)=>flushSync(()=>root.render(<Turn turn={turn} index={0} agent={agent} onFile={()=>{}}/>));
window.renderParts=()=>flushSync(()=>root.render(<div><Broken/><Fine/></div>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "IntelligentUIStates", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const comparison = {
  root: "result",
  elements: {
    result: { type: "Result", props: { title: "Two options", summary: "B is cheaper." }, children: ["table"] },
    table: {
      type: "Table",
      props: {
        id: "options",
        columns: [{ key: "name", label: "Option" }, { key: "cost", label: "Cost" }],
        rows: [{ id: "a", cells: { name: "A", cost: 12 } }, { id: "b", cells: { name: "B", cost: 9 } }],
      },
    },
  },
};
const fence = (body) => "```yuzuno-ui\n" + body + "\n```";
const reply = (body, { before = "Before **this**.", after = "After it." } = {}) => `${before}\n\n${fence(body)}\n\n${after}`;
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
    const { status = 200, body = {} } = (await respond?.(String(url))) ?? {};
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  const document = window.document;
  const text = () => document.getElementById("root").textContent;
  const button = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  /** Text a reader sees: closed <details> content excluded. */
  const visible = () => {
    const clone = document.getElementById("root").cloneNode(true);
    for (const details of clone.querySelectorAll("details:not([open])"))
      for (const child of [...details.childNodes]) if (child.nodeName !== "SUMMARY") child.remove();
    return clone.textContent;
  };
  return { window, document, errors, requests, text, visible, button, close: () => window.close() };
}

test("a valid result renders between its Markdown, with its JSON folded away", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderReply({ text: reply(JSON.stringify(comparison)) });
  await until(() => page.document.querySelector(".interactive-result"), "result");
  assert.match(page.visible(), /Before this\./);
  assert.match(page.visible(), /After it\./);
  assert.match(page.visible(), /Two options/);
  assert.doesNotMatch(page.visible(), /"root":"result"/, "the JSON is not on screen");
  assert.ok(page.document.querySelector(".result-original:not([open]) pre").textContent.includes('"root":"result"'));
});

test("a streaming block shows a placeholder, then the result, and an unclosed one ends as a readable note", async (t) => {
  const page = mount();
  t.after(page.close);
  const partial = `Working on it.\n\n\`\`\`yuzuno-ui\n${JSON.stringify(comparison).slice(0, 60)}`;
  page.window.renderReply({ text: partial, complete: false });
  assert.match(page.visible(), /Working on it\./);
  assert.match(page.visible(), /Generating interactive result…/);
  assert.doesNotMatch(page.text(), /"root"/, "partial JSON is never shown while it is written");
  page.window.renderReply({ text: reply(JSON.stringify(comparison)), complete: false });
  await until(() => page.document.querySelector(".interactive-result"), "result once closed");
  page.window.renderReply({ text: partial, complete: true });
  const note = page.document.querySelector('[data-result-state="unfinished"]');
  assert.ok(note, "an unclosed block of a finished reply is not left loading");
  assert.match(page.visible(), /stopped before it was complete/);
  assert.doesNotMatch(page.visible(), /Generating/);
  assert.ok(note.querySelector("details:not([open])"), "details and JSON are folded");
});

test("invalid JSON, unknown components and unknown fields stay local with folded details", async (t) => {
  const page = mount();
  t.after(page.close);
  const unknown = structuredClone(comparison);
  unknown.elements.table.type = "iframe";
  const extra = structuredClone(comparison);
  extra.elements.result.props.color = "red";
  for (const [body, code, where] of [
    ["{ not json", "invalid_json", null],
    [JSON.stringify(unknown), "unknown_component", "elements.table.type"],
    [JSON.stringify(extra), "unknown_field", "elements.result.props"],
  ]) {
    page.window.renderReply({ text: reply(body) });
    assert.match(page.visible(), /Before this\./);
    assert.match(page.visible(), /After it\./);
    assert.match(page.visible(), /its format isn’t valid/);
    assert.ok(!page.visible().includes(body), "the raw block is folded, not shown");
    const details = page.document.querySelector('[data-result-state="format"] details');
    assert.ok(!details.open);
    assert.match(details.textContent, new RegExp(code));
    if (where) assert.match(details.textContent, new RegExp(where.replaceAll(".", "\\.")));
    assert.ok(details.querySelector("pre").textContent === body, "the JSON is kept exactly");
    assert.ok(page.button("Copy result JSON"), "it can be copied");
    assert.ok(!page.button("Try again"), "nothing to retry for a format error");
  }
  assert.equal(page.requests.length, 0, "no requests, no messages, no model calls");
});

test("a viewer that fails to load is fetched again for real, under a new URL", async (t) => {
  // A browser keeps a failed module fetch for its URL (Chromium does), so the
  // retry must import the chunk the failure names under a new URL.
  const page = mount();
  t.after(page.close);
  const chunk = "http://isolated.test/assets/InteractiveResult-abc.js";
  const tried = [];
  let online = false;
  const offline = (url) => Promise.reject(new page.window.TypeError(`Failed to fetch dynamically imported module: ${url}`));
  page.window.chunk.load = () => { tried.push("load"); return offline(chunk); };
  page.window.chunk.loadFrom = (url) => { tried.push(url); return online ? page.window.realLoad() : offline(url); };
  page.window.renderReply({ text: reply(JSON.stringify(comparison)) });
  await until(() => page.document.querySelector('[data-result-state="load"]'), "load failure");
  assert.match(page.visible(), /Before this\./);
  assert.match(page.visible(), /viewer couldn’t be loaded/);
  assert.ok(page.button("Reload Yuzuno"), "a reload is offered from the first failure");
  // Still offline: a second real attempt under a new URL, which fails again.
  page.button("Try again").click();
  await until(() => tried.length === 2 && page.document.querySelector('[data-result-state="load"]'), "second attempt");
  online = true;
  page.button("Try again").click();
  await until(() => page.document.querySelector(".interactive-result"), "loaded on retry");
  assert.deepEqual(tried, ["load", `${chunk}?retry=1`, `${chunk}?retry=2`]);
  assert.equal(page.requests.length, 0, "retrying asks nothing of Core or the Agent");
});

test("after an update the old chunk never loads again; Reload stays offered with Try again", async (t) => {
  // R1: a deploy replaces the chunk's hash; the server answers the old URL
  // with HTML or 404 forever, so retrying in place can never succeed.
  const page = mount();
  t.after(page.close);
  const chunk = "http://isolated.test/assets/InteractiveResult-old.js";
  let reloads = 0;
  const tried = [];
  const gone = (url) => { tried.push(url); return Promise.reject(new page.window.TypeError(`Failed to fetch dynamically imported module: ${url}`)); };
  page.window.chunk.load = () => gone(chunk);
  page.window.chunk.loadFrom = gone;
  page.window.chunk.reloadPage = () => { reloads += 1; };
  page.window.renderReply({ text: reply(JSON.stringify(comparison)) });
  await until(() => page.document.querySelector('[data-result-state="load"]'), "load failure");
  for (let attempt = 1; attempt <= 2; attempt++) {
    page.button("Try again").click();
    // The count rises only once the retry renders, so this failure is a new one.
    await until(() => tried.length === attempt + 1 && page.document.querySelector('[data-result-state="load"]'), `failure ${attempt}`);
    assert.ok(page.button("Try again"));
    assert.ok(page.button("Reload Yuzuno"), `Reload is still offered after attempt ${attempt}`);
  }
  assert.match(page.visible(), /Before this\.[\s\S]*After it\./);
  page.button("Reload Yuzuno").click();
  assert.equal(reloads, 1);
  assert.deepEqual(tried, [chunk, `${chunk}?retry=1`, `${chunk}?retry=2`], "every Try again was a real request");
  assert.equal(page.requests.length, 0);
});

test("when the failure does not name the chunk, the only real recovery offered is a reload", async (t) => {
  const page = mount();
  t.after(page.close);
  let reloads = 0;
  page.window.chunk.load = () => Promise.reject(new page.window.TypeError("Importing a module script failed."));
  page.window.chunk.reloadPage = () => { reloads += 1; };
  page.window.renderReply({ text: reply(JSON.stringify(comparison)) });
  await until(() => page.document.querySelector('[data-result-state="load"]'), "load failure");
  assert.ok(!page.button("Try again"), "no in-place retry that could not fetch anything");
  page.button("Reload Yuzuno").click();
  assert.equal(reloads, 1);
});

test("a render error is told apart from a load failure and offers no fake retry", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.chunk.load = async () => ({ default: () => { throw new Error("boom in renderer"); } });
  page.window.renderReply({ text: reply(JSON.stringify(comparison)) });
  await until(() => page.document.querySelector('[data-result-state="render"]'), "render failure");
  assert.match(page.visible(), /couldn’t be displayed/);
  assert.ok(!page.button("Try again"));
  assert.match(page.document.querySelector('[data-result-state="render"] details').textContent, /render_error[\s\S]*boom in renderer/);
});

test("one part that fails to render leaves a note in its place and the rest shown", async (t) => {
  // json-render's own element boundary would render it as nothing.
  const page = mount();
  t.after(page.close);
  page.window.renderParts();
  await until(() => page.document.querySelector(".result-part-error"), "part note");
  assert.match(page.text(), /This part of the result couldn’t be displayed\.Still here/);
});

test("a reply sent as a preview is never judged broken; its full text is read first", async (t) => {
  let fail = true;
  const full = reply(JSON.stringify(comparison));
  const page = mount((url) => {
    if (!url.includes("/payload")) return undefined;
    return fail ? { status: 500, body: { error: "unavailable" } } : { body: { fields: { text: full } } };
  });
  t.after(page.close);
  const item = { id: "m", type: "agentMessage", text: full.slice(0, 80), _yuzunoTruncated: { text: { bytes: full.length, keep: "head" } } };
  page.window.renderReply({ text: item.text, source: { agentId: "agent", turnId: "turn", item } });
  await until(() => page.document.querySelector('[data-result-state="payload"]'), "payload failure");
  assert.ok(!page.document.querySelector('[data-result-state="unfinished"], [data-result-state="format"]'), "a cut-off preview is not a format error");
  fail = false;
  page.button("Try again").click();
  await until(() => page.document.querySelector(".interactive-result"), "full reply parsed");
  assert.ok(page.requests.every((r) => r.method === "GET" && r.url.includes("/items/m/payload")), JSON.stringify(page.requests));
});

test("in a conversation, a block stops generating once nothing more is coming for its message", async (t) => {
  // components.tsx: complete = Turn not running, execution unconfirmed, or the
  // message itself completed (Codex item/completed, Claude's confirmed text).
  const page = mount();
  t.after(page.close);
  const agent = (status) => ({ id: "a", name: "Mori", harness: "codex", color: "sage", status, cwd: "/w", goal: "", model: "",
    createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0 });
  const unclosed = "Working.\n\n```yuzuno-ui\n" + JSON.stringify(comparison).slice(0, 70);
  const state = (status, agentStatus, completed) => {
    const item = { id: "m", type: "agentMessage", text: unclosed, ...(completed ? { _yuzunoCompletedText: unclosed } : {}) };
    page.window.renderTurn({ id: "t", status, items: [{ id: "u", type: "userMessage", content: [{ type: "text", text: "Go" }] }, item] }, agent(agentStatus));
    return page.document.querySelector("[data-item-id=m] [data-result-state]")?.dataset.resultState
      ?? (page.document.querySelector("[data-item-id=m]").textContent.includes("Generating") ? "generating" : "none");
  };
  assert.equal(state("inProgress", "working", false), "generating", "still streaming");
  assert.equal(state("inProgress", "working", true), "unfinished", "the message finished while the Turn goes on");
  assert.equal(state("interrupted", "idle", false), "unfinished", "the Turn was interrupted");
  assert.equal(state("outcomeUnknown", "uncertain", false), "unfinished", "the outcome is unknown");
  assert.equal(state("inProgress", "offline", false), "unfinished", "the runtime went away with the Turn still open");
  assert.equal(state("inProgress", "waiting", false), "generating", "waiting for the user is still a live Turn");
});

test("a preview without a result block is never read in full", async (t) => {
  const page = mount(() => assert.fail("no payload request"));
  t.after(page.close);
  const item = { id: "m", type: "agentMessage", text: "A long plain reply…", _yuzunoTruncated: { text: { bytes: 90_000, keep: "head" } } };
  page.window.renderReply({ text: item.text, source: { agentId: "agent", turnId: "turn", item } });
  await tick(100);
  assert.match(page.text(), /A long plain reply/);
  assert.equal(page.requests.length, 0);
});

// T-189: the words around a result follow the interface language. What the
// Agent wrote, the JSON and the validator's code and place stay as written.
test("the words around a result follow the language; what the Agent wrote and the JSON stay as written", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
  page.window.renderReply({ text: reply(JSON.stringify(comparison)) });
  await until(() => page.document.querySelector(".interactive-result"), "result");
  assert.equal(page.document.querySelector(".result-disclosure > summary").textContent, "交互结果");
  assert.equal(page.document.querySelector(".result-original summary").textContent, "查看结果 JSON");
  assert.ok(page.button("复制结果 JSON"));
  assert.match(page.visible(), /Two options/, "the Agent's title as written");
  assert.match(page.visible(), /B is cheaper\./, "the Agent's summary as written");
  page.window.renderReply({ text: `Working on it.\n\n\`\`\`yuzuno-ui\n${JSON.stringify(comparison).slice(0, 60)}`, complete: false });
  assert.match(page.visible(), /正在生成交互结果…/);
  page.window.renderReply({ text: reply("{ not json") });
  const note = page.document.querySelector('[data-result-state="format"]');
  assert.equal(note.querySelector("p[role=status] span").textContent, "此交互结果无法显示：它的格式无效。");
  const details = note.querySelector("details");
  assert.equal(details.querySelector("summary").textContent, "详情与结果 JSON");
  assert.ok(details.textContent.includes("代码invalid_json"), "the validator's code as it is");
  assert.equal(details.querySelector("pre").textContent, "{ not json");
  details.open = true;
  page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" }));
  page.window.dispatchEvent(new page.window.StorageEvent("storage", { key: "yuzuno.language" }));
  await tick();
  assert.match(page.visible(), /its format isn’t valid/);
  assert.ok(page.document.querySelector('[data-result-state="format"] details').open, "the open details stay open");
  page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
  page.window.dispatchEvent(new page.window.StorageEvent("storage", { key: "yuzuno.language" }));
  page.window.renderParts();
  await tick();
  assert.match(page.text(), /结果的这一部分无法显示。/);
  assert.match(page.text(), /Still here/);
  assert.equal(page.requests.length, 0, "no requests, no messages, no model calls");
});

test("a form in a reply says why it can't be answered here in the interface language; its questions as written", async (t) => {
  const { clarificationExample } = await import("../src/intelligent-ui/clarification.ts");
  const page = mount();
  t.after(page.close);
  page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
  const spec = {
    root: "result",
    elements: {
      result: { type: "Result", props: { title: "Development preview", summary: "Confirm these settings." }, children: ["form"] },
      form: { type: "Clarification", props: clarificationExample },
    },
  };
  page.window.renderReply({ text: reply(JSON.stringify(spec)) });
  await until(() => page.document.querySelector(".clarification-delivery"), "the form's notice");
  assert.equal(page.document.querySelector(".clarification-delivery").textContent, "请让 Agent 发布这个表单，这样你的答案才能关联到原始会话。");
  assert.match(page.text(), /Working directory必填/);
  assert.match(page.text(), /Development preview/);
  assert.equal(page.requests.length, 0, "nothing is sent");
});
