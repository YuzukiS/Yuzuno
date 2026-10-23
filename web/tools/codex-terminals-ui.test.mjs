import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-29 /ps and /stop: a Codex Agent's background terminals. The dialog is
// rendered alone against a fake Core: the list answers at once, a stop waits
// until the test answers it.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "codex-terminals-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {CodexTerminalsDialog} from ${JSON.stringify(path.join(root, "src/CodexTerminals.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderTerminals=(props)=>root.render(props ? <CodexTerminalsDialog {...props}/> : null);`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, cssCodeSplit: false, lib: { entry, name: "CodexTerminals", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output).find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const agent = { id: "agent-1", name: "Dev", status: "idle", color: "sage", harness: "codex", cwd: "/work/app", lastSeq: 1,
  connectionState: "connected", remote: { machine: { id: "m1", name: "build-box" } } };
const terminal = (processId, itemId, command, extra = {}) => ({ processId, itemId, command, cwd: "/work/app", inRunningTurn: false, ...extra });
const listed = (terminals, extra = {}) => ({ state: "listed", reason: "listed", detail: null, generation: 4, threadId: "thread-a", terminals, complete: true, ...extra });
const outcome = (processId, itemId, outcome, sent, detail = null) => ({ processId, itemId, outcome, sent, detail });

function mount(listing) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  const calls = [];
  const events = [];
  const stops = [];
  let list = listing;
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if ((init.method || "GET") === "GET") return Promise.resolve(reply(list));
    return new Promise((resolve) => stops.push(resolve));
  };
  window.eval(bundle);
  return {
    window, document: window.document, calls, events, errors,
    text: () => window.document.querySelector('[role="dialog"]')?.textContent ?? "",
    setList: (next) => { list = next; },
    answer: async (body) => { stops.at(-1)(reply(body)); await tick(); },
    fail: async (status, error) => { stops.at(-1)(reply({ error }, status)); await tick(); },
    /** Renders it and, when shown, waits until its list has been read and drawn. */
    render: async (extra) => {
      window.renderTerminals(extra === null ? null : { agent, mode: "stop", open: true, onOpenChange: (open) => events.push(["open", open]), ...extra });
      await tick();
      const text = () => window.document.querySelector('[role="dialog"]')?.textContent ?? "";
      if (extra !== null) await until(() => text() && !/Listing background terminals…/.test(text()), "the list drawn");
    },
    button: (name) => [...window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === name),
    buttons: () => [...window.document.querySelectorAll("button")].map((b) => b.textContent.trim()),
    close: () => window.close(),
  };
}
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, message) {
  for (let n = 0; n < 200; n++) {
    if (read()) return;
    await tick(10);
  }
  assert.fail(message);
}
const posts = (page) => page.calls.filter((c) => c.method === "POST");

