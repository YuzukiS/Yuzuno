// YN-49 S4b: Settings → Executor routing's live view. Core evaluates the page's
// policy, unsaved changes included (POST /api/routing/evaluate): the card above
// the order says whom it would choose now and why not the ones before; each
// candidate shows its state, reasons and readings with when they were read;
// the recent choices (GET /api/routing/choices) open to their records; today's
// spend (GET /api/routing/readings) sits by the Workspace's cap. A Core without
// these routes says they come with routing itself. Fixture HTTP only, shaped
// as docs/executor-routing.md has them; no Core.
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
const fixture = await mkdtemp(path.join(cache, "routing-live-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ExecutorRouting} from ${src("ExecutorRouting.tsx")};
import {SaveBarScope} from ${src("SettingsSaveBar.tsx")};
const root=createRoot(document.getElementById('root'));
window.renderRouting=()=>root.render(<SaveBarScope><ExecutorRouting active/></SaveBarScope>);`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "RoutingLiveUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function until(check, what, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();
const PEAK = { timeZone: "UTC", slots: [{ days: [1, 2, 3, 4, 5], from: "01:00", to: "04:00" }, { days: [1, 2, 3, 4, 5], from: "06:00", to: "10:00" }] };
const policy = { enabled: true, whenNone: "wait", dailyApiCapUsd: 20, candidates: [
  { id: "ds", enabled: true, harness: "opencode", model: "deepseek/deepseek-flash", credential: { kind: "apiKey", keyId: "deepseek-main" }, unknown: "skip",
    conditions: [{ kind: "timeWindow", inside: false, schedule: PEAK, minMinutesLeft: 30 }] },
  { id: "cl", enabled: true, harness: "claude", model: "opus", credential: { kind: "pool", manager: "cswap", accounts: "all", pick: "mostRemaining" }, unknown: "skip",
    conditions: [{ kind: "quota", fiveHourLeftPct: 15, weekLeftPct: 10 }] },
  { id: "cx", enabled: true, harness: "codex", model: "gpt-6.1-sol", credential: { kind: "login" }, unknown: "skip", conditions: [] },
] };
// Core's evaluation (route_json), at "preview"; accounts by number and fingerprint only.
const record = (over = {}) => ({ policyVersion: 3, evaluatedAt: minutesAgo(0), at: "preview", chosen: "cl", account: { number: 2, fingerprint: "0f1e2d3c4b5a6978" },
  candidates: [
    { id: "ds", harness: "opencode", model: "deepseek/deepseek-flash", state: "skipped",
      reasons: [{ code: "peak", message: "DeepSeek's peak price now; off-peak from 12:00", messageZh: "现在是 DeepSeek 高峰价，12:00 起是闲时", params: { until: minutesAgo(-90) }, condition: 0 }], readings: [] },
    { id: "cl", harness: "claude", model: "opus", state: "chosen",
      reasons: [{ code: "poolPick", message: "Account #2: 71% of 5 hours and 58% of the week left, the most of the usable accounts", messageZh: "账号 #2：5 小时剩 71%，本周剩 58%，是可用账号里较少一项最多的" }],
      readings: [
        { what: "fiveHourLeft", account: "1", value: 8, observedAt: minutesAgo(2), source: "cswap" },
        { what: "weekLeft", account: "1", value: 64, observedAt: minutesAgo(2), source: "cswap" },
        { what: "fiveHourLeft", account: "2", value: 71, observedAt: minutesAgo(2), source: "cswap" },
        { what: "weekLeft", account: "2", value: 58, observedAt: minutesAgo(2), source: "cswap" }],
      accounts: [{ number: 1, fingerprint: "a1b2c3d4e5f60718", state: "low" }, { number: 2, fingerprint: "0f1e2d3c4b5a6978", state: "pick" }] },
    { id: "cx", harness: "codex", model: "gpt-6.1-sol", state: "notTried", reasons: [], readings: [] },
  ], ...over });

function core({ evaluate = () => [200, record()], choices, readings } = {}) {
  const asked = [];
  return { asked, route(url, method, body) {
    const p = new URL(url, "http://isolated.test").pathname;
    if (p === "/api/routing/policy") return [200, { version: 3, limits: { candidates: 8 }, policy }];
    if (p === "/api/routing/evaluate" && method === "POST") { asked.push(body); return evaluate(body); }
    if (p === "/api/routing/choices") return choices ? choices() : [200, { choices: [
      { dispatchId: "d-1", taskId: "T-905", executorName: "T-905 · Dev", route: record({ at: "dispatch", evaluatedAt: minutesAgo(6) }) },
      { dispatchId: "d-2", taskId: "T-904", route: { at: "start", evaluatedAt: minutesAgo(200), chosen: "cx", changedAtStart: { from: "cl", reason: "Account #2 ran low while waiting" },
        candidates: [{ id: "ds", state: "skipped", reasons: [{ code: "peak", message: "Peak price", messageZh: "高峰价" }], readings: [] },
          { id: "cl", state: "skipped", reasons: [{ code: "poolNone", message: "No account has enough left", messageZh: "没有够用的账号" }], readings: [] },
          { id: "cx", state: "chosen", reasons: [], readings: [] }] } }] }];
    if (p === "/api/routing/readings") return readings ? readings() : [200, { at: minutesAgo(0), staleAfterSeconds: 600,
      spend: { day: "2026-11-08", zone: "local", utcOffset: "+08:00", resetsAt: minutesAgo(-600), totalUsd: 1.23, byKey: { "deepseek-main": 1.23 } } }];
    // As a Core has it: the templates list (S4b's Templates block reads it).
    if (p === "/api/executor-templates") return [200, { workspace: { version: 1, templates: [], laterTemplates: 0 }, available: [], presets: [] }];
    if (p === "/api/routing/keys") return [200, { keys: [{ id: "deepseek-main", provider: "deepseek", source: "local", set: true, setAt: minutesAgo(60) }], onePasswordToken: { set: false } }];
    if (p === "/api/routing/accounts") return [200, { cswap: { command: "cswap", pinned: "1.0.0", accounts: [] }, codexHomes: [] }];
    return [404, { error: `not answered: ${method} ${p}` }];
  } };
}

// The live view refreshes every minute (S4b): each window is closed after the
// file's tests, so its timers don't keep the process running.
const windows = [];
after(() => { for (const window of windows) window.close(); });
function mount(server, language) {
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
    const [status, value] = await server.route(url, method, body);
    return { ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) };
  };
  window.eval(bundle);
  window.renderRouting();
  return { window, document: window.document, errors };
}
const q = (page, selector) => page.document.querySelector(selector);
const card = (page, id) => q(page, `.routing-cand[data-cand="${id}"]`);
const button = (page, label, within = page.document) =>
  [...within.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
async function set(page, node, value) {
  assert.ok(node, "the field");
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(node, value);
  node.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await tick();
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the card above the order says whom Core would choose now, why not the ones before, and from how old readings", async () => {
  const server = core();
  const page = mount(server);
  await until(() => q(page, ".routing-now"), "the now card");
  // The card's own evaluation, now: no time given (the simulation's carry one).
  const now = () => server.asked.filter((b) => !b.at);
  assert.deepEqual(now()[0], { policy }, "asked with the page's policy");
  assert.equal(q(page, ".routing-now-title").textContent, "Now it would choose Claude Code · opus — Account #2");
  assert.deepEqual([...page.document.querySelectorAll(".routing-now-why li")].map((li) => li.textContent), [
    "1OpenCode · deepseek-flash · API: DeepSeek's peak price now; off-peak from 12:00",
    "2Account #2: 71% of 5 hours and 58% of the week left, the most of the usable accounts"]);
  assert.match(q(page, ".routing-now .settings-row-meta").textContent, /^From readings 2 min ago$/);
  // Only the title is a live region: the "N min ago" under it changes every minute.
  assert.equal(q(page, ".routing-now").getAttribute("role"), null);
  assert.equal(q(page, ".routing-now-title").getAttribute("role"), "status");
  // Each card: its state, its reasons, its readings by account.
  assert.equal(card(page, "ds").querySelector(".routing-state").textContent, "Skipped");
  assert.equal(card(page, "ds").querySelector(".routing-why").textContent, "DeepSeek's peak price now; off-peak from 12:00");
  assert.equal(card(page, "cl").querySelector(".routing-state").textContent, "Would choose");
  assert.ok(card(page, "cl").classList.contains("is-chosen"));
  const parts = (li) => [...li.querySelectorAll(".routing-live-account, .routing-reading, .routing-reading-at, .settings-tag")].map((x) => x.textContent.trim());
  assert.deepEqual([...card(page, "cl").querySelectorAll(".routing-live-accounts li")].map(parts),
    [["Account #1", "5-hour left 8%", "Week left 64%", "2 min ago", "Not enough"], ["Account #2", "5-hour left 71%", "Week left 58%", "2 min ago", "Would use"]]);
  assert.equal(card(page, "cx").querySelector(".routing-state").textContent, "Not reached");
  assert.deepEqual(page.errors, []);
});

test("an unsaved change is evaluated as it stands, and says so", async () => {
  const server = core();
  const page = mount(server);
  await until(() => q(page, ".routing-now"), "the now card");
  button(page, "Move Claude Code · opus up").click();
  const now = () => server.asked.filter((b) => !b.at);
  await until(() => now().length === 2, "asked again after the change");
  assert.deepEqual(now()[1].policy.candidates.map((c) => c.id), ["cl", "ds", "cx"], "the draft, not the saved policy");
  await until(() => /with your unsaved changes/.test(q(page, ".routing-now .settings-row-meta").textContent), "the draft note");
});

test("none available: the card says when the first may be; routing off: it says what off means and no card has a state", async () => {
  const none = core({ evaluate: () => [200, record({ chosen: null, account: undefined, earliest: { at: "2026-11-10T06:20:00Z", candidate: "cl" },
    candidates: record().candidates.map((c) => ({ ...c, state: c.id === "cx" ? "skipped" : c.state === "chosen" ? "skipped" : c.state })) })] });
  const page = mount(none, "zh-Hans");
  await until(() => q(page, ".routing-now.is-wait"), "the waiting card");
  assert.equal(q(page, ".routing-now-title").textContent, "现在没有可用的候选");
  assert.match(q(page, ".routing-now .settings-row-help").textContent, /^新开的执行者会排队，最早 .+ 起 Claude Code · opus 可用。$/);
  page.document.querySelector('[aria-label="执行者路由"]').click();
  await until(() => q(page, ".routing-now.is-off"), "routing off");
  assert.equal(q(page, ".routing-now-title").textContent, "路由关着：新开的执行者按各自模板的固定设置启动。");
  assert.equal(page.document.querySelectorAll(".routing-state").length, 0, "no state on any card");
});

test("the recent choices open to their records; today's spend sits by the cap", async () => {
  const page = mount(core());
  await until(() => page.document.querySelectorAll(".routing-recent-row").length === 2, "the recent choices");
  const rows = [...page.document.querySelectorAll(".routing-recent-row")];
  const what = (row) => [row.querySelector(".routing-recent-what b").textContent, row.querySelector(".routing-recent-what small").textContent];
  assert.deepEqual(what(rows[0]), ["T-905 · Dev → Claude Code · opus · Account #2", "at dispatch"], "the task's id once, as its executor's name has it");
  assert.deepEqual(what(rows[1]), ["T-904 → Codex · gpt-6.1-sol", "Chosen again before starting, in place of Claude Code · opus"]);
  rows[1].click();
  await tick();
  assert.deepEqual([...q(page, "#routing-recent-d-2").querySelectorAll("li")].map((li) => li.textContent), [
    "OpenCode · deepseek-flash · APISkipped · Peak price", "Claude Code · opusSkipped · No account has enough left", "Codex · gpt-6.1-solWould choose"]);
  assert.equal(rows[1].getAttribute("aria-expanded"), "true");
  await until(() => q(page, ".routing-spend"), "the spend line");
  assert.match(q(page, ".routing-spend").textContent, /^Spent today with API keys: \$1\.23 of \$20What the tools report, not a bill\. A new day starts at .+\.$/);
});

test("a Core without the live routes says they come with routing itself; nothing else changes", async () => {
  const missing = () => [404, { error: "not found" }];
  const page = mount(core({ evaluate: missing, choices: missing, readings: missing }));
  await until(() => q(page, ".routing-now-unavailable") && q(page, ".routing-recent .settings-block-help:last-of-type")?.textContent.includes("S3b"), "the notes");
  assert.equal(q(page, ".routing-now-unavailable").textContent, "This Core can't say yet which candidate it would choose: that comes with routing itself (YN-34 S3b).");
  assert.ok(!q(page, ".routing-spend"), "no spend line");
  assert.equal(page.document.querySelectorAll(".routing-state").length, 0);
  assert.equal(page.document.querySelectorAll(".routing-cand").length, 3, "the order as ever");
  assert.ok(!q(page, '[role="alert"]'), "no error");
});

test("a draft the page can't save isn't sent to Core: a quiet note stands in for the card until it is corrected", async () => {
  const server = core();
  const page = mount(server);
  await until(() => q(page, ".routing-now"), "the now card");
  assert.equal(server.asked.length, 1);
  await set(page, q(page, '[aria-label="At most $ a day, all API keys"]'), "0");
  await wait(500);
  assert.equal(server.asked.length, 1, "not asked while the cap can't be saved");
  assert.equal(q(page, ".routing-now-held")?.textContent, "Whom Core would choose shows again once the marked block is corrected.");
  assert.ok(!q(page, ".routing-now"), "no card from before the change");
  assert.equal(page.document.querySelectorAll(".routing-state").length, 0, "no state from before the change");
  assert.ok(!q(page, ".routing-now-error"), "no error");
  await set(page, q(page, '[aria-label="At most $ a day, all API keys"]'), "25");
  await until(() => server.asked.length === 2, "asked again once corrected");
  assert.equal(server.asked[1].policy.dailyApiCapUsd, 25);
  await until(() => q(page, ".routing-now"), "the card again");
  assert.ok(!q(page, ".routing-now-held"));
});

test("a draft Core refuses to judge is a note with Core's words, not an error", async () => {
  const refuses = core({ evaluate: () => [400, { code: "invalid", error: "candidates[1].model: a model has no spaces", path: "candidates[1].model" }] });
  const page = mount(refuses);
  await until(() => q(page, ".routing-now-held"), "the note");
  assert.equal(q(page, ".routing-now-held").textContent, "Core can't judge this draft yet: candidates[1].model: a model has no spaces");
  assert.ok(!q(page, ".routing-now-error") && !q(page, ".routing-now"), "no error, no card");
  assert.equal(page.document.querySelectorAll(".routing-state").length, 0);
});

test("with no reading at all, an unknown candidate's card says none came yet, not that none was needed", async () => {
  const unread = core({ evaluate: () => [200, record({ chosen: "cx", account: undefined, candidates: [
    { id: "ds", state: "skipped", reasons: [{ code: "peak", message: "Peak price", messageZh: "高峰价" }], readings: [] },
    { id: "cl", state: "unknown", reasons: [{ code: "noReading", message: "No account of the pool is known to have quota now", messageZh: "还不知道池里哪个账号有额度" }], readings: [] },
    { id: "cx", state: "chosen", reasons: [], readings: [] }] })] });
  const page = mount(unread);
  await until(() => q(page, ".routing-now"), "the now card");
  assert.equal(q(page, ".routing-now .settings-row-meta").textContent, "No reading yet");
  const known = mount(core({ evaluate: () => [200, record({ chosen: "cx", account: undefined, candidates: [
    { id: "ds", state: "skipped", reasons: [{ code: "peak", message: "Peak price", messageZh: "高峰价" }], readings: [] },
    { id: "cl", state: "off", reasons: [], readings: [] }, { id: "cx", state: "chosen", reasons: [], readings: [] }] })] }));
  await until(() => q(known, ".routing-now"), "the now card");
  assert.equal(q(known, ".routing-now .settings-row-meta").textContent, "No reading was needed");
});
