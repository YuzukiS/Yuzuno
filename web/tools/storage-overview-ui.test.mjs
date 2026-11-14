// T-193: Settings → Data & storage, against a stub Core. Opening it only
// reads, once while shown; nothing unknown is shown as 0; no draft or
// message text is shown.
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
const overview = () => ({
  format: 1,
  readAt: "2026-10-24T22:00:00Z",
  dataDir: DATA_DIR,
  entries: [
    { name: "claude-runtime", what: "claudeRuntime", kind: "folder", backup: "excluded", backupReason: "A cache of the Claude runtime, which Core rebuilds" },
    { name: "home-images", what: "homeImages", kind: "folder", backup: "copied", backupReason: null },
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
});
// Core's build output cleanup (YN-65): off, nothing done yet, unless a test says.
const cleanupOff = () => ({ policy: { enabled: false, keepDays: 1, since: null, version: 0, changedAt: null }, maxKeepDays: 30, recent: [], waiting: 0 });
function mount(seed = {}, { tasks = { tasks: [], hasMore: false }, runtimes = null, cleanup = null } = {}) {
  const vc = new VirtualConsole();
  const errors = [], calls = [];
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, doc = w.document;
  for (const [key, value] of Object.entries(seed)) w.localStorage.setItem(key, value);
  w.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : undefined });
    // Core's task list: one answer, or one per request (by its body).
    const listed = String(url).endsWith("/api/collaboration/task_list")
      ? (typeof tasks === "function" ? tasks(JSON.parse(init.body)) : tasks) : null;
    if (listed?.httpStatus) {
      const body = { error: listed.error };
      return { ok: false, status: listed.httpStatus, json: async () => body, text: async () => JSON.stringify(body) };
    }
    // The prepared Claude runtimes (T-193): each read and removal answered in turn.
    const runtime = String(url).endsWith("/api/claude-sdk/copies") ? runtimes?.copies(calls.filter((c) => c.url.endsWith("/api/claude-sdk/copies")).length)
      : String(url).endsWith("/api/claude-sdk/copies/remove") ? runtimes?.remove(JSON.parse(init.body)) : null;
    // The build output cleanup: each read, change and backlog count answered in turn.
    const cleaning = /\/api\/build-cleanup(\/backlog)?$/.test(String(url))
      ? (cleanup ?? { read: cleanupOff })[String(url).endsWith("/backlog") ? "backlog" : method === "PUT" ? "change" : "read"]?.(init.body ? JSON.parse(init.body) : undefined)
      : null;
    if (cleaning?.httpStatus) {
      const body = { error: cleaning.error };
      return { ok: false, status: cleaning.httpStatus, json: async () => body, text: async () => JSON.stringify(body) };
    }
    const value = String(url).endsWith("/api/storage") ? overview() : listed ?? runtime ?? cleaning ?? {};
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  w.eval(bundle);
  const text = () => doc.querySelector("#settings-storage")?.textContent ?? "";
  const row = (name) => doc.querySelector(`[data-entry="${name}"]`)?.textContent ?? "";
  const button = (label) => [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  // Each size and note on its own: a row's parts run together in its textContent.
  const zeros = () => [...doc.querySelectorAll("#settings-storage .storage-size, #settings-storage .storage-note")]
    .map((el) => el.textContent).filter((text) => /(^|[^\d.,])0 B\b/.test(text));
  const reads = () => calls.filter((c) => c.url.endsWith("/api/storage") && c.method === "GET").length;
  const posts = () => calls.filter((c) => c.method !== "GET");
  return { w, doc, calls, errors, text, row, button, zeros, reads, posts, close: () => w.close() };
}

