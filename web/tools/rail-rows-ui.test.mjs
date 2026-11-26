// YN-234 A: streamed progress for one Agent draws only that Agent's rail row
// again. The real app (the built UI, flattened as ui-test-bundle does) with 50
// Agents in two Projects, its rail grouped as Settings has it by default, and
// Core's event stream answered here. Which rows React drew in each commit is
// read through React's own DevTools hook, so the count is the renderer's,
// not a counter in the product. Every other change a row shows (its own
// progress, selection, language, status, the wait it is stopped on, the
// attention order, its actions from the keyboard) still reaches it at once.
//   YUZUNO_UI_DIST=<isolated build> node tools/rail-rows-ui.test.mjs
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

const dist = pathToFileURL(resolve(process.env.YUZUNO_UI_DIST || "dist") + "/");
const index = await readFile(new URL("index.html", dist), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)[1];
const bundle = await uiTestBundle(new URL(entry, dist));
const pause = (ms = 45) => new Promise((r) => setTimeout(r, ms));
async function until(check, label = "condition", ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await pause(20);
  }
  assert.ok(check(), `${label} should settle`);
}
// progress-batch.ts: an entry is applied at most this long after it came, on a frame.
const PROGRESS_MS = 250;
const settle = () => pause(PROGRESS_MS + 150);

/**
 * The rail rows React drew, commit by commit. A row is the component given
 * an `agent`, a `statusLabel` and an `onSelect` (AgentRailRow, before and
 * after YN-234). A fiber drew in a commit when it is not the fiber that
 * commit's tree held for it last time (an untouched subtree keeps its
 * fibers) and React marked it PerformedWork (flag 1), which a bailout
 * clears. Production React calls the hook's onCommitFiberRoot as DevTools'.
 */
function rowProbe(w) {
  const last = new Map();
  let drawn = [];
  const isRow = (f) =>
    (f.tag === 0 || f.tag === 15) &&
    typeof f.memoizedProps?.onSelect === "function" &&
    typeof f.memoizedProps.statusLabel === "string" &&
    typeof f.memoizedProps.agent?.id === "string";
  const walk = (start) => {
    const out = [];
    const stack = [start];
    while (stack.length) {
      const f = stack.pop();
      if (f.sibling) stack.push(f.sibling);
      if (isRow(f)) {
        const id = f.memoizedProps.agent.id;
        if (f !== last.get(id) && (f.flags & 1) === 1) out.push(id);
        last.set(id, f);
        continue;
      }
      if (f.child) stack.push(f.child);
    }
    return out;
  };
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      const rows = walk(root.current);
      if (rows.length) drawn.push(rows);
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    setStrictMode() {},
    checkDCE() {},
  };
  return {
    /** The rows drawn since the last call, each time it was drawn. */
    take() {
      const taken = drawn.flat();
      drawn = [];
      return taken;
    },
  };
}

const ids = Array.from({ length: 50 }, (_, i) => `a${String(i + 1).padStart(2, "0")}`);
const nameOf = (id) => `Agent ${id.slice(1)}`;

