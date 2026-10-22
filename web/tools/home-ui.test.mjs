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

async function mount({ storage = {}, home = homeFixture(), failReplies = 0, replyStatus = "accepted", workspace = "ws-home", holdWorkspace = false, load = machineLoad, linked = [], workspaceAgents = agents } = {}) {
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

test("Home is laid out in columns: Machines is a widget beside Needs you and the projects, arranged on this device", async () => {
  const p = await mount();
  try {
    const column = p.doc.querySelector('.home-layout > .home-widget-column[aria-label="Widgets"]');
    assert.ok(column, "a widget column in the layout");
    assert.ok(column.querySelector('[data-widget="machines"] .home-machines'), "Machines is a widget there");
    assert.ok(p.doc.querySelector(".home-layout > .home-needs-area .home-needs-you"), "Needs you has its own area");
    assert.ok(p.doc.querySelector(".home-layout > .home-main [data-home-project]"), "the projects have theirs");
    assert.equal(column.querySelector(".home-needs-you, [data-home-project]"), null, "neither is inside the widget column");
    // The project panels keep their own inner .home-widgets; the column shares no class with them.
    assert.equal(column.matches(".home-widgets") || !!column.querySelector(".home-widget, .home-widgets"), false);
    // Manage opens the Machines page.
    p.button("Manage", column).click();
    await waitFor(() => /Where your agents run/.test(p.doc.querySelector('[role="dialog"]')?.textContent || ""), "the Machines page opens");
    p.doc.querySelector('[role="dialog"]').dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await waitFor(() => !p.doc.querySelector('[role="dialog"]'), "the Machines page closes");
    // Hidden, a widget is not drawn and reads nothing; the choice is kept.
    p.button("Arrange", column).click();
    await pause();
    assert.equal(column.querySelector('[aria-label="Move Machines up"]').disabled, true);
    column.querySelector('[aria-label="Hide Machines"]').click();
    await waitFor(() => !column.querySelector(".home-machines"), "Machines is hidden");
    assert.deepEqual(JSON.parse(p.w.localStorage.getItem("yuzuno.homeWidgets.ws-home")), { order: ["machines"], hidden: ["machines"], pins: [] });
    const reads = () => p.calls.filter((c) => c.url.endsWith("/api/machine-load")).length;
    const before = reads();
    await pause(2300);
    assert.equal(reads(), before, "a hidden widget does not sample");
    p.button("Done", column).click();
    await pause();
    assert.match(column.textContent, /No widgets on show\. Add one:/);
    p.button("Machines", column.querySelector(".home-widget-column-add")).click();
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
    card(p, "p-app", "notes").querySelector('[aria-label="Pin “Notes” to Widgets"]').click();
    await waitFor(() => pinned(), "Notes is pinned");
    assert.match(pinned().querySelector(".home-pinned-from").textContent, /^App · Mori · Updated /);
    assert.match(pinned().querySelector(".home-pinned-body").textContent, /Notes body/);
    assert.equal(card(p, "p-app", "notes").querySelector(".home-pin").getAttribute("aria-pressed"), "true");
    // Pinning tells Core nothing: no Seen, and nothing needs you twice.
    assert.equal(writes(), before);
    assert.deepEqual([...p.doc.querySelectorAll("[data-needs-you]")].map((e) => e.dataset.needsYou), needs);
    const layout = () => JSON.parse(p.w.localStorage.getItem("yuzuno.homeWidgets.ws-home"));
    assert.deepEqual(layout().pins, [{ projectId: "p-app", key: "notes", id: 101, title: "Notes", projectName: "App" }]);
    // Hidden, it stays pinned and shows again; unpinning is a separate button.
    p.button("Arrange", column).click();
    await pause();
    assert.ok(column.querySelector('[aria-label="Unpin Notes"]') && column.querySelector('[aria-label="Hide Notes"]'));
    column.querySelector('[aria-label="Hide Notes"]').click();
    await waitFor(() => !pinned(), "the pinned section is hidden");
    assert.equal(layout().pins.length, 1, "hidden, it is still pinned");
    assert.deepEqual(layout().hidden, ["pin:p-app:101:notes"]);
    p.button("Notes", column.querySelector(".home-widget-column-add")).click();
    await waitFor(() => pinned(), "it shows again");
    assert.deepEqual(layout().hidden, []);
    p.button("Done", column).click();
    await pause();
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
    assert.equal(p.button("Arrange", column), undefined);
    assert.equal(column.querySelector(".home-widget-slot, .home-widget-add, .home-machines"), null, "no widget is drawn, Machines reads nothing");
    assert.equal(p.doc.querySelector(".home-pin"), null, "no section offers a pin");
    assert.equal(p.calls.filter((c) => c.url.endsWith("/api/machine-load")).length, 0);
    assert.deepEqual(keys(), ["yuzuno.homeWidgets.ws-home"]);
    // The workspace is read: its own layout, its pin, and the controls.
    p.releaseWorkspace();
    await waitFor(() => p.button("Arrange", column), "the layout controls appear");
    await waitFor(() => column.querySelector('.home-pinned[data-pin-state="shown"]'), "the workspace's pin shows");
    assert.equal(column.querySelector(".home-machines"), null, "Machines stays hidden as this workspace keeps it");
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
