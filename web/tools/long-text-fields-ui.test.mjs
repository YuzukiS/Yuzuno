import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { composerText, setComposerText } from "./composer-driver.mjs";
import { outcomeFixture } from "./task-outcome-fixture.mjs";

// YN-106: a task's long fields are written in the conversation's composer,
// as Home's replies and forms are. A long paste folds into a block and goes
// whole; each field counts as Core counts what the page sends, against
// Core's own limit, so the page never cuts a paste short and never sends
// what Core refuses: over it, the field says by how much, the form sends
// nothing and keeps what was written. Return makes a new line where the
// form edits and sends where it sends, and an input method's Return is its
// own. The real task panel, with Core answered here.
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(path.join(root, "node_modules/.cache/long-text-fields-"));
let bundle;
try {
  const entry = path.join(temp, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {CollaborationBoard} from ${src("CollaborationBoard.tsx")};
import {CodexReviewDialog} from ${src("CodexReview.tsx")};
import {CodexGoalDialog} from ${src("CodexGoal.tsx")};
import {PrOperations} from ${src("PrOperations.tsx")};
import {coreLimits} from ${src("core-limits.ts")};
window.coreLimits=coreLimits;
const root=createRoot(document.getElementById('root'));
const parts={CodexReviewDialog, CodexGoalDialog, PrOperations};
window.renderBoard=props=>root.render(<CollaborationBoard {...props}/>);
window.renderPart=(name, props)=>{const Part=parts[name]; root.render(<Part {...props}/>);};
window.unmountBoard=()=>root.unmount();`,
  );
  const output = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "LongTextFields", formats: ["iife"] } },
  });
  bundle = (Array.isArray(output) ? output[0] : output).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(temp, { recursive: true, force: true });
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick(15);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
const utf8 = (text) => new TextEncoder().encode(text).length;

/** A paste of about `bytes` UTF-8 bytes in more than 12 lines: CRLF
 * endings, tabs, quotes, a backslash and Chinese. Its middle line marks
 * whether the whole text is on the page. */
function pasted(bytes) {
  const lines = [];
  for (let n = 1; lines.length < 13 || utf8(lines.join("\r\n")) < bytes - 80; n++)
    lines.push(`${n}\t"评审" 第 ${n} 行：C:\\work ok`);
  const text = lines.join("\r\n");
  return { text, deep: lines[Math.floor(lines.length / 2)] };
}
/** Exactly `bytes` UTF-8 bytes, nothing to trim. */
const exactly = (bytes) => "长".repeat(Math.floor(bytes / 3)) + "a".repeat(bytes % 3);

function mount({ part, props, answer } = {}) {
  const fixture = outcomeFixture();
  const errors = [];
  const calls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://long-text-fields.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const document = window.document;
  window.structuredClone = structuredClone;
  window.matchMedia = (media) => ({ media, matches: /reduced-motion/.test(media), addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = window.ResizeObserver;
  window.EventSource = class { addEventListener() {} close() {} };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.scrollTo = () => {};
  // JSDOM does no layout: the composer measures text ranges.
  window.Range.prototype.getClientRects ||= () => [];
  window.Range.prototype.getBoundingClientRect ||= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  window.crypto.randomUUID ??= () => `id-${calls.length}-${Math.random().toString(16).slice(2)}`;
  const task = (id) => fixture.tasks.find((t) => t.id === id);
  window.fetch = async (url, init = {}) => {
    const route = new URL(url, window.location.href).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    const operation = route.startsWith("/api/collaboration/") ? route.slice("/api/collaboration/".length) : "";
    if (operation) calls.push({ operation, body });
    let data;
    const own = answer?.(route, init.method || "GET", body);
    if (!operation && own !== undefined) {
      calls.push({ operation: `${init.method || "GET"} ${route}`, body });
      data = own;
    } else if (operation === "task_comment") data = { activity: { seq: 99 } };
    else if (operation === "task_update") {
      const t = task(body.taskId);
      Object.assign(t, body.patch, { version: t.version + 1 });
      data = { task: t };
    } else if (operation === "task_create")
      data = { task: { ...task("T-3"), id: "T-9", title: body.title, description: body.description, version: 1 } };
    else if (operation === "task_dispatch") data = { task: task(body.taskId) };
    else data = fixture.answer(route, body);
    return { ok: !data.error, status: data.error ? 500 : 200, json: async () => structuredClone(data), text: async () => JSON.stringify(data) };
  };
  window.eval(bundle);
  if (part) window.renderPart(part, props);
  else
    window.renderBoard({
      open: true,
      onOpenChange() {},
      agents: fixture.agents,
      projects: fixture.projects,
      onOpenAgent() {},
      revision: 0,
    });
  const button = (name) =>
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === name);
  const page = {
    window,
    document,
    errors,
    calls,
    fixture,
    button,
    sent: (operation) => calls.filter((call) => call.operation === operation),
    /** The long field labelled `label`. */
    field: (label) =>
      [...document.querySelectorAll(".long-text-field [data-composer-input]")].find(
        (field) => field.getAttribute("aria-label") === label,
      ),
    box: (field) => field.closest(".long-text-field"),
    note: (field) => field.closest(".long-text-field").querySelector(".home-reply-length"),
    chips: (field) => [...field.closest(".long-text-field").querySelectorAll(".pasted-text-chip")],
    async click(name) {
      const node = await until(() => button(name), `the ${name} button`);
      node.click();
      await tick();
    },
    async input(label, text) {
      const node = await until(
        () => [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent.trim().startsWith(label))?.querySelector("input"),
        `the ${label} input`,
      );
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(node, text);
      node.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    },
    /** Pasted into a field, as the clipboard gives it. */
    async paste(field, text) {
      field.focus();
      const event = new window.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { getData: (kind) => (kind === "text/plain" ? text : ""), files: [], items: [] } });
      field.dispatchEvent(event);
      await tick();
    },
    async type(field, text) {
      setComposerText(field, text);
      await tick();
    },
    async key(field, init) {
      field.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
      await tick(40);
    },
    async openTask(id) {
      (await until(() => document.querySelector(`button[data-task-id="${id}"]`), "the task list")).click();
      await until(() => document.querySelector(`.collab-task-title [data-task-id="${id}"]`), `${id} open`);
    },
    close() {
      window.unmountBoard();
      window.close();
    },
    /** The long field labelled `label`, in a dialog's portal as well. */
    async editor(label) {
      return until(() => page.field(label), `the ${label} field`);
    },
  };
  return page;
}

/**
 * Each long field of the task panel: how it opens, what it sends it as, the
 * button that submits it, its Core limit and its Return. `prepare` makes
 * the rest of its form ready to submit.
 */
const places = [
  {
    name: "a new task's description",
    label: "Description",
    limit: "taskDescription",
    submit: "Create task",
    operation: "task_create",
    value: (body) => body.description,
    async open(page) {
      await page.click("New task");
      await page.input("Task title", "Long description");
    },
  },
  {
    name: "a result's summary",
    label: "Result summary",
    limit: "resultSummary",
    submit: "Save result",
    operation: "task_submit_result",
    value: (body) => body.summary,
    async open(page) {
      await page.openTask("T-3");
      await page.click("Add result");
    },
  },
  ...[
    ["a criterion's report", "What the author reports", "criterionReport", (body) => body.outcome?.criteria[0]?.report],
    ["what remains", "What remains", "outcomeRemaining", (body) => body.outcome?.remaining],
    ["the next step", "Reported next step", "outcomeNextStep", (body) => body.outcome?.nextStep],
  ].map(([name, label, limit, value]) => ({
    name,
    label,
    limit,
    submit: "Save result",
    operation: "task_submit_result",
    value,
    async open(page) {
      await page.openTask("T-3");
      await page.click("Add result");
      await page.type(page.field("Result summary"), "Checked by hand.");
      await page.click("Add itemized author report");
      await page.click("Add item");
      await page.input("Item 1", "Desktop reading");
      if (limit !== "criterionReport") await page.type(page.field("What the author reports"), "Read on a desktop.");
    },
  })),
  {
    name: "a dispatch's note",
    label: "A note",
    limit: "dispatchNote",
    submit: "Assign and send",
    operation: "task_dispatch",
    value: (body) => body.body,
    async open(page) {
      await page.openTask("T-3");
      await page.click("Give to agent");
    },
  },
  ...[
    ["an edited description", "Description", "taskDescription", (body) => body.patch?.description],
    ["the latest progress", "Latest progress", "taskProgress", (body) => body.patch?.progress],
    ["what is in the way", "What’s in the way?", "taskBlocker", (body) => body.patch?.blocker],
  ].map(([name, label, limit, value]) => ({
    name,
    label,
    limit,
    submit: "Save changes",
    operation: "task_update",
    value,
    async open(page) {
      await page.openTask("T-3");
      await page.click("Edit task");
    },
  })),
  {
    name: "a comment",
    label: "Add a note",
    limit: "taskComment",
    submit: "Add note",
    operation: "task_comment",
    value: (body) => body.body,
    sends: true,
    async open(page) {
      await page.openTask("T-3");
    },
  },
];

test("a long paste in each of the task panel's long fields folds into one block and goes whole", async (t) => {
  for (const place of places) {
    const page = mount();
    t.after(page.close);
    await place.open(page);
    const field = await until(() => page.field(place.label), `${place.name}'s field`);
    const limit = page.window.coreLimits[place.limit];
    const { text, deep } = pasted(Math.min(limit.max, 20_000));
    assert.ok(utf8(text) <= limit.max, `${place.name}: the paste is within Core's limit`);
    // An edited task's description has its text already: the paste replaces it.
    await page.type(field, "");
    await page.paste(field, text);
    assert.equal(page.chips(field).length, 1, `${place.name}: the paste is one block`);
    assert.ok(!page.box(field).textContent.includes(deep), `${place.name}: the whole text is not drawn`);
    await page.click(place.submit);
    const sent = await until(() => page.sent(place.operation).at(-1), `${place.name} sent`);
    const value = place.value(sent.body);
    assert.ok(value === text, `${place.name}: the paste goes byte for byte (${utf8(value ?? "")} of ${utf8(text)} bytes sent)`);
    assert.deepEqual(page.errors, [], place.name);
  }
});

