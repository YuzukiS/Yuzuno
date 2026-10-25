import "./jsdom-guard.mjs";
// T-185: Settings → Phone access, against a stub Core that answers as the
// T-185 interface v1 (task comment 6798): the view, Check, apply (and
// disable as apply with enabled:false) and an operation's progress. The
// backend's own example views (fixtures/remote-access-views.json, Dev 5)
// are read as they are.
// Opening it only reads; the four states are shown apart; an address is
// shown only when the view has one; how a change ended is said with its
// step; a lost answer is asked again as the same request.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "remote-access-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteAccessSettings} from ${JSON.stringify(path.join(root, "src/RemoteAccessSettings.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderSettings = props => root.render(<RemoteAccessSettings {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, cssCodeSplit: false, lib: { entry, name: "RemoteAccessUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const ENTRY = "https://desk.example.ts.net:8444";
const examples = JSON.parse(await readFile(new URL("./fixtures/remote-access-views.json", import.meta.url), "utf8"));
/** One of the backend's example views; the two partial ones are said to be
 * appliedVerified with their own fields. */
function example(name) {
  const { _note, ...own } = structuredClone(examples[name]);
  return name === "appliedNotVerified" || name === "remoteEntryReadOnly" ? { ...structuredClone(examples.appliedVerified), ...own } : own;
}
/** An error from the examples, `"<status> <json>"`, as the stub answers it. */
function exampleError(name) {
  const [, status, body] = /^(\d+) (.*)$/.exec(examples.errors[name]);
  return { status: Number(status), body: JSON.parse(body) };
}
// A request is kept per Workspace (T-195); the page here is in this one.
const STORE = "yuzuno.remoteAccess.pending:ws-a";

/** `handler(url, method, body)` answers `{status, body}`, or throws a
 * TypeError for an answer that never arrives. */
