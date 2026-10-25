import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// The app-level recovery page and the diagnostics a user can copy (T-143),
// in the built app against an in-memory Core: no real Core, desktop or clipboard.
const distUrl = process.env.YUZUNO_UI_DIST
  ? pathToFileURL(resolve(process.env.YUZUNO_UI_DIST) + "/")
  : new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", distUrl), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)?.[1];
assert.ok(entry, "index.html must name the current JavaScript bundle");
const bundle = await uiTestBundle(new URL(entry, distUrl));
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, message, seconds = 6) {
  const deadline = Date.now() + seconds * 1000;
  while (!predicate() && Date.now() < deadline) await pause(25);
  assert.ok(predicate(), message);
}

const base = { model: "m", color: "sage", status: "idle", createdAt: "", updatedAt: "", goal: "", pendingCount: 0, lastSeq: 1, reviewedSeq: 1, unreadCount: 0, cwd: "/w/app", projectId: "p-app" };
const health = { product: "yuzuno", application: "yuzuno-next", version: "2026.10.18-core.11", releaseId: "core-20261018-6f29d20", apiReady: true, storageReady: true, schema: 2, workspaceId: "ws-private-id" };
const updates = { managed: false, current: null, candidates: [], blockers: [], acceptingWork: true };
const MiB = 1048576;
// A synthetic GET /api/diagnostics/memory report (T-140), with a reason and a
// field the page does not know, each carrying a sentinel that must not be copied.
const memoryReport = {
  format: 1, readAt: "2026-10-21T20:00:00+00:00", note: "MemoryNoteSentinel",
  os: { available: true, counts: "kernel process status", rssBytes: 678 * MiB, hwmBytes: 903.5 * MiB, anonBytes: 671.5 * MiB, fileBytes: 6.5 * MiB, shmemBytes: 0, swapBytes: 0, threads: 45 },
  allocator: { available: true, kind: "glibc malloc", arena: 1100 * MiB, uordblks: 126 * MiB, fordblks: 967 * MiB, hblkhd: 0, hblks: 0 },
  store: { heldRecords: 2, maxHeldRecords: 8 },
  admission: { inFlight: 1, includesThisRequest: true, updateOperation: false, sealed: false },
  reclaim: {
    available: true, maintenanceTickRunning: true, gateBusy: false,
    gate: { waitingFor: ["heldRecords", "heldGrace", "ReasonSentinel /home/person/private"], lastCheck: { at: "2026-10-21T19:00:00+00:00", result: "trimmed", reclaim: { rssBeforeBytes: 625 * MiB, rssAfterBytes: 13.5 * MiB } } },
  },
  extra: { path: "/home/person/ExtraFieldSentinel" },
};
// A synthetic GET /api/diagnostics/memory/history report (T-140): three held
// Agents, one with unwritten changes, one without stored rows and one in the
// older layout, and fields the page does not show, each carrying a sentinel.
const part = (rows, bytes) => ({ rows, bytes });
const stored = { stored: true, layout: 1, metadata: part(1, 2048), turns: part(3, 6144), items: part(40, 3 * MiB), itemsWithPayloads: 2, previews: part(2, 8192), payloads: part(2, 12 * MiB), path: "/home/person/AgentFieldSentinel" };
const historyReport = {
  format: 1, readAt: "2026-10-23T08:00:00+00:00", available: true, budgetMs: 2000, note: "HistoryNoteSentinel", heldAgents: 3,
  agents: [
    { agentId: "a", name: "Mori", unwrittenChanges: true, ...stored },
    { agentId: "b0c1d2e3f4", name: null, unwrittenChanges: false, stored: false },
    { agentId: "c", name: "Old", unwrittenChanges: false, stored: true, layout: 0, metadata: part(1, 5 * MiB), turns: part(0, 0), items: part(0, 0), itemsWithPayloads: 0, previews: part(0, 0), payloads: part(0, 0) },
  ],
  total: { metadata: part(2, 5 * MiB + 2048), turns: part(3, 6144), items: part(40, 3 * MiB), itemsWithPayloads: 2, previews: part(2, 8192), payloads: part(2, 12 * MiB) },
  sql: "SELECT SqlSentinel",
};

/**
 * The built app, with the page's script tag as Core serves it. `named: false`
 * serves an Agent without a name, which the rail can't draw: a real render
 * error that no part of the app handles.
 */