test("each field takes exactly Core's limit, and one byte over says so, sends nothing and keeps the text", async (t) => {
  for (const place of places) {
    const page = mount();
    t.after(page.close);
    await place.open(page);
    const field = await until(() => page.field(place.label), `${place.name}'s field`);
    const limit = page.window.coreLimits[place.limit];
    assert.equal(limit.unit, "bytes", place.name);
    const over = exactly(limit.max + 1);
    await page.type(field, over);
    const note = page.note(field);
    assert.ok(note?.hasAttribute("data-over"), `${place.name}: the field says it is over`);
    assert.match(note.textContent, /^1 byte too long/, `${place.name}: by how much`);
    assert.equal(field.getAttribute("aria-invalid"), "true", place.name);
    assert.ok(field.getAttribute("aria-describedby")?.split(" ").includes(note.parentElement.id), `${place.name}: the note describes the field`);
    assert.equal(page.button(place.submit).disabled, true, `${place.name}: its button waits`);
    // The keys submit as the button would: not while it waits.
    await page.key(field, { key: "Enter", ctrlKey: true });
    if (place.sends) await page.key(field, { key: "Enter" });
    assert.equal(page.sent(place.operation).length, 0, `${place.name}: nothing is sent`);
    assert.equal(composerText(field), over, `${place.name}: what was written is kept`);
    // Exactly the limit goes.
    await page.type(field, exactly(limit.max));
    assert.ok(!page.note(field)?.hasAttribute("data-over"), `${place.name}: at the limit, not over`);
    assert.match(page.note(field).textContent, /^0 bytes left/, place.name);
    await page.click(place.submit);
    const sent = await until(() => page.sent(place.operation).at(-1), `${place.name} sent at the limit`);
    assert.equal(utf8(place.value(sent.body)), limit.max, `${place.name}: Core's limit exactly`);
    assert.deepEqual(page.errors, [], place.name);
  }
});

