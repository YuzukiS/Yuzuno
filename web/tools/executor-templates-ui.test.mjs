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

// As Core answers /api/executor-slots (executor_slots.rs `executor_slots_view`).
const slotsView = ({ version = 0, slots = 3, saved = false, project, inUse = { waiting: 0, starting: 0, running: 0 }, startLimitSeconds = 300 } = {}) => ({
  workspace: { version, slots, saved, default: 3, startLimitSeconds },
  limits: { min: 1, max: 64, startLimitSeconds: { min: 30, max: 3600, default: 300 } },
  inUse,
  ...(project ? { project: { id: "p1", ...project } } : {}),
});
const isSlots = (url) => /\/executor-slots(\?|$)/.test(url);

/** `route` answers the templates; `slots`, if given, the executor slots (T-35). */
function mount(route, slots = () => [200, slotsView()]) {
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
    const [status, value] = (isSlots(url) ? slots : route)(url, method, body);
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
const puts = (page) => page.calls.filter((c) => c.method === "PUT" && !isSlots(c.url));
const slotPuts = (page) => page.calls.filter((c) => c.method === "PUT" && isSlots(c.url));

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
  // A label with no Latin letter or digit still gives an id (R2 70093e91).
  await type(page, "Label", "代码审查");
  assert.equal(field(page, "Id").value, "template-1", "a label in another script gives a numbered id");
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
  assert.deepEqual(puts(page).at(-1).body.templates[0],
    { id: "code-reviewer", label: "Lead reviewer", harness: "codex", instructions: "Read the acceptance first." },
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
  assert.equal(page.calls.find((c) => !isSlots(c.url)).url, "/api/executor-templates?projectId=p1");
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

test("Executors at once (T-35): the Workspace's limit is saved against its version, a whole number from 1 to 64", async () => {
  let current = { version: 0, slots: 3, saved: false, inUse: { waiting: 2, starting: 1, running: 3 } };
  let conflict = false;
  const page = mount(() => [200, view({ version: 0, templates: [] })], (url, method, body) => {
    if (method === "PUT") {
      if (conflict || body.expectedVersion !== current.version) return [400, { error: "version_conflict: these executor slots changed; reload before saving" }];
      current = { ...current, version: current.version + 1, slots: body.slots, saved: true };
    }
    return [200, slotsView(current)];
  });
  page.window.renderTemplates();
  const group = () => page.document.querySelector('[role="group"][aria-label="How many executors run at once"]');
  await until(() => field(page, "Executors at once"), "the limit");
  assert.equal(page.calls.find((c) => isSlots(c.url)).url, "/api/executor-slots");
  assert.equal(field(page, "Executors at once").value, "3");
  assert.match(group().textContent, /How many executors run at once in this Workspace\. Those dispatched beyond it wait in a queue and start in turn, as executors close\. 3 unless you change it\./);
  assert.match(group().textContent, /In this Workspace now: 3 running, 1 starting, 2 waiting\./);
  const save = () => button(page, "Save executors at once");
  assert.equal(save().disabled, true, "nothing to save yet");

  for (const bad of ["0", "65", ""]) {
    await type(page, "Executors at once", bad);
    assert.equal(save().disabled, true, `${JSON.stringify(bad)} is not saved`);
    assert.match(group().textContent, /A whole number from 1 to 64\./, `${JSON.stringify(bad)} says the range`);
    assert.equal(field(page, "Executors at once").getAttribute("aria-invalid"), "true");
  }
  await type(page, "Executors at once", "5");
  assert.match(group().textContent, /Unsaved change/);
  save().click();
  await until(() => /Saved\./.test(group().textContent), "the saved limit");
  assert.deepEqual(slotPuts(page), [{ url: "/api/executor-slots", method: "PUT", body: { expectedVersion: 0, slots: 5, startLimitSeconds: 300 } }]);
  assert.equal(field(page, "Executors at once").value, "5");
  assert.equal(save().disabled, true, "what was saved is what is shown");
  assert.deepEqual(puts(page), [], "the templates are saved apart");

  conflict = true;
  await type(page, "Executors at once", "6");
  save().click();
  await until(() => group().querySelector('[role="alert"]'), "the refusal");
  assert.match(group().querySelector('[role="alert"]').textContent, /version_conflict: these executor slots changed/);
  conflict = false;
  button(page, "Reload executors at once").click();
  await until(() => field(page, "Executors at once")?.value === "5", "the saved limit again");
  assert.ok(!group().querySelector('[role="alert"]'), "the refusal is gone");
  assert.deepEqual(page.errors, []);
});

test("Executors at once (T-35): a project's own limit is within the Workspace's, empty to unset; an archived project's can't change", async () => {
  let project = { version: 0, slots: null };
  const page = mount(() => [200, view({ version: 0, templates: [] }, { version: 0, templates: [] })], (url, method, body) => {
    if (method === "PUT") project = { version: project.version + 1, slots: body.slots };
    return [200, slotsView({ slots: 4, saved: true, version: 2, project })];
  });
  page.window.renderProjectTemplates("p1");
  await until(() => field(page, "Executors at once"), "the project's limit");
  assert.equal(page.calls.find((c) => isSlots(c.url)).url, "/api/executor-slots?projectId=p1");
  assert.equal(field(page, "Executors at once").value, "", "unset: empty");
  const group = () => page.document.querySelector('[role="group"][aria-label="How many executors run at once"]');
  assert.match(group().textContent, /At most this many of this project’s executors at once, within the Workspace’s 4\. Empty: only the Workspace’s limit applies\./);
  const save = () => button(page, "Save executors at once");
  assert.equal(save().disabled, true);
  await type(page, "Executors at once", "2");
  save().click();
  await until(() => slotPuts(page).length === 1, "the save");
  await until(() => /Saved\./.test(group().textContent), "saved");
  await type(page, "Executors at once", "");
  assert.equal(save().disabled, false, "empty unsets a project's own");
  save().click();
  await until(() => slotPuts(page).length === 2, "the second save");
  assert.deepEqual(slotPuts(page), [
    { url: "/api/projects/p1/executor-slots", method: "PUT", body: { expectedVersion: 0, slots: 2 } },
    { url: "/api/projects/p1/executor-slots", method: "PUT", body: { expectedVersion: 1, slots: null } },
  ]);
  page.window.renderProjectTemplates("p1", true);
  await tick();
  assert.equal(field(page, "Executors at once").disabled, true);
  assert.equal(save().disabled, true);
  assert.deepEqual(page.errors, []);
});

test("Executors at once (T-35): an answer without its fields reads as Core's defaults", async () => {
  const page = mount(() => [200, view({ version: 0, templates: [] })], () => [200, {}]);
  page.window.renderTemplates();
  await until(() => field(page, "Executors at once"), "the limit");
  assert.equal(field(page, "Executors at once").value, "3");
  assert.match(page.document.querySelector('[role="group"][aria-label="How many executors run at once"]').textContent, /0 running, 0 starting, 0 waiting/);
  assert.deepEqual(page.errors, []);
});

test("Start time limit (T-35 S2): the Workspace's, a whole number of seconds from 30 to 3600, saved with its limit; a project has none of its own", async () => {
  let current = { version: 0, slots: 3, saved: false, startLimitSeconds: 300 };
  const page = mount(() => [200, view({ version: 0, templates: [] })], (url, method, body) => {
    if (method === "PUT") current = { ...current, version: current.version + 1, slots: body.slots, saved: true, startLimitSeconds: body.startLimitSeconds ?? current.startLimitSeconds };
    return [200, slotsView(current)];
  });
  page.window.renderTemplates();
  await until(() => field(page, "Start time limit (seconds)"), "the start time limit");
  const group = () => page.document.querySelector('[role="group"][aria-label="How many executors run at once"]');
  assert.equal(field(page, "Start time limit (seconds)").value, "300");
  assert.match(group().textContent, /How long an executor’s start may take before Core cuts it off\. A start that fails is rebuilt once; a second failure blocks its task\. 300 unless you change it\./);
  const save = () => button(page, "Save executors at once");
  for (const bad of ["29", "3601", "30.5", ""]) {
    await type(page, "Start time limit (seconds)", bad);
    assert.match(group().textContent, /A whole number of seconds from 30 to 3600\./, `${JSON.stringify(bad)} says the range`);
    assert.equal(field(page, "Start time limit (seconds)").getAttribute("aria-invalid"), "true");
    assert.equal(save().disabled, true, `${JSON.stringify(bad)} is not saved`);
  }
  await type(page, "Start time limit (seconds)", "45");
  save().click();
  await until(() => slotPuts(page).length === 1, "the save");
  assert.deepEqual(slotPuts(page)[0].body, { expectedVersion: 0, slots: 3, startLimitSeconds: 45 });
  await until(() => /Saved\./.test(group().textContent), "saved");
  assert.equal(field(page, "Start time limit (seconds)").value, "45");
  assert.deepEqual(page.errors, []);
});

test("Start time limit (T-35 S2): a project's limit editor has no start time limit", async () => {
  const page = mount(() => [200, view({ version: 0, templates: [] }, { version: 0, templates: [] })],
    () => [200, slotsView({ project: { version: 0, slots: null } })]);
  page.window.renderProjectTemplates("p1");
  await until(() => field(page, "Executors at once"), "the project's limit");
  assert.ok(!field(page, "Start time limit (seconds)"), "the Workspace's alone");
  assert.deepEqual(page.errors, []);
});

test("At most at once (T-35 S4): a template's own limit is a whole number from 1 to 64, or empty; anything else holds the save, said at its field", async () => {
  let workspace = { version: 1, templates: [{ id: "reviewer", label: "Reviewer", harness: "claude" }] };
  const page = mount((url, method, body) => {
    if (method === "PUT") workspace = { version: workspace.version + 1, templates: body.templates };
    return [200, view(workspace)];
  });
  page.window.renderTemplates();
  await until(() => field(page, "At most at once"), "the template");
  const section = () => page.document.querySelector("#settings-executor-templates");
  assert.match(section().textContent, /At most this many of this template’s executors run at once, within Executors at once\. Empty: no limit of its own\./);
  for (const bad of ["-1", "2.5", "0", "65"]) {
    await type(page, "At most at once", bad);
    assert.match(section().textContent, /At most at once is a whole number from 1 to 64\./, `${bad} says the range`);
    assert.equal(field(page, "At most at once").getAttribute("aria-invalid"), "true", `${bad} is marked`);
    assert.equal(button(page, "Save templates").disabled, true, `${bad} is not saved`);
  }
  await type(page, "At most at once", "3");
  assert.doesNotMatch(section().textContent, /is a whole number from 1 to 64/);
  button(page, "Save templates").click();
  await until(() => puts(page).length === 1, "the save");
  assert.deepEqual(puts(page)[0].body.templates, [{ id: "reviewer", label: "Reviewer", harness: "claude", maxConcurrent: 3 }]);
  await until(() => /Saved\./.test(section().textContent), "saved");
  await type(page, "At most at once", "");
  button(page, "Save templates").click();
  await until(() => puts(page).length === 2, "the second save");
  assert.deepEqual(puts(page)[1].body.templates, [{ id: "reviewer", label: "Reviewer", harness: "claude" }], "empty: no limit of its own");
  assert.deepEqual(page.errors, []);
});
