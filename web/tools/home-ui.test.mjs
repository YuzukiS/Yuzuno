import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";
import { composerText } from "./composer-driver.mjs";

// Home (T-85) against an in-memory Core: the built app, a fetch fixture, no
// real Core, Agents or GitHub.
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
const body = (text) => ({
  root: "body",
  elements: {
    body: { type: "BriefBody", props: {}, children: ["text"] },
    text: { type: "Markdown", props: { text } },
  },
});
const owner = (agentId, name) => ({ agentId, name, state: "active" });
const section = (key, kind, title, version, by, extra = {}) => ({
  key, kind, title, version, owner: by, updatedAt: at(5), updatedTurnId: "t1",
  body: body(`${title} body`), attachments: [], refs: {}, seen: null, history: false, ...extra,
});
const base = { model: "m", color: "sage", status: "idle", createdAt: "", updatedAt: "", goal: "", pendingCount: 0, lastSeq: 12, reviewedSeq: 12 };
const agents = [
  // Unread finished turns stay in the conversation; Home never lists them.
  { ...base, id: "a", name: "Mori", cwd: "/w/app", projectId: "p-app", unreadCount: 3, reviewedSeq: 4 },
  { ...base, id: "b", name: "Hana", cwd: "/w/app", projectId: "p-app", unreadCount: 0 },
  { ...base, id: "c", name: "Sora", cwd: "/w/res", projectId: "p-res", unreadCount: 2, pendingCount: 1 },
];
const projects = [
  { id: "p-app", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" },
  { id: "p-res", name: "Research", defaultDirs: {}, createdAt: "", updatedAt: "" },
  { id: "p-docs", name: "Docs", defaultDirs: {}, createdAt: "", updatedAt: "" },
];
const counts = (working, idle) => ({ working, idle, waiting: 0, error: 0, offline: 0, total: working + idle });
function homeFixture() {
  return {
    generatedAt: at(0),
    order: ["p-res", "p-app", "p-docs"],
    needsYou: [
      { kind: "ask", projectId: "p-app", agentId: "a", agentName: "Mori", sectionKey: "release", title: "Ship today?", since: at(30) },
      { kind: "approval", projectId: "p-res", agentId: "c", agentName: "Sora", requestId: "r-1", title: "Run the test suite", since: at(10) },
    ],
    projects: [
      {
        project: { id: "p-app", name: "App" },
        agents: counts(1, 1),
        errors: [],
        pending: [],
        jobs: [{ id: "job-1", name: "cargo test", status: "running", agentId: "a", agentName: "Mori" }],
        unseen: 2,
        missing: [{ agentId: "a", agentName: "Mori", turnId: "t9", at: at(3), outcome: "missing" }],
        brief: {
          version: 7,
          history: [section("old", "report", "Last week", 1, owner("a", "Mori"), { history: true, seen: { version: 1, at: at(900) } })],
          sections: [
            section("release", "ask", "Ship today?", 3, owner("a", "Mori"), {
              ask: { question: "Ship the release today?", state: "open", reply: { options: [{ id: "ship", label: "Ship today" }, { id: "wait", label: "Wait" }], freeText: true } },
            }),
            section("notes", "report", "Notes", 2, owner("a", "Mori"), { seen: { version: 2, at: at(60) } }),
            section("notes/review", "report", "Review notes", 1, owner("b", "Hana")),
            section("budget", "ask", "Which plan?", 1, owner("b", "Hana"), {
              ask: { question: "Plan A or B?", state: "open", reply: { choice: { a: { id: "plan-a", label: "Plan A" }, b: { id: "plan-b", label: "Plan B", detail: "Slower, safer" } } } },
            }),
          ],
        },
      },
      {
        project: { id: "p-res", name: "Research" },
        agents: counts(0, 1),
        errors: [{ agentId: "c", agentName: "Sora", message: "Codex exited unexpectedly", at: at(2) }],
        pending: [{ id: "r-1", agentId: "c", agentName: "Sora", method: "item/commandExecution/requestApproval", params: { command: "npm test", reason: "Run the test suite" }, createdAt: at(10) }],
        jobs: [],
        unseen: 0,
        missing: [],
        brief: {
          version: 2,
          history: [],
          sections: [section("metrics", "status", "Loss", 4, owner("c", "Sora"), { seen: { version: 4, at: at(20) }, status: { asOf: at(120), validFor: 3600, stale: true } })],
        },
      },
      {
        project: { id: "p-docs", name: "Docs" },
        agents: counts(0, 0),
        errors: [],
        pending: [],
        jobs: [],
        unseen: 0,
        missing: [],
        brief: { version: 1, history: [], sections: [section("guide", "report", "Guide", 1, owner("b", "Hana"), { seen: { version: 1, at: at(50) } })] },
      },
    ],
  };
}
const machineLoad = () => ({
  at: at(0),
  cpu: { cores: 16, totalPct: 42, jobsPct: 10, agentsPct: null, otherPct: null },
  memory: { totalMiB: 65536, usedMiB: 32000, availableMiB: 33536, jobsMiB: 2048, agentsMiB: null },
  gpus: null,
  jobs: [{ id: "job-1", name: "cargo test", agentId: "a", agentName: "Mori", projectId: "p-app", cpuPct: null, memMiB: 512 }],
});

async function mount({ storage = {}, home = homeFixture(), failReplies = 0, replyStatus = "accepted", replyAnswer = null, workspace = "ws-home", holdWorkspace = false, load = machineLoad, linked = [], workspaceAgents = agents } = {}) {
  // holdWorkspace: /api/workspace answers only on releaseWorkspace(), so Home opens first.
  let releaseWorkspace = () => {};
  const workspaceRead = holdWorkspace ? new Promise((resolve) => (releaseWorkspace = resolve)) : null;
  const calls = [];
  const errors = [];
  // What the app logs as errors, React's caught render errors among them.
  const logged = [];
  const scrolled = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  vc.on("error", (...args) => logged.push(args.map(String).join(" ")));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4317/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window;
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
  w.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  const streams = [];
  w.EventSource = class {
    constructor() { streams.push(this); }
    addEventListener() {}
    close() {}
  };
  w.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
  w.HTMLElement.prototype.scrollTo = function () {};
  let visibility = "visible";
  Object.defineProperty(w.document, "visibilityState", { configurable: true, get: () => visibility });
  const state = { home, failReplies };
  const respond = (value, status = 200) => {
    const text = JSON.stringify(value);
    return { ok: status === 200, status, json: async () => JSON.parse(text), text: async () => text };
  };
  w.fetch = async (url, init = {}) => {
    const request = { url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(request);
    if (url.endsWith("/api/workspace")) {
      await workspaceRead;
      return respond({ workspace: { id: workspace }, projects, agents: workspaceAgents, runtime: { connected: true }, defaultCwd: "/w" });
    }
    if (url.endsWith("/api/home")) return respond(state.home);
    if (url.endsWith("/api/machine-load")) return respond(load());
    if (url.endsWith("/api/home/order")) {
      state.home.order = request.body.projectIds;
      return respond({ order: request.body.projectIds });
    }
    if (/\/api\/projects\/[^/]+\/brief\/seen$/.test(url)) return respond({ ok: true });
    if (/\/api\/projects\/[^/]+\/brief\/reply$/.test(url)) {
      if (state.failReplies > 0) {
        state.failReplies--;
        return respond({ error: "connection lost" }, 503);
      }
      // [status, body] for this request, or null for the usual receipt; a
      // promise of either holds the answer until it settles.
      const answer = await replyAnswer?.(request.body);
      if (answer) return respond(answer[1], answer[0]);
      return respond({ input: { ...request.body, expectedTurnId: null, question: null }, status: replyStatus, turnId: "t10", error: null });
    }
    if (/\/api\/requests\/[^/]+\/respond$/.test(url)) return respond({ ok: true });
    if (url.endsWith("/api/collaboration/github_repositories"))
      return respond({ repositories: request.body?.projectId === "p-app" ? linked : [], links: [] });
    if (url.endsWith("/api/projects/p-app/repo-activity"))
      return respond({ observedAt: at(1), repositories: linked.map((repo) => ({ ...repo, observedAt: at(1), commits: [], pulls: [], runs: [], stale: false })) });
    const detail = url.match(/\/api\/agents\/(\w)$/);
    if (detail) {
      const agent = workspaceAgents.find((a) => a.id === detail[1]);
      return respond({ agent, pending: [], artifacts: [], messageReceipts: [], turns: [] });
    }
    if (url.endsWith("/api/machines")) return respond({ machines: [] });
    return respond({});
  };
  const doc = w.document;
  const button = (text, root = doc) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text));
  const panel = (id) => doc.querySelector(`[data-home-project="${id}"]`);
  try {
    w.eval(bundle);
    // Home's memory is per workspace: open it once the workspace is read.
    if (holdWorkspace) await waitFor(() => button("Home"), "the toolbar is drawn");
    else await waitFor(() => button("Home") && /Mori/.test(doc.querySelector(".agent-list")?.textContent || ""), "the workspace is read");
    button("Home").click();
    await waitFor(() => doc.querySelector("[data-home-project]"), "Home read its panels");
  } catch (error) {
    w.close();
    throw error;
  }
  return {
    w, doc, calls, errors, logged, scrolled, state, button, panel, releaseWorkspace,
    setVisibility(value) {
      visibility = value;
      doc.dispatchEvent(new w.Event("visibilitychange"));
    },
    posts: (pattern) => calls.filter((c) => c.method === "POST" && pattern.test(c.url)),
    /** Core's event stream, as the open connection delivers it. */
    event: (value) => streams.at(-1)?.onmessage?.({ data: JSON.stringify(value), lastEventId: "" }),
    close: () => w.close(),
  };
}
async function type(p, element, value) {
  const proto = element.tagName === "TEXTAREA" ? p.w.HTMLTextAreaElement.prototype : p.w.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
  element.dispatchEvent(new p.w.Event("input", { bubbles: true }));
  await pause();
}
async function choose(p, select, value) {
  Object.getOwnPropertyDescriptor(p.w.HTMLSelectElement.prototype, "value").set.call(select, value);
  select.dispatchEvent(new p.w.Event("change", { bubbles: true }));
  await pause();
}
const card = (p, projectId, key) => p.doc.getElementById(`home-section-${projectId}-${key}`);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("Home replaces Catch up: panels follow Project Priority, needs you jumps, no unread turns are listed", async () => {
  const p = await mount();
  try {
    assert.ok(!p.button("Catch up"), "the toolbar has Home, not Catch up");
    assert.equal(p.doc.querySelector(".catchup-nav.selected .toolbar-nav-label").textContent, "Home");
    assert.equal(p.calls.filter((c) => c.url.includes("/api/catchup")).length, 0, "Catch up is never read");
    assert.deepEqual(
      [...p.doc.querySelectorAll("[data-home-project]")].map((e) => e.dataset.homeProject),
      ["p-res", "p-app", "p-docs"],
      "panels in Core's order, not the project list's",
    );
    assert.deepEqual(
      [...p.doc.querySelectorAll("[data-needs-you]")].map((e) => e.dataset.needsYou),
      ["ask:p-app:release", "approval:r-1"],
      "needs-you items in Core's order",
    );
    // The project header has Core facts only: no unread finished turns, no extracted answers.
    for (const head of p.doc.querySelectorAll(".home-panel-head")) assert.doesNotMatch(head.textContent, /unread|final answer/i);
    assert.doesNotMatch(p.doc.querySelector(".home-view").textContent, /unread/i);
    assert.match(p.panel("p-app").querySelector(".home-agent-counts").textContent, /1 working.*1 idle.*0 waiting.*0 errors/);
    // Counts read as words: one job, one error, one item that needs you.
    assert.deepEqual([...p.panel("p-app").querySelectorAll(".home-chip")].map((c) => c.textContent), ["2 new", "1 needs you"]);
    assert.deepEqual([...p.panel("p-res").querySelectorAll(".home-chip")].map((c) => c.textContent), ["1 needs you"]);
    await waitFor(() => /of 16 cores/.test(p.doc.querySelector(".home-machines").textContent), "cores read as a plural");
    assert.match(p.panel("p-app").textContent, /Mori ended a turn without updating the Brief/);
    // A sub-topic sits under its parent, labelled with its own author.
    const sub = card(p, "p-app", "notes/review");
    assert.ok(sub.closest(".home-topic[data-topic=notes] .home-subs"), "notes/review is merged under notes");
    assert.match(sub.querySelector(".home-owner").textContent, /by Hana/);
    // A stale status is greyed and says how old its data is.
    assert.ok(card(p, "p-res", "metrics").classList.contains("is-stale"));
    assert.match(card(p, "p-res", "metrics").textContent, /Data as of/);
    // Jumping from the needs-you row highlights the approval in its panel.
    p.doc.querySelector('[data-needs-you="approval:r-1"]').click();
    await waitFor(() => p.doc.getElementById("home-request-r-1")?.hasAttribute("data-home-highlight"), "the approval is highlighted");
    assert.ok(p.scrolled.includes(p.doc.getElementById("home-request-r-1")), "the approval was scrolled to");
    // The approval answers from Home.
    p.button("Allow once", p.panel("p-res")).click();
    await waitFor(() => p.posts(/\/api\/requests\/r-1\/respond$/).length === 1, "the approval was sent");
    assert.deepEqual(p.posts(/\/respond$/)[0].body, { response: { decision: "accept" } });
    // An ask jumps to its section.
    p.doc.querySelector('[data-needs-you="ask:p-app:release"]').click();
    await waitFor(() => card(p, "p-app", "release").hasAttribute("data-home-highlight"), "the ask is highlighted");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a panel the user collapsed or expanded stays that way per workspace and project", async () => {
  const p = await mount();
  let stored;
  try {
    assert.ok(p.panel("p-docs").classList.contains("is-collapsed"), "nothing changed since seen: one line");
    assert.match(p.panel("p-docs").textContent, /Nothing new since you looked/);
    assert.equal(card(p, "p-docs", "guide"), null);
    assert.ok(!p.panel("p-app").classList.contains("is-collapsed"), "unseen changes are open");
    assert.ok(!p.panel("p-res").classList.contains("is-collapsed"), "a pending approval keeps it open");
    p.panel("p-docs").querySelector(".home-panel-toggle").click();
    p.panel("p-app").querySelector(".home-panel-toggle").click();
    await pause();
    assert.ok(card(p, "p-docs", "guide"), "expanded by hand");
    assert.ok(p.panel("p-app").classList.contains("is-collapsed"), "collapsed by hand");
    assert.equal(p.w.localStorage.getItem('yuzuno.home-panel.v1:["ws-home","p-docs"]'), '"expanded"');
    assert.equal(p.w.localStorage.getItem('yuzuno.home-panel.v1:["ws-home","p-app"]'), '"collapsed"');
    // A panel the user has not acted in follows Core's later reads: once
    // nothing waits there, it folds by itself.
    const research = p.state.home.projects[1];
    research.pending = [];
    p.state.home.needsYou = p.state.home.needsYou.filter((item) => item.projectId !== "p-res");
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => p.panel("p-res").classList.contains("is-collapsed"), "an untouched quiet panel folds");
    assert.equal(p.w.localStorage.getItem('yuzuno.home-panel.v1:["ws-home","p-res"]'), null, "an automatic fold is not remembered");
    const storage = p.w.localStorage;
    stored = Object.fromEntries(Array.from({ length: storage.length }, (_, i) => [storage.key(i), storage.getItem(storage.key(i))]));
  } finally {
    p.close();
  }
  const again = await mount({ storage: stored });
  try {
    assert.ok(!again.panel("p-docs").classList.contains("is-collapsed"), "remembered expanded");
    assert.ok(again.panel("p-app").classList.contains("is-collapsed"), "remembered collapsed, even with changes");
    assert.match(again.panel("p-app").querySelector(".home-panel-chips").textContent, /2 new/);
  } finally {
    again.close();
  }
});

