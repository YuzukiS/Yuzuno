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
const root = createRoot(document.getElementById('root'));
window.renderSettings = props => root.render(<SettingsCenter {...props} renderEditor={(id, visible, open, request) => id === 'home' ? <HomePresentationSettings active/> : <div>Existing {id} editor{request?.sub ? ' at ' + request.sub : ''}</div>}/>);
window.renderAgent = props => root.render(<AgentSettings {...props}/>);`);
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
function mount({ phone = false, languages } = {}) {
  const vc = new VirtualConsole();
  const errors = [], calls = [], destinations = [];
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, doc = w.document;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  // A phone's window (T-170) and the browser's language (T-189), as asked.
  w.matchMedia = (query) => ({ media: query, matches: phone, addEventListener() {}, removeEventListener() {} });
  if (languages) Object.defineProperty(w.navigator, "languages", { value: languages, configurable: true });
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
  const tab = (id) => doc.getElementById(`settings-tab-${id}`);
  const shown = () => [...doc.querySelectorAll(".settings-editor")].filter((el) => !el.hidden).map((el) => el.id);
  return { w, doc, calls, destinations, errors, props, button, type, tab, shown, close: () => w.close() };
}

test("eighteen pages in four groups and bilingual search expose real scope, without fake controls", async (t) => {
  const p = mount(); t.after(p.close); p.w.renderSettings(p.props);
  await until(() => p.doc.querySelector('[type="search"]'));
  assert.equal(p.doc.querySelectorAll('[role="tab"]').length, 18);
  const query = p.doc.querySelector('[type="search"]');
  for (const [term, title, scope] of [
    ["预算", "Core host Job budget", "Core execution machine"],
    ["默认目录", "Project directories, repositories & services", "Selected project"],
    ["自动继续", "Continue after Claude’s usage limit resets", "Scope: Selected local Claude Agent"],
    // Its Workspace default has its own editor, needing no Agent (T-190).
    ["自动继续", "Continue after a usage limit: Workspace default", "Scope: This Workspace · local Claude Agents without their own choice"],
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
      assert.equal(p.tab("phone").getAttribute("aria-selected"), "true");
    }
    if (term === "预算") {
      // The Core host budget has its own editor in Settings (T-55), not the Jobs panel.
      assert.doesNotMatch(card.textContent, /Unavailable here/, "the budget can be edited here");
      card.querySelector("button").click();
      const editor = await until(() => p.doc.querySelector("#settings-editor-jobs-budget:not([hidden])"));
      assert.equal(editor.textContent, "Existing jobs-budget editor", "the budget card opens its editor in place");
      assert.equal(p.tab("machines").getAttribute("aria-selected"), "true", "the budgets are on the Machines page");
      assert.equal(p.destinations.length, 0, "opening the budget leaves Settings for nothing else");
    }
  }
  p.type(query, "CONTEXT compaction");
  await until(() => p.doc.querySelectorAll('.settings-catalog-card').length === 1);
  assert.match(p.doc.querySelector('.settings-catalog-card').textContent, /Unknown native values stay unknown/);
  // While searching, no tab names a panel that isn't there (review e0111214).
  assert.equal(p.doc.querySelector("#settings-page"), null);
  assert.ok([...p.doc.querySelectorAll('[role="tab"]')].every((tab) => !tab.hasAttribute("aria-controls")));
  // An Agent's own setting is on no page of Settings: listed under Elsewhere.
  assert.ok(p.doc.querySelector('.settings-elsewhere .settings-catalog-card'), "an Agent's setting is under Elsewhere");
  assert.equal(p.doc.querySelector('#settings-elsewhere-title').textContent, "Elsewhere");
  assert.deepEqual([...p.doc.querySelectorAll('[role="tab"]')].map((tab) => tab.id), [], "no page has a match");
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
  assert.equal(p.tab("storage").getAttribute("aria-selected"), "true");
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
  const project = () => p.button("Open Project directories, repositories & services");
  assert.equal(project().disabled, true, "a project setting names its project first");
  p.type(select, "p2"); await until(() => !project().disabled);
  project().click();
  // Projects are a page of Settings now (YN-8): opened there, at the project chosen.
  await until(() => p.shown().join() === "settings-editor-projects");
  assert.equal(p.doc.getElementById("settings-editor-projects").textContent, "Existing projects editor at p2");
  assert.equal(p.tab("projects").getAttribute("aria-selected"), "true");
  assert.equal(p.destinations.length, 1, "nothing outside Settings is opened for a project");
  assert.equal(p.calls.length, 0);
});

test("keyboard navigation and search preserve a failed Home edit and move focus to its editor", async (t) => {
  const p = mount(); t.after(p.close); p.w.renderSettings(p.props);
  const tab = (id) => p.doc.getElementById(`settings-tab-${id}`);
  await until(() => tab("updates"));
  tab("updates").focus();
  p.doc.activeElement.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  await until(() => p.doc.activeElement.id === "settings-tab-appearance");
  p.doc.activeElement.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await until(() => p.doc.activeElement.id === "settings-tab-typing");
  assert.deepEqual(p.shown(), ["settings-editor-input", "settings-editor-time"], "a key moves to the page and shows it");
  // One list across the groups: up from the first page is the last.
  p.doc.activeElement.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  await until(() => p.doc.activeElement.id === "settings-tab-appearance");
  p.doc.activeElement.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  await until(() => p.doc.activeElement.id === "settings-tab-about");
  const query = p.doc.querySelector('[type="search"]');
  p.type(query, "Home presentation"); await until(() => p.button("Open Home presentation")); p.button("Open Home presentation").click();
  await until(() => p.doc.querySelector('[aria-label="Your note for Agents"]'));
  assert.equal(p.doc.activeElement.id, "settings-editor-home");
  const note = p.doc.querySelector('[aria-label="Your note for Agents"]'); p.type(note, "Keep this unsaved preference");
  await until(() => p.button("Save Home preference")); p.button("Save Home preference").click();
  await until(() => p.doc.querySelector('[role="alert"]'));
  // While searching, the sidebar keeps the pages that match (YN-8).
  p.type(query, "主页"); await until(() => p.doc.querySelector('#setting-home') && tab("home") && !tab("appearance"));
  tab("home").click();
  await until(() => !p.doc.getElementById('settings-editor-home').hidden);
  assert.equal(p.doc.querySelector('[aria-label="Your note for Agents"]').value, "Keep this unsaved preference");
  assert.match(p.doc.querySelector('[role="alert"]').textContent, /storage unavailable/);
  assert.equal(p.calls.filter((call) => call.url.endsWith('/home/presentation') && call.method === 'GET').length, 1);
});

// YN-8: one sidebar of pages in four groups; a page shows its editors, as
// they are, one after another; no entry row, no cards before them.
test("a page shows its editors directly, and each group names whose settings it lists", async (t) => {
  const p = mount(); t.after(p.close); p.w.renderSettings(p.props);
  const { tab, shown } = p;
  await until(() => tab("appearance"));
  const groups = [...p.doc.querySelectorAll('[role="tablist"]')];
  assert.deepEqual(groups.map((list) => p.doc.getElementById(list.getAttribute("aria-labelledby")).textContent), ["This device", "Workspace", "Data", "About"]);
  assert.deepEqual(groups.map((list) => [...list.querySelectorAll('[role="tab"]')].map((item) => item.id.replace("settings-tab-", ""))), [
    ["appearance", "typing", "language", "shortcuts", "notifications", "transfer"],
    ["projects", "machines", "agents", "executors", "home", "phone"],
    ["storage", "backup", "diagnostics"],
    ["updates", "runtime", "about"],
  ]);
  // Settings opens at Updates, as it did.
  assert.equal(tab("updates").getAttribute("aria-selected"), "true");
  assert.deepEqual(shown(), ["settings-editor-updates"]);
  assert.equal(tab("typing").querySelector(".settings-nav-label").textContent, "Typing & time");
  for (const [id, editors] of [
    ["typing", ["input", "time"]],
    ["agents", ["agent-defaults", "auto-continue", "review"]],
    ["machines", ["machines", "jobs-budget", "jobs-remote"]],
    ["storage", ["storage", "drafts", "history"]],
    ["notifications", ["notifications"]],
  ]) {
    tab(id).click();
    await until(() => shown().join() === editors.map((editor) => `settings-editor-${editor}`).join());
    assert.equal(tab(id).getAttribute("aria-selected"), "true");
    assert.equal(p.doc.getElementById("settings-page").getAttribute("aria-labelledby"), `settings-tab-${id}`);
    assert.equal(p.doc.querySelectorAll(".settings-catalog-card").length, 0, `no cards before ${id}'s editors`);
  }
  assert.equal(p.doc.querySelector(".settings-entries"), null, "no entry row");
  assert.equal(p.doc.querySelector(".settings-back"), null, "Back is a phone's");
  assert.equal(p.calls.length, 0);
  assert.deepEqual(p.errors, []);
});

