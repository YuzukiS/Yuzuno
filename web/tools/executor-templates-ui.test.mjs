// T-34 S1, YN-2 S2: Settings → Executor templates, the Workspace's only list;
// a project has no templates and no executors number of its own (YN-2 S5: each machine has). A save sends the whole list as
// this client writes it, against the version read; a conflict says so and
// offers a reload. Fixture HTTP only; no Core.
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
import * as Templates from ${src("ExecutorTemplates.tsx")};
const root=createRoot(document.getElementById('root'));
window.renderTemplates=()=>root.render(<Templates.ExecutorTemplates active/>);
// A project's page (YN-2 S2). Before it, the page held the editor with a projectId: a red there fails at an assertion.
window.renderProjectExecutors=(id,disabled=false)=>root.render(Templates.ProjectExecutors
  ? <Templates.ProjectExecutors projectId={id} disabled={disabled}/>
  : <Templates.ExecutorTemplates active projectId={id} disabled={disabled}/>);`,
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
// As Core answers (executor_templates::view): the Workspace's list only (YN-2 S2).
const view = (workspace, opencodeEnabled = false, presets = []) => ({
  workspace,
  available: workspace.templates.map((template) => ({ template, source: "workspace" })),
  presets,
  defaultNamePattern: "{task} · {label}",
  limits: { templates: 50, instructionsBytes: 8192, maxConcurrent: 64 },
  opencodeEnabled,
});

// As Core answers /api/executor-slots (executor_slots.rs `executor_slots_view`, YN-2 S5: each machine's limit only).
const machineRow = (id, name, slots, saved) => ({ id, name, version: saved ? 1 : 0, slots, saved, default: 3, executors: 0 });
const slotsView = ({ version = 0, inUse = { waiting: 0, starting: 0, running: 0 }, startLimitSeconds = 300,
  machines = [machineRow("local", "this Core host", 3, false)] } = {}) => ({
  workspace: { version, startLimitSeconds },
  limits: { min: 1, max: 64, default: 3, startLimitSeconds: { min: 30, max: 3600, default: 300 } },
  inUse,
  machines,
  total: machines.reduce((sum, m) => sum + m.slots, 0),
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
    // A route may answer later (a promise), as Core can.
    const [status, value] = await (isSlots(url) ? slots : route)(url, method, body);
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
  await until(() => /No template yet: a dispatch makes a general executor\./.test(section()?.textContent ?? ""), "the empty list");
  assert.equal(button(page, "Save templates").disabled, true, "nothing to save yet");
  assert.doesNotMatch(section().textContent, /Executors run on this Core host\./, "the host-only line is gone: each template says where it runs (T-35 S3)");

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

test("a template needs only a label and a harness; the rest is folded, a copied one says where it came from (YN-2 S2)", async () => {
  const copied = { id: "reviewer-2", label: "Reviewer (Lab)", harness: "claude", instructions: "Lab's way.",
    origin: { projectId: "p1", projectName: "Lab", id: "reviewer" } };
  let workspace = { version: 2, templates: [copied] };
  const page = mount((url, method, body) => {
    if (method === "PUT") workspace = { version: workspace.version + 1, templates: body.templates };
    return [200, view(workspace)];
  });
  page.window.renderTemplates();
  const section = () => page.document.querySelector("#settings-executor-templates");
  await until(() => field(page, "Label"), "the list");
  assert.match(section().textContent, /Copied from the project Lab, where its id was reviewer\./);
  const folds = () => [...page.document.querySelectorAll("details.executor-template-more")];
  assert.ok(folds().length === 1 && !folds()[0].open, "a template's other settings are folded");
  assert.equal(folds()[0].querySelector("summary").textContent, "More settings (1 set)", "the fold says how many it sets");
  button(page, "Add template").click();
  await tick();
  assert.equal(button(page, "Save templates").disabled, true, "a template needs a label");
  assert.match(section().textContent, /A template needs a label\./);
  const labels = () => [...page.document.querySelectorAll('[aria-label="Label"]')];
  const proto = page.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(labels()[1], "Builder");
  labels()[1].dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await tick();
  assert.equal(button(page, "Save templates").disabled, false, "a label and the default harness are enough");
  button(page, "Save templates").click();
  await until(() => puts(page).length === 1, "the save");
  assert.deepEqual(puts(page)[0].body, { expectedVersion: 2, templates: [copied, { id: "builder", label: "Builder", harness: "codex" }] },
    "the copy keeps where it came from; the new one is a label and a harness");
  assert.deepEqual(page.errors, []);
});

test("a preset is adopted into an unsaved draft, with a free id, and saved only by Save (YN-2 S2, presets from T-43)", async () => {
  const preset = { id: "design-first", label: "Design first", harness: "claude", instructions: "Write the design note first.",
    description: "When a change needs a design note approved before code." };
  let workspace = { version: 1, templates: [{ id: "design-first", label: "Design first", harness: "codex" }] };
  const page = mount((url, method, body) => {
    if (method === "PUT") workspace = { version: workspace.version + 1, templates: body.templates };
    return [200, view(workspace, false, [preset])];
  });
  page.window.renderTemplates();
  await until(() => field(page, "Add from a preset"), "the preset picker");
  assert.deepEqual([...field(page, "Add from a preset").options].map((o) => o.textContent), ["Add from a preset", "Design first"]);
  await type(page, "Add from a preset", "design-first");
  assert.equal(page.document.querySelectorAll("fieldset").length, 2, "a draft from the preset");
  assert.deepEqual(puts(page), [], "nothing is saved by adopting");
  button(page, "Save templates").click();
  await until(() => puts(page).length === 1, "the save");
  assert.deepEqual(puts(page)[0].body.templates[1],
    { id: "design-first-2", label: "Design first", harness: "claude", instructions: "Write the design note first." },
    "a free id, and the preset's fields without its description");
  assert.deepEqual(page.errors, []);
});

test("OpenCode is offered only where this Core creates OpenCode Agents, with no model or permissions of its own", async () => {
  for (const enabled of [false, true]) {
    const page = mount(() => [200, view({ version: 1, templates: [{ id: "a", label: "A", harness: "codex" }], laterTemplates: 1 }, enabled)]);
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

test("Executors at once (YN-2 S5): each machine's number is shown, with their sum; there is no Workspace number to save", async () => {
  const machines = [machineRow("local", "this Core host", 6, true), machineRow("mini", "Mac mini", 3, false)];
  const page = mount(() => [200, view({ version: 0, templates: [] })],
    () => [200, slotsView({ machines, inUse: { waiting: 2, starting: 1, running: 3 } })]);
  page.window.renderTemplates();
  const group = () => page.document.querySelector('[role="group"][aria-label="How many executors run at once"]');
  await until(() => group() && field(page, "Start time limit (seconds)"), "executors at once");
  assert.match(group().textContent, /Executors at once is set for each machine: this Core host 6, Mac mini 3 \(default\); 9 in all\./,
    "each machine's number, the default marked, and their sum");
  assert.match(group().textContent, /Change a machine's number in Settings → Machines\./);
  assert.match(group().textContent, /In this Workspace now: 3 running, 1 starting, 2 waiting\./);
  assert.equal(Boolean(field(page, "Executors at once")), false, "no Workspace number to set: it is each machine's");
  assert.equal(page.calls.find((c) => isSlots(c.url)).url, "/api/executor-slots");
  assert.deepEqual(page.errors, []);
});

test("Executors at once (T-35): an answer without its fields reads as Core's defaults", async () => {
  const page = mount(() => [200, view({ version: 0, templates: [] })], () => [200, {}]);
  page.window.renderTemplates();
  await until(() => field(page, "Start time limit (seconds)"), "the start time limit");
  assert.equal(field(page, "Start time limit (seconds)").value, "300");
  const group = page.document.querySelector('[role="group"][aria-label="How many executors run at once"]');
  assert.match(group.textContent, /0 running, 0 starting, 0 waiting/);
  assert.match(group.textContent, /; 0 in all\./, "no machine listed: none counted");
  assert.deepEqual(page.errors, []);
});

test("Start time limit (T-35 S2): the Workspace's, a whole number of seconds from 30 to 3600, saved alone (YN-2 S5)", async () => {
  let current = { version: 0, startLimitSeconds: 300 };
  const page = mount(() => [200, view({ version: 0, templates: [] })], (url, method, body) => {
    if (method === "PUT") current = { ...current, version: current.version + 1, startLimitSeconds: body.startLimitSeconds };
    return [200, slotsView(current)];
  });
  page.window.renderTemplates();
  await until(() => field(page, "Start time limit (seconds)"), "the start time limit");
  const group = () => page.document.querySelector('[role="group"][aria-label="How many executors run at once"]');
  assert.equal(field(page, "Start time limit (seconds)").value, "300");
  assert.match(group().textContent, /How long an executor’s start may take before Core cuts it off\. A start that fails is rebuilt once; a second failure blocks its task\. 300 unless you change it\./);
  const save = () => button(page, "Save start time limit");
  assert.equal(save().disabled, true, "nothing to save yet");
  for (const bad of ["29", "3601", "30.5", ""]) {
    await type(page, "Start time limit (seconds)", bad);
    assert.match(group().textContent, /A whole number of seconds from 30 to 3600\./, `${JSON.stringify(bad)} says the range`);
    assert.equal(field(page, "Start time limit (seconds)").getAttribute("aria-invalid"), "true");
    assert.equal(save().disabled, true, `${JSON.stringify(bad)} is not saved`);
  }
  await type(page, "Start time limit (seconds)", "45");
  save().click();
  await until(() => slotPuts(page).length === 1, "the save");
  assert.deepEqual(slotPuts(page)[0], { url: "/api/executor-slots", method: "PUT", body: { expectedVersion: 0, startLimitSeconds: 45 } },
    "the start time limit alone: no Workspace number");
  await until(() => /Saved\./.test(group().textContent), "saved");
  assert.equal(field(page, "Start time limit (seconds)").value, "45");
  assert.deepEqual(page.errors, []);
});

test("a template has no limit of its own (T-43: one limit per machine); one saved before is dropped at the next save", async () => {
  let workspace = { version: 1, templates: [{ id: "reviewer", label: "Reviewer", harness: "claude", maxConcurrent: 3 }] };
  const page = mount((url, method, body) => {
    if (method === "PUT") workspace = { version: workspace.version + 1, templates: body.templates };
    return [200, view(workspace)];
  });
  page.window.renderTemplates();
  await until(() => field(page, "Name"), "the template");
  const section = () => page.document.querySelector("#settings-executor-templates");
  assert.equal(field(page, "At most at once"), null, "no At most at once field");
  assert.doesNotMatch(section().textContent, /At most at once|no limit of its own/);
  assert.match(section().querySelector(".executor-template summary").textContent, /^More settings$/, "an old limit isn't counted on the fold");
  assert.equal(button(page, "Save templates").disabled, true, "an old limit alone is nothing to save");
  await type(page, "Name", "{task} · review");
  button(page, "Save templates").click();
  await until(() => puts(page).length === 1, "the save");
  assert.deepEqual(puts(page)[0].body.templates, [{ id: "reviewer", label: "Reviewer", harness: "claude", namePattern: "{task} · review" }], "saved without its old limit");
  assert.deepEqual(page.errors, []);
});

// T-35 S3: where a template's executors run: this Core host, a registered
// machine, or auto. The options are read from one rendering of the select,
// so what is left out is checked in the same list as what is offered.
const machineList = { machines: [
  { id: "local", name: "Core host", kind: "local", defaultCwd: "/home/me" },
  { id: "lab", name: "Lab box", kind: "ssh", target: "lab", defaultCwd: "/srv/lab" },
  { id: "boxed", name: "Boxed", kind: "ssh", target: "boxed", defaultCwd: "/srv/boxed", contained: true },
] };
const runsOn = (page, label = "Runs on") => field(page, label);
const offered = (page, label) => [...runsOn(page, label).options].map((o) => o.value);
const shown = (page, label) => [...runsOn(page, label).options].map((o) => o.textContent);

test("Runs on (T-35 S3): a template names this Core host, a registered machine or auto, by harness, and a save keeps it", async () => {
  let workspace = { version: 1, templates: [{ id: "r", label: "Reviewer", harness: "claude", machineId: "lab" }] };
  const page = mount((url, method, body) => {
    if (url.endsWith("/machines")) return [200, machineList];
    if (method === "PUT") workspace = { version: workspace.version + 1, templates: body.templates };
    return [200, view(workspace, true)];
  });
  page.window.renderTemplates();
  const section = () => page.document.querySelector("#settings-executor-templates").textContent;
  await until(() => runsOn(page)?.value === "lab" && offered(page).length === 4, "the saved machine, with the machines read");
  assert.deepEqual(offered(page), ["", "lab", "boxed", "auto"], "Claude Code: this Core host, each registered machine, and auto");
  assert.deepEqual(shown(page), ["This Core host", "Lab box", "Boxed", "Choose automatically"]);
  assert.match(section(), /Where its executors run\. A dispatch may name another machine\./);

  await type(page, "Harness", "codex");
  assert.deepEqual(offered(page), ["", "lab", "auto"], "Codex: no machine that keeps its Agents contained");
  assert.equal(runsOn(page).value, "lab", "a machine Codex may run on stays chosen");
  button(page, "Save templates").click();
  await until(() => puts(page).length === 1 && /Saved\./.test(section()), "the save");
  assert.equal(puts(page)[0].body.templates[0].machineId, "lab", "a save keeps the machine it names");

  await type(page, "Runs on", "auto");
  assert.match(section(), /Core chooses at each dispatch: a machine with a free executor slot first, then the most spare Jobs memory, then CPU\. The task shows which it chose and why\./);
  button(page, "Save templates").click();
  await until(() => puts(page).length === 2 && /Saved\./.test(section()), "the second save");
  assert.equal(puts(page)[1].body.templates[0].machineId, "auto", "auto is saved as auto");

  await type(page, "Harness", "opencode");
  assert.deepEqual(offered(page), [""], "OpenCode: this Core host only, no machine and no auto");
  assert.equal(runsOn(page).disabled, true);
  assert.match(section(), /OpenCode executors run on this Core host\./);
  button(page, "Save templates").click();
  await until(() => puts(page).length === 3, "the third save");
  assert.equal("machineId" in puts(page)[2].body.templates[0], false, "an OpenCode template names no machine");
  assert.deepEqual(page.errors, []);
});

test("Runs on (T-35 S3): a machine the list no longer has is shown as unknown and kept until changed", async () => {
  const workspace = { version: 1, templates: [{ id: "r", label: "Reviewer", harness: "claude", machineId: "gone" }] };
  const page = mount((url, method) => {
    if (url.endsWith("/machines")) return [200, machineList];
    if (method === "PUT") return [200, view(workspace)];
    return [200, view(workspace)];
  });
  page.window.renderTemplates();
  await until(() => runsOn(page)?.value === "gone" && offered(page).length === 5, "the unknown machine, with the machines read");
  assert.equal(runsOn(page).selectedOptions[0].textContent, "gone (not in the Machines list)");
  await type(page, "Label", "Lead reviewer");
  button(page, "Save templates").click();
  await until(() => puts(page).length === 1, "the save");
  assert.equal(puts(page)[0].body.templates[0].machineId, "gone", "kept until changed");
});

// #645 R1 1342ccdd: a machine still in the list that this harness cannot use
// is named, with why, rather than called unknown; a save keeps it.
test("Runs on (T-35 S3): a Codex template saved with a machine that keeps its Agents contained names that machine and why, and keeps it until changed", async () => {
  const workspace = { version: 1, templates: [{ id: "c", label: "Coder", harness: "codex", machineId: "boxed" }] };
  const page = mount((url, method) => {
    if (url.endsWith("/machines")) return [200, machineList];
    return [200, view(workspace)];
  });
  page.window.renderTemplates();
  await until(() => runsOn(page)?.value === "boxed" && offered(page).length === 4, "the saved machine, with the machines read");
  assert.deepEqual(offered(page), ["", "lab", "boxed", "auto"]);
  assert.equal(runsOn(page).selectedOptions[0].textContent, "Boxed (keeps Agents contained: no Codex)", "the machine is named with why Codex cannot run there");
  assert.ok(!shown(page).some((text) => /not in the Machines list/.test(text)), "it is not called unknown");
  await type(page, "Label", "Lead coder");
  button(page, "Save templates").click();
  await until(() => puts(page).length === 1, "the save");
  assert.equal(puts(page)[0].body.templates[0].machineId, "boxed", "kept until changed");
  assert.deepEqual(page.errors, []);
});

// #645 R1 e4931a53: the Machines list is read beside the templates. Until it
// is read a saved machine is just its id; a failed read says the list is
// unavailable; only a list that was read and lacks it calls it missing.
test("Runs on (T-35 S3): a saved machine reads as its id until the Machines list is read, by name once it is, and as unavailable when the read fails", async () => {
  const workspace = { version: 1, templates: [{ id: "r", label: "Reviewer", harness: "claude", machineId: "lab" }] };
  let answer;
  const later = new Promise((resolve) => { answer = resolve; });
  const page = mount((url) => (url.endsWith("/machines") ? later : [200, view(workspace)]));
  page.window.renderTemplates();
  await until(() => runsOn(page)?.value === "lab", "the saved machine, before the list");
  await tick();
  assert.deepEqual(shown(page), ["This Core host", "lab", "Choose automatically"], "before the list is read, the saved machine is named without saying it is missing");
  answer([200, machineList]);
  await until(() => offered(page).length === 4, "the machines read");
  assert.equal(runsOn(page).selectedOptions[0].textContent, "Lab box", "once the list is read, it is named");
  assert.deepEqual(page.errors, []);

  const failing = mount((url) => (url.endsWith("/machines") ? [503, { error: "machines are not available right now" }] : [200, view(workspace)]));
  failing.window.renderTemplates();
  await until(() => runsOn(failing)?.value === "lab" && failing.calls.some((c) => c.url.endsWith("/machines")), "the saved machine, with the list asked for");
  await tick();
  await tick();
  assert.equal(runsOn(failing).selectedOptions[0].textContent, "lab (Machines list unavailable)", "a failed read says the list is unavailable");
  assert.deepEqual(failing.errors, []);
});

test("Runs on (T-35 S3) reads in Chinese (T-189)", async () => {
  const workspace = { version: 1, templates: [{ id: "r", label: "Reviewer", harness: "claude", machineId: "auto" }] };
  const page = mount((url) => [200, url.endsWith("/machines") ? machineList : view(workspace)]);
  page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
  page.window.renderTemplates();
  await until(() => runsOn(page, "运行于")?.value === "auto" && offered(page, "运行于").length === 4, "the select, in Chinese");
  assert.deepEqual(shown(page, "运行于"), ["此 Core 主机", "Lab box", "Boxed", "自动选择"]);
  assert.match(page.document.querySelector("#settings-executor-templates").textContent, /Core 在每次派发时选择：先选有空闲执行者槽位的机器/);
  assert.deepEqual(page.errors, []);
});
