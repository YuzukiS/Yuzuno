import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// T-43 S2, 灵动环 v10.1: an executor's row in the built app, against a
// fixture Core. Line one is what it is doing after its state's word; line two
// its task key and its clock, which freezes once it is over; its ring is its
// state. Needs you and failed are row islands by themselves; waiting for you
// is said once, with how long. A click on the row opens the conversation;
// the ring steps the island to its card, whose buttons go elsewhere: its PR
// (GET /api/executors/live) is the card's detail line. Presence is asserted
// as booleans: a failing assertion on an element would inspect the whole
// window.
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
  // Waiting for you: its request is its work summary.
  executor("w", "YN-w · Design first", "running", {
    status: "waiting", pendingCount: 1,
    workSummary: { kind: "pending", source: "runtime", text: "Approve the design note", requestId: "q1" },
  }),
  // Its result in, its PR in review; its name doesn't say its template.
  executor("v", "Agent v", "delivering"),
  // At work on a draft PR; done long ago; another Agent waiting for you.
  executor("k", "YN-k · Design first", "running", { status: "working" }),
  executor("a", "YN-a · Design first", "archived", { closedAt: at(30), releasedAt: at(30), releasedBy: "user" },
    { dispatchedAt: at(120), since: at(30) }),
  agent("s", { status: "waiting", pendingCount: 1, workSummary: { kind: "pending", source: "runtime", text: "Allow npm test", requestId: "q2" } }),
  // Made from no template (an empty id): Executor where a template's label goes.
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
    // Half a minute over too: the island's clock is to the minute, read when the row first subscribed.
    { kind: "approval", projectId: "p", agentId: "s", agentName: "Agent s", requestId: "q2", title: "Allow npm test", since: at(3.5) },
  ],
  projects: [{ project: { id: "p", name: "App" }, agents: { working: 1, idle: 2, waiting: 2, error: 0, offline: 0, total: 5 },
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
    more: (id) => part(id, ":scope > .agent-row-more"),
    actions: (id) => [...(row(id)?.querySelectorAll(":scope > .island-actions button") ?? [])].map((b) => b.textContent),
    bell: (id) => !!row(id)?.querySelector(".agent-row-bottom .needs-you"),
    close: () => w.close(),
  };
}

