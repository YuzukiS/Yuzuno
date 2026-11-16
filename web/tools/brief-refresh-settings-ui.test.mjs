import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// Settings → Home → Refreshes (YN-113 R4), the production editor in an
// isolated page: every refresh with its card, its cadence and its last run;
// the switch saves against the version read and says when it changed; the
// three limits save the same way, and a conflict shows Core's current values.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "brief-refresh-settings-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {BriefRefreshSettings} from ${JSON.stringify(path.join(root, "src/BriefRefreshSettings.tsx"))};
createRoot(document.getElementById('root')).render(<BriefRefreshSettings />);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "BriefRefreshSettingsUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function until(read, what, page) {
  for (let i = 0; i < 80; i++) {
    if (read()) return;
    await tick();
  }
  if (page) console.log("DEBUG", JSON.stringify({ html: page.doc.body.innerHTML.slice(0, 2000), requests: page.requests, errors: page.errors }));
  assert.fail(`Timed out waiting for ${what}`);
}
const limits = (extra = {}) => ({
  version: 3, minHours: 1, maxActive: 10, pauseAfterFailures: 3,
  ranges: { minHours: [1, 24], maxActive: [1, 50], pauseAfterFailures: [1, 10] }, ...extra,
});
const refresh = (extra = {}) => ({
  projectId: "p1", projectName: "Digest", identity: 7, key: "digest/news", title: "Daily news", live: true,
  version: 1, cadence: { every: "day", at: "08:00" }, zone: "local", utcOffset: "+00:00", instruction: "Summarise the news",
  enabled: true, pausedReason: null, weeklyRuns: 7, nextAt: "2026-11-15T08:00:00Z", lastSlot: "2026-11-14T08:00:00Z",
  run: { slot: "2026-11-14T08:00:00Z", missed: 0, state: "refreshed" }, recent: [], failures: 0, waiting: null,
  versions: 2, createdAt: "2026-11-01T00:00:00Z", createdBy: "a", updatedAt: "2026-11-14T08:01:00Z", ...extra,
});

/** The editor in a page whose Core answers `routes`: a list of
 * [method, path, {status, body}] matched in order. */
async function mount(routes) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  vc.on("error", (...args) => errors.push(args.map(String).join(" ")));
  vc.on("warn", (...args) => errors.push(`warn: ${args.map(String).join(" ")}`));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://isolated.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  const page = { dom, window, doc: window.document, errors, requests: [] };
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const route = String(url).slice(String(url).indexOf("/api"));
    const body = init.body ? JSON.parse(init.body) : undefined;
    page.requests.push([method, route, body]);
    // routes are [method, path, answer], matched in order.
    const answer = routes.find((entry) => entry[0] === method && entry[1] === route);
    const reply = answer ? answer[2] : { status: 500, body: { error: `unexpected ${method} ${route}` } };
    const status = reply.status ?? 200;
    const text = JSON.stringify(reply.body);
    return { ok: status < 400, status, text: async () => text, json: async () => reply.body };
  };
  window.eval(bundle);
  return page;
}
const q = (page, selector) => page.doc.querySelector(selector);
const all = (page, selector) => [...page.doc.querySelectorAll(selector)];
const button = (page, words) => all(page, "button").find((b) => b.textContent.trim() === words);
function setRange(page, name, value) {
  const input = q(page, `input[name="${name}"]`);
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(input, String(value));
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}

test("Settings → Home → Refreshes lists every refresh, its cadence and the totals (YN-113 R4)", async () => {
  const items = [
    refresh(),
    refresh({ projectId: "p2", projectName: "Papers", identity: 9, key: "papers/weekly", title: "Weekly papers",
      cadence: { every: "week", at: "09:00", days: [1, 3, 5] }, zone: "local", weeklyRuns: 3, version: 2,
      enabled: false, nextAt: null, run: null,
      pausedReason: { code: "paused_by_owner", message: "Paused by its owner Mori", messageZh: "主人 Mori 暂停了它" } }),
  ];
  const page = await mount([["GET", "/api/brief-refreshes", { body: {
    limits: limits(), total: { cards: 2, active: 1, weeklyRuns: 7 }, items } }]]);
  await until(() => q(page, ".brief-refresh-row"), "the rows", page);
  const words = page.doc.body.textContent;
  assert.match(words, /1 card refreshes itself · about 7 Turns a week/);
  assert.match(words, /Every day at 08:00 · Digest/);
  assert.match(words, /Mon, Wed, Fri at 09:00 · Papers/);
  assert.match(words, /Refreshed/);
  assert.match(words, /Not refreshed yet/);
  assert.match(words, /About 3 Turns a week/);
  assert.match(words, /Paused by its owner Mori/);
  assert.equal(all(page, "input[role=switch]").length, 2);
  assert.deepEqual(page.requests.filter((r) => r[0] === "GET").map((r) => r[1]), ["/api/brief-refreshes"]);
  assert.deepEqual(page.errors, []);
});

