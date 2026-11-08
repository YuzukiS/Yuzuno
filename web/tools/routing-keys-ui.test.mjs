// YN-49 S4a: Settings → Executor routing → Accounts and keys, on S1's routes
// (docs/executor-routing.md). A key's value is write-only: it is sent in one
// request body and never appears in the page, before or after it is kept; an
// account is named by its number and fingerprint, never its label or email.
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
const fixture = await mkdtemp(path.join(cache, "routing-keys-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RoutingKeys} from ${JSON.stringify(path.join(root, "src", "RoutingKeys.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderKeys=()=>root.render(<RoutingKeys active/>);`);
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
  while (!check()) {
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
    ...over,
  };
  const view = (k) => ({ ...k });
  return { state, route(url, method, body) {
    const p = new URL(url, "http://isolated.test").pathname;
    if (p === "/api/routing/keys" && method === "GET") return [200, { keys: state.keys.map(view), onePasswordToken: state.token }];
    if (p === "/api/routing/1password" && method === "GET") return [200, { token: state.token, op: state.op }];
    if (p === "/api/routing/accounts" && method === "GET") return [200, { cswap: state.cswap, codexHomes: state.homes }];
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
    // No answer at all, as a browser's fetch rejects: with the page's own TypeError.
    if (answer === "network") throw new window.TypeError("Failed to fetch");
    const [status, value] = answer;
    return { ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) };
  };
  window.eval(bundle);
  window.renderKeys();
  return { window, document: window.document, calls, errors, logged };
}
const html = (page) => page.document.documentElement.outerHTML;
const button = (page, label, within = page.document) =>
  [...within.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
const field = (page, label) => page.document.querySelector(`[aria-label="${label}"]`);
const row = (page, id) => page.document.querySelector(`.routing-key[data-key="${id}"]`);
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
function nowhere(page, secret, ownWrite) {
  const { window, document } = page;
  assert.ok(!document.documentElement.outerHTML.includes(secret), "not in the page's markup");
  for (const input of document.querySelectorAll("input")) {
    assert.notEqual(input.value, secret, "no field holds it");
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
  await until(() => button(page, "Add a key"), "Add a key");
  button(page, "Add a key", page.document.querySelector(".routing-add-key .settings-row-action")).click();
  await until(() => page.document.querySelector(".routing-new-key"), "the new key form");
  // The first provider without a key, under its own name.
  assert.equal(page.document.querySelector(".routing-new-key select").value, "deepseek");
  assert.equal(page.document.querySelector(".routing-new-key .routing-field input").value, "deepseek");
  await type(page, "DeepSeek API key (for OpenCode): value", SECRET);
  assert.ok(!html(page).includes(SECRET), "a typed key is the field's own value, not written into the page");
  assert.equal(field(page, "DeepSeek API key (for OpenCode): value").getAttribute("value"), null, "React never sets its value attribute");
  button(page, "Save", page.document.querySelector(".routing-new-key")).click();
  await until(() => row(page, "deepseek"), "the kept key's row");
  const put = page.calls.find((c) => c.method === "PUT");
  assert.deepEqual({ url: put.url, body: put.body }, { url: "/api/routing/keys/deepseek", body: { source: "local", provider: "deepseek", value: SECRET } });
  assert.ok(!html(page).includes(SECRET), "nor once kept");
  assert.ok([...page.document.querySelectorAll("input")].every((i) => i.value !== SECRET), "no field holds it");
  assert.match(row(page, "deepseek").textContent, /DeepSeek API key \(for OpenCode\).*Set · /);
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
  await until(() => button(page, "Add a key"), "Add a key");
  button(page, "Add a key", page.document.querySelector(".routing-add-key .settings-row-action")).click();
  await until(() => field(page, "DeepSeek API key (for OpenCode): value"), "the value field");
  await type(page, "DeepSeek API key (for OpenCode): value", SECRET);
  button(page, "Save", page.document.querySelector(".routing-new-key")).click();
  await until(() => page.document.querySelector('.routing-add-key [role="alert"]'), "the error");
  assert.equal(page.document.querySelector('.routing-add-key [role="alert"]').textContent, "No answer from Core over the network.");
  nowhere(page, SECRET, page.calls.find((c) => c.method === "PUT"));
  button(page, "Cancel", page.document.querySelector(".routing-new-key")).click();
  await tick();
  assert.equal(field(page, "DeepSeek API key (for OpenCode): value"), null, "the field is gone, and its value with it");
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

test("where the routes refuse (the phone entry), the page says where keys are changed", async () => {
  const page = mount({ route: () => [403, { error: "Proxied request: a phone uses Core's remote entry" }] });
  await until(() => page.document.querySelector(".routing-read-error"), "the refusal");
  assert.match(page.document.querySelector(".routing-read-error").textContent, /only from your own browser on this computer/);
  assert.equal(page.document.querySelector(".settings-group"), null, "no rows to change");
});
