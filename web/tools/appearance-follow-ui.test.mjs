// A device following the Workspace's shared Appearance preset (T-194), one
// way, between two clients of one Core, each with its own storage. Off until
// turned on after a preview; then a newer revision of the same Workspace is
// applied when Core announces a save or the client reconnects, never read
// by polling and never sent back. An edit of Appearance here (an import too)
// stops it; another Workspace, a preset this version can't read or a save
// this device refuses pause it with what is in effect kept. The Core here
// follows core/src/appearance_preset.rs, whose own tests prove its answers
// and the announcement of a kept save.
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
const fixture = await mkdtemp(path.join(cache, "appearance-follow-ui-"));
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
import {useAppearanceFollow} from ${src("appearance-follow.ts")};
import {appearanceInEffect, importAppearance, initializeAppearance, saveAppearance} from ${src("appearance.ts")};
const root = createRoot(document.getElementById('root'));
// As App.tsx: the Workspace shown, the live events' state, and a count of announced saves.
function Harness({workspaceId, connection, nudge}) {
  useAppearanceFollow(workspaceId, connection, nudge);
  return <SharedAppearanceSection active/>;
}
window.start = () => initializeAppearance();
window.render = (props) => flushSync(() => root.render(<Harness {...props}/>));
// The Appearance controls save a choice so; a file import imports it so.
window.choose = (palette) => saveAppearance({ ...appearanceInEffect(), palette });
window.importPalette = (palette) => importAppearance({ ...appearanceInEffect(), palette });`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "AppearanceFollowUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const KEY = "yuzuno.appearance";
const FOLLOW = "yuzuno.appearanceFollow";
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

/** One Core, as core/src/appearance_preset.rs answers, announcing a kept
 * save to every client whose live events are open. */
function core() {
  const state = { workspaceId: W1, preset: null, gets: 0, puts: [], clients: [] };
  state.handle = async (client, url, init = {}) => {
    if (!client.connected) throw new client.window.TypeError("Failed to fetch");
    const where = new URL(url, "http://isolated.test").pathname;
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (where !== "/api/appearance-preset") return reply(404, { error: "not in this fixture" });
    if ((init.method ?? "GET") === "GET") {
      state.gets++;
      return reply(200, { workspaceId: state.workspaceId, preset: state.preset });
    }
    const body = JSON.parse(init.body);
    state.puts.push({ from: client.name, body });
    if (body.workspaceId !== state.workspaceId)
      return reply(409, { error: "The preset was read from another Workspace, not this one. Nothing was saved.", code: "other_workspace", workspaceId: state.workspaceId });
    const revision = state.preset?.revision ?? 0;
    if (body.expectedRevision !== revision)
      return reply(409, { error: "The shared preset changed since it was read. Nothing was saved.", code: "preset_changed", workspaceId: state.workspaceId, preset: state.preset });
    state.preset = { version: 1, revision: revision + 1, savedAt: "2026-10-25T03:30:00.000Z", savedVia: "local", appearance: body.appearance };
    setTimeout(() => state.announce(), 0);
    return reply(200, { workspaceId: state.workspaceId, preset: state.preset });
  };
  state.announce = () => state.clients.forEach((client) => client.connected && client.event());
  /** Another device saved `appearance` as the next revision. */
  state.saved = (appearance, over = {}) => {
    state.preset = { version: 1, revision: (state.preset?.revision ?? 0) + 1, savedAt: "2026-10-25T03:31:00.000Z", savedVia: "remote", appearance, ...over };
    state.announce();
  };
  return state;
}

/** One client of `server`: its own storage holding `saved`, the App's
 * Workspace and live events as props. */
function client(server, name, saved = null) {
  const dom = new JSDOM('<!doctype html><html><head><meta name="theme-color" content=""></head><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  if (saved) window.localStorage.setItem(KEY, JSON.stringify(saved));
  const storage = window.Storage.prototype;
  const original = storage.setItem;
  const props = { workspaceId: W1, connection: "open", nudge: 0 };
  const page = {
    name, window, props, server,
    get connected() { return props.connection === "open"; },
    render: () => window.render({ ...props }),
    event() { props.nudge++; page.render(); },
    disconnect() { props.connection = "reconnecting"; page.render(); },
    reconnect() { props.connection = "open"; page.render(); },
    /** A new page load: the live events are still connecting. */
    loading() { props.connection = "connecting"; page.render(); },
    workspace(id) { props.workspaceId = id; page.render(); },
    stored: () => window.localStorage.getItem(KEY),
    follow: () => JSON.parse(window.localStorage.getItem(FOLLOW) ?? "null"),
    palette: () => window.document.documentElement.dataset.palette,
    section: () => window.document.querySelector("#settings-appearance-preset"),
    status: () => page.section().querySelector(".appearance-preset-status").textContent,
    device: () => page.section().querySelector(".appearance-follow-status")?.textContent ?? "",
    button: (label) => [...page.section().querySelectorAll("button")].find((b) => b.textContent.trim() === label),
    press: (label) => page.button(label).click(),
    said: () => [...page.section().querySelectorAll("[role=status], [role=alert]")].map((p) => p.textContent).join(" | "),
    preview: (label) => page.section().querySelector(`[aria-label="${label}"]`),
    refuse() {
      storage.setItem = function (key, value) {
        if (key === KEY) throw new window.DOMException("refused", "QuotaExceededError");
        return original.call(this, key, value);
      };
    },
    allow() { storage.setItem = original; },
    close: () => window.close(),
  };
  window.fetch = (url, init) => server.handle(page, url, init);
  window.eval(bundle);
  window.start();
  page.render();
  server.clients.push(page);
  return page;
}
const read = (page) => until(() => !page.status().startsWith("Reading") && page.device(), `${page.name} read the preset`);
/** Read again, and wait for that read's answer, not the last one's: the
 * fixture counts the request at once, before React has shown "Reading". */
async function reread(page) {
  const gets = page.server.gets;
  page.press("Read again");
  await until(() => page.server.gets > gets, `${page.name} asked again`);
  await tick();
  await until(() => !page.status().startsWith("Reading") && page.device(), `${page.name} read the preset again`);
}
/** B turns following on from the preset it reads now. */
async function follow(page) {
  await reread(page);
  page.press("Follow this preset…");
  await until(() => page.preview("Follow preview"), "the follow preview");
  const go = [...page.preview("Follow preview").querySelectorAll("button")].find((b) => b.textContent.startsWith("Follow"));
  go.click();
  await until(() => /now follows/.test(page.said()), `${page.name} follows`);
}

test("off until turned on after a preview; then each newer revision another device saves is applied here, saved first, and nothing is sent back", async () => {
  const server = core();
  const a = client(server, "A", { palette: "pine" });
  const b = client(server, "B");
  await read(a);
  await read(b);
  assert.equal(b.follow(), null, "off by default");
  assert.match(b.device(), /Uses its own Appearance; it doesn’t follow/);
  assert.ok(b.button("Follow this preset…").disabled, "nothing to follow yet");

  a.press("Save this device’s Appearance here");
  await until(() => server.preset?.revision === 1, "A's save");
  await tick(100);
  assert.equal(b.palette(), "garden", "a save by another device changes nothing here by itself");
  assert.equal(b.stored(), null);

  await reread(b);
  assert.match(b.status(), /shared preset revision 1/);
  b.press("Follow this preset…");
  const preview = await until(() => b.preview("Follow preview"), "the follow preview");
  assert.match(preview.textContent, /Palette.*Now: Garden.*Shared: Pine/);
  assert.equal(preview.querySelectorAll("input[type=checkbox]").length, 0, "following takes all it holds");
  assert.equal(b.follow(), null, "a preview turns nothing on");
  [...preview.querySelectorAll("button")].find((x) => x.textContent === "Follow and apply 1 change").click();
  await until(() => /now follows/.test(b.said()), "following on");
  assert.equal(b.palette(), "pine");
  assert.equal(JSON.parse(b.stored()).palette, "pine", "saved on this device");
  assert.deepEqual(b.follow(), { workspaces: { [W1]: { revision: 1 } } }, "on for this Workspace only, on this device");
  assert.match(b.device(), /Follows this Workspace’s shared preset: revision 1/);

  // A saves a new revision: B applies it when Core announces it.
  a.window.choose("yuzu");
  await tick(); // as a person would: the section shows the choice before Replace is pressed
  a.press("Replace it with this device’s Appearance");
  await until(() => server.preset?.revision === 2, "A's second save");
  await until(() => b.palette() === "yuzu", "B follows revision 2");
  assert.equal(JSON.parse(b.stored()).palette, "yuzu");
  assert.equal(b.follow().workspaces[W1].revision, 2);
  assert.deepEqual(server.puts.map((p) => p.from), ["A", "A"], "B never sent anything");
  a.close();
  b.close();
});

test("changing Appearance here, or importing it, stops following and says so; a newer revision is then not applied", async () => {
  const server = core();
  server.preset = { version: 1, revision: 1, savedAt: "2026-10-25T03:00:00.000Z", savedVia: "remote", appearance: { palette: "pine" } };
  const b = client(server, "B");
  await read(b);
  await follow(b);
  b.window.choose("sunroom");
  await until(() => b.follow() === null, "following off");
  assert.match(b.said(), /Stopped following this Workspace’s shared preset: Appearance was changed on this device, and stays as set here\./);
  server.saved({ palette: "yuzu" });
  await tick(100);
  assert.equal(b.palette(), "sunroom", "the edit stands");
  assert.match(b.device(), /Uses its own Appearance/);

  await follow(b);
  assert.equal(b.palette(), "yuzu");
  b.window.importPalette("graphite");
  await until(() => b.follow() === null, "an import stops it too");
  server.saved({ palette: "pine" });
  await tick(100);
  assert.equal(b.palette(), "graphite");

  // Stop following, chosen: this device keeps its Appearance; Core is not asked to change.
  await follow(b);
  const puts = server.puts.length;
  b.press("Stop following");
  await until(() => b.follow() === null, "stopped");
  assert.match(b.said(), /Stopped following\. This device keeps the Appearance in effect; nothing changed on Core\./);
  assert.equal(b.palette(), "pine");
  assert.equal(server.puts.length, puts);
  b.close();
});

test("offline, the Appearance in effect stays and nothing is sent; reconnected, the latest revision is read and applied", async () => {
  const server = core();
  server.preset = { version: 1, revision: 1, savedAt: "2026-10-25T03:00:00.000Z", savedVia: "remote", appearance: { palette: "pine" } };
  const b = client(server, "B");
  await read(b);
  await follow(b);
  b.disconnect();
  await until(() => /isn’t connected to Core now: the Appearance in effect stays/.test(b.device()), "offline");
  server.saved({ palette: "yuzu" });
  server.saved({ palette: "sunroom" });
  await tick(100);
  assert.equal(b.palette(), "pine", "nothing applied while offline");
  const gets = server.gets;
  b.reconnect();
  await until(() => b.palette() === "sunroom", "the latest revision, once connected");
  assert.equal(server.gets, gets + 1, "one read on reconnecting");
  assert.equal(b.follow().workspaces[W1].revision, 3);
  assert.equal(server.puts.length, 0, "nothing was ever sent back");

  // A page load's first "connecting" is not offline, and reads nothing yet.
  b.loading();
  await tick(50);
  assert.match(b.device(), /Follows this Workspace’s shared preset: revision 3/);
  assert.doesNotMatch(b.device(), /isn’t connected/);
  assert.equal(b.button("Try again"), undefined, "nothing to try again");
  b.close();
});

test("another Workspace, a preset this version can't read, or a save this device refuses pause following, keeping what is in effect", async () => {
  const server = core();
  server.preset = { version: 1, revision: 1, savedAt: "2026-10-25T03:00:00.000Z", savedVia: "remote", appearance: { palette: "pine" } };
  const b = client(server, "B");
  await read(b);
  await follow(b);

  // Another Workspace now answers at this address.
  server.workspaceId = W2;
  server.saved({ palette: "yuzu" });
  await until(() => /Following is paused: this page now reaches another Workspace \(2222bbbb\)/.test(b.device()), "paused for W2");
  assert.equal(b.palette(), "pine");
  assert.ok(b.button("Try again") && b.button("Stop following"), "a way on, or out");
  server.workspaceId = W1;

  // A preset of a later version.
  server.saved({ palette: "yuzu" }, { version: 2 });
  await until(() => /Following is paused: revision 3 can’t be applied here: it is from a newer Yuzuno/.test(b.device()), "paused for v2");
  assert.equal(b.palette(), "pine");

  // A save this device refuses: nothing changes here, and it can be tried again.
  b.refuse();
  server.saved({ palette: "sunroom" });
  await until(() => /Following is paused: revision 4 wasn’t applied: this browser’s storage for Yuzuno is full, so nothing changed here/.test(b.device()), "paused for storage");
  assert.equal(b.palette(), "pine");
  assert.equal(b.follow().workspaces[W1].revision, 1, "still at the revision applied");
  b.allow();
  b.press("Try again");
  await until(() => b.palette() === "sunroom", "applied once storage allows it");
  assert.equal(b.follow().workspaces[W1].revision, 4);

  // Following is kept per Workspace: shown W2, this device follows nothing there.
  b.workspace(W2);
  server.workspaceId = W2;
  server.saved({ palette: "graphite" });
  await tick(100);
  assert.equal(b.palette(), "sunroom", "W2's preset is not followed");
  assert.deepEqual(Object.keys(b.follow().workspaces), [W1]);
  assert.equal(server.puts.length, 0);
  b.close();
});

test("following paused, in Chinese (T-189): a pause said before a language change is worded again after it, the browser's reason too; the change reads and applies nothing", async () => {
  const server = core();
  server.preset = { version: 1, revision: 1, savedAt: "2026-10-25T03:00:00.000Z", savedVia: "remote", appearance: { palette: "pine" } };
  const b = client(server, "B");
  await read(b);
  await follow(b);
  b.refuse();
  server.saved({ palette: "sunroom" });
  await until(() => /Following is paused: revision 2 wasn’t applied: this browser’s storage for Yuzuno is full, so nothing changed here/.test(b.device()), "paused for storage");
  const switchTo = (language) => {
    b.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    b.window.dispatchEvent(new b.window.StorageEvent("storage", { key: "yuzuno.language" }));
  };
  const gets = server.gets;
  switchTo("zh-Hans");
  await until(() => b.device().startsWith("跟随已暂停"), "the pause, worded again");
  assert.equal(b.device(), "跟随已暂停：修订 2 未应用：此浏览器为 Yuzuno 保留的存储空间已满，因此这里没有任何变化。当前外观保持不变。");
  assert.ok(b.button("重试") && b.button("停止跟随"), "a way on, or out");
  assert.match(b.status(), /^Workspace 1111aaaa：共享预设修订 1，保存于 .+，经由远程入口。$/);
  switchTo("en");
  await until(() => b.device().startsWith("Following is paused"), "English again");
  await tick(50);
  assert.equal(server.gets, gets, "a language change reads nothing");
  assert.equal(b.palette(), "pine", "and applies nothing");
  assert.equal(b.follow().workspaces[W1].revision, 1);
  assert.equal(server.puts.length, 0);
  b.close();
});