async function mount({ appearance = null } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const logged = [];
  vc.on("error", (...args) => logged.push(args.map((a) => String(a?.stack ?? a)).join(" ").slice(0, 600)));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4452/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};
  // Only what a step drives: no 5 s poll, and no minute clock (live-executors.ts),
  // which draws every row once a minute by design.
  const realInterval = w.setInterval;
  w.setInterval = function (handler, delay, ...args) {
    return delay === 5_000 || delay === 60_000 ? 0 : realInterval.call(w, handler, delay, ...args);
  };
  w.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" }));
  // The conversation of the first Agent is open beside the rail.
  w.localStorage.setItem("yuzuno.selected.ws-rows", JSON.stringify("a01"));
  if (appearance) w.localStorage.setItem("yuzuno.appearance", JSON.stringify(appearance));
  const probe = rowProbe(w);
  const base = { harness: "codex", cwd: "/w", model: "m", color: "sage", createdAt: "", updatedAt: "",
    unreadCount: 0, pendingCount: 0, reviewedSeq: 0, connectionState: "connected" };
  const core = {
    agents: ids.map((id, i) => ({
      ...base, id, name: nameOf(id), status: i % 5 === 0 ? "working" : "idle", lastSeq: 10, rev: 10,
      projectId: i < 25 ? "p1" : "p2",
      workSummary: { text: `${nameOf(id)} is on step 0`, kind: "progress", source: "agent", turnId: `t-${id}`, itemId: `m-${id}` },
    })),
    projects: [
      { id: "p1", name: "Field notes", defaultDirs: {}, createdAt: "", updatedAt: "" },
      { id: "p2", name: "Site", defaultDirs: {}, createdAt: "", updatedAt: "" },
    ],
    calls: [],
    streams: [],
  };
  w.EventSource = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      core.streams.push(this);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  w.fetch = async (url, init = {}) => {
    const { pathname: path } = new URL(String(url), w.location.href);
    core.calls.push({ path, method: init.method || "GET" });
    // No Codex plan usage here, as from a Core that has none to tell.
    if (/^\/api\/agents\/[^/]+\/codex\/usage$/.test(path))
      return { ok: false, status: 404, json: async () => ({ error: "No usage" }), text: async () => '{"error":"No usage"}' };
    let body = {};
    if (path === "/api/workspace")
      body = { workspace: { id: "ws-rows" }, agents: core.agents, projects: core.projects, runtime: { connected: true }, defaultCwd: "/w" };
    else if (/^\/api\/agents\/a\d\d$/.test(path)) {
      const agent = core.agents.find((a) => path.endsWith(`/${a.id}`));
      body = { agent, pending: [], artifacts: [], messageReceipts: [], turns: [{ id: `t-${agent.id}`, status: "completed", items: [
        { id: `u-${agent.id}`, type: "userMessage", content: [{ type: "text", text: "Go on." }] },
        { id: `m-${agent.id}`, type: "agentMessage", text: `${agent.name} replied.` },
      ] }] };
    } else if (path === "/api/catchup") body = { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } };
    else if (path === "/api/merge-queue") body = { entries: [] };
    else if (path === "/api/ci/live" || path === "/api/waits/live" || path === "/api/jobs/live") body = { agents: {} };
    else if (path === "/api/home") body = { generatedAt: "", order: [], needsYou: [], projects: [] };
    else if (/^\/api\/projects\/[^/]+\/requests$/.test(path)) body = { requests: [], hasMore: false };
    // Each read its own copy, as from Core: a list read gives every row a new entry.
    return { ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
  };
  w.eval(bundle);
  const d = w.document;
  const p = { w, d, core, probe, errors, close: () => w.close() };
  try {
    await until(() => d.querySelectorAll(".agent-list .agent-row").length === 50, "all 50 rows");
    const stream = core.streams.at(-1);
    stream.readyState = 1;
    stream.onopen?.({});
    p.send = (data) => stream.onmessage?.({ data: JSON.stringify(data), lastEventId: "" });
    // The open stream's first word, so nothing reads again on a timer later.
    p.send({ type: "reset", reason: "open" });
    await until(() => d.querySelector('.agent-row.selected[data-agent-id="a01"]') && d.querySelector('[data-item-id="m-a01"]'), "a01's conversation open");
    await pause(600);
    probe.take();
  } catch (error) {
    w.close();
    throw error;
  }
  // A row that is not there says what the rail holds instead.
  p.row = (id) => {
    const row = d.querySelector(`.agent-list .agent-row[data-agent-id="${id}"]`);
    if (!row) {
      const rail = d.querySelector(".agent-list");
      assert.fail(`no row for ${id}: ${d.querySelectorAll(".agent-row").length} rows (${p.order().slice(0, 6).join(" ")}…); rail: ${rail ? rail.textContent.slice(0, 240) : "none"}; main: ${d.querySelector("main, .main-panel")?.className ?? "none"}; shown: ${d.body.textContent.slice(0, 300)}; logged: ${logged.slice(0, 3).join(" | ")}`);
    }
    return row;
  };
  p.order = () => [...d.querySelectorAll(".agent-list .agent-row")].map((row) => row.dataset.agentId);
  p.selected = () => [...d.querySelectorAll(".agent-list .agent-row.selected")].map((row) => row.dataset.agentId);
  // Core's rail entry for an Agent, changed as `change` says, as agent.progress carries it.
  p.progress = (id, change) => {
    const at = core.agents.findIndex((a) => a.id === id);
    const before = core.agents[at];
    const rev = before.rev + 1;
    const { projectId, ...listed } = { ...before, ...change, rev, lastSeq: rev };
    core.agents[at] = { ...listed, projectId };
    p.send({ type: "agent.progress", agentId: id, rev, lastSeq: rev, agent: listed });
  };
  p.step = (id, n) => p.progress(id, {
    status: "working",
    workSummary: { text: `${nameOf(id)} is on step ${n}`, kind: "progress", source: "agent", turnId: `t-${id}`, itemId: `m-${id}` },
  });
  return p;
}

const count = (list) => list.reduce((counts, id) => counts.set(id, (counts.get(id) || 0) + 1), new Map());