async function mount({ named = true, storage = {}, clipboard = "ok", desktop = null, memory = memoryReport, history = historyReport } = {}) {
  const calls = [];
  const copied = [];
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`, {
    url: "http://127.0.0.1:4317/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
  w.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  w.EventSource = class { addEventListener() {} close() {} };
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};
  if (clipboard !== "none")
    Object.defineProperty(w.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          if (clipboard === "denied") throw new w.DOMException("Write permission denied.", "NotAllowedError");
          copied.push(text);
        },
      },
    });
  else Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: undefined });
  if (desktop) {
    // A desktop window (api.ts isTauri); `version: null` is one whose update status doesn't answer.
    w.__TAURI_INTERNALS__ = {};
    w.__TAURI__ = {
      core: {
        invoke: async (command) => {
          calls.push({ url: `invoke:${command}` });
          if (command === "desktop_update_status" && desktop.version)
            return { version: desktop.version, channel: "installer", unavailable: null, phase: "idle", error: null, receivedBytes: 0, totalBytes: null, available: null };
          throw new Error(`command ${command} not allowed`);
        },
      },
    };
  }
  const state = { named, health: true };
  const respond = (value, status = 200) => {
    const text = JSON.stringify(value);
    return { ok: status === 200, status, json: async () => JSON.parse(text), text: async () => text };
  };
  w.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    if (url.endsWith("/api/health")) {
      if (!state.health) throw new TypeError("Failed to fetch");
      return respond(health);
    }
    if (url.endsWith("/api/diagnostics/memory/history")) {
      if (history === "older core") return respond({ error: "Not found" }, 404);
      return respond(history);
    }
    if (url.endsWith("/api/diagnostics/memory")) {
      if (memory === "unreachable") throw new TypeError("Failed to fetch");
      if (memory === "older core") return respond({ error: "Not found" }, 404);
      return respond(memory);
    }
    if (url.endsWith("/api/workspace"))
      return respond({
        workspace: { id: "ws-1" },
        projects: [{ id: "p-app", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
        agents: [{ ...base, id: "a", name: state.named ? "Mori" : null }],
        runtime: { connected: true },
        defaultCwd: "/w",
      });
    if (url.endsWith("/api/updates")) return respond(updates);
    // Data, privacy & recovery opens at its storage overview (T-187).
    if (url.endsWith("/api/storage"))
      return respond({ format: 1, readAt: "2026-10-24T22:00:00Z", dataDir: "/w/data", entries: [], unreadable: null,
        database: { pageSize: 4096, pages: 10, freePages: 0 }, jobs: { total: 0, unfinished: 0 }, native: [], notInBackup: [] });
    return respond({});
  };
  const doc = w.document;
  const button = (text, root = doc) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text));
  w.eval(bundle);
  return { w, doc, calls, copied, state, button, close: () => w.close() };
}
const recovery = (p) => p.doc.querySelector(".app-recovery");
const railShows = (p, name) => new RegExp(name).test(p.doc.querySelector(".agent-list")?.textContent || "");
// Settings opens on its categories (T-187): Diagnostics and the stored
// history are editors under Data, privacy & recovery, opened from its row of
// entries; one opened before stays mounted when the other is opened.
async function openSettingsEditor(p, title, selector) {
  if (!p.doc.querySelector("#settings-tab-data")) p.doc.querySelector('[aria-label="Settings and updates"]').click();
  await waitFor(() => p.doc.querySelector("#settings-tab-data"), "Settings shows its categories");
  p.doc.querySelector("#settings-tab-data").click();
  const entry = () => [...p.doc.querySelectorAll(".settings-entries button")].find((b) => b.textContent === title);
  await waitFor(entry, `Data, privacy & recovery offers ${title}`);
  entry().click();
  await waitFor(() => p.doc.querySelector(selector), `Settings shows ${title}`);
  return p.doc.querySelector(selector);
}
const openDiagnostics = (p) => openSettingsEditor(p, "Diagnostics", "#settings-diagnostics");
const shownText = (p) => p.doc.querySelector('textarea[aria-label="Diagnostics"]')?.value;
// Settings shows the text first (T-193): Preview copies nothing; Copy then takes that text.
async function previewAndCopy(p) {
  const section = p.doc.querySelector("#settings-diagnostics");
  p.button("Preview diagnostics", section).click();
  await waitFor(() => shownText(p), "the diagnostics are shown");
  assert.equal(p.copied.length, 0, "previewing copies nothing");
  p.button("Copy", section).click();
}
const allStorage = (w) => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => [w.localStorage.key(i), w.localStorage.getItem(w.localStorage.key(i))]));

test("a render error no part of the app handles shows the recovery page; trying again draws the app, and nothing stored is cleared", async () => {
  const storage = {
    "yuzuno.composerDraft.v1:a": JSON.stringify({ text: "my unsent draft" }),
    "yuzuno.homeWidgets.ws-1": JSON.stringify({ order: ["machines"], hidden: [], pins: [] }),
  };
  const p = await mount({ named: false, storage });
  try {
    await waitFor(() => recovery(p), "the recovery page shows instead of a blank window");
    assert.equal(p.doc.querySelector(".agent-list"), null, "the app itself is not drawn");
    assert.equal(recovery(p).querySelector("h1").textContent, "Yuzuno couldn't show this screen");
    assert.match(recovery(p).textContent, /nothing was cleared/);
    assert.ok(p.button("Reload", recovery(p)), "a reload is offered");
    // Trying again with the same data fails again, and says so.
    p.button("Try again", recovery(p)).click();
    await waitFor(() => /It failed again \(2 times in this window\)/.test(recovery(p)?.textContent || ""), "the second failure is counted");
    // Once the data can be drawn, trying again draws the app.
    p.state.named = true;
    p.button("Try again", recovery(p)).click();
    await waitFor(() => railShows(p, "Mori"), "the app is drawn again");
    assert.equal(recovery(p), null);
    const after = allStorage(p.w);
    for (const [key, value] of Object.entries(storage)) assert.equal(after[key], value, `${key} is kept as it was`);
  } finally {
    p.close();
  }
});

test("Copy diagnostics on the recovery page: versions, the render error by kind and name, and nothing private", async () => {
  const p = await mount({ named: false });
  try {
    await waitFor(() => recovery(p), "the recovery page shows");
    p.button("Copy diagnostics", recovery(p)).click();
    await waitFor(() => p.copied.length === 1, "the diagnostics are copied");
    const text = p.copied[0];
    assert.equal(shownText(p), text, "the copied text is shown too");
    assert.match(recovery(p).textContent, /Copied\. Nothing was sent anywhere/);
    const lines = text.split("\n");
    assert.equal(lines[0], "Yuzuno diagnostics");
    assert.match(text, new RegExp(`^Page: loaded \\S+; web UI ${entry.split("/").pop().replace(/[.]/g, "\\.")}; from http://127\\.0\\.0\\.1:4317; browser online$`, "m"));
    assert.match(text, /^Core: 2026\.10\.18-core\.11 \(release core-20261018-6f29d20\), API ready yes, storage ready yes; read \S+$/m);
    assert.match(text, /^Desktop app: not a desktop window$/m);
    assert.match(text, /^WebView: not a desktop window$/m);
    assert.match(text, /^Page environment \(as the page reads it, not a report from the desktop app\): WebKit \d+ on Linux$/m);
    for (const raw of ["Mozilla/5.0", "KHTML", "jsdom/"]) assert.ok(!text.includes(raw), `the user agent itself (${raw}) is not copied`);
    assert.match(text, /^Recent errors on this device: 1 \(newest first, at most 12 kept\)$/m);
    assert.match(text, /^1\. render · TypeError · once, \S+\n {3}read a property of null$/m, "a fixed summary, not the message");
    assert.doesNotMatch(text, /Cannot read|slice/, "the message itself is not kept");
    assert.doesNotMatch(text, /ws-private-id/, "Core's workspace id is not part of it");
    assert.equal(p.calls.filter((c) => c.method && c.method !== "GET").length, 0, "copying sends nothing");
  } finally {
    p.close();
  }
});

