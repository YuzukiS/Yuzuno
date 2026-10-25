import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { AUTO_READ_DWELL_MS } from "../src/useAutoRead.ts";

// Exercises the built app against an in-memory Core; it never contacts a real one.
const distUrl = process.env.YUZUNO_UI_DIST
  ? pathToFileURL(resolve(process.env.YUZUNO_UI_DIST) + "/")
  : new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", distUrl), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)?.[1];
assert.ok(entry, "index.html must name the current JavaScript bundle");
const { uiTestBundle } = await import("./ui-test-bundle.mjs");
const bundle = await uiTestBundle(new URL(entry, distUrl));
const pause = (ms = 45) => new Promise((resolve) => setTimeout(resolve, ms));
// Waits until check() returns something truthy and returns it; fails with the
// label when that has not happened by the deadline.
async function waitFor(check, label, timeout = 5_000) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (performance.now() > deadline) assert.fail(`${label} (not within ${timeout} ms)`);
    await pause(5);
  }
}
// A window in which no read may happen lasts the dwell plus 300 ms for the
// conversation's read and render.
const DWELL_PLUS = AUTO_READ_DWELL_MS + 300;
// Only the test with a positive dwell control runs the dwell ten times faster.
const SCALED_DWELL_MS = AUTO_READ_DWELL_MS / 10;
const SCALED_DWELL_PLUS = SCALED_DWELL_MS + 300;
// The design specimen's "never contacts Core" was watched this long before:
// the old mount loop never matched there and ran out (40 x 45 ms), then 45 ms.
const SPECIMEN_WATCH_MS = 1_850;

// A narrow test seam, installed before the bundle runs (React's scheduler
// keeps the setTimeout it finds then): a setTimeout whose delay is exactly one
// of the named product constants gets the scaled delay. Every other delay,
// setInterval and Date stay real, and without a mapping nothing is wrapped.
function timerSeam(window, map) {
  const mapping = new Map(Object.entries(map).map(([from, to]) => [Number(from), to]));
  const requested = [];
  const fired = [];
  if (mapping.size) {
    const real = window.setTimeout;
    window.setTimeout = function (handler, delay, ...args) {
      const scaled = mapping.get(delay);
      if (scaled === undefined || typeof handler !== "function") return real.call(window, handler, delay, ...args);
      requested.push(delay);
      return real.call(window, (...a) => {
        fired.push(delay);
        return handler(...a);
      }, scaled, ...args);
    };
  }
  return { requested, fired };
}

const projects = [
  { id: "p-app", name: "App", defaultDirs: { local: "/home/u/app" }, createdAt: "", updatedAt: "" },
  { id: "p-res", name: "Research", defaultDirs: {}, createdAt: "", updatedAt: "" },
  { id: "p-old", name: "Old study", defaultDirs: {}, archivedAt: "2026-10-01", createdAt: "", updatedAt: "" },
  // No agents, but tasks still link here.
  { id: "p-docs", name: "Docs", defaultDirs: {}, createdAt: "", updatedAt: "" },
];
const projectUsage = { "p-app": { agents: 2, tasks: 1 }, "p-docs": { agents: 0, tasks: 1 } };
const base = {
  model: "test-model",
  color: "sage",
  status: "idle",
  createdAt: "2026-10-12",
  updatedAt: "2026-10-12",
  goal: "",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 12,
  reviewedSeq: 12,
};
function fixtureAgents(overrides = {}) {
  return [
    { ...base, id: "a", name: "Mori", cwd: "/home/u/app", projectId: "p-app" },
    // An external worktree still belongs to the same project.
    { ...base, id: "b", name: "Hana", cwd: "/home/u/app-collaboration", projectId: "p-app" },
    { ...base, id: "c", name: "Sora", cwd: "/home/u/research", projectId: "p-res", unreadCount: 2, reviewedSeq: 5, pendingCount: 1 },
    { ...base, id: "d", name: "Kumo", cwd: "/home/u/old", projectId: "p-old", pendingCount: 1 },
    { ...base, id: "e", name: "Loose", cwd: "/home/u/scratch" },
  ].map((agent) => ({ ...agent, ...overrides[agent.id] }));
}
const tasks = [
  { id: "T-1", seq: 1, title: "Ship scope", description: "", status: "doing", projectId: "p-app", version: 1, createdAt: "", createdBy: { kind: "user", id: "user", name: "You" }, updatedAt: "", updatedBy: { kind: "user", id: "user", name: "You" } },
  { id: "T-2", seq: 2, title: "Read papers", description: "", status: "todo", projectId: "p-res", assigneeAgentId: "b", version: 1, createdAt: "", createdBy: { kind: "user", id: "user", name: "You" }, updatedAt: "", updatedBy: { kind: "user", id: "user", name: "You" } },
  { id: "T-3", seq: 3, title: "Loose end", description: "", status: "todo", projectId: null, version: 1, createdAt: "", createdBy: { kind: "user", id: "user", name: "You" }, updatedAt: "", updatedBy: { kind: "user", id: "user", name: "You" } },
];

// The initial shell already says "All projects". By default, wait for the
// workspace response (which also restores scope), not just that initial label.
const workspaceShown = (document) =>
  document.querySelector(".workspace-scope .status-dot.idle") && document.querySelector(".agent-list");
