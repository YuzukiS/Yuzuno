import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// YN-74 ①b (design 2.4, 7): a cleanup plan's gate Ask on Home shows each
// group as Core summarized it, the executor's words as a smaller note, and
// can't be sent while that summary can't be shown as the Ask asks it. The
// real AskReply, with Core's cleanup-plan read answered here. Synthetic
// data only; no Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "cleanup-approval-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AskReply} from ${JSON.stringify(path.join(root, "src/home/AskReply.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderAsk=(section)=>root.render(<AskReply section={section} projectId="p1" workspaceId="ws-1" agents={window.fixtureAgents} readOnly={false} onSent={()=>{}}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "CleanupApproval", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick(15);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const agent = { id: "ex", name: "Cleanup executor", harness: "claude", status: "idle", cwd: "/synthetic", model: "", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const PLAN = "11111111-2222-4333-8444-555555555555";
const SHA = "ab".repeat(32);

const summary = (group, decision, over = {}) => ({
  group, decision, executed: ["delete", "rebuildable"].includes(decision), items: 2, pending: 2,
  kinds: { entry: 2, cacheDir: {}, worktree: 0 }, bytes: 3 * 1024 ** 3, bytesComplete: true, worktrees: 0,
  uniqueCommits: { worktrees: 0, commits: 0 }, trackedChanges: 0, untrackedFiles: 0, snapshots: { items: 1, bytes: 2048 },
  snapshotTooLarge: 0, refused: { items: 0, reasons: [] }, categories: {}, warnings: [],
  largest: [{ item: "a", path: "/synthetic/scratch/job-a", kind: "entry", bytes: 2 * 1024 ** 3, category: "scratch-entry", flags: ["snapshot"] }],
  ...over,
});

// The executor calls a group holding a worktree with its own commit "rebuildable" and "safe".
const plan = {
  planId: PLAN, taskId: "T-1", title: "Tidy", state: "submitted", sha256: SHA, expiresAt: "2026-11-10T09:00:00Z", machine: null,
  items: 3, refused: 0,
  groups: [
    { id: "d", decision: "delete", authorLabel: "Old job copies", authorReason: "finished tasks", summary: summary("d", "delete") },
    { id: "r", decision: "rebuildable", authorLabel: "Rebuildable build output (safe)", authorReason: "only caches", summary: summary("r", "rebuildable", {
      items: 1, pending: 1, kinds: { entry: 0, cacheDir: {}, worktree: 1 }, worktrees: 1, bytes: 512 * 1024 ** 2,
      uniqueCommits: { worktrees: 1, commits: 1 }, untrackedFiles: 1, snapshots: { items: 0, bytes: 0 },
      warnings: [{ code: "notRebuildable", text: "Marked rebuildable, but Core finds 1 worktree(s), 0 entr(ies) and 0 folder(s) no rule recognizes in it" },
        { code: "uniqueCommits", text: "1 worktree(s) hold 1 commit(s) found on no remote branch" }],
      largest: [{ item: "w", path: "/synthetic/demo/.worktrees/ahead", kind: "worktree", bytes: 512 * 1024 ** 2, category: "worktree-unique-commits", flags: ["uniqueCommits:1", "untrackedFiles"] }],
    }) },
  ],
};

const ask = ({ question = `Approve cleanup plan ${PLAN} (sha256 ${SHA})?`, options = ["d", "r"], gate = { taskId: "T-1", step: 4 } } = {}) => ({
  key: "gates/cleanup", kind: "ask", title: "Approve the cleanup", version: 1,
  owner: { agentId: "ex", name: "Cleanup executor", state: "active" }, updatedAt: "2026-11-09T09:00:00Z", updatedTurnId: null,
  body: { root: "text", elements: { text: { type: "Markdown", props: { text: "See plan.md" } } } },
  ask: {
    question, state: "open", gate,
    reply: { form: { id: "approve", title: "Cleanup", fields: [
      { id: "groups", type: "multi", label: "Groups to apply", required: true, options: options.map((id) => ({ id, label: plan.groups.find((g) => g.id === id)?.authorLabel ?? `Group ${id}` })) },
      { id: "except", type: "text", label: "Exceptions", required: false },
    ] } },
  },
  attachments: [], refs: {}, seen: null, history: false,
});

function mount({ respond, language } = {}) {
  const errors = [];
  const requests = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://cleanup.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  if (language) window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  window.fixtureAgents = [agent];
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    const { status = 200, body = {} } = respond(String(url));
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  return { window, errors, requests };
}

const submit = (window) => window.document.querySelector(".clarification .primary-button");

