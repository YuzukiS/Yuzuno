import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// YN-48: a running OpenCode Turn is never a silent "Working". It names the
// model its message went to, says what OpenCode retries and why, and once it
// has shown nothing for 30 s says no reply came yet, with Stop and Change
// model. Bundled in memory, without the running UI's dist.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "opencode-waiting-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
import {OpenCodeRevertHost} from ${JSON.stringify(path.join(root, "src/Rewind.tsx"))};
const root=createRoot(document.getElementById('root'));
// A turn as the app shows it: an OpenCode one inside its Agent's revert host.
window.renderTurn=(props)=>root.render(props.agent.harness==='opencode'
  ? <OpenCodeRevertHost workspaceId="ws-1" agent={props.agent} onDraft={()=>true}><Turn {...props}/></OpenCodeRevertHost>
  : <Turn {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "OpenCodeWaitingUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

function mount() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" });
  window.eval(bundle);
  return { window, document: window.document, errors, close: () => window.close() };
}
async function until(ready, what) {
  for (let tries = 0; tries < 300; tries++) {
    const value = ready();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const button = (page, text) => [...page.document.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
const agent = { id: "a", name: "OC Lab", status: "working", color: "sage", harness: "opencode", connectionState: "connected" };
const hello = { id: "msg_t1:input", type: "userMessage", content: [{ type: "text", text: "hello" }] };
const flint = { id: "opencode/flint-40b-free", name: "OpenCode · Flint 40B Free", default: true };
const turn = (startedAgo, extra = {}) => ({ id: "msg_t1", status: "inProgress", _yuzunoStartedAt: Date.now() - startedAgo, items: [hello], ...extra });
const show = (page, props) => page.window.renderTurn({ index: 0, agent, onFile() {}, time: undefined, ...props });

test("a waiting OpenCode turn names its model, and after 30 s with nothing shown offers Stop and Change model", async () => {
  const page = mount();
  const stops = [], models = [];
  try {
    show(page, { turn: turn(45_000, { _opencodeModel: flint }), onStop: () => stops.push(1), onChangeModel: () => models.push(1) });
    const model = await until(() => page.document.querySelector(".turn-activity .activity-model"), "the model beside Working");
    assert.match(model.textContent, /OpenCode · Flint 40B Free/);
    assert.equal(model.title, "OpenCode’s default model", "said to be OpenCode's own default");
    const quiet = await until(() => page.document.querySelector(".opencode-quiet"), "the no-reply note");
    assert.match(quiet.textContent, /No reply from OpenCode · Flint 40B Free yet\./);
    assert.match(quiet.textContent, /Stop this turn, or choose another model/);
    button(page, "Stop").click();
    button(page, "Change model").click();
    assert.deepEqual([stops.length, models.length], [1, 1]);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("no no-reply note before 30 s, once the turn shows something, or when it is not OpenCode's or not running", async () => {
  const page = mount();
  try {
    show(page, { turn: turn(5_000, { _opencodeModel: flint }), onStop() {}, onChangeModel() {} });
    await until(() => page.document.querySelector(".turn-activity"), "the running turn");
    await tick();
    assert.equal(page.document.querySelector(".opencode-quiet"), null, "not before 30 s");
    const replying = turn(45_000, { _opencodeModel: flint, items: [hello, { id: "msg_a1:0", type: "agentMessage", text: "Hel" }] });
    show(page, { turn: replying, onStop() {}, onChangeModel() {} });
    await tick();
    assert.equal(page.document.querySelector(".opencode-quiet"), null, "not once it shows output");
    show(page, { turn: turn(45_000), agent: { ...agent, harness: "claude" }, onStop() {}, onChangeModel() {} });
    await tick();
    assert.equal(page.document.querySelector(".opencode-waiting"), null, "not for another harness");
    show(page, { turn: { ...turn(45_000, { _opencodeModel: flint }), status: "completed" }, agent: { ...agent, status: "idle" } });
    await tick();
    assert.equal(page.document.querySelector(".opencode-waiting"), null, "not once it ended");
    assert.equal(page.document.querySelector(".activity-model"), null);
  } finally { page.close(); }
});

test("a retry says its attempt, why the last one failed, and when OpenCode tries next", async () => {
  const page = mount();
  try {
    const retry = { attempt: 3, next: Date.now() + 8_000, message: "ECONNREFUSED: Unable to connect. Is the computer able to access the url?" };
    show(page, { turn: turn(5_000, { _opencodeModel: { id: "stub/fake", name: "Stub · Fake" }, _opencodeRetry: retry }), onStop() {}, onChangeModel() {} });
    const shown = await until(() => page.document.querySelector(".opencode-retry"), "the retry");
    assert.match(shown.textContent, /OpenCode is retrying its provider \(attempt 3\)/);
    assert.match(shown.textContent, /next try in [78]s/);
    assert.match(shown.querySelector(".opencode-retry-error").textContent, /^ECONNREFUSED: Unable to connect\./);
    assert.equal(page.document.querySelector(".opencode-quiet"), null, "the retry says what it waits on; no no-reply note before 30 s");
  } finally { page.close(); }
});