async function mount({ storage = {}, agents: overrides = {}, catchupItems = [], url = "http://127.0.0.1:4317/", failMove = [],
  timers: scaled = {}, ready = workspaceShown } = {}) {
  const agents = fixtureAgents(overrides);
  const editorPolicies = new Map();
  // Project services (T-151): what Core keeps, and what answers on each
  // port of this browser's computer (the proof the page checks itself).
  const services = [];
  const answersHere = new Map();
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  for (const [key, value] of Object.entries(storage))
    window.localStorage.setItem(key, JSON.stringify(value));
  window.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  window.EventSource = class { close() {} };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.scrollTo = function () {};
  const timers = timerSeam(window, scaled);
  // A conversation that is displayed counts as visible at its end, so an
  // automatic selection would be read after the dwell. Reads are observable.
  Object.defineProperty(window.document, "hasFocus", { configurable: true, value: () => true });
  Object.defineProperty(window.document, "visibilityState", { configurable: true, value: "visible" });
  const geometry = (element) =>
    element.classList?.contains("conversation-scroll")
      ? { top: 100, left: 100, bottom: 600, right: 800, width: 700, height: 500 }
      : element.classList?.contains("read-end-marker")
        ? { top: 598, left: 110, bottom: 599, right: 790, width: 680, height: 1 }
        : { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
  window.HTMLElement.prototype.getBoundingClientRect = function () { return geometry(this); };
  for (const [name, value] of [["clientHeight", 500], ["clientWidth", 700], ["scrollHeight", 500]])
    Object.defineProperty(window.HTMLElement.prototype, name, {
      configurable: true,
      get() { return this.classList?.contains("conversation-scroll") ? value : 0; },
    });
  // Like a real Core, every response is a fresh object, never shared state.
  const respond = (body) => {
    const text = JSON.stringify(body);
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  };
  window.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method || "GET", body });
    let match;
    if (url.endsWith("/api/workspace"))
      return respond({ workspace: { id: "ws-1" }, projects, projectUsage, agents: [...agents], runtime: { connected: false, error: "Codex unavailable" }, defaultCwd: "/workspace" });
    if ((match = url.match(/\/api\/agents\/(\w)\/project$/))) {
      if (failMove.includes(match[1]))
        return { ok: false, status: 400, json: async () => ({}), text: async () => JSON.stringify({ error: "Agent is gone" }) };
      const agent = agents.find((a) => a.id === match[1]);
      agent.projectId = body.projectId;
      return respond(agent);
    }
    if ((match = url.match(/\/api\/agents\/(\w)$/))) {
      const agent = agents.find((a) => a.id === match[1]);
      if (init.method === "DELETE") {
        agents.splice(agents.indexOf(agent), 1);
        return respond({ deleted: true });
      }
      return respond({
        agent,
        pending: [],
        artifacts: [],
        messageReceipts: [],
        turns: [{ id: `t-${agent.id}`, status: "completed", items: [
          { id: `u-${agent.id}`, type: "userMessage", content: [{ type: "text", text: "Hello" }] },
          { id: `r-${agent.id}`, type: "agentMessage", phase: "final_answer", text: `Reply from ${agent.name}` },
        ] }],
      });
    }
    if (url.endsWith("/api/catchup"))
      return respond({ generatedAt: "now", items: catchupItems, source: "records", coverage: { fromSeq: 0, toSeq: 12 } });
    // Home (T-85) lists every project, whatever the rail's scope.
    if (url.endsWith("/api/home"))
      return respond({ generatedAt: "now", order: [], projects: [], needsYou: catchupItems
        .filter((item) => item.kind === "pending")
        .map((item) => ({ kind: "approval", projectId: null, agentId: item.agentId, agentName: item.agentName,
          requestId: item.id, title: item.body, since: "2026-10-17T00:00:00Z" })) });
    const editorProject = url.match(/\/api\/projects\/([^/]+)\/home-editors$/)?.[1];
    if (editorProject) {
      let policy = editorPolicies.get(editorProject) || { version: 0, editorAgentIds: null };
      if (init.method === "PUT") {
        assert.equal(body.expectedVersion, policy.version);
        policy = { version: policy.version + 1, editorAgentIds: body.editorAgentIds };
        editorPolicies.set(editorProject, policy);
      }
      return respond(policy);
    }
    if ((match = url.match(/^http:\/\/127\.0\.0\.1:(\d+)\/\.well-known\/yuzuno-service\/(\w+)$/))) {
      const text = answersHere.get(Number(match[1]))?.(match[2]);
      if (text === undefined) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, json: async () => ({}), text: async () => text };
    }
    if ((match = url.match(/\/api\/projects\/([^/]+)\/services$/))) {
      if (init.method === "POST") {
        const made = { id: `s-${services.length + 1}`, projectId: match[1], ...body, author: { kind: "user" }, createdAt: "",
          connection: { state: "closed", since: "" } };
        services.push(made);
        return respond(made);
      }
      return respond({ services: services.filter((service) => service.projectId === match[1]) });
    }
    if ((match = url.match(/\/api\/services\/([^/]+)\/(open|close)$/))) {
      const service = services.find((s) => s.id === match[1]);
      if (match[2] === "close") {
        service.connection = { state: "closed", since: "" };
        return respond(service);
      }
      const port = 4380 + services.indexOf(service);
      service.connection = { state: "available", httpStatus: 200, localPort: port, since: "" };
      return respond({ ...service, proof: { challenge: `c${port}`, answer: `a${port}` } });
    }
    if ((match = url.match(/\/api\/services\/([^/]+)$/)) && init.method === "DELETE") {
      services.splice(services.findIndex((s) => s.id === match[1]), 1);
      return respond({ deleted: true });
    }
    if (url.endsWith("/api/machines"))
      return respond({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/workspace" },
        { id: "gpu", name: "GPU box", kind: "ssh", defaultCwd: "/srv" }] });
    if (url.endsWith("/api/projects") && init.method === "POST")
      return respond({ id: "p-new", name: body.name, defaultDirs: body.defaultDirs || {}, createdAt: "", updatedAt: "" });
    if (url.endsWith("/api/agents") && init.method === "POST") {
      const created = { ...base, id: "n", name: body.name, cwd: body.cwd, projectId: body.projectId };
      agents.push(created);
      return respond(created);
    }
    if (url.endsWith("/api/collaboration/task_list")) {
      const scoped = tasks.filter((task) =>
        !("projectId" in body) ? true : body.projectId === null ? !task.projectId : task.projectId === body.projectId);
      return respond({ tasks: scoped, hasMore: false, counts: {} });
    }
    if (url.endsWith("/api/collaboration/task_get")) {
      const task = tasks.find((t) => t.id === body.taskId);
      return respond({ task, activities: [], executions: [], hasMore: false });
    }
    if (url.endsWith("/api/collaboration/task_create") || url.endsWith("/api/collaboration/task_update"))
      return respond({ task: { ...tasks[0], ...body, ...(body.patch || {}), id: body.taskId || "T-9", version: 2 }, activity: {} });
    if (url.endsWith("/models")) return respond({ models: [] });
    return respond({});
  };
  window.eval(bundle);
  const evaluatedAt = performance.now();
  try {
    await waitFor(() => ready(window.document), "the app is shown", 10_000);
  } catch (error) {
    // A window left open keeps its 5 s poll running and the file alive.
    window.close();
    throw error;
  }
  return {
    window,
    timers,
    evaluatedAt,
    document: window.document,
    calls,
    errors,
    agents,
    services,
    answersHere,
    reads: () => calls.filter((call) => call.url.endsWith("/review")),
    railNames: () => [...window.document.querySelectorAll(".agent-list .agent-row")].map((row) => row.textContent),
    close: () => window.close(),
  };
}
function button(page, text, root = page.document) {
  return [...root.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text));
}
const workspaceReads = (page) => page.calls.filter((call) => call.url.endsWith("/api/workspace")).length;
const dialogOf = (page) => page.document.querySelector('[role="dialog"]');
// React renders input and change events before dispatchEvent returns (it
// flushes them to restore controlled inputs); callers wait for anything that
// follows a request.
function choose(page, select, value) {
  Object.getOwnPropertyDescriptor(page.window.HTMLSelectElement.prototype, "value").set.call(select, value);
  select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
}
// New agent shows its choices as chips: radios inside a named group.
function pick(dialog, group, value) {
  dialog.querySelector(`[role="radiogroup"][aria-label="${group}"] input[value="${value}"]`).click();
}
function type(page, input, value) {
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}
async function openScope(page, name) {
  page.document.querySelector(".workspace-scope").click();
  const option = await waitFor(() => [...page.document.querySelectorAll('.scope-menu [role="menuitemradio"]')].find((item) =>
    item.querySelector(".scope-option-name").textContent === name), `scope option ${name}`);
  option.click();
  // App's changeScope decides Home in the same click, so this commit has it.
  await waitFor(() => page.document.querySelector(".scope-menu") === null, `the project menu closes on ${name}`);
}
// Opens the Workspace menu and chooses an entry.
async function fromScopeMenu(page, text) {
  page.document.querySelector(".workspace-scope").click();
  (await waitFor(() => button(page, text), `the Workspace menu offers ${text}`)).click();
}