test("no text an error carries is kept: messages, string rejections, and names, codes and keys outside the product's lists; one error repeated counts; at most 12 are kept", async () => {
  const p = await mount();
  try {
    await waitFor(() => railShows(p, "Mori"), "the app is drawn");
    const fail = (error) => p.w.dispatchEvent(new p.w.ErrorEvent("error", { error, message: error.message }));
    for (let i = 0; i < 17; i++) {
      const error = new p.w.RangeError(`Invalid array length ${i}`);
      error.stack = `RangeError: Invalid array length ${i}\n    at grow (http://127.0.0.1:4317/assets/index-AbC123.js:${i + 1}:5)`;
      fail(error);
    }
    for (let i = 0; i < 30; i++) fail(new p.w.TypeError("Cannot read properties of undefined (reading 'x')"));
    await openDiagnostics(p);
    await previewAndCopy(p);
    await waitFor(() => p.copied.length === 1, "the diagnostics are copied");
    const text = p.copied[0];
    assert.match(text, /^Recent errors on this device: 12 \(newest first, at most 12 kept\)$/m);
    assert.match(text, /^1\. error · TypeError · 30 times, \S+ to \S+\n {3}read a property of undefined$/m, "one error repeated is one entry");
    assert.match(text, /^2\. error · RangeError · once, \S+\n {3}other message, not kept\n {3}at index-AbC123\.js:17:5$/m, "each is its own by where it failed");
    assert.match(text, /^12\. error · RangeError · once, \S+\n {3}other message, not kept\n {3}at index-AbC123\.js:7:5$/m, "the oldest are no longer kept");
    assert.doesNotMatch(text, /Invalid array length|reading 'x'|grow/);
  } finally {
    p.close();
  }
  const q = await mount();
  try {
    await waitFor(() => railShows(q, "Mori"), "the app is drawn");
    const sentinels = [];
    const s = (word) => (sentinels.push(word), word);
    const fail = (error) => q.w.dispatchEvent(new q.w.ErrorEvent("error", { error, message: error.message }));
    const reject = (reason) => {
      const event = new q.w.Event("unhandledrejection");
      event.reason = reason;
      q.w.dispatchEvent(event);
    };
    // A one-part absolute path, quoted text shaped like an identifier, and a path with spaces,
    // each also in its stack as V8 writes it.
    const thrown = (error, row) => Object.assign(error, { stack: `${error.name}: ${error.message}\n    at open (http://127.0.0.1:4317/assets/index-AbC123.js:${row}:5)` });
    fail(thrown(new q.w.Error(`open /${s("PrivateProjectSentinel")}`), 5));
    fail(thrown(new q.w.SyntaxError(`Unexpected token in "${s("DRAFT_SENTINEL")}"`), 6));
    fail(thrown(new q.w.Error(`open /home/Person With Spaces/${s("ResearchSentinel")}/result.json`), 5));
    // A string rejection, and names, codes, issue codes and keys outside the product's lists.
    reject(`${s("StringRejectionSentinel")} the user typed`);
    reject(Object.assign(new q.w.Error("custom"), { name: s("NameSentinel"), code: s("code_sentinel") }));
    reject(Object.assign(new q.w.Error("schema"), { name: "ZodError", issues: [{ code: "unrecognized_keys", keys: [s("KeySentinel"), "yuzunoChange"] }, { code: s("IssueSentinel") }] }));
    // An API failure nobody handled: its message is the response's text.
    reject(Object.assign(new q.w.Error(`<html><body>Proxy error: ${s("ResponseSentinel")} hello world</body></html>`), { name: "HttpError", status: 502, code: "message_not_submitted" }));
    // A message that pretends to be a frame, and the function names of real frames.
    const framed = new q.w.Error(`failed\n    at ${s("FakeFrameSentinel")} (http://127.0.0.1:4317/assets/index-AbC123.js:1:1)`);
    framed.stack = `Error: ${framed.message}\n    at ${s("drawRailSentinel")} (http://127.0.0.1:4317/assets/index-AbC123.js:11:21)\n    at chrome-extension://abcdef/content.js:3:4`;
    fail(framed);
    // Secrets, URLs, other projects' paths and e-mail addresses, in a message and in a stack.
    const leaky = new q.w.Error("Saving \"my unsent draft text\" failed: sk-ant-api03-FAKEFAKEFAKE1234 ghp_FAKEtoken1234567890 (Bearer abcdef123456) token=supersecretvalue " +
      "at /workspace/other-project/src/secret.ts, C:\\Users\\Bob\\notes.txt and \\\\nas\\share\\report.docx via https://x.example/cb?token=abc#frag for bob@example.org");
    leaky.stack = "Error: leaky\n    at loadPrivate (/workspace/other-project/tool.js:1:2)\n    at D:\\work\\other\\x.js:3:4";
    for (let i = 0; i < 3; i++) fail(leaky);
    await openDiagnostics(q);
    await previewAndCopy(q);
    await waitFor(() => q.copied.length === 1, "the diagnostics are copied");
    const text = q.copied[0];
    const kept = q.w.localStorage.getItem("yuzuno.diagnostics.v1");
    for (const word of [...sentinels, "Person With Spaces", "result.json", "hello world", "Proxy error", "<html>", "my unsent draft", "FAKEFAKE", "ghp_FAKE", "abcdef123456",
      "supersecretvalue", "other-project", "secret.ts", "C:\\Users", "Bob", "\\\\nas", "report.docx", "x.example", "token=abc", "#frag", "bob@example.org", "loadPrivate", "D:\\work", "chrome-extension"]) {
      assert.ok(!text.includes(word), `${word} is not in the diagnostics`);
      assert.ok(!kept.includes(word), `${word} is not stored either`);
    }
    assert.match(text, /^\d+\. error · Error · 2 times, \S+ to \S+\n {3}other message, not kept\n {3}at index-AbC123\.js:5:5$/m, "both paths give the same entry, without them");
    assert.match(text, /^\d+\. error · SyntaxError · once, \S+\n {3}a text that is not valid JSON\n {3}at index-AbC123\.js:6:5$/m);
    assert.match(text, /^\d+\. rejection · string · once, \S+\n {3}other message, not kept$/m);
    assert.match(text, /^\d+\. rejection · Error · other code · once, \S+\n {3}other message, not kept$/m);
    assert.match(text, /^\d+\. rejection · ZodError · unrecognized_keys:yuzunoChange,1 other · other issue · once, \S+$/m);
    assert.match(text, /^\d+\. rejection · HttpError · message_not_submitted · http 502 · once, \S+\n {3}at /m, "an HTTP error gives its codes, no summary");
    assert.match(text, /^\d+\. error · Error · once, \S+\n {3}other message, not kept\n {3}at index-AbC123\.js:11:21; \+1 frame outside Yuzuno$/m, "only the real frame, by position");
    assert.match(text, /^\d+\. error · Error · 3 times, \S+ to \S+\n {3}other message, not kept\n {3}at \+2 frames outside Yuzuno$/m);
    assert.doesNotMatch(text, /index-AbC123\.js:1:1/, "a frame written in the message is not read");
  } finally {
    q.close();
  }
});