test("needs you is a row island by itself, with how long; the bell under the row isn't said again", async () => {
  const p = await mount();
  try {
    await waitFor(() => p.clock("w") === "12m", "how long it has waited, from Home's Needs you");
    assert.deepEqual(p.state("w"), ["waiting", "Needs you: Approve the design note"], "what it asks is its line one");
    assert.equal(p.meta("w"), "YN-w · 12m", "its task key and its wait");
    assert.equal(p.form("w"), "row");
    assert.equal(p.island("w").getAttribute("aria-expanded"), "true");
    assert.match(p.island("w").title, /^Needs you · waiting 12m · Approve the design note\n/);
    assert.equal(p.bell("w"), false, "no second \"needs you\" under it");
    assert.equal(p.row("w").querySelector(".agent-work-summary"), null, "what it asks is said once");
    assert.match(p.row("w").querySelector(".agent-select").getAttribute("aria-description"), /^Executor · Needs you, on /);
    assert.equal(p.row("w").querySelector(".agent-select").getAttribute("aria-label"), "Open YN-w · Design first", "the row is the link to its conversation");
    // A standing Agent that needs you: its name, then the word and what it asks.
    assert.equal(p.row("s").querySelector(".agent-line-one").textContent, "Agent s");
    assert.equal(p.row("s").querySelector(":scope > .agent-row-state.is-alert .island-word").textContent, "Needs you");
    assert.equal(p.form("s"), "row");
    assert.equal(p.bell("s"), false);
    assert.equal(p.island("s").dataset.status, "Waiting", "the row's status words, kept on the ring");
    assert.equal(p.row("s").querySelector(".agent-rail-avatar"), null, "no avatar on any Agent row");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an executor's question not yet in Home's Needs you shows no clock, not its time since dispatch", async () => {
  const p = await mount({ needsYou: (items) => items.filter((item) => item.agentId !== "w") });
  try {
    await waitFor(() => p.row("s")?.querySelector(".agent-island")?.title.includes("3m"), "Home's Needs you is read");
    assert.deepEqual(p.state("w"), ["waiting", "Needs you: Approve the design note"]);
    assert.equal(p.clock("w"), null, "no clock until Home lists its wait");
    assert.equal(p.meta("w"), "YN-w");
    assert.equal(p.island("w").dataset.clock, undefined);
    assert.doesNotMatch(p.island("w").title, /1h/, "not its 65 minutes since dispatch");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("line one says what it is doing, line two its key and clock, frozen once over; the ring is the state", async () => {
  const p = await mount();
  try {
    await waitFor(() => /#688/.test(p.state("v")?.[1] ?? ""), "the PR, from /api/executors/live");
    assert.ok(p.calls.some((c) => c.url.endsWith("/api/executors/live") && c.method === "GET"), "one local read");
    assert.deepEqual(p.state("v"), ["handed", "Handed in #688 · waiting for the lead"], "handed in, its PR in its word");
    assert.equal(p.meta("v"), "YN-v · 5m", "handed in five minutes ago");
    assert.equal(p.form("v"), "ring");
    assert.deepEqual(p.state("k"), ["working", "Work k"], "nothing said yet: its task's title");
    assert.equal(p.meta("k"), "YN-k · 1h5m", "on its task since its dispatch");
    assert.deepEqual(p.state("a"), ["archived", "Archived: Work a"]);
    assert.equal(p.meta("a"), "YN-a · 1h30m in all", "its whole time, frozen when it was archived");
    assert.match(p.island("a").title, /^Archived · 1h30m in total/);
    // The ring is strokes: a mark only for done, failed and archived.
    assert.equal(p.island("a").querySelectorAll("svg path.r-mark").length, 1, "archived: its box");
    assert.equal(p.island("k").querySelectorAll("svg path").length, 0, "working: an arc, no mark");
    assert.equal(p.island("k").querySelectorAll("svg .r-spin .r-arc").length, 1, "working: its turning arc");
    assert.equal(p.island("v").querySelectorAll("svg .r-rounds").length, 1, "handed in: one round of two");
    assert.equal(p.row("k").querySelector(".island-dot, .executor-row-facts"), null, "no dot, no chips");
    // Its template and PR are in its ring's title, not on the row.
    assert.match(p.island("v").title, /PR #688 · Review 1\/2 · Design first/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a click on the row opens the conversation; the ring steps the island to its card, which goes elsewhere", async () => {
  const p = await mount();
  try {
    await waitFor(() => p.form("w") === "row" && /#688/.test(p.state("v")?.[1] ?? ""), "the rows");
    const reads = (id) => p.calls.filter((c) => c.url.endsWith(`/api/agents/${id}`)).length;
    // The row, the text of a row island included: the conversation, the island as it was.
    const before = reads("w");
    p.row("w").querySelector(".agent-select").click();
    await waitFor(() => reads("w") > before, "w's conversation opens");
    assert.equal(p.form("w"), "row");
    // The ring: row island → card → back, never the conversation.
    const opened = reads("v");
    p.island("v").click();
    await waitFor(() => p.form("v") === "row", "v's row island");
    assert.equal(p.island("v").getAttribute("aria-expanded"), "true");
    p.island("v").click();
    await waitFor(() => p.form("v") === "card", "v's card");
    assert.deepEqual(p.actions("v"), ["See result"], "handed in: its result");
    assert.equal(p.more("v"), "#688 · Review 1/2", "its PR is the card's detail line");
    assert.equal(p.row("v").querySelector(".island-actions button").className, "primary");
    p.island("v").click();
    await waitFor(() => p.form("v") === "ring", "closed into its ring");
    assert.equal(p.island("v").getAttribute("aria-expanded"), "false");
    assert.equal(reads("v"), opened, "the ring never opened the conversation");
    // Needs you: its card answers on Home, or opens its task; Escape closes it.
    p.island("w").click();
    await waitFor(() => p.form("w") === "card", "w's card");
    assert.deepEqual(p.actions("w"), ["Answer on Home", "Task"]);
    assert.equal(p.more("w"), "Task: Work w");
    p.doc.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => p.form("w") === "row", "back to its row island");
    // No card offers the conversation: it is the row's.
    for (const id of ["k", "a", "g"]) {
      p.island(id).click();
      p.island(id).click();
      await waitFor(() => p.form(id) === "card", `${id}'s card`);
      assert.ok(!p.actions(id).some((a) => /Open|conversation/i.test(a)), `${id}: ${p.actions(id)}`);
      p.doc.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await waitFor(() => p.form(id) === "ring", `${id} closed`);
    }
    // A button leads somewhere and the card closes.
    p.island("v").click();
    p.island("v").click();
    await waitFor(() => p.form("v") === "card", "v's card again");
    p.row("v").querySelector(".island-actions button").click();
    await waitFor(() => p.form("v") === "ring", "the card closes once it has led somewhere");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("in Chinese the row reads in Chinese", async () => {
  const p = await mount({ storage: { "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) } });
  try {
    await waitFor(() => /#688/.test(p.state("v")?.[1] ?? "") && p.clock("w") === "12分", "the PR and the wait");
    assert.deepEqual(p.state("w"), ["waiting", "等你：Approve the design note"]);
    assert.deepEqual(p.state("v"), ["handed", "已交 #688 · 等负责人"]);
    assert.deepEqual(p.state("k"), ["working", "Work k"]);
    assert.equal(p.meta("k"), "YN-k · 1时5分");
    assert.deepEqual(p.state("a"), ["archived", "已归档：Work a"]);
    assert.equal(p.meta("a"), "YN-a · 共 1时30分");
    p.island("w").click();
    await waitFor(() => p.form("w") === "card", "w's card");
    assert.deepEqual(p.actions("w"), ["去 Home 回答", "看任务"]);
    for (const id of ["w", "v", "k", "a"]) assert.doesNotMatch(p.island(id).title, /放行/, `${id}: no 放行`);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
