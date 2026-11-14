// Renaming an Agent (YN-112): its menu offers Rename… for any Agent where
// the page can rename it; the page checks a name by Core's rule (trimmed,
// not empty, no control characters, at most 100 bytes) and says why in
// place; the dialog sends one PATCH of the trimmed name and nothing on
// Cancel or a refused name, and keeps Core's refusal on screen; the field in
// Agent settings saves the name alone, on Enter too, never the settings form
// around it, and leaves an input method's Return alone. Fixture HTTP only;
// no Core.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "agent-rename-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {agentMenuItems} from ${src("agent-actions.ts")};
import {AgentNameSetting, RenameAgentDialog, agentNameProblem} from ${src("RenameAgent.tsx")};
const root = createRoot(document.getElementById('root'));
window.agentMenuItems = agentMenuItems;
window.agentNameProblem = agentNameProblem;
window.renamed = [];
window.closed = 0;
window.submitted = 0;
window.renderDialog = agent => root.render(<RenameAgentDialog agent={agent} open
  onOpenChange={open => { if (!open) window.closed++; }} onRenamed={name => window.renamed.push(name)}/>);
window.renderSetting = agent => root.render(<form onSubmit={event => { event.preventDefault(); window.submitted++; }}>
  <AgentNameSetting agent={agent} onRenamed={name => window.renamed.push(name)}/><button type="submit">Save settings</button></form>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "AgentRenameUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const agent = (id, rest = {}) => ({
  id, name: `Agent ${id}`, cwd: "/work", model: "m", color: "sage", harness: "codex",
  threadId: `thread-${id}`, status: "idle", connectionState: "connected",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, ...rest,
});
// 33 Chinese characters and a letter: exactly the 100 bytes Core takes.
const FULL = `${"汉".repeat(33)}a`;

function mount(respond = (_url, body) => ({ body: { ...agent("a"), name: body.name } })) {
  const calls = [];
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  window.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ call: `${init.method ?? "GET"} ${url}`, body });
    const { status = 200, body: answer = {} } = await respond(url, body);
    const text = JSON.stringify(answer);
    return { ok: status < 400, status, json: async () => answer, text: async () => text };
  };
  window.eval(bundle);
  const document = window.document;
  const button = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  return {
    window, document, button,
    calls: () => calls.map(({ call, body }) => `${call} ${JSON.stringify(body)}`),
    dialog: () => document.querySelector('[role="dialog"]'),
    input: () => document.querySelector('[role="dialog"] input, .agent-name-setting input'),
    type: (input, value) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    key: (target, init) => target.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })),
    said: () => [...document.querySelectorAll('[role="status"], [role="alert"]')].map((node) => node.textContent.trim()),
    close: () => window.close(),
  };
}
// Copied out of the page's realm: deepEqual compares prototypes.
const actions = (items) => [...items].map((item) => item.action);

test("Rename… is offered for any Agent, closed too, before its settings, only where the page can rename", () => {
  const page = mount();
  const menu = (rest, options = { rename: true }) => actions(page.window.agentMenuItems(agent("a", rest), options));
  assert.deepEqual(menu({}), ["rename", "settings", "manage"]);
  assert.deepEqual(menu({ status: "working" }), ["interrupt", "rename", "settings", "manage"]);
  assert.deepEqual(menu({ closedAt: "now", status: "offline", connectionState: "disconnected" }), ["rename", "manage"]);
  assert.deepEqual(menu({}, { rename: true, disconnect: true, link: true }), ["disconnect", "rename", "settings", "copyLink", "manage"]);
  assert.deepEqual(menu({}, {}), ["settings", "manage"], "not where nothing renames");
  const entry = [...page.window.agentMenuItems(agent("a"), { rename: true })].find((item) => item.action === "rename");
  assert.equal(entry.label, "Rename…");
  page.close();
});

test("a name is checked by Core's rule: trimmed, not empty, no control characters, at most 100 bytes", () => {
  const page = mount();
  const problem = page.window.agentNameProblem;
  assert.equal(new TextEncoder().encode(FULL).length, 100);
  for (const good of ["Mori", "  Mori · 前端  ", FULL, `  ${FULL}  `, "a  b"]) assert.equal(problem(good), null, good);
  for (const [value, why] of [["", "empty"], ["   ", "empty"], ["a\tb", "control"], ["a\u001bb", "control"], ["a\u0085b", "control"], [`${FULL}b`, "long"]]) {
    assert.equal(problem(value), why, JSON.stringify(value));
  }
  page.close();
});

