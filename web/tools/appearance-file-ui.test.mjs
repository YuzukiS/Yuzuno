// Appearance to and from a file (T-194): the export holds only the listed
// Appearance fields, with its format and version; an import is a preview of
// each setting beside the one in effect, and only the ticked ones are applied,
// once saved on this device. A file Yuzuno can't use, Cancel and a refused
// save change nothing, neither what is stored nor what is in effect.
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
const fixture = await mkdtemp(path.join(cache, "appearance-file-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {AppearanceSection} from ${JSON.stringify(path.join(root, "src/AppearanceSettings.tsx"))};
import {initializeAppearance} from ${JSON.stringify(path.join(root, "src/appearance.ts"))};
const root = createRoot(document.getElementById('root'));
// As the app starts: what this device holds is in effect before React mounts.
window.show = () => { initializeAppearance(); flushSync(() => root.render(<AppearanceSection/>)); };`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "AppearanceFileUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const KEY = "yuzuno.appearance";
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await tick(10);
  }
  assert.fail(`Expected state did not appear: ${what}`);
}
const file = (contents, over = {}) => ({
  format: "yuzuno-appearance",
  version: 1,
  exportedAt: "2026-10-24T12:00:00.000Z",
  appearance: contents,
  ...over,
});

function mount() {
  const dom = new JSDOM('<!doctype html><html><head><meta name="theme-color" content=""></head><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const exported = [];
  window.URL.createObjectURL = (blob) => {
    exported.push(blob);
    return "blob:isolated.test/appearance";
  };
  window.URL.revokeObjectURL = () => {};
  const storage = window.Storage.prototype;
  const original = { setItem: storage.setItem };
  window.eval(bundle);
  window.show();
  const document = window.document;
  const section = () => document.querySelector(".appearance-file");
  const button = (name) => [...section().querySelectorAll("button")].find((b) => b.textContent.trim() === name);
  return {
    window, document, exported,
    storage: window.localStorage,
    refuse() {
      storage.setItem = () => { throw new window.DOMException("refused", "QuotaExceededError"); };
    },
    allow() {
      Object.assign(storage, original);
    },
    button,
    preview: () => section().querySelector('[aria-label="Import preview"]'),
    row: (label) => [...section().querySelectorAll(".appearance-file-preview li")].find((li) => li.querySelector(".appearance-file-name")?.textContent.trim() === label),
    said: () => section().querySelector("[role=alert], [role=status]")?.textContent.trim() ?? null,
    alert: () => section().querySelector("[role=alert]")?.textContent.trim() ?? null,
    choose: (name, value) => document.querySelector(`input[name="${name}"][value="${value}"]`).click(),
    checked: (name) => document.querySelector(`input[name="${name}"]:checked`)?.value,
    /** The user picks `text` as a file in the Import picker. */
    pick(text, name = "appearance.json") {
      const input = section().querySelector('input[type="file"]');
      const picked = new window.File([text], name, { type: "application/json" });
      Object.defineProperty(input, "files", { configurable: true, value: [picked] });
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    read: (blob) => new Promise((resolve) => {
      const reader = new window.FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    }),
    close: () => window.close(),
  };
}

test("the export is a versioned file of the Appearance fields in effect, and nothing else", async () => {
  const page = mount();
  page.choose("appearance-palette", "pine");
  await tick();
  page.button("Export to a file").click();
  await until(() => page.exported.length === 1, "an export");
  const data = JSON.parse(await page.read(page.exported[0]));
  assert.deepEqual(Object.keys(data).sort(), ["appearance", "exportedAt", "format", "version"]);
  assert.equal(data.format, "yuzuno-appearance");
  assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data.appearance).sort(), ["agentList", "dock", "fontSize", "palette", "projectGroups", "theme", "turnDock"]);
  assert.deepEqual(Object.keys(data.appearance.dock).sort(), ["actions", "jobs", "subAgents"]);
  assert.deepEqual(Object.keys(data.appearance.turnDock).sort(), ["bars", "numbers"]);
  assert.equal(data.appearance.palette, "pine");
  page.close();
});

test("an import shows each setting beside the one in effect, and applies only the ticked ones once saved", async () => {
  const page = mount();
  page.pick(JSON.stringify(file({ palette: "yuzu", theme: "dark", fontSize: 20, agentList: "detailed", dock: { jobs: 3 } })));
  await until(page.preview, "the preview");
  assert.equal(page.storage.getItem(KEY), null, "a preview saves nothing");
  assert.equal(page.document.documentElement.dataset.palette, "garden", "and applies nothing");
  assert.match(page.row("Palette").textContent, /Now: Garden.*File: Yuzu/);
  assert.match(page.row("Theme").textContent, /Now: Light.*File: Dark/);
  assert.match(page.row("Text size").textContent, /Now: 16 px.*File: 20 px/);
  assert.match(page.row("Conversation dock: Local jobs").textContent, /Now: 5.*File: 3/);
  assert.match(page.row("Agent list").textContent, /File: the same/);
  assert.equal(page.row("Agent list").querySelector("input").disabled, true);
  assert.equal(page.row("Turn dock: Numbered turns"), undefined, "a setting the file lacks is not offered");
  // Keep the current theme.
  page.row("Theme").querySelector("input").click();
  await until(() => page.button("Apply 3 selected"), "three selected");
  page.button("Apply 3 selected").click();
  await until(() => page.said()?.startsWith("Imported"), "the import");
  assert.equal(page.said(), "Imported 3 settings from appearance.json; saved on this device.");
  const saved = JSON.parse(page.storage.getItem(KEY));
  assert.deepEqual([saved.palette, saved.theme, saved.fontSize, saved.dock.jobs], ["yuzu", "light", 20, 3]);
  const html = page.document.documentElement.dataset;
  assert.deepEqual([html.palette, html.theme, html.fontSize], ["yuzu", "light", "20"]);
  assert.equal(page.checked("appearance-palette"), "yuzu");
  assert.equal(page.preview(), null);
  page.close();
});

test("a file Yuzuno can't use is refused as a whole and changes nothing", async () => {
  const page = mount();
  const cases = [
    ["not json", /isn’t JSON/],
    [JSON.stringify({ format: "something-else", version: 1, appearance: { palette: "yuzu" } }), /isn’t a Yuzuno Appearance export/],
    [JSON.stringify(file({ palette: "yuzu" }, { version: 2 })), /newer Yuzuno \(Appearance file version 2\); this version reads version 1/],
    [JSON.stringify(file({ palette: "yuzu" }, { version: "1" })), /version isn’t one Yuzuno knows/],
    [JSON.stringify(file("palette=yuzu")), /holds no Appearance settings/],
    [`{"format":"yuzuno-appearance","version":1,"appearance":{"palette":"yuzu"},"pad":"${"x".repeat(17 * 1024)}"}`, /larger than 16 KiB.*not read/],
  ];
  for (const [text, expected] of cases) {
    page.pick(text);
    // The refusal for this file, not the one still shown for the last.
    await until(() => expected.test(page.alert() ?? ""), `a refusal for ${text.slice(0, 40)}`);
    assert.match(page.alert(), /Nothing was changed\.$/);
    assert.equal(page.preview(), null, "no preview");
    assert.equal(page.storage.getItem(KEY), null);
    assert.equal(page.document.documentElement.dataset.palette, "garden");
  }
  page.close();
});

test("values Yuzuno does not accept and names it does not know are shown and left out", async () => {
  const page = mount();
  page.pick(JSON.stringify(file(
    { palette: "neon", theme: "dark", fontSize: 99, cwd: "/home/someone/project", dock: { jobs: 2, token: "x" } },
    { token: "not-a-secret-fixture" },
  )));
  await until(page.preview, "the preview");
  assert.match(page.row("Text size").textContent, /File: 99, not a value Yuzuno accepts; kept as now/);
  assert.match(page.row("Palette").textContent, /File: "neon", not a value Yuzuno accepts/);
  assert.equal(page.row("Text size").querySelector("input"), null, "nothing to tick");
  assert.match(page.preview().textContent, /left out: token, appearance\.cwd, appearance\.dock\.token/);
  page.button("Apply 2 selected").click();
  await until(() => page.said()?.startsWith("Imported"), "the import");
  const saved = JSON.parse(page.storage.getItem(KEY));
  assert.deepEqual(Object.keys(saved).sort(), ["agentList", "dock", "fontSize", "palette", "projectGroups", "theme", "turnDock"]);
  assert.deepEqual(Object.keys(saved.dock).sort(), ["actions", "jobs", "subAgents"]);
  assert.deepEqual([saved.palette, saved.theme, saved.fontSize, saved.dock.jobs], ["garden", "dark", 16, 2]);
  page.close();
});

test("Cancel, or a save the browser refuses, changes nothing in storage or in effect", async () => {
  const page = mount();
  page.choose("appearance-palette", "pine");
  await tick();
  const before = page.storage.getItem(KEY);
  const contents = JSON.stringify(file({ palette: "yuzu", fontSize: 20 }));
  page.pick(contents);
  await until(page.preview, "the preview");
  page.button("Cancel").click();
  await until(() => page.preview() === null, "the preview closed");
  assert.equal(page.storage.getItem(KEY), before);
  assert.equal(page.document.documentElement.dataset.palette, "pine");

  page.pick(contents);
  await until(page.preview, "the preview again");
  page.refuse();
  page.button("Apply 2 selected").click();
  await until(page.alert, "the refusal");
  assert.equal(page.alert(), "Not imported: this browser’s storage for Yuzuno is full. Nothing was changed; your Appearance stays as it is.");
  assert.equal(page.storage.getItem(KEY), before, "nothing stored");
  const html = page.document.documentElement.dataset;
  assert.deepEqual([html.palette, html.fontSize], ["pine", "16"], "nothing applied here either");
  assert.equal(page.checked("appearance-palette"), "pine");
  assert.ok(page.preview(), "the preview stays, to try again");
  page.allow();
  page.button("Apply 2 selected").click();
  await until(() => page.said()?.startsWith("Imported"), "the import once storage allows it");
  assert.equal(JSON.parse(page.storage.getItem(KEY)).palette, "yuzu");
  assert.equal(page.document.documentElement.dataset.palette, "yuzu");
  page.close();
});
