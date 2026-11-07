import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// T-43 rail v11 (the user's answers to design/ask-rail-readability): an
// executor's row in the built app, against a fixture Core. Line one is its
// task's short name, else its title; line two, small, what it is doing and
// its clock. Its ring says one of five states (working, needs you, done,
// failed, idle); every other state is a pill beside it that stays while it
// holds ("Lead's turn", "Queued · 2 in line"). Needs you and failed are row
// islands. Only a lead shows updates unread, as a dot. No row has a "…":
// its actions open at a right-click, a long-press or the context-menu key.
// A click on the row opens the conversation; a click on the ring goes to
// its state's place. Presence is asserted as booleans: a failing assertion
// on an element would inspect the whole window.
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
const project = { id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" };
const agent = (id, extra = {}) => ({
  id, name: `Agent ${id}`, goal: "", cwd: "/synthetic/work", model: "m", color: "sage", status: "idle", harness: "codex",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", ...extra,
});
const design = { id: "design-first", label: "Design first" };
const executor = (id, name, state, extra = {}, lifecycle = {}) => agent(id, {
  name,
  kind: "executor",
  executor: { state, agentId: id, dispatcher: { kind: "user" }, task: { id: `YN-${id}`, title: `Work ${id}` }, template: design,
    dispatchedAt: at(65), since: at(5), ...lifecycle },
  ...extra,
});
const agents = () => [
  agent("l", { name: "Dev Lead", kind: "lead", unreadCount: 3 }),
  // Waiting for you: its request is its work summary.
  executor("w", "YN-w · Design first", "running", {
    status: "waiting", pendingCount: 1,
    workSummary: { kind: "pending", source: "runtime", text: "Approve the design note", requestId: "q1" },
  }, { task: { id: "YN-w", title: "Export and import device preferences", shortName: "Export settings" } }),
  // Its result in, its PR waiting for its review rounds: the lead's turn.
  executor("v", "Agent v", "delivering"),
  // At work, with a short name; done long ago; another Agent waiting for you; one with updates unread.
  executor("k", "YN-k · Design first", "running", { status: "working", workSummary: { kind: "progress", source: "agent", text: "Slice 2: evidence Job" } },
    { task: { id: "YN-k", title: "Keep the selection after a refresh", shortName: "Keep selection" } }),
  executor("a", "YN-a · Design first", "archived", { closedAt: at(30), releasedAt: at(30), releasedBy: "user" },
    { dispatchedAt: at(120), since: at(30) }),
  agent("s", { status: "waiting", pendingCount: 1, workSummary: { kind: "pending", source: "runtime", text: "Allow npm test", requestId: "q2" } }),
  agent("u", { unreadCount: 4 }),
  executor("q", "YN-q · Design first", "queued", {}, { position: 2 }),
  // Made from no template (an empty id).
  executor("g", "Agent g", "running", { status: "working" }, { template: { id: "", label: null } }),
];
const live = {
  executors: {
    v: { pr: { number: 688, url: "https://github.com/owner/repo/pull/688", state: "open", headSha: "b".repeat(40), ci: "success",
      reviews: { approved: 1, changesRequested: false, running: false } } },
    k: { pr: { number: 690, url: "https://github.com/owner/repo/pull/690", state: "draft", headSha: "c".repeat(40), ci: "pending",
      reviews: { approved: 0, changesRequested: false, running: false } } },
  },
};
const home = () => ({
  generatedAt: at(0),
  order: ["p"],
  needsYou: [
    // Half a minute over: the row's clock is read at most a moment before this.
    { kind: "approval", projectId: "p", agentId: "w", agentName: "YN-w · Design first", requestId: "q1", title: "Approve the design note", since: at(12.5) },
    { kind: "approval", projectId: "p", agentId: "s", agentName: "Agent s", requestId: "q2", title: "Allow npm test", since: at(3.5) },
  ],
  projects: [{ project: { id: "p", name: "App" }, agents: { working: 2, idle: 3, waiting: 2, error: 0, offline: 0, total: 9 },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 1, history: [], sections: [] } }],
});

// The archived fold open, so the archived executor is listed.
const opened = { "yuzuno.archivedExecutorsOpen.ws-rail": JSON.stringify(["all"]) };

