import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// T-43 S3: an executor's session has two tabs, its Overview (the one it opens
// on) and its Conversation, in the built app against a fixture Core. The
// Overview reads GET /api/agents/{id}/executor: its task, template and
// dispatcher; its starting materials; its template's steps, each with the
// state its record gives; what it does now; its PR's changes; its evidence,
// each with its own conclusion; its result. While it needs you, its request's
// card is in the Overview, not also in the Conversation; the composer is the
// Conversation's. A standing Agent has no tabs and no such read. Presence is
// asserted as booleans: a failing assertion on an element would inspect the
// whole window.
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

// From one moment, before any page's clock starts: a time read later is never short of its minutes.
const base = Date.now();
const at = (minutes) => new Date(base - minutes * 60_000).toISOString();
const project = { id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" };
const agent = (id, extra = {}) => ({
  id, name: `Agent ${id}`, goal: "", cwd: "/synthetic/work", model: "m", color: "sage", status: "idle", harness: "codex",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", ...extra,
});
const lifecycle = (id, extra = {}) => ({
  state: "running", agentId: id, dispatcher: { kind: "agent", id: "lead", name: "Dev Lead" },
  task: { id: `YN-${id}`, title: `Work ${id}` }, template: { id: "red-first", label: "Red first" }, dispatchedAt: at(65), since: at(5), ...extra,
});
const executor = (id, extra = {}) => agent(id, { name: `YN-${id} · Red first`, kind: "executor", executor: lifecycle(id), ...extra });
const approval = { id: "q1", agentId: "w", method: "item/commandExecution/requestApproval", createdAt: "2026-11-07",
  params: { command: "npm run build" } };
const agents = () => [
  executor("k", { status: "working", workSummary: { kind: "progress", source: "agent", text: "Writing the failing test" } }),
  executor("w", { status: "waiting", pendingCount: 1, workSummary: { kind: "pending", source: "runtime", text: "Allow npm run build", requestId: "q1" } }),
  agent("s"),
];
const head = "2".repeat(40);
// Core's answer for k: eight steps, a red Job then a green one, PR #688 in
// review on its head, CI green, waiting in the merge queue, a result in.
const overviewOf = (id) => ({
  agentId: id,
  lifecycle: lifecycle(id),
  task: { id: `YN-${id}`, title: `Work ${id}`, status: "doing" },
  template: { id: "red-first", label: "Red first", deliveryMode: "pr" },
  materials: { capturedAt: at(65), acceptance: "The failing test passes; nothing else changes", repository: "owner/repo",
    baseSha: "635caab1".padEnd(40, "0"), worktree: "/synthetic/work/yn-k", returnRequirements: "Red then green; one PR",
    handoverVersion: 3, contextSummary: "Synthetic summary" },
  steps: id === "w"
    ? [{ kind: "materials", state: "done", ref: { kind: "mail", readAt: at(60) } },
      { kind: "gate", label: "Approve the build", approver: "user", state: "blocked" },
      { kind: "work", state: "todo" }]
    : [
      { kind: "materials", state: "done", ref: { kind: "mail", readAt: at(60) } },
      { kind: "work", label: "Write the failing test", state: "done" },
      { kind: "job", label: "Red, then green", state: "done", ref: { kind: "job", id: "j2", name: "green", status: "succeeded" } },
      { kind: "pr", state: "done", ref: { kind: "pr", number: 688, url: "https://github.com/owner/repo/pull/688", state: "open" } },
      { kind: "review", rounds: 2, state: "doing", ref: { kind: "review", id: "r1", round: 1, conclusion: null, forCurrentHead: true } },
      { kind: "ci", state: "done", ref: { kind: "ci", state: "success", headSha: head } },
      { kind: "merge", state: "doing", ref: { kind: "merge", id: "m1", state: "waiting", reason: null } },
      { kind: "result", state: "done", ref: { kind: "result", id: "res12345678", reportedAt: at(2) } },
    ],
  jobs: id === "w" ? [] : [
    { id: "j2", name: "green", status: "succeeded", finishedAt: at(20) },
    { id: "j1", name: "red", status: "failed", reason: "exit-code", finishedAt: at(30) },
  ],
  pullRequest: id === "w" ? null : {
    number: 688, url: "https://github.com/owner/repo/pull/688", title: "Fix the selection", state: "open", headSha: head,
    ci: { state: "success", headSha: head },
    latestReview: { reviewId: "r1", round: 1, status: "running", conclusion: null, forCurrentHead: true },
    changes: { additions: 120, deletions: 30, files: 7 },
  },
  merge: id === "w" ? null : { id: "m1", state: "waiting", reason: "Waiting for its turn", number: 688, headSha: head },
  result: id === "w" ? null : { id: "res12345678", summary: "Red 1/1 before, green 24/24 after.", reportedAt: at(2), status: "submitted" },
});

async function mount({ storage = {}, overview = (id) => overviewOf(id), select = "k" } = {}) {
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
    calls.push({ url, method: init.method || "GET" });
    if (url.endsWith("/api/workspace")) return respond({ workspace: { id: "ws-overview" }, projects: [project], agents: listed, runtime: { connected: true }, defaultCwd: "/w" });
    if (url.endsWith("/api/home")) return respond({ generatedAt: at(0), order: ["p"], needsYou: [], projects: [] });
    if (url.endsWith("/api/executors/live")) return respond({ executors: {} });
    if (url.endsWith("/task_list")) return respond({ tasks: [], counts: {}, hasMore: false });
    const executorRead = url.match(/\/api\/agents\/(\w)\/executor$/);
    if (executorRead) {
      const answer = overview(executorRead[1]);
      return answer ? respond(answer) : respond({ error: "Overview unavailable" }, 500);
    }
    const detail = url.match(/\/api\/agents\/(\w)$/);
    if (detail) return respond({ agent: listed.find((a) => a.id === detail[1]), pending: detail[1] === "w" ? [approval] : [],
      artifacts: [], messageReceipts: [], turns: [] });
    if (url.endsWith("/api/machines")) return respond({ machines: [] });
    return respond({});
  };
  const doc = w.document;
  w.eval(bundle);
  await waitFor(() => doc.querySelector('.agent-list article[data-agent-id="s"]'), "the sidebar lists the Agents");
  const open = (id) => doc.querySelector(`.agent-list article[data-agent-id="${id}"] .agent-select`).click();
  if (select) open(select);
  const overviewPanel = () => doc.querySelector("#executor-overview");
  const tab = (name) => [...doc.querySelectorAll('.executor-tabs [role="tab"]')].find((b) => b.textContent === name) ?? null;
  return {
    w, doc, calls, errors, open, overviewPanel, tab,
    reads: (id) => calls.filter((c) => c.url.endsWith(`/api/agents/${id}/executor`)).length,
    loaded: () => !!overviewPanel()?.querySelector(".executor-overview-head"),
    text: (selector) => overviewPanel()?.querySelector(selector)?.textContent ?? null,
    all: (selector) => [...(overviewPanel()?.querySelectorAll(selector) ?? [])].map((el) => el.textContent),
    body: () => doc.querySelector(".conversation-body"),
    composer: () => doc.querySelector(".composer-area"),
    close: () => w.close(),
  };
}

