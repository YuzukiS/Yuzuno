// The Workspace's shared Appearance preset (T-194), between two clients of
// one Core, each with its own storage. Opening the editor only reads; saving
// and applying happen on a click, once. A save the Core refuses (another
// device saved since, or another Workspace) and an apply after the preset
// changed, the Core is another Workspace or does not answer are said, and
// change nothing on the device; a refused save on the device leaves its
// Appearance as it is. The Core here follows core/src/appearance_preset.rs,
// whose own tests prove the same answers.
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
const fixture = await mkdtemp(path.join(cache, "appearance-preset-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {SharedAppearanceSection} from ${src("SharedAppearance.tsx")};
import {initializeAppearance} from ${src("appearance.ts")};
import {findSettings} from ${src("settings-catalog.ts")};
const root = createRoot(document.getElementById('root'));
window.findSettings = findSettings;
window.start = () => initializeAppearance();
window.show = (active) => flushSync(() => root.render(<SharedAppearanceSection active={active}/>));`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "AppearancePresetUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const KEY = "yuzuno.appearance";
const W1 = "1111aaaa-0000-4000-8000-000000000001";
const W2 = "2222bbbb-0000-4000-8000-000000000002";
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await tick(10);
  }
  assert.fail(`Expected state did not appear: ${what}`);
}

/** One Core, as core/src/appearance_preset.rs answers: its Workspace, the
 * preset kept, every request it was sent; `down` answers nothing. */
function core() {
  const state = { workspaceId: W1, preset: null, gets: 0, puts: [], down: false };
  state.handle = async (window, url, init = {}) => {
    if (state.down) throw new window.TypeError("Failed to fetch");
    const where = new URL(url, "http://isolated.test").pathname;
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (where !== "/api/appearance-preset") return reply(404, { error: "not in this fixture" });
    if ((init.method ?? "GET") === "GET") {
      state.gets++;
      return reply(200, { workspaceId: state.workspaceId, preset: state.preset });
    }
    assert.equal(init.method, "PUT");
    const body = JSON.parse(init.body);
    state.puts.push(body);
    if (body.workspaceId !== state.workspaceId)
      return reply(409, { error: "The preset was read from another Workspace, not this one. Nothing was saved.", code: "other_workspace", workspaceId: state.workspaceId });
    const revision = state.preset?.revision ?? 0;
    if (body.expectedRevision !== revision)
      return reply(409, { error: "The shared preset changed since it was read. Nothing was saved.", code: "preset_changed", workspaceId: state.workspaceId, preset: state.preset });
    state.preset = { version: 1, revision: revision + 1, savedAt: "2026-10-25T03:00:00.000Z", savedVia: "local", appearance: body.appearance };
    return reply(200, { workspaceId: state.workspaceId, preset: state.preset });
  };
  return state;
}

/** One client of `server`, with its own storage holding `saved`. */
function client(server, saved = null) {
  const dom = new JSDOM('<!doctype html><html><head><meta name="theme-color" content=""></head><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  if (saved) window.localStorage.setItem(KEY, JSON.stringify(saved));
  window.fetch = (url, init) => server.handle(window, url, init);
  const storage = window.Storage.prototype;
  const original = storage.setItem;
  window.eval(bundle);
  window.start();
  window.show(true);
  const document = window.document;
  const section = () => document.querySelector("#settings-appearance-preset");
  const button = (name) => [...section().querySelectorAll("button")].find((b) => b.textContent.trim() === name);
  return {
    window, document,
    stored: () => window.localStorage.getItem(KEY),
    palette: () => document.documentElement.dataset.palette,
    status: () => section().querySelector(".appearance-preset-status").textContent,
    button,
    press: (name) => button(name).click(),
    preview: () => section().querySelector('[aria-label="Shared preset preview"]'),
    row: (label) => [...(section().querySelectorAll(".appearance-file-preview li") ?? [])].find((li) => li.querySelector(".appearance-file-name")?.textContent.trim() === label),
    alert: () => section().querySelector("[role=alert]")?.textContent ?? null,
    said: () => section().querySelector("[role=status], [role=alert]")?.textContent ?? null,
    /** The browser refuses to save this device's Appearance. */
    refuse() {
      storage.setItem = function (name, value) {
        if (name === KEY) throw new window.DOMException("refused", "QuotaExceededError");
        return original.call(this, name, value);
      };
    },
    allow() {
      storage.setItem = original;
    },
    show: (active) => window.show(active),
    close: () => window.close(),
  };
}
const read = (page, what = "the preset read") => until(() => !page.status().startsWith("Reading"), what);

test("opening only reads; one device saves its Appearance, another previews it beside its own and applies the ticked settings on itself", async () => {
  const server = core();
  const a = client(server, { palette: "pine", theme: "dark" });
  const b = client(server);
  await read(a);
  await read(b);
  assert.match(a.status(), /Workspace 1111aaaa: no preset shared yet\./);
  assert.equal(server.puts.length, 0, "opening the editor saves nothing to the Workspace");
  assert.equal(b.stored(), null, "and nothing on the device");
  assert.ok(b.button("Preview…").disabled, "nothing to preview yet");

  a.press("Save this device’s Appearance here");
  await until(() => a.said()?.startsWith("Saved"), "A's save");
  assert.match(a.said(), /Saved this device’s Appearance as this Workspace’s shared preset \(revision 1\)\./);
  assert.equal(server.puts.length, 1);
  assert.deepEqual(server.puts[0].appearance.palette, "pine");
  assert.deepEqual(Object.keys(server.puts[0].appearance).sort(), ["agentList", "dock", "fontSize", "palette", "projectGroups", "theme", "turnDock"], "only Appearance");
  assert.equal(server.puts[0].expectedRevision, 0);
  assert.equal(b.stored(), null, "B follows nothing by itself");
  assert.equal(b.palette(), "garden");

  b.press("Read again");
  await until(() => /revision 1/.test(b.status()), "B reads revision 1");
  assert.match(b.status(), /Workspace 1111aaaa: shared preset revision 1, saved .* through Core’s own address\./);
  b.press("Preview…");
  await until(b.preview, "B's preview");
  assert.equal(b.stored(), null, "a preview saves nothing");
  assert.match(b.row("Palette").textContent, /Now: Garden.*Shared: Pine/);
  assert.match(b.row("Theme").textContent, /Now: Light.*Shared: Dark/);
  assert.match(b.row("Text size").textContent, /Shared: the same/);
  b.row("Theme").querySelector("input").click(); // keep B's theme
  await until(() => b.button("Apply 1 selected"), "one selected");
  const gets = server.gets;
  b.press("Apply 1 selected");
  await until(() => b.said()?.startsWith("Applied"), "B's apply");
  assert.equal(server.gets, gets + 1, "Core is asked again before applying");
  assert.equal(b.said(), "Applied 1 setting from the shared preset; saved on this device.");
  assert.deepEqual([JSON.parse(b.stored()).palette, JSON.parse(b.stored()).theme], ["pine", "light"]);
  assert.equal(b.palette(), "pine");
  assert.equal(server.puts.length, 1, "applying writes nothing to the Workspace");
  assert.equal(b.preview(), null);
  a.close();
  b.close();
});

test("a save from an older read is refused and not retried; an apply after the preset changed asks for a new preview", async () => {
  const server = core();
  const a = client(server, { palette: "pine" });
  const b = client(server, { palette: "yuzu" });
  await read(a);
  await read(b);
  // Both read "no preset". B saves first.
  b.press("Save this device’s Appearance here");
  await until(() => b.said()?.startsWith("Saved"), "B's save");
  a.press("Save this device’s Appearance here");
  await until(a.alert, "A's refusal");
  assert.match(a.alert(), /Not saved: another device changed the shared preset after this one read it\. Nothing was changed\. Read it again/);
  assert.equal(server.puts.length, 2, "A's save was sent once, never again");
  assert.equal(server.preset.revision, 1);
  assert.equal(server.preset.appearance.palette, "yuzu", "B's preset stands");
  assert.match(a.status(), /Not read\./, "A's old read is dropped");
  assert.ok(a.button("Replace it with this device’s Appearance").disabled, "no save until read again");

  // A reads revision 1 and previews it; meanwhile B saves revision 2.
  a.press("Read again");
  await until(() => /revision 1/.test(a.status()), "A reads revision 1");
  a.press("Preview…");
  await until(() => a.button("Apply 1 selected"), "A's preview");
  b.press("Read again");
  await until(() => /revision 1/.test(b.status()), "B reads revision 1");
  b.press("Replace it with this device’s Appearance");
  await until(() => server.preset.revision === 2, "B's second save");
  a.press("Apply 1 selected");
  await until(a.alert, "A's apply refused");
  assert.match(a.alert(), /Not applied: the shared preset changed after you previewed it\. Nothing changed on this device\. Preview it again\./);
  assert.equal(JSON.parse(a.stored()).palette, "pine");
  assert.equal(a.palette(), "pine");
  assert.equal(a.preview(), null, "the old preview is closed");
  assert.match(a.status(), /revision 2/, "and the newer preset is what A sees now");
  a.close();
  b.close();
});

test("after a disconnect, or with another Workspace behind the same address, nothing read before is applied or saved over", async () => {
  const server = core();
  server.preset = { version: 1, revision: 4, savedAt: "2026-10-25T02:00:00.000Z", savedVia: "remote", appearance: { palette: "yuzu" } };
  const page = client(server);
  await read(page);
  assert.match(page.status(), /revision 4, saved .* through the remote entry\./);
  page.press("Preview…");
  await until(() => page.button("Apply 1 selected"), "the preview");

  server.down = true;
  page.press("Apply 1 selected");
  await until(page.alert, "the apply refused");
  assert.match(page.alert(), /Not applied: this Workspace’s Core couldn’t confirm the preset .*Nothing changed on this device\. Read it again once connected\./);
  assert.equal(page.stored(), null);
  assert.equal(page.palette(), "garden");
  assert.equal(page.preview(), null);
  assert.match(page.status(), /Not read\./);
  page.press("Read again");
  await until(() => /Couldn’t read/.test(page.status()), "a failed read");
  assert.equal(page.palette(), "garden");

  // Back, but another Workspace now answers at this address.
  server.down = false;
  page.press("Read again");
  await until(() => /revision 4/.test(page.status()), "read again");
  page.press("Preview…");
  await until(() => page.button("Apply 1 selected"), "the preview again");
  server.workspaceId = W2;
  server.preset = { version: 1, revision: 4, savedAt: "2026-10-25T02:00:00.000Z", savedVia: "local", appearance: { palette: "sunroom" } };
  page.press("Apply 1 selected");
  await until(page.alert, "the other Workspace refused");
  assert.match(page.alert(), /Not applied: this page is now connected to another Workspace/);
  assert.equal(page.palette(), "garden");

  // A save of what was read from W1 is refused by W2's Core.
  server.workspaceId = W1;
  page.press("Read again");
  await until(() => /Workspace 1111aaaa/.test(page.status()), "read from W1");
  server.workspaceId = W2;
  page.press("Replace it with this device’s Appearance");
  await until(page.alert, "the save refused");
  assert.match(page.alert(), /Not saved: this page read the preset from another Workspace/);
  assert.equal(server.preset.appearance.palette, "sunroom", "W2's preset stands");

  // A save Core never answers is said as unknown, and not retried.
  server.workspaceId = W1;
  page.press("Read again");
  await until(() => /Workspace 1111aaaa/.test(page.status()), "read from W1 again");
  const puts = server.puts.length;
  server.down = true;
  page.press("Replace it with this device’s Appearance");
  await until(page.alert, "the unanswered save");
  assert.match(page.alert(), /No answer from Core, so this device doesn’t know whether the preset was saved\. Nothing is retried/);
  await tick(100);
  assert.equal(server.puts.length, puts, "no request reached Core, and none was sent again");
  page.close();
});

test("a save this device refuses leaves its Appearance as it is; closing the editor drops what was read", async () => {
  const server = core();
  server.preset = { version: 1, revision: 1, savedAt: "2026-10-25T02:00:00.000Z", savedVia: "local", appearance: { palette: "yuzu", fontSize: 20 } };
  const page = client(server);
  await read(page);
  page.press("Preview…");
  await until(() => page.button("Apply 2 selected"), "the preview");
  page.refuse();
  page.press("Apply 2 selected");
  await until(page.alert, "the refusal");
  assert.match(page.alert(), /Not applied: this browser’s storage for Yuzuno is full\. Nothing was changed; your Appearance stays as it is\./);
  assert.equal(page.stored(), null);
  assert.equal(page.palette(), "garden");
  assert.ok(page.preview(), "the preview stays, to try again");
  page.allow();

  const gets = server.gets;
  page.show(false);
  await tick();
  assert.equal(page.preview(), null, "closing drops the preview");
  page.show(true);
  await until(() => server.gets === gets + 1, "opening reads again");
  await read(page);
  assert.equal(page.preview(), null);
  assert.equal(server.puts.length, 0);
  page.close();
});

test("a preset of a newer version, or with values or names this version doesn't know, is said, and only what it accepts is offered", async () => {
  const server = core();
  server.preset = { version: 2, revision: 3, savedAt: "2026-10-25T02:00:00.000Z", savedVia: "local", appearance: { palette: "yuzu" } };
  const page = client(server);
  await read(page);
  assert.match(page.status(), /the shared preset \(revision 3\) can’t be applied here: it is from a newer Yuzuno \(preset version 2\); this version reads version 1\./);
  assert.ok(page.button("Preview…").disabled);

  server.preset = { version: 1, revision: 4, savedAt: "2026-10-25T02:00:00.000Z", savedVia: "local", appearance: { palette: "neon", theme: "dark", glow: 1 } };
  page.press("Read again");
  await until(() => /revision 4/.test(page.status()), "revision 4");
  page.press("Preview…");
  await until(page.preview, "the preview");
  assert.match(page.row("Palette").textContent, /Shared: "neon", not a value Yuzuno accepts; kept as now/);
  assert.match(page.preview().textContent, /left out: appearance\.glow/);
  assert.ok(page.button("Apply 1 selected"), "only the theme is offered");
  page.close();
});

test("Settings finds the shared preset by its words, in the Appearance editor", () => {
  const page = client(core());
  try {
    const found = (query) => Array.from(page.window.findSettings(query), (entry) => `${entry.title}: ${entry.target.kind} ${entry.target.editor ?? ""}`.trim());
    assert.deepEqual(found("共享"), ["Shared Appearance preset: editor appearance"]);
    assert.deepEqual(found("shared preset"), ["Shared Appearance preset: editor appearance"]);
    assert.deepEqual(found("时区"), ["Clock & time zone: editor time"], "the time zone search stays on its own setting");
  } finally {
    page.close();
  }
});