const managed = { managed: true, storage: { releaseBytes: 314572800, backupBytes: 20971520, retainedReleases: 3, keepReleases: 3 } };
const seed = {
  [`yuzuno.composer.v1:${JSON.stringify(["ws-1", "agent-a"])}`]: JSON.stringify({ version: 1, nextNumber: 2, parts: [{ kind: "text", text: "secret draft text" }, { kind: "paste", id: "p1", number: 1, bodyId: "b1" }] }),
  [`yuzuno.paste.v1:${JSON.stringify(["ws-1", "agent-a"])}:b1`]: "secret pasted body",
  [`yuzuno.composer.v1:${JSON.stringify(["ws-1", "agent-b"])}`]: JSON.stringify({ version: 1, nextNumber: 1, parts: [] }),
  [`yuzuno.composer.v1:${JSON.stringify(["ws-1", "agent-c"])}`]: "{damaged",
  // Unsent messages are kept per Workspace (T-195). This view is the
  // device's, so it counts every Workspace's and says so as one number.
  "yuzuno.outbox": JSON.stringify({
    "ws-1": { "agent-a:composer": { clientMessageId: "m1", text: "secret outbox text" } },
    "ws-2": { "agent-a:composer": { clientMessageId: "m2", text: "another Workspace's secret" } },
  }),
  "yuzuno.appearance": JSON.stringify({ theme: "dark" }),
  "yuzuno.future-feature.v9": "1",
  "another-app": "x",
};