function mount(handler, { url = "http://isolated.test/", storage = {} } = {}) {
  const calls = [];
  const vc = new VirtualConsole();
  const dom = new JSDOM('<div id="root"></div>', { url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  for (const [key, value] of Object.entries(storage)) dom.window.localStorage.setItem(key, JSON.stringify(value));
  const copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (text) => { copied.push(text); } } });
  dom.window.fetch = async (input, init = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(input), method, body });
    let answered;
    try {
      answered = await handler(String(input), method, body);
    } catch (error) {
      // As the page's own fetch fails: a TypeError of its realm.
      throw error instanceof TypeError ? new dom.window.TypeError(error.message) : error;
    }
    const { status = 200, body: answer } = answered;
    const text = JSON.stringify(answer);
    return { ok: status < 400, status, json: async () => structuredClone(answer), text: async () => text };
  };
  dom.window.eval(bundle);
  dom.window.renderSettings({ active: true, workspaceId: "ws-a" });
  const doc = dom.window.document;
  return {
    window: dom.window, doc, calls, copied,
    writes: () => calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/check")),
    text: () => doc.querySelector("#settings-remote")?.textContent ?? "",
    states: () => [...doc.querySelectorAll(".remote-access-states li")].map((li) => [li.dataset.tone, li.textContent]),
    alerts: () => [...doc.querySelectorAll('[role="alert"]')].map((a) => a.textContent),
    applies: () => calls.filter((c) => c.url.endsWith("/api/remote-access/apply")),
    close: () => dom.window.close(),
  };
}
const button = (p, text) => [...p.doc.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
async function waitFor(f, what) {
  for (let i = 0; i < 200; i++) {
    if (f()) return;
    await tick();
  }
  assert.fail(`Expected UI state did not appear: ${what}`);
}
function type(p, label, value) {
  const input = p.doc.querySelector(`input[aria-label="${label}"]`);
  Object.getOwnPropertyDescriptor(p.window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new p.window.Event("input", { bubbles: true }));
}

/** Core's view: a supported WSL Core with Tailscale on Windows, entry off. */
function view(over = {}) {
  return {
    support: {
      state: "supported",
      coreHost: { kind: "wsl", name: "Ubuntu", networking: "mirrored" },
      tailscaleHost: { kind: "windows", cli: "/mnt/c/Program Files/Tailscale/tailscale.exe", version: "1.90.0" },
    },
    saved: null,
    environment: null,
    listening: null,
    serve: { state: "unchecked", otherEntries: 0 },
    tailscale: null,
    verification: null,
    operation: null,
    url: null,
    defaults: { servePort: 8444, localPort: 4318 },
    canChange: true,
    ...over,
  };
}
const tailscale = { state: "running", dnsName: "desk.example.ts.net", ownerLogin: "user@example.com", https: true, observedAt: "2026-10-24T17:00:00Z" };
const checkedView = (over = {}) => view({ tailscale, serve: { state: "absent", otherEntries: 1, observedAt: "2026-10-24T17:00:00Z" }, ...over });
const op = (state, step, extra = {}) => ({ id: "op-1", requestId: "r", kind: "apply", state, step, startedAt: "2026-10-24T17:00:01Z", ...extra });
const on = (over = {}) => view({
  tailscale,
  saved: { enabled: true, login: "user@example.com", servePort: 8444, localPort: 4318, origin: ENTRY, savedAt: "2026-10-24T17:00:02Z", applied: true },
  listening: { port: 4318, origin: ENTRY, login: "user@example.com", since: "2026-10-24T17:00:03Z", source: "settings" },
  serve: { state: "ours", port: 8444, target: "http://127.0.0.1:4318", otherEntries: 1, observedAt: "2026-10-24T17:00:04Z" },
  verification: { ok: true, at: "2026-10-24T17:00:05Z", steps: [] },
  url: `${ENTRY}/`,
  qr: { size: 3, rows: ["101", "010", "111"] },
  ...over,
});

test("opening it only reads, and saved settings alone are not shown as reachable", async () => {
  const p = mount(() => ({
    body: view({
      saved: { enabled: true, login: "user@example.com", servePort: 8444, localPort: 4318, origin: ENTRY, savedAt: "x", applied: false },
    }),
  }));
  try {
    await waitFor(() => p.states().length === 4, "the four states");
    assert.deepEqual(p.states().map(([tone]) => tone), ["warn", "off", "unknown", "unknown"]);
    assert.match(p.states()[0][1], /^Saved settingsOn · https:\/\/desk\.example\.ts\.net:8444 · user@example\.com · not applied$/);
    assert.match(p.states()[1][1], /Not listening/);
    assert.match(p.states()[2][1], /Not checked yet/);
    assert.match(p.states()[3][1], /Not checked yet/);
    assert.equal(p.doc.querySelector(".settings-current").textContent, "Not applied");
    assert.equal(!!p.doc.querySelector(".remote-access-result"), false, "no address without one in the view");
    assert.match(p.text(), /WSL · Ubuntu · mirrored networking/);
    assert.match(p.text(), /Windows · not checked yet/);
    await tick();
    assert.deepEqual(p.calls.map((c) => `${c.method} ${c.url}`), ["GET /api/remote-access"], "one read, nothing else");
  } finally {
    p.close();
  }
});

test("before it is set up, a check says what is ready, not that the entry failed", async () => {
  const free = { id: "serve", state: "skipped", detail: "Port 8444 is free for phone access; Save and apply sets it" };
  const steps = (tailscaleStep, serveStep = free) => [
    { id: "host", state: "ok", detail: "WSL with mirrored networking" },
    tailscaleStep,
    { id: "https", state: "ok", detail: "HTTPS certificates are on" },
    { id: "listener", state: "failed", detail: "Core is not listening for phone access" },
    { id: "hop", state: "skipped", detail: "" },
    serveStep,
    { id: "endToEnd", state: "skipped", detail: "" },
  ];
  const ready = { id: "tailscale", state: "ok", detail: "running" };
  const taken = "Port 8444 is already used by another Serve configuration (https://pc.tail0.ts.net:8444/ → http://127.0.0.1:9999); it is left as it is";
  const views = [
    [checkedView({ verification: { ok: false, at: "x", steps: steps(ready) } }), ["off", "VerificationNot set up; Core's host, Tailscale and HTTPS are ready"], "Off"],
    [checkedView({ verification: { ok: false, at: "x", steps: steps({ id: "tailscale", state: "failed", detail: "Tailscale is stopped" }) } }),
      ["warn", "VerificationNot ready: “Tailscale on Windows”: Tailscale is stopped"], "Off"],
    // Another entry holds the Serve port: a Check before setup says so, and
    // what to do; the Serve line has Core's sentence once.
    [checkedView({ serve: { state: "conflict", port: 8444, otherEntries: 1, detail: taken },
      verification: { ok: false, at: "x", steps: steps(ready, { id: "serve", state: "failed", detail: taken }) } }),
      ["warn", "VerificationNot ready: port 8444 is taken; choose another Serve port under Advanced"], "Off",
      ["warn", `Tailscale Serve${taken}`]],
    // Core listening for it: the same failure is the entry's own.
    [checkedView({ listening: { port: 4318, origin: ENTRY, login: "user@example.com", since: "x", source: "environment" }, verification: { ok: false, at: "x", steps: steps(ready) } }),
      ["warn", "VerificationFailed at “Core's phone port”: Core is not listening for phone access"], "Incomplete"],
    // Listening from the environment, Serve not looked at yet.
    [view({ listening: { port: 4318, origin: ENTRY, login: "user@example.com", since: "x", source: "environment" } }), ["unknown", "VerificationNot checked yet"], "Not checked"],
  ];
  for (const [body, line, badge, serveLine] of views) {
    const p = mount(() => ({ body }));
    try {
      await waitFor(() => p.states().length === 4, "the four states");
      assert.deepEqual(p.states()[3], line);
      if (serveLine) assert.deepEqual(p.states()[2], serveLine);
      assert.equal(p.doc.querySelector(".settings-current").textContent, badge);
    } finally {
      p.close();
    }
  }
});

/** jsdom has no layout: what the page asks to bring into view, as
 * [text, options] (options copied out of the page's realm). */
function recordScrolls(p) {
  const shown = [];
  p.window.HTMLElement.prototype.scrollIntoView = function (options) {
    shown.push([this.textContent, { ...options }]);
  };
  return shown;
}

test("a port out of range is said where it can be seen, every time, and nothing is sent", async () => {
  const p = mount((url) => {
    if (url.endsWith("/check")) return { body: checkedView() };
    return { body: view() };
  });
  const shown = recordScrolls(p);
  try {
    await waitFor(() => button(p, "Check"), "the form");
    button(p, "Check").click();
    await waitFor(() => !button(p, "Save and apply").disabled, "checked");
    type(p, "Serve port", "70000");
    const refusal = "The Serve port must be a port from 1 to 65535.";
    button(p, "Save and apply").click();
    await waitFor(() => p.alerts().includes(refusal), "the refusal");
    assert.deepEqual(shown, [[refusal, { block: "nearest" }]]);
    await tick();
    await tick();
    assert.equal(shown.length, 1, "once per time it is said");
    // Pressed again after scrolling away: brought into view again.
    button(p, "Save and apply").click();
    await waitFor(() => shown.length === 2, "shown again");
    assert.deepEqual(shown[1], [refusal, { block: "nearest" }]);
    assert.equal(p.applies().length, 0, "nothing sent");
  } finally {
    p.close();
  }
});

test("a refusal from Core is brought into view once; reading Core again does not scroll", async () => {
  let current = checkedView();
  const p = mount((url, method) => {
    if (url.endsWith("/api/remote-access") && method === "GET") return { body: current };
    if (url.endsWith("/check")) return { body: current };
    if (url.includes("/operations/")) return { body: current.operation };
    current = checkedView({ operation: op("running", "save", { requestId: "someone-else" }) });
    return exampleError("busy");
  });
  const shown = recordScrolls(p);
  try {
    await waitFor(() => button(p, "Check"), "the form");
    button(p, "Check").click();
    await waitFor(() => !button(p, "Save and apply").disabled, "checked");
    button(p, "Save and apply").click();
    await waitFor(() => p.alerts().some((a) => /already running/.test(a)), "the refusal");
    assert.equal(shown.length, 1);
    assert.match(shown[0][0], /already running/);
    // The running change is read about once a second: none of it scrolls.
    await waitFor(() => p.calls.filter((c) => c.url.includes("/operations/")).length >= 2, "two reads of the change");
    assert.equal(shown.length, 1, "reading Core again does not scroll");
    assert.notEqual(p.doc.activeElement, p.doc.querySelector('[role="alert"]'), "focus stays where it was");
  } finally {
    p.close();
  }
});

test("a Core it cannot set up says why and offers nothing to change", async () => {
  const p = mount(() => ({ body: example("unsupported") }));
  try {
    await waitFor(() => p.doc.querySelector(".remote-access-note"), "the reason");
    assert.match(p.text(), /cannot be set up from here for this Core: This Core runs on Linux, not WSL\./);
    assert.match(p.text(), /Linux · lab-host/);
    assert.match(p.text(), /Tailscale runs onNot found/);
    for (const label of ["Check", "Save and apply", "Turn off"]) assert.equal(!!button(p, label), false, label);
  } finally {
    p.close();
  }
});

test("check, then save and apply: progress by step, then the address with copy and code", async () => {
  let current = view();
  let polls = 0;
  const p = mount((url, method, body) => {
    if (url.endsWith("/api/remote-access") && method === "GET") return { body: current };
    if (url.endsWith("/check")) return { body: (current = checkedView()) };
    if (url.endsWith("/apply")) {
      current = checkedView({ operation: op("running", "listen", { requestId: body.requestId }) });
      return { status: 202, body: { operation: current.operation } };
    }
    if (url.endsWith("/operations/op-1")) {
      if (++polls < 2) return { body: op("running", "serve", { requestId: current.operation.requestId }) };
      current = on({ operation: op("succeeded", "done", { requestId: current.operation.requestId, url: `${ENTRY}/`, notes: ["The earlier entry on port 8444 was removed."] }) });
      return { body: current.operation };
    }
    return { status: 404, body: { error: "no" } };
  });
  try {
    await waitFor(() => button(p, "Check"), "the form");
    assert.equal(button(p, "Save and apply").disabled, true, "applied only after a check");
    button(p, "Check").click();
    await waitFor(() => !button(p, "Save and apply").disabled, "checked");
    assert.deepEqual(p.calls.find((c) => c.url.endsWith("/check")).body, {});
    assert.match(p.text(), /Windows · desk\.example\.ts\.net · running/);
    assert.match(p.states()[2][1], /No Yuzuno entry · 1 other entry left as it is/);
    assert.equal(p.doc.querySelector(".remote-access-preview").textContent, "Your phone will open https://desk.example.ts.net:8444");
    type(p, "Serve port", "443");
    assert.equal(p.doc.querySelector(".remote-access-preview").textContent, "Your phone will open https://desk.example.ts.net", "no port for 443");
    type(p, "Serve port", "9443");
    assert.equal(p.doc.querySelector(".remote-access-preview").textContent, "Your phone will open https://desk.example.ts.net:9443");
    button(p, "Save and apply").click();
    await waitFor(() => p.doc.querySelector(".remote-access-steps"), "the steps");
    const apply = p.applies()[0].body;
    assert.match(apply.requestId, /^remote-[0-9a-f]{24}$/);
    assert.deepEqual({ ...apply, requestId: "" }, { requestId: "", enabled: true, servePort: 9443 });
    assert.equal(p.doc.querySelector('.remote-access-steps [data-state="running"]').textContent, "Core listens on the phone's port");
    assert.equal(button(p, "Check").disabled, true, "nothing else while it runs");
    await waitFor(() => p.doc.querySelector('.remote-access-steps [data-state="running"]')?.textContent === "Tailscale Serve points to it", "the next step");
    await waitFor(() => p.doc.querySelector(".remote-access-result"), "the address");
    assert.equal(p.doc.querySelector(".remote-access-result a").getAttribute("href"), `${ENTRY}/`);
    assert.equal(p.doc.querySelector(".remote-access-qr path").getAttribute("d"), "M4,4h1v1h-1zM6,4h1v1h-1zM5,5h1v1h-1zM4,6h1v1h-1zM5,6h1v1h-1zM6,6h1v1h-1z");
    assert.equal(p.doc.querySelector(".settings-current").textContent, "On");
    assert.match(p.text(), /Applied\./);
    assert.deepEqual([...p.doc.querySelectorAll(".remote-access-notes li")].map((li) => li.textContent), ["The earlier entry on port 8444 was removed."]);
    button(p, "Copy").click();
    await waitFor(() => button(p, "Copied"), "copied");
    assert.deepEqual(p.copied, [`${ENTRY}/`]);
    assert.equal(p.window.localStorage.getItem(STORE), null, "the request ends with its change");
    assert.equal(p.applies().length, 1);
  } finally {
    p.close();
  }
});

test("how a change ended is said with its step, the input stays, and trying again is a new request", async () => {
  const endings = [
    [op("failed", "listen", { error: "Port 4318 is already in use." }), /Applying stopped at “Core listens on the phone's port”: Port 4318 is already in use\./],
    [op("rolledBack", "serve", { error: "Port 8444 is used by another Serve entry." }), /Applying stopped at “Tailscale Serve points to it” and was undone: Port 8444 is used by another Serve entry\./],
    [op("failed", "verify", { error: "Applied, but not verified: Windows could not reach Core on 127.0.0.1:4318" }), /^Applied, but not verified: Windows could not reach Core on 127\.0\.0\.1:4318\.$/],
  ];
  let current = checkedView();
  let ending = 0;
  const p = mount((url, method, body) => {
    if (method === "GET") return { body: current };
    if (url.endsWith("/check")) return { body: current };
    current = checkedView({ operation: { ...endings[ending][0], requestId: body.requestId } });
    return { status: 202, body: { operation: current.operation } };
  });
  try {
    await waitFor(() => button(p, "Check"), "the form");
    button(p, "Check").click();
    await waitFor(() => !button(p, "Save and apply").disabled, "checked");
    type(p, "Allowed login", "user@example.com");
    for (ending = 0; ending < endings.length; ending++) {
      const before = p.applies().length;
      button(p, "Save and apply").click();
      await waitFor(() => p.applies().length === before + 1, "applied");
      await waitFor(() => p.alerts().some((a) => endings[ending][1].test(a)), `ending ${ending}`);
      assert.equal(!!p.doc.querySelector(".remote-access-result"), false, "nothing shown as reachable");
      assert.equal(p.doc.querySelector('input[aria-label="Allowed login"]').value, "user@example.com", "the input stays");
    }
    const ids = p.applies().map((c) => c.body.requestId);
    assert.equal(new Set(ids).size, 3, "each try after an ending is a new request");
  } finally {
    p.close();
  }
});

test("a lost answer is shown as unknown, asking again is the same request, and uncertain says to check", async () => {
  let lose = true;
  let current = checkedView();
  const p = mount((url, method, body) => {
    if (method === "GET") return { body: current };
    if (url.endsWith("/check")) return { body: current };
    if (lose) {
      lose = false;
      throw new TypeError("Failed to fetch");
    }
    current = checkedView({ operation: op("uncertain", "serve", { requestId: body.requestId, error: "tailscale.exe did not answer within 20 s." }) });
    return { status: 202, body: { operation: current.operation } };
  });
  try {
    await waitFor(() => button(p, "Check"), "the form");
    button(p, "Check").click();
    await waitFor(() => !button(p, "Save and apply").disabled, "checked");
    button(p, "Save and apply").click();
    await waitFor(() => p.alerts().some((a) => /answer did not arrive/.test(a)), "the lost answer");
    const kept = JSON.parse(p.window.localStorage.getItem(STORE));
    button(p, "Save and apply").click();
    await waitFor(() => p.applies().length === 2, "asked again");
    const [one, two] = p.applies().map((c) => c.body.requestId);
    assert.equal(one, two, "the same request");
    assert.equal(kept.requestId, one);
    await waitFor(() => p.alerts().some((a) => /could not confirm how “Tailscale Serve points to it” ended: tailscale\.exe did not answer within 20 s\. Check, or apply again/.test(a)), "uncertain");
  } finally {
    p.close();
  }
});

test("another change already running is shown, not started twice", async () => {
  let current = checkedView();
  const p = mount((url, method) => {
    if (url.endsWith("/api/remote-access") && method === "GET") return { body: current };
    if (url.endsWith("/check")) return { body: current };
    if (url.includes("/operations/")) return { body: current.operation };
    current = checkedView({ operation: op("running", "save", { requestId: "someone-else" }) });
    return exampleError("busy");
  });
  try {
    await waitFor(() => button(p, "Check"), "the form");
    button(p, "Check").click();
    await waitFor(() => !button(p, "Save and apply").disabled, "checked");
    button(p, "Save and apply").click();
    await waitFor(() => p.alerts().some((a) => /already running/.test(a)), "the conflict");
    await waitFor(() => p.doc.querySelector('.remote-access-steps [data-state="running"]'), "its progress");
    assert.equal(button(p, "Save and apply").disabled, true);
    assert.equal(p.applies().length, 1);
  } finally {
    p.close();
  }
});

test("on the phone entry itself the page only shows: the address, and no way to change it", async () => {
  const p = mount(() => ({ body: example("remoteEntryReadOnly") }), { url: "https://pc.tail0.ts.net:8444/" });
  try {
    await waitFor(() => p.doc.querySelector(".remote-access-result"), "the address");
    assert.match(p.text(), /This page is open through the phone entry\. Change phone access from Yuzuno on the computer, so this phone cannot lock itself out\./);
    for (const label of ["Check", "Save and apply", "Turn off"]) assert.equal(!!button(p, label), false, label);
    assert.deepEqual(p.states().map(([tone]) => tone), ["on", "on", "on", "on"]);
    assert.deepEqual(p.writes(), []);
  } finally {
    p.close();
  }
});

test("an entry set up from Core's environment says so, Turn off sends enabled:false, and a kept draft survives a reload", async () => {
  const pending = { requestId: "remote-aaaaaaaaaaaaaaaaaaaaaaaa", draft: { enabled: true, servePort: 9443, login: "other@example.com" } };
  let current = example("environmentNotRecorded");
  const p = mount((url, method, body) => {
    if (method === "GET") return { body: current };
    current = view({ operation: op("succeeded", "done", { requestId: body.requestId, kind: "disable" }) });
    return { status: 202, body: { operation: current.operation } };
  }, { storage: { [STORE]: pending } });
  try {
    await waitFor(() => p.states().length === 4, "the states");
    assert.match(p.text(), /set up outside Settings, from Core's environment\. Save and apply with the same values takes it over/);
    assert.deepEqual(p.states()[1], ["on", "Core listeningOn, port 4318 for https://pc.tail0.ts.net:8444 · from Core's environment"]);
    assert.deepEqual(p.states()[2], ["warn", "Tailscale ServeAn entry on port 8444 points to Core, but Settings did not make it · 2 other entries left as they are"]);
    assert.equal(p.doc.querySelector('input[aria-label="Serve port"]').value, "9443");
    assert.equal(p.doc.querySelector('input[aria-label="Allowed login"]').value, "other@example.com");
    button(p, "Turn off").click();
    await waitFor(() => p.applies().length === 1, "turned off");
    const sent = p.applies()[0].body;
    assert.deepEqual({ ...sent, requestId: "" }, { requestId: "", enabled: false });
    assert.notEqual(sent.requestId, pending.requestId, "another change, another request");
    await waitFor(() => /Turned off\./.test(p.text()), "turned off");
  } finally {
    p.close();
  }
});

test("the backend's example views read as they should, and none of them is written to", async () => {
  const cases = {
    appliedVerified: (p) => {
      assert.equal(p.doc.querySelector(".settings-current").textContent, "On");
      assert.match(p.text(), /Core's environment also sets an entry; the saved settings decide, so it is ignored/);
      assert.match(p.text(), /Applied\. The status above is what Core reports now\./);
      assert.equal(p.doc.querySelector(".remote-access-result a").getAttribute("href"), "https://pc.tail0.ts.net:8444");
      assert.deepEqual(p.states().map(([tone]) => tone), ["on", "on", "on", "on"]);
      const qr = p.doc.querySelector(".remote-access-qr");
      assert.equal(qr.getAttribute("viewBox"), "0 0 33 33", "25 modules and a four-module margin");
      assert.equal(qr.getAttribute("aria-label"), "QR code for https://pc.tail0.ts.net:8444");
      assert.match(qr.querySelector("path").getAttribute("d"), /^M4,4h1v1h-1z/);
    },
    rolledBackAtServe: (p) => {
      assert.deepEqual(p.states()[0], ["warn", "Saved settingsOn · https://pc.tail0.ts.net:8445 · owner@github · not applied"]);
      assert.match(p.states()[1][1], /On, port 4318 for https:\/\/pc\.tail0\.ts\.net:8444$/);
      assert.equal(p.doc.querySelector(".remote-access-result a").getAttribute("href"), "https://pc.tail0.ts.net:8444", "the entry that still applies");
      assert.ok(p.alerts().some((a) => /^Applying stopped at “Tailscale Serve points to it” and was undone: Port 8445 is already used by another Serve configuration .*the previous phone access is unchanged\.$/.test(a)), p.alerts().join("|"));
    },
    appliedNotVerified: (p) => {
      assert.equal(p.doc.querySelector(".settings-current").textContent, "Not verified");
      assert.deepEqual(p.states()[3], ["warn", "VerificationFailed at “From Windows to Core”: Windows could not reach Core on 127.0.0.1:4318 (…); WSL networking is nat"]);
      assert.ok(p.alerts().some((a) => /^Applied, but not verified: Windows could not reach Core on 127\.0\.0\.1:4318 \(…\); WSL networking is nat \(hop\)\.$/.test(a)), p.alerts().join("|"));
      assert.match(p.doc.querySelector(".remote-access-result").textContent, /Set up, but not verified: it may not open on your phone yet/);
    },
    startupError: (p) => {
      assert.ok(p.alerts().some((a) => a === "When Core started, it could not serve the phone entry: Port 4318 is used by another program."), p.alerts().join("|"));
    },
  };
  for (const [name, expect] of Object.entries(cases)) {
    const body = name === "startupError"
      ? { ...example("appliedVerified"), startupError: "Port 4318 is used by another program." }
      : example(name);
    const p = mount(() => ({ body }));
    try {
      await waitFor(() => p.states().length === 4, `${name}: the states`);
      expect(p);
      await tick();
      assert.deepEqual(p.writes(), [], name);
    } finally {
      p.close();
    }
  }
});

test("a request ID Core already used for another change is dropped, and the next try is new", async () => {
  let refuse = true;
  let current = checkedView();
  const p = mount((url, method, body) => {
    if (method === "GET") return { body: current };
    if (url.endsWith("/check")) return { body: current };
    if (refuse) {
      refuse = false;
      return exampleError("idempotency");
    }
    current = checkedView({ operation: op("succeeded", "done", { requestId: body.requestId }) });
    return { status: 202, body: { operation: current.operation } };
  }, { storage: { [STORE]: { requestId: "remote-bbbbbbbbbbbbbbbbbbbbbbbb", draft: { enabled: true } } } });
  try {
    await waitFor(() => button(p, "Check"), "the form");
    button(p, "Check").click();
    await waitFor(() => !button(p, "Save and apply").disabled, "checked");
    button(p, "Save and apply").click();
    await waitFor(() => p.alerts().some((a) => /requestId already names a different phone access change\. Press again/.test(a)), "the refusal, without its code");
    assert.equal(p.applies()[0].body.requestId, "remote-bbbbbbbbbbbbbbbbbbbbbbbb", "the kept request was asked first");
    assert.equal(p.window.localStorage.getItem(STORE), null);
    button(p, "Save and apply").click();
    await waitFor(() => p.applies().length === 2, "the next try");
    assert.notEqual(p.applies()[1].body.requestId, "remote-bbbbbbbbbbbbbbbbbbbbbbbb");
  } finally {
    p.close();
  }
});

test("another Workspace's request, or one saved before requests were kept per Workspace, is neither shown nor asked again, and is left as it was (T-195)", async () => {
  const theirs = { requestId: "remote-bbbbbbbbbbbbbbbbbbbbbbbb", draft: { enabled: true, servePort: 9443, login: "other@example.com" } };
  const older = { requestId: "remote-cccccccccccccccccccccccc", draft: { enabled: true, servePort: 9443, login: "other@example.com" } };
  let current = example("environmentNotRecorded");
  const p = mount((url, method, body) => {
    if (method === "GET") return { body: current };
    current = view({ operation: op("succeeded", "done", { requestId: body.requestId, kind: "disable" }) });
    return { status: 202, body: { operation: current.operation } };
  }, { storage: { "yuzuno.remoteAccess.pending:ws-b": theirs, "yuzuno.remoteAccess.pending": older } });
  try {
    await waitFor(() => p.states().length === 4, "the states");
    assert.notEqual(p.doc.querySelector('input[aria-label="Serve port"]').value, "9443", "their draft is not this Workspace's");
    assert.notEqual(p.doc.querySelector('input[aria-label="Allowed login"]').value, "other@example.com");
    button(p, "Turn off").click();
    await waitFor(() => p.applies().length === 1, "turned off");
    const sent = p.applies()[0].body.requestId;
    assert.ok(![theirs.requestId, older.requestId].includes(sent), "a new request, never theirs");
    await waitFor(() => /Turned off\./.test(p.text()), "turned off");
    assert.equal(p.window.localStorage.getItem("yuzuno.remoteAccess.pending:ws-b"), JSON.stringify(theirs), "kept for its Workspace");
    assert.equal(p.window.localStorage.getItem("yuzuno.remoteAccess.pending"), JSON.stringify(older), "the older request is left where it is");
  } finally {
    p.close();
  }
});