test("a switch sends its version and turns a refresh off at once (YN-113 R4)", async () => {
  const before = refresh();
  const off = refresh({ enabled: false, version: 2, pausedReason: { code: "paused", message: "Paused by you", messageZh: "你暂停了它" } });
  const page = await mount([
    ["GET", "/api/brief-refreshes", { body: { limits: limits(), total: { cards: 1, active: 1, weeklyRuns: 7 }, items: [before] } }],
    ["PUT", "/api/projects/p1/brief/refreshes/7", { body: off }],
  ]);
  await until(() => q(page, ".brief-refresh-row"), "the row");
  const toggle = q(page, "input[role=switch]");
  assert.equal(toggle.checked, true);
  toggle.click();
  await until(() => page.requests.some((r) => r[0] === "PUT"), "the save");
  await until(() => q(page, "input[role=switch]").checked === false, "the switch");
  assert.deepEqual(page.requests.find((r) => r[0] === "PUT"), ["PUT", "/api/projects/p1/brief/refreshes/7", { version: 1, enabled: false }]);
  assert.match(page.doc.body.textContent, /0 cards refresh themselves · about 0 Turns a week/);
  assert.match(page.doc.body.textContent, /Paused by you/);
});

test("a switch refused for a newer version reads the current refresh and says so (YN-113 R4)", async () => {
  const page = await mount([
    ["GET", "/api/brief-refreshes", { body: { limits: limits(), total: { cards: 1, active: 1, weeklyRuns: 7 }, items: [refresh()] } }],
    ["PUT", "/api/projects/p1/brief/refreshes/7", { status: 409, body: {
      error: "This refresh changed since the page read it (version 4 now, not 1)",
      code: "version_conflict", current: refresh({ version: 4, enabled: true }) } }],
  ]);
  await until(() => q(page, ".brief-refresh-row"), "the row");
  q(page, "input[role=switch]").click();
  await until(() => /changed meanwhile and was read again/.test(page.doc.body.textContent), "the conflict");
  assert.equal(q(page, "input[role=switch]").checked, true, "Core's current value, not the refused one");
  assert.match(page.doc.body.textContent, /1 card refreshes itself/);
});

test("the three limits save against the version read, and a conflict shows Core's values (YN-113 R4)", async () => {
  const page = await mount([
    ["GET", "/api/brief-refreshes", { body: { limits: limits({ version: 5 }), total: { cards: 1, active: 1, weeklyRuns: 7 }, items: [refresh()] } }],
    ["PUT", "/api/brief-refreshes/limits", { status: 409, body: {
      error: "The limits changed since the page read them (version 6 now, not 5)",
      code: "version_conflict", current: limits({ version: 6, maxActive: 12 }) } }],
  ]);
  await until(() => q(page, "input[name=refresh-max-active]"), "the limits");
  setRange(page, "refresh-max-active", 20);
  await until(() => {
    const save = button(page, "Save limits");
    return save && !save.disabled;
  }, "the save button");
  button(page, "Save limits").click();
  await until(() => /The limits changed meanwhile/.test(page.doc.body.textContent), "the conflict");
  assert.deepEqual(page.requests.find((r) => r[0] === "PUT"), ["PUT", "/api/brief-refreshes/limits",
    { version: 5, minHours: 1, maxActive: 20, pauseAfterFailures: 3 }]);
  assert.equal(q(page, "input[name=refresh-max-active]").value, "12", "Core's value is read");
  assert.deepEqual(page.errors, []);
});

test("the limits save, and say so, when Core takes them (YN-113 R4)", async () => {
  const page = await mount([
    ["GET", "/api/brief-refreshes", { body: { limits: limits(), total: { cards: 1, active: 1, weeklyRuns: 7 }, items: [refresh()] } }],
    ["PUT", "/api/brief-refreshes/limits", { body: limits({ version: 4, minHours: 2 }) }],
  ]);
  await until(() => q(page, "input[name=refresh-min-hours]"), "the limits");
  setRange(page, "refresh-min-hours", 2);
  await until(() => {
    const save = button(page, "Save limits");
    return save && !save.disabled;
  }, "the save button");
  button(page, "Save limits").click();
  await until(() => page.requests.some((r) => r[0] === "PUT"), "the save");
  await until(() => /Saved\./.test(page.doc.body.textContent), "the saved note");
  assert.deepEqual(page.requests.find((r) => r[0] === "PUT"), ["PUT", "/api/brief-refreshes/limits",
    { version: 3, minHours: 2, maxActive: 10, pauseAfterFailures: 3 }]);
  assert.deepEqual(page.errors, []);
});
