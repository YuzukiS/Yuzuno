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

/**
 * The built app, with the page's script tag as Core serves it. `named: false`
 * serves an Agent without a name, which the rail can't draw: a real render
 * error that no part of the app handles.
 */
async function mount({ named = true, storage = {}, clipboard = "ok", desktop = null } = {}) {
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
    if (url.endsWith("/api/workspace"))
      return respond({
        workspace: { id: "ws-1" },
        projects: [{ id: "p-app", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
        agents: [{ ...base, id: "a", name: state.named ? "Mori" : null }],
        runtime: { connected: true },
        defaultCwd: "/w",
      });
    if (url.endsWith("/api/updates")) return respond(updates);
    return respond({});
  };
  const doc = w.document;
  const button = (text, root = doc) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text));
  w.eval(bundle);
  return { w, doc, calls, copied, state, button, close: () => w.close() };
}
const recovery = (p) => p.doc.querySelector(".app-recovery");
const railShows = (p, name) => new RegExp(name).test(p.doc.querySelector(".agent-list")?.textContent || "");
const shownText = (p) => p.doc.querySelector('textarea[aria-label="Diagnostics"]')?.value;
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
    p.doc.querySelector('[aria-label="Settings and updates"]').click();
    await waitFor(() => p.doc.querySelector("#settings-diagnostics"), "Settings shows Diagnostics");
    p.button("Copy diagnostics", p.doc.querySelector("#settings-diagnostics")).click();
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
    q.doc.querySelector('[aria-label="Settings and updates"]').click();
    await waitFor(() => q.doc.querySelector("#settings-diagnostics"), "Settings shows Diagnostics");
    q.button("Copy diagnostics", q.doc.querySelector("#settings-diagnostics")).click();
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
    p.doc.querySelector('[aria-label="Settings and updates"]').click();
    await waitFor(() => p.doc.querySelector("#settings-diagnostics"), "Settings shows Diagnostics");
    p.button("Copy diagnostics", p.doc.querySelector("#settings-diagnostics")).click();
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
