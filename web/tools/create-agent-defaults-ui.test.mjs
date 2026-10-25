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

function mount(defaults, { codexModels = [{ id: "gpt", model: "gpt", displayName: "GPT" }] } = {}) {
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
    if (url.includes("/agent-defaults")) {
      // A function answers per project (T-190: `?projectId=`).
      const value = typeof defaults === "function" ? defaults(new URL(url, "http://isolated.test/").searchParams.get("projectId")) : defaults;
      return value === null ? answer(404, { error: "Not found" }) : answer(200, value);
    }
    if (url.endsWith("/machines")) return answer(200, { machines: [local] });
    if (url.endsWith("/models?harness=claude")) return answer(200, { models: claudeModels });
    if (url.endsWith("/models")) return answer(200, { models: codexModels });
    if (url.endsWith("/agents") && init.method === "POST") return answer(200, { id: "new", ...body });
    return answer(200, {});
  };
  window.eval(bundle);
  const page = { window, document: window.document, calls, errors, created: [] };
  page.open = async (extra = {}) => {
    window.renderCreate({ open: true, close() {}, defaultCwd: "/workspace", disabled: false, onCreated: (agent) => page.created.push(agent), ...extra });
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

test("when the default switches the harness back, a model chosen for the other harness is not kept", async () => {
  const page = mount(view({ harness: "claude" }));
  await page.open();
  await until(() => picked(page, "Harness") === "claude", "the Workspace's default harness");
  await pick(page, "Harness", "codex");
  await until(() => group(page, "Model")?.querySelector('input[value="gpt"]'), "the Codex models");
  await pick(page, "Model", "gpt");
  page.window.renderCreate({ open: false, close() {}, defaultCwd: "/workspace", disabled: false, onCreated() {} });
  await tick();
  await page.open();
  await until(() => picked(page, "Harness") === "claude", "the default harness after cancelling");
  await until(() => group(page, "Model")?.querySelector('input[value="sonnet"]'), "the Claude models");
  assert.equal(picked(page, "Model"), "", "the Codex model is not carried over to Claude Code");
  await type(page, "Name", "Nashi");
  const body = await submit(page);
  assert.deepEqual([body.harness, "model" in body], ["claude", false]);
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

test("a project's overrides come in when it is chosen: the harness follows unless this Agent chose one, and only its own choice is sent", async () => {
  const workspace = view({ harness: "claude", claudePermissionMode: "auto" });
  // As Core answers for a project (agent_defaults::view): its harness and Codex permissions.
  const lab = {
    ...workspace,
    effective: {
      harness: { value: "codex", source: "project" },
      codexPermissionPreset: { value: "full", source: "project" },
      claudePermissionMode: { value: "auto", source: "workspace" },
    },
    project: { id: "p1", saved: { harness: "codex", codexPermissionPreset: "full" }, inherited: workspace.effective },
  };
  const projects = [{ id: "p1", name: "Lab", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
  const page = mount((project) => (project === "p1" ? lab : workspace));
  await page.open({ projects });
  await until(() => picked(page, "Harness") === "claude", "the Workspace's default harness");
  await pick(page, "Project", "p1");
  await until(() => picked(page, "Harness") === "codex", "the project's harness");
  assert.ok(page.calls.some((c) => c.url.includes("/agent-defaults?projectId=p1")), "read for that project");
  assert.match(page.document.body.textContent, /Set for this project: Codex for new/);
  assert.match(group(page, "Permissions").textContent, /Default · /);
  await type(page, "Name", "Lab agent");
  const inLab = await submit(page);
  assert.equal(inLab.harness, "codex");
  assert.equal(inLab.projectId, "p1");
  assert.equal("permissionPreset" in inLab, false, "the project's default is Core's to apply");
  assert.deepEqual(page.errors, []);
  // A harness this Agent chose (a change, not a click on the one shown) stays when the project
  // changes, and that project's Claude Code mode is not carried over to it.
  const claudeLab = {
    ...workspace,
    effective: { ...workspace.effective, harness: { value: "claude", source: "project" }, claudePermissionMode: { value: "auto", source: "project" } },
    project: { id: "p1", saved: { harness: "claude", claudePermissionMode: "auto" }, inherited: workspace.effective },
  };
  const again = mount((project) => (project === "p1" ? claudeLab : workspace));
  await again.open({ projects });
  await until(() => picked(again, "Harness") === "claude", "the Workspace's default harness");
  await pick(again, "Harness", "codex");
  await pick(again, "Project", "p1");
  await until(() => again.calls.some((c) => c.url.includes("/agent-defaults?projectId=p1")), "read for the project");
  await tick();
  assert.equal(picked(again, "Harness"), "codex", "this Agent's own choice stays");
  await type(again, "Name", "Chosen");
  const chosen = await submit(again);
  assert.equal(chosen.harness, "codex");
  assert.equal("permissionPreset" in chosen || "permissionMode" in chosen, false);
  assert.deepEqual(again.errors, []);
});

test("Codex on the Core host: the default model shows with its source; Codex's own default and an effort are this Agent's own choices", async () => {
  const codexModels = [
    { id: "m-small", model: "m-small", displayName: "Small", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "medium", description: "" }] },
    { id: "m-big", model: "m-big", displayName: "Big", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }] },
  ];
  const base = view({});
  const defaults = {
    ...base,
    effective: { ...base.effective, codexModel: { value: "m-big", source: "workspace" }, codexReasoningEffort: { value: "high", source: "workspace" } },
  };
  const labels = (page, label) => [...group(page, label).querySelectorAll("label")].map((l) => l.textContent.replace(/\s+/g, " ").trim());
  // Nothing chosen: the default is Core's to apply; nothing about the model is sent.
  const inherit = mount(defaults, { codexModels });
  await inherit.open();
  await until(() => group(inherit, "Model")?.querySelectorAll("input").length === 4, "the model choices");
  assert.match(labels(inherit, "Model")[0], /^Default · m-big.*Set for this Workspace/);
  assert.equal(labels(inherit, "Model")[1], "Codex’s own default");
  assert.match(inherit.document.body.textContent, /Reasoning effort with it: high/);
  assert.equal(group(inherit, "Reasoning effort"), null, "an effort is chosen with a model");
  await type(inherit, "Name", "Inherit");
  const inherited = await submit(inherit);
  assert.equal("model" in inherited || "reasoningEffort" in inherited, false);
  // Codex's own default, chosen: sent as null, so it overrides the default.
  const own = mount(defaults, { codexModels });
  await own.open();
  await until(() => group(own, "Model")?.querySelectorAll("input").length === 4, "the model choices");
  await pick(own, "Model", "(the harness’s own default)");
  await type(own, "Name", "Own");
  const ownBody = await submit(own);
  assert.equal(ownBody.model, null);
  assert.equal("reasoningEffort" in ownBody, false);
  // A model named: its efforts to choose from, sent with it.
  const named = mount(defaults, { codexModels });
  await named.open();
  await until(() => group(named, "Model")?.querySelectorAll("input").length === 4, "the model choices");
  await pick(named, "Model", "m-small");
  await until(() => group(named, "Reasoning effort"), "the model's efforts");
  assert.deepEqual(labels(named, "Reasoning effort"), ["Model’s own · medium", "low", "medium"]);
  await pick(named, "Reasoning effort", "low");
  await type(named, "Name", "Named");
  const namedBody = await submit(named);
  assert.deepEqual([namedBody.model, namedBody.reasoningEffort], ["m-small", "low"]);
  // Claude Code keeps its own path: no Codex default, no effort chosen here.
  await until(() => !named.document.querySelector("fieldset.remote-form-fields")?.disabled, "the form usable after the create");
  await pick(named, "Harness", "claude");
  await until(() => labels(named, "Model")[0] === "Harness default", "Claude's models");
  assert.equal(group(named, "Reasoning effort"), null);
  for (const page of [inherit, own, named]) assert.deepEqual(page.errors, []);
});

test("Claude Code on the Core host: the default model shows with its source, its own default is this Agent's choice, and an inherited model that can't run Auto mode waits for one", async () => {
  const withDefault = (model, saved = { harness: "claude" }) => {
    const base = view(saved);
    return {
      ...base,
      effective: {
        ...base.effective,
        codexModel: { value: null, source: "builtin" },
        codexReasoningEffort: { value: null, source: "builtin" },
        claudeModel: { value: model, source: "workspace" },
      },
    };
  };
  const labels = (page, label) => [...group(page, label).querySelectorAll("label")].map((l) => l.textContent.replace(/\s+/g, " ").trim());
  // Nothing chosen: the default is Core's to apply; nothing about the model is sent.
  const inherit = mount(withDefault("sonnet"));
  await inherit.open();
  await until(() => group(inherit, "Model")?.querySelectorAll("input").length === 4, "the Claude model choices");
  assert.match(labels(inherit, "Model")[0], /^Default · sonnet.*Set for this Workspace/);
  assert.equal(labels(inherit, "Model")[1], "Claude Code’s own default");
  assert.equal(group(inherit, "Reasoning effort"), null, "no effort default for Claude");
  await type(inherit, "Name", "Inherit");
  const inherited = await submit(inherit);
  assert.equal(inherited.harness, "claude");
  assert.equal("model" in inherited || "reasoningEffort" in inherited, false);
  // Claude Code's own default, chosen: sent as null, so it overrides the default.
  const own = mount(withDefault("sonnet"));
  await own.open();
  await until(() => group(own, "Model")?.querySelectorAll("input").length === 4, "the Claude model choices");
  await pick(own, "Model", "(the harness’s own default)");
  await type(own, "Name", "Own");
  const ownBody = await submit(own);
  assert.equal(ownBody.model, null);
  // An inherited model that can't run the Auto mode it would get: Create waits for this Agent's choice.
  const auto = mount(withDefault("haiku", { harness: "claude", claudePermissionMode: "auto" }));
  await auto.open();
  await until(() => group(auto, "Model")?.querySelectorAll("input").length === 4, "the Claude model choices");
  await type(auto, "Name", "Auto");
  assert.match(auto.document.body.textContent, /Auto mode isn’t available for this model/);
  assert.equal(createButton(auto).disabled, true);
  await pick(auto, "Permissions", "default");
  assert.equal(createButton(auto).disabled, false);
  const autoBody = await submit(auto);
  assert.equal(autoBody.permissionMode, "default");
  assert.equal("model" in autoBody, false);
  for (const page of [inherit, own, auto]) assert.deepEqual(page.errors, []);
});

test("New agent follows a language change from another window, what was typed and chosen kept and nothing asked again (T-189)", async () => {
  const page = mount(view({ harness: "codex" }));
  const language = async (value) => {
    page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: value }));
    page.window.dispatchEvent(new page.window.StorageEvent("storage", { key: "yuzuno.language" }));
    await tick();
    await tick();
  };
  await page.open();
  await until(() => picked(page, "Harness") === "codex", "the default harness");
  await type(page, "Name", "Mikan");
  await type(page, "Working folder", "/workspace/app");
  await pick(page, "Harness", "claude");
  await until(() => group(page, "Model")?.querySelector('input[value="haiku"]'), "Claude Code's models");
  await pick(page, "Model", "haiku");
  await pick(page, "Permissions", "default");
  const chosen = (labels) => ({
    name: page.document.querySelector('input[maxlength="60"]').value,
    folder: page.document.querySelector(".input-with-icon input").value,
    harness: picked(page, labels.harness),
    model: picked(page, labels.model),
    permission: picked(page, labels.permissions),
    models: [...group(page, labels.model).querySelectorAll("label")].map((l) => l.textContent),
  });
  const english = { text: page.document.body.textContent, chosen: chosen({ harness: "Harness", model: "Model", permissions: "Permissions" }) };
  assert.match(english.text, /A new little teammate.*Where to work.*Working folder.*Create agent/s);
  const before = page.calls.length;
  await language("zh-Hans");
  const text = page.document.body.textContent;
  assert.match(text, /一位新的小伙伴.*工作位置.*工作文件夹.*创建 Agent/s);
  assert.match(text, /操作前询问/, "agent-defaults' own words in the chosen language");
  assert.match(text, /使用你的 Core 主机上的 Claude Code 登录。/);
  const zh = chosen({ harness: "Harness", model: "模型", permissions: "权限" });
  assert.deepEqual(
    { ...zh, models: zh.models.slice(1) },
    { ...english.chosen, models: english.chosen.models.slice(1) },
    "what was typed and chosen, and the model names, as they were",
  );
  assert.equal(page.document.querySelector(".modal").getAttribute("lang"), "zh-Hans");
  await language("en");
  assert.equal(page.document.body.textContent, english.text);
  assert.deepEqual(chosen({ harness: "Harness", model: "Model", permissions: "Permissions" }), english.chosen);
  assert.equal(page.calls.length, before, "changing the language reads and sends nothing");
  assert.deepEqual(page.errors, []);
});