test("a remembered project scopes the rail and an out-of-scope remembered agent starts on Home", async () => {
  const page = await mount({
    storage: { "yuzuno.selected.ws-1": "e", "yuzuno.projectScope.ws-1": "project:p-app" },
    agents: { e: { unreadCount: 3, reviewedSeq: 2 } },
    catchupItems: [
      { id: "c:req", agentId: "c", agentName: "Sora", kind: "pending", title: "Needs you", body: "Run tests?", seq: 12 },
      { id: "d:req", agentId: "d", agentName: "Kumo", kind: "pending", title: "Needs you", body: "Archived but waiting", seq: 12 },
      { id: "c:res", agentId: "c", agentName: "Sora", kind: "result", title: "Paper read", body: "Done", seq: 12 },
      { id: "a:res", agentId: "a", agentName: "Mori", kind: "result", title: "Scope shipped", body: "Done", seq: 12 },
    ],
  });
  try {
    const scope = page.document.querySelector(".workspace-scope");
    assert.match(scope.textContent, /App.*Personal workspace/);
    // Core reachability, not Codex's catalog probe, drives the entry's dot.
    assert.ok(scope.querySelector(".status-dot.idle"));
    assert.match(scope.querySelector(".status-dot").getAttribute("aria-label"), /^Core connected\./);
    const rail = page.railNames().join("|");
    assert.match(rail, /Mori/);
    assert.match(rail, /Hana/, "an external worktree agent is still in the project");
    assert.doesNotMatch(rail, /Sora|Kumo|Loose/);
    assert.ok(page.document.querySelector(".home-view"), "Home instead of the remembered out-of-scope agent");
    // Requests in other projects, including an archived one, stay listed.
    const notice = page.document.querySelector(".elsewhere-notice");
    assert.match(notice.textContent, /2 waiting in other projects/);
    // Home's needs-you bar spans every project; a loaded machine can be slow.
    await waitFor(() => /Archived but waiting/.test(page.document.querySelector(".home-view")?.textContent || ""),
      "Home's needs-you bar is read");
    const home = page.document.querySelector(".home-view").textContent;
    assert.match(home, /Run tests\?/);
    assert.match(home, /Archived but waiting/);
    assert.doesNotMatch(home, /Paper read|Scope shipped/, "Home lists no finished replies");
    // Real dwell: no dwell runs here when the app is right, so a scaled one
    // could not be shown to fire; the window covers a whole real dwell.
    await pause(DWELL_PLUS);
    assert.equal(page.reads().length, 0, "starting in a scope reads nothing");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("switching scope never selects or reads another agent; opening one explicitly does", async () => {
  // The dwell runs ten times faster in this test (and its windows with it);
  // the positive control below shows that scaled dwell is what reads.
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a" }, timers: { [AUTO_READ_DWELL_MS]: SCALED_DWELL_MS } });
  try {
    await waitFor(() => page.document.querySelector(".conversation-scroll"), "Mori is open");
    await openScope(page, "Research");
    assert.deepEqual(page.railNames().map((name) => name.match(/Sora/)?.[0]), ["Sora"]);
    assert.ok(page.document.querySelector(".home-view"), "Mori left the scope; Home, not Sora, is shown");
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause(SCALED_DWELL_PLUS);
    assert.equal(page.reads().length, 0, "Sora's unread stays unread after a scope switch");
    assert.equal(page.calls.filter((call) => /\/agents\/c$/.test(call.url)).length, 0, "Sora was not opened");
    // Positive control: this harness does observe reads of an opened conversation.
    page.document.querySelector(".agent-list .agent-select").click();
    await waitFor(() => page.document.querySelector('[data-item-id="r-c"]'), "Sora's conversation is shown");
    page.window.dispatchEvent(new page.window.Event("focus"));
    await waitFor(() => page.reads().length > 0, "the opened conversation is read after the dwell");
    // A second read would need another whole dwell.
    await pause(SCALED_DWELL_PLUS);
    const reads = page.reads();
    assert.equal(reads.length, 1);
    assert.match(reads[0].url, /\/agents\/c\/review$/);
    assert.deepEqual(page.timers.fired, [AUTO_READ_DWELL_MS], "the scaled dwell is the one that read");
    // Switching back keeps the current conversation when it is in scope.
    await openScope(page, "All projects");
    assert.ok(page.document.querySelector(".home-view") === null, ".home-view is absent");
    assert.match(page.document.querySelector(".conversation-heading h1").textContent, /Sora/);
  } finally {
    page.close();
  }
});

test("Escape closes the project menu without interrupting a working agent", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a" }, agents: { a: { status: "working" } } });
  try {
    // Escape would interrupt only while Mori is shown working (App's keydown).
    await waitFor(() => page.document.querySelector(".interrupt-button"), "Mori is shown working");
    page.document.querySelector(".workspace-scope").click();
    assert.ok(await waitFor(() => page.document.querySelector(".scope-menu"), "the project menu opens"));
    const menu = page.document.querySelector(".scope-menu");
    page.document.querySelector('.scope-menu [role="menuitemradio"]').dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    // It sinks back first, out of reach, then goes: the same menu, never
    // taken off and put back for its way out.
    assert.ok(page.document.querySelector(".scope-menu") === menu, "the open menu itself sinks back");
    const leaving = await waitFor(() => page.document.querySelector(".scope-menu.is-leaving"), "the menu sinks back first");
    assert.ok(leaving === menu, "the open menu itself sinks back");
    assert.equal(leaving.getAttribute("aria-hidden"), "true");
    assert.ok(leaving.hasAttribute("inert"), "and cannot be used on its way out");
    // The interrupt would be sent from that same keydown, before this commit.
    await waitFor(() => page.document.querySelector(".scope-menu") === null, ".scope-menu is absent");
    assert.ok(page.document.querySelector(".scope-menu") === null, ".scope-menu is absent");
    assert.equal(page.calls.filter((call) => call.url.endsWith("/interrupt")).length, 0);
    await waitFor(() => page.document.activeElement === page.document.querySelector(".workspace-scope"), "focus returns to the workspace scope button");
    assert.ok(page.document.activeElement === page.document.querySelector(".workspace-scope"), "focus returns to the workspace scope button");
  } finally {
    page.close();
  }
});

test("projects are created explicitly and folder groups are only suggestions", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a" } });
  try {
    await fromScopeMenu(page, "Manage projects");
    const dialog = await waitFor(() => dialogOf(page), "the project dialog opens");
    assert.match(dialog.textContent, /App/);
    assert.match(dialog.textContent, /Old study/, "archived projects are listed separately");
    button(page, "Without a project", dialog).click();
    await waitFor(() => button(page, "Without a project", dialog)?.classList.contains("selected"), "Without a project is shown");
    assert.match(dialog.textContent, /\/home\/u\/scratch/);
    assert.match(dialog.textContent, /Nothing is assigned until you choose/);
    assert.equal(page.calls.filter((call) => call.url.endsWith("/project")).length, 0);
    const lists = workspaceReads(page);
    button(page, "Create project", dialog).click();
    // The flow ends by reading the list again, after every move.
    await waitFor(() => page.calls.some((call) => call.url.endsWith("/agents/e/project")) && workspaceReads(page) > lists,
      "the project is created, Loose is moved and the list is read again");
    const created = page.calls.find((call) => call.url.endsWith("/api/projects") && call.method === "POST");
    assert.deepEqual(created.body, { name: "scratch", defaultDirs: { local: "/home/u/scratch" } });
    const moved = page.calls.filter((call) => call.url.endsWith("/agents/e/project"));
    assert.deepEqual(moved.map((call) => call.body), [{ projectId: "p-new" }]);
  } finally {
    page.close();
  }
});

test("new agents start in the viewed project with its folder, which they may change", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a", "yuzuno.projectScope.ws-1": "project:p-app" } });
  try {
    page.document.querySelector('[aria-label="Create agent"]').click();
    const dialog = await waitFor(() => dialogOf(page), "the Create agent dialog opens");
    // Opening fills in the project and its folder.
    const folder = await waitFor(() => [...dialog.querySelectorAll("input")].find((input) => input.value === "/home/u/app"),
      "the project's default folder is filled in");
    const project = dialog.querySelector('[role="radiogroup"][aria-label="Project"]');
    assert.equal(project.querySelector("input:checked").value, "p-app");
    assert.ok(![...project.querySelectorAll(".choice-chip")].some((chip) => chip.textContent.includes("Old study")), "archived projects take no new agents");
    assert.ok(folder, "the project's default folder is filled in");
    type(page, dialog.querySelector('input[placeholder^="Mikan"]'), "Kaze");
    type(page, folder, "/home/u/app-hotfix");
    const remember = dialog.querySelector(".create-project-default input");
    assert.match(dialog.querySelector(".create-project-default").textContent, /Make this App’s default folder on Core host/);
    assert.equal(remember.checked, false, "saving a default is opt-in");
    remember.click();
    await waitFor(() => remember.checked, "saving the default is chosen");
    button(page, "Create agent", dialog).click();
    const create = await waitFor(() => page.calls.find((call) => call.url.endsWith("/api/agents") && call.method === "POST"), "the agent is created");
    assert.equal(create.body.cwd, "/home/u/app-hotfix");
    assert.equal(create.body.projectId, "p-app");
    assert.equal(create.body.saveProjectDefault, true);
    await waitFor(() => dialogOf(page) === null, "the dialog closes once the agent is created");

    page.document.querySelector('[aria-label="Create agent"]').click();
    const again = await waitFor(() => dialogOf(page), "the Create agent dialog opens again");
    pick(again, "Project", "");
    await waitFor(() => [...again.querySelectorAll("input")].some((input) => input.value === "/workspace"), "no project falls back to the machine default");
    assert.ok([...again.querySelectorAll("input")].some((input) => input.value === "/workspace"), "no project falls back to the machine default");
    assert.ok(again.querySelector(".create-project-default") === null, ".create-project-default is absent");
  } finally {
    page.close();
  }
});

