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
        target: "new", sameIdentity: true, notes: ["This backup is of the Workspace this Core uses: the restored copy keeps its identity and native sessions, so it must never run alongside this Core."] } };
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