async function mount({ storage = {}, needsYou = (items) => items } = {}) {
  const errors = [];
  const calls = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4317/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  for (const [key, value] of Object.entries({ ...opened, ...storage })) w.localStorage.setItem(key, value);
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
    calls.push({ url, method: init.method || "GET" });
    if (url.endsWith("/api/workspace")) return respond({ workspace: { id: "ws-rail" }, projects: [project], agents: listed, runtime: { connected: true }, defaultCwd: "/w" });
    if (url.endsWith("/api/home")) { const h = home(); return respond({ ...h, needsYou: needsYou(h.needsYou) }); }
    if (url.endsWith("/api/executors/live")) return respond(live);
    if (url.endsWith("/task_list")) return respond({ tasks: [], counts: {}, hasMore: false });
    const detail = url.match(/\/api\/agents\/(\w)$/);
    if (detail) return respond({ agent: listed.find((a) => a.id === detail[1]), pending: [], artifacts: [], messageReceipts: [], turns: [] });
    if (url.endsWith("/api/machines")) return respond({ machines: [] });
    return respond({});
  };
  const doc = w.document;
  w.eval(bundle);
  await waitFor(() => doc.querySelector('.agent-list article[data-agent-id="s"]'), "the sidebar lists the Agents");
  const row = (id) => doc.querySelector(`.agent-list article[data-agent-id="${id}"]`);
  const part = (id, name) => row(id)?.querySelector(name)?.textContent ?? null;
  return {
    w, doc, calls, errors, row,
    // Its ring (T-43 v10.1): its state and form; line one and line two.
    island: (id) => row(id)?.querySelector(":scope > .agent-island") ?? null,
    form: (id) => row(id)?.dataset.form ?? null,
    state: (id) => {
      const island = row(id)?.querySelector(":scope > .agent-island");
      return island ? [island.dataset.state, part(id, ".agent-line-one")] : null;
    },
    meta: (id) => part(id, ":scope > .agent-row-meta"),
    clock: (id) => part(id, ":scope > .agent-row-meta .island-clock"),
    pill: (id) => row(id)?.querySelector(":scope > .agent-island .island-pill")?.textContent ?? null,
    bell: (id) => !!row(id)?.querySelector(".agent-row-bottom .needs-you"),
    close: () => w.close(),
  };
}

