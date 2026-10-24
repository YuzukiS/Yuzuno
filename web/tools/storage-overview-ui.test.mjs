// T-193: Settings → Data & storage, against a stub Core. Opening it only
// reads; folder sizes come only from Measure; nothing unknown is shown as 0;
// the copied overview holds sizes and counts, never a path, name, ID or draft.
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
const temporary = await mkdtemp(path.join(root, ".storage-test-"));
let bundle;
try {
  const entry = path.join(temporary, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {StorageOverview} from ${JSON.stringify(path.join(root, "src/StorageOverview.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderStorage = props => root.render(<StorageOverview {...props}/>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { write: false, lib: { entry, name: "StorageTest", formats: ["iife"] } } });
  bundle = (Array.isArray(built) ? built[0] : built).output.find((item) => item.type === "chunk").code;
} finally { await rm(temporary, { recursive: true, force: true }); }

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(check, what = "Expected storage state") {
  for (let n = 0; n < 300; n++) { const result = check(); if (result) return result; await tick(); }
  assert.fail(`${what} did not appear`);
}

const DATA_DIR = "/home/someone/.local/share/yuzuno/workspace";
const overview = (measurement = null) => ({
  format: 1,
  readAt: "2026-10-24T22:00:00Z",
  dataDir: DATA_DIR,
  entries: [
    { name: "claude-runtime", what: "claudeRuntime", kind: "folder", backup: "excluded", backupReason: "A cache of the Claude runtime, which Core rebuilds" },
    { name: "input-images", what: "inputImages", kind: "folder", backup: "copied", backupReason: null },
    { name: "jobs", what: "jobs", kind: "folder", backup: "copied", backupReason: null },
    { name: "my-private-notes", what: "unknown", kind: "folder", backup: "notCopied", backupReason: null },
    { name: "workspace.sqlite", what: "database", kind: "file", bytes: 3145728, diskBytes: 3149824, modifiedAt: null, backup: "copied", backupReason: null },
  ],
  unreadable: null,
  database: { pageSize: 4096, pages: 768, freePages: 10 },
  jobs: { total: 12, unfinished: 1 },
  native: [
    { harness: "claude", machine: "lab box", agents: 1, closed: 0 },
    { harness: "codex", machine: null, agents: 3, closed: 1 },
  ],
  notInBackup: ["Native session histories kept by Codex, Claude Code and OpenCode outside the Workspace"],
  measurement,
  bounds: { entries: 1000000, seconds: 30 },
});
const running = { id: "m1", state: "running", startedAt: "2026-10-24T22:01:00Z", endedAt: null, current: "input-images", entries: 4096, folders: [] };
const limited = {
  id: "m1", state: "limited", startedAt: "2026-10-24T22:01:00Z", endedAt: "2026-10-24T22:01:30Z", current: null, entries: 1000000,
  folders: [
    { name: "input-images", measured: true, files: 3, bytes: 1000, diskBytes: 12288, complete: false, links: 2, otherDevice: 0, unreadable: 1, special: 0 },
    { name: "jobs", measured: false },
  ],
};

function mount(seed = {}) {
  const vc = new VirtualConsole();
  const errors = [], calls = [];
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, doc = w.document;
  for (const [key, value] of Object.entries(seed)) w.localStorage.setItem(key, value);
  const core = { measurement: null };
  w.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url: String(url), method });
    let value;
    if (String(url).endsWith("/api/storage/measure")) value = { measurement: (core.measurement = running) };
    else if (String(url).endsWith("/api/storage/measure/stop")) value = { measurement: core.measurement };
    else if (String(url).endsWith("/api/storage")) value = overview(core.measurement);
    else value = {};
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  const text = () => doc.querySelector("#settings-storage")?.textContent ?? "";
  const row = (name) => doc.querySelector(`[data-entry="${name}"]`)?.textContent ?? "";
  const button = (label) => [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  const reads = () => calls.filter((c) => c.url.endsWith("/api/storage") && c.method === "GET").length;
  const posts = () => calls.filter((c) => c.method !== "GET");
  return { w, doc, calls, errors, core, text, row, button, reads, posts, close: () => w.close() };
}

const managed = { managed: true, storage: { releaseBytes: 314572800, backupBytes: 20971520, retainedReleases: 3, keepReleases: 3 } };
const seed = {
  "yuzuno.composer.v1:agent-a": JSON.stringify({ version: 1, nextNumber: 2, parts: [{ kind: "text", text: "secret draft text" }, { kind: "paste", id: "p1", number: 1, bodyId: "b1" }] }),
  "yuzuno.paste.v1:agent-a:b1": "secret pasted body",
  "yuzuno.composer.v1:agent-b": JSON.stringify({ version: 1, nextNumber: 1, parts: [] }),
  "yuzuno.composer.v1:agent-c": "{damaged",
  "yuzuno.outbox": JSON.stringify({ "agent-a:composer": { text: "secret outbox text" } }),
  "yuzuno.appearance": JSON.stringify({ theme: "dark" }),
  "yuzuno.future-feature.v9": "1",
  "another-app": "x",
};

test("opening it only reads: this device by group, Core's overview once, and no folder is measured", async (t) => {
  const p = mount(seed); t.after(p.close);
  p.w.renderStorage({ active: true, updates: managed });
  await until(() => p.text().includes("Workspace database"), "Core's overview");
  await until(() => p.text().includes("does not report"), "the browser's own figures");
  assert.equal(p.reads(), 1, "one read of Core's overview");
  assert.deepEqual(p.posts(), [], "opening it starts no measurement and changes nothing");
  const groups = Object.fromEntries([...p.doc.querySelectorAll("[data-group]")].map((li) => [li.dataset.group, li.textContent]));
  assert.deepEqual(Object.keys(groups), ["unsent", "drafts", "preferences", "other", "foreign"]);
  assert.match(groups.drafts, /4 entries/);
  assert.match(groups.unsent, /1 entry/);
  assert.match(p.text(), /1 Agent has a saved draft; 1 saved draft could not be read and is left as it is\. 1 message is waiting/);
  for (const secret of ["secret draft text", "secret pasted body", "secret outbox text", "agent-a"]) assert.ok(!p.text().includes(secret), `${secret} is not shown`);
  // The browser here reports nothing: said so, never a size of 0.
  assert.match(p.text(), /This browser does not report how much it keeps for this site\./);
  assert.doesNotMatch(p.text(), /\b0 B\b/, "nothing unknown is shown as 0");
  assert.match(p.row("input-images"), /^Images sent to Agentsnot measured.*In a Workspace backup/);
  assert.match(p.row("my-private-notes"), /not measured: not made by Core/);
  assert.match(p.row("claude-runtime"), /Not in a backup: A cache of the Claude runtime, which Core rebuilds/);
  assert.match(p.row("workspace.sqlite"), /3\.0 MiB · 3\.0 MiB on disk/);
  assert.match(p.text(), /12 Job records, 1 not finished/);
  assert.match(p.text(), /Claude Code · lab box.*not measured.*Kept by Claude Code in its own folder on that computer/);
  assert.match(p.text(), /Codex · the Core host.*3 Agents \(1 closed\)/);
  assert.match(p.text(), /Releases: 300 MiB \(3 kept, up to 3\)\. Database copies made before updates: 20 MiB/);
  assert.ok(p.button("Measure folders"), "folders are measured only when asked");
  assert.deepEqual(p.errors, []);
});

test("Measure asks Core once and follows it; Stop asks it to stop; a cut-short result says what it lacks", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderStorage({ active: true, updates: managed });
  await until(() => p.button("Measure folders"));
  p.button("Measure folders").click();
  await until(() => p.button("Stop"), "the running measurement");
  assert.deepEqual(p.posts().map((c) => c.url.replace(/^.*\/api/, "")), ["/storage/measure"]);
  assert.match(p.text(), /Measuring Images sent to Agents… 4096 entries read/);
  p.button("Stop").click();
  await until(() => p.posts().length === 2, "the stop request");
  assert.equal(p.posts()[1].url.replace(/^.*\/api/, ""), "/storage/measure/stop");
  // Core reports how it ended: cut short by its bounds.
  p.core.measurement = limited;
  await until(() => p.button("Measure again"), "the ended measurement");
  assert.match(p.row("input-images"), /at least 1000 B · 12 KiB on disk/);
  assert.match(p.row("input-images"), /3 files · 2 links not followed, 1 could not be read/);
  assert.match(p.row("jobs"), /not reached by the measurement/);
  assert.match(p.text(), /cut short at 1,000,000 entries or 30 s: sizes marked "at least" are incomplete/);
  assert.equal(p.posts().length, 2, "following it only reads");
  assert.deepEqual(p.errors, []);
});

test("hidden, it reads nothing; shown again, it reads Core again", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderStorage({ active: false, updates: null });
  await tick(); await tick();
  assert.equal(p.calls.length, 0, "a hidden editor reads nothing");
  p.w.renderStorage({ active: true, updates: null });
  await until(() => p.reads() === 1);
  assert.match(p.text(), /Not read yet: Settings reads it with the update status\./);
  p.w.renderStorage({ active: false, updates: null });
  await tick(); await tick();
  assert.equal(p.reads(), 1);
  p.w.renderStorage({ active: true, updates: null });
  await until(() => p.reads() === 2, "a second read when shown again");
  assert.deepEqual(p.posts(), []);
});

test("the copied overview holds sizes and counts, never a path, name, ID or draft text", async (t) => {
  const p = mount(seed); t.after(p.close);
  p.w.renderStorage({ active: true, updates: { managed: false, storage: { releaseBytes: 0, backupBytes: 0, retainedReleases: 0, keepReleases: 3 } } });
  await until(() => p.text().includes("Workspace database"));
  assert.match(p.text(), /This Core is not a managed install, so Yuzuno keeps no releases or update copies for it\./);
  p.button("Copy this overview").click();
  const area = await until(() => p.doc.querySelector('textarea[aria-label="Data & storage overview"]'), "the copied text");
  const copied = area.value;
  assert.match(copied, /Images sent to Agents: not measured; backup: copied/);
  assert.match(copied, /Drafts: 4 keys, about/);
  assert.match(copied, /Update releases: not a managed install; none kept/);
  for (const secret of [DATA_DIR, "/home/", "lab box", "my-private-notes", "agent-a", "secret draft text", "secret outbox text", "secret pasted body"]) {
    assert.ok(!copied.includes(secret), `the copy does not hold ${secret}`);
  }
  assert.match(p.text(), /This window can't use the clipboard\. Select the text below and copy it\./);
  assert.deepEqual(p.posts(), [], "copying sends nothing");
});
