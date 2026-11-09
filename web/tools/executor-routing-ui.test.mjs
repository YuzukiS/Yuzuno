// YN-49 S4a: Settings → Executor routing, the candidate order. The whole
// policy is saved through the page's save bar against the version read; a
// newer version is shown and never overwritten unasked; a field Core refuses
// is marked where it is; fields this version doesn't know go back as they came.
// Fixture HTTP only, shaped as YN-34 S3 answers (docs/executor-routing.md); no Core.
import "./jsdom-guard.mjs";
import test, { after } from "node:test";
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
const fixture = await mkdtemp(path.join(cache, "executor-routing-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ExecutorRouting} from ${src("ExecutorRouting.tsx")};
import {SaveBarScope} from ${src("SettingsSaveBar.tsx")};
const root=createRoot(document.getElementById('root'));
window.renderRouting=(active=true)=>root.render(<SaveBarScope><ExecutorRouting active={active}/></SaveBarScope>);`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "ExecutorRoutingUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function until(check, what, ms = 3000) {
  const deadline = Date.now() + ms;
  // A check that reads what is not drawn yet waits for it, rather than throwing.
  const holds = () => { try { return check(); } catch { return false; } };
  while (!holds()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const PEAK = { timeZone: "UTC", slots: [{ days: [1, 2, 3, 4, 5], from: "01:00", to: "04:00" }, { days: [1, 2, 3, 4, 5], from: "06:00", to: "10:00" }] };
const EMAIL = "someone@example.test";
const clone = (v) => JSON.parse(JSON.stringify(v));
// What a Core keeps, with fields from a later Core on the policy, a candidate and a condition, and a condition of a later kind.
const ds = { id: "ds", enabled: true, harness: "opencode", model: "deepseek/deepseek-flash", credential: { kind: "apiKey", keyId: "deepseek-main" },
  conditions: [{ kind: "timeWindow", inside: false, schedule: PEAK, minMinutesLeft: 30 }, { kind: "dailyApiCap", usd: 5 }, { kind: "laterKind", x: 1 }],
  unknown: "skip", note: "from a later Core" };
const cl = { id: "cl", enabled: true, harness: "claude", model: "opus", credential: { kind: "pool", manager: "cswap", accounts: "all", pick: "mostRemaining" },
  conditions: [{ kind: "quota", fiveHourLeftPct: 15, weekLeftPct: 10, later: true }], unknown: "skip" };
const savedView = (over = {}) => ({ version: 3, updatedAt: "2026-11-08T04:00:00Z", limits: { candidates: 8 },
  policy: { enabled: true, whenNone: "wait", dailyApiCapUsd: 20, futureFlag: "kept", candidates: [clone(ds), clone(cl)] }, ...over });

/** The Workspace's keys as Core lists them: never a value. */
const KEYS = [
  { id: "deepseek-main", provider: "deepseek", source: "local", set: true, setAt: "2026-11-08T03:00:00Z" },
  { id: "anthropic", provider: "anthropic", source: "1password", set: true, setAt: "2026-11-08T03:00:00Z", reference: "op://Vault/Anthropic/credential" },
];
/** Each tool's list as Core answers it (YN-57 S2b): Claude Code's CLI aliases and what each points to now, Codex's
 * model/list, and OpenCode's as a new executor lists them (docs/executor-routing.md). */
const CATALOGS = {
  claude: { models: [
    { id: "default", model: "default", displayName: "Default (recommended)", resolvedModel: "claude-opus-5-5" },
    { id: "opus", model: "opus", displayName: "Opus", resolvedModel: "claude-opus-5-5" },
    { id: "sonnet", model: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5-5" },
    { id: "haiku", model: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-5-5" },
  ] },
  codex: { models: [
    { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
    { id: "gpt-6.1-sol-mini", model: "gpt-6.1-sol-mini", displayName: "GPT-6.1 Sol Mini" },
    { id: "gpt-old", model: "gpt-old", displayName: "Old", hidden: true },
  ] },
  opencode: { opencode: { version: "2.2.5", verified: "2.2.5" }, models: [
    { id: "anthropic/claude-x", model: "anthropic/claude-x", providerId: "anthropic", providerName: "Anthropic", name: "Claude X", displayName: "Anthropic · Claude X" },
    { id: "deepseek/deepseek-flash", model: "deepseek/deepseek-flash", providerId: "deepseek", providerName: "DeepSeek", name: "DeepSeek Flash", displayName: "DeepSeek · DeepSeek Flash" },
    { id: "deepseek/deepseek-v4-pro", model: "deepseek/deepseek-v4-pro", providerId: "deepseek", providerName: "DeepSeek", name: "DeepSeek V4 Pro", displayName: "DeepSeek · DeepSeek V4 Pro" },
    { id: "opencode/big-pickle", model: "opencode/big-pickle", providerId: "opencode", providerName: "OpenCode", name: "Big Pickle", displayName: "OpenCode · Big Pickle" },
  ], providers: [
    { id: "anthropic", name: "Anthropic", source: "routingKey", keyProvider: "anthropic" },
    { id: "deepseek", name: "DeepSeek", source: "routingKey", keyProvider: "deepseek" },
    { id: "opencode", name: "OpenCode", source: "ready" },
  ] },
};

/** Core as S1 and S3 answer it. `put` decides a save's answer; the default keeps it. `lists` answers a tool's list
 * instead of CATALOGS: `(harness, n)` with n its nth ask, giving `[status, body]` or nothing for the default. */
function core({ view = savedView(), put, lists, keys = KEYS } = {}) {
  const state = { view, asked: { claude: 0, codex: 0, opencode: 0 }, keys: keys && clone(keys) };
  return { state, route(url, method, body) {
    const u = new URL(url, "http://isolated.test");
    const p = u.pathname;
    const harness = p === "/api/models" ? (u.searchParams.get("harness") ?? "codex") : p === "/api/routing/models" ? u.searchParams.get("harness") : null;
    if (harness && method === "GET") {
      const n = ++state.asked[harness];
      return lists?.(harness, n) ?? [200, clone(CATALOGS[harness])];
    }
    if (p === "/api/routing/policy" && method === "GET") return [200, state.view];
    if (p === "/api/routing/policy" && method === "PUT") {
      const answer = put?.(body, state);
      if (answer) return answer;
      if (body.expectedVersion !== state.view.version) return [409, { code: "version_conflict", error: "version_conflict", current: state.view }];
      state.view = { ...state.view, version: state.view.version + 1, policy: body.policy, updatedAt: "2026-11-08T05:00:00Z" };
      return [200, state.view];
    }
    // Keys that can't be read here (null): as Core refuses them off its own address.
    if (p === "/api/routing/keys") return state.keys ? [200, { keys: state.keys, onePasswordToken: { set: true } }] : [403, { error: "Only from Core's own address" }];
    // A key kept (S1's write, YN-57 S3): the answer says only that it is set.
    const key = p.match(/^\/api\/routing\/keys\/([^/]+)$/);
    if (key && method === "PUT") {
      const kept = { id: decodeURIComponent(key[1]), provider: body.provider, source: body.source, set: true, setAt: "2026-11-09T01:00:00Z",
        ...(body.reference ? { reference: body.reference } : {}) };
      state.keys = [...state.keys.filter((k) => k.id !== kept.id), kept];
      return [200, kept];
    }
    if (p === "/api/routing/accounts") return [200, { cswap: { command: "cswap", pinned: "1.0.0", accounts: [
      { number: 1, fingerprint: "a1b2c3d4e5f60718", active: true, label: EMAIL },
      { number: 2, fingerprint: "0f1e2d3c4b5a6978", active: false, label: "fixture-alias-label" },
      { number: 3, fingerprint: "9a8b7c6d5e4f3021", active: false, label: "other@example.test" },
    ] }, codexHomes: [{ id: "work", label: "Work", home: "/home/fixture/.codex-work" }] }];
    return [404, { error: `not answered: ${method} ${p}` }];
  } };
}

// The live view refreshes every minute (S4b): each window is closed after the
// file's tests, so its timers don't keep the process running.
const windows = [];
after(() => { for (const window of windows) window.close(); });
function mount(server, language) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  windows.push(window);
  if (language) window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const body = init.body && JSON.parse(init.body);
    calls.push({ url, method, body });
    const [status, value] = await server.route(url, method, body);
    return { ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) };
  };
  window.eval(bundle);
  window.renderRouting();
  return { window, document: window.document, calls, errors };
}
const cards = (page) => [...page.document.querySelectorAll(".routing-cand")];
const titles = (page) => cards(page).map((c) => c.querySelector(".routing-cand-title > span").textContent);
const chips = (card) => [...card.querySelectorAll(".routing-chip")].map((c) => c.textContent);
const card = (page, id) => page.document.querySelector(`.routing-cand[data-cand="${id}"]`);
const button = (page, label, within = page.document) =>
  [...within.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
const bar = (page) => page.document.querySelector(".settings-savebar");
const puts = (page) => page.calls.filter((c) => c.method === "PUT");
async function set(page, node, value) {
  assert.ok(node, "the field");
  const proto = node.tagName === "SELECT" ? page.window.HTMLSelectElement.prototype : page.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
  node.dispatchEvent(new page.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  await tick();
}
/** A field of an open candidate's editor, by its label's words. */
const editorField = (page, id, label) => [...card(page, id).querySelectorAll(".routing-edit .routing-field")]
  .find((l) => l.querySelector(":scope > span")?.textContent === label)?.querySelector("input, select");
const byLabel = (page, label) => page.document.querySelector(`[aria-label="${label}"]`);
async function opened(page) {
  await until(() => cards(page).length > 0, "the candidates");
  await until(() => ["/routing/keys", "/routing/accounts"].every((path) => page.calls.some((c) => c.url.endsWith(path))), "the keys and accounts asked for");
  await tick();
  await tick();
}
async function save(page, words = "Save") {
  // The bar's Save appears once the change has joined it (an effect after the render).
  await until(() => { const b = button(page, words, bar(page)); return b && !b.disabled; }, "Save ready");
  button(page, words, bar(page)).click();
  await tick();
}

test("the saved order with its chips; a move by the arrows saved whole against the version read, unknown fields kept", async () => {
  const server = core();
  const page = mount(server);
  await opened(page);
  assert.deepEqual(titles(page), ["OpenCode · deepseek-flash", "Claude Code · opus"]);
  assert.deepEqual(cards(page).map((c) => c.querySelector(".routing-num").textContent), ["1", "2"]);
  assert.deepEqual(chips(card(page, "ds")), ["DeepSeek off-peak · at least 30 min before peak", "Today ≤ $5", "A condition this version can't show (laterKind)"]);
  assert.deepEqual(chips(card(page, "cl")), ["5-hour left ≥ 15% · week left ≥ 10%", "The account with most left", "Skipped when a reading is unavailable"]);
  assert.equal(card(page, "ds").querySelector(".routing-cand-sub").textContent.trim(), "API key: DeepSeek · this host");
  assert.equal(page.document.querySelector(".settings-current").textContent, "version 3");
  assert.equal(bar(page).hidden, true, "nothing to save yet");
  const colour = card(page, "ds").style.getPropertyValue("--cc");
  button(page, "Move OpenCode · deepseek-flash · API down").click();
  await tick();
  assert.deepEqual(titles(page), ["Claude Code · opus", "OpenCode · deepseek-flash"]);
  assert.equal(card(page, "ds").style.getPropertyValue("--cc"), colour, "its colour moves with it");
  assert.equal(card(page, "ds").querySelector(".routing-num").textContent, "2", "its number is its place");
  assert.match(bar(page).textContent, /1 change not saved/);
  await save(page);
  await until(() => /All changes saved/.test(bar(page).textContent), "saved");
  const sent = puts(page)[0].body;
  const policy = clone(savedView().policy);
  assert.deepEqual(sent, { expectedVersion: 3, policy: { ...policy, candidates: [policy.candidates[1], policy.candidates[0]] } }, "the whole policy, as it came but for the order");
  assert.equal(page.document.querySelector(".settings-current").textContent, "version 4");
  assert.ok(!page.document.documentElement.outerHTML.includes(EMAIL), "no account label or email in the page");
  assert.deepEqual(page.errors, []);
});

test("a handle's arrow keys move its candidate, say where to, and keep the focus on it", async () => {
  const page = mount(core());
  await opened(page);
  const grip = card(page, "ds").querySelector(".routing-grip");
  assert.equal(grip.getAttribute("aria-label"), "Reorder OpenCode · deepseek-flash · API: drag, or press the up and down arrow keys");
  grip.focus();
  grip.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await tick();
  assert.deepEqual(titles(page), ["Claude Code · opus", "OpenCode · deepseek-flash"]);
  assert.equal(page.document.querySelector('[aria-live="polite"]').textContent, "OpenCode · deepseek-flash · API moved to place 2");
  assert.equal(page.document.activeElement, card(page, "ds").querySelector(".routing-grip"), "the focus stays on the moved handle");
  card(page, "ds").querySelector(".routing-grip").dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await tick();
  assert.deepEqual(titles(page), ["Claude Code · opus", "OpenCode · deepseek-flash"], "the last stays last");
});

test("a new candidate: tool, model, effort, a Codex account and a condition; what can't be saved holds the bar", async () => {
  const page = mount(core());
  await opened(page);
  button(page, "Add a candidate").click();
  await until(() => cards(page).length === 3 && cards(page)[2].querySelector(".routing-edit"), "the new candidate's editor");
  const id = cards(page)[2].dataset.cand;
  assert.match(id, /^c-[0-9a-z]{6}$/);
  assert.equal(titles(page)[2], "Claude Code · sonnet");
  assert.equal(editorField(page, id, "Reasoning effort"), undefined, "a reasoning effort is Codex's only");
  await set(page, editorField(page, id, "Tool"), "codex");
  assert.equal(editorField(page, id, "Model").value, "gpt-6.1-sol", "a tool's first model");
  await set(page, editorField(page, id, "Reasoning effort"), "high");
  const credentials = [...editorField(page, id, "Account or key").options].map((o) => o.textContent);
  assert.deepEqual(credentials, ["This host's login (ChatGPT subscription)", "Codex account: Work", "Add an API key for OpenAI…"],
    "Codex takes its homes and an OpenAI key; no Anthropic or DeepSeek key");
  await set(page, editorField(page, id, "Account or key"), "home:work");
  button(page, "Subscription left", card(page, id)).click();
  await tick();
  // A model the list lacks: Other, then typed (YN-57 S2b).
  await set(page, editorField(page, id, "Model"), " other");
  await set(page, byLabel(page, "Model, typed"), "gpt 6.1");
  assert.ok(card(page, id).textContent.includes("A model is one name, without spaces."), "as Core's check would refuse it");
  assert.match(bar(page).textContent, /Correct the marked block to save/);
  assert.equal(button(page, "Save", bar(page)).disabled, true);
  await set(page, byLabel(page, "Model, typed"), "gpt-6.1-sol");
  await save(page);
  await until(() => puts(page).length === 1, "the save");
  assert.deepEqual(puts(page)[0].body.policy.candidates[2], { id, enabled: true, harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "high",
    credential: { kind: "codexHome", id: "work" }, conditions: [{ kind: "quota", fiveHourLeftPct: 15, weekLeftPct: 10 }], unknown: "skip" });
});

test("a newer version is shown and not overwritten; saving over it takes a choice and a Save", async () => {
  const newer = { version: 5, updatedAt: "2026-11-08T04:30:00Z", limits: { candidates: 8 }, policy: { enabled: true, whenNone: "wait", candidates: [clone(cl)] } };
  const server = core({ put: (body, state) => (body.expectedVersion === 3 ? (state.view = newer, [409, { code: "version_conflict", error: "version_conflict: the routing changed", current: newer }]) : null) });
  const page = mount(server);
  await opened(page);
  button(page, "Move OpenCode · deepseek-flash · API down").click();
  await save(page);
  await until(() => page.document.querySelector(".routing-conflict"), "the newer version");
  const conflict = page.document.querySelector(".routing-conflict");
  assert.match(conflict.textContent, /A newer version \(5, saved .*\) is in Core\. Nothing was overwritten; your changes are still here\./);
  assert.deepEqual([...conflict.querySelectorAll("li")].map((li) => li.textContent), ["Claude Code · opus"]);
  assert.deepEqual(titles(page), ["Claude Code · opus", "OpenCode · deepseek-flash"], "my order is still on the page");
  assert.equal(puts(page).length, 1, "one save, refused");
  assert.equal(button(page, "Save", bar(page)).disabled, true, "no blind second save");
  button(page, "Keep mine, to save over it", conflict).click();
  await tick();
  assert.ok(!page.document.querySelector(".routing-conflict"));
  assert.equal(puts(page).length, 1, "keeping mine saves nothing by itself");
  await save(page);
  await until(() => puts(page).length === 2 && /All changes saved/.test(bar(page).textContent), "the save over it");
  assert.equal(puts(page)[1].body.expectedVersion, 5);
  assert.deepEqual(puts(page)[1].body.policy.candidates.map((c) => c.id), ["cl", "ds"]);
  assert.equal(page.document.querySelector(".settings-current").textContent, "version 6");
});

test("Use the saved version takes the newer one in place of the changes", async () => {
  const newer = { version: 5, limits: { candidates: 8 }, policy: { enabled: false, whenNone: "wait", candidates: [clone(cl)] } };
  const page = mount(core({ put: () => [409, { code: "version_conflict", error: "version_conflict", current: newer }] }), "zh-Hans");
  await opened(page);
  button(page, "下移 OpenCode · deepseek-flash · API").click();
  await save(page, "保存");
  await until(() => page.document.querySelector(".routing-conflict"), "the newer version");
  assert.match(page.document.querySelector(".routing-conflict").textContent, /Core 里有更新的版本（5）。什么都没有被覆盖，你的改动还在这里。路由关着。/);
  button(page, "用保存的版本").click();
  await tick();
  assert.deepEqual(titles(page), ["Claude Code · opus"]);
  assert.equal(page.document.querySelector(".settings-current").textContent, "版本 5");
  assert.equal(bar(page).hidden, true, "no change left");
});

test("a field Core refuses is marked where it is, in the page's language", async () => {
  const page = mount(core({ put: () => [400, { code: "invalid", error: "usd must be above 0", path: "candidates[1].conditions[0].usd" }] }), "zh-Hans");
  await opened(page);
  await set(page, byLabel(page, "所有 API key 合计每天最多 $"), "30");
  await save(page, "保存");
  await until(() => page.document.querySelector(".routing-refused"), "the refusal");
  assert.equal(page.document.querySelector(".routing-refused").textContent, "Core 不接受第 2 项的第 1 个条件： usd must be above 0");
  assert.ok(card(page, "cl").classList.contains("is-refused") && card(page, "cl").querySelector(".routing-edit"), "its candidate opened");
  assert.ok(card(page, "cl").querySelector(".routing-cond").classList.contains("is-refused"), "its condition marked");
  assert.match(bar(page).textContent, /1 处更改没有保存/);
});

test("the preset 「闲时 DeepSeek 优先」 replaces the list once confirmed, with the Workspace's keys", async () => {
  const page = mount(core(), "zh-Hans");
  await opened(page);
  button(page, "闲时 DeepSeek 优先").click();
  await tick();
  assert.match(page.document.querySelector(".settings-confirm").textContent, /用「闲时 DeepSeek 优先」替换现在的列表？/);
  assert.deepEqual(titles(page), ["OpenCode · deepseek-flash", "Claude Code · opus"], "nothing replaced before it is confirmed");
  button(page, "替换").click();
  await tick();
  assert.deepEqual(titles(page), ["OpenCode · deepseek-flash", "Claude Code · opus", "Codex · gpt-6.1-sol", "Claude Code · opus", "Codex · gpt-6.1-sol"]);
  assert.deepEqual(chips(cards(page)[0]), ["DeepSeek 闲时 · 离高峰至少 30 分钟", "今日本项 ≤ $5"]);
  // No OpenAI key in this Workspace: its candidate says so, and holds the save until it has one or goes (Core refuses a key not set).
  assert.match(cards(page)[4].querySelector(".routing-cand-sub").textContent, /API key openai · 还没添加/, "a provider without a key says so");
  assert.equal(cards(page)[4].querySelector(".routing-fix")?.textContent, "需要修改", "marked to fix");
  await until(() => button(page, "保存", bar(page)), "the bar");
  assert.equal(button(page, "保存", bar(page)).disabled, true, "held while a key is missing");
  button(page, `编辑 Codex · gpt-6.1-sol · API`).click();
  await until(() => cards(page)[4].querySelector(".routing-edit"), "its editor");
  assert.match(cards(page)[4].querySelector(".routing-edit").textContent, /还没有 key openai：在下面的「账号和密钥」里添加，或换一个。/);
  button(page, "删除这一项", cards(page)[4]).click();
  await tick();
  await save(page, "保存");
  await until(() => puts(page).length === 1, "the save");
  const sent = puts(page)[0].body.policy.candidates;
  assert.deepEqual(sent.map((c) => c.credential), [
    { kind: "apiKey", keyId: "deepseek-main" }, { kind: "pool", manager: "cswap", accounts: "all", pick: "mostRemaining" }, { kind: "login" },
    { kind: "apiKey", keyId: "anthropic" }]);
  assert.deepEqual(sent[0].conditions[0], { kind: "timeWindow", inside: false, schedule: PEAK, minMinutesLeft: 30 });
  assert.equal(new Set(sent.map((c) => c.id)).size, 4, "each its own id");
});

/** An open editor's model select: its groups and options as shown, and the line under it. */
function modelView(page, id) {
  const select = card(page, id).querySelector(".routing-edit .routing-model select");
  const field = select.closest(".routing-model");
  return {
    select,
    value: select.value,
    groups: [...select.querySelectorAll("optgroup")].map((g) => g.label),
    options: [...select.options].map((o) => o.textContent),
    grouped: Object.fromEntries([...select.querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.value)])),
    notes: [...field.querySelectorAll(".routing-model-note")].map((n) => n.textContent.replace(/\s+/g, " ").trim()),
  };
}
const asks = (page) => page.calls.filter((c) => /\/api\/(routing\/)?models/.test(c.url)).map((c) => new URL(c.url, "http://isolated.test").pathname + new URL(c.url, "http://isolated.test").search);

test("Claude Code's model is chosen from its CLI's aliases and the versions they point to, read when its editor opens (YN-57)", async () => {
  const page = mount(core());
  await opened(page);
  assert.deepEqual(asks(page), [], "no list is read before an editor opens");
  button(page, "Edit Claude Code · opus").click();
  await until(() => modelView(page, "cl").groups.length === 2, "Claude Code's list");
  const view = modelView(page, "cl");
  assert.equal(view.value, "opus", "the saved alias stays chosen");
  assert.deepEqual(view.groups, ["Aliases · follow new releases", "Pinned versions"]);
  assert.deepEqual(view.grouped["Aliases · follow new releases"], ["default", "opus", "sonnet", "haiku"]);
  assert.deepEqual(view.grouped["Pinned versions"], ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], "each once");
  assert.equal(view.options[0], "The tool's default");
  assert.equal(view.options.at(-1), "Other (type it)…");
  assert.ok(view.options.includes("Opus · opus"));
  assert.match(view.notes[0], /^From Claude Code on this Core host: its aliases, and the versions they point to now\. Read again$/);
  assert.deepEqual(asks(page), ["/api/models?harness=claude"], "only the open candidate's tool, once");
  await set(page, view.select, "claude-sonnet-5-5");
  await save(page);
  await until(() => puts(page).length === 1, "the save");
  assert.equal(puts(page)[0].body.policy.candidates.find((c) => c.id === "cl").model, "claude-sonnet-5-5");
});

test("OpenCode's list puts the candidate's key's provider first, and says when a model needs another key (YN-57)", async () => {
  const page = mount(core(), "zh-Hans");
  await opened(page);
  button(page, "编辑 OpenCode · deepseek-flash · API").click();
  await until(() => modelView(page, "ds").groups.length === 3, "OpenCode's list");
  let view = modelView(page, "ds");
  assert.equal(view.value, "deepseek/deepseek-flash");
  assert.deepEqual(view.groups, ["DeepSeek · 用这个候选的 API key", "OpenCode · 免登录", "Anthropic · 只能用它自己的 API key"]);
  assert.deepEqual(view.grouped["DeepSeek · 用这个候选的 API key"], ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
  assert.ok(view.options.includes("DeepSeek V4 Pro · deepseek/deepseek-v4-pro"));
  assert.match(view.notes[0], /^来自这台 Core 主机上的 OpenCode 2\.2\.5：它这个版本自带的目录加上你的 OpenCode 配置，也就是新执行者看到的那份。 重新读取$/);
  assert.deepEqual(asks(page), ["/api/routing/models?harness=opencode"]);
  await set(page, view.select, "anthropic/claude-x");
  view = modelView(page, "ds");
  assert.equal(view.notes[1], "Anthropic 的模型需要 Anthropic 的 API key：在「账号或 key」里选一把。", "said, not refused");
  await until(() => button(page, "保存", bar(page)), "the bar");
  assert.equal(button(page, "保存", bar(page)).disabled, false, "the save is not held for it");
});

test("a tool whose list can't be read shows Yuzuno's short list and why, until Read again reads it (YN-57)", async () => {
  const view0 = savedView();
  view0.policy.candidates.push({ id: "cx", enabled: true, harness: "codex", model: "gpt-6.1-sol", credential: { kind: "login" }, conditions: [], unknown: "skip" });
  const page = mount(core({ view: view0, lists: (harness, n) => (harness === "codex" && n === 1 ? [503, { code: "unavailable", error: "Codex did not start" }] : undefined) }));
  await opened(page);
  button(page, "Edit Codex · gpt-6.1-sol").click();
  await until(() => modelView(page, "cx").groups.length === 1, "the short list");
  let view = modelView(page, "cx");
  assert.deepEqual(view.groups, ["Yuzuno's short list"]);
  assert.deepEqual(view.grouped["Yuzuno's short list"], ["gpt-6.1-sol"]);
  assert.equal(view.value, "gpt-6.1-sol");
  assert.match(view.notes[0], /^Couldn't read Codex's models on this Core host \(Codex did not start\)\. Showing Yuzuno's short list; choose Other to type any model\. Read again$/);
  button(page, "Read again", card(page, "cx")).click();
  await until(() => modelView(page, "cx").groups[0] === "Codex's models", "Codex's own list");
  view = modelView(page, "cx");
  assert.deepEqual(view.grouped["Codex's models"], ["gpt-6.1-sol", "gpt-6.1-sol-mini"], "a hidden model stays out");
  assert.match(view.notes[0], /^From Codex on this Core host: its own model list\./);
  assert.deepEqual(asks(page), ["/api/models", "/api/models"], "asked again");
});

test("a saved model the list lacks stays chosen and says so; Other takes a typed one (YN-57)", async () => {
  const view0 = savedView();
  view0.policy.candidates.push({ id: "cy", enabled: true, harness: "codex", model: "gpt-legacy", credential: { kind: "login" }, conditions: [], unknown: "skip" });
  const page = mount(core({ view: view0 }));
  await opened(page);
  button(page, "Edit Codex · gpt-legacy").click();
  await until(() => modelView(page, "cy").groups.length === 1, "Codex's list");
  let view = modelView(page, "cy");
  assert.equal(view.value, "gpt-legacy", "not changed for the user");
  assert.equal(view.select.selectedOptions[0].textContent, "gpt-legacy · not in the list now");
  await set(page, view.select, " other");
  const typed = byLabel(page, "Model, typed");
  assert.equal(typed.value, "gpt-legacy", "the typed field starts from it");
  await set(page, typed, "gpt-7-preview");
  view = modelView(page, "cy");
  assert.equal(view.value, " other", "Other stays chosen while typing");
  assert.ok(view.notes.includes("Codex doesn't list this model now: it runs only if the executor's Codex has it."));
  await save(page);
  await until(() => puts(page).length === 1, "the save");
  assert.equal(puts(page)[0].body.policy.candidates.find((c) => c.id === "cy").model, "gpt-7-preview");
});

test("a candidate added by hand offers an API key for its tool with no keys added yet (YN-57 S3)", async () => {
  const page = mount(core({ keys: [] }));
  await opened(page);
  button(page, "Add a candidate").click();
  await until(() => cards(page).length === 3 && cards(page)[2].querySelector(".routing-edit"), "the new candidate's editor");
  const id = cards(page)[2].dataset.cand;
  const offered = () => [...editorField(page, id, "Account or key").options].map((o) => [o.value, o.textContent]);
  assert.ok(offered().some(([value, label]) => value === "new:anthropic" && label === "Add an API key for Anthropic…"),
    `Claude Code takes an Anthropic key, and one can be added from here: ${JSON.stringify(offered())}`);
  await set(page, editorField(page, id, "Tool"), "opencode");
  for (const provider of ["DeepSeek", "Anthropic", "OpenAI"]) {
    assert.ok(offered().some(([, label]) => label === `Add an API key for ${provider}…`), `OpenCode takes ${provider}'s: ${JSON.stringify(offered())}`);
  }
});

