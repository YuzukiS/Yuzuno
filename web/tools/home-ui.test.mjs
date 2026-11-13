import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";
import { hoverTip, readTip } from "./tip-dom.mjs";
import { composerText, setComposerText } from "./composer-driver.mjs";
import { doseStudy, fixtureFiles } from "./research-fixtures.mjs";

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

// open: a Project's page to show once Home has read, where that project's cards are (YN-86).
async function mount({ storage = {}, home = homeFixture(), failReplies = 0, replyStatus = "accepted", replyAnswer = null, workspace = "ws-home", holdWorkspace = false, load = machineLoad, linked = [], activity = {}, workspaceAgents = agents, research = null, before = null, url = "http://127.0.0.1:4317/", pressHome = true, open = null } = {}) {
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
    url,
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
    // Home's other machines (YN-83 S1): none registered here, so the card only says so.
    if (url.endsWith("/api/machine-live")) return respond({ machines: [] });
    if (url.endsWith("/api/home/order")) {
      state.home.order = request.body.projectIds;
      return respond({ order: request.body.projectIds });
    }
    if (/\/api\/projects\/[^/]+\/brief\/seen$/.test(url)) return respond({ ok: true });
    // A research desk's numbers (T-9), as the test answers them; none by default.
    if (/\/api\/projects\/[^/]+\/brief\/research\//.test(url)) {
      const answer = research ? await research(url) : { status: 404, body: { error: "section_not_found" } };
      return respond(answer.body, answer.status ?? 200);
    }
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
      return respond({ observedAt: at(1), repositories: linked.map((repo) => ({ ...repo, observedAt: at(1), commits: [], pulls: [], runs: [], stale: false, ...activity })) });
    const detail = url.match(/\/api\/agents\/(\w)$/);
    if (detail) {
      const agent = workspaceAgents.find((a) => a.id === detail[1]);
      return respond({ agent, pending: [], artifacts: [], messageReceipts: [], turns: [] });
    }
    if (url.endsWith("/api/machines")) return respond({ machines: [] });
    return respond({});
  };
  const doc = w.document;
  // By its words; failing that, an icon-only button by its accessible name
  // (a summary card's Reply, T-18), whose title is a tip now (YN-44). Words
  // first: a fold button's name is its card's title, which an option's
  // words may begin with too.
  const button = (text, root = doc) => {
    const all = [...root.querySelectorAll("button")];
    return all.find((b) => b.textContent.trim().startsWith(text))
      ?? all.find((b) => !b.textContent.trim() && (b.getAttribute("aria-label") ?? "").startsWith(text));
  };
  // A Project's page (YN-86), where its cards are; the whole of Home has the project at a glance.
  const panel = (id) => doc.querySelector(`[data-project-home="${id}"]`);
  const glance = (id) => doc.querySelector(`[data-glance-project="${id}"]`);
  // Anything the page has before the app starts (the tab title, an app badge).
  before?.(w);
  try {
    w.eval(bundle);
    // Home's memory is per workspace: open it once the workspace is read.
    if (holdWorkspace) await waitFor(() => button("Home"), "the toolbar is drawn");
    else await waitFor(() => button("Home") && /Mori/.test(doc.querySelector(".agent-list")?.textContent || ""), "the workspace is read");
    if (pressHome) {
      button("Home").click();
      await waitFor(() => doc.querySelector("[data-glance-project]"), "Home read its projects");
    }
  } catch (error) {
    w.close();
    throw error;
  }
  const page = {
    w, doc, calls, errors, logged, scrolled, state, button, panel, glance, releaseWorkspace,
    setVisibility(value) {
      visibility = value;
      doc.dispatchEvent(new w.Event("visibilitychange"));
    },
    posts: (pattern) => calls.filter((c) => c.method === "POST" && pattern.test(c.url)),
    /** Core's event stream, as the open connection delivers it. */
    event: (value) => streams.at(-1)?.onmessage?.({ data: JSON.stringify(value), lastEventId: "" }),
    close: () => w.close(),
  };
  if (open) {
    try {
      await openProject(page, open);
    } catch (error) {
      w.close();
      throw error;
    }
  }
  return page;
}
async function type(p, element, value) {
  // A reply's field is the conversation's composer (YN-91).
  if (element.matches("[data-composer-input]")) {
    setComposerText(element, value);
    await pause();
    return;
  }
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
/** A Project's page, from its glance on the whole of Home (YN-86): where its cards are. */
async function openProject(p, id) {
  if (p.panel(id)) return p.panel(id);
  if (!p.glance(id)) {
    p.button("Home").click();
    await waitFor(() => p.glance(id), "the whole of Home");
  }
  p.glance(id).querySelector(".project-glance-open").click();
  await waitFor(() => p.panel(id), `${id}'s page`);
  return p.panel(id);
}
/** The whole of Home again, by the toolbar's Home. */
async function wholeHome(p) {
  p.button("Home").click();
  await waitFor(() => p.doc.querySelector(".home-layout [data-glance-project]"), "the whole of Home");
}
const chips = (p, id) => [...p.glance(id).querySelectorAll(".home-chip")].map((c) => c.textContent);
/** A reply's field under `root` (YN-91: the conversation's composer), or null. */
const replyField = (root) => root?.querySelector(".home-text-reply [data-composer-input]") ?? null;
// A report or status is read on its page, opened from its card (T-18, Lead 2270).
async function openReport(p, projectId, key) {
  card(p, projectId, key).querySelector(".home-report-open").click();
  await waitFor(() => p.doc.querySelector(".home-report .report-head h1"), `the report ${key}`);
  return p.doc.querySelector(".home-report");
}
async function closeReport(p) {
  p.doc.querySelector(".home-report .report-back").click();
  await waitFor(() => !p.doc.querySelector(".home-report"), "the report closed");
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("Home replaces Catch up: what needs you answered in place, then each project at a glance in Project Priority; no unread turns are listed (YN-86 §2.1)", async () => {
  const p = await mount();
  try {
    assert.ok(!p.button("Catch up"), "the toolbar has Home, not Catch up");
    assert.equal(p.doc.querySelector(".catchup-nav.selected .toolbar-nav-label").textContent, "Home");
    assert.equal(p.calls.filter((c) => c.url.includes("/api/catchup")).length, 0, "Catch up is never read");
    assert.deepEqual(
      [...p.doc.querySelectorAll("[data-glance-project]")].map((e) => e.dataset.glanceProject),
      ["p-res", "p-app", "p-docs"],
      "projects in Core's order, not the project list's",
    );
    assert.deepEqual(
      [...p.doc.querySelectorAll("[data-needs-you]")].map((e) => e.dataset.needsYou),
      ["ask:p-app:release", "approval:r-1"],
      "needs-you items in Core's order",
    );
    // The whole of Home: Needs you, the projects, then My widgets; no project's deck, no return overview.
    assert.deepEqual(
      [...p.doc.querySelector(".home-layout").children].map((el) => el.className),
      ["home-needs-area", "home-projects", "home-widget-column"],
    );
    assert.ok(!p.doc.querySelector(".home-return-overview, .home-panel"), "no overview or project panel");
    assert.ok(!card(p, "p-app", "notes"), "a report is on its project's page, not here");
    // A project's glance has Core's facts only: no unread finished turns, no extracted answers.
    assert.doesNotMatch(p.doc.querySelector(".home-view").textContent, /unread|final answer/i);
    assert.deepEqual(chips(p, "p-app"), ["1 needs you", "2 new"]);
    assert.deepEqual(chips(p, "p-res"), ["1 needs you"]);
    // In progress as its page groups it: the unread review, and the read report of its topic with it.
    assert.match(p.glance("p-app").querySelector(".project-glance-facts").textContent, /2 cards in progress.*1 Job running/);
    assert.match(p.glance("p-res").querySelector(".project-glance-facts").textContent, /1 error/);
    assert.ok(p.glance("p-docs").classList.contains("is-quiet"), "nothing for the user and nothing at work: one line");
    await waitFor(() => /of 16 cores/.test(p.doc.querySelector(".home-machines").textContent), "cores read as a plural");
    // Each card in Needs you says its project; the approval answers from Home.
    assert.equal(p.doc.querySelector('[data-needs-you="approval:r-1"] .home-needs-from').textContent, "Research · Sora");
    assert.equal(p.doc.querySelector('[data-needs-you="ask:p-app:release"] .home-needs-from').textContent, "App · Mori");
    p.button("Allow once", p.doc.querySelector(".home-needs-you")).click();
    await waitFor(() => p.posts(/\/api\/requests\/r-1\/respond$/).length === 1, "the approval was sent");
    assert.deepEqual(p.posts(/\/respond$/)[0].body, { response: { decision: "accept" } });
    // The project's page has its facts and its cards.
    const app = await openProject(p, "p-app");
    assert.match(app.querySelector(".home-agent-counts").textContent, /1 working.*1 idle.*0 waiting.*0 errors/);
    assert.match(app.textContent, /Mori ended a turn without updating the Brief/);
    // A sub-topic sits under its parent, labelled with its own author.
    const sub = card(p, "p-app", "notes/review");
    assert.ok(sub.closest(".home-topic[data-topic=notes] .home-subs"), "notes/review is merged under notes");
    assert.match(sub.querySelector(".home-owner").textContent, /by Hana/);
    // A stale status is greyed and says how old its data is.
    await openProject(p, "p-res");
    assert.ok(card(p, "p-res", "metrics").classList.contains("is-stale"));
    assert.match(card(p, "p-res", "metrics").textContent, /Data as of/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a quiet project is one line; a glance opens its project's page, a recent card opens it at that card (YN-86 §2.1)", async () => {
  const home = homeFixture();
  const sections = home.projects[0].brief.sections;
  sections.find((s) => s.key === "notes/review").updatedAt = at(1);
  sections.find((s) => s.key === "budget").updatedAt = at(2);
  const p = await mount({ home });
  try {
    const docs = p.glance("p-docs");
    assert.match(docs.textContent, /^Docs.*Quiet · updated .* ago/);
    assert.equal(docs.querySelector(".project-glance-open").getAttribute("aria-label"), "Open Docs's project page");
    const app = p.glance("p-app");
    assert.ok(!app.classList.contains("is-quiet"));
    // No lead wrote a status: the latest report's title says what the project has.
    assert.equal(app.querySelector(".project-glance-line").textContent, "Latest report: Review notes");
    const recent = [...app.querySelectorAll(".project-glance-recent li")];
    assert.deepEqual(recent.map((li) => li.querySelector(".project-glance-card").textContent), ["Review notes", "Which plan?"], "the two cards that changed last");
    assert.ok(recent.every((li) => li.querySelector(".project-glance-new")), "neither read yet");
    // A recent card: its project's page, at that card.
    recent[0].querySelector("button").click();
    await waitFor(() => p.panel("p-app"), "App's page");
    await waitFor(() => card(p, "p-app", "notes/review")?.hasAttribute("data-home-highlight"), "at that card");
    assert.equal(p.w.location.hash, "#/home?w=ws-home&p=p-app");
    await wholeHome(p);
    // A click anywhere on a glance but its controls opens the page too.
    p.glance("p-docs").querySelector("h3").click();
    await waitFor(() => p.panel("p-docs"), "Docs's page");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("Seen sends exactly the versions on screen; one arriving meanwhile stays unseen", async () => {
  const p = await mount();
  try {
    // The open Ask is answered, and marked seen, in Needs you.
    const release = card(p, "p-app", "release");
    assert.ok(release.closest(".home-needs-you"), "in Needs you on the whole of Home");
    assert.equal(release.dataset.sectionVersion, "3");
    assert.ok(release.classList.contains("is-changed"));
    // Core has a newer version, not yet read by this window.
    p.state.home.projects[0].brief.sections[0].version = 4;
    release.querySelector("button.home-seen").click();
    await waitFor(() => p.posts(/\/brief\/seen$/).length === 1, "seen was sent");
    const [mark] = p.posts(/\/brief\/seen$/);
    assert.match(mark.url, /\/api\/projects\/p-app\/brief\/seen$/);
    assert.deepEqual(mark.body, { sections: [{ key: "release", version: 3 }] });
    await waitFor(() => card(p, "p-app", "release").dataset.sectionVersion === "4", "Home read again after Seen");
    assert.ok(card(p, "p-app", "release").classList.contains("is-changed"), "the newer version is still unseen");
    // On its page: what it read is not highlighted, and Seen all sends every version shown.
    const app = await openProject(p, "p-app");
    assert.equal(card(p, "p-app", "notes").classList.contains("is-changed"), false, "a seen version is not highlighted");
    // Core's next read finds nothing waiting in App any more.
    const panel = p.state.home.projects[0];
    panel.unseen = 0;
    for (const s of panel.brief.sections) s.seen = { version: s.version, at: at(0) };
    p.state.home.needsYou = p.state.home.needsYou.filter((item) => item.projectId !== "p-app");
    p.button("Seen all", app).click();
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
    // Its tip says how many (YN-44); no native title.
    assert.deepEqual(await readTip(p.w, p.button("Home")), ["Home", "2 waiting for your response"]);
    // Home's own read is the count: an Ask answered elsewhere leaves it.
    p.state.home.needsYou = p.state.home.needsYou.filter((item) => item.kind !== "ask");
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => count() === "1", "the Ask left Needs you");
    p.button("Sora", (await openProject(p, "p-res")).querySelector(".home-error")).click();
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
    assert.deepEqual(await readTip(p.w, p.button("Home")), ["Home", "3 waiting for your response"]);
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
  const p = await mount({ open: "p-app", home });
  const key = 'yuzuno.home-seen-blocks.v1:["ws-home","p-app","notes",null]';
  // Which blocks changed is said on the report page; the card says only that it did (T-18).
  const marks = async () => {
    assert.equal(card(p, "p-app", "notes").querySelectorAll(".brief-change").length, 0, "no block marks on the card");
    const page = await openReport(p, "p-app", "notes");
    const found = [...page.querySelectorAll(".brief-change")].map((el) => [
      el.dataset.change,
      el.querySelector(":scope > .brief-change-mark").textContent,
      el.textContent.trim().slice(0, 40),
    ]);
    await closeReport(p);
    return found;
  };
  let stored;
  try {
    await waitFor(() => p.w.localStorage.getItem(key), "the seen version's blocks are kept");
    assert.equal(JSON.parse(p.w.localStorage.getItem(key)).version, 2);
    assert.deepEqual(await marks(), [], "nothing is marked at the seen version");
    // Version 3 rewrites the summary and adds a group; the rest is as it was.
    Object.assign(shown, { version: 3, body: notes(v3) });
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => card(p, "p-app", "notes").dataset.sectionVersion === "3", "version 3 is shown");
    assert.ok(card(p, "p-app", "notes").classList.contains("is-changed"));
    assert.equal(card(p, "p-app", "notes").querySelector(".home-changed").textContent, "Updated");
    assert.deepEqual(await marks(), [
      ["updated", "Updated", "UpdatedAll three steps are done."],
      ["new", "New", "NewNextStep three starts tomorrow."],
    ], "the new group is marked once, its own block is not marked again");
    assert.equal(JSON.parse(p.w.localStorage.getItem(key)).version, 2, "an unseen version is not kept as seen");
    const storage = p.w.localStorage;
    stored = Object.fromEntries(Array.from({ length: storage.length }, (_, i) => [storage.key(i), storage.getItem(storage.key(i))]));
    // Marking it seen clears the marks and keeps version 3 as the one to compare with.
    shown.seen = { version: 3, at: at(0) };
    card(p, "p-app", "notes").querySelector("button.home-seen").click();
    await waitFor(() => p.posts(/\/brief\/seen$/).length === 1, "seen was sent");
    await waitFor(() => !card(p, "p-app", "notes").classList.contains("is-changed"), "Home read again after Seen");
    assert.deepEqual(await marks(), []);
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
  const elsewhere = await mount({ open: "p-app", home: later() });
  try {
    assert.equal(card(elsewhere, "p-app", "notes").querySelector(".home-changed").textContent, "Updated");
    assert.equal((await openReport(elsewhere, "p-app", "notes")).querySelectorAll(".brief-change").length, 0);
  } finally {
    elsewhere.close();
  }
  // The same device, opened again later, still compares with version 2.
  const again = await mount({ open: "p-app", storage: stored, home: later() });
  try {
    await waitFor(() => card(again, "p-app", "notes"), "the card");
    const page = await openReport(again, "p-app", "notes");
    await waitFor(() => page.querySelectorAll(".brief-change").length === 2, "the marks come back after a reload");
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
  const first = await mount({ open: "p-app", home: seen });
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
  const p = await mount({ open: "p-app", storage: stored, home: later });
  try {
    // On its page, where its Sources sit beside the body (T-18).
    const shown = await openReport(p, "p-app", "notes");
    assert.deepEqual(
      [...shown.querySelectorAll(".brief-change")].map((el) => [el.dataset.change, el.textContent.trim()]),
      [["updated", "UpdatedSourcesPR #1PR #2"]],
    );
    assert.deepEqual(
      [...shown.querySelectorAll(".result-sources a")].map((a) => a.href),
      ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"],
    );
    await closeReport(p);
    assert.ok(p.panel("p-app"), "and its project's page still shows");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a section that can't be drawn says so in its place on its page, is tried again once per new version, and the rest of the app still works", async () => {
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
  const p = await mount({ open: "p-app", home });
  // Each time the section is drawn and refused, React reports the caught error once.
  const refused = () => p.logged.filter((line) => /ZodError|unrecognized_keys/i.test(line)).length;
  const unreadable = () => p.doc.querySelector(".home-report .result-part-error")?.textContent;
  const reads = () => p.calls.filter((c) => c.url.endsWith("/api/home")).length;
  async function refresh(what) {
    const before = reads();
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => reads() > before, `Home is read again: ${what}`);
    await pause(150);
  }
  try {
    // Home draws summaries, not bodies: every card shows, and none is refused there (T-18).
    assert.ok(card(p, "p-app", "release") && card(p, "p-app", "notes") && card(p, "p-app", "notes/review"));
    assert.equal(refused(), 0);
    // Its page says so in the block's place.
    await openReport(p, "p-app", "notes");
    assert.equal(unreadable(), "This section couldn't be displayed.");
    const first = refused();
    assert.ok(first > 0, "the refusal was caught and reported");
    await closeReport(p);
    // The same section read again is not drawn again.
    await refresh("the same version");
    assert.equal(refused(), first, "an unchanged section is not tried again");
    // A new version is tried once on its page, then stays as it is.
    Object.assign(notes, { version: 3, body: links({ note: "still older" }) });
    await refresh("version 3");
    await waitFor(() => card(p, "p-app", "notes").dataset.sectionVersion === "3", "version 3 is shown");
    await openReport(p, "p-app", "notes");
    assert.equal(unreadable(), "This section couldn't be displayed.");
    const second = refused();
    assert.ok(second > first, "a new version is tried again");
    await refresh("version 3 again");
    assert.equal(refused(), second, "and only once");
    await closeReport(p);
    // A version that can be drawn is drawn.
    Object.assign(notes, { version: 4, body: links({}) });
    await refresh("version 4");
    await waitFor(() => card(p, "p-app", "notes").dataset.sectionVersion === "4", "version 4 is shown");
    const page = await openReport(p, "p-app", "notes");
    await waitFor(() => page.querySelector(".result-sources a")?.textContent === "Spec", "version 4 is drawn");
    assert.equal(unreadable(), undefined);
    await closeReport(p);
    // The conversation and the way back to Home work as before.
    const error = (await openProject(p, "p-res")).querySelector(".home-error");
    p.button("Sora", error).click();
    await waitFor(() => p.doc.querySelector(".conversation-title h1")?.textContent === "Sora", "Sora's conversation is open");
    p.button("Back to Home").click();
    await waitFor(() => p.doc.querySelector(".home-view [data-glance-project]"), "back on Home");
    await openProject(p, "p-app");
    assert.ok(card(p, "p-app", "notes"));
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("replies go to the owner with the chosen option; a retry keeps its client id", async () => {
  const p = await mount({ open: "p-app", failReplies: 1 });
  try {
    const release = card(p, "p-app", "release");
    assert.equal(release.querySelector(".home-reply-target select").value, "a", "the owner is the default recipient");
    // The first send fails; it goes again only as it was, reusing its client id.
    await type(p, replyField(release), "Ship it after the docs fix");
    p.button("Send", release).click();
    await waitFor(() => release.querySelector('[role="alert"]'), "the failure is shown");
    p.button("Retry previous reply", release).click();
    await waitFor(() => p.posts(/\/brief\/reply$/).length === 2, "the reply was retried");
    const [first, retry] = p.posts(/\/brief\/reply$/);
    assert.match(first.url, /\/api\/projects\/p-app\/brief\/reply$/);
    // A reply to an ask names the version answered and the Workspace (T-9).
    assert.deepEqual(Object.keys(first.body).sort(), ["agentId", "askVersion", "clientMessageId", "key", "text", "workspaceId"]);
    assert.deepEqual([first.body.askVersion, first.body.workspaceId], [3, "ws-home"]);
    assert.equal(retry.body.askVersion, first.body.askVersion, "the same version on retry");
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
    await type(p, replyField(reply), "Please tidy the notes");
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
    // Answered in place in Needs you, on the whole of Home (YN-86 §2.1).
    assert.ok(card(p, "p-app", "release").closest(".home-needs-you"));
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

test("an Ask answered in Needs you keeps its answer card where it was until the next visit; Needs you counts what still waits (YN-86 §2.1)", async () => {
  const home = homeFixture();
  // Hana's Ask waits in Needs you too, after Mori's.
  home.needsYou.splice(1, 0, { kind: "ask", projectId: "p-app", agentId: "b", agentName: "Hana", sectionKey: "budget", title: "Which plan?", since: at(20) });
  const p = await mount({ home });
  try {
    const keys = () => [...p.doc.querySelectorAll(".home-needs-you [data-needs-you]")].map((el) => el.dataset.needsYou);
    const count = () => p.doc.querySelector(".home-needs-you h2 .nav-count").textContent;
    assert.deepEqual(keys(), ["ask:p-app:release", "ask:p-app:budget", "approval:r-1"]);
    assert.equal(count(), "3");
    p.button("Ship today", card(p, "p-app", "release")).click();
    await waitFor(() => p.posts(/\/brief\/reply$/).length === 1, "the option was sent");
    // Core has the reply: the Ask is no longer in its Needs you.
    const release = p.state.home.projects[0].brief.sections.find((s) => s.key === "release");
    release.ask = { ...release.ask, state: "replied", repliedAt: at(0), replyText: "Ship today" };
    p.state.home.needsYou = p.state.home.needsYou.filter((item) => item.sectionKey !== "release");
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => count() === "2", "Needs you counts what still waits");
    assert.deepEqual(keys(), ["ask:p-app:release", "ask:p-app:budget", "approval:r-1"], "the answered card stays where it was");
    assert.ok(card(p, "p-app", "release").classList.contains("is-answer"), "as its answer card");
    // The next visit to Home: only what waits.
    await wholeHome(p);
    await waitFor(() => keys().length === 2, "the next visit");
    assert.deepEqual(keys(), ["ask:p-app:budget", "approval:r-1"]);
    assert.deepEqual(p.errors, []);
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

test("YN-3 a replied ask is an answer card: whom it waits for, its title, the reply quoted, who acts next, never New; Reply again and the question and details on it; an owner's later update in place (T-132, the user's D3)", async () => {
  const p = await mount({ open: "p-app", home: repliedFixture() });
  try {
    const budget = card(p, "p-app", "budget");
    assert.ok(budget.classList.contains("is-replied"), "marked replied");
    // The answer card (YN-3, the user's choice D3): a small card on the deck, the rest folded.
    assert.ok(budget.classList.contains("is-answer"), "an answer card");
    assert.equal(budget.dataset.cardSize, "small", "a small card on the deck");
    const kind = budget.querySelector(".home-kind");
    assert.equal(kind.textContent.trim(), "Replied · waiting for Hana");
    assert.ok(kind.classList.contains("is-replied"), "no attention colour once answered");
    assert.equal(budget.querySelector(".home-answer-title h3").textContent, "Which plan?");
    assert.match(budget.querySelector(".home-answer-reply").textContent, /^You\s*Plan B$/, "the reply quoted, as the user's");
    assert.equal(budget.querySelector(".home-answer-next").textContent, "Next: Hana acts on your reply");
    assert.equal(budget.querySelector(".home-answer-update"), null);
    assert.ok(!budget.querySelector(".home-changed"), "answered, it is not New, though never marked seen");
    assert.ok(budget.querySelector(":scope > .home-card-body").hidden, "the rest folded");
    const details = budget.querySelector(".home-answer-details");
    assert.equal(details.textContent.trim(), "Question and details");
    assert.equal(details.getAttribute("aria-expanded"), "false");
    details.click();
    await waitFor(() => !budget.querySelector(":scope > .home-card-body").hidden, "unfolded");
    // Unfolded: the question and details; the reply is on the card's face, not again; no controls, no Defer.
    assert.equal(details.getAttribute("aria-expanded"), "true");
    assert.ok(budget.classList.contains("is-open") && budget.dataset.cardSize === undefined, "opened, it takes its row");
    assert.equal(budget.querySelector(":scope > .home-card-body > .home-question").textContent, "Plan A or B?");
    assert.match(budget.querySelector(":scope > .home-card-body > .home-section-body").textContent, /Which plan\? body/);
    assert.equal(budget.querySelector(".home-ask-replied"), null, "the reply is not drawn twice");
    assert.equal(budget.querySelector(".home-ask-reply"), null);
    assert.equal(p.button("Defer", budget), undefined);
    // Reply again, on the card, brings the controls back.
    p.button("Reply again", budget).click();
    await waitFor(() => p.button("Choose B", budget), "the choice is offered again");
    // Updated by its owner after the reply: Updated, not New, and what the owner says now in place.
    const deploy = card(p, "p-app", "deploy");
    assert.ok(deploy.classList.contains("is-replied") && deploy.classList.contains("is-answer"));
    assert.equal(deploy.querySelector(".home-changed").textContent, "Updated");
    assert.match(deploy.querySelector(".home-answer-reply").textContent, /^You\s*Yes, deploy$/);
    const update = deploy.querySelector(".home-answer-update");
    assert.match(update.querySelector(".home-answer-update-head").textContent, /^Hana updated it .+, after your reply$/);
    assert.match(update.textContent, /Deploy started; waiting for CI/);
    assert.equal(deploy.querySelector(".home-answer-next"), null, "its owner has said what is next");
    assert.ok(deploy.querySelector(":scope > .home-card-body").hidden, "the rest folded");
    // The page's new count is Core's, less the answered Ask its owner has not changed since.
    assert.equal(p.panel("p-app").querySelector(".home-panel-chips .home-chip.is-new").textContent, "1 new");
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

// YN-21, the user's choice: an Ask the user answers from this Home turns into its answer card as soon as Core has
// the reply, whichever way it was answered, Reply again too, keeping its place on the deck; one answered elsewhere
// (another device or tab) keeps its card until the next visit, as before (YN-3).
test("YN-21 an Ask answered here is its answer card as soon as Core has the reply: free text, a choice, a form, Reply again; its owner's update keeps it small; one answered elsewhere keeps its card until the next visit", async () => {
  const home = homeFixture();
  const app = home.projects.find((entry) => entry.project.id === "p-app");
  app.brief.sections.push(section("seed", "ask", "Which seed?", 2, owner("b", "Hana"), {
    ask: { question: "Seed 7 or 11?", state: "open", reply: { freeText: true } },
  }), section("scope", "ask", "Which part first?", 1, owner("a", "Mori"), {
    ask: { question: "Which part ships first?", state: "open", reply: { form: { id: "scope", title: "Which part ships first?",
      fields: [{ id: "part", type: "single", label: "First part", required: false, options: [{ id: "ui", label: "The UI" }, { id: "core", label: "Core" }] }] } } },
  }));
  const live = (key) => app.brief.sections.find((s) => s.key === key);
  const replied = (s, replyText) => {
    s.ask = { ...s.ask, state: "replied", repliedAt: new Date().toISOString(), replyText };
    home.needsYou = home.needsYou.filter((item) => item.sectionKey !== s.key);
  };
  // As Core: a reply marks that version of the ask replied before its receipt comes back (home.rs mark_replied).
  const replyAnswer = (reply) => {
    const s = live(reply.key);
    if (s?.ask && s.version === reply.askVersion) {
      const labels = [...(s.ask.reply.options ?? []), ...Object.values(s.ask.reply.choice ?? {})];
      const label = labels.find((option) => option.id === reply.choice)?.label;
      replied(s, label && reply.text ? `${label}: ${reply.text}` : label ?? reply.text);
    }
    return null;
  };
  const p = await mount({ open: "p-app", home, replyAnswer });
  try {
    const release = () => card(p, "p-app", "release");
    const budget = () => card(p, "p-app", "budget");
    const seed = () => card(p, "p-app", "seed");
    const scope = () => card(p, "p-app", "scope");
    const deck = () => [...p.panel("p-app").querySelectorAll(".home-brief [data-section-key]")].map((el) => el.dataset.sectionKey);
    const order = deck();
    await type(p, replyField(release()), "Ship it after the docs fix");
    p.button("Send", release()).click();
    // Core has it: the answer card at once, as a fresh visit shows it, with nothing held for the card it was.
    await waitFor(() => release().classList.contains("is-answer"), "an answer card as soon as Core has the reply");
    assert.equal(release().dataset.cardSize, "small", "a small card on the deck");
    assert.ok(release().querySelector(":scope > .home-card-body").hidden, "the question and details folded");
    assert.equal(release().style.minHeight, "", "no height held for the card it was");
    assert.equal(release().querySelector(".home-kind").textContent.trim(), "Replied · waiting for Mori");
    assert.match(release().querySelector(".home-answer-reply").textContent, /^You\s*Ship it after the docs fix$/);
    assert.equal(release().querySelector(".home-answer-next").textContent, "Next: Mori acts on your reply");
    assert.ok(p.button("Reply again", release()), "Reply again on its face");
    assert.equal(release().querySelector(".home-answer-details").textContent.trim(), "Question and details");
    assert.ok(p.doc.activeElement === release(), "focus, gone with the reply's controls, is on the card");
    assert.deepEqual(deck(), order, "its place on the deck kept: only its size changed");
    // A choice.
    p.button("Choose B", budget()).click();
    await waitFor(() => budget().classList.contains("is-answer"), "a choice: the answer card as soon as Core has it");
    assert.match(budget().querySelector(".home-answer-reply").textContent, /^You\s*Plan B$/);
    // A form, sent at its defaults (it copies its answers as it sends them).
    p.w.structuredClone = structuredClone;
    scope().querySelector(".clarification footer .primary-button").click();
    await waitFor(() => scope().classList.contains("is-answer"), "a form: the answer card as soon as Core has it");
    assert.equal(p.posts(/\/brief\/reply$/).at(-1).body.form?.formId, "scope", "sent as the form's answers");
    // Its owner updates it after the reply, in this visit: still the answer card, with what the owner says now.
    Object.assign(live("release"), { version: 4, updatedAt: new Date().toISOString(), body: body("Shipping once the docs fix lands.") });
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => release().dataset.sectionVersion === "4", "the owner's update read");
    assert.ok(release().classList.contains("is-answer") && release().dataset.cardSize === "small", "it does not grow back");
    assert.match(release().querySelector(".home-answer-update").textContent, /after your reply.*Shipping once the docs fix lands\./s);
    // Reply again: opened, it takes its row; sent, it closes back to the answer card with the new reply.
    p.button("Reply again", release()).click();
    await waitFor(() => release().querySelector(".home-card-body .home-text-reply [data-composer-input]"), "the reply field, on the card");
    assert.ok(release().classList.contains("is-open"));
    await type(p, release().querySelector(".home-card-body .home-text-reply [data-composer-input]"), "Ship it tomorrow instead");
    p.button("Send", release().querySelector(".home-card-body")).click();
    await waitFor(() => !release().classList.contains("is-open") && /Ship it tomorrow instead$/.test(release().querySelector(".home-answer-reply").textContent),
      "Reply again: closed back to the answer card, the new reply on it");
    assert.ok(release().querySelector(":scope > .home-card-body").hidden);
    assert.equal(p.posts(/\/brief\/reply$/).at(-1).body.askVersion, 4, "the version on screen answered");
    assert.ok(p.doc.activeElement === release(), "focus on the card again");
    // Answered elsewhere: Core reads it replied, and its card stays as it is in this visit.
    replied(live("seed"), "Seed 7");
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => seed().classList.contains("is-replied"), "read as replied");
    assert.ok(!seed().classList.contains("is-answer"), "answered elsewhere: still its card in this visit");
    assert.ok(!seed().querySelector(":scope > .home-card-body").hidden, "nothing folded under the user's hand");
    assert.deepEqual(deck(), order, "no card moved on the deck");
    // The next visit to Home: every answered Ask is an answer card, under its heading.
    p.doc.querySelector('.agent-row[data-agent-id="b"] .agent-select').click();
    await waitFor(() => p.doc.querySelector(".conversation-title h1")?.textContent === "Hana", "away from Home");
    await wholeHome(p);
    await openProject(p, "p-app");
    await waitFor(() => seed()?.classList.contains("is-answer"), "an answer card at the next visit");
    assert.ok(["release", "budget", "scope"].every((key) => card(p, "p-app", key).classList.contains("is-answer")));
    assert.match(seed().querySelector(".home-answer-reply").textContent, /^You\s*Seed 7$/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("YN-28 an answer card its owner then resolves keeps the answer card's height until the reader touches it, so the cards below are not pulled up (T-132)", async () => {
  const home = homeFixture();
  const app = home.projects.find((entry) => entry.project.id === "p-app");
  const live = () => app.brief.sections.find((s) => s.key === "release");
  // As Core: a reply marks that version of the ask replied before its receipt comes back (home.rs mark_replied).
  const replyAnswer = (reply) => {
    const s = live();
    if (s.version === reply.askVersion) {
      s.ask = { ...s.ask, state: "replied", repliedAt: new Date().toISOString(), replyText: reply.text };
      home.needsYou = home.needsYou.filter((item) => item.sectionKey !== "release");
    }
    return null;
  };
  const p = await mount({ open: "p-app", home, replyAnswer });
  // jsdom lays nothing out: the card measures as Chromium drew home-check's (6a), its answer card the taller.
  const measured = p.w.Element.prototype.getBoundingClientRect;
  p.w.Element.prototype.getBoundingClientRect = function () {
    if (this.dataset?.sectionKey !== "release") return measured.call(this);
    const height = this.classList.contains("is-answer") ? 155 : 143;
    return { x: 0, y: 0, top: 0, left: 0, right: 560, bottom: height, width: 560, height, toJSON() {} };
  };
  try {
    const release = () => card(p, "p-app", "release");
    await type(p, replyField(release()), "Ship it after the docs fix");
    p.button("Send", release()).click();
    await waitFor(() => release().classList.contains("is-answer"), "the answer card");
    assert.equal(release().style.minHeight, "", "the user's own reply: no height held for the card it was (YN-21)");
    // Its owner resolves it: Core's next version, read while the user reads Home.
    Object.assign(live(), { version: 4, updatedAt: new Date().toISOString(), body: body("Shipped."), ask: { ...live().ask, state: "resolved" } });
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => release().dataset.sectionVersion === "4", "the resolved version read");
    assert.ok(!release().classList.contains("is-answer"), "resolved, no longer an answer card");
    assert.equal(release().style.minHeight, "155px", "as tall as the answer card it was: nothing below is pulled up");
    // The reader touches it: it takes its own height.
    release().dispatchEvent(new p.w.Event("pointerdown", { bubbles: true }));
    assert.equal(release().style.minHeight, "");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// T-132 with T-127: a replied ask's changed blocks are marked wherever its body shows.
test("a replied ask marks its changed blocks where its body shows: on its answer card, in the folded question and details; the owner's update after the reply on the card's face too (YN-3)", async () => {
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
    const p = await mount({ open: "p-app", home });
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
      // A new version, replied when first shown: an answer card (YN-3, D3), its body folded.
      assert.ok(budget.classList.contains("is-replied") && budget.classList.contains("is-answer"));
      const body = budget.querySelector(":scope > .home-card-body");
      assert.ok(body.hidden, "the question and details folded");
      if (updatedSinceReply) {
        // What its owner says since the reply is on the card's face.
        assert.match(budget.querySelector(".home-answer-update").textContent, /Plan B is under way\./);
      } else {
        // Changed before the reply: nothing new from its owner on the face.
        assert.equal(budget.querySelector(".home-answer-update"), null);
      }
      // Either way, unfolded, the changed block is marked where the body shows.
      budget.querySelector(".home-answer-details").click();
      await waitFor(() => !body.hidden, "unfolded");
      assert.deepEqual(marks(body.querySelector(":scope > .home-section-body")), [["updated", "UpdatedPlan B is under way."]]);
      assert.deepEqual(p.errors, []);
    } finally {
      p.close();
    }
  }
});

test("a reply Core cannot confirm never shows as replied", async () => {
  const p = await mount({ open: "p-app", replyStatus: "uncertain" });
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

test("the Jobs here never read as none while the load is unknown: unknown when it can't be read, then the line (T-18)", async () => {
  let fail = true;
  const p = await mount({ load: () => {
    if (fail) throw new TypeError("Failed to fetch");
    return machineLoad();
  } });
  try {
    const cell = () => p.doc.querySelector(".home-machines .home-machine-jobs");
    await waitFor(() => p.doc.querySelector(".home-machines .home-machines-at.is-error"), "the load can't be read");
    assert.equal(cell().querySelector(".home-note").textContent, "unknown");
    assert.doesNotMatch(cell().textContent, /No Jobs running|\b0 running/);
    fail = false;
    await waitFor(() => cell().querySelector(".home-machine-job-line"), "read again two seconds later", 6);
    assert.equal(cell().querySelector(".home-machine-job-count").textContent, "1 running");
    assert.deepEqual(p.errors, []);
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
    // The Jobs here are one line; each Job's project and Agent are in its tip, its own CPU and memory in Jobs (T-18).
    assert.match((await hoverTip(p.w, machines.querySelector(".home-machine-job-line"))).join("\n"), /cargo test · App · Mori/, "a job names its project and Agent");
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

test("each GPU reads as two bars, use and memory; the Jobs here are one line that opens Jobs at the first (T-18)", async () => {
  const load = () => ({
    ...machineLoad(),
    gpus: [{ name: "RTX 5090", utilPct: 42, memUsedMiB: 8192, memTotalMiB: 32768, attribution: "unknown" }],
    jobs: [...machineLoad().jobs, { id: "job-2", name: "vite build", agentId: "a", agentName: "Mori", projectId: "p-app", cpuPct: 12, memMiB: 256 }],
  });
  const p = await mount({ load });
  try {
    await waitFor(() => p.doc.querySelector(".home-gpus .home-gpu-name")?.textContent === "RTX 5090", "the GPU is read");
    const bars = [...p.doc.querySelectorAll(".home-gpus li .home-meter")];
    assert.deepEqual(bars.map((b) => b.getAttribute("aria-label")), ["GPU use 42%", "GPU memory 8.0 GiB / 32.0 GiB"]);
    assert.deepEqual(bars.map((b) => b.querySelector(".home-meter-gpu").style.width), ["42%", "25%"]);
    // One line however many run, so nothing below moves: how many, the first one's
    // name, every name in its tip; the list is in Jobs, which it opens at the first (Dev 7, T-18).
    const opened = [];
    p.w.addEventListener("yuzuno:open-job", (event) => opened.push(JSON.stringify(event.detail)));
    const row = p.doc.querySelector(".home-machine-jobs button.home-machine-job-line");
    assert.equal(row.querySelector(".home-machine-job-count").textContent, "2 running");
    assert.equal(row.querySelector(".home-machine-job-first").textContent, "cargo test");
    assert.deepEqual(await hoverTip(p.w, row), ["2 running", "cargo test · App · Mori", "vite build · App · Mori"]);
    assert.equal(row.getAttribute("aria-label"), "2 Jobs running on this machine, first cargo test: open in Jobs");
    assert.equal(p.doc.querySelectorAll(".home-machine-jobs li").length, 0, "no list of Jobs on Home");
    row.click();
    assert.deepEqual(opened, [JSON.stringify({ source: "local", jobId: "job-1" })]);
    await waitFor(() => p.doc.querySelector(".jobs-nav.selected"), "the Jobs panel opens");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an Agent error opens its conversation and leads back to Home without reading it", async () => {
  const p = await mount({ open: "p-res" });
  try {
    const error = p.panel("p-res").querySelector(".home-error");
    assert.match(error.textContent, /Sora.*Codex exited unexpectedly/);
    p.button("Sora", error).click();
    await waitFor(() => p.doc.querySelector(".conversation-title h1")?.textContent === "Sora", "Sora's conversation is open");
    assert.equal(p.doc.querySelector(".home-view"), null, "Home gave way to the conversation");
    p.button("Back to Home").click();
    await waitFor(() => p.doc.querySelector(".home-view [data-glance-project]"), "back on Home");
    assert.equal(p.posts(/\/agents\/[^/]+\/review$/).length, 0, "nothing was marked read");
  } finally {
    p.close();
  }
});

test("Reorder moves a project's glance and saves the whole order", async () => {
  const p = await mount();
  try {
    p.button("Reorder").click();
    await pause();
    p.doc.querySelector('[aria-label="Move App up"]').click();
    await waitFor(() => p.posts(/\/api\/home\/order$/).length === 1, "the order was saved");
    assert.deepEqual(p.posts(/\/api\/home\/order$/)[0].body, { projectIds: ["p-app", "p-res", "p-docs"] });
    assert.deepEqual(
      [...p.doc.querySelectorAll("[data-glance-project]")].map((e) => e.dataset.glanceProject),
      ["p-app", "p-res", "p-docs"],
    );
    // The arrow pressed keeps the focus as its project moves (T-19 HM:H7).
    await waitFor(() => p.doc.activeElement?.getAttribute("aria-label") === "Move App up", "focus stays on the arrow");
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
    // On the whole of Home, the Ask is a card in Needs you; the team's card is on the project's page only.
    assert.ok(card(p, 'p-app', 'hidden-parent/question').closest('.home-needs-you'));
    assert.ok(!card(p, 'p-app', 'hidden-parent'));
    const page = await openProject(p, 'p-app');
    const details = page.querySelector('.project-team-written');
    assert.equal(details.open, false);
    assert.ok(card(p, 'p-app', 'hidden-parent').closest('.project-team-written'));
    assert.ok(!card(p, 'p-app', 'hidden-parent/question').closest('.project-team-written'));
    // The page's Asks jump goes to it, the second Ask waiting, without opening the team's cards.
    const asks = page.querySelector('.home-jumps [data-jump="asks"]');
    asks.click();
    await waitFor(() => card(p, 'p-app', 'release').hasAttribute('data-home-highlight'), 'the first Ask');
    asks.click();
    await waitFor(() => card(p, 'p-app', 'hidden-parent/question').hasAttribute('data-home-highlight'), 'Ask under hidden parent is reachable');
    assert.equal(details.open, false);
    assert.equal(p.posts(/brief\/seen$/).length, 0, 'source filtering and navigation do not mark Seen');
    p.button('Seen all', page).click();
    await waitFor(() => p.posts(/brief\/seen$/).length === 1, 'Seen all posted');
    assert.ok(!p.posts(/brief\/seen$/)[0].body.sections.some(section => section.key === 'hidden-parent'));
    details.querySelector('summary').click();
    assert.equal(details.open, true);
    assert.equal(p.posts(/brief\/seen$/).length, 1, 'opening team details adds no Seen write');
  } finally { p.close(); }
});

test("Home is laid out as Needs you, the projects, then My widgets; widgets are organized in a dialog on this device (T-9, YN-86 §2.1)", async () => {
  const p = await mount();
  try {
    const column = p.doc.querySelector('.home-layout > .home-widget-column[aria-label="My widgets"]');
    assert.ok(column, "My widgets in the layout");
    assert.ok(column.querySelector('.home-widget-grid > [data-widget="machines"] .home-machines'), "Machines is a widget in the grid");
    const needs = p.doc.querySelector(".home-layout > .home-needs-area .home-needs-you");
    const project = p.doc.querySelector(".home-layout > .home-projects [data-glance-project]");
    assert.ok(needs, "Needs you has its own area");
    assert.ok(project, "the projects have theirs");
    const follows = (a, b) => !!(a.compareDocumentPosition(b) & p.w.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(follows(needs, project) && follows(project, column), "Needs you, then the projects, then My widgets");
    assert.ok(!column.querySelector(".home-needs-you, [data-glance-project]"), "neither is inside My widgets");
    // A project's page keeps its own inner .home-widgets; the column shares no class with them.
    assert.equal(column.matches(".home-widgets") || !!column.querySelector(".home-widget, .home-widgets"), false);
    assert.equal(column.querySelector(".home-widget-count").textContent, "0 pinned");
    // Manage opens that machine's page of Settings › Machines (YN-8 S3): here the Core host's.
    p.button("Manage", column).click();
    await waitFor(() => p.doc.querySelector('[role="dialog"] #settings-machines-title')?.textContent === "Core host"
      && /The computer that runs your Workspace Core/.test(p.doc.querySelector('[role="dialog"]').textContent), "the Core host's page opens");
    p.doc.querySelector('[role="dialog"]').dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await waitFor(() => !p.doc.querySelector('[role="dialog"]'), "the Machines page closes");
    // Organize: a dialog; hidden, a widget is not drawn and reads nothing; the choice is kept.
    p.button("Organize", column).click();
    await waitFor(() => /Organize Home/.test(p.doc.querySelector('[role="dialog"]')?.textContent || ""), "Organize opens");
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

// T-115: every Home card folds on its own. The project's Repositories are one
// line since T-18, with details instead of a fold.
const repo = { id: 1, fullName: "acme/app", url: "https://github.com/acme/app", syncedAt: at(1), error: null };
const fold = (root) => root.querySelector(".home-fold");
const storageOf = (p) => Object.fromEntries(Array.from({ length: p.w.localStorage.length }, (_, i) => p.w.localStorage.key(i)).map((k) => [k, p.w.localStorage.getItem(k)]));

test("every Home card that holds a body folds on its own and keeps its header; a summary card has none to fold; nothing is seen, answered or read meanwhile (T-115, T-18)", async () => {
  const p = await mount({ linked: [repo] });
  try {
    // On the whole of Home: Needs you, an Ask in it, and Machines.
    const cards = {
      needs: p.doc.querySelector(".home-needs-you"),
      machines: p.doc.querySelector(".home-machines"),
      release: card(p, "p-app", "release"),
    };
    for (const [name, root] of Object.entries(cards)) {
      const button = fold(root);
      assert.ok(button, `${name} has its own fold`);
      assert.equal(button.getAttribute("aria-expanded"), "true", name);
      const body = p.doc.getElementById(button.getAttribute("aria-controls"));
      assert.ok(body && root.contains(body) && !body.hidden, `${name} controls its own body`);
    }
    const machineReads = () => p.calls.filter((c) => c.url.endsWith("/api/machine-load")).length;
    // The Ask first: folding Needs you hides it with the rest.
    for (const name of ["release", "needs", "machines"]) fold(cards[name]).click();
    await pause();
    for (const [name, root] of Object.entries(cards)) {
      assert.equal(fold(root).getAttribute("aria-expanded"), "false", name);
      assert.equal(p.doc.getElementById(fold(root).getAttribute("aria-controls")).hidden, true, `${name}'s body is hidden`);
    }
    // The headers still say what waits; load is not read.
    assert.match(cards.release.querySelector(".home-section-head").textContent, /Ask/);
    assert.match(cards.needs.querySelector("h2").textContent, /Needs you\s*2/);
    const machines = machineReads();
    await pause(2600);
    assert.equal(machineReads(), machines, "a collapsed Machines widget reads no load");
    // On its project's page: a report or status shows its summary, its body on its page, so it has no fold (T-18);
    // the Ask folded in Needs you is the same card, folded here too.
    await openProject(p, "p-app");
    await waitFor(() => p.panel("p-app").querySelector(".home-repos .repo-activity"), "the Repositories block is read");
    for (const key of ["notes", "notes/review"]) assert.equal(fold(card(p, "p-app", key)), null, `${key} is a summary`);
    const review = card(p, "p-app", "notes/review");
    assert.match(review.querySelector(".home-summary-head").textContent, /New/);
    assert.match(review.querySelector(".home-summary-title").textContent, /Review notes/);
    assert.ok(review.querySelector(".home-seen"), "Seen is still offered");
    assert.equal(fold(card(p, "p-app", "release")).getAttribute("aria-expanded"), "false", "the same card, folded on its page");
    assert.deepEqual(p.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/api/collaboration/github_repositories")).map((c) => c.url), [],
      "folding marks nothing seen, answers nothing and approves nothing");
    // Kept for this Workspace, by each card's own identity.
    const stored = storageOf(p);
    p.close();
    const again = await mount({ linked: [repo], storage: stored });
    try {
      assert.equal(fold(card(again, "p-app", "release")).getAttribute("aria-expanded"), "false");
      assert.equal(fold(again.doc.querySelector(".home-machines")).getAttribute("aria-expanded"), "false");
      fold(card(again, "p-app", "release")).click();
      await pause();
      assert.equal(again.doc.getElementById(fold(card(again, "p-app", "release")).getAttribute("aria-controls")).hidden, false, "expanded again");
    } finally {
      again.close();
    }
    const other = await mount({ linked: [repo], storage: stored, workspace: "ws-other" });
    try {
      assert.equal(fold(card(other, "p-app", "release")).getAttribute("aria-expanded"), "true", "another Workspace keeps its own");
    } finally {
      other.close();
    }
  } finally {
    p.close();
  }
});

// T-18: a project's repositories, one line each; YN-8 S7 (the design's
// layout A): under it the open PRs by what they need, the recent commits
// folded, and the links managed in Settings, not on Home.
test("a project's repository: its line, its open PRs grouped by what they need, its commits folded; Manage in Settings opens the project's page; nothing is sent (T-18, YN-8 S7)", async () => {
  const pull = (number, title, extra = {}) => ({ number, title, author: "kumo", url: `https://github.com/acme/app/pull/${number}`, draft: false, ...extra });
  const activity = {
    defaultBranch: "main",
    commits: [{ sha: "c40b8361234567", title: "Merge the cache fix", author: "mori", at: at(2), url: "https://github.com/acme/app/commit/c40b836" }],
    pulls: [
      pull(71, "Home slice 1", { ci: { state: "success" } }),
      pull(72, "Sketch", { draft: true, ci: { state: "failure" } }),
      // Its branch and when it was last updated (YN-8 S7b); #74 is as an older Core answers, without them.
      pull(73, "Cache fix", { ci: { state: "failure" }, branch: "fix/cache", updatedAt: at(4) }),
      pull(74, "Docs"),
    ],
    pullsTotal: 6,
    runs: [
      { id: 9, name: "CI", branch: "feat/home", status: "in_progress", conclusion: null, at: at(1), url: "https://github.com/acme/app/actions/runs/9" },
      { id: 8, name: "CI", branch: "main", status: "completed", conclusion: "success", at: at(3), url: "https://github.com/acme/app/actions/runs/8" },
    ],
  };
  const p = await mount({ open: "p-app", linked: [repo], activity });
  try {
    const repos = () => p.panel("p-app").querySelector(".home-repos");
    await waitFor(() => repos()?.querySelector(".repo-line .repo-line-commit .repo-row"), "the repository's line is read");
    assert.equal(repos().getAttribute("aria-label"), "Repositories");
    assert.equal(fold(repos()), null, "no fold of its own");
    const line = repos().querySelector(".repo-line");
    assert.equal(repos().querySelectorAll(".repo-line").length, 1);
    assert.equal(line.querySelector(".repo-name").textContent, "acme/app");
    assert.equal(line.querySelector(".repo-branch").textContent, "main");
    // The default branch's latest run, not the newer one on a feature branch.
    assert.equal(line.querySelector(".repo-line-run a").getAttribute("href"), "https://github.com/acme/app/actions/runs/8");
    assert.match(line.querySelector(".repo-line-run").textContent, /passed\s*CI/);
    assert.match(line.querySelector(".repo-line-commit").textContent, /c40b836\s*Merge the cache fix/);
    assert.equal(line.querySelector(".repo-line-pulls").textContent, "6 open PRs");
    // The PRs by what they need: failing first, drafts last whatever their checks.
    const groups = [...repos().querySelectorAll(".repo-group")];
    assert.deepEqual(groups.map((g) => g.dataset.group), ["failure", "success", "unknown", "draft"]);
    assert.deepEqual(groups.map((g) => g.querySelector("h5").textContent), ["Needs attention 1", "Checks passed 1", "Checks unknown 1", "Drafts 1"]);
    const row = groups[0].querySelector("a.repo-row");
    assert.equal(row.getAttribute("href"), "https://github.com/acme/app/pull/73");
    assert.match(row.textContent, /#73\s*Cache fix\s*fix\/cache/);
    assert.equal(row.querySelector(".repo-pull-branch").textContent, "fix/cache");
    assert.ok(row.querySelector(".repo-pull-time").textContent.length > 0, "when it was last updated");
    assert.match((await hoverTip(p.w, row))[0], /^#73 Cache fix · kumo · fix\/cache · Checks failed · /, "its author, branch and time in its tip");
    assert.equal(row.querySelector(".repo-pull-ci").getAttribute("aria-label"), "Checks failed");
    const older = groups[2].querySelector(".repo-row");
    assert.equal(older.querySelector(".repo-pull-branch").textContent + older.querySelector(".repo-pull-time").textContent, "", "an older Core's PR: no branch or time, its row still aligned");
    assert.equal(groups[2].querySelector(".repo-pull-ci").getAttribute("aria-label"), "checks unknown");
    assert.equal(repos().querySelector(".repo-activity-lists"), null, "no Commits / PRs / Actions columns");
    // More on GitHub; the commits folded; the runs on GitHub.
    const links = [...repos().querySelectorAll(".repo-footer-links a")].map((a) => [a.textContent.trim(), a.getAttribute("href")]);
    assert.deepEqual(links, [["2 more open on GitHub", "https://github.com/acme/app/pulls"], ["Runs on GitHub", "https://github.com/acme/app/actions"]]);
    const commits = repos().querySelector(".repo-commits-toggle");
    assert.equal(commits.getAttribute("aria-expanded"), "false");
    // Its own id, not the repository's: one repository can be linked to more than one project (#750 R1).
    assert.doesNotMatch(commits.getAttribute("aria-controls"), /^repo-commits-1$/);
    assert.ok(repos().contains(p.doc.getElementById(commits.getAttribute("aria-controls"))), "the toggle controls its own list");
    assert.equal(p.doc.getElementById(commits.getAttribute("aria-controls")).hidden, true);
    commits.click();
    await pause();
    assert.equal(commits.getAttribute("aria-expanded"), "true");
    assert.match(p.doc.getElementById(commits.getAttribute("aria-controls")).textContent, /c40b836\s*Merge the cache fix/);
    // The links are in Settings now: none on Home, and nothing sent.
    assert.equal(repos().querySelector('[aria-label="GitHub repositories"]'), null, "no link form on Home");
    const sent = () => p.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/api/collaboration/github_repositories")).map((c) => c.url);
    assert.deepEqual(sent(), [], "reading and folding send nothing");
    repos().querySelector(".home-repos-manage").click();
    await waitFor(() => p.doc.querySelector('.modal.settings-modal #settings-tab-projects[aria-selected="true"]'), "Settings › Projects opens");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a jump to an Ask in Needs you opens its collapsed card, and Needs you when it is folded (T-115)", async () => {
  const p = await mount();
  try {
    const needs = p.doc.querySelector(".home-needs-you");
    const release = card(p, "p-app", "release");
    const asks = p.doc.querySelector('.home-jumps [data-jump="asks"]');
    fold(release).click();
    await pause();
    assert.equal(fold(release).getAttribute("aria-expanded"), "false");
    asks.click();
    await waitFor(() => release.hasAttribute("data-home-highlight"), "the Ask is highlighted");
    assert.equal(fold(release).getAttribute("aria-expanded"), "true", "the Ask's own card opened");
    assert.ok(p.doc.activeElement === release, "and it has the focus");
    assert.ok(replyField(release), "its reply is in view");
    // Needs you folded: the jump opens it to the Ask.
    fold(needs).click();
    await pause();
    assert.equal(fold(needs).getAttribute("aria-expanded"), "false");
    asks.click();
    await waitFor(() => fold(needs).getAttribute("aria-expanded") === "true", "Needs you opened");
    assert.equal(release.closest(".home-card-body").hidden, false);
    assert.equal(p.posts(/\/brief\/(reply|seen)$|\/respond$/).length, 0, "jumping answers nothing");
  } finally {
    p.close();
  }
});

test("a collapsed Ask keeps what was typed in it, and folding sends nothing (T-115)", async () => {
  const p = await mount({ open: "p-app" });
  try {
    const release = card(p, "p-app", "release");
    const field = replyField(release);
    assert.ok(field, "the Ask has a reply field");
    await type(p, field, "Only after the docs land.");
    fold(release).click();
    await pause();
    assert.equal(p.doc.getElementById(fold(release).getAttribute("aria-controls")).hidden, true);
    assert.equal(release.querySelector(".home-kind").textContent, "Ask", "the header still says it is an Ask");
    fold(release).click();
    await pause();
    assert.equal(composerText(replyField(release)), "Only after the docs land.");
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

test("a summary card says what it is, when its data is from and that nobody keeps it; a body naming no summary shows its opening paragraph and no more (T-173, T-18, YN-3)", async () => {
  const p = await mount({ open: "p-docs", home: readingFixture() });
  try {
    await waitFor(() => card(p, "p-docs", "layout"), "the Docs cards are drawn");
    const overview = card(p, "p-docs", "overview");
    const evidence = card(p, "p-docs", "evidence");
    const layout = card(p, "p-docs", "layout");
    // These bodies name no summary: each card shows how its body opens, as a folded
    // card does (YN-3): the first paragraph of an accent Group or a Markdown, and
    // nothing after it; a body opening with a plain Group gives none.
    const lead = (root) => root.querySelector(".home-summary-lead")?.textContent.trim() ?? null;
    assert.equal(lead(overview), "Release core.15 is out; two lines wait for main.");
    assert.equal(lead(layout), "Daily runs core.12.");
    assert.equal(lead(evidence), null, "a body opening with a plain Group gives no paragraph");
    for (const root of [overview, evidence, layout]) {
      assert.ok(!/No summary named/.test(root.textContent), "never “No summary named”");
      assert.ok(!root.querySelector(".home-card-frame"), "no frame: a card with no summary is small");
      assert.ok(!root.querySelector(".brief-body"), "no block of the body on Home");
    }
    assert.doesNotMatch(overview.textContent, /Details below/);
    // When its data is from, in the foot of a status; a report says when it was updated.
    assert.match(layout.querySelector(".home-summary-foot").textContent, /Data as of/);
    assert.doesNotMatch(overview.querySelector(".home-summary-foot").textContent, /Data as of/);
    // An author who has closed: marked, with why.
    assert.equal(layout.querySelector(".home-unmaintained").textContent, "Not maintained");
    assert.match((await hoverTip(p.w, layout.querySelector(".home-unmaintained"))).join(" "), /Kumo has closed/);
    assert.ok(!overview.querySelector(".home-unmaintained"), "an active author's card is not marked");
    // The title and Open report go to the page; nothing is written by looking.
    assert.equal(layout.querySelector(".home-report-open").textContent, "Open status");
    assert.equal(overview.querySelector(".home-report-open").textContent, "Open report");
    assert.ok(overview.querySelector(".home-summary-title button"), "the title is the link");
    assert.deepEqual(p.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/api/collaboration/github_repositories")).map((c) => c.url), []);
  } finally {
    p.close();
  }
});

test("a section Core repaired is marked on its card, and its page says what Core changed (YN-14)", async () => {
  const home = readingFixture();
  const docs = home.projects.find((entry) => entry.project.id === "p-docs");
  const reason = (n) => `Element "log${n}": the unknown component "Code" became Markdown of its text. (brief_guide content)`;
  docs.brief.sections.find((one) => one.key === "evidence").repairs =
    [1, 2, 3, 4].map((n) => ({ code: "component_to_markdown", path: `body.elements.log${n}`, reason: reason(n) }));
  const p = await mount({ open: "p-docs", home });
  try {
    await waitFor(() => card(p, "p-docs", "evidence"), "the Docs cards are drawn");
    const mark = card(p, "p-docs", "evidence").querySelector(".home-repaired");
    assert.ok(mark, "the repaired card is marked");
    assert.equal(mark.textContent, "Repaired");
    assert.match((await hoverTip(p.w, mark)).join(" "), /Core repaired small slips in what Hana sent/);
    assert.ok(!card(p, "p-docs", "overview").querySelector(".home-repaired"), "a card kept as sent is not marked");
    const page = await openReport(p, "p-docs", "evidence");
    assert.equal(page.querySelector(".report-head .home-repaired").textContent, "Repaired");
    const items = [...page.querySelectorAll(".home-repaired-note li")].map((li) => li.textContent);
    assert.deepEqual(items, [1, 2, 3].map((n) => reason(n).replace(" (brief_guide content)", "")), "the first three, in Core's words");
    assert.match(page.querySelector(".home-repaired-note").textContent, /and 1 more/);
    await closeReport(p);
  } finally {
    p.close();
  }
});

test("a sub-topic without its topic's section stands as its own card; several get a readable heading (T-173)", async () => {
  const p = await mount({ open: "p-docs", home: readingFixture() });
  try {
    await waitFor(() => card(p, "p-docs", "ops/backup"), "the Docs cards are drawn");
    const alone = p.panel("p-docs").querySelector('[data-topic="release-core12"]');
    assert.ok(!alone.querySelector(".home-topic-name"), "no bare key over a single card");
    assert.ok(!alone.querySelector(".home-subs"), "not drawn as a sub-card");
    assert.ok(alone.contains(card(p, "p-docs", "release-core12/notes")));
    const ops = p.panel("p-docs").querySelector('[data-topic="ops"]');
    assert.equal(ops.querySelector(".home-topic-name").textContent, "Ops");
    assert.deepEqual(await hoverTip(p.w, ops.querySelector(".home-topic-name")), ["ops"], "the key stays reachable");
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
    let column = p.doc.querySelector(".home-widget-column");
    const pinned = () => column?.querySelector(".home-pinned");
    const refresh = async (until, what) => {
      p.doc.querySelector('[aria-label="Refresh Home"]').click();
      await waitFor(until, what);
    };
    const layout = () => JSON.parse(p.w.localStorage.getItem("yuzuno.homeWidgets.ws-home"));
    // Asks are answered in Needs you and their project: no pin. Reports and status pin, from their project's page.
    assert.equal(card(p, "p-app", "release").querySelector(".home-pin"), null);
    const needs = [...p.doc.querySelectorAll("[data-needs-you]")].map((e) => e.dataset.needsYou);
    const writes = () => p.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/api/collaboration/github_repositories")).length;
    const before = writes();
    await openProject(p, "p-res");
    assert.ok(card(p, "p-res", "metrics").querySelector(".home-pin"));
    await openProject(p, "p-app");
    assert.equal(card(p, "p-app", "budget").querySelector(".home-pin"), null);
    assert.ok(card(p, "p-app", "old-notes"), "the team content is drawn");
    assert.equal(card(p, "p-app", "old-notes").querySelector(".home-pin"), null, "content kept out of Home's view is not pinned");
    card(p, "p-app", "notes").querySelector('[aria-label="Pin “Notes” to My widgets"]').click();
    await waitFor(() => layout()?.pins?.length === 1, "Notes is pinned");
    assert.equal(card(p, "p-app", "notes").querySelector(".home-pin").getAttribute("aria-pressed"), "true");
    // In My widgets, on the whole of Home.
    await wholeHome(p);
    column = p.doc.querySelector(".home-widget-column");
    await waitFor(() => pinned(), "Notes is in My widgets");
    assert.match(pinned().querySelector(".home-pinned-from").textContent, /^App · Mori · Updated /);
    assert.match(pinned().querySelector(".home-pinned-body").textContent, /Notes body/);
    // Pinning tells Core nothing: no Seen, and nothing needs you twice.
    assert.equal(writes(), before);
    assert.deepEqual([...p.doc.querySelectorAll("[data-needs-you]")].map((e) => e.dataset.needsYou), needs);
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
    // Back to the source: its Project's page opens at it, highlighted (YN-86 §2.4).
    p.button("Open in App", pinned()).click();
    await waitFor(() => p.doc.querySelector('[data-project-home="p-app"]'), "the Project's page opens from the pin");
    await waitFor(() => card(p, "p-app", "notes").hasAttribute("data-home-highlight"), "the source is highlighted");
    assert.equal(p.w.location.hash, "#/home?w=ws-home&p=p-app", "the page is in the address");
    // Back to the whole of Home for the rest of the test; the pin stays as it was.
    p.w.history.back();
    await waitFor(() => p.doc.querySelector(".home-layout") && p.doc.querySelector(".home-widget-column .home-pinned"), "back on Home with the pin");
    column = p.doc.querySelector(".home-widget-column");
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
    await openProject(p, "p-app");
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

test("YN-38 a report card's reply goes to its latest version: the one on screen, and the one Core has when it refused that; no step, one draft (T-174)", async () => {
  // Core refuses any version but the one it has now, as project_brief/home.rs does.
  const p = await mount({ open: "p-app",
    replyAnswer: (body) => {
      const now = p.state.home.projects[0].brief.sections.find((s) => s.key === body.key);
      return now && now.version !== body.version ? changedAnswer(body.title) : null;
    },
  });
  try {
    assert.ok(!p.button("Reply", card(p, "p-app", "release")), "an ask has its own reply controls, no card reply");
    assert.ok(!!p.button("Reply", card(p, "p-app", "notes/review")), "a sub card takes a reply to its own author");
    const notes = card(p, "p-app", "notes");
    p.button("Reply", notes).click();
    await waitFor(() => !!replyBox(notes), "the reply opens under the card");
    assert.match(replyBox(notes).textContent, /Reply to “Notes” · version 2/);
    assert.equal(replyBox(notes).querySelector("select").value, "a", "to its author");
    assert.equal(p.posts(/\/brief\/reply$/).length, 0, "opening sends nothing");
    await type(p, replyField(replyBox(notes)), "Please add the numbers");
    // The author writes version 3 while the user writes: the reply follows it.
    const app = p.state.home.projects[0];
    Object.assign(app.brief.sections[1], { version: 3, title: "Notes, revised" });
    p.event({ type: "workspace.changed", scope: "brief" });
    await waitFor(() => card(p, "p-app", "notes").dataset.sectionVersion === "3", "Home read version 3");
    const box = replyBox(card(p, "p-app", "notes"));
    assert.match(box.textContent, /Reply to “Notes, revised” · version 3/);
    assert.doesNotMatch(box.textContent, /changed this card|still refers|Refer it/);
    assert.equal(p.button("Refer it to version 3", box), undefined, "no step to move it");
    assert.equal(composerText(replyField(box)), "Please add the numbers", "the draft stays");
    p.button("Send", box).click();
    await waitFor(() => /Sent to Mori, referring to version 3/.test(box.textContent), "sent to version 3");
    const [first] = p.posts(/\/brief\/reply$/);
    assert.deepEqual(keys(first.body), ["agentId", "clientMessageId", "key", "text", "title", "version"]);
    assert.deepEqual([first.body.key, first.body.version, first.body.title, first.body.agentId, first.body.text],
      ["notes", 3, "Notes, revised", "a", "Please add the numbers"]);
    assert.match(first.body.clientMessageId, uuid);
    assert.equal(composerText(replyField(box)), "");
    // Core has version 4 before Home reads it: Core refuses version 3, Home
    // reads the card again, and the reply goes to version 4.
    await type(p, replyField(box), "And the units, please");
    Object.assign(app.brief.sections[1], { version: 4, title: "Notes, third pass" });
    const homeReads = p.calls.filter((c) => c.url.endsWith("/api/home")).length;
    p.button("Send", box).click();
    await waitFor(() => /Sent to Mori, referring to version 4/.test(box.textContent), "sent to version 4");
    const [, refusedOne, second] = p.posts(/\/brief\/reply$/).map((c) => c.body);
    assert.deepEqual([refusedOne.version, refusedOne.title], [3, "Notes, revised"]);
    assert.deepEqual([second.version, second.title, second.text], [4, "Notes, third pass", "And the units, please"]);
    assert.notEqual(second.clientMessageId, refusedOne.clientMessageId, "Core never had the refused one: a new message");
    assert.ok(p.calls.filter((c) => c.url.endsWith("/api/home")).length > homeReads, "Home read the card again");
    assert.equal(box.querySelector('[role="alert"]'), null, "no refusal shown");
    assert.equal(p.w.localStorage.getItem("yuzuno.home-outbox.v1"), null);
    assert.equal(p.w.localStorage.getItem("yuzuno.home-card-drafts.v1"), null, "a sent reply leaves no draft");
    assert.equal(p.posts(/\/brief\/(seen|defer)$/).length, 0, "a card reply marks nothing seen and defers nothing");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a card reply keeps its id and version through a lost answer and a reload; an older Core says why, sending nothing else (T-174)", async () => {
  const p = await mount({ open: "p-app", failReplies: 1 });
  let stored;
  try {
    const review = card(p, "p-app", "notes/review");
    p.button("Reply", review).click();
    await waitFor(() => !!replyBox(review), "the reply opens");
    assert.equal(replyBox(review).querySelector("select").value, "b", "a sub card's own author");
    const area = replyField(replyBox(review));
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
  const again = await mount({ open: "p-app", storage: stored });
  try {
    const review = card(again, "p-app", "notes/review");
    await waitFor(() => !!replyBox(review), "the unconfirmed reply opens again after a reload");
    const box = replyBox(review);
    assert.equal(composerText(replyField(box)), "Which branch?");
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
  const older = await mount({ open: "p-res", replyAnswer: () => [422, "Failed to deserialize the JSON body into the target type: unknown field `version`, expected one of `key`, `agentId`, `text`, `clientMessageId`, `choice` at line 1 column 90"] });
  try {
    const metrics = card(older, "p-res", "metrics");
    older.button("Reply", metrics).click();
    await waitFor(() => !!replyBox(metrics), "a status card takes a reply too");
    await type(older, replyField(replyBox(metrics)), "Is this still running?");
    older.button("Send", replyBox(metrics)).click();
    await waitFor(() => !!replyBox(metrics).querySelector('[role="alert"]'), "the older Core's refusal is shown");
    assert.match(replyBox(metrics).querySelector('[role="alert"]').textContent, /can't bind a reply to a card version yet, so nothing was sent/);
    assert.equal(older.posts(/\/brief\/reply$/).length, 1, "never sent again without its reference");
    assert.equal(composerText(replyField(replyBox(metrics))), "Is this still running?");
    assert.equal(older.w.localStorage.getItem("yuzuno.home-outbox.v1"), null);
  } finally {
    older.close();
  }
});

test("an author who left waits for an explicit recipient; a card that leaves Home keeps the draft, sent nowhere (T-174)", async () => {
  const home = homeFixture();
  home.projects[0].brief.sections[1].owner = { agentId: "gone", name: "Kai", state: "closed" };
  const p = await mount({ open: "p-app", home });
  try {
    const notes = card(p, "p-app", "notes");
    p.button("Reply", notes).click();
    await waitFor(() => !!replyBox(notes), "the reply opens");
    const box = replyBox(notes);
    assert.equal(box.querySelector("select").value, "", "no recipient chosen for the user");
    assert.match(box.textContent, /Kai is closed; choose who should get this reply/);
    await type(p, replyField(box), "Who owns this now?");
    assert.equal(p.button("Send", box).disabled, true, "nothing to send to yet");
    await choose(p, box.querySelector("select"), "b");
    assert.equal(p.button("Send", box).disabled, false);
    // The card leaves Home before anything is sent.
    home.projects[0].brief.sections.splice(1, 1);
    p.event({ type: "workspace.changed", scope: "brief" });
    await waitFor(() => !card(p, "p-app", "notes"), "the card is gone");
    const kept = p.panel("p-app").querySelector(".home-kept-reply");
    assert.ok(!!kept, "the draft is kept and explained");
    assert.match(kept.textContent, /Your reply to “Notes” was not sent: that card is no longer on Home/);
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

test("a pinned report takes the same reply as its card: one draft, sent once (T-174)", async () => {
  const home = homeFixture();
  home.projects.forEach((panel, n) => panel.brief.sections.forEach((s, i) => (s.id = 100 * (n + 1) + i)));
  const p = await mount({ open: "p-app", home });
  try {
    card(p, "p-app", "notes").querySelector('[aria-label="Pin “Notes” to My widgets"]').click();
    await waitFor(() => JSON.parse(p.w.localStorage.getItem("yuzuno.homeWidgets.ws-home") ?? "{}").pins?.length === 1, "Notes is pinned");
    const notes = card(p, "p-app", "notes");
    p.button("Reply", notes).click();
    await waitFor(() => !!replyBox(notes), "the card's reply opens");
    assert.match(replyBox(notes).textContent, /Reply to “Notes” · version 2/);
    assert.equal(replyBox(notes).querySelector("select").value, "a", "to the card's author");
    await type(p, replyField(replyBox(notes)), "From the card");
    // In My widgets, on the whole of Home: the same reply, not a second one, open with what was typed.
    await wholeHome(p);
    const pinned = () => p.doc.querySelector(".home-widget-column .home-pinned");
    await waitFor(() => pinned() && replyBox(pinned()), "the widget's reply, open with the draft");
    assert.equal(composerText(replyField(replyBox(pinned()))), "From the card", "one draft in both places");
    await type(p, replyField(replyBox(pinned())), "From the widget");
    p.button("Send", replyBox(pinned())).click();
    await waitFor(() => /Sent to Mori, referring to version 2/.test(replyBox(pinned()).textContent), "the widget shows it sent");
    // Back on the card's page: nothing more is sent.
    await openProject(p, "p-app");
    await pause();
    assert.equal(p.posts(/\/brief\/reply$/).length, 1, "sent once");
    const [post] = p.posts(/\/brief\/reply$/);
    assert.deepEqual([post.body.key, post.body.version, post.body.title, post.body.text], ["notes", 2, "Notes", "From the widget"]);
    assert.equal(p.posts(/\/brief\/(seen|defer)$/).length, 0, "nothing seen or deferred");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a report marked seen takes a reply from History at its version; removed entries, older versions, asks and live keys take none, not even a control that can't send (T-174, YN-38)", async () => {
  const home = homeFixture();
  home.projects[0].brief.history = [
    section("weekly", "report", "Weekly", 3, owner("b", "Hana"), { history: true, historyReason: "seen", currentSource: true, seen: { version: 3, at: at(900) } }),
    section("weekly", "report", "Weekly", 2, owner("b", "Hana"), { history: true, historyReason: "seen", currentSource: true }),
    section("dropped", "report", "Dropped", 1, owner("a", "Mori"), { history: true, historyReason: "removed" }),
    section("notes", "report", "Notes", 1, owner("a", "Mori"), { history: true, historyReason: "seen", currentSource: true }),
    // An ask its owner resolved, and an earlier version of a live ask's key.
    section("launch", "ask", "Launch when?", 2, owner("a", "Mori"), { history: true, historyReason: "resolved",
      ask: { question: "Launch on Monday?", state: "resolved", replyText: "Monday", reply: { options: [{ id: "mon", label: "Monday" }], freeText: true } } }),
    section("release", "ask", "Ship today?", 2, owner("a", "Mori"), { history: true, historyReason: "removed",
      ask: { question: "Ship the release today?", state: "open", reply: { options: [{ id: "ship", label: "Ship today" }], freeText: true } } }),
  ];
  const p = await mount({ open: "p-app", home });
  try {
    const history = p.panel("p-app").querySelector(".home-history");
    history.open = true;
    const entries = [...history.querySelectorAll("li details")];
    for (const entry of entries) {
      entry.open = true;
      entry.dispatchEvent(new p.w.Event("toggle"));
    }
    await waitFor(() => entries.every((entry) => / body/.test(entry.textContent)), "the entries open");
    assert.deepEqual(entries.map((entry) => !!p.button("Reply", entry)), [true, false, false, false, false, false],
      "only each key's newest seen report, while no card under its key is live");
    // No reply control of any kind on an entry that can't take one.
    for (const entry of entries.slice(1))
      assert.equal(entry.querySelector("textarea, select, [data-composer-input], .home-ask-reply, .home-ask-options, .clarification, .home-card-reply"), null, entry.textContent);
    assert.equal(p.button("Ship today", history), undefined, "an earlier version of a live ask offers no option");
    p.button("Reply", entries[0]).click();
    await waitFor(() => !!replyBox(entries[0]), "the reply opens in History");
    assert.match(replyBox(entries[0]).textContent, /Reply to “Weekly” · version 3/);
    assert.equal(replyBox(entries[0]).querySelector("select").value, "b");
    await type(p, replyField(replyBox(entries[0])), "Can this stay weekly?");
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
  const p = await mount({ open: "p-app" });
  try {
    const review = card(p, "p-app", "notes/review");
    p.button("Reply", review).click();
    await waitFor(() => !!replyBox(review), "the reply opens");
    await type(p, replyField(replyBox(review)), "Before I mark it seen");
    // Core keeps a report the user marks seen in History, at that version.
    const app = p.state.home.projects[0].brief;
    const shown = app.sections.find((s) => s.key === "notes/review");
    app.sections = app.sections.filter((s) => s !== shown);
    app.history.unshift({ ...shown, history: true, historyReason: "seen", currentSource: true, seen: { version: 1, at: at(0) } });
    review.querySelector("button.home-seen").click();
    await waitFor(() => !card(p, "p-app", "notes/review"), "the card left for History");
    const kept = p.panel("p-app").querySelector(".home-kept-reply");
    assert.ok(!!kept, "the reply is kept in the project");
    assert.match(kept.textContent, /Your reply to “Review notes” is kept: that card is now in History, marked seen/);
    assert.equal(composerText(replyField(replyBox(kept))), "Before I mark it seen");
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

// T-18 (Lead 2655): a pinned report with a summary is its summary card in
// the widgets. Marked seen, it is History's entry, which a reply can still
// refer to: the reply being written stays, as it does in History.
function pinnedNotes() {
  const home = homeFixture();
  home.projects.forEach((panel, n) => panel.brief.sections.forEach((s, i) => (s.id = 100 * (n + 1) + i)));
  const notes = home.projects[0].brief.sections.find((s) => s.key === "notes");
  Object.assign(notes, { seen: null, body: { root: "body", elements: {
    body: { type: "BriefBody", props: { summary: { lead: "text", size: "wide" } }, children: ["text", "more"] },
    text: { type: "Markdown", props: { text: "Notes body" } },
    // More than its card shows: its page is reached from the card (a whole report has none, PR C2).
    more: { type: "Markdown", props: { text: "Notes the card leaves to the page." } },
  } } });
  return home;
}
async function pinWithReply(p, text) {
  // Pinned from its project's page; the widget is in My widgets, on the whole of Home.
  await openProject(p, "p-app");
  card(p, "p-app", "notes").querySelector('[aria-label="Pin “Notes” to My widgets"]').click();
  await wholeHome(p);
  await waitFor(() => !!p.doc.querySelector(".home-widget-column article[data-pin-widget]"), "Notes is pinned as its card");
  const widget = p.doc.querySelector(".home-widget-column article[data-pin-widget]");
  p.button("Reply", widget).click();
  await waitFor(() => !!replyBox(widget), "the reply opens in the widget");
  await choose(p, replyBox(widget).querySelector("select"), "b");
  await type(p, replyField(replyBox(widget)), text);
  return widget;
}
/** Core's reading once the user marked Notes seen (elsewhere: on another device, or its page). */
function notesSeen(p) {
  const app = p.state.home.projects[0].brief;
  const notes = app.sections.find((s) => s.key === "notes");
  app.sections = app.sections.filter((s) => s !== notes);
  app.history.unshift({ ...notes, history: true, historyReason: "seen", currentSource: true, seen: { version: 2, at: at(0) } });
  p.event({ type: "workspace.changed", scope: "brief" });
}

test("a pinned report marked seen keeps its reply: the same field, text, focus and recipient, sent at its version, Seen left as it is (T-18)", async () => {
  const p = await mount({ home: pinnedNotes() });
  try {
    const widget = await pinWithReply(p, "Before it is seen");
    const box = replyBox(widget), field = replyField(box);
    field.focus();
    assert.equal(p.doc.activeElement === field, true);
    notesSeen(p);
    await waitFor(() => /Marked seen/.test(widget.textContent), "the widget says it is marked seen");
    assert.equal(p.doc.querySelector(".home-widget-column article[data-pin-widget]") === widget, true, "the same widget");
    assert.equal(replyBox(widget) === box && replyField(box) === field, true, "the same reply and field");
    assert.equal(composerText(field), "Before it is seen");
    assert.equal(p.doc.activeElement === field, true, "focus stays in the field");
    assert.equal(box.querySelector("select").value, "b", "the recipient the user chose");
    assert.match(box.textContent, /Reply to “Notes” · version 2/);
    assert.equal(p.button("Reply", widget)?.getAttribute("aria-expanded"), "true", "its Reply stays, open");
    // Its page takes a reply too: the card and the page never disagree.
    widget.querySelector(".home-report-open").click();
    await waitFor(() => p.doc.querySelector(".home-report .report-head h1"), "its report");
    assert.ok(p.button("Reply", p.doc.querySelector(".home-report .report-actions")), "the page offers Reply on the same version");
    await closeReport(p);
    p.button("Send", replyBox(widget)).click();
    await waitFor(() => /Sent to Hana, referring to version 2/.test(replyBox(widget).textContent), "sent");
    const [post] = p.posts(/\/brief\/reply$/);
    assert.deepEqual([post.body.key, post.body.version, post.body.title, post.body.agentId, post.body.text], ["notes", 2, "Notes", "b", "Before it is seen"]);
    assert.equal(p.posts(/\/brief\/(seen|defer)$/).length, 0, "nothing marked seen or deferred");
    assert.match(widget.textContent, /Marked seen/, "still the seen entry");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a pinned report removed, gone from History, or another section under its key takes no reply in its widget; the draft is kept, sent nowhere (T-18)", async () => {
  const removed = (p) => {
    const app = p.state.home.projects[0].brief;
    const notes = app.sections.find((s) => s.key === "notes");
    app.sections = app.sections.filter((s) => s !== notes);
    app.history.unshift({ ...notes, history: true, historyReason: "removed" });
  };
  // Seen, then past History's 30 days: Core no longer has it.
  const expired = (p) => {
    const app = p.state.home.projects[0].brief;
    app.history = app.history.filter((s) => s.key !== "notes");
  };
  const anew = (p) => {
    const app = p.state.home.projects[0].brief;
    const index = app.sections.findIndex((s) => s.key === "notes");
    app.sections[index] = { ...app.sections[index], id: 999, version: 3, title: "Notes, anew", seen: null };
  };
  for (const [how, change, pinState] of [["removed", removed, "removed"], ["expired", expired, "removed"], ["written anew", anew, "replaced"]]) {
    const p = await mount({ home: pinnedNotes() });
    try {
      await pinWithReply(p, `Draft before ${how}`);
      if (how === "expired") {
        notesSeen(p);
        await waitFor(() => /Marked seen/.test(p.doc.querySelector(".home-widget-column article[data-pin-widget]")?.textContent ?? ""), `${how}: seen first`);
        assert.ok(replyBox(p.doc.querySelector(".home-widget-column article[data-pin-widget]")), `${how}: the seen entry keeps the reply`);
      }
      change(p);
      p.event({ type: "workspace.changed", scope: "brief" });
      const column = p.doc.querySelector(".home-widget-column");
      await waitFor(() => column.querySelector(`.home-pinned[data-pin-state="${pinState}"]`), `${how}: the widget says why`);
      assert.equal(column.querySelector(".home-card-reply"), null, `${how}: no reply in the widget`);
      assert.equal(p.button("Reply", column.querySelector(".home-pinned")), undefined, `${how}: no Reply in the widget`);
      if (how !== "written anew") {
        const kept = (await openProject(p, "p-app")).querySelector(".home-kept-reply");
        assert.ok(kept, `${how}: the draft is kept in its project`);
        assert.match(kept.textContent, new RegExp(`Draft before ${how}`));
        assert.equal(p.button("Send", kept), undefined, `${how}: never sent from there`);
      }
      assert.equal(p.posts(/\/brief\/reply$/).length, 0, `${how}: nothing sent`);
      assert.deepEqual(p.errors, []);
    } finally {
      p.close();
    }
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
    body: { type: "BriefBody", props: {}, children: ["files", "more"] },
    files: { type: "Attachments", props: { items: [{ name: "screen.png", caption: "Login screen" }] } },
    // More than its card shows: its page is reached from the card (a whole report has none, PR C2).
    more: { type: "Markdown", props: { text: "Two screens.\n\nThe page says which is which." } },
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
  const p = await mount({ open: "p-app", home: homeImages(), workspaceAgents: codexAgents });
  try {
    const { uploads, reads } = pointFixStubs(p);
    // On the report's page, where its attachments are (T-18).
    await waitFor(() => card(p, "p-app", "shots"), "the card is drawn");
    const shots = await openReport(p, "p-app", "shots");
    await waitFor(() => shots.querySelector("button.brief-image"), "the image is drawn");
    assert.ok(!shots.querySelector(".brief-attachment a"), "no link to a browser tab");
    const preview = () => p.doc.querySelector('[role="dialog"]');
    shots.querySelector("button.brief-image").click();
    await waitFor(preview, "the preview opens");
    // Its caption is the title, its file after (T-20).
    assert.equal(preview().querySelector("h2").textContent, "Login screen");
    assert.match(preview().textContent, /screen\.png · Snapshot/);
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
  const p = await mount({ open: "p-app", home: homeImages(), workspaceAgents: codexAgents });
  try {
    const { uploads } = pointFixStubs(p);
    await waitFor(() => card(p, "p-app", "ghost"), "the card is drawn");
    const ghost = await openReport(p, "p-app", "ghost");
    await waitFor(() => ghost.querySelector("button.brief-image"), "the image is drawn");
    ghost.querySelector("button.brief-attachment-open").click();
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

// T-189: a project's repository card on Home follows the interface
// language, changed in another window; the repository's name stays.
test("Home's repository card follows a language change; the repository stays as named and nothing is read again (T-189)", async () => {
  const activity = { pulls: [{ number: 73, title: "Cache fix", author: "kumo", url: "https://github.com/acme/app/pull/73", draft: false, ci: { state: "failure" } }] };
  const p = await mount({ open: "p-app", linked: [repo], activity });
  try {
    const repos = () => p.panel("p-app").querySelector(".home-repos");
    await waitFor(() => repos()?.querySelector(".repo-group h5"), "the Repositories block is read");
    const reads = () => p.calls.filter((c) => c.url.endsWith("/repo-activity")).length;
    const before = reads();
    p.w.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
    p.w.dispatchEvent(new p.w.StorageEvent("storage", { key: "yuzuno.language" }));
    await waitFor(() => repos().querySelector(".repo-group h5")?.textContent === "需要处理 1", "the card follows the language");
    assert.equal(repos().querySelector(".repo-commits-toggle").textContent.trim(), "最近的提交");
    assert.equal(repos().querySelector(".home-repos-manage").textContent, "在设置中管理");
    assert.equal(repos().querySelector(".repo-name").textContent, "acme/app", "the repository as named");
    assert.equal(reads(), before, "no repo-activity read again");
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
const askField = (p) => replyField(card(p, "p-app", "release")?.querySelector(".home-ask-reply"));

test("an Ask's unsent reply is kept across a reload with its recipient and version; a delivery clears only what it sent (T-182)", async () => {
  let stored;
  const p = await mount({ open: "p-app" });
  try {
    // Begun for the owner, emptied, sent to Hana instead, then written: Hana's.
    await type(p, askField(p), "A first thought for Mori.");
    await type(p, askField(p), "");
    await choose(p, card(p, "p-app", "release").querySelector(".home-reply-target select"), "b");
    await type(p, askField(p), "Only after the docs land.");
    const kept = askDrafts(p)[releaseSlot()];
    assert.deepEqual([kept.key, kept.text, kept.agentId], ["release", "Only after the docs land.", "b"]);
    assert.equal(kept.version, undefined, "bound to no version: it goes to the latest (YN-38)");
    assert.equal(p.w.localStorage.getItem("yuzuno.home-card-drafts.v1"), null, "an Ask's draft is not a card reply's");
    assert.equal(p.posts(/\/brief\/reply$/).length, 0, "writing sends nothing");
    stored = storageOf(p);
  } finally {
    p.close();
  }
  let answer = () => {};
  const held = new Promise((resolve) => (answer = resolve));
  const again = await mount({ open: "p-app", storage: stored, replyAnswer: (body) => (body.key === "release" ? held.then(() => null) : null) });
  try {
    const release = card(again, "p-app", "release");
    assert.equal(composerText(askField(again)), "Only after the docs land.", "the text is back after a reload");
    assert.equal(release.querySelector(".home-reply-target select").value, "b", "and its recipient");
    assert.match(release.textContent, /Kept from before, not sent yet: your reply to this ask\./);
    again.button("Send", release.querySelector(".home-text-reply")).click();
    await waitFor(() => again.posts(/\/brief\/reply$/).length === 1, "the reply is being sent");
    // Written while it is being sent: not what was sent, so it stays.
    await type(again, askField(again), "Only after the docs land. And the changelog.");
    answer();
    await waitFor(() => /Replied · waiting for/.test(card(again, "p-app", "release").textContent), "delivered");
    const [sent] = again.posts(/\/brief\/reply$/);
    // The version on screen and the Workspace, never a card's version or title (T-9).
    assert.deepEqual(keys(sent.body), ["agentId", "askVersion", "clientMessageId", "key", "text", "workspaceId"]);
    assert.deepEqual([sent.body.askVersion, sent.body.workspaceId], [3, "ws-home"]);
    assert.deepEqual([sent.body.key, sent.body.agentId, sent.body.text], ["release", "b", "Only after the docs land."]);
    assert.equal(askDrafts(again)[releaseSlot()].text, "Only after the docs land. And the changelog.");
    assert.match(card(again, "p-app", "release").textContent, /A reply you wrote here is kept, not sent: Reply again to see it\./);
    again.button("Reply again", card(again, "p-app", "release")).click();
    await pause();
    assert.equal(composerText(askField(again)), "Only after the docs land. And the changelog.");
    again.button("Send", card(again, "p-app", "release").querySelector(".home-text-reply")).click();
    await waitFor(() => again.posts(/\/brief\/reply$/).length === 2, "the second reply is sent");
    await waitFor(() => again.w.localStorage.getItem(ASK_DRAFTS) === null, "a delivered reply leaves no draft");
    assert.equal(again.posts(/\/brief\/reply$/)[1].body.text, "Only after the docs land. And the changelog.");
    assert.deepEqual(again.errors, []);
  } finally {
    again.close();
  }
});

test("YN-38 an Ask asked again while the user writes keeps the words and sends them to the latest version: on screen, or Core's when it refused the one on screen (T-182)", async () => {
  // Core refuses any version but the one it has now (project_brief/home.rs).
  const p = await mount({ open: "p-app",
    replyAnswer: (body) => {
      const now = p.state.home.projects[0].brief.sections[0];
      return body.key === "release" && body.askVersion !== now.version
        ? [409, { error: `ask_changed: version ${body.askVersion} of the ask \`release\` can't be answered now: it changed after you began this reply. Nothing was sent, and your reply is kept.`, code: "message_not_submitted" }]
        : null;
    },
  });
  const ask = (version, question) => Object.assign(p.state.home.projects[0].brief.sections[0], { version, ask: { question, state: "open", reply: { freeText: true } } });
  const reask = async (version, question) => {
    ask(version, question);
    p.event({ type: "workspace.changed", scope: "brief" });
    await waitFor(() => card(p, "p-app", "release").dataset.sectionVersion === String(version), `Home read version ${version}`);
  };
  try {
    await type(p, askField(p), "Ship after QA.");
    await reask(4, "Ship the release on Monday?");
    const release = () => card(p, "p-app", "release");
    assert.doesNotMatch(release().textContent, /began this reply on version|Refer it to/);
    assert.equal(composerText(askField(p)), "Ship after QA.", "the text stays");
    const send = () => p.button("Send", release().querySelector(".home-text-reply"));
    assert.equal(send().disabled, false, "no step before it can be sent");
    assert.equal(p.button("Refer it to version 4", release()), undefined);
    send().click();
    await waitFor(() => p.posts(/\/brief\/reply$/).length === 1, "sent");
    assert.deepEqual(keys(p.posts(/\/brief\/reply$/)[0].body), ["agentId", "askVersion", "clientMessageId", "key", "text", "workspaceId"]);
    assert.equal(p.posts(/\/brief\/reply$/)[0].body.askVersion, 4, "to the version on screen");
    await waitFor(() => p.w.localStorage.getItem(ASK_DRAFTS) === null, "no draft after delivery");
    // Begun again; Core has version 5 before Home reads it: refused there,
    // the words go to version 5 as a new message, with nothing to press.
    p.button("Reply again", release()).click();
    await pause();
    await type(p, askField(p), "Monday is fine.");
    ask(5, "Ship the release on Tuesday?");
    send().click();
    await waitFor(() => p.posts(/\/brief\/reply$/).length === 3, "refused once, then sent to version 5");
    const [, refusedOne, sent] = p.posts(/\/brief\/reply$/).map((c) => c.body);
    assert.deepEqual([refusedOne.askVersion, sent.askVersion, sent.text], [4, 5, "Monday is fine."]);
    assert.notEqual(sent.clientMessageId, refusedOne.clientMessageId);
    await waitFor(() => /Replied · waiting for/.test(release().textContent), "shown as answered");
    assert.doesNotMatch(release().textContent, /nothing was sent/i);
    assert.equal(p.w.localStorage.getItem(ASK_DRAFTS), null);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("YN-38 an Ask's form asked again while the user answers: the answers that still fit stay, what changed is said on each field, nothing is picked for the user, and the answers go to the latest version", async () => {
  const home = homeFixture();
  const plan = (version, fields) => section("plan", "ask", "Release plan", version, owner("a", "Mori"), {
    ask: { question: "How should the release go?", state: "open", reply: { form: { id: "release-plan", title: "Release plan", fields } } },
  });
  const day = (options) => ({ id: "day", type: "single", label: "Release day", required: true, options });
  const mon = { id: "mon", label: "Monday" }, tue = { id: "tue", label: "Tuesday" }, fri = { id: "fri", label: "Friday" };
  const notesField = { id: "notes", type: "text", label: "Anything else", required: false };
  home.projects[0].brief.sections.push(plan(1, [day([mon, tue]), notesField]));
  const p = await mount({ open: "p-app", home });
  try {
    // A form copies its answers on submit; jsdom's window lacks it (as above).
    p.w.structuredClone = structuredClone;
    const planCard = () => card(p, "p-app", "plan");
    const radio = (label) => [...planCard().querySelectorAll(".clarification label")].find((l) => l.textContent.includes(label))?.querySelector("input");
    const fieldNotes = (label) => [...[...planCard().querySelectorAll(".clarification-field")].find((f) => f.querySelector("legend").textContent.startsWith(label))
      .querySelectorAll(".clarification-carried p")].map((n) => n.textContent);
    radio("Tuesday").click();
    await pause();
    await type(p, planCard().querySelector(".clarification textarea"), "After the docs land.");
    // Mori asks again: Tuesday is gone, Friday and a required field are new.
    const sections = p.state.home.projects[0].brief.sections;
    sections[sections.length - 1] = plan(2, [day([mon, fri]), notesField, { id: "who", type: "single", label: "Who ships it", required: true, options: [{ id: "mori", label: "Mori" }, { id: "hana", label: "Hana" }] }]);
    p.event({ type: "workspace.changed", scope: "brief" });
    await waitFor(() => planCard().dataset.sectionVersion === "2", "Home read version 2");
    await waitFor(() => fieldNotes("Release day").length > 0, "the form says what changed");
    assert.deepEqual(fieldNotes("Release day"), ["No longer offered: “Tuesday”. Choose again."]);
    assert.deepEqual(fieldNotes("Who ships it"), ["New since you began answering."]);
    assert.deepEqual(fieldNotes("Anything else"), [], "an answer that still fits is kept, unsaid");
    assert.equal(planCard().querySelector(".clarification textarea").value, "After the docs land.");
    assert.ok(!radio("Monday").checked && !radio("Friday").checked, "no day picked for the user");
    assert.match(planCard().textContent, /This ask is now version 2\. Your answers are kept where they still fit/);
    assert.doesNotMatch(planCard().textContent, /Refer it to|began this reply on version/);
    const submit = () => planCard().querySelector(".clarification footer .primary-button");
    assert.equal(submit().disabled, false, "no step before it can be sent");
    submit().click();
    await pause();
    assert.equal(p.posts(/\/brief\/reply$/).length, 0, "not sent while a required answer is missing");
    radio("Friday").click();
    await pause();
    assert.deepEqual(fieldNotes("Release day"), [], "answered again: said no more");
    radio("Hana").click();
    await pause();
    submit().click();
    await waitFor(() => p.posts(/\/brief\/reply$/).length === 1, "sent");
    const [sent] = p.posts(/\/brief\/reply$/).map((c) => c.body);
    assert.equal(sent.askVersion, 2);
    assert.deepEqual(sent.form, { formId: "release-plan", answers: { day: "fri", notes: "After the docs land.", who: "hana" } });
    assert.match(sent.text, /- Release day: Friday\n- Anything else: After the docs land\.\n- Who ships it: Hana/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an Ask's draft belongs to its Workspace, shows once the Workspace is read, and says so when this browser won't keep it (T-182)", async () => {
  // The Ask is in Needs you, on the whole of Home (YN-86 §2.1).
  const draft = (text, agentId = "a") => JSON.stringify({ key: "release", text, version: 3, agentId, at: new Date().toISOString() });
  const other = await mount({ storage: { [ASK_DRAFTS]: JSON.stringify({ [releaseSlot("ws-other")]: JSON.parse(draft("For the other Workspace.")) }) } });
  try {
    assert.equal(composerText(askField(other)), "", "another Workspace's draft is not shown here");
  } finally {
    other.close();
  }
  const late = await mount({ holdWorkspace: true, storage: { [ASK_DRAFTS]: JSON.stringify({ [releaseSlot()]: JSON.parse(draft("Kept for this Workspace.", "b")) }) } });
  try {
    assert.equal(composerText(askField(late)), "", "nothing is shown before the Workspace is known");
    late.releaseWorkspace();
    // Home reads itself again for the Workspace now known, and its cards are
    // not drawn until that read lands: not there yet is "not yet", not an error.
    await waitFor(() => card(late, "p-app", "release")?.querySelector(".home-ask-reply [data-composer-input]") && composerText(card(late, "p-app", "release").querySelector(".home-ask-reply [data-composer-input]")) === "Kept for this Workspace.",
      "its own draft shows once it is read");
    assert.match(card(late, "p-app", "release").textContent, /Kept from before, not sent yet: your reply to this ask\./);
    assert.equal(card(late, "p-app", "release").querySelector(".home-reply-target select").value, "b", "with the recipient the user chose, not the owner");
  } finally {
    late.close();
  }
  // Kept for an Agent no longer in the project: the user chooses again; nothing goes elsewhere.
  const gone = await mount({ storage: { [ASK_DRAFTS]: JSON.stringify({ [releaseSlot()]: JSON.parse(draft("For an Agent who left.", "gone")) }) } });
  try {
    const release = card(gone, "p-app", "release");
    assert.equal(composerText(askField(gone)), "For an Agent who left.");
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
    assert.equal(composerText(askField(refused)), "Kept only here.");
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
    assert.equal((await hoverTip(p.w, option("Low density")))[0], "Spacious: each card’s main point");
    assert.equal((await hoverTip(p.w, option("High density")))[0], "Compact: every field and row");
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
  const p = await mount({ open: "p-res" });
  try {
    assert.equal(p.doc.querySelector(".home-view").dataset.density, "low");
    p.button("Sora", p.panel("p-res").querySelector(".home-error")).click();
    await waitFor(() => p.doc.querySelector(".conversation-title h1")?.textContent === "Sora", "Sora's conversation is open");
    assert.ok(!p.doc.querySelector(".home-view"), "Home is closed");
    // Another window of this device chooses high density for this Workspace.
    p.w.localStorage.setItem("yuzuno.homeDensity.ws-home", '"high"');
    p.w.dispatchEvent(new p.w.StorageEvent("storage", { key: "yuzuno.homeDensity.ws-home" }));
    p.button("Back to Home").click();
    await waitFor(() => p.doc.querySelector(".home-view [data-glance-project]"), "back on Home");
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

// T-9: a report copies as Markdown written from its stored body. A synthetic
// report with every kind of part, folded on the page.
const copyReport = () => {
  const runs = Array.from({ length: 30 }, (_, i) => ({ id: `r${i + 1}`, cells: { run: `r${i + 1}`, result: i === 1 ? "slow\nbut ok" : i === 2 ? "R&amp;D ok" : "ok" }, ...(i === 0 ? { sourceIds: ["s1"] } : {}) }));
  const steps = ["Read the spec", "Write the copy", "Test it", "Review", "Fix", "Merge", "Release", "Check"].map((text, i) => ({ id: `p${i}`, text, state: i < 2 ? "done" : i === 2 ? "doing" : "todo" }));
  return section("research", "report", "Research notes", 3, owner("a", "Mori"), {
    body: {
      root: "body",
      elements: {
        body: { type: "BriefBody", props: {}, children: ["summary", "plan", "evidence", "refs", "files", "sources"] },
        summary: { type: "Group", props: { title: "Where it stands", tone: "accent" }, children: ["text", "metrics"] },
        text: { type: "Markdown", props: { text: "The **retry** fix holds.\n\n- one\n- two" } },
        metrics: { type: "Metrics", props: { items: [{ label: "Pass rate", value: 0.93, unit: "%", previous: 0.91, detail: "last 3 runs" }] } },
        plan: { type: "Plan", props: { title: "Steps", steps } },
        evidence: { type: "Columns", props: {}, children: ["left", "right"] },
        left: { type: "Group", props: {}, children: ["table"] },
        right: { type: "Group", props: {}, children: ["chart"] },
        table: { type: "Table", props: { id: "runs", title: "Runs", columns: [{ key: "run", label: "Run" }, { key: "result", label: "Result | note" }], rows: runs } },
        chart: { type: "LineChart", props: { id: "loss", title: "Loss", x: { label: "Step" }, y: { label: "Loss", unit: "nats" }, series: [{ name: "train", points: [[0, 2.5], [1, 1.9], [2, 1.2]] }] } },
        refs: { type: "LiveRefs", props: { layout: "list", items: [{ kind: "task", id: "T-9", note: "copy slice" }, { kind: "pr", id: "acme/app#12" }] } },
        files: { type: "Attachments", props: { items: [{ name: "shot.png", caption: "Desktop view" }, { name: "spec", caption: "Spec" }] } },
        sources: { type: "Sources", props: { items: [{ id: "s1", label: "Run log", href: "https://example.test/run/1" }, { id: "s2", label: "Notes file", href: "/w/app/notes.md" },
          { id: "s3", label: "Raw [v2] notes", href: "https://example.test/a)b?x=(1)" }, { id: "s4", label: "R&amp;D query", href: "https://example.test/?q=&amp;x=1" }] } },
      },
    },
    attachments: [
      { name: "shot.png", kind: "image", mime: "image/png", size: 1200, snapshot: true, mayChange: false, takenAt: at(5), caption: "Desktop view" },
      { name: "spec", kind: "link", mime: "text/html", size: 0, snapshot: false, mayChange: true, takenAt: at(5), url: "https://example.test/spec" },
    ],
    // Core couldn't read the pull request this time: not the same as missing.
    // The task is named by the key it has now (T-56), not the T-9 written.
    refs: { "task:T-9": { kind: "task", id: "T-9", found: true, title: "Home", state: "doing", key: "APP-9" },
      "pr:acme/app#12": { kind: "pr", id: "acme/app#12", found: false, unavailable: true } },
  });
};
const copiedReport = [
  "# Research notes",
  "## Where it stands",
  "The **retry** fix holds.\n\n- one\n- two",
  "- **Pass rate**: 0.93 % (previously 0.91 %) — last 3 runs",
  "## Steps",
  ["Read the spec — Done", "Write the copy — Done", "Test it — Doing", "Review — To do", "Fix — To do", "Merge — To do", "Release — To do", "Check — To do"].map((line, i) => `${i + 1}. ${line}`).join("\n"),
  "## Runs",
  ["| Run | Result \\| note | Sources |", "| --- | --- | --- |",
    // "&amp;" written in a cell stays those five characters once rendered.
    ...Array.from({ length: 30 }, (_, i) => `| r${i + 1} | ${i === 1 ? "slow but ok" : i === 2 ? "R\\&amp;D ok" : "ok"} | ${i === 0 ? "Run log" : ""} |`)].join("\n"),
  "## Loss",
  "Chart · x: Step · y: Loss (nats)\n- train: 3 points; x 0–2; y 1.2–2.5; last 1.2",
  "## References",
  "- Task APP-9: Home · doing — copy slice\n- Pull request acme/app\\#12: couldn't read",
  "- Image: shot.png — Desktop view (kept with Home card research, version 3)\n- Link: [Spec](<https://example.test/spec>)",
  "## Sources",
  // A link keeps its whole address, parentheses included, and its label's brackets.
  "- [Run log](<https://example.test/run/1>)\n- Notes file: /w/app/notes.md\n- [Raw \\[v2\\] notes](<https://example.test/a)b?x=(1)>)" +
    "\n- [R\\&amp;D query](<https://example.test/?q=&amp;amp;x=1>)",
].join("\n\n") + "\n";
const withReport = () => {
  const home = homeFixture();
  home.projects[0].brief.sections.push(copyReport());
  return home;
};
const clipboard = (p, write) => Object.defineProperty(p.w.navigator, "clipboard", { configurable: true, value: write === null ? undefined : { writeText: write } });

test("T-9 a report copies in one click as Markdown from its body: folded parts, every row and step, charts, images and sources; no controls", async () => {
  const p = await mount({ open: "p-app", home: withReport() });
  try {
    await waitFor(() => card(p, "p-app", "research"), "the report");
    const report = card(p, "p-app", "research");
    // The card shows its summary only; the copy, from More actions, still has every part (T-18).
    await openMore(p, report);
    const copied = [];
    clipboard(p, async (text) => { copied.push(text); });
    p.button("Copy report", report).click();
    // Written within the click itself, as Safari requires.
    assert.equal(copied.length, 1, "the clipboard write starts in the click");
    await waitFor(() => p.button("Copied", report), "said copied");
    assert.equal(copied[0], copiedReport);
    assert.doesNotMatch(copied[0], /Copy report|Show all|Show \d+ more|Reply|Pin|Mark seen|\/api\/|token/i, "no control words or request addresses");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("T-9 a refused or missing clipboard is said as such, never as copied; only reports offer the copy", async () => {
  const p = await mount({ open: "p-app", home: withReport() });
  try {
    await waitFor(() => card(p, "p-app", "research"), "the report");
    const report = card(p, "p-app", "research");
    clipboard(p, async () => { throw new p.w.DOMException("Write permission denied.", "NotAllowedError"); });
    p.button("Copy report", report).click();
    await waitFor(() => p.button("Copy unavailable", report), "the refusal said");
    assert.deepEqual(await hoverTip(p.w, p.button("Copy unavailable", report)), ["Clipboard unavailable. Select the text to copy."]);
    assert.equal(p.button("Copied", report), undefined);
    await waitFor(() => p.button("Copy report", report), "ready again", 4);
    clipboard(p, null);
    p.button("Copy report", report).click();
    await waitFor(() => p.button("Copy unavailable", report), "no clipboard said");
    // An Ask and a status card have no copy.
    assert.equal(p.button("Copy report", card(p, "p-app", "release")), undefined, "not on an Ask");
    assert.ok(p.button("Copy report", card(p, "p-app", "notes")), "on another report");
    await openProject(p, "p-res");
    assert.equal(p.button("Copy report", card(p, "p-res", "metrics")), undefined, "not on a status");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// T-9: a report with a research desk (Dev 2's synthetic dose study) copies
// Core's numbers read for the version on screen, written within the click.
const pointerIn = (document, at) => at.split("/").slice(1).reduce((value, step) => (value && typeof value === "object" ? value[step] : undefined), document);
/** Core's research read for the dose study's desk at `version`, as Core answers it. */
const deskRead = (version) => {
  const desk = doseStudy.body.elements.desk.props;
  const values = {};
  for (const plot of desk.plots)
    for (const row of plot.rows)
      for (const owner of [row, ...(row.parts ?? [])])
        for (const field of ["value", "low", "high"]) {
          const number = owner.estimate[field];
          if (!number || typeof number === "number") continue;
          values[`${owner.id}.${field}`] = { status: "read", value: pointerIn(fixtureFiles[number.from], number.pointer), from: number.from };
        }
  const sources = Object.fromEntries(desk.sources.filter((source) => source.snapshot)
    .map((source) => [source.id, { attachment: source.snapshot, takenAt: "2026-10-31T08:00:00Z", size: 100, sha256: "a".repeat(64), available: true }]));
  return { key: "dose-study", version, elementId: "desk", values, sources };
};
const withDesk = () => {
  const home = homeFixture();
  home.projects[0].brief.sections.push(section("dose-study", "report", doseStudy.title, 4, owner("a", "Mori"), {
    body: doseStudy.body,
    attachments: ["results.json", "protocol.md", "paper.tex"].map((name) => ({ name, kind: name.endsWith(".json") ? "data" : "text", mime: "text/plain", size: 100, snapshot: true, mayChange: false, takenAt: at(5) })),
  }));
  return home;
};
// A summary card's Copy report is under More actions (T-18).
async function openMore(p, report) {
  report.querySelector(".home-summary-more > button").click();
  await waitFor(() => !report.querySelector(".home-summary-more-list").hidden, "More actions open");
}

test("T-9 a report's research desk copies Core's numbers for the version shown, through a write that starts in the click", async () => {
  const reads = [];
  const p = await mount({ open: "p-app", home: withDesk(), research: (url) => { reads.push(url); return { body: deskRead(4) }; } });
  try {
    await waitFor(() => card(p, "p-app", "dose-study"), "the desk report");
    const report = card(p, "p-app", "dose-study");
    await openMore(p, report);
    // As Safari needs it: a ClipboardItem whose text is still loading, written in the click.
    const items = [];
    p.w.ClipboardItem = class { constructor(parts) { this.parts = parts; } };
    Object.defineProperty(p.w.navigator, "clipboard", { configurable: true, value: {
      write: async (list) => { items.push(...list); }, writeText: async () => { throw new Error("writeText would wait for the read"); } } });
    const before = reads.length;
    p.button("Copy report", report).click();
    assert.equal(items.length, 1, "the clipboard write starts in the click");
    const text = await (await items[0].parts["text/plain"]).text();
    await waitFor(() => p.button("Copied", report), "said copied");
    const copyReads = reads.slice(before);
    assert.ok(copyReads.length >= 1 && copyReads.every((url) => url.endsWith("/api/projects/p-app/brief/research/dose-study/desk?version=4")), JSON.stringify(copyReads));
    assert.match(text, /^# Dose study \(synthetic\)\n/);
    assert.match(text, /Does the higher dose shorten recovery\?|High dose shortens recovery/);
    // The high dose's difference is read from the snapshot (-2.04), and says so; v1's -2.6 is the Agent's own.
    assert.match(text, /-2\.04/);
    assert.match(text, /snapshot results\.json/);
    assert.match(text, /-2\.60?\b/);
    assert.doesNotMatch(text, /not read/, "every snapshot number was read");
    // The whole desk, folded on the page: claims, both plots, sources, definitions and next steps.
    for (const part of ["Claims", "May say", "May not say", "Recovery time vs placebo (v2)", "Analysis output", "Definitions", "Next steps"])
      assert.ok(text.includes(part), `the copy has ${part}`);
    assert.doesNotMatch(text, /\/api\/|token|Copy report|Loading/i);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("T-9 a research desk whose numbers Core can't give for that version copies them as not read, in the UI language", async () => {
  let answer = { status: 500, body: { error: "snapshot unreadable" } };
  const p = await mount({ open: "p-app", home: withDesk(), storage: { "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) }, research: () => answer });
  try {
    await waitFor(() => card(p, "p-app", "dose-study"), "the desk report");
    const report = card(p, "p-app", "dose-study");
    await openMore(p, report);
    const copied = [];
    Object.defineProperty(p.w.navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { copied.push(value); } } });
    const copy = async () => {
      const count = copied.length;
      p.button("复制报告", report).click();
      await waitFor(() => copied.length > count && p.button("已复制", report), "copied");
      await waitFor(() => p.button("复制报告", report), "ready again", 4);
      return copied.at(-1);
    };
    // Core failed to read: the copy still goes out, its snapshot numbers not read.
    const failed = await copy();
    assert.match(failed, /^# Dose study \(synthetic\)\n/);
    assert.match(failed, /主张/);
    assert.match(failed, /未读取/);
    assert.doesNotMatch(failed, /-2\.04/, "no number Core didn't read");
    assert.match(failed, /-2\.60?\b/, "the Agent's own numbers stay");
    // An answer for another version (the section has moved on) is not this report's.
    answer = { body: deskRead(5) };
    const other = await copy();
    assert.match(other, /未读取/);
    assert.doesNotMatch(other, /-2\.04/, "a newer version's number is never copied into this one");
    // The version shown, read: the numbers come with their snapshot.
    answer = { body: deskRead(4) };
    const read = await copy();
    assert.match(read, /-2\.04/);
    assert.match(read, /快照 results\.json/);
    for (const part of ["主张", "可以说", "不能说", "Recovery time vs placebo (v2)", "Analysis output", "分析定义", "候选下一步"])
      assert.ok(read.includes(part), `the copy has ${part}`);
    assert.doesNotMatch(read, /未读取/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// Every field the page shows as written, each with characters Markdown would
// read as emphasis, code, a link, markup, a list, a table pipe or a
// heading's closing "#".
const plainFields = {
  title: "**Title** _x_", group: "~~old~~ `code`", check: "**required**", dash: "- not a list", numbered: "1. not a list",
  step: "~~enabled~~ <unknown>", source: "a_b_c", finding: "<unknown> **bold** `tick` [x](y)",
  metric: "*rate*", value: "5|6", unit: "<u>", previous: "~~4~~", detail: "`d`",
  column: "[col](x)", cell: "**a**", slash: "back\\slash", entity: "R&amp;D", dollars: "$5 and $6", tableTitle: "Release #",
  refLabel: "**ref**", note: "<b>n</b>", caption: "~~cap~~", loose: "- loose", path: "/w/_draft_/data.csv",
  sourceLabel: "**src**", sourceDash: "- src", sourcePath: "/w/_wip_/notes.md",
  chart: "_chart_", axis: "x*y", series: "`s`", first: "1. first", alpha: "**alpha**", beta: "`beta`",
};
const plainReport = () => {
  const f = plainFields;
  return section("plain", "report", f.title, 2, owner("a", "Mori"), {
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["group", "md", "math"] },
      group: { type: "Group", props: { title: f.group }, children: ["checks", "plan", "findings", "metrics", "table", "refs", "files", "sources", "chart", "bars"] },
      checks: { type: "Checklist", props: { items: [{ id: "a", text: f.check, done: true }, { id: "b", text: f.dash, done: false }, { id: "c", text: f.numbered, done: false }] } },
      plan: { type: "Plan", props: { steps: [{ id: "p", text: f.step, state: "doing" }] } },
      findings: { type: "Findings", props: { items: [{ id: "f", source: f.source, severity: "high", text: f.finding }] } },
      metrics: { type: "Metrics", props: { items: [{ label: f.metric, value: f.value, unit: f.unit, previous: f.previous, detail: f.detail }] } },
      table: { type: "Table", props: { id: "t", title: f.tableTitle, columns: [{ key: "k", label: f.column }], rows: [f.cell, f.slash, f.entity, f.dollars].map((k, i) => ({ id: `r${i}`, cells: { k } })) } },
      refs: { type: "LiveRefs", props: { items: [{ kind: "task", id: "T-1", label: f.refLabel, note: f.note }] } },
      files: { type: "Attachments", props: { items: [{ name: "kept.png", caption: f.caption }, { name: f.loose }, { name: "data.csv" }] } },
      sources: { type: "Sources", props: { items: [{ id: "s", label: f.sourceLabel, href: "https://example.test/s" }, { id: "p", label: f.sourceDash, href: f.sourcePath }] } },
      chart: { type: "LineChart", props: { id: "c", title: f.chart, x: { label: f.axis }, y: { label: "y" }, series: [{ name: f.series, points: [[0, 1], [1, 2]] }] } },
      bars: { type: "BarChart", props: { id: "b", title: "Bars", x: { label: "kind" }, y: { label: "n" }, series: [{ name: f.first, points: [[f.alpha, 1], [f.beta, 2]] }] } },
      md: { type: "Markdown", props: { text: "A **bold** word and `code`." } },
      math: { type: "Math", props: { tex: "x^2 + y_1", display: false } },
    } },
    attachments: [{ name: "kept.png", kind: "image", mime: "image/png", size: 10, snapshot: true, mayChange: false, takenAt: at(5) },
      { name: "data.csv", kind: "file", mime: "text/csv", size: 10, snapshot: false, mayChange: true, takenAt: at(5), path: f.path }],
    refs: { "task:T-1": { kind: "task", id: "T-1", found: true, title: "Task one", state: "doing" } },
  });
};

test("T-9 a report's plain fields read back as written once the copy is rendered; a Markdown block keeps its formatting", async () => {
  const home = homeFixture();
  home.projects[0].brief.sections.push(plainReport());
  let p = await mount({ open: "p-app", home });
  const copied = [];
  try {
    await waitFor(() => card(p, "p-app", "plain"), "the report");
    clipboard(p, async (text) => { copied.push(text); });
    p.button("Copy report", card(p, "p-app", "plain")).click();
    await waitFor(() => copied.length === 1, "copied");
    assert.ok(copied[0].includes("$x^2 + y_1$"), "Math stays its TeX");
  } finally {
    p.close();
  }
  // The copy, pasted as a Markdown block, rendered by Home's own Markdown.
  const pasted = homeFixture();
  pasted.projects[0].brief.sections.push(section("pasted", "report", "Pasted", 1, owner("a", "Mori"), { body: body(copied[0]) }));
  p = await mount({ open: "p-app", home: pasted });
  try {
    // Read on the report's page, where its body is drawn (T-18).
    await waitFor(() => card(p, "p-app", "pasted"), "the pasted report");
    const page = await openReport(p, "p-app", "pasted");
    await waitFor(() => page.querySelector(".brief-markdown"), "the pasted copy");
    const rendered = page.querySelector(".brief-markdown");
    const visible = rendered.textContent.replace(/\s+/g, " ");
    const lost = Object.entries(plainFields).filter(([, text]) => !visible.includes(text)).map(([field]) => field);
    assert.deepEqual(lost, [], `every plain field reads back as its characters; lost: ${lost.join(", ")}`);
    assert.ok([...rendered.querySelectorAll("strong")].some((el) => el.textContent === "bold"), "the Markdown block's bold");
    assert.ok([...rendered.querySelectorAll("code")].some((el) => el.textContent === "code"), "the Markdown block's code");
    assert.equal(rendered.querySelectorAll("del, a[href='y']").length, 0, "no strike or link made from a plain field");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// Markdown blocks as Home shows each one on its own: indented code keeps its
// indentation, and a fence or raw HTML block a block leaves open ends with
// it, not taking in the parts after. Closed fences, short and long, stay as
// they are. Each case is its own report, copied on its own.
const mdBlock = (text) => ({ type: "Markdown", props: { text } });
/** A block whose full, collapsed and shortcut links use its own [s], titled. */
const refBlock = (text, href) => mdBlock(`Full [${text}][s], collapsed [s][], shortcut [s].\n\n[s]: ${href} "Title ${text}"`);
const anchorsOf = (el) => [...el.querySelectorAll("a")].map((a) => `${a.textContent} ${a.getAttribute("href")} ${a.getAttribute("title")}`);
const linksOf = (text, href) => [`${text} ${href} Title ${text}`, `s ${href} Title ${text}`, `s ${href} Title ${text}`];
const plainRef = (el) => [...el.querySelectorAll("p")].some((p) => p.textContent === "Undefined [s] stays text." && !p.querySelector("a"));
const cellTable = (text) => ({ type: "Table", props: { id: text.replace(/\W+/g, "-"), columns: [{ key: "k", label: "Key" }], rows: [{ id: "r", cells: { k: text } }] } });
const markdownCases = {
  closed: { long: mdBlock("````\n```\nnot a closer\n````"), afterLong: mdBlock("after the long fence"), short: mdBlock("```\nclosed\n```"),
    afterShort: mdBlock("after the short fence; `inline` code") },
  indented: { checks: { type: "Checklist", props: { items: [{ id: "c", text: "ship it", done: false }] } }, code: mdBlock("    const x = 1;\n    const y = 2;"), after: cellTable("after indented") },
  // A fence written inside indented code is code, not a fence to close.
  indentedFence: { code: mdBlock("    ```\n    not a fence"), after: cellTable("after indented fence") },
  backticks: { open: mdBlock("Setup:\n\n```js\nlet open = true;"), plan: { type: "Plan", props: { steps: [{ id: "p", text: "plan step after the fence", state: "todo" }] } } },
  tildes: { open: mdBlock("~~~~\ncode with ``` inside\n~~~\nstill code"), after: cellTable("after tildes") },
  longOpen: { open: mdBlock("````md\n```\nan example fence\n```"), after: cellTable("after long open") },
  // A fence open inside a list item ends with the list; nothing is added.
  listFence: { open: mdBlock("- item\n\n  ```\n  code in a list"), after: cellTable("after list fence") },
  pre: { open: mdBlock("<pre>\nraw block"), after: cellTable("after pre") },
  // Raw HTML cut off mid-tag, a tag name with nothing after it, and an
  // unclosed <div>: each ends with its block on the page.
  preAttr: { open: mdBlock('<pre title="\nraw in attribute'), after: cellTable("after pre attr") },
  textarea: { open: mdBlock("<textarea"), plan: { type: "Plan", props: { steps: [{ id: "p", text: "plan step after textarea", state: "todo" }] } } },
  div: { open: mdBlock("<div>\nboxed text"), after: cellTable("after div") },
  lists: { zero: mdBlock("1. zero"), one: mdBlock("1. one") },
  // Each block's link references are its own, as on the page: the same label
  // defined in two blocks, in either order, and one block using it undefined.
  refs: { a: refBlock("one", "https://a.test/"), b: refBlock("two", "https://b.test/"), plain: mdBlock("Undefined [s] stays text.") },
  refsSwapped: { plain: mdBlock("Undefined [s] stays text."), b: refBlock("two", "https://b.test/"), a: refBlock("one", "https://a.test/") },
};
/** What the page itself shows for each raw HTML case's Markdown block. */
const pageShows = { preAttr: "", textarea: "<textarea", div: "boxed text" };
const markdownCase = (name) => section(`md-${name}`, "report", `Case ${name}`, 1, owner("a", "Mori"), {
  body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: Object.keys(markdownCases[name]) }, ...markdownCases[name] } },
});
/** What the pasted copy of each case must show, as the page shows it. */
const markdownChecks = {
  closed: (el, code) => code.length === 2 && code[0] === "```\nnot a closer\n" && code[1] === "closed\n"
    && ["after the long fence", "after the short fence; inline code"].every((text) => [...el.querySelectorAll("p")].some((p) => p.textContent === text))
    && [...el.querySelectorAll("p > code")].some((c) => c.textContent === "inline"),
  indented: (el, code, pres) => code.includes("const x = 1;\nconst y = 2;\n") && pres.every((pre) => !pre.closest("li"))
    && [...el.querySelectorAll("td")].some((td) => td.textContent === "after indented"),
  backticks: (el, code) => code.length === 1 && code[0] === "let open = true;\n"
    && [...el.querySelectorAll("ol > li")].some((li) => li.textContent.includes("plan step after the fence")),
  indentedFence: (el, code) => code.length === 1 && code[0] === "```\nnot a fence\n"
    && [...el.querySelectorAll("td")].some((td) => td.textContent === "after indented fence"),
  tildes: (el, code) => code.length === 1 && code[0] === "code with ``` inside\n~~~\nstill code\n"
    && [...el.querySelectorAll("td")].some((td) => td.textContent === "after tildes"),
  longOpen: (el, code) => code.length === 1 && code[0] === "```\nan example fence\n```\n"
    && [...el.querySelectorAll("td")].some((td) => td.textContent === "after long open"),
  listFence: (el, code, pres) => code.length === 1 && code[0] === "code in a list\n" && !!pres[0].closest("li")
    && [...el.querySelectorAll("td")].some((td) => td.textContent === "after list fence"),
  pre: (el, code) => code.length === 1 && code[0].trim() === "raw block" && [...el.querySelectorAll("td")].some((td) => td.textContent === "after pre"),
  preAttr: (el, code) => code.length === 0 && !el.textContent.includes("raw in attribute")
    && [...el.querySelectorAll("td")].some((td) => td.textContent === "after pre attr"),
  textarea: (el) => !el.querySelector("textarea") && [...el.querySelectorAll("p")].some((p) => p.textContent === "<textarea")
    && [...el.querySelectorAll("ol > li")].some((li) => li.textContent.includes("plan step after textarea")),
  div: (el) => [...el.querySelectorAll("div")].some((div) => div.textContent.trim() === "boxed text")
    && [...el.querySelectorAll("td")].some((td) => td.textContent === "after div" && td.closest("div") === el),
  refs: (el) => plainRef(el) && JSON.stringify(anchorsOf(el)) === JSON.stringify([...linksOf("one", "https://a.test/"), ...linksOf("two", "https://b.test/")]),
  refsSwapped: (el) => plainRef(el) && JSON.stringify(anchorsOf(el)) === JSON.stringify([...linksOf("two", "https://b.test/"), ...linksOf("one", "https://a.test/")]),
  // Two lists, each numbered from 1 as on the page.
  lists: (el) => [...el.querySelectorAll("ol")].length === 2 && [...el.querySelectorAll("ol")].every((ol) => !ol.hasAttribute("start") && ol.children.length === 1),
};

test("T-9 a report's Markdown blocks copy as Home shows each: indented code, and a fence or raw HTML block left open ends with its block", async () => {
  const names = Object.keys(markdownCases);
  const home = homeFixture();
  home.projects[0].brief.sections.push(...names.map(markdownCase));
  let p = await mount({ open: "p-app", home });
  const copies = {};
  try {
    await waitFor(() => names.every((name) => card(p, "p-app", `md-${name}`)), "the reports");
    for (const [name, text] of Object.entries(pageShows)) {
      const page = await openReport(p, "p-app", `md-${name}`);
      assert.equal(page.querySelector(".brief-markdown").textContent.trim(), text, `the page shows ${name} as written`);
      await closeReport(p);
    }
    for (const name of names) {
      const copied = [];
      clipboard(p, async (text) => { copied.push(text); });
      p.button("Copy report", card(p, "p-app", `md-${name}`)).click();
      await waitFor(() => copied.length === 1, `copied ${name}`);
      copies[name] = copied[0];
    }
  } finally {
    p.close();
  }
  // Each copy pasted as its own Markdown block, rendered by Home's own Markdown.
  const pasted = homeFixture();
  pasted.projects[0].brief.sections.push(section("pasted", "report", "Pasted", 1, owner("a", "Mori"), {
    body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: names }, ...Object.fromEntries(names.map((name) => [name, mdBlock(copies[name])])) } },
  }));
  p = await mount({ open: "p-app", home: pasted });
  try {
    await waitFor(() => card(p, "p-app", "pasted"), "the pasted report");
    const page = await openReport(p, "p-app", "pasted");
    await waitFor(() => page.querySelectorAll(".brief-markdown").length === names.length, "the pasted copies");
    const rendered = [...page.querySelectorAll(".brief-markdown")];
    const failed = names.filter((name, i) => {
      const pres = [...rendered[i].querySelectorAll("pre")];
      return !markdownChecks[name](rendered[i], pres.map((pre) => pre.textContent), pres);
    });
    assert.deepEqual(failed, [], `every case reads back as the page shows it; failed: ${failed.join(", ")}`);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("T-9 a fence a Markdown block leaves open before a research desk ends with its block: the desk's claims, numbers and sources copy outside code", async () => {
  const home = withDesk();
  const report = home.projects[0].brief.sections.at(-1);
  report.body = { root: "body", elements: { ...doseStudy.body.elements,
    body: { type: "BriefBody", props: {}, children: ["intro", "desk"] }, intro: mdBlock("Raw notes:\n\n```text\nraw log line") } };
  const reads = [];
  let p = await mount({ open: "p-app", home, research: (url) => { reads.push(url); return { body: deskRead(4) }; } });
  let copied;
  try {
    await waitFor(() => card(p, "p-app", "dose-study"), "the desk report");
    const texts = [];
    clipboard(p, async (text) => { texts.push(text); });
    const before = reads.length;
    p.button("Copy report", card(p, "p-app", "dose-study")).click();
    await waitFor(() => texts.length === 1, "copied");
    copied = texts[0];
    const copyReads = reads.slice(before);
    assert.ok(copyReads.length >= 1 && copyReads.every((url) => url.endsWith("/api/projects/p-app/brief/research/dose-study/desk?version=4")), JSON.stringify(copyReads));
  } finally {
    p.close();
  }
  const pasted = homeFixture();
  pasted.projects[0].brief.sections.push(section("pasted", "report", "Pasted", 1, owner("a", "Mori"), { body: body(copied) }));
  p = await mount({ open: "p-app", home: pasted });
  try {
    // Read on the report's page, where its body is drawn (T-18).
    await waitFor(() => card(p, "p-app", "pasted"), "the pasted report");
    const page = await openReport(p, "p-app", "pasted");
    await waitFor(() => page.querySelector(".brief-markdown"), "the pasted copy");
    const rendered = page.querySelector(".brief-markdown");
    const code = [...rendered.querySelectorAll("pre")].map((pre) => pre.textContent);
    assert.deepEqual(code, ["raw log line\n"], "only the notes' own line is code");
    const headings = [...rendered.querySelectorAll("h4")].map((h) => h.textContent);
    for (const part of ["Claims", "Sources"]) assert.ok(headings.includes(part), `the desk's ${part} outside code; got ${JSON.stringify(headings)}`);
    const cells = [...rendered.querySelectorAll("td")].map((td) => td.textContent);
    assert.ok(cells.includes("-2.04") && cells.includes("snapshot results.json"), `the read number in the desk's table; got ${JSON.stringify(cells)}`);
    assert.ok([...rendered.querySelectorAll("li")].some((li) => li.textContent.startsWith("Analysis output")), "the desk's source as a list item");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("T-9 a copied research desk keeps each row's and part's own source and definition, read for the version shown", async () => {
  const home = withDesk();
  const report = home.projects[0].brief.sections.at(-1);
  report.body = structuredClone(doseStudy.body);
  const high = report.body.elements.desk.props.plots[0].rows.find((row) => row.id === "high-v2");
  high.parts[0].estimate.cite = { source: "protocol", lines: "50-52" };
  high.parts[0].estimate.definition = { id: "recovery", version: 1 };
  const reads = [];
  let p = await mount({ open: "p-app", home, research: (url) => { reads.push(url); return { body: deskRead(4) }; } });
  let copied;
  try {
    await waitFor(() => card(p, "p-app", "dose-study"), "the desk report");
    const texts = [];
    clipboard(p, async (text) => { texts.push(text); });
    p.button("Copy report", card(p, "p-app", "dose-study")).click();
    await waitFor(() => texts.length === 1, "copied");
    copied = texts[0];
    assert.ok(reads.length >= 1 && reads.every((url) => url.endsWith("/api/projects/p-app/brief/research/dose-study/desk?version=4")), JSON.stringify(reads));
  } finally {
    p.close();
  }
  const pasted = homeFixture();
  pasted.projects[0].brief.sections.push(section("pasted", "report", "Pasted", 1, owner("a", "Mori"), { body: body(copied) }));
  p = await mount({ open: "p-app", home: pasted });
  try {
    await waitFor(() => card(p, "p-app", "pasted"), "the pasted report");
    const page = await openReport(p, "p-app", "pasted");
    await waitFor(() => page.querySelector(".brief-markdown table"), "the pasted copy");
    // The first table is the current plot's.
    const table = page.querySelector(".brief-markdown table");
    const basisOf = (label) => [...table.querySelectorAll("tr")].find((tr) => tr.cells[0]?.textContent === label)?.cells[4]?.textContent;
    assert.equal(table.rows[0].cells[4]?.textContent, "Source · definition");
    assert.equal(basisOf("High dose"), "Analysis output · Recovery v2", "the row's own");
    assert.equal(basisOf("High dose · High dose"), "Protocol, lines 50-52 · Recovery v1", "the part's own, not its row's");
    assert.equal(basisOf("High dose · Placebo"), "no source of its own · no definition of its own", "a part naming none takes none from its row");
    assert.equal(table.querySelectorAll("a").length, 0);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// T-42: who needs the user. Core says how each Agent's last Turn ended; what
// this device has seen of it is kept here only.
const ended = (seq, outcome = "finished") => ({ lastTurnEnd: { seq, outcome, at: at(4) } });
const attentionAgents = () => [
  // Mori's last Turn failed, Hana's finished, neither shown here yet.
  { ...agents[0], ...ended(30, "failed"), status: "error" },
  { ...agents[1], ...ended(20) },
  // Sora: a request and a question sent to be answered later.
  { ...agents[2], pendingCount: 2, openQuestions: 1 },
];
const attentionHome = () => {
  const home = homeFixture();
  home.needsYou.push({ kind: "question", projectId: "p-res", agentId: "c", agentName: "Sora", turnId: "t3", itemId: "q1", title: "Which seed?", since: at(5) });
  return home;
};
// The window opens on Sora, whose last Turn hasn't ended: nothing is seen before the test looks.
const startOnSora = { "yuzuno.selected.ws-home": JSON.stringify("c") };
const railIds = (p) => [...p.doc.querySelectorAll(".agent-list .agent-row")].map((row) => row.dataset.agentId);
// The status words the row has for it, on its island (T-43 v4-2).
const railLabel = (p, id) => p.doc.querySelector(`.agent-row[data-agent-id="${id}"] .agent-island`)?.getAttribute("data-status") ?? null;
const shown = (p) => p.doc.querySelector(".conversation-title h1")?.textContent ?? null;

test("Needs you lists an open question and opens its conversation; a Turn that ended unseen is not listed there, only marked on the Agent list, and stays this device's (YN-3)", async () => {
  const p = await mount({ workspaceAgents: attentionAgents(), home: attentionHome(), storage: startOnSora });
  try {
    await waitFor(() => p.doc.querySelector('[data-needs-you="question:c:t3:q1"]'), "the question is listed");
    // Only what waits for the user's decision: Mori's failed and Hana's finished Turns,
    // neither shown here yet, are their Agents' to follow, not the user's (YN-3).
    const needs = p.doc.querySelector(".home-needs-you");
    assert.equal(needs.querySelectorAll("[data-unseen]").length, 0, "no Turn end in Needs you");
    assert.doesNotMatch(needs.textContent, /Finished, not seen/);
    // Mori's Ask and Sora's request as cards, answered here; Sora's question a row, answered in its conversation.
    const items = needs.querySelectorAll("[data-needs-you]").length;
    assert.equal(items, 3, "each something Core says waits on the user");
    assert.equal(needs.querySelectorAll(".home-needs-list > li").length, 1, "only the question is a row");
    assert.equal(needs.querySelector("h2 .nav-count").textContent, String(items), "its count is what it lists");
    // The rail marks them, in the list's order: Appearance chose none.
    assert.deepEqual(railIds(p), ["a", "b", "c"]);
    assert.equal(railLabel(p, "a"), "Failed · unseen");
    assert.equal(railLabel(p, "b"), "Finished · unseen");
    p.doc.querySelector('[data-needs-you="question:c:t3:q1"]').click();
    await waitFor(() => shown(p) === "Sora", "the question opens Sora's conversation");
    // Shown here, from the Agent list, Hana's Turn end is seen on this device, and only here.
    p.doc.querySelector('.agent-row[data-agent-id="b"] .agent-select').click();
    await waitFor(() => shown(p) === "Hana", "Hana's conversation");
    await waitFor(() => p.w.localStorage.getItem("yuzuno.turnSeen.ws-home") === '{"b":20}', "seen on this device");
    await waitFor(() => railLabel(p, "b") === "Ready", "Hana's label");
    assert.equal(railLabel(p, "a"), "Failed · unseen");
    p.button("Home").click();
    await waitFor(() => p.doc.querySelector('[data-needs-you="question:c:t3:q1"]'), "Home again");
    assert.equal(p.doc.querySelectorAll(".home-needs-you [data-unseen]").length, 0, "still none in Needs you");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("the rail in attention order once Appearance chooses it: the same Agents, who needs you first, within each project group", async () => {
  const one = await mount({ workspaceAgents: attentionAgents(), storage: { ...startOnSora, "yuzuno.appearance": JSON.stringify({ agentOrder: "attention", projectGroups: "none" }) } });
  try {
    assert.deepEqual(railIds(one), ["c", "a", "b"], "waiting on you, failed unseen, finished unseen");
  } finally {
    one.close();
  }
  const listed = await mount({ workspaceAgents: attentionAgents(), storage: { ...startOnSora, "yuzuno.appearance": JSON.stringify({ projectGroups: "none" }) } });
  try {
    assert.deepEqual(railIds(listed), ["a", "b", "c"], "by default the list keeps its order");
  } finally {
    listed.close();
  }
  // Grouped by project: each group ordered, the groups as the project menu has them.
  const grouped = [{ ...agents[0], ...ended(30) }, { ...agents[1], pendingCount: 1 }, agents[2]];
  const groups = await mount({ workspaceAgents: grouped, storage: { ...startOnSora, "yuzuno.appearance": JSON.stringify({ agentOrder: "attention" }) } });
  try {
    assert.deepEqual(railIds(groups), ["b", "a", "c"]);
  } finally {
    groups.close();
  }
});

test("a Turn end read past on any device is not unseen on a new one; one that ended after the last read still is (review 9392d7c2)", async () => {
  // Nothing in this browser's storage. Mori's failed Turn was read through
  // elsewhere (reviewedSeq 30); Hana's ended after her last read (12).
  const workspaceAgents = [
    { ...agents[0], ...ended(30, "failed"), status: "error", reviewedSeq: 30 },
    { ...agents[1], ...ended(20) },
    { ...agents[2], pendingCount: 2, openQuestions: 1 },
  ];
  const p = await mount({ workspaceAgents, home: attentionHome(),
    storage: { ...startOnSora, "yuzuno.appearance": JSON.stringify({ agentOrder: "attention", projectGroups: "none" }) } });
  try {
    await waitFor(() => railLabel(p, "b") === "Finished · unseen", "Hana's Turn end is marked");
    assert.notEqual(railLabel(p, "a"), "Failed · unseen");
    assert.deepEqual(railIds(p), ["c", "b", "a"], "Mori's read end no longer moves Mori up");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("the tab title and the app badge count what Home's tab counts; next needs you goes through Needs you and round again, never to a Turn end unseen (YN-3)", async () => {
  const badges = [];
  const p = await mount({
    workspaceAgents: attentionAgents(),
    home: attentionHome(),
    storage: startOnSora,
    before: (w) => {
      w.document.title = "Yuzuno · test";
      w.navigator.setAppBadge = async (count) => badges.push(count);
      w.navigator.clearAppBadge = async () => badges.push(0);
    },
  });
  const press = () => p.w.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "j", ctrlKey: true, bubbles: true }));
  try {
    // Sora's request and question, and Mori's Ask.
    await waitFor(() => p.doc.title === "(3) Yuzuno · test", `the title counts: ${p.doc.title}`);
    assert.equal(badges.at(-1), 3);
    const button = p.doc.querySelector(".next-needs-you");
    // Its name and shortcut are on it; no tip repeats them (YN-44).
    assert.equal(button.hasAttribute("title"), false);
    assert.match(button.textContent, /^Next needs youCtrl J$/);
    // Home is open: the first is Mori's Ask, there.
    press();
    await waitFor(() => p.scrolled.some((el) => el.id === "home-section-p-app-release"), "the Ask is shown on Home");
    assert.ok(p.doc.querySelector(".home-view"), "still Home");
    press();
    await waitFor(() => shown(p) === "Sora", "then Sora, whose request and question wait");
    // Mori's failed and Hana's finished Turns, not seen here, are not in the round.
    button.click();
    await waitFor(() => p.doc.querySelector(".home-view"), "and round again to the Ask");
    assert.equal(p.w.localStorage.getItem("yuzuno.turnSeen.ws-home"), null, "neither Mori's nor Hana's conversation was shown");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("the tab title, the app badge and Home's count are Needs you's rows, an executor the user dispatched among them (YN-3)", async () => {
  const badges = [];
  const home = attentionHome();
  home.needsYou.push({ kind: "executor", projectId: "p-app", agentId: "b", agentName: "Hana", state: "delivering", taskId: "T-7", title: "Release notes", since: at(2) });
  const p = await mount({
    workspaceAgents: attentionAgents(),
    home,
    storage: startOnSora,
    before: (w) => {
      w.document.title = "Yuzuno · test";
      w.navigator.setAppBadge = async (count) => badges.push(count);
      w.navigator.clearAppBadge = async () => badges.push(0);
    },
  });
  try {
    await waitFor(() => p.doc.querySelector('[data-needs-you="executor:b:delivering"]'), "Hana's result waits for its release");
    // Mori's Ask, Sora's request and question, Hana's result: four in Needs you, four counted.
    await waitFor(() => p.doc.title === "(4) Yuzuno · test", `the title counts every row: ${p.doc.title}`);
    const listed = p.doc.querySelectorAll(".home-needs-you [data-needs-you]").length;
    assert.equal(listed, 4, "four listed, no Turn end among them");
    assert.equal(p.doc.querySelectorAll(".home-needs-you .home-needs-list > li").length, 2, "the question and the result as rows; the Ask and the request as cards");
    assert.equal(badges.at(-1), 4);
    assert.equal(p.doc.querySelector(".catchup-nav .nav-count").textContent, "4", "the Home tab's count");
    assert.equal(p.doc.querySelector(".home-needs-you h2 .nav-count").textContent, "4", "Needs you's own count");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("the desktop app's taskbar button gets the same count, once per change, its words in the language shown (YN-43)", async () => {
  const sent = [];
  const p = await mount({
    workspaceAgents: attentionAgents(),
    home: attentionHome(),
    storage: startOnSora,
    before: (w) => {
      w.document.title = "Yuzuno · test";
      // The desktop window's command bridge; its other commands (appearance,
      // updates, notifications) are not this test's concern.
      w.__TAURI_INTERNALS__ = {};
      w.__TAURI__ = { core: { invoke: async (command, args) => {
        // A copy made here: the page's own object has the page's prototypes.
        if (command === "desktop_badge") sent.push({ ...args });
        return null;
      } } };
    },
  });
  const key = (s) => `${s.count} ${s.lang}`;
  try {
    await waitFor(() => p.doc.title === "(3) Yuzuno · test", `the title counts: ${p.doc.title}`);
    await waitFor(() => sent.at(-1)?.count === 3, "the taskbar gets Home's count");
    assert.deepEqual(sent.at(-1), { count: 3, lang: "en" });
    const settled = sent.length;
    // Another conversation and Home again: rendered anew, the count still 3, nothing sent.
    p.doc.querySelector('.agent-row[data-agent-id="b"] .agent-select').click();
    await waitFor(() => shown(p) === "Hana", "Hana's conversation");
    p.button("Home").click();
    await waitFor(() => p.doc.querySelector(".home-view"), "Home again");
    assert.equal(sent.length, settled, "nothing more while the count is the same");
    // The language shown changes: the same count again, for its words.
    p.w.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
    p.w.dispatchEvent(new p.w.StorageEvent("storage", { key: "yuzuno.language" }));
    await waitFor(() => sent.at(-1)?.lang === "zh", "the words follow the language");
    assert.deepEqual(sent.slice(settled), [{ count: 3, lang: "zh" }]);
    // Every send was a change from the one before.
    sent.forEach((s, i) => assert.notEqual(i && key(sent[i - 1]), key(s), `send ${i} repeats the one before`));
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an executor you dispatched says in Needs you why it waits: why its start failed, what blocks its task (T-43 S4a)", async () => {
  const home = attentionHome();
  home.needsYou.push({ kind: "executor", projectId: "p-app", agentId: "b", agentName: "Hana", state: "blocked", taskId: "T-7", title: "Release notes",
    reason: "Waiting for the signing key", since: at(2) });
  home.needsYou.push({ kind: "executor", projectId: "p-app", agentId: "c", agentName: "Yuki", state: "delivering", taskId: "T-8", title: "Changelog", reason: null, since: at(3) });
  const p = await mount({ workspaceAgents: attentionAgents(), home, storage: startOnSora });
  try {
    const row = (key) => p.doc.querySelector(`[data-needs-you="${key}"]`);
    await waitFor(() => row("executor:b:blocked"), "Hana's blocked task");
    assert.equal(row("executor:b:blocked").querySelector(".home-needs-reason")?.textContent, "Waiting for the signing key");
    assert.match((await hoverTip(p.w, row("executor:b:blocked")))[0], /^Hana · Release notes · Waiting for the signing key · waiting since /);
    assert.equal(row("executor:c:delivering").querySelector(".home-needs-reason"), null, "no reason, no line");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// YN-3 PR B: a project's deck in its order, with no holes (deck-order.ts, deck-pack.ts).
const deckBody = (text, size) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: { summary: { lead: "lead", size } }, children: ["lead"] },
  lead: { type: "Markdown", props: { text } },
} });
const deckStatus = (stale) => ({ asOf: at(stale ? 3 * 24 * 60 : 30), validFor: 86400, stale });
function deckFixture() {
  const home = homeFixture();
  const mori = owner("a", "Mori");
  // In the order they were first written (Core's order), not the deck's.
  home.projects.find((entry) => entry.project.id === "p-app").brief.sections = [
    section("progress", "status", "Old progress", 2, mori, { id: 501, status: deckStatus(true) }),
    section("notes", "report", "Notes", 2, mori, { id: 502, body: deckBody("Notes lead.", "small") }),
    section("release", "ask", "Ship today?", 3, mori, {
      id: 503, ask: { question: "Ship the release today?", state: "open", reply: { options: [{ id: "ship", label: "Ship today" }], freeText: true } },
    }),
    section("train", "status", "Release train", 2, mori, { id: 504, status: deckStatus(false), body: deckBody("Two changes wait.", "wide") }),
    section("tokenizer", "ask", "Keep the old tokenizer?", 2, mori, {
      id: 505, updatedAt: at(90), ask: { question: "Keep it?", state: "replied", repliedAt: at(60), replyText: "Keep it.", reply: { freeText: true } },
    }),
    section("later", "ask", "Which plan?", 1, owner("b", "Hana"), {
      id: 506, ask: { question: "Plan A or B?", state: "open", deferredUntil: new Date(Date.now() + 86_400_000).toISOString(), reply: { freeText: true } },
    }),
    section("eval", "report", "Eval", 1, mori, { id: 507, body: deckBody("Eval lead.", "large") }),
  ];
  return home;
}
const deckKeys = (p) => [...p.panel("p-app").querySelectorAll(".home-brief [data-section-key]")].map((el) => el.dataset.sectionKey);

test("YN-3 a project's page stands its cards in the deck's order within each group: open Asks then those put off; current status, reports, the Asks answered under their heading; status out of date in Done, closed (YN-86 §2.2)", async () => {
  for (const [language, heading, done] of [
    ["en", "Replied, waiting · 1", /^Done · 1 card · latest /],
    ["zh-Hans", "已回复，等处理 · 1", /^已完成 · 1 张 · 最近 /],
  ]) {
    const p = await mount({ open: "p-app", home: deckFixture(), storage: { "yuzuno.language": JSON.stringify({ language }) } });
    try {
      await waitFor(() => card(p, "p-app", "eval"), `the deck is drawn (${language})`);
      assert.deepEqual(deckKeys(p), ["release", "later", "train", "notes", "eval", "tokenizer", "progress"], `the deck's order (${language})`);
      const later = p.panel("p-app").querySelector("details.project-deck-later");
      assert.ok(!!later && !later.open && later.contains(card(p, "p-app", "later")), "the Ask put off, at the end of Needs you, closed");
      const doing = p.panel("p-app").querySelector('[aria-labelledby="home-project-p-app-doing"] .home-brief');
      const head = doing.querySelector(":scope > .home-deck-heading");
      assert.equal(head?.textContent ?? null, heading);
      const after = (a, b) => (a.compareDocumentPosition(b) & p.w.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      assert.ok(after(card(p, "p-app", "eval"), head) && after(head, card(p, "p-app", "tokenizer")), "the heading stands over the answered Ask");
      const closed = p.panel("p-app").querySelector("details.project-deck-done");
      assert.ok(!!closed && !closed.open, "status out of date, in Done, closed");
      assert.ok(closed.contains(card(p, "p-app", "progress")));
      assert.match(closed.querySelector("summary").textContent, done);
      assert.deepEqual(p.errors, []);
    } finally {
      p.close();
    }
  }
});

test("YN-3 a status that goes out of date while Home is read keeps its place until the next visit; a card new in the visit stands before the answered Asks, then takes its own place", async () => {
  const p = await mount({ open: "p-app", home: deckFixture() });
  try {
    await waitFor(() => card(p, "p-app", "eval"), "the deck is drawn");
    const app = p.state.home.projects.find((entry) => entry.project.id === "p-app").brief;
    // While Home is read, the release train goes out of date and a new Ask comes in.
    app.sections.find((s) => s.key === "train").status = deckStatus(true);
    app.sections.push(section("budget", "ask", "Raise the budget?", 1, owner("a", "Mori"), {
      id: 508, ask: { question: "Raise it?", state: "open", reply: { freeText: true } },
    }));
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => card(p, "p-app", "budget"), "the new Ask");
    assert.deepEqual(deckKeys(p), ["release", "later", "train", "notes", "eval", "budget", "tokenizer", "progress"],
      "nothing moves: the release train stays, the new Ask is in progress before the answered ones");
    // The next visit to Home: each in its own place.
    p.doc.querySelector('.agent-row[data-agent-id="b"] .agent-select').click();
    await waitFor(() => p.doc.querySelector(".conversation-title h1")?.textContent === "Hana", "away from Home");
    await wholeHome(p);
    await openProject(p, "p-app");
    await waitFor(() => card(p, "p-app", "budget") && deckKeys(p)[1] === "budget", "the next visit");
    assert.deepEqual(deckKeys(p), ["release", "budget", "later", "notes", "eval", "tokenizer", "progress", "train"]);
    assert.ok(p.panel("p-app").querySelector("details.project-deck-done").contains(card(p, "p-app", "train")), "out of date, done, at the next visit");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("YN-3 the deck and My widgets are laid out with no holes, in order: each card spans its own size and the cells the grid's flow would leave empty", async () => {
  const home = homeFixture();
  const mori = owner("a", "Mori");
  home.projects.find((entry) => entry.project.id === "p-app").brief.sections = [
    section("release", "ask", "Ship today?", 3, mori, {
      id: 511, ask: { question: "Ship the release today?", state: "open", reply: { options: [{ id: "ship", label: "Ship today" }], freeText: true } },
    }),
    section("train", "status", "Release train", 2, mori, { id: 512, status: deckStatus(false), body: deckBody("Two changes wait.", "wide") }),
    section("gpu", "status", "GPU queue", 2, mori, { id: 513, status: deckStatus(false), body: deckBody("Three queued.", "small") }),
    section("eval", "report", "Eval", 1, mori, { id: 514, body: deckBody("Eval lead.", "large") }),
    section("notes", "report", "Notes", 1, mori, { id: 515, body: deckBody("Notes lead.", "small") }),
  ];
  const pins = [{ projectId: "p-app", key: "gpu", id: 513, title: "GPU queue", projectName: "App" }, { projectId: "p-app", key: "eval", id: 514, title: "Eval", projectName: "App" }];
  const p = await mount({
    open: "p-app",
    home,
    storage: { "yuzuno.homeWidgets.ws-home": JSON.stringify({ order: [], hidden: [], pins }) },
    // Four columns as a browser lays the grids out; JSDOM lays out nothing.
    before: (w) => {
      const own = w.getComputedStyle.bind(w);
      w.getComputedStyle = (element, pseudo) => {
        const style = own(element, pseudo);
        if (!element?.classList?.contains("home-brief") && !element?.classList?.contains("home-widget-grid")) return style;
        return new Proxy(style, { get: (target, key) => (key === "gridTemplateColumns" ? "300px 300px 300px 300px" : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
      };
    },
  });
  try {
    await waitFor(() => card(p, "p-app", "notes")?.dataset.deckCols, "the deck is laid out");
    const span = (el) => [el.dataset.deckCols ?? null, el.dataset.deckRows ?? null];
    // The Ask takes its row. Wide, small; the large card cannot follow on the row, nothing reaches its second row:
    // one row; each card that would leave the row's end empty grows to it.
    assert.deepEqual(["train", "gpu", "eval", "notes"].map((key) => span(card(p, "p-app", key))), [["2", "1"], ["2", "1"], ["2", "1"], ["2", "1"]]);
    assert.equal(card(p, "p-app", "release").dataset.deckCols, undefined, "the Ask is its CSS's full row");
    assert.equal(card(p, "p-app", "eval").style.getPropertyValue("--deck-cols"), "2");
    // My widgets, on the whole of Home: Machines takes its row; the small pin, then the large one, which takes the row's end.
    await wholeHome(p);
    const slot = (pin) => p.doc.querySelector(`.home-widget-grid > [data-widget="pin:p-app:${pin.id}:${pin.key}"]`);
    await waitFor(() => slot(pins[1])?.dataset.deckCols, "the widgets are laid out");
    assert.deepEqual(pins.map((pin) => span(slot(pin))), [["1", "1"], ["3", "1"]]);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// YN-3, the user's D3: answered Asks are small answer cards the deck packs, two to a row of four.
test("YN-3 answered Asks are small answer cards on the deck: two share a row of four under their heading; one opened takes its row", async () => {
  const home = homeFixture();
  const mori = owner("a", "Mori");
  const replied = (key, title, id, reply) => section(key, "ask", title, 2, mori, {
    id, ask: { question: `${title} question`, state: "replied", repliedAt: at(30), replyText: reply, reply: { freeText: true } },
  });
  home.projects.find((entry) => entry.project.id === "p-app").brief.sections = [
    section("train", "status", "Release train", 2, mori, { id: 521, status: deckStatus(false), body: deckBody("Two changes wait.", "wide") }),
    replied("tokenizer", "Keep the old tokenizer?", 522, "Keep it until the rebuild."),
    replied("draft", "Publish the draft?", 523, "Yes, once CI is green."),
  ];
  // Four columns as a browser lays the deck out; JSDOM lays out nothing.
  const fourColumns = (w) => {
    const own = w.getComputedStyle.bind(w);
    w.getComputedStyle = (element, pseudo) => {
      const style = own(element, pseudo);
      if (!element?.classList?.contains("home-brief")) return style;
      return new Proxy(style, { get: (target, key) => (key === "gridTemplateColumns" ? "300px 300px 300px 300px" : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
    };
  };
  const p = await mount({ open: "p-app", home, before: fourColumns });
  try {
    // Laid out once the status card has its span (packed in the same pass as every card).
    await waitFor(() => card(p, "p-app", "train")?.dataset.deckCols, "the deck is laid out");
    const span = (key) => [card(p, "p-app", key).dataset.deckCols ?? null, card(p, "p-app", key).dataset.deckRows ?? null];
    assert.ok(["tokenizer", "draft"].every((key) => card(p, "p-app", key).classList.contains("is-answer")), "answer cards");
    // The status takes its row alone; the heading its row; the two answer cards share theirs.
    assert.deepEqual(span("train"), ["4", "1"]);
    assert.deepEqual([span("tokenizer"), span("draft")], [["2", "1"], ["2", "1"]], "two to a row of four, never one and three");
    const heading = p.panel("p-app").querySelector(".home-deck-heading");
    assert.equal(heading.textContent, "Replied, waiting · 2");
    // Opened, it takes its row, as an open Ask does: no longer a small card.
    const tokenizer = card(p, "p-app", "tokenizer");
    tokenizer.querySelector(".home-answer-details").click();
    await waitFor(() => tokenizer.classList.contains("is-open"), "opened");
    assert.equal(tokenizer.dataset.cardSize, undefined);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
  // A lone answer card takes its row, so the row has no hole.
  home.projects.find((entry) => entry.project.id === "p-app").brief.sections.splice(2, 1);
  const q = await mount({ open: "p-app", home, before: fourColumns });
  try {
    await waitFor(() => card(q, "p-app", "train")?.dataset.deckCols, "the deck is laid out");
    assert.equal(card(q, "p-app", "draft"), null);
    assert.equal(card(q, "p-app", "tokenizer").dataset.deckCols, "4", "a lone answer card spans its row");
    assert.deepEqual(q.errors, []);
  } finally {
    q.close();
  }
});

// PR C1's review (P3, the Lead's ruling of 04:33Z): a render packs the deck once and keeps its one
// ResizeObserver; only a change of the deck's size packs it again, in the next frame.
test("YN-3 a deck keeps one ResizeObserver over Home's renders; a render packs it once, a size change once more in the next frame", async () => {
  const made = [];
  const passes = new Map();
  const p = await mount({
    open: "p-app",
    before: (w) => {
      w.ResizeObserver = class {
        constructor(seen) { this.seen = seen; made.push(this); }
        observe(target) { this.target = target; }
        disconnect() { this.off = true; }
      };
      // Each packing pass reads its grid's columns once.
      const own = w.getComputedStyle.bind(w);
      w.getComputedStyle = (element, pseudo) => {
        if (element?.classList?.contains("home-brief")) passes.set(element, (passes.get(element) ?? 0) + 1);
        return own(element, pseudo);
      };
    },
  });
  try {
    const decks = () => made.filter((observer) => observer.target?.classList?.contains("home-brief"));
    await waitFor(() => decks().length > 0, "a deck is watched");
    await pause(100);
    const watched = decks().length;
    // Home reads again: the project's page renders again.
    p.doc.querySelector('[aria-label="Refresh Home"]').click();
    await waitFor(() => p.calls.filter((call) => call.url.endsWith("/api/home")).length >= 2, "Home read again");
    await pause(150);
    assert.equal(decks().length, watched, "one observer per deck, not one per render");
    assert.ok(decks().every((observer) => !observer.off), "each still watching");
    // Its first report is of the size just packed: nothing; a later one packs once, in the next frame.
    const deck = decks()[0];
    const count = () => passes.get(deck.target) ?? 0;
    const before = count();
    deck.seen([{ target: deck.target }]);
    await pause(60);
    assert.equal(count(), before, "the first report packs nothing more");
    deck.seen([{ target: deck.target }]);
    deck.seen([{ target: deck.target }]);
    await waitFor(() => count() > before, "a size change packs again");
    await pause(60);
    assert.equal(count(), before + 1, "once, for two reports in one frame");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// YN-3, the user's item: Return sends a reply from Home as it does from the conversation's composer.
test("YN-3 Enter sends a reply from Home as the composer's Return does: from an Ask, Reply again and a report's Reply; Shift+Enter and Enter while an input method composes do not", async () => {
  const p = await mount({ open: "p-app", home: deckFixture() });
  const enter = (field, init = {}) => field.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
  const replies = () => p.posts(/\/brief\/reply$/);
  try {
    const release = () => card(p, "p-app", "release");
    await waitFor(() => replyField(release()), "the Ask's reply field");
    const field = replyField(release());
    await type(p, field, "Ship it after the docs fix");
    enter(field, { isComposing: true });
    enter(field, { shiftKey: true });
    await pause(150);
    assert.equal(replies().length, 0, "neither Enter while an input method composes nor Shift+Enter sends");
    enter(field);
    await waitFor(() => replies().length === 1, "Enter sends the Ask's reply");
    assert.equal(replies()[0].body.text, "Ship it after the docs fix");
    // Reply again, on an Ask the user answered before this visit.
    const tokenizer = card(p, "p-app", "tokenizer");
    tokenizer.querySelector(".home-fold").click();
    await waitFor(() => p.button("Reply again", tokenizer), "Reply again");
    p.button("Reply again", tokenizer).click();
    await waitFor(() => replyField(tokenizer), "the field again");
    await type(p, replyField(tokenizer), "Switch after the rebuild");
    enter(replyField(tokenizer));
    await waitFor(() => replies().length === 2, "Enter sends the reply again");
    // A report's Reply.
    const notes = card(p, "p-app", "notes");
    notes.querySelector(".home-reply-open").click();
    await waitFor(() => replyField(notes.querySelector(".home-card-reply")), "the report's reply field");
    const reply = replyField(notes.querySelector(".home-card-reply"));
    await type(p, reply, "Thanks");
    enter(reply, { isComposing: true });
    await pause(150);
    assert.equal(replies().length, 2, "not while an input method composes");
    enter(reply);
    await waitFor(() => replies().length === 3, "Enter sends the report's reply");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// YN-3 PR C2: a single-file HTML page works on its card (the user's decision of 03:09Z), asked for from Core as
// a card preview (the interface on YN-3 and YN-10, as #679 builds it) only once the card is in view.
const pageFile = (name, extra = {}) => ({ name, kind: "text", mime: "text/plain; charset=utf-8", size: 2048, snapshot: true, mayChange: false, takenAt: at(60), ...extra });
const pageBody = (lead, size, ...names) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: { summary: { lead: "lead", ...(size ? { size } : {}) } }, children: ["lead", "shown"] },
  lead: { type: "Markdown", props: { text: lead } },
  shown: { type: "Attachments", props: { items: names.map((name) => ({ name })) } },
} });
function pageFixture() {
  const home = homeFixture();
  const mori = owner("a", "Mori");
  home.projects.find((entry) => entry.project.id === "p-app").brief.sections.push(
    section("ring", "report", "Ring design", 3, mori, { id: 601, body: pageBody("The ring design, working.", null, "ring.html", "ring.png"),
      attachments: [pageFile("ring.html"), pageFile("ring.png", { kind: "image", mime: "image/png" })] }),
    section("spec", "report", "Spec page", 2, mori, { id: 602, body: pageBody("The spec.\n\nA second paragraph the card leaves to the page.", null, "spec.html"),
      attachments: [pageFile("spec.html")] }),
    section("tiny", "report", "Tiny page", 1, mori, { id: 603, body: pageBody("A small one.", "small", "tiny.html"), attachments: [pageFile("tiny.html")] }),
    section("trend", "report", "Loss trend", 1, mori, { id: 604, body: { root: "body", elements: {
      body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "chart", size: "small" } }, children: ["lead", "chart"] },
      lead: { type: "Markdown", props: { text: "Loss falls." } },
      chart: { type: "LineChart", props: { id: "c", title: "Loss", data: { attachment: "loss.csv", x: "step", series: [{ name: "A", column: "a" }] } } },
    } }, attachments: [pageFile("loss.csv", { kind: "data", mime: "text/csv" })] }),
    section("method", "report", "Method page", 1, mori, { id: 605, body: pageBody("The method, working.", null, "method.html", "method.pdf"),
      attachments: [pageFile("method.html"), pageFile("method.pdf", { kind: "pdf", mime: "application/pdf" })] }),
  );
  return home;
}
// Cards come into view when the test says so.
function watchedViews(w) {
  const views = [];
  w.IntersectionObserver = class {
    constructor(seen) { this.seen = seen; views.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.off = true; }
  };
  return () => views.filter((view) => !view.off).forEach((view) => view.seen([{ isIntersecting: true, target: view.target }]));
}
// Core's card previews, as #679 answers them; `refuse` answers instead, when given.
function cardPreviews(p, refuse = null) {
  const asked = [];
  asked.proofs = [];
  const base = p.w.fetch;
  p.w.fetch = async (url, init = {}) => {
    const text = (status, body) => ({ ok: status === 200, status, text: async () => body, json: async () => JSON.parse(body) });
    if (url.endsWith("/api/previews") && init.method === "POST") {
      const body = JSON.parse(init.body);
      asked.push(body);
      if (refuse) return text(refuse[0], refuse[1]);
      return text(200, JSON.stringify({
        name: body.name, size: 2048, sha256: "a".repeat(64), takenAt: at(0), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        version: body.version, port: 47390, url: `http://127.0.0.1:47390/v/tok-${body.section}`, place: "card", reused: false,
        proof: { challenge: `c-${body.section}`, answer: `a-${body.section}`, url: `http://127.0.0.1:47390/.well-known/yuzuno-preview/c-${body.section}` },
      }));
    }
    const proof = /\/\.well-known\/yuzuno-preview\/c-(\w+)$/.exec(url);
    if (proof) {
      asked.proofs.push(url);
      return text(200, `a-${proof[1]}`);
    }
    return base(url, init);
  };
  return asked;
}

test("YN-3 a card's HTML page works on its card once in view: one card preview, proven, in the Portal's sandbox; Open large; a page that goes elsewhere is not shown", async () => {
  let show;
  const p = await mount({ open: "p-app", home: pageFixture(), before: (w) => (show = watchedViews(w)) });
  try {
    const asked = cardPreviews(p);
    const ring = () => card(p, "p-app", "ring");
    await waitFor(() => ring()?.querySelector(".home-card-page"), "the ring card's page frame");
    assert.equal(ring().dataset.cardSize, "large", "a page with no size named: large");
    assert.equal(asked.length, 0, "nothing asked for before the card is in view");
    show();
    await waitFor(() => ring().querySelector("iframe.home-card-page-frame"), "the page is shown");
    assert.deepEqual(asked.filter((body) => body.section === "ring"),
      [{ kind: "briefAttachment", projectId: "p-app", section: "ring", name: "ring.html", version: 3, place: "card" }], "one card preview of this version");
    const frame = ring().querySelector("iframe.home-card-page-frame");
    assert.deepEqual([frame.getAttribute("src"), frame.getAttribute("sandbox"), frame.getAttribute("referrerpolicy"), frame.getAttribute("allow")],
      ["http://127.0.0.1:47390/v/tok-ring", "allow-scripts", "no-referrer", ""]);
    assert.ok(asked.proofs.includes("http://127.0.0.1:47390/.well-known/yuzuno-preview/c-ring"), "proven reachable from this browser first");
    assert.ok(ring().querySelector('button[aria-label="Open ring.html large"]'), "Open large");
    // A small card's page: one line that opens it, no frame, nothing asked for.
    const tiny = card(p, "p-app", "tiny");
    assert.equal(tiny.dataset.cardSize, "small");
    assert.equal(tiny.querySelector("iframe"), null);
    assert.match(tiny.querySelector(".home-card-page-line").textContent, /tiny\.html · 2\.0 KB/);
    assert.equal(asked.filter((body) => body.section === "tiny").length, 0);
    // Its other files, named under the picture.
    assert.deepEqual([...ring().querySelectorAll(".home-card-file")].map((chip) => chip.textContent.trim()), ["ring.png"]);
    // The page goes elsewhere: the card says so and offers it back.
    frame.dispatchEvent(new p.w.Event("load"));
    frame.dispatchEvent(new p.w.Event("load"));
    await waitFor(() => /loaded something else/.test(ring().querySelector(".home-card-page").textContent), "the card no longer shows it");
    assert.equal(ring().querySelector("iframe"), null);
    p.button("Back to the page", ring()).click();
    await waitFor(() => ring().querySelector("iframe.home-card-page-frame"), "back to the page");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// YN-16 S6: the page's frame, as the bridge reads and answers it. A message
// event as the browser delivers one: from the frame's own window, origin "null".
const fromPage = (p, data, source, origin = "null") => p.w.dispatchEvent(new p.w.MessageEvent("message", { data, source, origin }));
// What Home posts to the frame's window, kept instead of delivered.
function givenTo(frame) {
  const given = [];
  Object.defineProperty(frame.contentWindow, "postMessage", { configurable: true, value: (message, origin) => given.push([message, origin]) });
  return given;
}

test("YN-16 S6 a card's page talks to Home only through the bridge: the theme on its first load and on a change, its height within 120-1600 px, a message sent to the section's author only on Send", async () => {
  let show;
  const p = await mount({ open: "p-app", home: pageFixture(), before: (w) => (show = watchedViews(w)) });
  try {
    cardPreviews(p);
    const ring = () => card(p, "p-app", "ring");
    await waitFor(() => ring()?.querySelector(".home-card-page"), "the ring card's page frame");
    show();
    await waitFor(() => ring().querySelector("iframe.home-card-page-frame"), "the page is shown");
    const frame = ring().querySelector("iframe.home-card-page-frame");
    const page = frame.contentWindow;
    const given = givenTo(frame);
    frame.dispatchEvent(new p.w.Event("load"));
    assert.equal(given.length, 1, "the theme, on its first load");
    const [[theme, origin]] = given;
    assert.equal(origin, "*", "an opaque origin is named *");
    assert.equal(theme.type, "yuzuno:theme");
    assert.deepEqual(Object.keys(theme.vars), ["--paper", "--ink", "--line", "--accent-ink", "--green", "--font"]);
    assert.equal(theme.scheme, "light");
    // Its height: kept within 120-1600 px, the newest once per frame. The bridge
    // starts listening in an effect after the frame is drawn: the first height is
    // sent until it is taken, and from then on the bridge is known to listen.
    await waitFor(() => {
      fromPage(p, { type: "yuzuno:height", px: 5000 }, page);
      return frame.style.height === "1600px";
    }, "at most 1600 px");
    fromPage(p, { type: "yuzuno:height", px: 40 }, page);
    fromPage(p, { type: "yuzuno:height", px: 300.4 }, page);
    await waitFor(() => frame.style.height === "300px", "the newest");
    assert.ok(ring().querySelector(".home-card-page").classList.contains("is-sized"));
    fromPage(p, { type: "yuzuno:height", px: 40 }, page);
    await waitFor(() => frame.style.height === "120px", "at least 120 px");
    // The bridge listens now (a height was taken, by the effect that also watches the theme): the theme changes.
    p.doc.documentElement.dataset.theme = "dark";
    await waitFor(() => given.length === 2, "the theme given again when it changes");
    assert.equal(given[1][0].scheme, "dark");
    p.doc.documentElement.dataset.agentList = "compact";
    await pause(30);
    assert.equal(given.length, 2, "nothing else is given");
    // Not this page's, or not a message the bridge takes: nothing.
    fromPage(p, { type: "yuzuno:send", text: "from Home's own window" }, p.w);
    fromPage(p, { type: "yuzuno:send", text: "from a page with an origin" }, page, "http://127.0.0.1:47390");
    fromPage(p, { type: "yuzuno:send", text: "x".repeat(2001) }, page);
    fromPage(p, { type: "yuzuno:send", text: "   " }, page);
    fromPage(p, { type: "yuzuno:send", text: 42 }, page);
    fromPage(p, { type: "yuzuno:height", px: 900 }, p.w);
    await pause(30);
    const bar = () => ring().querySelector(".home-page-send");
    assert.equal(bar(), null, "nothing offered");
    assert.equal(frame.style.height, "120px", "another window's height is not taken");
    // Offered: the newest replaces the one before; Don't send sends nothing.
    fromPage(p, { type: "yuzuno:send", text: "First idea" }, page);
    await waitFor(() => bar(), "the page's message offered under it");
    fromPage(p, { type: "yuzuno:send", text: "  Ring size 7, gold  " }, page);
    await waitFor(() => /Ring size 7, gold/.test(bar().textContent), "a newer one replaces it");
    assert.doesNotMatch(bar().textContent, /First idea/);
    assert.equal(bar().querySelector(".home-page-send-head").textContent, "ring.html asks to send this to Mori, as your reply:");
    assert.equal(bar().querySelector(".home-page-send-text").textContent, "Ring size 7, gold");
    p.button("Don't send", bar()).click();
    await waitFor(() => !bar(), "gone, not sent");
    assert.deepEqual(p.posts(/\/brief\/reply$/), [], "nothing is sent without Send");
    // Send: the user's own reply from Home, to the section's author, at the version shown.
    fromPage(p, { type: "yuzuno:send", text: "Ring size 7, gold" }, page);
    await waitFor(() => bar(), "offered again");
    // Send takes a message only once it has been shown a second (S6 R1 P2).
    const sendButton = () => p.button("Send", bar());
    assert.equal(sendButton().disabled, true, "not yet: just shown");
    const shownAt = Date.now();
    await waitFor(() => !sendButton().disabled, "armed once read");
    assert.ok(Date.now() - shownAt >= 900, `armed after about a second, not ${Date.now() - shownAt} ms`);
    // The page swaps its text as the pointer reaches Send, and the click lands
    // before the bar is drawn again: the text the user read is not the newest,
    // so nothing is sent; the new text is shown, and Send waits for it to be read.
    const read = sendButton();
    fromPage(p, { type: "yuzuno:send", text: "Ring size 9, silver" }, page);
    read.click();
    await waitFor(() => /Ring size 9, silver/.test(bar().textContent), "the new text shown");
    assert.equal(sendButton().disabled, true, "the new text is not read yet");
    await pause(60);
    assert.deepEqual(p.posts(/\/brief\/reply$/), [], "neither the text read nor the one swapped in is sent");
    // The page offers the first again: a new text to read, then Send sends what it shows.
    fromPage(p, { type: "yuzuno:send", text: "Ring size 7, gold" }, page);
    await waitFor(() => bar().querySelector(".home-page-send-text").textContent === "Ring size 7, gold" && sendButton().disabled, "shown again, not armed");
    await waitFor(() => !sendButton().disabled, "armed again");
    sendButton().click();
    await waitFor(() => /Sent to Mori\./.test(bar()?.textContent ?? ""), "sent");
    const sent = p.posts(/\/brief\/reply$/);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /\/api\/projects\/p-app\/brief\/reply$/);
    const { key, agentId, text, version, title, clientMessageId } = sent[0].body;
    assert.deepEqual({ key, agentId, text, version, title }, { key: "ring", agentId: "a", text: "From the page “ring.html”:\n\nRing size 7, gold", version: 3, title: "Ring design" });
    assert.equal(typeof clientMessageId, "string");
    assert.ok(!("shown" in sent[0].body) && !("sentAt" in sent[0].body), "what is kept here only stays here");
    // A page that went elsewhere is not listened to.
    frame.dispatchEvent(new p.w.Event("load"));
    await waitFor(() => /loaded something else/.test(ring().querySelector(".home-card-page").textContent), "moved");
    fromPage(p, { type: "yuzuno:send", text: "from where it went" }, page);
    await pause(30);
    assert.equal(bar(), null);
    assert.equal(given.length, 2, "no theme for the page it went to");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("YN-16 S6 a card's page whose author is not open in the Project: its message is shown, and can't be sent from here", async () => {
  let show;
  const home = pageFixture();
  home.projects.find((entry) => entry.project.id === "p-app").brief.sections.find((s) => s.key === "ring").owner.state = "closed";
  const p = await mount({ open: "p-app", home, before: (w) => (show = watchedViews(w)) });
  try {
    cardPreviews(p);
    const ring = () => card(p, "p-app", "ring");
    await waitFor(() => ring()?.querySelector(".home-card-page"), "the ring card's page frame");
    show();
    await waitFor(() => ring().querySelector("iframe.home-card-page-frame"), "the page is shown");
    const frame = ring().querySelector("iframe.home-card-page-frame");
    givenTo(frame);
    frame.dispatchEvent(new p.w.Event("load"));
    const bar = () => ring().querySelector(".home-page-send");
    // Sent until the bridge, listening from an effect after the frame is drawn, takes it.
    await waitFor(() => bar() || (fromPage(p, { type: "yuzuno:send", text: "Ring size 7" }, frame.contentWindow), false), "offered");
    assert.match(bar().textContent, /ring\.html asks to send this to Mori, who isn't open in this Project, so it can't be sent from here:/);
    assert.deepEqual([...bar().querySelectorAll("button")].map((b) => b.textContent.trim()), ["Don't send"]);
    p.button("Don't send", bar()).click();
    await waitFor(() => !bar(), "gone");
    assert.deepEqual(p.posts(/\/brief\/reply$/), []);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("YN-3 a card's page shown when its author writes a new version: the new version's page, not loaded something else (PR C2's review)", async () => {
  let show;
  const p = await mount({ open: "p-app", home: pageFixture(), before: (w) => (show = watchedViews(w)) });
  try {
    const asked = cardPreviews(p);
    const ring = () => card(p, "p-app", "ring");
    await waitFor(() => ring()?.querySelector(".home-card-page"), "the ring card's page frame");
    show();
    await waitFor(() => ring().querySelector("iframe.home-card-page-frame"), "version 3's page is shown");
    ring().querySelector("iframe.home-card-page-frame").dispatchEvent(new p.w.Event("load"));
    // The author writes version 4; Core serves its page at the same address, as a stub may.
    Object.assign(p.state.home.projects.find((entry) => entry.project.id === "p-app").brief.sections.find((s) => s.key === "ring"), { version: 4 });
    p.event({ type: "workspace.changed", scope: "brief" });
    await waitFor(() => ring().dataset.sectionVersion === "4", "Home read version 4");
    show();
    await waitFor(() => asked.some((body) => body.section === "ring" && body.version === 4), "version 4's page asked for");
    await waitFor(() => ring().querySelector("iframe.home-card-page-frame") && ring().querySelector(".home-card-page").dataset.pageState === "ready", "version 4's page is shown");
    ring().querySelector("iframe.home-card-page-frame").dispatchEvent(new p.w.Event("load"));
    await pause(50);
    assert.doesNotMatch(ring().querySelector(".home-card-page").textContent, /loaded something else/, "its first load is the page");
    assert.ok(ring().querySelector("iframe.home-card-page-frame"), "the page stays shown");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("YN-3 where a card's page can't be shown, the card names the file and offers its Preview: an older Core, phone access without previews, another version", async () => {
  for (const [why, refuse, note] of [
    ["an older Core refuses the field", [422, "Failed to deserialize the JSON body into the target type: unknown field `place`"], /can't show it on the card/],
    ["phone access without previews", [400, JSON.stringify({ error: "preview_unavailable_remote: phone access does not include previews" })], /Phone access doesn't include previews/],
    ["a version other than the card's", null, /can't show it on the card/],
  ]) {
    let show;
    const home = pageFixture();
    const p = await mount({ open: "p-app", home, before: (w) => (show = watchedViews(w)) });
    try {
      const asked = cardPreviews(p, refuse);
      if (!refuse) {
        // Core serves another version than the card's: not this card's page.
        const ring = home.projects.find((entry) => entry.project.id === "p-app").brief.sections.find((s) => s.key === "ring");
        const base = p.w.fetch;
        p.w.fetch = async (url, init = {}) => {
          const answer = await base(url, init);
          if (!url.endsWith("/api/previews")) return answer;
          const body = await answer.json();
          return { ok: true, status: 200, json: async () => ({ ...body, version: ring.version + 1 }), text: async () => JSON.stringify({ ...body, version: ring.version + 1 }) };
        };
      }
      await waitFor(() => card(p, "p-app", "ring")?.querySelector(".home-card-page"), "the ring card's page frame");
      show();
      const ring = () => card(p, "p-app", "ring");
      await waitFor(() => ring().querySelector(".home-card-page-static"), `the static card: ${why}`);
      assert.ok(asked.length >= 1, why);
      assert.equal(ring().querySelector("iframe"), null, why);
      assert.match(ring().querySelector(".home-card-page-static").textContent, /ring\.html · 2\.0 KB/, why);
      assert.match(ring().querySelector(".home-card-page-static").textContent, note, why);
      assert.ok(p.button("Preview", ring().querySelector(".home-card-page-static")), `${why}: its Preview`);
      assert.deepEqual(p.errors, []);
    } finally {
      p.close();
    }
  }
});

test("YN-3 a report whose body holds only what its card shows is the whole report: no Open report, its title not a link; with more, both stay", async () => {
  const p = await mount({ open: "p-app", home: pageFixture(), before: (w) => watchedViews(w) });
  try {
    await waitFor(() => card(p, "p-app", "ring") && card(p, "p-app", "spec"), "both cards");
    const ring = card(p, "p-app", "ring"), spec = card(p, "p-app", "spec");
    assert.ok(ring.classList.contains("is-whole"), "the card is the report");
    assert.equal(p.button("Open report", ring), undefined, "no Open report");
    assert.equal(ring.querySelector(".home-summary-title-link"), null, "its title is not a link");
    assert.ok(!spec.classList.contains("is-whole"));
    assert.ok(p.button("Open report", spec), "a card that leaves more to its page keeps Open report");
    assert.ok(spec.querySelector(".home-summary-title-link"));
    // What the card can only name keeps its page linked (PR C2's review): a chart on a small card, a PDF beside the page.
    const trend = card(p, "p-app", "trend"), method = card(p, "p-app", "method");
    assert.equal(trend.dataset.cardSize, "small");
    assert.match(trend.textContent, /Line chart · on the report/);
    assert.ok(!trend.classList.contains("is-whole") && p.button("Open report", trend), "a chart named as on the report, and the report linked");
    assert.ok(!method.classList.contains("is-whole") && p.button("Open report", method), "the PDF opens on the report page");
    assert.equal(method.querySelector(".home-card-file").disabled, false, "its chip opens it there");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// YN-86 S1a: a Project's page on Home, its entry on the rail, and the address
// it lives at. The grouping itself is project-deck.test.mjs's; here the page
// is built from Core's fixture, the arrow folds without opening it, Back
// returns to the whole of Home, and an address opens it directly.
test("a Project's name on the rail opens its page; the arrow only folds; Back returns to Home (YN-86)", async () => {
  const home = homeFixture();
  const app = home.projects.find((panel) => panel.project.id === "p-app");
  // A read report in a topic of its own: it is Done, while a read report whose sub-topic is unread stays with it.
  app.brief.sections.push(section("reviewed", "report", "Reviewed", 1, owner("a", "Mori"), { seen: { version: 1, at: at(30) } }));
  // More than its card shows: the unread report keeps its own page.
  const review = app.brief.sections.find((s) => s.key === "notes/review");
  review.body.elements.body.children = ["text", "more"];
  review.body.elements.more = { type: "Markdown", props: { text: "A second paragraph the card leaves to its page." } };
  const p = await mount({ home });
  try {
    const group = p.doc.querySelector('.project-group[data-group="p-app"]');
    assert.ok(group, "the rail groups App");
    const fold = group.querySelector(".project-group-fold");
    const name = group.querySelector(".project-group-toggle");
    assert.equal(fold.getAttribute("aria-expanded"), "true");
    assert.match(name.getAttribute("aria-label"), /^Open App's project page · 2 agents$/);
    // Tab order in the heading: the arrow, the name, then +.
    assert.deepEqual(
      [...group.querySelector(".project-group-head").children].slice(0, 3).map((el) => el.className),
      ["project-group-fold", "project-group-toggle", "project-group-add"],
    );
    // The arrow folds, and only folds.
    fold.click();
    await waitFor(() => group.classList.contains("is-folded"), "the arrow folds the group");
    assert.equal(fold.getAttribute("aria-expanded"), "false");
    assert.equal(p.doc.querySelector("[data-project-home]"), null, "no Project's page opened");
    assert.ok(p.doc.querySelector(".home-layout"), "still on the whole of Home");
    // The name opens the Project's page: no whole-of-Home panes, its own groups.
    fold.click();
    await waitFor(() => !group.classList.contains("is-folded"), "the group opens again");
    name.click();
    await waitFor(() => p.doc.querySelector('[data-project-home="p-app"]'), "the Project's page");
    assert.equal(p.w.location.hash, "#/home?w=ws-home&p=p-app", "the page is in the address");
    assert.equal(p.doc.querySelector(".home-layout"), null, "the whole of Home gave way");
    assert.equal(p.doc.querySelector("[data-home-project]"), null, "its panel is not drawn too");
    assert.equal(name.getAttribute("aria-current"), "page", "the rail says which Project's page is open");
    assert.equal(p.doc.querySelector(".project-home-head h1").textContent.startsWith("App"), true);
    assert.equal(p.doc.querySelector(".project-home-head .home-chip.is-attention").textContent, "2 need you");
    assert.equal(p.doc.querySelector(".project-home-head .home-chip.is-new").textContent, "2 new");
    // The three groups, cards in the group their place and read state put them.
    const deck = (name) => p.doc.querySelector(`[aria-labelledby="home-project-p-app-${name}"]`);
    assert.match(deck("needs").querySelector(".project-deck-title").textContent, /^Needs you2/);
    assert.ok(p.doc.getElementById("home-section-p-app-release"), "the open Ask is in Needs you");
    assert.ok(p.doc.getElementById("home-section-p-app-budget"), "so is the other one");
    // A topic stands where its most urgent card does: the read report of "notes" stays with its unread sub-topic.
    assert.match(deck("doing").querySelector(".project-deck-title").textContent, /^In progress2/);
    assert.ok(deck("doing").contains(p.doc.getElementById("home-section-p-app-notes/review")), "the unread report is in progress");
    assert.ok(deck("doing").contains(p.doc.getElementById("home-section-p-app-notes")), "so is the read report of its topic");
    const done = p.doc.querySelector(".project-deck-done");
    assert.equal(done.open, false, "Done is closed at first");
    assert.match(done.querySelector("summary").textContent, /^Done · 1 card · latest .* · 30-day history 1$/);
    done.querySelector("summary").click();
    await waitFor(() => done.open, "Done opens");
    assert.ok(done.contains(p.doc.getElementById("home-section-p-app-reviewed")), "the read report of its own topic is done");
    assert.ok(!done.contains(p.doc.getElementById("home-section-p-app-notes")), "the read report kept with its unread topic is not");
    // A report opens over the page and closes back onto it, the card where it was.
    const card = p.doc.getElementById("home-section-p-app-notes/review");
    card.querySelector(".home-report-open").click();
    await waitFor(() => p.doc.querySelector(".home-report .report-head h1"), "the report page");
    p.doc.querySelector(".home-report .report-back").click();
    await waitFor(() => !p.doc.querySelector(".home-report"), "the report closes");
    assert.ok(deck("doing").contains(card), "the card stayed in In progress");
    // Core's next read has it read: New goes, the card does not move in this visit.
    const panel = p.state.home.projects.find((project) => project.project.id === "p-app");
    const section = panel.brief.sections.find((s) => s.key === "notes/review");
    section.opened = { version: section.version, at: at(1) };
    p.doc.querySelector('.project-home [aria-label="Refresh Home"]').click();
    await waitFor(() => !card.classList.contains("is-changed"), "the read version clears New");
    assert.ok(deck("doing").contains(card), "and the card stays where this visit first put it");
    // Back, from the Project's page, to the whole of Home.
    p.w.history.back();
    await waitFor(() => p.doc.querySelector(".home-layout"), "Back on the whole of Home");
    assert.equal(p.doc.querySelector("[data-project-home]"), null, "the Project's page is gone");
    assert.equal(p.w.location.hash, "", "its address is gone too");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a Project's page in Chinese, and #/home?w&p opening it directly (YN-86)", async () => {
  const zh = await mount({ storage: { "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) } });
  try {
    const group = zh.doc.querySelector('.project-group[data-group="p-app"]');
    const name = group.querySelector(".project-group-toggle");
    assert.equal(group.querySelector(".project-group-fold").getAttribute("aria-label"), "折叠 App");
    assert.match(name.getAttribute("aria-label"), /^打开 App 的项目页 · 2 个 Agent$/);
    name.click();
    await waitFor(() => zh.doc.querySelector('[data-project-home="p-app"]'), "the Chinese Project's page");
    assert.equal(zh.doc.querySelector(".project-home-head h1").textContent.startsWith("App"), true);
    const titles = [...zh.doc.querySelectorAll(".project-deck-title")].map((title) => title.textContent);
    assert.match(titles[0], /^需要你/);
    assert.match(titles[1], /^进行中/);
    assert.match(zh.doc.querySelector(".project-deck-done summary").textContent, /^已完成/);
    assert.equal(zh.doc.querySelector(".project-deck-note").textContent, "一次访问内位置不变");
    zh.doc.querySelector('.project-home [aria-label="刷新 Home"]').click();
    assert.deepEqual(zh.errors, []);
  } finally {
    zh.close();
  }
  // An address names the Project's page: Home opens it there, without the whole of Home first.
  const direct = await mount({ url: "http://127.0.0.1:4317/#/home?w=ws-home&p=p-res", pressHome: false });
  try {
    await waitFor(() => direct.doc.querySelector('[data-project-home="p-res"]'), "the address opens the Project's page");
    assert.equal(direct.w.location.hash, "#/home?w=ws-home&p=p-res", "the address stays while the page is open");
    assert.equal(direct.doc.querySelector(".home-layout"), null);
    assert.equal(direct.doc.querySelector(".project-home-head h1").textContent.startsWith("Research"), true);
    assert.deepEqual(direct.errors, []);
  } finally {
    direct.close();
  }
});