test("an executor opens on its Overview: its task, materials, steps, changes, evidence and result", async () => {
  const p = await mount();
  try {
    await waitFor(p.loaded, "k's Overview is read");
    assert.equal(p.reads("k"), 1, "one read of its Overview");
    assert.deepEqual([...p.doc.querySelectorAll('.executor-tabs [role="tab"]')].map((b) => [b.textContent, b.getAttribute("aria-selected")]),
      [["Overview", "true"], ["Conversation", "false"]], "Overview first, and chosen");
    assert.equal(p.tab("Overview").getAttribute("aria-controls"), "executor-overview");
    assert.equal(p.body().hidden, true, "its conversation is kept, hidden");
    assert.equal(p.body().getAttribute("role"), "tabpanel");
    assert.equal(p.composer().hidden, true, "the composer is its Conversation's");
    assert.equal(p.text(".executor-overview-head h2"), "YN-k · Work k");
    assert.deepEqual(p.all(".executor-overview-chips .chip"), ["Template Red first", "Dispatched by Dev Lead", "Running", "On it for 1 h 05 min", "Open task"]);
    // Starting materials, from the dispatch's snapshot.
    assert.deepEqual(p.all(".executor-overview-kv dt"), ["Acceptance", "Repository @ base", "Worktree", "Return requirements", "Handover version", "Context summary"]);
    assert.equal(p.all(".executor-overview-kv dd")[1], "owner/repo @ 635caab1");
    // Five steps, then the rest on request; each its label (or its kind's word), state and record.
    const steps = () => [...p.overviewPanel().querySelectorAll(".executor-overview-steps .step")].map((s) =>
      [s.dataset.state, s.querySelector(".label").textContent, s.querySelector(".ref").textContent]);
    assert.deepEqual(steps(), [
      ["done", "Read the materials", ""],
      ["done", "Write the failing test", ""],
      ["done", "Red, then green", "green · succeeded"],
      ["done", "Pull request", "#688"],
      ["doing", "Review", "round 1"],
    ]);
    assert.deepEqual(p.all(".executor-overview-steps .state"), ["done", "done", "done", "done", "under way"], "each state has its word");
    const more = p.overviewPanel().querySelector(".executor-overview-card .more");
    assert.equal(more.textContent, "3 more");
    more.click();
    await waitFor(() => steps().length === 8, "all eight steps");
    assert.deepEqual(steps().slice(5), [["done", "CI", "success"], ["doing", "Merge", "waiting"], ["done", "Submit a result", "res12345"]]);
    assert.equal(p.text(".executor-overview-now"), "Doing nowWriting the failing test");
    // Changes: its PR's size, from Core's GitHub record.
    assert.match(p.overviewPanel().textContent, /Changes \+120 −30 · 7 files/);
    assert.equal(p.overviewPanel().querySelector('a[href="https://github.com/owner/repo/pull/688"]').textContent, "#688 · Fix the selection");
    // Evidence: each record with its own conclusion and tone.
    assert.deepEqual([...p.overviewPanel().querySelectorAll(".executor-overview-evidence li")].map((li) =>
      [li.querySelector(".k").textContent, li.querySelector(".n").textContent, li.querySelector(".v").textContent, li.querySelector(".v").dataset.tone]), [
      ["Job", "green", "succeeded", "ok"],
      ["Job", "red", "failed", "bad"],
      ["Review", "#688 · round 1", "running", "wait"],
      ["CI", "#688", "success", "ok"],
      ["Merge", "Waiting for its turn", "waiting", "wait"],
    ]);
    assert.equal(p.text(".executor-overview-report"), "Red 1/1 before, green 24/24 after.");
    assert.equal(p.overviewPanel().querySelector(".executor-overview-banner, .executor-overview-requests"), null, "it needs nothing of you");
    // Its task opens from the header.
    const tasks = [];
    p.w.addEventListener("yuzuno:open-task-review", (event) => tasks.push(event.detail.taskId));
    [...p.overviewPanel().querySelectorAll(".chip.link")][0].click();
    assert.deepEqual(tasks, ["YN-k"]);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("its request is answered in the Overview while it shows, in the Conversation otherwise, never in both", async () => {
  const p = await mount({ select: "w" });
  try {
    await waitFor(() => p.loaded() && !!p.overviewPanel().querySelector(".executor-overview-requests .pending-card"),
      "w's request in its Overview");
    const requests = p.overviewPanel().querySelector(".executor-overview-requests");
    assert.equal(requests.querySelector(".pending-tag").textContent, "Needs you", "its card says it, once");
    assert.equal(p.overviewPanel().querySelector(".executor-overview-banner"), null);
    assert.ok([...requests.querySelectorAll("button")].some((b) => b.textContent === "Allow once"), "the request's own card");
    assert.equal(requests.querySelector(".note").textContent, "Answer here, in its conversation or on Home: one answer settles it everywhere.");
    assert.equal([...p.body().querySelectorAll("button")].some((b) => b.textContent === "Allow once"), false, "not also in the hidden Conversation");
    const gate = p.overviewPanel().querySelector('.executor-overview-steps .step[data-state="blocked"]');
    assert.deepEqual([gate.querySelector(".label").textContent, gate.querySelector(".ref").textContent], ["Approve the build", "By you"]);
    assert.match(p.overviewPanel().textContent, /No pull request yet\./);
    assert.match(p.overviewPanel().textContent, /No Jobs, reviews or CI yet\./);
    assert.match(p.overviewPanel().textContent, /No result handed in yet\./);
    // The Conversation, by keyboard: the card moves there, with the composer.
    p.tab("Overview").focus();
    p.tab("Overview").dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await waitFor(() => p.tab("Conversation").getAttribute("aria-selected") === "true", "ArrowRight chooses its Conversation");
    assert.equal(p.doc.activeElement, p.tab("Conversation"), "and moves focus there");
    assert.equal(p.overviewPanel(), null);
    assert.equal(p.body().hidden, false);
    assert.equal(p.composer().hidden, false);
    await waitFor(() => [...p.body().querySelectorAll("button")].some((b) => b.textContent === "Allow once"), "the card in its Conversation");
    // And back: read again, the card with it.
    p.tab("Conversation").dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await waitFor(() => p.loaded(), "Home key: its Overview again");
    assert.equal([...p.body().querySelectorAll("button")].some((b) => b.textContent === "Allow once"), false);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("each executor keeps the tab chosen; a standing Agent has no tabs and no Overview read", async () => {
  const p = await mount();
  try {
    await waitFor(p.loaded, "k's Overview");
    p.tab("Conversation").click();
    await waitFor(() => p.body().hidden === false, "k's Conversation");
    p.open("s");
    await waitFor(() => p.calls.some((c) => c.url.endsWith("/api/agents/s")), "s's conversation opens");
    await pause(80);
    assert.equal(p.doc.querySelector(".executor-tabs"), null, "no tabs for a standing Agent");
    assert.equal(p.body().hidden, false);
    assert.equal(p.body().getAttribute("role"), null);
    assert.equal(p.reads("s"), 0, "nothing read for it");
    p.open("w");
    await waitFor(p.loaded, "w opens on its Overview");
    p.open("k");
    await waitFor(() => p.tab("Conversation")?.getAttribute("aria-selected") === "true" && p.body().hidden === false, "k as it was left: its Conversation");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a failed read says so and is tried again on request", async () => {
  let fail = true;
  const p = await mount({ overview: (id) => (fail ? null : overviewOf(id)) });
  try {
    await waitFor(() => !!p.overviewPanel()?.querySelector('[role="alert"]'), "the failure");
    assert.match(p.text('[role="alert"]'), /^Couldn't read this executor's overview: /);
    fail = false;
    p.overviewPanel().querySelector('[role="alert"] button').click();
    await waitFor(p.loaded, "read again");
    assert.equal(p.reads("k"), 2);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("in Chinese the Overview reads in Chinese", async () => {
  const p = await mount({ storage: { "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) } });
  try {
    await waitFor(p.loaded, "k's Overview");
    assert.deepEqual([...p.doc.querySelectorAll('.executor-tabs [role="tab"]')].map((b) => b.textContent), ["概览", "会话"]);
    assert.deepEqual(p.all(".executor-overview-chips .chip"), ["模板 Red first", "派发者 Dev Lead", "运行中", "已用 1 小时 05 分", "打开任务"]);
    assert.deepEqual(p.all(".executor-overview-card h3").map((h) => h.split(/\s/)[0]), ["起始材料", "阶段", "变更", "证据坞", "收尾报告"]);
    assert.match(p.overviewPanel().textContent, /\+120 −30 · 7 个文件/);
    assert.deepEqual(p.all(".executor-overview-steps .label").slice(0, 1), ["读材料"]);
    assert.equal(p.text(".executor-overview-card .more"), "还有 3 步");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