test("one Agent's progress draws its row alone; the other 49 are left as they are", async () => {
  const p = await mount();
  try {
    // A quiet list: nothing streams, nothing is drawn.
    await pause(PROGRESS_MS * 2);
    assert.deepEqual(p.probe.take(), [], "quiet: no row drawn");

    for (let n = 1; n <= 4; n++) {
      p.step("a07", n);
      await settle();
    }
    await until(() => p.row("a07").textContent.includes("Agent 07 is on step 4"), "a07's newest progress shown");
    const drawn = p.probe.take();
    const others = drawn.filter((id) => id !== "a07");
    assert.ok(drawn.includes("a07"), "its own row is drawn");
    assert.deepEqual([...count(others)], [], `no other row is drawn: ${others.length} draws of ${count(others).size} rows`);
    assert.ok(p.row("a08").textContent.includes("Agent 08 is on step 0"), "another row keeps what it said");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("several Agents streaming at once draw only their own rows, in batches", async () => {
  const p = await mount();
  try {
    const streaming = ["a02", "a13", "a26", "a39", "a50"];
    for (let n = 1; n <= 3; n++) {
      for (const id of streaming) p.step(id, n);
      await settle();
    }
    for (const id of streaming)
      await until(() => p.row(id).textContent.includes(`${nameOf(id)} is on step 3`), `${id}'s newest progress`);
    const drawn = p.probe.take();
    assert.deepEqual([...new Set(drawn)].sort(), streaming, "only the streaming rows are drawn");
    assert.ok(drawn.length <= streaming.length * 3, `one draw per batch at most: ${drawn.length}`);
  } finally {
    p.close();
  }
});

test("selection, status, a held call and language still reach the rows at once", async () => {
  const p = await mount();
  try {
    const first = p.selected()[0];
    // Selection: the row chosen and the row left draw; no other.
    p.row("a12").querySelector(".agent-select").click();
    await until(() => p.selected().join() === "a12", "a12 selected");
    assert.equal(p.row("a12").querySelector(".agent-select").getAttribute("aria-current"), "true");
    assert.deepEqual([...new Set(p.probe.take())].sort(), [first, "a12"].sort(), "the two rows whose selection changed");

    // Status: needs you, shown on its row with the batch.
    p.progress("a30", { status: "waiting", pendingCount: 1,
      workSummary: { text: "Approve running the build?", kind: "pending", source: "runtime", requestId: "q1" } });
    await until(() => p.row("a30").dataset.island === "waiting", "a30 needs you");
    assert.match(p.row("a30").textContent, /Needs you/);
    assert.deepEqual([...new Set(p.probe.take())], ["a30"]);

    // The call a Turn is stopped on (YN-51): its ring says so once the call holds it a second.
    p.progress("a31", { status: "working", turnWait: { kind: "shell", itemId: "c1", label: "npm test" } });
    await until(() => p.row("a31").querySelector(".island-ringbox")?.dataset.wait === "shell", "a31 waits on a shell", 3000);
    assert.deepEqual([...new Set(p.probe.take())], ["a31"]);

    // Language: every row is drawn again in Chinese, at once.
    const language = JSON.stringify({ language: "zh-Hans" });
    p.w.localStorage.setItem("yuzuno.language", language);
    p.w.dispatchEvent(new p.w.StorageEvent("storage", { key: "yuzuno.language", newValue: language }));
    await until(() => p.row("a40").querySelector(".agent-select").getAttribute("aria-label") === "打开 Agent 40", "rows in Chinese");
    assert.equal(p.row("a30").querySelector(".agent-select").getAttribute("aria-label"), "打开 Agent 30");
    assert.equal(new Set(p.probe.take()).size, 50, "every row drawn for the language");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("in attention order a row that comes to need you moves up at once", async () => {
  const p = await mount({ appearance: { agentOrder: "attention" } });
  try {
    const before = p.order();
    assert.notEqual(before.indexOf("a20"), 0);
    p.progress("a20", { status: "waiting", pendingCount: 1,
      workSummary: { text: "Approve the release notes?", kind: "pending", source: "runtime", requestId: "q2" } });
    await until(() => p.order()[0] === "a20", "a20 first in its Project");
    // Its Project's group comes first; the other group keeps its order.
    assert.deepEqual(p.order().slice(25), before.slice(25), "the other Project's rows keep their order");
    p.probe.take();
  } finally {
    p.close();
  }
});

test("a row's actions from the keyboard act on that Agent with what is shown now", async () => {
  const p = await mount();
  try {
    const menu = async (id) => {
      const button = p.row(id).querySelector(".agent-select");
      button.focus();
      button.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
      await until(() => p.d.querySelector('[role="menu"]'), `${id}'s menu`);
      const entry = [...p.d.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === "Agent settings…");
      assert.ok(entry, "its Agent settings entry");
      entry.click();
    };
    // Progress first, so the rows have been given the same handlers since.
    p.step("a05", 1);
    await settle();
    p.row("a03").querySelector(".agent-select").click();
    await until(() => p.selected().join() === "a03", "a03 selected");
    await menu("a09");
    await until(() => p.selected().join() === "a09", "settings open a09");
    // Back to a03, then a09's menu again: the handler reads the selection as
    // it is now, not as it was when the row was last drawn.
    p.row("a03").querySelector(".agent-select").click();
    await until(() => p.selected().join() === "a03", "a03 selected again");
    await menu("a09");
    await until(() => p.selected().join() === "a09", "settings open a09 again");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