// Synthetic, long and unusual, so a page or request holding it is found by a text search.
const KEY_VALUE = "sk-fixture-yn57-IN-PLACE-WRITE-ONLY-7d2e";
test("a key added from a candidate is written once, never shown or kept, and becomes the candidate's (YN-57 S3)", async () => {
  const page = mount(core({ keys: [] }));
  await opened(page);
  button(page, "Add a candidate").click();
  await until(() => cards(page).length === 3 && cards(page)[2].querySelector(".routing-edit"), "the new candidate's editor");
  const id = cards(page)[2].dataset.cand;
  const keyReads = () => page.calls.filter((c) => c.method === "GET" && c.url.endsWith("/routing/keys")).length;
  const readsBefore = keyReads();
  await set(page, editorField(page, id, "Account or key"), "new:anthropic");
  const form = card(page, id).querySelector('.routing-key-inline form[aria-label="New Anthropic API key"]');
  assert.ok(form, "Accounts and keys' own form, in place");
  assert.equal(form.querySelector("select"), null, "its provider is the one chosen, not asked again");
  assert.equal(form.querySelector(".routing-new-key-grid input").value, "anthropic", "the first id free for it");
  assert.match(form.textContent, /Saved under Accounts and keys as soon as you save it here, and never shown again\./);
  const value = byLabel(page, "New Anthropic API key: value");
  assert.equal(value.type, "password");
  await set(page, value, KEY_VALUE);
  assert.equal(value.getAttribute("value"), null, "typed, it is never written into the page");
  button(page, "Save key", form).click();
  await until(() => !card(page, id).querySelector(".routing-key-inline"), "the form closes once the key is kept");
  const writes = page.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/routing/keys/anthropic"));
  assert.deepEqual(writes.map((c) => c.body), [{ source: "local", provider: "anthropic", value: KEY_VALUE }], "one write, with the value");
  const select = editorField(page, id, "Account or key");
  assert.equal(select.value, "key:anthropic", "the candidate's key now");
  assert.equal(select.selectedOptions[0].textContent, "API key: Anthropic (anthropic)");
  await until(() => keyReads() > readsBefore, "the page's keys read again");
  await save(page);
  await until(() => puts(page).some((c) => c.url.endsWith("/routing/policy")), "the page's save");
  const policy = puts(page).find((c) => c.url.endsWith("/routing/policy")).body.policy;
  assert.deepEqual(policy.candidates.find((c) => c.id === id).credential, { kind: "apiKey", keyId: "anthropic" });
  assert.deepEqual(page.calls.filter((c) => JSON.stringify(c.body ?? "").includes(KEY_VALUE)).map((c) => `${c.method} ${new URL(c.url, "http://isolated.test").pathname}`),
    ["PUT /api/routing/keys/anthropic"], "only its own write carries the value");
  assert.ok(!page.document.documentElement.outerHTML.includes(KEY_VALUE), "never in the page");
  const kept = JSON.stringify([Object.entries(page.window.localStorage), Object.entries(page.window.sessionStorage), page.window.location.href]);
  assert.ok(!kept.includes(KEY_VALUE), "never kept in this browser");
  assert.deepEqual(page.errors, []);
});

