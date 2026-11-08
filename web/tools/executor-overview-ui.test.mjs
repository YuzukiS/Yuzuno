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

async function mount({ storage = {}, overview = (id) => overviewOf(id), select = "k", more = [], home = null } = {}) {
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
  const listed = [...agents(), ...more];
  w.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/api/workspace")) return respond({ workspace: { id: "ws-overview" }, projects: [project], agents: listed, runtime: { connected: true }, defaultCwd: "/w" });
    if (url.endsWith("/api/home")) return respond(home ?? { generatedAt: at(0), order: ["p"], needsYou: [], projects: [] });
    if (url.endsWith("/api/projects/p/brief/reply")) {
      const sent = JSON.parse(init.body);
      return respond({ messageId: "m1", clientMessageId: sent.clientMessageId, agentId: sent.agentId, status: "accepted" });
    }
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

// T-43 S4 (the user's option D): an executor at a gate asked on Home with
// its own Ask, naming its task and step. Home's Needs you lists it with the
// gate; Home's section is what the card shows.
const gateAsk = {
  key: "gates/design", kind: "ask", title: "Approve the design note", version: 2,
  owner: { agentId: "g", name: "YN-g · Design first", state: "active" }, updatedAt: at(12), updatedTurnId: null,
  body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["note"] },
    note: { type: "Markdown", props: { text: "One JSON file with a version; the old format still imports." } } } },
  attachments: [], refs: {}, seen: null, history: false,
  ask: { question: "Export as one JSON file or three?", state: "open", gate: { taskId: "YN-g", step: 1 },
    reply: { options: [{ id: "one", label: "One JSON file" }, { id: "three", label: "Three files" }] } },
};
const gateHome = {
  generatedAt: at(0), order: ["p"],
  needsYou: [{ kind: "ask", projectId: "p", agentId: "g", agentName: "YN-g · Design first", sectionKey: "gates/design",
    title: "Approve the design note", since: at(12), gate: { taskId: "YN-g", step: 1 } }],
  projects: [{ project: { id: "p", name: "App" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], brief: { version: 3, sections: [gateAsk], history: [] }, unseen: 0, missing: [] }],
};
const gateOverview = (id) => id !== "g" ? overviewOf(id) : {
  ...overviewOf("w"), agentId: "g", lifecycle: lifecycle("g"), task: { id: "YN-g", title: "Work g", status: "doing" },
  steps: [{ kind: "materials", state: "done", ref: { kind: "mail", readAt: at(60) } },
    { kind: "gate", label: "Approve the design note", approver: "user", state: "blocked",
      ref: { kind: "ask", projectId: "p", key: "gates/design", version: 2, state: "open", since: at(12), repliedAt: null } },
    { kind: "work", label: "Slices", state: "todo" }],
};

