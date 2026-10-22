// Restore files dialog against fixture HTTP only; no Core, no Claude.
import "./jsdom-guard.mjs";
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
const fixture = await mkdtemp(path.join(cache, "claude-checkpoint-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {ClaudeCheckpointButton} from ${JSON.stringify(path.join(root, "src/ClaudeCheckpoint.tsx"))};
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
const root = createRoot(document.getElementById('root'));
window.render = props => root.render(<ClaudeCheckpointButton {...props}/>);
window.renderTurns = ({turns, agent}) => flushSync(() => root.render(<>{turns.map((turn, i) =>
  <Turn key={turn.id} turn={turn} index={i} agent={agent} onFile={() => {}}/>)}</>));`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "CheckpointUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what = "condition settles") {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await pause(10);
  }
  assert.ok(check(), what);
}
const U1 = "11111111-1111-4111-8111-111111111111";
const agent = { id: "agent a", name: "Claude", harness: "claude", status: "idle", connectionState: "connected" };
const preview = (extra = {}) => ({
  userMessageId: U1, turnId: "t1", previewId: "p1", previewedAt: "now", expiresInSeconds: 600,
  canRewind: true, reason: null, error: null, truncated: false, insertions: 3, deletions: 1,
  files: [
    { path: "/lab/a.txt", shown: "a.txt", exists: true },
    { path: "/lab/notes/b.md", shown: "notes/b.md", exists: false },
  ],
  ...extra,
});

/** Every request waits until the test answers it, in order. */
function mount(props = {}) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.fetch = (url, init = {}) =>
    new Promise((resolve) => calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body), resolve }));
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.eval(bundle);
  if (props) window.render({ agent, nativeUuid: U1, turnRunning: false, ...props });
  const page = {
    window, document: window.document, calls, errors,
    reply(index, value, status = 200) {
      calls[index].resolve({ ok: status < 400, status, json: async () => value,
        text: async () => (typeof value === "string" ? value : JSON.stringify(value)) });
    },
    button: (label) => [...window.document.querySelectorAll("button")].find((node) => node.textContent.trim() === label),
    text: () => window.document.body.textContent.replace(/\s+/g, " "),
    close: () => window.close(),
  };
  return page;
}
async function open(page) {
  await until(() => page.button("Restore files…"), "the entry is drawn");
  page.button("Restore files…").click();
  await until(() => page.calls.length === 1, "the dialog asks for a preview");
}

test("the conversation offers it on Claude prompts that carry their native uuid", async () => {
  const page = mount(null);
  try {
    const user = (id, extra = {}) => ({ id, type: "userMessage", content: [{ type: "text", text: id }], ...extra });
    const turns = [
      { id: "t1", status: "completed", items: [user("u1", { nativeUuid: U1 }), { id: "r1", type: "agentMessage", text: "Done." }] },
      { id: "t2", status: "completed", items: [user("u2")] },
      { id: "t3", status: "inProgress", items: [user("u3", { nativeUuid: "33333333-3333-4333-8333-333333333333" })] },
      { id: "t4", status: "completed", items: [user("u4", { nativeUuid: "44444444-4444-4444-8444-444444444444", _yuzunoDelivery: "queued" })] },
    ];
    const entries = () => Object.fromEntries([...page.document.querySelectorAll(".checkpoint-open")]
      .map((node) => [node.closest("[data-item-id]").dataset.itemId, node.disabled]));
    page.window.renderTurns({ turns, agent: { ...agent, color: "green", cwd: "/lab" } });
    assert.deepEqual(entries(), { u1: false, u3: true }, "not without a native uuid, nor before Claude confirmed the prompt");
    assert.ok(page.document.querySelector('[data-item-id="u1"] .message-label .checkpoint-open'), "it sits in the message's label row");
    page.window.renderTurns({ turns, agent: { ...agent, color: "green", cwd: "/lab", harness: "codex" } });
    assert.deepEqual(entries(), {}, "Codex Agents have no Claude checkpoints");
    assert.equal(page.calls.length, 0);
  } finally { page.close(); }
});

test("the entry is only offered between turns of an open Agent", async () => {
  for (const [props, title] of [
    [{ turnRunning: true }, "Files can be restored between turns"],
    [{ agent: { ...agent, status: "working" } }, "Files can be restored between turns"],
    [{ agent: { ...agent, status: "waiting" } }, "Files can be restored between turns"],
    [{ agent: { ...agent, closedAt: "yesterday" } }, "This Agent is closed"],
  ]) {
    const page = mount(props);
    try {
      await pause();
      const entry = page.button("Restore files…");
      assert.equal(entry.disabled, true, JSON.stringify(props));
      assert.equal(entry.title, title);
      assert.equal(page.calls.length, 0, "nothing is asked of Claude Code");
    } finally { page.close(); }
  }
});

test("a preview lists the files and limits; one confirmation restores exactly that preview", async () => {
  const page = mount();
  try {
    await open(page);
    assert.deepEqual([page.calls[0].url, page.calls[0].method, page.calls[0].body],
      ["/api/agents/agent%20a/claude/checkpoints/preview", "POST", { userMessageId: U1 }]);
    assert.match(page.text(), /Asking Claude Code what would change/);
    assert.equal(page.button("Restore 2 files"), undefined, "no restore before the preview");
    page.reply(0, preview());
    await until(() => page.button("Restore 2 files"));
    assert.deepEqual([...page.document.querySelectorAll(".checkpoint-files code")].map((n) => n.textContent), ["a.txt", "notes/b.md"]);
    assert.equal(page.document.querySelector(".checkpoint-files li").title, "/lab/a.txt");
    assert.match(page.text(), /2 files would change/);
    assert.match(page.text(), /\+3 −1 lines/);
    assert.match(page.text(), /missing now · would be put back/);
    assert.match(page.text(), /Write, Edit and NotebookEdit/);
    assert.match(page.text(), /shell commands, sub-agents or anything outside Claude are not part of the checkpoint/);
    assert.match(page.text(), /valid for 10 minutes/);
    assert.match(page.text(), /The conversation stays as it is/);
    const confirm = page.button("Restore 2 files");
    confirm.click(); confirm.click();
    await until(() => page.calls.length === 2);
    await pause();
    assert.equal(page.calls.length, 2, "a double click confirms once");
    assert.deepEqual([page.calls[1].url, page.calls[1].body], ["/api/agents/agent%20a/claude/checkpoints/restore", { previewId: "p1" }]);
    assert.match(page.text(), /Restoring…/);
    assert.equal(page.button("Cancel").disabled, true, "the dialog stays while files are written");
    page.reply(1, { status: "restored", userMessageId: U1, files: ["a.txt", "notes/b.md"], remaining: [], skippedLinks: 0, error: null });
    await until(() => page.text().includes("Restored 2 files to how they were at this message."));
    assert.equal(page.button("Restore 2 files"), undefined, "a preview is confirmed once");
    assert.equal(page.button("Preview again"), undefined, "a confirmed restore offers nothing more");
    assert.ok(page.button("Close"));
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a stale preview restores nothing and asks for a new preview", async () => {
  const page = mount();
  try {
    await open(page);
    page.reply(0, preview());
    await until(() => page.button("Restore 2 files"));
    page.button("Restore 2 files").click();
    await until(() => page.calls.length === 2);
    page.reply(1, { status: "stale", reason: "files", changed: ["a.txt"] });
    await until(() => page.button("Preview again"));
    assert.match(page.text(), /These files changed after the preview, so nothing was restored: ?a\.txt/);
    assert.equal(page.button("Restore 2 files"), undefined);
    page.button("Preview again").click();
    await until(() => page.calls.length === 3);
    assert.deepEqual(page.calls[2].body, { userMessageId: U1 });
    page.reply(2, preview({ previewId: "p2", files: [{ path: "/lab/a.txt", shown: "a.txt", exists: true }] }));
    await until(() => page.button("Restore 1 file"));
    page.button("Restore 1 file").click();
    await until(() => page.calls.length === 4);
    assert.deepEqual(page.calls[3].body, { previewId: "p2" }, "only the new preview is confirmed");
    for (const [reason, text] of [["runtime", /Claude Code restarted after the preview/], ["session", /The Claude session changed/],
      ["checkpoint", /checkpoint changed after the preview/], ["expired", /more than 10 minutes old/]]) {
      page.reply(page.calls.length - 1, { status: "stale", reason, changed: [] });
      await until(() => text.test(page.text()), reason);
      page.button("Preview again").click();
      await until(() => page.calls.length % 2 === 1);
      page.reply(page.calls.length - 1, preview({ previewId: `p-${reason}` }));
      await until(() => page.button("Restore 2 files"));
      page.button("Restore 2 files").click();
      await until(() => page.calls.length % 2 === 0);
    }
  } finally { page.close(); }
});

test("unavailable checkpoints are explained and offer no restore", async () => {
  for (const [answer, text] of [
    [preview({ previewId: null, canRewind: false, reason: "noCheckpoint", error: "No file checkpoint found for this message.", files: [] }),
      /has no file checkpoint for this message\. Messages sent before this session had checkpoints have none, and Claude Code does not keep one for every message\./],
    [preview({ previewId: null, canRewind: false, reason: "notEnabled", error: "File rewinding is not enabled.", files: [] }),
      /File checkpoints aren’t turned on in this Claude Code session/],
    [preview({ previewId: null, canRewind: false, reason: "unavailable", error: "Session is busy", files: [] }),
      /can’t restore files at this message: Session is busy\./],
    [preview({ previewId: null, files: [] }), /Nothing to restore: the files Claude changed after this message already match/],
    [preview({ previewId: null, truncated: true }), /more than 2 files\. Yuzuno only restores a list it can show in full/],
  ]) {
    const page = mount();
    try {
      await open(page);
      page.reply(0, answer);
      await until(() => text.test(page.text()), String(text));
      assert.equal([...page.document.querySelectorAll("button")].some((b) => /^Restore \d/.test(b.textContent.trim())), false);
    } finally { page.close(); }
  }
});

test("Claude Code's own failures and partial restores are reported as it gave them", async () => {
  for (const [answer, text, list] of [
    [{ status: "failed", files: ["a.txt", "notes/b.md"], remaining: [], skippedLinks: null, error: "File rewinding is not enabled." },
      /Claude Code didn’t restore the files: File rewinding is not enabled\.(?!\.)/, []],
    [{ status: "partial", files: ["a.txt", "notes/b.md"], remaining: ["notes/b.md"], skippedLinks: 1, error: null },
      /restored only some of the files\. These still differ from the checkpoint: Claude Code skipped 1 symbolic link\./, ["notes/b.md"]],
    [{ status: "unconfirmed", files: ["a.txt", "notes/b.md"], remaining: [], skippedLinks: 0, error: null, checkError: "Checkpoint state could not be read." },
      /reported the restore, but its check afterwards didn’t confirm it: Checkpoint state could not be read\. These files may or may not be restored/, ["a.txt", "notes/b.md"]],
  ]) {
    const page = mount();
    try {
      await open(page);
      page.reply(0, preview());
      await until(() => page.button("Restore 2 files"));
      page.button("Restore 2 files").click();
      await until(() => page.calls.length === 2);
      page.reply(1, answer);
      await until(() => text.test(page.text()), String(text));
      assert.deepEqual([...page.document.querySelectorAll(".checkpoint-files code")].map((n) => n.textContent), list);
      assert.equal(page.button("Restore 2 files"), undefined, "a used preview is not offered again");
      assert.ok(page.button("Preview again"), "what differs now can be previewed again");
      assert.equal(page.calls.length, 2, "nothing is sent again by itself");
    } finally { page.close(); }
  }
});

test("Core's refusals are shown and the preview can be asked for again", async () => {
  const page = mount();
  try {
    await open(page);
    page.reply(0, { error: "Claude is working or waiting for an answer; files can be restored between turns" }, 400);
    await until(() => page.button("Preview again"));
    assert.match(page.document.querySelector("[role=alert]").textContent, /files can be restored between turns/);
    page.button("Preview again").click();
    await until(() => page.calls.length === 2);
    page.reply(1, preview());
    await until(() => page.button("Restore 2 files"));
    assert.equal(page.document.querySelector("[role=alert]"), null);
    page.button("Restore 2 files").click();
    await until(() => page.calls.length === 3);
    page.reply(2, { error: "This preview is no longer valid; preview the restore again" }, 400);
    await until(() => page.button("Preview again"));
    assert.match(page.text(), /This preview is no longer valid/);
  } finally { page.close(); }
});
