// Runtime & versions in Settings (T-191, on the T-187 settings center): it is
// opened from Updates & about, reads nothing before that, then only GETs; its
// "Check machines" hands over to the Machines page. Fixture HTTP only; no Core.
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
const temporary = await mkdtemp(path.join(root, ".runtime-settings-test-"));
let bundle;
try {
  const entry = path.join(temporary, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceUpdatesHost} from ${JSON.stringify(path.join(root, "src/WorkspaceUpdates.tsx"))};
const root = createRoot(document.getElementById('root'));
window.destinations = [];
const navigation = { agents: [], projects: [], onNavigate: (destination) => window.destinations.push(destination) };
window.renderSettings = () => root.render(<WorkspaceUpdatesHost enabled open onOpenChange={() => {}}
  onNeedsReloadChange={() => {}} preserveDrafts={() => {}} navigation={navigation}/>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { write: false, lib: { entry, name: "RuntimeSettingsTest", formats: ["iife"] } } });
  bundle = (Array.isArray(built) ? built[0] : built).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(check, message) {
  for (let n = 0; n < 300; n++) { const result = check(); if (result) return result; await tick(); }
  assert.fail(message);
}
const answers = {
  "/api/updates": unmanagedUpdates,
  "/api/health": { version: "2026.10.24-core.17", releaseId: "core-20261024-c215011", apiReady: true, storageReady: true },
  "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/work", lastCheck: null }] },
  "/api/workspace": { agents: [], defaultCwd: "/work", runtime: { connected: true, account: "person@example.test" } },
  "/api/jobs/budget": { machine: { name: "Core host", scope: "Only jobs managed by this Core share this budget." } },
};

test("Runtime & versions opens from Updates & about, reads only once opened and only GETs, and leaves checks to Machines", async (t) => {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><head><meta name="yuzuno-release" content="core-20261024-c215011"></head><body><div id="root"></div></body></html>',
    { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  t.after(() => dom.window.close());
  const { window } = dom;
  const document = window.document;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const calls = [];
  window.fetch = async (url, init = {}) => {
    const path = new URL(url, "http://isolated.test").pathname;
    calls.push(`${init.method ?? "GET"} ${path}`);
    const value = answers[path];
    if (value === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '{"error":"not in this fixture"}' };
    return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
  };
  window.eval(bundle);
  window.renderSettings();
  const button = (text) => [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === text);
  const open = await until(() => button("Open Runtime & versions"), "Updates & about offers Runtime & versions");
  const runtimeReads = () => calls.filter((c) => /\/api\/(health|machines|workspace|jobs\/budget)$/.test(c));
  assert.deepEqual(runtimeReads(), [], "nothing of it is read before it is opened");
  open.click();
  const section = await until(() => document.querySelector("#settings-runtime .runtime-fact"), "the section shows its facts")
    && document.querySelector("#settings-runtime");
  const version = [...section.querySelectorAll(".runtime-fact")].find((row) => row.querySelector("dt").textContent === "Version");
  assert.equal(version.querySelector(".runtime-text").textContent, "2026.10.24-core.17");
  assert.deepEqual([...runtimeReads()].sort(), ["GET /api/health", "GET /api/jobs/budget", "GET /api/machines", "GET /api/workspace"]);
  button("Check machines").click();
  assert.deepEqual([...window.destinations].map((d) => d.kind), ["machines"], "a check is the Machines page's");
  assert.ok(calls.every((c) => c.startsWith("GET ")), `only reads: ${calls.filter((c) => !c.startsWith("GET ")).join(", ")}`);
  assert.ok(!calls.some((c) => /\/check$|\/models$|\/usage$|\/mcp/.test(c)), "no check, model list, usage or MCP request");
  assert.deepEqual(errors, []);
});
