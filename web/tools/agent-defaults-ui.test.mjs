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
window.renderProjectDefaults=(id,disabled=false)=>root.render(<AgentDefaults active projectId={id} disabled={disabled}/>);
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

// As Core answers for a project: the Workspace's choices, the project's own, what it inherits.
const projectView = (workspace, own) => {
  const inherited = view(workspace).effective;
  const pick = (field, built) => (own[field] !== undefined ? { value: own[field], source: "project" } : inherited[field] ?? built);
  return {
    ...view(workspace),
    effective: { harness: pick("harness"), codexPermissionPreset: pick("codexPermissionPreset"), claudePermissionMode: pick("claudePermissionMode") },
    project: { id: "p1", saved: own, inherited },
  };
};

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

test("a project's defaults inherit until set there; saving goes to the project, and null inherits again", async () => {
  const workspace = { harness: "claude", claudePermissionMode: "auto" };
  let own = {};
  const page = mount((url, method, body) => {
    if (method === "POST") {
      assert.match(url, /\/projects\/p1\/agent-defaults$/, "the project's own route, not the Workspace's");
      own = Object.fromEntries(Object.entries({ ...own, ...body }).filter(([, v]) => v !== null));
    } else {
      assert.match(url, /\/agent-defaults\?projectId=p1$/);
    }
    return [200, projectView(workspace, own)];
  });
  page.window.renderProjectDefaults("p1");
  await until(() => select(page, "Harness for new Agents"), "the project editor");
  const section = () => page.document.querySelector('[aria-label="New Agent defaults for this project"]');
  const text = () => section()?.textContent ?? "";
  assert.match(text(), /For Agents created in this project/);
  assert.match(text(), /Set for this Workspace: Claude Code/, "inherited, and from where");
  const options = (label) => [...select(page, label).options].map((o) => o.textContent.trim());
  assert.equal(options("Harness for new Agents")[0], "Inherit · Claude Code (Set for this Workspace)");
  assert.equal(options("Codex permissions for new Agents")[0], "Inherit · Ask for approval (Built in)");
  await choose(page, "Harness for new Agents", "codex");
  await choose(page, "Codex permissions for new Agents", "auto");
  button(page, "Save").click();
  await until(() => posts(page).length === 1 && /Set for this project: Codex/.test(text()), "the project's choice");
  assert.deepEqual(posts(page)[0].body, { harness: "codex", codexPermissionPreset: "auto" });
  assert.match(text(), /Saved for this project/);
  // Back to inherit: only that field is sent, as null; the other stays.
  await choose(page, "Harness for new Agents", "");
  button(page, "Save").click();
  await until(() => posts(page).length === 2 && /Set for this Workspace: Claude Code/.test(text()), "inherited again");
  assert.deepEqual(posts(page)[1].body, { harness: null });
  assert.deepEqual(own, { codexPermissionPreset: "auto" });
  button(page, "Inherit all").click();
  await until(() => posts(page).length === 3, "all inherited");
  assert.deepEqual(posts(page)[2].body, { harness: null, codexPermissionPreset: null, claudePermissionMode: null });
  assert.deepEqual(page.errors, []);
});

test("an archived project's defaults are shown but can't be changed", async () => {
  const page = mount(() => [200, projectView({}, { harness: "claude" })]);
  page.window.renderProjectDefaults("p1", true);
  await until(() => select(page, "Harness for new Agents"), "the project editor");
  assert.equal(select(page, "Harness for new Agents").disabled, true);
  assert.equal(button(page, "Inherit all").disabled, true);
});

// A Core with model defaults (T-190): the Core host's Codex catalog, and a view that reports them.
const catalog = [
  { id: "m-small", model: "m-small", displayName: "Small", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "medium", description: "" }] },
  { id: "m-big", model: "m-big", displayName: "Big", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }] },
];
const modelView = (saved) => {
  const base = view(saved);
  return {
    ...base,
    builtIn: { ...base.builtIn, codexModel: null, codexReasoningEffort: null },
    effective: {
      ...base.effective,
      codexModel: { value: saved.codexModel ?? null, source: saved.codexModel ? "workspace" : "builtin" },
      codexReasoningEffort: { value: saved.codexReasoningEffort ?? null, source: saved.codexReasoningEffort ? "workspace" : "builtin" },
    },
    modelAppliesTo: "Codex Agents created on the Core host. SSH machines, Claude Code and OpenCode keep their own model and effort.",
  };
};

