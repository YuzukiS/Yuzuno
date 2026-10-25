// T-190: Settings → New Agent defaults and Code review show where each value
// comes from; saving sends only what changed, "Built in" deletes the
// Workspace's choice (null / DELETE) instead of copying Yuzuno's. Fixture
// HTTP only; no Core.
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
const fixture = await mkdtemp(path.join(cache, "agent-defaults-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentDefaults} from ${src("AgentDefaults.tsx")};
import {ReviewSettings} from ${src("ReviewSettings.tsx")};
const root=createRoot(document.getElementById('root'));
window.renderDefaults=()=>root.render(<AgentDefaults active/>);
window.renderReview=()=>root.render(<ReviewSettings active/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "AgentDefaultsUI", formats: ["iife"] } },
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
// As Core answers (agent_defaults::view).
const view = (saved) => ({
  saved,
  builtIn: { harness: "codex", codexPermissionPreset: null, claudePermissionMode: "default" },
  effective: {
    harness: { value: saved.harness ?? "codex", source: saved.harness ? "workspace" : "builtin" },
    codexPermissionPreset: { value: saved.codexPermissionPreset ?? null, source: saved.codexPermissionPreset ? "workspace" : "builtin" },
    claudePermissionMode: { value: saved.claudePermissionMode ?? "default", source: saved.claudePermissionMode ? "workspace" : "builtin" },
  },
});

function mount(route) {
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
    const method = init.method || "GET";
    calls.push({ url, method, body });
    const [status, value] = route(url, method, body);
    return { ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) };
  };
  window.eval(bundle);
  return { window, document: window.document, calls, errors };
}
const select = (page, label) => page.document.querySelector(`select[aria-label="${label}"]`);
async function choose(page, label, value) {
  const node = select(page, label);
  Object.getOwnPropertyDescriptor(page.window.HTMLSelectElement.prototype, "value").set.call(node, value);
  node.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await tick();
}
const button = (page, text) => [...page.document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const posts = (page) => page.calls.filter((c) => c.method !== "GET");

test("New Agent defaults says what each value is and where it comes from; saving sends only what changed", async () => {
  let saved = {};
  const page = mount((url, method, body) => {
    if (method === "POST") {
      saved = Object.fromEntries(Object.entries({ ...saved, ...body }).filter(([, v]) => v !== null));
      return [200, view(saved)];
    }
    return [200, view(saved)];
  });
  page.window.renderDefaults();
  await until(() => select(page, "Harness for new Agents"), "the editor");
  const text = () => page.document.querySelector("#settings-agent-defaults")?.textContent ?? "";
  assert.match(text(), /Built in: Codex/);
  assert.match(text(), /Built in: Ask for approval/);
  assert.match(text(), /Built in: Ask before actions/);
  assert.match(text(), /no Workspace default for them yet/, "model and effort are said to be per Agent");
  assert.equal(button(page, "Save"), undefined, "nothing to save yet");
  await choose(page, "Harness for new Agents", "claude");
  await choose(page, "Codex permissions for new Agents", "config");
  button(page, "Save").click();
  await until(() => posts(page).length === 1 && /Set for this Workspace: Claude Code/.test(text()), "the saved choice");
  assert.deepEqual(posts(page)[0].body, { harness: "claude", codexPermissionPreset: "config" });
  assert.match(text(), /Set for this Workspace: Follow Codex config/);
  assert.match(text(), /existing Agents keep their settings/);
  // Built in again: the Workspace's choice is deleted, not overwritten.
  await choose(page, "Harness for new Agents", "");
  button(page, "Save").click();
  await until(() => posts(page).length === 2 && /Built in: Codex/.test(text()), "back to built in");
  assert.deepEqual(posts(page)[1].body, { harness: null });
  button(page, "Use built-in for all").click();
  await until(() => posts(page).length === 3, "everything built in");
  assert.deepEqual(posts(page)[2].body, { harness: null, codexPermissionPreset: null, claudePermissionMode: null });
  await until(() => !button(page, "Use built-in for all"), "nothing left to clear");
  assert.deepEqual(page.errors, []);
});

test("a save Core refuses keeps the choice and says why", async () => {
  const page = mount((url, method) => (method === "POST" ? [400, { error: "Unknown Codex permission mode: yolo" }] : [200, view({})]));
  page.window.renderDefaults();
  await until(() => select(page, "Claude Code permissions for new Agents"), "the editor");
  await choose(page, "Claude Code permissions for new Agents", "auto");
  button(page, "Save").click();
  await until(() => page.document.querySelector('[role="alert"]'), "the refusal");
  assert.equal(select(page, "Claude Code permissions for new Agents").value, "auto", "the choice is kept to save again");
  assert.ok(button(page, "Save"), "still unsaved");
});

test("Code review says whether this Workspace chose its reviewer; Use built-in deletes that choice", async () => {
  let source = "workspace";
  const page = mount((url, method) => {
    if (method === "DELETE") {
      source = "builtin";
      return [200, { harness: "codex", model: "gpt-6.1-sol", source, builtIn: { harness: "codex", model: "gpt-6.1-sol" } }];
    }
    if (url.includes("/models")) return [200, { models: [{ model: "claude-opus-5-5", displayName: "Opus" }] }];
    return [200, source === "workspace"
      ? { harness: "claude", model: "claude-opus-5-5", source, builtIn: { harness: "codex", model: "gpt-6.1-sol" } }
      : { harness: "codex", model: "gpt-6.1-sol", source, builtIn: { harness: "codex", model: "gpt-6.1-sol" } }];
  });
  page.window.renderReview();
  // Empty until the section has loaded, so waiting on it retries rather than throws.
  const text = () => page.document.querySelector("#settings-review")?.textContent ?? "";
  await until(() => /Set for this Workspace/.test(text()), "the reviewer's source");
  assert.match(text(), /Built in: Codex · GPT-6.1 Sol/, "what Use built-in returns to");
  button(page, "Use built-in").click();
  await until(() => posts(page).length === 1 && /Built in/.test(text()) && !button(page, "Use built-in"), "the built-in reviewer");
  assert.equal(posts(page)[0].method, "DELETE");
  assert.match(text(), /Running reviews keep/);
});

test("Code review from a Core that doesn't say where its reviewer comes from shows no source", async () => {
  const page = mount(() => [200, { harness: "codex", model: "gpt-6.1-sol" }]);
  page.window.renderReview();
  await until(() => page.document.querySelector("#settings-review .settings-current"), "the reviewer");
  assert.doesNotMatch(page.document.querySelector("#settings-review").textContent, /Set for this Workspace|Built in:/);
  assert.equal(button(page, "Use built-in"), undefined);
});
