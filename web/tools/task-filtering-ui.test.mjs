import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// The task board against an in-memory Core that filters and pages like
// collaboration_store::task_list. No Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "task-filtering-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {CollaborationBoard} from ${JSON.stringify(path.join(root, "src/CollaborationBoard.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderBoard=(props)=>root.render(<CollaborationBoard {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "TaskFilteringUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick(15);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
// CollaborationBoard.tsx's own delay before a workspace revision is acted on.
// Tests that wait on background checks pass fastRevision: that exact delay,
// and no other, then runs at REVISION_FAST_MS, and the test checks it ran.
const REVISION_MS = 600;
const REVISION_FAST_MS = 60;
const user = { kind: "user", id: "user", name: "You" };
const agent = (id, name) => ({
  id, name, harness: "codex", color: "sage", status: "idle", cwd: "/work", goal: "", model: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0,
});
const agents = [agent("dev-1", "Dev 1"), agent("dev-2", "Dev 2")];
const projects = [{ id: "p-app", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const OPEN = ["todo", "doing", "blocked", "review"];

function makeTask(seq, patch = {}) {
  return {
    id: `T-${seq}`, seq, title: `Task ${seq}`, description: "", status: "todo", version: 1,
    assigneeAgentId: null, assignee: null, progress: "", blocker: "", result: null, archivedAt: null,
    projectId: null, createdBy: user, updatedBy: user, createdAt: "", updatedAt: "", ...patch,
  };
}

/** collaboration_store::task_list: filter everything, count everything, then page. */
function taskList(tasks, input) {
  assert.ok(!(input.status && input.statuses), "status and statuses are never sent together");
  const statuses = input.statuses || (input.status ? [input.status] : null);
  const matching = tasks.filter(
    (t) =>
      !t.archivedAt === !input.archived &&
      (!statuses || statuses.includes(t.status)) &&
      (!input.assigneeAgentId || t.assigneeAgentId === input.assigneeAgentId) &&
      (!("projectId" in input) || (input.projectId === null ? !t.projectId : t.projectId === input.projectId)),
  );
  const counts = { todo: 0, doing: 0, blocked: 0, review: 0, done: 0, cancelled: 0 };
  for (const t of matching) counts[t.status]++;
  const after = input.afterSeq || 0;
  const limit = input.limit || 50;
  const rest = matching.filter((t) => t.seq > after);
  const page = rest.slice(0, limit);
  return { tasks: page, counts, hasMore: rest.length > limit, nextAfterSeq: page.at(-1)?.seq ?? after };
}

function mount({ tasks, handler, fastRevision = false } = {}) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const operation = url.split("/").at(-1);
    const call = { operation, body, signal: init.signal };
    calls.push(call);
    let response = await handler?.(operation, body, call);
    if (response === undefined && operation === "task_list") response = taskList(tasks, body);
    if (response === undefined) response = {};
    if (init.signal?.aborted) throw new window.DOMException("The operation was aborted.", "AbortError");
    const status = response.httpStatus || 200;
    const data = response.httpStatus ? { error: response.error } : response;
    const answered = (body) => ((call.answered = true), body);
    return { ok: status < 400, status, json: async () => answered(data), text: async () => answered(JSON.stringify(data)) };
  };
  let revisionDelays = 0;
  if (fastRevision) {
    const windowTimeout = window.setTimeout;
    window.setTimeout = (fn, ms, ...args) =>
      typeof fn === "function" && ms === REVISION_MS
        ? windowTimeout.call(window, (...a) => (revisionDelays++, fn(...a)), REVISION_FAST_MS, ...args)
        : windowTimeout.call(window, fn, ms, ...args);
  }
  window.eval(bundle);
  let revision = 0;
  const props = { open: true, onOpenChange() {}, agents, projects, onOpenAgent() {}, revision };
  const render = (extra = {}) => window.renderBoard({ ...props, revision, ...extra });
  return {
    window, document: window.document, calls, errors, render,
    bump: () => { revision += 1; render(); },
    revisionDelays: () => revisionDelays,
    lists: () => calls.filter((c) => c.operation === "task_list"),
    cards: () => [...window.document.querySelectorAll(".collab-task-card")].map((c) => c.dataset.taskId),
    text: () => window.document.body.textContent,
    close: () => window.close(),
  };
}
const select = (page, label) =>
  [...page.document.querySelectorAll(".collab-filters label")]
    .find((node) => node.querySelector("span")?.textContent.trim() === label)
    .querySelector("select");
