// YN-49 S4a: Settings → Accounts & keys, on S1's routes
// (docs/executor-routing.md). A key's value is write-only: it is sent in one
// request body and never appears in the page, before or after it is kept; an
// account is named by its number and fingerprint, never its label or email.
// YN-84 S3: a card per provider, its logins then its API keys, each row saying
// which Workspace settings reference it (routing, the new Agent defaults,
// review); what can't be read is said, never counted as no reference, and the
// cards don't depend on the order reads finish in. A provider's new key is its
// own form: no draft crosses providers. Fixture HTTP only; no Core.
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
const fixture = await mkdtemp(path.join(cache, "routing-keys-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RoutingKeys} from ${JSON.stringify(path.join(root, "src", "RoutingKeys.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderKeys=(active=true)=>root.render(<RoutingKeys active={active}/>);`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "RoutingKeysUI", formats: ["iife"] } },
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

// Synthetic values only. The secrets are long and unusual so a page that
// held them anywhere would be found by a plain text search.
const SECRET = "sk-fixture-yn49-WRITE-ONLY-7f3a9c";
const TOKEN = "ops_fixture-yn49-TOKEN-2b8e41";
const EMAIL = "someone@example.test";

/** Core as S1 answers it, with what was written kept in `state`. */
function core(over = {}) {
  const state = {
    keys: [
      { id: "anthropic", provider: "anthropic", source: "1password", set: true, setAt: "2026-11-08T03:10:00Z", reference: "op://Vault/Anthropic API/credential" },
    ],
    token: { set: true, setAt: "2026-11-08T03:20:00Z" },
    op: { found: true, version: "2.30.0", supported: true },
    cswap: { command: "cswap", pinned: "1.0.0", accounts: [
      { number: 1, fingerprint: "a1b2c3d4e5f60718", active: true, label: EMAIL },
      { number: 2, fingerprint: "0f1e2d3c4b5a6978", active: false, label: "work alias" },
    ] },
    homes: [],
    check: { ok: false, reason: { code: "referenceNotFound", message: "1Password has no op://Vault/Anthropic API/credential", messageZh: "1Password 里找不到 op://Vault/Anthropic API/credential" } },
    // What references them (YN-84 S3): DeepSeek through OpenCode's own login, the claude-swap pool, and the
    // Anthropic key by a candidate turned off; new Agents get Codex, and review is Claude Code's.
    policy: { enabled: true, candidates: [
      { id: "ds", enabled: true, harness: "opencode", model: "deepseek/deepseek-flash", credential: { kind: "login" }, conditions: [], unknown: "skip" },
      { id: "cl", enabled: true, harness: "claude", model: "opus", credential: { kind: "pool", manager: "cswap", accounts: "all", pick: "mostRemaining" }, conditions: [], unknown: "skip" },
      { id: "cla", enabled: false, harness: "claude", model: "opus", credential: { kind: "apiKey", keyId: "anthropic" }, conditions: [], unknown: "skip" },
    ] },
    agentHarness: "codex",
    review: { harness: "claude", model: "opus" },
    // A read to refuse: "policy", "agentDefaults", "review" or "accounts".
    fail: new Set(),
    ...over,
  };
  const view = (k) => ({ ...k });
  const refused = (what) => [500, { error: `${what} can't be read now` }];
  return { state, route(url, method, body) {
    const p = new URL(url, "http://isolated.test").pathname;
    if (p === "/api/routing/keys" && method === "GET") return [200, { keys: state.keys.map(view), onePasswordToken: state.token }];
    if (p === "/api/routing/1password" && method === "GET") return [200, { token: state.token, op: state.op }];
    if (p === "/api/routing/accounts" && method === "GET") return state.fail.has("accounts") ? refused("claude-swap") : [200, { cswap: state.cswap, codexHomes: state.homes }];
    if (p === "/api/routing/policy" && method === "GET") return state.fail.has("policy") ? refused("The routing")
      : [200, { version: 2, limits: { candidates: 8 }, policy: { whenNone: "wait", ...state.policy } }];
    if (p === "/api/agent-defaults" && method === "GET") return state.fail.has("agentDefaults") ? refused("The defaults")
      : [200, { saved: {}, builtIn: { harness: "codex", codexPermissionPreset: null, claudePermissionMode: "default" },
        effective: { harness: { value: state.agentHarness, source: "workspace" }, codexPermissionPreset: { value: null, source: "builtin" }, claudePermissionMode: { value: "default", source: "builtin" } } }];
    if (p === "/api/pr-reviews/settings" && method === "GET") return state.fail.has("review") ? refused("Review") : [200, { ...state.review, source: "workspace" }];
    const key = p.match(/^\/api\/routing\/keys\/([^/]+)(\/check)?$/);
    if (key && key[2] && method === "POST") return [200, state.check];
    if (key && method === "PUT") {
      if (state.refuse) return [400, { error: state.refuse }];
      const id = decodeURIComponent(key[1]);
      const kept = { id, provider: body.provider, source: body.source, set: true, setAt: "2026-11-08T04:40:00Z", ...(body.reference ? { reference: body.reference } : {}) };
      state.keys = [...state.keys.filter((k) => k.id !== id), kept].sort((a, b) => a.id.localeCompare(b.id));
      return [200, kept];
    }
    if (key && method === "DELETE") { state.keys = state.keys.filter((k) => k.id !== decodeURIComponent(key[1])); return [200, { removed: true }]; }
    if (p === "/api/routing/1password/token" && method === "PUT") { state.token = { set: true, setAt: "2026-11-08T04:41:00Z" }; return [200, state.token]; }
    if (p === "/api/routing/1password/token" && method === "DELETE") { state.token = { set: false }; return [200, { removed: true }]; }
    if (p === "/api/routing/cswap" && method === "PUT") { state.cswap = { ...state.cswap, command: body.command }; return [200, { command: body.command }]; }
    if (p === "/api/routing/codex-homes" && method === "PUT") { state.homes = body.homes; return [200, { codexHomes: body.homes }]; }
    return [404, { error: `not answered: ${method} ${p}` }];
  } };
}

function mount(server, language) {
  const calls = [];
  // The requests answered so far (YN-84 S3): a page is settled once every one is.
  const answered = [];
  const errors = [];
  // Everything the page writes to its console, to look for a secret in.
  const logged = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  for (const level of ["log", "info", "warn", "error", "debug", "trace", "dir"]) virtualConsole.on(level, (...args) => logged.push(args.map(String).join(" ")));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  if (language) window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const body = init.body && JSON.parse(init.body);
    calls.push({ url, method, body });
    const answer = await server.route(url, method, body);
    answered.push(url);
    // No answer at all, as a browser's fetch rejects: with the page's own TypeError.
    if (answer === "network") throw new window.TypeError("Failed to fetch");
    const [status, value] = answer;
    return { ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) };
  };
  window.eval(bundle);
  window.renderKeys();
  return { window, document: window.document, calls, answered, errors, logged };
}
const html = (page) => page.document.documentElement.outerHTML;
const button = (page, label, within = page.document) =>
  [...within.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
const field = (page, label) => page.document.querySelector(`[aria-label="${label}"]`);
const row = (page, id) => page.document.querySelector(`.routing-key[data-key="${id}"]`);
/** A provider's card (YN-84 S3), and the row its new key is added from. */
const card = (page, provider) => page.document.querySelector(`.routing-provider[data-provider="${provider}"]`);
const cards = (page) => [...page.document.querySelectorAll(".routing-provider")].map((c) => c.dataset.provider);
const addRow = (page, provider) => page.document.querySelector(`.routing-add-key[data-provider="${provider}"]`);
const words = (node) => node?.textContent.replace(/\s+/g, " ").trim();
/** Each row's references in a card: its title (or class) and the lines it lists, the off ones marked. */
const refsIn = (node) => [...node.querySelectorAll(".routing-refs")].map((r) => (r.classList.contains("is-none") ? words(r)
  : [...r.querySelectorAll("li")].map((li) => `${li.classList.contains("is-off") ? "~" : ""}${words(li)}`)));
const notices = (page) => [...page.document.querySelectorAll(".routing-notices p")].map(words);
const others = (page) => [...page.document.querySelectorAll(".routing-others button")].map(words);
/** Types into a field as a person does: the value is the field's own, then an input event. */
async function type(page, label, value) {
  const node = field(page, label);
  assert.ok(node, `the field ${label}`);
  const proto = node.tagName === "SELECT" ? page.window.HTMLSelectElement.prototype : page.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
  node.dispatchEvent(new page.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  await tick();
}
/** Where a secret must never be (YN-49, the Lead's gate on #794): the page's
 * markup, any field's value or value attribute, this site's storage, the
 * URL, the console, and any request but its own write. */
function nowhere(page, secret, ownWrite, typedIn) {
  const { window, document } = page;
  assert.ok(!document.documentElement.outerHTML.includes(secret), "not in the page's markup");
  for (const input of document.querySelectorAll("input")) {
    // Only the field it was typed into may still hold it (to try again), as its own value.
    if (input.getAttribute("aria-label") !== typedIn) assert.notEqual(input.value, secret, "no field holds it");
    assert.ok(!(input.getAttribute("value") ?? "").includes(secret), "no value attribute holds it");
  }
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      assert.ok(!key.includes(secret) && !(storage.getItem(key) ?? "").includes(secret), "not in this site's storage");
    }
  }
  assert.ok(!window.location.href.includes(secret), "not in the URL");
  assert.ok(!page.logged.some((line) => line.includes(secret)), "not in the console");
  for (const call of page.calls) {
    assert.ok(!call.url.includes(secret), "not in any request's URL");
    if (call !== ownWrite) assert.ok(!JSON.stringify(call.body ?? "").includes(secret), `not in ${call.method} ${call.url}`);
  }
}
const writes = (page) => page.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${new URL(c.url, "http://isolated.test").pathname}`);

test("accounts are named by number and fingerprint, never by label or email", async () => {
  const page = mount(core());
  await until(() => page.document.querySelector(".routing-accounts li"), "the claude-swap accounts");
  const items = [...page.document.querySelectorAll(".routing-cswap .routing-accounts li")].map((li) => li.textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(items, ["Account #1fingerprint a1b2c3d4This host's login", "Account #2fingerprint 0f1e2d3c"]);
  assert.ok(!html(page).includes(EMAIL) && !html(page).includes("work alias"), "no label or email anywhere in the page");
  assert.match(page.document.querySelector(".routing-op .settings-row-help").textContent, /Token set · .* · op 2\.30\.0/);
  assert.deepEqual(page.errors, []);
});

test("a new local key is sent once and never shown: not while typed, not once kept", async () => {
  const server = core();
  const page = mount(server);
  await until(() => button(page, "Add a DeepSeek key"), "DeepSeek's Add");
  button(page, "Add a DeepSeek key", addRow(page, "deepseek")).click();
  await until(() => page.document.querySelector(".routing-new-key"), "the new key form");
  // The card's own provider, under its own name: no provider to choose.
  assert.equal(page.document.querySelector(".routing-new-key select"), null);
  assert.equal(page.document.querySelector(".routing-new-key .routing-field input").value, "deepseek");
  await type(page, "New DeepSeek API key: value", SECRET);
  assert.ok(!html(page).includes(SECRET), "a typed key is the field's own value, not written into the page");
  assert.equal(field(page, "New DeepSeek API key: value").getAttribute("value"), null, "React never sets its value attribute");
  button(page, "Save", page.document.querySelector(".routing-new-key")).click();
  await until(() => row(page, "deepseek"), "the kept key's row");
  const put = page.calls.find((c) => c.method === "PUT");
  assert.deepEqual({ url: put.url, body: put.body }, { url: "/api/routing/keys/deepseek", body: { source: "local", provider: "deepseek", value: SECRET } });
  assert.ok(!html(page).includes(SECRET), "nor once kept");
  assert.ok([...page.document.querySelectorAll("input")].every((i) => i.value !== SECRET), "no field holds it");
  assert.equal(row(page, "deepseek").closest(".routing-provider").dataset.provider, "deepseek", "in DeepSeek's card");
  assert.equal(row(page, "deepseek").getAttribute("aria-label"), "DeepSeek API key (for OpenCode) · deepseek");
  assert.match(row(page, "deepseek").textContent, /^deepseek.*Set · /);
  assert.deepEqual(writes(page), ["PUT /api/routing/keys/deepseek"]);
  // The kept state is read again from Core and shown: still no value anywhere.
  assert.ok(page.calls.filter((c) => c.method === "GET" && c.url === "/api/routing/keys").length >= 2, "the keys read again after the save");
  nowhere(page, SECRET, put);
});

test("a refused key keeps its field for another try, and Core's words are shown", async () => {
  const server = core({ refuse: "The routing key id is taken by another provider" });
  const page = mount(server);
  await until(() => row(page, "anthropic"), "the 1Password key");
  // Replacing the 1Password key with a local one: its source's other button.
  button(page, "This host", row(page, "anthropic")).click();
  await until(() => field(page, "Anthropic API key (for Claude Code): value"), "the value field");
  await type(page, "Anthropic API key (for Claude Code): value", SECRET);
  button(page, "Save", row(page, "anthropic")).click();
  await until(() => row(page, "anthropic").querySelector('[role="alert"]'), "the refusal");
  assert.equal(row(page, "anthropic").querySelector('[role="alert"]').textContent, "The routing key id is taken by another provider");
  assert.equal(field(page, "Anthropic API key (for Claude Code): value").value, SECRET, "kept in the field to try again");
  assert.ok(!html(page).includes(SECRET), "still not in the page");
  assert.ok(!row(page, "anthropic").querySelector('[role="alert"]').textContent.includes(SECRET), "nor in the error shown");
  button(page, "Cancel", row(page, "anthropic")).click();
  await tick();
  assert.ok(!field(page, "Anthropic API key (for Claude Code): value"), "Cancel closes the field");
  assert.equal(row(page, "anthropic").querySelector(".routing-reference").textContent, "op://Vault/Anthropic API/credential", "the key is as it was");
  nowhere(page, SECRET, page.calls.find((c) => c.method === "PUT"));
});

test("no answer from Core: the error says so, the value stays in its field only, and goes on Cancel", async () => {
  const server = core();
  const page = mount({ route: (url, method, body) => (method === "PUT" ? "network" : server.route(url, method, body)) });
  await until(() => button(page, "Add a DeepSeek key"), "DeepSeek's Add");
  button(page, "Add a DeepSeek key", addRow(page, "deepseek")).click();
  await until(() => field(page, "New DeepSeek API key: value"), "the value field");
  await type(page, "New DeepSeek API key: value", SECRET);
  button(page, "Save", page.document.querySelector(".routing-new-key")).click();
  await until(() => addRow(page, "deepseek").querySelector('[role="alert"]'), "the error");
  assert.equal(addRow(page, "deepseek").querySelector('[role="alert"]').textContent, "No answer from Core over the network.");
  assert.equal(field(page, "New DeepSeek API key: value").value, SECRET, "kept in its own field to try again");
  nowhere(page, SECRET, page.calls.find((c) => c.method === "PUT"), "New DeepSeek API key: value");
  button(page, "Cancel", page.document.querySelector(".routing-new-key")).click();
  await tick();
  assert.equal(field(page, "New DeepSeek API key: value"), null, "the field is gone, and its value with it");
});

test("a 1Password key's row takes the token from the keys' read, not the slower op read (R1 42b80551)", async () => {
  const server = core();
  // op's version read never answers here, as a slow or failing op can.
  const page = mount({ route: (url, method, body) => (url.endsWith("/routing/1password") ? new Promise(() => {}) : server.route(url, method, body)) });
  await until(() => row(page, "anthropic"), "the 1Password key");
  assert.doesNotMatch(row(page, "anthropic").textContent, /token is not set/, "the token is set, as the keys' read says");
  assert.equal(button(page, "Check", row(page, "anthropic")).disabled, false, "Check can be pressed");
  button(page, "Check", row(page, "anthropic")).click();
  await until(() => /1Password has no/.test(row(page, "anthropic").textContent), "the check's answer");
  // A new token starts the checks over: the answer was the old token's.
  button(page, "Replace token").click();
  await until(() => field(page, "Service account token"), "the token field");
  await type(page, "Service account token", TOKEN);
  button(page, "Save", page.document.querySelector(".routing-op")).click();
  await until(() => !field(page, "Service account token"), "the token kept");
  assert.doesNotMatch(row(page, "anthropic").textContent, /1Password has no/, "the old token's answer is gone");
  nowhere(page, TOKEN, page.calls.find((c) => c.method === "PUT" && c.url.endsWith("/token")));
});

test("a 1Password key: Check says why it can't be read, in the page's language; its reference changes; Remove asks first", async () => {
  const server = core();
  const page = mount(server, "zh-Hans");
  await until(() => row(page, "anthropic"), "the 1Password key");
  button(page, "检查", row(page, "anthropic")).click();
  await until(() => /找不到/.test(row(page, "anthropic").textContent), "the check's answer");
  assert.match(row(page, "anthropic").querySelector(".settings-row-help").textContent, /1Password 里找不到 op:\/\/Vault\/Anthropic API\/credential/);
  button(page, "改引用", row(page, "anthropic")).click();
  await until(() => field(page, "Anthropic API key（Claude Code 用）: 1Password 引用"), "the reference field");
  await type(page, "Anthropic API key（Claude Code 用）: 1Password 引用", "vault/item");
  assert.ok(row(page, "anthropic").textContent.includes("引用以 op:// 开头"), "a reference that isn't one is marked");
  await type(page, "Anthropic API key（Claude Code 用）: 1Password 引用", "op://Vault/Anthropic/credential");
  button(page, "保存", row(page, "anthropic")).click();
  await until(() => row(page, "anthropic")?.querySelector(".routing-reference")?.textContent === "op://Vault/Anthropic/credential", "the new reference");
  assert.deepEqual(page.calls.find((c) => c.method === "PUT").body, { source: "1password", provider: "anthropic", reference: "op://Vault/Anthropic/credential" });
  button(page, "删除", row(page, "anthropic")).click();
  await until(() => row(page, "anthropic").querySelector(".settings-confirm"), "the confirmation");
  assert.deepEqual(writes(page), ["POST /api/routing/keys/anthropic/check", "PUT /api/routing/keys/anthropic"], "nothing removed before it is confirmed");
  button(page, "删除", row(page, "anthropic").querySelector(".settings-confirm")).click();
  await until(() => !row(page, "anthropic"), "the key gone");
  assert.deepEqual(writes(page).at(-1), "DELETE /api/routing/keys/anthropic");
});

test("the service account's token is write-only too; removing it asks first", async () => {
  const server = core({ token: { set: false } });
  const page = mount(server);
  await until(() => button(page, "Enter token"), "Enter token");
  assert.match(page.document.querySelector(".routing-op .settings-row-help").textContent, /The token is not set/);
  button(page, "Enter token").click();
  await until(() => field(page, "Service account token"), "the token field");
  await type(page, "Service account token", TOKEN);
  assert.ok(!html(page).includes(TOKEN));
  button(page, "Save", page.document.querySelector(".routing-op")).click();
  await until(() => button(page, "Remove token"), "the token kept");
  assert.deepEqual(page.calls.find((c) => c.method === "PUT").body, { value: TOKEN });
  assert.ok(!html(page).includes(TOKEN), "not in the page once kept");
  nowhere(page, TOKEN, page.calls.find((c) => c.method === "PUT"));
  button(page, "Remove token").click();
  await until(() => page.document.querySelector(".routing-op .settings-confirm"), "the confirmation");
  button(page, "Remove", page.document.querySelector(".routing-op .settings-confirm")).click();
  await until(() => button(page, "Enter token"), "the token removed");
  assert.deepEqual(writes(page), ["PUT /api/routing/1password/token", "DELETE /api/routing/1password/token"]);
});

test("claude-swap missing says why; its command changes and the accounts are read again; Codex homes are saved as a list", async () => {
  const server = core({ cswap: { command: "cswap", pinned: "1.0.0", unavailable: { code: "cswapMissing", message: "claude-swap (cswap) is not installed on this host", messageZh: "这台主机没装 claude-swap（cswap）" } } });
  const page = mount(server);
  await until(() => /not installed/.test(page.document.querySelector(".routing-cswap")?.textContent ?? ""), "why claude-swap can't be read");
  button(page, "Change", page.document.querySelector(".routing-cswap")).click();
  await until(() => field(page, "Command"), "the command field");
  server.state.cswap = { command: "/opt/cswap/bin/cswap", pinned: "1.0.0", accounts: [{ number: 3, fingerprint: "1122334455667788", active: false, label: EMAIL }] };
  await type(page, "Command", "/opt/cswap/bin/cswap");
  button(page, "Save", page.document.querySelector(".routing-cswap")).click();
  await until(() => /Account #3/.test(page.document.querySelector(".routing-cswap").textContent), "the accounts read again");
  assert.ok(!html(page).includes(EMAIL));
  const reads = page.calls.filter((c) => c.method === "GET" && c.url.endsWith("/routing/accounts")).length;
  assert.equal(reads, 2, "read once on opening, once after the command changed");

  button(page, "Edit accounts").click();
  await until(() => button(page, "Add an account"), "the homes form");
  button(page, "Add an account").click();
  await tick();
  await type(page, "Account 1: Id", "work");
  await type(page, "Account 1: Label", "Work");
  await type(page, "Account 1: Folder", "/home/fixture/.codex-work");
  button(page, "Save", page.document.querySelector(".routing-codex")).click();
  await until(() => page.document.querySelector(".routing-codex .routing-accounts"), "the saved homes");
  assert.deepEqual(page.calls.find((c) => c.url.endsWith("/routing/codex-homes")).body, { homes: [{ id: "work", label: "Work", home: "/home/fixture/.codex-work" }] });
  assert.deepEqual(writes(page), ["PUT /api/routing/cswap", "PUT /api/routing/codex-homes"]);
});

test("where the read is refused, the page says where keys are changed", async () => {
  const page = mount({ route: () => [403, { error: "These settings take no Agent credential: only the user's page changes them, on the computer or on the phone" }] });
  await until(() => page.document.querySelector(".routing-read-error"), "the refusal");
  assert.match(page.document.querySelector(".routing-read-error").textContent, /on the computer that runs Core or on the phone/);
  assert.ok(!page.document.querySelector(".settings-group"), "no rows to change");
});

// ---- YN-84 S3: a card per provider, and what references each login, account and key.

/** A Workspace with nothing set up: no key, no account, routing off; new Agents and review use Codex. */
const bare = (over = {}) => core({ keys: [], cswap: { command: "cswap", pinned: "1.0.0", accounts: [] }, homes: [],
  policy: { enabled: false, candidates: [] }, agentHarness: "codex", review: { harness: "codex", model: "gpt-6.1-sol" }, ...over });
/** Holds each of the page's reads until it is let go, to finish them in a chosen order. */
function gated(server) {
  const names = { "/api/routing/keys": "keys", "/api/routing/accounts": "accounts", "/api/routing/policy": "policy", "/api/agent-defaults": "agentDefaults", "/api/pr-reviews/settings": "review" };
  const waiting = new Map();
  return {
    route(url, method, body) {
      const name = method === "GET" && names[new URL(url, "http://isolated.test").pathname];
      if (!name) return server.route(url, method, body);
      return new Promise((resolve) => waiting.set(name, () => resolve(server.route(url, method, body))));
    },
    async release(name) {
      await until(() => waiting.has(name), `the ${name} read`);
      const go = waiting.get(name);
      waiting.delete(name);
      go();
      await tick();
    },
  };
}
/** Every request answered and drawn: nothing reading. */
async function settled(page) {
  await until(() => page.answered.length === page.calls.length && !page.document.querySelector('.routing-keys [role="status"]:not(.routing-notices)'), "every read done");
  await tick();
}

test("a card per provider, Claude's first: its logins then its API keys, each row with what references it", async () => {
  const page = mount(core({ homes: [{ id: "work", label: "Work", home: "/home/fixture/.codex-work" }],
    policy: { enabled: true, candidates: [...core().state.policy.candidates,
      { id: "cx", enabled: true, harness: "codex", model: "gpt-6.1-sol", credential: { kind: "codexHome", id: "work" }, conditions: [], unknown: "skip" }] } }));
  await until(() => cards(page).length === 3 && card(page, "anthropic").querySelector(".routing-refs li"), "the cards and their references");
  await settled(page);
  assert.deepEqual(cards(page), ["anthropic", "openai", "deepseek"]);
  assert.deepEqual(others(page), [], "every known provider is set up here");
  const heads = (id) => [card(page, id).querySelector("h4"), card(page, id).querySelector(".routing-provider-sub"), card(page, id).querySelector(".routing-provider-refs")].map(words);
  assert.deepEqual(heads("anthropic"), ["Claude", "Anthropic · Claude Code and OpenCode can use it", "Referenced in 2 places · 1 more off"]);
  assert.deepEqual(heads("openai"), ["OpenAI / Codex", "OpenAI · Codex and OpenCode can use it", "Referenced in 2 places"]);
  assert.deepEqual(heads("deepseek"), ["DeepSeek", "An OpenCode provider · OpenCode can use it", "Referenced in 1 place"]);
  for (const id of cards(page)) {
    assert.deepEqual([...card(page, id).querySelectorAll(".routing-layer-title")].map(words), ["Logins", "API keys"], `${id}: two layers`);
  }
  // Claude: the host's login (review), claude-swap (the pool), then its key, referenced only by a candidate turned off.
  const claude = card(page, "anthropic");
  assert.deepEqual([...claude.querySelectorAll('[data-layer="logins"] > .settings-row')].map((r) => r.className.split(" ")[1]), ["routing-host", "routing-cswap"]);
  assert.deepEqual(refsIn(claude), [["Review · opus"], ["Routing #2 Claude Code · opus"], ["~Routing #3 Claude Code · opus · API (off)"]]);
  assert.ok(claude.querySelector('[data-layer="keys"] .routing-key[data-key="anthropic"]'), "the Anthropic key is in Claude's keys");
  // OpenAI / Codex: the host's login (the new Agent defaults), and each Codex home with what references it.
  assert.deepEqual(refsIn(card(page, "openai")), [["New Agent default"], ["Routing #4 Codex · gpt-6.1-sol"]]);
  assert.ok(card(page, "openai").querySelector('.routing-codex .routing-accounts li .routing-refs'), "under its home");
  // DeepSeek: OpenCode's own login, and no key yet.
  const deepseek = card(page, "deepseek");
  assert.deepEqual(refsIn(deepseek), [["Routing #1 OpenCode · deepseek-flash"]]);
  assert.equal(words(deepseek.querySelector(".routing-opencode .settings-row-title")), "OpenCode's own login");
  assert.equal(words(addRow(page, "deepseek").querySelector(".settings-row-help")), "No key yet.");
  // The references' reach, always said; then where keys come from, and who can change them.
  assert.equal(words(page.document.querySelector(".routing-refs-scope")), "“Referenced by” covers Workspace settings only: routing candidates, the new Agent defaults and review. It leaves out projects' own settings and doesn't mean an executor is using it now.");
  assert.deepEqual([...page.document.querySelectorAll(".routing-sources .settings-row")].map((r) => r.className.split(" ")[1]), ["routing-op", "routing-store", "routing-boundary"]);
  assert.match(words(page.document.querySelector(".routing-boundary")), /an Agent's token cannot/);
  assert.deepEqual(notices(page), []);
  // References are words: nothing in them can be pressed.
  assert.equal(page.document.querySelectorAll(".routing-refs a, .routing-refs button").length, 0);
  assert.deepEqual(page.errors, []);
});

test("in Chinese: the same cards, layers and references", async () => {
  const page = mount(core(), "zh-Hans");
  await until(() => cards(page).length === 3 && card(page, "anthropic").querySelector(".routing-refs li"), "the cards");
  await settled(page);
  assert.equal(words(card(page, "anthropic").querySelector(".routing-provider-sub")), "Anthropic · Claude Code、OpenCode 能用");
  assert.equal(words(card(page, "anthropic").querySelector(".routing-provider-refs")), "2 处引用 · 另有 1 处停用");
  assert.deepEqual([...card(page, "deepseek").querySelectorAll(".routing-layer-title")].map(words), ["登录", "API key"]);
  assert.deepEqual(refsIn(card(page, "anthropic")), [["审查 · opus"], ["路由 #2 Claude Code · opus"], ["~路由 #3 Claude Code · opus · API（停用）"]]);
  assert.equal(words(page.document.querySelector(".routing-sources .settings-group-title")), "密钥从哪来");
  assert.ok(button(page, "添加 DeepSeek 的 key"), "each provider adds its own key");
});

test("routing off: its candidates are listed muted and not counted", async () => {
  const page = mount(core({ policy: { ...core().state.policy, enabled: false } }));
  await until(() => notices(page).length, "the notice");
  await settled(page);
  assert.deepEqual(notices(page), ["Executor routing is off: its candidates aren't used now."]);
  assert.equal(words(card(page, "anthropic").querySelector(".routing-provider-refs")), "Referenced in 1 place · 2 more off");
  assert.deepEqual(refsIn(card(page, "anthropic")), [["Review · opus"], ["~Routing #2 Claude Code · opus (routing off)"], ["~Routing #3 Claude Code · opus · API (routing off)"]]);
  assert.equal(words(card(page, "deepseek").querySelector(".routing-provider-refs")), "Referenced in 0 places · 1 more off");
});

test("a new Workspace: only what is set up has a card; another provider opens empty, until the page is opened again", async () => {
  const page = mount(bare());
  await until(() => others(page).length, "the other providers");
  await settled(page);
  assert.deepEqual(cards(page), ["openai"], "new Agents and review use Codex's host login");
  assert.deepEqual(others(page), ["Claude", "DeepSeek"]);
  assert.equal(words(page.document.querySelector(".routing-others .settings-row-meta")), "Not set up yet; open one to add a key or account.");
  assert.equal(words(card(page, "openai").querySelector(".routing-provider-refs")), "Referenced in 2 places");
  assert.deepEqual(refsIn(card(page, "openai")), [["New Agent default", "Review · gpt-6.1-sol"]]);
  button(page, "DeepSeek", page.document.querySelector(".routing-others")).click();
  await until(() => card(page, "deepseek"), "DeepSeek's card");
  assert.deepEqual(cards(page), ["openai", "deepseek"]);
  assert.deepEqual(others(page), ["Claude"]);
  const deepseek = card(page, "deepseek");
  assert.equal(words(deepseek.querySelector(".routing-no-login")), "No login to manage here. A routing candidate that reaches DeepSeek with OpenCode's own login is listed here.");
  assert.equal(words(deepseek.querySelector(".routing-provider-refs")), "Not referenced");
  assert.ok(button(page, "Add a DeepSeek key", addRow(page, "deepseek")), "its key can be added");
  // Claude opened shows claude-swap, with its Change.
  button(page, "Claude", page.document.querySelector(".routing-others")).click();
  await until(() => card(page, "anthropic"), "Claude's card");
  assert.deepEqual(cards(page), ["anthropic", "openai", "deepseek"]);
  assert.equal(page.document.querySelector(".routing-others"), null, "nothing left to open");
  assert.equal(words(card(page, "anthropic").querySelector(".routing-cswap .settings-row-help")), "claude-swap lists no account.");
  assert.ok(button(page, "Change", card(page, "anthropic").querySelector(".routing-cswap")));
  // Opened again, the page starts from what is set up.
  page.window.renderKeys(false);
  await tick();
  page.window.renderKeys(true);
  await until(() => cards(page).join() === "openai" && others(page).length === 2, "the cards from what is set up");
  assert.deepEqual(page.errors, []);
});

test("the accounts still reading or failed: Claude's and OpenAI's cards stay, with the error and Read again", async () => {
  const server = bare();
  let release = null;
  const page = mount({ route: (url, method, body) => (!release && url.endsWith("/routing/accounts")
    ? new Promise((resolve) => { release = () => resolve(server.route(url, method, body)); }) : server.route(url, method, body)) });
  await until(() => cards(page).length === 3 && page.document.querySelector(".routing-codex [role=status]"), "the cards while the accounts are read");
  assert.deepEqual(cards(page), ["anthropic", "openai", "deepseek"], "nothing hidden while unsure");
  assert.deepEqual(others(page), []);
  assert.equal(words(page.document.querySelector(".routing-cswap [role=status]")), "Reading…");
  assert.equal(words(page.document.querySelector(".routing-codex [role=status]")), "Reading…");
  await until(() => words(card(page, "openai").querySelector(".routing-provider-refs")) === "Referenced in 2 places · maybe more", "OpenAI's count, maybe short");
  assert.equal(words(card(page, "anthropic").querySelector(".routing-provider-refs")), "Not referenced");
  // The read fails: both cards, the error in both rows, and Read again.
  server.state.fail.add("accounts");
  release();
  await until(() => page.document.querySelector(".routing-codex .inline-error"), "the error");
  assert.deepEqual(cards(page), ["anthropic", "openai", "deepseek"]);
  assert.equal(words(page.document.querySelector(".routing-cswap .inline-error")), "claude-swap can't be read now");
  assert.equal(words(page.document.querySelector(".routing-codex .inline-error")), "claude-swap can't be read now");
  assert.equal(page.document.querySelector(".routing-cswap").textContent.includes("Below is what was read before."), false, "nothing was read before");
  const again = button(page, "Read again", page.document.querySelector(".routing-cswap"));
  assert.equal(again.disabled, false);
  assert.ok(button(page, "Read again", page.document.querySelector(".routing-codex")), "the Codex row has it too");
  server.state.fail.delete("accounts");
  again.click();
  // Read now: nothing set up for Claude, so its card goes back to the other providers.
  await until(() => cards(page).join() === "openai", "the cards from the accounts read");
  assert.deepEqual(others(page), ["Claude", "DeepSeek"]);
  assert.deepEqual(page.errors, []);
});

test("an empty list read, then the page opened again and the refresh failing: the cards, the error and Read again are there", async () => {
  const server = bare();
  const page = mount(server);
  await until(() => others(page).length === 2, "the cards from an empty list");
  await settled(page);
  assert.deepEqual(cards(page), ["openai"]);
  page.window.renderKeys(false);
  await tick();
  server.state.fail.add("accounts");
  page.window.renderKeys(true);
  await until(() => page.document.querySelector(".routing-cswap .inline-error"), "the error");
  assert.deepEqual(cards(page), ["anthropic", "openai", "deepseek"]);
  const cswap = page.document.querySelector(".routing-cswap");
  assert.equal(words(cswap.querySelector(".inline-error")), "claude-swap can't be read now");
  assert.match(words(cswap), /Below is what was read before\..*claude-swap lists no account\./, "the empty list, said to be the last read");
  assert.match(words(page.document.querySelector(".routing-codex")), /Below is what was read before\..*No other account\./);
  server.state.fail.delete("accounts");
  button(page, "Read again", cswap).click();
  await until(() => cards(page).join() === "openai", "read again");
  assert.equal(page.document.querySelector(".routing-codex .inline-error"), null);
});

test("the reads finishing in any order end in the same cards", async () => {
  const fixture = () => bare({ keys: [{ id: "deepseek-main", provider: "deepseek", source: "local", set: true, setAt: "2026-11-08T03:00:00Z" }],
    agentHarness: "claude", review: { harness: "claude", model: "opus" } });
  const finals = [];
  for (const order of [["accounts", "policy", "agentDefaults", "review"], ["review", "agentDefaults", "policy", "accounts"], ["policy", "accounts", "review", "agentDefaults"]]) {
    const server = gated(fixture());
    const page = mount(server);
    await server.release("keys");
    await until(() => cards(page).length === 3, "the cards while unsure");
    assert.deepEqual(others(page), [], `${order}: nothing hidden while unsure`);
    for (const name of order) await server.release(name);
    await until(() => cards(page).length === 2, `${order}: the cards once all is read`);
    await settled(page);
    finals.push(JSON.stringify({ cards: cards(page), others: others(page), heads: cards(page).map((id) => words(card(page, id).querySelector(".routing-provider-refs"))) }));
  }
  assert.deepEqual(finals.map((f) => JSON.parse(f)), Array(3).fill({ cards: ["anthropic", "deepseek"], others: ["OpenAI / Codex"], heads: ["Referenced in 2 places", "Not referenced"] }));
});

test("what can't be read is said, not counted as no reference; a refresh that fails keeps what was read", async () => {
  const server = bare();
  server.state.fail.add("policy");
  server.state.fail.add("review");
  const page = mount(server);
  await until(() => notices(page).length, "the notice");
  assert.deepEqual(notices(page), ["Couldn't read the routing order and the review settings: references may be missing."]);
  await settled(page);
  assert.deepEqual(cards(page), ["anthropic", "openai", "deepseek"], "nothing hidden while unsure");
  assert.equal(words(card(page, "anthropic").querySelector(".routing-provider-refs")), "References: not all read");
  assert.equal(words(card(page, "openai").querySelector(".routing-provider-refs")), "Referenced in 1 place · maybe more");
  assert.deepEqual(refsIn(card(page, "anthropic"))[0], "References: not all read", "a row with none says so");

  // A credential this version can't tell, and a reviewer it doesn't know.
  const odd = mount(core({ policy: { enabled: true, candidates: [{ id: "odd", enabled: true, harness: "claude", model: "opus", credential: { kind: "passkey" }, conditions: [], unknown: "skip" }] },
    review: { harness: "gemini", model: "g-1" } }));
  await until(() => notices(odd).length, "the notice");
  assert.deepEqual(notices(odd), ["This version can't tell what routing #1 and the review (harness gemini) uses; it isn't counted."]);
  await settled(odd);
  assert.deepEqual(cards(odd), ["anthropic", "openai", "deepseek"]);
  assert.equal(words(card(odd, "deepseek").querySelector(".routing-provider-refs")), "References: not all read");

  // Read once, then a credential changes and the routing can't be read again: what was read stays, said to be so.
  const fresh = core();
  const kept = mount(fresh);
  await until(() => card(kept, "anthropic")?.querySelector(".routing-cswap .routing-refs li"), "the references");
  await settled(kept);
  fresh.state.fail.add("policy");
  kept.window.dispatchEvent(new kept.window.Event("yuzuno:routing-credentials-changed"));
  await until(() => notices(kept).length, "the stale notice");
  assert.deepEqual(notices(kept), ["Couldn't refresh the routing order; showing what was read before."]);
  assert.deepEqual(refsIn(card(kept, "anthropic"))[1], ["Routing #2 Claude Code · opus"]);
  assert.equal(words(card(kept, "anthropic").querySelector(".routing-provider-refs")), "Referenced in 2 places · 1 more off");
});

test("each provider adds its own key: no id, source or value crosses to another's form", async () => {
  const server = core();
  const page = mount(server);
  await until(() => button(page, "Add an Anthropic key"), "Claude's Add");
  button(page, "Add an Anthropic key", addRow(page, "anthropic")).click();
  await until(() => field(page, "New Anthropic API key: value"), "Anthropic's form");
  const form = () => page.document.querySelector(".routing-new-key");
  const idField = () => form().querySelector(".routing-new-key-grid input");
  assert.equal(idField().value, "anthropic-2", "the first id free for it");
  await type(page, "New Anthropic API key: value", SECRET);
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(idField(), "anthropic-work");
  idField().dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await tick();
  // DeepSeek's Add, with Anthropic's form open: one edit at a time, and DeepSeek's own form.
  button(page, "Add a DeepSeek key", addRow(page, "deepseek")).click();
  await until(() => field(page, "New DeepSeek API key: value"), "DeepSeek's form");
  assert.equal(page.document.querySelectorAll(".routing-new-key").length, 1, "one form open");
  assert.equal(form().closest(".routing-provider").dataset.provider, "deepseek");
  assert.equal(field(page, "New Anthropic API key: value"), null, "Anthropic's form is gone, its value with it");
  assert.equal(idField().value, "deepseek", "DeepSeek's own id");
  assert.equal(field(page, "New DeepSeek API key: value").value, "", "an empty value field");
  assert.equal(button(page, "This host", form()).getAttribute("aria-pressed"), "true", "this host's store, as a new form starts");
  // A 1Password reference typed in DeepSeek's, cancelled; Anthropic's opened again starts empty too.
  button(page, "1Password", form()).click();
  await until(() => field(page, "New DeepSeek API key: 1Password reference"), "the reference field");
  await type(page, "New DeepSeek API key: 1Password reference", "op://Vault/DeepSeek/credential");
  button(page, "Cancel", form()).click();
  await until(() => !form(), "the form closed");
  button(page, "Add an Anthropic key", addRow(page, "anthropic")).click();
  await until(() => field(page, "New Anthropic API key: value"), "Anthropic's form again");
  assert.equal(idField().value, "anthropic-2");
  assert.equal(field(page, "New Anthropic API key: value").value, "");
  assert.equal(button(page, "This host", form()).getAttribute("aria-pressed"), "true");
  assert.deepEqual(writes(page), [], "nothing was saved");
  nowhere(page, SECRET, null);
  assert.ok(!html(page).includes("op://Vault/DeepSeek/credential"), "nor the reference typed in DeepSeek's form");
});