test("moving an agent is explicit and the window follows it", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a", "yuzuno.projectScope.ws-1": "project:p-app" } });
  try {
    const chip = () => page.document.querySelector(".conversation-metadata .project-chip");
    await waitFor(chip, "Mori's conversation shows its project");
    assert.match(chip().textContent, /App/);
    page.document.querySelector('[aria-label="Conversation actions"]').click();
    (await waitFor(() => page.document.querySelector('[role="menuitem"][data-action="manage"]'), "the actions menu offers Manage")).click();
    const dialog = await waitFor(() => dialogOf(page)?.querySelector(".agent-project-picker select") && dialogOf(page),
      "the conversation actions offer a project");
    const select = dialog.querySelector(".agent-project-picker select");
    assert.ok([...select.options].every((option) => !option.textContent.includes("Old study")));
    choose(page, select, "p-res");
    button(page, "Move", dialog).click();
    // The move ends with the window in the agent's new project.
    await waitFor(() => /Research/.test(page.document.querySelector(".workspace-scope strong")?.textContent || "")
      && /Research/.test(chip()?.textContent || ""), "the window follows Mori to Research");
    const move = page.calls.find((call) => call.url.endsWith("/agents/a/project"));
    assert.deepEqual(move.body, { projectId: "p-res" });
    assert.equal(page.calls.filter((call) => call.url.endsWith("/review")).length, 0);
    assert.match(page.document.querySelector(".workspace-scope strong").textContent, /Research/);
    assert.match(page.railNames().join("|"), /Mori/, "the open conversation stays listed");
    assert.match(page.document.querySelector(".conversation-metadata .project-chip").textContent, /Research/);
  } finally {
    page.close();
  }
});