async function choose(page, label, value) {
  const node = select(page, label);
  Object.getOwnPropertyDescriptor(page.window.HTMLSelectElement.prototype, "value").set.call(node, value);
  node.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await tick();
}
const button = (page, text) =>
  [...page.document.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
const loaded = (page) => until(() => page.cards().length || /No tasks match|Make room/.test(page.text()), "list");
// A revision's background check over loaded later pages: once the revision
// delay has run, Core's first 200 matching tasks (one request) are compared
// with what is loaded. Waits until a check made after call index `from` was
// answered, then REVISION_FAST_MS more for the board to compare and render.
async function checked(page, from) {
  await until(
    () => page.calls.slice(from).some((c) => c.operation === "task_list" && c.body.limit === 200 && c.answered),
    "the background check answered",
  );
  await tick(REVISION_FAST_MS);
}
function revisionDelaysRan(page, bumps) {
  assert.ok(page.revisionDelays() >= bumps,
    `the ${REVISION_MS} ms revision delay ran at ${REVISION_FAST_MS} ms for each of ${bumps} bumps, not ${page.revisionDelays()} times`);
}

test("a match after the first hundred tasks appears at once, not after loading more", async () => {
  const tasks = Array.from({ length: 150 }, (_, i) =>
    makeTask(i + 1, i + 1 === 140 ? { status: "doing", assigneeAgentId: "dev-2" } : {}));
  const page = mount({ tasks });
  try {
    page.render();
    await loaded(page);
    await choose(page, "Owner", "dev-2");
    await until(() => page.cards().length === 1, "the one match");
    assert.deepEqual(page.cards(), ["T-140"]);
    assert.match(page.text(), /Showing 1 of 1 matching tasks/);
    assert.doesNotMatch(page.text(), /No tasks match/);
    assert.deepEqual(page.lists().at(-1).body, { statuses: OPEN, assigneeAgentId: "dev-2", limit: 100 });
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("137 matches across two pages arrive once each, with the total from Core", async () => {
  const tasks = Array.from({ length: 210 }, (_, i) => {
    const seq = i + 1;
    return makeTask(seq, seq % 3 && seq <= 205 ? { assigneeAgentId: "dev-1", status: OPEN[seq % 4] } : { status: "done" });
  });
  // The list groups Core's order by what a task waits for; with no update
  // times to tell them apart, each group keeps Core's order.
  const core = tasks.filter((t) => t.assigneeAgentId === "dev-1");
  const expected = ["review", "blocked", "doing", "todo"].flatMap((status) =>
    core.filter((t) => t.status === status).map((t) => t.id));
  assert.equal(expected.length, 137);
  const page = mount({ tasks });
  try {
    page.render();
    await loaded(page);
    await choose(page, "Owner", "dev-1");
    await until(() => page.cards().length === 100, "first page");
    assert.match(page.text(), /Showing 100 of 137 matching tasks/);
    button(page, "Load more tasks").click();
    await until(() => page.cards().length === 137, "second page");
    assert.deepEqual(page.cards(), expected, "grouped in Core's order, no duplicates, none missing");
    assert.match(page.text(), /Showing 137 of 137 matching tasks/);
    assert.ok(button(page, "Load more tasks") === undefined, 'no "Load more tasks" button');
    const second = page.lists().at(-1).body;
    // Core pages in its own order: the cursor is its hundredth match.
    assert.equal(second.afterSeq, core[99].seq);
    assert.equal(second.assigneeAgentId, "dev-1", "every page uses the same conditions");
  } finally {
    page.close();
  }
});

test("each status choice, owner and project are sent to Core together", async () => {
  const tasks = [makeTask(1), makeTask(2, { status: "done", projectId: "p-app", assigneeAgentId: "dev-1" })];
  const page = mount({ tasks });
  try {
    page.render();
    await loaded(page);
    assert.deepEqual(page.lists().at(-1).body, { statuses: OPEN, limit: 100 }, "Open tasks");
    await choose(page, "Show", "all");
    await loaded(page);
    assert.deepEqual(page.lists().at(-1).body, { limit: 100 });
    await choose(page, "Show", "done");
    await choose(page, "Owner", "dev-1");
    await choose(page, "Project", "project:p-app");
    await until(() => page.cards().length === 1, "done task in App");
    assert.deepEqual(page.lists().at(-1).body, { status: "done", assigneeAgentId: "dev-1", projectId: "p-app", limit: 100 });
    await choose(page, "Project", "none");
    await until(() => /No tasks match these filters/.test(page.text()), "empty");
    assert.deepEqual(page.lists().at(-1).body, { status: "done", assigneeAgentId: "dev-1", projectId: null, limit: 100 });
    // Clearing every filter.
    await choose(page, "Show", "all");
    await choose(page, "Owner", "");
    await choose(page, "Project", "all");
    await until(() => page.cards().length === 2, "everything");
    assert.deepEqual(page.lists().at(-1).body, { limit: 100 });
    assert.match(page.text(), /Showing 2 of 2 tasks/);
  } finally {
    page.close();
  }
});

test("a slower earlier request cannot replace a newer one, nor show its error or end its loading", async () => {
  const tasks = [makeTask(1, { assigneeAgentId: "dev-1" }), makeTask(2, { assigneeAgentId: "dev-2" })];
  const gates = {};
  const page = mount({
    tasks,
    handler: (operation, body) => {
      const key = body.assigneeAgentId;
      if (operation !== "task_list" || !key) return undefined;
      return new Promise((resolve) => (gates[key] = resolve));
    },
  });
  try {
    page.render();
    await loaded(page);
    await choose(page, "Owner", "dev-1");
    await choose(page, "Owner", "dev-2");
    // The older dev-1 request fails late; the newer dev-2 one is still loading.
    gates["dev-1"]({ httpStatus: 500, error: "dev-1 request failed" });
    await tick(60);
    assert.doesNotMatch(page.text(), /dev-1 request failed/);
    assert.match(page.text(), /Gathering your tasks/, "still loading the current conditions");
    assert.doesNotMatch(page.text(), /No tasks match/);
    gates["dev-2"](taskList(tasks, { assigneeAgentId: "dev-2", statuses: OPEN, limit: 100 }));
    await until(() => page.cards().length === 1, "dev-2 result");
    assert.deepEqual(page.cards(), ["T-2"]);
    // A slow success for old conditions is ignored too.
    await choose(page, "Owner", "dev-1");
    await choose(page, "Owner", "dev-2");
    gates["dev-2"](taskList(tasks, { assigneeAgentId: "dev-2", statuses: OPEN, limit: 100 }));
    await until(() => page.cards().length === 1, "newest");
    gates["dev-1"](taskList(tasks, { assigneeAgentId: "dev-1", statuses: OPEN, limit: 100 }));
    await tick(60);
    assert.deepEqual(page.cards(), ["T-2"]);
    assert.ok(page.lists().filter((c) => c.body.assigneeAgentId === "dev-1").every((c) => c.signal?.aborted),
      "superseded requests are aborted");
  } finally {
    page.close();
  }
});

test("changing filters while more tasks load starts over without the old page", async () => {
  const tasks = Array.from({ length: 150 }, (_, i) => makeTask(i + 1, { status: i % 2 ? "todo" : "doing" }));
  let release;
  const page = mount({
    tasks,
    handler: (operation, body) =>
      operation === "task_list" && body.afterSeq
        ? new Promise((resolve) => (release = () => resolve(taskList(tasks, body))))
        : undefined,
  });
  try {
    page.render();
    await until(() => page.cards().length === 100, "first page of open tasks");
    button(page, "Load more tasks").click();
    await tick();
    await choose(page, "Show", "doing");
    await until(() => page.cards().length === 75, "doing only");
    release();
    await tick(60);
    assert.equal(page.cards().length, 75, "the late page for Open tasks never joins");
    assert.ok(page.cards().every((id) => Number(id.slice(2)) % 2 === 1));
    assert.match(page.text(), /Showing 75 of 75 matching tasks/);
  } finally {
    page.close();
  }
});

test("background updates keep loaded pages and say when Core's list really changed", async () => {
  const tasks = Array.from({ length: 137 }, (_, i) => makeTask(i + 1));
  const page = mount({ tasks, fastRevision: true });
  try {
    page.render();
    await until(() => page.cards().length === 100, "first page");
    // With one page loaded, a workspace update simply reloads it.
    const before = page.lists().length;
    page.bump();
    await until(() => page.lists().length > before, "silent reload", 2000);
    assert.doesNotMatch(page.text(), /Tasks changed/);
    button(page, "Load more tasks").click();
    await until(() => page.cards().length === 137, "both pages");
    // Revisions without task changes (the 5 s poll) leave everything alone.
    const quiet = page.calls.length;
    page.bump();
    await checked(page, quiet);
    assert.equal(page.cards().length, 137);
    assert.doesNotMatch(page.text(), /Tasks changed/);
    // A real change: later pages stay, and the user is told.
    tasks[3] = { ...tasks[3], version: 2, title: "Renamed elsewhere" };
    page.bump();
    await until(() => /Tasks changed since these pages loaded/.test(page.text()), "notice", 2000);
    assert.equal(page.cards().length, 137, "nothing dropped silently");
    button(page, "Refresh tasks").click();
    await until(() => page.cards().length === 100 && !/Tasks changed/.test(page.text()), "refreshed");
    assert.match(page.text(), /Renamed elsewhere/);
    revisionDelaysRan(page, 3);
  } finally {
    page.close();
  }
});

test("a saved task that leaves the filter goes, and the counts follow", async () => {
  const tasks = Array.from({ length: 120 }, (_, i) => makeTask(i + 1, { status: "doing" }));
  const page = mount({
    tasks,
    handler: (operation, body) => {
      if (operation === "task_get")
        return { task: tasks.find((t) => t.id === body.taskId), activities: [], executions: [], hasMore: false };
      if (operation === "task_update") {
        const index = tasks.findIndex((t) => t.id === body.taskId);
        tasks[index] = { ...tasks[index], ...body.patch, version: tasks[index].version + 1 };
        return { task: tasks[index], activity: {} };
      }
      return undefined;
    },
  });
  try {
    page.render();
    await until(() => page.cards().length === 100, "first page");
    button(page, "Load more tasks").click();
    await until(() => page.cards().length === 120, "both pages");
    page.document.querySelector('[data-task-id="T-110"]').click();
    await until(() => button(page, "Edit task"), "task pane");
    button(page, "Edit task").click();
    await tick();
    const status = [...page.document.querySelectorAll(".collab-detail select")][0];
    Object.getOwnPropertyDescriptor(page.window.HTMLSelectElement.prototype, "value").set.call(status, "done");
    status.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await tick();
    button(page, "Save changes").click();
    await until(() => !page.cards().includes("T-110"), "removed from Open tasks");
    assert.equal(page.cards().length, 119, "the other loaded pages stay");
    assert.match(page.text(), /Showing 119 of 119 matching tasks/);
  } finally {
    page.close();
  }
});

test("an empty result appears only once Core has answered", async () => {
  let release;
  const page = mount({
    tasks: [makeTask(1, { status: "done" })],
    handler: (operation, body) =>
      operation === "task_list" && body.statuses
        ? new Promise((resolve) => (release = () => resolve(taskList([], body))))
        : undefined,
  });
  try {
    page.render();
    await tick(80);
    assert.match(page.text(), /Gathering your tasks/);
    assert.doesNotMatch(page.text(), /No tasks match|Make room/);
    release();
    await until(() => /No tasks match these filters/.test(page.text()), "true empty");
    await choose(page, "Show", "all");
    await until(() => page.cards().length === 1, "the done task under All");
  } finally {
    page.close();
  }
});

test("changes on loaded later pages are flagged; beyond Core's 200-task check they wait for Refresh", async () => {
  const tasks = Array.from({ length: 260 }, (_, i) => makeTask(i + 1));
  const page = mount({ tasks, fastRevision: true });
  try {
    page.render();
    await until(() => page.cards().length === 100, "first page");
    button(page, "Load more tasks").click();
    await until(() => page.cards().length === 200, "second page");
    // A title edit on the second page changes only that task's version.
    tasks[149] = { ...tasks[149], version: 2, title: "Second-page rename" };
    page.bump();
    await until(() => /Tasks changed since these pages loaded/.test(page.text()), "edit on page 2", 2000);
    button(page, "Refresh tasks").click();
    await until(() => page.cards().length === 100 && !/Tasks changed/.test(page.text()), "refreshed");
    button(page, "Load more tasks").click();
    await until(() => page.cards().length === 200, "second page again");
    assert.match(page.text(), /Second-page rename/);
    // Archiving a loaded second-page task changes Core's counts.
    tasks[179] = { ...tasks[179], archivedAt: "2026-10-13T00:00:00Z", version: 2 };
    page.bump();
    await until(() => /Tasks changed since these pages loaded/.test(page.text()), "removal on page 2", 2000);
    assert.ok(page.cards().includes("T-180"), "still shown until the user refreshes");
    button(page, "Refresh tasks").click();
    await until(() => !/Tasks changed/.test(page.text()) && page.cards().length === 100, "refreshed again");
    button(page, "Load more tasks").click();
    await until(() => page.cards().length === 200, "two pages");
    button(page, "Load more tasks").click();
    await until(() => page.cards().length === 259, "third page");
    // Known limit: an edit beyond the first 200 tasks keeps the counts, so it
    // is not flagged; the refresh button shows it.
    tasks[249] = { ...tasks[249], version: 2, title: "Third-page rename" };
    const third = page.calls.length;
    page.bump();
    await checked(page, third);
    assert.doesNotMatch(page.text(), /Tasks changed/);
    page.document.querySelector('[aria-label="Refresh tasks"]').click();
    await until(() => page.cards().length === 100, "explicit refresh");
    revisionDelaysRan(page, 3);
  } finally {
    page.close();
  }
});

test("an existing empty result keeps its Create button and focus through background reloads", async () => {
  let hold = false;
  let release;
  const page = mount({
    fastRevision: true,
    tasks: [makeTask(1, { status: "done" })],
    handler: (operation, body) =>
      operation === "task_list" && hold
        ? new Promise((resolve) => (release = () => resolve(taskList([makeTask(1, { status: "done" })], body))))
        : undefined,
  });
  try {
    page.render();
    await until(() => /No tasks match these filters/.test(page.text()), "empty Open tasks");
    const create = button(page, "Create a task");
    create.focus();
    assert.ok(page.document.activeElement === create, "the Create a task button has focus");
    // The 5 s poll reloads the only page; hold that request open.
    hold = true;
    const before = page.lists().length;
    page.bump();
    await until(() => page.lists().length > before, "background reload started", 2000);
    await tick(80);
    assert.ok(create.isConnected, "the same button stays while Core is asked again");
    assert.ok(page.document.activeElement === create, "keyboard focus stays on it");
    assert.match(page.text(), /No tasks match these filters/);
    assert.doesNotMatch(page.text(), /Gathering your tasks/, "no flicker to a loading state");
    hold = false;
    release();
    await tick(80);
    assert.ok(create.isConnected);
    assert.ok(page.document.activeElement === create, "focus stays on the Create a task button");
    assert.ok(button(page, "Create a task") === create, "Create a task is still the same button");
    revisionDelaysRan(page, 1);
  } finally {
    page.close();
  }
});

test("new conditions still wait for Core before saying nothing matches", async () => {
  let release;
  const tasks = [makeTask(1, { status: "done" })];
  const page = mount({
    tasks,
    handler: (operation, body) =>
      operation === "task_list" && body.status === "blocked"
        ? new Promise((resolve) => (release = () => resolve(taskList(tasks, body))))
        : undefined,
  });
  try {
    page.render();
    await loaded(page);
    await choose(page, "Show", "all");
    await until(() => page.cards().length === 1, "the done task");
    await choose(page, "Show", "blocked");
    await tick(80);
    assert.match(page.text(), /Gathering your tasks/);
    assert.doesNotMatch(page.text(), /No tasks match/, "no empty state from the previous conditions");
    assert.deepEqual(page.cards(), [], "and no cards from them either");
    release();
    await until(() => /No tasks match these filters/.test(page.text()), "real empty answer");
  } finally {
    page.close();
  }
});