test("Return sends a comment as the conversation does, and makes a new line where the form edits", async (t) => {
  const page = mount();
  t.after(page.close);
  await page.openTask("T-3");
  const comment = await until(() => page.field("Add a note"), "the comment field");
  await page.type(comment, "选");
  comment.dispatchEvent(new page.window.CompositionEvent("compositionstart", { bubbles: true }));
  await page.key(comment, { key: "Enter", isComposing: true });
  await page.key(comment, { key: "Enter", keyCode: 229 });
  assert.equal(page.sent("task_comment").length, 0, "the input method's Return is its own");
  comment.dispatchEvent(new page.window.CompositionEvent("compositionend", { bubbles: true }));
  await tick();
  await page.key(comment, { key: "Enter", shiftKey: true });
  assert.equal(page.sent("task_comment").length, 0, "Shift+Return is a new line");
  await page.type(comment, "Looks right to me.");
  await page.key(comment, { key: "Enter" });
  const sent = await until(() => page.sent("task_comment")[0], "the comment sent");
  assert.equal(sent.body.body, "Looks right to me.");

  await page.click("Edit task");
  const progress = await until(() => page.field("Latest progress"), "the progress field");
  await page.type(progress, "Step one");
  await page.key(progress, { key: "Enter" });
  assert.equal(composerText(progress), "Step one\n", "Return makes a new line");
  assert.equal(page.sent("task_update").length, 0, "and saves nothing");
  progress.dispatchEvent(new page.window.CompositionEvent("compositionstart", { bubbles: true }));
  await page.key(progress, { key: "Enter", ctrlKey: true, isComposing: true });
  assert.equal(page.sent("task_update").length, 0, "the input method's Return is its own");
  progress.dispatchEvent(new page.window.CompositionEvent("compositionend", { bubbles: true }));
  // CodeMirror takes JSDOM for Safari, where a key within 100 ms of the
  // composition's end is still the input method's.
  await tick(150);
  await page.key(progress, { key: "Enter", ctrlKey: true });
  const saved = await until(() => page.sent("task_update")[0], "Ctrl+Return saved the task");
  assert.equal(saved.body.patch.progress, "Step one");
  assert.deepEqual(page.errors, []);
});

