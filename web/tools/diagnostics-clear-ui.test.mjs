// T-193 slice 4: Settings → Diagnostics clears the errors recorded in this
// browser for this site, and only them, when asked. The record's other fields
// (Core's and the desktop app's last reads) and every other key stay; a refused
// or unreadable store clears nothing and says so; errors after that are
// recorded as before. Synthetic records only.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(root, ".diagnostics-clear-test-"));
let bundle;
try {
  const entry = path.join(temporary, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {DiagnosticsCopy} from ${JSON.stringify(path.join(root, "src/RecoveryPage.tsx"))};
import {installErrorCapture} from ${JSON.stringify(path.join(root, "src/diagnostics.ts"))};
installErrorCapture();
const root = createRoot(document.getElementById('root'));
window.renderDiagnostics = () => root.render(<DiagnosticsCopy/>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { write: false, lib: { entry, name: "DiagnosticsClearTest", formats: ["iife"] } } });
  bundle = (Array.isArray(built) ? built[0] : built).output.find((item) => item.type === "chunk").code;
} finally { await rm(temporary, { recursive: true, force: true }); }

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(check, what) {
  for (let n = 0; n < 300; n++) { const result = check(); if (result) return result; await tick(); }
  assert.fail(`${what} did not appear`);
}
const KEY = "yuzuno.diagnostics.v1";
const entry = (last, name) => ({ kind: "error", name, codes: [], summary: "other message, not kept", where: [], first: last, last, count: 1 });
// As these rules store a record, so opening it writes nothing.
const record = {
  errors: [entry("2026-10-20T10:00:00.000Z", "TypeError"), entry("2026-10-20T09:00:00.000Z", "RangeError")],
  core: { at: "2026-10-20T08:00:00.000Z", version: "2026.10.18-core.11", releaseId: "core-20261018-6f29d20", apiReady: true, storageReady: true },
  desktop: { at: "2026-10-20T08:00:00.000Z", version: "0.2.0" },
};
const others = {
  "yuzuno.composer.v1:a1": JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text: "a synthetic draft" }] }),
  "yuzuno.appearance.v1": JSON.stringify({ theme: "dark" }),
};
const health = { product: "yuzuno", version: "2026.10.18-core.12", releaseId: "core-20261024-0000000", apiReady: true, storageReady: true };

function mount({ stored = JSON.stringify(record), refuse = false } = {}) {
  const vc = new VirtualConsole();
  const errors = [], calls = [];
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://127.0.0.1:4317/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, doc = w.document;
  for (const [key, value] of Object.entries(others)) w.localStorage.setItem(key, value);
  if (stored !== null) w.localStorage.setItem(KEY, stored);
  const proto = w.Storage.prototype, set = proto.setItem;
  const writes = [];
  const storage = { refuseWrites: false, write: (key, value) => set.call(w.localStorage, key, value) };
  proto.setItem = function (key, value) {
    if (storage.refuseWrites) throw new w.DOMException("The quota has been exceeded.", "QuotaExceededError");
    writes.push(key);
    return set.call(this, key, value);
  };
  if (refuse) Object.defineProperty(w, "localStorage", { configurable: true, get() { throw new w.DOMException("The operation is insecure.", "SecurityError"); } });
  w.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    const ok = String(url).endsWith("/api/health");
    const text = JSON.stringify(ok ? health : { error: "Not found" });
    return { ok, status: ok ? 200 : 404, json: async () => JSON.parse(text), text: async () => text };
  };
  w.eval(bundle);
  w.renderDiagnostics();
  const section = () => doc.querySelector("#settings-diagnostics");
  const button = (label) => [...(section()?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim().startsWith(label));
  const shown = () => doc.querySelector('textarea[aria-label="Diagnostics"]')?.value;
  const all = () => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => [w.localStorage.key(i), w.localStorage.getItem(w.localStorage.key(i))]));
  const raise = (message) => w.dispatchEvent(new w.ErrorEvent("error", { error: new w.TypeError(message), message }));
  return { w, doc, errors, calls, writes, storage, section, button, shown, all, raise, close: () => w.close() };
}

