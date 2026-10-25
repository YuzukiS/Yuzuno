// MCP services in Settings → Runtime & versions (T-191): one Claude Code
// Agent at a time, opened with what its last read found (?cached=true asks
// nothing); only Refresh asks that session. Offline is said as offline, an
// old observation as old, and other harnesses are named, not guessed.
// Fixture HTTP only; no Core.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { unmanagedUpdates } from "./browser-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(root, ".runtime-mcp-test-"));
let bundle;
try {
  const entry = path.join(temporary, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceUpdatesHost} from ${JSON.stringify(path.join(root, "src/WorkspaceUpdates.tsx"))};
const root = createRoot(document.getElementById('root'));
const navigation = { agents: [], projects: [], onNavigate: () => {} };
window.renderSettings = () => root.render(<WorkspaceUpdatesHost enabled open onOpenChange={() => {}}
  onNeedsReloadChange={() => {}} preserveDrafts={() => {}} navigation={navigation}/>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { write: false, lib: { entry, name: "RuntimeMcpTest", formats: ["iife"] } } });
  bundle = (Array.isArray(built) ? built[0] : built).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(check, message) {
  for (let n = 0; n < 300; n++) { const result = check(); if (result) return result; await tick(); }
  assert.fail(message);
}
const agent = (id, name, extra = {}) => ({
  id, name, harness: "claude", cwd: "/work", model: "sonnet", status: "idle", connectionState: "connected",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, ...extra,
});
const agents = [
  agent("mori", "Mori"),
  agent("ume", "Ume", { connectionState: "disconnected" }),
  agent("kaki", "Kaki", { remote: { machine: { id: "box", name: "Build box", target: "builder@box.example.test", codex: "codex", defaultCwd: "/srv" } } }),
  agent("yuzu", "Yuzu", { harness: "codex" }),
  agent("nashi", "Nashi", { closedAt: "2026-10-24T00:00:00Z" }),
];
const view = (state, reason, observation = null) => ({
  state, reason, generation: 1, sessionId: "s", checkedAt: observation?.observedAt ?? null,
  observation, stale: state !== "ready", freshForSeconds: 60,
});
const observed = (at, servers) => ({ observedAt: at, servers, total: servers.length, truncated: false });
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

function mount(t, mcp) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const calls = [];
  const answers = {
    "/api/updates": unmanagedUpdates,
    "/api/health": { version: "2026.10.24-core.17", releaseId: "core-20261024-c215011", apiReady: true, storageReady: true },
    "/api/machines": { machines: [] },
    "/api/workspace": { agents, defaultCwd: "/work", runtime: { connected: true } },
    "/api/jobs/budget": { machine: { name: "Core host" } },
  };
  window.fetch = async (url, init = {}) => {
    const where = new URL(url, "http://isolated.test");
    const call = `${init.method ?? "GET"} ${where.pathname}${where.search}`;
    calls.push(call);
    const match = where.pathname.match(/^\/api\/agents\/([^/]+)\/claude\/mcp-status$/);
    const value = match ? mcp(match[1], init.method ?? "GET", where.search) : answers[where.pathname];
    if (value === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '{"error":"not in this fixture"}' };
    return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
  };
  window.eval(bundle);
  window.renderSettings();
  const document = window.document;
  const page = {
    window, document, calls, errors,
    group: () => document.querySelector("#settings-runtime .runtime-mcp"),
    button: (label) => [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === label || item.getAttribute("aria-label") === label),
    mcpCalls: () => calls.filter((c) => c.includes("/claude/mcp-status")),
    async choose(id) {
      const select = page.group().querySelector("select");
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(select, id);
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await tick();
    },
  };
  page.open = async () => {
    (await until(() => page.button("Open Runtime & versions"), "Updates & about offers Runtime & versions")).click();
    return until(() => page.group(), "the MCP services group");
  };
  return page;
}

