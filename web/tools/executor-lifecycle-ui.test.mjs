import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// T-36 S3: an executor's lifecycle in the built app, against a fixture Core.
// The sidebar lists a Project's leads, its other Agents, its task executors
// (with Attention order: waiting on you or failed, delivered awaiting
// release, running, archiving, queued) and folds its archived ones; each
// executor's row says its one state (T-43 S2: one word and what it is at, in
// place of a runtime status beside a lifecycle badge); a task's card and view
// say its lifecycle; Home's
// Needs you lists the executors you dispatched, and its row opens the
// executor. Presence is asserted as booleans: a failing assertion on an
// element would inspect the whole window.
const distUrl = process.env.YUZUNO_UI_DIST
  ? pathToFileURL(resolve(process.env.YUZUNO_UI_DIST) + "/")
  : new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", distUrl), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)?.[1];
assert.ok(entry, "index.html must name the current JavaScript bundle");
const bundle = await uiTestBundle(new URL(entry, distUrl));
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, message, seconds = 6) {
  const deadline = Date.now() + seconds * 1000;
  while (!predicate() && Date.now() < deadline) await pause(25);
  assert.ok(predicate(), message);
}

const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const CLOSED = at(30);
const project = { id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" };
const person = { kind: "user", id: "user", name: "You" };
const agent = (id, extra = {}) => ({
  id, name: `Agent ${id}`, goal: "", cwd: "/synthetic/work", model: "m", color: "sage", status: "idle", harness: "codex",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", ...extra,
});
const executor = (id, state, extra = {}, lifecycle = {}) => agent(id, {
  kind: "executor",
  executor: { state, agentId: id, dispatcher: { kind: "user" }, task: { id: `T-${id}`, title: `Work ${id}` }, since: at(5), ...lifecycle },
  ...extra,
});
// In the workspace's own order; the sidebar orders them.
const agents = () => [
  executor("q", "queued", {}, { position: 2 }),
  agent("s"),
  executor("r", "running", { status: "working" }),
  executor("a", "archived", { closedAt: CLOSED, releasedAt: CLOSED, releasedBy: "user" }),
  executor("d", "delivering"),
  agent("l", { kind: "lead" }),
  executor("g", "archiving", {}, { reason: "Waiting to close: a Job is still running: build (j1)." }),
  executor("f", "failed", { closedAt: CLOSED }, { reason: "Both starts failed" }),
  executor("c", "closed", { closedAt: CLOSED }),
  // A lead's executor, its result in too: never in Home's Needs you.
  executor("e", "delivering", {}, { dispatcher: { kind: "agent", id: "l", name: "Agent l" } }),
];
const task = (id, extra) => ({
  id, title: `Work ${id}`, description: "", status: "doing", version: 1, projectId: "p", progress: "", blocker: "", result: null, github: [],
  createdAt: at(500), updatedAt: at(5), createdBy: person, updatedBy: person, ...extra,
});
const tasks = () => [
  task("T-d", { status: "review", assigneeAgentId: "d", executor: agents().find((a) => a.id === "d").executor }),
  task("T-q", {
    assigneeAgentId: "q", executor: agents().find((a) => a.id === "q").executor,
    // T-35's slot, which the lifecycle replaces on the card.
    executorSlot: { agentId: "q", state: "waiting", machine: "local", position: 2 },
  }),
];
// What Core lists: the user's executor only (Core leaves a lead's out).
const home = () => ({
  generatedAt: at(0),
  order: ["p"],
  needsYou: [{ kind: "executor", projectId: "p", agentId: "d", agentName: "Agent d", state: "delivering", taskId: "T-d", title: "Work d", since: at(5) }],
  projects: [{ project: { id: "p", name: "App" }, agents: { working: 1, idle: 3, waiting: 0, error: 0, offline: 0, total: 4 },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 1, history: [], sections: [] } }],
});