test("the task board follows the window's project and states projects explicitly", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a", "yuzuno.projectScope.ws-1": "project:p-app" } });
  try {
    button(page, "Tasks & messages").click();
    const lists = () => page.calls.filter((call) => call.url.endsWith("/task_list"));
    const dialog = await waitFor(() => lists().length && /Ship scope/.test(dialogOf(page)?.textContent || "") && dialogOf(page),
      "the task board shows its first list");
    assert.equal(lists().at(-1).body.projectId, "p-app", "filtered by Core, so counts and paging follow the project");
    assert.match(dialog.textContent, /Ship scope/);
    assert.doesNotMatch(dialog.textContent, /Read papers|Loose end/);
    const filter = [...dialog.querySelectorAll(".collab-filters select")].find((select) =>
      [...select.options].some((option) => option.textContent === "No project"));
    let before = lists().length;
    choose(page, filter, "none");
    await waitFor(() => lists().length > before && /Loose end/.test(dialog.textContent), "the board reads and shows the new filter");
    assert.ok("projectId" in lists().at(-1).body);
    assert.equal(lists().at(-1).body.projectId, null);
    assert.match(dialog.textContent, /Loose end/);
    before = lists().length;
    choose(page, filter, "all");
    await waitFor(() => lists().length > before, "the board reads every project's tasks");
    assert.equal("projectId" in lists().at(-1).body, false);

    before = lists().length;
    choose(page, filter, "project:p-app");
    await waitFor(() => lists().length > before, "the board reads App's tasks");
    button(page, "New task", dialog).click();
    const form = await waitFor(() => dialog.querySelector('[aria-label="New task"]'), "the New task form opens");
    const title = form.querySelector("input");
    type(page, title, "Scoped work");
    const project = [...form.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.textContent === "No project"));
    assert.equal(project.value, "p-app");
    button(page, "Create task", form).click();
    const created = await waitFor(() => page.calls.find((call) => call.url.endsWith("/task_create")), "the task is created");
    assert.equal(created.body.projectId, "p-app");
  } finally {
    page.close();
  }
});

test("the design specimen offers scopes only and sends no project requests", async () => {
  const page = await mount({ url: "http://127.0.0.1:4317/?preview=1",
    ready: (document) => document.querySelector(".workspace-scope") });
  try {
    page.document.querySelector(".workspace-scope").click();
    await waitFor(() => page.document.querySelector(".scope-menu"), "the scope menu opens");
    // Real time: "never contacts Core" is watched as long as before.
    await pause(Math.max(45, SPECIMEN_WATCH_MS - (performance.now() - page.evaluatedAt)));
    assert.ok(page.document.querySelector(".scope-menu"));
    assert.ok(button(page, "Manage projects") === undefined, 'no "Manage projects" button');
    assert.ok(button(page, "New project") === undefined, 'no "New project" button');
    assert.ok(button(page, "Machines") === undefined, 'no "Machines" button');
    assert.deepEqual(page.calls, [], "the specimen never contacts Core");
  } finally {
    page.close();
  }
});

test("unsaved default folders survive workspace refreshes", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a" } });
  try {
    await fromScopeMenu(page, "Manage projects");
    // The field is named for a machine, so it appears once machines are read.
    const input = await waitFor(() => page.document.querySelector('input[aria-label="Default folder on Core host"]'),
      "the default folder field for Core host");
    assert.equal(input.value, "/home/u/app");
    type(page, input, "/home/u/app-in-progress");
    const before = workspaceReads(page);
    page.window.dispatchEvent(new page.window.Event("focus"));
    // Real time: the refreshed list renders unchanged, so nothing shows when
    // it has; the field is checked after the same window as before.
    await pause(300);
    await waitFor(() => workspaceReads(page) > before, "a refresh happened");
    assert.ok(workspaceReads(page) > before, "a refresh happened");
    assert.equal(page.document.querySelector('input[aria-label="Default folder on Core host"]').value, "/home/u/app-in-progress");
  } finally {
    page.close();
  }
});

test("a project with linked tasks cannot be deleted from the dialog", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a" } });
  try {
    await fromScopeMenu(page, "Manage projects");
    const dialog = await waitFor(() => dialogOf(page), "the project dialog opens");
    button(page, "Docs", dialog).click();
    await waitFor(() => button(page, "Docs", dialog)?.getAttribute("aria-current") === "true", "Docs is shown");
    const remove = button(page, "Delete", dialog);
    assert.equal(remove.disabled, true);
    assert.match(remove.title, /0 agents and 1 task; archive it instead/);
  } finally {
    page.close();
  }
});

test("deleting the scope's last agent shows Home instead of another project's agent", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "c", "yuzuno.projectScope.ws-1": "project:p-res" } });
  try {
    // Mori elsewhere has unread work that an automatic selection would read.
    page.agents.find((agent) => agent.id === "a").unreadCount = 4;
    page.agents.find((agent) => agent.id === "a").reviewedSeq = 2;
    (await waitFor(() => page.document.querySelector('[aria-label="Conversation actions"]'), "Sora's conversation actions")).click();
    (await waitFor(() => page.document.querySelector('[role="menuitem"][data-action="manage"]'), "the actions menu offers Manage")).click();
    (await waitFor(() => button(page, "Delete agent"), "the actions offer Delete agent")).click();
    await waitFor(() => dialogOf(page)?.querySelector(".danger-button"), "deleting asks to confirm");
    button(page, "Delete agent", page.document.querySelector('[role="dialog"]')).click();
    await waitFor(() => page.document.querySelector(".home-view"), "Home replaces the deleted agent");
    assert.ok(page.document.querySelector(".home-view"));
    page.window.dispatchEvent(new page.window.Event("focus"));
    // Real dwell: Sora's unread conversation is shown at mount, and its real
    // dwell is what the first click must beat.
    await pause(DWELL_PLUS);
    assert.equal(page.reads().length, 0);
    assert.equal(page.calls.filter((call) => /\/agents\/a$/.test(call.url)).length, 0, "Mori was never opened");
  } finally {
    page.close();
  }
});

