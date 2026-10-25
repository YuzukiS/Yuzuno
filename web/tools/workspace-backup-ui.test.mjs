import "./jsdom-guard.mjs";
// T-192: Settings → Backup, against a stub Core answering as
// core/src/workspace_backup/online.rs does. Opening only reads; a refusal
// names its Jobs; a backup is followed step by step to its result and can be
// stopped, and so can the next one; a Stop that fails is said; restore is
// offered only after its precheck passes for the same folders, and nothing
// offers to switch to or start the restored copy; the phone entry only reads;
// a lost answer is sent again as the same request.
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
const fixture = await mkdtemp(path.join(cache, "workspace-backup-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceBackup} from ${JSON.stringify(path.join(root, "src/WorkspaceBackup.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderBackup = props => root.render(<WorkspaceBackup {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, cssCodeSplit: false, lib: { entry, name: "WorkspaceBackupUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

const NOT_COVERED = ["Native CLI accounts, keys and configuration (Codex, Claude Code, OpenCode)"];
function view(over = {}) {
  return {
    canChange: true,
    workspaceId: "ws-synthetic",
    canBackUp: true,
    refusals: [],
    unfinishedJobs: [],
    estimateBytes: 3 * 1024 * 1024,
    current: null,
    recent: [],
    notCovered: NOT_COVERED,
    replaceRunningWorkspace: "Replacing the Workspace this Core uses needs Core stopped; it is not offered here",
    ...over,
  };
}
function op(over = {}) {
  return {
    id: "op1", requestId: "r", kind: "backup", state: "running", step: "database",
    request: { to: "/backups/new" }, startedAt: "2026-10-24T20:00:00Z", finishedAt: null, error: null, result: null,
    ...over,
  };
}
const summary = {
  path: "/backups/new", workspaceId: "ws-synthetic", createdAt: "2026-10-24T20:00:00Z", agents: 2, files: 6, bytes: 4096,
  excluded: [{ path: "claude-runtime", reason: "A cache of the Claude runtime, which Core rebuilds" }], notCovered: NOT_COVERED,
};

/** The page under test, for what a failed wait shows. */
let shown = null;
/** `handler(url, method, body)` answers `{status, body}`, or throws a
 * TypeError for an answer that never arrives. */
function mount(handler) {
  const calls = [];
  const vc = new VirtualConsole();
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  dom.window.fetch = async (input, init = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(input), method, body });
    let answered;
    try {
      answered = await handler(String(input), method, body);
    } catch (error) {
      throw error instanceof TypeError ? new dom.window.TypeError(error.message) : error;
    }
    const { status = 200, body: answer } = answered;
    const text = JSON.stringify(answer);
    return { ok: status < 400, status, json: async () => structuredClone(answer), text: async () => text };
  };
  dom.window.eval(bundle);
  dom.window.renderBackup({ active: true });
  const doc = dom.window.document;
  shown = { doc, calls };
  return {
    window: dom.window, doc, calls,
    posts: () => calls.filter((c) => c.method === "POST"),
    text: () => doc.querySelector("#settings-backup")?.textContent ?? "",
    close: () => dom.window.close(),
  };
}
const button = (p, text) => [...p.doc.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
async function waitFor(f, what) {
  for (let i = 0; i < 300; i++) {
    if (f()) return;
    await tick();
  }
  const page = shown?.doc.querySelector("#settings-backup")?.textContent ?? "";
  const sent = (shown?.calls ?? []).map((c) => `${c.method} ${c.url.replace(/^https?:\/\/[^/]+/, "")}`).join(", ");
  assert.fail(`Expected UI state did not appear: ${what}\npage: ${page}\nrequests: ${sent}`);
}
function type(p, label, value) {
  const input = p.doc.querySelector(`input[aria-label="${label}"]`);
  Object.getOwnPropertyDescriptor(p.window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new p.window.Event("input", { bubbles: true }));
}

test("opening only reads, and a refusal names the Jobs that have not ended", async () => {
  const p = mount((url) => {
    assert.ok(url.endsWith("/api/workspace/backup"), url);
    return { body: view({ canBackUp: false, refusals: [{ code: "unfinished_jobs", detail: "1 Job(s) have not ended; back up once they have" }],
      unfinishedJobs: [{ id: "job-1", name: "nightly build" }] }) };
  });
  try {
    await waitFor(() => p.text().includes("nightly build"), "the unfinished Job");
    assert.ok(p.text().includes("job-1"));
    type(p, "Backup folder", "/backups/new");
    await tick();
    assert.equal(button(p, "Back up").disabled, true, "no backup while a Job runs");
    assert.equal(p.posts().length, 0, "opening the page sends nothing");
    assert.ok(p.text().includes("Never in a backup"));
  } finally {
    p.close();
  }
});

test("a backup is followed step by step to its result, and can be stopped", async () => {
  let reads = 0;
  let stopped = 0;
  const p = mount((url, method, body) => {
    if (url.endsWith("/api/workspace/backup")) return { body: view() };
    if (url.endsWith("/api/workspace/backups")) {
      assert.equal(body.to, "/backups/new");
      assert.ok(body.requestId, "a requestId");
      return { status: 202, body: { operation: op({ requestId: body.requestId }) } };
    }
    if (url.endsWith("/operations/op1/stop")) {
      stopped += 1;
      return { status: 202, body: { stopping: true } };
    }
    if (url.endsWith("/operations/op1")) {
      reads += 1;
      return { body: reads < 2 ? op({ step: "files" }) : op({ state: "succeeded", step: "verify", finishedAt: "2026-10-24T20:01:00Z", result: summary }) };
    }
    assert.fail(`unexpected ${method} ${url}`);
  });
  try {
    await waitFor(() => button(p, "Back up"), "the backup control");
    type(p, "Backup folder", "/backups/new");
    await tick();
    button(p, "Back up").click();
    await waitFor(() => p.text().includes("Copying the database"), "the running step");
    button(p, "Stop").click();
    await waitFor(() => stopped === 1, "the stop request");
    await waitFor(() => p.text().includes("Backup finished"), "the finished backup");
    assert.ok(p.text().includes("2 Agents, 6 files"), p.text());
    assert.ok(p.text().includes("Left out (1)"));
    assert.equal(p.posts().filter((c) => c.url.endsWith("/api/workspace/backups")).length, 1);
  } finally {
    p.close();
  }
});

test("after a backup is stopped, the next one on the same page can be stopped too", async () => {
  const started = [];
  const stops = [];
  const p = mount((url, method, body) => {
    if (url.endsWith("/api/workspace/backup")) return { body: view() };
    if (url.endsWith("/api/workspace/backups")) {
      const id = `op${started.length + 1}`;
      started.push(id);
      return { status: 202, body: { operation: op({ id, requestId: body.requestId }) } };
    }
    const stop = url.match(/\/operations\/(op\d)\/stop$/);
    if (stop) {
      stops.push(stop[1]);
      return { status: 202, body: { stopping: true } };
    }
    const read = url.match(/\/operations\/(op\d)$/);
    if (read) {
      const id = read[1];
      return { body: stops.includes(id) ? op({ id, state: "stopped", finishedAt: "2026-10-24T20:01:00Z" }) : op({ id }) };
    }
    assert.fail(`unexpected ${method} ${url}`);
  });
  try {
    await waitFor(() => button(p, "Back up"), "the backup control");
    type(p, "Backup folder", "/backups/new");
    await waitFor(() => !button(p, "Back up").disabled, "Back up offered");
    button(p, "Back up").click();
    await waitFor(() => button(p, "Stop"), "Stop for the first backup");
    button(p, "Stop").click();
    await waitFor(() => p.text().includes("Backup stopped"), "the first backup stopped");
    await waitFor(() => !button(p, "Back up").disabled, "Back up offered again");
    button(p, "Back up").click();
    await waitFor(() => started.length === 2 && p.text().includes("Copying the database"), "the second backup running");
    await waitFor(() => button(p, "Stop") && !button(p, "Stop").disabled, "an enabled Stop for the second backup");
    button(p, "Stop").click();
    await waitFor(() => p.text().includes("Backup stopped"), "the second backup stopped");
    assert.deepEqual(stops, ["op1", "op2"], "each Stop is sent for the operation it shows");
  } finally {
    p.close();
  }
});

test("a refused or unanswered Stop is said, and Stop can be sent again", async () => {
  const stops = [];
  const p = mount((url, method, body) => {
    if (url.endsWith("/api/workspace/backup")) return { body: view({ current: stops.length < 2 ? op() : null }) };
    if (url.endsWith("/operations/op1/stop")) {
      stops.push(body);
      if (stops.length === 1) throw new TypeError("Failed to fetch");
      return { status: 409, body: { error: "That operation is not running", code: "not_running" } };
    }
    if (url.endsWith("/operations/op1")) {
      // It finished before the second Stop reached it.
      return { body: stops.length < 2 ? op() : op({ state: "succeeded", step: "verify", finishedAt: "2026-10-24T20:01:00Z", result: summary }) };
    }
    assert.fail(`unexpected ${method} ${url}`);
  });
  try {
    await waitFor(() => button(p, "Stop"), "Stop for the running backup");
    button(p, "Stop").click();
    await waitFor(() => p.text().includes("No answer from Core to Stop"), "the unanswered Stop");
    assert.ok(!p.text().includes("Backup stopped"), "an unanswered Stop is not said to have stopped it");
    await waitFor(() => button(p, "Stop") && !button(p, "Stop").disabled, "Stop offered again");
    button(p, "Stop").click();
    await waitFor(() => p.text().includes("That operation is not running"), "the refused Stop");
    await waitFor(() => p.text().includes("Backup finished"), "the backup as it ended");
    assert.equal(stops.length, 2);
    assert.deepEqual(stops[0], stops[1], "the second Stop is the same request");
  } finally {
    p.close();
  }
});

test("restore is offered only after its precheck passes for the same folders", async () => {
  const restores = [];
  const p = mount((url, method, body) => {
    if (url.endsWith("/api/workspace/backup")) return { body: view() };
    if (url.endsWith("/restore/precheck")) {
      if (body.to === "/workspaces/taken") return { status: 400, body: { error: "This backup cannot be restored there; nothing was changed: /workspaces/taken is not empty" } };
      return { body: { ok: true, workspaceId: "ws-synthetic", createdAt: "2026-10-24T20:00:00Z", agents: 2, files: 6, bytes: 4096,
        target: "new", sameIdentity: true, notes: ["This backup is of the Workspace this Core uses: the restored copy keeps its Workspace ID and the IDs of its Agents' native sessions (not the native histories, which are not backed up), so it must never run alongside this Core."] } };
    }
    if (url.endsWith("/api/workspace/restores")) {
      restores.push(body);
      return { status: 202, body: { operation: op({ id: "op2", kind: "restore", requestId: body.requestId, request: { from: body.from, to: body.to } }) } };
    }
    if (url.endsWith("/operations/op2")) {
      return { body: op({ id: "op2", kind: "restore", state: "succeeded", step: "check", finishedAt: "2026-10-24T20:02:00Z",
        result: { ...summary, restoredTo: "/workspaces/copy", nextSteps: ["Stop the Core that uses the original Workspace, then start a Core with --data-dir /workspaces/copy"], notes: [] } }) };
    }
    assert.fail(`unexpected ${method} ${url}`);
  });
  try {
    await waitFor(() => button(p, "Check restore"), "the restore controls");
    type(p, "Backup to restore", "/backups/new");
    type(p, "Restore into", "/workspaces/taken");
    await tick();
    assert.equal(button(p, "Restore").disabled, true, "not before a precheck");
    button(p, "Check restore").click();
    await waitFor(() => p.text().includes("is not empty"), "the refused precheck");
    assert.equal(button(p, "Restore").disabled, true);
    type(p, "Restore into", "/workspaces/copy");
    await tick();
    button(p, "Check restore").click();
    await waitFor(() => p.text().includes("Can be restored into this new folder"), "the passed precheck");
    assert.ok(p.text().includes("must never run alongside this Core"));
    type(p, "Restore into", "/workspaces/other");
    await tick();
    assert.equal(button(p, "Restore").disabled, true, "a changed folder needs its own precheck");
    // The folders it was checked for: offered again, without a second check.
    type(p, "Restore into", "/workspaces/copy");
    await waitFor(() => !button(p, "Restore").disabled, "restore offered");
    await tick();
    button(p, "Restore").click();
    await waitFor(() => p.text().includes("Restored into"), "the restore result");
    assert.deepEqual(restores.map((r) => [r.from, r.to]), [["/backups/new", "/workspaces/copy"]]);
    assert.ok(p.text().includes("--data-dir /workspaces/copy"));
    const labels = [...p.doc.querySelectorAll("button")].map((b) => b.textContent.trim().toLowerCase());
    assert.ok(!labels.some((l) => /switch|replace|start core|open workspace/.test(l)), labels.join(", "));
  } finally {
    p.close();
  }
});

test("through the phone entry the page only reads", async () => {
  const p = mount((url) => {
    assert.ok(url.endsWith("/api/workspace/backup"), url);
    return { body: view({ canChange: false, recent: [op({ id: "old", state: "succeeded", finishedAt: "2026-10-24T19:00:00Z", result: summary })] }) };
  });
  try {
    await waitFor(() => p.text().includes("can only be seen"), "the read-only note");
    for (const label of ["Back up", "Check", "Check restore", "Restore"]) assert.equal(button(p, label), undefined, label);
    assert.ok(p.text().includes("Backup · succeeded"), p.text());
    assert.equal(p.posts().length, 0);
  } finally {
    p.close();
  }
});

test("a lost answer is sent again as the same request", async () => {
  let attempts = 0;
  const p = mount((url, method, body) => {
    if (url.endsWith("/api/workspace/backup")) return { body: view() };
    if (url.endsWith("/api/workspace/backups/check")) {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return { status: 202, body: { operation: op({ id: "op3", kind: "check", requestId: body.requestId, request: { path: body.path } }) } };
    }
    if (url.endsWith("/operations/op3")) return { body: op({ id: "op3", kind: "check", state: "failed", step: "verify", finishedAt: "2026-10-24T20:03:00Z", error: "files/x differs from its manifest entry" }) };
    assert.fail(`unexpected ${method} ${url}`);
  });
  try {
    await waitFor(() => button(p, "Check"), "the check control");
    type(p, "Backup to check", "/backups/old");
    await tick();
    button(p, "Check").click();
    await waitFor(() => button(p, "Try again"), "the retry");
    button(p, "Try again").click();
    await waitFor(() => p.text().includes("Check failed"), "the failed check");
    assert.ok(p.text().includes("differs from its manifest entry"));
    const sent = p.posts().filter((c) => c.url.endsWith("/backups/check"));
    assert.equal(sent.length, 2);
    assert.equal(sent[0].body.requestId, sent[1].body.requestId, "the retry is the same request");
  } finally {
    p.close();
  }
});

const OFF = { enabled: false, timeUtc: "", folder: null, nextRunAt: null, lastRun: null };

test("the daily backup is off until saved on; its time is UTC and a refusal is said", async () => {
  const sent = [];
  let refuse = true;
  const p = mount((url, method, body) => {
    if (url.endsWith("/api/workspace/backup")) return { body: view({ schedule: OFF }) };
    if (url.endsWith("/api/workspace/backup/schedule")) {
      sent.push(body);
      if (refuse) return { status: 400, body: { error: "/backups/missing is not a folder on the computer that runs Core" } };
      return { body: { schedule: { enabled: true, timeUtc: body.timeUtc, folder: body.folder, nextRunAt: "2026-10-26T03:00:00Z", lastRun: null } } };
    }
    assert.fail(`unexpected ${method} ${url}`);
  });
  try {
    const daily = () => p.doc.querySelector('[aria-label="Daily backup"]');
    await waitFor(() => daily(), "the daily backup");
    assert.match(daily().textContent, /Off\. When on, Core backs up once a day/);
    assert.doesNotMatch(daily().textContent, /Next run/);
    assert.equal(p.posts().length, 0, "opening sends nothing");
    daily().querySelector('input[type="checkbox"]').click();
    type(p, "Folder for daily backups", "/backups/missing");
    await waitFor(() => !button(p, "Save").disabled, "Save offered");
    assert.match(daily().textContent, /03:00 UTC is .* on this device today/);
    button(p, "Save").click();
    await waitFor(() => daily().querySelector('[role="alert"]'), "the refusal");
    assert.match(daily().querySelector('[role="alert"]').textContent, /is not a folder/);
    assert.match(daily().textContent, /^Daily backupOff\./, "still off");
    refuse = false;
    type(p, "Folder for daily backups", "/backups/daily");
    await waitFor(() => !button(p, "Save").disabled, "Save offered again");
    button(p, "Save").click();
    await waitFor(() => daily().textContent.includes("Next run: 2026-10-26 03:00 UTC."), "the schedule on");
    assert.match(daily().textContent, /Every day at 03:00 UTC \(.+ on this device\), into a new folder in \/backups\/daily\. Old backups are never deleted\./);
    assert.deepEqual(sent.at(-1), { enabled: true, timeUtc: "03:00", folder: "/backups/daily" });
    assert.equal(button(p, "Save").disabled, true, "nothing left to save");
  } finally {
    p.close();
  }
});

test("a daily run is shown as it ended, never as a success while it runs; the phone only reads", async () => {
  const failed = { slot: "2026-10-28T03:00:00Z", missed: 2, startedAt: "2026-10-28T08:00:05Z", to: "/backups/daily/yuzuno-backup-20261028T0300Z",
    operationId: "op9", state: "failed", error: "Not enough space for the backup: needs 2 GiB more. Nothing was written", finishedAt: "2026-10-28T08:00:06Z" };
  const p = mount((url) => {
    assert.ok(url.endsWith("/api/workspace/backup"), url);
    return { body: view({ canChange: false, schedule: { enabled: true, timeUtc: "03:00", folder: "/backups/daily", nextRunAt: "2026-10-29T03:00:00Z", lastRun: failed } }) };
  });
  try {
    const daily = () => p.doc.querySelector('[aria-label="Daily backup"]');
    await waitFor(() => daily()?.textContent.includes("failed"), "the failed run");
    assert.match(daily().textContent, /Last run, for 2026-10-28 03:00 UTC, failed: Not enough space for the backup: needs 2 GiB more\. Nothing was written\. It made up for 2 missed days\./);
    assert.equal(daily().querySelector("input, button"), null, "the phone entry has no controls");
    assert.equal(p.posts().length, 0);
  } finally {
    p.close();
  }
  const q = mount((url) => {
    assert.ok(url.endsWith("/api/workspace/backup"), url);
    return { body: view({ schedule: { enabled: true, timeUtc: "03:00", folder: "/backups/daily", nextRunAt: "2026-10-29T03:00:00Z",
      lastRun: { slot: "2026-10-28T03:00:00Z", missed: 0, startedAt: "2026-10-28T03:00:05Z", to: "/backups/daily/yuzuno-backup-20261028T0300Z",
        operationId: "op10", state: "running", error: null, finishedAt: null } } }) };
  });
  try {
    const daily = () => q.doc.querySelector('[aria-label="Daily backup"]');
    await waitFor(() => daily()?.textContent.includes("is backing up to"), "the running run");
    assert.doesNotMatch(daily().textContent, /and checked/, "not a success while it runs");
  } finally {
    q.close();
  }
});

test("the retention preview says what it would keep, could remove and protect, offers no deletion, and Check reads one back", async () => {
  const sent = [];
  const backup = (day, verdict, reason, extra = {}) => ({
    name: `yuzuno-backup-202610${day}T0300Z`, path: `/backups/daily/yuzuno-backup-202610${day}T0300Z`, verdict, reason,
    workspaceId: "ws-synthetic", createdAt: `2026-10-${day}T03:00:05+00:00`, estimateBytes: 3 * 1024 * 1024, manifestSha256: `sha-${day}`, ...extra,
  });
  const preview = {
    folder: "/backups/daily", keep: 2, unreadableNames: 0, removableEstimateBytes: 3 * 1024 * 1024,
    entries: [
      backup("24", "keep", "One of the latest 2", { lastCheckedAt: "2026-10-24T04:00:00+00:00" }),
      backup("23", "keep", "One of the latest 2"),
      backup("22", "remove", "Older than the latest 2"),
      { name: "other", path: "/backups/daily/other", verdict: "protected", reason: "A backup of another Workspace", workspaceId: "ws-other" },
      { name: "damaged", path: "/backups/daily/damaged", verdict: "unknown", reason: "Its manifest can't be read: The backup manifest is not JSON" },
      { name: "photos", path: "/backups/daily/photos", verdict: "ignored", reason: "No manifest.json, so not a Workspace backup" },
    ],
  };
  const p = mount((url, method, body) => {
    if (url.endsWith("/api/workspace/backup")) {
      return { body: view({ schedule: { enabled: true, timeUtc: "03:00", folder: "/backups/daily", nextRunAt: "2026-10-26T03:00:00Z", lastRun: null } }) };
    }
    if (url.endsWith("/api/workspace/backup/retention/preview")) {
      sent.push(["preview", body]);
      return { body: preview };
    }
    if (url.endsWith("/api/workspace/backups/check")) {
      sent.push(["check", body]);
      return { status: 202, body: { operation: op({ id: "op7", kind: "check", requestId: body.requestId, request: { path: body.path } }) } };
    }
    if (url.endsWith("/operations/op7")) {
      return { body: op({ id: "op7", kind: "check", state: "succeeded", step: "verify", finishedAt: "2026-10-25T02:00:00Z", result: { ...summary, path: body?.path ?? "/backups/daily/yuzuno-backup-20261022T0300Z" } }) };
    }
    assert.fail(`unexpected ${method} ${url}`);
  });
  try {
    const group = () => p.doc.querySelector('[aria-label="Keep the latest backups"]');
    await waitFor(() => group()?.querySelector('input[aria-label="Folder holding backups"]')?.value === "/backups/daily", "the daily folder as the default");
    type(p, "Backups to keep", "2");
    await waitFor(() => !button(p, "Preview").disabled, "Preview offered");
    button(p, "Preview").click();
    await waitFor(() => group().querySelector('[aria-label="Retention preview"]'), "the preview");
    assert.deepEqual(sent[0], ["preview", { folder: "/backups/daily", keep: 2 }]);
    const result = group().querySelector('[aria-label="Retention preview"]');
    assert.equal(result.querySelector('[role="status"]').textContent,
      "Keeping the latest 2: 2 kept, 1 could be removed (about 3.0 MiB, as their manifests declare), 2 protected or can't be judged. 1 other entry is not a backup.");
    const headings = [...result.querySelectorAll("h4")].map((h) => h.textContent);
    assert.deepEqual(headings, ["Kept (2)", "Could be removed (1)", "Protected (1)", "Can't be judged (1)"]);
    assert.match(result.textContent, /no backup's files were checked/);
    assert.match(result.textContent, /last checked 2026-10-24 04:00 UTC/);
    assert.match(result.textContent, /A backup of another Workspace/);
    const labels = [...group().querySelectorAll("button")].map((b) => b.textContent.trim().toLowerCase());
    assert.ok(!labels.some((l) => /delete|clean|apply|automatic/.test(l)), labels.join(", "));
    assert.deepEqual(labels.filter((l) => l.startsWith("remove")), ["remove…"], "one Remove… for the one removable backup, and it only asks");
    const removable = [...result.querySelectorAll("li")].find((li) => li.textContent.includes("yuzuno-backup-20261022T0300Z"));
    removable.querySelector("button").click();
    await waitFor(() => sent.some(([kind]) => kind === "check"), "the check");
    const check = sent.find(([kind]) => kind === "check")[1];
    assert.equal(check.path, "/backups/daily/yuzuno-backup-20261022T0300Z");
    assert.ok(check.requestId, "Check is the existing operation, with its own requestId");
    await waitFor(() => p.text().includes("Check finished"), "the check's outcome");
  } finally {
    p.close();
  }
});

test("removing one backup asks first, names exactly that one, and sends one removal Core judges again", async () => {
  const sent = [];
  const removable = { name: "yuzuno-backup-20261022T0300Z", path: "/backups/daily/yuzuno-backup-20261022T0300Z", verdict: "remove",
    reason: "Older than the latest 1", workspaceId: "ws-synthetic", createdAt: "2026-10-22T03:00:05+00:00", estimateBytes: 3 * 1024 * 1024, manifestSha256: "sha-22" };
  const kept = { ...removable, name: "yuzuno-backup-20261023T0300Z", path: "/backups/daily/yuzuno-backup-20261023T0300Z", verdict: "keep",
    reason: "One of the latest 1", createdAt: "2026-10-23T03:00:05+00:00", manifestSha256: "sha-23" };
  let reads = 0;
  const p = mount((url, method, body) => {
    if (url.endsWith("/api/workspace/backup")) return { body: view() };
    if (url.endsWith("/retention/preview")) return { body: { folder: "/backups/daily", keep: 1, unreadableNames: 0, removableEstimateBytes: 3 * 1024 * 1024, entries: [kept, removable] } };
    if (url.endsWith("/retention/remove")) {
      sent.push(body);
      // The second comes from a preview made before the first removal: Core judges the folder as it is now.
      if (sent.length === 2) return { status: 400, body: { error: `${removable.name} is no longer in /backups/daily; nothing was removed` } };
      return { status: 202, body: { operation: op({ id: "op8", kind: "remove", step: "preview", requestId: body.requestId, request: { folder: body.folder, name: body.name } }) } };
    }
    if (url.endsWith("/operations/op8")) {
      reads += 1;
      return { body: reads < 2 ? op({ id: "op8", kind: "remove", step: "verify", request: { name: removable.name } })
        : op({ id: "op8", kind: "remove", state: "succeeded", step: "remove", finishedAt: "2026-10-25T03:00:00Z", request: { name: removable.name },
          result: { removed: removable.path, name: removable.name, freedEstimateBytes: 3 * 1024 * 1024, keptChecked: kept.path } }) };
    }
    assert.fail(`unexpected ${method} ${url}`);
  });
  try {
    const group = () => p.doc.querySelector('[aria-label="Keep the latest backups"]');
    await waitFor(() => group(), "the retention controls");
    type(p, "Folder holding backups", "/backups/daily");
    type(p, "Backups to keep", "1");
    await waitFor(() => !button(p, "Preview").disabled, "Preview offered");
    button(p, "Preview").click();
    await waitFor(() => button(p, "Remove…"), "Remove… on the removable backup");
    assert.equal([...group().querySelectorAll("button")].filter((b) => b.textContent.trim() === "Remove…").length, 1);
    button(p, "Remove…").click();
    const confirm = () => group().querySelector(`[aria-label="Remove ${removable.name}"]`);
    await waitFor(() => confirm(), "the confirmation");
    assert.match(confirm().textContent, /Remove \/backups\/daily\/yuzuno-backup-20261022T0300Z, backed up 2026-10-22 03:00 UTC, about 3\.0 MiB\? Only this one backup is removed/);
    assert.match(confirm().textContent, /reads another backup of this Workspace back whole; if it can't, nothing is removed\. A removed backup can't be brought back\./);
    assert.equal(sent.length, 0, "asking sends nothing");
    button(p, "Cancel").click();
    await waitFor(() => !confirm(), "the confirmation closed");
    assert.equal(sent.length, 0, "Cancel sends nothing");
    button(p, "Remove…").click();
    await waitFor(() => button(p, "Remove this backup"), "the confirmation again");
    button(p, "Remove this backup").click();
    await waitFor(() => sent.length === 1, "one removal");
    assert.equal(sent[0].requestId.length > 0, true);
    assert.deepEqual({ ...sent[0], requestId: "r" }, { requestId: "r", folder: "/backups/daily", keep: 1, name: removable.name, manifestSha256: "sha-22" });
    assert.match(group().textContent, /Removal of yuzuno-backup-20261022T0300Z requested; Core's answer shows above\. Preview again once it has ended\./);
    assert.equal(group().querySelector('[aria-label="Retention preview"]') === null, true, "the preview from before is not offered again");
    await waitFor(() => p.text().includes("Removal finished"), "the removal's outcome");
    assert.match(p.text(), /Removed \/backups\/daily\/yuzuno-backup-20261022T0300Z, about 3\.0 MiB as its manifest declared\. First, \/backups\/daily\/yuzuno-backup-20261023T0300Z was read back whole\./);
    assert.equal(sent.length, 1);
    // A stale preview offers it again; Core's refusal is shown as it is, and nothing claims it was removed.
    button(p, "Preview").click();
    await waitFor(() => button(p, "Remove…"), "the stale preview");
    button(p, "Remove…").click();
    await waitFor(() => button(p, "Remove this backup"), "the confirmation");
    button(p, "Remove this backup").click();
    await waitFor(() => sent.length === 2 && p.doc.querySelector(".workspace-backup-error[role=alert]"), "Core's refusal");
    assert.equal(p.doc.querySelector(".workspace-backup-error[role=alert]").textContent.trim(), `${removable.name} is no longer in /backups/daily; nothing was removed`);
    assert.equal(sent[1].requestId !== sent[0].requestId, true, "a new confirmation is a new request");
  } finally {
    p.close();
  }
});

test("a space budget is optional: sent only when given, what stays is said against it, and a removal carries it", async () => {
  const sent = [];
  const backup = (day, verdict, reason, extra = {}) => ({
    name: `yuzuno-backup-202610${day}T0300Z`, path: `/backups/daily/yuzuno-backup-202610${day}T0300Z`, verdict, reason,
    workspaceId: "ws-synthetic", createdAt: `2026-10-${day}T03:00:05+00:00`, estimateBytes: 400 * 1024 * 1024, manifestSha256: `sha-${day}`, ...extra,
  });
  const basis = "Sizes are what each backup's manifest declares for its database and files. Disk use can differ (the file system's blocks, compression, links); nothing is measured on disk.";
  const p = mount((url, method, body) => {
    if (url.endsWith("/api/workspace/backup")) return { body: view() };
    if (url.endsWith("/retention/preview")) {
      sent.push(["preview", body]);
      if (body.budgetBytes === undefined) {
        return { body: { folder: body.folder, keep: body.keep, unreadableNames: 0, removableEstimateBytes: 0, removableUnknownSizes: 0, sizeBasis: basis,
          entries: [backup("24", "keep", "One of the latest 3"), backup("23", "keep", "One of the latest 3")] } };
      }
      return { body: { folder: body.folder, keep: body.keep, unreadableNames: 0, removableEstimateBytes: 400 * 1024 * 1024, removableUnknownSizes: 1, sizeBasis: basis,
        budget: { bytes: body.budgetBytes, state: "over", keptEstimateBytes: 800 * 1024 * 1024,
          reason: "what stays declares 800 MiB, more than 512 MiB (the newest backup, always kept, declares 400 MiB; 1 protected backup declares 400 MiB). Nothing protected or always kept is offered instead" },
        entries: [
          backup("24", "keep", "The newest backup: kept whatever the space budget"),
          backup("23", "remove", "Beyond the space budget: with what stays, it would declare more than 512 MiB"),
          backup("22", "protected", "The only backup with a successful check on record; kept until one of the latest is checked"),
        ] } };
    }
    if (url.endsWith("/retention/remove")) {
      sent.push(["remove", body]);
      return { status: 202, body: { operation: op({ id: "op9", kind: "remove", step: "preview", requestId: body.requestId, request: { folder: body.folder, name: body.name } }) } };
    }
    if (url.endsWith("/operations/op9")) return { body: op({ id: "op9", kind: "remove", step: "verify", request: { name: "yuzuno-backup-20261023T0300Z" } }) };
    assert.fail(`unexpected ${method} ${url}`);
  });
  try {
    const group = () => p.doc.querySelector('[aria-label="Keep the latest backups"]');
    const result = () => group().querySelector('[aria-label="Retention preview"]');
    await waitFor(() => group(), "the retention controls");
    assert.match(group().textContent, /A space budget is optional\. With one, of the latest only as many are kept as fit in it together/);
    type(p, "Folder holding backups", "/backups/daily");
    type(p, "Backups to keep", "3");
    // No budget: the request is the one it always was.
    await waitFor(() => !button(p, "Preview").disabled, "Preview offered");
    button(p, "Preview").click();
    await waitFor(() => result(), "the count preview");
    assert.deepEqual(sent.at(-1), ["preview", { folder: "/backups/daily", keep: 3 }]);
    assert.equal(result().querySelector("[data-budget]") === null, true, "no budget, nothing said about one");
    assert.match(result().textContent, /nothing is measured on disk/);
    // A budget that can't be a size: not offered.
    type(p, "Space budget in GiB (optional)", "-1");
    await waitFor(() => button(p, "Preview").disabled, "Preview held back");
    type(p, "Space budget in GiB (optional)", "0.5");
    await waitFor(() => !button(p, "Preview").disabled, "Preview offered again");
    button(p, "Preview").click();
    await waitFor(() => result()?.querySelector("[data-budget]"), "the budget preview");
    assert.deepEqual(sent.at(-1), ["preview", { folder: "/backups/daily", keep: 3, budgetBytes: 512 * 1024 * 1024 }]);
    assert.match(result().querySelector('[role="status"]').textContent,
      /^Keeping the latest 3 within 512 MiB: 1 kept, 1 could be removed \(about 400 MiB, as their manifests declare; 1 more of a size that can't be trusted\)/);
    const said = result().querySelector("[data-budget]");
    assert.equal(said.dataset.budget, "over");
    assert.match(said.textContent, /^The space budget can't be reached: what stays declares 800 MiB, more than 512 MiB \(the newest backup, always kept/);
    // A removal is judged again under the same count and budget.
    button(p, "Remove…").click();
    await waitFor(() => button(p, "Remove this backup"), "the confirmation");
    button(p, "Remove this backup").click();
    await waitFor(() => sent.some(([kind]) => kind === "remove"), "the removal");
    const removal = sent.find(([kind]) => kind === "remove")[1];
    assert.deepEqual({ ...removal, requestId: "r" },
      { requestId: "r", folder: "/backups/daily", keep: 3, budgetBytes: 512 * 1024 * 1024, name: "yuzuno-backup-20261023T0300Z", manifestSha256: "sha-23" });
  } finally {
    p.close();
  }
});

// T-196 slice 6: automatic removal of old daily backups.
const DAILY = { enabled: true, timeUtc: "03:00", folder: "/backups/daily", nextRunAt: "2026-10-29T03:00:00Z", lastRun: null, retention: null, retentionNote: null };
const autoPreview = (keep, budgetBytes) => ({
  folder: "/backups/daily", keep,
  entries: [
    { name: "yuzuno-backup-20261028T0300Z", verdict: "keep", reason: `One of the latest ${keep}` },
    { name: "yuzuno-backup-20261027T0300Z", verdict: "keep", reason: `One of the latest ${keep}` },
    { name: "yuzuno-backup-20261020T0300Z", verdict: "remove", reason: `Older than the latest ${keep}` },
    { name: "other", verdict: "protected", reason: "A backup of another Workspace" },
  ],
  unreadableNames: 0, removableEstimateBytes: 3 * 1024 ** 3, removableUnknownSizes: 0,
  sizeBasis: "Sizes are what each backup's manifest declares for its database and files.",
  ...(budgetBytes ? { budget: { bytes: budgetBytes, state: "met", reason: "this Workspace's backups that stay declare 4.0 GiB of 10 GiB" } } : {}),
});

test("automatic removal is off until a preview of the schedule's folder is confirmed for exactly those settings; turning it on removes nothing", async () => {
  let schedule = { ...DAILY };
  const previews = [];
  const sets = [];
  const p = mount((url, method, body) => {
    if (url.endsWith("/api/workspace/backup")) return { body: view({ schedule }) };
    if (url.endsWith("/api/workspace/backup/retention/preview")) {
      previews.push(body);
      return { body: autoPreview(body.keep, body.budgetBytes) };
    }
    if (url.endsWith("/api/workspace/backup/schedule/retention")) {
      sets.push(body);
      const retention = body.enabled ? { keep: body.keep, ...(body.budgetBytes ? { budgetBytes: body.budgetBytes } : {}), folder: body.folder, confirmedAt: "2026-10-28T10:00:00Z" } : null;
      schedule = { ...schedule, retention };
      return { body: { schedule } };
    }
    assert.fail(`unexpected ${method} ${url}`);
  });
  try {
    const auto = () => p.doc.querySelector('[aria-label="Automatic removal"]');
    const inAuto = (text) => [...(auto()?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === text);
    await waitFor(() => auto(), "automatic removal");
    assert.match(auto().textContent, /Off: old daily backups are never removed on their own/);
    assert.match(p.doc.querySelector('[aria-label="Daily backup"]').textContent, /Old backups are never deleted\./);
    assert.equal(inAuto("Turn on automatic removal"), undefined, "nothing to confirm before a preview");
    assert.equal(p.posts().length, 0, "opening sends nothing");
    type(p, "Daily backups to keep", "2");
    type(p, "Space budget for daily backups in GiB (optional)", "10");
    await tick();
    inAuto("Preview").click();
    await waitFor(() => inAuto("Turn on automatic removal"), "the confirm after the preview");
    assert.deepEqual(previews.at(-1), { folder: "/backups/daily", keep: 2, budgetBytes: 10 * 1024 ** 3 });
    assert.match(auto().textContent, /would keep 2 and remove 1 \(about 3\.0 GiB as their manifests declare\); 1 protected or can't be judged/);
    assert.match(auto().textContent, /yuzuno-backup-20261020T0300Z · Older than the latest 2/);
    assert.match(auto().textContent, /Turning it on removes nothing now/);
    // A setting changed after the preview is previewed again before it can be confirmed.
    type(p, "Daily backups to keep", "3");
    await waitFor(() => !inAuto("Turn on automatic removal"), "no confirm for settings not previewed");
    type(p, "Daily backups to keep", "2");
    await tick();
    inAuto("Preview").click();
    await waitFor(() => inAuto("Turn on automatic removal"), "previewed again");
    assert.equal(sets.length, 0, "nothing turned on by a preview");
    inAuto("Turn on automatic removal").click();
    await waitFor(() => /On since 2026-10-28 10:00 UTC/.test(auto().textContent), "on");
    assert.deepEqual(sets.at(-1), { enabled: true, keep: 2, budgetBytes: 10 * 1024 ** 3, folder: "/backups/daily" });
    assert.match(auto().textContent, /keeps the latest 2 within 10 GiB \(by the sizes their manifests declare\) in \/backups\/daily/);
    assert.match(p.doc.querySelector('[aria-label="Daily backup"]').textContent, /Old backups there are removed as Automatic removal below says\./);
    assert.ok(!p.posts().some((c) => c.url.endsWith("/retention/remove")), "turning it on requests no removal");
    inAuto("Turn off").click();
    await waitFor(() => /Off: old daily backups/.test(auto().textContent), "off again");
    assert.deepEqual(sets.at(-1), { enabled: false });
  } finally {
    p.close();
  }
});

test("after a run, automatic removal is said apart from its backup, and its operation shows as one", async () => {
  const run = {
    slot: "2026-10-28T03:00:00Z", missed: 0, startedAt: "2026-10-28T03:00:05Z", to: "/backups/daily/yuzuno-backup-20261028T0300Z",
    operationId: "op9", state: "succeeded", error: null, finishedAt: "2026-10-28T03:01:00Z",
  };
  const cleanup = (over) => ({ state: "succeeded", keep: 2, folder: "/backups/daily", decidedAt: "2026-10-28T03:01:30Z", operationId: "op10", reason: null, error: null, result: null, finishedAt: null, ...over });
  const retention = { keep: 2, folder: "/backups/daily", confirmedAt: "2026-10-27T10:00:00Z" };
  const cases = [
    [cleanup({ state: "failed", error: "Cannot move yuzuno-backup-20261020T0300Z aside to remove it: Permission denied; nothing was removed before it; the rest are left as they are" }),
      /Removing old backups after this run failed: Cannot move yuzuno-backup-20261020T0300Z aside .*the rest are left as they are\. The backup itself is as said above; this is not tried again on its own\./, "failed"],
    [cleanup({ result: { removed: [{ name: "yuzuno-backup-20261020T0300Z", freedEstimateBytes: 3 * 1024 ** 3 }], skipped: [], left: 1, removedEstimateBytes: 3 * 1024 ** 3, keptCheckedName: "yuzuno-backup-20261028T0300Z", sizeBasis: "…" } }),
      /After this run: Removed 1 old backup: yuzuno-backup-20261020T0300Z, about 3\.0 GiB as their manifests declared \(disk use can differ\)\. First, yuzuno-backup-20261028T0300Z was read back whole\. 1 more wait for the next run that succeeds\./, "succeeded"],
    [cleanup({ state: "not_run", reason: "Core started again after this backup ended, before removing old backups; nothing was removed" }),
      /Old backups were not removed after this run: Core started again after this backup ended/, "not_run"],
  ];
  for (const [shown, said, state] of cases) {
    const p = mount((url) => {
      assert.ok(url.endsWith("/api/workspace/backup"), url);
      return { body: view({ schedule: { ...DAILY, retention, lastRun: { ...run, cleanup: shown } } }) };
    });
    try {
      const daily = () => p.doc.querySelector('[aria-label="Daily backup"]');
      await waitFor(() => daily()?.querySelector(`[data-cleanup="${state}"]`), `the ${state} cleanup`);
      assert.match(daily().textContent, /Last run, for 2026-10-28 03:00 UTC: backed up to \/backups\/daily\/yuzuno-backup-20261028T0300Z and checked\./, "the backup's own outcome");
      assert.match(daily().querySelector(`[data-cleanup="${state}"]`).textContent, said);
      assert.equal(daily().querySelector(`[data-cleanup="${state}"]`).className, state === "failed" ? "workspace-backup-error" : "workspace-backup-note");
      assert.equal(p.posts().length, 0);
    } finally {
      p.close();
    }
  }
  // Turned off by Core when the folder changed: said.
  const moved = mount(() => ({ body: view({ schedule: { ...DAILY, retentionNote: "Automatic removal was turned off on 2026-10-28 10:00 UTC because the daily backup's folder changed; preview and turn it on again for the new folder" } }) }));
  try {
    await waitFor(() => moved.doc.querySelector('[aria-label="Automatic removal"]')?.textContent.includes("folder changed"), "the note");
  } finally {
    moved.close();
  }
  // The removal operation while the page is open: followed, and its list of removals shown.
  let done = false;
  const pass = { removed: [{ name: "yuzuno-backup-20261020T0300Z", freedEstimateBytes: 1024 }], skipped: [{ name: "yuzuno-backup-20261019T0300Z", reason: "yuzuno-backup-20261019T0300Z changed since the preview; preview again" }], left: 0, removedEstimateBytes: 1024, keptCheckedName: "yuzuno-backup-20261028T0300Z", sizeBasis: "…" };
  const auto = op({ id: "op10", kind: "remove", step: "recheck", request: { folder: "/backups/daily", keep: "2", automatic: true } });
  const q = mount((url) => {
    if (url.endsWith("/api/workspace/backup")) return { body: view({ schedule: { ...DAILY, retention }, current: done ? null : auto, recent: done ? [{ ...auto, state: "succeeded" }] : [] }) };
    if (url.endsWith("/api/workspace/backup/operations/op10")) {
      done = true;
      return { body: { ...auto, state: "succeeded", step: "remove", finishedAt: "2026-10-28T03:02:00Z", result: pass } };
    }
    assert.fail(`unexpected ${url}`);
  });
  try {
    await waitFor(() => q.text().includes("Automatic removal: Checking the folder again…"), "the running automatic removal");
    await waitFor(() => q.text().includes("Removed 1 old backup: yuzuno-backup-20261020T0300Z"), "its result");
    assert.match(q.text(), /Not removed: yuzuno-backup-20261019T0300Z \(yuzuno-backup-20261019T0300Z changed since the preview; preview again\)\./);
    assert.match(q.text(), /Automatic removal finished/);
  } finally {
    q.close();
  }
  // Stopped part way: said as a stop, with what it had removed, never "nothing … was kept" (review e252fc4d).
  const stoppedError = "Stopped; before it, 1 backup was removed (yuzuno-backup-20261020T0300Z); the rest are left as they are: Stopped on request";
  let ended = false;
  const r = mount((url) => {
    if (url.endsWith("/api/workspace/backup")) return { body: view({ schedule: { ...DAILY, retention }, current: ended ? null : auto, recent: [] }) };
    if (url.endsWith("/api/workspace/backup/operations/op10")) {
      ended = true;
      return { body: { ...auto, state: "stopped", step: "recheck", finishedAt: "2026-10-28T03:02:00Z", error: stoppedError } };
    }
    assert.fail(`unexpected ${url}`);
  });
  try {
    await waitFor(() => r.text().includes("Automatic removal stopped"), "the stopped automatic removal");
    assert.ok(r.text().includes(stoppedError), "what it had removed is said");
    assert.doesNotMatch(r.text(), /nothing it was writing was kept/);
  } finally {
    r.close();
  }
});

test("the Backup page in Chinese (T-189): a run and its cleanup said apart, Core's words as they came; typed folders and a preview kept across a language change, which sends nothing", async () => {
  const run = {
    slot: "2026-10-28T03:00:00Z", missed: 1, startedAt: "2026-10-28T03:00:05Z", to: "/backups/daily/yuzuno-backup-20261028T0300Z",
    operationId: "op9", state: "succeeded", error: null, finishedAt: "2026-10-28T03:01:00Z",
    cleanup: { state: "failed", keep: 2, folder: "/backups/daily", decidedAt: "2026-10-28T03:01:30Z", operationId: "op10", reason: null,
      error: "Cannot move yuzuno-backup-20261020T0300Z aside to remove it: Permission denied", result: null, finishedAt: null },
  };
  const p = mount((url, method, body) => {
    if (url.endsWith("/api/workspace/backup")) return { body: view({ schedule: { ...DAILY, lastRun: run } }) };
    if (url.endsWith("/api/workspace/backup/retention/preview")) return { body: autoPreview(body.keep, body.budgetBytes) };
    assert.fail(`unexpected ${method} ${url}`);
  });
  // Changed in another window: a storage event, as the browser sends it.
  const switchTo = (language) => {
    p.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    p.window.dispatchEvent(new p.window.StorageEvent("storage", { key: "yuzuno.language" }));
  };
  try {
    const group = (en, zh) => p.doc.querySelector(`[aria-label="${en}"], [aria-label="${zh}"]`);
    const auto = () => group("Automatic removal", "自动删除");
    await waitFor(() => auto(), "the page");
    type(p, "Backup folder", "/backups/by-hand");
    type(p, "Daily backups to keep", "2");
    await tick();
    [...auto().querySelectorAll("button")].find((b) => b.textContent.trim() === "Preview").click();
    await waitFor(() => /Turn on automatic removal/.test(auto().textContent), "the preview");
    const sent = p.calls.length;

    switchTo("zh-Hans");
    await waitFor(() => p.doc.querySelector("#settings-backup h3")?.textContent === "Workspace 备份", "Chinese");
    const daily = group("Daily backup", "每日备份").textContent;
    assert.match(daily, /在 \/backups\/daily 中新建一个文件夹。旧备份从不会被删除。/);
    assert.match(daily, /上次运行（2026-10-28 03:00 UTC）：已备份到 \/backups\/daily\/yuzuno-backup-20261028T0300Z 并已检查。它补做了 1 天错过的备份。/, "the backup's own outcome");
    assert.match(daily, /本次运行后的旧备份删除失败：Cannot move yuzuno-backup-20261020T0300Z aside to remove it: Permission denied。备份本身如上所述；这一步不会自动重试。/, "its cleanup apart, Core's error as it came");
    assert.match(auto().textContent, /关闭：旧的每日备份不会被自动删除。受保护或无法判断的备份从不会被删除/);
    assert.match(auto().textContent, /现在在 \/backups\/daily 中保留最新的 2 个，会保留 2 个、删除 1 个（按其清单声明约 3\.0 GiB）；1 个受保护或无法判断。/, "the preview, kept");
    assert.match(auto().textContent, /yuzuno-backup-20261020T0300Z · Older than the latest 2/, "Core's reason as it came");
    assert.ok([...auto().querySelectorAll("button")].some((b) => b.textContent.trim() === "开启自动删除"), "still to confirm");
    assert.equal(p.doc.querySelector('input[aria-label="备份文件夹"]').value, "/backups/by-hand", "what was typed stays");
    assert.equal(p.doc.querySelector('input[aria-label="要保留的每日备份数"]').value, "2");
    assert.equal(p.calls.length, sent, "a language change sends nothing");

    switchTo("en");
    await waitFor(() => p.doc.querySelector("#settings-backup h3")?.textContent === "Workspace backup", "English again");
    assert.match(auto().textContent, /would keep 2 and remove 1 \(about 3\.0 GiB as their manifests declare\); 1 protected or can't be judged/);
    assert.match(group("Daily backup", "每日备份").textContent, /Removing old backups after this run failed: Cannot move/);
    assert.equal(p.doc.querySelector('input[aria-label="Backup folder"]').value, "/backups/by-hand");
    assert.equal(p.calls.length, sent, "nor does changing back");
    assert.equal(p.posts().filter((c) => !c.url.endsWith("/retention/preview")).length, 0, "nothing started or saved");
  } finally {
    p.close();
  }
});