test("a gate it asked about on Home is answered in its Overview with Home's own reply, and in its Conversation otherwise (T-43 S4)", async () => {
  const p = await mount({ select: "g", more: [executor("g", { status: "idle" })], home: gateHome, overview: gateOverview });
  try {
    await waitFor(() => p.loaded() && !!p.overviewPanel().querySelector(".gate-ask .home-ask-options"), "g's gate ask in its Overview");
    const card = p.overviewPanel().querySelector(".gate-ask");
    assert.equal(card.querySelector("h3").textContent, "Waiting for your approval · Approve the design note");
    assert.equal(card.querySelector(".gate-ask-question").textContent, "Export as one JSON file or three?");
    assert.match(card.querySelector(".gate-ask-body").textContent, /One JSON file with a version; the old format still imports\./, "what it asks with, as on Home");
    assert.equal(card.querySelector(".note").textContent, "Its executor asked this on Home. Answer here, in its other tab or on Home: one answer settles it everywhere.");
    const gate = p.overviewPanel().querySelector('.executor-overview-steps .step[data-state="blocked"]');
    assert.deepEqual([gate.querySelector(".label").textContent, gate.querySelector(".state").textContent, gate.querySelector(".ref").textContent],
      ["Approve the design note", "waiting for you", "asked on Home"]);
    assert.equal(p.body().querySelector(".gate-ask"), null, "not also in the hidden Conversation");
    // Its row needs you, as a request would: the gate's ask waits on Home.
    const row = p.doc.querySelector('.agent-list article[data-agent-id="g"]');
    assert.equal(row.querySelector(".agent-island")?.getAttribute("data-state"), "waiting", "its ring needs you");
    // Answered here: Home's reply to that version of the ask, to its executor.
    [...card.querySelectorAll(".home-ask-options button")].find((b) => b.textContent === "One JSON file").click();
    await waitFor(() => p.calls.some((c) => c.url.endsWith("/api/projects/p/brief/reply")), "the reply sent");
    const sent = p.calls.find((c) => c.url.endsWith("/api/projects/p/brief/reply"));
    assert.equal(sent.method, "POST");
    assert.deepEqual([sent.body.key, sent.body.agentId, sent.body.choice, sent.body.askVersion, sent.body.workspaceId],
      ["gates/design", "g", "one", 2, "ws-overview"]);
    // The Conversation: the same card there instead.
    p.tab("Conversation").click();
    await waitFor(() => !!p.body().querySelector(".gate-ask"), "the card in its Conversation");
    assert.equal(p.body().querySelector(".gate-ask .gate-ask-question").textContent, "Export as one JSON file or three?");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("in Chinese the gate's card reads in Chinese (T-43 S4)", async () => {
  const p = await mount({ select: "g", more: [executor("g", { status: "idle" })], home: gateHome, overview: gateOverview,
    storage: { "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) } });
  try {
    await waitFor(() => p.loaded() && !!p.overviewPanel().querySelector(".gate-ask .home-ask-options"), "the card");
    const card = p.overviewPanel().querySelector(".gate-ask");
    assert.equal(card.querySelector("h3").textContent, "等你批准 · Approve the design note");
    assert.equal(card.querySelector(".note").textContent, "执行者在 Home 发的提问。在这里、另一个页签或 Home 回答都行，答一处各处都解决。");
    const gate = p.overviewPanel().querySelector('.executor-overview-steps .step[data-state="blocked"]');
    assert.deepEqual([gate.querySelector(".state").textContent, gate.querySelector(".ref").textContent], ["等你", "已在 Home 提问"]);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// T-43 S5: a red-first template's red Job and the green one after it, side
// by side in one row of the evidence dock; and the steps say their place.
const redGreenOverview = (id) => id !== "k" ? overviewOf(id) : {
  ...overviewOf("k"),
  steps: [
    { kind: "materials", state: "done", ref: { kind: "mail", readAt: at(60) } },
    { kind: "job", label: "Record the failing test red", state: "failed", ref: { kind: "job", id: "j1", name: "red 1/1", status: "failed" } },
    { kind: "work", label: "Fix, the test unchanged", state: "done" },
    { kind: "job", label: "Green", state: "done", ref: { kind: "job", id: "j2", name: "green 24/24", status: "succeeded" } },
    { kind: "pr", state: "todo" },
  ],
  jobs: [
    { id: "j3", name: "lint", status: "succeeded", finishedAt: at(10) },
    { id: "j2", name: "green 24/24", status: "succeeded", finishedAt: at(20) },
    { id: "j1", name: "red 1/1", status: "failed", reason: "exit-code", finishedAt: at(30) },
  ],
};

test("a red Job and the green one after it sit side by side, and the steps say their place (T-43 S5)", async () => {
  const p = await mount({ overview: redGreenOverview });
  try {
    await waitFor(p.loaded, "k's Overview");
    assert.deepEqual(p.all(".executor-overview-steps .no"), ["1", "2", "3", "4", "5"], "each step its place");
    const rows = [...p.overviewPanel().querySelectorAll(".executor-overview-evidence li")];
    const pair = rows[0];
    assert.equal(pair.className, "pair");
    assert.deepEqual([pair.querySelector(".k").textContent, pair.querySelector(".n").textContent, pair.querySelector(".v").textContent],
      ["Red → green", "red 1/1 → green 24/24", "failed → succeeded"]);
    assert.deepEqual([...pair.querySelectorAll(".v [data-tone]")].map((v) => v.dataset.tone), ["bad", "ok"]);
    // The two are that row's alone; another Job keeps its own row.
    const jobs = rows.filter((li) => li.querySelector(".k").textContent === "Job").map((li) => li.querySelector(".n").textContent);
    assert.deepEqual(jobs, ["lint"]);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
  // In Chinese; and without a green after the red, no pair.
  const zh = await mount({ overview: redGreenOverview, storage: { "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) } });
  try {
    await waitFor(zh.loaded, "the Chinese Overview");
    assert.equal(zh.overviewPanel().querySelector(".executor-overview-evidence .pair .k").textContent, "红 → 绿");
  } finally {
    zh.close();
  }
  const red = await mount({ overview: (id) => {
    const o = redGreenOverview(id);
    return id === "k" ? { ...o, steps: o.steps.map((s) => s.ref?.id === "j2" ? { kind: "job", label: "Green", state: "todo" } : s) } : o;
  } });
  try {
    await waitFor(red.loaded, "k's Overview, red only");
    assert.equal(red.overviewPanel().querySelector(".executor-overview-evidence .pair"), null, "a red Job alone is no pair");
    assert.equal(red.all(".executor-overview-evidence li .k").filter((k) => k === "Job").length, 3, "each Job its own row");
  } finally {
    red.close();
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