test("the dialog renames with one PATCH of the trimmed name; Cancel and a refused name send nothing", async () => {
  const page = mount();
  page.window.renderDialog(agent("a"));
  await tick();
  assert.match(page.dialog().textContent, /Rename agent/);
  assert.match(page.dialog().textContent, /its agent ID, tasks, mail and Home stay as they are/);
  const input = page.input();
  assert.equal(input.value, "Agent a");
  assert.equal(page.document.activeElement, input, "the name has the focus");
  assert.ok(page.button("Save").disabled, "an unchanged name has nothing to save");

  for (const [value, says] of [
    ["   ", "A name can’t be empty."],
    ["Mori\tfront", "A name can’t contain control characters, such as a tab."],
    [`${FULL}b`, /1 byte too long: this field takes at most 100 bytes/],
  ]) {
    page.type(input, value);
    await tick();
    assert.ok(page.button("Save").disabled, JSON.stringify(value));
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.ok(page.said().some((text) => (typeof says === "string" ? text === says : says.test(text))), `${JSON.stringify(value)}: ${page.said()}`);
    // Enter submits nothing either.
    page.dialog().querySelector("form").requestSubmit();
    await tick();
  }
  assert.deepEqual(page.calls(), [], "a refused name is never sent");

  page.type(input, "  Mori · 前端  ");
  await tick();
  assert.deepEqual(page.said(), []);
  page.dialog().querySelector("form").requestSubmit();
  await tick();
  await tick();
  assert.deepEqual(page.calls(), ['PATCH /api/agents/a {"name":"Mori · 前端"}']);
  assert.deepEqual([...page.window.renamed], ["Mori · 前端"]);
  assert.equal(page.window.closed, 1, "it closes once renamed");
  page.close();

  const cancelled = mount();
  cancelled.window.renderDialog(agent("a"));
  await tick();
  cancelled.type(cancelled.input(), "Other");
  await tick();
  cancelled.button("Cancel").click();
  await tick();
  assert.deepEqual(cancelled.calls(), [], "Cancel sends nothing");
  assert.equal(cancelled.window.closed, 1);
  cancelled.close();
});

test("Core's refusal stays in the dialog, which stays open", async () => {
  const page = mount(() => ({ status: 400, body: { error: "请填写名称（最多 100 字节，不含控制字符）" } }));
  page.window.renderDialog(agent("a"));
  await tick();
  page.type(page.input(), "Mori");
  await tick();
  page.button("Save").click();
  await tick();
  await tick();
  assert.equal(page.document.querySelector('[role="alert"]')?.textContent, "请填写名称（最多 100 字节，不含控制字符）");
  assert.equal(page.window.closed, 0);
  assert.deepEqual([...page.window.renamed], []);
  page.close();
});

test("the settings field saves the name alone, on Enter too, never the settings form; an input method's Return is its own", async () => {
  const page = mount();
  page.window.renderSetting(agent("a"));
  await tick();
  const input = page.input();
  assert.equal(input.value, "Agent a");
  assert.ok(page.button("Save name").disabled);
  page.type(input, "Mori");
  await tick();
  input.dispatchEvent(new page.window.CompositionEvent("compositionstart", { bubbles: true }));
  page.key(input, { key: "Enter", isComposing: true });
  page.key(input, { key: "Enter", keyCode: 229 });
  await tick();
  assert.deepEqual(page.calls(), [], "the input method's Return sends nothing");
  input.dispatchEvent(new page.window.CompositionEvent("compositionend", { bubbles: true }));
  page.key(input, { key: "Enter" });
  await tick();
  await tick();
  assert.deepEqual(page.calls(), ['PATCH /api/agents/a {"name":"Mori"}']);
  assert.deepEqual([...page.window.renamed], ["Mori"]);
  assert.equal(page.window.submitted, 0, "the settings around it were not submitted");

  // A refused name: the reason in place, nothing sent.
  page.type(input, "");
  await tick();
  assert.ok(page.button("Save name").disabled);
  assert.ok(page.said().includes("A name can’t be empty."));
  page.key(input, { key: "Enter" });
  await tick();
  assert.equal(page.calls().length, 1);
  page.close();
});