test("a default Codex model and effort come from the Core host's catalog, as a pair, and only to a Core that has them", async () => {
  let saved = {};
  const page = mount((url, method, body) => {
    if (url.endsWith("/models")) return [200, { models: catalog }];
    if (method === "POST") saved = Object.fromEntries(Object.entries({ ...saved, ...body }).filter(([, v]) => v !== null));
    return [200, modelView(saved)];
  });
  page.window.renderDefaults();
  await until(() => select(page, "Codex model for new Agents")?.options.length === 3, "the catalog's models");
  const text = () => page.document.querySelector("#settings-agent-defaults")?.textContent ?? "";
  assert.match(text(), /Built in: Codex’s own default/);
  assert.match(text(), /SSH machines, Claude Code and OpenCode keep their own model and effort/);
  assert.doesNotMatch(text(), /no Workspace default for them yet/);
  const options = (label) => [...select(page, label).options].map((o) => o.textContent.trim());
  assert.deepEqual(options("Codex model for new Agents"), ["Built in · Codex’s own default", "Small", "Big"]);
  assert.equal(select(page, "Codex reasoning effort for new Agents").disabled, true, "no model, no effort to choose");
  await choose(page, "Codex model for new Agents", "m-small");
  assert.deepEqual(options("Codex reasoning effort for new Agents"), ["Model’s own · medium", "low", "medium"]);
  await choose(page, "Codex reasoning effort for new Agents", "low");
  button(page, "Save").click();
  await until(() => posts(page).length === 1 && /Set for this Workspace: m-small, reasoning effort low/.test(text()), "the saved pair");
  assert.deepEqual(posts(page)[0].body, { codexModel: "m-small", codexReasoningEffort: "low" });
  // Another model that doesn't offer that effort: the effort goes with the model.
  await choose(page, "Codex model for new Agents", "m-big");
  assert.equal(select(page, "Codex reasoning effort for new Agents").value, "");
  button(page, "Save").click();
  await until(() => posts(page).length === 2 && /Set for this Workspace: m-big\./.test(text()), "the new model saved");
  assert.deepEqual(posts(page)[1].body, { codexModel: "m-big", codexReasoningEffort: null });
  button(page, "Use built-in for all").click();
  await until(() => posts(page).length === 3, "everything built in");
  assert.deepEqual(posts(page)[2].body, { harness: null, codexPermissionPreset: null, claudePermissionMode: null, codexModel: null, codexReasoningEffort: null });
  assert.deepEqual(page.errors, []);
});

test("a default model the Core host no longer offers, or a catalog that can't be read, is said", async () => {
  const stale = mount((url) => (url.endsWith("/models") ? [200, { models: catalog }] : [200, modelView({ codexModel: "gone" })]));
  stale.window.renderDefaults();
  await until(() => /gone is no longer offered/.test(stale.document.body.textContent), "the stale default said");
  assert.ok([...select(stale, "Codex model for new Agents").options].some((o) => o.textContent.trim() === "gone (no longer offered)"));
  const broken = mount((url) => (url.endsWith("/models") ? [500, { error: "Codex is not signed in" }] : [200, modelView({})]));
  broken.window.renderDefaults();
  await until(() => /Couldn’t read this Core host’s Codex models: .*Codex is not signed in/.test(broken.document.body.textContent), "the catalog failure said");
});

const claudeCatalog = [
  { id: "sonnet", model: "sonnet", displayName: "Sonnet", supportsAutoMode: true },
  { id: "haiku", model: "haiku", displayName: "Haiku", supportsAutoMode: false },
];
const claudeView = (saved) => {
  const base = modelView(saved);
  return {
    ...base,
    builtIn: { ...base.builtIn, claudeModel: null },
    effective: { ...base.effective, claudeModel: { value: saved.claudeModel ?? null, source: saved.claudeModel ? "workspace" : "builtin" } },
  };
};
const claudeReads = (page) => page.calls.filter((c) => c.url.endsWith("/models?harness=claude")).length;

test("a default Claude Code model comes from the Core host's Claude catalog, read once its choice is opened, and only to a Core that has it", async () => {
  let saved = {};
  const page = mount((url, method, body) => {
    if (url.endsWith("/models?harness=claude")) return [200, { models: claudeCatalog }];
    if (url.endsWith("/models")) return [200, { models: catalog }];
    if (method === "POST") saved = Object.fromEntries(Object.entries({ ...saved, ...body }).filter(([, v]) => v !== null));
    return [200, claudeView(saved)];
  });
  page.window.renderDefaults();
  await until(() => select(page, "Codex model for new Agents")?.options.length === 3, "the editor with its Codex models");
  const text = () => page.document.querySelector("#settings-agent-defaults")?.textContent ?? "";
  assert.match(text(), /Built in: Claude Code’s own default/);
  assert.equal(claudeReads(page), 0, "Claude Code's catalog is not read until its choice is opened");
  select(page, "Claude Code model for new Agents").dispatchEvent(new page.window.FocusEvent("focusin", { bubbles: true }));
  await until(() => select(page, "Claude Code model for new Agents").options.length === 3, "Claude Code's models");
  const options = [...select(page, "Claude Code model for new Agents").options].map((o) => o.textContent.trim());
  assert.deepEqual(options, ["Built in · Claude Code’s own default", "Sonnet", "Haiku"]);
  await choose(page, "Claude Code model for new Agents", "haiku");
  assert.match(text(), /haiku can’t run in Auto mode/);
  await choose(page, "Claude Code model for new Agents", "sonnet");
  assert.doesNotMatch(text(), /can’t run in Auto mode/);
  button(page, "Save").click();
  await until(() => posts(page).length === 1 && /Set for this Workspace: sonnet\./.test(text()), "the saved model");
  assert.deepEqual(posts(page)[0].body, { claudeModel: "sonnet" }, "its own field; Codex's untouched");
  button(page, "Use built-in for all").click();
  await until(() => posts(page).length === 2, "everything built in");
  assert.deepEqual(posts(page)[1].body, { harness: null, codexPermissionPreset: null, claudePermissionMode: null, codexModel: null, codexReasoningEffort: null, claudeModel: null });
  assert.equal(claudeReads(page), 1);
  assert.deepEqual(page.errors, []);
});