test("needs you is a row island by itself, with how long; line one is still its task", async () => {
  const p = await mount();
  try {
    await waitFor(() => p.clock("w") === "12m", "how long it has waited, from Home's Needs you");
    assert.deepEqual(p.state("w"), ["waiting", "Export settings"], "line one: its task's short name");
    assert.equal(p.meta("w"), "Approve the design note · 12m", "line two: what it asks, then its wait");
    assert.equal(p.form("w"), "row");
    assert.equal(p.pill("w"), null, "a row island has no pill");
    assert.equal(p.island("w").getAttribute("aria-label"), "YN-w · Design first · Answer its question on Home");
    assert.match(p.island("w").title, /^Needs you · waiting 12m · Approve the design note\nAnswer its question on Home\n/);
    assert.equal(p.bell("w"), false, "no second \"needs you\" under it");
    assert.match(p.row("w").querySelector(".agent-select").title, /YN-w · Export and import device preferences/, "its key and title in its link's title");
    // A standing Agent that needs you: its name, then the word and what it asks.
    assert.equal(p.row("s").querySelector(".agent-line-one").textContent, "Agent s");
    assert.equal(p.row("s").querySelector(":scope > .agent-row-state.is-alert .island-word").textContent, "Needs you");
    assert.equal(p.form("s"), "row");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("line one is the task's short name, else its title; the ring is one of five; any other state is a pill that stays", async () => {
  const p = await mount();
  try {
    await waitFor(() => p.pill("v") === "Lead's turn", "v's PR, from /api/executors/live: its rounds not under way");
    assert.deepEqual(p.state("v"), ["idle", "Work v"], "no short name: its title; handed in is no ring of its own");
    assert.equal(p.form("v"), "pill");
    assert.deepEqual(p.state("k"), ["working", "Keep selection"]);
    assert.equal(p.meta("k"), "Slice 2: evidence Job · 1h5m", "line two: what it is doing, then its time on the task");
    assert.equal(p.pill("k"), null, "working says itself in the ring");
    assert.deepEqual(p.state("q"), ["idle", "Work q"]);
    assert.equal(p.pill("q"), "Queued · 2 in line");
    assert.deepEqual(p.state("a"), ["done", "Work a"], "archived: ✓");
    assert.equal(p.meta("a"), "1h30m in all", "its whole time, frozen");
    // Five rings only: no review rounds, no marching dots, no box.
    for (const id of ["w", "v", "k", "a", "q", "g", "s", "u", "l"])
      assert.ok(["idle", "working", "waiting", "done", "failed"].includes(p.island(id).dataset.state), `${id}: ${p.island(id).dataset.state}`);
    assert.equal(p.doc.querySelectorAll(".agent-list .r-rounds, .agent-list .r-march, .agent-list .r-dots, .agent-list .r-box, .agent-list .r-dashed").length, 0);
    assert.equal(p.island("a").querySelectorAll("svg path.r-mark").length, 1, "done: its ✓");
    assert.equal(p.island("k").querySelectorAll("svg .r-spin .r-arc").length, 1, "working: its turning arc");
    // No numbers on the row: no task key, no PR.
    for (const id of ["v", "k", "q", "a", "g"]) assert.doesNotMatch(p.row(id).textContent, /#\d|YN-/, `${id}: no key or PR on the row`);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("only a lead shows updates unread, as a dot without a count", async () => {
  const p = await mount();
  try {
    await waitFor(() => p.island("l")?.dataset.dot === "true", "the lead's dot");
    assert.equal(!!p.island("l").querySelector(".island-dot"), true);
    assert.equal(p.island("u").dataset.dot, undefined, "another Agent with updates unread: no dot");
    assert.equal(p.doc.querySelectorAll(".agent-list .island-notch").length, 0, "no count anywhere");
    assert.doesNotMatch(p.row("u").textContent, /\d+ unread|未读/);
    assert.equal(p.island("u").tagName, "SPAN", "nowhere of its own: no button");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a click on the row opens the conversation; a click on the ring goes to its state's place; no row has a \"…\"", async () => {
  const p = await mount();
  try {
    await waitFor(() => p.form("w") === "row" && p.pill("v") === "Lead's turn", "the rows");
    const reads = (id) => p.calls.filter((c) => c.url.endsWith(`/api/agents/${id}`)).length;
    const tasks = [];
    p.w.addEventListener("yuzuno:open-task-review", (event) => tasks.push(event.detail.taskId));
    const before = reads("w");
    p.row("w").querySelector(".agent-select").click();
    await waitFor(() => reads("w") > before, "w's conversation opens");
    assert.equal(p.form("w"), "row");
    // The open row has no "…", nor does any other.
    assert.equal(p.doc.querySelectorAll(".agent-list .agent-row-menu, .agent-list .agent-actions-button").length, 0);
    assert.equal(p.doc.querySelector('.agent-list [aria-label^="Actions for"]'), null);
    // Needs you: Home, at its item in Needs you.
    for (const [id, key] of [["w", "approval:q1"], ["s", "approval:q2"]]) {
      p.island(id).click();
      await waitFor(() => p.doc.activeElement?.dataset?.needsYou === key, `${id}'s ring goes to its item in Home's Needs you`);
    }
    // Each executor's ring: its task, never the conversation.
    const opened = Object.fromEntries(["v", "k", "a", "q", "g"].map((id) => [id, reads(id)]));
    for (const [id, label] of [["v", "Agent v · See its result"], ["k", "YN-k · Design first · Open task YN-k"], ["a", "YN-a · Design first · Open task YN-a"],
      ["q", "YN-q · Design first · See its place in the queue"], ["g", "Agent g · Open task YN-g"]]) {
      assert.equal(p.island(id).getAttribute("aria-label"), label);
      p.island(id).click();
      await waitFor(() => tasks.at(-1) === `YN-${id}`, `${id}'s ring opens its task`);
      assert.equal(reads(id), opened[id], `${id}'s ring never opened the conversation`);
    }
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("in Chinese the row reads in Chinese", async () => {
  const p = await mount({ storage: { "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) } });
  try {
    await waitFor(() => p.pill("v") === "等负责人" && p.clock("w") === "12分", "the pill and the wait");
    assert.deepEqual(p.state("w"), ["waiting", "Export settings"]);
    assert.equal(p.meta("w"), "Approve the design note · 12分");
    assert.equal(p.pill("q"), "排队 · 第 2 位");
    assert.equal(p.meta("k"), "Slice 2: evidence Job · 1时5分");
    assert.equal(p.meta("a"), "共 1时30分");
    assert.equal(p.island("w").getAttribute("aria-label"), "YN-w · Design first · 去 Home 回答提问");
    assert.equal(p.island("v").getAttribute("aria-label"), "Agent v · 看结果");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
