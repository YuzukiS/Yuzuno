import "./jsdom-guard.mjs";
// T-185: Settings → Phone & remote access, against a stub Core that answers
// as the interface proposed to Dev 5 (T-185): status, check, apply/disable
// operations. Loading only reads; the four states are shown apart; an
// address is shown only when Core reports one; a failed step is named; a lost
// answer is asked again as the same request.
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
const ENTRY = "https://core.example.ts.net:8444";

/** `handler(url, method, body)` answers `{status, body}`, or throws a
 * TypeError for an answer that never arrives. */
function mount(handler, { url = "http://isolated.test/", storage = {} } = {}) {
  const calls = [];
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
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
  dom.window.renderSettings({ active: true });
  const doc = dom.window.document;
  return {
    window: dom.window, doc, calls, errors, copied,
    writes: () => calls.filter((c) => c.method !== "GET"),
    text: () => doc.querySelector("#settings-remote")?.textContent ?? "",
    states: () => [...doc.querySelectorAll(".remote-access-states li")].map((li) => [li.dataset.tone, li.textContent]),
    alerts: () => [...doc.querySelectorAll('[role="alert"]')].map((a) => a.textContent),
    close: () => dom.window.close(),
  };
}
const button = (p, text) => [...p.doc.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
async function waitFor(f, what) {
  for (let i = 0; i < 160; i++) {
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

/** Core's status, from a supported WSL Core with Tailscale on Windows. */
function status(over = {}) {
  return {
    support: {
      state: "supported",
      coreHost: { kind: "wsl", distro: "Ubuntu", installDir: "/home/user/.local/share/yuzuno/managed-core" },
      tailscaleHost: { kind: "windows", node: "desk.example.ts.net", login: "user@example.com" },
    },
    saved: null,
    listening: { state: "off" },
    serve: { state: "absent", observedAt: "2026-10-24T17:00:00Z" },
    verified: null,
    url: null,
    qr: null,
    operation: null,
    ...over,
  };
}
const op = (phase, steps, extra = {}) => ({
  id: "op-1", requestId: extra.requestId ?? "r", kind: "apply", phase,
  steps: ["check", "save", "listen", "serve", "verify"].map((id, i) => ({ id, state: steps[i] })),
  startedAt: "2026-10-24T17:00:00Z", updatedAt: "2026-10-24T17:00:01Z", ...extra,
});
const on = (over = {}) => status({
  saved: { enabled: true, httpsPort: 8444, remotePort: 4318, origin: ENTRY, login: "user@example.com", savedAt: "2026-10-24T17:00:02Z" },
  listening: { state: "on", port: 4318, origin: ENTRY, login: "user@example.com" },
  serve: { state: "ours", httpsPort: 8444, target: "http://127.0.0.1:4318", observedAt: "2026-10-24T17:00:03Z" },
  verified: { state: "ok", at: "2026-10-24T17:00:04Z", url: `${ENTRY}/` },
  url: `${ENTRY}/`,
  qr: { size: 3, rows: ["101", "010", "111"] },
  ...over,
});

test("opening it only reads, and saved settings alone are not shown as reachable", async () => {
  const p = mount(() => ({
    body: status({
      saved: { enabled: true, httpsPort: 8444, remotePort: 4318, origin: ENTRY, login: "user@example.com", savedAt: "x" },
    }),
  }));
  try {
    await waitFor(() => p.states().length === 4, "the four states");
    assert.deepEqual(p.states().map(([tone]) => tone), ["on", "off", "off", "unknown"]);
    assert.match(p.states()[0][1], /Saved settings.*On · https:\/\/core\.example\.ts\.net:8444/);
    assert.match(p.states()[1][1], /Not listening/);
    assert.match(p.states()[2][1], /No Yuzuno entry/);
    assert.match(p.states()[3][1], /Not checked yet/);
    assert.equal(p.doc.querySelector(".settings-current").textContent, "Incomplete");
    assert.equal(!!p.doc.querySelector(".remote-access-result"), false, "no address without Core's verified one");
    assert.equal(!!p.doc.querySelector(".remote-access-qr"), false);
    assert.match(p.text(), /WSL · Ubuntu/);
    assert.match(p.text(), /Windows · desk\.example\.ts\.net/);
    await tick();
    assert.deepEqual(p.writes(), [], "loading writes nothing");
  } finally {
    p.close();
  }
});

test("a Core it cannot set up says why and offers nothing to change", async () => {
  const p = mount(() => ({
    body: status({
      support: { state: "unsupported", reason: "this Core is not a managed WSL Core", coreHost: { kind: "other", label: "Linux · ubuntu-box" }, tailscaleHost: null },
    }),
  }));
  try {
    await waitFor(() => p.doc.querySelector(".remote-access-note"), "the reason");
    assert.match(p.doc.querySelector(".remote-access-note").textContent, /this Core is not a managed WSL Core/);
    assert.match(p.text(), /Linux · ubuntu-box/);
    assert.match(p.text(), /Tailscale runs onNot found/);
    for (const label of ["Check", "Save and apply", "Turn off"]) assert.equal(!!button(p, label), false, label);
    assert.deepEqual(p.writes(), []);
  } finally {
    p.close();
  }
});

test("check, then save and apply: problems keep the input, progress is shown by step, and the address comes with its code", async () => {
  let current = status();
  let polls = 0;
  const p = mount((url, method, body) => {
    if (method === "GET") {
      if (current.operation?.phase === "running" && ++polls >= 2) {
        current = on({ operation: op("complete", ["done", "done", "done", "done", "done"], { requestId: current.operation.requestId }) });
      }
      return { body: current };
    }
    if (url.endsWith("/check")) {
      return body.draft.httpsPort === 443
        ? { body: { ok: false, problems: [{ field: "httpsPort", step: "Tailscale Serve", message: "Port 443 is used by another Serve entry." }], preview: null } }
        : { body: { ok: true, problems: [], preview: { url: `${ENTRY}/`, origin: ENTRY, httpsPort: 8444, remotePort: 4318, login: "user@example.com" } } };
    }
    if (url.endsWith("/apply")) {
      current = status({ operation: op("running", ["done", "done", "running", "pending", "pending"], { requestId: body.requestId }) });
      return { status: 202, body: current.operation };
    }
    return { status: 404, body: { error: "no" } };
  });
  try {
    await waitFor(() => button(p, "Check"), "the form");
    assert.equal(button(p, "Save and apply").disabled, true, "applied only after a check");
    type(p, "Serve port", "443");
    button(p, "Check").click();
    await waitFor(() => /used by another Serve entry/.test(p.text()), "the problem");
    assert.equal(p.doc.querySelector('input[aria-label="Serve port"]').value, "443", "the input stays");
    assert.equal(button(p, "Save and apply").disabled, true);
    type(p, "Serve port", "8444");
    assert.equal(!!p.doc.querySelector(".remote-access-check"), false, "an edit drops the old check");
    button(p, "Check").click();
    await waitFor(() => /Ready: your phone would open/.test(p.text()), "the preview");
    assert.deepEqual(p.calls.filter((c) => c.url.endsWith("/check")).at(-1).body, { draft: { enabled: true, httpsPort: 8444 } });
    button(p, "Save and apply").click();
    await waitFor(() => p.doc.querySelector(".remote-access-steps"), "the steps");
    const apply = p.calls.find((c) => c.url.endsWith("/apply"));
    assert.match(apply.body.requestId, /^remote-[0-9a-f]{24}$/);
    assert.deepEqual(apply.body.draft, { enabled: true, httpsPort: 8444 });
    assert.equal(p.doc.querySelector('.remote-access-steps [data-state="running"]').textContent, "Core listens on the phone's port");
    assert.equal(button(p, "Check").disabled, true, "nothing else while it runs");
    await waitFor(() => p.doc.querySelector(".remote-access-result"), "the address");
    assert.equal(p.doc.querySelector(".remote-access-result a").getAttribute("href"), `${ENTRY}/`);
    assert.equal(p.doc.querySelector(".remote-access-qr path").getAttribute("d"), "M4,4h1v1h-1zM6,4h1v1h-1zM5,5h1v1h-1zM4,6h1v1h-1zM5,6h1v1h-1zM6,6h1v1h-1z");
    assert.equal(p.doc.querySelector(".settings-current").textContent, "On");
    button(p, "Copy").click();
    await waitFor(() => button(p, "Copied"), "copied");
    assert.deepEqual(p.copied, [`${ENTRY}/`]);
    assert.equal(p.window.localStorage.getItem("yuzuno.remoteAccess.pending"), null, "the request ends with its operation");
    assert.equal(p.writes().filter((c) => c.url.endsWith("/apply")).length, 1);
  } finally {
    p.close();
  }
});

test("a failed step is named, nothing is shown as reachable, and trying again is a new request", async () => {
  let current = status();
  const p = mount((url, method, body) => {
    if (method === "GET") return { body: current };
    if (url.endsWith("/check")) return { body: { ok: true, problems: [], preview: { url: `${ENTRY}/`, origin: ENTRY, httpsPort: 8444, remotePort: 4318, login: "user@example.com" } } };
    current = status({
      listening: { state: "on", port: 4318, origin: ENTRY },
      operation: op("failed", ["done", "done", "done", "failed", "skipped"], { requestId: body.requestId, error: { step: "serve", message: "tailscale.exe serve exited with 1" } }),
    });
    return { status: 202, body: current.operation };
  });
  try {
    await waitFor(() => button(p, "Check"), "the form");
    button(p, "Check").click();
    await waitFor(() => !button(p, "Save and apply").disabled, "checked");
    button(p, "Save and apply").click();
    await waitFor(() => p.alerts().some((a) => /stopped at/.test(a)), "the failure");
    assert.ok(p.alerts().some((a) => /Applying stopped at “Tailscale Serve points to it”: tailscale\.exe serve exited with 1\./.test(a)), p.alerts().join("|"));
    assert.equal(!!p.doc.querySelector(".remote-access-result"), false);
    assert.equal(p.doc.querySelector('.remote-access-steps [data-state="failed"]').textContent, "Tailscale Serve points to it");
    const first = p.calls.find((c) => c.url.endsWith("/apply")).body.requestId;
    button(p, "Save and apply").click();
    await waitFor(() => p.calls.filter((c) => c.url.endsWith("/apply")).length === 2, "the second try");
    assert.notEqual(p.calls.filter((c) => c.url.endsWith("/apply"))[1].body.requestId, first);
  } finally {
    p.close();
  }
});

test("a lost answer is shown as unknown, and asking again is the same request", async () => {
  let lose = true;
  let current = status();
  const p = mount((url, method, body) => {
    if (method === "GET") return { body: current };
    if (url.endsWith("/check")) return { body: { ok: true, problems: [], preview: { url: `${ENTRY}/`, origin: ENTRY, httpsPort: 8444, remotePort: 4318, login: "user@example.com" } } };
    if (lose) {
      lose = false;
      throw new TypeError("Failed to fetch");
    }
    current = status({ operation: op("uncertain", ["done", "done", "done", "running", "pending"], { requestId: body.requestId }) });
    return { status: 202, body: current.operation };
  });
  try {
    await waitFor(() => button(p, "Check"), "the form");
    button(p, "Check").click();
    await waitFor(() => !button(p, "Save and apply").disabled, "checked");
    button(p, "Save and apply").click();
    await waitFor(() => p.alerts().some((a) => /answer did not arrive/.test(a)), "the lost answer");
    const kept = JSON.parse(p.window.localStorage.getItem("yuzuno.remoteAccess.pending"));
    button(p, "Save and apply").click();
    await waitFor(() => p.calls.filter((c) => c.url.endsWith("/apply")).length === 2, "asked again");
    const [one, two] = p.calls.filter((c) => c.url.endsWith("/apply")).map((c) => c.body.requestId);
    assert.equal(one, two, "the same request");
    assert.equal(kept.requestId, one);
    await waitFor(() => p.alerts().some((a) => /did not confirm how this change ended/.test(a)), "uncertain");
    const gets = p.calls.filter((c) => c.method === "GET").length;
    button(p, "Check again").click();
    await waitFor(() => p.calls.filter((c) => c.method === "GET").length === gets + 1, "read again");
    assert.equal(p.calls.filter((c) => c.url.endsWith("/apply")).length, 2, "Check again only reads");
  } finally {
    p.close();
  }
});

test("another change already running is shown, not started twice", async () => {
  let current = status();
  const p = mount((url, method) => {
    if (method === "GET") return { body: current };
    if (url.endsWith("/check")) return { body: { ok: true, problems: [], preview: { url: `${ENTRY}/`, origin: ENTRY, httpsPort: 8444, remotePort: 4318, login: "user@example.com" } } };
    current = status({ operation: op("running", ["done", "running", "pending", "pending", "pending"], { requestId: "someone-else" }) });
    return { status: 409, body: { error: "Another phone access change is running." } };
  });
  try {
    await waitFor(() => button(p, "Check"), "the form");
    button(p, "Check").click();
    await waitFor(() => !button(p, "Save and apply").disabled, "checked");
    button(p, "Save and apply").click();
    await waitFor(() => p.alerts().some((a) => /already running/.test(a)), "the conflict");
    await waitFor(() => p.doc.querySelector('.remote-access-steps [data-state="running"]'), "its progress");
    assert.equal(button(p, "Save and apply").disabled, true);
  } finally {
    p.close();
  }
});

test("from the phone entry itself, a change that would cut this page off asks first", async () => {
  let current = on();
  const p = mount((url, method, body) => {
    if (method === "GET") return { body: current };
    current = status({ operation: { ...op("complete", ["done", "done", "done", "done", "done"], { requestId: body.requestId }), kind: "disable" } });
    return { status: 202, body: current.operation };
  }, { url: `${ENTRY}/` });
  try {
    await waitFor(() => button(p, "Turn off"), "Turn off");
    button(p, "Turn off").click();
    await waitFor(() => p.alerts().some((a) => /open through the phone entry/.test(a)), "the warning");
    assert.deepEqual(p.writes(), [], "nothing sent yet");
    button(p, "Turn off anyway").click();
    await waitFor(() => p.writes().length === 1, "sent");
    assert.match(p.writes()[0].url, /\/api\/remote-access\/disable$/);
    assert.match(p.writes()[0].body.requestId, /^remote-/);
  } finally {
    p.close();
  }
});

test("a Serve entry that is not Yuzuno's is said so, with a warning, and the saved draft survives a reload", async () => {
  const pending = { requestId: "remote-aaaaaaaaaaaaaaaaaaaaaaaa", kind: "apply", draft: { enabled: true, httpsPort: 9443, login: "other@example.com" } };
  const p = mount(() => ({
    body: status({ serve: { state: "foreign", httpsPort: 8444, detail: "proxies http://127.0.0.1:3000", observedAt: "x" } }),
  }), { storage: { "yuzuno.remoteAccess.pending": pending } });
  try {
    await waitFor(() => p.states().length === 4, "the states");
    assert.deepEqual(p.states()[2], ["warn", "Tailscale ServePort 8444 is used by another Serve entry; Yuzuno leaves it as it is (proxies http://127.0.0.1:3000)"]);
    assert.equal(p.doc.querySelector('input[aria-label="Serve port"]').value, "9443");
    assert.equal(p.doc.querySelector('input[aria-label="Allowed login"]').value, "other@example.com");
    assert.deepEqual(p.writes(), []);
  } finally {
    p.close();
  }
});