test("each group shows Core's summary and the executor's words only as a note", async () => {
  const { window, errors, requests } = mount({ respond: () => ({ body: { plan, planned: true } }) });
  window.renderAsk(ask());
  const options = await until(() => {
    const found = window.document.querySelectorAll(".cleanup-group");
    return found.length === 2 && found;
  }, "both groups as Core summarized them");
  assert.ok(requests.some((r) => r.url.endsWith("/api/tasks/T-1/cleanup-plan")), JSON.stringify(requests));
  const [deleted, rebuildable] = [...options].map((o) => o.textContent);
  assert.match(deleted, /Delete · 2 items · 3\.0 GiB/);
  assert.match(deleted, /1 kept in a snapshot first/);
  assert.match(deleted, /Executor's note: Old job copies — finished tasks/);
  // The misleading label stays a note; Core's summary says what is there.
  assert.match(rebuildable, /Rebuildable · 1 item · 512 MiB/);
  assert.match(rebuildable, /1 worktree/);
  assert.match(rebuildable, /Marked rebuildable, but Core finds 1 worktree\(s\)/);
  assert.match(rebuildable, /1 worktree\(s\) hold 1 commit\(s\) found on no remote branch/);
  assert.match(rebuildable, /\/synthetic\/demo\/\.worktrees\/ahead/);
  const note = rebuildable.indexOf("Executor's note: Rebuildable build output (safe)");
  assert.ok(note > rebuildable.indexOf("Marked rebuildable"), "the executor's words come after Core's");
  assert.ok(window.document.querySelector(".cleanup-group-author"), "a smaller note");
  assert.match(window.document.querySelector(".cleanup-approval-note").textContent, /Core's summary of plan 11111111/);
  assert.equal(submit(window).disabled, false, "it can be answered");
  assert.deepEqual(errors, []);
});

test("without a plan Core can show as the Ask asks it, it can't be sent", async () => {
  const cases = [
    { name: "no plan waits", respond: () => ({ body: { plan: null, planned: true } }), section: ask(), says: /No cleanup plan of this task waits/ },
    { name: "an older plan", respond: () => ({ body: { plan, planned: true } }), section: ask({ question: `Approve cleanup plan ${PLAN}?` }), says: /does not name the plan waiting now/ },
    { name: "other choices", respond: () => ({ body: { plan, planned: true } }), section: ask({ options: ["d", "x"] }), says: /choices are not this plan's groups/ },
    { name: "unreadable", respond: () => ({ status: 500, body: { error: "boom" } }), section: ask(), says: /couldn't be read/ },
  ];
  for (const { name, respond, section, says } of cases) {
    const { window } = mount({ respond });
    window.renderAsk(section);
    const shown = await until(() => window.document.querySelector(".cleanup-approval-note.is-blocked"), name);
    assert.match(shown.textContent, says, name);
    assert.equal(shown.getAttribute("role"), "alert", name);
    assert.equal(submit(window).disabled, true, `${name}: no answer`);
    assert.equal(window.document.querySelectorAll(".cleanup-group").length, 0, `${name}: no summary shown`);
  }
});

test("a gate Ask of a task that never had a plan is an ordinary Ask", async () => {
  const { window } = mount({ respond: () => ({ body: { plan: null, planned: false } }) });
  window.renderAsk(ask());
  await until(() => submit(window) && !submit(window).disabled, "the form, ready to answer");
  await tick(60);
  assert.equal(window.document.querySelector(".cleanup-approval-note"), null);
  assert.equal(window.document.querySelectorAll(".cleanup-group").length, 0);
  assert.match(window.document.querySelector(".clarification-options").textContent, /Old job copies/);
});

test("in Chinese too", async () => {
  const { window } = mount({ respond: () => ({ body: { plan, planned: true } }), language: "zh-Hans" });
  window.renderAsk(ask());
  const options = await until(() => {
    const found = window.document.querySelectorAll(".cleanup-group");
    return found.length === 2 && found;
  }, "both groups in Chinese");
  const [deleted, rebuildable] = [...options].map((o) => o.textContent);
  assert.match(deleted, /删除 · 2 项/);
  assert.match(deleted, /执行者的说明：Old job copies/);
  assert.match(rebuildable, /标为可重建，但 Core 在里面找到 worktree 1 个/);
  assert.match(rebuildable, /1 个 worktree 里有 1 个提交不在任何远端分支上/);
  assert.match(window.document.querySelector(".cleanup-approval-note").textContent, /Core 对计划 11111111/);
  const blocked = mount({ respond: () => ({ body: { plan: null, planned: true } }), language: "zh-Hans" });
  blocked.window.renderAsk(ask());
  const shown = await until(() => blocked.window.document.querySelector(".cleanup-approval-note.is-blocked"), "the warning in Chinese");
  assert.match(shown.textContent, /没有等待批准的清理计划/);
});