test("cancelling a key added in place leaves the candidate's account as it was and writes nothing (YN-57 S3)", async () => {
  const page = mount(core());
  await opened(page);
  button(page, "Edit Claude Code · opus").click();
  await until(() => card(page, "cl").querySelector(".routing-edit"), "its editor");
  await set(page, editorField(page, "cl", "Account or key"), "new:anthropic");
  const form = card(page, "cl").querySelector(".routing-key-inline form");
  assert.equal(form.querySelector(".routing-new-key-grid input").value, "anthropic-2", "another id than the key already there");
  await set(page, byLabel(page, "New Anthropic API key: value"), KEY_VALUE);
  button(page, "Cancel", form).click();
  await tick();
  assert.equal(card(page, "cl").querySelector(".routing-key-inline"), null);
  assert.equal(editorField(page, "cl", "Account or key").value, "pool", "the pool, as before");
  assert.deepEqual(puts(page).map((c) => c.url), [], "nothing written (evaluating the draft is a read)");
});

test("while the keys can't be read here, adding one from a candidate is offered but can't be chosen (YN-57 S3)", async () => {
  const page = mount(core({ keys: null }));
  await until(() => cards(page).length > 0, "the candidates");
  await until(() => page.calls.some((c) => c.url.endsWith("/routing/keys")), "the keys asked for");
  await tick();
  button(page, "Add a candidate").click();
  await until(() => cards(page).length === 3 && cards(page)[2].querySelector(".routing-edit"), "the new candidate's editor");
  const option = [...editorField(page, cards(page)[2].dataset.cand, "Account or key").options].find((o) => o.value === "new:anthropic");
  assert.ok(option, "still offered");
  assert.equal(option.disabled, true);
  assert.equal(option.textContent, "Add an API key for Anthropic (keys can't be read here)");
});

