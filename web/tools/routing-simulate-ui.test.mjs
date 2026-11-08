// YN-49 S4b: Settings → Executor routing → Simulate by time, and Templates.
// The week is asked of Core with the page's policy (POST /api/routing/simulate,
// 30-minute steps from today's local midnight), drawn as a strip per day with
// a text version; a picked time is evaluated with its reasons; assumptions
// are sent as Core takes them. Each template follows routing or is fixed, saved
// as the template list read but for `routing`, against its version; a list
// changed elsewhere is not overwritten. Fixture HTTP only; no Core.
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
const fixture = await mkdtemp(path.join(cache, "routing-simulate-ui-"));
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
    build: { write: false, lib: { entry, name: "RoutingSimulateUI", formats: ["iife"] } },
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
const H = 3_600_000;
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const policy = { enabled: true, whenNone: "wait", candidates: [
  { id: "ds", enabled: true, harness: "opencode", model: "deepseek/deepseek-flash", credential: { kind: "apiKey", keyId: "deepseek-main" }, unknown: "skip", conditions: [] },
  { id: "cl", enabled: true, harness: "claude", model: "opus", credential: { kind: "pool", manager: "cswap", accounts: "all", pick: "mostRemaining" }, unknown: "skip", conditions: [] },
] };
/** Each day: DeepSeek until 10:00, Claude until 22:00, then none; assuming account #2 used up, Claude's hours go to none. */
function week(body) {
  const from = Date.parse(body.from);
  const segments = [];
  const out = (a, b, chosen) => segments.push({ from: new Date(from + a * H).toISOString(), to: new Date(from + b * H).toISOString(), chosen });
  const claude = body.assume?.accountsUsedUp?.includes("0f1e2d3c4b5a6978") ? null : "cl";
  for (let d = 0; d < 7; d++) { out(24 * d, 24 * d + 10, "ds"); out(24 * d + 10, 24 * d + 22, claude); out(24 * d + 22, 24 * d + 24, null); }
  return segments;
}
const templates = [
  { id: "dev", label: "Development (PR)", harness: "codex", model: "gpt-6.1-sol", instructions: "Open a PR.", steps: [{ kind: "work" }], laterField: "kept" },
  { id: "review", label: "Review", harness: "claude", routing: "fixed" },
];