test("a new agent in another project is listed where it lives, and typed folders survive reopening", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a", "yuzuno.projectScope.ws-1": "project:p-app" } });
  try {
    page.document.querySelector('[aria-label="Create agent"]').click();
    let dialog = await waitFor(() => dialogOf(page), "the Create agent dialog opens");
    const folder = () => [...page.document.querySelector('[role="dialog"]').querySelectorAll(".input-with-icon input")][0];
    await waitFor(() => folder()?.value === "/home/u/app", "the project's default folder is filled in");
    type(page, folder(), "/home/u/app-hotfix");
    button(page, "Cancel", dialog).click();
    await waitFor(() => dialogOf(page) === null, "the dialog closes");
    page.document.querySelector('[aria-label="Create agent"]').click();
    await waitFor(() => dialogOf(page), "the Create agent dialog opens again");
    // Real time: opening fills the folder in a later render that shows
    // nothing when it keeps the typed one; checked after the same window.
    await pause(120);
    assert.equal(folder().value, "/home/u/app-hotfix", "a typed folder is kept");
    dialog = page.document.querySelector('[role="dialog"]');
    pick(dialog, "Project", "p-res");
    type(page, dialog.querySelector('input[placeholder^="Mikan"]'), "Kaze");
    button(page, "Create agent", dialog).click();
    await waitFor(() => /Research/.test(page.document.querySelector(".workspace-scope strong")?.textContent || "")
      && /Kaze/.test(page.railNames().join("|")), "Kaze is listed in Research");
    assert.match(page.document.querySelector(".workspace-scope strong").textContent, /Research/);
    assert.match(page.railNames().join("|"), /Kaze/);
  } finally {
    page.close();
  }
});

test("a partly failed folder suggestion still refreshes and explains what is left", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a" }, failMove: ["e"] });
  try {
    await fromScopeMenu(page, "Manage projects");
    const dialog = await waitFor(() => dialogOf(page), "the project dialog opens");
    button(page, "Without a project", dialog).click();
    await waitFor(() => button(page, "Without a project", dialog)?.classList.contains("selected"), "Without a project is shown");
    const before = workspaceReads(page);
    button(page, "Create project", dialog).click();
    await waitFor(() => /scratch was created, but not every agent joined it/.test(dialog.textContent) && workspaceReads(page) > before,
      "the partial result is explained and the list is read again");
    assert.match(dialog.textContent, /scratch was created, but not every agent joined it \(Loose: Agent is gone\)/);
    assert.ok(workspaceReads(page) > before);
  } finally {
    page.close();
  }
});

test("Machines opens from the Workspace menu, reads nothing while open, and opens an agent where it lives", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a", "yuzuno.projectScope.ws-1": "project:p-app" },
    agents: { a: { unreadCount: 2, reviewedSeq: 3 } } });
  try {
    await fromScopeMenu(page, "Machines");
    // The page says "Loading machines…" until /api/machines is answered.
    const dialog = await waitFor(() => /Core host/.test(dialogOf(page)?.textContent || "") && dialogOf(page), "the Machines page lists Core host");
    assert.match(dialog.textContent, /Machines/);
    assert.match(dialog.textContent, /Core host/);
    assert.match(dialog.textContent, /Not checked yet/);
    page.window.dispatchEvent(new page.window.Event("focus"));
    // Real dwell: Mori's unread conversation is shown at mount, and its real
    // dwell is what the menu click must beat.
    await pause(DWELL_PLUS);
    assert.equal(page.reads().length, 0, "Mori's unread stays while the page covers it");
    const sora = [...dialog.querySelectorAll(".machine-agent")].find((b) => b.textContent.includes("Sora"));
    sora.click();
    await waitFor(() => dialogOf(page) === null && /Sora/.test(page.document.querySelector(".conversation-heading h1")?.textContent || ""),
      "Sora opens in place of the page");
    assert.ok(page.document.querySelector('[role="dialog"]') === null, '[role="dialog"] is absent');
    assert.match(page.document.querySelector(".conversation-heading h1").textContent, /Sora/);
    assert.match(page.document.querySelector(".workspace-scope strong").textContent, /Research/);
  } finally {
    page.close();
  }
});


test("Home content editor settings save stable IDs, explicit none and compatibility per project", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a" } });
  try {
    await fromScopeMenu(page, "Manage projects");
    const settings = await waitFor(() => page.document.querySelector('.home-editor-settings input'), "editor setting loads");
    assert.equal(settings.checked, true, "unconfigured is all-members compatibility");
    settings.click(); await pause();
    let checks = [...page.document.querySelectorAll('.home-editor-members input')];
    assert.equal(checks.length, 2, "only this project's open members are choices");
    assert.ok(checks.every(box => box.checked));
    checks[1].click(); await pause();
    button(page, "Save content editors").click();
    const saves = () => page.calls.filter(call => call.method === "PUT" && call.url.endsWith('/home-editors'));
    await waitFor(() => saves().length === 1, "selected editor saved");
    assert.deepEqual(saves()[0].body, { expectedVersion: 0, editorAgentIds: ['a'] });
    await waitFor(() => !page.document.querySelector('.home-editor-members input').disabled
      && !page.document.querySelector('.home-editor-actions').textContent.includes('Unsaved changes'), "save finished");
    page.document.querySelector('.home-editor-members input').click(); await pause();
    assert.match(page.document.querySelector('.home-editor-settings').textContent, /Members can only ask questions or request approval/);
    button(page, "Save content editors").click();
    await waitFor(() => saves().length === 2, "empty list saved");
    assert.deepEqual(saves()[1].body.editorAgentIds, []);
    await waitFor(() => !page.document.querySelector('.home-editor-members input').disabled
      && !page.document.querySelector('.home-editor-actions').textContent.includes('Unsaved changes'), "second save finished");
    button(page, "Research", dialogOf(page)).click();
    await waitFor(() => page.document.querySelector('.home-editor-mode input')?.checked === true, "different project retains compatibility");
    button(page, "App", dialogOf(page)).click();
    await waitFor(() => page.document.querySelector('.home-editor-mode input')?.checked === false, "saved empty list restored");
    assert.ok([...page.document.querySelectorAll('.home-editor-members input')].every(box => !box.checked));
    page.document.querySelector('.home-editor-mode input').click(); await pause();
    button(page, "Save content editors").click();
    await waitFor(() => saves().length === 3, "compatibility restored");
    assert.equal(saves()[2].body.editorAgentIds, null);
    assert.equal(page.errors.length, 0, page.errors.join('\n'));
  } finally { page.close(); }
});