test("Clear removes only the recorded errors: the last reads and every other key stay, nothing is sent, and errors after it are recorded again", async (t) => {
  const p = mount(); t.after(p.close);
  await until(() => p.section(), "the diagnostics");
  assert.match(p.section().textContent, /2 recorded errors are kept in this browser for this site\. Clearing removes only these error records and can't be undone\. Core's and the desktop app's last-read versions stay, and so do drafts, settings, conversations and Core's logs\./);
  p.button("Preview diagnostics").click();
  await until(() => p.shown(), "the preview");
  assert.match(p.shown(), /^Recent errors on this device: 2 /m);
  const before = p.all();
  const sent = p.calls.length, wrote = p.writes.length;
  p.button("Clear recorded errors").click();
  await until(() => /Cleared 2 recorded errors from this browser for this site\./.test(p.section().textContent), "the clear is said");
  const after = p.all();
  assert.equal(after[KEY], JSON.stringify({ ...JSON.parse(before[KEY]), errors: [] }), "only the errors are gone from the record");
  assert.deepEqual(JSON.parse(after[KEY]).desktop, record.desktop, "the desktop app's last read stays");
  assert.ok(JSON.parse(after[KEY]).core.version, "Core's last read stays");
  for (const key of Object.keys(others)) assert.equal(after[key], before[key], `${key} is kept as it was`);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "no key is added or removed");
  assert.deepEqual(p.writes.slice(wrote), [KEY], "only the error record is written");
  assert.deepEqual(p.calls.slice(sent), [], "clearing sends nothing");
  assert.match(p.section().textContent, /This text was gathered before the recorded errors were cleared\. Preview again for the record as it is now\./);
  assert.match(p.shown(), /^Recent errors on this device: 2 /m, "the text shown is the one gathered before, and says so");
  assert.match(p.section().textContent, /No errors are recorded in this browser for this site\./);
  assert.equal(p.button("Clear recorded errors").disabled, true, "nothing is left to clear");
  p.button("Preview again").click();
  await until(() => /^Recent errors on this device: none$/m.test(p.shown() || ""), "the record as it is now");
  assert.doesNotMatch(p.section().textContent, /gathered before the recorded errors were cleared/);
  // An error after the clear is recorded as before, with the last reads.
  p.raise("x is not a function");
  await until(() => JSON.parse(p.all()[KEY]).errors.length === 1, "the new error is recorded");
  const kept = JSON.parse(p.all()[KEY]);
  assert.equal(kept.errors[0].summary, "called something that is not a function");
  assert.deepEqual(kept.desktop, record.desktop);
  assert.deepEqual(p.errors, []);
});

test("a refused change, an unreadable record or no storage clears nothing and says why; the record stays as it was", async (t) => {
  // The browser refuses the change: the errors stay, stored and in this window.
  const p = mount(); t.after(p.close);
  await until(() => p.button("Clear recorded errors"), "the clear action");
  p.storage.refuseWrites = true;
  p.button("Clear recorded errors").click();
  await until(() => p.section().querySelector('[role="alert"]'), "the refusal is said");
  assert.equal(p.section().querySelector('[role="alert"]').textContent,
    "Nothing was cleared: this browser refused to save the change (QuotaExceededError). The recorded errors are kept as they were.");
  assert.doesNotMatch(p.section().textContent, /Cleared \d/);
  assert.equal(p.all()[KEY], JSON.stringify(record), "the stored record is as it was");
  p.button("Preview diagnostics").click();
  await until(() => p.shown(), "the preview");
  assert.match(p.shown(), /^Recent errors on this device: 2 /m, "this window still has them too");
  assert.match(p.section().textContent, /2 recorded errors are kept in this browser for this site\./);

  // A record these rules can't read is not cleared over, before or at the click.
  const q = mount({ stored: "{damaged" }); t.after(q.close);
  await until(() => q.button("Clear recorded errors"), "the clear action");
  assert.match(q.section().textContent, /The recorded errors can't be cleared here: the record saved here is not valid JSON\./);
  assert.equal(q.button("Clear recorded errors").disabled, true);
  assert.equal(q.all()[KEY], "{damaged");
  const r = mount(); t.after(r.close);
  await until(() => r.button("Clear recorded errors"), "the clear action");
  r.storage.write(KEY, JSON.stringify({ errors: "not a list", core: record.core }));
  r.button("Clear recorded errors").click();
  await until(() => r.section().querySelector('[role="alert"]'), "the unreadable record is said");
  assert.match(r.section().querySelector('[role="alert"]').textContent, /^Nothing was cleared: the record saved here is not an error record\./);
  assert.equal(r.all()[KEY], JSON.stringify({ errors: "not a list", core: record.core }), "it is left as it is");

  // No storage at all: nothing to clear here, and it says so.
  const s = mount({ refuse: true }); t.after(s.close);
  await until(() => s.button("Clear recorded errors"), "the clear action");
  assert.match(s.section().textContent, /The recorded errors can't be cleared here: this browser gives Yuzuno no storage here\./);
  assert.equal(s.button("Clear recorded errors").disabled, true);
  for (const x of [p, q, r, s]) assert.deepEqual(x.errors, []);
});

test("when another window of this site clears the record, this one reads it again and doesn't store the cleared errors back", async (t) => {
  const p = mount(); t.after(p.close);
  await until(() => /2 recorded errors/.test(p.section()?.textContent || ""), "the record is read");
  p.storage.write(KEY, JSON.stringify({ ...record, errors: [] }));
  p.w.dispatchEvent(new p.w.StorageEvent("storage", { key: KEY }));
  p.raise("y is not a function");
  await until(() => JSON.parse(p.all()[KEY]).errors.length > 0, "the new error is recorded");
  assert.equal(JSON.parse(p.all()[KEY]).errors.length, 1, "only the new error is stored");
  assert.deepEqual(JSON.parse(p.all()[KEY]).core, record.core, "with the last reads the other window kept");
});