test("an Agent never read shows nothing observed and asks nothing; Refresh asks its session once and shows when", async (t) => {
  let refreshed = false;
  const page = mount(t, (id, method, search) => {
    if (method === "POST") { refreshed = true; return view("ready", "observed", observed(new Date().toISOString(), [{ name: "docs", status: "connected" }, { name: "tracker", status: "needs-auth" }])); }
    assert.equal(search, "?cached=true", "opening reads only what the last read found");
    return view("unknown", "not_observed");
  });
  const group = await page.open();
  await until(() => /has not been checked/.test(group.textContent), "the not-observed note");
  // Only open Claude Code Agents are offered, each with its machine.
  assert.deepEqual([...group.querySelectorAll("option")].map((o) => o.textContent), ["Mori · Core host", "Ume · Core host", "Kaki · Build box"]);
  assert.match(group.querySelector("h5").textContent, /Mori · Core host/);
  assert.match(group.textContent, /1 Codex or OpenCode Agent: these don.t report MCP status/);
  assert.deepEqual(page.mcpCalls(), ["GET /api/agents/mori/claude/mcp-status?cached=true"]);
  page.button("Refresh MCP status").click();
  await until(() => refreshed && group.querySelector(".mcp-server-list"), "the refreshed report");
  assert.match(group.textContent, /Observed ·/);
  assert.deepEqual([...group.querySelectorAll(".mcp-server-state")].map((s) => s.textContent), ["Connected", "Needs authentication"]);
  assert.deepEqual(page.mcpCalls(), ["GET /api/agents/mori/claude/mcp-status?cached=true", "POST /api/agents/mori/claude/mcp-status"]);
  assert.ok(!page.calls.some((c) => /\/agents\/(yuzu|nashi)\//.test(c)), "no request for a Codex or closed Agent");
  assert.deepEqual(page.errors, []);
});

test("switching Agents shows each one's own last report: old as old, offline as offline, a remote one as not available", async (t) => {
  const old = minutesAgo(30);
  const page = mount(t, (id, method) => {
    assert.equal(method, "GET", "nothing is refreshed without a click");
    if (id === "mori") return view("stale", "expired", observed(old, [{ name: "docs", status: "connected" }]));
    if (id === "ume") return view("unavailable", "not_connected", observed(old, [{ name: "docs", status: "connected" }]));
    return view("unavailable", "remote_unavailable");
  });
  const group = await page.open();
  await until(() => group.querySelector(".mcp-observed"), "Mori's old report");
  assert.match(group.querySelector(".mcp-observed").textContent, /^Previous observation/);
  assert.match(group.textContent, /over a minute old/);
  assert.equal(group.querySelector(".mcp-server-list").dataset.stale, "true");
  assert.equal(group.querySelector(".mcp-server-state").dataset.state, "unknown", "an old Connected is not shown as connected now");

  await page.choose("ume");
  await until(() => /Ume · Core host/.test(group.querySelector("h5").textContent) && /disconnected/.test(group.textContent), "Ume's report");
  assert.match(group.textContent, /Claude Code is disconnected or has not started/);
  assert.doesNotMatch(group.textContent, /signed out|logged out/i, "offline is not said as signed out");
  assert.equal(page.button("Refresh MCP status").disabled, true, "an offline session is not asked");

  await page.choose("kaki");
  await until(() => /unavailable for this remote runtime/.test(group.textContent), "Kaki's remote note");
  assert.equal(group.querySelector(".mcp-server-list"), null);
  assert.deepEqual(page.mcpCalls(), [
    "GET /api/agents/mori/claude/mcp-status?cached=true",
    "GET /api/agents/ume/claude/mcp-status?cached=true",
    "GET /api/agents/kaki/claude/mcp-status?cached=true",
  ]);
  assert.deepEqual(page.errors, []);
});

test("a refresh that fails keeps the previous report marked as previous and says it couldn't read", async (t) => {
  const page = mount(t, (id, method) => (method === "POST"
    ? view("failed", "read_failed", observed(minutesAgo(5), [{ name: "docs", status: "connected" }]))
    : view("ready", "observed", observed(new Date().toISOString(), [{ name: "docs", status: "connected" }]))));
  const group = await page.open();
  await until(() => /Observed ·/.test(group.textContent), "the current report");
  page.button("Refresh MCP status").click();
  await until(() => /Previous observation/.test(group.textContent), "the failed refresh");
  assert.match(group.textContent, /Could not read MCP status|Claude Code reported|Try refreshing/);
});