test("a request opens its page, and an older caller's editor opens the page it is on, each once", async (t) => {
  const p = mount(); t.after(p.close);
  const { tab, shown } = p;
  // The rail's New project (YN-8): the Projects page, asked for a new one.
  p.w.renderSettings({ ...p.props, openAt: { page: "projects", sub: "new", nonce: 1 } });
  await until(() => shown().join() === "settings-editor-projects");
  // Opened at the page, the page has its request from the first render: built once.
  assert.equal(p.doc.getElementById("settings-editor-projects").textContent, "Existing projects editor at new");
  await until(() => p.doc.activeElement?.id === "settings-editor-projects");
  // The status bar's Machines.
  p.w.renderSettings({ ...p.props, openAt: { page: "machines", nonce: 2 } });
  await until(() => tab("machines").getAttribute("aria-selected") === "true");
  await until(() => p.doc.activeElement?.id === "settings-editor-machines");
  // An editor's name, as a notification's click gives it (T-196).
  p.w.renderSettings({ ...p.props, openAt: { editor: "time", nonce: 3 } });
  await until(() => tab("typing").getAttribute("aria-selected") === "true");
  await until(() => p.doc.activeElement?.id === "settings-editor-time");
  // A page keeps what it showed across tabs until a new request for it.
  tab("projects").click();
  await until(() => shown().join() === "settings-editor-projects");
  assert.equal(p.doc.getElementById("settings-editor-projects").textContent, "Existing projects editor at new");
  p.w.renderSettings({ ...p.props, openAt: { page: "projects", sub: "p1", nonce: 4 } });
  await until(() => p.doc.getElementById("settings-editor-projects").textContent === "Existing projects editor at p1");
  assert.equal(p.calls.length, 0, "opening a page reads or writes nothing by itself");
  assert.equal(p.destinations.length, 0);
  assert.deepEqual(p.errors, []);
});