test("a candidate that can't be saved says so on its card, with a pill that opens its editor (YN-57)", async () => {
  const view = savedView();
  view.policy.candidates[0].credential = { kind: "apiKey", keyId: "deepseek-gone" };
  const page = mount(core({ view }));
  await opened(page);
  const pill = card(page, "ds").querySelector(".routing-cand-title > .routing-fix");
  assert.ok(pill, "the pill, beside its title");
  assert.equal(pill.tagName, "BUTTON");
  assert.equal(pill.type, "button", "never a form's submit");
  assert.equal(pill.textContent, "Needs a fix");
  assert.equal(pill.getAttribute("aria-label"), "Needs a fix: edit OpenCode · deepseek-flash · API");
  assert.ok(pill.querySelector("svg[aria-hidden='true']"), "its icon, hidden from a screen reader");
  assert.equal(card(page, "cl").querySelector(".routing-fix"), null, "only on a candidate with a problem");
  pill.click();
  await tick();
  const editor = card(page, "ds").querySelector(".routing-edit");
  assert.ok(editor, "its editor is open");
  assert.match(editor.textContent, /The key deepseek-gone isn't added yet/, "which says what to fix");
  assert.equal(card(page, "ds").querySelector(".routing-fix"), null, "the open editor says it instead of the pill");
  // The pill went: the focus is on the card's open/close toggle, as after the pencil, not lost to the page (R1).
  assert.equal(page.document.activeElement?.getAttribute("aria-label"), "Close OpenCode · deepseek-flash · API");
  assert.equal(page.document.activeElement?.getAttribute("aria-expanded"), "true");
  assert.deepEqual(page.errors, []);
});

test("routing off, the Workspace cap, a weekly schedule of its own and a pool of chosen accounts", async () => {
  const page = mount(core());
  await opened(page);
  byLabel(page, "Executor routing").click();
  await tick();
  assert.ok(page.document.querySelector(".routing-off-note"), "says what off means");
  await set(page, byLabel(page, "At most $ a day, all API keys"), "");
  button(page, "Edit OpenCode · deepseek-flash · API").click();
  await until(() => card(page, "ds").querySelector(".routing-window"), "the time window");
  await set(page, card(page, "ds").querySelector(".routing-window-head .routing-inline-field select"), "local");
  button(page, "Period 1: Sat", card(page, "ds")).click();
  await tick();
  await set(page, byLabel(page, "Period 1: to"), "00:00");
  assert.equal(byLabel(page, "Period 1: to").value, "00:00", "midnight at the end shows as 00:00");
  assert.equal(chips(card(page, "ds"))[0], "Outside Core host time Mon–Sat 01:00–24:00 +1 · 30 min left at least");
  button(page, "Edit Claude Code · opus").click();
  await until(() => card(page, "cl").querySelector(".routing-pool"), "the pool");
  [...card(page, "cl").querySelectorAll(".routing-pool label")].find((l) => l.textContent.includes("Only these")).querySelector("input").click();
  await tick();
  [...card(page, "cl").querySelectorAll(".routing-pool-accounts label")].find((l) => l.textContent.includes("Account #2")).querySelector("input").click();
  await tick();
  assert.ok(!page.document.documentElement.outerHTML.includes(EMAIL) && !page.document.documentElement.outerHTML.includes("fixture-alias-label"), "accounts by number and fingerprint only");
  await save(page);
  await until(() => puts(page).length === 1, "the save");
  const sent = puts(page)[0].body.policy;
  assert.equal(sent.enabled, false);
  assert.ok(!("dailyApiCapUsd" in sent), "no cap once emptied");
  assert.deepEqual(sent.candidates[0].conditions[0].schedule, { timeZone: "local", slots: [{ days: [1, 2, 3, 4, 5, 6], from: "01:00", to: "24:00" }, PEAK.slots[1]] });
  assert.deepEqual(sent.candidates[1].credential, { kind: "pool", manager: "cswap", accounts: ["a1b2c3d4e5f60718", "9a8b7c6d5e4f3021"], pick: "mostRemaining" });
});

test("leaving the page and coming back keeps the unsaved order; a version saved meanwhile is shown, not put over it (R1 75964dfb)", async () => {
  const server = core();
  const page = mount(server);
  await opened(page);
  button(page, "Move OpenCode · deepseek-flash · API down").click();
  await tick();
  const reads = () => page.calls.filter((c) => c.method === "GET" && c.url === "/api/routing/policy").length;
  // Settings hides the page (a search, another page) and shows it again: it reads the policy again.
  page.window.renderRouting(false);
  await tick();
  page.window.renderRouting(true);
  await until(() => reads() === 2, "read again");
  await tick();
  assert.deepEqual(titles(page), ["Claude Code · opus", "OpenCode · deepseek-flash"], "the move is still there");
  assert.match(bar(page).textContent, /1 change not saved/);
  // Another save lands while the page is hidden: shown as a newer version, the draft kept.
  server.state.view = { ...server.state.view, version: 4, updatedAt: "2026-11-08T05:30:00Z", policy: { ...server.state.view.policy, candidates: [clone(cl)] } };
  page.window.renderRouting(false);
  await tick();
  page.window.renderRouting(true);
  await until(() => page.document.querySelector(".routing-conflict"), "the newer version shown");
  assert.match(page.document.querySelector(".routing-conflict").textContent, /A newer version \(4/);
  assert.deepEqual(titles(page), ["Claude Code · opus", "OpenCode · deepseek-flash"], "still the draft");
  assert.equal(puts(page).length, 0, "nothing saved");
});

test("with no change, coming back shows what Core has now", async () => {
  const server = core();
  const page = mount(server);
  await opened(page);
  server.state.view = { ...server.state.view, version: 4, policy: { ...server.state.view.policy, candidates: [clone(cl)] } };
  page.window.renderRouting(false);
  await tick();
  page.window.renderRouting(true);
  await until(() => titles(page).length === 1, "the newer version adopted");
  assert.equal(page.document.querySelector(".settings-current").textContent, "version 4");
  assert.ok(!page.document.querySelector(".routing-conflict"), "no conflict: nothing was being edited");
});

test("changing the tool drops a daily spend cap with the key it can't use (R1 75964dfb)", async () => {
  const view = savedView();
  view.policy.candidates.push({ id: "ca", enabled: true, harness: "claude", model: "opus", credential: { kind: "apiKey", keyId: "anthropic" }, unknown: "skip",
    conditions: [{ kind: "dailyApiCap", usd: 8 }, { kind: "timeWindow", inside: true, schedule: PEAK }] });
  const page = mount(core({ view }));
  await opened(page);
  button(page, "Edit Claude Code · opus · API").click();
  await until(() => card(page, "ca").querySelector(".routing-edit"), "its editor");
  await set(page, editorField(page, "ca", "Tool"), "codex");
  assert.deepEqual(chips(card(page, "ca")), ["DeepSeek peak hours"], "the cap went with the key; the time window stays");
  await save(page);
  await until(() => puts(page).length === 1, "the save");
  const sent = puts(page)[0].body.policy.candidates.find((c) => c.id === "ca");
  assert.deepEqual([sent.harness, sent.credential, sent.conditions.map((c) => c.kind)], ["codex", { kind: "login" }, ["timeWindow"]]);
});