async function mount({ storage = {} } = {}) {
  const errors = [];
  const calls = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4317/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
  w.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.EventSource = class { addEventListener() {} close() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  const respond = (value, status = 200) => {
    const text = JSON.stringify(value);
    return { ok: status === 200, status, json: async () => JSON.parse(text), text: async () => text };
  };
  const listed = agents();
  w.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url, method: init.method || "GET", body });
    if (url.endsWith("/api/workspace")) return respond({ workspace: { id: "ws-exec" }, projects: [project], agents: listed, runtime: { connected: true }, defaultCwd: "/w" });
    if (url.endsWith("/api/home")) return respond(home());
    if (url.endsWith("/task_list")) return respond({ tasks: tasks(), counts: { review: 1, doing: 1 }, hasMore: false });
    if (url.endsWith("/task_get")) return respond({ task: tasks().find((t) => t.id === body.taskId), activities: [], executions: [], hasMore: false });
    const detail = url.match(/\/api\/agents\/(\w)$/);
    if (detail) return respond({ agent: listed.find((a) => a.id === detail[1]), pending: [], artifacts: [], messageReceipts: [], turns: [] });
    if (url.endsWith("/api/machines")) return respond({ machines: [] });
    return respond({});
  };
  const doc = w.document;
  w.eval(bundle);
  await waitFor(() => doc.querySelector('.agent-list article[data-agent-id="l"]'), "the sidebar lists the Agents");
  const row = (id) => doc.querySelector(`.agent-list article[data-agent-id="${id}"]`);
  return {
    w, doc, calls, errors, row,
    // The rows in the list's parts, the archived fold's apart.
    order: () => [...doc.querySelectorAll(".agent-list article[data-agent-id]")].filter((r) => !r.closest('[data-rail-part="archived"]')).map((r) => r.dataset.agentId),
    all: () => [...doc.querySelectorAll(".agent-list article[data-agent-id]")].map((r) => r.dataset.agentId),
    badge: (id) => row(id)?.querySelector(".agent-kind-badge")?.textContent ?? null,
    // An executor's state line (T-43 S2): its word and what it is at.
    state: (id) => {
      const line = row(id)?.querySelector(".executor-row-state");
      return line ? [line.querySelector(".executor-state-word")?.textContent ?? null, line.querySelector(".executor-state-detail")?.textContent ?? null] : null;
    },
    part: (name) => doc.querySelector(`.agent-list [data-rail-part="${name}"]`),
    button: (text) => [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === text),
    close: () => w.close(),
  };
}
const attention = { "yuzuno.appearance": JSON.stringify({ agentOrder: "attention" }) };

