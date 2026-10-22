import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { composerText } from "./composer-driver.mjs";
import { uiTestBundle } from "./ui-test-bundle.mjs";
import { installConnectionFixture } from "./connection-fixture.mjs";
import { build } from "vite";

const dist = pathToFileURL(resolve(process.env.YUZUNO_UI_DIST || "dist") + "/");
const index = await readFile(new URL("index.html", dist), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)[1];
const bundle = await uiTestBundle(new URL(entry, dist));
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await pause(15); }
  assert.ok(check(), "condition should settle");
}
async function mount() {
  const errors = [], vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4391/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function() {};
  w.HTMLElement.prototype.scrollTo = function() {};
  w.localStorage.setItem("yuzuno.drafts", JSON.stringify({ a: "保留我的草稿", b: "Keep Claude draft" }));
  w.eval(`(${installConnectionFixture.toString()})({deadlineMs: 180})`);
  w.eval(bundle);
  const d = w.document, f = w.connectionFixture;
  await until(() => d.querySelector(".prose")?.textContent.includes("initial fixture reply"));
  return { w, d, f, errors, close: () => w.close() };
}
function core(p, label) {
  // The toolbar is the one Core indicator; the bottom bar no longer repeats it.
  const indicators = [...p.d.querySelectorAll("[data-core-status]")];
  assert.equal(indicators.length, 1);
  for (const indicator of indicators) assert.equal(indicator.dataset.coreStatus, label);
  assert.ok(p.d.querySelector(".workspace-scope [role=img]").getAttribute("aria-label").startsWith(`${label}.`));
}
function retained(p) {
  assert.match(p.d.querySelector(".conversation-scroll").textContent, /fixture reply/);
  assert.equal(composerText(p.d.querySelector("[data-composer-input]")), "保留我的草稿");
  assert.equal(p.d.querySelector(".catchup-nav .nav-count.attention")?.textContent, "1");
  assert.equal(p.f.calls.filter(c => c.method !== "GET").length, 0);
  assert.equal(p.f.calls.filter(c => /models|machines|reconnect|interrupt/.test(c.path)).length, 0);
  assert.deepEqual(p.errors, []);
}

