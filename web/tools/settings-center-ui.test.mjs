import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(root, ".settings-test-"));
let bundle;
try {
  const entry = path.join(temporary, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {SettingsCenter} from ${JSON.stringify(path.join(root, "src/SettingsCenter.tsx"))};
import {HomePresentationSettings} from ${JSON.stringify(path.join(root, "src/HomePresentationSettings.tsx"))};
import {AgentSettings} from ${JSON.stringify(path.join(root, "src/AgentSettings.tsx"))};
import {BudgetSettings} from ${JSON.stringify(path.join(root, "src/JobBudget.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderSettings = props => root.render(<SettingsCenter {...props} renderEditor={id => id === 'home' ? <HomePresentationSettings active/> : <div>Existing {id} editor</div>}/>);
window.renderAgent = props => root.render(<AgentSettings {...props}/>);
window.renderBudget = props => root.render(<BudgetSettings {...props}/>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { write: false, lib: { entry, name: "SettingsTest", formats: ["iife"] } } });
  bundle = (Array.isArray(built) ? built[0] : built).output.find((item) => item.type === "chunk").code;
} finally { await rm(temporary, { recursive: true, force: true }); }

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(check) {
  for (let n = 0; n < 200; n++) { const result = check(); if (result) return result; await tick(); }
  assert.fail("Expected settings state did not appear");
}
const agents = [
  { id: "codex-one", name: "Cedar", harness: "codex", model: "fixture-model", settings: {} },
  { id: "codex-two", name: "Pine", harness: "codex", model: "fixture-model", settings: {} },
  { id: "claude-one", name: "Maple", harness: "claude" },
  { id: "remote", name: "Remote", harness: "claude", remote: { machine: { name: "Remote host" } } },
  { id: "closed", name: "Closed", harness: "codex", closedAt: "2026-01-01" },
  { id: "opencode", name: "OpenCode", harness: "opencode" },
];
const projects = [{ id: "p1", name: "Garden" }, { id: "p2", name: "Orchard" }, { id: "old", name: "Archive", archivedAt: "2026-01-01" }];
function mount() {
  const vc = new VirtualConsole();
  const errors = [], calls = [], destinations = [];
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, doc = w.document;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    const failed = init.method === "PUT";
    const value = failed ? { error: "Fixture storage unavailable" } : String(url).endsWith("/models")
      ? { models: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture", supportedReasoningEfforts: [] }], context: { supported: true, canApply: false, observedWindowTokens: null } }
      : { style: "default", note: "", updatedAt: null, scope: "workspace", agentText: null };
    return { ok: !failed, status: failed ? 503 : 200, json: async () => value, text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  const props = { attention: false, navigation: { agents, projects, onNavigate: (destination) => destinations.push(destination) } };
  const button = (text) => [...doc.querySelectorAll("button")].find((item) => item.textContent.trim() === text);
  function type(element, value) {
    const prototype = element.tagName === "TEXTAREA" ? w.HTMLTextAreaElement.prototype : element.tagName === "SELECT" ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new w.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  }
  return { w, doc, calls, destinations, errors, props, button, type, close: () => w.close() };
}

test("eight categories and bilingual search expose real scope, without fake controls", async (t) => {
  const p = mount(); t.after(p.close); p.w.renderSettings(p.props);
  await until(() => p.doc.querySelector('[type="search"]'));
  assert.equal(p.doc.querySelectorAll('[role="tab"]').length, 8);
  const query = p.doc.querySelector('[type="search"]');
  for (const [term, title, scope] of [
    ["预算", "Core host Job budget", "Core execution machine"],
    ["默认目录", "Project directories, repositories & services", "Selected project"],
    ["自动继续", "Continue after Claude’s usage limit resets", "Workspace default"],
    ["上下文", "Context window & compaction", "Selected Codex Agent"],
    ["手机访问", "Phone & remote access", "Workspace service"],
  ]) {
    p.type(query, term);
    const card = await until(() => [...p.doc.querySelectorAll('.settings-catalog-card')].find((item) => item.querySelector('h4')?.textContent === title));
    assert.match(card.textContent, new RegExp(scope));
    if (term === "手机访问") {
      // Phone access has its own editor (T-185); the card opens it in place.
      assert.doesNotMatch(card.textContent, /Unavailable here/);
      card.querySelector("button").click();
      const editor = await until(() => p.doc.querySelector("#settings-editor-remote:not([hidden])"));
      assert.equal(editor.textContent, "Existing remote editor");
      assert.equal(p.doc.querySelector("#settings-tab-connections").getAttribute("aria-selected"), "true");
    }
  }
  p.type(query, "CONTEXT compaction");
  await until(() => p.doc.querySelectorAll('.settings-catalog-card').length === 1);
  assert.match(p.doc.querySelector('.settings-catalog-card').textContent, /Unknown native values stay unknown/);
  p.type(query, "no-such-setting");
  await until(() => p.doc.querySelector('[role="status"]')?.textContent.includes("No matching"));
  assert.equal(p.calls.length, 0, "catalog browsing does not read or write settings");
  assert.deepEqual(p.errors, []);
});

test("the data & storage overview is found with its scope and opened in place, reading nothing while browsing", async (t) => {
  const p = mount(); t.after(p.close); p.w.renderSettings(p.props);
  await until(() => p.doc.querySelector('[type="search"]'));
  p.type(p.doc.querySelector('[type="search"]'), "存储 占用");
  const card = await until(() => [...p.doc.querySelectorAll(".settings-catalog-card")].find((item) => item.querySelector("h4")?.textContent === "Data & storage overview"));
  assert.match(card.textContent, /Scope: This device · Workspace service · native CLIs/);
  assert.doesNotMatch(card.textContent, /Unavailable here/);
  card.querySelector("button").click();
  const editor = await until(() => p.doc.querySelector("#settings-editor-storage:not([hidden])"));
  assert.equal(editor.textContent, "Existing storage editor");
  assert.equal(p.doc.querySelector("#settings-tab-data").getAttribute("aria-selected"), "true");
  assert.equal(p.calls.length, 0, "browsing the catalog reads nothing");
});

test("Workspace backup & restore opens its editor from search, not a fake control (T-192)", async (t) => {
  const p = mount(); t.after(p.close); p.w.renderSettings(p.props);
  await until(() => p.doc.querySelector('[type="search"]'));
  p.type(p.doc.querySelector('[type="search"]'), "备份");
  const card = await until(() => [...p.doc.querySelectorAll('.settings-catalog-card')].find((item) => item.querySelector('h4')?.textContent === "Workspace backup & restore"));
  assert.doesNotMatch(card.textContent, /Unavailable here/);
  assert.match(card.textContent, /never in a backup/);
  p.button("Open Workspace backup & restore").click();
  await until(() => p.doc.body.textContent.includes("Existing backup editor"));
  assert.equal(p.calls.length, 0, "opening the entry reads or writes nothing by itself");
  assert.deepEqual(p.errors, []);
});

test("object routes never default to the first Agent or project and reject a removed object", async (t) => {
  const p = mount(); t.after(p.close); p.w.renderSettings(p.props);
  await until(() => p.doc.querySelector('[type="search"]'));
  const query = p.doc.querySelector('[type="search"]');
  p.type(query, "上下文");
  let select = await until(() => p.doc.querySelector('.settings-catalog select'));
  assert.deepEqual([...select.options].map((o) => o.value), ["", "codex-one", "codex-two"]);
  const open = () => p.button("Open Context window & compaction");
  assert.equal(open().disabled, true);
  p.type(select, "codex-two"); await until(() => !open().disabled); open().click();
  assert.deepEqual(JSON.parse(JSON.stringify(p.destinations)), [{ kind: "agent", section: "context", agentId: "codex-two" }]);
  p.w.renderSettings({ ...p.props, navigation: { ...p.props.navigation, agents: agents.filter((a) => a.id !== "codex-two") } });
  await until(() => open().disabled); open().click(); assert.equal(p.destinations.length, 1);
  p.type(query, "自动继续"); select = await until(() => p.doc.querySelector('select[aria-label*="usage limit"]'));
  assert.deepEqual([...select.options].map((o) => o.value), ["", "claude-one"]);
  p.type(query, "默认目录"); select = await until(() => p.doc.querySelector('select[aria-label$="project"]'));
  assert.deepEqual([...select.options].map((o) => o.value), ["", "p1", "p2"]);
  p.type(select, "p2"); await until(() => !p.button("Open Project directories, repositories & services").disabled);
  p.button("Open Project directories, repositories & services").click();
  assert.deepEqual(JSON.parse(JSON.stringify(p.destinations[1])), { kind: "project", projectId: "p2" });
  assert.equal(p.calls.length, 0);
});

test("keyboard navigation and search preserve a failed Home edit and move focus to its editor", async (t) => {
  const p = mount(); t.after(p.close); p.w.renderSettings(p.props);
  await until(() => p.button("Updates & about"));
  p.button("Updates & about").focus();
  p.doc.activeElement.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  await until(() => p.doc.activeElement.id === "settings-tab-appearance");
  p.doc.activeElement.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await until(() => p.doc.activeElement.id === "settings-tab-notifications");
  const query = p.doc.querySelector('[type="search"]');
  p.type(query, "Home presentation"); await until(() => p.button("Open Home presentation")); p.button("Open Home presentation").click();
  await until(() => p.doc.querySelector('[aria-label="Your note for Agents"]'));
  assert.equal(p.doc.activeElement.id, "settings-editor-home");
  const note = p.doc.querySelector('[aria-label="Your note for Agents"]'); p.type(note, "Keep this unsaved preference");
  await until(() => p.button("Save Home preference")); p.button("Save Home preference").click();
  await until(() => p.doc.querySelector('[role="alert"]'));
  p.type(query, "预算"); await until(() => p.doc.querySelector('#setting-budget'));
  p.button("Projects & collaboration").click(); await until(() => p.button("Open Home presentation")); p.button("Open Home presentation").click();
  await until(() => !p.doc.getElementById('settings-editor-home').hidden);
  assert.equal(p.doc.querySelector('[aria-label="Your note for Agents"]').value, "Keep this unsaved preference");
  assert.match(p.doc.querySelector('[role="alert"]').textContent, /storage unavailable/);
  assert.equal(p.calls.filter((call) => call.url.endsWith('/home/presentation') && call.method === 'GET').length, 1);
});

test("a targeted context request survives the selected Agent mounting, without a save or Apply", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderAgent({ agent: agents[1], onSaved() { assert.fail("navigation must not save"); }, request: { agentId: "codex-two", model: "", section: "context", nonce: 1 } });
  await until(() => p.doc.querySelector('[role="dialog"]'));
  await until(() => p.doc.activeElement.classList.contains('codex-context-settings'));
  assert.match(p.doc.querySelector('[role="dialog"]').textContent, /Pine · Agent settings/);
  assert.ok(p.calls.every((call) => call.method === "GET"));
  assert.ok(p.calls.every((call) => call.url.includes('/agents/codex-two/')));
});

test("a budget navigation request expands the unique budget editor without writing", async (t) => {
  const p = mount(); t.after(p.close);
  let handled = 0;
  p.w.renderBudget({ budget: { cpuMillis: 2000, memoryMiB: 4096, swapMiB: 0 }, openRequest: 1, onOpenRequestHandled() { handled++; }, onSaved() {} });
  await until(() => p.doc.querySelector('details')?.open);
  assert.equal(p.doc.activeElement.tagName, 'SUMMARY');
  assert.equal(handled, 1, 'the parent consumes the request after it is used');
  assert.equal(p.calls.length, 0);
});