function core({ simulate = (body) => [200, { segments: week(body) }], templatesPut, policy: served = policy } = {}) {
  const asked = { simulate: [], evaluate: [], puts: [] };
  let list = { version: 7, templates: JSON.parse(JSON.stringify(templates)), laterTemplates: 0 };
  return { asked, route(url, method, body) {
    const p = new URL(url, "http://isolated.test").pathname;
    if (p === "/api/routing/policy") return [200, { version: 3, limits: { candidates: 8 }, policy: served }];
    if (p === "/api/routing/simulate") { asked.simulate.push(body); return simulate(body); }
    if (p === "/api/routing/evaluate") {
      asked.evaluate.push(body);
      const at = body.at ? Date.parse(body.at) : Date.now();
      const chosen = week({ from: new Date(midnight()).toISOString(), assume: body.assume }).find((s) => Date.parse(s.from) <= at && at < Date.parse(s.to))?.chosen ?? null;
      return [200, { at: "preview", chosen, candidates: [
        { id: "ds", state: chosen === "ds" ? "chosen" : "skipped", reasons: chosen === "ds" ? [] : [{ code: "peak", message: "DeepSeek's peak price", messageZh: "DeepSeek 高峰价" }], readings: [] },
        { id: "cl", state: chosen === "cl" ? "chosen" : chosen === "ds" ? "notTried" : "skipped", reasons: [], readings: [] }] }];
    }
    if (p === "/api/executor-templates" && method === "GET") return [200, { workspace: list, available: [], presets: [] }];
    if (p === "/api/executor-templates" && method === "PUT") {
      asked.puts.push(body);
      const answer = templatesPut?.(body);
      if (answer) return answer;
      list = { version: list.version + 1, templates: body.templates, laterTemplates: 0 };
      return [200, { workspace: list, available: [], presets: [] }];
    }
    if (p === "/api/routing/keys") return [200, { keys: [{ id: "deepseek-main", provider: "deepseek", source: "local", set: true, setAt: "2026-11-08T03:00:00Z" }], onePasswordToken: { set: false } }];
    if (p === "/api/routing/accounts") return [200, { cswap: { command: "cswap", pinned: "1.0.0", accounts: [
      { number: 1, fingerprint: "a1b2c3d4e5f60718", active: true, label: "someone@example.test" },
      { number: 2, fingerprint: "0f1e2d3c4b5a6978", active: false, label: "alias" }] }, codexHomes: [] }];
    return [404, { error: `not answered: ${method} ${p}` }];
  } };
}

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
const button = (page, label, within = page.document) =>
  [...within.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
async function set(page, node, value) {
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(node, value);
  node.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  node.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await tick();
}

test("the week is asked with the page's policy from today's midnight, drawn per day, with a text version", async () => {
  const server = core();
  const page = mount(server);
  await until(() => page.document.querySelectorAll(".routing-strip-row").length === 7, "seven rows");
  const asked = server.asked.simulate[0];
  assert.deepEqual(asked.policy, policy);
  assert.equal(Date.parse(asked.from), midnight(), "from today's local midnight");
  assert.equal(Date.parse(asked.to) - Date.parse(asked.from), 7 * 24 * H, "seven days");
  assert.equal(asked.stepMinutes, 30);
  assert.equal(asked.assume, undefined, "nothing assumed");
  const runs = [...page.document.querySelectorAll(".routing-strip-row")[0].querySelectorAll(".routing-strip-run")];
  const share = (r) => Math.round(parseFloat(r.style.width) * 100) / 100;
  assert.deepEqual(runs.map((r) => [r.textContent, share(r), r.classList.contains("is-wait")]),
    [["1", 41.67, false], ["2", 50, false], ["", 8.33, true]], "each run its share of the day; none striped, no number");
  const text = [...page.document.querySelectorAll(".routing-sim-text li")].map((li) => li.textContent);
  assert.equal(text.length, 21);
  assert.match(text[0], /–10:00 · OpenCode · deepseek-flash · API$/);
  assert.match(text[2], /–24:00 · none: wait$|–00:00 · none: wait$/);
  // The picked time is now, evaluated with its reasons.
  await until(() => server.asked.evaluate.some((b) => b.at), "the picked time evaluated");
  await until(() => /would choose/.test(q(page, ".routing-sim-result").textContent) || /none is available/.test(q(page, ".routing-sim-result").textContent), "its result");
  assert.deepEqual(page.errors, []);
});

test("a picked time and an assumption are asked as Core takes them; Back to now", async () => {
  const server = core();
  const page = mount(server);
  await until(() => q(page, ".routing-sim-slider input"), "the slider");
  // Tomorrow 12:00: Claude's hours.
  await set(page, q(page, ".routing-sim-slider input"), String(24 * 60 + 12 * 60));
  await until(() => server.asked.evaluate.some((b) => b.at && Date.parse(b.at) === midnight() + 36 * H), "tomorrow 12:00 evaluated");
  await until(() => /: would choose Claude Code · opus$/.test(q(page, ".routing-sim-result p").textContent), "its result");
  button(page, "Account #2 used up").click();
  await until(() => server.asked.simulate.some((b) => b.assume?.accountsUsedUp?.[0] === "0f1e2d3c4b5a6978"), "the week asked again, assuming it");
  assert.deepEqual(server.asked.simulate.at(-1).assume, { accountsUsedUp: ["0f1e2d3c4b5a6978"] }, "only what is on");
  await until(() => /none is available, new executors wait$/.test(q(page, ".routing-sim-result p").textContent), "none then");
  assert.equal(button(page, "Account #2 used up").getAttribute("aria-pressed"), "true");
  assert.ok(!page.document.documentElement.outerHTML.includes("someone@example.test"), "accounts by number only");
  button(page, "Back to now").click();
  await tick();
  assert.equal(button(page, "Back to now").disabled, true);
});

test("a Core without the simulation says it comes with routing itself", async () => {
  const page = mount(core({ simulate: () => [404, { error: "not found" }] }), "zh-Hans");
  await until(() => /按时间模拟要等路由本身/.test(q(page, ".routing-simulate")?.textContent ?? ""), "the note");
  assert.ok(!q(page, ".routing-strip"));
});

test("a template follows routing or is fixed: saved as read but for routing, against its version; a list changed elsewhere is not overwritten", async () => {
  const server = core();
  const page = mount(server);
  await until(() => q(page, '.routing-template[data-template="dev"]'), "the templates");
  const dev = q(page, '.routing-template[data-template="dev"]');
  assert.equal(dev.querySelector(".settings-row-help").textContent, "By the order above");
  assert.equal(q(page, '.routing-template[data-template="review"] .settings-row-help').textContent, "Fixed: Claude Code · the defaults for new Agents");
  assert.equal(q(page, ".routing-template.is-general .settings-row-help").textContent, "Always follows routing");
  button(page, "Fixed", dev).click();
  button(page, "Follows routing", q(page, '.routing-template[data-template="review"]')).click();
  await tick();
  assert.equal(dev.querySelector(".settings-row-help").textContent, "Fixed: Codex · gpt-6.1-sol");
  await until(() => button(page, "Save", q(page, ".settings-savebar")) && !button(page, "Save", q(page, ".settings-savebar")).disabled, "Save");
  button(page, "Save", q(page, ".settings-savebar")).click();
  await until(() => server.asked.puts.length === 1, "the save");
  assert.deepEqual(server.asked.puts[0], { expectedVersion: 7, templates: [
    { ...templates[0], routing: "fixed" }, { id: "review", label: "Review", harness: "claude" }] }, "the list as read, only routing changed");

  const conflicted = core({ templatesPut: () => [400, { error: "version_conflict: these executor templates changed; reload before saving" }] });
  const other = mount(conflicted, "zh-Hans");
  await until(() => q(other, '.routing-template[data-template="dev"]'), "the templates");
  button(other, "固定", q(other, '.routing-template[data-template="dev"]')).click();
  await until(() => button(other, "保存", q(other, ".settings-savebar")) && !button(other, "保存", q(other, ".settings-savebar")).disabled, "保存");
  button(other, "保存", q(other, ".settings-savebar")).click();
  await until(() => q(other, ".routing-templates .routing-conflict"), "the conflict");
  assert.match(q(other, ".routing-templates .routing-conflict").textContent, /模板在别处被改过了，这里没有保存任何东西。/);
  assert.equal(conflicted.asked.puts.length, 1, "no second save");
  button(other, "重新读取").click();
  await until(() => !q(other, ".routing-templates .routing-conflict"), "read again");
});

test("removing a candidate while its evaluation is shown keeps the page (a record of the order before the change)", async () => {
  const server = core();
  const page = mount(server);
  await until(() => q(page, ".routing-sim-slider input"), "the slider");
  // Today 12:00, in Claude's hours: DeepSeek is shown skipped, with its reason.
  await set(page, q(page, ".routing-sim-slider input"), String(12 * 60));
  await until(() => /: would choose Claude Code · opus$/.test(q(page, ".routing-sim-result p")?.textContent ?? ""), "the picked time's result");
  assert.match(q(page, ".routing-sim-result").textContent, /DeepSeek's peak price/, "DeepSeek shown skipped, with its reason");
  button(page, "Edit OpenCode · deepseek-flash · API").click();
  await until(() => q(page, '.routing-cand[data-cand="ds"] .routing-edit'), "its editor");
  button(page, "Remove this candidate", q(page, '.routing-cand[data-cand="ds"]')).click();
  await tick();
  assert.equal(page.document.querySelectorAll(".routing-cand").length, 1, "the order is still drawn, without it");
  assert.ok(q(page, ".routing-simulate"), "and the simulation with it");
  assert.deepEqual(page.errors, [], "nothing thrown");
});

test("the picked time's reasons carry their candidates' numbers and names", async () => {
  const page = mount(core());
  await until(() => q(page, ".routing-sim-slider input"), "the slider");
  await set(page, q(page, ".routing-sim-slider input"), String(12 * 60));
  await until(() => q(page, ".routing-sim-why li"), "the reasons");
  assert.deepEqual([...page.document.querySelectorAll(".routing-sim-why li")].map((li) => li.textContent), ["1OpenCode · deepseek-flash · API: DeepSeek's peak price"]);
});

test("an order the page can't save isn't simulated: a quiet note stands in for the week until it is corrected", async () => {
  const server = core();
  const page = mount(server);
  await until(() => q(page, ".routing-strip") && server.asked.evaluate.some((b) => b.at), "the week and the picked time");
  const before = { simulate: server.asked.simulate.length, evaluate: server.asked.evaluate.length };
  await set(page, q(page, '[aria-label="At most $ a day, all API keys"]'), "0");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual({ simulate: server.asked.simulate.length, evaluate: server.asked.evaluate.length }, before, "nothing asked while the cap can't be saved");
  assert.equal(q(page, ".routing-sim-held")?.textContent, "The week shows again once the marked block is corrected.");
  assert.ok(!q(page, ".routing-strip") && !q(page, ".routing-sim-result"), "no week or time of the order before the change");
  assert.ok(!q(page, ".routing-simulate .inline-error"), "no error");
  await set(page, q(page, '[aria-label="At most $ a day, all API keys"]'), "25");
  await until(() => server.asked.simulate.length > before.simulate, "asked again once corrected");
  assert.equal(server.asked.simulate.at(-1).policy.dailyApiCapUsd, 25);
  await until(() => q(page, ".routing-strip"), "the week again");
});

test("an order Core refuses to simulate is a note with Core's words, not an error", async () => {
  const page = mount(core({ simulate: () => [400, { code: "invalid", error: "candidates[0].model: a model has no spaces", path: "candidates[0].model" }] }));
  await until(() => q(page, ".routing-sim-held"), "the note");
  assert.equal(q(page, ".routing-sim-held").textContent, "Core can't simulate this draft yet: candidates[0].model: a model has no spaces");
  assert.ok(!q(page, ".routing-simulate .inline-error") && !q(page, ".routing-strip"), "no error, no week");
});

test("a Claude login offers its active claude-swap account as used up, and no other", async () => {
  const login = { ...policy, candidates: [{ id: "cl", enabled: true, harness: "claude", model: "opus", credential: { kind: "login" }, unknown: "skip", conditions: [] }] };
  const server = core({ policy: login });
  const page = mount(server);
  await until(() => q(page, ".routing-sim-assume"), "the assumptions");
  assert.deepEqual([...page.document.querySelectorAll(".routing-sim-assume .routing-pill")].map((b) => b.textContent), ["Account #1 used up"], "the active account only");
  button(page, "Account #1 used up").click();
  await until(() => server.asked.simulate.some((b) => b.assume?.accountsUsedUp?.[0] === "a1b2c3d4e5f60718"), "the week asked again, assuming it");
});