test("Codex catalog failure leaves Core connected and Claude usable; all indicators agree", async () => {
  const p = await mount();
  try {
    p.f.scenario("catalog");
    await until(() => p.d.body.textContent.includes("Simulated Codex catalog failure"));
    core(p, "Core connected"); retained(p);
    [...p.d.querySelectorAll("button")].find(b => b.textContent.includes("Claude fixture")).click();
    await until(() => p.d.querySelector(".prose")?.textContent.startsWith("Claude fixture"));
    assert.equal(composerText(p.d.querySelector("[data-composer-input]")), "Keep Claude draft");
    core(p, "Core connected");
    assert.equal(p.f.calls.filter(c => c.method !== "GET").length, 0);
  } finally { p.close(); }
});
test("SSE failure is separate from HTTP; quiet open streams stay healthy; reopening refreshes", async () => {
  const p = await mount();
  try {
    await pause(220); // No business events, including beyond the test read deadline.
    core(p, "Core connected");
    assert.ok(p.d.querySelector(".event-connection-banner") === null, ".event-connection-banner is absent");
    p.f.scenario("sse");
    await until(() => p.d.querySelector(".event-connection-banner"));
    core(p, "Core connected"); retained(p);
    const before = p.f.calls.filter(c => c.path === "/api/workspace").length;
    p.f.marker = "recovered fixture reply"; p.f.emit("open");
    await until(() => p.d.querySelector(".prose")?.textContent.includes("recovered fixture reply"));
    assert.ok(p.f.calls.filter(c => c.path === "/api/workspace").length > before);
    assert.ok(p.d.querySelector(".event-connection-banner") === null, ".event-connection-banner is absent");
    assert.equal(p.f.streams.filter(s => !s.closed).length, 1);
    retained(p);
  } finally { p.close(); }
});
test("Core/network disconnect and recovery preserve cached conversation, draft and Pending without writes", async () => {
  const p = await mount();
  try {
    p.f.scenario("offline");
    await until(() => p.d.querySelector(".connection")?.dataset.coreStatus === "Core unreachable");
    core(p, "Core unreachable"); retained(p);
    p.f.scenario("ok");
    await until(() => p.d.querySelector(".connection")?.dataset.coreStatus === "Core connected");
    core(p, "Core connected"); retained(p);
    assert.ok(p.d.querySelector(".core-connection-banner") === null, ".core-connection-banner is absent");
  } finally { p.close(); }
});
test("HTTP 500 with an open SSE stream reports update failure, not an offline Core", async () => {
  const p = await mount();
  try {
    p.f.scenario("http500");
    await until(() => p.d.querySelector(".connection")?.dataset.coreStatus === "Core update failed");
    core(p, "Core update failed"); retained(p);
    assert.match(p.d.querySelector(".core-connection-banner").textContent, /HTTP 500/);
    assert.match(p.d.querySelector(".core-connection-banner").textContent, /Live updates connected/);
    assert.doesNotMatch(p.d.querySelector(".core-connection-banner").textContent, /unreachable|unavailable|offline/i);
    p.f.mode = "invalid-json"; p.f.emit("error"); p.f.refresh();
    await until(() => !p.d.querySelector(".core-connection-banner")?.textContent.includes("HTTP 500"));
    core(p, "Core update failed"); retained(p);
    assert.match(p.d.querySelector(".core-connection-banner").textContent, /Could not refresh/);
  } finally { p.close(); }
});
test("hung read body times out, releases queued refresh and ignores late old results", async () => {
  const p = await mount();
  try {
    p.f.catalogError = true; p.f.marker = "stale fixture reply"; p.f.mode = "hang"; p.f.refresh();
    await until(() => p.f.held.length >= 2);
    p.f.refresh(); // Coalesce one refresh behind the stalled read.
    await until(() => p.d.querySelector(".connection")?.dataset.coreStatus === "Core request timed out");
    core(p, "Core request timed out"); retained(p);
    assert.ok(p.f.held.some(h => h.signal.aborted));
    p.f.mode = "ok"; p.f.catalogError = false; p.f.marker = "new fixture reply"; p.f.refresh();
    // Detail and workspace snapshots recover independently. A new message
    // does not yet mean the separate workspace request has cleared its error.
    await until(() => p.d.querySelector(".prose")?.textContent.includes("new fixture reply") &&
      [...p.d.querySelectorAll("[data-core-status]")].every(el => el.dataset.coreStatus === "Core connected"));
    core(p, "Core connected");
    p.f.release(); await pause(80);
    core(p, "Core connected");
    assert.match(p.d.querySelector(".prose").textContent, /new fixture reply/);
    assert.doesNotMatch(p.d.body.textContent, /Simulated Codex catalog failure/);
    retained(p);
  } finally { p.close(); }
});
test("switching Agent cancels old snapshot callbacks; late response cannot overwrite selected Agent", async () => {
  const p = await mount();
  try {
    p.f.mode = "hold-a"; p.f.marker = "stale fixture reply"; p.f.refresh();
    await until(() => p.f.held.length > 0);
    [...p.d.querySelectorAll("button")].find(b => b.textContent.includes("Claude fixture")).click();
    await until(() => p.d.querySelector(".prose")?.textContent.startsWith("Claude fixture"));
    assert.ok(p.f.held.every(h => h.signal.aborted));
    p.f.release(); await pause(80);
    assert.ok(p.d.querySelector(".prose").textContent.startsWith("Claude fixture"));
    assert.equal(composerText(p.d.querySelector("[data-composer-input]")), "Keep Claude draft");
    assert.equal(p.f.calls.filter(c => c.method !== "GET").length, 0);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("replaced event subscription cancels callbacks, scheduled refresh and focus listener", async () => {
  const cache = resolve("node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const fixture = await mkdtemp(`${cache}/connection-hooks-`);
  let hookBundle;
  try {
    const entry = `${fixture}/entry.js`;
    await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {useWorkspaceEvents} from ${JSON.stringify(resolve("src/useWorkspaceEvents.ts"))};
const root=createRoot(document.getElementById('root'));
const refresh=()=>window.refreshes++;
function Probe({enabled}) {const state=useWorkspaceEvents(enabled,refresh);return React.createElement('p',null,state);}
window.setEnabled=enabled=>root.render(React.createElement(Probe,{enabled}));`);
    const result = await build({ configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' }, build: { write: false, lib: { entry, name: "ConnectionHooks", formats: ["iife"] } } });
    hookBundle = (Array.isArray(result) ? result[0] : result).output.find(o => o.type === "chunk").code;
  } finally { await rm(fixture, { recursive: true, force: true }); }
  const dom = new JSDOM('<div id="root"></div>', { url: "http://127.0.0.1:4391/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  try {
    w.eval(`(${installConnectionFixture.toString()})()`);
    w.refreshes = 0; w.eval(hookBundle); w.setEnabled(true);
    await until(() => w.document.querySelector("p")?.textContent === "open");
    const old = w.connectionFixture.streams.at(-1);
    const oldOpen = old.onopen, oldError = old.onerror, oldMessage = old.onmessage;
    oldMessage({}); // Queue a refresh, then dispose before its 160ms deadline.
    w.setEnabled(false);
    await until(() => old.closed);
    assert.equal(old.onopen, null); assert.equal(old.onerror, null); assert.equal(old.onmessage, null);
    const before = w.refreshes;
    oldOpen({}); oldError({}); oldMessage({}); w.dispatchEvent(new w.Event("focus"));
    await pause(200);
    assert.equal(w.refreshes, before);
    assert.equal(w.document.querySelector("p").textContent, "open");
    w.setEnabled(true);
    await until(() => w.refreshes > before);
    const next = w.connectionFixture.streams.at(-1);
    assert.ok(next !== old, "reconnecting opens a new stream");
    oldError({}); await pause(30);
    assert.equal(w.document.querySelector("p").textContent, "open");
  } finally { w.close(); }
});