test("Home content editors follow a language change from another window, an unsaved choice kept (T-189)", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a" } });
  const language = async (value) => {
    page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: value }));
    page.window.dispatchEvent(new page.window.StorageEvent("storage", { key: "yuzuno.language" }));
    await pause();
  };
  try {
    await fromScopeMenu(page, "Manage projects");
    const all = await waitFor(() => page.document.querySelector(".home-editor-mode input"), "editor setting loads");
    all.click(); await pause();
    page.document.querySelectorAll(".home-editor-members input")[1].click(); await pause();
    const settings = () => page.document.querySelector(".home-editor-settings");
    const chosen = () => [...page.document.querySelectorAll(".home-editor-members input")].map((box) => box.checked);
    const names = () => [...page.document.querySelectorAll(".home-editor-members span")].map((span) => span.textContent);
    const english = { text: settings().textContent, chosen: chosen(), names: names() };
    assert.match(english.text, /Home content editors.*Only selected members maintain reports and status.*Save content editors.*Unsaved changes/s);
    assert.deepEqual(english.chosen, [true, false]);
    const before = page.calls.length;
    await language("zh-Hans");
    assert.match(settings().textContent, /Home 内容编辑者.*所有成员，包括以后加入的成员.*只有所选成员维护报告和状态.*保存内容编辑者.*有未保存的更改/s);
    assert.deepEqual([chosen(), names()], [english.chosen, english.names], "the unsaved choice and the Agent names as they were");
    await language("en");
    assert.equal(settings().textContent, english.text);
    assert.deepEqual(chosen(), english.chosen);
    assert.deepEqual(page.calls.slice(before).filter((call) => call.method === "PUT"), [], "changing the language saves nothing");
    assert.equal(page.errors.length, 0, page.errors.join("\n"));
  } finally { page.close(); }
});