test("without the clipboard the text is shown to select; offline, the last Core read is given with its time", async () => {
  const p = await mount({ named: false, clipboard: "denied" });
  try {
    await waitFor(() => recovery(p), "the recovery page shows");
    p.button("Copy diagnostics", recovery(p)).click();
    await waitFor(() => shownText(p), "the text is shown");
    assert.match(recovery(p).textContent, /can't use the clipboard\. Select the text below and copy it\./);
    assert.equal(p.copied.length, 0);
    assert.match(shownText(p), /^Core: 2026\.10\.18-core\.11 .*; read \S+$/m);
    assert.match(shownText(p), /^Recent errors on this device: 1 /m);
    // Core can't be reached now: what was read before is given as such.
    p.state.health = false;
    const before = shownText(p);
    p.button("Copy diagnostics", recovery(p)).click();
    await waitFor(() => shownText(p) !== before, "the text is read again");
    assert.match(shownText(p), /^Core: unknown now \(not reachable, \S+\); last read \S+: 2026\.10\.18-core\.11 \(release core-20261018-6f29d20\), API ready yes, storage ready yes$/m);
    assert.match(shownText(p), /^Recent errors on this device: 1 /m, "the refused clipboard and the failed read are not recorded as errors");
  } finally {
    p.close();
  }
  // A WebView with no clipboard at all.
  const q = await mount({ named: false, clipboard: "none" });
  try {
    await waitFor(() => recovery(q), "the recovery page shows");
    q.button("Copy diagnostics", recovery(q)).click();
    await waitFor(() => shownText(q), "the text is shown");
    assert.match(recovery(q).textContent, /Select the text below and copy it\./);
  } finally {
    q.close();
  }
});

test("in the desktop app its version comes from the update status it already answers; one that doesn't answer is unknown, and the WebView is unknown", async () => {
  const p = await mount({ named: false, desktop: { version: "0.2.0" } });
  try {
    await waitFor(() => recovery(p), "the recovery page shows");
    p.button("Copy diagnostics", recovery(p)).click();
    await waitFor(() => p.copied.length === 1, "the diagnostics are copied");
    assert.match(p.copied[0], /^Desktop app: 0\.2\.0; read \S+$/m);
    assert.match(p.copied[0], /^WebView: unknown \(the desktop app does not report it\)$/m);
    assert.deepEqual(p.calls.filter((c) => c.url.startsWith("invoke:")).map((c) => c.url).filter((u) => u === "invoke:desktop_update_status"), ["invoke:desktop_update_status"]);
  } finally {
    p.close();
  }
  const q = await mount({ named: false, desktop: { version: null } });
  try {
    await waitFor(() => recovery(q), "the recovery page shows");
    q.button("Copy diagnostics", recovery(q)).click();
    await waitFor(() => q.copied.length === 1, "the diagnostics are copied");
    assert.match(q.copied[0], /^Desktop app: unknown \(it did not say, \S+\)$/m);
    assert.match(q.copied[0], /^WebView: unknown \(the desktop app does not report it\)$/m);
  } finally {
    q.close();
  }
});

test("a record kept by an earlier version is shown by the same rules and stored again without its text; nothing else stored is touched", async () => {
  const old = {
    errors: [
      { kind: "error", name: "OldNameSentinel", codes: ["OldCodeSentinel", "http 500", "unrecognized_keys:OldKeySentinel"], message: 'open /PrivateProjectSentinel with "DRAFT_SENTINEL"',
        where: ["oldFnSentinel @ index-AbC123.js:1:2", "OldFrameSentinel", "+1 frame outside Yuzuno"], first: "2026-10-19T10:00:00.000Z", last: "2026-10-19T10:05:00.000Z", count: 2 },
      { kind: "rejection", name: "Message", codes: [], message: "OldStringSentinel the user typed", where: [], first: "2026-10-19T09:00:00.000Z", last: "2026-10-19T09:00:00.000Z", count: 1 },
      { kind: "render", name: "TypeError", codes: [], message: "Cannot read properties of null (reading 'slice')", where: [], first: "2026-10-19T08:00:00.000Z", last: "2026-10-19T08:00:00.000Z", count: 1 },
      { kind: "error", name: "Error", codes: [], message: "x", where: [], first: "OldTimeSentinel", last: "OldTimeSentinel", count: 1 },
    ],
    core: { at: "2026-10-19T10:00:00.000Z", version: "2026.10.18-core.11", releaseId: "core-20261018-6f29d20", apiReady: true, storageReady: true },
  };
  const draft = JSON.stringify({ text: "DRAFT_SENTINEL in my unsent draft" });
  const p = await mount({ storage: { "yuzuno.diagnostics.v1": JSON.stringify(old), "yuzuno.composerDraft.v1:a": draft } });
  try {
    await waitFor(() => railShows(p, "Mori"), "the app is drawn");
    await openDiagnostics(p);
    await previewAndCopy(p);
    await waitFor(() => p.copied.length === 1, "the diagnostics are copied");
    const text = p.copied[0];
    const kept = p.w.localStorage.getItem("yuzuno.diagnostics.v1");
    for (const word of ["OldNameSentinel", "OldCodeSentinel", "OldKeySentinel", "PrivateProjectSentinel", "DRAFT_SENTINEL", "oldFnSentinel", "OldFrameSentinel", "OldStringSentinel", "OldTimeSentinel", "slice"]) {
      assert.ok(!text.includes(word), `${word} is not in the diagnostics`);
      assert.ok(!kept.includes(word), `${word} is no longer stored`);
    }
    assert.match(text, /^Recent errors on this device: 3 \(newest first, at most 12 kept\)$/m);
    assert.match(text, /^1\. error · Error · other code · http 500 · 2 times, 2026-10-19T10:00:00\.000Z to 2026-10-19T10:05:00\.000Z\n {3}other message, not kept\n {3}at index-AbC123\.js:1:2; \+1 frame outside Yuzuno$/m);
    assert.match(text, /^2\. rejection · Error · once, 2026-10-19T09:00:00\.000Z\n {3}other message, not kept$/m);
    assert.match(text, /^3\. render · TypeError · once, 2026-10-19T08:00:00\.000Z\n {3}read a property of null$/m);
    assert.equal(p.w.localStorage.getItem("yuzuno.composerDraft.v1:a"), draft, "the draft is kept as it was");
  } finally {
    p.close();
  }
});

test("Copy diagnostics adds Core's memory counters, read only for the text: numbers and the reasons Core names, nothing else from the report", async () => {
  const p = await mount();
  try {
    await waitFor(() => railShows(p, "Mori"), "the app is drawn");
    assert.equal(p.calls.filter((c) => c.url.endsWith("/api/diagnostics/memory")).length, 0, "nothing reads it until the text is made");
    await openDiagnostics(p);
    await previewAndCopy(p);
    await waitFor(() => p.copied.length === 1, "the diagnostics are copied");
    const text = p.copied[0];
    assert.match(text, /^Core: 2026\.10\.18-core\.11 /m, "Core's health is still read");
    assert.match(text, /^Core memory: read \S+, one part after another, not one snapshot$/m);
    assert.match(text, /^ {2}Process: RSS 678\.0 MiB, peak 903\.5 MiB, anonymous 671\.5 MiB, file 6\.5 MiB, swap 0\.0 MiB, 45 threads$/m);
    assert.match(text, /^ {2}glibc malloc, its own counts \(free space need not be resident\): arena 1100\.0 MiB, uordblks 126\.0 MiB, fordblks 967\.0 MiB, hblkhd 0\.0 MiB$/m);
    assert.match(text, /^ {2}Held records: 2 of 8; requests in flight: 1 \(this one included\)$/m);
    assert.match(text, /^ {2}Idle trim: maintenance tick running yes; waiting for heldRecords, heldGrace, 1 other; last check trimmed at 2026-10-21T19:00:00\+00:00, RSS 625\.0 MiB to 13\.5 MiB$/m);
    for (const word of ["MemoryNoteSentinel", "ReasonSentinel", "ExtraFieldSentinel", "/home/person", "kernel process status"]) assert.ok(!text.includes(word), `${word} is not copied`);
    assert.equal(p.calls.filter((c) => c.url.endsWith("/api/diagnostics/memory")).length, 1, "read once, for this text");
    assert.ok(!(p.w.localStorage.getItem("yuzuno.diagnostics.v1") || "").includes("uordblks"), "the memory read is not stored");
    assert.equal(p.calls.filter((c) => c.method && c.method !== "GET").length, 0, "copying sends nothing");
  } finally {
    p.close();
  }
});

test("when Core's memory can't be read, the text says why and everything else is still there", async () => {
  for (const [memory, reason] of [["unreachable", "not reachable"], ["older core", "http 404"], [{ format: 2 }, "not a memory report"]]) {
    const p = await mount({ named: false, memory });
    try {
      await waitFor(() => recovery(p), "the recovery page shows");
      p.button("Copy diagnostics", recovery(p)).click();
      await waitFor(() => p.copied.length === 1, "the diagnostics are copied");
      const text = p.copied[0];
      assert.match(text, new RegExp(`^Core memory: unknown \\(${reason}, \\S+\\)$`, "m"));
      assert.match(text, /^Core: 2026\.10\.18-core\.11 /m);
      assert.match(text, /^Recent errors on this device: 1 /m);
      assert.match(text, /^This text stays on this device/m);
    } finally {
      p.close();
    }
  }
  const q = await mount({ memory: { ...memoryReport, os: { available: false, reason: "Read only on Linux" }, allocator: { available: false, reason: "x" }, reclaim: { available: false, reason: "y", maintenanceTickRunning: false } } });
  try {
    await waitFor(() => railShows(q, "Mori"), "the app is drawn");
    await openDiagnostics(q);
    await previewAndCopy(q);
    await waitFor(() => q.copied.length === 1, "the diagnostics are copied");
    const text = q.copied[0];
    assert.match(text, /^ {2}Process: not available on this Core$/m, "a platform without the counts says so, never 0");
    assert.match(text, /^ {2}glibc malloc: not available on this Core$/m);
    assert.match(text, /^ {2}Idle trim: not available on this Core$/m);
  } finally {
    q.close();
  }
  // A trim in progress holds the gate: Core says so, and that is not "not available".
  const busy = await mount({ named: false, memory: { ...memoryReport, reclaim: { available: true, maintenanceTickRunning: true, gateBusy: true, gate: null } } });
  try {
    await waitFor(() => recovery(busy), "the recovery page shows");
    busy.button("Copy diagnostics", recovery(busy)).click();
    await waitFor(() => busy.copied.length === 1, "the diagnostics are copied");
    assert.match(busy.copied[0], /^ {2}Idle trim: maintenance tick running yes; a trim held its gate as Core read it, so what it waits for was not read$/m);
  } finally {
    busy.close();
  }
});

const historyCalls = (p) => p.calls.filter((c) => c.url.endsWith("/api/diagnostics/memory/history")).length;
async function openHistory(p) {
  await waitFor(() => railShows(p, "Mori"), "the app is drawn");
  return openSettingsEditor(p, "History & memory", "#settings-history");
}

test("the held Agents' stored history is read only when Measure is pressed: a chart and a table of Core's numbers, nothing else from the report", async () => {
  const p = await mount();
  try {
    const section = await openHistory(p);
    assert.equal(historyCalls(p), 0, "opening Settings does not read it");
    assert.match(section.textContent, /stored bytes, not the memory Core uses/);
    assert.ok(!section.querySelector("table"), "nothing is shown before it is read");
    await openDiagnostics(p);
    await previewAndCopy(p);
    await waitFor(() => p.copied.length === 1, "the diagnostics are copied");
    assert.equal(historyCalls(p), 0, "the diagnostics text does not read it");
    assert.ok(!p.copied[0].includes("Stored history"), "nor include it");
    assert.equal(await openHistory(p), section, "the same History editor, kept while Diagnostics was open");
    p.button("Measure", section).click();
    await waitFor(() => section.querySelector("table"), "the table shows");
    assert.equal(historyCalls(p), 1, "read once, for this press");
    const rows = [...section.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((c) => c.textContent));
    // Record adds the four disjoint parts; previews, a copy of payloads, stay outside it.
    assert.deepEqual(rows, [
      ["Mori *", "3.0 MiB (40)", "12.0 MiB (2)", "6.0 KiB (3)", "2.0 KiB (1)", "15.0 MiB", "8.0 KiB (2)"],
      ["Agent b0c1d2e3", "No stored rows yet"],
      ["Old †", "0 B (0)", "0 B (0)", "0 B (0)", "5.0 MiB (1)", "5.0 MiB", "0 B (0)"],
      ["All held", "3.0 MiB (40)", "12.0 MiB (2)", "6.0 KiB (3)", "5.0 MiB (2)", "20.0 MiB", "8.0 KiB (2)"],
    ]);
    assert.deepEqual([...section.querySelectorAll("thead th")].map((th) => th.textContent), ["Agent", "Item text", "Large payloads", "Turns", "Metadata", "Record", "Previews"]);
    // The read time in this device's time, with Core's own time kept on the element.
    assert.equal(section.querySelector("caption time").getAttribute("datetime"), "2026-10-23T08:00:00+00:00");
    assert.match(section.querySelector("caption").textContent, /^Stored bytes \(rows\), read \S/);
    assert.ok(!section.querySelector("caption").textContent.includes("2026-10-23T"), "not Core's raw timestamp");
    assert.match(section.textContent, /\* Has changes that may not yet be included in this report\./);
    assert.match(section.textContent, /† Stored in the older layout: the whole record is in its metadata row\./);
    assert.match(section.textContent, /Previews are a shorter copy of large payloads kept for clients, so they are not in it\./);
    assert.match(section.textContent, /The event journal, originals kept from before a conversion and salvaged rows are not counted\./);
    assert.ok(section.querySelector(".history-chart"), "the composition chart is drawn");
    assert.ok(section.querySelector('.history-table-scroll[role="region"][tabindex="0"] > table'), "the table scrolls in its own region on a narrow screen");
    assert.deepEqual([...section.querySelectorAll(".history-legend li")].map((li) => li.textContent), ["Item text", "Large payloads", "Turns", "Metadata"]);
    for (const word of ["HistoryNoteSentinel", "AgentFieldSentinel", "SqlSentinel", "/home/person"]) assert.ok(!p.doc.body.textContent.includes(word), `${word} is not shown`);
    assert.ok(!JSON.stringify(allStorage(p.w)).includes("Large payloads") && !JSON.stringify(allStorage(p.w)).includes("12582912"), "the read is not stored");
    await pause(200);
    assert.equal(historyCalls(p), 1, "and not read again by itself");
    p.button("Measure", section).click();
    await waitFor(() => historyCalls(p) === 2, "pressed again, read again");
    assert.equal(p.calls.filter((c) => c.method && c.method !== "GET").length, 0, "measuring sends nothing");
  } finally {
    p.close();
  }
});

test("when Core does not measure the stored history, the section says why and gives no numbers", async () => {
  const cases = [
    [{ format: 1, readAt: "2026-10-23T08:00:00+00:00", available: false, budgetMs: 2000, heldAgents: 3, note: "x", reason: "Not read within 2000 ms, so no part of it is given." }, /^Not measured: Not read within 2000 ms, so no part of it is given\.$/],
    [{ format: 1, readAt: "2026-10-23T08:00:00+00:00", available: false, budgetMs: 2000, note: "x", reason: "Another measurement is running; ask again once it has finished." }, /^Not measured: Another measurement is running; ask again once it has finished\.$/],
    ["older core", /^Not measured: this Core can't measure it\.$/],
    [{ format: 2 }, /^Not measured: not an answer this window understands\.$/],
    [{ ...historyReport, agents: [{ agentId: "a", name: "Mori", stored: true, items: part(-1, 0) }] }, /^Not measured: not an answer this window understands\.$/],
    [{ ...historyReport, heldAgents: 0, agents: [], total: historyReport.total }, /^No Agent's record is held now, so there is nothing to measure\.$/],
  ];
  for (const [history, says] of cases) {
    const p = await mount({ history });
    try {
      const section = await openHistory(p);
      p.button("Measure", section).click();
      // fetch is called before the button redraws, so wait for what the answer draws.
      await waitFor(() => section.querySelector('[role="status"]'), "the answer is shown");
      assert.equal(historyCalls(p), 1, "read once");
      assert.match(section.querySelector('[role="status"]').textContent, says);
      assert.ok(!section.querySelector("table"), "no numbers are given");
      assert.ok(!section.querySelector(".history-chart"), "nor a chart");
    } finally {
      p.close();
    }
  }
});

// T-189: the language changed in another window after a read. The page's own
// words change; Core's numbers, names and reasons stay as they came, and
// nothing is measured again.
function changeLanguage(p, language) {
  p.w.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  p.w.dispatchEvent(new p.w.StorageEvent("storage", { key: "yuzuno.language" }));
}
test("History in Chinese after a read: its own words change, Core's numbers and names stay, and nothing is measured again", async () => {
  const p = await mount();
  try {
    const section = await openHistory(p);
    p.button("Measure", section).click();
    await waitFor(() => section.querySelector("table"), "the table shows");
    const rows = () => [...section.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((c) => c.textContent));
    const en = { rows: rows(), text: section.textContent };
    changeLanguage(p, "zh-Hans");
    await waitFor(() => section.querySelector("h3").textContent === "Core 持有的 Agent 的已存储历史", "shown in Chinese");
    assert.equal(section.closest("[lang]").getAttribute("lang"), "zh-Hans");
    assert.match(section.textContent, /这些是已存储的字节，不是 Core 使用的内存。/);
    assert.deepEqual([...section.querySelectorAll("thead th")].map((th) => th.textContent), ["Agent", "条目文本", "大型载荷", "Turn", "元数据", "记录", "预览"]);
    assert.deepEqual([...section.querySelectorAll(".history-legend li")].map((li) => li.textContent), ["条目文本", "大型载荷", "Turn", "元数据"]);
    assert.deepEqual(rows(), [
      ["Mori *", "3.0 MiB (40)", "12.0 MiB (2)", "6.0 KiB (3)", "2.0 KiB (1)", "15.0 MiB", "8.0 KiB (2)"],
      ["Agent b0c1d2e3", "尚无已存储的行"],
      ["Old †", "0 B (0)", "0 B (0)", "0 B (0)", "5.0 MiB (1)", "5.0 MiB", "0 B (0)"],
      ["全部持有", "3.0 MiB (40)", "12.0 MiB (2)", "6.0 KiB (3)", "5.0 MiB (2)", "20.0 MiB", "8.0 KiB (2)"],
    ]);
    assert.match(section.querySelector("caption").textContent, /^已存储字节（行数），读取于 \S/);
    assert.equal(section.querySelector("caption time").getAttribute("datetime"), "2026-10-23T08:00:00+00:00");
    assert.match(section.textContent, /\* 有更改可能尚未包含在此报告中。/);
    assert.match(section.textContent, /† 以旧版布局存储：整条记录都在其元数据行中。/);
    assert.ok(p.button("测量", section), "Measure is offered again, not pressed");
    await pause(200);
    assert.equal(historyCalls(p), 1, "the language change measures nothing");
    changeLanguage(p, "en");
    await waitFor(() => section.querySelector("h3").textContent === "Stored history of held Agents", "back in English");
    assert.deepEqual([rows(), section.textContent], [en.rows, en.text], "as it was in English");
    assert.equal(historyCalls(p), 1);
  } finally {
    p.close();
  }
  // Why it wasn't measured: this window's words in Chinese, Core's as it said them.
  for (const [history, en, zh] of [
    ["older core", "Not measured: this Core can't measure it.", "未测量：此 Core 无法测量。"],
    [{ format: 1, readAt: "2026-10-23T08:00:00+00:00", available: false, reason: "Another measurement is running; ask again once it has finished." },
      "Not measured: Another measurement is running; ask again once it has finished.", "未测量：Another measurement is running; ask again once it has finished."],
  ]) {
    const q = await mount({ history });
    try {
      const section = await openHistory(q);
      q.button("Measure", section).click();
      await waitFor(() => section.querySelector('[role="status"]'), "the answer is shown");
      assert.equal(section.querySelector('[role="status"]').textContent, en);
      changeLanguage(q, "zh-Hans");
      await waitFor(() => section.querySelector('[role="status"]').textContent === zh, "said in Chinese");
      assert.equal(historyCalls(q), 1, "not measured again");
    } finally {
      q.close();
    }
  }
});

// Settings' diagnostics (T-193): the text is shown before anything leaves the
// window. Copy and Download then take exactly that text.
function watchSaves(p) {
  const saves = { blobs: [], links: [], fail: null };
  p.w.URL.createObjectURL = (blob) => {
    if (saves.fail) throw new p.w.Error(saves.fail);
    saves.blobs.push(blob);
    return "blob:http://127.0.0.1:4317/fixture";
  };
  p.w.URL.revokeObjectURL = () => {};
  p.w.HTMLAnchorElement.prototype.click = function () { saves.links.push({ href: this.getAttribute("href"), download: this.getAttribute("download") }); };
  return saves;
}
const blobText = (p, blob) => new Promise((resolve) => {
  const reader = new p.w.FileReader();
  reader.onload = () => resolve(reader.result);
  reader.readAsText(blob);
});

test("Settings shows the diagnostics first: Preview copies, saves and sends nothing; Copy and Download take exactly that text", async () => {
  const p = await mount();
  try {
    await waitFor(() => railShows(p, "Mori"), "the app is drawn");
    const saves = watchSaves(p);
    const section = await openDiagnostics(p);
    assert.equal(shownText(p), undefined, "nothing is gathered until asked");
    const before = p.calls.length;
    p.button("Preview diagnostics", section).click();
    await waitFor(() => shownText(p), "the diagnostics are shown");
    assert.match(section.textContent, /This is the whole text\. Nothing has been copied, saved or sent\./);
    assert.deepEqual([p.copied.length, saves.blobs.length, saves.links.length], [0, 0, 0], "previewing copies and saves nothing");
    assert.deepEqual(p.calls.slice(before).filter((c) => c.method && c.method !== "GET"), [], "and sends nothing");
    const text = shownText(p);
    assert.match(text, /^Recent errors on this device: /m);
    p.button("Copy", section).click();
    await waitFor(() => /Copied\. Nothing was sent anywhere/.test(section.textContent), "the copy is said");
    assert.deepEqual(p.copied, [text], "exactly the shown text is copied");
    assert.match(text, /^Gathered: \S+$/m, "the text says when it was gathered, not that it was copied");
    p.button("Download .txt", section).click();
    await waitFor(() => saves.links.length === 1, "a download is asked for");
    assert.match(saves.links[0].download, /^yuzuno-diagnostics-[\dTZ-]+\.txt$/);
    assert.equal(await blobText(p, saves.blobs[0]), text, "the file holds the shown text");
    assert.match(section.textContent, /Your browser was asked to save yuzuno-diagnostics-[\dTZ-]+\.txt\. If no file appears, select the text below and copy it\./);
    assert.equal(p.copied.length, 1, "downloading does not copy");
    // While Preview again gathers (Core's health read held open), the shown text is about
    // to change: Copy and Download wait.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const answer = p.w.fetch;
    p.w.fetch = async (url, init) => { if (String(url).endsWith("/api/health")) await held; return answer(url, init); };
    p.button("Preview again", section).click();
    await waitFor(() => p.button("Copy", section).disabled, "Copy waits while the text is gathered again");
    assert.equal(p.button("Download .txt", section).disabled, true);
    release();
    await waitFor(() => !p.button("Copy", section).disabled, "the new text is shown");
    assert.deepEqual([p.copied.length, saves.links.length], [1, 1], "nothing left while it gathered");
  } finally {
    p.close();
  }
});

test("a refused clipboard says to select the text, and a download that cannot start says so; neither claims success", async () => {
  const p = await mount({ clipboard: "denied" });
  try {
    await waitFor(() => railShows(p, "Mori"), "the app is drawn");
    const saves = watchSaves(p);
    const section = await openDiagnostics(p);
    p.button("Preview diagnostics", section).click();
    await waitFor(() => shownText(p), "the diagnostics are shown");
    p.button("Copy", section).click();
    await waitFor(() => /can't use the clipboard\. Select the text below and copy it\./.test(section.textContent), "the refusal is said");
    assert.doesNotMatch(section.textContent, /Copied\./);
    saves.fail = "Blob URLs are blocked here";
    p.button("Download .txt", section).click();
    await waitFor(() => section.querySelector('[role="alert"]'), "the failed download is said");
    assert.match(section.querySelector('[role="alert"]').textContent, /^The download could not start \(Blob URLs are blocked here\)\. Select the text below and copy it\.$/);
    assert.doesNotMatch(section.textContent, /asked to save/);
    assert.equal(saves.links.length, 0);
    assert.ok(shownText(p), "the text stays to select");
  } finally {
    p.close();
  }
});
