import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-37: results an Agent published with result_publish, shown with their
// Turn. The real Turn, TurnResults and InteractiveResult in JSDOM, with Core's
// result endpoint answered here; no Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "turn-results-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderTurn=(turn,agent)=>flushSync(()=>root.render(<Turn turn={turn} index={0} agent={agent} onFile={()=>{}} onAnswer={(text)=>window.drafts.push(text)}/>));
window.drafts=[];`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "TurnResults", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const spec = (title) => ({
  root: "result",
  elements: {
    result: { type: "Result", props: { title, summary: "B is cheaper." }, children: ["table"] },
    table: {
      type: "Table",
      props: {
        id: "options",
        title: "Table",
        selectable: true,
        columns: [{ key: "name", label: "Option" }, { key: "cost", label: "Cost" }],
        rows: [{ id: "a", cells: { name: "A", cost: 12 } }, { id: "b", cells: { name: "B", cost: 9 } }],
      },
    },
  },
});
const agent = (status = "idle") => ({ id: "a", name: "Mori", harness: "codex", color: "sage", status, cwd: "/w", goal: "",
  model: "", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0 });
const shown = (id, version = 1, chainId = id) => ({ id, chainId, version, createdAt: "2026-10-14T00:00:00Z" });
const turn = (status, results, items = [{ id: "m", type: "agentMessage", text: "Here is the comparison." }]) => ({
  id: "t", status, _yuzunoResults: results,
  items: [{ id: "u", type: "userMessage", content: [{ type: "text", text: "Compare" }] }, ...items],
});
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
    const pathname = new URL(String(url), window.location.href).pathname;
    requests.push({ url: pathname, method: init.method || "GET" });
    const { status = 200, body = {} } = (await respond(pathname)) ?? {};
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  const document = window.document;
  const text = () => document.getElementById("root").textContent;
  const button = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  return { window, document, errors, requests, text, button, close: () => window.close() };
}

const found = (id, value) => ({ body: { id, agentId: "a", chainId: id, version: 1, turnId: "t", schemaVersion: 1, spec: value, defaults: [] } });

test("a published result is read once and shown after the Turn's reply", async (t) => {
  const page = mount((url) => url === "/api/agents/a/results/r1" ? found("r1", spec("Two options")) : { status: 404 });
  t.after(page.close);
  page.window.renderTurn(turn("completed", [shown("r1")]), agent());
  const result = await until(() => page.document.querySelector(".turn-results .interactive-result"), "result");
  assert.equal(result.dataset.resultId, "r1", "its selection belongs to this version");
  assert.match(page.text(), /Here is the comparison\.[\s\S]*Two options/, "after the reply");
  page.window.renderTurn(turn("completed", [shown("r1")]), agent());
  await tick(50);
  assert.deepEqual(page.requests, [{ url: "/api/agents/a/results/r1", method: "GET" }]);
  assert.deepEqual(page.errors, []);
});

test("an accepted result stays visible when the Turn fails or is interrupted, without a final reply", async (t) => {
  const page = mount(() => found("r1", spec("Kept")));
  t.after(page.close);
  for (const status of ["failed", "interrupted"]) {
    page.window.renderTurn(turn(status, [shown("r1")], []), agent());
    await until(() => page.document.querySelector(".turn-results .interactive-result"), `result in a ${status} Turn`);
    assert.match(page.text(), /Kept/);
    assert.doesNotMatch(page.text(), /\b(done|complete[d]?)\b/i, "a result is not a completion");
  }
  page.window.renderTurn(turn("inProgress", [shown("r1")], []), agent("working"));
  await until(() => page.document.querySelector(".turn-results .interactive-result"), "result in a running Turn");
  assert.ok(page.document.querySelector(".turn-activity"), "the Turn still reads as working");
});

test("a result that cannot be read offers Try again, which only reads it again", async (t) => {
  let fail = true;
  const page = mount(() => fail ? { status: 500, body: { error: "database busy" } } : found("r2", spec("Back")));
  t.after(page.close);
  page.window.renderTurn(turn("completed", [shown("r2")]), agent());
  await until(() => page.document.querySelector("[data-result-state=fetch]"), "load failure");
  assert.match(page.text(), /couldn’t be loaded/);
  assert.match(page.text(), /Here is the comparison\./, "the reply stays readable");
  fail = false;
  page.button("Try again").click();
  await until(() => page.document.querySelector(".turn-results .interactive-result"), "result after retry");
  assert.ok(page.requests.every((request) => request.method === "GET"), "no model call, no write");
  assert.equal(page.requests.length, 2);
});

test("a missing result says so without a retry, and an unreadable one shows its JSON", async (t) => {
  const page = mount((url) => url.endsWith("/gone") ? { status: 404, body: { error: "No such result", code: "result_not_found" } }
    : found("bad", { root: "result", elements: { result: { type: "Html", props: {} } } }));
  t.after(page.close);
  page.window.renderTurn(turn("completed", [shown("gone"), shown("bad")]), agent());
  await until(() => page.document.querySelector("[data-result-state=missing]") && page.document.querySelector("[data-result-state=format]"), "both notes");
  assert.ok(page.document.querySelector("[data-result-state=missing] button") === null, "a missing result offers no retry");
  assert.match(page.document.querySelector("[data-result-state=format] pre").textContent, /"Html"/);
  assert.match(page.text(), /Here is the comparison\./);
});

test("a new version replaces the shown one and starts with its own selection", async (t) => {
  const page = mount((url) => url.endsWith("/v1") ? found("v1", spec("First")) : found("v2", spec("Second")));
  t.after(page.close);
  page.window.renderTurn(turn("completed", [shown("v1")]), agent());
  await until(() => page.document.querySelector("[data-result-id=v1]"), "first version");
  const row = await until(() => page.document.querySelector("[data-result-id=v1] tbody input[type=checkbox]"), "a selectable row");
  row.click();
  await until(() => page.document.querySelector("[data-result-id=v1] tbody input[type=checkbox]:checked"), "selected");
  page.window.renderTurn(turn("completed", [shown("v2", 2, "v1")]), agent());
  await until(() => page.document.querySelector("[data-result-id=v2]"), "second version");
  assert.ok(page.document.querySelector("[data-result-id=v1]") === null, "the first version is no longer shown");
  assert.match(page.text(), /Second/);
  assert.ok(page.document.querySelector("[data-result-id=v2] tbody input[type=checkbox]:checked") === null, "the new version starts with nothing selected");
});

test("a Turn without published results reads nothing", async (t) => {
  const page = mount(() => assert.fail("no request"));
  t.after(page.close);
  page.window.renderTurn(turn("completed", undefined), agent());
  await tick(50);
  assert.ok(page.document.querySelector(".turn-results") === null, ".turn-results is absent");
  assert.equal(page.requests.length, 0);
});