test("the sidebar lists a Project's leads, its other Agents, its task executors by attention, and folds the archived ones", async () => {
  const p = await mount({ storage: attention });
  try {
    assert.deepEqual(p.order(), ["l", "s", "f", "d", "e", "r", "g", "q"],
      "lead; the other Agent; executors: failed, delivered awaiting release (two, as listed), running, archiving, queued");
    const executors = p.part("executors");
    assert.ok(executors, "a task executors group");
    assert.equal(executors.querySelector(".rail-subgroup-head").textContent, "Task executors3 running · 1 queued6",
      "while one waits for a slot, how many run and how many wait");
    assert.deepEqual([...executors.querySelectorAll("article[data-agent-id]")].map((r) => r.dataset.agentId), ["f", "d", "e", "r", "g", "q"]);
    // Each executor's row says its one state; a lead's badge says Lead.
    assert.equal(p.badge("l"), "Lead");
    assert.equal(p.badge("d"), null, "an executor's row has no lifecycle badge beside its state");
    assert.deepEqual(p.state("d"), ["Review", "Awaiting release"], "its result in: in review, awaiting release");
    assert.deepEqual(p.state("q"), ["Queued", "2 in line"]);
    assert.deepEqual(p.state("r"), ["Working", null]);
    assert.deepEqual(p.state("g"), ["Done", "Closing · Waiting to close: a Job is still running: build (j1)."]);
    assert.deepEqual(p.state("f"), ["Failed", "Both starts failed"]);
    assert.equal(p.row("r").querySelector(".agent-runtime"), null, "no runtime status beside it");
    assert.match(p.row("g").querySelector(".executor-row-state").title, /Archiving: Waiting to close: a Job is still running: build \(j1\)\./);
    assert.match(p.row("f").querySelector(".executor-row-state").title, /T-f · Work f\nBoth starts failed\nDispatched by you/);
    // Archived ones are folded away; a closed one is in Closed only.
    const toggle = p.part("archived")?.querySelector(".rail-archived-toggle");
    assert.ok(toggle, "an archived fold");
    assert.equal(toggle.getAttribute("aria-expanded"), "false", "folded until opened");
    const hidden = !p.row("a") && !p.row("c");
    assert.ok(hidden, "neither the archived executor nor the closed one is listed");
    toggle.click();
    await waitFor(() => p.row("a"), "opened, the archived executor is listed");
    assert.deepEqual(p.state("a"), ["Done", "Released"]);
    assert.deepEqual(JSON.parse(p.w.localStorage.getItem("yuzuno.archivedExecutorsOpen.ws-exec")), ["all"], "the fold is remembered on this device");
    assert.ok(!p.row("c"), "a closed executor stays in Closed");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("with List order the parts stay, each in the workspace's order; and a reload keeps the fold open", async () => {
  const p = await mount({ storage: { "yuzuno.archivedExecutorsOpen.ws-exec": JSON.stringify(["all"]) } });
  try {
    assert.deepEqual(p.all(), ["l", "s", "q", "r", "d", "g", "e", "f", "a"], "leads first, then the others, then executors and the opened fold");
    assert.equal(p.part("archived").querySelector(".rail-archived-toggle").getAttribute("aria-expanded"), "true");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("in Chinese the groups and states read in Chinese", async () => {
  const p = await mount({ storage: { ...attention, "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) } });
  try {
    assert.equal(p.part("executors").querySelector(".rail-subgroup-head").textContent, "任务执行者3 运行 · 1 排队6",
      "in Chinese, how many run and how many wait");
    assert.equal(p.part("archived").querySelector(".rail-archived-toggle").textContent, "已归档1");
    assert.deepEqual(p.state("d"), ["审查", "等待放行"]);
    assert.deepEqual(p.state("q"), ["排队", "第 2 位"]);
    assert.deepEqual(p.state("r"), ["在做", null]);
    assert.deepEqual(p.state("g"), ["完成", "收尾中 · Waiting to close: a Job is still running: build (j1)."]);
    assert.deepEqual(p.state("f"), ["失败", "Both starts failed"]);
    assert.match(p.row("g").querySelector(".executor-row-state").title, /归档中：Waiting to close/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a task's card says its executor's state in place of its slot, and its view says it beside its owner", async () => {
  const p = await mount();
  try {
    p.button("Tasks & messages").click();
    const card = (id) => p.doc.querySelector(`.collab-task-card[data-task-id="${id}"]`);
    await waitFor(() => card("T-d"), "the task list");
    assert.equal(card("T-d").querySelector(".collab-executor-state")?.textContent, "Executor · Awaiting release", "the card says its executor's state");
    assert.equal(card("T-q").querySelector(".collab-executor-state")?.textContent, "Executor · Queued · 2 in line");
    assert.equal(card("T-q").querySelector(".collab-executor-state").dataset.executorState, "queued");
    assert.ok(!card("T-q").querySelector(".collab-executor-slot"), "the lifecycle takes the slot's place");
    card("T-d").click();
    await waitFor(() => p.doc.querySelector(".collab-detail .collab-owner-line .collab-executor-state"), "the task's view");
    assert.equal(p.doc.querySelector(".collab-detail .collab-owner-line .collab-executor-state").textContent, "Executor · Awaiting release");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("Home's Needs you lists the executor you dispatched, never a lead's, and its row opens the executor", async () => {
  const p = await mount();
  try {
    const rows = () => [...p.doc.querySelectorAll(".home-needs-item")];
    // Home is the toolbar's first view; its count says one waits.
    p.doc.querySelector(".toolbar-nav button").click();
    await waitFor(() => rows().length > 0, "Needs you");
    const mine = rows().find((r) => r.dataset.needsYou === "executor:d:delivering");
    assert.ok(mine, "the executor you dispatched is listed");
    assert.match(mine.textContent, /App · Awaiting your release/);
    assert.match(mine.title, /^Agent d · Work d · waiting since /, "its name is in the row's title");
    assert.match(mine.textContent, /T-d · Work d/);
    // In the same render: the lead's executor, its result in too, is not.
    const leads = rows().some((r) => (r.dataset.needsYou ?? "").startsWith("executor:e:") || /Agent e/.test(r.textContent));
    assert.ok(!leads, "a lead's executor is never in Needs you");
    mine.click();
    await waitFor(() => p.row("d")?.classList.contains("selected"), "its row opens the executor");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
