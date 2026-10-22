import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// The task board (T-119) in the built app against an in-memory Core: tasks
// grouped by what they wait for, one line on where each stands, the detail's
// order and its Delivery section, and how the detail opens and closes.
const dist = pathToFileURL(resolve(process.env.YUZUNO_UI_DIST || "dist") + "/");
const html = await readFile(new URL("index.html", dist), "utf8");
const bundle = await uiTestBundle(new URL(html.match(/src="\/(assets\/[^" ]+\.js)"/)[1], dist));
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, message, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await pause(25);
  assert.ok(predicate(), message);
}

const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
const person = { kind: "user", id: "user", name: "You" };
const pr = (number, state, ci = "success", sameHead = true) => ({
  id: `7:pull:${number}`, repositoryId: 7, repository: "owner/repo", kind: "pull", number,
  url: `https://github.com/owner/repo/pull/${number}`, syncedAt: new Date().toISOString(), stale: false, error: null,
  snapshot: {
    title: `PR ${number}`, state, headSha: "a".repeat(40), headBranch: "feature", baseBranch: "main",
    ci: { state: ci, headSha: (sameHead ? "a" : "b").repeat(40), complete: true, observedAt: new Date().toISOString(), checks: [] },
  },
});
const task = (id, patch) => ({
  id, title: `Task ${id}`, description: "", status: "todo", version: 1, projectId: "p",
  progress: "", blocker: "", result: null, github: [],
  createdAt: ago(5000), updatedAt: ago(60), createdBy: person, updatedBy: person, ...patch,
});
const earlier = { summary: "**Earlier** round's delivery", links: [], reportedAt: ago(3000), reportedBy: person };
const fixture = () => [
  // Core's order is creation order; the list regroups it.
  task("T-1", { status: "todo", description: "Write the guide.\n\nThen the examples.", progress: "Last slice done", result: earlier, updatedAt: ago(180) }),
  task("T-2", {
    status: "doing", progress: "Halfway through `parsing`", result: earlier, updatedAt: ago(60), description: "Parse the files",
    github: [pr(9, "open", "success", false), pr(8, "merged"), pr(7, "merged")],
  }),
  task("T-3", { status: "doing", updatedAt: ago(10) }),
  task("T-4", {
    status: "review", description: "Ship it", updatedAt: ago(300),
    result: { summary: "Delivered as [PR 12](https://github.com/owner/repo/pull/12).", links: [], reportedAt: ago(300), reportedBy: person },
  }),
  task("T-5", { status: "blocked", blocker: "Waiting on the signing keys", updatedAt: ago(2880) }),
];

