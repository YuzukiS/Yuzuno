// T-190: the create dialog starts from the Workspace's defaults for new
// Agents, says where each came from, and sends a permission only when this
// Agent chooses one; a default the chosen model can't run is not sent.
// Fixture HTTP only; no Core.
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
const fixture = await mkdtemp(path.join(cache, "create-agent-defaults-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteCreateAgent} from ${JSON.stringify(path.join(root, "src/RemoteCreateAgent.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderCreate=(props)=>root.render(<RemoteCreateAgent {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "CreateAgentDefaultsUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function until(check, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const local = { id: "local", name: "Core host", kind: "local", defaultCwd: "/workspace" };
const view = (saved) => ({
  saved,
  builtIn: { harness: "codex", codexPermissionPreset: null, claudePermissionMode: "default" },
  effective: {
    harness: { value: saved.harness ?? "codex", source: saved.harness ? "workspace" : "builtin" },
    codexPermissionPreset: { value: saved.codexPermissionPreset ?? null, source: saved.codexPermissionPreset ? "workspace" : "builtin" },
    claudePermissionMode: { value: saved.claudePermissionMode ?? "default", source: saved.claudePermissionMode ? "workspace" : "builtin" },
  },
});
const claudeModels = [
  { id: "sonnet", model: "sonnet", displayName: "Sonnet", supportsAutoMode: true },
  { id: "haiku", model: "haiku", displayName: "Haiku", supportsAutoMode: false },
];

function mount(defaults) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.fetch = async (url, init = {}) => {
    const body = init.body && JSON.parse(init.body);
    calls.push({ url, method: init.method || "GET", body });
    const answer = (status, value) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) });
    if (url.endsWith("/agent-defaults")) return defaults === null ? answer(404, { error: "Not found" }) : answer(200, defaults);
    if (url.endsWith("/machines")) return answer(200, { machines: [local] });
    if (url.endsWith("/models?harness=claude")) return answer(200, { models: claudeModels });
    if (url.endsWith("/models")) return answer(200, { models: [{ id: "gpt", model: "gpt", displayName: "GPT" }] });
    if (url.endsWith("/agents") && init.method === "POST") return answer(200, { id: "new", ...body });
    return answer(200, {});
  };
  window.eval(bundle);
  const page = { window, document: window.document, calls, errors, created: [] };
  page.open = async () => {
    window.renderCreate({ open: true, close() {}, defaultCwd: "/workspace", disabled: false, onCreated: (agent) => page.created.push(agent) });
    await tick();
    await tick();
  };
  return page;
}
const group = (page, label) => page.document.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
const picked = (page, label) => group(page, label)?.querySelector("input:checked")?.value;
async function pick(page, label, choice) {
  group(page, label).querySelector(`input[value="${choice}"]`).click();
  await tick();
}
async function type(page, label, text) {
  const node = [...page.document.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith(label))?.querySelector("input");
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(node, text);
  node.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await tick();
}
const createButton = (page) => [...page.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Create agent");
async function submit(page) {
  const before = page.calls.filter((c) => c.method === "POST").length;
  page.document.querySelector("form").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => page.calls.filter((c) => c.method === "POST").length > before, "the create request");
  return page.calls.filter((c) => c.method === "POST").at(-1).body;
}

test("the dialog starts on the Workspace's default harness, says where it came from, and sends a permission only when this Agent chooses one", async () => {
  const page = mount(view({ harness: "claude", claudePermissionMode: "auto" }));
  await page.open();
  await until(() => picked(page, "Harness") === "claude", "the Workspace's default harness");
  const permissions = group(page, "Permissions");
  assert.ok(permissions, "a permission choice for the Agent");
  assert.match(permissions.textContent, /Default · Auto mode/);
  assert.match(page.document.body.textContent, /Set for this Workspace/);
  assert.equal(picked(page, "Permissions"), "", "the default is used unless this Agent chooses");
  await type(page, "Name", "Mikan");
  const first = await submit(page);
  assert.equal(first.harness, "claude");
  assert.equal("permissionMode" in first, false, "a default is Core's to apply, not sent as this Agent's choice");
  await page.open();
  await type(page, "Name", "Mori");
  await pick(page, "Permissions", "default");
  const second = await submit(page);
  assert.equal(second.permissionMode, "default");
  assert.deepEqual(page.errors, []);
});

test("a default the chosen model can't run is not sent: Create waits for this Agent's own choice", async () => {
  const page = mount(view({ harness: "claude", claudePermissionMode: "auto" }));
  await page.open();
  await until(() => group(page, "Model")?.querySelector('input[value="haiku"]'), "the Claude models");
  await pick(page, "Model", "haiku");
  await type(page, "Name", "Kaki");
  assert.match(page.document.body.textContent, /Auto mode isn’t available for this model/);
  assert.equal(createButton(page).disabled, true);
  await pick(page, "Permissions", "default");
  assert.equal(createButton(page).disabled, false);
  const body = await submit(page);
  assert.equal(body.permissionMode, "default");
});

test("Codex offers Follow Codex config beside Yuzuno's choices; a choice is the harness's own and resets when the harness changes", async () => {
  const page = mount(view({ codexPermissionPreset: "config" }));
  await page.open();
  await until(() => group(page, "Permissions"), "the permission choice");
  assert.equal(picked(page, "Harness"), "codex");
  assert.match(group(page, "Permissions").textContent, /Default · Follow Codex config/);
  assert.match(page.document.body.textContent, /Built in/, "the harness came from the built-in behaviour");
  await pick(page, "Permissions", "full");
  await pick(page, "Harness", "claude");
  assert.equal(picked(page, "Permissions"), "", "Codex's choice does not carry over to Claude Code");
  await pick(page, "Harness", "codex");
  await pick(page, "Permissions", "full");
  await type(page, "Name", "Yuzu");
  const body = await submit(page);
  assert.deepEqual([body.harness, body.permissionPreset, "permissionMode" in body], ["codex", "full", false]);
});

test("a harness picked in a cancelled dialog does not stick: the next opening starts on the default again", async () => {
  const page = mount(view({ harness: "claude" }));
  await page.open();
  await until(() => picked(page, "Harness") === "claude", "the Workspace's default harness");
  await pick(page, "Harness", "codex");
  await pick(page, "Permissions", "full");
  page.window.renderCreate({ open: false, close() {}, defaultCwd: "/workspace", disabled: false, onCreated() {} });
  await tick();
  await page.open();
  await until(() => picked(page, "Harness") === "claude", "the default harness after cancelling");
  assert.equal(picked(page, "Permissions"), "", "the cancelled permission choice does not stick either");
});

test("a Core that doesn't report defaults: the dialog works as before and says the default isn't known", async () => {
  const page = mount(null);
  await page.open();
  await until(() => group(page, "Harness"), "the dialog");
  assert.equal(picked(page, "Harness"), "codex");
  await until(() => group(page, "Permissions"), "the permission choice");
  assert.match(group(page, "Permissions").textContent, /Default · Not reported by this Core/);
  await type(page, "Name", "Ume");
  const body = await submit(page);
  assert.deepEqual([body.harness, "permissionPreset" in body], ["codex", false]);
});
