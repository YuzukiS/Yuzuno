import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// OpenCode Agents (T-110): offered only when Core says it creates them, and
// answered in OpenCode's own terms. Bundled in memory, without the running UI's dist.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "opencode-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteCreateAgent} from ${JSON.stringify(path.join(root, "src/RemoteCreateAgent.tsx"))};
import {PendingCard, Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderCreate=(props)=>root.render(<RemoteCreateAgent {...props}/>);
window.renderPending=(props)=>root.render(<PendingCard onViewChanges={()=>{}} {...props}/>);
window.renderTurn=(props)=>root.render(<Turn {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "OpenCodeUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const local = { id: "local", name: "Core host", kind: "local", defaultCwd: "/workspace" };
const remote = { id: "mini", name: "Mac mini", kind: "ssh", target: "mac-mini", defaultCwd: "/Users/test/projects" };

function mount(handler) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body && JSON.parse(init.body) });
    const body = (await handler?.(url, init)) ?? (url.endsWith("/machines")
      ? { machines: [local, remote] }
      : /\/models(\?|$)/.test(url) ? { models: [{ id: "m", model: "m", displayName: "Codex model" }] } : {});
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  return { window, document: window.document, calls, errors, close: () => window.close() };
}
const button = (page, text) => [...page.document.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
const group = (page, label) => page.document.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
const choice = (page, label, value) => group(page, label)?.querySelector(`input[value="${value}"]`);
async function value(page, node, text) {
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(node, text);
  node.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await tick();
}
async function create(page, opencode) {
  page.window.renderCreate({ open: true, close() {}, defaultCwd: "/workspace", disabled: false, onCreated() {}, opencode });
  await tick(); await tick();
}

test("OpenCode is offered only when Core creates it, on the Core host, with OpenCode's own model", async () => {
  const off = mount();
  try {
    await create(off, false);
    assert.ok(choice(off, "Harness", "claude"));
    assert.equal(choice(off, "Harness", "opencode"), null, "a Core without the switch offers no OpenCode");
  } finally { off.close(); }

  // Codex's list never answers: choosing OpenCode leaves no wait for it.
  const page = mount((url, init) => url.endsWith("/agents") ? { id: "new", ...JSON.parse(init.body) }
    : /\/models(\?|$)/.test(url) ? new Promise(() => {}) : undefined);
  try {
    await create(page, true);
    assert.match(page.document.body.textContent, /Loading Codex models/);
    choice(page, "Where to work", "mini").click(); await tick();
    choice(page, "Harness", "opencode").click(); await tick();
    assert.equal(group(page, "Where to work").querySelector("input:checked").value, "local", "an SSH machine is left");
    assert.equal(choice(page, "Where to work", "mini").disabled, true);
    assert.equal(group(page, "Model"), null, "no model choice");
    assert.doesNotMatch(page.document.body.textContent, /Loading|Couldn’t load models/);
    assert.match(page.document.body.textContent, /OpenCode’s own default model, login and permission rules/);
    assert.match(page.document.body.textContent, /OpenCode may download or update its own\s+dependencies when it starts/);
    assert.equal(page.calls.some((call) => /harness=opencode/.test(call.url)), false, "no model list is asked for");
    await value(page, [...page.document.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith("Name")).querySelector("input"), "Ocean");
    page.document.querySelector("form").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    const sent = page.calls.find((call) => call.url.endsWith("/agents")).body;
    assert.deepEqual(sent, { name: "Ocean", cwd: "/workspace", machineId: "local", harness: "opencode" });
    // The switch turned off while the dialog is open: back to Codex.
    await create(page, false);
    assert.equal(group(page, "Harness").querySelector("input:checked").value, "codex");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

const permission = { id: "req-1", agentId: "oc", method: "opencode/permission", createdAt: "now",
  params: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls -la"], metadata: {}, always: ["ls *"],
    _runtimeGeneration: 1, _opencodeSession: "ses_1", _responseSent: false } };

test("a permission is allowed once or rejected, and nothing lasting is offered", async () => {
  for (const [label, decision] of [["Allow once", "once"], ["Reject", "reject"]]) {
    const page = mount();
    try {
      page.window.renderPending({ request: permission, refresh() {}, disabled: false }); await tick();
      assert.match(page.document.body.textContent, /OpenCode asks to use bash for:\s*ls -la/);
      assert.deepEqual([...page.document.querySelectorAll("button")].map((b) => b.textContent.trim()), ["Allow once", "Reject"]);
      button(page, label).click(); button(page, label).click(); await tick();
      assert.equal(page.calls.length, 1, "two clicks answer once");
      assert.match(page.calls[0].url, /requests\/req-1\/respond$/);
      assert.deepEqual(page.calls[0].body, { response: { decision } });
    } finally { page.close(); }
  }
  const stale = mount();
  try {
    stale.window.renderPending({ request: { ...permission, stale: true }, refresh() {}, disabled: false }); await tick();
    assert.equal(button(stale, "Allow once").disabled, true);
    assert.match(stale.document.body.textContent, /closed connection/);
  } finally { stale.close(); }
});

test("questions are answered with one list of labels per question, in order", async () => {
  const request = { id: "req-2", agentId: "oc", method: "opencode/question", createdAt: "now",
    params: { id: "que_1", sessionID: "ses_1", _runtimeGeneration: 1, _opencodeSession: "ses_1", questions: [
      { question: "Which fruit?", header: "Fruit", options: [{ label: "Yuzu", description: "citrus" }, { label: "Peach", description: "" }] },
      { question: "Which colours?", header: "Colours", multiple: true, custom: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] },
    ] } };
  const page = mount();
  try {
    page.window.renderPending({ request, refresh() {}, disabled: false }); await tick();
    assert.equal(button(page, "Send answer").disabled, true);
    assert.equal(page.document.querySelectorAll('input[aria-label^="Your answer"]').length, 1, "custom text only where OpenCode allows it");
    await value(page, page.document.querySelector('input[aria-label="Your answer: Which fruit?"]'), "  Kumquat  ");
    for (const box of page.document.querySelectorAll("input[type=checkbox]")) box.click();
    await tick();
    button(page, "Send answer").click(); await tick();
    assert.deepEqual(page.calls[0].body, { response: { answers: [["Kumquat"], ["Red", "Blue"]] } });
  } finally { page.close(); }
  const declined = mount();
  try {
    declined.window.renderPending({ request, refresh() {}, disabled: false }); await tick();
    button(declined, "Decline").click(); await tick();
    assert.deepEqual(declined.calls[0].body, { response: { decision: "reject" } });
  } finally { declined.close(); }
});

test("an OpenCode turn names OpenCode, shows its tool calls and offers no rewind", async () => {
  const turn = { id: "msg_1", status: "completed", items: [
    { id: "u1", type: "userMessage", content: [{ type: "text", text: "List the files" }] },
    { id: "prt_1", type: "opencodeTool", name: "bash", callId: "call_1", input: { command: "ls" }, output: "a.txt\nb.txt", status: "completed" },
    { id: "prt_2", type: "agentMessage", text: "Two files." },
  ] };
  const shown = (harness) => {
    const page = mount();
    page.window.renderTurn({ turn, index: 0, agent: { id: "a", name: "Ocean", status: "idle", color: "sage", harness }, onFile() {}, onRewindDraft() {} });
    return page;
  };
  const codex = shown("codex");
  const page = shown("opencode");
  try {
    await tick(); await tick();
    assert.ok(button(codex, "Rewind"), "the same turn of a Codex Agent offers a rewind");
    assert.equal(button(page, "Rewind"), undefined);
    const text = page.document.body.textContent;
    assert.match(text, /OpenCode/);
    assert.doesNotMatch(text, /Codex/);
    for (const tools of page.document.querySelectorAll("details")) tools.open = true;
    await tick();
    const tool = page.document.querySelector(".opencode-tool");
    assert.ok(tool, "rendered as an OpenCode tool");
    assert.match(tool.querySelector("summary").textContent, /bash · ls/);
    assert.match(tool.textContent, /a\.txt\s*b\.txt/);
    assert.deepEqual(page.errors, []);
  } finally { codex.close(); page.close(); }
});