test("/ps lists once when it opens, on the Agent's machine and conversation, and has nothing that stops", async () => {
  const page = mount(listed([terminal("1001", "call-a", "npm run dev"), terminal("1002", "call-b", "tail -f app.log", { inRunningTurn: true })]));
  try {
    await page.render({ mode: "list" });
    assert.deepEqual(page.calls.map((c) => `${c.method} ${c.url}`), ["GET /api/agents/agent-1/codex/terminals"]);
    assert.match(page.text(), /Background terminals/);
    assert.match(page.text(), /On build-box, in this Agent's Codex conversation \(folder \/work\/app\), on its current connection/);
    assert.match(page.text(), /Running now · 2 terminals/);
    assert.match(page.text(), /npm run dev[\s\S]*process 1001/);
    assert.match(page.text(), /Started by a command of the running turn/);
    assert.ok(!page.buttons().some((b) => b.startsWith("Stop")), "nothing here stops a terminal");
    assert.match(page.text(), /Nothing here stops a terminal; \/stop does/);
    for (const internal of [/backgroundTerminals/, /terminate/, /threadId/, /generation/, /itemId/]) {
      assert.doesNotMatch(page.text(), internal, "the terminals and where they run, never how they are read");
    }
    page.button("Close").click();
    await tick();
    assert.deepEqual(page.events, [["open", false]]);
    assert.equal(page.calls.length, 1, "closing sends nothing");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("/stop sends exactly the terminal on the pressed button, once, and shows what Codex answered with a fresh list", async () => {
  const page = mount(listed([terminal("1001", "call-a", "npm run dev"), terminal("1002", "call-b", "watch")]));
  try {
    await page.render();
    assert.match(page.text(), /Stop acts only on the terminals named on its button, as listed here; one started later is not stopped\. The Agent's turn is\s+not interrupted\./);
    assert.deepEqual(page.buttons().filter((b) => b.startsWith("Stop")), ["Stop process 1001", "Stop process 1002", "Stop these 2 listed terminals"]);
    page.button("Stop process 1001").click();
    page.button("Stop process 1001").click();
    await tick();
    assert.deepEqual(posts(page).map((c) => [c.url, c.body]), [["/api/agents/agent-1/codex/terminals/stop",
      { generation: 4, threadId: "thread-a", targets: [{ processId: "1001", itemId: "call-a" }] }]], "one press, one stop, of that pair only");
    assert.match(page.text(), /Stopping process 1001…/);
    assert.ok(page.button("Stop process 1002").disabled && page.button("Refresh").disabled, "nothing else while it runs");
    await page.answer({ state: "done", reason: "done", generation: 4, outcomes: [outcome("1001", "call-a", "stopped", true)],
      after: listed([terminal("1002", "call-b", "watch"), terminal("1003", "call-c", "new one")]) });
    assert.match(page.text(), /process 1001: Stopped\./);
    assert.match(page.text(), /Running now \(a fresh check\) · 2 terminals/);
    assert.match(page.text(), /new one/, "the list is Codex's now");
    assert.equal(posts(page).length, 1, "nothing sent again");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("\"Stop these N listed\" names every listed terminal and no other; each answer reads as it is", async () => {
  const page = mount(listed([terminal("1001", "call-a", "a"), terminal("1002", "call-b", "b"), terminal("1003", "call-c", "c")]));
  try {
    await page.render();
    page.button("Stop these 3 listed terminals").click();
    await tick();
    assert.deepEqual(posts(page)[0].body.targets, [{ processId: "1001", itemId: "call-a" }, { processId: "1002", itemId: "call-b" }, { processId: "1003", itemId: "call-c" }]);
    assert.match(page.text(), /Stopping the 3 listed…/);
    await page.answer({ state: "done", reason: "done", generation: 4, after: listed([]), outcomes: [
      outcome("1001", "call-a", "gone", false), outcome("1002", "call-b", "replaced", false), outcome("1003", "call-c", "refused", true, "cannot stop it here")] });
    assert.match(page.text(), /process 1001: It had already ended; nothing was sent\./);
    assert.match(page.text(), /process 1002: Its number now names another terminal, so nothing was sent\./);
    assert.match(page.text(), /process 1003: Codex refused: cannot stop it here/);
    assert.match(page.text(), /No background terminals are running in this conversation\./);
    await page.render(null);
    page.setList(listed([terminal("1004", "call-d", "d"), terminal("1005", "call-e", "e")]));
    await page.render();
    page.button("Stop process 1004").click();
    await tick();
    await page.answer({ state: "done", reason: "done", generation: 4, after: null, outcomes: [
      outcome("1004", "call-d", "unknown", true, "connection closed"), outcome("1005", "call-e", "not_sent", false, "unknown")] });
    assert.match(page.text(), /process 1004: No answer came, so whether it stopped isn't known\. It isn't sent again/);
    assert.match(page.text(), /process 1005: Not sent: an earlier stop got no answer\./);
    assert.match(page.text(), /The connection changed, so no fresh list was read\./);
    for (const [o, said] of [[outcome("1", "x", "not_stopped", true), /Codex didn't stop it; it is still running\./],
        [outcome("1", "x", "gone", true), /It ended before Codex stopped it\./],
        [outcome("1", "x", "unsupported", true), /can't stop background terminals/],
        [outcome("1", "x", "not_sent", false, "connection"), /Not sent: the connection changed\./]]) {
      await page.render(null);
      page.setList(listed([terminal("1", "x", "one")]));
      await page.render();
      page.button("Stop process 1").click();
      await tick();
      await page.answer({ state: "done", reason: "done", generation: 4, after: null, outcomes: [o] });
      assert.match(page.text(), said, o.outcome);
    }
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("nothing is stopped for a target that changed, a stop already running, or with no connection; a failed list says so", async () => {
  const page = mount(listed([terminal("1001", "call-a", "a")]));
  try {
    await page.render();
    page.button("Stop process 1001").click();
    await tick();
    await page.answer({ state: "unavailable", reason: "target_changed", generation: 5, outcomes: [], after: null });
    assert.match(page.text(), /connection or conversation changed since the list was read, so nothing was stopped\. Refresh to list it again\./);
    page.button("Stop process 1001").click();
    await tick();
    await page.answer({ state: "busy", reason: "busy", generation: null, outcomes: [], after: null });
    assert.match(page.text(), /A stop is already running for this Agent\./);
    page.button("Stop process 1001").click();
    await tick();
    await page.fail(400, "无效的后台终端编号");
    assert.match(page.text(), /Couldn't send the stop: 无效的后台终端编号\. Whether anything stopped isn't known; Refresh to list again\./);
    for (const [list, said] of [
      [{ state: "unavailable", reason: "not_connected", detail: null, generation: null, threadId: null, terminals: [], complete: false }, /isn't connected to Codex\. Nothing is listed or stopped here, and nothing connects by itself\./],
      [{ state: "unavailable", reason: "old_protocol", detail: null, generation: 4, threadId: null, terminals: [], complete: false }, /can't list its background terminals/],
      [{ state: "unavailable", reason: "no_thread", detail: null, generation: null, threadId: null, terminals: [], complete: false }, /no Codex conversation yet/],
      [{ state: "failed", reason: "refused", detail: "thread not loaded", generation: 4, threadId: null, terminals: [], complete: false }, /Couldn't list them: Codex refused \(thread not loaded\)\./],
      [listed([terminal("1001", "call-a", "a")], { complete: false }), /more background terminals than this list shows/],
      // One stop names at most 100 terminals, as Core accepts: above that, no bulk button that could only fail.
      [listed(Array.from({ length: 101 }, (_, n) => terminal(String(2000 + n), `call-${n}`, `job ${n}`))),
        /Stopping every listed terminal at once is offered for up to 100; stop these one at a time\./],
    ]) {
      await page.render(null);
      page.setList(list);
      await page.render();
      assert.match(page.text(), said);
      if (list.state !== "listed") assert.ok(!page.buttons().some((b) => b.startsWith("Stop")), "nothing to stop without a list");
      if (list.terminals.length > 100) {
        assert.ok(!page.buttons().some((b) => b.startsWith("Stop these")), "no stop of more than one request can name");
        assert.ok(page.button("Stop process 2100"), "each one can still be stopped");
      }
    }
    const before = page.calls.length;
    page.button("Refresh").click();
    await tick();
    assert.deepEqual(page.calls.slice(before).map((c) => c.method), ["GET"], "Refresh lists again and stops nothing");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("closing during a stop sends nothing more, and its late answer is dropped", async () => {
  const page = mount(listed([terminal("1001", "call-a", "a")]));
  try {
    await page.render();
    page.button("Stop process 1001").click();
    await tick();
    page.button("Close").click();
    await page.render(null);
    await page.answer({ state: "done", reason: "done", generation: 4, outcomes: [outcome("1001", "call-a", "stopped", true)], after: listed([]) });
    assert.deepEqual(page.calls.map((c) => c.method), ["GET", "POST"], "no retry, no cancel of a stop already sent");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});