test("a phone starts at the list of pages, a page has Back to it, and search runs from the list", async (t) => {
  const p = mount({ phone: true }); t.after(p.close); p.w.renderSettings(p.props);
  const { tab, shown } = p;
  const center = await until(() => p.doc.querySelector(".settings-center"));
  assert.match(center.className, /is-phone/);
  assert.match(center.className, /is-root/);
  assert.deepEqual(shown(), [], "no page is shown over the list");
  assert.ok([...p.doc.querySelectorAll('[role="tab"]')].every((item) => item.getAttribute("aria-selected") === "false"));
  tab("appearance").click();
  await until(() => shown().join() === "settings-editor-appearance");
  assert.doesNotMatch(center.className, /is-root/);
  assert.equal(tab("appearance").getAttribute("aria-selected"), "true");
  p.doc.querySelector(".settings-back").click();
  await until(() => /is-root/.test(center.className));
  assert.deepEqual(shown(), []);
  p.type(p.doc.querySelector('[type="search"]'), "预算");
  await until(() => p.doc.querySelector("#setting-budget"));
  assert.match(center.className, /is-searching/);
  assert.equal(p.doc.querySelector(".settings-back"), null, "the results have no Back: clearing the search returns");
  p.button("Open Core host Job budget").click();
  await until(() => shown().includes("settings-editor-jobs-budget"));
  assert.doesNotMatch(center.className, /is-root|is-searching/);
  assert.ok(p.doc.querySelector(".settings-back"));
  assert.equal(p.calls.length, 0);
  assert.deepEqual(p.errors, []);
});

test("the groups, pages and Elsewhere are in Chinese when this device shows Chinese", async (t) => {
  const p = mount({ languages: ["zh-CN"] }); t.after(p.close); p.w.renderSettings(p.props);
  const { tab } = p;
  await until(() => tab("typing"));
  assert.deepEqual([...p.doc.querySelectorAll(".settings-nav-heading")].map((h) => h.textContent), ["这台设备", "工作区", "数据", "关于"]);
  assert.equal(tab("typing").querySelector(".settings-nav-label").textContent, "输入与时间");
  assert.equal(tab("machines").querySelector(".settings-nav-label").textContent, "机器");
  p.type(p.doc.querySelector('[type="search"]'), "上下文");
  await until(() => p.doc.querySelector("#settings-elsewhere-title"));
  assert.equal(p.doc.querySelector("#settings-elsewhere-title").textContent, "在别处");
  assert.equal(p.doc.querySelector(".settings-center").getAttribute("lang"), "zh-Hans");
  assert.deepEqual(p.errors, []);
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

// T-55: the Jobs card's Edit in Settings opens Settings at the Core host
// budget; each request once, and nothing is written by opening it.
test("a request to open the Core host budget shows its editor focused, once per request, without writing", async (t) => {
  const p = mount(); t.after(p.close);
  const tab = (id) => p.doc.getElementById(`settings-tab-${id}`);
  const shown = () => [...p.doc.querySelectorAll(".settings-editor")].filter((el) => !el.hidden).map((el) => el.id);
  p.w.renderSettings({ ...p.props, openAt: { editor: "jobs-budget", nonce: 1 } });
  await until(() => shown().includes("settings-editor-jobs-budget"));
  assert.equal(tab("machines").getAttribute("aria-selected"), "true", "the budgets are on the Machines page");
  await until(() => p.doc.activeElement?.id === "settings-editor-jobs-budget");
  // Moved elsewhere, the same request is not replayed; a new one opens it again.
  tab("updates").click();
  await until(() => shown().join() === "settings-editor-updates");
  p.w.renderSettings({ ...p.props, openAt: { editor: "jobs-budget", nonce: 1 } });
  await tick();
  assert.deepEqual(shown(), ["settings-editor-updates"], "a request already used is not replayed");
  p.w.renderSettings({ ...p.props, openAt: { editor: "jobs-budget", nonce: 2 } });
  await until(() => shown().includes("settings-editor-jobs-budget"));
  await until(() => p.doc.activeElement?.id === "settings-editor-jobs-budget");
  assert.equal(p.calls.length, 0, "opening the editor reads or writes nothing by itself");
  assert.equal(p.destinations.length, 0, "nothing outside Settings is opened");
  assert.deepEqual(p.errors, [], "no page errors");
});