test("opening it only reads: this device by group and Core's overview once, with unknown sizes said to be unknown", async (t) => {
  const p = mount(seed); t.after(p.close);
  p.w.renderStorage({ active: true, updates: managed });
  await until(() => p.text().includes("Workspace database"), "Core's overview");
  await until(() => p.text().includes("does not report"), "the browser's own figures");
  assert.equal(p.reads(), 1, "one read of Core's overview");
  assert.deepEqual(p.posts(), [], "opening it changes nothing");
  const groups = Object.fromEntries([...p.doc.querySelectorAll("[data-group]")].map((li) => [li.dataset.group, li.textContent]));
  assert.deepEqual(Object.keys(groups), ["unsent", "drafts", "preferences", "other", "foreign"]);
  assert.match(groups.drafts, /4 entries/);
  assert.match(groups.unsent, /1 entry/);
  assert.match(p.text(), /1 Agent has a saved draft; 1 saved draft could not be read and is left as it is\. 2 messages are waiting/);
  for (const secret of ["secret draft text", "secret pasted body", "secret outbox text", "another Workspace's secret", "agent-a", "ws-1", "ws-2"])
    assert.ok(!p.text().includes(secret), `${secret} is not shown`);
  // The browser here reports nothing: said so, never a size of 0.
  assert.match(p.text(), /This browser does not report how much it keeps for this site\./);
  assert.deepEqual(p.zeros(), [], "nothing unknown is shown as 0");
  assert.match(p.row("input-images"), /^Images sent to Agentssize unknown.*A Workspace backup copies files from here; its manifest lists which/);
  assert.match(p.row("home-images"), /^Images written on Homesize unknown.*A Workspace backup copies files from here; its manifest lists which/);
  assert.match(p.row("workspace.sqlite"), /In a Workspace backup, as a consistent copy/);
  assert.match(p.row("my-private-notes"), /^Not made by this Coresize unknown.*Not in a backup/);
  assert.match(p.row("claude-runtime"), /Not in a backup: A cache of the Claude runtime, which Core rebuilds/);
  assert.match(p.row("workspace.sqlite"), /3\.0 MiB · 3\.0 MiB on disk/);
  assert.match(p.text(), /12 Job records, 1 not finished/);
  assert.match(p.text(), /Claude Code · lab box.*size unknown.*Kept by Claude Code in its own folder on that computer/);
  assert.match(p.text(), /Codex · the Core host.*3 Agents \(1 closed\)/);
  assert.match(p.text(), /Releases: 300 MiB \(3 kept, up to 3\)\. Database copies made before updates: 20 MiB/);
  assert.deepEqual([...p.doc.querySelectorAll("#settings-storage button:not([role=switch])")].map((b) => b.textContent), ["Check prepared runtimes"],
    "the one thing to press is a read, and nothing was read for it yet");
  assert.equal(p.doc.querySelector("#settings-storage [role=switch]").getAttribute("aria-checked"), "false", "the build output cleanup is off, as Core keeps it");
  assert.equal(p.calls.filter((c) => c.url.endsWith("/api/build-cleanup")).length, 1, "read once");
  assert.ok(!p.calls.some((c) => c.url.includes("/claude-sdk")), "prepared runtimes are not read until asked");
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

test("an install that isn't managed says so instead of showing 0", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderStorage({ active: true, updates: { managed: false, storage: { releaseBytes: 0, backupBytes: 0, retainedReleases: 0, keepReleases: 3 } } });
  await until(() => p.text().includes("Workspace database"));
  assert.match(p.text(), /This Core is not a managed install, so Yuzuno keeps no releases or update copies for it\./);
  assert.deepEqual(p.zeros(), [], "no 0 for releases it does not keep, or for any size not known");
});

// T-193: a task chosen by its ID, opened at its own Workspace section; nothing here previews or removes.
test("a task is chosen by its ID and only opened: nothing is previewed, removed, registered or started here", async (t) => {
  // Core lists oldest first, a page at a time: both pages are read, the newest shown first.
  const pages = (body) => body.afterSeq === 7
    ? { tasks: [{ id: "T-8", seq: 8, title: "Build cache", status: "doing" }], hasMore: false, nextAfterSeq: 8 }
    : { tasks: [{ id: "T-7", seq: 7, title: "Build cache", status: "done" }], hasMore: true, nextAfterSeq: 7 };
  const p = mount({}, { tasks: pages }); t.after(p.close);
  const opened = [];
  p.w.renderStorage({ active: true, updates: managed, onOpenTaskWorkspaces: (id) => opened.push(id) });
  const select = await until(() => p.doc.querySelector("#settings-storage .storage-task-open select"), "the task choice");
  assert.deepEqual([...select.options].map((o) => o.textContent), ["Choose a task…", "T-8 · Build cache · doing", "T-7 · Build cache · done"], "each by its ID, done ones too, the newest first");
  const open = p.button("Open its Workspace section");
  assert.equal(open.disabled, true, "nothing chosen, nothing to open");
  const choose = (id) => {
    Object.getOwnPropertyDescriptor(p.w.HTMLSelectElement.prototype, "value").set.call(select, id);
    select.dispatchEvent(new p.w.Event("change", { bubbles: true }));
  };
  // A choice taken back leaves nothing to open, and nothing was opened.
  choose("T-8");
  await until(() => !p.button("Open its Workspace section").disabled, "a choice");
  choose("");
  await until(() => p.button("Open its Workspace section").disabled, "the choice taken back");
  assert.deepEqual(opened, [], "choosing alone opens nothing");
  choose("T-7");
  await until(() => !p.button("Open its Workspace section").disabled, "the choice");
  p.button("Open its Workspace section").click();
  assert.deepEqual(opened, ["T-7"], "the chosen ID, not the name both share");
  assert.match(p.text(), /regenerable Cargo build output, never source files, the folder or its branch/);
  assert.match(p.text(), /Choosing a task here only opens it: nothing is previewed or removed\./);
  assert.match(p.text(), /Archived tasks are not listed\./);
  assert.doesNotMatch(p.text(), /tasks are listed; open a later one/, "every page was read");
  // Only reads: the overview and the task list's pages, the board's own read.
  assert.deepEqual(p.posts().map((c) => [c.url, c.body]), [
    ["/api/collaboration/task_list", { limit: 200 }], ["/api/collaboration/task_list", { limit: 200, afterSeq: 7 }]]);
  // The build output cleanup's own policy is read (YN-65); nothing of a task's folders.
  assert.ok(!p.calls.some((c) => /workspaces|cleanup|jobs/.test(c.url) && !(c.url.endsWith("/api/build-cleanup") && c.method === "GET")),
    "no task folder is read, previewed or removed here");
  assert.deepEqual(p.errors, []);
});

test("a task list that can't be read says why; an empty one says so; without the way to the task board, the section says where; past the pages it reads, it says which are listed", async (t) => {
  const failed = mount({}, { tasks: { httpStatus: 503, error: "Core is restarting" } }); t.after(failed.close);
  failed.w.renderStorage({ active: true, updates: managed, onOpenTaskWorkspaces: () => {} });
  const alert = await until(() => failed.doc.querySelector("#settings-storage .storage-part [role=\"alert\"]"), "the failure");
  assert.match(alert.textContent, /^The tasks could not be read: .*Core is restarting/);
  assert.equal(failed.doc.querySelector(".storage-task-open") === null, true, "nothing to choose");
  const empty = mount(); t.after(empty.close);
  empty.w.renderStorage({ active: true, updates: managed, onOpenTaskWorkspaces: () => {} });
  await until(() => /This Workspace has no tasks\./.test(empty.text()), "no tasks");
  const without = mount(); t.after(without.close);
  without.w.renderStorage({ active: true, updates: managed });
  await until(() => /Open a task's Workspace section from Tasks to remove its build output\./.test(without.text()), "where to go");
  assert.deepEqual(without.posts(), [], "without the way there, no task list is read");
  // More pages than are read: the oldest are listed, and it says so.
  const endless = mount({}, { tasks: (body) => {
    const seq = (body.afterSeq ?? 0) + 1;
    return { tasks: [{ id: `T-${seq}`, seq, title: "Old", status: "done" }], hasMore: true, nextAfterSeq: seq };
  } }); t.after(endless.close);
  endless.w.renderStorage({ active: true, updates: managed, onOpenTaskWorkspaces: () => {} });
  await until(() => /Only the 10 oldest tasks are listed; open a later one from Tasks\./.test(endless.text()), "the pages it stopped at");
  assert.equal(endless.posts().length, 10, "a bounded number of pages");
});

// T-193: prepared Claude runtimes. Read only on Check; only copies no
// installed release needs can be ticked; removal is posted only once
// confirmed, with just the chosen keys; each result is said as it was.
const KEY = (c) => c.repeat(32);
const copy = (c, version, at, bytes, usedBy, problem = null) =>
  ({ key: c ? KEY(c) : null, version, source: null, at, bytes, usedBy, removable: !usedBy && !problem && !!c, problem });
const ready = (copies) => ({ format: 1, readAt: "2026-10-25T20:00:00Z", state: "ready", copies, limited: false });
const listed = [
  copy("a", "0.3.296", "2026-10-20T10:00:00Z", 52428800, "thisCore"),
  copy("b", "0.3.290", "2026-10-01T10:00:00Z", 50331648, "installedRelease"),
  copy("c", "0.3.280", "2026-09-01T10:00:00Z", 49283072, null),
  copy("d", "0.3.270", "2026-08-01T10:00:00Z", null, null),
  copy("e", null, null, null, null, "noReceipt"),
  copy(null, null, null, null, null, "unknownName"),
];

test("prepared runtimes: read on Check, only unneeded ones can be chosen, removed only once confirmed, each result said", async (t) => {
  const removals = [];
  const p = mount({}, { runtimes: {
    copies: (n) => ready(n === 1 ? listed : listed.filter((c) => c.key !== KEY("c"))),
    remove: (body) => { removals.push(body); return { format: 1, state: "done", results: [
      { key: KEY("c"), outcome: "removed", bytes: 49283072 },
      { key: KEY("d"), outcome: "partly", error: "permission denied" }] }; },
  } }); t.after(p.close);
  p.w.renderStorage({ active: true, updates: managed });
  await until(() => p.text().includes("Workspace database"));
  p.button("Check prepared runtimes").click();
  await until(() => p.doc.querySelector('[data-copy]'), "the prepared runtimes");
  const reads = () => p.calls.filter((c) => c.url.endsWith("/api/claude-sdk/copies")).length;
  assert.equal(reads(), 1);
  const row = (c) => p.doc.querySelector(`[data-copy="${c ? KEY(c) : "other"}"]`)?.textContent ?? "";
  assert.match(row("a"), /Claude Agent SDK 0\.3\.296 · runtime aaaaaaaa.*Used by this Core/);
  assert.match(row("b"), /Needed by an installed or downloaded release/);
  assert.match(row("c"), /No installed or downloaded release needs it/);
  assert.match(row("d"), /size unknown.*No installed or downloaded release needs it/);
  assert.match(row("e"), /Its record of what it is can't be read: kept/);
  assert.match(row(null), /^Not a copy Core made.*Kept$/);
  const ticks = () => [...p.doc.querySelectorAll('[data-copy] input[type="checkbox"]')];
  assert.deepEqual(ticks().map((box) => box.closest("[data-copy]").dataset.copy), [KEY("c"), KEY("d")], "only what no release needs");
  assert.equal(p.button("Remove chosen…").disabled, true, "nothing chosen");

  // Chosen, then taken back at the confirmation: nothing is removed.
  ticks()[0].click();
  await until(() => !p.button("Remove chosen…").disabled);
  p.button("Remove chosen…").click();
  const confirm = await until(() => p.doc.querySelector(".storage-confirm"), "the confirmation");
  assert.match(confirm.textContent, /^Remove 1 prepared runtime, about .+ MiB\? Core checks again first that no installed or downloaded release needs it\./);
  p.button("Cancel").click();
  await until(() => !p.doc.querySelector(".storage-confirm"));
  assert.deepEqual(removals, [], "cancelled: nothing posted");

  // Both chosen: a size not known isn't added up as 0.
  ticks()[1].click();
  await until(() => !p.button("Remove chosen…").disabled);
  p.button("Remove chosen…").click();
  const both = await until(() => p.doc.querySelector(".storage-confirm"));
  assert.match(both.textContent, /^Remove 2 prepared runtimes\? /, "no size claimed when one is unknown");
  p.button("Remove").click();
  await until(() => p.doc.querySelector('[data-result="partly"]'), "the results");
  assert.deepEqual(removals, [{ keys: [KEY("c"), KEY("d")] }], "just the chosen keys");
  assert.match(p.doc.querySelector('[data-result="removed"]').textContent, /^Runtime cccccccc: removed, about .+ MiB freed\.$/);
  assert.match(p.doc.querySelector('[data-result="partly"]').textContent,
    /^Runtime dddddddd: moved aside, but not all of it could be removed \(permission denied\)\..*its space is not counted as freed\.$/);
  await until(() => reads() === 2 && !p.doc.querySelector(`[data-copy="${KEY("c")}"]`), "the list read again");
  assert.equal(p.posts().filter((c) => c.url.includes("/claude-sdk")).length, 1, "one removal");
  assert.deepEqual(p.errors, []);
});

test("prepared runtimes: a refusal is said and offers nothing; a removal Core refuses says why and removes nothing", async (t) => {
  const refused = mount({}, { runtimes: { copies: () => ({ format: 1, readAt: "2026-10-25T20:00:00Z", state: "refused", reason: "installing", copies: [], limited: false }) } });
  t.after(refused.close);
  refused.w.renderStorage({ active: true, updates: managed });
  await until(() => refused.text().includes("Workspace database"));
  refused.button("Check prepared runtimes").click();
  await until(() => refused.doc.querySelector('[data-refused="installing"]'), "the refusal");
  assert.match(refused.text(), /An update is being downloaded or installed\. Check again once it has finished\./);
  assert.equal(refused.doc.querySelectorAll('[data-copy] input[type="checkbox"]').length, 0);
  assert.equal(refused.button("Remove chosen…"), undefined);

  // A cache set outside this Workspace's own folder is never offered (T-193).
  const elsewhere = mount({}, { runtimes: { copies: () => ({ format: 1, readAt: "2026-10-25T20:00:00Z", state: "refused", reason: "cacheElsewhere", copies: [], limited: false }) } });
  t.after(elsewhere.close);
  elsewhere.w.renderStorage({ active: true, updates: managed });
  await until(() => elsewhere.text().includes("Workspace database"));
  elsewhere.button("Check prepared runtimes").click();
  await until(() => elsewhere.doc.querySelector('[data-refused="cacheElsewhere"]'), "the refusal");
  assert.match(elsewhere.text(), /These copies are kept in a folder set for Core outside this Workspace's own, which another Core may share, so removing them is not offered here\./);
  assert.equal(elsewhere.button("Remove chosen…"), undefined);

  const late = mount({}, { runtimes: {
    copies: () => ready(listed),
    remove: () => ({ format: 1, state: "refused", reason: "releasesUnreadable", results: [] }),
  } }); t.after(late.close);
  late.w.renderStorage({ active: true, updates: managed });
  await until(() => late.text().includes("Workspace database"));
  late.button("Check prepared runtimes").click();
  const tick = await until(() => late.doc.querySelector('[data-copy] input[type="checkbox"]'));
  tick.click();
  await until(() => !late.button("Remove chosen…").disabled);
  late.button("Remove chosen…").click();
  await until(() => late.button("Remove"));
  late.button("Remove").click();
  const alert = await until(() => [...late.doc.querySelectorAll('.claude-runtime-copies [role="alert"]')].find((el) => el.textContent.includes("couldn't be read")), "the refusal");
  assert.match(alert.textContent, /^The runtime of an installed or downloaded release couldn't be read, so what it needs can't be told\. Nothing is offered for removal\.$/);
  assert.equal(late.doc.querySelectorAll("[data-result]").length, 0, "no result claimed");
  assert.deepEqual(late.errors, []);
});

// YN-65: the build output cleanup after an executor's release, in its section.
const section = (p) => p.doc.querySelector('[aria-labelledby="storage-task-folders"]');
const toggle = (p) => section(p)?.querySelector("[role=switch]") ?? null;
const puts = (p) => p.calls.filter((c) => c.url.endsWith("/api/build-cleanup") && c.method === "PUT").map((c) => c.body);
function cleanupCore(start) {
  let policy = { enabled: false, keepDays: 1, since: null, version: 0, changedAt: null, ...start };
  const changes = [];
  const view = () => ({ policy: structuredClone(policy), maxKeepDays: 30, recent: [], waiting: 0 });
  return {
    changes,
    read: () => view(),
    change: (body) => {
      changes.push(body);
      if (body.expectedVersion !== policy.version) return { httpStatus: 400, error: `version_conflict: the build output cleanup was changed since it was read (now version ${policy.version}); read it again` };
      policy = { ...policy, enabled: body.enabled, keepDays: body.keepDays, version: policy.version + 1,
        since: body.enabled && !policy.enabled ? (body.earlier ? null : "2026-11-09T03:00:00Z") : policy.since };
      return view();
    },
    backlog: () => ({ executors: 3, checked: 3, complete: true, folders: 2, bytes: 8 * 2 ** 30, kept: 1,
      items: [{ executor: "Executor YN-56", path: ".worktrees/yn56/target/debug", bytes: 6 * 2 ** 30 }, { executor: "Executor YN-57", path: "target/yn-x/debug", bytes: 2 * 2 ** 30 }] }),
  };
}

test("the build output cleanup is turned on only once what earlier releases left is counted and the choice confirmed", async (t) => {
  const core = cleanupCore();
  const p = mount({}, { cleanup: core }); t.after(p.close);
  p.w.renderStorage({ active: true, updates: managed });
  await until(() => toggle(p), "the cleanup's switch");
  assert.match(section(p).textContent, /Clean up after an executor is released.*only once nothing uses it/);
  assert.match(section(p).textContent, /Off: nothing is removed automatically\. Only you can turn it on here; Agents have no tool for it\./);
  assert.match(section(p).textContent, /One task's folders, by hand/, "the cleanup by hand stays below");

  toggle(p).click();
  await until(() => section(p).querySelector("[data-backlog]"), "the backlog counted");
  assert.match(section(p).textContent, /Executors released before left 2 debug folders that can go, about 8\.0 GiB; 1 more hold files Cargo didn't make and are kept\./);
  assert.match(section(p).textContent, /\.worktrees\/yn56\/target\/debug6\.0 GiBExecutor YN-56/);
  assert.match(section(p).textContent, /Only counted: nothing was checked for use or removed\./);
  assert.deepEqual(puts(p), [], "counting changes nothing");
  assert.equal(toggle(p).disabled, true, "the switch waits for the choice");
  p.button("Cancel").click();
  await until(() => !section(p).querySelector("[role=group]"));
  assert.deepEqual(puts(p), [], "cancelled: nothing saved");
  assert.equal(toggle(p).getAttribute("aria-checked"), "false");

  toggle(p).click();
  await until(() => p.button("Turn on and clean"), "the confirmation, cleaning the earlier ones by default");
  section(p).querySelectorAll('input[name="build-cleanup-earlier"]')[1].click();
  await until(() => p.button("Turn on"), "only later releases: just turned on");
  p.button("Turn on").click();
  await until(() => toggle(p).getAttribute("aria-checked") === "true", "on, as Core answered");
  assert.deepEqual(puts(p), [{ enabled: true, keepDays: 1, earlier: false, expectedVersion: 0 }]);
  assert.match(section(p).textContent, /On for executors released since .*What is in use is tried again every hour for a week\./);
  assert.deepEqual(p.errors, []);
});

test("the days are saved against the version read, a wrong number is refused, a conflict is said and read again, off saves at once", async (t) => {
  const core = cleanupCore({ enabled: true, keepDays: 1, version: 3, since: null });
  const p = mount({}, { cleanup: core }); t.after(p.close);
  p.w.renderStorage({ active: true, updates: managed });
  await until(() => toggle(p)?.getAttribute("aria-checked") === "true");
  assert.match(section(p).textContent, /On for every released executor\./);
  const days = section(p).querySelector("#build-cleanup-days");
  const type = (value) => {
    Object.getOwnPropertyDescriptor(p.w.HTMLInputElement.prototype, "value").set.call(days, value);
    days.dispatchEvent(new p.w.Event("input", { bubbles: true }));
  };
  type("31");
  await until(() => section(p).textContent.includes("A whole number from 0 to 30."));
  assert.equal(p.button("Save").disabled, true);
  type("5");
  await until(() => p.button("Save") && !p.button("Save").disabled);
  p.button("Save").click();
  await until(() => !p.button("Save"), "saved");
  assert.deepEqual(puts(p).at(-1), { enabled: true, keepDays: 5, earlier: false, expectedVersion: 3 });

  // Changed elsewhere meanwhile: refused, said, and read again.
  core.change({ enabled: true, keepDays: 7, expectedVersion: 4 });
  type("2");
  await until(() => p.button("Save"));
  const before = p.calls.filter((c) => c.url.endsWith("/api/build-cleanup") && c.method === "GET").length;
  p.button("Save").click();
  await until(() => section(p).textContent.includes("Not saved: version_conflict"), "the conflict");
  await until(() => p.calls.filter((c) => c.url.endsWith("/api/build-cleanup") && c.method === "GET").length === before + 1, "read again");
  await until(() => days.value === "7", "the days Core keeps now");

  toggle(p).click();
  await until(() => toggle(p).getAttribute("aria-checked") === "false", "off at once");
  assert.deepEqual(puts(p).at(-1), { enabled: false, keepDays: 7, earlier: false, expectedVersion: 5 });
  assert.equal(p.calls.filter((c) => c.url.endsWith("/backlog")).length, 0, "turning off counts nothing");
});

test("the latest cleanups: a row per folder with its state, the reasons Core gave and the next try", async (t) => {
  const outcome = (state, results, extra = {}) => ({ state, nextTryAt: state === "waiting" ? "2026-11-10T03:00:00Z" : null, updatedAt: "2026-11-10T02:15:00Z",
    executor: { id: `e-${state}`, name: `Executor ${state}`, releasedAt: "2026-11-09T01:00:00Z" }, taskId: "YN-56", results, ...extra });
  const p = mount({}, { cleanup: { read: () => ({ policy: { enabled: true, keepDays: 1, since: null, version: 2, changedAt: null }, maxKeepDays: 30, waiting: 1, recent: [
    outcome("done", [
      { path: ".worktrees/yn56/target/debug", how: ["it worked there"], state: "removed", reasons: [], bytes: 8.3 * 2 ** 30 },
      { path: ".worktrees/yn56/shots/target/debug", how: ["its Jobs ran there"], state: "kept", reasons: ["It holds what Cargo does not make: shots"], bytes: null },
    ]),
    outcome("waiting", [{ path: ".worktrees/yn57/target/debug", how: ["on its pull request's branch"], state: "waiting", reasons: ["Cargo is building here now"], bytes: 7 * 2 ** 30 }]),
    outcome("gaveUp", [{ path: ".worktrees/yn60/target/debug", how: ["it worked there"], state: "waiting", reasons: ["Agent Mori works in this folder"], bytes: 1024 }]),
  ] }) } }); t.after(p.close);
  p.w.renderStorage({ active: true, updates: managed });
  await until(() => p.doc.querySelector("[data-recent]"), "the latest cleanups");
  const rows = [...p.doc.querySelectorAll("[data-recent] li")].map((li) => [li.dataset.result, li.textContent]);
  assert.deepEqual(rows.map(([state]) => state), ["removed", "kept", "waiting", "gaveUp"]);
  assert.match(rows[0][1], /^Removed YN-56 · \.worktrees\/yn56\/target\/debug8\.3 GiBExecutor done · it worked there · /);
  assert.match(rows[1][1], /^Kept .*size unknown.*It holds what Cargo does not make: shots/);
  assert.match(rows[2][1], /^Will retry .*Cargo is building here now · next try /);
  assert.match(rows[3][1], /^Given up .*Agent Mori works in this folder · in use for a week: left as it is/);
  assert.match(section(p).textContent, /1 executor waits for the next try\./);
  assert.deepEqual(p.posts(), [], "showing them changes nothing");
});

test("an answer without a policy is said, never shown as off", async (t) => {
  const p = mount({}, { cleanup: { read: () => ({ recent: [] }) } }); t.after(p.close);
  p.w.renderStorage({ active: true, updates: managed });
  await until(() => section(p)?.textContent.includes("Could not read the build output cleanup: Core's answer has no policy"));
  assert.equal(toggle(p), null, "no switch to press");
});