test("a saved Claude Code model is checked at once: one no longer offered, or a catalog that can't be read, is said", async () => {
  const stale = mount((url) => (url.endsWith("/models?harness=claude") ? [200, { models: claudeCatalog }] : url.endsWith("/models") ? [200, { models: catalog }] : [200, claudeView({ claudeModel: "gone" })]));
  stale.window.renderDefaults();
  await until(() => /gone is no longer offered by this Core host’s Claude Code/.test(stale.document.body.textContent), "the stale default said");
  assert.ok([...select(stale, "Claude Code model for new Agents").options].some((o) => o.textContent.trim() === "gone (no longer offered)"));
  const broken = mount((url) => (url.endsWith("/models?harness=claude") ? [500, { error: "Claude Code is not signed in" }] : url.endsWith("/models") ? [200, { models: catalog }] : [200, claudeView({ claudeModel: "sonnet" })]));
  broken.window.renderDefaults();
  await until(() => /Couldn’t read this Core host’s Claude Code models: .*Claude Code is not signed in/.test(broken.document.body.textContent), "the catalog failure said");
  assert.equal(select(broken, "Claude Code model for new Agents").value, "sonnet", "the saved choice still shown");
});

test("a project's defaults in Chinese (T-189): inherited values and where they come from are worded, and so is a save; a language change keeps the choice and asks Core nothing", async () => {
  const workspace = { harness: "claude", claudePermissionMode: "auto" };
  let own = {};
  const page = mount((url, method, body) => {
    if (method === "POST") own = Object.fromEntries(Object.entries({ ...own, ...body }).filter(([, v]) => v !== null));
    return [200, projectView(workspace, own)];
  });
  page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
  page.window.renderProjectDefaults("p1");
  await until(() => select(page, "新 Agent 的 Harness"), "the project editor in Chinese");
  const section = (label) => page.document.querySelector(`[aria-label="${label}"]`);
  const options = (label) => [...select(page, label).options].map((o) => o.textContent.trim());
  assert.equal(section("此项目的新 Agent 默认值").querySelector("h3").textContent, "新 Agent 默认值");
  assert.match(section("此项目的新 Agent 默认值").textContent, /已为此 Workspace 设置：Claude Code。/);
  assert.deepEqual(options("新 Agent 的 Harness"), ["继承 · Claude Code（已为此 Workspace 设置）", "Codex", "Claude Code"]);
  assert.deepEqual(options("新 Agent 的 Codex 权限"), ["继承 · 请求批准（内置）", "跟随 Codex 配置", "请求批准", "替我批准", "完全访问"]);
  assert.deepEqual(options("新 Agent 的 Claude Code 权限"), ["继承 · 自动模式（已为此 Workspace 设置）", "操作前询问", "自动模式"]);
  await choose(page, "新 Agent 的 Codex 权限", "auto");
  button(page, "保存").click();
  await until(() => /已为此项目保存/.test(section("此项目的新 Agent 默认值").textContent), "the save, said in Chinese");
  assert.deepEqual(posts(page)[0].body, { codexPermissionPreset: "auto" }, "the same request as in English");
  const switchTo = (language) => {
    page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    page.window.dispatchEvent(new page.window.StorageEvent("storage", { key: "yuzuno.language" }));
  };
  // Changed in another window: the line about the save is worded again, nothing asked.
  const before = page.calls.length;
  switchTo("en");
  await until(() => select(page, "Harness for new Agents"), "English again");
  assert.match(section("New Agent defaults for this project").textContent, /Saved for this project/);
  assert.equal(select(page, "Codex permissions for new Agents").value, "auto");
  await choose(page, "Harness for new Agents", "codex");
  switchTo("zh-Hans");
  await until(() => select(page, "新 Agent 的 Harness"), "Chinese again");
  assert.equal(select(page, "新 Agent 的 Harness").value, "codex", "the unsaved choice stays");
  assert.ok(button(page, "保存"), "still to save");
  assert.equal(page.calls.length, before, "a language change reads and writes nothing");
  assert.deepEqual(page.errors, []);
});