test("Seen sends exactly the versions on screen; one arriving meanwhile stays unseen", async () => {
  const p = await mount();
  try {
    const release = card(p, "p-app", "release");
    assert.equal(release.dataset.sectionVersion, "3");
    assert.ok(release.classList.contains("is-changed"));
    assert.equal(card(p, "p-app", "notes").classList.contains("is-changed"), false, "a seen version is not highlighted");
    // Core has a newer version, not yet read by this window.
    p.state.home.projects[0].brief.sections[0].version = 4;
    p.button("Seen", release).click();
    await waitFor(() => p.posts(/\/brief\/seen$/).length === 1, "seen was sent");
    const [mark] = p.posts(/\/brief\/seen$/);
    assert.match(mark.url, /\/api\/projects\/p-app\/brief\/seen$/);
    assert.deepEqual(mark.body, { sections: [{ key: "release", version: 3 }] });
    await waitFor(() => card(p, "p-app", "release").dataset.sectionVersion === "4", "Home read again after Seen");
    assert.ok(card(p, "p-app", "release").classList.contains("is-changed"), "the newer version is still unseen");
    // Core's next read finds nothing waiting in App any more.
    const app = p.state.home.projects[0];
    app.unseen = 0;
    for (const s of app.brief.sections) s.seen = { version: s.version, at: at(0) };
    p.state.home.needsYou = p.state.home.needsYou.filter((item) => item.projectId !== "p-app");
    p.button("Seen all", p.panel("p-app")).click();
    await waitFor(() => p.posts(/\/brief\/seen$/).length === 2, "seen all was sent");
    assert.deepEqual(p.posts(/\/brief\/seen$/)[1].body, {
      sections: [
        { key: "release", version: 4 },
        { key: "notes", version: 2 },
        { key: "notes/review", version: 1 },
        { key: "budget", version: 1 },
      ],
    });
    await waitFor(() => !card(p, "p-app", "release").classList.contains("is-changed"), "Home read again after Seen all");
    assert.equal(p.panel("p-app").classList.contains("is-collapsed"), false, "the user's own Seen all never folds the panel under the pointer");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("the Home tab counts what Needs you lists, requests and open Asks, and keeps counting with Home closed", async () => {
  const p = await mount();
  const count = () => p.doc.querySelector(".catchup-nav .nav-count")?.textContent ?? null;
  const homeReads = () => p.calls.filter((c) => c.url.endsWith("/api/home")).length;
  try {
    // Sora's request and Mori's Ask; Mori's unread turns are not counted.
    await waitFor(() => count() === "2", "a request and an Ask");
    assert.equal(p.button("Home").title, "Home · 2 waiting for your response");
    // Home's own read is the count: an Ask answered elsewhere leaves it.
    p.state.home.needsYou = p.state.home.needsYou.filter((item) => item.kind !== "ask");
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => count() === "1", "the Ask left Needs you");
    p.button("Sora", p.panel("p-res").querySelector(".home-error")).click();
    await waitFor(() => p.doc.querySelector(".conversation-title h1")?.textContent === "Sora", "Sora's conversation is open");
    assert.equal(p.doc.querySelector(".home-view"), null);
    // Home is closed: a Brief change reads Needs you again for the count.
    await pause(300);
    const before = homeReads();
    p.state.home.needsYou.push(
      { kind: "ask", projectId: "p-res", agentId: "c", agentName: "Sora", sectionKey: "seed", title: "Which seed?", since: at(1) },
      { kind: "ask", projectId: "p-app", agentId: "b", agentName: "Hana", sectionKey: "budget", title: "Which plan?", since: at(1) },
    );
    p.event({ type: "workspace.changed", scope: "brief" });
    await waitFor(() => count() === "3", "two new Asks while Home is closed");
    assert.ok(homeReads() > before, "read for the count");
    assert.equal(p.button("Home").title, "Home · 3 waiting for your response");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a newer version marks only the blocks it added or changed, against what this device showed at the seen version", async () => {
  const notes = ({ summary, extra = false } = {}) => ({
    root: "body",
    elements: {
      body: { type: "BriefBody", props: {}, children: ["summary", "facts", ...(extra ? ["added"] : []), "more"] },
      summary: { type: "Markdown", props: { text: summary ?? "Two of three steps are done." } },
      // A body cannot mark a block itself.
      facts: { type: "Metrics", props: { items: [{ label: "Steps", value: 2 }], yuzunoChange: "updated" } },
      added: { type: "Group", props: { title: "Next" }, children: ["addedText"] },
      addedText: { type: "Markdown", props: { text: "Step three starts tomorrow." } },
      more: { type: "Group", props: { title: "Details" }, children: ["detail"] },
      detail: { type: "Markdown", props: { text: "Kept as it was." } },
    },
  });
  const v3 = { summary: "All three steps are done.", extra: true };
  const home = homeFixture();
  const shown = home.projects[0].brief.sections[1];
  Object.assign(shown, { version: 2, seen: { version: 2, at: at(60) }, body: notes() });
  const p = await mount({ home });
  const key = 'yuzuno.home-seen-blocks.v1:["ws-home","p-app","notes",null]';
  const marks = () => [...card(p, "p-app", "notes").querySelectorAll(".brief-change")].map((el) => [
    el.dataset.change,
    el.querySelector(":scope > .brief-change-mark").textContent,
    el.textContent.trim().slice(0, 40),
  ]);
  let stored;
  try {
    await waitFor(() => p.w.localStorage.getItem(key), "the seen version's blocks are kept");
    assert.equal(JSON.parse(p.w.localStorage.getItem(key)).version, 2);
    assert.deepEqual(marks(), [], "nothing is marked at the seen version");
    // Version 3 rewrites the summary and adds a group; the rest is as it was.
    Object.assign(shown, { version: 3, body: notes(v3) });
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => card(p, "p-app", "notes").dataset.sectionVersion === "3", "version 3 is shown");
    assert.ok(card(p, "p-app", "notes").classList.contains("is-changed"));
    assert.equal(card(p, "p-app", "notes").querySelector(".home-changed").textContent, "Updated");
    assert.deepEqual(marks(), [
      ["updated", "Updated", "UpdatedAll three steps are done."],
      ["new", "New", "NewNextStep three starts tomorrow."],
    ], "the new group is marked once, its own block is not marked again");
    assert.equal(JSON.parse(p.w.localStorage.getItem(key)).version, 2, "an unseen version is not kept as seen");
    const storage = p.w.localStorage;
    stored = Object.fromEntries(Array.from({ length: storage.length }, (_, i) => [storage.key(i), storage.getItem(storage.key(i))]));
    // Marking it seen clears the marks and keeps version 3 as the one to compare with.
    shown.seen = { version: 3, at: at(0) };
    p.button("Seen", card(p, "p-app", "notes")).click();
    await waitFor(() => p.posts(/\/brief\/seen$/).length === 1, "seen was sent");
    await waitFor(() => !card(p, "p-app", "notes").classList.contains("is-changed"), "Home read again after Seen");
    assert.deepEqual(marks(), []);
    assert.equal(JSON.parse(p.w.localStorage.getItem(key)).version, 3);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
  const later = () => {
    const value = homeFixture();
    Object.assign(value.projects[0].brief.sections[1], { version: 3, seen: { version: 2, at: at(60) }, body: notes(v3) });
    return value;
  };
  // Another device never showed version 2: only the card says it changed.
  const elsewhere = await mount({ home: later() });
  try {
    assert.equal(card(elsewhere, "p-app", "notes").querySelector(".home-changed").textContent, "Updated");
    assert.equal(card(elsewhere, "p-app", "notes").querySelectorAll(".brief-change").length, 0);
  } finally {
    elsewhere.close();
  }
  // The same device, opened again later, still compares with version 2.
  const again = await mount({ storage: stored, home: later() });
  try {
    await waitFor(() => card(again, "p-app", "notes")?.querySelectorAll(".brief-change").length === 2, "the marks come back after a reload");
  } finally {
    again.close();
  }
});

test("a Sources block changed since the seen version is marked like any other, and Home still shows (T-142)", async () => {
  const notes = (prs) => ({
    root: "body",
    elements: {
      body: { type: "BriefBody", props: {}, children: ["summary", "links"] },
      summary: { type: "Markdown", props: { text: "Merged, not released." } },
      links: {
        type: "Sources",
        props: { items: prs.map((n) => ({ id: `pr${n}`, label: `PR #${n}`, href: `https://github.com/o/r/pull/${n}` })) },
      },
    },
  });
  const key = 'yuzuno.home-seen-blocks.v1:["ws-home","p-app","notes",null]';
  // This device shows version 2, the seen one, and keeps what it showed.
  const seen = homeFixture();
  Object.assign(seen.projects[0].brief.sections[1], { version: 2, seen: { version: 2, at: at(60) }, body: notes([1]) });
  const first = await mount({ home: seen });
  let stored;
  try {
    await waitFor(() => first.w.localStorage.getItem(key), "the seen version's blocks are kept");
    stored = { [key]: first.w.localStorage.getItem(key) };
    assert.deepEqual(first.errors, []);
  } finally {
    first.close();
  }
  // Version 3 adds a link. Opened again on this device, Home marks the
  // Sources block; the Markdown before it is as it was.
  const later = homeFixture();
  Object.assign(later.projects[0].brief.sections[1], { version: 3, seen: { version: 2, at: at(60) }, body: notes([1, 2]) });
  const p = await mount({ storage: stored, home: later });
  try {
    const shown = card(p, "p-app", "notes");
    assert.deepEqual(
      [...shown.querySelectorAll(".brief-change")].map((el) => [el.dataset.change, el.textContent.trim()]),
      [["updated", "UpdatedSourcesPR #1PR #2"]],
    );
    assert.deepEqual(
      [...shown.querySelectorAll(".result-sources a")].map((a) => a.href),
      ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"],
    );
    assert.deepEqual([...p.doc.querySelectorAll("[data-home-project]")].map((el) => el.dataset.homeProject), ["p-res", "p-app", "p-docs"]);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a section that can't be drawn says so in its place, is tried again once per new version, and the rest of the app still works", async () => {
  const home = homeFixture();
  // A Sources block the result contract refuses (an unknown prop), as a body
  // an older Core kept could carry.
  const links = (extra) => ({
    root: "body",
    elements: {
      body: { type: "BriefBody", props: {}, children: ["links"] },
      links: { type: "Sources", props: { items: [{ id: "s1", label: "Spec", href: "https://example.com/spec" }], ...extra } },
    },
  });
  const notes = home.projects[0].brief.sections[1];
  Object.assign(notes, { body: links({ note: "older" }) });
  const p = await mount({ home });
  // Each time the section is drawn and refused, React reports the caught error once.
  const refused = () => p.logged.filter((line) => /ZodError|unrecognized_keys/i.test(line)).length;
  const unreadable = () => card(p, "p-app", "notes").querySelector(".result-part-error")?.textContent;
  const reads = () => p.calls.filter((c) => c.url.endsWith("/api/home")).length;
  async function refresh(what) {
    const before = reads();
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => reads() > before, `Home is read again: ${what}`);
    await pause(150);
  }
  try {
    assert.equal(unreadable(), "This section couldn't be displayed.");
    assert.match(card(p, "p-app", "notes/review").textContent, /Review notes body/);
    assert.match(card(p, "p-res", "metrics").textContent, /Loss body/);
    assert.deepEqual([...p.doc.querySelectorAll("[data-home-project]")].map((el) => el.dataset.homeProject), ["p-res", "p-app", "p-docs"]);
    const first = refused();
    assert.ok(first > 0, "the refusal was caught and reported");
    // The same section read again is not drawn again.
    await refresh("the same version");
    assert.equal(unreadable(), "This section couldn't be displayed.");
    assert.equal(refused(), first, "an unchanged section is not tried again");
    // A new version is tried once, then stays as it is.
    Object.assign(notes, { version: 3, body: links({ note: "still older" }) });
    await refresh("version 3");
    await waitFor(() => card(p, "p-app", "notes").dataset.sectionVersion === "3", "version 3 is shown");
    const second = refused();
    assert.ok(second > first, "a new version is tried again");
    await refresh("version 3 again");
    assert.equal(refused(), second, "and only once");
    assert.equal(unreadable(), "This section couldn't be displayed.");
    // A version that can be drawn is drawn.
    Object.assign(notes, { version: 4, body: links({}) });
    await refresh("version 4");
    await waitFor(() => card(p, "p-app", "notes").querySelector(".result-sources a")?.textContent === "Spec", "version 4 is drawn");
    assert.equal(unreadable(), undefined);
    // The conversation and the way back to Home work as before.
    const error = p.panel("p-res").querySelector(".home-error");
    p.button("Sora", error).click();
    await waitFor(() => p.doc.querySelector(".conversation-title h1")?.textContent === "Sora", "Sora's conversation is open");
    p.button("Back to Home").click();
    await waitFor(() => p.doc.querySelector(".home-view [data-home-project]"), "back on Home");
    assert.equal(card(p, "p-app", "notes").querySelector(".result-sources a")?.textContent, "Spec");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("replies go to the owner with the chosen option; a retry keeps its client id", async () => {
  const p = await mount({ failReplies: 1 });
  try {
    const release = card(p, "p-app", "release");
    assert.equal(release.querySelector(".home-reply-target select").value, "a", "the owner is the default recipient");
    // The first send fails; the retry must reuse its client id.
    await type(p, release.querySelector("textarea"), "Ship it after the docs fix");
    p.button("Send", release).click();
    await waitFor(() => release.querySelector('[role="alert"]'), "the failure is shown");
    p.button("Send", release).click();
    await waitFor(() => p.posts(/\/brief\/reply$/).length === 2, "the reply was retried");
    const [first, retry] = p.posts(/\/brief\/reply$/);
    assert.match(first.url, /\/api\/projects\/p-app\/brief\/reply$/);
    assert.deepEqual(Object.keys(first.body).sort(), ["agentId", "clientMessageId", "key", "text"]);
    assert.equal(first.body.key, "release");
    assert.equal(first.body.agentId, "a");
    assert.equal(first.body.text, "Ship it after the docs fix");
    assert.match(first.body.clientMessageId, uuid);
    assert.equal(retry.body.clientMessageId, first.body.clientMessageId, "same id on retry");
    await waitFor(() => /Replied · waiting for/.test(card(p, "p-app", "release").textContent), "replied state");
    assert.equal(p.w.localStorage.getItem("yuzuno.home-outbox.v1"), null, "a delivered reply leaves the outbox");
    // Choosing one of two approaches sends a pre-filled reply to that owner.
    const budget = card(p, "p-app", "budget");
    p.button("Choose B", budget).click();
    await waitFor(() => p.posts(/\/brief\/reply$/).length === 3, "the choice was sent");
    const choice = p.posts(/\/brief\/reply$/)[2].body;
    assert.equal(choice.key, "budget");
    assert.equal(choice.agentId, "b");
    assert.equal(choice.choice, "plan-b");
    assert.equal(choice.text, "");
    assert.notEqual(choice.clientMessageId, first.body.clientMessageId);
    // A project-level reply goes to the Agent the user picks, without a key.
    const app = p.panel("p-app");
    p.button("Reply to the project", app).click();
    await pause();
    const reply = app.querySelector(".home-project-reply");
    await choose(p, reply.querySelector("select"), "b");
    await type(p, reply.querySelector("textarea"), "Please tidy the notes");
    p.button("Send", reply).click();
    await waitFor(() => p.posts(/\/brief\/reply$/).length === 4, "the project reply was sent");
    const project = p.posts(/\/brief\/reply$/)[3].body;
    assert.equal("key" in project, false);
    assert.equal(project.agentId, "b");
    assert.equal(project.text, "Please tidy the notes");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an option button sends its id and no text; the label shows as sent", async () => {
  const p = await mount();
  try {
    p.button("Ship today", card(p, "p-app", "release")).click();
    await waitFor(() => p.posts(/\/brief\/reply$/).length === 1, "the option was sent");
    const { body: sent } = p.posts(/\/brief\/reply$/)[0];
    assert.equal(sent.key, "release");
    assert.equal(sent.agentId, "a");
    assert.equal(sent.text, "", "Core quotes the label; text would repeat it");
    assert.equal(sent.choice, "ship");
    await waitFor(() => card(p, "p-app", "release").querySelector(".home-ask-replied"), "shown as replied");
    assert.match(card(p, "p-app", "release").querySelector(".home-ask-replied").textContent, /Ship today/);
  } finally {
    p.close();
  }
});

// T-132: an answered ask is its owner's to act on, not the user's to decide.
function repliedFixture() {
  const home = homeFixture();
  const app = home.projects[0].brief;
  const budget = app.sections.find((s) => s.key === "budget");
  budget.ask = { ...budget.ask, state: "replied", repliedAt: at(3), replyText: "Plan B" };
  app.sections.push(
    section("deploy", "ask", "Deploy now?", 2, owner("b", "Hana"), {
      updatedAt: at(1),
      body: body("Deploy started; waiting for CI"),
      ask: { question: "Deploy to production?", state: "replied", repliedAt: at(10), replyText: "Yes, deploy", reply: { options: [{ id: "yes", label: "Yes, deploy" }, { id: "no", label: "No" }] } },
    }),
  );
  app.history.unshift(
    section("migrate", "ask", "Migrate the data?", 3, owner("a", "Mori"), {
      history: true, historyReason: "resolved", body: body("Migrated 12 tables"),
      ask: { question: "Run the migration now?", state: "resolved", repliedAt: at(80), replyText: "Run it tonight", reply: { freeText: true } },
    }),
  );
  return home;
}

test("a replied ask shows in short, waiting for its owner; the question and the owner's later update stay reachable", async () => {
  const p = await mount({ home: repliedFixture() });
  try {
    const budget = card(p, "p-app", "budget");
    assert.ok(budget.classList.contains("is-replied"), "marked replied");
    const kind = budget.querySelector(".home-kind");
    assert.equal(kind.textContent.trim(), "Replied");
    assert.ok(kind.classList.contains("is-replied"), "no attention colour once answered");
    // Compact: the answer and who acts next, no reply controls and no Defer.
    assert.match(budget.querySelector(".home-ask-replied").textContent, /Replied · waiting for Hana\s*Plan B/);
    assert.equal(budget.querySelector(".home-ask-reply"), null);
    assert.equal(p.button("Defer", budget), undefined);
    assert.equal(budget.querySelector(":scope > .home-card-body > .home-question"), null, "the question is folded away");
    assert.equal(budget.querySelector(":scope > .home-card-body > .home-section-body"), null, "so are the details");
    const details = budget.querySelector(".home-replied-details");
    assert.equal(details.open, false);
    assert.equal(details.querySelector("summary").textContent.trim(), "Question and details");
    assert.equal(details.querySelector(".home-question").textContent, "Plan A or B?");
    assert.match(details.querySelector(".home-section-body").textContent, /Which plan\? body/);
    // Reply again brings the controls back.
    p.button("Reply again", budget).click();
    await waitFor(() => p.button("Choose B", budget), "the choice is offered again");
    // Updated by its owner after the reply: that update stays in view, still replied.
    const deploy = card(p, "p-app", "deploy");
    assert.ok(deploy.classList.contains("is-replied"));
    assert.match(deploy.querySelector(":scope > .home-card-body > .home-section-body").textContent, /Deploy started; waiting for CI/);
    assert.match(deploy.querySelector(".home-ask-updated").textContent, /^Hana updated it .+, after your reply$/);
    assert.match(deploy.querySelector(".home-ask-replied").textContent, /Replied · waiting for Hana\s*Yes, deploy/);
    assert.equal(deploy.querySelector(".home-replied-details summary").textContent.trim(), "Question");
    // An open ask is unchanged: highlighted, question in view, Defer offered.
    const release = card(p, "p-app", "release");
    assert.ok(!release.classList.contains("is-replied"));
    assert.equal(release.querySelector(".home-kind").textContent.trim(), "Ask");
    assert.equal(release.querySelector(":scope > .home-card-body > .home-question").textContent, "Ship the release today?");
    assert.ok(p.button("Defer", release), "an open ask can be deferred");
    // A resolved ask keeps its question and the user's answer in history.
    const history = p.panel("p-app").querySelector(".home-history");
    history.open = true;
    const migrate = [...history.querySelectorAll("li details")].find((d) => /Migrate the data\?/.test(d.textContent));
    migrate.open = true;
    migrate.dispatchEvent(new p.w.Event("toggle"));
    await waitFor(() => migrate.querySelector(".home-history-reply"), "the resolved ask opens");
    assert.equal(migrate.querySelector(".home-question").textContent, "Run the migration now?");
    assert.equal(migrate.querySelector(".home-history-reply").textContent, "Your reply: Run it tonight");
    assert.match(migrate.textContent, /Migrated 12 tables/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// T-132 with T-127: a replied ask's changed blocks are marked wherever its body shows.
test("a replied ask marks its changed blocks where its body shows: the owner's update in view, or inside its folded details", async () => {
  const notes = (summary) => ({
    root: "body",
    elements: {
      body: { type: "BriefBody", props: {}, children: ["summary", "detail"] },
      summary: { type: "Markdown", props: { text: summary } },
      detail: { type: "Markdown", props: { text: "Kept as it was." } },
    },
  });
  const marks = (root) => [...root.querySelectorAll(".brief-change")].map((el) => [el.dataset.change, el.textContent.trim().slice(0, 30)]);
  for (const updatedSinceReply of [true, false]) {
    const home = homeFixture();
    const ask = home.projects[0].brief.sections.find((s) => s.key === "budget");
    Object.assign(ask, { version: 1, seen: { version: 1, at: at(60) }, body: notes("Plan A is cheaper.") });
    const p = await mount({ home });
    const key = 'yuzuno.home-seen-blocks.v1:["ws-home","p-app","budget",null]';
    try {
      await waitFor(() => p.w.localStorage.getItem(key), "the seen version's blocks are kept");
      // Version 2 rewrites the summary; the user replied before it, or after it.
      Object.assign(ask, {
        version: 2, updatedAt: at(updatedSinceReply ? 1 : 5), body: notes("Plan B is under way."),
        ask: { ...ask.ask, state: "replied", repliedAt: at(3), replyText: "Plan B" },
      });
      p.doc.querySelector('[aria-label="Refresh Home"]').click();
      await waitFor(() => card(p, "p-app", "budget").dataset.sectionVersion === "2", "version 2 is shown");
      const budget = card(p, "p-app", "budget");
      assert.ok(budget.classList.contains("is-replied"));
      const details = budget.querySelector(".home-replied-details");
      if (updatedSinceReply) {
        // The owner's update after the reply stays in view, its changed block marked.
        assert.deepEqual(marks(budget.querySelector(":scope > .home-card-body > .home-section-body")), [["updated", "UpdatedPlan B is under way."]]);
        assert.equal(details.querySelectorAll(".brief-change").length, 0, "only the question is folded away");
      } else {
        // Changed before the reply: the body is folded with the question, and marked there.
        assert.equal(budget.querySelector(":scope > .home-card-body > .home-section-body"), null);
        details.open = true;
        assert.deepEqual(marks(details), [["updated", "UpdatedPlan B is under way."]]);
      }
      assert.deepEqual(p.errors, []);
    } finally {
      p.close();
    }
  }
});

test("a reply Core cannot confirm never shows as replied", async () => {
  const p = await mount({ replyStatus: "uncertain" });
  try {
    const release = card(p, "p-app", "release");
    p.button("Ship today", release).click();
    await waitFor(() => release.querySelector('[role="alert"]'), "the unconfirmed delivery is shown");
    assert.match(release.querySelector('[role="alert"]').textContent, /not confirmed/);
    assert.equal(release.querySelector(".home-ask-replied"), null, "not shown as replied");
    assert.ok(!release.classList.contains("is-replied"));
    assert.ok(p.button("Defer", release), "still the user's to decide");
  } finally {
    p.close();
  }
});

test("an unknown machine metric reads unknown, never 0, and sampling stops while hidden", async () => {
  const p = await mount();
  try {
    await waitFor(() => p.doc.querySelector(".home-machine:not([aria-busy])"), "machine load shown");
    const machines = p.doc.querySelector(".home-machines");
    const facts = (name) => [...machines.querySelectorAll(`[data-fact="${name}"] strong`)].map((e) => e.textContent);
    assert.deepEqual(facts("Agents"), ["unknown", "unknown"], "CPU and memory for Agents are unknown");
    assert.deepEqual(facts("Other"), ["unknown"]);
    assert.deepEqual(facts("GPU"), ["unknown"]);
    assert.deepEqual(facts("Jobs"), ["10%", "2.0 GiB"]);
    assert.deepEqual(facts("CPU"), ["unknown"], "a job's unknown CPU");
    assert.match(machines.textContent, /App · Mori/, "a job names its project and Agent");
    assert.doesNotMatch(facts("Agents").join(" "), /\b0\b/);
    const reads = () => p.calls.filter((c) => c.url.endsWith("/api/machine-load")).length;
    await waitFor(() => reads() >= 2, "sampled again after two seconds", 5);
    p.setVisibility("hidden");
    await pause(100);
    const hidden = reads();
    await pause(2300);
    assert.equal(reads(), hidden, "no sampling while the window is hidden");
    p.setVisibility("visible");
    await waitFor(() => reads() > hidden, "sampling resumes when shown");
  } finally {
    p.close();
  }
});

test("each GPU reads as two bars, use and memory, and a Job on the machine opens in Jobs", async () => {
  const load = () => ({
    ...machineLoad(),
    gpus: [{ name: "RTX 5090", utilPct: 42, memUsedMiB: 8192, memTotalMiB: 32768, attribution: "unknown" }],
  });
  const p = await mount({ load });
  try {
    await waitFor(() => p.doc.querySelector(".home-gpus .home-gpu-name")?.textContent === "RTX 5090", "the GPU is read");
    const bars = [...p.doc.querySelectorAll(".home-gpus li .home-meter")];
    assert.deepEqual(bars.map((b) => b.getAttribute("aria-label")), ["GPU use 42%", "GPU memory 8.0 GiB / 32.0 GiB"]);
    assert.deepEqual(bars.map((b) => b.querySelector(".home-meter-gpu").style.width), ["42%", "25%"]);
    // As the conversation's dock: a name, a quiet line, and the row opens the Job.
    const opened = [];
    p.w.addEventListener("yuzuno:open-job", (event) => opened.push(JSON.stringify(event.detail)));
    const row = p.doc.querySelector(".home-machine-jobs button.home-machine-job");
    assert.equal(row.querySelector("strong").textContent, "cargo test");
    assert.match(row.querySelector("small").textContent, /^App · MoriCPU unknownMemory 512 MiB$/);
    row.click();
    assert.deepEqual(opened, [JSON.stringify({ source: "local", jobId: "job-1" })]);
    await waitFor(() => p.doc.querySelector(".jobs-nav.selected"), "the Jobs panel opens");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an Agent error opens its conversation and leads back to Home without reading it", async () => {
  const p = await mount();
  try {
    const error = p.panel("p-res").querySelector(".home-error");
    assert.match(error.textContent, /Sora.*Codex exited unexpectedly/);
    p.button("Sora", error).click();
    await waitFor(() => p.doc.querySelector(".conversation-title h1")?.textContent === "Sora", "Sora's conversation is open");
    assert.equal(p.doc.querySelector(".home-view"), null, "Home gave way to the conversation");
    p.button("Back to Home").click();
    await waitFor(() => p.doc.querySelector(".home-view [data-home-project]"), "back on Home");
    assert.equal(p.posts(/\/agents\/[^/]+\/review$/).length, 0, "nothing was marked read");
  } finally {
    p.close();
  }
});

test("Reorder moves a panel and saves the whole order", async () => {
  const p = await mount();
  try {
    p.button("Reorder").click();
    await pause();
    p.doc.querySelector('[aria-label="Move App up"]').click();
    await waitFor(() => p.posts(/\/api\/home\/order$/).length === 1, "the order was saved");
    assert.deepEqual(p.posts(/\/api\/home\/order$/)[0].body, { projectIds: ["p-app", "p-res", "p-docs"] });
    assert.deepEqual(
      [...p.doc.querySelectorAll("[data-home-project]")].map((e) => e.dataset.homeProject),
      ["p-app", "p-res", "p-docs"],
    );
  } finally {
    p.close();
  }
});

test("non-editor content stays in closed team details and does not affect Seen all or Ask jumps", async () => {
  const home = homeFixture();
  const app = home.projects.find(panel => panel.project.id === 'p-app');
  app.brief.teamSections = [section('hidden-parent', 'status', 'Earlier worker progress', 3, owner('b', 'Hana'))];
  app.brief.sections.push(section('hidden-parent/question', 'ask', 'Which version?', 1, owner('b', 'Hana'), {
    ask: { question: 'Which version?', reply: { freeText: true }, state: 'open' },
  }));
  home.needsYou.push({ kind: 'ask', projectId: 'p-app', agentId: 'b', agentName: 'Hana', sectionKey: 'hidden-parent/question', title: 'Which version?', since: at(0) });
  const p = await mount({ home });
  try {
    const details = p.panel('p-app').querySelector('.home-team-details');
    assert.equal(details.open, false);
    assert.ok(card(p, 'p-app', 'hidden-parent').closest('.home-team-details'));
    assert.ok(!card(p, 'p-app', 'hidden-parent/question').closest('.home-team-details'));
    p.doc.querySelector('[data-needs-you="ask:p-app:hidden-parent/question"]').click();
    await waitFor(() => card(p, 'p-app', 'hidden-parent/question').hasAttribute('data-home-highlight'), 'Ask under hidden parent is reachable');
    assert.equal(details.open, false);
    assert.equal(p.posts(/brief\/seen$/).length, 0, 'source filtering and navigation do not mark Seen');
    p.button('Seen all', p.panel('p-app')).click();
    await waitFor(() => p.posts(/brief\/seen$/).length === 1, 'Seen all posted');
    assert.ok(!p.posts(/brief\/seen$/)[0].body.sections.some(section => section.key === 'hidden-parent'));
    details.querySelector('summary').click();
    assert.equal(details.open, true);
    assert.equal(p.posts(/brief\/seen$/).length, 1, 'opening team details adds no Seen write');
  } finally { p.close(); }
});

test("Home is laid out as Needs you, My widgets, then the projects; widgets are organized in a dialog on this device (T-9)", async () => {
  const p = await mount();
  try {
    const column = p.doc.querySelector('.home-layout > .home-widget-column[aria-label="My widgets"]');
    assert.ok(column, "My widgets in the layout");
    assert.ok(column.querySelector('.home-widget-grid > [data-widget="machines"] .home-machines'), "Machines is a widget in the grid");
    const needs = p.doc.querySelector(".home-layout > .home-needs-area .home-needs-you");
    const project = p.doc.querySelector(".home-layout > .home-main [data-home-project]");
    assert.ok(needs, "Needs you has its own area");
    assert.ok(project, "the projects have theirs");
    const follows = (a, b) => !!(a.compareDocumentPosition(b) & p.w.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(follows(needs, column) && follows(column, project), "Needs you, then My widgets, then the projects");
    assert.ok(!column.querySelector(".home-needs-you, [data-home-project]"), "neither is inside My widgets");
    // The project panels keep their own inner .home-widgets; the column shares no class with them.
    assert.equal(column.matches(".home-widgets") || !!column.querySelector(".home-widget, .home-widgets"), false);
    assert.equal(column.querySelector(".home-widget-count").textContent, "0 pinned");
    // Manage opens the Machines page.
    p.button("Manage", column).click();
    await waitFor(() => /Where your agents run/.test(p.doc.querySelector('[role="dialog"]')?.textContent || ""), "the Machines page opens");
    p.doc.querySelector('[role="dialog"]').dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await waitFor(() => !p.doc.querySelector('[role="dialog"]'), "the Machines page closes");
    // Organize: a dialog; hidden, a widget is not drawn and reads nothing; the choice is kept.
    p.button("Organize", column).click();
    await waitFor(() => /Organize my widgets/.test(p.doc.querySelector('[role="dialog"]')?.textContent || ""), "Organize opens");
    const dialog = () => p.doc.querySelector('[role="dialog"]');
    assert.match(dialog().textContent, /Changes only how this device shows them\./);
    assert.ok(dialog().querySelector('[aria-label="Move Machines up"]').disabled);
    assert.match(dialog().textContent, /No hidden widgets\./);
    dialog().querySelector('[aria-label="Hide Machines"]').click();
    await waitFor(() => !column.querySelector(".home-machines"), "Machines is hidden");
    assert.deepEqual(JSON.parse(p.w.localStorage.getItem("yuzuno.homeWidgets.ws-home")), { order: ["machines"], hidden: ["machines"], pins: [] });
    assert.ok(dialog().querySelector('[aria-label="Show Machines"]'), "it is listed as hidden");
    const reads = () => p.calls.filter((c) => c.url.endsWith("/api/machine-load")).length;
    const before = reads();
    await pause(2300);
    assert.equal(reads(), before, "a hidden widget does not sample");
    p.button("Done", dialog()).click();
    await waitFor(() => !dialog(), "Organize closes");
    assert.match(column.querySelector(".home-widget-empty").textContent, /No widgets on show\./);
    p.button("Organize", column).click();
    await waitFor(() => dialog()?.querySelector('[aria-label="Show Machines"]'), "Organize opens again");
    dialog().querySelector('[aria-label="Show Machines"]').click();
    await waitFor(() => column.querySelector(".home-machines"), "Machines is shown again");
    assert.deepEqual(JSON.parse(p.w.localStorage.getItem("yuzuno.homeWidgets.ws-home")), { order: ["machines"], hidden: [], pins: [] });
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
  // A layout saved earlier on this device holds when Home opens again, one
  // saved before layouts were kept per workspace included.
  const again = await mount({ storage: { "yuzuno.homeWidgets": JSON.stringify({ order: ["machines"], hidden: ["machines"] }) } });
  try {
    await pause(200);
    assert.equal(again.doc.querySelector(".home-machines"), null);
    assert.equal(again.calls.filter((c) => c.url.endsWith("/api/machine-load")).length, 0, "never read while hidden");
  } finally {
    again.close();
  }
});

// T-115: every Home card folds on its own, the project's Repositories too.
const repo = { id: 1, fullName: "acme/app", url: "https://github.com/acme/app", syncedAt: at(1), error: null };
const fold = (root) => root.querySelector(".home-fold");
const storageOf = (p) => Object.fromEntries(Array.from({ length: p.w.localStorage.length }, (_, i) => p.w.localStorage.key(i)).map((k) => [k, p.w.localStorage.getItem(k)]));

test("every Home card folds on its own and keeps its header; nothing is seen, answered or read meanwhile (T-115)", async () => {
  const p = await mount({ linked: [repo] });
  try {
    await waitFor(() => p.panel("p-app").querySelector(".home-repos .repo-activity"), "the Repositories block is read");
    await waitFor(() => p.panel("p-res").querySelector(".home-approvals"), "the approval is shown");
    const cards = {
      needs: p.doc.querySelector(".home-needs-you"),
      machines: p.doc.querySelector(".home-machines"),
      notes: card(p, "p-app", "notes"),
      review: card(p, "p-app", "notes/review"),
      approvals: p.panel("p-res").querySelector(".home-approvals"),
      repos: p.panel("p-app").querySelector(".home-repos"),
    };
    for (const [name, root] of Object.entries(cards)) {
      const button = fold(root);
      assert.ok(button, `${name} has its own fold`);
      assert.equal(button.getAttribute("aria-expanded"), "true", name);
      const body = p.doc.getElementById(button.getAttribute("aria-controls"));
      assert.ok(body && root.contains(body) && !body.hidden, `${name} controls its own body`);
    }
    const machineReads = () => p.calls.filter((c) => c.url.endsWith("/api/machine-load")).length;
    const activityReads = () => p.calls.filter((c) => c.url.endsWith("/repo-activity")).length;
    for (const root of Object.values(cards)) fold(root).click();
    await pause();
    for (const [name, root] of Object.entries(cards)) {
      assert.equal(fold(root).getAttribute("aria-expanded"), "false", name);
      assert.equal(p.doc.getElementById(fold(root).getAttribute("aria-controls")).hidden, true, `${name}'s body is hidden`);
    }
    // The headers still say what is new and what waits.
    assert.match(cards.review.querySelector(".home-section-head").textContent, /Review notes.*New/);
    assert.ok(cards.review.querySelector(".home-seen"), "Seen is still offered");
    assert.match(cards.needs.querySelector("h2").textContent, /Needs you\s*2/);
    assert.match(cards.approvals.querySelector(".home-card-head").textContent, /Waiting for approval\s*1/);
    assert.match(cards.repos.querySelector(".home-card-head").textContent, /Repositories\s*1/);
    // The Repositories fold is its own: the project stays open; activity and load are not read.
    assert.equal(p.panel("p-app").classList.contains("is-collapsed"), false);
    assert.equal(cards.repos.querySelector(".repo-activity"), null);
    const machines = machineReads(), activity = activityReads();
    await pause(2600);
    assert.equal(machineReads(), machines, "a collapsed Machines widget reads no load");
    assert.equal(activityReads(), activity);
    assert.deepEqual(p.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/api/collaboration/github_repositories")).map((c) => c.url), [],
      "folding marks nothing seen, answers nothing and approves nothing");
    // Kept for this Workspace, by each card's own identity.
    const stored = storageOf(p);
    p.close();
    const again = await mount({ linked: [repo], storage: stored });
    try {
      await waitFor(() => again.panel("p-app").querySelector(".home-repos"), "the Repositories block is drawn again");
      assert.equal(fold(card(again, "p-app", "notes/review")).getAttribute("aria-expanded"), "false");
      assert.equal(fold(card(again, "p-app", "notes")).getAttribute("aria-expanded"), "false");
      assert.equal(fold(card(again, "p-app", "release")).getAttribute("aria-expanded"), "true", "another card is not folded with it");
      assert.equal(fold(again.panel("p-app").querySelector(".home-repos")).getAttribute("aria-expanded"), "false");
      assert.equal(fold(again.doc.querySelector(".home-machines")).getAttribute("aria-expanded"), "false");
      fold(card(again, "p-app", "notes")).click();
      await pause();
      assert.equal(again.doc.getElementById(fold(card(again, "p-app", "notes")).getAttribute("aria-controls")).hidden, false, "expanded again");
    } finally {
      again.close();
    }
    const other = await mount({ linked: [repo], storage: stored, workspace: "ws-other" });
    try {
      assert.equal(fold(card(other, "p-app", "notes/review")).getAttribute("aria-expanded"), "true", "another Workspace keeps its own");
    } finally {
      other.close();
    }
  } finally {
    p.close();
  }
});

test("a jump from Needs you opens a collapsed card to show its approval or Ask (T-115)", async () => {
  const p = await mount();
  try {
    await waitFor(() => p.panel("p-res").querySelector(".home-approvals"), "the approval is shown");
    const approvals = p.panel("p-res").querySelector(".home-approvals");
    const release = card(p, "p-app", "release");
    fold(approvals).click();
    fold(release).click();
    await pause();
    assert.equal(fold(approvals).getAttribute("aria-expanded"), "false");
    assert.equal(fold(release).getAttribute("aria-expanded"), "false");
    const needs = (pattern) => [...p.doc.querySelectorAll(".home-needs-item")].find((b) => pattern.test(b.textContent));
    needs(/Run the test suite/).click();
    await waitFor(() => p.doc.getElementById("home-request-r-1")?.hasAttribute("data-home-highlight"), "the approval is highlighted");
    const request = p.doc.getElementById("home-request-r-1");
    assert.equal(fold(approvals).getAttribute("aria-expanded"), "true", "its card opened");
    assert.equal(request.closest(".home-card-body").hidden, false);
    assert.equal(p.doc.activeElement, request);
    needs(/Ship today\?/).click();
    await waitFor(() => release.hasAttribute("data-home-highlight"), "the Ask is highlighted");
    assert.equal(fold(release).getAttribute("aria-expanded"), "true", "the Ask's own card opened");
    assert.ok(release.querySelector("textarea"), "its reply is in view");
    assert.equal(p.posts(/\/brief\/(reply|seen)$|\/respond$/).length, 0, "jumping answers nothing");
  } finally {
    p.close();
  }
});

test("a collapsed Ask keeps what was typed in it, and folding sends nothing (T-115)", async () => {
  const p = await mount();
  try {
    const release = card(p, "p-app", "release");
    const field = release.querySelector("textarea");
    assert.ok(field, "the Ask has a reply field");
    await type(p, field, "Only after the docs land.");
    fold(release).click();
    await pause();
    assert.equal(p.doc.getElementById(fold(release).getAttribute("aria-controls")).hidden, true);
    assert.equal(release.querySelector(".home-kind").textContent, "Ask", "the header still says it is an Ask");
    fold(release).click();
    await pause();
    assert.equal(release.querySelector("textarea").value, "Only after the docs land.");
    assert.equal(p.posts(/\/brief\/(reply|seen)$/).length, 0);
  } finally {
    p.close();
  }
});

// T-173: bodies shaped like the Home audit's examples, synthetic text.
function readingFixture() {
  const home = homeFixture();
  const docs = home.projects.find((entry) => entry.project.id === "p-docs");
  const node = (type, props, children) => (children ? { type, props, children } : { type, props });
  const md = (text) => node("Markdown", { text });
  const spec = (top, elements) => ({ root: "body", elements: { body: node("BriefBody", {}, top), ...elements } });
  const closed = { agentId: "k", name: "Kumo", state: "closed" };
  docs.unseen = 4;
  docs.brief.sections = [
    section("overview", "report", "Development", 3, owner("b", "Hana"), {
      body: spec(["lead", "costs"], {
        lead: node("Group", { title: "Now", tone: "accent" }, ["now"]),
        now: md("Release **core.15** is out; two lines wait for main.\n\nDetails below."),
        costs: node("BarChart", { title: "Cost", x: { label: "Run" }, y: { label: "USD" }, series: [{ name: "A", points: [["r1", 4], ["r2", 5]] }] }),
      }),
    }),
    section("evidence", "report", "Reconnect", 2, owner("b", "Hana"), {
      body: spec(["runs", "result"], { runs: node("Group", { title: "Runs" }, ["log"]), log: md("Run 101: 412 passed."), result: md("Merged.") }),
    }),
    section("layout", "status", "Home layout", 5, closed, {
      body: spec(["state"], { state: md("Daily runs core.12.") }),
      status: { asOf: at(4 * 24 * 60), validFor: 7 * 24 * 3600, stale: false },
    }),
    section("release-core12/notes", "report", "Release notes", 1, owner("b", "Hana")),
    section("ops/disk", "report", "Disk", 1, owner("b", "Hana")),
    section("ops/backup", "report", "Backup", 1, owner("b", "Hana")),
  ];
  return home;
}

test("a folded card still says what it is about, when its data is from and that nobody keeps it (T-173)", async () => {
  const p = await mount({ home: readingFixture() });
  try {
    await waitFor(() => card(p, "p-docs", "layout"), "the Docs cards are drawn");
    const overview = card(p, "p-docs", "overview");
    const evidence = card(p, "p-docs", "evidence");
    const layout = card(p, "p-docs", "layout");
    // Open, the body says it all: nothing is shown twice.
    for (const root of [overview, evidence, layout]) assert.ok(!root.querySelector(".home-card-glance"), "no excerpt while open");
    // An author who has closed: marked in the header, explained in the body.
    assert.equal(layout.querySelector(".home-unmaintained").textContent, "Not maintained");
    assert.match(layout.querySelector(".home-unmaintained").title, /Kumo has closed/);
    assert.match(layout.querySelector(".home-unmaintained-note").textContent, /Kumo has closed, so this status is no longer updated.*can claim it.*nothing is removed by itself/s);
    assert.ok(!overview.querySelector(".home-unmaintained"), "an active author's card is not marked");
    // Folding keeps the fold button focused and the chart's data table open.
    const table = overview.querySelector("details.brief-chart-data");
    table.open = true;
    table.dispatchEvent(new p.w.Event("toggle"));
    await pause();
    for (const root of [overview, evidence, layout]) {
      fold(root).focus();
      fold(root).click();
      await pause();
      assert.ok(p.doc.activeElement === fold(root), "focus stays on the fold");
    }
    const glance = (root) => root.querySelector(".home-card-glance");
    assert.equal(glance(overview).querySelector(".home-card-summary").textContent.trim(), "Release core.15 is out; two lines wait for main.",
      "the accent Group's first paragraph");
    assert.ok(glance(overview).querySelector(".home-card-summary strong"), "as Markdown");
    assert.ok(!glance(overview).querySelector(".home-section-time"), "a report has no data time");
    assert.ok(!glance(evidence), "a card opening with evidence shows no summary rather than the evidence");
    assert.equal(glance(layout).querySelector(".home-card-summary").textContent.trim(), "Daily runs core.12.");
    assert.match(glance(layout).querySelector(".home-section-time").textContent, /Data as of/);
    assert.ok(layout.querySelector(".home-section-head .home-unmaintained"), "still marked when folded");
    for (const root of [overview, layout]) {
      const id = fold(root).getAttribute("aria-controls");
      assert.ok(!glance(root).contains(p.doc.getElementById(id)), "the excerpt is outside the hidden body");
      assert.equal(p.doc.getElementById(id).hidden, true);
    }
    fold(overview).click();
    await pause();
    assert.ok(!glance(overview), "no excerpt once open");
    assert.ok(overview.querySelector("details.brief-chart-data") === table, "the same table, still open");
    assert.equal(table.open, true);
    assert.deepEqual(p.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/api/collaboration/github_repositories")).map((c) => c.url), [],
      "folding marks nothing seen and answers nothing");
  } finally {
    p.close();
  }
});

test("a sub-topic without its topic's section stands as its own card; several get a readable heading (T-173)", async () => {
  const p = await mount({ home: readingFixture() });
  try {
    await waitFor(() => card(p, "p-docs", "ops/backup"), "the Docs cards are drawn");
    const alone = p.panel("p-docs").querySelector('[data-topic="release-core12"]');
    assert.ok(!alone.querySelector(".home-topic-name"), "no bare key over a single card");
    assert.ok(!alone.querySelector(".home-subs"), "not drawn as a sub-card");
    assert.ok(alone.contains(card(p, "p-docs", "release-core12/notes")));
    const ops = p.panel("p-docs").querySelector('[data-topic="ops"]');
    assert.equal(ops.querySelector(".home-topic-name").textContent, "Ops");
    assert.equal(ops.querySelector(".home-topic-name").title, "ops", "the key stays reachable");
    assert.equal(ops.querySelectorAll(".home-subs .home-section").length, 2);
  } finally {
    p.close();
  }
});

test("a report or status pins to the widget column: the same section, its source, kept per workspace; asks never pin", async () => {
  const home = homeFixture();
  home.projects.forEach((panel, n) => panel.brief.sections.forEach((s, i) => (s.id = 100 * (n + 1) + i)));
  // Earlier content of a member who may no longer edit: shown under Team details, never pinned.
  home.projects[0].brief.teamSections = [section("old-notes", "report", "Old notes", 1, owner("b", "Hana"), { id: 150 })];
  const notes = () => home.projects[0].brief.sections.find((s) => s.key === "notes");
  const p = await mount({ home });
  try {
    const column = p.doc.querySelector(".home-widget-column");
    const pinned = () => column.querySelector(".home-pinned");
    const refresh = async (until, what) => {
      p.doc.querySelector('[aria-label="Refresh Home"]').click();
      await waitFor(until, what);
    };
    // Asks are answered in Needs you and their project: no pin. Reports and status pin.
    assert.equal(card(p, "p-app", "release").querySelector(".home-pin"), null);
    assert.equal(card(p, "p-app", "budget").querySelector(".home-pin"), null);
    assert.ok(card(p, "p-res", "metrics").querySelector(".home-pin"));
    assert.ok(card(p, "p-app", "old-notes"), "the team content is drawn");
    assert.equal(card(p, "p-app", "old-notes").querySelector(".home-pin"), null, "content kept out of Home's view is not pinned");
    const needs = [...p.doc.querySelectorAll("[data-needs-you]")].map((e) => e.dataset.needsYou);
    const writes = () => p.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/api/collaboration/github_repositories")).length;
    const before = writes();
    card(p, "p-app", "notes").querySelector('[aria-label="Pin “Notes” to My widgets"]').click();
    await waitFor(() => pinned(), "Notes is pinned");
    assert.match(pinned().querySelector(".home-pinned-from").textContent, /^App · Mori · Updated /);
    assert.match(pinned().querySelector(".home-pinned-body").textContent, /Notes body/);
    assert.equal(card(p, "p-app", "notes").querySelector(".home-pin").getAttribute("aria-pressed"), "true");
    // Pinning tells Core nothing: no Seen, and nothing needs you twice.
    assert.equal(writes(), before);
    assert.deepEqual([...p.doc.querySelectorAll("[data-needs-you]")].map((e) => e.dataset.needsYou), needs);
    const layout = () => JSON.parse(p.w.localStorage.getItem("yuzuno.homeWidgets.ws-home"));
    assert.deepEqual(layout().pins, [{ projectId: "p-app", key: "notes", id: 101, title: "Notes", projectName: "App" }]);
    assert.equal(column.querySelector(".home-widget-count").textContent, "1 pinned");
    // Hidden, it stays pinned and shows again; unpinning is a separate button.
    p.button("Organize", column).click();
    const dialog = () => p.doc.querySelector('[role="dialog"]');
    await waitFor(() => dialog()?.querySelector('[aria-label="Hide Notes"]'), "Organize lists Notes");
    assert.ok(dialog().querySelector('[aria-label="Unpin Notes"]'));
    assert.deepEqual([...dialog().querySelectorAll(".home-organize-list li")].map((li) => li.dataset.widget), ["machines", "pin:p-app:101:notes"], "a new pin comes last");
    dialog().querySelector('[aria-label="Hide Notes"]').click();
    await waitFor(() => !pinned(), "the pinned section is hidden");
    assert.equal(layout().pins.length, 1, "hidden, it is still pinned");
    assert.deepEqual(layout().hidden, ["pin:p-app:101:notes"]);
    dialog().querySelector('[aria-label="Show Notes"]').click();
    await waitFor(() => pinned(), "it shows again");
    assert.deepEqual(layout().hidden, []);
    // Moved before Machines: the grid follows the order.
    dialog().querySelector('[aria-label="Move Notes up"]').click();
    await waitFor(() => column.querySelector(".home-widget-grid > .home-widget-slot")?.dataset.widget === "pin:p-app:101:notes", "Notes comes first");
    assert.deepEqual(layout().order, ["pin:p-app:101:notes", "machines"]);
    p.button("Done", dialog()).click();
    await waitFor(() => !dialog(), "Organize closes");
    const saved = JSON.stringify(layout());
    // The Agent writes a new version: the content follows, the layout does not change.
    Object.assign(notes(), { version: 3, title: "Notes, round 2", body: body("Round 2 notes"), updatedAt: at(0) });
    await refresh(() => /Round 2 notes/.test(pinned()?.textContent || ""), "the new version shows");
    assert.equal(pinned().querySelector(".home-pinned-head h2").textContent, "Notes, round 2");
    assert.equal(JSON.stringify(layout()), saved, "an update leaves the layout as it was");
    // Back to the source: its project shows it, highlighted.
    p.button("Open in App", pinned()).click();
    await waitFor(() => card(p, "p-app", "notes").hasAttribute("data-home-highlight"), "the source is highlighted");
    assert.ok(p.scrolled.includes(card(p, "p-app", "notes")));
    // The user marks the report seen: it leaves the live Brief for history
    // (Core keeps its id); the pin shows it as last written, said to be seen.
    const app = home.projects[0].brief;
    const asSeen = { ...notes(), history: true, historyReason: "seen", currentSource: true, seen: { version: 3, at: at(0) } };
    app.sections = app.sections.filter((s) => s.key !== "notes");
    app.history = [asSeen, ...app.history];
    await refresh(() => /Marked seen/.test(pinned()?.textContent || ""), "the seen report stays pinned, said to be seen");
    assert.equal(pinned().dataset.pinState, "shown");
    assert.match(pinned().querySelector(".home-pinned-body").textContent, /Round 2 notes/);
    // Its owner writes it again (the same id): the new version, no longer said to be seen.
    app.sections.splice(1, 0, { ...asSeen, history: false, historyReason: undefined, currentSource: undefined, version: 4, seen: null, body: body("Round 3 notes") });
    await refresh(() => /Round 3 notes/.test(pinned()?.textContent || "") && !/Marked seen/.test(pinned().textContent), "the owner's next version shows");
    // Removed and written again under the same key: another section, never shown as this one.
    Object.assign(notes(), { id: 299, version: 1, body: body("Someone else's notes") });
    await refresh(() => pinned()?.dataset.pinState === "replaced", "the pin sees another section");
    assert.doesNotMatch(pinned().textContent, /Someone else's notes/);
    assert.match(pinned().textContent, /Another section now has the same key/);
    assert.ok(p.button("Pin the new section", pinned()), "the user may pin the new report");
    // The new section under the key is an ask: it is not offered for pinning.
    Object.assign(notes(), { kind: "ask", ask: { question: "Keep the notes?", state: "open", reply: { options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] } } });
    await refresh(() => pinned() && !p.button("Pin the new section", pinned()), "no pin offered for an ask");
    assert.equal(pinned().dataset.pinState, "replaced");
    assert.equal(layout().pins[0].id, 101, "the pin still names its own section");
    // Now an ask under that key: no body and no reply controls in the widget.
    Object.assign(notes(), { id: 101, kind: "ask", ask: { question: "Keep the notes?", state: "open", reply: { options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] } } });
    await refresh(() => pinned()?.dataset.pinState === "now-ask", "the pin sees an ask");
    assert.equal(pinned().querySelector("button[data-option], .home-ask, .home-pinned-body"), null);
    // The key's newest record decides, never an older entry with the pin's
    // id: each case starts from the seen report shown as last written.
    const seenAgain = () => {
      app.sections = app.sections.filter((s) => s.key !== "notes");
      app.teamSections = app.teamSections.filter((s) => s.key !== "notes");
      app.history = [asSeen, ...app.history.filter((s) => s.key !== "notes")];
    };
    const later = { history: false, historyReason: undefined, currentSource: undefined, version: 4, seen: null, body: body("Round 3 notes") };
    for (const [what, change] of [
      ["its next version was removed", () => app.history.unshift({ ...asSeen, ...later, history: true, historyReason: "removed" })],
      ["another Agent's newer section under the key was removed",
        () => app.history.unshift({ ...asSeen, ...later, id: 299, owner: owner("b", "Hana"), history: true, historyReason: "removed", body: body("Someone else's notes") })],
      ["it is live again but kept out of Home's view", () => app.teamSections.push({ ...asSeen, ...later })],
      ["its source is no longer one Home shows", () => (app.history[0] = { ...asSeen, currentSource: false })],
    ]) {
      seenAgain();
      await refresh(() => pinned()?.dataset.pinState === "shown" && /Marked seen/.test(pinned().textContent), `seen again before: ${what}`);
      change();
      await refresh(() => pinned()?.dataset.pinState === "removed", `not shown when ${what}`);
      assert.match(pinned().textContent, /no longer on Home/);
      assert.doesNotMatch(pinned().textContent, /Round 2 notes|Round 3 notes|Someone else's notes/);
    }
    // Its project gone: said so, and it can be unpinned.
    home.projects = home.projects.filter((panel) => panel.project.id !== "p-app");
    await refresh(() => pinned()?.dataset.pinState === "project-gone", "the pin sees the project is gone");
    p.button("Unpin", pinned()).click();
    await waitFor(() => !pinned(), "the pin is gone");
    assert.deepEqual(layout().pins, []);
    assert.equal(writes(), before, "nothing of this told Core anything");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
  // A pin belongs to its workspace's layout: another workspace on this device has its own.
  const pinnedHere = { order: [], hidden: [], pins: [{ projectId: "p-res", key: "metrics", id: 200, title: "Loss", projectName: "Research" }] };
  const fresh = homeFixture();
  fresh.projects.forEach((panel, n) => panel.brief.sections.forEach((s, i) => (s.id = 100 * (n + 1) + i)));
  const here = await mount({ home: fresh, storage: { "yuzuno.homeWidgets.ws-home": JSON.stringify(pinnedHere) } });
  try {
    await waitFor(() => here.doc.querySelector('.home-pinned[data-pin-state="shown"]'), "the saved pin shows");
    assert.match(here.doc.querySelector(".home-pinned").textContent, /Loss/);
    assert.match(here.doc.querySelector(".home-pinned").textContent, /older than its/, "a stale status says so in the widget too");
  } finally {
    here.close();
  }
  const other = await mount({ home: homeFixture(), workspace: "ws-other", storage: { "yuzuno.homeWidgets.ws-home": JSON.stringify(pinnedHere) } });
  try {
    await pause(200);
    assert.equal(other.doc.querySelector(".home-pinned"), null, "another workspace shows none of it");
  } finally {
    other.close();
  }
});

test("until the workspace is read, the widget layout is neither shown as arranged nor changed, and nothing is saved", async () => {
  const home = homeFixture();
  home.projects.forEach((panel, n) => panel.brief.sections.forEach((s, i) => (s.id = 100 * (n + 1) + i)));
  const saved = { order: ["machines"], hidden: ["machines"], pins: [{ projectId: "p-res", key: "metrics", id: 200, title: "Loss", projectName: "Research" }] };
  const p = await mount({ home, holdWorkspace: true, storage: { "yuzuno.homeWidgets.ws-home": JSON.stringify(saved) } });
  try {
    const column = p.doc.querySelector(".home-widget-column");
    const storage = p.w.localStorage;
    const keys = () => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key) => key.startsWith("yuzuno.homeWidgets"));
    // Home answered first: no layout yet, and nothing to arrange, hide or pin.
    assert.equal(p.calls.some((c) => c.url.endsWith("/api/workspace")), true);
    assert.match(column.textContent, /Reading this workspace's layout/);
    assert.equal(p.button("Organize", column), undefined);
    assert.equal(column.querySelector(".home-widget-slot, .home-machines"), null, "no widget is drawn, Machines reads nothing");
    assert.equal(p.doc.querySelector(".home-pin"), null, "no section offers a pin");
    assert.equal(p.calls.filter((c) => c.url.endsWith("/api/machine-load")).length, 0);
    assert.deepEqual(keys(), ["yuzuno.homeWidgets.ws-home"]);
    // The workspace is read: its own layout, its pin, and the controls.
    p.releaseWorkspace();
    // Home re-reads under the now-known Workspace identity instead of
    // carrying an unscoped reading across that boundary. Query its live DOM.
    const knownColumn = () => p.doc.querySelector(".home-widget-column");
    await waitFor(() => knownColumn() && p.button("Organize", knownColumn()), "the layout controls appear");
    await waitFor(() => knownColumn()?.querySelector('.home-pinned[data-pin-state="shown"]'), "the workspace's pin shows");
    assert.equal(knownColumn().querySelector(".home-machines"), null, "Machines stays hidden as this workspace keeps it");
    assert.ok(card(p, "p-app", "notes").querySelector(".home-pin"), "sections offer a pin again");
    // A change now is kept, under this workspace only.
    card(p, "p-app", "notes").querySelector(".home-pin").click();
    await waitFor(() => JSON.parse(p.w.localStorage.getItem("yuzuno.homeWidgets.ws-home")).pins.length === 2, "the pin is saved");
    assert.deepEqual(keys(), ["yuzuno.homeWidgets.ws-home"], "nothing was saved under no workspace");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// T-174: a report or status card takes a reply to its author, bound to the
// version on screen when the user began it. Booleans and text only in these
// assertions: a failing strict assertion on a node inspects React's fibers.
const replyBox = (root) => root.querySelector(".home-card-reply");
const keys = (body) => Object.keys(body).sort();
const changedAnswer = (title) => [400, { error: `section_changed: version 2 of “${title}” is no longer on Home; it changed after you began this reply. Nothing was sent, and your reply is kept.`, code: "message_not_submitted" }];

test("a report card takes a reply to its author with the version on screen; a newer version never changes it (T-174)", async () => {
  let refuse = true;
  const p = await mount({ replyAnswer: (body) => (body.version === 2 && refuse ? changedAnswer("Notes") : null) });
  try {
    assert.ok(!p.button("Reply", card(p, "p-app", "release")), "an ask has its own reply controls, no card reply");
    assert.ok(!!p.button("Reply", card(p, "p-app", "notes/review")), "a sub card takes a reply to its own author");
    const notes = card(p, "p-app", "notes");
    p.button("Reply", notes).click();
    await waitFor(() => !!replyBox(notes), "the reply opens under the card");
    assert.match(replyBox(notes).textContent, /Reply to “Notes” · version 2/);
    assert.equal(replyBox(notes).querySelector("select").value, "a", "to its author");
    assert.equal(p.posts(/\/brief\/reply$/).length, 0, "opening sends nothing");
    await type(p, replyBox(notes).querySelector("textarea"), "Please add the numbers");
    // The author writes version 3 meanwhile: the reply still names version 2.
    const app = p.state.home.projects[0];
    Object.assign(app.brief.sections[1], { version: 3, title: "Notes, revised" });
    p.event({ type: "workspace.changed", scope: "brief" });
    await waitFor(() => card(p, "p-app", "notes").dataset.sectionVersion === "3", "Home read version 3");
    const box = replyBox(card(p, "p-app", "notes"));
    assert.match(box.textContent, /Reply to “Notes” · version 2/);
    assert.match(box.textContent, /changed this card after you began \(now version 3\)/);
    assert.equal(box.querySelector("textarea").value, "Please add the numbers");
    p.button("Send", box).click();
    await waitFor(() => !!box.querySelector('[role="alert"]'), "Core's refusal is shown");
    const [first] = p.posts(/\/brief\/reply$/);
    assert.deepEqual(keys(first.body), ["agentId", "clientMessageId", "key", "text", "title", "version"]);
    assert.deepEqual([first.body.key, first.body.version, first.body.title, first.body.agentId, first.body.text],
      ["notes", 2, "Notes", "a", "Please add the numbers"]);
    assert.match(first.body.clientMessageId, uuid);
    assert.match(box.querySelector('[role="alert"]').textContent, /^version 2 of “Notes” is no longer on Home/);
    assert.equal(box.querySelector("textarea").value, "Please add the numbers", "the draft stays");
    assert.equal(p.w.localStorage.getItem("yuzuno.home-outbox.v1"), null, "nothing was submitted: no retry record");
    // Only the user moves it to the new version, and it is a new message.
    refuse = false;
    p.button("Refer it to version 3", box).click();
    await pause();
    assert.match(box.textContent, /Reply to “Notes, revised” · version 3/);
    p.button("Send", box).click();
    await waitFor(() => /Sent to Mori, referring to version 3/.test(box.textContent), "sent");
    const second = p.posts(/\/brief\/reply$/)[1].body;
    assert.deepEqual([second.version, second.title], [3, "Notes, revised"]);
    assert.notEqual(second.clientMessageId, first.body.clientMessageId);
    assert.equal(box.querySelector("textarea").value, "");
    assert.equal(p.w.localStorage.getItem("yuzuno.home-card-drafts.v1"), null, "a sent reply leaves no draft");
    assert.equal(p.posts(/\/brief\/(seen|defer)$/).length, 0, "a card reply marks nothing seen and defers nothing");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a card reply keeps its id and version through a lost answer and a reload; an older Core says why, sending nothing else (T-174)", async () => {
  const p = await mount({ failReplies: 1 });
  let stored;
  try {
    const review = card(p, "p-app", "notes/review");
    p.button("Reply", review).click();
    await waitFor(() => !!replyBox(review), "the reply opens");
    assert.equal(replyBox(review).querySelector("select").value, "b", "a sub card's own author");
    const area = replyBox(review).querySelector("textarea");
    await type(p, area, "Which branch?");
    // Composing with an IME: Enter only ends the composition.
    area.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true }));
    await pause();
    assert.equal(p.posts(/\/brief\/reply$/).length, 0, "nothing sent while composing");
    area.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await waitFor(() => !!replyBox(review).querySelector('[role="alert"]'), "the lost answer is shown");
    assert.equal(p.posts(/\/brief\/reply$/).length, 1);
    stored = storageOf(p);
  } finally {
    p.close();
  }
  const again = await mount({ storage: stored });
  try {
    const review = card(again, "p-app", "notes/review");
    await waitFor(() => !!replyBox(review), "the unconfirmed reply opens again after a reload");
    const box = replyBox(review);
    assert.equal(box.querySelector("textarea").value, "Which branch?");
    assert.match(box.textContent, /earlier reply here was not confirmed/);
    again.button("Send", box).click();
    again.button("Send", box).click();
    await waitFor(() => /Sent to Hana, referring to version 1/.test(box.textContent), "sent");
    await pause();
    const posts = again.posts(/\/brief\/reply$/);
    assert.equal(posts.length, 1, "a second click while sending sends nothing more");
    const before = JSON.parse(stored["yuzuno.home-outbox.v1"]);
    const kept = Object.values(before)[0];
    assert.deepEqual([posts[0].body.clientMessageId, posts[0].body.version, posts[0].body.key], [kept.clientMessageId, 1, "notes/review"]);
  } finally {
    again.close();
  }
  const older = await mount({ replyAnswer: () => [422, "Failed to deserialize the JSON body into the target type: unknown field `version`, expected one of `key`, `agentId`, `text`, `clientMessageId`, `choice` at line 1 column 90"] });
  try {
    const metrics = card(older, "p-res", "metrics");
    older.button("Reply", metrics).click();
    await waitFor(() => !!replyBox(metrics), "a status card takes a reply too");
    await type(older, replyBox(metrics).querySelector("textarea"), "Is this still running?");
    older.button("Send", replyBox(metrics)).click();
    await waitFor(() => !!replyBox(metrics).querySelector('[role="alert"]'), "the older Core's refusal is shown");
    assert.match(replyBox(metrics).querySelector('[role="alert"]').textContent, /can't bind a reply to a card version yet, so nothing was sent/);
    assert.equal(older.posts(/\/brief\/reply$/).length, 1, "never sent again without its reference");
    assert.equal(replyBox(metrics).querySelector("textarea").value, "Is this still running?");
    assert.equal(older.w.localStorage.getItem("yuzuno.home-outbox.v1"), null);
  } finally {
    older.close();
  }
});

test("an author who left waits for an explicit recipient; a card that leaves Home keeps the draft, sent nowhere (T-174)", async () => {
  const home = homeFixture();
  home.projects[0].brief.sections[1].owner = { agentId: "gone", name: "Kai", state: "closed" };
  const p = await mount({ home });
  try {
    const notes = card(p, "p-app", "notes");
    p.button("Reply", notes).click();
    await waitFor(() => !!replyBox(notes), "the reply opens");
    const box = replyBox(notes);
    assert.equal(box.querySelector("select").value, "", "no recipient chosen for the user");
    assert.match(box.textContent, /Kai is closed; choose who should get this reply/);
    await type(p, box.querySelector("textarea"), "Who owns this now?");
    assert.equal(p.button("Send", box).disabled, true, "nothing to send to yet");
    await choose(p, box.querySelector("select"), "b");
    assert.equal(p.button("Send", box).disabled, false);
    // The card leaves Home before anything is sent.
    home.projects[0].brief.sections.splice(1, 1);
    p.event({ type: "workspace.changed", scope: "brief" });
    await waitFor(() => !card(p, "p-app", "notes"), "the card is gone");
    const kept = p.panel("p-app").querySelector(".home-kept-reply");
    assert.ok(!!kept, "the draft is kept and explained");
    assert.match(kept.textContent, /Your reply to “Notes” \(version 2\) was not sent: that card is no longer on Home/);
    assert.match(kept.textContent, /Who owns this now\?/);
    assert.equal(p.posts(/\/brief\/reply$/).length, 0, "not sent to another card or Agent");
    p.button("Discard", kept).click();
    await pause();
    assert.ok(!p.panel("p-app").querySelector(".home-kept-reply"));
    assert.equal(p.w.localStorage.getItem("yuzuno.home-card-drafts.v1"), null);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a pinned report takes the same reply as its card: one draft, and one send whichever place sends (T-174)", async () => {
  const home = homeFixture();
  home.projects.forEach((panel, n) => panel.brief.sections.forEach((s, i) => (s.id = 100 * (n + 1) + i)));
  const p = await mount({ home });
  try {
    const column = p.doc.querySelector(".home-widget-column");
    const pinned = () => column.querySelector(".home-pinned");
    card(p, "p-app", "notes").querySelector('[aria-label="Pin “Notes” to My widgets"]').click();
    await waitFor(() => !!pinned(), "Notes is pinned");
    p.button("Reply", pinned()).click();
    await waitFor(() => !!replyBox(pinned()), "the reply opens in the widget");
    assert.match(replyBox(pinned()).textContent, /Reply to “Notes” · version 2/);
    assert.equal(replyBox(pinned()).querySelector("select").value, "a", "to the card's author");
    await type(p, replyBox(pinned()).querySelector("textarea"), "From the widget");
    // The card shows the same reply, not a second one.
    const notes = card(p, "p-app", "notes");
    p.button("Reply", notes).click();
    await waitFor(() => !!replyBox(notes), "the card's reply opens");
    assert.equal(replyBox(notes).querySelector("textarea").value, "From the widget");
    await type(p, replyBox(notes).querySelector("textarea"), "From the card");
    assert.equal(replyBox(pinned()).querySelector("textarea").value, "From the card", "one draft in both places");
    // Both places send in the same moment: one request.
    p.button("Send", replyBox(notes)).click();
    p.button("Send", replyBox(pinned())).click();
    await waitFor(() => /Sent to Mori, referring to version 2/.test(replyBox(pinned()).textContent), "the widget shows it sent");
    await pause();
    assert.equal(p.posts(/\/brief\/reply$/).length, 1, "sent once");
    assert.match(replyBox(notes).textContent, /Sent to Mori, referring to version 2/);
    const [post] = p.posts(/\/brief\/reply$/);
    assert.deepEqual([post.body.key, post.body.version, post.body.title, post.body.text], ["notes", 2, "Notes", "From the card"]);
    assert.equal(p.posts(/\/brief\/(seen|defer)$/).length, 0, "nothing seen or deferred");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a report marked seen takes a reply from History at its version; removed entries, older versions and live keys take none (T-174)", async () => {
  const home = homeFixture();
  home.projects[0].brief.history = [
    section("weekly", "report", "Weekly", 3, owner("b", "Hana"), { history: true, historyReason: "seen", currentSource: true, seen: { version: 3, at: at(900) } }),
    section("weekly", "report", "Weekly", 2, owner("b", "Hana"), { history: true, historyReason: "seen", currentSource: true }),
    section("dropped", "report", "Dropped", 1, owner("a", "Mori"), { history: true, historyReason: "removed" }),
    section("notes", "report", "Notes", 1, owner("a", "Mori"), { history: true, historyReason: "seen", currentSource: true }),
  ];
  const p = await mount({ home });
  try {
    const history = p.panel("p-app").querySelector(".home-history");
    history.open = true;
    const entries = [...history.querySelectorAll("li details")];
    for (const entry of entries) {
      entry.open = true;
      entry.dispatchEvent(new p.w.Event("toggle"));
    }
    await waitFor(() => entries.every((entry) => / body/.test(entry.textContent)), "the entries open");
    assert.deepEqual(entries.map((entry) => !!p.button("Reply", entry)), [true, false, false, false],
      "only each key's newest seen report, while no card under its key is live");
    p.button("Reply", entries[0]).click();
    await waitFor(() => !!replyBox(entries[0]), "the reply opens in History");
    assert.match(replyBox(entries[0]).textContent, /Reply to “Weekly” · version 3/);
    assert.equal(replyBox(entries[0]).querySelector("select").value, "b");
    await type(p, replyBox(entries[0]).querySelector("textarea"), "Can this stay weekly?");
    p.button("Send", replyBox(entries[0])).click();
    await waitFor(() => /Sent to Hana, referring to version 3/.test(replyBox(entries[0]).textContent), "sent");
    const [post] = p.posts(/\/brief\/reply$/);
    assert.deepEqual([post.body.key, post.body.version, post.body.title], ["weekly", 3, "Weekly"]);
    assert.equal(p.posts(/\/brief\/(seen|defer)$/).length, 0, "History stays as it was");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a reply begun on a card the user then marks seen stays sendable, at that version, from its project (T-174)", async () => {
  const p = await mount();
  try {
    const review = card(p, "p-app", "notes/review");
    p.button("Reply", review).click();
    await waitFor(() => !!replyBox(review), "the reply opens");
    await type(p, replyBox(review).querySelector("textarea"), "Before I mark it seen");
    // Core keeps a report the user marks seen in History, at that version.
    const app = p.state.home.projects[0].brief;
    const shown = app.sections.find((s) => s.key === "notes/review");
    app.sections = app.sections.filter((s) => s !== shown);
    app.history.unshift({ ...shown, history: true, historyReason: "seen", currentSource: true, seen: { version: 1, at: at(0) } });
    p.button("Seen", review).click();
    await waitFor(() => !card(p, "p-app", "notes/review"), "the card left for History");
    const kept = p.panel("p-app").querySelector(".home-kept-reply");
    assert.ok(!!kept, "the reply is kept in the project");
    assert.match(kept.textContent, /Your reply to “Review notes” is kept: that card is now in History, marked seen/);
    assert.equal(replyBox(kept).querySelector("textarea").value, "Before I mark it seen");
    p.button("Send", replyBox(kept)).click();
    await waitFor(() => /Sent to Hana, referring to version 1/.test(replyBox(kept).textContent), "sent from the kept reply");
    const [post] = p.posts(/\/brief\/reply$/);
    assert.deepEqual([post.body.key, post.body.version], ["notes/review", 1]);
    assert.deepEqual(p.posts(/\/brief\/seen$/).map((c) => c.body), [{ sections: [{ key: "notes/review", version: 1 }] }], "only the user's own Seen");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// T-177: a Home image opens in the app's preview and Point & Fix marks it,
// on Codex Agents that can take images. What Point & Fix needs from a
// browser, which jsdom lacks, is stubbed: decoding (400×300), drawing,
// object URLs; the snapshot read and image uploads answer here.
function homeImages() {
  const home = homeFixture();
  const app = home.projects.find((entry) => entry.project.id === "p-app");
  const shot = { name: "screen.png", kind: "image", mime: "image/png", size: 9, snapshot: true, mayChange: false, takenAt: "2026-10-22T09:00:00Z" };
  const files = { root: "body", elements: {
    body: { type: "BriefBody", props: {}, children: ["files"] },
    files: { type: "Attachments", props: { items: [{ name: "screen.png", caption: "Login screen" }] } },
  } };
  app.brief.sections.push(
    section("shots", "report", "Screens", 4, owner("b", "Hana"), { body: files, attachments: [shot], seen: { version: 4, at: at(9) } }),
    section("ghost", "report", "Old screens", 2, { agentId: "z", name: "Kumo", state: "deleted" }, { body: files, attachments: [shot], seen: { version: 2, at: at(9) } }),
  );
  return home;
}
function pointFixStubs(p) {
  const uploads = [], reads = [];
  p.w.createImageBitmap = async () => ({ width: 400, height: 300, close() {} });
  p.w.URL.createObjectURL = () => "blob:point-fix";
  p.w.URL.revokeObjectURL = () => {};
  p.w.HTMLCanvasElement.prototype.getContext = () =>
    ({ drawImage() {}, beginPath() {}, arc() {}, fill() {}, fillText() {}, strokeRect() {} });
  p.w.HTMLCanvasElement.prototype.toBlob = function (done, type) { done(new p.w.Blob([`annotated ${this.width}x${this.height}`], { type })); };
  const base = p.w.fetch;
  p.w.fetch = async (url, init = {}) => {
    if (/\/brief\/attachments\/[^/]+\/screen\.png\?version=\d+$/.test(url) && !init.method) {
      reads.push(url);
      return { ok: true, status: 200, blob: async () => new p.w.Blob(["png-bytes"], { type: "image/png" }) };
    }
    const upload = /\/api\/agents\/(\w)\/images$/.exec(url);
    if (upload && init.method === "POST") {
      const content = await init.body.text();
      uploads.push({ agent: upload[1], content });
      return { ok: true, status: 200, json: async () => ({ id: `${String(uploads.length).repeat(64)}.png`, width: 400, height: 300, bytes: content.length }) };
    }
    return base(url, init);
  };
  return { uploads, reads };
}
const codexAgents = agents.map((agent) => ({ ...agent, harness: "codex" }));
const buttonIn = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text));

test("a Home image opens in the app, and Mark up adds it with its card to the author's draft, sending nothing (T-177)", async () => {
  const p = await mount({ home: homeImages(), workspaceAgents: codexAgents });
  try {
    const { uploads, reads } = pointFixStubs(p);
    await waitFor(() => card(p, "p-app", "shots")?.querySelector("button.brief-image"), "the image is drawn");
    const shots = card(p, "p-app", "shots");
    assert.ok(!shots.querySelector(".brief-attachment a"), "no link to a browser tab");
    const preview = () => p.doc.querySelector('[role="dialog"]');
    shots.querySelector("button.brief-image").click();
    await waitFor(preview, "the preview opens");
    assert.equal(preview().querySelector("h2").textContent, "screen.png");
    assert.match(preview().textContent, /Login screen · Snapshot/);
    assert.match(preview().querySelector(".input-image-dialog img").getAttribute("src"), /\/api\/projects\/p-app\/brief\/attachments\/shots\/screen\.png\?version=4$/);
    const writes = () => p.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/api/collaboration/github_repositories"));
    assert.deepEqual(writes().map((c) => c.url), [], "looking writes nothing");
    buttonIn(preview(), "Mark up").click();
    const dialog = () => p.doc.querySelector(".point-fix-dialog");
    await waitFor(() => dialog()?.querySelector(".point-fix-image svg"), "the image opens for marking, without choosing a file");
    assert.deepEqual(reads.map((url) => url.replace(/^.*\/api\//, "/api/")), ["/api/projects/p-app/brief/attachments/shots/screen.png?version=4"]);
    const select = dialog().querySelector(".point-fix-target select");
    assert.equal(select.value, "b", "the card's author is offered first");
    assert.match(select.selectedOptions[0].textContent, /Hana · its owner/);
    buttonIn(dialog(), "Add area").click();
    await pause();
    await type(p, dialog().querySelector('[aria-label="Area 1 comment"]'), "Button is cut off");
    buttonIn(dialog(), "Add to Hana’s draft").click();
    const hana = () => p.doc.querySelector('[data-composer-input][aria-label="Message Hana"]');
    await waitFor(() => !dialog() && hana(), "Hana's draft opens");
    const text = composerText(hana());
    assert.match(text, /Point & Fix feedback on “screen\.png” \(400×300 px\): 1 marked area in the attached annotated image, with the original image attached\./);
    assert.match(text, /Source: the image “screen\.png” on the Home card “Screens” \(project p-app, section shots, version 4; snapshot taken 2026-10-22T09:00:00Z\)/);
    assert.match(text, /1\. Area at x \d+, y \d+, \d+×\d+ px: Button is cut off/);
    assert.deepEqual(uploads.map((u) => [u.agent, u.content]), [["b", "annotated 400x300"], ["b", "png-bytes"]]);
    assert.equal(p.posts(/\/(messages|turns)$|\/brief\/(reply|seen)$/).length, 0, "nothing is sent, answered or marked seen");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a Home image whose author is gone is never offered to another Agent: the user chooses (T-177)", async () => {
  const p = await mount({ home: homeImages(), workspaceAgents: codexAgents });
  try {
    const { uploads } = pointFixStubs(p);
    await waitFor(() => card(p, "p-app", "ghost")?.querySelector("button.brief-image"), "the image is drawn");
    card(p, "p-app", "ghost").querySelector("button.brief-attachment-open").click();
    const preview = () => p.doc.querySelector('[role="dialog"]');
    await waitFor(preview, "Open opens the same preview");
    buttonIn(preview(), "Mark up").click();
    const dialog = () => p.doc.querySelector(".point-fix-dialog");
    await waitFor(() => dialog()?.querySelector(".point-fix-image svg"), "the image opens for marking");
    const select = dialog().querySelector(".point-fix-target select");
    assert.equal(select.value, "", "nobody is picked in the author's place");
    assert.match(dialog().textContent, /Its author is no longer an Agent here\. Choose whom to tell\./);
    buttonIn(dialog(), "Add area").click();
    await pause();
    assert.equal(buttonIn(dialog(), "Add to the Agent’s draft").disabled, true);
    select.value = "a";
    select.dispatchEvent(new p.w.Event("change", { bubbles: true }));
    await pause();
    assert.equal(buttonIn(dialog(), "Add to Mori’s draft").disabled, false, "a chosen Agent can be told");
    buttonIn(dialog(), "Cancel").click();
    await waitFor(() => !dialog(), "Cancel closes it");
    assert.deepEqual(uploads, [], "cancelling adds nothing");
    assert.equal(p.posts(/\/(messages|turns|images)$/).length, 0);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// T-189: a project's repository details on Home follow the interface
// language, changed in another window; the repository's name stays.
test("Home's repository details follow a language change; the repository stays as named and nothing is read again (T-189)", async () => {
  const p = await mount({ linked: [repo] });
  try {
    await waitFor(() => p.panel("p-app").querySelector(".home-repos .repo-activity"), "the Repositories block is read");
    [...p.panel("p-app").querySelectorAll(".home-repos button")].find((b) => b.textContent === "Repository details…").click();
    await waitFor(() => p.panel("p-app").querySelector('.home-repos [aria-label="GitHub repositories"] .github-entry'), "the repositories are listed");
    const reads = () => p.calls.filter((c) => c.url.endsWith("/api/collaboration/github_repositories")).length;
    const before = reads();
    p.w.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
    p.w.dispatchEvent(new p.w.StorageEvent("storage", { key: "yuzuno.language" }));
    await waitFor(() => p.panel("p-app").querySelector('.home-repos [aria-label="GitHub 仓库"]'), "the details follow the language");
    const details = p.panel("p-app").querySelector('.home-repos [aria-label="GitHub 仓库"]');
    assert.equal(details.querySelector("h4").textContent, "仓库");
    assert.ok(details.textContent.includes("链接此项目使用的仓库。一个仓库可以属于多个项目。"));
    assert.ok(details.querySelector(".github-entry").textContent.includes("acme/app"), "the repository as named");
    assert.equal(reads(), before, "no github_repositories read again");
  } finally {
    p.close();
  }
});

// T-182: an Ask's free-text reply not sent yet is kept in this browser, apart
// from card replies, with the version of the ask it was begun on. Booleans and
// text only in these assertions (see T-174 above).
const ASK_DRAFTS = "yuzuno.home-ask-drafts.v1";
const askDrafts = (p) => JSON.parse(p.w.localStorage.getItem(ASK_DRAFTS) || "{}");
const releaseSlot = (workspace = "ws-home") => JSON.stringify([workspace, "p-app", "release"]);
const askField = (p) => card(p, "p-app", "release").querySelector(".home-ask-reply textarea");

test("an Ask's unsent reply is kept across a reload with its recipient and version; a delivery clears only what it sent (T-182)", async () => {
  let stored;
  const p = await mount();
  try {
    // Begun for the owner, emptied, sent to Hana instead, then written: Hana's.
    await type(p, askField(p), "A first thought for Mori.");
    await type(p, askField(p), "");
    await choose(p, card(p, "p-app", "release").querySelector(".home-reply-target select"), "b");
    await type(p, askField(p), "Only after the docs land.");
    const kept = askDrafts(p)[releaseSlot()];
    assert.deepEqual([kept.key, kept.text, kept.version, kept.agentId], ["release", "Only after the docs land.", 3, "b"]);
    assert.equal(p.w.localStorage.getItem("yuzuno.home-card-drafts.v1"), null, "an Ask's draft is not a card reply's");
    assert.equal(p.posts(/\/brief\/reply$/).length, 0, "writing sends nothing");
    stored = storageOf(p);
  } finally {
    p.close();
  }
  let answer = () => {};
  const held = new Promise((resolve) => (answer = resolve));
  const again = await mount({ storage: stored, replyAnswer: (body) => (body.key === "release" ? held.then(() => null) : null) });
  try {
    const release = card(again, "p-app", "release");
    assert.equal(askField(again).value, "Only after the docs land.", "the text is back after a reload");
    assert.equal(release.querySelector(".home-reply-target select").value, "b", "and its recipient");
    assert.match(release.textContent, /Kept from before, not sent yet: your reply to version 3 of this ask\./);
    again.button("Send", release.querySelector(".home-text-reply")).click();
    await waitFor(() => again.posts(/\/brief\/reply$/).length === 1, "the reply is being sent");
    // Written while it is being sent: not what was sent, so it stays.
    await type(again, askField(again), "Only after the docs land. And the changelog.");
    answer();
    await waitFor(() => /Replied · waiting for/.test(card(again, "p-app", "release").textContent), "delivered");
    const [sent] = again.posts(/\/brief\/reply$/);
    assert.deepEqual(keys(sent.body), ["agentId", "clientMessageId", "key", "text"], "an Ask's reply names no version or title");
    assert.deepEqual([sent.body.key, sent.body.agentId, sent.body.text], ["release", "b", "Only after the docs land."]);
    assert.equal(askDrafts(again)[releaseSlot()].text, "Only after the docs land. And the changelog.");
    assert.match(card(again, "p-app", "release").textContent, /A reply you wrote here is kept, not sent: Reply again to see it\./);
    again.button("Reply again", card(again, "p-app", "release")).click();
    await pause();
    assert.equal(askField(again).value, "Only after the docs land. And the changelog.");
    again.button("Send", card(again, "p-app", "release").querySelector(".home-text-reply")).click();
    await waitFor(() => again.posts(/\/brief\/reply$/).length === 2, "the second reply is sent");
    await waitFor(() => again.w.localStorage.getItem(ASK_DRAFTS) === null, "a delivered reply leaves no draft");
    assert.equal(again.posts(/\/brief\/reply$/)[1].body.text, "Only after the docs land. And the changelog.");
    assert.deepEqual(again.errors, []);
  } finally {
    again.close();
  }
});

test("an Ask asked again under its key holds a reply begun on the earlier version until the user refers it or discards it (T-182)", async () => {
  const p = await mount();
  const reask = async (version, question) => {
    Object.assign(p.state.home.projects[0].brief.sections[0], { version, ask: { question, state: "open", reply: { freeText: true } } });
    p.event({ type: "workspace.changed", scope: "brief" });
    await waitFor(() => card(p, "p-app", "release").dataset.sectionVersion === String(version), `Home read version ${version}`);
  };
  try {
    await type(p, askField(p), "Ship after QA.");
    await reask(4, "Ship the release on Monday?");
    const release = () => card(p, "p-app", "release");
    assert.match(release().textContent, /You began this reply on version 3 of this ask; Home shows version 4\./);
    assert.equal(askField(p).value, "Ship after QA.", "the text stays");
    const send = () => p.button("Send", release().querySelector(".home-text-reply"));
    assert.equal(send().disabled, true, "not sent to the new question as it is");
    askField(p).dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await pause();
    assert.equal(p.posts(/\/brief\/reply$/).length, 0, "nor by the keyboard");
    p.button("Refer it to version 4", release()).click();
    await pause();
    assert.equal(askDrafts(p)[releaseSlot()].version, 4);
    assert.equal(send().disabled, false);
    send().click();
    await waitFor(() => p.posts(/\/brief\/reply$/).length === 1, "sent once referred");
    assert.deepEqual(keys(p.posts(/\/brief\/reply$/)[0].body), ["agentId", "clientMessageId", "key", "text"]);
    await waitFor(() => p.w.localStorage.getItem(ASK_DRAFTS) === null, "no draft after delivery");
    // Begun again, then the question changes again: Discard drops it, sending nothing.
    p.button("Reply again", release()).click();
    await pause();
    await type(p, askField(p), "Monday is fine.");
    await reask(5, "Ship the release on Tuesday?");
    assert.match(release().textContent, /began this reply on version 4 of this ask; Home shows version 5/);
    p.button("Discard", release().querySelector(".home-ask-reply")).click();
    await pause();
    assert.equal(askField(p).value, "");
    assert.equal(p.w.localStorage.getItem(ASK_DRAFTS), null);
    assert.equal(p.posts(/\/brief\/reply$/).length, 1, "discarding sends nothing");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an Ask's draft belongs to its Workspace, shows once the Workspace is read, and says so when this browser won't keep it (T-182)", async () => {
  const draft = (text, agentId = "a") => JSON.stringify({ key: "release", text, version: 3, agentId, at: new Date().toISOString() });
  const other = await mount({ storage: { [ASK_DRAFTS]: JSON.stringify({ [releaseSlot("ws-other")]: JSON.parse(draft("For the other Workspace.")) }) } });
  try {
    assert.equal(askField(other).value, "", "another Workspace's draft is not shown here");
  } finally {
    other.close();
  }
  const late = await mount({ holdWorkspace: true, storage: { [ASK_DRAFTS]: JSON.stringify({ [releaseSlot()]: JSON.parse(draft("Kept for this Workspace.", "b")) }) } });
  try {
    assert.equal(askField(late).value, "", "nothing is shown before the Workspace is known");
    late.releaseWorkspace();
    await waitFor(() => askField(late).value === "Kept for this Workspace.", "its own draft shows once it is read");
    assert.match(card(late, "p-app", "release").textContent, /Kept from before, not sent yet: your reply to version 3/);
    assert.equal(card(late, "p-app", "release").querySelector(".home-reply-target select").value, "b", "with the recipient the user chose, not the owner");
  } finally {
    late.close();
  }
  // Kept for an Agent no longer in the project: the user chooses again; nothing goes elsewhere.
  const gone = await mount({ storage: { [ASK_DRAFTS]: JSON.stringify({ [releaseSlot()]: JSON.parse(draft("For an Agent who left.", "gone")) }) } });
  try {
    const release = card(gone, "p-app", "release");
    assert.equal(askField(gone).value, "For an Agent who left.");
    assert.equal(release.querySelector(".home-reply-target select").value, "", "no recipient is chosen for the user");
    assert.equal(gone.button("Send", release.querySelector(".home-text-reply")).disabled, true);
    assert.equal(gone.button("Ship today", release).disabled, true, "nor does an option send it anywhere");
    await choose(gone, release.querySelector(".home-reply-target select"), "a");
    assert.equal(gone.button("Send", release.querySelector(".home-text-reply")).disabled, false);
    assert.equal(gone.posts(/\/brief\/reply$/).length, 0);
  } finally {
    gone.close();
  }
  const refused = await mount();
  try {
    const set = refused.w.Storage.prototype.setItem;
    refused.w.Storage.prototype.setItem = function (key, value) {
      if (key === ASK_DRAFTS) throw new refused.w.DOMException("Refused here.", "QuotaExceededError");
      return set.call(this, key, value);
    };
    await type(refused, askField(refused), "Kept only here.");
    assert.equal(askField(refused).value, "Kept only here.");
    assert.match(card(refused, "p-app", "release").textContent, /This browser didn't keep the draft: it is only in this window\./);
    assert.deepEqual(refused.errors, []);
  } finally {
    refused.close();
  }
});

test("T-9 card density: low by default, high on a click, kept on this device for this Workspace and sent nowhere", async () => {
  const p = await mount();
  try {
    const group = p.doc.querySelector('.home-header .home-density[role="group"]');
    assert.ok(group, "the choice is in Home's header");
    assert.equal(group.getAttribute("aria-label"), "Card density");
    const option = (label) => [...group.querySelectorAll("button")].find((b) => b.textContent === label);
    assert.equal(option("Low density").getAttribute("aria-pressed"), "true", "low is Home's default");
    assert.equal(option("Low density").title, "Spacious: each card’s main point");
    assert.equal(option("High density").title, "Compact: every field and row");
    assert.equal(p.doc.querySelector(".home-view").dataset.density, "low");
    const before = p.calls.length;
    option("High density").click();
    await waitFor(() => p.doc.querySelector(".home-view").dataset.density === "high", "high applies");
    assert.equal(option("High density").getAttribute("aria-pressed"), "true");
    assert.equal(p.w.localStorage.getItem("yuzuno.homeDensity.ws-home"), '"high"', "kept on this device for this Workspace");
    assert.equal(p.w.localStorage.getItem("yuzuno.homeDensity"), null, "not for every Workspace");
    // Home's repository read is a POST of its own; nothing else is sent.
    assert.deepEqual(
      p.calls.slice(before).filter((c) => c.method !== "GET" && !c.url.endsWith("/api/collaboration/github_repositories")).map((c) => c.url),
      [],
      "nothing is sent to Core or an Agent",
    );
    assert.ok(!p.doc.querySelector(".home-density-note"), "no note when kept");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
  const stored = { "yuzuno.homeDensity.ws-home": '"high"' };
  // Read again on this device, for this Workspace only.
  const again = await mount({ storage: stored });
  try {
    assert.equal(again.doc.querySelector(".home-view").dataset.density, "high");
  } finally {
    again.close();
  }
  const other = await mount({ storage: stored, workspace: "ws-other" });
  try {
    assert.equal(other.doc.querySelector(".home-view").dataset.density, "low", "another Workspace keeps its own, low until chosen");
  } finally {
    other.close();
  }
});

test("T-9 card density another window saves while Home is closed here shows when Home opens again", async () => {
  const p = await mount();
  try {
    assert.equal(p.doc.querySelector(".home-view").dataset.density, "low");
    p.button("Sora", p.panel("p-res").querySelector(".home-error")).click();
    await waitFor(() => p.doc.querySelector(".conversation-title h1")?.textContent === "Sora", "Sora's conversation is open");
    assert.ok(!p.doc.querySelector(".home-view"), "Home is closed");
    // Another window of this device chooses high density for this Workspace.
    p.w.localStorage.setItem("yuzuno.homeDensity.ws-home", '"high"');
    p.w.dispatchEvent(new p.w.StorageEvent("storage", { key: "yuzuno.homeDensity.ws-home" }));
    p.button("Back to Home").click();
    await waitFor(() => p.doc.querySelector(".home-view [data-home-project]"), "back on Home");
    assert.equal(p.doc.querySelector(".home-view").dataset.density, "high", "the choice made meanwhile, not the one read before");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("T-9 card density a device refuses to keep still applies in this window, says it was not kept, and outlasts another Workspace's update", async () => {
  const p = await mount();
  try {
    const setItem = p.w.Storage.prototype.setItem;
    p.w.Storage.prototype.setItem = function () {
      throw new p.w.DOMException("full", "QuotaExceededError");
    };
    try {
      [...p.doc.querySelectorAll(".home-density button")].find((b) => b.textContent === "High density").click();
      await waitFor(() => p.doc.querySelector(".home-view").dataset.density === "high", "high applies here");
      await waitFor(() => p.doc.querySelector(".home-density-note"), "the note says it was not kept");
      assert.match(p.doc.querySelector(".home-density-note").textContent, /not kept on this device: this browser’s storage for Yuzuno is full/);
    } finally {
      p.w.Storage.prototype.setItem = setItem;
    }
    // Another Workspace's choice saved in another window leaves this unsaved one as it is.
    p.w.localStorage.setItem("yuzuno.homeDensity.ws-other", '"low"');
    p.w.dispatchEvent(new p.w.StorageEvent("storage", { key: "yuzuno.homeDensity.ws-other" }));
    await pause(100);
    assert.equal(p.doc.querySelector(".home-view").dataset.density, "high", "still high in this window");
    assert.ok(p.doc.querySelector(".home-density-note"), "still said not to be kept");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("T-9 a task change Core announces reads Home again, once for a burst; other collaboration changes don't", async () => {
  const p = await mount();
  const reads = () => p.calls.filter((c) => c.url.endsWith("/api/home")).length;
  try {
    await waitFor(() => reads() > 0, "Home's first read");
    // Hidden, the page's own polling and Home's safety net read nothing, so
    // every read counted here is an event's.
    p.setVisibility("hidden");
    await pause(2_500);
    const before = reads();
    // Mail, comments and GitHub syncs say collaboration without tasks.
    p.event({ type: "workspace.changed", scope: "collaboration", collaboration: true });
    await pause(2_500);
    assert.equal(reads(), before, "no Home read for a collaboration change without tasks");
    // A burst of task changes is one read.
    for (let i = 0; i < 5; i++) p.event({ type: "workspace.changed", scope: "collaboration", collaboration: true, tasks: true });
    await waitFor(() => reads() > before, "a task change reads Home again");
    await pause(2_500);
    assert.equal(reads(), before + 1, `one read for the burst: ${reads() - before}`);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