test("a result whose itemized report is empty is not saved, and the report says why", async (t) => {
  const page = mount();
  t.after(page.close);
  await page.openTask("T-3");
  await page.click("Add result");
  await page.type(page.field("Result summary"), "Checked by hand.");
  await page.click("Add itemized author report");
  await page.click("Add item");
  await page.input("Item 1", "Desktop reading");
  const report = page.field("What the author reports");
  assert.equal(report.getAttribute("aria-required"), "true");
  await page.click("Save result");
  assert.equal(page.sent("task_submit_result").length, 0, "nothing is saved");
  assert.equal(page.document.activeElement, report, "the empty report has focus");
  assert.equal(report.getAttribute("aria-invalid"), "true");
  assert.match(page.box(report).querySelector('[role="alert"]').textContent, /Write what the author reports/);
  await page.type(report, "Read on a desktop.");
  assert.equal(page.box(report).querySelector('[role="alert"]'), null, "written, it no longer says so");
  await page.click("Save result");
  const sent = await until(() => page.sent("task_submit_result")[0], "the result saved");
  assert.equal(sent.body.outcome.criteria[0].report, "Read on a desktop.");
  assert.deepEqual(page.errors, []);
});

// Each number is Core's, read from the Rust line that checks the field.
test("each long field's limit is the one Core checks", async (t) => {
  const page = mount();
  t.after(page.close);
  const rust = async (file) => readFile(path.join(root, "../core/src", file), "utf8");
  const store = await rust("collaboration_store.rs");
  const dispatch = await rust("collaboration_store/dispatch_materials.rs");
  const outcome = await rust("collaboration_store/result_outcome.rs");
  const one = (source, pattern, what) => {
    const found = [...source.matchAll(pattern)];
    assert.equal(found.length, 1, `one Rust line for ${what}`);
    return Number(found[0][1].replaceAll("_", ""));
  };
  const core = {
    taskDescription: one(store, /const MAX_DESCRIPTION: usize = ([\d_]+);/g, "the description"),
    resultSummary: one(store, /required_text\(input, "summary", ([\d_]+)\)/g, "a result's summary"),
    taskComment: one(store, /required_text\(input, "body", ([\d_]+)\)/g, "a comment"),
    taskProgress: one(store, /optional_text\(patch, "progress", ([\d_]+)\)/g, "the progress"),
    taskBlocker: one(store, /optional_text\(patch, "blocker", ([\d_]+)\)/g, "the blocker"),
    dispatchNote: one(dispatch, /optional_text\(input, "body", ([\d_]+)\)/g, "a dispatch's note"),
    criterionReport: one(outcome, /required_text\(criterion, "report", ([\d_]+)\)/g, "a criterion's report"),
    outcomeRemaining: one(outcome, /\("remaining", ([\d_]+)\)/g, "what remains"),
    outcomeNextStep: one(outcome, /\("nextStep", ([\d_]+)\)/g, "the next step"),
  };
  // Core measures these with str::len: UTF-8 bytes.
  assert.match(store, /value\.len\(\) <= max/);
  for (const [key, max] of Object.entries(core)) {
    assert.equal(page.window.coreLimits[key].max, max, `${key} is Core's ${max}`);
    assert.equal(page.window.coreLimits[key].unit, "bytes", key);
  }
});

