// T-34 S1: Settings → Executor templates, and a project's own on its page.
// A save sends the whole list as this client writes it, against the version
// read; a conflict says so and offers a reload. Fixture HTTP only; no Core.
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
const fixture = await mkdtemp(path.join(cache, "executor-templates-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ExecutorTemplates} from ${src("ExecutorTemplates.tsx")};
const root=createRoot(document.getElementById('root'));
window.renderTemplates=()=>root.render(<ExecutorTemplates active/>);
window.renderProjectTemplates=(id,disabled=false)=>root.render(<ExecutorTemplates active projectId={id} disabled={disabled}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "ExecutorTemplatesUI", formats: ["iife"] } },
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
// As Core answers (executor_templates::view).
const view = (workspace, project, opencodeEnabled = false) => ({
  workspace,
  ...(project ? { project: { id: "p1", ...project } } : {}),
  available: [
    ...(project?.templates ?? []).map((template) => ({ template, source: "project" })),
    ...workspace.templates.filter((w) => !(project?.templates ?? []).some((p) => p.id === w.id)).map((template) => ({ template, source: "workspace" })),
  ],
  defaultNamePattern: "{task} · {label}",
  limits: { templates: 50, instructionsBytes: 8192, maxConcurrent: 64 },
  opencodeEnabled,
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
const field = (page, label) => page.document.querySelector(`[aria-label="${label}"]`);
async function type(page, label, value) {
  const node = field(page, label);
  const proto = node.tagName === "TEXTAREA" ? page.window.HTMLTextAreaElement.prototype
    : node.tagName === "SELECT" ? page.window.HTMLSelectElement.prototype : page.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
  node.dispatchEvent(new page.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  await tick();
}
const button = (page, text) => [...page.document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const puts = (page) => page.calls.filter((c) => c.method === "PUT");

test("Executor templates: a new template is added, said as written and saved as a whole list against the version read", async () => {
  let workspace = { version: 0, templates: [] };
  let conflict = false;
  const page = mount((url, method, body) => {
    if (method === "PUT") {
      if (conflict || body.expectedVersion !== workspace.version) return [400, { error: "version_conflict: these executor templates changed; reload before saving" }];
      workspace = { version: workspace.version + 1, templates: body.templates };
    }
    return [200, view(workspace)];
  });
  page.window.renderTemplates();
  const section = () => page.document.querySelector("#settings-executor-templates");
  await until(() => /No template yet\./.test(section()?.textContent ?? ""), "the empty list");
  assert.equal(button(page, "Save templates").disabled, true, "nothing to save yet");
  assert.match(section().textContent, /Executors run on this Core host\./);

  button(page, "Add template").click();
  await tick();
  await type(page, "Label", "Code reviewer");
  assert.equal(field(page, "Id").value, "code-reviewer", "a new template's id follows its label");
  await type(page, "Harness", "claude");
  assert.equal(field(page, "Reasoning effort"), null, "Claude Code keeps each Agent's own effort");
  await type(page, "Permissions", "auto");
  await type(page, "Instructions", "Read the acceptance first.");
  assert.match(section().textContent, /26 of 8192 bytes/);
  assert.match(section().textContent, /Unsaved changes/);
  button(page, "Save templates").click();
  await until(() => /Saved\./.test(section().textContent), "the saved list");
  assert.deepEqual(puts(page)[0], { url: "/api/executor-templates", method: "PUT", body: { expectedVersion: 0, templates: [
    { id: "code-reviewer", label: "Code reviewer", harness: "claude", permissionMode: "auto", instructions: "Read the acceptance first." },
  ] } });
  assert.equal(button(page, "Save templates").disabled, true, "what was saved is what is shown");
  assert.equal(page.document.querySelector("fieldset").getAttribute("aria-label"), "Code reviewer");

  // Another harness starts its permissions over; a Codex effort needs its model.
  await type(page, "Harness", "codex");
  assert.equal(field(page, "Permissions").value, "", "another harness starts its permissions over");
  assert.equal(field(page, "Reasoning effort").disabled, true);
  await type(page, "Model", "gpt-test");
  assert.equal(field(page, "Reasoning effort").disabled, false);
  await type(page, "Reasoning effort", "high");
  await type(page, "Model", "");
  assert.equal(field(page, "Reasoning effort").value, "", "clearing the model clears its effort");
  await type(page, "Label", "Lead reviewer");
  assert.equal(field(page, "Id").value, "code-reviewer", "a saved template's id stays when its label changes");

  conflict = true;
  button(page, "Save templates").click();
  await until(() => page.document.querySelector('[role="alert"]'), "the refusal");
  assert.deepEqual(puts(page).at(-1).body.templates[0], { id: "code-reviewer", label: "Lead reviewer", harness: "codex" },
    "an effort is sent only with its model");
  assert.match(page.document.querySelector('[role="alert"]').textContent, /version_conflict: these executor templates changed/);
  conflict = false;
  button(page, "Reload saved templates").click();
  await until(() => field(page, "Harness")?.value === "claude", "the saved list again");
  assert.equal(page.document.querySelector('[role="alert"]'), null);
  assert.deepEqual(page.errors, []);
});

test("a project's own templates: the Workspace's are named, those it replaces said so; an archived project's can't change", async () => {
  const workspace = { version: 3, templates: [{ id: "reviewer", label: "Reviewer", harness: "codex" }, { id: "writer", label: "Writer", harness: "claude" }] };
  // In Core's own field order, which is not the order this client writes them in.
  let project = { version: 1, templates: [{ id: "reviewer", label: "Project reviewer", namePattern: "{label} on {task}", harness: "claude" }] };
  const page = mount((url, method, body) => {
    if (method === "PUT") project = { version: project.version + 1, templates: body.templates };
    return [200, view(workspace, project)];
  });
  page.window.renderProjectTemplates("p1");
  await until(() => field(page, "Label"), "the project's list");
  const text = () => page.document.querySelector(".executor-templates-settings").textContent;
  assert.match(text(), /Also available here, from the Workspace: Reviewer \(replaced here\) · Writer\./);
  assert.equal(page.calls[0].url, "/api/executor-templates?projectId=p1");
  assert.equal(field(page, "Name").value, "{label} on {task}");
  assert.equal(button(page, "Save templates").disabled, true, "nothing to save after loading");
  assert.doesNotMatch(text(), /Unsaved changes/, "nothing to save after loading");
  await type(page, "Label", "Lead reviewer");
  button(page, "Save templates").click();
  await until(() => puts(page).length === 1, "the save");
  assert.deepEqual(puts(page)[0], { url: "/api/projects/p1/executor-templates", method: "PUT", body: { expectedVersion: 1, templates: [
    { id: "reviewer", label: "Lead reviewer", harness: "claude", namePattern: "{label} on {task}" },
  ] } });
  page.window.renderProjectTemplates("p1", true);
  await tick();
  assert.equal(page.document.querySelector("fieldset").disabled, true);
  assert.equal(button(page, "Add template").disabled, true);
  assert.deepEqual(page.errors, []);
});

test("OpenCode is offered only where this Core creates OpenCode Agents, with no model or permissions of its own", async () => {
  for (const enabled of [false, true]) {
    const page = mount(() => [200, view({ version: 1, templates: [{ id: "a", label: "A", harness: "codex" }], laterTemplates: 1 }, undefined, enabled)]);
    page.window.renderTemplates();
    await until(() => field(page, "Harness"), "the list");
    assert.match(page.document.querySelector(".executor-templates-settings").textContent,
      /This list also holds 1 template saved by a newer Core\. This Core can’t show it; saving here keeps it as it is\./);
    const options = [...field(page, "Harness").options].map((o) => o.value);
    assert.deepEqual(options, enabled ? ["codex", "claude", "opencode"] : ["codex", "claude"], String(enabled));
    if (enabled) {
      await type(page, "Harness", "opencode");
      assert.equal(field(page, "Model"), null);
      assert.equal(field(page, "Permissions"), null);
      assert.match(page.document.querySelector(".executor-templates-settings").textContent, /OpenCode uses its own configuration’s model and permissions\./);
    }
    assert.deepEqual(page.errors, []);
  }
});
