import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-29 /changes: Yuzuno's record of the file edits Codex made in one turn.
// The dialog is rendered alone, with turns as Core sends them (previews for
// large edits) and a fake payload endpoint that answers when a test says so.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "codex-changes-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {CodexChangesDialog} from ${JSON.stringify(path.join(root, "src/CodexChanges.tsx"))};
import {changesLimits} from ${JSON.stringify(path.join(root, "src/changes.ts"))};
const root=createRoot(document.getElementById('root'));
window.changesLimits=changesLimits;
window.renderChanges=(props)=>root.render(props ? <CodexChangesDialog {...props}/> : null);`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, cssCodeSplit: false, lib: { entry, name: "CodexChanges", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output).find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const agent = { id: "agent-1", name: "Dev", status: "idle", color: "sage", harness: "codex", cwd: "/work/app", lastSeq: 1 };
const ask = (id) => ({ id: `${id}-ask`, type: "userMessage", content: [{ type: "text", text: "Fix the parser and tidy up" }] });
const update = (path, diff) => ({ path, kind: { type: "update", move_path: null }, diff });
const edit = (id, changes, status = "completed", extra = {}) => ({ id, type: "fileChange", status, changes, ...extra });
const turn = (id, items, status = "completed", extra = {}) => ({ id, status, items: [ask(id), ...items], ...extra });

function mount() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  const calls = [];
  const events = [];
  // Each payload read waits until the test answers it: answer(index, body) or fail(index).
  const pending = [];
  window.fetch = (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    return new Promise((resolve) => pending.push(resolve));
  };
  const answer = (index, body) => pending[index]({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const fail = (index) => pending[index]({ ok: false, status: 500, json: async () => ({ error: "payload unavailable" }), text: async () => '{"error":"payload unavailable"}' });
  window.eval(bundle);
  const render = async (extra) => {
    window.renderChanges(extra === null ? null : {
      agent, open: true, turnId: "turn-2", turnNumber: 2, olderNotLoaded: false,
      onOpenChange: (open) => events.push(["open", open]), onFile: (path) => events.push(["file", path]),
      onShowEdit: (turnId, itemId) => events.push(["show", turnId, itemId]), ...extra,
    });
    await tick();
  };
  return { window, document: window.document, calls, events, errors, answer, fail, render, close: () => window.close() };
}
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, message) {
  for (let n = 0; n < 200; n++) {
    const value = read();
    if (value) return value;
    await tick(10);
  }
  assert.fail(message);
}
const dialog = (page) => page.document.querySelector('[role="dialog"]');
const file = (page, name) => dialog(page).querySelector(`section.changes-file[aria-label="${name}"]`);
const button = (scope, pattern) => [...scope.querySelectorAll("button")].find((node) => pattern.test(node.textContent.trim()));
const rows = (section) => [...section.querySelectorAll(".changes-edit")];
const shownLines = (row) => [...row.querySelectorAll(".changes-lines > span")].map((line) => [line.dataset.line, line.textContent.replace(/\n$/, "")]);

const recorded = turn("turn-2", [
  edit("e1", [update("/work/app/src/a.rs", "@@ -1,3 +1,3 @@\n fn a() {\n-    old();\n+    new();\n@@ -9 +9 @@\n--- a SQL comment, removed\n+-- a SQL comment"),
    { path: "/work/app/src/new.rs", kind: { type: "add" }, diff: "fn main() {}\n" }]),
  { id: "cmd", type: "commandExecution", command: "sed -i s/x/y/ src/c.rs", status: "completed", aggregatedOutput: "" },
  edit("e2", [update("/work/app/src/a.rs", "@@ -12 +12 @@\n-x\n+y")], "failed"),
  edit("e3", [{ path: "/work/app/old.txt", kind: { type: "delete" }, diff: "gone\nfor good\n" }], "declined"),
  edit("e4", [{ path: "/work/app/src/b.rs", kind: { type: "update", move_path: "/work/app/src/b2.rs" }, diff: "@@ -1 +1 @@\n-b\n+b2\n\nMoved to: /work/app/src/b2.rs" }]),
  { id: "reply", type: "agentMessage", text: "Done.", phase: "final_answer" },
]);

test("/changes groups a turn's recorded edits by file, in order, with status and kind, and reads nothing", async () => {
  const page = mount();
  try {
    await page.render({ turns: [turn("turn-1", [edit("old", [update("/work/app/src/z.rs", "@@ -1 +1 @@\n-z\n+zz")])]), recorded] });
    const box = await until(() => dialog(page), "the dialog");
    assert.match(box.textContent, /Changes in this turn/);
    assert.match(box.textContent, /Yuzuno's record of the file edits Codex made · Dev/);
    const summary = box.querySelector(".changes-turn").textContent;
    assert.match(summary, /Turn 2/);
    assert.match(summary, /“Fix the parser and tidy up”/);
    assert.match(summary, /The latest turn with recorded edits among the turns loaded here\./);
    assert.match(summary, /4 files · 4 edits · 2 applied · 1 failed · 1 declined/);
    assert.deepEqual([...box.querySelectorAll("section.changes-file")].map((s) => s.getAttribute("aria-label")),
      ["src/a.rs", "src/new.rs", "old.txt", "src/b.rs"], "files in the order first edited, inside the folder shortened");
    assert.ok(!file(page, "src/z.rs") && !file(page, "src/c.rs"), "another turn's edit and a shell edit are not this turn's record");
    const a = rows(file(page, "src/a.rs"));
    assert.deepEqual(a.map((row) => row.querySelector(".changes-edit-heading span").textContent.replace(/\s+/g, " ").trim()),
      ["Edit 1 of 4 · Updated · Applied", "Edit 2 of 4 · Updated · Failed"], "each file's edits in turn order, with their status");
    assert.ok(!a[0].querySelector(".changes-lines"), "an edit is drawn only when opened");
    button(a[0], /^Show$/).click();
    await tick();
    assert.deepEqual(shownLines(a[0]), [["hunk", "@@ -1,3 +1,3 @@"], ["ctx", " fn a() {"], ["del", "-    old();"], ["add", "+    new();"],
      ["hunk", "@@ -9 +9 @@"], ["del", "--- a SQL comment, removed"], ["add", "+-- a SQL comment"]], "a removed '--- ' line inside a hunk is still removed");
    const added = rows(file(page, "src/new.rs"))[0];
    button(added, /^Show$/).click();
    await tick();
    assert.match(added.textContent, /Edit 1 of 4 · Added · Applied/);
    assert.match(added.textContent, /The added file's content, as Codex wrote it\./);
    assert.deepEqual(shownLines(added), [["add", "fn main() {}"]], "the content Codex recorded, not a diff");
    const deleted = rows(file(page, "old.txt"))[0];
    button(deleted, /^Show$/).click();
    await tick();
    assert.match(deleted.textContent, /Edit 3 of 4 · Deleted · Declined/);
    assert.deepEqual(shownLines(deleted), [["del", "gone"], ["del", "for good"]]);
    const moved = rows(file(page, "src/b.rs"))[0];
    assert.match(moved.textContent, /Edit 4 of 4 · Updated · moved to src\/b2\.rs · Applied/);
    button(moved, /^Show$/).click();
    await tick();
    assert.deepEqual(shownLines(moved).at(-1), ["meta", "Moved to: /work/app/src/b2.rs"]);
    // The current file, and the edit in the conversation, are the reader's choices.
    button(file(page, "src/a.rs"), /^Open file/).click();
    button(a[0], /^Show in conversation$/).click();
    assert.deepEqual(page.events, [["file", "/work/app/src/a.rs"], ["show", "turn-2", "e1"]]);
    assert.match(box.textContent, /Not recorded: changes made by shell commands, your own edits and sub-agents' edits\. This is not a Git diff of the folder/);
    assert.deepEqual(page.calls, [], "nothing is read: every edit was whole in the record");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

// A preview Core sent for a large edit: the start of its first file's diff, one file left out.
const preview = (id, extra = {}) => edit(id, [update("/work/app/src/a.rs", "@@ -1,400 +1,400 @@\n-old 0")], "completed",
  { _yuzunoTruncated: { changes: { bytes: 9000, keep: "head", omitted: 1, cutDiffs: [0] } }, ...extra });
const full = { fields: { changes: [update("/work/app/src/a.rs", "@@ -1,2 +1,2 @@\n-old 0\n+new 0"),
  { path: "/work/app/src/c.rs", kind: { type: "add" }, diff: "c\n" }] } };

test("an edit's full text is read only when asked, once for its Item however many of its files ask", async () => {
  const page = mount();
  try {
    await page.render({ turns: [turn("turn-2", [preview("big")])] });
    const box = await until(() => dialog(page), "the dialog");
    assert.match(box.textContent, /Edit 1 also changed 1 more file, not in the preview\./);
    const row = rows(file(page, "src/a.rs"))[0];
    button(row, /^Show$/).click();
    await tick();
    assert.match(row.textContent, /Only the start of this edit is in the preview\./);
    assert.deepEqual(shownLines(row), [["hunk", "@@ -1,400 +1,400 @@"], ["del", "-old 0"]], "the preview, marked as such");
    assert.equal(page.calls.length, 0, "nothing is read until asked");
    button(row, /^Load the full edit$/).click();
    await tick();
    assert.deepEqual(page.calls, [{ url: "/api/agents/agent-1/items/big/payload?turnId=turn-2&field=changes", method: "GET" }],
      "the Item's trimmed field, and nothing else of the turn");
    assert.match(row.textContent, /Loading the full edit/);
    const hidden = box.querySelector(".changes-hidden");
    assert.match(hidden.textContent, /Loading edit 1/, "the Item's other part waits on the same read");
    assert.ok(!button(hidden, /^Load edit 1$/), "nothing there to read it twice");
    page.answer(0, full);
    await until(() => file(page, "src/c.rs"), "the file the preview left out");
    assert.deepEqual(shownLines(rows(file(page, "src/a.rs"))[0]), [["hunk", "@@ -1,2 +1,2 @@"], ["del", "-old 0"], ["add", "+new 0"]]);
    assert.doesNotMatch(dialog(page).textContent, /Only the start|not in the preview/, "whole now");
    assert.match(rows(file(page, "src/c.rs"))[0].textContent, /Edit 1 of 1 · Added · Applied/);
    assert.equal(page.calls.length, 1);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a failed read says so and is read again only when asked; a read for an edit that has changed, or after closing, is not shown", async () => {
  const page = mount();
  try {
    await page.render({ turns: [turn("turn-2", [preview("big")])] });
    const box = await until(() => dialog(page), "the dialog");
    const hidden = () => box.querySelector(".changes-hidden");
    button(hidden(), /^Load edit 1$/).click();
    await tick();
    page.fail(0);
    await until(() => /Couldn't load edit 1: .*payload unavailable/.test(hidden().textContent), "the failure");
    await tick(120);
    assert.equal(page.calls.length, 1, "not read again by itself");
    button(hidden(), /^Try again$/).click();
    await tick();
    assert.equal(page.calls.length, 2);
    // The edit changes while its read is on its way (Core sent a newer preview): that read is not shown.
    await page.render({ turns: [turn("turn-2", [preview("big", { _yuzunoTruncated: { changes: { bytes: 9100, keep: "head", omitted: 1, cutDiffs: [0] } } })])] });
    page.answer(1, full);
    await tick(60);
    assert.ok(!file(page, "src/c.rs"), "an answer for the edit as it was is not shown as the edit now");
    assert.match(hidden().textContent, /Load edit 1/);
    // Closed while a read is on its way: its answer goes nowhere.
    button(hidden(), /^Load edit 1$/).click();
    await tick();
    assert.equal(page.calls.length, 3);
    await page.render(null);
    page.answer(2, full);
    await tick(60);
    assert.ok(!dialog(page), "closed");
    await page.render({ agent: { ...agent, id: "agent-2", name: "Other" }, turns: [turn("turn-2", [edit("own", [update("/work/app/src/own.rs", "@@ -1 +1 @@\n-p\n+q")])])] });
    await until(() => dialog(page), "the other Agent's dialog");
    assert.deepEqual([...dialog(page).querySelectorAll("section.changes-file")].map((s) => s.getAttribute("aria-label")), ["src/own.rs"],
      "another Agent's dialog shows only its own record");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a long edit is drawn in bounded steps, up to a limit, with the rest left in the conversation", async () => {
  const page = mount();
  try {
    Object.assign(page.window.changesLimits, { segmentLines: 5, segmentChars: 10_000, maxLines: 12, maxChars: 100_000 });
    const body = Array.from({ length: 30 }, (_, n) => `+line ${n}`).join("\n");
    await page.render({ turns: [turn("turn-2", [edit("long", [update("/work/app/big.txt", `@@ -0,0 +1,30 @@\n${body}`)])])] });
    const row = rows(file(page, "big.txt"))[0];
    button(row, /^Show$/).click();
    await tick();
    assert.equal(shownLines(row).length, 5);
    button(row, /^Show 5 more lines \(26 left\)$/).click();
    await tick();
    assert.equal(shownLines(row).length, 10);
    button(row, /^Show 5 more lines \(21 left\)$/).click();
    await tick();
    assert.equal(shownLines(row).length, 12, "never more than the limit");
    assert.match(row.textContent, /The rest of this edit \(19 more lines\) is not shown here\./);
    assert.ok(!button(row, /^Show \d+ more lines/));
    button(row, /^Show in conversation$/).click();
    assert.deepEqual(page.events, [["show", "turn-2", "long"]]);
    // One line longer than a step is shortened, and says so.
    Object.assign(page.window.changesLimits, { segmentChars: 20, maxChars: 40 });
    await page.render({ turns: [turn("turn-2", [edit("wide", [{ path: "/work/app/min.js", kind: { type: "add" }, diff: "x".repeat(500) }])])] });
    const wide = rows(file(page, "min.js"))[0];
    button(wide, /^Show$/).click();
    await tick();
    assert.equal(shownLines(wide)[0][1].length, 20);
    assert.match(wide.textContent, /A line too long to show here was shortened\./);
  } finally {
    page.close();
  }
});

test("the turn stays the one chosen when it opened; a running turn's new edits show there; no record or an unloaded turn says so", async () => {
  const page = mount();
  try {
    const running = (items) => turn("turn-2", items, "inProgress");
    await page.render({ turns: [running([edit("e1", [update("/work/app/a.rs", "@@ -1 +1 @@\n-a\n+b")])])] });
    let box = await until(() => dialog(page), "the dialog");
    assert.match(box.textContent, /This turn is still running: its new edits show here as Codex records them\./);
    await page.render({ turns: [
      running([edit("e1", [update("/work/app/a.rs", "@@ -1 +1 @@\n-a\n+b")]), edit("e2", [update("/work/app/b.rs", "@@ -1 +1 @@\n-c\n+d")], "inProgress")]),
      turn("turn-3", [edit("e9", [update("/work/app/later.rs", "@@ -1 +1 @@\n-l\n+m")])]),
    ] });
    box = dialog(page);
    assert.deepEqual([...box.querySelectorAll("section.changes-file")].map((s) => s.getAttribute("aria-label")), ["a.rs", "b.rs"],
      "the same turn, with its new edit; a newer turn is not taken");
    assert.match(rows(file(page, "b.rs"))[0].textContent, /Edit 2 of 2 · Updated · In progress/);
    await page.render({ turnId: null, turnNumber: null, olderNotLoaded: true, turns: [turn("turn-1", [])] });
    assert.match(dialog(page).textContent,
      /No file edits are recorded in the turns loaded here\. Earlier turns are not loaded; load them in the conversation to look further back\./);
    await page.render({ turnId: "turn-7", turnNumber: 7, turns: [turn("turn-8", [])] });
    assert.match(dialog(page).textContent, /Turn 7 is no longer among the turns loaded here\./);
    await page.render({ olderNotLoaded: true, turns: [turn("turn-2", [edit("e1", [update("/work/app/a.rs", "@@ -1 +1 @@\n-a\n+b")])], "completed",
      { _yuzunoSlice: { start: 3, total: 9, index: 0 } })] });
    assert.match(dialog(page).textContent, /among the turns loaded here; earlier turns are not loaded\./);
    assert.match(dialog(page).textContent, /Only part of this turn is loaded here, so edits outside that part are not listed\./);
    assert.deepEqual(page.calls, []);
  } finally {
    page.close();
  }
});