test("a project's service opens only once this computer proves it reaches Core's port", async () => {
  const page = await mount({ storage: { "yuzuno.selected.ws-1": "a" } });
  try {
    await fromScopeMenu(page, "Manage projects");
    const dialog = await waitFor(() => dialogOf(page), "the project dialog opens");
    button(page, "App", dialog).click();
    const panel = await waitFor(() => dialog.querySelector('[aria-label="Services"]'), "the Services panel is shown");
    await waitFor(() => /No services yet/.test(panel.textContent), "no services yet");
    button(page, "Add", panel).click();
    const form = await waitFor(() => panel.querySelector(".services-form"), "the form opens");
    const [name, port] = form.querySelectorAll("input");
    type(page, name, "Notebook");
    choose(page, form.querySelector("select"), "gpu");
    type(page, port, "8888");
    type(page, form.querySelectorAll("input")[2], "/lab");
    button(page, "Add service", form).click();
    await waitFor(() => page.services.length === 1 && /Notebook/.test(panel.textContent), "the service is registered");
    assert.deepEqual(page.calls.find((call) => call.method === "POST" && call.url.endsWith("/projects/p-app/services")).body,
      { name: "Notebook", machineId: "gpu", port: 8888, path: "/lab" });
    assert.match(panel.textContent, /GPU box · port 8888 · \/lab · added by you/);
    assert.match(panel.textContent, /Not open/);
    assert.equal(page.calls.filter((call) => call.url.includes("/open")).length, 0, "registering opens nothing");

    // Something else answers on that port here: refused, no link.
    page.answersHere.set(4380, () => "hello");
    button(page, "Open", panel).click();
    const note = await waitFor(() => panel.querySelector(".services-unreached"), "the page says this computer does not reach it");
    assert.match(note.textContent, /^This computer does not reach Core’s port 4380: something else answers there/);
    assert.equal(panel.querySelector(".services-open"), null, "no address is offered");
    assert.match(panel.textContent, /Answering \(HTTP 200\) · Core port 4380/);

    // Through Core's port: the answer only Core knows, then the address.
    page.answersHere.set(4380, (challenge) => (challenge === "c4380" ? "a4380" : "nope"));
    button(page, "Check again", panel).click();
    const link = await waitFor(() => panel.querySelector(".services-open"), "the address is offered");
    assert.equal(link.getAttribute("href"), "http://127.0.0.1:4380/lab");
    assert.equal(link.getAttribute("target"), "_blank");
    assert.match(link.getAttribute("rel"), /noopener/);
    assert.equal(panel.querySelector(".services-unreached"), null);

    // Closing forgets the proof; deleting leaves nothing listed.
    button(page, "Close", panel).click();
    await waitFor(() => /Not open/.test(panel.textContent) && !panel.querySelector(".services-open"), "closed");
    panel.querySelector('[aria-label="Delete Notebook"]').click();
    await waitFor(() => /No services yet/.test(panel.textContent), "deleted");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a page not opened on a loopback address says only that its connection reaches no unconfirmed service (T-170)", async () => {
  const page = await mount({ url: "https://phone-entry.test:8444/", storage: { "yuzuno.selected.ws-1": "a" } });
  try {
    await fromScopeMenu(page, "Manage projects");
    const dialog = await waitFor(() => dialogOf(page), "the project dialog opens");
    button(page, "App", dialog).click();
    const panel = await waitFor(() => dialog.querySelector('[aria-label="Services"]'), "the Services panel is shown");
    await waitFor(() => /No services yet/.test(panel.textContent), "no services yet");
    button(page, "Add", panel).click();
    const form = await waitFor(() => panel.querySelector(".services-form"), "the form opens");
    const [name, port] = form.querySelectorAll("input");
    type(page, name, "Dev server");
    type(page, port, "5173");
    button(page, "Add service", form).click();
    await waitFor(() => page.services.length === 1 && /Dev server/.test(panel.textContent), "the service is registered");
    const probes = () => page.calls.filter((call) => call.url.includes("/.well-known/yuzuno-service/")).length;

    // Nothing answers Core's port from here, then something else does: the
    // note says what this connection gives, and nothing about why.
    for (const answer of [undefined, () => "hello"]) {
      if (answer) page.answersHere.set(4380, answer);
      const before = probes();
      button(page, before ? "Check again" : "Open", panel).click();
      await waitFor(() => probes() === before + 1 && !/Checking that/.test(panel.textContent), "this check ends");
      const note = await waitFor(() => panel.querySelector(".services-unreached"), "the page says the service is not reached");
      assert.equal(note.textContent.replace(/\s+/g, " ").trim(), "Project services are not available through this page’s " +
        "connection: Core’s port 4380 could not be confirmed from here. They open on the Core host, or on a computer with a " +
        "tunnel to Core; see “Connect from another computer” in the guide.");
      assert.doesNotMatch(note.textContent, /This computer|something else answers|nothing does|must forward/);
      assert.equal(panel.querySelector(".services-open"), null, "no address is offered");
    }

    // Once the page confirms Core's port from here, the address is offered as anywhere.
    page.answersHere.set(4380, (challenge) => (challenge === "c4380" ? "a4380" : "nope"));
    button(page, "Check again", panel).click();
    const link = await waitFor(() => panel.querySelector(".services-open"), "the address is offered");
    assert.equal(link.getAttribute("href"), "http://127.0.0.1:4380/");
    assert.equal(panel.querySelector(".services-unreached"), null);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

// T-189: the Projects window in Chinese. Project, Agent and machine names,
// folders, repository and service names and what Core says stay as written.
const chinese = { "yuzuno.selected.ws-1": "a", "yuzuno.language": { language: "zh-Hans" } };

test("the Projects window reads in Chinese; names, folders and Core's words stay as written (T-189)", async () => {
  const page = await mount({ storage: chinese });
  try {
    await fromScopeMenu(page, "管理项目");
    const dialog = await waitFor(() => dialogOf(page), "the project dialog opens");
    assert.match(dialog.textContent, /把长期工作分组/);
    assert.ok(button(page, "无项目", dialog) && button(page, "新建项目", dialog));
    assert.match(dialog.querySelector(".project-archived-list").textContent, /已归档.*Old study/, "the archived list, its project named as given");
    button(page, "App", dialog).click();
    await waitFor(() => button(page, "App", dialog)?.getAttribute("aria-current") === "true", "App is shown");
    await waitFor(() => /还没有服务。/.test(dialog.textContent), "the services section has loaded");
    const text = dialog.textContent;
    assert.match(text, /项目名称/);
    assert.ok(button(page, "重命名", dialog));
    assert.match(text, /仓库/);
    assert.match(text, /链接此项目使用的仓库。/);
    assert.match(text, /服务/);
    assert.match(text, /默认文件夹/);
    assert.match(text, /不会移动现有 Agent/);
    assert.ok(dialog.querySelector('[aria-label="Core host 上的默认文件夹"]'), "the machine named as Core names it");
    assert.ok(dialog.querySelector('[aria-label="将 Mori 移出 App"]'));
    assert.match(text, /\/home\/u\/app-collaboration/);
    const add = dialog.querySelector(".project-add-agent select");
    assert.equal(add.options[0].textContent, "添加 Agent…");
    assert.ok([...add.options].some((option) => option.textContent === "Sora · 来自 Research"));
    assert.ok(button(page, "归档项目", dialog));
    assert.match(button(page, "删除", dialog).title, /仍关联 2 个 Agent 和 1 个任务；请改为归档/);
    assert.doesNotMatch(text, /Default folders|Rename|No services yet|Archive project|Repositories/);

    button(page, "无项目", dialog).click();
    await waitFor(() => /无项目的 Agent/.test(dialog.textContent), "Without a project is shown");
    assert.match(dialog.textContent, /在你选择之前不会分配任何项目。/);
    assert.match(dialog.textContent, /\/home\/u\/scratch/);
    assert.match(dialog.textContent, /Core 主机 · Loose/);
    assert.ok(button(page, "创建项目", dialog));
    assert.equal(dialog.querySelector(".project-suggestion select").options[0].textContent, "加入现有项目…");

    button(page, "新建项目", dialog).click();
    await waitFor(() => /新项目/.test(dialog.textContent), "the new project form");
    assert.match(dialog.textContent, /Core host 上的默认文件夹/);
    assert.match(dialog.textContent, /可选/);
    assert.ok(button(page, "创建项目", dialog));
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a partly failed suggestion and a service read in Chinese, with Core's reasons as written (T-189)", async () => {
  const page = await mount({ storage: chinese, failMove: ["e"] });
  try {
    await fromScopeMenu(page, "管理项目");
    const dialog = await waitFor(() => dialogOf(page), "the project dialog opens");
    button(page, "无项目", dialog).click();
    await waitFor(() => /无项目的 Agent/.test(dialog.textContent), "Without a project is shown");
    button(page, "创建项目", dialog).click();
    await waitFor(() => /并非所有 Agent 都已加入/.test(dialog.textContent), "the partial result is explained");
    assert.match(dialog.textContent, /已创建 scratch，但并非所有 Agent 都已加入（Loose: Agent is gone）。请在下方把它们加入 scratch。/);

    button(page, "App", dialog).click();
    const panel = await waitFor(() => dialog.querySelector('[aria-label="服务"]'), "the services panel");
    await waitFor(() => /还没有服务。/.test(panel.textContent), "no services yet");
    button(page, "添加", panel).click();
    const form = await waitFor(() => panel.querySelector(".services-form"), "the form opens");
    for (const label of ["名称", "机器", "该机器上的端口", "路径"])
      assert.ok([...form.querySelectorAll("label")].some((l) => l.textContent.trim().startsWith(label)), label);
    const [name, port] = form.querySelectorAll("input");
    type(page, name, "Notebook");
    choose(page, form.querySelector("select"), "gpu");
    type(page, port, "8888");
    type(page, form.querySelectorAll("input")[2], "/lab");
    button(page, "添加服务", form).click();
    await waitFor(() => page.services.length === 1 && /Notebook/.test(panel.textContent), "the service is registered");
    assert.match(panel.textContent, /GPU box · 端口 8888 · \/lab · 由你添加/);
    assert.match(panel.textContent, /未打开/);
    page.answersHere.set(4380, () => "hello");
    button(page, "打开", panel).click();
    const note = await waitFor(() => panel.querySelector(".services-unreached"), "this computer does not reach it");
    assert.match(note.textContent, /^这台电脑访问不到 Core 的端口 4380/);
    assert.match(panel.textContent, /有响应 \(HTTP 200\) · Core 端口 4380/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("switching the language while a project's repositories are open keeps what is typed and asks GitHub nothing again (T-189 R1)", async () => {
  const page = await mount({ storage: chinese });
  try {
    await fromScopeMenu(page, "管理项目");
    const dialog = await waitFor(() => dialogOf(page), "the project dialog opens");
    button(page, "App", dialog).click();
    const panel = await waitFor(() => dialog.querySelector('[aria-label="GitHub 仓库"]'), "the repositories section");
    await waitFor(() => panel.querySelector('[role="alert"]'), "its first answer (this Core lists no links)");
    const input = panel.querySelector(".github-link-form input");
    type(page, input, "owner/repo");
    const asked = () => page.calls.filter((call) => call.url.includes("/api/collaboration/github_")).length;
    const before = asked();
    page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" }));
    page.window.dispatchEvent(new page.window.StorageEvent("storage", { key: "yuzuno.language" }));
    await waitFor(() => dialog.querySelector('[aria-label="GitHub repositories"]'), "the section in English");
    await pause(100);
    assert.equal(dialog.querySelector(".github-link-form input").value, "owner/repo", "what was typed stays");
    assert.equal(asked(), before, "no request is started again");
  } finally {
    page.close();
  }
});

