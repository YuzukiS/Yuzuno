import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// T-43 S2: an executor's row in the built app, against a fixture Core. Its
// second line says one state and what it is at; waiting for you is said
// once, with how long; its PR (GET /api/executors/live) and the template it
// was made from, when its name doesn't say it, sit beside its time on the
// task, which freezes once it is over. Another Agent's row is as before.
// Presence is asserted as booleans: a failing assertion on an element would
// inspect the whole window.
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

async function mount({ storage = {} } = {}) {
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
    if (url.endsWith("/api/home")) return respond(home());
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
    // Its island (T-43 v4-2): its state and line two, its form, its clock.
    island: (id) => row(id)?.querySelector(".agent-island") ?? null,
    state: (id) => {
      const island = row(id)?.querySelector(".agent-island");
      return island ? [island.dataset.state, island.querySelector(".island-line")?.textContent ?? null] : null;
    },
    clock: (id) => part(id, ".agent-island .island-clock"),
    template: (id) => part(id, ".executor-template-chip"),
    card: (id) => row(id)?.querySelector(".agent-island-card") ?? null,
    actions: (id) => [...(row(id)?.querySelectorAll(".agent-island-card .island-actions button") ?? [])].map((b) => b.textContent),
    chip: (id) => row(id)?.querySelector(".executor-pr-chip") ?? null,
    bell: (id) => !!row(id)?.querySelector(".agent-row-bottom .needs-you"),
    close: () => w.close(),
  };
}

test("needs you opens to two lines by itself, with how long; the bell under the row isn't said again", async () => {
  const p = await mount();
  try {
    await waitFor(() => p.clock("w") === "12m", "how long it has waited, from Home's Needs you");
    assert.deepEqual(p.state("w"), ["waiting", "Needs you: Approve the design note"], "what it asks is its line two");
    assert.equal(p.island("w").dataset.form, "two");
    assert.match(p.island("w").title, /^Needs you · waiting 12m · Approve the design note\n/);
    assert.equal(p.bell("w"), false, "no second \"needs you\" under it");
    assert.equal(p.row("w").querySelector(".agent-work-summary"), null, "beside two lines the sentence is the island's, not said again");
    assert.match(p.row("w").querySelector(".agent-select").getAttribute("aria-description"), /^Executor · Needs you, on /);
    // A standing Agent that needs you: its island says it, the same way.
    assert.deepEqual(p.state("s"), ["waiting", "Needs you: Allow npm test"]);
    assert.equal(p.clock("s"), "3m");
    assert.equal(p.bell("s"), false);
    assert.equal(p.island("s").dataset.status, "Waiting", "the row's status words, kept on the island");
    assert.equal(p.row("s").querySelector(".agent-rail-avatar"), null, "no avatar on any Agent row");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("its PR on line two and in its chip, its template when its name lacks it, and its clock, frozen once over", async () => {
  const p = await mount();
  try {
    await waitFor(() => p.chip("v"), "the PR chip, from /api/executors/live");
    assert.ok(p.calls.some((c) => c.url.endsWith("/api/executors/live") && c.method === "GET"), "one local read");
    assert.deepEqual(p.state("v"), ["handed", "Handed in: Review 1/2"], "handed in, at its rounds");
    assert.equal(p.clock("v"), "5m", "handed in five minutes ago");
    assert.equal(p.island("v").dataset.form, "ring");
    assert.equal(p.chip("v").textContent, "PR #688");
    assert.equal(p.chip("v").dataset.tone, "wait");
    assert.equal(p.chip("v").title, "PR #688 · Review 1/2");
    assert.deepEqual(p.state("k"), ["working", "Working: Draft"], "at work on a draft PR");
    assert.equal(p.clock("k"), "1h5m", "on its task since its dispatch");
    assert.equal(p.template("v"), "Design first", "its name doesn't say its template: the chip does");
    assert.equal(p.template("w"), null, "its name says it already");
    assert.equal(p.template("g"), "Executor", "made from no template: Executor");
    assert.deepEqual(p.state("a"), ["archived", "Archived"]);
    assert.equal(p.clock("a"), "1h30m", "its whole time, frozen when it was archived");
    assert.match(p.island("a").title, /^Archived · 1h30m in total/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("pressing the island opens its card in the row's place, leading with what the state asks for", async () => {
  const p = await mount();
  try {
    await waitFor(() => p.island("w")?.dataset.form === "two" && p.chip("v"), "the rows");
    p.island("w").click();
    await waitFor(() => p.card("w"), "w's card");
    assert.equal(p.island("w").dataset.form, "card");
    assert.equal(p.island("w").getAttribute("aria-expanded"), "true");
    assert.deepEqual(p.actions("w"), ["Answer on Home", "Open", "Task"], "an executor's question is answered on Home");
    assert.equal(p.card("w").querySelector(".island-actions button").className, "primary");
    assert.equal(p.card("w").querySelector(".island-title").textContent, "Needs you · waiting 12m");
    assert.equal(p.card("w").querySelector(".island-cover").textContent, "12m");
    // Escape closes it; the island is two lines again.
    p.card("w").dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => !p.card("w"), "closed");
    assert.equal(p.island("w").dataset.form, "two");
    // Handed in leads with its result; Open opens the Agent and the card closes.
    p.island("v").click();
    await waitFor(() => p.card("v"), "v's card");
    assert.deepEqual(p.actions("v"), ["See result", "Open"]);
    const reads = () => p.calls.filter((c) => c.url.endsWith("/api/agents/v")).length;
    const before = reads();
    [...p.card("v").querySelectorAll("button")].find((b) => b.textContent === "Open").click();
    await waitFor(() => reads() > before, "the Agent opens");
    await waitFor(() => !p.card("v"), "the card closes once it has led somewhere");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("in Chinese the row reads in Chinese", async () => {
  const p = await mount({ storage: { "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) } });
  try {
    await waitFor(() => p.chip("v") && p.clock("w") === "12分", "the PR chip and the wait");
    assert.deepEqual(p.state("w"), ["waiting", "等你：Approve the design note"]);
    assert.deepEqual(p.state("v"), ["handed", "已交：审查 1/2"]);
    assert.deepEqual(p.state("k"), ["working", "在做：草稿"]);
    assert.equal(p.clock("k"), "1时5分");
    assert.deepEqual(p.state("a"), ["archived", "已归档"]);
    assert.equal(p.template("g"), "执行者");
    for (const id of ["w", "v", "k", "a"]) assert.doesNotMatch(p.island(id).title, /放行/, `${id}: no 放行`);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