async function mount({ reduceMotion = false } = {}) {
  const errors = [];
  const calls = [];
  const tasks = fixture();
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4491/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  w.matchMedia = (media) => ({ media, matches: reduceMotion && /reduced-motion: reduce/.test(media), addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.EventSource = class { addEventListener() {} close() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  const project = { id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" };
  const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
  w.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    if (url.endsWith("/workspace")) return response({ workspace: { id: "fixture" }, agents: [], projects: [project], runtime: { connected: false }, defaultCwd: "/fixture" });
    if (url.endsWith("/catchup")) return response({ items: [], coverage: {} });
    if (url.endsWith("/machines")) return response({ machines: [] });
    if (url.endsWith("/task_list")) return response({ tasks, counts: { todo: 1, doing: 2, review: 1, blocked: 1 }, hasMore: false });
    if (url.endsWith("/task_get")) return response({ task: tasks.find((t) => t.id === body.taskId), activities: [], executions: [], hasMore: false });
    if (url.includes("/github_")) {
      const own = tasks.find((t) => t.id === body.taskId);
      return response({ links: own?.github || [], repositories: [], refreshing: false });
    }
    return response({});
  };
  const doc = w.document;
  const button = (text, scope = doc) => [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  try {
    w.eval(bundle);
    await waitFor(() => { const b = button("Tasks & messages"); return b && !b.disabled; }, "workspace ready");
    button("Tasks & messages").click();
    await waitFor(() => doc.querySelector('button[data-task-id="T-1"]'), "task list loaded");
  } catch (error) {
    w.close();
    throw error;
  }
  return {
    w, doc, calls, errors, button,
    rows: () => [...doc.querySelectorAll(".collab-task-card")].map((row) => row.dataset.taskId),
    row: (id) => doc.querySelector(`.collab-task-card[data-task-id="${id}"]`),
    layout: () => doc.querySelector(".collab-task-layout"),
    detail: () => doc.querySelector(".collab-detail"),
    close: () => w.close(),
  };
}
/** Text a user can see: what a folded-away [hidden] part holds does not count. */
function visibleText(node) {
  const copy = node.cloneNode(true);
  for (const hidden of copy.querySelectorAll("[hidden]")) hidden.remove();
  return copy.textContent;
}
async function open(p, id) {
  // As a pointer or Enter does in a browser: the card is focused, then clicked.
  p.row(id).focus();
  p.row(id).click();
  await waitFor(() => p.detail()?.querySelector(`.collab-task-title [data-task-id="${id}"]`), `${id} opened`);
}

test("open tasks are ordered by what they wait for, newest change first, and each card says where it stands", async () => {
  const p = await mount();
  try {
    // No task open: one grid of cards, each with its status, no headings.
    assert.equal(p.doc.querySelectorAll(".collab-group-head").length, 0);
    assert.deepEqual(
      [...p.doc.querySelectorAll(".collab-cards .collab-task-card .collab-status")].map((s) => s.textContent.trim()),
      ["To review", "Blocked", "In progress", "In progress", "To do"],
    );
    assert.deepEqual(p.rows(), ["T-4", "T-5", "T-3", "T-2", "T-1"], "statuses in order; within one the newest change first");
    const line = (id) => p.row(id).querySelector(".collab-row-line");
    // Each status takes its line from the field that describes it now, as plain text.
    assert.equal(line("T-4").textContent, "Delivered as PR 12.");
    assert.equal(line("T-5").textContent, "Waiting on the signing keys");
    assert.equal(line("T-2").textContent, "Halfway through parsing", "progress, not the earlier round's result");
    assert.equal(line("T-1").textContent, "Write the guide.", "what the task is, not an earlier slice's progress or result");
    assert.equal(line("T-3").textContent, "No progress reported yet");
    assert.ok(line("T-3").classList.contains("is-empty"));
    // The result marker belongs to a result that is current.
    assert.ok(p.row("T-4").querySelector(".collab-has-result"));
    // Booleans only: a failing assert must never print a jsdom node.
    for (const id of ["T-1", "T-2", "T-3", "T-5"]) assert.ok(!p.row(id).querySelector(".collab-has-result"), `${id} has no current result`);
    // An open PR is shown with its checks as they are; merged ones only counted.
    const github = p.row("T-2").querySelector(".github-summary").textContent;
    assert.match(github, /repo#9.*Open.*Checks unknown/);
    assert.doesNotMatch(github, /Checks passed|repo#8|repo#7/);
    assert.match(github, /2 merged/);
    assert.ok(!p.row("T-4").querySelector(".github-summary"), "nothing linked, nothing claimed");
    assert.match(p.row("T-3").querySelector(".collab-row-time").textContent, /min ago/);
    assert.match(p.row("T-5").querySelector(".collab-row-time").textContent, /2 d ago/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("the detail opens beside the list, puts where things stand before delivery, and slides out on close", async () => {
  const p = await mount();
  try {
    await open(p, "T-2");
    assert.ok(p.layout().classList.contains("with-detail"));
    // Beside the open task: rows under status headings, in the same order.
    assert.deepEqual(
      [...p.doc.querySelectorAll(".collab-group-head")].map((h) => h.textContent.replace(/\d+$/, "").trim()),
      ["To review", "Blocked", "In progress", "To do"],
    );
    assert.deepEqual(p.rows(), ["T-4", "T-5", "T-3", "T-2", "T-1"]);
    await waitFor(() => p.doc.activeElement === p.row("T-2"), "focus moves from the card to its row");
    assert.equal(p.layout().dataset.entry, "open");
    assert.ok(p.row("T-2").classList.contains("selected"));
    const detail = p.detail();
    assert.ok(p.button("Edit task", detail.querySelector(".collab-task-title")), "actions sit with the title");
    const headings = [...detail.querySelectorAll("h4")].map((h) => h.textContent.trim());
    const at = (text) => headings.findIndex((h) => h.startsWith(text));
    assert.ok(at("Where things stand") >= 0 && at("Earlier result") > at("Where things stand"), headings.join(" | "));
    assert.ok(at("The work") > at("Earlier result") && at("Delivery") > at("The work"), headings.join(" | "));
    assert.equal(at("The result"), -1, "an earlier round's result is not called the result");
    // Delivery shows what is linked; managing it is one step away.
    const delivery = detail.querySelector(".collab-delivery");
    await waitFor(() => /repo#9/.test(delivery.textContent), "the linked PRs");
    assert.ok(!delivery.querySelector(".github-link-form"), "no link form until Manage");
    assert.doesNotMatch(visibleText(delivery), /Create or reuse PR|Unlink/);
    assert.ok(delivery.querySelector(".pr-operations")?.closest("[hidden]"), "PR operations stay mounted, folded away");
    const manage = delivery.querySelector("button[aria-expanded]");
    assert.equal(manage.textContent.trim(), "Manage");
    manage.click();
    await waitFor(() => !!delivery.querySelector(".github-link-form"), "the link form");
    assert.ok(!!delivery.querySelector('[aria-label="Unlink owner/repo#9"]'));
    assert.match(visibleText(delivery), /Create or reuse PR/);
    assert.equal(manage.getAttribute("aria-expanded"), "true");
    // Another task: its content fades in, the detail stays.
    await open(p, "T-4");
    assert.equal(p.layout().dataset.entry, "switch");
    const result = [...p.detail().querySelectorAll("h4")].map((h) => h.textContent.trim());
    assert.ok(result.indexOf("The result") >= 0 && result.indexOf("The result") < result.indexOf("The work"), result.join(" | "));
    // Close: the column shrinks while the detail slides out, then it goes,
    // and focus is back on the task's row.
    p.doc.querySelector('[aria-label="Close task"]').click();
    await pause(20);
    assert.ok(!p.layout().classList.contains("with-detail"));
    assert.ok(p.detail(), "still there while it leaves");
    await waitFor(() => !p.detail(), "gone after the slide", 1000);
    await waitFor(() => p.doc.activeElement === p.row("T-4"), "focus back on the row");
    // Quick changes of mind: the last one wins.
    await open(p, "T-1");
    p.doc.querySelector('[aria-label="Close task"]').click();
    p.row("T-2").click();
    p.row("T-5").click();
    await pause(400);
    assert.ok(p.layout().classList.contains("with-detail"));
    await waitFor(() => p.detail()?.querySelector('.collab-task-title [data-task-id="T-5"]'), "the last task chosen");
    p.doc.querySelector('[aria-label="Close task"]').click();
    await pause(20);
    p.doc.querySelector('[aria-label="Close task"]')?.click();
    await waitFor(() => !p.detail(), "closed once", 1000);
    // Opening again before it has gone keeps it.
    await open(p, "T-1");
    p.doc.querySelector('[aria-label="Close task"]').click();
    await pause(20);
    await open(p, "T-5");
    await pause(400);
    assert.ok(p.detail() && p.layout().classList.contains("with-detail"), "a new task opened while closing stays open");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a task with nothing linked offers one button; with reduced motion the detail closes at once", async () => {
  const p = await mount({ reduceMotion: true });
  try {
    await open(p, "T-3");
    const delivery = p.detail().querySelector(".collab-delivery");
    await waitFor(() => /No Issue or PR linked yet/.test(delivery.textContent), "nothing linked");
    assert.doesNotMatch(visibleText(delivery), /Create or reuse PR|Automatic delivery|Set up delivery|Pull requests and issues/);
    p.button("Link a PR or Issue", delivery).click();
    await waitFor(() => !!delivery.querySelector(".github-link-form"), "the link form");
    assert.match(visibleText(delivery), /Create or reuse PR/);
    assert.equal(delivery.querySelector("button[aria-expanded]").textContent.trim(), "Done");
    p.doc.querySelector('[aria-label="Close task"]').click();
    await waitFor(() => !p.detail(), "closed without waiting", 200);
    await waitFor(() => p.doc.activeElement === p.row("T-3"), "focus back on the row");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