// The three dialogs' long fields (YN-106 PR 2): /review's instructions,
// the Codex goal's objective and a PR's body.
const agent = { id: "a", name: "Mori", harness: "codex", status: "idle", cwd: "/w", model: "m", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const goalAnswer = (route, method, body) => {
  if (route !== "/api/agents/a/codex/goal") return undefined;
  return method === "GET"
    ? { state: "ready", reason: "", goal: null }
    : { goal: { objective: body.objective, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } };
};
const prAnswer = (route, method) => {
  if (route === "/api/pr-operations" && method === "GET") return { operations: [], repositories: [{ id: 7, fullName: "owner/repo" }], hasMore: false, nextBefore: null };
  if (route === "/api/pr-operations" && method === "POST") return { id: "operation-1", status: "queued" };
  return undefined;
};
const dialogs = [
  {
    name: "/review's instructions",
    label: "Instructions",
    limit: "reviewInstructions",
    submit: "Start review",
    sent: (page) => page.calls.filter((c) => c.operation === "POST /api/agents/a/codex/review").map((c) => c.body.target.instructions),
    async open() {
      const page = mount({ part: "CodexReviewDialog", props: { agent, open: true, onOpenChange() {}, onStarted() {} },
        answer: (route) => (route === "/api/agents/a/codex/review" ? { accepted: true, turnId: "t2" } : undefined) });
      await until(() => [...page.document.querySelectorAll('[role="radio"], input[type="radio"]')].length, "the review choices");
      const custom = page.document.querySelector('input[type="radio"][value="custom"]');
      custom.click();
      await tick();
      return page;
    },
  },
  {
    name: "the Codex goal's objective",
    label: "Objective",
    limit: "goalObjective",
    submit: "Set and start",
    sent: (page) => page.calls.filter((c) => c.operation === "POST /api/agents/a/codex/goal").map((c) => c.body.objective),
    async open(initialObjective = "") {
      const page = mount({ part: "CodexGoalDialog", props: { agent, open: true, initialObjective, onOpenChange() {}, onChanged() {} }, answer: goalAnswer });
      await until(() => page.field("Objective"), "the goal read");
      return page;
    },
  },
  {
    name: "a PR's body",
    label: "PR body",
    limit: "prBody",
    submit: "Create or reuse PR",
    sent: (page) => page.calls.filter((c) => c.operation === "POST /api/pr-operations").map((c) => c.body.body),
    async open() {
      const page = mount({ part: "PrOperations", props: { taskId: "T-1", disabled: false }, answer: prAnswer });
      const repository = await until(() => page.document.querySelector('select[aria-label="PR repository"] option[value="7"]')?.parentElement, "the repositories");
      Object.getOwnPropertyDescriptor(page.window.HTMLSelectElement.prototype, "value").set.call(repository, "7");
      repository.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      // The PR form's labels hold their input directly.
      for (const [name, value] of [["Head branch", "feature"], ["PR title", "Ship it"]]) {
        const input = [...page.document.querySelectorAll(".pr-operations label")].find((l) => l.textContent.startsWith(name)).querySelector("input");
        Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      }
      await tick();
      return page;
    },
  },
];
const submitButton = (page, name) =>
  [...page.document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(name) && !b.closest(".long-text-field"));

test("a long paste in each dialog's long field folds into one block and goes whole", async (t) => {
  for (const place of dialogs) {
    const page = await place.open();
    t.after(page.close);
    const field = await page.editor(place.label);
    // Within the limit in its own unit: a character is at least a byte.
    const limit = page.window.coreLimits[place.limit];
    const { text, deep } = pasted(Math.min(limit.max, 20_000));
    await page.paste(field, text);
    assert.equal(page.chips(field).length, 1, `${place.name}: the paste is one block`);
    assert.ok(!page.box(field).textContent.includes(deep), `${place.name}: the whole text is not drawn`);
    submitButton(page, place.submit).click();
    const sent = await until(() => place.sent(page)[0], `${place.name} sent`);
    // /review and the goal go trimmed; this paste has nothing to trim.
    assert.ok(sent === text, `${place.name}: the paste goes byte for byte (${utf8(sent)} of ${utf8(text)} bytes)`);
    assert.deepEqual(page.errors, [], place.name);
  }
});

test("each dialog takes exactly Core's limit, in Core's unit; one over says so and sends nothing", async (t) => {
  for (const place of dialogs) {
    const page = await place.open();
    t.after(page.close);
    const field = await page.editor(place.label);
    const limit = page.window.coreLimits[place.limit];
    // Codex counts characters: "é" is one, and two bytes.
    const exact = limit.unit === "chars" ? "é".repeat(limit.max) : exactly(limit.max);
    const over = limit.unit === "chars" ? "é".repeat(limit.max + 1) : exactly(limit.max + 1);
    await page.type(field, over);
    const note = page.note(field);
    assert.ok(note?.hasAttribute("data-over"), `${place.name}: the field says it is over`);
    assert.match(note.textContent, limit.unit === "chars" ? /^1 character too long/ : /^1 byte too long/, place.name);
    assert.equal(submitButton(page, place.submit).disabled, true, `${place.name}: its button waits`);
    await page.key(field, { key: "Enter", ctrlKey: true });
    await page.key(field, { key: "Enter" });
    assert.deepEqual(place.sent(page), [], `${place.name}: nothing is sent`);
    assert.equal(composerText(field).replace(/\n$/, ""), over, `${place.name}: what was written is kept`);
    await page.type(field, exact);
    assert.ok(!page.note(field)?.hasAttribute("data-over"), `${place.name}: at the limit, not over`);
    submitButton(page, place.submit).click();
    const sent = await until(() => place.sent(page)[0], `${place.name} sent at the limit`);
    assert.equal(sent, exact, `${place.name}: Core's limit exactly`);
    assert.deepEqual(page.errors, [], place.name);
  }
});

test("Return starts a review as a message sends; in the goal and a PR's body it makes a new line", async (t) => {
  const review = await dialogs[0].open();
  t.after(review.close);
  const instructions = await review.editor("Instructions");
  await review.type(instructions, "Look at the error paths");
  await review.key(instructions, { key: "Enter" });
  assert.deepEqual(await until(() => dialogs[0].sent(review).length && dialogs[0].sent(review), "the review started"), ["Look at the error paths"]);
  for (const place of dialogs.slice(1)) {
    const page = await place.open();
    t.after(page.close);
    const field = await page.editor(place.label);
    await page.type(field, "First line");
    await page.key(field, { key: "Enter" });
    assert.equal(composerText(field), "First line\n", `${place.name}: Return makes a new line`);
    assert.deepEqual(place.sent(page), [], `${place.name}: and sends nothing`);
    await page.key(field, { key: "Enter", ctrlKey: true });
    const sent = await until(() => place.sent(page)[0], `${place.name}: Ctrl+Return sent it`);
    assert.equal(sent.trimEnd(), "First line", place.name);
  }
});

test("an objective that came with /goal longer than Codex takes says so at once and sets nothing", async (t) => {
  const place = dialogs[1];
  const page = await place.open("x".repeat(4_001));
  t.after(page.close);
  const field = await page.editor("Objective");
  const note = await until(() => page.note(field), "the note");
  assert.ok(note.hasAttribute("data-over"));
  assert.match(note.textContent, /^1 character too long: this field takes at most 4,000 characters/);
  assert.equal(submitButton(page, "Set and start").disabled, true, "Set and start waits, and says why beside it");
  await page.key(field, { key: "Enter", ctrlKey: true });
  assert.deepEqual(place.sent(page), []);
  assert.deepEqual(page.errors, []);
});

test("each dialog's limit is the one Core checks, in Core's unit", async (t) => {
  const page = mount();
  t.after(page.close);
  const rust = async (file) => readFile(path.join(root, "../core/src", file), "utf8");
  const model = await rust("model.rs");
  const goal = await rust("codex_goal.rs");
  const pr = await rust("pr_operations/mod.rs");
  const one = (source, pattern, what) => {
    const found = [...source.matchAll(pattern)];
    assert.equal(found.length, 1, `one Rust line for ${what}`);
    return Number(found[0][1].replaceAll("_", ""));
  };
  const { coreLimits } = page.window;
  assert.equal(coreLimits.reviewInstructions.max, one(model, /instructions\.len\(\) <= ([\d_]+)/g, "/review's instructions"));
  assert.equal(coreLimits.reviewInstructions.unit, "bytes");
  assert.equal(coreLimits.goalObjective.max, one(goal, /pub const MAX_OBJECTIVE_CHARS: usize = ([\d_]+);/g, "the goal's objective"));
  assert.match(goal, /objective\.chars\(\)\.count\(\) <= MAX_OBJECTIVE_CHARS/, "Codex's limit is in characters");
  assert.equal(coreLimits.goalObjective.unit, "chars");
  assert.equal(coreLimits.prBody.max, one(pr, /self\.body\.len\(\) <= ([\d_]+)/g, "a PR's body"));
  assert.equal(coreLimits.prBody.unit, "bytes");
});

// One-line fields (YN-106 PR 3): a name or a title is counted in the bytes
// Core counts. 100 Chinese characters are 300 bytes: a task's title takes
// them; with one more Core would refuse it, so the page says so and sends
// nothing. Nothing cuts a paste short.
test("a task's title is counted in bytes as Core counts them: 100 Chinese characters go, 101 do not", async (t) => {
  const page = mount();
  t.after(page.close);
  const titleInput = () =>
    [...page.document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent.trim() === "Task title")?.querySelector("input");
  const overNote = () => titleInput()?.closest("label").nextElementSibling?.querySelector(".home-reply-length[data-over]");
  await page.click("New task");
  await page.input("Task title", "长".repeat(101));
  assert.equal(titleInput().maxLength, -1, "no limit of its own: a paste is never cut short");
  assert.equal(titleInput().getAttribute("aria-invalid"), "true");
  assert.match(overNote()?.textContent ?? "", /^3 bytes too long: this field takes at most 300 bytes/);
  assert.equal(page.button("Create task").disabled, true);
  titleInput().form.requestSubmit();
  await tick();
  assert.equal(page.sent("task_create").length, 0, "nothing is sent");
  await page.input("Task title", "长".repeat(100));
  assert.ok(!overNote(), "at the limit, nothing to say");
  await page.click("Create task");
  const created = await until(() => page.sent("task_create")[0], "the task created");
  assert.equal(created.body.title, "长".repeat(100));

  await page.openTask("T-3");
  await page.click("Edit task");
  await page.input("Task title", "长".repeat(101));
  assert.equal(page.button("Save changes").disabled, true, "an edited title too");
  titleInput().form.requestSubmit();
  await tick();
  assert.equal(page.sent("task_update").length, 0);
  await page.input("Task title", "长".repeat(100));
  await page.click("Save changes");
  const saved = await until(() => page.sent("task_update")[0], "the title saved");
  assert.equal(saved.body.patch.title, "长".repeat(100));
  assert.deepEqual(page.errors, []);
});

// Each number is the one in the Rust line that checks the field, and Core
// counts it with str::len, in bytes.
test("each one-line field's limit is the one Core checks", async (t) => {
  const page = mount();
  t.after(page.close);
  const rust = async (file) => readFile(path.join(root, "../core/src", file), "utf8");
  const one = async (file, pattern, what) => {
    const found = [...(await rust(file)).matchAll(pattern)];
    assert.equal(found.length, 1, `one Rust line in ${file} for ${what}`);
    return Number(found[0][1].replaceAll("_", ""));
  };
  const core = {
    taskTitle: await one("collaboration_store.rs", /const MAX_TITLE: usize = ([\d_]+);/g, "a task's title"),
    criterionLabel: await one("collaboration_store/result_outcome.rs", /required_text\(criterion, "label", ([\d_]+)\)/g, "a criterion's label"),
    prTitle: await one("pr_operations/mod.rs", /self\.title\.len\(\) <= ([\d_]+)/g, "a PR's title"),
    prBranch: await one("pr_operations/mod.rs", /\bs\.len\(\) <= ([\d_]+)/g, "a PR's branch"),
    reviewName: await one("model.rs", /value\.len\(\) <= ([\d_]+)/g, "a branch or commit to review"),
    jobName: await one("jobs/mod.rs", /self\.name\.len\(\) <= ([\d_]+)/g, "a Job's name"),
    gpuReason: await one("jobs/gpu.rs", /r\.len\(\) <= ([\d_]+)/g, "a GPU's closing reason"),
    machineName: await one("remote.rs", /"机器名称", &machine\.name, ([\d_]+)\)/g, "a machine's name"),
    projectName: await one("projects.rs", /name\.len\(\) > ([\d_]+)/g, "a project's name"),
    serviceName: await one("services.rs", /name\.len\(\) <= ([\d_]+)/g, "a service's name"),
    mergeReason: await one("merge_queue/mod.rs", /r\.len\(\) <= ([\d_]+)/g, "a revert's reason"),
  };
  // An Agent's name: every way Core makes one checks the same number.
  for (const [file, count] of [["workspace.rs", 1], ["claude.rs", 1], ["opencode_agent.rs", 1], ["codex_sessions.rs", 2], ["claude_sessions.rs", 1]]) {
    const found = [...(await rust(file)).matchAll(/name\.len\(\) (?:>|<=) ([\d_]+)/g)].map((m) => Number(m[1].replaceAll("_", "")));
    assert.equal(found.length, count, `${file}: its Agent name checks`);
    for (const max of found) assert.equal(page.window.coreLimits.agentName.max, max, `${file}: an Agent's name`);
  }
  for (const [key, max] of Object.entries(core)) {
    assert.equal(page.window.coreLimits[key].max, max, `${key} is Core's ${max}`);
    assert.equal(page.window.coreLimits[key].unit, "bytes", key);
  }
});
